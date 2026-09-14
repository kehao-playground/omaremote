// Spec §6.2 tab 4 — Setup (implemented in Task 11).
import QtQuick
import qs.Commons

Item {
  id: root
  property var service: null
  property QtObject bar: null
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int cursor: -1
  readonly property int rowCount: 0
  property bool editing: false
  function moveCursor(dy) {}
  function activate() {}
  function onShown() {}
  implicitHeight: placeholder.implicitHeight
  Text { id: placeholder; textFormat: Text.PlainText; text: "Setup — coming in Task 11"; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body }
}
