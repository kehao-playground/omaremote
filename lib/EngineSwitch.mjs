// Typeless spec §6.1 (routing), §6.2 (drain both engines, then commit), §4.1 (keytap exit codes). Pure; Service.qml
// performs the effects. Extracted so the orchestration is tested under node with the real sessions it drives.
export const DRAIN_MS = 3000;            // §6.2: each session's drain bound
export const KEYTAP_DEADLINE_MS = 2000;  // §6.1: the runner reports by deadline + 1 s, so 3 s at most
const VOICE_GRACE_MS = 1000;             // VoiceSession aborts itself at DRAIN_MS; this only guards against a wedge

// §6.1: which session hears an input. Source updates reach TypelessSession under both engines (it is dormant under
// Voxtype); the mic key, reset and panic reach only the selected engine; the mic key's release only Voxtype.
export function routeTargets(engine, input) {
  const t = engine === "typeless";
  switch (input) {
    case "state": case "sourceLost": return t ? ["typeless"] : ["voice", "typeless"];
    case "micDown": case "reset": return t ? ["typeless"] : ["voice"];
    case "micUp": return t ? [] : ["voice"];
    default: return [];
  }
}

// §4.1 client exit codes, plus the runner's 124/137 and its synthesized 127 (python3 could not be exec'd).
export function tapOutcome(code) {
  if (code === 0) return { outcome: "sent", reason: "" };
  if (code === 2) return { outcome: "notSent", reason: "rejected by keytap" };
  if (code === 3) return { outcome: "notSent", reason: "keytap not running" };
  if (code === 127) return { outcome: "notSent", reason: "python3 not found" };
  if (code === 124 || code === 137) return { outcome: "unknown", reason: "keytap timed out" };
  return { outcome: "unknown", reason: "keytap exit " + code };
}

// §6.2: an external edit of engine, mic or hotkey drains both sessions before the new config applies.
export function reloadNeedsDrain(held, next) {
  if (!held || !next) return false;
  return held.voice.engine !== next.voice.engine || held.voice.mic !== next.voice.mic
      || held.voice.typeless.hotkey !== next.voice.typeless.hotkey;
}

// §6.1 shell start: dormant first, seeded second. Seeding a streaming State into a session that is not yet quiesced
// would tap at once, even under Voxtype. `seedState` is the current source's last State, or null without a source.
export function startTypeless(session, engine, seedState, now) {
  const out = [];
  if (engine !== "typeless") out.push(...session.quiesce(now, "dormant", ""));
  if (seedState === "streaming" || seedState === "connected" || seedState === "disconnected")
    out.push(...session.streaming(seedState === "streaming", now));
  return out;
}

// §6.2: the "mic" holder belongs to a pending mic apply. MicApply can end one without a `done` effect (a deferred
// rollback that runs out its 60 s bound), so Service releases a holder that outlived its apply on every pump.
export function releaseMicHold(micPending, typeless, now) {
  if (micPending || typeless.snapshot().quiesced.indexOf("mic") < 0) return [];
  return typeless.resume(now, "mic");
}

// §6.2 mic apply under Typeless: MicApply waits for an idle voice session; under Typeless it must also wait until
// TypelessSession is settled. This view is what MicApply is given instead of VoiceSession itself.
export function micVoiceView(voice, typeless, engineOf) {
  return {
    snapshot() {
      const s = voice.snapshot();
      if (engineOf() === "typeless" && !typeless.settled()) return Object.assign({}, s, { state: "typeless-busy" });
      return s;
    },
    gate: voice.gate,
  };
}

// §6.2 steps 1-4. kind "switch" commits target; kind "reload" applies a config that is already loaded.
export function createEngineSwitch() {
  let op = null;                         // { kind, target, due, voiceDone, typelessDone }
  function finish(out) {
    if (op && op.voiceDone && op.typelessDone) { out.push({ type: "switchCommit", kind: op.kind, target: op.target }); op = null; }
    return out;
  }
  return {
    busy() { return op !== null; },
    begin(kind, target, now) {
      if (op) return { ok: false, reason: "busy", effects: [] };
      op = { kind, target, due: now + DRAIN_MS, voiceDone: false, typelessDone: false };
      return { ok: true, effects: [{ type: "drainStart", kind, target }] };
    },
    progress(s, now) {
      if (!op) return [];
      if (s.voiceDrained) op.voiceDone = true;
      if (s.typelessSettled) op.typelessDone = true;
      return finish([]);
    },
    advance(now) {
      const out = [];
      if (!op) return out;
      if (!op.typelessDone && now >= op.due) { op.typelessDone = true; out.push({ type: "typelessExpired" }); }
      if (!op.voiceDone && now >= op.due + VOICE_GRACE_MS) {
        op.voiceDone = true;
        out.push({ type: "log", text: "VoiceSession did not drain after its own abort; switching anyway" });
      }
      return finish(out);
    },
    nextDeadline() {
      if (!op) return null;
      if (!op.typelessDone) return op.due;
      return op.voiceDone ? null : op.due + VOICE_GRACE_MS;
    },
  };
}
