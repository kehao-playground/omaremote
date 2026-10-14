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
import "lib/AlsaMic.mjs" as AlsaMic
import "lib/MicSources.mjs" as MicSources
import "lib/Stats.mjs" as Stats
import "lib/Pipewire.mjs" as Pipewire
import "lib/SelfTest.mjs" as SelfTest
import "lib/Doctor.mjs" as Doctor
import "lib/Chord.mjs" as Chord
import "lib/ConfigWrites.mjs" as ConfigWrites
import "lib/TypelessSession.mjs" as TypelessSession
import "lib/EngineSwitch.mjs" as EngineSwitch
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
  readonly property string keytapOverride: Quickshell.env("OMAREMOTE_KEYTAP") || ""                // harness only: a fake keytap client

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
  property string _lastVoiceErrorReason: ""       // finding #16: voice's own error reason, kept apart from the shared lastError slot
  property var heldKeys: []
  property int stuckKeyCount: 0         // monotonic since process start; never cleared by a reset (lastStuckKey is)
  property var lastStuckKey: null      // { key, at } — set when a key's release never arrived within timing.stuckMs; normal-operation signal only (no edges reach KeyEngine during a self-test lease)
  signal resetHappened()                          // §4.3: BarWidget closes the Panel

  // ---- modules ---------------------------------------------------------------
  property var engine: null
  property var voice: null
  property var typeless: null                     // Typeless spec §5; dormant (held quiesced) under Voxtype
  readonly property var switcher: EngineSwitch.createEngineSwitch()
  property bool switching: false                  // an engine switch or engine/mic/hotkey reload is draining
  property var typelessSnap: null
  property string typelessView: "idle"            // Typeless spec §6.3: idle | recording | unsynced (remote mode only)
  property bool _pumping: false
  property bool _micRequesting: false             // ipcMic is between its quiesce and mic.request
  property string _typelessSender: ""             // the ATVVoice source TypelessSession's facts belong to
  property int _typelessGeneration: -1
  readonly property string engineName: root.config ? root.config.voice.engine : "voxtype"
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
  property var mic: null
  property var stats: null
  property bool micPending: false
  property string micCurrentId: ""
  property var micLast: null                      // last terminal `done` effect
  property var micConflict: null                  // { expected, found } from a `conflict` effect
  property string unconfiguredReason: ""
  property var lastCapture: null                  // null = not yet verified (§3); { node, at, mode }
  readonly property var micSources: MicSources.createMicSources()     // picker spec §4.3/§4.4
  property var micSourceList: []
  property bool micSourcesRefreshing: false
  property var statsSummary: ({ today: { count: 0, seconds: 0 }, week: { count: 0, seconds: 0 }, all: { count: 0, seconds: 0 }, longest: null })
  property var selftest: null
  property bool selftestActive: false
  property var selftestId: null                   // id of the live lease, published by statusJson so an interrupted caller can disarm it
  property var doctorRows: []
  property string doctorSummary: "unknown"
  property var doctorFacts: null
  property double doctorAt: 0
  property int doctorSeq: 0
  // Typeless spec §8: under Typeless, VoiceSession's own "voxtype not responding" does not make the plugin unconfigured.
  readonly property bool unconfigured: (root.engineName !== "typeless" && root.voiceState === "unconfigured") || root.doctorSummary === "unconfigured" || root.configInvalid
  readonly property string hudLine: Presentation.hudLine({ voiceState: root.voiceState, hudText: root.hudText, elapsedMs: root.elapsedMs, flash: root.flash, typeless: root.typelessView })
  Timer { interval: 250; repeat: true; running: root.voiceState === "recording" || root.typelessView === "recording"; onTriggered: root.elapsedMs = Date.now() - root.recordingSince }

  // ---- exception containment (Controller Ruling 13): every call into a lib engine/session that can
  // create a deadline must not skip rearm() if it throws — this is the only such entry point. --------
  // DEVIATION (Task 5 review ruling, applied to Task 7's mic.* call sites): `fallback` lets a caller whose
  // module function does not return a plain effects array (mic.request() returns { effects, result }) still
  // route through guarded() instead of duplicating its try/catch/rearm shape. Every other caller is unaffected.
  function guarded(label, fn, fallback) {
    try { return fn() }
    catch (err) { root.errorCount++; root.lastError = label + ": " + err; console.log("omaremote: " + label + " threw: " + err); return fallback !== undefined ? fallback : [] }
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
      case "stuckKey":
        root.lastStuckKey = { key: e.key, at: Date.now() }
        root.stuckKeyCount++
        root.heldKeys = engine ? engine.heldKeys() : []    // advanceAll() never refreshes this; without it the status keeps reporting a key the engine already released
        console.log("omaremote: key " + e.key + " exceeded timing.stuckMs; release presumed lost")
        break
      case "hud": root.hudText = e.text; break
      case "error":
        root.errorCount++; root.lastError = e.reason
        if (src === "voice") root._lastVoiceErrorReason = e.reason   // finding #16: onVoiceState's unconfigured case reads this, not the shared root.lastError
        console.log("omaremote: " + src + " error " + e.reason)
        break
      // ---- voice effects (Task 6) ----
      case "cmd":
        if (src === "mic" && e.kind === "restart") { verifier.markRestart(); vox.restart() }
        runner.run(src, e.id, e.argv, e.kind === "restart" || String(e.kind).indexOf("alsa-") === 0 ? root.restartCmdMs : root.shortCmdMs)   // plan ruling 5
        break
      case "state": if (src === "typeless") root.onTypelessState(e); else root.onVoiceState(e); break
      // ---- Typeless engine effects (Typeless spec §5, §6) ----
      case "tap": root.runTap(e); break
      case "log": console.log("omaremote: " + src + ": " + e.text); break
      case "drainStart": root.onDrainStart(); break
      case "typelessExpired": root.typelessCall("forceUnsynced", function(n) { return root.typeless.forceUnsynced(n) }); break
      case "switchCommit": root.onSwitchCommit(e); break
      case "poll": vox.poll(); break
      case "readAtv": atv.readState(e.requestId); break
      case "micClose": atv.micClose(); voice.micClosed(); break
      case "restart": runner.cancelAll("voice"); vox.restart(); verifier.beginRecovery(Date.now()); break   // §5.3: reap, then bounded restart
      case "show": verifier.pollJob(); break                                                            // Fix round 1 (Ruling 14): mic needs a fresh systemd job reading
      case "verify": verifier.beginVerify("mic", e.id, Date.now()); break
      case "commit": configStore.setVoiceMic(e.mode, e.device); root.refreshAudioDevice(); break                // §3 step 4
      case "done":
        root.micLast = e; root.micPending = mic.pending(); if (e.state !== "queued") root.refreshDoctor()
        if (!mic.pending()) root.typelessCall("resume", function(n) { return root.typeless.resume(n, "mic") })   // §6.2: after the terminal outcome
        break
      case "conflict": root.micConflict = { expected: e.expected, found: e.found }; break
      case "unconfigured": root.unconfiguredReason = e.reason; break
      case "stat": stats.add(e.session); statsStore.save(stats.entries()); root.statsSummary = stats.summary(Date.now()); break
      case "selftestExpired": case "selftestFailed": root.onSelftestEnded(); break
      default: console.log("omaremote: unhandled effect " + e.type + " from " + src)
    }
  }

  // ---- one Timer for every module (host obligations) -------------------------
  Timer { id: tick; repeat: false; onTriggered: root.advanceAll() }
  function deadlines() {
    return [engine ? engine.nextDeadline() : null, voice ? voice.nextDeadline() : null, mic ? mic.nextDeadline() : null, verifier.nextDeadline(),
      selftest ? selftest.nextDeadline() : null, typeless ? typeless.nextDeadline() : null, root.switcher.nextDeadline()]
  }
  function rearm() {
    root.pumpOrchestration()
    root.micPending = mic ? mic.pending() : false; verifier.jobPolling = root.micPending
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
    if (typeless) root.dispatch(root.guarded("typeless.advance", function() { return typeless.advance(now) }), "typeless")
    if (mic) root.dispatch(root.guarded("mic.advance", function() { return mic.advance(now) }), "mic")
    root.guarded("verifier.advance", function() { verifier.advance(now); return [] })
    if (selftest) root.dispatch(root.guarded("selftest.advance", function() { return selftest.advance(now) }), "selftest")
    root.runSwitch(root.guarded("switch.advance", function() { return root.switcher.advance(now) }))
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
    // Typeless spec §6.2: the engine switch commits through its own path (Task 10 applies it there), and a hotkey
    // change through IPC only refreshes the sessions' config. Neither reloads the key engine or aborts anything.
    if (kind === "engine") { root.rearm(); return }
    if (kind === "hotkey") {
      if (voice) root.guarded("voice.setConfig", function() { voice.setConfig(configStore.config); return [] })
      root.typelessCall("setConfig", function(n) { return typeless.setConfig(configStore.config, n) })   // the running session keeps its chord
      root.rearm()
      return
    }
    if (kind === "commit") {                                        // §6.2: the internal voice.mic write reloads and aborts nothing,
      if (voice) {                                                  // but _write replaced the config object: refresh what reads voice.mic
        root.guarded("voice.setConfig", function() { voice.setConfig(configStore.config); return [] })
        root.typelessCall("setConfig", function(n) { return typeless.setConfig(configStore.config, n) })
        // Only a switch to system can be settled here. After a switch to remote the old voxAudioDevice is stale,
        // so a warning computed now would be false; the audioDeviceProbe callback recomputes it with the new value.
        if (configStore.config.voice.mic === "system") root.updateRemoteWarning()
      }
      return
    }
    if (kind !== "voice") {                                         // §4.3 reset without emitting
      root.dispatch(root.guarded("engine.reload", function() { return engine.reload(configStore.config) }), "engine")
      root.heldKeys = engine.heldKeys()
      if (!selftestActive) root.rebuildSelftest()
    }
    if (voice) {
      // Typeless spec §6.2: an external edit of engine, mic or hotkey drains both sessions with their old config;
      // the commit applies the new one. If a drain is already running, its commit applies configStore.config,
      // which already holds this edit. Every other external reload keeps the §5.2 abort.
      if (kind === "external" && typeless && EngineSwitch.reloadNeedsDrain(typeless.config(), configStore.config)) {
        root.beginDrain("reload", configStore.config.voice.engine)
        root.rearm()
        return
      }
      if (kind === "external") root.dispatch(root.guarded("voice.abort", function() { return voice.abort(now) }), "voice")     // §5.2: config reload aborts
      root.guarded("voice.setConfig", function() { voice.setConfig(configStore.config); return [] })
      root.typelessCall("setConfig", function(n) { return typeless.setConfig(configStore.config, n) })
      root.updateRemoteWarning()
    }
    root.rearm()
  }
  function startModules(now) {
    engine = KeyEngine.createKeyEngine(configStore.config)
    voice = VoiceSession.createVoiceSession(configStore.config)
    // The NameOwnerChanged monitor runs from creation, so an org.atvvoice name that appeared before config load
    // was announced while `voice` was null and skipped by onSource; atv.start() will not announce it again
    // (AtvSource treats a discovery while connected as redundant). Seed the session from the current source.
    voice.setDbusSource({ sender: atv.sender || null, generation: atv.generation })
    root.updateRemoteWarning()                                     // and push the warning computed meanwhile (onSource does both)
    vox.start()
    atv.start()
    root.refreshAudioDevice()
    typeless = TypelessSession.createTypelessSession(configStore.config)
    // Typeless §6.1: dormant first, then seeded with the current source's last State (read before the session
    // existed). startTypeless owns that order; tests/EngineSwitch.test.mjs pins it.
    root._typelessSender = atv.sender || ""; root._typelessGeneration = atv.generation
    root.dispatch(root.guarded("typeless.start", function() {
      return EngineSwitch.startTypeless(typeless, configStore.config.voice.engine, atv.sender ? root.remoteState : null, now)
    }), "typeless")
    root.typelessSnap = typeless.snapshot()
    mic = MicApply.createMicApply({ voice: EngineSwitch.micVoiceView(voice, typeless, function() { return root.engineName }),
                                    alsaArgv: ["bash", root.pluginDir + "/host/omaremote-setup", "alsa-mic"] })
    stats = Stats.createStats(statsStore.loaded ? statsStore.entries : [])
    root.statsSummary = stats.summary(now)
    root.rebuildSelftest()
    root.refreshDoctor()
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
    if (selftest && selftest.active()) {                                   // §7 step 6: raw counts before the engine; IPC tracked separately
      root.guarded("selftest.record", function() { selftest.record(source === "ipc" ? "ipc" : "shortcut", name, edge, now); return [] })
      root.rearm()
      return true
    }
    // Plan 4 §4.2: in remote mode the mic key reaches neither voice nor engine. The remote's own ATVV
    // stream (D-Bus) is the trigger there, and the HID key is a press-time pulse from the same press:
    // acting on it too would start a second session. Dropped even under remoteWarning, because
    // Voxtype's device is then the ATVVoice node and an HID-started session would record silence.
    // Typeless spec §6.1: under Typeless the mic key's press edge goes to TypelessSession (one tap in system mode,
    // nothing in remote mode) and its release is dropped, whatever keys.mic.trigger says.
    if (name === "mic" && root.engineName === "typeless") {
      if (edge === "down") root.typelessCall("hidPress", function(n) { return typeless.hidPress(n) })
      root.rearm()
      return true
    }
    if (name === "mic" && root.config.voice.mic === "remote") { root.rearm(); return true }
    var micTrigger = root.config.keys.mic.trigger                              // §5.1 HID mic key
    if (name === "mic" && micTrigger === "toggle") {
      // Press edge only. This mode exists for buttons whose firmware sends press and release in the
      // same millisecond, where acting on the release would stop the session ~0.1 s after starting
      // it -- mechanically correct and useless. Dropping the release is the point.
      if (edge === "down") root.dispatch(root.guarded("voice.hidToggle", function() { return voice.hidToggle(now) }), "voice")
      root.rearm()
      return true
    }
    if (name === "mic" && micTrigger === "ptt") {
      root.dispatch(root.guarded("voice.hid" + edge, function() { return edge === "down" ? voice.hidPress(now) : voice.hidRelease(now) }), "voice")
      root.rearm()
      return true
    }
    // micTrigger === "key" falls through to the engine, so mic behaves as an ordinary key.
    root.dispatch(root.guarded("engine." + edge, function() { return edge === "down" ? engine.press(name, now) : engine.release(name, now) }), "engine")
    root.heldKeys = engine.heldKeys()
    root.rearm()
    return true
  }

  // ---- actions (§4.4) ----------------------------------------------------------
  // A key action is a send_key_state down/up pair rather than one wtype process, because wtype's
  // virtual keyboard appearing while the triggering key is still held destroys that key's release
  // edge (measured 2026-10-07). The two halves are spaced: Omarchy's own bindings use 50 ms and
  // note that the split works around Hyprland leaving synthetic key state stuck or repeating.
  //
  // The releases are a queue, not one restartable timer. A `repeat: true` key fires every
  // timing.repeatMs -- 80 ms by default, and settable lower -- so a single timer restarted on each
  // press would discard the pending release of the previous one and leave synthetic keys down.
  readonly property int keyUpDelayMs: 50
  property var pendingKeyUps: []
  function dispatchLua(cmd) {
    if (root.dispatchViaHyprctl) Quickshell.execDetached(["hyprctl", "dispatch", cmd])
    else Hyprland.dispatch(cmd)
  }
  function queueKeyUp(cmd) {
    var q = root.pendingKeyUps.slice()
    q.push({ cmd: cmd, at: Date.now() + root.keyUpDelayMs })
    root.pendingKeyUps = q
    if (!keyUpTimer.running) keyUpTimer.restart()
  }
  function flushKeyUps() {
    var now = Date.now(), still = [], i
    for (i = 0; i < root.pendingKeyUps.length; i++) {
      var p = root.pendingKeyUps[i]
      if (p.at <= now) root.dispatchLua(p.cmd); else still.push(p)
    }
    root.pendingKeyUps = still
    if (still.length) {
      var soonest = still[0].at
      for (i = 1; i < still.length; i++) if (still[i].at < soonest) soonest = still[i].at
      keyUpTimer.interval = Math.max(1, soonest - now)
      keyUpTimer.restart()
    }
  }
  Timer { id: keyUpTimer; interval: root.keyUpDelayMs; repeat: false; onTriggered: root.flushKeyUps() }

  function runAction(e) {
    if (selftest && selftest.active()) return   // §7 step 6: no real actions under a lease
    var r = Actions.toArgv(e.action)
    if (r.kind === "dispatch") {
      // One argv element, not r.cmd.split(" "): a Lua dispatcher carries its arguments inside the
      // string -- hl.dsp.focus({ workspace = "e+1" }) has spaces -- and splitting it would hand
      // hyprctl a dozen fragments. The live path never split; only the harness path did, so the
      // two disagreed exactly where a spaced dispatcher would have shown it.
      root.dispatchLua(r.cmd)
    } else if (r.kind === "keyseq") {
      root.dispatchLua(r.down)
      root.queueKeyUp(r.up)
    } else if (r.kind === "process") Quickshell.execDetached(r.argv)
    root.lastAction = e.key + ":" + e.trigger + (e.repeat ? ":repeat" : "") + ":" + Actions.describe(e.action)
    if (e.trigger !== "tap" && root.config && root.config.voice.actionFlash)
      root.showFlash(Presentation.flashText(e.key, e.trigger, e.action), root.flashMs)      // §6.3 600 ms flash
  }
  Timer { id: flashTimer; repeat: false; onTriggered: root.flash = "" }
  function showFlash(text, ms) { root.flash = text; flashTimer.interval = ms; flashTimer.restart() }

  // ---- reset (§4.3 hard-coded escape hatch) ------------------------------------
  function onEngineReset() {                        // the engine already cleared its keys before emitting {type:"reset"}
    // Release any synthetic keys still pending. The reset exists to escape a stuck state, so it
    // must not leave one of its own behind.
    var pending = root.pendingKeyUps
    root.pendingKeyUps = []
    keyUpTimer.stop()
    for (var i = 0; i < pending.length; i++) root.dispatchLua(pending[i].cmd)
    root.heldKeys = []
    root.lastStuckKey = null
    root.showFlash("Reset", root.resetFlashMs)     // §6.3 1 s
    var targets = EngineSwitch.routeTargets(root.engineName, "reset")                                                       // Typeless §6.1/§6.2
    if (voice && targets.indexOf("voice") >= 0) root.dispatch(root.guarded("voice.abort", function() { return voice.abort(Date.now()) }), "voice")   // §4.3: cancel, never stop
    if (targets.indexOf("typeless") >= 0) root.typelessCall("reset", function(n) { return typeless.reset(n) })
    root.resetHappened()
  }
  function doReset(origin) {
    // A lease swallows every shortcut edge (the panic key included) and holds the shared voice gate, so reset must end it too.
    if (selftest && selftest.active() && root.selftestId !== null) root.selftestDisarm(root.selftestId)
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
    if (e.state === "unconfigured") root.unconfiguredReason = root._lastVoiceErrorReason
    if (e.state === "recording" && prev !== "recording") captureDelay.restart()                 // §3 capture verification
    if (e.state === "recording" && e.owner === "keyboard" && mic && root.micCurrentId) {
      var cur = mic.statusOf(root.micCurrentId)
      if (cur && (cur.state === "applying" || cur.state === "verifying" || cur.state === "rollingBack"))
        root.dispatch(root.guarded("mic.externalRecording", function() { return mic.externalRecording(Date.now()) }), "mic")   // §3: observed interference
    }
    if (e.state === "recording" && e.owner === "keyboard" && selftest && selftest.active())
      root.dispatch(root.guarded("selftest.externalRecording", function() { return selftest.externalRecording(Date.now()) }), "selftest")     // §7 step 6: fail the test, keep observing
  }
  function updateRemoteWarning() {                                              // §5.4
    var mode = root.config ? root.config.voice.mic : "remote"
    // Under Typeless, Voxtype's audio.device plays no part in remote mode; only the ATVVoice source must be ready.
    var warn = mode === "remote" && (!root.atvBusName || !root.remoteNode || (root.engineName !== "typeless" && root.voxAudioDevice !== root.remoteNode))
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
      if (src === "mic" && root.mic) root.dispatch(root.guarded("mic.cmdExit", function() { return root.mic.cmdExit(id, code, stdout, now) }), "mic")
      if (src === "keytap" && root.typeless) {
        var o = EngineSwitch.tapOutcome(code)
        root.typelessCall("tapResult", function(n) { return root.typeless.tapResult(id, o.outcome, o.reason, n) })
      }
      if (src === "doctor") {
        if (code === 0) {
          try { root.doctorFacts = JSON.parse(stdout) } catch (e) { console.log("omaremote: facts parse failed: " + e); root.doctorFacts = null }
          root.evaluateDoctor()
        } else {                                    // Ruling 16: a wedged/killed facts run (124/137, or any other non-zero exit) is recoverable,
          root.doctorRows = []                       // never a stuck `doctor` — refreshDoctor() can simply be called again afterwards
          root.doctorSummary = "facts-timeout"
          root.errorCount++; root.lastError = "doctor: facts timed out"
          root.doctorAt = now
        }
      }
      root.rearm()
    }
  }
  VoxtypeMonitor {
    id: vox
    onStatus: function(cls, fresh, raw) {
      var now = Date.now()
      root.backendClass = cls
      if (root.voice) root.dispatch(root.guarded("voice.status", function() { return root.voice.status(cls, now, { fresh: fresh }) }), "voice")
      if (root.mic) root.dispatch(root.guarded("mic.backend", function() { return root.mic.backend(cls, now, { fresh: fresh }) }), "mic")
      root.guarded("verifier.status", function() { verifier.status(cls, fresh, now); return [] })
      root.rearm()
    }
  }
  AtvvoiceMonitor {
    id: atv
    onSource: function(sender, generation, busName) {
      root.atvBusName = busName
      if (!busName) root.remoteState = "absent"
      if (root.voice) {
        root.voice.setDbusSource({ sender: sender || null, generation: generation })
        // Plan 4 §4.5: a revoked/lost source can never send the `connected` that ends a dbus session.
        if (!sender && EngineSwitch.routeTargets(root.engineName, "sourceLost").indexOf("voice") >= 0)
          root.dispatch(root.guarded("voice.sourceLost", function() { return root.voice.sourceLost(Date.now()) }), "voice")
      }
      // Typeless §5.2: a lost or replaced source makes streaming unknown. A first discovery does not: the session's
      // streaming is already unknown, and arming then would swallow the first hold.
      if (root.typeless && root._typelessSender !== "" && (sender !== root._typelessSender || generation !== root._typelessGeneration))
        root.typelessCall("sourceLost", function(n) { return root.typeless.sourceLost(n) })
      root._typelessSender = sender || ""; root._typelessGeneration = generation
      root.updateRemoteWarning()
      root.rearm()
    }
    onSignalEvent: function(ev) { root.onAtvState(ev) }
    onStateRead: function(requestId, state, generation) {
      if (state) root.remoteState = state
      if (root.voice) root.dispatch(root.guarded("voice.atvRead", function() { return root.voice.atvRead({ state: state || "unknown", requestId: requestId, generation: generation }, Date.now()) }), "voice")
      root.rearm()
    }
    onNodeName: function(name) { root.remoteNode = name; root.updateRemoteWarning() }
  }
  SystemdVerifier {
    id: verifier
    onJobInfo: function(info) {
      if (root.mic && root.mic.pending()) {
        root.dispatch(root.guarded("mic.systemdJob", function() { return root.mic.systemdJob(info.jobPending, Date.now()) }), "mic")
        root.rearm()
      }
    }
    onPollRequested: vox.poll()
    onRecoveryRestarting: root.hudText = "restarting Voxtype"
    onVerified: function(kind, id, ok) {
      var now = Date.now()
      if (kind === "mic" && root.mic) root.dispatch(root.guarded("mic.verifyResult", function() { return root.mic.verifyResult(ok, now, id) }), "mic")
      else if (kind === "recovery" && root.voice) { if (ok) vox.restart(); root.dispatch(root.guarded("voice.restartResult", function() { return root.voice.restartResult(ok, now) }), "voice") }   // discard the old monitor before restartResult(true)
      root.rearm()
    }
  }
  StatsStore {
    id: statsStore
    path: root.dataHome + "/omaremote/stats.json"
    ready: configStore.ready
    onStatsLoaded: { if (root.stats) { root.stats = Stats.createStats(statsStore.entries); root.statsSummary = root.stats.summary(Date.now()) } }
  }
  Timer { id: captureDelay; interval: 400; repeat: false; onTriggered: if (!captureProbe.running) captureProbe.running = true }
  Process {
    id: captureProbe
    command: ["pw-dump"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      try {
        var dump = JSON.parse(text)
        var r = Pipewire.captureSourceOf(dump)
        if (r.streamFound) root.lastCapture = { node: r.node, at: Date.now(), mode: root.config.voice.mic }
        if (r.streamFound && root.config.voice.mic === "system") {             // picker spec §5.3: the fallback HUD
          var want = root.config.voice.systemDevice !== "default" ? root.config.voice.systemDevice : Pipewire.defaultSource(dump)
          var mm = Pipewire.captureMismatch(dump, want)
          if (mm) root.hudText = "recording from " + mm.nodeDescription + ", not " + mm.expectedDescription
        }
      } catch (e) { console.log("omaremote: pw-dump parse failed: " + e) }
    } }
  }
  // Picker spec §4.3: one Process per refresh. A refresh succeeds only with exit 0 AND a JSON array
  // (Pipewire.sourcesFromProbe). A binary that fails to start emits no `exited`, so the deadline covers it.
  Component {
    id: sourcesProbeComponent
    Process {
      id: probe
      property int rid: 0
      property string out: ""
      property int exitCode: -1
      property bool gotOut: false
      property bool gotExit: false
      property bool reported: false
      command: ["pw-dump"]
      stdout: StdioCollector { waitForEnd: true; onStreamFinished: { probe.out = text; probe.gotOut = true; probe.report() } }
      onExited: function(code, status) { probe.exitCode = code; probe.gotExit = true; probe.report() }
      property Timer deadline: Timer { interval: 3000; running: true; repeat: false; onTriggered: probe.abandon() }
      function report() {
        if (probe.reported || !probe.gotOut || !probe.gotExit) return
        probe.reported = true; probe.deadline.stop()
        root.sourcesDone(probe.rid, Pipewire.sourcesFromProbe(probe.exitCode, probe.out, { exclude: root.remoteNode ? [root.remoteNode] : [] }))
        probe.destroy()
      }
      function abandon() {
        if (probe.reported) return
        probe.reported = true; probe.running = false
        root.sourcesDone(probe.rid, null)
        probe.destroy()
      }
    }
  }
  function startSourcesRefresh() {
    var rid = root.micSources.started()
    root.micSourcesRefreshing = true
    var p = sourcesProbeComponent.createObject(root, { rid: rid })
    if (!p) { root.sourcesDone(rid, null); return }
    p.running = true
  }
  function sourcesDone(rid, list) {
    var again = root.micSources.finished(rid, list)          // false and no change for a stale rid
    root.micSourceList = root.micSources.list(); root.micSourcesRefreshing = root.micSources.refreshing()
    if (again) root.startSourcesRefresh()
  }
  function refreshMicSources() { if (root.micSources.requestRefresh()) root.startSourcesRefresh() }
  // Picker spec §4.4: the request-time refusals; null means "go ahead". A `refresh: true` answer obliges us to start now.
  function checkSource(device) {
    if (!AlsaMic.isNodeName(device) || /\.monitor$/.test(device) || device === root.remoteNode) return { ok: false, reason: "invalid-source" }
    var r = root.micSources.check(device)
    if (r.refresh) root.startSourcesRefresh()
    if (r.verdict === "ok") return null
    if (r.verdict === "refreshing") return { ok: false, reason: "busy", detail: "sourcesRefreshing", retryAfterMs: 300 }
    return { ok: false, reason: r.verdict }
  }
  function ipcMic(mode, device) {
    if (!mic) return JSON.stringify({ ok: false, reason: "not-ready" })
    // Refused before any quiesce: a second request must never touch the "mic" holder the pending apply owns.
    if (root.switcher.busy() || mic.pending()) return JSON.stringify({ ok: false, reason: "busy" })
    if (device === "") device = undefined                                    // an empty device from a caller means "default"
    if (mode === "system" && device !== undefined && device !== "default") {   // picker spec §4.4
      var refused = root.checkSource(device)
      if (refused) return JSON.stringify(refused)
    }
    var now = Date.now()
    // Typeless §6.2: under Typeless the apply first quiesces TypelessSession; MicApply (through micVoiceView) waits
    // until it is settled. The "done" effect resumes it after the terminal outcome.
    var underTypeless = root.engineName === "typeless"
    root._micRequesting = true
    var r
    try {
      if (underTypeless) root.typelessCall("quiesce", function(n) { return typeless.quiesce(n, "mic", "changing microphone") })
      r = root.guarded("mic.request", function() { return mic.request(mode, now, { nodeName: root.remoteNode, device: device }) },
                       { effects: [], result: { ok: false, reason: "error" } })
    } finally { root._micRequesting = false }
    if (underTypeless && !r.result.ok) root.typelessCall("resume", function(n) { return typeless.resume(n, "mic") })
    root.dispatch(r.effects, "mic")
    if (r.result.ok) { root.micCurrentId = r.result.operationId; root.micConflict = null }
    root.rearm()
    return JSON.stringify(r.result.ok ? { ok: true, operationId: r.result.operationId, state: "queued" } : { ok: false, reason: r.result.reason })
  }
  function micStatusOf(id) { return mic ? mic.statusOf(id) : null }
  function ipcMicStatus(id) {
    var s = root.micStatusOf(id)
    return JSON.stringify(s ? { ok: true, operationId: id, state: s.state, phase: s.phase, mode: s.mode, error: s.error, rollback: s.rollback }
                            : { ok: false, reason: "unknown-operation" })                         // §3: unknown ID is a failure, never success
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
    h.recording = root.voiceState === "recording" || root.typelessView === "recording"
    h.enabled = root.config ? root.config.voice.hud : true
  }
  onHudLineChanged: syncHud()
  onVoiceStateChanged: syncHud()
  onTypelessViewChanged: syncHud()
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
      root.onAtvState({ state: arg, sender: atv.sender, path: atv.path, interface: atv.iface, member: "MicStateChanged", generation: atv.generation })
      return JSON.stringify({ ok: true })
    }
    if (verb === "poll") { vox.poll(); return JSON.stringify({ ok: true }) }
    if (verb === "audioDevice") { root.refreshAudioDevice(); return JSON.stringify({ ok: true }) }
    return JSON.stringify({ ok: false, reason: "unknown-verb" })
  }

  // ---- self-test (§7 step 6) ---------------------------------------------------
  function rebuildSelftest() {
    var keys = Defaults.KEY_NAMES.filter(function(k) { return root.config.keys[k].supported !== false })
    selftest = SelfTest.createSelfTest({ supportedKeys: keys, gate: voice.gate })
  }
  function selftestArm(leaseMs) {                     // leaseMs: undefined or "" means the default
    var now = Date.now()
    if (!selftest || !voice) return { ok: false, reason: "not-ready" }
    // A live lease is the answer regardless of mic or backend state. Checked before the freshness pre-check:
    // nothing refreshes backendAt while a lease idles, so past 500 ms the pre-check would say backendStale
    // ("retry, it will clear") for a lease that never clears on its own.
    if (selftest.active()) return { ok: false, reason: "busy", detail: "leaseActive", retryAfterMs: 300 }
    if (mic && mic.pending()) return { ok: false, reason: "busy", detail: "gate", retryAfterMs: 300 }   // a mic apply is pending (running or merely deferred) and will take the shared gate
    var s = voice.snapshot()
    var fresh = s.backend === "idle" && s.backendFresh && now - s.backendAt <= 500
    if (!fresh) { vox.poll(); return { ok: false, reason: "busy", detail: "backendStale", retryAfterMs: 300 } }   // Ruling 17: explicit cold-start retry contract
    // DEVIATION (Task 5 review ruling, applied here as it was to Task 7's mic.* call sites): selftest.arm() returns a
    // plain result object, not an effects array, so `guarded` is used with a fallback instead of dispatch().
    var r = root.guarded("selftest.arm", function() {
      return selftest.arm(now, { voiceIdle: s.state === "idle", backendIdleFresh: fresh, heldKeys: engine.heldKeys(), pendingCmds: s.pendingCmds + runner.pending("voice") },
                          leaseMs === "" || leaseMs === undefined ? undefined : leaseMs)
    }, { ok: false, reason: "error" })
    if (r.ok) { root.selftestActive = true; root.selftestId = r.id; root.hudText = "self-test" }
    root.rearm()
    return r
  }
  function onSelftestEnded() {
    root.selftestActive = false
    root.selftestId = null
    if (root.hudText === "self-test") root.hudText = ""
    if (engine) engine.reset()                                             // quarantine: no queued action can fire after the lease
    root.heldKeys = []
  }
  function selftestReport(id) {
    var r = selftest ? root.guarded("selftest.report", function() { return selftest.report(id, Date.now()) }, { ok: false, reason: "error" }) : { ok: false, reason: "not-ready" }
    if (!selftest || !selftest.active()) root.onSelftestEnded()
    root.rearm()
    return r
  }
  function selftestDisarm(id) {
    var ok = selftest ? root.guarded("selftest.disarm", function() { return selftest.disarm(id, Date.now()) }, false) : false
    if (ok) root.onSelftestEnded()
    root.rearm()
    return ok
  }

  // ---- doctor (§6.2 item 4; same rules as host/omaremote-setup --doctor) --------
  // Ruling 16: host/omaremote-facts bounds each of its own tool calls with `timeout 2`, but their sum can exceed
  // shortCmdMs, so this runs through CommandRunner with the 10 s restartCmdMs bound instead of a bare Process —
  // a wedged facts run is killed and reported via onFinished (code 124/137) rather than hanging `doctor` forever.
  function refreshDoctor() {
    if (runner.pending("doctor") === 0) runner.run("doctor", ++root.doctorSeq, [root.pluginDir + "/host/omaremote-facts"], root.restartCmdMs)
  }
  function evaluateDoctor() {
    if (!root.config) return
    var facts = ({})
    if (root.doctorFacts) for (var k in root.doctorFacts) facts[k] = root.doctorFacts[k]
    facts.lastCapture = root.lastCapture                                      // null = not yet verified
    facts.configProblems = root.configProblems
    facts.now = Date.now()
    root.doctorRows = Doctor.evaluate(facts, root.config)
    root.doctorSummary = Doctor.summarize(root.doctorRows, root.config)
    root.doctorAt = Date.now()
  }
  onLastCaptureChanged: evaluateDoctor()
  onConfigProblemsChanged: evaluateDoctor()

  // ---- mic test (§6.1 middle click) ----------------------------------------------
  function micToggle() {
    if (!voice || (mic && mic.pending()) || root.voiceState === "recovering" || root.selftestActive) return "busy"
    if (!root.atvBusName) return "no-atvvoice"
    atv.micToggle()
    if (root.remoteState === "streaming") voice.micClosed(); else voice.micOpened()   // §5.1: plugin-owned only after our own toggle
    return "ok"
  }

  // ---- config writers for the Panel (§6.2: BarWidget/Panel write config only through the Service) ----
  function setKeyField(name, fields) { configStore.setKey(name, fields) }
  function setTiming(t) { configStore.setTiming(t) }
  function resetKeys() { configStore.resetKeys() }
  function setVoiceField(field, value) { configStore.setVoiceField(field, value) }

  // ---- Typeless engine (Typeless spec §5, §6) ----------------------------------------
  function typelessCall(label, fn) {
    if (!root.typeless) return
    var now = Date.now()
    root.dispatch(root.guarded("typeless." + label, function() { return fn(now) }), "typeless")
  }
  function onTypelessState(e) {
    root.typelessSnap = e.state
    root.refreshTypelessView()
  }
  function refreshTypelessView() {                              // §6.3: elapsed time runs from the start tap
    var v = root.engineName === "typeless" && root.typelessSnap ? Presentation.typelessView(root.typelessSnap) : "idle"
    if (v === "recording" && root.typelessView !== "recording") {
      root.recordingSince = root.typelessSnap.since || Date.now()
      root.elapsedMs = Date.now() - root.recordingSince
    }
    root.typelessView = v
  }
  function onAtvState(ev) {                                     // §6.1: State changes reach TypelessSession under both engines
    var now = Date.now()
    root.remoteState = ev.state
    var targets = EngineSwitch.routeTargets(root.engineName, "state")
    if (root.voice && targets.indexOf("voice") >= 0) root.dispatch(root.guarded("voice.dbus", function() { return root.voice.dbus(ev, now) }), "voice")
    if (root.typeless && targets.indexOf("typeless") >= 0 && ev.sender === atv.sender && ev.generation === atv.generation)
      root.typelessCall("streaming", function(n) { return root.typeless.streaming(ev.state === "streaming", n) })
    root.rearm()
  }
  function keytapArgv(chord) {
    return root.keytapOverride ? [root.keytapOverride, "tap", chord]
                               : ["python3", "-I", Quickshell.env("HOME") + "/.local/lib/omaremote/omaremote-keytap", "tap", chord]
  }
  function runTap(e) {
    runner.run("keytap", e.id, root.keytapArgv(e.chord), EngineSwitch.KEYTAP_DEADLINE_MS)
    if (e.kind === "press") root.showFlash(Presentation.TYPELESS_FLASH, root.flashMs)   // §6.3: system mode flashes each tap
  }
  function applyDormancy() {                                    // §6.1: held quiesced (silently) whenever Voxtype is selected
    if (root.engineName === "typeless") root.typelessCall("resume", function(n) { return root.typeless.resume(n, "dormant") })
    else root.typelessCall("quiesce", function(n) { return root.typeless.quiesce(n, "dormant", "") })
  }
  // §6.2: the switch commits once both sessions are drained, and a queued mic apply under Typeless retries its
  // reservation once TypelessSession settles. Runs at the start of every rearm(), which follows every module call,
  // and never re-enters: switch effects run with _pumping set, so a commit cannot land in the middle of drainStart.
  function pumpOrchestration() {
    if (root._pumping || !root.voice || !root.typeless) return
    root._pumping = true
    try {
      var now = Date.now()
      if (root.switcher.busy()) {
        var fx = root.switcher.progress({ voiceDrained: root.voice.drained(), typelessSettled: root.typeless.settled() }, now)
        if (fx.length) root.dispatch(fx, "switch")
      }
      if (root.mic && root.mic.pending() && root.engineName === "typeless") root.dispatch(root.mic.advance(now), "mic")
      // Not inside ipcMic: its quiesce runs (and rearms) before mic.request makes the apply pending.
      if (root.mic && !root._micRequesting) root.dispatch(EngineSwitch.releaseMicHold(root.mic.pending(), root.typeless, now), "typeless")
    } catch (err) { root.errorCount++; root.lastError = "orchestration: " + err; console.log("omaremote: orchestration threw: " + err) }
    finally { root._pumping = false }
  }
  function runSwitch(effects) {
    var was = root._pumping
    root._pumping = true
    try { root.dispatch(effects, "switch") } finally { root._pumping = was }
  }
  function beginDrain(kind, target) {
    var r = root.switcher.begin(kind, target, Date.now())
    if (r.ok) { root.switching = true; root.runSwitch(r.effects) }
    root.rearm()
    return r.ok
  }
  function setEngine(name) {                                    // the Panel's Engine row and the `engine` IPC
    if (name !== "voxtype" && name !== "typeless") return "invalid-engine"
    if (!root.voice || !root.typeless) return "not-ready"
    if (root.switcher.busy() || (root.mic && root.mic.pending()) || root.selftestActive) return "busy"
    if (root.engineName === name) return "ok"
    root.beginDrain("switch", name)
    return "ok"
  }
  function onDrainStart() {
    root.hudText = "switching engine"
    root.typelessCall("quiesce", function(n) { return root.typeless.quiesce(n, "switch", "switching engine") })
    var now = Date.now()
    root.dispatch(root.guarded("voice.drain", function() { return root.voice.drain(now) }), "voice")
  }
  function onSwitchCommit(e) {
    var now = Date.now()
    if (e.kind === "switch") configStore.setVoiceEngine(e.target)          // emits changed("engine"), applied here
    var c = configStore.config
    root.guarded("voice.setConfig", function() { root.voice.setConfig(c); return [] })
    root.typelessCall("setConfig", function(n) { return root.typeless.setConfig(c, n) })
    root.dispatch(root.guarded("voice.undrain", function() { return root.voice.undrain(now, root.remoteState) }), "voice")
    root.applyDormancy()
    root.typelessCall("resume", function(n) { return root.typeless.resume(n, "switch") })
    root.switching = false
    root.refreshTypelessView()
    if (root.hudText === "switching engine") root.hudText = ""
    root.updateRemoteWarning()
    root.refreshDoctor()
  }

  // ---- Typeless hotkey (Typeless spec §4.3 step 5) -----------------------------------
  function ipcTypelessHotkey(chord) {
    if (!configStore.loaded) return JSON.stringify({ ok: false, reason: "not-ready" })
    var p = Chord.parseChord(chord)
    if (!p.ok) return JSON.stringify({ ok: false, reason: "invalid chord: " + p.reason })   // rejected, never defaulted
    if (root.configInvalid) return JSON.stringify({ ok: false, reason: "config.json is invalid" })
    var rawV = configStore.raw && configStore.raw.voice
    var stored = rawV && rawV.typeless && rawV.typeless.hotkey !== undefined ? Chord.canonicalChord(rawV.typeless.hotkey) : undefined
    var last = configStore.writes.lastCarrying(function(t) { return Chord.canonicalChord(configStore.hotkeyOfText(t)) === p.canonical })
    var plan = ConfigWrites.hotkeyWritePlan(stored, p.canonical, last)
    var seq = plan.seq
    if (plan.write) {
      seq = configStore.setTypelessHotkey(p.canonical)
      if (!seq) return JSON.stringify({ ok: false, reason: root.lastError || "config write refused" })
    }
    return JSON.stringify({ ok: true, hotkey: p.canonical, writeSeq: seq })
  }
  function hotkeyStored() {
    var v = configStore.raw && configStore.raw.voice
    return !!(v && v.typeless && v.typeless.hotkey !== undefined)
  }

  // ---- IPC (§2 hardware-free testability) ---------------------------------------
  function statusJson() {
    return JSON.stringify({
      config: !!engine, configInvalid: root.configInvalid, configProblems: root.configProblems,
      timing: root.config ? root.config.timing : null,
      // The mic trigger is published because nothing else exposes it: `config` here is a boolean
      // (engine configured yes/no), so a caller cannot tell ptt from toggle, and an integration
      // test has no deterministic way to wait for a config reload to take effect.
      micTrigger: root.config ? root.config.keys.mic.trigger : null,
      // Published for the same reason as micTrigger: `config` is a boolean, so tests and the panel
      // cannot otherwise wait for a voice.mic / remoteOnDemand reload to take effect.
      voiceMode: root.config ? root.config.voice.mic : null,
      systemDevice: root.config ? root.config.voice.systemDevice : null,
      micSources: { list: root.micSourceList, refreshing: root.micSourcesRefreshing },
      remoteOnDemand: root.config ? root.config.voice.remoteOnDemand : null,
      heldKeys: root.heldKeys, lastStuckKey: root.lastStuckKey, stuckKeyCount: root.stuckKeyCount, lastAction: root.lastAction, hud: root.hudLine, flash: root.flash,
      errorCount: root.errorCount, lastError: root.lastError
      , voice: voice ? (function(s) { return { state: s.state, owner: s.owner, inferred: s.inferred, pendingCmds: s.pendingCmds, gates: s.gates, backendFresh: s.backendFresh } })(voice.snapshot()) : null
      , backend: root.backendClass
      , remote: { state: root.remoteState, node: root.remoteNode, bus: root.atvBusName, sender: atv.sender, warning: root.remoteWarning, retryMs: atv.retryMs, retryAt: atv.retryAt }
      , audioDevice: root.voxAudioDevice
      , mic: { pending: root.micPending, current: root.micCurrentId ? root.micStatusOf(root.micCurrentId) : null, last: root.micLast, conflict: root.micConflict }
      , stats: root.statsSummary
      , lastCapture: root.lastCapture
      , unconfiguredReason: root.unconfiguredReason
      , selftest: { active: root.selftestActive, id: root.selftestActive ? root.selftestId : null,
                    remainingMs: root.selftestActive && root.selftest && root.selftestId !== null ? (function(s) { return s ? s.remainingMs : 0 })(root.selftest.status(root.selftestId, Date.now())) : 0 }
      , configWrites: { saves: configStore.saves, errors: configStore.saveErrors }
      , engine: root.engineName
      , typeless: { hotkey: root.config ? root.config.voice.typeless.hotkey : null, hotkeyStored: root.hotkeyStored(),
                    pressWaitMs: root.config ? root.config.voice.typeless.pressWaitMs : null,
                    state: root.typeless ? root.typeless.snapshot() : null, switching: root.switching, view: root.typelessView }
      , doctorSummary: root.doctorSummary
      , unconfigured: root.unconfigured
    })
  }
  IpcHandler {
    target: root.ipcTarget
    function ping(): string { return "ok" }
    function key(name: string, edge: string): string { return root.onKeyEdge(name, edge, "ipc") ? "ok" : "unknown-key" }
    function reset(): string { root.doReset("ipc"); return "ok" }
    function status(): string { return root.statusJson() }
    function voice(verb: string, arg: string): string { return root.ipcVoice(verb, arg) }
    function mic(mode: string): string { return root.ipcMic(mode) }
    function micSystem(node: string): string { return root.ipcMic("system", node) }            // plan ruling 1
    function micSources(): string { root.refreshMicSources(); return JSON.stringify({ sources: root.micSourceList, refreshing: root.micSourcesRefreshing }) }
    function micStatus(id: string): string { return root.ipcMicStatus(id) }
    function selftestPing(): string { return "ok" }
    function selftestArm(): string { return JSON.stringify(root.selftestArm(undefined)) }
    function selftestArmFor(leaseMs: string): string { return JSON.stringify(root.selftestArm(leaseMs)) }
    function selftestStatus(id: string): string {
      var s = root.selftest ? root.selftest.status(id, Date.now()) : null
      return JSON.stringify(s ? { ok: true, id: id, active: s.active, remainingMs: s.remainingMs, failed: s.failed } : { ok: false, reason: "unknown" })
    }
    function selftestReport(id: string): string { return JSON.stringify(root.selftestReport(id)) }
    function selftestDisarm(id: string): string { return root.selftestDisarm(id) ? "ok" : "unknown" }
    function doctor(): string { root.refreshDoctor(); return JSON.stringify({ rows: root.doctorRows, summary: root.doctorSummary, facts: root.doctorFacts, at: root.doctorAt }) }
    function micToggle(): string { return root.micToggle() }
    function typelessHotkey(chord: string): string { return root.ipcTypelessHotkey(chord) }
    function engine(name: string): string { return root.setEngine(name) }
  }

  // Finding #5 (final-review.md): spec §5.2 "shell exit makes a best-effort `voxtype record cancel`, closes
  // only a plugin-opened remote mic" was a plan gap for the host process itself — `omarchy-restart-shell`
  // (what `make dev-restart` runs) during a recording otherwise leaves the daemon recording with no owner.
  // Startup reconciliation already covers the other half (the real `--follow` stream emits the current state
  // first). Best-effort only: must never throw during shell teardown.
  Component.onDestruction: {
    try {
      if (voice) {
        var snap = voice.snapshot()
        if (["starting", "recording", "transcribing", "arbitrating"].indexOf(snap.state) !== -1 || snap.pendingCmds > 0)
          Quickshell.execDetached(["voxtype", "record", "cancel"])
        if (snap.pluginMic) atv.micClose()
      }
      // Typeless §6.2: only a remote `on` session with nothing outstanding; a stop after an unconfirmed start could
      // itself start a recording.
      if (typeless) { var chord = typeless.exitStop(); if (chord) Quickshell.execDetached(root.keytapArgv(chord)) }
    } catch (e) { }
  }
}
