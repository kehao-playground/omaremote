// Spec §3 (neutral keys), §4.2 (schema defaults), §4.5 (default profile), §7 step 2 (learning rules).
export const KEY_NAMES = ["up", "down", "left", "right", "ok", "back", "home", "menu", "app", "volup", "voldown", "power", "mic"];
export const REQUIRED_KEYS = ["up", "down", "left", "right", "ok", "back"];
export const PANIC_FALLBACK_ORDER = ["home", "app", "power", "back"];

export const NEUTRAL_KEYS = {
  up:      { keyd: "f13", keysym: "F13" },
  down:    { keyd: "f14", keysym: "F14" },
  left:    { keyd: "f15", keysym: "F15" },
  right:   { keyd: "f16", keysym: "F16" },
  ok:      { keyd: "f17", keysym: "F17" },
  back:    { keyd: "f18", keysym: "F18" },
  home:    { keyd: "f19", keysym: "F19" },
  menu:    { keyd: "f20", keysym: "F20" },
  app:     { keyd: "f21", keysym: "F21" },
  volup:   { keyd: "f22", keysym: "F22" },
  voldown: { keyd: "f23", keysym: "F23" },
  power:   { keyd: "f24", keysym: "F24" },
  mic:     { keyd: "prog1", keysym: "XF86Tools" },
};

export const DEFAULT_TIMING = { holdMs: 350, doubleMs: 250, repeatMs: 80, panicMs: 1500, stuckMs: 10000 };

export const DEFAULT_VOICE = {
  mic: "remote",
  maxSessionSec: 60,
  startTimeoutMs: 1500,
  arbitrationMs: 250,
  stopTimeoutMs: 15000,
  hud: true,
  actionFlash: true,
};

const key = (keys) => ({ type: "key", keys });

export const DEFAULT_KEYS = {
  up:      { tap: key("Up"),    repeat: true },
  down:    { tap: key("Down"),  repeat: true },
  left:    { tap: key("Left"),  repeat: true },
  right:   { tap: key("Right"), repeat: true },
  ok:      { tap: key("Return"), hold: key("ctrl+c") },
  back:    { tap: key("Escape"), hold: key("BackSpace") },
  home:    { tap: { type: "dispatch", dispatcher: "exec", arg: "omarchy-menu" } },
  menu:    { tap: key("Tab"), panic: true },
  app:     { tap: { type: "dispatch", dispatcher: "workspace", arg: "e+1" } },
  volup:   { tap: { type: "volume", delta: "+5" }, repeat: true },
  voldown: { tap: { type: "volume", delta: "-5" }, repeat: true },
  power:   { tap: { type: "screen", cmd: "off" }, hold: { type: "screen", cmd: "lock" } },
  mic:     { ptt: true },
};

export const DEFAULT_CONFIG = {
  version: 1,
  device: { vendor: "", product: "", name: "", learned: {} },
  timing: Object.assign({}, DEFAULT_TIMING),
  keys: DEFAULT_KEYS,
  voice: Object.assign({}, DEFAULT_VOICE),
};
