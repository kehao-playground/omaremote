// Mic source picker spec §4.3/§4.4: the cached capture-source list and the cache-miss rule. A node missing from the
// cache is refused only after a refresh that STARTED after its first miss has completed; ipcMic answers at once and
// the caller retries. Ids order refreshes against misses (no clock ties) and identify each refresh, so a late report
// from an abandoned probe can never finish a newer one. Pure; Service runs pw-dump.
export function createMicSources() {
  let list = [];
  let seq = 0;                       // the last refresh id issued
  let running = null;                // { id } while a refresh runs
  let requested = false;             // a start was asked for and started() has not been called yet
  let last = null;                   // { id, ok } of the last completed refresh
  let again = false;                 // start another refresh as soon as the running one ends
  const misses = new Map();          // node → the value of `seq` when its first unanswered miss was recorded
  const ask = () => { requested = true; return true; };

  return {
    list() { return list.slice(); },
    refreshing() { return running !== null || requested; },
    check(node) {
      if (list.some(s => s.name === node)) { misses.delete(node); return { verdict: "ok", refresh: false }; }
      if (!misses.has(node)) misses.set(node, seq);
      const missSeq = misses.get(node);
      if (last && last.id > missSeq) {
        misses.delete(node);
        return { verdict: last.ok ? "no-such-source" : "sources-unavailable", refresh: false };
      }
      if (requested) return { verdict: "refreshing", refresh: false };   // the refresh about to start postdates the miss
      if (running) { if (running.id <= missSeq) again = true; return { verdict: "refreshing", refresh: false }; }
      return { verdict: "refreshing", refresh: ask() };
    },
    requestRefresh() {
      if (requested) return false;
      if (running) { again = true; return false; }
      return ask();
    },
    started() { requested = false; running = { id: ++seq }; return running.id; },
    finished(id, sources) {
      if (!running || running.id !== id) return false;
      last = { id, ok: Array.isArray(sources) };
      if (Array.isArray(sources)) list = sources.slice();
      running = null;
      if (!again) return false;
      again = false;
      return ask();
    },
  };
}
