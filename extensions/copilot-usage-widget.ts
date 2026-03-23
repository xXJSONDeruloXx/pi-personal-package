import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const STATUS_KEY = "copilot-usage";
const WIDGET_KEY = "copilot-usage-widget";
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

function parseUsage(stdout: string): UsageState {
	const parsed = JSON.parse(stdout) as CopilotInternalResponse;
	const premium = parsed.quota_snapshots?.premium_interactions;

	if (!premium) {
		throw new Error("Missing premium_interactions quota in /copilot_internal/user response");
	}
	if (premium.unlimited) {
		throw new Error("Premium interactions are unlimited for this account");
	}

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
	if (!result.stdout.trim()) {
		throw new Error("Empty response from gh api /copilot_internal/user");
	}

	return parseUsage(result.stdout);
}

function applyUI(ctx: ExtensionContext, usage: UsageState | null, showBar: boolean): void {
	if (!ctx.hasUI) return;

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
				const overageDetails =
					usage.overageCount > 0
						? ` · ${widgetTheme.fg(color, `+${usage.overageCount} overage`)} ${widgetTheme.fg(usage.overagePermitted ? "warning" : "error", usage.overagePermitted ? "allowed" : "blocked")}`
						: "";
				const details =
					widgetTheme.fg("muted", `${baseDetails}`) +
					overageDetails +
					widgetTheme.fg("muted", ` · reset ${resetText}`);

				if (!showBar) {
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
		{ placement: "belowEditor" },
	);
}

export default function copilotUsageWidget(pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | undefined;
	let latestUsage: UsageState | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let refreshQueued = false;
	let showBar = false;

	const ensureTimer = () => {
		if (refreshTimer) return;
		refreshTimer = setInterval(() => {
			void refresh();
		}, REFRESH_INTERVAL_MS);
	};

	const refresh = async (ctx?: ExtensionContext, notifyOnError = false) => {
		if (ctx) latestCtx = ctx;
		if (!latestCtx?.hasUI) return;

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
					applyUI(latestCtx, latestUsage, showBar);
				}
			} while (refreshQueued);
		} finally {
			refreshing = false;
		}
	};

	const onUiEvent = async (_event: unknown, ctx: ExtensionContext) => {
		ensureTimer();
		await refresh(ctx);
	};

	pi.on("session_start", onUiEvent);
	pi.on("session_switch", onUiEvent);
	pi.on("turn_end", onUiEvent);
	pi.on("model_select", onUiEvent);

	pi.on("session_shutdown", async () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	});

	pi.registerCommand("copilot-usage-bar", {
		description: "Toggle Copilot usage progress bar",
		handler: async (_args, ctx) => {
			showBar = !showBar;
			applyUI(ctx, latestUsage, showBar);
			ctx.ui.notify(`Copilot usage bar ${showBar ? "shown" : "hidden"}`, "info");
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
