---
name: ci-fix-watch
description: Diagnose a failed GitHub Actions run, make the minimal code or config fix, push the branch, and watch replacement workflow runs until the pipeline is healthy. Use when asked to fix CI, unblock a failing pipeline, or monitor a branch/PR back to green.
---

# CI Fix Watch

Use this skill when the user wants you to:
- inspect a failed GitHub Actions run
- fix CI failures on the current branch or PR
- push follow-up commits and keep watching until workflows go green
- summarize what failed, what you changed, and whether the branch is healthy now

## Requirements

- `gh` CLI must be installed and authenticated
- `git` push access to the target branch must be available
- the repository should already be checked out locally

## Inputs

Accept any of these forms:
- a full workflow run URL, e.g. `https://github.com/owner/repo/actions/runs/123456789`
- a run ID, e.g. `123456789`
- an implicit current branch / PR context from the conversation
- optionally a specific workflow name if the branch has multiple runs in flight

If the user refers to the run or PR already in context, do not ask them to repeat it.

## Workflow

Run all commands from the target repository unless the user says otherwise.

1. Identify the failing run.
   - If the user gave a run URL, extract the run ID.
   - If only a branch/PR is known, list recent runs:
     ```bash
     gh run list --branch <branch> --limit 10 --json databaseId,status,conclusion,headSha,name,url
     ```
2. Inspect the run summary:
   ```bash
   gh run view <run-id> --json status,conclusion,name,headBranch,headSha,jobs,url
   ```
3. Read the failed logs first:
   ```bash
   gh run view <run-id> --log-failed
   ```
4. Locate the failing file or command and validate it locally before editing.
   - Use `read` on referenced files before changing them.
   - Reproduce locally when practical (lint, typecheck, unit test, build step, etc.).
5. Make the smallest fix that addresses the actual failure.
   - Prefer fixing root cause over muting the check.
   - Avoid unrelated cleanup while unblocking CI.
6. Run the closest local validation available.
   - Match the failing CI step if possible.
   - If multiple checks are cheap, run them before pushing.
7. Commit and push only after local validation passes.
8. Watch the new runs for the new `HEAD` SHA until they complete.
   - Poll with:
     ```bash
     gh run list --branch <branch> --limit 10 --json databaseId,status,conclusion,headSha,name,url
     ```
   - Filter to the newest runs matching the current local `HEAD`.
   - Keep watching until all relevant runs for that SHA are `completed`.
9. If a new run fails, inspect that run's failed logs, fix it, push again, and repeat.
10. Report back with:
    - what failed
    - what you changed
    - the commit(s) you pushed
    - whether the branch is now green

## Triage Guidance

Prioritize the first real blocker in the logs.

Common categories:
- **Lint / formatting**: fix style issues directly; avoid broad reformatting
- **Typecheck**: correct types or signatures; avoid `Any`/ignore hacks unless clearly justified
- **Unit tests**: understand whether the code or test is wrong before changing either
- **Build / packaging**: verify paths, manifest entries, generated artifacts, and missing files
- **Container / infra startup noise**: do not assume a workflow is failed if jobs are still pending or initializing

## Watch Guidance

When watching replacement runs:
- prefer the latest runs for the current local `HEAD` SHA
- ignore older failed runs from previous commits once superseded
- if one workflow is green and another is still running, keep polling until all relevant workflows settle
- if a workflow appears stuck in setup/containers, confirm it is still `in_progress` before concluding anything

## Notes

- Keep user-visible summaries concise, but include the exact failing step and the fix.
- Mention URLs for the final healthy run(s) when useful.
- If push access is missing or the repo is dirty in unrelated ways, tell the user before proceeding.
