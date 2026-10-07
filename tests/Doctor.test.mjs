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
  atvvoice: { active: true, micOnDemand: true, nodeName: "G20S PRO", busNames: ["org.atvvoice.G20SPRO"] },
  pipewire: { sources: ["alsa_input.pci", "G20S PRO"] },
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
