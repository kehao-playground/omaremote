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

test("status reports an expired lease as inactive without ending it", () => {
  const { g, st } = mk();
  const { id } = st.arm(0, okCtx);
  assert.deepEqual(st.status(id, 29999), { active: true, remainingMs: 1, failed: undefined });
  assert.deepEqual(st.status(id, 30000), { active: false, remainingMs: 0, failed: undefined });
  assert.equal(g.busy(), true);
  assert.deepEqual(st.advance(30000), [{ type: "selftestExpired", id }]);
  assert.equal(g.busy(), false);
});
