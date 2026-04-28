/**
 * pi-poe-provider: Poe integration extension for pi.
 *
 * Features:
 * - Dynamic provider registration (poe-chat, poe-responses)
 * - OAuth /login poe support
 * - /poe slash commands (balance, history, models, refresh, account)
 * - LLM-callable tools (poe_get_balance, poe_list_models, poe_get_usage_history)
 * - Footer status badge showing point balance
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { PoeClient, type PoeModel, type PoeHistoryEntry } from "./poe-client.js";
import { normalizeModels, categorizeModels } from "./models.js";
import { loginPoe, refreshPoeToken, getPoeApiKey } from "./oauth.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const client = new PoeClient();

/** Cached model catalog (refreshed on startup and /poe refresh) */
let cachedModels: PoeModel[] = [];
let modelsFetchedAt = 0;
const MODELS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/** Cached balance */
let cachedBalance: number | null = null;
let balanceFetchedAt = 0;
const BALANCE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Determine API key from env or client state */
function resolveApiKey(): string | undefined {
	return process.env.POE_API_KEY ?? client.getApiKey();
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

async function fetchAndRegisterProviders(pi: ExtensionAPI): Promise<void> {
	try {
		const response = await client.listModels();
		cachedModels = response.data ?? [];
		modelsFetchedAt = Date.now();
	} catch (err) {
		console.error("[poe] Failed to fetch model catalog:", err);
		return;
	}

	const normalized = normalizeModels(cachedModels);
	const { chatModels, responseModels } = categorizeModels(normalized);

	// Register the main poe provider (openai-completions) with all chat-capable models
	if (chatModels.length > 0) {
		pi.registerProvider("poe", {
			baseUrl: "https://api.poe.com/v1",
			apiKey: "POE_API_KEY",
			api: "openai-completions",
			models: chatModels,
			authHeader: true,
			oauth: {
				name: "Sign in with Poe",
				login: (callbacks) => loginPoe(callbacks, client),
				refreshToken: refreshPoeToken,
				getApiKey: getPoeApiKey,
			},
		});
	}

	// Register poe-responses provider (openai-responses) for reasoning-capable models
	// Shares auth with the main poe provider since pi reuses OAuth credentials by apiKey name
	if (responseModels.length > 0) {
		pi.registerProvider("poe-responses", {
			baseUrl: "https://api.poe.com/v1",
			apiKey: "POE_API_KEY",
			api: "openai-responses",
			models: responseModels,
			authHeader: true,
			oauth: {
				name: "Sign in with Poe",
				login: (callbacks) => loginPoe(callbacks, client),
				refreshToken: refreshPoeToken,
				getApiKey: getPoeApiKey,
			},
		});
	}
}

// ---------------------------------------------------------------------------
// Balance helpers
// ---------------------------------------------------------------------------

async function fetchBalance(signal?: AbortSignal): Promise<number | null> {
	const key = resolveApiKey();
	if (!key) return null;

	// Return cached if fresh
	if (cachedBalance !== null && Date.now() - balanceFetchedAt < BALANCE_CACHE_TTL) {
		return cachedBalance;
	}

	try {
		client.setApiKey(key);
		const response = await client.getBalance(signal);
		cachedBalance = response.current_point_balance;
		balanceFetchedAt = Date.now();
		return cachedBalance;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatBalance(balance: number): string {
	return `Poe: ${balance.toLocaleString()} pts`;
}

function formatHistoryEntry(entry: PoeHistoryEntry, idx: number): string {
	const time = new Date(entry.creation_time * 1000).toLocaleString();
	const cost = entry.cost_points.toFixed(1);
	const usd = entry.cost_usd !== undefined ? ` ($${entry.cost_usd.toFixed(4)})` : "";
	return `${idx + 1}. ${entry.bot_name} — ${cost} pts${usd} — ${entry.usage_type} — ${time}`;
}

/** Format a per-turn cost line for the footer/widget */
function formatTurnCost(entry: PoeHistoryEntry): string {
	const cost = entry.cost_points.toFixed(1);
	const usd = entry.cost_usd !== undefined ? ` ($${entry.cost_usd.toFixed(4)})` : "";
	return `${entry.bot_name} ${cost} pts${usd}`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	// Initialize client with env var if available
	const envKey = process.env.POE_API_KEY;
	if (envKey) client.setApiKey(envKey);

	// Phase 2: Fetch models and register providers before startup finishes
	await fetchAndRegisterProviders(pi);

	// -------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------

	pi.registerCommand("poe", {
		description: "Poe integration: balance, history, models, refresh, account",
		getArgumentCompletions(prefix: string) {
			const subs = ["balance", "history", "models", "refresh", "account", "login", "logout"];
			return subs
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			const rest = args.trim().split(/\s+/).slice(1).join(" ");

			switch (sub) {
				case "balance": {
					const balance = await fetchBalance(ctx.signal);
					if (balance === null) {
						ctx.ui.notify("Poe balance unavailable (no API key or network error)", "warning");
					} else {
						ctx.ui.notify(formatBalance(balance), "info");
					}
					break;
				}

				case "history": {
					const key = resolveApiKey();
					if (!key) {
						ctx.ui.notify("Poe API key required. Use /login poe or set POE_API_KEY.", "warning");
						break;
					}
					const limit = parseInt(rest, 10) || 10;
					client.setApiKey(key);
					try {
						const response = await client.getHistory({ limit }, ctx.signal);
						if (response.data.length === 0) {
							ctx.ui.notify("No Poe usage history found.", "info");
						} else {
							const lines = response.data.map((e, i) => formatHistoryEntry(e, i));
							ctx.ui.notify("Poe Usage History:\n" + lines.join("\n"), "info");
						}
					} catch (err) {
						ctx.ui.notify(`Failed to fetch history: ${err instanceof Error ? err.message : err}`, "error");
					}
					break;
				}

				case "models": {
					// Refresh if stale or empty
					if (cachedModels.length === 0 || Date.now() - modelsFetchedAt > MODELS_CACHE_TTL) {
						try {
							const response = await client.listModels(ctx.signal);
							cachedModels = response.data ?? [];
							modelsFetchedAt = Date.now();
						} catch (err) {
							ctx.ui.notify(`Failed to fetch models: ${err instanceof Error ? err.message : err}`, "error");
							break;
						}
					}

					const query = rest.toLowerCase();
					const matches = query
						? cachedModels.filter((m) =>
								m.id.toLowerCase().includes(query) ||
								(m.metadata?.display_name ?? "").toLowerCase().includes(query) ||
								(m.owned_by ?? "").toLowerCase().includes(query)
							)
						: cachedModels.slice(0, 20); // Show first 20 by default

					if (matches.length === 0) {
						ctx.ui.notify(query ? `No Poe models matching "${query}"` : "No Poe models found.", "info");
					} else {
						const lines = matches.slice(0, 30).map((m) => {
							const name = m.metadata?.display_name ?? m.id;
							const owner = m.owned_by ? ` [${m.owned_by}]` : "";
							const pricing = m.pricing
								? ` in:${(m.pricing.input_tokens ?? 0).toExponential(2)}/tok out:${(m.pricing.output_tokens ?? 0).toExponential(2)}/tok`
								: "";
							return `  ${name}${owner}${pricing}`;
						});
						const total = query ? matches.length : cachedModels.length;
						const header = query
							? `Poe models matching "${query}" (${matches.length}):`
							: `Poe models (showing first ${Math.min(30, matches.length)} of ${total}):`;
						ctx.ui.notify(header + "\n" + lines.join("\n"), "info");
					}
					break;
				}

				case "refresh": {
					// Force refresh models and balance
					try {
						const modelResponse = await client.listModels(ctx.signal);
						cachedModels = modelResponse.data ?? [];
						modelsFetchedAt = Date.now();
					} catch (err) {
						ctx.ui.notify(`Model refresh failed: ${err instanceof Error ? err.message : err}`, "error");
					}
					const balance = await fetchBalance(ctx.signal);
					const balanceMsg = balance !== null ? formatBalance(balance) : "balance unavailable";
					ctx.ui.notify(`Poe refreshed — ${cachedModels.length} models, ${balanceMsg}`, "info");
					break;
				}

				case "account": {
					const key = resolveApiKey();
					if (!key) {
						ctx.ui.notify("No Poe API key configured. Use /login poe or set POE_API_KEY.", "warning");
						break;
					}
					const balance = await fetchBalance(ctx.signal);
					const balanceMsg = balance !== null ? formatBalance(balance) : "balance unavailable";
					const source = process.env.POE_API_KEY ? "env (POE_API_KEY)" : "OAuth /login poe";
					ctx.ui.notify(`Poe account: ${balanceMsg}\nKey source: ${source}`, "info");
					break;
				}

				case "login": {
					const hasClientId = !!process.env.POE_CLIENT_ID?.trim();
					if (hasClientId) {
						ctx.ui.notify("Use /login and select the Poe provider to open browser OAuth.", "info");
					} else {
						ctx.ui.notify(
							"Use /login and select the Poe provider to enter your API key.\n" +
							"For browser OAuth, set POE_CLIENT_ID (register at https://poe.com/api/clients) and restart pi.",
							"info"
						);
					}
					break;
				}

				case "logout": {
					client.setApiKey(undefined);
					cachedBalance = null;
					ctx.ui.notify("Poe credentials cleared from session. Use /login poe to re-authenticate.", "info");
					break;
				}

				default: {
					ctx.ui.notify(
						"Poe commands: /poe balance | history [N] | models [query] | refresh | account | login | logout",
						"info"
					);
					break;
				}
			}
		},
	});

	// -------------------------------------------------------------------
	// LLM-callable tools
	// -------------------------------------------------------------------

	pi.registerTool({
		name: "poe_get_balance",
		label: "Poe Balance",
		description: "Get the current Poe point balance. Returns the total available points (plan + add-on).",
		promptSnippet: "Check current Poe point balance",
		promptGuidelines: ["Use poe_get_balance when the user asks about their Poe points or balance."],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			const balance = await fetchBalance(signal);
			if (balance === null) {
				return {
					content: [{ type: "text", text: "Poe balance unavailable. No API key configured or network error." }],
					details: { error: true },
				};
			}
			return {
				content: [{ type: "text", text: `Current Poe balance: ${balance.toLocaleString()} points` }],
				details: { balance, fetchedAt: balanceFetchedAt },
			};
		},
	});

	pi.registerTool({
		name: "poe_list_models",
		label: "Poe Models",
		description: "Search the Poe model catalog. Optionally filter by query string matching model ID, display name, or owner.",
		promptSnippet: "Search Poe model catalog",
		promptGuidelines: ["Use poe_list_models when the user asks about available Poe models or wants to find a specific model."],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search query to filter models by ID, name, or owner" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results (default 20, max 50)", default: 20 })),
		}),
		async execute(_toolCallId, params, signal) {
			// Refresh if stale
			if (cachedModels.length === 0 || Date.now() - modelsFetchedAt > MODELS_CACHE_TTL) {
				try {
					const response = await client.listModels(signal);
					cachedModels = response.data ?? [];
					modelsFetchedAt = Date.now();
				} catch (err) {
					return {
						content: [{ type: "text", text: `Failed to fetch Poe models: ${err instanceof Error ? err.message : err}` }],
						details: { error: true },
					};
				}
			}

			const query = (params.query ?? "").toLowerCase();
			const limit = Math.min(params.limit ?? 20, 50);
			const matches = query
				? cachedModels.filter((m) =>
						m.id.toLowerCase().includes(query) ||
						(m.metadata?.display_name ?? "").toLowerCase().includes(query) ||
						(m.owned_by ?? "").toLowerCase().includes(query)
					)
				: cachedModels;

			const results = matches.slice(0, limit).map((m) => ({
				id: m.id,
				name: m.metadata?.display_name ?? m.id,
				owner: m.owned_by,
				reasoning: m.reasoning,
				contextWindow: m.context_window?.context_length,
				maxOutputTokens: m.context_window?.max_output_tokens,
				inputModalities: m.architecture?.input_modalities,
			}));

			return {
				content: [{
					type: "text",
					text: results.length === 0
						? query ? `No Poe models matching "${params.query}"` : "No Poe models found"
						: `Poe models (${results.length}${matches.length > limit ? ` of ${matches.length}` : ""}):\n` +
							results.map((r) => `  ${r.name} (${r.id}) [${r.owner ?? "unknown"}]${r.reasoning ? " reasoning" : ""}`).join("\n"),
				}],
				details: { models: results, total: matches.length },
			};
		},
	});

	pi.registerTool({
		name: "poe_get_usage_history",
		label: "Poe Usage History",
		description: "Get recent Poe point usage history. Shows per-request point spend, model used, and timestamps.",
		promptSnippet: "Check recent Poe point spending",
		promptGuidelines: ["Use poe_get_usage_history when the user asks about their Poe spending or recent usage."],
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Number of entries to fetch (default 10, max 50)", default: 10 })),
			startingAfter: Type.Optional(Type.String({ description: "Pagination cursor: query_id from last entry" })),
		}),
		async execute(_toolCallId, params, signal) {
			const key = resolveApiKey();
			if (!key) {
				return {
					content: [{ type: "text", text: "Poe API key required. Use /login poe or set POE_API_KEY." }],
					details: { error: true },
				};
			}

			client.setApiKey(key);
			try {
				const limit = Math.min(params.limit ?? 10, 50);
				const response = await client.getHistory({
					limit,
					startingAfter: params.startingAfter,
				}, signal);

				if (response.data.length === 0) {
					return {
						content: [{ type: "text", text: "No Poe usage history found." }],
						details: { entries: [], hasMore: false },
					};
				}

				const lines = response.data.map((e, i) =>
					`${i + 1}. ${e.bot_name} — ${e.cost_points.toFixed(1)} pts — ${e.usage_type} — ${new Date(e.creation_time * 1000).toLocaleString()}`
				);
				const totalPts = response.data.reduce((sum, e) => sum + e.cost_points, 0);

				return {
					content: [{
						type: "text",
						text: `Poe usage (${response.data.length} entries, ${totalPts.toFixed(1)} pts total):\n` + lines.join("\n"),
					}],
					details: {
						entries: response.data,
						hasMore: response.has_more,
						totalPoints: totalPts,
					},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to fetch Poe history: ${err instanceof Error ? err.message : err}` }],
					details: { error: true },
				};
			}
		},
	});

	// -------------------------------------------------------------------
	// Footer status badge
	// -------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Only show badge if we have an API key
		const key = resolveApiKey();
		if (!key) return;

		const balance = await fetchBalance();
		if (balance !== null) {
			ctx.ui.setStatus("poe-balance", formatBalance(balance));
		}
	});

	// Update balance badge and show per-turn cost after each agent turn
	pi.on("agent_end", async (_event, ctx) => {
		const key = resolveApiKey();
		if (!key) return;

		// Fetch updated balance
		const balance = await fetchBalance(ctx.signal);
		if (balance !== null) {
			ctx.ui.setStatus("poe-balance", formatBalance(balance));
		} else {
			ctx.ui.setStatus("poe-balance", "Poe: pts unavailable");
		}

		// Fetch the latest history entry to show per-turn cost
		try {
			client.setApiKey(key);
			const history = await client.getHistory({ limit: 1 }, ctx.signal);
			if (history.data.length > 0) {
				const latest = history.data[0];
				ctx.ui.setStatus("poe-turn-cost", `Last turn: ${formatTurnCost(latest)}`);
			}
		} catch {
			// Don't error out if history fetch fails — balance update is sufficient
		}
	});
}
