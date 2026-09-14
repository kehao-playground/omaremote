import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatusLine, isHealthy, isIdle, createStatusStream } from "../lib/VoxStatus.mjs";

test("class field is the state; alt is a fallback", () => {
  assert.equal(parseStatusLine('{"text":"","alt":"recording","class":"recording","tooltip":"Recording..."}').cls, "recording");
  assert.equal(parseStatusLine('{"alt":"idle"}').cls, "idle");
});

test("streaming is normalized to recording", () => {
  assert.equal(parseStatusLine('{"class":"streaming"}').cls, "recording");
  assert.equal(parseStatusLine('{"alt":"streaming"}').cls, "recording");
});

test("stopped and unknown classes are unhealthy and never idle", () => {
  assert.equal(parseStatusLine('{"class":"stopped"}').cls, "stopped");
  assert.equal(parseStatusLine('{"class":"weird"}').cls, "unknown");
  assert.equal(isHealthy("stopped"), false);
  assert.equal(isHealthy("unknown"), false);
  assert.equal(isHealthy("transcribing"), true);
  assert.equal(isIdle("unknown"), false);
  assert.equal(isIdle("idle"), true);
});

test("blank and non-JSON lines are null", () => {
  assert.equal(parseStatusLine(""), null);
  assert.equal(parseStatusLine("Voxtype ready"), null);
});

test("stream buffers partial lines", () => {
  const s = createStatusStream();
  const l = '{"class":"transcribing"}\n';
  assert.deepEqual(s.feed(l.slice(0, 5)), []);
  assert.equal(s.feed(l.slice(5))[0].cls, "transcribing");
});
