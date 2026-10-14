// Spec §6.2 tab 3 — Voice: active sources, current owner (inferred label), maxSessionSec, HUD/action-flash toggles,
// Voxtype mic picker (Remote, System default, each capture source; picker spec §4.5) (§3 transaction: active and requested modes shown separately, second request disabled,
// terminal error/rollback shown), detailed stats.
import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Presentation.mjs" as Presentation

Item {
  id: root
  property var service: null
  property QtObject bar: null
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int cursor: -1
  readonly property int rowCount: 5                    // engine, mic switch, HUD toggle, flash toggle, maxSessionSec (Enter cycles 30/60/120)
  property bool editing: false
  property string requestedMode: ""
  property string lastError: ""
  property string engineError: ""
  readonly property var s: service
  readonly property var cfg: s && s.config ? s.config : null
  readonly property var current: s && s.micCurrentId ? s.micStatusOf(s.micCurrentId) : null
  readonly property var choices: Presentation.micChoices(cfg, s ? s.micSourceList : [])
  property int pick: -1                                   // highlighted choice while the cursor is on the Microphone row
  // Picker spec §4.5 retry ownership: every user choice takes a new intent number. A retry carries the intent that
  // started it and dies when that is no longer current, so a superseded choice can never apply or touch the status line.
  property int _intent: 0
  property var _retry: null                               // { mode, device, label, intent, tries } while sourcesRefreshing is retried
  function activeIndex() { for (var i = 0; i < choices.length; i++) if (choices[i].active) return i; return 0 }
  function moveChoice(dx) { var p = pick < 0 ? activeIndex() : pick; pick = Math.max(0, Math.min(choices.length - 1, p + dx)) }

  function onShown() { cursor = -1; pick = -1; root.cancelPending(); if (s) s.refreshMicSources() }
  function cancelPending() { root._intent++; root._retry = null; retryTimer.stop() }
  function onHidden() { root.cancelPending() }             // Panel.close(): a closed panel retries nothing
  function moveCursor(dy) { cursor = cursor < 0 ? 0 : Math.max(0, Math.min(rowCount - 1, cursor + dy)); if (cursor !== 1) pick = -1 }
  onChoicesChanged: pick = -1                             // a refresh may reorder the list: never let the highlight land on another source
  function activate() {
    if (!cfg) return
    if (cursor === 0) root.requestEngine(cfg.voice.engine === "typeless" ? "voxtype" : "typeless")
    else if (cursor === 1) { var c = choices[pick < 0 ? activeIndex() : pick]; if (c && c.connected && !c.active) root.requestChoice(c) }
    else if (cursor === 2) s.setVoiceField("hud", !cfg.voice.hud)
    else if (cursor === 3) s.setVoiceField("actionFlash", !cfg.voice.actionFlash)
    else if (cursor === 4) s.setVoiceField("maxSessionSec", cfg.voice.maxSessionSec >= 120 ? 30 : cfg.voice.maxSessionSec >= 60 ? 120 : 60)
  }
  function requestEngine(name) {                        // Typeless spec §7: the switch drains both engines first
    if (!s) return
    var r = s.setEngine(name)
    root.engineError = r === "ok" ? "" : r
  }
  function requestChoice(c) {                              // a new user intent supersedes any pending retry
    root.cancelPending()
    root.requestMic(c.mode, c.mode === "system" ? c.device : undefined, c.label, root._intent, 1)
  }
  function requestMic(mode, device, label, intent, tries) { // §3: returns immediately; the Service polls micStatus internally
    if (intent !== root._intent) return                    // superseded by a newer choice, or the panel closed
    root._retry = null
    if (!s || s.micPending) return                         // another apply holds the mic; this intent ends here
    var r = JSON.parse(device === undefined ? s.ipcMic(mode) : s.ipcMic(mode, device))
    if (!r.ok && r.reason === "busy" && r.detail === "sourcesRefreshing" && tries < 20) {   // picker spec §4.5: retried, never shown
      root._retry = { mode: mode, device: device, label: label, intent: intent, tries: tries + 1 }
      retryTimer.restart()
      return
    }
    root.requestedMode = r.ok ? (label || mode) : ""
    root.lastError = r.ok ? "" : Presentation.micRefusal(r.reason)
  }
  Timer {
    id: retryTimer; interval: 300; repeat: false
    onTriggered: { var t = root._retry; if (t) root.requestMic(t.mode, t.device, t.label, t.intent, t.tries) }
  }

  implicitHeight: column.implicitHeight
  Column {
    id: column
    width: parent.width
    spacing: Style.space(8)

    PanelSectionHeader { text: "Engine"; foreground: root.fg; fontFamily: root.fontFamily }
    Row {
      spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Transcription: " + (root.cfg ? root.cfg.voice.engine : "?"); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      Button { text: "Voxtype"; selected: root.cfg && root.cfg.voice.engine === "voxtype"; hasCursor: root.cursor === 0; foreground: root.fg; enabled: root.s && !root.s.switching; onClicked: root.requestEngine("voxtype") }
      Button { text: "Typeless"; selected: root.cfg && root.cfg.voice.engine === "typeless"; hasCursor: root.cursor === 0; foreground: root.fg; enabled: root.s && !root.s.switching; onClicked: root.requestEngine("typeless") }
    }
    Text {
      textFormat: Text.PlainText; width: parent.width; wrapMode: Text.WordWrap
      visible: text !== ""
      text: {
        if (!root.s || !root.cfg) return ""
        if (root.s.switching) return "switching engine…"
        if (root.engineError) return "engine change refused: " + root.engineError
        if (root.cfg.voice.engine !== "typeless") return ""
        return Presentation.engineStatusLine(root.cfg, root.s.doctorFacts) + " — edit with omaremote-setup typeless --hotkey …"
      }
      color: Qt.darker(root.fg, 1.3); font.family: root.fontFamily; font.pixelSize: Style.font.caption
    }

    PanelSectionHeader { text: "Microphone"; foreground: root.fg; fontFamily: root.fontFamily }
    Flow {
      width: parent.width
      spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Voxtype mic:"; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body }
      Repeater {
        model: root.choices
        delegate: Button {
          required property var modelData
          required property int index
          text: modelData.label
          selected: modelData.active
          hasCursor: root.cursor === 1 && (root.pick < 0 ? modelData.active : root.pick === index)
          foreground: root.fg
          enabled: root.s && !root.s.micPending && modelData.connected
          onClicked: if (!modelData.active) root.requestChoice(modelData)
        }
      }
    }
    Text {
      textFormat: Text.PlainText
      width: parent.width; wrapMode: Text.WordWrap
      visible: text !== ""
      text: {
        if (!root.s) return ""
        if (root.s.micPending && root.current) return "requested: " + root.requestedMode + " · " + Presentation.micStatusLine(root.current) + " — changing microphones restarts Voxtype; leave F9 alone until it finishes"
        if (root.lastError) return "request refused: " + root.lastError
        if (root.s.micLast && root.s.micLast.state === "failed") return "last change failed: " + Presentation.micStatusLine(root.s.micLast)
        if (root.s.micConflict) return Presentation.micConflictLine(root.s.micConflict)
        if (root.cfg && root.cfg.voice.engine === "typeless") return Presentation.TYPELESS_MIC_HINT
        return ""
      }
      color: root.s && root.s.micLast && root.s.micLast.state === "failed" ? Color.urgent : Qt.darker(root.fg, 1.3)
      font.family: root.fontFamily; font.pixelSize: Style.font.caption
    }

    PanelSectionHeader { text: "Sources"; foreground: root.fg; fontFamily: root.fontFamily }
    Text {
      textFormat: Text.PlainText; width: parent.width; wrapMode: Text.WordWrap
      text: !root.s ? "" :
        "remote button (D-Bus): " + (root.s.atvBusName ? (root.s.remoteWarning ? "disabled — remote mic not ready" : "active · " + root.s.remoteState) : "ATVVoice not on the bus") +
        "\nHID mic key: " + Presentation.hidMicLine(root.cfg) +
        "\nkeyboard (F9): " + Presentation.keyboardSourceLine(root.cfg) +
        (root.s.voiceState !== "idle" ? "\ncurrent session: " + root.s.voiceState + " · owner " + root.s.voiceOwner + (root.s.voiceInferred ? " (inferred attribution)" : "") : "")
      color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall
    }

    PanelSectionHeader { text: "Options"; foreground: root.fg; fontFamily: root.fontFamily }
    Row { spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "HUD"; width: Style.space(120); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      ToggleSwitch { checked: root.cfg ? root.cfg.voice.hud : true; hasCursor: root.cursor === 2; foreground: root.fg; onToggled: root.s.setVoiceField("hud", !root.cfg.voice.hud) }
    }
    Row { spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Action flash"; width: Style.space(120); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      ToggleSwitch { checked: root.cfg ? root.cfg.voice.actionFlash : true; hasCursor: root.cursor === 3; foreground: root.fg; onToggled: root.s.setVoiceField("actionFlash", !root.cfg.voice.actionFlash) }
    }
    Row { spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Max session (s)"; width: Style.space(120); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      NumberField { value: root.cfg ? root.cfg.voice.maxSessionSec : 60; from: 5; to: 600; stepSize: 5; hasCursor: root.cursor === 4; foreground: root.fg; fontFamily: root.fontFamily; onModified: function(v) { root.s.setVoiceField("maxSessionSec", v) } }
    }

    PanelSectionHeader { text: "Stats"; foreground: root.fg; fontFamily: root.fontFamily }
    Text {
      textFormat: Text.PlainText; width: parent.width
      text: !root.s ? "" :
        "today " + root.s.statsSummary.today.count + " · " + Math.round(root.s.statsSummary.today.seconds) + " s\n" +
        "this week " + root.s.statsSummary.week.count + " · " + Math.round(root.s.statsSummary.week.seconds) + " s\n" +
        "all time " + root.s.statsSummary.all.count + " · " + Math.round(root.s.statsSummary.all.seconds) + " s" +
        (root.s.statsSummary.longest ? "\nlongest " + Math.round(root.s.statsSummary.longest.durationSec) + " s" : "")
      color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall
    }
  }
}
