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
  property bool _followStarted: false              // reset before each (re)start attempt, set by onStarted
  property bool _pollStarted: false                // same, for the one-shot poll process

  function start() { root.generation++; follow.running = true }
  function restart() {                             // after a Voxtype restart: drop the old monitor and its buffered lines
    root.generation++
    if (follow.running) { root._restartNow = true; follow.signal(15) } else follow.running = true
  }
  function poll() { if (pollProc.running) { root._pollAgain = true; return } pollProc.running = true }

  Process {
    id: follow
    command: ["voxtype", "status", "--follow", "--format", "json"]
    onStarted: root._followStarted = true
    // A missing/unexecutable `voxtype` flips `running` false with no `started` and no `exited` (see
    // CommandRunner.qml for the same Quickshell 0.3.1 semantics). Without this, a follow that never starts
    // is silently dead forever: no backoff, no status, §5.4's degradation case never surfaces. Treat a
    // failed start exactly like a normal exit so the existing backoff path retries it (bounded, 1 s → 30 s).
    onRunningChanged: {
      if (follow.running) { root._followStarted = false; return }
      if (root._restartNow) return                                  // onExited already handles a deliberate restart
      if (!root._followStarted) { backoff.interval = Systemd.backoffMs(root.attempts++); backoff.restart() }
    }
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        if (root._restartNow) return                                // discard lines the old process flushes before its exit lands (finding #7)
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
    onStarted: root._pollStarted = true
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (root._pollKilled) { root._pollKilled = false; console.log("omaremote: voxtype status poll timed out"); return }   // hung daemon: no answer, let recovery time out into its bounded restart (§5.3)
        var first = String(text || "").trim().split("\n")[0]
        var r = VoxStatus.parseStatusLine(first)
        root.status(r ? r.cls : "stopped", true, r ? r.raw : null)                 // a prompt "no daemon" answer is `stopped` (§3)
      }
    }
    onRunningChanged: {
      if (pollProc.running) { root._pollStarted = false; pollGuard.restart(); return }
      pollGuard.stop()
      // A missing/unexecutable `voxtype` never reaches the StdioCollector above, so without this a poll
      // answers nothing at all (not even "stopped") and a caller waiting on it (e.g. selftestArm) is stuck
      // busy forever. Still honour a poll that was requested again while this one was "in flight".
      if (!root._pollStarted) {
        root.status("stopped", true, null)
        if (root._pollAgain) { root._pollAgain = false; pollProc.running = true }
      }
    }
    onExited: function(code, st) { if (root._pollAgain) { root._pollAgain = false; pollProc.running = true } }
  }
  Timer { id: pollGuard; interval: 2000; repeat: false; onTriggered: if (pollProc.running) { root._pollKilled = true; pollProc.signal(9) } }
}
