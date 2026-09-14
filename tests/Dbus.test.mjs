import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignalParser, parseProperty, atvvoiceNames } from "../lib/Dbus.mjs";

const line = (state, sender = ":1.42", extra = {}) => JSON.stringify({
  type: "signal", endian: "l", flags: 1, version: 1, cookie: 7, sender,
  path: "/org/atvvoice/Daemon", interface: "org.atvvoice.Daemon", member: "MicStateChanged",
  payload: { type: "s", data: [state] }, ...extra,
}) + "\n";

const mk = () => createSignalParser({
  path: "/org/atvvoice/Daemon", iface: "org.atvvoice.Daemon", member: "MicStateChanged",
  acceptSender: (s) => s === ":1.42",
});

const EV = (state, generation = 0) => ({ state, sender: ":1.42", path: "/org/atvvoice/Daemon", interface: "org.atvvoice.Daemon", member: "MicStateChanged", generation });

test("parses one signal per line into {state, sender, path, interface, member, generation}", () => {
  const p = mk();
  assert.deepEqual(p.feed(line("streaming")), [EV("streaming")]);
});

test("buffers partial lines across feeds", () => {
  const p = mk();
  const full = line("connected");
  assert.deepEqual(p.feed(full.slice(0, 20)), []);
  assert.deepEqual(p.feed(full.slice(20)), [EV("connected")]);
});

test("rejects other senders, paths, interfaces, members and malformed lines", () => {
  const p = mk();
  assert.deepEqual(p.feed(line("streaming", ":1.99")), []);
  assert.deepEqual(p.feed(line("streaming", ":1.42", { path: "/other" })), []);
  assert.deepEqual(p.feed(line("streaming", ":1.42", { interface: "org.x" })), []);
  assert.deepEqual(p.feed(line("streaming", ":1.42", { member: "Other" })), []);
  assert.deepEqual(p.feed("not json\n"), []);
  assert.deepEqual(p.feed(JSON.stringify({ type: "method_call" }) + "\n"), []);
});

test("bumpGeneration discards buffered partial input and tags later events", () => {
  const p = mk();
  p.feed(line("streaming").slice(0, 10));
  assert.equal(p.bumpGeneration(), 1);
  assert.deepEqual(p.feed(line("streaming")), [EV("streaming", 1)]);
});

test("parseProperty reads busctl get-property string output", () => {
  assert.equal(parseProperty('s "streaming"\n'), "streaming");
  assert.equal(parseProperty('s "G20S PRO"\n'), "G20S PRO");
  assert.equal(parseProperty(""), null);
  assert.equal(parseProperty("Failed to get property"), null);
});

test("atvvoiceNames extracts org.atvvoice.* from busctl list output", () => {
  const out = "NAME                 PID PROCESS USER CONNECTION UNIT SESSION DESCRIPTION\n" +
              "org.atvvoice.G20SPRO 123 atvvoice k  :1.42 - - -\n" +
              "org.freedesktop.DBus 1 dbus-broker k :1.0 - - -\n";
  assert.deepEqual(atvvoiceNames(out), ["org.atvvoice.G20SPRO"]);
});
