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
