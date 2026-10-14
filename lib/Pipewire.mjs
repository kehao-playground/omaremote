import { isNodeName } from "./AlsaMic.mjs";
// Spec §3 ("capture device is verified on the next session: pw-dump must show Voxtype's stream linked to the expected node"), §6.2 Doctor facts.
const props = (o) => (o && o.info && o.info.props) || {};
const nodesOf = (dump) => (Array.isArray(dump) ? dump : []).filter(o => o && o.type === "PipeWire:Interface:Node");

export function captureSourceOf(dump, match = /voxtype/i) {
  const nodes = nodesOf(dump);
  const stream = nodes.find(n => props(n)["media.class"] === "Stream/Input/Audio"
    && match.test(`${props(n)["application.name"] || ""} ${props(n)["node.name"] || ""}`));
  if (!stream) return { streamFound: false, node: null };
  const links = (Array.isArray(dump) ? dump : []).filter(o => o && o.type === "PipeWire:Interface:Link" && o.info && o.info["input-node-id"] === stream.id);
  const src = nodes.find(n => links.some(l => l.info["output-node-id"] === n.id));
  return { streamFound: true, node: src ? (props(src)["node.name"] || null) : null };
}

export function sourceNames(dump) {
  return nodesOf(dump).filter(n => props(n)["media.class"] === "Audio/Source").map(n => props(n)["node.name"]).filter(Boolean);
}

// Mic source picker spec §4.3: every pickable capture source. Monitors and the excluded names (the ATVVoice node) are
// dropped, and so is a name the picker could never pass to alsa-mic.
export function captureSources(dump, { exclude = [] } = {}) {
  return nodesOf(dump).filter(n => props(n)["media.class"] === "Audio/Source").map(n => {
    const p = props(n);
    return { name: p["node.name"], description: p["node.description"] || p["node.nick"] || p["node.name"] };
  }).filter(s => isNodeName(s.name) && !/\.monitor$/.test(s.name) && !exclude.includes(s.name));
}

// Spec §4.3: one probe's outcome. A refresh succeeds only when pw-dump exited 0 AND printed a JSON array.
export function sourcesFromProbe(code, text, opts) {
  if (code !== 0) return null;
  let dump;
  try { dump = JSON.parse(String(text || "")); } catch (e) { return null; }
  return Array.isArray(dump) ? captureSources(dump, opts) : null;
}

// Spec §6 `last-capture`: the PipeWire default source, from the `default` metadata object.
export function defaultSource(dump) {
  const md = (Array.isArray(dump) ? dump : []).find(o => o && o.type === "PipeWire:Interface:Metadata"
    && o.props && o.props["metadata.name"] === "default");
  const e = md && Array.isArray(md.metadata) ? md.metadata.find(m => m && m.subject === 0 && m.key === "default.audio.source") : null;
  const name = e && e.value && typeof e.value === "object" ? e.value.name : null;
  return typeof name === "string" && name ? name : null;
}

// Spec §5.3: Voxtype's stream is linked to a node other than the expected one.
export function captureMismatch(dump, expected) {
  if (!expected) return null;
  const r = captureSourceOf(dump);
  if (!r.streamFound || !r.node || r.node === expected) return null;
  const desc = (name) => {
    const n = nodesOf(dump).find(x => props(x)["node.name"] === name);
    const p = n ? props(n) : {};
    return p["node.description"] || p["node.nick"] || name;
  };
  return { node: r.node, nodeDescription: desc(r.node), expected, expectedDescription: desc(expected) };
}
