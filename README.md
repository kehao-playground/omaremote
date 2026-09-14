# OmaRemote

Omarchy Quickshell plugin that turns an ATVV-class Bluetooth voice remote (G20S Pro family, Xiaomi Remote 2 Pro once verified) into a couch controller: push-to-talk dictation through Voxtype and a configurable 13-key mapping engine.

Design: `docs/superpowers/specs/2026-09-14-omaremote-design.md`.

## Development

```bash
make test          # node --test (pure lib)
make lint          # qmllint + omarchy plugin validate
make integration   # second Quickshell instance + bash fakes; never touches the live shell or ~/.config/omaremote
make check         # all of the above
make dev-install   # rsync into ~/.config/omarchy/plugins/io.github.kehao-chen.omaremote and rescan
make dev-restart   # + omarchy-restart-shell (needed for Service.qml changes: keepLoaded services survive rescans)
```

IPC (`omarchy-shell omaremote …`): `ping`, `status`, `doctor`, `key <name> down|up`, `voice state <state>`, `voice poll -`, `reset`,
`mic remote|system`, `micStatus <id>`, `micToggle`, `selftestPing`, `selftestArm`, `selftestStatus|selftestReport|selftestDisarm <id>`.

License: GPL-3.0-only.
