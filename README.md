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
`mic remote|system`, `micStatus <id>`, `micToggle`, `engine voxtype|typeless`, `typelessHotkey <chord>`,
`selftestPing`, `selftestArm`, `selftestStatus|selftestReport|selftestDisarm <id>`.

## Typeless engine (optional)

With **Engine: Typeless** (Voice tab), the remote's mic button sends Typeless's dictation hotkey instead of driving
Voxtype. Typeless records, transcribes and pastes on its own; choose its microphone in Typeless.

- Setup: `bash host/omaremote-setup typeless` installs the `omaremote-keytap` user service, a uinput keyboard that needs
  the `input` group, which Typeless needs too. On the first run it adopts Typeless's dictation hotkey. Change the
  hotkey with `--hotkey RightAlt+RightShift`, or re-read Typeless's with `--hotkey-from-typeless`. Setup never switches
  the engine.
- `remote` mic mode: hold the button to talk. In Typeless, select the remote's microphone (小米蓝牙语音遥控器).
- `system` mic mode: each press toggles Typeless; it records from whatever microphone Typeless has selected.
- **Known limitation:** omaremote cannot see Typeless's real state. Pressing the hotkey on the keyboard, Typeless
  stopping by itself (silence or its length limit), or a tap whose result was unknown can leave the two inverted.
  Every later remote hold then toggles the wrong way. To recover:
  1. stop Typeless by hand;
  2. press reset if the bar shows the Typeless warning;
  3. hold again.
- After restarting the shell during a dictation, check Typeless: it may still be recording.

License: GPL-3.0-only.
