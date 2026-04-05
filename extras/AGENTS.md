# Personal environment notes

- GameNative local repository path: `/Users/danhimebauch/Developer/GameNative`
- When asked to compare against upstream/master for GameNative, use the local repo above and compare against git ref `upstream/master`
- In a GameNative repo session, if the user sends a Discord link with little or no extra context, treat it as a request to investigate the linked bug report / feature request.
  - Prefer using Latchkey for Discord API access when available.
  - Summarize the request, inspect the GameNative codebase for the relevant implementation, and determine whether the work is actionable.
  - If actionable and the user has not said otherwise, branch from `upstream/master` and start implementing.
- For broad GameNative Discord triage without a specific message link, prefer the Discord HTTP API via Latchkey over GUI review.
  - Prefer the `gamenative-discord-research` skill from the personal pi package for topic/theme investigations.
  - GameNative guild id: `1378308569287622737`
  - Useful forum channels:
    - `bug-reports`: `1384098122715758682`
    - `feature-requests`: `1438076056782504037`
  - Use `GET /channels/<forum_id>/threads/search?limit=<n>` to list recent forum posts when authenticated as the user session.
    - The parent forum's `/messages` endpoint may be empty even when the forum has active posts.
    - `GET /guilds/<guild_id>/threads/active` is bot-only and will fail for the Latchkey user session.
  - In the `threads/search` response, the OP content is in `first_messages`; match each item by `channel_id == thread.id`.
  - Resolve tag ids by reading `GET /channels/<forum_id>` and mapping `available_tags`.
  - For targeted historical searches across channels, use guild-wide message search in addition to forum pagination.
  - When reporting findings, clearly separate direct evidence from hypotheses; if the user asks for notes, journal them in Markdown at repo root.
  - Do not assume supporter-only channels are readable from the current account; e.g. `priority-feature-requests` may return `Missing Access`.
- When opening a PR for work that came from a provided Discord bug / feature link, put that Discord URL in the PR description.
  - If there is no provided Discord link, leave the PR description blank unless the user asks for something else.
- For GameNative PRs and commit messages the agent creates, prefer conventional/semantic prefixes such as `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, or `test:`.
- For GameNative code changes that affect runtime behavior or UI, prefer building an APK and installing it on the attached device with `adb install -r ...` before reporting completion, unless the user says not to.
- When syncing GameNative `master` with `upstream/master`, fetch `upstream` first, do not create a merge commit, and keep `master`, `origin/master`, and `upstream/master` 1:1. If needed, hard-reset `master` to `upstream/master` and push with `--force-with-lease` after verifying the worktree is clean.
  - If a destructive repo operation is blocked by uncommitted changes, stop and present concise numbered options so the user can reply with just a number.
  - Default options should include: `1)` stash current changes (include untracked when relevant) and proceed, `2)` commit and push the current branch changes first, then return to the requested operation, `3)` inspect/show diff or cancel, plus any other clearly relevant option for the situation.
  - After the user replies with a number, carry out that option as specified without making them restate the plan, unless a new ambiguity or destructive choice still needs confirmation.
- Proactively update this global `AGENTS.md` when the user corrects agent behavior or when stable usage patterns emerge from repeated interactions.

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
- Android emulator setup on this machine:
  - Homebrew `android-commandlinetools` is installed and its effective SDK root is `/opt/homebrew/share/android-commandlinetools`.
  - `avdmanager` expects system images installed under that same SDK root; installing images only under `~/Library/Android/sdk` can make `avdmanager create avd` fail or make the emulator fail to resolve the system image.
  - When launching emulator binaries for AVDs created from the Homebrew SDK root, set:
    - `ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools`
    - `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`
  - The ATD image (`google_atd`) booted but rendered a black screen; a standard Google APIs arm64 image worked:
    - `system-images;android-35;google_apis;arm64-v8a`
  - Known working AVD on this machine:
    - `GameNative_API35_GAPI`
  - Android emulator is available for future agent-driven GameNative smoke tests; prefer reusing `GameNative_API35_GAPI` before creating another AVD.
  - Known working launch pattern:
    - `env ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools ANDROID_HOME=/opt/homebrew/share/android-commandlinetools /opt/homebrew/share/android-commandlinetools/emulator/emulator -avd GameNative_API35_GAPI -gpu swiftshader_indirect -no-snapshot -no-boot-anim -noaudio ...`
- For Android app inspection, use `adb shell uiautomator dump` to get reliable text/bounds when Compose UI is visible on emulator but not accessible from macOS accessibility.
- For GameNative custom game setup on emulator:
  - create a folder under `/sdcard/Download/<GameName>` and place at least one `.exe` file there (even a dummy file is enough to exercise the UI flow)
  - add game flow may require both Storage Access Framework folder approval and the separate “All files access” settings permission
  - after granting all-file access in Android Settings, you may still need to return to the SAF dialog and press `ALLOW`, then `USE THIS FOLDER` again to complete the flow.
