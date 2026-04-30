import { describe, expect, it, vi, afterEach } from "vitest";
import { Type } from "typebox";
import {
	convertContextForEmulatedTools,
	parseEmulatedToolCalls,
	parseEmulatedToolResponse,
	streamPoeEmulatedTools,
	validateEmulatedToolCalls,
} from "./poe-emulated.js";
import type { Context, Model, Tool } from "@mariozechner/pi-ai";

const lsTool: Tool = {
	name: "ls",
	description: "List files",
	parameters: Type.Object({ path: Type.Optional(Type.String()) }),
};

async function collectStream(stream: ReturnType<typeof streamPoeEmulatedTools>): Promise<any[]> {
	const events: any[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function mockFetchResponses(contents: string[]) {
	const fetchMock = vi.fn();
	for (const content of contents) {
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
			choices: [{ message: { content }, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}), { status: 200, headers: { "content-type": "application/json" } }));
	}
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const model: Model = {
	id: "glm-5.1-t",
	name: "GLM-5.1-T",
	provider: "poe-emulated",
	api: "openai-completions",
	baseUrl: "https://api.poe.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

describe("parseEmulatedToolCalls", () => {
	it("parses tagged tool call arrays", () => {
		const calls = parseEmulatedToolCalls('<tool_calls>\n[{"name":"ls","arguments":{"path":"."}}]\n</tool_calls>');
		expect(calls).toEqual([{ name: "ls", arguments: { path: "." } }]);
	});

	it("parses raw objects with tool_calls", () => {
		const calls = parseEmulatedToolCalls('{"tool_calls":[{"name":"ls","arguments":{"path":"src"}}]}');
		expect(calls).toEqual([{ name: "ls", arguments: { path: "src" } }]);
	});

	it("parses fenced json", () => {
		const calls = parseEmulatedToolCalls('```json\n[{"name":"ls","arguments":{}}]\n```');
		expect(calls).toEqual([{ name: "ls", arguments: {} }]);
	});

	it("returns null for ordinary text", () => {
		expect(parseEmulatedToolCalls("hello world")).toBeNull();
	});

	it("captures text before a tagged tool call", () => {
		const parsed = parseEmulatedToolResponse('Hello first.\n<tool_calls>[{"name":"ls","arguments":{}}]</tool_calls>');
		expect(parsed).toEqual({ calls: [{ name: "ls", arguments: {} }], prefixText: "Hello first." });
	});
});

describe("validateEmulatedToolCalls", () => {
	it("accepts known tool calls with schema-valid arguments", () => {
		const result = validateEmulatedToolCalls([{ name: "ls", arguments: { path: "." } }], [lsTool]);
		expect(result.errors).toEqual([]);
		expect(result.validCalls).toEqual([{ name: "ls", arguments: { path: "." } }]);
	});

	it("rejects unknown tools", () => {
		const result = validateEmulatedToolCalls([{ name: "nope", arguments: {} }], [lsTool]);
		expect(result.validCalls).toEqual([]);
		expect(result.errors[0]).toContain('Unknown tool "nope"');
	});

	it("rejects schema-invalid arguments", () => {
		const result = validateEmulatedToolCalls([{ name: "ls", arguments: { path: 123 } }], [lsTool]);
		expect(result.validCalls).toEqual([]);
		expect(result.errors[0]).toContain("Invalid arguments for ls");
	});
});

describe("convertContextForEmulatedTools", () => {
	it("serializes tool results as user text and does not replay tool-call JSON", () => {
		const messages = convertContextForEmulatedTools({
			systemPrompt: "system",
			tools: [lsTool],
			messages: [
				{ role: "user", content: "list files", timestamp: 0 },
				{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "ls", arguments: { path: "." } }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 },
				{ role: "toolResult", toolCallId: "1", toolName: "ls", content: [{ type: "text", text: "a\nb" }], isError: false, timestamp: 0 },
			],
		});
		expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
		expect(messages.at(-1)).toEqual({ role: "user", content: "Tool result for ls (1):\na\nb" });
	});
});

describe("streamPoeEmulatedTools", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("emits native pi tool-call events for valid emulated tool calls", async () => {
		const fetchMock = mockFetchResponses(['<tool_calls>[{"name":"ls","arguments":{"path":"."}}]</tool_calls>']);
		const context: Context = { messages: [{ role: "user", content: "list files", timestamp: 0 }], tools: [lsTool] };
		const events = await collectStream(streamPoeEmulatedTools(model, context, { apiKey: "test" }));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(events.map((e) => e.type)).toContain("toolcall_end");
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
	});

	it("repairs malformed tool calls and retries", async () => {
		const fetchMock = mockFetchResponses([
			'<tool_calls>[{"name":"ls","arguments":{"path":123}}]</tool_calls>',
			'<tool_calls>[{"name":"ls","arguments":{"path":"."}}]</tool_calls>',
		]);
		const context: Context = { messages: [{ role: "user", content: "list files", timestamp: 0 }], tools: [lsTool] };
		const events = await collectStream(streamPoeEmulatedTools(model, context, { apiKey: "test" }));

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
		expect(secondBody.messages.at(-1).content).toContain("Invalid arguments for ls");
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
	});

	it("emits text before tool calls for sandwich turns", async () => {
		const fetchMock = mockFetchResponses(['Hello! I will clean that up now.\n<tool_calls>[{"name":"ls","arguments":{"path":"."}}]</tool_calls>']);
		const context: Context = { messages: [{ role: "user", content: "say hi then list files", timestamp: 0 }], tools: [lsTool] };
		const events = await collectStream(streamPoeEmulatedTools(model, context, { apiKey: "test" }));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["text_delta", "toolcall_end"]));
		const done = events.at(-1);
		expect(done).toMatchObject({ type: "done", reason: "toolUse" });
		expect(done.message.content[0]).toMatchObject({ type: "text", text: "Hello! I will clean that up now." });
	});

	it("repairs native-agent-style tool preambles", async () => {
		const fetchMock = mockFetchResponses([
			"Let me check what model you're using and see if the emulated provider is active:",
			'<tool_calls>[{"name":"ls","arguments":{"path":"."}}]</tool_calls>',
		]);
		const context: Context = { messages: [{ role: "user", content: "check the repo", timestamp: 0 }], tools: [lsTool] };
		const events = await collectStream(streamPoeEmulatedTools(model, context, { apiKey: "test" }));

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
		expect(secondBody.messages.at(-1).content).toContain("did not include a <tool_calls> block");
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
	});

	it("does not repair ordinary final text", async () => {
		const fetchMock = mockFetchResponses(["No tool needed."]);
		const context: Context = { messages: [{ role: "user", content: "say hi", timestamp: 0 }], tools: [lsTool] };
		const events = await collectStream(streamPoeEmulatedTools(model, context, { apiKey: "test" }));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	});

	it("repairs scratchpad-like preambles that end with an action colon", async () => {
		const fetchMock = mockFetchResponses([
			'Thinking...\n> I can see the command succeeded. Let me check the stream handling now:',
			'<tool_calls>[{"name":"ls","arguments":{"path":"."}}]</tool_calls>',
		]);
		const context: Context = { messages: [{ role: "user", content: "check stream handling", timestamp: 0 }], tools: [lsTool] };
		const events = await collectStream(streamPoeEmulatedTools(model, context, { apiKey: "test" }));

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
	});

	it("emits an error after exhausting repair attempts", async () => {
		const fetchMock = mockFetchResponses([
			'<tool_calls>[{"name":"ls","arguments":{"path":123}}]</tool_calls>',
			'<tool_calls>[{"name":"ls","arguments":{"path":123}}]</tool_calls>',
			'<tool_calls>[{"name":"ls","arguments":{"path":123}}]</tool_calls>',
		]);
		const context: Context = { messages: [{ role: "user", content: "list files", timestamp: 0 }], tools: [lsTool] };
		const events = await collectStream(streamPoeEmulatedTools(model, context, { apiKey: "test" }));

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
		expect(events.at(-1).error.errorMessage).toContain("failed after 3 attempts");
	});
});
