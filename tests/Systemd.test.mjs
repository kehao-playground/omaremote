import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShow, backoffMs, createRestartVerifier } from "../lib/Systemd.mjs";
import { byType, last } from "./helpers.mjs";

test("parseShow reads Key=Value lines regardless of order; empty Job means no pending job", () => {
  // Captured live: `systemctl --user show voxtype --property=Job,ActiveState,InvocationID` (no --value) prints
  // its own order (ActiveState, Job, InvocationID), not the requested order.
  assert.deepEqual(parseShow("ActiveState=active\nJob=\nInvocationID=9ca6e27825dd4684bd9ad1133d62c912\n"),
    { job: "", activeState: "active", invocationId: "9ca6e27825dd4684bd9ad1133d62c912", jobPending: false });
  // A pending job is systemd's "<id> <type>" format, e.g. "55 start".
  assert.deepEqual(parseShow("ActiveState=activating\nJob=55 start\nInvocationID=abc\n"),
    { job: "55 start", activeState: "activating", invocationId: "abc", jobPending: true });
  // Order-independence: same fields, shuffled.
  assert.deepEqual(parseShow("InvocationID=abc\nJob=55 start\nActiveState=activating\n"),
    { job: "55 start", activeState: "activating", invocationId: "abc", jobPending: true });
  assert.deepEqual(parseShow(""), { job: "", activeState: "", invocationId: "", jobPending: false });
  assert.equal(parseShow(null).jobPending, false);
});

test("backoffMs doubles from 1 s and caps at 30 s", () => {
  assert.deepEqual([0, 1, 2, 4, 5, 9].map(backoffMs), [1000, 2000, 4000, 16000, 30000, 30000]);
});

test("verifier succeeds only after a new invocation, active state and a fresh idle", () => {
  const v = createRestartVerifier();
  const fx = v.begin("mic-1", "old", 0);
  assert.deepEqual(fx.map(e => e.type), ["show", "poll"]);
  assert.equal(v.active(), true);
  assert.deepEqual(v.show({ job: "", activeState: "active", invocationId: "new" }, 100), []);
  const done = v.status("idle", true, 150);
  assert.deepEqual(last(done, "verified"), { type: "verified", id: "mic-1", ok: true, reason: undefined });
  assert.equal(v.active(), false);
});

test("an idle observed before the invocation changed is discarded", () => {
  const v = createRestartVerifier();
  v.begin("r", "old", 0);
  assert.deepEqual(v.status("idle", true, 50), []);                                   // old daemon's idle
  assert.deepEqual(v.show({ job: "", activeState: "active", invocationId: "old" }, 60), []);
  assert.deepEqual(v.show({ job: "", activeState: "active", invocationId: "new" }, 1100), []);   // still needs a newer idle
  assert.equal(last(v.status("idle", true, 1200), "verified").ok, true);
});

test("non-fresh status and transient stopped do not verify; a later fresh idle does", () => {
  const v = createRestartVerifier();
  v.begin("r", "old", 0);
  v.show({ job: "", activeState: "active", invocationId: "new" }, 100);
  assert.deepEqual(v.status("idle", false, 110), []);
  assert.deepEqual(v.status("stopped", true, 120), []);
  assert.equal(last(v.status("idle", true, 130), "verified").ok, true);
});

test("verifier times out at the deadline and reports failure once", () => {
  const v = createRestartVerifier({ deadlineMs: 10000 });
  v.begin("r", "old", 0);
  assert.deepEqual(byType(v.advance(9999), "verified"), []);
  const fx = v.advance(10000);
  assert.deepEqual(last(fx, "verified"), { type: "verified", id: "r", ok: false, reason: "timeout" });
  assert.equal(v.active(), false);
  assert.deepEqual(v.advance(20000), []);
  assert.equal(v.nextDeadline(), null);
});

test("verifier re-polls show+status every second while pending", () => {
  const v = createRestartVerifier();
  v.begin("r", "old", 0);
  assert.equal(v.nextDeadline(), 1000);
  assert.deepEqual(v.advance(500), []);
  assert.deepEqual(v.advance(1000).map(e => e.type), ["show", "poll"]);
  assert.equal(v.nextDeadline(), 2000);
});
