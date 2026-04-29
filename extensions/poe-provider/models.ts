/**
 * Model normalization: convert raw Poe model objects into pi ProviderModelConfig entries.
 */

import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import type { PoeModel } from "./poe-client.js";

// ---------------------------------------------------------------------------
// Known reasoning model patterns
// ---------------------------------------------------------------------------

/** Model ID substrings that strongly indicate reasoning support */
const REASONING_PATTERNS = [
	"o1", "o3", "o4",            // OpenAI reasoning
	"deepseek-r1",               // DeepSeek R1
	"claude-3-5-sonnet",        // Claude w/ thinking
	"claude-3-7-sonnet",        // Claude w/ thinking
	"claude-4",                  // Claude 4 family
	"gemini-2.5",               // Gemini thinking
	"glm-5",                    // GLM 5.x family (thinking)
	"qwen3",                     // Qwen 3 thinking
	"reasoner",                  // Generic pattern
];

/** Model ID substrings that indicate image input support */
const IMAGE_PATTERNS = [
	"vision", "gpt-4o", "gpt-4-turbo", "claude-3", "claude-4",
	"gemini", "qwen-vl", "llava", "pixtral",
];

/** Model IDs that should be excluded (non-chat-LLM models) */
const EXCLUDE_PATTERNS = [
	// Image generation / editing
	"dall-e", "stable-diffusion", "stablediffusion", "midjourney",
	"flux-", "flux-1", "flux-2", "flux-dev", "flux-schnell", "flux-pro", "flux-fill", "flux-kontext", "flux-krea", "flux-inpaint",
	"ideogram", "imagen", "sana-t2i",
	"dreamina", "hunyuan-image", "luma-photon", "recraft",
	"seedream", "seededit", "sketch-to-image", "remove-background",
	"restyler", "retro-diffusion", "topazlabs", "trellis-3d",
	"qwen-image", "gpt-image",
	"wan2.7-image", "z-image",
	"amazon-nova-canvas", "bria-eraser", "clarity-upscaler",
	"nova-reel", "gpt-oss-",
	// Video generation
	"video", "veo-", "sora", "kling-", "runway", "mochi", "wan-2", "wan-ani",
	"pixverse", "ltx-2", "seedance", "vidu", "omnihuman",
	"pika-v", "liveportrait", "hailuo-0", "hailuo-director",
	// Audio / music / speech / voice
	"music", "audio", "tts", "whisper", "elevenlabs", "lyria", "sonic-",
	"deepgram", "cartesia", "minimax-speech", "hailuo-speech", "hailuo-live",
	// Utility bots (not chat LLMs)
	"markitdown", "gptzero", "python", "code-editor", "code-saver",
	"canvas-creator", "script-bot-creator", "deep-ai-search",
	"web-search", "exa-", "linkup-", "perplexity",
	"deepreasoning", "assistant", "interpreter", "manus",
	"happyhorse", "phoenix", "tako", "claude-code",
	"deepseek-prover", "gpt-researcher",
	// Models with no /v1/chat/completions or /v1/responses endpoint (not callable via API)
	"nano-banana",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesAny(id: string, patterns: string[]): boolean {
	const lower = id.toLowerCase();
	return patterns.some((p) => {
		// Patterns ending with '-' match prefixes; others match anywhere
		if (p.endsWith("-")) return lower.startsWith(p);
		return lower.includes(p);
	});
}

/** Clean up a Poe model ID into a human-friendly display name */
function displayName(model: PoeModel): string {
	if (model.metadata?.display_name) return model.metadata.display_name;
	if (model.name) return model.name;
	// Fallback: clean up the ID like "GPT-4o" from "gpt-4o"
	return model.id
		.split("/").pop()!
		.split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1))
		.join(" ");
}

/** Convert per-token USD pricing (string or number) to per-million-token cost */
function tokenCostToPerMillion(perToken?: number | string | null): number {
	if (perToken === undefined || perToken === null) return 0;
	const num = typeof perToken === "string" ? parseFloat(perToken) : perToken;
	if (isNaN(num)) return 0;
	return num * 1_000_000;
}

/** Determine input modalities for a Poe model */
function inferInputCapabilities(model: PoeModel): ("text" | "image")[] {
	const input: ("text" | "image")[] = ["text"];

	// Check explicit modalities first
	if (model.architecture?.input_modalities) {
		if (model.architecture.input_modalities.some((m) => m.includes("image"))) {
			input.push("image");
		}
		return input;
	}

	// Fallback to pattern matching
	if (matchesAny(model.id, IMAGE_PATTERNS)) {
		input.push("image");
	}
	return input;
}

/** Known models that support tool use (beyond what Poe reports) */
const KNOWN_TOOL_MODELS = [
	"glm-5",    // GLM 5.x family supports tools but Poe doesn't always report it
];

/** Infer whether a model supports reasoning/extended thinking */
function inferReasoning(model: PoeModel): boolean {
	// Explicit flag takes priority — Poe returns `reasoning: { required: boolean }` or `reasoning: boolean`
	if (typeof model.reasoning === "boolean") return model.reasoning;
	if (typeof model.reasoning === "object" && model.reasoning !== null) {
		// Poe returns { budget: null, required: false, supports_reasoning_effort: true }
		// A model supports reasoning if supports_reasoning_effort is true
		// (budget/required are about mandatory reasoning, not capability)
		const r = model.reasoning as { budget?: number | null; required?: boolean; supports_reasoning_effort?: boolean };
		return r.supports_reasoning_effort === true;
	}
	// Pattern-based inference
	return matchesAny(model.id, REASONING_PATTERNS);
}

/** Check if a model should be excluded from provider registration */
function shouldExclude(model: PoeModel): boolean {
	if (matchesAny(model.id, EXCLUDE_PATTERNS)) return true;

	// Exclude models that have no chat/responses/messages endpoint
	const endpoints: string[] = model.supported_endpoints ?? [];
	if (endpoints.length > 0) {
		const usable = endpoints.some((ep) =>
			ep === "/v1/chat/completions" || ep === "/v1/responses" || ep === "/v1/messages"
		);
		if (!usable) return true;
	}

	return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Convert a raw Poe model into a pi ProviderModelConfig */
export function normalizeModel(model: PoeModel): ProviderModelConfig {
	const pricing = model.pricing;
	const contextWindow = model.context_window?.context_length ?? model.context_length ?? 200000;
	const maxTokens = model.context_window?.max_output_tokens ?? 4096;

	return {
		id: model.id,
		name: displayName(model),
		reasoning: inferReasoning(model),
		input: inferInputCapabilities(model),
		cost: {
			input: tokenCostToPerMillion(pricing?.prompt),
			output: tokenCostToPerMillion(pricing?.completion),
			cacheRead: tokenCostToPerMillion(pricing?.input_cache_read),
			cacheWrite: tokenCostToPerMillion(pricing?.input_cache_write),
		},
		contextWindow,
		maxTokens,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	};
}

/**
 * Filter and normalize the raw Poe model list.
 * Excludes video/audio generation models and deduplicates.
 */
export function normalizeModels(models: PoeModel[]): ProviderModelConfig[] {
	const seen = new Set<string>();
	const result: ProviderModelConfig[] = [];

	for (const model of models) {
		if (shouldExclude(model)) continue;
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		result.push(normalizeModel(model));
	}

	return result;
}

/**
 * Split models into two categories based on supported_endpoints:
 * - chat-compatible (suitable for openai-completions)
 * - responses-capable (suitable for openai-responses)
 *
 * Uses the model's supported_endpoints field when available.
 * Falls back to reasoning flag for models that don't declare endpoints.
 */
export function categorizeModels(models: ProviderModelConfig[], rawModels?: PoeModel[]): {
	chatModels: ProviderModelConfig[];
	responseModels: ProviderModelConfig[];
} {
	// Build a lookup from raw model data if available
	const rawLookup = new Map<string, PoeModel>();
	if (rawModels) {
		for (const m of rawModels) rawLookup.set(m.id, m);
	}

	const chatModels = models.filter((m) => {
		const raw = rawLookup.get(m.id);
		if (!raw) return true; // include if no raw data
		const endpoints: string[] = raw.supported_endpoints ?? [];
		// Include if has chat/completions OR messages (Anthropic compat) endpoint, or no endpoint data
		if (endpoints.length === 0) return true;
		return endpoints.some((ep) => ep === "/v1/chat/completions" || ep === "/v1/messages");
	});

	const responseModels = models.filter((m) => {
		const raw = rawLookup.get(m.id);
		if (!raw) return m.reasoning; // fallback to reasoning flag
		const endpoints: string[] = raw.supported_endpoints ?? [];
		if (endpoints.length === 0) return m.reasoning; // no data, use reasoning
		return endpoints.some((ep) => ep === "/v1/responses");
	});

	return { chatModels, responseModels };
}
