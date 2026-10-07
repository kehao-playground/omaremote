#!/usr/bin/env bash
# Measure, per bind configuration, whether the plugin sees both key edges as a function of press
# duration. Settles the question main spec §3 currently answers wrongly.
#
# Runs as the NORMAL USER and calls sudo only for the injector. Running the whole script as root
# would break it two ways: omarchy-shell IPC would not reach the user's Quickshell session, and
# $HOME would be root's, so the generated Lua would land in the wrong place.
set -euo pipefail

LUA=$HOME/.config/hypr/omaremote.lua
HYPRLAND_LUA=$HOME/.config/hypr/hyprland.lua
HYPRLAND_BAK=$HYPRLAND_LUA.omaremote-matrix.bak
REQUIRE_ADDED=0
LUA_EXISTED=0
LUA_BAK=""
# The sweep replaces two pieces of host state and must restore BOTH exactly as found, because
# either one left half-applied breaks the user's compositor config:
#   * $LUA -- an earlier draft called this "a temporary bind module this script owns outright".
#     That was wrong twice over. If Task 7 has already installed the real omaremote.lua, owning it
#     outright means overwriting the user's working binds and then deleting them on exit.
#   * the require line in hyprland.lua -- only removed if THIS run added it, so an identical line
#     the user added themselves is never taken away. But that alone is not enough: if the require
#     was already present and $LUA was not, deleting $LUA on exit leaves a dangling require and
#     `hyprctl configerrors` reports "module 'hypr.omaremote' not found" on every later reload.
#     Observed 2026-10-07 after the second sweep.
INJECT=$(dirname "$0")/inject-key.py
SHELL_CMD=${OMAREMOTE_SHELL:-omarchy-shell}
LEASE_MS=120000
DURATIONS=(120 600 3000)
# key:neutral -- up is repeat:true (phase `repeating`), back is a long non-repeat key (phase `held`).
# power/f24 is excluded on purpose: its tap action blanks the screen.
PROBES=(up:f13 back:f18)

# Rows are TAB-separated, never space-separated. The `duplicated` field contains spaces
# ("down x2, up x2"), so a space-separated row read with a bare `read -r d u lost dup held`
# shifts the tail of that field into `held` -- and `held` is a qualification criterion, so a
# two-bind run, where a duplicated release is EXPECTED, would disqualify itself and the sweep
# would report "neither configuration qualifies" on a field-splitting bug. See
# tests/matrix-helpers.sh.
TAB=$'\t'

classify_row() {   # classify_row <down> <up> <held> -> down TAB up TAB lost TAB duplicated TAB held
  local d=$1 u=$2 held=$3 lost="" dup=""
  (( d < 1 )) && lost="down"
  (( u < 1 )) && lost="${lost:+$lost+}up"
  (( d > 1 )) && dup="down x$d"
  (( u > 1 )) && dup="${dup:+$dup, }up x$u"
  printf '%s\t%s\t%s\t%s\t%s\n' "$d" "$u" "${lost:--}" "${dup:--}" "${held:--}"
}

# A row qualifies when both edges arrived at least once and nothing stayed held. Duplicates are
# reported and TOLERATED: KeyEngine tolerating a duplicate release is verified, a loss it cannot.
row_qualifies() {   # row_qualifies <down> <up> <held>
  local d=$1 u=$2 held=$3
  (( d >= 1 )) || return 1
  (( u >= 1 )) || return 1
  [[ -z $held || $held == "-" ]] || return 1
  return 0
}

# Only run the live sweep when executed, so the helpers above can be sourced by their test.
[[ ${BASH_SOURCE[0]} == "${0}" ]] || return 0

[[ $EUID -eq 0 ]] && { echo "bind-matrix: run as your normal user, not root (it sudos only the injector)" >&2; exit 1; }
command -v jq >/dev/null || { echo "bind-matrix: jq required" >&2; exit 1; }
sudo -n true 2>/dev/null || { echo "bind-matrix: cache sudo credentials first with 'sudo -v', then re-run" >&2; exit 1; }
hyprctl version >/dev/null 2>&1 || {
  echo "bind-matrix: hyprctl cannot reach Hyprland (HYPRLAND_INSTANCE_SIGNATURE unset?)." >&2
  echo "  Run this from a terminal inside your Hyprland session." >&2
  exit 1
}

ipc() { $SHELL_CMD omaremote "$@"; }

# The running Quickshell must BE the code under test. The sweep consumes selftestArmFor and the
# per-call lease length from Plan 3 Task 3; a session still running an older build answers
# "Function not found." to that verb, and the arm loop would then spin 20 times and report
# "could not arm a lease" -- indistinguishable from a gate or lease problem. Observed 2026-10-06:
# the installed plugin was the Plan 2 build. Check the contract instead of inferring it.
require_live_build() {
  local probe id have_stuck
  probe=$(ipc selftestArmFor 1000 2>&1 || true)
  if [[ $probe != "{"* ]]; then
    printf 'bind-matrix: the running shell does not expose selftestArmFor.\n' >&2
    printf '  it answered: %s\n' "${probe%%$'\n'*}" >&2
    printf '  The live session predates Plan 3 Task 3. Install this build and restart the shell:\n' >&2
    printf '      make dev-restart\n' >&2
    exit 1
  fi
  # Release the probe lease if it armed, so the sweep starts from a clean gate.
  id=$(jq -r '.id // empty' <<< "$probe" 2>/dev/null || true)
  [[ -n $id ]] && ipc selftestDisarm "$id" >/dev/null 2>&1
  have_stuck=$(ipc status 2>/dev/null | jq -r '.timing | has("stuckMs")' 2>/dev/null || echo false)
  [[ $have_stuck == true ]] || {
    printf 'bind-matrix: the running shell has no timing.stuckMs, so it predates Plan 3 Task 1.\n' >&2
    printf '  Install this build and restart the shell:  make dev-restart\n' >&2
    exit 1
  }
}
require_live_build

# Snapshot $LUA once, before the first write, so every later restore has something to restore to.
snapshot_lua() {
  if [[ -f $LUA ]]; then
    LUA_EXISTED=1
    LUA_BAK=$LUA.omaremote-matrix.bak
    cp -a "$LUA" "$LUA_BAK"
    echo "note: an existing $LUA was found and backed up to $LUA_BAK; it is restored on exit"
  fi
}

write_lua() {   # write_lua <one|two>
  local mode=$1 k neutral sym p
  {
    printf -- '-- TEMPORARY: generated by tests/bind-matrix.sh (%s-bind sweep). Removed on exit.\n' "$mode"
    for p in "${PROBES[@]}"; do
      IFS=: read -r k neutral <<< "$p"
      sym=${neutral^^}
      printf 'hl.bind("%s", hl.dsp.global("omaremote:%s"), { description = "omaremote:%s" })\n' "$sym" "$k" "$k"
      if [[ $mode == two ]]; then
        printf 'hl.bind("%s", hl.dsp.global("omaremote:%s"), { description = "omaremote:%s", release = true })\n' "$sym" "$k" "$k"
      fi
    done
  } > "$LUA"
  # The require line is the user's file, so it is restored from a backup rather than sed-deleted:
  # a blind `sed -i '/require("hypr.omaremote")/d'` on cleanup would also remove an identical line
  # the user had added themselves. Only a line this script appended is ever taken away.
  if ! grep -q 'require("hypr.omaremote")' "$HYPRLAND_LUA"; then
    cp -a "$HYPRLAND_LUA" "$HYPRLAND_BAK"
    printf '%s\n' 'require("hypr.omaremote")' >> "$HYPRLAND_LUA"
    REQUIRE_ADDED=1
  fi
  hyprctl reload >/dev/null
  # MANDATORY (Task 4 finding): hyprctl reload answers "ok" even when the Lua raised, keeping the
  # PREVIOUS config loaded, and nothing reaches the Hyprland log. Only configerrors reports it.
  # Without this a generated-config typo reads as "this configuration loses the release edge" --
  # a measurement error wearing the costume of the measurement.
  local cfgerr; cfgerr=$(hyprctl configerrors 2>&1 | grep -v '^$' || true)
  [[ -z $cfgerr ]] || { echo "  !! hyprctl configerrors after loading the $mode-bind config:"; echo "$cfgerr" | sed 's/^/     /'; return 1; }
  # NOT $(( ... mode == two ... )): inside arithmetic, bash expands `mode` and `two` as variables,
  # so a string comparison there is silently always true.
  local per=1; [[ $mode == two ]] && per=2
  local want=$(( ${#PROBES[@]} * per ))
  local got; got=$(hyprctl binds -j | jq '[.[].description | select(startswith("omaremote:"))] | length')
  [[ $got == "$want" ]] || { echo "  !! expected $want omaremote binds loaded, found $got"; return 1; }
}

arm() {   # echoes the lease id, or fails after naming the blocker
  local tries=0 r detail=""
  while (( tries < 20 )); do
    r=$(ipc selftestArmFor "$LEASE_MS")
    if [[ $(jq -r '.ok' <<< "$r") == true ]]; then jq -r '.id' <<< "$r"; return 0; fi
    detail=$(jq -r '.detail // "?"' <<< "$r")
    case $detail in
      heldKeys:*) echo "  !! blocked by held keys ($detail) -- not a transient condition" >&2; return 1 ;;
      # backendStale is expected and self-clearing: nothing refreshes the 500 ms freshness window on
      # its own, and the refused arm itself triggers a poll, so the next attempt finds it fresh.
      *) sleep 0.3 ;;
    esac
    tries=$((tries + 1))
  done
  echo "  !! could not arm a lease: $detail" >&2; return 1
}

trial() {   # trial <key> <neutral> <hold_ms> -> a TAB-separated row from classify_row
  local key=$1 neutral=$2 ms=$3 id attempt=0
  while (( attempt < 3 )); do
    id=$(arm) || return 1
    sudo "$INJECT" "$neutral" --hold-ms "$ms" >/dev/null
    sleep 0.4
    local rep; rep=$(ipc selftestReport "$id")
    local unexpected
    unexpected=$(jq -r --arg k "$key" '[.counts.shortcut | keys[] | select(. != $k)] | join(",")' <<< "$rep")
    if [[ -n $unexpected ]]; then
      # Review focus 3: raw counts include real remote input, so a stray press would be recorded as
      # this configuration's verdict. Discard the trial instead of publishing a false cell.
      echo "  .. discarding trial for $key/${ms}ms: unexpected keys seen ($unexpected); do not touch the remote" >&2
      attempt=$((attempt + 1)); sleep 1; continue
    fi
    local d u held
    d=$(jq -r --arg k "$key" '.counts.shortcut[$k].down // 0' <<< "$rep")
    u=$(jq -r --arg k "$key" '.counts.shortcut[$k].up // 0' <<< "$rep")
    # held comes from the report, which derives it from the lease's own down-without-up tracking.
    # Reading `ipc status .heldKeys` here would be worthless: during a lease onKeyEdge hands edges to
    # selftest.record() and returns (Service.qml:213-219), so KeyEngine never sees them and has no
    # held key -- and selftestReport ends the lease, whose onSelftestEnded() then clears
    # root.heldKeys outright (Service.qml:456). Likewise .lastStuckKey can never be produced by an
    # injected edge in this window, so it is not an observation of this trial and is not collected.
    held=$(jq -r '.held | join(",")' <<< "$rep")
    classify_row "$d" "$u" "$held"
    return 0
  done
  echo "  !! $key/${ms}ms never produced a clean trial" >&2; return 1
}

sweep() {   # sweep <one|two> -> prints rows, sets QUALIFIES / LOST
  local mode=$1 k neutral ms row d u lost dup held p
  QUALIFIES=1; LOST=0
  write_lua "$mode" || { QUALIFIES=0; LOST=99; return 0; }
  for p in "${PROBES[@]}"; do
    IFS=: read -r k neutral <<< "$p"
    for ms in "${DURATIONS[@]}"; do
      row=$(trial "$k" "$neutral" "$ms") || { QUALIFIES=0; LOST=$((LOST + 1)); continue; }
      IFS=$TAB read -r d u lost dup held <<< "$row"
      printf '| %s | %s | %sms | %s | %s | %s | %s | %s |\n' "$mode" "$k" "$ms" "$d" "$u" "$lost" "$dup" "$held"
      row_qualifies "$d" "$u" "$held" || { QUALIFIES=0; LOST=$((LOST + 1)); }
      ipc reset >/dev/null
    done
  done
}

cleanup() {
  # Restore $LUA to exactly what was there, which may be nothing or may be Task 7's real config.
  if (( LUA_EXISTED )) && [[ -n $LUA_BAK && -f $LUA_BAK ]]; then
    cp -a "$LUA_BAK" "$LUA" && rm -f "$LUA_BAK"
  else
    rm -f "$LUA"
  fi
  # Only ever take away a require line this run put there.
  if (( REQUIRE_ADDED )) && [[ -f $HYPRLAND_BAK ]]; then
    cp -a "$HYPRLAND_BAK" "$HYPRLAND_LUA" && rm -f "$HYPRLAND_BAK"
  fi
  hyprctl reload >/dev/null 2>&1 || true
  # A require with no module is a broken config, and it is silent until the next reload. Say so
  # rather than leaving the user to find it.
  if [[ ! -f $LUA ]] && grep -q 'require("hypr.omaremote")' "$HYPRLAND_LUA" 2>/dev/null; then
    echo "WARNING: $HYPRLAND_LUA still requires hypr.omaremote but $LUA does not exist." >&2
    echo "  This run did not add that line, so it has been left alone -- but every 'hyprctl reload'" >&2
    echo "  will now report \"module 'hypr.omaremote' not found\" until the module exists or the" >&2
    echo "  line is removed. 'omaremote-setup binds' creates the module." >&2
  fi
}
trap cleanup EXIT
snapshot_lua

echo
echo "| config | key | duration | down | up | lost | duplicated | held |"
echo "|---|---|---|---|---|---|---|---|"
sweep one; ONE_Q=$QUALIFIES; ONE_LOST=$LOST
sweep two; TWO_Q=$QUALIFIES; TWO_LOST=$LOST
echo

if (( ONE_Q )); then
  echo "VERDICT: one bind qualifies -- use a single hl.bind per key (fewer lines, no duplicate releases)."
  exit 0
elif (( TWO_Q )); then
  echo "VERDICT: two binds qualify (press + { release = true }); one bind does not."
  echo "KeyEngine tolerating a duplicate release is verified; a loss it cannot."
  exit 0
fi
cat <<EOF
VERDICT: NEITHER CONFIGURATION QUALIFIES.
  one-bind failing cells: $ONE_LOST    two-bind failing cells: $TWO_LOST
The least-bad configuration is a DIAGNOSTIC, NOT A PASS. Do not generate or install
~/.config/hypr/omaremote.lua from it: Task 7 stays blocked and setup must report failure.
This is a finding about the Hyprland Lua bind layer; record the failing cells above.
EOF
exit 1
