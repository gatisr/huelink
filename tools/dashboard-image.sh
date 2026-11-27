#!/usr/bin/env bash
# Rebuild docs/img/dashboard.webp, the four-mode picture in the README.
#
# Save a fresh screenshot as docs/img/dashboard-<off|light|effect|sync>.png and
# run this. Each PNG is trimmed to its cards plus an even margin (so captures
# framed differently still line up), stored as lossless WebP and removed; then
# the four panels are joined in one row with the mode named above each.
# Needs ffmpeg (with drawtext) and cwebp.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docs/img"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BG=0x111111 # the Home Assistant dark page colour the screenshots are taken on
MARGIN=8
FONT="${FONT:-/System/Library/Fonts/Helvetica.ttc}"

for mode in off light effect sync; do
    src="$DIR/dashboard-$mode.png"
    [ -f "$src" ] || src="$DIR/dashboard-$mode.webp"
    # Bounding box of everything lighter than the page colour (17/255).
    box="$(ffmpeg -hide_banner -i "$src" -vf "format=gray,cropdetect=limit=22:round=2:skip=0:reset=0" -frames:v 1 -f null - 2>&1 | grep -o 'crop=[0-9:]*' | tail -1)"
    [ -n "$box" ] || { echo "no cards found in $src" >&2; exit 1; }
    ffmpeg -v error -y -i "$src" -vf "$box,pad=iw+2*$MARGIN:ih+2*$MARGIN:$MARGIN:$MARGIN:color=$BG" "$WORK/$mode.png"
    cwebp -quiet -lossless -z 9 "$WORK/$mode.png" -o "$DIR/dashboard-$mode.webp"
    rm -f "$DIR/dashboard-$mode.png"
done

# Common panel size: the widest and the tallest of the four.
read -r W H < <(for m in off light effect sync; do ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$WORK/$m.png"; done | awk -F, '{ if ($1 > w) w = $1; if ($2 > h) h = $2 } END { print w, h }')
panel() { echo "[$1:v]pad=$W:$H:0:0:color=$BG,pad=$W:$((H + 56)):0:56:color=$BG,drawtext=fontfile=${FONT}:text='$2':fontcolor=0xe1e1e1:fontsize=30:x=(w-text_w)/2:y=14[p$1]"; }
ffmpeg -v error -y -i "$WORK/off.png" -i "$WORK/light.png" -i "$WORK/effect.png" -i "$WORK/sync.png" -filter_complex \
    "$(panel 0 Off);$(panel 1 Light);$(panel 2 Effect);$(panel 3 Sync);[p0][p1][p2][p3]hstack=inputs=4,pad=iw+16:ih+8:8:0:color=$BG" "$WORK/dashboard.png"
cwebp -quiet -lossless -z 9 "$WORK/dashboard.png" -o "$DIR/dashboard.webp"
echo "wrote $DIR/dashboard.webp ($(wc -c <"$DIR/dashboard.webp" | tr -d ' ') bytes)"
