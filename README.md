# pi-personal-package

`pi-personal-package` is a bundled Pi package for a personal setup.

It gives you one repo that installs:
- custom Pi extensions from this repo
- custom Pi skills from this repo
- a prompt pack
- a curated set of bundled third-party Pi packages
- a few extra config/reference files kept alongside the package

## Install

```bash
pi install git:git@github.com:xXJSONDeruloXx/pi-personal-package
```

Or:

```bash
pi install git:github.com/xXJSONDeruloXx/pi-personal-package
```

Update later with:

```bash
pi update
```

Web access is no longer bundled here. Install it separately if you want it:

```bash
pi install npm:pi-web-access
```

## What this repo contains

### `extensions/`
Local Pi extensions, including:
- chat/title helpers
- diff and upstream/base context helpers
- notifications
- provider/widget controls
- usage widgets
- UI tweaks like banners and token-stat hiding
- a custom `poe-provider/` integration with tests and model/client helpers

Notable files:
- `extensions/auto-title.ts`
- `extensions/codex-usage-widget.ts`
- `extensions/copilot-usage-widget.ts`
- `extensions/diff.ts`
- `extensions/hide-token-stats.ts`
- `extensions/kurt-klaw-banner.ts`
- `extensions/notifications.ts`
- `extensions/pifinity.ts`
- `extensions/provider-widget-controls.ts`
- `extensions/upstream-master-diff-footer.ts`
- `extensions/zai-usage-widget.ts`
- `extensions/poe-provider/`

### `skills/`
Local Pi skills, including:
- CI fix/watch workflows
- PR conflict and review monitoring
- GameNative debugging/research helpers
- media compression/export helpers
- a local Ralph wrapper

Included skills:
- `skills/ci-fix-watch/`
- `skills/gamenative-cloud-save-debug/`
- `skills/gamenative-discord-research/`
- `skills/gamenative-screen-recording-export/`
- `skills/media-under-size/`
- `skills/pr-conflict-check/`
- `skills/pr-review-watch/`
- `skills/ralph-wiggum/`

### `prompts/`
Prompt files loaded by Pi.
- `prompts/sync-upstream.md`

### `extras/`
Versioned extras that live in the repo but are not the main package entrypoints.
- `extras/AGENTS.md`
- `extras/settings.example.json`

### `scripts/`
Project helper scripts used during development.

## Bundled third-party packages

This package also bundles a set of Pi packages so they install together:
- `@0xkobold/pi-autoupdate`
- `@aliou/pi-processes`
- `@ifi/pi-extension-subagents`
- `@tmustier/pi-files-widget`
- `@tmustier/pi-ralph-wiggum`
- `latchkey`
- `pi-command-center`
- `pi-continuous-learning`
- `pi-hide-messages`
- `pi-interactive-shell`
- `pi-stash`
- `pi-tool-display`

## Repo purpose

This repo is the package source for a Pi setup that combines local extensions, local skills, prompts, and bundled dependencies in one installable package.
