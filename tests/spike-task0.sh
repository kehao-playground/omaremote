#!/usr/bin/env bash
# Spec §2 "Verification-first items" (1)-(4) + ES-module check. Run on a live Omarchy session
# after `make dev-restart` and `omarchy plugin enable io.github.kehao-chen.omaremote right`.
set -uo pipefail
say() { printf '%s\n' "$*"; }
streams() {
  pw-dump | jq '[.[] | select(.type == "PipeWire:Interface:Node")
                     | select((.info.props["media.class"] // "") == "Stream/Input/Audio")
                     | select(((.info.props["application.name"] // "") + (.info.props["node.name"] // "")) | test("voxtype"; "i"))] | length'
}
say "## versions"
hyprctl version | head -1; quickshell --version; voxtype --version; pacman -Q keyd 2>/dev/null || say "keyd: not installed"
say "## 0a ES modules from QML (Map/Set/spread/template/default params/includes/engine)"
omarchy-shell omaremote es
say "## 0b bar widget reaches the service through bar.shell.serviceFor (expect widget:true)"
sleep 1; omarchy-shell omaremote counts
say "## 0c GlobalShortcut press+release from one 'global' bind (hl.dsp.global equivalent)"
hyprctl keyword bind ",F13,global,omaremote:up" >/dev/null
before=$(omarchy-shell omaremote counts)
wtype -P F13 -s 100 -p F13; sleep 0.3
after=$(omarchy-shell omaremote counts)
say "before=$before"; say "after=$after   (expect press and release each +1)"
hyprctl reload >/dev/null
say "## 0d service-owned PanelWindow (expect hudVisible:true after the press above)"
omarchy-shell omaremote counts
say "## 0e Voxtype opens its capture stream only while recording (expect 0 / >=1 / 0)"
say "idle: $(streams)"
voxtype record start; sleep 1.5
say "recording: $(streams)"
voxtype record cancel; sleep 0.7
say "after cancel: $(streams)"
