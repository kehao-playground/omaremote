// Spec §6.2 tab 2 footer "Timing…": holdMs / doubleMs / repeatMs (panicMs stays at its §4.2 default; the escape hatch is not tunable here).
import QtQuick
import qs.Commons
import qs.Ui

Rectangle {
  id: root
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int holdMs: 350
  property int doubleMs: 250
  property int repeatMs: 80
  property int panicMs: 1500
  signal saved(var timing)
  signal cancelled()
  function open(t) { holdMs = t.holdMs; doubleMs = t.doubleMs; repeatMs = t.repeatMs; panicMs = t.panicMs; visible = true; focusItem.forceActiveFocus() }

  visible: false
  radius: Style.cornerRadius
  color: Color.popups.background
  border.color: Color.popups.border
  border.width: 1
  implicitHeight: body.implicitHeight + Style.space(24)
  Item { id: focusItem; anchors.fill: parent; focus: true; Keys.onEscapePressed: { root.visible = false; root.cancelled() } }
  Column {
    id: body
    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
    anchors.margins: Style.space(12)
    spacing: Style.space(8)
    Text { textFormat: Text.PlainText; text: "Timing (ms)"; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle; font.bold: true }
    NumberField { label: "holdMs"; value: root.holdMs; from: 100; to: 2000; stepSize: 10; foreground: root.fg; fontFamily: root.fontFamily; onModified: function(v) { root.holdMs = v } }
    NumberField { label: "doubleMs"; value: root.doubleMs; from: 100; to: 1000; stepSize: 10; foreground: root.fg; fontFamily: root.fontFamily; onModified: function(v) { root.doubleMs = v } }
    NumberField { label: "repeatMs"; value: root.repeatMs; from: 20; to: 500; stepSize: 5; foreground: root.fg; fontFamily: root.fontFamily; onModified: function(v) { root.repeatMs = v } }
    Row {
      spacing: Style.space(6)
      Button { text: "Save"; foreground: root.fg; onClicked: { root.visible = false; root.saved({ holdMs: root.holdMs, doubleMs: root.doubleMs, repeatMs: root.repeatMs, panicMs: root.panicMs }) } }
      Button { text: "Cancel"; foreground: root.fg; onClicked: { root.visible = false; root.cancelled() } }
    }
  }
}
