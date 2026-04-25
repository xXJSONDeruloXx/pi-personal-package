/**
 * pi-autoupdate Extension
 *
 * Automatically checks for pi updates on startup and offers to install them.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const UPDATE_STATE_FILE = join(homedir(), ".pi", "autoupdate-state.json");
const CURRENT_VERSION_FILE = join(homedir(), ".pi", "autoupdate-current-version.txt");
const SETTINGS_FILE = join(homedir(), ".pi", "autoupdate-settings.json");

interface Settings {
  enabled: boolean;
}

function loadSettings(): Settings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const data = readFileSync(SETTINGS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch {
    // Ignore errors
  }
  return { enabled: true }; // Default to enabled
}

function saveSettings(settings: Settings): void {
  try {
    const dir = join(homedir(), ".pi");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch {
    // Ignore errors
  }
}

interface UpdateState {
  version: string;
  changelogUrl: string;
  installCommand: string;
  detectedAt: number;
}

function loadState(): UpdateState | null {
  try {
    if (existsSync(UPDATE_STATE_FILE)) {
      const data = readFileSync(UPDATE_STATE_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch {
    // Ignore errors
  }
  return null;
}

function saveState(state: UpdateState): void {
  try {
    const dir = join(homedir(), ".pi");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(UPDATE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Ignore errors
  }
}

function clearState(): void {
  try {
    if (existsSync(UPDATE_STATE_FILE)) {
      unlinkSync(UPDATE_STATE_FILE);
    }
  } catch {
    // Ignore errors
  }
}

async function getCurrentVersion(pi: ExtensionAPI): Promise<string | null> {
  try {
    const result = await pi.exec("npm", ["list", "-g", "--depth=0", "--json"], { timeout: 10000 });
    if (result.code === 0) {
      const npmData = JSON.parse(result.stdout);
      const pkg = npmData.dependencies?.["@mariozechner/pi-coding-agent"];
      if (pkg?.version) {
        return pkg.version;
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

async function getLatestVersion(pi: ExtensionAPI): Promise<string | null> {
  try {
    const result = await pi.exec("npm", ["view", "@mariozechner/pi-coding-agent", "version"], { timeout: 15000 });
    if (result.code === 0) {
      return result.stdout.trim();
    }
  } catch {
    // Ignore errors
  }
  return null;
}

// Helper: timeout wrapper for promises
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// Helper: set the update widget below the editor
function setUpdateWidget(ctx: any, updateInfo: UpdateState | null, currentVersion?: string | null): void {
  if (!ctx?.ui) return;
  
  if (updateInfo) {
    const pendingText = updateInfo.detectedAt 
      ? ` (pending since ${new Date(updateInfo.detectedAt).toLocaleDateString()})`
      : "";
    
    ctx.ui.setWidget("autoupdate", [
      `  📦 Update available: v${updateInfo.version}${pendingText}`,
      `  Run /check-update to install  •  /dismiss-update to skip`,
    ], { placement: "belowEditor" });
  } else {
    // Up to date or no update needed
    ctx.ui.setWidget("autoupdate", [
      `  ✓ pi is up to date (v${currentVersion || "unknown"})`,
    ], { placement: "belowEditor" });
  }
}

// Helper: clear the update widget
function clearUpdateWidget(ctx: any): void {
  if (ctx?.ui) {
    ctx.ui.setWidget("autoupdate", undefined);
  }
}

async function checkAndPromptForUpdate(pi: ExtensionAPI, ctx: any): Promise<void> {
  if (!ctx?.hasUI || !ctx?.ui) {
    return;
  }

  // First check if we have a pending update from a previous check
  const pendingUpdate = loadState();
  
  // Get current and latest versions
  const currentVersion = await getCurrentVersion(pi);
  const latestVersion = await getLatestVersion(pi);

  if (!latestVersion) {
    // Failed to check (network timeout) - clear status and try again later
    ctx.ui.setStatus("autoupdate", undefined);
    return;
  }

  // Check if update is needed
  const needsUpdate = currentVersion && currentVersion !== latestVersion;
  
  if (!needsUpdate && !pendingUpdate) {
    // Already up to date and no pending update - clear any existing widget
    clearUpdateWidget(ctx);
    return;
  }

  // Determine what to show
  const updateInfo: UpdateState = pendingUpdate || {
    version: latestVersion,
    installCommand: "npm install -g @mariozechner/pi-coding-agent",
    changelogUrl: "https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md",
    detectedAt: Date.now(),
  };

  // Save/update state
  saveState(updateInfo);

  // Show status and widget
  ctx.ui.setStatus("autoupdate", `Update to v${updateInfo.version} available`);
  setUpdateWidget(ctx, updateInfo, currentVersion);

  // Build message
  let message: string;
  if (pendingUpdate) {
    message = `Update to v${updateInfo.version} detected from previous session`;
  } else if (needsUpdate) {
    message = `Update available: v${currentVersion} → v${updateInfo.version}`;
  } else {
    message = `Update to v${updateInfo.version} available`;
  }

  message += `\n\nRun: ${updateInfo.installCommand}\n\nView changelog: ${updateInfo.changelogUrl}`;

  // Ask user if they want to update now - with timeout to prevent blocking startup
  // Default to "defer" if user doesn't respond within 30 seconds
  let shouldUpdate: boolean | null = null;
  try {
    shouldUpdate = await withTimeout(
      ctx.ui.confirm(`Update to v${updateInfo.version}?`, message),
      30000, // 30 second timeout
      null   // null = user didn't respond in time
    );
  } catch (err) {
    // Confirmation dialog failed (e.g., UI not ready) - defer update
    ctx.ui.notify("Update check had an issue. Run /check-update to update manually.", "info");
    ctx.ui.setStatus("autoupdate", `Update to v${updateInfo.version} pending`);
    return;
  }

  // User didn't respond in time - defer
  if (shouldUpdate === null) {
    ctx.ui.notify("Update prompt timed out. Run /check-update to update manually.", "info");
    ctx.ui.setStatus("autoupdate", `Update to v${updateInfo.version} pending`);
    return;
  }

  if (shouldUpdate) {
    ctx.ui.setStatus("autoupdate", `Updating to v${updateInfo.version}...`);
    
    try {
      const result = await pi.exec("npm", [
        "install",
        "-g",
        "@mariozechner/pi-coding-agent",
      ], { timeout: 120000 });

      if (result.code === 0) {
        clearState();
        ctx.ui.notify(`Updated to v${updateInfo.version}! Restart pi to use the new version.`, "success");
        ctx.ui.setStatus("autoupdate", `Updated to v${updateInfo.version}`);
        clearUpdateWidget(ctx);
        
        // Show success in widget briefly, then clear
        const newVersion = await getCurrentVersion(pi);
        ctx.ui.setWidget("autoupdate", [
          `  ✓ Updated to v${updateInfo.version}`,
        ], { placement: "belowEditor" });
        
        // Clear widget after 5 seconds
        setTimeout(() => clearUpdateWidget(ctx), 5000);
      } else {
        ctx.ui.notify(`Update failed: ${result.stderr || "Unknown error"}`, "error");
        ctx.ui.setStatus("autoupdate", `Update failed`);
      }
    } catch (err) {
      ctx.ui.notify(`Update error: ${err}`, "error");
      ctx.ui.setStatus("autoupdate", `Update error`);
    }
  } else {
    // User declined - keep the update state for next time
    ctx.ui.notify("Update postponed. Will ask again on next start.", "info");
  }
}

export default function (pi: ExtensionAPI) {
  // Intercept native update notifications by watching for version-related messages
  pi.on("message_end", async (event, ctx) => {
    // Check if this is an assistant message that might contain an update notification
    if (event.message?.role !== "assistant") return;
    
    const content = event.message.content;
    if (!content || !Array.isArray(content)) return;
    
    // Extract text from content array
    let messageText = "";
    for (const item of content) {
      if (item.type === "text" && item.text) {
        messageText += item.text;
      }
    }
    
    // Check for update-related keywords in the message
    const isUpdateMessage = messageText.match(/new version|update available|version.*available|you'?re using/i);
    if (!isUpdateMessage) return;
    
    // Look for version numbers in the message
    const versionMatch = messageText.match(/(\d+\.\d+\.\d+)/);
    if (!versionMatch) return;
    
    const newVersion = versionMatch[1];
    
    // Ask user if they want to update
    const shouldUpdate = await ctx.ui.confirm(
      `Update to v${newVersion}?`,
      `A new version of pi is available. Would you like to update now?\n\nAfter updating, restart pi to use the new version.`
    );
    
    if (shouldUpdate) {
      ctx.ui.setStatus("autoupdate", `Updating to v${newVersion}...`);
      
      try {
        const result = await pi.exec("npm", [
          "install",
          "-g",
          "@mariozechner/pi-coding-agent",
        ], { timeout: 120000 });

        if (result.code === 0) {
          ctx.ui.notify(`Updated to v${newVersion}! Restart pi to use the new version.`, "success");
          ctx.ui.setStatus("autoupdate", `Updated to v${newVersion}`);
        } else {
          ctx.ui.notify(`Update failed: ${result.stderr || "Unknown error"}`, "error");
          ctx.ui.setStatus("autoupdate", `Update failed`);
        }
      } catch (err) {
        ctx.ui.notify(`Update error: ${err}`, "error");
        ctx.ui.setStatus("autoupdate", `Update error`);
      }
    } else {
      ctx.ui.notify("Update postponed. Run /check-update to update later.", "info");
    }
  });

  // Register command to toggle autoupdate on/off
  pi.registerCommand("autoupdate", {
    description: "Toggle pi autoupdate on/off or show current status",
    handler: async (args, ctx) => {
      if (args === "on") {
        saveSettings({ enabled: true });
        ctx.ui.notify("pi autoupdate enabled", "success");
        ctx.ui.setStatus("autoupdate", "enabled");
      } else if (args === "off") {
        saveSettings({ enabled: false });
        ctx.ui.notify("pi autoupdate disabled", "info");
        ctx.ui.setStatus("autoupdate", "disabled");
        clearUpdateWidget(ctx);
      } else {
        // Show current status
        const settings = loadSettings();
        const status = settings.enabled ? "enabled" : "disabled";
        ctx.ui.notify(`pi autoupdate is ${status}`, "info");
        ctx.ui.setStatus("autoupdate", status);
      }
    },
  });

  // Check for updates on session start (only if enabled)
  // Note: Auto-check is disabled by default to avoid blocking on slow npm.
  // Run /check-update manually to check for updates.
  pi.on("session_start", async (_event, ctx) => {
    const settings = loadSettings();
    if (!settings.enabled) {
      ctx.ui?.setStatus("autoupdate", "disabled");
      clearUpdateWidget(ctx);
      return;
    }
    
    // Check for pending updates from previous session and show widget
    const pendingUpdate = loadState();
    if (pendingUpdate) {
      ctx.ui?.setStatus("autoupdate", `Update to v${pendingUpdate.version} pending`);
      setUpdateWidget(ctx, pendingUpdate);
    } else {
      // No pending updates - clear any old status
      ctx.ui?.setStatus("autoupdate", undefined);
      clearUpdateWidget(ctx);
    }
  });

  // Register command to check for updates
  pi.registerCommand("check-update", {
    description: "Check for pi updates and install if available",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("autoupdate", "Checking for updates...");
      
      const currentVersion = await getCurrentVersion(pi);
      const latestVersion = await getLatestVersion(pi);

      if (!latestVersion) {
        ctx.ui.notify("Failed to check for updates", "error");
        ctx.ui.setStatus("autoupdate", undefined);
        clearUpdateWidget(ctx);
        return;
      }

      if (currentVersion === latestVersion) {
        ctx.ui.notify(`pi is up to date (v${currentVersion})`, "success");
        ctx.ui.setStatus("autoupdate", undefined);
        clearState(); // Clear any stale pending state
        setUpdateWidget(ctx, null, currentVersion);
        
        // Clear widget after 5 seconds
        setTimeout(() => clearUpdateWidget(ctx), 5000);
        return;
      }

      // Update available
      ctx.ui.notify(`Update available: v${currentVersion} → v${latestVersion}`, "info");

      const updateInfo: UpdateState = {
        version: latestVersion,
        installCommand: "npm install -g @mariozechner/pi-coding-agent",
        changelogUrl: "https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md",
        detectedAt: Date.now(),
      };
      saveState(updateInfo);
      setUpdateWidget(ctx, updateInfo, currentVersion);

      const shouldUpdate = await ctx.ui.confirm(
        `Update to v${latestVersion}?`,
        `Current: v${currentVersion}\nRun: npm install -g @mariozechner/pi-coding-agent\n\nView changelog: ${updateInfo.changelogUrl}`
      );

      if (shouldUpdate) {
        ctx.ui.setStatus("autoupdate", `Updating to v${latestVersion}...`);
        
        const result = await pi.exec("npm", [
          "install",
          "-g",
          "@mariozechner/pi-coding-agent",
        ], { timeout: 120000 });

        if (result.code === 0) {
          clearState();
          ctx.ui.notify(`Updated to v${latestVersion}! Restart pi to use it.`, "success");
          ctx.ui.setStatus("autoupdate", `Updated to v${latestVersion}`);
          
          // Show success in widget briefly
          ctx.ui.setWidget("autoupdate", [
            `  ✓ Updated to v${latestVersion}`,
          ], { placement: "belowEditor" });
          setTimeout(() => clearUpdateWidget(ctx), 5000);
        } else {
          ctx.ui.notify(`Update failed: ${result.stderr || "Unknown error"}`, "error");
          ctx.ui.setStatus("autoupdate", `Update failed`);
        }
      } else {
        ctx.ui.notify("Update saved for next session", "info");
        ctx.ui.setStatus("autoupdate", `Update to v${latestVersion} pending`);
      }
    },
  });

  // Register command to clear pending update
  pi.registerCommand("clear-update", {
    description: "Clear any pending pi update",
    handler: async (_args, ctx) => {
      const state = loadState();
      if (state) {
        clearState();
        ctx.ui.notify(`Cleared pending update to v${state.version}`, "info");
      } else {
        ctx.ui.notify("No pending updates", "info");
      }
      ctx.ui.setStatus("autoupdate", undefined);
      clearUpdateWidget(ctx);
    },
  });

  // Register command to dismiss update for current version
  pi.registerCommand("dismiss-update", {
    description: "Dismiss update notification for the current latest version",
    handler: async (_args, ctx) => {
      const latestVersion = await getLatestVersion(pi);
      if (latestVersion) {
        // Save current latest version so we don't prompt until a NEW version comes out
        try {
          const dir = join(homedir(), ".pi");
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(CURRENT_VERSION_FILE, latestVersion);
        } catch {
          // Ignore
        }
        clearState();
        ctx.ui.notify(`Dismissed update to v${latestVersion}`, "info");
        ctx.ui.setStatus("autoupdate", undefined);
        clearUpdateWidget(ctx);
        
        // Show dismissed status briefly
        const currentVersion = await getCurrentVersion(pi);
        ctx.ui.setWidget("autoupdate", [
          `  ⏭️  Update dismissed until next release`,
        ], { placement: "belowEditor" });
        setTimeout(() => clearUpdateWidget(ctx), 5000);
      }
    },
  });
}
