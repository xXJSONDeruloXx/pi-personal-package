# Emulated Tool Calling Research & Analysis

This document summarizes research on making non-tool-calling models work with tool execution in pi, analysis of the current `poe-emulated-tools` branch implementation, and recommended improvements.

---

## Web Research Findings

### Three Main Production Patterns

Based on research across LLM providers, documentation, and academic papers, there are three established approaches for implementing tool calling on models without native support:

#### 1. Prompt/Template-Only Pseudo-Function-Calling
- **Approach**: Put tool schemas/instructions directly in the system prompt or chat template
- **Execution**: Force the model to emit only a structured call object (JSON or XML), parse it client-side, execute the tool, feed result back for final answer
- **Sources**: Google's [Gemma 4 Function Calling docs](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4) demonstrate this explicitly
- **Pros**: Works with any text-completion model
- **Cons**: No guarantees on output format; requires robust parsing and retry logic

#### 2. Constrained Decoding / Structured Output Wrappers
- **Approach**: Use constrained generation to force schema-conformant outputs
- **Examples**: vLLM supports "named/required" calls with structured outputs for schema compliance
- **Pros**: Guaranteed valid JSON/schema adherence
- **Cons**: Requires inference-time control over token generation; not available via most hosted APIs

#### 3. Schema Validation + Retry/Repair Loops
- **Approach**: Accept free-form output, validate against schema, repair if invalid
- **Key Insight**: Plain JSON mode guarantees valid JSON, NOT schema adherence
- **Sources**: OpenAI docs recommend validation and retries over relying on `strict` mode
- **Pros**: Works with existing APIs
- **Cons**: Latency increases due to retry turns; may loop indefinitely with stubborn models

### Key Research Takeaways

- **Native/provider-enforced structured output is more reliable** than prompt-only approaches
- **Function-calling-tuned models** (e.g., FunctionGemma) perform significantly better than general models
- **Retry/repair loops are essential** when using non-native approaches
- Model-specific prompt templates matter - models are often trained on specific formats (GLM uses XML, Gemma uses JSON)

---

## Current Branch Implementation Analysis

### Files and Their Roles

| File | Purpose |
|------|---------|
| `poe-emulated.ts` | Core emulation logic with XML-tagged JSON format (`<tool_calls>[...]</tool_calls>`) |
| `tool-emulation.ts` | Alternative GLM-specific XML format (appears unused/deprecated) |
| `models.ts` | `normalizeEmulatedModels()` and `shouldExcludeFromEmulated()` filters |
| `index.ts` | Provider registration with `streamSimple: streamPoeEmulatedTools` |
| `poe-emulated.test.ts` | Unit tests for parsing and context conversion |

### Current Approach Details

**Request Flow:**
1. Uses **non-streaming** requests (`stream: false`) to Poe API
2. Strips native `tools` field from the API request (avoiding 400 errors)
3. Injects tool schemas as text instructions into the system prompt
4. Sends modified payload to `/v1/chat/completions`

**Response Flow:**
1. Receives text response from model
2. Parses for `<tool_calls>` XML blocks containing JSON array
3. Converts parsed tool calls back to native pi `ToolCall` format
4. Returns via `AssistantMessageEventStream` for normal pi execution

**Format Used:**
```xml
<tool_calls>
[{"name":"ls","arguments":{"path":"."}}]
</tool_calls>
```

### Dual Format Problem

The codebase contains **two competing parsing implementations**:

1. **`poe-emulated.ts`** - JSON array inside XML tags (current)
2. **`tool-emulation.ts`** - GLM-style XML with `<arg_key>`/`<arg_value>` pairs (legacy)

This creates maintenance burden and potential confusion. The GLM format was likely an earlier experiment that was abandoned in favor of JSON.

---

## Why It May Not Work Well

### 1. No Retry/Repair Loop
- If the model emits invalid JSON, there's **no recovery mechanism**
- The code returns `null` from `parseEmulatedToolCalls()` and gives up
- Should send a repair prompt back to the model for another attempt

### 2. No Constrained Decoding
- The model can emit **anything** in its response
- No guarantee it follows the `<tool_calls>` format
- No guarantee the JSON inside is valid or matches the schema

### 3. Non-Streaming = Poor UX
- `stream: false` means the user sees nothing during the API call
- Could take 10-30+ seconds with no feedback
- pi's streaming architecture is designed for real-time updates

### 4. Missing Argument Validation
- Parsed tool calls are not validated against their JSON schemas
- Invalid arguments may crash the tool execution
- No feedback to the model about what was wrong

### 5. Model-Specific Behavior
- Some models (GLM) were trained on different formats
- The JSON-in-XML format may not be optimal for all models
- No per-model prompt customization

---

## Relevant pi Extension Points

From `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, these capabilities can improve the implementation:

### `before_provider_request` Event
Intercept and modify the LLM request payload:
```typescript
pi.on("before_provider_request", (event, ctx) => {
  // Strip tools, add text instructions
  return modifiedPayload;
});
```

**Current use**: Already used in `tool-emulation.ts`, but could be enhanced to add retry prompts on repair loops.

### `message_end` Event
Intercept assistant responses to parse tool calls:
```typescript
pi.on("message_end", async (event, ctx) => {
  // Parse text for tool call patterns
  // Inject tool calls into message.content
});
```

**Current use**: The `poe-emulated.ts` approach uses `streamSimple` instead, but `message_end` could enable repair loops by sending follow-up prompts.

### `tool_call` Event
Block or modify tool calls after parsing:
```typescript
pi.on("tool_call", async (event, ctx) => {
  // Validate arguments
  // Return { block: true, reason: "Invalid args" } if needed
});
```

**Opportunity**: Add JSON schema validation here before tools execute.

### `after_provider_response` Event
Inspect raw HTTP responses:
```typescript
pi.on("after_provider_response", (event, ctx) => {
  // event.status, event.headers
  // Can detect rate limits, errors before parsing
});
```

### Custom Provider with `streamSimple`
The branch correctly uses this pattern:
```typescript
pi.registerProvider("poe-emulated", {
  baseUrl: "https://api.poe.com/v1",
  apiKey: "POE_API_KEY",
  api: "openai-completions",
  models: allEmulatedModels,
  streamSimple: streamPoeEmulatedTools,  // Custom implementation
});
```

This is the right approach for non-standard API behavior.

---

## Recommended Improvements

### 1. Add Retry/Repair Logic

When `parseEmulatedToolCalls()` returns null, send a repair prompt:

```typescript
function createRepairPrompt(originalResponse: string, format: string): string {
  return `Your previous response had an invalid tool call format.

You responded with:
${originalResponse}

Please respond ONLY with this exact format:
${format}

No prose before or after. Only the tool call block.`;
}
```

Implement a max retry limit (e.g., 3 attempts) before giving up.

### 2. Add Schema Validation

Validate tool call arguments before execution:

```typescript
import { Type } from "typebox";
import { Value } from "@sinclair/typebox/value";

function validateToolCall(call: EmulatedToolCall, tool: Tool): boolean {
  try {
    Value.Check(tool.parameters, call.arguments);
    return true;
  } catch {
    return false;
  }
}
```

If validation fails, send the error back to the model for correction.

### 3. Simplify to One Format

Remove the GLM-specific XML format in `tool-emulation.ts` and consolidate on the JSON-in-XML approach. If GLM-specific support is needed, use model-specific prompt templates instead of a completely different parsing path.

### 4. Consider Streaming with Early Detection

Instead of `stream: false`, stream the response and detect tool call patterns as they arrive:

```typescript
// As chunks arrive, buffer and look for opening <tool_calls> tag
// If found, continue buffering until closing tag
// Then parse and emit tool calls
```

This provides better UX while still being able to parse tool calls.

### 5. Per-Model Prompt Templates

Different models may respond better to different prompt formats:

```typescript
const PROMPT_TEMPLATES: Record<string, string> = {
  "glm-5-t": "Use XML format: <tool>...</tool>",
  "gemma-4": "Use JSON format: <tool_calls>[...]</tool_calls>",
  "default": "Use JSON format: <tool_calls>[...]</tool_calls>",
};
```

### 6. Use Provider-Native Structured Output (If Available)

Some Poe models support `response_format: { type: "json_object" }` even without native tool calling. This is more reliable than free-form text:

```typescript
const body = {
  model: model.id,
  messages: convertContextForEmulatedTools(context),
  response_format: { type: "json_object" },  // Force JSON output
  // ...
};
```

### 7. Telemetry and Logging

Add structured logging to understand failure modes:

```typescript
console.error(JSON.stringify({
  event: "emulated_tool_parse",
  model: modelId,
  success: calls !== null,
  responseLength: text.length,
  hasToolTag: TOOL_TAG_RE.test(text),
}));
```

---

## Key Research Sources

| Source | URL | Relevance |
|--------|-----|-----------|
| Gemma 4 Function Calling | https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4 | Google's official prompt-only tool calling guide |
| FunctionGemma Sequence | https://ai.google.dev/gemma/docs/functiongemma/full-function-calling-sequence-with-functiongemma | Complete implementation pattern |
| vLLM Tool Calling | https://docs.vllm.ai/en/latest/features/tool_calling/ | Constrained decoding approaches |
| OpenAI Structured Outputs | https://platform.openai.com/docs/guides/structured-outputs | Why schema validation matters |
| LangChain Structured Output | https://docs.langchain.com/oss/javascript/langchain/structured-output | Provider-native vs wrapper approaches |
| Vercel AI SDK Tools | https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling | Error handling and repair strategies |
| Tool Calling Research Paper | https://arxiv.org/abs/2407.04997 | Academic evidence for prompt-only feasibility |
| FunctionGemma Model Card | https://ai.google.dev/gemma/docs/functiongemma/model_card | Fine-tuned model benefits |
| Poe Tool Calling Docs | https://creator.poe.com/docs/external-applications/tool-calling | Native Poe capabilities |
| Poe OpenAI API | https://creator.poe.com/docs/external-applications/openai-compatible-api | Poe API specifics |

---

## Summary

The current `poe-emulated-tools` branch implements a valid architecture but lacks critical reliability features:

1. **Missing**: Retry/repair loops for malformed responses
2. **Missing**: Schema validation before tool execution  
3. **Missing**: Per-model prompt customization
4. **Suboptimal**: Non-streaming requests hurt UX

The pi extension system provides all necessary hooks (`before_provider_request`, `message_end`, `tool_call`) to implement these improvements. The core insight from research is that **prompt-engineered tool calling works, but requires robust error handling and validation loops** to be production-ready.

Recommended priority order:
1. Add retry/repair loop (highest impact)
2. Add schema validation
3. Consolidate to single format
4. Add per-model prompt templates
5. Explore streaming improvements
