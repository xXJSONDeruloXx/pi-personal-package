#!/usr/bin/env node
/*
 * Reference test: prove which request patterns bypass Poe's 400 tool error.
 *
 * Runs three probes against the Poe /v1/chat/completions endpoint using a model
 * that has NO native tool support (qwen3.5-397b-a17b-t, free on Poe):
 *   1. Native tool calling (sends tools=)         -> expect 400 BLOCKED
 *   2. CodingAgent pattern (no tools=, code blocks)-> expect 200 + parseable code
 *   3. Prompt-injected tools (JSON emission)       -> expect 200 + parseable JSON
 *
 * Run: POE_API_KEY env or it falls back to poe-code's auth store.
 *
 * Companion to EMULATION_VALIDATION.md in this folder.
 */

const NON_TOOL_MODEL = "qwen3.5-397b-a17b-t"; // FREE but no native tool support

async function getApiKey() {
  // 1) Explicit env var wins.
  if (process.env.POE_API_KEY) return process.env.POE_API_KEY.trim();
  // 2) Otherwise fall back to poe-code's encrypted auth store, if available.
  try {
    const storePath = process.env.POE_AUTH_STORE
      ?? "/Users/kurt/Developer/poe-code/node_modules/auth-store/dist/index.js";
    const { createSecretStore } = await import(storePath);
    const secretStore = createSecretStore({
      backendEnvVar: "POE_AUTH_BACKEND",
      fileStore: {
        salt: "poe-code:encrypted-file-auth-store:v1",
        defaultDirectory: ".poe-code",
        defaultFileName: "credentials.enc",
      },
    });
    return (await secretStore.store.get()).trim();
  } catch {
    throw new Error("No POE_API_KEY env var and poe-code auth store unavailable.");
  }
}

async function callPoe(apiKey, { system, user, tools = null }) {
  const body = {
    model: NON_TOOL_MODEL,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
    max_tokens: 300,
    stream: false,
  };
  if (tools) body.tools = tools; // only set when we WANT to trigger the native path

  const res = await fetch("https://api.poe.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json };
}

async function main() {
  const apiKey = await getApiKey();
  console.log(`Model under test: ${NON_TOOL_MODEL} (FREE, no native tools)\n`);

  // ---- TEST 1: native tools (should FAIL with 400) ----
  console.log("TEST 1 — Native tool calling (sends tools= to API)");
  const t1 = await callPoe(apiKey, {
    system: "You are a helpful assistant.",
    user: "What is the current date?",
    tools: [{
      type: "function",
      function: {
        name: "get_date",
        description: "Get current date",
        parameters: { type: "object", properties: {} },
      },
    }],
  });
  console.log(`  HTTP ${t1.status}: ${t1.status === 400 ? "BLOCKED (as expected)" : "OK"}`);
  if (t1.json?.error) console.log(`  -> ${t1.json.error.message?.slice(0, 90)}\n`);

  // ---- TEST 2: CodingAgent pattern (NO tools=, code in fenced blocks) ----
  console.log("TEST 2 — CodingAgent pattern (no tools=, model writes python blocks)");
  const t2 = await callPoe(apiKey, {
    system:
      "You are a coding agent. Write Python code in fenced ```python blocks. " +
      "The code will be automatically executed and the output fed back to you.",
    user: "List the files in /tmp that end in .txt. Write runnable python to do it.",
  });
  console.log(`  HTTP ${t2.status}: ${t2.status === 200 ? "OK" : "FAILED"}`);
  const codeMatch = t2.json?.choices?.[0]?.message?.content?.match(/```python\n([\s\S]*?)```/);
  if (codeMatch) {
    console.log(`  ✅ Parsed code block from TEXT response:`);
    console.log(`     ${codeMatch[1].trim().split("\n").slice(0,3).join("\n     ")}`);
  } else {
    console.log(`  ❌ No code block found in response`);
    console.log(`     raw: ${(t2.json?.choices?.[0]?.message?.content || "").slice(0,120)}`);
  }
  console.log();

  // ---- TEST 3: Prompt-injected tools (describe tools as text, ask for JSON) ----
  console.log("TEST 3 — Prompt-injected tools (tools described in prompt, JSON output)");
  const t3 = await callPoe(apiKey, {
    system:
      "You have access to a tool called list_files(path) which lists files in a directory.\n" +
      "To use a tool, respond with ONLY a JSON object: {\"tool\": \"list_files\", \"args\": {\"path\": \"/tmp\"}}\n" +
      "If you don't need a tool, answer normally.",
    user: "What files are in /tmp?",
  });
  console.log(`  HTTP ${t3.status}: ${t3.status === 200 ? "OK" : "FAILED"}`);
  const content = t3.json?.choices?.[0]?.message?.content || "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`  ✅ Parsed tool call from TEXT: ${JSON.stringify(parsed)}`);
    } catch {
      console.log(`  ❓ Found JSON-like text but failed to parse: ${jsonMatch[0].slice(0,100)}`);
    }
  } else {
    console.log(`  ❌ No JSON tool call found: ${content.slice(0,120)}`);
  }
  console.log();

  console.log("CONCLUSION:");
  console.log("  Native tools -> 400 (blocked by Poe for non-tool models)");
  console.log("  Prompt-based patterns (no tools=) -> work on the SAME free model");
}

main().catch((e) => console.error("Fatal:", e));
