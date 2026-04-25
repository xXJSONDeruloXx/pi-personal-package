/**
 * Compiles and caches a Swift native helper binary for macOS GUI events.
 * The binary handles: click, right-click, double-click, hover, click-and-hold,
 * drag, scroll, and capture-context (display/window metadata).
 *
 * Adapted from understudy's native-helper.ts
 */
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HELPER_BINARY_NAME = "pi-compuse-gui-helper";
const HELPER_COMPILE_TIMEOUT_MS = 120_000;

// The full Swift source for the native helper binary
const NATIVE_GUI_HELPER_SOURCE = String.raw`
import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

enum HelperError: Error, CustomStringConvertible {
	case invalidCommand(String)
	case invalidEnv(String)
	case missingEnv(String)
	case applicationNotFound(String)
	case activationFailed(String)
	case eventCreationFailed(String)

	var description: String {
		switch self {
		case .invalidCommand(let value): return "invalidCommand(\(value))"
		case .invalidEnv(let key): return "invalidEnv(\(key))"
		case .missingEnv(let key): return "missingEnv(\(key))"
		case .applicationNotFound(let name): return "applicationNotFound(\(name))"
		case .activationFailed(let name): return "activationFailed(\(name))"
		case .eventCreationFailed(let detail): return "eventCreationFailed(\(detail))"
		}
	}
}

struct Rect: Codable { let x: Double; let y: Double; let width: Double; let height: Double }
struct Point: Codable { let x: Double; let y: Double }
struct DisplayDescriptor: Codable { let index: Int; let bounds: Rect }
struct CaptureContext: Codable {
	let appName: String?
	let display: DisplayDescriptor
	let cursor: Point
	let windowId: Int?
	let windowTitle: String?
	let windowBounds: Rect?
	let windowCount: Int?
	let windowCaptureStrategy: String?
}
struct WindowMatch { let id: Int; let title: String?; let bounds: CGRect; let layer: Int }
struct WindowSelection { let primary: WindowMatch; let captureBounds: CGRect; let windowCount: Int; let captureStrategy: String }

func env(_ key: String) -> String { ProcessInfo.processInfo.environment[key] ?? "" }
func trimmedEnv(_ key: String) -> String? {
	let value = env(key).trimmingCharacters(in: .whitespacesAndNewlines)
	return value.isEmpty ? nil : value
}
func normalizedText(_ value: String?) -> String? {
	guard let value else { return nil }
	let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	return normalized.isEmpty ? nil : normalized
}
func requiredDouble(_ key: String) throws -> Double {
	guard let value = Double(env(key)) else { throw HelperError.invalidEnv(key) }; return value
}
func requiredInt32(_ key: String) throws -> Int32 {
	guard let value = Int32(env(key)) else { throw HelperError.invalidEnv(key) }; return value
}
func requiredInt(_ key: String) throws -> Int {
	guard let value = Int(env(key)) else { throw HelperError.invalidEnv(key) }; return value
}
func optionalInt(_ key: String) -> Int? { let raw = env(key); return raw.isEmpty ? nil : Int(raw) }
func optionalDouble(_ key: String) -> Double? { Double(env(key)) }
func shouldActivateApp() -> Bool { env("UNDERSTUDY_GUI_ACTIVATE_APP") != "0" }

func matchesAppName(_ app: NSRunningApplication, requestedName: String) -> Bool {
	let normalized = requestedName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	if normalized.isEmpty { return false }
	if app.localizedName?.lowercased() == normalized { return true }
	if app.bundleIdentifier?.lowercased() == normalized { return true }
	if app.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == normalized { return true }
	return false
}

func findRunningApplication(named name: String) -> NSRunningApplication? {
	let candidates = NSWorkspace.shared.runningApplications.filter { matchesAppName($0, requestedName: name) && !$0.isTerminated }
	return candidates.first(where: { $0.isActive }) ?? candidates.first
}

func resolveRequestedApplication(named name: String?) -> NSRunningApplication? {
	guard let name else { return NSWorkspace.shared.frontmostApplication }
	return findRunningApplication(named: name) ?? NSWorkspace.shared.frontmostApplication
}

func activateApplication(named name: String?) throws {
	guard let name else { return }
	if let frontmost = NSWorkspace.shared.frontmostApplication, matchesAppName(frontmost, requestedName: name) { return }
	guard let app = findRunningApplication(named: name) else { throw HelperError.applicationNotFound(name) }
	if !app.activate(options: [.activateIgnoringOtherApps]) { throw HelperError.activationFailed(name) }
	usleep(100_000)
}

func rect(_ value: CGRect) -> Rect { Rect(x: value.origin.x.rounded(), y: value.origin.y.rounded(), width: value.size.width.rounded(), height: value.size.height.rounded()) }
func point(_ value: CGPoint) -> Point { Point(x: value.x.rounded(), y: value.y.rounded()) }

func activeDisplays() -> [(index: Int, bounds: CGRect)] {
	var count: UInt32 = 0; CGGetActiveDisplayList(0, nil, &count)
	var displayIDs = Array(repeating: CGDirectDisplayID(0), count: Int(count))
	CGGetActiveDisplayList(count, &displayIDs, &count)
	return Array(displayIDs.prefix(Int(count))).enumerated().map { ($0.offset + 1, CGDisplayBounds($0.element)) }
}

func displayForPoint(_ point: CGPoint, displays: [(index: Int, bounds: CGRect)]) -> (index: Int, bounds: CGRect) {
	for d in displays where d.bounds.contains(point) { return d }
	return displays.first ?? (1, CGDisplayBounds(CGMainDisplayID()))
}

func matchingWindows(ownerName: String?, exactTitle: String?, titleContains: String?) -> [WindowMatch] {
	guard let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
	let normalizedExactTitle = normalizedText(exactTitle)
	let normalizedContainsTitle = normalizedText(titleContains)
	var matches: [WindowMatch] = []
	for info in windowInfo {
		let alpha = info[kCGWindowAlpha as String] as? Double ?? 1
		let layer = info[kCGWindowLayer as String] as? Int ?? 0
		let owner = info[kCGWindowOwnerName as String] as? String ?? ""
		if alpha <= 0.01 { continue }
		if let ownerName, owner != ownerName { continue }
		guard let rawBounds = info[kCGWindowBounds as String] else { continue }
		guard let bounds = CGRect(dictionaryRepresentation: rawBounds as! CFDictionary), bounds.width >= 80, bounds.height >= 80 else { continue }
		let windowId = (info[kCGWindowNumber as String] as? NSNumber)?.intValue
		let title = info[kCGWindowName as String] as? String
		let normalizedTitle = normalizedText(title) ?? ""
		if let normalizedExactTitle, normalizedTitle != normalizedExactTitle { continue }
		if let normalizedContainsTitle, !normalizedTitle.contains(normalizedContainsTitle) { continue }
		matches.append(WindowMatch(id: windowId ?? 0, title: title, bounds: bounds.integral, layer: layer))
	}
	return matches
}

func rankWindows(_ matches: [WindowMatch]) -> [WindowMatch] {
	return matches.sorted { lhs, rhs in
		let lp = lhs.layer == 0 ? 0 : 1; let rp = rhs.layer == 0 ? 0 : 1
		if lp != rp { return lp < rp }
		if lhs.layer != rhs.layer { return lhs.layer < rhs.layer }
		let la = lhs.bounds.width * lhs.bounds.height; let ra = rhs.bounds.width * rhs.bounds.height
		if la != ra { return la > ra }
		let lt = normalizedText(lhs.title) != nil; let rt = normalizedText(rhs.title) != nil
		if lt != rt { return lt && !rt }
		return lhs.id < rhs.id
	}
}

func unionBounds(for matches: [WindowMatch]) -> CGRect? {
	guard let first = matches.first else { return nil }
	return matches.dropFirst().reduce(first.bounds) { $0.union($1.bounds) }.integral
}

func selectedWindow(ownerName: String?, exactTitle: String?, titleContains: String?, index: Int?) -> WindowSelection? {
	let matches = matchingWindows(ownerName: ownerName, exactTitle: exactTitle, titleContains: titleContains)
	guard !matches.isEmpty else { return nil }
	let hasExplicit = normalizedText(exactTitle) != nil || normalizedText(titleContains) != nil || index != nil
	if let index, index > 0, index <= matches.count {
		let w = matches[index - 1]
		return WindowSelection(primary: w, captureBounds: w.bounds.integral, windowCount: 1, captureStrategy: "selected_window")
	}
	let ranked = rankWindows(matches)
	guard let primary = ranked.first else { return nil }
	if hasExplicit { return WindowSelection(primary: primary, captureBounds: primary.bounds.integral, windowCount: 1, captureStrategy: "selected_window") }
	if matches.count == 1 { return WindowSelection(primary: primary, captureBounds: primary.bounds.integral, windowCount: 1, captureStrategy: "main_window") }
	guard let combined = unionBounds(for: matches) else { return nil }
	return WindowSelection(primary: primary, captureBounds: combined, windowCount: matches.count, captureStrategy: "app_union")
}

func handleCaptureContext() throws {
	let requestedApp = trimmedEnv("UNDERSTUDY_GUI_APP")
	let requestedWindowTitle = trimmedEnv("UNDERSTUDY_GUI_WINDOW_TITLE")
	let requestedWindowTitleContains = trimmedEnv("UNDERSTUDY_GUI_WINDOW_TITLE_CONTAINS")
	let requestedWindowIndex = optionalInt("UNDERSTUDY_GUI_WINDOW_INDEX")
	if shouldActivateApp() { try activateApplication(named: requestedApp) }
	let resolvedApp = resolveRequestedApplication(named: requestedApp)
	let targetApp = resolvedApp?.localizedName ?? requestedApp ?? NSWorkspace.shared.frontmostApplication?.localizedName
	let cursorLocation = CGEvent(source: nil)?.location ?? .zero
	let displays = activeDisplays()
	let window = selectedWindow(ownerName: targetApp, exactTitle: requestedWindowTitle, titleContains: requestedWindowTitleContains, index: requestedWindowIndex)
	let anchorPoint = window.map { CGPoint(x: $0.primary.bounds.midX, y: $0.primary.bounds.midY) } ?? cursorLocation
	let display = displayForPoint(anchorPoint, displays: displays)
	let payload = CaptureContext(appName: targetApp, display: DisplayDescriptor(index: display.index, bounds: rect(display.bounds)), cursor: point(cursorLocation), windowId: window?.primary.id, windowTitle: window?.primary.title, windowBounds: window.map { rect($0.captureBounds) }, windowCount: window?.windowCount, windowCaptureStrategy: window?.captureStrategy)
	let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
	FileHandle.standardOutput.write(try encoder.encode(payload))
}

func makeMouseEvent(_ type: CGEventType, point: CGPoint, button: CGMouseButton = .left) throws -> CGEvent {
	guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw HelperError.eventCreationFailed("mouse_\(type.rawValue)") }
	return event
}

func post(_ event: CGEvent) { event.post(tap: .cghidEventTap) }
func moveCursor(to point: CGPoint) throws { post(try makeMouseEvent(.mouseMoved, point: point)); usleep(30_000) }

func modifierFlags() -> CGEventFlags {
	let raw = env("UNDERSTUDY_GUI_MODIFIERS")
	if raw.isEmpty { return [] }
	var flags: CGEventFlags = []
	if raw.contains("command") { flags.insert(.maskCommand) }
	if raw.contains("shift") { flags.insert(.maskShift) }
	if raw.contains("option") { flags.insert(.maskAlternate) }
	if raw.contains("control") { flags.insert(.maskControl) }
	return flags
}
func applyModifiers(_ event: CGEvent) { let flags = modifierFlags(); if flags != [] { event.flags = event.flags.union(flags) } }

func leftDown(at point: CGPoint, clickState: Int64 = 1) throws {
	let e = try makeMouseEvent(.leftMouseDown, point: point); e.setIntegerValueField(.mouseEventClickState, value: clickState); applyModifiers(e); post(e)
}
func leftUp(at point: CGPoint, clickState: Int64 = 1) throws {
	let e = try makeMouseEvent(.leftMouseUp, point: point); e.setIntegerValueField(.mouseEventClickState, value: clickState); applyModifiers(e); post(e)
}
func rightDown(at point: CGPoint, clickState: Int64 = 1) throws {
	let e = try makeMouseEvent(.rightMouseDown, point: point, button: .right); e.setIntegerValueField(.mouseEventClickState, value: clickState); applyModifiers(e); post(e)
}
func rightUp(at point: CGPoint, clickState: Int64 = 1) throws {
	let e = try makeMouseEvent(.rightMouseUp, point: point, button: .right); e.setIntegerValueField(.mouseEventClickState, value: clickState); applyModifiers(e); post(e)
}
func middleDown(at point: CGPoint, clickState: Int64 = 1) throws {
	let e = try makeMouseEvent(.otherMouseDown, point: point, button: .center); e.setIntegerValueField(.mouseEventClickState, value: clickState); applyModifiers(e); post(e)
}
func middleUp(at point: CGPoint, clickState: Int64 = 1) throws {
	let e = try makeMouseEvent(.otherMouseUp, point: point, button: .center); e.setIntegerValueField(.mouseEventClickState, value: clickState); applyModifiers(e); post(e)
}

func drag(from start: CGPoint, to end: CGPoint, steps: Int, durationMs: Int) throws {
	let stepCount = max(1, steps); let sleepMicros = useconds_t(max(10_000, (durationMs * 1_000) / stepCount))
	try moveCursor(to: start); try leftDown(at: start); usleep(50_000)
	for index in 1...stepCount {
		let progress = Double(index) / Double(stepCount)
		let point = CGPoint(x: start.x + ((end.x - start.x) * progress), y: start.y + ((end.y - start.y) * progress))
		post(try makeMouseEvent(.leftMouseDragged, point: point)); usleep(sleepMicros)
	}
	try leftUp(at: end)
}

func handleEvent() throws {
	let requestedApp = trimmedEnv("UNDERSTUDY_GUI_APP")
	if shouldActivateApp() { try activateApplication(named: requestedApp) }
	switch env("UNDERSTUDY_GUI_EVENT_MODE") {
	case "click":
		let p = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		try moveCursor(to: p); try leftDown(at: p); usleep(30_000); try leftUp(at: p); print("cg_click")
	case "right_click":
		let p = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		try moveCursor(to: p); try rightDown(at: p); usleep(30_000); try rightUp(at: p); print("cg_right_click")
	case "double_click":
		let p = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		try moveCursor(to: p)
		for state in [Int64(1), Int64(2)] { try leftDown(at: p, clickState: state); usleep(30_000); try leftUp(at: p, clickState: state); usleep(80_000) }
		print("cg_double_click")
	case "hover":
		let p = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		let settleMs = max(0, optionalInt("UNDERSTUDY_GUI_SETTLE_MS") ?? 200)
		try moveCursor(to: p); if settleMs > 0 { usleep(useconds_t(settleMs * 1_000)) }; print("cg_hover")
	case "click_and_hold":
		let p = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		let holdMs = max(100, optionalInt("UNDERSTUDY_GUI_HOLD_DURATION_MS") ?? 650)
		try moveCursor(to: p); try leftDown(at: p); usleep(useconds_t(holdMs * 1_000)); try leftUp(at: p); print("cg_click_and_hold")
	case "drag":
		let start = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_FROM_X"), y: try requiredDouble("UNDERSTUDY_GUI_FROM_Y"))
		let end = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_TO_X"), y: try requiredDouble("UNDERSTUDY_GUI_TO_Y"))
		try drag(from: start, to: end, steps: try requiredInt("UNDERSTUDY_GUI_STEPS"), durationMs: try requiredInt("UNDERSTUDY_GUI_DURATION_MS")); print("cg_drag")
	case "middle_click":
		let p = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		try moveCursor(to: p); try middleDown(at: p); usleep(30_000); try middleUp(at: p); print("cg_middle_click")
	case "triple_click":
		let p = CGPoint(x: try requiredDouble("UNDERSTUDY_GUI_X"), y: try requiredDouble("UNDERSTUDY_GUI_Y"))
		try moveCursor(to: p)
		for state in [Int64(1), Int64(2), Int64(3)] { try leftDown(at: p, clickState: state); usleep(30_000); try leftUp(at: p, clickState: state); usleep(80_000) }
		print("cg_triple_click")
	case "scroll":
		let vert = try requiredInt32("UNDERSTUDY_GUI_SCROLL_Y"); let horiz = try requiredInt32("UNDERSTUDY_GUI_SCROLL_X")
		guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: vert, wheel2: horiz, wheel3: 0) else { throw HelperError.eventCreationFailed("scroll") }
		if let x = optionalDouble("UNDERSTUDY_GUI_X"), let y = optionalDouble("UNDERSTUDY_GUI_Y") { e.location = CGPoint(x: x, y: y) }
		post(e); print("cg_scroll")
	default: throw HelperError.missingEnv("UNDERSTUDY_GUI_EVENT_MODE")
	}
}

do {
	let command = CommandLine.arguments.dropFirst().first ?? ""
	switch command {
	case "activate": try activateApplication(named: trimmedEnv("UNDERSTUDY_GUI_APP")); print("activated")
	case "capture-context": try handleCaptureContext()
	case "event": try handleEvent()
	case "cursor-position":
		let loc = CGEvent(source: nil)?.location ?? .zero
		let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
		FileHandle.standardOutput.write(try enc.encode(point(loc)))
	default: throw HelperError.invalidCommand(command)
	}
} catch {
	fputs("pi-compuse native GUI helper failed: \(error)\n", stderr)
	exit(1)
}
`;

let helperBinaryPath: string | undefined;
let helperBinaryPromise: Promise<string> | undefined;

export async function resolveNativeGuiHelperBinary(): Promise<string> {
	const overridePath = process.env.PI_COMPUSE_NATIVE_HELPER_PATH?.trim();
	if (overridePath) return overridePath;
	if (helperBinaryPath) return helperBinaryPath;
	if (helperBinaryPromise) return await helperBinaryPromise;

	helperBinaryPromise = (async () => {
		const sourceHash = createHash("sha256")
			.update(NATIVE_GUI_HELPER_SOURCE)
			.digest("hex")
			.slice(0, 16);
		const helperDir = join(tmpdir(), "pi-compuse-gui-helper", sourceHash);
		const sourcePath = join(helperDir, `${HELPER_BINARY_NAME}.swift`);
		const binaryPath = join(helperDir, HELPER_BINARY_NAME);

		try {
			await access(binaryPath);
			helperBinaryPath = binaryPath;
			return binaryPath;
		} catch {
			// Need to compile
		}

		await mkdir(helperDir, { recursive: true });
		await writeFile(sourcePath, NATIVE_GUI_HELPER_SOURCE, "utf-8");
		try {
			await execFileAsync("swiftc", [sourcePath, "-o", binaryPath], {
				timeout: HELPER_COMPILE_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				encoding: "utf-8",
			});
		} catch (error: any) {
			const details = [error.stderr?.trim(), error.stdout?.trim()].filter(Boolean).join(" ");
			throw new Error(
				`Failed to compile pi-compuse macOS GUI helper. Ensure Xcode CLI Tools are installed. ${details}`.trim(),
			);
		}

		helperBinaryPath = binaryPath;
		return binaryPath;
	})();

	try {
		return await helperBinaryPromise;
	} finally {
		helperBinaryPromise = undefined;
	}
}

export { execFileAsync };
