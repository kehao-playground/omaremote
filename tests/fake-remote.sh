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

# ---- Task 6: voice session through real adapters + fakes ----
ready() { wait_for '.config' true 5 && wait_for '.backend' idle 5 && wait_for '.remote.sender' ":1.99" 5; }
s_hid_session() {
  ready || return 1
  ipc key mic down > /dev/null
  wait_for '.voice.state' recording 3 || return 1
  [[ $(jget '.voice.owner') == hid ]] || return 1
  [[ $(jget '.hud') == "● 00:00" || $(jget '.hud') == "● 00:01" ]] || { echo "    hud=$(jget '.hud')"; return 1; }
  has_line "$F/vox.log" "voxtype record start" || return 1
  ipc key mic up > /dev/null
  wait_for '.voice.state' idle 5 || return 1
  has_line "$F/vox.log" "voxtype record stop" || return 1
  no_line "$F/vox.log" "voxtype record cancel"
}
s_hid_release_while_starting() {          # §9: no stop before confirmed recording; exactly one stop on confirmation
  ready || return 1
  echo 0.4 > "$F/vox.start-delay"
  ipc key mic down > /dev/null; sleep 0.1; ipc key mic up > /dev/null; sleep 0.1
  no_line "$F/vox.log" "voxtype record stop" || return 1
  wait_for '.voice.state' idle 5 || return 1
  (( $(grep -cxF "voxtype record stop" "$F/vox.log") == 1 ))
}
s_start_never_confirms() {                # §9: 1500 ms without recording → cancel + recovering; settles without a daemon restart
  ready || return 1
  : > "$F/vox.no-confirm"
  ipc key mic down > /dev/null
  wait_for '.voice.state' recovering 3 || return 1
  has_line "$F/vox.log" "voxtype record cancel" || return 1
  ipc key mic up > /dev/null
  wait_for '.voice.state' idle 6 || return 1
  no_line "$F/sysd.log" "systemctl --user restart voxtype"
}
s_dbus_arbitration_short_tap() {          # §9: release before 250 ms → no plugin start
  ready || return 1
  echo streaming >> "$F/atv.signals"
  wait_for '.voice.state' arbitrating 2 || return 1
  echo connected >> "$F/atv.signals"
  wait_for '.voice.state' idle 2 || return 1
  no_line "$F/vox.log" "voxtype record start"
}
s_dbus_session() {                        # button held: fresh re-reads at 250 ms allow the start; release → re-read → stop
  ready || return 1
  echo streaming >> "$F/atv.signals"
  wait_for '.voice.state' recording 3 || return 1
  [[ $(jget '.voice.owner') == dbus ]] || return 1
  [[ $(jget '.voice.inferred') == true ]] || return 1
  echo connected >> "$F/atv.signals"
  wait_for '.voice.state' idle 5 || return 1
  has_line "$F/vox.log" "voxtype record stop"
}
s_voice_state_verb() {                    # §2: `voice state <state>` injects a D-Bus state for deterministic tests
  ready || return 1
  ipc voice state streaming > /dev/null
  wait_for '.voice.state' arbitrating 2 || return 1
  ipc voice state connected > /dev/null
  wait_for '.voice.state' idle 2
}
s_keyboard_session_observed() {           # F9 elsewhere: recording not requested by us → owner keyboard, no plugin commands
  ready || return 1
  echo recording > "$F/vox.state"
  wait_for '.voice.state' recording 3 || return 1
  [[ $(jget '.voice.owner') == keyboard ]] || return 1
  echo transcribing > "$F/vox.state"
  wait_for '.voice.state' transcribing 3 || return 1
  [[ $(jget '.hud') == "… transcribing" ]] || return 1
  echo idle > "$F/vox.state"
  wait_for '.voice.state' idle 3 || return 1
  ! grep -q "voxtype record" "$F/vox.log"
}
s_panic_during_recording() {              # §9: reset cancels (never stops) and recovers
  ready || return 1
  ipc key mic down > /dev/null
  wait_for '.voice.state' recording 3 || return 1
  ipc reset > /dev/null
  wait_for '.voice.state' recovering 2 || return 1
  has_line "$F/vox.log" "voxtype record cancel" || return 1
  no_line "$F/vox.log" "voxtype record stop" || return 1
  [[ $(jget '.flash') == Reset ]] || return 1
  ipc key mic up > /dev/null
  wait_for '.voice.state' idle 6
}
s_config_reload_aborts_session() {        # §5.2: abort on config reload; keys still hot-reload
  ready || return 1
  ipc key mic down > /dev/null
  wait_for '.voice.state' recording 3 || return 1
  local f=$XDG_CONFIG_HOME/omaremote/config.json
  jq '.timing.holdMs = 700' "$f" > "$F/c.json" && cat "$F/c.json" > "$f"
  wait_for '.voice.state' recovering 5 || return 1
  has_line "$F/vox.log" "voxtype record cancel" || return 1
  ipc key mic up > /dev/null
  wait_for '.timing.holdMs' 700 2
}
s_voxtype_absent_is_unconfigured() {      # §5.4: stopped → unconfigured, starts refused; healthy again → idle
  ready || return 1
  : > "$F/vox.stopped"
  ipc voice poll - > /dev/null
  wait_for '.voice.state' unconfigured 3 || return 1
  ipc key mic down > /dev/null; sleep 0.1; ipc key mic up > /dev/null
  no_line "$F/vox.log" "voxtype record start" || return 1
  rm "$F/vox.stopped"; ipc voice poll - > /dev/null
  wait_for '.voice.state' idle 3
}
s_remote_warning_disables_dbus_path() {   # §5.4: audio.device ≠ NodeName in remote mode → warning, D-Bus start path off, HID still works
  ready || return 1
  printf 'default' > "$F/vox.config"
  ipc voice audioDevice - > /dev/null
  wait_for '.remote.warning' true 3 || return 1
  echo streaming >> "$F/atv.signals"; sleep 0.4
  [[ $(jget '.voice.state') == idle ]] || return 1
  echo connected >> "$F/atv.signals"
  ipc key mic down > /dev/null
  wait_for '.voice.state' recording 3 || return 1
  ipc key mic up > /dev/null
  wait_for '.voice.state' idle 5
}
scenario hid_session s_hid_session
scenario hid_release_while_starting s_hid_release_while_starting
scenario start_never_confirms s_start_never_confirms
scenario dbus_arbitration_short_tap s_dbus_arbitration_short_tap
scenario dbus_session s_dbus_session
scenario voice_state_verb s_voice_state_verb
scenario keyboard_session_observed s_keyboard_session_observed
scenario panic_during_recording s_panic_during_recording
scenario config_reload_aborts_session s_config_reload_aborts_session
scenario voxtype_absent_is_unconfigured s_voxtype_absent_is_unconfigured
scenario remote_warning_disables_dbus_path s_remote_warning_disables_dbus_path

# ---- Task 7: mic apply, recovery restart, stats, capture ----
mic_wait() {   # mic_wait <id> [timeout-s] → prints terminal state
  local id=$1 t=${2:-15} i=0 st=""
  while (( i < t * 10 )); do st=$(ipc micStatus "$id" | jq -r .state); [[ $st == succeeded || $st == failed ]] && { echo "$st"; return 0; }; sleep 0.1; i=$((i + 1)); done
  echo "$st"; return 1
}
s_mic_apply_system() {
  ready || return 1
  local r; r=$(ipc mic system)
  [[ $(jq -r .ok <<<"$r") == true && $(jq -r .state <<<"$r") == queued ]] || { echo "    $r"; return 1; }
  local id; id=$(jq -r .operationId <<<"$r")
  [[ $(mic_wait "$id") == succeeded ]] || { ipc micStatus "$id"; return 1; }
  has_line "$F/vox.log" "voxtype config get audio.device --json" || return 1
  has_line "$F/vox.log" "voxtype config set audio.device default" || return 1
  has_line "$F/sysd.log" "systemctl --user restart voxtype" || return 1
  has_line "$F/sysd.log" "systemctl --user show voxtype --property=Job,ActiveState,InvocationID --value" || return 1
  [[ $(jq -r .voice.mic "$XDG_CONFIG_HOME/omaremote/config.json") == system ]] || return 1     # commit only after verification
  [[ $(jget '.voice.state') == idle && $(jget '.mic.pending') == false ]] || return 1
  [[ $(jget '.audioDevice') == default ]]                                                         # re-read after commit
}
s_mic_apply_second_request_is_busy() {
  ready || return 1
  local id; id=$(ipc mic system | jq -r .operationId)
  [[ $(ipc mic remote | jq -r .reason) == busy ]] || return 1
  [[ $(mic_wait "$id") == succeeded ]]
}
s_mic_apply_unknown_id_is_failure() { ready || return 1; [[ $(ipc micStatus mic-99 | jq -r .ok) == false ]]; }
s_mic_apply_waits_for_session() {         # §3 step 1: no mutation while a session runs; HUD explains; applies afterwards
  ready || return 1
  ipc key mic down > /dev/null; wait_for '.voice.state' recording 3 || return 1
  local id; id=$(ipc mic system | jq -r .operationId)
  sleep 0.6
  no_line "$F/vox.log" "voxtype config set audio.device default" || return 1
  [[ $(jget '.hud') == *"mic change applies after this dictation"* ]] || { echo "    hud=$(jget '.hud')"; return 1; }
  ipc key mic up > /dev/null
  [[ $(mic_wait "$id") == succeeded ]]
}
s_mic_apply_restart_fails_rolls_back() {  # §9: verification fails → rollback restores the old literal; mode not committed
  ready || return 1
  : > "$F/sysd.restart-fails-once"
  local id; id=$(ipc mic system | jq -r .operationId)
  [[ $(mic_wait "$id" 25) == failed ]] || return 1
  local s; s=$(ipc micStatus "$id")
  [[ $(jq -r .rollback <<<"$s") == verified ]] || { echo "    $s"; return 1; }
  [[ $(cat "$F/vox.config") == atvvoice_mic ]] || return 1
  [[ $(jq -r .voice.mic "$XDG_CONFIG_HOME/omaremote/config.json") == remote ]] || return 1
  [[ $(jget '.voice.state') == idle ]]
}
s_mic_apply_job_pending_blocks() {         # §3: a live systemd job (any origin) blocks the initial mutation
  ready || return 1
  printf '55 start\n' > "$F/sysd.job"
  local id; id=$(ipc mic system | jq -r .operationId)
  [[ $(mic_wait "$id" 8) == failed ]] || return 1
  no_line "$F/vox.log" "voxtype config set audio.device default" || return 1
  no_line "$F/sysd.log" "systemctl --user restart voxtype" || return 1
  : > "$F/sysd.job"
  id=$(ipc mic system | jq -r .operationId)
  [[ $(mic_wait "$id") == succeeded ]]
}
s_recovery_restart_bounded() {             # §5.3/§9: daemon hangs after abort (cancel ignored, polls unanswered) → one bounded restart → verified → idle
  ready || return 1
  ipc key mic down > /dev/null; wait_for '.voice.state' recording 3 || return 1
  : > "$F/vox.cancel-ignored"; : > "$F/vox.hang"
  ipc reset > /dev/null
  wait_for '.voice.state' recovering 2 || return 1
  has_line "$F/vox.log" "voxtype record cancel" || return 1
  sleep 5; [[ $(jget '.voice.state') == recovering ]] || return 1          # no premature restart or unconfigured
  no_line "$F/sysd.log" "systemctl --user restart voxtype" || return 1
  for _ in $(seq 1 200); do grep -qxF "systemctl --user restart voxtype" "$F/sysd.log" && break; sleep 0.1; done   # ≈15 s budget
  has_line "$F/sysd.log" "systemctl --user restart voxtype" || return 1
  [[ $(jget '.hud') == "restarting Voxtype" || $(jget '.voice.state') == idle ]] || return 1
  ipc key mic up > /dev/null
  wait_for '.voice.state' idle 15 || return 1                              # verified restart → fresh idle → settle
  (( $(grep -cxF "systemctl --user restart voxtype" "$F/sysd.log") == 1 ))
}
s_stats_and_capture() {                    # §5.5 + §3 capture verification
  ready || return 1
  ipc key mic down > /dev/null; wait_for '.voice.state' recording 3 || return 1
  sleep 0.6
  ipc key mic up > /dev/null; wait_for '.voice.state' idle 5 || return 1
  wait_for '.stats.all.count' 1 3 || return 1
  jq -e 'length == 1 and .[0].source == "hid" and .[0].inferred == false' "$XDG_DATA_HOME/omaremote/stats.json" > /dev/null || return 1
  [[ $(jget '.lastCapture.node') == atvvoice_mic ]] || { echo "    lastCapture=$(jget '.lastCapture')"; return 1; }
  has_line "$F/actions.log" "pw-dump "   # fake-log quirk: a zero-arg invocation logs "basename " with a trailing space
}
scenario mic_apply_system s_mic_apply_system
scenario mic_apply_second_request_is_busy s_mic_apply_second_request_is_busy
scenario mic_apply_unknown_id_is_failure s_mic_apply_unknown_id_is_failure
scenario mic_apply_waits_for_session s_mic_apply_waits_for_session
scenario mic_apply_restart_fails_rolls_back s_mic_apply_restart_fails_rolls_back
scenario mic_apply_job_pending_blocks s_mic_apply_job_pending_blocks
scenario recovery_restart_bounded s_recovery_restart_bounded
scenario stats_and_capture s_stats_and_capture

# ---- summary ---------------------------------------------------------------------
echo "integration: $pass passed, $fail failed"
(( fail == 0 )) || { printf '  %s\n' "${failed[@]}"; exit 1; }
exit 0
