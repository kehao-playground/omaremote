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
  // Measured on the host 2026-10-08, not looked up: **keyd's key-name table is not Linux's.**
  // keyd's `prog1` emits KEY_F21 (191) and `prog2` emits KEY_F22 (192) -- they are aliases for
  // f21..f24, not the KEY_PROG1 (148) that input-event-codes.h defines. So `mic = prog1` made the
  // mic button emit `app`'s exact code: pressing mic fired omaremote:app and omaremote:mic could
  // never fire at all. `keyd check` passes on such a config and reports nothing.
  //
  // This was invisible for two days because every check above keyd used the LINUX code: injecting
  // `prog1` through uinput sends 148 -> XF86Launch1 -> the bind fires, which "proved" a path the
  // real system never produces. keyd is the only thing that emits 191 there.
  //
  // `xfer` (147 -> <I155> -> XF86Xfer) was measured emitting its Linux code, is outside the
  // F13-F24 range, and has no application meaning that could act if it ever leaked past a bind.
  assert.equal(NEUTRAL_KEYS.mic.keyd, "xfer");
  assert.equal(NEUTRAL_KEYS.mic.keysym, "XF86Xfer");
  // No neutral key may use a keyd name that aliases another code. prog1..prog4 are the known trap;
  // they are *valid* keyd names, so only this assertion stops one coming back.
  for (const k of KEY_NAMES) {
    assert.ok(!/^prog[1-4]$/.test(NEUTRAL_KEYS[k].keyd),
      `NEUTRAL_KEYS.${k}.keyd is "${NEUTRAL_KEYS[k].keyd}": keyd aliases prog1-prog4 to f21-f24, ` +
      `so this silently collides with another key's code`);
  }
  // The collision above is the reason this is asserted at all: every keysym must be distinct, or
  // two logical keys fight over one bind.
  const syms = KEY_NAMES.map(k => NEUTRAL_KEYS[k].keysym);
  assert.equal(new Set(syms).size, 13);
});

test("a legacy dispatcher string is reported, because it fails silently", () => {
  // Hyprland evaluates a dispatch string as Lua on an Omarchy Lua config, so "exec omarchy-menu"
  // is a parse error. Nothing surfaces: the action still appears in lastAction as though it ran,
  // and `hyprctl dispatch` answers "ok" even for arguments it cannot use. `home` and `app` did
  // nothing at all on this host until 2026-10-07, and the config that caused it looked valid.
  const r = normalizeConfig({ keys: { home: { tap: { type: "dispatch", dispatcher: "exec", arg: "omarchy-menu" } } } });
  const p = r.problems.find(x => x.code === "legacy-dispatcher");
  assert.ok(p, `expected a legacy-dispatcher problem, got ${JSON.stringify(r.problems)}`);
  assert.match(p.message, /home\.tap/);
  // The action is kept, not dropped: it is the user's, it may be right on a legacy-parser host,
  // and dropping it would replace a visible misbehaviour with an invisible one.
  assert.equal(r.config.keys.home.tap.dispatcher, "exec");
  // A Lua dispatcher is not reported.
  const ok = normalizeConfig({ keys: { home: { tap: { type: "dispatch", dispatcher: 'hl.dsp.exec_cmd("omarchy-menu")' } } } });
  assert.equal(ok.problems.filter(x => x.code === "legacy-dispatcher").length, 0);
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

test("mic trigger: ptt | toggle | key, migrating the legacy ptt boolean", () => {
  // `keys.mic.ptt` was a boolean, which cannot express a third interaction. This remote's mic
  // button sends press and release ~0 ms apart (firmware pulse, measured 2026-10-08), so
  // push-to-talk records ~0.1 s -- mechanically correct and useless. A toggle is the only
  // interaction a pulse supports, so the field became an enum.
  const trig = (mic) => normalizeConfig({ version: 1, keys: { mic } }).config.keys.mic.trigger;

  assert.equal(trig({ trigger: "toggle" }), "toggle");
  assert.equal(trig({ trigger: "ptt" }), "ptt");
  assert.equal(trig({ trigger: "key" }), "key");

  // Legacy configs on disk carry `ptt`. ptt:false meant "mic is an ordinary key, let the engine
  // handle tap/hold", which is now spelled "key" -- so the migration must not turn it into "ptt".
  // The normalizer always wrote `ptt: true` (it was `src.ptt !== false`), so `true` is
  // indistinguishable from unset: it records no choice and must not pin a config to ptt forever.
  assert.equal(trig({ ptt: true }), "toggle");
  // `ptt: false` required a deliberate edit and meant "mic is an ordinary key" -- a real choice,
  // preserved. This is the one asymmetry in the migration and the reason it is not a blanket reset.
  assert.equal(trig({ ptt: false }), "key");
  assert.equal(trig({}), "toggle", "an unspecified mic trigger takes the shipped default");

  // Garbage falls back to the default rather than disabling the mic silently.
  assert.equal(trig({ trigger: "nonsense" }), "toggle");
  assert.equal(trig({ trigger: 7 }), "toggle");
  // An explicit trigger wins over a stale ptt left beside it by an older writer.
  assert.equal(trig({ trigger: "ptt", ptt: false }), "ptt", "an explicit trigger wins over a stale ptt");
  assert.equal(trig({ trigger: "key", ptt: true }), "key");

  // The legacy boolean must be REMOVED, not merely superseded. Unknown fields are preserved on
  // write (spec §4.2), so without an explicit delete a migrated config keeps `ptt: true` sitting
  // next to `trigger: "toggle"` and a reader cannot tell which one the plugin obeys -- the exact
  // duplicate-source-of-truth drift this enum exists to end.
  //
  // This must be asserted on a config that ACTUALLY CARRIES `ptt`. The earlier version of this
  // assertion used `normalizeConfig({ version: 1 })`, which has no `ptt` at all, so it passed
  // vacuously and could never have caught the leak.
  const migrated = normalizeConfig({ version: 1, keys: { mic: { ptt: true } } }).config.keys.mic;
  assert.equal(migrated.trigger, "toggle");
  assert.equal(migrated.ptt, undefined, "the legacy ptt boolean must not survive migration");
  const migratedOff = normalizeConfig({ version: 1, keys: { mic: { ptt: false } } }).config.keys.mic;
  assert.equal(migratedOff.trigger, "key");
  assert.equal(migratedOff.ptt, undefined);
  // A genuinely unknown field is still preserved -- the delete is targeted, not a purge.
  const kept = normalizeConfig({ version: 1, keys: { mic: { ptt: true, mystery: 42 } } }).config.keys.mic;
  assert.equal(kept.mystery, 42);
});
