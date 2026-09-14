// Spec §3 Voxtype (change-driven `status --follow`; explicit polls give freshness; no answer → `stopped`), §5.4 (backoff 1 s → 30 s).
import QtQuick
import Quickshell.Io
import "../lib/VoxStatus.mjs" as VoxStatus
import "../lib/Systemd.mjs" as Systemd

Item {
  id: root
  signal status(string cls, bool fresh, var raw)   // fresh=true only for one-shot poll answers (host obligations)
  property int generation: 0                       // bumped on every follow (re)start
  property int attempts: 0
  property bool _restartNow: false
  property bool _pollAgain: false
  property bool _pollKilled: false

  function start() { root.generation++; follow.running = true }
  function restart() {                             // after a Voxtype restart: drop the old monitor and its buffered lines
    root.generation++
    if (follow.running) { root._restartNow = true; follow.signal(15) } else follow.running = true
  }
  function poll() { if (pollProc.running) { root._pollAgain = true; return } pollProc.running = true }

  Process {
    id: follow
    command: ["voxtype", "status", "--follow", "--format", "json"]
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        var r = VoxStatus.parseStatusLine(line)
        if (!r) return
        root.attempts = 0
        root.status(r.cls, false, r.raw)
      }
    }
    onExited: function(code, st) {
      if (root._restartNow) { root._restartNow = false; root.generation++; follow.running = true; return }
      backoff.interval = Systemd.backoffMs(root.attempts++)
      backoff.restart()
    }
  }
  Timer { id: backoff; repeat: false; onTriggered: { root.generation++; follow.running = true } }

  Process {
    id: pollProc
    command: ["voxtype", "status", "--format", "json"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (root._pollKilled) { root._pollKilled = false; console.log("omaremote: voxtype status poll timed out"); return }   // hung daemon: no answer, let recovery time out into its bounded restart (§5.3)
        var first = String(text || "").trim().split("\n")[0]
        var r = VoxStatus.parseStatusLine(first)
        root.status(r ? r.cls : "stopped", true, r ? r.raw : null)                 // a prompt "no daemon" answer is `stopped` (§3)
      }
    }
    onRunningChanged: if (running) pollGuard.restart(); else pollGuard.stop()
    onExited: function(code, st) { if (root._pollAgain) { root._pollAgain = false; pollProc.running = true } }
  }
  Timer { id: pollGuard; interval: 2000; repeat: false; onTriggered: if (pollProc.running) { root._pollKilled = true; pollProc.signal(9) } }
}
