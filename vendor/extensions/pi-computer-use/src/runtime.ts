/**
 * Core GUI runtime for macOS.
 * Handles screenshot capture, coordinate grounding, and native input dispatch.
 *
 * Design: screenshots are only taken when the agent explicitly requests them
 * (gui_read/gui_screenshot) or when a target needs grounding. Actions like
 * gui_keypress and gui_hotkey never take screenshots. The agent is responsible
 * for planning its own observation cadence.
 */
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNativeGuiHelperBinary, execFileAsync } from "./native-helper.js";
import type { GroundingProvider, GroundingResult, GroundingPoint } from "./grounding.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SCROLL_AMOUNT = 5;
const DEFAULT_DRAG_STEPS = 18;
const DEFAULT_DRAG_DURATION_MS = 450;
const DEFAULT_HOVER_SETTLE_MS = 200;
const DEFAULT_CLICK_AND_HOLD_MS = 650;
const MAX_IMAGE_DIMENSION = 1920;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

// ─── Types ─────────────────────────────────────────────────────────────────

interface Rect { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }

interface CaptureContext {
	appName?: string;
	display: { index: number; bounds: Rect };
	cursor: Point;
	windowId?: number;
	windowTitle?: string;
	windowBounds?: Rect;
	windowCount?: number;
	windowCaptureStrategy?: string;
}

interface ScreenshotArtifact {
	bytes: Buffer;
	filePath: string;
	mimeType: string;
	captureRect: Rect;
	scaleX: number;
	scaleY: number;
	imageWidth?: number;
	imageHeight?: number;
	appName?: string;
	windowTitle?: string;
	cleanup: () => Promise<void>;
}

export interface GuiActionResult {
	text: string;
	image?: { data: string; mimeType: string };
	details?: Record<string, unknown>;
}

// ─── AppleScript for type/hotkey ───────────────────────────────────────────

const COMMON_KEY_CODES: Record<string, number> = {
	enter: 36, return: 36, tab: 48, escape: 53, esc: 53,
	delete: 51, backspace: 51, up: 126, down: 125, left: 123, right: 124, space: 49,
};

const TYPE_SCRIPT = String.raw`
set requestedApp to system attribute "UNDERSTUDY_GUI_APP"
set inputText to system attribute "UNDERSTUDY_GUI_TEXT"
set replaceText to system attribute "UNDERSTUDY_GUI_REPLACE"
set submitText to system attribute "UNDERSTUDY_GUI_SUBMIT"
on pasteText(rawText)
	set previousClipboard to missing value
	set hadClipboard to false
	try
		set previousClipboard to the clipboard
		set hadClipboard to true
	end try
	set the clipboard to rawText
	delay 0.15
	tell application "System Events"
		keystroke "v" using command down
	end tell
	delay 0.25
	if hadClipboard then
		try
			set the clipboard to previousClipboard
		end try
	end if
end pasteText
tell application "System Events"
	if requestedApp is not "" then
		if not (exists application process requestedApp) then error "Application process not found: " & requestedApp
		set targetProc to application process requestedApp
		set frontmost of targetProc to true
		delay 0.1
	else
		set targetProc to first application process whose frontmost is true
	end if
	if replaceText is "1" then keystroke "a" using command down
	my pasteText(inputText)
	if submitText is "1" then key code 36
	return "paste"
end tell
`;

const HOTKEY_SCRIPT = String.raw`
on buildModifierList(rawText)
	set modifierList to {}
	if rawText contains "command" then copy command down to end of modifierList
	if rawText contains "shift" then copy shift down to end of modifierList
	if rawText contains "option" then copy option down to end of modifierList
	if rawText contains "control" then copy control down to end of modifierList
	return modifierList
end buildModifierList
set requestedApp to system attribute "UNDERSTUDY_GUI_APP"
set keyText to system attribute "UNDERSTUDY_GUI_KEY"
set keyCodeText to system attribute "UNDERSTUDY_GUI_KEY_CODE"
set modifiersText to system attribute "UNDERSTUDY_GUI_MODIFIERS"
set repeatText to system attribute "UNDERSTUDY_GUI_REPEAT"
set modifierList to my buildModifierList(modifiersText)
set repeatCount to 1
if repeatText is not "" then
	set repeatCandidate to repeatText as integer
	if repeatCandidate > 0 then set repeatCount to repeatCandidate
end if
tell application "System Events"
	if requestedApp is not "" then
		if not (exists application process requestedApp) then error "Application process not found: " & requestedApp
		set targetProc to application process requestedApp
		set frontmost of targetProc to true
		delay 0.1
	end if
	if keyCodeText is not "" then
		repeat repeatCount times
			if (count of modifierList) is 0 then key code (keyCodeText as integer) else key code (keyCodeText as integer) using modifierList
			delay 0.03
		end repeat
		return "key_code"
	end if
	repeat repeatCount times
		if (count of modifierList) is 0 then keystroke keyText else keystroke keyText using modifierList
		delay 0.03
	end repeat
	return "keystroke"
end tell
`;

// ─── Helper functions ──────────────────────────────────────────────────────

function parsePngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
	if (bytes.length < 24) return undefined;
	if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return undefined;
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Downsize a screenshot to fit within size/dimension limits using macOS sips. */
async function downsizeImage(filePath: string, bytes: Buffer, dims: { width: number; height: number } | undefined): Promise<{ bytes: Buffer; mimeType: string; width?: number; height?: number }> {
	const w = dims?.width ?? 0;
	const h = dims?.height ?? 0;
	const needsResize = w > MAX_IMAGE_DIMENSION || h > MAX_IMAGE_DIMENSION;
	const needsCompress = bytes.length > MAX_IMAGE_BYTES;

	if (!needsResize && !needsCompress) {
		return { bytes, mimeType: "image/png", width: dims?.width, height: dims?.height };
	}

	try {
		const dir = filePath.substring(0, filePath.lastIndexOf("/"));
		const jpegPath = join(dir, "screenshot-small.jpg");
		const args: string[] = [];
		if (needsResize) {
			const scale = MAX_IMAGE_DIMENSION / Math.max(w, h);
			args.push("-z", String(Math.round(h * scale)), String(Math.round(w * scale)));
		}
		args.push("-s", "format", "jpeg", "-s", "formatOptions", "70", filePath, "--out", jpegPath);
		await execFileAsync("sips", args, { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
		const jpegBytes = Buffer.from(await readFile(jpegPath));
		const newDims = needsResize
			? { width: Math.round(w * (MAX_IMAGE_DIMENSION / Math.max(w, h))), height: Math.round(h * (MAX_IMAGE_DIMENSION / Math.max(w, h))) }
			: dims;
		return { bytes: jpegBytes, mimeType: "image/jpeg", width: newDims?.width, height: newDims?.height };
	} catch {
		return { bytes, mimeType: "image/png", width: dims?.width, height: dims?.height };
	}
}

async function runAppleScript(script: string, env: Record<string, string | undefined>): Promise<string> {
	try {
		const result = await execFileAsync("osascript", ["-l", "AppleScript", "-e", script], {
			env: { ...process.env, ...env },
			timeout: DEFAULT_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
			encoding: "utf-8",
		});
		return result.stdout.trim();
	} catch (error: any) {
		const details = [error.stderr?.trim(), error.stdout?.trim()].filter(Boolean).join(" ");
		throw new Error(`macOS GUI scripting failed. ${error.message} ${details}`.trim());
	}
}

async function runNativeHelper(command: string, env: Record<string, string | undefined>, errorLabel: string): Promise<string> {
	const binaryPath = await resolveNativeGuiHelperBinary();
	try {
		const result = await execFileAsync(binaryPath, [command], {
			env: { ...process.env, ...env },
			timeout: DEFAULT_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
			encoding: "utf-8",
		});
		return result.stdout.trim();
	} catch (error: any) {
		const details = [error.stderr?.trim(), error.stdout?.trim()].filter(Boolean).join(" ");
		throw new Error(`${errorLabel}. ${error.message} ${details}`.trim());
	}
}

// ─── Runtime class ─────────────────────────────────────────────────────────

export class GuiRuntime {
	constructor(private groundingProvider?: GroundingProvider) {}

	setGroundingProvider(provider: GroundingProvider | undefined) {
		this.groundingProvider = provider;
	}

	// ─── Screenshot (internal, only when needed) ───────────────────────────

	private async captureScreenshot(params: {
		appName?: string;
		captureMode?: "window" | "display";
		windowTitle?: string;
		windowTitleContains?: string;
		windowIndex?: number;
	} = {}): Promise<ScreenshotArtifact> {
		const contextRaw = await runNativeHelper("capture-context", {
			UNDERSTUDY_GUI_APP: params.appName?.trim(),
			UNDERSTUDY_GUI_ACTIVATE_APP: "1",
			UNDERSTUDY_GUI_WINDOW_TITLE: params.windowTitle,
			UNDERSTUDY_GUI_WINDOW_TITLE_CONTAINS: params.windowTitleContains,
			UNDERSTUDY_GUI_WINDOW_INDEX: params.windowIndex ? String(params.windowIndex) : undefined,
		}, "GUI capture context failed");

		const ctx: CaptureContext = JSON.parse(contextRaw);
		const useWindow = params.captureMode !== "display" && ctx.windowBounds;
		const captureRect: Rect = useWindow
			? { x: Math.round(ctx.windowBounds!.x), y: Math.round(ctx.windowBounds!.y), width: Math.max(1, Math.round(ctx.windowBounds!.width)), height: Math.max(1, Math.round(ctx.windowBounds!.height)) }
			: ctx.display.bounds;

		const screencaptureArgs = useWindow
			? ["-x", "-R", `${captureRect.x},${captureRect.y},${captureRect.width},${captureRect.height}`, "-t", "png"]
			: ["-x", `-D${ctx.display.index}`, "-t", "png"];

		const tempDir = await mkdtemp(join(tmpdir(), "pi-compuse-screenshot-"));
		const filePath = join(tempDir, "screenshot.png");

		try {
			await execFileAsync("screencapture", [...screencaptureArgs, filePath], {
				timeout: DEFAULT_TIMEOUT_MS,
				maxBuffer: 8 * 1024 * 1024,
			});
			const bytes = Buffer.from(await readFile(filePath));
			const dims = parsePngDimensions(bytes);
			const scaleX = dims && captureRect.width > 0 ? dims.width / captureRect.width : 1;
			const scaleY = dims && captureRect.height > 0 ? dims.height / captureRect.height : 1;

			return {
				bytes, filePath, mimeType: "image/png",
				captureRect, scaleX, scaleY,
				imageWidth: dims?.width, imageHeight: dims?.height,
				appName: params.appName, windowTitle: ctx.windowTitle,
				cleanup: async () => { await rm(tempDir, { recursive: true, force: true }).catch(() => {}); },
			};
		} catch (error: any) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
			throw new Error(`Screenshot capture failed. Ensure Screen Recording permissions. ${error.message}`);
		}
	}

	// ─── Grounding (screenshot → coordinates) ──────────────────────────────

	private async groundTarget(artifact: ScreenshotArtifact, target: string, params: {
		scope?: string; app?: string; action?: string;
		groundingMode?: "single" | "complex"; locationHint?: string;
	} = {}): Promise<{ point: Point; result: GroundingResult } | undefined> {
		if (!this.groundingProvider) throw new Error("No grounding provider configured.");
		if (!target?.trim()) return undefined;

		const result = await this.groundingProvider.ground({
			imageBytes: artifact.bytes,
			imageMimeType: artifact.mimeType,
			imageWidth: artifact.imageWidth,
			imageHeight: artifact.imageHeight,
			target: target.trim(),
			scope: params.scope,
			app: params.app,
			action: params.action,
			groundingMode: params.groundingMode,
			locationHint: params.locationHint,
			captureMode: artifact.captureRect.width === artifact.imageWidth ? "display" : "window",
		});

		if (!result) return undefined;

		const displayPoint: Point = {
			x: artifact.captureRect.x + (result.point.x / artifact.scaleX),
			y: artifact.captureRect.y + (result.point.y / artifact.scaleY),
		};

		return { point: displayPoint, result };
	}

	/** Internal: capture, ground a target, return the display-space point. */
	private async captureAndGround(params: {
		app?: string; target: string; scope?: string; captureMode?: "window" | "display";
		groundingMode?: "single" | "complex"; locationHint?: string; action: string;
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
	}): Promise<Point> {
		const artifact = await this.captureScreenshot({
			appName: params.app, captureMode: params.captureMode,
			windowTitle: params.windowSelector?.title ?? params.windowTitle,
			windowTitleContains: params.windowSelector?.titleContains,
			windowIndex: params.windowSelector?.index,
		});
		try {
			const grounded = await this.groundTarget(artifact, params.target, {
				scope: params.scope, app: params.app, action: params.action,
				groundingMode: params.groundingMode, locationHint: params.locationHint,
			});
			if (!grounded) throw new Error(`Target "${params.target}" not found on screen.`);
			return grounded.point;
		} finally {
			await artifact.cleanup();
		}
	}

	// ─── Native input dispatch ─────────────────────────────────────────────

	private modifiersEnv(modifiers?: string[]): string {
		return modifiers?.map(m => m.trim().toLowerCase()).filter(Boolean).join(",") ?? "";
	}

	private async nativeClick(appName: string | undefined, point: Point, modifiers?: string[]): Promise<void> {
		await runNativeHelper("event", {
			UNDERSTUDY_GUI_APP: appName?.trim(), UNDERSTUDY_GUI_ACTIVATE_APP: "1",
			UNDERSTUDY_GUI_EVENT_MODE: "click",
			UNDERSTUDY_GUI_X: String(point.x), UNDERSTUDY_GUI_Y: String(point.y),
			UNDERSTUDY_GUI_MODIFIERS: this.modifiersEnv(modifiers),
		}, "GUI click failed");
	}

	private async nativeRightClick(appName: string | undefined, point: Point, modifiers?: string[]): Promise<void> {
		await runNativeHelper("event", {
			UNDERSTUDY_GUI_APP: appName?.trim(), UNDERSTUDY_GUI_ACTIVATE_APP: "1",
			UNDERSTUDY_GUI_EVENT_MODE: "right_click",
			UNDERSTUDY_GUI_X: String(point.x), UNDERSTUDY_GUI_Y: String(point.y),
			UNDERSTUDY_GUI_MODIFIERS: this.modifiersEnv(modifiers),
		}, "GUI right-click failed");
	}

	private async nativeMiddleClick(appName: string | undefined, point: Point, modifiers?: string[]): Promise<void> {
		await runNativeHelper("event", {
			UNDERSTUDY_GUI_APP: appName?.trim(), UNDERSTUDY_GUI_ACTIVATE_APP: "1",
			UNDERSTUDY_GUI_EVENT_MODE: "middle_click",
			UNDERSTUDY_GUI_X: String(point.x), UNDERSTUDY_GUI_Y: String(point.y),
			UNDERSTUDY_GUI_MODIFIERS: this.modifiersEnv(modifiers),
		}, "GUI middle-click failed");
	}

	private async nativeDoubleClick(appName: string | undefined, point: Point, modifiers?: string[]): Promise<void> {
		await runNativeHelper("event", {
			UNDERSTUDY_GUI_APP: appName?.trim(), UNDERSTUDY_GUI_ACTIVATE_APP: "1",
			UNDERSTUDY_GUI_EVENT_MODE: "double_click",
			UNDERSTUDY_GUI_X: String(point.x), UNDERSTUDY_GUI_Y: String(point.y),
			UNDERSTUDY_GUI_MODIFIERS: this.modifiersEnv(modifiers),
		}, "GUI double-click failed");
	}

	private async nativeTripleClick(appName: string | undefined, point: Point, modifiers?: string[]): Promise<void> {
		await runNativeHelper("event", {
			UNDERSTUDY_GUI_APP: appName?.trim(), UNDERSTUDY_GUI_ACTIVATE_APP: "1",
			UNDERSTUDY_GUI_EVENT_MODE: "triple_click",
			UNDERSTUDY_GUI_X: String(point.x), UNDERSTUDY_GUI_Y: String(point.y),
			UNDERSTUDY_GUI_MODIFIERS: this.modifiersEnv(modifiers),
		}, "GUI triple-click failed");
	}

	private async nativeHover(appName: string | undefined, point: Point, settleMs: number): Promise<void> {
		await runNativeHelper("event", {
			UNDERSTUDY_GUI_APP: appName?.trim(), UNDERSTUDY_GUI_ACTIVATE_APP: "1",
			UNDERSTUDY_GUI_EVENT_MODE: "hover",
			UNDERSTUDY_GUI_X: String(point.x), UNDERSTUDY_GUI_Y: String(point.y),
			UNDERSTUDY_GUI_SETTLE_MS: String(settleMs),
		}, "GUI hover failed");
	}

	private async nativeClickAndHold(appName: string | undefined, point: Point, holdMs: number): Promise<void> {
		await runNativeHelper("event", {
			UNDERSTUDY_GUI_APP: appName?.trim(), UNDERSTUDY_GUI_ACTIVATE_APP: "1",
			UNDERSTUDY_GUI_EVENT_MODE: "click_and_hold",
			UNDERSTUDY_GUI_X: String(point.x), UNDERSTUDY_GUI_Y: String(point.y),
			UNDERSTUDY_GUI_HOLD_DURATION_MS: String(holdMs),
		}, "GUI click-and-hold failed");
	}

	private async nativeDrag(appName: string | undefined, from: Point, to: Point, durationMs: number, modifiers?: string[]): Promise<void> {
		await runNativeHelper("event", {
			UNDERSTUDY_GUI_APP: appName?.trim(), UNDERSTUDY_GUI_ACTIVATE_APP: "1",
			UNDERSTUDY_GUI_EVENT_MODE: "drag",
			UNDERSTUDY_GUI_FROM_X: String(from.x), UNDERSTUDY_GUI_FROM_Y: String(from.y),
			UNDERSTUDY_GUI_TO_X: String(to.x), UNDERSTUDY_GUI_TO_Y: String(to.y),
			UNDERSTUDY_GUI_DURATION_MS: String(durationMs),
			UNDERSTUDY_GUI_STEPS: String(DEFAULT_DRAG_STEPS),
			UNDERSTUDY_GUI_MODIFIERS: this.modifiersEnv(modifiers),
		}, "GUI drag failed");
	}

	private async nativeScroll(appName: string | undefined, point: Point | undefined, direction: string, amount: number): Promise<void> {
		const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
		const deltaY = direction === "up" ? amount : direction === "down" ? -amount : 0;
		await runNativeHelper("event", {
			UNDERSTUDY_GUI_APP: appName?.trim(), UNDERSTUDY_GUI_ACTIVATE_APP: "1",
			UNDERSTUDY_GUI_EVENT_MODE: "scroll",
			UNDERSTUDY_GUI_X: point ? String(point.x) : undefined,
			UNDERSTUDY_GUI_Y: point ? String(point.y) : undefined,
			UNDERSTUDY_GUI_SCROLL_X: String(deltaX), UNDERSTUDY_GUI_SCROLL_Y: String(deltaY),
		}, "GUI scroll failed");
	}

	private async nativeCursorPosition(): Promise<Point> {
		const raw = await runNativeHelper("cursor-position", {}, "GUI cursor-position failed");
		return JSON.parse(raw) as Point;
	}

	// ─── Public tool methods ───────────────────────────────────────────────

	/** gui_read / gui_screenshot: capture and return a downsized image. */
	async performRead(params: {
		app?: string; target?: string; scope?: string; captureMode?: "window" | "display";
		groundingMode?: "single" | "complex"; locationHint?: string;
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
	}): Promise<GuiActionResult> {
		const captureMode = params.captureMode ?? (!params.app && !params.target?.trim() ? "display" : undefined);
		const artifact = await this.captureScreenshot({
			appName: params.app, captureMode,
			windowTitle: params.windowSelector?.title ?? params.windowTitle,
			windowTitleContains: params.windowSelector?.titleContains,
			windowIndex: params.windowSelector?.index,
		});
		try {
			const downsized = await downsizeImage(artifact.filePath, artifact.bytes, artifact.imageWidth && artifact.imageHeight ? { width: artifact.imageWidth, height: artifact.imageHeight } : undefined);
			const image = { data: downsized.bytes.toString("base64"), mimeType: downsized.mimeType };

			if (!params.target?.trim()) {
				return { text: "Captured GUI screenshot.", image };
			}
			if (!this.groundingProvider) {
				return { text: "Captured GUI screenshot (no grounding configured).", image };
			}
			const grounded = await this.groundTarget(artifact, params.target!, {
				scope: params.scope, app: params.app, action: "read",
				groundingMode: params.groundingMode, locationHint: params.locationHint,
			});
			if (!grounded) {
				return { text: `Target "${params.target}" not found in screenshot.`, image };
			}
			return {
				text: `Found "${params.target}" at (${Math.round(grounded.point.x)}, ${Math.round(grounded.point.y)}). Confidence: ${grounded.result.confidence}.`,
				image,
			};
		} finally { await artifact.cleanup(); }
	}

	/** gui_click: ground target → click (left, right, or middle). No screenshot returned. */
	async performClick(params: {
		app?: string; target: string; scope?: string; captureMode?: "window" | "display";
		groundingMode?: "single" | "complex"; locationHint?: string;
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
		button?: "left" | "right" | "middle"; modifiers?: string[];
	}): Promise<GuiActionResult> {
		const btn = params.button ?? "left";
		const actionMap = { left: "click", right: "right_click", middle: "middle_click" } as const;
		const point = await this.captureAndGround({ ...params, action: actionMap[btn] });
		const mods = params.modifiers;
		const modPrefix = mods?.length ? `${mods.join("+")}+` : "";
		if (btn === "right") {
			await this.nativeRightClick(params.app, point, mods);
			return { text: `${modPrefix}Right-clicked "${params.target}".` };
		}
		if (btn === "middle") {
			await this.nativeMiddleClick(params.app, point, mods);
			return { text: `${modPrefix}Middle-clicked "${params.target}".` };
		}
		await this.nativeClick(params.app, point, mods);
		return { text: `${modPrefix}Clicked "${params.target}".` };
	}

	/** gui_right_click: ground target → right-click. */
	async performRightClick(params: {
		app?: string; target: string; scope?: string; captureMode?: "window" | "display";
		groundingMode?: "single" | "complex"; locationHint?: string;
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
		modifiers?: string[];
	}): Promise<GuiActionResult> {
		const point = await this.captureAndGround({ ...params, action: "right_click" });
		await this.nativeRightClick(params.app, point, params.modifiers);
		return { text: `Right-clicked "${params.target}".` };
	}

	/** gui_double_click: ground target → double-click. */
	async performDoubleClick(params: {
		app?: string; target: string; scope?: string; captureMode?: "window" | "display";
		groundingMode?: "single" | "complex"; locationHint?: string;
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
		modifiers?: string[];
	}): Promise<GuiActionResult> {
		const point = await this.captureAndGround({ ...params, action: "double_click" });
		await this.nativeDoubleClick(params.app, point, params.modifiers);
		return { text: `Double-clicked "${params.target}".` };
	}

	/** gui_triple_click: ground target → triple-click. Selects entire line/paragraph. */
	async performTripleClick(params: {
		app?: string; target: string; scope?: string; captureMode?: "window" | "display";
		groundingMode?: "single" | "complex"; locationHint?: string;
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
		modifiers?: string[];
	}): Promise<GuiActionResult> {
		const point = await this.captureAndGround({ ...params, action: "triple_click" });
		await this.nativeTripleClick(params.app, point, params.modifiers);
		return { text: `Triple-clicked "${params.target}".` };
	}

	/** gui_hover: ground target → hover. */
	async performHover(params: {
		app?: string; target: string; scope?: string; captureMode?: "window" | "display";
		groundingMode?: "single" | "complex"; locationHint?: string;
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
		settleMs?: number;
	}): Promise<GuiActionResult> {
		const point = await this.captureAndGround({ ...params, action: "hover" });
		await this.nativeHover(params.app, point, params.settleMs ?? DEFAULT_HOVER_SETTLE_MS);
		return { text: `Hovered "${params.target}".` };
	}

	/** gui_click_and_hold: ground target → click and hold. */
	async performClickAndHold(params: {
		app?: string; target: string; scope?: string; captureMode?: "window" | "display";
		groundingMode?: "single" | "complex"; locationHint?: string;
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
		holdDurationMs?: number;
	}): Promise<GuiActionResult> {
		const point = await this.captureAndGround({ ...params, action: "click_and_hold" });
		await this.nativeClickAndHold(params.app, point, params.holdDurationMs ?? DEFAULT_CLICK_AND_HOLD_MS);
		return { text: `Click-and-held "${params.target}".` };
	}

	/** gui_drag: ground both endpoints → drag. */
	async performDrag(params: {
		app?: string; fromTarget: string; toTarget: string;
		scope?: string; fromScope?: string; toScope?: string;
		captureMode?: "window" | "display";
		groundingMode?: "single" | "complex";
		fromLocationHint?: string; toLocationHint?: string;
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
		durationMs?: number; modifiers?: string[];
	}): Promise<GuiActionResult> {
		// Single screenshot, ground both targets on it
		const artifact = await this.captureScreenshot({
			appName: params.app, captureMode: params.captureMode,
			windowTitle: params.windowSelector?.title ?? params.windowTitle,
			windowTitleContains: params.windowSelector?.titleContains,
			windowIndex: params.windowSelector?.index,
		});
		let fromPoint: Point, toPoint: Point;
		try {
			const from = await this.groundTarget(artifact, params.fromTarget, {
				scope: params.fromScope ?? params.scope, app: params.app, action: "drag_source",
				groundingMode: params.groundingMode, locationHint: params.fromLocationHint,
			});
			if (!from) throw new Error(`Drag source "${params.fromTarget}" not found.`);
			fromPoint = from.point;

			const to = await this.groundTarget(artifact, params.toTarget, {
				scope: params.toScope ?? params.scope, app: params.app, action: "drag_destination",
				groundingMode: params.groundingMode, locationHint: params.toLocationHint,
			});
			if (!to) throw new Error(`Drag destination "${params.toTarget}" not found.`);
			toPoint = to.point;
		} finally { await artifact.cleanup(); }

		await this.nativeDrag(params.app, fromPoint, toPoint, params.durationMs ?? DEFAULT_DRAG_DURATION_MS, params.modifiers);
		return { text: `Dragged "${params.fromTarget}" → "${params.toTarget}".` };
	}

	/** gui_scroll: optionally ground a scroll target, then scroll. */
	async performScroll(params: {
		app?: string; target?: string; scope?: string; captureMode?: "window" | "display";
		groundingMode?: "single" | "complex"; locationHint?: string;
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
		direction?: "up" | "down" | "left" | "right"; amount?: number;
	}): Promise<GuiActionResult> {
		const direction = params.direction ?? "down";
		const amount = Math.max(1, Math.min(50, params.amount ?? DEFAULT_SCROLL_AMOUNT));
		let scrollPoint: Point | undefined;

		if (params.target?.trim() && this.groundingProvider) {
			try {
				scrollPoint = await this.captureAndGround({ ...params, target: params.target!, action: "scroll" });
			} catch { /* scroll at cursor if target not found */ }
		}

		await this.nativeScroll(params.app, scrollPoint, direction, amount);
		return { text: `Scrolled ${direction} by ${amount}.` };
	}

	/** gui_type: optionally ground a target field (click it), then type. */
	async performType(params: {
		app?: string; target?: string; scope?: string; captureMode?: "window" | "display";
		groundingMode?: "single" | "complex"; locationHint?: string;
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
		value: string; replace?: boolean; submit?: boolean;
	}): Promise<GuiActionResult> {
		if (params.target?.trim() && this.groundingProvider) {
			const point = await this.captureAndGround({ ...params, target: params.target!, action: "type" });
			await this.nativeClick(params.app, point);
			await new Promise(r => setTimeout(r, 200));
		}

		await runAppleScript(TYPE_SCRIPT, {
			UNDERSTUDY_GUI_APP: params.app?.trim() ?? "",
			UNDERSTUDY_GUI_TEXT: params.value,
			UNDERSTUDY_GUI_REPLACE: params.replace === false ? "0" : "1",
			UNDERSTUDY_GUI_SUBMIT: params.submit ? "1" : "0",
		});

		return { text: `Typed "${params.value.slice(0, 80)}${params.value.length > 80 ? "..." : ""}".` };
	}

	/** gui_keypress: press a key. No screenshot needed. */
	async performKeypress(params: {
		app?: string; key: string; modifiers?: string[]; repeat?: number;
	}): Promise<GuiActionResult> {
		const normalizedKey = params.key.trim().toLowerCase();
		const keyCode = COMMON_KEY_CODES[normalizedKey];
		await runAppleScript(HOTKEY_SCRIPT, {
			UNDERSTUDY_GUI_APP: params.app?.trim() ?? "",
			UNDERSTUDY_GUI_KEY: keyCode ? "" : params.key,
			UNDERSTUDY_GUI_KEY_CODE: keyCode ? String(keyCode) : "",
			UNDERSTUDY_GUI_MODIFIERS: (params.modifiers ?? []).map(m => m.trim().toLowerCase()).filter(Boolean).join(","),
			UNDERSTUDY_GUI_REPEAT: String(Math.max(1, params.repeat ?? 1)),
		});
		return { text: `Pressed ${params.key}.` };
	}

	/** gui_hotkey: send a keyboard shortcut. No screenshot needed. */
	async performHotkey(params: {
		app?: string; key: string; modifiers?: string[]; repeat?: number;
	}): Promise<GuiActionResult> {
		const normalizedKey = params.key.trim().toLowerCase();
		const keyCode = COMMON_KEY_CODES[normalizedKey];
		await runAppleScript(HOTKEY_SCRIPT, {
			UNDERSTUDY_GUI_APP: params.app?.trim() ?? "",
			UNDERSTUDY_GUI_KEY: keyCode ? "" : params.key,
			UNDERSTUDY_GUI_KEY_CODE: keyCode ? String(keyCode) : "",
			UNDERSTUDY_GUI_MODIFIERS: (params.modifiers ?? ["command"]).map(m => m.trim().toLowerCase()).filter(Boolean).join(","),
			UNDERSTUDY_GUI_REPEAT: String(Math.max(1, params.repeat ?? 1)),
		});
		const combo = [...(params.modifiers ?? ["command"]), params.key].join("+");
		return { text: `Sent hotkey ${combo}.` };
	}

	/** gui_screenshot: just capture and return the image. */
	async performScreenshot(params: {
		app?: string; captureMode?: "window" | "display";
		windowTitle?: string; windowSelector?: { title?: string; titleContains?: string; index?: number };
	}): Promise<GuiActionResult> {
		const artifact = await this.captureScreenshot({
			appName: params.app, captureMode: params.captureMode,
			windowTitle: params.windowSelector?.title ?? params.windowTitle,
			windowTitleContains: params.windowSelector?.titleContains,
			windowIndex: params.windowSelector?.index,
		});
		try {
			const downsized = await downsizeImage(artifact.filePath, artifact.bytes, artifact.imageWidth && artifact.imageHeight ? { width: artifact.imageWidth, height: artifact.imageHeight } : undefined);
			return {
				text: "Screenshot captured.",
				image: { data: downsized.bytes.toString("base64"), mimeType: downsized.mimeType },
			};
		} finally { await artifact.cleanup(); }
	}

	// ─── New Phase 1+2 tools ───────────────────────────────────────────────

	/** gui_cursor_position: get current cursor coordinates. */
	async performCursorPosition(): Promise<GuiActionResult> {
		const pos = await this.nativeCursorPosition();
		return { text: `Cursor at (${Math.round(pos.x)}, ${Math.round(pos.y)}).`, details: { x: pos.x, y: pos.y } };
	}

	/** gui_clipboard_read: read text from the system clipboard. */
	async performClipboardRead(): Promise<GuiActionResult> {
		const text = await runAppleScript('return (the clipboard as text)', {});
		return { text: text || "(clipboard is empty)" };
	}

	/** gui_clipboard_write: write text to the system clipboard. */
	async performClipboardWrite(params: { text: string }): Promise<GuiActionResult> {
		await runAppleScript(
			'set the clipboard to (system attribute "PI_COMPUSE_CLIPBOARD_TEXT")',
			{ PI_COMPUSE_CLIPBOARD_TEXT: params.text },
		);
		return { text: `Wrote ${params.text.length} characters to clipboard.` };
	}

	/** gui_wait: pause for a specified duration. */
	async performWait(params: { ms: number }): Promise<GuiActionResult> {
		const ms = Math.max(0, Math.min(30_000, params.ms));
		await new Promise(r => setTimeout(r, ms));
		return { text: `Waited ${ms}ms.` };
	}

	/** gui_batch: execute a sequence of GUI actions in one tool call. */
	async performBatch(params: {
		actions: Array<Record<string, unknown>>;
	}): Promise<GuiActionResult> {
		const results: string[] = [];
		for (let i = 0; i < params.actions.length; i++) {
			const step = params.actions[i]!;
			const action = step.action as string;
			try {
				const result = await this.dispatchBatchAction(action, step);
				results.push(`${i + 1}. ${result.text}`);
			} catch (error: any) {
				results.push(`${i + 1}. ERROR (${action}): ${error.message}`);
				break; // Stop on first error
			}
		}
		return { text: results.join("\n") };
	}

	/** Dispatch a single batch action. */
	private async dispatchBatchAction(action: string, step: Record<string, unknown>): Promise<GuiActionResult> {
		const s = (key: string) => step[key] as string | undefined;
		const n = (key: string) => step[key] as number | undefined;
		const b = (key: string) => step[key] as boolean | undefined;
		const a = (key: string) => step[key] as string[] | undefined;

		switch (action) {
			case "click":
				return this.performClick({
					app: s("app"), target: s("target") ?? "", scope: s("scope"),
					button: s("button") as "left" | "right" | "middle" | undefined,
					modifiers: a("modifiers"),
					captureMode: s("captureMode") as "window" | "display" | undefined,
					groundingMode: s("groundingMode") as "single" | "complex" | undefined,
					locationHint: s("locationHint"), windowTitle: s("windowTitle"),
				});
			case "right_click":
				return this.performRightClick({
					app: s("app"), target: s("target") ?? "", scope: s("scope"),
					modifiers: a("modifiers"),
					captureMode: s("captureMode") as "window" | "display" | undefined,
					groundingMode: s("groundingMode") as "single" | "complex" | undefined,
					locationHint: s("locationHint"), windowTitle: s("windowTitle"),
				});
			case "double_click":
				return this.performDoubleClick({
					app: s("app"), target: s("target") ?? "", scope: s("scope"),
					modifiers: a("modifiers"),
					captureMode: s("captureMode") as "window" | "display" | undefined,
					groundingMode: s("groundingMode") as "single" | "complex" | undefined,
					locationHint: s("locationHint"), windowTitle: s("windowTitle"),
				});
			case "triple_click":
				return this.performTripleClick({
					app: s("app"), target: s("target") ?? "", scope: s("scope"),
					modifiers: a("modifiers"),
					captureMode: s("captureMode") as "window" | "display" | undefined,
					groundingMode: s("groundingMode") as "single" | "complex" | undefined,
					locationHint: s("locationHint"), windowTitle: s("windowTitle"),
				});
			case "hover":
				return this.performHover({
					app: s("app"), target: s("target") ?? "", scope: s("scope"),
					settleMs: n("settleMs"),
					captureMode: s("captureMode") as "window" | "display" | undefined,
					groundingMode: s("groundingMode") as "single" | "complex" | undefined,
					locationHint: s("locationHint"), windowTitle: s("windowTitle"),
				});
			case "drag":
				return this.performDrag({
					app: s("app"), fromTarget: s("fromTarget") ?? "", toTarget: s("toTarget") ?? "",
					scope: s("scope"), fromScope: s("fromScope"), toScope: s("toScope"),
					modifiers: a("modifiers"), durationMs: n("durationMs"),
					captureMode: s("captureMode") as "window" | "display" | undefined,
					groundingMode: s("groundingMode") as "single" | "complex" | undefined,
					windowTitle: s("windowTitle"),
				});
			case "type":
				return this.performType({
					app: s("app"), target: s("target"), scope: s("scope"),
					value: s("value") ?? s("text") ?? "",
					replace: b("replace"), submit: b("submit"),
					captureMode: s("captureMode") as "window" | "display" | undefined,
					groundingMode: s("groundingMode") as "single" | "complex" | undefined,
					locationHint: s("locationHint"), windowTitle: s("windowTitle"),
				});
			case "keypress":
				return this.performKeypress({
					app: s("app"), key: s("key") ?? "",
					modifiers: a("modifiers"), repeat: n("repeat"),
				});
			case "hotkey":
				return this.performHotkey({
					app: s("app"), key: s("key") ?? "",
					modifiers: a("modifiers"), repeat: n("repeat"),
				});
			case "scroll":
				return this.performScroll({
					app: s("app"), target: s("target"), scope: s("scope"),
					direction: s("direction") as "up" | "down" | "left" | "right" | undefined,
					amount: n("amount"),
					captureMode: s("captureMode") as "window" | "display" | undefined,
					groundingMode: s("groundingMode") as "single" | "complex" | undefined,
					locationHint: s("locationHint"), windowTitle: s("windowTitle"),
				});
			case "wait":
				return this.performWait({ ms: n("ms") ?? 500 });
			case "clipboard_read":
				return this.performClipboardRead();
			case "clipboard_write":
				return this.performClipboardWrite({ text: s("text") ?? "" });
			default:
				return { text: `Unknown action: ${action}` };
		}
	}
}
