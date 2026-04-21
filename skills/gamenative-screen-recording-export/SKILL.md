---
name: gamenative-screen-recording-export
description: Pulls the latest Android screen recording from the attached ADB device to the Desktop, recompresses it under 10 MB (or falls back to GIF if needed), and can be used to attach polished media to a GameNative PR. Use after recording a GameNative test or when the user asks to grab the latest device screen recording, prep it for sharing, or attach it to a PR.
---

# GameNative Screen Recording Export

Use this skill when the user wants you to:
- pull the latest screen recording from the attached Android device
- save it to the Desktop
- make it small enough to share, preferably under 10 MB
- prepare recording/screenshot assets for a GameNative PR
- optionally push the current branch and open the PR or branch in the browser

## Requirements

- `adb` must be installed and an Android device must be connected
- `ffmpeg` and `ffprobe` must be installed
- for branch or PR opening, run from a git repo with a GitHub `origin` remote

## Fast path

If the repo has a helper script, prefer it. From the repo root, run:

```bash
./scripts/export-latest-recording.sh
```

If that script does not exist in the current repo, do the equivalent manually:
1. find the newest screen recording on the device
2. pull it to `~/Desktop`
3. create a compressed shareable copy under 10 MB when possible
4. if the user wants a PR/branch opened, push the current branch to `origin`
5. open the relevant GitHub page in the browser

## Useful options

```bash
./scripts/export-latest-recording.sh --max-mb 10
./scripts/export-latest-recording.sh --no-open-branch
./scripts/export-latest-recording.sh --no-push-branch
./scripts/export-latest-recording.sh --desktop-dir ~/Desktop
```

If working manually, the important outputs are the Desktop file path and its final size.

## Output behavior

- Keeps the original pulled recording on the Desktop
- Writes a second optimized file when compression is needed:
  - `*-under10mb.mp4`
- Falls back to a GIF if MP4 attempts cannot get under the target size
- Prints the final output paths

## PR attachment / formatting notes

When this recording is going into a GameNative PR:
- Prefer the actual GitHub-uploaded video/screenshot attachments in the PR body, not local filesystem paths like `~/Desktop/...`.
- If helpful, include a screenshot showing the broken state before the fix in addition to the recording.
- Keep the PR description very succinct and human. Avoid filler like `WIP` when a short real summary is available.
- Check the PR template boxes that are genuinely true instead of leaving everything unchecked by default.
- If `gh` cannot cleanly upload the media into the PR body, open the PR in the browser and attach the assets there.

## Notes

- If no device is connected, stop and tell the user
- If the current branch is not pushed yet and branch or PR opening is requested, push it first
- Prefer the optimized MP4 over GIF when it already fits under the limit
- If the repo lacks `./scripts/export-latest-recording.sh`, do not assume it exists; fall back to manual `adb pull` + compression steps
