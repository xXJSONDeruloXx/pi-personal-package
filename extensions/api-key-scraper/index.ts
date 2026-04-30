/**
 * API Key Scraper Extension - Fast Edition
 *
 * Lightweight GitHub secret scanner with Events API and verification
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

// Secret patterns
const SECRET_PATTERNS = [
  { name: "openai_api_key", pattern: /sk-[a-zA-Z0-9]{48}/g, verify: testOpenAIKey, severity: "high" as const },
  { name: "anthropic_api_key", pattern: /sk-ant-[a-zA-Z0-9]{32,}/g, verify: testAnthropicKey, severity: "high" as const },
  { name: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/g, severity: "critical" as const },
  { name: "stripe_live_key", pattern: /sk_live_[0-9a-zA-Z]{24,}/g, severity: "critical" as const },
  { name: "slack_token", pattern: /xox[baprs]-[0-9a-zA-Z-]{10,48}/g, severity: "high" as const },
  { name: "github_token", pattern: /ghp_[a-zA-Z0-9]{36}/g, severity: "high" as const },
  { name: "mongodb_uri", pattern: /mongodb(\+srv)?:\/\/[^:]+:[^@]+@[^/]+/g, severity: "critical" as const },
  { name: "generic_api_key", pattern: /(?:api[_-]?key|apikey)[\s]*[:=]\s*["']?[a-zA-Z0-9_\-]{32,}["']?/gi, severity: "medium" as const },
  { name: "private_key", pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/g, severity: "critical" as const },
];

// State
let scannedCount = 0;
let foundSecrets: Array<{
  pattern: string;
  value: string;
  context: string;
  severity: string;
  source: string;
}> = [];
let verifiedSecrets: Array<{
  pattern: string;
  value: string;
  valid: boolean;
  details?: string;
  source: string;
}> = [];

async function testOpenAIKey(key: string, signal: AbortSignal): Promise<{ valid: boolean; details?: string }> {
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { "Authorization": `Bearer ${key}` },
      signal,
    });
    if (response.status === 401) return { valid: false, details: "Invalid" };
    if (response.ok) {
      const data = await response.json() as { data?: unknown[] };
      return { valid: true, details: `${data.data?.length || 0} models` };
    }
    return { valid: false, details: `HTTP ${response.status}` };
  } catch (err) {
    return { valid: false, details: String(err) };
  }
}

async function testAnthropicKey(key: string, signal: AbortSignal): Promise<{ valid: boolean; details?: string }> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal,
    });
    if (response.status === 401) return { valid: false, details: "Invalid" };
    if (response.ok) {
      const data = await response.json() as { data?: unknown[] };
      return { valid: true, details: `${data.data?.length || 0} models` };
    }
    return { valid: false, details: `HTTP ${response.status}` };
  } catch (err) {
    return { valid: false, details: String(err) };
  }
}

function findSecrets(text: string, source: string): typeof foundSecrets {
  const results: typeof foundSecrets = [];
  const seen = new Set<string>();
  
  for (const pattern of SECRET_PATTERNS) {
    const matches = text.matchAll(pattern.pattern);
    for (const match of matches) {
      const value = match[0];
      if (seen.has(value)) continue;
      seen.add(value);
      
      const start = Math.max(0, (match.index || 0) - 50);
      const end = Math.min(text.length, (match.index || 0) + value.length + 50);
      
      results.push({
        pattern: pattern.name,
        value,
        context: text.slice(start, end),
        severity: pattern.severity,
        source,
      });
    }
  }
  
  return results;
}

async function verifySecret(
  secret: typeof foundSecrets[0],
  signal: AbortSignal
): Promise<typeof verifiedSecrets[0]> {
  const patternDef = SECRET_PATTERNS.find(p => p.name === secret.pattern);
  
  if (patternDef?.verify) {
    const result = await patternDef.verify(secret.value, signal);
    return {
      pattern: secret.pattern,
      value: secret.value,
      valid: result.valid,
      details: result.details,
      source: secret.source,
    };
  }
  
  return {
    pattern: secret.pattern,
    value: secret.value,
    valid: false,
    details: "No verification available",
    source: secret.source,
  };
}

async function fetchEvents(signal: AbortSignal, maxPages = 1): Promise<Array<{
  id: string;
  type: "commit" | "gist";
  url: string;
  content: string;
  repo?: string;
  sha?: string;
  gistId?: string;
}>> {
  const items: ReturnType<typeof fetchEvents> extends Promise<infer T> ? T : never = [];
  
  for (let page = 1; page <= maxPages; page++) {
    const response = await fetch(
      `https://api.github.com/events?per_page=100&page=${page}`,
      {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "pi-api-key-scraper",
        },
        signal,
      }
    );
    
    if (!response.ok) throw new Error(`GitHub API: ${response.status}`);
    
    const events = await response.json() as Array<{
      id: string;
      type: string;
      repo?: { name: string };
      payload?: {
        commits?: Array<{ sha: string; message: string }>;
        gist?: { id: string; description: string; html_url: string };
      };
    }>;
    
    for (const event of events) {
      if (event.type === "PushEvent" && event.payload?.commits) {
        for (const commit of event.payload.commits) {
          items.push({
            id: commit.sha,
            type: "commit",
            url: `https://github.com/${event.repo?.name}/commit/${commit.sha}`,
            content: commit.message,
            repo: event.repo?.name,
            sha: commit.sha,
          });
        }
      }
      
      if (event.type === "GistEvent" && event.payload?.gist) {
        const gist = event.payload.gist;
        items.push({
          id: gist.id,
          type: "gist",
          url: gist.html_url,
          content: gist.description || "",
          gistId: gist.id,
        });
      }
    }
  }
  
  return items;
}

async function fetchCommitDiff(repo: string, sha: string, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/commits/${sha}`,
      {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "pi-api-key-scraper",
        },
        signal,
      }
    );
    
    if (!response.ok) return "";
    
    const data = await response.json() as { files?: Array<{ patch?: string }> };
    return (data.files || []).map(f => f.patch || "").join("\n");
  } catch {
    return "";
  }
}

async function fetchGistContent(gistId: string, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetch(
      `https://api.github.com/gists/${gistId}`,
      {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "pi-api-key-scraper",
        },
        signal,
      }
    );
    
    if (!response.ok) return "";
    
    const data = await response.json() as { files?: Record<string, { content?: string }> };
    return Object.values(data.files || {})
      .map(f => f.content || "")
      .join("\n");
  } catch {
    return "";
  }
}

export default function apiKeyScraperExtension(pi: ExtensionAPI) {
  pi.registerCommand("scan-secrets-fast", {
    description: "Fast secret scan - Events API only",
    handler: async (args, ctx) => {
      const maxPages = parseInt(args) || 1;
      const signal = ctx.signal || new AbortController().signal;
      
      ctx.ui.notify(`Scanning ${maxPages} page(s) of GitHub events...`, "info");
      
      try {
        // Fetch events
        ctx.ui.setStatus("scanner", "Fetching events...");
        const events = await fetchEvents(signal, maxPages);
        scannedCount += events.length;
        
        ctx.ui.setStatus("scanner", `Found ${events.length} items, scanning for secrets...`);
        
        // Scan for secrets (just message content first - fast)
        let newSecrets: typeof foundSecrets = [];
        for (const event of events) {
          const secrets = findSecrets(event.content, event.url);
          newSecrets.push(...secrets);
        }
        
        // Fetch diffs for suspicious items (limit to 10)
        const toFetch = events.slice(0, 10);
        for (let i = 0; i < toFetch.length; i++) {
          ctx.ui.setStatus("scanner", `Fetching content ${i + 1}/${toFetch.length}...`);
          
          const event = toFetch[i];
          let content = "";
          
          if (event.type === "commit" && event.repo && event.sha) {
            content = await fetchCommitDiff(event.repo, event.sha, signal);
          } else if (event.type === "gist" && event.gistId) {
            content = await fetchGistContent(event.gistId, signal);
          }
          
          if (content) {
            const secrets = findSecrets(content, event.url);
            newSecrets.push(...secrets);
          }
        }
        
        // Add to global list
        foundSecrets.push(...newSecrets);
        
        ctx.ui.setStatus("scanner", `Found ${newSecrets.length} secrets, verifying...`);
        
        // Verify unique secrets (max 10)
        const uniqueSecrets = [...new Map(newSecrets.map(s => [s.value, s])).values()].slice(0, 10);
        const newVerified: typeof verifiedSecrets = [];
        
        for (let i = 0; i < uniqueSecrets.length; i++) {
          ctx.ui.setStatus("scanner", `Verifying ${i + 1}/${uniqueSecrets.length}...`);
          const result = await verifySecret(uniqueSecrets[i], signal);
          newVerified.push(result);
          
          if (result.valid) {
            ctx.ui.notify(`🚨 Valid ${result.pattern} found!`, "warning");
          }
        }
        
        verifiedSecrets.push(...newVerified);
        ctx.ui.setStatus("scanner", undefined);
        
        // Report
        const valid = newVerified.filter(v => v.valid);
        
        pi.sendMessage({
          customType: "secret-scan-report",
          content: `🔍 Scan Complete

**This scan:**
- Items scanned: ${events.length}
- Secrets found: ${newSecrets.length}
- Verified: ${newVerified.length}
- ✅ **VALID: ${valid.length}**

${valid.length > 0 ? "**Valid Secrets Found:**\n" : ""}
${valid.map(v => `- **${v.pattern}**: ${v.source}\n  Value: \`${v.value.slice(0, 20)}...\`\n  Details: ${v.details}`).join("\n")}

**Total history:**
- Total scanned: ${scannedCount}
- Total secrets found: ${foundSecrets.length}
- Total verified valid: ${verifiedSecrets.filter(v => v.valid).length}
`,
          display: true,
          details: {
            scanned: events.length,
            secretsFound: newSecrets.length,
            valid: valid.length,
            validSecrets: valid.map(v => ({
              pattern: v.pattern,
              source: v.source,
              details: v.details,
            })),
          },
        });
        
      } catch (err) {
        ctx.ui.setStatus("scanner", undefined);
        ctx.ui.notify(`Scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
  
  pi.registerCommand("show-secrets", {
    description: "Show scan history",
    handler: async (_args, ctx) => {
      const valid = verifiedSecrets.filter(v => v.valid);
      
      pi.sendMessage({
        customType: "secret-history",
        content: `📊 **Scan History**

**Totals:**
- Scanned: ${scannedCount} items
- Secrets detected: ${foundSecrets.length}
- Verified valid: ${valid.length}

${valid.length > 0 ? "**Valid Secrets:**\n" + valid.map(v => `- ${v.pattern}: ${v.source}`).join("\n") : "No valid secrets found yet."}
`,
        display: true,
      });
    },
  });
  
  pi.registerCommand("clear-secrets", {
    description: "Clear scan history",
    handler: async (_args, ctx) => {
      scannedCount = 0;
      foundSecrets = [];
      verifiedSecrets = [];
      ctx.ui.notify("History cleared", "success");
    },
  });
  
  pi.registerTool({
    name: "scan_github_secrets",
    label: "Scan GitHub Secrets",
    description: "Scan GitHub events for leaked secrets and verify them",
    parameters: Type.Object({
      maxPages: Type.Optional(Type.Number({ description: "Pages of events to scan (default: 1)" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const maxPages = Math.min(params.maxPages ?? 1, 2);
      const scanSignal = signal || new AbortController().signal;
      
      onUpdate?.({ content: [{ type: "text", text: `Scanning ${maxPages} page(s)...` }] });
      
      const events = await fetchEvents(scanSignal, maxPages);
      onUpdate?.({ content: [{ type: "text", text: `Found ${events.length} items` }] });
      
      // Quick scan
      let secrets: typeof foundSecrets = [];
      for (const event of events) {
        secrets.push(...findSecrets(event.content, event.url));
      }
      
      // Fetch diffs for first 5
      const toFetch = events.slice(0, 5);
      for (const event of toFetch) {
        let content = "";
        if (event.type === "commit" && event.repo && event.sha) {
          content = await fetchCommitDiff(event.repo, event.sha, scanSignal);
        } else if (event.type === "gist" && event.gistId) {
          content = await fetchGistContent(event.gistId, scanSignal);
        }
        if (content) {
          secrets.push(...findSecrets(content, event.url));
        }
      }
      
      onUpdate?.({ content: [{ type: "text", text: `Found ${secrets.length} potential secrets, verifying...` }] });
      
      // Verify unique
      const unique = [...new Map(secrets.map(s => [s.value, s])).values()].slice(0, 5);
      const verified: typeof verifiedSecrets = [];
      
      for (const secret of unique) {
        const result = await verifySecret(secret, scanSignal);
        verified.push(result);
        if (result.valid) {
          onUpdate?.({ content: [{ type: "text", text: `🚨 Valid ${result.pattern} found!` }] });
        }
      }
      
      const valid = verified.filter(v => v.valid);
      
      return {
        content: [{
          type: "text",
          text: `Scan complete!\n- Items: ${events.length}\n- Secrets: ${secrets.length}\n- Valid: ${valid.length}\n${valid.length > 0 ? "Valid:\n" + valid.map(v => `- ${v.pattern}: ${v.source}`).join("\n") : ""}`
        }],
        details: {
          scanned: events.length,
          secrets: secrets.length,
          valid: valid.length,
          validSecrets: valid.map(v => ({
            pattern: v.pattern,
            source: v.source,
            details: v.details,
          })),
        },
      };
    },
  });
}
