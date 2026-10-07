import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, keyClass } from "../lib/Config.mjs";
import { DEFAULT_CONFIG, KEY_NAMES, NEUTRAL_KEYS } from "../lib/Defaults.mjs";

test("defaults normalize with no problems and all 13 keys present", () => {
  const { config, problems } = normalizeConfig(DEFAULT_CONFIG);
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(config.keys).sort(), [...KEY_NAMES].sort());
  assert.equal(config.timing.holdMs, 350);
  assert.equal(config.voice.arbitrationMs, 250);
});

test("null / non-object input yields defaults plus a config-invalid problem", () => {
  const { config, problems } = normalizeConfig(null);
  assert.equal(config.timing.panicMs, 1500);
  assert.equal(problems[0].code, "config-invalid");
});

test("panic is exclusive with hold/repeat: key falls back to tap-only and is reported", () => {
  const raw = { ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys,
    menu: { tap: { type: "key", keys: "Tab" }, hold: { type: "key", keys: "Escape" }, panic: true, repeat: true } } };
  const { config, problems } = normalizeConfig(raw);
  assert.equal(config.keys.menu.hold, undefined);
  assert.equal(config.keys.menu.repeat, false);
  assert.equal(config.keys.menu.panic, true);
  assert.equal(problems.find(p => p.key === "menu").code, "panic-exclusive");
});

test("unknown top-level and per-key fields are preserved", () => {
  const raw = { ...DEFAULT_CONFIG, extra: { a: 1 }, keys: { ...DEFAULT_CONFIG.keys, ok: { ...DEFAULT_CONFIG.keys.ok, note: "x" } } };
  const { config } = normalizeConfig(raw);
  assert.deepEqual(config.extra, { a: 1 });
  assert.equal(config.keys.ok.note, "x");
});

test("supported defaults to true and can be false; missing keys are filled from defaults", () => {
  const raw = { ...DEFAULT_CONFIG, keys: { app: { supported: false } } };
  const { config } = normalizeConfig(raw);
  assert.equal(config.keys.app.supported, false);
  assert.equal(config.keys.up.supported, true);
  assert.equal(config.keys.up.repeat, true);
});

test("no supported panic key is reported", () => {
  const raw = { ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, menu: { ...DEFAULT_CONFIG.keys.menu, supported: false } } };
  const { problems } = normalizeConfig(raw);
  assert.ok(problems.some(p => p.code === "no-panic-key"));
});

test("invalid action on a key is dropped and reported", () => {
  const raw = { ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, ok: { tap: { type: "shell", cmd: "rm" } } } };
  const { config, problems } = normalizeConfig(raw);
  assert.equal(config.keys.ok.tap, undefined);
  assert.equal(problems.find(p => p.key === "ok").code, "action-invalid");
});

test("keyClass classifies keys", () => {
  assert.deepEqual(keyClass({ tap: { type: "none" } }), { long: false, panic: false, double: false, simple: true });
  assert.deepEqual(keyClass({ tap: { type: "none" }, repeat: true }), { long: true, panic: false, double: false, simple: false });
  assert.deepEqual(keyClass({ tap: { type: "none" }, panic: true, double: { type: "none" } }), { long: false, panic: true, double: true, simple: false });
});

test("neutral key table covers all 13 keys with unique keyd names and keysyms", () => {
  const names = KEY_NAMES.map(k => NEUTRAL_KEYS[k].keyd);
  assert.equal(new Set(names).size, 13);
  // Measured on the host 2026-10-07, not assumed: KEY_PROG1 is <I156>, which symbols/inet maps to
  // XF86Launch1. The table said XF86Tools, which is what <FK13> (keyd f13, our `up`) produces --
  // so before this was corrected, `up` and `mic` resolved to the SAME keysym and one of them could
  // never fire. Verified by injecting prog1 against binds on both names: XF86Launch1 fired.
  assert.equal(NEUTRAL_KEYS.mic.keysym, "XF86Launch1");
  // The collision above is the reason this is asserted at all: every keysym must be distinct, or
  // two logical keys fight over one bind.
  const syms = KEY_NAMES.map(k => NEUTRAL_KEYS[k].keysym);
  assert.equal(new Set(syms).size, 13);
});

test("timing.stuckMs is raised above the longest key timer, with a problem recorded", () => {
  const r = normalizeConfig({ timing: { stuckMs: 0 } });
  assert.equal(r.config.timing.stuckMs, 1501);            // panicMs 1500 is the longest default timer
  assert.ok(r.problems.some(p => p.code === "stuck-ms-raised"));
});

test("the stuckMs floor covers holdMs, not just panicMs", () => {
  const r = normalizeConfig({ timing: { holdMs: 3000, stuckMs: 2000 } });
  assert.equal(r.config.timing.stuckMs, 3001);           // holdMs 3000 > panicMs 1500: only the Math.max over all three timers gets this
});

test("a stuckMs below panicMs cannot disable the panic escape hatch", () => {
  const r = normalizeConfig({ timing: { stuckMs: 1000 } });
  assert.ok(r.config.timing.stuckMs > r.config.timing.panicMs);
});

test("a stuckMs above every key timer is honoured untouched", () => {
  const r = normalizeConfig({ timing: { stuckMs: 4000 } });
  assert.equal(r.config.timing.stuckMs, 4000);
  assert.ok(!r.problems.some(p => p.code === "stuck-ms-raised"));
});
