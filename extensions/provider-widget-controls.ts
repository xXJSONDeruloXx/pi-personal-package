import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { InteractiveMode } from "@mariozechner/pi-coding-agent";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	PROVIDER_WIDGET_VISIBILITY_EVENT,
	getProviderWidgetVisibilityCompletions,
	loadGlobalProviderWidgetVisibility,
	parseProviderWidgetVisibilityArg,
	persistGlobalProviderWidgetVisibility,
	readSettings,
	writeSettings,
	type ProviderWidgetVisibility,
} from "./lib/provider-widget-visibility";

const SETTINGS_KEY = "pi-provider-widgets";
const WIDGET_ORDER_KEY = "widgetOrder";

const DEFAULT_WIDGET_ORDER = [
	"codex-usage-widget",
	"copilot-usage-widget",
	"zai-usage-widget",
	"base-diff-widget",
];

// ── Widget order: patch InteractiveMode.prototype.renderWidgetContainer ────

let activeWidgetOrder: string[] = [...DEFAULT_WIDGET_ORDER];

function sortWidgetMap(widgets: Map<string, unknown>): Map<string, unknown> {
	return new Map(
		[...widgets.entries()].sort(([a], [b]) => {
			const ai = activeWidgetOrder.indexOf(a);
			const bi = activeWidgetOrder.indexOf(b);
			const aRank = ai === -1 ? activeWidgetOrder.length : ai;
			const bRank = bi === -1 ? activeWidgetOrder.length : bi;
			return aRank - bRank;
		}),
	);
}

const origRenderWidgetContainer = (InteractiveMode.prototype as any).renderWidgetContainer;
(InteractiveMode.prototype as any).renderWidgetContainer = function (
	container: unknown,
	widgets: Map<string, unknown>,
	spacerWhenEmpty: boolean,
	leadingSpacer: boolean,
) {
	origRenderWidgetContainer.call(this, container, sortWidgetMap(widgets), spacerWhenEmpty, leadingSpacer);
};

// ── Settings persistence ───────────────────────────────────────────────────

async function loadWidgetOrder(): Promise<string[]> {
	const settings = await readSettings();
	const providerWidgets = settings[SETTINGS_KEY];
	if (!providerWidgets || typeof providerWidgets !== "object" || Array.isArray(providerWidgets)) {
		return [...DEFAULT_WIDGET_ORDER];
	}
	const order = (providerWidgets as Record<string, unknown>)[WIDGET_ORDER_KEY];
	if (!Array.isArray(order) || order.length === 0) return [...DEFAULT_WIDGET_ORDER];
	return order.filter((v) => typeof v === "string") as string[];
}

async function persistWidgetOrder(order: string[]): Promise<void> {
	const settings = await readSettings();
	const providerWidgets =
		settings[SETTINGS_KEY] && typeof settings[SETTINGS_KEY] === "object" && !Array.isArray(settings[SETTINGS_KEY])
			? (settings[SETTINGS_KEY] as Record<string, unknown>)
			: {};
	providerWidgets[WIDGET_ORDER_KEY] = order;
	settings[SETTINGS_KEY] = providerWidgets;
	await writeSettings(settings);
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function providerWidgetControls(pi: ExtensionAPI) {
	let currentVisibility: ProviderWidgetVisibility = "auto";
	let settingsWriteQueue: Promise<void> = Promise.resolve();

	const queuePersistOrder = (ctx: ExtensionContext) => {
		const snapshot = [...activeWidgetOrder];
		settingsWriteQueue = settingsWriteQueue
			.catch(() => undefined)
			.then(() => persistWidgetOrder(snapshot))
			.catch((err) => {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Provider widgets: failed to save order: ${err instanceof Error ? err.message : String(err)}`,
						"warning",
					);
				}
			});
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			currentVisibility = (await loadGlobalProviderWidgetVisibility()) ?? "auto";
		} catch {
			currentVisibility = "auto";
		}

		try {
			activeWidgetOrder = await loadWidgetOrder();
		} catch {
			activeWidgetOrder = [...DEFAULT_WIDGET_ORDER];
		}

		pi.events.emit(PROVIDER_WIDGET_VISIBILITY_EVENT, { visibility: currentVisibility });
	});

	// ── /provider-widget-visibility ──────────────────────────────────────

	pi.registerCommand("provider-widget-visibility", {
		description: "Set all provider widget visibilities at once: auto | always | hidden",
		getArgumentCompletions: getProviderWidgetVisibilityCompletions,
		handler: async (args, ctx) => {
			try {
				currentVisibility = (await loadGlobalProviderWidgetVisibility()) ?? currentVisibility;
			} catch { /* keep current */ }

			const next = parseProviderWidgetVisibilityArg(args, currentVisibility);
			if (!next) return;
			currentVisibility = next;
			await persistGlobalProviderWidgetVisibility(currentVisibility);
			pi.events.emit(PROVIDER_WIDGET_VISIBILITY_EVENT, { visibility: currentVisibility });
			ctx.ui.notify(`Provider widgets: ${currentVisibility}`, "info");
		},
	});

	// ── /provider-widget-order ───────────────────────────────────────────

	pi.registerCommand("provider-widget-order", {
		description: "Set widget display order. Args: space-separated keys or short names (codex copilot zai)",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase().split(/\s+/).pop() ?? "";
			const items = [
				{ value: "codex", label: "codex", description: "codex-usage-widget" },
				{ value: "copilot", label: "copilot", description: "copilot-usage-widget" },
				{ value: "zai", label: "zai", description: "zai-usage-widget" },
			];
			if (!p) return items;
			const filtered = items.filter((i) => i.value.startsWith(p));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const SHORT: Record<string, string> = {
				codex: "codex-usage-widget",
				copilot: "copilot-usage-widget",
				zai: "zai-usage-widget",
			};

			const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				const current = activeWidgetOrder
					.map((k) => {
						const short = Object.entries(SHORT).find(([, v]) => v === k)?.[0] ?? k;
						return short;
					})
					.join(" ");
				ctx.ui.notify(`Current widget order: ${current}`, "info");
				return;
			}

			const resolved = tokens.map((t) => SHORT[t] ?? t);
			activeWidgetOrder = resolved;
			queuePersistOrder(ctx);
			ctx.ui.notify(`Widget order: ${tokens.join(" → ")}`, "info");
		},
	});
}
