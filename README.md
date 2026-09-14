# OmaRemote

Omarchy Quickshell plugin that turns an ATVV-class Bluetooth voice remote (G20S Pro family, Xiaomi Remote 2 Pro once verified) into a couch controller: push-to-talk dictation through Voxtype and a configurable 13-key mapping engine.

Design: `docs/superpowers/specs/2026-09-14-omaremote-design.md`.

## Development

    make test      # node --test "tests/*.test.mjs"
    make check     # + qmllint / omarchy plugin validate when available

License: GPL-3.0-only.
