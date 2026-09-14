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
  let seq = 0, cmdSeq = 0;
  const cmds = new Map();                         // id -> kind
  let backend = { cls: "unknown", at: -Infinity, fresh: false };
  let dl = {};
  let deferred = null;                            // { id, mode, prev, setValue, error } rollback waiting for a quiet system
  let jobPending = false;

  const hud = (out, text) => out.push({ type: "hud", text });
  const cmd = (out, kind, argv) => { const id = ++cmdSeq; cmds.set(id, kind); out.push({ type: "cmd", id, kind, argv }); return id; };
  const restartArgv = ["systemctl", "--user", "restart", "voxtype"];
  const getArgv = ["voxtype", "config", "get", "audio.device", "--json"];
  const targetValue = (o) => (o.mode === "remote" ? o.nodeName : "default");
  const fresh = (now) => backend.cls === "idle" && backend.fresh && now - backend.at <= FRESH_MS;

  function record(id, state, extra) { history.set(id, { state, phase: null, ...extra }); }

  function finish(out, state) {
    record(op.id, state, { mode: op.mode, error: op.error, rollback: op.rollback });
    out.push({ type: "done", operationId: op.id, state, error: op.error, rollback: op.rollback });
    voice.gate.release("mic-apply");
    dl = {};
    op = null;
  }

  function beginRollback(out) {                   // every rollback starts with the external-edit check
    op.state = "rollingBack"; op.phase = "rollback-get";
    hud(out, "restoring previous microphone");
    delete dl.verify;
    cmd(out, "get", getArgv);
  }

  function tryReserve(out, now) {
    if (!op || op.state !== "queued") return;
    const s = voice.snapshot();
    if (s.state !== "idle" || s.pendingCmds > 0) return;
    if (!fresh(now)) { if (!op.polled) { op.polled = true; out.push({ type: "poll" }); } return; }
    if (jobPending) return;                                  // §3: never mutate while a systemd job is pending
    if (!voice.gate.acquire("mic-apply")) return;
    delete dl.wait;
    op.state = "applying"; op.phase = "get";
    hud(out, "changing microphone…");
    cmd(out, "get", getArgv);
  }

  function tryDeferred(out, now) {
    if (!deferred || op) return;
    if (cmds.size > 0 || jobPending || !fresh(now) || voice.snapshot().state !== "idle") return;
    const d = deferred; deferred = null; delete dl.defer;
    op = { id: d.id, mode: d.mode, state: "rollingBack", phase: null, prev: d.prev, setValue: d.setValue, mutated: true, error: d.error, rollback: undefined };
    beginRollback(out);
  }

  return {
    request(mode, now, opts = {}) {
      const out = [];
      if (op || deferred) return { effects: out, result: { ok: false, reason: "busy" } };
      if (!MODES.includes(mode)) return { effects: out, result: { ok: false, reason: "invalid-mode" } };
      if (mode === "remote" && !opts.nodeName) return { effects: out, result: { ok: false, reason: "no-node" } };
      op = { id: `mic-${++seq}`, mode, nodeName: opts.nodeName || null, state: "queued", phase: null, prev: null, setValue: null, mutated: false, error: undefined, rollback: undefined, polled: false };
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
      const out = [];
      tryDeferred(out, now);
      tryReserve(out, now);
      return out;
    },

    cmdExit(id, code, stdout, now) {
      const kind = cmds.get(id);
      const out = [];
      cmds.delete(id);
      if (!kind) return out;
      if (!op) { tryDeferred(out, now); return out; }          // a command from a reset operation drained
      switch (op.phase) {
        case "get": {
          const parsed = parseConfigGet(stdout);
          if (code !== 0 || !parsed.literalKnown) { op.error = "preflight-failed"; finish(out, "failed"); return out; }
          op.prev = parsed;
          op.phase = "set"; op.mutated = true; op.setValue = String(targetValue(op));
          cmd(out, "set", ["voxtype", "config", "set", "audio.device", op.setValue]);
          return out;
        }
        case "set":
          if (code !== 0) { op.error = "set-failed"; beginRollback(out); return out; }
          op.phase = "restart"; cmd(out, "restart", restartArgv); return out;
        case "restart":
          op.phase = "verify"; op.state = "verifying"; out.push({ type: "verify" }); dl.verify = now + VERIFY_MS; return out;
        case "rollback-get": {
          const parsed = parseConfigGet(stdout);
          const found = parsed.literalKnown ? parsed.literal : undefined;
          if (code !== 0 || !parsed.literalKnown || String(found) !== op.setValue) {
            op.rollback = "conflict";
            out.push({ type: "conflict", expected: op.setValue, found: found === undefined ? null : found });
            hud(out, "microphone config changed externally");
            finish(out, "failed");
            return out;
          }
          op.phase = "rollback-set";
          if (op.prev.literal === null) cmd(out, "unset", ["voxtype", "config", "unset", "audio.device"]);
          else cmd(out, "set", ["voxtype", "config", "set", "audio.device", String(op.prev.literal)]);
          return out;
        }
        case "rollback-set":
          if (code !== 0) { op.rollback = "failed"; out.push({ type: "unconfigured", reason: "voxtype restart failed" }); finish(out, "failed"); return out; }
          op.phase = "rollback-restart"; cmd(out, "restart", restartArgv); return out;
        case "rollback-restart":
          op.phase = "rollback-verify"; out.push({ type: "verify" }); dl.verify = now + VERIFY_MS; return out;
        default:
          return out;
      }
    },

    verifyResult(ok, now) {
      const out = [];
      if (!op) return out;
      delete dl.verify;
      void now;
      if (op.phase === "verify") {
        if (ok) { out.push({ type: "commit", mode: op.mode }); hud(out, ""); finish(out, "succeeded"); return out; }
        op.error = "verify-failed"; beginRollback(out); return out;
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
      op.error = reason;
      if (!op.mutated) { finish(out, "failed"); return out; }
      // Mutated: stop here; rollback runs only once the system is quiet (§3 reset priority / no competing restarts).
      deferred = { id: op.id, mode: op.mode, prev: op.prev, setValue: op.setValue, error: reason };
      dl = { defer: now + DEFER_MS };
      record(op.id, "failed", { mode: op.mode, error: reason, rollback: "deferred" });
      out.push({ type: "done", operationId: op.id, state: "failed", error: reason, rollback: "deferred" });
      hud(out, "mic change interrupted");
      voice.gate.release("mic-apply");
      op = null;
      return out;
    },

    advance(now) {
      const out = [];
      if (dl.wait !== undefined && dl.wait <= now && op && op.state === "queued") { delete dl.wait; op.error = "wait-timeout"; finish(out, "failed"); return out; }
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
