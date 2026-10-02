// Spec §6.1: one remote glyph coloured by Service state with Omarchy theme tokens; active voice/operation states take precedence;
// left click toggles the Panel, middle click is the quick mic test; bar-widget contract for Bar.findPanelWidget.
import QtQuick
import qs.Commons
import qs.Ui
import "lib/Presentation.mjs" as Presentation

BarWidget {
  id: root
  moduleName: "io.github.kehao-chen.omaremote"
  readonly property string pluginId: "io.github.kehao-chen.omaremote"
  property var service: null
  readonly property color warningColor: "#e5c07b"      // no Omarchy token for "warning"; §6.1 asks for yellow

  function findService() {
    var s = bar && bar.shell && typeof bar.shell.serviceFor === "function" ? bar.shell.serviceFor(pluginId) : null
    if (s) service = s
  }
  Timer { id: retry; interval: 500; repeat: true; running: !root.service; onTriggered: root.findService() }
  onBarChanged: findService()
  Connections { target: root.service; function onResetHappened() { root.close() } }   // §4.3: reset closes HUD and Panel

  readonly property string look: service ? Presentation.glyphLook({
      voiceState: service.voiceState, unconfigured: service.unconfigured, remoteState: service.remoteState,
      micPending: service.micPending, selftest: service.selftestActive }) : "disconnected"
  readonly property string glyph: look === "selftest" ? "󰙨" : (look === "unconfigured" || look === "disconnected" ? "󰍭" : "󰍬")
  readonly property color fg: bar ? bar.barForeground : Color.foreground
  readonly property color glyphColor: look === "recording" ? (bar ? bar.urgent : Color.urgent)
                                    : look === "unconfigured" ? root.warningColor
                                    : look === "disconnected" ? Qt.darker(fg, 1.6) : fg
  readonly property string elapsed: service && look === "recording" ? Presentation.elapsedText(service.elapsedMs) : ""
  readonly property string tooltipText: {
    if (!service) return "OmaRemote: service not loaded"
    if (look === "unconfigured") {
      var missing = []
      for (var i = 0; i < service.doctorRows.length; i++) if (service.doctorRows[i].status === "fail") missing.push(service.doctorRows[i].label)
      return "OmaRemote unconfigured: " + (missing.length ? missing.join(", ") : service.unconfiguredReason || "see Setup tab")
    }
    if (look === "busy") return service.micPending ? "OmaRemote: changing microphone…" : "OmaRemote: recovering…"
    if (look === "recording") return "Recording (" + service.voiceOwner + (service.voiceInferred ? ", inferred" : "") + ")"
    if (service.remoteWarning) return "OmaRemote: remote mic not ready (" + (service.remoteState === "absent" ? "ATVVoice not running" : "audio.device ≠ " + service.remoteNode) + ")"
    return "OmaRemote: " + look + (service.remoteState !== "unknown" ? " · remote " + service.remoteState : "")
  }

  implicitWidth: row.implicitWidth + Style.space(12)
  implicitHeight: barSize

  Row {
    id: row
    anchors.centerIn: parent
    spacing: Style.space(4)
    Text {
      id: glyphText
      textFormat: Text.PlainText
      text: root.glyph
      color: root.glyphColor
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.icon
      anchors.verticalCenter: parent.verticalCenter
      SequentialAnimation on opacity {                    // slow pulse while recording
        running: root.look === "recording"; loops: Animation.Infinite
        NumberAnimation { to: 0.4; duration: 900 } NumberAnimation { to: 1.0; duration: 900 }
      }
      onTextChanged: opacity = 1
    }
    Text {                                                // spinner for transcribing / recovering / mic apply, pending dot for arbitrating/starting
      textFormat: Text.PlainText
      visible: root.look === "transcribing" || root.look === "busy" || root.look === "pending"
      text: root.look === "pending" ? "…" : ""
      color: root.fg
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.bodySmall
      anchors.verticalCenter: parent.verticalCenter
      RotationAnimation on rotation { running: root.look !== "pending" && parent.visible; loops: Animation.Infinite; from: 0; to: 360; duration: 1400 }
    }
    Text {
      textFormat: Text.PlainText
      visible: root.elapsed !== "" && !root.vertical
      text: root.elapsed
      color: root.bar ? root.bar.urgent : Color.urgent
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.bodySmall
      anchors.verticalCenter: parent.verticalCenter
    }
    Rectangle {                                           // §5.4 remoteWarning dot
      visible: root.service && root.service.remoteWarning && root.look === "ready"
      width: Style.space(6); height: width; radius: width / 2
      color: root.warningColor
      anchors.verticalCenter: parent.verticalCenter
    }
  }

  // Bar.targetTooltipHovered() drops any showTooltip() whose target does not expose `tooltipHovered === true`
  // (shell/plugins/bar/Bar.qml:400; the first-party widgets provide it via Ui/WidgetButton.qml). Without it the
  // hover tooltip never appears.
  readonly property bool tooltipHovered: visible && hoverArea.containsMouse

  MouseArea {
    id: hoverArea
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton | Qt.MiddleButton
    cursorShape: Qt.PointingHandCursor
    onClicked: function(mouse) {
      if (mouse.button === Qt.MiddleButton) { if (root.service) root.service.micToggle() }   // §6.1 quick mic test (busy-guarded by the Service)
      else root.toggle()
    }
    onEntered: if (root.bar) root.bar.showTooltip(root, root.tooltipText)
    onExited: if (root.bar) root.bar.hideTooltip(root)
  }

  // ---- Panel popup (Bar.findPanelWidget requires open/close/opened on the widget root) ----
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  function open() { if (panelLoader.item) panelLoader.item.openFromHotkey() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }
  function injectPanel() {
    var t = panelLoader.item
    if (!t) return
    t.bar = root.bar; t.settings = root.settings; t.anchorItem = root; t.hostWidget = root; t.service = root.service
  }
  onServiceChanged: injectPanel()
  onSettingsChanged: injectPanel()
  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: { root.injectPanel(); Qt.callLater(root.injectPanel) }
  }
}
