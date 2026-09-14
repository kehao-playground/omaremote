// Spec §4.4: closed action union. Task 6 adds argv mapping.
export const ACTION_TYPES = ["key", "dispatch", "volume", "media", "screen", "none"];

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
