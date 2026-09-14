// Spec §5: voice session state machine (§5.1 sources, §5.2 start/arbitration/end, §5.3 failures & recovery,
// §5.4 degradation, §5.5 stats). Pure: explicit `now`, effects out, no processes.
import { isHealthy } from "./VoxStatus.mjs";

const VOX = (sub) => ["voxtype", "record", sub];
const ATV = { path: "/org/atvvoice/Daemon", iface: "org.atvvoice.Daemon", member: "MicStateChanged" };   // §5.1 source identity
const ARB_CHECK_MS = 500;    // bound for readAtv/poll answers after the arbitration timer
const RESTART_MS = 10000;    // §5.3 recovery restart verification bound
const FRESH_MS = 500;        // §5.3 "fresh idle" = poll no older than this
const MAX_CANCELS = 3;       // §5.3 phantom re-cancel bound

export function createVoiceSession(config) {
  let cfg = config;
  const v = () => cfg.voice;

  let st = "idle", owner = null;
  let remote = "unknown";                                   // last known ATVVoice State
  let backend = { cls: "unknown", at: -Infinity, fresh: false };
  let gen = 0, cmdSeq = 0;
  const cmds = new Map();                                   // id -> { kind, gen }
  let dl = {};                                              // named deadlines (ms)
  let stopLatched = false, stopOnConfirm = false, ourStart = false, pendingDbusEnd = false;
  let arb = null;                                           // { atv, backend } answers after arbitration timer
  let cancels = 0, cancelAt = -Infinity, escalate = false, restartPending = false, restarted = false, idleAccepted = false, external = false;
  let recoveryPollAt = -Infinity;                           // §5.3: set when a busy-blocked restart re-polls, to detect an unanswered backend
  let unconfirmedEntry = false;                             // §5.3: recovery began from `starting` (our SIGUSR1 may land late)
  let pluginMic = false, dbusEnabled = true;
  let dbusSender = null, dbusGeneration = 0;                // §5.1 selected sender / monitor generation
  let atvRequestId = null, atvSeq = 0;                      // outstanding readAtv request
  let sessionStart = 0, sessionSource = null, recordEnd = 0;
  const gates = new Set();

  // ---- helpers -------------------------------------------------------------
  const stateEff = () => ({ type: "state", state: st, owner });
  const hud = (out, text) => out.push({ type: "hud", text });
  function setState(out, next, nextOwner) {
    st = next;
    if (nextOwner !== undefined) owner = nextOwner;
    out.push(stateEff());
  }
  function cmd(out, kind) {
    const id = ++cmdSeq;
    cmds.set(id, { kind, gen });
    out.push({ type: "cmd", id, kind, argv: VOX(kind) });
    return id;
  }
  const clearDeadlines = () => { dl = {}; };
  const inferred = (src) => src === "dbus" || src === "keyboard";
  function readAtv(out) { atvRequestId = `atv-${++atvSeq}`; out.push({ type: "readAtv", requestId: atvRequestId }); }
  function currentSource(ev) {                              // generation/sender check shared by signals and property replies
    if (!ev || typeof ev !== "object") return false;        // fails closed: no selected sender yet -> nothing is current
    if (dbusSender === null) return false;
    if (ev.sender !== dbusSender) return false;
    if (ev.generation !== dbusGeneration) return false;      // an absent/undefined generation is a mismatch, not a pass
    return true;
  }
  function validSignal(ev) {                                // full §5.1 identity for monitor events
    return currentSource(ev) && ev.path === ATV.path && ev.interface === ATV.iface && ev.member === ATV.member;
  }

  function startSession(out, now, source) {
    ourStart = true; stopLatched = false; stopOnConfirm = false;
    cmd(out, "start");
    dl.start = now + v().startTimeoutMs;
    hud(out, "starting…");
    setState(out, "starting", source);
  }

  function confirm(out, now) {
    ourStart = false; delete dl.start;
    sessionStart = now; sessionSource = owner;
    dl.maxSession = now + v().maxSessionSec * 1000;
    hud(out, "recording");
    setState(out, "recording");
    if (stopOnConfirm) { stopOnConfirm = false; requestStop(out, now); }
  }

  function adoptKeyboard(out, now) {
    arb = null; delete dl.arb; delete dl.arbCheck;
    stopLatched = false; ourStart = false;
    sessionStart = now; sessionSource = "keyboard";
    dl.maxSession = now + v().maxSessionSec * 1000;
    hud(out, "recording");
    setState(out, "recording", "keyboard");
  }

  function observeTranscribing(out, now) {
    arb = null; delete dl.arb; delete dl.arbCheck;
    if (dl.stop === undefined) dl.stop = now + v().stopTimeoutMs;   // §5.3 external transcription deadline
    setState(out, "transcribing", owner || "keyboard");
  }

  function requestStop(out, now) {
    if (stopLatched) return;
    stopLatched = true;
    cmd(out, "stop");
    delete dl.maxSession; delete dl.endCheck; pendingDbusEnd = false;   // a stop supersedes any pending D-Bus end re-read
    dl.stop = now + v().stopTimeoutMs;
    hud(out, "stopping…");
    setState(out, "stopping");
  }

  function finalize(out, now) {
    if (sessionStart > 0) {
      const end = recordEnd || now;
      out.push({ type: "stat", session: { startedAt: sessionStart, durationSec: (end - sessionStart) / 1000, source: sessionSource, inferred: inferred(sessionSource) } });
    }
    sessionStart = 0; sessionSource = null; recordEnd = 0;
    stopLatched = false; stopOnConfirm = false; ourStart = false; pendingDbusEnd = false;
    clearDeadlines();
    hud(out, "");
    setState(out, "idle", null);
  }

  function abandonArb(out, reason) {
    arb = null; delete dl.arb; delete dl.arbCheck;
    hud(out, "");
    setState(out, "idle", null);
    if (reason) out.push({ type: "error", reason: `arbitration-${reason}` });
  }

  function enterRecovering(out, now, reason) {
    // Re-entry (e.g. a second abort() while already recovering) must not erase in-flight recovery
    // classification: whether the original entry was unconfirmed (§5.3 phantom rule) and whether a
    // restart is already pending survive; only the per-attempt counters and deadlines reset.
    const reentry = st === "recovering";
    const keepUnconfirmed = reentry ? unconfirmedEntry : st === "starting";
    const keepRestarted = reentry ? restarted : false;
    const keepRestartPending = reentry ? restartPending : false;
    const keepRestartDeadline = reentry ? dl.restart : undefined;
    gen++; cmds.clear();                                    // §5.3 invalidate stale callbacks
    ourStart = false; stopLatched = false; stopOnConfirm = false; arb = null; pendingDbusEnd = false;
    sessionStart = 0; sessionSource = null; recordEnd = 0;
    clearDeadlines();
    unconfirmedEntry = keepUnconfirmed; restarted = keepRestarted; restartPending = keepRestartPending;
    cancels = 1; cancelAt = now; escalate = false; idleAccepted = false; external = false; recoveryPollAt = -Infinity;
    cmd(out, "cancel");
    if (pluginMic) { pluginMic = false; out.push({ type: "micClose" }); }
    out.push({ type: "error", reason });
    hud(out, reason === "abort" ? "Reset" : "recovering…");
    out.push({ type: "poll" });
    if (restartPending) dl.restart = keepRestartDeadline;    // re-arm the deadline we preserved, not a fresh recovery budget
    else dl.recovery = now + v().stopTimeoutMs;
    setState(out, "recovering", null);
  }

  function toUnconfigured(out, reason) {
    clearDeadlines();
    arb = null; restartPending = false; ourStart = false; stopLatched = false; pendingDbusEnd = false;
    sessionStart = 0; sessionSource = null;
    out.push({ type: "error", reason });
    hud(out, reason);
    setState(out, "unconfigured", null);
  }

  function recovered(out) {
    cancels = 0; cancelAt = -Infinity; escalate = false; restarted = false; idleAccepted = false; external = false; unconfirmedEntry = false; recoveryPollAt = -Infinity;
    clearDeadlines();
    hud(out, "");
    setState(out, "idle", null);
  }

  function trySettle(now) {
    if (st === "recovering" && idleAccepted && cmds.size === 0 && !escalate && !restartPending && dl.settle === undefined) {
      dl.settle = now + v().startTimeoutMs;
    }
  }

  function maybeRestart(out, now, force) {
    if (!escalate || restartPending || restarted) return;
    const busy = backend.cls === "recording" || backend.cls === "transcribing";
    if (busy && backend.at >= cancelAt && !force) return;     // never restart over work observed since the cancel, unless forced
    gen++; cmds.clear();
    restartPending = true; restarted = true;
    hud(out, "restarting Voxtype");
    out.push({ type: "restart" });
    clearDeadlines();                                         // a settle window armed just before escalation must not survive under a restart
    dl.restart = now + RESTART_MS;
  }

  function decideArb(out, now) {
    if (!arb || arb.atv === null || arb.backend === null) return;
    const { atv, backend: b } = arb;
    arb = null; delete dl.arbCheck;
    if (atv !== "streaming") { abandonArb(out, "remote-stopped"); return; }
    if (b === "recording") { adoptKeyboard(out, now); return; }
    if (b === "transcribing") { observeTranscribing(out, now); return; }
    if (b === "idle" && gates.size === 0) { startSession(out, now, "dbus"); return; }
    abandonArb(out, "backend-busy");
  }

  function recoveringStatus(out, prev, now) {
    const cls = backend.cls;
    if (cls === "recording" || cls === "transcribing") {
      delete dl.settle;
      if ((idleAccepted || external) && !unconfirmedEntry) { // §5.3: after an accepted idle, from a confirmed session -> external
        if (!external) hud(out, "external dictation in progress");
        external = true; idleAccepted = false; return;
      }
      idleAccepted = false;
      if (cancels < MAX_CANCELS) { cancels++; cancelAt = now; cmd(out, "cancel"); }
      else escalate = true;                                  // restart once the backend is quiet
      return;
    }
    const transition = prev.cls === "recording" || prev.cls === "transcribing";
    const freshEnough = backend.fresh && now - backend.at <= FRESH_MS;
    if (now >= cancelAt && (freshEnough || transition)) {
      idleAccepted = true; external = false;
      if (escalate) maybeRestart(out, now); else trySettle(now);
    }
  }

  // ---- inputs --------------------------------------------------------------
  function status(cls, now, opts = {}) {
    const prev = backend;
    backend = { cls, at: now, fresh: !!opts.fresh };
    const out = [];
    if (restartPending) return out;                          // host verifies the restart and reports restartResult
    if (!isHealthy(cls)) { if (st !== "unconfigured") toUnconfigured(out, "voxtype not responding"); return out; }
    if (st === "unconfigured") { hud(out, ""); setState(out, "idle", null); }
    if (arb && st === "arbitrating") { arb.backend = cls; decideArb(out, now); return out; }
    switch (st) {
      case "idle":
        if (cls === "recording" && !ourStart) adoptKeyboard(out, now);
        else if (cls === "transcribing") observeTranscribing(out, now);
        break;
      case "arbitrating":
        if (cls === "recording") adoptKeyboard(out, now);
        else if (cls === "transcribing") observeTranscribing(out, now);
        break;
      case "starting":
        if (cls === "recording") confirm(out, now);
        else if (cls === "transcribing") { ourStart = false; delete dl.start; observeTranscribing(out, now); }
        break;
      case "recording":
      case "stopping":
        if (cls === "transcribing") { recordEnd = now; delete dl.maxSession; delete dl.endCheck; pendingDbusEnd = false; if (dl.stop === undefined) dl.stop = now + v().stopTimeoutMs; setState(out, "transcribing"); }
        else if (cls === "idle") { recordEnd = now; finalize(out, now); }
        break;
      case "transcribing":
        if (cls === "idle") finalize(out, now);
        else if (cls === "recording") { finalize(out, now); adoptKeyboard(out, now); }
        break;
      case "recovering":
        recoveringStatus(out, prev, now);
        break;
      default: break;
    }
    return out;
  }

  function dbus(event, now) {
    const out = [];
    if (!validSignal(event)) return out;
    const state = event.state;
    const prev = remote; remote = state;
    const was = prev === "streaming", is = state === "streaming";
    if (is && !was) {
      if (st === "idle" && dbusEnabled && gates.size === 0) {
        if (backend.cls === "recording") adoptKeyboard(out, now);
        else { dl.arb = now + v().arbitrationMs; hud(out, "…"); setState(out, "arbitrating", null); }
      }
      return out;
    }
    if (was && !is) {
      if (st === "arbitrating") { abandonArb(out, null); return out; }
      if (owner === "dbus") {
        if (st === "starting") stopOnConfirm = true;
        else if (st === "recording") { pendingDbusEnd = true; readAtv(out); dl.endCheck = now + ARB_CHECK_MS; }
      } else if ((st === "recording" || st === "starting") && v().mic === "remote") {
        hud(out, "remote audio dropped");
      }
    }
    return out;
  }

  function atvRead(reading, now) {
    const out = [];
    if (!reading || reading.requestId !== atvRequestId || !currentSource({ sender: dbusSender, generation: reading.generation })) return out;
    atvRequestId = null;
    const state = reading.state;
    remote = state;
    if (arb && st === "arbitrating") { arb.atv = state; decideArb(out, now); return out; }
    if (pendingDbusEnd && st === "recording" && owner === "dbus") {
      pendingDbusEnd = false; delete dl.endCheck;
      if (state !== "streaming") requestStop(out, now);
    }
    return out;
  }

  function hidPress(now) {
    const out = [];
    if (st !== "idle" || gates.size > 0 || !cfg.keys.mic.ptt) return out;
    startSession(out, now, "hid");
    return out;
  }

  function hidRelease(now) {
    const out = [];
    if (owner !== "hid") return out;
    if (st === "starting") stopOnConfirm = true;
    else if (st === "recording") requestStop(out, now);
    return out;
  }

  function cmdExit(id, code, now) {
    const c = cmds.get(id);
    if (!c) return [];
    cmds.delete(id);
    const out = [];
    if (c.gen !== gen) return out;
    if (c.kind === "start" && code !== 0 && st === "starting") { hud(out, "Voxtype start failed"); enterRecovering(out, now, "start-failed"); }
    else if (c.kind === "stop" && code !== 0 && st === "stopping") enterRecovering(out, now, "stop-failed");
    else if (st === "recovering") trySettle(now);
    return out;
  }

  function restartResult(ok, now) {
    const out = [];
    if (!restartPending) return out;
    restartPending = false; delete dl.restart;
    if (!ok) { toUnconfigured(out, "voxtype not responding"); return out; }
    escalate = false; cancels = 0; cancelAt = now; idleAccepted = false; unconfirmedEntry = false; // fresh Voxtype: no stale "unconfirmed start" classification survives it
    out.push({ type: "poll" });
    dl.recovery = now + v().stopTimeoutMs;
    return out;
  }

  function abort(now) {
    const out = [];
    if (st === "idle" || st === "unconfigured") {
      if (pluginMic) { pluginMic = false; out.push({ type: "micClose" }); }
      return out;
    }
    enterRecovering(out, now, "abort");
    return out;
  }

  function advance(now) {
    const out = [];
    const due = (k) => dl[k] !== undefined && dl[k] <= now;
    if (st === "starting" && due("start")) { delete dl.start; hud(out, "no audio from Voxtype"); enterRecovering(out, now, "start-timeout"); }
    if (st === "arbitrating" && due("arb")) { delete dl.arb; arb = { atv: null, backend: null }; readAtv(out); out.push({ type: "poll" }); dl.arbCheck = now + ARB_CHECK_MS; }
    if (st === "arbitrating" && due("arbCheck")) { delete dl.arbCheck; abandonArb(out, "unresponsive"); }
    if (st === "recording" && due("maxSession")) { delete dl.maxSession; hud(out, "max session reached"); requestStop(out, now); }
    if (pendingDbusEnd && st === "recording" && owner === "dbus" && due("endCheck")) {   // §3/§5.3: bound an unanswered D-Bus end re-read
      delete dl.endCheck; pendingDbusEnd = false; requestStop(out, now);
    }
    if ((st === "stopping" || st === "transcribing") && due("stop")) { delete dl.stop; enterRecovering(out, now, "stop-timeout"); }
    if (st === "recovering" && !restartPending && due("settle")) { delete dl.settle; recovered(out); }
    if (st === "recovering" && due("recovery")) {
      delete dl.recovery;
      if (external) dl.recovery = now + v().stopTimeoutMs;   // §5.3: the budget pauses across external work, not just the settle window
      else if (restarted) toUnconfigured(out, "voxtype not responding");
      else {
        escalate = true;
        // §5.3: never restart over busy work unless the backend has gone silent since our own poll
        // (nothing newer than recoveryPollAt) — otherwise re-poll and re-arm the budget.
        const force = recoveryPollAt > -Infinity && backend.at <= recoveryPollAt;
        maybeRestart(out, now, force);
        if (!restartPending) { out.push({ type: "poll" }); recoveryPollAt = now; dl.recovery = now + v().stopTimeoutMs; }
      }
    }
    if (st === "recovering" && due("restart")) { delete dl.restart; toUnconfigured(out, "voxtype not responding"); }
    return out;
  }

  function nextDeadline() {
    let d = null;
    for (const k of Object.keys(dl)) if (dl[k] !== undefined && (d === null || dl[k] < d)) d = dl[k];
    return d;
  }

  return {
    hidPress, hidRelease, dbus, atvRead, status, cmdExit, restartResult, abort, advance, nextDeadline,
    micOpened() { pluginMic = true; }, micClosed() { pluginMic = false; },
    setDbusEnabled(b) { dbusEnabled = !!b; },
    setDbusSource({ sender, generation }) { dbusSender = sender === undefined ? null : sender; dbusGeneration = generation || 0; atvRequestId = null; },
    setConfig(c) { cfg = c; },
    gate: {
      acquire(name) { if (st !== "idle" || gates.size > 0) return false; gates.add(name); return true; },
      release(name) { gates.delete(name); },
      busy() { return gates.size > 0; },
    },
    snapshot() {
      return { state: st, owner, remote, backend: backend.cls, backendAt: backend.at, backendFresh: backend.fresh, pluginMic, cancels, pendingCmds: cmds.size, sessionSource, inferred: inferred(owner), gates: [...gates], dbusSender, dbusGeneration, atvRequestId, idleAccepted };
    },
  };
}
