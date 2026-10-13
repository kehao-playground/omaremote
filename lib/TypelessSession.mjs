// Typeless spec §5: when to tap Typeless's dictation hotkey. Pure: explicit `now`, effects out, no processes.
//   remote mode (§5.2): hold to talk, by reconciling a few facts after every input and every tap result;
//   system mode (§5.3): each HID press is one tap, through a FIFO of at most SYSTEM_FIFO presses;
//   both: single-flight taps (§5.1), quiesce holders for drains (§6.2), dormant (held quiesced) under Voxtype (§6.1).
// Typeless's real state is invisible (§5.4): `typeless` is only what omaremote believes it is doing.
export const HUD = {
  failed: (reason) => "Typeless trigger failed: " + reason,
  unknown: "Typeless state unknown — check Typeless; press reset when it is stopped",
  pendingReset: "a Typeless trigger is still pending — wait a moment, check Typeless is stopped, then reset again",
  maxSession: "max session reached",
  tooFast: "too fast — press ignored",
  systemFailed: "Typeless trigger failed; check Typeless before pressing again",
  paused: (reason) => "dictation paused: " + reason,
  mayRecord: "Typeless may still be recording",
};
export const SYSTEM_FIFO = 4;              // presses held, the outstanding one included

export function createTypelessSession(config) {
  let cfg = config;
  let typeless = "off";                    // remote: off | on | unsynced
  let streaming = false;                   // latest ATVVoice streaming value ...
  let trusted = false;                     // ... read from the current source; false = unknown (counts as not streaming)
  let needRelease = false;                 // one physical hold never restarts after it was ended
  const holders = new Map();               // quiesce holder → reason shown while paused ("" = silent)
  let outstanding = null;                  // { id, kind, chord }: the single tap in flight
  let tapSeq = 0;
  let chord = null;                        // remote session's captured chord (§5.1)
  let since = 0;                           // when that session's start tap was issued
  let deadline = null;                     // maxSessionSec bound of an `on` session
  let fifo = [];                           // system: chords of queued presses (outstanding not included)
  let lastKey = "";

  const mode = () => (cfg.voice.mic === "system" ? "system" : "remote");
  const quiesced = () => holders.size > 0;
  const desired = () => trusted && streaming && !needRelease && !quiesced();
  const settled = () => outstanding === null && fifo.length === 0 && typeless !== "on";
  function pausedReason() { let r = ""; holders.forEach((reason) => { if (reason) r = reason; }); return r; }
  // §5.2 "arming": a release that already happened (trusted false) leaves nothing to wait for.
  function arm() { if (trusted && !streaming) return; needRelease = true; }
  const hud = (out, text) => out.push({ type: "hud", text });

  function snapshot() {
    return {
      mode: mode(), typeless, streaming, trusted, needRelease, quiesced: Array.from(holders.keys()),
      outstanding: outstanding ? { id: outstanding.id, kind: outstanding.kind } : null,
      queued: fifo.length, since, chord, deadline, settled: settled(),
    };
  }
  function tap(out, kind, c) {
    outstanding = { id: ++tapSeq, kind, chord: c };
    out.push({ type: "tap", id: outstanding.id, chord: c, kind });
  }
  function reconcile(out, now) {
    if (mode() !== "remote" || outstanding || typeless === "unsynced") return;
    if (typeless === "off" && desired()) {
      chord = cfg.voice.typeless.hotkey; since = now; deadline = now + cfg.voice.maxSessionSec * 1000;
      tap(out, "start", chord);
    } else if (typeless === "on" && !desired()) {
      tap(out, "stop", chord);
    }
  }
  function finish(out, now) {
    reconcile(out, now);
    if (mode() === "system" && !outstanding && fifo.length > 0) tap(out, "press", fifo.shift());
    const s = snapshot(), key = JSON.stringify(s);
    if (key !== lastKey) { lastKey = key; out.push({ type: "state", state: s }); }
    return out;
  }

  function onStreaming(on, now) {
    const out = [];
    streaming = !!on; trusted = true;
    if (!streaming) needRelease = false;
    if (streaming && mode() === "remote") {
      const why = pausedReason();
      if (quiesced() && why) hud(out, HUD.paused(why));
      else if (typeless === "unsynced") hud(out, HUD.unknown);
    }
    return finish(out, now);
  }

  function sourceLost(now) {
    trusted = false; streaming = false; needRelease = true;   // unknown: always armed (§5.2)
    return finish([], now);
  }

  function hidPress(now) {
    const out = [];
    if (mode() !== "system") return out;                      // remote-mic design §4.2: the stream is the trigger
    if (quiesced()) { const why = pausedReason(); if (why) hud(out, HUD.paused(why)); return finish(out, now); }
    if (fifo.length + (outstanding ? 1 : 0) >= SYSTEM_FIFO) { hud(out, HUD.tooFast); return finish(out, now); }
    fifo.push(cfg.voice.typeless.hotkey);                     // the chord current at press time
    return finish(out, now);
  }

  function tapResult(id, outcome, reason, now) {
    const out = [];
    if (!outstanding || outstanding.id !== id) return out;   // stale: duplicate or never issued (§5.1)
    const kind = outstanding.kind;
    outstanding = null;
    if (kind === "press") {
      if (outcome !== "sent") { fifo = []; hud(out, HUD.systemFailed); }
      return finish(out, now);
    }
    if (typeless === "unsynced") {                           // §5.2: the single rule for results in unsynced
      out.push({ type: "log", text: "Typeless " + kind + " result " + outcome + " ignored while unsynced" });
      return finish(out, now);
    }
    if (outcome === "unknown") { typeless = "unsynced"; deadline = null; hud(out, HUD.unknown); }
    else if (kind === "start" && outcome === "sent") { typeless = "on"; hud(out, ""); }
    else if (kind === "start") { arm(); deadline = null; hud(out, HUD.failed(reason || "not sent")); }
    else if (outcome === "sent") { typeless = "off"; deadline = null; hud(out, ""); }
    else { typeless = "unsynced"; deadline = null; hud(out, HUD.unknown); }   // stop notSent: certainly still recording
    return finish(out, now);
  }

  function reset(now) {
    const out = [];
    if (mode() === "system") { fifo = []; return finish(out, now); }
    if (typeless === "unsynced") {
      if (outstanding) { hud(out, HUD.pendingReset); return finish(out, now); }
      typeless = "off"; hud(out, "");
    }
    arm();
    return finish(out, now);
  }

  function quiesce(now, holder, reason) {
    holders.set(holder || "switch", reason === undefined ? "switching engine" : reason);
    arm();
    fifo = [];
    return finish([], now);
  }

  function resume(now, holder) {
    holders.delete(holder || "switch");
    return finish([], now);
  }

  // §6.2 step 1: the drain bound expired. The outstanding tap stays outstanding; its result will only be logged.
  function forceUnsynced(now) {
    const out = [];
    if (mode() === "remote" && !settled()) { typeless = "unsynced"; deadline = null; }
    hud(out, HUD.mayRecord);
    return finish(out, now);
  }

  // The bound runs from the start tap, so it also applies while that tap is in flight: arming then means a late
  // `sent` reconciles straight into a stop.
  const sessionLive = () => typeless === "on" || (outstanding !== null && outstanding.kind === "start");
  function advance(now) {
    const out = [];
    if (sessionLive() && deadline !== null && now >= deadline) { deadline = null; hud(out, HUD.maxSession); arm(); }
    return finish(out, now);
  }

  return {
    streaming: onStreaming, sourceLost, hidPress, reset, quiesce, resume, forceUnsynced, tapResult, advance,
    setConfig(c, now) { cfg = c; return finish([], now); },
    nextDeadline() { return sessionLive() ? deadline : null; },        // never a past deadline nothing will act on
    settled,
    exitStop() { return mode() === "remote" && typeless === "on" && !outstanding ? chord : null; },
    config() { return cfg; },
    snapshot,
  };
}
