import { readFileSync } from "node:fs"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

export const STASH_FILE = path.join(".pi", "stash.md")
export const DEFAULT_SHORTCUT = "alt+s"
export const SHORTCUT_KEYBINDING_ID = "pi-stash.shortcut"

export function getPendingStashPath(cwd: string): string {
  return path.join(cwd, STASH_FILE)
}

export async function savePendingStash(cwd: string, text: string): Promise<void> {
  const stashPath = getPendingStashPath(cwd)
  await mkdir(path.dirname(stashPath), { recursive: true })
  await writeFile(stashPath, text, "utf8")
}

export async function popPendingStash(cwd: string): Promise<string | null> {
  const stashPath = getPendingStashPath(cwd)

  try {
    const text = await readFile(stashPath, "utf8")
    await rm(stashPath, { force: true })
    return text
  } catch {
    return null
  }
}

type NotifyType = "info" | "warning" | "error" | "success"

type ShortcutContext = {
  cwd?: string
  ui: {
    getEditorText(): string
    setEditorText(text: string): void
    notify(message: string, type?: NotifyType): void
  }
}

type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0]

function getCwd(cwd?: string): string {
  return cwd || process.cwd()
}

function getKeybindingsPath(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".pi", "agent", "keybindings.json")
}

function normalizeShortcut(value: unknown): ShortcutKey | null {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized.length > 0 ? (normalized as ShortcutKey) : null
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = normalizeShortcut(entry)
      if (normalized !== null) {
        return normalized
      }
    }
  }

  return null
}

export function readShortcutFromKeybindings(keybindingsPath = getKeybindingsPath()): ShortcutKey | null {
  try {
    const parsed = JSON.parse(readFileSync(keybindingsPath, "utf8")) as Record<string, unknown>
    return normalizeShortcut(parsed[SHORTCUT_KEYBINDING_ID])
  } catch {
    return null
  }
}

export function resolveShortcut(keybindingsPath = getKeybindingsPath()): ShortcutKey {
  return readShortcutFromKeybindings(keybindingsPath) ?? DEFAULT_SHORTCUT
}

export default function stashExtension(pi: ExtensionAPI) {
  let armed = false

  async function restorePendingStash(ctx: ShortcutContext, notifyOnMissing: boolean): Promise<void> {
    const stashedPrompt = await popPendingStash(getCwd(ctx.cwd))

    if (stashedPrompt === null) {
      if (notifyOnMissing) {
        ctx.ui.notify("Both the editor and stash are empty", "warning")
      }
      return
    }

    ctx.ui.setEditorText(stashedPrompt)
    ctx.ui.notify("Restored stashed prompt to the editor", "info")
  }

  pi.registerShortcut(resolveShortcut(), {
    description: "Stash the current prompt, or restore a pending stash when the editor is empty",
    handler: async (ctx) => {
      const cwd = getCwd(ctx.cwd)
      const editorText = ctx.ui.getEditorText()

      if (editorText.trim().length === 0) {
        armed = false
        await restorePendingStash(ctx, true)
        return
      }

      await savePendingStash(cwd, editorText)
      armed = false
      ctx.ui.setEditorText("")
      ctx.ui.notify("Stashed prompt (auto-restores after submit)", "info")
    },
  })

  pi.on("input", async (event, ctx) => {
    if (event.source === "interactive") {
      try {
        await access(getPendingStashPath(getCwd(ctx.cwd)))
        armed = true
      } catch {
        armed = false
      }
    }

    return { action: "continue" as const }
  })

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!armed) {
      return
    }

    armed = false
    await restorePendingStash(ctx, false)
  })
}
