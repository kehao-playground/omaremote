# omaremote — Typeless as an alternative transcription engine

**Date:** 2026-10-13
**Status:** Draft rev 3 — second review addressed; awaiting user review
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
| `voice.typeless.hotkey` | string | `"RightAlt"` | a chord in Typeless's notation (§3.1), stored canonical; an invalid stored value normalizes to `"RightAlt"` plus a config warning |

`voice.mic` keeps its meaning and its apply transaction under both engines (§6.2).

### 3.1 Chord grammar

A chord is 1–4 `+`-joined names from the allowlist (§4.2). The same parser exists in JS (`lib/Chord.mjs`)
and in `omaremote-keytap`, and both are tested against one shared fixture table
(`tests/fixtures/chords.json`).

- Names match case-insensitively. Aliases canonicalize: `Super`/`Win`/`Meta` with a `Left`/`Right` prefix
  becomes `LeftMeta`/`RightMeta`, and `Control` becomes `Ctrl`. The canonical form uses the allowlist's spelling,
  for example `rightalt+rightshift` becomes `RightAlt+RightShift`.
- Each name appears once. Duplicates after canonicalization are rejected, for example `RightAlt+rightalt`.
- **Two shapes:**
  - **modifiers + one main key:** any number of modifiers and exactly one main key. The canonical form puts
    the modifiers in their written order and the main key last. Two main keys are rejected.
  - **modifiers only:** 1–4 modifiers, kept in written order. The last one is the *trigger*. Typeless records
    these as written; `RightAlt+RightShift` was measured in that order.
- The trigger is the main key, or the last modifier in a modifiers-only chord. A tap presses every other name in
  order (30 ms apart), presses and releases the trigger (80 ms hold), then releases the others in reverse order.
  A single-name chord is a plain press and release.
- Anything else is invalid: an empty name, more than four names, or a name outside the allowlist.

Comparisons (Doctor §8, setup §4.3) are between canonical forms. A Typeless value that does not parse is
reported as `unknown`, not as a mismatch.

## 4. Host component — `omaremote-keytap`

### 4.1 Process

`host/omaremote-keytap` is a single stdlib-only Python 3 file with three commands.

- **`omaremote-keytap serve`**
  - Creates one uinput keyboard named `omaremote keytap` (bus `BUS_VIRTUAL`, every key code 1–248 advertised,
    see §2.2).
  - Listens on the Unix socket `$XDG_RUNTIME_DIR/omaremote-keytap.sock`, mode 0600. It replaces a stale socket
    file at startup.
- **`omaremote-keytap tap <chord>`:** sends one tap request.
- **`omaremote-keytap ping`:** sends one ping request.

**Protocol.** Each connection carries one request line and gets one reply line.

| request | reply | meaning |
|---|---|---|
| `tap <chord>\n` | `ok\n` | every event was written |
| | `err reject <reason>\n` | parse failure; nothing was written |
| | `err write <reason>\n` | a uinput write failed after the first event; the keys were released, and whether Typeless saw a tap is unknown |
| `ping\n` | `ok\n` | no key is sent |
| anything else | `err reject …` | |

The daemon serves one connection at a time:
- Each connection has a 500 ms read deadline and a 128-byte request limit. A client that sends no newline in
  time, or too much, gets `err reject` and is closed.
- A stuck client therefore delays the next request by at most 500 ms.
- A tap takes ≤ 400 ms.

Every pressed key is released in a `finally` block, on SIGTERM, and before the device is destroyed. No key is
ever left down.

**Client exit codes.** These are what TypelessSession sees as `tapResult` outcomes (§5.1):

| code | condition | tap happened? |
|---|---|---|
| 0 | `ok` | yes |
| 2 | `err reject` | no |
| 3 | connect failed (no socket, or refused) | no |
| 4 | `err write` | unknown |
| 5 | connected and sent, but no reply within 1.5 s, or the connection broke | unknown |

The Service's command runner kills a client still running at 2 s. A kill is also "unknown".

### 4.2 Allowlist

Only these names are accepted:
- modifiers: `LeftCtrl RightCtrl LeftShift RightShift LeftAlt RightAlt LeftMeta RightMeta`;
- main keys: `A`–`Z`, `0`–`9`, `Space`, `F1`–`F24`.

Anything else is rejected before any event is written. Advertising every code (§2.2) is about device
classification only. The allowlist is what limits what is ever sent.

### 4.3 Installation (`omaremote-setup typeless`)

1. **Prerequisites.**
   - `python3` exists, the user is in `input` (`id -nG`), and `/dev/uinput` is writable.
   - On failure, print the exact `sudo` command (`sudo usermod -aG input $USER`, then log out and back in) and exit 1.
2. **Install.** Copy the script to `~/.local/lib/omaremote/omaremote-keytap`, so the unit does not depend on
   the checkout's location. Write `~/.config/systemd/user/omaremote-keytap.service`:
   - `ExecStart=/usr/bin/python3 -I %h/.local/lib/omaremote/omaremote-keytap serve`
   - `Restart=on-failure`
   - `WantedBy=graphical-session.target`
3. **Start.** `daemon-reload` and `enable --now`, plus `restart` when the script or unit changed.
4. **Verify.** Within 3 s:
   - a `/sys/class/input/event*/device/name` reads `omaremote keytap`;
   - `omaremote-keytap ping` exits 0.

   Otherwise exit 1 and print the unit's last journal lines.
5. **Hotkey.** This step runs only after steps 1–4 succeed, so a failure here leaves a working keytap.
   - **Choose the value.**
     - `--hotkey X` uses X.
     - `--hotkey-from-typeless` uses Typeless's `dictationMode[0]`.
     - With neither flag, and only when `status` reports `typeless.hotkeyStored: false`, it uses Typeless's value.
       `hotkeyStored` is computed from the **raw** config (the field is present), because the normalized config
       always holds a default.
     - An unreadable or invalid Typeless value falls back to `RightAlt`, and setup says so.
     - Otherwise the stored value is kept and nothing is written.
   - **Write it** through the IPC method `typelessHotkey <chord>`. The reply is JSON:
     - `{"ok":true,"hotkey":"<canonical>","writeSeq":N|null}`: the Service validated the value and applied it in
       memory. `writeSeq` is the write whose completion proves persistence. `null` means it is already on disk
       and there is nothing to wait for.
     - `{"ok":false,"reason":"invalid chord: …"}`: an invalid chord is **rejected**, never replaced by a default,
       and nothing is written.
     - `{"ok":false,"reason":"config.json is invalid"}`: the existing guard in `ConfigStore._write`.
   - **Confirm persistence.** This needs serialized writes in ConfigStore (below). setup polls `status` until
     `config.saves[N]` is `saved` or `failed`, for up to 2 s.
     - On `saved` it re-reads `config.json` from disk with `jq`, read-only, as a sanity check, and compares
       canonical values.
     - `failed`, the timeout, or a mismatch exits 1 with the reason.
   - **No Service.** Every setup IPC call runs as `timeout 3 omarchy-shell omaremote …`; the `ipc()` wrapper
     gains this explicit deadline. A non-zero exit or an empty answer exits 1 with "the omaremote service is
     not running; start the shell, then re-run `omaremote-setup typeless --hotkey …`". Each poll is one such
     call, and the 2 s budget is checked between polls. Worst case is therefore 2 s plus one call.

   **Serialized ConfigStore writes.** These are needed because FileView's `saved`/`saveFailed` signals carry no
   identity.
   - Each `_write` gets the next `seq`. At most one `setText` is in flight.
   - A write requested while one is in flight becomes the single queued write. A newer request replaces the
     queued raw but keeps every seq it covers.
   - When the in-flight write finishes, its signal resolves exactly the seqs that write carried, as `saved` or
     `failed`. Then the queued write, if any, starts.
   - `status` exposes the last 16 outcomes as `config.saves` (`seq → saved|failed|pending`), plus the reason
     for a failure.
   - For `typelessHotkey` when the value is already equal in memory:
     - the write that last carried it is still pending → return that pending seq;
     - that write failed → issue a new write and return its seq;
     - otherwise (saved, or loaded from disk) → `writeSeq: null`.
   - External reloads are unaffected. The echo check (`_lastWritten`) compares against the text of the write in
     flight.
6. setup never switches `voice.engine`. The user does that in the panel.

Overrides for tests: `OMAREMOTE_KEYTAP_DIR`, `OMAREMOTE_KEYTAP_UNIT`, `OMAREMOTE_TYPELESS_SETTINGS`,
`OMAREMOTE_UINPUT`.

## 5. Plugin — `lib/TypelessSession.mjs`

### 5.1 Shape

TypelessSession is a pure module with an injected clock, in the same style as VoiceSession. Entry points
return effects:
- `{ type: "tap", chord, id }`
- `{ type: "hud", text }`
- `{ type: "state", state }`

**Inputs:**
- `streaming(on, now)`
- `hidPress(now)`
- `sourceLost(now)`
- `reset(now)`
- `quiesce(now)` and `resume(now)` (§6.2)
- `tapResult(id, outcome, reason, now)`, where `outcome` is `sent`, `notSent` or `unknown` (§4.1 exit codes)
- `advance(now)`
- `setConfig(cfg, now)`

**Single flight.** At most one tap is outstanding.
- Every tap gets a fresh monotonically increasing `id`.
- The outstanding tap is **never abandoned**. Reset, quiesce, a switch timeout and `unsynced` all leave it in
  place, and its result is always delivered and honoured. The command runner guarantees the result within
  2 s (§6.1).
- No other tap is sent until it resolves.
- A `tapResult` is *stale*, and ignored, only when its id is not the outstanding one. That happens for a
  duplicate report of an already-resolved id, or an id the session never issued.
- Taps are never merged or replaced. Each one is a toggle edge.

**Chord capture.** A session records the chord it started with. Its stop tap uses that chord even if
`voice.typeless.hotkey` changed in between.

### 5.2 `remote` mode: hold to talk, by reconciliation

Instead of a per-event transition table, `remote` mode keeps a few facts and reconciles them after every input
and every tap result.

**Facts:**
- `typeless`: `off`, `on` or `unsynced`. This is what omaremote believes Typeless is doing.
- `streaming`: the latest ATVVoice streaming value, updated in **every** state, including while a tap is
  outstanding.
- `needRelease`: set by `reset`, the `maxSessionSec` deadline, `quiesce`, `sourceLost`, or a failed start. It is
  cleared only by observing `streaming = false`. This is what keeps one physical hold from restarting after
  being ended.
- `outstanding`: the id and kind (`start`/`stop`) of the single tap in flight, or none.

**desired** = `streaming && !needRelease && !quiesced`.

**Reconcile.** It runs when there is no `outstanding` and `typeless ≠ unsynced`:
- `typeless = off` and `desired` → send a start tap with the current hotkey, captured as the session chord. The
  deadline begins.
- `typeless = on` and `!desired` → send a stop tap with the captured chord. The deadline also adds HUD "max
  session reached".
- Otherwise nothing.

**Tap results** (for the outstanding id only, §5.1):

| kind | outcome | effect, then reconcile |
|---|---|---|
| start | sent | `typeless = on` |
| start | notSent | `typeless` stays `off`, `needRelease = true`, HUD "Typeless trigger failed: <reason>" (no retry within this hold) |
| start/stop | unknown | `typeless = unsynced`, HUD "Typeless state unknown — check Typeless; press reset when it is stopped" |
| stop | sent | `typeless = off` |
| stop | notSent | `typeless = unsynced`. Typeless is certainly still recording, and a retry would hit the same failure. Same HUD. |

**`unsynced`** sends nothing.
- `streaming on` only repeats the HUD.
- `reset` sets `typeless = off` and `needRelease = true`. It does not tap.
- An outstanding tap is still awaited, and its result is recorded but not acted on.

**Worked interleavings** (each is a required test, §9):
- *release during start, re-press before the result:* starting → off → on → start `sent`. `desired` is true
  again, so the session stays `on` and nothing is sent. The second hold continues the same Typeless recording.
- *release during start:* start `sent`, `desired` false → stop.
- *start `notSent`:* nothing more is sent, so a stop never follows a start that did not happen.
- *re-press during stop:* stop `sent`, `desired` true → start.
- *reset or deadline mid-hold:* stop. The still-held button does not restart because of `needRelease`. The next
  hold starts normally.

`hidPress` does nothing in `remote` mode (remote-mic design §4.2). A short press makes a ~1 s stream:
Typeless records about 1 s of silence and stops. This is harmless and not filtered.

### 5.3 `system` mode: toggle, no recorded Typeless state

- **`hidPress`:** appends one tap to a FIFO. The FIFO holds at most 4 presses, **counting the outstanding
  one**. A fifth press while four are held is dropped with HUD "too fast — press ignored". Presses are sent one
  at a time, in order, each with its own `id`.
- **`notSent` or `unknown` result:** clears the FIFO and shows HUD "Typeless trigger failed; check Typeless
  before pressing again". The remaining presses would otherwise invert the user's intent.
- **`reset` and `quiesce`:** clear the FIFO and send nothing. The outstanding tap, if any, finishes, and its
  result is honoured.
- **`streaming`, `sourceLost` and deadlines:** never tap in this mode.

The user's keyboard hotkey and Typeless's own silence or limit stops are invisible to omaremote. So this mode
keeps no recording state, and nothing in it taps on its own.

### 5.4 Known limitation: desynchronization is not self-healing

Some events toggle Typeless without omaremote seeing them:
- the user presses the hotkey on the keyboard;
- Typeless stops by itself (silence or its length limit);
- a tap whose outcome was unknown went through.

After any of these, Typeless and omaremote stay inverted in `remote` mode. Each later hold sends two taps, so
the inversion persists. Example: remote start, keyboard stop, release (this tap starts Typeless). omaremote
promises no automatic recovery. To recover, the user stops Typeless by hand, then presses reset if omaremote shows
`unsynced`, and starts the next remote session from there. The README states this.

## 6. Service wiring

### 6.1 Routing

- **`voice.engine = "voxtype"`:** unchanged. TypelessSession exists but receives no input.
- **`voice.engine = "typeless"`:**
  - ATVVoice `State` changes, source loss, the mic key's press edge, reset and panic go to TypelessSession.
  - VoiceSession receives none of them. It keeps following `voxtype status`, so F9 dictation and its HUD still work.
  - The mic key's release edge is dropped.
- **Tap effects** run `python3 -I ~/.local/lib/omaremote/omaremote-keytap tap <chord>` through the existing
  command runner, with a 2 s kill. The exit code maps to `sent`/`notSent`/`unknown` per §4.1.

### 6.2 Lifecycle: draining both engines

**TypelessSession**
- `quiesce()` sets `needRelease` and `quiesced`, so `desired` becomes false, and in `remote` mode reconcile sends
  the stop. It clears the `system` FIFO except the outstanding press.
- While quiesced, `streaming on` and `hidPress` only show HUD "dictation paused: <reason>".
- It is **settled** when there is no outstanding tap and `typeless` is `off` or `unsynced`.
- `resume()` clears `quiesced`. `needRelease` still requires a release before the next hold.

**VoiceSession** gains `drain(now)` and `undrain()`:
- `drain` refuses new *plugin-owned* starts (D-Bus and HID). It sends `voxtype record stop` for a plugin-owned
  session that is recording; stop, not cancel, so the dictation's text is kept.
- It is **drained** when no plugin-owned session is `starting` or `recording` and no start/stop command is
  pending. `transcribing` counts as drained: the audio is complete.
- A *keyboard-owned* session (F9, adopted from `voxtype status`) is never stopped and never blocks drained.
  Omarchy's F9 bind still delivers its release, so it ends normally under either engine.
- If not drained within 3 s, `drain` falls back to the existing `abort()`, which cancels that plugin-owned
  session.

**Engine switch (panel)**, in either direction:
1. Drain both sessions: `quiesce()` on TypelessSession and `drain()` on VoiceSession, each with its own bound.
   - VoiceSession: 3 s, then abort.
   - TypelessSession: 3 s. On expiry it is forced to `unsynced`, but its outstanding tap stays outstanding. It
     still resolves within the runner's 2 s kill, and no further tap can be issued until it does (§5.1). The
     HUD says "Typeless may still be recording".
2. Commit `voice.engine` (an internal `commit`).
3. `setConfig()` on both sessions.
4. `resume()` and `undrain()`.

Inputs that arrive during steps 1–3 reach neither engine as a start. Both refuse them, and the HUD shows
"switching engine". A switch never restarts Voxtype.

**Mic apply transaction** (the existing `MicApply`):
- Under the Typeless engine, step 1 ("wait without mutation") also quiesces TypelessSession and waits until it
  is settled, within the same 60 s budget.
- The session stays quiesced through apply, verify and rollback, and resumes after the terminal outcome,
  whether succeeded or failed.
- Rollback never taps, because the session is already settled.
- Under the Voxtype engine, MicApply is unchanged. Its existing gate already covers VoiceSession.

**External config reload** (`changed("external")`):
- If `voice.engine`, `voice.mic` or `voice.typeless.hotkey` changed:
  1. Drain as in a switch, with the old config still in both sessions, so a stop uses the captured chord
     (§5.1).
  2. Then `setConfig()`, `resume()` and `undrain()`.
- Any other reload keeps today's behaviour.

**Hotkey changed through IPC while a session runs:** `setConfig()` only. The running session keeps its
captured chord for the stop. The next session uses the new chord.

**Reset and panic:** VoiceSession keeps today's `abort()`. TypelessSession gets `reset()` (§5.2/§5.3). Neither
is a drain. A new hold after a release may start at once.

**Shell exit** (`Component.onDestruction`):
- Only when TypelessSession is in `remote` mode, `typeless = on` and **nothing is outstanding**: spawn one
  detached stop tap with the captured chord.
- In any other state (a start or stop outstanding, or `unsynced`) nothing is sent. A stop after an unconfirmed
  start could itself start a recording.
- This, like a killed shell, can leave Typeless recording. The README tells the user to check Typeless after
  restarting the shell.

### 6.3 Presentation

- `remote` + `active`: the bar and HUD show recording with elapsed time, labelled "Typeless".
- `remote` + `unsynced`: the bar shows a warning state, and the HUD shows the §5.2 text until reset.
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
| hotkey matches | canonical `voice.typeless.hotkey` equals canonical `dictationMode[0]` (§3.1) | warn · fix `omaremote-setup typeless --hotkey-from-typeless`; `unknown` when the file is unreadable |
| microphone matches mode | `remote`: Typeless's selected device label equals the remote's name. `system`: it does not | warn with both values; `unknown` when unreadable |

The Voxtype rows that `remote` mode makes mandatory become informational under Typeless, except the ATVVoice rows,
which `remote` mode still needs.

## 9. Testing

- **Unit (node):**
  - `Chord.test.mjs` runs the shared table `tests/fixtures/chords.json`, with each input mapped to its canonical
    form or to its rejection reason. The table covers:
    - case and aliases;
    - duplicates;
    - two main keys;
    - modifiers-only order;
    - more than four names;
    - an empty name.
  - `TypelessSession.test.mjs` uses a fake clock and covers §5.2's reconcile rules and result table plus §5.3.
    It must include these interleavings:
    - every worked interleaving in §5.2;
    - streaming off during start, then start `unknown` → `unsynced`, and no stop is ever emitted;
    - reset while `starting`: the start result is still honoured, and if `sent`, one stop follows;
    - re-press during stop, then stop `notSent` → `unsynced`, and no start;
    - stale results: a duplicate report for a resolved id, and a never-issued id, are both ignored;
    - in system mode, five rapid presses (one outstanding plus three queued are sent, the fifth is dropped);
    - in system mode, a mid-FIFO `unknown` that clears the rest;
    - a hotkey change while `on`, where the stop uses the captured chord;
    - quiesce while `starting`, then settled, then resume, then a re-press only after a release;
    - a switch timeout while a tap is outstanding: no second tap until it resolves;
    - shell exit sending a stop only for `on` with nothing outstanding;
    - system mode never tapping on reset, quiesce or a deadline, after a history that looks active
      (discriminating);
    - the `unsynced` exit only through reset.
  - `VoiceSession.test.mjs` adds drain cases:
    - a plugin-owned recording gets `record stop` and is drained at `transcribing`;
    - a keyboard-owned session is untouched and does not block;
    - 3 s without draining falls back to abort;
    - new plugin starts are refused while draining.
  - ConfigStore write serialization, as a pure helper:
    - two writes in flight resolve their own seqs;
    - a queued write coalesces and carries both seqs;
    - a failure marks exactly its seqs;
    - the `typelessHotkey` equal-value cases (pending, failed, saved).
  - Config normalization of `engine` and `hotkey`, including a stored invalid hotkey.
  - The Doctor rows, with canonical comparison and `unknown` for an unparsable Typeless value.
  - The Presentation strings.
  - The routing and quiesce orchestration, extracted as pure functions:
    - an engine switch in both directions, with a plugin-owned session running on the outgoing engine;
    - an engine switch timing out at 3 s;
    - an external reload that changes the hotkey mid-session;
    - a mic apply under Typeless waiting for settled, then rolling back without a tap.
- **keytap (python unittest, stdlib):**
  - the same chord fixture table;
  - the event order for both chord shapes, using an injected writer instead of `/dev/uinput`;
  - all keys released when a write raises mid-chord, with reply `err write`;
  - the socket protocol: `tap`, `ping`, `err reject`, the 500 ms read deadline, the 128-byte limit, a stale
    socket file;
  - the client exit codes 0/2/3/4/5, including a server that accepts and never replies.
- **Integration:** `tests/setup-typeless.sh` drives setup with fake `systemctl`, `id` and IPC, a fixture
  `app-settings.json`, and a fake uinput path. It covers:
  - the missing `input` group;
  - first run (`hotkeyStored:false`) taking Typeless's value;
  - an existing value kept;
  - an invalid `--hotkey` rejected, with nothing written;
  - an IPC with no Service;
  - `config.saves[N]` failed, or not resolved within 2 s;
  - a stuck IPC hitting the `timeout 3` deadline.

  It never touches the real systemd, Typeless or `~/.config/omaremote`.
- **`make check`** runs all of the above.
- **Hardware acceptance (user present):**
  1. `remote`: hold and speak, then release, with Typeless set to the remote mic. Text is pasted.
  2. `system`: press, speak, press, with C922 or Auto-detect. Text is pasted.
  3. Repeat with the hotkey set to `RightAlt+RightShift`.
  4. Reset while holding in `remote` mode. Typeless stops.
  5. Stop `omaremote-keytap` and press. The HUD shows "keytap not running". Restart it, and it works again.
  6. Switch Voxtype → Typeless while holding in `remote` mode. Voxtype stops and transcribes before the switch
     commits.
  7. Switch Typeless → Voxtype while holding in `remote` mode. Typeless stops before the switch commits.
  8. Switch engines while an F9 dictation runs. It is not interrupted.

## 10. Out of scope

- Detecting Typeless's real recording state. There is no API, and scraping its window or logs is fragile.
- Holding the hotkey down for the hold duration. Taps were chosen so a missed release can never leave a
  modifier stuck.
- Editing Typeless's settings: microphone, hotkey, launch flags.
- The microphone source picker. It is a separate sub-project and applies to Voxtype only.
