// Spec §6.2 tab 2: one row — key · tap · hold · double · repeat☐ (greyed when supported: false; panic keys show "panic" instead of hold).
import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Presentation.mjs" as Presentation
import "../lib/Actions.mjs" as Actions

Item {
  id: root
  property string keyName: ""
  property var keyConfig: ({})
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property bool hasCursor: false
  property int column: 0                       // 0 tap, 1 hold, 2 double, 3 repeat (cursor column)
  signal editRequested(string trigger)
  signal repeatToggled()
  readonly property bool supported: keyConfig.supported !== false
  readonly property bool panic: keyConfig.panic === true
  readonly property bool isMic: keyName === "mic"
  function cell(trigger) { var a = keyConfig[trigger]; return a ? Actions.describe(a) : "—" }

  implicitHeight: Style.space(26)
  Rectangle { anchors.fill: parent; radius: Style.cornerRadius; color: root.hasCursor ? Style.selectedFillFor(root.fg, Color.accent) : "transparent" }
  Row {
    anchors.fill: parent
    anchors.leftMargin: Style.space(6)
    spacing: Style.space(6)
    opacity: root.supported ? 1.0 : 0.4
    Text { width: Style.space(58); textFormat: Text.PlainText; text: Presentation.keyLabel(root.keyName); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall; font.bold: true; anchors.verticalCenter: parent.verticalCenter }
    Repeater {
      model: root.isMic ? [] : ["tap", "hold", "double"]
      Rectangle {
        required property int index
        required property string modelData
        width: Style.space(96); height: Style.space(22)
        radius: Style.cornerRadius
        color: root.hasCursor && root.column === index ? Style.selectedFillFor(root.fg, Color.accent) : "transparent"
        border.width: root.hasCursor && root.column === index ? 1 : 0
        border.color: Color.accent
        anchors.verticalCenter: parent.verticalCenter
        Text {
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: parent.modelData === "hold" && root.panic ? "panic (" + root.cell("tap") + " <1.5 s)" : root.cell(parent.modelData)
          elide: Text.ElideRight
          width: parent.width - Style.space(8)
          horizontalAlignment: Text.AlignHCenter
          color: root.fg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
        MouseArea { anchors.fill: parent; enabled: root.supported && !(parent.modelData === "hold" && root.panic); cursorShape: Qt.PointingHandCursor; onClicked: root.editRequested(parent.modelData) }
      }
    }
    Text { visible: root.isMic; textFormat: Text.PlainText; text: root.keyConfig.trigger === "toggle" ? "toggle" : root.keyConfig.trigger === "key" ? "plain key" : "push-to-talk"; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
    ToggleSwitch {
      visible: !root.isMic
      checked: root.keyConfig.repeat === true
      interactive: root.supported && !root.panic          // §4.2: panic excludes hold/repeat
      hasCursor: root.hasCursor && root.column === 3
      foreground: root.fg
      anchors.verticalCenter: parent.verticalCenter
      onToggled: root.repeatToggled()
    }
  }
}
