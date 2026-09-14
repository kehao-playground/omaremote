// Spec §2 verification-first items — spike host (replaced by the real Service in Task 5).
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Hyprland
import "lib/Defaults.mjs" as Defaults
import "lib/Config.mjs" as Config
import "lib/KeyEngine.mjs" as KeyEngine

Item {
  id: root
  property var shell: null
  property int pressCount: 0
  property int releaseCount: 0
  property bool widgetAttached: false
  readonly property string state: "spike"

  function esCheck() {
    var m = new Map([["a", 1]])
    var s = new Set([1, 2])
    var o = Object.assign({}, { x: 1 }, { y: 2 }) // object-spread `{...x}` fails to parse in QML inline JS (qmllint + runtime both reject it; see findings)
    var eng = KeyEngine.createKeyEngine(Config.normalizeConfig(Defaults.DEFAULT_CONFIG).config)
    var fx = eng.press("home", 0)
    var cls = (function(a = 5) { return a })()
    return JSON.stringify({ keys: Defaults.KEY_NAMES.length, map: m.get("a"), set: s.size, spread: o.x + o.y,
      tpl: `t${o.y}`, includes: [1].includes(1), defaults: cls, engineAction: fx.length ? fx[0].type : null })
  }

  GlobalShortcut {
    appid: "omaremote"
    name: "up"
    onPressed: root.pressCount++
    onReleased: root.releaseCount++
  }

  PanelWindow {
    id: hud
    anchors.top: true
    exclusiveZone: 0
    implicitWidth: 260
    implicitHeight: 40
    color: "transparent"
    visible: root.pressCount > 0
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    WlrLayershell.namespace: "omaremote-hud"
    Rectangle {
      anchors.fill: parent
      radius: 8
      color: "#cc101315"
      Text { anchors.centerIn: parent; color: "#cacccc"; text: "omaremote spike " + root.pressCount + "/" + root.releaseCount }
    }
  }

  IpcHandler {
    target: "omaremote"
    function ping(): string { return "ok" }
    function es(): string { return root.esCheck() }
    function counts(): string {
      return JSON.stringify({ press: root.pressCount, release: root.releaseCount, widget: root.widgetAttached, hudVisible: hud.visible })
    }
  }
}
