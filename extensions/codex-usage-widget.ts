/**
 * Codex usage widget for pi-personal-package.
 * Local widget version with per-widget settings, placement control, and support
 * for a shared global provider-widget visibility override.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
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

const WIDGET_KEY = "codex-usage-widget";
const ENTRY_TYPE = "codex-usage-settings";
const SETTINGS_KEY = "pi-codex-usage";
const REFRESH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

const SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SPARK_LIMIT_NAME = "GPT-5.3-Codex-Spark";
const MISSING_AUTH_ERROR_PREFIX = "Missing openai-codex OAuth access/accountId";

const agentDirFromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
const AGENT_DIR = agentDirFromEnv || path.join(os.homedir(), ".pi", "agent");
const AUTH_FILE = path.join(AGENT_DIR, "auth.json");
const SETTINGS_FILE = path.join(AGENT_DIR, "settings.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type UsageWindow = {
	used_percent?: number | null;
	reset_after_seconds?: number | null;
	reset_at?: number | null;
};

type RateLimitBucket = {
	allowed?: boolean;
	limit_reached?: boolean;
	primary_window?: UsageWindow | null;
	secondary_window?: UsageWindow | null;
};

type CodexUsageResponse = {
	rate_limit?: RateLimitBucket | null;
	additional_rate_limits?: Record<string, unknown> | unknown[] | null;
};

type UsageSnapshot = {
	fiveHourLeftPercent: number | null;
	sevenDayLeftPercent: number | null;
	fiveHourResetInSeconds: number | null;
	sevenDayResetInSeconds: number | null;
	isLimited: boolean;
	stale: boolean;
};

type Visibility = ProviderWidgetVisibility;
type DisplayMode = "left" | "used";
type ResetWindowMode = "5h" | "7d";
type WidgetPlacement = "aboveEditor" | "belowEditor";

type PersistedSettings = {
	visibility: Visibility;
	showBar: boolean;
	displayMode: DisplayMode;
	resetWindow: ResetWindowMode;
	placement: WidgetPlacement;
};

const DEFAULT_SETTINGS: PersistedSettings = {
	visibility: "auto",
	showBar: true,
	displayMode: "left",
	resetWindow: "7d",
	placement: "aboveEditor",
};

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}

function clampPercent(v: number): number {
	return clamp(v, 0, 100);
}

function usedToLeft(v: number | null | undefined): number | null {
	if (typeof v !== "number" || Number.isNaN(v)) return null;
	return clampPercent(100 - v);
}

function bar(ratio: number, width: number): { filled: string; empty: string } {
	const w = Math.max(1, width);
	const filled = clamp(Math.round(ratio * w), 0, w);
	return { filled: "█".repeat(filled), empty: "░".repeat(w - filled) };
}

function colorForLeft(pctLeft: number): "success" | "warning" | "error" {
	if (pctLeft <= 10) return "error";
	if (pctLeft <= 25) return "warning";
	return "success";
}

function colorForUsed(pctUsed: number): "success" | "warning" | "error" {
	if (pctUsed >= 90) return "error";
	if (pctUsed >= 75) return "warning";
	return "success";
}

function formatCountdown(seconds: number | null): string | null {
	if (typeof seconds !== "number" || Number.isNaN(seconds)) return null;
	let total = Math.max(0, Math.round(seconds));
	if (total === 0) return "now";
	const days = Math.floor(total / 86_400);
	total %= 86_400;
	const hours = Math.floor(total / 3_600);
	total %= 3_600;
	const mins = Math.floor(total / 60);
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${mins}m`;
	return `${mins}m`;
}

function isSparkModel(modelId: string | undefined): boolean {
	return modelId === SPARK_MODEL_ID;
}

function isCodexModel(modelId: string | undefined): boolean {
	return typeof modelId === "string" && modelId.toLowerCase().includes("codex");
}

function getLabel(modelId: string | undefined): string {
	return isSparkModel(modelId) ? "Codex Spark" : "Codex";
}

function colorizePercent(
	theme: ExtensionContext["ui"]["theme"],
	leftPct: number | null,
	mode: DisplayMode,
): string {
	if (leftPct === null) return theme.fg("muted", "--");
	const usedPct = clampPercent(100 - leftPct);
	const display = mode === "left" ? leftPct : usedPct;
	const rounded = Math.round(clampPercent(display));
	const text = mode === "left" ? `${rounded}% left` : `${rounded}% used`;
	const color = mode === "left" ? colorForLeft(leftPct) : colorForUsed(usedPct);
	return theme.fg(color, text);
}

async function readAgentSettings(): Promise<Record<string, unknown>> {
	try {
		const raw = await fs.readFile(SETTINGS_FILE, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw e;
	}
}

async function writeAgentSettings(settings: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
	await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function normalizeSettings(value: unknown): PersistedSettings {
	if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
	const s = value as Partial<PersistedSettings>;
	return {
		visibility:
			s.visibility === "auto" || s.visibility === "always" || s.visibility === "hidden"
				? s.visibility
				: DEFAULT_SETTINGS.visibility,
		showBar: s.showBar ?? DEFAULT_SETTINGS.showBar,
		displayMode:
			s.displayMode === "left" || s.displayMode === "used"
				? s.displayMode
				: DEFAULT_SETTINGS.displayMode,
		resetWindow:
			s.resetWindow === "5h" || s.resetWindow === "7d"
				? s.resetWindow
				: DEFAULT_SETTINGS.resetWindow,
		placement:
			s.placement === "aboveEditor" || s.placement === "belowEditor"
				? s.placement
				: DEFAULT_SETTINGS.placement,
	};
}

async function loadPersistedSettings(): Promise<PersistedSettings> {
	const all = await readAgentSettings();
	return normalizeSettings(all[SETTINGS_KEY]);
}

async function persistSettingsToDisk(settings: PersistedSettings): Promise<void> {
	const all = await readAgentSettings();
	all[SETTINGS_KEY] = settings;
	await writeAgentSettings(all);
}

async function loadAuth(): Promise<{ accessToken: string; accountId: string }> {
	const raw = await fs.readFile(AUTH_FILE, "utf8");
	const auth = JSON.parse(raw) as Record<
		string,
		| { type?: string; access?: string | null; accountId?: string | null; account_id?: string | null }
		| undefined
	>;

	const entry = auth["openai-codex"];
	const oauth = entry?.type === "oauth" ? entry : undefined;
	const accessToken = oauth?.access?.trim();
	const accountId = (oauth?.accountId ?? oauth?.account_id)?.trim();

	if (!accessToken || !accountId) {
		throw new Error(`${MISSING_AUTH_ERROR_PREFIX} in ${AUTH_FILE}`);
	}
	return { accessToken, accountId };
}

function isMissingAuthError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	if (e.message.includes(MISSING_AUTH_ERROR_PREFIX)) return true;
	return (e as NodeJS.ErrnoException).code === "ENOENT" && e.message.includes(AUTH_FILE);
}

function asObject(v: unknown): Record<string, unknown> | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null;
	return v as Record<string, unknown>;
}

function normalizeBucket(v: unknown): RateLimitBucket | null {
	const r = asObject(v);
	if (!r) return null;
	if (!("primary_window" in r || "secondary_window" in r || "limit_reached" in r || "allowed" in r)) {
		return null;
	}
	return r as RateLimitBucket;
}

function findSparkBucket(data: CodexUsageResponse): RateLimitBucket | null {
	const additional = data.additional_rate_limits;
	const entries = Array.isArray(additional)
		? additional
		: additional ? Object.values(asObject(additional) ?? {}) : [];
	for (const entry of entries) {
		const r = asObject(entry);
		if (typeof r?.limit_name === "string" && r.limit_name.trim() === SPARK_LIMIT_NAME) {
			return normalizeBucket(r.rate_limit);
		}
	}
	return null;
}

function getResetSeconds(window: UsageWindow | null | undefined): number | null {
	const secs = window?.reset_after_seconds;
	if (typeof secs === "number" && !Number.isNaN(secs)) return secs;
	const at = window?.reset_at;
	if (typeof at !== "number" || Number.isNaN(at)) return null;
	const atSecs = at > 100_000_000_000 ? at / 1000 : at;
	return Math.max(0, atSecs - Date.now() / 1000);
}

function parseSnapshot(data: CodexUsageResponse, modelId: string | undefined): UsageSnapshot {
	const bucket = isSparkModel(modelId)
		? findSparkBucket(data)
		: normalizeBucket(data.rate_limit);
	return {
		fiveHourLeftPercent: usedToLeft(bucket?.primary_window?.used_percent),
		sevenDayLeftPercent: usedToLeft(bucket?.secondary_window?.used_percent),
		fiveHourResetInSeconds: getResetSeconds(bucket?.primary_window),
		sevenDayResetInSeconds: getResetSeconds(bucket?.secondary_window),
		isLimited: bucket?.limit_reached === true || bucket?.allowed === false,
		stale: false,
	};
}

async function fetchUsage(modelId: string | undefined): Promise<UsageSnapshot> {
	const { accessToken, accountId } = await loadAuth();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(USAGE_URL, {
			headers: {
				accept: "*/*",
				authorization: `Bearer ${accessToken}`,
				"chatgpt-account-id": accountId,
			},
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`Codex usage request failed (${res.status})`);
		const data = (await res.json()) as CodexUsageResponse;
		return parseSnapshot(data, modelId);
	} finally {
		clearTimeout(timer);
	}
}

function applyUI(
	ctx: ExtensionContext,
	snapshot: UsageSnapshot | null,
	settings: PersistedSettings,
	globalVisibility: Visibility | null,
	isCodex: boolean,
): void {
	if (!ctx.hasUI) return;

	const { showBar, displayMode, resetWindow } = settings;
	const visibility = getEffectiveProviderWidgetVisibility(settings.visibility, globalVisibility);

	if (visibility === "hidden" || (visibility === "auto" && !isCodex) || !snapshot) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	ctx.ui.setWidget(WIDGET_KEY, (_tui, widgetTheme) => ({
		render(width: number): string[] {
			const modelId = ctx.model?.id;
			const staleSuffix = snapshot.stale ? ` ${widgetTheme.fg("warning", "(stale)")}` : "";
			const limitTag = snapshot.isLimited ? widgetTheme.fg("error", " [limited]") : "";
			const prefix = widgetTheme.fg("accent", `${getLabel(modelId)} `) + limitTag;

			const resetSecs = resetWindow === "5h" ? snapshot.fiveHourResetInSeconds : snapshot.sevenDayResetInSeconds;
			const resetText = formatCountdown(resetSecs);
			const resetLabel = resetWindow === "5h" ? "5h" : "7d";
			const resetSuffix = resetText ? widgetTheme.fg("dim", ` (${resetLabel}:↺${resetText})`) : "";

			const windows: Array<{ label: string; leftPct: number | null }> = [
				{ label: "5h", leftPct: snapshot.fiveHourLeftPercent },
				{ label: "7d", leftPct: snapshot.sevenDayLeftPercent },
			];

			const parts: string[] = [];
			for (const win of windows) {
				const pctText = colorizePercent(widgetTheme, win.leftPct, displayMode);
				if (showBar && win.leftPct !== null) {
					const usedPct = clampPercent(100 - win.leftPct);
					const barRatio = clamp(usedPct / 100, 0, 1);
					const barWidth = clamp(Math.floor((width - 55) / windows.length), 5, 12);
					const { filled, empty } = bar(barRatio, barWidth);
					const barColor = displayMode === "left" ? colorForLeft(win.leftPct) : colorForUsed(usedPct);
					const barText = widgetTheme.fg(barColor, filled) + widgetTheme.fg("dim", empty);
					parts.push(widgetTheme.fg("muted", `${win.label} `) + barText + " " + pctText);
				} else {
					parts.push(widgetTheme.fg("muted", `${win.label} `) + pctText);
				}
			}

			const line = prefix + " " + parts.join(widgetTheme.fg("dim", " │ ")) + resetSuffix + staleSuffix;
			return [truncateToWidth(line, width)];
		},
		invalidate() {},
	}), { placement: settings.placement });
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
	const filtered = p ? items.filter((i) => i.value.startsWith(p)) : items;
	return filtered.length > 0 ? filtered : null;
}

export default function codexUsageWidget(pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | undefined;
	let latestSnapshot: UsageSnapshot | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let refreshQueued = false;
	let settings: PersistedSettings = { ...DEFAULT_SETTINGS };
	let globalVisibility: Visibility | null = null;
	let settingsWriteQueue: Promise<void> = Promise.resolve();

	const isCodexCtx = (ctx: ExtensionContext) => isCodexModel(ctx.model?.id);

	const persistAll = (ctx: ExtensionContext) => {
		pi.appendEntry(ENTRY_TYPE, { ...settings });
		settingsWriteQueue = settingsWriteQueue
			.catch(() => undefined)
			.then(() => persistSettingsToDisk(settings))
			.catch((err) => {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Codex usage: failed to save settings: ${err instanceof Error ? err.message : String(err)}`,
						"warning",
					);
				}
			});
	};

	const ensureTimer = () => {
		if (refreshTimer) return;
		refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
	};

	const refresh = async (ctx?: ExtensionContext, notifyOnError = false) => {
		if (ctx) latestCtx = ctx;
		if (!latestCtx?.hasUI) return;

		const codex = isCodexCtx(latestCtx);
		const effectiveVisibility = getEffectiveProviderWidgetVisibility(settings.visibility, globalVisibility);

		if (effectiveVisibility === "auto" && !codex) {
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
					latestSnapshot = await fetchUsage(latestCtx.model?.id);
				} catch (err) {
					if (isMissingAuthError(err)) {
						latestSnapshot = null;
						if (latestCtx) applyUI(latestCtx, null, settings, globalVisibility, codex);
						return;
					}
					if (latestSnapshot) {
						latestSnapshot = { ...latestSnapshot, stale: true };
					} else {
						latestSnapshot = null;
					}
					if (notifyOnError && latestCtx) {
						const msg = err instanceof Error ? err.message : String(err);
						latestCtx.ui.notify(`Codex usage refresh failed: ${msg}`, "warning");
					}
				}
				if (latestCtx) applyUI(latestCtx, latestSnapshot, settings, globalVisibility, codex);
			} while (refreshQueued);
		} finally {
			refreshing = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && (entry as any).customType === ENTRY_TYPE) {
				const data = (entry as any).data as PersistedSettings | undefined;
				if (data) settings = normalizeSettings(data);
				break;
			}
		}
		try {
			settings = await loadPersistedSettings();
		} catch {
			// keep whatever we got above
		}
		try {
			globalVisibility = await loadGlobalProviderWidgetVisibility();
		} catch {
			globalVisibility = null;
		}
		ensureTimer();
		await refresh(ctx);
	});

	pi.on("model_select", async (_event, ctx) => { await refresh(ctx); });
	pi.on("turn_end", async (_event, ctx) => { await refresh(ctx); });

	pi.events.on(PROVIDER_WIDGET_VISIBILITY_EVENT, (payload: unknown) => {
		globalVisibility = normalizeProviderWidgetVisibility((payload as { visibility?: unknown } | null)?.visibility);
		if (latestCtx) {
			applyUI(latestCtx, latestSnapshot, settings, globalVisibility, isCodexCtx(latestCtx));
		}
	});

	pi.on("session_shutdown", () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	});

	pi.registerCommand("codex-usage", {
		description: "Cycle Codex usage widget visibility (auto → always → hidden)",
		handler: async (_args, ctx) => {
			const cycle: Visibility[] = ["auto", "always", "hidden"];
			const idx = cycle.indexOf(settings.visibility);
			settings.visibility = cycle[(idx + 1) % cycle.length];
			persistAll(ctx);
			applyUI(ctx, latestSnapshot, settings, globalVisibility, isCodexCtx(ctx));
			ctx.ui.notify(`Codex usage: ${settings.visibility}`, "info");
		},
	});

	pi.registerCommand("codex-usage-bar", {
		description: "Toggle Codex usage progress bars on/off",
		handler: async (_args, ctx) => {
			settings.showBar = !settings.showBar;
			persistAll(ctx);
			applyUI(ctx, latestSnapshot, settings, globalVisibility, isCodexCtx(ctx));
			ctx.ui.notify(`Codex usage bar ${settings.showBar ? "shown" : "hidden"}`, "info");
		},
	});

	pi.registerCommand("codex-usage-mode", {
		description: "Toggle Codex display mode, or set explicitly: left | used",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			const items = [
				{ value: "left", label: "left", description: 'Shows remaining: "81% left"' },
				{ value: "used", label: "used", description: 'Shows consumed: "19% used"' },
				{ value: "toggle", label: "toggle", description: "Flip between left and used" },
			];
			const filtered = p ? items.filter((i) => i.value.startsWith(p)) : items;
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const token = args.trim().toLowerCase().split(/\s+/)[0] ?? "";
			const next: DisplayMode = token === "left" || token === "used"
				? token
				: settings.displayMode === "left" ? "used" : "left";
			settings.displayMode = next;
			persistAll(ctx);
			applyUI(ctx, latestSnapshot, settings, globalVisibility, isCodexCtx(ctx));
			ctx.ui.notify(`Codex usage display: ${next === "left" ? "% left" : "% used"}`, "info");
		},
	});

	pi.registerCommand("codex-usage-reset-window", {
		description: "Toggle Codex reset countdown window: 5h | 7d",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			const items = [
				{ value: "5h", label: "5h", description: "Show 5-hour window countdown" },
				{ value: "7d", label: "7d", description: "Show 7-day window countdown" },
				{ value: "toggle", label: "toggle", description: "Flip between 5h and 7d" },
			];
			const filtered = p ? items.filter((i) => i.value.startsWith(p)) : items;
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const token = args.trim().toLowerCase().split(/\s+/)[0] ?? "";
			const next: ResetWindowMode = token === "5h" || token === "7d"
				? token
				: settings.resetWindow === "7d" ? "5h" : "7d";
			settings.resetWindow = next;
			persistAll(ctx);
			applyUI(ctx, latestSnapshot, settings, globalVisibility, isCodexCtx(ctx));
			ctx.ui.notify(`Codex usage reset window: ${next}`, "info");
		},
	});

	pi.registerCommand("codex-usage-placement", {
		description: "Set Codex widget placement: above | below | toggle",
		getArgumentCompletions: getPlacementCompletions,
		handler: async (args, ctx) => {
			const next = parsePlacementArg(args, settings.placement);
			if (!next) return;
			settings.placement = next;
			persistAll(ctx);
			applyUI(ctx, latestSnapshot, settings, globalVisibility, isCodexCtx(ctx));
			ctx.ui.notify(`Codex widget: ${next === "aboveEditor" ? "above editor" : "below editor"}`, "info");
		},
	});

	pi.registerCommand("codex-usage-refresh", {
		description: "Force-refresh Codex usage from the API",
		handler: async (_args, ctx) => {
			ensureTimer();
			await refresh(ctx, true);
			if (latestSnapshot && !latestSnapshot.stale) {
				const fiveH = latestSnapshot.fiveHourLeftPercent !== null ? `5h: ${Math.round(latestSnapshot.fiveHourLeftPercent)}% left` : "5h: --";
				const sevenD = latestSnapshot.sevenDayLeftPercent !== null ? `7d: ${Math.round(latestSnapshot.sevenDayLeftPercent)}% left` : "7d: --";
				ctx.ui.notify(`Codex usage refreshed — ${fiveH}, ${sevenD}`, "info");
			}
		},
	});
}
