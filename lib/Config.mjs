// Spec §4.2: config schema, validation rules (panic exclusivity, supported flag, unknown-field preservation).
import { DEFAULT_CONFIG, DEFAULT_KEYS, DEFAULT_TIMING, DEFAULT_VOICE, KEY_NAMES } from "./Defaults.mjs";
import { validateAction } from "./Actions.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function keyClass(k) {
  const long = !!(k.hold || k.repeat);
  const panic = !!k.panic;
  const double = !!k.double;
  return { long, panic, double, simple: !long && !panic && !double };
}

function normalizeKey(name, raw, problems) {
  const base = DEFAULT_KEYS[name] || {};
  const src = isObj(raw) ? raw : base;
  const out = Object.assign({}, src);            // preserve unknown fields
  for (const trig of ["tap", "hold", "double"]) {
    if (src[trig] === undefined) continue;
    const errs = validateAction(src[trig]);
    if (errs.length) {
      problems.push({ key: name, code: "action-invalid", message: `${name}.${trig}: ${errs.join("; ")}` });
      delete out[trig];
      continue;
    }
    // A legacy dispatcher string fails SILENTLY on an Omarchy Lua config: Hyprland evaluates the
    // string as Lua, "exec omarchy-menu" is a parse error, and nothing surfaces -- the action is
    // still recorded in lastAction as though it ran, and `hyprctl dispatch` answers "ok" even for
    // an argument it cannot use. Report it; do not rewrite it. There is no safe general mapping
    // from a legacy dispatcher to its Lua form, and the string may be correct on a host using the
    // legacy parser, so dropping or rewriting it would trade a visible fault for an invisible one.
    const act = src[trig];
    if (act.type === "dispatch" && !String(act.dispatcher).startsWith("hl.")) {
      problems.push({
        key: name, code: "legacy-dispatcher",
        message: `${name}.${trig}: dispatcher "${act.dispatcher}" is a legacy string. On an Omarchy Lua config Hyprland evaluates dispatch strings as Lua, so this is a parse error and the action will not run. Use the Lua form, e.g. hl.dsp.exec_cmd("omarchy-menu").`,
      });
    }
  }
  out.repeat = src.repeat === true;
  out.panic = src.panic === true;
  out.supported = src.supported !== false;
  if (name === "mic") {
    // An enum, not the old `ptt` boolean: a pulse-type mic button (press and release ~0 ms apart)
    // can only be driven by a toggle, and "mic behaves as an ordinary key" is a third state the
    // boolean could not express. Legacy `ptt: false` meant exactly that third state, so it must
    // migrate to "key" rather than to "ptt".
    const t = src.trigger;
    // Migration from the legacy `ptt` boolean. The normalizer ALWAYS wrote `ptt: true` (it was
    // `src.ptt !== false`), so `true` is indistinguishable from unset and carries no user intent --
    // it must not pin a config to ptt forever. `ptt: false` DID require a deliberate edit, and it
    // meant "mic is an ordinary key", which is now spelled "key".
    out.trigger = (t === "ptt" || t === "toggle" || t === "key") ? t
                : (src.ptt === false ? "key" : "toggle");
    // Remove the legacy boolean rather than leaving it beside the enum. `out` starts as a copy of
    // `src` to preserve unknown fields, so without this a migrated config keeps `ptt: true` next to
    // `trigger: "toggle"` and a reader cannot tell which the plugin obeys. `ptt` is a known
    // deprecated field, not an unknown one, so deleting it is migration rather than data loss.
    delete out.ptt;
  }
  if (out.panic && (out.hold || out.repeat)) {
    problems.push({ key: name, code: "panic-exclusive", message: `${name}: panic cannot combine with hold/repeat; using tap only` });
    delete out.hold;
    out.repeat = false;
  }
  return out;
}

export function normalizeConfig(raw) {
  const problems = [];
  if (!isObj(raw)) {
    problems.push({ code: "config-invalid", message: "config is not an object; using defaults" });
    raw = {};
  }
  const config = Object.assign({}, raw);
  config.version = 1;
  config.device = Object.assign({}, DEFAULT_CONFIG.device, isObj(raw.device) ? raw.device : {});
  const t = isObj(raw.timing) ? raw.timing : {};
  config.timing = Object.assign({}, t);
  for (const k of Object.keys(DEFAULT_TIMING)) config.timing[k] = num(t[k], DEFAULT_TIMING[k]);
  // The stuck bound must never pre-empt a key's own legitimate timer. A stuckMs below holdMs/panicMs/doubleMs
  // would time a key out before its hold, panic reset or double window could fire — on a panic key that
  // silently removes the §4.3 escape hatch — and num() above accepts 0. Raise it rather than honour it.
  const stuckFloor = Math.max(config.timing.holdMs, config.timing.panicMs, config.timing.doubleMs) + 1;
  if (config.timing.stuckMs < stuckFloor) {
    problems.push({ code: "stuck-ms-raised", message: `timing.stuckMs ${config.timing.stuckMs} is below the longest key timer; raised to ${stuckFloor}` });
    config.timing.stuckMs = stuckFloor;
  }
  const v = isObj(raw.voice) ? raw.voice : {};
  config.voice = Object.assign({}, v);
  for (const k of ["maxSessionSec", "startTimeoutMs", "arbitrationMs", "stopTimeoutMs"]) config.voice[k] = num(v[k], DEFAULT_VOICE[k]);
  config.voice.mic = v.mic === "system" ? "system" : "remote";
  config.voice.hud = v.hud !== false;
  config.voice.actionFlash = v.actionFlash !== false;

  const rawKeys = isObj(raw.keys) ? raw.keys : {};
  config.keys = {};
  for (const name of KEY_NAMES) config.keys[name] = normalizeKey(name, rawKeys[name], problems);
  for (const extra of Object.keys(rawKeys)) if (!KEY_NAMES.includes(extra)) config.keys[extra] = rawKeys[extra];

  if (!KEY_NAMES.some(n => config.keys[n].panic && config.keys[n].supported)) {
    problems.push({ code: "no-panic-key", message: "no supported key has panic: true (§4.3 escape hatch)" });
  }
  return { config, problems };
}
