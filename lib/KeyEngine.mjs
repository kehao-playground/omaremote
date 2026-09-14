// Spec §4.3: per-key state machine. Pure: explicit `now`, returns effects, never spawns.
import { keyClass } from "./Config.mjs";
import { KEY_NAMES } from "./Defaults.mjs";

// phases: idle | down | held | repeating | waitDouble | consumeRelease
export function createKeyEngine(initialConfig) {
  let config = initialConfig;
  const st = {};                       // name -> { phase, deadline, pressedAt, releasedAt }
  const fresh = () => ({ phase: "idle", deadline: null, pressedAt: 0, releasedAt: 0 });
  const init = () => { for (const n of KEY_NAMES) st[n] = fresh(); };
  init();

  const cfg = (n) => config.keys[n];
  const timing = () => config.timing;
  const action = (n, trigger, act, repeat = false) => ({ type: "action", key: n, trigger, repeat, action: act });

  function clearAll() { init(); }

  function fire(n, now, out) {           // timer for key n is due
    const s = st[n], k = cfg(n), c = keyClass(k);
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
      let best = null;
      for (const n of KEY_NAMES) {
        const s = st[n];
        if (s.deadline !== null && s.deadline <= now && (best === null || s.deadline < st[best].deadline)) best = n;
      }
      if (best === null || guard++ > 1000) break;
      fire(best, st[best].deadline, out);
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
      return out;
    }
    if (s.phase !== "idle") return out;      // key already down: ignore repeat press events
    resolvePendingDoubles(n, now, out);
    s.pressedAt = now;
    if (c.simple) { if (k.tap) out.push(action(n, "tap", k.tap)); return out; }
    s.phase = "down";
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
        if (k.double) { s.phase = "waitDouble"; s.releasedAt = now; s.deadline = now + t.doubleMs; }
        else { s.phase = "idle"; if (k.tap) out.push(action(n, "tap", k.tap)); }
        break;
      case "held":
      case "repeating":
      case "consumeRelease":
        s.deadline = null; s.phase = "idle"; break;
      default: break;
    }
    return out;
  }

  function nextDeadline() {
    let d = null;
    for (const n of KEY_NAMES) { const s = st[n]; if (s.deadline !== null && (d === null || s.deadline < d)) d = s.deadline; }
    return d;
  }

  return {
    press, release, advance, nextDeadline,
    reset() { clearAll(); return [{ type: "reset" }]; },
    reload(next) { config = next; clearAll(); return []; },
    heldKeys() { return KEY_NAMES.filter(n => st[n].phase !== "idle"); },
  };
}
