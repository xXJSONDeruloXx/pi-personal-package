---
name: media-under-size
description: Shrink a GIF or video file under a target file size, defaulting to 10 MB, using ffmpeg/ffprobe. Use when the user wants media small enough for upload limits like Discord, GitHub comments, chat apps, or email.
---

# Media Under Size

Use this skill when the user wants you to:
- make a GIF under 10 MB
- compress a video to fit an upload limit
- keep the original file untouched while writing a smaller copy
- trade some quality for a hard size cap

## Requirements

- `ffmpeg` must be installed
- `ffprobe` must be installed
- `python3` should be available for size parsing helpers

## Inputs

Accept any of these forms:
- a path to a GIF or video file
- an optional target size such as `10mb`, `8mb`, or `2500kb`
- an optional output path
- optional preferences like `mute`, `keep audio`, or `keep GIF format`

Default target size: `10mb`

## Workflow

Run all relative paths from this skill directory.

1. Confirm the input file exists.
2. Run the helper script:

```bash
./scripts/compress_media_under_size.sh --input <PATH>
```

With an explicit target:

```bash
./scripts/compress_media_under_size.sh --input <PATH> --target 10mb
```

With an explicit output path:

```bash
./scripts/compress_media_under_size.sh --input <PATH> --target 10mb --output <OUTPUT_PATH>
```

Mute the output video if the user wants that:

```bash
./scripts/compress_media_under_size.sh --input <PATH> --target 10mb --mute
```

3. Read the script output and report:
   - output path
   - original size
   - new size
   - whether the target was met
   - any notable tradeoffs, like GIF palette reduction or video conversion to MP4
4. Keep the original file unless the user explicitly asks to overwrite it.

## Format behavior

- GIF input stays GIF output.
- Video input defaults to H.264 MP4 output for best compatibility and compression.
- For videos, preserve audio by default when practical; use `--mute` if the user asks for silent output.

## Notes

- Prefer the script over manually hand-writing ffmpeg commands unless debugging the script itself.
- If the file already fits under the target, the script copies it to the default output path and reports success.
- If the user says only “make this under 10mb,” use the default target and let the script choose the compression strategy.
