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
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
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

// ---- Fix round 1 regressions: ---------------------------------------------------------------
// review findings on paths the 16 tests above do not cover, each ruled against spec §3.

test("a deferred rollback holds the shared gate for its whole run, not just the initial apply", () => {
  const { voice, mic } = ready();
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);          // set issued, not yet exited
  mic.reset(2);
  assert.equal(voice.gate.busy(), false);                                  // failed op released the gate; nothing runs yet
  const after = mic.cmdExit(cmdId(set, "set"), 0, "", 20);                // set exits 0 -> deferred rollback resumes, expecting "N" on disk
  assert.deepEqual(kinds(after), ["get"]);
  assert.equal(voice.gate.busy(), true);                                   // the rollback holds the gate from here on
  assert.equal(voice.gate.acquire("someone-else"), false);
  const rb = mic.cmdExit(cmdId(after, "get"), 0, JSON.stringify({ value: "N", file_value: "N" }), 21);  // the write really landed
  assert.deepEqual(byType(rb, "cmd")[0].argv, ["voxtype", "config", "unset", "audio.device"]);
  assert.equal(voice.gate.busy(), true);
  const restart = mic.cmdExit(cmdId(rb, "unset"), 0, "", 22);
  assert.deepEqual(kinds(restart), ["restart"]);
  assert.equal(voice.gate.busy(), true);
  const verify = mic.cmdExit(cmdId(restart, "restart"), 0, "", 23);
  assert.equal(byType(verify, "verify").length, 1);
  assert.equal(voice.gate.busy(), true);
  const done = mic.verifyResult(true, 24);
  assert.equal(byType(done, "done")[0].rollback, "verified");
  assert.equal(voice.gate.busy(), false);
  assert.equal(mic.pending(), false);
});

test("reset while the rollback unset is in flight also corrects the deferred expected literal", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  const chk = mic.verifyResult(false, 5000);                               // verify fails -> rollback entry
  const rb = mic.cmdExit(cmdId(chk, "get"), 0, JSON.stringify({ value: "N", file_value: "N" }), 5001);
  assert.deepEqual(byType(rb, "cmd")[0].argv, ["voxtype", "config", "unset", "audio.device"]);
  mic.reset(5002);                                                          // reset while the rollback unset is in flight
  assert.equal(mic.statusOf(result.operationId).rollback, "deferred");
  assert.deepEqual(kinds(mic.backend("idle", 5100, { fresh: true })), []); // unset still outstanding
  const resumed = mic.cmdExit(cmdId(rb, "unset"), 0, "", 5200);            // unset exits 0: deferred.expected corrected to null
  assert.deepEqual(kinds(resumed), ["get"]);                                 // deferred rollback re-checks for external edits
  const again = mic.cmdExit(cmdId(resumed, "get"), 0, JSON.stringify({ value: null, file_value: null }), 5201);
  assert.deepEqual(byType(again, "conflict"), []);                           // no false conflict
  assert.deepEqual(kinds(again), ["restart"]);                                // already at target; service still needs restoring
  const v = mic.cmdExit(cmdId(again, "restart"), 0, "", 5202);
  assert.equal(byType(v, "verify").length, 1);
  const done = mic.verifyResult(true, 6000);
  const d = byType(done, "done")[0];
  assert.equal(d.error, "verify-failed");                                  // original failure reason survives the deferred rollback
  assert.equal(d.rollback, "verified");
});

test("the 60s defer bound does not restart on a re-deferral", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  mic.reset(5);                                                             // first defer: deadline fixed at 5 + 60000 = 60005
  const resumed = mic.cmdExit(cmdId(set, "set"), 0, "", 20);                // set exits 0 -> deferred rollback resumes
  assert.deepEqual(kinds(resumed), ["get"]);
  const rb = mic.cmdExit(cmdId(resumed, "get"), 0, JSON.stringify({ value: "N", file_value: "N" }), 21);
  assert.deepEqual(byType(rb, "cmd")[0].argv, ["voxtype", "config", "unset", "audio.device"]);
  mic.systemdJob(true, 22);                                                 // a job appears right before the rollback restart
  const redeferred = mic.cmdExit(cmdId(rb, "unset"), 0, "", 23);            // re-deferred: must keep the original deadline
  assert.equal(byType(redeferred, "done")[0].rollback, "deferred");
  assert.equal(mic.nextDeadline(), 60005);
  const u = mic.advance(60005);
  assert.equal(byType(u, "unconfigured")[0].reason, "mic change unresolved");
  assert.equal(mic.statusOf(result.operationId).rollback, "unresolved");
});

test("a stale command from a reset operation cannot be misdispatched as the next operation's phase", () => {
  const { mic } = ready();
  const { effects, result: r1 } = mic.request("remote", 0, { nodeName: "N" });
  mic.reset(1);                                                            // failed while the get is still in flight, no mutation
  assert.equal(mic.statusOf(r1.operationId).state, "failed");
  const { effects: e2, result: r2 } = mic.request("system", 2, {});        // accepted, but must wait for the stale get to drain
  assert.deepEqual(kinds(e2), []);
  assert.equal(mic.statusOf(r2.operationId).state, "queued");
  const stale = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 3);         // the first op's get finally exits
  assert.deepEqual(kinds(stale), ["get"]);                                 // draining kicks the new op's own get immediately, never a `set`
  assert.equal(mic.statusOf(r2.operationId).state, "applying");
  assert.equal(mic.statusOf(r2.operationId).phase, "get");
  assert.deepEqual(kinds(mic.advance(4)), []);                             // nothing further until that get exits
  const set = mic.cmdExit(cmdId(stale, "get"), 0, GET_OUT, 5);
  assert.deepEqual(byType(set, "cmd")[0].argv, ["voxtype", "config", "set", "audio.device", "default"]);
  assert.equal(mic.statusOf(r2.operationId).state, "applying");
});

test("rollback after a failed set finds the file untouched and finishes without any write", () => {
  const { mic } = ready();
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
  const rb = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const chk = mic.cmdExit(cmdId(rb, "set"), 1, "", 2);                     // config set itself fails: file never touched
  assert.deepEqual(kinds(chk), ["get"]);                                   // rollback still starts with the conflict check
  const done = mic.cmdExit(cmdId(chk, "get"), 0, GET_OUT, 3);              // file still holds the original (absent) literal
  assert.deepEqual(kinds(done), []);                                       // no set/unset/restart: nothing to undo
  assert.deepEqual(byType(done, "conflict"), []);
  const d = byType(done, "done")[0];
  assert.equal(d.state, "failed");
  assert.equal(d.error, "set-failed");
  assert.equal(d.rollback, "verified");
});

test("a reset mid rollback-restart re-verifies without re-writing, keeping the original error", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  const chk = mic.verifyResult(false, 5000);                               // verify fails -> rollback entry
  const rb = mic.cmdExit(cmdId(chk, "get"), 0, JSON.stringify({ value: "N", file_value: "N" }), 5001);
  const restart2 = mic.cmdExit(cmdId(rb, "unset"), 0, "", 5002);           // rollback-restart issued
  assert.deepEqual(kinds(restart2), ["restart"]);
  mic.reset(5003);                                                          // reset while that restart is in flight
  assert.equal(mic.statusOf(result.operationId).rollback, "deferred");
  assert.deepEqual(kinds(mic.backend("idle", 5100, { fresh: true })), []); // restart still outstanding
  const resumed = mic.cmdExit(cmdId(restart2, "restart"), 0, "", 5200);    // stale restart drains; deferred rollback resumes
  assert.deepEqual(kinds(resumed), ["get"]);                                 // re-checks for external edits first
  const again = mic.cmdExit(cmdId(resumed, "get"), 0, JSON.stringify({ value: null, file_value: null }), 5201);
  assert.deepEqual(kinds(again), ["restart"]);                               // file already reverted: exactly one further restart
  const v = mic.cmdExit(cmdId(again, "restart"), 0, "", 5202);
  assert.equal(byType(v, "verify").length, 1);
  const done = mic.verifyResult(true, 6000);
  const d = byType(done, "done")[0];
  assert.equal(d.error, "verify-failed");                                  // original failure reason survives the deferred rollback
  assert.equal(d.rollback, "verified");
});

test("a systemd job discovered right after the preflight read blocks the set with no mutation", () => {
  const { voice, mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  mic.systemdJob(true, 1);
  const fx = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 2);
  assert.deepEqual(kinds(fx), []);
  assert.equal(byType(fx, "done")[0].error, "job-pending");
  assert.equal(mic.statusOf(result.operationId).state, "failed");
  assert.equal(voice.gate.busy(), false);
});

test("a systemd job discovered right before the apply restart defers rollback instead of racing it", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const fx = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  mic.systemdJob(true, 2);
  const done = mic.cmdExit(cmdId(fx, "set"), 0, "", 3);
  assert.deepEqual(kinds(done), []);                                       // no restart raced the job
  assert.equal(byType(done, "done")[0].rollback, "deferred");
  assert.equal(mic.pending(), true);
  const resumed = mic.systemdJob(false, 100);                              // job clears; backend view still fresh from ready()
  assert.deepEqual(kinds(resumed), ["get"]);                                 // deferred rollback resumes with its own conflict check
  const rb = mic.cmdExit(cmdId(resumed, "get"), 0, JSON.stringify({ value: "N", file_value: "N" }), 101);
  assert.deepEqual(byType(rb, "cmd")[0].argv, ["voxtype", "config", "unset", "audio.device"]);
  const restart2 = mic.cmdExit(cmdId(rb, "unset"), 0, "", 102);
  assert.deepEqual(kinds(restart2), ["restart"]);
  const verify2 = mic.cmdExit(cmdId(restart2, "restart"), 0, "", 103);
  assert.equal(byType(verify2, "verify").length, 1);
  assert.equal(mic.statusOf(result.operationId).state, "rollingBack");
});

test("a systemd job discovered at verify failure defers rollback without reading first", () => {
  const { mic } = ready();
  const { effects } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  mic.systemdJob(true, 4);
  const fx = mic.verifyResult(false, 100);
  assert.deepEqual(kinds(fx), []);                                          // no get/unset/restart issued while the job is live
  assert.equal(byType(fx, "done")[0].rollback, "deferred");
  assert.equal(mic.pending(), true);
});

test("a verify report is correlated to the outstanding verify only", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);
  const restart = mic.cmdExit(cmdId(set, "set"), 0, "", 2);
  const verified = mic.cmdExit(cmdId(restart, "restart"), 0, "", 3);
  const firstVerifyId = byType(verified, "verify")[0].id;
  assert.ok(firstVerifyId);
  const timedOut = mic.advance(3 + 10000);                                 // apply verify times out -> rollback begins
  assert.deepEqual(kinds(timedOut), ["get"]);
  const rb = mic.cmdExit(cmdId(timedOut, "get"), 0, JSON.stringify({ value: "N", file_value: "N" }), 10004);
  const rbRestart = mic.cmdExit(cmdId(rb, "unset"), 0, "", 10005);
  const rbVerified = mic.cmdExit(cmdId(rbRestart, "restart"), 0, "", 10006);
  const secondVerifyId = byType(rbVerified, "verify")[0].id;
  assert.ok(secondVerifyId);
  assert.notEqual(secondVerifyId, firstVerifyId);
  const stale = mic.verifyResult(true, 20000, firstVerifyId);              // the long-dead apply verify reports back late
  assert.deepEqual(stale, []);
  assert.equal(mic.statusOf(result.operationId).state, "rollingBack");     // ignored: the rollback verify is still outstanding
  const done = mic.verifyResult(true, 20001, secondVerifyId);
  assert.equal(byType(done, "done")[0].rollback, "verified");
  assert.equal(mic.statusOf(result.operationId).state, "failed");
});

// ---- Ruling 17: tryReserve/tryDeferred re-request backend freshness while otherwise unblocked ----

test("a request blocked by a systemd job re-polls for backend freshness once the job clears", () => {
  const { mic } = ready();
  mic.systemdJob(true, 0);
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  assert.deepEqual(kinds(effects), []);
  const stillBlocked = mic.advance(3000);                    // job still pending: no poll yet
  assert.deepEqual(kinds(stillBlocked), []);
  assert.equal(byType(stillBlocked, "poll").length, 0);
  const cleared = mic.systemdJob(false, 3000);               // job clears, but the ready() backend view (t=0) is now stale
  assert.deepEqual(kinds(cleared), []);
  assert.equal(byType(cleared, "poll").length, 1);
  const go = mic.backend("idle", 3010, { fresh: true });     // fresh answer -> reservation proceeds, no wait-timeout
  assert.deepEqual(kinds(go), ["get"]);
  assert.equal(mic.statusOf(result.operationId).state, "applying");
});

test("a deferred rollback blocked only on backend freshness re-polls, then proceeds once fresh, rate-limited to one poll per window", () => {
  const { mic } = ready();
  const { effects, result } = mic.request("remote", 0, { nodeName: "N" });
  const set = mic.cmdExit(cmdId(effects, "get"), 0, GET_OUT, 1);           // set issued, not yet exited
  mic.reset(2);                                                            // op mutated -> deferred, gate released
  const resumed = mic.cmdExit(cmdId(set, "set"), 0, "", 900);              // set exits 0, well past the ready() fresh window
  assert.deepEqual(kinds(resumed), []);                                    // blocked on freshness alone: no get yet
  assert.equal(byType(resumed, "poll").length, 1);                         // ...but the block is no longer silent
  const stillWaiting = mic.advance(1000);                                  // 100ms later: rate-limited, no second poll
  assert.deepEqual(kinds(stillWaiting), []);
  assert.equal(byType(stillWaiting, "poll").length, 0);
  const go = mic.backend("idle", 1000, { fresh: true });                   // fresh answer -> deferred rollback starts
  assert.deepEqual(kinds(go), ["get"]);
  assert.equal(mic.statusOf(result.operationId).state, "rollingBack");
});
