# OmaRemote Host Setup (Plan 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Xiaomi BT voice remote (`2717:32b8`) genuinely usable on this Omarchy host — button → keyd → neutral key → Hyprland bind → `GlobalShortcut` → plugin → action — and settle by measurement the bind-edge question the main spec answers wrongly.

**Architecture:** Three pure-JS/QML changes land first because they are the safety net for everything after them (an absolute per-key stuck bound, its Service plumbing, and a usable self-test lease). Then a uinput injector proves itself, keyd is installed and validated, the bind matrix is measured, and only a qualifying matrix is allowed to generate the real Hyprland config. `host/omaremote-setup` grows subcommand by subcommand and is run at each step, so it is never a post-hoc description of manual work.

**Tech Stack:** Node 24 (`node --test`), Quickshell 0.3.1 / Qt 6.11 (V4 JS engine), bash 5, Python 3 stdlib (uinput via `fcntl.ioctl`), keyd 2.6.0, Hyprland 0.56.2 with Omarchy's Lua config.

**Spec:** `docs/superpowers/specs/2026-10-02-omaremote-host-setup-design.md` (commits `6a85b8f`, `e8da55b`). Main spec: `docs/superpowers/specs/2026-09-14-omaremote-design.md`.

## Global Constraints

- `lib/*.mjs` and `components/*.qml` run on the Qt 6.11 V4 engine: **no object spread** (`Object.assign` instead), no `??`, no `?.`. `tests/*.test.mjs` run on Node and may use spread. `tests/Portability.test.mjs` enforces this on `lib/`.
- `lib/*.mjs` stay pure: explicit `now` argument, return effect lists, never spawn a process or create a timer.
- `Service.qml` is the only process and timer owner. ONE `tick` Timer, armed at the minimum of `deadlines()`. Every engine call that can create a deadline goes through `guarded(label, fn, fallback)`, which calls `rearm()` in `finally`.
- Tests run with `node --test "tests/*.test.mjs"` (`make test`). `make check` = `test` + `lint` + `tests/fake-remote.sh`. `make lint` must stay exit-0.
- Integration tests must never type into the user's desktop and never mutate the user's real `voxtype`/`systemd`/`~/.config/omaremote`. The harness sets `OMAREMOTE_DISPATCH=hyprctl` so dispatches reach a fake `hyprctl`.
- bash scripts: `set -euo pipefail`.
- The agent has **no root**. Every `sudo` command in this plan is handed to the user to run with `! sudo …`; the plan step says so explicitly and waits for the output.
- Every host-file write is staged to a temporary file, validated, compared against the current contents, and replaces it only on a difference, keeping the prior version as `.bak`.
- keyd 2.6.0 from `extra`. Valid key names are whatever `keyd list-keys` prints; all 26 names this device needs were verified on 2026-10-02.
- `timing.stuckMs` default `10000`. The bind sweep lowers it to `2000` — which must stay above `panicMs` (1500).
- Self-test lease: default `120000` ms, hard cap `600000` ms.
- Bind sweep: durations 120 / 600 / 3000 ms; keys `up` (F13, `repeat: true`) and `back` (F18, long non-repeat). `power` (F24) is excluded — its tap action blanks the screen.
- **A least-bad bind matrix is a diagnostic, never a pass.** If no configuration qualifies, Task 7 does not run, no `~/.config/hypr/omaremote.lua` is generated, and `omaremote-setup` reports failure.

## Review Focus

1. **`timing.stuckMs` of `0`, or below the longest key timer.** `num()` (`lib/Config.mjs:7-9`) accepts any finite `v >= 0`, so `0` passes validation and would time every key out on the press itself; any value below `panicMs` (1500) times a panic key out before its reset can fire, silently removing the §4.3 escape hatch — and the sweep procedure itself tells an operator to lower this value. Expected: the value is raised to a safe floor and a config problem says so. → Task 1.
2. **`selftestArmFor` with `""`, `"abc"`, `"0"` or `"99999999999"`.** An IPC string arrives from a shell; it must clamp to the default or the cap, never throw into the shell process or arm a zero-length lease that reports success and expires before the first injection. → Task 3.
3. **A real remote button pressed during the sweep.** Raw `GlobalShortcut` counts include real input (main spec §7 step 6), so a stray press reads as a duplicate-edge failure and would be recorded as the bind configuration's verdict. Expected: the sweep notices the unexpected key, discards that trial, and retries rather than publishing a false matrix cell. → Task 6.
4. **`hyprctl binds -j` already carrying `omaremote:` descriptions, or carrying none because the `require` line is missing.** A leftover generated file gives too many; a present file with no `require("hypr.omaremote")` gives zero. Both must be distinguished from each other and from a genuine mismatch, because "zero" and "double" need opposite fixes. → Task 7.
5. **`stuckKey` while a self-test lease is active, and `reset` racing a stuck timeout.** `root.heldKeys` is only recomputed in `onKeyEdge` (`Service.qml:226`); `stuckKey` arrives via `advanceAll()`, which does not touch it, so the status would keep reporting a key that the engine has already released. → Task 2.

---

## File Structure

| file | responsibility |
|---|---|
| `lib/Defaults.mjs` | modify: `DEFAULT_TIMING.stuckMs` |
| `lib/Config.mjs` | modify: raise `stuckMs` to a safe floor, report it as a problem |
| `lib/KeyEngine.mjs` | modify: per-key `stuckAt` absolute bound, checked before phase logic |
| `lib/SelfTest.mjs` | modify: `arm` returns a `detail` reason; caller-chosen `leaseMs` |
| `Service.qml` | modify: consume `stuckKey`, expose `lastStuckKey`, refresh `heldKeys`; `selftestArmFor` IPC verb |
| `tests/KeyEngine.test.mjs` | the stuck bound, every phase, the config floor |
| `tests/SelfTest.test.mjs` | `arm` detail reasons, lease clamping |
| `tests/fake-remote.sh` | integration scenarios: stuck key end to end, `selftestArmFor` |
| `tests/inject-key.py` | **create**: uinput key injector (development tool) |
| `tests/bind-matrix.sh` | **create**: the sweep — generates candidate Lua, arms a lease, injects, reports the matrix |
| `host/omaremote-setup` | **create**: `deps`, `keyd`, `binds`, `plugin`, `mic`, `verify` subcommands |
| `docs/hw-keymap-xiaomi-voice-remote.md` | modify: replace the open bind-edge bullet with the measured matrix |
| `docs/superpowers/plans/2026-09-14-omaremote-qml-host-task0.md` | modify: close the "Correction (2026-10-02)" open question |
| `docs/superpowers/specs/2026-09-14-omaremote-design.md` | modify: the seven corrections in design spec §9 |

---

### Task 1: Absolute per-key stuck bound in KeyEngine

A lost release currently holds a key forever in one of four phases. On the six `repeat: true` keys that is an unbounded stream of injected keystrokes, observed live on 2026-10-02. Rather than patch four phases, the engine gains one absolute bound per key, measured from the physical press and checked before any phase logic.

**Files:**
- Modify: `lib/Defaults.mjs:22`
- Modify: `lib/Config.mjs:51-53`
- Modify: `lib/KeyEngine.mjs:8-9`, `:19-21`, `:46-61`, `:71-91`, `:93-111`, `:113-117`
- Test: `tests/KeyEngine.test.mjs`

**Interfaces:**
- Consumes: `keyClass(k)` from `lib/Config.mjs`, `KEY_NAMES` / `DEFAULT_TIMING` from `lib/Defaults.mjs`.
- Produces: effect `{ type: "stuckKey", key: <name> }`, emitted from `advance(now)`. `timing.stuckMs` (number, ms). `engine.heldKeys()` returns `[]` for a key that has timed out. Task 2 consumes the effect; Task 6 reads it through `statusJson()`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/KeyEngine.test.mjs`:

```javascript
const stuck = (fx) => byType(fx, "stuckKey").map(e => e.key);

test("repeat key whose release is lost stops repeating and reports stuckKey once", () => {
  const e = engine();
  e.press("up", 0);
  // holdMs 350 then repeatMs 80: fires at 350, 430, 510, 590, 670, 750, 830, 910, 990
  assert.equal(acts(e.advance(1000)).length, 9);
  const fx = e.advance(10000);
  assert.deepEqual(stuck(fx), ["up"]);
  assert.deepEqual(e.heldKeys(), []);
  assert.equal(e.nextDeadline(), null);
  assert.deepEqual(stuck(e.advance(20000)), []);          // reported once, not every tick
  assert.deepEqual(acts(e.advance(20000)), []);           // and no action after the bound
});

test("the stuck timeout emits no action of any kind", () => {
  const e = engine();
  e.press("ok", 0);                                       // long key: hold fires at 350
  assert.deepEqual(acts(e.advance(350)), ["ok:hold"]);
  const fx = e.advance(10000);
  assert.deepEqual(stuck(fx), ["ok"]);
  assert.deepEqual(acts(fx), []);                         // never a tap: a timeout is not a release
});

test("held phase (long key, release lost) times out", () => {
  const e = engine();
  e.press("ok", 0);
  e.advance(350);
  assert.deepEqual(e.heldKeys(), ["ok"]);
  assert.deepEqual(stuck(e.advance(10000)), ["ok"]);
  assert.deepEqual(e.heldKeys(), []);
});

test("consumeRelease phase (double fired, release lost) times out", () => {
  const e = engine({ ok: { tap: { type: "key", keys: "Return" }, double: { type: "key", keys: "ctrl+w" } } });
  e.press("ok", 0);
  e.release("ok", 100);                                   // -> waitDouble
  assert.deepEqual(acts(e.press("ok", 150)), ["ok:double"]);   // -> consumeRelease, still physically down
  assert.deepEqual(e.heldKeys(), ["ok"]);
  assert.deepEqual(stuck(e.advance(10150)), ["ok"]);
  assert.deepEqual(e.heldKeys(), []);
});

test("down phase with no timer at all (double-only key held) times out", () => {
  const e = engine({ app: { double: { type: "key", keys: "ctrl+w" } } });
  e.press("app", 0);
  assert.deepEqual(e.heldKeys(), ["app"]);
  assert.equal(e.nextDeadline(), 10000);                  // the bound is the only timer this phase has
  assert.deepEqual(stuck(e.advance(10000)), ["app"]);
  assert.deepEqual(e.heldKeys(), []);
});

test("the bound is measured from the press, not from the last phase transition", () => {
  const e = engine();
  e.press("ok", 0);
  e.advance(9000);                                        // down -> held somewhere in here
  assert.deepEqual(stuck(e.advance(10000)), ["ok"]);      // 10000, not 9000 + stuckMs
});

test("waitDouble clears the bound so a double-tap window is never cut short", () => {
  const e = engine({ ok: { tap: { type: "key", keys: "Return" }, double: { type: "key", keys: "ctrl+w" } } });
  e.press("ok", 0);
  e.release("ok", 9999);                                  // -> waitDouble, doubleMs window opens
  assert.equal(e.nextDeadline(), 9999 + 250);             // the doubleMs deadline, not a stuck bound
  assert.deepEqual(acts(e.advance(9999 + 250)), ["ok:tap"]);
});

test("a release arriving after the timeout produces nothing", () => {
  const e = engine();
  e.press("up", 0);
  e.advance(10000);
  assert.deepEqual(acts(e.release("up", 12000)), []);
  assert.deepEqual(stuck(e.release("up", 12000)), []);
});

test("a panic key still resets at panicMs, before any stuck bound", () => {
  const e = engine();
  e.press("menu", 0);
  assert.deepEqual(byType(e.advance(1500), "reset").length, 1);
  assert.deepEqual(e.heldKeys(), []);
});
```

Append to `tests/Config.test.mjs`:

```javascript
test("timing.stuckMs is raised above the longest key timer, with a problem recorded", () => {
  const r = normalizeConfig({ timing: { stuckMs: 0 } });
  assert.equal(r.config.timing.stuckMs, 1501);            // panicMs 1500 is the longest default timer
  assert.ok(r.problems.some(p => p.code === "stuck-ms-raised"));
});

test("a stuckMs below panicMs cannot disable the panic escape hatch", () => {
  const r = normalizeConfig({ timing: { stuckMs: 1000 } });
  assert.ok(r.config.timing.stuckMs > r.config.timing.panicMs);
});

test("a stuckMs above every key timer is honoured untouched", () => {
  const r = normalizeConfig({ timing: { stuckMs: 4000 } });
  assert.equal(r.config.timing.stuckMs, 4000);
  assert.ok(!r.problems.some(p => p.code === "stuck-ms-raised"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/KeyEngine.test.mjs tests/Config.test.mjs`
Expected: FAIL. The `stuckKey` tests fail because `byType(fx, "stuckKey")` is always empty and `e.heldKeys()` stays `["up"]`; the Config tests fail with `stuckMs` being `undefined`.

- [ ] **Step 3: Add the default**

In `lib/Defaults.mjs`, replace line 22:

```javascript
export const DEFAULT_TIMING = { holdMs: 350, doubleMs: 250, repeatMs: 80, panicMs: 1500, stuckMs: 10000 };
```

- [ ] **Step 4: Add the safe floor in Config**

In `lib/Config.mjs`, directly after the `for (const k of Object.keys(DEFAULT_TIMING))` loop (currently line 53), insert:

```javascript
  // The stuck bound must never pre-empt a key's own legitimate timer. A stuckMs below holdMs/panicMs/doubleMs
  // would time a key out before its hold, panic reset or double window could fire — on a panic key that
  // silently removes the §4.3 escape hatch — and num() above accepts 0. Raise it rather than honour it.
  const stuckFloor = Math.max(config.timing.holdMs, config.timing.panicMs, config.timing.doubleMs) + 1;
  if (config.timing.stuckMs < stuckFloor) {
    problems.push({ code: "stuck-ms-raised", message: `timing.stuckMs ${config.timing.stuckMs} is below the longest key timer; raised to ${stuckFloor}` });
    config.timing.stuckMs = stuckFloor;
  }
```

- [ ] **Step 5: Add the bound to the engine**

In `lib/KeyEngine.mjs`:

Replace `fresh` (line 9) so every key carries the new field:

```javascript
  const fresh = () => ({ phase: "idle", deadline: null, stuckAt: null, pressedAt: 0, releasedAt: 0 });
```

Add the effective-due helper next to `cfg`/`timing` (after line 14):

```javascript
  // Effective due time: the earlier of the phase deadline and the absolute stuck bound.
  const due = (s) => (s.deadline === null ? s.stuckAt : s.stuckAt === null ? s.deadline : Math.min(s.deadline, s.stuckAt));
```

Replace the opening of `fire` (lines 19-21) so the bound is checked before any phase logic:

```javascript
  function fire(n, now, out) {           // timer for key n is due
    const s = st[n], k = cfg(n), c = keyClass(k);
    // Checked before the phase switch, and emitting nothing but stuckKey: if this ran after the phase
    // logic, a timeout in `down` would be indistinguishable from a release and reported as a tap.
    if (s.stuckAt !== null && now >= s.stuckAt) {
      s.phase = "idle"; s.deadline = null; s.stuckAt = null;
      out.push({ type: "stuckKey", key: n });
      return;
    }
    s.deadline = null;
```

Replace the scan in `advance` (lines 51-57) so it ranks on the effective due time and fires at it:

```javascript
      let best = null, bestDue = null;
      for (const n of KEY_NAMES) {
        const d = due(st[n]);
        if (d !== null && d <= now && (bestDue === null || d < bestDue)) { best = n; bestDue = d; }
      }
      if (best === null || guard++ > 1000) break;
      fire(best, bestDue, out);
```

In `press`, arm the bound whenever the key leaves `idle`. In the `waitDouble` branch (after line 79's `s.phase = "consumeRelease"`) add:

```javascript
      s.stuckAt = now + timing().stuckMs;      // physically down again; bound this press too
```

and after `s.phase = "down"` (line 86) add:

```javascript
    s.stuckAt = now + t.stuckMs;
```

(The `c.simple` early return on line 85 stays `idle` and needs no bound.)

In `release`, clear the bound on every path back to `idle` or into `waitDouble`:

```javascript
      case "down":
        s.deadline = null;
        if (k.double) { s.phase = "waitDouble"; s.releasedAt = now; s.deadline = now + t.doubleMs; s.stuckAt = null; }
        else { s.phase = "idle"; s.stuckAt = null; if (k.tap) out.push(action(n, "tap", k.tap)); }
        break;
      case "held":
      case "repeating":
      case "consumeRelease":
        s.deadline = null; s.stuckAt = null; s.phase = "idle"; break;
```

Replace `nextDeadline` (lines 113-117):

```javascript
  function nextDeadline() {
    let d = null;
    for (const n of KEY_NAMES) { const x = due(st[n]); if (x !== null && (d === null || x < d)) d = x; }
    return d;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, all suites. `tests/Portability.test.mjs` must stay green — the code above uses no object spread, no `??` and no `?.`.

- [ ] **Step 7: Commit**

```bash
git add lib/Defaults.mjs lib/Config.mjs lib/KeyEngine.mjs tests/KeyEngine.test.mjs tests/Config.test.mjs
git commit -m "feat(engine): bound every key press absolutely, not per phase

A lost release held a key forever in one of four phases, and on the six
repeat:true keys that was an unbounded stream of injected keystrokes
recoverable only by the panic reset (observed live 2026-10-02).

One absolute per-key bound (stuckAt), measured from the physical press and
checked before any phase logic, replaces what would have been four patches.
The check emits stuckKey and nothing else: run after the phase logic, a
timeout in \`down\` would be indistinguishable from a release and reported
as a tap.

Config raises a stuckMs below holdMs/panicMs/doubleMs to a safe floor
rather than honouring it. num() accepts 0, and any value under panicMs
would time a panic key out before its reset — silently removing the §4.3
escape hatch, on the very knob the bind sweep tells an operator to lower."
```

---

### Task 2: `lastStuckKey` Service plumbing

The engine now emits `stuckKey`, but nothing consumes it, and `root.heldKeys` is recomputed only in `onKeyEdge` (`Service.qml:226`). `stuckKey` arrives through `advanceAll()` → `engine.advance(now)`, which never touches `heldKeys` — so after a timeout the status would keep reporting a key the engine has already released. Four parts, all required: the effect is consumed, the last one is retained, `statusJson()` publishes it, and `heldKeys` is resynchronised.

**Files:**
- Modify: `Service.qml` — property near `:43-47`, `applyEffect` switch `:103-131`, `statusJson()` `:508-526`
- Test: `tests/fake-remote.sh`

**Interfaces:**
- Consumes: `{ type: "stuckKey", key }` from Task 1, dispatched with `src === "engine"`.
- Produces: `root.lastStuckKey` — `null`, or `{ key: <string>, at: <epoch ms> }` — published in `statusJson()` as `.lastStuckKey`. Task 6's sweep reads `.lastStuckKey.key` to tell a lost release from a delivered one.

- [ ] **Step 1: Write the failing integration scenarios**

In `tests/fake-remote.sh`, add next to the other key scenarios (after `s_ipc_reset_clears_held_keys`):

```bash
s_stuck_key_bounds_a_lost_release() {   # Task 1/2: a repeat key whose release never arrives must stop and self-clear
  wait_for '.config' true 5 || return 1
  local f=$XDG_CONFIG_HOME/omaremote/config.json
  jq '.timing.stuckMs = 1600' "$f" > "$F/c.json" && cat "$F/c.json" > "$f"   # above panicMs 1500, so the floor leaves it alone
  wait_for '.timing.stuckMs' 1600 5 || return 1
  ipc key up down > /dev/null                                                # pressed, never released
  wait_for '.heldKeys | length' 1 2 || return 1
  wait_for '.heldKeys | length' 0 4 || { echo "    heldKeys never cleared: $(jget '.heldKeys | join(",")')"; return 1; }
  [[ $(jget '.lastStuckKey.key') == up ]] || { echo "    lastStuckKey=$(jget '.lastStuckKey')"; return 1; }
  local n; n=$(grep -cxF "wtype -k Up" "$F/actions.log")
  sleep 0.5
  [[ $(grep -cxF "wtype -k Up" "$F/actions.log") == "$n" ]] || { echo "    actions kept coming after the bound"; return 1; }
}
s_stuck_key_absent_when_release_arrives() {   # the signal must mean something: a normal press leaves it null
  wait_for '.config' true 5 || return 1
  ipc key up down > /dev/null; sleep 0.2; ipc key up up > /dev/null; sleep 0.1
  [[ $(jget '.lastStuckKey') == null ]] || { echo "    lastStuckKey=$(jget '.lastStuckKey')"; return 1; }
  [[ $(jget '.heldKeys | length') == 0 ]]
}
```

and register them with the other `scenario` lines:

```bash
scenario stuck_key_bounds_a_lost_release s_stuck_key_bounds_a_lost_release
scenario stuck_key_absent_when_release_arrives s_stuck_key_absent_when_release_arrives
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bash tests/fake-remote.sh stuck_key_bounds_a_lost_release`
Expected: FAIL — `.lastStuckKey` is `null` because `statusJson()` has no such field, and `heldKeys` never returns to 0 because nothing resynchronises it.

- [ ] **Step 3: Add the property**

In `Service.qml`, beside the other key-state properties (after `property var heldKeys: []`, line 47):

```qml
  property var lastStuckKey: null      // { key, at } — §2 of the Plan 3 spec; the sweep reads this to tell a lost release from a delivered one
```

- [ ] **Step 4: Consume the effect**

In `Service.qml`'s `applyEffect` switch, add a case beside the other engine effects (next to `case "reset"`):

```qml
      case "stuckKey":
        root.lastStuckKey = { key: e.key, at: Date.now() }
        root.heldKeys = engine ? engine.heldKeys() : []    // advanceAll() never refreshes this; without it the status keeps reporting a key the engine already released
        console.log("omaremote: key " + e.key + " exceeded timing.stuckMs; release presumed lost")
        break
```

- [ ] **Step 5: Publish it**

In `Service.qml`'s `statusJson()`, add to the object (beside `heldKeys`, line 512):

```qml
      , lastStuckKey: root.lastStuckKey
```

- [ ] **Step 6: Clear it on reset**

In `onEngineReset()` (`Service.qml:247-248`), beside `root.heldKeys = []`:

```qml
    root.lastStuckKey = null
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bash tests/fake-remote.sh stuck_key_bounds_a_lost_release && bash tests/fake-remote.sh stuck_key_absent_when_release_arrives && make check`
Expected: PASS, and the full scenario count rises by 2 with no regressions.

- [ ] **Step 8: Commit**

```bash
git add Service.qml tests/fake-remote.sh
git commit -m "feat(host): publish lastStuckKey and resync heldKeys on a timeout

stuckKey arrives through advanceAll() -> engine.advance(), a path that
never recomputed root.heldKeys — only onKeyEdge did. Without the resync the
status kept reporting a key the engine had already released, which would
have blocked the bind sweep's own held-key check.

lastStuckKey is also the sweep's instrument: it distinguishes 'the release
was lost' from 'the release arrived' by observation instead of inference."
```

---

### Task 3: Self-test lease — caller-chosen length and a reason on `busy`

`SelfTest.mjs:20` collapses six distinct conditions into one `busy`, so a caller cannot tell "retry in 300 ms" from "a key is stuck and will never clear". The 30 s lease cannot cover the sweep of Task 6 or any human-in-the-loop check.

`selftestArm()` is a zero-argument `IpcHandler` function and `tests/fake-remote.sh` already calls it that way, so its arity is **not** changed; a new verb `selftestArmFor(leaseMs)` is added beside it.

**Files:**
- Modify: `lib/SelfTest.mjs:3`, `:20-24`
- Modify: `Service.qml:434`, `:436-451`, IPC block `:527-545`
- Test: `tests/SelfTest.test.mjs`, `tests/fake-remote.sh`

**Interfaces:**
- Consumes: `root.selftestArm()` from Task 2's unchanged Service.
- Produces: `arm(now, ctx)` returns `{ ok: true, id }` or `{ ok: false, reason: "busy", detail: <string>, retryAfterMs: 300 }` where `detail` is one of `leaseActive`, `voiceBusy`, `backendStale`, `heldKeys:<comma-separated>`, `pendingCmds:<n>`, `gate`. `createSelfTest({ supportedKeys, gate, leaseMs })` clamps `leaseMs` into `[1000, 600000]`, defaulting to `120000`. IPC verb `selftestArmFor(leaseMs: string)`. Task 6 calls `selftestArmFor 120000` and branches on `detail`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/SelfTest.test.mjs`:

```javascript
test("arm names the blocker instead of a bare busy", () => {
  const { g, st } = mk();
  assert.equal(st.arm(0, { ...okCtx, voiceIdle: false }).detail, "voiceBusy");
  assert.equal(st.arm(0, { ...okCtx, backendIdleFresh: false }).detail, "backendStale");
  assert.equal(st.arm(0, { ...okCtx, heldKeys: ["ok", "up"] }).detail, "heldKeys:ok,up");
  assert.equal(st.arm(0, { ...okCtx, pendingCmds: 2 }).detail, "pendingCmds:2");
  g.acquire("mic-apply");
  assert.equal(st.arm(0, okCtx).detail, "gate");
  g.release("mic-apply");
  st.arm(0, okCtx);
  assert.equal(st.arm(0, okCtx).detail, "leaseActive");
});

test("every busy reply carries retryAfterMs so a runner can retry", () => {
  const { st } = mk();
  const r = st.arm(0, { ...okCtx, pendingCmds: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "busy");
  assert.equal(r.retryAfterMs, 300);
});

test("leaseMs defaults to 120 s and is clamped, never rejected", () => {
  const d = createSelfTest({ supportedKeys: ["up"], gate: gate() });
  d.arm(0, okCtx);
  assert.equal(d.nextDeadline(), 120000);
  const hi = createSelfTest({ supportedKeys: ["up"], gate: gate(), leaseMs: 99999999 });
  hi.arm(0, okCtx);
  assert.equal(hi.nextDeadline(), 600000);
  const lo = createSelfTest({ supportedKeys: ["up"], gate: gate(), leaseMs: 0 });
  lo.arm(0, okCtx);
  assert.equal(lo.nextDeadline(), 1000);
  const bad = createSelfTest({ supportedKeys: ["up"], gate: gate(), leaseMs: NaN });
  bad.arm(0, okCtx);
  assert.equal(bad.nextDeadline(), 120000);
});
```

Remove the now-wrong assertion `assert.equal(st.nextDeadline(), 30000);` from the existing `"arm requires idle voice…"` test and replace it with `assert.equal(st.nextDeadline(), 120000);`.

In `tests/fake-remote.sh`, add:

```bash
s_selftest_arm_for_clamps_garbage() {   # Review focus 2: an IPC string from a shell must clamp, never throw
  ready || return 1
  local id; id=$(ipc selftestArmFor "abc" | jq -r '.id')
  [[ $id == st-* ]] || { echo "    arm with 'abc' gave: $(ipc selftestArmFor abc)"; return 1; }
  local rem; rem=$(ipc selftestStatus "$id" | jq -r '.remainingMs')
  (( rem > 100000 )) || { echo "    remainingMs=$rem (expected the 120 s default)"; return 1; }
  [[ $(ipc selftestDisarm "$id") == ok ]]
}
s_selftest_arm_busy_names_the_blocker() {
  ready || return 1
  ipc key ok down > /dev/null; sleep 0.05
  [[ $(ipc selftestArm | jq -r '.detail') == heldKeys:ok ]] || { echo "    detail=$(ipc selftestArm | jq -r '.detail')"; return 1; }
  ipc key ok up > /dev/null
}
```

and register them:

```bash
scenario selftest_arm_for_clamps_garbage s_selftest_arm_for_clamps_garbage
scenario selftest_arm_busy_names_the_blocker s_selftest_arm_busy_names_the_blocker
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/SelfTest.test.mjs`
Expected: FAIL — `detail` is `undefined`, `retryAfterMs` is `undefined`, and `nextDeadline()` is `30000`.

- [ ] **Step 3: Implement the clamp and the reasons**

In `lib/SelfTest.mjs`, replace the factory signature (line 3) and the `arm` method (lines 20-24):

```javascript
export function createSelfTest({ supportedKeys, gate, leaseMs }) {
  // §7: the lease length is chosen by the caller. An out-of-range or unparseable value clamps rather
  // than rejecting — it arrives as an IPC string from a shell and must never throw into the host.
  const LEASE_DEFAULT = 120000, LEASE_MIN = 1000, LEASE_MAX = 600000;
  const n = Number(leaseMs);
  const lease_ms = Number.isFinite(n) && n > 0 ? Math.min(LEASE_MAX, Math.max(LEASE_MIN, n)) : LEASE_DEFAULT;
```

and

```javascript
    arm(now, ctx) {
      const busy = (detail) => ({ ok: false, reason: "busy", detail: detail, retryAfterMs: 300 });
      if (lease) return busy("leaseActive");
      if (!ctx) return busy("voiceBusy");
      if (!ctx.voiceIdle) return busy("voiceBusy");
      if (!ctx.backendIdleFresh) return busy("backendStale");
      if (ctx.heldKeys && ctx.heldKeys.length) return busy("heldKeys:" + ctx.heldKeys.join(","));
      if ((ctx.pendingCmds || 0) > 0) return busy("pendingCmds:" + ctx.pendingCmds);
      if (!gate.acquire("selftest")) return busy("gate");
      lease = { id: `st-${++seq}`, until: now + lease_ms, counts: { shortcut: {}, ipc: {} }, down: new Set() };
      return { ok: true, id: lease.id };
    },
```

Replace every remaining use of the old `leaseMs` identifier inside the module with `lease_ms`.

- [ ] **Step 4: Thread it through Service**

In `Service.qml`, give `rebuildSelftest` a lease argument and add the new verb. Replace `rebuildSelftest` (`:432-435`):

```qml
  property int selftestLeaseMs: 120000
  function rebuildSelftest() {
    var keys = Defaults.KEY_NAMES.filter(function(k) { return root.config.keys[k].supported !== false })
    selftest = SelfTest.createSelfTest({ supportedKeys: keys, gate: voice.gate, leaseMs: root.selftestLeaseMs })
  }
  function selftestArmWith(leaseMs) {
    root.selftestLeaseMs = leaseMs
    root.rebuildSelftest()
    return root.selftestArm()
  }
```

and in the `IpcHandler` block, beside `selftestArm`:

```qml
    function selftestArmFor(leaseMs: string): string { return JSON.stringify(root.selftestArmWith(leaseMs)) }
```

`selftestArm()` keeps its zero-argument signature and its existing body, so `tests/fake-remote.sh`'s current calls are untouched.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `make check`
Expected: PASS. `rebuildSelftest` is called from `onKeyEdge`'s guard (`Service.qml:179`) only when no lease is active, so swapping the instance cannot drop a live lease.

- [ ] **Step 6: Commit**

```bash
git add lib/SelfTest.mjs Service.qml tests/SelfTest.test.mjs tests/fake-remote.sh
git commit -m "feat(selftest): name the blocker on busy, let the caller pick the lease

Six distinct conditions all answered a bare 'busy', so a runner could not
tell 'retry in 300 ms' from 'a key is stuck and will never clear'. arm now
returns a detail naming the blocker.

The 30 s lease cannot cover the bind sweep or any human-in-the-loop check;
the default rises to 120 s with a 600 s cap, clamped rather than rejected
because the value arrives as an IPC string from a shell.

selftestArm() keeps its zero-argument arity — fake-remote.sh calls it that
way — and selftestArmFor(leaseMs) is added beside it."
```

---

### Task 4: uinput key injector, self-verified

keyd 2.6.0 has no injection subcommand (verified by extracting the package), so measuring bind edges at controlled durations needs an injector. A human cannot reproduce 120 ms versus 3000 ms, and unreliable human timing is what muddied the 2026-10-02 round.

**This task must complete before Task 5 installs keyd**, so that "the injector is broken" and "the bind rule is strange" can never be confused.

**Files:**
- Create: `tests/inject-key.py`
- Test: self-verification, both checks below

**Interfaces:**
- Produces: `sudo ./tests/inject-key.py <keyname> --hold-ms <n>` and `sudo ./tests/inject-key.py --seq f13:120,f18:3000`. Key names are the lowercase `KEY_*` stems (`f13`, `prog1`). Exit 0 on success, non-zero with a message on failure. Task 6 calls it once per matrix cell.

- [ ] **Step 1: Write the injector**

Create `tests/inject-key.py`:

```python
#!/usr/bin/env python3
"""Inject EV_KEY press/release pairs through a temporary uinput device.

keyd 2.6.0 has no injection subcommand, and wtype cannot trigger Hyprland binds
on this host, so measuring bind edges at controlled press durations needs this.
Emits only F13-F24 and prog1 by default -- nothing on an Omarchy host binds those,
so a stray injection is inert. Never injects modifiers.

Requires root (writes /dev/uinput). Read-only on everything else.
"""
import argparse
import ctypes
import fcntl
import os
import re
import struct
import sys
import time

UINPUT_IOCTL_BASE = ord("U")
UI_DEV_CREATE = 0x5501          # _IO(UINPUT_IOCTL_BASE, 1)
UI_DEV_DESTROY = 0x5502         # _IO(UINPUT_IOCTL_BASE, 2)
UI_SET_EVBIT = 0x40045564       # _IOW(UINPUT_IOCTL_BASE, 100, int)
UI_SET_KEYBIT = 0x40045565      # _IOW(UINPUT_IOCTL_BASE, 101, int)
UI_DEV_SETUP = 0x405c5503       # _IOW(UINPUT_IOCTL_BASE, 3, struct uinput_setup)

EV_SYN, EV_KEY = 0x00, 0x01
SYN_REPORT = 0
EVENT_FMT = "llHHi"             # struct input_event on 64-bit

# The compositor and libinput need time to finish adding the device after
# UI_DEV_CREATE. Without this wait the first events are silently dropped, and
# that failure reads exactly like "the bind rule is strange" -- the thing this
# tool exists to measure. Mandatory, not a tuning knob to remove.
SETTLE_S = 0.5


def key_codes():
    codes = {}
    with open("/usr/include/linux/input-event-codes.h") as fh:
        for line in fh:
            m = re.match(r"#define\s+KEY_(\w+)\s+(0x[0-9a-fA-F]+|\d+)", line)
            if m and not m.group(1).endswith(("MAX", "CNT")):
                codes.setdefault(m.group(1).lower(), int(m.group(2), 0))
    return codes


class Injector:
    def __init__(self, codes, name="omaremote-inject"):
        self.codes = codes
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
        for code in codes.values():
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, code)
        # struct uinput_setup { struct input_id id; char name[80]; __u32 ff_effects_max; }
        # struct input_id { __u16 bustype, vendor, product, version; }
        setup = struct.pack("HHHH80sI", 0x03, 0x1234, 0x5678, 1, name.encode(), 0)
        fcntl.ioctl(self.fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(self.fd, UI_DEV_CREATE)
        time.sleep(SETTLE_S)
        self.pressed = set()

    def _emit(self, etype, code, value):
        os.write(self.fd, struct.pack(EVENT_FMT, 0, 0, etype, code, value))

    def _syn(self):
        self._emit(EV_SYN, SYN_REPORT, 0)

    def tap(self, name, hold_ms):
        code = self.codes[name]
        self._emit(EV_KEY, code, 1)
        self._syn()
        self.pressed.add(code)
        time.sleep(hold_ms / 1000.0)
        self._emit(EV_KEY, code, 0)
        self._syn()
        self.pressed.discard(code)

    def close(self):
        for code in list(self.pressed):          # never leave a key down
            self._emit(EV_KEY, code, 0)
            self._syn()
        self.pressed.clear()
        try:
            fcntl.ioctl(self.fd, UI_DEV_DESTROY)
        finally:
            os.close(self.fd)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("key", nargs="?", help="key name, e.g. f13 or prog1")
    ap.add_argument("--hold-ms", type=int, default=120)
    ap.add_argument("--seq", help="comma-separated name:hold_ms pairs, e.g. f13:120,f18:3000")
    ap.add_argument("--gap-ms", type=int, default=300, help="pause between sequence entries")
    ap.add_argument("--settle-ms", type=int, default=int(SETTLE_S * 1000))
    args = ap.parse_args()

    if os.geteuid() != 0:
        sys.exit("inject-key: needs root to write /dev/uinput (run under sudo)")
    if not args.key and not args.seq:
        sys.exit("inject-key: give a key name or --seq")

    plan = []
    if args.seq:
        for part in args.seq.split(","):
            name, _, ms = part.partition(":")
            plan.append((name.strip().lower(), int(ms or args.hold_ms)))
    else:
        plan.append((args.key.strip().lower(), args.hold_ms))

    codes = key_codes()
    unknown = [n for n, _ in plan if n not in codes]
    if unknown:
        sys.exit(f"inject-key: unknown key name(s): {', '.join(unknown)}")

    global SETTLE_S
    SETTLE_S = args.settle_ms / 1000.0
    inj = Injector(codes)
    try:
        for i, (name, ms) in enumerate(plan):
            if i:
                time.sleep(args.gap_ms / 1000.0)
            inj.tap(name, ms)
            print(f"injected {name} for {ms}ms", flush=True)
    finally:
        inj.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Make it executable and check the ioctl numbers**

```bash
chmod +x tests/inject-key.py
python3 -c "
import ctypes
# _IOW(type, nr, size) = (2<<30)|(size<<16)|(ord(type)<<8)|nr ; _IO = (0<<30)|...
IOC=lambda d,t,n,s:(d<<30)|(s<<16)|(ord(t)<<8)|n
print('UI_DEV_CREATE ', hex(IOC(0,'U',1,0)))
print('UI_DEV_DESTROY', hex(IOC(0,'U',2,0)))
print('UI_SET_EVBIT  ', hex(IOC(2,'U',100,4)))
print('UI_SET_KEYBIT ', hex(IOC(2,'U',101,4)))
print('UI_DEV_SETUP  ', hex(IOC(2,'U',3,ctypes.sizeof(ctypes.c_uint16)*4+80+4)))
"
```

Expected: the five values printed match the constants in the script. If any differs, correct the script to the computed value — these are the numbers the running kernel's headers imply, and a wrong one fails with `OSError: [Errno 25] Inappropriate ioctl for device`.

- [ ] **Step 3: Self-verification check 1 — uinput emission and timing**

Ask the user to run both halves; the reader must be started first. The injector is useless as a judge until this passes.

Terminal A: `! sudo python3 /tmp/claude-1000/*/scratchpad/learn-keys.py /dev/input/by-path/platform-omaremote-inject 20` — if that path does not exist, first run `! ls -l /dev/input/by-id/ /dev/input/by-path/` while the injector is alive, or identify the node with `! grep -A4 omaremote-inject /proc/bus/input/devices`.

Terminal B: `! sudo ./tests/inject-key.py --seq f13:120,f18:3000 --gap-ms 500`

Expected in terminal A: `down`/`up` pairs for `KEY_F13` about 0.12 s apart and `KEY_F18` about 3.0 s apart, each within roughly 30 ms of the requested duration. Record the measured durations — Task 6's matrix is only as trustworthy as this number.

- [ ] **Step 4: Self-verification check 2 — the events reach Hyprland's bind layer**

Add a temporary ordinary bind (not a `GlobalShortcut`), fire it, confirm it, remove it. F24 is used because it is outside Task 6's sweep and nothing on this host binds it.

```bash
cat > ~/.config/hypr/omaremote-injecttest.lua <<'LUA'
-- TEMPORARY: injector self-verification only; removed in the next step.
hl.bind("F24", hl.dsp.exec("bash -c 'date +%s%3N >> /tmp/omaremote-inject-proof'"), { description = "omaremote-injecttest" })
LUA
grep -q 'hypr.omaremote-injecttest' ~/.config/hypr/hyprland.lua || printf '%s\n' 'require("hypr.omaremote-injecttest")' >> ~/.config/hypr/hyprland.lua
hyprctl reload
hyprctl binds -j | jq -r '.[].description | select(. == "omaremote-injecttest")'
rm -f /tmp/omaremote-inject-proof
```

Then: `! sudo ./tests/inject-key.py f24 --hold-ms 120`

```bash
cat /tmp/omaremote-inject-proof
```

Expected: the description line printed, and one timestamp in the proof file. A present bind with an empty proof file means the events are not reaching the bind layer — stop and investigate before Task 5, because every later measurement depends on this.

- [ ] **Step 5: Remove the temporary bind**

```bash
rm -f ~/.config/hypr/omaremote-injecttest.lua /tmp/omaremote-inject-proof
sed -i '/hypr.omaremote-injecttest/d' ~/.config/hypr/hyprland.lua
hyprctl reload
hyprctl binds -j | jq -r '[.[].description | select(startswith("omaremote"))] | length'
```

Expected: `0`. Leaving this bind behind would add a phantom `omaremote*` description that Task 7's verification counts.

- [ ] **Step 6: Commit**

```bash
git add tests/inject-key.py
git commit -m "test: uinput key injector for bind-edge measurement

keyd 2.6.0 has no injection subcommand (verified by extracting the package
without installing it) and wtype cannot trigger Hyprland binds on this
host, so measuring bind edges at controlled durations needs this. Press
duration is the variable that changed the 2026-10-02 outcome, and a human
cannot reproduce 120ms vs 3000ms.

Self-verified two ways before it is allowed to judge anything: the events
are read back off the virtual device's own evdev node with the measured
duration, and an ordinary Hyprland bind on F24 is shown to fire. Neither
check involves GlobalShortcut, so 'the injector is broken' and 'the bind
rule is strange' cannot be confused later.

The post-UI_DEV_CREATE settle wait is mandatory: without it the first
events are silently dropped, which reads exactly like the thing being
measured."
```

---

### Task 5: `host/omaremote-setup` — `deps` and `keyd`

The script is created here and run here, so it is never a description of work done by hand. It grows in Tasks 7 and 8.

Design spec §4 facts, all verified on 2026-10-02 by extracting the keyd package without installing it: keyd 2.6.0 is in `extra` with no dependencies; all 26 key names this device needs pass `keyd list-keys`; the `[ids]` explicit-list form matches **only** the listed ids, so the keyboard is never grabbed; `keyd.service` is exactly `ExecStart=/usr/bin/keyd`, so a foreground run is equivalent to the unit; `backspace+escape+enter` terminates keyd.

**Files:**
- Create: `host/omaremote-setup`
- Reference: `docs/hw-keymap-xiaomi-voice-remote.md` (the key table and the conf to generate), `host/omaremote-facts` (bash conventions in this repo)

**Interfaces:**
- Produces: `host/omaremote-setup <subcommand>` with `deps` and `keyd`. `LEARNED_KEYS` — an associative array mapping logical key to `<keyd source name>:<neutral keyd name>` for this device. `stage_file <dest> <tmp>` — validates, compares, keeps a `.bak`, replaces only on a difference, prints what it did. Tasks 7 and 8 add `binds`, `plugin`, `mic`, `verify` and reuse `stage_file`.

- [ ] **Step 1: Write the script**

Create `host/omaremote-setup`:

```bash
#!/usr/bin/env bash
# OmaRemote host setup. Idempotent; every subcommand is safe to re-run.
# Spec: docs/superpowers/specs/2026-10-02-omaremote-host-setup-design.md
set -euo pipefail

DEVICE_ID=${OMAREMOTE_DEVICE:-2717:32b8}
KEYD_CONF=/etc/keyd/omaremote.conf
ASSUME_YES=0

# Learned on 2026-10-02 from the real remote; see docs/hw-keymap-xiaomi-voice-remote.md.
# TODO(plan4): replace this table with the interactive learning step of main spec §7 step 2.
# logical -> "<source key as the remote emits it>:<neutral key>"
declare -A LEARNED_KEYS=(
  [up]="up:f13"            [down]="down:f14"       [left]="left:f15"
  [right]="right:f16"      [ok]="enter:f17"        [back]="back:f18"
  [home]="home:f19"        [menu]="compose:f20"    [app]="grave:f21"
  [volup]="volumeup:f22"   [voldown]="volumedown:f23"
  [power]="power:f24"      [mic]="f5:prog1"
)
# Deterministic order, so a regenerated conf is byte-identical and stage_file sees no change.
KEY_ORDER=(up down left right ok back home menu app volup voldown power mic)

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf 'omaremote-setup: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# Stage, validate, compare, replace only on a difference, keep a .bak. Never writes blind.
stage_file() {   # stage_file <dest> <staged-tmp> [sudo]
  local dest=$1 tmp=$2 use_sudo=${3:-}
  [[ -s $tmp ]] || die "refusing to install an empty file to $dest"
  if [[ -f $dest ]] && $use_sudo cmp -s "$tmp" "$dest" 2>/dev/null; then
    say "unchanged: $dest"; return 0
  fi
  if [[ -f $dest ]]; then
    $use_sudo cp -a "$dest" "$dest.bak" && say "kept previous version at $dest.bak"
  fi
  $use_sudo install -D -m 0644 "$tmp" "$dest"
  say "wrote: $dest"
}

gen_keyd_conf() {   # gen_keyd_conf > file
  printf '# Generated by omaremote-setup for %s. Do not edit by hand.\n' "$DEVICE_ID"
  printf '# The [ids] explicit-list form matches ONLY this device, so the keyboard is never grabbed.\n\n'
  printf '[ids]\n%s\n\n[main]\n' "$DEVICE_ID"
  local k src neutral
  for k in "${KEY_ORDER[@]}"; do
    IFS=: read -r src neutral <<< "${LEARNED_KEYS[$k]}"
    printf '%-12s = %s\n' "$src" "$neutral"
  done
}

cmd_deps() {
  step "checking host tools"
  local t
  for t in jq pw-dump wpctl voxtype hyprctl; do
    if command -v "$t" >/dev/null 2>&1; then say "  ok      $t"; else say "  MISSING $t"; fi
  done
  if command -v keyd >/dev/null 2>&1; then
    say "  ok      keyd ($(keyd --version 2>&1 | head -1))"
  else
    say "  MISSING keyd"
    say ""
    say "Install it yourself, then re-run this subcommand:"
    say "    sudo pacman -S --needed keyd"
    say "Note: install only. Do NOT enable the service yet -- 'omaremote-setup keyd' validates the"
    say "config in the foreground first, because a bad keyd config can make a machine unusable."
    return 1
  fi
}

cmd_keyd() {
  need keyd
  step "staging $KEYD_CONF for $DEVICE_ID"
  local tmp; tmp=$(mktemp); trap 'rm -f "$tmp"' RETURN
  gen_keyd_conf > "$tmp"
  sed 's/^/    /' "$tmp"

  step "validating the staged config with keyd check"
  # Validate before anything is written under /etc. keyd check wants a .conf in a directory it scans.
  local checkdir; checkdir=$(mktemp -d); cp "$tmp" "$checkdir/omaremote.conf"
  keyd check "$checkdir/omaremote.conf" || { rm -rf "$checkdir"; die "keyd check rejected the generated config; nothing was written"; }
  rm -rf "$checkdir"
  say "keyd check: ok"

  step "confirm the device id from keyd's own point of view"
  say "The man page names 'keyd monitor' as the source of device ids, so /proc/bus/input/devices is"
  say "corroboration, not authority. Run this and press ONE button on the remote:"
  say ""
  say "    sudo keyd monitor -t"
  say ""
  say "Expect a line whose device id is $DEVICE_ID. If it differs, re-run with"
  say "OMAREMOTE_DEVICE=<vendor:product> and nothing will be written until it matches."
  if (( ! ASSUME_YES )); then
    read -r -p "Did keyd monitor report $DEVICE_ID? [y/N] " a
    [[ ${a,,} == y ]] || die "device id not confirmed; $KEYD_CONF was not written"
  fi

  stage_file "$KEYD_CONF" "$tmp" sudo

  step "validate in the FOREGROUND before enabling the service"
  say "keyd.service is exactly 'ExecStart=/usr/bin/keyd', so a foreground run is equivalent to the"
  say "unit -- but Ctrl-C ends it, and closing the terminal ends it."
  say ""
  say "Rescue paths, before you start it:"
  say "  * backspace+escape+enter terminates keyd (documented in its README)"
  say "  * this config's [ids] lists only $DEVICE_ID, so your keyboard is never grabbed"
  say "  * Ctrl+Alt+F2 gives a second TTY where 'sudo systemctl stop keyd' works"
  say "  * removing $KEYD_CONF and running 'sudo keyd reload' reverts"
  say ""
  say "    Terminal A:  sudo /usr/bin/keyd"
  say "    Terminal B:  sudo keyd monitor -t      # press remote buttons; expect f13..f24 / prog1"
  say ""
  say "Confirm the remote now emits the neutral keys AND that your keyboard is unaffected."
  if (( ! ASSUME_YES )); then
    read -r -p "Foreground run clean, remote emits neutral keys, keyboard unaffected? [y/N] " a
    [[ ${a,,} == y ]] || die "foreground validation not confirmed; the service was NOT enabled"
  fi

  step "enabling the service"
  say "Run:  sudo systemctl enable --now keyd"
  say "Then re-run 'omaremote-setup keyd' to confirm it is active."
  systemctl is-active --quiet keyd && say "keyd.service: active" || say "keyd.service: not active yet"
}

usage() {
  cat <<'USAGE'
usage: omaremote-setup [--yes] <subcommand>

  deps    check host tools; report what to install (installs nothing itself)
  keyd    stage and validate /etc/keyd/omaremote.conf, then guide enabling the service

Environment:
  OMAREMOTE_DEVICE   vendor:product of the remote (default 2717:32b8)
USAGE
}

main() {
  while [[ ${1:-} == --* ]]; do
    case $1 in
      --yes) ASSUME_YES=1; shift ;;
      --help) usage; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  case ${1:-} in
    deps) cmd_deps ;;
    keyd) cmd_keyd ;;
    ""|help) usage ;;
    *) die "unknown subcommand: $1" ;;
  esac
}

main "$@"
```

- [ ] **Step 2: Make it executable and check it parses**

```bash
chmod +x host/omaremote-setup
bash -n host/omaremote-setup && echo "syntax ok"
./host/omaremote-setup --help
```

Expected: `syntax ok` and the usage text.

- [ ] **Step 3: Run `deps` and confirm it reports keyd missing**

```bash
./host/omaremote-setup deps || true
```

Expected: `jq`, `pw-dump`, `wpctl`, `voxtype`, `hyprctl` reported ok; `keyd` reported MISSING with the `pacman` line and the explicit "do not enable the service yet" warning, exit non-zero.

- [ ] **Step 4: Install keyd**

Ask the user to run: `! sudo pacman -S --needed keyd`

Then confirm: `./host/omaremote-setup deps`
Expected: every tool ok, including a keyd version line, exit 0.

- [ ] **Step 5: Verify the generated conf against `keyd list-keys` before trusting it**

```bash
./host/omaremote-setup keyd < /dev/null 2>&1 | sed -n '/^\[main\]/,/^$/p' | awk '{print $1; print $3}' | grep -v '^$' | sort -u > /tmp/omaremote-confkeys
keyd list-keys | sort -u > /tmp/omaremote-validkeys
comm -23 /tmp/omaremote-confkeys /tmp/omaremote-validkeys
```

Expected: no output — every name in the generated conf is a name keyd accepts. Any line printed is a name keyd would reject.

- [ ] **Step 6: Run the `keyd` subcommand, answering its prompts**

Ask the user to run `! ./host/omaremote-setup keyd` and work through it: `sudo keyd monitor -t` to confirm the id, then the foreground run in two terminals, then `sudo systemctl enable --now keyd`.

Expected: `keyd check: ok`, the conf written to `/etc/keyd/omaremote.conf`, the remote emitting `f13`–`f24`/`prog1` under `keyd monitor`, the keyboard unaffected, and a final `keyd.service: active`.

- [ ] **Step 7: Confirm idempotence**

Ask the user to run `! ./host/omaremote-setup --yes keyd`
Expected: `unchanged: /etc/keyd/omaremote.conf` — the regenerated file is byte-identical, so nothing is rewritten and no `.bak` is created.

- [ ] **Step 8: Commit**

```bash
git add host/omaremote-setup
git commit -m "feat(host): omaremote-setup deps and keyd subcommands

Written and run here rather than after the fact: a setup script that only
describes what was done by hand is not a deliverable.

The keyd step validates before it mutates and never enables silently --
keyd check on a staged file before anything touches /etc, the device id
confirmed through 'keyd monitor' (which the man page names as the authority,
not /proc/bus/input/devices), then a foreground 'sudo /usr/bin/keyd' run,
which is equivalent to the unit because keyd.service is exactly
ExecStart=/usr/bin/keyd. The rescue paths are printed before the user is
asked to start anything.

The [ids] explicit-list form matches only 2717:32b8, so the keyboard is
never grabbed -- that is the structural reason this is safe, not the
prompts."
```

---

### Task 6: Measure the bind matrix

Main spec §3 asserts "`hl.dsp.global` requests the release event itself, so a single bind delivers press and release". Live measurement on 2026-10-02 disproved it, on one key only, because 11 of the remote's 13 native codes collided with the keyboard. keyd is now in place, so the real neutral keys are available.

**Files:**
- Create: `tests/bind-matrix.sh`
- Modify: `docs/hw-keymap-xiaomi-voice-remote.md` (the open bind-edge bullet), `docs/superpowers/plans/2026-09-14-omaremote-qml-host-task0.md` ("Correction (2026-10-02)")

**Interfaces:**
- Consumes: `tests/inject-key.py` (Task 4), `selftestArmFor` and `arm`'s `detail` (Task 3), `.lastStuckKey` (Task 2), `timing.stuckMs` (Task 1).
- Produces: a markdown matrix on stdout, one row per (configuration, key, duration) with `down`/`up` counts, `heldKeys` and `lastStuckKey`; exit 0 only when a configuration qualifies. `~/.config/hypr/omaremote.lua` is left **removed** on exit — Task 7 generates the real one.

- [ ] **Step 1: Write the sweep**

Create `tests/bind-matrix.sh`:

```bash
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
INJECT=$(dirname "$0")/inject-key.py
SHELL_CMD=${OMAREMOTE_SHELL:-omarchy-shell}
LEASE_MS=120000
DURATIONS=(120 600 3000)
# key:neutral -- up is repeat:true (phase `repeating`), back is a long non-repeat key (phase `held`).
# power/f24 is excluded on purpose: its tap action blanks the screen.
PROBES=(up:f13 back:f18)

[[ $EUID -eq 0 ]] && { echo "bind-matrix: run as your normal user, not root (it sudos only the injector)" >&2; exit 1; }
command -v jq >/dev/null || { echo "bind-matrix: jq required" >&2; exit 1; }
sudo -n true 2>/dev/null || { echo "bind-matrix: cache sudo credentials first with 'sudo -v', then re-run" >&2; exit 1; }

ipc() { $SHELL_CMD omaremote "$@"; }

write_lua() {   # write_lua <one|two>
  local mode=$1 k neutral
  {
    printf -- '-- TEMPORARY: generated by tests/bind-matrix.sh (%s-bind sweep). Removed on exit.\n' "$mode"
    for probe in "${PROBES[@]}"; do
      IFS=: read -r k neutral <<< "$probe"
      local sym=${neutral^^}
      printf 'hl.bind("%s", hl.dsp.global("omaremote:%s"), { description = "omaremote:%s" })\n' "$sym" "$k" "$k"
      if [[ $mode == two ]]; then
        printf 'hl.bind("%s", hl.dsp.global("omaremote:%s"), { description = "omaremote:%s", release = true })\n' "$sym" "$k" "$k"
      fi
    done
  } > "$LUA"
  grep -q 'require("hypr.omaremote")' "$HYPRLAND_LUA" || printf '%s\n' 'require("hypr.omaremote")' >> "$HYPRLAND_LUA"
  hyprctl reload >/dev/null
  # NOT $(( ... mode == two ... )): inside arithmetic, bash expands `mode` and `two` as variables,
  # so a string comparison there is silently always true.
  local per=1; [[ $mode == two ]] && per=2
  local want=$(( ${#PROBES[@]} * per ))
  local got; got=$(hyprctl binds -j | jq '[.[].description | select(startswith("omaremote:"))] | length')
  [[ $got == "$want" ]] || { echo "  !! expected $want omaremote binds loaded, found $got"; return 1; }
}

arm() {   # echoes the lease id, or fails after naming the blocker
  local tries=0 r detail
  while (( tries < 20 )); do
    r=$(ipc selftestArmFor "$LEASE_MS")
    if [[ $(jq -r '.ok' <<< "$r") == true ]]; then jq -r '.id' <<< "$r"; return 0; fi
    detail=$(jq -r '.detail // "?"' <<< "$r")
    case $detail in
      heldKeys:*) echo "  !! blocked by held keys ($detail) -- not a transient condition" >&2; return 1 ;;
      *) sleep 0.3 ;;
    esac
    tries=$((tries + 1))
  done
  echo "  !! could not arm a lease: $detail" >&2; return 1
}

trial() {   # trial <key> <neutral> <hold_ms> -> "down up held stuck"
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
    local d u held stuck
    d=$(jq -r --arg k "$key" '.counts.shortcut[$k].down // 0' <<< "$rep")
    u=$(jq -r --arg k "$key" '.counts.shortcut[$k].up // 0' <<< "$rep")
    held=$(ipc status | jq -r '.heldKeys | join(",")')
    stuck=$(ipc status | jq -r '.lastStuckKey.key // "-"')
    printf '%s %s %s %s\n' "$d" "$u" "${held:--}" "$stuck"
    return 0
  done
  echo "  !! $key/${ms}ms never produced a clean trial" >&2; return 1
}

sweep() {   # sweep <one|two> -> prints rows, sets QUALIFIES / LOST
  local mode=$1 k neutral ms row d u held stuck
  QUALIFIES=1; LOST=0
  write_lua "$mode" || { QUALIFIES=0; LOST=99; return 0; }
  for probe in "${PROBES[@]}"; do
    IFS=: read -r k neutral <<< "$probe"
    for ms in "${DURATIONS[@]}"; do
      row=$(trial "$k" "$neutral" "$ms") || { QUALIFIES=0; LOST=$((LOST + 1)); continue; }
      read -r d u held stuck <<< "$row"
      printf '| %s | %s | %sms | %s | %s | %s | %s |\n' "$mode" "$k" "$ms" "$d" "$u" "$held" "$stuck"
      (( d >= 1 )) || { QUALIFIES=0; }
      (( u >= 1 )) || { QUALIFIES=0; LOST=$((LOST + 1)); }
      [[ $held == "-" || -z $held ]] || QUALIFIES=0
      ipc reset >/dev/null
    done
  done
}

cleanup() { rm -f "$LUA"; sed -i '/require("hypr.omaremote")/d' "$HYPRLAND_LUA"; hyprctl reload >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Lowering timing.stuckMs for the sweep (must stay above panicMs 1500)."
echo "Set \"stuckMs\": 2000 in ~/.config/omaremote/config.json before running, then press enter."
read -r _

echo
echo "| config | key | duration | down | up | heldKeys | lastStuckKey |"
echo "|---|---|---|---|---|---|---|"
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
  one-bind lost edges: $ONE_LOST    two-bind lost edges: $TWO_LOST
The least-bad configuration is a DIAGNOSTIC, NOT A PASS. Do not generate or install
~/.config/hypr/omaremote.lua from it: Task 7 stays blocked and setup must report failure.
This is a finding about the Hyprland Lua bind layer; record the failing cells above.
EOF
exit 1
```

- [ ] **Step 2: Check it parses**

```bash
chmod +x tests/bind-matrix.sh
bash -n tests/bind-matrix.sh && echo "syntax ok"
```

Expected: `syntax ok`.

- [ ] **Step 3: Lower `stuckMs` for the sweep**

```bash
jq '.timing.stuckMs = 2000' ~/.config/omaremote/config.json > /tmp/omaremote-cfg.json && cat /tmp/omaremote-cfg.json > ~/.config/omaremote/config.json
omarchy-shell omaremote status | jq '.timing.stuckMs, .configProblems'
```

Expected: `2000` and no `stuck-ms-raised` problem — 2000 is above `panicMs` 1500, so Task 1's floor leaves it alone. If it comes back as `1501`, the value was below the floor and the sweep would be measuring the clamp instead of the binds.

- [ ] **Step 4: Run the sweep**

Ask the user to run `! sudo -v && ./tests/bind-matrix.sh` (the script sudos only the injector) and **not to touch the remote while it runs** (the script discards and retries trials where it sees an unexpected key, but a quiet desk makes it finish faster).

Expected: the markdown matrix, then one of the three verdicts. Save the output.

- [ ] **Step 5: Restore `stuckMs`**

```bash
jq '.timing.stuckMs = 10000' ~/.config/omaremote/config.json > /tmp/omaremote-cfg.json && cat /tmp/omaremote-cfg.json > ~/.config/omaremote/config.json
omarchy-shell omaremote status | jq '.timing.stuckMs'
```

Expected: `10000`.

- [ ] **Step 6: If no configuration qualified, stop here**

Record the matrix and the failing cells in `docs/hw-keymap-xiaomi-voice-remote.md`, commit it, and report to the user that Task 7 is blocked. Do not generate `omaremote.lua`. Do not pick the least-bad configuration. This is the one branch of the plan where the correct action is to stop with the work incomplete.

- [ ] **Step 7: Record the measured matrix**

In `docs/hw-keymap-xiaomi-voice-remote.md`, replace the bullet beginning `**How many \`hl.bind\` lines per key is still open.**` with the measured matrix, the verdict, and this paragraph:

```markdown
- **Settled 2026-10-02 by measurement** (`tests/bind-matrix.sh`, keyd installed, real neutral keys,
  durations 120/600/3000 ms on `up`/F13 and `back`/F18):

  <matrix table from the sweep>

  **The weighting changed between the two rounds, and that matters more than the verdict.** When this
  was first measured, a lost release on a `repeat: true` key was catastrophic — an unbounded action
  stream recoverable only by the panic reset. `timing.stuckMs` (Plan 3) bounds that, so a lost release
  is now a bounded defect rather than a runaway. A reader comparing the two rounds' conclusions should
  see that the premise changed, not merely the taste.
```

Make the matching edit to the "Correction (2026-10-02)" section of
`docs/superpowers/plans/2026-09-14-omaremote-qml-host-task0.md`, replacing its open question with the verdict and a pointer here.

- [ ] **Step 8: Commit**

```bash
git add tests/bind-matrix.sh docs/hw-keymap-xiaomi-voice-remote.md docs/superpowers/plans/2026-09-14-omaremote-qml-host-task0.md
git commit -m "test(hw): settle the bind-edge question by measurement

Main spec §3 claims hl.dsp.global makes one bind deliver both edges. The
2026-10-02 round disproved that on one key -- the only key available,
because 11 of this remote's 13 native codes collide with the keyboard. With
keyd installed the real neutral keys exist, so the sweep covers both a
repeat:true key (phase 'repeating') and a long non-repeat key (phase
'held') at three durations.

The sweep discards and retries any trial where it sees a key it did not
inject: raw GlobalShortcut counts include real remote input, so a stray
press would otherwise be recorded as the configuration's verdict.

A least-bad result is a diagnostic, not a pass: the script exits non-zero
and says so, because this is the likeliest place to quietly install a
known-defective configuration for being the best of what was seen."
```

---

### Task 7: Generate the real Hyprland binds

Runs **only** if Task 6 produced a qualifying configuration.

**Files:**
- Modify: `host/omaremote-setup` (add `cmd_binds`, `gen_lua`, `verify_binds`, `neutral_keysym`; register `binds`; extend usage)

**Interfaces:**
- Consumes: `stage_file`, `LEARNED_KEYS`, `KEY_ORDER` from Task 5; Task 6's verdict as the value of `BIND_MODE`.
- Produces: `omaremote-setup binds`; `~/.config/hypr/omaremote.lua`; `verify_binds` — distinguishes zero / too many / mismatched descriptions, reused by Task 8's `verify`.

- [ ] **Step 1: Add the generator and its verification**

In `host/omaremote-setup`, set the measured mode near the top, beside `DEVICE_ID`:

```bash
# Settled by tests/bind-matrix.sh on 2026-10-02; see docs/hw-keymap-xiaomi-voice-remote.md.
# "one" = a single hl.bind per key; "two" = press plus { release = true }.
BIND_MODE=${OMAREMOTE_BIND_MODE:-<one-or-two-from-task-6>}
HYPR_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/hypr
```

and add the subcommand:

```bash
neutral_keysym() {   # neutral_keysym <logical> -> F13.. / XF86Tools
  local neutral; IFS=: read -r _ neutral <<< "${LEARNED_KEYS[$1]}"
  if [[ $neutral == prog1 ]]; then printf 'XF86Tools'; else printf '%s' "${neutral^^}"; fi
}

gen_lua() {
  printf -- '-- Generated by omaremote-setup. Do not edit by hand; re-run "omaremote-setup binds".\n'
  printf -- '-- Bind count per key (%s) was settled by measurement, not assumption: tests/bind-matrix.sh.\n' "$BIND_MODE"
  printf -- '-- Modifier combos are never generated: the modmask stops matching once the modifier is\n'
  printf -- '-- released first, which loses the release edge.\n\n'
  local k sym
  for k in "${KEY_ORDER[@]}"; do
    sym=$(neutral_keysym "$k")
    printf 'hl.bind("%s", hl.dsp.global("omaremote:%s"), { description = "omaremote:%s" })\n' "$sym" "$k" "$k"
    [[ $BIND_MODE == two ]] && printf 'hl.bind("%s", hl.dsp.global("omaremote:%s"), { description = "omaremote:%s", release = true })\n' "$sym" "$k" "$k"
  done
  printf -- '\n-- Keyboard escape hatch, independent of the remote (main spec §4.3).\n'
  printf 'o.bind("SUPER + CTRL + ALT + R", "OmaRemote reset", "omarchy-shell omaremote reset")\n'
}

verify_binds() {
  local per=1; [[ $BIND_MODE == two ]] && per=2
  local want=$(( ${#KEY_ORDER[@]} * per ))
  local got; got=$(hyprctl binds -j | jq '[.[].description | select(startswith("omaremote:"))] | length')
  if [[ $got == "$want" ]]; then say "binds loaded: $got (expected $want)"; return 0; fi
  # Review focus 4: zero and too-many need opposite fixes, so never report them as one "mismatch".
  if [[ $got == 0 ]]; then
    if grep -q 'require("hypr.omaremote")' "$HYPR_DIR/hyprland.lua"; then
      die "no omaremote binds loaded although the require line is present -- check hyprctl reload output and $HYPR_DIR/omaremote.lua for a Lua error"
    fi
    die "no omaremote binds loaded because hyprland.lua has no require(\"hypr.omaremote\") line"
  fi
  if (( got > want )); then
    say "duplicate or leftover omaremote binds -- descriptions seen:"
    hyprctl binds -j | jq -r '.[].description | select(startswith("omaremote:"))' | sort | uniq -c | sed 's/^/    /'
    die "expected $want, found $got; remove any stale generated or hand-written omaremote binds and re-run"
  fi
  die "expected $want omaremote binds, found only $got; some keys did not bind"
}

cmd_binds() {
  need hyprctl; need jq
  [[ $BIND_MODE == one || $BIND_MODE == two ]] || die "BIND_MODE must be 'one' or 'two' (settled by tests/bind-matrix.sh); got '$BIND_MODE'"
  step "generating $HYPR_DIR/omaremote.lua ($BIND_MODE-bind)"
  local tmp; tmp=$(mktemp); trap 'rm -f "$tmp"' RETURN
  gen_lua > "$tmp"
  stage_file "$HYPR_DIR/omaremote.lua" "$tmp"

  step "ensuring hyprland.lua requires it"
  if grep -q 'require("hypr.omaremote")' "$HYPR_DIR/hyprland.lua"; then
    say "require line already present"
  else
    cp -a "$HYPR_DIR/hyprland.lua" "$HYPR_DIR/hyprland.lua.bak"
    printf '%s\n' 'require("hypr.omaremote")' >> "$HYPR_DIR/hyprland.lua"
    say "appended require(\"hypr.omaremote\") (previous version at hyprland.lua.bak)"
  fi

  step "reloading and verifying"
  hyprctl reload >/dev/null
  verify_binds
}
```

Register it in `main`'s `case` (`binds) cmd_binds ;;`) and add a `binds` line to `usage`.

- [ ] **Step 2: Fill in the measured mode**

Replace `<one-or-two-from-task-6>` with the verdict from Task 6. If Task 6 did not produce a qualifying configuration, this task does not run at all.

- [ ] **Step 3: Check it parses and generate the file**

```bash
bash -n host/omaremote-setup && echo "syntax ok"
./host/omaremote-setup binds
```

Expected: `syntax ok`, the file written, the require line appended or already present, and `binds loaded: N (expected N)` with N = 13 or 26.

- [ ] **Step 4: Verify the zero-binds branch reports the right cause**

```bash
cp ~/.config/hypr/hyprland.lua /tmp/omaremote-hyprland.bak
sed -i '/require("hypr.omaremote")/d' ~/.config/hypr/hyprland.lua
hyprctl reload >/dev/null
./host/omaremote-setup binds 2>&1 | tail -3
```

Expected: the run re-appends the require line and succeeds. Then confirm the diagnostic itself, without the generator repairing it:

```bash
sed -i '/require("hypr.omaremote")/d' ~/.config/hypr/hyprland.lua
hyprctl reload >/dev/null
bash -c 'source <(sed -n "/^verify_binds()/,/^}/p" host/omaremote-setup); BIND_MODE=one; KEY_ORDER=(up down left right ok back home menu app volup voldown power mic); HYPR_DIR=$HOME/.config/hypr; say(){ printf "%s\n" "$*"; }; die(){ printf "%s\n" "$*" >&2; exit 1; }; verify_binds' 2>&1 | tail -2
cp /tmp/omaremote-hyprland.bak ~/.config/hypr/hyprland.lua
./host/omaremote-setup binds
```

Expected: the isolated `verify_binds` says the require line is missing — not a bare count mismatch — and the final run restores a verified state.

- [ ] **Step 5: Confirm idempotence**

```bash
./host/omaremote-setup binds
```

Expected: `unchanged: …/omaremote.lua`, `require line already present`, and the same verified count. No new `.bak`.

- [ ] **Step 6: Commit**

```bash
git add host/omaremote-setup
git commit -m "feat(host): generate the Hyprland binds from the measured bind count

The bind count per key comes from tests/bind-matrix.sh, not from the main
spec's claim that one bind suffices. Modifier combos are never generated:
the modmask stops matching once the modifier is released first, losing the
release edge.

verify_binds distinguishes zero from too-many rather than reporting both as
a mismatch, because they need opposite fixes -- zero is usually a missing
require(\"hypr.omaremote\") line, too many is a leftover generated file."
```

---

### Task 8: Plugin, mic mode, and end-to-end verification

**Files:**
- Modify: `host/omaremote-setup` (add `cmd_plugin`, `cmd_mic`, `cmd_verify`, `cmd_all`; extend usage)

**Interfaces:**
- Consumes: `verify_binds` (Task 7), `tests/inject-key.py` (Task 4), the main spec §3 mic-apply contract (`mic`/`micStatus` IPC, already implemented in Plan 2).
- Produces: `omaremote-setup plugin|mic|verify`, and a bare `omaremote-setup` running every step in order.

- [ ] **Step 1: Add the remaining subcommands**

In `host/omaremote-setup`:

```bash
PLUGIN_ID=io.github.kehao-chen.omaremote
SHELL_CMD=${OMAREMOTE_SHELL:-omarchy-shell}

ipc() { $SHELL_CMD omaremote "$@"; }

cmd_plugin() {
  need omarchy; need jq
  step "ensuring the plugin is installed and enabled"
  if omarchy plugin list 2>/dev/null | grep -q "$PLUGIN_ID"; then
    say "plugin present: $PLUGIN_ID"
  else
    say "Install it from this checkout, then re-run:"
    say "    omarchy plugin add . --enable"
    return 1
  fi
  $SHELL_CMD shell rescanPlugins >/dev/null 2>&1 || true
  step "waiting for the service to answer (at most 15 s)"
  local i=0
  while (( i < 150 )); do
    [[ $(ipc selftestPing 2>/dev/null) == ok ]] && { say "selftestPing: ok"; return 0; }
    sleep 0.1; i=$((i + 1))
  done
  die "the service never answered selftestPing. A changed keepLoaded manifest needs a full restart: omarchy-restart-shell"
}

cmd_mic() {   # cmd_mic <remote|system>
  need jq
  local mode=${1:-system}
  [[ $mode == remote || $mode == system ]] || die "mic mode must be 'remote' or 'system'; got '$mode'"
  step "applying mic mode: $mode"
  say "This restarts voxtype once. Do not use F9 until it finishes."
  local r id; r=$(ipc mic "$mode"); id=$(jq -r '.operationId // empty' <<< "$r")
  [[ -n $id ]] || die "mic apply was not accepted: $r"
  say "operation $id queued; polling"
  local i=0 state=""
  while (( i < 150 )); do          # 150 s client budget per main spec §7 step 5
    state=$(ipc micStatus "$id" | jq -r '.state // "?"')
    case $state in
      succeeded) say "mic mode applied: $mode"; return 0 ;;
      failed|rollingBack) die "mic apply ended $state: $(ipc micStatus "$id")" ;;
    esac
    sleep 1; i=$((i + 1))
  done
  die "mic apply did not reach a terminal state within 150 s (last: $state); resolve before retrying"
}

cmd_verify() {
  need jq
  step "verifying the loaded binds"
  verify_binds
  step "verifying the transport"
  # Gated on sudo being usable, not on being root: this script must stay a user-run script so its
  # omarchy-shell IPC reaches the user's session.
  if ! sudo -n true 2>/dev/null; then
    say "SKIPPED: the transport sweep needs sudo for the injector (/dev/uinput)."
    say "Run 'sudo -v' to cache credentials, then re-run this subcommand. NOT reporting a pass."
    return 0
  fi
  local inject; inject=$(dirname "$0")/../tests/inject-key.py
  [[ -x $inject ]] || die "injector not found at $inject"
  local r id; r=$(ipc selftestArmFor 60000)
  id=$(jq -r '.id // empty' <<< "$r")
  [[ -n $id ]] || die "could not arm a self-test lease: $r"
  local k neutral
  for k in "${KEY_ORDER[@]}"; do
    IFS=: read -r _ neutral <<< "${LEARNED_KEYS[$k]}"
    sudo "$inject" "$neutral" --hold-ms 120 >/dev/null
  done
  sleep 0.5
  local rep; rep=$(ipc selftestReport "$id")
  if [[ $(jq -r '.ok' <<< "$rep") == true ]]; then
    say "transport: every supported key delivered exactly one press and one release"
  else
    say "transport FAILED:"
    jq -r '"  missing: \(.missing | join(",")) extras: \(.extras | join(",")) held: \(.held | join(","))"' <<< "$rep" 2>/dev/null || jq . <<< "$rep"
    return 1
  fi
}

cmd_all() {
  cmd_deps
  cmd_keyd
  cmd_binds
  cmd_plugin
  cmd_mic system
  cmd_verify
}
```

Register `plugin`, `mic`, `verify` in `main`'s `case`, make the bare invocation run `cmd_all`, and extend `usage`.

- [ ] **Step 2: Check it parses**

```bash
bash -n host/omaremote-setup && echo "syntax ok"
./host/omaremote-setup --help
```

Expected: `syntax ok` and usage listing all six subcommands.

- [ ] **Step 3: Install and enable the plugin**

```bash
./host/omaremote-setup plugin || true
```

If it reports the plugin is absent, ask the user to run `! omarchy plugin add . --enable`, then re-run.
Expected: `plugin present`, `selftestPing: ok`.

- [ ] **Step 4: Apply the system mic mode**

```bash
./host/omaremote-setup mic system
```

Expected: an operation id, then `mic mode applied: system`. `DEFAULT_VOICE.mic` stays `"remote"`; `system` is committed to `config.json` by the mic-apply contract, not by changing the default.

Then confirm, and check the known stale-error finding is still only cosmetic:

```bash
omarchy-shell omaremote status | jq '{mic: .mic.last.state, audioDevice, errorCount, lastError}'
```

Expected: `succeeded` and `audioDevice` of `default`. A residual `errorCount: 1` with `"voxtype not responding"` is the Plan 2 carry-over (the plugin's own restart transiently looks unhealthy) and is out of scope here — note it, do not fix it.

- [ ] **Step 5: Verify without root, then with it**

```bash
./host/omaremote-setup verify
```
Expected: binds verified, and the transport sweep explicitly `SKIPPED` with "NOT reporting a pass".

Ask the user to run `! sudo -v && ./host/omaremote-setup verify`
Expected: `transport: every supported key delivered exactly one press and one release`.

- [ ] **Step 6: End-to-end with the real remote**

This is the row the injector cannot cover: it proves the remote's own HID edges and keyd's translation, not just a Hyprland bind on a virtual device.

Ask the user to press every one of the 13 buttons, a short tap and a long hold each, and to try dictation with the microphone button. After each group, read:

```bash
omarchy-shell omaremote status | jq '{lastAction, heldKeys, lastStuckKey, voice: .voice.state}'
```

Expected per the default profile (`lib/Defaults.mjs:36-50`): arrows repeat; `ok` tap `Return` / hold `ctrl+c`; `back` tap `Escape` / hold `BackSpace`; `home` opens `omarchy-menu`; `menu` held 1.5 s resets; `app` switches workspace; volume keys change volume; `power` tap blanks the screen and hold locks; `mic` starts dictation from the system microphone. `heldKeys` must be empty at rest and `lastStuckKey` must stay `null` throughout — a `stuckKey` here means a release is being lost in normal use, which the matrix said would not happen.

**Do not ask for the press inside a running command.** The user only sees a message after the turn ends; end the turn, then read the status in the next one. (This cost two empty 20 s lease windows on 2026-10-02.)

- [ ] **Step 7: Commit**

```bash
git add host/omaremote-setup
git commit -m "feat(host): plugin, mic mode and verification subcommands

omaremote-setup is now complete end to end and has been run on this host.

verify refuses to claim a pass it did not earn: without root the injector
cannot write /dev/uinput, so the transport sweep is reported as SKIPPED
rather than silently omitted from a successful-looking run.

mic reaches 'system' through the main spec §3 apply contract, polling
micStatus to a terminal state; DEFAULT_VOICE.mic stays 'remote' and the
mode is committed to config.json by the contract."
```

---

### Task 9: Correct the main spec

Seven passages in the main spec are now known to be wrong or incomplete. Leaving them is worse than having never written them: the next reader would implement against text that live measurement has already disproved.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-14-omaremote-design.md` — §2, §3 (Hyprland, Voxtype), §4.1, §4.3, §5.2, §7 steps 2, 5, 6
- Modify: `docs/superpowers/specs/2026-10-02-omaremote-host-setup-design.md` (mark §9 applied)

- [ ] **Step 1: Apply the seven corrections**

Work through design spec §9's table, which names each location and the replacement:

1. **§3 Hyprland** — delete "`hl.dsp.global` requests the release event itself, so a single bind delivers press and release". Replace with Task 6's measured verdict and a pointer to `docs/hw-keymap-xiaomi-voice-remote.md`. Add that modifier combos are never used, because the modmask stops matching once the modifier is released first.
2. **§2 and §7 step 6** — replace `wtype -P <neutral> -s 100 -p <neutral>` with `tests/inject-key.py`. State that `wtype` cannot trigger Hyprland binds on this host and that `hyprctl keyword bind` fails under the non-legacy parser.
3. **§7 step 2** — `keyd -m` is not a keyd 2.6.0 subcommand; it is `keyd monitor`. Add the `[ids]` explicit-list guarantee, the `backspace+escape+enter` rescue, and foreground-validation-before-enable.
4. **§3 Voxtype and §7 step 5** — `systemctl show --property=A,B,C --value` prints in systemd's own order; the host parses `Key=Value` lines without `--value`. Job format is `<id> <type>`.
5. **§5.2** — the shell-exit best-effort `voxtype record cancel` is a host obligation, implemented in `Service.qml`'s `Component.onDestruction`.
6. **§4.1 and §4.3** — add `timing.stuckMs`, the `stuckKey` effect, the floor that keeps it above every other key timer, and that a lost release is bounded rather than permanent. Record the 10 s default as an accepted tradeoff, not a latent bug: a user holding a direction key past the bound sees the repeat stream stop, and the remedy is raising `timing.stuckMs`.
7. **§7 step 6** — the lease length is caller-chosen, defaults to 120 s with a 600 s cap, and `arm`'s `busy` carries a `detail` naming the blocker.

- [ ] **Step 2: Check nothing stale survives**

```bash
cd /home/kehao/Projects/omaremote
grep -n 'wtype -P\|keyd -m\|--value\|single bind delivers' docs/superpowers/specs/2026-09-14-omaremote-design.md || echo "no stale text"
grep -n 'stuckMs\|stuckKey' docs/superpowers/specs/2026-09-14-omaremote-design.md | head
```

Expected: `no stale text`, and `stuckMs`/`stuckKey` now present in §4.

- [ ] **Step 3: Mark the corrections applied**

In `docs/superpowers/specs/2026-10-02-omaremote-host-setup-design.md`, add a line under the §9 heading recording that all seven were applied, with the commit date, so a later reader does not re-apply them.

- [ ] **Step 4: Run the full suite**

Run: `make check`
Expected: every unit suite passing, lint clean, and all integration scenarios passing with the four added in Tasks 2 and 3.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-14-omaremote-design.md docs/superpowers/specs/2026-10-02-omaremote-host-setup-design.md
git commit -m "docs(spec): correct the seven passages Plan 2 and Plan 3 disproved

Leaving these would be worse than never having written them: the next
reader would implement against text that live measurement has already
disproved. Most consequential is §3's claim that one hl.bind delivers both
edges, which drove the original bind design.

Also corrects keyd -m (not a 2.6.0 subcommand), the systemctl show key
order that caused Plan 2's one critical finding, and adds timing.stuckMs
and the stuckKey effect to §4, which said nothing about a lost release."
```
