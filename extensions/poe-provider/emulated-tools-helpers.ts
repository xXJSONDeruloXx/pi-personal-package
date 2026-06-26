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

/** Parse ALL `<tool_calls>[...]</tool_calls>` blocks out of text and combine them.
 *
 * Also handles truncation: when the model hits its output token limit (e.g.
 * ~2k on free Together AI models), the last `<tool_calls>` block may be
 * cut off mid-JSON with no closing `</tool_calls>` tag. This function
 * detects that and attempts to repair by closing the JSON array and tag. */
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

	// Try to salvage a truncated unclosed tool_calls block at the end.
	// This happens when the model hits its output token cap mid-block.
	const truncated = repairTruncatedBlock(text);
	if (truncated) {
		allCalls.push(...truncated);
	}

	return allCalls.length > 0 ? allCalls : null;
}

/**
 * Detect and repair a trailing unclosed `<tool_calls>` block.
 *
 * Finds the last `<tool_calls>` that has no matching `</tool_calls>`
 * after it, then attempts to close the JSON array and extract valid calls.
 */
export function repairTruncatedBlock(text: string): ToolCall[] | null {
	// Find the last unclosed <tool_calls>
	let searchFrom = 0;
	let lastUnclosedIdx = -1;
	while (true) {
		const openIdx = text.indexOf(TOOL_OPEN_TAG, searchFrom);
		if (openIdx === -1) break;
		const closeIdx = text.indexOf(TOOL_CLOSE_TAG, openIdx + TOOL_OPEN_TAG.length);
		if (closeIdx === -1) {
			lastUnclosedIdx = openIdx;
			break; // This and any subsequent opens are also unclosed
		}
		searchFrom = closeIdx + TOOL_CLOSE_TAG.length;
	}

	if (lastUnclosedIdx === -1) return null;

	// Extract the truncated content after the final <tool_calls>
	const afterTag = text.slice(lastUnclosedIdx + TOOL_OPEN_TAG.length);

	// Try parsing as-is first (maybe the JSON array is complete, just missing the closing tag)
	let calls = parseToolCallJson(afterTag.trim());
	if (calls) return calls;

	// The JSON is truncated. Walk backwards to find the last complete JSON object
	// by looking for `},` or `]` (end of an object or end of the array).
	const repaired = repairJsonArray(afterTag);
	if (!repaired) return null;

	calls = parseToolCallJson(repaired);
	return calls;
}

/**
 * Try to close a truncated JSON array by finding the last complete object.
 * E.g. `[{"name":"a","arguments":{}},{"name":"b","arg` → `[{"name":"a","arguments":{}}]`
 */
export function repairJsonArray(partial: string): string | null {
	// Strategy: find the last `},` or `}]` boundary that ends a complete object.
	// Try from rightmost to leftmost.
	const boundaries: number[] = [];
	for (let i = partial.length - 1; i >= 0; i--) {
		const ch = partial[i];
		if (ch === ',') {
			// Check if this comma follows a `}` (end of a complete object)
			let j = i - 1;
			while (j >= 0 && partial[j] === ' ') j--;
			if (j >= 0 && partial[j] === '}') {
				boundaries.push(i); // comma after a complete object
			}
		}
	}

	// Try each boundary, closing the array
	for (const commaPos of boundaries) {
		const truncated = partial.slice(0, commaPos) + "]";
		try {
			const parsed = JSON.parse(truncated);
			if (Array.isArray(parsed) && parsed.length > 0) return truncated;
		} catch {
			continue;
		}
	}

	// If no comma boundaries worked, check if the opening `[` content is a single
	// complete object (rare but possible: `[{"name":"a"` truncated mid-key)
	// Try just slapping `}]` on the end
	for (let i = partial.length - 1; i >= 0; i--) {
		if (partial[i] === '}') {
			const candidate = partial.slice(0, i + 1) + ']';
			try {
				const parsed = JSON.parse(candidate);
				if (Array.isArray(parsed) && parsed.length > 0) return candidate;
			} catch {
				break;
			}
		}
	}

	return null;
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
