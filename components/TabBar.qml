// Spec §6.2: four-tab header; the Panel drives `current` from keys (←/→, 1–4) and clicks.
import QtQuick
import qs.Commons

Row {
  id: root
  property var tabs: ["Status", "Keys", "Voice", "Setup"]
  property int current: 0
  property color fg: Color.foreground
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  signal selected(int index)
  spacing: Style.space(6)
  Repeater {
    model: root.tabs
    Rectangle {
      required property int index
      required property string modelData
      readonly property bool active: index === root.current
      width: label.implicitWidth + Style.space(16)
      height: label.implicitHeight + Style.space(8)
      radius: Style.cornerRadius
      color: active ? Style.selectedFillFor(root.fg, root.accent) : "transparent"
      Text {
        id: label
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: (parent.index + 1) + " " + parent.modelData
        color: parent.active ? root.accent : Qt.darker(root.fg, 1.3)
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: parent.active
      }
      MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.selected(parent.index) }
    }
  }
}
