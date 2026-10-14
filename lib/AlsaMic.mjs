// Mic source picker spec §4.1/§4.2/§5.1: the managed `omaremote-mic` block's state, as `omaremote-setup alsa-mic` prints
// it, and the one comparison every caller uses. Spec §4.2 / plan ruling 3: the first character can never be `-`, so a node name is
// never read as an option. host/omaremote-setup's NODE_RE is the same pattern; tests pin both to one table.
export const NODE_RE = /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]*$/;
export const MIC_PCM = "omaremote-mic";

export const isNodeName = (s) => typeof s === "string" && NODE_RE.test(s);
export const absent = () => ({ state: "absent" });
export const present = (node) => ({ state: "present", node });

export function parseAlsaState(text) {
  let j;
  try { j = JSON.parse(String(text === null || text === undefined ? "" : text).trim()); } catch (e) { return null; }
  if (!j || typeof j !== "object") return null;
  if (j.state === "absent") return absent();
  if (j.state === "present" && isNodeName(j.node)) return present(j.node);
  return null;
}

// Spec §5.1 "Comparing block states": the same state, and the same node when both are present.
export function sameAlsa(a, b) {
  if (!a || !b || a.state !== b.state) return false;
  return a.state !== "present" || a.node === b.node;
}

export function alsaSetArgv(prefix, target, expect) {
  return prefix.concat(["set"],
    target.state === "present" ? [target.node] : ["--absent"],
    expect.state === "present" ? ["--expect", expect.node] : ["--expect-absent"]);
}
