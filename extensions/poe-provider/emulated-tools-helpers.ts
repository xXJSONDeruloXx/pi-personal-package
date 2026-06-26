/**
 * Pure helpers for Poe emulated tool calling.
 *
 * This module has NO runtime dependencies on pi (only `type` imports), so it can
 * be unit-tested in isolation. The stream implementation in `emulated-tools.ts`
 * imports these plus pi-ai's runtime helpers.
 */

import type { Message, Tool, ToolCall } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

export const TOOL_OPEN_TAG = "<tool_calls>";
export const TOOL_CLOSE_TAG = "</tool_calls>";

/** Regex matching a complete tool_calls block (non-greedy, dot-all). */
export const TOOL_BLOCK_RE = new RegExp(
	`${escapeRe(TOOL_OPEN_TAG)}\\s*(\\[[\\s\\S]*?\\])\\s*${escapeRe(TOOL_CLOSE_TAG)}`,
);

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Prompt + message conversion
// ---------------------------------------------------------------------------

/** Render the active tool catalog as system-prompt text instructions. */
export function toolsAsSystemText(tools: Tool[] | undefined): string {
	if (!tools || tools.length === 0) return "";
	const defs = tools.map((t) => {
		let schema: string;
		try {
			schema = JSON.stringify(t.parameters);
		} catch {
			schema = "{}";
		}
		return `- ${t.name}: ${t.description}\n  parameters schema: ${schema}`;
	});
	return [
		"",
		"# Tool calling",
		"You have access to the following tools. To call one or more tools, output " +
			`ONLY this exact format and nothing else:`,
		`${TOOL_OPEN_TAG}[{"name": "<toolName>", "arguments": { ... }}, ...]${TOOL_CLOSE_TAG}`,
		"Rules:",
		"- Output the block on its own; no prose before or after when calling a tool.",
		"- `arguments` MUST be a JSON object matching the tool's parameter schema.",
		"- You may call multiple tools in one block by adding objects to the array.",
		"- If you do not need a tool, answer the user normally with no block.",
		"",
		"Available tools:",
		...defs,
	].join("\n");
}

/**
 * Convert pi's message history into an OpenAI-compatible text-only conversation
 * that a non-tool model can follow. Mirrors npcpy's `flatten_tool_messages()`:
 * assistant tool calls become `<tool_calls>` text, and tool results become user
 * messages. This is what lets a multi-turn tool conversation round-trip through
 * a model that has no native tool roles.
 */
export function flattenMessagesToChat(
	messages: Message[],
): Array<{ role: string; content: string }> {
	const out: Array<{ role: string; content: string }> = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			out.push({ role: "user", content: messageText(msg.content) });
		} else if (msg.role === "assistant") {
			const parts: string[] = [];
			const calls: ToolCall[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) {
					parts.push(block.text);
				} else if (block.type === "toolCall") {
					calls.push(block);
				}
			}
			if (calls.length > 0) {
				const rendered = calls.map((c) => ({ name: c.name, arguments: c.arguments }));
				parts.push(`${TOOL_OPEN_TAG}${safeStringify(rendered)}${TOOL_CLOSE_TAG}`);
			}
			out.push({ role: "assistant", content: parts.join("\n") });
		} else if (msg.role === "toolResult") {
			const text = messageText(msg.content);
			const tag = msg.isError ? "Tool error" : "Tool result";
			out.push({ role: "user", content: `${tag} for ${msg.toolName}: ${text}` });
		}
	}

	return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse ALL `<tool_calls>[...]</tool_calls>` blocks out of text and combine them. */
export function parseEmulatedToolCalls(text: string): ToolCall[] | null {
	const allCalls: ToolCall[] = [];
	const re = new RegExp(
		`${escapeRe(TOOL_OPEN_TAG)}\\s*([\\s\\S]*?\\])\\s*${escapeRe(TOOL_CLOSE_TAG)}`,
		"g",
	);
	for (const match of text.matchAll(re)) {
		const calls = parseToolCallJson(match[1]);
		if (calls) allCalls.push(...calls);
	}
	return allCalls.length > 0 ? allCalls : null;
}

/** Strict parse + shape normalization of the JSON array inside a tool block. */
export function parseToolCallJson(jsonText: string): ToolCall[] | null {
	let arr: unknown;
	try {
		arr = JSON.parse(jsonText);
	} catch {
		return null;
	}
	if (!Array.isArray(arr)) return null;

	const calls: ToolCall[] = [];
	for (const entry of arr) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		const name = typeof e.name === "string" ? e.name : "";
		if (!name) continue;
		const rawArgs = e.arguments ?? e.args ?? e.parameters ?? {};
		const arguments_ =
			typeof rawArgs === "string" ? safeParseArgs(rawArgs) : isRecord(rawArgs) ? rawArgs : {};
		calls.push({ type: "toolCall", id: `emulated_${randomId()}`, name, arguments: arguments_ });
	}
	return calls.length > 0 ? calls : null;
}

/** True if text looks like it tried to start a tool block (even if malformed). */
export function looksLikeAttemptedCall(text: string): boolean {
	const idx = text.indexOf(TOOL_OPEN_TAG.slice(0, 6)); // "<tool_"
	if (idx === -1) return false;
	const tail = text.slice(idx);
	return tail.includes(TOOL_OPEN_TAG) || TOOL_OPEN_TAG.startsWith(tail) || tail.includes("</");
}

// ---------------------------------------------------------------------------
// Shared small utilities (also used by emulated-tools.ts)
// ---------------------------------------------------------------------------

export function joinSystem(prompt: string | undefined, toolText: string): string {
	return [prompt?.trim(), toolText].filter(Boolean).join("\n\n");
}

export function messageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text!)
		.join("\n");
}

export function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "{}";
	}
}

export function safeParseArgs(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : { value: parsed };
	} catch {
		return { raw_arguments: raw };
	}
}

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function trimTrailingSlash(s: string): string {
	return s.replace(/\/+$/, "");
}

export function randomId(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
