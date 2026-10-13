// Typeless spec §3.1 (chord grammar) and §4.2 (allowlist). host/omaremote-keytap carries the same parser; both run
// tests/fixtures/chords.json, so a chord omaremote stores is exactly a chord keytap will send.
export const MODIFIERS = ["LeftCtrl", "RightCtrl", "LeftShift", "RightShift", "LeftAlt", "RightAlt", "LeftMeta", "RightMeta"];
const main = ["Space"];
for (let c = 65; c <= 90; c++) main.push(String.fromCharCode(c));
for (let d = 0; d <= 9; d++) main.push(String(d));
for (let f = 1; f <= 24; f++) main.push("F" + f);
export const MAIN_KEYS = main;

const ALIASES = { leftsuper: "LeftMeta", rightsuper: "RightMeta", leftwin: "LeftMeta", rightwin: "RightMeta",
                  leftcontrol: "LeftCtrl", rightcontrol: "RightCtrl" };
const CANON = new Map();
for (const n of MODIFIERS.concat(MAIN_KEYS)) CANON.set(n.toLowerCase(), n);
for (const k of Object.keys(ALIASES)) CANON.set(k, ALIASES[k]);

export function parseChord(text) {
  const parts = String(text === undefined || text === null ? "" : text).split("+");
  if (parts.length > 4) return { ok: false, reason: "too many names" };
  const names = [];
  for (const p of parts) {
    if (p === "") return { ok: false, reason: "empty name" };
    const c = CANON.get(p.toLowerCase());
    if (c === undefined) return { ok: false, reason: "unknown name: " + p };
    if (names.indexOf(c) >= 0) return { ok: false, reason: "duplicate name: " + c };
    names.push(c);
  }
  const mains = names.filter(n => MODIFIERS.indexOf(n) < 0);
  if (mains.length > 1) return { ok: false, reason: "two main keys" };
  const ordered = names.filter(n => MODIFIERS.indexOf(n) >= 0).concat(mains);
  return { ok: true, names: ordered, canonical: ordered.join("+"), trigger: ordered[ordered.length - 1] };
}

export function canonicalChord(text) {
  const r = parseChord(text);
  return r.ok ? r.canonical : null;
}
