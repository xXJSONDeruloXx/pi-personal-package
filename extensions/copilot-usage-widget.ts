import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	PROVIDER_WIDGET_VISIBILITY_EVENT,
	getEffectiveProviderWidgetVisibility,
	loadGlobalProviderWidgetVisibility,
	normalizeProviderWidgetVisibility,
	type ProviderWidgetVisibility,
} from "./lib/provider-widget-visibility";

const STATUS_KEY = "copilot-usage";
const WIDGET_KEY = "copilot-usage-widget";
const ENTRY_TYPE = "copilot-usage-settings";
const SETTINGS_KEY = "pi-copilot-usage";
const SETTINGS_FILE = path.join(
	process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent"),
	"settings.json",
);
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const GH_TIMEOUT_MS = 5000;

type CopilotInternalResponse = {
	copilot_plan?: string;
	quota_reset_date_utc?: string;
	quota_snapshots?: {
		premium_interactions?: {
			entitlement?: number;
			quota_remaining?: number;
			percent_remaining?: number;
			unlimited?: boolean;
			overage_permitted?: boolean;
			overage_count?: number;
			timestamp_utc?: string;
		};
	};
};

type UsageState = {
	plan: string;
	entitlement: number;
	remaining: number;
	used: number;
	overageCount: number;
	overagePermitted: boolean;
	percentUsed: number;
	percentRemaining: number;
	resetAt: string;
	updatedAt: string;
	stale: boolean;
};

type Visibility = ProviderWidgetVisibility;
type WidgetPlacement = "aboveEditor" | "belowEditor";

type PersistedSettings = {
	visibility: Visibility;
	showBar: boolean;
	placement: WidgetPlacement;
	overageRate: number;
};

const DEFAULT_SETTINGS: PersistedSettings = {
	visibility: "auto",
	showBar: false,
	placement: "aboveEditor",
	overageRate: 0.04,
};

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function bar(ratio: number, width: number): { filled: string; empty: string } {
	const safeWidth = Math.max(1, width);
	const filledWidth = clamp(Math.round(ratio * safeWidth), 0, safeWidth);
	return {
		filled: "█".repeat(filledWidth),
		empty: "░".repeat(safeWidth - filledWidth),
	};
}

function usageColorKey(percentUsed: number, overageCount: number): "success" | "warning" | "error" {
	if (overageCount > 0 || percentUsed >= 85) return "error";
	if (percentUsed >= 60) return "warning";
	return "success";
}

function formatReset(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(date);
}

function isCopilotProvider(ctx: ExtensionContext): boolean {
	try {
		return ctx.model?.provider === "github-copilot";
	} catch {
		return false;
	}
}

async function readSettings(): Promise<Record<string, unknown>> {
	try {
		const raw = await fs.readFile(SETTINGS_FILE, "utf8");
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw e;
	}
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
	await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function normalizePersistedSettings(value: unknown): PersistedSettings {
	if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
	const s = value as Partial<PersistedSettings>;
	return {
		visibility:
			s.visibility === "always" || s.visibility === "auto" || s.visibility === "hidden"
				? s.visibility
				: DEFAULT_SETTINGS.visibility,
		showBar: s.showBar ?? DEFAULT_SETTINGS.showBar,
		placement:
			s.placement === "aboveEditor" || s.placement === "belowEditor"
				? s.placement
				: DEFAULT_SETTINGS.placement,
		overageRate: typeof s.overageRate === "number" && s.overageRate >= 0 ? s.overageRate : DEFAULT_SETTINGS.overageRate,
	};
}

async function loadPersistedSettings(): Promise<PersistedSettings> {
	const settings = await readSettings();
	return normalizePersistedSettings(settings[SETTINGS_KEY]);
}

async function persistSettingsToDisk(settings: PersistedSettings): Promise<void> {
	const all = await readSettings();
	all[SETTINGS_KEY] = settings;
	await writeSettings(all);
}

function parsePlacementArg(args: string, current: WidgetPlacement): WidgetPlacement | null {
	const token = args.trim().toLowerCase().split(/\s+/)[0] ?? "";
	if (!token || token === "toggle") return current === "aboveEditor" ? "belowEditor" : "aboveEditor";
	if (token === "above") return "aboveEditor";
	if (token === "below") return "belowEditor";
	return null;
}

function getPlacementCompletions(prefix: string) {
	const p = prefix.trim().toLowerCase();
	const items = [
		{ value: "above", label: "above", description: "Show widget above the editor" },
		{ value: "below", label: "below", description: "Show widget below the editor" },
		{ value: "toggle", label: "toggle", description: "Flip widget placement" },
	];
	if (!p) return items;
	const filtered = items.filter((i) => i.value.startsWith(p));
	return filtered.length > 0 ? filtered : null;
}

function parseUsage(stdout: string): UsageState {
	const parsed = JSON.parse(stdout) as CopilotInternalResponse;
	const premium = parsed.quota_snapshots?.premium_interactions;

	if (!premium) throw new Error("Missing premium_interactions quota in /copilot_internal/user response");
	if (premium.unlimited) throw new Error("Premium interactions are unlimited for this account");

	const entitlement = premium.entitlement;
	const remaining = premium.quota_remaining;
	const percentRemaining = premium.percent_remaining;
	const overageCount = premium.overage_count ?? 0;
	const overagePermitted = premium.overage_permitted ?? false;
	const resetAt = parsed.quota_reset_date_utc;
	const updatedAt = premium.timestamp_utc;

	if (
		typeof entitlement !== "number" ||
		typeof remaining !== "number" ||
		typeof percentRemaining !== "number" ||
		typeof overageCount !== "number" ||
		typeof overagePermitted !== "boolean" ||
		typeof resetAt !== "string" ||
		typeof updatedAt !== "string"
	) {
		throw new Error("Unexpected /copilot_internal/user response shape");
	}

	const used = Math.max(0, entitlement - remaining);
	const percentUsed = clamp(100 - percentRemaining, 0, 100);

	return {
		plan: parsed.copilot_plan ?? "copilot",
		entitlement,
		remaining,
		used,
		overageCount,
		overagePermitted,
		percentUsed,
		percentRemaining,
		resetAt,
		updatedAt,
		stale: false,
	};
}

async function fetchUsage(pi: ExtensionAPI): Promise<UsageState> {
	const result = await pi.exec(
		"gh",
		["api", "-H", "Accept: application/vnd.github+json", "/copilot_internal/user"],
		{ timeout: GH_TIMEOUT_MS },
	);

	if (result.code !== 0) {
		const error = (result.stderr || result.stdout || "gh api failed").trim();
		throw new Error(error);
	}
	if (!result.stdout.trim()) throw new Error("Empty response from gh api /copilot_internal/user");

	return parseUsage(result.stdout);
}

function applyUI(
	ctx: ExtensionContext,
	usage: UsageState | null,
	settings: PersistedSettings,
	globalVisibility: Visibility | null,
	isCopilot: boolean,
): void {
	if (!ctx.hasUI) return;

	const effectiveVisibility = getEffectiveProviderWidgetVisibility(settings.visibility, globalVisibility);

	if (effectiveVisibility === "hidden") {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	if (effectiveVisibility === "auto" && !isCopilot) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	if (!usage) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const color = usageColorKey(usage.percentUsed, usage.overageCount);
	ctx.ui.setStatus(STATUS_KEY, undefined);

	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, widgetTheme) => ({
			render(width: number): string[] {
				const staleWidget = usage.stale ? ` ${widgetTheme.fg("warning", "(stale)")}` : "";
				const resetText = formatReset(usage.resetAt);
				const prefix = widgetTheme.fg("accent", "Copilot ");
				const baseDetails = `${Math.round(usage.percentUsed)}% ${usage.used}/${usage.entitlement}`;
				const overageDetails = (() => {
					if (usage.overageCount <= 0) return "";
					const cost = (usage.overageCount * settings.overageRate).toFixed(2);
					const costStr = widgetTheme.fg(color, `~$${cost}`);
					const allowedStr = widgetTheme.fg(usage.overagePermitted ? "warning" : "error", usage.overagePermitted ? "allowed" : "blocked");
					return ` · ${widgetTheme.fg(color, `+${usage.overageCount} overage`)} ${allowedStr} ${costStr}`;
				})();
				const details =
					widgetTheme.fg("muted", `${baseDetails}`) +
					overageDetails +
					widgetTheme.fg("muted", ` · reset ${resetText}`);

				if (!settings.showBar) {
					return [truncateToWidth(prefix + details + staleWidget, width)];
				}

				const suffix = ` ${details}${staleWidget}`;
				const reserved = visibleWidth(prefix) + visibleWidth(suffix);
				const barWidth = clamp(width - reserved, 8, 28);
				const ratio = usage.entitlement > 0 ? clamp(usage.used / usage.entitlement, 0, 1) : 0;
				const parts = bar(ratio, barWidth);
				const barText = widgetTheme.fg(color, parts.filled) + widgetTheme.fg("dim", parts.empty);
				return [truncateToWidth(prefix + barText + suffix, width)];
			},
			invalidate() {},
		}),
		{ placement: settings.placement },
	);
}

export default function copilotUsageWidget(pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | undefined;
	let latestUsage: UsageState | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let refreshQueued = false;
	let settings: PersistedSettings = { ...DEFAULT_SETTINGS };
	let globalVisibility: Visibility | null = null;
	let settingsWriteQueue: Promise<void> = Promise.resolve();

	const persistAll = (ctx: ExtensionContext) => {
		pi.appendEntry(ENTRY_TYPE, { ...settings });
		settingsWriteQueue = settingsWriteQueue
			.catch(() => undefined)
			.then(() => persistSettingsToDisk(settings))
			.catch((error) => {
				if (!ctx.hasUI) return;
				ctx.ui.notify(
					`Copilot usage: failed to save settings: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
	};

	const ensureTimer = () => {
		if (refreshTimer) return;
		refreshTimer = setInterval(() => {
			void refresh();
		}, REFRESH_INTERVAL_MS);
	};

	const refresh = async (ctx?: ExtensionContext, notifyOnError = false) => {
		if (ctx) latestCtx = ctx;
		if (!latestCtx?.hasUI) return;

		const providerIsCopilot = isCopilotProvider(latestCtx);
		const effectiveVisibility = getEffectiveProviderWidgetVisibility(settings.visibility, globalVisibility);

		if (effectiveVisibility === "auto" && !providerIsCopilot) {
			applyUI(latestCtx, null, settings, globalVisibility, false);
			return;
		}

		if (refreshing) {
			refreshQueued = true;
			return;
		}

		refreshing = true;
		try {
			do {
				refreshQueued = false;
				try {
					latestUsage = await fetchUsage(pi);
				} catch (error) {
					if (latestUsage) {
						latestUsage = { ...latestUsage, stale: true };
					} else {
						latestUsage = null;
					}

					if (notifyOnError && latestCtx) {
						const message = error instanceof Error ? error.message : String(error);
						latestCtx.ui.notify(`Copilot usage refresh failed: ${message}`, "warning");
					}
				}

				if (latestCtx) {
					applyUI(latestCtx, latestUsage, settings, globalVisibility, providerIsCopilot);
				}
			} while (refreshQueued);
		} finally {
			refreshing = false;
		}
	};

	const onSessionStart = async (_event: unknown, ctx: ExtensionContext) => {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && "customType" in entry && (entry as any).customType === ENTRY_TYPE) {
				const data = (entry as any).data as PersistedSettings | undefined;
				if (data) settings = normalizePersistedSettings(data);
				break;
			}
		}

		try {
			settings = await loadPersistedSettings();
		} catch {
			// keep restored/default settings
		}

		try {
			globalVisibility = await loadGlobalProviderWidgetVisibility();
		} catch {
			globalVisibility = null;
		}

		ensureTimer();
		await refresh(ctx);
	};

	const onUiEvent = async (_event: unknown, ctx: ExtensionContext) => {
		ensureTimer();
		await refresh(ctx);
	};

	pi.on("session_start", onSessionStart);
	pi.on("session_switch", onUiEvent);
	pi.on("turn_end", onUiEvent);
	pi.on("model_select", onUiEvent);

	pi.events.on(PROVIDER_WIDGET_VISIBILITY_EVENT, (payload: unknown) => {
		globalVisibility = normalizeProviderWidgetVisibility((payload as { visibility?: unknown } | null)?.visibility);
		if (latestCtx) {
			applyUI(latestCtx, latestUsage, settings, globalVisibility, isCopilotProvider(latestCtx));
			void refresh();
		}
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	});

	pi.registerCommand("copilot-usage", {
		description: "Cycle Copilot usage widget visibility (auto → always → hidden)",
		handler: async (_args, ctx) => {
			const cycle: Visibility[] = ["auto", "always", "hidden"];
			const idx = cycle.indexOf(settings.visibility);
			settings.visibility = cycle[(idx + 1) % cycle.length];
			persistAll(ctx);
			applyUI(ctx, latestUsage, settings, globalVisibility, isCopilotProvider(ctx));
			ctx.ui.notify(`Copilot usage: ${settings.visibility}`, "info");
		},
	});

	pi.registerCommand("copilot-usage-bar", {
		description: "Toggle Copilot usage progress bar",
		handler: async (_args, ctx) => {
			settings.showBar = !settings.showBar;
			persistAll(ctx);
			applyUI(ctx, latestUsage, settings, globalVisibility, isCopilotProvider(ctx));
			ctx.ui.notify(`Copilot usage bar ${settings.showBar ? "shown" : "hidden"}`, "info");
		},
	});

	pi.registerCommand("copilot-usage-placement", {
		description: "Set Copilot widget placement: above | below | toggle",
		getArgumentCompletions: getPlacementCompletions,
		handler: async (args, ctx) => {
			const next = parsePlacementArg(args, settings.placement);
			if (!next) return;
			settings.placement = next;
			persistAll(ctx);
			applyUI(ctx, latestUsage, settings, globalVisibility, isCopilotProvider(ctx));
			ctx.ui.notify(`Copilot widget: ${next === "aboveEditor" ? "above editor" : "below editor"}`, "info");
		},
	});

	pi.registerCommand("copilot-overage-rate", {
		description: "Set cost per overage unit (default $0.04). E.g. /copilot-overage-rate 0.04",
		handler: async (args, ctx) => {
			const token = args.trim();
			if (!token) {
				ctx.ui.notify(`Copilot overage rate: $${settings.overageRate.toFixed(4)}/unit`, "info");
				return;
			}
			const parsed = parseFloat(token);
			if (Number.isNaN(parsed) || parsed < 0) {
				ctx.ui.notify("Invalid rate — provide a non-negative number e.g. 0.04", "warning");
				return;
			}
			settings.overageRate = parsed;
			persistAll(ctx);
			applyUI(ctx, latestUsage, settings, globalVisibility, isCopilotProvider(ctx));
			ctx.ui.notify(`Copilot overage rate set to $${parsed.toFixed(4)}/unit`, "info");
		},
	});

	pi.registerCommand("copilot-usage-refresh", {
		description: "Refresh GitHub Copilot premium request usage widget",
		handler: async (_args, ctx) => {
			ensureTimer();
			await refresh(ctx, true);
			if (latestUsage && !latestUsage.stale) {
				const overageText =
					latestUsage.overageCount > 0
						? `, +${latestUsage.overageCount} overage (${latestUsage.overagePermitted ? "allowed" : "blocked"})`
						: "";
				ctx.ui.notify(
					`Copilot usage refreshed: ${Math.round(latestUsage.percentUsed)}% used (${latestUsage.used}/${latestUsage.entitlement}${overageText})`,
					"info",
				);
			}
		},
	});
}
