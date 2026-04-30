import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type Tool,
	type ToolCall,
} from "@mariozechner/pi-ai";

interface EmulatedToolCall {
	name: string;
	arguments?: Record<string, unknown>;
}

interface PoeChatCompletionResponse {
	choices?: Array<{
		message?: { content?: string | null };
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: {
			cached_tokens?: number;
			cache_write_tokens?: number;
		};
	};
	error?: { message?: string; type?: string; code?: string };
}

const TOOL_TAG_RE = /<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/i;

function textFromContent(content: string | (TextContent | ImageContent)[]): string | Array<Record<string, unknown>> {
	if (typeof content === "string") return content;
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

	const blocks: Array<Record<string, unknown>> = [];
	for (const block of content) {
		if (block.type === "text") {
			blocks.push({ type: "text", text: block.text });
		} else {
			blocks.push({
				type: "image_url",
				image_url: { url: `data:${block.mimeType};base64,${block.data}` },
			});
		}
	}
	if (!blocks.some((b) => b.type === "text")) blocks.unshift({ type: "text", text: "(see attached image)" });
	return blocks;
}

function textFromToolResult(content: (TextContent | ImageContent)[]): string {
	return content.map((block) => block.type === "text" ? block.text : `[image result: ${block.mimeType}]`).join("\n");
}

function compactSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(compactSchema);
	const src = schema as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of ["type", "enum", "required", "additionalProperties"] as const) {
		if (src[key] !== undefined) out[key] = src[key];
	}
	if (src.properties && typeof src.properties === "object") {
		out.properties = Object.fromEntries(Object.entries(src.properties as Record<string, unknown>).map(([key, value]) => [key, compactSchema(value)]));
	}
	if (src.items) out.items = compactSchema(src.items);
	return out;
}

function buildToolInstructions(tools?: Tool[]): string {
	if (!tools || tools.length === 0) return "";
	const toolSpecs = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: compactSchema(tool.parameters),
	}));
	return [
		"You can request tools, but this API does not support native tool calling.",
		"When a tool is needed, respond with ONLY this exact XML wrapper containing valid JSON:",
		"<tool_calls>",
		"[{\"name\":\"tool_name\",\"arguments\":{\"arg\":\"value\"}}]",
		"</tool_calls>",
		"Do not include prose before or after <tool_calls>. If no tool is needed, answer normally.",
		"Available tools:",
		JSON.stringify(toolSpecs),
	].join("\n");
}

export function convertContextForEmulatedTools(context: Context): Array<Record<string, unknown>> {
	const messages: Array<Record<string, unknown>> = [];
	const systemParts = [context.systemPrompt, buildToolInstructions(context.tools)].filter(Boolean);
	if (systemParts.length > 0) {
		messages.push({ role: "system", content: systemParts.join("\n\n") });
	}

	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({ role: "user", content: textFromContent(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			// Do not replay emulated tool-call markup back to non-native models. The
			// following toolResult user message carries the information the model needs,
			// and replaying tool-call JSON can make some Poe-hosted models loop or stall.
			const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
			if (text) messages.push({ role: "assistant", content: text });
			continue;
		}
		messages.push({
			role: "user",
			content: `Tool result for ${message.toolName} (${message.toolCallId}):\n${textFromToolResult(message.content)}`,
		});
	}
	return messages;
}

function coerceToolCalls(value: unknown): EmulatedToolCall[] | null {
	const rawCalls = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && Array.isArray((value as { tool_calls?: unknown }).tool_calls)
			? (value as { tool_calls: unknown[] }).tool_calls
			: null;
	if (!rawCalls) return null;

	const calls: EmulatedToolCall[] = [];
	for (const call of rawCalls) {
		if (!call || typeof call !== "object") continue;
		const record = call as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name : undefined;
		if (!name) continue;
		const args = record.arguments;
		calls.push({ name, arguments: args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {} });
	}
	return calls.length > 0 ? calls : null;
}

export function parseEmulatedToolCalls(text: string): EmulatedToolCall[] | null {
	const tagged = TOOL_TAG_RE.exec(text)?.[1];
	const candidates = [tagged, text.trim()].filter((v): v is string => !!v);
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			const calls = coerceToolCalls(parsed);
			if (calls) return calls;
		} catch {
			// Try next format.
		}
	}
	return null;
}

function applyUsage(output: AssistantMessage, response: PoeChatCompletionResponse, model: Model): void {
	const usage = response.usage;
	if (!usage) return;
	const promptTokens = usage.prompt_tokens ?? 0;
	const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0;
	const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
	output.usage.cacheRead = cacheRead;
	output.usage.cacheWrite = cacheWrite;
	output.usage.input = Math.max(0, promptTokens - cacheRead - cacheWrite);
	output.usage.output = usage.completion_tokens ?? 0;
	output.usage.totalTokens = usage.total_tokens ?? (output.usage.input + output.usage.output + cacheRead + cacheWrite);
	calculateCost(model, output.usage);
}

function requestSignal(options?: SimpleStreamOptions): AbortSignal | undefined {
	// Only apply a timeout if explicitly requested via timeoutMs.
	// Respect external cancellation via options.signal without layering
	// additional timeouts, allowing pi's own timeout handling to control
	// the overall request lifecycle.
	if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
		const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
		if (options.signal) return AbortSignal.any([options.signal, timeoutSignal]);
		return timeoutSignal;
	}
	return options?.signal;
}

export function streamPoeEmulatedTools(
	model: Model,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			stream.push({ type: "start", partial: output });
			const apiKey = options?.apiKey || process.env.POE_API_KEY;
			if (!apiKey) throw new Error("Poe API key is required. Use /login poe or set POE_API_KEY.");

			const body: Record<string, unknown> = {
				model: model.id,
				messages: convertContextForEmulatedTools(context),
				stream: false,
				max_tokens: options?.maxTokens ?? model.maxTokens,
			};
			if (options?.temperature !== undefined) body.temperature = options.temperature;

			const response = await fetch(`${model.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: requestSignal(options),
			});
			options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);
			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Poe emulated request failed: ${response.status} ${errorText}`);
			}
			const json = await response.json() as PoeChatCompletionResponse;
			applyUsage(output, json, model);
			const text = json.choices?.[0]?.message?.content ?? "";
			const toolCalls = parseEmulatedToolCalls(text);

			if (toolCalls) {
				output.stopReason = "toolUse";
				for (const call of toolCalls) {
					const toolCall: ToolCall = {
						type: "toolCall",
						id: `emulated_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
						name: call.name,
						arguments: call.arguments ?? {},
					};
					const contentIndex = output.content.length;
					output.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
					stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
				}
				stream.push({ type: "done", reason: "toolUse", message: output });
			} else {
				const contentIndex = output.content.length;
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex, partial: output });
				(output.content[contentIndex] as TextContent).text = text;
				stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
				stream.push({ type: "text_end", contentIndex, content: text, partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
			}
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}
