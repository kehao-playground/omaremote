// Typeless spec §4.3: serialized, never-merged config writes, and watcher notifications that only trigger a re-read.
// Pure: ConfigStore.qml performs the effects ({type:"setText", seq, text}, {type:"reload"}) and reports each write's
// outcome by seq; one FileView per write gives the signals that identity. Exactly one write is in flight. A report for
// a seq that is not in flight is a late answer to a write already resolved (e.g. failed by the save watchdog).
export const MAX_PENDING = 8;     // in flight + queued
export const KEEP = 16;           // outcomes published as status.configWrites

export function createConfigWrites() {
  let seq = 0;
  const queue = [];               // [{ seq, text }]; queue[0] is in flight while `inFlight`
  let inFlight = false;
  let dirty = false;              // a watcher event or a failure happened while busy: re-read once idle
  const log = [];                 // [{ seq, text, state, reason }], oldest first, at most KEEP

  const busy = () => inFlight || queue.length > 0;
  function startNext() {
    if (inFlight || queue.length === 0) return [];
    inFlight = true;
    return [{ type: "setText", seq: queue[0].seq, text: queue[0].text }];
  }
  function resolve(s, state, reason) {
    if (!inFlight || queue[0].seq !== s) return [];   // not the write in flight: a late answer resolves nothing
    const w = queue.shift();
    inFlight = false;
    for (const e of log) if (e.seq === w.seq) { e.state = state; e.reason = reason; }
    if (state === "failed") dirty = true;         // memory may now be ahead of disk
    const out = startNext();
    if (out.length === 0 && dirty) { dirty = false; out.push({ type: "reload" }); }
    return out;
  }

  return {
    request(text) {
      if (queue.length >= MAX_PENDING) return { ok: false, reason: "too many pending config writes", effects: [] };
      const s = ++seq;
      queue.push({ seq: s, text });
      log.push({ seq: s, text, state: "pending", reason: "" });
      while (log.length > KEEP) log.shift();
      return { ok: true, seq: s, effects: startNext() };
    },
    saved(s) { return resolve(s, "saved", ""); },
    failed(s, reason) { return resolve(s, "failed", String(reason)); },
    inFlightSeq() { return inFlight ? queue[0].seq : 0; },
    notify() {
      if (busy()) { dirty = true; return []; }
      return [{ type: "reload" }];
    },
    // Equal text cannot tell who wrote a file, so there is no history check: once idle, the current disk text
    // either equals memory (nothing to do, including a late echo of our own write) or is adopted.
    diskRead(text, memText) {
      if (busy()) { dirty = true; return false; }
      return text !== memText;
    },
    busy,
    saves() { const o = {}; for (const e of log) o[String(e.seq)] = e.state; return o; },
    errors() { const o = {}; for (const e of log) if (e.state === "failed") o[String(e.seq)] = e.reason; return o; },
    lastCarrying(pred) {
      for (let i = log.length - 1; i >= 0; i--) if (pred(log[i].text)) return { seq: log[i].seq, state: log[i].state };
      return null;
    },
  };
}

// §4.3: what `typelessHotkey <chord>` does. `last` is lastCarrying() for the requested value.
export function hotkeyWritePlan(storedCanonical, requested, last) {
  if (storedCanonical !== requested) return { write: true, seq: null };
  if (last && last.state === "pending") return { write: false, seq: last.seq };
  if (last && last.state === "failed") return { write: true, seq: null };
  return { write: false, seq: null };
}
