// Spec §3 "Mic apply contract": wait → reserve+snapshot → apply+restart → verify → commit, with rollback,
// reset priority, deferred rollback, systemd-job serialization and external-edit conflict detection.
const WAIT_MS = 60000, VERIFY_MS = 10000, DEFER_MS = 60000, FRESH_MS = 500;
const MODES = ["remote", "system"];

export function parseConfigGet(stdout) {
  let j;
  try { j = JSON.parse(String(stdout || "")); } catch (e) { return { effective: null, literal: null, literalKnown: false }; }
  if (!j || typeof j !== "object") return { effective: null, literal: null, literalKnown: false };
  const effective = j.value !== undefined ? j.value : (j.effective !== undefined ? j.effective : null);
  for (const k of ["file_value", "file", "literal"]) {
    if (Object.prototype.hasOwnProperty.call(j, k)) return { effective, literal: j[k] === undefined ? null : j[k], literalKnown: true };
  }
  return { effective, literal: null, literalKnown: false };
}

export function createMicApply({ voice }) {
  let op = null;                                  // current operation
  const history = new Map();                      // id -> final status
  let seq = 0, cmdSeq = 0, verifySeq = 0;
  const cmds = new Map();                         // id -> { kind, opId } — opId tags a command to the operation that issued it
  let backend = { cls: "unknown", at: -Infinity, fresh: false };
  let dl = {};
  let deferred = null;                            // { id, mode, prev, setValue, error, expected, serviceDirty, deferUntil } rollback waiting for a quiet system
  let jobPending = false;
  let jobAt = -Infinity;                          // time of the last systemdJob() reading (Fix round 1, Ruling 14)
  let lastPollAt = -Infinity;                     // §3: rate-limit the freshness re-poll shared by tryReserve/tryDeferred
  let lastShowAt = -Infinity;                     // §3: rate-limit the systemd-job re-read requested by tryReserve

  const hud = (out, text) => out.push({ type: "hud", text });
  // `writes` tags the literal (or null for unset) a command will leave on disk if it exits 0; get/restart
  // pass none (undefined) since they never write. Lets a command that outlives a defer still correct
  // `deferred.expected` when it finally exits — see the `!op` branch of cmdExit.
  const cmd = (out, kind, argv, writes) => { const id = ++cmdSeq; cmds.set(id, { kind, opId: op.id, writes }); out.push({ type: "cmd", id, kind, argv }); return id; };
  const restartArgv = ["systemctl", "--user", "restart", "voxtype"];
  const getArgv = ["voxtype", "config", "get", "audio.device", "--json"];
  const targetValue = (o) => (o.mode === "remote" ? o.nodeName : "default");
  const fresh = (now) => backend.cls === "idle" && backend.fresh && now - backend.at <= FRESH_MS;
  const setErrorOnce = (o, reason) => { if (o.error === undefined) o.error = reason; };  // the first failure reason survives a later reset/defer
  // §3: while every other precondition holds, re-request a fresh backend reading at most once per FRESH_MS
  // so a request blocked only on staleness (not on a job or the gate) is not left waiting for wait-timeout.
  const pollIfDue = (out, now) => { if (now - lastPollAt > FRESH_MS) { lastPollAt = now; out.push({ type: "poll" }); } };
  // Fix round 1 (Ruling 14): mirrors pollIfDue, but for the systemd job reading itself — tryReserve must
  // not act on a jobPending value that predates this operation's request (a `get` racing the verifier's
  // first `show` must not win); rate-limited the same way so a request blocked only on this is not left
  // silent until wait-timeout.
  const showIfDue = (out, now) => { if (now - lastShowAt > FRESH_MS) { lastShowAt = now; out.push({ type: "show" }); } };

  function record(id, state, extra) { history.set(id, Object.assign({ state: state, phase: null }, extra)); }

  function finish(out, state) {
    record(op.id, state, { mode: op.mode, error: op.error, rollback: op.rollback });
    out.push({ type: "done", operationId: op.id, state, error: op.error, rollback: op.rollback });
    voice.gate.release("mic-apply");
    dl = {};
    op = null;
  }

  // §3 reset priority: once a mutated operation can no longer continue in place (reset, external
  // recording, or a systemd job in the way of its next write), it fails now and its rollback is
  // deferred until the system is quiet — never left racing another restart. Shared by every such exit
  // so a job discovered mid-apply and a reset mid-apply are handled identically.
  function deferOp(out, now) {
    const until = op.deferUntil !== undefined ? op.deferUntil : now + DEFER_MS;  // §3: the 60s bound does not restart on a re-deferral
    deferred = { id: op.id, mode: op.mode, prev: op.prev, setValue: op.setValue, error: op.error, expected: op.expected, serviceDirty: op.serviceDirty, deferUntil: until };
    dl = { defer: until };
    record(op.id, "failed", { mode: op.mode, error: op.error, rollback: "deferred" });
    out.push({ type: "done", operationId: op.id, state: "failed", error: op.error, rollback: "deferred" });
    hud(out, "mic change interrupted");
    voice.gate.release("mic-apply");
    op = null;
  }

  function pushVerify(out, now) {                 // §3: verify reports are correlated to the outstanding verify only
    op.verifyId = `verify-${++verifySeq}`;
    out.push({ type: "verify", id: op.verifyId });
    dl.verify = now + VERIFY_MS;
  }

  function beginRollback(out) {                   // every rollback starts with the external-edit check
    op.state = "rollingBack"; op.phase = "rollback-get";
    hud(out, "restoring previous microphone");
    delete dl.verify;
    cmd(out, "get", getArgv);
  }

  function tryReserve(out, now) {
    if (!op || op.state !== "queued") return;
    if (cmds.size > 0) return;                                // wait for a stale command from a superseded operation to drain
    const s = voice.snapshot();
    if (s.state !== "idle" || s.pendingCmds > 0) return;
    if (jobPending) return;                                  // §3: never mutate while a systemd job is pending
    if (jobAt < op.requestedAt) { showIfDue(out, now); return; }  // §3/Ruling 14: the job reading must postdate this request
    if (!fresh(now)) { pollIfDue(out, now); return; }
    if (!voice.gate.acquire("mic-apply")) return;
    delete dl.wait;
    op.state = "applying"; op.phase = "get";
    hud(out, "changing microphone…");
    cmd(out, "get", getArgv);
  }

  function tryDeferred(out, now) {
    if (!deferred || op) return;
    if (cmds.size > 0 || jobPending || voice.snapshot().state !== "idle") return;
    if (!fresh(now)) { pollIfDue(out, now); return; }
    if (!voice.gate.acquire("mic-apply")) return;             // hold the gate for the whole deferred rollback, like any other apply
    const d = deferred; deferred = null; delete dl.defer;
    op = { id: d.id, mode: d.mode, state: "rollingBack", phase: null, prev: d.prev, setValue: d.setValue, mutated: true, error: d.error, rollback: undefined, expected: d.expected, serviceDirty: d.serviceDirty, deferUntil: d.deferUntil, verifyId: undefined };
    beginRollback(out);
  }

  return {
    request(mode, now, opts = {}) {
      const out = [];
      if (op || deferred) return { effects: out, result: { ok: false, reason: "busy" } };
      if (!MODES.includes(mode)) return { effects: out, result: { ok: false, reason: "invalid-mode" } };
      if (mode === "remote" && !opts.nodeName) return { effects: out, result: { ok: false, reason: "no-node" } };
      op = { id: `mic-${++seq}`, mode, nodeName: opts.nodeName || null, state: "queued", phase: null, prev: null, setValue: null, mutated: false, error: undefined, rollback: undefined, expected: null, serviceDirty: false, deferUntil: undefined, verifyId: undefined, requestedAt: now };
      dl.wait = now + WAIT_MS;
      if (voice.snapshot().state !== "idle") hud(out, "mic change applies after this dictation");
      tryReserve(out, now);
      return { effects: out, result: { ok: true, operationId: op.id } };
    },

    statusOf(id) {
      if (op && op.id === id) return { state: op.state, phase: op.phase, mode: op.mode, error: op.error, rollback: op.rollback };
      return history.get(id) || null;
    },

    pending() { return op !== null || deferred !== null; },

    backend(cls, now, opts = {}) {
      backend = { cls, at: now, fresh: !!opts.fresh };
      const out = [];
      tryDeferred(out, now);
      tryReserve(out, now);
      return out;
    },

    systemdJob(pending, now) {
      jobPending = !!pending;
      jobAt = now;
      const out = [];
      tryDeferred(out, now);
      tryReserve(out, now);
      return out;
    },

    cmdExit(id, code, stdout, now) {
      const entry = cmds.get(id);
      const out = [];
      cmds.delete(id);
      if (!entry) return out;
      if (!op) {
        // A command from a reset/deferred-away operation drained. If it belongs to the operation now
        // waiting to roll back and it actually wrote to disk, the deferred snapshot's `expected` was
        // taken before this write was known to succeed — correct it now, so the eventual rollback
        // re-read is compared against what is really on disk, not the pre-write literal.
        if (deferred && entry.opId === deferred.id && entry.writes !== undefined && code === 0) deferred.expected = entry.writes;
        tryDeferred(out, now);
        return out;
      }
      if (entry.opId !== op.id) { tryReserve(out, now); return out; }  // stale: belongs to a superseded operation; its drain may unblock this one

      switch (op.phase) {
        case "get": {
          const parsed = parseConfigGet(stdout);
          if (code !== 0 || !parsed.literalKnown) { setErrorOnce(op, "preflight-failed"); finish(out, "failed"); return out; }
          op.prev = parsed; op.expected = parsed.literal;               // the literal the file holds right now (nothing written yet)
          if (jobPending) { setErrorOnce(op, "job-pending"); finish(out, "failed"); return out; }  // nothing mutated: just fail, no rollback
          op.phase = "set"; op.mutated = true; op.setValue = String(targetValue(op));
          cmd(out, "set", ["voxtype", "config", "set", "audio.device", op.setValue], op.setValue);
          return out;
        }
        case "set":
          if (code !== 0) {
            setErrorOnce(op, "set-failed");
            if (jobPending) { deferOp(out, now); return out; }
            beginRollback(out); return out;
          }
          op.expected = op.setValue;                                    // the write took effect: this is now the literal on disk
          if (jobPending) { setErrorOnce(op, "job-pending"); deferOp(out, now); return out; }  // restart must not race the job
          op.serviceDirty = true;                                       // the running service is about to fall out of sync with prev
          op.phase = "restart"; cmd(out, "restart", restartArgv); return out;
        case "restart":
          op.state = "verifying"; op.phase = "verify"; pushVerify(out, now); return out;
        case "rollback-get": {
          const parsed = parseConfigGet(stdout);
          const found = parsed.literalKnown ? parsed.literal : undefined;
          if (code !== 0 || !parsed.literalKnown || String(found) !== String(op.expected)) {
            op.rollback = "conflict";
            out.push({ type: "conflict", expected: op.expected, found: found === undefined ? null : found });
            hud(out, "microphone config changed externally");
            finish(out, "failed");
            return out;
          }
          if (op.expected === op.prev.literal) {                        // the file already holds the value to restore
            if (!op.serviceDirty) { op.rollback = "verified"; finish(out, "failed"); return out; }  // service never saw the new value
            if (jobPending) { deferOp(out, now); return out; }
            op.phase = "rollback-restart"; cmd(out, "restart", restartArgv); return out;             // service may still need restoring
          }
          op.phase = "rollback-set";
          if (op.prev.literal === null) cmd(out, "unset", ["voxtype", "config", "unset", "audio.device"], null);
          else cmd(out, "set", ["voxtype", "config", "set", "audio.device", String(op.prev.literal)], op.prev.literal);
          return out;
        }
        case "rollback-set":
          if (code !== 0) { op.rollback = "failed"; out.push({ type: "unconfigured", reason: "voxtype restart failed" }); finish(out, "failed"); return out; }
          op.expected = op.prev.literal;
          if (jobPending) { deferOp(out, now); return out; }
          op.phase = "rollback-restart"; cmd(out, "restart", restartArgv); return out;
        case "rollback-restart":
          op.phase = "rollback-verify"; pushVerify(out, now); return out;
        default:
          return out;
      }
    },

    verifyResult(ok, now, id) {
      const out = [];
      if (!op) return out;
      if (id !== undefined && id !== op.verifyId) return out;  // a report for a verify this op no longer has outstanding
      delete dl.verify;
      op.verifyId = undefined;
      if (op.phase === "verify") {
        if (ok) { out.push({ type: "commit", mode: op.mode }); hud(out, ""); finish(out, "succeeded"); return out; }
        setErrorOnce(op, "verify-failed");
        if (jobPending) { deferOp(out, now); return out; }
        beginRollback(out); return out;
      }
      if (op.phase === "rollback-verify") {
        if (ok) { op.rollback = "verified"; hud(out, ""); finish(out, "failed"); return out; }
        op.rollback = "failed"; out.push({ type: "unconfigured", reason: "voxtype restart failed" }); finish(out, "failed"); return out;
      }
      return out;
    },

    externalRecording(now) { return this.reset(now, "interrupted"); },

    reset(now, reason = "reset") {
      const out = [];
      if (!op) return out;
      setErrorOnce(op, reason);
      if (!op.mutated) { finish(out, "failed"); return out; }
      deferOp(out, now);                                       // mutated: rollback only once the system is quiet (§3 reset priority)
      return out;
    },

    advance(now) {
      const out = [];
      if (dl.wait !== undefined && dl.wait <= now && op && op.state === "queued") { delete dl.wait; setErrorOnce(op, "wait-timeout"); finish(out, "failed"); return out; }
      if (dl.verify !== undefined && dl.verify <= now && op) { delete dl.verify; return this.verifyResult(false, now); }
      if (dl.defer !== undefined && dl.defer <= now && deferred) {
        delete dl.defer;
        record(deferred.id, "failed", { mode: deferred.mode, error: deferred.error, rollback: "unresolved" });
        deferred = null;
        out.push({ type: "unconfigured", reason: "mic change unresolved" });
        return out;
      }
      if (op && op.state === "queued") tryReserve(out, now);
      tryDeferred(out, now);
      return out;
    },

    nextDeadline() {
      let d = null;
      for (const k of Object.keys(dl)) if (dl[k] !== undefined && (d === null || dl[k] < d)) d = dl[k];
      return d;
    },
  };
}
