import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, type Theme } from "@mariozechner/pi-tui";
import { parseNumstat, refExists } from "./lib/git.ts";

const STATUS_KEY = "base-diff";
const WIDGET_KEY = "base-diff-widget";
const DEFAULT_BASE_REF_CANDIDATES = [
	"upstream/master",
	"upstream/main",
	"origin/main",
	"origin/master",
] as const;

type DiffStats = {
	added: number;
	removed: number;
	files: number;
	binary: number;
};

type DiffWidgetStats = {
	base: DiffStats | null;
	uncommitted: DiffStats | null;
	baseRef: string | null;
};

async function detectRemoteHead(pi: ExtensionAPI, remote: string): Promise<string | null> {
	const remoteInfo = await pi.exec("git", ["remote", "show", remote], { timeout: 2_000 });
	if (remoteInfo.code !== 0) return null;
	const match = remoteInfo.stdout.match(/HEAD branch:\s*(\S+)/);
	return match?.[1] ? `${remote}/${match[1]}` : null;
}

async function resolveBaseRef(pi: ExtensionAPI): Promise<string | null> {
	const detected = [await detectRemoteHead(pi, "upstream"), await detectRemoteHead(pi, "origin")].filter(
		(value): value is string => Boolean(value),
	);

	for (const candidate of [...detected, ...DEFAULT_BASE_REF_CANDIDATES]) {
		if (await refExists(pi, candidate)) return candidate;
	}
	return null;
}

async function computeStats(pi: ExtensionAPI): Promise<DiffWidgetStats | null> {
	const inRepo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 1_500 });
	if (inRepo.code !== 0 || inRepo.stdout.trim() !== "true") {
		return null;
	}

	const baseRef = await resolveBaseRef(pi);

	let base: DiffStats | null = null;
	if (baseRef) {
		const diff = await pi.exec(
			"git",
			["diff", "--numstat", "--find-renames", "--diff-filter=ACDMRTUXB", baseRef],
			{ timeout: 4_000 },
		);
		if (diff.code === 0) {
			base = parseNumstat(diff.stdout);
		}
	}

	let uncommitted: DiffStats | null = null;
	if (await refExists(pi, "HEAD")) {
		const diff = await pi.exec(
			"git",
			["diff", "--numstat", "--find-renames", "--diff-filter=ACDMRTUXB", "HEAD"],
			{ timeout: 4_000 },
		);
		if (diff.code === 0) {
			uncommitted = parseNumstat(diff.stdout);
		}
	}

	return { base, uncommitted, baseRef };
}

function renderDiffStats(theme: Theme, stats: DiffStats, label: string): string {
	const plus = theme.fg("toolDiffAdded", `+${stats.added}`);
	const minus = theme.fg("toolDiffRemoved", `-${stats.removed}`);
	const files = theme.fg("dim", `${stats.files}f`);
	const base = theme.fg("muted", label);
	const binary = stats.binary > 0 ? ` ${theme.fg("dim", `bin:${stats.binary}`)}` : "";
	return `${plus} ${minus} ${files} ${base}${binary}`;
}

function renderWidgetLine(theme: Theme, stats: DiffWidgetStats): string {
	const sections: string[] = [];
	if (stats.base && stats.baseRef) {
		sections.push(renderDiffStats(theme, stats.base, `vs ${stats.baseRef}`));
	}
	if (stats.uncommitted) {
		sections.push(renderDiffStats(theme, stats.uncommitted, "uncommitted"));
	}
	return sections.join(` ${theme.fg("dim", "·")} `);
}

function clearUI(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function applyUI(ctx: ExtensionContext, stats: DiffWidgetStats | null): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);

	if (!stats || (!stats.base && !stats.uncommitted)) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
		render(width: number): string[] {
			return [truncateToWidth(renderWidgetLine(theme, stats), width)];
		},
		invalidate() {},
	}));
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let refreshing = false;
	let refreshQueued = false;

	const refresh = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!enabled) {
			clearUI(ctx);
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
				const stats = await computeStats(pi);
				applyUI(ctx, stats);
			} while (refreshQueued);
		} finally {
			refreshing = false;
		}
	};

	const triggerRefresh = async (_event: unknown, ctx: ExtensionContext) => {
		await refresh(ctx);
	};

	pi.on("session_start", triggerRefresh);
	pi.on("session_switch", triggerRefresh);
	pi.on("turn_end", triggerRefresh);
	pi.on("tool_execution_end", triggerRefresh);

	pi.registerCommand("diff-footer-refresh", {
		description: "Refresh the base-aware diff widget shown above the prompt bar",
		handler: async (_args, ctx) => {
			await refresh(ctx);
			ctx.ui.notify("Diff widget refreshed", "info");
		},
	});

	pi.registerCommand("diff-footer-toggle", {
		description: "Toggle the base-aware diff widget above the prompt bar",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (!enabled) {
				clearUI(ctx);
				ctx.ui.notify("Diff widget hidden", "info");
				return;
			}

			await refresh(ctx);
			ctx.ui.notify("Diff widget shown", "info");
		},
	});
}
