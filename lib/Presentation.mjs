// Spec §6.1 (bar glyph by state, precedence), §6.3 (HUD lines and flashes), §6.2 (Keys tab capture, Voice tab mic status).
import { describe } from "./Actions.mjs";

const pad2 = (n) => (n < 10 ? "0" : "") + n;
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

const KEY_LABEL = { up: "Up", down: "Down", left: "Left", right: "Right", ok: "OK", back: "Back", home: "Home", menu: "Menu", app: "App", volup: "Vol+", voldown: "Vol−", power: "Power", mic: "Mic" };
export function keyLabel(name) { return KEY_LABEL[name] || String(name); }
export function flashText(key, trigger, action) { return `${keyLabel(key)} · ${trigger} → ${describe(action)}`; }

export function glyphLook(s) {
  const st = s.voiceState || "idle";
  if (s.selftest) return "selftest";
  if (st === "recovering" || s.micPending) return "busy";
  if (st === "recording") return "recording";
  if (st === "transcribing" || st === "stopping") return "transcribing";
  if (st === "arbitrating" || st === "starting") return "pending";
  if (st === "unconfigured" || s.unconfigured) return "unconfigured";
  if (s.remoteState === "disconnected" || s.remoteState === "absent") return "disconnected";
  return "ready";
}

export function hudLine(s) {
  if (s.flash) return s.flash;
  if (s.voiceState === "recording") {
    const extra = s.hudText && s.hudText !== "recording" ? ` · ${s.hudText}` : "";   // e.g. "mic change applies after this dictation" (§3 step 1)
    return `● ${elapsedText(s.elapsedMs || 0)}${extra}`;
  }
  if (s.voiceState === "transcribing") return "… transcribing";
  return s.hudText || "";
}

export function micStatusLine(status) {
  if (!status) return "";
  let line = status.state;
  if (status.error) line += `: ${status.error}`;
  if (status.rollback) line += ` (rollback: ${status.rollback})`;
  return line;
}

// Qt::Key values are stable ABI; listed so the panel needs no QML enum plumbing.
const QT_KEYS = {
  0x01000000: "Escape", 0x01000001: "Tab", 0x01000003: "BackSpace", 0x01000004: "Return", 0x01000005: "KP_Enter",
  0x01000006: "Insert", 0x01000007: "Delete", 0x01000010: "Home", 0x01000011: "End", 0x01000012: "Left",
  0x01000013: "Up", 0x01000014: "Right", 0x01000015: "Down", 0x01000016: "Page_Up", 0x01000017: "Page_Down", 0x20: "space",
};
for (let i = 0; i < 12; i++) QT_KEYS[0x01000030 + i] = `F${i + 1}`;
const MODIFIER_KEYS = [0x01000020, 0x01000021, 0x01000022, 0x01000023];               // Shift, Control, Meta, Alt
const MODIFIERS = [[0x04000000, "ctrl"], [0x02000000, "shift"], [0x08000000, "alt"], [0x10000000, "super"]];

export function keysFromQtEvent(key, modifiers, text) {
  if (MODIFIER_KEYS.includes(key)) return null;
  const mods = MODIFIERS.filter(m => (modifiers & m[0]) !== 0).map(m => m[1]);
  let name = QT_KEYS[key];
  if (!name && key >= 0x21 && key <= 0x7e) name = String.fromCharCode(key).toLowerCase();   // printable ASCII: Qt key = uppercase code
  if (!name) {
    const t = String(text || "");
    if (t.length === 1 && t.charCodeAt(0) > 32) name = t.toLowerCase(); else return null;
  }
  return mods.concat([name]).join("+");
}
