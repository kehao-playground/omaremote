// Typeless spec §6.1/§9: the real components/CommandRunner.qml must report every job exactly once within
// deadline + 1 s. Run by tests/runner-bound.sh in an offscreen Quickshell instance; prints "runner-bound: ok".
import QtQuick
import Quickshell
import "components"

ShellRoot {
  id: h
  property double t0: Date.now()
  property var seen: ({})              // "src:id" → [{ code, at, out }]
  property var fails: []
  function fail(msg) { var f = h.fails.slice(); f.push(msg); h.fails = f }

  function record(src, id, code, stdout) {
    var k = src + ":" + id, next = ({})
    for (var x in h.seen) next[x] = h.seen[x]
    next[k] = (h.seen[k] || []).concat([{ code: code, at: Date.now() - h.t0, out: stdout }])
    h.seen = next
  }
  CommandRunner { id: runner; onFinished: function(src, id, code, stdout, timedOut) { h.record(src, id, code, stdout) } }
  // A runner whose escalation is a no-op (signal 0): its child survives SIGTERM and "SIGKILL" alike, so only the hard
  // deadline + 1 s bound can report the job.
  CommandRunner { id: unkillable; escalationSignal: 0; onFinished: function(src, id, code, stdout, timedOut) { h.record("u", id, code, stdout) } }
  Component.onCompleted: {
    // 1. a child that outlives every signal: reported by the hard bound at 500 + 1000 ms; its own exit at ~2.5 s
    //    must not report a second time
    unkillable.run("u", 1, ["bash", "-c", "trap '' TERM; for i in $(seq 50); do sleep 0.05; done"], 500)
    // 2. ignores SIGTERM: the SIGKILL at 500 + 500 ms ends it
    runner.run("t", 2, ["bash", "-c", "trap '' TERM; while :; do sleep 0.05; done"], 500)
    // 3. an ordinary job is untouched
    runner.run("t", 3, ["sh", "-c", "echo hi"], 2000)
    // 4. cancelAll still reports 137, once
    runner.run("c", 4, ["sleep", "5"], 2000)
    cancelTimer.start()
    checkTimer.start()
  }
  Timer { id: cancelTimer; interval: 100; onTriggered: runner.cancelAll("c") }
  Timer {
    id: checkTimer; interval: 4000
    onTriggered: {
      function one(k) { var l = h.seen[k] || []; if (l.length !== 1) h.fail(k + " reported " + l.length + " times"); return l[0] }
      var a = one("u:1"); if (a && (a.code !== 124 || a.at < 1400 || a.at > 1900)) h.fail("u:1 code " + a.code + " at " + a.at + " ms (want 124 within 1400-1900)")
      var b = one("t:2"); if (b && (b.code !== 124 || b.at < 950 || b.at > 1400)) h.fail("t:2 code " + b.code + " at " + b.at + " ms (want 124 within 950-1400)")
      var c = one("t:3"); if (c && (c.code !== 0 || c.out.trim() !== "hi" || c.at > 1000)) h.fail("t:3 code " + c.code + " out " + JSON.stringify(c.out) + " at " + c.at)
      var d = one("c:4"); if (d && d.code !== 137) h.fail("c:4 code " + d.code)
      if (runner.pending("t") !== 0 || runner.pending("c") !== 0 || unkillable.pending("u") !== 0) h.fail("jobs left pending")
      console.log(h.fails.length ? "runner-bound: FAIL " + h.fails.join("; ") : "runner-bound: ok")
      Qt.quit()
    }
  }
}
