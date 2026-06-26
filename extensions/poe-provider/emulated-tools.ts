/**
 * Poe emulated tool calling — stream implementation.
 *
 * A separate `poe-emulated` provider that exposes the SAME models as the main
 * `poe` provider, but routes every request through a prompt-based tool protocol
 * instead of Poe's native `tools=` field. Models are registered with
 * `api: "openai-completions-emulated"` so this custom `streamSimple` only handles
 * `poe-emulated` traffic, never the main `poe` provider's.
 *
 *   "Model <id> does not support tool calling. Use a tool-capable model or
 *    remove tools from the request."
 *
 * How it works (validated against the live Poe API — see research/EMULATION_VALIDATION.md):
 *   1. Tool definitions are rendered as TEXT instructions in the system prompt.
 *   2. The model is told to emit a `<tool_calls>[{name, arguments}, ...]</tool_calls>` block.
 *   3. We never send `tools=` in the request payload.
 *   4. We parse the model's text response and emit real `toolcall_*` stream events,
 *      so pi executes the tools and loops exactly as if the call were native.
 *   5. A retry/repair loop recovers from malformed JSON — the gap that made the
 *      old `poe-emulated-tools` branch "not work very well".
 *
 * Pure, dependency-free helpers live in `emulated-tools-helpers.ts` (unit-tested).
 *
 * v1 trade-off: responses are buffered before emitting events (no live token
 * streaming during a tool-call turn). Reliability over cosmetics; see
 * "Future work" at the bottom.
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
	type Api,
	createAssistantMessageEventStream,
	calculateCost,
} from "@mariozechner/pi-ai";
import {
	TOOL_OPEN_TAG,
	TOOL_CLOSE_TAG,
	TOOL_BLOCK_RE,
	toolsAsSystemText,
	flattenMessagesToChat,
	parseEmulatedToolCalls,
	looksLikeAttemptedCall,
	joinSystem,
	trimTrailingSlash,
} from "./emulated-tools-helpers.js";

// Re-export pure helpers so callers can import everything from one place,
// and so tests written against emulated-tools.js keep working.
export {
	TOOL_OPEN_TAG,
	TOOL_CLOSE_TAG,
	TOOL_BLOCK_RE,
	toolsAsSystemText,
	flattenMessagesToChat,
	parseEmulatedToolCalls,
};

/** Max repair attempts when the model emits a malformed tool block. */
const DEFAULT_MAX_ATTEMPTS = Number(process.env.POE_EMULATED_MAX_ATTEMPTS ?? 3);

// ---------------------------------------------------------------------------
// Stream implementation
// ---------------------------------------------------------------------------

export interface EmulatedOptions {
	/** Override the default repair-attempt cap. */
	maxAttempts?: number;
	/** Inject a fetch (for tests). Defaults to global fetch. */
	fetch?: typeof fetch;
}

/**
 * Custom `streamSimple` for the `poe-emulated` provider.
 *
 * Strips native `tools`, injects them as text, flattens history, and converts a
 * detected `<tool_calls>` block in the response into real `toolcall_*` events.
 */
export function streamPoeEmulated(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	emulated?: EmulatedOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const fetchImpl = emulated?.fetch ?? fetch;
	const maxAttempts = emulated?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const apiKey = options?.apiKey ?? process.env.POE_API_KEY;

	void runEmulated(model, context, options, {
		stream,
		fetchImpl,
		maxAttempts,
		apiKey,
	});

	return stream;
}

interface RunCtx {
	stream: AssistantMessageEventStream;
	fetchImpl: typeof fetch;
	maxAttempts: number;
	apiKey: string | undefined;
}

async function runEmulated(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	ctx: RunCtx,
): Promise<void> {
	const output = freshOutput(model);
	ctx.stream.push({ type: "start", partial: output });

	try {
		const baseMessages = flattenMessagesToChat(context.messages);
		const systemText = joinSystem(context.systemPrompt, toolsAsSystemText(context.tools));
		const endpoint = `${trimTrailingSlash(model.baseUrl)}/chat/completions`;
		const hasTools = (context.tools?.length ?? 0) > 0;

		// Working copy of messages for the repair loop.
		const messages = [...baseMessages];

		let attempts = 0;
		let finalText = "";
		let stopReason: AssistantMessage["stopReason"] = "stop";
		let toolCalls: ToolCall[] | null = null;
		let usage = output.usage;

		while (attempts < ctx.maxAttempts) {
			attempts += 1;
			const result = await requestFull(ctx.fetchImpl, endpoint, ctx.apiKey, {
				model: model.id,
				stream: true,
				messages: systemText
					? [{ role: "system", content: systemText }, ...messages]
					: messages,
				max_tokens: model.maxTokens,
			}, options?.signal);

			finalText = result.text;
			usage = mergeUsage(usage, result.usage);

			toolCalls = hasTools ? parseEmulatedToolCalls(finalText) : null;

			if (hasTools && looksLikeAttemptedCall(finalText) && !toolCalls) {
				// Malformed tool block — ask the model to fix it and retry.
				messages.push({ role: "assistant", content: finalText });
				messages.push({
					role: "user",
					content:
						"Your previous response contained a tool call block but the JSON was " +
						"invalid or empty. Respond with ONLY a valid " +
						`${TOOL_OPEN_TAG}[{"name":"...","arguments":{...}}]${TOOL_CLOSE_TAG} block.`,
				});
				continue;
			}
			break; // success or plain-text answer
		}

		// Emit content events.
		if (toolCalls && toolCalls.length > 0) {
			stopReason = "toolUse";
			let idx = output.content.length;
			for (const call of toolCalls) {
				output.content.push(call);
				ctx.stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
				const delta = JSON.stringify(call.arguments);
				ctx.stream.push({ type: "toolcall_delta", contentIndex: idx, delta, partial: output });
				ctx.stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: call, partial: output });
				idx += 1;
			}
		} else if (finalText) {
			// Strip a stray/empty tool block from a plain answer, if present.
			const clean = hasTools ? finalText.replace(TOOL_BLOCK_RE, "").trim() : finalText;
			const text = clean || finalText;
			const idx = output.content.length;
			output.content.push({ type: "text", text });
			ctx.stream.push({ type: "text_start", contentIndex: idx, partial: output });
			ctx.stream.push({ type: "text_delta", contentIndex: idx, delta: text, partial: output });
			ctx.stream.push({ type: "text_end", contentIndex: idx, content: text, partial: output });
		}

		output.usage = usage;
		output.usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		output.usage.cost = calculateCost(model, output.usage);
		output.stopReason = stopReason;

		ctx.stream.push({
			type: "done",
			reason: stopReason === "toolUse" ? "toolUse" : "stop",
			message: output,
		});
		ctx.stream.end(output);
	} catch (err) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = err instanceof Error ? err.message : String(err);
		ctx.stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
		ctx.stream.end(output);
	}
}

// ---------------------------------------------------------------------------
// HTTP + SSE parsing
// ---------------------------------------------------------------------------

interface RequestResult {
	text: string;
	usage: Partial<AssistantMessage["usage"]>;
}

async function requestFull(
	fetchImpl: typeof fetch,
	endpoint: string,
	apiKey: string | undefined,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<RequestResult> {
	const res = await fetchImpl(endpoint, {
		method: "POST",
		signal,
		headers: {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify(body),
	});

	if (!res.ok || !res.body) {
		const errText = await safeReadText(res);
		throw new Error(`Poe emulated request failed: HTTP ${res.status} ${errText.slice(0, 300)}`);
	}

	return parseSse(res.body);
}

/** Parse an OpenAI-style SSE stream into the full concatenated text + usage. */
async function parseSse(body: ReadableStream<Uint8Array>): Promise<RequestResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let usage: Partial<AssistantMessage["usage"]> = {};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let nl: number;
		while ((nl = buffer.indexOf("\n")) !== -1) {
			const rawLine = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!rawLine || !rawLine.startsWith("data:")) continue;
			const payload = rawLine.slice(5).trim();
			if (payload === "[DONE]") continue;

			try {
				const chunk = JSON.parse(payload) as Record<string, unknown>;
				const delta = (chunk.choices as any[])?.[0]?.delta?.content;
				if (typeof delta === "string") text += delta;
				const u = chunk.usage as Record<string, unknown> | undefined;
				if (u) usage = mapOpenAiUsage(u);
			} catch {
				// Ignore malformed keep-alive lines.
			}
		}
	}

	return { text, usage };
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function freshOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function mapOpenAiUsage(u: Record<string, unknown>): Partial<AssistantMessage["usage"]> {
	const num = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
	const cacheRead =
		typeof u.prompt_tokens_details === "object" && u.prompt_tokens_details !== null
			? (u.prompt_tokens_details as Record<string, unknown>).cached_tokens
			: u.cached_tokens;
	return {
		input: num("prompt_tokens"),
		output: num("completion_tokens"),
		cacheRead: typeof cacheRead === "number" ? cacheRead : 0,
		cacheWrite: 0,
	};
}

function mergeUsage(
	base: AssistantMessage["usage"],
	patch: Partial<AssistantMessage["usage"]>,
): AssistantMessage["usage"] {
	return {
		...base,
		input: patch.input ?? base.input,
		output: patch.output ?? base.output,
		cacheRead: patch.cacheRead ?? base.cacheRead,
		cacheWrite: patch.cacheWrite ?? base.cacheWrite,
	};
}

async function safeReadText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

/*
 * Future work:
 *  - Live token streaming during a tool-call turn (currently buffered for
 *    reliable block detection + repair). Stream text deltas and suppress the
 *    `<tool_calls>` region in-flight.
 *  - JSON-schema validation of `arguments` before emitting toolcall_end; on
 *    failure, feed the validation error back through the repair loop.
 *  - Per-model prompt templates (some models prefer XML or fenced-JSON formats).
 */
