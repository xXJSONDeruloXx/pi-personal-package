import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const UPSTREAM_STATUS_KEY = "upstream-master-diff-upstream";
const UNCOMMITTED_STATUS_KEY = "upstream-master-diff-uncommitted";
const DIFF_WIDGET_KEY = "upstream-master-diff-widget";
const BASE_REF_CANDIDATES = ["upstream/master", "upstream/main", "origin/master", "origin/main"] as const;

type DiffStats = {
	added: number;
	removed: number;
	files: number;
	binary: number;
};

type FooterStats = {
	upstream: DiffStats | null;
	uncommitted: DiffStats | null;
	baseRef: string | null;
};

function parseNumstat(output: string): DiffStats {
	const stats: DiffStats = { added: 0, removed: 0, files: 0, binary: 0 };
	const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
	for (const line of lines) {
		const [addedRaw = "", removedRaw = ""] = line.split("\t", 3);
		const added = Number.parseInt(addedRaw, 10);
		const removed = Number.parseInt(removedRaw, 10);

		if (Number.isFinite(added)) stats.added += added;
		if (Number.isFinite(removed)) stats.removed += removed;
		if (!Number.isFinite(added) || !Number.isFinite(removed)) stats.binary += 1;
		stats.files += 1;
	}
	return stats;
}

async function resolveBaseRef(pi: ExtensionAPI): Promise<string | null> {
	for (const candidate of BASE_REF_CANDIDATES) {
		const hasBase = await pi.exec("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
			timeout: 1500,
		});
		if (hasBase.code === 0) {
			return candidate;
		}
	}
	return null;
}

async function computeStats(pi: ExtensionAPI): Promise<FooterStats | null> {
	const inRepo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 1500 });
	if (inRepo.code !== 0 || inRepo.stdout.trim() !== "true") {
		return null;
	}

	const baseRef = await resolveBaseRef(pi);

	let upstream: DiffStats | null = null;
	if (baseRef) {
		const diff = await pi.exec(
			"git",
			["diff", "--numstat", "--find-renames", "--diff-filter=ACDMRTUXB", baseRef],
			{ timeout: 4000 },
		);
		if (diff.code === 0) {
			upstream = parseNumstat(diff.stdout);
		}
	}

	let uncommitted: DiffStats | null = null;
	const head = await pi.exec("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
		timeout: 1500,
	});
	if (head.code === 0) {
		const diff = await pi.exec(
			"git",
			["diff", "--numstat", "--find-renames", "--diff-filter=ACDMRTUXB", "HEAD"],
			{ timeout: 4000 },
		);
		if (diff.code === 0) {
			uncommitted = parseNumstat(diff.stdout);
		}
	}

	return { upstream, uncommitted, baseRef };
}

function renderDiffStats(ctx: ExtensionContext, stats: DiffStats, label: string): string {
	const theme = ctx.ui.theme;
	const base = theme.fg("muted", `${label}:`);
	const plus = theme.fg("toolDiffAdded", `+${stats.added}`);
	const minus = theme.fg("toolDiffRemoved", `-${stats.removed}`);
	const files = theme.fg("dim", `${stats.files}f`);
	const binary = stats.binary > 0 ? ` ${theme.fg("dim", `bin:${stats.binary}`)}` : "";
	return `${base} ${plus} ${minus} ${files}${binary}`;
}

function setStatuses(ctx: ExtensionContext, stats: FooterStats | null): void {
	ctx.ui.setStatus(UPSTREAM_STATUS_KEY, undefined);
	ctx.ui.setStatus(UNCOMMITTED_STATUS_KEY, undefined);

	if (!stats) {
		ctx.ui.setWidget(DIFF_WIDGET_KEY, undefined);
		return;
	}

	const lines = [
		stats.upstream && stats.baseRef ? renderDiffStats(ctx, stats.upstream, stats.baseRef) : undefined,
		stats.uncommitted ? renderDiffStats(ctx, stats.uncommitted, "uncommitted") : undefined,
	].filter((line): line is string => Boolean(line));

	ctx.ui.setWidget(DIFF_WIDGET_KEY, lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
}

export default function (pi: ExtensionAPI) {
	let refreshing = false;
	let refreshQueued = false;

	const refresh = async (ctx: ExtensionContext): Promise<FooterStats | null> => {
		if (!ctx.hasUI) return null;

		if (refreshing) {
			refreshQueued = true;
			return null;
		}

		refreshing = true;
		let latestStats: FooterStats | null = null;
		try {
			do {
				refreshQueued = false;
				const stats = await computeStats(pi);
				latestStats = stats && (stats.upstream || stats.uncommitted) ? stats : null;
				setStatuses(ctx, latestStats);
			} while (refreshQueued);
		} finally {
			refreshing = false;
		}
		return latestStats;
	};

	const triggerRefresh = async (_event: unknown, ctx: ExtensionContext) => {
		await refresh(ctx);
	};

	pi.on("session_start", triggerRefresh);
	pi.on("session_switch", triggerRefresh);
	pi.on("turn_end", triggerRefresh);
	pi.on("tool_execution_end", triggerRefresh);

	pi.registerCommand("diff-footer-refresh", {
		description: `Refresh diff widget against ${BASE_REF_CANDIDATES.join(" / ")} and uncommitted changes`,
		handler: async (_args, ctx) => {
			const stats = await refresh(ctx);
			if (!stats) {
				ctx.ui.notify("Diff widget refreshed. No git repo or no changes detected.", "info");
				return;
			}

			const baseMessage = stats.baseRef
				? `against ${stats.baseRef}`
				: `without an upstream/origin base ref (${BASE_REF_CANDIDATES.join(", ")})`;
			ctx.ui.notify(`Diff widget refreshed ${baseMessage} and uncommitted changes`, "info");
		},
	});
}
