import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { captureSourceOf, sourceNames, captureSources, sourcesFromProbe, defaultSource, captureMismatch } from "../lib/Pipewire.mjs";

const dump = JSON.parse(readFileSync(new URL("./fixtures/pw-dump.json", import.meta.url), "utf8"));

test("captureSourceOf finds the node linked into voxtype's capture stream", () => {
  assert.deepEqual(captureSourceOf(dump), { streamFound: true, node: "atvvoice_mic" });
});

test("no voxtype stream means not yet verified, never a pass", () => {
  const noStream = dump.filter(o => o.id !== 60 && o.id !== 70);
  assert.deepEqual(captureSourceOf(noStream), { streamFound: false, node: null });
  assert.deepEqual(captureSourceOf(null), { streamFound: false, node: null });
});

test("a stream with no link reports the stream but no node", () => {
  const unlinked = dump.filter(o => o.id !== 70);
  assert.deepEqual(captureSourceOf(unlinked), { streamFound: true, node: null });
});

test("sourceNames lists Audio/Source node names", () => {
  assert.deepEqual(sourceNames(dump), ["atvvoice_mic", "alsa_input.pci-0000_00_1f.3.analog-stereo"]);
});

const node = (id, props) => ({ id, type: "PipeWire:Interface:Node", info: { props } });
const pickDump = [
  node(1, { "media.class": "Audio/Source", "node.name": "alsa_input.usb-C922", "node.description": "C922 Pro Stream Webcam Analog Stereo", "node.nick": "C922" }),
  node(2, { "media.class": "Audio/Source", "node.name": "alsa_input.pci-builtin", "node.nick": "CS4208 Analog" }),
  node(3, { "media.class": "Audio/Source", "node.name": "bare_source" }),
  node(4, { "media.class": "Audio/Source", "node.name": "alsa_output.hdmi.monitor", "node.description": "Monitor" }),
  node(5, { "media.class": "Audio/Source", "node.name": "atvvoice-xiaomi", "node.description": "小米蓝牙语音遥控器" }),
  node(6, { "media.class": "Audio/Source", "node.name": "weird name", "node.description": "Unpickable" }),
  node(7, { "media.class": "Audio/Sink", "node.name": "alsa_output.hdmi" }),
  { id: 9, type: "PipeWire:Interface:Metadata", props: { "metadata.name": "settings" }, metadata: [] },
  { id: 10, type: "PipeWire:Interface:Metadata", props: { "metadata.name": "default" }, metadata: [
    { subject: 0, key: "default.audio.sink", type: "Spa:String:JSON", value: { name: "alsa_output.hdmi" } },
    { subject: 0, key: "default.audio.source", type: "Spa:String:JSON", value: { name: "alsa_input.usb-C922" } } ] },
];

test("captureSources lists pickable sources with description fallbacks", () => {
  assert.deepEqual(captureSources(pickDump, { exclude: ["atvvoice-xiaomi"] }), [
    { name: "alsa_input.usb-C922", description: "C922 Pro Stream Webcam Analog Stereo" },
    { name: "alsa_input.pci-builtin", description: "CS4208 Analog" },
    { name: "bare_source", description: "bare_source" },
  ]);
  assert.equal(captureSources(pickDump).some(s => s.name === "atvvoice-xiaomi"), true, "exclude is what drops the remote");
  assert.deepEqual(captureSources(null), []);
});

test("sourcesFromProbe needs both a zero exit and a JSON array", () => {
  const text = JSON.stringify(pickDump);
  assert.deepEqual(sourcesFromProbe(0, text, { exclude: ["atvvoice-xiaomi"] }).map(s => s.name), ["alsa_input.usb-C922", "alsa_input.pci-builtin", "bare_source"]);
  assert.equal(sourcesFromProbe(1, text, {}), null, "valid JSON with a non-zero exit is a failed refresh");
  assert.equal(sourcesFromProbe(124, text, {}), null);
  assert.equal(sourcesFromProbe(0, "not json", {}), null);
  assert.equal(sourcesFromProbe(0, "{}", {}), null, "not an array");
  assert.deepEqual(sourcesFromProbe(0, "[]", {}), [], "an empty graph is a successful, empty list");
});

test("defaultSource reads the default metadata, null without it", () => {
  assert.equal(defaultSource(pickDump), "alsa_input.usb-C922");
  assert.equal(defaultSource(pickDump.filter(o => o.id !== 10)), null);
  assert.equal(defaultSource(dump), null);
  assert.equal(defaultSource(null), null);
});

test("captureMismatch names both sides only when the linked node differs", () => {
  const linked = (to) => pickDump.concat([
    { id: 60, type: "PipeWire:Interface:Node", info: { props: { "media.class": "Stream/Input/Audio", "node.name": "voxtype" } } },
    { id: 70, type: "PipeWire:Interface:Link", info: { "input-node-id": 60, "output-node-id": to } },
  ]);
  assert.equal(captureMismatch(linked(1), "alsa_input.usb-C922"), null);
  assert.deepEqual(captureMismatch(linked(2), "alsa_input.usb-C922"), {
    node: "alsa_input.pci-builtin", nodeDescription: "CS4208 Analog",
    expected: "alsa_input.usb-C922", expectedDescription: "C922 Pro Stream Webcam Analog Stereo" });
  assert.deepEqual(captureMismatch(linked(2), "gone_node").expectedDescription, "gone_node");
  assert.equal(captureMismatch(linked(2), null), null, "nothing expected, nothing to report");
  assert.equal(captureMismatch(pickDump, "alsa_input.usb-C922"), null, "no voxtype stream yet");
});
