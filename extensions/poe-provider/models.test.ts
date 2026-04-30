import { describe, it, expect } from "vitest";
import {
	normalizeModel,
	normalizeModels,
	normalizeEmulatedModels,
	categorizeModels,
} from "./models.js";
import type { PoeModel } from "./poe-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<PoeModel> & { id: string }): PoeModel {
	return {
		object: "model",
		created: 0,
		root: overrides.id,
		...overrides,
	} as PoeModel;
}

// ---------------------------------------------------------------------------
// displayName
// ---------------------------------------------------------------------------

describe("displayName", () => {
	it("uses metadata.display_name when available", () => {
		const model = normalizeModel(makeModel({
			id: "gpt-5.4",
			metadata: { display_name: "GPT-5.4" },
		}));
		expect(model.name).toBe("GPT-5.4");
	});

	it("falls back to id when no display_name", () => {
		const model = normalizeModel(makeModel({ id: "gpt-5.4" }));
		// The fallback splits on '-' and title-cases each segment
		// "gpt-5.4" → "Gpt" + "5.4" → "Gpt 5.4"
		expect(model.name).toBe("Gpt 5.4");
	});
});

// ---------------------------------------------------------------------------
// Pricing → cost mapping
// ---------------------------------------------------------------------------

describe("cost mapping", () => {
	it("maps prompt/completion to input/output per-million", () => {
		const model = normalizeModel(makeModel({
			id: "test-model",
			pricing: {
				prompt: "0.0000042929",
				completion: "0.0000214646",
				image: null,
				request: null,
				input_cache_read: "0.0000004293",
				input_cache_write: "0.0000053662",
			},
		}));
		expect(model.cost.input).toBeCloseTo(4.2929, 2);
		expect(model.cost.output).toBeCloseTo(21.4646, 2);
		expect(model.cost.cacheRead).toBeCloseTo(0.4293, 2);
		expect(model.cost.cacheWrite).toBeCloseTo(5.3662, 2);
	});

	it("handles numeric pricing values", () => {
		const model = normalizeModel(makeModel({
			id: "test-model",
			pricing: {
				prompt: 0.0000022727,
				completion: 0.0000136364,
				request: null,
				image: null,
				input_cache_read: 0.0000002273,
				input_cache_write: null,
			},
		}));
		expect(model.cost.input).toBeCloseTo(2.2727, 2);
		expect(model.cost.output).toBeCloseTo(13.6364, 2);
		expect(model.cost.cacheRead).toBeCloseTo(0.2273, 2);
		expect(model.cost.cacheWrite).toBe(0);
	});

	it("handles null pricing (free model)", () => {
		const model = normalizeModel(makeModel({
			id: "free-model",
			pricing: null,
		}));
		expect(model.cost.input).toBe(0);
		expect(model.cost.output).toBe(0);
		expect(model.cost.cacheRead).toBe(0);
		expect(model.cost.cacheWrite).toBe(0);
	});

	it("handles pricing with all-null fields (confirmed free)", () => {
		const model = normalizeModel(makeModel({
			id: "gemma-4-31b-t",
			pricing: {
				prompt: null,
				completion: null,
				image: null,
				request: "0.00",
				input_cache_read: null,
				input_cache_write: null,
			},
		}));
		expect(model.cost.input).toBe(0);
		expect(model.cost.output).toBe(0);
	});

	it("handles string request=0.00 (free per-request)", () => {
		const model = normalizeModel(makeModel({
			id: "free-req",
			pricing: {
				prompt: null,
				completion: null,
				image: null,
				request: "0.00",
				input_cache_read: null,
				input_cache_write: null,
			},
		}));
		expect(model.cost.input).toBe(0);
		expect(model.cost.output).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Context window fallback
// ---------------------------------------------------------------------------

describe("context window", () => {
	it("uses context_window.context_length when available", () => {
		const model = normalizeModel(makeModel({
			id: "test",
			context_window: { context_length: 200000, max_output_tokens: 8192 },
		}));
		expect(model.contextWindow).toBe(200000);
		expect(model.maxTokens).toBe(8192);
	});

	it("falls back to top-level context_length", () => {
		const model = normalizeModel(makeModel({
			id: "test",
			context_length: 128000,
		}));
		expect(model.contextWindow).toBe(128000);
	});

	it("prefers context_window over context_length when both present", () => {
		const model = normalizeModel(makeModel({
			id: "test",
			context_window: { context_length: 200000, max_output_tokens: 4096 },
			context_length: 128000,
		}));
		expect(model.contextWindow).toBe(200000);
	});

	it("defaults to 200000 when neither is present", () => {
		const model = normalizeModel(makeModel({ id: "test" }));
		expect(model.contextWindow).toBe(200000);
	});

	it("defaults maxTokens to 4096 when not in context_window", () => {
		const model = normalizeModel(makeModel({ id: "test" }));
		expect(model.maxTokens).toBe(4096);
	});
});

// ---------------------------------------------------------------------------
// Reasoning inference
// ---------------------------------------------------------------------------

describe("reasoning", () => {
	it("infers reasoning from supports_reasoning_effort", () => {
		const model = normalizeModel(makeModel({
			id: "test",
			reasoning: { budget: null, required: false, supports_reasoning_effort: true },
		}));
		expect(model.reasoning).toBe(true);
	});

	it("returns false when supports_reasoning_effort is false", () => {
		const model = normalizeModel(makeModel({
			id: "test",
			reasoning: { budget: null, required: false, supports_reasoning_effort: false },
		}));
		expect(model.reasoning).toBe(false);
	});

	it("returns false when reasoning is null", () => {
		const model = normalizeModel(makeModel({
			id: "test",
			reasoning: null,
		}));
		expect(model.reasoning).toBe(false);
	});

	it("pattern-matches known reasoning models", () => {
		for (const id of ["o3-mini", "deepseek-r1-di", "claude-4-opus"]) {
			const model = normalizeModel(makeModel({ id, reasoning: null }));
			expect(model.reasoning, `${id} should match reasoning patterns`).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Input capabilities
// ---------------------------------------------------------------------------

describe("input capabilities", () => {
	it("derives image from architecture.input_modalities", () => {
		const model = normalizeModel(makeModel({
			id: "test",
			architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		}));
		expect(model.input).toContain("image");
		expect(model.input).toContain("text");
	});

	it("text-only from modalities", () => {
		const model = normalizeModel(makeModel({
			id: "test",
			architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		}));
		expect(model.input).toEqual(["text"]);
	});

	it("pattern-matches image for known models without modalities", () => {
		const model = normalizeModel(makeModel({
			id: "gpt-4o",
		}));
		expect(model.input).toContain("image");
	});

	it("text-only when no modalities or pattern match", () => {
		const model = normalizeModel(makeModel({
			id: "some-unknown-model",
		}));
		expect(model.input).toEqual(["text"]);
	});
});

// ---------------------------------------------------------------------------
// Exclusion
// ---------------------------------------------------------------------------

describe("shouldExclude", () => {
	it("excludes image generation models", () => {
		const excluded = [
			"dall-e-3", "flux-2-pro", "ideogram-v3", "gpt-image-2",
			"stable-diffusion-xl", "seedream-4.0",
		];
		const result = normalizeModels(excluded.map((id) =>
			makeModel({ id, supported_endpoints: ["/v1/images"] })
		));
		expect(result).toHaveLength(0);
	});

	it("excludes video generation models", () => {
		const excluded = ["veo-3", "sora-2", "kling-v3-pro", "runway-gen-4.5"];
		const result = normalizeModels(excluded.map((id) =>
			makeModel({ id, supported_endpoints: ["/v1/videos"] })
		));
		expect(result).toHaveLength(0);
	});

	it("excludes audio/TTS models", () => {
		const excluded = ["elevenlabs-v3", "whisper-v3-large-t", "lyria-3"];
		const result = normalizeModels(excluded.map((id) =>
			makeModel({ id, supported_endpoints: ["/v1/audio"] })
		));
		expect(result).toHaveLength(0);
	});

	it("excludes utility bots", () => {
		const excluded = ["assistant", "interpreter", "manus", "deepreasoning", "claude-code"];
		const result = normalizeModels(excluded.map((id) =>
			makeModel({ id, supported_endpoints: [] })
		));
		expect(result).toHaveLength(0);
	});

	it("excludes models with only /v1/images endpoint", () => {
		const result = normalizeModels([
			makeModel({ id: "nano-banana-2", supported_endpoints: ["/v1/images", "/v1/responses"] }),
		]);
		// nano-banana is in EXCLUDE_PATTERNS
		expect(result).toHaveLength(0);
	});

	it("does not exclude chat models with supported endpoints and legacy feature data", () => {
		const result = normalizeModels([
			makeModel({
				id: "my-chat-model",
				supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
			}),
		]);
		expect(result).toHaveLength(1);
	});

	it("excludes explicit non-tool chat models from the native provider", () => {
		const result = normalizeModels([
			makeModel({ id: "some-free-model", supported_endpoints: [], supported_features: [] }),
		]);
		expect(result).toHaveLength(0);
	});

	it("puts explicit non-tool chat models in the emulated provider", () => {
		const result = normalizeEmulatedModels([
			makeModel({ id: "some-free-model", supported_endpoints: [], supported_features: [] }),
		]);
		expect(result).toHaveLength(1);
	});

	it("does not put native tool models in the emulated provider", () => {
		const result = normalizeEmulatedModels([
			makeModel({ id: "tool-model", supported_endpoints: ["/v1/chat/completions"], supported_features: ["tools"] }),
		]);
		expect(result).toHaveLength(0);
	});

	it("deduplicates models by id", () => {
		const result = normalizeModels([
			makeModel({ id: "dup-model" }),
			makeModel({ id: "dup-model" }),
		]);
		expect(result).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// categorizeModels
// ---------------------------------------------------------------------------

describe("categorizeModels", () => {
	it("puts chat/completions models in chatModels", () => {
		const models = [
			normalizeModel(makeModel({
				id: "chat-model",
				supported_endpoints: ["/v1/chat/completions"],
			})),
		];
		const raw = [makeModel({
			id: "chat-model",
			supported_endpoints: ["/v1/chat/completions"],
		})];
		const { chatModels, responseModels } = categorizeModels(models, raw);
		expect(chatModels).toHaveLength(1);
	});

	it("puts /v1/responses models in responseModels", () => {
		const models = [
			normalizeModel(makeModel({
				id: "resp-model",
				reasoning: { budget: null, required: false, supports_reasoning_effort: true },
				supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
			})),
		];
		const raw = [makeModel({
			id: "resp-model",
			supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
		})];
		const { chatModels, responseModels } = categorizeModels(models, raw);
		expect(chatModels).toHaveLength(1);
		expect(responseModels).toHaveLength(1);
	});

	it("excludes from responseModels when no /v1/responses", () => {
		const models = [
			normalizeModel(makeModel({
				id: "chat-only",
				reasoning: null,
				supported_endpoints: ["/v1/chat/completions"],
			})),
		];
		const raw = [makeModel({
			id: "chat-only",
			supported_endpoints: ["/v1/chat/completions"],
		})];
		const { chatModels, responseModels } = categorizeModels(models, raw);
		expect(chatModels).toHaveLength(1);
		expect(responseModels).toHaveLength(0);
	});

	it("falls back to reasoning flag when no endpoint data", () => {
		const models = [
			normalizeModel(makeModel({
				id: "reasoning-no-endpoints",
				reasoning: { budget: null, required: false, supports_reasoning_effort: true },
			})),
			normalizeModel(makeModel({
				id: "plain-no-endpoints",
				reasoning: null,
			})),
		];
		const raw = [
			makeModel({ id: "reasoning-no-endpoints", supported_endpoints: [] }),
			makeModel({ id: "plain-no-endpoints", supported_endpoints: [] }),
		];
		const { responseModels } = categorizeModels(models, raw);
		expect(responseModels).toHaveLength(1);
		expect(responseModels[0].id).toBe("reasoning-no-endpoints");
	});

	it("includes /v1/messages models in chatModels", () => {
		const models = [
			normalizeModel(makeModel({
				id: "messages-model",
				supported_endpoints: ["/v1/messages"],
			})),
		];
		const raw = [makeModel({
			id: "messages-model",
			supported_endpoints: ["/v1/messages"],
		})];
		const { chatModels } = categorizeModels(models, raw);
		expect(chatModels).toHaveLength(1);
	});
});
