// Spec §6.2 tab 4 — Setup (Doctor): rows from lib/Doctor.mjs (same rules as host/omaremote-setup --doctor), Copy per fix,
// header "Copy full setup command" → `bash <plugin-dir>/host/omaremote-setup`. The panel never installs anything.
import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

Item {
  id: root
  property var service: null
  property QtObject bar: null
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int cursor: -1
  readonly property var rows: service ? service.doctorRows : []
  readonly property int rowCount: rows.length + 1                  // + header button
  property bool editing: false
  property string copied: ""
  function onShown() { cursor = -1; if (service) service.refreshDoctor() }
  function moveCursor(dy) { cursor = cursor < 0 ? 0 : Math.max(0, Math.min(rowCount - 1, cursor + dy)) }
  function activate() {
    if (cursor === 0) root.copy(root.setupCommand)
    else if (cursor > 0 && rows[cursor - 1] && rows[cursor - 1].fix) root.copy(rows[cursor - 1].fix)
  }
  readonly property string setupCommand: service ? "bash " + service.pluginDir + "/host/omaremote-setup" : ""
  function copy(text) {                                             // Quickshell.clipboardText: no wl-copy process — stays inside the allowed-commands list
    Quickshell.clipboardText = text
    root.copied = text
    copiedTimer.restart()
  }
  Timer { id: copiedTimer; interval: 1500; repeat: false; onTriggered: root.copied = "" }

  implicitHeight: column.implicitHeight
  Column {
    id: column
    width: parent.width
    spacing: Style.space(4)
    Row {
      spacing: Style.space(8)
      Button { text: "Copy full setup command"; hasCursor: root.cursor === 0; foreground: root.fg; onClicked: root.copy(root.setupCommand) }
      Text { textFormat: Text.PlainText; text: root.service ? root.service.doctorSummary + (root.service.doctorAt ? " · " + Qt.formatTime(new Date(root.service.doctorAt), "HH:mm:ss") : "") : ""; color: Qt.darker(root.fg, 1.3); font.family: root.fontFamily; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
      Text { visible: root.copied !== ""; textFormat: Text.PlainText; text: "copied"; color: Color.accent; font.family: root.fontFamily; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
    }
    Repeater {
      model: root.rows
      DoctorRow {
        required property int index
        required property var modelData
        width: column.width
        row: modelData
        fg: root.fg
        fontFamily: root.fontFamily
        hasCursor: root.cursor === index + 1
        onCopyRequested: function(text) { root.copy(text) }
      }
    }
  }
}
