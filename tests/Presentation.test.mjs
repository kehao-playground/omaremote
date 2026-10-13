import { test } from "node:test";
import assert from "node:assert/strict";
import { elapsedText, keyLabel, flashText, glyphLook, hudLine, micStatusLine, keysFromQtEvent, hidMicLine, keyboardSourceLine, typelessView, engineStatusLine, TYPELESS_FLASH } from "../lib/Presentation.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";

test("elapsedText formats mm:ss and clamps negatives", () => {
  assert.equal(elapsedText(4000), "00:04");
  assert.equal(elapsedText(61999), "01:01");
  assert.equal(elapsedText(-5), "00:00");
});

test("flashText names key, trigger and action", () => {
  assert.equal(flashText("ok", "hold", { type: "key", keys: "ctrl+c" }), "OK · hold → Ctrl+C");
  assert.equal(flashText("volup", "tap", { type: "volume", delta: "+5" }), "Vol+ · tap → Volume +5");
  assert.equal(keyLabel("unknown"), "unknown");
});

test("glyphLook precedence: self-test > busy > recording > transcribing > pending > unconfigured > disconnected > ready", () => {
  assert.equal(glyphLook({ selftest: true, voiceState: "recording" }), "selftest");
  assert.equal(glyphLook({ voiceState: "recovering", remoteState: "disconnected" }), "busy");
  assert.equal(glyphLook({ voiceState: "idle", micPending: true }), "busy");
  assert.equal(glyphLook({ voiceState: "recording", unconfigured: true }), "recording");
  assert.equal(glyphLook({ voiceState: "stopping" }), "transcribing");
  assert.equal(glyphLook({ voiceState: "transcribing" }), "transcribing");
  assert.equal(glyphLook({ voiceState: "arbitrating" }), "pending");
  assert.equal(glyphLook({ voiceState: "starting" }), "pending");
  assert.equal(glyphLook({ voiceState: "unconfigured" }), "unconfigured");
  assert.equal(glyphLook({ voiceState: "idle", unconfigured: true }), "unconfigured");
  assert.equal(glyphLook({ voiceState: "idle", remoteState: "disconnected" }), "disconnected");
  assert.equal(glyphLook({ voiceState: "idle", remoteState: "absent" }), "disconnected");
  assert.equal(glyphLook({ voiceState: "idle", remoteState: "connected" }), "ready");
});

test("hudLine: flash wins, recording shows the timer, transcribing is fixed text, else the session text", () => {
  assert.equal(hudLine({ voiceState: "recording", elapsedMs: 4000, flash: "OK · hold → Ctrl+C" }), "OK · hold → Ctrl+C");
  assert.equal(hudLine({ voiceState: "recording", elapsedMs: 4000, hudText: "recording" }), "● 00:04");
  assert.equal(hudLine({ voiceState: "recording", elapsedMs: 4000, hudText: "mic change applies after this dictation" }), "● 00:04 · mic change applies after this dictation");   // §3 step 1
  assert.equal(hudLine({ voiceState: "transcribing", hudText: "recording" }), "… transcribing");
  assert.equal(hudLine({ voiceState: "starting", hudText: "starting…" }), "starting…");
  assert.equal(hudLine({ voiceState: "idle", hudText: "" }), "");
});

test("micStatusLine renders queued/applying/failed with rollback", () => {
  assert.equal(micStatusLine(null), "");
  assert.equal(micStatusLine({ state: "queued" }), "queued");
  assert.equal(micStatusLine({ state: "failed", error: "restart-failed", rollback: "verified" }), "failed: restart-failed (rollback: verified)");
  assert.equal(micStatusLine({ state: "succeeded" }), "succeeded");
});

test("keysFromQtEvent maps Qt key codes and modifiers to wtype keysyms", () => {
  const CTRL = 0x04000000, SHIFT = 0x02000000, ALT = 0x08000000, SUPER = 0x10000000;
  assert.equal(keysFromQtEvent(0x01000004, 0, "\r"), "Return");
  assert.equal(keysFromQtEvent(0x43, CTRL | SHIFT, ""), "ctrl+shift+c");
  assert.equal(keysFromQtEvent(0x41, ALT | SUPER, "a"), "alt+super+a");
  assert.equal(keysFromQtEvent(0x01000030, 0, ""), "F1");
  assert.equal(keysFromQtEvent(0x0100003b, 0, ""), "F12");
  assert.equal(keysFromQtEvent(0x20, 0, " "), "space");
  assert.equal(keysFromQtEvent(0x01000021, CTRL, ""), null);       // bare Control
  assert.equal(keysFromQtEvent(0x01000020, SHIFT, ""), null);      // bare Shift
  assert.equal(keysFromQtEvent(0x2e, 0, "."), ".");
  assert.equal(keysFromQtEvent(0x01ffffff, 0, ""), null);          // Key_unknown
});

const pcfg = (voice = {}, mic = {}) => normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, ...voice }, keys: { ...DEFAULT_CONFIG.keys, mic: { ...DEFAULT_CONFIG.keys.mic, ...mic } } }).config;

test("hidMicLine: remote mode ignores the key whatever its trigger; system mode reports the trigger", () => {
  assert.equal(hidMicLine(pcfg({ mic: "remote" })), "ignored in remote mode — hold the remote's mic button to talk");
  assert.equal(hidMicLine(pcfg({ mic: "remote" }, { trigger: "ptt" })), "ignored in remote mode — hold the remote's mic button to talk");
  assert.equal(hidMicLine(pcfg({ mic: "system" })), "toggle (press to start, press again to stop)");
  assert.equal(hidMicLine(pcfg({ mic: "system" }, { trigger: "ptt" })), "push-to-talk");
  assert.equal(hidMicLine(pcfg({ mic: "system" }, { trigger: "key" })), "not available");
  assert.equal(hidMicLine(pcfg({ mic: "system" }, { supported: false })), "not available");
  assert.equal(hidMicLine(null), "");
});

test("keyboardSourceLine warns that F9 is silent in remote mode without on-demand", () => {
  assert.equal(keyboardSourceLine(pcfg({ mic: "remote" })), "observed — no audio in remote mode unless the remote's mic button is held; use system mode for F9");
  assert.equal(keyboardSourceLine(pcfg({ mic: "remote", remoteOnDemand: true })), "observed");
  assert.equal(keyboardSourceLine(pcfg({ mic: "system" })), "observed");
});

// ---- Typeless engine (Typeless spec §6.3) ----
test("typelessView: recording while on or a start is in flight, a warning while unsynced, idle otherwise and in system mode", () => {
  const snap = (o) => Object.assign({ mode: "remote", typeless: "off", outstanding: null }, o);
  assert.equal(typelessView(null), "idle");
  assert.equal(typelessView(snap({})), "idle");
  assert.equal(typelessView(snap({ outstanding: { id: 1, kind: "start" } })), "recording");
  assert.equal(typelessView(snap({ typeless: "on" })), "recording");
  assert.equal(typelessView(snap({ typeless: "on", outstanding: { id: 2, kind: "stop" } })), "recording", "a stop in flight keeps the display");
  assert.equal(typelessView(snap({ typeless: "unsynced", outstanding: { id: 3, kind: "start" } })), "unsynced");
  assert.equal(typelessView(snap({ mode: "system", outstanding: { id: 1, kind: "press" } })), "idle");
});

test("glyphLook and hudLine show Typeless recording and the unsynced warning", () => {
  assert.equal(glyphLook({ voiceState: "idle", typeless: "recording" }), "recording");
  assert.equal(glyphLook({ voiceState: "idle", typeless: "unsynced" }), "warning");
  assert.equal(glyphLook({ voiceState: "idle", typeless: "idle" }), "ready");
  assert.equal(glyphLook({ voiceState: "idle", typeless: "recording", selftest: true }), "selftest", "a self-test still wins");
  assert.equal(hudLine({ voiceState: "idle", typeless: "recording", elapsedMs: 12000, hudText: "" }), "● Typeless 00:12");
  assert.equal(hudLine({ voiceState: "idle", typeless: "recording", elapsedMs: 0, hudText: "max session reached" }), "● Typeless 00:00 · max session reached");
  assert.equal(hudLine({ voiceState: "idle", typeless: "recording", elapsedMs: 0, flash: "Typeless ⏯" }), "Typeless ⏯");
  assert.equal(hudLine({ voiceState: "idle", typeless: "unsynced", hudText: "Typeless state unknown — check Typeless; press reset when it is stopped" }),
               "Typeless state unknown — check Typeless; press reset when it is stopped");
});

test("engineStatusLine reports the hotkey and whether keytap runs", () => {
  const c = normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, engine: "typeless", typeless: { hotkey: "RightAlt+RightShift" } } }).config;
  assert.equal(engineStatusLine(c, null), "hotkey: RightAlt+RightShift · keytap: unknown");
  assert.equal(engineStatusLine(c, { typeless: { keytapActive: true, keytapDevice: true } }), "hotkey: RightAlt+RightShift · keytap: running");
  assert.equal(engineStatusLine(c, { typeless: { keytapActive: true, keytapDevice: false } }), "hotkey: RightAlt+RightShift · keytap: not running");
  assert.equal(engineStatusLine(c, { typeless: { keytapActive: false, keytapDevice: false } }), "hotkey: RightAlt+RightShift · keytap: not running");
  assert.equal(TYPELESS_FLASH, "Typeless ⏯");
});

test("review: under Typeless a Voxtype that is not responding does not make the bar unconfigured", () => {
  assert.equal(glyphLook({ voiceState: "unconfigured", engine: "typeless" }), "ready");
  assert.equal(glyphLook({ voiceState: "unconfigured", engine: "voxtype" }), "unconfigured");
  assert.equal(glyphLook({ voiceState: "unconfigured", engine: "typeless", unconfigured: true }), "unconfigured", "a real Typeless problem still shows");
  assert.equal(glyphLook({ voiceState: "recording", engine: "typeless" }), "recording", "an F9 dictation still shows");
});
