#!/usr/bin/env bash
# Spec §9 "integration, no hardware": deterministic IPC sequences against fake process/status/D-Bus adapters.
# Runs a second Quickshell instance (tests/harness) — never the user's omarchy-shell — with PATH prefixed by tests/fakes/bin
# and XDG dirs pointed at a temp directory, so nothing types into the desktop or touches ~/.config/omaremote.
# Usage: tests/fake-remote.sh [scenario-name]
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# Non-interactive shells lack the session variables; recover them like /usr/bin/omarchy-shell does.
RUNTIME=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
if [[ -z ${WAYLAND_DISPLAY:-} ]]; then s=$(ls -t "$RUNTIME"/wayland-[0-9]* 2>/dev/null | grep -v '\.lock$' | head -n1); [[ -n $s ]] && export WAYLAND_DISPLAY=${s##*/}; fi
if [[ -z ${HYPRLAND_INSTANCE_SIGNATURE:-} ]]; then s=$(ls -t "$RUNTIME/hypr" 2>/dev/null | head -n1); [[ -n $s ]] && export HYPRLAND_INSTANCE_SIGNATURE=$s; fi

OMAREMOTE_FAKE_DIR=$(mktemp -d /tmp/omaremote-fake.XXXXXX); export OMAREMOTE_FAKE_DIR
export XDG_CONFIG_HOME=$OMAREMOTE_FAKE_DIR/config XDG_DATA_HOME=$OMAREMOTE_FAKE_DIR/data
export OMAREMOTE_IPC_TARGET=omaremote-test OMAREMOTE_APPID=omaremote-test
export OMAREMOTE_DISPATCH=hyprctl            # dispatch actions go to the fake hyprctl, never to the live compositor
export PATH=$ROOT/tests/fakes/bin:$PATH
ONLY=${1:-}
pass=0; fail=0; failed=(); HPID=""
F=$OMAREMOTE_FAKE_DIR
HARNESS=$F/harness # materialized by start_harness — Quickshell only loads QML under its config root

ipc() { qs ipc -p "$HARNESS" call -- omaremote-test "$@"; }
jget() { ipc status | jq -r "$1"; }
wait_for() {   # wait_for <jq-expr> <expected> [timeout-s]
  local expr=$1 want=$2 t=${3:-3} i=0 got=""
  while (( i < t * 20 )); do got=$(jget "$expr" 2>/dev/null || true); [[ $got == "$want" ]] && return 0; sleep 0.05; i=$((i + 1)); done
  echo "    wait_for '$expr' == '$want' timed out (last: '$got')"; return 1
}
has_line() { grep -qxF "$2" "$1" || { echo "    expected line '$2' in $(basename "$1"):"; sed 's/^/      /' "$1" 2>/dev/null; return 1; }; }
no_line() { ! grep -qxF "$2" "$1" || { echo "    unexpected line '$2' in $(basename "$1")"; return 1; }; }
reset_fakes() {
  rm -rf "${F:?}"/*; mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
  echo idle > "$F/vox.state"; echo inv-0 > "$F/sysd.invocation"; : > "$F/actions.log"
  : > "$F/atv.present"; echo connected > "$F/atv.state"; printf 'atvvoice_mic' > "$F/vox.config"
  cp "$ROOT/tests/fixtures/pw-dump.json" "$F/pw-dump.json"
}
start_harness() {
  mkdir -p "$HARNESS"; cp "$ROOT/tests/harness/shell.qml" "$HARNESS/shell.qml"
  for e in Service.qml lib components host; do [[ -e $ROOT/$e ]] && ln -sfn "$ROOT/$e" "$HARNESS/$e"; done
  qs -p "$HARNESS" --no-duplicate > "$F/harness.log" 2>&1 & HPID=$!
  for _ in $(seq 1 100); do [[ $(ipc ping 2>/dev/null) == ok ]] && return 0; sleep 0.1; done
  echo "    harness did not answer ping:"; sed 's/^/      /' "$F/harness.log"; return 1
}
stop_harness() { [[ -n $HPID ]] && { kill "$HPID" 2>/dev/null; wait "$HPID" 2>/dev/null; }; HPID=""; }
scenario() {   # scenario <name> <function>
  local name=$1 fn=$2
  [[ -n $ONLY && $ONLY != "$name" ]] && return 0
  reset_fakes
  if ! start_harness; then fail=$((fail + 1)); failed+=("$name (harness)"); stop_harness; return 0; fi
  if "$fn"; then pass=$((pass + 1)); echo "ok   $name"; else fail=$((fail + 1)); failed+=("$name"); echo "FAIL $name"; grep -i 'omaremote\|error\|warn' "$F/harness.log" | tail -20 | sed 's/^/      /'; fi
  stop_harness
}
trap 'stop_harness; rm -rf "$OMAREMOTE_FAKE_DIR"' EXIT

# ---- scenarios (each task appends its own below its marker) ----------------------
s_ping() { [[ $(ipc ping) == ok ]]; }
scenario ping s_ping

# ---- Task 5: config + engine + actions ----
s_config_created() {
  wait_for '.config' true 5 || return 1
  jq -e '.version == 1 and .keys.menu.panic == true' "$XDG_CONFIG_HOME/omaremote/config.json" > /dev/null
}
s_tap_and_hold() {
  wait_for '.config' true 5 || return 1
  ipc key ok down > /dev/null; sleep 0.45; ipc key ok up > /dev/null; sleep 0.15
  has_line "$F/actions.log" "wtype -M ctrl -k c -m ctrl" || return 1
  [[ $(jget '.lastAction') == "ok:hold:Ctrl+C" ]] || { echo "    lastAction=$(jget '.lastAction')"; return 1; }
  [[ $(jget '.flash') == "OK · hold → Ctrl+C" ]] || return 1
  ipc key ok down > /dev/null; ipc key ok up > /dev/null; sleep 0.15
  has_line "$F/actions.log" "wtype -k Return"
}
s_simple_key_fires_on_press() {
  wait_for '.config' true 5 || return 1
  ipc key home down > /dev/null; sleep 0.15
  [[ $(jget '.lastAction') == "home:tap:exec omarchy-menu" ]] || return 1
  has_line "$F/actions.log" "hyprctl dispatch exec omarchy-menu"      # OMAREMOTE_DISPATCH=hyprctl in the harness; live shell uses Hyprland.dispatch
}
s_repeat() {
  wait_for '.config' true 5 || return 1
  ipc key up down > /dev/null; sleep 0.65; ipc key up up > /dev/null; sleep 0.1
  (( $(grep -cxF "wtype -k Up" "$F/actions.log") >= 3 ))
}
s_panic_reset() {
  wait_for '.config' true 5 || return 1
  ipc key menu down > /dev/null; sleep 1.6
  [[ $(jget '.flash') == Reset ]] || { echo "    flash=$(jget '.flash')"; return 1; }
  [[ $(jget '.heldKeys | length') == 0 ]] || return 1
  ipc key menu up > /dev/null; sleep 0.1
  no_line "$F/actions.log" "wtype -k Tab"
}
s_ipc_reset_clears_held_keys() {
  wait_for '.config' true 5 || return 1
  ipc key ok down > /dev/null; sleep 0.05
  [[ $(jget '.heldKeys | join(",")') == ok ]] || return 1
  [[ $(ipc reset) == ok ]] && wait_for '.heldKeys | length' 0
}
s_config_external_reload() {
  wait_for '.config' true 5 || return 1
  local f=$XDG_CONFIG_HOME/omaremote/config.json
  jq '.timing.holdMs = 900 | .keep_me = {"x": 1}' "$f" > "$F/c.json" && cat "$F/c.json" > "$f"     # in-place: keep the watched inode
  wait_for '.timing.holdMs' 900 5 || return 1
  ipc key ok down > /dev/null; sleep 0.5; ipc key ok up > /dev/null; sleep 0.15
  has_line "$F/actions.log" "wtype -k Return"                                                        # 500 ms < new holdMs: tap, not hold
}
s_corrupt_config_never_overwritten() {
  wait_for '.config' true 5 || return 1
  local f=$XDG_CONFIG_HOME/omaremote/config.json
  printf '{ broken' > "$f"
  wait_for '.configInvalid' true 5 || return 1
  ipc key ok down > /dev/null; ipc key ok up > /dev/null; sleep 0.15
  has_line "$F/actions.log" "wtype -k Return" || return 1          # defaults keep working
  [[ $(cat "$f") == '{ broken' ]]
}
scenario config_created s_config_created
scenario tap_and_hold s_tap_and_hold
scenario simple_key_fires_on_press s_simple_key_fires_on_press
scenario repeat s_repeat
scenario panic_reset s_panic_reset
scenario ipc_reset_clears_held_keys s_ipc_reset_clears_held_keys
scenario config_external_reload s_config_external_reload
scenario corrupt_config_never_overwritten s_corrupt_config_never_overwritten

# ---- summary ---------------------------------------------------------------------
echo "integration: $pass passed, $fail failed"
(( fail == 0 )) || { printf '  %s\n' "${failed[@]}"; exit 1; }
exit 0
