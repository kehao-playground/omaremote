// Spec §6.2 tab 2: popover editing one action — type combo + type-specific fields; `key` has a "press a key to capture" mode.
// Lives inside the KeyboardPanel content so it keeps the panel's keyboard focus (the PanelKeyCatcher is blocked while open).
import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Actions.mjs" as Actions
import "../lib/Presentation.mjs" as Presentation

Rectangle {
  id: root
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property string keyName: ""
  property string trigger: ""
  property string type: "none"
  property string keys: ""
  property string dispatcher: ""
  property string arg: ""
  property string delta: "+5"
  property string media: "play-pause"
  property string screen: "off"
  property bool capturing: false
  property string error: ""
  signal saved(string keyName, string trigger, var action)     // action null = unbind
  signal cancelled()

  function open(keyName, trigger, action) {
    root.keyName = keyName; root.trigger = trigger; root.error = ""; root.capturing = false
    var a = action || { type: "none" }
    root.type = a.type; root.keys = a.keys || ""; root.dispatcher = a.dispatcher || ""; root.arg = a.arg || ""
    root.delta = a.delta || "+5"; root.media = a.cmd && a.type === "media" ? a.cmd : "play-pause"; root.screen = a.cmd && a.type === "screen" ? a.cmd : "off"
    root.visible = true
    captureArea.forceActiveFocus()
  }
  function build() {
    switch (root.type) {
      case "key": return { type: "key", keys: root.keys.trim() }
      case "dispatch": return { type: "dispatch", dispatcher: root.dispatcher.trim(), arg: root.arg.trim() }
      case "volume": return { type: "volume", delta: root.delta }
      case "media": return { type: "media", cmd: root.media }
      case "screen": return { type: "screen", cmd: root.screen }
      default: return null
    }
  }
  function save() {
    var a = root.build()
    if (a) { var errs = Actions.validateAction(a); if (errs.length) { root.error = errs.join("; "); return } }
    root.visible = false
    root.saved(root.keyName, root.trigger, a)
  }
  function cancel() { root.visible = false; root.cancelled() }

  visible: false
  radius: Style.cornerRadius
  color: Color.popups.background
  border.color: Color.popups.border
  border.width: 1
  implicitHeight: body.implicitHeight + Style.space(24)

  Item {                                                       // key capture target (§6.2 "press a key to capture")
    id: captureArea
    anchors.fill: parent
    focus: true
    Keys.onPressed: function(event) {
      if (event.key === Qt.Key_Escape) { if (root.capturing) root.capturing = false; else root.cancel(); event.accepted = true; return }
      if (root.capturing) {
        var k = Presentation.keysFromQtEvent(event.key, event.modifiers, event.text)
        if (k) { root.keys = k; root.capturing = false }
        event.accepted = true; return
      }
      if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !keysField.activeFocus && !dispField.activeFocus && !argField.activeFocus) { root.save(); event.accepted = true }
    }
  }

  Column {
    id: body
    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
    anchors.margins: Style.space(12)
    spacing: Style.space(8)
    Text { textFormat: Text.PlainText; text: Presentation.keyLabel(root.keyName) + " · " + root.trigger; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle; font.bold: true }
    Dropdown {
      label: "Type"
      value: root.type
      options: Actions.ACTION_TYPES
      foreground: root.fg
      fontFamily: root.fontFamily
      onChanged: function(v) { root.type = v; root.error = "" }
    }
    Row {
      visible: root.type === "key"
      spacing: Style.space(6)
      TextField { id: keysField; width: Style.space(200); text: root.keys; placeholderText: "ctrl+shift+Return"; foreground: root.fg; onTextEdited: root.keys = text }
      Button { text: root.capturing ? "press a key…" : "Capture"; foreground: root.fg; selected: root.capturing; onClicked: { root.capturing = !root.capturing; captureArea.forceActiveFocus() } }
    }
    Row {
      visible: root.type === "dispatch"
      spacing: Style.space(6)
      TextField { id: dispField; width: Style.space(120); text: root.dispatcher; placeholderText: "dispatcher"; foreground: root.fg; onTextEdited: root.dispatcher = text }
      TextField { id: argField; width: Style.space(160); text: root.arg; placeholderText: "arg"; foreground: root.fg; onTextEdited: root.arg = text }
    }
    Dropdown { visible: root.type === "volume"; label: "Delta"; value: root.delta; options: ["+5", "-5", "mute"]; foreground: root.fg; fontFamily: root.fontFamily; onChanged: function(v) { root.delta = v } }
    Dropdown { visible: root.type === "media"; label: "Command"; value: root.media; options: ["play-pause", "next", "previous"]; foreground: root.fg; fontFamily: root.fontFamily; onChanged: function(v) { root.media = v } }
    Dropdown { visible: root.type === "screen"; label: "Command"; value: root.screen; options: ["off", "lock"]; foreground: root.fg; fontFamily: root.fontFamily; onChanged: function(v) { root.screen = v } }
    Text { visible: root.error !== ""; textFormat: Text.PlainText; text: root.error; color: Color.urgent; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
    Row {
      spacing: Style.space(6)
      Button { text: "Save"; foreground: root.fg; onClicked: root.save() }
      Button { text: "Unbind"; foreground: root.fg; onClicked: { root.type = "none"; root.save() } }
      Button { text: "Cancel"; foreground: root.fg; onClicked: root.cancel() }
    }
  }
}
