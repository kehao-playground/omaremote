import { test } from "node:test";
import assert from "node:assert/strict";
import { createSelfTest } from "../lib/SelfTest.mjs";

function gate() {
  const held = new Set();
  return { acquire: (n) => (held.size ? false : (held.add(n), true)), release: (n) => held.delete(n), busy: () => held.size > 0, held };
}
const okCtx = { voiceIdle: true, backendIdleFresh: true, heldKeys: [], pendingCmds: 0 };
const mk = (leaseMs) => { const g = gate(); return { g, st: createSelfTest({ supportedKeys: ["up", "ok"], gate: g, leaseMs }) }; };

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
  assert.equal(st.nextDeadline(), 120000);
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
  const { g, st } = mk(30000);
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
  const { g, st } = mk(30000);
  const { id } = st.arm(0, okCtx);
  assert.deepEqual(st.status(id, 29999), { active: true, remainingMs: 1, failed: undefined });
  assert.deepEqual(st.status(id, 30000), { active: false, remainingMs: 0, failed: undefined });
  assert.equal(g.busy(), true);
  assert.deepEqual(st.advance(30000), [{ type: "selftestExpired", id }]);
  assert.equal(g.busy(), false);
});

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
  const lo = createSelfTest({ supportedKeys: ["up"], gate: gate(), leaseMs: 500 });
  lo.arm(0, okCtx);
  assert.equal(lo.nextDeadline(), 1000);                  // in range (0, LEASE_MIN): clamped up
  // 0, "" and NaN are treated as "no value given", not as "clamp to the minimum": a 1 s lease would
  // report success and then expire before the first injection, which Review Focus 2 warns against.
  for (const bad of [0, "", NaN, "abc", -5]) {
    const b = createSelfTest({ supportedKeys: ["up"], gate: gate(), leaseMs: bad });
    b.arm(0, okCtx);
    assert.equal(b.nextDeadline(), 120000, `leaseMs ${JSON.stringify(bad)} should fall back to the default`);
  }
});

test("the lease length is a per-arm argument and is clamped per call", () => {
  const { st } = mk();
  st.arm(0, okCtx, 5000);
  assert.equal(st.nextDeadline(), 5000);
  st.disarm("st-1", 10);
  st.arm(100, okCtx, 99999999);
  assert.equal(st.nextDeadline(), 100 + 600000);
  st.disarm("st-2", 110);
  st.arm(200, okCtx, "garbage");
  assert.equal(st.nextDeadline(), 200 + 120000);          // falls back to the default, never throws
});

test("per-call clamp boundaries: 0, 999, 1000, 600000, 600001", () => {
  const { st } = mk();
  const want = [[0, 120000], [999, 1000], [1000, 1000], [600000, 600000], [600001, 600000]];
  want.forEach(([req, exp], i) => {
    const r = st.arm(0, okCtx, req);
    assert.equal(r.ok, true);
    assert.equal(st.nextDeadline(), exp, `requested ${req}`);
    st.disarm(r.id, 1);
  });
});

test("a second arm never replaces a live lease \u2014 it reports leaseActive", () => {
  const { g, st } = mk();
  const first = st.arm(0, okCtx, 120000);
  assert.equal(first.ok, true);
  const second = st.arm(10, okCtx, 60000);
  assert.equal(second.ok, false);
  assert.equal(second.detail, "leaseActive");
  assert.equal(st.nextDeadline(), 120000);                // the first lease is untouched
  assert.equal(g.held.size, 1);                           // and the shared gate was not acquired twice
  const r = st.report(first.id, 20);
  assert.ok(r.missing.length > 0);                        // still the first lease's state
  assert.equal(g.busy(), false);                          // released exactly once
});
