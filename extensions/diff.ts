import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, Theme, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	detectDefaultBranch,
	execShell,
	getCurrentBranch,
	getRepoRoot,
	getUntrackedFiles,
	isGitRepo,
	refExists,
	shellQuote,
	trimOutput,
} from "./lib/git.ts";

type DiffMode = "working" | "staged" | "origin" | "stat";

type DiffView = {
	title: string;
	lines: string[];
	body: string;
};

const HEADER = "/DIFF////////////////////////////////////////////////////////////";
const FOOTER_LEGEND = "↑/↓ to scroll   pgup/pgdn to page   home/end to jump   q to quit";

class DiffPager {
	private scrollOffset = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly title: string,
		private readonly lines: string[],
		private readonly done: () => void,
	) {
		this.enterAlternateScreen();
		this.tui.terminal.clearScreen();
		this.tui.requestRender(true);
	}

	handleInput(data: string): void {
		if (data === "q" || data === "Q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done();
			return;
		}

		const pageSize = this.getContentHeight();
		const maxOffset = this.getMaxOffset(pageSize);
		let nextOffset = this.scrollOffset;

		if (matchesKey(data, Key.up) || data === "k") nextOffset -= 1;
		else if (matchesKey(data, Key.down) || data === "j") nextOffset += 1;
		else if (matchesKey(data, Key.pageUp)) nextOffset -= pageSize;
		else if (matchesKey(data, Key.pageDown)) nextOffset += pageSize;
		else if (matchesKey(data, Key.home)) nextOffset = 0;
		else if (matchesKey(data, Key.end)) nextOffset = maxOffset;
		else return;

		this.scrollOffset = Math.max(0, Math.min(maxOffset, nextOffset));
		this.tui.requestRender();
	}

	dispose(): void {
		this.exitAlternateScreen();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const contentHeight = this.getContentHeight();
		const maxOffset = this.getMaxOffset(contentHeight);
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));

		const totalLines = this.lines.length;
		const start = this.scrollOffset;
		const end = Math.min(totalLines, start + contentHeight);
		const visible = this.lines.slice(start, end);
		const percent = maxOffset === 0 ? 100 : Math.round((start / maxOffset) * 100);
		const range = totalLines === 0 ? "0/0" : `${start + 1}-${end}/${totalLines}`;

		const headerLeft = this.theme.fg("accent", this.theme.bold(this.title));
		const headerRight = this.theme.fg("dim", range);
		const footerLeft = this.theme.fg("dim", FOOTER_LEGEND);
		const footerRight = this.theme.fg("dim", `${percent}%`);

		const rendered: string[] = [this.joinLeftRight(headerLeft, headerRight, width)];

		for (const line of visible) {
			rendered.push(truncateToWidth(this.colorizeLine(line), width));
		}

		for (let i = visible.length; i < contentHeight; i++) {
			rendered.push("");
		}

		rendered.push(this.joinLeftRight(footerLeft, footerRight, width));
		return rendered;
	}

	private enterAlternateScreen(): void {
		this.tui.terminal.write("\x1b[?1049h");
	}

	private exitAlternateScreen(): void {
		this.tui.terminal.write("\x1b[?1049l");
	}

	private getContentHeight(): number {
		return Math.max(1, this.tui.terminal.rows - 2);
	}

	private getMaxOffset(contentHeight: number): number {
		return Math.max(0, this.lines.length - contentHeight);
	}

	private joinLeftRight(left: string, right: string, width: number): string {
		const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(left + " ".repeat(pad) + right, width, "", true);
	}

	private colorizeLine(line: string): string {
		if (!line) return "";
		if (/^(Repo:|Branch:|Base:|Note:|Untracked files:)/.test(line)) return this.theme.fg("dim", line);
		if (/^(Failed to generate|Not in a git repository|Unable to locate repo root|Could not detect origin)/.test(line)) {
			return this.theme.fg("warning", line);
		}
		if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename from |rename to |Binary files )/.test(line)) {
			return this.theme.fg("accent", line);
		}
		if (line.startsWith("@@")) return this.theme.fg("toolDiffContext", line);
		if (line.startsWith("+") && !line.startsWith("+++")) return this.theme.fg("toolDiffAdded", line);
		if (line.startsWith("-") && !line.startsWith("---")) return this.theme.fg("toolDiffRemoved", line);
		return line;
	}
}

function getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const items: AutocompleteItem[] = [
		{ value: "staged", label: "staged", description: "Show staged changes only" },
		{ value: "origin", label: "origin", description: "Show current changes against origin default branch" },
		{ value: "stat", label: "stat", description: "Show diff summary against HEAD" },
	];
	const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
	return filtered.length > 0 ? filtered : null;
}

function usageText(invalidArgs?: string): string {
	const lines = [
		HEADER,
		"",
		invalidArgs ? `Invalid /diff arguments: ${invalidArgs}` : "Usage:",
		"  /diff         Show current working tree vs HEAD",
		"  /diff staged  Show staged changes only",
		"  /diff origin  Show current changes vs origin default branch",
		"  /diff stat    Show diff summary vs HEAD",
	];
	return lines.join("\n");
}

function parseMode(args?: string): DiffMode | null {
	const normalized = (args || "").trim().toLowerCase();
	if (!normalized) return "working";
	if (normalized === "staged") return "staged";
	if (normalized === "origin") return "origin";
	if (normalized === "stat") return "stat";
	return null;
}

function renderDocument(title: string, lines: string[], body: string): string {
	const parts = [HEADER, "", title, ...lines];
	const normalizedBody = body.trim();
	if (normalizedBody) {
		parts.push("", normalizedBody);
	} else {
		parts.push("", "No diff.");
	}
	return parts.join("\n");
}

function buildViewerLines(view: DiffView): string[] {
	const lines = [...view.lines];
	const normalizedBody = view.body.trim();
	if (normalizedBody) {
		if (lines.length > 0) lines.push("");
		lines.push(...normalizedBody.split(/\r?\n/));
	} else {
		if (lines.length > 0) lines.push("");
		lines.push("No diff.");
	}
	return lines;
}

async function runGitInRepo(pi: ExtensionAPI, repoRoot: string, args: string[], timeout = 20_000) {
	const command = `cd ${shellQuote(repoRoot)} && git ${args.map(shellQuote).join(" ")}`;
	return execShell(pi, command, timeout);
}

async function buildUntrackedPatch(pi: ExtensionAPI, repoRoot: string): Promise<string> {
	const files = await getUntrackedFiles(pi);
	if (files.length === 0) return "";

	const patches: string[] = [];
	for (const file of files) {
		const result = await runGitInRepo(
			pi,
			repoRoot,
			[
				"--no-pager",
				"diff",
				"--no-index",
				"--no-ext-diff",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				"--",
				"/dev/null",
				file,
			],
			10_000,
		);

		if ((result.code === 0 || result.code === 1) && result.stdout.trim()) {
			patches.push(result.stdout.trimEnd());
			continue;
		}

		patches.push(
			[
				`diff --git a/${file} b/${file}`,
				"new file mode 100644",
				"--- /dev/null",
				`+++ b/${file}`,
				`[Unable to render untracked file diff: ${trimOutput(result.stderr || result.stdout)}]`,
			].join("\n"),
		);
	}

	return patches.join("\n\n");
}

async function buildUntrackedStat(pi: ExtensionAPI): Promise<string> {
	const files = await getUntrackedFiles(pi);
	if (files.length === 0) return "";
	return ["Untracked files:", ...files.map((file) => `  ${file}`)].join("\n");
}

async function buildDiffView(pi: ExtensionAPI, mode: DiffMode): Promise<DiffView> {
	if (!(await isGitRepo(pi))) {
		return {
			title: "Not in a git repository",
			lines: [],
			body: "Run /diff from inside a git work tree.",
		};
	}

	const repoRoot = await getRepoRoot(pi);
	if (!repoRoot) {
		return {
			title: "Unable to locate repo root",
			lines: [],
			body: "`git rev-parse --show-toplevel` did not return a path.",
		};
	}

	const branch = await getCurrentBranch(pi);
	const hasHead = await refExists(pi, "HEAD");
	const lines = [`Repo: ${repoRoot}`, `Branch: ${branch ?? "detached HEAD"}`];

	let title = "Diff";
	let tracked = "";
	let extra = "";

	if (mode === "working") {
		title = hasHead ? "Working tree vs HEAD" : "Working tree vs empty repo";
		if (!hasHead) {
			lines.push("Note: no HEAD commit yet; showing staged changes plus untracked files.");
		}
		const result = await runGitInRepo(
			pi,
			repoRoot,
			hasHead
				? ["--no-pager", "diff", "--no-ext-diff", "--minimal", "--patch", "HEAD"]
				: ["--no-pager", "diff", "--no-ext-diff", "--minimal", "--patch", "--cached"],
			20_000,
		);
		if (result.code !== 0) {
			return {
				title,
				lines,
				body: `Failed to generate diff: ${trimOutput(result.stderr || result.stdout)}`,
			};
		}
		tracked = result.stdout.trimEnd();
		extra = await buildUntrackedPatch(pi, repoRoot);
	}

	if (mode === "staged") {
		title = hasHead ? "Staged changes vs HEAD" : "Staged changes vs empty repo";
		const result = await runGitInRepo(
			pi,
			repoRoot,
			["--no-pager", "diff", "--no-ext-diff", "--minimal", "--patch", "--cached"],
			20_000,
		);
		if (result.code !== 0) {
			return {
				title,
				lines,
				body: `Failed to generate staged diff: ${trimOutput(result.stderr || result.stdout)}`,
			};
		}
		tracked = result.stdout.trimEnd();
	}

	if (mode === "origin") {
		const baseRef = await detectDefaultBranch(pi);
		if (!baseRef) {
			return {
				title: "Origin diff unavailable",
				lines,
				body: "Could not detect origin's default branch.",
			};
		}
		title = `Working tree vs ${baseRef}`;
		lines.push(`Base: ${baseRef}`);
		const result = await runGitInRepo(
			pi,
			repoRoot,
			["--no-pager", "diff", "--no-ext-diff", "--minimal", "--patch", baseRef],
			25_000,
		);
		if (result.code !== 0) {
			return {
				title,
				lines,
				body: `Failed to generate origin diff: ${trimOutput(result.stderr || result.stdout)}`,
			};
		}
		tracked = result.stdout.trimEnd();
		extra = await buildUntrackedPatch(pi, repoRoot);
	}

	if (mode === "stat") {
		title = hasHead ? "Diff summary vs HEAD" : "Diff summary vs empty repo";
		if (!hasHead) {
			lines.push("Note: no HEAD commit yet; showing staged summary plus untracked files.");
		}
		const result = await runGitInRepo(
			pi,
			repoRoot,
			hasHead
				? ["--no-pager", "diff", "--no-ext-diff", "--stat", "HEAD"]
				: ["--no-pager", "diff", "--no-ext-diff", "--stat", "--cached"],
			20_000,
		);
		if (result.code !== 0) {
			return {
				title,
				lines,
				body: `Failed to generate diff summary: ${trimOutput(result.stderr || result.stdout)}`,
			};
		}
		tracked = result.stdout.trimEnd();
		extra = await buildUntrackedStat(pi);
	}

	const body = [tracked, extra].filter((section) => section.trim().length > 0).join("\n\n");
	return { title, lines, body };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("diff", {
		description: "Show a git diff for the working tree, staged changes, or origin base",
		getArgumentCompletions,
		handler: async (args, ctx) => {
			const mode = parseMode(args);
			if (!mode) {
				const text = usageText(args);
				if (ctx.hasUI) {
					ctx.ui.setEditorText(text);
					ctx.ui.notify("Invalid /diff arguments", "warn");
				} else {
					console.log(text);
				}
				return;
			}

			const view = await buildDiffView(pi, mode);
			if (ctx.hasUI) {
				const viewerLines = buildViewerLines(view);
				await ctx.ui.custom<void>((tui, theme, _kb, done) => new DiffPager(tui, theme, view.title, viewerLines, done));
				return;
			}

			const finalText = renderDocument(view.title, view.lines, view.body);
			console.log(finalText);
		},
	});
}
