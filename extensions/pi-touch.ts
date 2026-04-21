import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Component, OverlayHandle, TUI, Theme } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

type TouchCommand =
	| "on"
	| "off"
	| "toggle"
	| "status"
	| "log"
	| "top"
	| "bottom"
	| "page-up"
	| "page-down";

type TouchAction = "top" | "pageUp" | "model" | "pageDown" | "bottom" | "etc";

type MouseInput = {
	raw: string;
	code: number;
	col: number;
	row: number;
	phase: "press" | "release";
};

type ViewportDebugState = {
	scrollTop: number;
	visibleHeight: number;
	totalLines: number;
	maxTop: number;
	followBottom: boolean;
	percent: number;
};

const COMMANDS: TouchCommand[] = ["on", "off", "toggle", "status", "log", "top", "bottom", "page-up", "page-down"];
const STATUS_KEY = "pi-touch";
const BOOTSTRAP_WIDGET_KEY = "pi-touch-bootstrap";
const CHAT_CHILD_INDEX = 1;
const LOG_PATH = path.join(os.homedir(), ".pi", "agent", "logs", "pi-touch.log");
const PERSIST_PATH = path.join(os.homedir(), ".pi", "agent", "pi-touch-persist.json");
const BAR_WIDGET_KEY = "pi-touch-bar";
const BAR_HEIGHT = 3;
const BUTTON_GAP = 1;
const BAR_LEADING = 1;
const MODEL_CYCLE_INPUT = "\x10";
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";
const EMPTY_COMPONENT: Component = {
	render: () => [],
	invalidate: () => {},
};

const BUTTONS: { action: TouchAction; label: string }[] = [
	{ action: "top", label: " TOP " },
	{ action: "pageUp", label: " PG↑ " },
	{ action: "model", label: "MODEL" },
	{ action: "pageDown", label: " PG↓ " },
	{ action: "bottom", label: " END " },
	{ action: "etc", label: " ETC " },
];

/** Utility buttons shown in the ETC top overlay. Add more entries here to extend. */
const TOP_BUTTONS: { label: string; command: string }[] = [
	{ label: " /new  ", command: "/new" },
	{ label: "/reload", command: "/reload" },
];

type BarButtonBounds = {
	action: TouchAction;
	colStart: number;
	colEnd: number;
};

type UtilButtonBounds = {
	command: string;
	colStart: number;
	colEnd: number;
};

const state: {
	enabled: boolean;
	theme?: Theme;
	tui?: TUI;
	viewport?: TouchViewport;
	originalChat?: Component;
	barRow: number;
	barButtons: BarButtonBounds[];
	etcOverlayVisible: boolean;
	topOverlay?: OverlayHandle;
	topOverlayButtons: UtilButtonBounds[];
	inputUnsubscribe?: () => void;
	logQueue: Promise<void>;
	lastInput?: string;
	lastMouse?: MouseInput;
	lastAction?: string;
	statusSink?: (key: string, text: string | undefined) => void;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
	setEditorText?: (text: string) => void;
	setWidget?: (key: string, content: any, options?: any) => void;
} = {
	enabled: false,
	barRow: 0,
	barButtons: [],
	etcOverlayVisible: false,
	topOverlayButtons: [],
	logQueue: Promise.resolve(),
};

function getTheme(): Theme {
	if (!state.theme) {
		throw new Error("pi-touch theme not initialized");
	}
	return state.theme;
}

class TouchViewport implements Component {
	readonly __piTouchViewport = true;

	private scrollTop = 0;
	private followBottom = true;
	private lastVisibleHeight = 1;
	private lastTotalLines = 0;
	private lastMaxTop = 0;

	constructor(
		private readonly tui: TUI,
		private readonly content: Component,
	) {}

	render(width: number): string[] {
		const fixedHeight = this.tui.children
			.filter((child) => child !== this)
			.reduce((sum, child) => sum + child.render(width).length, 0);
		const visibleHeight = Math.max(1, this.tui.terminal.rows - fixedHeight);
		const lines = this.content.render(width);
		const maxTop = Math.max(0, lines.length - visibleHeight);

		if (this.followBottom) this.scrollTop = maxTop;
		this.scrollTop = Math.max(0, Math.min(maxTop, this.scrollTop));
		this.lastVisibleHeight = visibleHeight;
		this.lastTotalLines = lines.length;
		this.lastMaxTop = maxTop;

		const visible = lines.slice(this.scrollTop, this.scrollTop + visibleHeight);
		while (visible.length < visibleHeight) visible.push("");
		return visible;
	}

	invalidate(): void {
		this.content.invalidate();
	}

	scrollLines(delta: number): void {
		if (delta === 0) return;
		this.followBottom = false;
		this.scrollTop = Math.max(0, Math.min(this.lastMaxTop, this.scrollTop + delta));
		if (this.scrollTop >= this.lastMaxTop) this.followBottom = true;
		this.tui.requestRender();
	}

	pageUp(): void {
		this.scrollLines(-this.getPageSize());
	}

	pageDown(): void {
		this.scrollLines(this.getPageSize());
	}

	toTop(): void {
		this.followBottom = false;
		this.scrollTop = 0;
		this.tui.requestRender();
	}

	toBottom(): void {
		this.followBottom = true;
		this.scrollTop = this.lastMaxTop;
		this.tui.requestRender();
	}

	getDebugState(): ViewportDebugState {
		const percent = this.lastMaxTop === 0 ? 100 : Math.round((this.scrollTop / this.lastMaxTop) * 100);
		return {
			scrollTop: this.scrollTop,
			visibleHeight: this.lastVisibleHeight,
			totalLines: this.lastTotalLines,
			maxTop: this.lastMaxTop,
			followBottom: this.followBottom,
			percent,
		};
	}

	private getPageSize(): number {
		return Math.max(1, this.lastVisibleHeight - 2);
	}
}

class TouchBarComponent implements Component {
	constructor(private readonly tui: TUI) {}

	render(width: number): string[] {
		const theme = getTheme();
		const debugState = state.viewport?.getDebugState();

		// Compute each button's pixel-width (label + 2 border chars)
		const buttonWidths = BUTTONS.map((b) => visibleWidth(b.label) + 2);
		const totalButtonsWidth = buttonWidths.reduce((a, w) => a + w, 0) + BUTTON_GAP * (BUTTONS.length - 1);

		// Build lines: top borders, labels, bottom borders
		const tops: string[] = [];
		const mids: string[] = [];
		const bots: string[] = [];

		const newButtons: BarButtonBounds[] = [];
		let col = BAR_LEADING + 1; // 1-indexed

		for (let i = 0; i < BUTTONS.length; i++) {
			const button = BUTTONS[i]!;
			const bw = buttonWidths[i]!;
			const inner = bw - 2;
			const borderColor = button.action === "model" ? "warning" : "accent";

			tops.push(theme.fg(borderColor, `╭${"─".repeat(inner)}╮`));
			mids.push(theme.fg(borderColor, "│") + theme.bold(button.label) + theme.fg(borderColor, "│"));
			bots.push(theme.fg(borderColor, `╰${"─".repeat(inner)}╯`));

			newButtons.push({ action: button.action, colStart: col, colEnd: col + bw - 1 });
			col += bw + BUTTON_GAP;

			if (i < BUTTONS.length - 1) {
				tops.push(" ".repeat(BUTTON_GAP));
				mids.push(" ".repeat(BUTTON_GAP));
				bots.push(" ".repeat(BUTTON_GAP));
			}
		}

		// Scroll indicator appended after buttons
		const indicator = debugState
			? " " + (debugState.followBottom ? theme.fg("dim", "BOT") : theme.fg("accent", `${debugState.percent}%`))
			: "";

		const lead = " ".repeat(BAR_LEADING);
		const topLine = truncateToWidth(lead + tops.join(""), width);
		const midLine = truncateToWidth(lead + mids.join("") + indicator, width);
		const botLine = truncateToWidth(lead + bots.join(""), width);

		// Update bar position + button column map for click detection
		const footerChild = this.tui.children[this.tui.children.length - 1];
		const footerHeight = footerChild ? footerChild.render(width).length : 3;
		state.barRow = this.tui.terminal.rows - footerHeight - BAR_HEIGHT + 1; // 1-indexed
		state.barButtons = newButtons;

		return [topLine, midLine, botLine];
	}

	invalidate(): void {}
}

function getBarButtonBounds(): BarButtonBounds[] {
	return state.barButtons;
}

// ============================================================================
// Top (ETC) overlay component
// ============================================================================

class TopOverlayComponent implements Component {
	constructor(private readonly tui: TUI) {}

	render(width: number): string[] {
		const theme = getTheme();
		const buttonWidths = TOP_BUTTONS.map((b) => visibleWidth(b.label) + 2);
		const tops: string[] = [];
		const mids: string[] = [];
		const bots: string[] = [];
		const newButtons: UtilButtonBounds[] = [];
		let col = BAR_LEADING + 1; // 1-indexed

		for (let i = 0; i < TOP_BUTTONS.length; i++) {
			const button = TOP_BUTTONS[i]!;
			const bw = buttonWidths[i]!;
			const inner = bw - 2;

			tops.push(theme.fg("warning", `\u256d${"\u2500".repeat(inner)}\u256e`));
			mids.push(theme.fg("warning", "\u2502") + theme.bold(button.label) + theme.fg("warning", "\u2502"));
			bots.push(theme.fg("warning", `\u2570${"\u2500".repeat(inner)}\u256f`));

			newButtons.push({ command: button.command, colStart: col, colEnd: col + bw - 1 });
			col += bw + BUTTON_GAP;

			if (i < TOP_BUTTONS.length - 1) {
				tops.push(" ".repeat(BUTTON_GAP));
				mids.push(" ".repeat(BUTTON_GAP));
				bots.push(" ".repeat(BUTTON_GAP));
			}
		}

		state.topOverlayButtons = newButtons;
		const lead = " ".repeat(BAR_LEADING);
		return [
			truncateToWidth(lead + tops.join(""), width),
			truncateToWidth(lead + mids.join(""), width),
			truncateToWidth(lead + bots.join(""), width),
		];
	}

	invalidate(): void {}
}

// ============================================================================
// Persistence
// ============================================================================

async function loadPersisted(): Promise<boolean> {
	try {
		const content = await fs.readFile(PERSIST_PATH, "utf8");
		return JSON.parse(content).enabled === true;
	} catch {
		return false;
	}
}

function savePersisted(enabled: boolean): Promise<void> {
	return fs.mkdir(path.dirname(PERSIST_PATH), { recursive: true })
		.then(() => fs.writeFile(PERSIST_PATH, JSON.stringify({ enabled }), "utf8"))
		.catch(() => undefined);
}

function parseMouseInput(data: string): MouseInput | undefined {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return undefined;
	return {
		raw: data,
		code: Number.parseInt(match[1]!, 10),
		col: Number.parseInt(match[2]!, 10),
		row: Number.parseInt(match[3]!, 10),
		phase: match[4] === "M" ? "press" : "release",
	};
}

function isPrimaryPointerPress(mouse: MouseInput): boolean {
	if (mouse.phase !== "press") return false;
	if ((mouse.code & 64) !== 0) return false; // wheel/extra
	return (mouse.code & 0b11) === 0;
}

function visualizeInput(data: string): string {
	return JSON.stringify(
		data.replace(/\x1b/g, "<ESC>").replace(/[\x00-\x1f\x7f]/g, (char) => {
			if (char === "\n") return "<LF>";
			if (char === "\r") return "<CR>";
			if (char === "\t") return "<TAB>";
			const code = char.charCodeAt(0).toString(16).padStart(2, "0");
			return `<0x${code}>`;
		}),
	);
}

function queueLog(message: string): void {
	state.logQueue = state.logQueue
		.catch(() => undefined)
		.then(async () => {
			await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
			await fs.appendFile(LOG_PATH, `${new Date().toISOString()} ${message}\n`, "utf8");
		})
		.catch(() => undefined);
}

function installViewport(): void {
	if (!state.tui) return;
	const current = state.tui.children[CHAT_CHILD_INDEX];
	if (!current) return;
	if (current instanceof TouchViewport) {
		state.viewport = current;
		return;
	}
	state.originalChat = current;
	state.viewport = new TouchViewport(state.tui, current);
	state.tui.children[CHAT_CHILD_INDEX] = state.viewport;
	state.viewport.toBottom();
	state.tui.requestRender(true);
	queueLog("viewport installed");
}

function uninstallViewport(): void {
	if (!state.tui || !state.originalChat) return;
	if (state.tui.children[CHAT_CHILD_INDEX] === state.viewport) {
		state.tui.children[CHAT_CHILD_INDEX] = state.originalChat;
		state.tui.requestRender(true);
		queueLog("viewport uninstalled");
	}
	state.viewport = undefined;
	state.originalChat = undefined;
}

function showPanel(): void {
	if (!state.setWidget) return;
	state.setWidget(BAR_WIDGET_KEY, (tui: TUI, theme: Theme) => {
		state.theme = theme;
		return new TouchBarComponent(tui);
	}, { placement: "belowEditor" });
	queueLog("bar shown");
}

function hidePanel(): void {
	state.setWidget?.(BAR_WIDGET_KEY, undefined, { placement: "belowEditor" });
	state.barRow = 0;
	state.barButtons = [];
	queueLog("bar hidden");
}

function destroyPanel(): void {
	state.setWidget?.(BAR_WIDGET_KEY, undefined, { placement: "belowEditor" });
	state.barRow = 0;
	state.barButtons = [];
	queueLog("bar destroyed");
}

function showTopOverlay(): void {
	if (!state.tui || state.topOverlay) return;
	state.topOverlay = state.tui.showOverlay(new TopOverlayComponent(state.tui), {
		anchor: "top-left",
		row: 0,
		col: 0,
		width: "100%",
		nonCapturing: true,
	});
	state.etcOverlayVisible = true;
	queueLog("top overlay shown");
}

function hideTopOverlay(): void {
	state.topOverlay?.hide();
	state.topOverlay = undefined;
	state.etcOverlayVisible = false;
	queueLog("top overlay hidden");
}

function toggleTopOverlay(): void {
	if (state.etcOverlayVisible) {
		hideTopOverlay();
	} else {
		showTopOverlay();
	}
}

function enableMouseTracking(): void {
	state.tui?.terminal.write(ENABLE_MOUSE);
	queueLog("mouse tracking enabled");
}

function disableMouseTracking(): void {
	state.tui?.terminal.write(DISABLE_MOUSE);
	queueLog("mouse tracking disabled");
}

function clearCapturedTui(): void {
	state.tui = undefined;
	state.theme = undefined;
	state.setWidget = undefined;
}

function captureTui(ctx: ExtensionCommandContext): boolean {
	if (state.tui) return true;
	ctx.ui.setWidget(
		BOOTSTRAP_WIDGET_KEY,
		(tui, theme) => {
			state.tui = tui;
			state.theme = theme;
			return EMPTY_COMPONENT;
		},
		{ placement: "belowEditor" },
	);
	ctx.ui.setWidget(BOOTSTRAP_WIDGET_KEY, undefined);
	return !!state.tui;
}

function touchStatusText(): string {
	const theme = getTheme();
	return theme.fg("accent", "touch") + theme.fg("dim", " mode");
}

function registerInputHandler(ctx: ExtensionCommandContext): void {
	state.inputUnsubscribe?.();
	state.inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
		state.lastInput = visualizeInput(data);

		const mouse = parseMouseInput(data);
		if (mouse) {
			state.lastMouse = mouse;
			queueLog(`mouse ${mouse.phase} code=${mouse.code} row=${mouse.row} col=${mouse.col}`);
			if (!state.enabled || !isPrimaryPointerPress(mouse)) return { consume: true };
			// Top overlay (ETC panel) — rows 1–3 from top of screen
			if (state.etcOverlayVisible && mouse.row >= 1 && mouse.row <= BAR_HEIGHT) {
				for (const btn of state.topOverlayButtons) {
					if (mouse.col >= btn.colStart && mouse.col <= btn.colEnd) {
						state.lastAction = `etc:${btn.command}`;
						queueLog(`etc action: ${btn.command}`);
						hideTopOverlay();
						state.setEditorText?.(btn.command);
						return { data: "\r" };
					}
				}
				return { consume: true };
			}
			// Bottom bar buttons
			const inBar = state.barRow > 0 &&
				mouse.row >= state.barRow &&
				mouse.row < state.barRow + BAR_HEIGHT;
			if (!inBar) return { consume: true };
			for (const bounds of getBarButtonBounds()) {
				const inside = mouse.col >= bounds.colStart && mouse.col <= bounds.colEnd;
				if (!inside) continue;
				state.lastAction = bounds.action;
				queueLog(`action ${bounds.action}`);
				switch (bounds.action) {
					case "top":
						state.viewport?.toTop();
						return { consume: true };
					case "pageUp":
						state.viewport?.pageUp();
						return { consume: true };
					case "model":
						return { data: MODEL_CYCLE_INPUT };
					case "pageDown":
						state.viewport?.pageDown();
						return { consume: true };
					case "bottom":
						state.viewport?.toBottom();
						return { consume: true };
					case "etc":
						toggleTopOverlay();
						return { consume: true };
				}
			}
			return { consume: true };
		}

		if (!state.enabled) return undefined;
		if (matchesKey(data, Key.pageUp)) {
			state.lastAction = "pageUp(keyboard)";
			state.viewport?.pageUp();
			queueLog("keyboard pageUp");
			return { consume: true };
		}
		if (matchesKey(data, Key.pageDown)) {
			state.lastAction = "pageDown(keyboard)";
			state.viewport?.pageDown();
			queueLog("keyboard pageDown");
			return { consume: true };
		}
		if (matchesKey(data, Key.home)) {
			state.lastAction = "top(keyboard)";
			state.viewport?.toTop();
			queueLog("keyboard home");
			return { consume: true };
		}
		if (matchesKey(data, Key.end)) {
			state.lastAction = "bottom(keyboard)";
			state.viewport?.toBottom();
			queueLog("keyboard end");
			return { consume: true };
		}

		return undefined;
	});
}

function unregisterInputHandler(): void {
	state.inputUnsubscribe?.();
	state.inputUnsubscribe = undefined;
}

function disableTouchMode(ctx?: ExtensionCommandContext, permanent = false, persist = true): void {
	if (!state.enabled && !permanent) return;
	state.enabled = false;
	disableMouseTracking();
	unregisterInputHandler();
	hideTopOverlay();
	hidePanel();
	uninstallViewport();
	state.statusSink?.(STATUS_KEY, undefined);
	if (permanent) {
		destroyPanel();
		clearCapturedTui();
	}
	if (persist) savePersisted(false);
	ctx?.ui.notify("pi-touch disabled", "info");
	queueLog(`touch disabled permanent=${permanent}`);
}

function enableTouchMode(ctx: ExtensionCommandContext, persist = true): void {
	state.statusSink = ctx.ui.setStatus;
	state.notify = ctx.ui.notify;
	state.theme = ctx.ui.theme;
	state.setEditorText = ctx.ui.setEditorText.bind(ctx.ui);
	state.setWidget = ctx.ui.setWidget.bind(ctx.ui);
	if (!captureTui(ctx) || !state.tui) {
		ctx.ui.notify("pi-touch: failed to capture TUI instance", "error");
		queueLog("failed to capture TUI instance");
		return;
	}
	state.enabled = true;
	installViewport();
	showPanel();
	enableMouseTracking();
	registerInputHandler(ctx);
	if (persist) savePersisted(true);
	ctx.ui.setStatus(STATUS_KEY, touchStatusText());
	ctx.ui.notify(`pi-touch enabled • log: ${LOG_PATH}`, "info");
	queueLog("touch enabled");
}

function getStatusReport(): string {
	const viewport = state.viewport?.getDebugState();
	const mouse = state.lastMouse
		? `phase=${state.lastMouse.phase} code=${state.lastMouse.code} row=${state.lastMouse.row} col=${state.lastMouse.col}`
		: "(none)";

	return [
		"# pi-touch status",
		"",
		`- enabled: ${state.enabled}`,
		`- log: ${LOG_PATH}`,
		state.tui ? `- terminal: ${state.tui.terminal.columns} cols × ${state.tui.terminal.rows} rows` : "- terminal: (not captured)",
		state.barRow > 0 ? `- bar: row=${state.barRow} buttons=${state.barButtons.length}` : "- bar: (not rendered)",
		`- last action: ${state.lastAction ?? "(none)"}`,
		`- last input: ${state.lastInput ?? "(none)"}`,
		`- last mouse: ${mouse}`,
		viewport
			? `- viewport: scrollTop=${viewport.scrollTop} visibleHeight=${viewport.visibleHeight} totalLines=${viewport.totalLines} maxTop=${viewport.maxTop} followBottom=${viewport.followBottom} percent=${viewport.percent}`
			: "- viewport: (not installed)",
	].join("\n");
}

async function getLogTail(lines = 80): Promise<string> {
	try {
		const content = await fs.readFile(LOG_PATH, "utf8");
		const tail = content.trimEnd().split(/\r?\n/).slice(-lines);
		return tail.length > 0 ? tail.join("\n") : "(log is empty)";
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "(log file does not exist yet)";
		throw error;
	}
}

function parseCommand(args: string): TouchCommand | undefined {
	const token = args.trim().toLowerCase().split(/\s+/)[0] ?? "";
	if (!token) return "status";
	if (token === "up" || token === "pgup") return "page-up";
	if (token === "down" || token === "pgdn") return "page-down";
	return COMMANDS.find((command) => command === token);
}

export default function piTouchExtension(pi: ExtensionAPI) {
	// Touch mode is always disabled on startup for safety.
	// Use /touch to toggle it on/off manually.

	pi.on("session_shutdown", async () => {
		// persist=false: don't overwrite the saved state on shutdown so it survives to the next session
		disableTouchMode(undefined, true, false);
		state.lastInput = undefined;
		state.lastMouse = undefined;
		state.lastAction = undefined;
		state.statusSink = undefined;
		state.notify = undefined;
		state.theme = undefined;
		state.setWidget = undefined;
	});

	pi.registerCommand("touch", {
		description: "Toggle touch mode on/off",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log("pi-touch requires interactive mode.");
				return;
			}
			state.statusSink = ctx.ui.setStatus;
			state.notify = ctx.ui.notify;
			state.theme = ctx.ui.theme;
			state.setEditorText = ctx.ui.setEditorText.bind(ctx.ui);
			state.setWidget = ctx.ui.setWidget.bind(ctx.ui);
			if (state.enabled) disableTouchMode(ctx);
			else enableTouchMode(ctx);
		},
	});

	pi.registerCommand("pi-touch", {
		description: "Experimental phone-oriented touch mode with fixed chat viewport and touch rail",
		getArgumentCompletions: (prefix: string) => {
			const token = prefix.trim().toLowerCase().split(/\s+/).pop() ?? "";
			const items = [
				{ value: "on", label: "on", description: "Enable touch mode" },
				{ value: "off", label: "off", description: "Disable touch mode" },
				{ value: "toggle", label: "toggle", description: "Toggle touch mode" },
				{ value: "status", label: "status", description: "Show current touch-mode state" },
				{ value: "log", label: "log", description: "Paste recent pi-touch log lines into the editor" },
				{ value: "top", label: "top", description: "Scroll chat viewport to the top" },
				{ value: "bottom", label: "bottom", description: "Scroll chat viewport to the bottom" },
				{ value: "page-up", label: "page-up", description: "Page chat viewport upward" },
				{ value: "page-down", label: "page-down", description: "Page chat viewport downward" },
			];
			if (!token) return items;
			const filtered = items.filter((item) => item.value.startsWith(token));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				console.log("pi-touch requires interactive mode.");
				return;
			}

			state.statusSink = ctx.ui.setStatus;
			state.notify = ctx.ui.notify;
			state.theme = ctx.ui.theme;
			state.setEditorText = ctx.ui.setEditorText.bind(ctx.ui);
			state.setWidget = ctx.ui.setWidget.bind(ctx.ui);
			const command = parseCommand(args);
			if (!command) {
				ctx.ui.notify("Usage: /pi-touch [on|off|toggle|status|log|top|bottom|page-up|page-down]", "warning");
				return;
			}

			switch (command) {
				case "on":
					enableTouchMode(ctx);
					return;
				case "off":
					disableTouchMode(ctx);
					return;
				case "toggle":
					if (state.enabled) disableTouchMode(ctx);
					else enableTouchMode(ctx);
					return;
				case "top":
					state.viewport?.toTop();
					ctx.ui.notify("pi-touch: top", "info");
					queueLog("command top");
					return;
				case "bottom":
					state.viewport?.toBottom();
					ctx.ui.notify("pi-touch: bottom", "info");
					queueLog("command bottom");
					return;
				case "page-up":
					state.viewport?.pageUp();
					ctx.ui.notify("pi-touch: page up", "info");
					queueLog("command page-up");
					return;
				case "page-down":
					state.viewport?.pageDown();
					ctx.ui.notify("pi-touch: page down", "info");
					queueLog("command page-down");
					return;
				case "status":
					ctx.ui.setEditorText(getStatusReport());
					ctx.ui.notify("pi-touch status pasted into editor", "info");
					return;
				case "log": {
					const tail = await getLogTail();
					ctx.ui.setEditorText(`# pi-touch log\n\n${tail}`);
					ctx.ui.notify("pi-touch log pasted into editor", "info");
					return;
				}
			}
		},
	});
}
