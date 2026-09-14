// Spec §3 ATVVoice (bus name discovered by prefix; State/NodeName; MicClose/MicToggle), §5.1 (only the selected sender,
// exact path and interface; a generation per monitor (re)connect; State and NodeName read on start and reconnect), §5.4 (backoff).
import QtQuick
import Quickshell
import Quickshell.Io
import "../lib/Dbus.mjs" as Dbus
import "../lib/Systemd.mjs" as Systemd

Item {
  id: root
  readonly property string path: "/org/atvvoice/Daemon"
  readonly property string iface: "org.atvvoice.Daemon"
  property string busName: ""
  property string sender: ""                     // unique name (":1.42"); "" while absent
  property int generation: 0
  property int attempts: 0
  property var _reads: []                        // requestIds waiting for a State read
  property var parser: Dbus.createSignalParser({
    path: root.path, iface: root.iface, member: "MicStateChanged",
    acceptSender: function(s) { return root.sender !== "" && s === root.sender }
  })
  signal source(string sender, int generation, string busName)
  signal signalEvent(var ev)
  signal stateRead(string requestId, string state, int generation)   // state "" on failure
  signal nodeName(string name)

  function start() { if (!discover.running) discover.running = true }
  function readState(requestId) {
    if (!root.busName) { root.stateRead(requestId, "", root.generation); return }
    root._reads.push(requestId)
    if (!stateProc.running) stateProc.running = true
  }
  function micClose() { if (root.busName) Quickshell.execDetached(["busctl", "--user", "call", root.busName, root.path, root.iface, "MicClose"]) }
  function micToggle() { if (root.busName) Quickshell.execDetached(["busctl", "--user", "call", root.busName, root.path, root.iface, "MicToggle"]) }

  function _lost() {                             // monitor gone or owner unresolvable: fail closed, then rediscover with backoff
    root.sender = ""
    root.generation = root.parser.bumpGeneration()
    root.source("", root.generation, root.busName)
    backoff.interval = Systemd.backoffMs(root.attempts++)
    backoff.restart()
  }
  Timer { id: backoff; repeat: false; onTriggered: root.start() }

  Process {                                      // 1. names with the org.atvvoice. prefix
    id: discover
    command: ["busctl", "--user", "list", "--no-legend"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var names = Dbus.atvvoiceNames(text)
      if (names.length === 0) { root.busName = ""; root._lost(); return }
      root.busName = names[0]
      owner.running = true
    } }
  }
  Process {                                      // 2. unique name of the owner → the only accepted sender
    id: owner
    command: ["busctl", "--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", "s", root.busName]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var s = Dbus.parseProperty(text)
      if (!s) { root._lost(); return }
      root.sender = s
      root.generation = root.parser.bumpGeneration()
      root.source(root.sender, root.generation, root.busName)     // host obligation: setDbusSource before any signal
      monitor.running = true
      nodeProc.running = true
      initState.running = true
    } }
  }
  Process {                                      // 3. signal monitor
    id: monitor
    command: ["busctl", "--user", "--json=short", "monitor", "--match", "type='signal',interface='org.atvvoice.Daemon',member='MicStateChanged'"]
    stdout: SplitParser { splitMarker: "\n"; onRead: function(line) {
      var evs = root.parser.feed(line + "\n")
      for (var i = 0; i < evs.length; i++) { root.attempts = 0; root.signalEvent(evs[i]) }
    } }
    onExited: function(code, st) { root._lost() }
  }
  Process {                                      // 4. NodeName on (re)connect
    id: nodeProc
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "NodeName"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: { var n = Dbus.parseProperty(text); if (n) root.nodeName(n) } }
  }
  Process {                                      // 5. State on (re)connect, delivered like a signal
    id: initState
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "State"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var s = Dbus.parseProperty(text)
      if (s) root.signalEvent({ state: s, sender: root.sender, path: root.path, interface: root.iface, member: "MicStateChanged", generation: root.generation })
    } }
  }
  Process {                                      // 6. explicit re-reads (readAtv effects); answers every queued request
    id: stateProc
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "State"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var s = Dbus.parseProperty(text) || ""
      var ids = root._reads; root._reads = []
      for (var i = 0; i < ids.length; i++) root.stateRead(ids[i], s, root.generation)
    } }
    onExited: function(code, st) { if (root._reads.length > 0) stateProc.running = true }
  }
}
