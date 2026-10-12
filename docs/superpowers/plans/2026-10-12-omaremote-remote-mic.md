# Remote Microphone via ATVVoice — Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In `voice.mic = "remote"` mode, holding the Xiaomi remote's mic button dictates through
Voxtype from the remote's own microphone, and releasing it ends the session.

**Architecture:** ATVVoice, built by setup from a pinned upstream commit, runs as a systemd user
unit without `--mic-on-demand`. It exposes the remote's hold-to-talk audio as the PipeWire node
`atvvoice-xiaomi` and reports `streaming`/`connected` on D-Bus. The plugin's existing D-Bus voice
path drives the session. Because nothing but the button can make ATVVoice stream, the 250 ms
arbitration is skipped (`voice.remoteOnDemand = false`), and in remote mode the HID mic key is
dropped so one press cannot start two sessions.

**Tech Stack:** Quickshell QML, plain ES modules under `node --test`, bash (setup, fakes,
integration harness), `busctl`, systemd user units, cargo.

**Spec:** `docs/superpowers/specs/2026-10-12-remote-mic-design.md`. It amends
`docs/superpowers/specs/2026-09-14-omaremote-design.md` §2, §3, §5.1 and §5.2.

## Global Constraints

- ATVVoice repo `https://github.com/b0o/ATVVoice`, pinned rev `0e8f6413dc4bad7a04e3c6b648945439d7a22fac`, installed with `--locked`.
- The unit's ExecStart is `%h/.cargo/bin/atvvoice --device <addr> --name xiaomi`. It never contains `--mic-on-demand`.
- ATV service UUID used to pick the remote: `ab5e0001-5a21-4f05-bc7d-af01f617b664`.
- `voice.remoteOnDemand` is a boolean, defaults to `false`, and any non-boolean normalizes to `false`.
- In remote mode both `mic` edges are dropped before the voice path and before the engine, even while `remoteWarning` is set.
- `keys.mic.trigger` applies only when `voice.mic = "system"`.
- Setup default flow: `deps → keyd → binds → plugin → atvvoice → mic remote → verify`. `--mic system` skips `atvvoice` and ends with `mic system`. Any other value is a usage error.
- The setup step makes no omaremote config edit.
- The agent has no root. Every `sudo`/`pacman` command is printed for the user and never run by a test.
- Tests never touch the real voxtype, systemd, ATVVoice or `~/.config/omaremote`. Integration runs only through `tests/fake-remote.sh`.
- `make check` is green only when its output contains `MAKE_CHECK_EXIT=0` when run as `make check; echo MAKE_CHECK_EXIT=$?`. The unit-test `pass N` line prints long before the integration block finishes.
- `tests/fake-remote.sh <scenario>` takes the scenario name as a positional argument. `ONLY=x` silently runs everything.
- `ipc voice poll -` needs the `-`: the IPC handler has fixed arity.

## Review Focus

1. **The remote drops off Bluetooth mid-hold.** ATVVoice reports `disconnected` (not `connected`) while a `dbus` session records. The user expects the session to stop as if released, not to run to `maxSessionSec`. Task 2 adds this test.
2. **A second press while the previous dictation is still transcribing.** `streaming` arrives with the session in `transcribing`. The user expects it to be ignored, with no new `record start` that would race the typing output. Task 2 adds this test.
3. **The button is pressed while a mic apply or self-test holds the gate.** The new direct-start path must honour the gate like arbitration did. The user expects no session. Task 2 adds this test.
4. **`cargo install` fails (offline, toolchain broken).** The user expects setup to stop with the cargo error, leaving the existing unit file and running service untouched. Task 7 adds this test.
5. **Bluetooth is off or the remote is not paired.** `bluetoothctl` lists nothing, or fails. The user expects setup to stop and say no ATVV remote is paired, not to write a unit with an empty `--device`. Task 7 adds this test.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `lib/Defaults.mjs` | modify | `DEFAULT_VOICE.remoteOnDemand: false` |
| `lib/Config.mjs` | modify | normalize `voice.remoteOnDemand` |
| `lib/VoiceSession.mjs` | modify | direct D-Bus start when `remoteOnDemand` is false; `sourceLost` |
| `lib/Doctor.mjs` | modify | `atvvoice-ondemand` becomes a consistency row |
| `lib/Dbus.mjs` | modify | `parseNameOwnerChanged(line)` |
| `lib/AtvSource.mjs` | create | which org.atvvoice owner is the source; arrivals, departures, races (pure) |
| `lib/Presentation.mjs` | modify | `hidMicLine(cfg)`, `keyboardSourceLine(cfg)` |
| `Service.qml` | modify | drop HID mic in remote mode; status fields |
| `components/AtvvoiceMonitor.qml` | modify | thin driver of `AtvSource`; NameOwnerChanged monitor; `retryMs`/`retryAt` |
| `components/VoiceTab.qml` | modify | source lines from Presentation |
| `host/omaremote-setup` | modify | `atvvoice` subcommand, `--mic`, new default flow |
| `tests/fakes/bin/systemctl` | modify | ExecStart answer driven by `atv.ondemand` knob |
| `tests/fakes/bin/busctl` | modify | NameOwnerChanged monitor fed by `atv.owners`; owner from `atv.owner`; slow replies via `atv.prop-delay` |
| `tests/fake-remote.sh` | modify | `set_cfg`/`use_system`/`use_ondemand`; scenario updates; 7 new scenarios |
| `tests/setup-atvvoice.sh` | create | setup `atvvoice` step and `--mic` flow against stubs |
| `Makefile` | modify | run `tests/setup-atvvoice.sh` in `check` |
| `tests/*.test.mjs` | modify/create | Config, VoiceSession, Doctor, Dbus, Presentation, AtvSource (new) |
| docs | modify | base spec, host-setup spec, hw keymap doc |

---

### Task 1: `voice.remoteOnDemand` in config

**Files:**
- Modify: `lib/Defaults.mjs:26-34` (`DEFAULT_VOICE`)
- Modify: `lib/Config.mjs:93-98` (voice normalization)
- Test: `tests/Config.test.mjs`

**Interfaces:**
- Produces: `config.voice.remoteOnDemand: boolean`. It is always present after `normalizeConfig`. Tasks 2, 3 and 4 read it.

- [ ] **Step 1: Write the failing tests** (append to `tests/Config.test.mjs`)

```js
test("voice.remoteOnDemand defaults to false: the shipped ATVVoice unit has no --mic-on-demand", () => {
  const { config } = normalizeConfig(DEFAULT_CONFIG);
  assert.equal(config.voice.remoteOnDemand, false);
  const { config: bare } = normalizeConfig({});
  assert.equal(bare.voice.remoteOnDemand, false);
});

test("voice.remoteOnDemand keeps a real true and normalizes every non-boolean to false", () => {
  const n = (v) => normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, remoteOnDemand: v } }).config.voice.remoteOnDemand;
  assert.equal(n(true), true);
  assert.equal(n(false), false);
  for (const junk of ["true", 1, null, {}, []]) assert.equal(n(junk), false, `input ${JSON.stringify(junk)}`);
});

test("unknown voice fields survive normalization next to remoteOnDemand", () => {
  const { config } = normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, futureKnob: "x", remoteOnDemand: true } });
  assert.equal(config.voice.futureKnob, "x");
  assert.equal(config.voice.remoteOnDemand, true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/Config.test.mjs`
Expected: FAIL. The first test gets `undefined` where it expects `false`, and the `"true"` case returns `"true"`.

- [ ] **Step 3: Implement**

In `lib/Defaults.mjs`, add the field to `DEFAULT_VOICE` after `actionFlash: true,`:

```js
  // Plan 4: describes how ATVVoice runs, not a preference. false = no --mic-on-demand, so only the
  // remote's button can make it stream and the D-Bus start needs no arbitration.
  remoteOnDemand: false,
```

In `lib/Config.mjs`, after `config.voice.actionFlash = v.actionFlash !== false;`:

```js
  config.voice.remoteOnDemand = v.remoteOnDemand === true;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/Config.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add lib/Defaults.mjs lib/Config.mjs tests/Config.test.mjs
git commit -m "feat(config): voice.remoteOnDemand, default false"
```

---

### Task 2: Direct D-Bus start without on-demand

**Files:**
- Modify: `lib/VoiceSession.mjs` (`dbus()`, near line 252)
- Test: `tests/VoiceSession.test.mjs`

**Interfaces:**
- Consumes: `cfg.voice.remoteOnDemand` (Task 1).
- Produces: none new. With `remoteOnDemand=false`, `dbus(streaming)` from `idle` returns `[cmd start, hud "starting…", state starting/dbus]`. With `true` it behaves as today.

- [ ] **Step 1: Make the existing arbitration tests select on-demand explicitly**

The arbitration tests assume the old behaviour, which is now opt-in. In `tests/VoiceSession.test.mjs`, add this helper next to `pttCfg` (line 12):

```js
// Arbitration (§5.2) only exists when ATVVoice runs with --mic-on-demand. The shipped default is
// remoteOnDemand=false (plan 4: the Xiaomi remote yields no audio for a host MIC_OPEN), where a
// streaming signal can only be the button and starts at once -- so arbitration tests opt in.
const onDemandCfg = () => cfg({ keys: { ...DEFAULT_CONFIG.keys, mic: { trigger: "ptt" } }, voice: { ...DEFAULT_CONFIG.voice, remoteOnDemand: true } });
```

Change `idleSession()` (line 130) to construct `createVoiceSession(onDemandCfg())` in place of
`pttCfg()`.

In the test "arbitration still runs in system mode" (line 322), change the config to
`cfg({ voice: { ...DEFAULT_CONFIG.voice, mic: "system", remoteOnDemand: true } })`.

- [ ] **Step 2: Write the failing tests** (append after the arbitration block, before `// ---- recovery (§5.3) ----`)

```js
// ---- direct D-Bus start, no on-demand (plan 4 §4.1) ----
function directIdle() {
  const vs = createVoiceSession(cfg());                     // remoteOnDemand defaults to false
  vs.setDbusSource({ sender: ":1.42", generation: 0 });
  vs.status("idle", 0, { fresh: true });
  return vs;
}
function directRecording() {
  const vs = directIdle();
  const fx = vs.dbus(D("streaming"), 0);
  vs.cmdExit(cmdId(fx, "start"), 0, 20);
  vs.status("recording", 100);
  return vs;
}

test("without on-demand, streaming from idle starts at once: record start, owner dbus, no arbitration", () => {
  const vs = directIdle();
  const fx = vs.dbus(D("streaming"), 0);
  assert.deepEqual(kinds(fx), ["start"]);
  assert.equal(stateOf(fx), "starting");
  assert.equal(vs.snapshot().owner, "dbus");
  assert.ok(!byType(fx, "state").some(s => s.state === "arbitrating"), "must not pass through arbitrating");
  assert.equal(vs.nextDeadline(), 1500, "the next deadline is the start timeout, not arbitrationMs");
});

test("without on-demand, a full hold: recording on confirm, release re-reads then stops, stat source dbus", () => {
  const vs = directRecording();
  assert.equal(vs.snapshot().state, "recording");
  const end = vs.dbus(D("connected"), 900);
  assert.deepEqual(kinds(end), []);
  assert.equal(byType(end, "readAtv").length, 1);
  assert.deepEqual(kinds(vs.atvRead(A(vs, "connected"), 910)), ["stop"]);
  const done = vs.status("idle", 1200);
  assert.equal(byType(done, "stat")[0].session.source, "dbus");
});

test("without on-demand, a release while starting latches the stop until recording is confirmed", () => {
  const vs = directIdle();
  const fx = vs.dbus(D("streaming"), 0);
  assert.deepEqual(kinds(vs.dbus(D("connected"), 60)), []);
  vs.cmdExit(cmdId(fx, "start"), 0, 70);
  assert.deepEqual(kinds(vs.status("recording", 100)), ["stop"]);
});

test("without on-demand, a keyboard session observed first keeps its owner and streaming starts nothing", () => {
  const vs = directIdle();
  vs.status("recording", 0);
  assert.equal(vs.snapshot().owner, "keyboard");
  assert.deepEqual(kinds(vs.dbus(D("streaming"), 30)), []);
  assert.equal(vs.snapshot().owner, "keyboard");
});

// Review focus 3: the direct path must honour the gate exactly like arbitration did.
test("without on-demand, streaming while a gate is held starts nothing", () => {
  const vs = directIdle();
  assert.equal(vs.gate.acquire("mic-apply"), true);
  const fx = vs.dbus(D("streaming"), 0);
  assert.deepEqual(kinds(fx), []);
  assert.equal(vs.snapshot().state, "idle");
});

// Review focus 2: a press while the last dictation is still transcribing must not race its output.
test("without on-demand, streaming during transcribing is ignored", () => {
  const vs = directRecording();
  vs.dbus(D("connected"), 900);
  vs.atvRead(A(vs, "connected"), 910);
  vs.status("transcribing", 950);
  assert.equal(vs.snapshot().state, "transcribing");
  assert.deepEqual(kinds(vs.dbus(D("streaming"), 1000)), []);
  assert.equal(vs.snapshot().state, "transcribing");
});

// Review focus 1: the remote dropping off Bluetooth mid-hold ends the session like a release.
test("without on-demand, the remote disconnecting mid-hold stops the session after the re-read", () => {
  const vs = directRecording();
  const drop = vs.dbus(D("disconnected"), 900);
  assert.equal(byType(drop, "readAtv").length, 1);
  assert.deepEqual(kinds(vs.atvRead(A(vs, "disconnected"), 910)), ["stop"]);
});
```

- [ ] **Step 3: Run them to verify the new ones fail and the old ones still pass**

Run: `node --test tests/VoiceSession.test.mjs`
Expected: the first new test FAILS. `kinds(fx)` is `[]` because the state is `arbitrating`. The
hold, latch, transcribing and disconnect tests fail for the same reason. Every pre-existing test
PASSES, which confirms that Step 1 moved them to on-demand.

- [ ] **Step 4: Implement**

In `lib/VoiceSession.mjs`, in `dbus()`, replace the start branch:

```js
    if (is && !was) {
      if (st === "idle" && dbusEnabled && gates.size === 0) {
        if (backend.cls === "recording") adoptKeyboard(out, now);
        else { dl.arb = now + v().arbitrationMs; hud(out, "…"); setState(out, "arbitrating", null); }
      }
      return out;
    }
```

with:

```js
    if (is && !was) {
      if (st === "idle" && dbusEnabled && gates.size === 0) {
        if (backend.cls === "recording") adoptKeyboard(out, now);
        // Plan 4 §4.1: without --mic-on-demand only the remote's button can make ATVVoice stream, so
        // the button-vs-capture-client ambiguity arbitration resolves cannot arise. Waiting 250 ms
        // here would only cut the first word.
        else if (!v().remoteOnDemand) startSession(out, now, "dbus");
        else { dl.arb = now + v().arbitrationMs; hud(out, "…"); setState(out, "arbitrating", null); }
      }
      return out;
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/VoiceSession.test.mjs && node --test "tests/*.test.mjs"`
Expected: PASS, all tests. If any other pre-existing test that sends `D("streaming")` from `idle`
now fails, it relied on arbitration. Give it `onDemandCfg()` and note it in the commit message. Do
not change its assertions.

- [ ] **Step 6: Commit**

```bash
git add lib/VoiceSession.mjs tests/VoiceSession.test.mjs
git commit -m "feat(voice): start a D-Bus session at once when ATVVoice has no on-demand"
```

---

### Task 3: Doctor on-demand consistency row

**Files:**
- Modify: `lib/Doctor.mjs:90` (the `atvvoice-ondemand` row)
- Modify: `tests/fakes/bin/systemctl` (the ExecStart answer)
- Test: `tests/Doctor.test.mjs`

**Interfaces:**
- Consumes: `facts.atvvoice.micOnDemand` (boolean from `host/omaremote-facts`, unchanged) and
  `config.voice.remoteOnDemand` (Task 1).
- Produces: row id `atvvoice-ondemand` keeps its id, so `REMOTE_ROWS`/`summarize` are unchanged.
  It passes iff `micOnDemand === remoteOnDemand`. It is `info` in system mode and `unknown` when
  the fact is missing.

- [ ] **Step 1: Write the failing tests**

In `tests/Doctor.test.mjs`, change the `good()` fixture's atvvoice line to
`micOnDemand: false`, which matches the shipped default. Then append:

```js
test("atvvoice-ondemand passes when the unit and voice.remoteOnDemand agree (both off)", () => {
  assert.equal(row(evaluate(good(), config), "atvvoice-ondemand").status, "pass");
});

test("atvvoice-ondemand fails when the unit has --mic-on-demand but the config says false", () => {
  const f = good(); f.atvvoice.micOnDemand = true;
  const rows = evaluate(f, config);
  const r = row(rows, "atvvoice-ondemand");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /unit: on-demand, config: false/);
  assert.equal(summarize(rows, config), "remoteWarning");
});

test("atvvoice-ondemand fails in the other direction too, and passes when both are on", () => {
  const onCfg = normalizeConfig({ ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, mic: { supported: false } }, voice: { ...DEFAULT_CONFIG.voice, remoteOnDemand: true } }).config;
  assert.equal(row(evaluate(good(), onCfg), "atvvoice-ondemand").status, "fail");
  const f = good(); f.atvvoice.micOnDemand = true;
  assert.equal(row(evaluate(f, onCfg), "atvvoice-ondemand").status, "pass");
});

test("atvvoice-ondemand is unknown without the fact and info in system mode", () => {
  const f = good(); delete f.atvvoice.micOnDemand;
  assert.equal(row(evaluate(f, config), "atvvoice-ondemand").status, "unknown");
  const sys = normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, mic: "system" } }).config;
  const g = good(); g.atvvoice.micOnDemand = true;
  assert.equal(row(evaluate(g, sys), "atvvoice-ondemand").status, "info");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/Doctor.test.mjs`
Expected: FAIL. With `micOnDemand: false` the old row reports `fail` ("runs with
--mic-on-demand"), and the mismatch detail does not match.

- [ ] **Step 3: Implement the row**

In `lib/Doctor.mjs`, replace the `push("atvvoice-ondemand", …)` line with:

```js
  // Plan 4 §5: the unit and voice.remoteOnDemand must agree. With on-demand running but the config
  // saying false, a capture client's open would start an unarbitrated session; the reverse adds a
  // pointless 250 ms to every press.
  const od = get(facts, "atvvoice.micOnDemand");
  const wantOd = get(config, "voice.remoteOnDemand") === true;
  const odKnown = od !== undefined && od !== null;
  push("atvvoice-ondemand", "ATVVoice --mic-on-demand matches voice.remoteOnDemand",
       infoOr(odKnown ? tri(od === wantOd) : "unknown"), BOTH,
       odKnown ? `unit: ${od ? "on-demand" : "button only"}, config: ${wantOd}` : "",
       wantOd ? "systemctl --user edit atvvoice  # add --mic-on-demand to ExecStart"
              : "bash <plugin-dir>/host/omaremote-setup atvvoice  # rewrites the unit without --mic-on-demand");
```

- [ ] **Step 4: Make the fake systemctl answer follow a knob**

In `tests/fakes/bin/systemctl`, change the header comment line about ExecStart to:

```bash
#   `show --property=ExecStart --value` (host/omaremote-facts) answers a button-only ExecStart line, or an
#   on-demand one while the knob atv.ondemand exists -- independent of the Job/ActiveState/InvocationID
```

and replace the `echo '{ path=/usr/bin/atvvoice ; argv[]=/usr/bin/atvvoice --mic-on-demand ; ignore_errors=no }'` line with:

```bash
      if [[ -e $d/atv.ondemand ]]; then
        echo '{ path=/usr/bin/atvvoice ; argv[]=/usr/bin/atvvoice --mic-on-demand ; ignore_errors=no }'
      else
        echo '{ path=/usr/bin/atvvoice ; argv[]=/usr/bin/atvvoice --device AA:BB:CC:DD:EE:FF --name fake ; ignore_errors=no }'
      fi
```

- [ ] **Step 5: Run the unit tests and the doctor scenario**

Run: `node --test tests/Doctor.test.mjs && bash tests/fake-remote.sh doctor_rows`
Expected: PASS, and `ok   doctor_rows`. The scenario requires `summary == ready`, which now
depends on the default knob-less fake agreeing with `remoteOnDemand=false`.

- [ ] **Step 6: Commit**

```bash
git add lib/Doctor.mjs tests/Doctor.test.mjs tests/fakes/bin/systemctl
git commit -m "feat(doctor): on-demand row checks unit/config agreement instead of requiring on-demand"
```

---

### Task 4: Remote mode drops the HID mic key; status and Voice tab

**Files:**
- Modify: `Service.qml:221-245` (`onKeyEdge`), `Service.qml:584-606` (`statusJson`)
- Modify: `lib/Presentation.mjs` (two new exports)
- Modify: `components/VoiceTab.qml:69-76` (Sources text)
- Modify: `tests/fake-remote.sh` (helpers, existing scenarios, 2 new scenarios)
- Test: `tests/Presentation.test.mjs`

**Interfaces:**
- Consumes: `config.voice.mic`, `config.voice.remoteOnDemand` (Task 1), `config.keys.mic`.
- Produces:
  - status JSON top-level `voiceMode: "remote"|"system"|null` and `remoteOnDemand: boolean|null`.
  - `Presentation.hidMicLine(cfg) → string` and `Presentation.keyboardSourceLine(cfg) → string`.
  - integration helpers `set_cfg <jq-filter> <status-expr> <want>`, `use_system`, `use_ondemand`, and `use_ptt`, which now also selects system mode.

- [ ] **Step 1: Write the failing Presentation tests**

At the top of `tests/Presentation.test.mjs`, add `hidMicLine, keyboardSourceLine` to the existing
`../lib/Presentation.mjs` import, and add these two imports below it:

```js
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";
```

Then append:

```js
const pcfg = (voice = {}, mic = {}) => normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, ...voice }, keys: { ...DEFAULT_CONFIG.keys, mic: { ...DEFAULT_CONFIG.keys.mic, ...mic } } }).config;

test("hidMicLine: remote mode ignores the key whatever its trigger; system mode reports the trigger", () => {
  assert.equal(hidMicLine(pcfg({ mic: "remote" })), "ignored in remote mode — hold the remote's mic button to talk");
  assert.equal(hidMicLine(pcfg({ mic: "remote" }, { trigger: "ptt" })), "ignored in remote mode — hold the remote's mic button to talk");
  assert.equal(hidMicLine(pcfg({ mic: "system" })), "toggle (press to start, press again to stop)");
  assert.equal(hidMicLine(pcfg({ mic: "system" }, { trigger: "ptt" })), "push-to-talk");
  assert.equal(hidMicLine(pcfg({ mic: "system" }, { trigger: "key" })), "not available");
  assert.equal(hidMicLine(pcfg({ mic: "system" }, { supported: false })), "not available");
  assert.equal(hidMicLine(null), "");
});

test("keyboardSourceLine warns that F9 is silent in remote mode without on-demand", () => {
  assert.equal(keyboardSourceLine(pcfg({ mic: "remote" })), "observed — no audio in remote mode unless the remote's mic button is held; use system mode for F9");
  assert.equal(keyboardSourceLine(pcfg({ mic: "remote", remoteOnDemand: true })), "observed");
  assert.equal(keyboardSourceLine(pcfg({ mic: "system" })), "observed");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/Presentation.test.mjs`
Expected: FAIL. `hidMicLine` is not exported (SyntaxError on import).

- [ ] **Step 3: Implement the Presentation helpers** (append to `lib/Presentation.mjs`)

```js
// Plan 4 §4.2/§4.5: Voice tab source lines. In remote mode the HID mic key is dropped before voice
// and engine, so its trigger is irrelevant there; without on-demand an F9 session captures silence.
export function hidMicLine(cfg) {
  if (!cfg) return "";
  const m = cfg.keys.mic;
  if (m.supported === false) return "not available";
  if (cfg.voice.mic === "remote") return "ignored in remote mode — hold the remote's mic button to talk";
  if (m.trigger === "key") return "not available";
  return m.trigger === "toggle" ? "toggle (press to start, press again to stop)" : "push-to-talk";
}
export function keyboardSourceLine(cfg) {
  return cfg && cfg.voice.mic === "remote" && !cfg.voice.remoteOnDemand
    ? "observed — no audio in remote mode unless the remote's mic button is held; use system mode for F9"
    : "observed";
}
```

- [ ] **Step 4: Run the Presentation tests to verify they pass**

Run: `node --test tests/Presentation.test.mjs`
Expected: PASS.

- [ ] **Step 5: Update the integration helpers and existing scenarios**

In `tests/fake-remote.sh`, replace the `use_ptt()` function and its comment block (lines 189-197)
with:

```bash
set_cfg() {   # set_cfg <jq-filter> <status-expr> <want>: edit config.json, then wait for the reload to land
  local f=$XDG_CONFIG_HOME/omaremote/config.json
  jq "$1" "$f" > "$F/cfg.json" && cat "$F/cfg.json" > "$f"
  wait_for "$2" "$3" 5
}
# Plan 4 §4.2: in remote mode -- the harness default -- the HID mic key is dropped before voice and
# engine, because the remote's own ATVV stream is the trigger there. Every scenario that drives a
# session with `ipc key mic` therefore selects system mode first. use_ptt also selects ptt: the
# shipped trigger is "toggle", where the release is ignored and the `up` would never stop anything.
use_system() { set_cfg '.voice.mic = "system"' '.voiceMode' system; }
use_ptt() { set_cfg '.voice.mic = "system" | .keys.mic.trigger = "ptt"' '.micTrigger' ptt && wait_for '.voiceMode' system 2; }
# Arbitration (§5.2) exists only with --mic-on-demand; the default remoteOnDemand=false starts at once.
use_ondemand() { set_cfg '.voice.remoteOnDemand = true' '.remoteOnDemand' true; }
```

Add `use_system || return 1` as the line right after `ready || return 1` in each of these
scenarios, which press `ipc key mic` without `use_ptt`: `s_config_reload_aborts_session`,
`s_mic_toggle_session`, `s_panic_during_recording`, `s_recovery_restart_bounded`,
`s_start_never_confirms`, `s_voxtype_absent_is_unconfigured`, `s_selftest_blocks_voice_starts`.
The last two only assert that nothing starts. Without system mode they would pass vacuously after
this task, because the key is dropped before the gate they are meant to exercise.

Add `use_ondemand || return 1` right after `ready || return 1` in the scenarios that wait for
`arbitrating`: `s_dbus_arbitration_short_tap` and `s_voice_state_verb`.

Replace `s_remote_warning_disables_dbus_path` with:

```bash
s_remote_warning_disables_dbus_path() {   # §5.4 + plan 4 §4.2: remote mode with audio.device ≠ NodeName → warning, D-Bus start
  ready || return 1                       # path off, and the HID mic key is still dropped (it would record silence)
  printf 'default' > "$F/vox.config"
  ipc voice audioDevice - > /dev/null
  wait_for '.remote.warning' true 3 || return 1
  echo streaming >> "$F/atv.signals"; sleep 0.4
  [[ $(jget '.voice.state') == idle ]] || return 1
  echo connected >> "$F/atv.signals"
  ipc key mic down > /dev/null; sleep 0.2; ipc key mic up > /dev/null; sleep 0.2
  [[ $(jget '.voice.state') == idle ]] || return 1
  no_line "$F/vox.log" "voxtype record start"
}
```

- [ ] **Step 6: Write the two new failing scenarios** (define them after `s_dbus_session`, and add their `scenario` lines right after `scenario dbus_session s_dbus_session`)

```bash
s_remote_hold_session() {                 # plan 4 §4.1: no on-demand → streaming starts at once, never arbitrating
  ready || return 1
  [[ $(jget '.remoteOnDemand') == false ]] || return 1
  echo streaming >> "$F/atv.signals"
  local seen="" st i
  for i in $(seq 1 60); do                # sample every state from the press until recording (≤ 3 s)
    st=$(jget '.voice.state'); seen+=" $st"
    [[ $st == recording ]] && break
    sleep 0.05
  done
  [[ $st == recording ]] || { echo "    never recorded; states:$seen"; return 1; }
  [[ $seen != *arbitrating* ]] || { echo "    passed through arbitrating:$seen"; return 1; }
  [[ $(jget '.voice.owner') == dbus ]] || return 1
  echo connected >> "$F/atv.signals"
  wait_for '.voice.state' idle 5 || return 1
  has_line "$F/vox.log" "voxtype record stop"
}
s_remote_mode_ignores_hid_mic() {         # plan 4 §4.2: remote mode drops both mic edges before voice and engine
  ready || return 1
  [[ $(jget '.voiceMode') == remote ]] || return 1
  ipc key mic down > /dev/null; sleep 0.2; ipc key mic up > /dev/null; sleep 0.3
  [[ $(jget '.voice.state') == idle ]] || return 1
  no_line "$F/vox.log" "voxtype record start" || return 1
  [[ ! -s $F/actions.log ]] || { echo "    actions.log:"; sed 's/^/      /' "$F/actions.log"; return 1; }
}
scenario remote_hold_session s_remote_hold_session
scenario remote_mode_ignores_hid_mic s_remote_mode_ignores_hid_mic
```

`s_remote_hold_session` samples the state every 50 ms. Arbitration holds `arbitrating` for at least
250 ms plus a re-read, so with on-demand behaviour at least four samples would show it. This
assertion is about the state sequence, not timing, so it does not flake under load. Do not add a
latency assertion; see the carry-over note on `s_mic_apply_second_request_is_busy`.

- [ ] **Step 7: Run the new scenarios to verify they fail**

Run: `bash tests/fake-remote.sh remote_mode_ignores_hid_mic; bash tests/fake-remote.sh remote_hold_session`
Expected: `FAIL remote_mode_ignores_hid_mic`, because `.voiceMode` is null and the key starts a
toggle session. `FAIL remote_hold_session` on `.remoteOnDemand` being null.

- [ ] **Step 8: Implement in Service.qml**

In `onKeyEdge`, directly after the self-test block (the `if (selftest && selftest.active()) { … return true }`) and before `var micTrigger = …`, insert:

```js
    // Plan 4 §4.2: in remote mode the mic key reaches neither voice nor engine. The remote's own ATVV
    // stream (D-Bus) is the trigger there, and the HID key is a press-time pulse from the same press:
    // acting on it too would start a second session. Dropped even under remoteWarning, because
    // Voxtype's device is then the ATVVoice node and an HID-started session would record silence.
    if (name === "mic" && root.config.voice.mic === "remote") { root.rearm(); return true }
```

In `statusJson()`, after the `micTrigger: …,` line, add:

```js
      // Published for the same reason as micTrigger: `config` is a boolean, so tests and the panel
      // cannot otherwise wait for a voice.mic / remoteOnDemand reload to take effect.
      voiceMode: root.config ? root.config.voice.mic : null,
      remoteOnDemand: root.config ? root.config.voice.remoteOnDemand : null,
```

- [ ] **Step 9: Implement the Voice tab lines**

In `components/VoiceTab.qml`, in the Sources `Text`, replace the two lines

```
        "\nHID mic key: " + (root.cfg && root.cfg.keys.mic.supported !== false && root.cfg.keys.mic.trigger !== "key" ? (root.cfg.keys.mic.trigger === "toggle" ? "toggle (press to start, press again to stop)" : "push-to-talk") : "not available") +
        "\nkeyboard (F9): observed" +
```

with

```
        "\nHID mic key: " + Presentation.hidMicLine(root.cfg) +
        "\nkeyboard (F9): " + Presentation.keyboardSourceLine(root.cfg) +
```

(`VoiceTab.qml` already imports `lib/Presentation.mjs` as `Presentation` for `micStatusLine`. Confirm with `grep -n Presentation components/VoiceTab.qml`.)

- [ ] **Step 10: Run the full integration suite**

Run: `make check; echo MAKE_CHECK_EXIT=$?`
Expected: `MAKE_CHECK_EXIT=0`. The integration summary is 46 + 2 = `48 passed, 0 failed`. If a
scenario not listed in Step 5 fails on a `mic` press, it drove HID in remote mode. Add
`use_system || return 1` after its `ready` line, and name it in the commit message.

- [ ] **Step 11: Commit**

```bash
git add Service.qml lib/Presentation.mjs components/VoiceTab.qml tests/Presentation.test.mjs tests/fake-remote.sh
git commit -m "feat(voice): remote mode drops the HID mic key; publish voiceMode/remoteOnDemand"
```

---

### Task 5: ATVVoice source tracking as a pure state machine (arrivals, departures, races)

**Files:**
- Create: `lib/AtvSource.mjs`
- Test: `tests/AtvSource.test.mjs`
- Modify: `lib/Dbus.mjs` (new export `parseNameOwnerChanged`)
- Test: `tests/Dbus.test.mjs`
- Modify: `components/AtvvoiceMonitor.qml` (becomes a thin driver of `AtvSource`)
- Modify: `Service.qml:596` (status `remote`)
- Modify: `tests/fakes/bin/busctl`, `tests/fake-remote.sh`

**Interfaces:**
- Consumes: `Systemd.backoffMs(attempt)` (existing; 1000·2ⁿ capped at 30000).
- Produces:
  - `Dbus.parseNameOwnerChanged(line: string) → { name, oldOwner, newOwner } | null`.
  - `AtvSource.createAtvSource({ backoffMs }) →` an object with:
    - `start(now)`, `discovered(names: string[], now)`, `ownerResolved(id: number, owner: string|null, now)`, `monitorExited(now)`, `nameOwnerChanged(ev, now)` and `retryFired(now)`. Each returns an effects array.
    - `isCurrent(epoch) → boolean`.
    - `snapshot() → { sender, busName, epoch, retryMs, retryAt, attempts, monitorRunning, retiring, pendingMonitor }`.
  - Effect types, in emission order: `{type:"discover"}`, `{type:"resolveOwner", id, name}`, `{type:"source", sender, busName, epoch}` (`sender ""` means revoked), `{type:"startMonitor"}`, `{type:"stopMonitor"}`, `{type:"retry", ms}` and `{type:"cancelRetry"}`.
  - `AtvvoiceMonitor` keeps its public API (`start()`, `readState()`, `micClose()`, `micToggle()`, the `busName`, `sender` and `generation` properties, and the `source`, `signalEvent`, `stateRead` and `nodeName` signals). It adds `retryMs: int` and `retryAt: double`.
  - status JSON `remote.retryMs` and `remote.retryAt`.
  - Two fake busctl knobs:
    - `atv.owners`: each appended line `<name> <old> <new>` (`-` for empty) is emitted as a NameOwnerChanged signal.
    - `atv.owner`: the fake daemon's unique name. It defaults to `:1.99` and is used by `list`, `GetNameOwner` and the MicStateChanged sender.
    - `atv.prop-delay`: seconds. When present, `get-property` captures its answer at invocation, then sleeps before printing, like a slow daemon.

- [ ] **Step 1: Write the failing parser tests** (append to `tests/Dbus.test.mjs`; add `parseNameOwnerChanged` to its import)

```js
// Shape measured 2026-10-12 with `busctl --user --json=short monitor` while ATVVoice started and stopped.
const noc = (data, extra = {}) => JSON.stringify({ type: "signal", sender: "org.freedesktop.DBus", path: "/org/freedesktop/DBus",
  interface: "org.freedesktop.DBus", member: "NameOwnerChanged", payload: { type: "sss", data }, ...extra });

test("parseNameOwnerChanged reads an org.atvvoice arrival and departure", () => {
  assert.deepEqual(parseNameOwnerChanged(noc(["org.atvvoice.xiaomi", "", ":1.66819"])), { name: "org.atvvoice.xiaomi", oldOwner: "", newOwner: ":1.66819" });
  assert.deepEqual(parseNameOwnerChanged(noc(["org.atvvoice.xiaomi", ":1.66819", ""])), { name: "org.atvvoice.xiaomi", oldOwner: ":1.66819", newOwner: "" });
});

test("parseNameOwnerChanged rejects other names, other senders, other members and junk", () => {
  assert.equal(parseNameOwnerChanged(noc(["org.other.x", "", ":1.5"])), null);
  assert.equal(parseNameOwnerChanged(noc(["org.atvvoice.x", "", ":1.5"], { sender: ":1.9" })), null);
  assert.equal(parseNameOwnerChanged(noc(["org.atvvoice.x", "", ":1.5"], { member: "NameLost" })), null);
  assert.equal(parseNameOwnerChanged(noc(["org.atvvoice.x"])), null);
  assert.equal(parseNameOwnerChanged("not json"), null);
  assert.equal(parseNameOwnerChanged(""), null);
});
```

- [ ] **Step 2: Write the failing state-machine tests** (`tests/AtvSource.test.mjs`)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAtvSource } from "../lib/AtvSource.mjs";
import { backoffMs } from "../lib/Systemd.mjs";

const types = (fx) => fx.map(e => e.type);
const N = "org.atvvoice.xiaomi";
const mk = () => createAtvSource({ backoffMs });
function connected(owner = ":1.99") {
  const s = mk();
  s.start(0);
  const r = s.discovered([N], 0)[0];
  s.ownerResolved(r.id, owner, 0);
  return s;
}
const resolve = (s, owner, now) => { const r = s.discovered([N], now)[0]; return s.ownerResolved(r.id, owner, now); };

test("startup: discover, resolve the owner, then announce the source and start the monitor", () => {
  const s = mk();
  assert.deepEqual(types(s.start(0)), ["discover"]);
  const r = s.discovered([N], 10);
  assert.deepEqual(r, [{ type: "resolveOwner", id: r[0].id, name: N }]);
  const fx = s.ownerResolved(r[0].id, ":1.99", 20);
  assert.deepEqual(types(fx), ["cancelRetry", "source", "startMonitor"]);
  assert.equal(fx[1].sender, ":1.99");
  assert.equal(fx[1].busName, N);
  assert.equal(fx[1].epoch, s.snapshot().epoch);
  assert.equal(s.snapshot().retryAt, 0);
});

test("no daemon: the backoff is 1 s, 2 s, then 4 s, each with a retryAt deadline", () => {
  const s = mk();
  s.start(0);
  assert.deepEqual(s.discovered([], 0), [{ type: "retry", ms: 1000 }]);
  assert.equal(s.snapshot().retryAt, 1000);
  s.retryFired(1000); s.discovered([], 1000);
  assert.equal(s.snapshot().retryMs, 2000);
  s.retryFired(3000); s.discovered([], 3000);
  assert.deepEqual([s.snapshot().retryMs, s.snapshot().retryAt], [4000, 7000]);
});

test("an arrival cancels the pending retry, resets the backoff and rediscovers at once", () => {
  const s = mk();
  s.start(0); s.discovered([], 0); s.retryFired(1000); s.discovered([], 1000);
  const fx = s.nameOwnerChanged({ name: N, oldOwner: "", newOwner: ":1.5" }, 1500);
  assert.deepEqual(types(fx), ["cancelRetry", "discover"]);
  assert.equal(s.snapshot().retryAt, 0);
  assert.equal(s.snapshot().attempts, 0);
});

test("a departure revokes at once and stops the monitor; its exit then backs off only once", () => {
  const s = connected();
  const fx = s.nameOwnerChanged({ name: N, oldOwner: ":1.99", newOwner: "" }, 100);
  assert.deepEqual(types(fx), ["source", "stopMonitor", "retry"]);
  assert.equal(fx[0].sender, "");
  assert.equal(fx[0].busName, "");
  assert.equal(s.snapshot().sender, "");
  assert.deepEqual(s.monitorExited(150), [], "a retiring monitor's exit is neither a second revoke nor a second backoff");
  assert.equal(s.snapshot().retryMs, 1000);
});

test("departure then arrival before the old monitor exits: the new owner wins and the old exit cannot clear it", () => {
  const s = connected(":1.99");
  s.nameOwnerChanged({ name: N, oldOwner: ":1.99", newOwner: "" }, 100);
  assert.deepEqual(types(s.nameOwnerChanged({ name: N, oldOwner: "", newOwner: ":1.77" }, 110)), ["cancelRetry", "discover"]);
  const fx = resolve(s, ":1.77", 130);
  assert.deepEqual(types(fx), ["cancelRetry", "source"], "the monitor start waits for the old monitor to exit");
  assert.equal(s.snapshot().sender, ":1.77");
  assert.deepEqual(s.monitorExited(140), [{ type: "startMonitor" }]);
  assert.equal(s.snapshot().sender, ":1.77");
  assert.equal(s.snapshot().retryAt, 0);
});

test("a direct owner replacement in one signal revokes the old owner and rediscovers", () => {
  const s = connected(":1.99");
  const fx = s.nameOwnerChanged({ name: N, oldOwner: ":1.99", newOwner: ":1.77" }, 100);
  assert.deepEqual(types(fx), ["source", "stopMonitor", "cancelRetry", "discover"]);
  assert.equal(fx[0].sender, "");
  resolve(s, ":1.77", 120);
  assert.deepEqual(s.monitorExited(130), [{ type: "startMonitor" }]);
  assert.equal(s.snapshot().sender, ":1.77");
});

test("an arrival naming the current owner changes nothing", () => {
  assert.deepEqual(connected(":1.99").nameOwnerChanged({ name: N, oldOwner: "", newOwner: ":1.99" }, 100), []);
});

test("a departure of some other org.atvvoice name changes nothing", () => {
  assert.deepEqual(connected().nameOwnerChanged({ name: "org.atvvoice.other", oldOwner: ":1.5", newOwner: "" }, 100), []);
});

test("while connected, another org.atvvoice name appearing leaves the current source alone", () => {
  const s = connected(":1.99");
  const epoch = s.snapshot().epoch;
  assert.deepEqual(s.nameOwnerChanged({ name: "org.atvvoice.other", oldOwner: "", newOwner: ":1.5" }, 100), []);
  assert.equal(s.snapshot().sender, ":1.99");
  assert.equal(s.isCurrent(epoch), true);
});

test("before any connection, an arrival of any org.atvvoice name triggers discovery", () => {
  const s = mk();
  s.start(0); s.discovered([], 0);
  assert.deepEqual(types(s.nameOwnerChanged({ name: "org.atvvoice.other", oldOwner: "", newOwner: ":1.5" }, 100)), ["cancelRetry", "discover"]);
});

test("an owner result that arrives after its name was revoked is ignored", () => {
  const s = mk();
  s.start(0);
  const r = s.discovered([N], 0)[0];
  s.nameOwnerChanged({ name: N, oldOwner: ":1.99", newOwner: "" }, 5);
  assert.deepEqual(s.ownerResolved(r.id, ":1.99", 10), []);
  assert.equal(s.snapshot().sender, "");
});

test("an owner result from a lookup older than the latest discovery is stale even though busName is set again", () => {
  const s = mk();
  s.start(0);
  const old = s.discovered([N], 0)[0];                       // lookup #1 in flight for :1.99 …
  s.nameOwnerChanged({ name: N, oldOwner: ":1.99", newOwner: "" }, 5);
  s.nameOwnerChanged({ name: N, oldOwner: "", newOwner: ":1.77" }, 6);
  const cur = s.discovered([N], 7)[0];                       // … lookup #2 refills busName
  assert.notEqual(cur.id, old.id);
  assert.deepEqual(s.ownerResolved(old.id, ":1.99", 8), [], "the departed owner must not come back");
  assert.equal(s.snapshot().sender, "");
  assert.equal(s.ownerResolved(cur.id, ":1.77", 9)[1].sender, ":1.77");
});

test("the source epoch advances on every change of source, so replies to older reads are recognisable", () => {
  const s = connected(":1.99");
  const tok = s.snapshot().epoch;
  assert.equal(s.isCurrent(tok), true);
  s.nameOwnerChanged({ name: N, oldOwner: ":1.99", newOwner: ":1.77" }, 100);
  assert.equal(s.isCurrent(tok), false, "revocation retires reads launched for the old owner");
  resolve(s, ":1.77", 120);
  assert.equal(s.isCurrent(tok), false, "a new owner does not revive them");
  assert.equal(s.isCurrent(s.snapshot().epoch), true);
});

test("an unexpected monitor exit is a loss: revoke and back off", () => {
  const s = connected();
  const fx = s.monitorExited(100);
  assert.deepEqual(types(fx), ["source", "retry"]);
  assert.equal(s.snapshot().sender, "");
});

test("a start requested while a discovery is in flight runs one more discovery and drops the stale result", () => {
  const s = mk();
  s.start(0);
  assert.deepEqual(s.start(5), []);
  assert.deepEqual(types(s.discovered([], 10)), ["discover"]);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/Dbus.test.mjs tests/AtvSource.test.mjs`
Expected: FAIL. `parseNameOwnerChanged` is not exported, and `lib/AtvSource.mjs` does not exist.

- [ ] **Step 4: Implement the parser** (append to `lib/Dbus.mjs`)

```js
// Plan 4 §4.4: NameOwnerChanged for an org.atvvoice.* name, from the bus itself. An empty newOwner is
// a departure, an empty oldOwner an arrival, both non-empty a replacement.
export function parseNameOwnerChanged(line) {
  let m;
  try { m = JSON.parse(line); } catch (e) { return null; }
  if (!m || m.type !== "signal" || m.sender !== "org.freedesktop.DBus" || m.member !== "NameOwnerChanged") return null;
  const d = m.payload && Array.isArray(m.payload.data) ? m.payload.data : null;
  if (!d || d.length !== 3 || !d.every(x => typeof x === "string")) return null;
  if (!d[0].startsWith("org.atvvoice.")) return null;
  return { name: d[0], oldOwner: d[1], newOwner: d[2] };
}
```

- [ ] **Step 5: Implement the state machine** (`lib/AtvSource.mjs`)

```js
// Plan 4 spec §4.4: which org.atvvoice.* owner is the voice source, as a pure state machine.
// AtvvoiceMonitor.qml runs the processes and reports back; this decides. Effects, in order:
//   { type: "discover" }                 run `busctl --user list`
//   { type: "resolveOwner", id, name }   GetNameOwner(name); report back with the same id
//   { type: "source", sender, busName, epoch }  bump the parser generation, then announce (sender "" = revoked)
//   { type: "startMonitor" }             start the MicStateChanged monitor and the one-shot NodeName/State reads
//   { type: "stopMonitor" }              stop the MicStateChanged monitor; its exit is reported back
//   { type: "retry", ms }                (re)arm the rediscovery timer
//   { type: "cancelRetry" }
// Losing the current owner revokes at once -- never via the old monitor's exit callback, which may land
// after a new owner has already connected. A monitor being retired is tracked so that its exit neither
// clears a newer connection nor counts as a second loss. Owner lookups carry ids so only the latest one
// counts; `epoch` advances on every change of source so the driver can drop replies to older reads.
export function createAtvSource({ backoffMs }) {
  let sender = "", busName = "", attempts = 0, retryMs = 0, retryAt = 0;
  let discovering = false, rediscover = false;
  let monitorRunning = false, retiring = false, pendingMonitor = false;
  let resolveSeq = 0, resolveId = 0, epoch = 0;

  function revoke() {
    if (!sender && !busName) return [];
    sender = ""; busName = "";
    pendingMonitor = false;
    resolveId = 0;                                                  // an outstanding lookup is now stale
    epoch++;
    const out = [{ type: "source", sender: "", busName: "", epoch }];
    if (monitorRunning && !retiring) { retiring = true; out.push({ type: "stopMonitor" }); }
    return out;
  }
  function scheduleRetry(now) {
    retryMs = backoffMs(attempts++);
    retryAt = now + retryMs;
    return [{ type: "retry", ms: retryMs }];
  }
  function clearRetry() { retryMs = 0; retryAt = 0; return [{ type: "cancelRetry" }]; }
  function lost(now) { return [...revoke(), ...scheduleRetry(now)]; }
  function start() {
    if (discovering) { rediscover = true; return []; }
    discovering = true;
    return [{ type: "discover" }];
  }

  return {
    start(now) { return start(); },
    discovered(names, now) {
      discovering = false;
      if (rediscover) { rediscover = false; return start(); }      // a newer request supersedes this result
      if (!Array.isArray(names) || names.length === 0) return lost(now);
      if (sender) return [];                                        // already connected: a redundant discovery
      busName = names[0];
      resolveId = ++resolveSeq;
      return [{ type: "resolveOwner", id: resolveId, name: busName }];
    },
    ownerResolved(id, owner, now) {
      if (id !== resolveId || !busName || sender) return [];        // stale lookup, revoked meanwhile, or already connected
      resolveId = 0;
      if (!owner) return lost(now);
      sender = owner; attempts = 0;
      epoch++;
      const out = [...clearRetry(), { type: "source", sender, busName, epoch }];
      if (monitorRunning) pendingMonitor = true;                    // the retired monitor has not exited yet
      else { monitorRunning = true; out.push({ type: "startMonitor" }); }
      return out;
    },
    monitorExited(now) {
      monitorRunning = false;
      if (retiring) {
        retiring = false;
        if (pendingMonitor) { pendingMonitor = false; monitorRunning = true; return [{ type: "startMonitor" }]; }
        return [];
      }
      return lost(now);
    },
    nameOwnerChanged(ev, now) {
      if (!ev) return [];
      if (ev.newOwner) {
        // Connected: only our own name's owner change matters; another org.atvvoice.* name is ignored.
        if (sender && (ev.name !== busName || ev.newOwner === sender)) return [];
        const out = [...revoke(), ...clearRetry()];
        attempts = 0;
        return [...out, ...start()];
      }
      if (ev.name === busName) return lost(now);
      return [];
    },
    retryFired(now) { retryAt = 0; return start(); },
    isCurrent(e) { return e === epoch; },
    snapshot() { return { sender, busName, epoch, retryMs, retryAt, attempts, monitorRunning, retiring, pendingMonitor }; },
  };
}
```

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `node --test tests/Dbus.test.mjs tests/AtvSource.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 7: Mutation checks on the race handling**

Make each change on its own, run `node --test tests/AtvSource.test.mjs`, confirm the named test
FAILS, and revert:
- In `revoke()`, delete `retiring = true;`, leaving only the push. Expected failures: "departure
  then arrival before the old monitor exits" and "a departure revokes at once…", because the old
  exit becomes a loss.
- In `nameOwnerChanged`, change `const out = [...revoke(), ...clearRetry()];` to
  `const out = [...clearRetry()];`. Expected failure: "a direct owner replacement…".
- In `ownerResolved`, delete `id !== resolveId ||`. Expected failure: "an owner result from a lookup
  older than the latest discovery is stale…".
- In `nameOwnerChanged`, delete `ev.name !== busName ||`. Expected failure: "while connected, another
  org.atvvoice name appearing leaves the current source alone".

- [ ] **Step 8: Teach the fake busctl NameOwnerChanged and a changeable owner**

Replace `tests/fakes/bin/busctl` header lines 2-4 with:

```bash
# Spec §9: fake busctl for ATVVoice. State files in $OMAREMOTE_FAKE_DIR:
#   atv.present  exists → org.atvvoice.fake is owned            atv.state   connected|streaming|disconnected
#   atv.owner    the owner's unique name (default :1.99)        atv.log     every invocation
#   atv.signals  append a state per line to emit MicStateChanged from `monitor`
#   atv.owners   append "<name> <old> <new>" per line (- for empty) to emit NameOwnerChanged from a
#                `monitor` whose match names NameOwnerChanged
```

After `present() { … }`, add:

```bash
owner() { cat "$d/atv.owner" 2>/dev/null || echo ":1.99"; }
```

In `list)`, change `:1.99` in the atvvoice line to `$(owner)`. In the GetNameOwner branch, change
`echo 's ":1.99"'` to `printf 's "%s"\n' "$(owner)"`. In the MicStateChanged `printf`, change
`"sender":":1.99"` to `"sender":"'"$(owner)"'"`.

In `monitor)`, before `: >> "$d/atv.signals"`, insert:

```bash
    if [[ " $* " == *NameOwnerChanged* ]]; then
      : >> "$d/atv.owners"
      tail -n 0 -F "$d/atv.owners" 2>/dev/null | while read -r n o w; do
        [[ $o == - ]] && o=""; [[ $w == - ]] && w=""
        printf '{"type":"signal","sender":"org.freedesktop.DBus","path":"/org/freedesktop/DBus","interface":"org.freedesktop.DBus","member":"NameOwnerChanged","payload":{"type":"sss","data":["%s","%s","%s"]}}\n' "$n" "$o" "$w"
      done &
      tp=$!
      cleanup() { pkill -P $$ 2>/dev/null; exit 0; }
      trap cleanup TERM INT
      while kill -0 "$tp" 2>/dev/null && [[ -d $d ]] && kill -0 "$PPID" 2>/dev/null; do sleep 0.2; done
      cleanup
    fi
```

Replace the whole `get-property)` branch with a version that captures its answer first and can be slow:

```bash
  get-property)
    present || { echo "Failed to get property: no such name" >&2; exit 1; }
    case "${*: -1}" in
      State) ans=$(printf 's "%s"' "$(cat "$d/atv.state" 2>/dev/null || echo connected)") ;;
      NodeName) ans='s "atvvoice_mic"' ;;
      DeviceAddress) ans='s "AA:BB:CC:DD:EE:FF"' ;;
      *) ans="" ;;
    esac
    [[ -s $d/atv.prop-delay ]] && sleep "$(cat "$d/atv.prop-delay")"   # answer as of the call, delivered late
    [[ -n $ans ]] && printf '%s\n' "$ans" ;;
```

A scenario changes `atv.present`/`atv.owner` *before* appending to `atv.owners`, matching the real
order: the bus updates ownership, then announces it.

- [ ] **Step 9: Write the failing integration scenarios** (define them after `s_remote_mode_ignores_hid_mic`; register them after its `scenario` line)

```bash
s_atvvoice_departure_noticed() {          # plan 4 §4.4: a stopped daemon is reported absent; busctl monitor alone never exits
  ready || return 1
  wait_for '.remote.state' connected 3 || return 1
  rm -f "$F/atv.present"
  echo "org.atvvoice.fake :1.99 -" >> "$F/atv.owners"
  wait_for '.remote.state' absent 3 || return 1
  [[ $(jget '.remote.sender') == "" ]]
}
s_atvvoice_owner_replaced() {             # plan 4 §4.4: one signal, old owner → new owner; the race orderings are unit-tested
  ready || return 1
  wait_for '.remote.sender' ":1.99" 3 || return 1
  echo ":1.77" > "$F/atv.owner"
  echo "org.atvvoice.fake :1.99 :1.77" >> "$F/atv.owners"
  wait_for '.remote.sender' ":1.77" 3
}
s_atvvoice_appears_late() {               # plan 4 §4.4: an arrival is noticed at once, not at the next backoff retry
  ready || return 1                       # the harness starts with the fake daemon present: make it leave first
  wait_for '.remote.state' connected 3 || return 1
  rm -f "$F/atv.present"
  echo "org.atvvoice.fake :1.99 -" >> "$F/atv.owners"
  wait_for '.remote.state' absent 3 || return 1
  wait_for '.remote.retryMs' 4000 12 || return 1          # backoff 1 s, 2 s, then 4 s: the third failed discovery
  local now at
  for _ in 1 2 3 4; do                                    # the retry deadline, not the interval, must be > 2 s away
    now=$(date +%s%3N); at=$(jget '.remote.retryAt')
    (( at - now > 2000 )) && break
    sleep 1
  done
  now=$(date +%s%3N); at=$(jget '.remote.retryAt')
  (( at - now > 2000 )) || { echo "    retryAt only $((at - now)) ms away"; return 1; }
  : > "$F/atv.present"
  echo "org.atvvoice.fake - :1.99" >> "$F/atv.owners"
  wait_for '.remote.state' connected 2 || return 1
  (( $(date +%s%3N) < at )) || { echo "    connected only after the backoff deadline"; return 1; }
  [[ $(jget '.remote.retryAt') == 0 ]]
}
s_atvvoice_stale_property_reply() {       # plan 4 §4.4: a departed owner's late `streaming` must not start a session
  ready || return 1
  wait_for '.remote.sender' ":1.99" 3 || return 1
  echo 1.5 > "$F/atv.prop-delay"
  echo streaming > "$F/atv.state"                         # what :1.99 will answer to the State read below
  local n; n=$(grep -c ' State$' "$F/atv.log")
  rm -f "$F/atv.present"; echo "org.atvvoice.fake :1.99 -" >> "$F/atv.owners"
  : > "$F/atv.present"; echo "org.atvvoice.fake - :1.99" >> "$F/atv.owners"    # :1.99 returns: a slow initial State read starts
  local i
  for i in $(seq 1 40); do (( $(grep -c ' State$' "$F/atv.log") > n )) && break; sleep 0.05; done
  (( $(grep -c ' State$' "$F/atv.log") > n )) || { echo "    no State read was issued"; return 1; }
  echo connected > "$F/atv.state"; echo ":1.77" > "$F/atv.owner"
  echo "org.atvvoice.fake :1.99 :1.77" >> "$F/atv.owners"  # replaced while :1.99's `streaming` reply is still in flight
  for i in $(seq 1 60); do                                 # 3 s: the stale reply lands ~1.5 s in
    [[ $(jget '.voice.state') == idle ]] || { echo "    a session started from a stale reply: $(jget '.voice.state')"; return 1; }
    sleep 0.05
  done
  no_line "$F/vox.log" "voxtype record start" || return 1
  wait_for '.remote.sender' ":1.77" 3 || return 1
  wait_for '.remote.state' connected 4                     # :1.77's own read runs after the stale one exits
}
scenario atvvoice_departure_noticed s_atvvoice_departure_noticed
scenario atvvoice_owner_replaced s_atvvoice_owner_replaced
scenario atvvoice_appears_late s_atvvoice_appears_late
scenario atvvoice_stale_property_reply s_atvvoice_stale_property_reply
```

`date +%s%3N` gives epoch milliseconds (GNU date), the same clock as QML `Date.now()`.

- [ ] **Step 10: Run them to verify they fail**

Run: `for s in atvvoice_departure_noticed atvvoice_owner_replaced atvvoice_appears_late atvvoice_stale_property_reply; do bash tests/fake-remote.sh $s; done`
Expected, all four FAIL:
- `atvvoice_departure_noticed`: the state stays `connected`.
- `atvvoice_owner_replaced`: the sender stays `:1.99`.
- `atvvoice_appears_late`: `.remote.retryMs` is null.
- `atvvoice_stale_property_reply`: the departure goes unnoticed, so the setup's arrival never issues a State read.

- [ ] **Step 11: Rewrite AtvvoiceMonitor.qml as a driver**

Replace the whole of `components/AtvvoiceMonitor.qml` with:

```qml
// Spec §3 ATVVoice (bus name discovered by prefix; State/NodeName; MicClose/MicToggle), §5.1 (only the selected sender,
// exact path and interface; a generation per monitor (re)connect; State and NodeName read on start and reconnect), §5.4 (backoff).
// Plan 4 §4.4: which owner is the source is decided by lib/AtvSource.mjs; this file only runs the processes it asks for.
import QtQuick
import Quickshell
import Quickshell.Io
import "../lib/Dbus.mjs" as Dbus
import "../lib/Systemd.mjs" as Systemd
import "../lib/AtvSource.mjs" as AtvSource

Item {
  id: root
  readonly property string path: "/org/atvvoice/Daemon"
  readonly property string iface: "org.atvvoice.Daemon"
  property string busName: ""
  property string sender: ""                     // unique name (":1.42"); "" while absent
  property int generation: 0
  property int retryMs: 0                        // plan 4 §4.4: current backoff interval (diagnostic), 0 when connected
  property double retryAt: 0                     // epoch ms of the next scheduled rediscovery, 0 when none
  property string _resolving: ""                 // name whose owner the `owner` process is resolving
  property int _resolveId: 0                     // AtvSource lookup id of the running `owner` process
  property var _resolveNext: null                // { id, name } queued while `owner` is still running
  property var _reads: []                        // requestIds waiting for a State read not yet launched
  property var _inflight: []                     // requestIds the running stateProc will answer
  // Plan 4 §4.4: every property read records the source epoch at launch; replies from an older epoch are
  // dropped. A read requested while the same process runs is re-run after it exits instead of being lost.
  property int _nodeEpoch: -1
  property bool _nodeAgain: false
  property int _initEpoch: -1
  property bool _initAgain: false
  property int _stateEpoch: -1
  property int _stateGen: 0
  property var core: AtvSource.createAtvSource({ backoffMs: Systemd.backoffMs })
  property var parser: Dbus.createSignalParser({
    path: root.path, iface: root.iface, member: "MicStateChanged",
    acceptSender: function(s) { return root.sender !== "" && s === root.sender }
  })
  signal source(string sender, int generation, string busName)
  signal signalEvent(var ev)
  signal stateRead(string requestId, string state, int generation)   // state "" on failure
  signal nodeName(string name)

  function start() { root._apply(root.core.start(Date.now())) }
  function readState(requestId) {
    if (!root.busName) { root.stateRead(requestId, "", root.generation); return }
    root._reads.push(requestId)
    root._launchState()
  }
  function _launchState() {
    if (stateProc.running || root._reads.length === 0) return
    root._inflight = root._reads; root._reads = []
    root._stateEpoch = root.core.snapshot().epoch
    root._stateGen = root.generation
    stateProc.running = true
  }
  function _readNode() {
    if (nodeProc.running) { root._nodeAgain = true; return }
    root._nodeEpoch = root.core.snapshot().epoch
    nodeProc.running = true
  }
  function _readInit() {
    if (initState.running) { root._initAgain = true; return }
    root._initEpoch = root.core.snapshot().epoch
    initState.running = true
  }
  function _resolve(r) {
    if (owner.running) { root._resolveNext = r; return }
    root._resolveId = r.id
    root._resolving = r.name
    owner.running = true
  }
  function micClose() { if (root.busName) Quickshell.execDetached(["busctl", "--user", "call", root.busName, root.path, root.iface, "MicClose"]) }
  function micToggle() { if (root.busName) Quickshell.execDetached(["busctl", "--user", "call", root.busName, root.path, root.iface, "MicToggle"]) }

  function _apply(effects) {
    for (var i = 0; i < effects.length; i++) {
      var e = effects[i]
      switch (e.type) {
        case "discover": discover.running = true; break
        case "resolveOwner": root._resolve({ id: e.id, name: e.name }); break
        case "source":                           // host obligation: setDbusSource before any signal of the new generation
          root.sender = e.sender
          root.busName = e.busName
          root.generation = root.parser.bumpGeneration()
          root.source(root.sender, root.generation, root.busName)
          break
        case "startMonitor": monitor.running = true; root._readNode(); root._readInit(); break
        case "stopMonitor": monitor.running = false; break
        case "retry": backoff.interval = e.ms; backoff.restart(); break
        case "cancelRetry": backoff.stop(); break
      }
    }
    var s = root.core.snapshot()
    root.retryMs = s.retryMs
    root.retryAt = s.retryAt
  }
  Timer { id: backoff; repeat: false; onTriggered: root._apply(root.core.retryFired(Date.now())) }

  Process {                                      // 1. names with the org.atvvoice. prefix
    id: discover
    command: ["busctl", "--user", "list", "--no-legend"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root._apply(root.core.discovered(Dbus.atvvoiceNames(text), Date.now())) }
  }
  Process {                                      // 2. unique name of the owner → the only accepted sender
    id: owner
    command: ["busctl", "--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", "s", root._resolving]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root._apply(root.core.ownerResolved(root._resolveId, Dbus.parseProperty(text), Date.now())) }
    onExited: function(code, st) { if (root._resolveNext) { var r = root._resolveNext; root._resolveNext = null; root._resolve(r) } }
  }
  Process {                                      // 3. signal monitor
    id: monitor
    command: ["busctl", "--user", "--json=short", "monitor", "--match", "type='signal',interface='org.atvvoice.Daemon',member='MicStateChanged'"]
    stdout: SplitParser { splitMarker: "\n"; onRead: function(line) {
      var evs = root.parser.feed(line + "\n")
      for (var i = 0; i < evs.length; i++) root.signalEvent(evs[i])
    } }
    onExited: function(code, st) { root._apply(root.core.monitorExited(Date.now())) }
  }
  Process {                                      // plan 4 §4.4: arrivals, departures and replacements of org.atvvoice.* names
    id: owners
    running: true
    command: ["busctl", "--user", "--json=short", "monitor", "--match",
              "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.atvvoice'"]
    stdout: SplitParser { splitMarker: "\n"; onRead: function(line) {
      var ev = Dbus.parseNameOwnerChanged(line)
      if (ev) root._apply(root.core.nameOwnerChanged(ev, Date.now()))
    } }
    onExited: function(code, st) { ownersRestart.restart() }
  }
  Timer { id: ownersRestart; interval: 2000; repeat: false; onTriggered: owners.running = true }
  Process {                                      // 4. NodeName on (re)connect
    id: nodeProc
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "NodeName"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      if (!root.core.isCurrent(root._nodeEpoch)) return            // a previous owner's answer
      var n = Dbus.parseProperty(text); if (n) root.nodeName(n)
    } }
    onExited: function(code, st) { if (root._nodeAgain) { root._nodeAgain = false; root._readNode() } }
  }
  Process {                                      // 5. State on (re)connect, delivered like a signal
    id: initState
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "State"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      if (!root.core.isCurrent(root._initEpoch)) return            // a previous owner's answer: never a signal of the new one
      var s = Dbus.parseProperty(text)
      if (s) root.signalEvent({ state: s, sender: root.sender, path: root.path, interface: root.iface, member: "MicStateChanged", generation: root.generation })
    } }
    onExited: function(code, st) { if (root._initAgain) { root._initAgain = false; root._readInit() } }
  }
  Process {                                      // 6. explicit re-reads (readAtv effects); answers every queued request
    id: stateProc
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "State"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      // A stale answer is reported as a failed read under the generation it was launched for, which
      // VoiceSession rejects; it must not update remoteState or decide anything for the new owner.
      var stale = !root.core.isCurrent(root._stateEpoch)
      var s = stale ? "" : (Dbus.parseProperty(text) || "")
      var ids = root._inflight; root._inflight = []
      for (var i = 0; i < ids.length; i++) root.stateRead(ids[i], s, stale ? root._stateGen : root.generation)
    } }
    onExited: function(code, st) { root._launchState() }
  }
}
```

The `owner`, `nodeProc` and `initState` command bindings read `root._resolving`/`root.busName` at
the moment `running` becomes true, so a queued re-run uses the then-current name.

Two behaviours of the old file are deliberately gone:
- `attempts` is no longer reset on every received signal. `AtvSource` resets it when an owner
  resolves, which is the success that matters.
- `_lost()` is gone. Every loss goes through `AtvSource`.

Before replacing the file, `grep -n "attempts\|_lost" Service.qml components/*.qml` must show no
caller outside `AtvvoiceMonitor.qml`. If one exists, stop and report it.

- [ ] **Step 12: Publish the retry fields**

In `Service.qml` `statusJson()`, change the `remote` object to:

```js
      , remote: { state: root.remoteState, node: root.remoteNode, bus: root.atvBusName, sender: atv.sender, warning: root.remoteWarning, retryMs: atv.retryMs, retryAt: atv.retryAt }
```

- [ ] **Step 13: Run the scenarios, then the whole suite**

Run: `for s in atvvoice_departure_noticed atvvoice_owner_replaced atvvoice_appears_late atvvoice_stale_property_reply; do bash tests/fake-remote.sh $s; done; make check; echo MAKE_CHECK_EXIT=$?`
Expected: `ok` for all four, then `MAKE_CHECK_EXIT=0` with `52 passed, 0 failed`.

- [ ] **Step 14: Discrimination check on the late-arrival scenario**

In `AtvvoiceMonitor.qml`, temporarily change `if (ev) root._apply(…)` to `if (ev && ev.newOwner === "") root._apply(…)`, so arrivals are ignored. Then run
`bash tests/fake-remote.sh atvvoice_appears_late`. It must FAIL with "connected only after the
backoff deadline" or a `wait_for` timeout. Revert and confirm `ok`.

Then, in `initState`'s `onStreamFinished`, temporarily delete the `isCurrent` line and run
`bash tests/fake-remote.sh atvvoice_stale_property_reply`. It must FAIL with "a session started from
a stale reply". Revert and confirm `ok`.

- [ ] **Step 15: Commit**

```bash
git add lib/AtvSource.mjs tests/AtvSource.test.mjs lib/Dbus.mjs tests/Dbus.test.mjs components/AtvvoiceMonitor.qml Service.qml tests/fakes/bin/busctl tests/fake-remote.sh
git commit -m "feat(remote): track the ATVVoice owner through NameOwnerChanged, race-safe"
```

---

### Task 6: Stop a D-Bus session when its source disappears

**Files:**
- Modify: `lib/VoiceSession.mjs` (new `sourceLost`, exported)
- Modify: `Service.qml` (`AtvvoiceMonitor.onSource`, near line 395)
- Modify: `tests/fake-remote.sh`
- Test: `tests/VoiceSession.test.mjs`

**Interfaces:**
- Consumes:
  - A revoked source announced as `source("", generation, "")` (Task 5).
  - The `directIdle()`/`directRecording()`/`idleSession()`/`hidRecording()` test helpers (Task 2 and existing).
- Produces: `VoiceSession.sourceLost(now) → effects`. It returns `[cmd stop, hud, state stopping]` for a `dbus`-owned recording. It returns `[]` and latches the stop for `dbus`/`starting`. It returns `[hud "", state idle]` from `arbitrating`. It returns `[]` otherwise.

- [ ] **Step 1: Write the failing tests** (append to `tests/VoiceSession.test.mjs`, after the direct-start block)

```js
// ---- source lost mid-session (plan 4 §4.5) ----
test("sourceLost stops a dbus-owned recording at once, with no re-read", () => {
  const vs = directRecording();
  const fx = vs.sourceLost(500);
  assert.deepEqual(kinds(fx), ["stop"]);
  assert.equal(byType(fx, "readAtv").length, 0);
  assert.equal(stateOf(fx), "stopping");
});

test("sourceLost while a dbus session is starting latches the stop until recording is confirmed", () => {
  const vs = directIdle();
  const fx = vs.dbus(D("streaming"), 0);
  assert.deepEqual(kinds(vs.sourceLost(30)), []);
  vs.cmdExit(cmdId(fx, "start"), 0, 40);
  assert.deepEqual(kinds(vs.status("recording", 100)), ["stop"]);
});

test("sourceLost abandons arbitration without any command", () => {
  const vs = idleSession();                                  // on-demand: arbitration exists
  vs.dbus(D("streaming"), 0);
  const fx = vs.sourceLost(100);
  assert.deepEqual(kinds(fx), []);
  assert.equal(stateOf(fx), "idle");
});

test("sourceLost leaves keyboard and hid sessions alone", () => {
  const kb = directIdle();
  kb.status("recording", 0);
  assert.deepEqual(kinds(kb.sourceLost(50)), []);
  assert.equal(kb.snapshot().state, "recording");
  const hid = hidRecording();
  assert.deepEqual(kinds(hid.sourceLost(200)), []);
  assert.equal(hid.snapshot().state, "recording");
});

test("after sourceLost the next daemon's first streaming is a transition and starts a session", () => {
  const vs = directIdle();
  assert.equal(vs.gate.acquire("mic-apply"), true);
  vs.dbus(D("streaming"), 0);                                // remembered as streaming, no start (gate held)
  vs.sourceLost(10);
  vs.gate.release("mic-apply");
  vs.setDbusSource({ sender: ":1.77", generation: 1 });
  const fx = vs.dbus(D("streaming", { sender: ":1.77", generation: 1 }), 20);
  assert.deepEqual(kinds(fx), ["start"]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/VoiceSession.test.mjs`
Expected: FAIL with `vs.sourceLost is not a function`.

- [ ] **Step 3: Implement**

In `lib/VoiceSession.mjs`, after `hidRelease`, add:

```js
  // Plan 4 §4.5: the ATVVoice source was revoked or lost. No `connected` can arrive any more, so a
  // dbus-owned recording would otherwise run to maxSessionSec. keyboard/hid audio does not depend on it.
  function sourceLost(now) {
    const out = [];
    remote = "absent";                                       // the next daemon's first streaming is a transition
    if (st === "arbitrating") { abandonArb(out, null); return out; }
    if (owner !== "dbus") return out;
    if (st === "starting") stopOnConfirm = true;
    else if (st === "recording") requestStop(out, now);
    return out;
  }
```

Add `sourceLost` to the returned object's first line, after `hidToggle`:

```js
    hidPress, hidRelease, hidToggle, sourceLost, dbus, atvRead, status, cmdExit, restartResult, abort, advance, nextDeadline,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/VoiceSession.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing integration scenario** (define after `s_atvvoice_appears_late`; register after its `scenario` line)

```bash
s_atvvoice_departure_stops_session() {    # plan 4 §4.5: ATVVoice exiting mid-hold must not leave Voxtype recording
  ready || return 1
  echo streaming >> "$F/atv.signals"
  wait_for '.voice.state' recording 3 || return 1
  [[ $(jget '.voice.owner') == dbus ]] || return 1
  rm -f "$F/atv.present"
  echo "org.atvvoice.fake :1.99 -" >> "$F/atv.owners"
  wait_for '.voice.state' idle 5 || return 1
  has_line "$F/vox.log" "voxtype record stop"
}
scenario atvvoice_departure_stops_session s_atvvoice_departure_stops_session
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bash tests/fake-remote.sh atvvoice_departure_stops_session`
Expected: FAIL. The state stays `recording`, because `Service` never calls `sourceLost`.

- [ ] **Step 7: Wire it in Service.qml**

Replace the `onSource` handler of `AtvvoiceMonitor` with:

```js
    onSource: function(sender, generation, busName) {
      root.atvBusName = busName
      if (!busName) root.remoteState = "absent"
      if (root.voice) {
        root.voice.setDbusSource({ sender: sender || null, generation: generation })
        // Plan 4 §4.5: a revoked/lost source can never send the `connected` that ends a dbus session.
        if (!sender) root.dispatch(root.guarded("voice.sourceLost", function() { return root.voice.sourceLost(Date.now()) }), "voice")
      }
      root.updateRemoteWarning()
      root.rearm()
    }
```

- [ ] **Step 8: Run the scenario and the whole suite**

Run: `bash tests/fake-remote.sh atvvoice_departure_stops_session; make check; echo MAKE_CHECK_EXIT=$?`
Expected: `ok   atvvoice_departure_stops_session`, then `MAKE_CHECK_EXIT=0` with `53 passed, 0 failed`.

- [ ] **Step 9: Commit**

```bash
git add lib/VoiceSession.mjs tests/VoiceSession.test.mjs Service.qml tests/fake-remote.sh
git commit -m "feat(voice): stop a dbus session when the ATVVoice source disappears"
```

---

### Task 7: Setup `atvvoice` step and `--mic`

**Files:**
- Modify: `host/omaremote-setup` (constants, 4 functions, `cmd_atvvoice`, `cmd_all`, `usage`, `main`)
- Create: `tests/setup-atvvoice.sh`
- Modify: `Makefile` (`check` target)

**Interfaces:**
- Produces:
  - subcommand `omaremote-setup atvvoice`
  - option `--mic remote|system` (default `remote`), stored in `MIC_MODE`
  - functions `atv_candidates`, `atv_installed_rev`, `gen_atv_unit <addr>`, `cmd_atvvoice`
  - env override `OMAREMOTE_ATV_UNIT` (unit path, for tests)

- [ ] **Step 1: Write the failing setup test** (`tests/setup-atvvoice.sh`)

```bash
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

printf '\n%s\n' "$([[ $fail == 0 ]] && echo 'RESULT: PASS' || echo 'RESULT: FAIL')"
exit $fail
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/setup-atvvoice.sh`
Expected: `RESULT: FAIL`. `cmd_atvvoice` is not defined (exit 127), and the flow checks show
`cmd_mic system` without `cmd_atvvoice`.

- [ ] **Step 3: Implement**

In `host/omaremote-setup`, after `SHELL_CMD=…`, add:

```bash
MIC_MODE=remote   # plan 4 §3: --mic remote|system; system skips the atvvoice step (external microphone hosts)
# ATVVoice, pinned to the commit measured against the Xiaomi RC003 on 2026-10-12.
ATV_REPO=https://github.com/b0o/ATVVoice
ATV_REV=0e8f6413dc4bad7a04e3c6b648945439d7a22fac
ATV_UUID=ab5e0001-5a21-4f05-bc7d-af01f617b664
ATV_UNIT=${OMAREMOTE_ATV_UNIT:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/atvvoice.service}
```

Before `cmd_all()`, add:

```bash
atv_candidates() {   # paired devices exposing the ATV voice service, one address per line
  local a
  for a in $(bluetoothctl devices 2>/dev/null | awk '$1 == "Device" { print $2 }'); do
    bluetoothctl info "$a" 2>/dev/null | grep -qi -- "$ATV_UUID" && printf '%s\n' "$a"
  done
  return 0
}

atv_installed_rev() {   # the rev cargo recorded for an installed atvvoice, or nothing
  cargo install --list 2>/dev/null | sed -n 's/^atvvoice v[^ ]* (.*[?&]rev=\([0-9a-f]*\).*/\1/p' | head -n1
}

gen_atv_unit() {   # gen_atv_unit <addr> > file
  cat <<EOF
# Generated by omaremote-setup. Do not edit by hand; re-run \`omaremote-setup atvvoice\`.
# No --mic-on-demand: the Xiaomi RC003 sends no audio for a host MIC_OPEN, only while its button is
# held (plan 4 spec §2). --name avoids an invalid D-Bus name derived from the remote's Chinese name.
[Unit]
Description=ATVVoice: Bluetooth voice remote as a PipeWire microphone
After=pipewire.service bluetooth.target

[Service]
ExecStart=%h/.cargo/bin/atvvoice --device $1 --name xiaomi
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
}

cmd_atvvoice() {
  step "ATVVoice (remote microphone)"
  command -v cargo >/dev/null 2>&1 \
    || die "cargo is missing. Run:  sudo pacman -S rustup && rustup default stable  -- then re-run this step."
  need bluetoothctl

  # Resolve the device before building or touching anything, so a missing remote changes nothing.
  local cands; mapfile -t cands < <(atv_candidates)
  (( ${#cands[@]} > 0 )) || die "no paired ATVV remote found (is Bluetooth on and the remote paired?)"
  (( ${#cands[@]} == 1 )) || die "several ATVV remotes are paired: ${cands[*]} -- unpair all but one"

  local built=0
  if [[ $(atv_installed_rev) != "$ATV_REV" ]]; then
    say "building ATVVoice $ATV_REV (a few minutes)"
    cargo install --git "$ATV_REPO" --rev "$ATV_REV" --locked atvvoice || die "cargo install failed; nothing was changed"
    built=1
  fi

  gen_atv_unit "${cands[0]}" > "$WORKDIR/atvvoice.service"
  local changed=0
  if ! cmp -s "$WORKDIR/atvvoice.service" "$ATV_UNIT"; then
    mkdir -p "$(dirname "$ATV_UNIT")"
    cp "$WORKDIR/atvvoice.service" "$ATV_UNIT"
    systemctl --user daemon-reload
    changed=1
    say "wrote $ATV_UNIT (device ${cands[0]})"
  fi

  # Three separate rules (spec §3): rewrite only on change; always ensure enabled+active, which repairs a
  # stopped or disabled service; restart a running service only when its unit or binary changed.
  local was_active=0
  systemctl --user is-active --quiet atvvoice && was_active=1
  systemctl --user enable --now atvvoice
  if (( was_active && (changed || built) )); then systemctl --user restart atvvoice; fi
  say "ATVVoice: node atvvoice-xiaomi, D-Bus org.atvvoice.xiaomi"
}
```

Replace `cmd_all()` with:

```bash
cmd_all() {
  # keyd and the mic apply both stop for confirmation or restart a daemon, so a bare run is
  # interactive by design. Pass --yes to skip the keyd prompts. Plan 4: the remote's microphone is
  # the default; --mic system keeps the external-microphone flow and skips ATVVoice entirely.
  cmd_deps
  cmd_keyd
  cmd_binds
  cmd_plugin
  [[ $MIC_MODE == remote ]] && cmd_atvvoice
  cmd_mic "$MIC_MODE"
  cmd_verify
}
```

In `usage()`, change the first line to `usage: omaremote-setup [--yes] [--mic remote|system] <subcommand>`.
Add the subcommand line after `plugin`:

```
  atvvoice build ATVVoice (pinned), write its user unit for the paired remote, enable it
```

Replace the sentence under the list with:

```
With no subcommand, every step runs in order (interactive: keyd confirms, mic restarts voxtype).
--mic remote (default) includes atvvoice and applies the remote mic; --mic system skips atvvoice
and applies the system/external mic.
```

In `main()`, add an option case and validation, and the subcommand:

```bash
      --mic) MIC_MODE=${2:-}; shift; [[ $# -gt 0 ]] && shift ;;   # never `shift 2 || true`: a bare --mic would loop forever
```

after the `while … done` loop:

```bash
  [[ $MIC_MODE == remote || $MIC_MODE == system ]] || die "usage: --mic remote|system (got: ${MIC_MODE:-nothing})"
```

and in the `case`, after `plugin) cmd_plugin ;;`:

```bash
    atvvoice) cmd_atvvoice ;;
```

- [ ] **Step 4: Run the setup test to verify it passes**

Run: `bash tests/setup-atvvoice.sh`
Expected: every line `ok`, then `RESULT: PASS`.

- [ ] **Step 5: Mutation check on the idempotence rules**

Temporarily delete the line `systemctl --user enable --now atvvoice` and run the test: "rerun:
enable --now still issued" and "stopped: enable --now" must FAIL. Restore it. Then temporarily change
`(( was_active && (changed || built) ))` to `(( was_active && changed ))`: "binary: restart" must
FAIL. Restore it and confirm `RESULT: PASS`.

- [ ] **Step 6: Wire into `make check` and run everything**

In `Makefile`, in the `check:` recipe, after `bash tests/setup-helpers.sh`, add the line:

```make
	bash tests/setup-atvvoice.sh
```

Run: `make check; echo MAKE_CHECK_EXIT=$?`
Expected: `MAKE_CHECK_EXIT=0`.

- [ ] **Step 7: Commit**

```bash
git add host/omaremote-setup tests/setup-atvvoice.sh Makefile
git commit -m "feat(host): atvvoice setup step and --mic; remote mic is the default flow"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-09-14-omaremote-design.md` (§1 Target line, §2 diagram, §3 ATVVoice, §5.1, §5.2 mode table, §7 step 1 ATVVoice sentence)
- Modify: `docs/superpowers/specs/2026-10-02-omaremote-host-setup-design.md`
- Modify: `docs/hw-keymap-xiaomi-voice-remote.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Base spec**

Make each edit and cite `2026-10-12-remote-mic-design.md` §2 where it states a measured fact:

- Header **Target** line: replace `ATVVoice with --mic-on-demand` with `ATVVoice (pinned build, no --mic-on-demand on the Xiaomi RC003; see 2026-10-12-remote-mic-design.md)`.
- §2 diagram line `atvvoice  systemd --user, --mic-on-demand; PipeWire node + D-Bus` → `atvvoice  systemd --user, --device/--name, no on-demand; PipeWire node + D-Bus`.
- §2 verification item 4 (Voxtype opens capture only while recording, "so ATVVoice --mic-on-demand opens the remote mic per session"): append `Superseded for the Xiaomi RC003: a host MIC_OPEN yields no audio, so capture rides the button's hold-to-talk stream (2026-10-12-remote-mic-design.md §2.4).`
- §3 ATVVoice: replace the first sentence's `--mic-on-demand` drop-in with the unit from the remote-mic design §3, and add `voice.remoteOnDemand` (default false) with the doctor consistency row.
- §5.1 first paragraph ("Because ATVVoice runs with `--mic-on-demand` …"): prefix it with `With voice.remoteOnDemand = true:`, then add a paragraph: `With the default false, a D-Bus streaming can only be the button; it starts a session at once with owner dbus (no arbitration), and in remote mode the HID mic key is dropped before voice and engine.`
- §5.1 HID mic key paragraph and its "A toggle is not a preference, it is a hardware requirement" sub-paragraph: state that `keys.mic.trigger` applies only in system mode. Rewrite the pulse claim as: `the HID key is a press-time pulse (one down per press, measured with a self-test lease); the remote's audio, by contrast, streams for the whole physical hold over ATVV`. Remove "Push-to-talk on it is mechanically correct and useless" as a statement about the remote's microphone, and keep it only for HID-driven PTT.
- §5.2 arbitration bullet: prefix `Only with voice.remoteOnDemand = true.`
- Mode table `remote` row, keyboard F9 column: replace `audio from remote via on-demand` with `no audio unless the remote's button is held (no on-demand); use system mode for F9`. Remote-button column: `hold to talk; release ends the session`.
- §7 step 1: replace the ATVVoice build/drop-in sentence with `omaremote-setup atvvoice` as specified in the remote-mic design §3, including the `--mic` option and the new default flow.

- [ ] **Step 2: Host-setup spec**

Add the `atvvoice` step to its step list, the default flow
`deps → keyd → binds → plugin → atvvoice → mic remote → verify`, the `--mic remote|system` option
(system skips atvvoice and is the previous flow), and the three idempotence rules.

- [ ] **Step 3: Hardware doc**

Append a section `## ATVV voice (measured 2026-10-09..12)` to `docs/hw-keymap-xiaomi-voice-remote.md`
listing facts 1–8 from the remote-mic design §2 verbatim in substance. Include the GATT layout
(`ab5e0002` TX, `ab5e0003` AUDIO, `ab5e0004` CTL), CAPS v1.0 / ADPCM 16 kHz / frame 120 / HoldToTalk,
host MIC_OPEN → zero frames, the naming bug and `--name`, and the withdrawn "pulse means no hold"
conclusion with its unexplained early runs. Where the doc's existing text says the mic button
cannot hold, add `(HID layer only; see the ATVV section)`.

- [ ] **Step 4: Check and commit**

Run: `grep -n "mic-on-demand" docs/superpowers/specs/2026-09-14-omaremote-design.md`
Expected: every remaining hit is qualified by `remoteOnDemand = true`, "superseded", or "no".

```bash
git add docs/
git commit -m "docs: remote mic via ATVVoice hold-to-talk; on-demand becomes opt-in"
```

---

### Task 9: Verification and hardware acceptance

**Files:** none changed unless a check fails.

- [ ] **Step 1: Full suite**

Run: `make check; echo MAKE_CHECK_EXIT=$?`
Expected: `MAKE_CHECK_EXIT=0`, integration `53 passed, 0 failed`, and `RESULT: PASS` from both setup
test files. Report the exact counts.

- [ ] **Step 2: Install into the live shell**

Run: `make dev-restart`
Expected: the shell restarts and `omarchy-shell omaremote status | jq -c '{voiceMode, remoteOnDemand, remote}'`
prints `voiceMode: "system"`, the user's current mode, `remoteOnDemand: false`, and a `remote`
object that includes `retryMs` and `retryAt`.

- [ ] **Step 3: Hand the hardware steps to the user** (the agent runs none of these; each `sudo` is the user's)

Give the user, in order:

1. If `cargo` is missing: `! sudo pacman -S rustup && rustup default stable`.
2. `! bash host/omaremote-setup atvvoice`. This builds for a few minutes, then writes and enables the unit.
3. `! omarchy-shell omaremote mic remote`. Then poll `omarchy-shell omaremote micStatus <id>` until `succeeded`.
4. Check the configuration rows in the Setup tab, or with `omarchy-shell omaremote doctor | jq -r '.rows[] | "\(.id) \(.status)"'`: `voxtype-status`, `voxtype-output`, `atvvoice-service`, `atvvoice-ondemand`, `atvvoice-dbus` and `voxtype-device` all `pass`. `last-capture` may still be `unknown`, which is expected before the first session.
5. Focus an empty text field. Hold the remote's mic button and speak for 3 s or more, then release. Text appears with no second press.
6. The Status tab's "Last capture" row shows `atvvoice-xiaomi · remote`.
7. `! omarchy-shell omaremote mic system`, wait for `succeeded`, then press the mic button twice. The toggle starts and stops a session as before.

- [ ] **Step 4: Record the outcome**

Append a `## Plan 4 outcome (<date>)` section to this plan with the measured results of Steps 1–3,
including any acceptance step that did not behave as written, and commit:

```bash
git add docs/superpowers/plans/2026-10-12-omaremote-remote-mic.md
git commit -m "docs(plan): record Plan 4 outcome"
```
