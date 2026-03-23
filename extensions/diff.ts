import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, Theme } from "@mariozechner/pi-tui";
import { Box, Text } from "@mariozechner/pi-tui";
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
const DIFF_MESSAGE_TYPE = "diff-view";

function colorizeLine(theme: Theme, line: string): string {
	if (!line) return "";
	if (line === HEADER) return theme.fg("accent", theme.bold(line));
	if (/^(Repo:|Branch:|Base:|Note:|Untracked files:)/.test(line)) return theme.fg("dim", line);
	if (/^(Failed to generate|Not in a git repository|Unable to locate repo root|Could not detect origin)/.test(line)) {
		return theme.fg("warning", line);
	}
	if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename from |rename to |Binary files )/.test(line)) {
		return theme.fg("accent", line);
	}
	if (line.startsWith("@@")) return theme.fg("toolDiffContext", line);
	if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
	if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
	return line;
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
	return [HEADER, "", view.title, ...lines];
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
	pi.registerMessageRenderer(DIFF_MESSAGE_TYPE, (message, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const colored = message.content
			.split(/\r?\n/)
			.map((line) => colorizeLine(theme, line))
			.join("\n");
		box.addChild(new Text(colored, 0, 0));
		return box;
	});

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
			const finalText = renderDocument(view.title, view.lines, view.body);

			if (ctx.hasUI) {
				pi.sendMessage({
					customType: DIFF_MESSAGE_TYPE,
					content: buildViewerLines(view).join("\n"),
					display: true,
					details: { mode, title: view.title },
				});
				return;
			}

			console.log(finalText);
		},
	});
}
