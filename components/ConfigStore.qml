// Spec §3 plugin-side files (config.json created with defaults on first run), §4.2 (unknown fields preserved),
// §6.2 (hot reload; the internal voice.mic commit reloads nothing), §8 (corrupt config → defaults, never overwritten).
import QtQuick
import Quickshell.Io
import "../lib/ConfigFile.mjs" as ConfigFile

Item {
  id: root
  required property string path
  property bool ready: false                   // parent directory exists (Service runs mkdir -p first)
  property var raw: null                       // file object as loaded, unknown fields intact
  property var config: null                    // normalized (lib/Config.mjs)
  property var problems: []
  property bool invalid: false
  property bool loaded: false
  signal changed(string kind)                  // load | external | keys | timing | voice | commit | reset-keys
  signal saveFailed(string reason)
  property string _lastWritten: ""

  FileView {
    id: file
    path: root.ready ? root.path : ""
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root._ingest(file.text(), false)
    onLoadFailed: function(error) { root._ingest("", error === FileViewError.FileNotFound) }
    onFileChanged: file.reload()
    onSaveFailed: function(error) { root.saveFailed(String(error)) }
  }

  function _ingest(text, createIfMissing) {
    if (root.loaded && text === root._lastWritten) return          // our own write echoed by the watcher
    var r = ConfigFile.load(text)
    root.raw = r.raw; root.config = r.config; root.problems = r.problems; root.invalid = r.invalid
    var first = !root.loaded
    root.loaded = true
    if (r.missing && createIfMissing) root._write(r.raw)
    root.changed(first ? "load" : "external")
  }

  function _write(raw) {
    if (root.invalid) { root.saveFailed("config.json is invalid; not overwriting it (§8)"); return false }
    var text = ConfigFile.serialize(raw)
    var r = ConfigFile.load(text)
    root._lastWritten = text
    root.raw = r.raw; root.config = r.config; root.problems = r.problems
    file.setText(text)
    return true
  }

  function setVoiceMic(mode) { if (root._write(ConfigFile.withPatch(root.raw, ["voice", "mic"], mode))) root.changed("commit") }
  function setKey(name, fields) { if (root._write(ConfigFile.withKey(root.raw, name, fields))) root.changed("keys") }
  function setTiming(timing) { if (root._write(ConfigFile.withPatch(root.raw, ["timing"], timing))) root.changed("timing") }
  function setVoiceField(field, value) { if (root._write(ConfigFile.withPatch(root.raw, ["voice", field], value))) root.changed("voice") }
  function resetKeys() { if (root._write(ConfigFile.withDefaultKeys(root.raw))) root.changed("reset-keys") }
}
