import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, summarize } from "../lib/Doctor.mjs";
import { normalizeConfig } from "../lib/Config.mjs";
import { DEFAULT_CONFIG, KEY_NAMES } from "../lib/Defaults.mjs";

const config = normalizeConfig({ ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, mic: { supported: false } } }).config;
const supported = KEY_NAMES.filter(k => k !== "mic");
const good = () => ({
  tools: { keyd: true, playerctl: true, wpctl: true, "pw-dump": true, voxtype: true, evtest: true, jq: true, node: true },
  keyd: { enabled: true, active: true, checkOk: true, grabbed: true },
  hypr: { required: true, descriptions: supported.map(k => `omaremote:${k}`) },
  voxtype: { version: "0.8.1", statusClass: "idle", outputMode: "type", audioDevice: "G20S PRO" },
  atvvoice: { active: true, micOnDemand: false, nodeName: "G20S PRO", busNames: ["org.atvvoice.G20SPRO"] },
  pipewire: { sources: ["alsa_input.pci", "G20S PRO"] },
  alsa: { pcms: ["null", "default", "G20S PRO"] },
  lastCapture: { node: "G20S PRO", at: 1000 },
  configProblems: [],
  now: 2000,
});
const row = (rows, id) => rows.find(r => r.id === id);

test("wtype is not a required tool: key actions no longer spawn it", () => {
  // Key actions are dispatched as send_key_state down/up pairs through Hyprland. wtype's virtual
  // keyboard destroyed the release edge of the key that triggered it (measured 2026-10-07), so the
  // product no longer runs it at all -- and doctor must not send the user to install a package
  // nothing uses, nor report a problem when it is absent.
  const f = good();
  delete f.tools.wtype;
  const r = row(evaluate(f, config), "tools");
  assert.equal(r.status, "pass", `tools row was "${r.status}": ${r.detail}`);
});

test("all-good facts in remote mode: every applicable row passes and summary is ready", () => {
  const rows = evaluate(good(), config);
  const applicable = rows.filter(r => r.modes.includes("remote"));
  assert.ok(applicable.length >= 12);
  assert.deepEqual(applicable.filter(r => r.status !== "pass").map(r => r.id), []);
  assert.equal(summarize(rows, config), "ready");
});

test("hypr binds must match the supported key set exactly", () => {
  const f = good(); f.hypr.descriptions = f.hypr.descriptions.slice(1).concat(["omaremote:mic"]);
  const r = row(evaluate(f, config), "hypr-binds");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /missing: up/);
  assert.match(r.detail, /unexpected: mic/);
});

test("voxtype rows: old version, stopped status, wrong output mode -> unconfigured", () => {
  const f = good(); f.voxtype.version = "0.7.9"; f.voxtype.statusClass = "stopped"; f.voxtype.outputMode = "clipboard";
  const rows = evaluate(f, config);
  assert.equal(row(rows, "voxtype-version").status, "fail");
  assert.equal(row(rows, "voxtype-status").status, "fail");
  assert.equal(row(rows, "voxtype-output").status, "fail");
  assert.equal(summarize(rows, config), "unconfigured");
});

test("remote mode: ATVVoice down or device mismatch -> remoteWarning, not unconfigured", () => {
  const f = good(); f.atvvoice.active = false; f.voxtype.audioDevice = "default";
  const rows = evaluate(f, config);
  assert.equal(row(rows, "atvvoice-service").status, "fail");
  assert.equal(row(rows, "voxtype-device").status, "fail");
  assert.equal(summarize(rows, config), "remoteWarning");
});

test("system mode: ATVVoice rows are informational and device must resolve to a source or default", () => {
  const sys = normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, mic: "system" } }).config;
  const f = good(); f.atvvoice.active = false; f.voxtype.audioDevice = "default";
  const rows = evaluate(f, sys);
  assert.equal(row(rows, "atvvoice-service").status, "info");
  assert.equal(row(rows, "voxtype-device").status, "pass");
  assert.equal(summarize(rows, sys), "ready");
  f.voxtype.audioDevice = "ghost";
  assert.equal(row(evaluate(f, sys), "voxtype-device").status, "fail");
});

test("last capture: null is unknown (not yet verified); mismatch is a warning", () => {
  const f = good(); f.lastCapture = null;
  assert.equal(row(evaluate(f, config), "last-capture").status, "unknown");
  f.lastCapture = { node: "alsa_input.pci", at: 1500 };
  assert.equal(row(evaluate(f, config), "last-capture").status, "warn");
});

test("panic key, tools, keyd and config rows", () => {
  const noPanic = normalizeConfig({ ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, menu: { ...DEFAULT_CONFIG.keys.menu, supported: false } } }).config;
  assert.equal(row(evaluate(good(), noPanic), "panic-key").status, "fail");
  const f = good(); f.tools.playerctl = false; f.keyd.active = false; f.configProblems = [{ code: "action-invalid", message: "ok.tap bad" }];
  const rows = evaluate(f, config);
  assert.equal(row(rows, "tools").status, "fail");
  assert.match(row(rows, "tools").detail, /playerctl/);
  assert.equal(row(rows, "keyd-service").status, "fail");
  assert.equal(row(rows, "keyd-service").fix, "sudo systemctl enable --now keyd");
  assert.equal(row(rows, "config-valid").status, "fail");
});

test("missing facts are unknown, never pass", () => {
  const rows = evaluate({}, config);
  assert.ok(rows.every(r => r.status !== "pass" || r.id === "panic-key"));
  assert.equal(row(rows, "keyd-service").status, "unknown");
});

test("tools fix: only pw-dump missing -> pacman install pipewire", () => {
  const f = good(); f.tools["pw-dump"] = false;
  const r = row(evaluate(f, config), "tools");
  assert.equal(r.status, "fail");
  assert.equal(r.fix, "sudo pacman -S --needed pipewire");
});

test("tools fix: wpctl and pw-dump missing -> pacman install wireplumber and pipewire", () => {
  const f = good(); f.tools.wpctl = false; f.tools["pw-dump"] = false;
  const r = row(evaluate(f, config), "tools");
  assert.equal(r.status, "fail");
  assert.equal(r.fix, "sudo pacman -S --needed wireplumber pipewire");
});

test("tools fix: only voxtype missing -> omarchy-update", () => {
  const f = good(); f.tools.voxtype = false;
  const r = row(evaluate(f, config), "tools");
  assert.equal(r.status, "fail");
  assert.equal(r.fix, "omarchy-update");
});

test("tools fix: a package tool and voxtype missing -> pacman install it && omarchy-update", () => {
  const f = good(); f.tools.playerctl = false; f.tools.voxtype = false;
  const r = row(evaluate(f, config), "tools");
  assert.equal(r.status, "fail");
  assert.equal(r.fix, "sudo pacman -S --needed playerctl && omarchy-update");
});

test("voxtype-version: tools.voxtype false with no version -> fail with voxtype not installed", () => {
  const f = good(); f.tools.voxtype = false; f.voxtype = {};
  const r = row(evaluate(f, config), "voxtype-version");
  assert.equal(r.status, "fail");
  assert.equal(r.detail, "voxtype not installed");
  assert.equal(r.fix, "omarchy-update  # Voxtype >= 0.8 ships with Omarchy");
});

test("summarize: tools fail does not mark summary unconfigured in remote mode", () => {
  const f = good(); f.tools.playerctl = false;
  const rows = evaluate(f, config);
  assert.equal(row(rows, "tools").status, "fail");
  assert.equal(summarize(rows, config), "ready");
});

test("summarize: voxtype binary missing marks summary unconfigured", () => {
  const f = good(); f.tools.voxtype = false; f.voxtype = {};
  const rows = evaluate(f, config);
  assert.equal(row(rows, "voxtype-version").status, "fail");
  assert.equal(summarize(rows, config), "unconfigured");
});

test("atvvoice-ondemand passes when the unit and voice.remoteOnDemand agree (both off)", () => {
  assert.equal(row(evaluate(good(), config), "atvvoice-ondemand").status, "pass");
});

test("atvvoice-ondemand fails when the unit has --mic-on-demand but the config says false", () => {
  const f = good(); f.atvvoice.micOnDemand = true;
  const rows = evaluate(f, config);
  const r = row(rows, "atvvoice-ondemand");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /unit: on-demand, config: false/);
  assert.equal(summarize(rows, config), "remoteWarning");
});

test("atvvoice-ondemand fails in the other direction too, and passes when both are on", () => {
  const onCfg = normalizeConfig({ ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, mic: { supported: false } }, voice: { ...DEFAULT_CONFIG.voice, remoteOnDemand: true } }).config;
  assert.equal(row(evaluate(good(), onCfg), "atvvoice-ondemand").status, "fail");
  const f = good(); f.atvvoice.micOnDemand = true;
  assert.equal(row(evaluate(f, onCfg), "atvvoice-ondemand").status, "pass");
});

test("atvvoice-ondemand is unknown without the fact and info in system mode", () => {
  const f = good(); delete f.atvvoice.micOnDemand;
  assert.equal(row(evaluate(f, config), "atvvoice-ondemand").status, "unknown");
  const sys = normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, mic: "system" } }).config;
  const g = good(); g.atvvoice.micOnDemand = true;
  assert.equal(row(evaluate(g, sys), "atvvoice-ondemand").status, "info");
});

// Voxtype 1.1.0 opens audio only through ALSA: audio.device == node name passed while capture was broken
// (measured 2026-10-12) because ALSA had no PCM of that name. The remote row must see the ALSA list.
test("remote voxtype-device: device equals node but ALSA lacks that PCM -> fail with the setup fix", () => {
  const f = good(); f.alsa.pcms = ["null", "default"];
  const r = row(evaluate(f, config), "voxtype-device");
  assert.equal(r.status, "fail");
  assert.equal(r.detail, "audio.device: G20S PRO, but ALSA has no PCM named G20S PRO");
  assert.equal(r.fix, "bash <plugin-dir>/host/omaremote-setup atvvoice");
});

test("remote voxtype-device: ALSA PCM list unavailable -> unknown", () => {
  for (const v of [null, undefined]) {
    const f = good(); if (v === undefined) delete f.alsa; else f.alsa.pcms = v;
    const r = row(evaluate(f, config), "voxtype-device");
    assert.equal(r.status, "unknown");
    assert.equal(r.detail, "audio.device: G20S PRO; ALSA PCM list unavailable");
    assert.equal(r.fix, "sudo pacman -S --needed alsa-utils");
  }
});

test("remote voxtype-device: device differing from the node still fails as before", () => {
  const f = good(); f.voxtype.audioDevice = "default";
  assert.equal(row(evaluate(f, config), "voxtype-device").status, "fail");
});

test("remote voxtype-device: passes when ALSA lists the node", () => {
  assert.equal(row(evaluate(good(), config), "voxtype-device").status, "pass");
});

test("system voxtype-device ignores the ALSA list", () => {
  const sys = normalizeConfig({ ...DEFAULT_CONFIG, voice: { ...DEFAULT_CONFIG.voice, mic: "system" } }).config;
  const f = good(); f.voxtype.audioDevice = "default"; delete f.alsa;
  assert.equal(row(evaluate(f, sys), "voxtype-device").status, "pass");
});

// ---- Typeless engine (Typeless spec §8) ----
const tlConfig = (voice = {}) => normalizeConfig({ ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, mic: { supported: false } },
                                                   voice: { ...DEFAULT_CONFIG.voice, engine: "typeless", ...voice } }).config;
const tlFacts = (typeless = {}) => {
  const f = good();
  f.atvvoice.nodeDescription = "小米蓝牙语音遥控器";
  f.typeless = Object.assign({ keytapActive: true, keytapDevice: true, inInput: true, uinputWritable: true, running: true,
                               settingsReadable: true, hotkey: "RightAlt", micId: "a79c", micLabel: "小米蓝牙语音遥控器" }, typeless);
  return f;
};
const TL_ROWS = ["typeless-keytap", "typeless-uinput", "typeless-running", "typeless-hotkey", "typeless-mic"];

test("the five Typeless rows appear only when the Typeless engine is selected", () => {
  const ids = (rows) => rows.map(r => r.id).filter(id => id.startsWith("typeless-"));
  assert.deepEqual(ids(evaluate(tlFacts(), config)), []);
  assert.deepEqual(ids(evaluate(tlFacts(), tlConfig())), TL_ROWS);
  for (const id of TL_ROWS) assert.equal(row(evaluate(tlFacts(), tlConfig()), id).status, "pass", id);
});

test("keytap and uinput rows fail with their fixes, and either failure makes the summary unconfigured", () => {
  const down = evaluate(tlFacts({ keytapDevice: false }), tlConfig());
  assert.equal(row(down, "typeless-keytap").status, "fail");
  assert.match(row(down, "typeless-keytap").fix, /omaremote-setup typeless/);
  assert.equal(summarize(down, tlConfig()), "unconfigured");
  const ui = evaluate(tlFacts({ inInput: false }), tlConfig());
  assert.equal(row(ui, "typeless-uinput").status, "fail");
  assert.match(row(ui, "typeless-uinput").fix, /usermod -aG input/);
  assert.equal(summarize(ui, tlConfig()), "unconfigured");
  assert.equal(summarize(evaluate(tlFacts(), tlConfig()), tlConfig()), "ready");
});

test("Typeless not running is a warning", () => {
  const r = row(evaluate(tlFacts({ running: false }), tlConfig()), "typeless-running");
  assert.equal(r.status, "warn");
  assert.equal(r.fix, "start Typeless");
});

test("the hotkey row compares canonical forms and is unknown for an unreadable or unparsable Typeless value", () => {
  const st = (t, v) => row(evaluate(tlFacts(t), tlConfig(v)), "typeless-hotkey").status;
  assert.equal(st({ hotkey: "rightalt" }), "pass", "case differs, canonical equal");
  assert.equal(st({ hotkey: "RightShift+RightAlt" }, { typeless: { hotkey: "RightShift+RightAlt" } }), "pass");
  assert.equal(st({ hotkey: "RightAlt+RightShift" }), "warn");
  assert.match(row(evaluate(tlFacts({ hotkey: "RightAlt+RightShift" }), tlConfig()), "typeless-hotkey").fix, /--hotkey-from-typeless/);
  assert.equal(st({ hotkey: "Fn+Q" }), "unknown", "review focus 5: an unparsable value is not a mismatch");
  assert.equal(st({ hotkey: null }), "unknown", "review focus 5: no dictationMode");
  assert.equal(st({ settingsReadable: false }), "unknown");
});

test("the microphone row: remote mode wants the remote's label; system mode wants anything else", () => {
  const st = (t, v) => row(evaluate(tlFacts(t), tlConfig(v)), "typeless-mic");
  assert.equal(st({}).status, "pass");
  assert.equal(st({ micId: "default", micLabel: "Auto-detect (C922 Pro Stream Webcam Analog Stereo)" }).status, "warn");
  assert.equal(st({ micId: "c922", micLabel: "C922 Pro Stream Webcam Analog Stereo" }).status, "warn");
  assert.match(st({ micId: "c922", micLabel: "C922 Pro Stream Webcam Analog Stereo" }).detail, /Typeless: C922.*remote: 小米蓝牙语音遥控器/);
  assert.equal(st({}, { mic: "system" }).status, "warn", "system mode recording from the remote hears nothing between presses");
  assert.equal(st({ micId: "default", micLabel: "Auto-detect (C922)" }, { mic: "system" }).status, "pass");
  assert.equal(st({ micId: "c922", micLabel: "C922" }, { mic: "system" }).status, "pass");
  assert.equal(st({ settingsReadable: false }).status, "unknown");
  const noNode = tlFacts(); delete noNode.atvvoice.nodeDescription;
  assert.equal(row(evaluate(noNode, tlConfig()), "typeless-mic").status, "unknown");
});

test("under Typeless the remote-mode Voxtype device row is informational; the ATVVoice rows still count", () => {
  const f = tlFacts();
  f.voxtype.audioDevice = "default";                       // Voxtype not pointed at the remote: irrelevant to Typeless
  const rows = evaluate(f, tlConfig());
  assert.equal(row(rows, "voxtype-device").status, "info");
  assert.equal(summarize(rows, tlConfig()), "ready");
  f.atvvoice.active = false;
  assert.equal(row(evaluate(f, tlConfig()), "atvvoice-service").status, "fail");
  assert.equal(row(evaluate(f, config), "voxtype-device").status, "fail", "under Voxtype the same facts still fail");
});

test("review: Typeless prerequisites all pass while Voxtype is unusable → Voxtype rows informational, summary ready", () => {
  const broken = () => {
    const f = tlFacts();
    f.tools.voxtype = false;
    f.voxtype = { version: null, statusClass: "stopped", outputMode: "clipboard", audioDevice: "default" };
    f.lastCapture = { node: "elsewhere", at: 1000 };
    return f;
  };
  const rows = evaluate(broken(), tlConfig());
  for (const id of ["voxtype-version", "voxtype-status", "voxtype-output", "voxtype-device", "last-capture"]) assert.equal(row(rows, id).status, "info", id);
  assert.equal(row(rows, "tools").status, "pass", "voxtype is not a required tool under Typeless");
  assert.equal(summarize(rows, tlConfig()), "ready");
  const sysRows = evaluate(broken(), tlConfig({ mic: "system" }));
  assert.equal(summarize(sysRows, tlConfig({ mic: "system" })), "ready");
  const voxCfg = normalizeConfig({ ...DEFAULT_CONFIG, keys: { ...DEFAULT_CONFIG.keys, mic: { supported: false } } }).config;
  assert.equal(summarize(evaluate(broken(), voxCfg), voxCfg), "unconfigured", "discriminating: the same host under Voxtype is unconfigured");
});
