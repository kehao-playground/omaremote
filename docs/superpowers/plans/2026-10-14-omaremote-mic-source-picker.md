# Mic Source Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick, in the Voice tab, which PipeWire capture source Voxtype records from in `system` mode, through a hinted ALSA PCM `omaremote-mic` whose target the mic apply transaction rewrites and can roll back.

**Architecture:** A new host subcommand `omaremote-setup alsa-mic` owns a second managed asoundrc block with a locked, single-read compare-and-set. `lib/MicApply.mjs` gains two snapshot/write phases (`alsa-get`, `alsa-set`) and a rollback step (`alsa-restore`) whose progress survives a defer. Pure helpers (`lib/AlsaMic.mjs`, `lib/MicSources.mjs`, `lib/Pipewire.mjs` additions) carry the parsing and the cache-miss rule. `Service.qml` wires them, and `VoiceTab.qml` shows one button per choice.

**Tech Stack:** QML/Quickshell (V4 engine: no object spread, use `Object.assign`), plain ES modules tested with `node --test`, bash + awk + `flock` (util-linux) for the host script, the existing `tests/fake-remote.sh` harness.

**Spec:** `docs/superpowers/specs/2026-10-14-mic-source-picker-design.md` (rev 3, `a1ce3ca`). Read it before any task. Section numbers below (§n) refer to it.

## Global Constraints

- The PCM name is `omaremote-mic`. The block markers are `# BEGIN omaremote mic (managed by omaremote-setup; do not edit)` and `# END omaremote mic`.
- Block hint text: `hint { show on description "omaremote picked microphone" }`.
- `alsa-mic` output is one JSON line: `{"state":"absent"}` or `{"state":"present","node":"<node>"}`.
- `alsa-mic` exit codes: 0 ok · 1 I/O or lock timeout (file unchanged) · 2 `bad` block (file unchanged) · 3 expectation mismatch (file unchanged, current state printed) · 64 usage error.
- Lock: exclusive `flock` on `<asoundrc>.omaremote.lock`, waited for at most 5 s (`OMAREMOTE_ALSA_LOCK_WAIT` overrides, tests only).
- `voice.systemDevice` is `"default"` or a node name. A missing, non-string or invalid value loads as `"default"`.
- Refusal reasons, verbatim: `invalid-source`, `no-such-source`, `sources-unavailable`; the cache-miss answer is `{ ok:false, reason:"busy", detail:"sourcesRefreshing", retryAfterMs:300 }`.
- Operation errors, verbatim: `preflight-failed`, `job-pending`, `alsa-conflict`, `alsa-set-failed`. Rollback values: `verified | conflict | failed | deferred | unresolved`, plus `partial: "conflict" | "failed"` on an `unresolved` record.
- HUD texts, verbatim: "microphone config changed externally"; `unconfigured` reason "microphone partly restored"; fallback "recording from <description>, not <picked description>".
- Panel refusal texts, verbatim: "microphone not found (unplugged?)", "not a usable microphone", "cannot list microphones (pw-dump failed)"; a disconnected stored source is suffixed " (not connected)".
- Every test touching the ALSA file sets `OMAREMOTE_ALSA_RC` to a temp path. Nothing in this plan may read or write the real `~/.config/alsa/asoundrc` except hardware acceptance (Task 11).
- Comparisons of block states always go through `sameAlsa(a, b)`; never compare parsed objects with `===`/`!==` (spec §5.1).
- `make check` must end with `MAKE_CHECK_EXIT=0` printed by the wrapper below. The unit total prints long before the integration block, so do not read it as success:
  `make check > /tmp/claude-1000/check.log 2>&1; echo "MAKE_CHECK_EXIT=$?" >> /tmp/claude-1000/check.log; tail -40 /tmp/claude-1000/check.log`

## Plan-level rulings (deviations from the spec's wording, decided here)

1. **IPC verb.** Quickshell `IpcHandler` functions have a fixed arity, so `mic(mode)` cannot also take a node, and changing it would break `omarchy-shell omaremote mic system` and `host/omaremote-setup`'s `ipc mic "$mode"`. Spec §4.4's `mic system <node>` is therefore spelled **`micSystem <node>`** (`omarchy-shell omaremote micSystem alsa_input…`). A second new verb, **`micSources`**, refreshes and returns the source list so a CLI user can find node names. `mic system` and `mic remote` are unchanged.
2. **Keyboard.** Spec §4.5 says the row behaves like the Keys tab. The Keys tab's real pattern is: with the cursor on a row, Left/Right moves the highlighted column and Enter activates it. The picker follows that: cursor on the Microphone row, Left/Right moves the highlight, Enter applies it, and Esc keeps its panel-wide meaning (close). There is no separate edit mode. Enter on the already-active choice does nothing.
3. **Node-name pattern.** The pattern is `^[A-Za-z0-9_.:][A-Za-z0-9_.:-]*$` (spec rev 4 §4.2): the spec's character set, with only a leading `-` forbidden, so a node name can never be parsed as an option to `alsa-mic`. A leading `.` or `:` is allowed. It is defined once in JS (`lib/AlsaMic.mjs` `NODE_RE`) and once in bash (`NODE_RE` in `host/omaremote-setup`), and a test pins both to the same accept/reject table.
4. **An `alsa-set` whose exit is not one of 1, 2, 3, 64 (a timeout kill 124/137, 127) may have landed**, because the rename is its last step. MicApply treats it as written: `alsaExpected = present <node>`, `serviceDirty = true`, error `alsa-set-failed`, then a normal rollback. The rollback's compare-and-set then finds the truth. `alsa-restore` exiting 3 with a printed state equal to `alsaPrev` means "the file already holds the value to restore" and counts as `done`, mirroring today's `rollback-get` rule. Any other non-zero `alsa-restore` exit is `failed`.
5. **The `alsa-*` commands get the 10 s restart deadline** (`restartCmdMs`), not the 2 s read deadline, because the lock may legitimately wait 5 s.
6. **The integration scenario checks wiring and end state**, not the cross-process order of `get`/`alsa-get`/`alsa-set`/`set`/`restart`. The fake harness logs Voxtype calls and systemd calls in different files and never logs the host script. The exact order is pinned by the MicApply unit tests (Task 6), which see every command in one effect stream.
7. **Append layout applies to both managed blocks.** The shared writer appends with no extra blank line (§4.1). The atvvoice block used to add one when appending to a non-empty file. Only a fresh append changes: an existing atvvoice block is replaced in place as before.

## Review Focus

- A node name that looks like an option or contains ALSA syntax (`-x`, `a"b`, `a}b`, `a b`) must be refused before it reaches argv or the file. Owner: Task 1 (JS table), Task 4 (bash table, same rows).
- A file whose last line has no newline, or that holds only the mic block: add then remove must leave exactly the original (plus at most the one newline an append adds), and a replace or remove must never add a byte outside the block. Owner: Task 4.
- A drained command answering after a defer must update the deferred snapshot, never a newer operation. Owner: Task 6 ("a stale alsa command from a reset operation" test).
- The panel opened with an empty cache, then an immediate pick: the first answer is `sourcesRefreshing`, never `no-such-source`. Owner: Task 2 (pure rule) and Task 9 (`s_mic_system_unknown_source` first answer).
- A system with the stored `systemDevice` unplugged at startup: the panel must still show it, as " (not connected)" and unpickable, and Doctor must fail condition 3, not crash on a missing list. Owner: Task 7 (Doctor) and Task 10 (`micChoices`).

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `lib/AlsaMic.mjs` | new | Block-state values, `NODE_RE`, `parseAlsaState`, `sameAlsa`, `alsaSetArgv`, `MIC_PCM` |
| `lib/MicSources.mjs` | new | Cached capture-source list and the cache-miss/refresh rule (§4.4) |
| `lib/Pipewire.mjs` | modify | `captureSources`, `defaultSource`, `captureMismatch` |
| `lib/Config.mjs`, `lib/Defaults.mjs` | modify | `voice.systemDevice` |
| `components/ConfigStore.qml` | modify | `setVoiceMic(mode, device)` |
| `host/omaremote-setup` | modify | Shared single-read block engine, lock, atomic write; `alsa-mic`; atvvoice uses the engine |
| `host/omaremote-facts` | modify | `alsa.mic`, `pipewire.defaultSource` |
| `lib/MicApply.mjs` | modify | ALSA phases, rollback step, progress across defer |
| `lib/Doctor.mjs` | modify | `voxtype-device` system + node, `last-capture` expected node |
| `lib/Presentation.mjs` | modify | `micChoices`, `micConflictLine`, `micStatusLine` partial |
| `Service.qml` | modify | Wiring: alsa argv, deadlines, commit device, IPC, source probe, fallback HUD, status |
| `components/VoiceTab.qml`, `Panel.qml` | modify | Picker row and keyboard |
| `tests/AlsaMic.test.mjs`, `tests/MicSources.test.mjs` | new | Unit tests |
| `tests/setup-alsa-mic.sh` | new | Host script tests incl. concurrency and facts |
| `tests/fake-remote.sh` | modify | `OMAREMOTE_ALSA_RC`, three scenarios |
| `Makefile` | modify | Run `tests/setup-alsa-mic.sh` in `check` |
| `README.md`, `README.zh-TW.md` | modify | The picker and `micSystem`/`micSources` |

---

### Task 1: `lib/AlsaMic.mjs` and the PipeWire source helpers

**Files:**
- Create: `lib/AlsaMic.mjs`
- Modify: `lib/Pipewire.mjs`
- Test: `tests/AlsaMic.test.mjs`, `tests/Pipewire.test.mjs`

**Interfaces:**
- Produces: `NODE_RE: RegExp` (`^[A-Za-z0-9_.:][A-Za-z0-9_.:-]*$`), `MIC_PCM = "omaremote-mic"`, `isNodeName(s) → boolean`, `absent() → {state:"absent"}`, `present(node) → {state:"present",node}`, `parseAlsaState(text) → state | null`, `sameAlsa(a, b) → boolean`, `alsaSetArgv(prefix: string[], target: state, expect: state) → string[]`.
- Produces: `captureSources(dump, { exclude?: string[] }) → [{ name, description }]`, `sourcesFromProbe(code: number, text: string, opts) → [{ name, description }] | null` (null unless the exit is 0 AND the output is a JSON array), `defaultSource(dump) → string | null`, `captureMismatch(dump, expected: string | null) → null | { node, nodeDescription, expected, expectedDescription }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/AlsaMic.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { NODE_RE, MIC_PCM, isNodeName, absent, present, parseAlsaState, sameAlsa, alsaSetArgv } from "../lib/AlsaMic.mjs";

// The same table is pinned against the bash NODE_RE in tests/setup-alsa-mic.sh (Task 4). Keep the two in step.
export const NODE_TABLE = [
  ["alsa_input.usb-046d_C922_Pro_Stream_Webcam_557DD3BF-02.analog-stereo", true],
  ["atvvoice-xiaomi", true], ["none", true], ["absent", true], ["a:b.c_d-e", true], ["_x", true], [".x", true], [":x", true],
  ["-x", false], ["", false], ["a b", false], ['a"b', false], ["a}b", false], ["a{b", false], ["a\\b", false], ["a\nb", false],
];

test("NODE_RE accepts node names and refuses option-like or ALSA-syntax names", () => {
  for (const [name, ok] of NODE_TABLE) assert.equal(isNodeName(name), ok, JSON.stringify(name));
  assert.equal(isNodeName(undefined), false);
  assert.equal(isNodeName(42), false);
  assert.equal(NODE_RE.source, "^[A-Za-z0-9_.:][A-Za-z0-9_.:-]*$");
  assert.equal(MIC_PCM, "omaremote-mic");
});

test("parseAlsaState reads the alsa-mic JSON and refuses anything else", () => {
  assert.deepEqual(parseAlsaState('{"state":"absent"}\n'), { state: "absent" });
  assert.deepEqual(parseAlsaState('{"state":"present","node":"none"}'), { state: "present", node: "none" });
  assert.equal(parseAlsaState('{"state":"bad"}'), null);
  assert.equal(parseAlsaState('{"state":"present"}'), null);
  assert.equal(parseAlsaState('{"state":"present","node":"a b"}'), null);
  assert.equal(parseAlsaState("none"), null);
  assert.equal(parseAlsaState(""), null);
  assert.equal(parseAlsaState(null), null);
});

test("sameAlsa compares state and node, never identity", () => {
  assert.equal(sameAlsa(absent(), absent()), true);
  assert.equal(sameAlsa(present("a"), present("a")), true);
  assert.equal(sameAlsa(present("a"), present("b")), false);
  assert.equal(sameAlsa(present("absent"), absent()), false);
  assert.equal(sameAlsa(null, absent()), false);
  assert.equal(sameAlsa(parseAlsaState('{"state":"present","node":"a"}'), present("a")), true);
});

test("alsaSetArgv spells targets and expectations as alsa-mic flags", () => {
  const p = ["bash", "/x/omaremote-setup", "alsa-mic"];
  assert.deepEqual(alsaSetArgv(p, present("n"), absent()), [...p, "set", "n", "--expect-absent"]);
  assert.deepEqual(alsaSetArgv(p, absent(), present("n")), [...p, "set", "--absent", "--expect", "n"]);
  assert.deepEqual(alsaSetArgv(p, present("absent"), present("none")), [...p, "set", "absent", "--expect", "none"]);
  assert.deepEqual(p, ["bash", "/x/omaremote-setup", "alsa-mic"], "the prefix is not mutated");
});
```

Append to `tests/Pipewire.test.mjs` (also extend its import line to `import { captureSourceOf, sourceNames, captureSources, sourcesFromProbe, defaultSource, captureMismatch } from "../lib/Pipewire.mjs";`):

```js
const node = (id, props) => ({ id, type: "PipeWire:Interface:Node", info: { props } });
const pickDump = [
  node(1, { "media.class": "Audio/Source", "node.name": "alsa_input.usb-C922", "node.description": "C922 Pro Stream Webcam Analog Stereo", "node.nick": "C922" }),
  node(2, { "media.class": "Audio/Source", "node.name": "alsa_input.pci-builtin", "node.nick": "CS4208 Analog" }),
  node(3, { "media.class": "Audio/Source", "node.name": "bare_source" }),
  node(4, { "media.class": "Audio/Source", "node.name": "alsa_output.hdmi.monitor", "node.description": "Monitor" }),
  node(5, { "media.class": "Audio/Source", "node.name": "atvvoice-xiaomi", "node.description": "小米蓝牙语音遥控器" }),
  node(6, { "media.class": "Audio/Source", "node.name": "weird name", "node.description": "Unpickable" }),
  node(7, { "media.class": "Audio/Sink", "node.name": "alsa_output.hdmi" }),
  { id: 9, type: "PipeWire:Interface:Metadata", props: { "metadata.name": "settings" }, metadata: [] },
  { id: 10, type: "PipeWire:Interface:Metadata", props: { "metadata.name": "default" }, metadata: [
    { subject: 0, key: "default.audio.sink", type: "Spa:String:JSON", value: { name: "alsa_output.hdmi" } },
    { subject: 0, key: "default.audio.source", type: "Spa:String:JSON", value: { name: "alsa_input.usb-C922" } } ] },
];

test("captureSources lists pickable sources with description fallbacks", () => {
  assert.deepEqual(captureSources(pickDump, { exclude: ["atvvoice-xiaomi"] }), [
    { name: "alsa_input.usb-C922", description: "C922 Pro Stream Webcam Analog Stereo" },
    { name: "alsa_input.pci-builtin", description: "CS4208 Analog" },
    { name: "bare_source", description: "bare_source" },
  ]);
  assert.equal(captureSources(pickDump).some(s => s.name === "atvvoice-xiaomi"), true, "exclude is what drops the remote");
  assert.deepEqual(captureSources(null), []);
});

test("sourcesFromProbe needs both a zero exit and a JSON array", () => {
  const text = JSON.stringify(pickDump);
  assert.deepEqual(sourcesFromProbe(0, text, { exclude: ["atvvoice-xiaomi"] }).map(s => s.name), ["alsa_input.usb-C922", "alsa_input.pci-builtin", "bare_source"]);
  assert.equal(sourcesFromProbe(1, text, {}), null, "valid JSON with a non-zero exit is a failed refresh");
  assert.equal(sourcesFromProbe(124, text, {}), null);
  assert.equal(sourcesFromProbe(0, "not json", {}), null);
  assert.equal(sourcesFromProbe(0, "{}", {}), null, "not an array");
  assert.deepEqual(sourcesFromProbe(0, "[]", {}), [], "an empty graph is a successful, empty list");
});

test("defaultSource reads the default metadata, null without it", () => {
  assert.equal(defaultSource(pickDump), "alsa_input.usb-C922");
  assert.equal(defaultSource(pickDump.filter(o => o.id !== 10)), null);
  assert.equal(defaultSource(dump), null);
  assert.equal(defaultSource(null), null);
});

test("captureMismatch names both sides only when the linked node differs", () => {
  const linked = (to) => pickDump.concat([
    { id: 60, type: "PipeWire:Interface:Node", info: { props: { "media.class": "Stream/Input/Audio", "node.name": "voxtype" } } },
    { id: 70, type: "PipeWire:Interface:Link", info: { "input-node-id": 60, "output-node-id": to } },
  ]);
  assert.equal(captureMismatch(linked(1), "alsa_input.usb-C922"), null);
  assert.deepEqual(captureMismatch(linked(2), "alsa_input.usb-C922"), {
    node: "alsa_input.pci-builtin", nodeDescription: "CS4208 Analog",
    expected: "alsa_input.usb-C922", expectedDescription: "C922 Pro Stream Webcam Analog Stereo" });
  assert.deepEqual(captureMismatch(linked(2), "gone_node").expectedDescription, "gone_node");
  assert.equal(captureMismatch(linked(2), null), null, "nothing expected, nothing to report");
  assert.equal(captureMismatch(pickDump, "alsa_input.usb-C922"), null, "no voxtype stream yet");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/AlsaMic.test.mjs tests/Pipewire.test.mjs`
Expected: FAIL. `AlsaMic.mjs` cannot be found, and the Pipewire import has no `captureSources`.

- [ ] **Step 3: Implement**

Create `lib/AlsaMic.mjs`:

```js
// Mic source picker spec §4.1/§4.2/§5.1: the managed `omaremote-mic` block's state, as `omaremote-setup alsa-mic` prints
// it, and the one comparison every caller uses. Spec §4.2 / plan ruling 3: the first character can never be `-`, so a node name is
// never read as an option. host/omaremote-setup's NODE_RE is the same pattern; tests pin both to one table.
export const NODE_RE = /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]*$/;
export const MIC_PCM = "omaremote-mic";

export const isNodeName = (s) => typeof s === "string" && NODE_RE.test(s);
export const absent = () => ({ state: "absent" });
export const present = (node) => ({ state: "present", node });

export function parseAlsaState(text) {
  let j;
  try { j = JSON.parse(String(text === null || text === undefined ? "" : text).trim()); } catch (e) { return null; }
  if (!j || typeof j !== "object") return null;
  if (j.state === "absent") return absent();
  if (j.state === "present" && isNodeName(j.node)) return present(j.node);
  return null;
}

// Spec §5.1 "Comparing block states": the same state, and the same node when both are present.
export function sameAlsa(a, b) {
  if (!a || !b || a.state !== b.state) return false;
  return a.state !== "present" || a.node === b.node;
}

export function alsaSetArgv(prefix, target, expect) {
  return prefix.concat(["set"],
    target.state === "present" ? [target.node] : ["--absent"],
    expect.state === "present" ? ["--expect", expect.node] : ["--expect-absent"]);
}
```

Append to `lib/Pipewire.mjs` (add `import { isNodeName } from "./AlsaMic.mjs";` as the file's first import line):

```js
// Mic source picker spec §4.3: every pickable capture source. Monitors and the excluded names (the ATVVoice node) are
// dropped, and so is a name the picker could never pass to alsa-mic.
export function captureSources(dump, { exclude = [] } = {}) {
  return nodesOf(dump).filter(n => props(n)["media.class"] === "Audio/Source").map(n => {
    const p = props(n);
    return { name: p["node.name"], description: p["node.description"] || p["node.nick"] || p["node.name"] };
  }).filter(s => isNodeName(s.name) && !/\.monitor$/.test(s.name) && !exclude.includes(s.name));
}

// Spec §4.3: one probe's outcome. A refresh succeeds only when pw-dump exited 0 AND printed a JSON array.
export function sourcesFromProbe(code, text, opts) {
  if (code !== 0) return null;
  let dump;
  try { dump = JSON.parse(String(text || "")); } catch (e) { return null; }
  return Array.isArray(dump) ? captureSources(dump, opts) : null;
}

// Spec §6 `last-capture`: the PipeWire default source, from the `default` metadata object.
export function defaultSource(dump) {
  const md = (Array.isArray(dump) ? dump : []).find(o => o && o.type === "PipeWire:Interface:Metadata"
    && o.props && o.props["metadata.name"] === "default");
  const e = md && Array.isArray(md.metadata) ? md.metadata.find(m => m && m.subject === 0 && m.key === "default.audio.source") : null;
  const name = e && e.value && typeof e.value === "object" ? e.value.name : null;
  return typeof name === "string" && name ? name : null;
}

// Spec §5.3: Voxtype's stream is linked to a node other than the expected one.
export function captureMismatch(dump, expected) {
  if (!expected) return null;
  const r = captureSourceOf(dump);
  if (!r.streamFound || !r.node || r.node === expected) return null;
  const desc = (name) => {
    const n = nodesOf(dump).find(x => props(x)["node.name"] === name);
    const p = n ? props(n) : {};
    return p["node.description"] || p["node.nick"] || name;
  };
  return { node: r.node, nodeDescription: desc(r.node), expected, expectedDescription: desc(expected) };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/AlsaMic.test.mjs tests/Pipewire.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add lib/AlsaMic.mjs lib/Pipewire.mjs tests/AlsaMic.test.mjs tests/Pipewire.test.mjs
git commit -m "feat(mic): ALSA block state helpers and PipeWire capture-source helpers"
```

---

### Task 2: `lib/MicSources.mjs`, the cache-miss rule

**Files:**
- Create: `lib/MicSources.mjs`
- Test: `tests/MicSources.test.mjs`

**Interfaces:**
- Produces: `createMicSources()` returning:
  - `list() → [{name, description}]` (a copy).
  - `check(node) → { verdict: "ok" | "refreshing" | "no-such-source" | "sources-unavailable", refresh: boolean }`.
  - `requestRefresh() → boolean`.
  - `started() → id: number`.
  - `finished(id: number, sources: array | null) → boolean`.
  - `refreshing() → boolean`.
- **Start contract.** Every call that answers "start one" (`check` with `refresh: true`, `requestRefresh` returning true, `finished` returning true) puts the cache in *start requested*. The caller must call `started()` next, in the same turn.
  - While a start is requested, or a refresh runs, no further call answers "start one", and `refreshing()` is true.
  - A miss recorded while a start is requested needs no extra refresh, because the refresh about to start postdates it.
- **Identity.** `started()` returns the refresh's id, and `finished` takes it. A `finished` for an id that is not the running refresh is ignored and returns false. That covers a timed-out probe's late exit, or a probe abandoned and replaced.
- The order between a refresh and a miss is decided by the id sequence, not a clock: a refresh qualifies for a miss only if its id is greater than the last id issued when the miss was recorded.

- [ ] **Step 1: Write the failing tests**

Create `tests/MicSources.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMicSources } from "../lib/MicSources.mjs";

const C922 = { name: "alsa_input.usb-C922", description: "C922" };
const LATE = { name: "alsa_input.usb-late", description: "Late" };
function seeded(list = [C922]) { const s = createMicSources(); s.requestRefresh(); s.finished(s.started(), list); return s; }

test("a cache hit is accepted without a refresh", () => {
  assert.deepEqual(seeded().check(C922.name), { verdict: "ok", refresh: false });
});

test("a miss starts a refresh even when the cache was just refreshed", () => {
  const s = seeded();                                       // refreshed a moment ago; LATE was plugged in afterwards
  assert.deepEqual(s.check(LATE.name), { verdict: "refreshing", refresh: true });
});

test("start requested but not yet started: a second check never asks for another start", () => {
  const s = seeded();
  assert.equal(s.check(LATE.name).refresh, true);
  assert.deepEqual(s.check(LATE.name), { verdict: "refreshing", refresh: false });
  assert.deepEqual(s.check("other"), { verdict: "refreshing", refresh: false });
  assert.equal(s.requestRefresh(), false);
  assert.equal(s.refreshing(), true);
  s.finished(s.started(), [C922]);
  assert.deepEqual(s.check("other"), { verdict: "no-such-source", refresh: false }, "a miss during the requested start is decided by it");
});

test("a retry while that refresh runs answers refreshing and starts no second one", () => {
  const s = seeded();
  s.check(LATE.name); s.started();
  assert.deepEqual(s.check(LATE.name), { verdict: "refreshing", refresh: false });
  assert.equal(s.refreshing(), true);
});

test("a refresh started after the miss decides: found accepts, missing refuses once", () => {
  const s = seeded();
  s.check(LATE.name); s.finished(s.started(), [C922, LATE]);
  assert.deepEqual(s.check(LATE.name), { verdict: "ok", refresh: false });
  const t = seeded();
  t.check("gone"); t.finished(t.started(), [C922]);
  assert.deepEqual(t.check("gone"), { verdict: "no-such-source", refresh: false });
  assert.deepEqual(t.check("gone"), { verdict: "refreshing", refresh: true }, "the answered miss was cleared: a new one starts over");
});

test("a refresh that started before the miss never answers no-such-source", () => {
  const s = seeded();
  assert.equal(s.requestRefresh(), true);
  const old = s.started();                                  // the panel's refresh, already running
  assert.deepEqual(s.check(LATE.name), { verdict: "refreshing", refresh: false });
  assert.equal(s.finished(old, [C922]), true, "the older refresh ending must start one that postdates the miss");
  assert.deepEqual(s.check(LATE.name), { verdict: "refreshing", refresh: false }, "start requested: waiting, no second start");
  s.finished(s.started(), [C922]);
  assert.deepEqual(s.check(LATE.name), { verdict: "no-such-source", refresh: false });
});

test("a failed refresh answers sources-unavailable and keeps the old list", () => {
  const s = seeded();
  s.check(LATE.name); s.finished(s.started(), null);
  assert.deepEqual(s.check(LATE.name), { verdict: "sources-unavailable", refresh: false });
  assert.deepEqual(s.list(), [C922]);
});

test("a late report from an abandoned refresh cannot finish the newer one", () => {
  const s = seeded();
  s.requestRefresh();
  const first = s.started();
  assert.equal(s.finished(first, null), false);              // its deadline expired: reported failed, abandoned
  s.requestRefresh();
  const second = s.started();
  assert.equal(s.finished(first, [C922, LATE]), false, "the old probe's late exit is ignored");
  assert.equal(s.refreshing(), true, "the newer refresh is still running");
  assert.deepEqual(s.list(), [C922], "and the stale result was not adopted");
  s.finished(second, [C922, LATE]);
  assert.deepEqual(s.list(), [C922, LATE]);
});

test("requestRefresh while one runs queues exactly one more", () => {
  const s = createMicSources();
  assert.equal(s.requestRefresh(), true);
  const a = s.started();
  assert.equal(s.requestRefresh(), false);
  assert.equal(s.finished(a, [C922]), true);
  assert.equal(s.requestRefresh(), false, "start already requested");
  const b = s.started();
  assert.equal(s.finished(b, [C922]), false);
  assert.equal(s.finished(b, [C922]), false, "a second report for the same refresh is ignored");
  assert.equal(s.refreshing(), false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/MicSources.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `lib/MicSources.mjs`:

```js
// Mic source picker spec §4.3/§4.4: the cached capture-source list and the cache-miss rule. A node missing from the
// cache is refused only after a refresh that STARTED after its first miss has completed; ipcMic answers at once and
// the caller retries. Ids order refreshes against misses (no clock ties) and identify each refresh, so a late report
// from an abandoned probe can never finish a newer one. Pure; Service runs pw-dump.
export function createMicSources() {
  let list = [];
  let seq = 0;                       // the last refresh id issued
  let running = null;                // { id } while a refresh runs
  let requested = false;             // a start was asked for and started() has not been called yet
  let last = null;                   // { id, ok } of the last completed refresh
  let again = false;                 // start another refresh as soon as the running one ends
  const misses = new Map();          // node → the value of `seq` when its first unanswered miss was recorded
  const ask = () => { requested = true; return true; };

  return {
    list() { return list.slice(); },
    refreshing() { return running !== null || requested; },
    check(node) {
      if (list.some(s => s.name === node)) { misses.delete(node); return { verdict: "ok", refresh: false }; }
      if (!misses.has(node)) misses.set(node, seq);
      const missSeq = misses.get(node);
      if (last && last.id > missSeq) {
        misses.delete(node);
        return { verdict: last.ok ? "no-such-source" : "sources-unavailable", refresh: false };
      }
      if (requested) return { verdict: "refreshing", refresh: false };   // the refresh about to start postdates the miss
      if (running) { if (running.id <= missSeq) again = true; return { verdict: "refreshing", refresh: false }; }
      return { verdict: "refreshing", refresh: ask() };
    },
    requestRefresh() {
      if (requested) return false;
      if (running) { again = true; return false; }
      return ask();
    },
    started() { requested = false; running = { id: ++seq }; return running.id; },
    finished(id, sources) {
      if (!running || running.id !== id) return false;
      last = { id, ok: Array.isArray(sources) };
      if (Array.isArray(sources)) list = sources.slice();
      running = null;
      if (!again) return false;
      again = false;
      return ask();
    },
  };
}
```

Check against "before the miss":
- The running refresh has id 2, and the miss records `seq` 2. `running.id <= missSeq` sets `again`.
- `finished(2)` sets `last.id` 2, which does not decide, because 2 is not greater than 2. Because `again` is set, `finished` returns `ask()`.
- While the start is requested, `check` answers `refresh: false`.
- The next refresh is id 3, and 3 is greater than 2, so it decides.

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/MicSources.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/MicSources.mjs tests/MicSources.test.mjs
git commit -m "feat(mic): source cache with refresh ids and a refresh-before-refusing miss rule"
```

---

### Task 3: `voice.systemDevice` in config and the commit write

**Files:**
- Modify: `lib/Defaults.mjs` (`DEFAULT_VOICE`), `lib/Config.mjs:97` (the `config.voice.mic` line), `components/ConfigStore.qml:123`
- Test: `tests/Config.test.mjs`

**Interfaces:**
- Consumes: `isNodeName` (Task 1).
- Produces: `config.voice.systemDevice: "default" | <node>`; problem code `system-device-invalid`; `configStore.setVoiceMic(mode: string, device: string | undefined)`. It writes `voice.mic`, and `voice.systemDevice` only when `device !== undefined`, as one write that emits `changed("commit")`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/Config.test.mjs` (it already imports `normalizeConfig` and `DEFAULT_CONFIG`; add them if a reviewer finds otherwise):

```js
test("voice.systemDevice: missing, non-string or invalid loads as default; a node name is kept", () => {
  const load = (v) => normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, systemDevice: v } });
  assert.equal(load(undefined).config.voice.systemDevice, "default");
  assert.equal(load(42).config.voice.systemDevice, "default");
  assert.equal(load(null).config.voice.systemDevice, "default");
  assert.equal(load("alsa_input.usb-C922").config.voice.systemDevice, "alsa_input.usb-C922");
  assert.equal(load("default").config.voice.systemDevice, "default");
  const bad = load("-rf");
  assert.equal(bad.config.voice.systemDevice, "default");
  assert.ok(bad.problems.some(p => p.code === "system-device-invalid"));
  assert.equal(load(42).problems.some(p => p.code === "system-device-invalid"), false, "a non-string is silently default");
  const noVoice = normalizeConfig({ ...DEFAULT_CONFIG, voice: undefined }).config;
  assert.equal(noVoice.voice.systemDevice, "default");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/Config.test.mjs`
Expected: FAIL on the first assertion (`undefined !== "default"`).

- [ ] **Step 3: Implement**

`lib/Defaults.mjs`: add `systemDevice: "default",` to `DEFAULT_VOICE`, directly after `mic: "remote",`, with the comment `// Mic source picker spec §3: "default" or a PipeWire node.name; used only while mic is "system".`

`lib/Config.mjs`: add `import { isNodeName } from "./AlsaMic.mjs";` beside the file's other imports. Insert after `config.voice.mic = …`:

```js
  // Mic source picker spec §3: "default" or a node name. A string that fails the node pattern is a problem, not silence.
  const sd = v.systemDevice;
  if (typeof sd === "string" && sd !== "default" && !isNodeName(sd))
    problems.push({ code: "system-device-invalid", message: `voice.systemDevice "${sd}" is not a PipeWire node name; using default` });
  config.voice.systemDevice = typeof sd === "string" && (sd === "default" || isNodeName(sd)) ? sd : "default";
```

`components/ConfigStore.qml:123`: replace `setVoiceMic` with:

```qml
  // Mic source picker spec §3: voice.mic and voice.systemDevice land in one write; remote passes no device.
  function setVoiceMic(mode, device) {
    var next = ConfigFile.withPatch(root.raw, ["voice", "mic"], mode)
    if (device !== undefined) next = ConfigFile.withPatch(next, ["voice", "systemDevice"], device)
    if (root._write(next)) root.changed("commit")
  }
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/*.test.mjs`
Expected: PASS everywhere. A test that deep-compares `DEFAULT_CONFIG.voice` may need `systemDevice: "default"` added; that is the only acceptable edit to an existing test here.

- [ ] **Step 5: Commit**

```bash
git add lib/Defaults.mjs lib/Config.mjs components/ConfigStore.qml tests/Config.test.mjs
git commit -m "feat(config): voice.systemDevice and a two-field mic commit"
```

---

### Task 4: Host ALSA block engine — single read, lock, atomic write; atvvoice moves onto it

**Files:**
- Modify: `host/omaremote-setup` (constants near `ALSA_BEGIN`, new functions, replace `alsa_rc_state` and `gen_alsa_rc`, the two ALSA spots in `cmd_atvvoice`)
- Create: `tests/setup-alsa-mic.sh` (this task adds the engine and atvvoice tests; Task 5 appends `alsa-mic` and facts tests)
- Modify: `Makefile` (`check`: add `bash tests/setup-alsa-mic.sh` after `bash tests/setup-atvvoice.sh`)

**Interfaces:**
- Produces (bash, sourced by tests and Task 5):
  - `NODE_RE`, `MIC_BEGIN`, `MIC_END`, `MIC_PCM`, `ALSA_LOCK_WAIT` constants.
  - `alsa_rc_read` sets `ALSA_CONTENT`.
  - `alsa_block_state <content> <begin> <end> <strict>` prints `absent` | `present` | `present <node>` | `bad`.
  - `alsa_rc_put <content> <begin> <end> <block-or-empty>` prints the new content.
  - `alsa_rc_write <content>`.
  - `alsa_rc_locked <fn> [args…]`.
  - `gen_mic_block <node>`.
  - `atv_alsa_write` sets `ALSA_CHANGED`.

- [ ] **Step 1: Write the failing tests**

Create `tests/setup-alsa-mic.sh`:

```bash
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

# ---- alsa_rc_locked: waits, then times out ----
rm -rf "$T/alsa"; mkdir -p "$T/alsa"
( flock "$RC.omaremote.lock" sleep 1 ) & sleep 0.2
t0=$(date +%s%N); lib 'alsa_rc_locked true'; rc=$?; t1=$(date +%s%N)
check "lock: waits for a short holder, then succeeds" "0" "$rc"
check "lock: really waited (>= 0.5 s)" "yes" "$( (( t1 - t0 >= 500000000 )) && echo yes || echo no )"
wait
( flock "$RC.omaremote.lock" sleep 3 ) & sleep 0.2
OMAREMOTE_ALSA_LOCK_WAIT=1 lib 'alsa_rc_locked true'; check "lock: held past the wait -> 1" "1" "$?"
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
```

The `NODE_RE` loop passes each name through the environment, so no quoting can alter it on the way.

- [ ] **Step 2: Run them to verify they fail**

Run: `bash tests/setup-alsa-mic.sh`
Expected: FAIL. `NODE_RE`, `alsa_block_state` and the rest are undefined, so most checks print `FAIL`, and the run ends with `RESULT: FAIL`.

- [ ] **Step 3: Implement the engine**

In `host/omaremote-setup`, right after `ALSA_END=…`, add:

```bash
# Mic source picker spec §4.1: the second managed block, the PCM Voxtype opens for a picked source.
MIC_BEGIN='# BEGIN omaremote mic (managed by omaremote-setup; do not edit)'
MIC_END='# END omaremote mic'
MIC_PCM=omaremote-mic
# Plan ruling 3: lib/AlsaMic.mjs NODE_RE is the same pattern. The first character is never `-`.
NODE_RE='^[A-Za-z0-9_.:][A-Za-z0-9_.:-]*$'
ALSA_LOCK_WAIT=${OMAREMOTE_ALSA_LOCK_WAIT:-5}
ALSA_CONTENT=""
ALSA_CHANGED=0
```

Delete the functions `alsa_rc_state` and `gen_alsa_rc` and their comments. Then run `grep -n 'alsa_rc_state\|gen_alsa_rc' host/ tests/` and change any remaining caller to the functions below. In their place, after `gen_alsa_block`, add:

```bash
gen_mic_block() {   # gen_mic_block <node>: the canonical mic block, markers included, no final newline
  printf '%s\npcm.%s {\n  type pipewire\n  capture_node "%s"\n  hint { show on description "omaremote picked microphone" }\n}\n%s' \
    "$MIC_BEGIN" "$MIC_PCM" "$1" "$MIC_END"
}

# Spec §4.2 single-snapshot parsing: one open of $ALSA_RC, its whole content into ALSA_CONTENT. Every parse below works
# on this copy, never on the pathname again, so a writer's rename can never mix two versions into one reading.
# A missing file reads as empty. The trailing `x` keeps the file's final newlines, which $(...) would strip.
alsa_rc_read() {
  ALSA_CONTENT=""
  [[ -e $ALSA_RC ]] || return 0
  local c; c=$(cat -- "$ALSA_RC" && printf x) || return 1
  ALSA_CONTENT=${c%x}
}

# alsa_block_state <content> <begin> <end> <strict>: absent | present | present <node> | bad.
# bad = unbalanced, misordered or repeated markers; with strict=1 (the mic block) also anything but exactly one
# `capture_node "<node>"` line between them whose value matches NODE_RE.
alsa_block_state() {
  printf '%s' "$1" | awk -v beg="$2" -v end="$3" -v strict="$4" -v re="$NODE_RE" '
    $0 == beg { nb++; if (ne > 0 || inb) bad = 1; inb = 1; next }
    $0 == end { ne++; if (!inb) bad = 1; inb = 0; next }
    inb && $0 ~ /^[ \t]*capture_node[ \t]/ {
      nc++; v = $0
      ok = sub(/^[ \t]*capture_node[ \t]+"/, "", v) && sub(/"[ \t]*$/, "", v)
      if (!ok || v !~ re) badv = 1
    }
    END {
      if (nb == 0 && ne == 0) { print "absent"; exit }
      if (bad || nb != 1 || ne != 1 || inb) { print "bad"; exit }
      if (strict == "1") { if (nc != 1 || badv) print "bad"; else print "present " v; exit }
      print "present"
    }'
}

# alsa_rc_put <content> <begin> <end> <block>: the new content (spec §4.1 layout). The caller has ruled out `bad`.
# Absent + block: append, after one newline only if the content does not already end in one (the ONLY byte this
# function ever adds outside a block). Present: cut the content at the BEGIN and END lines and keep both outside parts
# byte for byte (a last line without a newline included); put the block between them, or nothing when it is empty.
# No awk here: awk's print would re-terminate every outside line it copies.
alsa_rc_put() {
  local c=$1 b=$2 e=$3 blk=$4 pre rest post endnl=1
  if [[ $(alsa_block_state "$c" "$b" "$e" 0) == absent ]]; then
    printf '%s' "$c"
    if [[ -z $blk ]]; then return 0; fi
    if [[ -n $c && ${c: -1} != $'\n' ]]; then printf '\n'; fi
    printf '%s\n' "$blk"
    return 0
  fi
  # present: exactly one BEGIN line, before exactly one END line. BEGIN is never the last line, so a newline follows it.
  if [[ $c == "$b"$'\n'* ]]; then pre=""; rest=${c#"$b"$'\n'}
  else pre=${c%%$'\n'"$b"$'\n'*}$'\n'; rest=${c#*$'\n'"$b"$'\n'}; fi
  if [[ $rest == "$e" ]]; then post=""; endnl=0                        # block is the whole rest, END unterminated
  elif [[ $rest == "$e"$'\n'* ]]; then post=${rest#"$e"$'\n'}
  elif [[ $rest == *$'\n'"$e"$'\n'* ]]; then post=${rest#*$'\n'"$e"$'\n'}
  else post=""; endnl=0; fi                                             # END is the last line, unterminated
  printf '%s' "$pre"
  if [[ -n $blk ]]; then printf '%s' "$blk"; if (( endnl )); then printf '\n'; fi; fi
  printf '%s' "$post"
}

# alsa_rc_write <content>: atomic replace, a temp file in the same directory then a rename. Readers never see a part.
alsa_rc_write() {
  local dir tmp; dir=$(dirname -- "$ALSA_RC")
  tmp=$(mktemp "$dir/.asoundrc.omaremote.XXXXXX") || return 1
  if ! printf '%s' "$1" > "$tmp"; then rm -f -- "$tmp"; return 1; fi
  if [[ -e $ALSA_RC ]]; then chmod --reference="$ALSA_RC" "$tmp" 2>/dev/null || true; else chmod 644 "$tmp"; fi
  mv -f -- "$tmp" "$ALSA_RC" || { rm -f -- "$tmp"; return 1; }
}

# alsa_rc_locked <fn> [args]: run fn holding the exclusive lock every repo writer of $ALSA_RC takes (spec §4.2), for
# the whole read-compare-generate-rename. Returns fn's status, or 1 when the directory cannot be made or the lock is
# not had within ALSA_LOCK_WAIT seconds. Editors outside the repo do not take it; spec §4.2 states what that leaves.
alsa_rc_locked() {
  local fd rc=0
  mkdir -p -- "$(dirname -- "$ALSA_RC")" 2>/dev/null || return 1
  exec {fd}>>"$ALSA_RC.omaremote.lock" || return 1
  if ! flock -w "$ALSA_LOCK_WAIT" "$fd"; then exec {fd}>&-; return 1; fi
  "$@" || rc=$?
  exec {fd}>&-
  return "$rc"
}

# atv_alsa_write: under the lock. Writes the atvvoice block if it changed; 2 = bad markers; sets ALSA_CHANGED.
atv_alsa_write() {
  ALSA_CHANGED=0
  alsa_rc_read || return 1
  [[ $(alsa_block_state "$ALSA_CONTENT" "$ALSA_BEGIN" "$ALSA_END" 0) == bad ]] && return 2
  local new; new=$(alsa_rc_put "$ALSA_CONTENT" "$ALSA_BEGIN" "$ALSA_END" "$(gen_alsa_block)"; printf x) || return 1
  new=${new%x}
  [[ $new == "$ALSA_CONTENT" ]] && return 0
  alsa_rc_write "$new" || return 1
  ALSA_CHANGED=1
}
```

`gen_alsa_block` emits its block with a trailing newline. That newline is dropped when the output is captured with `"$(gen_alsa_block)"`, and that capture is the form both callers use.

In `cmd_atvvoice`, replace the read-only pre-check with:

```bash
  # And a user ALSA file we cannot edit safely (read-only check, one read), so it fails before anything is built or written.
  alsa_rc_read || die "cannot read $ALSA_RC"
  [[ $(alsa_block_state "$ALSA_CONTENT" "$ALSA_BEGIN" "$ALSA_END" 0) != bad ]] \
    || die "$ALSA_RC has unbalanced or misordered '$ALSA_BEGIN' / '$ALSA_END' markers; fix it by hand. Nothing was changed."
```

Then replace the block from `gen_alsa_rc "$ALSA_RC" > "$WORKDIR/asoundrc" …` through the closing `fi` of the `cmp`/`cp` branch with:

```bash
  # The ALSA PCM: written after the build and the unit, so a failed build leaves this file alone too. Locked and
  # atomic, like every repo writer of this file (mic source picker spec §4.2).
  local alsa_rc=0
  alsa_rc_locked atv_alsa_write || alsa_rc=$?
  case $alsa_rc in
    0) ;;
    2) die "cannot generate $ALSA_RC (markers changed during the run?)" ;;
    *) die "cannot write $ALSA_RC" ;;
  esac
  local alsa_changed=$ALSA_CHANGED
  if (( alsa_changed )); then say "wrote $ALSA_RC (ALSA PCM $ATV_NODE)"; else say "ALSA PCM $ATV_NODE: unchanged"; fi
```

The `try-restart voxtype` block that follows keeps reading `alsa_changed` unchanged.

- [ ] **Step 4: Run both host test files**

Run: `bash tests/setup-alsa-mic.sh; bash tests/setup-atvvoice.sh`
Expected: both end `RESULT: PASS`. If an atvvoice check fails only because a fresh append no longer adds a blank line (plan ruling 7), update that one expected string. Anything else is a regression to fix in the engine, not in the test.

- [ ] **Step 5: Add the file to `make check`**

In `Makefile`, under `check:`, add `	bash tests/setup-alsa-mic.sh` (tab-indented) on the line after `	bash tests/setup-atvvoice.sh`.

- [ ] **Step 6: Commit**

```bash
git add host/omaremote-setup tests/setup-alsa-mic.sh Makefile
git commit -m "feat(setup): locked single-read asoundrc block engine; atvvoice writes through it"
```

---

### Task 5: `omaremote-setup alsa-mic` and the two new facts

**Files:**
- Modify: `host/omaremote-setup` (new functions after `atv_alsa_write`, `main` case, `usage`)
- Modify: `host/omaremote-facts` (`alsa.mic`, `pipewire.defaultSource`)
- Test: `tests/setup-alsa-mic.sh` (append before the final `RESULT` lines)

**Interfaces:**
- Consumes: the Task 4 engine.
- Produces:
  - CLI `omaremote-setup alsa-mic get` and `omaremote-setup alsa-mic set (<node> | --absent) (--expect <node> | --expect-absent)`, with the exit codes from Global Constraints.
  - Facts `alsa.mic`: one of `{"state":"absent"}`, `{"state":"present","node":…}`, `{"state":"bad"}`, or `null`.
  - Facts `pipewire.defaultSource`: a string or `null`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/setup-alsa-mic.sh` (before `printf '\n%s\n' "$([[ $fail …`):

```bash
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
```

- [ ] **Step 2: Run to verify the new checks fail**

Run: `bash tests/setup-alsa-mic.sh`
Expected: `FAIL` lines for every `alsa-mic`, concurrency and facts check. `main` dies with "unknown subcommand: alsa-mic", which exits 1.

- [ ] **Step 3: Implement `alsa-mic`**

In `host/omaremote-setup`, after `atv_alsa_write`:

```bash
alsa_mic_json() {   # alsa_mic_json absent | "present <node>": the one-line JSON alsa-mic prints
  if [[ $1 == absent ]]; then printf '{"state":"absent"}\n'; else printf '{"state":"present","node":"%s"}\n' "${1#present }"; fi
}
alsa_mic_usage() {
  printf 'usage: omaremote-setup alsa-mic get\n       omaremote-setup alsa-mic set (<node> | --absent) (--expect <node> | --expect-absent)\n' >&2
  exit 64
}
alsa_mic_node() { [[ $1 =~ $NODE_RE ]] || { printf 'omaremote-setup: not a PipeWire node name: %s\n' "$1" >&2; exit 64; }; }

# alsa_mic_set <target> <expected>: under the lock. States are "absent" or "present <node>".
# 2 = bad block, 3 = mismatch (current state printed), 1 = I/O; the file is unchanged on every non-zero return.
alsa_mic_set() {
  local st new blk=""
  alsa_rc_read || return 1
  st=$(alsa_block_state "$ALSA_CONTENT" "$MIC_BEGIN" "$MIC_END" 1)
  [[ $st == bad ]] && return 2
  if [[ $st != "$2" ]]; then alsa_mic_json "$st"; return 3; fi
  [[ $1 == absent ]] || blk=$(gen_mic_block "${1#present }")
  new=$(alsa_rc_put "$ALSA_CONTENT" "$MIC_BEGIN" "$MIC_END" "$blk"; printf x) || return 1
  new=${new%x}
  [[ $new == "$ALSA_CONTENT" ]] && return 0
  alsa_rc_write "$new"
}

cmd_alsa_mic() {   # mic source picker spec §4.2. No root, no prompt: the plugin calls this.
  case ${1:-} in
    get)
      (( $# == 1 )) || alsa_mic_usage
      alsa_rc_read || exit 1
      local st; st=$(alsa_block_state "$ALSA_CONTENT" "$MIC_BEGIN" "$MIC_END" 1)
      if [[ $st == bad ]]; then printf 'omaremote-setup: the omaremote mic block in %s is malformed\n' "$ALSA_RC" >&2; exit 2; fi
      alsa_mic_json "$st"; exit 0 ;;
    set)
      shift
      local target="" expect="" rc=0
      while (( $# )); do
        case $1 in
          --absent) [[ -z $target ]] || alsa_mic_usage; target=absent; shift ;;
          --expect-absent) [[ -z $expect ]] || alsa_mic_usage; expect=absent; shift ;;
          --expect) [[ -z $expect && $# -ge 2 ]] || alsa_mic_usage; alsa_mic_node "$2"; expect="present $2"; shift 2 ;;
          -*) alsa_mic_usage ;;
          *) [[ -z $target ]] || alsa_mic_usage; alsa_mic_node "$1"; target="present $1"; shift ;;
        esac
      done
      [[ -n $target && -n $expect ]] || alsa_mic_usage
      alsa_rc_locked alsa_mic_set "$target" "$expect" || rc=$?
      exit "$rc" ;;
    *) alsa_mic_usage ;;
  esac
}
```

In `main`'s `case`, add `    alsa-mic) shift; cmd_alsa_mic "$@" ;;` after the `atvvoice)` line. In `usage`, add after the `atvvoice` entry:

```
  alsa-mic get | set (<node> | --absent) (--expect <node> | --expect-absent)
           read or compare-and-set the omaremote-mic PCM block (used by the plugin's mic picker; JSON out)
```

- [ ] **Step 4: Implement the facts**

In `host/omaremote-facts`, inside the `if has pw-dump && raw=$(bounded pw-dump); then` block, after `pw_sources=…`, add:

```bash
  # Mic source picker spec §6 last-capture: the PipeWire default source, from the `default` metadata object.
  pw_default=$(jq -c '[.[] | select(.type == "PipeWire:Interface:Metadata") | select((.props["metadata.name"] // "") == "default")
                       | .metadata[]? | select(.subject == 0 and .key == "default.audio.source") | .value.name? | strings] | .[0] // null' <<<"$raw" 2>/dev/null)
```

After `pw_sources=${pw_sources:-null}`, add `pw_default=${pw_default:-null}`. After the `alsa_pcms` lines, add:

```bash
# Mic source picker spec §6 condition 2: the omaremote mic block, read by the same parser that writes it.
SELF_DIR=$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")
alsa_mic=null
out=$(timeout "$TO" bash "$SELF_DIR/omaremote-setup" alsa-mic get 2>/dev/null); rc=$?
if (( rc == 0 )); then alsa_mic=$(jq -c 'select(.state == "absent" or .state == "present")' <<<"$out" 2>/dev/null); alsa_mic=${alsa_mic:-null}
elif (( rc == 2 )); then alsa_mic='{"state":"bad"}'; fi
```

In the final JSON, change the two lines to:

```
 "pipewire":{"sources":$pw_sources,"defaultSource":$pw_default},
 "alsa":{"pcms":$alsa_pcms,"mic":$alsa_mic},
```

- [ ] **Step 5: Run the host tests**

Run: `bash tests/setup-alsa-mic.sh; bash tests/setup-atvvoice.sh; bash tests/setup-helpers.sh`
Expected: all three end `RESULT: PASS`. If the facts checks print `null` everywhere, a tool `omaremote-setup` runs at load time (for example `sha256sum` or `cut`) is missing from `FB`. Add it to the `for t in …` list, since that list only mirrors the real script's needs.

- [ ] **Step 6: Commit**

```bash
git add host/omaremote-setup host/omaremote-facts tests/setup-alsa-mic.sh
git commit -m "feat(setup): alsa-mic get/set compare-and-set; facts report alsa.mic and the default source"
```

---

### Task 6: MicApply — ALSA phases, rollback step, progress across a defer

**Files:**
- Modify: `lib/MicApply.mjs`
- Test: `tests/MicApply.test.mjs` (append; existing tests must keep passing unchanged except where noted)

**Interfaces:**
- Consumes: `MIC_PCM`, `isNodeName`, `absent`, `present`, `parseAlsaState`, `sameAlsa`, `alsaSetArgv` (Task 1).
- Produces:
  - `createMicApply({ voice, alsaArgv = ["omaremote-setup", "alsa-mic"] })`.
  - `request(mode, now, { nodeName?, device? })`. `device` is `"default"` or a node name, honoured only for `system`. A device that fails the pattern answers `{ ok:false, reason:"invalid-source" }`.
  - New `cmd` kinds: `alsa-get`, `alsa-set`, `alsa-restore`.
  - The `commit` effect is `{ type:"commit", mode, device }` for `system`, where `device` is the node or `"default"`, and `{ type:"commit", mode:"remote" }` (no `device` key) for `remote`.
  - The `conflict` effect gains `target: "device" | "alsa"`. For `alsa`, `expected` and `found` are block states, and `found` may be `null`.
  - `statusOf()` and history records gain `device`, and an `unresolved` record gains `partial` when it applies.

- [ ] **Step 1: Write the failing tests**

Append to `tests/MicApply.test.mjs`.

Timing rule these tests rely on: `ready()` records a fresh backend reading at t=0, and MicApply treats it as fresh for 500 ms (`FRESH_MS`). A deferred rollback therefore resumes *inside* whatever call makes the system quiet, if that call happens before t=500. To make the resume land on an explicit, asserted call, every test that resumes a deferred rollback drains or clears at t≥1000. The stale view then yields only a `poll`, and the following `mic.backend("idle", t, { fresh: true })` returns the rollback's first command.

```js
// ---- mic source picker (spec §5) ----
const N = "alsa_input.usb-C922";
const ABSENT = JSON.stringify({ state: "absent" });
const PRESENT = (n) => JSON.stringify({ state: "present", node: n });
const GET_MIC = JSON.stringify({ key: "audio.device", value: "omaremote-mic", file_value: "omaremote-mic" });
const AM = ["omaremote-setup", "alsa-mic"];
const argvOf = (fx, kind) => byType(fx, "cmd").find(c => c.kind === kind).argv;
// toAlsaSet: a system + N request driven up to its in-flight alsa-set
function toAlsaSet(mic, prev = ABSENT, getOut = GET_OUT) {
  const { effects, result } = mic.request("system", 0, { device: N });
  const ag = mic.cmdExit(cmdId(effects, "get"), 0, getOut, 1);
  const as = mic.cmdExit(cmdId(ag, "alsa-get"), 0, prev, 2);
  return { id: result.operationId, as };
}
// drive: answer every command with success (get → GET_OUT, alsa-get → ABSENT) and every verify with ok; the kinds seen
function drive(mic, mode, opts) {
  const seen = [];
  let fx = mic.request(mode, 0, opts).effects, t = 1;
  for (let guard = 0; guard < 20; guard++) {
    const c = byType(fx, "cmd")[0];
    if (c) { seen.push(c.kind); fx = mic.cmdExit(c.id, 0, c.kind === "get" ? GET_OUT : c.kind === "alsa-get" ? ABSENT : "", t++); continue; }
    if (byType(fx, "verify").length) { fx = mic.verifyResult(true, t++); continue; }
    break;
  }
  return seen;
}

test("picker: system + node snapshots both, then writes: get, alsa-get, alsa-set, set, restart, commit with device", () => {
  const { mic, voice } = ready();
  const { effects, result } = mic.request("system", 0, { device: N });
  assert.deepEqual(kinds(effects), ["get"]);
  const ag = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  assert.deepEqual(argvOf(ag, "alsa-get"), [...AM, "get"]);
  const as = mic.cmdExit(cmdId(ag, "alsa-get"), 0, ABSENT, 2);
  assert.deepEqual(argvOf(as, "alsa-set"), [...AM, "set", N, "--expect-absent"]);
  const set = mic.cmdExit(cmdId(as, "alsa-set"), 0, "", 3);
  assert.deepEqual(argvOf(set, "set"), ["voxtype", "config", "set", "audio.device", "omaremote-mic"]);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 4);
  assert.deepEqual(kinds(restart), ["restart"]);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 5);
  const done = mic.verifyResult(true, 6);
  assert.deepEqual(byType(done, "commit"), [{ type: "commit", mode: "system", device: N }]);
  assert.equal(byType(done, "done")[0].state, "succeeded");
  assert.equal(mic.statusOf(result.operationId).device, N);
  assert.equal(voice.gate.busy(), false);
});

test("picker: only system + node issues alsa commands (the driver sees them when they exist)", () => {
  assert.deepEqual(drive(ready().mic, "system", { device: N }), ["get", "alsa-get", "alsa-set", "set", "restart"]);
  assert.deepEqual(drive(ready().mic, "system", {}), ["get", "set", "restart"]);
  assert.deepEqual(drive(ready().mic, "system", { device: "default" }), ["get", "set", "restart"]);
  assert.deepEqual(drive(ready().mic, "remote", { nodeName: "N" }), ["get", "set", "restart"]);
});

test("picker: commit carries device default for system default, no device key for remote", () => {
  const sys = ready().mic; const { effects } = sys.request("system", 0, {});
  const s1 = sys.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1); const r1 = sys.cmdExit(cmdId(s1, "set"), 0, "", 2);
  sys.cmdExit(cmdId(r1, "restart"), 0, "", 3);
  assert.deepEqual(byType(sys.verifyResult(true, 4), "commit"), [{ type: "commit", mode: "system", device: "default" }]);
});

test("picker: an invalid device is refused before anything is queued", () => {
  const { mic } = ready();
  for (const d of ["-rf", "a b", 'a"b', ""]) assert.deepEqual(mic.request("system", 0, { device: d }).result, { ok: false, reason: "invalid-source" }, d);
  assert.equal(mic.pending(), false);
});

test("picker: alsa-set expects the snapshot state; a matching block skips alsa-set", () => {
  const a = ready().mic; const { as } = toAlsaSet(a, PRESENT("old"));
  assert.deepEqual(argvOf(as, "alsa-set"), [...AM, "set", N, "--expect", "old"]);
  const b = ready().mic; const { as: skipped } = toAlsaSet(b, PRESENT(N));
  assert.deepEqual(kinds(skipped), ["set"], "already the picked node: straight to audio.device");
});

test("picker: snapshot failures end preflight-failed with no write and no rollback", () => {
  const cases = [["get fails", (m, fx) => m.cmdExit(cmdId(fx, "get"), 1, "", 1)],
    ["alsa-get exits 1", (m, fx) => m.cmdExit(cmdId(m.cmdExit(cmdId(fx, "get"), 0, GET_OUT, 1), "alsa-get"), 1, "", 2)],
    ["alsa-get exits 2 (bad block)", (m, fx) => m.cmdExit(cmdId(m.cmdExit(cmdId(fx, "get"), 0, GET_OUT, 1), "alsa-get"), 2, "", 2)],
    ["alsa-get prints garbage", (m, fx) => m.cmdExit(cmdId(m.cmdExit(cmdId(fx, "get"), 0, GET_OUT, 1), "alsa-get"), 0, "none", 2)]];
  for (const [name, step] of cases) {
    const { mic, voice } = ready();
    const fx = step(mic, mic.request("system", 0, { device: N }).effects);
    const d = byType(fx, "done")[0];
    assert.equal(d.error, "preflight-failed", name);
    assert.equal(d.rollback, undefined, name);
    assert.deepEqual(kinds(fx), [], name);
    assert.equal(voice.gate.busy(), false, name);
  }
});

test("picker: a job found at the job check ends job-pending before any alsa-set", () => {
  const { mic } = ready();
  const { effects } = mic.request("system", 0, { device: N });
  const ag = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  mic.systemdJob(true, 2);
  const fx = mic.cmdExit(cmdId(ag, "alsa-get"), 0, ABSENT, 3);
  assert.deepEqual(kinds(fx), []);
  assert.equal(byType(fx, "done")[0].error, "job-pending");
  assert.equal(byType(fx, "done")[0].rollback, undefined);
});

test("picker: a live alsa-set exiting 3 or 1/2 fails with rollback verified and no restart", () => {
  for (const [code, err] of [[3, "alsa-conflict"], [2, "alsa-set-failed"], [1, "alsa-set-failed"]]) {
    const { mic, voice } = ready();
    const { as } = toAlsaSet(mic);
    const fx = mic.cmdExit(cmdId(as, "alsa-set"), code, code === 3 ? PRESENT("x") : "", 3);
    const d = byType(fx, "done")[0];
    assert.deepEqual([d.state, d.error, d.rollback], ["failed", err, "verified"], `exit ${code}`);
    assert.deepEqual(kinds(fx), [], `exit ${code}: nothing to restart`);
    assert.equal(voice.gate.busy(), false);
  }
});

test("picker: a live alsa-set killed by its deadline is assumed written and rolled back by compare-and-set", () => {
  const { mic } = ready();
  const { as } = toAlsaSet(mic);
  const chk = mic.cmdExit(cmdId(as, "alsa-set"), 124, "", 3);
  assert.deepEqual(kinds(chk), ["get"]);
  const ra = mic.cmdExit(cmdId(chk, "get"), 0, GET_OUT, 4);
  assert.deepEqual(argvOf(ra, "alsa-restore"), [...AM, "set", "--absent", "--expect", N]);
  const rs = mic.cmdExit(cmdId(ra, "alsa-restore"), 3, ABSENT, 5);     // it had not landed: the file already holds alsaPrev
  assert.deepEqual(kinds(rs), ["restart"]);
  mic.cmdExit(cmdId(rs, "restart"), 0, "", 6);
  const v = mic.verifyResult(true, 7);
  assert.deepEqual([byType(v, "done")[0].error, byType(v, "done")[0].rollback], ["alsa-set-failed", "verified"]);
  assert.equal(byType(v, "conflict").length, 0);
});

test("picker: set failing after alsa-set restores the block, then restarts", () => {
  const { mic } = ready();
  const { as } = toAlsaSet(mic);
  const set = mic.cmdExit(cmdId(as, "alsa-set"), 0, "", 3);
  const chk = mic.cmdExit(cmdId(set, "set"), 1, "", 4);
  assert.deepEqual(kinds(chk), ["get"]);
  const ra = mic.cmdExit(cmdId(chk, "get"), 0, GET_OUT, 5);           // audio.device untouched: nothing to write back
  assert.deepEqual(argvOf(ra, "alsa-restore"), [...AM, "set", "--absent", "--expect", N]);
  const rs = mic.cmdExit(cmdId(ra, "alsa-restore"), 0, "", 6);
  assert.deepEqual(kinds(rs), ["restart"], "the block was live for the daemon: restart");
  mic.cmdExit(cmdId(rs, "restart"), 0, "", 7);
  assert.equal(byType(mic.verifyResult(true, 8), "done")[0].rollback, "verified");
});

test("picker: restart failure rolls back in order — audio.device, then the block, then restart", () => {
  const { mic } = ready();
  const { as } = toAlsaSet(mic, PRESENT("old"));
  const set = mic.cmdExit(cmdId(as, "alsa-set"), 0, "", 3);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 4);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 5);
  const chk = mic.verifyResult(false, 6);
  assert.deepEqual(kinds(chk), ["get"]);
  const unset = mic.cmdExit(cmdId(chk, "get"), 0, GET_MIC, 7);
  assert.deepEqual(kinds(unset), ["unset"]);
  const ra = mic.cmdExit(cmdId(unset, "unset"), 0, "", 8);
  assert.deepEqual(argvOf(ra, "alsa-restore"), [...AM, "set", "old", "--expect", N]);
  const rs = mic.cmdExit(cmdId(ra, "alsa-restore"), 0, "", 9);
  assert.deepEqual(kinds(rs), ["restart"]);
  mic.cmdExit(cmdId(rs, "restart"), 0, "", 10);
  const v = mic.verifyResult(true, 11);
  assert.deepEqual([byType(v, "done")[0].error, byType(v, "done")[0].rollback], ["verify-failed", "verified"]);
});

// rollbackToAlsa: drive to the in-flight alsa-restore of a verify-failure rollback (prev block absent)
function rollbackToAlsa(mic) {
  const { as, id } = toAlsaSet(mic);
  const set = mic.cmdExit(cmdId(as, "alsa-set"), 0, "", 3);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 4);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 5);
  const chk = mic.verifyResult(false, 6);
  const unset = mic.cmdExit(cmdId(chk, "get"), 0, GET_MIC, 7);
  const ra = mic.cmdExit(cmdId(unset, "unset"), 0, "", 8);
  return { id, ra };
}

test("picker: alsa-restore exit 3 emits an alsa conflict, still restarts, and stays conflict after a good verify", () => {
  const { mic } = ready();
  const { ra } = rollbackToAlsa(mic);
  const rs = mic.cmdExit(cmdId(ra, "alsa-restore"), 3, PRESENT("someone-else"), 9);
  assert.deepEqual(byType(rs, "conflict"), [{ type: "conflict", target: "alsa", expected: { state: "present", node: N }, found: { state: "present", node: "someone-else" } }]);
  assert.ok(byType(rs, "hud").some(h => h.text === "microphone config changed externally"));
  assert.deepEqual(kinds(rs), ["restart"]);
  mic.cmdExit(cmdId(rs, "restart"), 0, "", 10);
  assert.equal(byType(mic.verifyResult(true, 11), "done")[0].rollback, "conflict");
});

test("picker: alsa-restore exit 2 is partly restored: restart, rollback failed, nothing deferred", () => {
  const { mic, voice } = ready();
  const { ra } = rollbackToAlsa(mic);
  const rs = mic.cmdExit(cmdId(ra, "alsa-restore"), 2, "", 9);
  assert.deepEqual(byType(rs, "unconfigured"), [{ type: "unconfigured", reason: "microphone partly restored" }]);
  assert.deepEqual(kinds(rs), ["restart"]);
  mic.cmdExit(cmdId(rs, "restart"), 0, "", 10);
  assert.equal(byType(mic.verifyResult(true, 11), "done")[0].rollback, "failed");
  assert.equal(mic.pending(), false);
  assert.equal(voice.gate.busy(), false);
});

test("picker: a conflict on audio.device ends the rollback with no alsa-restore", () => {
  const { mic } = ready();
  const { as } = toAlsaSet(mic);
  const set = mic.cmdExit(cmdId(as, "alsa-set"), 0, "", 3);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 4);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 5);
  const chk = mic.verifyResult(false, 6);
  const fx = mic.cmdExit(cmdId(chk, "get"), 0, JSON.stringify({ value: "other", file_value: "other" }), 7);
  assert.deepEqual(kinds(fx), []);
  assert.deepEqual(byType(fx, "conflict"), [{ type: "conflict", target: "device", expected: "omaremote-mic", found: "other" }]);
});

test("picker: reset while alsa-set is in flight defers; the drained exit 0 is restored by the deferred rollback", () => {
  const { mic } = ready();
  const { id, as } = toAlsaSet(mic);
  const r = mic.reset(10);
  assert.equal(byType(r, "done")[0].rollback, "deferred");
  assert.deepEqual(kinds(r), []);
  mic.cmdExit(cmdId(as, "alsa-set"), 0, "", 1000);                  // drains into the deferred snapshot; backend view is stale
  const go = mic.backend("idle", 1001, { fresh: true });
  assert.deepEqual(kinds(go), ["get"]);
  const ra = mic.cmdExit(cmdId(go, "get"), 0, GET_OUT, 1002);
  assert.deepEqual(argvOf(ra, "alsa-restore"), [...AM, "set", "--absent", "--expect", N]);
  const rs = mic.cmdExit(cmdId(ra, "alsa-restore"), 0, "", 1003);
  assert.deepEqual(kinds(rs), ["restart"], "the drained write made the service dirty");
  mic.cmdExit(cmdId(rs, "restart"), 0, "", 1004);
  mic.verifyResult(true, 1005);
  assert.equal(mic.statusOf(id).rollback, "verified");
  assert.equal(mic.pending(), false);
});

test("picker: reset while alsa-set is in flight; a drained exit 3 needs neither alsa-restore nor restart", () => {
  const { mic } = ready();
  const { id, as } = toAlsaSet(mic);
  mic.reset(10);
  mic.cmdExit(cmdId(as, "alsa-set"), 3, PRESENT("x"), 1000);
  const go = mic.backend("idle", 1001, { fresh: true });
  const fx = mic.cmdExit(cmdId(go, "get"), 0, GET_OUT, 1002);
  assert.deepEqual(kinds(fx), []);
  assert.equal(mic.statusOf(id).rollback, "verified");
});

test("picker: reset while alsa-get is in flight fails with nothing to roll back", () => {
  const { mic } = ready();
  const { effects } = mic.request("system", 0, { device: N });
  mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const r = mic.reset(2);
  assert.equal(byType(r, "done")[0].rollback, undefined);
  assert.equal(mic.pending(), false);
});

test("picker: alsa-set done, a job before set defers; the deferred rollback restores the block", () => {
  const { mic } = ready();
  const { id, as } = toAlsaSet(mic);
  mic.systemdJob(true, 3);
  const fx = mic.cmdExit(cmdId(as, "alsa-set"), 0, "", 4);
  assert.deepEqual([byType(fx, "done")[0].error, byType(fx, "done")[0].rollback], ["job-pending", "deferred"]);
  mic.systemdJob(false, 1000);                                      // job gone, but the backend view (t=0) is stale
  const go = mic.backend("idle", 1001, { fresh: true });
  const ra = mic.cmdExit(cmdId(go, "get"), 0, GET_OUT, 1002);
  assert.deepEqual(kinds(ra), ["alsa-restore"]);
  const rs = mic.cmdExit(cmdId(ra, "alsa-restore"), 0, "", 1003);
  mic.cmdExit(cmdId(rs, "restart"), 0, "", 1004);
  mic.verifyResult(true, 1005);
  assert.equal(mic.statusOf(id).rollback, "verified");
});

test("picker: a partial outcome survives a defer and the resume re-runs nothing", () => {
  for (const [code, out, want] of [[2, "", "failed"], [3, PRESENT("x"), "conflict"]]) {
    const { mic } = ready();
    const { id, ra } = rollbackToAlsa(mic);
    mic.systemdJob(true, 9);
    const fx = mic.cmdExit(cmdId(ra, "alsa-restore"), code, out, 10);
    assert.equal(byType(fx, "done")[0].rollback, "deferred", `exit ${code}`);
    mic.systemdJob(false, 1000);
    const go = mic.backend("idle", 1001, { fresh: true });
    assert.deepEqual(kinds(go), ["restart"], `exit ${code}: resume goes straight to the restart`);
    mic.cmdExit(cmdId(go, "restart"), 0, "", 1002);
    mic.verifyResult(true, 1003);
    assert.equal(mic.statusOf(id).rollback, want, `exit ${code}`);
  }
});

test("picker: a defer that expires keeps the partial outcome beside unresolved", () => {
  const { mic } = ready();
  const { id, ra } = rollbackToAlsa(mic);
  mic.systemdJob(true, 9);
  mic.cmdExit(cmdId(ra, "alsa-restore"), 3, PRESENT("x"), 10);
  const fx = mic.advance(10 + 60000);
  assert.equal(byType(fx, "unconfigured")[0].reason, "mic change unresolved");
  assert.deepEqual([mic.statusOf(id).rollback, mic.statusOf(id).partial], ["unresolved", "conflict"]);
});

test("picker: reset while alsa-restore is in flight; its drained exit sets the progress", () => {
  const { mic } = ready();
  const { id, ra } = rollbackToAlsa(mic);
  mic.reset(9);
  mic.cmdExit(cmdId(ra, "alsa-restore"), 0, "", 1000);
  const go = mic.backend("idle", 1001, { fresh: true });
  assert.deepEqual(kinds(go), ["restart"], "device done before the defer, block done by the drain");
  mic.cmdExit(cmdId(go, "restart"), 0, "", 1002);
  mic.verifyResult(true, 1003);
  assert.equal(mic.statusOf(id).rollback, "verified");
});

test("picker: switching between two sources still writes audio.device and restarts", () => {
  const { mic } = ready();
  const { as } = toAlsaSet(mic, PRESENT("old"), GET_MIC);
  const set = mic.cmdExit(cmdId(as, "alsa-set"), 0, "", 3);
  assert.deepEqual(argvOf(set, "set"), ["voxtype", "config", "set", "audio.device", "omaremote-mic"]);
  assert.deepEqual(kinds(mic.cmdExit(cmdId(set, "set"), 0, "", 4)), ["restart"]);
});

test("picker: with alsa-set skipped, mutated begins at set (a reset then defers)", () => {
  const { mic } = ready();
  const { as } = toAlsaSet(mic, PRESENT(N));                          // set in flight
  assert.equal(byType(mic.reset(5), "done")[0].rollback, "deferred");
});

test("picker: a stale alsa command from a reset operation cannot touch the next operation", () => {
  const { mic } = ready();
  const { as } = toAlsaSet(mic);
  mic.reset(10);
  mic.cmdExit(cmdId(as, "alsa-set"), 3, PRESENT("x"), 1000);           // drained: nothing written, deferred skips the block
  const go = mic.backend("idle", 1001, { fresh: true });
  mic.cmdExit(cmdId(go, "get"), 0, GET_OUT, 1002);                    // deferred rollback finishes (verified, no restart)
  assert.equal(mic.pending(), false);
  const { result } = mic.request("system", 1010, { device: "other_node" });
  const fx = mic.systemdJob(false, 1011);                             // a job reading newer than the request; backend still fresh
  assert.deepEqual(kinds(fx), ["get"]);
  assert.equal(mic.statusOf(result.operationId).state, "applying");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/MicApply.test.mjs`
Expected: the existing tests PASS, and every `picker:` test FAILS. For example, the first one fails because the kinds after `get` are `["set"]`, not `alsa-get`.

- [ ] **Step 3: Implement**

Apply these edits to `lib/MicApply.mjs`, in file order.

1) The header and imports. Add after the existing first comment line:

```js
// Mic source picker spec §5: system + node also snapshots and rewrites the managed omaremote-mic ALSA block
// (alsa-get, alsa-set; rollback step alsa-restore), and a rollback's progress survives a defer.
import { MIC_PCM, isNodeName, present, parseAlsaState, sameAlsa, alsaSetArgv } from "./AlsaMic.mjs";
```

and after `const MODES = …`:

```js
// Plan ruling 4: alsa-mic's documented "nothing written" exits. Any other exit (a deadline kill) may have landed.
const ALSA_NOT_WRITTEN = new Set([1, 2, 3, 64]);
```

2) The `createMicApply` signature and helpers:

```js
export function createMicApply({ voice, alsaArgv = ["omaremote-setup", "alsa-mic"] }) {
```

Replace `cmd` and `targetValue`:

```js
  // `alsaWrites` tags the block state an alsa-set leaves if it lands, so a drain after a defer can correct the snapshot.
  const cmd = (out, kind, argv, writes, alsaWrites) => { const id = ++cmdSeq; cmds.set(id, { kind, opId: op.id, writes, alsaWrites }); out.push({ type: "cmd", id, kind, argv }); return id; };
  const targetValue = (o) => (o.mode === "remote" ? o.nodeName : (o.device ? MIC_PCM : "default"));
  const carried = (o) => (o.rbAlsa === "conflict" || o.rbAlsa === "failed" ? o.rbAlsa : undefined);
```

3) `finish`: change its `record(...)` line to
`record(op.id, state, { mode: op.mode, device: op.device, error: op.error, rollback: op.rollback });`

4) `deferOp`: build the snapshot with the new fields:

```js
    deferred = { id: op.id, mode: op.mode, device: op.device, prev: op.prev, setValue: op.setValue, error: op.error, expected: op.expected,
                 serviceDirty: op.serviceDirty, deferUntil: until, alsaPrev: op.alsaPrev, alsaExpected: op.alsaExpected,
                 rbDevice: op.rbDevice, rbAlsa: op.rbAlsa };
```

and its `record(...)` to `record(op.id, "failed", { mode: op.mode, device: op.device, error: op.error, rollback: "deferred" });`.

5) After `beginRollback`, add the rollback continuation (spec §5.2):

```js
  // Spec §5.2 step 2, entered once audio.device is settled (restored, or never written).
  function afterDevice(out, now) {
    op.rbDevice = "done";
    if (op.rbAlsa === "pending") {
      if (op.alsaPrev && !sameAlsa(op.alsaExpected, op.alsaPrev)) {
        if (jobPending) { deferOp(out, now); return; }
        op.phase = "rollback-alsa";
        cmd(out, "alsa-restore", alsaSetArgv(alsaArgv, op.alsaPrev, op.alsaExpected));
        return;
      }
      op.rbAlsa = "done";
    }
    rollbackRestart(out, now);
  }
  // Spec §5.2 step 3. A carried conflict/failed outcome stands even when the restart verifies.
  function rollbackRestart(out, now) {
    if (!op.serviceDirty) { op.rollback = carried(op) || "verified"; finish(out, "failed"); return; }
    if (jobPending) { deferOp(out, now); return; }
    op.phase = "rollback-restart"; cmd(out, "restart", restartArgv);
  }
  // alsa-restore's exit, live or drained into a deferred snapshot. Exit 3 with the file already at alsaPrev is done
  // (plan ruling 4, mirroring rollback-get's "already holds the value to restore").
  function restoreExit(o, code, stdout, out) {
    const found = code === 3 ? parseAlsaState(stdout) : null;
    if (code === 0 || (found && sameAlsa(found, o.alsaPrev))) { o.alsaExpected = o.alsaPrev; o.rbAlsa = "done"; return; }
    if (code === 3) {
      o.rbAlsa = "conflict";
      out.push({ type: "conflict", target: "alsa", expected: o.alsaExpected, found });
      hud(out, "microphone config changed externally");
      return;
    }
    o.rbAlsa = "failed";
    out.push({ type: "unconfigured", reason: "microphone partly restored" });
  }
  function issueSet(out) {
    op.phase = "set"; op.mutated = true; op.setValue = String(targetValue(op));
    cmd(out, "set", ["voxtype", "config", "set", "audio.device", op.setValue], op.setValue);
  }
```

6) `tryDeferred`: the reconstructed `op` gains the fields, and the call that starts it changes:

```js
    op = { id: d.id, mode: d.mode, device: d.device, state: "rollingBack", phase: null, prev: d.prev, setValue: d.setValue, mutated: true, error: d.error,
           rollback: undefined, expected: d.expected, serviceDirty: d.serviceDirty, deferUntil: d.deferUntil, verifyId: undefined,
           alsaPrev: d.alsaPrev, alsaExpected: d.alsaExpected, rbDevice: d.rbDevice, rbAlsa: d.rbAlsa };
    if (op.rbDevice === "pending") beginRollback(out);
    else { hud(out, "restoring previous microphone"); afterDevice(out, now); }       // spec §5.2: continue, never re-run
```

`tryDeferred(out, now)` already receives `now`.

7) `request`: validate the device and initialise the new fields:

```js
      if (mode === "system" && opts.device !== undefined && opts.device !== "default" && !isNodeName(opts.device))
        return { effects: out, result: { ok: false, reason: "invalid-source" } };
      const device = mode === "system" && opts.device && opts.device !== "default" ? opts.device : null;
      op = { id: `mic-${++seq}`, mode, nodeName: opts.nodeName || null, device, state: "queued", phase: null, prev: null, setValue: null, mutated: false,
             error: undefined, rollback: undefined, expected: null, serviceDirty: false, deferUntil: undefined, verifyId: undefined, requestedAt: now,
             alsaPrev: null, alsaExpected: null, rbDevice: "pending", rbAlsa: "pending" };
```

The empty string `""` is refused by `isNodeName`, so it must be checked before `opts.device &&` short-circuits. The order above does that: `"" !== undefined && "" !== "default" && !isNodeName("")` is true.

8) `statusOf` (live branch): add `device: op.device`.

9) `cmdExit` drain branch (`if (!op) { … }`): replace its body with:

```js
      if (!op) {
        // A command from a reset/deferred-away operation drained. If it belongs to the operation now waiting to roll
        // back, fold what it did into the deferred snapshot (spec §5.1 "in flight", §5.2 "Deferred rollback").
        if (deferred && entry.opId === deferred.id) {
          if (entry.writes !== undefined && code === 0) deferred.expected = entry.writes;
          if (entry.alsaWrites && !ALSA_NOT_WRITTEN.has(code)) { deferred.alsaExpected = entry.alsaWrites; deferred.serviceDirty = true; }
          if (entry.kind === "alsa-restore") restoreExit(deferred, code, stdout, out);
        }
        tryDeferred(out, now);
        return out;
      }
```

A drained `alsa-set` with exit 0 is not in `ALSA_NOT_WRITTEN`, so it counts as written. Exits 1, 2, 3 and 64 leave the snapshot as it is.

10) `case "get"`: after `op.prev = parsed; op.expected = parsed.literal;`, insert the branch, and route the existing write through `issueSet`:

```js
          if (op.device) { op.phase = "alsa-get"; cmd(out, "alsa-get", alsaArgv.concat(["get"])); return out; }   // spec §5.1 snapshot 2
          if (jobPending) { setErrorOnce(op, "job-pending"); finish(out, "failed"); return out; }  // nothing mutated: just fail, no rollback
          issueSet(out);
          return out;
```

This replaces the old `op.phase = "set"; op.mutated = true; …; cmd(out, "set", …)` lines.

11) New cases, placed before `case "set":`:

```js
        case "alsa-get": {                                            // spec §5.1: the second snapshot; still nothing written
          const st = code === 0 ? parseAlsaState(stdout) : null;
          if (!st) { setErrorOnce(op, "preflight-failed"); finish(out, "failed"); return out; }
          op.alsaPrev = st; op.alsaExpected = st;
          if (jobPending) { setErrorOnce(op, "job-pending"); finish(out, "failed"); return out; }
          const want = present(op.device);
          if (sameAlsa(st, want)) { issueSet(out); return out; }       // already the picked node: mutated begins at set
          op.phase = "alsa-set"; op.mutated = true;                    // mutated when ISSUED (spec §5.1), like set
          cmd(out, "alsa-set", alsaSetArgv(alsaArgv, want, st), undefined, want);
          return out;
        }
        case "alsa-set":
          if (ALSA_NOT_WRITTEN.has(code)) {                            // nothing written: the "service never saw it" ending
            setErrorOnce(op, code === 3 ? "alsa-conflict" : "alsa-set-failed");
            op.rollback = "verified"; finish(out, "failed"); return out;
          }
          op.alsaExpected = present(op.device); op.serviceDirty = true;  // alsa-lib re-reads changed config on open
          if (code !== 0) { setErrorOnce(op, "alsa-set-failed"); beginRollback(out); return out; }   // ruling 4: maybe landed
          if (jobPending) { setErrorOnce(op, "job-pending"); deferOp(out, now); return out; }
          issueSet(out);
          return out;
```

12) `case "rollback-get"`: add `target: "device"` to its `conflict` push. Replace its "already holds the value" branch body with `afterDevice(out, now); return out;`:

```js
          if (op.expected === op.prev.literal) { afterDevice(out, now); return out; }   // the file already holds the value to restore
```

13) `case "rollback-set"`: keep the failure line. Replace the success lines (`op.expected = op.prev.literal; if (jobPending) …; op.phase = "rollback-restart"; …`) with:

```js
          op.expected = op.prev.literal;
          afterDevice(out, now); return out;
```

14) New case before `case "rollback-restart":`:

```js
        case "rollback-alsa":
          restoreExit(op, code, stdout, out);
          rollbackRestart(out, now); return out;
```

15) `verifyResult`:
- In the `phase === "verify"` success branch, build the commit as:
  `out.push(op.mode === "system" ? { type: "commit", mode: op.mode, device: op.device || "default" } : { type: "commit", mode: op.mode });`
- In the `rollback-verify` success branch:
  `if (ok) { op.rollback = carried(op) || "verified"; if (op.rollback === "verified") hud(out, ""); finish(out, "failed"); return out; }`

16) `advance`, the defer-expiry branch: change its `record(...)` to:

```js
        record(deferred.id, "failed", { mode: deferred.mode, device: deferred.device, error: deferred.error, rollback: "unresolved", partial: carried(deferred) });
```

- [ ] **Step 4: Run all unit tests**

Run: `node --test tests/*.test.mjs`
Expected: PASS. The only acceptable edit to an existing test is the one that asserts `byType(fx, "conflict")` with `deepEqual` (`rollback refuses to overwrite an external edit`). Its expected object gains `target: "device"`. Any other existing failure is a regression in the edits above.

- [ ] **Step 5: Commit**

```bash
git add lib/MicApply.mjs tests/MicApply.test.mjs
git commit -m "feat(mic-apply): snapshot-then-write ALSA phases, alsa-restore, rollback progress across defer"
```

---

### Task 7: Doctor rows for a picked source

**Files:**
- Modify: `lib/Doctor.mjs` (the `// voxtype device per mode` `else` branch, and the `last-capture` block)
- Test: `tests/Doctor.test.mjs`

**Interfaces:**
- Consumes: `config.voice.systemDevice` (Task 3); facts `alsa.mic`, `pipewire.defaultSource` (Task 5); `MIC_PCM` (Task 1).
- Produces: row `voxtype-device`, labelled "Voxtype records from the picked microphone" for `system` + node. Its fixes:
  - `omarchy-shell omaremote micSystem <node>`
  - "repair the omaremote mic block in ~/.config/alsa/asoundrc by hand"
  - "connect the microphone, or pick another one in the Voice tab"

- [ ] **Step 1: Write the failing tests**

Append to `tests/Doctor.test.mjs`:

```js
const picked = (device) => normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, mic: "system", systemDevice: device } }).config;
const pickFacts = () => Object.assign(good(), {
  voxtype: Object.assign(good().voxtype, { audioDevice: "omaremote-mic" }),
  pipewire: { sources: ["alsa_input.usb-C922", "G20S PRO"], defaultSource: "G20S PRO" },
  alsa: { pcms: ["default", "omaremote-mic"], mic: { state: "present", node: "alsa_input.usb-C922" } },
  lastCapture: { node: "alsa_input.usb-C922", at: 1000 },
});

test("picked source: all three conditions hold -> voxtype-device and last-capture pass", () => {
  const rows = evaluate(pickFacts(), picked("alsa_input.usb-C922"));
  assert.equal(row(rows, "voxtype-device").status, "pass");
  assert.equal(row(rows, "last-capture").status, "pass");
});

test("picked source: each condition failing alone names its own fix", () => {
  const cfg = picked("alsa_input.usb-C922");
  const dev = pickFacts(); dev.voxtype.audioDevice = "default";
  const r1 = row(evaluate(dev, cfg), "voxtype-device");
  assert.equal(r1.status, "fail"); assert.equal(r1.fix, "omarchy-shell omaremote micSystem alsa_input.usb-C922");
  const other = pickFacts(); other.alsa.mic = { state: "present", node: "elsewhere" };
  const r2 = row(evaluate(other, cfg), "voxtype-device");
  assert.equal(r2.status, "fail"); assert.equal(r2.fix, "omarchy-shell omaremote micSystem alsa_input.usb-C922"); assert.match(r2.detail, /elsewhere/);
  const none = pickFacts(); none.alsa.mic = { state: "absent" };
  assert.equal(row(evaluate(none, cfg), "voxtype-device").status, "fail");
  const bad = pickFacts(); bad.alsa.mic = { state: "bad" };
  const r3 = row(evaluate(bad, cfg), "voxtype-device");
  assert.equal(r3.status, "fail"); assert.match(r3.fix, /repair the omaremote mic block/);
  const gone = pickFacts(); gone.pipewire.sources = ["G20S PRO"];
  const r4 = row(evaluate(gone, cfg), "voxtype-device");
  assert.equal(r4.status, "fail"); assert.equal(r4.fix, "connect the microphone, or pick another one in the Voice tab");
});

test("picked source: unreadable facts are unknown, never a pass or a crash", () => {
  const cfg = picked("alsa_input.usb-C922");
  const noMic = pickFacts(); noMic.alsa.mic = null;
  assert.equal(row(evaluate(noMic, cfg), "voxtype-device").status, "unknown");
  const noSources = pickFacts(); noSources.pipewire = { sources: null, defaultSource: null };
  assert.equal(row(evaluate(noSources, cfg), "voxtype-device").status, "unknown");
});

test("last-capture expects the picked node, or the PipeWire default for system default", () => {
  const f = pickFacts(); f.lastCapture = { node: "G20S PRO", at: 1 };
  assert.equal(row(evaluate(f, picked("alsa_input.usb-C922")), "last-capture").status, "warn");
  f.voxtype.audioDevice = "default";
  assert.equal(row(evaluate(f, picked("default")), "last-capture").status, "pass", "the old literal-\"default\" compare always warned");
  f.pipewire.defaultSource = null;
  assert.equal(row(evaluate(f, picked("default")), "last-capture").status, "unknown");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/Doctor.test.mjs`
Expected: FAIL, because the picked-source rows report `"Voxtype audio.device resolves to a PipeWire source"` semantics (`fail` with fix `mic system`), and the default `last-capture` warns.

- [ ] **Step 3: Implement**

In `lib/Doctor.mjs`, add `import { MIC_PCM } from "./AlsaMic.mjs";`. Replace the `else { const sources = …; push("voxtype-device", "Voxtype audio.device resolves to a PipeWire source", …) }` branch with:

```js
  else {
    const sources = get(facts, "pipewire.sources");
    const sd = get(config, "voice.systemDevice") || "default";
    if (sd === "default") {
      const ok = dev === "default" || (Array.isArray(sources) && sources.includes(dev));
      push("voxtype-device", "Voxtype audio.device resolves to a PipeWire source", vox(Array.isArray(sources) || dev === "default" ? tri(ok) : "unknown"), ["system"], `audio.device: ${dev}`, "omarchy-shell omaremote mic system");
    } else {
      // Mic source picker spec §6: audio.device names the PCM, the block targets the picked node, the node is plugged in.
      const label = "Voxtype records from the picked microphone";
      const am = get(facts, "alsa.mic");
      const fixPick = `omarchy-shell omaremote micSystem ${sd}`;
      if (dev !== MIC_PCM) push("voxtype-device", label, vox("fail"), ["system"], `audio.device: ${dev}, expected ${MIC_PCM}`, fixPick);
      else if (!am) push("voxtype-device", label, vox("unknown"), ["system"], "the omaremote mic block could not be read", "");
      else if (am.state === "bad") push("voxtype-device", label, vox("fail"), ["system"], "the omaremote mic block is malformed", "repair the omaremote mic block in ~/.config/alsa/asoundrc by hand");
      else if (am.state !== "present" || am.node !== sd) push("voxtype-device", label, vox("fail"), ["system"], `ALSA block: ${am.state === "present" ? am.node : "absent"}, picked: ${sd}`, fixPick);
      else if (!Array.isArray(sources)) push("voxtype-device", label, vox("unknown"), ["system"], `picked: ${sd}; PipeWire source list unavailable`, "");
      else if (!sources.includes(sd)) push("voxtype-device", label, vox("fail"), ["system"], `${sd} is not connected`, "connect the microphone, or pick another one in the Voice tab");
      else push("voxtype-device", label, vox("pass"), ["system"], `audio.device: ${MIC_PCM} → ${sd}`, "");
    }
  }
```

Replace the `last-capture` block's `expected` computation and its final `push`:

```js
  const lc = get(facts, "lastCapture");
  const sdev = get(config, "voice.systemDevice") || "default";
  const expected = mode === "remote" ? node : sdev !== "default" ? sdev : get(facts, "pipewire.defaultSource");
  if (lc === undefined) push("last-capture", "Last session captured from expected node", vox("unknown"), BOTH, "", "");
  else if (lc === null) push("last-capture", "Last session captured from expected node", vox("unknown"), BOTH, "not yet verified", "");
  else if (!expected) push("last-capture", "Last session captured from expected node", vox("unknown"), BOTH, `captured from: ${lc.node}; expected node unknown`, "");
  else push("last-capture", "Last session captured from expected node", vox(lc.node === expected ? "pass" : "warn"), BOTH, `captured from: ${lc.node}`, "");
```

- [ ] **Step 4: Run all unit tests**

Run: `node --test tests/*.test.mjs`
Expected: PASS. If an existing system-mode `last-capture` assertion relied on the old always-warn compare, change it to the new expected node. That compare is the defect spec §6 fixes, and the commit message must say so.

- [ ] **Step 5: Commit**

```bash
git add lib/Doctor.mjs tests/Doctor.test.mjs
git commit -m "feat(doctor): picked-source voxtype-device conditions; last-capture compares the real expected node"
```

---

### Task 8: Presentation helpers for the picker

**Files:**
- Modify: `lib/Presentation.mjs`
- Test: `tests/Presentation.test.mjs`

**Interfaces:**
- Produces:
  - `micChoices(cfg, sources) → [{ key, label, mode, device?, connected, active }]`
  - `micRefusal(reason) → string`
  - `micConflictLine(conflict) → string`
  - `micStatusLine(status)`, extended with ` (partial: x)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/Presentation.test.mjs` (extend its import with `micChoices, micRefusal, micConflictLine`; `micStatusLine` is already exported):

```js
const cfgFor = (mic, systemDevice) => ({ voice: { mic, systemDevice } });
const SRC = [{ name: "alsa_input.usb-C922", description: "C922 Pro Stream Webcam Analog Stereo" }, { name: "builtin", description: "Built-in" }];

test("micChoices: Remote, System default, then each source; the active one is marked", () => {
  const c = micChoices(cfgFor("system", "builtin"), SRC);
  assert.deepEqual(c.map(x => [x.key, x.mode, x.device, x.connected, x.active]), [
    ["remote", "remote", undefined, true, false], ["default", "system", "default", true, false],
    ["alsa_input.usb-C922", "system", "alsa_input.usb-C922", true, false], ["builtin", "system", "builtin", true, true]]);
  assert.equal(c[2].label, "C922 Pro Stream Webcam Anal…", "truncated to 28 characters");
  assert.equal(micChoices(cfgFor("remote", "builtin"), SRC)[0].active, true);
  assert.equal(micChoices(cfgFor("system", "default"), SRC)[1].active, true);
});

test("micChoices: a stored source missing from the list stays visible, disconnected", () => {
  const c = micChoices(cfgFor("system", "gone_node"), SRC);
  const last = c[c.length - 1];
  assert.deepEqual([last.key, last.connected, last.active, last.label], ["gone_node", false, true, "gone_node (not connected)"]);
  assert.equal(micChoices(cfgFor("remote", "gone_node"), []).some(x => x.key === "gone_node"), true, "shown under remote too");
  assert.equal(micChoices(null, SRC).length, 4, "no config yet: no stored entry, nothing active");
});

test("micRefusal and micConflictLine wording", () => {
  assert.equal(micRefusal("no-such-source"), "microphone not found (unplugged?)");
  assert.equal(micRefusal("invalid-source"), "not a usable microphone");
  assert.equal(micRefusal("sources-unavailable"), "cannot list microphones (pw-dump failed)");
  assert.equal(micRefusal("busy"), "busy");
  assert.equal(micConflictLine({ target: "device", expected: "omaremote-mic", found: "other" }),
    "conflict: Voxtype audio.device is other (expected omaremote-mic) — reconcile in Setup");
  assert.equal(micConflictLine({ target: "alsa", expected: { state: "present", node: "a" }, found: { state: "absent" } }),
    "conflict: the omaremote mic ALSA block is absent (expected a) — reconcile in Setup");
  assert.equal(micConflictLine({ target: "alsa", expected: { state: "present", node: "a" }, found: null }),
    "conflict: the omaremote mic ALSA block is unreadable (expected a) — reconcile in Setup");
  assert.equal(micStatusLine({ state: "failed", error: "verify-failed", rollback: "unresolved", partial: "conflict" }),
    "failed: verify-failed (rollback: unresolved) (partial: conflict)");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/Presentation.test.mjs`
Expected: FAIL (not exported).

- [ ] **Step 3: Implement**

In `lib/Presentation.mjs`, extend `micStatusLine` by adding before `return line;`:
`  if (status.partial) line += ` (partial: ${status.partial})`;`

Then append:

```js
// Mic source picker spec §4.5: the Microphone row's buttons. Plan ruling 2: Enter on the active one does nothing.
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export function micChoices(cfg, sources) {
  const v = (cfg && cfg.voice) || {};
  const sd = v.systemDevice || "default";
  const list = Array.isArray(sources) ? sources : [];
  const out = [
    { key: "remote", label: "Remote", mode: "remote", connected: true, active: v.mic === "remote" },
    { key: "default", label: "System default", mode: "system", device: "default", connected: true, active: v.mic === "system" && sd === "default" },
  ];
  for (const s of list) out.push({ key: s.name, label: cut(s.description || s.name, 28), mode: "system", device: s.name, connected: true, active: v.mic === "system" && sd === s.name });
  if (cfg && sd !== "default" && !list.some(s => s.name === sd))
    out.push({ key: sd, label: cut(sd, 28) + " (not connected)", mode: "system", device: sd, connected: false, active: v.mic === "system" });
  return out;
}

const REFUSALS = { "no-such-source": "microphone not found (unplugged?)", "invalid-source": "not a usable microphone",
                   "sources-unavailable": "cannot list microphones (pw-dump failed)" };
export function micRefusal(reason) { return REFUSALS[reason] || String(reason); }

export function micConflictLine(c) {
  if (c && c.target === "alsa") {
    const show = (s) => (!s ? "unreadable" : s.state === "present" ? s.node : "absent");
    return `conflict: the omaremote mic ALSA block is ${show(c.found)} (expected ${show(c.expected)}) — reconcile in Setup`;
  }
  return `conflict: Voxtype audio.device is ${c.found} (expected ${c.expected}) — reconcile in Setup`;
}
```

The `micChoices` loop uses `sd === s.name`, so the stored-entry check has to stay outside it.

- [ ] **Step 4: Run all unit tests**

Run: `node --test tests/*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/Presentation.mjs tests/Presentation.test.mjs
git commit -m "feat(presentation): mic picker choices, refusal and conflict wording"
```

---

### Task 9: Service wiring and integration scenarios

**Files:**
- Modify: `Service.qml`, `tests/fake-remote.sh`
- Test: three new scenarios in `tests/fake-remote.sh`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - Service functions: `ipcMic(mode, device)`, `refreshMicSources()`.
  - Service properties: `micSourceList` (array), `micSourcesRefreshing` (bool).
  - IPC verbs: `micSystem(node)` and `micSources()`. `micSources()` returns `{ sources, refreshing }`.
  - Status fields: `systemDevice`, and `micSources: { list, refreshing }`.

- [ ] **Step 1: Write the failing scenarios**

In `tests/fake-remote.sh`:

1) After `export OMAREMOTE_TYPELESS_SETTINGS=…`, add:
`export OMAREMOTE_ALSA_RC=$OMAREMOTE_FAKE_DIR/asoundrc   # the mic picker's ALSA block: never ~/.config/alsa`

2) After `mic_wait() { … }`, add the helper and the scenarios:

```bash
mic_device() {   # mic_device <node> → the final answer to micSystem, retrying sourcesRefreshing as the panel does
  local r i
  for i in $(seq 1 20); do
    r=$(ipc micSystem "$1")
    [[ $(jq -r '.detail // empty' <<<"$r") == sourcesRefreshing ]] || { echo "$r"; [[ $(jq -r .ok <<<"$r") == true ]]; return; }
    sleep 0.3
  done
  echo "$r"; return 1
}
PICK=alsa_input.pci-0000_00_1f.3.analog-stereo   # an Audio/Source in tests/fixtures/pw-dump.json
s_mic_system_device() {   # picker spec §5.1: wiring and end state (the phase order is pinned by the MicApply unit tests)
  ready || return 1
  local r id; r=$(mic_device "$PICK") || { echo "    $r"; return 1; }
  id=$(jq -r .operationId <<<"$r")
  [[ $(mic_wait "$id") == succeeded ]] || { ipc micStatus "$id"; return 1; }
  has_line "$F/vox.log" "voxtype config get audio.device --json" || return 1
  has_line "$F/vox.log" "voxtype config set audio.device omaremote-mic" || return 1
  has_line "$F/sysd.log" "systemctl --user restart voxtype" || return 1
  grep -qxF "  capture_node \"$PICK\"" "$F/asoundrc" || { echo "    asoundrc:"; sed 's/^/      /' "$F/asoundrc" 2>/dev/null; return 1; }
  [[ $(jq -r .voice.mic "$XDG_CONFIG_HOME/omaremote/config.json") == system ]] || return 1
  [[ $(jq -r .voice.systemDevice "$XDG_CONFIG_HOME/omaremote/config.json") == "$PICK" ]] || return 1
  [[ $(jget '.systemDevice') == "$PICK" ]]
}
s_mic_system_unknown_source() {   # picker spec §4.4: a miss refreshes first, then refuses; nothing is queued
  ready || return 1
  local r; r=$(ipc micSystem alsa_input.nonexistent)
  [[ $(jq -r .reason <<<"$r") == busy && $(jq -r .detail <<<"$r") == sourcesRefreshing ]] || { echo "    first: $r"; return 1; }
  r=$(mic_device alsa_input.nonexistent) && { echo "    accepted: $r"; return 1; }
  [[ $(jq -r .reason <<<"$r") == no-such-source ]] || { echo "    final: $r"; return 1; }
  [[ $(jget '.mic.pending') == false ]] || return 1
  no_line "$F/vox.log" "voxtype config set audio.device omaremote-mic" || return 1
  [[ ! -e $F/asoundrc ]]
}
s_mic_system_late_plug() {   # picker spec §4.4: a source plugged in after a fresh refresh is still found
  ready || return 1
  ipc micSources > /dev/null; wait_for '.micSources.refreshing' false 3 || return 1
  jq '. + [{"id":45,"type":"PipeWire:Interface:Node","info":{"props":{"media.class":"Audio/Source","node.name":"alsa_input.usb-late","node.description":"Late Mic"}}}]' \
    "$F/pw-dump.json" > "$F/pw.tmp" && mv "$F/pw.tmp" "$F/pw-dump.json"
  local r; r=$(ipc micSystem alsa_input.usb-late)
  [[ $(jq -r .detail <<<"$r") == sourcesRefreshing ]] || { echo "    first: $r"; return 1; }
  r=$(mic_device alsa_input.usb-late) || { echo "    $r"; return 1; }
  [[ $(mic_wait "$(jq -r .operationId <<<"$r")") == succeeded ]]
}
```

3) Register them in the block of `scenario <name> <fn>` lines that follows the mic-apply scenarios (the file registers each scenario right below its group, e.g. `scenario ping s_ping` at line 82):

```bash
scenario mic_system_device s_mic_system_device
scenario mic_system_unknown_source s_mic_system_unknown_source
scenario mic_system_late_plug s_mic_system_late_plug
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bash tests/fake-remote.sh mic_system_device; bash tests/fake-remote.sh mic_system_unknown_source; bash tests/fake-remote.sh mic_system_late_plug`
Expected: all three `FAIL`. The verbs `micSystem` and `micSources` do not exist yet.

- [ ] **Step 3: Wire the Service**

In `Service.qml`:

1) Imports: add `import "lib/AlsaMic.mjs" as AlsaMic` and `import "lib/MicSources.mjs" as MicSources` beside the other `lib` imports.

2) State, near `property var lastCapture`:

```qml
  readonly property var micSources: MicSources.createMicSources()     // picker spec §4.3/§4.4
  property var micSourceList: []
  property bool micSourcesRefreshing: false
```

3) Line 271, the `mic = MicApply.createMicApply(...)` call. Pass the host script:

```qml
    mic = MicApply.createMicApply({ voice: EngineSwitch.micVoiceView(voice, typeless, function() { return root.engineName }),
                                    alsaArgv: ["bash", root.pluginDir + "/host/omaremote-setup", "alsa-mic"] })
```

4) `applyEffect` `case "cmd"`. Give the alsa kinds the 10 s deadline (plan ruling 5):

```qml
        runner.run(src, e.id, e.argv, e.kind === "restart" || String(e.kind).indexOf("alsa-") === 0 ? root.restartCmdMs : root.shortCmdMs)
```

5) `case "commit"`: `configStore.setVoiceMic(e.mode, e.device); root.refreshAudioDevice(); break`

6) The source probe, after the `captureProbe` Process. Each refresh gets its own Process object, tagged with the id `micSources.started()` returned. The object reports exactly once, after it has *both* its stdout and its exit code, or when its own 3 s deadline fires, and then destroys itself. A late event from an abandoned probe carries the old id, and `MicSources.finished` ignores it, so it can neither fail the newer refresh nor stop its deadline. That deadline belongs to the newer object.

```qml
  // Picker spec §4.3: one Process per refresh. A refresh succeeds only with exit 0 AND a JSON array
  // (Pipewire.sourcesFromProbe). A binary that fails to start emits no `exited`, so the deadline covers it.
  Component {
    id: sourcesProbeComponent
    Process {
      id: probe
      property int rid: 0
      property string out: ""
      property int exitCode: -1
      property bool gotOut: false
      property bool gotExit: false
      property bool reported: false
      command: ["pw-dump"]
      stdout: StdioCollector { waitForEnd: true; onStreamFinished: { probe.out = text; probe.gotOut = true; probe.report() } }
      onExited: function(code, status) { probe.exitCode = code; probe.gotExit = true; probe.report() }
      property Timer deadline: Timer { interval: 3000; running: true; repeat: false; onTriggered: probe.abandon() }
      function report() {
        if (reported || !gotOut || !gotExit) return
        reported = true; deadline.stop()
        root.sourcesDone(rid, Pipewire.sourcesFromProbe(exitCode, out, { exclude: root.remoteNode ? [root.remoteNode] : [] }))
        destroy()
      }
      function abandon() {
        if (reported) return
        reported = true; running = false
        root.sourcesDone(rid, null)
        destroy()
      }
    }
  }
  function startSourcesRefresh() {
    var rid = root.micSources.started()
    root.micSourcesRefreshing = true
    var p = sourcesProbeComponent.createObject(root, { rid: rid })
    if (!p) { root.sourcesDone(rid, null); return }
    p.running = true
  }
  function sourcesDone(rid, list) {
    var again = root.micSources.finished(rid, list)          // false and no change for a stale rid
    root.micSourceList = root.micSources.list(); root.micSourcesRefreshing = root.micSources.refreshing()
    if (again) root.startSourcesRefresh()
  }
  function refreshMicSources() { if (root.micSources.requestRefresh()) root.startSourcesRefresh() }
  // Picker spec §4.4: the request-time refusals; null means "go ahead". A `refresh: true` answer obliges us to start now.
  function checkSource(device) {
    if (!AlsaMic.isNodeName(device) || /\.monitor$/.test(device) || device === root.remoteNode) return { ok: false, reason: "invalid-source" }
    var r = root.micSources.check(device)
    if (r.refresh) root.startSourcesRefresh()
    if (r.verdict === "ok") return null
    if (r.verdict === "refreshing") return { ok: false, reason: "busy", detail: "sourcesRefreshing", retryAfterMs: 300 }
    return { ok: false, reason: r.verdict }
  }
```

7) `ipcMic`. Change the signature to `function ipcMic(mode, device) {`. After the existing `busy` refusal line, insert:

```qml
    if (mode === "system" && device !== undefined && device !== "" && device !== "default") {
      var refused = root.checkSource(device)
      if (refused) return JSON.stringify(refused)
    }
```

In its `mic.request(...)` call, pass `{ nodeName: root.remoteNode, device: device }`. An empty-string `device` from a caller means "default", so normalise it before the call: `if (device === "") device = undefined`.

8) The fallback HUD (spec §5.3). In `captureProbe`'s `onStreamFinished`, after `root.lastCapture = …`, inside the same `try`:

```qml
        if (r.streamFound && root.config.voice.mic === "system") {
          var dump = JSON.parse(text)
          var want = root.config.voice.systemDevice !== "default" ? root.config.voice.systemDevice : Pipewire.defaultSource(dump)
          var mm = Pipewire.captureMismatch(dump, want)
          if (mm) root.hudText = "recording from " + mm.nodeDescription + ", not " + mm.expectedDescription
        }
```

To avoid parsing twice, hoist `var dump = JSON.parse(text)` to the top of the `try` and pass `dump` to `captureSourceOf` too.

9) Status, in `statusJson`, after `voiceMode: …`:

```qml
      systemDevice: root.config ? root.config.voice.systemDevice : null,
      micSources: { list: root.micSourceList, refreshing: root.micSourcesRefreshing },
```

10) IPC handler, after `function mic(mode: string)…`:

```qml
    function micSystem(node: string): string { return root.ipcMic("system", node) }            // plan ruling 1
    function micSources(): string { root.refreshMicSources(); return JSON.stringify({ sources: root.micSourceList, refreshing: root.micSourcesRefreshing }) }
```

The existing `function mic(mode: string)` calls `root.ipcMic(mode)` with `device` undefined, so `mic system` stays `default`.

- [ ] **Step 4: Run lint and the scenarios**

Run: `make lint && for s in mic_system_device mic_system_unknown_source mic_system_late_plug mic_apply_system mic_apply_restart_fails_rolls_back; do bash tests/fake-remote.sh $s; done`
Expected: lint prints `module-load: ok`, and all five print `ok`.

- [ ] **Step 5: Run the whole suite**

Run the `make check` wrapper from Global Constraints.
Expected: `MAKE_CHECK_EXIT=0`. `s_mic_apply_second_request_is_busy` and `s_dbus_session` are known pre-existing flakes (project notes). If one fails, rerun it alone three times with `bash tests/fake-remote.sh <name>`. Then prove it pre-existing by checking that this task's diff does not touch its code path. Do not reason about which test "should" be affected.

- [ ] **Step 6: Commit**

```bash
git add Service.qml tests/fake-remote.sh
git commit -m "feat(service): mic picker wiring — micSystem/micSources IPC, source cache, alsa deadlines, fallback HUD"
```

---

### Task 10: Voice tab picker row and keyboard

**Files:**
- Modify: `components/VoiceTab.qml` (the `Microphone` section, `activate`, `requestMic`, `onShown`), `Panel.qml:53`
- Test: `make lint` (module load) plus the manual check in Step 4; `micChoices` itself is unit-tested in Task 8.

**Interfaces:**
- Consumes: `Presentation.micChoices`, `micRefusal`, `micConflictLine`; `service.ipcMic(mode, device)`, `service.refreshMicSources()`, `service.micSourceList`.
- Produces: `voiceTab.moveChoice(dx)`, `voiceTab.onHidden()` (called by `Panel.close()`), `voiceTab.cancelPending()`.

- [ ] **Step 1: Implement the row**

In `components/VoiceTab.qml`:

1) Properties, after `readonly property var current: …`:

```qml
  readonly property var choices: Presentation.micChoices(cfg, s ? s.micSourceList : [])
  property int pick: -1                                   // highlighted choice while the cursor is on the Microphone row
  // Picker spec §4.5 retry ownership: every user choice takes a new intent number. A retry carries the intent that
  // started it and dies when that is no longer current, so a superseded choice can never apply or touch the status line.
  property int _intent: 0
  property var _retry: null                               // { mode, device, label, intent, tries } while sourcesRefreshing is retried
  function activeIndex() { for (var i = 0; i < choices.length; i++) if (choices[i].active) return i; return 0 }
  function moveChoice(dx) { var p = pick < 0 ? activeIndex() : pick; pick = Math.max(0, Math.min(choices.length - 1, p + dx)) }
```

2) `onShown`:
`function onShown() { cursor = -1; pick = -1; root.cancelPending(); if (s) s.refreshMicSources() }`

and add beside it:

```qml
  function cancelPending() { root._intent++; root._retry = null; retryTimer.stop() }
  function onHidden() { root.cancelPending() }             // Panel.close(): a closed panel retries nothing
```

3) In `activate`, replace the `cursor === 1` line with:
`    else if (cursor === 1) { var c = choices[pick < 0 ? activeIndex() : pick]; if (c && c.connected && !c.active) root.requestChoice(c) }`

4) Replace `requestMic` with:

```qml
  function requestChoice(c) {                              // a new user intent supersedes any pending retry
    root.cancelPending()
    root.requestMic(c.mode, c.mode === "system" ? c.device : undefined, c.label, root._intent, 1)
  }
  function requestMic(mode, device, label, intent, tries) { // §3: returns immediately; the Service polls micStatus internally
    if (intent !== root._intent) return                    // superseded by a newer choice, or the panel closed
    root._retry = null
    if (!s || s.micPending) return                         // another apply holds the mic; this intent ends here
    var r = JSON.parse(device === undefined ? s.ipcMic(mode) : s.ipcMic(mode, device))
    if (!r.ok && r.reason === "busy" && r.detail === "sourcesRefreshing" && tries < 20) {   // picker spec §4.5: retried, never shown
      root._retry = { mode: mode, device: device, label: label, intent: intent, tries: tries + 1 }
      retryTimer.restart()
      return
    }
    root.requestedMode = r.ok ? (label || mode) : ""
    root.lastError = r.ok ? "" : Presentation.micRefusal(r.reason)
  }
  Timer {
    id: retryTimer; interval: 300; repeat: false
    onTriggered: { var t = root._retry; if (t) root.requestMic(t.mode, t.device, t.label, t.intent, t.tries) }
  }
```

5) Replace the Microphone `Row` (the `Text "Voxtype mic: …"` and the two `Button`s) with:

```qml
    Flow {
      width: parent.width
      spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Voxtype mic:"; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body }
      Repeater {
        model: root.choices
        delegate: Button {
          required property var modelData
          required property int index
          text: modelData.label
          selected: modelData.active
          hasCursor: root.cursor === 1 && (root.pick < 0 ? modelData.active : root.pick === index)
          foreground: root.fg
          enabled: root.s && !root.s.micPending && modelData.connected
          onClicked: if (!modelData.active) root.requestChoice(modelData)
        }
      }
    }
```

6) In the status `Text` below, change the conflict line to
`        if (root.s.micConflict) return Presentation.micConflictLine(root.s.micConflict)`.
`request refused: ` + `root.lastError` stays, since `lastError` now already holds the wording.

7) Update the header comment on line 2: `Voxtype mic Remote/System switch` → `Voxtype mic picker (Remote, System default, each capture source; picker spec §4.5)`.

In `Panel.qml` line 28, make `close()` also cancel the Voice tab's pending retry. Append `voiceTab.onHidden()` after `statusTab.onHidden()`:

```qml
  function close() { setCenterHoverRevealSuppressed(false); root.controller.hide(); statusTab.onHidden(); voiceTab.onHidden() }   // finding #4; picker spec §4.5
```

In `Panel.qml` line 53, extend the `onMoveRequested` chain with the Voice-tab case before the tab switch:

```qml
        if (dx !== 0 && root.tabIndex === 1 && keysTab.cursor >= 0 && keysTab.cursor < 13) keysTab.moveColumn(dx)
        else if (dx !== 0 && root.tabIndex === 2 && voiceTab.cursor === 1) voiceTab.moveChoice(dx)   // plan ruling 2
        else if (dx !== 0) root.switchTab(dx)
```

- [ ] **Step 2: Lint**

Run: `make lint`
Expected: `module-load: ok`, and no new qmllint errors beyond the documented `qs.Ui` warnings.

- [ ] **Step 3: Full suite**

Run the `make check` wrapper.
Expected: `MAKE_CHECK_EXIT=0`.

- [ ] **Step 4: Look at it**

Run `make dev-restart` and open the panel's Voice tab (this touches the live shell, not the mic config). Confirm:
- The row shows Remote, System default, C922 and the built-in input.
- With the cursor on the row, Left/Right moves the highlight and does not switch tabs.
- Nothing is applied until Enter or a click.
- The panel has no QML test harness, so the retry-ownership rule (spec §4.5) is a review item. The task reviewer checks three things:
  - `requestMic` returns at once when `intent !== root._intent`;
  - `requestChoice` and `onHidden` both call `cancelPending()`;
  - `Panel.close()` calls `voiceTab.onHidden()`.

Take a screenshot for the user. Do not pick anything here, because that is Task 11's hardware acceptance.

- [ ] **Step 5: Commit**

```bash
git add components/VoiceTab.qml Panel.qml
git commit -m "feat(panel): microphone picker row with Left/Right selection"
```

---

### Task 11: Docs and hardware acceptance (user present)

**Files:**
- Modify: `README.md`, `README.zh-TW.md` (the mic-mode feature bullets, the Voice tab line, and the command table)

- [ ] **Step 1: Document**

In both READMEs:
- Under the two mic modes, add one bullet:
  - English: "In `system` mode, pick the microphone in the Voice tab, or run `omarchy-shell omaremote micSystem <node>`; `omarchy-shell omaremote micSources` lists the node names. Only Voxtype is affected; Typeless keeps its own microphone setting."
  - Traditional Chinese: 「`system` 模式下可在 Voice 分頁挑選麥克風，或執行 `omarchy-shell omaremote micSystem <節點>`；`omarchy-shell omaremote micSources` 會列出節點名稱。只影響 Voxtype，Typeless 的麥克風仍在它自己的設定裡選。」
- In the Voice tab description, change "microphone mode" / 「麥克風模式」 to "microphone mode and source" / 「麥克風模式與來源」.

Commit:

```bash
git add README.md README.zh-TW.md
git commit -m "docs: the microphone source picker"
```

- [ ] **Step 2: Hardware acceptance with the user (spec §7)**

Run `make dev-restart` and have the user do each item. Record pass or fail per item in the plan's outcome section.

These items write the real `~/.config/alsa/asoundrc` and restart Voxtype. That is why they need the user present. Back the file up first: `cp ~/.config/alsa/asoundrc <scratchpad>/asoundrc.pre-picker`.

1. Pick the C922 in the panel and dictate with F9. Doctor `last-capture` passes.
2. Pick the built-in input and dictate. `pw-dump` / Doctor shows the capture from the built-in input.
3. Pick System default, then Remote, then the C922 again. Each apply succeeds.
4. Unplug the C922. The panel marks it " (not connected)", and Doctor `voxtype-device` fails with "connect the microphone, or pick another one in the Voice tab".
5. Switch once with the keyboard only: cursor to the Microphone row, Left/Right, Enter.

Leave the user's final choice in place.

- [ ] **Step 3: Record the outcome**

Append a `## Outcome (date)` section to this plan with the per-item results and anything measured, then commit it.

---

## Self-review notes (done while writing)

- **Spec coverage.**
  - §3 → Task 3. §4.1/§4.2 → Tasks 4–5. §4.3 → Tasks 1, 9. §4.4 → Tasks 2, 9 (with ruling 1). §4.5 → Tasks 8, 10 (with ruling 2).
  - §5.1/§5.2 → Task 6. §5.3 → Tasks 1, 9. §6 → Tasks 5, 7. §7 unit/setup/integration → Tasks 1–9. §7 hardware → Task 11.
  - §7's "phase order in integration" is moved to unit tests by ruling 6.
- **Type consistency.**
  - Block states are `{state, node?}` everywhere in JS and `absent` / `present <node>` strings in bash. They are converted only at the `alsa-mic` JSON boundary.
  - `alsaArgv` is a prefix array in both Task 6 and Task 9.
  - The `commit` effect's `device` is read by `ConfigStore.setVoiceMic(mode, device)` (Task 3).
- **Plan review round 1 (2026-10-14) fixes.**
  - Per-refresh Process objects with ids (Task 9) and `sourcesFromProbe` (Task 1).
  - The start-requested contract in `MicSources` (Task 2).
  - A byte-exact `alsa_rc_put` replace and remove (Task 4; checked against a scratch copy before writing it here).
  - Intent-numbered panel retries (Task 10).
  - The node pattern that forbids only a leading `-`.
- **Known judgment calls for reviewers.**
  - Rulings 1–7 above.
  - `restoreExit` folds plan ruling 4's "exit 3 at alsaPrev is done" into the drained path too.

## Outcome (2026-10-15)

Hardware acceptance on the Mac mini, with the user at the machine. Engine: Typeless, so the Doctor Voxtype rows report
`info` in place of pass/fail. `~/.config/alsa/asoundrc` was backed up first.

1. **C922, F9 dictation: pass.** asoundrc `omaremote-mic` → C922, Voxtype `device = "omaremote-mic"`, text typed.
   Doctor `voxtype-device` showed `omaremote-mic → …C922…`, and `last-capture` showed `captured from: …C922…`. The
   "recording from …" HUD line cleared on release. F9 is push-to-talk (press and release binds); a tap records 0.0 s
   and Voxtype logs "No audio was captured".
2. **Built-in input: pass.** `last-capture` showed `alsa_input.pci-0000_00_1b.0.analog-stereo`; 2.9 s were captured.
   The transcript was empty, because nothing is plugged into the line-in.
3. **System default → Remote → C922: pass.** mic-5..7 all succeeded, and Doctor had no failures. Each Voxtype restart
   logs a DEBUG `voice error voxtype not responding`; nothing is shown on screen.
4. **Unplug the C922: pass.** The button read `alsa_input.usb-046d_C922_Pr… (not connected)` and was disabled. Doctor
   `voxtype-device` showed "… is not connected" with the fix "connect the microphone, or pick another one in the Voice
   tab". The label is the node name, because no description is stored. That is cosmetic and left as is.
5. **Keyboard-only switch: pass after a fix.**
   - Defect: on the Microphone row the cursor frame on the active choice looks the same as its selected fill, so the
     row showed no change when the cursor reached it.
   - The user pressed Down again, and Left/Right then switched tabs from the HUD row. A debug log confirmed that the
     routing was correct.
   - 6f44399 shades the whole row while the cursor is on it. After that, Down Down Left Enter switched to Built-in,
     then back to C922.
6. **Final choice: C922** (`voice.mic = system`, `systemDevice` = the C922 node).
