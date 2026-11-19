#!/bin/sh
# Switches the hyperion-test LED device between philipshue and udpraw/udpddp.
# Works straight on the sqlite db: the only way without the web UI.
#
# UDP_HOST/UDP_PORT are where huelink listens; they must match `udpPort` in
# huelink.config.json. Defaults are localhost, so an unset variable cannot
# point somebody else's Hyperion at a stranger.
#
# usage: UDP_HOST=10.0.0.5 sh setdevice.sh <philips|udpraw|udpddp>
apk add -q sqlite >/dev/null 2>&1
UDP_HOST="${UDP_HOST:-127.0.0.1}"
UDP_PORT="${UDP_PORT:-19447}"
LEDS="${LEDS:-7}"
MODE="$1"
udp_config() {
  printf '{"type":"%s","host":"%s","port":%s,"hardwareLedCount":%s,"colorOrder":"rgb","latchTime":0,"autoStart":true,"rewriteTime":0}' \
    "$1" "$UDP_HOST" "$UDP_PORT" "$LEDS"
}
case "$MODE" in
  philips)
    sqlite3 /db/hyperion.db "update settings set config=readfile('/db/device.philips.json') where type='device';"
    ;;
  udpraw|udpddp)
    sqlite3 /db/hyperion.db "update settings set config='$(udp_config "$MODE")' where type='device';"
    ;;
  *) echo "unknown mode: $MODE"; exit 1;;
esac
sqlite3 /db/hyperion.db "select substr(config,1,200) from settings where type='device';"
