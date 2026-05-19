import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, type Theme } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { execShell, parseNumstat, shellQuote } from "./lib/git.ts";

const STATUS_KEY = "base-diff";
const WIDGET_KEY = "base-diff-widget";
const ENTRY_TYPE = "base-diff-target";
const DEFAULT_BASE_REF_CANDIDATES = [
	"upstream/master",
	"upstream/main",
	"origin/main",
	"origin/master",
] as const;

type TargetMode = "session" | "override";

type PersistedTarget =
	| { mode: "session" }
	| { mode: "override"; repoRoot: string };

type ActiveTarget = {
	mode: TargetMode;
	requestedRepoRoot: string | null;
	repoRoot: string | null;
	label: string | null;
	available: boolean;
};

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
	targetLabel: string | null;
};

type TargetActionResult = {
	message: string;
	level: "info" | "warning";
	activeTarget: ActiveTarget;
};

function normalizePathArg(value: string): string {
	const trimmed = value.trim().replace(/^@/, "");
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	return trimmed;
}

function maybeDirectoryForGitProbe(absolutePath: string): string {
	try {
		if (existsSync(absolutePath) && statSync(absolutePath).isDirectory()) {
			return absolutePath;
		}
	} catch {
		// Fall through to dirname().
	}
	return path.dirname(absolutePath);
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return path.resolve(a) === path.resolve(b);
}

function getTargetLabel(repoRoot: string): string {
	return path.basename(repoRoot) || repoRoot;
}

async function execGitInRepo(pi: ExtensionAPI, repoRoot: string, args: string[], timeout = 4_000) {
	const command = `cd ${shellQuote(repoRoot)} && git ${args.map(shellQuote).join(" ")}`;
	return execShell(pi, command, timeout);
}

async function refExistsInRepo(pi: ExtensionAPI, repoRoot: string, ref: string): Promise<boolean> {
	const result = await execGitInRepo(pi, repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 1_500);
	return result.code === 0;
}

async function detectRemoteHead(pi: ExtensionAPI, repoRoot: string, remote: string): Promise<string | null> {
	const remoteInfo = await execGitInRepo(pi, repoRoot, ["remote", "show", remote], 2_000);
	if (remoteInfo.code !== 0) return null;
	const match = remoteInfo.stdout.match(/HEAD branch:\s*(\S+)/);
	return match?.[1] ? `${remote}/${match[1]}` : null;
}

async function resolveBaseRef(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
	const detected = [await detectRemoteHead(pi, repoRoot, "upstream"), await detectRemoteHead(pi, repoRoot, "origin")].filter(
		(value): value is string => Boolean(value),
	);

	for (const candidate of [...detected, ...DEFAULT_BASE_REF_CANDIDATES]) {
		if (await refExistsInRepo(pi, repoRoot, candidate)) return candidate;
	}
	return null;
}

async function resolveRepoRootFromPath(
	pi: ExtensionAPI,
	cwd: string,
	rawPath: string,
): Promise<{ absolutePath: string; repoRoot: string | null }> {
	const normalized = normalizePathArg(rawPath) || ".";
	const absolutePath = path.resolve(cwd, normalized);
	const probeDir = maybeDirectoryForGitProbe(absolutePath);
	const result = await execShell(pi, `cd ${shellQuote(probeDir)} && git rev-parse --show-toplevel`, 2_000);
	const repoRoot = result.code === 0 ? result.stdout.trim() : null;
	return { absolutePath, repoRoot };
}

async function resolveSessionRepoRoot(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | null> {
	const resolved = await resolveRepoRootFromPath(pi, ctx.cwd, ".");
	return resolved.repoRoot;
}

async function isRepoAvailable(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
	const inRepo = await execGitInRepo(pi, repoRoot, ["rev-parse", "--is-inside-work-tree"], 1_500);
	return inRepo.code === 0 && inRepo.stdout.trim() === "true";
}

async function resolveActiveTarget(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: PersistedTarget,
): Promise<ActiveTarget> {
	if (target.mode === "override") {
		const available = await isRepoAvailable(pi, target.repoRoot);
		return {
			mode: "override",
			requestedRepoRoot: target.repoRoot,
			repoRoot: available ? target.repoRoot : null,
			label: getTargetLabel(target.repoRoot),
			available,
		};
	}

	const repoRoot = await resolveSessionRepoRoot(pi, ctx);
	return {
		mode: "session",
		requestedRepoRoot: repoRoot,
		repoRoot,
		label: null,
		available: Boolean(repoRoot),
	};
}

async function computeStats(pi: ExtensionAPI, target: ActiveTarget): Promise<DiffWidgetStats | null> {
	if (!target.repoRoot) {
		return null;
	}

	const inRepo = await execGitInRepo(pi, target.repoRoot, ["rev-parse", "--is-inside-work-tree"], 1_500);
	if (inRepo.code !== 0 || inRepo.stdout.trim() !== "true") {
		return null;
	}

	const baseRef = await resolveBaseRef(pi, target.repoRoot);

	let base: DiffStats | null = null;
	if (baseRef) {
		const diff = await execGitInRepo(
			pi,
			target.repoRoot,
			["diff", "--numstat", "--find-renames", "--diff-filter=ACDMRTUXB", baseRef],
			4_000,
		);
		if (diff.code === 0) {
			base = parseNumstat(diff.stdout);
		}
	}

	let uncommitted: DiffStats | null = null;
	if (await refExistsInRepo(pi, target.repoRoot, "HEAD")) {
		const diff = await execGitInRepo(
			pi,
			target.repoRoot,
			["diff", "--numstat", "--find-renames", "--diff-filter=ACDMRTUXB", "HEAD"],
			4_000,
		);
		if (diff.code === 0) {
			uncommitted = parseNumstat(diff.stdout);
		}
	}

	return { base, uncommitted, baseRef, targetLabel: target.label };
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
	if (stats.targetLabel) {
		sections.push(theme.fg("accent", `[${stats.targetLabel}]`));
	}
	if (stats.base && stats.baseRef) {
		sections.push(renderDiffStats(theme, stats.base, `vs ${stats.baseRef}`));
	}
	if (stats.uncommitted) {
		sections.push(renderDiffStats(theme, stats.uncommitted, "uncommitted"));
	}
	return sections.join(` ${theme.fg("dim", "·")} `);
}

function renderUnavailableTargetLine(theme: Theme, target: ActiveTarget): string {
	const label = target.label ? theme.fg("accent", `[${target.label}]`) : theme.fg("accent", "[override]");
	return `${label} ${theme.fg("dim", "·")} ${theme.fg("warning", "diff target unavailable")}`;
}

function clearUI(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function applyUI(ctx: ExtensionContext, stats: DiffWidgetStats | null, target: ActiveTarget): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);

	if (target.mode === "override" && !target.available) {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				render(width: number): string[] {
					return [truncateToWidth(renderUnavailableTargetLine(theme, target), width)];
				},
				invalidate() {},
			}),
			{ placement: "belowEditor" },
		);
		return;
	}

	if (!stats || (!stats.base && !stats.uncommitted)) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			render(width: number): string[] {
				return [truncateToWidth(renderWidgetLine(theme, stats), width)];
			},
			invalidate() {},
		}),
		{ placement: "belowEditor" },
	);
}

function loadPersistedTarget(ctx: ExtensionContext): PersistedTarget {
	const entry = [...ctx.sessionManager.getEntries()].reverse().find(
		(item: { type: string; customType?: string }) => item.type === "custom" && item.customType === ENTRY_TYPE,
	) as { data?: unknown } | undefined;

	const data = entry?.data;
	if (!data || typeof data !== "object") {
		return { mode: "session" };
	}

	const persisted = data as { mode?: unknown; repoRoot?: unknown };
	if (persisted.mode === "override" && typeof persisted.repoRoot === "string" && persisted.repoRoot.trim()) {
		return { mode: "override", repoRoot: path.resolve(persisted.repoRoot) };
	}

	return { mode: "session" };
}

function parseTargetCommand(args: string): { action: "show" | "session" | "set"; path?: string } {
	const trimmed = args.trim();
	if (!trimmed) return { action: "show" };

	const normalized = trimmed.toLowerCase();
	if (normalized === "show" || normalized === "status") return { action: "show" };
	if (["session", "reset", "clear", "cwd", "default"].includes(normalized)) {
		return { action: "session" };
	}

	return { action: "set", path: trimmed };
}

function getTargetCommandCompletions(prefix: string) {
	const trimmed = prefix.trim();
	if (trimmed.includes("/") || trimmed.startsWith(".") || trimmed.startsWith("~") || trimmed.startsWith("@")) {
		return null;
	}

	const normalized = trimmed.toLowerCase();
	const items = [
		{ value: "show", label: "show", description: "Show the widget's current repo target" },
		{ value: "session", label: "session", description: "Reset to the session working directory repo" },
		{ value: "reset", label: "reset", description: "Alias for session" },
	];
	const filtered = normalized ? items.filter((item) => item.value.startsWith(normalized)) : items;
	return filtered.length > 0 ? filtered : null;
}

async function describeTarget(pi: ExtensionAPI, ctx: ExtensionContext, target: PersistedTarget): Promise<TargetActionResult> {
	const activeTarget = await resolveActiveTarget(pi, ctx, target);
	if (activeTarget.mode === "override") {
		if (activeTarget.available) {
			return {
				message: `Diff widget target override: ${activeTarget.requestedRepoRoot}`,
				level: "info",
				activeTarget,
			};
		}
		return {
			message: `Diff widget target override is unavailable: ${activeTarget.requestedRepoRoot}`,
			level: "warning",
			activeTarget,
		};
	}

	if (activeTarget.repoRoot) {
		return {
			message: `Diff widget target: session repo ${activeTarget.repoRoot}`,
			level: "info",
			activeTarget,
		};
	}

	return {
		message: "Diff widget target: session working directory (not in a git repo)",
		level: "warning",
		activeTarget,
	};
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let refreshing = false;
	let refreshQueued = false;
	let target: PersistedTarget = { mode: "session" };

	const persistTarget = () => {
		pi.appendEntry(ENTRY_TYPE, target.mode === "override" ? { mode: "override", repoRoot: target.repoRoot } : { mode: "session" });
	};

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
				const activeTarget = await resolveActiveTarget(pi, ctx, target);
				const stats = await computeStats(pi, activeTarget);
				applyUI(ctx, stats, activeTarget);
			} while (refreshQueued);
		} finally {
			refreshing = false;
		}
	};

	const applySessionTarget = async (ctx: ExtensionContext): Promise<TargetActionResult> => {
		target = { mode: "session" };
		persistTarget();
		await refresh(ctx);
		return describeTarget(pi, ctx, target);
	};

	const applyPathTarget = async (rawPath: string, ctx: ExtensionContext): Promise<TargetActionResult> => {
		const resolved = await resolveRepoRootFromPath(pi, ctx.cwd, rawPath);
		if (!resolved.repoRoot) {
			throw new Error(`Diff widget target must be a git repo or a path inside one: ${resolved.absolutePath}`);
		}

		const sessionRepoRoot = await resolveSessionRepoRoot(pi, ctx);
		target = samePath(resolved.repoRoot, sessionRepoRoot)
			? { mode: "session" }
			: { mode: "override", repoRoot: resolved.repoRoot };
		persistTarget();
		await refresh(ctx);
		return describeTarget(pi, ctx, target);
	};

	const triggerRefresh = async (_event: unknown, ctx: ExtensionContext) => {
		await refresh(ctx);
	};

	const onSessionStart = async (_event: unknown, ctx: ExtensionContext) => {
		target = loadPersistedTarget(ctx);
		await refresh(ctx);
	};

	pi.on("session_start", onSessionStart);
	pi.on("session_switch", triggerRefresh);
	pi.on("turn_end", triggerRefresh);
	pi.on("tool_execution_end", triggerRefresh);

	pi.on("before_agent_start", async (event, ctx) => {
		const sessionRepoRoot = await resolveSessionRepoRoot(pi, ctx);
		const activeTarget = await resolveActiveTarget(pi, ctx, target);
		const sessionTargetText = sessionRepoRoot
			? `Session cwd repo: ${sessionRepoRoot}.`
			: "Session cwd is not currently inside a git repo.";
		const widgetTargetText = activeTarget.mode === "override"
			? activeTarget.available
				? `The below-editor diff widget is currently pinned to: ${activeTarget.requestedRepoRoot}.`
				: `The below-editor diff widget is pinned to an unavailable repo target: ${activeTarget.requestedRepoRoot}.`
			: sessionRepoRoot
				? `The below-editor diff widget is currently following the session repo.`
				: "The below-editor diff widget currently has no repo target.";
		return {
			systemPrompt:
				`${event.systemPrompt}\n\n` +
				`Diff widget guidance: ${sessionTargetText} ${widgetTargetText} ` +
				`If you are about to inspect or modify files in a different git repo than the session cwd repo, call diff_footer_path first with any file or directory from that repo so the widget tracks the correct git metadata. ` +
				`Call diff_footer_path with reset=true when you should switch the widget back to the session repo.`,
		};
	});

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

	pi.registerCommand("diff-footer-path", {
		description: "Show, set, or reset the repo path used by the diff widget",
		getArgumentCompletions: getTargetCommandCompletions,
		handler: async (args, ctx) => {
			const command = parseTargetCommand(args);
			try {
				const result = command.action === "show"
					? await describeTarget(pi, ctx, target)
					: command.action === "session"
						? await applySessionTarget(ctx)
						: await applyPathTarget(command.path ?? "", ctx);
				ctx.ui.notify(result.message, result.level);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.registerTool({
		name: "diff_footer_path",
		label: "Diff Footer Path",
		description: "Get or change the repository path used by the below-editor diff widget. Use this when the user wants that widget to track a repo other than the session working directory.",
		promptSnippet: "Get or change the repository path used by the below-editor diff widget.",
		promptGuidelines: [
			"Use diff_footer_path when the user wants the below-editor diff widget to track a different repository or to reset it back to the session working directory.",
			"Use diff_footer_path before editing files in a git repo outside the session cwd repo so the widget follows the correct repository metadata.",
		],
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description: "Absolute or session-relative path to the target repo, or to any file/directory inside that repo. Omit to report the current target.",
				}),
			),
			reset: Type.Optional(
				Type.Boolean({
					description: "Set true to reset the widget back to the session working directory's repository.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = params.reset
				? await applySessionTarget(ctx)
				: params.path?.trim()
					? await applyPathTarget(params.path, ctx)
					: await describeTarget(pi, ctx, target);

			if (ctx.hasUI) {
				ctx.ui.notify(result.message, result.level);
			}

			return {
				content: [{ type: "text", text: result.message }],
				details: {
					mode: result.activeTarget.mode,
					repoRoot: result.activeTarget.requestedRepoRoot,
					available: result.activeTarget.available,
				},
			};
		},
	});
}
