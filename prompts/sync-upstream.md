---
description: Sync local master and origin/master to upstream/master with 1:1 history
---
Sync this repo's `master` branch so it exactly matches `upstream/master` with no merge commit.

Requirements:
- Treat this as a hard sync, not a merge.
- Fetch `upstream master` first, then fetch `origin master`.
- Verify the repo has both `upstream` and `origin` remotes.
- If the working tree has uncommitted changes, stop and ask before doing anything destructive.

Steps:
1. Show `git status --short --branch` and current remotes.
2. `git fetch upstream master`
3. `git fetch origin master`
4. `git checkout master`
5. Reset local `master` to `upstream/master` so history is 1:1 with upstream. Do not merge and do not rebase.
6. Push `master` to `origin`. If needed to preserve exact 1:1 history, use `--force-with-lease`.
7. Re-verify and print the SHAs for `master`, `upstream/master`, and `origin/master`.

Important:
- Do not create a merge commit.
- Do not leave `master` ahead/behind `upstream/master`.
- Be concise and report the final SHA.
