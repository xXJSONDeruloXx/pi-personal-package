---
name: gamenative-discord-research
description: Investigate a bug report, feature theme, or topic trend in the GameNative Discord using Latchkey, then correlate what you find against the local GameNative codebase. Use when asked to search GameNative Discord for reports about a topic, summarize recurring complaints/requests, review relevant code paths, separate known findings from guesses, or journal the research in Markdown.
---

# GameNative Discord Research

Use this skill when the user wants you to:
- search the GameNative Discord for reports about a bug, regression, feature request, or recurring complaint
- investigate a topic across multiple Discord threads, not just a single linked message
- summarize what users/devs have said about an issue theme
- correlate Discord findings with the local GameNative codebase
- produce a Markdown journal of the research with evidence and an honest root-cause assessment

## Requirements

- `latchkey` must be installed and have valid Discord credentials
- the local GameNative repo should be available at:
  - `/Users/danhimebauch/Developer/GameNative`
- `python3` should be available for small JSON filtering helpers when needed

## Canonical GameNative Discord IDs

- Guild: `1378308569287622737`
- Forums:
  - `bug-reports`: `1384098122715758682`
  - `feature-requests`: `1438076056782504037`
- Other commonly useful channels:
  - `development`: `1386424596449988709`
  - `general`: `1412756778159964201`
  - `latest-builds`: `1440655876133228555`
  - `release-previews`: `1392123808730714222`
  - `game-support`: `1439100215486451804`

## Important Discord API notes

1. Prefer Discord HTTP API via Latchkey over GUI review.
2. For forum channels, use:
   ```bash
   latchkey curl 'https://discord.com/api/v10/channels/<forum_id>/threads/search?limit=25'
   ```
3. The parent forum's `/messages` endpoint may be empty even when the forum has active posts.
4. `GET /guilds/<guild_id>/threads/active` is bot-only and will fail for the Latchkey user session.
5. In `threads/search` responses, the opening post content is in `first_messages`; match each OP by `channel_id == thread.id`.
6. Resolve tag IDs by reading the forum channel object and mapping `available_tags`.
7. Do not assume supporter-only channels are accessible from the current account.
8. Respect rate limits. If the API returns `retry_after`, wait and retry instead of hammering.
9. Guild-wide message search is often the fastest way to find scattered discussion:
   ```bash
   latchkey curl 'https://discord.com/api/v10/guilds/1378308569287622737/messages/search?content=<query>'
   ```
10. For forum-topic discovery, it is usually more reliable to paginate `threads/search` and filter client-side than to assume server-side query filtering is sufficient.

## Inputs

Accept any of these forms:
- a Discord message/thread URL
- a topic like `steam frequent logouts`, `controller regression`, `GOG downloads`, `save sync`
- a request to broadly research a theme in GameNative Discord
- optional instructions to journal findings in Markdown
- optional instructions to compare the findings against current code or `upstream/master`

If the user gives a specific Discord link, investigate that first, then fan out to related threads if useful.
If the user gives only a topic, start broad.

## Workflow

Run Discord queries from any directory. Run code inspection from the local GameNative repo unless the user says otherwise.

### 1) Define scope
Clarify internally:
- exact topic or symptom
- whether the user wants broad research vs one linked report
- whether they want code review / fix ideas too
- whether they want a Markdown journal

Do not ask extra questions if the request is already actionable.

### 2) Collect forum evidence first
For broad topic research, start with the GameNative forums.

Read forum metadata if tags may matter:
```bash
latchkey curl 'https://discord.com/api/v10/channels/1384098122715758682'
latchkey curl 'https://discord.com/api/v10/channels/1438076056782504037'
```

Enumerate threads with pagination in pages of 25:
```bash
latchkey curl 'https://discord.com/api/v10/channels/<forum_id>/threads/search?limit=25&offset=0'
latchkey curl 'https://discord.com/api/v10/channels/<forum_id>/threads/search?limit=25&offset=25'
```

When useful, use a short Python helper to:
- page until `has_more` is false
- index `first_messages` by `channel_id`
- filter titles + OP content by topic keywords
- print candidate thread IDs, titles, timestamps, and short excerpts

### 3) Expand with guild-wide search
Use guild-wide message search to find:
- repeated complaints outside the forums
- dev commentary in `development`
- user reports in `general`
- build announcements in `latest-builds`
- historical mentions of fixes/regressions

Examples:
```bash
latchkey curl 'https://discord.com/api/v10/guilds/1378308569287622737/messages/search?content=steam%20logout'
latchkey curl 'https://discord.com/api/v10/guilds/1378308569287622737/messages/search?content=reconnecting%20to%20steam'
```

Treat forum threads and direct dev comments as stronger evidence than second-hand paraphrases.

### 4) Inspect relevant threads directly
For each promising thread:
```bash
latchkey curl 'https://discord.com/api/v10/channels/<thread_id>'
latchkey curl 'https://discord.com/api/v10/channels/<thread_id>/messages?limit=100'
```

Capture:
- title
- timestamp
- report pattern / repro steps
- how many users pile on
- whether a dev acknowledged it
- whether a build/PR/commit was referenced

### 5) Summarize Discord findings before touching code
Identify:
- strongest recurring patterns
- oldest and newest known reports
- whether issue appears tied to app version, device class, sleep/resume, network, downloads, etc.
- what is established vs what is still ambiguous

Be explicit about evidence quality:
- direct report
- dev statement
- build announcement
- hearsay / second-hand interpretation

### 6) Correlate with the GameNative codebase
Switch to the local repo:
```bash
cd /Users/danhimebauch/Developer/GameNative
```

Use `rg` to locate relevant implementation first, then `read` the files before drawing conclusions.

Typical research flow:
1. search for topic terms, related services, state flags, events, or strings
2. inspect core service / UI / state-management files
3. inspect recent git history for likely fixes or regressions
4. when useful, inspect branches or commits already present locally that appear relevant

Examples:
```bash
rg -n "steam|logout|disconnect|reconnect|session|refreshToken|isConnected|isLoggedIn" app/src/main/java -S
git log --oneline --grep='logout\|disconnect\|reconnect' --all -n 30
```

### 7) Separate known findings from hypotheses
In your write-up, clearly label:
- **Known from Discord**
- **Known from code**
- **High-confidence mitigation**
- **Hypotheses / guesses**

Be honest. If a proposal is only plausible, say so.

### 8) Journal to Markdown when requested
If the user asks for notes, create a Markdown file at the target repo root unless they specify another location.

Recommended structure:
```markdown
# <topic> investigation

## Scope
## Search method
## Discord findings
## Pattern summary
## Code review
## Known findings
## Hypotheses / guesses
## Likely mitigations / next steps
## Bottom line
```

Include Discord thread/message references when possible.

### 9) If fixes are requested afterward
After the research phase:
- identify the highest-confidence mitigation first
- say whether it is a real fix vs a mitigation
- if implementation seems actionable, branch from `upstream/master` unless the user says otherwise

## Guidance on evidence quality

Prefer this order of trust:
1. direct Discord bug thread content
2. direct dev messages referencing a PR/build/fix
3. code paths currently present in the repo
4. old local branches/commits that show intended mitigations
5. user paraphrases of what devs supposedly said

## Notes

- Keep the final answer concise, but make the Markdown journal detailed if asked.
- If you find a likely root cause, still state whether it is proven or inferred.
- If the problem seems to be multiple issues conflated into one symptom, say so explicitly.
- If the code already contains an unmerged or local mitigation, call it out.
