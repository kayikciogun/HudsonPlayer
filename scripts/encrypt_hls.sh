#!/usr/bin/env bash
# ──────────────────────────────────────────────
# scripts/encrypt_hls.sh
# Convert .mp3 source files to HLS (.ts) with
# AES-128 encryption. Each track gets:
#   - segments/<safe>/index.m3u8    (playlist)
#   - segments/<safe>/seg_NNN.ts    (encrypted audio chunks)
#   - keys/<safe>.key               (16-byte AES key — to be uploaded
#                                   to a *private* Storage path)
# The key is uploaded separately and gated by Storage Rules.
# ──────────────────────────────────────────────
set -euo pipefail

SRC="${1:-mp3_export}"
OUT="${2:-hls_build}"
KEY_DIR="$OUT/keys"
SEG_DIR_BASE="$OUT/segments"

mkdir -p "$KEY_DIR"

count=0
total=$(find "$SRC" -maxdepth 1 -name '*.mp3' | wc -l | tr -d ' ')

for src in "$SRC"/*.mp3; do
  [ -e "$src" ] || continue
  name="$(basename "$src" .mp3)"
  safe="$(printf '%s' "$name" | tr ' ' '_' | tr -cd '[:alnum:]_-')"
  segdir="$SEG_DIR_BASE/$safe"
  mkdir -p "$segdir"

  keyfile="$KEY_DIR/${safe}.key"
  keyinfo="$KEY_DIR/${safe}.keyinfo"

  # Random 16-byte AES-128 key
  openssl rand 16 > "$keyfile"

  # keyinfo format (FFmpeg):
  #   line 1: key URL (placeholder; replaced by frontend player)
  #   line 2: local key file path
  #   line 3: 16-byte IV (hex)
  iv_hex="$(openssl rand 16 | xxd -p)"
  {
    printf 'http://placeholder/%s.key\n' "$safe"
    printf '%s\n' "$keyfile"
    printf '%s\n' "$iv_hex"
  } > "$keyinfo"

  ffmpeg -y -loglevel error \
    -i "$src" \
    -c:a aac -b:a 128k \
    -f hls \
    -hls_time 6 \
    -hls_playlist_type vod \
    -hls_segment_type mpegts \
    -hls_key_info_file "$keyinfo" \
    -hls_segment_filename "$segdir/seg_%03d.ts" \
    "$segdir/index.m3u8"

  rm -f "$keyinfo"
  count=$((count + 1))
  printf '\r[%d/%d] %s' "$count" "$total" "$safe"
done
echo
echo "✓ $count tracks encrypted → $OUT"