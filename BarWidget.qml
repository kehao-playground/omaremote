// Spec §2 verification-first item 1 — spike widget (replaced in Task 9).
import QtQuick
import qs.Ui

BarWidget {
  id: root
  moduleName: "io.github.kehao-chen.omaremote"
  readonly property string pluginId: "io.github.kehao-chen.omaremote"
  property var service: null

  // Bar contract (Bar.findPanelWidget needs these on the widget root).
  readonly property bool opened: false
  readonly property bool popoutSwitchClosing: false
  function open() {}
  function close() {}
  function toggle() {}
  function closeForPopoutSwitch() {}

  function findService() {
    var s = bar && bar.shell && typeof bar.shell.serviceFor === "function" ? bar.shell.serviceFor(pluginId) : null
    if (!s) return
    service = s
    s.widgetAttached = true
    retry.stop()
  }
  Timer { id: retry; interval: 500; repeat: true; running: true; onTriggered: root.findService() }
  onBarChanged: findService()

  implicitWidth: label.implicitWidth + 16
  implicitHeight: barSize
  Text {
    id: label
    anchors.centerIn: parent
    text: root.service ? "󰍬 " + root.service.pressCount : "󰍬 ?"
    color: root.bar ? root.bar.barForeground : "white"
    font.family: root.bar ? root.bar.fontFamily : ""
    font.pixelSize: 14
  }
}
