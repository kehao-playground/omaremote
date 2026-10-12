#!/usr/bin/env bash
# Plan 4 §3: host/omaremote-setup's atvvoice step and --mic flow against stubbed cargo, systemctl and
# bluetoothctl. Nothing here builds, installs, or touches a real unit.
# Usage: bash tests/setup-atvvoice.sh [path to omaremote-setup]
set -uo pipefail
SRC=${1:-$(dirname "$0")/../host/omaremote-setup}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ $2 == "$3" ]]; then printf '  ok    %-58s\n' "$1"; else printf '  FAIL  %-58s expected [%s] got [%s]\n' "$1" "$2" "$3"; fail=1; fi; }

# Everything up to main "$@" -- functions and constants, never the call itself.
LIB=$T/lib.sh
sed '/^main "\$@"$/d' "$SRC" > "$LIB"

ADDR=C0:5D:39:C3:45:D1
UUID=ab5e0001-5a21-4f05-bc7d-af01f617b664
REV=0e8f6413dc4bad7a04e3c6b648945439d7a22fac

# run <scenario-env...> : source the script in a subshell with stubs; prints the call log and the exit code
run() {
  (
    export OMAREMOTE_ATV_UNIT=$T/unit/atvvoice.service
    # shellcheck disable=SC1090
    source "$LIB"
    set +e                                 # the script sets -e; the stubs and this harness must not inherit it
    LOG=$T/calls.log; : > "$LOG"
    cargo() {
      printf 'cargo %s\n' "$*" >> "$LOG"
      if [[ $1 == install && ${2:-} == --list ]]; then
        [[ -n ${INSTALLED_REV:-} ]] && printf 'atvvoice v0.2.0 (https://github.com/b0o/ATVVoice?rev=%s#%s):\n    atvvoice\n' "$INSTALLED_REV" "${INSTALLED_REV:0:8}"
        return 0
      fi
      [[ -n ${CARGO_FAILS:-} ]] && { echo "error: failed to fetch" >&2; return 101; }
      return 0
    }
    bluetoothctl() {
      printf 'bluetoothctl %s\n' "$*" >> "$LOG"
      [[ -n ${BT_FAILS:-} ]] && return 1
      case $1 in
        devices) for a in ${BT_ATV:-} ${BT_OTHER:-}; do echo "Device $a Some Name"; done ;;
        info) [[ " ${BT_ATV:-} " == *" $2 "* ]] && echo "	UUID: Vendor specific           ($UUID)"; echo "	UUID: Human Interface Device    (00001812-0000-1000-8000-00805f9b34fb)" ;;
      esac
    }
    systemctl() {
      printf 'systemctl %s\n' "$*" >> "$LOG"
      [[ " $* " == *" is-active "* ]] && { [[ -n ${WAS_ACTIVE:-} ]]; return; }
      return 0
    }
    command() { if [[ $1 == -v && $2 == cargo ]]; then [[ -z ${NO_CARGO:-} ]]; return; fi; builtin command "$@"; }
    ( cmd_atvvoice ) > "$T/out.log" 2>&1   # die() exits: run it in its own subshell so the code is still recorded
    echo "exit=$?" >> "$LOG"
  )
  cat "$T/calls.log"
}
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }

# 1. fresh host: builds, writes the unit, reloads, enables; no restart (was not active)
rm -rf "$T/unit"
out=$(BT_ATV=$ADDR run)
check "fresh: exits 0"                         "yes" "$(has "$out" "exit=0")"
check "fresh: cargo install at the pinned rev" "yes" "$(has "$out" "cargo install --git https://github.com/b0o/ATVVoice --rev $REV --locked atvvoice")"
check "fresh: daemon-reload"                   "yes" "$(has "$out" "systemctl --user daemon-reload")"
check "fresh: enable --now"                    "yes" "$(has "$out" "systemctl --user enable --now atvvoice")"
check "fresh: no restart"                      "no"  "$(has "$out" "systemctl --user restart atvvoice")"
unit=$(cat "$T/unit/atvvoice.service" 2>/dev/null)
check "unit: ExecStart with address and name"  "yes" "$(has "$unit" "ExecStart=%h/.cargo/bin/atvvoice --device $ADDR --name xiaomi")"
check "unit: ExecStart never --mic-on-demand"  "no"  "$(has "$(grep '^ExecStart=' <<<"$unit")" "--mic-on-demand")"   # comments may mention it

# 2. re-run, nothing changed, service active: no build, no rewrite, no reload, no restart, still enable --now
out=$(BT_ATV=$ADDR INSTALLED_REV=$REV WAS_ACTIVE=1 run)
check "rerun: no build"                        "no"  "$(has "$out" "--locked atvvoice")"
check "rerun: no daemon-reload"                "no"  "$(has "$out" "daemon-reload")"
check "rerun: no restart"                      "no"  "$(has "$out" "restart atvvoice")"
check "rerun: enable --now still issued"       "yes" "$(has "$out" "enable --now atvvoice")"

# 3. re-run after the service was stopped/disabled: enable --now brings it back, no restart
out=$(BT_ATV=$ADDR INSTALLED_REV=$REV run)
check "stopped: enable --now"                  "yes" "$(has "$out" "enable --now atvvoice")"
check "stopped: no restart"                    "no"  "$(has "$out" "restart atvvoice")"

# 4. only the binary changed (older rev installed), service active: rebuild + restart, no rewrite
out=$(BT_ATV=$ADDR INSTALLED_REV=1111111111111111111111111111111111111111 WAS_ACTIVE=1 run)
check "binary: rebuilt"                        "yes" "$(has "$out" "--locked atvvoice")"
check "binary: no daemon-reload"               "no"  "$(has "$out" "daemon-reload")"
check "binary: restart"                        "yes" "$(has "$out" "systemctl --user restart atvvoice")"

# 5. unit changed (remote re-paired at a new address), service active: rewrite + reload + restart
out=$(BT_ATV=AA:AA:AA:AA:AA:AA INSTALLED_REV=$REV WAS_ACTIVE=1 run)
check "unit changed: daemon-reload"            "yes" "$(has "$out" "daemon-reload")"
check "unit changed: restart"                  "yes" "$(has "$out" "systemctl --user restart atvvoice")"
check "unit changed: new address written"      "yes" "$(has "$(cat "$T/unit/atvvoice.service")" "--device AA:AA:AA:AA:AA:AA")"

# 6. no ATVV remote paired (Review focus 5): stops, names the problem, writes nothing
rm -rf "$T/unit"
out=$(BT_OTHER=11:22:33:44:55:66 INSTALLED_REV=$REV run)
check "none: exits non-zero"                   "no"  "$(has "$out" "exit=0")"
check "none: no unit written"                  "no"  "$([[ -e $T/unit/atvvoice.service ]] && echo yes || echo no)"
check "none: message names the cause"          "yes" "$(has "$(cat "$T/out.log")" "no paired ATVV remote")"
check "none: no enable"                        "no"  "$(has "$out" "enable --now")"

# 7. bluetoothctl fails (Bluetooth off): same as none
out=$(BT_FAILS=1 INSTALLED_REV=$REV run)
check "bt off: exits non-zero"                 "no"  "$(has "$out" "exit=0")"
check "bt off: message names the cause"        "yes" "$(has "$(cat "$T/out.log")" "no paired ATVV remote")"

# 8. two ATVV remotes: stops and names both
out=$(BT_ATV="$ADDR AA:AA:AA:AA:AA:AA" INSTALLED_REV=$REV run)
check "two: exits non-zero"                    "no"  "$(has "$out" "exit=0")"
check "two: both named"                        "yes" "$(has "$(cat "$T/out.log")" "$ADDR AA:AA:AA:AA:AA:AA")"

# 9. cargo install fails (Review focus 4): stops with the error; existing unit and service untouched
mkdir -p "$T/unit"; printf 'EXISTING\n' > "$T/unit/atvvoice.service"
out=$(BT_ATV=$ADDR CARGO_FAILS=1 WAS_ACTIVE=1 run)
check "cargo fails: exits non-zero"            "no"  "$(has "$out" "exit=0")"
check "cargo fails: unit untouched"            "EXISTING" "$(cat "$T/unit/atvvoice.service")"
check "cargo fails: no systemctl mutation"     "no"  "$(grep -qE 'systemctl --user (daemon-reload|enable|restart)' <<<"$out" && echo yes || echo no)"

# 10. no cargo: prints the rustup command for the user and stops before anything else
out=$(NO_CARGO=1 BT_ATV=$ADDR run)
check "no cargo: exits non-zero"               "no"  "$(has "$out" "exit=0")"
check "no cargo: prints the rustup command"    "yes" "$(has "$(cat "$T/out.log")" "sudo pacman -S rustup && rustup default stable")"

# ---- --mic and the default flow ----
flow() {   # flow <args...>: run main with every cmd_* stubbed; prints the call order and exit code
  (
    source "$LIB"
    set +e
    for c in cmd_deps cmd_keyd cmd_binds cmd_plugin cmd_atvvoice cmd_verify; do eval "$c() { echo $c; }"; done
    cmd_mic() { echo "cmd_mic $1"; }
    ( main "$@" ) 2>&1; echo "exit=$?"
  ) | tr '\n' ' '
}
check "default flow ends with mic remote"  "cmd_deps cmd_keyd cmd_binds cmd_plugin cmd_atvvoice cmd_mic remote cmd_verify exit=0 " "$(flow)"
check "--mic system skips atvvoice"        "cmd_deps cmd_keyd cmd_binds cmd_plugin cmd_mic system cmd_verify exit=0 " "$(flow --mic system)"
check "--mic remote is the default flow"   "cmd_deps cmd_keyd cmd_binds cmd_plugin cmd_atvvoice cmd_mic remote cmd_verify exit=0 " "$(flow --mic remote)"
check "--mic bogus is a usage error"       "yes" "$(flow --mic bogus | grep -q 'exit=1' && echo yes || echo no)"
check "bare --mic is a usage error, no hang" "yes" "$(timeout 5 bash -c "$(declare -f flow); LIB=$LIB; flow --mic" | grep -q 'exit=1' && echo yes || echo no)"
check "atvvoice subcommand dispatches"     "cmd_atvvoice exit=0 " "$(flow atvvoice)"
# The mic subcommand honours an explicit --mic; with neither it keeps its old default (system).
check "mic subcommand alone stays system"  "cmd_mic system exit=0 " "$(flow mic)"
check "--mic remote mic applies remote"    "cmd_mic remote exit=0 " "$(flow --mic remote mic)"
check "--mic system mic applies system"    "cmd_mic system exit=0 " "$(flow --mic system mic)"
check "mic's own argument wins over --mic" "cmd_mic system exit=0 " "$(flow --mic remote mic system)"

# ---- cmd_mic remote waits for the remote's audio node (fresh host: ATVVoice registers late) ----
# micrun <scenario-env...>: cmd_mic with ipc stubbed. NODE_AFTER=n -> .remote.node is empty for the first n
# status polls, then atvvoice-xiaomi; NODE_AFTER=never -> it never appears. Prints the call log + exit code.
micrun() {
  (
    source "$LIB"
    set +e
    LOG=$T/mic.log; : > "$LOG"; echo 0 > "$T/polls"
    ipc() {
      printf 'ipc %s\n' "$*" >> "$LOG"
      case $1 in
        status)
          local n; n=$(( $(cat "$T/polls") + 1 )); echo "$n" > "$T/polls"
          if [[ $NODE_AFTER != never ]] && (( n > NODE_AFTER )); then echo '{"remote":{"node":"atvvoice-xiaomi"}}'
          else echo '{"remote":{"node":""}}'; fi ;;
        mic) echo '{"ok":true,"operationId":"op-1"}' ;;
        micStatus) echo '{"state":"succeeded"}' ;;
      esac
    }
    sleep() { :; }                                    # the poll interval is real time; the tries are what is under test
    ( cmd_mic "$1" ) > "$T/mic.out" 2>&1
    echo "exit=$?" >> "$LOG"
  )
  cat "$T/mic.log"
}
out=$(NODE_AFTER=3 OMAREMOTE_NODE_WAIT_MS=2000 OMAREMOTE_NODE_POLL_MS=100 micrun remote)
check "node late: exits 0"                     "yes" "$(has "$out" "exit=0")"
check "node late: mic remote applied"          "yes" "$(has "$out" "ipc mic remote")"
check "node late: polled until the node"       "4"   "$(grep -c '^ipc status' <<<"$out")"
check "node late: status polled before apply"  "ipc status" "$(grep -m1 '^ipc \(status\|mic \)' <<<"$out")"
check "node late: wake hint printed once"      "1"   "$(grep -c 'press any button on the remote' "$T/mic.out")"
out=$(NODE_AFTER=never OMAREMOTE_NODE_WAIT_MS=1000 OMAREMOTE_NODE_POLL_MS=100 micrun remote)
check "no node: exits non-zero"                "no"  "$(has "$out" "exit=0")"
check "no node: no mic apply"                  "no"  "$(has "$out" "ipc mic ")"
check "no node: bounded by the wait"           "10"  "$(grep -c '^ipc status' <<<"$out")"
check "no node: says how to retry"             "yes" "$(has "$(cat "$T/mic.out")" "omaremote-setup mic remote")"
out=$(NODE_AFTER=0 micrun remote)
check "node present: no hint"                  "0"   "$(grep -c 'press any button on the remote' "$T/mic.out")"
check "node present: mic remote applied"       "yes" "$(has "$out" "ipc mic remote")"
out=$(NODE_AFTER=never OMAREMOTE_NODE_WAIT_MS=1000 OMAREMOTE_NODE_POLL_MS=100 micrun system)
check "system mode: never waits for a node"    "0"   "$(grep -c '^ipc status' <<<"$out")"
check "system mode: mic system applied"        "yes" "$(has "$out" "ipc mic system")"

# ---- host/omaremote-facts: atvvoice.micOnDemand is unknown (null) when the unit is not loaded ----
# A PATH holding only the tools the script needs plus stubs: no real systemctl/busctl/voxtype/hyprctl/pw-dump
# is reachable, and HOME is a temp dir. `systemctl show` on a missing unit really prints nothing and exits 0.
FACTS=$(dirname "$SRC")/omaremote-facts
FB=$T/fbin; mkdir -p "$FB" "$T/home"
for t in bash env jq awk grep sed timeout cat; do ln -sf "$(type -P "$t")" "$FB/$t"; done
cat > "$FB/systemctl" <<'STUB'
#!/bin/bash
case " $* " in
  *" show atvvoice "*"--property=LoadState"*) [[ -n ${FAKE_LOADSTATE:-} ]] && echo "$FAKE_LOADSTATE" ;;
  *" show atvvoice "*"--property=ExecStart"*) [[ ${FAKE_LOADSTATE:-} == loaded ]] && echo "{ path=/x/atvvoice ; argv[]=/x/atvvoice ${FAKE_EXEC:-"--device A --name xiaomi"} ; }" ;;
  *" is-active "*) exit 3 ;;
esac
exit 0
STUB
printf '#!/bin/bash\nexit 0\n' > "$FB/busctl"
chmod +x "$FB/systemctl" "$FB/busctl"
facts() { env -i PATH="$FB" HOME="$T/home" FAKE_LOADSTATE="${FAKE_LOADSTATE:-}" FAKE_EXEC="${FAKE_EXEC:-}" "$FB/bash" "$FACTS" | "$FB/jq" -c '.atvvoice.micOnDemand'; }
check "facts: missing unit -> micOnDemand null"     "null"  "$(FAKE_LOADSTATE=not-found facts)"
check "facts: no LoadState at all -> null"          "null"  "$(FAKE_LOADSTATE= facts)"
check "facts: loaded, button only -> false"         "false" "$(FAKE_LOADSTATE=loaded facts)"
check "facts: loaded, --mic-on-demand -> true"      "true"  "$(FAKE_LOADSTATE=loaded FAKE_EXEC='--mic-on-demand' facts)"

# alsa.pcms: names from `arecord -L` (unindented lines). Stubbed arecord; absent from FB by default.
cat > "$FB/arecord-stub" <<'STUB'
#!/bin/bash
[[ -n ${FAKE_ARECORD_FAIL:-} ]] && exit 1
printf 'null\n    Discard all samples (playback) or generate zero samples (capture)\natvvoice-xiaomi\n    ATVVoice remote (atvvoice-xiaomi)\nsysdefault:CARD=PCH\n    HDA Intel PCH\n'
STUB
chmod +x "$FB/arecord-stub"
pcms() { env -i PATH="$FB" HOME="$T/home" FAKE_ARECORD_FAIL="${FAKE_ARECORD_FAIL:-}" "$FB/bash" "$FACTS" | "$FB/jq" -c '.alsa.pcms'; }
check "facts: no arecord -> alsa.pcms null"         "null"  "$(pcms)"
ln -sf "$FB/arecord-stub" "$FB/arecord"
check "facts: arecord -L names only, no descriptions" '["null","atvvoice-xiaomi","sysdefault:CARD=PCH"]' "$(pcms)"
check "facts: arecord fails -> alsa.pcms null"      "null"  "$(FAKE_ARECORD_FAIL=1 pcms)"
rm -f "$FB/arecord"

printf '\n%s\n' "$([[ $fail == 0 ]] && echo 'RESULT: PASS' || echo 'RESULT: FAIL')"
exit $fail
