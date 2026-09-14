// Spec §6.3: PanelWindow owned by the Service — layer overlay, top-centre, no exclusive zone, no keyboard focus, click-through.
import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons

PanelWindow {
  id: root
  property string line: ""
  property bool recording: false
  property bool enabled: true

  anchors.top: true
  margins.top: Style.gapsOut
  exclusiveZone: 0
  color: "transparent"
  visible: root.enabled && root.line !== ""
  implicitWidth: card.implicitWidth
  implicitHeight: card.implicitHeight
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
  WlrLayershell.namespace: "omaremote-hud"
  mask: Region {}

  Rectangle {
    id: card
    implicitWidth: label.implicitWidth + Style.space(28)
    implicitHeight: label.implicitHeight + Style.space(14)
    radius: Style.cornerRadius
    color: Color.popups.background
    border.color: Color.popups.border
    border.width: 1
    Text {
      id: label
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: root.line
      color: root.recording ? Color.urgent : Color.popups.text
      font.family: Style.font.family
      font.pixelSize: Style.font.body
    }
    SequentialAnimation on opacity {          // slow pulse while recording (§6.1)
      running: root.recording
      loops: Animation.Infinite
      NumberAnimation { to: 0.55; duration: 900 }
      NumberAnimation { to: 1.0; duration: 900 }
    }
  }
}
