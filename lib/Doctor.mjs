// Spec §6.2 item 4 (doctor rows), §5.4 (state mapping), §7 --doctor. One rule set for panel and script.
import { KEY_NAMES } from "./Defaults.mjs";
import { isHealthy } from "./VoxStatus.mjs";

const BOTH = ["remote", "system"];
// wtype was dropped 2026-10-07: key actions are send_key_state down/up pairs dispatched through
// Hyprland, because wtype's virtual keyboard destroyed the release edge of the key that
// triggered it. Nothing in the product spawns it, so requiring it would send the user to
// install a package that does nothing.
const REQUIRED_TOOLS = ["keyd", "playerctl", "wpctl", "pw-dump", "voxtype"];
const TOOL_PACKAGES = { keyd: "keyd", playerctl: "playerctl", wpctl: "wireplumber", "pw-dump": "pipewire" };

const get = (o, path) => path.split(".").reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), o);
const tri = (v) => (v === undefined || v === null ? "unknown" : v ? "pass" : "fail");

function versionAtLeast(v, major, minor) {
  const m = /^(\d+)\.(\d+)/.exec(String(v || ""));
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return a > major || (a === major && b >= minor);
}

export function evaluate(facts = {}, config) {
  const mode = get(config, "voice.mic") === "system" ? "system" : "remote";
  const supported = KEY_NAMES.filter(k => get(config, `keys.${k}.supported`) !== false);
  const rows = [];
  const push = (id, label, status, modes, detail = "", fix = "") => rows.push({ id, label, status, modes, detail, fix });

  // tools
  const tools = get(facts, "tools");
  if (!tools) push("tools", "Required tools present", "unknown", BOTH, "", "");
  else {
    const missing = REQUIRED_TOOLS.filter(t => !tools[t]);
    if (missing.length) {
      const pacmanMissing = missing.filter(t => t !== "voxtype").map(t => TOOL_PACKAGES[t]);
      const hasVoxtype = missing.includes("voxtype");
      let fix = "";
      if (pacmanMissing.length && hasVoxtype) {
        fix = `sudo pacman -S --needed ${pacmanMissing.join(" ")} && omarchy-update`;
      } else if (pacmanMissing.length) {
        fix = `sudo pacman -S --needed ${pacmanMissing.join(" ")}`;
      } else if (hasVoxtype) {
        fix = "omarchy-update";
      }
      push("tools", "Required tools present", "fail", BOTH, `missing: ${missing.join(", ")}`, fix);
    } else {
      push("tools", "Required tools present", "pass", BOTH, "", "");
    }
  }

  // keyd
  const keydOk = get(facts, "keyd.enabled") && get(facts, "keyd.active");
  push("keyd-service", "keyd enabled and active", get(facts, "keyd.enabled") === undefined ? "unknown" : tri(!!keydOk), BOTH, "", "sudo systemctl enable --now keyd");
  push("keyd-conf", "keyd check passes on /etc/keyd/omaremote.conf", tri(get(facts, "keyd.checkOk")), BOTH, "", "sudo keyd check /etc/keyd/omaremote.conf");
  push("keyd-grab", "remote device grabbed by keyd", tri(get(facts, "keyd.grabbed")), BOTH, "", "bash <plugin-dir>/host/omaremote-setup --relearn");

  // hyprland binds
  const desc = get(facts, "hypr.descriptions");
  if (!Array.isArray(desc)) push("hypr-binds", "Hyprland global binds loaded", "unknown", BOTH, "", "");
  else {
    const want = supported.map(k => `omaremote:${k}`);
    const missing = want.filter(d => !desc.includes(d)).map(d => d.slice("omaremote:".length));
    const unexpected = desc.filter(d => !want.includes(d)).map(d => d.slice("omaremote:".length));
    const dup = desc.filter((d, i) => desc.indexOf(d) !== i);
    const ok = get(facts, "hypr.required") !== false && !missing.length && !unexpected.length && !dup.length;
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
    if (unexpected.length) parts.push(`unexpected: ${unexpected.join(", ")}`);
    if (dup.length) parts.push(`duplicate: ${dup.join(", ")}`);
    push("hypr-binds", "Hyprland global binds match supported keys", ok ? "pass" : "fail", BOTH, parts.join("; "), "bash <plugin-dir>/host/omaremote-setup && hyprctl reload");
  }

  // voxtype
  const vver = get(facts, "voxtype.version");
  const voxtypeNotInstalled = get(facts, "tools.voxtype") === false;
  if (voxtypeNotInstalled) {
    push("voxtype-version", "Voxtype ≥ 0.8", "fail", BOTH, "voxtype not installed", "omarchy-update  # Voxtype >= 0.8 ships with Omarchy");
  } else {
    const vok = versionAtLeast(vver, 0, 8);
    push("voxtype-version", "Voxtype ≥ 0.8", vok === null ? "unknown" : tri(vok), BOTH, vver ? `found ${vver}` : "", "omarchy-update  # Voxtype >= 0.8 ships with Omarchy");
  }
  const cls = get(facts, "voxtype.statusClass");
  push("voxtype-status", "Voxtype daemon answering", cls === undefined ? "unknown" : tri(isHealthy(cls)), BOTH, cls ? `status: ${cls}` : "", "systemctl --user restart voxtype");
  const om = get(facts, "voxtype.outputMode");
  push("voxtype-output", 'Voxtype output.mode is "type"', om === undefined ? "unknown" : tri(om === "type"), BOTH, om ? `output.mode: ${om}` : "", "voxtype config set output.mode type && systemctl --user restart voxtype");

  // atvvoice (remote mode rows; informational in system mode)
  const infoOr = (status) => (mode === "system" ? "info" : status);
  push("atvvoice-service", "ATVVoice service active", infoOr(tri(get(facts, "atvvoice.active"))), BOTH, "", "systemctl --user enable --now atvvoice");
  push("atvvoice-ondemand", "ATVVoice runs with --mic-on-demand", infoOr(tri(get(facts, "atvvoice.micOnDemand"))), BOTH, "", "systemctl --user edit atvvoice  # add --mic-on-demand to ExecStart");
  const bus = get(facts, "atvvoice.busNames");
  push("atvvoice-dbus", "ATVVoice on the session bus", infoOr(Array.isArray(bus) ? tri(bus.length > 0) : "unknown"), BOTH, Array.isArray(bus) ? bus.join(", ") : "", "systemctl --user restart atvvoice");

  // voxtype device per mode
  const dev = get(facts, "voxtype.audioDevice");
  const node = get(facts, "atvvoice.nodeName");
  if (dev === undefined) push("voxtype-device", "Voxtype audio.device", "unknown", BOTH, "", "");
  else if (mode === "remote") push("voxtype-device", "Voxtype audio.device is the ATVVoice node", tri(!!node && dev === node), ["remote"], `audio.device: ${dev}${node ? `, node: ${node}` : ""}`, "omarchy-shell omaremote mic remote");
  else {
    const sources = get(facts, "pipewire.sources");
    const ok = dev === "default" || (Array.isArray(sources) && sources.includes(dev));
    push("voxtype-device", "Voxtype audio.device resolves to a PipeWire source", Array.isArray(sources) || dev === "default" ? tri(ok) : "unknown", ["system"], `audio.device: ${dev}`, "omarchy-shell omaremote mic system");
  }

  // last capture
  const lc = get(facts, "lastCapture");
  const expected = mode === "remote" ? node : dev;
  if (lc === undefined) push("last-capture", "Last session captured from expected node", "unknown", BOTH, "", "");
  else if (lc === null) push("last-capture", "Last session captured from expected node", "unknown", BOTH, "not yet verified", "");
  else push("last-capture", "Last session captured from expected node", lc.node === expected ? "pass" : "warn", BOTH, `captured from: ${lc.node}`, "");

  // panic + config
  const panicOk = KEY_NAMES.some(k => get(config, `keys.${k}.panic`) && get(config, `keys.${k}.supported`) !== false);
  push("panic-key", "At least one supported key has panic", panicOk ? "pass" : "fail", BOTH, "", "bash <plugin-dir>/host/omaremote-setup --relearn");
  const probs = get(facts, "configProblems");
  push("config-valid", "config.json valid", Array.isArray(probs) ? tri(probs.length === 0) : "unknown", BOTH, Array.isArray(probs) ? probs.map(p => p.message).join("; ") : "", "");

  return rows;
}

const VOX_ROWS = ["voxtype-version", "voxtype-status", "voxtype-output", "config-valid"];
const REMOTE_ROWS = ["atvvoice-service", "atvvoice-ondemand", "atvvoice-dbus", "voxtype-device"];

export function summarize(rows, config) {
  const mode = get(config, "voice.mic") === "system" ? "system" : "remote";
  const failed = (ids) => rows.some(r => ids.includes(r.id) && r.status === "fail" && r.modes.includes(mode));
  if (failed(VOX_ROWS)) return "unconfigured";
  if (mode === "system" && rows.some(r => r.id === "voxtype-device" && r.status === "fail")) return "unconfigured";
  if (mode === "remote" && failed(REMOTE_ROWS)) return "remoteWarning";
  return "ready";
}
