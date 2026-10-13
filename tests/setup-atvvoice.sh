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
  [[ -n ${KEEPSTATE:-} ]] || unstamp       # each scenario starts from "nothing installed" unless it asks for a stamp (or KEEPSTATE=1: a re-run)
  if [[ -n ${STAMPED:-} ]]; then stamp "${STAMP_TEXT:-}"; [[ -z ${NOBIN:-} ]] || rm -f "$T/bin/atvvoice"; fi
  (
    export OMAREMOTE_ATV_UNIT=$T/unit/atvvoice.service
    export OMAREMOTE_ALSA_RC=$T/alsa/asoundrc                  # never the user's ~/.config/alsa
    export OMAREMOTE_ATV_STAMP=$T/state/atvvoice.build         # never ~/.local/state
    export OMAREMOTE_ATV_BIN=$T/bin/atvvoice                   # never ~/.cargo/bin
    : > "$T/pw-present"; export OMAREMOTE_PW_ALSA_PROBE=${PW_PROBE:-$T/pw-present}
    # shellcheck disable=SC1090
    source "$LIB"
    set +e                                 # the script sets -e; the stubs and this harness must not inherit it
    LOG=$T/calls.log; : > "$LOG"
    cargo() {
      printf 'cargo %s\n' "$*" >> "$LOG"
      [[ -n ${CARGO_FAILS:-} ]] && { echo "error: failed to fetch" >&2; return 101; }
      if [[ $1 == install ]]; then mkdir -p "$(dirname "$OMAREMOTE_ATV_BIN")"; : > "$OMAREMOTE_ATV_BIN"; chmod +x "$OMAREMOTE_ATV_BIN"; fi   # a real install leaves the binary
      return 0
    }
    git() {
      printf 'git %s\n' "$*" >> "$LOG"
      local dir=.; [[ $1 == -C ]] && { dir=$2; shift 2; }   # honour -C: a relative patch path is opened from inside dir
      case " $* " in
        *" apply "*) [[ -z ${GIT_APPLY_FAIL:-} ]] && (cd "$dir" && [[ -f ${!#} ]]) ||  { echo "error: patch failed" >&2; return 1; } ;;
        *" fetch "*) [[ -z ${GIT_FETCH_FAIL:-} ]] || { echo "fatal: unable to access" >&2; return 128; } ;;
      esac
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
      [[ " $* " == *" try-restart voxtype"* && -n ${VOX_RESTART_FAILS:-} ]] && return 1
      [[ " $* " == *" is-active "*" voxtype"* ]] && { [[ -n ${VOX_ACTIVE:-} ]]; return; }
      [[ " $* " == *" is-active "* ]] && { [[ -n ${WAS_ACTIVE:-} ]]; return; }
      return 0
    }
    command() { if [[ $1 == -v && $2 == cargo ]]; then [[ -z ${NO_CARGO:-} ]]; return; fi; if [[ $1 == -v && $2 == git ]]; then [[ -z ${NO_GIT:-} ]]; return; fi; builtin command "$@"; }
    [[ -z ${ERREXIT:-} ]] || set -e         # ERREXIT=1: behave like the real script, where any failing command ends the run
    ( cmd_atvvoice ) > "$T/out.log" 2>&1   # die() exits: run it in its own subshell so the code is still recorded
    echo "exit=$?" >> "$LOG"
  )
  cat "$T/calls.log"
}
PATCH=$(dirname "$SRC")/patches/atvvoice-reset-decoder.patch
PSHA=$(sha256sum "$PATCH" 2>/dev/null | cut -d' ' -f1)
STAMP_LINE="rev=$REV patch=$PSHA"
# stamp [line]: the build is recorded as installed (stamp + binary present); no argument = the matching stamp
stamp() { mkdir -p "$T/state" "$T/bin"; printf '%s\n' "${1:-$STAMP_LINE}" > "$T/state/atvvoice.build"; : > "$T/bin/atvvoice"; chmod +x "$T/bin/atvvoice"; }
unstamp() { rm -rf "$T/state" "$T/bin"; }
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }

# 1. fresh host: builds, writes the unit, reloads, enables; no restart (was not active)
rm -rf "$T/unit"
out=$(BT_ATV=$ADDR run)
check "fresh: exits 0"                         "yes" "$(has "$out" "exit=0")"
check "fresh: git fetch of the pinned rev"    "yes" "$(grep -qE "^git .*fetch --depth 1 https://github.com/b0o/ATVVoice $REV\$" <<<"$out" && echo yes || echo no)"
check "fresh: git apply of the repo patch"     "yes" "$(grep -qE "^git .*apply .*/host/patches/atvvoice-reset-decoder.patch\$|^git .*apply .*/tests/\.\./host/patches/atvvoice-reset-decoder.patch\$" <<<"$out" && echo yes || echo no)"
check "fresh: cargo install --path --locked"   "yes" "$(grep -qE '^cargo install --locked --path [^ ]+ --force$' <<<"$out" && echo yes || echo no)"
check "fresh: no cargo --git install"          "no"  "$(has "$out" "--git")"
check "fresh: order fetch, apply, install"     "fetch apply install" "$(grep -oE 'fetch|apply|cargo install' <<<"$out" | sed 's/cargo //' | tr '\n' ' ' | sed 's/ $//')"
check "fresh: stamp holds rev and patch sha"   "$STAMP_LINE" "$(cat "$T/state/atvvoice.build" 2>/dev/null)"
check "fresh: says built"                      "yes" "$(has "$(cat "$T/out.log")" "built atvvoice ${REV:0:7} + reset-decoder patch")"
check "fresh: daemon-reload"                   "yes" "$(has "$out" "systemctl --user daemon-reload")"
check "fresh: enable --now"                    "yes" "$(has "$out" "systemctl --user enable --now atvvoice")"
check "fresh: no restart"                      "no"  "$(has "$out" "systemctl --user restart atvvoice")"
unit=$(cat "$T/unit/atvvoice.service" 2>/dev/null)
check "unit: ExecStart with address and name"  "yes" "$(has "$unit" "ExecStart=%h/.cargo/bin/atvvoice --device $ADDR --name xiaomi")"
check "unit: ExecStart never --mic-on-demand"  "no"  "$(has "$(grep '^ExecStart=' <<<"$unit")" "--mic-on-demand")"   # comments may mention it

# 2. re-run, nothing changed, service active: no build, no rewrite, no reload, no restart, still enable --now
out=$(BT_ATV=$ADDR STAMPED=1 WAS_ACTIVE=1 run)
check "rerun: no build"                        "no"  "$(has "$out" "--locked")"
check "rerun: no git, no cargo at all"         "no"  "$(grep -qE '^(git|cargo) ' <<<"$out" && echo yes || echo no)"
check "rerun: says up to date"                 "yes" "$(has "$(cat "$T/out.log")" "atvvoice ${REV:0:7} + patch: up to date")"
check "rerun: no daemon-reload"                "no"  "$(has "$out" "daemon-reload")"
check "rerun: no restart"                      "no"  "$(has "$out" "restart atvvoice")"
check "rerun: enable --now still issued"       "yes" "$(has "$out" "enable --now atvvoice")"

# 3. re-run after the service was stopped/disabled: enable --now brings it back, no restart
out=$(BT_ATV=$ADDR STAMPED=1 run)
check "stopped: enable --now"                  "yes" "$(has "$out" "enable --now atvvoice")"
check "stopped: no restart"                    "no"  "$(has "$out" "restart atvvoice")"

# 4. only the binary changed (older rev stamped), service active: rebuild + restart, no rewrite
out=$(BT_ATV=$ADDR STAMPED=1 STAMP_TEXT="rev=1111111111111111111111111111111111111111 patch=$PSHA" WAS_ACTIVE=1 run)
check "binary: rebuilt"                        "yes" "$(has "$out" "--locked --path")"
check "binary: no daemon-reload"               "no"  "$(has "$out" "daemon-reload")"
check "binary: restart"                        "yes" "$(has "$out" "systemctl --user restart atvvoice")"

# 4b. same rev, different patch hash: rebuild; a missing binary with a matching stamp: rebuild
out=$(BT_ATV=$ADDR STAMPED=1 STAMP_TEXT="rev=$REV patch=deadbeef" WAS_ACTIVE=1 run)
check "patch hash differs: rebuilt"            "yes" "$(has "$out" "--locked --path")"
check "patch hash differs: stamp refreshed"    "$STAMP_LINE" "$(cat "$T/state/atvvoice.build")"
check "patch hash differs: restart"            "yes" "$(has "$out" "systemctl --user restart atvvoice")"
out=$(BT_ATV=$ADDR STAMPED=1 NOBIN=1 run)
check "binary missing, stamp ok: rebuilt"      "yes" "$(has "$out" "--locked --path")"
out=$(BT_ATV=$ADDR run)
check "no stamp (unpatched host): rebuilt"     "yes" "$(has "$out" "--locked --path")"

# 5. unit changed (remote re-paired at a new address), service active: rewrite + reload + restart
out=$(BT_ATV=AA:AA:AA:AA:AA:AA STAMPED=1 WAS_ACTIVE=1 run)
check "unit changed: daemon-reload"            "yes" "$(has "$out" "daemon-reload")"
check "unit changed: restart"                  "yes" "$(has "$out" "systemctl --user restart atvvoice")"
check "unit changed: new address written"      "yes" "$(has "$(cat "$T/unit/atvvoice.service")" "--device AA:AA:AA:AA:AA:AA")"

# 6. no ATVV remote paired (Review focus 5): stops, names the problem, writes nothing
rm -rf "$T/unit"
out=$(BT_OTHER=11:22:33:44:55:66 STAMPED=1 run)
check "none: exits non-zero"                   "no"  "$(has "$out" "exit=0")"
check "none: no unit written"                  "no"  "$([[ -e $T/unit/atvvoice.service ]] && echo yes || echo no)"
check "none: message names the cause"          "yes" "$(has "$(cat "$T/out.log")" "no paired ATVV remote")"
check "none: no enable"                        "no"  "$(has "$out" "enable --now")"

# 7. bluetoothctl fails (Bluetooth off): same as none
out=$(BT_FAILS=1 STAMPED=1 run)
check "bt off: exits non-zero"                 "no"  "$(has "$out" "exit=0")"
check "bt off: message names the cause"        "yes" "$(has "$(cat "$T/out.log")" "no paired ATVV remote")"

# 8. two ATVV remotes: stops and names both
out=$(BT_ATV="$ADDR AA:AA:AA:AA:AA:AA" STAMPED=1 run)
check "two: exits non-zero"                    "no"  "$(has "$out" "exit=0")"
check "two: both named"                        "yes" "$(has "$(cat "$T/out.log")" "$ADDR AA:AA:AA:AA:AA:AA")"

# 9. cargo install fails (Review focus 4): stops with the error; existing unit and service untouched
mkdir -p "$T/unit"; printf 'EXISTING\n' > "$T/unit/atvvoice.service"
rm -rf "$T/alsa"
out=$(BT_ATV=$ADDR CARGO_FAILS=1 WAS_ACTIVE=1 run)
check "cargo fails: exits non-zero"            "no"  "$(has "$out" "exit=0")"
check "cargo fails: unit untouched"            "EXISTING" "$(cat "$T/unit/atvvoice.service")"
check "cargo fails: no systemctl mutation"     "no"  "$(grep -qE 'systemctl --user (daemon-reload|enable|restart)' <<<"$out" && echo yes || echo no)"
check "cargo fails: no stamp"                  "no"  "$([[ -e $T/state/atvvoice.build ]] && echo yes || echo no)"
check "cargo fails: ALSA file not created"     "no"  "$([[ -e $T/alsa/asoundrc ]] && echo yes || echo no)"

# 9b. git apply fails: dies with git's error; no cargo, no stamp, no unit, no ALSA, no systemctl
rm -rf "$T/unit" "$T/alsa"
out=$(BT_ATV=$ADDR GIT_APPLY_FAIL=1 WAS_ACTIVE=1 run)
check "apply fails: exits non-zero"            "no"  "$(has "$out" "exit=0")"
check "apply fails: git's error shown"         "yes" "$(has "$(cat "$T/out.log")" "patch failed")"
check "apply fails: no cargo"                  "no"  "$(has "$out" "cargo")"
check "apply fails: no stamp, unit or ALSA"    "no no no" "$([[ -e $T/state/atvvoice.build ]] && echo yes || echo no) $([[ -e $T/unit/atvvoice.service ]] && echo yes || echo no) $([[ -e $T/alsa/asoundrc ]] && echo yes || echo no)"
check "apply fails: no systemctl mutation"     "no"  "$(grep -qE 'systemctl --user (daemon-reload|enable|restart)' <<<"$out" && echo yes || echo no)"
out=$(BT_ATV=$ADDR GIT_FETCH_FAIL=1 run)
check "fetch fails: exits non-zero, no apply"  "no no" "$(has "$out" "exit=0") $(has "$out" "apply")"
check "fetch fails: no cargo, no stamp"        "no no" "$(has "$out" "cargo") $([[ -e $T/state/atvvoice.build ]] && echo yes || echo no)"

# 9c. git missing: dies with the pacman hint before any write or build
out=$(NO_GIT=1 BT_ATV=$ADDR run)
check "no git: exits non-zero"                 "no"  "$(has "$out" "exit=0")"
check "no git: pacman hint"                    "yes" "$(has "$(cat "$T/out.log")" "sudo pacman -S git")"
check "no git: nothing ran or written"         "no no no" "$(has "$out" "cargo") $(has "$out" "systemctl") $([[ -e $T/unit/atvvoice.service ]] && echo yes || echo no)"

# a relative patch path (script run as `bash host/omaremote-setup` from the repo root) must still reach git apply
REPO=$(cd "$(dirname "$SRC")/.." && pwd)
check "ATV_PATCH absolute for a relative \$0"  "yes" "$(cd "$REPO" && bash -c 'source "$1"; [[ $ATV_PATCH == /* && -f $ATV_PATCH ]] && echo yes || echo no' host/omaremote-setup "$LIB")"
rm -rf "$T/unit" "$T/alsa"
out=$(cd "$REPO" && BT_ATV=$ADDR OMAREMOTE_ATV_PATCH=host/patches/atvvoice-reset-decoder.patch run)
check "relative override: apply still succeeds" "yes" "$(has "$out" "exit=0")"
check "relative override: reaches cargo"        "yes" "$(has "$out" "cargo install --locked --path")"

# a failed cd keeps the path as given (it used to become /<basename>), so the die message names it
check "failed cd keeps the relative patch path" "nodir/x.patch" "$(cd "$T" && OMAREMOTE_ATV_PATCH=nodir/x.patch bash -c 'source "$1"; echo "$ATV_PATCH"' x "$LIB")"
out=$(cd "$T" && BT_ATV=$ADDR OMAREMOTE_ATV_PATCH=nodir/x.patch run)
check "missing patch: dies naming the given path" "yes" "$(has "$(cat "$T/out.log")" "patch is missing: nodir/x.patch")"
# invoked through a symlink elsewhere: SELF_DIR must follow it to the real host/patches
mkdir -p "$T/elsewhere"; ln -sf "$REPO/host/omaremote-setup" "$T/elsewhere/omaremote-setup"
check "symlinked \$0 still finds the patch"    "yes" "$(cd "$T" && bash -c 'source "$1"; [[ -f $ATV_PATCH ]] && echo yes || echo no' "$T/elsewhere/omaremote-setup" "$LIB")"

# 9d. the run dies after the install (Important 1): the stamp must not claim the old process is current
rm -rf "$T/unit" "$T/alsa"; : > "$T/alsa"      # $T/alsa is a file, so mkdir -p "$T/alsa" fails at the ALSA write
out=$(BT_ATV=$ADDR WAS_ACTIVE=1 ERREXIT=1 run)
check "interrupted: first run fails after build"  "yes" "$(has "$out" "cargo install")"
check "interrupted: first run exits non-zero"     "no"  "$(has "$out" "exit=0")"
check "interrupted: no stamp written"             "no"  "$([[ -e $T/state/atvvoice.build ]] && echo yes || echo no)"
rm -f "$T/alsa"
out=$(BT_ATV=$ADDR WAS_ACTIVE=1 KEEPSTATE=1 run)
check "re-run after interruption: rebuilds"       "yes" "$(has "$out" "cargo install")"
check "re-run after interruption: restarts atvvoice" "yes" "$(has "$out" "systemctl --user restart atvvoice")"
check "re-run after interruption: stamp written"  "$STAMP_LINE" "$(cat "$T/state/atvvoice.build" 2>/dev/null)"
out=$(BT_ATV=$ADDR WAS_ACTIVE=1 KEEPSTATE=1 run)
check "then settled: no rebuild, no restart"      "no no" "$(has "$out" "cargo install") $(has "$out" "restart atvvoice")"

# 9e. voxtype try-restart fails: a warning, not an abort; atvvoice is still restarted in the same run
rm -rf "$T/unit" "$T/alsa"
out=$(BT_ATV=$ADDR WAS_ACTIVE=1 VOX_ACTIVE=1 VOX_RESTART_FAILS=1 ERREXIT=1 run)
check "voxtype restart fails: exits 0"            "yes" "$(has "$out" "exit=0")"
check "voxtype restart fails: warns with the fix" "yes" "$(has "$(cat "$T/out.log")" "systemctl --user restart voxtype")"
check "voxtype restart fails: atvvoice restarted" "yes" "$(has "$out" "systemctl --user restart atvvoice")"
check "voxtype restart fails: stamp written"      "$STAMP_LINE" "$(cat "$T/state/atvvoice.build" 2>/dev/null)"

# static: the patch ships in the repo (git apply --check needs the network-fetched source, so it cannot run here)
check "patch file exists in the repo"          "yes" "$([[ -f $PATCH ]] && echo yes || echo no)"
check "patch carries the decoder reset"        "yes" "$(grep -qF 'on_audio_sync(&AudioSyncData::Full' "$PATCH" && echo yes || echo no)"

# 10. no cargo: prints the rustup command for the user and stops before anything else
out=$(NO_CARGO=1 BT_ATV=$ADDR run)
check "no cargo: exits non-zero"               "no"  "$(has "$out" "exit=0")"
check "no cargo: prints the rustup command"    "yes" "$(has "$(cat "$T/out.log")" "sudo pacman -S rustup && rustup default stable")"

# ---- ALSA PCM bridge: Voxtype 1.1.0 opens only ALSA PCM names, so the node needs a PCM of the same name ----
BEGIN_M='# BEGIN omaremote atvvoice (managed by omaremote-setup; do not edit)'
END_M='# END omaremote atvvoice'
BLOCK="$BEGIN_M
pcm.atvvoice-xiaomi {
  type pipewire
  capture_node \"atvvoice-xiaomi\"
  hint { show on description \"ATVVoice remote (atvvoice-xiaomi)\" }
}
$END_M"
rm -rf "$T/unit" "$T/alsa"
out=$(BT_ATV=$ADDR STAMPED=1 run)
check "alsa fresh: file is exactly the block"  "$BLOCK" "$(cat "$T/alsa/asoundrc" 2>/dev/null)"
check "alsa fresh: reports the write"          "yes" "$(has "$(cat "$T/out.log")" "wrote $T/alsa/asoundrc (ALSA PCM atvvoice-xiaomi)")"
check "alsa fresh: voxtype try-restart"        "no"  "$(has "$out" "try-restart voxtype")"   # inactive stub: see below for the active case

# rerun: unchanged, and not rewritten (mtime pinned in the past would move on any rewrite)
touch -d '2001-01-01 00:00:00' "$T/alsa/asoundrc"
out=$(BT_ATV=$ADDR STAMPED=1 VOX_ACTIVE=1 run)
check "alsa rerun: says unchanged"             "yes" "$(has "$(cat "$T/out.log")" "ALSA PCM atvvoice-xiaomi: unchanged")"
check "alsa rerun: mtime untouched"            "2001-01-01" "$(date -r "$T/alsa/asoundrc" +%F)"
check "alsa rerun: voxtype not restarted"      "no"  "$(has "$out" "voxtype")"

# existing unrelated content is preserved byte-for-byte; the block is appended
rm -rf "$T/alsa"; mkdir -p "$T/alsa"
printf '# my own config\npcm.foo {\n  type null\n}\n' > "$T/alsa/asoundrc"
before=$(cat "$T/alsa/asoundrc")
out=$(BT_ATV=$ADDR STAMPED=1 VOX_ACTIVE=1 run)
check "alsa append: original lines kept first" "$before" "$(head -n 4 "$T/alsa/asoundrc")"
check "alsa append: block present once"        "1"   "$(grep -c -F "$BEGIN_M" "$T/alsa/asoundrc")"
check "alsa append: block text exact"          "$BLOCK" "$(sed -n "/^# BEGIN omaremote/,/^# END omaremote/p" "$T/alsa/asoundrc")"
check "alsa changed + voxtype active: try-restart" "yes" "$(has "$out" "systemctl --user try-restart voxtype")"

# stale block replaced in place; text before and after it preserved
printf '# top\npcm.foo {}\n%s\npcm.stale {\n  type null\n}\n%s\n# bottom\npcm.bar {}\n' "$BEGIN_M" "$END_M" > "$T/alsa/asoundrc"
out=$(BT_ATV=$ADDR STAMPED=1 VOX_ACTIVE=1 run)
want=$(printf '# top\npcm.foo {}\n%s\n# bottom\npcm.bar {}' "$BLOCK")
check "alsa stale: block replaced, rest kept"  "$want" "$(cat "$T/alsa/asoundrc")"
check "alsa stale: voxtype try-restart"        "yes" "$(has "$out" "systemctl --user try-restart voxtype")"

# an unterminated marker is never guessed at: the file is left alone and the step stops
rm -rf "$T/unit"
printf '# top\n%s\npcm.mine {}\n' "$BEGIN_M" > "$T/alsa/asoundrc"; before=$(cat "$T/alsa/asoundrc")
out=$(BT_ATV=$ADDR STAMPED=1 run)
check "alsa broken markers: exits non-zero"    "no"  "$(has "$out" "exit=0")"
check "alsa broken markers: file untouched"    "$before" "$(cat "$T/alsa/asoundrc")"
check "alsa broken markers: no build, no unit" "no no" "$(has "$out" "--path") $([[ -e $T/unit/atvvoice.service ]] && echo yes || echo no)"
check "alsa broken markers: fails before systemctl" "no" "$(has "$out" "systemctl")"

# END before BEGIN (one of each) is misordered: refuse, never drop the tail
rm -rf "$T/unit"
printf '# top\n%s\npcm.mine {}\n%s\n# precious tail\n' "$END_M" "$BEGIN_M" > "$T/alsa/asoundrc"; before=$(cat "$T/alsa/asoundrc")
out=$(BT_ATV=$ADDR run)
check "alsa END before BEGIN: dies"            "no"  "$(has "$out" "exit=0")"
check "alsa END before BEGIN: file unchanged"  "$before" "$(cat "$T/alsa/asoundrc")"
check "alsa END before BEGIN: no cargo install" "no" "$(has "$out" "--path")"

# PipeWire ALSA plugin missing: dies with the pacman hint before cargo, the unit or the ALSA file
rm -rf "$T/unit" "$T/alsa"
out=$(BT_ATV=$ADDR PW_PROBE=$T/absent run)
check "no pw plugin: exits non-zero"           "no"  "$(has "$out" "exit=0")"
check "no pw plugin: pacman hint"              "yes" "$(has "$(cat "$T/out.log")" "sudo pacman -S --needed pipewire-alsa")"
check "no pw plugin: no cargo install"         "no"  "$(has "$out" "--path")"
check "no pw plugin: no unit, no alsa file"    "no no" "$([[ -e $T/unit/atvvoice.service ]] && echo yes || echo no) $([[ -e $T/alsa/asoundrc ]] && echo yes || echo no)"
check "no pw plugin: no systemctl at all"      "no"  "$(has "$out" "systemctl")"

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
