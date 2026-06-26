/**
 * Poe emulated tool calling — stream implementation.
 *
 * A separate `poe-emulated` provider that exposes the SAME models as the main
 * `poe` provider, but routes every request through a prompt-based tool protocol
 * instead of Poe's native `tools=` field. Models are registered with
 * `api: "openai-completions-emulated"` so this custom `streamSimple` only handles
 * `poe-emulated` traffic, never the main `poe` provider's.
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
 * Streaming: every token is emitted live as a text_delta. The raw <tool_calls>
 * block is visible in the stream — this is intentional so the user can see
 * tokens flowing. After the stream completes, tool calls are parsed from the
 * full text and emitted as toolcall_* events. If the text contained a tool
 * block, stopReason is set to "toolUse" and pi will execute the tools.
 *
 * Pure, dependency-free helpers live in `emulated-tools-helpers.ts` (unit-tested).
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
	TOOL_BLOCK_RE,
	toolsAsSystemText,
	flattenMessagesToChat,
	parseEmulatedToolCalls,
	looksLikeAttemptedCall,
	joinSystem,
	trimTrailingSlash,
} from "./emulated-tools-helpers.js";

// Re-export pure helpers so callers can import everything from one place.
export {
	TOOL_OPEN_TAG,
	TOOL_CLOSE_TAG,
	TOOL_BLOCK_RE,
	toolsAsSystemText,
	flattenMessagesToChat,
	parseEmulatedToolCalls,
} from "./emulated-tools-helpers.js";

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
		const requestBody = (msgs: Array<{ role: string; content: string }>) => ({
			model: model.id,
			stream: true,
			messages: systemText
				? [{ role: "system", content: systemText }, ...msgs]
				: msgs,
			max_tokens: model.maxTokens,
		});

		// ---- First attempt: live streaming ----
		// Every token is emitted as text_delta immediately. After the stream
		// completes, we parse the full text for tool calls.
		const firstResult = await streamLive(
			ctx, endpoint, requestBody(baseMessages), options?.signal, output,
		);

		let usage = mergeUsage(output.usage, firstResult.usage);
		let toolCalls = hasTools ? parseEmulatedToolCalls(firstResult.text) : null;
		let textContentIdx = firstResult.contentIdx;
		let fullText = firstResult.text;

		// ---- Retry loop (buffered) ----
		// If the model attempted a tool block but the JSON was malformed, ask
		// it to fix it and retry. Retries are buffered — we need the full text
		// before deciding whether to retry again.
		const messages = [...baseMessages];
		let attempts = 1;

		while (
			hasTools && looksLikeAttemptedCall(fullText) && !toolCalls
			&& attempts < ctx.maxAttempts
		) {
			attempts += 1;
			messages.push({ role: "assistant", content: fullText });
			messages.push({
				role: "user",
				content:
					"Your previous response contained a tool call block but the JSON was " +
					"invalid or empty. Respond with ONLY a valid " +
					`<tool_calls>[{"name":"...","arguments":{...}}]</tool_calls> block.`,
			});

			const retryResult = await requestFull(
				ctx.fetchImpl, endpoint, ctx.apiKey, requestBody(messages), options?.signal,
			);
			usage = mergeUsage(usage, retryResult.usage);
			fullText = retryResult.text;
			toolCalls = parseEmulatedToolCalls(fullText);
		}

		// ---- Finalize ----
		let stopReason: AssistantMessage["stopReason"] = "stop";

		if (toolCalls && toolCalls.length > 0) {
			stopReason = "toolUse";

			// The raw <tool_calls> block was already streamed as text. Now emit
			// the parsed toolcall events so pi executes them.
			let idx = output.content.length;
			for (const call of toolCalls) {
				output.content.push(call);
				ctx.stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
				ctx.stream.push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(call.arguments), partial: output });
				ctx.stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: call, partial: output });
				idx += 1;
			}
		}

		// Finalize the text block (if one was started during streaming).
		if (textContentIdx !== undefined) {
			const block = output.content[textContentIdx];
			if (block && block.type === "text") {
				ctx.stream.push({ type: "text_end", contentIndex: textContentIdx, content: block.text, partial: output });
			}
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
// Live streaming — emit every SSE token as text_delta immediately
// ---------------------------------------------------------------------------

interface LiveStreamResult {
	text: string;
	usage: Partial<AssistantMessage["usage"]>;
	/** Content index of the text block, if any tokens were received. */
	contentIdx: number | undefined;
}

async function streamLive(
	ctx: RunCtx,
	endpoint: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
	output: AssistantMessage,
): Promise<LiveStreamResult> {
	const res = await ctx.fetchImpl(endpoint, {
		method: "POST",
		signal,
		headers: {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
		},
		body: JSON.stringify(body),
	});

	if (!res.ok || !res.body) {
		const errText = await safeReadText(res);
		throw new Error(`Poe emulated request failed: HTTP ${res.status} ${errText.slice(0, 300)}`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let sseBuffer = "";
	let fullText = "";
	let contentIdx: number | undefined;
	let usage: Partial<AssistantMessage["usage"]> = {};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		sseBuffer += decoder.decode(value, { stream: true });

		let nl: number;
		while ((nl = sseBuffer.indexOf("\n")) !== -1) {
			const rawLine = sseBuffer.slice(0, nl).trim();
			sseBuffer = sseBuffer.slice(nl + 1);
			if (!rawLine || !rawLine.startsWith("data:")) continue;
			const payload = rawLine.slice(5).trim();
			if (payload === "[DONE]") continue;

			let delta: string | undefined;
			try {
				const chunk = JSON.parse(payload) as Record<string, unknown>;
				delta = (chunk.choices as any[])?.[0]?.delta?.content;
				const u = chunk.usage as Record<string, unknown> | undefined;
				if (u) usage = mapOpenAiUsage(u);
			} catch {
				continue;
			}

			if (typeof delta !== "string") continue;
			fullText += delta;

			// Create the text block on first token.
			if (contentIdx === undefined) {
				contentIdx = output.content.length;
				output.content.push({ type: "text", text: "" });
				ctx.stream.push({ type: "text_start", contentIndex: contentIdx, partial: output });
			}

			// Emit every token live — including the raw <tool_calls> block.
			const block = output.content[contentIdx!];
			if (block.type === "text") {
				block.text += delta;
				ctx.stream.push({ type: "text_delta", contentIndex: contentIdx!, delta, partial: output });
			}
		}
	}

	return { text: fullText, usage, contentIdx };
}

// ---------------------------------------------------------------------------
// Buffered request (for retries)
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

	const reader = res.body.getReader();
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
				continue;
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
