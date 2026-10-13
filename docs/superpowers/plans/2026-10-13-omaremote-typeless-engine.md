# Typeless Transcription Engine — Implementation Plan (Plan 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user can pick Typeless instead of Voxtype as the transcription engine. With Typeless, the remote's
voice button only sends Typeless's dictation hotkey through a persistent uinput keyboard. In `remote` mic mode a
hold sends one tap at the start and one at the end. In `system` mode each press sends one tap.

**Architecture:** A stdlib-Python daemon, `omaremote-keytap`, owns one full uinput keyboard and taps allowlisted
chords on request over a Unix socket. A new pure module, `lib/TypelessSession.mjs`, decides when to tap. It works by
reconciliation, with single-flight taps and an explicit `unsynced` state. A second pure module, `lib/EngineSwitch.mjs`,
holds the routing table, the drain-then-commit engine switch and the keytap exit-code mapping. Service.qml only wires
these modules together.

ConfigStore writes become a serialized, unmerged FIFO (`lib/ConfigWrites.mjs`), so `omaremote-setup typeless` can
prove that a hotkey reached disk. CommandRunner gains a hard completion bound. Doctor, the Voice tab and setup gain
Typeless rows, an Engine row and a `typeless` subcommand.

**Tech Stack:**
- Quickshell QML; plain ES modules under `node --test`;
- Python 3 stdlib (`fcntl`, `socket`, `struct`, `unittest`);
- bash (setup, fakes, integration harness); systemd user units; Linux uinput.

**Spec:** `docs/superpowers/specs/2026-10-13-typeless-engine-design.md` (rev 5, approved 2026-10-13). It amends
`docs/superpowers/specs/2026-09-14-omaremote-design.md` §3, §5 and §6.2, and
`docs/superpowers/specs/2026-10-12-remote-mic-design.md` §5. Section numbers like §5.2 below refer to the Typeless spec.

**Validation (revision 2, after review):** the plan was applied to a fresh worktree from its own text. The script
used every whole-file block and every `Replace`/`with` pair as written, and every `Replace` matched exactly once.
`make check` then passed:
- 361 unit tests;
- 21 keytap tests;
- `runner-bound: ok`;
- `setup-typeless: all ok`;
- 71 integration scenarios.

Each test added for the review was also run against the reverted defect, and it failed there.

Defects found by running the plan:
- FileView answers a `setText` issued inside its own `loadFailed` with no `saved` (Task 5);
- jq's `// empty` turns `false` into nothing (Task 13);
- `KEYTAP_SRC` resolved wrongly when a test sources setup (Task 13);
- the CommandRunner harness could not observe the hard bound until it gained `escalationSignal` (Task 8).

Defects found by review:
- a save-watchdog failure let a late `saved` be credited to the next write. Fixed with one writer FileView per seq
  (Tasks 4–5).
- startup seeded before going dormant, so a held button tapped under Voxtype. Fixed with `startTypeless`
  (Tasks 9–10).
- a refused second mic request released the first apply's `mic` holder (Task 10).
- the session bound was not scheduled while the start tap was in flight (Task 6).
- under Typeless, the Voxtype rows still decided the Doctor summary and the bar (Task 12).

If a step's expected output differs from what you see, stop and report it. Do not adjust the test to match.

## Global Constraints

**keytap daemon and client**
- `omaremote-keytap` is one stdlib-only Python 3 file. It always runs as `python3 -I <path> …`.
- Device name `omaremote keytap`, bus `BUS_VIRTUAL` (0x06), key codes 1–248 advertised.
- Socket `$XDG_RUNTIME_DIR/omaremote-keytap.sock`, mode 0600. When `XDG_RUNTIME_DIR` is unset it is `/run/user/<uid>`.
- Allowlist:
  - modifiers `LeftCtrl RightCtrl LeftShift RightShift LeftAlt RightAlt LeftMeta RightMeta`;
  - main keys `A`–`Z`, `0`–`9`, `Space`, `F1`–`F24`;
  - aliases `Left/RightSuper`, `Left/RightWin` → `Left/RightMeta`, and `Left/RightControl` → `Left/RightCtrl`.
  - Names match case-insensitively. At most 4 names.
- Chord rejection reasons, verbatim and identical in JS and Python:
  `empty name`, `too many names`, `unknown name: <as written>`, `duplicate name: <canonical>`, `two main keys`.
- Tap timing:
  - the other names are pressed in order, 30 ms apart;
  - the trigger is held 80 ms;
  - the others are released in reverse order, 30 ms apart.
- Protocol:
  - each connection has a 500 ms read deadline and a 128-byte request limit, newline included;
  - replies are `ok`, `err reject <reason>` or `err write <reason>`.
- Client exit codes: 0 ok · 2 reject · 3 connect failed · 4 err write · 5 no reply within 1.5 s or broken connection.

**Service timing**
- Keytap runner deadline is 2000 ms. CommandRunner sends SIGKILL 500 ms after SIGTERM and always reports by
  deadline + 1000 ms with code 124.
- Tap outcomes:
  - 0 → `sent`;
  - 2, 3 and 127 → `notSent` (reason for 3: `keytap not running`);
  - anything else, including 124 and 137 → `unknown`.
- Engine drain bound: 3000 ms, for VoiceSession and TypelessSession each.

**Config writes**
- ConfigStore write FIFO: at most 8, counting the in-flight write. A ninth request fails with
  `too many pending config writes`.
- `status` publishes the last 16 outcomes.
- `voice.engine` and `voice.typeless` are **not** in `DEFAULT_VOICE`. A freshly created `config.json` must not contain
  `voice.typeless.hotkey`, or `typeless.hotkeyStored` would always be true and first-run setup could never adopt
  Typeless's value. Normalization supplies `engine: "voxtype"` and `typeless.hotkey: "RightAlt"` in memory only.

**Status fields** that tests and setup rely on (exact names):
- `engine`;
- `typeless.hotkey`, `typeless.hotkeyStored`, `typeless.state`, `typeless.switching`, `typeless.view`;
- `configWrites.saves` (`"<seq>" → "saved"|"failed"|"pending"`) and `configWrites.errors` (`"<seq>" → reason`).
- **Deviation from spec §4.3:** the spec says `config.saves`, but `status.config` is already a boolean that existing
  integration tests read. The outcomes therefore live under `configWrites`.

**HUD texts, verbatim**
- `Typeless trigger failed: <reason>`
- `Typeless state unknown — check Typeless; press reset when it is stopped`
- `a Typeless trigger is still pending — wait a moment, check Typeless is stopped, then reset again`
- `max session reached`
- `too fast — press ignored`
- `Typeless trigger failed; check Typeless before pressing again`
- `dictation paused: <reason>`
- `Typeless may still be recording`
- `switching engine`
- The system-mode flash is `Typeless ⏯`.

**Measured on 2026-10-13, which corrects spec §2.6.** In Typeless's `app-settings.json`:
- `selectedMicrophoneDevice` is an object `{deviceId, label, …}`. Auto-detect is `deviceId: "default"`, and the label
  starts with `Auto-detect`.
- `featureShortcutBindings.dictationMode` can hold more than one chord. Only `[0]` is used.
- The ATVVoice node's PipeWire `node.description` (`小米蓝牙语音遥控器`) equals Typeless's label for the remote.

**Testing and safety**
- The agent has no root. Every `sudo` command is printed for the user and never run.
- Tests never touch:
  - the real voxtype, systemd, ATVVoice, Typeless, `/dev/uinput`;
  - `~/.config/omaremote`, `~/.config/Typeless`, `~/.local/lib/omaremote`.
- Never `pkill -f` or `pgrep -f` a pattern that appears in your own command line.
- Anything that injects real keys (the hardware acceptance in Task 14) runs only with the user present, who controls
  the timing.
- `make check` is green only when `make check; echo MAKE_CHECK_EXIT=$?` prints `MAKE_CHECK_EXIT=0`.
- `tests/fake-remote.sh <scenario>` takes the scenario name as a positional argument.
- Library code must run under the QML V4 engine. Do not use optional chaining (`?.`), `??`, or `Array.prototype.at`
  in `lib/*.mjs`. `tests/harness/ModuleLoad.qml` imports every module.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL
  ```

## Review Focus

1. **Rapid short presses in `remote` mode.** The user taps the mic button five times in a second, so streams start
   and end while taps are still in flight. Expected: never more than one tap outstanding. Once everything is
   released and every result is in, Typeless is off and the taps alternate start/stop. Task 6 adds this test.
2. **The Engine button is pressed again while a switch is draining.** Expected: the second request is refused
   (`busy`), and the engine ends on the first target. Task 9 adds this test.
3. **The hotkey changes while `system` presses are still queued.** Expected: each queued press taps the chord that
   was current when it was pressed, so a half-sent sequence is not split across two chords. Task 6 adds this test.
4. **`XDG_RUNTIME_DIR` is unset** (the client is spawned from an environment without it). Expected: the client and
   daemon still agree on `/run/user/<uid>/omaremote-keytap.sock`. Task 2 adds this test.
5. **Typeless's settings file lacks `dictationMode`, or holds a non-string or invalid chord.** Expected: setup falls
   back to `RightAlt` and says so, and Doctor shows `unknown` rather than a false mismatch. Tasks 12 and 13 add
   these tests.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `tests/fixtures/chords.json` | create | shared chord table: input → canonical or rejection reason |
| `lib/Chord.mjs` | create | chord parser (§3.1, §4.2) |
| `host/omaremote-keytap` | create | uinput daemon + client (§4.1) |
| `tests/test_keytap.py` | create | python unittest for keytap |
| `lib/Defaults.mjs`, `lib/Config.mjs` | modify | `voice.engine`, `voice.typeless.hotkey` |
| `lib/ConfigWrites.mjs` | create | serialized write FIFO + watcher reconcile decisions (§4.3) |
| `components/ConfigStore.qml` | modify | drive FileView through ConfigWrites; `setVoiceEngine`, `setTypelessHotkey` |
| `lib/TypelessSession.mjs` | create | remote reconcile, system FIFO, quiesce holders, dormant (§5) |
| `lib/VoiceSession.mjs` | modify | `drain`, `undrain`, `drained` (§6.2) |
| `components/CommandRunner.qml` | modify | SIGKILL escalation, deadline + 1 s completion (§6.1) |
| `tests/harness/RunnerBound.qml`, `tests/runner-bound.sh` | create | offscreen Quickshell check of CommandRunner |
| `lib/EngineSwitch.mjs` | create | `routeTargets`, `tapOutcome`, `micVoiceView`, `createEngineSwitch` |
| `Service.qml` | modify | wiring, IPC `typelessHotkey`/`engine`, status, shell exit |
| `tests/fakes/bin/omaremote-keytap` | create | fake keytap client for the harness |
| `lib/Presentation.mjs`, `BarWidget.qml`, `components/VoiceTab.qml` | modify | Typeless display, Engine row |
| `lib/Doctor.mjs`, `host/omaremote-facts` | modify | five Typeless rows; `typeless` facts |
| `host/omaremote-setup` | modify | `typeless` subcommand; `ipc()` gains `timeout` |
| `tests/setup-typeless.sh` | create | setup `typeless` against stubs |
| `tests/fixtures/typeless-settings.json` | create | Typeless settings fixture for the Doctor scenario |
| `tests/fake-remote.sh` | modify | Typeless scenarios |
| `tests/harness/ModuleLoad.qml`, `Makefile` | modify | new modules; new test scripts in `check` |
| `README.md`, spec | modify | Typeless section, known limitation, status |

---
### Task 1: Chord grammar (JS) and the shared fixture

**Files:**
- Create: `tests/fixtures/chords.json`
- Create: `lib/Chord.mjs`
- Create: `tests/Chord.test.mjs`
- Modify: `tests/harness/ModuleLoad.qml`

**Interfaces:**
- Produces:
  - `parseChord(text) → { ok: true, names: string[], canonical: string, trigger: string } | { ok: false, reason: string }`.
    `names` is in tap order: modifiers in written order, then the main key, if any.
  - `canonicalChord(text) → string | null`.
  - `MODIFIERS: string[]` and `MAIN_KEYS: string[]`.
  - The fixture rows: `{ "in": string, "out": string }` or `{ "in": string, "err": string }`. Task 2's Python parser
    reads the same file.

- [ ] **Step 1: Write the fixture** `tests/fixtures/chords.json`

```json
[
  { "in": "RightAlt", "out": "RightAlt" },
  { "in": "rightalt", "out": "RightAlt" },
  { "in": "RIGHTALT+rightshift", "out": "RightAlt+RightShift" },
  { "in": "RightShift+RightAlt", "out": "RightShift+RightAlt" },
  { "in": "RightCtrl+Space", "out": "RightCtrl+Space" },
  { "in": "space+rightctrl", "out": "RightCtrl+Space" },
  { "in": "LeftCtrl+a+LeftShift", "out": "LeftCtrl+LeftShift+A" },
  { "in": "RightSuper+F13", "out": "RightMeta+F13" },
  { "in": "leftwin+1", "out": "LeftMeta+1" },
  { "in": "RightControl+F24", "out": "RightCtrl+F24" },
  { "in": "LeftMeta+LeftCtrl+LeftAlt+LeftShift", "out": "LeftMeta+LeftCtrl+LeftAlt+LeftShift" },
  { "in": "f1", "out": "F1" },
  { "in": "0", "out": "0" },
  { "in": "RightAlt+rightalt", "err": "duplicate name: RightAlt" },
  { "in": "RightSuper+RightMeta", "err": "duplicate name: RightMeta" },
  { "in": "A+B", "err": "two main keys" },
  { "in": "Space+F5+LeftAlt", "err": "two main keys" },
  { "in": "LeftCtrl+LeftAlt+LeftShift+LeftMeta+A", "err": "too many names" },
  { "in": "", "err": "empty name" },
  { "in": "RightAlt+", "err": "empty name" },
  { "in": "+RightAlt", "err": "empty name" },
  { "in": "Alt", "err": "unknown name: Alt" },
  { "in": "Ctrl+Space", "err": "unknown name: Ctrl" },
  { "in": "RightAlt+Enter", "err": "unknown name: Enter" },
  { "in": "F25", "err": "unknown name: F25" },
  { "in": " RightAlt", "err": "unknown name:  RightAlt" }
]
```

- [ ] **Step 2: Write the failing test** `tests/Chord.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseChord, canonicalChord, MODIFIERS, MAIN_KEYS } from "../lib/Chord.mjs";

const TABLE = JSON.parse(readFileSync(new URL("./fixtures/chords.json", import.meta.url), "utf8"));

test("every row of the shared chord table parses to its canonical form or its exact rejection reason", () => {
  for (const row of TABLE) {
    const r = parseChord(row.in);
    if (row.out !== undefined) {
      assert.equal(r.ok, true, `${JSON.stringify(row.in)} should parse, got ${r.reason}`);
      assert.equal(r.canonical, row.out, `input ${JSON.stringify(row.in)}`);
      assert.equal(canonicalChord(row.in), row.out);
    } else {
      assert.equal(r.ok, false, `${JSON.stringify(row.in)} should be rejected`);
      assert.equal(r.reason, row.err, `input ${JSON.stringify(row.in)}`);
      assert.equal(canonicalChord(row.in), null);
    }
  }
});

test("the table exercises both shapes, aliases, case, duplicates, two main keys, >4 names and an empty name", () => {
  const errs = TABLE.filter(r => r.err).map(r => r.err.split(":")[0]);
  for (const e of ["duplicate name", "two main keys", "too many names", "empty name", "unknown name"]) assert.ok(errs.includes(e), e);
  assert.ok(TABLE.some(r => r.out === "RightShift+RightAlt"), "modifiers-only keeps written order");
  assert.ok(TABLE.some(r => r.in === "space+rightctrl" && r.out === "RightCtrl+Space"), "main key moves last");
});

test("the trigger is the main key, or the last modifier of a modifiers-only chord", () => {
  assert.equal(parseChord("Space+RightCtrl").trigger, "Space");
  assert.equal(parseChord("RightAlt+RightShift").trigger, "RightShift");
  assert.deepEqual(parseChord("LeftCtrl+a+LeftShift").names, ["LeftCtrl", "LeftShift", "A"]);
});

test("the allowlist is exactly 8 modifiers and 26 letters + 10 digits + Space + F1-F24", () => {
  assert.equal(MODIFIERS.length, 8);
  assert.equal(MAIN_KEYS.length, 26 + 10 + 1 + 24);
  assert.equal(parseChord("Escape").ok, false);
  assert.equal(parseChord("toString").ok, false, "object prototype names are not keys");
});

test("non-string input is rejected, not thrown", () => {
  assert.equal(parseChord(undefined).ok, false);
  assert.equal(parseChord(null).reason, "empty name");
  assert.equal(parseChord(true).reason, "unknown name: true");
  assert.equal(parseChord(5).canonical, "5", "a number is stringified, and 5 is a digit key");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test tests/Chord.test.mjs`
Expected: FAIL with `Cannot find module '…/lib/Chord.mjs'`.

- [ ] **Step 4: Implement** `lib/Chord.mjs`

```js
// Typeless spec §3.1 (chord grammar) and §4.2 (allowlist). host/omaremote-keytap carries the same parser; both run
// tests/fixtures/chords.json, so a chord omaremote stores is exactly a chord keytap will send.
export const MODIFIERS = ["LeftCtrl", "RightCtrl", "LeftShift", "RightShift", "LeftAlt", "RightAlt", "LeftMeta", "RightMeta"];
const main = ["Space"];
for (let c = 65; c <= 90; c++) main.push(String.fromCharCode(c));
for (let d = 0; d <= 9; d++) main.push(String(d));
for (let f = 1; f <= 24; f++) main.push("F" + f);
export const MAIN_KEYS = main;

const ALIASES = { leftsuper: "LeftMeta", rightsuper: "RightMeta", leftwin: "LeftMeta", rightwin: "RightMeta",
                  leftcontrol: "LeftCtrl", rightcontrol: "RightCtrl" };
const CANON = new Map();
for (const n of MODIFIERS.concat(MAIN_KEYS)) CANON.set(n.toLowerCase(), n);
for (const k of Object.keys(ALIASES)) CANON.set(k, ALIASES[k]);

export function parseChord(text) {
  const parts = String(text === undefined || text === null ? "" : text).split("+");
  if (parts.length > 4) return { ok: false, reason: "too many names" };
  const names = [];
  for (const p of parts) {
    if (p === "") return { ok: false, reason: "empty name" };
    const c = CANON.get(p.toLowerCase());
    if (c === undefined) return { ok: false, reason: "unknown name: " + p };
    if (names.indexOf(c) >= 0) return { ok: false, reason: "duplicate name: " + c };
    names.push(c);
  }
  const mains = names.filter(n => MODIFIERS.indexOf(n) < 0);
  if (mains.length > 1) return { ok: false, reason: "two main keys" };
  const ordered = names.filter(n => MODIFIERS.indexOf(n) >= 0).concat(mains);
  return { ok: true, names: ordered, canonical: ordered.join("+"), trigger: ordered[ordered.length - 1] };
}

export function canonicalChord(text) {
  const r = parseChord(text);
  return r.ok ? r.canonical : null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/Chord.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 6: Add the module to the QML load check.** In `tests/harness/ModuleLoad.qml`, add after the `Actions`
  import:

```qml
import "../../lib/Chord.mjs" as Chord
```

and add this element to the `checks` array, after `Actions.toArgv({ type: "none" }).kind`:

```js
            , Chord.parseChord("RightAlt+RightShift").canonical
```

Run: `make lint`
Expected: the output contains `module-load: ok`.

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures/chords.json lib/Chord.mjs tests/Chord.test.mjs tests/harness/ModuleLoad.qml
git commit -m "feat(typeless): chord grammar with a shared fixture table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---

### Task 2: `omaremote-keytap` daemon and client

**Files:**
- Create: `host/omaremote-keytap` (mode 0755)
- Create: `tests/test_keytap.py`
- Modify: `Makefile` (`check` target)

**Interfaces:**
- Consumes: `tests/fixtures/chords.json` (Task 1).
- Produces:
  - The CLI `python3 -I omaremote-keytap serve | tap <chord> | ping`, with exit codes 0/2/3/4/5 and 64 for usage.
  - The module functions `parse_chord(text) -> list[str]`, which raises `ChordError(reason)`; `sock_path()`;
    `process(line, kb) -> str`; `serve(path, kb, ready=None)`; `client(line, path=None, timeout=1.5) -> int`.
  - The class `Keyboard(write, sleep=time.sleep, destroy=None)` with `.tap(names)`, `.release_all()` and `.close()`.
  - Task 10 calls the CLI. Task 13 installs the file and runs `ping`.

- [ ] **Step 1: Write the failing tests** `tests/test_keytap.py`

```python
#!/usr/bin/env python3
"""Typeless spec §4 / §9: omaremote-keytap's parser, event order, release-on-failure, socket protocol and client
exit codes. Stdlib unittest; never opens /dev/uinput (an injected writer stands in for it).
Run: python3 -I tests/test_keytap.py"""
import importlib.machinery
import importlib.util
import json
import os
import socket
import stat
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def load_keytap():
    path = os.path.join(HERE, "..", "host", "omaremote-keytap")
    loader = importlib.machinery.SourceFileLoader("omaremote_keytap", path)
    spec = importlib.util.spec_from_loader("omaremote_keytap", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


kt = load_keytap()
EV_KEY, EV_SYN = 1, 0


class Recorder:
    """Stands in for the uinput fd: records (type, code, value); optionally fails on the Nth EV_KEY write."""
    def __init__(self, fail_on_key=None):
        self.events, self.keys, self.fail_on_key = [], 0, fail_on_key

    def write(self, etype, code, value):
        if etype == EV_KEY:
            self.keys += 1
            if self.fail_on_key is not None and self.keys == self.fail_on_key:
                raise OSError("injected write failure")
        self.events.append((etype, code, value))

    def key_events(self):
        return [(c, v) for (t, c, v) in self.events if t == EV_KEY]


def keyboard(fail_on_key=None):
    rec, sleeps = Recorder(fail_on_key), []
    return kt.Keyboard(rec.write, sleep=sleeps.append), rec, sleeps


class ChordTable(unittest.TestCase):
    def test_shared_fixture(self):
        with open(os.path.join(HERE, "fixtures", "chords.json"), encoding="utf-8") as f:
            table = json.load(f)
        for row in table:
            if "out" in row:
                self.assertEqual("+".join(kt.parse_chord(row["in"])), row["out"], row["in"])
            else:
                with self.assertRaises(kt.ChordError, msg=row["in"]) as cm:
                    kt.parse_chord(row["in"])
                self.assertEqual(str(cm.exception), row["err"], row["in"])

    def test_codes(self):
        self.assertEqual(kt.CODES["RightAlt"], 100)
        self.assertEqual(kt.CODES["Q"], 16)
        self.assertEqual(kt.CODES["M"], 50)
        self.assertEqual(kt.CODES["0"], 11)
        self.assertEqual(kt.CODES["F10"], 68)
        self.assertEqual(kt.CODES["F13"], 183)
        self.assertEqual(kt.CODES["F24"], 194)
        self.assertEqual(len(kt.CODES), 8 + 26 + 10 + 1 + 24)


class EventOrder(unittest.TestCase):
    def test_single_key_is_press_syn_release_syn(self):
        kb, rec, sleeps = keyboard()
        kb.tap(kt.parse_chord("RightAlt"))
        self.assertEqual(rec.events, [(EV_KEY, 100, 1), (EV_SYN, 0, 0), (EV_KEY, 100, 0), (EV_SYN, 0, 0)])
        self.assertEqual(sleeps, [0.08])

    def test_modifiers_only_keeps_written_order_and_releases_in_reverse(self):
        kb, rec, sleeps = keyboard()
        kb.tap(kt.parse_chord("RightAlt+RightShift"))
        self.assertEqual(rec.key_events(), [(100, 1), (54, 1), (54, 0), (100, 0)])
        self.assertEqual(sleeps, [0.03, 0.08, 0.03])

    def test_main_key_is_the_trigger_wherever_it_was_written(self):
        kb, rec, _ = keyboard()
        kb.tap(kt.parse_chord("space+rightctrl"))
        self.assertEqual(rec.key_events(), [(97, 1), (57, 1), (57, 0), (97, 0)])

    def test_four_name_chord_stays_under_400_ms(self):
        kb, _, sleeps = keyboard()
        kb.tap(kt.parse_chord("LeftCtrl+LeftAlt+LeftShift+A"))
        self.assertLessEqual(sum(sleeps), 0.4)


class ReleaseOnFailure(unittest.TestCase):
    def test_write_failure_mid_chord_releases_every_pressed_key(self):
        kb, rec, _ = keyboard(fail_on_key=2)   # RightCtrl down succeeds, Space down raises
        with self.assertRaises(OSError):
            kb.tap(kt.parse_chord("RightCtrl+Space"))
        self.assertEqual(rec.key_events(), [(97, 1), (57, 0), (97, 0)])
        self.assertEqual(kb.down, [])

    def test_process_reports_err_write(self):
        kb, _, _ = keyboard(fail_on_key=1)
        self.assertTrue(kt.process("tap RightAlt", kb).startswith("err write "))

    def test_close_releases_keys_left_down(self):
        rec, destroyed = Recorder(), []
        kb = kt.Keyboard(rec.write, sleep=lambda s: None, destroy=lambda: destroyed.append(True))
        kb.down = ["RightAlt"]
        kb.close()
        self.assertEqual(rec.key_events(), [(100, 0)])
        self.assertEqual(destroyed, [True])


class FakeKb:
    def __init__(self, fail=False):
        self.taps, self.fail = [], fail

    def tap(self, names):
        if self.fail:
            raise OSError("injected")
        self.taps.append("+".join(names))

    def close(self):
        pass


class Protocol(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "k.sock")

    def start(self, kb=None, stale=False):
        if stale:
            with open(self.path, "w") as f:
                f.write("stale")
        self.kb = kb or FakeKb()
        ready = threading.Event()
        threading.Thread(target=kt.serve, args=(self.path, self.kb, ready), daemon=True).start()
        self.assertTrue(ready.wait(2))

    def raw(self, payload, wait=2.0):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.path)
        if payload:
            s.sendall(payload)
        s.settimeout(wait)
        t0 = time.monotonic()
        data = b""
        try:
            while not data.endswith(b"\n"):
                chunk = s.recv(256)
                if not chunk:
                    break
                data += chunk
        finally:
            s.close()
        return data.decode(), time.monotonic() - t0

    def test_tap_ping_and_reject(self):
        self.start()
        self.assertEqual(kt.client("tap rightalt+rightshift", self.path), 0)
        self.assertEqual(self.kb.taps, ["RightAlt+RightShift"])
        self.assertEqual(kt.client("ping", self.path), 0)
        self.assertEqual(self.kb.taps, ["RightAlt+RightShift"], "ping sends no key")
        self.assertEqual(kt.client("tap Enter", self.path), 2)
        self.assertEqual(self.raw(b"hello\n")[0], "err reject unknown request\n")

    def test_read_deadline_is_500_ms_and_the_next_client_is_served(self):
        self.start()
        reply, took = self.raw(b"")
        self.assertEqual(reply, "err reject timeout\n")
        self.assertGreaterEqual(took, 0.4)
        self.assertLess(took, 0.9)
        self.assertEqual(kt.client("ping", self.path), 0)

    def test_request_over_128_bytes_is_rejected(self):
        self.start()
        self.assertEqual(self.raw(b"x" * 200)[0], "err reject too long\n")
        self.assertEqual(self.raw(b"tap " + b"A" * 123 + b"\n")[0].split(" ")[0:2], ["err", "reject"])  # 128 bytes, parsed
        self.assertEqual(self.raw(b"ping\n")[0], "ok\n")

    def test_stale_socket_file_is_replaced_and_mode_is_0600(self):
        self.start(stale=True)
        self.assertEqual(kt.client("ping", self.path), 0)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)


class ClientExitCodes(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "k.sock")

    def test_3_when_no_socket(self):
        self.assertEqual(kt.client("ping", self.path), 3)

    def test_4_on_err_write(self):
        ready = threading.Event()
        threading.Thread(target=kt.serve, args=(self.path, FakeKb(fail=True), ready), daemon=True).start()
        self.assertTrue(ready.wait(2))
        self.assertEqual(kt.client("tap RightAlt", self.path), 4)

    def test_5_when_the_server_accepts_and_never_replies(self):
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(self.path)
        srv.listen(1)          # never accept(): the connection sits in the backlog and no reply ever comes
        t0 = time.monotonic()
        self.assertEqual(kt.client("ping", self.path, timeout=0.3), 5)
        self.assertLess(time.monotonic() - t0, 1.0)
        srv.close()

    def test_5_when_the_connection_breaks(self):
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(self.path)
        srv.listen(1)

        def accept_and_close():
            c, _ = srv.accept()
            c.close()
        threading.Thread(target=accept_and_close, daemon=True).start()
        self.assertEqual(kt.client("ping", self.path), 5)
        srv.close()

    def test_default_reply_timeout_is_1_5_s(self):
        self.assertEqual(kt.REPLY_TIMEOUT, 1.5)

    def test_a_newline_inside_the_chord_is_rejected_locally(self):
        self.assertEqual(kt.client("tap Right\nAlt", self.path), 2)


class SocketPath(unittest.TestCase):
    def test_xdg_runtime_dir(self):
        old = os.environ.get("XDG_RUNTIME_DIR")
        try:
            os.environ["XDG_RUNTIME_DIR"] = "/run/user/4242"
            self.assertEqual(kt.sock_path(), "/run/user/4242/omaremote-keytap.sock")
            del os.environ["XDG_RUNTIME_DIR"]          # review focus 4: unset falls back to /run/user/<uid>
            self.assertEqual(kt.sock_path(), "/run/user/%d/omaremote-keytap.sock" % os.getuid())
        finally:
            if old is None:
                os.environ.pop("XDG_RUNTIME_DIR", None)
            else:
                os.environ["XDG_RUNTIME_DIR"] = old


class Usage(unittest.TestCase):
    def test_bad_arguments_exit_64(self):
        self.assertEqual(kt.main(["omaremote-keytap"]), 64)
        self.assertEqual(kt.main(["omaremote-keytap", "tap"]), 64)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python3 -I tests/test_keytap.py`
Expected: an error loading `host/omaremote-keytap`: `FileNotFoundError`.

- [ ] **Step 3: Implement** `host/omaremote-keytap`

```python
#!/usr/bin/env python3
"""omaremote-keytap: one persistent uinput keyboard that taps Typeless's dictation hotkey on request.

Typeless reads raw evdev and opens only devices that look like full keyboards, within ~2 s of their creation, so
this device advertises every key code and lives for the whole session (Typeless spec §2.1-§2.2). Only the allowlist
below is ever sent (§4.2).

  omaremote-keytap serve          create the device and serve $XDG_RUNTIME_DIR/omaremote-keytap.sock
  omaremote-keytap tap <chord>    exit 0 sent, 2 rejected, 3 no daemon, 4 write failed (unknown), 5 no reply (unknown)
  omaremote-keytap ping           same exit codes; sends no key

Spec: docs/superpowers/specs/2026-10-13-typeless-engine-design.md §3.1, §4. Stdlib only; run with python3 -I."""
import fcntl
import os
import select
import signal
import socket
import struct
import sys
import time

MODIFIERS = {"LeftCtrl": 29, "RightCtrl": 97, "LeftShift": 42, "RightShift": 54,
             "LeftAlt": 56, "RightAlt": 100, "LeftMeta": 125, "RightMeta": 126}
MAIN = {"Space": 57}
for _i, _c in enumerate("QWERTYUIOP"):
    MAIN[_c] = 16 + _i
for _i, _c in enumerate("ASDFGHJKL"):
    MAIN[_c] = 30 + _i
for _i, _c in enumerate("ZXCVBNM"):
    MAIN[_c] = 44 + _i
for _d in range(1, 10):
    MAIN[str(_d)] = 1 + _d
MAIN["0"] = 11
for _n in range(1, 11):
    MAIN["F%d" % _n] = 58 + _n
MAIN["F11"], MAIN["F12"] = 87, 88
for _n in range(13, 25):
    MAIN["F%d" % _n] = 170 + _n
CODES = dict(MODIFIERS, **MAIN)
ALIASES = {"leftsuper": "LeftMeta", "rightsuper": "RightMeta", "leftwin": "LeftMeta", "rightwin": "RightMeta",
           "leftcontrol": "LeftCtrl", "rightcontrol": "RightCtrl"}
CANON = {name.lower(): name for name in CODES}
CANON.update(ALIASES)

EV_SYN, EV_KEY, SYN_REPORT = 0, 1, 0
EVENT = "llHHi"                                   # struct input_event on 64-bit Linux
UI_SET_EVBIT, UI_SET_KEYBIT = 0x40045564, 0x40045565
UI_DEV_SETUP, UI_DEV_CREATE, UI_DEV_DESTROY = 0x405C5503, 0x5501, 0x5502
BUS_VIRTUAL = 0x06
DEVICE_NAME = b"omaremote keytap"
READ_DEADLINE, MAX_REQUEST, REPLY_TIMEOUT = 0.5, 128, 1.5
PRESS_GAP, TRIGGER_HOLD = 0.03, 0.08


class ChordError(ValueError):
    pass


def parse_chord(text):
    """Return the names in tap order (modifiers as written, then the main key). Mirrors lib/Chord.mjs."""
    parts = text.split("+")
    if len(parts) > 4:
        raise ChordError("too many names")
    names = []
    for p in parts:
        if p == "":
            raise ChordError("empty name")
        c = CANON.get(p.lower())
        if c is None:
            raise ChordError("unknown name: " + p)
        if c in names:
            raise ChordError("duplicate name: " + c)
        names.append(c)
    mains = [n for n in names if n in MAIN]
    if len(mains) > 1:
        raise ChordError("two main keys")
    return [n for n in names if n in MODIFIERS] + mains


class Keyboard:
    """Writes key events through `write(type, code, value)`. Every key it presses is released before tap() returns
    or raises, and again by close(); `down` lists keys that may still be held."""

    def __init__(self, write, sleep=time.sleep, destroy=None):
        self.write, self.sleep, self._destroy, self.down = write, sleep, destroy, []

    @classmethod
    def open(cls, path):
        fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
        for code in range(1, 249):                # a full keyboard, or Typeless never opens it (§2.2)
            fcntl.ioctl(fd, UI_SET_KEYBIT, code)
        fcntl.ioctl(fd, UI_DEV_SETUP, struct.pack("HHHH80sI", BUS_VIRTUAL, 0, 0, 1, DEVICE_NAME, 0))
        fcntl.ioctl(fd, UI_DEV_CREATE)

        def write(etype, code, value):
            os.write(fd, struct.pack(EVENT, 0, 0, etype, code, value))

        def destroy():
            try:
                fcntl.ioctl(fd, UI_DEV_DESTROY)
            finally:
                os.close(fd)
        return cls(write, destroy=destroy)

    def _key(self, name, value):
        self.write(EV_KEY, CODES[name], value)
        self.write(EV_SYN, SYN_REPORT, 0)

    def tap(self, names):
        others, trigger = names[:-1], names[-1]
        try:
            for k in others:
                self.down.append(k)               # recorded before the write: a half-written press is still released
                self._key(k, 1)
                self.sleep(PRESS_GAP)
            self.down.append(trigger)
            self._key(trigger, 1)
            self.sleep(TRIGGER_HOLD)
            self._key(trigger, 0)
            self.down.remove(trigger)
            for k in reversed(others):
                self.sleep(PRESS_GAP)
                self._key(k, 0)
                self.down.remove(k)
        finally:
            self.release_all()

    def release_all(self):
        for k in reversed(self.down):
            try:
                self._key(k, 0)
            except OSError:
                pass
        self.down = []

    def close(self):
        self.release_all()
        if self._destroy:
            self._destroy()


def sock_path():
    base = os.environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid()
    return os.path.join(base, "omaremote-keytap.sock")


def process(line, kb):
    if line == "ping":
        return "ok"
    if line.startswith("tap "):
        try:
            names = parse_chord(line[4:])
        except ChordError as e:
            return "err reject %s" % e
        try:
            kb.tap(names)
        except OSError as e:
            return "err write %s" % e
        return "ok"
    return "err reject unknown request"


def _read_request(conn):
    deadline = time.monotonic() + READ_DEADLINE
    buf = b""
    while b"\n" not in buf[:MAX_REQUEST]:
        if len(buf) >= MAX_REQUEST:
            return None, "err reject too long"
        left = deadline - time.monotonic()
        if left <= 0 or not select.select([conn], [], [], left)[0]:
            return None, "err reject timeout"
        chunk = conn.recv(MAX_REQUEST + 1 - len(buf))
        if not chunk:
            return None, None                    # the client went away: nothing to answer
        buf += chunk
    return buf.split(b"\n", 1)[0].decode("utf-8", "replace"), None


def _handle(conn, kb):
    line, early = _read_request(conn)
    reply = early if line is None else process(line, kb)
    if reply is not None:
        try:
            conn.sendall((reply + "\n").encode())
        except OSError:
            pass


def serve(path, kb, ready=None):
    """One connection at a time; a stuck client costs the next one at most READ_DEADLINE."""
    try:
        os.unlink(path)                           # a stale socket from a crashed run
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        srv.bind(path)
    finally:
        os.umask(old)
    os.chmod(path, 0o600)
    srv.listen(8)
    if ready is not None:
        ready.set()
    try:
        while True:
            conn, _ = srv.accept()
            with conn:
                _handle(conn, kb)
    finally:
        kb.close()
        srv.close()
        try:
            os.unlink(path)
        except OSError:
            pass


def client(line, path=None, timeout=REPLY_TIMEOUT):
    if "\n" in line:
        return 2
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        try:
            s.connect(path or sock_path())
        except OSError:
            return 3
        deadline = time.monotonic() + timeout
        buf = b""
        try:
            s.sendall((line + "\n").encode())
            while b"\n" not in buf:
                left = deadline - time.monotonic()
                if left <= 0:
                    return 5
                s.settimeout(left)
                chunk = s.recv(256)
                if not chunk:
                    return 5
                buf += chunk
        except OSError:                           # includes socket.timeout
            return 5
        reply = buf.split(b"\n", 1)[0].decode("utf-8", "replace")
        if reply == "ok":
            return 0
        if reply.startswith("err reject"):
            print(reply, file=sys.stderr)
            return 2
        if reply.startswith("err write"):
            print(reply, file=sys.stderr)
            return 4
        return 5
    finally:
        s.close()


def main(argv):
    if len(argv) == 2 and argv[1] == "serve":
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))   # SystemExit unwinds through tap()'s finally
        serve(sock_path(), Keyboard.open(os.environ.get("OMAREMOTE_UINPUT", "/dev/uinput")))
        return 0
    if len(argv) == 3 and argv[1] == "tap":
        return client("tap " + argv[2])
    if len(argv) == 2 and argv[1] == "ping":
        return client("ping")
    print("usage: omaremote-keytap serve | tap <chord> | ping", file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

Then: `chmod 0755 host/omaremote-keytap`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -I tests/test_keytap.py -v`
Expected: `OK`, 21 tests. In `test_request_over_128_bytes_is_rejected`, the second request is exactly 128 bytes,
newline included. It must be *read and parsed*: its reply is `err reject unknown name: AAA…`, not
`err reject too long`.

- [ ] **Step 5: Wire it into `make check`.** In `Makefile`, in the `check:` recipe, add after `bash tests/matrix-helpers.sh`:

```make
	python3 -I tests/test_keytap.py
```

Run: `make check; echo MAKE_CHECK_EXIT=$?`
Expected: `MAKE_CHECK_EXIT=0`.

- [ ] **Step 6: Commit**

```bash
git add host/omaremote-keytap tests/test_keytap.py Makefile
git commit -m "feat(typeless): omaremote-keytap uinput daemon and client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---

### Task 3: Config — `voice.engine` and `voice.typeless.hotkey`

**Files:**
- Modify: `lib/Defaults.mjs` (export two constants; `DEFAULT_VOICE` unchanged)
- Modify: `lib/Config.mjs:93-98` (voice normalization)
- Test: `tests/Config.test.mjs`

**Interfaces:**
- Consumes: `canonicalChord`, `parseChord` (Task 1).
- Produces:
  - `DEFAULT_ENGINE = "voxtype"` and `DEFAULT_TYPELESS_HOTKEY = "RightAlt"`.
  - After `normalizeConfig`, `config.voice.engine` is `"voxtype" | "typeless"` and `config.voice.typeless.hotkey` is a
    canonical chord.
  - The problem code `typeless-hotkey-invalid`.

- [ ] **Step 1: Write the failing tests** (append to `tests/Config.test.mjs`; it already imports `normalizeConfig` and
  `DEFAULT_CONFIG`)

```js
test("voice.engine defaults to voxtype and only the exact string typeless selects Typeless", () => {
  const n = (v) => normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, engine: v } }).config.voice.engine;
  assert.equal(normalizeConfig(DEFAULT_CONFIG).config.voice.engine, "voxtype");
  assert.equal(n("typeless"), "typeless");
  for (const junk of ["Typeless", "voxtype ", 1, null, {}, undefined]) assert.equal(n(junk), "voxtype", JSON.stringify(junk));
});

test("voice.typeless.hotkey defaults to RightAlt and is stored canonical", () => {
  const n = (h) => normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, typeless: { hotkey: h } } });
  assert.equal(normalizeConfig(DEFAULT_CONFIG).config.voice.typeless.hotkey, "RightAlt");
  assert.equal(n("rightalt+rightshift").config.voice.typeless.hotkey, "RightAlt+RightShift");
  assert.equal(n("space+rightctrl").config.voice.typeless.hotkey, "RightCtrl+Space");
  assert.deepEqual(n("RightAlt").problems, []);
});

test("an invalid stored hotkey normalizes to RightAlt with a typeless-hotkey-invalid problem", () => {
  const { config, problems } = normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, typeless: { hotkey: "Alt+Q" } } });
  assert.equal(config.voice.typeless.hotkey, "RightAlt");
  const p = problems.find(x => x.code === "typeless-hotkey-invalid");
  assert.ok(p, "problem reported");
  assert.match(p.message, /unknown name: Alt/);
});

test("the shipped defaults never write engine or typeless into config.json (hotkeyStored stays meaningful)", () => {
  assert.equal("engine" in DEFAULT_CONFIG.voice, false);
  assert.equal("typeless" in DEFAULT_CONFIG.voice, false);
});

test("unknown fields under voice.typeless survive normalization", () => {
  const { config } = normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, typeless: { hotkey: "RightAlt", future: 1 } } });
  assert.equal(config.voice.typeless.future, 1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/Config.test.mjs`
Expected: FAIL. `config.voice.engine` is `undefined`, and so is `config.voice.typeless`.

- [ ] **Step 3: Implement.** In `lib/Defaults.mjs`, add after `DEFAULT_VOICE`:

```js
// Typeless spec §3. Deliberately outside DEFAULT_VOICE: DEFAULT_CONFIG is what a first run writes to config.json,
// and `omaremote-setup typeless` adopts Typeless's own hotkey only while voice.typeless.hotkey is absent there.
export const DEFAULT_ENGINE = "voxtype";
export const DEFAULT_TYPELESS_HOTKEY = "RightAlt";
```

In `lib/Config.mjs`:
- change the first import to:

```js
import { DEFAULT_CONFIG, DEFAULT_KEYS, DEFAULT_TIMING, DEFAULT_VOICE, KEY_NAMES, DEFAULT_ENGINE, DEFAULT_TYPELESS_HOTKEY } from "./Defaults.mjs";
import { parseChord } from "./Chord.mjs";
```

- add after `config.voice.remoteOnDemand = v.remoteOnDemand === true;`:

```js
  config.voice.engine = v.engine === "typeless" ? "typeless" : DEFAULT_ENGINE;
  const tl = isObj(v.typeless) ? v.typeless : {};
  config.voice.typeless = Object.assign({}, tl);               // preserve unknown fields
  if (tl.hotkey === undefined) config.voice.typeless.hotkey = DEFAULT_TYPELESS_HOTKEY;
  else {
    const r = parseChord(tl.hotkey);
    if (r.ok) config.voice.typeless.hotkey = r.canonical;
    else {
      problems.push({ code: "typeless-hotkey-invalid", message: `voice.typeless.hotkey "${tl.hotkey}": ${r.reason}; using ${DEFAULT_TYPELESS_HOTKEY}` });
      config.voice.typeless.hotkey = DEFAULT_TYPELESS_HOTKEY;
    }
  }
```

- [ ] **Step 4: Run all unit tests**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, with no regressions in the other suites.

- [ ] **Step 5: Commit**

```bash
git add lib/Defaults.mjs lib/Config.mjs tests/Config.test.mjs
git commit -m "feat(typeless): voice.engine and voice.typeless.hotkey config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---
### Task 4: `lib/ConfigWrites.mjs` — serialized writes and watcher reconcile (pure)

**Files:**
- Create: `lib/ConfigWrites.mjs`
- Create: `tests/ConfigWrites.test.mjs`
- Modify: `tests/harness/ModuleLoad.qml`

**Interfaces:**
- Produces:
  - `MAX_PENDING = 8` and `KEEP = 16`.
  - `createConfigWrites()` returns:
    - `request(text) → { ok: true, seq, effects } | { ok: false, reason, effects: [] }`;
    - `saved(seq) → effects`, `failed(seq, reason) → effects`, `notify() → effects`. A report for a seq that is not
      the one in flight resolves nothing: it is a late answer to a write already resolved, e.g. by the save watchdog.
    - `inFlightSeq() → number` (0 when idle);
    - `diskRead(text, memText) → boolean` (true means adopt the disk text as an external change);
    - `busy() → boolean`;
    - `saves() → { "<seq>": "pending"|"saved"|"failed" }` and `errors() → { "<seq>": reason }`;
    - `lastCarrying(pred) → { seq, state } | null`.
  - Effects are `{ type: "setText", seq, text }` and `{ type: "reload" }`.
  - `hotkeyWritePlan(storedCanonical, requested, last) → { write: boolean, seq: number|null }`.
  - Task 5 drives FileView with these. It gives every write its own FileView object, so `saved`/`saveFailed` arrive
    tagged with that write's seq and the attribution never depends on order.

- [ ] **Step 1: Write the failing tests** `tests/ConfigWrites.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfigWrites, hotkeyWritePlan, MAX_PENDING, KEEP } from "../lib/ConfigWrites.mjs";

const T = (hotkey) => JSON.stringify({ voice: { typeless: { hotkey } } }) + "\n";
const hk = (text) => JSON.parse(text).voice.typeless.hotkey;
const sets = (fx) => fx.filter(e => e.type === "setText");
const reloads = (fx) => fx.filter(e => e.type === "reload").length;
// FileView reports a write's outcome on that write's own object, so a report always names its seq.
const ok = (w) => w.saved(w.inFlightSeq());

test("writes go out one at a time in FIFO order, and each report resolves exactly its own seq", () => {
  const w = createConfigWrites();
  const a = w.request("A"), b = w.request("B"), c = w.request("C");
  assert.deepEqual(sets(a.effects), [{ type: "setText", seq: a.seq, text: "A" }]);
  assert.deepEqual(b.effects, [], "B waits behind A");
  assert.deepEqual(c.effects, []);
  assert.equal(w.inFlightSeq(), a.seq);
  assert.deepEqual(sets(w.saved(a.seq)), [{ type: "setText", seq: b.seq, text: "B" }]);
  assert.deepEqual(w.saves(), { [a.seq]: "saved", [b.seq]: "pending", [c.seq]: "pending" });
  assert.deepEqual(sets(w.saved(b.seq)), [{ type: "setText", seq: c.seq, text: "C" }]);
  assert.deepEqual(w.saved(c.seq), []);
  assert.equal(w.busy(), false);
  assert.equal(w.inFlightSeq(), 0);
  assert.deepEqual(w.saves(), { [a.seq]: "saved", [b.seq]: "saved", [c.seq]: "saved" });
});

test("a report for a seq that is not in flight resolves nothing", () => {
  const w = createConfigWrites();
  const a = w.request("A"), b = w.request("B");
  assert.deepEqual(w.saved(b.seq), [], "B is queued, not in flight");
  assert.deepEqual(w.saved(99), [], "never issued");
  assert.equal(w.saves()[a.seq], "pending");
  assert.equal(w.saves()[b.seq], "pending");
  assert.equal(w.inFlightSeq(), a.seq);
});

test("A times out (watchdog) → B starts → A's late saved is ignored and B resolves only on its own report", () => {
  const w = createConfigWrites();
  const a = w.request("A"), b = w.request("B");
  const fx = w.failed(a.seq, "no save confirmation");      // the watchdog's verdict
  assert.deepEqual(sets(fx), [{ type: "setText", seq: b.seq, text: "B" }]);
  assert.deepEqual(w.saved(a.seq), [], "A's late saved names A, which is no longer in flight");
  assert.equal(w.saves()[a.seq], "failed");
  assert.equal(w.saves()[b.seq], "pending", "B is not marked saved by A's signal");
  assert.equal(reloads(w.saved(b.seq)), 1, "B saved; A's failure still forces the reconcile");
  assert.equal(w.saves()[b.seq], "saved");
});

test("writes are never merged: B saved means B's own text reached disk, even though C later replaced it", () => {
  const w = createConfigWrites();
  let disk = "";
  const apply = (fx) => { for (const e of sets(fx)) disk = e.text; };
  const a = w.request(T("RightAlt")); apply(a.effects);
  const b = w.request(T("RightAlt+RightShift"));        // B carries X
  const c = w.request(T("RightCtrl+Space"));            // C carries Y
  apply(w.saved(a.seq));                                // A done, B written
  assert.equal(hk(disk), "RightAlt+RightShift", "B's own text was what reached disk");
  apply(w.saved(b.seq));                                // B done, C written
  assert.equal(w.saves()[b.seq], "saved");
  w.saved(c.seq);
  assert.notEqual(hk(disk), "RightAlt+RightShift", "setup's disk re-read sees Y and reports 'changed again'");
});

test("a failure marks exactly its own seq and the next write still goes out", () => {
  const w = createConfigWrites();
  const a = w.request("A"), b = w.request("B");
  const fx = w.failed(a.seq, "EACCES");
  assert.deepEqual(sets(fx), [{ type: "setText", seq: b.seq, text: "B" }]);
  assert.equal(w.saves()[a.seq], "failed");
  assert.equal(w.saves()[b.seq], "pending");
  assert.deepEqual(w.errors(), { [a.seq]: "EACCES" });
});

test("at most 8 writes may be pending, the in-flight one included; a ninth fails without consuming a seq", () => {
  const w = createConfigWrites();
  const seqs = [];
  for (let i = 0; i < MAX_PENDING; i++) { const r = w.request("t" + i); assert.equal(r.ok, true); seqs.push(r.seq); }
  const ninth = w.request("t8");
  assert.deepEqual(ninth, { ok: false, reason: "too many pending config writes", effects: [] });
  ok(w);
  assert.equal(w.request("t9").seq, seqs[seqs.length - 1] + 1);
});

test("a late watcher notification after our own writes re-reads, finds memory, and adopts nothing", () => {
  const w = createConfigWrites();
  const a = w.request("A");
  assert.deepEqual(w.notify(), [], "while busy a notification only marks dirty");
  assert.equal(reloads(w.saved(a.seq)), 1, "the reconcile runs once the queue drains");
  assert.equal(w.diskRead("A", "A"), false);
  assert.equal(reloads(w.notify()), 1, "a notification while idle re-reads at once");
  assert.equal(w.diskRead("A", "A"), false, "the disk holds our latest text: no external change");
});

test("save X, save Y, then an external edit back to X: the re-read adopts X (no text-history rule)", () => {
  const w = createConfigWrites();
  const X = T("RightCtrl+Space"), Y = T("RightAlt+RightShift");
  w.request(X); ok(w);
  w.request(Y); ok(w);
  assert.equal(reloads(w.notify()), 1);
  assert.equal(w.diskRead(X, Y), true, "X differs from memory (Y): adopt it");
});

test("notifications during a write only mark dirty; exactly one reconcile follows the last write", () => {
  const w = createConfigWrites();
  w.request("A"); w.request("B");
  assert.deepEqual(w.notify(), []);
  assert.deepEqual(w.notify(), []);
  const mid = ok(w);
  assert.equal(reloads(mid), 0, "B is still to go: no re-read yet");
  assert.equal(sets(mid).length, 1);
  assert.equal(reloads(ok(w)), 1);
  assert.equal(reloads(w.saved(1)), 0, "a stray report with nothing in flight does nothing");
});

test("a disk read that lands while a write is pending is not adopted, and forces a reconcile after the drain", () => {
  const w = createConfigWrites();
  w.request("A");
  assert.equal(w.diskRead("OLD", "A"), false);
  assert.equal(reloads(ok(w)), 1);
});

test("a failed last write triggers a reconcile, which adopts the disk text", () => {
  const w = createConfigWrites();
  const a = w.request("A");
  assert.equal(reloads(w.failed(a.seq, "ENOSPC")), 1);
  assert.equal(w.diskRead("OLD", "A"), true);
});

test("saves() keeps the last 16 outcomes", () => {
  const w = createConfigWrites();
  for (let i = 0; i < 20; i++) { w.request("t" + i); ok(w); }
  const keys = Object.keys(w.saves()).map(Number);
  assert.equal(keys.length, KEEP);
  assert.equal(Math.min(...keys), 5);
});

test("lastCarrying finds the newest write whose text satisfies the predicate", () => {
  const w = createConfigWrites();
  w.request(T("RightAlt")); ok(w);
  w.request(T("RightCtrl+Space"));
  assert.deepEqual(w.lastCarrying(t => hk(t) === "RightCtrl+Space"), { seq: 2, state: "pending" });
  assert.deepEqual(w.lastCarrying(t => hk(t) === "RightAlt"), { seq: 1, state: "saved" });
  assert.equal(w.lastCarrying(t => hk(t) === "LeftAlt"), null);
});

test("hotkeyWritePlan: equal value pending → that seq; failed → write again; saved or from disk → null; different → write", () => {
  assert.deepEqual(hotkeyWritePlan("RightAlt", "RightAlt", { seq: 4, state: "pending" }), { write: false, seq: 4 });
  assert.deepEqual(hotkeyWritePlan("RightAlt", "RightAlt", { seq: 4, state: "failed" }), { write: true, seq: null });
  assert.deepEqual(hotkeyWritePlan("RightAlt", "RightAlt", { seq: 4, state: "saved" }), { write: false, seq: null });
  assert.deepEqual(hotkeyWritePlan("RightAlt", "RightAlt", null), { write: false, seq: null });
  assert.deepEqual(hotkeyWritePlan("RightAlt", "LeftAlt", null), { write: true, seq: null });
  assert.deepEqual(hotkeyWritePlan(undefined, "RightAlt", null), { write: true, seq: null });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/ConfigWrites.test.mjs`
Expected: FAIL with `Cannot find module '…/lib/ConfigWrites.mjs'`.

- [ ] **Step 3: Implement** `lib/ConfigWrites.mjs`

```js
// Typeless spec §4.3: serialized, never-merged config writes, and watcher notifications that only trigger a re-read.
// Pure: ConfigStore.qml performs the effects ({type:"setText", seq, text}, {type:"reload"}) and reports each write's
// outcome by seq; one FileView per write gives the signals that identity. Exactly one write is in flight. A report for
// a seq that is not in flight is a late answer to a write already resolved (e.g. failed by the save watchdog).
export const MAX_PENDING = 8;     // in flight + queued
export const KEEP = 16;           // outcomes published as status.configWrites

export function createConfigWrites() {
  let seq = 0;
  const queue = [];               // [{ seq, text }]; queue[0] is in flight while `inFlight`
  let inFlight = false;
  let dirty = false;              // a watcher event or a failure happened while busy: re-read once idle
  const log = [];                 // [{ seq, text, state, reason }], oldest first, at most KEEP

  const busy = () => inFlight || queue.length > 0;
  function startNext() {
    if (inFlight || queue.length === 0) return [];
    inFlight = true;
    return [{ type: "setText", seq: queue[0].seq, text: queue[0].text }];
  }
  function resolve(s, state, reason) {
    if (!inFlight || queue[0].seq !== s) return [];   // not the write in flight: a late answer resolves nothing
    const w = queue.shift();
    inFlight = false;
    for (const e of log) if (e.seq === w.seq) { e.state = state; e.reason = reason; }
    if (state === "failed") dirty = true;         // memory may now be ahead of disk
    const out = startNext();
    if (out.length === 0 && dirty) { dirty = false; out.push({ type: "reload" }); }
    return out;
  }

  return {
    request(text) {
      if (queue.length >= MAX_PENDING) return { ok: false, reason: "too many pending config writes", effects: [] };
      const s = ++seq;
      queue.push({ seq: s, text });
      log.push({ seq: s, text, state: "pending", reason: "" });
      while (log.length > KEEP) log.shift();
      return { ok: true, seq: s, effects: startNext() };
    },
    saved(s) { return resolve(s, "saved", ""); },
    failed(s, reason) { return resolve(s, "failed", String(reason)); },
    inFlightSeq() { return inFlight ? queue[0].seq : 0; },
    notify() {
      if (busy()) { dirty = true; return []; }
      return [{ type: "reload" }];
    },
    // Equal text cannot tell who wrote a file, so there is no history check: once idle, the current disk text
    // either equals memory (nothing to do, including a late echo of our own write) or is adopted.
    diskRead(text, memText) {
      if (busy()) { dirty = true; return false; }
      return text !== memText;
    },
    busy,
    saves() { const o = {}; for (const e of log) o[String(e.seq)] = e.state; return o; },
    errors() { const o = {}; for (const e of log) if (e.state === "failed") o[String(e.seq)] = e.reason; return o; },
    lastCarrying(pred) {
      for (let i = log.length - 1; i >= 0; i--) if (pred(log[i].text)) return { seq: log[i].seq, state: log[i].state };
      return null;
    },
  };
}

// §4.3: what `typelessHotkey <chord>` does. `last` is lastCarrying() for the requested value.
export function hotkeyWritePlan(storedCanonical, requested, last) {
  if (storedCanonical !== requested) return { write: true, seq: null };
  if (last && last.state === "pending") return { write: false, seq: last.seq };
  if (last && last.state === "failed") return { write: true, seq: null };
  return { write: false, seq: null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/ConfigWrites.test.mjs`
Expected: PASS, 14 tests.

- [ ] **Step 5: Add the module to the QML load check.** In `tests/harness/ModuleLoad.qml`, add the import
  `import "../../lib/ConfigWrites.mjs" as ConfigWrites` and this element to `checks`:

```js
            , ConfigWrites.createConfigWrites().request("{}").seq
```

Run: `make lint`
Expected: `module-load: ok`.

- [ ] **Step 6: Commit**

```bash
git add lib/ConfigWrites.mjs tests/ConfigWrites.test.mjs tests/harness/ModuleLoad.qml
git commit -m "feat(config): serialized config writes and watcher re-read reconcile (pure)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---

### Task 5: ConfigStore on ConfigWrites, plus the `typelessHotkey` IPC

**Files:**
- Modify: `components/ConfigStore.qml` (whole file)
- Modify: `Service.qml`:
  - imports;
  - `onConfigChanged` (lines 181-204);
  - `statusJson` (lines 607-634);
  - `IpcHandler` (lines 635-655).
- Modify: `tests/fake-remote.sh` (new scenarios before `# ---- summary`)

**Interfaces:**
- Consumes: `createConfigWrites` and `hotkeyWritePlan` (Task 4); `parseChord` and `canonicalChord` (Task 1); the config
  fields (Task 3).
- Produces:
  - ConfigStore gains:
    - `setVoiceEngine(name)`, which emits `changed("engine")`;
    - `setTypelessHotkey(chord) → seq` (0 on refusal), which emits `changed("hotkey")`;
    - the properties `saves`, `saveErrors` and `writes`;
    - `hotkeyOfText(text)`.
  - `_write(raw)` now returns a seq (0 on refusal) instead of a boolean.
  - Service gains:
    - the IPC `typelessHotkey(chord: string): string`;
    - the status fields `configWrites.saves`, `configWrites.errors`, `typeless.hotkey` and `typeless.hotkeyStored`.
  - Task 10 extends `typeless` in status, and the `onConfigChanged` branches for `engine` and `hotkey`.

- [ ] **Step 1: Write the failing integration scenarios.** Append to `tests/fake-remote.sh`, before
  `# ---- summary`:

```bash
# ---- Plan 5 Task 5: serialized config writes, typelessHotkey IPC ----
cfgfile() { echo "$XDG_CONFIG_HOME/omaremote/config.json"; }
wait_saved() {   # wait_saved <seq>
  wait_for ".configWrites.saves[\"$1\"]" saved 3
}
s_typeless_hotkey_written_and_confirmed() {
  wait_for '.config' true 5 || return 1
  [[ $(jget '.typeless.hotkeyStored') == false ]] || { echo "    a fresh config must not store a hotkey"; return 1; }
  local r seq; r=$(ipc typelessHotkey rightalt+rightshift)
  [[ $(jq -r '.ok' <<<"$r") == true && $(jq -r '.hotkey' <<<"$r") == RightAlt+RightShift ]] || { echo "    reply: $r"; return 1; }
  seq=$(jq -r '.writeSeq' <<<"$r"); [[ $seq =~ ^[0-9]+$ ]] || { echo "    no writeSeq: $r"; return 1; }
  wait_saved "$seq" || return 1
  [[ $(jq -r '.voice.typeless.hotkey' "$(cfgfile)") == RightAlt+RightShift ]] || return 1
  [[ $(jget '.typeless.hotkeyStored') == true ]] || return 1
  r=$(ipc typelessHotkey RightAlt+RightShift)                       # equal value, already saved
  [[ $(jq -r '.writeSeq' <<<"$r") == null ]] || { echo "    equal saved value must not write: $r"; return 1; }
}
scenario typeless_hotkey_written_and_confirmed s_typeless_hotkey_written_and_confirmed

s_typeless_hotkey_invalid_rejected() {
  wait_for '.config' true 5 || return 1
  local before; before=$(cat "$(cfgfile)")
  local r; r=$(ipc typelessHotkey Alt+Q)
  [[ $(jq -r '.ok' <<<"$r") == false && $(jq -r '.reason' <<<"$r") == "invalid chord: unknown name: Alt" ]] || { echo "    reply: $r"; return 1; }
  sleep 0.3
  [[ $(cat "$(cfgfile)") == "$before" ]] || { echo "    config.json changed"; return 1; }
  [[ $(jget '.typeless.hotkey') == RightAlt ]] || return 1
}
scenario typeless_hotkey_invalid_rejected s_typeless_hotkey_invalid_rejected

s_config_external_edit_back_to_earlier_value() {   # spec §4.3: X, Y, then an external edit back to X must win
  wait_for '.config' true 5 || return 1
  local s1 s2
  s1=$(ipc typelessHotkey RightCtrl+Space | jq -r '.writeSeq'); wait_saved "$s1" || return 1
  s2=$(ipc typelessHotkey RightAlt+RightShift | jq -r '.writeSeq'); wait_saved "$s2" || return 1
  local f; f=$(cfgfile)
  jq '.voice.typeless.hotkey = "RightCtrl+Space"' "$f" > "$F/c.json" && cat "$F/c.json" > "$f"
  wait_for '.typeless.hotkey' RightCtrl+Space 5
}
scenario config_external_edit_back_to_earlier_value s_config_external_edit_back_to_earlier_value
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bash tests/fake-remote.sh typeless_hotkey_written_and_confirmed; bash tests/fake-remote.sh config_external_edit_back_to_earlier_value`
Expected: both FAIL. `.typeless.hotkeyStored` is `null` because there is no such status field, and the IPC answers
that the method does not exist.

- [ ] **Step 3: Rewrite** `components/ConfigStore.qml`

```qml
// Spec §3 plugin-side files (config.json created with defaults on first run), §4.2 (unknown fields preserved),
// §6.2 (hot reload; the internal voice.mic commit reloads nothing), §8 (corrupt config → defaults, never overwritten).
// Typeless spec §4.3: writes are a serialized, never-merged FIFO (lib/ConfigWrites.mjs). Each write gets its own
// FileView object, so its saved/saveFailed names its seq and can never be credited to another write. The reading
// FileView only watches; a change notification only triggers a re-read of the current disk text once the queue is idle.
import QtQuick
import Quickshell.Io
import "../lib/ConfigFile.mjs" as ConfigFile
import "../lib/ConfigWrites.mjs" as ConfigWrites

Item {
  id: root
  required property string path
  property bool ready: false                   // parent directory exists (Service runs mkdir -p first)
  property var raw: null                       // file object as loaded, unknown fields intact
  property var config: null                    // normalized (lib/Config.mjs)
  property var problems: []
  property bool invalid: false
  property bool loaded: false
  signal changed(string kind)                  // load | external | keys | timing | voice | commit | reset-keys | engine | hotkey
  signal saveFailed(string reason)
  readonly property var writes: ConfigWrites.createConfigWrites()
  property var saves: ({})                     // seq → pending|saved|failed (last 16), published by status
  property var saveErrors: ({})                // seq → reason for failed writes
  property string _memText: ""                 // the text memory reflects: our newest requested write, or the disk text we adopted

  FileView {
    id: file
    path: root.ready ? root.path : ""
    watchChanges: true
    printErrors: false
    onLoaded: root._ingest(file.text(), false)
    onLoadFailed: function(error) { root._ingest("", error === FileViewError.FileNotFound) }
    onFileChanged: root._run(root.writes.notify())
  }
  // One FileView per write (measured with Quickshell 0.3.1, 2026-10-13: each instance answers its own setText with
  // saved, a file that does not exist yet included). blockAllReads: a writer never loads the file.
  Component {
    id: writerComponent
    FileView {
      property int seq: 0
      atomicWrites: true
      printErrors: false
      blockAllReads: true
      onSaved: { root._answer(seq, true, ""); destroy() }
      onSaveFailed: function(error) { root._answer(seq, false, String(error)); destroy() }
    }
  }
  // Every write must resolve, or the FIFO stalls and external edits are never adopted again. A write unanswered for
  // 3 s is counted as failed; if its writer answers later, that answer names a seq no longer in flight and is ignored.
  Timer {
    id: saveWatchdog; interval: 3000; repeat: false
    onTriggered: {
      var s = root.writes.inFlightSeq()
      if (s) { root.saveFailed("no save confirmation from FileView"); root._settle(root.writes.failed(s, "no save confirmation")) }
    }
  }
  // §3/§8: an in-place external edit (`cat new > config.json`) truncates then writes; the watcher can fire and be read
  // in that gap, landing an empty read that is NOT a real "file missing". Only the very first load, or a genuine
  // FileNotFound, may treat empty as "apply defaults" — any later empty read is transient: ignore it and retry once.
  property int _emptyRetries: 0
  Timer { id: reloadRetry; interval: 100; repeat: false; onTriggered: file.reload() }

  function _run(effects) {
    for (var i = 0; i < effects.length; i++) {
      var e = effects[i]
      if (e.type === "setText") {
        var w = writerComponent.createObject(root, { seq: e.seq, path: root.path })
        if (!w) { root._answer(e.seq, false, "could not create a writer"); continue }
        saveWatchdog.restart()
        w.setText(e.text)
      } else if (e.type === "reload") file.reload()
    }
  }
  function _answer(seq, ok, reason) {
    if (seq === root.writes.inFlightSeq()) saveWatchdog.stop()
    if (!ok) root.saveFailed(reason)
    root._settle(ok ? root.writes.saved(seq) : root.writes.failed(seq, reason))
  }
  function _settle(effects) {
    root.saves = root.writes.saves()
    root.saveErrors = root.writes.errors()
    root._run(effects)
  }

  function _ingest(text, createIfMissing) {
    if (root.loaded && !createIfMissing && text.trim() === "") {
      if (root._emptyRetries < 20) { root._emptyRetries++; reloadRetry.restart() }
      return
    }
    // Typeless §4.3: no echo bookkeeping. While our writes are pending this only marks the store dirty; once idle
    // the current disk text is adopted only when it differs from memory.
    if (root.loaded && !root.writes.diskRead(text, root._memText)) return
    root._emptyRetries = 0
    var r = ConfigFile.load(text)
    root.raw = r.raw; root.config = r.config; root.problems = r.problems; root.invalid = r.invalid
    var first = !root.loaded
    root.loaded = true
    root._memText = text
    // Deferred so the first write is not issued from inside the reading FileView's own loadFailed handler.
    if (r.missing && createIfMissing) Qt.callLater(function() { root._write(r.raw) })
    root.changed(first ? "load" : "external")
  }

  // Returns the write's seq, or 0 when nothing was written.
  function _write(raw) {
    if (root.invalid) { root.saveFailed("config.json is invalid; not overwriting it (§8)"); return 0 }
    var text = ConfigFile.serialize(raw)
    var w = root.writes.request(text)
    if (!w.ok) { root.saveFailed(w.reason); return 0 }
    var r = ConfigFile.load(text)
    root._memText = text
    root.raw = r.raw; root.config = r.config; root.problems = r.problems
    root._settle(w.effects)
    return w.seq
  }

  function hotkeyOfText(text) {
    try { var j = JSON.parse(text); return j && j.voice && j.voice.typeless ? j.voice.typeless.hotkey : undefined }
    catch (e) { return undefined }
  }

  function setVoiceMic(mode) { if (root._write(ConfigFile.withPatch(root.raw, ["voice", "mic"], mode))) root.changed("commit") }
  function setKey(name, fields) { if (root._write(ConfigFile.withKey(root.raw, name, fields))) root.changed("keys") }
  function setTiming(timing) { if (root._write(ConfigFile.withMerged(root.raw, ["timing"], timing))) root.changed("timing") }
  function setVoiceField(field, value) { if (root._write(ConfigFile.withPatch(root.raw, ["voice", field], value))) root.changed("voice") }
  function resetKeys() { if (root._write(ConfigFile.withDefaultKeys(root.raw))) root.changed("reset-keys") }
  function setVoiceEngine(name) { if (root._write(ConfigFile.withPatch(root.raw, ["voice", "engine"], name))) root.changed("engine") }
  function setTypelessHotkey(chord) {
    var s = root._write(ConfigFile.withPatch(root.raw, ["voice", "typeless", "hotkey"], chord))
    if (s) root.changed("hotkey")
    return s
  }
}
```

Three details in this file come from measuring Quickshell 0.3.1 on 2026-10-13 and from review. Keep all three:
- **One writer FileView per write.** FileView's `saved`/`saveFailed` carry no identity. With a single shared
  FileView, a watchdog that fails write A and starts B would let A's late `saved` mark B saved. Each writer object
  carries its seq, and `ConfigWrites` ignores a report for a seq that is not in flight.
- **The first-run create is deferred with `Qt.callLater`.** A `setText` issued from inside a FileView's own
  `loadFailed` handler was written but never answered with `saved`.
- **`saveWatchdog`.** Every write must resolve, or the FIFO stalls. A write unanswered for 3 s counts as failed, and
  the reconcile that follows re-reads the disk.

- [ ] **Step 4: Service: imports, config kinds, IPC and status.** In `Service.qml`:

Add these imports after `import "lib/Doctor.mjs" as Doctor`:

```qml
import "lib/Chord.mjs" as Chord
import "lib/ConfigWrites.mjs" as ConfigWrites
```

In `onConfigChanged(kind)`, add directly after the `if (kind === "load") { … }` line:

```js
    // Typeless spec §6.2: the engine switch commits through its own path (Task 10 applies it there), and a hotkey
    // change through IPC only refreshes the sessions' config. Neither reloads the key engine or aborts anything.
    if (kind === "engine") { root.rearm(); return }
    if (kind === "hotkey") {
      if (voice) root.guarded("voice.setConfig", function() { voice.setConfig(configStore.config); return [] })
      root.rearm()
      return
    }
```

Add this function before `// ---- IPC (§2 hardware-free testability)`:

```js
  // ---- Typeless hotkey (Typeless spec §4.3 step 5) -----------------------------------
  function ipcTypelessHotkey(chord) {
    if (!configStore.loaded) return JSON.stringify({ ok: false, reason: "not-ready" })
    var p = Chord.parseChord(chord)
    if (!p.ok) return JSON.stringify({ ok: false, reason: "invalid chord: " + p.reason })   // rejected, never defaulted
    if (root.configInvalid) return JSON.stringify({ ok: false, reason: "config.json is invalid" })
    var rawV = configStore.raw && configStore.raw.voice
    var stored = rawV && rawV.typeless && rawV.typeless.hotkey !== undefined ? Chord.canonicalChord(rawV.typeless.hotkey) : undefined
    var last = configStore.writes.lastCarrying(function(t) { return Chord.canonicalChord(configStore.hotkeyOfText(t)) === p.canonical })
    var plan = ConfigWrites.hotkeyWritePlan(stored, p.canonical, last)
    var seq = plan.seq
    if (plan.write) {
      seq = configStore.setTypelessHotkey(p.canonical)
      if (!seq) return JSON.stringify({ ok: false, reason: root.lastError || "config write refused" })
    }
    return JSON.stringify({ ok: true, hotkey: p.canonical, writeSeq: seq })
  }
  function hotkeyStored() {
    var v = configStore.raw && configStore.raw.voice
    return !!(v && v.typeless && v.typeless.hotkey !== undefined)
  }
```

In `statusJson()`, add before `, doctorSummary: root.doctorSummary`:

```js
      , configWrites: { saves: configStore.saves, errors: configStore.saveErrors }
      , typeless: { hotkey: root.config ? root.config.voice.typeless.hotkey : null, hotkeyStored: root.hotkeyStored() }
```

In `IpcHandler`, add after `function micToggle(): string { return root.micToggle() }`:

```qml
    function typelessHotkey(chord: string): string { return root.ipcTypelessHotkey(chord) }
```

Check that `ConfigStore`'s `onSaveFailed` handler in Service (`root.lastError = "config-write: " + reason`) is
unchanged. It now also fires for the 8-deep limit. `ipcTypelessHotkey` reads `root.lastError` only right after a
refused write, so the reason it returns is that refusal.

- [ ] **Step 5: Run the new scenarios, then the whole integration suite**

Run: `bash tests/fake-remote.sh typeless_hotkey_written_and_confirmed; bash tests/fake-remote.sh typeless_hotkey_invalid_rejected; bash tests/fake-remote.sh config_external_edit_back_to_earlier_value`
Expected: `ok` for each.

Run: `bash tests/fake-remote.sh`
Expected: `integration: N passed, 0 failed`. Pay particular attention to `config_external_reload`,
`corrupt_config_never_overwritten` and `config_slow_external_write`, which pin the transient-empty handling this task
re-plumbed.

- [ ] **Step 6: Run the unit tests and lint**

Run: `make check; echo MAKE_CHECK_EXIT=$?`
Expected: `MAKE_CHECK_EXIT=0`.

- [ ] **Step 7: Commit**

```bash
git add components/ConfigStore.qml Service.qml tests/fake-remote.sh
git commit -m "feat(config): ConfigStore on serialized writes; typelessHotkey IPC with a write seq

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---
### Task 6: `lib/TypelessSession.mjs`

This task carries every TypelessSession interleaving that spec §9 requires. Keep them all; they are how a reviewer
confirms the reconcile rules were implemented as written.

**Files:**
- Create: `lib/TypelessSession.mjs`
- Create: `tests/TypelessSession.test.mjs`
- Modify: `tests/harness/ModuleLoad.qml`

**Interfaces:**
- Consumes: the normalized config fields `voice.mic`, `voice.maxSessionSec` and `voice.typeless.hotkey` (Task 3).
- Produces: `createTypelessSession(config)` returning:
  - `streaming(on, now)`, `sourceLost(now)`, `hidPress(now)`, `reset(now)`;
  - `quiesce(now, holder, reason)` and `resume(now, holder)`. A holder is a string such as `"switch"`, `"mic"` or
    `"dormant"`. A reason of `""` means silent.
  - `forceUnsynced(now)`, `tapResult(id, outcome, reason, now)`, `advance(now)`, `setConfig(cfg, now)`.
    Each of these returns an effects array.
  - `nextDeadline() → ms|null`, `settled() → bool`, `exitStop() → chord|null`, `config() → cfg`, `snapshot()`.
- Effects:
  - `{ type: "tap", id, chord, kind: "start"|"stop"|"press" }`;
  - `{ type: "hud", text }`;
  - `{ type: "state", state: snapshot }`, emitted only when the snapshot changed;
  - `{ type: "log", text }`.
- `snapshot()` is
  `{ mode, typeless, streaming, trusted, needRelease, quiesced: string[], outstanding: {id, kind}|null, queued, since, chord, deadline, settled }`.
- Also exports `HUD` (the verbatim texts) and `SYSTEM_FIFO = 4`.
- Two extensions beyond the spec's input list:
  - `quiesce`/`resume` take a holder name, so the engine switch, a mic apply and dormancy can overlap without
    resuming each other.
  - `forceUnsynced` implements the switch timeout (§6.2 step 1).

- [ ] **Step 1: Write the failing tests** `tests/TypelessSession.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTypelessSession, HUD } from "../lib/TypelessSession.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";

const cfg = (voice = {}) => normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, engine: "typeless", ...voice } }).config;
const sys = (voice = {}) => cfg({ mic: "system", ...voice });
const taps = (fx) => fx.filter(e => e.type === "tap");
const huds = (fx) => fx.filter(e => e.type === "hud").map(e => e.text);

// Records every effect so a test can assert across a whole interleaving.
function rig(c = cfg()) {
  const s = createTypelessSession(c);
  const all = [];
  const rec = (fx) => { all.push(...fx); return fx; };
  return {
    s, all,
    on: (t) => rec(s.streaming(true, t)),
    off: (t) => rec(s.streaming(false, t)),
    lost: (t) => rec(s.sourceLost(t)),
    press: (t) => rec(s.hidPress(t)),
    reset: (t) => rec(s.reset(t)),
    quiesce: (t, holder = "switch", why = "switching engine") => rec(s.quiesce(t, holder, why)),
    resume: (t, holder = "switch") => rec(s.resume(t, holder)),
    force: (t) => rec(s.forceUnsynced(t)),
    advance: (t) => rec(s.advance(t)),
    set: (c2, t) => rec(s.setConfig(c2, t)),
    res: (id, outcome, t, reason = "") => rec(s.tapResult(id, outcome, reason, t)),
    taps: () => taps(all),
    kinds: () => taps(all).map(e => e.kind),
    lastTap: () => { const l = taps(all); return l[l.length - 1]; },
    snap: () => s.snapshot(),
  };
}

// ---- remote mode (§5.2) ----------------------------------------------------------

test("a hold sends one start tap with the configured hotkey and its release one stop tap", () => {
  const r = rig();
  assert.deepEqual(taps(r.on(0)), [{ type: "tap", id: 1, chord: "RightAlt", kind: "start" }]);
  r.res(1, "sent", 30);
  assert.equal(r.snap().typeless, "on");
  assert.deepEqual(taps(r.off(500)).map(t => [t.id, t.kind, t.chord]), [[2, "stop", "RightAlt"]]);
  r.res(2, "sent", 530);
  assert.equal(r.snap().typeless, "off");
  assert.deepEqual(r.kinds(), ["start", "stop"]);
});

test("shell start before ATVVoice reports: streaming is unknown, nothing is armed, and the first read of streaming starts", () => {
  const r = rig();
  assert.equal(r.snap().trusted, false);
  assert.equal(r.snap().needRelease, false);
  assert.deepEqual(taps(r.on(0)).map(t => t.kind), ["start"]);
});

test("shell start with the button released: the first trusted false arms nothing and the first hold starts", () => {
  const r = rig();
  assert.deepEqual(taps(r.off(0)), []);
  assert.deepEqual(taps(r.on(100)).map(t => t.kind), ["start"]);
});

test("release during start, re-press before the result: the start is honoured and nothing more is sent", () => {
  const r = rig();
  r.on(0); r.off(10); r.on(20);
  assert.deepEqual(taps(r.res(1, "sent", 30)), []);
  assert.equal(r.snap().typeless, "on");
  assert.equal(r.taps().length, 1, "the second hold continues the same Typeless recording");
  assert.deepEqual(taps(r.off(40)).map(t => t.kind), ["stop"]);
});

test("release during start: the start result is followed by exactly one stop", () => {
  const r = rig();
  r.on(0); r.off(10);
  assert.deepEqual(taps(r.res(1, "sent", 30)).map(t => [t.id, t.kind]), [[2, "stop"]]);
});

test("start notSent: HUD with the reason, nothing more is sent, and no stop follows a start that did not happen", () => {
  const r = rig();
  r.on(0);
  const fx = r.res(1, "notSent", 20, "keytap not running");
  assert.deepEqual(huds(fx), ["Typeless trigger failed: keytap not running"]);
  assert.equal(r.snap().typeless, "off");
  assert.equal(r.snap().needRelease, true, "no retry within this hold");
  r.off(100);
  assert.equal(r.taps().length, 1, "no stop");
  r.on(200);
  assert.deepEqual(r.kinds(), ["start", "start"], "the next hold starts");
});

test("release first, then start notSent: the trusted false makes arming a no-op and the next hold starts", () => {
  const r = rig();
  r.on(0); r.off(10);
  r.res(1, "notSent", 20, "keytap not running");
  assert.equal(r.snap().needRelease, false);
  assert.deepEqual(taps(r.on(30)).map(t => t.kind), ["start"]);
});

test("re-press during stop: the stop result is followed by a new start", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  r.off(100);                                  // stop 2
  r.on(110);
  assert.deepEqual(taps(r.res(2, "sent", 130)).map(t => [t.id, t.kind]), [[3, "start"]]);
});

test("reset mid-hold stops; the still-held button does not restart; the next hold starts", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  assert.deepEqual(taps(r.reset(100)).map(t => t.kind), ["stop"]);
  assert.deepEqual(taps(r.res(2, "sent", 120)), []);
  assert.equal(r.snap().needRelease, true);
  r.off(300);
  assert.deepEqual(taps(r.on(400)).map(t => t.kind), ["start"]);
});

test("the maxSessionSec deadline stops with HUD, the held button does not restart, the next hold starts", () => {
  const r = rig(cfg({ maxSessionSec: 5 }));
  r.on(0); r.res(1, "sent", 10);
  assert.equal(r.s.nextDeadline(), 5000);
  assert.deepEqual(taps(r.advance(4999)), []);
  const fx = r.advance(5000);
  assert.deepEqual(huds(fx), ["max session reached"]);
  assert.deepEqual(taps(fx).map(t => t.kind), ["stop"]);
  r.res(2, "sent", 5020);
  assert.equal(r.s.nextDeadline(), null);
  assert.equal(r.taps().length, 2);
  r.off(6000);
  assert.deepEqual(taps(r.on(6100)).map(t => t.kind), ["start"]);
});

test("a maxSessionSec shorter than the start reply: the bound fires while the start is in flight, and the late sent stops", () => {
  const r = rig(cfg({ maxSessionSec: 1 }));
  r.on(0);                                       // start 1 in flight
  assert.equal(r.s.nextDeadline(), 1000, "scheduled before the start result arrives");
  const fx = r.advance(1000);
  assert.deepEqual(huds(fx), ["max session reached"]);
  assert.deepEqual(taps(fx), [], "single flight: nothing more while the start is outstanding");
  assert.equal(r.snap().needRelease, true);
  assert.equal(r.s.nextDeadline(), null);
  assert.deepEqual(taps(r.res(1, "sent", 1500)).map(t => t.kind), ["stop"], "the late success reconciles into a stop");
  r.res(2, "sent", 1520);
  assert.equal(r.taps().length, 2, "the still-held button does not restart");
});

test("streaming off during start, then start unknown → unsynced, and no stop is ever emitted", () => {
  const r = rig();
  r.on(0); r.off(10);
  assert.deepEqual(huds(r.res(1, "unknown", 20)), [HUD.unknown]);
  assert.equal(r.snap().typeless, "unsynced");
  assert.deepEqual(huds(r.on(30)), [HUD.unknown], "streaming on only repeats the HUD");
  r.off(40); r.advance(1e9);
  assert.equal(r.taps().length, 1);
});

test("reset while starting: the start result is still honoured, and if sent exactly one stop follows", () => {
  const r = rig();
  r.on(0);
  assert.deepEqual(taps(r.reset(10)), []);
  assert.deepEqual(taps(r.res(1, "sent", 20)).map(t => t.kind), ["stop"]);
  r.res(2, "sent", 40);
  assert.equal(r.taps().length, 2);
});

test("re-press during stop, then stop notSent → unsynced and no start", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  r.off(100); r.on(110);
  const fx = r.res(2, "notSent", 130, "keytap not running");
  assert.deepEqual(taps(fx), []);
  assert.equal(r.snap().typeless, "unsynced");
  assert.deepEqual(huds(fx), [HUD.unknown]);
});

test("stale results: a duplicate report for a resolved id and a never-issued id are both ignored", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  const before = JSON.stringify(r.snap());
  assert.deepEqual(r.res(1, "sent", 20), []);
  assert.deepEqual(r.res(99, "unknown", 30), []);
  assert.equal(JSON.stringify(r.snap()), before);
});

test("a hotkey change while on: the stop uses the captured chord, the next session the new one", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  r.set(cfg({ typeless: { hotkey: "RightCtrl+Space" } }), 50);
  assert.equal(taps(r.off(100))[0].chord, "RightAlt");
  r.res(2, "sent", 120);
  assert.equal(taps(r.on(300))[0].chord, "RightCtrl+Space");
});

test("unsynced is left only through reset, and reset re-arms nothing once released", () => {
  const r = rig();
  r.on(0); r.res(1, "unknown", 10);
  r.off(20); r.on(30); r.off(40); r.advance(1e9); r.set(cfg(), 45);
  assert.equal(r.snap().typeless, "unsynced");
  assert.equal(r.taps().length, 1);
  r.reset(50);
  assert.equal(r.snap().typeless, "off");
  assert.equal(r.snap().needRelease, false, "trusted streaming is false: arming is a no-op");
  assert.deepEqual(taps(r.on(60)).map(t => t.kind), ["start"]);
});

test("ATVVoice restarts mid-hold: the lost source stops Typeless and nothing starts until a trusted release", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  assert.deepEqual(taps(r.lost(100)).map(t => t.kind), ["stop"], "the audio source is gone");
  r.res(2, "sent", 120);
  assert.deepEqual(taps(r.on(200)), [], "the new source reports the old hold");
  assert.equal(r.snap().needRelease, true);
  r.off(300);
  assert.deepEqual(taps(r.on(400)).map(t => t.kind), ["start"]);
});

test("single flight: however the button moves, no second tap is sent while one is outstanding", () => {
  const r = rig();
  r.on(0); r.off(1); r.on(2); r.off(3); r.on(4);
  assert.equal(r.taps().length, 1);
});

test("review focus 1: five short presses with late results never overlap taps and end off with alternating taps", () => {
  const r = rig();
  let t = 0;
  const pending = [];
  const collect = (fx) => { for (const e of taps(fx)) pending.push(e); };
  for (let i = 0; i < 5; i++) {
    collect(r.on(t += 50));
    collect(r.off(t += 120));
    if (i % 2 === 1) while (pending.length) { const e = pending.shift(); collect(r.res(e.id, "sent", t += 10)); }
    assert.ok(pending.length <= 1, "never more than one tap in flight");
  }
  while (pending.length) { const e = pending.shift(); collect(r.res(e.id, "sent", t += 10)); }
  assert.equal(r.snap().typeless, "off");
  assert.equal(r.snap().outstanding, null);
  r.kinds().forEach((k, i) => assert.equal(k, i % 2 === 0 ? "start" : "stop", `tap ${i}`));
  assert.equal(r.kinds().length % 2, 0);
});

test("hidPress does nothing in remote mode", () => {
  const r = rig();
  assert.deepEqual(r.press(0), []);
});

// ---- system mode (§5.3) -----------------------------------------------------------

test("system: each press is one tap with the current hotkey; streaming is ignored", () => {
  const r = rig(sys());
  assert.deepEqual(taps(r.press(0)), [{ type: "tap", id: 1, chord: "RightAlt", kind: "press" }]);
  assert.deepEqual(taps(r.on(5)), []);
  r.res(1, "sent", 30);
  assert.deepEqual(taps(r.press(100)).map(t => t.id), [2]);
});

test("system: five rapid presses send one plus three queued; the fifth is dropped with HUD", () => {
  const r = rig(sys());
  for (let i = 0; i < 5; i++) r.press(i);
  assert.equal(r.taps().length, 1);
  assert.deepEqual(r.all.filter(e => e.type === "hud").map(e => e.text), ["too fast — press ignored"]);
  assert.equal(taps(r.res(1, "sent", 10)).length, 1);
  assert.equal(taps(r.res(2, "sent", 20)).length, 1);
  assert.equal(taps(r.res(3, "sent", 30)).length, 1);
  assert.deepEqual(taps(r.res(4, "sent", 40)), []);
  assert.equal(r.taps().length, 4);
});

test("system: a mid-FIFO unknown or notSent clears the remaining presses", () => {
  for (const outcome of ["unknown", "notSent"]) {
    const r = rig(sys());
    r.press(0); r.press(1); r.press(2);
    const fx = r.res(1, outcome, 10, "keytap not running");
    assert.deepEqual(huds(fx), ["Typeless trigger failed; check Typeless before pressing again"], outcome);
    assert.deepEqual(taps(fx), [], outcome);
    assert.equal(r.snap().queued, 0, outcome);
  }
});

test("review focus 3: queued system presses keep the chord that was current when they were pressed", () => {
  const r = rig(sys());
  r.press(0); r.press(1); r.press(2);
  r.set(sys({ typeless: { hotkey: "RightCtrl+Space" } }), 3);
  assert.equal(taps(r.res(1, "sent", 10))[0].chord, "RightAlt");
  assert.equal(taps(r.res(2, "sent", 20))[0].chord, "RightAlt");
  r.res(3, "sent", 30);
  assert.equal(taps(r.press(40))[0].chord, "RightCtrl+Space");
});

test("system: reset and quiesce clear the FIFO; the outstanding press finishes and is honoured", () => {
  const a = rig(sys());
  a.press(0); a.press(1); a.press(2);
  a.reset(5);
  assert.equal(a.snap().queued, 0);
  assert.deepEqual(taps(a.res(1, "sent", 10)), []);
  const b = rig(sys());
  b.press(0); b.press(1);
  b.quiesce(5);
  assert.equal(b.snap().queued, 0);
  assert.equal(b.s.settled(), false, "the outstanding press is still in flight");
  b.res(1, "sent", 10);
  assert.equal(b.s.settled(), true);
  assert.equal(b.taps().length, 1);
});

test("system never taps on streaming, source loss, a deadline, reset or quiesce after an active-looking history (discriminating)", () => {
  const history = (r) => {
    r.on(1000); r.off(1100); r.on(1200); r.lost(1300); r.on(1400); r.advance(1e9);
    r.reset(1500); r.quiesce(1600); r.resume(1700); r.on(1800); r.off(1900);
  };
  const s = rig(sys());
  s.press(0); s.res(1, "sent", 10);             // Typeless is now really recording
  history(s);
  assert.equal(s.taps().length, 1);
  const m = rig();
  history(m);
  assert.ok(m.taps().length > 0, "the same history does tap in remote mode, so the check above can fail");
});

// ---- quiesce, switch timeout, dormancy, shell exit (§6.1, §6.2) ------------------

test("quiesce while starting: started then stopped, settled, resumed; a re-press works only after a release", () => {
  const r = rig();
  r.on(0);
  r.quiesce(10);
  assert.equal(r.s.settled(), false);
  assert.deepEqual(taps(r.res(1, "sent", 20)).map(t => t.kind), ["stop"]);
  r.res(2, "sent", 40);
  assert.equal(r.s.settled(), true);
  r.resume(50);
  assert.equal(r.taps().length, 2, "the still-held button does not restart");
  r.off(60);
  assert.deepEqual(taps(r.on(70)).map(t => t.kind), ["start"]);
});

test("engine switch while idle and released, then switch back: the first hold afterwards starts", () => {
  const r = rig();
  r.off(0);
  r.quiesce(10); r.resume(20);
  r.quiesce(30); r.resume(40);
  assert.equal(r.snap().needRelease, false);
  assert.deepEqual(taps(r.on(50)).map(t => t.kind), ["start"]);
});

test("while quiesced, streaming on and a press only show the pause reason; a silent holder shows nothing", () => {
  const r = rig();
  r.off(0); r.quiesce(1, "mic", "changing microphone");
  assert.deepEqual(huds(r.on(2)), ["dictation paused: changing microphone"]);
  assert.equal(r.taps().length, 0);
  const d = rig();
  d.quiesce(0, "dormant", "");
  assert.deepEqual(huds(d.on(1)), []);
  const p = rig(sys());
  p.quiesce(0);
  assert.deepEqual(huds(p.press(1)), ["dictation paused: switching engine"]);
  assert.equal(p.taps().length, 0);
});

test("holders are independent: resuming one keeps the session quiesced while another holds", () => {
  const r = rig();
  r.off(0);
  r.quiesce(1, "mic", "changing microphone"); r.quiesce(2, "switch", "switching engine");
  r.resume(3, "switch");
  assert.deepEqual(r.snap().quiesced, ["mic"]);
  assert.deepEqual(taps(r.on(4)), []);
  r.off(5); r.resume(6, "mic");
  assert.deepEqual(taps(r.on(7)).map(t => t.kind), ["start"]);
});

test("switch timeout while a tap is outstanding: no second tap; reset refused until it resolves; then reset → off", () => {
  const r = rig();
  r.on(0);                                       // start 1, never answered in time
  r.quiesce(10);
  assert.deepEqual(huds(r.force(3010)), ["Typeless may still be recording"]);
  assert.equal(r.snap().typeless, "unsynced");
  assert.deepEqual(huds(r.reset(3020)), [HUD.pendingReset]);
  assert.equal(r.snap().typeless, "unsynced");
  const late = r.res(1, "sent", 3100);
  assert.deepEqual(taps(late), []);
  assert.equal(late.filter(e => e.type === "log").length, 1, "a result in unsynced is only logged");
  assert.equal(r.snap().typeless, "unsynced");
  r.reset(3200);
  assert.equal(r.snap().typeless, "off");
  assert.equal(r.taps().length, 1, "no second tap was ever issued");
});

test("settled: no tap outstanding, nothing queued, and Typeless not believed on", () => {
  const r = rig();
  assert.equal(r.s.settled(), true);
  r.on(0);
  assert.equal(r.s.settled(), false, "start outstanding");
  r.res(1, "sent", 10);
  assert.equal(r.s.settled(), false, "on");
  const u = rig();
  u.on(0); u.res(1, "unknown", 10);
  assert.equal(u.s.settled(), true, "unsynced with nothing outstanding");
  const p = rig(sys());
  p.press(0);
  assert.equal(p.s.settled(), false);
});

test("shell exit stops only an `on` remote session with nothing outstanding", () => {
  const r = rig();
  assert.equal(r.s.exitStop(), null);
  r.on(0);
  assert.equal(r.s.exitStop(), null, "start outstanding: a stop could itself start a recording");
  r.res(1, "sent", 10);
  assert.equal(r.s.exitStop(), "RightAlt");
  r.off(20);
  assert.equal(r.s.exitStop(), null, "stop outstanding");
  const u = rig();
  u.on(0); u.res(1, "unknown", 10);
  assert.equal(u.s.exitStop(), null, "unsynced");
  const p = rig(sys());
  p.press(0); p.res(1, "sent", 10);
  assert.equal(p.s.exitStop(), null, "system mode keeps no state");
});

test("dormant under Voxtype: hold, then release, then switch to Typeless → the first hold starts", () => {
  const r = rig();
  r.quiesce(0, "dormant", "");
  r.on(10); r.off(500);
  r.resume(600, "dormant");
  assert.equal(r.taps().length, 0);
  assert.deepEqual(taps(r.on(700)).map(t => t.kind), ["start"]);
});

test("dormant under Voxtype: ATVVoice restarts; a new source reporting not streaming lets the first hold start", () => {
  const r = rig();
  r.quiesce(0, "dormant", ""); r.off(1);
  r.lost(10); r.off(20);
  r.resume(30, "dormant");
  assert.deepEqual(taps(r.on(40)).map(t => t.kind), ["start"]);
});

test("dormant under Voxtype: a new source reporting streaming (held across the switch) waits for a release", () => {
  const r = rig();
  r.quiesce(0, "dormant", ""); r.off(1);
  r.lost(10); r.on(20);
  r.resume(30, "dormant");
  assert.equal(r.taps().length, 0);
  r.off(40);
  assert.deepEqual(taps(r.on(50)).map(t => t.kind), ["start"]);
});

test("dormant under Voxtype: a long history never taps (discriminating: the same history resumed does)", () => {
  const history = (r) => {
    for (let i = 0; i < 5; i++) { r.on(i * 100 + 10); r.off(i * 100 + 60); if (i === 2) r.lost(i * 100 + 70); }
    r.on(1000);
  };
  const d = rig();
  d.quiesce(0, "dormant", "");
  history(d);
  assert.equal(d.taps().length, 0);
  const live = rig();
  history(live);
  assert.ok(live.taps().length > 0);
});

test("a state effect carries the snapshot only when it changed", () => {
  const r = rig();
  const fx = r.on(0);
  const st = fx.filter(e => e.type === "state");
  assert.equal(st.length, 1);
  assert.deepEqual(st[0].state.outstanding, { id: 1, kind: "start" });
  assert.equal(st[0].state.since, 0);
  assert.equal(r.res(99, "sent", 1).length, 0, "a stale result changes nothing and emits nothing");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/TypelessSession.test.mjs`
Expected: FAIL with `Cannot find module '…/lib/TypelessSession.mjs'`.

- [ ] **Step 3: Implement** `lib/TypelessSession.mjs`

```js
// Typeless spec §5: when to tap Typeless's dictation hotkey. Pure: explicit `now`, effects out, no processes.
//   remote mode (§5.2): hold to talk, by reconciling a few facts after every input and every tap result;
//   system mode (§5.3): each HID press is one tap, through a FIFO of at most SYSTEM_FIFO presses;
//   both: single-flight taps (§5.1), quiesce holders for drains (§6.2), dormant (held quiesced) under Voxtype (§6.1).
// Typeless's real state is invisible (§5.4): `typeless` is only what omaremote believes it is doing.
export const HUD = {
  failed: (reason) => "Typeless trigger failed: " + reason,
  unknown: "Typeless state unknown — check Typeless; press reset when it is stopped",
  pendingReset: "a Typeless trigger is still pending — wait a moment, check Typeless is stopped, then reset again",
  maxSession: "max session reached",
  tooFast: "too fast — press ignored",
  systemFailed: "Typeless trigger failed; check Typeless before pressing again",
  paused: (reason) => "dictation paused: " + reason,
  mayRecord: "Typeless may still be recording",
};
export const SYSTEM_FIFO = 4;              // presses held, the outstanding one included

export function createTypelessSession(config) {
  let cfg = config;
  let typeless = "off";                    // remote: off | on | unsynced
  let streaming = false;                   // latest ATVVoice streaming value ...
  let trusted = false;                     // ... read from the current source; false = unknown (counts as not streaming)
  let needRelease = false;                 // one physical hold never restarts after it was ended
  const holders = new Map();               // quiesce holder → reason shown while paused ("" = silent)
  let outstanding = null;                  // { id, kind, chord }: the single tap in flight
  let tapSeq = 0;
  let chord = null;                        // remote session's captured chord (§5.1)
  let since = 0;                           // when that session's start tap was issued
  let deadline = null;                     // maxSessionSec bound of an `on` session
  let fifo = [];                           // system: chords of queued presses (outstanding not included)
  let lastKey = "";

  const mode = () => (cfg.voice.mic === "system" ? "system" : "remote");
  const quiesced = () => holders.size > 0;
  const desired = () => trusted && streaming && !needRelease && !quiesced();
  const settled = () => outstanding === null && fifo.length === 0 && typeless !== "on";
  function pausedReason() { let r = ""; holders.forEach((reason) => { if (reason) r = reason; }); return r; }
  // §5.2 "arming": a release that already happened (trusted false) leaves nothing to wait for.
  function arm() { if (trusted && !streaming) return; needRelease = true; }
  const hud = (out, text) => out.push({ type: "hud", text });

  function snapshot() {
    return {
      mode: mode(), typeless, streaming, trusted, needRelease, quiesced: Array.from(holders.keys()),
      outstanding: outstanding ? { id: outstanding.id, kind: outstanding.kind } : null,
      queued: fifo.length, since, chord, deadline, settled: settled(),
    };
  }
  function tap(out, kind, c) {
    outstanding = { id: ++tapSeq, kind, chord: c };
    out.push({ type: "tap", id: outstanding.id, chord: c, kind });
  }
  function reconcile(out, now) {
    if (mode() !== "remote" || outstanding || typeless === "unsynced") return;
    if (typeless === "off" && desired()) {
      chord = cfg.voice.typeless.hotkey; since = now; deadline = now + cfg.voice.maxSessionSec * 1000;
      tap(out, "start", chord);
    } else if (typeless === "on" && !desired()) {
      tap(out, "stop", chord);
    }
  }
  function finish(out, now) {
    reconcile(out, now);
    if (mode() === "system" && !outstanding && fifo.length > 0) tap(out, "press", fifo.shift());
    const s = snapshot(), key = JSON.stringify(s);
    if (key !== lastKey) { lastKey = key; out.push({ type: "state", state: s }); }
    return out;
  }

  function onStreaming(on, now) {
    const out = [];
    streaming = !!on; trusted = true;
    if (!streaming) needRelease = false;
    if (streaming && mode() === "remote") {
      const why = pausedReason();
      if (quiesced() && why) hud(out, HUD.paused(why));
      else if (typeless === "unsynced") hud(out, HUD.unknown);
    }
    return finish(out, now);
  }

  function sourceLost(now) {
    trusted = false; streaming = false; needRelease = true;   // unknown: always armed (§5.2)
    return finish([], now);
  }

  function hidPress(now) {
    const out = [];
    if (mode() !== "system") return out;                      // remote-mic design §4.2: the stream is the trigger
    if (quiesced()) { const why = pausedReason(); if (why) hud(out, HUD.paused(why)); return finish(out, now); }
    if (fifo.length + (outstanding ? 1 : 0) >= SYSTEM_FIFO) { hud(out, HUD.tooFast); return finish(out, now); }
    fifo.push(cfg.voice.typeless.hotkey);                     // the chord current at press time
    return finish(out, now);
  }

  function tapResult(id, outcome, reason, now) {
    const out = [];
    if (!outstanding || outstanding.id !== id) return out;   // stale: duplicate or never issued (§5.1)
    const kind = outstanding.kind;
    outstanding = null;
    if (kind === "press") {
      if (outcome !== "sent") { fifo = []; hud(out, HUD.systemFailed); }
      return finish(out, now);
    }
    if (typeless === "unsynced") {                           // §5.2: the single rule for results in unsynced
      out.push({ type: "log", text: "Typeless " + kind + " result " + outcome + " ignored while unsynced" });
      return finish(out, now);
    }
    if (outcome === "unknown") { typeless = "unsynced"; deadline = null; hud(out, HUD.unknown); }
    else if (kind === "start" && outcome === "sent") { typeless = "on"; hud(out, ""); }
    else if (kind === "start") { arm(); deadline = null; hud(out, HUD.failed(reason || "not sent")); }
    else if (outcome === "sent") { typeless = "off"; deadline = null; hud(out, ""); }
    else { typeless = "unsynced"; deadline = null; hud(out, HUD.unknown); }   // stop notSent: certainly still recording
    return finish(out, now);
  }

  function reset(now) {
    const out = [];
    if (mode() === "system") { fifo = []; return finish(out, now); }
    if (typeless === "unsynced") {
      if (outstanding) { hud(out, HUD.pendingReset); return finish(out, now); }
      typeless = "off"; hud(out, "");
    }
    arm();
    return finish(out, now);
  }

  function quiesce(now, holder, reason) {
    holders.set(holder || "switch", reason === undefined ? "switching engine" : reason);
    arm();
    fifo = [];
    return finish([], now);
  }

  function resume(now, holder) {
    holders.delete(holder || "switch");
    return finish([], now);
  }

  // §6.2 step 1: the drain bound expired. The outstanding tap stays outstanding; its result will only be logged.
  function forceUnsynced(now) {
    const out = [];
    if (mode() === "remote" && !settled()) { typeless = "unsynced"; deadline = null; }
    hud(out, HUD.mayRecord);
    return finish(out, now);
  }

  // The bound runs from the start tap, so it also applies while that tap is in flight: arming then means a late
  // `sent` reconciles straight into a stop.
  const sessionLive = () => typeless === "on" || (outstanding !== null && outstanding.kind === "start");
  function advance(now) {
    const out = [];
    if (sessionLive() && deadline !== null && now >= deadline) { deadline = null; hud(out, HUD.maxSession); arm(); }
    return finish(out, now);
  }

  return {
    streaming: onStreaming, sourceLost, hidPress, reset, quiesce, resume, forceUnsynced, tapResult, advance,
    setConfig(c, now) { cfg = c; return finish([], now); },
    nextDeadline() { return sessionLive() ? deadline : null; },        // never a past deadline nothing will act on
    settled,
    exitStop() { return mode() === "remote" && typeless === "on" && !outstanding ? chord : null; },
    config() { return cfg; },
    snapshot,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/TypelessSession.test.mjs`
Expected: PASS, 39 tests.

- [ ] **Step 5: Mutation check.** The negative tests (no tap, no restart) must be able to fail. Make each change
  below, run the file, see at least one named test fail, and revert:
  - In `arm()`, delete `if (trusted && !streaming) return;`. Expected failures: "release first, then start notSent…",
    "engine switch while idle and released…" and "unsynced is left only through reset…".
  - In `tapResult`, replace the `typeless === "unsynced"` block with a fall-through. Expected failure: "switch
    timeout while a tap is outstanding…".
  - In `hidPress`, push `cfg.voice.typeless.hotkey` at pump time instead of at press time, by moving it into
    `finish()`. Expected failure: "review focus 3…".
  - In `desired`, drop `!quiesced()`. Expected failure: "dormant under Voxtype: a long history never taps…".

- [ ] **Step 6: Add the module to the QML load check.** Add
  `import "../../lib/TypelessSession.mjs" as TypelessSession` to `tests/harness/ModuleLoad.qml`, and add this element
  to `checks`:

```js
            , TypelessSession.createTypelessSession(normalized).snapshot().typeless
```

Run: `make lint`
Expected: `module-load: ok`. This also proves that `Map`, `Array.from` and arrow functions load under V4.

- [ ] **Step 7: Commit**

```bash
git add lib/TypelessSession.mjs tests/TypelessSession.test.mjs tests/harness/ModuleLoad.qml
git commit -m "feat(typeless): TypelessSession — remote reconcile, system FIFO, quiesce holders, dormant

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---
### Task 7: VoiceSession `drain` / `undrain` / `drained`

**Files:**
- Modify: `lib/VoiceSession.mjs`
- Test: `tests/VoiceSession.test.mjs` (append)

**Interfaces:**
- Produces:
  - `voice.drain(now) → effects`. It refuses new plugin-owned starts, stops a plugin-owned recording and abandons
    arbitration.
  - `voice.undrain(now, remoteState) → []`. It re-allows starts and resyncs the last known ATVVoice state.
  - `voice.drained() → bool`.
  - `snapshot().draining`.
  - `advance(now)` aborts a plugin-owned session that has not drained by `drain` time + 3000 ms.
- Why `undrain` takes `remoteState`: under Typeless, VoiceSession receives no ATVVoice input (§6.1). Its `remote`
  would otherwise keep a stale `streaming`, and the first hold after switching back would not be seen as a
  transition.

- [ ] **Step 1: Write the failing tests** (append to `tests/VoiceSession.test.mjs`; `cfg`, `D`, `kinds`, `stateOf`,
  `cmdId`, `byType` and `last` already exist there)

```js
// ---- Typeless spec §6.2: drain for an engine switch ----
function dbusRecording() {
  const vs = createVoiceSession(cfg());
  vs.setDbusSource({ sender: ":1.42", generation: 0 });
  vs.status("idle", 0, { fresh: true });
  const fx = vs.dbus(D("streaming"), 10);
  vs.cmdExit(cmdId(fx, "start"), 0, 20);
  vs.status("recording", 100);
  return vs;
}

test("drain stops a plugin-owned recording and counts it drained once it is transcribing", () => {
  const vs = dbusRecording();
  const fx = vs.drain(200);
  assert.deepEqual(kinds(fx), ["stop"]);
  assert.equal(vs.snapshot().draining, true);
  assert.equal(vs.drained(), false);
  vs.cmdExit(cmdId(fx, "stop"), 0, 220);
  assert.equal(vs.drained(), false, "stopping: the audio is not complete yet");
  vs.status("transcribing", 300);
  assert.equal(vs.drained(), true);
});

test("drain leaves a keyboard-owned session alone and does not wait for it", () => {
  const vs = createVoiceSession(cfg());
  vs.status("idle", 0, { fresh: true });
  vs.status("recording", 10);                       // F9: adopted as keyboard-owned
  const fx = vs.drain(20);
  assert.deepEqual(kinds(fx), []);
  assert.equal(vs.drained(), true);
  assert.equal(vs.snapshot().owner, "keyboard");
  assert.deepEqual(kinds(vs.advance(5000)), [], "the 3 s bound never touches it");
});

test("a plugin-owned session not drained within 3 s falls back to abort", () => {
  const vs = dbusRecording();
  const fx = vs.drain(200);
  vs.cmdExit(cmdId(fx, "stop"), 0, 220);            // Voxtype never reports transcribing
  assert.equal(vs.nextDeadline() <= 3200, true);
  assert.deepEqual(kinds(vs.advance(3199)), []);
  const ab = vs.advance(3200);
  assert.deepEqual(kinds(ab), ["cancel"]);
  assert.equal(stateOf(ab), "recovering");
  assert.equal(vs.drained(), true);
});

test("new plugin-owned starts are refused while draining, with HUD; undrain re-allows them", () => {
  const vs = createVoiceSession(cfg({ keys: { ...DEFAULT_CONFIG.keys, mic: { trigger: "toggle" } }, voice: { ...DEFAULT_CONFIG.voice, mic: "system" } }));
  vs.setDbusSource({ sender: ":1.42", generation: 0 });
  vs.status("idle", 0, { fresh: true });
  vs.drain(10);
  const t = vs.hidToggle(20);
  assert.deepEqual(kinds(t), []);
  assert.deepEqual(byType(t, "hud").map(h => h.text), ["switching engine"]);
  vs.undrain(30, "connected");
  assert.deepEqual(kinds(vs.hidToggle(40)), ["start"]);
});

test("a D-Bus stream is refused while draining", () => {
  const vs = createVoiceSession(cfg());
  vs.setDbusSource({ sender: ":1.42", generation: 0 });
  vs.status("idle", 0, { fresh: true });
  vs.drain(10);
  const fx = vs.dbus(D("streaming"), 20);
  assert.deepEqual(kinds(fx), []);
  assert.deepEqual(byType(fx, "hud").map(h => h.text), ["switching engine"]);
});

test("undrain resyncs the remote state, so the first hold after switching back is a transition (discriminating)", () => {
  const finishOne = (vs, t) => {                     // a whole dbus session that leaves remote = "streaming"
    const fx = vs.dbus(D("streaming"), t);
    vs.cmdExit(cmdId(fx, "start"), 0, t + 10);
    vs.status("recording", t + 20);
    vs.status("idle", t + 30, { fresh: true });
  };
  const stale = createVoiceSession(cfg());
  stale.setDbusSource({ sender: ":1.42", generation: 0 });
  stale.status("idle", 0, { fresh: true });
  finishOne(stale, 10);
  stale.drain(100); stale.undrain(200);              // no remoteState: still "streaming"
  assert.deepEqual(kinds(stale.dbus(D("streaming"), 300)), [], "without a resync the hold is lost");
  const synced = createVoiceSession(cfg());
  synced.setDbusSource({ sender: ":1.42", generation: 0 });
  synced.status("idle", 0, { fresh: true });
  finishOne(synced, 10);
  synced.drain(100); synced.undrain(200, "connected");
  assert.deepEqual(kinds(synced.dbus(D("streaming"), 300)), ["start"]);
});

test("drain while starting stops on confirmation; drain while arbitrating abandons it", () => {
  const vs = createVoiceSession(cfg());
  vs.setDbusSource({ sender: ":1.42", generation: 0 });
  vs.status("idle", 0, { fresh: true });
  const fx = vs.dbus(D("streaming"), 10);
  vs.drain(15);
  vs.cmdExit(cmdId(fx, "start"), 0, 20);
  assert.equal(vs.drained(), false);
  assert.deepEqual(kinds(vs.status("recording", 30)), ["stop"]);
  const arb = createVoiceSession(onDemandCfg());
  arb.setDbusSource({ sender: ":1.42", generation: 0 });
  arb.status("idle", 0, { fresh: true });
  arb.dbus(D("streaming"), 10);
  assert.equal(arb.snapshot().state, "arbitrating");
  arb.drain(20);
  assert.equal(arb.snapshot().state, "idle");
  assert.equal(arb.drained(), true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/VoiceSession.test.mjs`
Expected: FAIL with `vs.drain is not a function`.

- [ ] **Step 3: Implement.** In `lib/VoiceSession.mjs`:

Add after `const MAX_CANCELS = 3;`:

```js
const DRAIN_MS = 3000;       // Typeless spec §6.2: a plugin-owned session not drained by then is aborted
```

Add after `const gates = new Set();`:

```js
  let draining = false, drainDue = null;                    // Typeless §6.2; kept outside `dl`, which clearDeadlines() wipes
  const pluginOwned = () => owner === "dbus" || owner === "hid";
  // Drained: no plugin-owned session still capturing audio and no start/stop command in flight. `transcribing`
  // counts as drained (the audio is complete); a keyboard-owned (F9) session never blocks.
  function drained() {
    if (st === "arbitrating") return false;
    if (pluginOwned() && (st === "starting" || st === "recording" || st === "stopping")) return false;
    for (const c of cmds.values()) if (c.gen === gen && (c.kind === "start" || c.kind === "stop")) return false;
    return true;
  }
```

In `dbus(event, now)`, directly after the line
`if (cfg.voice.mic === "system" && !v().remoteOnDemand) return out;`, add:

```js
      if (draining) { if (st === "idle") hud(out, "switching engine"); return out; }   // Typeless §6.2
```

At the top of `hidPress(now)` and of `hidToggle(now)`, directly after `const out = [];`, add:

```js
    if (draining) { if (st === "idle") hud(out, "switching engine"); return out; }
```

Add these functions before `function cmdExit(id, code, now)`:

```js
  // Typeless spec §6.2: stop, not cancel, so the dictation's text is kept.
  function drain(now) {
    const out = [];
    draining = true; drainDue = now + DRAIN_MS;
    if (st === "arbitrating") abandonArb(out, null);
    else if (pluginOwned() && st === "starting") stopOnConfirm = true;
    else if (pluginOwned() && st === "recording") requestStop(out, now);
    return out;
  }
  function undrain(now, remoteState) {
    draining = false; drainDue = null;
    if (typeof remoteState === "string" && remoteState !== "") remote = remoteState;   // §6.1: no ATV input reached us meanwhile
    return [];
  }
```

At the top of `advance(now)`, after the `const due = …` line, add:

```js
    if (drainDue !== null && now >= drainDue) {
      drainDue = null;
      if (!drained() && st !== "idle" && st !== "unconfigured") enterRecovering(out, now, "abort");
    }
```

Replace `nextDeadline()` with:

```js
  function nextDeadline() {
    let d = drainDue;
    for (const k of Object.keys(dl)) if (dl[k] !== undefined && (d === null || dl[k] < d)) d = dl[k];
    return d;
  }
```

In the returned object, add `drain, undrain, drained,` after `abort, advance, nextDeadline,`. In `snapshot()`, add
`draining` after `idleAccepted`.

- [ ] **Step 4: Run the whole unit suite**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS. The earlier VoiceSession tests are unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/VoiceSession.mjs tests/VoiceSession.test.mjs
git commit -m "feat(voice): drain/undrain for engine switches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---

### Task 8: CommandRunner — SIGKILL escalation and a guaranteed report by deadline + 1 s

**Files:**
- Modify: `components/CommandRunner.qml:32-82` (the job component)
- Create: `tests/harness/RunnerBound.qml`
- Create: `tests/runner-bound.sh`
- Modify: `Makefile` (`check`)

**Interfaces:**
- Produces: every `runner.run(src, id, argv, deadlineMs)` emits `finished` exactly once, at most
  `deadlineMs + 1000` ms later. The code is 124 on timeout and 137 on `cancelAll`. Existing callers keep their
  deadlines. Task 10 relies on this for keytap (2000 ms deadline, so 3000 ms at most).

- [ ] **Step 1: Write the harness shell** `tests/harness/RunnerBound.qml`

```qml
// Typeless spec §6.1/§9: the real components/CommandRunner.qml must report every job exactly once within
// deadline + 1 s. Run by tests/runner-bound.sh in an offscreen Quickshell instance; prints "runner-bound: ok".
import QtQuick
import Quickshell
import "components"

ShellRoot {
  id: h
  property double t0: Date.now()
  property var seen: ({})              // "src:id" → [{ code, at, out }]
  property var fails: []
  function fail(msg) { var f = h.fails.slice(); f.push(msg); h.fails = f }

  function record(src, id, code, stdout) {
    var k = src + ":" + id, next = ({})
    for (var x in h.seen) next[x] = h.seen[x]
    next[k] = (h.seen[k] || []).concat([{ code: code, at: Date.now() - h.t0, out: stdout }])
    h.seen = next
  }
  CommandRunner { id: runner; onFinished: function(src, id, code, stdout, timedOut) { h.record(src, id, code, stdout) } }
  // A runner whose escalation is a no-op (signal 0): its child survives SIGTERM and "SIGKILL" alike, so only the hard
  // deadline + 1 s bound can report the job.
  CommandRunner { id: unkillable; escalationSignal: 0; onFinished: function(src, id, code, stdout, timedOut) { h.record("u", id, code, stdout) } }
  Component.onCompleted: {
    // 1. a child that outlives every signal: reported by the hard bound at 500 + 1000 ms; its own exit at ~2.5 s
    //    must not report a second time
    unkillable.run("u", 1, ["bash", "-c", "trap '' TERM; for i in $(seq 50); do sleep 0.05; done"], 500)
    // 2. ignores SIGTERM: the SIGKILL at 500 + 500 ms ends it
    runner.run("t", 2, ["bash", "-c", "trap '' TERM; while :; do sleep 0.05; done"], 500)
    // 3. an ordinary job is untouched
    runner.run("t", 3, ["sh", "-c", "echo hi"], 2000)
    // 4. cancelAll still reports 137, once
    runner.run("c", 4, ["sleep", "5"], 2000)
    cancelTimer.start()
    checkTimer.start()
  }
  Timer { id: cancelTimer; interval: 100; onTriggered: runner.cancelAll("c") }
  Timer {
    id: checkTimer; interval: 4000
    onTriggered: {
      function one(k) { var l = h.seen[k] || []; if (l.length !== 1) h.fail(k + " reported " + l.length + " times"); return l[0] }
      var a = one("u:1"); if (a && (a.code !== 124 || a.at < 1400 || a.at > 1900)) h.fail("u:1 code " + a.code + " at " + a.at + " ms (want 124 within 1400-1900)")
      var b = one("t:2"); if (b && (b.code !== 124 || b.at < 950 || b.at > 1400)) h.fail("t:2 code " + b.code + " at " + b.at + " ms (want 124 within 950-1400)")
      var c = one("t:3"); if (c && (c.code !== 0 || c.out.trim() !== "hi" || c.at > 1000)) h.fail("t:3 code " + c.code + " out " + JSON.stringify(c.out) + " at " + c.at)
      var d = one("c:4"); if (d && d.code !== 137) h.fail("c:4 code " + d.code)
      if (runner.pending("t") !== 0 || runner.pending("c") !== 0 || unkillable.pending("u") !== 0) h.fail("jobs left pending")
      console.log(h.fails.length ? "runner-bound: FAIL " + h.fails.join("; ") : "runner-bound: ok")
      Qt.quit()
    }
  }
}
```

- [ ] **Step 2: Write the runner script** `tests/runner-bound.sh`

```bash
#!/usr/bin/env bash
# Typeless spec §6.1/§9: run tests/harness/RunnerBound.qml against the real components/ in an offscreen Quickshell
# instance (no Wayland needed). Quickshell loads QML only under its config root, so the root is materialized here.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
command -v qs >/dev/null 2>&1 || { echo "runner-bound: skipped (no quickshell)"; exit 0; }
T=$(mktemp -d /tmp/omaremote-runner.XXXXXX); trap 'rm -rf "$T"' EXIT
cp "$ROOT/tests/harness/RunnerBound.qml" "$T/shell.qml"
ln -s "$ROOT/components" "$T/components"
out=$(QT_QPA_PLATFORM=offscreen timeout 20 qs -p "$T" --no-duplicate 2>&1)
line=$(grep -o 'runner-bound: .*' <<<"$out" | sed 's/\x1b\[[0-9;]*m//g' | tail -n1)
echo "${line:-runner-bound: no result}"
[[ $line == "runner-bound: ok" ]] || { sed 's/^/    /' <<<"$out" | tail -20; exit 1; }
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bash tests/runner-bound.sh`
Expected: a failure. Against today's runner, the harness cannot even load: `runner-bound: no result`, because
`CommandRunner` has no `escalationSignal` property. As a further check, temporarily delete `escalationSignal: 0`
from the harness and run again. The result is `runner-bound: FAIL u:1 code 124 at ~2575 ms …; t:2 reported 0 times`:
nothing escalates, and the report waits for the process to die. Restore the line afterwards.

- [ ] **Step 4: Implement.** In `components/CommandRunner.qml`:
  - add this property after `property var _live: ({})`:

```qml
  // The signal that follows an ignored SIGTERM. Only tests/harness/RunnerBound.qml changes it (to 0, a no-op), to
  // prove the deadline + 1 s report does not depend on the process ever dying.
  property int escalationSignal: 9
```

  - then replace the whole `Component { id: jobComponent … }` block with:

```qml
  // Typeless spec §6.1: every job reports exactly once, by deadline + 1 s. The deadline sends SIGTERM; 500 ms later a
  // process still running gets SIGKILL; at deadline + 1 s the job completes with 124 whatever its exit or stream
  // state (a grandchild can hold stdout open past SIGKILL), and anything the process does afterwards is dropped.
  Component {
    id: jobComponent
    Item {
      id: job
      property string src
      property int opId
      property var argv
      property int deadlineMs
      property bool timedOut: false
      property bool started: false
      property bool exitedSeen: false
      property bool streamDone: false
      property bool killed: false
      property bool done: false
      property int code: -1
      property string outText: ""
      function complete() { if (!job.done) { job.done = true; root._finish(job) } }
      function maybeDone() { if (exitedSeen && streamDone) job.complete() }
      function kill() { killed = true; if (proc.running) proc.signal(9) }
      Process {
        id: proc
        command: job.argv
        onStarted: job.started = true
        // A binary that cannot be found/exec'd flips `running` back to false without ever emitting `started`
        // or `exited` (verified live in a scratch Quickshell 0.3.1 instance) — the StdioCollector below never
        // finishes either, so without this the job would stay in `_live` forever. Synthesize exit 127.
        onRunningChanged: {
          if (!proc.running && !job.started && !job.exitedSeen) {
            job.code = 127
            job.exitedSeen = true
            job.streamDone = true
            job.maybeDone()
          }
        }
        stdout: StdioCollector {
          waitForEnd: true
          onStreamFinished: { job.outText = text; job.streamDone = true; job.maybeDone() }
        }
        onExited: function(exitCode, exitStatus) {
          job.code = job.timedOut ? 124 : (job.killed ? 137 : exitCode)
          job.exitedSeen = true
          job.maybeDone()
        }
      }
      Timer {
        interval: job.deadlineMs
        running: true
        repeat: false
        onTriggered: { if (proc.running) { job.timedOut = true; proc.signal(15); killTimer.start() } }
      }
      Timer { id: killTimer; interval: 500; repeat: false; onTriggered: if (proc.running) proc.signal(root.escalationSignal) }
      Timer {
        interval: job.deadlineMs + 1000
        running: true
        repeat: false
        onTriggered: {
          if (job.done) return
          job.timedOut = true
          job.code = 124
          if (proc.running) proc.signal(root.escalationSignal)
          job.complete()
        }
      }
      Component.onCompleted: proc.running = true
    }
  }
```

- [ ] **Step 5: Run the harness and the existing integration suite**

Run: `bash tests/runner-bound.sh`
Expected: `runner-bound: ok`.

Run: `bash tests/fake-remote.sh voxtype_missing_command_is_bounded; bash tests/fake-remote.sh`
Expected: all scenarios pass. The voice and doctor paths rely on the 124/137 codes and the 127 synthesis, which are
unchanged.

- [ ] **Step 6: Wire it into `make check`.** In `Makefile`, add `bash tests/runner-bound.sh` to the `check:` recipe
  after the `python3 -I tests/test_keytap.py` line. The script skips itself without quickshell, so no gate is needed.

Run: `make check; echo MAKE_CHECK_EXIT=$?`
Expected: `MAKE_CHECK_EXIT=0`.

- [ ] **Step 7: Commit**

```bash
git add components/CommandRunner.qml tests/harness/RunnerBound.qml tests/runner-bound.sh Makefile
git commit -m "fix(runner): escalate to SIGKILL and always report by deadline + 1 s

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---
### Task 9: `lib/EngineSwitch.mjs` — routing, tap outcomes, drain-then-commit (pure)

**Files:**
- Create: `lib/EngineSwitch.mjs`
- Create: `tests/EngineSwitch.test.mjs`
- Modify: `tests/harness/ModuleLoad.qml`

**Interfaces:**
- Consumes: `createTypelessSession` (Task 6), `voice.drain`/`undrain`/`drained` (Task 7), `createMicApply`
  (existing).
- Produces:
  - `DRAIN_MS = 3000` and `KEYTAP_DEADLINE_MS = 2000`.
  - `routeTargets(engine, input) → ("voice"|"typeless")[]`, where `input` is one of `state`, `sourceLost`, `micDown`,
    `micUp`, `reset`.
  - `tapOutcome(code) → { outcome, reason }`.
  - `reloadNeedsDrain(heldCfg, nextCfg) → bool`.
  - `startTypeless(session, engine, seedState, now) → effects`: the shell-start order, dormant first and seeded
    second. Task 10 calls it from `startModules`.
  - `micVoiceView(voice, typeless, engineOf) → { snapshot(), gate }`.
  - `createEngineSwitch()` returns:
    - `busy()`;
    - `begin(kind, target, now) → { ok, reason?, effects }`;
    - `progress({ voiceDrained, typelessSettled }, now)`, `advance(now)` and `nextDeadline()`.
  - Effects: `{ type: "drainStart", kind, target }`, `{ type: "typelessExpired" }`,
    `{ type: "switchCommit", kind, target }`, `{ type: "log", text }`.
- `makeHost` in the test file is the executable contract for Task 10's Service wiring. Service must:
  - perform `drainStart` (TypelessSession `quiesce("switch")`, then `voice.drain`);
  - perform `typelessExpired` (`forceUnsynced`);
  - perform `switchCommit`:
    - commit the engine (kind `switch` only);
    - `setConfig` both sessions;
    - `voice.undrain(now, remoteState)`;
    - resume `dormant` under Typeless, or quiesce it under Voxtype;
    - resume `switch`.
  - call `progress` only after an outermost module call has finished, so a commit can never land in the middle of a
    `drainStart`.

- [ ] **Step 1: Write the failing tests** `tests/EngineSwitch.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeTargets, tapOutcome, reloadNeedsDrain, micVoiceView, createEngineSwitch, startTypeless, DRAIN_MS } from "../lib/EngineSwitch.mjs";
import { createTypelessSession } from "../lib/TypelessSession.mjs";
import { createVoiceSession } from "../lib/VoiceSession.mjs";
import { createMicApply } from "../lib/MicApply.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";

const cfg = (voice = {}) => normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, ...voice } }).config;
const ev = (state) => ({ state, sender: ":1.42", path: "/org/atvvoice/Daemon", interface: "org.atvvoice.Daemon", member: "MicStateChanged", generation: 0 });

// The contract Service.qml implements (Task 10), in miniature: route inputs per §6.1, perform switch effects, and
// check the switch's progress only after an outermost call has finished, never in the middle of a drainStart.
function makeHost(engine) {
  let config = cfg({ engine });
  let pending = null;                                       // a reload's config, applied at its commit
  const voice = createVoiceSession(config);
  voice.setDbusSource({ sender: ":1.42", generation: 0 });
  voice.status("idle", 0, { fresh: true });
  const typeless = createTypelessSession(config);
  typeless.streaming(false, 0);                             // seeded from the source's last State, then...
  if (engine !== "typeless") typeless.quiesce(0, "dormant", "");   // ...dormant under Voxtype
  const sw = createEngineSwitch();
  const fx = { voice: [], typeless: [], switch: [] };
  let depth = 0;
  const h = {
    voice, typeless, sw, fx,
    get config() { return config; },
    apply(src, effects, now) {
      depth++;
      try {
        fx[src].push(...effects);
        for (const e of effects) {
          if (e.type === "drainStart") {
            h.apply("typeless", typeless.quiesce(now, "switch", "switching engine"), now);
            h.apply("voice", voice.drain(now), now);
          } else if (e.type === "typelessExpired") h.apply("typeless", typeless.forceUnsynced(now), now);
          else if (e.type === "switchCommit") {
            if (e.kind === "switch") config = cfg({ ...config.voice, engine: e.target });
            else config = pending;
            voice.setConfig(config);
            h.apply("typeless", typeless.setConfig(config, now), now);
            h.apply("voice", voice.undrain(now, "connected"), now);
            if (config.voice.engine === "typeless") h.apply("typeless", typeless.resume(now, "dormant"), now);
            else h.apply("typeless", typeless.quiesce(now, "dormant", ""), now);
            h.apply("typeless", typeless.resume(now, "switch"), now);
          }
        }
      } finally { depth--; }
      if (depth === 0 && sw.busy()) {
        const p = sw.progress({ voiceDrained: voice.drained(), typelessSettled: typeless.settled() }, now);
        if (p.length) h.apply("switch", p, now);
      }
    },
    begin(target, now) { const r = sw.begin("switch", target, now); h.apply("switch", r.effects, now); return r; },
    reload(next, now) { pending = next; const r = sw.begin("reload", next.voice.engine, now); h.apply("switch", r.effects, now); return r; },
    state(on, now) {
      for (const t of routeTargets(config.voice.engine, "state")) {
        if (t === "voice") h.apply("voice", voice.dbus(ev(on ? "streaming" : "connected"), now), now);
        else h.apply("typeless", typeless.streaming(on, now), now);
      }
    },
    tapResult(id, outcome, now) { h.apply("typeless", typeless.tapResult(id, outcome, "", now), now); },
    advance(now) {
      h.apply("voice", voice.advance(now), now);
      h.apply("typeless", typeless.advance(now), now);
      h.apply("switch", sw.advance(now), now);
    },
    taps() { return fx.typeless.filter(e => e.type === "tap"); },
    voxCmds() { return fx.voice.filter(e => e.type === "cmd").map(e => e.kind); },
    commits() { return fx.switch.filter(e => e.type === "switchCommit"); },
  };
  return h;
}

test("routeTargets: source updates reach TypelessSession under both engines; mic key, reset and panic only the selected one", () => {
  assert.deepEqual(routeTargets("voxtype", "state"), ["voice", "typeless"]);
  assert.deepEqual(routeTargets("voxtype", "sourceLost"), ["voice", "typeless"]);
  assert.deepEqual(routeTargets("voxtype", "micDown"), ["voice"]);
  assert.deepEqual(routeTargets("voxtype", "micUp"), ["voice"]);
  assert.deepEqual(routeTargets("voxtype", "reset"), ["voice"]);
  assert.deepEqual(routeTargets("typeless", "state"), ["typeless"]);
  assert.deepEqual(routeTargets("typeless", "sourceLost"), ["typeless"]);
  assert.deepEqual(routeTargets("typeless", "micDown"), ["typeless"]);
  assert.deepEqual(routeTargets("typeless", "micUp"), []);
  assert.deepEqual(routeTargets("typeless", "reset"), ["typeless"]);
});

test("tapOutcome maps the keytap exit codes and the runner's own codes", () => {
  assert.deepEqual(tapOutcome(0), { outcome: "sent", reason: "" });
  assert.equal(tapOutcome(2).outcome, "notSent");
  assert.deepEqual(tapOutcome(3), { outcome: "notSent", reason: "keytap not running" });
  assert.equal(tapOutcome(127).outcome, "notSent");
  for (const c of [4, 5, 124, 137, 1, 64]) assert.equal(tapOutcome(c).outcome, "unknown", "code " + c);
  assert.equal(tapOutcome(124).reason, "keytap timed out");
});

test("reloadNeedsDrain: engine, mic or hotkey changes drain; anything else does not", () => {
  const base = cfg();
  assert.equal(reloadNeedsDrain(base, cfg({ engine: "typeless" })), true);
  assert.equal(reloadNeedsDrain(base, cfg({ mic: "system" })), true);
  assert.equal(reloadNeedsDrain(base, cfg({ typeless: { hotkey: "RightCtrl+Space" } })), true);
  assert.equal(reloadNeedsDrain(base, cfg({ maxSessionSec: 120 })), false);
  assert.equal(reloadNeedsDrain(null, base), false);
});

test("switch Voxtype → Typeless while a remote hold records: Voxtype stops and transcribes before the commit", () => {
  const h = makeHost("voxtype");
  h.state(true, 0);                                         // Voxtype session starts (dbus-owned)
  const start = h.fx.voice.find(e => e.type === "cmd" && e.kind === "start");
  h.apply("voice", h.voice.cmdExit(start.id, 0, 10), 10);
  h.apply("voice", h.voice.status("recording", 20), 20);
  assert.equal(h.begin("typeless", 100).ok, true);
  assert.deepEqual(h.voxCmds(), ["start", "stop"]);
  assert.equal(h.commits().length, 0, "not before Voxtype has the whole utterance");
  assert.equal(h.taps().length, 0);
  const stop = h.fx.voice.find(e => e.type === "cmd" && e.kind === "stop");
  h.apply("voice", h.voice.cmdExit(stop.id, 0, 150), 150);
  assert.equal(h.commits().length, 0, "stopping: Voxtype may still be capturing");
  h.apply("voice", h.voice.status("transcribing", 300), 300);
  assert.equal(h.commits().length, 1);
  assert.equal(h.config.voice.engine, "typeless");
  assert.equal(h.taps().length, 0, "the hold that began under Voxtype never starts Typeless");
  h.state(false, 400);
  h.state(true, 500);
  assert.deepEqual(h.taps().map(t => t.kind), ["start"]);
  assert.deepEqual(h.voxCmds(), ["start", "stop"], "VoiceSession heard nothing under Typeless");
});

test("switch Typeless → Voxtype while a remote hold records: Typeless is stopped before the commit", () => {
  const h = makeHost("typeless");
  h.state(true, 0);
  h.tapResult(1, "sent", 20);
  h.begin("voxtype", 100);
  assert.deepEqual(h.taps().map(t => t.kind), ["start", "stop"]);
  assert.equal(h.commits().length, 0, "the stop tap is still outstanding");
  h.tapResult(2, "sent", 150);
  assert.equal(h.commits().length, 1);
  assert.equal(h.config.voice.engine, "voxtype");
  h.state(false, 200);
  h.state(true, 300);
  assert.deepEqual(h.voxCmds(), ["start"], "Voxtype takes the next hold");
  assert.equal(h.taps().length, 2, "dormant Typeless sends nothing");
});

test("a switch whose Typeless tap never answers commits at 3 s with Typeless unsynced, and still sends no second tap", () => {
  const h = makeHost("typeless");
  h.state(true, 0);                                         // start tap 1 never answered
  h.begin("voxtype", 10);
  h.advance(10 + DRAIN_MS - 1);
  assert.equal(h.commits().length, 0);
  h.advance(10 + DRAIN_MS);
  assert.equal(h.commits().length, 1);
  assert.equal(h.config.voice.engine, "voxtype");
  assert.equal(h.typeless.snapshot().typeless, "unsynced");
  assert.ok(h.fx.typeless.some(e => e.type === "hud" && e.text === "Typeless may still be recording"));
  h.tapResult(1, "sent", 4000);
  assert.equal(h.taps().length, 1);
});

test("review focus 2: a second switch request while one drains is refused, and the first target wins", () => {
  const h = makeHost("typeless");
  h.state(true, 0); h.tapResult(1, "sent", 10);
  assert.equal(h.begin("voxtype", 100).ok, true);
  assert.deepEqual(h.begin("typeless", 110), { ok: false, reason: "busy", effects: [] });
  h.tapResult(2, "sent", 150);
  assert.equal(h.config.voice.engine, "voxtype");
  assert.equal(h.commits().length, 1);
});

test("an external reload that changes the hotkey mid-session drains with the captured chord, then uses the new one", () => {
  const h = makeHost("typeless");
  h.state(true, 0); h.tapResult(1, "sent", 10);
  const next = cfg({ engine: "typeless", typeless: { hotkey: "RightCtrl+Space" } });
  assert.equal(reloadNeedsDrain(h.typeless.config(), next), true);
  h.reload(next, 100);
  const stop = h.taps()[1];
  assert.deepEqual([stop.kind, stop.chord], ["stop", "RightAlt"]);
  h.tapResult(2, "sent", 120);
  assert.equal(h.commits().length, 1);
  assert.equal(h.typeless.config().voice.typeless.hotkey, "RightCtrl+Space");
  h.state(false, 200); h.state(true, 300);
  assert.deepEqual([h.taps()[2].kind, h.taps()[2].chord], ["start", "RightCtrl+Space"]);
});

test("a switch made while idle commits at once, in the same call", () => {
  const h = makeHost("voxtype");
  h.begin("typeless", 10);
  assert.equal(h.commits().length, 1);
  assert.equal(h.voice.snapshot().draining, false, "the commit came after the drain, not before it");
  assert.deepEqual(h.typeless.snapshot().quiesced, []);
});

test("review: shell start under Voxtype with the button already streaming sends no tap at all", () => {
  const s = createTypelessSession(cfg());
  const fx = startTypeless(s, "voxtype", "streaming", 0);
  assert.equal(fx.filter(e => e.type === "tap").length, 0);
  assert.equal(s.snapshot().trusted, true, "the State was taken in");
  assert.equal(s.snapshot().needRelease, true, "the hold that began before the shell never starts Typeless later");
  assert.deepEqual(s.snapshot().quiesced, ["dormant"]);
});

test("shell start: under Typeless a streaming seed starts (discriminating); a released seed arms nothing; no source seeds nothing", () => {
  const t = createTypelessSession(cfg({ engine: "typeless" }));
  assert.deepEqual(startTypeless(t, "typeless", "streaming", 0).filter(e => e.type === "tap").map(e => e.kind), ["start"]);
  const r = createTypelessSession(cfg());
  startTypeless(r, "voxtype", "connected", 0);
  assert.equal(r.snapshot().needRelease, false);
  const n = createTypelessSession(cfg());
  startTypeless(n, "voxtype", null, 0);
  assert.equal(n.snapshot().trusted, false);
});

test("micVoiceView: under Typeless, MicApply sees a busy session until TypelessSession is settled", () => {
  const voice = createVoiceSession(cfg());
  const typeless = createTypelessSession(cfg({ engine: "typeless" }));
  let engine = "typeless";
  const view = micVoiceView(voice, typeless, () => engine);
  assert.equal(view.snapshot().state, "idle");
  typeless.streaming(true, 0);                               // start tap outstanding
  assert.equal(view.snapshot().state, "typeless-busy");
  engine = "voxtype";
  assert.equal(view.snapshot().state, "idle", "under Voxtype only VoiceSession counts");
  assert.equal(view.gate, voice.gate);
});

test("a mic apply under Typeless waits for settled, then rolls back without a tap", () => {
  const h = makeHost("typeless");
  h.state(true, 0); h.tapResult(1, "sent", 10);             // Typeless on, button held
  const mic = createMicApply({ voice: micVoiceView(h.voice, h.typeless, () => h.config.voice.engine) });
  h.apply("typeless", h.typeless.quiesce(20, "mic", "changing microphone"), 20);   // Service quiesces before request()
  assert.deepEqual(h.taps().map(t => t.kind), ["start", "stop"]);
  const req = mic.request("system", 21, {});
  assert.equal(req.result.ok, true);
  mic.systemdJob(false, 22);
  const blocked = mic.backend("idle", 23, { fresh: true });
  assert.equal(blocked.some(e => e.type === "cmd"), false, "nothing mutates while a Typeless tap is in flight");
  h.tapResult(2, "sent", 40);                               // settled
  const go = mic.advance(41);
  const get = go.find(e => e.type === "cmd" && e.kind === "get");
  assert.ok(get, "the reservation proceeds once settled");
  const lit = JSON.stringify({ value: "atvvoice-xiaomi", file_value: "atvvoice-xiaomi" });
  const set = mic.cmdExit(get.id, 0, lit, 50).find(e => e.type === "cmd" && e.kind === "set");
  const rb = mic.cmdExit(set.id, 1, "", 60).find(e => e.type === "cmd" && e.kind === "get");   // set fails → rollback
  const done = mic.cmdExit(rb.id, 0, lit, 70).find(e => e.type === "done");
  assert.equal(done.state, "failed");
  assert.equal(h.taps().length, 2, "rollback never taps");
  h.apply("typeless", h.typeless.resume(80, "mic"), 80);    // Service resumes after the terminal outcome
  assert.equal(h.taps().length, 2, "the still-held button does not restart");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/EngineSwitch.test.mjs`
Expected: FAIL with `Cannot find module '…/lib/EngineSwitch.mjs'`.

- [ ] **Step 3: Implement** `lib/EngineSwitch.mjs`

```js
// Typeless spec §6.1 (routing), §6.2 (drain both engines, then commit), §4.1 (keytap exit codes). Pure; Service.qml
// performs the effects. Extracted so the orchestration is tested under node with the real sessions it drives.
export const DRAIN_MS = 3000;            // §6.2: each session's drain bound
export const KEYTAP_DEADLINE_MS = 2000;  // §6.1: the runner reports by deadline + 1 s, so 3 s at most
const VOICE_GRACE_MS = 1000;             // VoiceSession aborts itself at DRAIN_MS; this only guards against a wedge

// §6.1: which session hears an input. Source updates reach TypelessSession under both engines (it is dormant under
// Voxtype); the mic key, reset and panic reach only the selected engine; the mic key's release only Voxtype.
export function routeTargets(engine, input) {
  const t = engine === "typeless";
  switch (input) {
    case "state": case "sourceLost": return t ? ["typeless"] : ["voice", "typeless"];
    case "micDown": case "reset": return t ? ["typeless"] : ["voice"];
    case "micUp": return t ? [] : ["voice"];
    default: return [];
  }
}

// §4.1 client exit codes, plus the runner's 124/137 and its synthesized 127 (python3 could not be exec'd).
export function tapOutcome(code) {
  if (code === 0) return { outcome: "sent", reason: "" };
  if (code === 2) return { outcome: "notSent", reason: "rejected by keytap" };
  if (code === 3) return { outcome: "notSent", reason: "keytap not running" };
  if (code === 127) return { outcome: "notSent", reason: "python3 not found" };
  if (code === 124 || code === 137) return { outcome: "unknown", reason: "keytap timed out" };
  return { outcome: "unknown", reason: "keytap exit " + code };
}

// §6.2: an external edit of engine, mic or hotkey drains both sessions before the new config applies.
export function reloadNeedsDrain(held, next) {
  if (!held || !next) return false;
  return held.voice.engine !== next.voice.engine || held.voice.mic !== next.voice.mic
      || held.voice.typeless.hotkey !== next.voice.typeless.hotkey;
}

// §6.1 shell start: dormant first, seeded second. Seeding a streaming State into a session that is not yet quiesced
// would tap at once, even under Voxtype. `seedState` is the current source's last State, or null without a source.
export function startTypeless(session, engine, seedState, now) {
  const out = [];
  if (engine !== "typeless") out.push(...session.quiesce(now, "dormant", ""));
  if (seedState === "streaming" || seedState === "connected" || seedState === "disconnected")
    out.push(...session.streaming(seedState === "streaming", now));
  return out;
}

// §6.2 mic apply under Typeless: MicApply waits for an idle voice session; under Typeless it must also wait until
// TypelessSession is settled. This view is what MicApply is given instead of VoiceSession itself.
export function micVoiceView(voice, typeless, engineOf) {
  return {
    snapshot() {
      const s = voice.snapshot();
      if (engineOf() === "typeless" && !typeless.settled()) return Object.assign({}, s, { state: "typeless-busy" });
      return s;
    },
    gate: voice.gate,
  };
}

// §6.2 steps 1-4. kind "switch" commits target; kind "reload" applies a config that is already loaded.
export function createEngineSwitch() {
  let op = null;                         // { kind, target, due, voiceDone, typelessDone }
  function finish(out) {
    if (op && op.voiceDone && op.typelessDone) { out.push({ type: "switchCommit", kind: op.kind, target: op.target }); op = null; }
    return out;
  }
  return {
    busy() { return op !== null; },
    begin(kind, target, now) {
      if (op) return { ok: false, reason: "busy", effects: [] };
      op = { kind, target, due: now + DRAIN_MS, voiceDone: false, typelessDone: false };
      return { ok: true, effects: [{ type: "drainStart", kind, target }] };
    },
    progress(s, now) {
      if (!op) return [];
      if (s.voiceDrained) op.voiceDone = true;
      if (s.typelessSettled) op.typelessDone = true;
      return finish([]);
    },
    advance(now) {
      const out = [];
      if (!op) return out;
      if (!op.typelessDone && now >= op.due) { op.typelessDone = true; out.push({ type: "typelessExpired" }); }
      if (!op.voiceDone && now >= op.due + VOICE_GRACE_MS) {
        op.voiceDone = true;
        out.push({ type: "log", text: "VoiceSession did not drain after its own abort; switching anyway" });
      }
      return finish(out);
    },
    nextDeadline() {
      if (!op) return null;
      if (!op.typelessDone) return op.due;
      return op.voiceDone ? null : op.due + VOICE_GRACE_MS;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/EngineSwitch.test.mjs`
Expected: PASS, 13 tests. Mutation check: swap the two statements in `startTypeless`, so it seeds first and goes
dormant second. "review: shell start under Voxtype…" must fail. Revert afterwards.

Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 5: Add the module to the QML load check.** Add `import "../../lib/EngineSwitch.mjs" as EngineSwitch`
  to `tests/harness/ModuleLoad.qml`, and add this element to `checks`:

```js
            , EngineSwitch.routeTargets("typeless", "state").length
```

Run: `make lint`
Expected: `module-load: ok`.

- [ ] **Step 6: Commit**

```bash
git add lib/EngineSwitch.mjs tests/EngineSwitch.test.mjs tests/harness/ModuleLoad.qml
git commit -m "feat(typeless): engine routing, tap outcomes and drain-then-commit switch (pure)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---
### Task 10: Service wiring

**Files:**
- Modify: `Service.qml`. The 25 exact replacements are below; each "Replace" text occurs exactly once.
- Modify: `lib/Presentation.mjs` (one constant)
- Create: `tests/fakes/bin/omaremote-keytap` (mode 0755)
- Modify: `tests/fake-remote.sh`:
  - an export;
  - `reset_fakes`;
  - new scenarios before `# ---- summary`.

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces:
  - IPC `engine <voxtype|typeless>` → `ok | busy | invalid-engine | not-ready`.
  - Status fields `engine`, `typeless.state` (a TypelessSession snapshot) and `typeless.switching`.
  - Service functions `setEngine(name)` and `typelessCall(label, fn)`.
  - Properties `switching`, `typelessSnap`, `engineName`.
  - `Presentation.TYPELESS_FLASH`.
  - Task 11 builds the display on `typelessSnap` and `switching`.
- The orchestration follows `makeHost` in `tests/EngineSwitch.test.mjs` (Task 9). Two Service-specific rules:
  - `pumpOrchestration()` runs at the start of every `rearm()`, and it never re-enters.
  - Switch effects run with `_pumping` set (`runSwitch`), so `switchCommit` cannot fire inside `drainStart`.

- [ ] **Step 1: Add the fake keytap client** `tests/fakes/bin/omaremote-keytap`

```bash
#!/usr/bin/env bash
# Typeless spec §9: fake omaremote-keytap client for the harness (OMAREMOTE_KEYTAP). Logs "tap <chord>" to keytap.log.
#   knobs in $OMAREMOTE_FAKE_DIR: keytap.code (exit code, default 0), keytap.sleep (seconds before answering)
set -u
d=${OMAREMOTE_FAKE_DIR:?}
printf '%s\n' "$*" >> "$d/keytap.log"
[[ -e $d/keytap.sleep ]] && sleep "$(cat "$d/keytap.sleep")"
exit "$(cat "$d/keytap.code" 2>/dev/null || echo 0)"
```

Then: `chmod 0755 tests/fakes/bin/omaremote-keytap`

In `tests/fake-remote.sh`, add after the `export OMAREMOTE_DISPATCH=hyprctl …` line:

```bash
export OMAREMOTE_KEYTAP=$ROOT/tests/fakes/bin/omaremote-keytap   # Typeless taps go to the fake client, never to uinput
```

and add to `reset_fakes()`, after the line that starts `echo idle > "$F/vox.state"`:

```bash
  : > "$F/keytap.log"
```

Give `scenario` an optional third argument, a function run after `reset_fakes` and before the harness starts, for
state that must exist at shell start. Replace its first three lines:

```bash
scenario() {   # scenario <name> <function>
  local name=$1 fn=$2
  [[ -n $ONLY && $ONLY != "$name" ]] && return 0
  reset_fakes
```

with:

```bash
scenario() {   # scenario <name> <function> [prestart-function]
  local name=$1 fn=$2 pre=${3:-}
  [[ -n $ONLY && $ONLY != "$name" ]] && return 0
  reset_fakes
  [[ -n $pre ]] && "$pre"
```

- [ ] **Step 2: Write the failing scenarios** (append to `tests/fake-remote.sh`, before `# ---- summary`)

```bash
# ---- Plan 5 Task 10: the Typeless engine through the Service ----
taps_n() { wc -l < "$F/keytap.log" | tr -d ' '; }
wait_taps() {   # wait_taps <n>: keytap.log holds exactly n taps within 3 s
  local i=0
  while (( i < 60 )); do [[ $(taps_n) == "$1" ]] && return 0; sleep 0.05; i=$((i + 1)); done
  echo "    keytap.log has $(taps_n) taps, want $1:"; sed 's/^/      /' "$F/keytap.log"; return 1
}
settled_switch() { wait_for '.typeless.switching' false 5; }
use_typeless() { set_cfg '.voice.engine = "typeless"' '.engine' typeless && settled_switch && wait_for '.typeless.state.quiesced | length' 0 3; }

s_typeless_remote_hold_taps_start_and_stop() {
  ready || return 1
  use_typeless || return 1
  ipc voice state streaming >/dev/null
  wait_taps 1 || return 1
  has_line "$F/keytap.log" "tap RightAlt" || return 1
  wait_for '.typeless.state.typeless' on 3 || return 1
  ipc voice state connected >/dev/null
  wait_taps 2 || return 1
  wait_for '.typeless.state.typeless' off 3 || return 1
  ! grep -q 'record start' "$F/vox.log" || { echo "    voxtype was started under Typeless"; return 1; }
}
scenario typeless_remote_hold_taps_start_and_stop s_typeless_remote_hold_taps_start_and_stop

s_typeless_system_press_toggles() {
  ready || return 1
  set_cfg '.voice.engine = "typeless" | .voice.mic = "system"' '.voiceMode' system || return 1
  settled_switch || return 1
  wait_for '.engine' typeless 3 || return 1
  ipc key mic down >/dev/null; ipc key mic up >/dev/null
  wait_taps 1 || return 1
  ipc key mic down >/dev/null; ipc key mic up >/dev/null
  wait_taps 2 || return 1
  ! grep -q 'record start' "$F/vox.log" || { echo "    voxtype was started under Typeless"; return 1; }
}
scenario typeless_system_press_toggles s_typeless_system_press_toggles

s_typeless_keytap_not_running_shows_hud() {
  ready || return 1
  echo 3 > "$F/keytap.code"
  use_typeless || return 1
  ipc voice state streaming >/dev/null
  wait_for '.hud' "Typeless trigger failed: keytap not running" 3 || return 1
  wait_for '.typeless.state.typeless' off 3
}
scenario typeless_keytap_not_running_shows_hud s_typeless_keytap_not_running_shows_hud

s_engine_switch_ipc_commits() {
  ready || return 1
  [[ $(ipc engine typeless) == ok ]] || return 1
  wait_for '.engine' typeless 3 || return 1
  settled_switch || return 1
  wait_for '.typeless.state.quiesced | length' 0 3 || return 1
  [[ $(jq -r '.voice.engine' "$XDG_CONFIG_HOME/omaremote/config.json") == typeless ]] || { echo "    engine not written"; return 1; }
  [[ $(ipc engine bogus) == invalid-engine ]]
}
scenario engine_switch_ipc_commits s_engine_switch_ipc_commits

s_engine_switch_drains_voxtype_session() {   # §9 hardware item 6, without hardware
  ready || return 1
  ipc voice state streaming >/dev/null
  wait_for '.voice.state' recording 3 || return 1
  [[ $(ipc engine typeless) == ok ]] || return 1
  settled_switch || return 1
  has_line "$F/vox.log" "voxtype record stop" || return 1
  [[ $(jget '.engine') == typeless ]] || return 1
  [[ $(taps_n) == 0 ]] || { echo "    the hold that began under Voxtype started Typeless"; return 1; }
  ipc voice state connected >/dev/null
  ipc voice state streaming >/dev/null
  wait_taps 1
}
scenario engine_switch_drains_voxtype_session s_engine_switch_drains_voxtype_session

s_typeless_switch_back_stops_typeless() {    # §9 hardware item 7, without hardware
  ready || return 1
  use_typeless || return 1
  ipc voice state streaming >/dev/null
  wait_for '.typeless.state.typeless' on 3 || return 1
  [[ $(ipc engine voxtype) == ok ]] || return 1
  wait_taps 2 || return 1
  settled_switch || return 1
  [[ $(jget '.engine') == voxtype ]] || return 1
  ipc voice state connected >/dev/null
  sleep 0.3
  [[ $(taps_n) == 2 ]] || { echo "    dormant Typeless tapped"; return 1; }
}
scenario typeless_switch_back_stops_typeless s_typeless_switch_back_stops_typeless

s_dormant_under_voxtype_never_taps() {
  ready || return 1
  local i
  for i in 1 2 3; do
    ipc voice state streaming >/dev/null; sleep 0.15
    ipc voice state connected >/dev/null; wait_for '.voice.state' idle 5 || return 1
  done
  [[ $(taps_n) == 0 ]] || { echo "    a dormant TypelessSession tapped"; return 1; }
}
scenario dormant_under_voxtype_never_taps s_dormant_under_voxtype_never_taps

s_typeless_reset_while_holding() {           # §9 hardware item 4, without hardware
  ready || return 1
  use_typeless || return 1
  ipc voice state streaming >/dev/null
  wait_for '.typeless.state.typeless' on 3 || return 1
  ipc reset >/dev/null
  wait_taps 2 || return 1
  wait_for '.typeless.state.typeless' off 3 || return 1
  sleep 0.3
  [[ $(taps_n) == 2 ]] || { echo "    the still-held button restarted Typeless"; return 1; }
}
scenario typeless_reset_while_holding s_typeless_reset_while_holding

# Review: a shell started while the button streams. The startup order itself is pinned by EngineSwitch.test.mjs
# (startTypeless); these two check the wired result end to end, whichever of State and config arrives first.
pre_streaming() { echo streaming > "$F/atv.state"; }
pre_streaming_typeless() { pre_streaming; mkdir -p "$XDG_CONFIG_HOME/omaremote"; echo '{"voice":{"engine":"typeless"}}' > "$XDG_CONFIG_HOME/omaremote/config.json"; }
s_startup_streaming_under_voxtype_no_tap() {
  wait_for '.config' true 5 || return 1
  wait_for '.typeless.state.streaming' true 3 || return 1          # the State was seen...
  sleep 0.5
  [[ $(taps_n) == 0 ]] || { echo "    startup tapped under Voxtype:"; sed 's/^/      /' "$F/keytap.log"; return 1; }   # ...and nothing tapped
}
scenario startup_streaming_under_voxtype_no_tap s_startup_streaming_under_voxtype_no_tap pre_streaming
s_startup_streaming_under_typeless_taps() {      # discriminating: the same start under Typeless does tap
  wait_for '.engine' typeless 5 || return 1
  wait_taps 1
}
scenario startup_streaming_under_typeless_taps s_startup_streaming_under_typeless_taps pre_streaming_typeless

# Review: a refused second mic request must not release the "mic" holder of the apply still running.
s_typeless_second_mic_request_keeps_first_paused() {
  ready || return 1
  use_typeless || return 1
  echo 1 > "$F/vox.get-delay"                                       # keep the first apply pending for a while
  [[ $(ipc mic system | jq -r '.ok') == true ]] || return 1
  wait_for '.typeless.state.quiesced | index("mic") != null' true 3 || return 1
  [[ $(ipc mic system | jq -r '.reason') == busy ]] || { echo "    the second request was not refused"; return 1; }
  [[ $(jget '.typeless.state.quiesced | index("mic") != null') == true ]] || { echo "    the first apply lost its pause"; return 1; }
  wait_for '.mic.pending' false 20 || return 1
  wait_for '.typeless.state.quiesced | length' 0 3
}
scenario typeless_second_mic_request_keeps_first_paused s_typeless_second_mic_request_keeps_first_paused
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bash tests/fake-remote.sh typeless_remote_hold_taps_start_and_stop; bash tests/fake-remote.sh engine_switch_ipc_commits`
Expected: both FAIL. `.engine` is `null`, and `ipc engine` is an unknown method.

- [ ] **Step 4: The flash constant.** Append to `lib/Presentation.mjs`:

```js

// Typeless spec §6.3: what system mode flashes on each tap; Typeless's own Status bar shows the real state.
export const TYPELESS_FLASH = "Typeless ⏯";
```

- [ ] **Step 5: Service edits.** Apply each replacement below to `Service.qml`, in order.

**Imports.**

Replace:

```qml
import "lib/ConfigWrites.mjs" as ConfigWrites
```

with:

```qml
import "lib/ConfigWrites.mjs" as ConfigWrites
import "lib/TypelessSession.mjs" as TypelessSession
import "lib/EngineSwitch.mjs" as EngineSwitch
```


**Properties.**

Replace:

```qml
  readonly property bool dispatchViaHyprctl: Quickshell.env("OMAREMOTE_DISPATCH") === "hyprctl"   // harness only
```

with:

```qml
  readonly property bool dispatchViaHyprctl: Quickshell.env("OMAREMOTE_DISPATCH") === "hyprctl"   // harness only
  readonly property string keytapOverride: Quickshell.env("OMAREMOTE_KEYTAP") || ""                // harness only: a fake keytap client
```

Replace:

```qml
  property var voice: null
```

with:

```qml
  property var voice: null
  property var typeless: null                     // Typeless spec §5; dormant (held quiesced) under Voxtype
  readonly property var switcher: EngineSwitch.createEngineSwitch()
  property bool switching: false                  // an engine switch or engine/mic/hotkey reload is draining
  property var typelessSnap: null
  property bool _pumping: false
  property string _typelessSender: ""             // the ATVVoice source TypelessSession's facts belong to
  property int _typelessGeneration: -1
  readonly property string engineName: root.config ? root.config.voice.engine : "voxtype"
```


**Effect router.**

Replace:

```qml
      case "state": root.onVoiceState(e); break
```

with:

```qml
      case "state": if (src === "typeless") root.onTypelessState(e); else root.onVoiceState(e); break
      // ---- Typeless engine effects (Typeless spec §5, §6) ----
      case "tap": root.runTap(e); break
      case "log": console.log("omaremote: " + src + ": " + e.text); break
      case "drainStart": root.onDrainStart(); break
      case "typelessExpired": root.typelessCall("forceUnsynced", function(n) { return root.typeless.forceUnsynced(n) }); break
      case "switchCommit": root.onSwitchCommit(e); break
```

Replace:

```qml
      case "done": root.micLast = e; root.micPending = mic.pending(); if (e.state !== "queued") root.refreshDoctor(); break
```

with:

```qml
      case "done":
        root.micLast = e; root.micPending = mic.pending(); if (e.state !== "queued") root.refreshDoctor()
        if (!mic.pending()) root.typelessCall("resume", function(n) { return root.typeless.resume(n, "mic") })   // §6.2: after the terminal outcome
        break
```


**Deadlines, rearm and advanceAll.**

Replace:

```qml
    return [engine ? engine.nextDeadline() : null, voice ? voice.nextDeadline() : null, mic ? mic.nextDeadline() : null, verifier.nextDeadline(),
      selftest ? selftest.nextDeadline() : null]
```

with:

```qml
    return [engine ? engine.nextDeadline() : null, voice ? voice.nextDeadline() : null, mic ? mic.nextDeadline() : null, verifier.nextDeadline(),
      selftest ? selftest.nextDeadline() : null, typeless ? typeless.nextDeadline() : null, root.switcher.nextDeadline()]
```

Replace:

```qml
  function rearm() {
    root.micPending
```

with:

```qml
  function rearm() {
    root.pumpOrchestration()
    root.micPending
```

Replace:

```qml
    if (voice) root.dispatch(root.guarded("voice.advance", function() { return voice.advance(now) }), "voice")
```

with:

```qml
    if (voice) root.dispatch(root.guarded("voice.advance", function() { return voice.advance(now) }), "voice")
    if (typeless) root.dispatch(root.guarded("typeless.advance", function() { return typeless.advance(now) }), "typeless")
```

Replace:

```qml
    if (selftest) root.dispatch(root.guarded("selftest.advance", function() { return selftest.advance(now) }), "selftest")
    root.rearm()
  }
```

with:

```qml
    if (selftest) root.dispatch(root.guarded("selftest.advance", function() { return selftest.advance(now) }), "selftest")
    root.runSwitch(root.guarded("switch.advance", function() { return root.switcher.advance(now) }))
    root.rearm()
  }
```


**Config changes.**

Replace:

```qml
    if (kind === "commit") {                                        // §6.2: the internal voice.mic write reloads and aborts nothing,
      if (voice) {                                                  // but _write replaced the config object: refresh what reads voice.mic
        root.guarded("voice.setConfig", function() { voice.setConfig(configStore.config); return [] })
```

with:

```qml
    if (kind === "commit") {                                        // §6.2: the internal voice.mic write reloads and aborts nothing,
      if (voice) {                                                  // but _write replaced the config object: refresh what reads voice.mic
        root.guarded("voice.setConfig", function() { voice.setConfig(configStore.config); return [] })
        root.typelessCall("setConfig", function(n) { return typeless.setConfig(configStore.config, n) })
```

Replace:

```qml
    if (kind === "hotkey") {
      if (voice) root.guarded("voice.setConfig", function() { voice.setConfig(configStore.config); return [] })
      root.rearm()
```

with:

```qml
    if (kind === "hotkey") {
      if (voice) root.guarded("voice.setConfig", function() { voice.setConfig(configStore.config); return [] })
      root.typelessCall("setConfig", function(n) { return typeless.setConfig(configStore.config, n) })   // the running session keeps its chord
      root.rearm()
```

Replace:

```qml
    if (voice) {
      if (kind === "external") root.dispatch(root.guarded("voice.abort", function() { return voice.abort(now) }), "voice")     // §5.2: config reload aborts
      root.guarded("voice.setConfig", function() { voice.setConfig(configStore.config); return [] })
      root.updateRemoteWarning()
    }
```

with:

```qml
    if (voice) {
      // Typeless spec §6.2: an external edit of engine, mic or hotkey drains both sessions with their old config;
      // the commit applies the new one. If a drain is already running, its commit applies configStore.config,
      // which already holds this edit. Every other external reload keeps the §5.2 abort.
      if (kind === "external" && typeless && EngineSwitch.reloadNeedsDrain(typeless.config(), configStore.config)) {
        root.beginDrain("reload", configStore.config.voice.engine)
        root.rearm()
        return
      }
      if (kind === "external") root.dispatch(root.guarded("voice.abort", function() { return voice.abort(now) }), "voice")     // §5.2: config reload aborts
      root.guarded("voice.setConfig", function() { voice.setConfig(configStore.config); return [] })
      root.typelessCall("setConfig", function(n) { return typeless.setConfig(configStore.config, n) })
      root.updateRemoteWarning()
    }
```


**startModules.**

Replace:

```qml
    mic = MicApply.createMicApply({ voice: voice })
```

with:

```qml
    typeless = TypelessSession.createTypelessSession(configStore.config)
    // Typeless §6.1: dormant first, then seeded with the current source's last State (read before the session
    // existed). startTypeless owns that order; tests/EngineSwitch.test.mjs pins it.
    root._typelessSender = atv.sender || ""; root._typelessGeneration = atv.generation
    root.dispatch(root.guarded("typeless.start", function() {
      return EngineSwitch.startTypeless(typeless, configStore.config.voice.engine, atv.sender ? root.remoteState : null, now)
    }), "typeless")
    root.typelessSnap = typeless.snapshot()
    mic = MicApply.createMicApply({ voice: EngineSwitch.micVoiceView(voice, typeless, function() { return root.engineName }) })
```


**Mic key.**

Replace:

```qml
    if (name === "mic" && root.config.voice.mic === "remote") { root.rearm(); return true }
```

with:

```qml
    // Typeless spec §6.1: under Typeless the mic key's press edge goes to TypelessSession (one tap in system mode,
    // nothing in remote mode) and its release is dropped, whatever keys.mic.trigger says.
    if (name === "mic" && root.engineName === "typeless") {
      if (edge === "down") root.typelessCall("hidPress", function(n) { return typeless.hidPress(n) })
      root.rearm()
      return true
    }
    if (name === "mic" && root.config.voice.mic === "remote") { root.rearm(); return true }
```


**Reset.**

Replace:

```qml
    if (voice) root.dispatch(root.guarded("voice.abort", function() { return voice.abort(Date.now()) }), "voice")                // §4.3: cancel, never stop
```

with:

```qml
    var targets = EngineSwitch.routeTargets(root.engineName, "reset")                                                       // Typeless §6.1/§6.2
    if (voice && targets.indexOf("voice") >= 0) root.dispatch(root.guarded("voice.abort", function() { return voice.abort(Date.now()) }), "voice")   // §4.3: cancel, never stop
    if (targets.indexOf("typeless") >= 0) root.typelessCall("reset", function(n) { return typeless.reset(n) })
```


**Remote warning.**

Replace:

```qml
    var warn = mode === "remote" && (!root.atvBusName || !root.remoteNode || root.voxAudioDevice !== root.remoteNode)
```

with:

```qml
    // Under Typeless, Voxtype's audio.device plays no part in remote mode; only the ATVVoice source must be ready.
    var warn = mode === "remote" && (!root.atvBusName || !root.remoteNode || (root.engineName !== "typeless" && root.voxAudioDevice !== root.remoteNode))
```


**Keytap results.**

Replace:

```qml
      if (src === "mic" && root.mic) root.dispatch(root.guarded("mic.cmdExit", function() { return root.mic.cmdExit(id, code, stdout, now) }), "mic")
```

with:

```qml
      if (src === "mic" && root.mic) root.dispatch(root.guarded("mic.cmdExit", function() { return root.mic.cmdExit(id, code, stdout, now) }), "mic")
      if (src === "keytap" && root.typeless) {
        var o = EngineSwitch.tapOutcome(code)
        root.typelessCall("tapResult", function(n) { return root.typeless.tapResult(id, o.outcome, o.reason, n) })
      }
```


**ATVVoice source changes.**

Replace:

```qml
      if (root.voice) {
        root.voice.setDbusSource({ sender: sender || null, generation: generation })
        // Plan 4 §4.5: a revoked/lost source can never send the `connected` that ends a dbus session.
        if (!sender) root.dispatch(root.guarded("voice.sourceLost", function() { return root.voice.sourceLost(Date.now()) }), "voice")
      }
```

with:

```qml
      if (root.voice) {
        root.voice.setDbusSource({ sender: sender || null, generation: generation })
        // Plan 4 §4.5: a revoked/lost source can never send the `connected` that ends a dbus session.
        if (!sender && EngineSwitch.routeTargets(root.engineName, "sourceLost").indexOf("voice") >= 0)
          root.dispatch(root.guarded("voice.sourceLost", function() { return root.voice.sourceLost(Date.now()) }), "voice")
      }
      // Typeless §5.2: a lost or replaced source makes streaming unknown. A first discovery does not: the session's
      // streaming is already unknown, and arming then would swallow the first hold.
      if (root.typeless && root._typelessSender !== "" && (sender !== root._typelessSender || generation !== root._typelessGeneration))
        root.typelessCall("sourceLost", function(n) { return root.typeless.sourceLost(n) })
      root._typelessSender = sender || ""; root._typelessGeneration = generation
```


**ATVVoice State.**

Replace:

```qml
    onSignalEvent: function(ev) {
      root.remoteState = ev.state
      if (root.voice) root.dispatch(root.guarded("voice.dbus", function() { return root.voice.dbus(ev, Date.now()) }), "voice")
      root.rearm()
    }
```

with:

```qml
    onSignalEvent: function(ev) { root.onAtvState(ev) }
```

Replace:

```qml
      root.dispatch(root.guarded("voice.dbus", function() { return voice.dbus({ state: arg, sender: atv.sender, path: atv.path, interface: atv.iface, member: "MicStateChanged", generation: atv.generation }, now) }), "voice")
      root.remoteState = arg
      root.rearm()
      return JSON.stringify({ ok: true })
```

with:

```qml
      root.onAtvState({ state: arg, sender: atv.sender, path: atv.path, interface: atv.iface, member: "MicStateChanged", generation: atv.generation })
      return JSON.stringify({ ok: true })
```


**Mic apply under Typeless.**

Replace:

```qml
    if (!mic) return JSON.stringify({ ok: false, reason: "not-ready" })
    var now = Date.now()
    var r = root.guarded("mic.request", function() { return mic.request(mode, now, { nodeName: root.remoteNode }) },
                          { effects: [], result: { ok: false, reason: "error" } })
    root.dispatch(r.effects, "mic")
```

with:

```qml
    if (!mic) return JSON.stringify({ ok: false, reason: "not-ready" })
    // Refused before any quiesce: a second request must never touch the "mic" holder the pending apply owns.
    if (root.switcher.busy() || mic.pending()) return JSON.stringify({ ok: false, reason: "busy" })
    var now = Date.now()
    // Typeless §6.2: under Typeless the apply first quiesces TypelessSession; MicApply (through micVoiceView) waits
    // until it is settled. The "done" effect resumes it after the terminal outcome.
    var underTypeless = root.engineName === "typeless"
    if (underTypeless) root.typelessCall("quiesce", function(n) { return typeless.quiesce(n, "mic", "changing microphone") })
    var r = root.guarded("mic.request", function() { return mic.request(mode, now, { nodeName: root.remoteNode }) },
                          { effects: [], result: { ok: false, reason: "error" } })
    if (underTypeless && !r.result.ok) root.typelessCall("resume", function(n) { return typeless.resume(n, "mic") })
    root.dispatch(r.effects, "mic")
```


**New functions.**

Replace:

```qml
  // ---- Typeless hotkey (Typeless spec §4.3 step 5) -----------------------------------
```

with:

```qml
  // ---- Typeless engine (Typeless spec §5, §6) ----------------------------------------
  function typelessCall(label, fn) {
    if (!root.typeless) return
    var now = Date.now()
    root.dispatch(root.guarded("typeless." + label, function() { return fn(now) }), "typeless")
  }
  function onTypelessState(e) { root.typelessSnap = e.state }
  function onAtvState(ev) {                                     // §6.1: State changes reach TypelessSession under both engines
    var now = Date.now()
    root.remoteState = ev.state
    var targets = EngineSwitch.routeTargets(root.engineName, "state")
    if (root.voice && targets.indexOf("voice") >= 0) root.dispatch(root.guarded("voice.dbus", function() { return root.voice.dbus(ev, now) }), "voice")
    if (root.typeless && targets.indexOf("typeless") >= 0 && ev.sender === atv.sender && ev.generation === atv.generation)
      root.typelessCall("streaming", function(n) { return root.typeless.streaming(ev.state === "streaming", n) })
    root.rearm()
  }
  function keytapArgv(chord) {
    return root.keytapOverride ? [root.keytapOverride, "tap", chord]
                               : ["python3", "-I", Quickshell.env("HOME") + "/.local/lib/omaremote/omaremote-keytap", "tap", chord]
  }
  function runTap(e) {
    runner.run("keytap", e.id, root.keytapArgv(e.chord), EngineSwitch.KEYTAP_DEADLINE_MS)
    if (e.kind === "press") root.showFlash(Presentation.TYPELESS_FLASH, root.flashMs)   // §6.3: system mode flashes each tap
  }
  function applyDormancy() {                                    // §6.1: held quiesced (silently) whenever Voxtype is selected
    if (root.engineName === "typeless") root.typelessCall("resume", function(n) { return root.typeless.resume(n, "dormant") })
    else root.typelessCall("quiesce", function(n) { return root.typeless.quiesce(n, "dormant", "") })
  }
  // §6.2: the switch commits once both sessions are drained, and a queued mic apply under Typeless retries its
  // reservation once TypelessSession settles. Runs at the start of every rearm(), which follows every module call,
  // and never re-enters: switch effects run with _pumping set, so a commit cannot land in the middle of drainStart.
  function pumpOrchestration() {
    if (root._pumping || !root.voice || !root.typeless) return
    root._pumping = true
    try {
      var now = Date.now()
      if (root.switcher.busy()) {
        var fx = root.switcher.progress({ voiceDrained: root.voice.drained(), typelessSettled: root.typeless.settled() }, now)
        if (fx.length) root.dispatch(fx, "switch")
      }
      if (root.mic && root.mic.pending() && root.engineName === "typeless") root.dispatch(root.mic.advance(now), "mic")
    } catch (err) { root.errorCount++; root.lastError = "orchestration: " + err; console.log("omaremote: orchestration threw: " + err) }
    finally { root._pumping = false }
  }
  function runSwitch(effects) {
    var was = root._pumping
    root._pumping = true
    try { root.dispatch(effects, "switch") } finally { root._pumping = was }
  }
  function beginDrain(kind, target) {
    var r = root.switcher.begin(kind, target, Date.now())
    if (r.ok) { root.switching = true; root.runSwitch(r.effects) }
    root.rearm()
    return r.ok
  }
  function setEngine(name) {                                    // the Panel's Engine row and the `engine` IPC
    if (name !== "voxtype" && name !== "typeless") return "invalid-engine"
    if (!root.voice || !root.typeless) return "not-ready"
    if (root.switcher.busy() || (root.mic && root.mic.pending()) || root.selftestActive) return "busy"
    if (root.engineName === name) return "ok"
    root.beginDrain("switch", name)
    return "ok"
  }
  function onDrainStart() {
    root.hudText = "switching engine"
    root.typelessCall("quiesce", function(n) { return root.typeless.quiesce(n, "switch", "switching engine") })
    var now = Date.now()
    root.dispatch(root.guarded("voice.drain", function() { return root.voice.drain(now) }), "voice")
  }
  function onSwitchCommit(e) {
    var now = Date.now()
    if (e.kind === "switch") configStore.setVoiceEngine(e.target)          // emits changed("engine"), applied here
    var c = configStore.config
    root.guarded("voice.setConfig", function() { root.voice.setConfig(c); return [] })
    root.typelessCall("setConfig", function(n) { return root.typeless.setConfig(c, n) })
    root.dispatch(root.guarded("voice.undrain", function() { return root.voice.undrain(now, root.remoteState) }), "voice")
    root.applyDormancy()
    root.typelessCall("resume", function(n) { return root.typeless.resume(n, "switch") })
    root.switching = false
    if (root.hudText === "switching engine") root.hudText = ""
    root.updateRemoteWarning()
    root.refreshDoctor()
  }

  // ---- Typeless hotkey (Typeless spec §4.3 step 5) -----------------------------------
```


**Status.**

Replace:

```qml
      , typeless: { hotkey: root.config ? root.config.voice.typeless.hotkey : null, hotkeyStored: root.hotkeyStored() }
```

with:

```qml
      , engine: root.engineName
      , typeless: { hotkey: root.config ? root.config.voice.typeless.hotkey : null, hotkeyStored: root.hotkeyStored(),
                    state: root.typeless ? root.typeless.snapshot() : null, switching: root.switching }
```


**IPC.**

Replace:

```qml
    function typelessHotkey(chord: string): string { return root.ipcTypelessHotkey(chord) }
```

with:

```qml
    function typelessHotkey(chord: string): string { return root.ipcTypelessHotkey(chord) }
    function engine(name: string): string { return root.setEngine(name) }
```


**Shell exit.**

Replace:

```qml
        if (snap.pluginMic) atv.micClose()
      }
```

with:

```qml
        if (snap.pluginMic) atv.micClose()
      }
      // Typeless §6.2: only a remote `on` session with nothing outstanding; a stop after an unconfirmed start could
      // itself start a recording.
      if (typeless) { var chord = typeless.exitStop(); if (chord) Quickshell.execDetached(root.keytapArgv(chord)) }
```


- [ ] **Step 6: Run the new scenarios, then everything**

Run each: `bash tests/fake-remote.sh <name>` for the eleven scenarios added in Step 2.
Expected: `ok` for each.

Run: `bash tests/fake-remote.sh`
Expected: `integration: 70 passed, 0 failed`. That is the 56 existing scenarios, plus 3 from Task 5 and 11 from this
task. The voice scenarios exercise the refactored `onAtvState`, `onSource` and reset paths under Voxtype.

Run: `make check; echo MAKE_CHECK_EXIT=$?`
Expected: `MAKE_CHECK_EXIT=0`.

- [ ] **Step 7: Commit**

```bash
git add Service.qml lib/Presentation.mjs tests/fakes/bin/omaremote-keytap tests/fake-remote.sh
git commit -m "feat(typeless): Service wiring — routing, keytap taps, drain-then-commit engine switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---
### Task 11: Presentation, bar, HUD and the Voice tab Engine row

**Files:**
- Modify: `lib/Presentation.mjs`:
  - `glyphLook`, `hudLine`;
  - new `typelessView`, `engineStatusLine`, `TYPELESS_MIC_HINT`.
- Modify: `Service.qml`:
  - the `typelessView` property;
  - `hudLine`, the elapsed timer, `syncHud`, status.
- Modify: `BarWidget.qml`:
  - the `warning` look;
  - the Typeless tooltip.
- Modify: `components/VoiceTab.qml`:
  - the Engine row as row 0, with the other rows shifted by one;
  - the hotkey/keytap line;
  - the mic hint.
- Test: `tests/Presentation.test.mjs` (append; extend its import)

**Interfaces:**
- Consumes: `typelessSnap`, `switching`, `setEngine` and `engineName` (Task 10); `doctorFacts.typeless` (Task 12;
  until then the line reads `keytap: unknown`).
- Produces:
  - `Presentation.typelessView(snap) → "idle"|"recording"|"unsynced"`;
  - `Presentation.engineStatusLine(cfg, facts)`;
  - `Presentation.TYPELESS_MIC_HINT`;
  - `glyphLook` now returns `"warning"` for `typeless: "unsynced"`;
  - Service gains `typelessView` and the status field `typeless.view`.

- [ ] **Step 1: Write the failing tests.** In `tests/Presentation.test.mjs`, extend the import from
  `../lib/Presentation.mjs` with `typelessView, engineStatusLine, TYPELESS_FLASH`, then append:

```js
// ---- Typeless engine (Typeless spec §6.3) ----
test("typelessView: recording while on or a start is in flight, a warning while unsynced, idle otherwise and in system mode", () => {
  const snap = (o) => Object.assign({ mode: "remote", typeless: "off", outstanding: null }, o);
  assert.equal(typelessView(null), "idle");
  assert.equal(typelessView(snap({})), "idle");
  assert.equal(typelessView(snap({ outstanding: { id: 1, kind: "start" } })), "recording");
  assert.equal(typelessView(snap({ typeless: "on" })), "recording");
  assert.equal(typelessView(snap({ typeless: "on", outstanding: { id: 2, kind: "stop" } })), "recording", "a stop in flight keeps the display");
  assert.equal(typelessView(snap({ typeless: "unsynced", outstanding: { id: 3, kind: "start" } })), "unsynced");
  assert.equal(typelessView(snap({ mode: "system", outstanding: { id: 1, kind: "press" } })), "idle");
});

test("glyphLook and hudLine show Typeless recording and the unsynced warning", () => {
  assert.equal(glyphLook({ voiceState: "idle", typeless: "recording" }), "recording");
  assert.equal(glyphLook({ voiceState: "idle", typeless: "unsynced" }), "warning");
  assert.equal(glyphLook({ voiceState: "idle", typeless: "idle" }), "ready");
  assert.equal(glyphLook({ voiceState: "idle", typeless: "recording", selftest: true }), "selftest", "a self-test still wins");
  assert.equal(hudLine({ voiceState: "idle", typeless: "recording", elapsedMs: 12000, hudText: "" }), "● Typeless 00:12");
  assert.equal(hudLine({ voiceState: "idle", typeless: "recording", elapsedMs: 0, hudText: "max session reached" }), "● Typeless 00:00 · max session reached");
  assert.equal(hudLine({ voiceState: "idle", typeless: "recording", elapsedMs: 0, flash: "Typeless ⏯" }), "Typeless ⏯");
  assert.equal(hudLine({ voiceState: "idle", typeless: "unsynced", hudText: "Typeless state unknown — check Typeless; press reset when it is stopped" }),
               "Typeless state unknown — check Typeless; press reset when it is stopped");
});

test("engineStatusLine reports the hotkey and whether keytap runs", () => {
  const c = normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, engine: "typeless", typeless: { hotkey: "RightAlt+RightShift" } } }).config;
  assert.equal(engineStatusLine(c, null), "hotkey: RightAlt+RightShift · keytap: unknown");
  assert.equal(engineStatusLine(c, { typeless: { keytapActive: true, keytapDevice: true } }), "hotkey: RightAlt+RightShift · keytap: running");
  assert.equal(engineStatusLine(c, { typeless: { keytapActive: true, keytapDevice: false } }), "hotkey: RightAlt+RightShift · keytap: not running");
  assert.equal(engineStatusLine(c, { typeless: { keytapActive: false, keytapDevice: false } }), "hotkey: RightAlt+RightShift · keytap: not running");
  assert.equal(TYPELESS_FLASH, "Typeless ⏯");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/Presentation.test.mjs`
Expected: FAIL. `typelessView` is not exported.

- [ ] **Step 3: Implement.** Append to `lib/Presentation.mjs`:

```js

// ---- Typeless engine (Typeless spec §6.3, §7) ----
export const TYPELESS_MIC_HINT = "also select the matching microphone in Typeless";
// What the bar and HUD show for a TypelessSession snapshot: recording while Typeless is believed on or a start tap is
// in flight (a stop in flight keeps `on` until its result), a warning while unsynced, otherwise idle. System mode
// keeps no state: Typeless's own Status bar shows it.
export function typelessView(snap) {
  if (!snap || snap.mode !== "remote") return "idle";
  if (snap.typeless === "unsynced") return "unsynced";
  if (snap.typeless === "on" || (snap.outstanding && snap.outstanding.kind === "start")) return "recording";
  return "idle";
}
export function engineStatusLine(cfg, facts) {
  if (!cfg) return "";
  const t = facts && facts.typeless;
  let kt = "unknown";
  if (t && typeof t.keytapActive === "boolean") kt = t.keytapActive && t.keytapDevice ? "running" : "not running";
  return "hotkey: " + cfg.voice.typeless.hotkey + " · keytap: " + kt;
}
```

Then apply these replacements:

In `lib/Presentation.mjs`:

Replace:

```js
  if (st === "recovering" || s.micPending) return "busy";
```

with:

```js
  if (st === "recovering" || s.micPending) return "busy";
  if (s.typeless === "recording") return "recording";            // Typeless spec §6.3
  if (s.typeless === "unsynced") return "warning";
```

Replace:

```js
export function hudLine(s) {
  if (s.flash) return s.flash;
```

with:

```js
export function hudLine(s) {
  if (s.flash) return s.flash;
  if (s.typeless === "recording") return "● Typeless " + elapsedText(s.elapsedMs || 0) + (s.hudText ? " · " + s.hudText : "");
```


In `Service.qml`:

Replace:

```qml
  property var typelessSnap: null
```

with:

```qml
  property var typelessSnap: null
  property string typelessView: "idle"            // Typeless spec §6.3: idle | recording | unsynced (remote mode only)
```

Replace:

```qml
  readonly property string hudLine: Presentation.hudLine({ voiceState: root.voiceState, hudText: root.hudText, elapsedMs: root.elapsedMs, flash: root.flash })
  Timer { interval: 250; repeat: true; running: root.voiceState === "recording"; onTriggered: root.elapsedMs = Date.now() - root.recordingSince }
```

with:

```qml
  readonly property string hudLine: Presentation.hudLine({ voiceState: root.voiceState, hudText: root.hudText, elapsedMs: root.elapsedMs, flash: root.flash, typeless: root.typelessView })
  Timer { interval: 250; repeat: true; running: root.voiceState === "recording" || root.typelessView === "recording"; onTriggered: root.elapsedMs = Date.now() - root.recordingSince }
```

Replace:

```qml
  function onTypelessState(e) { root.typelessSnap = e.state }
```

with:

```qml
  function onTypelessState(e) {
    root.typelessSnap = e.state
    root.refreshTypelessView()
  }
  function refreshTypelessView() {                              // §6.3: elapsed time runs from the start tap
    var v = root.engineName === "typeless" && root.typelessSnap ? Presentation.typelessView(root.typelessSnap) : "idle"
    if (v === "recording" && root.typelessView !== "recording") {
      root.recordingSince = root.typelessSnap.since || Date.now()
      root.elapsedMs = Date.now() - root.recordingSince
    }
    root.typelessView = v
  }
```

Replace:

```qml
    root.switching = false
    if (root.hudText === "switching engine") root.hudText = ""
```

with:

```qml
    root.switching = false
    root.refreshTypelessView()
    if (root.hudText === "switching engine") root.hudText = ""
```

Replace:

```qml
    h.recording = root.voiceState === "recording"
```

with:

```qml
    h.recording = root.voiceState === "recording" || root.typelessView === "recording"
```

Replace:

```qml
  onVoiceStateChanged: syncHud()
```

with:

```qml
  onVoiceStateChanged: syncHud()
  onTypelessViewChanged: syncHud()
```

Replace:

```qml
                    state: root.typeless ? root.typeless.snapshot() : null, switching: root.switching }
```

with:

```qml
                    state: root.typeless ? root.typeless.snapshot() : null, switching: root.switching, view: root.typelessView }
```


In `BarWidget.qml`:

Replace:

```qml
      micPending: service.micPending, selftest: service.selftestActive }) : "disconnected"
```

with:

```qml
      micPending: service.micPending, selftest: service.selftestActive, typeless: service.typelessView }) : "disconnected"
```

Replace:

```qml
                                    : look === "unconfigured" ? root.warningColor
```

with:

```qml
                                    : look === "unconfigured" || look === "warning" ? root.warningColor
```

Replace:

```qml
    if (look === "recording") return "Recording (" + service.voiceOwner + (service.voiceInferred ? ", inferred" : "") + ")"
```

with:

```qml
    if (look === "warning") return "OmaRemote: Typeless state unknown — check Typeless, then press reset"
    if (look === "recording" && service.typelessView === "recording") return "Recording (Typeless)"
    if (look === "recording") return "Recording (" + service.voiceOwner + (service.voiceInferred ? ", inferred" : "") + ")"
```


In `components/VoiceTab.qml`:

Replace:

```qml
  readonly property int rowCount: 4                    // mic switch, HUD toggle, flash toggle, maxSessionSec (+/- via ←/→ not needed: Enter cycles 30/60/120)
```

with:

```qml
  readonly property int rowCount: 5                    // engine, mic switch, HUD toggle, flash toggle, maxSessionSec (Enter cycles 30/60/120)
```

Replace:

```qml
  property string lastError: ""
```

with:

```qml
  property string lastError: ""
  property string engineError: ""
```

Replace:

```qml
    if (cursor === 0) root.requestMic(cfg.voice.mic === "remote" ? "system" : "remote")
    else if (cursor === 1) s.setVoiceField("hud", !cfg.voice.hud)
    else if (cursor === 2) s.setVoiceField("actionFlash", !cfg.voice.actionFlash)
    else if (cursor === 3) s.setVoiceField("maxSessionSec", cfg.voice.maxSessionSec >= 120 ? 30 : cfg.voice.maxSessionSec >= 60 ? 120 : 60)
```

with:

```qml
    if (cursor === 0) root.requestEngine(cfg.voice.engine === "typeless" ? "voxtype" : "typeless")
    else if (cursor === 1) root.requestMic(cfg.voice.mic === "remote" ? "system" : "remote")
    else if (cursor === 2) s.setVoiceField("hud", !cfg.voice.hud)
    else if (cursor === 3) s.setVoiceField("actionFlash", !cfg.voice.actionFlash)
    else if (cursor === 4) s.setVoiceField("maxSessionSec", cfg.voice.maxSessionSec >= 120 ? 30 : cfg.voice.maxSessionSec >= 60 ? 120 : 60)
```

Replace:

```qml
  function requestMic(mode) {
```

with:

```qml
  function requestEngine(name) {                        // Typeless spec §7: the switch drains both engines first
    if (!s) return
    var r = s.setEngine(name)
    root.engineError = r === "ok" ? "" : r
  }
  function requestMic(mode) {
```

Replace:

```qml
    PanelSectionHeader { text: "Microphone"; foreground: root.fg; fontFamily: root.fontFamily }
```

with:

```qml
    PanelSectionHeader { text: "Engine"; foreground: root.fg; fontFamily: root.fontFamily }
    Row {
      spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Transcription: " + (root.cfg ? root.cfg.voice.engine : "?"); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      Button { text: "Voxtype"; selected: root.cfg && root.cfg.voice.engine === "voxtype"; hasCursor: root.cursor === 0; foreground: root.fg; enabled: root.s && !root.s.switching; onClicked: root.requestEngine("voxtype") }
      Button { text: "Typeless"; selected: root.cfg && root.cfg.voice.engine === "typeless"; hasCursor: root.cursor === 0; foreground: root.fg; enabled: root.s && !root.s.switching; onClicked: root.requestEngine("typeless") }
    }
    Text {
      textFormat: Text.PlainText; width: parent.width; wrapMode: Text.WordWrap
      visible: text !== ""
      text: {
        if (!root.s || !root.cfg) return ""
        if (root.s.switching) return "switching engine…"
        if (root.engineError) return "engine change refused: " + root.engineError
        if (root.cfg.voice.engine !== "typeless") return ""
        return Presentation.engineStatusLine(root.cfg, root.s.doctorFacts) + " — edit with omaremote-setup typeless --hotkey …"
      }
      color: Qt.darker(root.fg, 1.3); font.family: root.fontFamily; font.pixelSize: Style.font.caption
    }

    PanelSectionHeader { text: "Microphone"; foreground: root.fg; fontFamily: root.fontFamily }
```

Replace:

```qml
      Button { text: "Remote"; selected: root.cfg && root.cfg.voice.mic === "remote"; hasCursor: root.cursor === 0;
```

with:

```qml
      Button { text: "Remote"; selected: root.cfg && root.cfg.voice.mic === "remote"; hasCursor: root.cursor === 1;
```

Replace:

```qml
      Button { text: "System default"; selected: root.cfg && root.cfg.voice.mic === "system"; hasCursor: root.cursor === 0;
```

with:

```qml
      Button { text: "System default"; selected: root.cfg && root.cfg.voice.mic === "system"; hasCursor: root.cursor === 1;
```

Replace:

```qml
        if (root.s.micConflict) return "conflict: Voxtype audio.device is " + root.s.micConflict.found + " (expected " + root.s.micConflict.expected + ") — reconcile in Setup"
        return ""
```

with:

```qml
        if (root.s.micConflict) return "conflict: Voxtype audio.device is " + root.s.micConflict.found + " (expected " + root.s.micConflict.expected + ") — reconcile in Setup"
        if (root.cfg && root.cfg.voice.engine === "typeless") return Presentation.TYPELESS_MIC_HINT
        return ""
```

Replace:

```qml
      ToggleSwitch { checked: root.cfg ? root.cfg.voice.hud : true; hasCursor: root.cursor === 1;
```

with:

```qml
      ToggleSwitch { checked: root.cfg ? root.cfg.voice.hud : true; hasCursor: root.cursor === 2;
```

Replace:

```qml
      ToggleSwitch { checked: root.cfg ? root.cfg.voice.actionFlash : true; hasCursor: root.cursor === 2;
```

with:

```qml
      ToggleSwitch { checked: root.cfg ? root.cfg.voice.actionFlash : true; hasCursor: root.cursor === 3;
```

Replace:

```qml
hasCursor: root.cursor === 3; foreground: root.fg; fontFamily: root.fontFamily; onModified
```

with:

```qml
hasCursor: root.cursor === 4; foreground: root.fg; fontFamily: root.fontFamily; onModified
```


- [ ] **Step 4: Run the tests and lint**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

Run: `make lint; echo LINT_EXIT=$?`
Expected: `module-load: ok` and `LINT_EXIT=0`. qmllint prints warnings about `qs.Ui`/`qs.Commons`; those exist
before this task too.

Run: `bash tests/fake-remote.sh`
Expected: `integration: 70 passed, 0 failed`. The HUD and status strings the scenarios wait on are unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/Presentation.mjs tests/Presentation.test.mjs Service.qml BarWidget.qml components/VoiceTab.qml
git commit -m "feat(typeless): bar/HUD display, unsynced warning, Voice tab Engine row

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---

### Task 12: Doctor rows and `typeless` facts

**Files:**
- Modify: `lib/Doctor.mjs`:
  - five rows;
  - every Voxtype row (`voxtype-version`, `-status`, `-output`, `-device`, `last-capture`) informational under
    Typeless, and `voxtype` dropped from the required tools there;
  - `summarize`: under Typeless only `config-valid`, the keytap/uinput rows and the ATVVoice rows count.
- Modify: `lib/Presentation.mjs` (`glyphLook`), `BarWidget.qml`, `Service.qml` (`unconfigured`): under Typeless, a
  VoiceSession `unconfigured` (Voxtype not responding) does not mark the plugin unconfigured.
- Modify: `host/omaremote-facts`: the `typeless` object and `atvvoice.nodeDescription`.
- Create: `tests/fixtures/typeless-settings.json`
- Modify: `tests/fake-remote.sh`:
  - copy the fixture;
  - export `OMAREMOTE_TYPELESS_SETTINGS`;
  - one scenario.
- Test: `tests/Doctor.test.mjs`, `tests/Presentation.test.mjs` (append)

**Interfaces:**
- Consumes: `canonicalChord` (Task 1).
- Produces:
  - facts `typeless: { keytapActive, keytapDevice, inInput, uinputWritable, running, settingsReadable, hotkey, micId, micLabel }`;
  - facts `atvvoice.nodeDescription`;
  - rows `typeless-keytap`, `typeless-uinput`, `typeless-running`, `typeless-hotkey`, `typeless-mic`.
  - Under Typeless, `summarize` returns `unconfigured` when the keytap or uinput row fails. That choice is this plan's:
    without either, no tap can be sent.

- [ ] **Step 1: Write the failing tests** (append to `tests/Doctor.test.mjs`; `good`, `row`, `config`, `evaluate`,
  `summarize`, `normalizeConfig` and `DEFAULT_CONFIG` already exist there)

```js
// ---- Typeless engine (Typeless spec §8) ----
const tlConfig = (voice = {}) => normalizeConfig({ ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, mic: { supported: false } },
                                                   voice: { ...DEFAULT_CONFIG.voice, engine: "typeless", ...voice } }).config;
const tlFacts = (typeless = {}) => {
  const f = good();
  f.atvvoice.nodeDescription = "小米蓝牙语音遥控器";
  f.typeless = Object.assign({ keytapActive: true, keytapDevice: true, inInput: true, uinputWritable: true, running: true,
                               settingsReadable: true, hotkey: "RightAlt", micId: "a79c", micLabel: "小米蓝牙语音遥控器" }, typeless);
  return f;
};
const TL_ROWS = ["typeless-keytap", "typeless-uinput", "typeless-running", "typeless-hotkey", "typeless-mic"];

test("the five Typeless rows appear only when the Typeless engine is selected", () => {
  const ids = (rows) => rows.map(r => r.id).filter(id => id.startsWith("typeless-"));
  assert.deepEqual(ids(evaluate(tlFacts(), config)), []);
  assert.deepEqual(ids(evaluate(tlFacts(), tlConfig())), TL_ROWS);
  for (const id of TL_ROWS) assert.equal(row(evaluate(tlFacts(), tlConfig()), id).status, "pass", id);
});

test("keytap and uinput rows fail with their fixes, and either failure makes the summary unconfigured", () => {
  const down = evaluate(tlFacts({ keytapDevice: false }), tlConfig());
  assert.equal(row(down, "typeless-keytap").status, "fail");
  assert.match(row(down, "typeless-keytap").fix, /omaremote-setup typeless/);
  assert.equal(summarize(down, tlConfig()), "unconfigured");
  const ui = evaluate(tlFacts({ inInput: false }), tlConfig());
  assert.equal(row(ui, "typeless-uinput").status, "fail");
  assert.match(row(ui, "typeless-uinput").fix, /usermod -aG input/);
  assert.equal(summarize(ui, tlConfig()), "unconfigured");
  assert.equal(summarize(evaluate(tlFacts(), tlConfig()), tlConfig()), "ready");
});

test("Typeless not running is a warning", () => {
  const r = row(evaluate(tlFacts({ running: false }), tlConfig()), "typeless-running");
  assert.equal(r.status, "warn");
  assert.equal(r.fix, "start Typeless");
});

test("the hotkey row compares canonical forms and is unknown for an unreadable or unparsable Typeless value", () => {
  const st = (t, v) => row(evaluate(tlFacts(t), tlConfig(v)), "typeless-hotkey").status;
  assert.equal(st({ hotkey: "rightalt" }), "pass", "case differs, canonical equal");
  assert.equal(st({ hotkey: "RightShift+RightAlt" }, { typeless: { hotkey: "RightShift+RightAlt" } }), "pass");
  assert.equal(st({ hotkey: "RightAlt+RightShift" }), "warn");
  assert.match(row(evaluate(tlFacts({ hotkey: "RightAlt+RightShift" }), tlConfig()), "typeless-hotkey").fix, /--hotkey-from-typeless/);
  assert.equal(st({ hotkey: "Fn+Q" }), "unknown", "review focus 5: an unparsable value is not a mismatch");
  assert.equal(st({ hotkey: null }), "unknown", "review focus 5: no dictationMode");
  assert.equal(st({ settingsReadable: false }), "unknown");
});

test("the microphone row: remote mode wants the remote's label; system mode wants anything else", () => {
  const st = (t, v) => row(evaluate(tlFacts(t), tlConfig(v)), "typeless-mic");
  assert.equal(st({}).status, "pass");
  assert.equal(st({ micId: "default", micLabel: "Auto-detect (C922 Pro Stream Webcam Analog Stereo)" }).status, "warn");
  assert.equal(st({ micId: "c922", micLabel: "C922 Pro Stream Webcam Analog Stereo" }).status, "warn");
  assert.match(st({ micId: "c922", micLabel: "C922 Pro Stream Webcam Analog Stereo" }).detail, /Typeless: C922.*remote: 小米蓝牙语音遥控器/);
  assert.equal(st({}, { mic: "system" }).status, "warn", "system mode recording from the remote hears nothing between presses");
  assert.equal(st({ micId: "default", micLabel: "Auto-detect (C922)" }, { mic: "system" }).status, "pass");
  assert.equal(st({ micId: "c922", micLabel: "C922" }, { mic: "system" }).status, "pass");
  assert.equal(st({ settingsReadable: false }).status, "unknown");
  const noNode = tlFacts(); delete noNode.atvvoice.nodeDescription;
  assert.equal(row(evaluate(noNode, tlConfig()), "typeless-mic").status, "unknown");
});

test("under Typeless the remote-mode Voxtype device row is informational; the ATVVoice rows still count", () => {
  const f = tlFacts();
  f.voxtype.audioDevice = "default";                       // Voxtype not pointed at the remote: irrelevant to Typeless
  const rows = evaluate(f, tlConfig());
  assert.equal(row(rows, "voxtype-device").status, "info");
  assert.equal(summarize(rows, tlConfig()), "ready");
  f.atvvoice.active = false;
  assert.equal(row(evaluate(f, tlConfig()), "atvvoice-service").status, "fail");
  assert.equal(row(evaluate(f, config), "voxtype-device").status, "fail", "under Voxtype the same facts still fail");
});

test("review: Typeless prerequisites all pass while Voxtype is unusable → Voxtype rows informational, summary ready", () => {
  const broken = () => {
    const f = tlFacts();
    f.tools.voxtype = false;
    f.voxtype = { version: null, statusClass: "stopped", outputMode: "clipboard", audioDevice: "default" };
    f.lastCapture = { node: "elsewhere", at: 1000 };
    return f;
  };
  const rows = evaluate(broken(), tlConfig());
  for (const id of ["voxtype-version", "voxtype-status", "voxtype-output", "voxtype-device", "last-capture"]) assert.equal(row(rows, id).status, "info", id);
  assert.equal(row(rows, "tools").status, "pass", "voxtype is not a required tool under Typeless");
  assert.equal(summarize(rows, tlConfig()), "ready");
  const sysRows = evaluate(broken(), tlConfig({ mic: "system" }));
  assert.equal(summarize(sysRows, tlConfig({ mic: "system" })), "ready");
  const voxCfg = normalizeConfig({ ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, mic: { supported: false } } }).config;
  assert.equal(summarize(evaluate(broken(), voxCfg), voxCfg), "unconfigured", "discriminating: the same host under Voxtype is unconfigured");
});
```

Also append to `tests/Presentation.test.mjs`:

```js
test("review: under Typeless a Voxtype that is not responding does not make the bar unconfigured", () => {
  assert.equal(glyphLook({ voiceState: "unconfigured", engine: "typeless" }), "ready");
  assert.equal(glyphLook({ voiceState: "unconfigured", engine: "voxtype" }), "unconfigured");
  assert.equal(glyphLook({ voiceState: "unconfigured", engine: "typeless", unconfigured: true }), "unconfigured", "a real Typeless problem still shows");
  assert.equal(glyphLook({ voiceState: "recording", engine: "typeless" }), "recording", "an F9 dictation still shows");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/Doctor.test.mjs tests/Presentation.test.mjs`
Expected: FAIL. No `typeless-*` rows exist, the Voxtype rows are not `info` under Typeless, and `glyphLook` still
reports `unconfigured`.

- [ ] **Step 3: Implement.** Apply these replacements. The facts script keeps its read-only, bounded style:

In `lib/Doctor.mjs`:

Replace:

```js
import { isHealthy } from "./VoxStatus.mjs";
```

with:

```js
import { isHealthy } from "./VoxStatus.mjs";
import { canonicalChord } from "./Chord.mjs";
```

Replace:

```js
  const mode = get(config, "voice.mic") === "system" ? "system" : "remote";
  const supported = KEY_NAMES.filter(k => get(config, `keys.${k}.supported`) !== false);
  const rows = [];
  const push = (id, label, status, modes, detail = "", fix = "") => rows.push({ id, label, status, modes, detail, fix });
```

with:

```js
  const mode = get(config, "voice.mic") === "system" ? "system" : "remote";
  const supported = KEY_NAMES.filter(k => get(config, `keys.${k}.supported`) !== false);
  const rows = [];
  const push = (id, label, status, modes, detail = "", fix = "") => rows.push({ id, label, status, modes, detail, fix });
  // Typeless spec §8: under Typeless the remote never drives Voxtype, so every Voxtype row is informational (F9 is
  // Omarchy's own binding). The ATVVoice rows still count: remote mode needs the remote's stream either way.
  const typelessEngine = get(config, "voice.engine") === "typeless";
  const vox = (status) => (typelessEngine ? "info" : status);
```

Replace:

```js
    const missing = REQUIRED_TOOLS.filter(t => !tools[t]);
```

with:

```js
    const missing = REQUIRED_TOOLS.filter(t => !tools[t] && !(typelessEngine && t === "voxtype"));
```

Replace:

```js
    push("voxtype-version", "Voxtype ≥ 0.8", "fail", BOTH, "voxtype not installed", "omarchy-update  # Voxtype >= 0.8 ships with Omarchy");
```

with:

```js
    push("voxtype-version", "Voxtype ≥ 0.8", vox("fail"), BOTH, "voxtype not installed", "omarchy-update  # Voxtype >= 0.8 ships with Omarchy");
```

Replace:

```js
    push("voxtype-version", "Voxtype ≥ 0.8", vok === null ? "unknown" : tri(vok), BOTH,
```

with:

```js
    push("voxtype-version", "Voxtype ≥ 0.8", vox(vok === null ? "unknown" : tri(vok)), BOTH,
```

Replace:

```js
  push("voxtype-status", "Voxtype daemon answering", cls === undefined ? "unknown" : tri(isHealthy(cls)), BOTH,
```

with:

```js
  push("voxtype-status", "Voxtype daemon answering", vox(cls === undefined ? "unknown" : tri(isHealthy(cls))), BOTH,
```

Replace:

```js
  push("voxtype-output", 'Voxtype output.mode is "type"', om === undefined ? "unknown" : tri(om === "type"), BOTH,
```

with:

```js
  push("voxtype-output", 'Voxtype output.mode is "type"', vox(om === undefined ? "unknown" : tri(om === "type")), BOTH,
```

Replace:

```js
  if (dev === undefined) push("voxtype-device", "Voxtype audio.device", "unknown", BOTH, "", "");
```

with:

```js
  if (dev === undefined) push("voxtype-device", "Voxtype audio.device", vox("unknown"), BOTH, "", "");
```

Replace:

```js
    if (!node || dev !== node) push("voxtype-device", label, "fail", ["remote"],
```

with:

```js
    if (!node || dev !== node) push("voxtype-device", label, vox("fail"), ["remote"],
```

Replace:

```js
    else if (Array.isArray(pcms) && !pcms.includes(node)) push("voxtype-device", label, "fail", ["remote"],
```

with:

```js
    else if (Array.isArray(pcms) && !pcms.includes(node)) push("voxtype-device", label, vox("fail"), ["remote"],
```

Replace:

```js
    else if (!Array.isArray(pcms)) push("voxtype-device", label, "unknown", ["remote"],
```

with:

```js
    else if (!Array.isArray(pcms)) push("voxtype-device", label, vox("unknown"), ["remote"],
```

Replace:

```js
    else push("voxtype-device", label, "pass", ["remote"],
```

with:

```js
    else push("voxtype-device", label, vox("pass"), ["remote"],
```

Replace:

```js
    push("voxtype-device", "Voxtype audio.device resolves to a PipeWire source", Array.isArray(sources) || dev === "default" ? tri(ok) : "unknown", ["system"],
```

with:

```js
    push("voxtype-device", "Voxtype audio.device resolves to a PipeWire source", vox(Array.isArray(sources) || dev === "default" ? tri(ok) : "unknown"), ["system"],
```

Replace:

```js
  if (lc === undefined) push("last-capture", "Last session captured from expected node", "unknown", BOTH, "", "");
  else if (lc === null) push("last-capture", "Last session captured from expected node", "unknown", BOTH, "not yet verified", "");
  else push("last-capture", "Last session captured from expected node", lc.node === expected ? "pass" : "warn", BOTH, `captured from: ${lc.node}`, "");
```

with:

```js
  if (lc === undefined) push("last-capture", "Last session captured from expected node", vox("unknown"), BOTH, "", "");
  else if (lc === null) push("last-capture", "Last session captured from expected node", vox("unknown"), BOTH, "not yet verified", "");
  else push("last-capture", "Last session captured from expected node", vox(lc.node === expected ? "pass" : "warn"), BOTH, `captured from: ${lc.node}`, "");
```

Replace:

```js
  // panic + config
```

with:

```js
  // Typeless engine (Typeless spec §8): five rows, only while it is selected. Values compare in canonical form, and
  // a Typeless value that cannot be read or parsed is `unknown`, never a mismatch.
  if (get(config, "voice.engine") === "typeless") {
    const t = get(facts, "typeless");
    const known = (k) => t && typeof t[k] === "boolean";
    push("typeless-keytap", "omaremote-keytap running with its input device",
         known("keytapActive") && known("keytapDevice") ? tri(t.keytapActive && t.keytapDevice) : "unknown", BOTH,
         known("keytapActive") ? `unit: ${t.keytapActive ? "active" : "inactive"}, device: ${t.keytapDevice ? "present" : "absent"}` : "",
         "bash <plugin-dir>/host/omaremote-setup typeless");
    push("typeless-uinput", "uinput access (input group, /dev/uinput writable)",
         known("inInput") && known("uinputWritable") ? tri(t.inInput && t.uinputWritable) : "unknown", BOTH,
         known("inInput") ? `input group: ${t.inInput ? "yes" : "no"}, /dev/uinput: ${t.uinputWritable ? "writable" : "not writable"}` : "",
         "sudo usermod -aG input $USER  # then log out and back in");
    push("typeless-running", "Typeless running", known("running") ? (t.running ? "pass" : "warn") : "unknown", BOTH, "", "start Typeless");
    const want = get(config, "voice.typeless.hotkey");
    const readable = !!(t && t.settingsReadable);
    const theirs = readable ? canonicalChord(t.hotkey) : null;
    push("typeless-hotkey", "Hotkey matches Typeless's dictation shortcut",
         theirs === null ? "unknown" : (theirs === want ? "pass" : "warn"), BOTH,
         `omaremote: ${want}, Typeless: ${!readable ? "unreadable" : t.hotkey === null || t.hotkey === undefined ? "not set" : String(t.hotkey)}`,
         "bash <plugin-dir>/host/omaremote-setup typeless --hotkey-from-typeless");
    const remoteName = get(facts, "atvvoice.nodeDescription");
    let micStatus = "unknown", micDetail = readable ? "" : "Typeless settings unreadable";
    if (readable) {
      const auto = t.micId === null || t.micId === undefined || t.micId === "default";
      const label = auto ? "Auto-detect" : String(t.micLabel || "");
      micDetail = `Typeless: ${label}` + (remoteName ? `, remote: ${remoteName}` : "");
      const isRemote = !auto && !!remoteName && label === remoteName;
      if (mode === "remote") micStatus = remoteName ? (isRemote ? "pass" : "warn") : "unknown";
      else micStatus = auto ? "pass" : (remoteName ? (isRemote ? "warn" : "pass") : "unknown");
    }
    push("typeless-mic", mode === "remote" ? "Typeless records from the remote's microphone" : "Typeless does not record from the remote's microphone",
         micStatus, BOTH, micDetail,
         mode === "remote" ? "select the remote's microphone in Typeless" : "select your microphone (or Auto-detect) in Typeless");
  }
  // panic + config
```

Replace:

```js
  if (failed(VOX_ROWS)) return "unconfigured";
  if (mode === "system" && rows.some(r => r.id === "voxtype-device" && r.status === "fail")) return "unconfigured";
```

with:

```js
  if (get(config, "voice.engine") === "typeless") {
    // Typeless spec §8: Voxtype rows are informational here; without keytap or uinput access no tap can be sent.
    if (failed(["config-valid"])) return "unconfigured";
    if (rows.some(r => (r.id === "typeless-keytap" || r.id === "typeless-uinput") && r.status === "fail")) return "unconfigured";
    if (mode === "remote" && failed(REMOTE_ROWS)) return "remoteWarning";
    return "ready";
  }
  if (failed(VOX_ROWS)) return "unconfigured";
  if (mode === "system" && rows.some(r => r.id === "voxtype-device" && r.status === "fail")) return "unconfigured";
```


In `host/omaremote-facts`:

Replace:

```bash
atv_node=null
```

with:

```bash
atv_node=null
atv_desc=null
```

Replace:

```bash
if has pw-dump && raw=$(bounded pw-dump); then
  pw_sources=$(jq -c '[.[] | select(.type == "PipeWire:Interface:Node") | select((.info.props["media.class"] // "") == "Audio/Source") | .info.props["node.name"]]' <<<"$raw" 2>/dev/null)
fi
```

with:

```bash
if has pw-dump && raw=$(bounded pw-dump); then
  pw_sources=$(jq -c '[.[] | select(.type == "PipeWire:Interface:Node") | select((.info.props["media.class"] // "") == "Audio/Source") | .info.props["node.name"]]' <<<"$raw" 2>/dev/null)
  # Typeless spec §8: Typeless labels a microphone by its PipeWire node.description, so the Doctor compares that.
  atv_node_raw=$(jq -r '. // empty' <<<"$atv_node" 2>/dev/null)
  if [[ -n $atv_node_raw ]]; then
    atv_desc=$(jq -c --arg n "$atv_node_raw" '[.[] | select(.type == "PipeWire:Interface:Node") | select((.info.props["node.name"] // "") == $n) | .info.props["node.description"]] | .[0] // null' <<<"$raw" 2>/dev/null)
    atv_desc=${atv_desc:-null}
  fi
fi
```

Replace:

```bash
cat <<JSON
```

with:

```bash
# Typeless engine (Typeless spec §8). Read-only, like everything here.
TL_SETTINGS=${OMAREMOTE_TYPELESS_SETTINGS:-${XDG_CONFIG_HOME:-$HOME/.config}/Typeless/app-settings.json}
kt_active=$(jbool_bounded systemctl --user is-active omaremote-keytap)
kt_device=$(jbool_bounded grep -qxs 'omaremote keytap' /sys/class/input/event*/device/name)
tl_input=$(jbool bash -c 'id -nG | tr " " "\n" | grep -qx input')
tl_uinput=$(jbool test -w "${OMAREMOTE_UINPUT:-/dev/uinput}")
tl_running=$(jbool_bounded pgrep -x -u "$(id -u)" typeless)
tl='{"settingsReadable":false,"hotkey":null,"micId":null,"micLabel":null}'
if [[ -r $TL_SETTINGS ]]; then
  t=$(jq -c '{settingsReadable: true,
              hotkey: ((.featureShortcutBindings.dictationMode // null) | if type == "array" then (.[0] // null) else null end | if type == "string" then . else null end),
              micId: (.selectedMicrophoneDevice | if type == "object" then (.deviceId // null) else null end),
              micLabel: (.selectedMicrophoneDevice | if type == "object" then (.label // null) else null end)}' "$TL_SETTINGS" 2>/dev/null) && [[ -n $t ]] && tl=$t
fi

cat <<JSON
```

Replace:

```bash
 "atvvoice":{"active":$atv_active,"micOnDemand":$atv_ondemand,"busNames":$atv_names,"nodeName":$atv_node},
```

with:

```bash
 "atvvoice":{"active":$atv_active,"micOnDemand":$atv_ondemand,"busNames":$atv_names,"nodeName":$atv_node,"nodeDescription":$atv_desc},
```

Replace:

```bash
 "alsa":{"pcms":$alsa_pcms}}
```

with:

```bash
 "alsa":{"pcms":$alsa_pcms},
 "typeless":{"keytapActive":$kt_active,"keytapDevice":$kt_device,"inInput":$tl_input,"uinputWritable":$tl_uinput,"running":$tl_running,
             "settingsReadable":$(jq -r '.settingsReadable' <<<"$tl"),"hotkey":$(jq -c '.hotkey' <<<"$tl"),"micId":$(jq -c '.micId' <<<"$tl"),"micLabel":$(jq -c '.micLabel' <<<"$tl")}}
```


In `lib/Presentation.mjs`:

Replace:

```js
export function glyphLook(s) {
  const st = s.voiceState || "idle";
```

with:

```js
export function glyphLook(s) {
  // Typeless spec §8: under Typeless a Voxtype that is not responding is not this engine's problem.
  const st = s.engine === "typeless" && s.voiceState === "unconfigured" ? "idle" : (s.voiceState || "idle");
```


In `BarWidget.qml`:

Replace:

```qml
selftest: service.selftestActive, typeless: service.typelessView }) : "disconnected"
```

with:

```qml
selftest: service.selftestActive, typeless: service.typelessView, engine: service.engineName }) : "disconnected"
```


In `Service.qml`:

Replace:

```qml
  readonly property bool unconfigured: root.voiceState === "unconfigured" || root.doctorSummary === "unconfigured" || root.configInvalid
```

with:

```qml
  // Typeless spec §8: under Typeless, VoiceSession's own "voxtype not responding" does not make the plugin unconfigured.
  readonly property bool unconfigured: (root.engineName !== "typeless" && root.voiceState === "unconfigured") || root.doctorSummary === "unconfigured" || root.configInvalid
```


- [ ] **Step 4: The fixture and an integration scenario.** Create `tests/fixtures/typeless-settings.json`. Its label
  equals the fake ATVVoice node's description in `tests/fixtures/pw-dump.json`.

```json
{
  "featureShortcutBindings": { "dictationMode": ["RightAlt"] },
  "selectedMicrophoneDevice": { "deviceId": "f00d", "kind": "audioinput", "label": "ATVVoice Remote Mic" },
  "microphoneDevices": [
    { "deviceId": "default", "kind": "audioinput", "label": "Auto-detect (Built-in Audio Analog Stereo)" },
    { "deviceId": "f00d", "kind": "audioinput", "label": "ATVVoice Remote Mic" }
  ]
}
```

In `tests/fake-remote.sh`:
- add after the `export OMAREMOTE_KEYTAP=…` line (Task 10):

```bash
export OMAREMOTE_TYPELESS_SETTINGS=$OMAREMOTE_FAKE_DIR/typeless-settings.json   # never ~/.config/Typeless
```

- add to `reset_fakes()`, after its `cp "$ROOT/tests/fixtures/pw-dump.json" "$F/pw-dump.json"` line:

```bash
  cp "$ROOT/tests/fixtures/typeless-settings.json" "$F/typeless-settings.json"
```

- append before `# ---- summary`:

```bash
# ---- Plan 5 Task 12: Typeless Doctor rows from host/omaremote-facts ----
doctor_row() { ipc doctor | jq -r --arg id "$1" '[.rows[] | select(.id == $id) | .status][0] // "absent"'; }
wait_doctor_row() {   # wait_doctor_row <id> <status>
  local i=0 got=""
  while (( i < 100 )); do got=$(doctor_row "$1"); [[ $got == "$2" ]] && return 0; sleep 0.1; i=$((i + 1)); done
  echo "    doctor row $1: want $2, last $got"; return 1
}
s_doctor_typeless_rows() {
  ready || return 1
  wait_doctor_row typeless-hotkey absent || return 1               # only under the Typeless engine
  use_typeless || return 1
  wait_doctor_row typeless-hotkey pass || return 1                 # fixture: dictationMode[0] = RightAlt
  wait_doctor_row typeless-mic pass || return 1                    # fixture label = the fake node's description
  local seq; seq=$(ipc typelessHotkey RightCtrl+Space | jq -r '.writeSeq'); wait_saved "$seq" || return 1
  wait_doctor_row typeless-hotkey warn
}
scenario doctor_typeless_rows s_doctor_typeless_rows
```

- [ ] **Step 5: Run everything touched**

Run: `node --test tests/Doctor.test.mjs`
Expected: PASS.

Run: `bash tests/fake-remote.sh doctor_typeless_rows`
Expected: `ok`.

Run: `host/omaremote-facts | jq -c '{d: .atvvoice.nodeDescription, t: .typeless}'`
Expected: valid JSON. This read-only check runs against the real host. `t.settingsReadable` is true when Typeless is
installed, and `d` is the remote's description when ATVVoice runs.

- [ ] **Step 6: Commit**

```bash
git add lib/Doctor.mjs host/omaremote-facts lib/Presentation.mjs BarWidget.qml Service.qml tests/Doctor.test.mjs tests/Presentation.test.mjs tests/fixtures/typeless-settings.json tests/fake-remote.sh
git commit -m "feat(doctor): Typeless rows — keytap, uinput, running, hotkey and microphone match

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---
### Task 13: `omaremote-setup typeless`

**Files:**
- Modify: `host/omaremote-setup`:
  - `ipc()` (line 359);
  - new functions before `cmd_all()`;
  - `usage()`;
  - `main()`.
- Create: `tests/setup-typeless.sh`
- Modify: `Makefile` (`check`)

**Interfaces:**
- Consumes:
  - `host/omaremote-keytap` and its `ping` (Task 2);
  - the IPC `typelessHotkey` and the status fields `typeless.hotkeyStored`, `typeless.hotkey` and
    `configWrites.saves/errors` (Task 5).
- Produces:
  - `omaremote-setup typeless [--hotkey <chord> | --hotkey-from-typeless]`;
  - the user unit `omaremote-keytap.service`;
  - the installed `~/.local/lib/omaremote/omaremote-keytap`.
  - Every setup IPC call is now bounded by `timeout ${OMAREMOTE_IPC_TIMEOUT:-3}`.
- Test overrides:
  - `OMAREMOTE_KEYTAP_DIR`, `OMAREMOTE_KEYTAP_UNIT`, `OMAREMOTE_TYPELESS_SETTINGS`, `OMAREMOTE_UINPUT`
    (from the spec);
  - `OMAREMOTE_INPUT_SYSFS`, `OMAREMOTE_IPC_TIMEOUT` and `OMAREMOTE_SAVE_WAIT_MS` (test-only additions).

- [ ] **Step 1: Write the failing test** `tests/setup-typeless.sh`

The script creates a fresh directory per scenario with `mktemp -d "$T/case.XXXXXX"`. It never runs `rm -rf` on
anything but its own `$T`, through the EXIT trap.

```bash
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/setup-typeless.sh`
Expected: `setup-typeless: FAILED`. Every scenario fails with `cmd_typeless: command not found` in its `out.log`.

- [ ] **Step 3: Bound the IPC wrapper.** In `host/omaremote-setup`, replace

```bash
ipc() { $SHELL_CMD omaremote "$@"; }
```

with

```bash
# Typeless spec §4.3: every IPC call is bounded, so a wedged shell cannot hang setup.
IPC_TIMEOUT=${OMAREMOTE_IPC_TIMEOUT:-3}
ipc() { timeout "$IPC_TIMEOUT" $SHELL_CMD omaremote "$@"; }
```

- [ ] **Step 4: Add the step.** Insert directly before `cmd_all() {`:

```bash
# ---- Typeless engine: keytap daemon and hotkey (Plan 5; Typeless spec §4.3) ----------------------
KEYTAP_DIR=${OMAREMOTE_KEYTAP_DIR:-$HOME/.local/lib/omaremote}
KEYTAP_UNIT=${OMAREMOTE_KEYTAP_UNIT:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/omaremote-keytap.service}
TYPELESS_SETTINGS=${OMAREMOTE_TYPELESS_SETTINGS:-${XDG_CONFIG_HOME:-$HOME/.config}/Typeless/app-settings.json}
UINPUT=${OMAREMOTE_UINPUT:-/dev/uinput}
INPUT_SYSFS=${OMAREMOTE_INPUT_SYSFS:-/sys/class/input}
KEYTAP_SRC=$SELF_DIR/../host/omaremote-keytap   # like ATV_PATCH: resolves from host/ and from a test that sources this file
OMA_CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}/omaremote/config.json
SAVE_WAIT_MS=${OMAREMOTE_SAVE_WAIT_MS:-2000}
NO_SERVICE="the omaremote service is not running; start the shell, then re-run \`omaremote-setup typeless --hotkey …\`"

gen_keytap_unit() {   # gen_keytap_unit > file. %h keeps the unit independent of where the checkout lives.
  local exec='%h/.local/lib/omaremote/omaremote-keytap'
  [[ -n ${OMAREMOTE_KEYTAP_DIR:-} ]] && exec=$KEYTAP_DIR/omaremote-keytap   # tests only
  cat <<UNIT
[Unit]
Description=omaremote keytap (uinput hotkey taps for Typeless)
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStart=/usr/bin/python3 -I $exec serve
Restart=on-failure

[Install]
WantedBy=graphical-session.target
UNIT
}

keytap_prereqs() {
  command -v python3 >/dev/null 2>&1 || die "python3 is missing. Run:  sudo pacman -S --needed python  -- then re-run this step."
  id -nG | tr ' ' '\n' | grep -qx input \
    || die "you are not in the input group (Typeless needs it too). Run:  sudo usermod -aG input \$USER  -- then log out and back in, and re-run this step."
  [[ -w $UINPUT ]] \
    || die "$UINPUT is not writable. Run:  sudo usermod -aG input \$USER  -- then log out and back in (a group change needs a new login)."
}

keytap_install() {
  [[ -f $KEYTAP_SRC ]] || die "the keytap script is missing: $KEYTAP_SRC"
  local changed=0
  mkdir -p "$KEYTAP_DIR"
  if ! cmp -s "$KEYTAP_SRC" "$KEYTAP_DIR/omaremote-keytap"; then
    install -m 0755 "$KEYTAP_SRC" "$KEYTAP_DIR/omaremote-keytap"; changed=1
    say "installed $KEYTAP_DIR/omaremote-keytap"
  fi
  gen_keytap_unit > "$WORKDIR/omaremote-keytap.service"
  if ! cmp -s "$WORKDIR/omaremote-keytap.service" "$KEYTAP_UNIT"; then
    mkdir -p "$(dirname "$KEYTAP_UNIT")"
    cp "$WORKDIR/omaremote-keytap.service" "$KEYTAP_UNIT"; changed=1
    say "wrote $KEYTAP_UNIT"
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now omaremote-keytap
  if (( changed )); then systemctl --user restart omaremote-keytap; fi
  return 0
}

keytap_verify() {   # within 3 s: the input device exists and the daemon answers ping
  local i=0
  while (( i < 30 )); do
    if grep -qxs 'omaremote keytap' "$INPUT_SYSFS"/event*/device/name && python3 -I "$KEYTAP_DIR/omaremote-keytap" ping >/dev/null 2>&1; then
      say "keytap: input device present, daemon answers"
      return 0
    fi
    sleep 0.1; i=$((i + 1))
  done
  journalctl --user -u omaremote-keytap -n 20 --no-pager 2>/dev/null | sed 's/^/    /' >&2 || true
  die "omaremote-keytap did not come up within 3 s (its journal is above)"
}

typeless_value() {   # Typeless's dictationMode[0] when it is a string, else nothing
  jq -r '(.featureShortcutBindings.dictationMode // null) | if type == "array" then (.[0] // empty) else empty end | strings' \
    "$TYPELESS_SETTINGS" 2>/dev/null || true
}

hotkey_request() {   # hotkey_request <chord>: the IPC reply, or dies when there is no service
  local r; r=$(ipc typelessHotkey "$1" 2>/dev/null) && [[ -n $r ]] || die "$NO_SERVICE"
  printf '%s' "$r"
}

typeless_hotkey() {   # typeless_hotkey <explicit chord or ""> <from_typeless 0|1>
  local want=$1 from=$2 st stored adopted=0
  st=$(ipc status 2>/dev/null) && [[ -n $st ]] || die "$NO_SERVICE"
  stored=$(jq -r '.typeless.hotkeyStored | if type == "boolean" then tostring else empty end' <<<"$st" 2>/dev/null)   # not `// empty`: false is falsy
  [[ -n $stored ]] || die "$NO_SERVICE"
  if [[ -z $want ]] && { (( from )) || [[ $stored == false ]]; }; then
    want=$(typeless_value); adopted=1
    if [[ -z $want ]]; then
      want=RightAlt; adopted=0
      say "Typeless's dictation hotkey could not be read from $TYPELESS_SETTINGS; using RightAlt"
    else
      say "using Typeless's dictation hotkey: $want"
    fi
  fi
  if [[ -z $want ]]; then say "keeping the stored hotkey: $(jq -r '.typeless.hotkey' <<<"$st")"; return 0; fi

  local r; r=$(hotkey_request "$want")
  if [[ $(jq -r '.ok' <<<"$r") != true ]]; then
    local why; why=$(jq -r '.reason // "unknown"' <<<"$r")
    if (( adopted )) && [[ $why == "invalid chord: "* ]]; then        # an unusable Typeless value falls back, loudly
      say "Typeless's hotkey '$want' is not usable here ($why); using RightAlt"
      want=RightAlt; r=$(hotkey_request "$want")
      [[ $(jq -r '.ok' <<<"$r") == true ]] || die "the hotkey was not accepted: $(jq -r '.reason // "unknown"' <<<"$r")"
    else
      die "the hotkey was not accepted: $why"
    fi
  fi

  local canon seq; canon=$(jq -r '.hotkey' <<<"$r"); seq=$(jq -r '.writeSeq // empty' <<<"$r")
  if [[ -n $seq ]]; then
    local t0=${EPOCHREALTIME/./} state=""
    while :; do
      st=$(ipc status 2>/dev/null) && [[ -n $st ]] || die "$NO_SERVICE"
      state=$(jq -r --arg n "$seq" '.configWrites.saves[$n] // "unknown"' <<<"$st")
      case $state in
        saved) break ;;
        failed) die "saving config.json failed: $(jq -r --arg n "$seq" '.configWrites.errors[$n] // "unknown reason"' <<<"$st")" ;;
      esac
      (( (${EPOCHREALTIME/./} - t0) / 1000 >= SAVE_WAIT_MS )) && die "config.json write $seq was not confirmed within $((SAVE_WAIT_MS / 1000)) s (last state: $state)"
      sleep 0.1
    done
  fi
  local disk; disk=$(jq -r '.voice.typeless.hotkey // empty' "$OMA_CONFIG" 2>/dev/null)
  [[ $disk == "$canon" ]] || die "the hotkey was changed again before setup could confirm it (config.json holds '${disk:-nothing}', expected '$canon')"
  say "hotkey: $canon (saved)"
}

cmd_typeless() {   # cmd_typeless [--hotkey <chord> | --hotkey-from-typeless]
  need jq
  local want="" from=0
  while (( $# )); do
    case $1 in
      --hotkey) [[ $# -ge 2 && -n $2 ]] || die "usage: omaremote-setup typeless [--hotkey <chord> | --hotkey-from-typeless]"; want=$2; shift 2 ;;
      --hotkey-from-typeless) from=1; shift ;;
      *) die "unknown typeless option: $1 (usage: omaremote-setup typeless [--hotkey <chord> | --hotkey-from-typeless])" ;;
    esac
  done
  [[ -n $want && $from == 1 ]] && die "--hotkey and --hotkey-from-typeless are exclusive"
  step "Typeless engine: keytap daemon"
  keytap_prereqs
  keytap_install
  keytap_verify
  step "Typeless engine: hotkey"           # only after a working keytap: a failure here leaves the daemon running
  typeless_hotkey "$want" "$from"
  say "Switch the engine in the panel (Voice tab → Engine: Typeless). Setup never switches it."
}
```

Two details here were caught by running the test, so keep them:
- **`KEYTAP_SRC` is `$SELF_DIR/../host/omaremote-keytap`**, like `ATV_PATCH`. `$SELF_DIR` is `tests/` when a test
  sources this file.
- **`hotkeyStored` is read with `if type == "boolean" then tostring else empty end`, never `// empty`.** jq's `//`
  treats `false` as missing, so a first run would read as "no service".

In `usage()`, add after the `mic …` line:

```
  typeless install and start the omaremote-keytap user service (uinput; needs the input group) and store the
           Typeless dictation hotkey: typeless [--hotkey <chord> | --hotkey-from-typeless]. Never switches the
           engine; do that in the panel (Voice tab → Engine). Not part of the default flow.
```

and add to its Environment list:

```
  OMAREMOTE_KEYTAP_DIR, OMAREMOTE_KEYTAP_UNIT, OMAREMOTE_TYPELESS_SETTINGS, OMAREMOTE_UINPUT  test overrides for `typeless`
```

In `main()`'s `case`, add after the `mic)` line:

```bash
    typeless) shift; cmd_typeless "$@" ;;
```

- [ ] **Step 5: Run the setup tests**

Run: `bash tests/setup-typeless.sh`
Expected: `setup-typeless: all ok`.

Run: `bash tests/setup-atvvoice.sh && bash tests/setup-helpers.sh`
Expected: both end `RESULT: PASS`. `setup-atvvoice.sh` overrides `ipc` itself, so the new timeout does not affect it.

- [ ] **Step 6: Wire it into `make check`.** Add `bash tests/setup-typeless.sh` after `bash tests/setup-atvvoice.sh` in
  the `check:` recipe.

Run: `make check; echo MAKE_CHECK_EXIT=$?`
Expected: `MAKE_CHECK_EXIT=0`.

- [ ] **Step 7: Commit**

```bash
git add host/omaremote-setup tests/setup-typeless.sh Makefile
git commit -m "feat(setup): typeless step — keytap user service and confirmed hotkey; bounded IPC

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

---
### Task 14: Docs, final check, and hardware acceptance (user present)

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-13-typeless-engine-design.md` (status line; §2.6 measured correction;
  §4.3 status field name)

**Interfaces:** none. This task closes the plan.

- [ ] **Step 1: README.** In `README.md`, replace the IPC paragraph with:

```markdown
IPC (`omarchy-shell omaremote …`): `ping`, `status`, `doctor`, `key <name> down|up`, `voice state <state>`, `voice poll -`, `reset`,
`mic remote|system`, `micStatus <id>`, `micToggle`, `engine voxtype|typeless`, `typelessHotkey <chord>`,
`selftestPing`, `selftestArm`, `selftestStatus|selftestReport|selftestDisarm <id>`.

## Typeless engine (optional)

With **Engine: Typeless** (Voice tab), the remote's mic button sends Typeless's dictation hotkey instead of driving
Voxtype. Typeless records, transcribes and pastes on its own; choose its microphone in Typeless.

- Setup: `bash host/omaremote-setup typeless` installs the `omaremote-keytap` user service, a uinput keyboard that needs
  the `input` group, which Typeless needs too. On the first run it adopts Typeless's dictation hotkey. Change the
  hotkey with `--hotkey RightAlt+RightShift`, or re-read Typeless's with `--hotkey-from-typeless`. Setup never switches
  the engine.
- `remote` mic mode: hold the button to talk. In Typeless, select the remote's microphone (小米蓝牙语音遥控器).
- `system` mic mode: each press toggles Typeless; it records from whatever microphone Typeless has selected.
- **Known limitation:** omaremote cannot see Typeless's real state. Pressing the hotkey on the keyboard, Typeless
  stopping by itself (silence or its length limit), or a tap whose result was unknown can leave the two inverted.
  Every later remote hold then toggles the wrong way. To recover:
  1. stop Typeless by hand;
  2. press reset if the bar shows the Typeless warning;
  3. hold again.
- After restarting the shell during a dictation, check Typeless: it may still be recording.
```

- [ ] **Step 2: Spec bookkeeping.** In `docs/superpowers/specs/2026-10-13-typeless-engine-design.md`:
  - Change the status line to `**Status:** Approved rev 5 (2026-10-13); implemented by Plan 5
    (docs/superpowers/plans/2026-10-13-omaremote-typeless-engine.md)`.
  - In §2.6, replace the `selectedMicrophoneDevice` bullet with:
    `` `selectedMicrophoneDevice` is an object `{deviceId, label, …}`; Auto-detect is `deviceId: "default"` (measured
    2026-10-13 while writing Plan 5) ``.
  - In §4.3, wherever `config.saves[N]` appears, write `configWrites.saves[N]`, and add one sentence:
    `` (`status.config` was already a boolean, so the outcomes are published as `configWrites`.) ``
  - In §8, replace the sentence that starts "The Voxtype rows that `remote` mode makes mandatory" with:
    `Under Typeless every Voxtype row is informational: voxtype-version, -status, -output, -device and last-capture,
    and voxtype is not a required tool. The remote never drives Voxtype then; F9 is Omarchy's own binding. The
    ATVVoice rows still count. A VoiceSession "voxtype not responding" does not make the plugin unconfigured.`

- [ ] **Step 3: Final automated check**

Run: `make check; echo MAKE_CHECK_EXIT=$?`
Expected:
- `MAKE_CHECK_EXIT=0`;
- the output includes `runner-bound: ok`, `setup-typeless: all ok`, the keytap unittest `OK`, and
  `integration: 71 passed, 0 failed`.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-10-13-typeless-engine-design.md
git commit -m "docs: Typeless engine in the README; spec marked implemented

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014vQpzXWTp1gDwYSU3hmyiL"
```

- [ ] **Step 5: Install on the host (ask the user first).** These commands change the live desktop: they replace the
  installed plugin and restart the shell, and they install and start a user service. Ask before each command, then
  run it:
  - `make dev-restart`
  - `bash host/omaremote-setup typeless`

  Expected:
  - setup ends with `hotkey: RightAlt (saved)`, or with whatever Typeless holds in `dictationMode[0]`;
  - `omarchy-shell omaremote doctor | jq -r '.rows[] | select(.id | startswith("typeless")) | "\(.id) \(.status)"'`
    lists nothing until the engine is switched, because the rows are Typeless-only.

- [ ] **Step 6: Hardware acceptance (spec §9).** The user does these at the machine, in the order below. Start each
  only when the user says go: they inject real keys. Switch the engine to Typeless in the panel first.
  1. `remote` mode, with Typeless's microphone set to the remote: hold, speak, release. Text is pasted.
  2. `system` mode, with Typeless's microphone set to C922 or Auto-detect: press, speak, press. Text is pasted.
  3. Repeat items 1–2 after `bash host/omaremote-setup typeless --hotkey RightAlt+RightShift` and the same
     shortcut set in Typeless.
  4. Press reset while holding in `remote` mode. Typeless stops.
  5. `systemctl --user stop omaremote-keytap`, then press. The HUD shows `Typeless trigger failed: keytap not running`.
     Then `systemctl --user start omaremote-keytap`, wait 2 s, and press again. It works.
  6. With Voxtype selected, start holding in `remote` mode. Switch to Typeless while holding. Voxtype stops and
     transcribes before the switch commits.
  7. With Typeless selected, start holding in `remote` mode. Switch to Voxtype while holding. Typeless stops before the
     switch commits.
  8. Start an F9 dictation, then switch engines. The dictation is not interrupted.

  Record each item's result, as pass or fail with what was seen. A failure gets its own fix, with a regression test,
  before this plan is done.
