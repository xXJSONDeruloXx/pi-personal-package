import { describe, it, expect } from "vitest";
import { normalizeModel, normalizeModels, categorizeModels } from "./models.js";
import type { PoeModel } from "./poe-client.js";

// ---------------------------------------------------------------------------
// Snapshot-style tests against real-ish API data
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<PoeModel> & { id: string }): PoeModel {
	return {
		object: "model",
		created: 0,
		root: overrides.id,
		...overrides,
	} as PoeModel;
}

describe("full model normalization — realistic data", () => {
	it("normalizes a paid Claude model", () => {
		const model = normalizeModel(makeModel({
			id: "claude-sonnet-4.6",
			owned_by: "Anthropic",
			metadata: { display_name: "Claude-Sonnet-4.6" },
			architecture: {
				input_modalities: ["text", "image"],
				output_modalities: ["text"],
			},
			context_window: { context_length: 983040, max_output_tokens: 128000 },
			pricing: {
				prompt: "0.0000025758",
				completion: "0.0000128788",
				image: null,
				request: null,
				input_cache_read: "0.0000002576",
				input_cache_write: "0.0000032197",
			},
			reasoning: { budget: null, required: false, supports_reasoning_effort: false },
			supported_endpoints: ["/v1/messages", "/v1/responses", "/v1/chat/completions"],
			supported_features: ["web_search", "tools"],
		}));

		expect(model.id).toBe("claude-sonnet-4.6");
		expect(model.name).toBe("Claude-Sonnet-4.6");
		expect(model.reasoning).toBe(false);
		expect(model.input).toContain("image");
		expect(model.contextWindow).toBe(983040);
		expect(model.maxTokens).toBe(128000);
		expect(model.cost.input).toBeCloseTo(2.5758, 2);
		expect(model.cost.output).toBeCloseTo(12.8788, 2);
		expect(model.cost.cacheRead).toBeCloseTo(0.2576, 2);
		expect(model.cost.cacheWrite).toBeCloseTo(3.2197, 2);
	});

	it("normalizes a paid GPT model with reasoning", () => {
		const model = normalizeModel(makeModel({
			id: "gpt-5.4",
			owned_by: "OpenAI",
			metadata: { display_name: "GPT-5.4" },
			architecture: {
				input_modalities: ["text", "image"],
				output_modalities: ["text", "image"],
			},
			context_window: { context_length: 1050000, max_output_tokens: 128000 },
			pricing: {
				prompt: "0.0000022727",
				completion: "0.0000136364",
				image: null,
				request: null,
				input_cache_read: "0.0000002273",
				input_cache_write: null,
			},
			reasoning: { budget: null, required: false, supports_reasoning_effort: true },
			supported_endpoints: ["/v1/responses", "/v1/chat/completions", "/v1/messages"],
			supported_features: ["web_search", "tools"],
		}));

		expect(model.id).toBe("gpt-5.4");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("image");
		expect(model.contextWindow).toBe(1050000);
		expect(model.cost.cacheRead).toBeCloseTo(0.2273, 2);
		expect(model.cost.cacheWrite).toBe(0); // null → 0
	});

	it("normalizes a confirmed-free model", () => {
		const model = normalizeModel(makeModel({
			id: "glm-5.1-t",
			owned_by: "Together AI",
			metadata: { display_name: "GLM-5.1-T" },
			architecture: {
				input_modalities: ["text"],
				output_modalities: ["text"],
			},
			pricing: {
				prompt: null,
				completion: null,
				image: null,
				request: "0.00",
				input_cache_read: null,
				input_cache_write: null,
			},
			reasoning: null,
			supported_endpoints: [],
			supported_features: [],
		}));

		// glm-5.1-t matches the REASONING_PATTERNS "glm-5" so reasoning is inferred
		expect(model.reasoning).toBe(true);
		expect(model.cost.input).toBe(0);
		expect(model.cost.output).toBe(0);
		expect(model.input).toEqual(["text"]);
		// No context_window or context_length → defaults
		expect(model.contextWindow).toBe(200000);
		expect(model.maxTokens).toBe(4096);
	});

	it("normalizes a model with only context_length (no context_window)", () => {
		const model = normalizeModel(makeModel({
			id: "qwen3.6-plus",
			owned_by: "EmpirioLabs AI",
			context_length: 131072,
			pricing: null,
			supported_endpoints: [],
		}));

		expect(model.contextWindow).toBe(131072);
		expect(model.maxTokens).toBe(4096); // default
	});
});

// ---------------------------------------------------------------------------
// categorizeModels with realistic raw data
// ---------------------------------------------------------------------------

describe("categorizeModels — realistic scenarios", () => {
	it("correctly splits a mixed catalog", () => {
		const rawModels: PoeModel[] = [
			makeModel({
				id: "claude-sonnet-4.6",
				reasoning: { budget: null, required: false, supports_reasoning_effort: false },
				supported_endpoints: ["/v1/messages", "/v1/responses", "/v1/chat/completions"],
				pricing: { prompt: "0.0000025758", completion: "0.0000128788" },
			}),
			makeModel({
				id: "mistral-medium",
				reasoning: null,
				supported_endpoints: ["/v1/chat/completions"],
				pricing: { prompt: "0.000002", completion: "0.00001" },
			}),
			makeModel({
				id: "glm-5.1-fw",
				reasoning: null,
				supported_endpoints: [],
				pricing: { prompt: null, completion: null, request: null },
			}),
			makeModel({
				id: "grok-3-mini",
				reasoning: { budget: null, required: false, supports_reasoning_effort: true },
				supported_endpoints: ["/v1/chat/completions", "/v1/messages"],
				pricing: { prompt: "0.0000015", completion: "0.0000075" },
			}),
		];

		const normalized = normalizeModels(rawModels);
		const { chatModels, responseModels } = categorizeModels(normalized, rawModels);

		const chatIds = chatModels.map((m) => m.id);
		const respIds = responseModels.map((m) => m.id);

		// All 4 should be in chat (they all have chat/completions or no endpoint data)
		expect(chatIds).toContain("claude-sonnet-4.6");
		expect(chatIds).toContain("mistral-medium");
		expect(chatIds).toContain("glm-5.1-fw"); // no endpoints, included by default
		expect(chatIds).toContain("grok-3-mini");

		// Only claude-sonnet-4.6 has /v1/responses
		expect(respIds).toContain("claude-sonnet-4.6");
		expect(respIds).not.toContain("mistral-medium"); // no /v1/responses
		expect(respIds).not.toContain("grok-3-mini"); // no /v1/responses, reasoning=true but endpoint check wins
		expect(respIds).toContain("glm-5.1-fw"); // no endpoints, but glm-5 pattern → reasoning=true → fallback puts it in responses
	});

	it("grok-3-mini reasoning falls back when no raw data provided", () => {
		// When categorizeModels is called without rawModels, it uses reasoning flag
		const models = [
			normalizeModel(makeModel({
				id: "grok-3-mini",
				reasoning: { budget: null, required: false, supports_reasoning_effort: true },
				supported_endpoints: ["/v1/chat/completions", "/v1/messages"],
			})),
		];
		const { responseModels } = categorizeModels(models); // no raw data
		// Falls back to reasoning=true
		expect(responseModels).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Full pipeline: normalizeModels then categorize
// ---------------------------------------------------------------------------

describe("full pipeline", () => {
	it("excludes non-chat and categorizes remaining", () => {
		const rawModels: PoeModel[] = [
			// Chat models
			makeModel({
				id: "gpt-5.4",
				owned_by: "OpenAI",
				metadata: { display_name: "GPT-5.4" },
				architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
				context_window: { context_length: 1050000, max_output_tokens: 128000 },
				pricing: { prompt: "0.0000022727", completion: "0.0000136364" },
				reasoning: { budget: null, required: false, supports_reasoning_effort: true },
				supported_endpoints: ["/v1/responses", "/v1/chat/completions", "/v1/messages"],
				supported_features: ["web_search", "tools"],
			}),
			// Free model with no endpoints
			makeModel({
				id: "gemma-4-31b-t",
				owned_by: "Together AI",
				pricing: { prompt: null, completion: null, request: "0.00" },
				reasoning: null,
				supported_endpoints: [],
			}),
			// Video model — should be excluded
			makeModel({
				id: "veo-3.1-lite",
				supported_endpoints: ["/v1/videos"],
				pricing: null,
			}),
			// Image model — should be excluded
			makeModel({
				id: "flux-2-pro",
				supported_endpoints: [],  // also matched by EXCLUDE_PATTERNS
				pricing: null,
			}),
			// Audio model — should be excluded
			makeModel({
				id: "elevenlabs-v3",
				supported_endpoints: ["/v1/audio"],
				pricing: null,
			}),
			// Utility bot — should be excluded
			makeModel({
				id: "assistant",
				supported_endpoints: ["/v1/responses", "/v1/chat/completions", "/v1/messages"],
				pricing: null,
			}),
		];

		const normalized = normalizeModels(rawModels);
		const { chatModels, responseModels } = categorizeModels(normalized, rawModels);

		const ids = normalized.map((m) => m.id);
		expect(ids).not.toContain("veo-3.1-lite");
		expect(ids).not.toContain("flux-2-pro");
		expect(ids).not.toContain("elevenlabs-v3");
		expect(ids).not.toContain("assistant"); // utility bot excluded
		expect(ids).toContain("gpt-5.4");
		expect(ids).toContain("gemma-4-31b-t");

		expect(chatModels.map((m) => m.id)).toContain("gpt-5.4");
		expect(chatModels.map((m) => m.id)).toContain("gemma-4-31b-t");
		expect(responseModels.map((m) => m.id)).toContain("gpt-5.4");
		expect(responseModels.map((m) => m.id)).not.toContain("gemma-4-31b-t"); // no reasoning
	});
});
