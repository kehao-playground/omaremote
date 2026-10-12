// Spec §5.1: ATVVoice D-Bus monitor parsing with sender/path/interface filtering and generations.
export function createSignalParser({ path, iface, member, acceptSender }) {
  let buf = "";
  let gen = 0;

  function parseLine(l) {
    let m;
    try { m = JSON.parse(l); } catch (e) { return null; }
    if (!m || m.type !== "signal") return null;
    if (m.path !== path || m.interface !== iface || m.member !== member) return null;
    if (typeof acceptSender === "function" && !acceptSender(m.sender)) return null;
    const data = m.payload && Array.isArray(m.payload.data) ? m.payload.data[0] : undefined;
    if (typeof data !== "string") return null;
    return { state: data, sender: m.sender, path: m.path, interface: m.interface, member: m.member, generation: gen };
  }

  return {
    feed(chunk) {
      buf += chunk;
      const out = [];
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!l) continue;
        const ev = parseLine(l);
        if (ev) out.push(ev);
      }
      return out;
    },
    bumpGeneration() { buf = ""; return ++gen; },
    generation() { return gen; },
  };
}

export function parseProperty(stdout) {
  const m = /^\s*s\s+"((?:[^"\\]|\\.)*)"/m.exec(String(stdout || ""));
  return m ? m[1].replace(/\\"/g, '"') : null;
}

export function atvvoiceNames(listStdout) {
  return String(listStdout || "").split("\n")
    .map(l => l.trim().split(/\s+/)[0])
    .filter(n => n && n.startsWith("org.atvvoice."));
}

// Plan 4 §4.4: NameOwnerChanged for an org.atvvoice.* name, from the bus itself. An empty newOwner is
// a departure, an empty oldOwner an arrival, both non-empty a replacement.
export function parseNameOwnerChanged(line) {
  let m;
  try { m = JSON.parse(line); } catch (e) { return null; }
  if (!m || m.type !== "signal" || m.sender !== "org.freedesktop.DBus" || m.member !== "NameOwnerChanged") return null;
  const d = m.payload && Array.isArray(m.payload.data) ? m.payload.data : null;
  if (!d || d.length !== 3 || !d.every(x => typeof x === "string")) return null;
  if (!d[0].startsWith("org.atvvoice.")) return null;
  return { name: d[0], oldOwner: d[1], newOwner: d[2] };
}
