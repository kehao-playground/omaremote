// Spec §6.2 tab 1 — Status: remote / ATVVoice state and node, Voxtype status, today's stats, "Test mic (3 s)" button.
import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Presentation.mjs" as Presentation

Item {
  id: root
  property var service: null
  property QtObject bar: null
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int cursor: -1
  readonly property int rowCount: 1                   // the mic-test button is the only activatable row
  property bool editing: false
  property int micTestLeft: 0
  function moveCursor(dy) { cursor = cursor < 0 ? 0 : Math.max(0, Math.min(rowCount - 1, cursor + dy)) }
  function activate() { if (cursor === 0) root.micTest() }
  function onShown() { cursor = -1 }
  // finding #4 (final-review.md): the 3 s mic-test Timer must not survive a reset (which already closed the
  // plugin-owned mic) or the panel closing — either would let this Timer's trailing micToggle() fire later,
  // during/after recovery, and re-open a mic that was just deliberately closed.
  function onHidden() { micTimer.stop(); root.micTestLeft = 0 }
  Connections { target: root.service; function onResetHappened() { root.onHidden() } }
  function micTest() {                                  // §6.2: 3 s MicToggle round trip through the same voice rules
    if (!service || micTestLeft > 0) return
    if (service.micToggle() !== "ok") return
    micTestLeft = 3
    micTimer.restart()
  }
  Timer { id: micTimer; interval: 1000; repeat: true; onTriggered: { root.micTestLeft--; if (root.micTestLeft <= 0) { micTimer.stop(); if (root.service) root.service.micToggle() } } }

  readonly property var s: service
  readonly property var rows: !s ? [] : [
    ["Voice", s.voiceState + (s.voiceOwner ? " · " + s.voiceOwner + (s.voiceInferred ? " (inferred)" : "") : "") + (s.voiceState === "recording" ? " · " + Presentation.elapsedText(s.elapsedMs) : "")],
    ["Voxtype", s.backendClass + (s.unconfiguredReason ? " · " + s.unconfiguredReason : "")],
    ["Remote", s.remoteState + (s.atvBusName ? " · " + s.atvBusName : "") + (s.remoteNode ? " · " + s.remoteNode : "")],
    ["Mic mode", s.config ? s.config.voice.mic + (s.remoteWarning ? " · remote mic: " + (s.remoteState === "absent" ? "ATVVoice missing" : s.remoteState === "disconnected" ? "disconnected" : "device mismatch") : "") : ""],
    ["Last capture", s.lastCapture ? s.lastCapture.node + " · " + s.lastCapture.mode + " · " + Qt.formatTime(new Date(s.lastCapture.at), "HH:mm") : "not yet verified"],
    ["Today", s.statsSummary.today.count + " sessions · " + Math.round(s.statsSummary.today.seconds) + " s"],
    ["Errors", String(s.errorCount) + (s.lastError ? " · " + s.lastError : "")]
  ]

  implicitHeight: column.implicitHeight
  Column {
    id: column
    width: parent.width
    spacing: Style.space(6)
    Repeater {
      model: root.rows
      Row {
        required property var modelData
        width: column.width
        spacing: Style.space(8)
        Text { textFormat: Text.PlainText; text: parent.modelData[0]; width: Style.space(96); color: Qt.darker(root.fg, 1.3); font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall }
        Text { textFormat: Text.PlainText; text: parent.modelData[1]; width: parent.width - Style.space(104); wrapMode: Text.WordWrap; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall }
      }
    }
    Button {
      text: root.micTestLeft > 0 ? "Testing mic… " + root.micTestLeft : "Test mic (3 s)"
      foreground: root.fg
      hasCursor: root.cursor === 0
      enabled: root.service && !root.service.micPending && !root.service.selftestActive && root.service.voiceState !== "recovering"
      onClicked: root.micTest()
    }
  }
}
