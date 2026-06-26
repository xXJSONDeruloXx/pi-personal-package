# Emulated Tool Calling — Empirical Validation & Implementation Sketch

> Companion to `../EMULATED_TOOLS_RESEARCH.md` (the theoretical research).
> This doc adds **empirical proof** that the prompt-based patterns work, plus a
> concrete, pi-API-grounded sketch for adding emulation to the `poe-provider`
> extension.

**TL;DR:** The prior research doc was theoretical. We cloned [npcpy](https://github.com/npc-worldwide/npcpy)
(an agent lib with prompt-based tool primitives), pointed it at Poe, and **proved**
that prompt-only patterns bypass Poe's `400 ... does not support tool calling`
error for non-tool-capable models. The emulated-tools feature is viable — the old
branch just lacked retry/repair loops and streaming, not the core idea.

---

## 1. The limitation (re-confirmed)

Poe rejects tool calls **at the API gateway** whenever `tools=` is present in the
request payload, for any model whose catalog lacks the `tools` feature:

```
400 Bad Request
{"error":{"message":"Model <id> does not support tool calling.
 Use a tool-capable model or remove tools from the request."}}
```

This fires *before* any agent/ACP layer. `poe-code`'s `spawn()` and pi's native
tool path both send `tools=`, so they both hit the 400. ACP / provider protocol
layers cannot fix this — only **not sending `tools=`** can.

## 2. The empirical proof

Tested three request shapes against `qwen3.5-397b-a17b-t` (free on Poe, **zero**
native tool support). Full results from `research/validate_npcy_poe.py`:

| # | Pattern | Sends `tools=`? | HTTP | Outcome |
|---|---------|:---:|:---:|---------|
| 1 | Native tool calling | ✅ | **400** | ❌ Blocked (as expected) |
| 2 | `CodingAgent` (model writes ` ```python ` blocks, host executes) | ❌ | **200** | ✅ Parsed + executed a code block from text |
| 3 | Prompt-injected tools (tools described as text; model emits JSON) | ❌ | **200** | ✅ Parsed `{tool, args}` from text, executed it |

**All three succeeded on the same free model that 400'd on native tools.** This
directly validates the prior doc's "Pattern 1: Prompt/Template-Only Pseudo-Function-Calling"
as not just feasible but reproducible against the live Poe API.

### How npcpy does it (the reference implementation)

- **`CodingAgent`** — system prompt says "write Python in fenced blocks"; the host
  regex-extracts ` ```python ... ``` ` and executes it, feeding output back for
  another round. No `tools=` ever sent. *Most reliable pattern in testing.*
- **Text-described tools** — the tool schema is rendered into the system prompt as
  prose; the model is told to emit a JSON call; the host parses (lenient,
  brace-matching) and executes. This is exactly the `<tool_calls>[...]</tool_calls>`
  format the old `poe-emulated.ts` branch used.
- **`flatten_tool_messages()`** — converts any prior `tool_calls`/`tool` roles in
  message history into plain `assistant`/`user` text, so history round-trips
  cleanly through a non-tool model.

> See npc_compiler.py `class Agent.run()` and `class CodingAgent`, plus
> gen/response.py `auto_process_tool_calls` (text-scan fallback for local models)
> and tools.py `flatten_tool_messages`.

## 3. Which models this unblocks

From `REFERENCE.md`, these confirmed-free models lack native `tools` and are
therefore **currently unusable for tool-driven pi sessions** — emulation would
unlock them at $0:

| Model | Provider | Free? | Native tools? |
|-------|----------|:---:|:---:|
| `qwen3.5-397b-a17b-t` | Together AI | ✅ | ❌ |
| `glm-5-t` | Together AI | ✅ | ❌ |
| `glm-5.1-t` | Together AI | ✅ | ❌ |
| `gemma-4-31b-t` | Together AI | ✅ | ❌ |
| `glm-5.1-fw` | Fireworks AI | ✅ | ❌ |

(`gemma-4-31b`, `kimi-k2.5-fw`, `gpt-5.3-codex-spark` are free **and** have native
tools — those don't need emulation.) The pattern: **Together-AI `-t` variants and
some Fireworks `-fw` variants are free but toolless.** Emulation is the only way
to make them agentic.

## 4. Validation methodology

Reproducing the results:

```bash
# A) Raw Poe API proof (Node, no deps beyond poe-code's auth store)
node extensions/poe-provider/research/test_poe_api_patterns.mjs

# B) End-to-end through npcpy (needs Python >= 3.10 + npcpy[lite])
#    Point LiteLLM at Poe via provider="openai-like", api_url="https://api.poe.com/v1"
python extensions/poe-provider/research/validate_npcy_poe.py
```

Both scripts live in `research/`. The Python one requires:

```bash
uv python install 3.12
cd <npcpy clone> && uv venv --python 3.12 .venv && source .venv/bin/activate
uv pip install -e ".[lite]"
```

## 5. What an addition to the extension would look like

The extension currently registers two providers (`poe`, `poe-responses`) — both
send `tools=` natively, so non-tool models 400 on any tool turn. Emulation means a
**third provider** (`poe-emulated`) that never sends `tools=` and instead converts
text ↔ tool calls at the stream boundary.

Two viable approaches, grounded in the pi extension API (`docs/extensions.md` +
`docs/custom-provider.md`).

### Approach A (recommended): custom `streamSimple` provider

This is the cleanest and matches the prior branch's architecture. A `streamSimple`
implementation owns the HTTP call, so it can strip `tools`, inject text, and —
critically — **emit `toolcall_*` stream events** when it detects a tool call in
the text. This gives real streaming + pi's normal tool-execution loop.

```typescript
// research/sketch-poe-emulated.ts  (illustrative, not wired in)
import {
  type AssistantMessage, type AssistantMessageEventStream,
  type Context, type Model, type SimpleStreamOptions,
  createAssistantMessageEventStream, calculateCost,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const TOOL_TAG = /<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/;

// 1. Render the tool catalog as TEXT instructions (the prompt-based protocol).
function toolsAsText(tools: Context["tools"]): string {
  if (!tools?.length) return "";
  const defs = tools.map(t => `- ${t.name}(${JSON.stringify(t.parameters)}): ${t.description}`);
  return [
    "You have tools. To call one, output ONLY:",
    '<tool_calls>[{"name":"<tool>","arguments":{...}}]</tool_calls>',
    "Available tools:", ...defs,
  ].join("\n");
}

// 2. Flatten any prior tool_calls/tool messages to plain text (non-tool models
//    can't replay tool roles). Mirrors npcpy's flatten_tool_messages().
function flattenToolMessages(messages: any[]): any[] { /* ...see tools.py... */ }

// 3. The custom stream: no tools= in payload, parse text into toolcall events.
function streamPoeEmulated(model: Model<any>, context: Context, options?: SimpleStreamOptions)
  : AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = { /* role, content:[], usage, stopReason... */ } as any;
    try {
      stream.push({ type: "start", partial: output });
      const body = {
        model: model.id,
        stream: true,                                  // real streaming
        messages: [
          { role: "system", content: toolsAsText(context.tools) }, // text, not tools=
          ...flattenToolMessages(context.messages),
        ],
        // NOTE: no `tools` field — this is the whole point.
      };
      const res = await fetch("https://api.poe.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.POE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: options?.signal,
      });
      // ...iterate SSE text deltas -> emit text_start/text_delta,
      //    buffer across deltas, and when TOOL_TAG closes:
      //      parse JSON, push toolcall_start/toolcall_delta(toolcall_end)
      //    (so pi runs the tool and loops as if it were native)
      stream.push({ type: "done", reason: "toolUse", message: output });
      stream.end();
    } catch (e) { /* push {type:"error"}, set stopReason */ stream.end(); }
  })();
  return stream;
}

export default function (pi: ExtensionAPI) {
  // Register a 3rd provider containing ONLY the toolless free models.
  // Emulation is opt-in: native-tool models keep using `poe`/`poe-responses`.
  pi.registerProvider("poe-emulated", {
    baseUrl: "https://api.poe.com/v1",
    apiKey: "POE_API_KEY",
    api: "openai-completions",
    authHeader: true,
    streamSimple: streamPoeEmulated,
    models: EMULATED_MODELS, // qwen3.5-397b-a17b-t, glm-5-t, gemma-4-31b-t, ...
    oauth: { /* share the same Poe oauth block as `poe` */ } as any,
  });
}
```

Usage: `pi --provider poe-emulated --model qwen3.5-397b-a17b-t`. pi's normal agent
loop calls tools exactly as if they were native.

### Approach B (lighter, no custom stream): event interception

If a full `streamSimple` is too much, two events cover most of it:

- **`before_provider_request`** — for non-tool models, delete `payload.tools` and
  append `toolsAsText(...)` to the system message. Keeps native streaming for text.
- **`message_end`** — when the finalized assistant text matches `TOOL_TAG`, return
  a **replacement message** whose content is converted from `text` blocks into
  `toolCall` blocks. pi then executes them and loops.

```typescript
pi.on("before_provider_request", (event) => {
  if (!isEmulatedModel(event)) return;            // skip native-tool models
  const p = event.payload as any;
  if (p.tools?.length) { p.messages = injectToolText(p.messages, p.tools); delete p.tools; }
  return p;
});

pi.on("message_end", (event) => {
  if (event.message.role !== "assistant" || !isEmulatedMsg(event.message)) return;
  const text = textOf(event.message);
  const m = text.match(TOOL_TAG);
  if (!m) return;
  const calls = JSON.parse(m[1]);
  return { message: { ...event.message, content: toToolCallBlocks(calls) } };
});
```

Trade-off: no streaming during the tool-call turn (the whole text buffers before
conversion), and `message_end` replacement must preserve `role` and produce valid
`toolCall` content blocks. Approach A avoids both problems.

## 6. Why the old branch "didn't work very well" — now explained

The prior `EMULATED_TOOLS_RESEARCH.md` already diagnosed this; our npcpy run
confirms it. The branch had the right architecture but missed the reliability
layer that makes prompt-only calling actually usable:

| Gap | Why it breaks | Fix (proven by npcpy) |
|-----|--------------|------------------------|
| No retry/repair | Bad JSON → parser returns null → gives up | npcpy uses a tool-loop with up to `max_iterations` rounds; feed "your JSON was invalid, retry" back |
| No schema validation | Garbage args reach the tool | Validate `arguments` against the tool's typebox schema before emitting `toolcall_end` |
| `stream:false` | 10–30s with no feedback | Approach A above streams text deltas live |
| Message history breaks | Non-tool models can't replay `tool`/`tool_calls` roles | `flatten_tool_messages()` converts them to text |
| Two competing parsers | GLM XML vs JSON-in-XML | Consolidate on one format; per-model prompt templates, not separate parsers |

## 7. Recommendations

1. **Scope emulation to toolless free models only.** Don't run it on models with
   native `tools` (worse reliability for no benefit). Build `EMULATED_MODELS` from
   the catalog: `supported_features` lacks `"tools"` **and** `pricing.request` is
   `"0.00"`/null (see `REFERENCE.md` §Pricing).
2. **Implement Approach A (`streamSimple`).** It's the only one that streams and
   emits tool calls as real events. Reuse the existing Poe OAuth block.
3. **Add the retry loop + schema validation** the old branch lacked — this is the
   difference between "doesn't work well" and production-ready. Cap at ~3 retries.
4. **Default to the CodingAgent-style format first** for models that already write
   code well (gemma/glm), since fenced-code parsing is more robust than JSON.
5. **Telemetry**: log `{model, parseSuccess, attempts, responseLen}` to find which
   free models emulate best.

## 8. Files in this folder

| File | Purpose |
|------|---------|
| `EMULATION_VALIDATION.md` | (this doc) empirical findings + implementation sketch |
| `test_poe_api_patterns.mjs` | Node: proves which request shapes 200 vs 400 on Poe |
| `validate_npcy_poe.py` | Python: end-to-end npcpy CodingAgent/tool-loop vs Poe |
| `../EMULATED_TOOLS_RESEARCH.md` | (prior) theoretical research on the 3 patterns |

---

*Validated June 2026. Built from `npcpy` (MIT) + the live Poe API + pi extension docs
(`docs/extensions.md`, `docs/custom-provider.md`).*
