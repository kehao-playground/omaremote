// Spec §5.3 (plugin command processes are tagged, bounded, reaped before a replacement daemon starts), §3 (2 s reads, 10 s restart).
import QtQuick
import Quickshell.Io

Item {
  id: root
  signal finished(string src, int id, int code, string stdout, bool timedOut)
  property var _live: ({})                        // "src:id" → job Item

  function run(src, id, argv, deadlineMs) {
    var job = jobComponent.createObject(root, { src: src, opId: id, argv: argv, deadlineMs: deadlineMs })
    if (!job) { console.log("omaremote: could not start " + argv.join(" ")); root.finished(src, id, 127, "", false); return }
    var next = ({}); for (var k in root._live) next[k] = root._live[k]
    next[src + ":" + id] = job
    root._live = next
  }
  function cancelAll(src) {                       // §5.3: terminate + reap outstanding plugin commands of one module
    var keep = ({})
    for (var k in root._live) {
      if (k.indexOf(src + ":") === 0) root._live[k].kill(); else keep[k] = root._live[k]
    }
    root._live = keep
  }
  function pending(src) { var n = 0; for (var k in root._live) if (k.indexOf(src + ":") === 0) n++; return n }
  function _finish(job) {
    var next = ({}); for (var k in root._live) if (root._live[k] !== job) next[k] = root._live[k]
    root._live = next
    root.finished(job.src, job.opId, job.code, job.outText, job.timedOut)
    job.destroy(0)
  }

  Component {
    id: jobComponent
    Item {
      id: job
      property string src
      property int opId
      property var argv
      property int deadlineMs
      property bool timedOut: false
      property bool started: false
      property bool exitedSeen: false
      property bool streamDone: false
      property bool killed: false
      property int code: -1
      property string outText: ""
      function maybeDone() { if (exitedSeen && streamDone) root._finish(job) }
      function kill() { killed = true; if (proc.running) proc.signal(9) }
      Process {
        id: proc
        command: job.argv
        onStarted: job.started = true
        // A binary that cannot be found/exec'd flips `running` back to false without ever emitting `started`
        // or `exited` (verified live in a scratch Quickshell 0.3.1 instance) — the StdioCollector below never
        // finishes either, so without this the job would stay in `_live` forever. Synthesize exit 127.
        onRunningChanged: {
          if (!proc.running && !job.started && !job.exitedSeen) {
            job.code = 127
            job.exitedSeen = true
            job.streamDone = true
            job.maybeDone()
          }
        }
        stdout: StdioCollector {
          waitForEnd: true
          onStreamFinished: { job.outText = text; job.streamDone = true; job.maybeDone() }
        }
        onExited: function(exitCode, exitStatus) {
          job.code = job.timedOut ? 124 : (job.killed ? 137 : exitCode)
          job.exitedSeen = true
          job.maybeDone()
        }
      }
      Timer {
        interval: job.deadlineMs
        running: true
        repeat: false
        onTriggered: { if (proc.running) { job.timedOut = true; proc.signal(15) } }
      }
      Component.onCompleted: proc.running = true
    }
  }
}
