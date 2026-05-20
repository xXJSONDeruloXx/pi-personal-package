const MODEL_OVERRIDES = {
  // NVIDIA's model catalog currently omits context metadata for this model.
  // The effective limit on this route behaves like a prompt-token window, so
  // keep the registered context in sync and track context usage against prompt
  // tokens so pi compacts before that window is exceeded.
  "z-ai/glm-5.1": {
    contextWindow: 193000,
    trackPromptTokens: true,
  },
};

export default async function (pi) {
  const apiKey = process.env.NVIDIA_API_KEY;

  if (!apiKey) {
    console.error("NVIDIA_API_KEY not set -- skipping NVIDIA provider");
    return;
  }

  let models;
  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      console.error(`Failed to fetch NVIDIA models: ${response.status} ${response.statusText}`);
      return;
    }

    const payload = await response.json();
    const seen = new Set();
    models = [];
    for (const model of payload.data ?? []) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      const override = MODEL_OVERRIDES[model.id];
      models.push({
        id: model.id,
        name: model.id,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: override?.contextWindow ?? model.context_length ?? 128000,
        maxTokens: model.max_model_len ?? 4096,
      });
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

  pi.on("message_end", async (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.provider !== "nvidia") return;
    if (message.stopReason === "error" || message.stopReason === "aborted") return;

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

      // Known tool names to look for in the text
      const KNOWN_TOOL_NAMES = [
        "ralph_done",
        "ralph_start",
        "bash",
        "read",
        "write",
        "edit",
        "grep",
        "find",
        "ls",
      ];

      // Check for exact tool names mentioned in the text
      const mentioned = KNOWN_TOOL_NAMES.find((name) =>
        fullText.toLowerCase().includes(name.toLowerCase()),
      );

      // Also match verb patterns: "call ralph_done", "invoke the bash tool"
      const verbMatch = fullText.match(/(?:call|invoke|use)\s+(?:the\s+)?(\w+)/i);
      const inferredName =
        mentioned ??
        (verbMatch && KNOWN_TOOL_NAMES.includes(verbMatch[1]) ? verbMatch[1] : null);

      if (!inferredName) return block;

      patchedToolCall = true;
      return {
        ...block,
        id: block.id || `nvidia-patch-${Date.now()}`,
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

    if (patchedToolCall || needsUsagePatch) {
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
