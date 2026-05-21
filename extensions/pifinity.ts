/**
 * pifinity: Infinite auto-continue extension for pi.
 *
 * Keeps the agent looping by sending a follow-up message after each agent_end.
 * Only stops on /pifinity off. Esc pauses it until you send your next message.
 * Steer freely -- pifinity skips one cycle so it doesn't bury your input.
 *
 * Commands:
 *   /pifinity [on|off]       - toggle or explicitly set
 *   /pifinity-msg [text]     - set the continue message (default: "continue")
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const WIDGET_KEY = "pifinity";
const ENTRY_TYPE = "pifinity-state";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pifinity-config.json");

// -- State -------------------------------------------------------------------

let enabled = false;
let paused = false;
let message = "continue";
let turnCount = 0;
let skipNext = false;
let latestCtx: ExtensionContext | undefined;
let continueRetryTimer: ReturnType<typeof setTimeout> | undefined;
let watchdogTimer: ReturnType<typeof setInterval> | undefined;

// -- Persistence -------------------------------------------------------------

type PersistedState = {
	enabled: boolean;
	message: string;
	turnCount: number;
};

function persistState(ctx: ExtensionContext) {
	pi.appendEntry(ENTRY_TYPE, { enabled, message, turnCount } satisfies PersistedState);
}

let pi: ExtensionAPI;

// -- Cross-session config file persistence --------------------------------

type ConfigFile = { message?: string; mdPath?: string };

function loadMdFile(mdPath: string): string | null {
	try {
		return readFileSync(mdPath, "utf-8");
	} catch (err) {
		console.error(`[pifinity] failed to load md file ${mdPath}:`, err);
		return null;
	}
}

function loadConfig(): { message: string | null; mdPath: string | null } {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const cfg = JSON.parse(raw) as ConfigFile;
		// If mdPath is set, read the file content
		if (cfg.mdPath) {
			const mdContent = loadMdFile(cfg.mdPath);
			if (mdContent) return { message: mdContent, mdPath: cfg.mdPath };
		}
		if (typeof cfg.message === "string" && cfg.message.trim()) {
			return { message: cfg.message, mdPath: null };
		}
	} catch {
		// File doesn't exist yet or invalid JSON -- that's fine
	}
	return { message: null, mdPath: null };
}

function saveConfig(msg: string, mdPath?: string) {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		const cfg: ConfigFile = mdPath ? { mdPath } : { message: msg };
		writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
	} catch (err) {
		console.error("[pifinity] failed to save config:", err);
	}
}

function restoreFromEntries(ctx: ExtensionContext) {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry.type === "custom" &&
			"customType" in entry &&
			(entry as any).customType === ENTRY_TYPE
		) {
			const data = (entry as any).data as PersistedState | undefined;
			if (data) {
				enabled = data.enabled ?? false;
				message = data.message ?? "continue";
				turnCount = data.turnCount ?? 0;
			}
			break;
		}
	}
}

// -- Widget ------------------------------------------------------------------

function applyWidget(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	if (!enabled) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
		render(width: number): string[] {
			const label = theme.fg("accent", "pifinity");
			const stateTag = paused
				? theme.fg("warning", "paused")
				: theme.fg("success", "on");
			const msg = theme.fg("muted", `"${message}"`);
			const turns = theme.fg("dim", `turn #${turnCount}`);
			const line = `${label} ${stateTag} ${msg}  ${turns}`;
			if (line.length > width) return [line.slice(0, width)];
			return [line];
		},
		invalidate() {},
	}), { placement: "aboveEditor" });
}

// -- Core logic --------------------------------------------------------------

function clearContinueRetry() {
	if (continueRetryTimer) {
		clearTimeout(continueRetryTimer);
		continueRetryTimer = undefined;
	}
}

function stopWatchdog() {
	if (watchdogTimer) {
		clearInterval(watchdogTimer);
		watchdogTimer = undefined;
	}
}

function startWatchdog() {
	if (watchdogTimer) return;
	watchdogTimer = setInterval(() => {
		const ctx = latestCtx;
		if (!ctx) return;
		if (!enabled || paused) return;
		if (!ctx.isIdle()) return;
		if (ctx.hasPendingMessages()) return;
		queueContinue(ctx);
	}, 5000);
}

function queueContinue(ctx: ExtensionContext, attempt = 0) {
	const runCtx = latestCtx ?? ctx;
	if (!enabled || paused) return;
	if (!message.trim()) return;
	if (runCtx.hasPendingMessages()) return;

	// During agent_end, Pi may still consider the agent "processing" for a
	// brief moment even though the stream has visually finished. Poll until the
	// session is truly idle, then send immediately so pifinity actually keeps
	// the loop going instead of leaving a queued follow-up behind.
	if (!runCtx.isIdle()) {
		if (continueRetryTimer) return;
		continueRetryTimer = setTimeout(() => {
			continueRetryTimer = undefined;
			queueContinue(runCtx, attempt + 1);
		}, Math.min(25 * (attempt + 1), 250));
		return;
	}

	clearContinueRetry();
	try {
		pi.sendUserMessage(message);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		if (errorMessage.includes("Agent is already processing")) {
			if (!continueRetryTimer) {
				continueRetryTimer = setTimeout(() => {
					continueRetryTimer = undefined;
					queueContinue(runCtx, attempt + 1);
				}, Math.min(25 * (attempt + 1), 250));
			}
			return;
		}
		throw err;
	}
}

function enable(ctx: ExtensionContext) {
	enabled = true;
	paused = false;
	turnCount = 0;
	skipNext = false;
	startWatchdog();
	applyWidget(ctx);
	persistState(ctx);
	ctx.ui.notify(`pifinity: ON -- will send "${message}" after each turn`, "info");

	// Kick off immediately if agent is idle
	if (ctx.isIdle()) {
		queueContinue(ctx);
	}
}

function disable(ctx: ExtensionContext) {
	enabled = false;
	paused = false;
	clearContinueRetry();
	stopWatchdog();
	applyWidget(ctx);
	persistState(ctx);
	ctx.ui.notify("pifinity: OFF", "info");
}

function pause(ctx: ExtensionContext) {
	paused = true;
	clearContinueRetry();
	stopWatchdog();
	applyWidget(ctx);
	ctx.ui.notify("pifinity: paused (send a message to resume)", "info");
}

// -- Helpers -----------------------------------------------------------------

/** Find the last assistant message's stopReason from agent_end messages */
function wasAborted(messages: any[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			return messages[i]?.stopReason === "aborted";
		}
	}
	return false;
}

// -- Extension entry point ---------------------------------------------------

export default function (api: ExtensionAPI) {
	pi = api;

	// Restore message from config file (cross-session) first, then session entries
	pi.on("session_start", async (event, ctx) => {
		latestCtx = ctx;
		const cfg = loadConfig();
		if (cfg.message) message = cfg.message;
		// Reset first; restoreFromEntries will re-enable if state was saved
		enabled = false;
		paused = false;
		stopWatchdog();
		restoreFromEntries(ctx);
		if (enabled && !paused) startWatchdog();
		applyWidget(ctx);
		// On /reload, if pifinity was enabled and agent is idle, re-kick the loop
		if (enabled && !paused && event.reason === "reload" && ctx.isIdle()) {
			queueContinue(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		clearContinueRetry();
		stopWatchdog();
		latestCtx = undefined;
	});

	// Track user input:
	// - If paused: unpause (their message goes through, pifinity resumes after)
	// - If active: skip one cycle so "continue" doesn't bury their steer
	pi.on("input", async (event, _ctx) => {
		if (event.source !== "interactive") return { action: "continue" };

		if (paused) {
			paused = false;
			startWatchdog();
			// Don't set skipNext -- pifinity should fire on the next agent_end
		} else if (enabled) {
			skipNext = true;
		}

		return { action: "continue" };
	});

	// Ensure pifinity state survives compaction by persisting it just before the cut.
	pi.on("session_before_compact", async (_event, ctx) => {
		if (enabled || turnCount > 0) {
			persistState(ctx);
		}
		// Return undefined → proceed with default compaction
	});

	// After compaction, re-kick the loop if the agent went idle.
	// Auto-compaction runs concurrently with pifinity's fire-and-forget sendUserMessage
	// (triggered from agent_end), and the two can race — leaving the loop stalled.
	pi.on("session_compact", async (_event, ctx) => {
		if (!enabled || paused) return;
		// Re-persist state so it stays in the kept range for future compactions
		persistState(ctx);
		applyWidget(ctx);
		// If no turn is running and nothing is queued, pifinity's "continue" was
		// lost in the compaction race. Re-fire it now.
		if (ctx.isIdle() && !ctx.hasPendingMessages()) {
			turnCount++;
			persistState(ctx);
			queueContinue(ctx);
		}
	});

	// The loop: send continue after agent finishes
	pi.on("agent_end", async (event, ctx) => {
		latestCtx = ctx;
		if (!enabled) return;

		// Esc was hit -- pause instead of continuing
		if (wasAborted(event.messages)) {
			pause(ctx);
			return;
		}

		if (paused) return;

		if (skipNext) {
			skipNext = false;
			// Don't return — fall through and re-kick the loop.
			// The user got their one steered turn; pifinity resumes immediately after.
		}

		turnCount++;
		applyWidget(ctx);
		persistState(ctx);

		// Queue the next continue safely whether the runtime is already idle
		// or still finishing the current assistant turn.
		queueContinue(ctx);
	});

	// Commands

	pi.registerCommand("pifinity", {
		description: "Toggle infinite auto-continue (pifinity)",
		getArgumentCompletions(prefix: string) {
			const p = prefix.trim().toLowerCase();
			const items = [
				{ value: "on", label: "on", description: "Enable infinite continue" },
				{ value: "off", label: "off", description: "Disable infinite continue" },
			];
			const filtered = p ? items.filter((i) => i.value.startsWith(p)) : items;
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();

			if (sub === "on") {
				if (enabled) {
					ctx.ui.notify("pifinity is already ON", "info");
					return;
				}
				enable(ctx);
			} else if (sub === "off") {
				if (!enabled) {
					ctx.ui.notify("pifinity is already OFF", "info");
					return;
				}
				disable(ctx);
			} else {
				if (enabled) {
					disable(ctx);
				} else {
					enable(ctx);
				}
			}
		},
	});

	pi.registerCommand("pifinity-msg", {
		description: "Set the pifinity continue message (inline text)",
		handler: async (args, ctx) => {
			const newMsg = args.trim();
			if (!newMsg) {
				ctx.ui.notify(`pifinity message: "${message}"`, "info");
				return;
			}
			message = newMsg;
			saveConfig(message);
			persistState(ctx);
			applyWidget(ctx);
			ctx.ui.notify(`pifinity message set to: "${message}"`, "info");
		},
	});

	pi.registerCommand("pifinity-md", {
		description: "Set the pifinity continue message from an MD file (provide absolute or relative path)",
		handler: async (args, ctx) => {
			const mdPath = args.trim();
			if (!mdPath) {
				// Show current status
				const cfg = loadConfig();
				if (cfg.mdPath) {
					ctx.ui.notify(`pifinity MD file: ${cfg.mdPath}`, "info");
				} else {
					ctx.ui.notify("pifinity: no MD file set (using inline message)", "info");
				}
				return;
			}
			// Resolve relative paths
			const resolvedPath = mdPath.startsWith("/") 
				? mdPath 
				: join(process.cwd(), mdPath);
			const content = loadMdFile(resolvedPath);
			if (!content) {
				ctx.ui.notify(`Failed to load MD file: ${resolvedPath}`, "error");
				return;
			}
			message = content;
			saveConfig("", resolvedPath);  // Save path, not content
			persistState(ctx);
			applyWidget(ctx);
			ctx.ui.notify(`pifinity message set from MD file: ${resolvedPath}`, "info");
		},
	});
}
