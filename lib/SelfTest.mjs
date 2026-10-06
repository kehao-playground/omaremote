// Spec §7 step 6: exclusive self-test lease; raw transport counts kept apart from IPC injections;
// an external recording ends the lease immediately and the failure stays reportable once.
export function createSelfTest({ supportedKeys, gate, leaseMs }) {
  // §7: the lease length is chosen by the caller, per arm() call. An out-of-range or unparseable
  // value clamps rather than rejecting — it arrives as an IPC string from a shell and must never
  // throw into the host process. The constructor argument is only the default.
  const LEASE_DEFAULT = 120000, LEASE_MIN = 1000, LEASE_MAX = 600000;
  const clampLease = (v, fallback) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.min(LEASE_MAX, Math.max(LEASE_MIN, x)) : fallback;
  };
  const defaultLeaseMs = clampLease(leaseMs, LEASE_DEFAULT);
  let lease = null;          // { id, until, counts: {shortcut:{}, ipc:{}}, down: Set }
  let seq = 0;
  const failed = new Map();  // id -> report of a lease that ended in failure, retrievable once
  const empty = () => ({ down: 0, up: 0 });

  function compute(l) {
    const sc = l.counts.shortcut;
    const missing = supportedKeys.filter(k => !sc[k] || sc[k].down < 1 || sc[k].up < 1);
    const extras = Object.keys(sc).filter(k => !supportedKeys.includes(k) || sc[k].down > 1 || sc[k].up > 1);
    const held = [...l.down];
    return { missing, extras, held, counts: l.counts };
  }
  function end() { if (!lease) return; gate.release("selftest"); lease = null; }

  return {
    arm(now, ctx, requestedLeaseMs) {
      const busy = (detail) => ({ ok: false, reason: "busy", detail: detail, retryAfterMs: 300 });
      // Checked first and answered without side effects: a live lease is never replaced. Rebuilding the
      // instance to change a lease length would drop the old lease silently AND leak the shared gate,
      // because the discarded instance's end() — the only caller of gate.release("selftest") — never runs.
      if (lease) return busy("leaseActive");
      if (!ctx) return busy("voiceBusy");
      if (!ctx.voiceIdle) return busy("voiceBusy");
      if (!ctx.backendIdleFresh) return busy("backendStale");
      if (ctx.heldKeys && ctx.heldKeys.length) return busy("heldKeys:" + ctx.heldKeys.join(","));
      if ((ctx.pendingCmds || 0) > 0) return busy("pendingCmds:" + ctx.pendingCmds);
      if (!gate.acquire("selftest")) return busy("gate");
      const ms = requestedLeaseMs === undefined ? defaultLeaseMs : clampLease(requestedLeaseMs, defaultLeaseMs);
      lease = { id: `st-${++seq}`, until: now + ms, counts: { shortcut: {}, ipc: {} }, down: new Set() };
      return { ok: true, id: lease.id };
    },
    active() { return lease !== null; },
    record(source, key, edge, now) {
      if (!lease || now >= lease.until) return false;
      const bucket = lease.counts[source === "ipc" ? "ipc" : "shortcut"];
      bucket[key] = bucket[key] || empty();
      bucket[key][edge === "up" ? "up" : "down"]++;
      if (source !== "ipc") { if (edge === "down") lease.down.add(key); else lease.down.delete(key); }
      return true;
    },
    status(id, now) {
      if (lease && lease.id === id) {
        if (now >= lease.until) return { active: false, remainingMs: 0, failed: undefined };
        return { active: true, remainingMs: Math.max(0, lease.until - now), failed: undefined };
      }
      if (failed.has(id)) return { active: false, remainingMs: 0, failed: failed.get(id).failed };
      return null;
    },
    report(id, now) {
      if (failed.has(id)) { const r = failed.get(id); failed.delete(id); return r; }
      if (!lease || lease.id !== id) {
        const known = /^st-\d+$/.test(String(id)) && Number(String(id).slice(3)) <= seq;
        return { ok: false, reason: known ? "expired" : "unknown" };
      }
      if (now >= lease.until) { end(); return { ok: false, reason: "expired" }; }
      const r = compute(lease);
      end();
      return Object.assign({ ok: r.missing.length === 0 && r.extras.length === 0 && r.held.length === 0 }, r, { failed: undefined });
    },
    disarm(id, now) {
      if (!lease || lease.id !== id) return false;
      end();
      return true;
    },
    externalRecording(now) {
      if (!lease) return [];
      const id = lease.id;
      failed.set(id, Object.assign({ ok: false }, compute(lease), { failed: "external-recording" }));
      end();
      return [{ type: "selftestFailed", id, reason: "external-recording" }];
    },
    advance(now) {
      if (lease && now >= lease.until) { const id = lease.id; end(); return [{ type: "selftestExpired", id }]; }
      return [];
    },
    nextDeadline() { return lease ? lease.until : null; },
  };
}
