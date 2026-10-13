#!/usr/bin/env bash
# Typeless spec §6.1/§9: run tests/harness/RunnerBound.qml against the real components/ in an offscreen Quickshell
# instance (no Wayland needed). Quickshell loads QML only under its config root, so the root is materialized here.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
command -v qs >/dev/null 2>&1 || { echo "runner-bound: skipped (no quickshell)"; exit 0; }
T=$(mktemp -d /tmp/omaremote-runner.XXXXXX); trap 'rm -rf "$T"' EXIT
cp "$ROOT/tests/harness/RunnerBound.qml" "$T/shell.qml"
ln -s "$ROOT/components" "$T/components"
out=$(QT_QPA_PLATFORM=offscreen timeout 20 qs -p "$T" --no-duplicate 2>&1)
line=$(grep -o 'runner-bound: .*' <<<"$out" | sed 's/\x1b\[[0-9;]*m//g' | tail -n1)
echo "${line:-runner-bound: no result}"
[[ $line == "runner-bound: ok" ]] || { sed 's/^/    /' <<<"$out" | tail -20; exit 1; }
