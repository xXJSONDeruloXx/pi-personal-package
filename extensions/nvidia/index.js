const MODEL_OVERRIDES = {
  // NVIDIA's model catalog currently omits metadata for this model.
  // The effective limit on this route behaves like a prompt-token window, so
  // keep the registered context in sync and track context usage against prompt
  // tokens so pi compacts before that window is exceeded. Also keep output
  // tokens conservative to avoid oversized completion requests.
  "z-ai/glm-5.1": {
    contextWindow: 193000,
    maxTokens: 8192,
    trackPromptTokens: true,
  },
};

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const RATE_LIMIT_TTL_MS = 30000;
const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "trace-id", "x-trace-id", "x-correlation-id"];

function getContextWindow(model, override) {
  return override?.contextWindow ?? model.context_length ?? model.max_model_len ?? DEFAULT_CONTEXT_WINDOW;
}

function getMaxTokens(model, override, contextWindow) {
  const outputCap =
    override?.maxTokens ?? model.max_output_tokens ?? model.max_completion_tokens ?? model.max_tokens ?? DEFAULT_MAX_TOKENS;

  return Math.max(256, Math.min(outputCap, contextWindow));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getConfiguredFallbackIds() {
  return (process.env.NVIDIA_MODEL_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildModelDescriptor(model) {
  const override = MODEL_OVERRIDES[model.id];
  const contextWindow = getContextWindow(model, override);
  return {
    id: model.id,
    name: model.id,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: getMaxTokens(model, override, contextWindow),
  };
}

function buildFallbackModels() {
  const ids = new Set([...Object.keys(MODEL_OVERRIDES), ...getConfiguredFallbackIds()]);
  return [...ids].map((id) => buildModelDescriptor({ id }));
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

function pickRequestId(headers) {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headerValue(headers, name);
    if (value) return value;
  }
  return undefined;
}

function parseRetryAfter(value) {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);

  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return undefined;

  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}

function trimBody(text) {
  if (typeof text !== "string") return "";
  return text.trim();
}

function summarizeBody(text, maxLength = 240) {
  const body = trimBody(text);
  if (!body) return "";
  return body.length > maxLength ? `${body.slice(0, maxLength)}…` : body;
}

function describeHttpFailure(response, bodyText) {
  const status = response.status;
  const requestId = pickRequestId(response.headers);
  const retryAfter = parseRetryAfter(headerValue(response.headers, "retry-after"));
  const body = summarizeBody(bodyText);

  if (status === 429) {
    const details = ["NVIDIA models endpoint rate limited us (429)"];
    if (retryAfter !== undefined) details.push(`retry-after=${retryAfter}s`);
    if (requestId) details.push(`request-id=${requestId}`);
    details.push(body ? `body=${JSON.stringify(body)}` : "body=<empty>");
    return details.join("; ");
  }

  return `${status} ${response.statusText}${body ? `: ${body}` : ""}`;
}

function buildRateLimitErrorMessage(meta, existingMessage) {
  const parts = ["NVIDIA API rate limit (429)"];
  if (meta.retryAfter !== undefined) parts.push(`retry after ${meta.retryAfter}s`);
  if (meta.requestId) parts.push(`request id ${meta.requestId}`);
  parts.push(meta.body ? `body ${JSON.stringify(meta.body)}` : "empty response body");

  const normalizedExisting = trimBody(existingMessage);
  if (normalizedExisting && !/rate.?limit|too many requests|429/i.test(normalizedExisting)) {
    parts.push(`original error: ${normalizedExisting}`);
  }

  return parts.join("; ");
}

export default async function (pi) {
  const apiKey = process.env.NVIDIA_API_KEY;

  if (!apiKey) {
    console.error("NVIDIA_API_KEY not set -- skipping NVIDIA provider");
    return;
  }

  const fallbackModels = buildFallbackModels();
  const recentRateLimits = new Map();

  let models;
  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const description = describeHttpFailure(response, bodyText);

      if (response.status === 429 && fallbackModels.length > 0) {
        console.warn(`Failed to fetch NVIDIA models: ${description}; using fallback model registry.`);
        models = fallbackModels;
      } else {
        console.error(`Failed to fetch NVIDIA models: ${description}`);
        return;
      }
    } else {
      const payload = await response.json();
      const seen = new Set();
      models = [];
      for (const model of payload.data ?? []) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(buildModelDescriptor(model));
      }
    }
  } catch (error) {
    console.error(`Failed to connect to NVIDIA API: ${error.message}`);
    return;
  }

  if (models.length === 0) {
    console.error("No NVIDIA models found");
    return;
  }

  pi.registerProvider("nvidia", {
    name: "NVIDIA (build.nvidia.com)",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "NVIDIA_API_KEY",
    authHeader: true,
    api: "openai-completions",
    compat: {
      supportsDeveloperRole: false,
    },
    models,
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== "nvidia") return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (event.status !== 429) {
      recentRateLimits.delete(sessionId);
      return;
    }

    const retryAfter = parseRetryAfter(headerValue(event.headers, "retry-after"));
    const requestId = pickRequestId(event.headers);
    recentRateLimits.set(sessionId, {
      status: event.status,
      retryAfter,
      requestId,
      timestamp: Date.now(),
      body: "",
    });

    const details = [`retry-after=${retryAfter ?? "n/a"}`, `request-id=${requestId ?? "n/a"}`].join(", ");
    console.warn(`NVIDIA API returned 429 for session ${sessionId} (${details})`);
  });

  pi.on("message_end", async (event, ctx) => {
    let message = event.message;
    if (message.role !== "assistant") return;
    if (message.provider !== "nvidia") return;

    const sessionId = ctx.sessionManager.getSessionId();
    const recentRateLimit = recentRateLimits.get(sessionId);
    const hasFreshRateLimit = recentRateLimit && Date.now() - recentRateLimit.timestamp <= RATE_LIMIT_TTL_MS;

    let salvagedFromStreamEnd = false;
    if (message.stopReason === "error") {
      if (hasFreshRateLimit) {
        recentRateLimits.delete(sessionId);
        return {
          message: {
            ...message,
            errorMessage: buildRateLimitErrorMessage(recentRateLimit, message.errorMessage),
          },
        };
      }

      // NVIDIA NIM (e.g. z-ai/glm) often closes the SSE stream without a
      // final finish_reason chunk, even when the model fully emitted text
      // and/or tool calls. pi-ai surfaces this as stopReason="error" with
      // errorMessage="Stream ended without finish_reason". When the message
      // actually carried content, salvage it: clear the error and fall through
      // to the normal tool-call/usage patching path below so the response is
      // usable instead of failing every turn.
      const isStreamEndError = /Stream ended without finish_reason/i.test(message.errorMessage ?? "");
      const hasToolCall = (message.content ?? []).some((b) => b.type === "toolCall");
      const hasText = (message.content ?? []).some(
        (b) => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0,
      );
      if (isStreamEndError && (hasToolCall || hasText)) {
        salvagedFromStreamEnd = true;
        message = {
          ...message,
          stopReason: hasToolCall ? "toolUse" : "stop",
          errorMessage: undefined,
        };
      } else {
        return;
      }
    }

    recentRateLimits.delete(sessionId);
    if (message.stopReason === "aborted") return;

    // Fix empty tool calls: NVIDIA/z-ai/glm-5.1 sometimes emits tool_call
    // chunks with empty id and name, resulting in "Tool not found" errors.
    // When the preceding text in the same message clearly names a tool,
    // patch the call so it can be dispatched properly.
    let patchedToolCall = false;
    const content = (message.content ?? []).map((block) => {
      if (block.type !== "toolCall") return block;
      if (block.name && block.id) return block; // already valid

      // Empty or missing name/id -- try to infer from text in this message
      const textBlocks = (message.content ?? []).filter(
        (b) => b.type === "text" && typeof b.text === "string",
      );
      const fullText = textBlocks.map((b) => b.text).join(" ");

      const knownToolNames = new Set([
        "ralph_done",
        "ralph_start",
        ...pi.getAllTools().map((tool) => tool.name),
      ]);

      // Check for exact tool names mentioned in the text.
      const mentioned = [...knownToolNames].sort((a, b) => b.length - a.length).find((name) =>
        new RegExp(`\\b${escapeRegex(name)}\\b`, "i").test(fullText),
      );

      // Also match verb patterns: "call ralph_done", "invoke the bash tool"
      const verbMatch = fullText.match(/(?:call|invoke|use)\s+(?:the\s+)?([a-z0-9_.-]+)/i);
      const inferredName =
        mentioned ??
        (verbMatch && knownToolNames.has(verbMatch[1]) ? verbMatch[1] : null);

      if (!inferredName) return block;

      patchedToolCall = true;
      return {
        ...block,
        id: block.id || `nvidia-patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: inferredName,
      };
    });

    // Also handle usage tracking for models with trackPromptTokens
    const override = MODEL_OVERRIDES[message.model];
    const needsUsagePatch =
      override?.trackPromptTokens &&
      message.usage &&
      message.usage.totalTokens !==
        (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0);

    if (salvagedFromStreamEnd || patchedToolCall || needsUsagePatch) {
      const updated = { ...message, content };
      if (needsUsagePatch) {
        const promptTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0);
        updated.usage = { ...message.usage, totalTokens: promptTokens };
      }
      return { message: updated };
    }
  });

  console.log(`NVIDIA provider registered (${models.length} models)`);
}
