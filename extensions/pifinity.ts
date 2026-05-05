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

type ConfigFile = { message?: string };

function loadConfig(): string | null {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const cfg = JSON.parse(raw) as ConfigFile;
		if (typeof cfg.message === "string" && cfg.message.trim()) return cfg.message;
	} catch {
		// File doesn't exist yet or invalid JSON -- that's fine
	}
	return null;
}

function saveConfig(msg: string) {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ message: msg }, null, 2), "utf-8");
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

function enable(ctx: ExtensionContext) {
	enabled = true;
	paused = false;
	turnCount = 0;
	skipNext = false;
	applyWidget(ctx);
	persistState(ctx);
	ctx.ui.notify(`pifinity: ON -- will send "${message}" after each turn`, "info");

	// Kick off immediately if agent is idle
	if (ctx.isIdle()) {
		pi.sendUserMessage(message);
	}
}

function disable(ctx: ExtensionContext) {
	enabled = false;
	paused = false;
	applyWidget(ctx);
	persistState(ctx);
	ctx.ui.notify("pifinity: OFF", "info");
}

function pause(ctx: ExtensionContext) {
	paused = true;
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
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		const cfgMsg = loadConfig();
		if (cfgMsg) message = cfgMsg;
		restoreFromEntries(ctx);
		enabled = false;
		paused = false;
		applyWidget(ctx);
	});

	pi.on("session_shutdown", () => {
		latestCtx = undefined;
	});

	// Track user input:
	// - If paused: unpause (their message goes through, pifinity resumes after)
	// - If active: skip one cycle so "continue" doesn't bury their steer
	pi.on("input", async (event, _ctx) => {
		if (event.source !== "interactive") return { action: "continue" };

		if (paused) {
			paused = false;
			// Don't set skipNext -- pifinity should fire on the next agent_end
		} else if (enabled) {
			skipNext = true;
		}

		return { action: "continue" };
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
			return;
		}

		turnCount++;
		applyWidget(ctx);
		persistState(ctx);

		// Agent is idle -- sendUserMessage triggers a new turn immediately
		pi.sendUserMessage(message);
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
		description: "Set the pifinity continue message",
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
}
