// Plan 4 spec §4.4: which org.atvvoice.* owner is the voice source, as a pure state machine.
// AtvvoiceMonitor.qml runs the processes and reports back; this decides. Effects, in order:
//   { type: "discover" }                 run `busctl --user list`
//   { type: "resolveOwner", id, name }   GetNameOwner(name); report back with the same id
//   { type: "source", sender, busName, epoch }  bump the parser generation, then announce (sender "" = revoked)
//   { type: "startMonitor" }             start the MicStateChanged monitor and the one-shot NodeName/State reads
//   { type: "stopMonitor" }              stop the MicStateChanged monitor; its exit is reported back
//   { type: "retry", ms }                (re)arm the rediscovery timer
//   { type: "cancelRetry" }
// Losing the current owner revokes at once -- never via the old monitor's exit callback, which may land
// after a new owner has already connected. A monitor being retired is tracked so that its exit neither
// clears a newer connection nor counts as a second loss. Owner lookups carry ids so only the latest one
// counts; `epoch` advances on every change of source so the driver can drop replies to older reads.
export function createAtvSource({ backoffMs }) {
  let sender = "", busName = "", attempts = 0, retryMs = 0, retryAt = 0;
  let discovering = false, rediscover = false;
  let monitorRunning = false, retiring = false, pendingMonitor = false;
  let resolveSeq = 0, resolveId = 0, epoch = 0;

  function revoke() {
    if (!sender && !busName) return [];
    sender = ""; busName = "";
    pendingMonitor = false;
    resolveId = 0;                                                  // an outstanding lookup is now stale
    epoch++;
    const out = [{ type: "source", sender: "", busName: "", epoch }];
    if (monitorRunning && !retiring) { retiring = true; out.push({ type: "stopMonitor" }); }
    return out;
  }
  function scheduleRetry(now) {
    retryMs = backoffMs(attempts++);
    retryAt = now + retryMs;
    return [{ type: "retry", ms: retryMs }];
  }
  function clearRetry() { retryMs = 0; retryAt = 0; return [{ type: "cancelRetry" }]; }
  function lost(now) { return [...revoke(), ...scheduleRetry(now)]; }
  function start() {
    if (discovering) { rediscover = true; return []; }
    discovering = true;
    return [{ type: "discover" }];
  }

  return {
    start(now) { return start(); },
    discovered(names, now) {
      discovering = false;
      if (rediscover) { rediscover = false; return start(); }      // a newer request supersedes this result
      if (!Array.isArray(names) || names.length === 0) return lost(now);
      if (sender) return [];                                        // already connected: a redundant discovery
      busName = names[0];
      resolveId = ++resolveSeq;
      return [{ type: "resolveOwner", id: resolveId, name: busName }];
    },
    ownerResolved(id, owner, now) {
      if (id !== resolveId || !busName || sender) return [];        // stale lookup, revoked meanwhile, or already connected
      resolveId = 0;
      if (!owner) return lost(now);
      sender = owner; attempts = 0;
      epoch++;
      const out = [...clearRetry(), { type: "source", sender, busName, epoch }];
      if (monitorRunning) pendingMonitor = true;                    // the retired monitor has not exited yet
      else { monitorRunning = true; out.push({ type: "startMonitor" }); }
      return out;
    },
    monitorExited(now) {
      monitorRunning = false;
      if (retiring) {
        retiring = false;
        if (pendingMonitor) { pendingMonitor = false; monitorRunning = true; return [{ type: "startMonitor" }]; }
        return [];
      }
      return lost(now);
    },
    nameOwnerChanged(ev, now) {
      if (!ev) return [];
      if (ev.newOwner) {
        // Connected: only our own name's owner change matters; another org.atvvoice.* name is ignored.
        if (sender && (ev.name !== busName || ev.newOwner === sender)) return [];
        const out = [...revoke(), ...clearRetry()];
        attempts = 0;
        return [...out, ...start()];
      }
      if (ev.name === busName) return lost(now);
      return [];
    },
    retryFired(now) { retryAt = 0; return start(); },
    isCurrent(e) { return e === epoch; },
    snapshot() { return { sender, busName, epoch, retryMs, retryAt, attempts, monitorRunning, retiring, pendingMonitor }; },
  };
}
