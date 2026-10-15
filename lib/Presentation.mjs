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
  // Typeless spec §8: under Typeless a Voxtype that is not responding is not this engine's problem.
  const st = s.engine === "typeless" && s.voiceState === "unconfigured" ? "idle" : (s.voiceState || "idle");
  if (s.selftest) return "selftest";
  if (st === "recovering" || s.micPending) return "busy";
  if (s.typeless === "recording") return "recording";            // Typeless spec §6.3
  if (s.typeless === "unsynced") return "warning";
  if (st === "recording") return "recording";
  if (st === "transcribing" || st === "stopping") return "transcribing";
  if (st === "arbitrating" || st === "starting") return "pending";
  if (st === "unconfigured" || s.unconfigured) return "unconfigured";
  if (s.remoteState === "disconnected" || s.remoteState === "absent") return "disconnected";
  return "ready";
}

export function hudLine(s) {
  if (s.flash) return s.flash;
  if (s.typeless === "recording") return "● Typeless " + elapsedText(s.elapsedMs || 0) + (s.hudText ? " · " + s.hudText : "");
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
  if (status.partial) line += ` (partial: ${status.partial})`;
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

// Plan 4 §4.2/§4.5: Voice tab source lines. In remote mode the HID mic key is dropped before voice
// and engine, so its trigger is irrelevant there; without on-demand an F9 session captures silence.
export function hidMicLine(cfg) {
  if (!cfg) return "";
  const m = cfg.keys.mic;
  if (m.supported === false) return "not available";
  if (cfg.voice.mic === "remote") return "ignored in remote mode — hold the remote's mic button to talk";
  if (m.trigger === "key") return "not available";
  return m.trigger === "toggle" ? "toggle (press to start, press again to stop)" : "push-to-talk";
}
export function keyboardSourceLine(cfg) {
  return cfg && cfg.voice.mic === "remote" && !cfg.voice.remoteOnDemand
    ? "observed — no audio in remote mode unless the remote's mic button is held; use system mode for F9"
    : "observed";
}

// Typeless spec §6.3: what system mode flashes on each tap; Typeless's own Status bar shows the real state.
export const TYPELESS_FLASH = "Typeless ⏯";

// ---- Typeless engine (Typeless spec §6.3, §7) ----
export const TYPELESS_MIC_HINT = "also select the matching microphone in Typeless";
// What the bar and HUD show for a TypelessSession snapshot: recording while Typeless is believed on or a start tap is
// in flight (a stop in flight keeps `on` until its result), a warning while unsynced, otherwise idle. System mode
// keeps no state: Typeless's own Status bar shows it.
export function typelessView(snap) {
  if (!snap || snap.mode !== "remote") return "idle";
  if (snap.typeless === "unsynced") return "unsynced";
  if (snap.typeless === "on" || (snap.outstanding && snap.outstanding.kind === "start")) return "recording";
  return "idle";
}
export function engineStatusLine(cfg, facts) {
  if (!cfg) return "";
  const t = facts && facts.typeless;
  let kt = "unknown";
  if (t && typeof t.keytapActive === "boolean") kt = t.keytapActive && t.keytapDevice ? "running" : "not running";
  return "hotkey: " + cfg.voice.typeless.hotkey + " · keytap: " + kt;
}

// Mic source picker spec §4.5: the Microphone row's buttons. Plan ruling 2: Enter on the active one does nothing.
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// `names` (MicSources.names()) labels a disconnected pick with the description it was last seen with.
export function micChoices(cfg, sources, names) {
  const v = (cfg && cfg.voice) || {};
  const sd = v.systemDevice || "default";
  const list = Array.isArray(sources) ? sources : [];
  const out = [
    { key: "remote", label: "Remote", mode: "remote", connected: true, active: v.mic === "remote" },
    { key: "default", label: "System default", mode: "system", device: "default", connected: true, active: v.mic === "system" && sd === "default" },
  ];
  for (const s of list) out.push({ key: s.name, label: cut(s.description || s.name, 28), mode: "system", device: s.name, connected: true, active: v.mic === "system" && sd === s.name });
  if (cfg && sd !== "default" && !list.some(s => s.name === sd))
    out.push({ key: sd, label: cut((names && names[sd]) || sd, 28) + " (not connected)", mode: "system", device: sd, connected: false, active: v.mic === "system" });
  return out;
}

const REFUSALS = { "no-such-source": "microphone not found (unplugged?)", "invalid-source": "not a usable microphone",
                   "sources-unavailable": "cannot list microphones (pw-dump failed)" };
export function micRefusal(reason) { return REFUSALS[reason] || String(reason); }

export function micConflictLine(c) {
  if (c && c.target === "alsa") {
    const show = (s) => (!s ? "unreadable" : s.state === "present" ? s.node : "absent");
    return `conflict: the omaremote mic ALSA block is ${show(c.found)} (expected ${show(c.expected)}) — reconcile in Setup`;
  }
  return `conflict: Voxtype audio.device is ${c.found} (expected ${c.expected}) — reconcile in Setup`;
}
