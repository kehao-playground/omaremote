import { test } from "node:test";
import assert from "node:assert/strict";
import { NODE_RE, MIC_PCM, isNodeName, absent, present, parseAlsaState, sameAlsa, alsaSetArgv } from "../lib/AlsaMic.mjs";

// The same table is pinned against the bash NODE_RE in tests/setup-alsa-mic.sh (Task 4). Keep the two in step.
export const NODE_TABLE = [
  ["alsa_input.usb-046d_C922_Pro_Stream_Webcam_557DD3BF-02.analog-stereo", true],
  ["atvvoice-xiaomi", true], ["none", true], ["absent", true], ["a:b.c_d-e", true], ["_x", true], [".x", true], [":x", true],
  ["-x", false], ["", false], ["a b", false], ['a"b', false], ["a}b", false], ["a{b", false], ["a\\b", false], ["a\nb", false],
];

test("NODE_RE accepts node names and refuses option-like or ALSA-syntax names", () => {
  for (const [name, ok] of NODE_TABLE) assert.equal(isNodeName(name), ok, JSON.stringify(name));
  assert.equal(isNodeName(undefined), false);
  assert.equal(isNodeName(42), false);
  assert.equal(NODE_RE.source, "^[A-Za-z0-9_.:][A-Za-z0-9_.:-]*$");
  assert.equal(MIC_PCM, "omaremote-mic");
});

test("parseAlsaState reads the alsa-mic JSON and refuses anything else", () => {
  assert.deepEqual(parseAlsaState('{"state":"absent"}\n'), { state: "absent" });
  assert.deepEqual(parseAlsaState('{"state":"present","node":"none"}'), { state: "present", node: "none" });
  assert.equal(parseAlsaState('{"state":"bad"}'), null);
  assert.equal(parseAlsaState('{"state":"present"}'), null);
  assert.equal(parseAlsaState('{"state":"present","node":"a b"}'), null);
  assert.equal(parseAlsaState("none"), null);
  assert.equal(parseAlsaState(""), null);
  assert.equal(parseAlsaState(null), null);
});

test("sameAlsa compares state and node, never identity", () => {
  assert.equal(sameAlsa(absent(), absent()), true);
  assert.equal(sameAlsa(present("a"), present("a")), true);
  assert.equal(sameAlsa(present("a"), present("b")), false);
  assert.equal(sameAlsa(present("absent"), absent()), false);
  assert.equal(sameAlsa(null, absent()), false);
  assert.equal(sameAlsa(parseAlsaState('{"state":"present","node":"a"}'), present("a")), true);
});

test("alsaSetArgv spells targets and expectations as alsa-mic flags", () => {
  const p = ["bash", "/x/omaremote-setup", "alsa-mic"];
  assert.deepEqual(alsaSetArgv(p, present("n"), absent()), [...p, "set", "n", "--expect-absent"]);
  assert.deepEqual(alsaSetArgv(p, absent(), present("n")), [...p, "set", "--absent", "--expect", "n"]);
  assert.deepEqual(alsaSetArgv(p, present("absent"), present("none")), [...p, "set", "absent", "--expect", "none"]);
  assert.deepEqual(p, ["bash", "/x/omaremote-setup", "alsa-mic"], "the prefix is not mutated");
});
