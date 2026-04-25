/**
 * /learn command — record a user demonstration and synthesize a pi skill.
 *
 * Flow:
 *   /learn <skill-name>   → start recording (Swift event recorder + periodic screenshots)
 *   /learn stop           → stop recording, analyze, save SKILL.md
 *   /learn list           → list learned skills
 *   /learn delete <name>  → delete a learned skill
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileAsync } from "./native-helper.js";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Model, Api, ImageContent, TextContent } from "@mariozechner/pi-ai";

// ─── Swift Event Recorder ──────────────────────────────────────────────────
// Records mouse clicks, key presses, drags, scrolls, app switches, etc.
// with rich accessibility context (app name, window title, target element).

const SWIFT_EVENT_RECORDER_SCRIPT = String.raw`
import Foundation
import AppKit
import CoreGraphics
import ApplicationServices

struct RecordedEvent: Codable {
	let type: String
	let timestampMs: Int
	let source: String
	let app: String?
	let windowTitle: String?
	let target: String?
	let detail: String?
	let x: Double?
	let y: Double?
	let keyCode: Int?
	let modifiers: [String]?
	let importance: String?
}

func env(_ key: String) -> String {
	ProcessInfo.processInfo.environment[key] ?? ""
}

let outputPath = env("PI_COMPUSE_EVENTS_PATH")
if outputPath.isEmpty {
	fputs("PI_COMPUSE_EVENTS_PATH is required\n", stderr)
	exit(1)
}

let fileManager = FileManager.default
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

var recordedEvents: [RecordedEvent] = []

func nowMs() -> Int {
	Int((Date().timeIntervalSince1970 * 1000.0).rounded())
}

func currentAppName() -> String? {
	NSWorkspace.shared.frontmostApplication?.localizedName
}

func modifierNames(_ flags: NSEvent.ModifierFlags) -> [String]? {
	var values: [String] = []
	if flags.contains(.command) { values.append("command") }
	if flags.contains(.option) { values.append("option") }
	if flags.contains(.control) { values.append("control") }
	if flags.contains(.shift) { values.append("shift") }
	return values.isEmpty ? nil : values
}

func currentAccessibilityApp() -> AXUIElement? {
	guard let running = NSWorkspace.shared.frontmostApplication else { return nil }
	return AXUIElementCreateApplication(running.processIdentifier)
}

func axAttributeValue(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, attribute, &value)
	return result == .success ? value : nil
}

func axElementAttribute(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
	guard let value = axAttributeValue(element, attribute) else { return nil }
	guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
	return unsafeBitCast(value, to: AXUIElement.self)
}

func axStringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
	if let value = axAttributeValue(element, attribute) as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
		return value.trimmingCharacters(in: .whitespacesAndNewlines)
	}
	if let value = axAttributeValue(element, attribute) as? NSAttributedString {
		let string = value.string.trimmingCharacters(in: .whitespacesAndNewlines)
		return string.isEmpty ? nil : string
	}
	return nil
}

func targetSummary(for element: AXUIElement?) -> String? {
	guard let element else { return nil }
	let candidates = [
		axStringAttribute(element, kAXTitleAttribute as CFString),
		axStringAttribute(element, kAXDescriptionAttribute as CFString),
		axStringAttribute(element, kAXIdentifierAttribute as CFString),
		axStringAttribute(element, kAXRoleDescriptionAttribute as CFString),
		axStringAttribute(element, kAXValueAttribute as CFString),
		axStringAttribute(element, kAXRoleAttribute as CFString),
	].compactMap { $0 }.filter { !$0.isEmpty }
	return candidates.isEmpty ? nil : candidates.prefix(2).joined(separator: " | ")
}

func windowTitle(for element: AXUIElement?) -> String? {
	guard let element else { return nil }
	if let direct = axStringAttribute(element, kAXTitleAttribute as CFString) { return direct }
	if let window = axElementAttribute(element, kAXWindowAttribute as CFString),
	   let title = axStringAttribute(window, kAXTitleAttribute as CFString) { return title }
	return nil
}

func focusedElement() -> AXUIElement? {
	guard let appElement = currentAccessibilityApp() else { return nil }
	return axElementAttribute(appElement, kAXFocusedUIElementAttribute as CFString)
}

func focusedWindowTitle() -> String? {
	guard let appElement = currentAccessibilityApp() else { return nil }
	if let window = axElementAttribute(appElement, kAXFocusedWindowAttribute as CFString),
	   let title = axStringAttribute(window, kAXTitleAttribute as CFString) { return title }
	return nil
}

func elementAtPoint(_ point: CGPoint) -> AXUIElement? {
	let systemWide = AXUIElementCreateSystemWide()
	var element: AXUIElement?
	let result = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &element)
	return result == .success ? element : nil
}

func semanticContext(location: CGPoint? = nil) -> (app: String?, windowTitle: String?, target: String?) {
	let app = currentAppName()
	let element = location.flatMap { elementAtPoint($0) } ?? focusedElement()
	return (
		app: app,
		windowTitle: windowTitle(for: element) ?? focusedWindowTitle(),
		target: targetSummary(for: element)
	)
}

func inferImportance(for type: String) -> String {
	if type.contains("mouse_down") || type.contains("click") || type.contains("drag") || type.contains("key_down") || type.contains("hotkey") || type.contains("app_activated") {
		return "high"
	}
	if type.contains("scroll") || type.contains("mouse_move") { return "medium" }
	return "low"
}

var lastPointerSampleByType: [String: (timestampMs: Int, location: CGPoint)] = [:]

func shortcutText(characters: String?, modifiers: [String]?) -> String? {
	let key = characters?.trimmingCharacters(in: .whitespacesAndNewlines)
	let normalizedModifiers = modifiers ?? []
	guard !normalizedModifiers.isEmpty, let key, !key.isEmpty else { return nil }
	return (normalizedModifiers + [key]).joined(separator: "+")
}

func shouldRecordPointerSample(type: String, location: CGPoint, minIntervalMs: Int, minDistance: Double) -> Bool {
	let now = nowMs()
	if let previous = lastPointerSampleByType[type] {
		let deltaT = now - previous.timestampMs
		let deltaX = location.x - previous.location.x
		let deltaY = location.y - previous.location.y
		let distance = sqrt((deltaX * deltaX) + (deltaY * deltaY))
		if deltaT < minIntervalMs && distance < minDistance { return false }
	}
	lastPointerSampleByType[type] = (timestampMs: now, location: location)
	return true
}

func appendEvent(
	_ type: String, source: String = "input", detail: String? = nil,
	location: CGPoint? = nil, keyCode: Int? = nil, modifiers: [String]? = nil,
	app: String? = nil, windowTitle wt: String? = nil, target t: String? = nil
) {
	let context = semanticContext(location: location)
	recordedEvents.append(RecordedEvent(
		type: type, timestampMs: nowMs(), source: source,
		app: app ?? context.app ?? currentAppName(),
		windowTitle: wt ?? context.windowTitle,
		target: t ?? context.target,
		detail: detail,
		x: location.map { Double($0.x.rounded()) },
		y: location.map { Double($0.y.rounded()) },
		keyCode: keyCode, modifiers: modifiers,
		importance: inferImportance(for: type)
	))
}

func persistAndExit(_ code: Int32 = 0) {
	do {
		let parent = URL(fileURLWithPath: outputPath).deletingLastPathComponent()
		try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
		let data = try encoder.encode(recordedEvents)
		try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
		exit(code)
	} catch {
		fputs("Failed to persist: \(error)\n", stderr)
		exit(1)
	}
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigintSource.setEventHandler { persistAndExit(0) }
sigintSource.resume()

let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigtermSource.setEventHandler { persistAndExit(0) }
sigtermSource.resume()

let eventMask: NSEvent.EventTypeMask = [
	.leftMouseDown, .leftMouseUp, .leftMouseDragged,
	.rightMouseDown, .rightMouseUp,
	.scrollWheel, .keyDown, .flagsChanged,
]

let monitor = NSEvent.addGlobalMonitorForEvents(matching: eventMask) { event in
	switch event.type {
	case .leftMouseDown:
		appendEvent("click", location: event.locationInWindow)
		if event.clickCount >= 2 { appendEvent("double_click", location: event.locationInWindow) }
	case .leftMouseUp:
		break  // We only care about mouse-down for clicks
	case .leftMouseDragged:
		if shouldRecordPointerSample(type: "drag", location: event.locationInWindow, minIntervalMs: 200, minDistance: 20) {
			appendEvent("drag", location: event.locationInWindow)
		}
	case .rightMouseDown:
		appendEvent("right_click", location: event.locationInWindow)
	case .rightMouseUp:
		break
	case .scrollWheel:
		appendEvent("scroll",
			detail: "deltaX=\(event.scrollingDeltaX.rounded()) deltaY=\(event.scrollingDeltaY.rounded())",
			location: event.locationInWindow)
	case .keyDown:
		let modifiers = modifierNames(event.modifierFlags)
		let chars = event.charactersIgnoringModifiers
		appendEvent("key_down", detail: chars, keyCode: Int(event.keyCode), modifiers: modifiers)
		if let shortcut = shortcutText(characters: chars, modifiers: modifiers) {
			appendEvent("hotkey", detail: shortcut, keyCode: Int(event.keyCode), modifiers: modifiers)
		}
	case .flagsChanged:
		break
	default:
		break
	}
}

let workspaceCenter = NSWorkspace.shared.notificationCenter
let activationObserver = workspaceCenter.addObserver(
	forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { notification in
	let app = (notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.localizedName
	appendEvent("app_activated", source: "workspace", app: app,
		windowTitle: focusedWindowTitle(), target: targetSummary(for: focusedElement()))
}

appendEvent("recording_started", source: "system", detail: "Recording started")
RunLoop.main.run()
if let monitor { NSEvent.removeMonitor(monitor) }
workspaceCenter.removeObserver(activationObserver)
persistAndExit(0)
`;

// ─── Types ─────────────────────────────────────────────────────────────────

interface RecordedEvent {
	type: string;
	timestampMs: number;
	source: string;
	app?: string;
	windowTitle?: string;
	target?: string;
	detail?: string;
	x?: number;
	y?: number;
	keyCode?: number;
	modifiers?: string[];
	importance?: string;
}

interface TimestampedScreenshot {
	timestampMs: number;
	filePath: string;
}

interface RecordingSession {
	skillName: string;
	startedAt: number;
	tempDir: string;
	eventLogPath: string;
	screenshotDir: string;
	eventRecorderProcess: ChildProcessByStdio<null, Readable, Readable>;
	screenshotTimer: ReturnType<typeof setInterval>;
	screenshotCount: number;
	screenshots: TimestampedScreenshot[];
}

interface LearnModelResolver {
	resolve(): Promise<{ model: Model<Api>; apiKey: string }>;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const SCREENSHOT_INTERVAL_MS = 4_000;
const MAX_SCREENSHOTS = 60;
const MAX_SCREENSHOTS_FOR_ANALYSIS = 12;
const MAX_SCREENSHOT_DIMENSION = 1280;
const STOP_TIMEOUT_MS = 5_000;
const MAX_EVENTS_FOR_ANALYSIS = 200;

// ─── Screenshot helpers ────────────────────────────────────────────────────

async function captureAndDownsize(outputPath: string): Promise<boolean> {
	try {
		const rawPath = outputPath + ".raw.png";
		await execFileAsync("screencapture", ["-x", "-t", "png", rawPath], {
			timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
		});
		// Downsize to JPEG
		await execFileAsync("sips", [
			"-Z", String(MAX_SCREENSHOT_DIMENSION),
			"-s", "format", "jpeg",
			"-s", "formatOptions", "60",
			rawPath, "--out", outputPath,
		], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
		await rm(rawPath, { force: true }).catch(() => {});
		return true;
	} catch {
		return false;
	}
}

// ─── Event filtering ───────────────────────────────────────────────────────

function filterHighImportanceEvents(events: RecordedEvent[]): RecordedEvent[] {
	// Keep high importance + scroll/drag summaries
	const filtered: RecordedEvent[] = [];
	let lastScrollTime = 0;
	let lastDragTime = 0;

	for (const event of events) {
		if (event.importance === "high" || event.type === "app_activated" || event.type === "recording_started") {
			filtered.push(event);
			continue;
		}
		// Sample scrolls (max 1 per second)
		if (event.type === "scroll" && event.timestampMs - lastScrollTime > 1000) {
			filtered.push(event);
			lastScrollTime = event.timestampMs;
			continue;
		}
		// Sample drags (max 1 per 500ms)
		if (event.type === "drag" && event.timestampMs - lastDragTime > 500) {
			filtered.push(event);
			lastDragTime = event.timestampMs;
		}
	}
	return filtered.slice(-MAX_EVENTS_FOR_ANALYSIS);
}

// ─── Screenshot selection ──────────────────────────────────────────────────

function selectKeyScreenshots(
	screenshots: TimestampedScreenshot[],
	events: RecordedEvent[],
	maxCount: number,
): TimestampedScreenshot[] {
	if (screenshots.length <= maxCount) return screenshots;

	// Score screenshots by proximity to high-importance events
	const highEvents = events.filter(e => e.importance === "high");
	const scored = screenshots.map(ss => {
		let score = 0;
		for (const event of highEvents) {
			const gap = Math.abs(ss.timestampMs - event.timestampMs);
			if (gap < 2000) score += 10;
			else if (gap < 5000) score += 5;
			else if (gap < 10000) score += 1;
		}
		return { ...ss, score };
	});

	// Always include first and last
	const first = scored[0];
	const last = scored[scored.length - 1];
	const middle = scored.slice(1, -1).sort((a, b) => b.score - a.score);

	const selected = [first!, ...middle.slice(0, maxCount - 2), last!];
	return selected.sort((a, b) => a.timestampMs - b.timestampMs);
}

// ─── Skill directory ───────────────────────────────────────────────────────

function getSkillsDir(): string {
	return resolve(process.cwd(), ".pi", "skills");
}

function getSkillDir(name: string): string {
	return join(getSkillsDir(), name);
}

function getSkillPath(name: string): string {
	return join(getSkillDir(name), "SKILL.md");
}

// ─── Analysis prompt ───────────────────────────────────────────────────────

function buildAnalysisPrompt(params: {
	skillName: string;
	events: RecordedEvent[];
	durationMs: number;
	screenshotCount: number;
}): string {
	const eventSummary = params.events.map(e => {
		const parts = [
			`[${formatMs(e.timestampMs)}]`,
			e.type,
			e.app ? `app=${e.app}` : "",
			e.windowTitle ? `window="${e.windowTitle}"` : "",
			e.target ? `target="${e.target}"` : "",
			e.detail ? `detail="${e.detail}"` : "",
			e.x !== undefined ? `pos=(${e.x},${e.y})` : "",
			e.modifiers?.length ? `mods=[${e.modifiers.join(",")}]` : "",
		].filter(Boolean).join(" ");
		return parts;
	}).join("\n");

	return `You are analyzing a GUI demonstration recording to create a reusable skill document.

The user demonstrated a workflow called "${params.skillName}" over ${formatMs(params.durationMs)}.

## Recorded Input Events
${eventSummary}

## Screenshots
${params.screenshotCount} screenshots are attached in chronological order, showing the GUI state at key moments during the demonstration.

## Your Task
Analyze the events and screenshots to produce a structured SKILL.md document. The skill should teach an AI agent how to reproduce this workflow.

Focus on:
1. What the user was trying to accomplish (the goal)
2. The exact sequence of steps (which app, what to click/type/scroll, in what order)
3. Visual landmarks to look for (what the screen should look like at each step)
4. Any parameters that might vary between executions

Return ONLY the markdown content for the SKILL.md file. Use this exact format:

---
name: ${params.skillName}
description: <one-line description of what this workflow does>
---

# ${params.skillName}

## Goal
<What this workflow accomplishes>

## Prerequisites
<What needs to be true before starting — apps open, state, etc.>

## Steps

1. <Step description — be specific about what to click/type/where>
   - App: <app name>
   - Action: <gui_click|gui_type|gui_hotkey|gui_scroll|etc.>
   - Target: <visual description of the element to interact with>
   - Details: <any additional context, what to type, etc.>

2. ...

## Verification
<How to verify the workflow completed successfully — what should the screen look like>

## Notes
<Any edge cases, timing considerations, or variations>

Be precise and specific. Use the exact visual descriptions from the accessibility targets in the events, and reference what's visible in the screenshots. The goal is that another AI agent can follow these steps to reproduce the workflow perfectly.`;
}

function formatMs(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	return `${min}:${String(sec).padStart(2, "0")}`;
}

// ─── Analysis ──────────────────────────────────────────────────────────────

async function analyzeRecording(params: {
	skillName: string;
	events: RecordedEvent[];
	screenshots: TimestampedScreenshot[];
	durationMs: number;
	modelResolver: LearnModelResolver;
}): Promise<string> {
	const { model, apiKey } = await params.modelResolver.resolve();

	// Select key screenshots
	const keyScreenshots = selectKeyScreenshots(
		params.screenshots,
		params.events,
		MAX_SCREENSHOTS_FOR_ANALYSIS,
	);

	// Filter events
	const filteredEvents = filterHighImportanceEvents(params.events);

	// Build message content: screenshots + text prompt
	const content: (ImageContent | TextContent)[] = [];

	// Add screenshots in chronological order
	for (const ss of keyScreenshots) {
		try {
			const bytes = await readFile(ss.filePath);
			content.push({
				type: "image",
				data: bytes.toString("base64"),
				mimeType: "image/jpeg",
			});
		} catch {
			// Skip unreadable screenshots
		}
	}

	// Add the analysis prompt
	content.push({
		type: "text",
		text: buildAnalysisPrompt({
			skillName: params.skillName,
			events: filteredEvents,
			durationMs: params.durationMs,
			screenshotCount: keyScreenshots.length,
		}),
	});

	const response = await completeSimple(model, {
		messages: [{
			role: "user",
			content,
			timestamp: Date.now(),
		}],
	}, { apiKey });

	const textParts = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text);
	const responseText = textParts.join("\n").trim();

	if (!responseText) {
		throw new Error("LLM returned empty analysis.");
	}

	// Extract just the markdown (strip any wrapping code fences)
	const fenced = responseText.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/);
	return fenced ? fenced[1]!.trim() : responseText;
}

// ─── Session management ────────────────────────────────────────────────────

let activeSession: RecordingSession | undefined;

export function isRecording(): boolean {
	return activeSession !== undefined;
}

export function getActiveSkillName(): string | undefined {
	return activeSession?.skillName;
}

export async function startRecording(skillName: string): Promise<string> {
	if (activeSession) {
		throw new Error(`Already recording skill "${activeSession.skillName}". Run /learn stop first.`);
	}

	// Validate skill name
	const normalized = skillName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (!normalized) {
		throw new Error("Invalid skill name. Use lowercase letters, numbers, and hyphens.");
	}

	// Create temp directory
	const tempDir = join(tmpdir(), `pi-compuse-learn-${normalized}-${Date.now()}`);
	await mkdir(tempDir, { recursive: true });
	const eventLogPath = join(tempDir, "events.json");
	const screenshotDir = join(tempDir, "screenshots");
	await mkdir(screenshotDir, { recursive: true });

	// Start Swift event recorder
	const eventProcess = spawn("swift", ["-e", SWIFT_EVENT_RECORDER_SCRIPT], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_COMPUSE_EVENTS_PATH: eventLogPath,
		},
	}) as ChildProcessByStdio<null, Readable, Readable>;

	// Collect stderr for debugging
	let stderrOutput = "";
	eventProcess.stderr.setEncoding("utf8");
	eventProcess.stderr.on("data", (chunk: string) => { stderrOutput += chunk; });

	// Wait a moment for Swift to compile and start
	await new Promise(r => setTimeout(r, 2000));

	// Check it didn't crash immediately
	if (eventProcess.exitCode !== null) {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		throw new Error(`Event recorder failed to start: ${stderrOutput}`);
	}

	const startedAt = Date.now();

	// Start periodic screenshots
	let screenshotCount = 0;
	const screenshots: TimestampedScreenshot[] = [];

	// Take an initial screenshot
	const initialPath = join(screenshotDir, `ss-${String(screenshotCount).padStart(4, "0")}.jpg`);
	if (await captureAndDownsize(initialPath)) {
		screenshots.push({ timestampMs: startedAt, filePath: initialPath });
		screenshotCount++;
	}

	const screenshotTimer = setInterval(async () => {
		if (screenshotCount >= MAX_SCREENSHOTS) return;
		const ssPath = join(screenshotDir, `ss-${String(screenshotCount).padStart(4, "0")}.jpg`);
		if (await captureAndDownsize(ssPath)) {
			screenshots.push({ timestampMs: Date.now(), filePath: ssPath });
			screenshotCount++;
		}
	}, SCREENSHOT_INTERVAL_MS);

	activeSession = {
		skillName: normalized,
		startedAt,
		tempDir,
		eventLogPath,
		screenshotDir,
		eventRecorderProcess: eventProcess,
		screenshotTimer,
		screenshotCount,
		screenshots,
	};

	return normalized;
}

export async function stopRecording(modelResolver: LearnModelResolver): Promise<{
	skillName: string;
	skillPath: string;
	eventCount: number;
	screenshotCount: number;
	durationMs: number;
}> {
	if (!activeSession) {
		throw new Error("No active recording. Start one with /learn <skill-name>.");
	}

	const session = activeSession;
	activeSession = undefined;

	// Stop screenshot timer
	clearInterval(session.screenshotTimer);

	// Take a final screenshot
	const finalPath = join(session.screenshotDir, `ss-${String(session.screenshots.length).padStart(4, "0")}.jpg`);
	if (await captureAndDownsize(finalPath)) {
		session.screenshots.push({ timestampMs: Date.now(), filePath: finalPath });
	}

	// Stop event recorder (SIGINT triggers persist + exit)
	const durationMs = Date.now() - session.startedAt;

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			try { session.eventRecorderProcess.kill("SIGKILL"); } catch {}
			resolve();
		}, STOP_TIMEOUT_MS);

		session.eventRecorderProcess.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});

		session.eventRecorderProcess.kill("SIGINT");
	});

	// Wait for event log to be written
	await new Promise(r => setTimeout(r, 500));

	// Load events
	let events: RecordedEvent[] = [];
	try {
		const raw = await readFile(session.eventLogPath, "utf8");
		events = JSON.parse(raw);
	} catch {
		// Event recorder may have failed — continue with screenshots only
	}

	// Normalize event timestamps relative to recording start
	const baseTimestamp = events.length > 0
		? Math.min(...events.map(e => e.timestampMs))
		: session.startedAt;
	const normalizedEvents = events.map(e => ({
		...e,
		timestampMs: e.timestampMs - baseTimestamp,
	}));

	const normalizedScreenshots = session.screenshots.map(ss => ({
		...ss,
		timestampMs: ss.timestampMs - session.startedAt,
	}));

	// Analyze the recording
	const skillContent = await analyzeRecording({
		skillName: session.skillName,
		events: normalizedEvents,
		screenshots: normalizedScreenshots,
		durationMs,
		modelResolver,
	});

	// Save the skill
	const skillDir = getSkillDir(session.skillName);
	await mkdir(skillDir, { recursive: true });
	const skillPath = getSkillPath(session.skillName);
	await writeFile(skillPath, skillContent, "utf8");

	// Cleanup temp files
	await rm(session.tempDir, { recursive: true, force: true }).catch(() => {});

	return {
		skillName: session.skillName,
		skillPath,
		eventCount: events.length,
		screenshotCount: session.screenshots.length,
		durationMs,
	};
}

export async function listSkills(): Promise<Array<{ name: string; description: string; path: string }>> {
	const skillsDir = getSkillsDir();
	try {
		await stat(skillsDir);
	} catch {
		return [];
	}

	const entries = await readdir(skillsDir);
	const skills: Array<{ name: string; description: string; path: string }> = [];

	for (const entry of entries) {
		const skillPath = join(skillsDir, entry, "SKILL.md");
		try {
			const content = await readFile(skillPath, "utf8");
			const descMatch = content.match(/^description:\s*(.+)$/m);
			skills.push({
				name: entry,
				description: descMatch?.[1]?.trim() ?? "(no description)",
				path: skillPath,
			});
		} catch {
			// Not a valid skill directory
		}
	}

	return skills;
}

export async function deleteSkill(name: string): Promise<boolean> {
	const skillDir = getSkillDir(name);
	try {
		await stat(skillDir);
		await rm(skillDir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}
