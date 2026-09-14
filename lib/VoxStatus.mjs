// Spec §3 Voxtype: status classes idle|recording|transcribing|stopped; `streaming` normalizes to recording;
// anything else is unknown (never idle).
const KNOWN = ["idle", "recording", "transcribing", "stopped"];
const ALIAS = { streaming: "recording" };

export function parseStatusLine(line) {
  const l = String(line || "").trim();
  if (!l) return null;
  let j;
  try { j = JSON.parse(l); } catch (e) { return null; }
  if (!j || typeof j !== "object") return null;
  const c0 = typeof j.class === "string" ? j.class : (typeof j.alt === "string" ? j.alt : "");
  const c = ALIAS[c0] || c0;
  return { cls: KNOWN.includes(c) ? c : "unknown", raw: j };
}

export const isHealthy = (cls) => cls === "idle" || cls === "recording" || cls === "transcribing";
export const isIdle = (cls) => cls === "idle";

export function createStatusStream() {
  let buf = "";
  return {
    feed(chunk) {
      buf += chunk;
      const out = [];
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const st = parseStatusLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (st) out.push(st);
      }
      return out;
    },
  };
}
