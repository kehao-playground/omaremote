# OmaRemote Core Library Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and fully test the pure-JavaScript core of the OmaRemote Omarchy plugin — key-mapping engine, voice-session state machine, mic-apply transaction, parsers, doctor rules, self-test recorder — with no Omarchy, Hyprland or hardware required.

**Architecture:** Every piece of logic lives in `lib/*.mjs` ES modules that take explicit time (`now` in ms) and return **effects** (plain objects) instead of spawning processes or touching QML. Qt 6 QML imports `.mjs` modules directly, so the same files run under `node --test` here and inside `omarchy-shell` later. Plan 2 wires these modules to Quickshell `Process`/`GlobalShortcut`/`IpcHandler` adapters; Plan 3 writes the host setup script. No module under `lib/` spawns a process or reads the environment; the only external commands in this plan are repository housekeeping in Task 1 (license download) and `node --test`.

**Tech Stack:** Node.js ≥ 20 (`node --test`, `node:assert/strict`), ES modules (`.mjs`, no npm dependencies), GNU Make. Target runtime later: Qt 6 QML JavaScript. Qt 6 documents `.mjs` ES-module imports from QML, but the exact engine level is **verified in Plan 2 task 0** (load a minimal `.mjs` with named exports inside `omarchy-shell`; confirm `Map`, `Set`, object spread, default parameters, template literals, `Array.prototype.includes`). Until then `lib/` avoids anything newer than ES2018 (no optional catch binding, no `??`/`?.`/`??=`, no top-level await, no Node APIs).

**Spec:** `docs/superpowers/specs/2026-09-14-omaremote-design.md` — sections referenced as §N below. Read §4 (engine), §5 (voice session), §3 "Mic apply contract", §6.2 item 4 (doctor rows) and §7 step 6 (self-test) before starting.

## Global Constraints

- Plugin id `io.github.kehao-chen.omaremote`; global-shortcut appid `omaremote`; IPC target `omaremote` (§2).
- Logical key names, exactly: `up down left right ok back home menu app volup voldown power mic` (§4.1).
- Default timing: `holdMs 350`, `doubleMs 250`, `repeatMs 80`, `panicMs 1500` (§4.2). Default voice: `mic "remote"`, `maxSessionSec 60`, `startTimeoutMs 1500`, `arbitrationMs 250`, `stopTimeoutMs 15000`, `hud true`, `actionFlash true` (§4.2).
- `panic` is mutually exclusive with `hold` and `repeat` on one key; a violating key falls back to `tap`-only and is reported (§4.2).
- Required learnable keys: `up down left right ok back`; panic fallback order `home, app, power, back` (§7 step 2).
- Neutral key pool: `up→f13 down→f14 left→f15 right→f16 ok→f17 back→f18 home→f19 menu→f20 app→f21 volup→f22 voldown→f23 power→f24 mic→prog1` (keyd names) with Hyprland keysyms `F13…F24`, `XF86Tools` (§3).
- Action types are a closed union: `key | dispatch | volume | media | screen | none` (§4.4). No free-form shell.
- Voice commands are exactly `voxtype record start|stop|cancel`; panic/abort never issues `stop` (§4.3, §5.2).
- Voxtype status classes: `idle | recording | transcribing | stopped`; a `streaming` class (streaming-transcription builds) is normalized to `recording`; unknown classes are "not idle", never idle (§3 Voxtype).
- `lib/` files must not import Node built-ins (`fs`, `child_process`, …) — QML cannot load them. Tests may.
- Every code file starts with a one-line comment naming the spec section it implements.
- Commit after every task with the message shown; append whatever attribution trailer your harness requires, if any.

## File Structure

```
OmaRemote/                          # repo root == plugin root (§2)
├── manifest.json                   # Omarchy plugin manifest (bar-widget + service, keepLoaded)
├── package.json                    # "type": "module", test script only, zero deps
├── Makefile                        # make test / make lint / make check
├── LICENSE                         # GPL-3.0
├── .gitignore
├── README.md                       # stub; expanded in Plan 3
├── lib/
│   ├── Defaults.mjs                # constants + DEFAULT_CONFIG (§4.2, §4.5, §3 neutral keys)
│   ├── Config.mjs                  # normalizeConfig(raw) → {config, problems}
│   ├── KeyEngine.mjs               # per-key state machine, explicit time, effects (§4.3)
│   ├── Actions.mjs                 # action validation + argv/dispatch mapping (§4.4)
│   ├── Dbus.mjs                    # busctl --json=short signal parser, property parser (§5.1)
│   ├── VoxStatus.mjs               # voxtype status JSON → class (§3 Voxtype)
│   ├── VoiceSession.mjs            # §5 state machine, effects-based
│   ├── MicApply.mjs                # §3 mic apply contract, effects-based
│   ├── SelfTest.mjs                # §7 step 6 lease + recorder + report
│   ├── Stats.mjs                   # §5.5 aggregation
│   └── Doctor.mjs                  # §6.2 item 4 rules: facts → rows
└── tests/
    ├── helpers.mjs                 # fake clock + effect collectors
    ├── Config.test.mjs
    ├── KeyEngine.test.mjs
    ├── Actions.test.mjs
    ├── Dbus.test.mjs
    ├── VoxStatus.test.mjs
    ├── VoiceSession.test.mjs
    ├── MicApply.test.mjs
    ├── SelfTest.test.mjs
    ├── Stats.test.mjs
    └── Doctor.test.mjs
```

Responsibilities are one-per-file. `VoiceSession.mjs` is the largest (≈400 lines); it is split across three tasks but stays one file because its states share one transition table.

**Effect convention (used by KeyEngine, VoiceSession, MicApply, SelfTest):** every input method returns an array of effect objects. Effects are plain data: `{ type: "cmd", id, argv }`, `{ type: "hud", text }`, `{ type: "state", state, owner }`, `{ type: "action", key, trigger, action }`, `{ type: "reset" }`, `{ type: "error", reason }`, `{ type: "poll" }`, `{ type: "readAtv" }`, `{ type: "micClose" }`, `{ type: "restart" }`, `{ type: "stat", session }`. The QML host executes them; tests assert on them. Each module also exposes `nextDeadline()` (ms or `null`) and `advance(now)` so a single host `Timer` can drive all timeouts.

---

### Task 1: Repository scaffold and test harness

**Files:**
- Create: `package.json`, `manifest.json`, `Makefile`, `.gitignore`, `README.md`, `tests/helpers.mjs`, `tests/helpers.test.mjs`
- Create: `LICENSE` (downloaded)

**Interfaces:**
- Produces: `tests/helpers.mjs` exporting `createClock(start = 0)` → `{ now(), tick(ms) }` and `byType(effects, type)` → filtered array. Every later test imports these.

- [ ] **Step 1: Write the failing helper test**

`tests/helpers.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock, byType } from "./helpers.mjs";

test("clock starts at 0 and ticks forward", () => {
  const c = createClock();
  assert.equal(c.now(), 0);
  c.tick(350);
  assert.equal(c.now(), 350);
});

test("byType filters effects", () => {
  const fx = [{ type: "hud", text: "a" }, { type: "cmd", id: 1 }, { type: "hud", text: "b" }];
  assert.deepEqual(byType(fx, "hud").map(e => e.text), ["a", "b"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test "tests/*.test.mjs"`
Expected: FAIL — `Cannot find module './helpers.mjs'`

- [ ] **Step 3: Create scaffold files**

`package.json`:
```json
{
  "name": "omaremote",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Omarchy Quickshell plugin turning ATVV Bluetooth voice remotes into a couch controller",
  "license": "GPL-3.0-only",
  "scripts": {
    "test": "node --test \"tests/*.test.mjs\""
  },
  "engines": { "node": ">=20" }
}
```

`manifest.json` (Omarchy plugin manifest, §2; `keepLoaded` so the IPC target exists at shell start):
```json
{
  "schemaVersion": 1,
  "id": "io.github.kehao-chen.omaremote",
  "name": "OmaRemote",
  "version": "0.1.0",
  "author": "Kehao Chen",
  "license": "GPL-3.0-only",
  "homepage": "https://github.com/kehao-playground/omaremote",
  "category": "Input",
  "description": "ATVV Bluetooth voice remote as couch controller: push-to-talk via Voxtype and a 13-key mapping engine.",
  "kinds": ["bar-widget", "service"],
  "keepLoaded": true,
  "entryPoints": {
    "barWidget": "BarWidget.qml",
    "service": "Service.qml"
  },
  "barWidget": {
    "displayName": "OmaRemote",
    "category": "Input",
    "allowMultiple": false,
    "defaultSection": "right"
  }
}
```

`Makefile`:
```make
.PHONY: test lint check
test:
	node --test "tests/*.test.mjs"

# qmllint and omarchy are only present on an Omarchy host; skip gracefully elsewhere.
lint:
	@if command -v qmllint >/dev/null 2>&1; then qmllint -I "$${OMARCHY_PATH:-/usr/share/omarchy}/shell" *.qml components/*.qml; else echo "qmllint not found - skipped"; fi
	@if command -v omarchy >/dev/null 2>&1; then omarchy plugin validate .; else echo "omarchy CLI not found - skipped"; fi

check: test lint
```

`.gitignore`:
```
node_modules/
*.log
.DS_Store
```

`README.md`:
```markdown
# OmaRemote

Omarchy Quickshell plugin that turns an ATVV-class Bluetooth voice remote (G20S Pro family, Xiaomi Remote 2 Pro once verified) into a couch controller: push-to-talk dictation through Voxtype and a configurable 13-key mapping engine.

Design: `docs/superpowers/specs/2026-09-14-omaremote-design.md`.

## Development

    make test      # node --test "tests/*.test.mjs"
    make check     # + qmllint / omarchy plugin validate when available

License: GPL-3.0-only.
```

`tests/helpers.mjs`:
```js
// Test helpers: deterministic clock and effect filters shared by all suites.
export function createClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    tick: (ms) => { t += ms; return t; },
  };
}

export function byType(effects, type) {
  return effects.filter(e => e.type === type);
}

export function last(effects, type) {
  const list = byType(effects, type);
  return list.length ? list[list.length - 1] : undefined;
}
```

Repository action (network): `curl -sSL https://www.gnu.org/licenses/gpl-3.0.txt -o LICENSE` and confirm the first line reads `GNU GENERAL PUBLIC LICENSE`. Offline fallback: copy an existing GPL-3.0 text (`/usr/share/licenses/common/GPL3/license.txt` on Arch) or leave `LICENSE` out of this commit and add it in a later one — do not block the task on it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `make test`
Expected: `# pass 2`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add package.json manifest.json Makefile .gitignore README.md LICENSE tests/helpers.mjs tests/helpers.test.mjs
git commit -m "chore: scaffold plugin repo and node test harness"
```

---

### Task 2: Defaults and config normalization

**Files:**
- Create: `lib/Defaults.mjs`, `lib/Config.mjs`
- Test: `tests/Config.test.mjs`

**Interfaces:**
- Produces `lib/Defaults.mjs`: `KEY_NAMES` (array of 13), `REQUIRED_KEYS`, `PANIC_FALLBACK_ORDER`, `NEUTRAL_KEYS` (`{ up: { keyd: "f13", keysym: "F13" }, … mic: { keyd: "prog1", keysym: "XF86Tools" } }`), `DEFAULT_TIMING`, `DEFAULT_VOICE`, `DEFAULT_KEYS`, `DEFAULT_CONFIG`.
- Produces `lib/Config.mjs`: `normalizeConfig(raw)` → `{ config, problems }` where `problems` is `[{ key?, code, message }]`; `keyClass(keyCfg)` → `{ long, panic, double, simple }`.

- [ ] **Step 1: Write the failing tests**

`tests/Config.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, keyClass } from "../lib/Config.mjs";
import { DEFAULT_CONFIG, KEY_NAMES, NEUTRAL_KEYS } from "../lib/Defaults.mjs";

test("defaults normalize with no problems and all 13 keys present", () => {
  const { config, problems } = normalizeConfig(DEFAULT_CONFIG);
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(config.keys).sort(), [...KEY_NAMES].sort());
  assert.equal(config.timing.holdMs, 350);
  assert.equal(config.voice.arbitrationMs, 250);
});

test("null / non-object input yields defaults plus a config-invalid problem", () => {
  const { config, problems } = normalizeConfig(null);
  assert.equal(config.timing.panicMs, 1500);
  assert.equal(problems[0].code, "config-invalid");
});

test("panic is exclusive with hold/repeat: key falls back to tap-only and is reported", () => {
  const raw = { ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys,
    menu: { tap: { type: "key", keys: "Tab" }, hold: { type: "key", keys: "Escape" }, panic: true, repeat: true } } };
  const { config, problems } = normalizeConfig(raw);
  assert.equal(config.keys.menu.hold, undefined);
  assert.equal(config.keys.menu.repeat, false);
  assert.equal(config.keys.menu.panic, true);
  assert.equal(problems.find(p => p.key === "menu").code, "panic-exclusive");
});

test("unknown top-level and per-key fields are preserved", () => {
  const raw = { ...DEFAULT_CONFIG, extra: { a: 1 }, keys: { ...DEFAULT_CONFIG.keys, ok: { ...DEFAULT_CONFIG.keys.ok, note: "x" } } };
  const { config } = normalizeConfig(raw);
  assert.deepEqual(config.extra, { a: 1 });
  assert.equal(config.keys.ok.note, "x");
});

test("supported defaults to true and can be false; missing keys are filled from defaults", () => {
  const raw = { ...DEFAULT_CONFIG, keys: { app: { supported: false } } };
  const { config } = normalizeConfig(raw);
  assert.equal(config.keys.app.supported, false);
  assert.equal(config.keys.up.supported, true);
  assert.equal(config.keys.up.repeat, true);
});

test("no supported panic key is reported", () => {
  const raw = { ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, menu: { ...DEFAULT_CONFIG.keys.menu, supported: false } } };
  const { problems } = normalizeConfig(raw);
  assert.ok(problems.some(p => p.code === "no-panic-key"));
});

test("invalid action on a key is dropped and reported", () => {
  const raw = { ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, ok: { tap: { type: "shell", cmd: "rm" } } } };
  const { config, problems } = normalizeConfig(raw);
  assert.equal(config.keys.ok.tap, undefined);
  assert.equal(problems.find(p => p.key === "ok").code, "action-invalid");
});

test("keyClass classifies keys", () => {
  assert.deepEqual(keyClass({ tap: { type: "none" } }), { long: false, panic: false, double: false, simple: true });
  assert.deepEqual(keyClass({ tap: { type: "none" }, repeat: true }), { long: true, panic: false, double: false, simple: false });
  assert.deepEqual(keyClass({ tap: { type: "none" }, panic: true, double: { type: "none" } }), { long: false, panic: true, double: true, simple: false });
});

test("neutral key table covers all 13 keys with unique keyd names", () => {
  const names = KEY_NAMES.map(k => NEUTRAL_KEYS[k].keyd);
  assert.equal(new Set(names).size, 13);
  assert.equal(NEUTRAL_KEYS.mic.keysym, "XF86Tools");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/Config.test.mjs`
Expected: FAIL — `Cannot find module '../lib/Config.mjs'`

- [ ] **Step 3: Write Defaults.mjs**

`lib/Defaults.mjs`:
```js
// Spec §3 (neutral keys), §4.2 (schema defaults), §4.5 (default profile), §7 step 2 (learning rules).
export const KEY_NAMES = ["up", "down", "left", "right", "ok", "back", "home", "menu", "app", "volup", "voldown", "power", "mic"];
export const REQUIRED_KEYS = ["up", "down", "left", "right", "ok", "back"];
export const PANIC_FALLBACK_ORDER = ["home", "app", "power", "back"];

export const NEUTRAL_KEYS = {
  up:      { keyd: "f13", keysym: "F13" },
  down:    { keyd: "f14", keysym: "F14" },
  left:    { keyd: "f15", keysym: "F15" },
  right:   { keyd: "f16", keysym: "F16" },
  ok:      { keyd: "f17", keysym: "F17" },
  back:    { keyd: "f18", keysym: "F18" },
  home:    { keyd: "f19", keysym: "F19" },
  menu:    { keyd: "f20", keysym: "F20" },
  app:     { keyd: "f21", keysym: "F21" },
  volup:   { keyd: "f22", keysym: "F22" },
  voldown: { keyd: "f23", keysym: "F23" },
  power:   { keyd: "f24", keysym: "F24" },
  mic:     { keyd: "prog1", keysym: "XF86Tools" },
};

export const DEFAULT_TIMING = { holdMs: 350, doubleMs: 250, repeatMs: 80, panicMs: 1500 };

export const DEFAULT_VOICE = {
  mic: "remote",
  maxSessionSec: 60,
  startTimeoutMs: 1500,
  arbitrationMs: 250,
  stopTimeoutMs: 15000,
  hud: true,
  actionFlash: true,
};

const key = (keys) => ({ type: "key", keys });

export const DEFAULT_KEYS = {
  up:      { tap: key("Up"),    repeat: true },
  down:    { tap: key("Down"),  repeat: true },
  left:    { tap: key("Left"),  repeat: true },
  right:   { tap: key("Right"), repeat: true },
  ok:      { tap: key("Return"), hold: key("ctrl+c") },
  back:    { tap: key("Escape"), hold: key("BackSpace") },
  home:    { tap: { type: "dispatch", dispatcher: "exec", arg: "omarchy-menu" } },
  menu:    { tap: key("Tab"), panic: true },
  app:     { tap: { type: "dispatch", dispatcher: "workspace", arg: "e+1" } },
  volup:   { tap: { type: "volume", delta: "+5" }, repeat: true },
  voldown: { tap: { type: "volume", delta: "-5" }, repeat: true },
  power:   { tap: { type: "screen", cmd: "off" }, hold: { type: "screen", cmd: "lock" } },
  mic:     { ptt: true },
};

export const DEFAULT_CONFIG = {
  version: 1,
  device: { vendor: "", product: "", name: "", learned: {} },
  timing: { ...DEFAULT_TIMING },
  keys: DEFAULT_KEYS,
  voice: { ...DEFAULT_VOICE },
};
```

- [ ] **Step 4: Write Config.mjs**

`lib/Config.mjs`:
```js
// Spec §4.2: config schema, validation rules (panic exclusivity, supported flag, unknown-field preservation).
import { DEFAULT_CONFIG, DEFAULT_KEYS, DEFAULT_TIMING, DEFAULT_VOICE, KEY_NAMES } from "./Defaults.mjs";
import { validateAction } from "./Actions.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function keyClass(k) {
  const long = !!(k.hold || k.repeat);
  const panic = !!k.panic;
  const double = !!k.double;
  return { long, panic, double, simple: !long && !panic && !double };
}

function normalizeKey(name, raw, problems) {
  const base = DEFAULT_KEYS[name] || {};
  const src = isObj(raw) ? raw : base;
  const out = { ...src };            // preserve unknown fields
  for (const trig of ["tap", "hold", "double"]) {
    if (src[trig] === undefined) continue;
    const errs = validateAction(src[trig]);
    if (errs.length) {
      problems.push({ key: name, code: "action-invalid", message: `${name}.${trig}: ${errs.join("; ")}` });
      delete out[trig];
    }
  }
  out.repeat = src.repeat === true;
  out.panic = src.panic === true;
  out.supported = src.supported !== false;
  if (name === "mic") out.ptt = src.ptt !== false;
  if (out.panic && (out.hold || out.repeat)) {
    problems.push({ key: name, code: "panic-exclusive", message: `${name}: panic cannot combine with hold/repeat; using tap only` });
    delete out.hold;
    out.repeat = false;
  }
  return out;
}

export function normalizeConfig(raw) {
  const problems = [];
  if (!isObj(raw)) {
    problems.push({ code: "config-invalid", message: "config is not an object; using defaults" });
    raw = {};
  }
  const config = { ...raw };
  config.version = 1;
  config.device = { ...DEFAULT_CONFIG.device, ...(isObj(raw.device) ? raw.device : {}) };
  const t = isObj(raw.timing) ? raw.timing : {};
  config.timing = { ...t };
  for (const k of Object.keys(DEFAULT_TIMING)) config.timing[k] = num(t[k], DEFAULT_TIMING[k]);
  const v = isObj(raw.voice) ? raw.voice : {};
  config.voice = { ...v };
  for (const k of ["maxSessionSec", "startTimeoutMs", "arbitrationMs", "stopTimeoutMs"]) config.voice[k] = num(v[k], DEFAULT_VOICE[k]);
  config.voice.mic = v.mic === "system" ? "system" : "remote";
  config.voice.hud = v.hud !== false;
  config.voice.actionFlash = v.actionFlash !== false;

  const rawKeys = isObj(raw.keys) ? raw.keys : {};
  config.keys = {};
  for (const name of KEY_NAMES) config.keys[name] = normalizeKey(name, rawKeys[name], problems);
  for (const extra of Object.keys(rawKeys)) if (!KEY_NAMES.includes(extra)) config.keys[extra] = rawKeys[extra];

  if (!KEY_NAMES.some(n => config.keys[n].panic && config.keys[n].supported)) {
    problems.push({ code: "no-panic-key", message: "no supported key has panic: true (§4.3 escape hatch)" });
  }
  return { config, problems };
}
```

`validateAction` does not exist yet — create a minimal `lib/Actions.mjs` now (Task 6 completes it):
```js
// Spec §4.4: closed action union. Task 6 adds argv mapping.
export const ACTION_TYPES = ["key", "dispatch", "volume", "media", "screen", "none"];

export function validateAction(a) {
  const errs = [];
  if (a === null || typeof a !== "object") return ["action must be an object"];
  if (!ACTION_TYPES.includes(a.type)) return [`unknown action type "${a.type}"`];
  switch (a.type) {
    case "key": if (typeof a.keys !== "string" || !a.keys.trim()) errs.push("key.keys must be a non-empty string"); break;
    case "dispatch": if (typeof a.dispatcher !== "string" || !a.dispatcher) errs.push("dispatch.dispatcher required"); break;
    case "volume": if (!["+5", "-5", "mute"].includes(a.delta)) errs.push("volume.delta must be +5, -5 or mute"); break;
    case "media": if (!["play-pause", "next", "previous"].includes(a.cmd)) errs.push("media.cmd invalid"); break;
    case "screen": if (!["off", "lock"].includes(a.cmd)) errs.push("screen.cmd must be off or lock"); break;
    default: break;
  }
  return errs;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/Config.test.mjs`
Expected: `# pass 9`, `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add lib/Defaults.mjs lib/Config.mjs lib/Actions.mjs tests/Config.test.mjs
git commit -m "feat(core): defaults and config normalization with panic exclusivity"
```

---

### Task 3: KeyEngine — simple, long and panic keys

**Files:**
- Create: `lib/KeyEngine.mjs`
- Test: `tests/KeyEngine.test.mjs`

**Interfaces:**
- Produces `createKeyEngine(config)` → engine with:
  - `press(name, now)` / `release(name, now)` / `advance(now)` → effects array
  - `nextDeadline()` → ms or `null`
  - `reset()` → effects (`[{ type: "reset" }]`), `reload(config)` → `[]`
  - `heldKeys()` → array of key names currently not idle (used by SelfTest arming)
  - Effects: `{ type: "action", key, trigger: "tap"|"hold"|"double", repeat: boolean, action }` and `{ type: "reset" }`.
- Consumes: `normalizeConfig`, `keyClass` from Task 2.

- [ ] **Step 1: Write the failing tests**

`tests/KeyEngine.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyEngine } from "../lib/KeyEngine.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";
import { byType } from "./helpers.mjs";

function engine(overrideKeys = {}) {
  const raw = { ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, ...overrideKeys } };
  return createKeyEngine(normalizeConfig(raw).config);
}
const acts = (fx) => byType(fx, "action").map(a => `${a.key}:${a.trigger}${a.repeat ? "*" : ""}`);

test("simple key (home) fires tap on press; release and long hold are ignored", () => {
  const e = engine();
  assert.deepEqual(acts(e.press("home", 0)), ["home:tap"]);
  assert.deepEqual(acts(e.advance(5000)), []);
  assert.deepEqual(acts(e.release("home", 5000)), []);
  assert.equal(e.nextDeadline(), null);
});

test("long key (ok): release before holdMs emits tap", () => {
  const e = engine();
  assert.deepEqual(acts(e.press("ok", 0)), []);
  assert.equal(e.nextDeadline(), 350);
  assert.deepEqual(acts(e.release("ok", 349)), ["ok:tap"]);
  assert.equal(e.nextDeadline(), null);
});

test("long key (ok): hold fires at holdMs, release afterwards emits nothing", () => {
  const e = engine();
  e.press("ok", 0);
  assert.deepEqual(acts(e.advance(350)), ["ok:hold"]);
  assert.deepEqual(acts(e.release("ok", 1000)), []);
});

test("release exactly at holdMs counts as hold, not tap", () => {
  const e = engine();
  e.press("ok", 0);
  const fx = e.release("ok", 350);
  assert.deepEqual(acts(fx), ["ok:hold"]);
});

test("hold action carries the configured action object", () => {
  const e = engine();
  e.press("ok", 0);
  const hold = byType(e.advance(350), "action")[0];
  assert.deepEqual(hold.action, { type: "key", keys: "ctrl+c" });
});

test("panic key (menu): release before panicMs emits tap even after 350ms", () => {
  const e = engine();
  e.press("menu", 0);
  assert.deepEqual(acts(e.advance(1499)), []);
  assert.deepEqual(acts(e.release("menu", 1499)), ["menu:tap"]);
});

test("panic key held to panicMs emits reset and clears every key", () => {
  const e = engine();
  e.press("ok", 0);
  e.press("menu", 10);
  assert.deepEqual(acts(e.advance(400)), ["ok:hold"]);   // ok's own hold fires first, as the host timer would
  const fx = e.advance(1510);
  assert.deepEqual(byType(fx, "reset").length, 1);
  assert.deepEqual(acts(fx), []);
  assert.deepEqual(e.heldKeys(), []);
  assert.deepEqual(acts(e.release("menu", 1600)), []);
  assert.deepEqual(acts(e.release("ok", 1600)), []);
});

test("unsupported key events are ignored", () => {
  const e = engine({ app: { supported: false, tap: { type: "none" } } });
  assert.deepEqual(e.press("app", 0), []);
});

test("unknown key names are ignored", () => {
  const e = engine();
  assert.deepEqual(e.press("nope", 0), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/KeyEngine.test.mjs`
Expected: FAIL — `Cannot find module '../lib/KeyEngine.mjs'`

- [ ] **Step 3: Write KeyEngine.mjs (simple/long/panic paths; double and repeat come in Tasks 4–5 but the structure is complete now)**

`lib/KeyEngine.mjs`:
```js
// Spec §4.3: per-key state machine. Pure: explicit `now`, returns effects, never spawns.
import { keyClass } from "./Config.mjs";
import { KEY_NAMES } from "./Defaults.mjs";

// phases: idle | down | held | repeating | waitDouble | consumeRelease
export function createKeyEngine(initialConfig) {
  let config = initialConfig;
  const st = {};                       // name -> { phase, deadline, pressedAt, releasedAt }
  const fresh = () => ({ phase: "idle", deadline: null, pressedAt: 0, releasedAt: 0 });
  const init = () => { for (const n of KEY_NAMES) st[n] = fresh(); };
  init();

  const cfg = (n) => config.keys[n];
  const timing = () => config.timing;
  const action = (n, trigger, act, repeat = false) => ({ type: "action", key: n, trigger, repeat, action: act });

  function clearAll() { init(); }

  function fire(n, now, out) {           // timer for key n is due
    const s = st[n], k = cfg(n), c = keyClass(k);
    s.deadline = null;
    if (s.phase === "down") {
      if (c.panic) { clearAll(); out.push({ type: "reset" }); return; }
      if (c.long) {
        if (k.hold) out.push(action(n, "hold", k.hold));
        if (k.repeat) {
          if (k.tap) out.push(action(n, "tap", k.tap, true));
          s.phase = "repeating"; s.deadline = now + timing().repeatMs;
        } else {
          s.phase = "held";
        }
      }
      return;
    }
    if (s.phase === "repeating") {
      if (k.tap) out.push(action(n, "tap", k.tap, true));
      s.deadline = now + timing().repeatMs;
      return;
    }
    if (s.phase === "waitDouble") {
      if (k.tap) out.push(action(n, "tap", k.tap));
      s.phase = "idle";
    }
  }

  function advance(now) {
    const out = [];
    // fire in deadline order so two due timers resolve deterministically
    let guard = 0;
    for (;;) {
      let best = null;
      for (const n of KEY_NAMES) {
        const s = st[n];
        if (s.deadline !== null && s.deadline <= now && (best === null || s.deadline < st[best].deadline)) best = n;
      }
      if (best === null || guard++ > 1000) break;
      fire(best, st[best].deadline, out);
      if (out.some(e => e.type === "reset")) break;
    }
    return out;
  }

  function resolvePendingDoubles(except, now, out) {
    for (const n of KEY_NAMES) {
      if (n === except) continue;
      const s = st[n];
      if (s.phase === "waitDouble") { s.deadline = null; fire(n, now, out); }
    }
  }

  function press(n, now) {
    const k = cfg(n);
    if (!k || !k.supported) return [];
    const out = advance(now);
    const s = st[n], c = keyClass(k), t = timing();
    if (s.phase === "waitDouble") {
      s.deadline = null;
      if (k.double) out.push(action(n, "double", k.double));
      s.phase = "consumeRelease";
      return out;
    }
    if (s.phase !== "idle") return out;      // key already down: ignore repeat press events
    resolvePendingDoubles(n, now, out);
    s.pressedAt = now;
    if (c.simple) { if (k.tap) out.push(action(n, "tap", k.tap)); return out; }
    s.phase = "down";
    if (c.long) s.deadline = now + t.holdMs;
    else if (c.panic) s.deadline = now + t.panicMs;
    else s.deadline = null;                  // simple+double: no timer while down
    return out;
  }

  function release(n, now) {
    const k = cfg(n);
    if (!k || !k.supported) return [];
    const out = advance(now);
    const s = st[n], t = timing();
    switch (s.phase) {
      case "down":
        s.deadline = null;
        if (k.double) { s.phase = "waitDouble"; s.releasedAt = now; s.deadline = now + t.doubleMs; }
        else { s.phase = "idle"; if (k.tap) out.push(action(n, "tap", k.tap)); }
        break;
      case "held":
      case "repeating":
      case "consumeRelease":
        s.deadline = null; s.phase = "idle"; break;
      default: break;
    }
    return out;
  }

  function nextDeadline() {
    let d = null;
    for (const n of KEY_NAMES) { const s = st[n]; if (s.deadline !== null && (d === null || s.deadline < d)) d = s.deadline; }
    return d;
  }

  return {
    press, release, advance, nextDeadline,
    reset() { clearAll(); return [{ type: "reset" }]; },
    reload(next) { config = next; clearAll(); return []; },
    heldKeys() { return KEY_NAMES.filter(n => st[n].phase !== "idle"); },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/KeyEngine.test.mjs`
Expected: `# pass 9`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/KeyEngine.mjs tests/KeyEngine.test.mjs
git commit -m "feat(core): key engine with simple, long and panic key semantics"
```

---

### Task 4: KeyEngine — repeat, hold+repeat, reload

**Files:**
- Modify: `lib/KeyEngine.mjs` (only if a test fails; the Task 3 code already implements these paths)
- Test: `tests/KeyEngine.test.mjs` (append)

- [ ] **Step 1: Append the failing/confirming tests**

Append to `tests/KeyEngine.test.mjs`:
```js
test("repeat key (up): tap at holdMs then every repeatMs until release", () => {
  const e = engine();
  e.press("up", 0);
  assert.deepEqual(acts(e.advance(350)), ["up:tap*"]);
  assert.equal(e.nextDeadline(), 430);
  assert.deepEqual(acts(e.advance(430)), ["up:tap*"]);
  assert.deepEqual(acts(e.advance(600)), ["up:tap*", "up:tap*"]); // 510, 590
  assert.deepEqual(acts(e.release("up", 620)), []);
  assert.equal(e.nextDeadline(), null);
});

test("repeat key released before holdMs emits a single non-repeat tap", () => {
  const e = engine();
  e.press("up", 0);
  const fx = e.release("up", 100);
  assert.deepEqual(acts(fx), ["up:tap"]);
  assert.equal(byType(fx, "action")[0].repeat, false);
});

test("hold and repeat both bound: hold fires once, then tap repeats", () => {
  const e = engine({ down: { tap: { type: "key", keys: "Down" }, hold: { type: "key", keys: "End" }, repeat: true } });
  e.press("down", 0);
  assert.deepEqual(acts(e.advance(350)), ["down:hold", "down:tap*"]);
  assert.deepEqual(acts(e.advance(430)), ["down:tap*"]);
});

test("reload clears in-flight state without emitting", () => {
  const e = engine();
  e.press("up", 0);
  assert.deepEqual(e.reload(normalizeConfig(DEFAULT_CONFIG).config), []);
  assert.equal(e.nextDeadline(), null);
  assert.deepEqual(acts(e.advance(1000)), []);
  assert.deepEqual(acts(e.release("up", 1000)), []);
});

test("press while already down is ignored (no double-start of timers)", () => {
  const e = engine();
  e.press("ok", 0);
  assert.deepEqual(acts(e.press("ok", 100)), []);
  assert.equal(e.nextDeadline(), 350);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/KeyEngine.test.mjs`
Expected: `# pass 14`, `# fail 0`. If any of the five fail, fix `fire()`/`press()` in `lib/KeyEngine.mjs` until they pass — do not change the tests.

- [ ] **Step 3: Commit**

```bash
git add tests/KeyEngine.test.mjs lib/KeyEngine.mjs
git commit -m "test(core): key engine repeat and reload coverage"
```

---

### Task 5: KeyEngine — double-tap semantics

**Files:**
- Modify: `lib/KeyEngine.mjs` (if needed)
- Test: `tests/KeyEngine.test.mjs` (append)

- [ ] **Step 1: Append the failing tests**

```js
const dbl = () => engine({ ok: { tap: { type: "key", keys: "Return" }, double: { type: "key", keys: "ctrl+Return" } } });

test("double-bound key: single tap is deferred until doubleMs elapses", () => {
  const e = dbl();
  e.press("ok", 0);
  assert.deepEqual(acts(e.release("ok", 50)), []);
  assert.equal(e.nextDeadline(), 300);
  assert.deepEqual(acts(e.advance(299)), []);
  assert.deepEqual(acts(e.advance(300)), ["ok:tap"]);
});

test("double-bound key: second press within doubleMs emits double and consumes its release", () => {
  const e = dbl();
  e.press("ok", 0); e.release("ok", 50);
  assert.deepEqual(acts(e.press("ok", 200)), ["ok:double"]);
  assert.deepEqual(acts(e.release("ok", 260)), []);
  assert.deepEqual(acts(e.advance(1000)), []);
});

test("double-bound key: second press after doubleMs is a new single press", () => {
  const e = dbl();
  e.press("ok", 0); e.release("ok", 50);
  const fx = e.press("ok", 400);                // 300 deadline fires first -> tap, then new press
  assert.deepEqual(acts(fx), ["ok:tap"]);
  assert.deepEqual(acts(e.release("ok", 450)), []); // now waiting for a possible double again
  assert.deepEqual(acts(e.advance(700)), ["ok:tap"]);
});

test("double + long key: hold still fires while down; release after hold emits nothing", () => {
  const e = engine({ ok: { tap: { type: "key", keys: "Return" }, hold: { type: "key", keys: "ctrl+c" }, double: { type: "key", keys: "ctrl+Return" } } });
  e.press("ok", 0);
  assert.deepEqual(acts(e.advance(350)), ["ok:hold"]);
  assert.deepEqual(acts(e.release("ok", 400)), []);
});

test("pressing another key resolves a pending double as tap first (no cross-key doubles)", () => {
  const e = dbl();
  e.press("ok", 0); e.release("ok", 50);
  const fx = e.press("home", 100);
  assert.deepEqual(acts(fx), ["ok:tap", "home:tap"]);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/KeyEngine.test.mjs`
Expected: `# pass 19`, `# fail 0`. Fix `press()`/`fire()` if any fail.

- [ ] **Step 3: Commit**

```bash
git add tests/KeyEngine.test.mjs lib/KeyEngine.mjs
git commit -m "feat(core): key engine double-tap semantics"
```

---

### Task 6: Actions — argv and dispatch mapping

**Files:**
- Modify: `lib/Actions.mjs`
- Test: `tests/Actions.test.mjs`

**Interfaces:**
- Produces: `parseKeys(str)` → `{ mods: string[], key: string }` (mods lowercased from `ctrl|shift|alt|super|meta`), `toArgv(action)` → `{ kind: "process", argv: string[] } | { kind: "dispatch", cmd: string } | { kind: "none" }`, `describe(action)` → short label for HUD flashes (e.g. `Ctrl+C`).

- [ ] **Step 1: Write the failing tests**

`tests/Actions.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeys, toArgv, validateAction, describe } from "../lib/Actions.mjs";

test("parseKeys splits modifiers and key, case-insensitive modifiers", () => {
  assert.deepEqual(parseKeys("Ctrl+Shift+Return"), { mods: ["ctrl", "shift"], key: "Return" });
  assert.deepEqual(parseKeys("Up"), { mods: [], key: "Up" });
  assert.deepEqual(parseKeys("ctrl+c"), { mods: ["ctrl"], key: "c" });
});

test("key action maps to wtype with press/release modifier pairs in reverse order", () => {
  assert.deepEqual(toArgv({ type: "key", keys: "ctrl+shift+Return" }),
    { kind: "process", argv: ["wtype", "-M", "ctrl", "-M", "shift", "-k", "Return", "-m", "shift", "-m", "ctrl"] });
  assert.deepEqual(toArgv({ type: "key", keys: "Up" }), { kind: "process", argv: ["wtype", "-k", "Up"] });
});

test("dispatch action is a Hyprland dispatch string, no process", () => {
  assert.deepEqual(toArgv({ type: "dispatch", dispatcher: "workspace", arg: "e+1" }), { kind: "dispatch", cmd: "workspace e+1" });
  assert.deepEqual(toArgv({ type: "dispatch", dispatcher: "fullscreen" }), { kind: "dispatch", cmd: "fullscreen" });
});

test("volume, media and screen map to documented tools", () => {
  assert.deepEqual(toArgv({ type: "volume", delta: "+5" }).argv, ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%+"]);
  assert.deepEqual(toArgv({ type: "volume", delta: "-5" }).argv, ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"]);
  assert.deepEqual(toArgv({ type: "volume", delta: "mute" }).argv, ["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"]);
  assert.deepEqual(toArgv({ type: "media", cmd: "play-pause" }).argv, ["playerctl", "play-pause"]);
  assert.deepEqual(toArgv({ type: "screen", cmd: "off" }).argv, ["hyprctl", "dispatch", "dpms", "off"]);
  assert.deepEqual(toArgv({ type: "screen", cmd: "lock" }).argv, ["omarchy-lock-screen"]);
  assert.deepEqual(toArgv({ type: "none" }), { kind: "none" });
});

test("invalid actions are rejected by validateAction and mapped to none", () => {
  assert.ok(validateAction({ type: "shell", cmd: "rm" }).length > 0);
  assert.ok(validateAction({ type: "key", keys: "" }).length > 0);
  assert.deepEqual(toArgv({ type: "shell", cmd: "rm" }), { kind: "none" });
});

test("describe gives a short human label", () => {
  assert.equal(describe({ type: "key", keys: "ctrl+c" }), "Ctrl+C");
  assert.equal(describe({ type: "dispatch", dispatcher: "workspace", arg: "e+1" }), "workspace e+1");
  assert.equal(describe({ type: "volume", delta: "+5" }), "Volume +5");
  assert.equal(describe({ type: "screen", cmd: "lock" }), "Lock screen");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/Actions.test.mjs`
Expected: FAIL — `parseKeys is not exported` / similar.

- [ ] **Step 3: Complete Actions.mjs**

Replace `lib/Actions.mjs` with:
```js
// Spec §4.4: closed action union; argv/dispatch mapping is data so it can be tested without spawning.
export const ACTION_TYPES = ["key", "dispatch", "volume", "media", "screen", "none"];
const MODS = ["ctrl", "shift", "alt", "super", "meta"];

export function validateAction(a) {
  const errs = [];
  if (a === null || typeof a !== "object") return ["action must be an object"];
  if (!ACTION_TYPES.includes(a.type)) return [`unknown action type "${a.type}"`];
  switch (a.type) {
    case "key": if (typeof a.keys !== "string" || !a.keys.trim()) errs.push("key.keys must be a non-empty string"); break;
    case "dispatch": if (typeof a.dispatcher !== "string" || !a.dispatcher) errs.push("dispatch.dispatcher required"); break;
    case "volume": if (!["+5", "-5", "mute"].includes(a.delta)) errs.push("volume.delta must be +5, -5 or mute"); break;
    case "media": if (!["play-pause", "next", "previous"].includes(a.cmd)) errs.push("media.cmd invalid"); break;
    case "screen": if (!["off", "lock"].includes(a.cmd)) errs.push("screen.cmd must be off or lock"); break;
    default: break;
  }
  return errs;
}

export function parseKeys(str) {
  const parts = String(str).split("+").map(s => s.trim()).filter(Boolean);
  const mods = [];
  let key = "";
  for (const p of parts) {
    const low = p.toLowerCase();
    if (MODS.includes(low)) mods.push(low); else key = p;
  }
  return { mods, key };
}

export function toArgv(a) {
  if (validateAction(a).length) return { kind: "none" };
  switch (a.type) {
    case "key": {
      const { mods, key } = parseKeys(a.keys);
      const argv = ["wtype"];
      for (const m of mods) argv.push("-M", m);
      argv.push("-k", key);
      for (const m of [...mods].reverse()) argv.push("-m", m);
      return { kind: "process", argv };
    }
    case "dispatch":
      return { kind: "dispatch", cmd: a.arg ? `${a.dispatcher} ${a.arg}` : a.dispatcher };
    case "volume":
      if (a.delta === "mute") return { kind: "process", argv: ["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"] };
      return { kind: "process", argv: ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", a.delta === "+5" ? "5%+" : "5%-"] };
    case "media":
      return { kind: "process", argv: ["playerctl", a.cmd] };
    case "screen":
      return a.cmd === "off"
        ? { kind: "process", argv: ["hyprctl", "dispatch", "dpms", "off"] }
        : { kind: "process", argv: ["omarchy-lock-screen"] };
    default:
      return { kind: "none" };
  }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function describe(a) {
  if (validateAction(a).length) return "";
  switch (a.type) {
    case "key": { const { mods, key } = parseKeys(a.keys); return [...mods.map(cap), key.length === 1 ? key.toUpperCase() : key].join("+"); }
    case "dispatch": return a.arg ? `${a.dispatcher} ${a.arg}` : a.dispatcher;
    case "volume": return a.delta === "mute" ? "Mute" : `Volume ${a.delta}`;
    case "media": return cap(a.cmd.replace("-", " "));
    case "screen": return a.cmd === "off" ? "Screen off" : "Lock screen";
    default: return "";
  }
}
```

- [ ] **Step 4: Run all tests**

Run: `make test`
Expected: all pass (Config tests still green because `validateAction` semantics are unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/Actions.mjs tests/Actions.test.mjs
git commit -m "feat(core): action argv/dispatch mapping and labels"
```

---

### Task 7: Dbus — busctl JSON signal parser and property parser

**Files:**
- Create: `lib/Dbus.mjs`
- Test: `tests/Dbus.test.mjs`

**Interfaces:**
- Produces `createSignalParser({ path, iface, member, acceptSender })` → `{ feed(chunk) → events[], bumpGeneration() → number, generation() }`. Input is the stdout of `busctl --user monitor --json=short --match "type='signal',interface='org.atvvoice.Daemon',member='MicStateChanged'"`: one JSON object per line. Event: `{ state, sender, path, interface, member, generation }` — the parser filters on path/interface/member and **also carries them**, so `VoiceSession.dbus()` re-validates the full source itself (§5.1) instead of trusting the parser. Partial lines are buffered across `feed` calls.
- Produces `parseProperty(stdout)` → string value from `busctl get-property` output (`s "streaming"`), or `null`.
- Produces `atvvoiceNames(listStdout)` → array of `org.atvvoice.*` names from `busctl --user list --acquired` output.
- Plan 2 note: the exact `--json=short` line shape is confirmed on the Omarchy host in Plan 2 task 0 (capture a real sample into `tests/fixtures/`); the parser below follows the systemd documentation (`type, sender, path, interface, member, payload.data`).

- [ ] **Step 1: Write the failing tests**

`tests/Dbus.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignalParser, parseProperty, atvvoiceNames } from "../lib/Dbus.mjs";

const line = (state, sender = ":1.42", extra = {}) => JSON.stringify({
  type: "signal", endian: "l", flags: 1, version: 1, cookie: 7, sender,
  path: "/org/atvvoice/Daemon", interface: "org.atvvoice.Daemon", member: "MicStateChanged",
  payload: { type: "s", data: [state] }, ...extra,
}) + "\n";

const mk = () => createSignalParser({
  path: "/org/atvvoice/Daemon", iface: "org.atvvoice.Daemon", member: "MicStateChanged",
  acceptSender: (s) => s === ":1.42",
});

const EV = (state, generation = 0) => ({ state, sender: ":1.42", path: "/org/atvvoice/Daemon", interface: "org.atvvoice.Daemon", member: "MicStateChanged", generation });

test("parses one signal per line into {state, sender, path, interface, member, generation}", () => {
  const p = mk();
  assert.deepEqual(p.feed(line("streaming")), [EV("streaming")]);
});

test("buffers partial lines across feeds", () => {
  const p = mk();
  const full = line("connected");
  assert.deepEqual(p.feed(full.slice(0, 20)), []);
  assert.deepEqual(p.feed(full.slice(20)), [EV("connected")]);
});

test("rejects other senders, paths, interfaces, members and malformed lines", () => {
  const p = mk();
  assert.deepEqual(p.feed(line("streaming", ":1.99")), []);
  assert.deepEqual(p.feed(line("streaming", ":1.42", { path: "/other" })), []);
  assert.deepEqual(p.feed(line("streaming", ":1.42", { interface: "org.x" })), []);
  assert.deepEqual(p.feed(line("streaming", ":1.42", { member: "Other" })), []);
  assert.deepEqual(p.feed("not json\n"), []);
  assert.deepEqual(p.feed(JSON.stringify({ type: "method_call" }) + "\n"), []);
});

test("bumpGeneration discards buffered partial input and tags later events", () => {
  const p = mk();
  p.feed(line("streaming").slice(0, 10));
  assert.equal(p.bumpGeneration(), 1);
  assert.deepEqual(p.feed(line("streaming")), [EV("streaming", 1)]);
});

test("parseProperty reads busctl get-property string output", () => {
  assert.equal(parseProperty('s "streaming"\n'), "streaming");
  assert.equal(parseProperty('s "G20S PRO"\n'), "G20S PRO");
  assert.equal(parseProperty(""), null);
  assert.equal(parseProperty("Failed to get property"), null);
});

test("atvvoiceNames extracts org.atvvoice.* from busctl list output", () => {
  const out = "NAME                 PID PROCESS USER CONNECTION UNIT SESSION DESCRIPTION\n" +
              "org.atvvoice.G20SPRO 123 atvvoice k  :1.42 - - -\n" +
              "org.freedesktop.DBus 1 dbus-broker k :1.0 - - -\n";
  assert.deepEqual(atvvoiceNames(out), ["org.atvvoice.G20SPRO"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/Dbus.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write Dbus.mjs**

`lib/Dbus.mjs`:
```js
// Spec §5.1: ATVVoice D-Bus monitor parsing with sender/path/interface filtering and generations.
export function createSignalParser({ path, iface, member, acceptSender }) {
  let buf = "";
  let gen = 0;

  function parseLine(l) {
    let m;
    try { m = JSON.parse(l); } catch (e) { return null; }
    if (!m || m.type !== "signal") return null;
    if (m.path !== path || m.interface !== iface || m.member !== member) return null;
    if (typeof acceptSender === "function" && !acceptSender(m.sender)) return null;
    const data = m.payload && Array.isArray(m.payload.data) ? m.payload.data[0] : undefined;
    if (typeof data !== "string") return null;
    return { state: data, sender: m.sender, path: m.path, interface: m.interface, member: m.member, generation: gen };
  }

  return {
    feed(chunk) {
      buf += chunk;
      const out = [];
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!l) continue;
        const ev = parseLine(l);
        if (ev) out.push(ev);
      }
      return out;
    },
    bumpGeneration() { buf = ""; return ++gen; },
    generation() { return gen; },
  };
}

export function parseProperty(stdout) {
  const m = /^\s*s\s+"((?:[^"\\]|\\.)*)"/m.exec(String(stdout || ""));
  return m ? m[1].replace(/\\"/g, '"') : null;
}

export function atvvoiceNames(listStdout) {
  return String(listStdout || "").split("\n")
    .map(l => l.trim().split(/\s+/)[0])
    .filter(n => n && n.startsWith("org.atvvoice."));
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/Dbus.test.mjs`
Expected: `# pass 6`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/Dbus.mjs tests/Dbus.test.mjs
git commit -m "feat(core): busctl signal/property parsers with sender filtering and generations"
```

---

### Task 8: VoxStatus — Voxtype status JSON parser

**Files:**
- Create: `lib/VoxStatus.mjs`
- Test: `tests/VoxStatus.test.mjs`

**Interfaces:**
- Produces `parseStatusLine(line)` → `{ cls: "idle"|"recording"|"transcribing"|"stopped"|"unknown", raw }` or `null` for blank/non-JSON. Class comes from the JSON `class` field (Voxtype's Waybar-style output; `alt` is a fallback). `isHealthy(cls)` → true for `idle|recording|transcribing`; `isIdle(cls)` → `cls === "idle"` only.
- Produces `createStatusStream()` → `{ feed(chunk) → status[] }` line-buffering wrapper for `voxtype status --follow --format json`.

- [ ] **Step 1: Write the failing tests**

`tests/VoxStatus.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatusLine, isHealthy, isIdle, createStatusStream } from "../lib/VoxStatus.mjs";

test("class field is the state; alt is a fallback", () => {
  assert.equal(parseStatusLine('{"text":"","alt":"recording","class":"recording","tooltip":"Recording..."}').cls, "recording");
  assert.equal(parseStatusLine('{"alt":"idle"}').cls, "idle");
});

test("streaming is normalized to recording", () => {
  assert.equal(parseStatusLine('{"class":"streaming"}').cls, "recording");
  assert.equal(parseStatusLine('{"alt":"streaming"}').cls, "recording");
});

test("stopped and unknown classes are unhealthy and never idle", () => {
  assert.equal(parseStatusLine('{"class":"stopped"}').cls, "stopped");
  assert.equal(parseStatusLine('{"class":"weird"}').cls, "unknown");
  assert.equal(isHealthy("stopped"), false);
  assert.equal(isHealthy("unknown"), false);
  assert.equal(isHealthy("transcribing"), true);
  assert.equal(isIdle("unknown"), false);
  assert.equal(isIdle("idle"), true);
});

test("blank and non-JSON lines are null", () => {
  assert.equal(parseStatusLine(""), null);
  assert.equal(parseStatusLine("Voxtype ready"), null);
});

test("stream buffers partial lines", () => {
  const s = createStatusStream();
  const l = '{"class":"transcribing"}\n';
  assert.deepEqual(s.feed(l.slice(0, 5)), []);
  assert.equal(s.feed(l.slice(5))[0].cls, "transcribing");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/VoxStatus.test.mjs` — Expected: module not found.

- [ ] **Step 3: Write VoxStatus.mjs**

`lib/VoxStatus.mjs`:
```js
// Spec §3 Voxtype: status classes idle|recording|transcribing|stopped; `streaming` normalizes to recording;
// anything else is unknown (never idle).
const KNOWN = ["idle", "recording", "transcribing", "stopped"];
const ALIAS = { streaming: "recording" };

export function parseStatusLine(line) {
  const l = String(line || "").trim();
  if (!l) return null;
  let j;
  try { j = JSON.parse(l); } catch (e) { return null; }
  if (!j || typeof j !== "object") return null;
  const c0 = typeof j.class === "string" ? j.class : (typeof j.alt === "string" ? j.alt : "");
  const c = ALIAS[c0] || c0;
  return { cls: KNOWN.includes(c) ? c : "unknown", raw: j };
}

export const isHealthy = (cls) => cls === "idle" || cls === "recording" || cls === "transcribing";
export const isIdle = (cls) => cls === "idle";

export function createStatusStream() {
  let buf = "";
  return {
    feed(chunk) {
      buf += chunk;
      const out = [];
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const st = parseStatusLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (st) out.push(st);
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run tests** — `node --test tests/VoxStatus.test.mjs` → `# pass 5`.

- [ ] **Step 5: Commit**

```bash
git add lib/VoxStatus.mjs tests/VoxStatus.test.mjs
git commit -m "feat(core): voxtype status parser"
```

---

### Task 9: VoiceSession — HID-owned sessions, confirmation, stop latch, health

**Files:**
- Create: `lib/VoiceSession.mjs` (complete module; Tasks 10–11 add tests and fix defects, they do not restructure it)
- Test: `tests/VoiceSession.test.mjs`

**Interfaces:**
- Produces `createVoiceSession(config)` → object with inputs (each returns an effects array):
  - `hidPress(now)`, `hidRelease(now)` — HID mic key (only when `config.keys.mic.ptt`)
  - `dbus(event, now)` — a parsed monitor event `{ state, sender, path, interface, member, generation }` (from `Dbus.mjs`); dropped unless `path === "/org/atvvoice/Daemon"`, `interface === "org.atvvoice.Daemon"`, `member === "MicStateChanged"`, `sender` equals the selected sender and `generation` equals the current monitor generation (VoiceSession validates all of it; the parser's filtering is not relied upon). `setDbusSource({ sender, generation })` — host calls it after resolving the `org.atvvoice.*` owner and after every monitor (re)start.
  - `atvRead(reading, now)` — answer to a `readAtv` effect: `{ state, requestId, generation }`; dropped unless `requestId` is the outstanding request and `generation` is current, so a late property reply from a retired daemon cannot decide arbitration or a stop
  - `status(cls, now, { fresh })` — a Voxtype status class; `fresh: true` for answers to a `poll` effect, `false` for follow-stream lines
  - `cmdExit(id, code, now)` — a `cmd` effect's process exited
  - `restartResult(ok, now)` — host finished the recovery restart + verification (§5.3)
  - `abort(now)` — panic / reset (§4.3, §5.2)
  - `advance(now)`, `nextDeadline()`
  - `micOpened()` / `micClosed()` — plugin-owned mic bookkeeping (§5.1); `setDbusEnabled(bool)` — remoteWarning switch (§5.4); `setConfig(config)`
  - `gate.acquire(name)` → boolean (only from `idle` with no other holder), `gate.release(name)`, `gate.busy()`
  - `snapshot()` → `{ state, owner, remote, backend, backendAt, backendFresh, pluginMic, cancels, pendingCmds, sessionSource, inferred, gates, dbusSender, dbusGeneration, atvRequestId, idleAccepted }`
- Effects emitted: `cmd` (`{ id, kind: "start"|"stop"|"cancel", argv }`), `state`, `hud`, `error` (`{ reason }`), `poll`, `readAtv` (`{ requestId }`), `micClose`, `restart`, `stat` (`{ session: { startedAt, durationSec, source, inferred } }`).
- States: `idle | arbitrating | starting | recording | stopping | transcribing | recovering | unconfigured`. Owners: `dbus | hid | keyboard | null`.

- [ ] **Step 1: Write the failing tests (HID path)**

`tests/VoiceSession.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceSession } from "../lib/VoiceSession.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";
import { byType, last } from "./helpers.mjs";

const cfg = (over = {}) => normalizeConfig({ ...DEFAULT_CONFIG, ...over }).config;
const kinds = (fx) => byType(fx, "cmd").map(c => c.kind);
const stateOf = (fx) => (last(fx, "state") || {}).state;
const cmdId = (fx, kind) => byType(fx, "cmd").find(c => c.kind === kind).id;
// D-Bus event from the selected sender in the current generation; A = answer to the outstanding readAtv.
const D = (state, extra = {}) => ({ state, sender: ":1.42", path: "/org/atvvoice/Daemon", interface: "org.atvvoice.Daemon", member: "MicStateChanged", generation: 0, ...extra });
const A = (vs, state, extra = {}) => ({ state, requestId: vs.snapshot().atvRequestId, generation: 0, ...extra });

// Bring a session to confirmed recording via the HID key.
function hidRecording() {
  const vs = createVoiceSession(cfg());
  vs.status("idle", 0, { fresh: true });
  const fx = vs.hidPress(10);
  vs.cmdExit(cmdId(fx, "start"), 0, 20);
  vs.status("recording", 100);
  return vs;
}

test("HID press from idle issues record start and enters starting with a 1500ms deadline", () => {
  const vs = createVoiceSession(cfg());
  const fx = vs.hidPress(10);
  assert.deepEqual(kinds(fx), ["start"]);
  assert.deepEqual(byType(fx, "cmd")[0].argv, ["voxtype", "record", "start"]);
  assert.equal(stateOf(fx), "starting");
  assert.equal(vs.snapshot().owner, "hid");
  assert.equal(vs.nextDeadline(), 1510);
});

test("session is confirmed only by observed recording; release then issues exactly one stop", () => {
  const vs = hidRecording();
  assert.equal(vs.snapshot().state, "recording");
  const fx = vs.hidRelease(500);
  assert.deepEqual(kinds(fx), ["stop"]);
  assert.equal(stateOf(fx), "stopping");
  assert.deepEqual(kinds(vs.hidRelease(510)), []);           // latched
  const t = vs.status("transcribing", 600);
  assert.equal(stateOf(t), "transcribing");
  const done = vs.status("idle", 900);
  assert.equal(stateOf(done), "idle");
  const stat = byType(done, "stat")[0].session;
  assert.equal(stat.source, "hid");
  assert.equal(stat.inferred, false);
  assert.equal(stat.startedAt, 100);
  assert.equal(stat.durationSec, 0.5);
});

test("release while starting is remembered: no stop before confirmation, one stop on confirmation", () => {
  const vs = createVoiceSession(cfg());
  vs.hidPress(0);
  assert.deepEqual(kinds(vs.hidRelease(50)), []);
  const fx = vs.status("recording", 200);
  assert.deepEqual(kinds(fx), ["stop"]);
  assert.equal(stateOf(fx), "stopping");
});

test("start never confirms: at 1500ms cancel is issued and state is recovering, not idle", () => {
  const vs = createVoiceSession(cfg());
  vs.hidPress(0);
  const fx = vs.advance(1500);
  assert.deepEqual(kinds(fx), ["cancel"]);
  assert.equal(stateOf(fx), "recovering");
  assert.equal(byType(fx, "error")[0].reason, "start-timeout");
  assert.equal(byType(fx, "poll").length, 1);
});

test("record start exiting non-zero enters recovering", () => {
  const vs = createVoiceSession(cfg());
  const fx = vs.hidPress(0);
  const r = vs.cmdExit(cmdId(fx, "start"), 1, 30);
  assert.deepEqual(kinds(r), ["cancel"]);
  assert.equal(stateOf(r), "recovering");
});

test("HID press is ignored while not idle and when ptt is off", () => {
  const vs = hidRecording();
  assert.deepEqual(vs.hidPress(200), []);
  const off = createVoiceSession(cfg({ keys: { ...DEFAULT_CONFIG.keys, mic: { ptt: false } } }));
  assert.deepEqual(off.hidPress(0), []);
});

test("maxSessionSec forces a stop with a warning", () => {
  const vs = hidRecording();                       // confirmed at t=100
  const fx = vs.advance(100 + 60000);
  assert.deepEqual(kinds(fx), ["stop"]);
  assert.ok(byType(fx, "hud").some(h => /max session/.test(h.text)));
});

test("stopped/unknown status makes the session unconfigured; healthy idle restores it", () => {
  const vs = createVoiceSession(cfg());
  const fx = vs.status("stopped", 0, { fresh: true });
  assert.equal(stateOf(fx), "unconfigured");
  assert.deepEqual(vs.hidPress(10), []);
  const back = vs.status("idle", 20, { fresh: true });
  assert.equal(stateOf(back), "idle");
  assert.equal(stateOf(vs.status("weird", 30)), "unconfigured");
});

test("stop exiting non-zero enters recovering regardless of cancel exit code", () => {
  const vs = hidRecording();
  const fx = vs.hidRelease(500);
  const r = vs.cmdExit(cmdId(fx, "stop"), 1, 520);
  assert.deepEqual(kinds(r), ["cancel"]);
  assert.equal(stateOf(r), "recovering");
  assert.deepEqual(vs.cmdExit(cmdId(r, "cancel"), 1, 530), []);
  assert.equal(vs.snapshot().state, "recovering");
});

test("gate: acquire only from idle, blocks HID start, release restores", () => {
  const vs = createVoiceSession(cfg());
  assert.equal(vs.gate.acquire("selftest"), true);
  assert.equal(vs.gate.acquire("mic-apply"), false);
  assert.deepEqual(kinds(vs.hidPress(0)), []);
  vs.gate.release("selftest");
  assert.deepEqual(kinds(vs.hidPress(1)), ["start"]);
  assert.equal(vs.gate.acquire("selftest"), false);          // not idle now
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/VoiceSession.test.mjs` — Expected: module not found.

- [ ] **Step 3: Write VoiceSession.mjs (complete)**

`lib/VoiceSession.mjs`:
```js
// Spec §5: voice session state machine (§5.1 sources, §5.2 start/arbitration/end, §5.3 failures & recovery,
// §5.4 degradation, §5.5 stats). Pure: explicit `now`, effects out, no processes.
import { isHealthy } from "./VoxStatus.mjs";

const VOX = (sub) => ["voxtype", "record", sub];
const ATV = { path: "/org/atvvoice/Daemon", iface: "org.atvvoice.Daemon", member: "MicStateChanged" };   // §5.1 source identity
const ARB_CHECK_MS = 500;    // bound for readAtv/poll answers after the arbitration timer
const RESTART_MS = 10000;    // §5.3 recovery restart verification bound
const FRESH_MS = 500;        // §5.3 "fresh idle" = poll no older than this
const MAX_CANCELS = 3;       // §5.3 phantom re-cancel bound

export function createVoiceSession(config) {
  let cfg = config;
  const v = () => cfg.voice;

  let st = "idle", owner = null;
  let remote = "unknown";                                   // last known ATVVoice State
  let backend = { cls: "unknown", at: -Infinity, fresh: false };
  let gen = 0, cmdSeq = 0;
  const cmds = new Map();                                   // id -> { kind, gen }
  let dl = {};                                              // named deadlines (ms)
  let stopLatched = false, stopOnConfirm = false, ourStart = false, pendingDbusEnd = false;
  let arb = null;                                           // { atv, backend } answers after arbitration timer
  let cancels = 0, cancelAt = -Infinity, escalate = false, restartPending = false, restarted = false, idleAccepted = false, external = false;
  let unconfirmedEntry = false;                             // §5.3: recovery began from `starting` (our SIGUSR1 may land late)
  let pluginMic = false, dbusEnabled = true;
  let dbusSender = null, dbusGeneration = 0;                // §5.1 selected sender / monitor generation
  let atvRequestId = null, atvSeq = 0;                      // outstanding readAtv request
  let sessionStart = 0, sessionSource = null, recordEnd = 0;
  const gates = new Set();

  // ---- helpers -------------------------------------------------------------
  const stateEff = () => ({ type: "state", state: st, owner });
  const hud = (out, text) => out.push({ type: "hud", text });
  function setState(out, next, nextOwner) {
    st = next;
    if (nextOwner !== undefined) owner = nextOwner;
    out.push(stateEff());
  }
  function cmd(out, kind) {
    const id = ++cmdSeq;
    cmds.set(id, { kind, gen });
    out.push({ type: "cmd", id, kind, argv: VOX(kind) });
    return id;
  }
  const clearDeadlines = () => { dl = {}; };
  const inferred = (src) => src === "dbus" || src === "keyboard";
  function readAtv(out) { atvRequestId = `atv-${++atvSeq}`; out.push({ type: "readAtv", requestId: atvRequestId }); }
  function currentSource(ev) {                              // generation/sender check shared by signals and property replies
    if (!ev || typeof ev !== "object") return false;
    if (dbusSender !== null && ev.sender !== dbusSender) return false;
    if (ev.generation !== undefined && ev.generation !== dbusGeneration) return false;
    return true;
  }
  function validSignal(ev) {                                // full §5.1 identity for monitor events
    return currentSource(ev) && ev.path === ATV.path && ev.interface === ATV.iface && ev.member === ATV.member;
  }

  function startSession(out, now, source) {
    ourStart = true; stopLatched = false; stopOnConfirm = false;
    cmd(out, "start");
    dl.start = now + v().startTimeoutMs;
    hud(out, "starting…");
    setState(out, "starting", source);
  }

  function confirm(out, now) {
    ourStart = false; delete dl.start;
    sessionStart = now; sessionSource = owner;
    dl.maxSession = now + v().maxSessionSec * 1000;
    hud(out, "recording");
    setState(out, "recording");
    if (stopOnConfirm) { stopOnConfirm = false; requestStop(out, now); }
  }

  function adoptKeyboard(out, now) {
    arb = null; delete dl.arb; delete dl.arbCheck;
    stopLatched = false; ourStart = false;
    sessionStart = now; sessionSource = "keyboard";
    dl.maxSession = now + v().maxSessionSec * 1000;
    hud(out, "recording");
    setState(out, "recording", "keyboard");
  }

  function observeTranscribing(out, now) {
    arb = null; delete dl.arb; delete dl.arbCheck;
    if (dl.stop === undefined) dl.stop = now + v().stopTimeoutMs;   // §5.3 external transcription deadline
    setState(out, "transcribing", owner || "keyboard");
  }

  function requestStop(out, now) {
    if (stopLatched) return;
    stopLatched = true;
    cmd(out, "stop");
    delete dl.maxSession;
    dl.stop = now + v().stopTimeoutMs;
    hud(out, "stopping…");
    setState(out, "stopping");
  }

  function finalize(out, now) {
    if (sessionStart > 0) {
      const end = recordEnd || now;
      out.push({ type: "stat", session: { startedAt: sessionStart, durationSec: (end - sessionStart) / 1000, source: sessionSource, inferred: inferred(sessionSource) } });
    }
    sessionStart = 0; sessionSource = null; recordEnd = 0;
    stopLatched = false; stopOnConfirm = false; ourStart = false; pendingDbusEnd = false;
    clearDeadlines();
    hud(out, "");
    setState(out, "idle", null);
  }

  function abandonArb(out, reason) {
    arb = null; delete dl.arb; delete dl.arbCheck;
    hud(out, "");
    setState(out, "idle", null);
    if (reason) out.push({ type: "error", reason: `arbitration-${reason}` });
  }

  function enterRecovering(out, now, reason) {
    unconfirmedEntry = st === "starting";
    gen++; cmds.clear();                                    // §5.3 invalidate stale callbacks
    ourStart = false; stopLatched = false; stopOnConfirm = false; arb = null; pendingDbusEnd = false;
    sessionStart = 0; sessionSource = null; recordEnd = 0;
    clearDeadlines();
    cancels = 1; cancelAt = now; escalate = false; restartPending = false; restarted = false; idleAccepted = false; external = false;
    cmd(out, "cancel");
    if (pluginMic) { pluginMic = false; out.push({ type: "micClose" }); }
    out.push({ type: "error", reason });
    hud(out, reason === "abort" ? "Reset" : "recovering…");
    out.push({ type: "poll" });
    dl.recovery = now + v().stopTimeoutMs;
    setState(out, "recovering", null);
  }

  function toUnconfigured(out, reason) {
    clearDeadlines();
    arb = null; restartPending = false; ourStart = false; stopLatched = false; pendingDbusEnd = false;
    sessionStart = 0; sessionSource = null;
    out.push({ type: "error", reason });
    hud(out, reason);
    setState(out, "unconfigured", null);
  }

  function recovered(out) {
    cancels = 0; cancelAt = -Infinity; escalate = false; restarted = false; idleAccepted = false; external = false; unconfirmedEntry = false;
    clearDeadlines();
    hud(out, "");
    setState(out, "idle", null);
  }

  function trySettle(now) {
    if (st === "recovering" && idleAccepted && cmds.size === 0 && !escalate && !restartPending && dl.settle === undefined) {
      dl.settle = now + v().startTimeoutMs;
    }
  }

  function maybeRestart(out, now) {
    if (!escalate || restartPending || restarted) return;
    const busy = backend.cls === "recording" || backend.cls === "transcribing";
    if (busy && backend.at >= cancelAt) return;              // never restart over work observed since the cancel
    gen++; cmds.clear();
    restartPending = true; restarted = true;
    hud(out, "restarting Voxtype");
    out.push({ type: "restart" });
    dl.restart = now + RESTART_MS;
    delete dl.recovery;
  }

  function decideArb(out, now) {
    if (!arb || arb.atv === null || arb.backend === null) return;
    const { atv, backend: b } = arb;
    arb = null; delete dl.arbCheck;
    if (atv !== "streaming") { abandonArb(out, "remote-stopped"); return; }
    if (b === "recording") { adoptKeyboard(out, now); return; }
    if (b === "transcribing") { observeTranscribing(out, now); return; }
    if (b === "idle" && gates.size === 0) { startSession(out, now, "dbus"); return; }
    abandonArb(out, "backend-busy");
  }

  function recoveringStatus(out, prev, now) {
    const cls = backend.cls;
    if (cls === "recording" || cls === "transcribing") {
      delete dl.settle;
      if ((idleAccepted || external) && !unconfirmedEntry) { // §5.3: after an accepted idle, from a confirmed session -> external
        if (!external) hud(out, "external dictation in progress");
        external = true; idleAccepted = false; return;
      }
      idleAccepted = false;
      if (cancels < MAX_CANCELS) { cancels++; cancelAt = now; cmd(out, "cancel"); }
      else escalate = true;                                  // restart once the backend is quiet
      return;
    }
    const transition = prev.cls === "recording" || prev.cls === "transcribing";
    const freshEnough = backend.fresh && now - backend.at <= FRESH_MS;
    if (now >= cancelAt && (freshEnough || transition)) {
      idleAccepted = true; external = false;
      if (escalate) maybeRestart(out, now); else trySettle(now);
    }
  }

  // ---- inputs --------------------------------------------------------------
  function status(cls, now, opts = {}) {
    const prev = backend;
    backend = { cls, at: now, fresh: !!opts.fresh };
    const out = [];
    if (restartPending) return out;                          // host verifies the restart and reports restartResult
    if (!isHealthy(cls)) { if (st !== "unconfigured") toUnconfigured(out, "voxtype not responding"); return out; }
    if (st === "unconfigured") { hud(out, ""); setState(out, "idle", null); }
    if (arb && st === "arbitrating") { arb.backend = cls; decideArb(out, now); return out; }
    switch (st) {
      case "idle":
        if (cls === "recording" && !ourStart) adoptKeyboard(out, now);
        else if (cls === "transcribing") observeTranscribing(out, now);
        break;
      case "arbitrating":
        if (cls === "recording") adoptKeyboard(out, now);
        else if (cls === "transcribing") observeTranscribing(out, now);
        break;
      case "starting":
        if (cls === "recording") confirm(out, now);
        else if (cls === "transcribing") { ourStart = false; delete dl.start; observeTranscribing(out, now); }
        break;
      case "recording":
      case "stopping":
        if (cls === "transcribing") { recordEnd = now; delete dl.maxSession; if (dl.stop === undefined) dl.stop = now + v().stopTimeoutMs; setState(out, "transcribing"); }
        else if (cls === "idle") { recordEnd = now; finalize(out, now); }
        break;
      case "transcribing":
        if (cls === "idle") finalize(out, now);
        else if (cls === "recording") { finalize(out, now); adoptKeyboard(out, now); }
        break;
      case "recovering":
        recoveringStatus(out, prev, now);
        break;
      default: break;
    }
    return out;
  }

  function dbus(event, now) {
    const out = [];
    if (!validSignal(event)) return out;
    const state = event.state;
    const prev = remote; remote = state;
    const was = prev === "streaming", is = state === "streaming";
    if (is && !was) {
      if (st === "idle" && dbusEnabled && gates.size === 0) {
        if (backend.cls === "recording") adoptKeyboard(out, now);
        else { dl.arb = now + v().arbitrationMs; hud(out, "…"); setState(out, "arbitrating", null); }
      }
      return out;
    }
    if (was && !is) {
      if (st === "arbitrating") { abandonArb(out, null); return out; }
      if (owner === "dbus") {
        if (st === "starting") stopOnConfirm = true;
        else if (st === "recording") { pendingDbusEnd = true; readAtv(out); }
      } else if ((st === "recording" || st === "starting") && v().mic === "remote") {
        hud(out, "remote audio dropped");
      }
    }
    return out;
  }

  function atvRead(reading, now) {
    const out = [];
    if (!reading || reading.requestId !== atvRequestId || !currentSource({ sender: dbusSender, generation: reading.generation })) return out;
    atvRequestId = null;
    const state = reading.state;
    remote = state;
    if (arb && st === "arbitrating") { arb.atv = state; decideArb(out, now); return out; }
    if (pendingDbusEnd && st === "recording" && owner === "dbus") {
      pendingDbusEnd = false;
      if (state !== "streaming") requestStop(out, now);
    }
    return out;
  }

  function hidPress(now) {
    const out = [];
    if (st !== "idle" || gates.size > 0 || !cfg.keys.mic.ptt) return out;
    startSession(out, now, "hid");
    return out;
  }

  function hidRelease(now) {
    const out = [];
    if (owner !== "hid") return out;
    if (st === "starting") stopOnConfirm = true;
    else if (st === "recording") requestStop(out, now);
    return out;
  }

  function cmdExit(id, code, now) {
    const c = cmds.get(id);
    if (!c) return [];
    cmds.delete(id);
    const out = [];
    if (c.gen !== gen) return out;
    if (c.kind === "start" && code !== 0 && st === "starting") { hud(out, "Voxtype start failed"); enterRecovering(out, now, "start-failed"); }
    else if (c.kind === "stop" && code !== 0 && st === "stopping") enterRecovering(out, now, "stop-failed");
    else if (st === "recovering") trySettle(now);
    return out;
  }

  function restartResult(ok, now) {
    const out = [];
    if (!restartPending) return out;
    restartPending = false; delete dl.restart;
    if (!ok) { toUnconfigured(out, "voxtype not responding"); return out; }
    escalate = false; cancels = 0; cancelAt = now; idleAccepted = false;
    out.push({ type: "poll" });
    dl.recovery = now + v().stopTimeoutMs;
    return out;
  }

  function abort(now) {
    const out = [];
    if (st === "idle" || st === "unconfigured") {
      if (pluginMic) { pluginMic = false; out.push({ type: "micClose" }); }
      return out;
    }
    enterRecovering(out, now, "abort");
    return out;
  }

  function advance(now) {
    const out = [];
    const due = (k) => dl[k] !== undefined && dl[k] <= now;
    if (st === "starting" && due("start")) { delete dl.start; hud(out, "no audio from Voxtype"); enterRecovering(out, now, "start-timeout"); }
    if (st === "arbitrating" && due("arb")) { delete dl.arb; arb = { atv: null, backend: null }; readAtv(out); out.push({ type: "poll" }); dl.arbCheck = now + ARB_CHECK_MS; }
    if (st === "arbitrating" && due("arbCheck")) { delete dl.arbCheck; abandonArb(out, "unresponsive"); }
    if (st === "recording" && due("maxSession")) { delete dl.maxSession; hud(out, "max session reached"); requestStop(out, now); }
    if ((st === "stopping" || st === "transcribing") && due("stop")) { delete dl.stop; enterRecovering(out, now, "stop-timeout"); }
    if (st === "recovering" && due("settle")) { delete dl.settle; recovered(out); }
    if (st === "recovering" && due("recovery")) {
      delete dl.recovery;
      if (restarted) toUnconfigured(out, "voxtype not responding");
      else { escalate = true; maybeRestart(out, now); }
    }
    if (st === "recovering" && due("restart")) { delete dl.restart; toUnconfigured(out, "voxtype not responding"); }
    return out;
  }

  function nextDeadline() {
    let d = null;
    for (const k of Object.keys(dl)) if (dl[k] !== undefined && (d === null || dl[k] < d)) d = dl[k];
    return d;
  }

  return {
    hidPress, hidRelease, dbus, atvRead, status, cmdExit, restartResult, abort, advance, nextDeadline,
    micOpened() { pluginMic = true; }, micClosed() { pluginMic = false; },
    setDbusEnabled(b) { dbusEnabled = !!b; },
    setDbusSource({ sender, generation }) { dbusSender = sender === undefined ? null : sender; dbusGeneration = generation || 0; atvRequestId = null; },
    setConfig(c) { cfg = c; },
    gate: {
      acquire(name) { if (st !== "idle" || gates.size > 0) return false; gates.add(name); return true; },
      release(name) { gates.delete(name); },
      busy() { return gates.size > 0; },
    },
    snapshot() {
      return { state: st, owner, remote, backend: backend.cls, backendAt: backend.at, backendFresh: backend.fresh, pluginMic, cancels, pendingCmds: cmds.size, sessionSource, inferred: inferred(owner), gates: [...gates], dbusSender, dbusGeneration, atvRequestId, idleAccepted };
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/VoiceSession.test.mjs`
Expected: `# pass 10`, `# fail 0`. If a test fails, fix the module — the tests encode §5.2/§5.3 and must not be weakened.

- [ ] **Step 5: Commit**

```bash
git add lib/VoiceSession.mjs tests/VoiceSession.test.mjs
git commit -m "feat(core): voice session state machine with HID sessions, stop latch and health"
```

---

### Task 10: VoiceSession — D-Bus arbitration and ownership

**Files:**
- Modify: `lib/VoiceSession.mjs` (only to fix failing tests)
- Test: `tests/VoiceSession.test.mjs` (append)

- [ ] **Step 1: Append the tests**

```js
// ---- D-Bus arbitration (§5.2) ----
function idleSession() {
  const vs = createVoiceSession(cfg());
  vs.setDbusSource({ sender: ":1.42", generation: 0 });
  vs.status("idle", 0, { fresh: true });
  return vs;
}

test("streaming from idle enters arbitrating; release before 250ms sends nothing and returns to idle", () => {
  const vs = idleSession();
  const fx = vs.dbus(D("streaming"), 0);
  assert.equal(stateOf(fx), "arbitrating");
  assert.equal(vs.nextDeadline(), 250);
  const rel = vs.dbus(D("connected"), 100);
  assert.deepEqual(kinds(rel), []);
  assert.equal(stateOf(rel), "idle");
  assert.deepEqual(kinds(vs.advance(1000)), []);
});

test("keyboard recording at 100ms is adopted as keyboard owner; later remote drop only warns", () => {
  const vs = idleSession();
  vs.dbus(D("streaming"), 0);
  const fx = vs.status("recording", 100);
  assert.equal(stateOf(fx), "recording");
  assert.equal(vs.snapshot().owner, "keyboard");
  const drop = vs.dbus(D("connected"), 500);
  assert.deepEqual(kinds(drop), []);
  assert.ok(byType(drop, "hud").some(h => h.text === "remote audio dropped"));
  assert.equal(vs.snapshot().state, "recording");
});

test("reverse order: keyboard recording observed first, then on-demand streaming is ignored", () => {
  const vs = idleSession();
  const fx = vs.status("recording", 0);
  assert.equal(vs.snapshot().owner, "keyboard");
  assert.deepEqual(vs.dbus(D("streaming"), 30), []);
  assert.equal(vs.snapshot().state, "recording");
});

test("arbitration timer: re-read; streaming + fresh idle backend -> record start owned by dbus", () => {
  const vs = idleSession();
  vs.dbus(D("streaming"), 0);
  const t = vs.advance(250);
  assert.equal(byType(t, "readAtv").length, 1);
  assert.equal(byType(t, "poll").length, 1);
  assert.deepEqual(kinds(vs.atvRead(A(vs, "streaming"), 260)), []);          // waits for both answers
  const fx = vs.status("idle", 270, { fresh: true });
  assert.deepEqual(kinds(fx), ["start"]);
  assert.equal(stateOf(fx), "starting");
  assert.equal(vs.snapshot().owner, "dbus");
  vs.status("recording", 400);
  assert.equal(vs.snapshot().state, "recording");
  // remote button released: verify before stopping
  const end = vs.dbus(D("connected"), 900);
  assert.deepEqual(kinds(end), []);
  assert.equal(byType(end, "readAtv").length, 1);
  const stop = vs.atvRead(A(vs, "connected"), 910);
  assert.deepEqual(kinds(stop), ["stop"]);
  const done = vs.status("idle", 1200);
  const stat = byType(done, "stat")[0].session;
  assert.equal(stat.source, "dbus");
  assert.equal(stat.inferred, true);
});

test("arbitration timer: remote no longer streaming -> abandon without start", () => {
  const vs = idleSession();
  vs.dbus(D("streaming"), 0);
  vs.advance(250);
  vs.status("idle", 255, { fresh: true });
  const fx = vs.atvRead(A(vs, "connected"), 260);
  assert.deepEqual(kinds(fx), []);
  assert.equal(stateOf(fx), "idle");
});

test("arbitration timer: backend transcribing -> observe, no start", () => {
  const vs = idleSession();
  vs.dbus(D("streaming"), 0);
  vs.advance(250);
  vs.atvRead(A(vs, "streaming"), 255);
  const fx = vs.status("transcribing", 260, { fresh: true });
  assert.deepEqual(kinds(fx), []);
  assert.equal(stateOf(fx), "transcribing");
});

test("arbitration answers never arrive: abandoned after 500ms", () => {
  const vs = idleSession();
  vs.dbus(D("streaming"), 0);
  vs.advance(250);
  const fx = vs.advance(750);
  assert.equal(stateOf(fx), "idle");
  assert.equal(byType(fx, "error")[0].reason, "arbitration-unresponsive");
});

test("delayed keyboard status at 300ms is misattributed to dbus (documented, bounded)", () => {
  const vs = idleSession();
  vs.dbus(D("streaming"), 0);
  vs.advance(250);
  vs.atvRead(A(vs, "streaming"), 255);
  const started = vs.status("idle", 260, { fresh: true });     // stale idle poll -> we start
  assert.deepEqual(kinds(started), ["start"]);
  vs.status("recording", 300);                                  // actually the keyboard session
  const snap = vs.snapshot();
  assert.equal(snap.owner, "dbus");
  assert.equal(snap.inferred, true);
  // premature stop when the on-demand stream closes (documented consequence, §5.2)
  vs.dbus(D("connected"), 800);
  assert.deepEqual(kinds(vs.atvRead(A(vs, "connected"), 810)), ["stop"]);
});

test("stale D-Bus end is discarded when the remote is still streaming on re-read", () => {
  const vs = idleSession();
  vs.dbus(D("streaming"), 0); vs.advance(250); vs.atvRead(A(vs, "streaming"), 255); vs.status("idle", 260, { fresh: true });
  vs.status("recording", 400);
  vs.dbus(D("connected"), 500);
  assert.deepEqual(kinds(vs.atvRead(A(vs, "streaming"), 510)), []);
  assert.equal(vs.snapshot().state, "recording");
});

test("D-Bus start path disabled by remoteWarning; gate holders also block it", () => {
  const vs = idleSession();
  vs.setDbusEnabled(false);
  assert.deepEqual(vs.dbus(D("streaming"), 0), []);
  vs.setDbusEnabled(true);
  vs.dbus(D("connected"), 1);
  assert.equal(vs.gate.acquire("mic-apply"), true);
  assert.deepEqual(vs.dbus(D("streaming"), 2), []);
});

test("signals from another sender, path, interface, member or an older monitor generation are dropped", () => {
  const vs = idleSession();
  assert.deepEqual(vs.dbus(D("streaming", { sender: ":1.99" }), 0), []);
  assert.deepEqual(vs.dbus(D("streaming", { path: "/org/atvvoice/Other" }), 0), []);
  assert.deepEqual(vs.dbus(D("streaming", { interface: "org.atvvoice.Other" }), 0), []);
  assert.deepEqual(vs.dbus(D("streaming", { member: "Other" }), 0), []);
  assert.deepEqual(vs.dbus({ state: "streaming" }, 0), []);                        // no metadata at all
  assert.equal(vs.snapshot().state, "idle");
  vs.setDbusSource({ sender: ":1.42", generation: 1 });
  assert.deepEqual(vs.dbus(D("streaming", { generation: 0 }), 1), []);      // buffered from the old monitor
  assert.equal(vs.snapshot().state, "idle");
  assert.equal(stateOf(vs.dbus(D("streaming", { generation: 1 }), 2)), "arbitrating");
});

test("a property reply for a retired request or generation cannot decide arbitration or a stop", () => {
  const vs = idleSession();
  vs.dbus(D("streaming"), 0);
  vs.advance(250);
  const rid = vs.snapshot().atvRequestId;
  assert.ok(rid);
  assert.deepEqual(vs.atvRead({ state: "connected", requestId: "stale", generation: 0 }, 255), []);
  assert.equal(vs.snapshot().state, "arbitrating");
  assert.deepEqual(vs.atvRead({ state: "connected", requestId: rid, generation: -1 }, 256), []);
  assert.equal(vs.snapshot().state, "arbitrating");
  vs.status("idle", 257, { fresh: true });
  assert.deepEqual(kinds(vs.atvRead({ state: "streaming", requestId: rid, generation: 0 }, 258)), ["start"]);
  assert.equal(vs.snapshot().atvRequestId, null);
});

test("HID release during a keyboard-owned session does nothing", () => {
  const vs = idleSession();
  vs.status("recording", 0);
  assert.deepEqual(kinds(vs.hidRelease(10)), []);
});

test("external transcribing observed from idle gets a stop deadline and finalizes without a stat", () => {
  const vs = idleSession();
  const fx = vs.status("transcribing", 10);
  assert.equal(stateOf(fx), "transcribing");
  assert.equal(vs.nextDeadline(), 15010);
  const done = vs.status("idle", 500);
  assert.equal(stateOf(done), "idle");
  assert.equal(byType(done, "stat").length, 0);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/VoiceSession.test.mjs`
Expected: `# pass 24`, `# fail 0`. Fix the module if needed.

- [ ] **Step 3: Commit**

```bash
git add tests/VoiceSession.test.mjs lib/VoiceSession.mjs
git commit -m "test(core): voice session D-Bus arbitration and ownership coverage"
```

---

### Task 11: VoiceSession — abort, recovery settle window, re-cancel, escalation

**Files:**
- Modify: `lib/VoiceSession.mjs` (only to fix failing tests)
- Test: `tests/VoiceSession.test.mjs` (append)

- [ ] **Step 1: Append the tests**

```js
// ---- recovery (§5.3) ----
test("abort from recording cancels (never stops), closes no mic unless plugin-owned, enters recovering", () => {
  const vs = hidRecording();
  const fx = vs.abort(300);
  assert.deepEqual(kinds(fx), ["cancel"]);
  assert.equal(byType(fx, "micClose").length, 0);
  assert.equal(stateOf(fx), "recovering");
  assert.ok(byType(fx, "hud").some(h => h.text === "Reset"));
  const vs2 = hidRecording();
  vs2.micOpened();
  assert.equal(byType(vs2.abort(300), "micClose").length, 1);
});

test("abort from idle only closes a plugin-owned mic", () => {
  const vs = idleSession();
  assert.deepEqual(vs.abort(0), []);
  vs.micOpened();
  assert.deepEqual(vs.abort(1), [{ type: "micClose" }]);
});

test("recovery settles after fresh idle + reaped cancel + quiet settle window", () => {
  const vs = hidRecording();
  const fx = vs.abort(300);
  const cancel = cmdId(fx, "cancel");
  const idle = vs.status("idle", 320, { fresh: true });        // answer to poll
  assert.equal(stateOf(idle), undefined);                        // still recovering, no state change
  assert.equal(vs.nextDeadline(), 15300);                        // recovery budget only; cancel not reaped yet
  vs.cmdExit(cancel, 0, 330);
  assert.equal(vs.nextDeadline(), 330 + 1500);                   // settle window armed
  const done = vs.advance(1830);
  assert.equal(stateOf(done), "idle");
});

test("a non-fresh idle with no transition does not settle; a fresh poll does", () => {
  const vs = createVoiceSession(cfg());
  vs.status("idle", 0, { fresh: true });
  vs.hidPress(10);
  const fx = vs.advance(1510);                                   // start-timeout -> recovering, cancel issued
  vs.cmdExit(cmdId(fx, "cancel"), 0, 1515);
  vs.status("idle", 1520, { fresh: false });                     // stream line, backend was already idle: no evidence
  assert.equal(vs.nextDeadline(), 16510);                        // only the recovery budget is armed
  vs.status("idle", 1530, { fresh: true });                      // poll answer newer than the cancel
  assert.equal(vs.nextDeadline(), 1530 + 1500);
  assert.equal(stateOf(vs.advance(3030)), "idle");
});

test("a recording->idle transition observed after the cancel counts as fresh evidence", () => {
  const vs = hidRecording();
  const fx = vs.abort(300);
  vs.cmdExit(cmdId(fx, "cancel"), 0, 310);
  vs.status("idle", 320, { fresh: false });
  assert.equal(vs.nextDeadline(), 320 + 1500);
});

test("phantom recording after an unconfirmed start is re-cancelled up to three times, then escalates to a restart once quiet", () => {
  const vs = createVoiceSession(cfg());
  vs.status("idle", 0, { fresh: true });
  vs.hidPress(10);
  const fx = vs.advance(1510);                                    // start-timeout: cancel #1, recovering from `starting`
  vs.cmdExit(cmdId(fx, "cancel"), 0, 1520);
  vs.status("idle", 1530, { fresh: true });                       // accepted; settle armed
  assert.equal(vs.nextDeadline(), 3030);
  const c2 = vs.status("recording", 1600);  assert.deepEqual(kinds(c2), ["cancel"]);   // late SIGUSR1 -> phantom
  vs.cmdExit(cmdId(c2, "cancel"), 0, 1610);
  vs.status("idle", 1620);
  const c3 = vs.status("recording", 1700);  assert.deepEqual(kinds(c3), ["cancel"]);
  vs.cmdExit(cmdId(c3, "cancel"), 0, 1710);
  vs.status("idle", 1720);
  const c4 = vs.status("recording", 1800);  assert.deepEqual(kinds(c4), []);          // budget exhausted, escalate
  assert.equal(byType(c4, "restart").length, 0);                                      // never while recording
  const quiet = vs.status("idle", 1900);
  assert.equal(byType(quiet, "restart").length, 1);
  assert.equal(vs.nextDeadline(), 1900 + 10000);
  assert.deepEqual(vs.status("stopped", 2000), []);                                   // ignored while restart pending
  const rr = vs.restartResult(true, 3000);
  assert.equal(byType(rr, "poll").length, 1);
  vs.status("idle", 3100, { fresh: true });
  assert.equal(vs.nextDeadline(), 3100 + 1500);
  assert.equal(stateOf(vs.advance(4600)), "idle");
  assert.equal(vs.snapshot().owner, null);
});

test("from a confirmed session, a recording after an accepted idle is external: observed, never cancelled, pauses the settle window", () => {
  const vs = hidRecording();                                       // confirmed entry: nothing of ours can be pending
  const fx = vs.abort(300);
  vs.cmdExit(cmdId(fx, "cancel"), 0, 310);
  vs.status("idle", 320, { fresh: true });                       // accepted -> settle armed at 1820
  assert.equal(vs.nextDeadline(), 1820);
  const ext = vs.status("recording", 900);                        // F9 pressed by the user
  assert.deepEqual(kinds(ext), []);                               // no cancel
  assert.equal(vs.snapshot().cancels, 1);
  assert.equal(vs.snapshot().state, "recovering");
  assert.equal(vs.nextDeadline(), 15300);                         // settle paused; only the budget remains
  vs.status("transcribing", 1500);
  assert.deepEqual(kinds(vs.advance(1820)), []);
  const back = vs.status("idle", 2000);                           // transition after cancelAt -> re-armed
  assert.equal(vs.nextDeadline(), 3500);
  assert.equal(stateOf(vs.advance(3500)), "idle");
  void back;
});

test("late recording during recovering is never adopted as a keyboard session", () => {
  const vs = hidRecording();
  vs.abort(300);
  vs.status("recording", 400);
  assert.equal(vs.snapshot().state, "recovering");
  assert.equal(vs.snapshot().owner, null);
});

test("failed restart or restart timeout ends unconfigured", () => {
  const vs = hidRecording();
  const fx = vs.abort(300);
  vs.cmdExit(cmdId(fx, "cancel"), 0, 310);
  const b = vs.advance(15300);                                    // recovery budget expires, backend idle-unknown -> restart
  assert.equal(byType(b, "restart").length, 1);
  assert.equal(stateOf(vs.restartResult(false, 15400)), "unconfigured");
  const vs2 = hidRecording();
  const f2 = vs2.abort(300);
  vs2.cmdExit(cmdId(f2, "cancel"), 0, 310);
  vs2.advance(15300);
  assert.equal(stateOf(vs2.advance(25300)), "unconfigured");
});

test("stop timeout: backend stays recording after stop -> recovering; after restart budget -> unconfigured", () => {
  const vs = hidRecording();
  vs.hidRelease(500);
  const fx = vs.advance(15500);
  assert.deepEqual(kinds(fx), ["cancel"]);
  assert.equal(stateOf(fx), "recovering");
  vs.status("recording", 15600);                                  // still recording: cancel #2
  vs.status("recording", 15700);                                  // #3
  assert.equal(vs.snapshot().cancels, 3);
  const r = vs.advance(15500 + 15000);                            // budget: escalate, but backend busy -> no restart yet
  assert.equal(byType(r, "restart").length, 0);
  assert.equal(byType(vs.status("idle", 31000), "restart").length, 1);
});

test("stale command callbacks from before recovery are ignored", () => {
  const vs = createVoiceSession(cfg());
  const fx = vs.hidPress(0);
  const startId = cmdId(fx, "start");
  vs.abort(100);
  assert.deepEqual(vs.cmdExit(startId, 1, 120), []);
  assert.equal(vs.snapshot().cancels, 1);
});

test("stopped during recovery (not restart-pending) is unconfigured; healthy idle restores idle", () => {
  const vs = hidRecording();
  vs.abort(300);
  assert.equal(stateOf(vs.status("stopped", 400)), "unconfigured");
  assert.equal(stateOf(vs.status("idle", 500, { fresh: true })), "idle");
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/VoiceSession.test.mjs`
Expected: `# pass 36`, `# fail 0`. Fix the module if needed; keep tests as the spec's executable form.

- [ ] **Step 3: Commit**

```bash
git add tests/VoiceSession.test.mjs lib/VoiceSession.mjs
git commit -m "test(core): voice session recovery, settle window and escalation coverage"
```

---

### Task 12: MicApply — the mic apply contract (§3)

**Files:**
- Create: `lib/MicApply.mjs`
- Test: `tests/MicApply.test.mjs`

**Interfaces:**
- Produces `createMicApply({ voice })` where `voice` is a VoiceSession (uses `voice.snapshot()` and `voice.gate`). Methods (all return effects unless noted):
  - `request(mode, now, { nodeName })` → `{ effects, result }` with `result` = `{ ok: true, operationId }` or `{ ok: false, reason: "busy" | "invalid-mode" | "no-node" }`
  - `statusOf(operationId)` → `{ state: "queued"|"applying"|"verifying"|"rollingBack"|"succeeded"|"failed", phase, mode, error?, rollback? }` or `null` for an unknown id (never assume success); `phase` ∈ `get | set | restart | verify | rollback-get | rollback-set | rollback-restart | rollback-verify | null` for diagnostics
  - `backend(cls, now, { fresh })` — same feed as VoiceSession gets; MicApply keeps its own freshness view
  - `cmdExit(id, code, stdout, now)` — **phase contract:** the module dispatches on the operation's current phase, not on `kind`. In phases `get` and `rollback-get` the `stdout` is parsed with `parseConfigGet()`; `get` snapshots `prev` (literal + presence) and fails the operation before any mutation if the output is unparsable; `rollback-get` compares the literal with the value this operation wrote and refuses to mutate on mismatch. Phases `set`/`rollback-set` look only at the exit code; `restart`/`rollback-restart` emit `verify`. A `cmdExit` that arrives after a reset only drains the outstanding-command count.
  - `verifyResult(ok, now)`, `externalRecording(now)`, `reset(now)`, `systemdJob(pending, now)`, `advance(now)`, `nextDeadline()`, `pending()` → boolean
  - **systemd job contract (host side, §3):** whenever an operation is queued or a rollback is deferred, and once before every mutation, the host polls `systemctl --user show voxtype --property=Job,ActiveState,InvocationID --value` (1 s cadence) and calls `systemdJob(job !== "", now)`. `Job` prints `<id> <type>` while a job is queued or running and is removed by systemd on completion, so non-empty ⇒ pending. Origin does not matter — an external `restart`/`stop` job blocks us exactly like our own. "Job gone but unit not yet active" is not a job question: it is caught by `verify` (active + new `InvocationID` + fresh idle). A job that never clears is bounded by the 60 s wait/defer deadlines → `wait-timeout` (no mutation yet) or `rollback: "unresolved"` + `unconfigured`.
  - **Reset priority and rollback rules (§3):** `reset` while `queued` → `failed` with no mutation. `reset` after the `set` command was issued (mutated) → the operation is `failed` immediately, no further apply step runs, and rollback is **deferred** until the voice session is idle, the backend reports a fresh idle, every outstanding plugin command has exited, and no systemd job is pending; the deferred rollback is bounded by 60 s, after which the outcome is `unresolved` and the host is told `unconfigured`. Every rollback (immediate or deferred) starts by re-reading `audio.device`; if the literal no longer equals the value this operation wrote, someone else edited the file: no mutation, `rollback: "conflict"`, a `conflict` effect, and Doctor's `voxtype-device` row shows the mismatch until an explicit apply reconciles it.
- Effects: `cmd` (`kind: "get"|"set"|"unset"|"restart"`, `argv`), `poll`, `verify` (host: `systemctl --user is-active voxtype` = active **and** a new `InvocationID` **and** a fresh `idle` within 10 s), `commit` (`{ mode }` — host writes `voice.mic`), `done` (`{ operationId, state, error?, rollback? }` with `rollback ∈ verified | failed | conflict | deferred | unresolved`), `conflict` (`{ expected, found }`), `unconfigured` (`{ reason }`), `hud`.
- Also exports `parseConfigGet(stdout)` → `{ effective, literal, literalKnown }` where `literal === null` means the key is absent from the file. Voxtype's `--json` field names are confirmed in Plan 2 task 0 from a real `voxtype config get audio.device --json`; the parser accepts `value`/`effective` for the effective value and `file_value`/`file`/`literal` for the literal, and `literalKnown` is false when none of those keys exists.

- [ ] **Step 1: Write the failing tests**

`tests/MicApply.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMicApply, parseConfigGet } from "../lib/MicApply.mjs";
import { createVoiceSession } from "../lib/VoiceSession.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";
import { byType } from "./helpers.mjs";

const kinds = (fx) => byType(fx, "cmd").map(c => c.kind);
const cmdId = (fx, kind) => byType(fx, "cmd").find(c => c.kind === kind).id;
const GET_OUT = JSON.stringify({ key: "audio.device", value: "default", file_value: null });

function ready() {
  const voice = createVoiceSession(normalizeConfig(DEFAULT_CONFIG).config);
  voice.status("idle", 0, { fresh: true });
  const mic = createMicApply({ voice });
  mic.backend("idle", 0, { fresh: true });
  return { voice, mic };
}

test("parseConfigGet distinguishes absent literal from a set one", () => {
  assert.deepEqual(parseConfigGet(GET_OUT), { effective: "default", literal: null, literalKnown: true });
  assert.deepEqual(parseConfigGet(JSON.stringify({ value: "G20S PRO", file_value: "G20S PRO" })), { effective: "G20S PRO", literal: "G20S PRO", literalKnown: true });
  assert.equal(parseConfigGet(JSON.stringify({ value: "x" })).literalKnown, false);
  assert.equal(parseConfigGet("garbage").literalKnown, false);
});

test("happy path: get -> set -> restart -> verify -> commit -> succeeded, gate released", () => {
  const { voice, mic } = ready();
  const { effects, result } = mic.request("remote", 10, { nodeName: "G20S PRO" });
  assert.equal(result.ok, true);
  assert.deepEqual(kinds(effects), ["get"]);
  assert.deepEqual(byType(effects, "cmd")[0].argv, ["voxtype", "config", "get", "audio.device", "--json"]);
  assert.equal(voice.gate.busy(), true);
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 20);
  assert.deepEqual(byType(set, "cmd")[0].argv, ["voxtype", "config", "set", "audio.device", "G20S PRO"]);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 30);
  assert.deepEqual(byType(restart, "cmd")[0].argv, ["systemctl", "--user", "restart", "voxtype"]);
  const verify = mic.cmdExit(cmdId(restart, "restart"), 0, "", 40);
  assert.equal(byType(verify, "verify").length, 1);
  assert.equal(mic.statusOf(result.operationId).state, "verifying");
  assert.equal(mic.nextDeadline(), 40 + 10000);
  const done = mic.verifyResult(true, 2000);
  assert.deepEqual(byType(done, "commit"), [{ type: "commit", mode: "remote" }]);
  assert.equal(byType(done, "done")[0].state, "succeeded");
  assert.equal(mic.statusOf(result.operationId).state, "succeeded");
  assert.equal(voice.gate.busy(), false);
  assert.equal(mic.pending(), false);
});

test("second request while one is pending is busy; invalid mode and missing node are rejected", () => {
  const { mic } = ready();
  assert.equal(mic.request("remote", 0, { nodeName: "N" }).result.ok, true);
  assert.deepEqual(mic.request("system", 1, {}).result, { ok: false, reason: "busy" });
  const { mic: m2 } = ready();
  assert.deepEqual(m2.request("wifi", 0, {}).result, { ok: false, reason: "invalid-mode" });
  assert.deepEqual(m2.request("remote", 0, {}).result, { ok: false, reason: "no-node" });
});

test("waits without mutation while the session is busy; 60s timeout fails with nothing to roll back", () => {
  const { voice, mic } = ready();
  voice.hidPress(0); voice.status("recording", 50);
  const { effects, result } = mic.request("system", 100, {});
  assert.deepEqual(kinds(effects), []);
  assert.ok(byType(effects, "hud").some(h => /applies after this dictation/.test(h.text)));
  assert.equal(mic.statusOf(result.operationId).state, "queued");
  const fx = mic.advance(60100);
  assert.equal(byType(fx, "done")[0].state, "failed");
  assert.equal(byType(fx, "done")[0].error, "wait-timeout");
  assert.deepEqual(kinds(fx), []);
});

test("once the session goes idle a queued request needs a fresh backend idle, then proceeds", () => {
  const { voice, mic } = ready();
  const st = voice.hidPress(0); voice.cmdExit(cmdId(st, "start"), 0, 10); voice.status("recording", 50);
  const { result } = mic.request("system", 100, {});
  const sp = voice.hidRelease(200); voice.cmdExit(cmdId(sp, "stop"), 0, 210);
  voice.status("transcribing", 250); voice.status("idle", 1400);
  const p = mic.advance(1401);                                  // session idle, but our backend view (t=0) is stale -> poll
  assert.equal(byType(p, "poll").length, 1);
  const go = mic.backend("idle", 1450, { fresh: true });
  assert.deepEqual(kinds(go), ["get"]);
  assert.equal(mic.statusOf(result.operationId).state, "applying");
});

test("verify failure rolls back with unset when the old literal was absent, then reports failed", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  const chk = mic.verifyResult(false, 5000);
  assert.deepEqual(kinds(chk), ["get"]);                         // re-read before touching the file
  assert.equal(mic.statusOf(result.operationId).state, "rollingBack");
  const rb = mic.cmdExit(cmdId(chk, "get"), 0, JSON.stringify({ value: "N", file_value: "N" }), 5000);
  assert.deepEqual(byType(rb, "cmd")[0].argv, ["voxtype", "config", "unset", "audio.device"]);
  const r2 = mic.cmdExit(cmdId(rb, "unset"), 0, "", 5001);
  const v2 = mic.cmdExit(cmdId(r2, "restart"), 0, "", 5002);
  assert.equal(byType(v2, "verify").length, 1);
  const done = mic.verifyResult(true, 6000);
  const d = byType(done, "done")[0];
  assert.equal(d.state, "failed");
  assert.equal(d.error, "verify-failed");
  assert.equal(d.rollback, "verified");
  assert.equal(byType(done, "commit").length, 0);
});

test("rollback restores a previous literal with set; rollback verify failure is unconfigured", () => {
  const { mic } = ready();
  const { effects } = mic.request("system", 0, {});
  const set = mic.cmdExit(cmdId(effects, "get"), 0, JSON.stringify({ value: "G20S PRO", file_value: "G20S PRO" }), 1);
  assert.deepEqual(byType(set, "cmd")[0].argv, ["voxtype", "config", "set", "audio.device", "default"]);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  const chk = mic.verifyResult(false, 100);
  const rb = mic.cmdExit(cmdId(chk, "get"), 0, JSON.stringify({ value: "default", file_value: "default" }), 100);
  assert.deepEqual(byType(rb, "cmd")[0].argv, ["voxtype", "config", "set", "audio.device", "G20S PRO"]);
  const r2 = mic.cmdExit(cmdId(rb, "set"), 0, "", 101);
  mic.cmdExit(cmdId(r2, "restart"), 0, "", 102);
  const bad = mic.verifyResult(false, 200);
  assert.equal(byType(bad, "unconfigured")[0].reason, "voxtype restart failed");
  assert.equal(byType(bad, "done")[0].rollback, "failed");
});

test("verify timeout behaves like a failed verify", () => {
  const { mic } = ready();
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  const fx = mic.advance(3 + 10000);
  assert.deepEqual(kinds(fx), ["get"]);                           // rollback begins with the conflict check
});

test("rollback refuses to overwrite an external edit: conflict, no mutation, Doctor reconciles", () => {
  const { mic, voice } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  const chk = mic.verifyResult(false, 100);
  const fx = mic.cmdExit(cmdId(chk, "get"), 0, JSON.stringify({ value: "other", file_value: "other" }), 101);
  assert.deepEqual(kinds(fx), []);
  assert.deepEqual(byType(fx, "conflict"), [{ type: "conflict", expected: "N", found: "other" }]);
  const d = byType(fx, "done")[0];
  assert.equal(d.state, "failed"); assert.equal(d.rollback, "conflict");
  assert.equal(mic.statusOf(result.operationId).rollback, "conflict");
  assert.equal(voice.gate.busy(), false);
});

test("a pending systemd job blocks the initial mutation until it clears", () => {
  const { mic } = ready();
  mic.systemdJob(true, 0);
  const { effects, result } = mic.request("remote", 1, { nodeName: "N" });
  assert.deepEqual(kinds(effects), []);
  assert.equal(mic.statusOf(result.operationId).state, "queued");
  assert.deepEqual(kinds(mic.systemdJob(false, 100)), ["get"]);
  assert.equal(mic.statusOf(result.operationId).phase, "get");
});

test("get failure or unparsable output fails before any mutation", () => {
  const { mic, voice } = ready();
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
  const fx = mic.cmdExit(cmdId(effects, "get"), 0, "not json", 1);
  assert.equal(byType(fx, "done")[0].error, "preflight-failed");
  assert.deepEqual(kinds(fx), []);
  assert.equal(voice.gate.busy(), false);
});

test("reset while queued fails without mutation", () => {
  const { voice, mic } = ready();
  const st = voice.hidPress(0); voice.cmdExit(cmdId(st, "start"), 0, 5); voice.status("recording", 50);
  const { result } = mic.request("system", 100, {});
  const fx = mic.reset(150);
  assert.equal(byType(fx, "done")[0].error, "reset");
  assert.deepEqual(kinds(fx), []);
  assert.equal(mic.statusOf(result.operationId).state, "failed");
  assert.equal(mic.pending(), false);
});

test("reset while the set command is in flight: failed now, rollback deferred until set exits and backend is idle", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);          // set issued, not yet exited
  const rs = mic.reset(2);
  assert.equal(byType(rs, "done")[0].rollback, "deferred");
  assert.equal(mic.statusOf(result.operationId).state, "failed");
  assert.deepEqual(kinds(mic.backend("idle", 10, { fresh: true })), []);  // set still outstanding
  const after = mic.cmdExit(cmdId(set, "set"), 0, "", 20);
  assert.deepEqual(kinds(after), ["get"]);                                  // no apply step continues; deferred rollback starts with the conflict check
  assert.equal(mic.statusOf(result.operationId).state, "rollingBack");      // status reflects the live rollback of the failed operation
  assert.equal(mic.pending(), true);
});

test("reset while the restart is in flight never launches a second restart", () => {
  const { mic } = ready();
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);                // restart issued
  mic.reset(3);
  assert.deepEqual(kinds(mic.backend("idle", 100, { fresh: true })), []);  // restart still running
  const rb = mic.cmdExit(cmdId(restart, "restart"), 0, "", 200);          // restart exited, backend fresh -> rollback may begin
  assert.deepEqual(kinds(rb), ["get"]);
  const r2 = mic.cmdExit(cmdId(rb, "get"), 0, JSON.stringify({ value: "N", file_value: "N" }), 211);
  assert.deepEqual(kinds(r2), ["unset"]);
  const r3 = mic.cmdExit(cmdId(r2, "unset"), 0, "", 212);
  assert.deepEqual(kinds(r3), ["restart"]);                                 // exactly one rollback restart
});

test("a live systemd job blocks the deferred rollback until it clears; the 60s bound ends unresolved", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);                          // client exited; job may still be live
  mic.systemdJob(true, 4);
  mic.reset(5);
  assert.deepEqual(kinds(mic.backend("idle", 100, { fresh: true })), []);
  assert.deepEqual(kinds(mic.systemdJob(false, 700)), []);                  // job cleared, but the idle view is stale now
  assert.deepEqual(kinds(mic.backend("idle", 710, { fresh: true })), ["get"]);

  const { mic: m2 } = ready();
  const { effects: e2, result: r2 } = m2.request("remote", 0, { nodeName: "N" });
  const s2 = m2.cmdExit(cmdId(e2, "get"), 0, GET_OUT, 1);
  m2.cmdExit(cmdId(s2, "set"), 0, "", 2);
  m2.systemdJob(true, 3);
  m2.reset(4);
  const u = m2.advance(4 + 60000);
  assert.equal(byType(u, "unconfigured")[0].reason, "mic change unresolved");
  assert.equal(m2.statusOf(r2.operationId).rollback, "unresolved");
  void result;
});

test("external recording during apply interrupts; 60s without a quiet system ends unresolved", () => {
  const { mic } = ready();
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  const fx = mic.externalRecording(10);
  assert.equal(byType(fx, "done")[0].error, "interrupted");
  assert.equal(byType(fx, "done")[0].rollback, "deferred");
  const u = mic.advance(10 + 60000);
  assert.equal(byType(u, "unconfigured")[0].reason, "mic change unresolved");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/MicApply.test.mjs` — Expected: module not found.

- [ ] **Step 3: Write MicApply.mjs**

`lib/MicApply.mjs`:
```js
// Spec §3 "Mic apply contract": wait → reserve+snapshot → apply+restart → verify → commit, with rollback,
// reset priority, deferred rollback, systemd-job serialization and external-edit conflict detection.
const WAIT_MS = 60000, VERIFY_MS = 10000, DEFER_MS = 60000, FRESH_MS = 500;
const MODES = ["remote", "system"];

export function parseConfigGet(stdout) {
  let j;
  try { j = JSON.parse(String(stdout || "")); } catch (e) { return { effective: null, literal: null, literalKnown: false }; }
  if (!j || typeof j !== "object") return { effective: null, literal: null, literalKnown: false };
  const effective = j.value !== undefined ? j.value : (j.effective !== undefined ? j.effective : null);
  for (const k of ["file_value", "file", "literal"]) {
    if (Object.prototype.hasOwnProperty.call(j, k)) return { effective, literal: j[k] === undefined ? null : j[k], literalKnown: true };
  }
  return { effective, literal: null, literalKnown: false };
}

export function createMicApply({ voice }) {
  let op = null;                                  // current operation
  const history = new Map();                      // id -> final status
  let seq = 0, cmdSeq = 0;
  const cmds = new Map();                         // id -> kind
  let backend = { cls: "unknown", at: -Infinity, fresh: false };
  let dl = {};
  let deferred = null;                            // { id, mode, prev, setValue, error } rollback waiting for a quiet system
  let jobPending = false;

  const hud = (out, text) => out.push({ type: "hud", text });
  const cmd = (out, kind, argv) => { const id = ++cmdSeq; cmds.set(id, kind); out.push({ type: "cmd", id, kind, argv }); return id; };
  const restartArgv = ["systemctl", "--user", "restart", "voxtype"];
  const getArgv = ["voxtype", "config", "get", "audio.device", "--json"];
  const targetValue = (o) => (o.mode === "remote" ? o.nodeName : "default");
  const fresh = (now) => backend.cls === "idle" && backend.fresh && now - backend.at <= FRESH_MS;

  function record(id, state, extra) { history.set(id, { state, phase: null, ...extra }); }

  function finish(out, state) {
    record(op.id, state, { mode: op.mode, error: op.error, rollback: op.rollback });
    out.push({ type: "done", operationId: op.id, state, error: op.error, rollback: op.rollback });
    voice.gate.release("mic-apply");
    dl = {};
    op = null;
  }

  function beginRollback(out) {                   // every rollback starts with the external-edit check
    op.state = "rollingBack"; op.phase = "rollback-get";
    hud(out, "restoring previous microphone");
    delete dl.verify;
    cmd(out, "get", getArgv);
  }

  function tryReserve(out, now) {
    if (!op || op.state !== "queued") return;
    const s = voice.snapshot();
    if (s.state !== "idle" || s.pendingCmds > 0) return;
    if (!fresh(now)) { if (!op.polled) { op.polled = true; out.push({ type: "poll" }); } return; }
    if (jobPending) return;                                  // §3: never mutate while a systemd job is pending
    if (!voice.gate.acquire("mic-apply")) return;
    delete dl.wait;
    op.state = "applying"; op.phase = "get";
    hud(out, "changing microphone…");
    cmd(out, "get", getArgv);
  }

  function tryDeferred(out, now) {
    if (!deferred || op) return;
    if (cmds.size > 0 || jobPending || !fresh(now) || voice.snapshot().state !== "idle") return;
    const d = deferred; deferred = null; delete dl.defer;
    op = { id: d.id, mode: d.mode, state: "rollingBack", phase: null, prev: d.prev, setValue: d.setValue, mutated: true, error: d.error, rollback: undefined };
    beginRollback(out);
  }

  return {
    request(mode, now, opts = {}) {
      const out = [];
      if (op || deferred) return { effects: out, result: { ok: false, reason: "busy" } };
      if (!MODES.includes(mode)) return { effects: out, result: { ok: false, reason: "invalid-mode" } };
      if (mode === "remote" && !opts.nodeName) return { effects: out, result: { ok: false, reason: "no-node" } };
      op = { id: `mic-${++seq}`, mode, nodeName: opts.nodeName || null, state: "queued", phase: null, prev: null, setValue: null, mutated: false, error: undefined, rollback: undefined, polled: false };
      dl.wait = now + WAIT_MS;
      if (voice.snapshot().state !== "idle") hud(out, "mic change applies after this dictation");
      tryReserve(out, now);
      return { effects: out, result: { ok: true, operationId: op.id } };
    },

    statusOf(id) {
      if (op && op.id === id) return { state: op.state, phase: op.phase, mode: op.mode, error: op.error, rollback: op.rollback };
      return history.get(id) || null;
    },

    pending() { return op !== null || deferred !== null; },

    backend(cls, now, opts = {}) {
      backend = { cls, at: now, fresh: !!opts.fresh };
      const out = [];
      tryDeferred(out, now);
      tryReserve(out, now);
      return out;
    },

    systemdJob(pending, now) {
      jobPending = !!pending;
      const out = [];
      tryDeferred(out, now);
      tryReserve(out, now);
      return out;
    },

    cmdExit(id, code, stdout, now) {
      const kind = cmds.get(id);
      const out = [];
      cmds.delete(id);
      if (!kind) return out;
      if (!op) { tryDeferred(out, now); return out; }          // a command from a reset operation drained
      switch (op.phase) {
        case "get": {
          const parsed = parseConfigGet(stdout);
          if (code !== 0 || !parsed.literalKnown) { op.error = "preflight-failed"; finish(out, "failed"); return out; }
          op.prev = parsed;
          op.phase = "set"; op.mutated = true; op.setValue = String(targetValue(op));
          cmd(out, "set", ["voxtype", "config", "set", "audio.device", op.setValue]);
          return out;
        }
        case "set":
          if (code !== 0) { op.error = "set-failed"; beginRollback(out); return out; }
          op.phase = "restart"; cmd(out, "restart", restartArgv); return out;
        case "restart":
          op.phase = "verify"; op.state = "verifying"; out.push({ type: "verify" }); dl.verify = now + VERIFY_MS; return out;
        case "rollback-get": {
          const parsed = parseConfigGet(stdout);
          const found = parsed.literalKnown ? parsed.literal : undefined;
          if (code !== 0 || !parsed.literalKnown || String(found) !== op.setValue) {
            op.rollback = "conflict";
            out.push({ type: "conflict", expected: op.setValue, found: found === undefined ? null : found });
            hud(out, "microphone config changed externally");
            finish(out, "failed");
            return out;
          }
          op.phase = "rollback-set";
          if (op.prev.literal === null) cmd(out, "unset", ["voxtype", "config", "unset", "audio.device"]);
          else cmd(out, "set", ["voxtype", "config", "set", "audio.device", String(op.prev.literal)]);
          return out;
        }
        case "rollback-set":
          if (code !== 0) { op.rollback = "failed"; out.push({ type: "unconfigured", reason: "voxtype restart failed" }); finish(out, "failed"); return out; }
          op.phase = "rollback-restart"; cmd(out, "restart", restartArgv); return out;
        case "rollback-restart":
          op.phase = "rollback-verify"; out.push({ type: "verify" }); dl.verify = now + VERIFY_MS; return out;
        default:
          return out;
      }
    },

    verifyResult(ok, now) {
      const out = [];
      if (!op) return out;
      delete dl.verify;
      void now;
      if (op.phase === "verify") {
        if (ok) { out.push({ type: "commit", mode: op.mode }); hud(out, ""); finish(out, "succeeded"); return out; }
        op.error = "verify-failed"; beginRollback(out); return out;
      }
      if (op.phase === "rollback-verify") {
        if (ok) { op.rollback = "verified"; hud(out, ""); finish(out, "failed"); return out; }
        op.rollback = "failed"; out.push({ type: "unconfigured", reason: "voxtype restart failed" }); finish(out, "failed"); return out;
      }
      return out;
    },

    externalRecording(now) { return this.reset(now, "interrupted"); },

    reset(now, reason = "reset") {
      const out = [];
      if (!op) return out;
      op.error = reason;
      if (!op.mutated) { finish(out, "failed"); return out; }
      // Mutated: stop here; rollback runs only once the system is quiet (§3 reset priority / no competing restarts).
      deferred = { id: op.id, mode: op.mode, prev: op.prev, setValue: op.setValue, error: reason };
      dl = { defer: now + DEFER_MS };
      record(op.id, "failed", { mode: op.mode, error: reason, rollback: "deferred" });
      out.push({ type: "done", operationId: op.id, state: "failed", error: reason, rollback: "deferred" });
      hud(out, "mic change interrupted");
      voice.gate.release("mic-apply");
      op = null;
      return out;
    },

    advance(now) {
      const out = [];
      if (dl.wait !== undefined && dl.wait <= now && op && op.state === "queued") { delete dl.wait; op.error = "wait-timeout"; finish(out, "failed"); return out; }
      if (dl.verify !== undefined && dl.verify <= now && op) { delete dl.verify; return this.verifyResult(false, now); }
      if (dl.defer !== undefined && dl.defer <= now && deferred) {
        delete dl.defer;
        record(deferred.id, "failed", { mode: deferred.mode, error: deferred.error, rollback: "unresolved" });
        deferred = null;
        out.push({ type: "unconfigured", reason: "mic change unresolved" });
        return out;
      }
      if (op && op.state === "queued") tryReserve(out, now);
      tryDeferred(out, now);
      return out;
    },

    nextDeadline() {
      let d = null;
      for (const k of Object.keys(dl)) if (dl[k] !== undefined && (d === null || dl[k] < d)) d = dl[k];
      return d;
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/MicApply.test.mjs`
Expected: `# pass 16`, `# fail 0`. Fix the module if needed.

- [ ] **Step 5: Commit**

```bash
git add lib/MicApply.mjs tests/MicApply.test.mjs
git commit -m "feat(core): mic apply transaction with verify, commit and rollback"
```

---

### Task 13: SelfTest — transport self-test lease and recorder (§7 step 6)

**Files:**
- Create: `lib/SelfTest.mjs`
- Test: `tests/SelfTest.test.mjs`

**Interfaces:**
- Produces `createSelfTest({ supportedKeys, gate, leaseMs = 30000 })`:
  - `arm(now, ctx)` → `{ ok: true, id }` or `{ ok: false, reason: "busy" }`; `ctx = { voiceIdle, backendIdleFresh, heldKeys, pendingCmds }`; acquires `gate.acquire("selftest")`.
  - `record(source, key, edge, now)` → boolean; `source` ∈ `"shortcut" | "ipc"`, `edge` ∈ `"down" | "up"`. Only counted while active; `ipc` events are tracked separately and never satisfy the transport check.
  - `active()`, `status(id, now)` → `{ active, remainingMs, failed? }` or `null`.
  - `report(id, now)` → `{ ok, missing, extras, held, counts, failed? }` and ends the lease. Unknown/expired id → `{ ok: false, reason: "unknown" | "expired" }`.
  - `disarm(id, now)` → boolean. `externalRecording(now)` → **ends the lease immediately** (gate released, normal dispatch and observation resume, the external session is not touched); `record()` returns `false` from then on, `status(id)` reports `{ active: false, failed: "external-recording" }`, and `report(id)` still returns the full failure (`ok: false`, `failed`, counts so far) exactly once. `advance(now)` → `[{ type: "selftestExpired", id }]` on expiry; `nextDeadline()`.
  - **Lifecycle rules:** ids are `st-<n>` with a monotonically increasing `n` and are never reused. A failure record is consumed by the first `report(id)`; every later `report(id)` for that id returns `{ ok: false, reason: "expired" }`. `disarm(id)` on an ended lease (failed, reported or expired) returns `false` and changes nothing. `advance()` emits `selftestExpired` at most once per lease and never for a lease that already ended. A `status(id)` of `null` means the id is neither active nor holding an unreported failure.

- [ ] **Step 1: Write the failing tests**

`tests/SelfTest.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSelfTest } from "../lib/SelfTest.mjs";

function gate() {
  const held = new Set();
  return { acquire: (n) => (held.size ? false : (held.add(n), true)), release: (n) => held.delete(n), busy: () => held.size > 0, held };
}
const okCtx = { voiceIdle: true, backendIdleFresh: true, heldKeys: [], pendingCmds: 0 };
const mk = () => { const g = gate(); return { g, st: createSelfTest({ supportedKeys: ["up", "ok"], gate: g }) }; };

test("arm requires idle voice, fresh backend idle, no held keys/pending commands and a free gate", () => {
  const { g, st } = mk();
  assert.equal(st.arm(0, { ...okCtx, voiceIdle: false }).ok, false);
  assert.equal(st.arm(0, { ...okCtx, heldKeys: ["ok"] }).ok, false);
  assert.equal(st.arm(0, { ...okCtx, pendingCmds: 1 }).ok, false);
  assert.equal(st.arm(0, { ...okCtx, backendIdleFresh: false }).ok, false);
  g.acquire("mic-apply");
  assert.equal(st.arm(0, okCtx).ok, false);
  g.release("mic-apply");
  const a = st.arm(0, okCtx);
  assert.equal(a.ok, true);
  assert.equal(st.active(), true);
  assert.equal(g.busy(), true);
  assert.equal(st.nextDeadline(), 30000);
});

test("report lists exactly one press and release per supported key; ends lease and releases gate", () => {
  const { g, st } = mk();
  const { id } = st.arm(0, okCtx);
  st.record("shortcut", "up", "down", 10); st.record("shortcut", "up", "up", 20);
  st.record("shortcut", "ok", "down", 30); st.record("shortcut", "ok", "up", 40);
  const r = st.report(id, 50);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []); assert.deepEqual(r.extras, []); assert.deepEqual(r.held, []);
  assert.equal(st.active(), false);
  assert.equal(g.busy(), false);
});

test("missing release, extra events and held keys fail the report with names", () => {
  const { st } = mk();
  const { id } = st.arm(0, okCtx);
  st.record("shortcut", "up", "down", 10);                   // never released
  st.record("shortcut", "ok", "down", 30); st.record("shortcut", "ok", "up", 40); st.record("shortcut", "ok", "up", 41);
  const r = st.report(id, 50);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["up"]);
  assert.deepEqual(r.extras, ["ok"]);
  assert.deepEqual(r.held, ["up"]);
});

test("ipc-injected events are counted separately and cannot pass the transport check", () => {
  const { st } = mk();
  const { id } = st.arm(0, okCtx);
  st.record("ipc", "up", "down", 1); st.record("ipc", "up", "up", 2);
  st.record("shortcut", "ok", "down", 3); st.record("shortcut", "ok", "up", 4);
  const r = st.report(id, 5);
  assert.deepEqual(r.missing, ["up"]);
  assert.equal(r.counts.ipc.up.down, 1);
});

test("events outside an active lease are not recorded", () => {
  const { st } = mk();
  assert.equal(st.record("shortcut", "up", "down", 0), false);
});

test("expiry emits selftestExpired, releases the gate, and report afterwards is an error not partial data", () => {
  const { g, st } = mk();
  const { id } = st.arm(0, okCtx);
  st.record("shortcut", "up", "down", 10); st.record("shortcut", "up", "up", 20);
  assert.deepEqual(st.advance(29999), []);
  assert.deepEqual(st.advance(30000), [{ type: "selftestExpired", id }]);
  assert.equal(g.busy(), false);
  assert.deepEqual(st.report(id, 30001), { ok: false, reason: "expired" });
  assert.deepEqual(st.report("nope", 1), { ok: false, reason: "unknown" });
});

test("external recording ends the lease at once: gate released, no more injections, failure still reportable once", () => {
  const { g, st } = mk();
  const { id } = st.arm(0, okCtx);
  st.record("shortcut", "up", "down", 10); st.record("shortcut", "up", "up", 20);
  assert.deepEqual(st.externalRecording(100), [{ type: "selftestFailed", id, reason: "external-recording" }]);
  assert.equal(st.active(), false);
  assert.equal(g.busy(), false);
  assert.equal(st.record("shortcut", "ok", "down", 110), false);
  assert.deepEqual(st.status(id, 200), { active: false, remainingMs: 0, failed: "external-recording" });
  const r = st.report(id, 300);
  assert.equal(r.ok, false); assert.equal(r.failed, "external-recording");
  assert.deepEqual(r.missing, ["ok"]);
  assert.equal(r.counts.shortcut.up.down, 1);
  assert.deepEqual(st.report(id, 301), { ok: false, reason: "expired" });   // reported exactly once
  assert.equal(st.disarm(id, 302), false);                                  // ended lease: no-op
  assert.deepEqual(st.advance(40000), []);                                  // no expiry event for an ended lease
  const { id: id2 } = st.arm(400, okCtx);
  assert.notEqual(id2, id);                                                 // ids are never reused
  assert.equal(st.disarm(id2, 401), true);
  assert.equal(st.disarm(id2, 402), false);
  assert.equal(g.busy(), false);
  assert.equal(st.status(id2, 403), null);
});
```

- [ ] **Step 2: Run tests to verify they fail** — `node --test tests/SelfTest.test.mjs` → module not found.

- [ ] **Step 3: Write SelfTest.mjs**

`lib/SelfTest.mjs`:
```js
// Spec §7 step 6: exclusive self-test lease; raw transport counts kept apart from IPC injections;
// an external recording ends the lease immediately and the failure stays reportable once.
export function createSelfTest({ supportedKeys, gate, leaseMs = 30000 }) {
  let lease = null;          // { id, until, counts: {shortcut:{}, ipc:{}}, down: Set }
  let seq = 0;
  const failed = new Map();  // id -> report of a lease that ended in failure, retrievable once
  const empty = () => ({ down: 0, up: 0 });

  function compute(l) {
    const sc = l.counts.shortcut;
    const missing = supportedKeys.filter(k => !sc[k] || sc[k].down < 1 || sc[k].up < 1);
    const extras = Object.keys(sc).filter(k => !supportedKeys.includes(k) || sc[k].down > 1 || sc[k].up > 1);
    const held = [...l.down];
    return { missing, extras, held, counts: l.counts };
  }
  function end() { if (!lease) return; gate.release("selftest"); lease = null; }

  return {
    arm(now, ctx) {
      if (lease || !ctx || !ctx.voiceIdle || !ctx.backendIdleFresh || (ctx.heldKeys && ctx.heldKeys.length) || (ctx.pendingCmds || 0) > 0) return { ok: false, reason: "busy" };
      if (!gate.acquire("selftest")) return { ok: false, reason: "busy" };
      lease = { id: `st-${++seq}`, until: now + leaseMs, counts: { shortcut: {}, ipc: {} }, down: new Set() };
      return { ok: true, id: lease.id };
    },
    active() { return lease !== null; },
    record(source, key, edge, now) {
      if (!lease || now >= lease.until) return false;
      const bucket = lease.counts[source === "ipc" ? "ipc" : "shortcut"];
      bucket[key] = bucket[key] || empty();
      bucket[key][edge === "up" ? "up" : "down"]++;
      if (source !== "ipc") { if (edge === "down") lease.down.add(key); else lease.down.delete(key); }
      return true;
    },
    status(id, now) {
      if (lease && lease.id === id) return { active: true, remainingMs: Math.max(0, lease.until - now), failed: undefined };
      if (failed.has(id)) return { active: false, remainingMs: 0, failed: failed.get(id).failed };
      return null;
    },
    report(id, now) {
      if (failed.has(id)) { const r = failed.get(id); failed.delete(id); return r; }
      if (!lease || lease.id !== id) {
        const known = /^st-\d+$/.test(String(id)) && Number(String(id).slice(3)) <= seq;
        return { ok: false, reason: known ? "expired" : "unknown" };
      }
      if (now >= lease.until) { end(); return { ok: false, reason: "expired" }; }
      const r = compute(lease);
      end();
      return { ok: r.missing.length === 0 && r.extras.length === 0 && r.held.length === 0, ...r, failed: undefined };
    },
    disarm(id, now) {
      void now;
      if (!lease || lease.id !== id) return false;
      end();
      return true;
    },
    externalRecording(now) {
      void now;
      if (!lease) return [];
      const id = lease.id;
      failed.set(id, { ok: false, ...compute(lease), failed: "external-recording" });
      end();
      return [{ type: "selftestFailed", id, reason: "external-recording" }];
    },
    advance(now) {
      if (lease && now >= lease.until) { const id = lease.id; end(); return [{ type: "selftestExpired", id }]; }
      return [];
    },
    nextDeadline() { return lease ? lease.until : null; },
  };
}
```

- [ ] **Step 4: Run tests** — `node --test tests/SelfTest.test.mjs` → `# pass 7`.

- [ ] **Step 5: Commit**

```bash
git add lib/SelfTest.mjs tests/SelfTest.test.mjs
git commit -m "feat(core): transport self-test lease and recorder"
```

---

### Task 14: Stats — session aggregation (§5.5)

**Files:**
- Create: `lib/Stats.mjs`
- Test: `tests/Stats.test.mjs`

**Interfaces:**
- Produces `createStats(entries = [])` → `{ add(session) → entries, entries() → array, summary(now) }` where `summary` = `{ today: { count, seconds }, week: { count, seconds }, all: { count, seconds }, longest: { durationSec, startedAt } | null }`. "today" = same local calendar day as `now`; "week" = the last 7 × 24 h. Sessions are `{ startedAt (ms epoch), durationSec, source, inferred }`.

- [ ] **Step 1: Write the failing tests**

`tests/Stats.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStats } from "../lib/Stats.mjs";

const DAY = 86400000;
const noon = new Date(2026, 8, 14, 12, 0, 0).getTime();     // local time, so "today" is deterministic

test("empty stats summarize to zeros and no longest", () => {
  assert.deepEqual(createStats().summary(noon), { today: { count: 0, seconds: 0 }, week: { count: 0, seconds: 0 }, all: { count: 0, seconds: 0 }, longest: null });
});

test("today / week / all buckets and longest session", () => {
  const s = createStats();
  s.add({ startedAt: noon - 3600000, durationSec: 4, source: "hid", inferred: false });      // today
  s.add({ startedAt: noon - 2 * DAY, durationSec: 10, source: "dbus", inferred: true });    // this week
  s.add({ startedAt: noon - 30 * DAY, durationSec: 2.5, source: "keyboard", inferred: true }); // older
  const sum = s.summary(noon);
  assert.deepEqual(sum.today, { count: 1, seconds: 4 });
  assert.deepEqual(sum.week, { count: 2, seconds: 14 });
  assert.deepEqual(sum.all, { count: 3, seconds: 16.5 });
  assert.deepEqual(sum.longest, { durationSec: 10, startedAt: noon - 2 * DAY });
  assert.equal(s.entries().length, 3);
});

test("add ignores malformed sessions", () => {
  const s = createStats();
  s.add({ startedAt: "x", durationSec: 1 });
  s.add(null);
  assert.equal(s.entries().length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail** — `node --test tests/Stats.test.mjs` → module not found.

- [ ] **Step 3: Write Stats.mjs**

`lib/Stats.mjs`:
```js
// Spec §5.5: local-only session stats; no audio or text is ever stored.
const WEEK_MS = 7 * 86400000;

export function createStats(initial = []) {
  const entries = Array.isArray(initial) ? initial.filter(valid) : [];
  function valid(s) {
    return !!s && typeof s === "object" && typeof s.startedAt === "number" && Number.isFinite(s.startedAt) && typeof s.durationSec === "number" && s.durationSec >= 0;
  }
  const bucket = (list) => ({ count: list.length, seconds: list.reduce((a, s) => a + s.durationSec, 0) });
  return {
    add(session) { if (valid(session)) entries.push({ ...session }); return entries; },
    entries() { return entries.slice(); },
    summary(now) {
      const d = new Date(now); d.setHours(0, 0, 0, 0);
      const dayStart = d.getTime(), dayEnd = dayStart + 86400000;
      const today = entries.filter(s => s.startedAt >= dayStart && s.startedAt < dayEnd);
      const week = entries.filter(s => s.startedAt > now - WEEK_MS && s.startedAt <= now);
      let longest = null;
      for (const s of entries) if (!longest || s.durationSec > longest.durationSec) longest = { durationSec: s.durationSec, startedAt: s.startedAt };
      return { today: bucket(today), week: bucket(week), all: bucket(entries), longest };
    },
  };
}
```

- [ ] **Step 4: Run tests** — `node --test tests/Stats.test.mjs` → `# pass 3`.

- [ ] **Step 5: Commit**

```bash
git add lib/Stats.mjs tests/Stats.test.mjs
git commit -m "feat(core): session stats aggregation"
```

---

### Task 15: Doctor — shared check rules (§6.2 item 4, §5.4, §7 `--doctor`)

**Files:**
- Create: `lib/Doctor.mjs`
- Test: `tests/Doctor.test.mjs`

**Interfaces:**
- Produces `evaluate(facts, config)` → `rows: [{ id, label, status, modes, detail, fix }]` with `status ∈ pass | warn | fail | unknown | info`, `modes` ⊆ `["remote","system"]` (which mic modes the row applies to), and `summarize(rows, config)` → `"ready" | "unconfigured" | "remoteWarning"` (§5.4 mapping: any failing Voxtype/config row → `unconfigured`; in `remote` mode any failing ATVVoice/device row → `remoteWarning`).
- Facts shape (every field optional; missing → `unknown`):
```js
{
  tools: { keyd, wtype, playerctl, wpctl, "pw-dump": bool, voxtype, evtest, jq, node },
  keyd: { enabled, active, checkOk, grabbed },
  hypr: { required, descriptions: ["omaremote:up", …] },
  voxtype: { version: "0.8.1", statusClass: "idle", outputMode: "type", audioDevice: "G20S PRO" },
  atvvoice: { active, micOnDemand, nodeName: "G20S PRO", busNames: ["org.atvvoice.G20SPRO"] },
  pipewire: { sources: ["alsa_input…", "G20S PRO"] },
  lastCapture: { node: "G20S PRO", at: 1726300000000 } | null,
  configProblems: [ { code, message } ],
  now: 1726300100000
}
```
- Plan 2 (QML) and Plan 3 (`omaremote-setup --doctor`, via `node -e`) both gather facts and call this one function, so the panel and the script cannot disagree.

- [ ] **Step 1: Write the failing tests**

`tests/Doctor.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, summarize } from "../lib/Doctor.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG, KEY_NAMES } from "../lib/Defaults.mjs";

const config = normalizeConfig({ ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, mic: { supported: false } } }).config;
const supported = KEY_NAMES.filter(k => k !== "mic");
const good = () => ({
  tools: { keyd: true, wtype: true, playerctl: true, wpctl: true, "pw-dump": true, voxtype: true, evtest: true, jq: true, node: true },
  keyd: { enabled: true, active: true, checkOk: true, grabbed: true },
  hypr: { required: true, descriptions: supported.map(k => `omaremote:${k}`) },
  voxtype: { version: "0.8.1", statusClass: "idle", outputMode: "type", audioDevice: "G20S PRO" },
  atvvoice: { active: true, micOnDemand: true, nodeName: "G20S PRO", busNames: ["org.atvvoice.G20SPRO"] },
  pipewire: { sources: ["alsa_input.pci", "G20S PRO"] },
  lastCapture: { node: "G20S PRO", at: 1000 },
  configProblems: [],
  now: 2000,
});
const row = (rows, id) => rows.find(r => r.id === id);

test("all-good facts in remote mode: every applicable row passes and summary is ready", () => {
  const rows = evaluate(good(), config);
  const applicable = rows.filter(r => r.modes.includes("remote"));
  assert.ok(applicable.length >= 12);
  assert.deepEqual(applicable.filter(r => r.status !== "pass").map(r => r.id), []);
  assert.equal(summarize(rows, config), "ready");
});

test("hypr binds must match the supported key set exactly", () => {
  const f = good(); f.hypr.descriptions = f.hypr.descriptions.slice(1).concat(["omaremote:mic"]);
  const r = row(evaluate(f, config), "hypr-binds");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /missing: up/);
  assert.match(r.detail, /unexpected: mic/);
});

test("voxtype rows: old version, stopped status, wrong output mode -> unconfigured", () => {
  const f = good(); f.voxtype.version = "0.7.9"; f.voxtype.statusClass = "stopped"; f.voxtype.outputMode = "clipboard";
  const rows = evaluate(f, config);
  assert.equal(row(rows, "voxtype-version").status, "fail");
  assert.equal(row(rows, "voxtype-status").status, "fail");
  assert.equal(row(rows, "voxtype-output").status, "fail");
  assert.equal(summarize(rows, config), "unconfigured");
});

test("remote mode: ATVVoice down or device mismatch -> remoteWarning, not unconfigured", () => {
  const f = good(); f.atvvoice.active = false; f.voxtype.audioDevice = "default";
  const rows = evaluate(f, config);
  assert.equal(row(rows, "atvvoice-service").status, "fail");
  assert.equal(row(rows, "voxtype-device").status, "fail");
  assert.equal(summarize(rows, config), "remoteWarning");
});

test("system mode: ATVVoice rows are informational and device must resolve to a source or default", () => {
  const sys = normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, mic: "system" } }).config;
  const f = good(); f.atvvoice.active = false; f.voxtype.audioDevice = "default";
  const rows = evaluate(f, sys);
  assert.equal(row(rows, "atvvoice-service").status, "info");
  assert.equal(row(rows, "voxtype-device").status, "pass");
  assert.equal(summarize(rows, sys), "ready");
  f.voxtype.audioDevice = "ghost";
  assert.equal(row(evaluate(f, sys), "voxtype-device").status, "fail");
});

test("last capture: null is unknown (not yet verified); mismatch is a warning", () => {
  const f = good(); f.lastCapture = null;
  assert.equal(row(evaluate(f, config), "last-capture").status, "unknown");
  f.lastCapture = { node: "alsa_input.pci", at: 1500 };
  assert.equal(row(evaluate(f, config), "last-capture").status, "warn");
});

test("panic key, tools, keyd and config rows", () => {
  const noPanic = normalizeConfig({ ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, menu: { ...DEFAULT_CONFIG.keys.menu, supported: false } } }).config;
  assert.equal(row(evaluate(good(), noPanic), "panic-key").status, "fail");
  const f = good(); f.tools.wtype = false; f.keyd.active = false; f.configProblems = [{ code: "action-invalid", message: "ok.tap bad" }];
  const rows = evaluate(f, config);
  assert.equal(row(rows, "tools").status, "fail");
  assert.match(row(rows, "tools").detail, /wtype/);
  assert.equal(row(rows, "keyd-service").status, "fail");
  assert.equal(row(rows, "keyd-service").fix, "sudo systemctl enable --now keyd");
  assert.equal(row(rows, "config-valid").status, "fail");
});

test("missing facts are unknown, never pass", () => {
  const rows = evaluate({}, config);
  assert.ok(rows.every(r => r.status !== "pass" || r.id === "panic-key"));
  assert.equal(row(rows, "keyd-service").status, "unknown");
});
```

- [ ] **Step 2: Run tests to verify they fail** — `node --test tests/Doctor.test.mjs` → module not found.

- [ ] **Step 3: Write Doctor.mjs**

`lib/Doctor.mjs`:
```js
// Spec §6.2 item 4 (doctor rows), §5.4 (state mapping), §7 --doctor. One rule set for panel and script.
import { KEY_NAMES } from "./Defaults.mjs";
import { isHealthy } from "./VoxStatus.mjs";

const BOTH = ["remote", "system"];
const REQUIRED_TOOLS = ["keyd", "wtype", "playerctl", "wpctl", "pw-dump", "voxtype"];

const get = (o, path) => path.split(".").reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), o);
const tri = (v) => (v === undefined || v === null ? "unknown" : v ? "pass" : "fail");

function versionAtLeast(v, major, minor) {
  const m = /^(\d+)\.(\d+)/.exec(String(v || ""));
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return a > major || (a === major && b >= minor);
}

export function evaluate(facts = {}, config) {
  const mode = get(config, "voice.mic") === "system" ? "system" : "remote";
  const supported = KEY_NAMES.filter(k => get(config, `keys.${k}.supported`) !== false);
  const rows = [];
  const push = (id, label, status, modes, detail = "", fix = "") => rows.push({ id, label, status, modes, detail, fix });

  // tools
  const tools = get(facts, "tools");
  if (!tools) push("tools", "Required tools present", "unknown", BOTH, "", "");
  else {
    const missing = REQUIRED_TOOLS.filter(t => !tools[t]);
    push("tools", "Required tools present", missing.length ? "fail" : "pass", BOTH, missing.length ? `missing: ${missing.join(", ")}` : "", missing.length ? `sudo pacman -S --needed ${missing.filter(t => t !== "pw-dump").join(" ")}` : "");
  }

  // keyd
  const keydOk = get(facts, "keyd.enabled") && get(facts, "keyd.active");
  push("keyd-service", "keyd enabled and active", get(facts, "keyd.enabled") === undefined ? "unknown" : tri(!!keydOk), BOTH, "", "sudo systemctl enable --now keyd");
  push("keyd-conf", "keyd check passes on /etc/keyd/omaremote.conf", tri(get(facts, "keyd.checkOk")), BOTH, "", "sudo keyd check /etc/keyd/omaremote.conf");
  push("keyd-grab", "remote device grabbed by keyd", tri(get(facts, "keyd.grabbed")), BOTH, "", "bash <plugin-dir>/host/omaremote-setup --relearn");

  // hyprland binds
  const desc = get(facts, "hypr.descriptions");
  if (!Array.isArray(desc)) push("hypr-binds", "Hyprland global binds loaded", "unknown", BOTH, "", "");
  else {
    const want = supported.map(k => `omaremote:${k}`);
    const missing = want.filter(d => !desc.includes(d)).map(d => d.slice("omaremote:".length));
    const unexpected = desc.filter(d => !want.includes(d)).map(d => d.slice("omaremote:".length));
    const dup = desc.filter((d, i) => desc.indexOf(d) !== i);
    const ok = get(facts, "hypr.required") !== false && !missing.length && !unexpected.length && !dup.length;
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
    if (unexpected.length) parts.push(`unexpected: ${unexpected.join(", ")}`);
    if (dup.length) parts.push(`duplicate: ${dup.join(", ")}`);
    push("hypr-binds", "Hyprland global binds match supported keys", ok ? "pass" : "fail", BOTH, parts.join("; "), "bash <plugin-dir>/host/omaremote-setup && hyprctl reload");
  }

  // voxtype
  const vver = get(facts, "voxtype.version");
  const vok = versionAtLeast(vver, 0, 8);
  push("voxtype-version", "Voxtype ≥ 0.8", vok === null ? "unknown" : tri(vok), BOTH, vver ? `found ${vver}` : "", "voxtype configure  # update");
  const cls = get(facts, "voxtype.statusClass");
  push("voxtype-status", "Voxtype daemon answering", cls === undefined ? "unknown" : tri(isHealthy(cls)), BOTH, cls ? `status: ${cls}` : "", "systemctl --user restart voxtype");
  const om = get(facts, "voxtype.outputMode");
  push("voxtype-output", 'Voxtype output.mode is "type"', om === undefined ? "unknown" : tri(om === "type"), BOTH, om ? `output.mode: ${om}` : "", "voxtype config set output.mode type && systemctl --user restart voxtype");

  // atvvoice (remote mode rows; informational in system mode)
  const infoOr = (status) => (mode === "system" ? "info" : status);
  push("atvvoice-service", "ATVVoice service active", infoOr(tri(get(facts, "atvvoice.active"))), BOTH, "", "systemctl --user enable --now atvvoice");
  push("atvvoice-ondemand", "ATVVoice runs with --mic-on-demand", infoOr(tri(get(facts, "atvvoice.micOnDemand"))), BOTH, "", "systemctl --user edit atvvoice  # add --mic-on-demand to ExecStart");
  const bus = get(facts, "atvvoice.busNames");
  push("atvvoice-dbus", "ATVVoice on the session bus", infoOr(Array.isArray(bus) ? tri(bus.length > 0) : "unknown"), BOTH, Array.isArray(bus) ? bus.join(", ") : "", "systemctl --user restart atvvoice");

  // voxtype device per mode
  const dev = get(facts, "voxtype.audioDevice");
  const node = get(facts, "atvvoice.nodeName");
  if (dev === undefined) push("voxtype-device", "Voxtype audio.device", "unknown", BOTH, "", "");
  else if (mode === "remote") push("voxtype-device", "Voxtype audio.device is the ATVVoice node", tri(!!node && dev === node), ["remote"], `audio.device: ${dev}${node ? `, node: ${node}` : ""}`, "omarchy-shell omaremote mic remote");
  else {
    const sources = get(facts, "pipewire.sources");
    const ok = dev === "default" || (Array.isArray(sources) && sources.includes(dev));
    push("voxtype-device", "Voxtype audio.device resolves to a PipeWire source", Array.isArray(sources) || dev === "default" ? tri(ok) : "unknown", ["system"], `audio.device: ${dev}`, "omarchy-shell omaremote mic system");
  }

  // last capture
  const lc = get(facts, "lastCapture");
  const expected = mode === "remote" ? node : dev;
  if (lc === undefined) push("last-capture", "Last session captured from expected node", "unknown", BOTH, "", "");
  else if (lc === null) push("last-capture", "Last session captured from expected node", "unknown", BOTH, "not yet verified", "");
  else push("last-capture", "Last session captured from expected node", lc.node === expected ? "pass" : "warn", BOTH, `captured from: ${lc.node}`, "");

  // panic + config
  const panicOk = KEY_NAMES.some(k => get(config, `keys.${k}.panic`) && get(config, `keys.${k}.supported`) !== false);
  push("panic-key", "At least one supported key has panic", panicOk ? "pass" : "fail", BOTH, "", "bash <plugin-dir>/host/omaremote-setup --relearn");
  const probs = get(facts, "configProblems");
  push("config-valid", "config.json valid", Array.isArray(probs) ? tri(probs.length === 0) : "unknown", BOTH, Array.isArray(probs) ? probs.map(p => p.message).join("; ") : "", "");

  return rows;
}

const VOX_ROWS = ["tools", "voxtype-version", "voxtype-status", "voxtype-output", "config-valid"];
const REMOTE_ROWS = ["atvvoice-service", "atvvoice-ondemand", "atvvoice-dbus", "voxtype-device"];

export function summarize(rows, config) {
  const mode = get(config, "voice.mic") === "system" ? "system" : "remote";
  const failed = (ids) => rows.some(r => ids.includes(r.id) && r.status === "fail" && r.modes.includes(mode));
  if (failed(VOX_ROWS)) return "unconfigured";
  if (mode === "system" && rows.some(r => r.id === "voxtype-device" && r.status === "fail")) return "unconfigured";
  if (mode === "remote" && failed(REMOTE_ROWS)) return "remoteWarning";
  return "ready";
}
```

- [ ] **Step 4: Run tests** — `node --test tests/Doctor.test.mjs` → `# pass 8`. Then `make test` → all suites green.

- [ ] **Step 5: Commit**

```bash
git add lib/Doctor.mjs tests/Doctor.test.mjs
git commit -m "feat(core): shared doctor rules and state summary"
```

---

## Done criteria for Plan 1

Two different things get verified, and only the second counts as completion:

- *Plan-snippet verification (already done while writing this plan):* the code blocks above were extracted into a scratch tree and run; that proves the examples are internally consistent, nothing more.
- *Repository verification (required to call Plan 1 done):* `make test` runs `node --test "tests/*.test.mjs"` against the committed `tests/` and `lib/` directories in this repository — no extraction script, no copied tree — and reports `fail 0` for the Config, KeyEngine, Actions, Dbus, VoxStatus, VoiceSession, MicApply, SelfTest, Stats and Doctor suites.
- `lib/` imports nothing from Node: `rg -l 'from "node:' lib/` prints nothing.
- Every `lib/*.mjs` opens with its spec reference: `for f in lib/*.mjs; do head -1 "$f" | rg -q '^// Spec §' || echo "missing spec header: $f"; done` prints nothing.
- Recovery never touches an external session: the VoiceSession tests "an external recording after an accepted idle is observed, never cancelled…" and "failed restart or restart timeout…" (restart only when the backend is quiet) pass; no `cancel`/`restart` effect is emitted while an external `recording`/`transcribing` is observed after an accepted idle.
- Stale inputs are inert: D-Bus events from another sender or an older monitor generation, and ATVVoice property replies for a retired `requestId`/generation, produce no effects (tests in Task 10).
- Mic apply never overwrites an external edit: the "rollback refuses to overwrite an external edit" test passes; deferred rollback waits for exited commands, no systemd job, fresh idle (Task 12 tests).
- Every spec §9 "required lifecycle case" that does not need a compositor or a real backend has a test: HID release while starting; start fails/never confirms; panic in arbitration/recording/transcribing; stop fails / backend stays recording; arbitration release before 250 ms; delayed keyboard status at 300 ms; stale D-Bus end; system default resolving to ATVVoice (arbitration runs in both modes); mic request busy > 60 s; apply succeeds / restart fails / commit; reset during apply; self-test arm busy, normal, expiry, external F9; learning-related checks live in Plan 3.

## What Plans 2 and 3 pick up (not in this plan)

- **Plan 2 — QML plugin (needs an Omarchy host):** task 0 spikes from spec §2 (Service↔BarWidget state sharing, Service-owned `PanelWindow`, `GlobalShortcut` press/release via `hl.dsp.global`, Voxtype capture-stream lifetime) **plus** loading a minimal `.mjs` ES module with named exports from QML inside `omarchy-shell` and confirming the engine accepts the syntax `lib/` uses (`Map`, `Set`, object spread, default parameters, template literals, `Array.prototype.includes`) — if not, the fallback is a mechanical rewrite of the offending constructs, not a change of design; capture real `busctl --json=short`, `voxtype config get --json` and `systemctl show -p Job --value` samples into `tests/fixtures/`, then `Service.qml` (adapters that execute effects, single `Timer` driven by the modules' `nextDeadline()`, `IpcHandler` verbs `key/voice/reset/mic/micStatus/selftest`), `BarWidget.qml`, `Panel.qml`, `components/`.
- **Plan 3 — host setup + docs (needs Omarchy + a remote):** `host/omaremote-setup` (§7), `--doctor` via `node -e` over `lib/Doctor.mjs`, `tests/fake-remote.sh`, `docs/hw-checklist.md`, README (zh-TW + English).
