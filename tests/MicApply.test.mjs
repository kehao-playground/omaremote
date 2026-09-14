import { test } from "node:test";
import assert from "node:assert/strict";
import { createMicApply, parseConfigGet } from "../lib/MicApply.mjs";
import { createVoiceSession } from "../lib/VoiceSession.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";
import { byType } from "./helpers.mjs";

const kinds = (fx) => byType(fx, "cmd").map(c => c.kind);
const cmdId = (fx, kind) => byType(fx, "cmd").find(c => c.kind === kind).id;
const GET_OUT = JSON.stringify({ key: "audio.device", value: "default", file_value: null });

function ready() {
  const voice = createVoiceSession(normalizeConfig(DEFAULT_CONFIG).config);
  voice.status("idle", 0, { fresh: true });
  const mic = createMicApply({ voice });
  mic.backend("idle", 0, { fresh: true });
  return { voice, mic };
}

test("parseConfigGet distinguishes absent literal from a set one", () => {
  assert.deepEqual(parseConfigGet(GET_OUT), { effective: "default", literal: null, literalKnown: true });
  assert.deepEqual(parseConfigGet(JSON.stringify({ value: "G20S PRO", file_value: "G20S PRO" })), { effective: "G20S PRO", literal: "G20S PRO", literalKnown: true });
  assert.equal(parseConfigGet(JSON.stringify({ value: "x" })).literalKnown, false);
  assert.equal(parseConfigGet("garbage").literalKnown, false);
});

test("happy path: get -> set -> restart -> verify -> commit -> succeeded, gate released", () => {
  const { voice, mic } = ready();
  const { effects, result } = mic.request("remote", 10, { nodeName: "G20S PRO" });
  assert.equal(result.ok, true);
  assert.deepEqual(kinds(effects), ["get"]);
  assert.deepEqual(byType(effects, "cmd")[0].argv, ["voxtype", "config", "get", "audio.device", "--json"]);
  assert.equal(voice.gate.busy(), true);
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 20);
  assert.deepEqual(byType(set, "cmd")[0].argv, ["voxtype", "config", "set", "audio.device", "G20S PRO"]);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 30);
  assert.deepEqual(byType(restart, "cmd")[0].argv, ["systemctl", "--user", "restart", "voxtype"]);
  const verify = mic.cmdExit(cmdId(restart, "restart"), 0, "", 40);
  assert.equal(byType(verify, "verify").length, 1);
  assert.equal(mic.statusOf(result.operationId).state, "verifying");
  assert.equal(mic.nextDeadline(), 40 + 10000);
  const done = mic.verifyResult(true, 2000);
  assert.deepEqual(byType(done, "commit"), [{ type: "commit", mode: "remote" }]);
  assert.equal(byType(done, "done")[0].state, "succeeded");
  assert.equal(mic.statusOf(result.operationId).state, "succeeded");
  assert.equal(voice.gate.busy(), false);
  assert.equal(mic.pending(), false);
});

test("second request while one is pending is busy; invalid mode and missing node are rejected", () => {
  const { mic } = ready();
  assert.equal(mic.request("remote", 0, { nodeName: "N" }).result.ok, true);
  assert.deepEqual(mic.request("system", 1, {}).result, { ok: false, reason: "busy" });
  const { mic: m2 } = ready();
  assert.deepEqual(m2.request("wifi", 0, {}).result, { ok: false, reason: "invalid-mode" });
  assert.deepEqual(m2.request("remote", 0, {}).result, { ok: false, reason: "no-node" });
});

test("waits without mutation while the session is busy; 60s timeout fails with nothing to roll back", () => {
  const { voice, mic } = ready();
  voice.hidPress(0); voice.status("recording", 50);
  const { effects, result } = mic.request("system", 100, {});
  assert.deepEqual(kinds(effects), []);
  assert.ok(byType(effects, "hud").some(h => /applies after this dictation/.test(h.text)));
  assert.equal(mic.statusOf(result.operationId).state, "queued");
  const fx = mic.advance(60100);
  assert.equal(byType(fx, "done")[0].state, "failed");
  assert.equal(byType(fx, "done")[0].error, "wait-timeout");
  assert.deepEqual(kinds(fx), []);
});

test("once the session goes idle a queued request needs a fresh backend idle, then proceeds", () => {
  const { voice, mic } = ready();
  const st = voice.hidPress(0); voice.cmdExit(cmdId(st, "start"), 0, 10); voice.status("recording", 50);
  const { result } = mic.request("system", 100, {});
  const sp = voice.hidRelease(200); voice.cmdExit(cmdId(sp, "stop"), 0, 210);
  voice.status("transcribing", 250); voice.status("idle", 1400);
  const p = mic.advance(1401);                                  // session idle, but our backend view (t=0) is stale -> poll
  assert.equal(byType(p, "poll").length, 1);
  const go = mic.backend("idle", 1450, { fresh: true });
  assert.deepEqual(kinds(go), ["get"]);
  assert.equal(mic.statusOf(result.operationId).state, "applying");
});

test("verify failure rolls back with unset when the old literal was absent, then reports failed", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  const chk = mic.verifyResult(false, 5000);
  assert.deepEqual(kinds(chk), ["get"]);                         // re-read before touching the file
  assert.equal(mic.statusOf(result.operationId).state, "rollingBack");
  const rb = mic.cmdExit(cmdId(chk, "get"), 0, JSON.stringify({ value: "N", file_value: "N" }), 5000);
  assert.deepEqual(byType(rb, "cmd")[0].argv, ["voxtype", "config", "unset", "audio.device"]);
  const r2 = mic.cmdExit(cmdId(rb, "unset"), 0, "", 5001);
  const v2 = mic.cmdExit(cmdId(r2, "restart"), 0, "", 5002);
  assert.equal(byType(v2, "verify").length, 1);
  const done = mic.verifyResult(true, 6000);
  const d = byType(done, "done")[0];
  assert.equal(d.state, "failed");
  assert.equal(d.error, "verify-failed");
  assert.equal(d.rollback, "verified");
  assert.equal(byType(done, "commit").length, 0);
});

test("rollback restores a previous literal with set; rollback verify failure is unconfigured", () => {
  const { mic } = ready();
  const { effects } = mic.request("system", 0, {});
  const set = mic.cmdExit(cmdId(effects, "get"), 0, JSON.stringify({ value: "G20S PRO", file_value: "G20S PRO" }), 1);
  assert.deepEqual(byType(set, "cmd")[0].argv, ["voxtype", "config", "set", "audio.device", "default"]);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  const chk = mic.verifyResult(false, 100);
  const rb = mic.cmdExit(cmdId(chk, "get"), 0, JSON.stringify({ value: "default", file_value: "default" }), 100);
  assert.deepEqual(byType(rb, "cmd")[0].argv, ["voxtype", "config", "set", "audio.device", "G20S PRO"]);
  const r2 = mic.cmdExit(cmdId(rb, "set"), 0, "", 101);
  mic.cmdExit(cmdId(r2, "restart"), 0, "", 102);
  const bad = mic.verifyResult(false, 200);
  assert.equal(byType(bad, "unconfigured")[0].reason, "voxtype restart failed");
  assert.equal(byType(bad, "done")[0].rollback, "failed");
});

test("verify timeout behaves like a failed verify", () => {
  const { mic } = ready();
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  const fx = mic.advance(3 + 10000);
  assert.deepEqual(kinds(fx), ["get"]);                           // rollback begins with the conflict check
});

test("rollback refuses to overwrite an external edit: conflict, no mutation, Doctor reconciles", () => {
  const { mic, voice } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  const chk = mic.verifyResult(false, 100);
  const fx = mic.cmdExit(cmdId(chk, "get"), 0, JSON.stringify({ value: "other", file_value: "other" }), 101);
  assert.deepEqual(kinds(fx), []);
  assert.deepEqual(byType(fx, "conflict"), [{ type: "conflict", expected: "N", found: "other" }]);
  const d = byType(fx, "done")[0];
  assert.equal(d.state, "failed"); assert.equal(d.rollback, "conflict");
  assert.equal(mic.statusOf(result.operationId).rollback, "conflict");
  assert.equal(voice.gate.busy(), false);
});

test("a pending systemd job blocks the initial mutation until it clears", () => {
  const { mic } = ready();
  mic.systemdJob(true, 0);
  const { effects, result } = mic.request("remote", 1, { nodeName: "N" });
  assert.deepEqual(kinds(effects), []);
  assert.equal(mic.statusOf(result.operationId).state, "queued");
  assert.deepEqual(kinds(mic.systemdJob(false, 100)), ["get"]);
  assert.equal(mic.statusOf(result.operationId).phase, "get");
});

test("get failure or unparsable output fails before any mutation", () => {
  const { mic, voice } = ready();
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
  const fx = mic.cmdExit(cmdId(effects, "get"), 0, "not json", 1);
  assert.equal(byType(fx, "done")[0].error, "preflight-failed");
  assert.deepEqual(kinds(fx), []);
  assert.equal(voice.gate.busy(), false);
});

test("reset while queued fails without mutation", () => {
  const { voice, mic } = ready();
  const st = voice.hidPress(0); voice.cmdExit(cmdId(st, "start"), 0, 5); voice.status("recording", 50);
  const { result } = mic.request("system", 100, {});
  const fx = mic.reset(150);
  assert.equal(byType(fx, "done")[0].error, "reset");
  assert.deepEqual(kinds(fx), []);
  assert.equal(mic.statusOf(result.operationId).state, "failed");
  assert.equal(mic.pending(), false);
});

test("reset while the set command is in flight: failed now, rollback deferred until set exits and backend is idle", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);          // set issued, not yet exited
  const rs = mic.reset(2);
  assert.equal(byType(rs, "done")[0].rollback, "deferred");
  assert.equal(mic.statusOf(result.operationId).state, "failed");
  assert.deepEqual(kinds(mic.backend("idle", 10, { fresh: true })), []);  // set still outstanding
  const after = mic.cmdExit(cmdId(set, "set"), 0, "", 20);
  assert.deepEqual(kinds(after), ["get"]);                                  // no apply step continues; deferred rollback starts with the conflict check
  assert.equal(mic.statusOf(result.operationId).state, "rollingBack");      // status reflects the live rollback of the failed operation
  assert.equal(mic.pending(), true);
});

test("reset while the restart is in flight never launches a second restart", () => {
  const { mic } = ready();
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);                // restart issued
  mic.reset(3);
  assert.deepEqual(kinds(mic.backend("idle", 100, { fresh: true })), []);  // restart still running
  const rb = mic.cmdExit(cmdId(restart, "restart"), 0, "", 200);          // restart exited, backend fresh -> rollback may begin
  assert.deepEqual(kinds(rb), ["get"]);
  const r2 = mic.cmdExit(cmdId(rb, "get"), 0, JSON.stringify({ value: "N", file_value: "N" }), 211);
  assert.deepEqual(kinds(r2), ["unset"]);
  const r3 = mic.cmdExit(cmdId(r2, "unset"), 0, "", 212);
  assert.deepEqual(kinds(r3), ["restart"]);                                 // exactly one rollback restart
});

test("a live systemd job blocks the deferred rollback until it clears; the 60s bound ends unresolved", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);                          // client exited; job may still be live
  mic.systemdJob(true, 4);
  mic.reset(5);
  assert.deepEqual(kinds(mic.backend("idle", 100, { fresh: true })), []);
  assert.deepEqual(kinds(mic.systemdJob(false, 700)), []);                  // job cleared, but the idle view is stale now
  assert.deepEqual(kinds(mic.backend("idle", 710, { fresh: true })), ["get"]);

  const { mic: m2 } = ready();
  const { effects: e2, result: r2 } = m2.request("remote", 0, { nodeName: "N" });
  const s2 = m2.cmdExit(cmdId(e2, "get"), 0, GET_OUT, 1);
  m2.cmdExit(cmdId(s2, "set"), 0, "", 2);
  m2.systemdJob(true, 3);
  m2.reset(4);
  const u = m2.advance(4 + 60000);
  assert.equal(byType(u, "unconfigured")[0].reason, "mic change unresolved");
  assert.equal(m2.statusOf(r2.operationId).rollback, "unresolved");
  void result;
});

test("external recording during apply interrupts; 60s without a quiet system ends unresolved", () => {
  const { mic } = ready();
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  const fx = mic.externalRecording(10);
  assert.equal(byType(fx, "done")[0].error, "interrupted");
  assert.equal(byType(fx, "done")[0].rollback, "deferred");
  const u = mic.advance(10 + 60000);
  assert.equal(byType(u, "unconfigured")[0].reason, "mic change unresolved");
});
