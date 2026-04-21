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

type TouchAction = "top" | "pageUp" | "model" | "pageDown" | "bottom";

type MouseInput = {
	raw: string;
	code: number;
	col: number;
	row: number;
	phase: "press" | "release";
};

type PanelBounds = {
	row: number;
	col: number;
	width: number;
	height: number;
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
const PANEL_WIDTH = 12;
const BUTTON_HEIGHT = 3;
const BUTTON_GAP = 1;
const RIGHT_MARGIN = 1;
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
];

const state: {
	enabled: boolean;
	theme?: Theme;
	tui?: TUI;
	viewport?: TouchViewport;
	originalChat?: Component;
	panel?: TouchPanel;
	overlay?: OverlayHandle;
	inputUnsubscribe?: () => void;
	logQueue: Promise<void>;
	lastInput?: string;
	lastMouse?: MouseInput;
	lastAction?: string;
	lastBounds?: PanelBounds;
	statusSink?: (key: string, text: string | undefined) => void;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
} = {
	enabled: false,
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

class TouchPanel implements Component {
	render(width: number): string[] {
		const theme = getTheme();
		const w = Math.max(7, width);
		const innerWidth = Math.max(1, w - 2);
		const lines: string[] = [];
		const debugState = state.viewport?.getDebugState();

		for (const [index, button] of BUTTONS.entries()) {
			const borderColor = button.action === "model" ? "warning" : "accent";
			lines.push(theme.fg(borderColor, `╭${"─".repeat(innerWidth)}╮`));
			lines.push(
				theme.fg(borderColor, "│") +
				center(theme.bold(button.label), innerWidth) +
				theme.fg(borderColor, "│"),
			);
			lines.push(theme.fg(borderColor, `╰${"─".repeat(innerWidth)}╯`));
			if (index !== BUTTONS.length - 1) lines.push("");
		}

		if (debugState) {
			const summary = debugState.followBottom ? "BOT" : `${debugState.percent}%`;
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", center(summary, w)), w));
		}

		return lines.map((line) => truncateToWidth(line, w, "", true));
	}

	invalidate(): void {}
}

function center(text: string, width: number): string {
	const len = visibleWidth(text);
	if (len >= width) return truncateToWidth(text, width, "", true);
	const left = Math.floor((width - len) / 2);
	const right = Math.max(0, width - len - left);
	return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

function getPanelHeight(): number {
	const debugLines = state.viewport ? 2 : 0;
	return BUTTONS.length * BUTTON_HEIGHT + (BUTTONS.length - 1) * BUTTON_GAP + debugLines;
}

function getPanelBounds(tui: TUI): PanelBounds {
	const width = Math.max(1, Math.min(PANEL_WIDTH, Math.max(1, tui.terminal.columns - RIGHT_MARGIN)));
	const height = Math.max(1, Math.min(getPanelHeight(), tui.terminal.rows));
	const col = Math.max(0, tui.terminal.columns - RIGHT_MARGIN - width);
	const row = Math.max(0, Math.floor((tui.terminal.rows - height) / 2));
	return { row, col, width, height };
}

function getButtonBounds(tui: TUI) {
	const panel = getPanelBounds(tui);
	state.lastBounds = panel;
	let topOffset = 0;
	return BUTTONS.map((button) => {
		const bounds = {
			action: button.action,
			left: panel.col + 1,
			right: panel.col + panel.width,
			top: panel.row + topOffset + 1,
			bottom: panel.row + topOffset + BUTTON_HEIGHT,
		};
		topOffset += BUTTON_HEIGHT + BUTTON_GAP;
		return bounds;
	});
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
	if (!state.tui) return;
	if (!state.panel) state.panel = new TouchPanel();
	if (!state.overlay) {
		state.overlay = state.tui.showOverlay(state.panel, {
			width: PANEL_WIDTH,
			anchor: "right-center",
			margin: { right: RIGHT_MARGIN },
			nonCapturing: true,
		});
		queueLog("overlay shown");
		return;
	}
	state.overlay.setHidden(false);
	state.tui.requestRender();
	queueLog("overlay revealed");
}

function hidePanel(): void {
	state.overlay?.setHidden(true);
	state.tui?.requestRender();
	queueLog("overlay hidden");
}

function destroyPanel(): void {
	state.overlay?.hide();
	state.overlay = undefined;
	state.panel = undefined;
	state.tui?.requestRender();
	queueLog("overlay destroyed");
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
	state.lastBounds = undefined;
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
			if (!state.enabled || !state.tui || !isPrimaryPointerPress(mouse)) return { consume: true };
			for (const bounds of getButtonBounds(state.tui)) {
				const inside =
					mouse.col >= bounds.left &&
					mouse.col <= bounds.right &&
					mouse.row >= bounds.top &&
					mouse.row <= bounds.bottom;
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

function disableTouchMode(ctx?: ExtensionCommandContext, permanent = false): void {
	if (!state.enabled && !permanent) return;
	state.enabled = false;
	disableMouseTracking();
	unregisterInputHandler();
	hidePanel();
	uninstallViewport();
	state.statusSink?.(STATUS_KEY, undefined);
	if (permanent) {
		destroyPanel();
		clearCapturedTui();
	}
	ctx?.ui.notify("pi-touch disabled", "info");
	queueLog(`touch disabled permanent=${permanent}`);
}

function enableTouchMode(ctx: ExtensionCommandContext): void {
	state.statusSink = ctx.ui.setStatus;
	state.notify = ctx.ui.notify;
	state.theme = ctx.ui.theme;
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
	ctx.ui.setStatus(STATUS_KEY, touchStatusText());
	ctx.ui.notify(`pi-touch enabled • log: ${LOG_PATH}`, "info");
	queueLog("touch enabled");
}

function getStatusReport(): string {
	const viewport = state.viewport?.getDebugState();
	const mouse = state.lastMouse
		? `phase=${state.lastMouse.phase} code=${state.lastMouse.code} row=${state.lastMouse.row} col=${state.lastMouse.col}`
		: "(none)";
	const bounds = state.tui ? getPanelBounds(state.tui) : state.lastBounds;

	return [
		"# pi-touch status",
		"",
		`- enabled: ${state.enabled}`,
		`- log: ${LOG_PATH}`,
		state.tui ? `- terminal: ${state.tui.terminal.columns} cols × ${state.tui.terminal.rows} rows` : "- terminal: (not captured)",
		bounds ? `- panel: row=${bounds.row} col=${bounds.col} width=${bounds.width} height=${bounds.height}` : "- panel: (not rendered)",
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
	pi.on("session_shutdown", async () => {
		disableTouchMode(undefined, true);
		state.lastInput = undefined;
		state.lastMouse = undefined;
		state.lastAction = undefined;
		state.statusSink = undefined;
		state.notify = undefined;
		state.theme = undefined;
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
