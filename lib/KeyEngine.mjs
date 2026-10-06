// Spec §4.3: per-key state machine. Pure: explicit `now`, returns effects, never spawns.
import { keyClass } from "./Config.mjs";
import { KEY_NAMES } from "./Defaults.mjs";

// phases: idle | down | held | repeating | waitDouble | consumeRelease
export function createKeyEngine(initialConfig) {
  let config = initialConfig;
  const st = {};                       // name -> { phase, deadline, stuckAt, pressedAt, releasedAt }
  const fresh = () => ({ phase: "idle", deadline: null, stuckAt: null, pressedAt: 0, releasedAt: 0 });
  const init = () => { for (const n of KEY_NAMES) st[n] = fresh(); };
  init();

  const cfg = (n) => config.keys[n];
  const timing = () => config.timing;
  // Effective due time: the earlier of the phase deadline and the absolute stuck bound.
  const due = (s) => (s.deadline === null ? s.stuckAt : s.stuckAt === null ? s.deadline : Math.min(s.deadline, s.stuckAt));
  const action = (n, trigger, act, repeat = false) => ({ type: "action", key: n, trigger, repeat, action: act });

  function clearAll() { init(); }

  function fire(n, now, out) {           // timer for key n is due
    const s = st[n], k = cfg(n), c = keyClass(k);
    // Checked before the phase switch, and emitting nothing but stuckKey: if this ran after the phase
    // logic, a timeout in `down` would be indistinguishable from a release and reported as a tap.
    if (s.stuckAt !== null && now >= s.stuckAt) {
      s.phase = "idle"; s.deadline = null; s.stuckAt = null;
      out.push({ type: "stuckKey", key: n });
      return;
    }
    s.deadline = null;
    if (s.phase === "down") {
      if (c.panic) { clearAll(); out.push({ type: "reset" }); return; }
      if (c.long) {
        if (k.hold) out.push(action(n, "hold", k.hold));
        if (k.repeat) {
          if (k.tap) out.push(action(n, "tap", k.tap, true));
          s.phase = "repeating"; s.deadline = now + timing().repeatMs;
        } else {
          s.phase = "held";
        }
      }
      return;
    }
    if (s.phase === "repeating") {
      if (k.tap) out.push(action(n, "tap", k.tap, true));
      s.deadline = now + timing().repeatMs;
      return;
    }
    if (s.phase === "waitDouble") {
      if (k.tap) out.push(action(n, "tap", k.tap));
      s.phase = "idle";
    }
  }

  function advance(now) {
    const out = [];
    // fire in deadline order so two due timers resolve deterministically
    let guard = 0;
    for (;;) {
      let best = null, bestDue = null;
      for (const n of KEY_NAMES) {
        const d = due(st[n]);
        if (d !== null && d <= now && (bestDue === null || d < bestDue)) { best = n; bestDue = d; }
      }
      if (best === null || guard++ > 1000) break;
      fire(best, bestDue, out);
      if (out.some(e => e.type === "reset")) break;
    }
    return out;
  }

  function resolvePendingDoubles(except, now, out) {
    for (const n of KEY_NAMES) {
      if (n === except) continue;
      const s = st[n];
      if (s.phase === "waitDouble") { s.deadline = null; fire(n, now, out); }
    }
  }

  function press(n, now) {
    const k = cfg(n);
    if (!k || !k.supported) return [];
    const out = advance(now);
    const s = st[n], c = keyClass(k), t = timing();
    if (s.phase === "waitDouble") {
      s.deadline = null;
      if (k.double) out.push(action(n, "double", k.double));
      s.phase = "consumeRelease";
      s.stuckAt = now + timing().stuckMs;      // physically down again; bound this press too
      return out;
    }
    if (s.phase !== "idle") return out;      // key already down: ignore repeat press events
    resolvePendingDoubles(n, now, out);
    s.pressedAt = now;
    if (c.simple) { if (k.tap) out.push(action(n, "tap", k.tap)); return out; }
    s.phase = "down";
    s.stuckAt = now + t.stuckMs;
    if (c.long) s.deadline = now + t.holdMs;
    else if (c.panic) s.deadline = now + t.panicMs;
    else s.deadline = null;                  // simple+double: no timer while down
    return out;
  }

  function release(n, now) {
    const k = cfg(n);
    if (!k || !k.supported) return [];
    const out = advance(now);
    const s = st[n], t = timing();
    switch (s.phase) {
      case "down":
        s.deadline = null;
        if (k.double) { s.phase = "waitDouble"; s.releasedAt = now; s.deadline = now + t.doubleMs; s.stuckAt = null; }
        else { s.phase = "idle"; s.stuckAt = null; if (k.tap) out.push(action(n, "tap", k.tap)); }
        break;
      case "held":
      case "repeating":
      case "consumeRelease":
        s.deadline = null; s.stuckAt = null; s.phase = "idle"; break;
      default: break;
    }
    return out;
  }

  function nextDeadline() {
    let d = null;
    for (const n of KEY_NAMES) { const x = due(st[n]); if (x !== null && (d === null || x < d)) d = x; }
    return d;
  }

  return {
    press, release, advance, nextDeadline,
    reset() { clearAll(); return [{ type: "reset" }]; },
    reload(next) { config = next; clearAll(); return []; },
    heldKeys() { return KEY_NAMES.filter(n => st[n].phase !== "idle"); },
  };
}
