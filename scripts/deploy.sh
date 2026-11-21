#!/usr/bin/env bash
#
# deploy.sh - put this checkout's extension into a running zigbee2mqtt, make
# zigbee2mqtt actually run it, prove that it does, and publish the deployed
# version to Home Assistant as a sensor.
#
# "Prove that it does" is the whole point of the second half of this script.
# zigbee2mqtt's `bridge/request/extension/save` re-imports ONLY the top-level
# extension file: it copies that one file to a fresh temporary name so Node
# treats it as a new module, while every `./huelink-lib/*.mjs` it imports keeps its
# stable path and therefore stays in the ESM module cache for the lifetime of
# the process. So a hot reload picks up huelink.mjs and silently ignores every
# change under huelink-lib/. `bridge/request/restart` does not help either: it restarts
# zigbee2mqtt inside the same Node process, and the module cache survives it.
#
# The only thing that really reloads huelink-lib/ is a new Node process. Set
# Z2M_RESTART_CMD to whatever restarts your zigbee2mqtt (a `docker restart`, a
# `systemctl restart`, an `ssh ... ` line) and this script will use it, then
# refuse to report success until the LIVE extension reports both the version
# being deployed and a process start time later than the moment the copy began.
# Without that setting the script falls back to the hot reload and says plainly
# that huelink-lib/ changes are not live.
#
# Settings come from the environment, then .env.deploy, then .env in the repo
# root, in that order of precedence: the first of those that sets a key wins.
# .env describes the installation, .env.deploy points one run somewhere else,
# and a key set in both is reported rather than silently resolved. See
# .env.example and .env.deploy.example. Nothing installation-specific is baked
# into this file.
#
# No secret ever reaches a command line. The Home Assistant token goes into a
# curl --config file and the MQTT credentials into mosquitto's own defaults
# files, all of them 0600 inside WORK_DIR and all removed by `cleanup`.
# Anything in argv is readable from `ps` by every other user on the machine.
#
# Written for bash 3.2, which is still what macOS ships.

set -euo pipefail

PROJECT="huelink"
SENSOR="sensor.huelink_deployed_version"
FRIENDLY_NAME="huelink deployed version"
ICON="mdi:led-strip-variant"
EXTENSION_FILE="huelink.mjs"
CONVERTER_FILE="huelink-exposes.mjs"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_DIR"

# ---------------------------------------------------------------- options --

DRY_RUN=0
NO_RELOAD=0
VERSION_ONLY=0
FORCE=0

usage() {
  cat <<'EOF'
Usage: scripts/deploy.sh [options]

Copies extension/ into the zigbee2mqtt external_extensions directory and
converter/ into external_converters, makes zigbee2mqtt run the new code, waits
until the live extension reports that version from a process that started after
the copy, then publishes the deployed version to Home Assistant as
sensor.huelink_deployed_version and reads it back.

How the new code is loaded depends on Z2M_RESTART_CMD:
  set    - that command is run, which is the only way changes under
           extension/huelink-lib actually take effect.
  unset  - a hot reload over MQTT, which reloads huelink.mjs alone. The script
           says so, loudly, instead of implying huelink-lib/ went live too.

Options:
  --dry-run       print what would be done and change nothing. Makes no
                  network calls at all, so it also works offline.
  --no-reload     copy the files but do not make zigbee2mqtt load them.
  --version-only  publish the version sensor to Home Assistant and nothing
                  else. Deploys no code.
  --force         deploy even though the working tree has uncommitted changes.
  -h, --help      show this text.

Settings are read from the environment, then .env.deploy, then .env in the repo
root, and the first of those that sets a key wins. A key set in both files is
reported, because two files disagreeing about the target is how a deploy goes
to the wrong machine. Copy .env.example to .env to get started, and
.env.deploy.example to .env.deploy to send one run somewhere else.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-reload) NO_RELOAD=1 ;;
    --version-only) VERSION_ONLY=1 ;;
    --force) FORCE=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown option "%s". Run scripts/deploy.sh --help.\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

# ---------------------------------------------------------------- output ---

# A step is "open" between step() and the ok/fail that closes it, so an abort
# from deep inside still closes the line with "fail" instead of leaving a
# dangling "... " on screen.
STEP_OPEN=0

step() { STEP_OPEN=1; printf '  %-40s' "$1 ..."; }

ok() {
  STEP_OPEN=0
  if [ -n "${1:-}" ]; then printf 'ok    %s\n' "$1"; else printf 'ok\n'; fi
}

# Used inside a step: closes the line with "fail", then explains on stderr.
fail() {
  STEP_OPEN=0
  printf 'fail\n'
  printf '\nerror: %s\n' "$1" >&2
  exit 1
}

# Explains and exits; closes an open step first, if there is one.
abort() {
  if [ "$STEP_OPEN" = 1 ]; then STEP_OPEN=0; printf 'fail\n'; fi
  printf '\nerror: %s\n' "$1" >&2
  exit 1
}

note() { printf '        %s\n' "$1"; }

WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# -------------------------------------------------------------- settings ---

# Reads KEY=VALUE lines. A value is taken literally except for one optional
# layer of surrounding quotes, so there is no inline-comment syntax: put
# comments on their own line. A key already present in the environment is left
# alone, which is what makes every setting overridable.
load_env_file() {
  local file="$1" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      '' | '#'*) continue ;;
    esac
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      value="${BASH_REMATCH[3]}"
    else
      continue
    fi
    case "$value" in
      '"'*'"') value="${value#\"}" && value="${value%\"}" ;;
      "'"*"'") value="${value#\'}" && value="${value%\'}" ;;
    esac
    if [ -z "${!key:-}" ]; then
      export "$key=$value"
    fi
  done <"$file"
}

# The keys a settings file defines, sorted, one per line. Deliberately the same
# shape of line `load_env_file` accepts, so the warning below cannot disagree
# with what was actually loaded.
env_file_keys() {
  [ -f "$1" ] || return 0
  sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*$/\2/p' "$1" |
    sort -u
}

# A key set in two files is the one case where "first one wins" is dangerous.
# The two files disagree about where this deploy is going, the loser is
# discarded without a word, and the result is a deploy to the wrong machine
# that looks exactly like a successful one. Name the keys instead.
warn_duplicate_settings() {
  local winner="$1" loser="$2" shared
  [ -f "$winner" ] && [ -f "$loser" ] || return 0
  shared=$(comm -12 <(env_file_keys "$winner") <(env_file_keys "$loser") | tr '\n' ' ')
  shared="${shared% }"
  [ -n "$shared" ] || return 0
  printf 'warning: %s and %s both set: %s\n' \
    "$(basename "$winner")" "$(basename "$loser")" "$shared" >&2
  printf 'warning: %s wins; an environment variable of the same name wins over both.\n' \
    "$(basename "$winner")" >&2
}

# Precedence is environment > .env.deploy > .env. `load_env_file` never
# overwrites a key that is already set, so loading them in that order IS the
# precedence: the environment is in place before the script starts, .env.deploy
# goes in next, and .env fills only what is still missing. The order used to be
# the other way round, which meant .env.deploy could be read in full and change
# nothing at all.
warn_duplicate_settings "$REPO_DIR/.env.deploy" "$REPO_DIR/.env"
load_env_file "$REPO_DIR/.env.deploy"
load_env_file "$REPO_DIR/.env"

require_settings() {
  local key missing=""
  for key in "$@"; do
    if [ -z "${!key:-}" ]; then missing="$missing $key"; fi
  done
  if [ -n "$missing" ]; then
    abort "missing required settings:$missing. Copy .env.example to .env, fill them in, or pass them as environment variables."
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    abort "$1 is not installed, and this script needs it. $2"
  fi
}

# Every setting this script understands, with its default. Listing them here
# means an unset one is an empty string rather than a crash under set -u.
HA_URL="${HA_URL:-}"
HA_TOKEN="${HA_TOKEN:-}"
HA_TIMEOUT="${HA_TIMEOUT:-15}"
Z2M_EXTENSIONS_DIR="${Z2M_EXTENSIONS_DIR:-}"
Z2M_CONVERTERS_DIR="${Z2M_CONVERTERS_DIR:-}"
# The command that gives zigbee2mqtt a new Node process. Empty means "I have no
# way to restart it", and the script downgrades to a hot reload and says so.
Z2M_RESTART_CMD="${Z2M_RESTART_CMD:-}"
# How long zigbee2mqtt may take to come back up and publish its first state.
Z2M_RESTART_WAIT="${Z2M_RESTART_WAIT:-120}"
Z2M_BASE_TOPIC="${Z2M_BASE_TOPIC:-zigbee2mqtt}"
# Last segment of the extension's own topic. Must match "name" in
# huelink.config.json, because that is the topic its state is retained on.
HUELINK_NAME="${HUELINK_NAME:-huelink}"
MQTT_HOST="${MQTT_HOST:-}"
MQTT_PORT="${MQTT_PORT:-1883}"
MQTT_USER="${MQTT_USER:-}"
MQTT_PASSWORD="${MQTT_PASSWORD:-}"
MQTT_TIMEOUT="${MQTT_TIMEOUT:-20}"

# ------------------------------------------------------------------- HA ----

HA_CURL_CONF="$WORK_DIR/curl.conf"

# The token goes into a file curl reads, not onto curl's command line. `ps`
# shows every argument of every process to every user on the machine, and a
# long-lived Home Assistant token is a permanent key to the whole house. The
# file is created 0600 before anything is written to it, inside the WORK_DIR
# that `cleanup` removes on exit.
#
# curl unescapes \ and " inside a quoted config value, so both are escaped on
# the way in; otherwise a token containing either would arrive mangled.
write_curl_conf() {
  local escaped
  escaped=$(printf '%s' "$HA_TOKEN" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  rm -f "$HA_CURL_CONF"
  (
    umask 077
    printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' \
      "$escaped" >"$HA_CURL_CONF"
  )
}

# ha_api METHOD PATH [BODY_FILE] - prints the response body, fails loudly.
ha_api() {
  local method="$1" path="$2" body_file="${3:-}" code out
  out="$WORK_DIR/response.json"
  [ -f "$HA_CURL_CONF" ] || write_curl_conf
  local args
  args=(-sS -o "$out" -w '%{http_code}' -X "$method" --max-time "$HA_TIMEOUT"
    --config "$HA_CURL_CONF")
  if [ -n "$body_file" ]; then
    args=("${args[@]}" --data-binary "@$body_file")
  fi
  if ! code=$(curl "${args[@]}" "${HA_URL%/}$path"); then
    printf 'could not reach Home Assistant at %s. Check HA_URL and that the machine can see it.\n' "${HA_URL%/}" >&2
    return 1
  fi
  case "$code" in
    2*) ;;
    401 | 403)
      printf 'Home Assistant rejected the token (HTTP %s) on %s %s. Check HA_TOKEN.\n' "$code" "$method" "$path" >&2
      return 1
      ;;
    *)
      printf 'Home Assistant answered HTTP %s on %s %s: %s\n' "$code" "$method" "$path" "$(head -c 300 "$out")" >&2
      return 1
      ;;
  esac
  cat "$out"
}

publish_version() {
  local body="$WORK_DIR/state.json"
  # `z2m_started` is the attribute worth having here: the version alone cannot
  # tell a deploy that went live from one that only copied files, because most
  # deploys do not change the version. Attributes that are empty are dropped
  # rather than shown as blanks on the sensor's page.
  jq -n \
    --arg state "$VERSION" \
    --arg commit "$COMMIT" \
    --arg deployed_at "$DEPLOYED_AT" \
    --arg deployed_from "$DEPLOYED_FROM" \
    --arg z2m_started "$LIVE_STARTED" \
    --arg loaded_by "$RELOAD_MODE" \
    --arg friendly_name "$FRIENDLY_NAME" \
    --arg icon "$ICON" \
    '{state: $state, attributes: ({commit: $commit, deployed_at: $deployed_at,
      deployed_from: $deployed_from, z2m_started: $z2m_started,
      loaded_by: $loaded_by, friendly_name: $friendly_name, icon: $icon}
      | with_entries(select(.value != "")))}' \
    >"$body"
  ha_api POST "/api/states/$SENSOR" "$body" >/dev/null
}

# ----------------------------------------------------------------- MQTT ----

# The broker and its credentials go into mosquitto's own defaults file rather
# than onto the command line, for the same reason as the token above: `-P
# secret` is readable from `ps` by any local user, and on this kind of setup
# the broker password opens every device in the house. mosquitto_pub and
# mosquitto_sub each read $XDG_CONFIG_HOME under their own name, so there are
# two files; both are 0600 and both die with WORK_DIR.
#
# mosquitto splits those lines on whitespace and has no quoting at all, so a
# password containing a space cannot be written there. Saying that outright
# beats an authentication failure with no visible cause.
write_mqtt_conf() {
  local client
  case "$MQTT_PASSWORD" in
    *[[:space:]]*)
      abort "MQTT_PASSWORD contains whitespace, which mosquitto's own defaults file cannot express. The alternative is passing it on the command line, where every user on this machine can read it, so this script will not do that."
      ;;
  esac
  for client in mosquitto_pub mosquitto_sub; do
    rm -f "$WORK_DIR/$client"
    (
      umask 077
      {
        printf -- '-h %s\n-p %s\n' "$MQTT_HOST" "$MQTT_PORT"
        if [ -n "$MQTT_USER" ]; then printf -- '-u %s\n' "$MQTT_USER"; fi
        if [ -n "$MQTT_PASSWORD" ]; then printf -- '-P %s\n' "$MQTT_PASSWORD"; fi
      } >"$WORK_DIR/$client"
    )
  done
}

# The only way the mosquitto clients are called, so there is no path left on
# which a credential could reach argv by accident.
mqtt_pub() { XDG_CONFIG_HOME="$WORK_DIR" mosquitto_pub "$@"; }
mqtt_sub() { XDG_CONFIG_HOME="$WORK_DIR" mosquitto_sub "$@"; }

# mqtt_retained TOPIC OUT_FILE [TIMEOUT] - one retained message, or non-zero.
# A retained message arrives the moment the subscription lands, so a timeout
# here means the topic is empty rather than that the network is slow.
mqtt_retained() {
  mqtt_sub -t "$1" -C 1 -W "${3:-$MQTT_TIMEOUT}" >"$2" 2>/dev/null
}

# Seconds since the epoch out of an ISO 8601 timestamp, for comparing times
# without depending on BSD vs GNU `date`. jq's fromdateiso8601 does not accept
# fractional seconds, which `Date.toISOString()` always produces, so they go
# first. Prints nothing when the input is not a timestamp.
iso_to_epoch() {
  printf '%s' "$1" | jq -Rr 'sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch empty'
}

# ----------------------------------------------------------------- facts ---

require_command jq "Install it with: brew install jq (macOS) or apt install jq (Debian/Ubuntu)."
require_command curl "Install it with: brew install curl (macOS) or apt install curl (Debian/Ubuntu)."

[ -f "$REPO_DIR/package.json" ] || abort "package.json is missing, so there is no version to deploy. Run this from a full checkout."
VERSION=$(jq -r '.version // empty' "$REPO_DIR/package.json")
[ -n "$VERSION" ] || abort "package.json has no \"version\" field."

if ! COMMIT=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null); then
  abort "this is not a git checkout, so the deployed commit cannot be recorded."
fi
DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DEPLOYED_FROM=$(hostname -s 2>/dev/null || hostname)

printf '%s %s (%s)\n' "$PROJECT" "$VERSION" "$COMMIT"

# --------------------------------------------------------------- preflight -

step "check prerequisites"
if [ "$VERSION_ONLY" -eq 1 ]; then
  require_settings HA_URL HA_TOKEN
  ok "version sensor only"
else
  require_settings HA_URL HA_TOKEN Z2M_EXTENSIONS_DIR MQTT_HOST
  if [ "$NO_RELOAD" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    require_command mosquitto_pub "Install the Mosquitto clients: brew install mosquitto (macOS) or apt install mosquitto-clients (Debian/Ubuntu)."
    require_command mosquitto_sub "Install the Mosquitto clients: brew install mosquitto (macOS) or apt install mosquitto-clients (Debian/Ubuntu)."
  fi
  [ -f "$REPO_DIR/extension/$EXTENSION_FILE" ] || fail "extension/$EXTENSION_FILE is missing from this checkout."
  [ -d "$REPO_DIR/extension/huelink-lib" ] || fail "extension/huelink-lib is missing from this checkout."
  [ -f "$REPO_DIR/converter/$CONVERTER_FILE" ] || fail "converter/$CONVERTER_FILE is missing from this checkout."
  # The converters directory is the sibling of the extensions one in every
  # stock layout, so guessing it beats making everybody set another key. It is
  # only a guess, though: if the guess is not there, say so instead of
  # creating a directory zigbee2mqtt will never read.
  if [ -z "$Z2M_CONVERTERS_DIR" ]; then
    Z2M_CONVERTERS_DIR="$(dirname "${Z2M_EXTENSIONS_DIR%/}")/external_converters"
  fi
  ok
fi

step "check working tree"
if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    ok "dirty (a real run would need --force)"
  elif [ "$FORCE" -eq 0 ]; then
    fail "the working tree has uncommitted changes, so what you deploy would not match commit $COMMIT. Commit them, stash them, or re-run with --force."
  else
    COMMIT="$COMMIT-dirty"
    ok "dirty, continuing because of --force"
  fi
else
  ok "clean"
fi

# ---------------------------------------------------------------- deploy ---

if [ -n "$MQTT_HOST" ]; then write_mqtt_conf; fi

# none = nothing was asked to load; save = hot reload of huelink.mjs alone;
# restart = a new Node process, the only kind that picks up huelink-lib/.
RELOAD_MODE="none"
# What the running extension says about itself, filled in by the verify step.
# Empty means nobody asked it, and the verdict says so rather than guessing.
LIVE_VERSION=""
LIVE_STARTED=""

# Waits until the live extension reports $VERSION from a process that started
# at or after $1, or until the deadline $2. Gives up early, and differently, if
# zigbee2mqtt has already rejected the file.
#   0 = the new code is live   1 = timed out   2 = refused as invalid
wait_for_live() {
  local min_started="$1" deadline="$2" started_epoch
  while :; do
    if mqtt_retained "$Z2M_BASE_TOPIC/bridge/extensions" "$WORK_DIR/extensions.json" 3; then
      if jq -e --arg n "$EXTENSION_FILE.invalid" 'any(.[]; .name == $n)' \
        <"$WORK_DIR/extensions.json" >/dev/null 2>&1; then
        return 2
      fi
    fi
    if mqtt_retained "$Z2M_BASE_TOPIC/$HUELINK_NAME" "$WORK_DIR/live.json" 3; then
      LIVE_VERSION=$(jq -r '.version // empty' <"$WORK_DIR/live.json")
      LIVE_STARTED=$(jq -r '.started // empty' <"$WORK_DIR/live.json")
      started_epoch=""
      if [ -n "$LIVE_STARTED" ]; then started_epoch=$(iso_to_epoch "$LIVE_STARTED"); fi
      if [ "$LIVE_VERSION" = "$VERSION" ] && [ -n "$started_epoch" ] &&
        [ "$started_epoch" -ge "$min_started" ]; then
        return 0
      fi
    fi
    [ "$(date -u +%s)" -lt "$deadline" ] || return 1
    sleep 3
  done
}

if [ "$VERSION_ONLY" -eq 0 ]; then
  step "copy extension to zigbee2mqtt"
  FILE_COUNT=$(find "$REPO_DIR/extension" -type f | wc -l | tr -d ' ')
  # Taken before the copy, not after, so a process that started while files
  # were still landing cannot pass for one that started after them.
  COPY_STARTED=$(date -u +%s)
  if [ "$DRY_RUN" -eq 1 ]; then
    ok "would copy $FILE_COUNT files into $Z2M_EXTENSIONS_DIR"
    note "and converter/$CONVERTER_FILE into $Z2M_CONVERTERS_DIR"
  else
    [ -d "$Z2M_EXTENSIONS_DIR" ] || fail "Z2M_EXTENSIONS_DIR ($Z2M_EXTENSIONS_DIR) does not exist. Point it at the external_extensions directory of your zigbee2mqtt installation."
    [ -d "$Z2M_CONVERTERS_DIR" ] || fail "the external converters directory ($Z2M_CONVERTERS_DIR) does not exist. Set Z2M_CONVERTERS_DIR to the external_converters directory of your zigbee2mqtt installation."
    # Copied file by file rather than mirrored, because the same directory can
    # hold other people's extensions and deleting those would be rude.
    mkdir -p "$Z2M_EXTENSIONS_DIR/huelink-lib"
    cp "$REPO_DIR/extension/$EXTENSION_FILE" "$Z2M_EXTENSIONS_DIR/$EXTENSION_FILE"
    cp -R "$REPO_DIR/extension/huelink-lib/." "$Z2M_EXTENSIONS_DIR/huelink-lib/"
    # The converter is what gives the strip its extra fields on the device
    # page. It lives in a different directory and was easy to forget, which is
    # how a deploy could leave the extension and its exposes out of step.
    cp "$REPO_DIR/converter/$CONVERTER_FILE" "$Z2M_CONVERTERS_DIR/$CONVERTER_FILE"
    ok "$FILE_COUNT files + $CONVERTER_FILE"
    note "extension -> $Z2M_EXTENSIONS_DIR"
    note "converter -> $Z2M_CONVERTERS_DIR"
    # Pre-1.3.0 name. Never deleted here (it may belong to another extension).
    if [ -d "$Z2M_EXTENSIONS_DIR/lib" ]; then
      note "old $Z2M_EXTENSIONS_DIR/lib is no longer used by HueLink; remove it if nothing else needs it"
    fi
  fi

  step "load the new code"
  if [ "$NO_RELOAD" -eq 1 ]; then
    ok "skipped (--no-reload)"
  elif [ "$DRY_RUN" -eq 1 ]; then
    if [ -n "$Z2M_RESTART_CMD" ]; then
      ok "would run Z2M_RESTART_CMD"
    else
      ok "would publish to $Z2M_BASE_TOPIC/bridge/request/extension/save"
    fi
  elif [ -n "$Z2M_RESTART_CMD" ]; then
    # Deliberately the whole process, not bridge/request/restart: that one
    # restarts zigbee2mqtt inside the same Node process and the ESM module
    # cache, which is where huelink-lib/ lives, survives it untouched.
    if ! bash -c "$Z2M_RESTART_CMD" >"$WORK_DIR/restart.log" 2>&1; then
      fail "Z2M_RESTART_CMD failed: $(tr '\n' ' ' <"$WORK_DIR/restart.log" | head -c 300)"
    fi
    RELOAD_MODE="restart"
    ok "restarted zigbee2mqtt"
  else
    # No way to restart, so this is the best available: zigbee2mqtt writes the
    # file itself and re-imports that one file. huelink-lib/ keeps running the code the
    # process started with, and the verdict at the bottom says so.
    jq -n --arg name "$EXTENSION_FILE" --rawfile code "$REPO_DIR/extension/$EXTENSION_FILE" \
      '{name: $name, code: $code}' >"$WORK_DIR/save.json"
    mqtt_sub -t "$Z2M_BASE_TOPIC/bridge/response/extension/save" \
      -C 1 -W "$MQTT_TIMEOUT" >"$WORK_DIR/save-response.json" 2>"$WORK_DIR/save-response.err" &
    SUB_PID=$!
    # The subscriber has to be on the topic before the request goes out,
    # otherwise the answer arrives before anyone is listening.
    sleep 1
    if ! mqtt_pub -t "$Z2M_BASE_TOPIC/bridge/request/extension/save" \
      -f "$WORK_DIR/save.json" 2>"$WORK_DIR/publish.err"; then
      kill "$SUB_PID" 2>/dev/null || true
      wait "$SUB_PID" 2>/dev/null || true
      fail "could not publish to the MQTT broker at $MQTT_HOST:$MQTT_PORT: $(tr '\n' ' ' <"$WORK_DIR/publish.err")"
    fi
    if ! wait "$SUB_PID"; then
      fail "zigbee2mqtt did not answer on $Z2M_BASE_TOPIC/bridge/response/extension/save within ${MQTT_TIMEOUT}s. Check Z2M_BASE_TOPIC and that zigbee2mqtt is running."
    fi
    SAVE_STATUS=$(jq -r '.status // "unknown"' <"$WORK_DIR/save-response.json")
    if [ "$SAVE_STATUS" != "ok" ]; then
      fail "zigbee2mqtt refused the extension: $(jq -r '.error // "no reason given"' <"$WORK_DIR/save-response.json")"
    fi
    RELOAD_MODE="save"
    ok "bridge accepted $EXTENSION_FILE"
  fi

  step "verify the running code"
  if [ "$DRY_RUN" -eq 1 ] || [ "$RELOAD_MODE" = "none" ]; then
    ok "skipped (nothing was loaded)"
  elif [ "$RELOAD_MODE" = "restart" ]; then
    # The only check in this script that cannot be satisfied by anything except
    # the new code running: the version has to match AND the process has to be
    # younger than the copy. The version alone proves nothing when a deploy
    # does not change it, which is most deploys.
    # Called in this shell, not in $(...): the subshell a command substitution
    # creates would throw away the LIVE_* values the wait filled in.
    LIVE_RC=0
    wait_for_live "$COPY_STARTED" "$(($(date -u +%s) + Z2M_RESTART_WAIT))" || LIVE_RC=$?
    case "$LIVE_RC" in
      0) ok "live $PROJECT $LIVE_VERSION, process started $LIVE_STARTED" ;;
      2) fail "zigbee2mqtt could not compile the extension and renamed it to $EXTENSION_FILE.invalid. Check the zigbee2mqtt log for the error." ;;
      *)
        fail "zigbee2mqtt did not come back with $PROJECT $VERSION within ${Z2M_RESTART_WAIT}s (last seen: version ${LIVE_VERSION:-none}, started ${LIVE_STARTED:-never}). The old code may still be running: check the zigbee2mqtt log."
        ;;
    esac
  else
    if ! mqtt_retained "$Z2M_BASE_TOPIC/bridge/extensions" "$WORK_DIR/extensions.json"; then
      fail "the retained list on $Z2M_BASE_TOPIC/bridge/extensions never arrived, so the reload could not be confirmed."
    fi
    LOADED=$(jq -r '[.[].name] | join(" ")' <"$WORK_DIR/extensions.json")
    case " $LOADED " in
      *" $EXTENSION_FILE.invalid "*)
        fail "zigbee2mqtt could not compile the extension and renamed it to $EXTENSION_FILE.invalid. Check the zigbee2mqtt log for the syntax error."
        ;;
      *" $EXTENSION_FILE "*) ;;
      *) fail "zigbee2mqtt does not list $EXTENSION_FILE among its extensions ($LOADED)." ;;
    esac
    # Give the reloaded extension a moment to republish, then take whatever it
    # says at face value. There is no liveness to prove here: by construction
    # this path did not start a new process.
    sleep 2
    if mqtt_retained "$Z2M_BASE_TOPIC/$HUELINK_NAME" "$WORK_DIR/live.json"; then
      LIVE_VERSION=$(jq -r '.version // empty' <"$WORK_DIR/live.json")
      LIVE_STARTED=$(jq -r '.started // empty' <"$WORK_DIR/live.json")
    fi
    if [ -n "$LIVE_VERSION" ] && [ "$LIVE_VERSION" != "$VERSION" ]; then
      fail "zigbee2mqtt accepted the file but reports $PROJECT $LIVE_VERSION, not $VERSION. Something else is writing to $Z2M_EXTENSIONS_DIR, or the reload did not take."
    fi
    ok "zigbee2mqtt lists $EXTENSION_FILE, live version ${LIVE_VERSION:-unknown}"
    note "hot reload: extension/huelink-lib is still the code this process started with"
    note "set Z2M_RESTART_CMD in .env to deploy huelink-lib/ changes for real"
  fi
fi

# ------------------------------------------------------- version to HA -----

step "publish version to Home Assistant"
if [ "$DRY_RUN" -eq 1 ]; then
  ok "would set $SENSOR = $VERSION"
else
  publish_version || abort "could not publish $SENSOR to Home Assistant (see the message above)."
  ok "$SENSOR = $VERSION"
fi

step "read the sensor back"
if [ "$DRY_RUN" -eq 1 ]; then
  ok "would read $SENSOR back"
  REPORTED="(not read, dry run)"
else
  ha_api GET "/api/states/$SENSOR" >"$WORK_DIR/readback.json" ||
    abort "could not read $SENSOR back from Home Assistant (see the message above)."
  REPORTED=$(jq -r '.state' <"$WORK_DIR/readback.json")
  # Compared against what the LIVE extension reports, not against the value
  # this script just sent: comparing the sensor with our own POST only ever
  # proved that Home Assistant can store a string. $LIVE_VERSION came off the
  # extension's own retained topic, so this is the end-to-end check. It is
  # empty only when nothing was deployed (--version-only, --no-reload), and
  # then falling back to $VERSION is all there is.
  EXPECTED="${LIVE_VERSION:-$VERSION}"
  if [ "$REPORTED" != "$EXPECTED" ]; then
    fail "Home Assistant reports $SENSOR = $REPORTED, but zigbee2mqtt is running $EXPECTED."
  fi
  ok "$SENSOR = $REPORTED"
  note "commit $(jq -r '.attributes.commit' <"$WORK_DIR/readback.json"), deployed_at $(jq -r '.attributes.deployed_at' <"$WORK_DIR/readback.json")"
fi

# --------------------------------------------------------------- verdict ---

printf '\n'
if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s %s dry run: nothing was copied, loaded or published.\n' "$PROJECT" "$VERSION"
elif [ "$VERSION_ONLY" -eq 1 ]; then
  printf '%s %s was not deployed (--version-only); HA reports %s = %s\n' "$PROJECT" "$VERSION" "$SENSOR" "$REPORTED"
elif [ "$RELOAD_MODE" = "restart" ]; then
  printf '%s %s is live: zigbee2mqtt restarted at %s and reports it. HA reports %s = %s\n' \
    "$PROJECT" "$VERSION" "$LIVE_STARTED" "$SENSOR" "$REPORTED"
elif [ "$RELOAD_MODE" = "save" ]; then
  printf '%s %s: %s was hot reloaded, but huelink-lib/ was NOT (no Z2M_RESTART_CMD), so zigbee2mqtt still runs the huelink-lib/ it started with. HA reports %s = %s\n' \
    "$PROJECT" "$VERSION" "$EXTENSION_FILE" "$SENSOR" "$REPORTED"
else
  printf '%s %s was copied but not loaded, so zigbee2mqtt still runs the old code until it restarts; HA reports %s = %s\n' "$PROJECT" "$VERSION" "$SENSOR" "$REPORTED"
fi
