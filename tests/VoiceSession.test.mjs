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
