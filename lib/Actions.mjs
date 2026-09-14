// Spec §4.4: closed action union; argv/dispatch mapping is data so it can be tested without spawning.
export const ACTION_TYPES = ["key", "dispatch", "volume", "media", "screen", "none"];
const MODS = ["ctrl", "shift", "alt", "super", "meta"];

export function validateAction(a) {
  const errs = [];
  if (a === null || typeof a !== "object") return ["action must be an object"];
  if (!ACTION_TYPES.includes(a.type)) return [`unknown action type "${a.type}"`];
  switch (a.type) {
    case "key": if (typeof a.keys !== "string" || !a.keys.trim()) errs.push("key.keys must be a non-empty string"); break;
    case "dispatch": if (typeof a.dispatcher !== "string" || !a.dispatcher) errs.push("dispatch.dispatcher required"); break;
    case "volume": if (!["+5", "-5", "mute"].includes(a.delta)) errs.push("volume.delta must be +5, -5 or mute"); break;
    case "media": if (!["play-pause", "next", "previous"].includes(a.cmd)) errs.push("media.cmd invalid"); break;
    case "screen": if (!["off", "lock"].includes(a.cmd)) errs.push("screen.cmd must be off or lock"); break;
    default: break;
  }
  return errs;
}

export function parseKeys(str) {
  const parts = String(str).split("+").map(s => s.trim()).filter(Boolean);
  const mods = [];
  let key = "";
  for (const p of parts) {
    const low = p.toLowerCase();
    if (MODS.includes(low)) mods.push(low); else key = p;
  }
  return { mods, key };
}

export function toArgv(a) {
  if (validateAction(a).length) return { kind: "none" };
  switch (a.type) {
    case "key": {
      const { mods, key } = parseKeys(a.keys);
      const argv = ["wtype"];
      for (const m of mods) argv.push("-M", m);
      argv.push("-k", key);
      for (const m of [...mods].reverse()) argv.push("-m", m);
      return { kind: "process", argv };
    }
    case "dispatch":
      return { kind: "dispatch", cmd: a.arg ? `${a.dispatcher} ${a.arg}` : a.dispatcher };
    case "volume":
      if (a.delta === "mute") return { kind: "process", argv: ["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"] };
      return { kind: "process", argv: ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", a.delta === "+5" ? "5%+" : "5%-"] };
    case "media":
      return { kind: "process", argv: ["playerctl", a.cmd] };
    case "screen":
      return a.cmd === "off"
        ? { kind: "process", argv: ["hyprctl", "dispatch", "dpms", "off"] }
        : { kind: "process", argv: ["omarchy-lock-screen"] };
    default:
      return { kind: "none" };
  }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function describe(a) {
  if (validateAction(a).length) return "";
  switch (a.type) {
    case "key": { const { mods, key } = parseKeys(a.keys); return [...mods.map(cap), key.length === 1 ? key.toUpperCase() : key].join("+"); }
    case "dispatch": return a.arg ? `${a.dispatcher} ${a.arg}` : a.dispatcher;
    case "volume": return a.delta === "mute" ? "Mute" : `Volume ${a.delta}`;
    case "media": return cap(a.cmd.replace("-", " "));
    case "screen": return a.cmd === "off" ? "Screen off" : "Lock screen";
    default: return "";
  }
}
