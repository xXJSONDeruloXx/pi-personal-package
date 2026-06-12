/**
 * Auto-title + tab-status extension.
 *
 * Combines two responsibilities:
 *  1. Generates a short session title via LLM (or heuristic) after each agent
 *     turn and sets it as the session name + terminal tab title.
 *  2. Shows live traffic-light circles in front of the π — 🟢 / 🟡 / 🔴.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const LOG = "/tmp/auto-title-debug.log";
function log(msg: string) {
	fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
}

const GIT_COMMIT_RE = /\bgit\b[^\n]*\bcommit\b/;
const JIRA_TICKET_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
const INACTIVE_TIMEOUT_MS = 180_000;
const nativeClearTimeout = globalThis.clearTimeout;

export default function (pi: ExtensionAPI) {
	let titleSet = false;
	let lastTitle = "";
	let sawCommit = false;
	let lastStopError = false;
	let agentRunning = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	log("=== Extension loaded ===");

	const buildTitle = (cwdBase: string, emoji: string, name?: string): string =>
		name ? `${emoji} π - ${name}` : `${emoji} π - ${cwdBase}`;

	const clearTabTimeout = (): void => {
		if (timeoutId === undefined) return;
		nativeClearTimeout(timeoutId);
		timeoutId = undefined;
	};

	const resetTimeout = (ui: ExtensionContext["ui"], cwdBase: string): void => {
		clearTabTimeout();
		timeoutId = setTimeout(() => {
			if (agentRunning) {
				ui.setTitle(buildTitle(cwdBase, "🔴", lastTitle || undefined));
				log("activity timeout → 🛑");
			}
		}, INACTIVE_TIMEOUT_MS);
	};

	const markActivity = (ui: ExtensionContext["ui"], cwdBase: string): void => {
		if (agentRunning) resetTimeout(ui, cwdBase);
	};

	pi.on("session_start", async (_event, ctx) => {
		const existing = pi.getSessionName();
		log(`session_start: existing name = ${JSON.stringify(existing)}`);
		agentRunning = false;
		sawCommit = false;
		clearTabTimeout();
		if (existing) {
			titleSet = true;
			lastTitle = existing;
		} else {
			titleSet = false;
			lastTitle = "";
		}
		const cwdBase = path.basename(ctx.cwd || "pi");
		ctx.ui.setTitle(buildTitle(cwdBase, "🟡", lastTitle || undefined));
	});

	pi.on("session_switch", async (event: any, ctx) => {
		const existing = pi.getSessionName();
		agentRunning = false;
		sawCommit = false;
		clearTabTimeout();
		lastTitle = existing || "";
		titleSet = !!existing;
		const cwdBase = path.basename(ctx.cwd || "pi");
		const emoji = event?.reason === "new" ? "🟡" : "🟡";
		ctx.ui.setTitle(buildTitle(cwdBase, emoji, lastTitle || undefined));
	});

	pi.on("agent_start", async (_event, ctx) => {
		sawCommit = false;
		lastStopError = false;
		agentRunning = true;
		const cwdBase = path.basename(ctx.cwd || "pi");
		ctx.ui.setTitle(buildTitle(cwdBase, "🟡", lastTitle || undefined));
		resetTimeout(ctx.ui, cwdBase);
	});

	pi.on("turn_start", async (_event, ctx) => {
		const cwdBase = path.basename(ctx.cwd || "pi");
		markActivity(ctx.ui, cwdBase);
	});

	pi.on("tool_call", async (event: any, ctx) => {
		if (event.toolName === "bash") {
			const command = typeof event.input?.command === "string" ? event.input.command : "";
			if (command && GIT_COMMIT_RE.test(command)) sawCommit = true;
		}
		const cwdBase = path.basename(ctx.cwd || "pi");
		markActivity(ctx.ui, cwdBase);
	});

	pi.on("tool_result", async (_event, ctx) => {
		const cwdBase = path.basename(ctx.cwd || "pi");
		markActivity(ctx.ui, cwdBase);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		agentRunning = false;
		clearTabTimeout();
		const cwdBase = path.basename(ctx.cwd || "pi");
		ctx.ui.setTitle(`🟡 π - ${cwdBase}`);
	});

	pi.on("agent_end", async (_event, ctx) => {
		log("agent_end fired");
		try {
			lastStopError = (_event as any)?.stopReason === "error";
			agentRunning = false;
			clearTabTimeout();

			const cwdBase = path.basename(ctx.cwd);
			const statusSuffix = lastStopError ? "🔴" : sawCommit ? "🟢" : "🟡";

			ctx.ui.setTitle(buildTitle(cwdBase, statusSuffix, lastTitle || undefined));

			const entries = ctx.sessionManager.getBranch();
			const userMessages = entries.filter((e) => e.type === "message" && e.message.role === "user");
			const userCount = userMessages.length;
			log(`userCount=${userCount}, titleSet=${titleSet}`);

			const convo = entries.filter(
				(e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
			);
			const firstUser = convo.find((e) => e.type === "message" && e.message.role === "user");
			const tail = convo.slice(titleSet ? -6 : -4);
			const selected = [...(firstUser ? [firstUser] : []), ...tail.filter((e) => e !== firstUser)];

			const snippets = [
				`project: ${cwdBase}`,
				...selected.map((e) => {
					if (e.type !== "message") return "";
					const msg = e.message;
					if (msg.role === "user" || msg.role === "assistant") {
						return `${msg.role}: ${extractText(msg).slice(0, 500)}`;
					}
					return "";
				}),
			]
				.filter(Boolean)
				.join("\n");

			log(`snippets length: ${snippets.length}`);
			if (!snippets.trim()) {
				log("empty snippets, returning");
				return;
			}

			const gitCtx = await getGitContext(ctx.cwd);
			log(`gitCtx: ${JSON.stringify(gitCtx)}`);

			let title: string | null = null;

			if (gitCtx.ticket || gitCtx.prNumber !== null) {
				const parts: string[] = [];
				if (gitCtx.ticket) parts.push(gitCtx.ticket);
				if (gitCtx.prNumber !== null) parts.push(`#${gitCtx.prNumber}`);
				parts.push(cwdBase);
				title = parts.join(" ");
				log(`structured title: ${JSON.stringify(title)}`);
			} else {
				log("no git context, attempting LLM title...");
				title = await generateTitleViaModel(ctx, snippets);
				log(`LLM title result: ${JSON.stringify(title)}`);

				if (!title) {
					const userText = extractUserText(entries, titleSet ? "latest" : "first");
					log(`heuristic input: ${JSON.stringify(userText?.slice(0, 80))}`);
					if (userText) title = heuristicTitle(userText);
					log(`heuristic title: ${JSON.stringify(title)}`);
				}
			}

			if (title && title !== lastTitle) {
				log(`setting title: ${JSON.stringify(title)} suffix=${statusSuffix}`);
				pi.setSessionName(title);
				ctx.ui.setTitle(buildTitle(cwdBase, statusSuffix, title));
				lastTitle = title;
				titleSet = true;
				log("title set successfully");
			} else {
				log(`no change: title=${JSON.stringify(title)}, lastTitle=${JSON.stringify(lastTitle)}`);
			}
		} catch (err) {
			log(`ERROR: ${err}`);
		}
	});
}

async function generateTitleViaModel(ctx: ExtensionContext, conversationSnippet: string): Promise<string | null> {
	try {
		const available = ctx.modelRegistry.getAvailable();
		log(`available models: ${available.length} — ${available.map((m: any) => `${m.id}(${m.api})`).join(", ")}`);
		if (available.length === 0) return null;

		const usable = available.filter((m: any) => !String(m.api || "").includes("codex-responses"));
		log(`usable models after filtering: ${usable.length}`);

		const apiPriority = (m: any): number => {
			const api = String(m.api || "");
			if (api.includes("databricks")) return 0;
			if (api.includes("anthropic") || api === "openai-completions") return 1;
			if (api === "openai-responses") return 2;
			return 3;
		};
		const sorted = [...usable].sort((a, b) => {
			const prio = apiPriority(a) - apiPriority(b);
			if (prio !== 0) return prio;
			return a.cost.input + a.cost.output - (b.cost.input + b.cost.output);
		});

		for (const model of sorted.slice(0, 3)) {
			log(`trying model: ${model.id} api=${model.api} baseUrl=${model.baseUrl}`);
			const title = await callModel(ctx, model, conversationSnippet);
			log(`model ${model.id} returned: ${JSON.stringify(title)}`);
			if (title) return title;
		}
		return null;
	} catch (err) {
		log(`generateTitleViaModel ERROR: ${err}`);
		return null;
	}
}

async function callModel(ctx: ExtensionContext, model: any, snippet: string): Promise<string | null> {
	try {
		const api = String(model.api || "");
		const baseUrl = String(model.baseUrl || "").replace(/\/$/, "");
		const isDatabricks = api.includes("databricks");

		let apiKey: string | null;
		if (isDatabricks) {
			apiKey = await getDatabricksToken();
		} else {
			apiKey = await ctx.modelRegistry.getApiKey(model);
		}
		if (!apiKey) {
			log(`callModel: no API key for ${model.id} (isDatabricks=${isDatabricks})`);
			return null;
		}

		const userPrompt =
			`Generate a short 2-6 word tab title for the user's main task. ` +
			`Prefer the format "<task> for <project or component>" when both are clear and it sounds natural. ` +
			`Prefer the user's underlying goal over incidental tool output, assistant phrasing, or debugging chatter. ` +
			`Use project/repo/component context when it helps disambiguate. ` +
			`Ignore filler or meta turns like "continue", "do it", or "what did you just do". ` +
			`Respond with ONLY the title. No quotes. No trailing punctuation. No explanation. ` +
			`Examples of good titles: "Title Refine for Auto-Title", "Initial CLI for Teams", "Replay Fix for Databricks", "Doctor Checks for Miyagi"\n\n` +
			`Conversation:\n${snippet.slice(0, 1600)}`;

		let raw: string | null = null;

		log(`callModel: api=${api}, baseUrl=${baseUrl}, hasKey=${!!apiKey}, isDatabricks=${isDatabricks}`);

		if (api.includes("anthropic") || api.includes("databricks")) {
			raw = await fetchAnthropic(baseUrl, apiKey, model.id, userPrompt);
		} else if (api.includes("openai") || api.includes("codex") || api.includes("responses")) {
			raw = await fetchOpenAI(baseUrl, apiKey, model.id, userPrompt);
		} else {
			log(`callModel: unrecognized api type "${api}", skipping`);
		}

		log(`callModel raw response: ${JSON.stringify(raw)}`);
		return cleanTitle(raw);
	} catch (err) {
		log(`callModel ERROR for ${model.id}: ${err}`);
		return null;
	}
}

const AZURE_DATABRICKS_RESOURCE_ID = "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d";
let cachedDatabricksToken: { token: string; expiresAt: number } | null = null;

async function getDatabricksToken(): Promise<string | null> {
	const now = Date.now();
	if (cachedDatabricksToken && cachedDatabricksToken.expiresAt > now + 5 * 60 * 1000) {
		return cachedDatabricksToken.token;
	}
	try {
		const { stdout } = await execAsync(
			`az account get-access-token --resource ${AZURE_DATABRICKS_RESOURCE_ID} --query accessToken -o tsv`,
			{ timeout: 10000 },
		);
		const token = stdout.trim();
		if (!token || !token.startsWith("eyJ")) {
			log("getDatabricksToken: az cli returned non-JWT token");
			return null;
		}
		try {
			const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
			cachedDatabricksToken = { token, expiresAt: (payload.exp || 0) * 1000 };
		} catch {
			cachedDatabricksToken = { token, expiresAt: now + 60 * 60 * 1000 };
		}
		log("getDatabricksToken: got fresh token from az cli");
		return token;
	} catch (err) {
		log(`getDatabricksToken ERROR: ${err}`);
		return null;
	}
}

function copilotHeaders(baseUrl: string, apiKey: string): Record<string, string> {
	const isCopilot = baseUrl.includes("githubcopilot.com");
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		...(isCopilot && {
			"Editor-Version": "pi/1.0.0",
			"Copilot-Integration-Id": "pi-auto-title",
			"Editor-Plugin-Version": "pi/1.0.0",
		}),
	};
}

async function fetchAnthropic(baseUrl: string, apiKey: string, modelId: string, prompt: string): Promise<string | null> {
	const url = baseUrl.endsWith("/v1/messages")
		? baseUrl
		: baseUrl.includes("/v1/")
			? baseUrl.replace(/\/v1\/.*$/, "/v1/messages")
			: `${baseUrl}/v1/messages`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10000);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				...copilotHeaders(baseUrl, apiKey),
				"anthropic-version": "2023-06-01",
				"x-api-key": apiKey,
			},
			body: JSON.stringify({
				model: modelId,
				max_tokens: 40,
				messages: [{ role: "user", content: prompt }],
			}),
			signal: controller.signal,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			log(`fetchAnthropic FAIL: ${response.status} ${response.statusText} — ${body.slice(0, 300)}`);
			return null;
		}
		const data = (await response.json()) as any;
		return data?.content?.[0]?.text?.trim() ?? null;
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchOpenAI(baseUrl: string, apiKey: string, modelId: string, prompt: string): Promise<string | null> {
	const chatResult = await fetchOpenAIChatCompletions(baseUrl, apiKey, modelId, prompt);
	if (chatResult) return chatResult;
	return null;
}

async function fetchOpenAIChatCompletions(
	baseUrl: string,
	apiKey: string,
	modelId: string,
	prompt: string,
): Promise<string | null> {
	let url: string;
	if (baseUrl.includes("/chat/completions")) {
		url = baseUrl;
	} else if (baseUrl.includes("/v1")) {
		url = baseUrl.replace(/\/v1\/?.*$/, "/v1/chat/completions");
	} else {
		url = `${baseUrl}/v1/chat/completions`;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10000);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: copilotHeaders(baseUrl, apiKey),
			body: JSON.stringify({
				model: modelId,
				max_tokens: 40,
				messages: [
					{
						role: "system",
						content:
							"Generate short 2-6 word tab titles. Prefer '<task> for <project>' when natural. Prefer the user's core task. Reply with ONLY the title.",
					},
					{ role: "user", content: prompt },
				],
			}),
			signal: controller.signal,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			log(`fetchOpenAI FAIL: ${response.status} ${response.statusText} — ${body.slice(0, 300)}`);
			return null;
		}
		const data = (await response.json()) as any;
		return data?.choices?.[0]?.message?.content?.trim() ?? null;
	} finally {
		clearTimeout(timeout);
	}
}

interface GitContext {
	ticket: string | null;
	prNumber: number | null;
}

async function getGitContext(cwd: string): Promise<GitContext> {
	const result: GitContext = { ticket: null, prNumber: null };
	try {
		const { stdout: branchOut } = await execAsync(`git -C ${JSON.stringify(cwd)} rev-parse --abbrev-ref HEAD`, {
			timeout: 5000,
		});
		const branch = branchOut.trim();
		log(`getGitContext: branch=${branch}`);

		if (branch && branch !== "HEAD" && branch !== "main" && branch !== "master" && branch !== "develop") {
			const match = branch.match(JIRA_TICKET_RE);
			if (match) result.ticket = match[1];
		}
	} catch (err) {
		log(`getGitContext: branch lookup failed — ${err}`);
	}

	try {
		const { stdout: prOut } = await execAsync(`gh pr view --json number --jq .number`, {
			timeout: 8000,
			cwd,
		});
		const num = Number.parseInt(prOut.trim(), 10);
		if (!Number.isNaN(num)) result.prNumber = num;
		log(`getGitContext: prNumber=${result.prNumber}`);
	} catch (err) {
		log(`getGitContext: no PR or gh unavailable — ${err}`);
	}

	return result;
}

function cleanTitle(raw: string | null): string | null {
	if (!raw) return null;
	let cleaned = raw
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/^title:\s*/i, "")
		.replace(/[.!]+$/, "")
		.trim();
	cleaned = truncWords(cleaned, 6);
	if (cleaned.length > 60 || cleaned.length < 2) return null;
	return cleaned;
}

function extractText(msg: any): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join(" ");
	}
	return String(msg.content ?? "");
}

function extractUserText(entries: any[], which: "first" | "latest"): string | null {
	const users = entries.filter((e: any) => e.type === "message" && e.message.role === "user");
	const target = which === "latest" ? users[users.length - 1] : users[0];
	if (!target || target.type !== "message") return null;
	return extractText(target.message);
}

function heuristicTitle(text: string): string {
	let clean = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\/skill:\S+/g, " ")
		.replace(/\/prompt:\S+/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[<>{}[\]]/g, " ")
		.replace(/\n+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (!clean) return "";
	if (clean.length <= 35) return capitalize(truncWords(clean.replace(/[.!,;:]+$/, ""), 6));

	const patterns = [
		/(?:tell me about|explain|describe|show me|walk me through)\s+(.{5,45})/i,
		/(?:what(?:'s| is| are))\s+(.{5,45})/i,
		/(?:how (?:to|do|can|should|would))\s+(.{5,45})/i,
		/(?:create|build|write|make|generate)\s+(.{5,45})/i,
		/(?:fix|debug|troubleshoot|resolve)\s+(.{5,45})/i,
		/(?:add|implement|set up|configure|install)\s+(.{5,45})/i,
		/(?:update|refactor|migrate|upgrade|convert)\s+(.{5,45})/i,
		/(?:review|check|look at|analyze|audit)\s+(.{5,45})/i,
		/(?:search|find|look for|grep|locate)\s+(.{5,45})/i,
		/(?:deploy|release|publish|push)\s+(.{5,45})/i,
		/(?:read|open|view|see|list)\s+(.{5,45})/i,
	];

	for (const pattern of patterns) {
		const match = clean.match(pattern);
		if (match?.[1]) return capitalize(truncWords(match[1].trim(), 6));
	}

	const stripped = clean
		.replace(
			/^(?:hey|hi|hello|ok|okay|so|well|um|uh|please|can you|could you|i want to|i need to|i'd like to|let's|let me|see |im )\s+/i,
			"",
		)
		.trim();

	return capitalize(truncWords(stripped || clean, 6));
}

function truncWords(text: string, max: number): string {
	return text.split(/\s+/).slice(0, max).join(" ").replace(/[.,;:!]+$/, "");
}

function capitalize(s: string): string {
	return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
