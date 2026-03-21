---
description: Show a colorized git -P diff for uncommitted changes, optionally limited to paths
---
Show me the raw `git -P diff --color=always` output for the current uncommitted changes.

- If I passed path arguments, limit the diff to: $@
- If I passed no arguments, show the full uncommitted diff
- Use the `bash` tool to run the diff command
- Return the diff output directly in a fenced code block
- Do not summarize unless I explicitly ask
