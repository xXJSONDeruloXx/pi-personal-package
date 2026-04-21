---
name: gamenative-screen-recording-export
description: Pulls the latest Android screen recording from the attached ADB device to the Desktop, recompresses it under 10 MB (or falls back to GIF if needed), pushes the current branch to origin, and opens the branch in the browser. Use after recording a GameNative test or when the user asks to grab the latest device screen recording and open the active branch.
---

# GameNative Screen Recording Export

Use this skill when the user wants you to:
- pull the latest screen recording from the attached Android device
- save it to the Desktop
- make it small enough to share, preferably under 10 MB
- open the current git branch in the browser
- optionally push the branch first so the browser URL exists

## Requirements

- `adb` must be installed and an Android device must be connected
- `ffmpeg` and `ffprobe` must be installed
- for branch opening, run from a git repo with a GitHub `origin` remote

## Fast path

From the repo root, run:

```bash
./scripts/export-latest-recording.sh
```

This will:
1. find the newest screen recording on the device
2. pull it to `~/Desktop`
3. create a compressed shareable copy under 10 MB when possible
4. push the current branch to `origin`
5. open the branch URL in the browser

## Useful options

```bash
./scripts/export-latest-recording.sh --max-mb 10
./scripts/export-latest-recording.sh --no-open-branch
./scripts/export-latest-recording.sh --no-push-branch
./scripts/export-latest-recording.sh --desktop-dir ~/Desktop
```

## Output behavior

- Keeps the original pulled recording on the Desktop
- Writes a second optimized file when compression is needed:
  - `*-under10mb.mp4`
- Falls back to a GIF if MP4 attempts cannot get under the target size
- Prints the final output paths

## Notes

- If no device is connected, stop and tell the user
- If the current branch is not pushed yet and branch opening is requested, push it first
- Prefer the optimized MP4 over GIF when it already fits under the limit
