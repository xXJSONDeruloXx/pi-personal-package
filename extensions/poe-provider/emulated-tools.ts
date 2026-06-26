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
 * Streaming: text deltas are emitted live as they arrive from the SSE stream.
 * When a `<tool_calls>` block is detected mid-stream, text emission is suppressed
 * and the rest is buffered. After the stream completes, tool calls are parsed and
 * emitted as toolcall events. On retry (malformed JSON), the second attempt uses
 * buffered mode since we need the full text to decide.
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

// ---------------------------------------------------------------------------
// Tag detection helpers
// ---------------------------------------------------------------------------

/** Prefix of TOOL_OPEN_TAG that could still be arriving in a partial delta. */
const TOOL_TAG_PREFIX = "<tool_";

/**
 * Returns how many characters at the end of `text` could be the start of
 * TOOL_OPEN_TAG (e.g. if text ends with "<too", returns 4). Returns 0 if
 * the text doesn't end with a prefix of the tag.
 */
function partialTagLength(text: string): number {
	for (let len = Math.min(text.length, TOOL_OPEN_TAG.length); len >= 1; len--) {
		if (text.endsWith(TOOL_OPEN_TAG.slice(0, len))) {
			return len;
		}
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

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
		let stopReason: AssistantMessage["stopReason"] = "stop";
		let toolCalls: ToolCall[] | null = null;
		let usage = output.usage;

		// State from the first (streaming) attempt.
		let firstAttemptText = "";
		let firstAttemptEmittedLen = 0;
		let firstAttemptContentIdx: number | undefined;
		let needsRetry = false;

		// ---- First attempt: live streaming ----
		// Stream text deltas live. When <tool_calls> is detected, stop emitting
		// text and buffer the rest. After completion, check if we need a retry.
		if (attempts < ctx.maxAttempts) {
			attempts += 1;
			const result = await streamWithLiveText(
				ctx, endpoint, model, systemText, messages, options?.signal, output, hasTools,
			);
			firstAttemptText = result.text;
			firstAttemptEmittedLen = result.emittedLen;
			firstAttemptContentIdx = result.contentIdx;
			usage = mergeUsage(usage, result.usage);

			// Parse tool calls from the full text.
			toolCalls = hasTools ? parseEmulatedToolCalls(firstAttemptText) : null;

			if (hasTools && looksLikeAttemptedCall(firstAttemptText) && !toolCalls) {
				needsRetry = true;
			}
		}

		// ---- Retry attempts: buffered (need full text to decide) ----
		while (needsRetry && attempts < ctx.maxAttempts) {
			attempts += 1;

			// If we emitted text during the first attempt that included part of a
			// malformed tool block, that text is already in the output. The retry
			// adds more context to the messages and gets a fresh response.

			messages.push({ role: "assistant", content: firstAttemptText });
			messages.push({
				role: "user",
				content:
					"Your previous response contained a tool call block but the JSON was " +
					"invalid or empty. Respond with ONLY a valid " +
					`${TOOL_OPEN_TAG}[{"name":"...","arguments":{...}}]${TOOL_CLOSE_TAG} block.`,
			});

			const result = await requestFull(ctx.fetchImpl, endpoint, ctx.apiKey, {
				model: model.id,
				stream: true,
				messages: systemText
					? [{ role: "system", content: systemText }, ...messages]
					: messages,
				max_tokens: model.maxTokens,
			}, options?.signal);

			usage = mergeUsage(usage, result.usage);

			toolCalls = hasTools ? parseEmulatedToolCalls(result.text) : null;

			if (hasTools && looksLikeAttemptedCall(result.text) && !toolCalls) {
				// Still malformed — update the text for the next loop iteration.
				firstAttemptText = result.text;
				continue;
			}

			// Retry succeeded or gave plain text.
			firstAttemptText = result.text;
			firstAttemptEmittedLen = 0; // Nothing was live-emitted for this retry.
			firstAttemptContentIdx = undefined;
			needsRetry = false;

			// Emit the retry response as text (it's a fresh response, no tool block
			// was detected, or it was parsed successfully).
			if (toolCalls && toolCalls.length > 0) {
				// Tool calls from retry — emit them below (outside the loop).
			} else if (result.text) {
				const clean = hasTools ? result.text.replace(TOOL_BLOCK_RE, "").trim() : result.text;
				const text = clean || result.text;
				if (text) {
					const idx = output.content.length;
					output.content.push({ type: "text", text });
					ctx.stream.push({ type: "text_start", contentIndex: idx, partial: output });
					ctx.stream.push({ type: "text_delta", contentIndex: idx, delta: text, partial: output });
					ctx.stream.push({ type: "text_end", contentIndex: idx, content: text, partial: output });
				}
			}
			break;
		}

		// ---- Emit final events from the first (streaming) attempt ----
		if (firstAttemptContentIdx !== undefined || toolCalls) {
			// We had a first attempt. Handle the text that was already emitted.
			if (toolCalls && toolCalls.length > 0) {
				stopReason = "toolUse";

				// If we emitted text before the <tool_calls> block was detected,
				// trim it to only the pre-tool-call prose. The text block already
				// exists in output.content; update it to remove the tool block.
				if (firstAttemptContentIdx !== undefined) {
					const preToolText = firstAttemptText.slice(0, firstAttemptEmittedLen).trimEnd();
					// Remove any partial tag prefix from the end.
					const cleaned = preToolText.replace(/\s*<tool_.*$/s, "").trimEnd();
					const block = output.content[firstAttemptContentIdx];
					if (block && block.type === "text") {
						if (cleaned) {
							block.text = cleaned;
							// Update pi with the trimmed text.
							ctx.stream.push({ type: "text_end", contentIndex: firstAttemptContentIdx, content: cleaned, partial: output });
						} else {
							// The entire text was part of a tool-call preamble (unlikely but
							// possible). Remove the text block.
							output.content.splice(firstAttemptContentIdx, 1);
						}
					}
				}

				// Emit toolcall events.
				let idx = output.content.length;
				for (const call of toolCalls) {
					output.content.push(call);
					ctx.stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
					const delta = JSON.stringify(call.arguments);
					ctx.stream.push({ type: "toolcall_delta", contentIndex: idx, delta, partial: output });
					ctx.stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: call, partial: output });
					idx += 1;
				}
			} else if (firstAttemptContentIdx !== undefined && !needsRetry) {
				// Plain text answer — finalize the text block that was streamed live.
				// The text_delta events were pushed during streaming. Push text_end
				// with the final content (stripped of any stray tool block).
				const block = output.content[firstAttemptContentIdx];
				if (block && block.type === "text") {
					const clean = hasTools ? firstAttemptText.replace(TOOL_BLOCK_RE, "").trim() : firstAttemptText;
					const text = clean || firstAttemptText;
					block.text = text;
					ctx.stream.push({ type: "text_end", contentIndex: firstAttemptContentIdx, content: text, partial: output });
				}
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
// Live streaming first attempt
// ---------------------------------------------------------------------------

interface LiveStreamResult {
	text: string;
	emittedLen: number;
	contentIdx: number | undefined;
	usage: Partial<AssistantMessage["usage"]>;
}

/**
 * Stream the SSE response with live text deltas.
 *
 * - Text before `<tool_calls>` is emitted as `text_delta` events.
 * - When the opening tag is detected (or a partial prefix of it), text
 *   emission is suppressed and the rest is buffered.
 * - Returns the full text, how many characters were emitted live, and the
 *   content index of the text block (if one was started).
 */
async function streamWithLiveText(
	ctx: RunCtx,
	endpoint: string,
	model: Model<Api>,
	systemText: string,
	messages: Array<{ role: string; content: string }>,
	signal: AbortSignal | undefined,
	output: AssistantMessage,
	hasTools: boolean,
): Promise<LiveStreamResult> {
	const body: Record<string, unknown> = {
		model: model.id,
		stream: true,
		messages: systemText
			? [{ role: "system", content: systemText }, ...messages]
			: messages,
		max_tokens: model.maxTokens,
	};

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

	return parseSseLive(res.body, ctx.stream, output, hasTools);
}

/**
 * Parse SSE stream with live text emission. Emits `text_start` / `text_delta`
 * as tokens arrive. Suppresses the `<tool_calls>` region.
 */
async function parseSseLive(
	body: ReadableStream<Uint8Array>,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	hasTools: boolean,
): Promise<LiveStreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let sseBuffer = "";
	let fullText = "";
	let emittedLen = 0;
	let contentIdx: number | undefined;
	let usage: Partial<AssistantMessage["usage"]> = {};

	// State machine for tag detection:
	//   "streaming"  — emitting text deltas live
	//   "holdback"   — detected possible start of <tool_calls>, buffering until we know
	//   "suppressed" — inside a <tool_calls> block, all text buffered, not emitted
	let state: "streaming" | "holdback" | "suppressed" = "streaming";
	let holdback = ""; // text held back while we decide if it's a tag

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

			if (!hasTools || state === "suppressed") {
				// No tool detection needed, or we're already past the tag.
				// Just buffer the text (suppressed) or emit it (no-tools).
				if (state === "suppressed") continue;
				// No tools — just emit everything live.
				emitDelta(delta);
				continue;
			}

			// We have tools and need to watch for <tool_calls>.
			if (state === "streaming") {
				// Check if this delta contains the tag start.
				const combined = holdback + delta;

				const tagPos = combined.indexOf(TOOL_TAG_PREFIX);
				if (tagPos === -1) {
					// No tag prefix anywhere — emit holdback + delta.
					if (holdback) {
						emitDelta(holdback);
						holdback = "";
					}
					emitDelta(delta);
				} else {
					// A potential tag start exists. Check if the full tag is present.
					const fullTagPos = combined.indexOf(TOOL_OPEN_TAG);
					if (fullTagPos !== -1) {
						// Full tag found! Emit everything before it, suppress the rest.
						emitDelta(combined.slice(0, fullTagPos));
						state = "suppressed";
						holdback = "";
					} else {
						// Partial tag or tag prefix. Emit text before the prefix,
						// hold back from the prefix onward.
						const beforeTag = combined.slice(0, tagPos);
						if (beforeTag) emitDelta(beforeTag);
						holdback = combined.slice(tagPos);
						state = "holdback";
					}
				}
			} else if (state === "holdback") {
				// We're holding back text that might be the start of <tool_calls>.
				holdback += delta;
				const fullTagPos = holdback.indexOf(TOOL_OPEN_TAG);
				if (fullTagPos !== -1) {
					// Confirmed: the tag is here. Emit anything before it, suppress.
					const before = holdback.slice(0, fullTagPos);
					if (before) emitDelta(before);
					state = "suppressed";
					holdback = "";
				} else if (!TOOL_OPEN_TAG.startsWith(holdback)) {
					// It wasn't a tag prefix after all. Emit the held-back text.
					emitDelta(holdback);
					holdback = "";
					state = "streaming";
				}
				// else: still a valid prefix of <tool_calls>, keep holding.
			}
		}
	}

	// If we have leftover holdback, it wasn't a tag — emit it.
	if (holdback && state === "holdback") {
		emitDelta(holdback);
	}

	return { text: fullText, emittedLen, contentIdx, usage };

	/** Helper: emit a text delta, creating the text block if needed. */
	function emitDelta(d: string) {
		if (!d) return;
		if (contentIdx === undefined) {
			contentIdx = output.content.length;
			output.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: contentIdx, partial: output });
		}
		const block = output.content[contentIdx!];
		if (block.type === "text") {
			block.text += d;
			emittedLen += d.length;
			stream.push({ type: "text_delta", contentIndex: contentIdx!, delta: d, partial: output });
		}
	}
}

// ---------------------------------------------------------------------------
// Buffered HTTP + SSE parsing (for retry attempts)
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

	return parseSseBuffered(res.body);
}

/** Parse an OpenAI-style SSE stream into the full concatenated text + usage (no live emission). */
async function parseSseBuffered(body: ReadableStream<Uint8Array>): Promise<RequestResult> {
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
 *  - JSON-schema validation of `arguments` before emitting toolcall_end; on
 *    failure, feed the validation error back through the repair loop.
 *  - Per-model prompt templates (some models prefer XML or fenced-JSON formats).
 *  - Stray tool block cleanup: if the model emits text then a stray empty
 *    <tool_calls></tool_calls> block (no actual calls), strip it from the
 *    already-emitted text in the text_end event.
 */
