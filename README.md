# pi-personal-package

Personal pi package for syncing my prompts, skills, extensions, and bundled third-party pi packages across machines.

## Install on other devices

If the repo is private, install over SSH:

```bash
pi install git:git@github.com:xXJSONDeruloXx/pi-personal-package
```

If the repo is public, this shorthand also works:

```bash
pi install git:github.com/xXJSONDeruloXx/pi-personal-package
```

After you push updates here, other devices can pull the latest package with:

```bash
pi update
```

If you previously installed separate extension / third-party pi packages, remove them so `pi-personal-package` is the single source of truth:

```bash
pi remove https://github.com/xXJSONDeruloXx/pi-extensions
pi remove npm:@calesennett/pi-codex-usage
pi remove npm:tau-mirror
pi remove npm:pi-codex-web-search
pi remove npm:latchkey
```

## Included in the pi package

### Local resources in this repo
- `extensions/copilot-usage-widget.ts`
- `extensions/upstream-master-diff-footer.ts`
- `prompts/pdiff.md`
- `skills/ci-fix-watch/`
- `skills/gamenative-discord-research/`
- `skills/pr-review-watch/`

### Bundled third-party resources loaded through `node_modules/`
- `@calesennett/pi-codex-usage`
  - `extensions/codex-usage-status.ts`
- `tau-mirror`
  - `extensions/mirror-server.ts`
- `pi-codex-web-search`
  - `src/index.ts`
- `latchkey`
  - `dist/skills/generic/`

These load automatically after `pi install ...` because they are declared in `package.json` under the `pi` key.

## Extras kept in the repo

These are versioned here for sync, but they are **not** auto-loaded by pi packages:

- `extras/AGENTS.md`
- `extras/settings.example.json`

### Manual sync bits

- Copy `extras/AGENTS.md` to `~/.pi/agent/AGENTS.md` if you want the same global instructions.
- Merge `extras/settings.example.json` into `~/.pi/agent/settings.json` if you want the same default model/theme and package-specific config.

## Local development on this machine

This Mac is configured to load the package from the local working tree:

```text
/Users/danhimebauch/Developer/pi-personal-package
```

That means edits in this repo become the local source of truth. After changing prompts, skills, or extensions, run `/reload` in pi or restart pi.

Typical workflow:

```bash
cd /Users/danhimebauch/Developer/pi-personal-package
npm install
npm run check
git status
git add .
git commit -m "Update pi package"
git push
```

## Sanity check

```bash
npm install
npm run check
```
