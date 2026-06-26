import { describe, it, expect } from "vitest";
import {
	TOOL_OPEN_TAG,
	TOOL_CLOSE_TAG,
	toolsAsSystemText,
	flattenMessagesToChat,
	parseEmulatedToolCalls,
} from "./emulated-tools-helpers.js";

// Minimal local types so this test stays free of runtime deps (typebox/pi-ai
// are provided by pi at runtime, not from this dir's node_modules).
type AnyTool = { name: string; description: string; parameters: object };
type AnyMessage = Parameters<typeof flattenMessagesToChat>[0][number];

// ---------------------------------------------------------------------------
// toolsAsSystemText
// ---------------------------------------------------------------------------

describe("toolsAsSystemText", () => {
	it("returns empty string when there are no tools", () => {
		expect(toolsAsSystemText(undefined)).toBe("");
		expect(toolsAsSystemText([])).toBe("");
	});

	it("renders each tool with name, description, and schema", () => {
		const tools: AnyTool[] = [
			{
				name: "list_files",
				description: "List files in a directory",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		];
		const text = toolsAsSystemText(tools);
		expect(text).toContain("list_files");
		expect(text).toContain("List files in a directory");
		expect(text).toContain(TOOL_OPEN_TAG);
		expect(text).toContain(TOOL_CLOSE_TAG);
		// Schema is JSON-stringified into the prompt.
		expect(text).toContain('"path"');
	});
});

// ---------------------------------------------------------------------------
// parseEmulatedToolCalls
// ---------------------------------------------------------------------------

describe("parseEmulatedToolCalls", () => {
	it("returns null when no block is present", () => {
		expect(parseEmulatedToolCalls("just a normal answer")).toBeNull();
	});

	it("parses a single well-formed call", () => {
		const text = `${TOOL_OPEN_TAG}[{"name":"list_files","arguments":{"path":"/tmp"}}]${TOOL_CLOSE_TAG}`;
		const calls = parseEmulatedToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls![0]).toMatchObject({
			type: "toolCall",
			name: "list_files",
			arguments: { path: "/tmp" },
		});
		expect(calls![0].id).toBeTruthy();
	});

	it("parses multiple calls in one block", () => {
		const text =
			`${TOOL_OPEN_TAG}[` +
			'{"name":"a","arguments":{"x":1}},' +
			'{"name":"b","arguments":{}}' +
			`]${TOOL_CLOSE_TAG}`;
		const calls = parseEmulatedToolCalls(text);
		expect(calls).toHaveLength(2);
		expect(calls!.map((c) => c.name)).toEqual(["a", "b"]);
	});

	it("extracts a block even when surrounded by prose", () => {
		const text = `Sure! Let me do that.\n${TOOL_OPEN_TAG}[{"name":"x","arguments":{}}]${TOOL_CLOSE_TAG}\nDone.`;
		const calls = parseEmulatedToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls![0].name).toBe("x");
	});

	it("parses multiple separate tool_calls blocks in one response", () => {
		const text =
			`I'll edit both files.\n` +
			`${TOOL_OPEN_TAG}[{"name":"edit","arguments":{"path":"a.py"}}]${TOOL_CLOSE_TAG}\n` +
			`Now the other file:\n` +
			`${TOOL_OPEN_TAG}[{"name":"edit","arguments":{"path":"b.py"}}]${TOOL_CLOSE_TAG}`;
		const calls = parseEmulatedToolCalls(text);
		expect(calls).toHaveLength(2);
		expect(calls!.map((c) => c.name)).toEqual(["edit", "edit"]);
		expect(calls![0].arguments).toEqual({ path: "a.py" });
		expect(calls![1].arguments).toEqual({ path: "b.py" });
	});

	it("accepts args/parameters aliases and stringified arguments", () => {
		const text =
			`${TOOL_OPEN_TAG}[` +
			'{"name":"a","args":{"k":1}},' +
			'{"name":"b","parameters":"{\\"y\\":2}"}' +
			`]${TOOL_CLOSE_TAG}`;
		const calls = parseEmulatedToolCalls(text);
		expect(calls).toHaveLength(2);
		expect(calls![0].arguments).toEqual({ k: 1 });
		expect(calls![1].arguments).toEqual({ y: 2 });
	});

	it("returns null for malformed JSON", () => {
		const text = `${TOOL_OPEN_TAG}[{not valid json}]${TOOL_CLOSE_TAG}`;
		expect(parseEmulatedToolCalls(text)).toBeNull();
	});

	it("returns null when the array has no valid entries", () => {
		const text = `${TOOL_OPEN_TAG}[]${TOOL_CLOSE_TAG}`;
		expect(parseEmulatedToolCalls(text)).toBeNull();
	});

	it("repairs a truncated tool_calls block missing the closing tag", () => {
		// Simulates model hitting ~2k token cap mid-block
		const text =
			`${TOOL_OPEN_TAG}[{"name":"a","arguments":{"path":"/tmp"}},{"name":"b","arg`;
		const calls = parseEmulatedToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls![0].name).toBe("a");
		expect(calls![0].arguments).toEqual({ path: "/tmp" });
	});

	it("repairs a truncated block after a closed block", () => {
		const text =
			`${TOOL_OPEN_TAG}[{"name":"x","arguments":{}}]${TOOL_CLOSE_TAG} some prose ${TOOL_OPEN_TAG}[{"name":"a","arguments":{}},{"name":"b","arg`;
		const calls = parseEmulatedToolCalls(text);
		expect(calls).toHaveLength(2); // x from closed block, a from repaired truncated block
		expect(calls!.map((c) => c.name)).toEqual(["x", "a"]);
	});

	it("parses a complete block inside an unclosed block (last closed wins)", () => {
		// JSON array is complete, just missing </tool_calls>
		const text = `${TOOL_OPEN_TAG}[{"name":"done","arguments":{"x":1}}]`;
		const calls = parseEmulatedToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls![0].name).toBe("done");
	});
});

// ---------------------------------------------------------------------------
// flattenMessagesToChat
// ---------------------------------------------------------------------------

const now = 1_700_000_000_000;

describe("flattenMessagesToChat", () => {
	it("passes plain user text through unchanged", () => {
		const messages: AnyMessage[] = [{ role: "user", content: "hello", timestamp: now }];
		expect(flattenMessagesToChat(messages)).toEqual([{ role: "user", content: "hello" }]);
	});

	it("flattens assistant tool calls into a tool_calls block", () => {
		const messages: AnyMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Sure." },
					{ type: "toolCall", id: "t1", name: "list_files", arguments: { path: "/" } },
				],
				api: "openai-completions",
				provider: "poe-emulated",
				model: "m",
				usage: {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: now,
			},
		];
		const out = flattenMessagesToChat(messages);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("assistant");
		expect(out[0].content).toContain("Sure.");
		expect(out[0].content).toContain(TOOL_OPEN_TAG);
		expect(out[0].content).toContain('"list_files"');
		expect(out[0].content).toContain(TOOL_CLOSE_TAG);
	});

	it("turns toolResult messages into user-role text", () => {
		const messages: AnyMessage[] = [
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "list_files",
				content: [{ type: "text", text: "a.txt\nb.txt" }],
				isError: false,
				timestamp: now,
			},
		];
		const out = flattenMessagesToChat(messages);
		expect(out[0].role).toBe("user");
		expect(out[0].content).toContain("list_files");
		expect(out[0].content).toContain("a.txt");
		expect(out[0].content).toContain("Tool result");
	});

	it("marks errored tool results distinctly", () => {
		const messages: AnyMessage[] = [
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bad",
				content: [{ type: "text", text: "boom" }],
				isError: true,
				timestamp: now,
			},
		];
		const out = flattenMessagesToChat(messages);
		expect(out[0].content).toContain("Tool error");
	});

	it("preserves a multi-turn tool conversation in order", () => {
		const messages: AnyMessage[] = [
			{ role: "user", content: "list /tmp", timestamp: now },
			{
				role: "assistant", api: "openai-completions", provider: "p", model: "m", stopReason: "toolUse", timestamp: now,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				content: [{ type: "toolCall", id: "t1", name: "list_files", arguments: { path: "/tmp" } }],
			},
			{
				role: "toolResult", toolCallId: "t1", toolName: "list_files", isError: false, timestamp: now,
				content: [{ type: "text", text: "x.txt" }],
			},
		];
		const out = flattenMessagesToChat(messages);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(out[1].content).toContain(TOOL_OPEN_TAG);
		expect(out[2].content).toContain("x.txt");
	});
});
