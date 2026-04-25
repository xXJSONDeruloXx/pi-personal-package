/**
 * pi-compuse: Pi extension for GUI computer-use on macOS.
 *
 * Gives the LLM the ability to see and interact with the desktop:
 * click, type, scroll, drag, take screenshots, press hotkeys, etc.
 *
 * Uses pi's configured model for visual grounding (screenshot → coordinates).
 *
 * Config (env vars):
 *   PI_COMPUSE_GROUNDING_PROVIDER  - pi provider name for grounding (e.g. "openai", "anthropic", "google")
 *   PI_COMPUSE_GROUNDING_MODEL     - model ID for grounding (e.g. "gpt-4.1", "claude-sonnet-4-5-20250514")
 *                                    If not set, uses the currently active pi model.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { GuiRuntime } from "./runtime.js";
import { createGroundingProvider, type GroundingModelResolver } from "./grounding.js";
import { startRecording, stopRecording, listSkills, deleteSkill, isRecording, getActiveSkillName } from "./learn.js";

// ─── Shared field schemas ──────────────────────────────────────────────────

const AppField = Type.Optional(Type.String({ description: "Optional macOS application name to target. Defaults to the frontmost app." }));
const TargetField = (desc: string) => Type.Optional(Type.String({ description: desc }));
const ScopeField = Type.Optional(Type.String({ description: 'Optional visible container hint (e.g. "Save As dialog", "left sidebar").' }));
const CaptureModeField = Type.Optional(Type.Union([Type.Literal("window"), Type.Literal("display")], { description: 'Capture surface: "window" for app window, "display" for full desktop.' }));
const GroundingModeField = Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("complex")], { description: 'Use "complex" when the target is ambiguous or a prior attempt failed.' }));
const LocationHintField = Type.Optional(Type.String({ description: 'Coarse location hint (e.g. "top-left", "bottom toolbar").' }));
const WindowTitleField = Type.Optional(Type.String({ description: "Exact visible window title to capture." }));

// ─── Extension ─────────────────────────────────────────────────────────────

export default function piCompuse(pi: ExtensionAPI) {
	const runtime = new GuiRuntime();

	// Model resolver: resolves grounding model from pi's registry
	function createResolver(ctx: ExtensionContext): GroundingModelResolver {
		return {
			async resolve() {
				const envProvider = process.env.PI_COMPUSE_GROUNDING_PROVIDER?.trim();
				const envModel = process.env.PI_COMPUSE_GROUNDING_MODEL?.trim();

				let model;
				if (envProvider && envModel) {
					model = ctx.modelRegistry.find(envProvider, envModel);
					if (!model) throw new Error(`Grounding model ${envProvider}/${envModel} not found in pi's model registry.`);
				} else if (envModel) {
					const all = ctx.modelRegistry.getAll();
					model = all.find(m => m.id === envModel);
					if (!model) throw new Error(`Grounding model "${envModel}" not found in pi's model registry.`);
				} else {
					model = ctx.model;
					if (!model) throw new Error("No active model. Set PI_COMPUSE_GROUNDING_MODEL or select a model in pi.");
				}

				if (!model.input.includes("image")) {
					throw new Error(`Model ${model.provider}/${model.id} doesn't support image input. Set PI_COMPUSE_GROUNDING_MODEL to a vision model.`);
				}

				const apiKey = await ctx.modelRegistry.getApiKey(model);
				if (!apiKey) throw new Error(`No API key for model ${model.provider}/${model.id}. Configure it in pi.`);

				return { model, apiKey };
			},
		};
	}

	// Helper to run a tool with grounding initialized
	async function withGrounding<T>(ctx: ExtensionContext, fn: () => Promise<T>): Promise<T> {
		const provider = createGroundingProvider(createResolver(ctx));
		runtime.setGroundingProvider(provider);
		try {
			return await fn();
		} finally {
			runtime.setGroundingProvider(undefined);
		}
	}

	// Helper to convert GuiActionResult to tool result
	function toToolResult(result: { text: string; image?: { data: string; mimeType: string }; details?: Record<string, unknown> }) {
		const content: any[] = [{ type: "text", text: result.text }];
		if (result.image) {
			content.push({ type: "image", data: result.image.data, mimeType: result.image.mimeType });
		}
		return { content, details: result.details ?? {} };
	}

	// ─── GUI Read ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_read",
		label: "GUI Read",
		description: "Capture and inspect the current GUI state. Optionally ground a visual target on the screenshot.",
		promptSnippet: "Capture a GUI screenshot and optionally locate a visual target on it",
		promptGuidelines: [
			"Use gui_read to observe the current desktop or app state. Plan multiple actions from one observation.",
			"Action tools (gui_click, gui_type, etc.) do NOT return screenshots. Only gui_read and gui_screenshot return images.",
			"Workflow: gui_read to observe → plan a sequence of actions → execute them → gui_read again only if you need to verify or see new state.",
		],
		parameters: Type.Object({
			app: AppField,
			target: TargetField('Optional target to locate. Quote visible text, e.g. \'button labeled "Save"\'.'),
			scope: ScopeField,
			captureMode: CaptureModeField,
			groundingMode: GroundingModeField,
			locationHint: LocationHintField,
			windowTitle: WindowTitleField,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return withGrounding(ctx, async () => toToolResult(await runtime.performRead(params)));
		},
	});

	// ─── GUI Click ─────────────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_click",
		label: "GUI Click",
		description: "Click a visually grounded GUI target. Defaults to left-click. Set button to \"right\" for a context-menu right-click. Name the control in `target`, e.g. 'button labeled \"Save\"'.",
		promptSnippet: "Click a GUI element (left-click by default, or right-click with button=\"right\")",
		parameters: Type.Object({
			app: AppField,
			target: Type.String({ description: 'Target to click. Quote visible text, e.g. \'button labeled "Save"\'.' }),
			button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], { description: 'Mouse button to use. "left" (default) for normal click, "right" for context-menu click, "middle" for middle-click (e.g. open link in new tab).' })),
			modifiers: Type.Optional(Type.Array(Type.String({ description: '"shift", "option", "control", or "command"' }), { description: 'Hold modifier keys during the click. E.g. ["shift"] for Shift+click range select, ["command"] for Cmd+click multi-select.' })),
			scope: ScopeField,
			captureMode: CaptureModeField,
			groundingMode: GroundingModeField,
			locationHint: LocationHintField,
			windowTitle: WindowTitleField,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return withGrounding(ctx, async () => toToolResult(await runtime.performClick(params)));
		},
	});

	// ─── GUI Right Click ───────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_right_click",
		label: "GUI Right Click",
		description: "Right-click a GUI target to open a context menu. (Equivalent to gui_click with button=\"right\".)",
		promptSnippet: "Right-click a GUI element to open its context menu",
		parameters: Type.Object({
			app: AppField,
			target: Type.String({ description: 'Target to right-click. Quote visible text.' }),
			scope: ScopeField,
			captureMode: CaptureModeField,
			groundingMode: GroundingModeField,
			locationHint: LocationHintField,
			windowTitle: WindowTitleField,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return withGrounding(ctx, async () => toToolResult(await runtime.performRightClick(params)));
		},
	});

	// ─── GUI Double Click ──────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_double_click",
		label: "GUI Double Click",
		description: "Double-click a GUI target. Use for opening files, selecting words, etc.",
		promptSnippet: "Double-click a GUI element (open files, select words, etc.)",
		parameters: Type.Object({
			app: AppField,
			target: Type.String({ description: 'Target to double-click. Quote visible text.' }),
			modifiers: Type.Optional(Type.Array(Type.String({ description: '"shift", "option", "control", or "command"' }), { description: "Hold modifier keys during the double-click." })),
			scope: ScopeField,
			captureMode: CaptureModeField,
			groundingMode: GroundingModeField,
			locationHint: LocationHintField,
			windowTitle: WindowTitleField,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return withGrounding(ctx, async () => toToolResult(await runtime.performDoubleClick(params)));
		},
	});

	// ─── GUI Hover ─────────────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_hover",
		label: "GUI Hover",
		description: "Hover the pointer over a GUI target without clicking. For tooltips and hover menus.",
		promptSnippet: "Hover over a GUI element (tooltips, hover menus)",
		parameters: Type.Object({
			app: AppField,
			target: Type.String({ description: 'Target to hover.' }),
			scope: ScopeField,
			captureMode: CaptureModeField,
			groundingMode: GroundingModeField,
			locationHint: LocationHintField,
			windowTitle: WindowTitleField,
			settleMs: Type.Optional(Type.Number({ description: "Hover settle time in ms. Default: 200." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return withGrounding(ctx, async () => toToolResult(await runtime.performHover(params)));
		},
	});

	// ─── GUI Drag ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_drag",
		label: "GUI Drag",
		description: "Drag from one GUI target to another.",
		promptSnippet: "Drag between two GUI elements",
		parameters: Type.Object({
			app: AppField,
			fromTarget: Type.String({ description: 'Drag source target.' }),
			toTarget: Type.String({ description: 'Drag destination target.' }),
			fromScope: Type.Optional(Type.String({ description: "Scope for drag source." })),
			toScope: Type.Optional(Type.String({ description: "Scope for drag destination." })),
			modifiers: Type.Optional(Type.Array(Type.String({ description: '"shift", "option", "control", or "command"' }), { description: 'Hold modifier keys during drag. E.g. ["option"] for Option+drag to duplicate.' })),
			captureMode: CaptureModeField,
			groundingMode: GroundingModeField,
			fromLocationHint: Type.Optional(Type.String({ description: "Location hint for source." })),
			toLocationHint: Type.Optional(Type.String({ description: "Location hint for destination." })),
			windowTitle: WindowTitleField,
			durationMs: Type.Optional(Type.Number({ description: "Drag duration in ms. Default: 450." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return withGrounding(ctx, async () => toToolResult(await runtime.performDrag(params)));
		},
	});

	// ─── GUI Scroll ────────────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_scroll",
		label: "GUI Scroll",
		description: "Scroll a GUI region in a direction. Optionally target a specific scrollable area.",
		promptSnippet: "Scroll a GUI region up/down/left/right",
		parameters: Type.Object({
			app: AppField,
			target: TargetField("Optional scrollable area to target."),
			scope: ScopeField,
			captureMode: CaptureModeField,
			groundingMode: GroundingModeField,
			locationHint: LocationHintField,
			windowTitle: WindowTitleField,
			direction: Type.Optional(Type.Union([
				Type.Literal("up"), Type.Literal("down"),
				Type.Literal("left"), Type.Literal("right"),
			], { description: 'Scroll direction. Default: "down".' })),
			amount: Type.Optional(Type.Number({ description: "Scroll amount (lines). Default: 5." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return withGrounding(ctx, async () => toToolResult(await runtime.performScroll(params)));
		},
	});

	// ─── GUI Type ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_type",
		label: "GUI Type",
		description: "Type text into a GUI input field. Optionally target a specific field first.",
		promptSnippet: "Type text into a GUI input field",
		parameters: Type.Object({
			app: AppField,
			target: TargetField('Optional input field to target. E.g. \'search field with placeholder "Search..."\''),
			scope: ScopeField,
			captureMode: CaptureModeField,
			groundingMode: GroundingModeField,
			locationHint: LocationHintField,
			windowTitle: WindowTitleField,
			value: Type.String({ description: "Text to type." }),
			replace: Type.Optional(Type.Boolean({ description: "Replace existing text. Default: true." })),
			submit: Type.Optional(Type.Boolean({ description: "Press Return after typing." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return withGrounding(ctx, async () => toToolResult(await runtime.performType(params)));
		},
	});

	// ─── GUI Keypress ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_keypress",
		label: "GUI Keypress",
		description: "Press a single key (Enter, Tab, Escape, Space, arrows, etc.). For modifier combos use gui_hotkey.",
		promptSnippet: "Press a single key (Enter, Tab, Escape, arrows, etc.)",
		parameters: Type.Object({
			app: AppField,
			key: Type.String({ description: 'Key to press: "Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "ArrowDown", etc.' }),
			modifiers: Type.Optional(Type.Array(Type.String({ description: '"shift", "option", "control", or "command"' }))),
			repeat: Type.Optional(Type.Number({ description: "Times to press. Default: 1." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return toToolResult(await runtime.performKeypress(params));
		},
	});

	// ─── GUI Hotkey ────────────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_hotkey",
		label: "GUI Hotkey",
		description: "Send a keyboard shortcut (modifier+key combo). E.g. Command+S, Shift+Command+P.",
		promptSnippet: "Send a keyboard shortcut like Command+S, Command+Z, etc.",
		parameters: Type.Object({
			app: AppField,
			key: Type.String({ description: 'Key with modifiers, e.g. "s" for Command+S.' }),
			modifiers: Type.Optional(Type.Array(Type.String({ description: '"command", "shift", "option", "control". Default: ["command"].' }))),
			repeat: Type.Optional(Type.Number({ description: "Times to send. Default: 1." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return toToolResult(await runtime.performHotkey(params));
		},
	});

	// ─── GUI Triple Click ──────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_triple_click",
		label: "GUI Triple Click",
		description: "Triple-click a GUI target. Selects an entire line or paragraph of text.",
		promptSnippet: "Triple-click to select an entire line or paragraph",
		parameters: Type.Object({
			app: AppField,
			target: Type.String({ description: 'Target to triple-click. Quote visible text.' }),
			modifiers: Type.Optional(Type.Array(Type.String({ description: '"shift", "option", "control", or "command"' }), { description: "Hold modifier keys during the triple-click." })),
			scope: ScopeField,
			captureMode: CaptureModeField,
			groundingMode: GroundingModeField,
			locationHint: LocationHintField,
			windowTitle: WindowTitleField,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return withGrounding(ctx, async () => toToolResult(await runtime.performTripleClick(params)));
		},
	});

	// ─── GUI Screenshot ────────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_screenshot",
		label: "GUI Screenshot",
		description: "Capture a screenshot of the current GUI state.",
		promptSnippet: "Capture a screenshot of the desktop or app window",
		parameters: Type.Object({
			app: AppField,
			captureMode: CaptureModeField,
			windowTitle: WindowTitleField,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return toToolResult(await runtime.performScreenshot(params));
		},
	});

	// ─── GUI Cursor Position ───────────────────────────────────────────────

	pi.registerTool({
		name: "gui_cursor_position",
		label: "GUI Cursor Position",
		description: "Get the current mouse cursor position in display coordinates.",
		promptSnippet: "Get the current mouse cursor position (x, y)",
		parameters: Type.Object({}),
		async execute() {
			return toToolResult(await runtime.performCursorPosition());
		},
	});

	// ─── GUI Clipboard Read ────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_clipboard_read",
		label: "GUI Clipboard Read",
		description: "Read text content from the system clipboard.",
		promptSnippet: "Read text from the macOS clipboard",
		parameters: Type.Object({}),
		async execute() {
			return toToolResult(await runtime.performClipboardRead());
		},
	});

	// ─── GUI Clipboard Write ───────────────────────────────────────────────

	pi.registerTool({
		name: "gui_clipboard_write",
		label: "GUI Clipboard Write",
		description: "Write text to the system clipboard.",
		promptSnippet: "Write text to the macOS clipboard",
		parameters: Type.Object({
			text: Type.String({ description: "Text to write to the clipboard." }),
		}),
		async execute(_id, params) {
			return toToolResult(await runtime.performClipboardWrite(params));
		},
	});

	// ─── GUI Wait ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_wait",
		label: "GUI Wait",
		description: "Pause for a specified duration. Useful between GUI actions to wait for animations, loading, etc.",
		promptSnippet: "Wait/pause for a specified number of milliseconds",
		parameters: Type.Object({
			ms: Type.Number({ description: "Milliseconds to wait (max 30000)." }),
		}),
		async execute(_id, params) {
			return toToolResult(await runtime.performWait(params));
		},
	});

	// ─── GUI Batch ─────────────────────────────────────────────────────────

	pi.registerTool({
		name: "gui_batch",
		label: "GUI Batch",
		description: [
			"Execute a sequence of GUI actions in one tool call. Reduces round-trips for multi-step workflows.",
			"Each action object has an \"action\" field and action-specific fields:",
			"• click: target, button?, modifiers?, app?, scope?, locationHint?",
			"• right_click / double_click / triple_click: target, modifiers?, app?, scope?",
			"• type: value, target?, replace?, submit?, app?",
			"• keypress: key, modifiers?, repeat?, app?",
			"• hotkey: key, modifiers?, repeat?, app?",
			"• scroll: direction?, amount?, target?, app?, scope?",
			"• hover: target, app?, scope?, settleMs?",
			"• drag: fromTarget, toTarget, modifiers?, app?, durationMs?",
			"• wait: ms",
			"• clipboard_read (no extra fields)",
			"• clipboard_write: text",
			"Execution stops on first error.",
		].join("\n"),
		promptSnippet: "Chain multiple GUI actions (click, type, keypress, scroll, wait, etc.) in a single tool call",
		promptGuidelines: [
			"Use gui_batch to chain multiple actions when you know the full sequence upfront. Each grounded action (click, type with target) takes a fresh screenshot, but you save LLM round-trips.",
			"Example: gui_batch({ actions: [{ action: 'click', target: 'search field' }, { action: 'type', value: 'hello' }, { action: 'keypress', key: 'Enter' }] })",
		],
		parameters: Type.Object({
			actions: Type.Array(Type.Object({
				action: Type.String({ description: 'Action type: click, right_click, double_click, triple_click, type, keypress, hotkey, scroll, hover, drag, wait, clipboard_read, clipboard_write' }),
				app: Type.Optional(Type.String({ description: "Target application." })),
				target: Type.Optional(Type.String({ description: "Visual target for grounding." })),
				scope: Type.Optional(Type.String({ description: "Scope hint for grounding." })),
				locationHint: Type.Optional(Type.String({ description: "Coarse location hint." })),
				captureMode: Type.Optional(Type.String({ description: '"window" or "display".' })),
				groundingMode: Type.Optional(Type.String({ description: '"single" or "complex".' })),
				windowTitle: Type.Optional(Type.String({ description: "Window title filter." })),
				button: Type.Optional(Type.String({ description: '"left", "right", or "middle" (for click).' })),
				modifiers: Type.Optional(Type.Array(Type.String(), { description: 'Modifier keys: "shift", "option", "control", "command".' })),
				value: Type.Optional(Type.String({ description: "Text to type (for type action)." })),
				text: Type.Optional(Type.String({ description: "Text for clipboard_write." })),
				replace: Type.Optional(Type.Boolean({ description: "Replace existing text (for type)." })),
				submit: Type.Optional(Type.Boolean({ description: "Press Return after typing (for type)." })),
				key: Type.Optional(Type.String({ description: "Key name (for keypress/hotkey)." })),
				repeat: Type.Optional(Type.Number({ description: "Times to repeat (for keypress/hotkey)." })),
				direction: Type.Optional(Type.String({ description: 'Scroll direction: "up", "down", "left", "right".' })),
				amount: Type.Optional(Type.Number({ description: "Scroll amount in lines." })),
				ms: Type.Optional(Type.Number({ description: "Wait duration in milliseconds." })),
				settleMs: Type.Optional(Type.Number({ description: "Hover settle time in ms." })),
				fromTarget: Type.Optional(Type.String({ description: "Drag source target." })),
				toTarget: Type.Optional(Type.String({ description: "Drag destination target." })),
				fromScope: Type.Optional(Type.String({ description: "Scope for drag source." })),
				toScope: Type.Optional(Type.String({ description: "Scope for drag destination." })),
				durationMs: Type.Optional(Type.Number({ description: "Drag duration in ms." })),
			}), { description: "Ordered list of actions to execute sequentially." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return withGrounding(ctx, async () => toToolResult(await runtime.performBatch(params)));
		},
	});

	// ─── /learn command ────────────────────────────────────────────────────

	pi.registerCommand("learn", {
		description: "Record a GUI demonstration and save as a skill. Usage: /learn <name> | /learn stop | /learn list | /learn delete <name>",
		getArgumentCompletions(prefix: string) {
			const subcommands = ["stop", "list", "delete"];
			if (!prefix) return subcommands.map(s => ({ label: s, value: s }));
			return subcommands
				.filter(s => s.startsWith(prefix.toLowerCase()))
				.map(s => ({ label: s, value: s }));
		},
		async handler(args: string, ctx) {
			const trimmed = args.trim();
			const [subcommand, ...rest] = trimmed.split(/\s+/);

			if (!subcommand) {
				ctx.ui.notify("Usage: /learn <skill-name> | /learn stop | /learn list | /learn delete <name>", "info");
				return;
			}

			if (subcommand === "list") {
				const skills = await listSkills();
				if (skills.length === 0) {
					ctx.ui.notify("No learned skills found. Use /learn <name> to record one.", "info");
				} else {
					const lines = skills.map(s => `• ${s.name} — ${s.description}`).join("\n");
					ctx.ui.notify(`Learned skills:\n${lines}`, "info");
				}
				return;
			}

			if (subcommand === "delete") {
				const name = rest.join("-").trim();
				if (!name) {
					ctx.ui.notify("Usage: /learn delete <skill-name>", "warning");
					return;
				}
				const deleted = await deleteSkill(name);
				if (deleted) {
					ctx.ui.notify(`Deleted skill "${name}".`, "info");
					await ctx.reload();
				} else {
					ctx.ui.notify(`Skill "${name}" not found.`, "warning");
				}
				return;
			}

			if (subcommand === "stop") {
				if (!isRecording()) {
					ctx.ui.notify("No active recording. Start one with /learn <skill-name>.", "warning");
					return;
				}
				ctx.ui.notify("Stopping recording and analyzing demonstration...", "info");
				ctx.ui.setStatus("pi-compuse", "🔴 Analyzing recording...");
				try {
					const result = await stopRecording(createResolver(ctx));
					ctx.ui.notify(
						`Skill "${result.skillName}" saved to ${result.skillPath}\n` +
						`Recorded ${result.eventCount} events and ${result.screenshotCount} screenshots over ${Math.round(result.durationMs / 1000)}s.`,
						"info",
					);
					ctx.ui.setStatus("pi-compuse", "🖥️ GUI tools active");
					// Reload so pi picks up the new skill
					await ctx.reload();
					// Send a message to tell the agent about the new skill
					ctx.sendUserMessage(
						`I just demonstrated and saved a GUI skill called "${result.skillName}". ` +
						`It's now available as /skill:${result.skillName}. ` +
						`Load it with the read tool from ${result.skillPath} when you need to perform this workflow.`,
						{ deliverAs: "followUp" },
					);
				} catch (error: any) {
					ctx.ui.notify(`Learn analysis failed: ${error.message}`, "error");
					ctx.ui.setStatus("pi-compuse", "🖥️ GUI tools active");
				}
				return;
			}

			// Default: start recording with the given name
			if (isRecording()) {
				ctx.ui.notify(`Already recording skill "${getActiveSkillName()}". Run /learn stop first.`, "warning");
				return;
			}

			try {
				const skillName = await startRecording(subcommand + (rest.length ? "-" + rest.join("-") : ""));
				ctx.ui.notify(
					`🔴 Recording skill "${skillName}".\n` +
					`Demonstrate the workflow on your Mac, then run /learn stop when done.\n` +
					`Recording: input events + screenshots every ${SCREENSHOT_INTERVAL_MS / 1000}s.`,
					"info",
				);
				ctx.ui.setStatus("pi-compuse", `🔴 Recording: ${skillName}`);
			} catch (error: any) {
				ctx.ui.notify(`Failed to start recording: ${error.message}`, "error");
			}
		},
	});

	const SCREENSHOT_INTERVAL_MS = 4_000;

	// ─── Notify on load ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (process.platform !== "darwin") {
			ctx.ui.notify("pi-compuse: GUI tools are macOS-only. They won't work on this platform.", "warning");
			return;
		}
		ctx.ui.setStatus("pi-compuse", "🖥️ GUI tools active");
	});
}
