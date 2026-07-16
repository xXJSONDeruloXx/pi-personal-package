# Personal environment notes

- Proactively update this global `AGENTS.md` when the user corrects agent behavior or when stable usage patterns emerge from repeated interactions.

## Bash safety
- ALWAYS set a `timeout` on bash commands that run executables, start servers, or do anything that might hang. Default: 30 seconds. Use `timeout <seconds>` before the command.
- Example: `timeout 8 ./build/mybinary arg1` not `./build/mybinary arg1`
- Never run a binary without a timeout — getting stuck wastes entire turns.
- For longer-running commands (builds, tests), set an appropriate timeout (e.g. 120s for cmake builds).
- macOS `timeout` is available via the shell alias in `~/.zshrc`.

## Computer-use tools

- Mac Mini Agent local repository path: `/Users/danhimebauch/Developer/mac-mini-agent`
- For macOS computer-use / GUI automation tasks, use Mac Mini Agent docs and skills first.
- Main docs:
  - `/Users/danhimebauch/Developer/mac-mini-agent/README.md`
  - `/Users/danhimebauch/Developer/mac-mini-agent/apps/steer/README.md`
- Skill docs:
  - `/Users/danhimebauch/Developer/mac-mini-agent/.claude/skills/steer/SKILL.md`
  - `/Users/danhimebauch/Developer/mac-mini-agent/.claude/skills/drive/SKILL.md`
- Steer binary for GUI automation:
  - `/Users/danhimebauch/Developer/mac-mini-agent/apps/steer/.build/release/steer`
- Drive entrypoint for tmux automation:
  - `cd /Users/danhimebauch/Developer/mac-mini-agent/apps/drive && uv run python main.py ...`
- Preferred Steer workflow:
  - start with `steer screens --json`, `steer apps --json`, then `steer see --screen <n> --json` or `steer see --app <App> --json`
  - for Electron apps like Discord, prefer `steer ocr --app <App> --store --json`
  - use one steer command per bash call and always re-check the screen after each action
  - prefer OCR/text/element targeting over raw coordinates when possible

## Computer-use learnings / mistakes to avoid

- Always use the full Steer binary path exactly: `/Users/danhimebauch/Developer/mac-mini-agent/apps/steer/.build/release/steer`
  - Do not accidentally call `/Users/danhimebauch/Developer/mac-mini-agent/apps/steer` (that is a directory, not the binary).
- For Discord channel/message navigation, prefer deep links for the Discord app:
  - `discord://-/channels/<server>/<channel>/<message>`
  - After opening, immediately verify with `steer ocr --app Discord --store --json`.
- Do not assume `open -a Discord 'https://discord.com/channels/...'` will navigate to the requested message/thread inside the desktop app.
- Do not assume Safari web links will be usable for Discord review work; they may redirect to login even when the desktop app is already signed in.
- For Electron apps, OCR is the source of truth. After any navigation attempt, re-run OCR and confirm the visible title/post text matches the target before proceeding.
