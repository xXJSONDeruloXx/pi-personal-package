import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const STATUS_KEY = "zai-usage";
const WIDGET_KEY = "zai-usage-widget";
const ENTRY_TYPE = "zai-usage-settings";
const SETTINGS_FILE = path.join(
	process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent"),
	"settings.json",
);
const SETTINGS_KEY = "pi-zai-usage";
const REFRESH_INTERVAL_MS = 90_000; // 1.5 min — 5hr window moves fast
const FETCH_TIMEOUT_SECS = "8";

// ── Z.ai quota API response types ──────────────────────────────────────────

type UsageDetail = { modelCode: string; usage: number };

type QuotaLimit =
	| {
			type: "TIME_LIMIT";
			unit: number;
			number: number;
			usage: number;
			currentValue: number;
			remaining: number;
			percentage: number;
			nextResetTime: number;
			usageDetails: UsageDetail[];
	  }
	| {
			type: "TOKENS_LIMIT";
			unit: number;
			number: number;
			percentage: number;
			nextResetTime: number;
	  };

type QuotaResponse = {
	code: number;
	msg: string;
	data: {
		limits: QuotaLimit[];
		level: string;
	};
	success: boolean;
};

// ── Parsed state ───────────────────────────────────────────────────────────

type WindowState = {
	percentUsed: number;
	resetAt: number;
	label: string;
};

type UsageState = {
	windows: WindowState[];
	level: string;
	updatedAt: number;
	stale: boolean;
};

// ── Persisted settings ─────────────────────────────────────────────────────

type Visibility = "auto" | "always" | "hidden";
type DisplayMode = "left" | "used";

type PersistedSettings = {
	visibility: Visibility;
	showBar: boolean;
	showCountdown: boolean;
	displayMode: DisplayMode;
};

const DEFAULT_SETTINGS: PersistedSettings = {
	visibility: "auto",
	showBar: true,
	showCountdown: true,
	displayMode: "left",
};

// ── Helpers ────────────────────────────────────────────────────────────────

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

/** Color based on how much is remaining */
function remainingColor(percentRemaining: number): "success" | "warning" | "error" {
	if (percentRemaining <= 15) return "error";
	if (percentRemaining <= 45) return "warning";
	return "success";
}

/** Color based on how much is used */
function usedColor(percentUsed: number): "success" | "warning" | "error" {
	if (percentUsed >= 85) return "error";
	if (percentUsed >= 55) return "warning";
	return "success";
}

/** Format remaining time: "4h 32m", "23m", "6d 5h" */
function formatCountdown(resetAt: number): string {
	let secs = Math.max(0, Math.floor((resetAt - Date.now()) / 1000));
	if (secs <= 0) return "now";

	const days = Math.floor(secs / 86400);
	secs %= 86400;
	const hours = Math.floor(secs / 3600);
	secs %= 3600;
	const mins = Math.floor(secs / 60);

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0 || days > 0) parts.push(`${hours}h`);
	if (days === 0) parts.push(`${mins}m`);
	return parts.join(" ");
}

/** Map unit codes to labels. Observed: unit=3 → 5h, unit=6 → weekly */
function windowLabel(limit: QuotaLimit): string {
	if (limit.type === "TIME_LIMIT") return "Tools";
	if (limit.unit === 3) return "5h";
	if (limit.unit === 6) return "Weekly";
	return `${limit.unit}/${limit.number}`;
}

/** Format a window's percent with label based on display mode */
function formatPercent(
	theme: { fg: (color: string, text: string) => string },
	percentUsed: number,
	mode: DisplayMode,
): string {
	const percentRemaining = clamp(100 - percentUsed, 0, 100);
	const rounded = Math.round(mode === "left" ? percentRemaining : percentUsed);

	if (mode === "left") {
		const color = remainingColor(percentRemaining);
		return theme.fg(color, `${rounded}% left`);
	} else {
		const color = usedColor(percentUsed);
		return theme.fg(color, `${rounded}% used`);
	}
}

// ── Settings persistence (settings.json) ───────────────────────────────────

async function readSettings(): Promise<Record<string, unknown>> {
	try {
		const raw = await fs.readFile(SETTINGS_FILE, "utf8");
		const parsed = JSON.parse(raw);
		return (typeof parsed === "object" && parsed && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : {};
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
		visibility: s.visibility === "always" || s.visibility === "auto" || s.visibility === "hidden"
			? s.visibility
			: DEFAULT_SETTINGS.visibility,
		showBar: s.showBar ?? DEFAULT_SETTINGS.showBar,
		showCountdown: s.showCountdown ?? DEFAULT_SETTINGS.showCountdown,
		displayMode: s.displayMode === "left" || s.displayMode === "used"
			? s.displayMode
			: DEFAULT_SETTINGS.displayMode,
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

// ── API fetch ──────────────────────────────────────────────────────────────

async function fetchUsage(pi: ExtensionAPI, apiKey: string): Promise<UsageState> {
	const result = await pi.exec("curl", [
		"-s",
		"-H",
		`Authorization: Bearer ${apiKey}`,
		"--max-time",
		FETCH_TIMEOUT_SECS,
		"https://api.z.ai/api/monitor/usage/quota/limit",
	]);

	if (result.code !== 0) {
		throw new Error((result.stderr || result.stdout || "curl failed").trim());
	}

	const parsed = JSON.parse(result.stdout) as QuotaResponse;

	if (!parsed.success || parsed.code !== 200) {
		throw new Error(parsed.msg || "API returned non-success");
	}

	const windows: WindowState[] = [];

	for (const limit of parsed.data.limits) {
		if (limit.type === "TOKENS_LIMIT" && (limit.unit === 3 || limit.unit === 6)) {
			windows.push({
				percentUsed: limit.percentage,
				resetAt: limit.nextResetTime,
				label: windowLabel(limit),
			});
		}
	}

	// Sort: 5h first, then weekly
	windows.sort((a, b) => a.resetAt - b.resetAt);

	return {
		windows,
		level: parsed.data.level,
		updatedAt: Date.now(),
		stale: false,
	};
}

// ── UI rendering ───────────────────────────────────────────────────────────

function applyUI(
	ctx: ExtensionContext,
	usage: UsageState | null,
	settings: PersistedSettings,
	isZaiProvider: boolean,
): void {
	if (!ctx.hasUI) return;

	if (settings.visibility === "hidden") {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	if (settings.visibility === "auto" && !isZaiProvider) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	if (!usage) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, undefined);

	ctx.ui.setWidget(WIDGET_KEY, (_tui, widgetTheme) => ({
		render(width: number): string[] {
			const staleSuffix = usage.stale ? ` ${widgetTheme.fg("warning", "(stale)")}` : "";
			const levelTag = widgetTheme.fg("dim", `[${usage.level}]`);
			const prefix = widgetTheme.fg("accent", "Z.ai ") + levelTag + " ";

			if (usage.windows.length === 0) {
				return [truncateToWidth(prefix + widgetTheme.fg("muted", "No quota windows found") + staleSuffix, width)];
			}

			const parts: string[] = [];

			for (const win of usage.windows) {
				const pctText = formatPercent(widgetTheme, win.percentUsed, settings.displayMode);
				const countdown = settings.showCountdown ? ` ${widgetTheme.fg("dim", formatCountdown(win.resetAt))}` : "";

				if (settings.showBar) {
					// Bar always fills as usage increases
					const barRatio = clamp(win.percentUsed / 100, 0, 1);
					const barWidth = clamp(Math.floor((width - 50) / usage.windows.length), 6, 14);
					const { filled, empty } = bar(barRatio, barWidth);
					// Color the bar based on what we're displaying
					const percentRemaining = clamp(100 - win.percentUsed, 0, 100);
					const barColor = settings.displayMode === "left"
						? remainingColor(percentRemaining)
						: usedColor(win.percentUsed);
					const barText = widgetTheme.fg(barColor, filled) + widgetTheme.fg("dim", empty);

					parts.push(
						widgetTheme.fg("muted", `${win.label} `) +
						barText + " " +
						pctText +
						countdown,
					);
				} else {
					parts.push(
						widgetTheme.fg("muted", `${win.label} `) +
						pctText +
						countdown,
					);
				}
			}

			const line = prefix + parts.join(widgetTheme.fg("dim", " │ ")) + staleSuffix;
			return [truncateToWidth(line, width)];
		},
		invalidate() {},
	}));
}

// ── Command argument helpers ───────────────────────────────────────────────

function parseModeArg(args: string, current: DisplayMode): DisplayMode | null {
	const token = args.trim().toLowerCase().split(/\s+/)[0] ?? "";
	if (!token || token === "toggle") return current === "left" ? "used" : "left";
	if (token === "left" || token === "used") return token;
	return null;
}

function getModeCompletions(prefix: string) {
	const p = prefix.trim().toLowerCase();
	const items = [
		{ value: "left", label: "left", description: 'Shows remaining: "49% left"' },
		{ value: "used", label: "used", description: 'Shows consumed: "51% used"' },
		{ value: "toggle", label: "toggle", description: "Flip between left and used" },
	];
	if (!p) return items;
	const filtered = items.filter((i) => i.value.startsWith(p));
	return filtered.length > 0 ? filtered : null;
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function zaiUsageWidget(pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | undefined;
	let latestUsage: UsageState | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let refreshQueued = false;
	let settings: PersistedSettings = { ...DEFAULT_SETTINGS };
	let apiKey: string | undefined;
	let settingsWriteQueue: Promise<void> = Promise.resolve();

	const isZaiProvider = (ctx: ExtensionContext): boolean => {
		try {
			return ctx.model?.provider === "zai";
		} catch {
			return false;
		}
	};

	const queuePersist = (ctx: ExtensionContext) => {
		settingsWriteQueue = settingsWriteQueue
			.catch(() => undefined)
			.then(() => persistSettingsToDisk(settings))
			.catch((error) => {
				if (!ctx.hasUI) return;
				ctx.ui.notify(`Z.ai usage: failed to save settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
	};

	/** Also persist via appendEntry so reload within the same session picks it up */
	const persistAll = (ctx: ExtensionContext) => {
		pi.appendEntry(ENTRY_TYPE, { ...settings });
		queuePersist(ctx);
	};

	const ensureTimer = () => {
		if (refreshTimer) return;
		refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
	};

	const refresh = async (ctx?: ExtensionContext, notifyOnError = false) => {
		if (ctx) latestCtx = ctx;
		if (!latestCtx?.hasUI) return;

		const providerIsZai = isZaiProvider(latestCtx);

		if (settings.visibility === "auto" && !providerIsZai) {
			applyUI(latestCtx, null, settings, false);
			return;
		}

		if (!apiKey) {
			apiKey = process.env.ZAI_API_KEY;
			if (!apiKey) {
				if (notifyOnError) latestCtx.ui.notify("Z.ai usage: ZAI_API_KEY not set", "warning");
				return;
			}
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
					latestUsage = await fetchUsage(pi, apiKey);
				} catch (error) {
					if (latestUsage) {
						latestUsage = { ...latestUsage, stale: true };
					} else {
						latestUsage = null;
					}
					if (notifyOnError && latestCtx) {
						const message = error instanceof Error ? error.message : String(error);
						latestCtx.ui.notify(`Z.ai usage refresh failed: ${message}`, "warning");
					}
				}
				if (latestCtx) {
					applyUI(latestCtx, latestUsage, settings, providerIsZai);
				}
			} while (refreshQueued);
		} finally {
			refreshing = false;
		}
	};

	const onSessionStart = async (_event: unknown, ctx: ExtensionContext) => {
		// Restore from session entries first (covers /reload)
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (
				entry.type === "custom" &&
				"customType" in entry &&
				(entry as any).customType === ENTRY_TYPE
			) {
				const data = (entry as any).data as PersistedSettings | undefined;
				if (data) settings = normalizePersistedSettings(data);
				break;
			}
		}

		// Then try settings.json (authoritative across sessions)
		try {
			settings = await loadPersistedSettings();
		} catch {
			// Keep whatever we got from session entries or defaults
		}

		ensureTimer();
		await refresh(ctx);
	};

	pi.on("session_start", onSessionStart);
	pi.on("model_select", async (_event, ctx) => { await refresh(ctx); });
	pi.on("turn_end", async (_event, ctx) => { await refresh(ctx); });

	pi.on("session_shutdown", () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	});

	// ── Commands ────────────────────────────────────────────────────────

	pi.registerCommand("zai-usage", {
		description: "Cycle Z.ai usage widget visibility (auto → always → hidden)",
		handler: async (_args, ctx) => {
			const cycle: Visibility[] = ["auto", "always", "hidden"];
			const idx = cycle.indexOf(settings.visibility);
			settings.visibility = cycle[(idx + 1) % cycle.length];
			persistAll(ctx);
			const providerIsZai = isZaiProvider(ctx);
			applyUI(ctx, latestUsage, settings, providerIsZai);
			ctx.ui.notify(`Z.ai usage: ${settings.visibility}`, "info");
		},
	});

	pi.registerCommand("zai-usage-bar", {
		description: "Toggle Z.ai usage progress bars on/off",
		handler: async (_args, ctx) => {
			settings.showBar = !settings.showBar;
			persistAll(ctx);
			const providerIsZai = isZaiProvider(ctx);
			applyUI(ctx, latestUsage, settings, providerIsZai);
			ctx.ui.notify(`Z.ai usage bar ${settings.showBar ? "shown" : "hidden"}`, "info");
		},
	});

	pi.registerCommand("zai-usage-countdown", {
		description: "Toggle Z.ai usage countdown timers on/off",
		handler: async (_args, ctx) => {
			settings.showCountdown = !settings.showCountdown;
			persistAll(ctx);
			const providerIsZai = isZaiProvider(ctx);
			applyUI(ctx, latestUsage, settings, providerIsZai);
			ctx.ui.notify(`Z.ai countdown ${settings.showCountdown ? "shown" : "hidden"}`, "info");
		},
	});

	pi.registerCommand("zai-usage-mode", {
		description: "Toggle Z.ai display mode, or set it explicitly: left | used",
		getArgumentCompletions: getModeCompletions,
		handler: async (args, ctx) => {
			const nextMode = parseModeArg(args, settings.displayMode);
			if (!nextMode) return;
			settings.displayMode = nextMode;
			persistAll(ctx);
			const providerIsZai = isZaiProvider(ctx);
			applyUI(ctx, latestUsage, settings, providerIsZai);
			ctx.ui.notify(`Z.ai display: ${nextMode === "left" ? "% left" : "% used"}`, "info");
		},
	});

	pi.registerCommand("zai-usage-refresh", {
		description: "Force-refresh Z.ai quota usage from the API",
		handler: async (_args, ctx) => {
			ensureTimer();
			await refresh(ctx, true);
			if (latestUsage && !latestUsage.stale) {
				const summary = latestUsage.windows
					.map((w) => {
						const pct = settings.displayMode === "left"
							? `${Math.round(clamp(100 - w.percentUsed, 0, 100))}% left`
							: `${Math.round(w.percentUsed)}% used`;
						return `${w.label}: ${pct}`;
					})
					.join(", ");
				ctx.ui.notify(`Z.ai usage refreshed — ${summary} [${latestUsage.level}]`, "info");
			}
		},
	});
}
