// Spec §5.5: per-session stats appended to $XDG_DATA_HOME/omaremote/stats.json; no audio or transcribed text is stored.
import QtQuick
import Quickshell.Io

Item {
  id: root
  required property string path
  property bool ready: false
  property var entries: []
  property bool loaded: false
  signal statsLoaded()

  FileView {
    id: file
    path: root.ready ? root.path : ""
    printErrors: false
    atomicWrites: true
    onLoaded: {
      try { var v = JSON.parse(file.text()); root.entries = Array.isArray(v) ? v : [] } catch (e) { root.entries = [] }
      root.loaded = true; root.statsLoaded()
    }
    onLoadFailed: function(error) { root.entries = []; root.loaded = true; root.statsLoaded() }
  }
  function save(list) { root.entries = list; file.setText(JSON.stringify(list) + "\n") }
}
