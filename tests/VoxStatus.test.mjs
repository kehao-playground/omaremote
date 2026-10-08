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

test("a line carrying no class at all is no information, not an unhealthy daemon", () => {
  // Measured on the host 2026-10-08 against voxtype 1.1.0: its `status --follow` stream emits a
  // line with an EMPTY class as a normal part of the recording -> idle transition:
  //     class=recording
  //     class=              <-- this one
  //     class=idle
  // Mapping that to "unknown" made isHealthy() reject it, and VoiceSession.status() then called
  // toUnconfigured("voxtype not responding") on a daemon that was alive and merely mid-transition.
  // Every mic press therefore incremented errorCount and knocked the session out of its state.
  //
  // An absent class is NOT the same as a class we do not recognise: "weird" means the daemon told
  // us something we cannot interpret, while "" means it told us nothing. Only the former is a
  // health signal, so a classless line must be dropped by the caller (`if (!r) return`).
  assert.equal(parseStatusLine('{"class":""}'), null);
  assert.equal(parseStatusLine('{"class":"","alt":""}'), null);
  assert.equal(parseStatusLine('{"text":"x"}'), null);                 // no class and no alt
  // An unrecognised but non-empty class stays "unknown" -- that distinction is the whole point.
  assert.equal(parseStatusLine('{"class":"weird"}').cls, "unknown");
  // `alt` still backstops a missing `class`, which is how the existing fallback is specified.
  assert.equal(parseStatusLine('{"alt":"recording"}').cls, "recording");
});
