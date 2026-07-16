---
name: pr-conflict-check
description: "Check all open PRs for a GitHub repo against a target branch (default: upstream/master) and report which ones have merge conflicts, are mergeable, or have failing CI. Use when asked to check PR conflict status, triage open PRs, or find PRs needing rebase/merge conflict resolution."
---

# PR Conflict Check

Checks merge conflict status for all open PRs on a GitHub repo, reporting conflicts, clean merges, and unstable CI in a single pass.

## Workflow

### 1. Discover the upstream repo

If the upstream repo is not already known from project context (e.g. AGENTS.md), derive it from git remotes:

```bash
git remote get-url upstream
# e.g. https://github.com/example-org/example-repo.git → UPSTREAM_REPO=example-org/example-repo
```

If no `upstream` remote exists, fall back to `origin` and use that as the repo for merge queries.

Parse the owner/repo from the URL (strip `.git` suffix, extract last two path segments).

### 2. List open PRs

Run from the repo's working directory so `gh` targets the correct repo:

```bash
gh pr list --state open --author @me --json number,title
```

Drop `--author @me` to check all open PRs, or replace `@me` with a specific username.

### 3. Query merge status in parallel

For every PR number from step 2, query the **upstream** repo for mergeability:

```bash
gh pr view 1282 --repo example-org/example-repo --json number,title,mergeable,mergeStateStatus &
gh pr view 1278 --repo example-org/example-repo --json number,title,mergeable,mergeStateStatus &
wait
```

Run one `gh` call per PR, all backgrounded with `&`, then `wait` for all to complete.

> **Why upstream?** For repos where PRs are opened from a fork against an upstream repo, only the upstream repo has mergeability data. Querying the fork returns no merge info.

### 4. Retry UNKNOWN results

GitHub often returns `mergeable: UNKNOWN` on the first query because it hasn't computed mergeability yet. **Do not report UNKNOWN as final.**

- Collect the PR numbers that returned `UNKNOWN`.
- Sleep 10 seconds.
- Re-query **only those PRs** in parallel:
  ```bash
  sleep 10
  gh pr view 1076 --repo example-org/example-repo --json number,title,mergeable,mergeStateStatus &
  # ... only UNKNOWN PRs ...
  wait
  ```
- If any are still UNKNOWN after the retry, report them as ⚪ and note GitHub may need more time.

### 5. Summarize with status indicators

| Indicator | `mergeable`   | `mergeStateStatus` | Meaning |
|-----------|---------------|---------------------|---------|
| 🔴        | `CONFLICTING` | `DIRTY`             | Merge conflicts — needs resolution |
| 🟢        | `MERGEABLE`   | `CLEAN`             | All good, ready to merge |
| 🟡        | `MERGEABLE`   | `UNSTABLE`          | No conflicts but CI failing |
| ⚪        | `MERGEABLE`   | `BLOCKED`           | Blocked by base branch rules or another PR |
| ⚪        | `UNKNOWN`     | `UNKNOWN`           | GitHub hasn't computed yet (retry) |

### 6. Report

Present a table with columns: PR number, title, merge status. Call out conflicting PRs explicitly and offer to resolve them (rebase onto upstream/master, etc.).

## Tips

- Always query the **upstream** repo for merge status, not the fork.
- The first parallel batch almost always returns UNKNOWN — the retry step is not optional.
- Only re-query the UNKNOWN PRs on retry to save time.
- To check a specific author's PRs, replace `@me` with the username.
- To check all PRs (not just yours), drop the `--author` flag.
