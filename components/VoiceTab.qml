// Spec §6.2 tab 3 — Voice: active sources, current owner (inferred label), maxSessionSec, HUD/action-flash toggles,
// Voxtype mic Remote/System switch (§3 transaction: active and requested modes shown separately, second request disabled,
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
  readonly property int rowCount: 4                    // mic switch, HUD toggle, flash toggle, maxSessionSec (+/- via ←/→ not needed: Enter cycles 30/60/120)
  property bool editing: false
  property string requestedMode: ""
  property string lastError: ""
  readonly property var s: service
  readonly property var cfg: s && s.config ? s.config : null
  readonly property var current: s && s.micCurrentId ? s.micStatusOf(s.micCurrentId) : null

  function onShown() { cursor = -1 }
  function moveCursor(dy) { cursor = cursor < 0 ? 0 : Math.max(0, Math.min(rowCount - 1, cursor + dy)) }
  function activate() {
    if (!cfg) return
    if (cursor === 0) root.requestMic(cfg.voice.mic === "remote" ? "system" : "remote")
    else if (cursor === 1) s.setVoiceField("hud", !cfg.voice.hud)
    else if (cursor === 2) s.setVoiceField("actionFlash", !cfg.voice.actionFlash)
    else if (cursor === 3) s.setVoiceField("maxSessionSec", cfg.voice.maxSessionSec >= 120 ? 30 : cfg.voice.maxSessionSec >= 60 ? 120 : 60)
  }
  function requestMic(mode) {                           // §3: returns immediately; the Service polls micStatus internally
    if (!s || s.micPending) return
    var r = JSON.parse(s.ipcMic(mode))
    root.requestedMode = r.ok ? mode : ""
    root.lastError = r.ok ? "" : r.reason
  }

  implicitHeight: column.implicitHeight
  Column {
    id: column
    width: parent.width
    spacing: Style.space(8)

    PanelSectionHeader { text: "Microphone"; foreground: root.fg; fontFamily: root.fontFamily }
    Row {
      spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Voxtype mic: " + (root.cfg ? root.cfg.voice.mic : "?"); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      Button { text: "Remote"; selected: root.cfg && root.cfg.voice.mic === "remote"; hasCursor: root.cursor === 0; foreground: root.fg; enabled: root.s && !root.s.micPending; onClicked: root.requestMic("remote") }
      Button { text: "System default"; selected: root.cfg && root.cfg.voice.mic === "system"; hasCursor: root.cursor === 0; foreground: root.fg; enabled: root.s && !root.s.micPending; onClicked: root.requestMic("system") }
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
        if (root.s.micConflict) return "conflict: Voxtype audio.device is " + root.s.micConflict.found + " (expected " + root.s.micConflict.expected + ") — reconcile in Setup"
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
        "\nHID mic key: " + (root.cfg && root.cfg.keys.mic.supported !== false && root.cfg.keys.mic.trigger !== "key" ? (root.cfg.keys.mic.trigger === "toggle" ? "toggle (press to start, press again to stop)" : "push-to-talk") : "not available") +
        "\nkeyboard (F9): observed" +
        (root.s.voiceState !== "idle" ? "\ncurrent session: " + root.s.voiceState + " · owner " + root.s.voiceOwner + (root.s.voiceInferred ? " (inferred attribution)" : "") : "")
      color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall
    }

    PanelSectionHeader { text: "Options"; foreground: root.fg; fontFamily: root.fontFamily }
    Row { spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "HUD"; width: Style.space(120); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      ToggleSwitch { checked: root.cfg ? root.cfg.voice.hud : true; hasCursor: root.cursor === 1; foreground: root.fg; onToggled: root.s.setVoiceField("hud", !root.cfg.voice.hud) }
    }
    Row { spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Action flash"; width: Style.space(120); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      ToggleSwitch { checked: root.cfg ? root.cfg.voice.actionFlash : true; hasCursor: root.cursor === 2; foreground: root.fg; onToggled: root.s.setVoiceField("actionFlash", !root.cfg.voice.actionFlash) }
    }
    Row { spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Max session (s)"; width: Style.space(120); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      NumberField { value: root.cfg ? root.cfg.voice.maxSessionSec : 60; from: 5; to: 600; stepSize: 5; hasCursor: root.cursor === 3; foreground: root.fg; fontFamily: root.fontFamily; onModified: function(v) { root.s.setVoiceField("maxSessionSec", v) } }
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
