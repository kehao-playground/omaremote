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
  // NOT prog1: keyd aliases prog1..prog4 to f21..f24, so `mic = prog1` emitted `app`'s code
  // (KEY_F21) and mic could never fire. Measured on the host 2026-10-08. `xfer` emits its own
  // Linux code 147 = <I155> -> XF86Xfer, outside the F13-F24 range.
  mic:     { keyd: "xfer", keysym: "XF86Xfer" },
};

export const DEFAULT_TIMING = { holdMs: 350, doubleMs: 250, repeatMs: 80, panicMs: 1500, stuckMs: 10000 };

export const DEFAULT_VOICE = {
  mic: "remote",
  // Mic source picker spec §3: "default" or a PipeWire node.name; used only while mic is "system".
  systemDevice: "default",
  maxSessionSec: 60,
  startTimeoutMs: 1500,
  arbitrationMs: 250,
  stopTimeoutMs: 15000,
  hud: true,
  actionFlash: true,
  // Plan 4: describes how ATVVoice runs, not a preference. false = no --mic-on-demand, so only the
  // remote's button can make it stream and the D-Bus start needs no arbitration.
  remoteOnDemand: false,
};

// Typeless spec §3. Deliberately outside DEFAULT_VOICE: DEFAULT_CONFIG is what a first run writes to config.json,
// and `omaremote-setup typeless` adopts Typeless's own hotkey only while voice.typeless.hotkey is absent there.
export const DEFAULT_ENGINE = "voxtype";
export const DEFAULT_TYPELESS_HOTKEY = "RightAlt";
export const DEFAULT_TYPELESS_PRESS_WAIT_MS = 250;   // §5.2 press gate; 0 disables it

const key = (keys) => ({ type: "key", keys });

// Dispatcher strings must be Lua: an Omarchy Lua config evaluates them as Lua, so the legacy
// "exec omarchy-menu" and "workspace e+1" were parse errors and `home`/`app` did nothing at all.
// Measured 2026-10-07. tests/Actions.test.mjs asserts no default carries a legacy string.
export const DEFAULT_KEYS = {
  up:      { tap: key("Up"),    repeat: true },
  down:    { tap: key("Down"),  repeat: true },
  left:    { tap: key("Left"),  repeat: true },
  right:   { tap: key("Right"), repeat: true },
  ok:      { tap: key("Return"), hold: key("ctrl+c") },
  back:    { tap: key("Escape"), hold: key("BackSpace") },
  home:    { tap: { type: "dispatch", dispatcher: "hl.dsp.exec_cmd(\"omarchy-menu\")" } },
  menu:    { tap: key("Tab"), panic: true },
  app:     { tap: { type: "dispatch", dispatcher: "hl.dsp.focus({ workspace = \"e+1\" })" } },
  volup:   { tap: { type: "volume", delta: "+5" }, repeat: true },
  voldown: { tap: { type: "volume", delta: "-5" }, repeat: true },
  power:   { tap: { type: "screen", cmd: "off" }, hold: { type: "screen", cmd: "lock" } },
  // "toggle" by default: a pulse-type mic button (press and release in the same millisecond)
  // cannot do push-to-talk at all, and an explicit start/stop is the right primitive for a
  // streaming dictation backend. Set trigger: "ptt" for a remote whose mic button really holds.
  mic:     { trigger: "toggle" },
};

export const DEFAULT_CONFIG = {
  version: 1,
  device: { vendor: "", product: "", name: "", learned: {} },
  timing: Object.assign({}, DEFAULT_TIMING),
  keys: DEFAULT_KEYS,
  voice: Object.assign({}, DEFAULT_VOICE),
};
