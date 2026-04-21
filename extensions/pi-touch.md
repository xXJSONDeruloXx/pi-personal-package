# pi-touch extension notes

Path: `extensions/pi-touch.ts`

This document is the local maintenance guide for the `pi-touch` extension.
It exists so future coding agents can extend or debug the touch UI without having to rediscover the same constraints and pitfalls.

## What pi-touch does

`pi-touch` adds a phone/tablet-oriented control layer to pi's TUI:

- a **bottom touch bar** rendered below the editor
- a **top ETC overlay** with quick command/control buttons
- mouse/tap hit-testing for those controls
- a chat viewport controller (`top`, `page up/down`, `bottom`)
- startup persistence for touch-mode enabled state
- a manual escape hatch so broken touch mode does not brick pi startup

## Safety / startup rules

Touch mode should **never** be able to break pi startup permanently.

Current persistence file:
- `~/.pi/agent/pi-touch-persist.json`

Current persisted shape:

```json
{
  "enabled": true,
  "autoEnable": true
}
```

Meaning:
- `enabled`: whether touch mode should be restored on the next session
- `autoEnable`: hard kill-switch for startup restore

If touch mode ever causes startup/init problems, manually set:

```json
{
  "enabled": false,
  "autoEnable": false
}
```

Behavioral rules:
- startup restore must be wrapped so failures are swallowed
- startup failures must not prevent pi from opening normally
- shutdown cleanup should not overwrite the persisted enabled state unless explicitly intended

## Session lifecycle learnings

### `session_start` callback signature matters

The correct signature is:

```ts
pi.on("session_start", async (_event, ctx) => {
  ...
});
```

Do **not** accidentally write:

```ts
pi.on("session_start", async (ctx) => {
  ...
});
```

That bug causes `ctx` to actually be the event object, which makes `ctx.hasUI` fail and silently skips restore logic.

### Startup restore timing

Touch restore needs a small delay so the TUI is ready:

```ts
setTimeout(() => enableTouchMode(ctx as ExtensionCommandContext, false), 200)
```

A render/bootstrap trick was attempted, but the simple delayed restore matched a previously working implementation and was more reliable.

## Commands and shortcut

### Commands

Simple toggle:
- `/touch`

Advanced command namespace remains intact:
- `/pi-touch on`
- `/pi-touch off`
- `/pi-touch toggle`
- `/pi-touch status`
- `/pi-touch log`
- `/pi-touch top`
- `/pi-touch bottom`
- `/pi-touch page-up`
- `/pi-touch page-down`

### Shortcut

Current touch-mode toggle shortcut:
- `ctrl+1`

This changed several times due to conflicts with built-in bindings. If it changes again, check for built-in shortcut conflicts first.

## Current UI layout

## Bottom bar

The bottom bar is rendered as **logical groups**, and each group can internally wrap across multiple 3-line button rows.
Groups stay separate even when terminal width is wide enough to fit everything on one line.

Current bottom groups:

### Group 1
- `ETC`
- `TOP`
- `PG↑`
- `MODEL`
- `PG↓`
- `BTM`

### Group 2
- `ESC`
- `/`
- `↑`
- `↓`
- `←`
- `→`
- `↵`

## Top ETC overlay

Current ETC overlay buttons:
- `/new`
- `/reload`
- `/compact`
- `/resume`
- `/tree`
- `^C`
- `⌥ ↵`

The ETC overlay now also wraps onto additional 3-line rows when narrow, instead of truncating.

## Button categories

There are effectively **four** button kinds in the current implementation.

### 1. Command buttons
These replace editor contents with a slash command and then submit it.

Examples:
- `/new`
- `/reload`
- `/compact`
- `/resume`
- `/tree`

Typical behavior:
- `setEditorText(command)`
- send `"\r"`

### 2. Raw keystroke buttons
These send terminal bytes directly.

Examples:
- `ESC` → `\x1b`
- `↑` → `\x1b[A`
- `↓` → `\x1b[B`
- `←` → `\x1b[D`
- `→` → `\x1b[C`
- `↵` → `\r`
- `^C` → `\x03`
- `⌥ ↵` → `\x1b\r`
- `MODEL` → current model-cycle input sequence

### 3. Editor-manipulation buttons
These mutate editor state first, then often inject a real keystroke so pi reacts like the user typed something.

Current example:
- `/`

Important implementation detail:
- `setEditorText("/")` alone does **not** immediately trigger pi's command dropdown/autocomplete UI
- the working approach is:
  - `setEditorText("")`
  - then send a real `/` keystroke

That pattern matters any time the built-in UI should react as if the user typed the character.

### 4. Internal action buttons
These call extension logic directly instead of sending editor text or raw input.

Examples:
- `TOP`
- `PG↑`
- `PG↓`
- `BTM`
- `ETC`

Typical behaviors:
- `viewport.toTop()`
- `viewport.pageUp()`
- `viewport.pageDown()`
- `viewport.toBottom()`
- `toggleTopOverlay()`

Current paging behavior:
- page up/down intentionally leaves more overlap than before to reduce disorientation
- target overlap is currently `20` lines
- on very short viewports, paging still moves at least `3` lines so the control does not feel stuck

## Rendering / hit-testing model

Both bars use a rendered-box model.

### Bottom bar
Bottom bar buttons are defined in grouped arrays and rendered into one or more 3-line button rows.
Each rendered button stores bounds in `state.barButtons`:

- `action`
- `colStart`
- `colEnd`
- `rowOffset`

`rowOffset` is critical because the bottom bar may wrap.
Hit-testing checks both:
- x range (`colStart..colEnd`)
- rendered row block (`rowOffset`)

The actual rendered height is tracked in:
- `state.barActualHeight`

This must be reset when the bar is hidden/destroyed.

### Top ETC overlay
The ETC overlay now follows a similar wrapping model.
Each rendered top button stores:

- `actionLabel`
- `command?`
- `data?`
- `colStart`
- `colEnd`
- `rowOffset`

The total height is tracked in:
- `state.topActualHeight`

When the overlay is hidden, reset:
- `state.topOverlayButtons = []`
- `state.topActualHeight = BAR_HEIGHT`

## Important implementation learnings

### 1. `setEditorText()` is not the same as typing
If you want built-in pi UI to react immediately, sometimes you must send a real keystroke after manipulating editor contents.

Most important example:
- for `/` command-start behavior, clear editor then send `/` as raw input

### 2. Preserve ETC overlay after command selection
The overlay intentionally stays open after selecting ETC buttons like `/new`, `/reload`, and `/compact`.
This makes repeated touch use easier.
Do not reintroduce automatic overlay dismissal unless that UX is explicitly desired.

### 3. Wrapping requires row-aware hit-testing
Once buttons wrap, x coordinates alone are not enough.
If a future change adds more buttons and clicks start landing on the wrong target, inspect:
- `rowOffset`
- `barActualHeight`
- `topActualHeight`
- overlay/bar row calculations

### 4. Keep logical groups separate
Bottom button groups are intentionally rendered as separate blocks.
Even on wide terminals, they should not collapse into one mega-row.
This is a UX choice, not an accident.

### 5. ETC overlay auto-opens on enable
When touch mode is enabled, ETC is shown automatically.
This is intentional and makes the mode more self-sufficient.

### 6. Use `setEditorText` for command buttons instead of raw pasted text
ETC command buttons originally used raw keystroke injection, which appended into existing editor contents.
The fixed behavior is to replace editor text first, then submit.

## Current extensibility picture

The extension is only **partially data-driven** right now.

### Already data-driven
- top overlay button list
- bottom bar button group definitions
- button labels
- some top-button behavior (`command` vs `data`)

### Still switch-driven / hard-coded
- bottom bar action dispatch
- internal action handling
- some button semantics are encoded in `switch` statements instead of a unified button spec

## If extending later

A good future refactor would introduce a unified button schema, something like:

```ts
type ButtonSpec =
  | { kind: "command"; label: string; command: string }
  | { kind: "data"; label: string; data: string }
  | { kind: "editorKey"; label: string; clearFirst?: boolean; data: string; setText?: string }
  | { kind: "action"; label: string; action: string };
```

Then both top and bottom could be driven by config arrays instead of separate custom logic.
That would make it easier to:
- move buttons between top and bottom
- add buttons without editing dispatch code
- eventually load layout from JSON or a separate TS config module

## Suggested future safe extension path

If this becomes more configurable, prefer this progression:

1. **Unify button specs in code**
   - one renderer model
   - one dispatcher model

2. **Move layout into a local config module**
   - e.g. `pi-touch-layout.ts`

3. **Optional user override file**
   - e.g. `~/.pi/agent/pi-touch-layout.json`
   - invalid config should fall back safely to built-in defaults
   - never let bad layout config break startup

## Files to care about

Main implementation:
- `extensions/pi-touch.ts`

Persistence:
- `~/.pi/agent/pi-touch-persist.json`

Logs:
- `~/.pi/agent/logs/pi-touch.log`

## Quick maintenance checklist

When changing `pi-touch`, verify:

- touch still starts/restores correctly across sessions
- `autoEnable: false` still prevents startup auto-enable
- `/touch` toggle still works
- ETC auto-opens on enable
- ETC stays open after button selection
- top overlay wraps and click hit-testing still works
- bottom bar wraps and click hit-testing still works
- `/` button still triggers the slash-command dropdown immediately
- `PG↑` / `PG↓` feel less jumpy and preserve visible context between pages
- `^C` still sends real Ctrl+C
- `⌥ ↵` still queues follow-up correctly
- startup failures do not break pi
