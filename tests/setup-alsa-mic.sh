#!/usr/bin/env bash
# Mic source picker spec §4.1/§4.2: the shared asoundrc block engine (single-read parse, lock, atomic write), the
# alsa-mic subcommand and the facts it feeds. Every path is a temp dir; the user's ~/.config/alsa is never touched.
# Usage: bash tests/setup-alsa-mic.sh [path to omaremote-setup]
set -uo pipefail
SRC=${1:-$(dirname "$0")/../host/omaremote-setup}
SRC=$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ $2 == "$3" ]]; then printf '  ok    %-62s\n' "$1"; else printf '  FAIL  %-62s expected [%s] got [%s]\n' "$1" "$2" "$3"; fail=1; fi; }
LIB=$T/lib.sh
sed '/^main "\$@"$/d' "$SRC" > "$LIB"
RC=$T/alsa/asoundrc
export OMAREMOTE_ALSA_RC=$RC
# lib <snippet>: run bash code with the script's functions loaded, in a subshell
lib() { ( source "$LIB"; set +e; eval "$1" ); }

# ---- the node pattern: same table as tests/AlsaMic.test.mjs NODE_TABLE ----
while IFS='|' read -r name want; do
  got=$(NAME=$name bash -c 'source "$0"; [[ $NAME =~ $NODE_RE ]] && echo true || echo false' "$LIB")
  check "NODE_RE ${name:-<empty>}" "$want" "$got"
done <<'TABLE'
alsa_input.usb-046d_C922_Pro_Stream_Webcam_557DD3BF-02.analog-stereo|true
atvvoice-xiaomi|true
none|true
absent|true
a:b.c_d-e|true
_x|true
.x|true
:x|true
-x|false
|false
a b|false
a"b|false
a}b|false
a{b|false
a\b|false
TABLE

# ---- alsa_block_state: strict (mic) vs markers-only (atvvoice) ----
B='# BEGIN omaremote mic (managed by omaremote-setup; do not edit)'; E='# END omaremote mic'
st() { lib 'alsa_block_state "$(cat '"$T"'/in)" "$MIC_BEGIN" "$MIC_END" '"${2:-1}"; }
put_in() { printf '%b' "$1" > "$T/in"; }
put_in '';                                             check "state: empty -> absent"                  "absent" "$(st)"
put_in '# mine\n';                                     check "state: no markers -> absent"             "absent" "$(st)"
put_in "$B\n  capture_node \"n1\"\n$E\n";              check "state: one capture_node -> present n1"   "present n1" "$(st)"
put_in "$B\n  capture_node \"n1\"\n$E";                check "state: no final newline still parses"    "present n1" "$(st)"
put_in "$B\n  capture_node \"n1\"\n";                  check "state: no END -> bad"                    "bad" "$(st)"
put_in "$E\n$B\n  capture_node \"n1\"\n";              check "state: END before BEGIN -> bad"          "bad" "$(st)"
put_in "$B\n$E\n";                                     check "state: no capture_node -> bad"           "bad" "$(st)"
put_in "$B\n  capture_node \"a\"\n  capture_node \"b\"\n$E\n"; check "state: two capture_node -> bad"   "bad" "$(st)"
put_in "$B\n  capture_node \"a b\"\n$E\n";             check "state: value fails pattern -> bad"       "bad" "$(st)"
put_in "$B\n  capture_node \"a\"b\"\n$E\n";            check "state: embedded quote -> bad"            "bad" "$(st)"
put_in "$B\n  capture_node \"n1\"\n$E\n$B\n  capture_node \"n1\"\n$E\n"; check "state: two blocks -> bad" "bad" "$(st)"
put_in "$B\npcm.stale {}\n$E\n";                       check "state: markers-only mode ignores content" "present" "$(st x 0)"

# ---- alsa_rc_put + add/remove layout (§4.1) ----
blk=$(lib 'gen_mic_block n1')
check "gen_mic_block text" "$B
pcm.omaremote-mic {
  type pipewire
  capture_node \"n1\"
  hint { show on description \"omaremote picked microphone\" }
}
$E" "$blk"
roundtrip() {   # roundtrip <original printf %b text>: prints yes when add-then-remove gives back the original bytes
  printf '%b' "$1" > "$T/orig"
  lib 'c=$(cat '"$T"'/orig; printf x); c=${c%x}
       a=$(alsa_rc_put "$c" "$MIC_BEGIN" "$MIC_END" "$(gen_mic_block n1)"; printf x); a=${a%x}
       r=$(alsa_rc_put "$a" "$MIC_BEGIN" "$MIC_END" ""; printf x); r=${r%x}
       printf %s "$r" > '"$T"'/back; printf %s "$a" > '"$T"'/added'
  cmp -s "$T/orig" "$T/back" && echo yes || echo no
}
check "layout: empty file round-trips"                 "yes" "$(roundtrip '')"
check "layout: newline-terminated file round-trips"    "yes" "$(roundtrip '# a\npcm.x {}\n')"
check "layout: appended with no blank line"            "# a
pcm.x {}
$B" "$(head -n 3 "$T/added")"
roundtrip '# a\npcm.x {}' > /dev/null
check "layout: unterminated file gains only one newline" "# a|pcm.x {}|" "$(tr '\n' '|' < "$T/back")"
printf '# top\n%s\n  capture_node "old"\n  # my note\n%s\n# bottom\n' "$B" "$E" > "$T/in"
out=$(lib 'c=$(cat '"$T"'/in; printf x); c=${c%x}; alsa_rc_put "$c" "$MIC_BEGIN" "$MIC_END" "$(gen_mic_block n2)"')
check "put: replaces in place, outside kept, inner note dropped" "# top
$(lib 'gen_mic_block n2')
# bottom" "$out"
# outside bytes are kept exactly, including a last line with no newline (replace and remove)
putfiles() {   # putfiles <input printf %b text>: writes $T/rep (block -> n2) and $T/rem (block removed), byte-exact
  printf '%b' "$1" > "$T/in"
  lib 'c=$(cat '"$T"'/in; printf x); c=${c%x}
       alsa_rc_put "$c" "$MIC_BEGIN" "$MIC_END" "$(gen_mic_block n2)" > '"$T"'/rep
       alsa_rc_put "$c" "$MIC_BEGIN" "$MIC_END" "" > '"$T"'/rem'
}
same() { cmp -s "$1" "$2" && echo yes || echo no; }
putfiles "# top\n$B\n  capture_node \"o\"\n$E\n# tail"
{ printf '# top\n'; lib 'gen_mic_block n2'; printf '\n# tail'; } > "$T/want"
check "put: replace keeps an unterminated tail line byte for byte" "yes" "$(same "$T/rep" "$T/want")"
printf '# top\n# tail' > "$T/want"
check "put: remove keeps an unterminated tail line byte for byte"  "yes" "$(same "$T/rem" "$T/want")"
putfiles "# top\n$B\n  capture_node \"o\"\n$E"
{ printf '# top\n'; lib 'gen_mic_block n2'; } > "$T/want"
check "put: unterminated END stays unterminated on replace"        "yes" "$(same "$T/rep" "$T/want")"
printf '# top\n' > "$T/want"
check "put: remove of an unterminated last block keeps the rest"   "yes" "$(same "$T/rem" "$T/want")"
putfiles "$B\n  capture_node \"o\"\n$E\n# tail\n"
{ lib 'gen_mic_block n2'; printf '\n# tail\n'; } > "$T/want"
check "put: block at the very start is replaced in place"          "yes" "$(same "$T/rep" "$T/want")"

# ---- alsa_rc_write: atomic, mode kept ----
rm -rf "$T/alsa"; mkdir -p "$T/alsa"; printf 'x\n' > "$RC"; chmod 640 "$RC"
lib 'alsa_rc_write "y
"' ; check "write: content replaced" "y" "$(cat "$RC")"
check "write: mode kept"            "640" "$(stat -c %a "$RC")"
check "write: no temp left behind"  "0" "$(find "$T/alsa" -name '.asoundrc.omaremote.*' | wc -l)"
rm -f "$RC"; lib 'alsa_rc_write "z
"'; check "write: new file is 644" "644" "$(stat -c %a "$RC")"
# atomic = a new inode via rename, never an in-place rewrite; so a read-only file in a writable dir is still replaced
printf 'x\n' > "$RC"; chmod 440 "$RC"; ino=$(stat -c %i "$RC")
lib 'alsa_rc_write "ro
"'; check "write: read-only file replaced (rename, not in-place)" "ro" "$(cat "$RC")"
check "write: new inode (atomic replace)" "yes" "$([[ $(stat -c %i "$RC") != "$ino" ]] && echo yes || echo no)"
check "write: read-only mode kept" "440" "$(stat -c %a "$RC")"
chmod 644 "$RC"
# a symlinked asoundrc stays a link; the target gets the content
mkdir -p "$T/dots"; printf 'old\n' > "$T/dots/real"; chmod 600 "$T/dots/real"; rm -f "$RC"; ln -s "$T/dots/real" "$RC"
lib 'alsa_rc_write "via link
"'
check "write: symlink stays a link"      "yes" "$([[ -L $RC ]] && echo yes || echo no)"
check "write: link target has new content" "via link" "$(cat "$T/dots/real")"
check "write: link target mode kept"     "600" "$(stat -c %a "$T/dots/real")"
check "write: no temp beside the target" "0" "$(find "$T/dots" "$T/alsa" -name '.asoundrc.omaremote.*' | wc -l)"
rm -f "$RC"; ln -s "$T/dots/new" "$RC"
lib 'alsa_rc_write "dangling
"'
check "write: dangling link -> target created" "dangling" "$(cat "$T/dots/new" 2>/dev/null)"
check "write: dangling link stays a link" "yes" "$([[ -L $RC ]] && echo yes || echo no)"
rm -f "$RC"

# ---- alsa_rc_locked: waits, then times out ----
rm -rf "$T/alsa"; mkdir -p "$T/alsa"
( flock "$RC.omaremote.lock" sleep 1 ) & sleep 0.2
t0=$(date +%s%N); lib 'alsa_rc_locked true'; rc=$?; t1=$(date +%s%N)
check "lock: waits for a short holder, then succeeds" "0" "$rc"
check "lock: really waited (>= 0.5 s)" "yes" "$( (( t1 - t0 >= 500000000 )) && echo yes || echo no )"
wait
( flock "$RC.omaremote.lock" sleep 3 ) & sleep 0.2
rm -f "$T/ran"
OMAREMOTE_ALSA_LOCK_WAIT=1 lib 'alsa_rc_locked touch '"$T"'/ran'; check "lock: held past the wait -> 1" "1" "$?"
check "lock: timed-out fn never ran" "no" "$([[ -e $T/ran ]] && echo yes || echo no)"
wait
: > "$T/notadir"; OMAREMOTE_ALSA_RC=$T/notadir/asoundrc lib 'alsa_rc_locked true'; check "lock: unmakeable dir -> 1" "1" "$?"

# ---- atv_alsa_write: the atvvoice block on the shared engine ----
rm -rf "$T/alsa"
lib 'atv_alsa_write; echo "rc=$? changed=$ALSA_CHANGED"' > "$T/o"; check "atv: fresh write" "rc=0 changed=1" "$(cat "$T/o")"
check "atv: file is exactly the block" "$(lib gen_alsa_block)" "$(cat "$RC")"
lib 'atv_alsa_write; echo "rc=$? changed=$ALSA_CHANGED"' > "$T/o"; check "atv: rerun unchanged" "rc=0 changed=0" "$(cat "$T/o")"
printf '%s\npcm.x {}\n' "$(lib 'echo "$ALSA_BEGIN"')" > "$RC"; before=$(cat "$RC")
lib 'atv_alsa_write; echo "rc=$?"' > "$T/o"; check "atv: unbalanced -> 2" "rc=2" "$(cat "$T/o")"
check "atv: unbalanced file unchanged" "$before" "$(cat "$RC")"

printf '\n%s\n' "$([[ $fail == 0 ]] && echo 'RESULT: PASS' || echo 'RESULT: FAIL')"
exit $fail
