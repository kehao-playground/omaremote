import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { captureSourceOf, sourceNames } from "../lib/Pipewire.mjs";

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
