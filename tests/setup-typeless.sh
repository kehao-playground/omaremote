#!/usr/bin/env bash
# Plan 5 / Typeless spec §4.3, §9: host/omaremote-setup's `typeless` step against stubbed systemctl, id, journalctl,
# python3 and a fake omarchy-shell. Never touches the real systemd, Typeless, /dev/uinput or ~/.config/omaremote.
# Usage: bash tests/setup-typeless.sh [path to omaremote-setup]
set -uo pipefail
SRC=${1:-$(dirname "$0")/../host/omaremote-setup}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ $2 == "$3" ]]; then printf '  ok    %-62s\n' "$1"; else printf '  FAIL  %-62s expected [%s] got [%s]\n' "$1" "$2" "$3"; fail=1; fi; }
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }

LIB=$T/lib.sh
sed '/^main "\$@"$/d' "$SRC" > "$LIB"
mkdir -p "$T/bin"

# The fake omarchy-shell is a real executable: setup runs it under `timeout`, which cannot run a shell function.
cat > "$T/bin/fakeshell" <<'FAKE'
#!/usr/bin/env bash
# fakeshell omaremote <method> [arg]; state in $FAKE:
#   no-service (exit 1)  hang (never answers)  stored (true|false)  hotkey  save-after (polls before final, default 1)
#   save-final (saved|failed)  disk-hotkey (what config.json holds once saved; default: the requested chord)
#   reply.<chord> (canned typelessHotkey reply)  writeseq (default 7; "null" for an already-saved value)
d=$FAKE; printf '%s\n' "${*:2}" >> "$d/ipc.log"
[[ -e $d/no-service ]] && { echo "no running instance" >&2; exit 1; }
[[ -e $d/hang ]] && exec sleep 30
case $2 in
  status)
    n=$(( $(cat "$d/polls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$d/polls"
    st=pending; (( n > $(cat "$d/save-after" 2>/dev/null || echo 1) )) && st=$(cat "$d/save-final" 2>/dev/null || echo saved)
    if [[ $st == saved && -e $d/requested ]]; then
      h=$(cat "$d/disk-hotkey" 2>/dev/null || cat "$d/requested")
      mkdir -p "$XDG_CONFIG_HOME/omaremote"; jq -n --arg h "$h" '{voice:{typeless:{hotkey:$h}}}' > "$XDG_CONFIG_HOME/omaremote/config.json"
    fi
    jq -nc --arg st "$st" --argjson stored "$(cat "$d/stored" 2>/dev/null || echo false)" --arg hk "$(cat "$d/hotkey" 2>/dev/null || echo RightAlt)" \
      '{typeless:{hotkey:$hk, hotkeyStored:$stored}, configWrites:{saves:{"7":$st}, errors:(if $st == "failed" then {"7":"EACCES"} else {} end)}}' ;;
  typelessHotkey)
    if [[ -e $d/reply.$3 ]]; then cat "$d/reply.$3"
    else echo "$3" > "$d/requested"; jq -nc --arg h "$3" --argjson s "$(cat "$d/writeseq" 2>/dev/null || echo 7)" '{ok:true, hotkey:$h, writeSeq:$s}'; fi ;;
esac
FAKE
chmod +x "$T/bin/fakeshell"

# Every scenario gets its own fresh directory B: nothing installed, a writable fake uinput, a Typeless settings fixture.
fresh() {
  B=$(mktemp -d "$T/case.XXXXXX"); mkdir -p "$B/fake" "$B/sys"
  : > "$B/uinput"; chmod 0666 "$B/uinput"
  printf '%s\n' '{"featureShortcutBindings":{"dictationMode":["RightAlt+RightShift"]},"selectedMicrophoneDevice":{"deviceId":"default","label":"Auto-detect"}}' > "$B/typeless.json"
}
run() {   # run [typeless args...]: prints the call log; its last line is exit=N
  (
    export OMAREMOTE_KEYTAP_DIR=$B/lib OMAREMOTE_KEYTAP_UNIT=$B/unit/omaremote-keytap.service
    export OMAREMOTE_TYPELESS_SETTINGS=$B/typeless.json OMAREMOTE_UINPUT=$B/uinput OMAREMOTE_INPUT_SYSFS=$B/sys
    export XDG_CONFIG_HOME=$B/config OMAREMOTE_SHELL=$T/bin/fakeshell FAKE=$B/fake
    export OMAREMOTE_IPC_TIMEOUT=${IPC_TIMEOUT:-3} OMAREMOTE_SAVE_WAIT_MS=${SAVE_WAIT_MS:-2000}
    # shellcheck disable=SC1090
    source "$LIB"
    set +e
    LOG=$B/calls.log; : > "$LOG"
    systemctl() {
      printf 'systemctl %s\n' "$*" >> "$LOG"
      if [[ " $* " == *" enable --now omaremote-keytap "* && -z ${NO_DEVICE:-} ]]; then
        mkdir -p "$B/sys/event9/device"; echo "omaremote keytap" > "$B/sys/event9/device/name"
      fi
      return 0
    }
    id() { if [[ ${1:-} == -nG ]]; then echo "user wheel ${GROUPS_EXTRA-input}"; else builtin command id "$@"; fi; }
    journalctl() { echo "keytap: Traceback (fake journal)"; }
    python3() { printf 'python3 %s\n' "$*" >> "$LOG"; [[ -z ${PING_FAILS:-} ]]; }
    command() { if [[ ${1:-} == -v && ${2:-} == python3 ]]; then [[ -z ${NO_PYTHON:-} ]]; return; fi; builtin command "$@"; }
    ( cmd_typeless "$@" ) > "$B/out.log" 2>&1
    echo "exit=$?" >> "$LOG"
  )
  cat "$B/calls.log"
}
out() { cat "$B/out.log"; }
ipclog() { cat "$B/fake/ipc.log" 2>/dev/null; }

# 1. missing input group: nothing installed, the usermod command printed
fresh; o=$(GROUPS_EXTRA="" run)
check "no input group: exit 1"                       "yes" "$(has "$o" "exit=1")"
check "no input group: prints usermod"               "yes" "$(has "$(out)" "sudo usermod -aG input \$USER")"
check "no input group: no systemctl call"            "no"  "$(has "$o" "systemctl")"
check "no input group: nothing installed"            "no"  "$([[ -e $B/lib/omaremote-keytap ]] && echo yes || echo no)"

# 2. /dev/uinput not writable, and 3. no python3
fresh; chmod 0444 "$B/uinput"; o=$(run)
check "uinput not writable: exit 1"                  "yes" "$(has "$o" "exit=1")"
fresh; o=$(NO_PYTHON=1 run)
check "no python3: exit 1 with the pacman hint"      "yes" "$(has "$(out)" "sudo pacman -S --needed python")"

# 4. first run (hotkeyStored false) adopts Typeless's value and confirms it on disk
fresh; o=$(run)
check "first run: exit 0"                            "yes" "$(has "$o" "exit=0")"
check "first run: script installed byte-identical"   "yes" "$(cmp -s "$(dirname "$SRC")/omaremote-keytap" "$B/lib/omaremote-keytap" && echo yes || echo no)"
check "first run: installed executable"              "yes" "$([[ -x $B/lib/omaremote-keytap ]] && echo yes || echo no)"
check "first run: unit ExecStart"                    "yes" "$(has "$(cat "$B/unit/omaremote-keytap.service")" "ExecStart=/usr/bin/python3 -I $B/lib/omaremote-keytap serve")"
check "first run: unit WantedBy graphical-session"   "yes" "$(has "$(cat "$B/unit/omaremote-keytap.service")" "WantedBy=graphical-session.target")"
check "first run: enable --now"                      "yes" "$(has "$o" "systemctl --user enable --now omaremote-keytap")"
check "first run: ping"                              "yes" "$(has "$o" "python3 -I $B/lib/omaremote-keytap ping")"
check "first run: Typeless's value sent"             "yes" "$(has "$(ipclog)" "typelessHotkey RightAlt+RightShift")"
check "first run: says saved"                        "yes" "$(has "$(out)" "hotkey: RightAlt+RightShift (saved)")"
check "first run: never switches the engine"         "no"  "$(has "$(ipclog)" "engine")"

# 5. a re-run in the same directory with the value stored keeps it, writes nothing and restarts nothing
echo true > "$B/fake/stored"; : > "$B/fake/ipc.log"; o=$(run)
check "re-run: exit 0"                               "yes" "$(has "$o" "exit=0")"
check "re-run: no typelessHotkey call"               "no"  "$(has "$(ipclog)" "typelessHotkey")"
check "re-run: says keeping"                         "yes" "$(has "$(out)" "keeping the stored hotkey")"
check "re-run: no restart (nothing changed)"         "no"  "$(has "$o" "restart omaremote-keytap")"
check "re-run: no install/write lines"               "no"  "$(grep -qE '^(installed|wrote) ' "$B/out.log" && echo yes || echo no)"

# 6. an invalid --hotkey is rejected after a working keytap, nothing written
fresh; echo '{"ok":false,"reason":"invalid chord: unknown name: Alt"}' > "$B/fake/reply.Alt+Q"; o=$(run --hotkey Alt+Q)
check "invalid --hotkey: exit 1"                     "yes" "$(has "$o" "exit=1")"
check "invalid --hotkey: reason shown"               "yes" "$(has "$(out)" "invalid chord: unknown name: Alt")"
check "invalid --hotkey: keytap still installed"     "yes" "$(has "$o" "enable --now omaremote-keytap")"
check "invalid --hotkey: config.json untouched"      "no"  "$([[ -e $B/config/omaremote/config.json ]] && echo yes || echo no)"

# 7. --hotkey-from-typeless with an unusable Typeless value falls back to RightAlt, and says so
fresh; echo true > "$B/fake/stored"
printf '%s\n' '{"featureShortcutBindings":{"dictationMode":["Fn+Q"]}}' > "$B/typeless.json"
echo '{"ok":false,"reason":"invalid chord: unknown name: Fn"}' > "$B/fake/reply.Fn+Q"; o=$(run --hotkey-from-typeless)
check "unusable Typeless value: exit 0"              "yes" "$(has "$o" "exit=0")"
check "unusable Typeless value: falls back loudly"   "yes" "$(has "$(out)" "is not usable here")"
check "unusable Typeless value: RightAlt sent"       "yes" "$(has "$(ipclog)" "typelessHotkey RightAlt")"

# 8. review focus 5: settings without dictationMode, or not an array, or not JSON → RightAlt, said
for body in '{"featureShortcutBindings":{}}' '{"featureShortcutBindings":{"dictationMode":"RightAlt"}}' 'not json'; do
  fresh; printf '%s\n' "$body" > "$B/typeless.json"; o=$(run)
  check "settings ${body:0:28}: RightAlt sent"          "yes" "$(has "$(ipclog)" "typelessHotkey RightAlt")"
  check "settings ${body:0:28}: fallback said"          "yes" "$(has "$(out)" "could not be read")"
done

# 9. no service
fresh; : > "$B/fake/no-service"; o=$(run)
check "no service: exit 1"                           "yes" "$(has "$o" "exit=1")"
check "no service: the message"                      "yes" "$(has "$(out)" "the omaremote service is not running")"

# 10. the write failed
fresh; echo failed > "$B/fake/save-final"; o=$(run)
check "save failed: exit 1 with the reason"          "yes" "$(has "$(out)" "saving config.json failed: EACCES")"

# 11. the write never resolves within the budget
fresh; echo 999 > "$B/fake/save-after"; o=$(SAVE_WAIT_MS=300 run)
check "never confirmed: exit 1"                      "yes" "$(has "$(out)" "was not confirmed within")"

# 12. the value on disk was changed again after the write
fresh; echo RightCtrl+Space > "$B/fake/disk-hotkey"; o=$(run)
check "changed again: exit 1"                        "yes" "$(has "$(out)" "the hotkey was changed again before setup could confirm it")"

# 13. an already-saved equal value (writeSeq null) skips the wait but still checks the disk
fresh; echo true > "$B/fake/stored"; echo null > "$B/fake/writeseq"
mkdir -p "$B/config/omaremote"; echo '{"voice":{"typeless":{"hotkey":"RightAlt"}}}' > "$B/config/omaremote/config.json"
o=$(run --hotkey RightAlt)
check "writeSeq null: exit 0"                        "yes" "$(has "$o" "exit=0")"
check "writeSeq null: one status call only"          "1"   "$(grep -c '^status' "$B/fake/ipc.log")"

# 14. a stuck IPC is cut off by the timeout
fresh; : > "$B/fake/hang"; s0=$SECONDS; o=$(IPC_TIMEOUT=1 run)
check "stuck IPC: exit 1"                            "yes" "$(has "$o" "exit=1")"
check "stuck IPC: bounded by the timeout"            "yes" "$( (( SECONDS - s0 <= 3 )) && echo yes || echo no)"

# 15. the daemon never comes up: journal shown, exit 1, no hotkey step
fresh; o=$(NO_DEVICE=1 run)
check "keytap down: exit 1"                          "yes" "$(has "$o" "exit=1")"
check "keytap down: journal shown"                   "yes" "$(has "$(out)" "fake journal")"
check "keytap down: no hotkey IPC"                   "no"  "$(has "$(ipclog)" "typelessHotkey")"

# 16. exclusive flags
fresh; o=$(run --hotkey RightAlt --hotkey-from-typeless)
check "exclusive flags: refused"                     "yes" "$(has "$(out)" "are exclusive")"

(( fail == 0 )) && echo "setup-typeless: all ok" || { echo "setup-typeless: FAILED"; exit 1; }
