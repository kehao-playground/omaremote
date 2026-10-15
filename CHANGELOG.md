# Changelog

All notable changes to OmaRemote. Versions follow [Semantic Versioning](https://semver.org); while the version is
0.x, a minor release may change behaviour or generated files.

## 0.1.1 — 2026-10-15

### Changed

- The `atvvoice` setup step checks out ATVVoice's pinned commit by its literal SHA (`git checkout --detach`), in one
  `&&` chain with the patch and the build, so the marketplace security baseline can verify the pin. The commit built
  is unchanged.

## 0.1.0 — 2026-10-15

First public release. Tested on Omarchy 4.0 (alpha) with the Xiaomi Bluetooth Voice Remote (RC003, `2717:32b8`).

### Added

- **Dictation from the remote.** Hold the mic button to dictate into the focused window, through either engine:
  - Voxtype (default): local Whisper through Omarchy's Voxtype.
  - Typeless (optional): the remote sends Typeless's dictation hotkey through the `omaremote-keytap` user service.
- **Microphone modes.** `remote` streams the remote's own microphone over Bluetooth through ATVVoice, built at a
  pinned commit with a decoder patch. `system` uses a desktop microphone.
- **Microphone picker.** In `system` mode, choose the Voxtype microphone in the Voice tab or with
  `omarchy-shell omaremote micSystem <node>`. A microphone that is unplugged keeps its name.
- **13-key mapping engine.** Tap, hold, double-tap and repeat per key, with key, Hyprland dispatcher, volume, media
  and screen actions. Holding the panic key (Menu) resets everything.
- **Bar widget, panel and HUD.** Status, Keys, Voice and Setup tabs, all keyboard-navigable.
- **Doctor.** The Setup tab checks each host prerequisite and gives a copyable fix for each failure.
- **Host setup script** (`host/omaremote-setup`): keyd mapping, Hyprland binds and xkb option, ATVVoice,
  microphone mode, Typeless keytap, and a transport self-test.
- **`omaremote-setup uninstall`**: undoes every setup step, asking before each item. `--dry-run` lists what it would
  remove; `--purge` also deletes `~/.config/omaremote`.
