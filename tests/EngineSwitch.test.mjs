import { test } from "node:test";
import assert from "node:assert/strict";
import { routeTargets, tapOutcome, reloadNeedsDrain, micVoiceView, createEngineSwitch, startTypeless, DRAIN_MS } from "../lib/EngineSwitch.mjs";
import { createTypelessSession } from "../lib/TypelessSession.mjs";
import { createVoiceSession } from "../lib/VoiceSession.mjs";
import { createMicApply } from "../lib/MicApply.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";

const cfg = (voice = {}) => normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, ...voice } }).config;
const ev = (state) => ({ state, sender: ":1.42", path: "/org/atvvoice/Daemon", interface: "org.atvvoice.Daemon", member: "MicStateChanged", generation: 0 });

// The contract Service.qml implements (Task 10), in miniature: route inputs per §6.1, perform switch effects, and
// check the switch's progress only after an outermost call has finished, never in the middle of a drainStart.
function makeHost(engine) {
  let config = cfg({ engine });
  let pending = null;                                       // a reload's config, applied at its commit
  const voice = createVoiceSession(config);
  voice.setDbusSource({ sender: ":1.42", generation: 0 });
  voice.status("idle", 0, { fresh: true });
  const typeless = createTypelessSession(config);
  typeless.streaming(false, 0);                             // seeded from the source's last State, then...
  if (engine !== "typeless") typeless.quiesce(0, "dormant", "");   // ...dormant under Voxtype
  const sw = createEngineSwitch();
  const fx = { voice: [], typeless: [], switch: [] };
  let depth = 0;
  const h = {
    voice, typeless, sw, fx,
    get config() { return config; },
    apply(src, effects, now) {
      depth++;
      try {
        fx[src].push(...effects);
        for (const e of effects) {
          if (e.type === "drainStart") {
            h.apply("typeless", typeless.quiesce(now, "switch", "switching engine"), now);
            h.apply("voice", voice.drain(now), now);
          } else if (e.type === "typelessExpired") h.apply("typeless", typeless.forceUnsynced(now), now);
          else if (e.type === "switchCommit") {
            if (e.kind === "switch") config = cfg({ ...config.voice, engine: e.target });
            else config = pending;
            voice.setConfig(config);
            h.apply("typeless", typeless.setConfig(config, now), now);
            h.apply("voice", voice.undrain(now, "connected"), now);
            if (config.voice.engine === "typeless") h.apply("typeless", typeless.resume(now, "dormant"), now);
            else h.apply("typeless", typeless.quiesce(now, "dormant", ""), now);
            h.apply("typeless", typeless.resume(now, "switch"), now);
          }
        }
      } finally { depth--; }
      if (depth === 0 && sw.busy()) {
        const p = sw.progress({ voiceDrained: voice.drained(), typelessSettled: typeless.settled() }, now);
        if (p.length) h.apply("switch", p, now);
      }
    },
    begin(target, now) { const r = sw.begin("switch", target, now); h.apply("switch", r.effects, now); return r; },
    reload(next, now) { pending = next; const r = sw.begin("reload", next.voice.engine, now); h.apply("switch", r.effects, now); return r; },
    state(on, now) {
      for (const t of routeTargets(config.voice.engine, "state")) {
        if (t === "voice") h.apply("voice", voice.dbus(ev(on ? "streaming" : "connected"), now), now);
        else h.apply("typeless", typeless.streaming(on, now), now);
      }
    },
    tapResult(id, outcome, now) { h.apply("typeless", typeless.tapResult(id, outcome, "", now), now); },
    advance(now) {
      h.apply("voice", voice.advance(now), now);
      h.apply("typeless", typeless.advance(now), now);
      h.apply("switch", sw.advance(now), now);
    },
    taps() { return fx.typeless.filter(e => e.type === "tap"); },
    voxCmds() { return fx.voice.filter(e => e.type === "cmd").map(e => e.kind); },
    commits() { return fx.switch.filter(e => e.type === "switchCommit"); },
  };
  return h;
}

test("routeTargets: source updates reach TypelessSession under both engines; mic key, reset and panic only the selected one", () => {
  assert.deepEqual(routeTargets("voxtype", "state"), ["voice", "typeless"]);
  assert.deepEqual(routeTargets("voxtype", "sourceLost"), ["voice", "typeless"]);
  assert.deepEqual(routeTargets("voxtype", "micDown"), ["voice"]);
  assert.deepEqual(routeTargets("voxtype", "micUp"), ["voice"]);
  assert.deepEqual(routeTargets("voxtype", "reset"), ["voice"]);
  assert.deepEqual(routeTargets("typeless", "state"), ["typeless"]);
  assert.deepEqual(routeTargets("typeless", "sourceLost"), ["typeless"]);
  assert.deepEqual(routeTargets("typeless", "micDown"), ["typeless"]);
  assert.deepEqual(routeTargets("typeless", "micUp"), []);
  assert.deepEqual(routeTargets("typeless", "reset"), ["typeless"]);
});

test("tapOutcome maps the keytap exit codes and the runner's own codes", () => {
  assert.deepEqual(tapOutcome(0), { outcome: "sent", reason: "" });
  assert.equal(tapOutcome(2).outcome, "notSent");
  assert.deepEqual(tapOutcome(3), { outcome: "notSent", reason: "keytap not running" });
  assert.equal(tapOutcome(127).outcome, "notSent");
  for (const c of [4, 5, 124, 137, 1, 64]) assert.equal(tapOutcome(c).outcome, "unknown", "code " + c);
  assert.equal(tapOutcome(124).reason, "keytap timed out");
});

test("reloadNeedsDrain: engine, mic or hotkey changes drain; anything else does not", () => {
  const base = cfg();
  assert.equal(reloadNeedsDrain(base, cfg({ engine: "typeless" })), true);
  assert.equal(reloadNeedsDrain(base, cfg({ mic: "system" })), true);
  assert.equal(reloadNeedsDrain(base, cfg({ typeless: { hotkey: "RightCtrl+Space" } })), true);
  assert.equal(reloadNeedsDrain(base, cfg({ maxSessionSec: 120 })), false);
  assert.equal(reloadNeedsDrain(null, base), false);
});

test("switch Voxtype → Typeless while a remote hold records: Voxtype stops and transcribes before the commit", () => {
  const h = makeHost("voxtype");
  h.state(true, 0);                                         // Voxtype session starts (dbus-owned)
  const start = h.fx.voice.find(e => e.type === "cmd" && e.kind === "start");
  h.apply("voice", h.voice.cmdExit(start.id, 0, 10), 10);
  h.apply("voice", h.voice.status("recording", 20), 20);
  assert.equal(h.begin("typeless", 100).ok, true);
  assert.deepEqual(h.voxCmds(), ["start", "stop"]);
  assert.equal(h.commits().length, 0, "not before Voxtype has the whole utterance");
  assert.equal(h.taps().length, 0);
  const stop = h.fx.voice.find(e => e.type === "cmd" && e.kind === "stop");
  h.apply("voice", h.voice.cmdExit(stop.id, 0, 150), 150);
  assert.equal(h.commits().length, 0, "stopping: Voxtype may still be capturing");
  h.apply("voice", h.voice.status("transcribing", 300), 300);
  assert.equal(h.commits().length, 1);
  assert.equal(h.config.voice.engine, "typeless");
  assert.equal(h.taps().length, 0, "the hold that began under Voxtype never starts Typeless");
  h.state(false, 400);
  h.state(true, 500);
  assert.deepEqual(h.taps().map(t => t.kind), ["start"]);
  assert.deepEqual(h.voxCmds(), ["start", "stop"], "VoiceSession heard nothing under Typeless");
});

test("switch Typeless → Voxtype while a remote hold records: Typeless is stopped before the commit", () => {
  const h = makeHost("typeless");
  h.state(true, 0);
  h.tapResult(1, "sent", 20);
  h.begin("voxtype", 100);
  assert.deepEqual(h.taps().map(t => t.kind), ["start", "stop"]);
  assert.equal(h.commits().length, 0, "the stop tap is still outstanding");
  h.tapResult(2, "sent", 150);
  assert.equal(h.commits().length, 1);
  assert.equal(h.config.voice.engine, "voxtype");
  h.state(false, 200);
  h.state(true, 300);
  assert.deepEqual(h.voxCmds(), ["start"], "Voxtype takes the next hold");
  assert.equal(h.taps().length, 2, "dormant Typeless sends nothing");
});

test("a switch whose Typeless tap never answers commits at 3 s with Typeless unsynced, and still sends no second tap", () => {
  const h = makeHost("typeless");
  h.state(true, 0);                                         // start tap 1 never answered
  h.begin("voxtype", 10);
  h.advance(10 + DRAIN_MS - 1);
  assert.equal(h.commits().length, 0);
  h.advance(10 + DRAIN_MS);
  assert.equal(h.commits().length, 1);
  assert.equal(h.config.voice.engine, "voxtype");
  assert.equal(h.typeless.snapshot().typeless, "unsynced");
  assert.ok(h.fx.typeless.some(e => e.type === "hud" && e.text === "Typeless may still be recording"));
  h.tapResult(1, "sent", 4000);
  assert.equal(h.taps().length, 1);
});

test("review focus 2: a second switch request while one drains is refused, and the first target wins", () => {
  const h = makeHost("typeless");
  h.state(true, 0); h.tapResult(1, "sent", 10);
  assert.equal(h.begin("voxtype", 100).ok, true);
  assert.deepEqual(h.begin("typeless", 110), { ok: false, reason: "busy", effects: [] });
  h.tapResult(2, "sent", 150);
  assert.equal(h.config.voice.engine, "voxtype");
  assert.equal(h.commits().length, 1);
});

test("an external reload that changes the hotkey mid-session drains with the captured chord, then uses the new one", () => {
  const h = makeHost("typeless");
  h.state(true, 0); h.tapResult(1, "sent", 10);
  const next = cfg({ engine: "typeless", typeless: { hotkey: "RightCtrl+Space" } });
  assert.equal(reloadNeedsDrain(h.typeless.config(), next), true);
  h.reload(next, 100);
  const stop = h.taps()[1];
  assert.deepEqual([stop.kind, stop.chord], ["stop", "RightAlt"]);
  h.tapResult(2, "sent", 120);
  assert.equal(h.commits().length, 1);
  assert.equal(h.typeless.config().voice.typeless.hotkey, "RightCtrl+Space");
  h.state(false, 200); h.state(true, 300);
  assert.deepEqual([h.taps()[2].kind, h.taps()[2].chord], ["start", "RightCtrl+Space"]);
});

test("a switch made while idle commits at once, in the same call", () => {
  const h = makeHost("voxtype");
  h.begin("typeless", 10);
  assert.equal(h.commits().length, 1);
  assert.equal(h.voice.snapshot().draining, false, "the commit came after the drain, not before it");
  assert.deepEqual(h.typeless.snapshot().quiesced, []);
});

test("review: shell start under Voxtype with the button already streaming sends no tap at all", () => {
  const s = createTypelessSession(cfg());
  const fx = startTypeless(s, "voxtype", "streaming", 0);
  assert.equal(fx.filter(e => e.type === "tap").length, 0);
  assert.equal(s.snapshot().trusted, true, "the State was taken in");
  assert.equal(s.snapshot().needRelease, true, "the hold that began before the shell never starts Typeless later");
  assert.deepEqual(s.snapshot().quiesced, ["dormant"]);
});

test("shell start: under Typeless a streaming seed starts (discriminating); a released seed arms nothing; no source seeds nothing", () => {
  const t = createTypelessSession(cfg({ engine: "typeless" }));
  assert.deepEqual(startTypeless(t, "typeless", "streaming", 0).filter(e => e.type === "tap").map(e => e.kind), ["start"]);
  const r = createTypelessSession(cfg());
  startTypeless(r, "voxtype", "connected", 0);
  assert.equal(r.snapshot().needRelease, false);
  const n = createTypelessSession(cfg());
  startTypeless(n, "voxtype", null, 0);
  assert.equal(n.snapshot().trusted, false);
});

test("micVoiceView: under Typeless, MicApply sees a busy session until TypelessSession is settled", () => {
  const voice = createVoiceSession(cfg());
  const typeless = createTypelessSession(cfg({ engine: "typeless" }));
  let engine = "typeless";
  const view = micVoiceView(voice, typeless, () => engine);
  assert.equal(view.snapshot().state, "idle");
  typeless.streaming(true, 0);                               // start tap outstanding
  assert.equal(view.snapshot().state, "typeless-busy");
  engine = "voxtype";
  assert.equal(view.snapshot().state, "idle", "under Voxtype only VoiceSession counts");
  assert.equal(view.gate, voice.gate);
});

test("a mic apply under Typeless waits for settled, then rolls back without a tap", () => {
  const h = makeHost("typeless");
  h.state(true, 0); h.tapResult(1, "sent", 10);             // Typeless on, button held
  const mic = createMicApply({ voice: micVoiceView(h.voice, h.typeless, () => h.config.voice.engine) });
  h.apply("typeless", h.typeless.quiesce(20, "mic", "changing microphone"), 20);   // Service quiesces before request()
  assert.deepEqual(h.taps().map(t => t.kind), ["start", "stop"]);
  const req = mic.request("system", 21, {});
  assert.equal(req.result.ok, true);
  mic.systemdJob(false, 22);
  const blocked = mic.backend("idle", 23, { fresh: true });
  assert.equal(blocked.some(e => e.type === "cmd"), false, "nothing mutates while a Typeless tap is in flight");
  h.tapResult(2, "sent", 40);                               // settled
  const go = mic.advance(41);
  const get = go.find(e => e.type === "cmd" && e.kind === "get");
  assert.ok(get, "the reservation proceeds once settled");
  const lit = JSON.stringify({ value: "atvvoice-xiaomi", file_value: "atvvoice-xiaomi" });
  const set = mic.cmdExit(get.id, 0, lit, 50).find(e => e.type === "cmd" && e.kind === "set");
  const rb = mic.cmdExit(set.id, 1, "", 60).find(e => e.type === "cmd" && e.kind === "get");   // set fails → rollback
  const done = mic.cmdExit(rb.id, 0, lit, 70).find(e => e.type === "done");
  assert.equal(done.state, "failed");
  assert.equal(h.taps().length, 2, "rollback never taps");
  h.apply("typeless", h.typeless.resume(80, "mic"), 80);    // Service resumes after the terminal outcome
  assert.equal(h.taps().length, 2, "the still-held button does not restart");
});
