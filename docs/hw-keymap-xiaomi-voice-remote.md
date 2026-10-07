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
keysym a Hyprland bind uses. The `F13`–`F24` column holds **only** with the xkb option
`fkeys:basic_13-24` applied; without it those keycodes produce `XF86Tools` / `XF86Launch5-9` /
`XF86AudioMicMute` / `XF86Touchpad*` instead. See the consequences section.

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
| mic | `KEY_F5` | 63 | `prog1` | `XF86Launch1` |

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
- **Settled 2026-10-07 by measurement: ONE bind per key.** `tests/bind-matrix.sh`, with keyd
  installed, the real neutral keys, and durations driven by `tests/inject-key.py` (measured accurate
  to under 1 ms). `up`/F13 is a `repeat: true` key, exercising the engine's `repeating` phase;
  `back`/F18 is a long non-repeat key, exercising `held`.

  | config | key | duration | down | up | lost | duplicated | held |
  |---|---|---|---|---|---|---|---|
  | one | up | 120ms | 1 | 1 | - | - | - |
  | one | up | 600ms | 1 | 1 | - | - | - |
  | one | up | 3000ms | 1 | 1 | - | - | - |
  | one | back | 120ms | 1 | 1 | - | - | - |
  | one | back | 600ms | 1 | 1 | - | - | - |
  | one | back | 3000ms | 1 | 1 | - | - | - |
  | two | up | 120ms | 1 | 2 | - | up x2 | - |
  | two | up | 600ms | 1 | 2 | - | up x2 | - |
  | two | up | 3000ms | 1 | 2 | - | up x2 | - |
  | two | back | 120ms | 1 | 2 | - | up x2 | - |
  | two | back | 600ms | 1 | 2 | - | up x2 | - |
  | two | back | 3000ms | 1 | 2 | - | up x2 | - |

  A single `hl.bind` delivers both edges at every duration on both key classes — no loss, no
  duplication, nothing left held. Two binds duplicate the release at every duration. So main spec §3
  was **right**: `hl.dsp.global` does request the release event itself, and the plan's own premise
  that live measurement had disproved it was mistaken.

  **Why the 2026-10-02 round concluded the opposite.** That round measured `XF86Back` — the remote's
  native `KEY_BACK` — by hand, because 11 of the 13 native codes collided with the keyboard, and it
  reported a release lost on a long press. It does not reproduce here at 3000 ms. The honest summary
  is that the earlier result came from a hand-timed press on a different key and a different code
  path, and should not have been promoted to a claim about the bind layer. This round controls the
  duration to under a millisecond and reads raw edge counts out of the self-test lease.

  **This measurement was impossible until an xkb option was added — and the first attempt silently
  measured nothing.** See the next bullet; 12 of 12 cells came back `down=0, up=0`, which is not
  what a lost release edge looks like.

- **`hl.bind("F13", …)` cannot match without `fkeys:basic_13-24`.** `/usr/share/X11/xkb/symbols/pc`
  never maps `<FK13>`–`<FK24>`. The default `inet(evdev)` keymap does, and hands them out as:

  | keyd neutral | keysym without the option |
  |---|---|
  | `f13` | `XF86Tools` |
  | `f14`–`f18` | `XF86Launch5`–`XF86Launch9` |
  | `f19` | `F19` |
  | `f20` | `XF86AudioMicMute` |
  | `f21`–`f23` | `XF86TouchpadToggle` / `XF86TouchpadOn` / `XF86TouchpadOff` |
  | `f24` | `F24` |

  Only `F19` and `F24` keep their own names. So every bind this project generates was unmatchable
  except `home` and `power`. The fix is the xkb option `fkeys:basic_13-24`
  (`/usr/share/X11/xkb/rules/evdev`), which maps `<FK13>`–`<FK24>` to `F13`–`F24` — exactly what
  `lib/Defaults.mjs NEUTRAL_KEYS` already declares, so no key table changes. `kb_options` **replaces
  rather than appends**, so Omarchy's own `compose:caps,shift:both_capslock_cancel` must be repeated
  alongside it. `hyprctl keyword input:kb_options` cannot set it — "keyword can't work with
  non-legacy parsers" — so it has to live in `~/.config/hypr/input.lua`.

  Binding the actual `XF86*` keysyms instead was rejected: it needs no keymap change, but it binds
  semantically real keys (mic mute, touchpad toggle), and it is outright broken for this key set
  because `f13` yields `XF86Tools` and `mic`/`prog1` was *recorded* as `XF86Tools` too — see below.

- **`mic` is `XF86Launch1`, not `XF86Tools` (corrected 2026-10-07).** `KEY_PROG1` is `<I156>`, which
  `symbols/inet` maps to `XF86Launch1`. The table below said `XF86Tools`, which is what `<FK13>`
  produces — so before this was corrected, `up` and `mic` resolved to the same keysym and one of them
  could never have fired. Verified by injecting `prog1` against binds on both names: `XF86Launch1`
  fired. `tests/Config.test.mjs` now asserts all 13 keysyms are distinct, which is the assertion that
  would have caught the collision.
- **End-to-end verified pre-keyd:** remote button → libinput/xkb → Hyprland bind → `GlobalShortcut`
  → engine → action, with `back:tap:Escape` and `back:hold:BackSpace` observed from the remote's own
  Back button on 2026-10-02.
