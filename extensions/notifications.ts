/**
 * Session/TTS extension.
 *
 * Keeps lightweight local ergonomics:
 * - TTS queue processing on agent_end
 * - Session state tracking to /tmp/claude-sessions/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TTS_QUEUE_DIR = "/tmp/claude-tts-queue";
const SESSIONS_DIR = "/tmp/claude-sessions";

function processTtsQueue() {
	if (!existsSync(TTS_QUEUE_DIR)) return;

	try {
		const files = readdirSync(TTS_QUEUE_DIR).filter((file) => file.endsWith(".txt"));
		for (const file of files) {
			const filepath = join(TTS_QUEUE_DIR, file);
			try {
				const message = readFileSync(filepath, "utf-8").trim();
				unlinkSync(filepath);
				if (message) {
					const aiffPath = filepath.replace(/\.txt$/, ".aiff");
					execSync(
						`say -o "${aiffPath}" "${message.replace(/"/g, '\\"')}" && afplay -v 0.1 "${aiffPath}" && rm -f "${aiffPath}"`,
						{ timeout: 15_000 },
					);
				}
			} catch {
				// Non-fatal.
			}
		}
	} catch {
		// Queue dir may disappear mid-run.
	}
}

function writeSessionStatus(sessionId: string, state: string, cwd: string) {
	try {
		mkdirSync(SESSIONS_DIR, { recursive: true });
		writeFileSync(
			join(SESSIONS_DIR, `pi-${sessionId}.json`),
			JSON.stringify(
				{
					session_id: sessionId,
					cwd,
					source: "pi",
					state,
					last_seen: Math.floor(Date.now() / 1000),
				},
				null,
				2,
			),
		);
	} catch {
		// Non-fatal.
	}
}

export default function (pi: ExtensionAPI) {
	const sessionId = `${Date.now()}`;

	pi.on("session_start", async (_event, ctx) => {
		writeSessionStatus(sessionId, "idle", ctx.cwd || process.cwd());
	});

	pi.on("agent_start", async (_event, ctx) => {
		writeSessionStatus(sessionId, "working", ctx.cwd || process.cwd());
	});

	pi.on("agent_end", async (_event, ctx) => {
		writeSessionStatus(sessionId, "idle", ctx.cwd || process.cwd());
		processTtsQueue();
	});

	pi.registerCommand("tts", {
		description: "Speak a message via TTS",
		handler: async (args, ctx) => {
			const message = args || "Done";
			try {
				execSync(
					`say -o /tmp/pi-tts.aiff "${message.replace(/"/g, '\\"')}" && afplay -v 0.1 /tmp/pi-tts.aiff && rm /tmp/pi-tts.aiff`,
					{ timeout: 15_000 },
				);
				ctx.ui.notify(`Spoke: ${message}`, "info");
			} catch {
				ctx.ui.notify("TTS failed", "error");
			}
		},
	});
}
