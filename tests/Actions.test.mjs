import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeys, toArgv, validateAction, describe } from "../lib/Actions.mjs";

test("parseKeys splits modifiers and key, case-insensitive modifiers", () => {
  assert.deepEqual(parseKeys("Ctrl+Shift+Return"), { mods: ["ctrl", "shift"], key: "Return" });
  assert.deepEqual(parseKeys("Up"), { mods: [], key: "Up" });
  assert.deepEqual(parseKeys("ctrl+c"), { mods: ["ctrl"], key: "c" });
});

test("key action maps to a send_key_state down/up pair, not wtype", () => {
  // wtype is not usable for this: its virtual keyboard appearing while the triggering key is still
  // physically held destroys that key's release edge, so a hold or repeat action leaves the key
  // stuck until timing.stuckMs. Measured on the host 2026-10-07 against the real remote and
  // reproduced with an injected 2000ms press; a Hyprland-native dispatch in the same position keeps
  // the release. Omarchy's own clipboard bindings avoid wtype for the same class of reason
  // ("the physically held SUPER merges into the injected chord at the seat").
  assert.deepEqual(toArgv({ type: "key", keys: "ctrl+shift+Return" }), {
    kind: "keyseq",
    down: 'hl.dsp.send_key_state({ mods = "CTRL SHIFT", key = "Return", state = "down" })',
    up: 'hl.dsp.send_key_state({ mods = "CTRL SHIFT", key = "Return", state = "up" })',
  });
  // mods is REQUIRED by the dispatcher -- omitting it answers "hl.send_key_state: 'mods' is
  // required" -- so the no-modifier case is an empty string, not an absent field. Verified live.
  assert.deepEqual(toArgv({ type: "key", keys: "Up" }), {
    kind: "keyseq",
    down: 'hl.dsp.send_key_state({ mods = "", key = "Up", state = "down" })',
    up: 'hl.dsp.send_key_state({ mods = "", key = "Up", state = "up" })',
  });
});

test("dispatch action is a Hyprland dispatch string, no process", () => {
  assert.deepEqual(toArgv({ type: "dispatch", dispatcher: "workspace", arg: "e+1" }), { kind: "dispatch", cmd: "workspace e+1" });
  assert.deepEqual(toArgv({ type: "dispatch", dispatcher: "fullscreen" }), { kind: "dispatch", cmd: "fullscreen" });
});

test("volume, media and screen map to documented tools", () => {
  assert.deepEqual(toArgv({ type: "volume", delta: "+5" }).argv, ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%+"]);
  assert.deepEqual(toArgv({ type: "volume", delta: "-5" }).argv, ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"]);
  assert.deepEqual(toArgv({ type: "volume", delta: "mute" }).argv, ["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"]);
  assert.deepEqual(toArgv({ type: "media", cmd: "play-pause" }).argv, ["playerctl", "play-pause"]);
  assert.deepEqual(toArgv({ type: "screen", cmd: "off" }).argv, ["hyprctl", "dispatch", "dpms", "off"]);
  assert.deepEqual(toArgv({ type: "screen", cmd: "lock" }).argv, ["omarchy-lock-screen"]);
  assert.deepEqual(toArgv({ type: "none" }), { kind: "none" });
});

test("invalid actions are rejected by validateAction and mapped to none", () => {
  assert.ok(validateAction({ type: "shell", cmd: "rm" }).length > 0);
  assert.ok(validateAction({ type: "key", keys: "" }).length > 0);
  assert.deepEqual(toArgv({ type: "shell", cmd: "rm" }), { kind: "none" });
});

test("describe gives a short human label", () => {
  assert.equal(describe({ type: "key", keys: "ctrl+c" }), "Ctrl+C");
  assert.equal(describe({ type: "dispatch", dispatcher: "workspace", arg: "e+1" }), "workspace e+1");
  assert.equal(describe({ type: "volume", delta: "+5" }), "Volume +5");
  assert.equal(describe({ type: "screen", cmd: "lock" }), "Lock screen");
});
