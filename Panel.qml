// Spec §6.2: KeyboardPanel with four tabs (Status, Keys, Voice, Setup), fully keyboard-navigable: ←/→ or 1–4 switch tabs,
// ↑/↓ move the row cursor, Enter activates, Esc closes; the Service owns the only "omaremote" IpcHandler (manageIpc: false).
import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "components"

Panel {
  id: root
  moduleName: "io.github.kehao-chen.omaremote"
  ipcTarget: ""
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var service: null
  readonly property var barIdentity: hostWidget || root
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  property int tabIndex: 0
  readonly property var pages: [statusTab, keysTab, voiceTab, setupTab]
  readonly property var currentTab: pages[tabIndex]
  readonly property bool editing: currentTab ? currentTab.editing : false

  function open() { setCenterHoverRevealSuppressed(false); root.controller.show(); currentTab.onShown(); if (service) service.refreshDoctor() }
  function openFromHotkey() { open(); Qt.callLater(function() { if (root.opened) setCenterHoverRevealSuppressed(true) }) }
  function close() { setCenterHoverRevealSuppressed(false); root.controller.hide(); statusTab.onHidden() }   // finding #4: the mic-test timer must not survive the panel closing
  function toggle() { if (root.opened) root.close(); else root.openFromHotkey() }
  function switchPanel(direction) { return root.bar && typeof root.bar.switchPanelFrom === "function" ? root.bar.switchPanelFrom(root.barIdentity, direction) : false }
  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function") root.bar.setCenterHoverRevealSuppressed(value)
  }
  function selectTab(i) { tabIndex = Math.max(0, Math.min(3, i)); currentTab.onShown() }
  function switchTab(dx) { selectTab((tabIndex + dx + 4) % 4) }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.editing
      onMoveRequested: function(dx, dy) {
        if (dx !== 0 && root.tabIndex === 1 && keysTab.cursor >= 0 && keysTab.cursor < 13) keysTab.moveColumn(dx)
        else if (dx !== 0) root.switchTab(dx)
        else root.currentTab.moveCursor(dy)
      }
      onActivateRequested: root.currentTab.activate()
      onReturnRequested: root.currentTab.activate()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        var n = parseInt(t, 10)
        if (n >= 1 && n <= 4) root.selectTab(n - 1)
        else if (t === "r" && root.service) root.service.refreshDoctor()
      }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: "OmaRemote"
          meta: root.service ? (root.service.voiceState + (root.service.remoteWarning ? " · remote mic not ready" : "")).toUpperCase() : "SERVICE NOT LOADED"
          foreground: root.contentForeground
          fontFamily: root.contentFontFamily
          iconComponent: Component { Text { textFormat: Text.PlainText; text: "󰍬"; color: root.contentForeground; font.family: root.contentFontFamily; font.pixelSize: Style.font.display } }
        }
        TabBar {
          id: tabs
          current: root.tabIndex
          fg: root.contentForeground
          fontFamily: root.contentFontFamily
          onSelected: function(i) { root.selectTab(i) }
        }
        PanelSeparator { foreground: root.contentForeground }
        Item {
          width: parent.width
          implicitHeight: root.currentTab ? root.currentTab.implicitHeight : 0
          StatusTab { id: statusTab; width: parent.width; visible: root.tabIndex === 0; service: root.service; bar: root.bar; fg: root.contentForeground; fontFamily: root.contentFontFamily }
          KeysTab   { id: keysTab;   width: parent.width; visible: root.tabIndex === 1; service: root.service; bar: root.bar; fg: root.contentForeground; fontFamily: root.contentFontFamily }
          VoiceTab  { id: voiceTab;  width: parent.width; visible: root.tabIndex === 2; service: root.service; bar: root.bar; fg: root.contentForeground; fontFamily: root.contentFontFamily }
          SetupTab  { id: setupTab;  width: parent.width; visible: root.tabIndex === 3; service: root.service; bar: root.bar; fg: root.contentForeground; fontFamily: root.contentFontFamily }
        }
        Text {
          textFormat: Text.PlainText
          text: "←→ tabs · ↑↓ rows · Enter · Esc · r refresh"
          color: Qt.darker(root.contentForeground, 1.6)
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
