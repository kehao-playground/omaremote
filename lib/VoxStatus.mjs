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
  const c0 = typeof j.class === "string" && j.class ? j.class
           : (typeof j.alt === "string" && j.alt ? j.alt : "");
  // A line with NO class is no information, not a health signal. voxtype 1.1.0 emits exactly such a
  // line as part of its recording -> idle transition (measured on the host 2026-10-08), and
  // reporting it as "unknown" made isHealthy() reject it, so VoiceSession.status() called
  // toUnconfigured("voxtype not responding") on a live daemon mid-transition -- knocking the session
  // out of state on every mic press. Returning null makes every caller's `if (!r) return` drop it.
  //
  // An unrecognised but non-empty class still yields "unknown": the daemon said something we cannot
  // interpret, which IS worth treating as unhealthy. That is the distinction this guard draws.
  if (!c0) return null;
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
