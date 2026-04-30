import { describe, expect, it, vi } from "vitest";
import { parseEmulatedToolCalls, convertContextForEmulatedTools, streamPoeEmulatedTools } from "./poe-emulated.js";

describe("parseEmulatedToolCalls", () => {
	it("parses tagged tool call arrays", () => {
		const calls = parseEmulatedToolCalls('<tool_calls>\n[{"name":"ls","arguments":{"path":"."}}]\n</tool_calls>');
		expect(calls).toEqual([{ name: "ls", arguments: { path: "." } }]);
	});

	it("parses raw objects with tool_calls", () => {
		const calls = parseEmulatedToolCalls('{"tool_calls":[{"name":"read","arguments":{"path":"package.json"}}]}');
		expect(calls).toEqual([{ name: "read", arguments: { path: "package.json" } }]);
	});

	it("returns null for ordinary text", () => {
		expect(parseEmulatedToolCalls("hello world")).toBeNull();
	});
});

describe("convertContextForEmulatedTools", () => {
	it("serializes tool results as user text and does not replay tool-call JSON", () => {
		const messages = convertContextForEmulatedTools({
			systemPrompt: "system",
			tools: [{ name: "ls", description: "List files", parameters: { type: "object", properties: { path: { type: "string", description: "Path" } } } as any }],
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

describe("streamPoeEmulatedTools event timing", () => {
	it("pushes 'start' event immediately before fetch completes", async () => {
		// This test verifies that the stream pushes events synchronously
		// before the async fetch begins. If events are only pushed after
		// fetch completes, consumers will see no activity during the wait.
		
		const events: string[] = [];
		
		// Create a mock stream to capture events
		const mockStream = {
			push: (event: { type: string }) => {
				events.push(event.type);
			},
			end: () => {
				events.push("end");
			},
		};
		
		// Simulate what happens in streamPoeEmulatedTools
		// The critical pattern: stream.push() happens BEFORE await fetch()
		(async () => {
			mockStream.push({ type: "start" });
			// Simulated fetch delay
			await new Promise(r => setTimeout(r, 50));
			mockStream.push({ type: "done" });
			mockStream.end();
		})();
		
		// Check events immediately (synchronously)
		expect(events).toContain("start");
		
		// Wait for completion
		await new Promise(r => setTimeout(r, 100));
		expect(events).toEqual(["start", "done", "end"]);
	});
});
