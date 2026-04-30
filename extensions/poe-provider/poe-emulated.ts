import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	type Context,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type Tool,
	type ToolCall,
} from "@mariozechner/pi-ai";
import { Check, Errors } from "typebox/value";

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

interface ValidationResult {
	validCalls: EmulatedToolCall[];
	errors: string[];
}

const TOOL_TAG_RE = /<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/i;
const FENCED_JSON_RE = /```(?:json)?\s*([\s\S]*?)\s*```/i;
const MAX_REPAIR_ATTEMPTS = 2;

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
	for (const key of ["type", "description", "enum", "required", "additionalProperties", "minItems", "maxItems", "minimum", "maximum"] as const) {
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
		"You can request tools, but this API endpoint does not support native tool calling.",
		"When a tool is needed, respond with ONLY this exact XML wrapper containing valid JSON:",
		"<tool_calls>",
		"[{\"name\":\"tool_name\",\"arguments\":{\"arg\":\"value\"}}]",
		"</tool_calls>",
		"Rules:",
		"- Do not include prose before or after <tool_calls> when calling tools.",
		"- Use the exact tool names shown below.",
		"- arguments must be a JSON object matching the tool's parameters schema.",
		"- If no tool is needed, answer normally without <tool_calls>.",
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
		const args = record.arguments ?? record.args ?? record.parameters;
		calls.push({ name, arguments: args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {} });
	}
	return calls.length > 0 ? calls : null;
}

function parseJsonToolCalls(candidate: string): EmulatedToolCall[] | null {
	try {
		return coerceToolCalls(JSON.parse(candidate));
	} catch {
		return null;
	}
}

export function parseEmulatedToolCalls(text: string): EmulatedToolCall[] | null {
	const trimmed = text.trim();
	const tagged = TOOL_TAG_RE.exec(text)?.[1];
	const fenced = FENCED_JSON_RE.exec(text)?.[1];
	const candidates = [tagged, fenced, trimmed].filter((v): v is string => !!v && v.trim().length > 0);
	for (const candidate of candidates) {
		const calls = parseJsonToolCalls(candidate.trim());
		if (calls) return calls;
	}
	return null;
}

export function validateEmulatedToolCalls(calls: EmulatedToolCall[], tools?: Tool[]): ValidationResult {
	const validCalls: EmulatedToolCall[] = [];
	const errors: string[] = [];
	const toolMap = new Map((tools ?? []).map((tool) => [tool.name, tool]));

	for (const call of calls) {
		const tool = toolMap.get(call.name);
		if (!tool) {
			errors.push(`Unknown tool \"${call.name}\". Available tools: ${Array.from(toolMap.keys()).join(", ") || "none"}.`);
			continue;
		}

		const args = call.arguments ?? {};
		if (!Check(tool.parameters, args)) {
			const firstErrors = [...Errors(tool.parameters, args)].slice(0, 3).map((err) => `${err.path || "/"}: ${err.message}`);
			errors.push(`Invalid arguments for ${call.name}: ${firstErrors.join("; ")}`);
			continue;
		}

		validCalls.push({ name: call.name, arguments: args });
	}

	return { validCalls, errors };
}

function looksLikeFailedToolCall(text: string): boolean {
	const lower = text.toLowerCase();
	return lower.includes("<tool_call")
		|| lower.includes("tool_calls")
		|| lower.includes('"arguments"')
		|| lower.includes('"name"') && (lower.startsWith("{") || lower.startsWith("["));
}

function buildRepairMessage(responseText: string, errors: string[]): Record<string, unknown> {
	const errorText = errors.length > 0 ? errors.join("\n") : "The response was not valid tool-call JSON.";
	return {
		role: "user",
		content: [
			"Your previous response could not be executed as a tool call.",
			"Errors:",
			errorText,
			"",
			"Previous response:",
			responseText.slice(0, 4000),
			"",
			"Respond again with ONLY this exact format and valid JSON arguments:",
			"<tool_calls>",
			"[{\"name\":\"tool_name\",\"arguments\":{\"arg\":\"value\"}}]",
			"</tool_calls>",
		].join("\n"),
	};
}

function addUsage(output: AssistantMessage, response: PoeChatCompletionResponse, model: Model): void {
	const usage = response.usage;
	if (!usage) return;
	const promptTokens = usage.prompt_tokens ?? 0;
	const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0;
	const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
	output.usage.cacheRead += cacheRead;
	output.usage.cacheWrite += cacheWrite;
	output.usage.input += Math.max(0, promptTokens - cacheRead - cacheWrite);
	output.usage.output += usage.completion_tokens ?? 0;
	output.usage.totalTokens += usage.total_tokens ?? (Math.max(0, promptTokens - cacheRead - cacheWrite) + (usage.completion_tokens ?? 0) + cacheRead + cacheWrite);
	calculateCost(model, output.usage);
}

function requestSignal(options?: SimpleStreamOptions): AbortSignal | undefined {
	if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
		const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
		if (options.signal) return AbortSignal.any([options.signal, timeoutSignal]);
		return timeoutSignal;
	}
	return options?.signal;
}

async function callPoeChat(
	model: Model,
	messages: Array<Record<string, unknown>>,
	options?: SimpleStreamOptions,
): Promise<PoeChatCompletionResponse> {
	const apiKey = options?.apiKey || process.env.POE_API_KEY;
	if (!apiKey) throw new Error("Poe API key is required. Use /login poe or set POE_API_KEY.");

	const body: Record<string, unknown> = {
		model: model.id,
		messages,
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
	return response.json() as Promise<PoeChatCompletionResponse>;
}

function emitText(stream: AssistantMessageEventStream, output: AssistantMessage, text: string): void {
	const contentIndex = output.content.length;
	output.content.push({ type: "text", text: "" });
	stream.push({ type: "text_start", contentIndex, partial: output });
	(output.content[contentIndex] as TextContent).text = text;
	stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
	stream.push({ type: "text_end", contentIndex, content: text, partial: output });
	stream.push({ type: "done", reason: "stop", message: output });
}

function emitToolCalls(stream: AssistantMessageEventStream, output: AssistantMessage, calls: EmulatedToolCall[]): void {
	output.stopReason = "toolUse";
	for (const call of calls) {
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
			const baseMessages = convertContextForEmulatedTools(context);
			let messages = baseMessages;
			let lastText = "";
			let lastErrors: string[] = [];

			for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
				const json = await callPoeChat(model, messages, options);
				addUsage(output, json, model);
				const text = json.choices?.[0]?.message?.content ?? "";
				lastText = text;

				const parsedCalls = parseEmulatedToolCalls(text);
				if (!parsedCalls) {
					lastErrors = ["Could not parse a <tool_calls> JSON block."];
					if (!looksLikeFailedToolCall(text)) {
						emitText(stream, output, text);
						stream.end();
						return;
					}
				} else {
					const validation = validateEmulatedToolCalls(parsedCalls, context.tools);
					if (validation.errors.length === 0) {
						emitToolCalls(stream, output, validation.validCalls);
						stream.end();
						return;
					}
					lastErrors = validation.errors;
				}

				if (attempt < MAX_REPAIR_ATTEMPTS) {
					messages = [...baseMessages, { role: "assistant", content: text }, buildRepairMessage(text, lastErrors)];
				}
			}

			output.stopReason = "error";
			output.errorMessage = `Poe emulated tool call failed after ${MAX_REPAIR_ATTEMPTS + 1} attempts: ${lastErrors.join("; ")}`;
			if (lastText) output.content.push({ type: "text", text: lastText });
			stream.push({ type: "error", reason: "error", error: output });
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
