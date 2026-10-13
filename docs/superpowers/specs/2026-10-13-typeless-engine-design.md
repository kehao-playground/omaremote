# omaremote — Typeless as an alternative transcription engine

**Date:** 2026-10-13
**Status:** Draft — awaiting user review
**Amends:** `2026-09-14-omaremote-design.md` §3 (adds a host component), §5 (voice session), §6.2 (Voice tab);
`2026-10-12-remote-mic-design.md` §5 (Doctor)

## 1. Goal

Let the user pick the transcription engine: **Voxtype** (today's behaviour, the default) or **Typeless**.
With Typeless, the remote's voice button does exactly one thing: send Typeless's dictation hotkey.
Typeless records, transcribes and pastes on its own. Microphone choice, languages and every other setting live in
Typeless.

Why: Typeless gives better mixed Chinese/English recognition than the CPU-bound Voxtype `base.en` model, it is
much faster on this machine, and the user already pays for it.

Success means:
- With `voice.mic = "remote"`, holding the remote's mic button dictates through Typeless using the
  remote's microphone, and releasing it ends the dictation.
- With `voice.mic = "system"`, one press starts and the next press stops, using whichever microphone
  Typeless has selected.
- Both work with a single-key hotkey (`RightAlt`) and with a chord (`RightAlt+RightShift`).

## 2. Measured facts this design rests on

Measured on 2026-10-13 with Typeless 2.2.0 (Electron 33) on the Mac mini (Omarchy, Hyprland 0.56 Lua config).
The probe was a throwaway stdlib-Python uinput script, since deleted.

1. **Typeless reads raw evdev.** Its keyboard helper (`libKeyboardHelper.so`) opens `/dev/input/event*` and
   watches `/dev/input` with inotify for hotplug. Hotkeys therefore work from any evdev keyboard,
   uinput devices included. `wtype` and Hyprland's `send_key_state` go through Wayland, which Typeless never sees.
2. **Typeless opens full keyboards only.** A uinput device that advertised 9 keys was never opened, and
   taps from it did nothing. With all codes 1–248 advertised, it was opened within 2 s of creation and
   taps worked. So the virtual keyboard must advertise a full key set, and it must exist *before* the
   first tap. A per-tap device is not reliable.
3. **A tap of the dictation hotkey toggles hands-free dictation:** the first tap starts recording and the
   second stops it, then transcribes and pastes. This was confirmed for `RightAlt` and for the chord
   `RightAlt+RightShift` sent as modifiers down → key down/up → modifiers up.
4. `/dev/uinput` is `root:input 0660`. The user is in `input`, which Typeless itself requires, so creating a
   uinput device needs no root.
5. Typeless lists the ATVVoice node as a microphone (label `小米蓝牙语音遥控器`). Audio from it exists only
   while the remote's button is physically held (remote-mic design §2.3).
6. Typeless keeps its settings in `~/.config/Typeless/app-settings.json`:
   - `featureShortcutBindings.dictationMode` holds `["RightAlt"]`, written as `+`-joined evdev-style names;
   - `selectedMicrophoneDevice` is `null` for Auto-detect, otherwise a device id;
   - `microphoneDevices[]` maps ids to labels.

   This is an undocumented internal file. omaremote only reads it, for defaults and Doctor hints, and nothing
   depends on it.

Host prerequisites that are outside this project (recorded in user memory, not automated):
- Typeless is launched with `env -u DISPLAY TYPELESS_SKIP_SECRET_STORE=1 … --ozone-platform=wayland --password-store=basic`.
- Hyprland has the `Status` window rule and the terminal-aware `Ctrl+V` bind.

## 3. Configuration

| field | type | default | meaning |
|---|---|---|---|
| `voice.engine` | `"voxtype" \| "typeless"` | `"voxtype"` | anything else normalizes to `"voxtype"` |
| `voice.typeless.hotkey` | string | `"RightAlt"` | Typeless's notation: `+`-joined names from the allowlist (§4.2), exactly one non-modifier or a single modifier alone; invalid → `"RightAlt"` plus a config warning |

`voice.mic` keeps its meaning and its apply transaction under both engines (§6.1).

## 4. Host component — `omaremote-keytap`

### 4.1 Process

`host/omaremote-keytap` is a single stdlib-only Python 3 file with two modes:

- `omaremote-keytap serve` creates one uinput keyboard named `omaremote keytap` (bus `BUS_VIRTUAL`,
  every key code 1–248 advertised; see §2.2). It then listens on the Unix socket
  `$XDG_RUNTIME_DIR/omaremote-keytap.sock`, mode 0600.
- `omaremote-keytap tap <chord>` connects, sends one request line, and waits at most 2 s for one reply line.
  It exits 0 on `ok`, 2 on a rejected chord, and 3 when the daemon is unreachable or does not answer.

The protocol is one line each way: request `tap <chord>\n` or `ping\n` (sends no key), reply `ok\n` or `err <reason>\n`. Requests are
served one at a time.

A tap presses the modifiers in chord order (30 ms apart), presses and releases the main key (80 ms
hold), then releases the modifiers in reverse order. Every press is released in a `finally` block,
on shutdown (SIGTERM), and before the device is destroyed, so no key is ever left down.

### 4.2 Allowlist

Only these names are accepted (case-insensitive):
- modifiers: `LeftCtrl RightCtrl LeftShift RightShift LeftAlt RightAlt LeftMeta RightMeta`
  (`Super` is accepted as an alias for `Meta`);
- main keys: `A`–`Z`, `0`–`9`, `Space`, `F1`–`F24`.

A chord has at most four names. Anything else is rejected before any event is written. Advertising every
code (§2.2) is about device classification only; the allowlist is what limits what is ever sent.

### 4.3 Installation (`omaremote-setup typeless`)

1. **Prerequisites.**
   - `python3` exists, the user is in `input` (`id -nG`), and `/dev/uinput` is writable.
   - On failure, print the exact `sudo` command (`sudo usermod -aG input $USER`, then log out and back in) and stop.
2. **Install.** Copy the script to `~/.local/lib/omaremote/omaremote-keytap`, so the unit does not depend on
   the checkout's location. Write `~/.config/systemd/user/omaremote-keytap.service`:
   `ExecStart=/usr/bin/python3 -I %h/.local/lib/omaremote/omaremote-keytap serve`, `Restart=on-failure`,
   `WantedBy=graphical-session.target`.
3. **Start.** `daemon-reload`, `enable --now`, and `restart` when the script or unit changed.
4. **Verify.** Within 3 s a `/sys/class/input/event*/device/name` reads `omaremote keytap`, and
   `omaremote-keytap ping` answers.
5. **Hotkey.**
   - `--hotkey X` sets `voice.typeless.hotkey` to X.
   - `--hotkey-from-typeless`, or a first run with no hotkey stored, reads `dictationMode[0]` from Typeless's
     settings. If that is unreadable or not allowlisted, it falls back to `RightAlt` and says so.
   - The write goes through a new IPC method, `typelessHotkey <chord>`, so the Service validates it and writes
     `config.json` atomically. setup never edits `config.json` itself.
6. setup never switches `voice.engine`. The user does that in the panel.

Overrides for tests: `OMAREMOTE_KEYTAP_DIR`, `OMAREMOTE_KEYTAP_UNIT`, `OMAREMOTE_TYPELESS_SETTINGS`,
`OMAREMOTE_UINPUT`.

## 5. Plugin — `lib/TypelessSession.mjs`

### 5.1 Shape

TypelessSession is a pure module with an injected clock, in the same style as VoiceSession. Every
entry point returns a list of effects for the Service to run:
- `{ type: "tap", chord, id }`
- `{ type: "hud", text }`
- `{ type: "state", state }`

Its state is `idle | active`. `active` means "we sent the start tap and owe a stop tap". It exists only in
`remote` mode.

Inputs:
- `streaming(on, now)`, from the ATVVoice `State` signal;
- `hidPress(now)`, from the mic key's press edge;
- `sourceLost(now)`;
- `reset(now)`;
- `leaving(now)`, when the engine or mic mode is about to change;
- `tapResult(id, ok, reason)`;
- `advance(now)`;
- `setConfig(cfg)`.

### 5.2 `remote` mode: hold to talk, stateful

- `streaming(true)` while `idle` → tap, `active`, deadline `maxSessionSec`.
- `streaming(true)` while `active` → nothing.
- `streaming(false)`, `sourceLost`, `reset`, `leaving`, or the `maxSessionSec` deadline while `active`
  → tap, `idle`. The deadline also emits HUD "max session reached".
- `hidPress` → nothing. The RC003's mic key is a press pulse, and audio rides the hold-to-talk stream
  (remote-mic design §4.2).
- A short press makes a ~1 s stream, so Typeless records about 1 s of silence and stops. It is harmless and
  not filtered.

### 5.3 `system` mode: toggle, stateless

- `hidPress` → one tap. Nothing else.
- `streaming`, `reset`, `leaving` and the deadline never tap.

The user's keyboard hotkey and Typeless's own silence or limit stops are invisible to omaremote, so any
recorded state would drift. An automatic tap in this mode could start a recording instead of stopping
one, so there is none.

### 5.4 Failures

- A tap that exits non-zero, or exceeds 2 s, produces HUD "Typeless trigger failed: <reason>". The reasons
  are `keytap not running` (exit 3) and `bad hotkey` (exit 2).
- A failed start tap leaves the session `idle`. A failed stop tap still moves it to `idle`; it never sticks in
  `active`.
- Taps never overlap. A tap requested while one is pending is queued, at most one deep, and a newer
  request replaces the queued one.

### 5.5 Known limitation

In `remote` mode, pressing the hotkey on the keyboard while holding the remote desynchronizes Typeless
from omaremote for one cycle. The next hold restores it.

## 6. Service wiring

### 6.1 Routing

- `voice.engine = "voxtype"`: unchanged. TypelessSession is created but receives no input.
- `voice.engine = "typeless"`:
  - ATVVoice `State` changes, source loss, the mic key's press edge, reset and panic go to TypelessSession.
  - VoiceSession receives none of them. It keeps following `voxtype status`, so F9 dictation and its HUD still
    work.
  - The mic-key release edge is dropped.
- Engine switch from the panel:
  1. `leaving()` on the outgoing side.
  2. Write `voice.engine` atomically (an internal `commit`, not an external reload).
  3. `setConfig()` on both sessions.

  It never restarts Voxtype.
- The Remote/System mic switch runs the existing apply transaction (Voxtype `audio.device` and restart)
  under both engines. TypelessSession gets `leaving()` before the transaction starts.

  One code path keeps Voxtype and F9 consistent with `voice.mic`, so switching back to Voxtype needs no
  resync. The cost is a Voxtype restart that the Typeless engine does not need.
- Tap effects run `python3 -I ~/.local/lib/omaremote/omaremote-keytap tap <chord>` through the existing
  command runner, which reports exit codes back to `tapResult`.

### 6.2 Presentation

- `remote` + `active`: the bar and HUD show recording with elapsed time, labelled "Typeless".
- `system`: each tap flashes "Typeless ⏯". Typeless's own Status bar shows the real state.
- Typeless taps are not counted in Voxtype session stats.

## 7. Panel (Voice tab)

- New first row: `Engine: [Voxtype] [Typeless]`, reachable by cursor and click.
- Under Typeless, a read-only line: `hotkey: <chord> · keytap: running|not running`. The panel has no
  text input, so the hotkey is edited with `omaremote-setup typeless --hotkey …`.
- Under Typeless, the mic row gains the hint "also select the matching microphone in Typeless".

## 8. Doctor

These rows appear only when `voice.engine = "typeless"`. `host/omaremote-facts` gains a `typeless` object.

| row | pass | otherwise |
|---|---|---|
| keytap service | unit `active` and the `omaremote keytap` input device present | fail · fix `omaremote-setup typeless` |
| uinput access | user in `input` and `/dev/uinput` writable | fail · print the `usermod` command |
| Typeless running | a `/opt/Typeless/typeless` main process | warn · "start Typeless" |
| hotkey matches | `voice.typeless.hotkey` equals `dictationMode[0]` | warn · fix `omaremote-setup typeless --hotkey-from-typeless`; `unknown` when the file is unreadable |
| microphone matches mode | `remote`: Typeless's selected device label equals the remote's name. `system`: it does not | warn with both values; `unknown` when unreadable |

The Voxtype rows that `remote` mode makes mandatory become informational under Typeless, except the ATVVoice rows,
which `remote` mode still needs.

## 9. Testing

- **Unit (node):**
  - `TypelessSession.test.mjs` covers §5.2–§5.4 with a fake clock. It must include a *discriminating* test that
    `system` mode emits no tap on `reset`, `leaving` or the deadline, with an `active`-looking history first.
  - Config normalization of `engine` and `hotkey`.
  - The Doctor rows.
  - The Presentation strings.
  - Service routing as pure functions, if extracted.
- **keytap (python unittest, stdlib):**
  - chord parsing and the allowlist;
  - the event order, using an injected writer instead of `/dev/uinput`;
  - all keys released when a write raises mid-chord;
  - the socket protocol (`tap`, `ping`, the error replies, the 2 s client timeout) against a temporary socket path.
- **Integration:** `tests/setup-typeless.sh` drives setup with fake `systemctl`, `id` and IPC, a fixture
  `app-settings.json`, and a fake uinput path. It never touches the real systemd, Typeless or `~/.config/omaremote`.
- **`make check`** runs all of the above.
- **Hardware acceptance (user present):**
  1. `remote`: hold and speak, then release, with Typeless set to the remote mic. Text is pasted.
  2. `system`: press, speak, press, with C922 or Auto-detect. Text is pasted.
  3. Repeat with the hotkey set to `RightAlt+RightShift`.
  4. Reset while holding in `remote` mode. Typeless stops.
  5. Stop `omaremote-keytap` and press. The HUD shows "keytap not running". Restart it, and it works again.

## 10. Out of scope

- Detecting Typeless's real recording state. There is no API, and scraping its window or logs is fragile.
- Holding the hotkey down for the hold duration. Taps were chosen so a missed release can never leave a
  modifier stuck.
- Editing Typeless's settings: microphone, hotkey, launch flags.
- The microphone source picker. It is a separate sub-project and applies to Voxtype only.
