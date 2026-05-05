/**
 * pifinity: Infinite auto-continue extension for pi.
 *
 * Keeps the agent looping by sending a follow-up message after each agent_end.
 * Only stops when you run /pifinity off. Steer freely -- pifinity will skip
 * one cycle after your steer so it doesn't bury your input.
 *
 * Commands:
 *   /pifinity [on|off]       - toggle or explicitly set
 *   /pifinity-msg [text]     - set the continue message (default: "continue")
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const WIDGET_KEY = "pifinity";
const ENTRY_TYPE = "pifinity-state";

// -- State -------------------------------------------------------------------

let enabled = false;
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
			const icon = theme.fg("accent", "pifinity");
			const msg = theme.fg("muted", `"${message}"`);
			const turns = theme.fg("dim", `turn #${turnCount}`);
			const line = `${icon} ${msg}  ${turns}`;
			if (line.length > width) return [line.slice(0, width)];
			return [line];
		},
		invalidate() {},
	}), { placement: "aboveEditor" });
}

// -- Core logic --------------------------------------------------------------

function enable(ctx: ExtensionContext) {
	enabled = true;
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
	applyWidget(ctx);
	persistState(ctx);
	ctx.ui.notify("pifinity: OFF", "info");
}

// -- Extension entry point ---------------------------------------------------

export default function (api: ExtensionAPI) {
	pi = api;

	// Restore message/counter from session entries
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		restoreFromEntries(ctx);
		enabled = false;
		applyWidget(ctx);
	});

	pi.on("session_shutdown", () => {
		latestCtx = undefined;
	});

	// Track when user sends input so we can skip one pifinity cycle
	// after their steer -- otherwise "continue" buries their message
	pi.on("input", async (event, _ctx) => {
		if (event.source === "interactive" && enabled) {
			skipNext = true;
		}
		return { action: "continue" };
	});

	// The loop: send continue after agent finishes
	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		if (!enabled) return;

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
			persistState(ctx);
			applyWidget(ctx);
			ctx.ui.notify(`pifinity message set to: "${message}"`, "info");
		},
	});
}
