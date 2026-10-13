import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseChord, canonicalChord, MODIFIERS, MAIN_KEYS } from "../lib/Chord.mjs";

const TABLE = JSON.parse(readFileSync(new URL("./fixtures/chords.json", import.meta.url), "utf8"));

test("every row of the shared chord table parses to its canonical form or its exact rejection reason", () => {
  for (const row of TABLE) {
    const r = parseChord(row.in);
    if (row.out !== undefined) {
      assert.equal(r.ok, true, `${JSON.stringify(row.in)} should parse, got ${r.reason}`);
      assert.equal(r.canonical, row.out, `input ${JSON.stringify(row.in)}`);
      assert.equal(canonicalChord(row.in), row.out);
    } else {
      assert.equal(r.ok, false, `${JSON.stringify(row.in)} should be rejected`);
      assert.equal(r.reason, row.err, `input ${JSON.stringify(row.in)}`);
      assert.equal(canonicalChord(row.in), null);
    }
  }
});

test("the table exercises both shapes, aliases, case, duplicates, two main keys, >4 names and an empty name", () => {
  const errs = TABLE.filter(r => r.err).map(r => r.err.split(":")[0]);
  for (const e of ["duplicate name", "two main keys", "too many names", "empty name", "unknown name"]) assert.ok(errs.includes(e), e);
  assert.ok(TABLE.some(r => r.out === "RightShift+RightAlt"), "modifiers-only keeps written order");
  assert.ok(TABLE.some(r => r.in === "space+rightctrl" && r.out === "RightCtrl+Space"), "main key moves last");
});

test("the trigger is the main key, or the last modifier of a modifiers-only chord", () => {
  assert.equal(parseChord("Space+RightCtrl").trigger, "Space");
  assert.equal(parseChord("RightAlt+RightShift").trigger, "RightShift");
  assert.deepEqual(parseChord("LeftCtrl+a+LeftShift").names, ["LeftCtrl", "LeftShift", "A"]);
});

test("the allowlist is exactly 8 modifiers and 26 letters + 10 digits + Space + F1-F24", () => {
  assert.equal(MODIFIERS.length, 8);
  assert.equal(MAIN_KEYS.length, 26 + 10 + 1 + 24);
  assert.equal(parseChord("Escape").ok, false);
  assert.equal(parseChord("toString").ok, false, "object prototype names are not keys");
});

test("non-string input is rejected, not thrown", () => {
  assert.equal(parseChord(undefined).ok, false);
  assert.equal(parseChord(null).reason, "empty name");
  assert.equal(parseChord(true).reason, "unknown name: true");
  assert.equal(parseChord(5).canonical, "5", "a number is stringified, and 5 is a digit key");
});
