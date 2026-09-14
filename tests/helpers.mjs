// Test helpers: deterministic clock and effect filters shared by all suites.
export function createClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    tick: (ms) => { t += ms; return t; },
  };
}

export function byType(effects, type) {
  return effects.filter(e => e.type === type);
}

export function last(effects, type) {
  const list = byType(effects, type);
  return list.length ? list[list.length - 1] : undefined;
}
