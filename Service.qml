// Spec §2 (Service hosts the engine; BarWidget/Panel only read state), §4.1/§4.3 (GlobalShortcut → KeyEngine, hard-coded reset),
// §4.4 (actions), §3 plugin-side files, §6.3 (flashes), §8 (never throw into the shell). Voice/mic/self-test sections follow in Tasks 6–8.
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "lib/Defaults.mjs" as Defaults
import "lib/KeyEngine.mjs" as KeyEngine
import "lib/Actions.mjs" as Actions
import "lib/Presentation.mjs" as Presentation
import "lib/VoiceSession.mjs" as VoiceSession
import "lib/MicApply.mjs" as MicApply
import "components"

Item {
  id: root
  property var shell: null                        // scoped shell facade injected by omarchy-shell; unused, kept for the contract

  // ---- environment (overrides exist for the test harness only) --------------
  readonly property string ipcTarget: Quickshell.env("OMAREMOTE_IPC_TARGET") || "omaremote"
  readonly property string shortcutAppid: Quickshell.env("OMAREMOTE_APPID") || "omaremote"
  readonly property string configHome: Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config")
  readonly property string dataHome: Quickshell.env("XDG_DATA_HOME") || (Quickshell.env("HOME") + "/.local/share")
  readonly property string pluginDir: Qt.resolvedUrl(".").toString().replace(/^file:\/\//, "").replace(/\/$/, "")
  readonly property bool dispatchViaHyprctl: Quickshell.env("OMAREMOTE_DISPATCH") === "hyprctl"   // harness only

  // ---- host constants --------------------------------------------------------
  readonly property int flashMs: 600
  readonly property int resetFlashMs: 1000
  readonly property int shortCmdMs: 2000
  readonly property int restartCmdMs: 10000

  // ---- state read by BarWidget/Panel (never written by them) -----------------
  readonly property var config: configStore.config
  readonly property var configProblems: configStore.problems
  readonly property bool configInvalid: configStore.invalid
  property string hudText: ""
  property string flash: ""
  property string lastAction: ""
  property int errorCount: 0
  property string lastError: ""
  property var heldKeys: []
  signal resetHappened()                          // §4.3: BarWidget closes the Panel

  // ---- modules ---------------------------------------------------------------
  property var engine: null
  property var voice: null
  property string voiceState: "idle"
  property string voiceOwner: ""
  property bool voiceInferred: false
  property string backendClass: "unknown"
  property string remoteState: "unknown"          // last ATVVoice State; "absent" when no org.atvvoice.* on the bus
  property string remoteNode: ""
  property string atvBusName: ""
  property bool remoteWarning: false
  property string voxAudioDevice: ""
  property double recordingSince: 0
  property int elapsedMs: 0
  readonly property string hudLine: Presentation.hudLine({ voiceState: root.voiceState, hudText: root.hudText, elapsedMs: root.elapsedMs, flash: root.flash })
  Timer { interval: 250; repeat: true; running: root.voiceState === "recording"; onTriggered: root.elapsedMs = Date.now() - root.recordingSince }

  // ---- exception containment (Controller Ruling 13): every call into a lib engine/session that can
  // create a deadline must not skip rearm() if it throws — this is the only such entry point. --------
  function guarded(label, fn) {
    try { return fn() }
    catch (err) { root.errorCount++; root.lastError = label + ": " + err; console.log("omaremote: " + label + " threw: " + err); return [] }
    finally { root.rearm() }
  }

  // ---- effect router (the only consumer of module effects) -------------------
  function dispatch(effects, src) {
    if (!effects) return
    for (var i = 0; i < effects.length; i++) {
      var e = effects[i]
      try { root.applyEffect(e, src) } catch (err) { console.log("omaremote: effect " + e.type + " from " + src + " threw: " + err) }
    }
  }
  function applyEffect(e, src) {
    switch (e.type) {
      case "action": root.runAction(e); break
      case "reset": root.onEngineReset(); break
      case "hud": root.hudText = e.text; break
      case "error": root.errorCount++; root.lastError = e.reason; console.log("omaremote: " + src + " error " + e.reason); break
      // ---- voice effects (Task 6) ----
      case "cmd": runner.run(src, e.id, e.argv, e.kind === "restart" ? root.restartCmdMs : root.shortCmdMs); break
      case "state": root.onVoiceState(e); break
      case "poll": vox.poll(); break
      case "readAtv": atv.readState(e.requestId); break
      case "micClose": atv.micClose(); voice.micClosed(); break
      // ---- mic/stat effects (Task 7) ----
      // ---- self-test effects (Task 8) ----
      default: console.log("omaremote: unhandled effect " + e.type + " from " + src)
    }
  }

  // ---- one Timer for every module (host obligations) -------------------------
  Timer { id: tick; repeat: false; onTriggered: root.advanceAll() }
  function deadlines() {
    return [engine ? engine.nextDeadline() : null, voice ? voice.nextDeadline() : null]
    // ---- more deadlines (Tasks 7–8) ----
  }
  function rearm() {
    var ds = root.deadlines(), d = null
    for (var i = 0; i < ds.length; i++) if (ds[i] !== null && ds[i] !== undefined && (d === null || ds[i] < d)) d = ds[i]
    if (d === null) { tick.stop(); return }
    tick.interval = Math.max(1, d - Date.now())
    tick.restart()
  }
  function advanceAll() {
    var now = Date.now()
    if (engine) root.dispatch(root.guarded("engine.advance", function() { return engine.advance(now) }), "engine")
    if (voice) root.dispatch(root.guarded("voice.advance", function() { return voice.advance(now) }), "voice")
    // ---- more advances (Tasks 7–8) ----
    root.rearm()
  }

  // ---- config ----------------------------------------------------------------
  Process {
    id: mkdirs
    command: ["mkdir", "-p", root.configHome + "/omaremote", root.dataHome + "/omaremote"]
    running: true
    onExited: function(code, status) { configStore.ready = true }
  }
  ConfigStore {
    id: configStore
    path: root.configHome + "/omaremote/config.json"
    onChanged: function(kind) { root.onConfigChanged(kind) }
    onSaveFailed: function(reason) { root.errorCount++; root.lastError = "config-write: " + reason }
  }
  function onConfigChanged(kind) {
    var now = Date.now()
    if (kind === "load") { root.startModules(now); root.rearm(); return }
    if (kind === "commit") return                                  // §6.2: the internal voice.mic write reloads nothing
    if (kind !== "voice") {                                         // §4.3 reset without emitting
      root.dispatch(root.guarded("engine.reload", function() { return engine.reload(configStore.config) }), "engine")
      root.heldKeys = engine.heldKeys()
    }
    if (voice) {
      if (kind === "external") root.dispatch(root.guarded("voice.abort", function() { return voice.abort(now) }), "voice")     // §5.2: config reload aborts
      root.guarded("voice.setConfig", function() { voice.setConfig(configStore.config); return [] })
      root.updateRemoteWarning()
    }
    root.rearm()
  }
  function startModules(now) {
    engine = KeyEngine.createKeyEngine(configStore.config)
    voice = VoiceSession.createVoiceSession(configStore.config)
    vox.start()
    atv.start()
    root.refreshAudioDevice()
    // ---- module start (Tasks 7–8) ----
  }

  // ---- key input (§4.1): GlobalShortcut per logical key ---------------------
  Instantiator {
    model: Defaults.KEY_NAMES
    delegate: GlobalShortcut {
      required property string modelData
      appid: root.shortcutAppid
      name: modelData
      onPressed: root.onKeyEdge(modelData, "down", "shortcut")
      onReleased: root.onKeyEdge(modelData, "up", "shortcut")
    }
  }
  function onKeyEdge(name, edge, source) {
    if (!engine || Defaults.KEY_NAMES.indexOf(name) < 0 || (edge !== "down" && edge !== "up")) return false
    var now = Date.now()
    // ---- self-test recorder (Task 8) ----
    if (name === "mic" && root.config.keys.mic.ptt) {                          // §5.1 HID mic key
      root.dispatch(root.guarded("voice.hid" + edge, function() { return edge === "down" ? voice.hidPress(now) : voice.hidRelease(now) }), "voice")
      root.rearm()
      return true
    }
    root.dispatch(root.guarded("engine." + edge, function() { return edge === "down" ? engine.press(name, now) : engine.release(name, now) }), "engine")
    root.heldKeys = engine.heldKeys()
    root.rearm()
    return true
  }

  // ---- actions (§4.4) ----------------------------------------------------------
  function runAction(e) {
    var r = Actions.toArgv(e.action)
    if (r.kind === "dispatch") {
      if (root.dispatchViaHyprctl) Quickshell.execDetached(["hyprctl", "dispatch"].concat(r.cmd.split(" ")))
      else Hyprland.dispatch(r.cmd)
    } else if (r.kind === "process") Quickshell.execDetached(r.argv)
    root.lastAction = e.key + ":" + e.trigger + (e.repeat ? ":repeat" : "") + ":" + Actions.describe(e.action)
    if (e.trigger !== "tap" && root.config && root.config.voice.actionFlash)
      root.showFlash(Presentation.flashText(e.key, e.trigger, e.action), root.flashMs)      // §6.3 600 ms flash
  }
  Timer { id: flashTimer; repeat: false; onTriggered: root.flash = "" }
  function showFlash(text, ms) { root.flash = text; flashTimer.interval = ms; flashTimer.restart() }

  // ---- reset (§4.3 hard-coded escape hatch) ------------------------------------
  function onEngineReset() {                        // the engine already cleared its keys before emitting {type:"reset"}
    root.heldKeys = []
    root.showFlash("Reset", root.resetFlashMs)     // §6.3 1 s
    if (voice) root.dispatch(root.guarded("voice.abort", function() { return voice.abort(Date.now()) }), "voice")                // §4.3: cancel, never stop
    root.resetHappened()
  }
  function doReset(origin) {
    if (engine) root.dispatch(root.guarded("engine.reset", function() { return engine.reset() }), "engine")   // emits {type:"reset"} → onEngineReset
    root.rearm()
  }

  // ---- voice adapters (§5.1, §3) ---------------------------------------------
  function onVoiceState(e) {
    var prev = root.voiceState
    root.voiceState = e.state
    root.voiceOwner = e.owner || ""
    root.voiceInferred = e.owner === "dbus" || e.owner === "keyboard"
    if (e.state === "recording" && prev !== "recording") { root.recordingSince = Date.now(); root.elapsedMs = 0 }
    // ---- external recording → mic apply / self-test (Tasks 7–8) ----
  }
  function updateRemoteWarning() {                                              // §5.4
    var mode = root.config ? root.config.voice.mic : "remote"
    var warn = mode === "remote" && (!root.atvBusName || !root.remoteNode || root.voxAudioDevice !== root.remoteNode)
    root.remoteWarning = warn
    if (voice) voice.setDbusEnabled(!warn)
  }
  Process {
    id: audioDeviceProbe
    command: ["voxtype", "config", "get", "audio.device", "--json"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var r = MicApply.parseConfigGet(text)
      root.voxAudioDevice = r.effective === null || r.effective === undefined ? "" : String(r.effective)
      root.updateRemoteWarning()
    } }
  }
  function refreshAudioDevice() { if (!audioDeviceProbe.running) audioDeviceProbe.running = true }

  CommandRunner {
    id: runner
    onFinished: function(src, id, code, stdout, timedOut) {
      var now = Date.now()
      if (src === "voice" && root.voice) root.dispatch(root.guarded("voice.cmdExit", function() { return root.voice.cmdExit(id, code, now) }), "voice")
      // ---- mic command exits (Task 7) ----
      root.rearm()
    }
  }
  VoxtypeMonitor {
    id: vox
    onStatus: function(cls, fresh, raw) {
      var now = Date.now()
      root.backendClass = cls
      if (root.voice) root.dispatch(root.guarded("voice.status", function() { return root.voice.status(cls, now, { fresh: fresh }) }), "voice")
      // ---- fresh polls → mic apply / verifier (Task 7) ----
      root.rearm()
    }
  }
  AtvvoiceMonitor {
    id: atv
    onSource: function(sender, generation, busName) {
      root.atvBusName = busName
      if (!busName) root.remoteState = "absent"
      if (root.voice) root.voice.setDbusSource({ sender: sender || null, generation: generation })
      root.updateRemoteWarning()
    }
    onSignalEvent: function(ev) {
      root.remoteState = ev.state
      if (root.voice) root.dispatch(root.guarded("voice.dbus", function() { return root.voice.dbus(ev, Date.now()) }), "voice")
      root.rearm()
    }
    onStateRead: function(requestId, state, generation) {
      if (state) root.remoteState = state
      if (root.voice) root.dispatch(root.guarded("voice.atvRead", function() { return root.voice.atvRead({ state: state || "unknown", requestId: requestId, generation: generation }, Date.now()) }), "voice")
      root.rearm()
    }
    onNodeName: function(name) { root.remoteNode = name; root.updateRemoteWarning() }
  }
  Loader {
    id: hudLoader
    source: Qt.resolvedUrl("components/Hud.qml")
    onLoaded: root.syncHud()
    onStatusChanged: if (status === Loader.Error) console.log("omaremote: HUD unavailable outside omarchy-shell")
  }
  function syncHud() {
    var h = hudLoader.item
    if (!h) return
    h.line = root.hudLine
    h.recording = root.voiceState === "recording"
    h.enabled = root.config ? root.config.voice.hud : true
  }
  onHudLineChanged: syncHud()
  onVoiceStateChanged: syncHud()
  // NOTE (deviation from brief): `onConfigChanged: syncHud()` here would collide with the existing
  // `function onConfigChanged(kind)` member on root (same identifier) — QML rejects the duplicate.
  // A Connections block gives the `config` property's auto-generated change handler its own scope.
  Connections {
    target: root
    function onConfigChanged() { root.syncHud() }
  }

  function ipcVoice(verb, arg) {
    var now = Date.now()
    if (!voice) return JSON.stringify({ ok: false, reason: "not-ready" })
    if (verb === "state") {
      if (!atv.sender) return JSON.stringify({ ok: false, reason: "no-atvvoice" })
      root.dispatch(root.guarded("voice.dbus", function() { return voice.dbus({ state: arg, sender: atv.sender, path: atv.path, interface: atv.iface, member: "MicStateChanged", generation: atv.generation }, now) }), "voice")
      root.remoteState = arg
      root.rearm()
      return JSON.stringify({ ok: true })
    }
    if (verb === "poll") { vox.poll(); return JSON.stringify({ ok: true }) }
    if (verb === "audioDevice") { root.refreshAudioDevice(); return JSON.stringify({ ok: true }) }
    return JSON.stringify({ ok: false, reason: "unknown-verb" })
  }

  // ---- IPC (§2 hardware-free testability) ---------------------------------------
  function statusJson() {
    return JSON.stringify({
      config: !!engine, configInvalid: root.configInvalid, configProblems: root.configProblems,
      timing: root.config ? root.config.timing : null,
      heldKeys: root.heldKeys, lastAction: root.lastAction, hud: root.hudLine, flash: root.flash,
      errorCount: root.errorCount, lastError: root.lastError
      , voice: voice ? (function(s) { return { state: s.state, owner: s.owner, inferred: s.inferred, pendingCmds: s.pendingCmds, gates: s.gates, backendFresh: s.backendFresh } })(voice.snapshot()) : null
      , backend: root.backendClass
      , remote: { state: root.remoteState, node: root.remoteNode, bus: root.atvBusName, sender: atv.sender, warning: root.remoteWarning }
      , audioDevice: root.voxAudioDevice
      // ---- more status (Tasks 7–8) ----
    })
  }
  IpcHandler {
    target: root.ipcTarget
    function ping(): string { return "ok" }
    function key(name: string, edge: string): string { return root.onKeyEdge(name, edge, "ipc") ? "ok" : "unknown-key" }
    function reset(): string { root.doReset("ipc"); return "ok" }
    function status(): string { return root.statusJson() }
    function voice(verb: string, arg: string): string { return root.ipcVoice(verb, arg) }
    // ---- more verbs (Tasks 7–8) ----
  }
}
