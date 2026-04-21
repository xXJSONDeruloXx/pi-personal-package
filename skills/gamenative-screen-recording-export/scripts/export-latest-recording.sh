#!/usr/bin/env bash
set -euo pipefail

MAX_MB=10
DESKTOP_DIR="$HOME/Desktop"
OPEN_BRANCH=1
PUSH_BRANCH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-mb)
      MAX_MB="$2"
      shift 2
      ;;
    --desktop-dir)
      DESKTOP_DIR="$2"
      shift 2
      ;;
    --no-open-branch)
      OPEN_BRANCH=0
      shift
      ;;
    --no-push-branch)
      PUSH_BRANCH=0
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd adb
need_cmd ffmpeg
need_cmd ffprobe
mkdir -p "$DESKTOP_DIR"

adb get-state >/dev/null 2>&1 || {
  echo "No ADB device connected" >&2
  exit 1
}

LATEST_LINE="$({ adb shell 'for d in /sdcard/Movies /sdcard/DCIM /sdcard/Download /sdcard/Recordings /storage/emulated/0/Movies /storage/emulated/0/DCIM /storage/emulated/0/Download; do [ -d "$d" ] && find "$d" -type f \( -iname "*.mp4" -o -iname "*.mkv" -o -iname "*.webm" \) -printf "%T@ %p\n"; done' || true; } | sort -nr | head -n 1)"
[[ -n "$LATEST_LINE" ]] || {
  echo "No screen recording found on device" >&2
  exit 1
}

REMOTE_PATH="${LATEST_LINE#* }"
BASENAME="$(basename "$REMOTE_PATH")"
LOCAL_ORIG="$DESKTOP_DIR/$BASENAME"

adb pull "$REMOTE_PATH" "$LOCAL_ORIG" >/dev/null

TARGET_BYTES=$(python3 - <<PY
max_mb = float(${MAX_MB})
print(int(max_mb * 1024 * 1024))
PY
)

size_bytes() {
  python3 - <<PY
import os
print(os.path.getsize(r'''$1'''))
PY
}

DURATION=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$LOCAL_ORIG")
EXT="${BASENAME##*.}"
STEM="${BASENAME%.*}"
FINAL_PATH="$LOCAL_ORIG"

if [[ $(size_bytes "$LOCAL_ORIG") -gt $TARGET_BYTES ]]; then
  CANDIDATE_MP4="$DESKTOP_DIR/${STEM}-under10mb.mp4"
  attempt_encode() {
    local vf="$1"
    local crf="$2"
    local fps="$3"
    ffmpeg -y -i "$LOCAL_ORIG" \
      -vf "$vf,fps=${fps}" \
      -c:v libx264 -preset slow -crf "$crf" -pix_fmt yuv420p -movflags +faststart -an \
      "$CANDIDATE_MP4" >/dev/null 2>&1
    [[ $(size_bytes "$CANDIDATE_MP4") -le $TARGET_BYTES ]]
  }

  if ! attempt_encode "scale=iw:ih" 28 30 \
    && ! attempt_encode "scale=iw:ih" 30 30 \
    && ! attempt_encode "scale=854:-2" 32 24 \
    && ! attempt_encode "scale=720:-2" 34 20 \
    && ! attempt_encode "scale=640:-2" 36 15; then

    GIF_PATH="$DESKTOP_DIR/${STEM}-under10mb.gif"
    PALETTE="$(mktemp /tmp/${STEM}.palette.XXXXXX.png)"
    ffmpeg -y -i "$LOCAL_ORIG" -vf "fps=10,scale=480:-1:flags=lanczos,palettegen" "$PALETTE" >/dev/null 2>&1
    ffmpeg -y -i "$LOCAL_ORIG" -i "$PALETTE" -lavfi "fps=10,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse" "$GIF_PATH" >/dev/null 2>&1 || true
    rm -f "$PALETTE"
    if [[ -f "$GIF_PATH" && $(size_bytes "$GIF_PATH") -le $TARGET_BYTES ]]; then
      FINAL_PATH="$GIF_PATH"
    else
      FINAL_PATH="$CANDIDATE_MP4"
    fi
  else
    FINAL_PATH="$CANDIDATE_MP4"
  fi
fi

BRANCH_URL=""
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH_NAME="$(git branch --show-current)"
  ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
  if [[ -n "$BRANCH_NAME" && -n "$ORIGIN_URL" ]]; then
    if [[ $PUSH_BRANCH -eq 1 ]]; then
      git push -u origin "$BRANCH_NAME"
    fi
    if [[ "$ORIGIN_URL" =~ ^git@github.com:(.*)\.git$ ]]; then
      REPO_PATH="${BASH_REMATCH[1]}"
      BRANCH_URL="https://github.com/${REPO_PATH}/tree/${BRANCH_NAME}"
    elif [[ "$ORIGIN_URL" =~ ^https://github.com/(.*)\.git$ ]]; then
      REPO_PATH="${BASH_REMATCH[1]}"
      BRANCH_URL="https://github.com/${REPO_PATH}/tree/${BRANCH_NAME}"
    elif [[ "$ORIGIN_URL" =~ ^https://github.com/(.*)$ ]]; then
      REPO_PATH="${BASH_REMATCH[1]}"
      BRANCH_URL="https://github.com/${REPO_PATH}/tree/${BRANCH_NAME}"
    fi
  fi
fi

if [[ $OPEN_BRANCH -eq 1 && -n "$BRANCH_URL" ]]; then
  open "$BRANCH_URL"
fi

echo "Original: $LOCAL_ORIG"
echo "Shareable: $FINAL_PATH"
if [[ -n "$BRANCH_URL" ]]; then
  echo "Branch: $BRANCH_URL"
fi
