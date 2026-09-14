import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyEngine } from "../lib/KeyEngine.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";
import { byType } from "./helpers.mjs";

function engine(overrideKeys = {}) {
  const raw = { ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, ...overrideKeys } };
  return createKeyEngine(normalizeConfig(raw).config);
}
const acts = (fx) => byType(fx, "action").map(a => `${a.key}:${a.trigger}${a.repeat ? "*" : ""}`);

test("simple key (home) fires tap on press; release and long hold are ignored", () => {
  const e = engine();
  assert.deepEqual(acts(e.press("home", 0)), ["home:tap"]);
  assert.deepEqual(acts(e.advance(5000)), []);
  assert.deepEqual(acts(e.release("home", 5000)), []);
  assert.equal(e.nextDeadline(), null);
});

test("long key (ok): release before holdMs emits tap", () => {
  const e = engine();
  assert.deepEqual(acts(e.press("ok", 0)), []);
  assert.equal(e.nextDeadline(), 350);
  assert.deepEqual(acts(e.release("ok", 349)), ["ok:tap"]);
  assert.equal(e.nextDeadline(), null);
});

test("long key (ok): hold fires at holdMs, release afterwards emits nothing", () => {
  const e = engine();
  e.press("ok", 0);
  assert.deepEqual(acts(e.advance(350)), ["ok:hold"]);
  assert.deepEqual(acts(e.release("ok", 1000)), []);
});

test("release exactly at holdMs counts as hold, not tap", () => {
  const e = engine();
  e.press("ok", 0);
  const fx = e.release("ok", 350);
  assert.deepEqual(acts(fx), ["ok:hold"]);
});

test("hold action carries the configured action object", () => {
  const e = engine();
  e.press("ok", 0);
  const hold = byType(e.advance(350), "action")[0];
  assert.deepEqual(hold.action, { type: "key", keys: "ctrl+c" });
});

test("panic key (menu): release before panicMs emits tap even after 350ms", () => {
  const e = engine();
  e.press("menu", 0);
  assert.deepEqual(acts(e.advance(1499)), []);
  assert.deepEqual(acts(e.release("menu", 1499)), ["menu:tap"]);
});

test("panic key held to panicMs emits reset and clears every key", () => {
  const e = engine();
  e.press("ok", 0);
  e.press("menu", 10);
  assert.deepEqual(acts(e.advance(400)), ["ok:hold"]);   // ok's own hold fires first, as the host timer would
  const fx = e.advance(1510);
  assert.deepEqual(byType(fx, "reset").length, 1);
  assert.deepEqual(acts(fx), []);
  assert.deepEqual(e.heldKeys(), []);
  assert.deepEqual(acts(e.release("menu", 1600)), []);
  assert.deepEqual(acts(e.release("ok", 1600)), []);
});

test("unsupported key events are ignored", () => {
  const e = engine({ app: { supported: false, tap: { type: "none" } } });
  assert.deepEqual(e.press("app", 0), []);
});

test("unknown key names are ignored", () => {
  const e = engine();
  assert.deepEqual(e.press("nope", 0), []);
});

test("repeat key (up): tap at holdMs then every repeatMs until release", () => {
  const e = engine();
  e.press("up", 0);
  assert.deepEqual(acts(e.advance(350)), ["up:tap*"]);
  assert.equal(e.nextDeadline(), 430);
  assert.deepEqual(acts(e.advance(430)), ["up:tap*"]);
  assert.deepEqual(acts(e.advance(600)), ["up:tap*", "up:tap*"]); // 510, 590
  assert.deepEqual(acts(e.release("up", 620)), []);
  assert.equal(e.nextDeadline(), null);
});

test("repeat key released before holdMs emits a single non-repeat tap", () => {
  const e = engine();
  e.press("up", 0);
  const fx = e.release("up", 100);
  assert.deepEqual(acts(fx), ["up:tap"]);
  assert.equal(byType(fx, "action")[0].repeat, false);
});

test("hold and repeat both bound: hold fires once, then tap repeats", () => {
  const e = engine({ down: { tap: { type: "key", keys: "Down" }, hold: { type: "key", keys: "End" }, repeat: true } });
  e.press("down", 0);
  assert.deepEqual(acts(e.advance(350)), ["down:hold", "down:tap*"]);
  assert.deepEqual(acts(e.advance(430)), ["down:tap*"]);
});

test("reload clears in-flight state without emitting", () => {
  const e = engine();
  e.press("up", 0);
  assert.deepEqual(e.reload(normalizeConfig(DEFAULT_CONFIG).config), []);
  assert.equal(e.nextDeadline(), null);
  assert.deepEqual(acts(e.advance(1000)), []);
  assert.deepEqual(acts(e.release("up", 1000)), []);
});

test("press while already down is ignored (no double-start of timers)", () => {
  const e = engine();
  e.press("ok", 0);
  assert.deepEqual(acts(e.press("ok", 100)), []);
  assert.equal(e.nextDeadline(), 350);
});

const dbl = () => engine({ ok: { tap: { type: "key", keys: "Return" }, double: { type: "key", keys: "ctrl+Return" } } });

test("double-bound key: single tap is deferred until doubleMs elapses", () => {
  const e = dbl();
  e.press("ok", 0);
  assert.deepEqual(acts(e.release("ok", 50)), []);
  assert.equal(e.nextDeadline(), 300);
  assert.deepEqual(acts(e.advance(299)), []);
  assert.deepEqual(acts(e.advance(300)), ["ok:tap"]);
});

test("double-bound key: second press within doubleMs emits double and consumes its release", () => {
  const e = dbl();
  e.press("ok", 0); e.release("ok", 50);
  assert.deepEqual(acts(e.press("ok", 200)), ["ok:double"]);
  assert.deepEqual(acts(e.release("ok", 260)), []);
  assert.deepEqual(acts(e.advance(1000)), []);
});

test("double-bound key: second press after doubleMs is a new single press", () => {
  const e = dbl();
  e.press("ok", 0); e.release("ok", 50);
  const fx = e.press("ok", 400);                // 300 deadline fires first -> tap, then new press
  assert.deepEqual(acts(fx), ["ok:tap"]);
  assert.deepEqual(acts(e.release("ok", 450)), []); // now waiting for a possible double again
  assert.deepEqual(acts(e.advance(700)), ["ok:tap"]);
});

test("double + long key: hold still fires while down; release after hold emits nothing", () => {
  const e = engine({ ok: { tap: { type: "key", keys: "Return" }, hold: { type: "key", keys: "ctrl+c" }, double: { type: "key", keys: "ctrl+Return" } } });
  e.press("ok", 0);
  assert.deepEqual(acts(e.advance(350)), ["ok:hold"]);
  assert.deepEqual(acts(e.release("ok", 400)), []);
});

test("pressing another key resolves a pending double as tap first (no cross-key doubles)", () => {
  const e = dbl();
  e.press("ok", 0); e.release("ok", 50);
  const fx = e.press("home", 100);
  assert.deepEqual(acts(fx), ["ok:tap", "home:tap"]);
});
