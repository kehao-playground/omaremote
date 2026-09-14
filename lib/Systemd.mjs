// Spec §3 (systemd job contract, restart verified by active + new InvocationID + fresh idle within 10 s), §5.3 (bounded recovery restart), §5.4 (monitor backoff 1 s → 30 s).
const POLL_MS = 1000;

export function parseShow(stdout) {
  const lines = String(stdout === undefined || stdout === null ? "" : stdout).split("\n");
  const job = (lines[0] || "").trim();
  const activeState = (lines[1] || "").trim();
  const invocationId = (lines[2] || "").trim();
  return { job, activeState, invocationId, jobPending: job !== "" };
}

export function backoffMs(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(30000, 1000 * Math.pow(2, n));
}

export function createRestartVerifier({ deadlineMs = 10000 } = {}) {
  let v = null;   // { id, prev, until, nextPoll, changed, active, idle }

  function finish(ok, reason) { const id = v.id; v = null; return { type: "verified", id, ok, reason }; }
  function check(now) {
    if (!v) return [];
    if (v.changed && v.active && v.idle) return [finish(true, undefined)];
    if (now >= v.until) return [finish(false, "timeout")];
    return [];
  }

  return {
    begin(id, prevInvocation, now) {
      v = { id, prev: prevInvocation || "", until: now + deadlineMs, nextPoll: now + POLL_MS, changed: false, active: false, idle: false };
      return [{ type: "show" }, { type: "poll" }];
    },
    show(info, now) {
      if (!v) return [];
      v.changed = !!info.invocationId && info.invocationId !== v.prev;
      v.active = info.activeState === "active";
      if (!v.changed) v.idle = false;        // an idle seen before the new invocation belongs to the old daemon
      return check(now);
    },
    status(cls, fresh, now) {
      if (!v || !fresh) return [];
      v.idle = v.changed && cls === "idle";  // transient stopped/other classes are retried until the deadline
      return check(now);
    },
    advance(now) {
      const out = check(now);
      if (v && now >= v.nextPoll) { v.nextPoll = now + POLL_MS; out.push({ type: "show" }, { type: "poll" }); }
      return out;
    },
    nextDeadline() { return v ? Math.min(v.until, v.nextPoll) : null; },
    active() { return v !== null; },
    id() { return v ? v.id : null; },
  };
}
