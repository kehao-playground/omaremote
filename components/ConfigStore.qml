// Spec §3 plugin-side files (config.json created with defaults on first run), §4.2 (unknown fields preserved),
// §6.2 (hot reload; the internal voice.mic commit reloads nothing), §8 (corrupt config → defaults, never overwritten).
// Typeless spec §4.3: writes are a serialized, never-merged FIFO (lib/ConfigWrites.mjs). Each write gets its own
// FileView object, so its saved/saveFailed names its seq and can never be credited to another write. The reading
// FileView only watches; a change notification only triggers a re-read of the current disk text once the queue is idle.
import QtQuick
import Quickshell.Io
import "../lib/ConfigFile.mjs" as ConfigFile
import "../lib/ConfigWrites.mjs" as ConfigWrites

Item {
  id: root
  required property string path
  property bool ready: false                   // parent directory exists (Service runs mkdir -p first)
  property var raw: null                       // file object as loaded, unknown fields intact
  property var config: null                    // normalized (lib/Config.mjs)
  property var problems: []
  property bool invalid: false
  property bool loaded: false
  signal changed(string kind)                  // load | external | keys | timing | voice | commit | reset-keys | engine | hotkey
  signal saveFailed(string reason)
  readonly property var writes: ConfigWrites.createConfigWrites()
  property var saves: ({})                     // seq → pending|saved|failed (last 16), published by status
  property var saveErrors: ({})                // seq → reason for failed writes
  property string _memText: ""                 // the text memory reflects: our newest requested write, or the disk text we adopted

  FileView {
    id: file
    path: root.ready ? root.path : ""
    watchChanges: true
    printErrors: false
    onLoaded: root._ingest(file.text(), false)
    onLoadFailed: function(error) { root._ingest("", error === FileViewError.FileNotFound) }
    onFileChanged: root._run(root.writes.notify())
  }
  // One FileView per write (measured with Quickshell 0.3.1, 2026-10-13: each instance answers its own setText with
  // saved, a file that does not exist yet included). blockAllReads: a writer never loads the file.
  Component {
    id: writerComponent
    FileView {
      property int seq: 0
      atomicWrites: true
      printErrors: false
      blockAllReads: true
      onSaved: { root._answer(seq, true, ""); destroy() }
      onSaveFailed: function(error) { root._answer(seq, false, String(error)); destroy() }
    }
  }
  // Every write must resolve, or the FIFO stalls and external edits are never adopted again. A write unanswered for
  // 3 s is counted as failed; if its writer answers later, that answer names a seq no longer in flight and is ignored.
  Timer {
    id: saveWatchdog; interval: 3000; repeat: false
    onTriggered: {
      var s = root.writes.inFlightSeq()
      if (s) { root.saveFailed("no save confirmation from FileView"); root._settle(root.writes.failed(s, "no save confirmation")) }
    }
  }
  // §3/§8: an in-place external edit (`cat new > config.json`) truncates then writes; the watcher can fire and be read
  // in that gap, landing an empty read that is NOT a real "file missing". Only the very first load, or a genuine
  // FileNotFound, may treat empty as "apply defaults" — any later empty read is transient: ignore it and retry once.
  property int _emptyRetries: 0
  Timer { id: reloadRetry; interval: 100; repeat: false; onTriggered: file.reload() }

  function _run(effects) {
    for (var i = 0; i < effects.length; i++) {
      var e = effects[i]
      if (e.type === "setText") {
        var w = writerComponent.createObject(root, { seq: e.seq, path: root.path })
        if (!w) { root._answer(e.seq, false, "could not create a writer"); continue }
        saveWatchdog.restart()
        w.setText(e.text)
      } else if (e.type === "reload") file.reload()
    }
  }
  function _answer(seq, ok, reason) {
    if (seq === root.writes.inFlightSeq()) saveWatchdog.stop()
    if (!ok) root.saveFailed(reason)
    root._settle(ok ? root.writes.saved(seq) : root.writes.failed(seq, reason))
  }
  function _settle(effects) {
    root.saves = root.writes.saves()
    root.saveErrors = root.writes.errors()
    root._run(effects)
  }

  function _ingest(text, createIfMissing) {
    if (root.loaded && !createIfMissing && text.trim() === "") {
      if (root._emptyRetries < 20) { root._emptyRetries++; reloadRetry.restart() }
      return
    }
    // Typeless §4.3: no echo bookkeeping. While our writes are pending this only marks the store dirty; once idle
    // the current disk text is adopted only when it differs from memory.
    if (root.loaded && !root.writes.diskRead(text, root._memText)) return
    root._emptyRetries = 0
    var r = ConfigFile.load(text)
    root.raw = r.raw; root.config = r.config; root.problems = r.problems; root.invalid = r.invalid
    var first = !root.loaded
    root.loaded = true
    root._memText = text
    // Deferred so the first write is not issued from inside the reading FileView's own loadFailed handler.
    if (r.missing && createIfMissing) Qt.callLater(function() { root._write(r.raw) })
    root.changed(first ? "load" : "external")
  }

  // Returns the write's seq, or 0 when nothing was written.
  function _write(raw) {
    if (root.invalid) { root.saveFailed("config.json is invalid; not overwriting it (§8)"); return 0 }
    var text = ConfigFile.serialize(raw)
    var w = root.writes.request(text)
    if (!w.ok) { root.saveFailed(w.reason); return 0 }
    var r = ConfigFile.load(text)
    root._memText = text
    root.raw = r.raw; root.config = r.config; root.problems = r.problems
    root._settle(w.effects)
    return w.seq
  }

  function hotkeyOfText(text) {
    try { var j = JSON.parse(text); return j && j.voice && j.voice.typeless ? j.voice.typeless.hotkey : undefined }
    catch (e) { return undefined }
  }

  // Mic source picker spec §3: voice.mic and voice.systemDevice land in one write; remote passes no device.
  function setVoiceMic(mode, device) {
    var next = ConfigFile.withPatch(root.raw, ["voice", "mic"], mode)
    if (device !== undefined) next = ConfigFile.withPatch(next, ["voice", "systemDevice"], device)
    if (root._write(next)) root.changed("commit")
  }
  function setKey(name, fields) { if (root._write(ConfigFile.withKey(root.raw, name, fields))) root.changed("keys") }
  function setTiming(timing) { if (root._write(ConfigFile.withMerged(root.raw, ["timing"], timing))) root.changed("timing") }
  function setVoiceField(field, value) { if (root._write(ConfigFile.withPatch(root.raw, ["voice", field], value))) root.changed("voice") }
  function resetKeys() { if (root._write(ConfigFile.withDefaultKeys(root.raw))) root.changed("reset-keys") }
  function setVoiceEngine(name) { if (root._write(ConfigFile.withPatch(root.raw, ["voice", "engine"], name))) root.changed("engine") }
  function setTypelessHotkey(chord) {
    var s = root._write(ConfigFile.withPatch(root.raw, ["voice", "typeless", "hotkey"], chord))
    if (s) root.changed("hotkey")
    return s
  }
}
