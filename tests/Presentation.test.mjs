import { test } from "node:test";
import assert from "node:assert/strict";
import { elapsedText, keyLabel, flashText, glyphLook, hudLine, micStatusLine, keysFromQtEvent } from "../lib/Presentation.mjs";

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
