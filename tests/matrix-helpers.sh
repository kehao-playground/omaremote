#!/usr/bin/env bash
# Unit-test the pure row logic of tests/bind-matrix.sh. The sweep itself needs a live Hyprland
# session, root for the injector and a quiet remote, so these pin the part that can be wrong
# without any of that -- and the part that was wrong.
#
# The row format matters more than it looks. The `duplicated` field contains spaces
# ("down x2, up x2"). With space-separated rows and a bare `read -r d u lost dup held`, the tail
# of that field lands in `held`, and `held` is a qualification criterion -- so a two-bind run,
# where a duplicated release is EXPECTED, disqualified itself and the sweep reported "neither
# configuration qualifies" on a field-splitting bug, blocking Task 7 and blaming Hyprland.
# Observed 2026-10-06 before the sweep was ever run.
#
# Usage: bash tests/matrix-helpers.sh [path to bind-matrix.sh]
set -uo pipefail

SRC=${1:-$(dirname "$0")/bind-matrix.sh}
# bind-matrix.sh returns early when sourced, so only the helpers come in.
# shellcheck disable=SC1090
source "$SRC"

fail=0
check() {  # check <label> <expected> <actual>
  if [[ $2 == "$3" ]]; then
    printf '  ok    %-46s -> [%s]\n' "$1" "$3"
  else
    printf '  FAIL  %-46s expected [%s] got [%s]\n' "$1" "$2" "$3"
    fail=1
  fi
}

# A row survives the same round trip the sweep puts it through.
roundtrip() {   # roundtrip <down> <up> <held> -> "down|up|lost|dup|held"
  local row d u lost dup held
  row=$(classify_row "$1" "$2" "$3")
  IFS=$'\t' read -r d u lost dup held <<< "$row"
  printf '%s|%s|%s|%s|%s' "$d" "$u" "$lost" "$dup" "$held"
}

# ---- classification ----------------------------------------------------------------
check "clean single press"              "1|1|-|-|-"                 "$(roundtrip 1 1 '')"
check "release lost"                    "1|0|up|-|up"               "$(roundtrip 1 0 'up')"
check "press lost"                      "0|1|down|-|-"              "$(roundtrip 0 1 '')"
check "both edges lost"                 "0|0|down+up|-|-"           "$(roundtrip 0 0 '')"
check "release duplicated"              "1|2|-|up x2|-"             "$(roundtrip 1 2 '')"
check "both edges duplicated"           "2|2|-|down x2, up x2|-"    "$(roundtrip 2 2 '')"
check "two keys held"                   "1|0|up|-|up,back"          "$(roundtrip 1 0 'up,back')"

# ---- the regression: a duplicated edge must not corrupt the held column -------------
dup_held=$(roundtrip 2 2 '')
check "duplicates leave held intact"    "-" "${dup_held##*|}"

# ---- qualification -----------------------------------------------------------------
q() { row_qualifies "$1" "$2" "$3" && echo yes || echo no; }
check "1 down 1 up nothing held"        "yes" "$(q 1 1 '-')"
check "duplicated release still counts" "yes" "$(q 1 2 '-')"
check "both duplicated still counts"    "yes" "$(q 2 2 '-')"
check "a lost release disqualifies"     "no"  "$(q 1 0 'up')"
check "a lost press disqualifies"       "no"  "$(q 0 1 '-')"
check "a held key disqualifies"         "no"  "$(q 1 1 'up')"
check "empty held is not held"          "yes" "$(q 1 1 '')"

# The whole point of the sweep: a two-bind configuration whose only flaw is a duplicate must
# qualify. If this is "no", the sweep reports "neither configuration qualifies" and blocks Task 7.
check "two-bind shape qualifies overall" "yes" "$(q 1 2 '')"

printf '\n%s\n' "$([[ $fail == 0 ]] && echo 'RESULT: PASS' || echo 'RESULT: FAIL')"
exit $fail
