/**
 * pi-poe-provider: Poe integration extension for pi.
 *
 * Features:
 * - Dynamic provider registration (poe-chat, poe-responses)
 * - OAuth /login poe support
 * - /poe slash commands (balance, history, models, free, refresh, account, add)
 * - LLM-callable tools (poe_get_balance, poe_list_models, poe_get_usage_history)
 * - Footer status badge showing point balance
 * - Custom bot registration for community bots not in catalog
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { PoeClient, type PoeModel, type PoeHistoryEntry } from "./poe-client.js";
import { normalizeModels, normalizeEmulatedModels, categorizeModels } from "./models.js";
import { streamPoeEmulatedTools } from "./poe-emulated.js";
import { loginPoe, refreshPoeToken, getPoeApiKey } from "./oauth.js";
import { loadCustomModels, saveCustomModel } from "./custom-models.js";

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

	// Load custom/community bot IDs that users have added. Treat custom bots as
	// emulated by default because Poe does not expose their tool-capability metadata.
	const customModelIds = await loadCustomModels();
	const existingCachedIds = new Set(cachedModels.map((m) => m.id));
	for (const modelId of customModelIds) {
		if (!existingCachedIds.has(modelId)) {
			cachedModels.push({
				id: modelId,
				object: "model",
				created: 0,
				owned_by: "custom",
				metadata: { display_name: modelId },
				supported_endpoints: ["/v1/chat/completions"],
				supported_features: [],
			} as PoeModel);
		}
	}

	const normalized = normalizeModels(cachedModels);
	const emulatedNormalized = normalizeEmulatedModels(cachedModels);
	const { chatModels, responseModels } = categorizeModels(normalized, cachedModels);
	const { chatModels: emulatedChatModels } = categorizeModels(emulatedNormalized, cachedModels);

	if (customModelIds.length > 0) {
		console.log(`[poe] Loaded ${customModelIds.length} custom bot(s): ${customModelIds.join(", ")}`);
	}

	// Register the main poe provider (openai-completions) with native-tool-capable chat models.
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

	// Experimental provider for Poe chat models that reject native tool calling.
	// The custom stream handler converts pi tools to prompt instructions and parses
	// model-emitted JSON back into pi tool calls, with validation and repair retries.
	if (emulatedChatModels.length > 0) {
		pi.registerProvider("poe-emulated", {
			baseUrl: "https://api.poe.com/v1",
			apiKey: "POE_API_KEY",
			api: "openai-completions",
			models: emulatedChatModels,
			authHeader: true,
			oauth: {
				name: "Sign in with Poe",
				login: (callbacks) => loginPoe(callbacks, client),
				refreshToken: refreshPoeToken,
				getApiKey: getPoeApiKey,
			},
			streamSimple: streamPoeEmulatedTools,
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
	// Poe returns creation_time in microseconds, convert to milliseconds for Date
	const time = new Date(entry.creation_time / 1000).toLocaleString();
	const cost = entry.cost_points.toFixed(1);
	const costUsd = typeof entry.cost_usd === "number" ? entry.cost_usd : parseFloat(String(entry.cost_usd ?? 0));
	const usd = costUsd !== 0 ? ` ($${costUsd.toFixed(4)})` : "";
	const apiKeyTag = entry.api_key_name ? ` via ${entry.api_key_name}` : "";
	return `${idx + 1}. ${entry.bot_name} — ${cost} pts${usd} — ${entry.usage_type}${apiKeyTag} — ${time}`;
}

/** Format a per-turn cost line for the footer/widget */
function formatTurnCost(entry: PoeHistoryEntry): string {
	const cost = entry.cost_points.toFixed(1);
	const costUsd = typeof entry.cost_usd === "number" ? entry.cost_usd : parseFloat(String(entry.cost_usd ?? 0));
	const usd = costUsd !== 0 ? ` ($${costUsd.toFixed(4)})` : "";
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
		description: "Poe integration: balance, history, models, free, refresh, account, add",
		getArgumentCompletions(prefix: string) {
			const subs = ["balance", "history", "models", "free", "refresh", "account", "login", "logout", "add"];
			return subs
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			const rest = args.trim().split(/\s+/).slice(1).join(" ");

			switch (sub) {
				case "balance": {
					const key = resolveApiKey();
					if (!key) {
						ctx.ui.notify("Poe balance unavailable (no API key)", "warning");
						break;
					}
					try {
						client.setApiKey(key);
						const response = await client.getBalance(ctx.signal);
						cachedBalance = response.current_point_balance;
						balanceFetchedAt = Date.now();

						let msg = formatBalance(cachedBalance);
						if (response.plan_points_balance !== undefined) {
							msg += ` (plan: ${response.plan_points_balance.toLocaleString()}`;
							if (response.addon_point_balance !== undefined) {
							msg += `, add-on: ${response.addon_point_balance.toLocaleString()}`;
							}
							msg += `)`;
						}
					if (response.total_balance_usd) {
						msg += ` ≈ $${response.total_balance_usd}`;
						}
					if (response.next_daily_grant_time && response.next_daily_grant_amount) {
						const grantTime = new Date(response.next_daily_grant_time / 1000).toLocaleString();
						msg += `\nNext daily grant: +${response.next_daily_grant_amount.toLocaleString()} pts at ${grantTime}`;
						}
					ctx.ui.notify(msg, "info");
					} catch {
						ctx.ui.notify("Poe balance unavailable (network error)", "warning");
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
							const endpoints = (m.supported_endpoints as string[] | undefined)?.filter((ep) =>
								ep === "/v1/chat/completions" || ep === "/v1/responses" || ep === "/v1/messages"
							).join(", ") ?? "";
							const pricing = m.pricing
								? (() => {
									const p = m.pricing as Record<string, unknown>;
									const prompt = p["prompt"] != null ? Number(p["prompt"]) : null;
									const completion = p["completion"] != null ? Number(p["completion"]) : null;
									if (prompt || completion) {
										return ` in:$${(prompt! * 1e6).toFixed(2)}/M out:$${(completion! * 1e6).toFixed(2)}/M`;
									}
									return " free";
								})()
								: " free";
							const epTag = endpoints ? ` [${endpoints}]` : "";
							return `  ${name}${owner}${pricing}${epTag}`;
						});
						const total = query ? matches.length : cachedModels.length;
						const header = query
							? `Poe models matching "${query}" (${matches.length}):`
							: `Poe models (showing first ${Math.min(30, matches.length)} of ${total}):`;
						ctx.ui.notify(header + "\n" + lines.join("\n"), "info");
					}
					break;
				}

				case "free": {
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

					// Classify models by pricing
					const confirmedFree: Array<{ id: string; name: string; owner?: string }> = [];
					const likelyFree: Array<{ id: string; name: string; owner?: string }> = [];
					let paidCount = 0;

					for (const m of cachedModels) {
						const p = m.pricing;
						const name = m.metadata?.display_name ?? m.id;
						const owner = m.owned_by;

						if (p == null) {
							// pricing=null — likely free on the Poe app, but ambiguous for API
							likelyFree.push({ id: m.id, name, owner });
						} else if (typeof p === "object") {
							// Check all pricing fields for zero cost
							const fields = ["prompt", "completion", "image", "request", "input_cache_read", "input_cache_write"];
							let allZero = true;
							for (const field of fields) {
								const val = (p as Record<string, unknown>)[field];
								if (val != null && Number(val) !== 0) {
									allZero = false;
									break;
								}
							}
							if (allZero) {
								confirmedFree.push({ id: m.id, name, owner });
							} else {
								paidCount++;
							}
						} else {
							paidCount++;
						}
					}

					// Apply search filter if provided
					const filterFn = (m: { id: string; name: string; owner?: string }) =>
						!query ||
						m.id.toLowerCase().includes(query) ||
						m.name.toLowerCase().includes(query) ||
						(m.owner ?? "").toLowerCase().includes(query);

					const filteredConfirmed = confirmedFree.filter(filterFn);
					const filteredLikely = likelyFree.filter(filterFn);

					// Build output
					let output = `Poe model catalog: ${cachedModels.length} models total\n`;

					if (filteredConfirmed.length > 0) {
						output += `\n✅ Confirmed free (all pricing fields = $0):\n`;
						for (const m of filteredConfirmed) {
							const ownerTag = m.owner ? ` [${m.owner}]` : "";
							output += `  ${m.name} (${m.id})${ownerTag}\n`;
						}
					}

					if (filteredLikely.length > 0) {
						// Group likely-free models by owner
						const byOwner = new Map<string, Array<{ id: string; name: string }>>();
						for (const m of filteredLikely) {
							const key = m.owner ?? "unknown";
							if (!byOwner.has(key)) byOwner.set(key, []);
							byOwner.get(key)!.push(m);
						}

						output += `\n🟡 Likely free (pricing=null — free on Poe app, API cost ambiguous):\n`;
						// Sort owners by count descending
						const sortedOwners = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);
						for (const [owner, models] of sortedOwners) {
							if (query) {
								// Show individually when filtered
								for (const m of models) {
									output += `  ${m.name} (${m.id})\n`;
								}
							} else {
								// Summarize by owner, list up to 5 notable models
								const notable = models.slice(0, 5).map((m) => m.id).join(", ");
								const suffix = models.length > 5 ? `, … (+${models.length - 5} more)` : "";
								output += `  ${owner}: ${notable}${suffix}\n`;
							}
						}
						output += `  Total: ${filteredLikely.length} models\n`;
					}

					output += `\n💰 Paid (non-zero pricing): ${paidCount} models (skipped)`;

					ctx.ui.notify(output, "info");
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
					try {
						client.setApiKey(key);
						const balResp = await client.getBalance(ctx.signal);
						cachedBalance = balResp.current_point_balance;
						balanceFetchedAt = Date.now();

						const source = process.env.POE_API_KEY ? "env (POE_API_KEY)" : "OAuth /login poe";
						let msg = `Poe account: ${formatBalance(cachedBalance)}`;
						if (balResp.plan_points_balance !== undefined) msg += `\n  Plan: ${balResp.plan_points_balance.toLocaleString()} pts`;
						if (balResp.addon_point_balance !== undefined) msg += `, Add-on: ${balResp.addon_point_balance.toLocaleString()} pts`;
						if (balResp.total_balance_usd) msg += ` ($${balResp.total_balance_usd})`;
						msg += `\n  Key source: ${source}`;
						if (balResp.auto_recharge) {
							msg += `\n  Auto-recharge: ${balResp.auto_recharge.enabled ? `on (threshold: ${balResp.auto_recharge.threshold_points} pts, refill: ${balResp.auto_recharge.refill_points} pts)` : "off"}`;
						}
						ctx.ui.notify(msg, "info");
					} catch {
						ctx.ui.notify("Failed to fetch account info", "error");
					}
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

				case "add": {
					// Register a custom/community bot ID not in the standard catalog
					const modelId = rest.trim();
					if (!modelId) {
						ctx.ui.notify(
							"Usage: /poe add <model-id>\n" +
							"Register a custom/community bot from Poe that may not appear in the catalog.\n" +
							"Example: /poe add GLM-5-FWAI",
							"info"
						);
					} else {
						// Persist to config file - model will be available after /reload
						await saveCustomModel(modelId);

						ctx.ui.notify(
							`Custom bot "${modelId}" saved. Run /reload to use it.\n` +
							`Then: pi --provider poe --model ${modelId}`,
							"success"
						);
					}
					break;
				}

				default: {
					ctx.ui.notify(
						"Poe commands: /poe balance | history [N] | models [query] | free [query] | refresh | account | login | logout | add",
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
				reasoning: typeof m.reasoning === "object" && m.reasoning !== null ? (m.reasoning as { supports_reasoning_effort?: boolean }).supports_reasoning_effort === true : !!m.reasoning,
				contextWindow: m.context_window?.context_length ?? m.context_length,
				maxOutputTokens: m.context_window?.max_output_tokens,
				inputModalities: m.architecture?.input_modalities,
				supportedEndpoints: (m.supported_endpoints as string[] | undefined)?.filter((ep) =>
					ep === "/v1/chat/completions" || ep === "/v1/responses" || ep === "/v1/messages"
				) ?? [],
				supportedFeatures: (m.supported_features as string[] | undefined) ?? [],
			}));

			return {
				content: [{
					type: "text",
					text: results.length === 0
						? query ? `No Poe models matching "${params.query}"` : "No Poe models found"
						: `Poe models (${results.length}${matches.length > limit ? ` of ${matches.length}` : ""}):\n` +
							results.map((r) => {
								const tags: string[] = [];
								if (r.reasoning) tags.push("reasoning");
								if (r.supportedFeatures.includes("tools")) tags.push("tools");
								if (r.supportedFeatures.includes("web_search")) tags.push("web_search");
								const tagStr = tags.length ? ` ${tags.join(",")}` : "";
								return `  ${r.name} (${r.id}) [${r.owner ?? "unknown"}]${tagStr}`;
							}).join("\n"),
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
					`${i + 1}. ${e.bot_name} — ${e.cost_points.toFixed(1)} pts — ${e.usage_type} — ${new Date(e.creation_time / 1000).toLocaleString()}`
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
