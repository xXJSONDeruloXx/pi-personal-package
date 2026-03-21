import type { ExtensionAPI, ExtensionContext, ToolExecutionEndEvent } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "git-diff";
const BASE_REF_CANDIDATES = ["upstream/master", "upstream/main", "origin/master", "origin/main"] as const;
const POLL_INTERVAL_MS = 5000;

export default function (pi: ExtensionAPI) {
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let updating = false;

	const parseNumstat = (stdout: string): { added: number; removed: number } => {
		let added = 0;
		let removed = 0;

		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			const [a, r] = line.split("\t");
			const addNum = Number.parseInt(a ?? "", 10);
			const remNum = Number.parseInt(r ?? "", 10);
			if (Number.isFinite(addNum)) added += addNum;
			if (Number.isFinite(remNum)) removed += remNum;
		}

		return { added, removed };
	};

	const resolveBaseRef = async () => {
		for (const candidate of BASE_REF_CANDIDATES) {
			const exists = await pi.exec("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
				timeout: 1500,
			});
			if (exists.code === 0) return candidate;
		}
		return null;
	};

	const refreshStatus = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI || updating) return;
		updating = true;
		try {
			const inRepo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.cwd });
			if (inRepo.code !== 0 || inRepo.stdout.trim() !== "true") {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}

			const baseRef = await resolveBaseRef();
			if (!baseRef) {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "Δ n/a (no upstream/origin main/master)"));
				return;
			}

			const mergeBase = await pi.exec("git", ["merge-base", baseRef, "HEAD"], { cwd: ctx.cwd });
			if (mergeBase.code !== 0) {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `Δ n/a (${baseRef} unavailable)`));
				return;
			}

			const base = mergeBase.stdout.trim();
			const numstat = await pi.exec("git", ["diff", "--numstat", base], { cwd: ctx.cwd });
			if (numstat.code !== 0) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}

			const { added, removed } = parseNumstat(numstat.stdout);

			let aheadBehindText = "";
			const aheadBehind = await pi.exec("git", ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`], {
				cwd: ctx.cwd,
			});
			if (aheadBehind.code === 0) {
				const [behindRaw, aheadRaw] = aheadBehind.stdout.trim().split(/\s+/);
				const behind = Number.parseInt(behindRaw ?? "", 10);
				const ahead = Number.parseInt(aheadRaw ?? "", 10);
				if (Number.isFinite(behind) && Number.isFinite(ahead)) {
					aheadBehindText = ` ${ctx.ui.theme.fg("dim", `↑${ahead}↓${behind}`)}`;
				}
			}

			const status = [
				ctx.ui.theme.fg("dim", "Δ"),
				ctx.ui.theme.fg("success", `+${added}`),
				ctx.ui.theme.fg("error", `-${removed}`),
				ctx.ui.theme.fg("dim", `(${baseRef})`),
			].join(" ") + aheadBehindText;

			ctx.ui.setStatus(STATUS_KEY, status);
		} catch {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} finally {
			updating = false;
		}
	};

	const startPolling = (ctx: ExtensionContext) => {
		if (pollTimer) clearInterval(pollTimer);
		void refreshStatus(ctx);
		pollTimer = setInterval(() => {
			void refreshStatus(ctx);
		}, POLL_INTERVAL_MS);
	};

	const stopPolling = (ctx: ExtensionContext) => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		startPolling(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		void refreshStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		void refreshStatus(ctx);
	});

	pi.on("tool_execution_end", async (event: ToolExecutionEndEvent, ctx) => {
		if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "bash") {
			void refreshStatus(ctx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopPolling(ctx);
	});
}
