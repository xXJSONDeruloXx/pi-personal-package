#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  compress_media_under_size.sh --input PATH [--target 10mb] [--output PATH] [--mute]

Behavior:
  - GIF input stays GIF output.
  - Video input is written as H.264 MP4 by default.
  - Original file is never modified.

Examples:
  compress_media_under_size.sh --input clip.gif
  compress_media_under_size.sh --input recording.mov --target 10mb
  compress_media_under_size.sh --input video.mp4 --target 8mb --output ./video-small.mp4
  compress_media_under_size.sh --input clip.mov --mute
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

file_size_bytes() {
  local path="$1"
  if stat -f '%z' "$path" >/dev/null 2>&1; then
    stat -f '%z' "$path"
  else
    stat -c '%s' "$path"
  fi
}

parse_size_to_bytes() {
  python3 - "$1" <<'PY'
import re
import sys
raw = sys.argv[1].strip().lower().replace(" ", "")
m = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)(b|kb|k|mb|m|gb|g)?", raw)
if not m:
    raise SystemExit(2)
value = float(m.group(1))
unit = m.group(2) or 'b'
mult = {
    'b': 1,
    'k': 1000,
    'kb': 1000,
    'm': 1000**2,
    'mb': 1000**2,
    'g': 1000**3,
    'gb': 1000**3,
}[unit]
print(int(value * mult))
PY
}

human_mb() {
  python3 - "$1" <<'PY'
import sys
n = int(sys.argv[1])
print(f"{n/1_000_000:.2f} MB")
PY
}

float_eval() {
  python3 - "$@" <<'PY'
import sys
expr = sys.argv[1]
print(eval(expr, {"__builtins__": {}}, {}))
PY
}

round_even() {
  python3 - "$1" <<'PY'
import sys
value = int(round(float(sys.argv[1])))
if value < 2:
    value = 2
if value % 2:
    value -= 1
print(value)
PY
}

unique_lines() {
  awk 'NF && !seen[$0]++'
}

ffprobe_value() {
  local input="$1"
  local selector="$2"
  local entries="$3"
  ffprobe -v error ${selector:+$selector} -show_entries "$entries" -of default=nokey=1:noprint_wrappers=1 "$input" | head -n1
}

ffprobe_has_audio() {
  local input="$1"
  if ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$input" 2>/dev/null | grep -q '^audio$'; then
    return 0
  fi
  return 1
}

build_default_output() {
  local input="$1"
  local target_label="$2"
  local mode="$3"
  local dir base stem ext
  dir=$(dirname "$input")
  base=$(basename "$input")
  stem="${base%.*}"
  ext="${base##*.}"
  if [[ "$mode" == "gif" ]]; then
    printf '%s/%s-under-%s.gif\n' "$dir" "$stem" "$target_label"
  else
    printf '%s/%s-under-%s.mp4\n' "$dir" "$stem" "$target_label"
  fi
}

choose_video_limit() {
  local original_max="$1"
  local video_kbps="$2"
  local limit="$original_max"
  if (( video_kbps < 60 )); then
    limit=360
  elif (( video_kbps < 90 )); then
    limit=480
  elif (( video_kbps < 150 )); then
    limit=640
  elif (( video_kbps < 250 )); then
    limit=854
  elif (( video_kbps < 400 )); then
    limit=960
  elif (( video_kbps < 800 )); then
    limit=1280
  elif (( video_kbps < 1400 )); then
    limit=1600
  fi
  if (( limit > original_max )); then
    limit="$original_max"
  fi
  echo "$limit"
}

compute_scaled_dimensions() {
  local width="$1"
  local height="$2"
  local limit="$3"
  local current_max="$width"
  if (( height > current_max )); then
    current_max="$height"
  fi

  if (( current_max <= limit )); then
    printf '%s %s\n' "$width" "$height"
    return
  fi

  if (( width >= height )); then
    local new_w="$limit"
    local new_h
    new_h=$(round_even "($height * $limit) / $width")
    printf '%s %s\n' "$new_w" "$new_h"
  else
    local new_h="$limit"
    local new_w
    new_w=$(round_even "($width * $limit) / $height")
    printf '%s %s\n' "$new_w" "$new_h"
  fi
}

compress_gif() {
  local input="$1"
  local output="$2"
  local target_bytes="$3"
  local width="$4"
  local height="$5"
  local fps_raw="$6"

  local fps_num
  fps_num=$(python3 - "$fps_raw" <<'PY'
import sys
raw = sys.argv[1].strip()
if not raw or raw == '0/0':
    print('12')
elif '/' in raw:
    a, b = raw.split('/', 1)
    val = float(a) / float(b)
    print(f"{val:.3f}")
else:
    print(raw)
PY
)

  local -a fps_candidates=()
  fps_candidates+=("$fps_num")
  for candidate in 15 12 10 8 6; do
    if python3 - "$fps_num" "$candidate" <<'PY'
import sys
orig = float(sys.argv[1])
cand = float(sys.argv[2])
raise SystemExit(0 if cand < orig - 0.05 else 1)
PY
    then
      fps_candidates+=("$candidate")
    fi
  done

  local width_list
  width_list=$(printf '%s\n' \
    "$width" \
    1600 1400 1280 1200 1100 1000 960 900 840 800 760 720 680 640 600 560 520 480 440 400 |
    awk -v maxw="$width" '$1 <= maxw && $1 >= 200 { print $1 }' | unique_lines)

  local -a colors_list=(256 192 160 128 96 64 48 32)
  local tmpdir
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' RETURN

  local fps_candidate width_candidate colors palette temp_out size
  while IFS= read -r fps_candidate; do
    [[ -z "$fps_candidate" ]] && continue
    while IFS= read -r width_candidate; do
      [[ -z "$width_candidate" ]] && continue
      for colors in "${colors_list[@]}"; do
        palette="$tmpdir/palette-${fps_candidate}-${width_candidate}-${colors}.png"
        temp_out="$tmpdir/out-${fps_candidate}-${width_candidate}-${colors}.gif"
        ffmpeg -nostdin -v error -y -i "$input" -vf "fps=${fps_candidate},scale=${width_candidate}:-1:flags=lanczos,palettegen=max_colors=${colors}:reserve_transparent=0" "$palette"
        ffmpeg -nostdin -v error -y -i "$input" -i "$palette" -lavfi "fps=${fps_candidate},scale=${width_candidate}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" "$temp_out"
        size=$(file_size_bytes "$temp_out")
        echo "TRY gif fps=${fps_candidate} width=${width_candidate} colors=${colors} size=${size}" >&2
        if (( size <= target_bytes )); then
          cp "$temp_out" "$output"
          echo "gif fps=${fps_candidate} width=${width_candidate} colors=${colors}" >"${output}.meta"
          return 0
        fi
      done
    done <<< "$width_list"
  done < <(printf '%s\n' "${fps_candidates[@]}" | unique_lines)

  return 1
}

compress_video() {
  local input="$1"
  local output="$2"
  local target_bytes="$3"
  local width="$4"
  local height="$5"
  local duration="$6"
  local fps_raw="$7"
  local mute_requested="$8"
  local has_audio="$9"

  local fps_num
  fps_num=$(python3 - "$fps_raw" <<'PY'
import sys
raw = sys.argv[1].strip()
if not raw or raw == '0/0':
    print('30')
elif '/' in raw:
    a, b = raw.split('/', 1)
    val = float(a) / float(b)
    print(f"{val:.3f}")
else:
    print(raw)
PY
)

  local fps_out="$fps_num"
  if python3 - "$fps_num" <<'PY'
import sys
raise SystemExit(0 if float(sys.argv[1]) > 30 else 1)
PY
  then
    fps_out="30"
  fi

  local original_max="$width"
  if (( height > original_max )); then
    original_max="$height"
  fi

  local -a safety_factors=(0.97 0.94 0.91 0.88)
  local -a audio_modes=()
  if [[ "$mute_requested" == "1" || "$has_audio" == "0" ]]; then
    audio_modes=(mute)
  else
    audio_modes=(keep mute)
  fi

  local safety audio_mode safe_target total_kbps audio_kbps video_kbps limit scaled_w scaled_h fps_try vf passlog temp_out size
  for audio_mode in "${audio_modes[@]}"; do
    for safety in "${safety_factors[@]}"; do
      safe_target=$(python3 - "$target_bytes" "$safety" <<'PY'
import sys
n = int(sys.argv[1])
f = float(sys.argv[2])
print(max(int(n * f) - 65536, 100000))
PY
)
      total_kbps=$(python3 - "$safe_target" "$duration" <<'PY'
import sys
bytes_ = int(sys.argv[1])
duration = float(sys.argv[2])
print(max(int((bytes_ * 8) / duration / 1000), 40))
PY
)

      if [[ "$audio_mode" == "mute" ]]; then
        audio_kbps=0
      elif (( total_kbps >= 400 )); then
        audio_kbps=64
      elif (( total_kbps >= 200 )); then
        audio_kbps=48
      elif (( total_kbps >= 120 )); then
        audio_kbps=32
      elif (( total_kbps >= 96 )); then
        audio_kbps=24
      else
        audio_kbps=0
      fi

      video_kbps=$(( total_kbps - audio_kbps ))
      if (( video_kbps < 40 )); then
        video_kbps=40
        audio_kbps=0
      fi

      limit=$(choose_video_limit "$original_max" "$video_kbps")
      read -r scaled_w scaled_h < <(compute_scaled_dimensions "$width" "$height" "$limit")

      fps_try="$fps_out"
      if (( video_kbps < 150 )) && python3 - "$fps_out" <<'PY'
import sys
raise SystemExit(0 if float(sys.argv[1]) > 24 else 1)
PY
      then
        fps_try="24"
      fi
      if (( video_kbps < 90 )) && python3 - "$fps_try" <<'PY'
import sys
raise SystemExit(0 if float(sys.argv[1]) > 15 else 1)
PY
      then
        fps_try="15"
      fi

      vf="scale=${scaled_w}:${scaled_h}:flags=lanczos"
      if [[ "$fps_try" != "$fps_num" ]]; then
        vf+=",fps=${fps_try}"
      fi

      passlog=$(mktemp -u /tmp/pi-media-pass.XXXXXX)
      temp_out=$(mktemp -u /tmp/pi-media-out.XXXXXX.mp4)

      echo "TRY video audio=${audio_mode} safety=${safety} bitrate=${video_kbps}k audio_bitrate=${audio_kbps}k scale=${scaled_w}x${scaled_h} fps=${fps_try}" >&2

      ffmpeg -nostdin -v error -y -i "$input" -map 0:v:0 -vf "$vf" -c:v libx264 -preset slow -pix_fmt yuv420p -b:v "${video_kbps}k" -maxrate "${video_kbps}k" -bufsize "$(( video_kbps * 2 ))k" -pass 1 -passlogfile "$passlog" -an -f mp4 /dev/null

      if (( audio_kbps > 0 )); then
        ffmpeg -nostdin -v error -y -i "$input" -map 0:v:0 -map 0:a:0? -vf "$vf" -c:v libx264 -preset slow -pix_fmt yuv420p -b:v "${video_kbps}k" -maxrate "${video_kbps}k" -bufsize "$(( video_kbps * 2 ))k" -pass 2 -passlogfile "$passlog" -c:a aac -b:a "${audio_kbps}k" -ac 2 -movflags +faststart "$temp_out"
      else
        ffmpeg -nostdin -v error -y -i "$input" -map 0:v:0 -vf "$vf" -c:v libx264 -preset slow -pix_fmt yuv420p -b:v "${video_kbps}k" -maxrate "${video_kbps}k" -bufsize "$(( video_kbps * 2 ))k" -pass 2 -passlogfile "$passlog" -an -movflags +faststart "$temp_out"
      fi

      rm -f "${passlog}"* || true
      size=$(file_size_bytes "$temp_out")
      if (( size <= target_bytes )); then
        mv "$temp_out" "$output"
        echo "video audio=${audio_mode} safety=${safety} bitrate=${video_kbps}k audio_bitrate=${audio_kbps}k scale=${scaled_w}x${scaled_h} fps=${fps_try}" >"${output}.meta"
        return 0
      fi
      rm -f "$temp_out"
    done
  done

  return 1
}

INPUT=""
TARGET="10mb"
OUTPUT=""
MUTE="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input|-i)
      [[ $# -ge 2 ]] || fail "missing value for $1"
      INPUT="$2"
      shift 2
      ;;
    --target|-t)
      [[ $# -ge 2 ]] || fail "missing value for $1"
      TARGET="$2"
      shift 2
      ;;
    --output|-o)
      [[ $# -ge 2 ]] || fail "missing value for $1"
      OUTPUT="$2"
      shift 2
      ;;
    --mute|--no-audio)
      MUTE="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -n "$INPUT" ]] || { usage; fail "--input is required"; }
[[ -f "$INPUT" ]] || fail "input file not found: $INPUT"

have_cmd ffmpeg || fail "ffmpeg is required"
have_cmd ffprobe || fail "ffprobe is required"
have_cmd python3 || fail "python3 is required"

TARGET_BYTES=$(parse_size_to_bytes "$TARGET") || fail "invalid target size: $TARGET"
TARGET_LABEL=$(printf '%s' "$TARGET" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9.-')
[[ -n "$TARGET_LABEL" ]] || TARGET_LABEL="target"

FORMAT_NAME=$(ffprobe_value "$INPUT" "" "format=format_name" || true)
WIDTH=$(ffprobe_value "$INPUT" "-select_streams v:0" "stream=width")
HEIGHT=$(ffprobe_value "$INPUT" "-select_streams v:0" "stream=height")
FPS_RAW=$(ffprobe_value "$INPUT" "-select_streams v:0" "stream=avg_frame_rate")
DURATION=$(ffprobe_value "$INPUT" "" "format=duration")
[[ -n "$WIDTH" && -n "$HEIGHT" ]] || fail "could not determine video dimensions"
[[ -n "$DURATION" ]] || fail "could not determine duration"

MODE="video"
shopt -s nocasematch
if [[ "$INPUT" == *.gif || "$FORMAT_NAME" == *gif* ]]; then
  MODE="gif"
fi
shopt -u nocasematch

if [[ -z "$OUTPUT" ]]; then
  OUTPUT=$(build_default_output "$INPUT" "$TARGET_LABEL" "$MODE")
fi

mkdir -p "$(dirname "$OUTPUT")"

ORIGINAL_BYTES=$(file_size_bytes "$INPUT")
if (( ORIGINAL_BYTES <= TARGET_BYTES )); then
  cp "$INPUT" "$OUTPUT"
  printf 'status=already-under-target\n'
  printf 'mode=%s\n' "$MODE"
  printf 'input=%s\n' "$INPUT"
  printf 'output=%s\n' "$OUTPUT"
  printf 'original_bytes=%s\n' "$ORIGINAL_BYTES"
  printf 'output_bytes=%s\n' "$ORIGINAL_BYTES"
  printf 'target_bytes=%s\n' "$TARGET_BYTES"
  printf 'original_human=%s\n' "$(human_mb "$ORIGINAL_BYTES")"
  printf 'output_human=%s\n' "$(human_mb "$ORIGINAL_BYTES")"
  printf 'target_human=%s\n' "$(human_mb "$TARGET_BYTES")"
  exit 0
fi

HAS_AUDIO="0"
if ffprobe_has_audio "$INPUT"; then
  HAS_AUDIO="1"
fi

rm -f "${OUTPUT}.meta"

if [[ "$MODE" == "gif" ]]; then
  compress_gif "$INPUT" "$OUTPUT" "$TARGET_BYTES" "$WIDTH" "$HEIGHT" "$FPS_RAW" || fail "could not get GIF under target size"
else
  compress_video "$INPUT" "$OUTPUT" "$TARGET_BYTES" "$WIDTH" "$HEIGHT" "$DURATION" "$FPS_RAW" "$MUTE" "$HAS_AUDIO" || fail "could not get video under target size"
fi

OUTPUT_BYTES=$(file_size_bytes "$OUTPUT")
STRATEGY=""
if [[ -f "${OUTPUT}.meta" ]]; then
  STRATEGY=$(cat "${OUTPUT}.meta")
  rm -f "${OUTPUT}.meta"
fi

printf 'status=compressed\n'
printf 'mode=%s\n' "$MODE"
printf 'input=%s\n' "$INPUT"
printf 'output=%s\n' "$OUTPUT"
printf 'original_bytes=%s\n' "$ORIGINAL_BYTES"
printf 'output_bytes=%s\n' "$OUTPUT_BYTES"
printf 'target_bytes=%s\n' "$TARGET_BYTES"
printf 'original_human=%s\n' "$(human_mb "$ORIGINAL_BYTES")"
printf 'output_human=%s\n' "$(human_mb "$OUTPUT_BYTES")"
printf 'target_human=%s\n' "$(human_mb "$TARGET_BYTES")"
printf 'strategy=%s\n' "$STRATEGY"
