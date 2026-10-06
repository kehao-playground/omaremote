import { test } from "node:test";
import assert from "node:assert/strict";
import { load, serialize, withPatch, withMerged, withKey, withDefaultKeys } from "../lib/ConfigFile.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";

test("empty or missing text loads defaults and flags missing (first run creates the file)", () => {
  const r = load("");
  assert.equal(r.missing, true); assert.equal(r.invalid, false);
  assert.deepEqual(r.raw, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  assert.equal(r.config.voice.mic, "remote");
  assert.equal(load(undefined).missing, true);
});

test("invalid JSON or a non-object loads defaults, flags invalid and reports config-invalid", () => {
  const r = load("{ not json");
  assert.equal(r.invalid, true); assert.equal(r.missing, false);
  assert.equal(r.problems[0].code, "config-invalid");
  assert.equal(load("[1,2]").invalid, true);
});

test("a valid file keeps raw (unknown fields) and normalizes config", () => {
  const r = load(JSON.stringify({ version: 1, extra: { a: 1 }, keys: { ok: { tap: { type: "key", keys: "Return" }, note: "mine" } } }));
  assert.equal(r.invalid, false);
  assert.deepEqual(r.raw.extra, { a: 1 });
  assert.equal(r.raw.keys.ok.note, "mine");
  assert.equal(r.config.keys.up.repeat, true);         // defaults filled in for missing keys
  assert.equal(r.config.keys.ok.note, "mine");         // §4.2 unknown per-key fields preserved
});

test("withPatch sets a nested path without touching other fields and deletes on undefined", () => {
  const raw = { version: 1, extra: 1, voice: { mic: "remote", custom: true } };
  const next = withPatch(raw, ["voice", "mic"], "system");
  assert.equal(next.voice.mic, "system"); assert.equal(next.voice.custom, true); assert.equal(next.extra, 1);
  assert.equal(raw.voice.mic, "remote");                 // input untouched
  assert.deepEqual(withPatch({}, ["timing", "holdMs"], 400), { timing: { holdMs: 400 } });
  assert.deepEqual(withPatch({ a: { b: 1 } }, ["a", "b"], undefined), { a: {} });
});

test("withMerged keeps node fields the caller did not supply (a Timing save must not drop stuckMs)", () => {
  const raw = { extra: 1, timing: { holdMs: 350, doubleMs: 250, repeatMs: 80, panicMs: 1500, stuckMs: 30000, custom: "x" } };
  const next = withMerged(raw, ["timing"], { holdMs: 400, doubleMs: 250, repeatMs: 80, panicMs: 1500 });
  assert.equal(next.timing.stuckMs, 30000);
  assert.equal(next.timing.custom, "x");
  assert.equal(next.timing.holdMs, 400);
  assert.equal(next.extra, 1);
  assert.equal(raw.timing.holdMs, 350);                  // input untouched
  assert.deepEqual(withMerged({}, ["timing"], { holdMs: 400 }), { timing: { holdMs: 400 } });
  assert.deepEqual(withMerged({ timing: 5 }, ["timing"], { holdMs: 400 }), { timing: { holdMs: 400 } });
  assert.deepEqual(withMerged({ t: { a: 1, b: 2 } }, ["t"], { a: undefined }), { t: { b: 2 } });
});

test("withKey merges fields into keys[name], deletes undefined fields, keeps unknown fields", () => {
  const raw = { keys: { ok: { tap: { type: "key", keys: "Return" }, hold: { type: "key", keys: "ctrl+c" }, note: "x" } } };
  const next = withKey(raw, "ok", { hold: undefined, repeat: true });
  assert.deepEqual(next.keys.ok, { tap: { type: "key", keys: "Return" }, repeat: true, note: "x" });
  assert.deepEqual(withKey({}, "up", { repeat: false }).keys.up, { repeat: false });
});

test("withDefaultKeys restores default actions but keeps supported:false", () => {
  const raw = { keys: { app: { supported: false, tap: { type: "none" } }, ok: { tap: { type: "none" } } }, device: { name: "G20S" } };
  const next = withDefaultKeys(raw);
  assert.equal(next.keys.app.supported, false);
  assert.equal(next.keys.app.tap.type, "dispatch");
  assert.equal(next.keys.ok.tap.keys, "Return");
  assert.equal(next.device.name, "G20S");
});

test("serialize round-trips with a trailing newline", () => {
  const raw = { version: 1, extra: [1, 2] };
  assert.deepEqual(JSON.parse(serialize(raw)), raw);
  assert.ok(serialize(raw).endsWith("\n"));
});
