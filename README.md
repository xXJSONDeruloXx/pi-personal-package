# pi-personal-package

Personal Pi package for non-work machines.

This repo is the **single source of truth** for your personal Pi setup:

- personal extensions
- personal skills
- selected third-party Pi packages bundled into one install
- lightweight config examples and notes

It is intentionally **not** a mirror of the work-machine `pi-miyagi` stack. The goal is a clean personal distro with the best generally useful ergonomics, without corporate-specific workflows.

## Install

If the repo is private, install over SSH:

```bash
pi install git:git@github.com:xXJSONDeruloXx/pi-personal-package
```

If the repo is public, this also works:

```bash
pi install git:github.com/xXJSONDeruloXx/pi-personal-package
```

Update later with:

```bash
pi update
```

## What this package includes

### Local extensions in this repo
- `extensions/auto-title.ts`
- `extensions/copilot-usage-widget.ts`
- `extensions/diff.ts`
- `extensions/notifications.ts`
- `extensions/upstream-master-diff-footer.ts`

### Local skills in this repo
- `skills/ci-fix-watch/`
- `skills/gamenative-cloud-save-debug/`
- `skills/gamenative-discord-research/`
- `skills/pr-review-watch/`

### Bundled third-party extensions and skills
This package also bundles a curated set of reusable Pi packages so personal machines can be bootstrapped from a single install.

#### Bundled extensions
- `@0xkobold/pi-autoupdate`
- `@aliou/pi-processes`
- `@calesennett/pi-codex-usage`
- `@ifi/pi-extension-subagents`
- `@tmustier/pi-ralph-wiggum`
- `pi-codex-web-search`
- `pi-command-center`
- `pi-computer-use`
- `pi-continuous-learning`
- `pi-hide-messages`
- `pi-interactive-shell`
- `pi-stash`
- `pi-tool-display`

#### Bundled skills
- `@aliou/pi-processes`
- `@tmustier/pi-ralph-wiggum`
- `latchkey`
- `pi-interactive-shell`

## Design choices

### Personal-focused, not work-cloned
This package intentionally keeps:
- GameNative-specific research/debugging skills
- personal Copilot usage status
- generic Pi UX improvements learned from work
- selected autonomy / process / TUI tools from the work machine

It intentionally leaves out:
- Jira / enterprise workflow glue
- corporate Slack / Outlook / Teams packaging
- Databricks-specific work setup
- work-only operational skills from `pi-miyagi`

### Base-aware diff footer
The diff footer prefers upstream when it exists, then falls back to origin.
That makes it friendlier for personal repos that track `upstream/master` while still working fine in ordinary origin-only repos.

### Subagent choice
This package bundles `@ifi/pi-extension-subagents` as the default subagent system.
It is the richer option and a better long-term personal default than carrying multiple overlapping subagent packages.

## Extras kept in the repo

These are versioned here for sync, but not automatically loaded by Pi:

- `extras/AGENTS.md`
- `extras/settings.example.json`

## Local development

This repo can also be used as a local path package during development:

```bash
pi install /absolute/path/to/pi-personal-package
```

Then after edits, run `/reload` in Pi.

Typical workflow:

```bash
cd /Users/dhimebauch/Developer/personal/pi-personal-package
npm install
npm run check
git status
git add .
git commit -m "feat: update personal pi package"
git push
```

## Sanity check

```bash
npm install
npm run check
```
