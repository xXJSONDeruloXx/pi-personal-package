export default async function (pi) {
  const apiKey = process.env.NVIDIA_API_KEY;

  if (!apiKey) {
    console.error("NVIDIA_API_KEY not set — skipping NVIDIA provider");
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
      models.push({
        id: model.id,
        name: model.id,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.context_length ?? 128000,
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

  console.log(`✓ NVIDIA provider registered (${models.length} models)`);
}
