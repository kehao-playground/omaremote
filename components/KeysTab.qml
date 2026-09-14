// Spec §6.2 tab 2 — Keys: 13 rows (key · tap · hold · double · repeat☐), editor popover, footer "Reset to defaults" and "Timing…".
// Writes go through the Service (§2); the engine hot-reloads on the ConfigStore change signal (§6.2).
import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Defaults.mjs" as Defaults

Item {
  id: root
  property var service: null
  property QtObject bar: null
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int cursor: -1
  property int column: 0
  readonly property int rowCount: Defaults.KEY_NAMES.length + 2       // rows + "Reset to defaults" + "Timing…"
  readonly property bool editing: editor.visible || timing.visible
  readonly property var keys: service && service.config ? service.config.keys : ({})
  readonly property var problems: service ? service.configProblems : []

  function onShown() { cursor = -1; column = 0 }
  function moveCursor(dy) { cursor = cursor < 0 ? 0 : Math.max(0, Math.min(rowCount - 1, cursor + dy)) }
  function moveColumn(dx) { column = Math.max(0, Math.min(3, column + dx)) }
  function activate() {
    if (cursor < 0) return
    if (cursor === Defaults.KEY_NAMES.length) { if (service) service.resetKeys(); return }
    if (cursor === Defaults.KEY_NAMES.length + 1) { timing.open(service.config.timing); return }
    var name = Defaults.KEY_NAMES[cursor]
    if (name === "mic") return
    if (column === 3) root.toggleRepeat(name)
    else root.edit(name, ["tap", "hold", "double"][column])
  }
  function edit(name, trigger) { if (!service || keys[name].supported === false) return; editor.open(name, trigger, keys[name][trigger] || null) }
  function toggleRepeat(name) {
    if (!service || keys[name].panic) return
    service.setKeyField(name, { repeat: !keys[name].repeat })
  }

  implicitHeight: column_.implicitHeight
  Column {
    id: column_
    width: parent.width
    spacing: Style.space(2)
    Repeater {
      model: Defaults.KEY_NAMES
      KeyRow {
        required property int index
        required property string modelData
        width: column_.width
        keyName: modelData
        keyConfig: root.keys[modelData] || ({})
        fg: root.fg
        fontFamily: root.fontFamily
        hasCursor: root.cursor === index
        column: root.column
        onEditRequested: function(trigger) { root.edit(modelData, trigger) }
        onRepeatToggled: root.toggleRepeat(modelData)
      }
    }
    Text {
      visible: root.problems.length > 0
      textFormat: Text.PlainText
      width: parent.width
      wrapMode: Text.WordWrap
      text: root.problems.map(function(p) { return p.message }).join("\n")
      color: Color.urgent
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
    Row {
      spacing: Style.space(6)
      Button { text: "Reset to defaults"; foreground: root.fg; hasCursor: root.cursor === Defaults.KEY_NAMES.length; onClicked: if (root.service) root.service.resetKeys() }
      Button { text: "Timing…"; foreground: root.fg; hasCursor: root.cursor === Defaults.KEY_NAMES.length + 1; onClicked: timing.open(root.service.config.timing) }
    }
    ActionEditor {
      id: editor
      width: parent.width
      fg: root.fg
      fontFamily: root.fontFamily
      onSaved: function(keyName, trigger, action) { var f = ({}); f[trigger] = action === null ? undefined : action; root.service.setKeyField(keyName, f) }
    }
    TimingEditor {
      id: timing
      width: parent.width
      fg: root.fg
      fontFamily: root.fontFamily
      onSaved: function(t) { root.service.setTiming(t) }
    }
  }
}
