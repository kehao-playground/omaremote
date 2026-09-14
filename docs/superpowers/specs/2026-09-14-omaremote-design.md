# OmaRemote — Design Spec

**Date:** 2026-09-14
**Status:** Revision 4; incorporates e6e6bb8 with revised lifecycle and transport contracts. Planning may proceed; implementation remains gated by task-0 spikes.
**Target:** Omarchy master ("quattro", Lua Hyprland config), Hyprland with Lua config + `global` dispatcher, keyd ≥ 2.5, Voxtype ≥ 0.8 (`record cancel`, `config set`), ATVVoice with `--mic-on-demand`
**Plugin id:** `io.github.kehao-chen.omaremote`
**Global-shortcut appid:** `omaremote`

## 1. Goal

Turn any ATVV-class Bluetooth voice remote (G20S Pro family; Xiaomi Remote 2 Pro / RC003 once verified) into a couch controller for Omarchy: push-to-talk dictation into the focused window via Voxtype, and a configurable 13-key mapping engine, surfaced as an Omarchy Quickshell plugin with a bar widget, settings panel, and on-screen HUD.

It is a Linux re-interpretation of two macOS projects:

| macOS reference | Linux / Omarchy equivalent |
|---|---|
| `hidutil` device remap → neutral keys → `CGEventTap` | `keyd` per-device remap → F13–F24 → `hl.bind(key, hl.dsp.global(...))` → Quickshell `GlobalShortcut` |
| ATVV GATT → IMA ADPCM → BlackHole virtual mic | **ATVVoice** daemon → PipeWire virtual mic |
| Douban / WeChat IME voice input | **Voxtype** (`voxtype record start/stop`) |
| Menu-bar icon + corner badges | Quickshell `bar-widget` + `PanelWindow` HUD |
| Settings window | Quickshell `KeyboardPanel` |

### In scope (v1)

1. Voice key → Voxtype dictation (D-Bus and HID triggers).
2. 13-key mapping engine: tap / hold / double / repeat, configurable timing, panic reset.
3. Bar widget + 4-tab panel (Status, Keys, Voice, Setup/Doctor) + HUD.
4. Host setup script + doctor that share one check definition.

### Explicitly out of scope (v1)

Per-app profiles and "app control mode", window-switcher overlay, mouse mode, layers, multiple profiles, arbitrary shell actions, audio waveform/level display, i18n (UI is English; README is zh-TW + English).

## 2. Architecture

```
┌──────────── host (one-time setup; plugin only detects & guides) ─────────────┐
│ keyd      /etc/keyd/omaremote.conf   [ids] vendor:product  (remote only)     │
│           up→f13 down→f14 … 12 keys → F13–F24 (neutral, never collide)       │
│ hyprland  ~/.config/hypr/omaremote.lua, require()d from hyprland.lua        │
│           hl.bind("F13", hl.dsp.global("omaremote:up"))  × learned keys      │
│ atvvoice  systemd --user, --mic-on-demand; PipeWire node + D-Bus             │
│ voxtype   ~/.config/voxtype/config.toml  [audio] device = <atvvoice node>    │
└──────────────────────────────────────────────────────────────────────────────┘
          │ GlobalShortcut press/release                 │ busctl monitor
          ▼                                              ▼
┌──────────── plugin  ~/.config/omarchy/plugins/io.github.kehao-chen.omaremote ─┐
│ manifest.json   kinds: ["bar-widget", "service"], keepLoaded: true           │
│ Service.qml     engine host: GlobalShortcut×N → KeyEngine → ActionDispatcher │
│                 VoiceSession (owner-based; D-Bus / HID / keyboard sources)    │
│                 IpcHandler "omaremote": key down|up, voice, reset, selftest   │
│                 Config (JsonAdapter ↔ ~/.config/omaremote/config.json)        │
│                 Doctor, Stats, HUD PanelWindow                                 │
│ BarWidget.qml   status glyph; Loader → Panel.qml (Status/Keys/Voice/Setup)    │
│ lib/*.js        KeyEngine, Actions, Dbus, Doctor rules — pure JS, node --test │
│ host/omaremote-setup   bash: packages, keyd conf, hypr include, atvvoice,     │
│                        voxtype device; --doctor for check-only               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Decisions

- **Repo root is the plugin.** `omarchy plugin add <git url> --enable` installs it directly. `host/`, `tests/`, `docs/` are sidecar directories. No symlinks anywhere in the tree (Omarchy forbids them).
- **Service.qml hosts the engine** so removing the bar widget does not stop the remote from working. BarWidget/Panel only read state and write config.
- **The plugin performs no privileged or installing action.** Doctor reports what is missing and the exact command; `host/omaremote-setup` does the work.
- **No second Quickshell process or plugin-owned systemd unit.** The plugin invokes only documented operations of `wtype`, `wpctl`, `playerctl`, `voxtype`, `busctl`, `hyprctl`, `pw-dump`, `omarchy-lock-screen`, and `systemctl --user` (inspect/restart the existing Voxtype service). Commands use argument arrays, never interpolated shell strings; package installation and unit creation remain in host setup.
- **Hardware-free testability is a design constraint:** the Service exposes an `IpcHandler` reachable as `omarchy-shell omaremote <verb> …` (`key <name> down|up`, `voice state <state>`, `reset`, `mic remote|system`, `micStatus <operationId>`, `selftest …`) for deterministic event sequences, and `wtype -P F13 … -p F13` exercises the real Hyprland bind → GlobalShortcut path (Hyprland routes virtual-keyboard events through binds). `hyprctl dispatch global` is **not** usable: it forwards the compositor's internal `m_passPressed`, not an explicit down/up.

### Verification-first items (Plan task 0)

These are assumptions about the Omarchy plugin API that must be confirmed by cloning a built-in plugin (`omarchy plugin clone omarchy.<id> --edit`) before other work starts:

1. A plugin may declare both `bar-widget` and `service` kinds, and BarWidget/Panel can reach the Service singleton's state.
2. A `service` may instantiate its own `PanelWindow` (for the HUD).
3. `Quickshell.Hyprland.GlobalShortcut { appid: "omaremote"; name: "up" }` receives `pressed`/`released` for `hl.bind("F13", hl.dsp.global("omaremote:up"))` (Hyprland's `dsp_global` sets `request_release`, so one bind should deliver both).
4. Voxtype opens its PipeWire capture stream only while recording (so ATVVoice `--mic-on-demand` opens the remote mic per session, not permanently).
Already settled by Voxtype's own Omarchy plugin (`peteonrails/voxtype/omarchy-plugin`, id `io.voxtype.settings`): a plugin's `IpcHandler { target: "<id>" }` is reachable as `omarchy-shell <id> <verb> [args]`; `"keepLoaded": true` in the manifest instantiates the plugin with the shell so the IPC target exists before any UI is opened (changing that flag needs `omarchy-restart-shell`, not `rescanPlugins`); `omarchy-shell shell rescanPlugins` picks up a hand-copied plugin.

Fallbacks, in order: if (1) or (2) fails, evaluate a BarWidget-owned engine/HUD, but do not proceed until a revised contract explains residency and HUD availability when the widget is removed. If (3) fails, bind press and release separately to `exec` of `omarchy-shell omaremote key <name> down|up`, and test that delivery path explicitly. If (4) fails, evaluate explicit `MicOpen`/`MicClose`; observing an external keyboard session is not sufficient to open its microphone before capture starts. That fallback requires a revised keyboard-start contract and new acceptance tests before implementation. The remaining sections describe the primary on-demand design.

## 3. Host contract

### keyd — `/etc/keyd/omaremote.conf`

```
[ids]
<vendor>:<product>          # only the remote; keyboard untouched

[main]
up = f13
down = f14
left = f15
right = f16
enter = f17
back = f18       # source key names are learned per device (see §7 step 2)
home = f19
menu = f20
<app/tv key> = f21
volumeup = f22
volumedown = f23
power = f24
<mic key, if any> = prog1   # → XF86Tools; most ATVV remotes have no HID mic key
```

Neutral key pool: F13–F24 (12) + `prog1`/XF86Tools (13th). All keycodes are < 256 so they survive xkb on Wayland.

### Hyprland — `~/.config/hypr/omaremote.lua`

Omarchy configures Hyprland in Lua (`~/.config/hypr/hyprland.lua` → `require("hypr.bindings")` etc.; `package.path` includes `~/.config/?.lua`). Setup writes:

```lua
-- Generated by omaremote-setup; regenerated on re-run.
hl.bind("F13", hl.dsp.global("omaremote:up"),   { description = "omaremote:up" })
hl.bind("F14", hl.dsp.global("omaremote:down"), { description = "omaremote:down" })
-- … one line per supported key …
hl.bind("XF86Tools", hl.dsp.global("omaremote:mic"), { description = "omaremote:mic" })  -- only if the remote has a HID mic key
-- Keyboard-reachable escape hatch, independent of the remote (§4.3):
o.bind("SUPER + CTRL + ALT + R", "OmaRemote reset", "omarchy-shell omaremote reset")
```

and appends `require("hypr.omaremote")` to `hyprland.lua` once if absent (after the other `require("hypr.*")` lines). `hl.dsp.global` requests the release event itself, so a single bind delivers press and release.

**Load verification.** For Lua binds `hyprctl binds -j` reports `dispatcher` as the handler's Lua function string and `arg` as a registry reference, so the check keys on the `description` we set: `hyprctl reload && hyprctl binds -j | jq -r '.[].description | select(startswith("omaremote:"))'` must yield exactly one `omaremote:<key>` per supported key, with no duplicates or extras. That proves the binds loaded, not that they reach the plugin; the **transport self-test** (§7 step 6 / §9) proves the latter. Doctor runs the same description check. Omarchy's own F9 Voxtype binds (`default/hypr/bindings/voxtype.lua`) are never touched.

### ATVVoice

`systemctl --user enable --now atvvoice`, with a drop-in setting `ExecStart=… --mic-on-demand` so the remote mic opens whenever a PipeWire client captures from the node and closes when the client stops. Plugin consumes:

- Bus name `org.atvvoice.<name>` (any suffix; the plugin discovers it by listing names with the prefix), object `/org/atvvoice/Daemon`, interface `org.atvvoice.Daemon`.
- Methods `MicOpen`, `MicClose`, `MicToggle`.
- Properties `State` (`disconnected|connected|opening|streaming`), `DeviceAddress`, `NodeName`.
- Signal `MicStateChanged(string)`.

### Voxtype

`~/.config/voxtype/config.toml`: `[audio] device = "<NodeName>"`, `[output] mode = "type"`. `auto_submit` is left to the user. Control via `voxtype record start|stop|cancel`; `cancel` requests cancellation of pending work and cannot undo text already emitted. State comes from the JSON `class` field of `voxtype status --follow --format json`; normalize `streaming` to `recording` if the selected Voxtype mode reports it. `stopped` is unhealthy even when the command exits zero; unknown classes are not treated as `idle`. The follow stream is change-driven, so explicit polls are required for freshness checks. Streaming transcription may emit text before release; the panic contract only covers output still pending at cancellation.

**Mic modes (`voice.mic` in `config.json`, mirrored into Voxtype's `audio.device`):**

| mode | Voxtype `audio.device` | remote button (D-Bus) | keyboard F9 | prerequisites for `ready` |
|---|---|---|---|---|
| `remote` (default after setup) | ATVVoice `NodeName` | starts a session, audio from remote | audio from remote via on-demand; **no microphone while the remote is disconnected** (Status shows "remote mic: disconnected") | Voxtype healthy + ATVVoice active + device == `NodeName` |
| `system` | `"default"` | still starts a session (if ATVVoice is present), audio from the system mic — the remote acts as a PTT button | normal Voxtype behaviour | Voxtype healthy only; ATVVoice rows are informational |

**Mic apply contract** (one implementation, in the plugin; the Voice tab and setup use it). `omarchy-shell` has a short IPC timeout, so `mic remote|system` returns immediately with JSON `{ "ok": true, "operationId": "…", "state": "queued" }`. `micStatus <operationId>` returns `queued|applying|verifying|rollingBack|succeeded|failed`, including an error and rollback result when applicable. Both clients inspect this payload, not just the shell exit code. Only one operation may be pending; a second request returns `busy`. Results remain available for the Service lifetime; an unknown ID or lost Service connection is a failure, never assumed success.

Voxtype does not reload its config. The operation follows these steps:

1. **wait without mutation** — wait at most 60 s for VoiceSession `idle`, no pending start/stop/cancel command, and a fresh backend `idle` observation. While waiting, the current session continues normally and the HUD says "mic change applies after this dictation". Timeout or reset fails the request without a config write or restart; there is nothing to roll back.
2. **reserve and snapshot** — acquire the same exclusive operation gate used by recovery and self-test. Refuse plugin voice starts while applying. Recheck backend state before mutation; if it is busy, release the gate and continue within the original wait deadline. Read `voxtype config get audio.device --json`, preserving whether the file value was absent as well as its literal value, and retain the previous `voice.mic`. Resolve the target node now. A failed preflight leaves both configs untouched.
3. **apply and restart** — `voxtype config set audio.device <value>`, then `systemctl --user restart voxtype`. Short read/config commands have a 2 s deadline and are reaped before a subsequent mutation. Restart and verification together have a 10 s deadline. Verify service `active`, a changed systemd invocation identity, and a fresh JSON `class: idle` after that restart; discard buffered status from the old monitor. Transient `stopped`/non-zero polls during startup are retried until the deadline, not mistaken for success or immediate terminal failure.
4. **commit** — only after verification, atomically write `voice.mic` to `config.json` and report `succeeded`. A commit-write failure is also an apply failure. Release the operation gate after a terminal outcome.
5. **rollback after mutation** — restore the old file value with `config set`, or `voxtype config unset audio.device` if it was absent; restart and verify using the same 10 s bound. Keep/restore the previous `voice.mic`. Report the original failure and rollback outcome. Failed rollback → `unconfigured` with "voxtype restart failed"; never report the requested mode as active. Do not overwrite a concurrent external config edit: detect a changed value and instead report a conflict requiring reconciliation in Doctor.

All plugin voice commands and mic/recovery operations share the gate; queued mic requests never bypass recovery. Reset has priority: fail a queued request without mutation, or mark an applying request failed, stop further apply steps and serialize cancellation/recovery before any rollback. Never run two restarts concurrently. Killing a timed-out `systemctl` client does not cancel its systemd job: inspect the unit's `Job` and state before another mutation. An unsettled job at the deadline leaves the operation failed/`unconfigured`, with rollback deferred for explicit reconciliation, rather than submitting a competing restart.

External F9 commands are outside this gate: setup/UI explicitly show that changing microphones restarts Voxtype and F9 must remain unused until it finishes. If an external recording is observed during apply, fail the operation and defer any remaining restart/rollback until it settles, with a 60 s bound; on expiry leave `unconfigured` with "mic change interrupted", preserve the snapshot for diagnosis, and perform no further automatic restart. This detects observed interference; the upstream commands provide no atomic lock against an external start between the final check and restart.

The capture device is verified on the next session: `pw-dump` must show Voxtype's stream linked to the expected node; the result appears in Status as "last session captured from: <node>" with its time and mode. No observed stream means "not yet verified", not a pass; a mismatch is a warning. This is the only Voxtype user-config edit the plugin performs, always on an explicit request. A Service interruption during an operation is reported as an unknown outcome on reconnect; Doctor reconciles file/device/runtime state before another apply, rather than claiming the interrupted operation succeeded.

### Plugin-side files

- `~/.config/omaremote/config.json` — user config (schema §4.2). Created with defaults on first run if absent.
- `~/.local/share/omaremote/stats.json` — voice session stats (§5.5).

## 4. Key mapping engine

### 4.1 Inputs

Logical key names: `up down left right ok back home menu app volup voldown power mic`. Each receives `press(t)` / `release(t)` in milliseconds from the GlobalShortcut (or IPC fallback). `mic` may also be driven by VoiceSession (§5).

### 4.2 Config schema

```json
{
  "version": 1,
  "device": { "vendor": "1915", "product": "1010", "name": "G20S PRO", "learned": { "back": "back", "app": "prog2" } },
  "timing": { "holdMs": 350, "doubleMs": 250, "repeatMs": 80, "panicMs": 1500 },
  "keys": {
    "ok":   { "tap": {"type":"key","keys":"Return"}, "hold": {"type":"key","keys":"ctrl+c"} },
    "up":   { "tap": {"type":"key","keys":"Up"}, "repeat": true },
    "menu": { "tap": {"type":"key","keys":"Tab"}, "panic": true },
    "mic":  { "ptt": true },
    "app":  { "supported": false }
  },
  "voice": { "mic": "remote", "maxSessionSec": 60, "startTimeoutMs": 1500, "arbitrationMs": 250, "stopTimeoutMs": 15000, "hud": true, "actionFlash": true }
}
```

Per-key fields: `tap`, `hold`, `double` (each an Action or absent), `repeat` (bool), `panic` (bool), `ptt` (bool, `mic` only), `supported` (bool, default true; set to false by setup for keys the remote does not emit — the Keys tab greys the row and no bind is generated). Validation: `panic` is mutually exclusive with `hold` and `repeat` on the same key (the UI disables the fields; a hand-edited config that combines them is reported by Doctor and the key falls back to `tap`-only). Unknown fields are preserved on write.

### 4.3 State machine (per key, pure JS with injected clock)

Each key is classified from its config: `long` = `hold` or `repeat` bound (threshold `holdMs`), `panic` (threshold `panicMs`, exclusive with `long`), `double` bound or not.

- **Simple key** (no `long`, no `panic`, no `double`): emit `tap` on **press**; release is ignored. Zero latency, behaves like an ordinary key regardless of how long it is held.
- **Long key, no double:** press → `down`. Release before `holdMs` → emit `tap`. At `holdMs`: if `hold` bound emit `hold` → `held`; if `repeat`, emit `tap` now and every `repeatMs` → `repeating`. Release from `held`/`repeating` → `idle`, nothing emitted.
- **Panic key, no double:** press → `down`. Release before `panicMs` → emit `tap` (so Menu released at 350–1499 ms still tabs). At `panicMs` → `engine.reset()`, release ignored.
- **Double-bound key:** release before the long threshold (or any release, for a simple+double key) → `waitDouble`. Second press within `doubleMs` → emit `double`, consume that press's release. Timeout → emit `tap`. Long/panic thresholds still apply while `down`, as above.
- A press arriving while another key is `waitDouble` resolves that key as `tap` first (no cross-key doubles).

Boundary cases are enumerated in `tests/KeyEngine.test.js`: release exactly at the threshold counts as long; `repeat` with `hold` both bound fires `hold` once then repeats `tap`; config changes mid-press reset that key to `idle` without emitting.

`reset()` clears every key's state, calls `VoiceSession.abort()` (§5.2: `voxtype record cancel` + `MicClose`, never `stop`), closes HUD and Panel. This path is hard-coded and cannot be disabled by config. It has two entries that must always exist: at least one **supported** key with `panic: true` (enforced by setup §7 and Doctor), and the IPC verb `omarchy-shell omaremote reset`, which setup binds to `SUPER+CTRL+ALT+R` so a stuck remote can always be cleared from the keyboard.

The engine emits `(keyName, trigger, action)` events; it never touches Hyprland, wtype, or processes.

### 4.4 Actions (closed union — `lib/Actions.js`)

| type | fields | dispatch |
|---|---|---|
| `key` | `keys: "ctrl+shift+Return"` | `wtype` — modifiers become `-M mod … -m mod`, final token `-k <keysym>` |
| `dispatch` | `dispatcher`, `arg` | `Hyprland.dispatch("<dispatcher> <arg>")`, no process spawn |
| `volume` | `delta: "+5" \| "-5" \| "mute"` | `wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%+` / `set-mute … toggle` |
| `media` | `cmd: play-pause \| next \| previous` | `playerctl <cmd>` |
| `screen` | `cmd: off \| lock` | `hyprctl dispatch dpms off` / `omarchy-lock-screen` |
| `none` | — | placeholder |

`Actions.toArgv(action)` returns `{ kind: "process", argv: [...] }` or `{ kind: "dispatch", cmd }` so it can be unit-tested without spawning.

### 4.5 Default profile (generic ATVV remote)

| key | tap | hold | other |
|---|---|---|---|
| up/down/left/right | arrow key | — | repeat |
| ok | Return | ctrl+c | |
| back | Escape | BackSpace | |
| home | `dispatch exec omarchy-menu` | — | simple key: fires on press |
| menu | Tab | — | panic (tap fires on release < 1500 ms) |
| app | `dispatch workspace e+1` | — | |
| volup / voldown | volume +5 / −5 | — | repeat |
| power | screen off | screen lock | |
| mic | — | — | ptt |

## 5. Voice session

### 5.1 Sources

Because ATVVoice runs with `--mic-on-demand`, every source funnels into the same Voxtype commands; the plugin does not call `MicOpen` for normal sessions.

- **D-Bus — remote mic button:** `busctl --user monitor --match "type='signal',interface='org.atvvoice.Daemon',member='MicStateChanged'"`, parsed by `lib/Dbus.js` into `{ state, sender, path, interface, generation }`. Only signals from the selected `org.atvvoice.*` sender, exact object path and interface are accepted. A monitor reconnect increments `generation`; buffered signals and prior generations are discarded. The remote's own button makes ATVVoice go `streaming`; that is the start signal. On start and after every monitor reconnect the `State` and `NodeName` properties are read once.
- **HID mic key:** `mic` press/release from the engine when `ptt: true` (rare; most ATVV remotes have no HID mic key).
- **Keyboard (F9 / any other Voxtype hotkey):** observed through `voxtype status --follow --format json`.

### 5.2 State machine

`idle → starting → recording → transcribing → idle`, plus `arbitrating` (below), `recovering` (§5.3) and `unconfigured`. `unconfigured` means **Voxtype itself** is unusable (binary/daemon missing, `output.mode ≠ "type"`, daemon not answering); remote-side problems (ATVVoice down, device mismatch in `remote` mode, remote disconnected) only set a `remoteWarning` shown in Status/HUD and disable the D-Bus start path — keyboard and HID sessions keep working. Every session has one **owner** ∈ `{dbus, hid, keyboard}`. Ownership controls which input may ask the plugin to stop; actual backend transitions are authoritative for every owner. External F9 can stop a session without going through the plugin, so this is not a lock on Voxtype.

**Start.** `voxtype record start` only delivers SIGUSR1; a zero exit does not mean audio is flowing (the daemon may stay `idle` if the capture device vanished). A session is therefore **confirmed only when `voxtype status` reports `recording`**:

| event (from `idle`) | action | owner | next state |
|---|---|---|---|
| HID `mic` press | `voxtype record start` | `hid` | `starting` |
| D-Bus `streaming` | see arbitration below | `dbus` or `keyboard` | `arbitrating` |
| Voxtype status `recording` not requested by us | none (observe) | `keyboard` | `recording` |

- `starting` → `recording` when status shows `recording`; HUD shows `starting…` meanwhile. If the owner releases during `starting`, the release is remembered and the stop is issued the moment `recording` is observed. If `startTimeoutMs` (1500) passes with no `recording`: `voxtype record cancel`, HUD `no audio from Voxtype`, error +1, → **`recovering`** (§5.3) — not `idle`, because `cancel` only files a request and a late `recording` from the cancelled start may still arrive.
- **Arbitration** (`arbitrating`, both mic modes): D-Bus `streaming` is ambiguous — it is either the remote button, or an on-demand open caused by a capture client whose `recording` status has not reached us yet. Voxtype opens capture before it writes its state, and the two monitors have no ordering guarantee or trigger identity. `system` mode does not prove independence: the system default source can itself resolve to ATVVoice. Rules while `arbitrating`:
  - status already `recording`, or `recording` arrives within `arbitrationMs` (250) → adopt as `keyboard` owner → `recording`.
  - D-Bus leaves `streaming` (button released, or remote dropped) → arbitration cancelled → `idle`, nothing sent. A short remote tap therefore never issues a `record start` after the user has let go.
  - `abort()` → `cancel`, and `MicClose` only when this session owns a remote mic opened by the plugin; then `recovering`. In `system` mode, or when ownership is unknown, do not close ATVVoice's mic. Arbitration may conceal an already-starting keyboard session.
  - timer expires → explicitly re-read ATVVoice `State` and Voxtype status. If the remote is no longer streaming, abandon arbitration. If the backend is recording, adopt `keyboard`; if transcribing or unhealthy, observe that state without starting. Only current `streaming` + backend `idle` + a free operation gate allows `voxtype record start`, owner `dbus`, → `starting`.
  - **This remains a heuristic, not source identification.** A delayed keyboard status can still be misattributed to `dbus`; a delayed D-Bus end may then stop that keyboard session. Start/stop are signals evaluated when the daemon handles them: a command intended for old work can affect later work if an external session starts in between. Neither the 250 ms window nor a fresh read makes these operations atomic. Show inferred ownership as such in the UI/stats; do not promise harmless duplicate commands or exact isolation from concurrent F9/other capture clients. Exact attribution would require upstream trigger/session IDs or routing every start through one controller, both outside v1. Tests cover both event orders and the delayed-event counterexamples (§9).
- Any start event while not `idle` is ignored at debug level; in particular on-demand `streaming` during a `hid`/`keyboard` session and the `recording` status of a session we requested ourselves. The "adopt as `keyboard`" rule applies **only** from `idle` or `arbitrating`, never from `recovering` (§5.3).

**End (`recording → transcribing`):**

| event | owner it applies to | action |
|---|---|---|
| D-Bus leaves `streaming` | `dbus` | `voxtype record stop` |
| HID `mic` release | `hid` | `voxtype record stop` |
| Voxtype status becomes `transcribing` or `idle` | any | follow backend state; no additional stop |
| Voxtype status becomes `stopped` / unknown | any | refuse starts; unhealthy → `unconfigured` |
| `maxSessionSec` elapsed | any | `voxtype record stop`, warning |
| `abort()` (panic / config reload / shell exit) | any | `voxtype record cancel`; `MicClose` only for a plugin-owned remote mic; HUD `Reset`, → `recovering` |

Non-owner input end events are ignored: an HID release during a `keyboard` session does nothing. D-Bus leaving `streaming` during a `hid`/`keyboard` session warns about dropped audio only if capture is known to use the remote node (otherwise it updates remote connectivity only). Before a D-Bus end issues stop, re-read the selected remote's state and backend status; discard the end if the remote is currently streaming or the backend is no longer recording. This filters stale events but retains the attribution limitation above. Once stop is requested, latch it so duplicate releases cannot send another stop; keep a "stopping…" indicator until the backend leaves recording, and start the absolute `stopTimeoutMs` deadline at that request.

**`transcribing → idle`:** Voxtype status returns to `idle`. `abort()` in `transcribing` issues `voxtype record cancel` + `MicClose` and enters recovery. Cancellation suppresses work the daemon has not yet emitted; it cannot retract already typed text. Shell exit makes a best-effort cancel/close and cannot supervise recovery after the Service is gone; the next Service startup reconciles backend state before declaring readiness.

### 5.3 Command failures and timeouts

- Serialize plugin start/stop/cancel processes; tag their callbacks, status monitors and timers with a local generation. A reset or daemon restart invalidates the old generation, drops queued commands, and terminates/reaps outstanding plugin command processes before any replacement daemon is started. Local generations reject stale callbacks; they do not supply missing upstream session IDs.
- `voxtype record start` exits non-zero or times out → HUD `Voxtype start failed`, error +1, cancel + `recovering`. Do not infer that the signal was never delivered. Exit zero remains `starting` until observed recording (§5.2).
- `voxtype record stop` exits non-zero → cancel + `recovering`, regardless of cancel's exit code. A successful stop remains unconfirmed until the backend changes state.
- Stop-to-idle exceeds `stopTimeoutMs` (default 15 s, including waiting for recording to end) → cancel + `recovering`. For externally initiated transcription, start that deadline on observed `transcribing`. Status updates never extend it.
- **`recovering`** refuses starts and mic apply, shows `recovering…`, and never adopts late `recording`/`transcribing` as a new session. Issue cancel once on entry; close the mic only for a plugin-owned remote mic. A fresh `idle` observation is a status poll no more than 500 ms old, from the current monitor generation, and newer than the cancellation request. It can settle a previously confirmed session only after plugin command processes have completed and there is no unconfirmed start. A buffered idle from before cancellation is insufficient.
- **Unconfirmed start / abort during arbitration:** a fresh idle alone cannot settle recovery. Voxtype's start handler clears the cancel marker, so a pending start can run after that idle poll. Retire that daemon: after reaping old plugin command processes, inspect `systemctl --user show voxtype --property=Job --value`; do not submit another restart while a job is pending. Once no conflicting job remains, perform one bounded restart. Verify a new systemd `InvocationID`, service `active`, and fresh `idle` within 10 s before reopening the gate. This is a recovery restart, with no config edit; HUD explains "restarting Voxtype after cancelled start".
- **Bound recovery even if status keeps arriving:** if a confirmed session has not settled within a further `stopTimeoutMs`, perform the same single recovery restart. If restart/verification fails, or status remains unhealthy, enter `unconfigured` with "voxtype not responding" and stop automatic retries. The combined recovery budget is at most `stopTimeoutMs + 10 s`, including cancellation and command cleanup; an unconfirmed start takes the restart branch directly. An unsettled systemd job uses the same no-competing-restart rule as mic apply (§3). Never reopen on the strength of `cancel` exit zero. An external F9 session is observed during recovery but is not cancelled by OmaRemote; wait for it to settle or enter `unconfigured` and show the unavailable interval explicitly.

### 5.4 Degradation

Voxtype missing/not answering or `output.mode ≠ "type"` → `unconfigured` (no sessions; bar glyph yellow; key mapping keeps working). In `remote` mode, missing ATVVoice / no `org.atvvoice.*` on the bus / `audio.device ≠ NodeName` → `remoteWarning` (glyph shows a warning dot, D-Bus start path disabled, keyboard/HID sessions still allowed). In `system` mode the ATVVoice checks are informational only. D-Bus monitor exit → restart with exponential backoff (1 s → 30 s cap).

### 5.5 Stats

Append per confirmed session to `~/.local/share/omaremote/stats.json`: `{ startedAt, durationSec, source, inferred }`; D-Bus/keyboard attribution is inferred (§5.2). Failed starts and self-test events do not count as sessions. Panel shows today / this week / all-time counts and seconds and the longest session. No audio or transcribed text is stored.

## 6. UI

### 6.1 BarWidget.qml

One remote glyph coloured by Service state using Omarchy theme tokens:

| state | look |
|---|---|
| `unconfigured` | yellow; tooltip lists missing items |
| `disconnected` | dimmed (ATVVoice `disconnected` or remote absent) |
| `ready` | foreground |
| `arbitrating` / `starting` | pending indicator; not yet recording |
| `recording` | red with slow pulse; elapsed seconds beside it |
| `transcribing` | foreground with spinner |
| `recovering` / mic apply | spinner with operation and error detail; voice starts unavailable |
| self-test | test indicator; normal remote actions suppressed |

Active voice/operation states take precedence over disconnected/ready presentation. Left click → `toggle()` Panel. Middle click → `MicToggle` (quick mic test; unavailable during mic apply, recovery or self-test). A user mic test may generate D-Bus streaming and is subject to the same voice rules. Exposes `open() close() toggle() closeForPopoutSwitch()` and `opened`, `popoutSwitchClosing` as Omarchy's bar-widget contract requires.

### 6.2 Panel.qml (`KeyboardPanel`, same `moduleName` as the widget)

Four tabs, fully keyboard-navigable:

1. **Status** — remote / ATVVoice state and node, Voxtype status, today's stats, "Test mic (3 s)" button.
2. **Keys** — 13 rows: key · tap · hold · double · repeat☐. Editing an action opens a popover: type combo + type-specific fields; `key` type has a "press a key to capture" mode. Footer: "Reset to defaults", "Timing…" (holdMs/doubleMs/repeatMs).
3. **Voice** — active sources, owner of the current session (label inferred attribution), `maxSessionSec`, HUD and action-flash toggles, **Voxtype mic: Remote / System default** switch (§3), detailed stats. Show active and requested modes separately while the asynchronous apply is pending; disable a second request and display terminal errors/rollback outcome.
4. **Setup (Doctor)** — checklist rows (pass/warning/failure/not-yet-verified + one-line fix command + Copy): keyd service enabled+active and `keyd check` passes on our conf; remote evdev device grabbed by keyd; `hypr/omaremote.lua` required and exactly one `omaremote:<key>` description per supported key (§3); Voxtype ≥ 0.8 present, healthy JSON status class rather than merely exit zero, `output.mode == "type"`; per `voice.mic` mode: ATVVoice service active with `--mic-on-demand` and `audio.device == NodeName` (`remote`) or `audio.device` resolves to an existing PipeWire source (`system`); last session's captured node and freshness; at least one supported key has `panic: true`; required tools present; config valid (§4.2). Each row states which mode it applies to. Header button "Copy full setup command" → `bash <plugin-dir>/host/omaremote-setup`. The panel never installs anything.

Key/timing changes write `config.json` through `JsonAdapter`; the engine hot-reloads and resets affected keys. Mic-mode changes use the transaction in §3 and write the mode only on commit; that internal write must not trigger another apply or abort. An external edit that disagrees with Voxtype is shown as a mismatch until an explicit mic apply reconciles it.

### 6.3 HUD

A `PanelWindow` owned by Service: layer overlay, top-centre, no exclusive zone, no keyboard focus.

- recording: red dot + `00:04` timer; transcribing: `… transcribing`; fades out on idle.
- starting/arbitrating, stopping, recovery, mic apply and self-test display their pending state; no recording timer before backend confirmation.
- Non-tap triggers flash the action name for 600 ms (e.g. `OK · hold → Ctrl+C`), toggleable.
- Panic reset flashes `Reset` for 1 s.

## 7. Host setup script — `host/omaremote-setup`

bash (Omarchy ships bash 5), idempotent, safe to re-run. Steps:

1. `sudo pacman -S --needed keyd wtype playerctl evtest jq psmisc`; verify the other documented host tools (including `pw-dump`, `wpctl`, Node.js for shared Doctor rules, and Voxtype) before dependent steps. `sudo systemctl enable --now keyd` (a host that never ran keyd has nothing to `reload`). Install `rustup` if `cargo` is missing, build ATVVoice with `cargo install --git https://github.com/b0o/ATVVoice` after checking its upstream build prerequisites, write the user unit plus a drop-in with `--mic-on-demand`, `systemctl --user daemon-reload`, then `systemctl --user enable --now atvvoice`.
2. **Detect the remote:** list `/proc/bus/input/devices` entries matching `Remote|RC|G20` (or take `--device vendor:product`). **Learn keys** — skipped when `config.json → device.learned` already exists for this vendor:product unless `--relearn` is given. keyd holds the remote with `EVIOCGRAB`, so on a re-run `evtest` would see nothing: learning runs inside `sudo systemctl stop keyd` … `start keyd`, with a `trap` that terminates/reaps the learning process and restarts keyd on any exit or Ctrl-C. Exclusivity is tested by the grab itself: one `evtest --grab` process holds the selected node throughout learning; a failed grab (`EBUSY`) aborts with the holder list from `fuser -v` as a diagnostic only. Normal readers such as the compositor's libinput keep the node open and coexist with `evtest`, so open handles are never treated as a conflict. Prompt the 13 *logical* keys one at a time; accept a press/release pair before advancing, or `s` / 10 s timeout to mark it `supported: false`. `mic` is last with "most ATVV remotes have no HID mic key — skipping is normal". `up down left right ok back` are required; abort if any is skipped. **Panic guarantee:** if the panic key (default `menu`) was skipped, ask for a supported fallback in the order `home, app, power, back`; the chosen key gets `panic: true` and loses `hold`/`repeat`. Stage the results and generated keyd config; reject duplicate physical-key assignments and validate with `keyd check` before replacing existing files. Persist `device.learned` / `keys.<k>.supported` only after validation. Terminate/reap `evtest` to release its grab, explicitly `sudo systemctl start keyd`, then `sudo keyd reload`. Prompt the user to press a learned key and confirm via a 3 s `keyd -m` capture that the remote emits the expected neutral key; restore the previous config and reload on failure.
Learning cleanup uses a dedicated process group: the trap sends TERM then KILL, waits for every child, confirms the evdev grab is released, and only then starts keyd. Prior files remain untouched until staged learning passes duplicate-key and `keyd check` validation.
3. Write `~/.config/hypr/omaremote.lua` (§3); append `require("hypr.omaremote")` to `hyprland.lua` if absent; `hyprctl reload`; verify the description set with `hyprctl binds -j` as in §3, abort on mismatch.
4. `omarchy plugin add <repo> --enable` if not installed; `omarchy-shell shell rescanPlugins`; wait at most 15 s for `omarchy-shell omaremote selftest ping`. If the target is absent, fail with the shell diagnostic and `omarchy-restart-shell` guidance for a changed `keepLoaded` manifest; do not loop forever.
5. Apply the existing `voice.mic` mode (or `remote` only when no valid config exists); an explicit `--mic remote|system` may select a mode. Obtain the operation ID and poll `micStatus <operationId>` until success/failure (§3). Each IPC call returns promptly; setup treats transport errors, unknown IDs and payload `ok: false` as failure. The overall client budget is 150 s (initial wait, apply, interference wait and rollback bounds); expiry reports an unresolved operation and fails without starting self-test or sending a competing apply.
6. **Transport self-test:** `omarchy-shell omaremote selftest arm` obtains an exclusive test lease (30 s) and returns an ID. Arming requires VoiceSession idle, fresh backend idle, no held keys or pending key timers/commands, and no mic/recovery operation; otherwise return `busy` without cancelling anything. With the lease active, all normal action dispatch and voice starts (HID, D-Bus, IPC and mic-test UI) are suppressed. Keep the real backend observer attached; if external F9 starts recording, fail the test, clean up its fake state, and resume normal observation of that session without cancelling it. HUD shows `self-test`.
   - Count raw GlobalShortcut press/release events **before** KeyEngine consumes them; track IPC-injected events separately so they cannot pass a GlobalShortcut transport check. A recorder may run a separate KeyEngine instance, but it cannot invoke real actions. Real remote input during the window is counted too and may cause an extra-event failure.
   - For every supported key run `wtype -P <neutral> -s 100 -p <neutral>`; query `selftest report <id>` for exactly one press and one release per supported key, no extras and no held keys. A report ends the lease, and mismatches name affected keys. If task-0 selects the exec/IPC fallback, tag and test that path separately rather than claiming GlobalShortcut success.
   - Report, reset, external recording and lease expiry all discard the test engine, timers and queued actions before normal dispatch resumes; held keys are quarantined until release. Expired/invalid IDs return an error, never partial success. The runner bounds each `wtype` call, checks `selftest status <id>` (active + remaining time) before each injection, and stops/reaps its injector on any failure or before the 30 s deadline. Its exit trap sends releases for keys it pressed, then `selftest disarm <id>`. No injections may continue after lease expiry; cleanup releases never trigger tap/hold actions. Explicit reset still invokes the normal voice abort contract; test-generated panic only records an event.

`omaremote-setup --doctor` performs checks only and prints the same JSON the Panel Doctor renders; both use `lib/Doctor.js` rules so they can never disagree.

## 8. Error handling

- Any missing subsystem degrades that feature only; nothing else stops.
- Never let an exception escape into the Omarchy shell process: every `Process` has `onExited` logging; long-running monitors auto-restart with backoff.
- Corrupt `config.json` → use built-in defaults, mark `unconfigured` with a "config invalid" item, never overwrite the user's file.
- `engine.reset()` (panic) is the single hard-coded escape hatch; it cancels (never stops-and-transcribes) any voice work and closes only a plugin-owned remote mic.

## 9. Testing

| layer | method |
|---|---|
| `lib/*.js` (KeyEngine, Actions, Dbus, Doctor rules) | `node --test tests/`; engine tests use a fake clock and cover every timing window and conflict (double during hold, panic during repeat, release after hold, etc.) |
| QML | `qmllint -I "$OMARCHY_PATH/shell"` + `omarchy plugin validate .`, wired into `make check` |
| integration, no hardware | `tests/fake-remote.sh`: deterministic `key`/`voice` IPC sequences against fake process/status/D-Bus adapters, plus the real compositor transport lease in §7. For example, `key ok down`, advance 400 ms, `key ok up` exercises hold; `voice state streaming` / `voice state connected` exercises arbitration and connectivity separately. `gdbus emit --session --object-path /org/atvvoice/Daemon --signal org.atvvoice.Daemon.MicStateChanged streaming` tests monitor parsing only; a fake service implementing `State`/`NodeName` is required for the full arbitration path. These tests must run with recorded/fake action and Voxtype outputs, not type into the user's desktop. |
| hardware | with a G20S Pro / RC003: run setup → Doctor all green → manual checklist in `docs/hw-checklist.md` |

Required lifecycle cases (fake clock and controllable backend; transport tests additionally require a running Linux/Hyprland session):

| case | required assertion |
|---|---|
| HID release while `starting` | No stop before confirmed recording; exactly one stop on confirmation. Backend transitions to transcribing/idle are respected for every owner. |
| Start fails, or never confirms within 1500 ms | Enter recovery; an old idle poll cannot reopen the gate. Cancel marker followed by delayed start does not yield a new keyboard session. Reap old command processes, restart once, require a new invocation + fresh idle. |
| Panic during arbitration/recording/transcription | All paths cancel + close and enter recovery. Hold fake transcription before emission, panic and let cancellation be consumed: no text emitted. Separately document that already-emitted text is not retracted. |
| Stop fails or backend remains recording after successful stop | Recovery applies regardless of cancel's exit status. Repeated recording/transcribing updates cannot extend the absolute deadline; failed bounded restart ends unconfigured. |
| Arbitration releases before 250 ms | No plugin start. Backend recording at 100 ms is adopted as keyboard. Test both monitor arrival orders. |
| Delayed keyboard status at 300 ms | Fresh backend recording at the final poll prevents a start. If that poll is also stale, assert inferred attribution and exercise possible premature stop; do not assert harmless duplication. |
| Old D-Bus end arrives after a later session starts | A current streaming property or non-recording backend suppresses stop. If both fresh observations still permit it, record the known cross-session ambiguity; local generations alone must not be presented as source isolation. |
| System default resolves to ATVVoice | Arbitration still runs; warning follows observed capture source, not the mode label alone. |
| Mic request while busy exceeds 60 s | No config mutation, restart or rollback; requested mode is not committed. A second request returns busy. |
| Mic apply succeeds / restart fails / commit write fails | Active + new invocation + idle gates commit. Transient stopped is retried; persistent stopped times out and rolls back. Restore an absent old device with unset, not a guessed default. Rollback failure is unconfigured. |
| F9/config edit/Service exit during mic apply | Detect observed interference; bound deferred rollback and avoid overwriting external edits. Lost operation ID is unknown/failure; no false success or automatic competing operation. |
| Apply takes longer than shell IPC timeout | Initial call returns an ID promptly; polling reaches a terminal payload. Shell exit zero with application failure is still a setup failure. |
| Reset or timed-out systemctl during apply | No overlapping apply/recovery/rollback commands. A live systemd job after client exit blocks further mutation and leaves an explicit unresolved failure. |
| Self-test with active session, held key, or pending operation | Arm returns busy without cancelling the session or detaching its observer. |
| Self-test normal completion, missing release, expiry, panic, external F9 | All source paths suppress real actions/starts. Raw press/release counts remain visible even for simple keys. Cleanup drops timers/actions and quarantines held keys; advancing the clock cannot cause a late action. External F9 remains observed. |
| Learning fails / Ctrl-C / skipped mic | evtest is reaped before keyd resumes; prior config survives failure; required navigation and supported panic checks still hold. |

## 10. Repository layout

```
OmaRemote/                      # = the plugin
├── manifest.json
├── Service.qml
├── BarWidget.qml
├── Panel.qml
├── components/                 # Hud.qml, KeyRow.qml, ActionEditor.qml, DoctorRow.qml
├── lib/                        # KeyEngine.js, Actions.js, Dbus.js, Doctor.js, Defaults.js
├── host/omaremote-setup
├── tests/                      # *.test.js, fake-remote.sh
├── docs/
│   ├── superpowers/specs/2026-09-14-omaremote-design.md
│   └── hw-checklist.md
├── Makefile                    # check: node --test, qmllint, omarchy plugin validate
├── README.md                   # zh-TW + English
└── LICENSE                     # GPL-3.0 (matches both reference projects)
```

## 11. Upstream evidence for lifecycle constraints

These sources were checked for this revision; task 0 must record the installed versions and verify the runtime assumptions above.

- [Voxtype record commands](https://github.com/peteonrails/voxtype/blob/320a737e5d3c8662e0ec7de95f75407baa784d82/src/cli/record.rs) and [daemon](https://github.com/peteonrails/voxtype/blob/320a737e5d3c8662e0ec7de95f75407baa784d82/src/daemon.rs): signal-based starts/stops and cancellation request handling, including clearing cancellation when capture starts.
- [Voxtype status](https://github.com/peteonrails/voxtype/blob/320a737e5d3c8662e0ec7de95f75407baa784d82/src/cli/status.rs): JSON classes, stopped status and change-driven monitoring.
- [Voxtype config get](https://github.com/peteonrails/voxtype/blob/320a737e5d3c8662e0ec7de95f75407baa784d82/src/app/config_get.rs) and [set/unset](https://github.com/peteonrails/voxtype/blob/320a737e5d3c8662e0ec7de95f75407baa784d82/src/app/config_set.rs): resolved versus literal file value and restoring an absent entry.
- [Voxtype Omarchy plugin](https://github.com/peteonrails/voxtype/tree/320a737e5d3c8662e0ec7de95f75407baa784d82/omarchy-plugin): IPC and resident plugin conventions; [Omarchy IPC wrapper](https://github.com/basecamp/omarchy/blob/b679363bed05415771a1b1dc92c6899a908236f7/bin/omarchy-shell): bounded per-call transport timeout.
- [ATVVoice](https://github.com/b0o/ATVVoice/tree/f36286d8185cb2b9b219cd91a9c0e08091999c9d): consumer-driven mic opening does not identify who initiated capture.
- [systemd unit/job API](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html): unit invocation identity and systemd jobs must be considered separately from the `systemctl` client process.
