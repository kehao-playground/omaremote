// Spec §9 "integration, no hardware": a second Quickshell instance hosting the real Service.qml with fake adapters on PATH.
// The runner materializes a harness root containing shell.qml plus symlinks to the repo's Service.qml, lib/, components/, host/ — Quickshell cannot load files outside its config root.
import QtQuick
import Quickshell

ShellRoot {
  id: harness
  property var service: null
  Component.onCompleted: {
    var comp = Qt.createComponent(Qt.resolvedUrl("Service.qml"))
    if (comp.status === Component.Error) { console.error("harness: " + comp.errorString()); Qt.quit(); return }
    harness.service = comp.createObject(null)
    if (!harness.service) { console.error("harness: createObject failed: " + comp.errorString()); Qt.quit() }
  }
}
