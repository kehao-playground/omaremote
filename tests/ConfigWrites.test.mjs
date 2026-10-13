import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfigWrites, hotkeyWritePlan, MAX_PENDING, KEEP } from "../lib/ConfigWrites.mjs";

const T = (hotkey) => JSON.stringify({ voice: { typeless: { hotkey } } }) + "\n";
const hk = (text) => JSON.parse(text).voice.typeless.hotkey;
const sets = (fx) => fx.filter(e => e.type === "setText");
const reloads = (fx) => fx.filter(e => e.type === "reload").length;
// FileView reports a write's outcome on that write's own object, so a report always names its seq.
const ok = (w) => w.saved(w.inFlightSeq());

test("writes go out one at a time in FIFO order, and each report resolves exactly its own seq", () => {
  const w = createConfigWrites();
  const a = w.request("A"), b = w.request("B"), c = w.request("C");
  assert.deepEqual(sets(a.effects), [{ type: "setText", seq: a.seq, text: "A" }]);
  assert.deepEqual(b.effects, [], "B waits behind A");
  assert.deepEqual(c.effects, []);
  assert.equal(w.inFlightSeq(), a.seq);
  assert.deepEqual(sets(w.saved(a.seq)), [{ type: "setText", seq: b.seq, text: "B" }]);
  assert.deepEqual(w.saves(), { [a.seq]: "saved", [b.seq]: "pending", [c.seq]: "pending" });
  assert.deepEqual(sets(w.saved(b.seq)), [{ type: "setText", seq: c.seq, text: "C" }]);
  assert.deepEqual(w.saved(c.seq), []);
  assert.equal(w.busy(), false);
  assert.equal(w.inFlightSeq(), 0);
  assert.deepEqual(w.saves(), { [a.seq]: "saved", [b.seq]: "saved", [c.seq]: "saved" });
});

test("a report for a seq that is not in flight resolves nothing", () => {
  const w = createConfigWrites();
  const a = w.request("A"), b = w.request("B");
  assert.deepEqual(w.saved(b.seq), [], "B is queued, not in flight");
  assert.deepEqual(w.saved(99), [], "never issued");
  assert.equal(w.saves()[a.seq], "pending");
  assert.equal(w.saves()[b.seq], "pending");
  assert.equal(w.inFlightSeq(), a.seq);
});

test("A times out (watchdog) → B starts → A's late saved is ignored and B resolves only on its own report", () => {
  const w = createConfigWrites();
  const a = w.request("A"), b = w.request("B");
  const fx = w.failed(a.seq, "no save confirmation");      // the watchdog's verdict
  assert.deepEqual(sets(fx), [{ type: "setText", seq: b.seq, text: "B" }]);
  assert.deepEqual(w.saved(a.seq), [], "A's late saved names A, which is no longer in flight");
  assert.equal(w.saves()[a.seq], "failed");
  assert.equal(w.saves()[b.seq], "pending", "B is not marked saved by A's signal");
  assert.equal(reloads(w.saved(b.seq)), 1, "B saved; A's failure still forces the reconcile");
  assert.equal(w.saves()[b.seq], "saved");
});

test("writes are never merged: B saved means B's own text reached disk, even though C later replaced it", () => {
  const w = createConfigWrites();
  let disk = "";
  const apply = (fx) => { for (const e of sets(fx)) disk = e.text; };
  const a = w.request(T("RightAlt")); apply(a.effects);
  const b = w.request(T("RightAlt+RightShift"));        // B carries X
  const c = w.request(T("RightCtrl+Space"));            // C carries Y
  apply(w.saved(a.seq));                                // A done, B written
  assert.equal(hk(disk), "RightAlt+RightShift", "B's own text was what reached disk");
  apply(w.saved(b.seq));                                // B done, C written
  assert.equal(w.saves()[b.seq], "saved");
  w.saved(c.seq);
  assert.notEqual(hk(disk), "RightAlt+RightShift", "setup's disk re-read sees Y and reports 'changed again'");
});

test("a failure marks exactly its own seq and the next write still goes out", () => {
  const w = createConfigWrites();
  const a = w.request("A"), b = w.request("B");
  const fx = w.failed(a.seq, "EACCES");
  assert.deepEqual(sets(fx), [{ type: "setText", seq: b.seq, text: "B" }]);
  assert.equal(w.saves()[a.seq], "failed");
  assert.equal(w.saves()[b.seq], "pending");
  assert.deepEqual(w.errors(), { [a.seq]: "EACCES" });
});

test("at most 8 writes may be pending, the in-flight one included; a ninth fails without consuming a seq", () => {
  const w = createConfigWrites();
  const seqs = [];
  for (let i = 0; i < MAX_PENDING; i++) { const r = w.request("t" + i); assert.equal(r.ok, true); seqs.push(r.seq); }
  const ninth = w.request("t8");
  assert.deepEqual(ninth, { ok: false, reason: "too many pending config writes", effects: [] });
  ok(w);
  assert.equal(w.request("t9").seq, seqs[seqs.length - 1] + 1);
});

test("a late watcher notification after our own writes re-reads, finds memory, and adopts nothing", () => {
  const w = createConfigWrites();
  const a = w.request("A");
  assert.deepEqual(w.notify(), [], "while busy a notification only marks dirty");
  assert.equal(reloads(w.saved(a.seq)), 1, "the reconcile runs once the queue drains");
  assert.equal(w.diskRead("A", "A"), false);
  assert.equal(reloads(w.notify()), 1, "a notification while idle re-reads at once");
  assert.equal(w.diskRead("A", "A"), false, "the disk holds our latest text: no external change");
});

test("save X, save Y, then an external edit back to X: the re-read adopts X (no text-history rule)", () => {
  const w = createConfigWrites();
  const X = T("RightCtrl+Space"), Y = T("RightAlt+RightShift");
  w.request(X); ok(w);
  w.request(Y); ok(w);
  assert.equal(reloads(w.notify()), 1);
  assert.equal(w.diskRead(X, Y), true, "X differs from memory (Y): adopt it");
});

test("notifications during a write only mark dirty; exactly one reconcile follows the last write", () => {
  const w = createConfigWrites();
  w.request("A"); w.request("B");
  assert.deepEqual(w.notify(), []);
  assert.deepEqual(w.notify(), []);
  const mid = ok(w);
  assert.equal(reloads(mid), 0, "B is still to go: no re-read yet");
  assert.equal(sets(mid).length, 1);
  assert.equal(reloads(ok(w)), 1);
  assert.equal(reloads(w.saved(1)), 0, "a stray report with nothing in flight does nothing");
});

test("a disk read that lands while a write is pending is not adopted, and forces a reconcile after the drain", () => {
  const w = createConfigWrites();
  w.request("A");
  assert.equal(w.diskRead("OLD", "A"), false);
  assert.equal(reloads(ok(w)), 1);
});

test("a failed last write triggers a reconcile, which adopts the disk text", () => {
  const w = createConfigWrites();
  const a = w.request("A");
  assert.equal(reloads(w.failed(a.seq, "ENOSPC")), 1);
  assert.equal(w.diskRead("OLD", "A"), true);
});

test("saves() keeps the last 16 outcomes", () => {
  const w = createConfigWrites();
  for (let i = 0; i < 20; i++) { w.request("t" + i); ok(w); }
  const keys = Object.keys(w.saves()).map(Number);
  assert.equal(keys.length, KEEP);
  assert.equal(Math.min(...keys), 5);
});

test("lastCarrying finds the newest write whose text satisfies the predicate", () => {
  const w = createConfigWrites();
  w.request(T("RightAlt")); ok(w);
  w.request(T("RightCtrl+Space"));
  assert.deepEqual(w.lastCarrying(t => hk(t) === "RightCtrl+Space"), { seq: 2, state: "pending" });
  assert.deepEqual(w.lastCarrying(t => hk(t) === "RightAlt"), { seq: 1, state: "saved" });
  assert.equal(w.lastCarrying(t => hk(t) === "LeftAlt"), null);
});

test("hotkeyWritePlan: equal value pending → that seq; failed → write again; saved or from disk → null; different → write", () => {
  assert.deepEqual(hotkeyWritePlan("RightAlt", "RightAlt", { seq: 4, state: "pending" }), { write: false, seq: 4 });
  assert.deepEqual(hotkeyWritePlan("RightAlt", "RightAlt", { seq: 4, state: "failed" }), { write: true, seq: null });
  assert.deepEqual(hotkeyWritePlan("RightAlt", "RightAlt", { seq: 4, state: "saved" }), { write: false, seq: null });
  assert.deepEqual(hotkeyWritePlan("RightAlt", "RightAlt", null), { write: false, seq: null });
  assert.deepEqual(hotkeyWritePlan("RightAlt", "LeftAlt", null), { write: true, seq: null });
  assert.deepEqual(hotkeyWritePlan(undefined, "RightAlt", null), { write: true, seq: null });
});
