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
