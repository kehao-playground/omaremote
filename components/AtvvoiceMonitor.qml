// Spec §3 ATVVoice (bus name discovered by prefix; State/NodeName; MicClose/MicToggle), §5.1 (only the selected sender,
// exact path and interface; a generation per monitor (re)connect; State and NodeName read on start and reconnect), §5.4 (backoff).
// Plan 4 §4.4: which owner is the source is decided by lib/AtvSource.mjs; this file only runs the processes it asks for.
import QtQuick
import Quickshell
import Quickshell.Io
import "../lib/Dbus.mjs" as Dbus
import "../lib/Systemd.mjs" as Systemd
import "../lib/AtvSource.mjs" as AtvSource

Item {
  id: root
  readonly property string path: "/org/atvvoice/Daemon"
  readonly property string iface: "org.atvvoice.Daemon"
  property string busName: ""
  property string sender: ""                     // unique name (":1.42"); "" while absent
  property int generation: 0
  property int retryMs: 0                        // plan 4 §4.4: current backoff interval (diagnostic), 0 when connected
  property double retryAt: 0                     // epoch ms of the next scheduled rediscovery, 0 when none
  property string _resolving: ""                 // name whose owner the `owner` process is resolving
  property int _resolveId: 0                     // AtvSource lookup id of the running `owner` process
  property var _resolveNext: null                // { id, name } queued while `owner` is still running
  property var _reads: []                        // requestIds waiting for a State read not yet launched
  property var _inflight: []                     // requestIds the running stateProc will answer
  // Plan 4 §4.4: every property read records the source epoch at launch; replies from an older epoch are
  // dropped. A read requested while the same process runs is re-run after it exits instead of being lost.
  property int _nodeEpoch: -1
  property bool _nodeAgain: false
  property int _initEpoch: -1
  property bool _initAgain: false
  property int _stateEpoch: -1
  property int _stateGen: 0
  property var core: AtvSource.createAtvSource({ backoffMs: Systemd.backoffMs })
  property var parser: Dbus.createSignalParser({
    path: root.path, iface: root.iface, member: "MicStateChanged",
    acceptSender: function(s) { return root.sender !== "" && s === root.sender }
  })
  signal source(string sender, int generation, string busName)
  signal signalEvent(var ev)
  signal stateRead(string requestId, string state, int generation)   // state "" on failure
  signal nodeName(string name)

  function start() { root._apply(root.core.start(Date.now())) }
  function readState(requestId) {
    if (!root.busName) { root.stateRead(requestId, "", root.generation); return }
    root._reads.push(requestId)
    root._launchState()
  }
  function _launchState() {
    if (stateProc.running || root._reads.length === 0) return
    root._inflight = root._reads; root._reads = []
    root._stateEpoch = root.core.snapshot().epoch
    root._stateGen = root.generation
    stateProc.running = true
  }
  function _readNode() {
    if (nodeProc.running) { root._nodeAgain = true; return }
    root._nodeEpoch = root.core.snapshot().epoch
    nodeProc.running = true
  }
  function _readInit() {
    if (initState.running) { root._initAgain = true; return }
    root._initEpoch = root.core.snapshot().epoch
    initState.running = true
  }
  function _resolve(r) {
    if (owner.running) { root._resolveNext = r; return }
    root._resolveId = r.id
    root._resolving = r.name
    owner.running = true
  }
  function micClose() { if (root.busName) Quickshell.execDetached(["busctl", "--user", "call", root.busName, root.path, root.iface, "MicClose"]) }
  function micToggle() { if (root.busName) Quickshell.execDetached(["busctl", "--user", "call", root.busName, root.path, root.iface, "MicToggle"]) }

  function _apply(effects) {
    for (var i = 0; i < effects.length; i++) {
      var e = effects[i]
      switch (e.type) {
        case "discover": discover.running = true; break
        case "resolveOwner": root._resolve({ id: e.id, name: e.name }); break
        case "source":                           // host obligation: setDbusSource before any signal of the new generation
          root.sender = e.sender
          root.busName = e.busName
          root.generation = root.parser.bumpGeneration()
          root.source(root.sender, root.generation, root.busName)
          break
        case "startMonitor": monitor.running = true; root._readNode(); root._readInit(); break
        case "stopMonitor": monitor.running = false; break
        case "retry": backoff.interval = e.ms; backoff.restart(); break
        case "cancelRetry": backoff.stop(); break
      }
    }
    var s = root.core.snapshot()
    root.retryMs = s.retryMs
    root.retryAt = s.retryAt
  }
  Timer { id: backoff; repeat: false; onTriggered: root._apply(root.core.retryFired(Date.now())) }

  Process {                                      // 1. names with the org.atvvoice. prefix
    id: discover
    command: ["busctl", "--user", "list", "--no-legend"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root._apply(root.core.discovered(Dbus.atvvoiceNames(text), Date.now())) }
  }
  Process {                                      // 2. unique name of the owner → the only accepted sender
    id: owner
    command: ["busctl", "--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", "s", root._resolving]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root._apply(root.core.ownerResolved(root._resolveId, Dbus.parseProperty(text), Date.now())) }
    onExited: function(code, st) { if (root._resolveNext) { var r = root._resolveNext; root._resolveNext = null; root._resolve(r) } }
  }
  Process {                                      // 3. signal monitor
    id: monitor
    command: ["busctl", "--user", "--json=short", "monitor", "--match", "type='signal',interface='org.atvvoice.Daemon',member='MicStateChanged'"]
    stdout: SplitParser { splitMarker: "\n"; onRead: function(line) {
      var evs = root.parser.feed(line + "\n")
      for (var i = 0; i < evs.length; i++) root.signalEvent(evs[i])
    } }
    onExited: function(code, st) { root._apply(root.core.monitorExited(Date.now())) }
  }
  Process {                                      // plan 4 §4.4: arrivals, departures and replacements of org.atvvoice.* names
    id: owners
    running: true
    command: ["busctl", "--user", "--json=short", "monitor", "--match",
              "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.atvvoice'"]
    stdout: SplitParser { splitMarker: "\n"; onRead: function(line) {
      var ev = Dbus.parseNameOwnerChanged(line)
      if (ev) root._apply(root.core.nameOwnerChanged(ev, Date.now()))
    } }
    onExited: function(code, st) { ownersRestart.restart() }
  }
  Timer { id: ownersRestart; interval: 2000; repeat: false; onTriggered: owners.running = true }
  Process {                                      // 4. NodeName on (re)connect
    id: nodeProc
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "NodeName"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      if (!root.core.isCurrent(root._nodeEpoch)) return            // a previous owner's answer
      var n = Dbus.parseProperty(text); if (n) root.nodeName(n)
    } }
    onExited: function(code, st) { if (root._nodeAgain) { root._nodeAgain = false; root._readNode() } }
  }
  Process {                                      // 5. State on (re)connect, delivered like a signal
    id: initState
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "State"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      if (!root.core.isCurrent(root._initEpoch)) return            // a previous owner's answer: never a signal of the new one
      var s = Dbus.parseProperty(text)
      if (s) root.signalEvent({ state: s, sender: root.sender, path: root.path, interface: root.iface, member: "MicStateChanged", generation: root.generation })
    } }
    onExited: function(code, st) { if (root._initAgain) { root._initAgain = false; root._readInit() } }
  }
  Process {                                      // 6. explicit re-reads (readAtv effects); answers every queued request
    id: stateProc
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "State"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      // A stale answer is reported as a failed read under the generation it was launched for, which
      // VoiceSession rejects; it must not update remoteState or decide anything for the new owner.
      var stale = !root.core.isCurrent(root._stateEpoch)
      var s = stale ? "" : (Dbus.parseProperty(text) || "")
      var ids = root._inflight; root._inflight = []
      for (var i = 0; i < ids.length; i++) root.stateRead(ids[i], s, stale ? root._stateGen : root.generation)
    } }
    onExited: function(code, st) { root._launchState() }
  }
}
