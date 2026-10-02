// Spec §6.2 tab 4: one checklist row — status glyph, label (with the mode it applies to), detail, fix command + Copy.
import QtQuick
import qs.Commons
import qs.Ui

Item {
  id: root
  property var row: ({})
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property bool hasCursor: false
  signal copyRequested(string text)
  readonly property string glyph: ({ pass: "󰄬", warn: "󰀦", fail: "󰅖", unknown: "󰋗", info: "󰋽" })[row.status] || "󰋗"
  readonly property color glyphColor: row.status === "pass" ? root.fg : row.status === "fail" ? Color.urgent : row.status === "warn" ? "#e5c07b" : Qt.darker(root.fg, 1.5)

  implicitHeight: body.implicitHeight + Style.space(6)
  Rectangle { anchors.fill: parent; radius: Style.cornerRadius; color: root.hasCursor ? Style.selectedFillFor(root.fg, Color.accent) : "transparent" }
  Row {
    id: body
    anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.space(6)
    spacing: Style.space(8)
    Text { textFormat: Text.PlainText; text: root.glyph; color: root.glyphColor; font.family: root.fontFamily; font.pixelSize: Style.font.body; width: Style.space(18) }
    Column {
      width: parent.width - Style.space(26) - (copyBtn.visible ? copyBtn.width + Style.space(8) : 0)
      spacing: Style.space(1)
      Text { textFormat: Text.PlainText; width: parent.width; elide: Text.ElideRight; text: root.row.label + " [" + (root.row.modes || []).join("/") + "]"; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall }
      Text { visible: text !== ""; textFormat: Text.PlainText; width: parent.width; wrapMode: Text.WordWrap; text: root.row.detail || ""; color: Qt.darker(root.fg, 1.3); font.family: root.fontFamily; font.pixelSize: Style.font.caption }
      Text { visible: text !== "" && root.row.status !== "pass"; textFormat: Text.PlainText; width: parent.width; elide: Text.ElideMiddle; text: root.row.fix || ""; color: Qt.darker(root.fg, 1.2); font.family: "monospace"; font.pixelSize: Style.font.caption }
    }
    Button { id: copyBtn; visible: !!root.row.fix && root.row.status !== "pass"; text: "Copy"; foreground: root.fg; onClicked: root.copyRequested(root.row.fix) }
  }
}
