import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type GitExecResult = {
	stdout: string;
	stderr: string;
	code: number;
};

export type DiffStats = {
	added: number;
	removed: number;
	files: number;
	binary: number;
};

export async function execShell(pi: ExtensionAPI, command: string, timeout = 12_000): Promise<GitExecResult> {
	const shell = process.env.SHELL || "/bin/bash";
	const result = await pi.exec(shell, ["-lc", command], { timeout });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		code: result.code ?? 1,
	};
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function trimOutput(text: string, max = 160): string {
	const cleaned = text.replace(/\s+/g, " ").trim();
	if (!cleaned) return "(no output)";
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function parseNumstat(output: string): DiffStats {
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

export async function isGitRepo(pi: ExtensionAPI): Promise<boolean> {
	const inRepo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 1500 });
	return inRepo.code === 0 && inRepo.stdout.trim() === "true";
}

export async function getRepoRoot(pi: ExtensionAPI): Promise<string | null> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 1500 });
	const root = result.stdout.trim();
	return result.code === 0 && root ? root : null;
}

export async function refExists(pi: ExtensionAPI, ref: string): Promise<boolean> {
	const result = await pi.exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
		timeout: 1500,
	});
	return result.code === 0;
}

export async function detectDefaultBranch(pi: ExtensionAPI): Promise<string | null> {
	const remoteInfo = await pi.exec("git", ["remote", "show", "origin"], { timeout: 2000 });
	if (remoteInfo.code === 0) {
		const match = remoteInfo.stdout.match(/HEAD branch:\s*(\S+)/);
		if (match?.[1]) {
			return `origin/${match[1]}`;
		}
	}

	const hasMain = await refExists(pi, "origin/main");
	if (hasMain) return "origin/main";

	const hasMaster = await refExists(pi, "origin/master");
	if (hasMaster) return "origin/master";

	return null;
}

export async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const result = await pi.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { timeout: 1500 });
	const branch = result.stdout.trim();
	return result.code === 0 && branch ? branch : null;
}

export async function getUntrackedFiles(pi: ExtensionAPI): Promise<string[]> {
	const result = await pi.exec("git", ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"], {
		timeout: 4000,
	});
	if (result.code !== 0) return [];
	return result.stdout.split("\u0000").map((file) => file.trim()).filter(Boolean);
}
