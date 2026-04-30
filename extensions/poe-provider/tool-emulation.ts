/**
 * Tool emulation for Poe models that don't support native tool calling.
 *
 * Strategy: Convert native tool calls to text prompts for non-tool-capable models
 * - Strip tools from the API request (to avoid 400 errors)
 * - Inject tool descriptions as text into system prompt
 * - Parse model's text response for tool call patterns
 * - Convert parsed tool calls back to native format for execution
 */

import type {
	ExtensionAPI,
	Message,
	TextContent,
	ToolCallContent,
} from "@mariozechner/pi-coding-agent";

// Models known to NOT support native tool calling via Poe API
export const NON_TOOL_MODELS = new Set([
	"glm-5.1-t",
	"glm-5-t",
	"gemma-4-31b-t",
	"gemma-4-4b-t",
	"gemma-4-12b-t",
	"qwen3.5-397b-a17b-t",
	"qwen3.5-32b-a3b-t",
]);

/**
 * Check if a model requires tool emulation
 */
export function requiresToolEmulation(modelId: string): boolean {
	return NON_TOOL_MODELS.has(modelId);
}

/**
 * Add a model to the non-tool list dynamically
 */
export function registerNonToolModel(modelId: string): void {
	NON_TOOL_MODELS.add(modelId);
}

/**
 * Convert tool definitions into a text prompt format
 * Uses XML-style format that models like GLM are trained on
 */
export function toolsToTextPrompt(tools: Array<{ name: string; description: string; parameters: unknown }>): string {
	if (tools.length === 0) return "";

	const toolDescriptions = tools
		.map((tool) => {
			return `**${tool.name}**: ${tool.description}\nParameters schema: ${JSON.stringify(tool.parameters)}`;
		})
		.join("\n\n");

	// Get first tool for examples
	const firstTool = tools[0];
	const exampleToolName = firstTool?.name ?? "bash";
	const exampleParam = firstTool?.parameters && typeof firstTool.parameters === "object"
		? Object.keys(firstTool.parameters)[0] ?? "command"
		: "command";

	return `

---
You have access to the following tools:

${toolDescriptions}

When you need to use a tool, output it in this EXACT format:

<tool_call>${exampleToolName}
<arg_key>${exampleParam}</arg_key><arg_value>your value here</arg_value></tool_call>

If a tool needs multiple parameters, use multiple <arg_key>/<arg_value> pairs:
<tool_call>${exampleToolName}
<arg_key>param1</arg_key><arg_value>value1</arg_value>
<arg_key>param2</arg_key><arg_value>value2</arg_value></tool_call>

You can use multiple tools by outputting multiple <tool_call> blocks.
After tool results are returned, you will receive the results and can continue.
---`;
}

/**
 * Parse TOOL_CALL blocks from assistant response
 */
export function parseToolCalls(content: string): Array<{ name: string; arguments: Record<string, unknown> }> | null {
	const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

	// GLM's weird custom XML format: <tool_call>tool_name\n<arg_key>param</arg_key><arg_value>value</arg_value>...</tool_call>
	const glmXmlRegex = /<tool_call>(\w+)\s*((?:<arg_key>[^<]+<\/arg_key><arg_value>[^<]*<\/arg_value>\s*)+)<\/tool_call>/g;
	let match;

	while ((match = glmXmlRegex.exec(content)) !== null) {
		const name = match[1];
		const argsText = match[2];
		try {
			// Parse the arg_key/arg_value pairs
			const args: Record<string, string> = {};
			const argRegex = /<arg_key>([^<]+)<\/arg_key><arg_value>([^<]*)<\/arg_value>/g;
			let argMatch;
			while ((argMatch = argRegex.exec(argsText)) !== null) {
				args[argMatch[1]] = argMatch[2];
			}
			if (Object.keys(args).length > 0) {
				calls.push({ name, arguments: args });
			}
		} catch {
			// Parsing failed, skip
		}
	}

	return calls.length > 0 ? calls : null;
}

/**
 * State tracking for hybrid tool execution
 */
interface EmulationState {
	originalModel: string;
	pendingToolCalls: Array<{ id: string; name: string; arguments: unknown }>;
	conversationBuffer: Message[];
}

const activeEmulations = new Map<string, EmulationState>();

/**
 * Generate unique ID for tool call
 */
function generateToolCallId(): string {
	return `emulated_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Setup tool emulation hooks
 */
export function setupToolEmulation(pi: ExtensionAPI): void {
	console.error(`[poe-emulation] Setting up tool emulation hooks`);

	// Intercept requests to non-tool models - strip tools and add text descriptions
	pi.on("before_provider_request", async (event, ctx) => {
		const modelId = ctx.model?.id;
		console.error(`[poe-emulation] before_provider_request: model=${modelId}, requiresEmulation=${modelId ? requiresToolEmulation(modelId) : 'n/a'}`);

		if (!modelId || !requiresToolEmulation(modelId)) {
			return undefined;
		}

		// Get the payload
		const payload = event.payload;
		console.error(`[poe-emulation] Payload has ${payload.tools?.length ?? 0} tools`);

		if (!payload.tools || payload.tools.length === 0) {
			return undefined;
		}

		// Save tools and messages before modifying
		const originalTools = payload.tools;

		// Convert tools to text and prepare modified messages
		const toolsText = toolsToTextPrompt(originalTools);

		// Deep clone messages and add tool instructions
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let modifiedMessages: any[];
		if (payload.messages && Array.isArray(payload.messages)) {
			modifiedMessages = JSON.parse(JSON.stringify(payload.messages));

			// Find system message or prepend one
			const systemIdx = modifiedMessages.findIndex((m: { role: string }) => m.role === "system");
			if (systemIdx >= 0) {
				const systemMsg = modifiedMessages[systemIdx];
				if (typeof systemMsg.content === "string") {
					systemMsg.content += toolsText;
				} else if (Array.isArray(systemMsg.content)) {
					const textBlock = systemMsg.content.find((c: { type: string }) => c.type === "text");
					if (textBlock) {
						textBlock.text += toolsText;
					} else {
						systemMsg.content.push({ type: "text", text: toolsText });
					}
				}
			} else {
				modifiedMessages.unshift({
					role: "system",
					content: `You are a helpful coding assistant.${toolsText}`,
				});
			}
		} else {
			modifiedMessages = [{
				role: "system",
				content: `You are a helpful coding assistant.${toolsText}`,
			}];
		}

		// Create new payload without tools field and with modified messages
		// We must return a new object - mutating may not work
		const modifiedPayload: Record<string, unknown> = {};
		for (const key of Object.keys(payload)) {
			if (key !== "tools" && key !== "tool_choice") {
				modifiedPayload[key] = payload[key as keyof typeof payload];
			}
		}
		modifiedPayload.messages = modifiedMessages;

		// Log what we're returning to verify no tools
		const hasTools = 'tools' in modifiedPayload;
		console.error(`[poe-emulation] Returning modified payload with ${modifiedMessages.length} messages, has tools field: ${hasTools}`);
		console.error(`[poe-emulation] Modified payload keys: ${Object.keys(modifiedPayload).join(', ')}`);

		// Initialize emulation state
		activeEmulations.set(modelId, {
			originalModel: modelId,
			pendingToolCalls: [],
			conversationBuffer: [],
		});

		return modifiedPayload;
	});

	// After assistant response, check for tool calls in text
	pi.on("message_end", async (event, ctx) => {
		const modelId = ctx.model?.id;
		if (!modelId || !requiresToolEmulation(modelId)) {
			return;
		}

		const message = event.message;
		if (message.role !== "assistant") {
			return;
		}

		// Extract text content
		let textContent = "";
		if (typeof message.content === "string") {
			textContent = message.content;
		} else if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "text") {
					textContent += block.text;
				}
			}
		}

		// Parse for tool calls
		const parsedCalls = parseToolCalls(textContent);
		if (!parsedCalls || parsedCalls.length === 0) {
			// No tool calls, emulation not needed
			activeEmulations.delete(modelId);
			return;
		}

		// Store the pending calls
		const state = activeEmulations.get(modelId);
		if (!state) return;

		// Generate IDs and store
		const toolCallsWithIds = parsedCalls.map((call) => ({
			id: generateToolCallId(),
			name: call.name,
			arguments: call.arguments,
		}));

		state.pendingToolCalls = toolCallsWithIds;

		// Inject a hidden message with tool calls in proper format
		// This allows pi to handle them through normal tool flow
		const toolCallBlocks: ToolCallContent[] = toolCallsWithIds.map((tc) => ({
			type: "toolCall",
			id: tc.id,
			name: tc.name,
			arguments: tc.arguments as Record<string, unknown>,
		}));

		// Append tool calls to the message content
		if (Array.isArray(message.content)) {
			message.content.push(...toolCallBlocks);
		} else if (typeof message.content === "string") {
			// Convert to array with text + tool calls
			message.content = [
				{ type: "text", text: message.content },
				...toolCallBlocks,
			];
		}
	});
}

/**
 * Get list of models currently requiring emulation
 */
export function getNonToolModels(): string[] {
	return Array.from(NON_TOOL_MODELS);
}
