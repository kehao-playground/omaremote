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
