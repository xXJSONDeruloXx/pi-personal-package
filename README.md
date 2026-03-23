# pi-personal-package

Personal pi package for syncing my custom prompts, skills, and extensions across machines.

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

## Included in the pi package

- `extensions/copilot-usage-widget.ts`
- `extensions/upstream-master-diff-footer.ts`
- `prompts/pdiff.md`
- `skills/ci-fix-watch/`
- `skills/gamenative-discord-research/`
- `skills/pr-review-watch/`

These load automatically after `pi install ...` because they are declared in `package.json` under the `pi` key.

## Extras kept in the repo

These are versioned here for sync, but they are **not** auto-loaded by pi packages:

- `extras/AGENTS.md`
- `extras/settings.example.json`
- `extras/extensions-disabled/upstream-diff-footer.ts`

### Manual sync bits

- Copy `extras/AGENTS.md` to `~/.pi/agent/AGENTS.md` if you want the same global instructions.
- Merge `extras/settings.example.json` into `~/.pi/agent/settings.json` if you want the same default model/theme/third-party packages.
- The package now includes the Copilot usage widget and the upstream diff footer automatically.

## Local development on this machine

This Mac is configured to load the package from the local working tree:

```text
/Users/danhimebauch/Developer/pi-personal-package
```

That means edits in this repo become the local source of truth. After changing prompts or skills, run `/reload` in pi or restart pi.

Typical workflow:

```bash
cd /Users/danhimebauch/Developer/pi-personal-package
# edit files
npm run check
git status
git add .
git commit -m "Update pi package"
git push
```

## Sanity check

```bash
npm run check
```
