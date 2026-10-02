# Learned key map — 小米蓝牙语音遥控器 (Xiaomi Bluetooth voice remote)

Captured 2026-10-02 on the development host by reading `/dev/input/event13` directly (no
`EVIOCGRAB`), with keyd **not** installed — i.e. these are the remote's native HID codes, before
any remap. This is the data Plan 3's `host/omaremote-setup` learning step (spec §7 step 2) would
produce, and what it should persist as `config.json → device.learned`.

## Device

| field | value |
|---|---|
| name | `小米蓝牙语音遥控器` |
| evdev node | `/dev/input/event13` (`sysrq kbd`) |
| bustype | `0005` (Bluetooth) |
| vendor:product | `2717:32b8` → keyd `[ids]` line `2717:32b8` |
| version | `00a4` |
| Bluetooth address | `C0:5D:39:C3:45:D1` |

ATVV-class remote per spec §1 ("Xiaomi Remote 2 Pro / RC003 once verified") — now verified for key
layout. All 13 logical keys exist on this remote; nothing had to be skipped, so the `menu` default
panic key is available and no `PANIC_FALLBACK_ORDER` entry is needed.

## Mapping

Physical code as emitted by the remote → neutral key from `lib/Defaults.mjs NEUTRAL_KEYS` → the
keysym a Hyprland bind uses.

| logical | remote emits | code | keyd neutral | Hyprland keysym |
|---|---|---|---|---|
| up | `KEY_UP` | 103 | `f13` | `F13` |
| down | `KEY_DOWN` | 108 | `f14` | `F14` |
| left | `KEY_LEFT` | 105 | `f15` | `F15` |
| right | `KEY_RIGHT` | 106 | `f16` | `F16` |
| ok | `KEY_ENTER` | 28 | `f17` | `F17` |
| back | `KEY_BACK` | 158 | `f18` | `F18` |
| home | `KEY_HOME` | 102 | `f19` | `F19` |
| menu | `KEY_COMPOSE` | 127 | `f20` | `F20` |
| app | `KEY_GRAVE` | 41 | `f21` | `F21` |
| volup | `KEY_VOLUMEUP` | 115 | `f22` | `F22` |
| voldown | `KEY_VOLUMEDOWN` | 114 | `f23` | `F23` |
| power | `KEY_POWER` | 116 | `f24` | `F24` |
| mic | `KEY_F5` | 63 | `prog1` | `XF86Tools` |

Every button delivered a clean press **and** release pair (~0.2 s apart), with no autorepeat held
back by the kernel — the engine's tap/hold/repeat discrimination has real edges to work with.

## Consequences for Plan 3

- **Per-device remap is mandatory, not a nicety.** Eleven of the thirteen codes are ordinary
  keyboard keys (arrows, Enter, grave, F5, volume, Power, Home). A global remap or a direct
  `hl.bind("Up", …)` would hijack the user's keyboard; keyd's `[ids] 2717:32b8` section is what keeps
  the remap confined to the remote. Only `KEY_BACK` (158) and arguably `KEY_COMPOSE` (127) are free
  enough on this host to bind directly, which is why the pre-keyd end-to-end smoke test uses `back`.
- **`mic` is a real HID key here** (`KEY_F5`), so the spec's "most ATVV remotes have no HID mic key —
  skipping is normal" prompt does not apply to this model; push-to-talk can be driven by the remote's
  own microphone button. Note that `F5` unremapped is "reload" in browsers — another argument for
  keyd rather than direct binds.
- **`KEY_POWER` passes straight to logind/the compositor while keyd is absent**, so a stray press
  during setup can suspend the host. The learning step should warn before prompting for `power`, and
  the generated keyd conf should be in place before anyone is asked to test that key.
- The generated `/etc/keyd/omaremote.conf` for this remote is therefore:

  ```ini
  [ids]
  2717:32b8

  [main]
  up = f13
  down = f14
  left = f15
  right = f16
  enter = f17
  back = f18
  home = f19
  compose = f20
  grave = f21
  volumeup = f22
  volumedown = f23
  power = f24
  f5 = prog1
  ```

  keyd's own key names are assumed to be the lowercased `KEY_*` stems; `keyd check` must validate the
  file before it replaces anything (spec §7 step 2 already requires this).
- Each logical key needs **two** `hl.bind` lines under Omarchy's Lua config — one for the press and
  one with `{ release = true }` — see the resolution note in
  `docs/superpowers/plans/2026-09-14-omaremote-qml-host-task0.md`.
