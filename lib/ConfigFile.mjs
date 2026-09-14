// Spec §3 plugin-side files, §4.2 (unknown fields preserved on write), §8 (corrupt config → defaults, never overwritten).
import { DEFAULT_CONFIG, DEFAULT_KEYS, KEY_NAMES } from "./Defaults.mjs";
import { normalizeConfig } from "./Config.mjs";

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function defaults(problems, missing, invalid) {
  const raw = clone(DEFAULT_CONFIG);
  return { raw, config: normalizeConfig(raw).config, problems, missing, invalid };
}

export function load(text) {
  const t = text === undefined || text === null ? "" : String(text);
  if (t.trim() === "") return defaults([], true, false);
  let raw;
  try { raw = JSON.parse(t); } catch (e) {
    return defaults([{ code: "config-invalid", message: "config.json is not valid JSON; using defaults" }], false, true);
  }
  if (!isObj(raw)) return defaults([{ code: "config-invalid", message: "config.json is not an object; using defaults" }], false, true);
  const n = normalizeConfig(raw);
  return { raw, config: n.config, problems: n.problems, missing: false, invalid: false };
}

export function serialize(raw) { return JSON.stringify(raw, null, 2) + "\n"; }

export function withPatch(raw, path, value) {
  const next = clone(isObj(raw) ? raw : {});
  let cur = next;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isObj(cur[path[i]])) cur[path[i]] = {};
    cur = cur[path[i]];
  }
  const leaf = path[path.length - 1];
  if (value === undefined) delete cur[leaf]; else cur[leaf] = clone(value);
  return next;
}

export function withKey(raw, name, fields) {
  const next = clone(isObj(raw) ? raw : {});
  if (!isObj(next.keys)) next.keys = {};
  const merged = isObj(next.keys[name]) ? Object.assign({}, next.keys[name]) : {};
  for (const k of Object.keys(fields)) {
    if (fields[k] === undefined) delete merged[k]; else merged[k] = clone(fields[k]);
  }
  next.keys[name] = merged;
  return next;
}

export function withDefaultKeys(raw) {
  const next = clone(isObj(raw) ? raw : {});
  const prev = isObj(next.keys) ? next.keys : {};
  next.keys = {};
  for (const name of KEY_NAMES) {
    next.keys[name] = clone(DEFAULT_KEYS[name] || {});
    if (isObj(prev[name]) && prev[name].supported === false) next.keys[name].supported = false;
  }
  return next;
}
