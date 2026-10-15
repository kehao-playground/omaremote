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

test("names: every description seen this session survives the source leaving the list", () => {
  const s = seeded([C922, LATE]);
  s.requestRefresh(); s.finished(s.started(), [LATE]);           // the C922 was unplugged
  assert.deepEqual(s.list(), [LATE]);
  assert.deepEqual(s.names(), { [C922.name]: "C922", [LATE.name]: "Late" });
  s.requestRefresh(); s.finished(s.started(), null);             // a failed refresh forgets nothing
  assert.equal(s.names()[C922.name], "C922");
  s.requestRefresh(); s.finished(s.started(), [{ name: C922.name, description: "" }]);
  assert.equal(s.names()[C922.name], "C922", "an empty description never replaces a known one");
  s.names()[LATE.name] = "mutated";
  assert.equal(s.names()[LATE.name], "Late", "a copy, not the store");
});
