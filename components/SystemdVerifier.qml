// Spec §3 (systemd job contract: poll Job/ActiveState/InvocationID at 1 s while an operation is pending; never submit a competing
// restart; verify active + new InvocationID + fresh idle within 10 s), §5.3 (bounded recovery restart with the same contract).
import QtQuick
import Quickshell.Io
import "../lib/Systemd.mjs" as Systemd

Item {
  id: root
  property var verifier: Systemd.createRestartVerifier({ deadlineMs: 10000 })
  property var lastShow: ({ job: "", activeState: "", invocationId: "", jobPending: false })
  property string invocationBeforeRestart: ""
  property bool jobPolling: false                       // Service sets this while a mic operation is pending
  property string recoveryPhase: ""                     // "" | waitJob | restarting | verifying
  signal jobInfo(var info)
  signal pollRequested()                                 // answered by the Service with a fresh status poll
  signal verified(string kind, string id, bool ok)       // kind: mic | recovery
  signal recoveryRestarting()

  function pollJob() { if (!showProc.running) showProc.running = true }
  Timer {
    id: jobTimer
    interval: 1000; repeat: true; triggeredOnStart: true
    running: root.jobPolling || root.recoveryPhase === "waitJob"
    onTriggered: root.pollJob()
  }

  function markRestart() { root.invocationBeforeRestart = root.lastShow.invocationId }   // call when a restart command is issued
  // DEVIATION (Plan 1 review note): Systemd.mjs createRestartVerifier().begin() silently overwrites an
  // in-flight verification. Guard both callers (here and the recovery-restart exit handler below) so a
  // second verification never clobbers the first's tracking state. The caller that loses the race is not
  // stranded: MicApply carries its own VERIFY_MS deadline independent of this signal, and VoiceSession
  // carries its own RESTART_MS deadline — both time out to a safe failure/unconfigured outcome on their own.
  function beginVerify(kind, id, now) {
    if (root.verifier.active()) return
    root.handle(root.verifier.begin(kind + ":" + id, root.invocationBeforeRestart, now), now)
  }
  function beginRecovery(now) {
    if (root.recoveryPhase !== "") return
    root.recoveryPhase = "waitJob"                       // §5.3: a non-empty Job blocks the restart whatever its origin
    root.pollJob()
  }
  function handle(fx, now) {
    for (var i = 0; i < fx.length; i++) {
      var e = fx[i]
      if (e.type === "show") root.pollJob()
      else if (e.type === "poll") root.pollRequested()
      else if (e.type === "verified") {
        var p = e.id.indexOf(":")
        var kind = e.id.slice(0, p)
        if (kind === "recovery") root.recoveryPhase = ""
        root.verified(kind, e.id.slice(p + 1), e.ok)
      }
    }
  }
  function status(cls, fresh, now) { if (root.verifier.active()) root.handle(root.verifier.status(cls, fresh, now), now) }
  function advance(now) { if (root.verifier.active()) root.handle(root.verifier.advance(now), now) }
  function nextDeadline() { return root.verifier.nextDeadline() }

  Process {
    id: showProc
    command: ["systemctl", "--user", "show", "voxtype", "--property=Job,ActiveState,InvocationID"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var info = Systemd.parseShow(text)
      var now = Date.now()
      root.lastShow = info
      root.jobInfo(info)
      if (root.verifier.active()) root.handle(root.verifier.show(info, now), now)
      if (root.recoveryPhase === "waitJob" && !info.jobPending) {
        root.recoveryPhase = "restarting"
        root.markRestart()
        root.recoveryRestarting()
        restartGuard.restart()
        restartProc.running = true
      }
    } }
  }
  Process {
    id: restartProc
    command: ["systemctl", "--user", "restart", "voxtype"]
    onExited: function(code, st) {
      restartGuard.stop()
      var now = Date.now()
      if (root.recoveryPhase !== "restarting") return
      if (code !== 0) { root.recoveryPhase = ""; root.verified("recovery", "", false); return }
      if (root.verifier.active()) { root.recoveryPhase = ""; return }   // see beginVerify's guard note above
      root.recoveryPhase = "verifying"
      root.handle(root.verifier.begin("recovery:", root.invocationBeforeRestart, now), now)
    }
  }
  Timer { id: restartGuard; interval: 10000; repeat: false; onTriggered: if (restartProc.running) restartProc.signal(15) }
}
