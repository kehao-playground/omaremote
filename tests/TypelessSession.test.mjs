import { test } from "node:test";
import assert from "node:assert/strict";
import { createTypelessSession, HUD } from "../lib/TypelessSession.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";

// pressWaitMs 0 unless a test sets it: these tests pin the reconcile rules; the press gate has its own tests below.
const cfg = (voice = {}) => normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, engine: "typeless", ...voice,
  typeless: { pressWaitMs: 0, ...(voice.typeless || {}) } } }).config;
const sys = (voice = {}) => cfg({ mic: "system", ...voice });
const taps = (fx) => fx.filter(e => e.type === "tap");
const huds = (fx) => fx.filter(e => e.type === "hud").map(e => e.text);

// Records every effect so a test can assert across a whole interleaving.
function rig(c = cfg()) {
  const s = createTypelessSession(c);
  const all = [];
  const rec = (fx) => { all.push(...fx); return fx; };
  return {
    s, all,
    on: (t) => rec(s.streaming(true, t)),
    off: (t) => rec(s.streaming(false, t)),
    lost: (t) => rec(s.sourceLost(t)),
    press: (t) => rec(s.hidPress(t)),
    reset: (t) => rec(s.reset(t)),
    quiesce: (t, holder = "switch", why = "switching engine") => rec(s.quiesce(t, holder, why)),
    resume: (t, holder = "switch") => rec(s.resume(t, holder)),
    force: (t) => rec(s.forceUnsynced(t)),
    advance: (t) => rec(s.advance(t)),
    set: (c2, t) => rec(s.setConfig(c2, t)),
    res: (id, outcome, t, reason = "") => rec(s.tapResult(id, outcome, reason, t)),
    taps: () => taps(all),
    kinds: () => taps(all).map(e => e.kind),
    lastTap: () => { const l = taps(all); return l[l.length - 1]; },
    snap: () => s.snapshot(),
  };
}

// ---- remote mode (§5.2) ----------------------------------------------------------

test("a hold sends one start tap with the configured hotkey and its release one stop tap", () => {
  const r = rig();
  assert.deepEqual(taps(r.on(0)), [{ type: "tap", id: 1, chord: "RightAlt", kind: "start" }]);
  r.res(1, "sent", 30);
  assert.equal(r.snap().typeless, "on");
  assert.deepEqual(taps(r.off(500)).map(t => [t.id, t.kind, t.chord]), [[2, "stop", "RightAlt"]]);
  r.res(2, "sent", 530);
  assert.equal(r.snap().typeless, "off");
  assert.deepEqual(r.kinds(), ["start", "stop"]);
});

test("shell start before ATVVoice reports: streaming is unknown, nothing is armed, and the first read of streaming starts", () => {
  const r = rig();
  assert.equal(r.snap().trusted, false);
  assert.equal(r.snap().needRelease, false);
  assert.deepEqual(taps(r.on(0)).map(t => t.kind), ["start"]);
});

test("shell start with the button released: the first trusted false arms nothing and the first hold starts", () => {
  const r = rig();
  assert.deepEqual(taps(r.off(0)), []);
  assert.deepEqual(taps(r.on(100)).map(t => t.kind), ["start"]);
});

test("release during start, re-press before the result: the start is honoured and nothing more is sent", () => {
  const r = rig();
  r.on(0); r.off(10); r.on(20);
  assert.deepEqual(taps(r.res(1, "sent", 30)), []);
  assert.equal(r.snap().typeless, "on");
  assert.equal(r.taps().length, 1, "the second hold continues the same Typeless recording");
  assert.deepEqual(taps(r.off(40)).map(t => t.kind), ["stop"]);
});

test("release during start: the start result is followed by exactly one stop", () => {
  const r = rig();
  r.on(0); r.off(10);
  assert.deepEqual(taps(r.res(1, "sent", 30)).map(t => [t.id, t.kind]), [[2, "stop"]]);
});

test("start notSent: HUD with the reason, nothing more is sent, and no stop follows a start that did not happen", () => {
  const r = rig();
  r.on(0);
  const fx = r.res(1, "notSent", 20, "keytap not running");
  assert.deepEqual(huds(fx), ["Typeless trigger failed: keytap not running"]);
  assert.equal(r.snap().typeless, "off");
  assert.equal(r.snap().needRelease, true, "no retry within this hold");
  r.off(100);
  assert.equal(r.taps().length, 1, "no stop");
  r.on(200);
  assert.deepEqual(r.kinds(), ["start", "start"], "the next hold starts");
});

test("release first, then start notSent: the trusted false makes arming a no-op and the next hold starts", () => {
  const r = rig();
  r.on(0); r.off(10);
  r.res(1, "notSent", 20, "keytap not running");
  assert.equal(r.snap().needRelease, false);
  assert.deepEqual(taps(r.on(30)).map(t => t.kind), ["start"]);
});

test("re-press during stop: the stop result is followed by a new start", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  r.off(100);                                  // stop 2
  r.on(110);
  assert.deepEqual(taps(r.res(2, "sent", 130)).map(t => [t.id, t.kind]), [[3, "start"]]);
});

test("reset mid-hold stops; the still-held button does not restart; the next hold starts", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  assert.deepEqual(taps(r.reset(100)).map(t => t.kind), ["stop"]);
  assert.deepEqual(taps(r.res(2, "sent", 120)), []);
  assert.equal(r.snap().needRelease, true);
  r.off(300);
  assert.deepEqual(taps(r.on(400)).map(t => t.kind), ["start"]);
});

test("the maxSessionSec deadline stops with HUD, the held button does not restart, the next hold starts", () => {
  const r = rig(cfg({ maxSessionSec: 5 }));
  r.on(0); r.res(1, "sent", 10);
  assert.equal(r.s.nextDeadline(), 5000);
  assert.deepEqual(taps(r.advance(4999)), []);
  const fx = r.advance(5000);
  assert.deepEqual(huds(fx), ["max session reached"]);
  assert.deepEqual(taps(fx).map(t => t.kind), ["stop"]);
  r.res(2, "sent", 5020);
  assert.equal(r.s.nextDeadline(), null);
  assert.equal(r.taps().length, 2);
  r.off(6000);
  assert.deepEqual(taps(r.on(6100)).map(t => t.kind), ["start"]);
});

test("a maxSessionSec shorter than the start reply: the bound fires while the start is in flight, and the late sent stops", () => {
  const r = rig(cfg({ maxSessionSec: 1 }));
  r.on(0);                                       // start 1 in flight
  assert.equal(r.s.nextDeadline(), 1000, "scheduled before the start result arrives");
  const fx = r.advance(1000);
  assert.deepEqual(huds(fx), ["max session reached"]);
  assert.deepEqual(taps(fx), [], "single flight: nothing more while the start is outstanding");
  assert.equal(r.snap().needRelease, true);
  assert.equal(r.s.nextDeadline(), null);
  assert.deepEqual(taps(r.res(1, "sent", 1500)).map(t => t.kind), ["stop"], "the late success reconciles into a stop");
  r.res(2, "sent", 1520);
  assert.equal(r.taps().length, 2, "the still-held button does not restart");
});

test("streaming off during start, then start unknown → unsynced, and no stop is ever emitted", () => {
  const r = rig();
  r.on(0); r.off(10);
  assert.deepEqual(huds(r.res(1, "unknown", 20)), [HUD.unknown]);
  assert.equal(r.snap().typeless, "unsynced");
  assert.deepEqual(huds(r.on(30)), [HUD.unknown], "streaming on only repeats the HUD");
  r.off(40); r.advance(1e9);
  assert.equal(r.taps().length, 1);
});

test("reset while starting: the start result is still honoured, and if sent exactly one stop follows", () => {
  const r = rig();
  r.on(0);
  assert.deepEqual(taps(r.reset(10)), []);
  assert.deepEqual(taps(r.res(1, "sent", 20)).map(t => t.kind), ["stop"]);
  r.res(2, "sent", 40);
  assert.equal(r.taps().length, 2);
});

test("re-press during stop, then stop notSent → unsynced and no start", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  r.off(100); r.on(110);
  const fx = r.res(2, "notSent", 130, "keytap not running");
  assert.deepEqual(taps(fx), []);
  assert.equal(r.snap().typeless, "unsynced");
  assert.deepEqual(huds(fx), [HUD.unknown]);
});

test("stale results: a duplicate report for a resolved id and a never-issued id are both ignored", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  const before = JSON.stringify(r.snap());
  assert.deepEqual(r.res(1, "sent", 20), []);
  assert.deepEqual(r.res(99, "unknown", 30), []);
  assert.equal(JSON.stringify(r.snap()), before);
});

test("a hotkey change while on: the stop uses the captured chord, the next session the new one", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  r.set(cfg({ typeless: { hotkey: "RightCtrl+Space" } }), 50);
  assert.equal(taps(r.off(100))[0].chord, "RightAlt");
  r.res(2, "sent", 120);
  assert.equal(taps(r.on(300))[0].chord, "RightCtrl+Space");
});

test("unsynced is left only through reset, and reset re-arms nothing once released", () => {
  const r = rig();
  r.on(0); r.res(1, "unknown", 10);
  r.off(20); r.on(30); r.off(40); r.advance(1e9); r.set(cfg(), 45);
  assert.equal(r.snap().typeless, "unsynced");
  assert.equal(r.taps().length, 1);
  r.reset(50);
  assert.equal(r.snap().typeless, "off");
  assert.equal(r.snap().needRelease, false, "trusted streaming is false: arming is a no-op");
  assert.deepEqual(taps(r.on(60)).map(t => t.kind), ["start"]);
});

test("ATVVoice restarts mid-hold: the lost source stops Typeless and nothing starts until a trusted release", () => {
  const r = rig();
  r.on(0); r.res(1, "sent", 10);
  assert.deepEqual(taps(r.lost(100)).map(t => t.kind), ["stop"], "the audio source is gone");
  r.res(2, "sent", 120);
  assert.deepEqual(taps(r.on(200)), [], "the new source reports the old hold");
  assert.equal(r.snap().needRelease, true);
  r.off(300);
  assert.deepEqual(taps(r.on(400)).map(t => t.kind), ["start"]);
});

test("single flight: however the button moves, no second tap is sent while one is outstanding", () => {
  const r = rig();
  r.on(0); r.off(1); r.on(2); r.off(3); r.on(4);
  assert.equal(r.taps().length, 1);
});

test("review focus 1: five short presses with late results never overlap taps and end off with alternating taps", () => {
  const r = rig();
  let t = 0;
  const pending = [];
  const collect = (fx) => { for (const e of taps(fx)) pending.push(e); };
  for (let i = 0; i < 5; i++) {
    collect(r.on(t += 50));
    collect(r.off(t += 120));
    if (i % 2 === 1) while (pending.length) { const e = pending.shift(); collect(r.res(e.id, "sent", t += 10)); }
    assert.ok(pending.length <= 1, "never more than one tap in flight");
  }
  while (pending.length) { const e = pending.shift(); collect(r.res(e.id, "sent", t += 10)); }
  assert.equal(r.snap().typeless, "off");
  assert.equal(r.snap().outstanding, null);
  r.kinds().forEach((k, i) => assert.equal(k, i % 2 === 0 ? "start" : "stop", `tap ${i}`));
  assert.equal(r.kinds().length % 2, 0);
});

test("hidPress does nothing in remote mode", () => {
  const r = rig();
  assert.deepEqual(r.press(0), []);
});

// ---- system mode (§5.3) -----------------------------------------------------------

test("system: each press is one tap with the current hotkey; streaming is ignored", () => {
  const r = rig(sys());
  assert.deepEqual(taps(r.press(0)), [{ type: "tap", id: 1, chord: "RightAlt", kind: "press" }]);
  assert.deepEqual(taps(r.on(5)), []);
  r.res(1, "sent", 30);
  assert.deepEqual(taps(r.press(100)).map(t => t.id), [2]);
});

test("system: five rapid presses send one plus three queued; the fifth is dropped with HUD", () => {
  const r = rig(sys());
  for (let i = 0; i < 5; i++) r.press(i);
  assert.equal(r.taps().length, 1);
  assert.deepEqual(r.all.filter(e => e.type === "hud").map(e => e.text), ["too fast — press ignored"]);
  assert.equal(taps(r.res(1, "sent", 10)).length, 1);
  assert.equal(taps(r.res(2, "sent", 20)).length, 1);
  assert.equal(taps(r.res(3, "sent", 30)).length, 1);
  assert.deepEqual(taps(r.res(4, "sent", 40)), []);
  assert.equal(r.taps().length, 4);
});

test("system: a mid-FIFO unknown or notSent clears the remaining presses", () => {
  for (const outcome of ["unknown", "notSent"]) {
    const r = rig(sys());
    r.press(0); r.press(1); r.press(2);
    const fx = r.res(1, outcome, 10, "keytap not running");
    assert.deepEqual(huds(fx), ["Typeless trigger failed; check Typeless before pressing again"], outcome);
    assert.deepEqual(taps(fx), [], outcome);
    assert.equal(r.snap().queued, 0, outcome);
  }
});

test("review focus 3: queued system presses keep the chord that was current when they were pressed", () => {
  const r = rig(sys());
  r.press(0); r.press(1); r.press(2);
  r.set(sys({ typeless: { hotkey: "RightCtrl+Space" } }), 3);
  assert.equal(taps(r.res(1, "sent", 10))[0].chord, "RightAlt");
  assert.equal(taps(r.res(2, "sent", 20))[0].chord, "RightAlt");
  r.res(3, "sent", 30);
  assert.equal(taps(r.press(40))[0].chord, "RightCtrl+Space");
});

test("system: reset and quiesce clear the FIFO; the outstanding press finishes and is honoured", () => {
  const a = rig(sys());
  a.press(0); a.press(1); a.press(2);
  a.reset(5);
  assert.equal(a.snap().queued, 0);
  assert.deepEqual(taps(a.res(1, "sent", 10)), []);
  const b = rig(sys());
  b.press(0); b.press(1);
  b.quiesce(5);
  assert.equal(b.snap().queued, 0);
  assert.equal(b.s.settled(), false, "the outstanding press is still in flight");
  b.res(1, "sent", 10);
  assert.equal(b.s.settled(), true);
  assert.equal(b.taps().length, 1);
});

test("system never taps on streaming, source loss, a deadline, reset or quiesce after an active-looking history (discriminating)", () => {
  const history = (r) => {
    r.on(1000); r.off(1100); r.on(1200); r.lost(1300); r.on(1400); r.advance(1e9);
    r.reset(1500); r.quiesce(1600); r.resume(1700); r.on(1800); r.off(1900);
  };
  const s = rig(sys());
  s.press(0); s.res(1, "sent", 10);             // Typeless is now really recording
  history(s);
  assert.equal(s.taps().length, 1);
  const m = rig();
  history(m);
  assert.ok(m.taps().length > 0, "the same history does tap in remote mode, so the check above can fail");
});

// ---- quiesce, switch timeout, dormancy, shell exit (§6.1, §6.2) ------------------

test("quiesce while starting: started then stopped, settled, resumed; a re-press works only after a release", () => {
  const r = rig();
  r.on(0);
  r.quiesce(10);
  assert.equal(r.s.settled(), false);
  assert.deepEqual(taps(r.res(1, "sent", 20)).map(t => t.kind), ["stop"]);
  r.res(2, "sent", 40);
  assert.equal(r.s.settled(), true);
  r.resume(50);
  assert.equal(r.taps().length, 2, "the still-held button does not restart");
  r.off(60);
  assert.deepEqual(taps(r.on(70)).map(t => t.kind), ["start"]);
});

test("engine switch while idle and released, then switch back: the first hold afterwards starts", () => {
  const r = rig();
  r.off(0);
  r.quiesce(10); r.resume(20);
  r.quiesce(30); r.resume(40);
  assert.equal(r.snap().needRelease, false);
  assert.deepEqual(taps(r.on(50)).map(t => t.kind), ["start"]);
});

test("while quiesced, streaming on and a press only show the pause reason; a silent holder shows nothing", () => {
  const r = rig();
  r.off(0); r.quiesce(1, "mic", "changing microphone");
  assert.deepEqual(huds(r.on(2)), ["dictation paused: changing microphone"]);
  assert.equal(r.taps().length, 0);
  const d = rig();
  d.quiesce(0, "dormant", "");
  assert.deepEqual(huds(d.on(1)), []);
  const p = rig(sys());
  p.quiesce(0);
  assert.deepEqual(huds(p.press(1)), ["dictation paused: switching engine"]);
  assert.equal(p.taps().length, 0);
});

test("holders are independent: resuming one keeps the session quiesced while another holds", () => {
  const r = rig();
  r.off(0);
  r.quiesce(1, "mic", "changing microphone"); r.quiesce(2, "switch", "switching engine");
  r.resume(3, "switch");
  assert.deepEqual(r.snap().quiesced, ["mic"]);
  assert.deepEqual(taps(r.on(4)), []);
  r.off(5); r.resume(6, "mic");
  assert.deepEqual(taps(r.on(7)).map(t => t.kind), ["start"]);
});

test("switch timeout while a tap is outstanding: no second tap; reset refused until it resolves; then reset → off", () => {
  const r = rig();
  r.on(0);                                       // start 1, never answered in time
  r.quiesce(10);
  assert.deepEqual(huds(r.force(3010)), ["Typeless may still be recording"]);
  assert.equal(r.snap().typeless, "unsynced");
  assert.deepEqual(huds(r.reset(3020)), [HUD.pendingReset]);
  assert.equal(r.snap().typeless, "unsynced");
  const late = r.res(1, "sent", 3100);
  assert.deepEqual(taps(late), []);
  assert.equal(late.filter(e => e.type === "log").length, 1, "a result in unsynced is only logged");
  assert.equal(r.snap().typeless, "unsynced");
  r.reset(3200);
  assert.equal(r.snap().typeless, "off");
  assert.equal(r.taps().length, 1, "no second tap was ever issued");
});

test("settled: no tap outstanding, nothing queued, and Typeless not believed on", () => {
  const r = rig();
  assert.equal(r.s.settled(), true);
  r.on(0);
  assert.equal(r.s.settled(), false, "start outstanding");
  r.res(1, "sent", 10);
  assert.equal(r.s.settled(), false, "on");
  const u = rig();
  u.on(0); u.res(1, "unknown", 10);
  assert.equal(u.s.settled(), true, "unsynced with nothing outstanding");
  const p = rig(sys());
  p.press(0);
  assert.equal(p.s.settled(), false);
});

test("shell exit stops only an `on` remote session with nothing outstanding", () => {
  const r = rig();
  assert.equal(r.s.exitStop(), null);
  r.on(0);
  assert.equal(r.s.exitStop(), null, "start outstanding: a stop could itself start a recording");
  r.res(1, "sent", 10);
  assert.equal(r.s.exitStop(), "RightAlt");
  r.off(20);
  assert.equal(r.s.exitStop(), null, "stop outstanding");
  const u = rig();
  u.on(0); u.res(1, "unknown", 10);
  assert.equal(u.s.exitStop(), null, "unsynced");
  const p = rig(sys());
  p.press(0); p.res(1, "sent", 10);
  assert.equal(p.s.exitStop(), null, "system mode keeps no state");
});

test("dormant under Voxtype: hold, then release, then switch to Typeless → the first hold starts", () => {
  const r = rig();
  r.quiesce(0, "dormant", "");
  r.on(10); r.off(500);
  r.resume(600, "dormant");
  assert.equal(r.taps().length, 0);
  assert.deepEqual(taps(r.on(700)).map(t => t.kind), ["start"]);
});

test("dormant under Voxtype: ATVVoice restarts; a new source reporting not streaming lets the first hold start", () => {
  const r = rig();
  r.quiesce(0, "dormant", ""); r.off(1);
  r.lost(10); r.off(20);
  r.resume(30, "dormant");
  assert.deepEqual(taps(r.on(40)).map(t => t.kind), ["start"]);
});

test("dormant under Voxtype: a new source reporting streaming (held across the switch) waits for a release", () => {
  const r = rig();
  r.quiesce(0, "dormant", ""); r.off(1);
  r.lost(10); r.on(20);
  r.resume(30, "dormant");
  assert.equal(r.taps().length, 0);
  r.off(40);
  assert.deepEqual(taps(r.on(50)).map(t => t.kind), ["start"]);
});

test("dormant under Voxtype: a long history never taps (discriminating: the same history resumed does)", () => {
  const history = (r) => {
    for (let i = 0; i < 5; i++) { r.on(i * 100 + 10); r.off(i * 100 + 60); if (i === 2) r.lost(i * 100 + 70); }
    r.on(1000);
  };
  const d = rig();
  d.quiesce(0, "dormant", "");
  history(d);
  assert.equal(d.taps().length, 0);
  const live = rig();
  history(live);
  assert.ok(live.taps().length > 0);
});

test("a state effect carries the snapshot only when it changed", () => {
  const r = rig();
  const fx = r.on(0);
  const st = fx.filter(e => e.type === "state");
  assert.equal(st.length, 1);
  assert.deepEqual(st[0].state.outstanding, { id: 1, kind: "start" });
  assert.equal(st[0].state.since, 0);
  assert.equal(r.res(99, "sent", 1).length, 0, "a stale result changes nothing and emits nothing");
});

// ---- hardware acceptance 2026-10-14: the remote's HID press must not land inside the start tap ----
// The remote sends two signals per hold: the ATVV stream and an HID press (keyd → one XF86Xfer pulse). Their order
// varies. Typeless ignores RightAlt when another key's event falls between its down and up, so in remote mode the
// start tap waits until the press has been seen, or pressWaitMs has passed.
const gated = (voice = {}) => cfg({ typeless: { hotkey: "RightAlt", pressWaitMs: 250 }, ...voice });

test("press gate: stream before the HID press → the start waits for the press, then taps", () => {
  const r = rig(gated());
  r.off(0); r.press(-1000);                                   // seed: trusted, released, an old press long ago
  assert.deepEqual(taps(r.on(1000)), [], "the stream arrived first: no tap while the press is still due");
  assert.equal(r.s.nextDeadline(), 1250);
  assert.deepEqual(taps(r.press(1030)).map(t => t.kind), ["start"], "the press has passed: start now");
  assert.equal(r.s.nextDeadline(), 1030 + 60000, "only the session bound remains");
});

test("press gate: HID press before the stream → the start taps at once", () => {
  const r = rig(gated());
  r.off(0);
  assert.deepEqual(r.press(1000), [], "a press with no stream does nothing in remote mode");
  assert.deepEqual(taps(r.on(1040)).map(t => t.kind), ["start"]);
});

test("press gate: no HID press at all → the start taps when pressWaitMs runs out", () => {
  const r = rig(gated());
  r.off(0);
  assert.deepEqual(taps(r.on(1000)), []);
  assert.deepEqual(taps(r.advance(1249)), []);
  assert.deepEqual(taps(r.advance(1250)).map(t => t.kind), ["start"]);
});

test("press gate: a press from an earlier hold does not open the gate for a later stream", () => {
  const r = rig(gated());
  r.off(0);
  r.press(1000); r.on(1010);                                  // hold 1 starts at once
  r.res(1, "sent", 1100); r.off(2000); r.res(2, "sent", 2100);
  assert.deepEqual(taps(r.on(2200)), [], "hold 2's stream came first; hold 1's press was already used");
  assert.deepEqual(taps(r.press(2220)).map(t => t.kind), ["start"]);
});

test("press gate: release before the gate opens → nothing is ever tapped", () => {
  const r = rig(gated());
  r.off(0);
  r.on(1000); r.off(1100);
  assert.deepEqual(taps(r.press(1120)), []);
  assert.deepEqual(taps(r.advance(1300)), []);
  assert.equal(r.s.nextDeadline(), null);
});

test("press gate: the stop never waits for a press", () => {
  const r = rig(gated());
  r.off(0);
  r.press(1000); r.on(1010); r.res(1, "sent", 1100);
  assert.deepEqual(taps(r.off(3000)).map(t => t.kind), ["stop"]);
});

test("press gate: pressWaitMs 0 turns the gate off", () => {
  const r = rig(gated({ typeless: { hotkey: "RightAlt", pressWaitMs: 0 } }));
  r.off(0);
  assert.deepEqual(taps(r.on(1000)).map(t => t.kind), ["start"]);
});

test("press gate: system mode is unaffected (each press is still one tap)", () => {
  const r = rig(gated({ mic: "system" }));
  assert.deepEqual(taps(r.press(0)).map(t => t.kind), ["press"]);
});
