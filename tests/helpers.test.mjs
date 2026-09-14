import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock, byType } from "./helpers.mjs";

test("clock starts at 0 and ticks forward", () => {
  const c = createClock();
  assert.equal(c.now(), 0);
  c.tick(350);
  assert.equal(c.now(), 350);
});

test("byType filters effects", () => {
  const fx = [{ type: "hud", text: "a" }, { type: "cmd", id: 1 }, { type: "hud", text: "b" }];
  assert.deepEqual(byType(fx, "hud").map(e => e.text), ["a", "b"]);
});
