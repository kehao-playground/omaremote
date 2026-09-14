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
      // ---- mic/stat effects (Task 7) ----
      // ---- self-test effects (Task 8) ----
      default: console.log("omaremote: unhandled effect " + e.type + " from " + src)
    }
  }

  // ---- one Timer for every module (host obligations) -------------------------
  Timer { id: tick; repeat: false; onTriggered: root.advanceAll() }
  function deadlines() {
    return [engine ? engine.nextDeadline() : null]
    // ---- more deadlines (Tasks 6–8) ----
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
    if (engine) root.dispatch(engine.advance(now), "engine")
    // ---- more advances (Tasks 6–8) ----
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
    if (kind !== "voice") { root.dispatch(engine.reload(configStore.config), "engine"); root.heldKeys = engine.heldKeys() }   // §4.3 reset without emitting
    // ---- config change → voice (Task 6) ----
    root.rearm()
  }
  function startModules(now) {
    engine = KeyEngine.createKeyEngine(configStore.config)
    // ---- module start (Tasks 6–8) ----
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
    // ---- HID mic key → VoiceSession (Task 6) ----
    root.dispatch(edge === "down" ? engine.press(name, now) : engine.release(name, now), "engine")
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
    // ---- reset → voice abort (Task 6) ----
    root.resetHappened()
  }
  function doReset(origin) {
    if (engine) root.dispatch(engine.reset(), "engine")   // emits {type:"reset"} → onEngineReset
    root.rearm()
  }

  // ---- IPC (§2 hardware-free testability) ---------------------------------------
  function statusJson() {
    return JSON.stringify({
      config: !!engine, configInvalid: root.configInvalid, configProblems: root.configProblems,
      timing: root.config ? root.config.timing : null,
      heldKeys: root.heldKeys, lastAction: root.lastAction, hud: root.hudText, flash: root.flash,
      errorCount: root.errorCount, lastError: root.lastError
      // ---- more status (Tasks 6–8) ----
    })
  }
  IpcHandler {
    target: root.ipcTarget
    function ping(): string { return "ok" }
    function key(name: string, edge: string): string { return root.onKeyEdge(name, edge, "ipc") ? "ok" : "unknown-key" }
    function reset(): string { root.doReset("ipc"); return "ok" }
    function status(): string { return root.statusJson() }
    // ---- more verbs (Tasks 6–8) ----
  }
}
