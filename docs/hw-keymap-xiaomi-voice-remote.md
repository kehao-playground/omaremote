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

| logical | physical button | remote emits | code | keyd neutral | Hyprland keysym |
|---|---|---|---|---|---|
| up | D-pad up | `KEY_UP` | 103 | `f13` | `F13` |
| down | D-pad down | `KEY_DOWN` | 108 | `f14` | `F14` |
| left | D-pad left | `KEY_LEFT` | 105 | `f15` | `F15` |
| right | D-pad right | `KEY_RIGHT` | 106 | `f16` | `F16` |
| ok | D-pad centre | `KEY_ENTER` | 28 | `f17` | `F17` |
| back | back arrow | `KEY_BACK` | 158 | `f18` | `F18` |
| home | house icon | `KEY_HOME` | 102 | `f19` | `F19` |
| menu | hamburger / three lines | `KEY_COMPOSE` | 127 | `f20` | `F20` |
| app | **TV icon** | `KEY_GRAVE` | 41 | `f21` | `F21` |
| volup | volume up | `KEY_VOLUMEUP` | 115 | `f22` | `F22` |
| voldown | volume down | `KEY_VOLUMEDOWN` | 114 | `f23` | `F23` |
| power | power symbol | `KEY_POWER` | 116 | `f24` | `F24` |
| mic | microphone icon | `KEY_F5` | 63 | `xfer` | `XF86Xfer` |

The **twelve non-mic buttons** each delivered a clean press **and** release pair (~0.11--0.19 s
apart), with no autorepeat held back by the kernel — the engine's tap/hold/repeat discrimination has
real edges to work with. A full in-order sweep under `keyd monitor -t` on 2026-10-08 reproduced all
twelve, in the table's order, with the codes above.

**`mic` is the exception and cannot be held.** Its press and release arrive in the *same
millisecond* -- measured independently at two layers: a raw read of `/dev/input/event13` showed down
and up at an identical timestamp, and `keyd monitor -t` shows `down` followed by `up` at `+0 ms`.
This is the remote's firmware emitting a *pulse*, not a press-and-hold, and it is not a defect
anywhere in our stack. The consequence is hard: **`ptt: true` can never work on this button**,
because `hidPress` and `hidRelease` are indistinguishable in time. Hold-to-talk on the remote's own
mic button is physically impossible on this model.

## Consequences for Plan 3

- **Per-device remap is mandatory, not a nicety.** Eleven of the thirteen codes are ordinary
  keyboard keys (arrows, Enter, grave, F5, volume, Power, Home). A global remap or a direct
  `hl.bind("Up", …)` would hijack the user's keyboard; keyd's `[ids] 2717:32b8` section is what keeps
  the remap confined to the remote. Only `KEY_BACK` (158) and arguably `KEY_COMPOSE` (127) are free
  enough on this host to bind directly, which is why the pre-keyd end-to-end smoke test uses `back`.
- **`mic` is a real HID key here, but push-to-talk on it is impossible.** ~~push-to-talk can be
  driven by the remote's own microphone button~~ — **WITHDRAWN 2026-10-08.** The button emits a
  zero-duration pulse (see above), so there is no hold interval to gate recording with. The spec's
  "most ATVV remotes have no HID mic key — skipping is normal" prompt does not apply for the reason
  given (the key exists), but its *conclusion* does: this button cannot drive PTT. A toggle
  (press to start, press again to stop) is the only interaction a pulse can support.
  Note that `F5` unremapped is "reload" in browsers — another argument for keyd rather than
  direct binds.
- **RESOLVED 2026-10-08: keyd aliases `prog1` to `KEY_F21`, so `mic` emitted `app`'s code.**
  The remote is blameless. An unfiltered read of `/dev/input/event13` shows mic sending `KEY_F5`
  (63, HID scancode `0x7003E`) and app sending `KEY_GRAVE` (41, `0x70035`) — two distinct codes.
  But **keyd's key-name table is not Linux's**: measured by reading keyd's own virtual keyboard,
  the output name `prog1` emits `KEY_F21` (191) and `prog2` emits `KEY_F22` (192), so
  `prog1`–`prog4` alias `f21`–`f24` rather than the `KEY_PROG1` (148) of `input-event-codes.h`.
  With `f5 = prog1`, pressing mic emitted exactly `app`'s code: `omaremote:app` fired and
  `omaremote:mic` never could. `keyd check` passes on that config and reports nothing.

  Why it survived two days of checking: every test above keyd used the *Linux* code. Injecting
  `prog1` through uinput sends 148 → `XF86Launch1` → the bind fires, which looks like proof but
  exercises a code the real system never emits. And `keyd monitor` prints keyd's **names**, so its
  output read as a plausible `f21` collision rather than as the alias it was.

  Fixed by making the 13th neutral key `xfer` (measured emitting its own Linux code 147 = `<I155>`
  → `XF86Xfer`, outside the F13–F24 range, with no application meaning). `tests/Config.test.mjs`
  pins the name and keysym and rejects `prog1`–`prog4` outright. `tests/inject-key.py
  --vendor/--product` makes keyd's own remapping testable: claiming the remote's `vendor:product`
  gets the virtual device grabbed, so no human has to press buttons.
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
  f5 = xfer
  ```

  keyd's own key names are assumed to be the lowercased `KEY_*` stems; `keyd check` must validate the
  file before it replaces anything (spec §7 step 2 already requires this).
- **WITHDRAWN 2026-10-07, same day: the matrix below answers a question that decides nothing.**
  A self-test lease suppresses KeyEngine entirely (`Service.qml:242`,
  `if (selftest && selftest.active()) return   // no real actions under a lease`), so during every
  cell of every sweep **no action was dispatched**. Both edges always arrive under those conditions,
  for either bind count. In real operation a `hold` or `repeat` action runs `wtype` *while the key is
  still down*, and that is what loses the release edge — see the next bullet. The matrix is kept
  because its numbers are correct and its method is reusable, but it did not and cannot settle the
  bind count.

- **Superseded measurement: ONE bind per key (valid only with no action dispatched).**
  `tests/bind-matrix.sh`, with keyd
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
  duplication, nothing left held. Two binds duplicate the release at every duration. **Both
  statements hold only while nothing is dispatched during the press**, which is the only condition a
  self-test lease can produce.

  **The 2026-10-02 round was right and I argued it down wrongly.** I claimed it did not generalise
  for three reasons — a different key, hand-timed presses, and a modifier artifact. Each was true;
  none was the reason. It reported a release lost on a long press because it was pressing a key whose
  hold action ran, and this sweep never runs one.

  **This measurement was impossible until an xkb option was added — and the first attempt silently
  measured nothing.** See below; 12 of 12 cells came back `down=0, up=0`, which is not what a lost
  release edge looks like.

- **`wtype` destroys the release edge of the key that triggered it (2026-10-07).** This is the real
  finding, and it is a product defect rather than a configuration choice. Four tests on the live
  host, one variable changed at a time, `back`/F18 held 2000 ms:

  | `back.hold` action | binds | release edge |
  |---|---|---|
  | `{"type":"none"}` | one | **arrives** — `heldKeys` empty, `stuckKeyCount` flat |
  | `{"type":"key","keys":"BackSpace"}` (`wtype`) | one | **lost** — `heldKeys: ["back"]`, stuck fires |
  | `{"type":"key","keys":"BackSpace"}` (`wtype`) | **two** | **lost** — bind count is irrelevant |
  | `{"type":"dispatch", ...}` (Hyprland-native) | one | **arrives** |

  A physical long press on the real remote reproduces the `wtype` case. `keyd monitor` shows keyd
  emitting both edges (`f18 down`, then `f18 up` 1700 ms later), so the loss happens above keyd,
  when `wtype`'s virtual keyboard appears while the triggering key is still held.

  **This also explains the 2026-10-02 `up` runaway** that motivated the stuck-key bound: `up` is
  `repeat: true`, so its repeat action dispatches `wtype` during the press, killing the release, and
  the key repeats until something stops it. Tap actions are unaffected — a tap fires *on* release,
  after the edge has been processed.

  The indicated fix is to stop injecting keys with `wtype` and use the compositor's own key
  injection instead; Omarchy's bindings use `hl.dsp.send_key_state({ mods, key, state })`, which
  needs a `down` and an `up` dispatch per keystroke. That is an engine change (`lib/Actions.mjs`
  returns `{kind:"process", argv:["wtype", …]}` today) and a spec change (the main spec names
  `wtype` throughout), so it is not folded in here.

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
