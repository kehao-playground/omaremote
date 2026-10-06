#!/usr/bin/env bash
# Unit-test host/omaremote-setup's helpers against stubbed system state, so the parts
# that only fire in situations that are awkward to stage on a live host are still pinned.
#
# stray_keyd(): keyd binds one socket at /var/run/keyd.socket, so a leftover foreground
# validation run makes `systemctl start keyd` fail with "another instance already running?"
# and leaves the unit `enabled` + `failed` -- which reads like a broken config rather than
# a stray process. Observed for real on 2026-10-06 during Task 5.
#
# Usage: bash tests/setup-helpers.sh [path to omaremote-setup]
set -uo pipefail

SRC=${1:-$(dirname "$0")/../host/omaremote-setup}
eval "$(sed -n '/^stray_keyd()/,/^}/p' "$SRC")"

fail=0
check() {  # check <label> <expected> <actual>
  if [[ $2 == "$3" ]]; then
    printf '  ok    %-44s -> [%s]\n' "$1" "$3"
  else
    printf '  FAIL  %-44s expected [%s] got [%s]\n' "$1" "$2" "$3"
    fail=1
  fi
}

# Case 1: a foreground keyd exists and the service owns nothing.
pgrep() { printf '%s\n' 1832163; }
systemctl() { printf '0\n'; }
check "foreground run, service dead" "1832163" "$(stray_keyd)"

# Case 2: the only keyd is the one the service owns -- not a stray.
pgrep() { printf '%s\n' 4242; }
systemctl() { printf '4242\n'; }
check "service's own daemon is not a stray" "" "$(stray_keyd)"

# Case 3: the service's daemon plus a stray alongside it.
pgrep() { printf '%s\n%s\n' 4242 999; }
systemctl() { printf '4242\n'; }
check "stray alongside the service" "999" "$(stray_keyd)"

# Case 4: nothing running at all.
pgrep() { return 1; }
systemctl() { printf '0\n'; }
check "no keyd at all" "" "$(stray_keyd)"

# Case 5: two strays, service dead -- both must be named.
pgrep() { printf '%s\n%s\n' 111 222; }
systemctl() { printf '0\n'; }
check "two strays are both reported" "111 222" "$(stray_keyd)"

# ---- temp-file cleanup -------------------------------------------------------------
# The original code used `trap 'rm -f "$tmp"' RETURN` inside cmd_keyd. A RETURN trap is not
# scoped to the function that set it: it stays installed and fires again when the NEXT
# function returns, where `tmp` is a dead local -- so under `set -u` the script exited
# non-zero after a completely successful run (observed on 2026-10-06), and the temp file
# leaked anyway because RETURN never fires on `die`. These pin the replacement.
unset -f pgrep systemctl

# ---- the per-run work dir ----------------------------------------------------------
# Pins the EXIT-trap cleanup. Two earlier shapes of this code failed silently: a RETURN
# trap that fired after its local was gone (exiting non-zero on success under `set -u`),
# and a registry helper whose `t=$(mktmp)` callers appended inside a subshell, so the
# parent cleaned up nothing. Both are caught by the two cases below.
helpers=$(
  sed -n '/^WORKDIR=/p' "$SRC"
  sed -n '/^cleanup_tmp()/,/^}/p' "$SRC"
  sed -n '/^trap cleanup_tmp EXIT$/p' "$SRC"
)
[[ $helpers == *"WORKDIR="* && $helpers == *"cleanup_tmp()"* ]] \
  || { echo "  FAIL  could not extract WORKDIR/cleanup_tmp from $SRC"; fail=1; }
# The trap line is taken from the script, never supplied by this harness: supplying it would
# make its deletion from the script undetectable, which is how the first draft of this test
# passed against a mutant with no EXIT trap at all.
check "the script installs the EXIT trap itself" "yes" \
  "$([[ $helpers == *"trap cleanup_tmp EXIT"* ]] && echo yes || echo no)"

wd=$(bash -euo pipefail -c "$helpers
printf x > \"\$WORKDIR/probe\"
mkdir -p \"\$WORKDIR/sub\"
[[ -f \$WORKDIR/probe && -d \$WORKDIR/sub ]] || exit 9
printf '%s' \"\$WORKDIR\"
" 2>&1) || { printf '  FAIL  %-44s %s\n' "work dir is usable during the run" "$wd"; fail=1; wd=""; }

if [[ -n $wd ]]; then
  check "work dir was created and written to" "yes"  "$([[ $wd == /tmp/omaremote-setup.* ]] && echo yes || echo no)"
  check "work dir is removed on exit"         "gone" "$([[ -e $wd ]] && echo present || echo gone)"
fi

# The regression itself: under `set -u` a successful run must exit 0. The RETURN-trap form
# exited non-zero here even though everything it was asked to do had succeeded.
if bash -euo pipefail -c "$helpers
true" 2>/dev/null; then
  check "a successful run exits 0 under set -u" "0" "0"
else
  check "a successful run exits 0 under set -u" "0" "nonzero"
fi

printf '\n%s\n' "$([[ $fail == 0 ]] && echo 'RESULT: PASS' || echo 'RESULT: FAIL')"
exit $fail
