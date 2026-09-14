# OmaRemote — Design Spec

**Date:** 2026-09-14
**Status:** Revised after reviews of bcfa1e2, 9bccea7 and 4c799a1; approved for planning
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
- **No second Quickshell process, no systemd units, no scripts executed by the plugin except the documented tools** (`wtype`, `wpctl`, `playerctl`, `voxtype`, `busctl`, `hyprctl`).
- **Hardware-free testability is a design constraint:** the Service exposes an `IpcHandler` reachable as `omarchy-shell omaremote <verb> …` (`key <name> down|up`, `voice <state>`, `reset`, `selftest …`) for deterministic event sequences, and `wtype -P F13 … -p F13` exercises the real Hyprland bind → GlobalShortcut path (Hyprland routes virtual-keyboard events through binds). `hyprctl dispatch global` is **not** usable: it forwards the compositor's internal `m_passPressed`, not an explicit down/up.

### Verification-first items (Plan task 0)

These are assumptions about the Omarchy plugin API that must be confirmed by cloning a built-in plugin (`omarchy plugin clone omarchy.<id> --edit`) before other work starts:

1. A plugin may declare both `bar-widget` and `service` kinds, and BarWidget/Panel can reach the Service singleton's state.
2. A `service` may instantiate its own `PanelWindow` (for the HUD).
3. `Quickshell.Hyprland.GlobalShortcut { appid: "omaremote"; name: "up" }` receives `pressed`/`released` for `hl.bind("F13", hl.dsp.global("omaremote:up"))` (Hyprland's `dsp_global` sets `request_release`, so one bind should deliver both).
4. Voxtype opens its PipeWire capture stream only while recording (so ATVVoice `--mic-on-demand` opens the remote mic per session, not permanently).
Already settled by Voxtype's own Omarchy plugin (`peteonrails/voxtype/omarchy-plugin`, id `io.voxtype.settings`): a plugin's `IpcHandler { target: "<id>" }` is reachable as `omarchy-shell <id> <verb> [args]`; `"keepLoaded": true` in the manifest instantiates the plugin with the shell so the IPC target exists before any UI is opened (changing that flag needs `omarchy-restart-shell`, not `rescanPlugins`); `omarchy-shell shell rescanPlugins` picks up a hand-copied plugin.

Fallbacks, in order: if (1) fails, the engine moves into BarWidget.qml with Panel/HUD as its children (design unchanged, host changes). If (2) fails, HUD lives under BarWidget's Loader. If (3) fails, bind press and release separately to `exec` of `omarchy-shell omaremote key <name> down|up`. If (4) fails, drop `--mic-on-demand` and have VoiceSession call `MicOpen`/`MicClose` around every session it starts (keyboard-source sessions included).

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

**Load verification.** For Lua binds `hyprctl binds -j` reports `dispatcher` as the handler's Lua function string and `arg` as a registry reference, so the check keys on the `description` we set: `hyprctl reload && hyprctl binds -j | jq -r '.[].description | select(startswith("omaremote:"))'` must yield exactly the supported key set. That proves the binds loaded, not that they reach the plugin; the **transport self-test** (§7 step 6 / §9) proves the latter. Doctor runs the same description check. Omarchy's own F9 Voxtype binds (`default/hypr/bindings/voxtype.lua`) are never touched.

### ATVVoice

`systemctl --user enable --now atvvoice`, with a drop-in setting `ExecStart=… --mic-on-demand` so the remote mic opens whenever a PipeWire client captures from the node and closes when the client stops. Plugin consumes:

- Bus name `org.atvvoice.<name>` (any suffix; the plugin discovers it by listing names with the prefix), object `/org/atvvoice/Daemon`, interface `org.atvvoice.Daemon`.
- Methods `MicOpen`, `MicClose`, `MicToggle`.
- Properties `State` (`disconnected|connected|opening|streaming`), `DeviceAddress`, `NodeName`.
- Signal `MicStateChanged(string)`.

### Voxtype

`~/.config/voxtype/config.toml`: `[audio] device = "<NodeName>"`, `[output] mode = "type"`. `auto_submit` is left to the user. Control via `voxtype record start|stop|cancel` (`cancel` discards the current recording *or* transcription without output); state via `voxtype status --follow --format json` (`idle|recording|transcribing`).

**Mic modes (`voice.mic` in `config.json`, mirrored into Voxtype's `audio.device`):**

| mode | Voxtype `audio.device` | remote button (D-Bus) | keyboard F9 | prerequisites for `ready` |
|---|---|---|---|---|
| `remote` (default after setup) | ATVVoice `NodeName` | starts a session, audio from remote | audio from remote via on-demand; **no microphone while the remote is disconnected** (Status shows "remote mic: disconnected") | Voxtype healthy + ATVVoice active + device == `NodeName` |
| `system` | `"default"` | still starts a session (if ATVVoice is present), audio from the system mic — the remote acts as a PTT button | normal Voxtype behaviour | Voxtype healthy only; ATVVoice rows are informational |

**Mic apply contract** (one implementation, in the plugin; the Voice tab and `omarchy-shell omaremote mic remote|system` both call it, and setup uses the IPC verb rather than re-implementing it). Voxtype does not reload its config, so:

1. **apply** — `voxtype config set audio.device <value>`; if VoiceSession is not `idle`, wait for `idle` first (HUD: "mic change applies after this dictation"; a 60 s cap then aborts the apply with rollback).
2. **restart** — `systemctl --user restart voxtype`.
3. **verify** — within 10 s, `systemctl --user is-active voxtype` must be `active` **and** `voxtype status --format json` must report `idle`. `stopped` (what `status` prints, with exit 0, when no daemon is running), any other state, a non-zero exit, or the timeout all count as failure.
4. **commit** — only now write `voice.mic` to `config.json` and report success.
5. **rollback** on any failure of 1–3: `config set` the previous value, restart, verify again; report the original error plus whether rollback verified. If rollback also fails the session state becomes `unconfigured` with item "voxtype restart failed".

The capture device is verified on the next session: `pw-dump` must show Voxtype's stream linked to the expected node; the result appears in Status as "last session captured from: <node>" and Doctor reports a mismatch as a warning. This is the one user-config edit the plugin performs, always on an explicit request.

### Plugin-side files

- `~/.config/omaremote/config.json` — user config (schema §4.2). Created with defaults on first run if absent.
- `~/.local/share/omaremote/stats.json` — voice session stats (§5.4).

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

- **D-Bus — remote mic button:** `busctl --user monitor --match "type='signal',interface='org.atvvoice.Daemon',member='MicStateChanged'"`, parsed by `lib/Dbus.js` into `{ state }`. The remote's own button makes ATVVoice go `streaming`; that is the start signal. On start and after every monitor reconnect the `State` and `NodeName` properties are read once.
- **HID mic key:** `mic` press/release from the engine when `ptt: true` (rare; most ATVV remotes have no HID mic key).
- **Keyboard (F9 / any other Voxtype hotkey):** observed through `voxtype status --follow --format json`.

### 5.2 State machine

`idle → starting → recording → transcribing → idle`, plus `arbitrating` (below), `recovering` (§5.3) and `unconfigured`. `unconfigured` means **Voxtype itself** is unusable (binary/daemon missing, `output.mode ≠ "type"`, daemon not answering); remote-side problems (ATVVoice down, device mismatch in `remote` mode, remote disconnected) only set a `remoteWarning` shown in Status/HUD and disable the D-Bus start path — keyboard and HID sessions keep working. Every session has exactly one **owner** ∈ `{dbus, hid, keyboard}`; only the owner's end event, the safety limits, and `abort()` can end it.

**Start.** `voxtype record start` only delivers SIGUSR1; a zero exit does not mean audio is flowing (the daemon may stay `idle` if the capture device vanished). A session is therefore **confirmed only when `voxtype status` reports `recording`**:

| event (from `idle`) | action | owner | next state |
|---|---|---|---|
| HID `mic` press | `voxtype record start` | `hid` | `starting` |
| D-Bus `streaming` | see arbitration below | `dbus` or `keyboard` | `arbitrating` |
| Voxtype status `recording` not requested by us | none (observe) | `keyboard` | `recording` |

- `starting` → `recording` when status shows `recording`; HUD shows `starting…` meanwhile. If the owner releases during `starting`, the release is remembered and the stop is issued the moment `recording` is observed. If `startTimeoutMs` (1500) passes with no `recording`: `voxtype record cancel`, HUD `no audio from Voxtype`, error +1, → **`recovering`** (§5.3) — not `idle`, because `cancel` only files a request and a late `recording` from the cancelled start may still arrive.
- **Arbitration** (`arbitrating`, `remote` mic mode only): D-Bus `streaming` is ambiguous — it is either the remote button, or the on-demand open caused by a keyboard session whose `recording` status has not reached us yet (Voxtype opens capture before it writes its state, and the two monitors have no ordering guarantee; the status file carries no trigger source, so there is no evidence to consult). In `system` mode Voxtype never captures from the node, so `streaming` is unambiguous and arbitration is skipped. Rules while `arbitrating`:
  - status already `recording`, or `recording` arrives within `arbitrationMs` (250) → adopt as `keyboard` owner → `recording`.
  - D-Bus leaves `streaming` (button released, or remote dropped) → arbitration cancelled → `idle`, nothing sent. A short remote tap therefore never issues a `record start` after the user has let go.
  - `abort()` → `idle`.
  - timer expires with none of the above → `voxtype record start`, owner `dbus`, → `starting`.
  - **This is a heuristic, not a guarantee.** If a keyboard session's `recording` status arrives later than 250 ms, the session is misattributed to `dbus`. Consequences are bounded and enumerated: our `record start` is a no-op (Voxtype ignores SIGUSR1 unless idle), so no second session exists; the extra `record stop` we send when the on-demand stream closes arrives after Voxtype has already stopped and is a no-op; the only observable effect is that a remote-audio drop mid-session stops the keyboard session — which had no other audio source anyway. `arbitrationMs` is configurable, and tests cover release-before-timeout, `recording` at 100 ms, and `recording` at 300 ms (misattribution path, asserting the bounded behaviour above).
- Any start event while not `idle` is ignored at debug level; in particular on-demand `streaming` during a `hid`/`keyboard` session and the `recording` status of a session we requested ourselves. The "adopt as `keyboard`" rule applies **only** from `idle` or `arbitrating`, never from `recovering` (§5.3).

**End (`recording → transcribing`):**

| event | owner it applies to | action |
|---|---|---|
| D-Bus leaves `streaming` | `dbus` | `voxtype record stop` |
| HID `mic` release | `hid` | `voxtype record stop` |
| Voxtype status leaves `recording` | `keyboard` | none (observe) |
| `maxSessionSec` elapsed | any | `voxtype record stop`, warning |
| `abort()` (panic / config reload / shell exit) | any | `voxtype record cancel` + `MicClose`, HUD `Reset`, → `recovering` |

Non-owner end events are ignored: an HID release during a `keyboard` session does nothing; D-Bus leaving `streaming` during a `hid`/`keyboard` session only sets a "remote audio dropped" warning on the HUD (Voxtype keeps recording silence until its owner stops it). In `system` mic mode D-Bus transitions never carry that warning, since the audio does not come from the remote.

**`transcribing → idle`:** Voxtype status returns to `idle`. `abort()` in `transcribing` issues `voxtype record cancel`, which discards the pending transcription; this is what makes panic safe at both stages.

### 5.3 Command failures and timeouts

- `voxtype record start` exits non-zero → session never starts; HUD flashes `Voxtype start failed`, error counter +1, state stays `idle`. Exit zero merely moves to `starting` (§5.2).
- `voxtype record stop` exits non-zero → issue `cancel`; if that also fails → `recovering`.
- `transcribing` exceeds `stopTimeoutMs` (default 15 s) → **`recovering`**: issue `voxtype record cancel`, HUD shows `recovering…`, all start events are refused.
- **`recovering`** is entered from any path that issued `cancel` without yet seeing the backend settle (start timeout, stop failure, transcribe timeout, `abort()`). `cancel` only files a request, so a late `recording`/`transcribing` status may still arrive; while `recovering`, such transitions are attributed to the cancelled work and never adopted as a new `keyboard` session. Leave `recovering` only when `voxtype status` reports `idle` **after** the cancel was issued (a `recording → idle` or `transcribing → idle` edge, or an `idle` reading on the next poll), or after a further `stopTimeoutMs` with no status at all (then mark the Voxtype daemon unhealthy → `unconfigured` with item "voxtype not responding"). The UI never shows `idle` while Voxtype might still emit text.

### 5.4 Degradation

Voxtype missing/not answering or `output.mode ≠ "type"` → `unconfigured` (no sessions; bar glyph yellow; key mapping keeps working). In `remote` mode, missing ATVVoice / no `org.atvvoice.*` on the bus / `audio.device ≠ NodeName` → `remoteWarning` (glyph shows a warning dot, D-Bus start path disabled, keyboard/HID sessions still allowed). In `system` mode the ATVVoice checks are informational only. D-Bus monitor exit → restart with exponential backoff (1 s → 30 s cap).

### 5.5 Stats

Append per session to `~/.local/share/omaremote/stats.json`: `{ startedAt, durationSec, source }`. Panel shows today / this week / all-time counts and seconds and the longest session. No audio or transcribed text is stored.

## 6. UI

### 6.1 BarWidget.qml

One remote glyph coloured by Service state using Omarchy theme tokens:

| state | look |
|---|---|
| `unconfigured` | yellow; tooltip lists missing items |
| `disconnected` | dimmed (ATVVoice `disconnected` or remote absent) |
| `ready` | foreground |
| `recording` | red with slow pulse; elapsed seconds beside it |
| `transcribing` | foreground with spinner |

Left click → `toggle()` Panel. Middle click → `MicToggle` (quick mic test; the only place besides `abort()` that touches ATVVoice's mic methods). Exposes `open() close() toggle() closeForPopoutSwitch()` and `opened`, `popoutSwitchClosing` as Omarchy's bar-widget contract requires.

### 6.2 Panel.qml (`KeyboardPanel`, same `moduleName` as the widget)

Four tabs, fully keyboard-navigable:

1. **Status** — remote / ATVVoice state and node, Voxtype status, today's stats, "Test mic (3 s)" button.
2. **Keys** — 13 rows: key · tap · hold · double · repeat☐. Editing an action opens a popover: type combo + type-specific fields; `key` type has a "press a key to capture" mode. Footer: "Reset to defaults", "Timing…" (holdMs/doubleMs/repeatMs).
3. **Voice** — active sources, owner of the current session, `maxSessionSec`, HUD and action-flash toggles, **Voxtype mic: Remote / System default** switch (§3, applies via `voxtype config set` + idle-time restart), detailed stats.
4. **Setup (Doctor)** — checklist rows (✓/✗ + one-line fix command + Copy): keyd service enabled+active and `keyd check` passes on our conf; remote evdev device grabbed by keyd; `hypr/omaremote.lua` required and `hyprctl binds -j` shows one `global omaremote:*` bind per supported key; Voxtype ≥ 0.8 present, `voxtype status` responds, `output.mode == "type"`; per `voice.mic` mode: ATVVoice service active with `--mic-on-demand` and `audio.device == NodeName` (`remote`) or `audio.device` resolves to an existing PipeWire source (`system`); last session's captured node matches; at least one supported key has `panic: true`; `wtype` / `playerctl` present; config valid (§4.2). Each row states which mode it applies to. Header button "Copy full setup command" → `bash <plugin-dir>/host/omaremote-setup`. The panel never installs anything.

Every change writes `config.json` through `JsonAdapter`; the engine hot-reloads.

### 6.3 HUD

A `PanelWindow` owned by Service: layer overlay, top-centre, no exclusive zone, no keyboard focus.

- recording: red dot + `00:04` timer; transcribing: `… transcribing`; fades out on idle.
- Non-tap triggers flash the action name for 600 ms (e.g. `OK · hold → Ctrl+C`), toggleable.
- Panic reset flashes `Reset` for 1 s.

## 7. Host setup script — `host/omaremote-setup`

bash (Omarchy ships bash 5), idempotent, safe to re-run. Steps:

1. `sudo pacman -S --needed keyd wtype playerctl evtest`; `sudo systemctl enable --now keyd` (a host that never ran keyd has nothing to `reload`). ATVVoice has no AUR package: install `rustup` if `cargo` is missing, `cargo install --git https://github.com/b0o/ATVVoice`, write the user unit plus a drop-in with `--mic-on-demand`, `systemctl --user enable --now atvvoice`.
2. **Detect the remote:** list `/proc/bus/input/devices` entries matching `Remote|RC|G20` (or take `--device vendor:product`). **Learn keys** — skipped when `config.json → device.learned` already exists for this vendor:product unless `--relearn` is given. keyd holds the remote with `EVIOCGRAB`, so on a re-run `evtest` would see nothing: learning runs inside `sudo systemctl stop keyd` … `start keyd`, with a `trap` that restarts keyd on any exit or Ctrl-C. Exclusivity is tested by the grab itself: learning uses `evtest --grab`, and a failed grab (`EBUSY`) aborts with the holder list from `fuser -v` as a diagnostic only — normal readers such as the compositor's libinput also keep the node open and coexist with `evtest`, so open handles are never treated as a conflict. The 13 *logical* keys are then prompted one at a time via `evtest`; for each, the user presses the key, or presses `s` / waits 10 s to mark it `supported: false`. `mic` is prompted last with the hint "most ATVV remotes have no HID mic key — skipping is normal". `up down left right ok back` are required; setup aborts with a message if any of them is skipped. **Panic guarantee:** if the key carrying `panic: true` (default `menu`) was skipped, setup asks the user to choose a panic key among the supported non-navigation keys in the order `home, app, power, back`; the chosen key gets `panic: true` and loses any `hold`/`repeat` (exclusivity rule §4.2). Results go to `config.json → device.learned` / `keys.<k>.supported`, and `/etc/keyd/omaremote.conf` is generated for supported keys only. Then `sudo keyd check /etc/keyd/omaremote.conf` (abort on error) and `sudo keyd reload`; confirm with `keyd -m` for 3 s that the remote now emits F-keys.
3. Write `~/.config/hypr/omaremote.lua` (§3); append `require("hypr.omaremote")` to `hyprland.lua` if absent; `hyprctl reload`; verify the description set with `hyprctl binds -j` as in §3, abort on mismatch.
4. `omarchy plugin add <repo> --enable` if not installed; `omarchy-shell shell rescanPlugins`; wait until `omarchy-shell omaremote selftest ping` answers.
5. `omarchy-shell omaremote mic remote` — runs the mic apply contract from §3 (apply → restart → verify active + `idle` → commit, rollback on failure) inside the plugin, so setup and the Voice tab share one implementation; setup fails if the verb reports failure.
6. **Transport self-test:** `omarchy-shell omaremote selftest arm` puts the Service into **test mode**: KeyEngine still runs, but ActionDispatcher and VoiceSession are detached and replaced by a recorder, so nothing is typed, dispatched, or recorded — Power does not blank the screen, OK does not send Return, `mic` does not start Voxtype; real remote presses during the window are recorded too, not executed; HUD shows `self-test`. Then for every supported key `wtype -P <neutral> -s 100 -p <neutral>`; `omarchy-shell omaremote selftest report` must list every supported key with one press and one release, and **disarms** test mode. Test mode also disarms itself on `abort()` or after 30 s without `report`, and `report` after auto-disarm returns an error rather than partial data. This is the only step that proves keyd-independent delivery from Hyprland to the plugin; a mismatch names the missing keys and exits non-zero.

`omaremote-setup --doctor` performs checks only and prints the same JSON the Panel Doctor renders; both use `lib/Doctor.js` rules so they can never disagree.

## 8. Error handling

- Any missing subsystem degrades that feature only; nothing else stops.
- Never let an exception escape into the Omarchy shell process: every `Process` has `onExited` logging; long-running monitors auto-restart with backoff.
- Corrupt `config.json` → use built-in defaults, mark `unconfigured` with a "config invalid" item, never overwrite the user's file.
- `engine.reset()` (panic) is the single hard-coded escape hatch; it cancels (never stops-and-transcribes) any voice work.

## 9. Testing

| layer | method |
|---|---|
| `lib/*.js` (KeyEngine, Actions, Dbus, Doctor rules) | `node --test tests/`; engine tests use a fake clock and cover every timing window and conflict (double during hold, panic during repeat, release after hold, etc.) |
| QML | `qmllint -I "$OMARCHY_PATH/shell"` + `omarchy plugin validate .`, wired into `make check` |
| integration, no hardware | `tests/fake-remote.sh`, two layers: (a) deterministic sequences through the plugin's `IpcHandler` — `omarchy-shell omaremote key ok down`, `sleep 0.4`, `omarchy-shell omaremote key ok up` — for tap/hold/double/panic and `omarchy-shell omaremote voice streaming|connected` for the D-Bus path; (b) real-transport check with `wtype -P F13 -s 400 -p F13`, which drives Hyprland's bind → `GlobalShortcut` without keyd or hardware. `gdbus emit --session --object-path /org/atvvoice/Daemon --signal org.atvvoice.Daemon.MicStateChanged streaming` verifies the `busctl monitor` parser end-to-end. Assert HUD state and `voxtype status` transitions, including: panic during `transcribing` produces no typed text; `starting` times out to `idle` when Voxtype never reports `recording`; `streaming` released before the arbitration timer sends no `record start`; keyboard `recording` at 100 ms yields a `keyboard` owner and at 300 ms the documented bounded misattribution; a start timeout enters `recovering` and a late `recording` is not adopted as a new session; a mic-mode switch while recording is applied only after `idle`, and a switch whose restart leaves `voxtype status` at `stopped` rolls back; `selftest arm` suppresses every action and voice start |
| hardware | with a G20S Pro / RC003: run setup → Doctor all green → manual checklist in `docs/hw-checklist.md` |

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
