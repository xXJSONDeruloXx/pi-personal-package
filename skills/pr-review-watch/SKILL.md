---
name: pr-review-watch
description: Monitor a GitHub pull request for new review comments, reviews, and issue comments for a bounded time, then assess whether the feedback is actionable and worth addressing. Use when asked to watch a PR for bot or human review activity, or to summarize existing review feedback.
---

# PR Review Watch

Use this skill when the user wants you to:
- watch a GitHub PR for new review comments for a few minutes
- summarize the current review state of a PR
- assess whether existing or new feedback should be addressed
- separate actionable review feedback from bot noise

## Requirements

- `gh` CLI must be installed and authenticated
- `python3` must be available

## Inputs

Accept any of these forms:
- full PR URL, e.g. `https://github.com/owner/repo/pull/123`
- repo + PR number, e.g. `owner/repo 123`
- optional watch duration in minutes, default `10`
- implicit current PR context from the conversation, e.g. “this PR”, “the one we’ve been working on”, or invoking the skill after recent PR work

If the user refers to an already-active PR context in the conversation, use that PR by default instead of asking them to repeat the URL/number.

## Workflow

Run all relative paths from this skill directory.

1. Parse the target PR from the user request.
2. For a one-time snapshot, run:
   ```bash
   python3 ./scripts/pr_review_watch.py --url <PR_URL> --snapshot-only
   ```
   or:
   ```bash
   python3 ./scripts/pr_review_watch.py --repo <owner/repo> --pr <number> --snapshot-only
   ```
3. For watch mode, run:
   ```bash
   python3 ./scripts/pr_review_watch.py --url <PR_URL> --minutes 10
   ```
4. If the script reports new review activity, inspect the relevant comments and files before recommending changes:
   - use `gh api repos/<owner>/<repo>/pulls/<pr>/comments` for inline review comments
   - use `gh api repos/<owner>/<repo>/pulls/<pr>/reviews` for submitted reviews
   - use `gh api repos/<owner>/<repo>/issues/<pr>/comments` for top-level discussion comments
   - use `read` on referenced files before concluding whether a comment is valid
5. Distinguish signal from noise:
   - “review in progress” bot comments are not actionable by themselves
   - review summaries are less important than inline comments tied to code
   - “No issues found” comments are informational only
   - assess whether a finding is still valid on the current branch before suggesting a fix
6. Give the user a short conclusion:
   - whether any new feedback arrived
   - which comments are actionable vs ignorable
   - whether you recommend addressing them now

## Assessment Guidance

Translate technical comments into user-facing impact when helpful:
- What could a user see go wrong?
- Is it a correctness issue, stability issue, edge case, or only style?
- Is it worth fixing before merge?

Use this decision framing:
- **Address now**: correctness, crashes, bad UX, race conditions, data loss, broken flows
- **Optional**: maintainability, low-risk edge cases, weak bot suggestions
- **Ignore for now**: stale comments, comments already fixed, non-actionable summaries, style-only bot noise

## Notes

- Prefer bounded watches, usually `5` to `10` minutes.
- If no new comments arrive, still report the latest known review activity timestamp.
- If the user asks whether a comment is worth addressing, validate against current code first.
