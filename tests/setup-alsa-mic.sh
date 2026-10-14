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

# ---- alsa-mic CLI ----
am() { bash "$SRC" alsa-mic "$@"; }
rm -rf "$T/alsa"
check "get: missing file -> absent"            '{"state":"absent"}' "$(am get)"
am set n1 --expect-absent; check "set: create -> 0" "0" "$?"
check "get: present n1"                        '{"state":"present","node":"n1"}' "$(am get)"
check "set: file is exactly the block"         "$(lib 'gen_mic_block n1')" "$(cat "$RC")"
cp "$RC" "$T/snap"
out=$(am set n2 --expect-absent); rc=$?
check "set: wrong expectation -> 3"            "3" "$rc"
check "set: exit 3 prints the current state"   '{"state":"present","node":"n1"}' "$out"
check "set: exit 3 leaves the file"            "yes" "$(cmp -s "$RC" "$T/snap" && echo yes || echo no)"
am set n2 --expect n1; check "set: replace -> 0" "0" "$?"
am set --absent --expect n2; check "set: remove -> 0" "0" "$?"
check "set: removing the only block leaves an empty file" "0" "$(wc -c < "$RC")"
check "get: absent again"                      '{"state":"absent"}' "$(am get)"
am set none --expect-absent; check "set: node named none -> 0" "0" "$?"
check "get: none round-trips as present"       '{"state":"present","node":"none"}' "$(am get)"
am set absent --expect none; check "set: node named absent -> 0" "0" "$?"
check "get: absent round-trips as present"     '{"state":"present","node":"absent"}' "$(am get)"
for bad in 'a b' 'a"b' 'a}b' '-x'; do am set "$bad" --expect absent 2>/dev/null; check "set: node [$bad] -> 64" "64" "$?"; done
am set n1 2>/dev/null; check "set: no expectation -> 64" "64" "$?"
am set n1 --absent --expect-absent 2>/dev/null; check "set: two targets -> 64" "64" "$?"
am bogus 2>/dev/null; check "unknown verb -> 64" "64" "$?"
for f in "$B\n$E\n" "$B\n  capture_node \"a\"\n  capture_node \"b\"\n$E\n" "$B\n  capture_node \"n1\"\n" "$E\n$B\n  capture_node \"n1\"\n"; do
  printf "%b" "$f" > "$RC"; cp "$RC" "$T/snap"
  am get > /dev/null 2>&1; g=$?; am set n9 --expect n1 > /dev/null 2>&1; s=$?
  check "bad block -> get 2, set 2, file byte-identical" "2 2 yes" "$g $s $(cmp -s "$RC" "$T/snap" && echo yes || echo no)"
done
# refuse paths (exit 1, file byte-identical): a failing engine step or a state answer that is none of the known words
rfile() { printf '# mine\n%s\n  capture_node "n1"\n%s\n# tail\n' "$B" "$E" > "$RC"; lib 'alsa_rc_locked atv_alsa_write'; cp "$RC" "$T/snap"; }
rfile; lib 'alsa_rc_put() { return 1; }; cmd_alsa_mic set n2 --expect n1' > /dev/null 2>&1; rc=$?
check "refuse: alsa_rc_put fails -> set 1, file byte-identical" "1 yes" "$rc $(same "$RC" "$T/snap")"
for ans in '' 'weird'; do
  # only the caller's own read is stubbed (alsa_rc_put's inner check stays real), so each caller's guard is what refuses
  stub='eval "real_$(declare -f alsa_block_state)"
        alsa_block_state() { if [[ ${FUNCNAME[1]} == alsa_rc_put ]]; then real_alsa_block_state "$@"; return; fi
                             [[ -n "'"$ans"'" ]] && echo "'"$ans"'"; return 0; }; '
  rfile; lib "$stub"'cmd_alsa_mic get' > /dev/null 2>&1; g=$?
  lib "$stub"'cmd_alsa_mic set n2 --expect n1' > /dev/null 2>&1; s=$?
  check "refuse: state [${ans:-<nothing>}] -> get 1, set 1, file byte-identical" "1 1 yes" "$g $s $(same "$RC" "$T/snap")"
  lib "$stub"'atv_alsa_write' > /dev/null 2>&1; a=$?
  check "refuse: state [${ans:-<nothing>}] -> atv_alsa_write 1, file byte-identical" "1 yes" "$a $(same "$RC" "$T/snap")"
done
printf '# top\n' > "$RC"; am set n1 --expect-absent
printf '# top\n%s\n  capture_node "n1"\n  # hand note\n%s\n' "$B" "$E" > "$RC"
am set n1 --expect n1; check "set: same node over a hand-edited block is a no-op (0)" "0" "$?"
am set n2 --expect n1; am set n1 --expect n2
check "rollback to present writes the canonical block (semantic restore)" "# top
$(lib 'gen_mic_block n1')" "$(cat "$RC")"

# ---- concurrency: two locked writers, 50 rounds each; unlocked readers, 500 reads ----
rm -rf "$T/alsa"; mkdir -p "$T/alsa"; printf '# keep me\npcm.mine { type null }\n' > "$RC"; am set na --expect-absent
lib 'alsa_rc_locked atv_alsa_write'                     # both blocks exist before the writers start: every read must see both
mic_flip() { local i cur nxt; for i in $(seq 1 50); do cur=$(am get | jq -r .node); [[ $cur == na ]] && nxt=nb || nxt=na; am set "$nxt" --expect "$cur" || echo "flip-fail $?" >> "$T/errs"; done; }
atv_flip() { ( source "$LIB"; set +e; for i in $(seq 1 50); do ATV_NODE=atvvoice-$(( i % 2 )); alsa_rc_locked atv_alsa_write || echo "atv-fail $?" >> "$T/errs"; done ); }
: > "$T/errs"
mic_flip & p1=$!; atv_flip & p2=$!
reads=0; badreads=0
while kill -0 $p1 2>/dev/null || kill -0 $p2 2>/dev/null || (( reads < 500 )); do
  r=$(am get 2>/dev/null) || { badreads=$((badreads + 1)); r=""; }
  [[ $r == '{"state":"present","node":"na"}' || $r == '{"state":"present","node":"nb"}' ]] || badreads=$((badreads + 1))
  a=$(lib 'alsa_rc_read && alsa_block_state "$ALSA_CONTENT" "$ALSA_BEGIN" "$ALSA_END" 0')
  [[ $a == present ]] || badreads=$((badreads + 1))
  reads=$((reads + 1)); (( reads >= 500 )) && ! kill -0 $p1 2>/dev/null && ! kill -0 $p2 2>/dev/null && break
done
wait $p1 $p2
check "concurrency: no writer failed"                  "" "$(cat "$T/errs")"
check "concurrency: >= 500 unlocked reads, none bad"   "0" "$badreads"
check "concurrency: both blocks present at the end"    "2 2" "$(grep -c '^# BEGIN omaremote' "$RC") $(grep -c '^# END omaremote' "$RC")"
check "concurrency: outside lines intact"              "# keep me
pcm.mine { type null }" "$(head -n 2 "$RC")"

# ---- facts: alsa.mic and pipewire.defaultSource ----
FACTS=$(dirname "$SRC")/omaremote-facts
FB=$T/fbin; mkdir -p "$FB" "$T/home"
for t in bash env jq awk grep sed timeout cat mktemp rm dirname readlink basename flock mv chmod mkdir id tr; do ln -sf "$(type -P "$t")" "$FB/$t"; done
printf '#!/bin/bash\nexit 0\n' > "$FB/systemctl"; printf '#!/bin/bash\nexit 0\n' > "$FB/busctl"
cat > "$FB/pw-dump" <<'STUB'
#!/bin/bash
cat <<'J'
[{"id":1,"type":"PipeWire:Interface:Node","info":{"props":{"media.class":"Audio/Source","node.name":"n1"}}},
 {"id":10,"type":"PipeWire:Interface:Metadata","props":{"metadata.name":"default"},
  "metadata":[{"subject":0,"key":"default.audio.source","type":"Spa:String:JSON","value":{"name":"n1"}}]}]
J
STUB
chmod +x "$FB/systemctl" "$FB/busctl" "$FB/pw-dump"
facts() { env -i PATH="$FB" HOME="$T/home" OMAREMOTE_ALSA_RC="$RC" "$FB/bash" "$FACTS" | "$FB/jq" -c "$1"; }
rm -rf "$T/alsa"
check "facts: no file -> alsa.mic absent"      '{"state":"absent"}' "$(facts .alsa.mic)"
am set n1 --expect-absent
check "facts: alsa.mic present"                '{"state":"present","node":"n1"}' "$(facts .alsa.mic)"
printf '%b' "$B\n$E\n" > "$RC"
check "facts: malformed block -> bad"          '{"state":"bad"}' "$(facts .alsa.mic)"
check "facts: pipewire.defaultSource"          '"n1"' "$(facts .pipewire.defaultSource)"
printf '#!/bin/bash\necho "[]"\n' > "$FB/pw-dump"
check "facts: no default metadata -> null"     'null' "$(facts .pipewire.defaultSource)"

printf '\n%s\n' "$([[ $fail == 0 ]] && echo 'RESULT: PASS' || echo 'RESULT: FAIL')"
exit $fail
