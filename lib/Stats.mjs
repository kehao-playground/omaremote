// Spec §5.5: local-only session stats; no audio or text is ever stored.
const WEEK_MS = 7 * 86400000;

export function createStats(initial = []) {
  const entries = Array.isArray(initial) ? initial.filter(valid) : [];
  function valid(s) {
    return !!s && typeof s === "object" && typeof s.startedAt === "number" && Number.isFinite(s.startedAt) && typeof s.durationSec === "number" && s.durationSec >= 0;
  }
  const bucket = (list) => ({ count: list.length, seconds: list.reduce((a, s) => a + s.durationSec, 0) });
  return {
    add(session) { if (valid(session)) entries.push({ ...session }); return entries; },
    entries() { return entries.slice(); },
    summary(now) {
      const d = new Date(now); d.setHours(0, 0, 0, 0);
      const dayStart = d.getTime(), dayEnd = dayStart + 86400000;
      const today = entries.filter(s => s.startedAt >= dayStart && s.startedAt < dayEnd);
      const week = entries.filter(s => s.startedAt > now - WEEK_MS && s.startedAt <= now);
      let longest = null;
      for (const s of entries) if (!longest || s.durationSec > longest.durationSec) longest = { durationSec: s.durationSec, startedAt: s.startedAt };
      return { today: bucket(today), week: bucket(week), all: bucket(entries), longest };
    },
  };
}
