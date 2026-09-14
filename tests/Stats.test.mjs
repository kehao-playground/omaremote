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
