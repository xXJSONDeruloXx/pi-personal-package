# Poe Provider Extension — API Reference & Implementation Notes

> Companion docs for the `poe-provider` extension. Covers the live Poe API surface
> we rely on, findings from our audit (April 2026), and how the extension maps
> Poe concepts into pi's provider/tool/command system.

---

## Table of Contents

1. [Poe API Endpoints](#poe-api-endpoints)
2. [Model Catalog Schema](#model-catalog-schema)
3. [Pricing Field Details](#pricing-field-details)
4. [Timestamp Units](#timestamp-units)
5. [Usage History & Balance](#usage-history--balance)
6. [OAuth Flow](#oauth-flow)
7. [Provider Registration in pi](#provider-registration-in-pi)
8. [Extension Architecture](#extension-architecture)
9. [Audit Findings & Fixes (April 2026)](#audit-findings--fixes-april-2026)
10. [Known Gaps & Future Work](#known-gaps--future-work)

---

## Poe API Endpoints

| Endpoint | Auth | Method | Description |
|---|---|---|---|
| `https://api.poe.com/v1/models` | No | GET | Public model catalog |
| `https://api.poe.com/v1/chat/completions` | Bearer | POST | OpenAI Chat Completions |
| `https://api.poe.com/v1/responses` | Bearer | POST | OpenAI Responses API |
| `https://api.poe.com/v1/messages` | Bearer | POST | Anthropic Messages API (Claude models only) |
| `https://api.poe.com/v1/images` | Bearer | POST | Image generation |
| `https://api.poe.com/v1/videos` | Bearer | POST | Video generation |
| `https://api.poe.com/v1/audio` | Bearer | POST | Audio generation |
| `https://api.poe.com/usage/current_balance` | Bearer | GET | Point balance + plan details |
| `https://api.poe.com/usage/points_history` | Bearer | GET | Usage history (30-day) |
| `https://poe.com/oauth/authorize` | — | Browser | OAuth authorize |
| `https://api.poe.com/token` | — | POST | OAuth token exchange |

Official docs: <https://creator.poe.com/api-reference/overview>

---

## Model Catalog Schema

`GET /v1/models` returns `{ object: "list", data: PoeModel[] }`.

### PoeModel (full observed shape)

```typescript
interface PoeModel {
  id: string;
  object: "model";
  created: number;                    // Unix ms (approx; varies)
  root: string;                       // Base model ID

  name?: string;
  description?: string;
  owned_by?: string;                  // e.g. "Anthropic", "OpenAI", "Google"

  metadata?: {
    display_name?: string;            // e.g. "Claude-Sonnet-4.6"
    image?: { url: string; alt: string; width: number; height: number };
    url?: string;                     // e.g. "https://poe.com/claude-sonnet-4.6"
  };

  architecture?: {
    input_modalities?: string[];      // ["text", "image", "video", "audio"]
    output_modalities?: string[];     // ["text"], ["text", "image"]
    modality?: string;               // "text,image->text"
  };

  // Context: context_window is canonical; context_length is deprecated but present
  context_window?: {
    context_length?: number;          // Max total context tokens
    max_output_tokens?: number;       // Max generation tokens
  };
  context_length?: number;           // Deprecated; many models only have this

  pricing?: Pricing | null;          // See Pricing section below

  reasoning?: Reasoning | null;      // See below

  parameters?: ModelParameter[];      // Per-model tunable params

  supported_endpoints?: string[];     // See below
  supported_features?: string[];     // ["tools", "web_search"]
}
```

### Reasoning

```typescript
type Reasoning = {
  budget: number | null;
  required: boolean;
  supports_reasoning_effort: boolean;  // TRUE = model accepts reasoning effort
};
```

The `reasoning` field is `null` for non-reasoning models. **Never** a bare `boolean`
in the current catalog — always `object | null`.

**Key insight:** `required: false` doesn't mean the model can't reason; it means
reasoning is optional. `supports_reasoning_effort: true` is the signal that the
model accepts configurable reasoning effort. Some models (e.g. `grok-3-mini`) have
`supports_reasoning_effort: true` but no `/v1/responses` endpoint — they use
reasoning via Chat Completions instead.

### ModelParameter

```typescript
interface ModelParameter {
  name: string;                       // e.g. "web_search", "reasoning_effort"
  schema: object;                     // JSON Schema for the parameter
  default_value: unknown;
  description?: string;
}
```

### supported_endpoints

Observed endpoint combinations and their counts (as of April 2026, 379 models):

| Endpoints | Count | Notes |
|---|---|---|
| `[]` (empty) | 278 | Most models! Free/3rd-party often omit this |
| `["/v1/responses", "/v1/chat/completions", "/v1/messages"]` | 60 | Major first-party models |
| `["/v1/chat/completions", "/v1/messages"]` | 14 | Some Claude/OpenAI without responses |
| `["/v1/chat/completions"]` | 4 | Mistral family |
| `["/v1/videos"]` | 15 | Video gen only |
| `["/v1/images"]` | 3 | Image gen only |
| `["/v1/chat/completions", "/v1/images", "/v1/responses"]` | 2 | Nano-banana-pro etc |
| Other combos | 3 | Audio, mixed image+responses |

**278 models have `supported_endpoints: []`** — this doesn't mean they're unusable.
Many are still callable via `/v1/chat/completions` even without declaring it.
However, models that *do* declare endpoints but only list `/v1/videos`,
`/v1/images`, or `/v1/audio` are definitely not chat LLMs.

### supported_features

Only two values observed:
- `"tools"` — model supports OpenAI-style tool/function calling
- `"web_search"` — model supports web search via `web_search_preview` tool

There is **no** `"structured_output"` or `"vision"` feature flag.
Derive vision from `architecture.input_modalities` instead.

---

## Pricing Field Details

### Pricing shape

```typescript
type Pricing = {
  prompt?: string | number | null;           // Per-token USD cost (input)
  completion?: string | number | null;       // Per-token USD cost (output)
  image?: string | number | null;            // Per-image USD cost
  request?: string | number | null;          // Per-request point cost
  input_cache_read?: string | number | null; // Per-token cache read
  input_cache_write?: string | number | null;// Per-token cache write
};
```

**Critical notes:**
- Values are **strings** in the API (e.g. `"0.0000042929"`), not numbers.
  Our `tokenCostToPerMillion()` must `parseFloat()` them.
- The field names are `prompt` / `completion`, **not** `input_tokens` / `output_tokens`.
  (Those old names never appear in the live API.)
- `request` is in **Poe points**, not USD. When `request: "0.00"`, the model is
  confirmed free on the API.
- `null` means "not applicable" (e.g. no image pricing for a text-only model).

### Pricing classification

| Condition | Classification | Count | API cost |
|---|---|---|---|
| `pricing === null` | Likely free | ~190 | Free on Poe app; API cost ambiguous per docs |
| All pricing fields `null` or `"0.00"` | Confirmed free | 9 | Definitely $0 |
| Any field > 0 | Paid | ~180 | Costs points per request |

**Confirmed-free models** (all pricing fields null or zero):

| Model ID | Provider | request field |
|---|---|---|
| `gemma-4-31b` | Google | `"0.00"` |
| `gemma-4-31b-t` | Together AI | `"0.00"` |
| `glm-5-t` | Together AI | `"0.00"` |
| `glm-5.1-t` | Together AI | `"0.00"` |
| `glm-5.1-fw` | Fireworks AI | `null` |
| `gpt-5.3-codex-spark` | OpenAI | `"0.00"` |
| `kimi-k2.5-fw` | Fireworks AI | `"0.00"` |
| `qwen3.5-397b-a17b-t` | Together AI | `"0.00"` |
| `minimax-m2.7-fw` | Fireworks AI | `null` |

### Cost calculation

Poe pricing is per-token USD (not per-million). To get per-million cost:

```
cost_per_million = parseFloat(pricing.prompt) * 1_000_000
```

For the `request` field, the unit is Poe points (not USD).

---

## Timestamp Units

**This was a bug we fixed.** Poe returns **microseconds** since epoch in several
places, not seconds or milliseconds:

| Field | Unit | To get JS Date |
|---|---|---|
| `PoeHistoryEntry.creation_time` | Microseconds | `new Date(val / 1000)` |
| `PoeBalanceResponse.points_cycle_start_time` | Microseconds | `new Date(val / 1000)` |
| `PoeBalanceResponse.next_daily_grant_time` | Microseconds | `new Date(val / 1000)` |

The old code used `new Date(val * 1000)` which produced `Invalid Date` because
microseconds × 1000 overflows the JS date range.

---

## Usage History & Balance

### Balance response (full shape)

```typescript
interface PoeBalanceResponse {
  current_point_balance: number;
  plan_points_balance?: number;
  addon_point_balance?: number;
  plan_balance_usd?: string;          // e.g. "0.30"
  addon_balance_usd?: string;
  total_balance_usd?: string;
  points_cycle_start_time?: number;   // Microseconds!
  next_daily_grant_time?: number;     // Microseconds!
  next_monthly_grant_time?: number;
  next_daily_grant_amount?: number;   // Points
  next_monthly_grant_amount?: number;
  auto_recharge?: {
    enabled: boolean;
    status: string;                   // "never_enabled" | "enabled" | etc
    threshold_points: number;
    threshold_usd: string;
    refill_points: number;
    refill_usd: string;
    last_recharge_failure_time: number | null;
  };
}
```

### History response

`GET /usage/points_history?limit=N&starting_after=CURSOR`

- `limit`: max 100 (default 20)
- `starting_after`: `query_id` of last entry for pagination
- History covers up to 30 days

```typescript
interface PoeHistoryEntry {
  creation_time: number;              // MICROSECONDS!
  bot_name: string;
  query_id: string;
  cost_points: number;
  cost_usd: number | string;         // Can be string "0.00" or number
  cost_breakdown_in_points?: Record<string, string>;
  // Keys: "Input", "Output", "Cache write", "Cache discount", "Total"
  // Values: "450 points (5290 tokens)" — human-readable strings!
  usage_type: string;                // "API" | "Chat" | "Canvas App"
  chat_name?: string;                // Only when usage_type == "Chat"
  canvas_tab_name?: string;          // Only when usage_type == "Canvas App"
  api_key_name?: string;             // Only when usage_type == "API"
}

interface PoeHistoryResponse {
  data: PoeHistoryEntry[];
  has_more: boolean;
  length?: number;
}
```

---

## OAuth Flow

Poe uses OAuth 2.0 Authorization Code + PKCE. There is **no refresh token grant**.

1. Generate PKCE `code_verifier` + `code_challenge` (S256)
2. Open browser to `https://poe.com/oauth/authorize` with params:
   - `client_id`, `redirect_uri`, `response_type=code`, `scope=apikey:create`
   - `code_challenge`, `code_challenge_method=S256`
3. Receive `code` via local callback server
4. Exchange `POST https://api.poe.com/token` with:
   - `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`, `code_verifier`
5. Response: `{ api_key: string, api_key_expires_in: number | null }`

The result is an **API key**, not an access/refresh token pair.
When `api_key_expires_in` is null, the key doesn't expire.

**For users without a registered OAuth client** (`POE_CLIENT_ID`), the extension
falls back to prompting for an API key directly.

---

## Provider Registration in pi

The extension registers **two** pi providers from the same base URL:

### 1. `poe` (openai-completions)

Models that have `/v1/chat/completions` or `/v1/messages` in their
`supported_endpoints`, or have no endpoint data at all (assumed compatible).

### 2. `poe-responses` (openai-responses)

Models that have `/v1/responses` in their `supported_endpoints`.
For models with no endpoint data, falls back to the `reasoning` flag
(`supports_reasoning_effort === true`).

Both providers share the same `apiKey: "POE_API_KEY"` so pi reuses OAuth
credentials across them.

### Model filtering

The extension **excludes** non-chat models using pattern matching
(`EXCLUDE_PATTERNS`) and endpoint checking. Models that declare only
`/v1/images`, `/v1/videos`, or `/v1/audio` endpoints are excluded.

### cost mapping

Poe's per-token USD pricing → pi's per-million-token cost:

```
pi.cost.input  = poe.pricing.prompt * 1_000_000
pi.cost.output = poe.pricing.completion * 1_000_000
pi.cost.cacheRead  = poe.pricing.input_cache_read * 1_000_000
pi.cost.cacheWrite = poe.pricing.input_cache_write * 1_000_000
```

### compat settings

Currently set conservatively:

```typescript
compat: {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
}
```

**Potential improvement:** Models with `reasoning.supports_reasoning_effort`
could set `supportsReasoningEffort: true`. Poe docs say `reasoning_effort` is
ignored on Chat Completions but works via `extra_body`; the Responses API handles
it natively.

---

## Extension Architecture

```
extensions/poe-provider/
├── index.ts        # Main extension: providers, commands, tools, events
├── models.ts       # Model normalization, filtering, categorization
├── poe-client.ts   # HTTP client for Poe API endpoints
└── oauth.ts        # OAuth2/PKCE login flow
```

### Commands (`/poe`)

| Subcommand | Auth? | Description |
|---|---|---|
| `balance` | Yes | Point balance, plan/addon breakdown, next grant |
| `history [N]` | Yes | Usage history (N entries, default 10) |
| `models [query]` | No | Search model catalog with pricing + endpoints |
| `free [query]` | No | List zero-cost models (confirmed + likely free) |
| `refresh` | Yes | Force-refresh catalog + balance cache |
| `account` | Yes | Full account info including auto-recharge |
| `login` | — | OAuth or API key entry instructions |
| `logout` | — | Clear session credentials |

### LLM-callable tools

| Tool | Description |
|---|---|
| `poe_get_balance` | Current point balance |
| `poe_list_models` | Search model catalog |
| `poe_get_usage_history` | Recent usage with pagination |

### Footer badges

- `poe-balance` — Current point balance
- `poe-turn-cost` — Last turn's model + point cost

### Caching

| Resource | TTL | Invalidation |
|---|---|---|
| Model catalog | 1 hour | `/poe refresh` |
| Point balance | 5 minutes | `/poe refresh`, `agent_end` |

---

## Audit Findings & Fixes (April 2026)

### Bugs fixed

1. **Timestamp units** — `creation_time` is microseconds; old code used `* 1000`
   producing `Invalid Date`. Fixed to `/ 1000` (µs → ms) in all 4 locations.

2. **Wrong pricing field names** — `PoeModel.pricing` typed as `input_tokens`/
   `output_tokens` which don't exist. Real fields: `prompt`/`completion`/`image`/
   `request`/`input_cache_read`/`input_cache_write`. Values are `string|null`,
   not `number`.

3. **Cache pricing hardcoded to 0** — `cost.cacheRead`/`cacheWrite` always 0.
   Now reads from `input_cache_read`/`input_cache_write`.

4. **Context window fallback** — 222/379 models have `context_length` but not
   `context_window`. Added fallback: `context_window?.context_length ?? context_length`.

### Improvements

5. **Endpoint-aware registration** — `categorizeModels()` now uses
   `supported_endpoints` to decide chat vs responses provider. Models with no
   chat/responses/messages endpoint are excluded.

6. **`/poe balance`** — Shows plan vs add-on breakdown, USD equivalent, next
   daily grant.

7. **`/poe account`** — Shows auto-recharge status.

8. **`/poe models`** — Shows per-million-token USD pricing and supported
   API endpoints.

9. **`poe_list_models` tool** — Exposes `supportedEndpoints`,
   `supportedFeatures` (tools, web_search). Reasoning flag now checks
   `supports_reasoning_effort`.

10. **Type accuracy** — `PoeBalanceResponse`, `PoeHistoryEntry`,
    `PoeHistoryResponse` updated with full API-returned fields.

---

## Known Gaps & Future Work

### Could set `supportsReasoningEffort: true`

Models with `reasoning.supports_reasoning_effort === true` could have
`compat.supportsReasoningEffort` set to `true`. Currently all models default
to `false`. This would let pi send `reasoning_effort` to capable models.

Caveat from Poe docs: `reasoning_effort` is ignored on Chat Completions
but can be passed via `extra_body`. The Responses API handles it natively.
Setting the compat flag may only help for the `poe-responses` provider.

### `supported_features` could inform `compat`

Models with `"tools"` in `supported_features` could set compat flags for
tool calling. Models with `"web_search"` could be annotated so pi knows
they support `web_search_preview`.

### Model `parameters` not exposed

Poe models declare tunable parameters (e.g. `web_search: boolean`,
`reasoning_effort: enum`, `output_effort: enum`, `verbosity: enum`).
These aren't exposed to pi currently. They could be mapped to
per-model `compat` flags or custom tool parameters.

### `/v1/messages` (Anthropic-compatible) provider

Poe supports Anthropic Messages API for Claude models. We could register a
third `poe-messages` provider using `api: "anthropic-messages"` for models
that list `/v1/messages` in their endpoints. This might give better tool
calling and thinking support for Claude models on Poe.

### Pagination for `/poe history`

The history tool supports `startingAfter` for pagination but the command
doesn't expose it. Could add `/poe history --more` or similar.

### `pricing.request` in `cost` display

The `request` field (point cost per request) isn't shown in `/poe models`
pricing output. For free models where `request: "0.00"`, this would be useful
to display explicitly.

### Balance cache could use `plan_points_balance`

The `fetchBalance()` helper only caches `current_point_balance`. The richer
breakdown (`plan_points_balance`, `addon_point_balance`, etc.) is fetched
every time `/poe balance` or `/poe account` is called directly.

---

*Last updated: April 2026*
