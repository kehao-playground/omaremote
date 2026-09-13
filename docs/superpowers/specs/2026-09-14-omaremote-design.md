# OmaRemote — Design Spec

**Date:** 2026-09-14
**Status:** Approved for planning
**Plugin id:** `io.github.kehao-chen.omaremote`
**Global-shortcut appid:** `omaremote`

## 1. Goal

Turn any ATVV-class Bluetooth voice remote (G20S Pro family; Xiaomi Remote 2 Pro / RC003 once verified) into a couch controller for Omarchy: push-to-talk dictation into the focused window via Voxtype, and a configurable 13-key mapping engine, surfaced as an Omarchy Quickshell plugin with a bar widget, settings panel, and on-screen HUD.

It is a Linux re-interpretation of two macOS projects:

| macOS reference | Linux / Omarchy equivalent |
|---|---|
| `hidutil` device remap → neutral keys → `CGEventTap` | `keyd` per-device remap → F13–F24 → Hyprland `global` binds → Quickshell `GlobalShortcut` |
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
│ hyprland  ~/.config/hypr/omaremote.conf, sourced from hyprland.conf          │
│           bind = , F13, global, omaremote:up   × up to 13                    │
│ atvvoice  systemd --user; PipeWire node + D-Bus org.atvvoice.<name>          │
│ voxtype   ~/.config/voxtype/config.toml  [audio] device = <atvvoice node>    │
└──────────────────────────────────────────────────────────────────────────────┘
          │ GlobalShortcut press/release                 │ busctl monitor
          ▼                                              ▼
┌──────────── plugin  ~/.config/omarchy/plugins/io.github.kehao-chen.omaremote ─┐
│ manifest.json   kinds: ["bar-widget", "service"]                             │
│ Service.qml     engine host: 13×GlobalShortcut → KeyEngine → ActionDispatcher │
│                 VoiceSession (D-Bus signal + HID mic key → voxtype start/stop) │
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
- **Hardware-free testability is a design constraint:** `hyprctl dispatch global omaremote:<key>` simulates a key; `gdbus emit … MicStateChanged` simulates the voice signal.

### Verification-first items (Plan task 0)

These are assumptions about the Omarchy plugin API that must be confirmed by cloning a built-in plugin (`omarchy plugin clone omarchy.<id> --edit`) before other work starts:

1. A plugin may declare both `bar-widget` and `service` kinds, and BarWidget/Panel can reach the Service singleton's state.
2. A `service` may instantiate its own `PanelWindow` (for the HUD).
3. `Quickshell.Hyprland.GlobalShortcut { appid: "omaremote"; name: "up" }` receives `pressed`/`released` for `bind = , F13, global, omaremote:up`.

Fallbacks, in order: if (1) fails, the engine moves into BarWidget.qml with Panel/HUD as its children (design unchanged, host changes). If (2) fails, HUD lives under BarWidget's Loader. If (3) fails, use `bind`/`bindr … exec, qs ipc call omaremote key down|up <name>` with an `IpcHandler`.

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

### Hyprland — `~/.config/hypr/omaremote.conf`

```
bind = , F13, global, omaremote:up
bind = , F14, global, omaremote:down
… (one per learned key)
bind = , XF86Tools, global, omaremote:mic
```

`hyprland.conf` gets `source = ~/.config/hypr/omaremote.conf` appended once if absent. Omarchy's own F9 Voxtype bind is never touched.

### ATVVoice

`systemctl --user enable --now atvvoice`. Plugin consumes:

- Bus name `org.atvvoice.<name>` (any suffix; the plugin discovers it by listing names with the prefix), object `/org/atvvoice/Daemon`, interface `org.atvvoice.Daemon`.
- Methods `MicOpen`, `MicClose`, `MicToggle`.
- Properties `State` (`disconnected|connected|opening|streaming`), `DeviceAddress`, `NodeName`.
- Signal `MicStateChanged(string)`.

### Voxtype

`~/.config/voxtype/config.toml`: `[audio] device = "<NodeName>"`, `[output] mode = "type"`. `auto_submit` is left to the user. Control via `voxtype record start|stop`; state via `voxtype status --follow --format json`.

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
    "mic":  { "ptt": true }
  },
  "voice": { "maxSessionSec": 60, "stopTimeoutMs": 15000, "hud": true, "actionFlash": true }
}
```

Per-key fields: `tap`, `hold`, `double` (each an Action or absent), `repeat` (bool), `panic` (bool), `ptt` (bool, `mic` only). Unknown fields are preserved on write.

### 4.3 State machine (per key, pure JS with injected clock)

- `idle` —press→ `down`
- `down` —release within `holdMs`→ if the key has **no** `double` binding, emit `tap` **immediately** (zero latency); else → `waitDouble`
- `down` —`holdMs` elapsed→ if `hold` bound, emit `hold` → `held`; if `repeat`, emit `tap` every `repeatMs` until release → `repeating`
- `held` / `repeating` —release→ `idle` (no `tap` on release after a hold)
- `waitDouble` —press within `doubleMs`→ emit `double` → `idle` on release; timeout → emit `tap` → `idle`
- Any key with `panic: true` held for `panicMs` → `engine.reset()`; the panic key's own `hold` action does not fire.

`reset()` clears every key's state, asks VoiceSession to abort (MicClose + `voxtype record stop`), closes HUD and Panel. This path is hard-coded and cannot be disabled by config.

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
| home | `dispatch exec omarchy-menu` | — | |
| menu | Tab | — | panic |
| app | `dispatch workspace e+1` | — | |
| volup / voldown | volume +5 / −5 | — | repeat |
| power | screen off | screen lock | |
| mic | — | — | ptt |

## 5. Voice session

### 5.1 Sources

- **D-Bus (primary):** `busctl --user monitor --match "type='signal',interface='org.atvvoice.Daemon',member='MicStateChanged'"`, parsed line-by-line by `lib/Dbus.js` into `{ state }`. On start, and whenever the monitor reconnects, read the `State` and `NodeName` properties once.
- **HID mic key (secondary):** `mic` press/release from the engine when `ptt: true`.
- **Keyboard F9 (observed only):** Voxtype's own hotkey; seen through `voxtype status --follow`, updates HUD/stats, never touches ATVVoice.

### 5.2 State machine

`idle → recording → transcribing → idle`, plus `unconfigured` when Doctor prerequisites fail.

- **Enter `recording`** (first source wins; the other is a no-op while recording):
  - D-Bus `streaming` → `voxtype record start` (source `dbus`)
  - HID mic press → `busctl call … MicOpen` + `voxtype record start` (source `hid`)
  - Voxtype status shows recording without our start → source `keyboard`, HUD only
- **Leave `recording` → `transcribing`:**
  - D-Bus leaves `streaming` → `voxtype record stop`
  - HID mic release → `voxtype record stop` + `MicClose`
  - `maxSessionSec` elapsed → force stop (both), log warning
  - `engine.reset()` → force stop (both)
- **`transcribing` → `idle`:** Voxtype status returns to idle. If no transition within `stopTimeoutMs`, go `idle` and count an error.

### 5.3 Degradation

Missing ATVVoice, no `org.atvvoice.*` name on the bus, Voxtype device ≠ `NodeName`, or `[output] mode ≠ "type"` → state `unconfigured`: bar glyph yellow with tooltip listing the missing items; key mapping keeps working. D-Bus monitor exit → restart with exponential backoff (1 s → 30 s cap).

### 5.4 Stats

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

Left click → `toggle()` Panel. Middle click → `MicToggle` (quick mic test). Exposes `open() close() toggle() closeForPopoutSwitch()` and `opened`, `popoutSwitchClosing` as Omarchy's bar-widget contract requires.

### 6.2 Panel.qml (`KeyboardPanel`, same `moduleName` as the widget)

Four tabs, fully keyboard-navigable:

1. **Status** — remote / ATVVoice state and node, Voxtype status, today's stats, "Test mic (3 s)" button.
2. **Keys** — 13 rows: key · tap · hold · double · repeat☐. Editing an action opens a popover: type combo + type-specific fields; `key` type has a "press a key to capture" mode. Footer: "Reset to defaults", "Timing…" (holdMs/doubleMs/repeatMs).
3. **Voice** — active sources, `maxSessionSec`, HUD and action-flash toggles, detailed stats.
4. **Setup (Doctor)** — checklist rows (✓/✗ + one-line fix command + Copy): keyd service and conf present; remote evdev device grabbed by keyd; hypr include sourced and all global shortcuts registered; ATVVoice service active; Voxtype device matches; `wtype` / `playerctl` present. Header button "Copy full setup command" → `bash <plugin-dir>/host/omaremote-setup`. The panel never installs anything.

Every change writes `config.json` through `JsonAdapter`; the engine hot-reloads.

### 6.3 HUD

A `PanelWindow` owned by Service: layer overlay, top-centre, no exclusive zone, no keyboard focus.

- recording: red dot + `00:04` timer; transcribing: `… transcribing`; fades out on idle.
- Non-tap triggers flash the action name for 600 ms (e.g. `OK · hold → Ctrl+C`), toggleable.
- Panic reset flashes `Reset` for 1 s.

## 7. Host setup script — `host/omaremote-setup`

bash (Omarchy ships bash 5), idempotent, safe to re-run. Steps:

1. `sudo pacman -S --needed keyd wtype playerctl`. ATVVoice has no AUR package: install `rustup` if `cargo` is missing, then `cargo install --git https://github.com/b0o/ATVVoice`, write the user unit, `systemctl --user enable --now atvvoice`.
2. **Detect the remote:** list `/proc/bus/input/devices` entries matching `Remote|RC|G20` (or take `--device vendor:product`). **Learn keys:** run `evtest` on that device and prompt the user to press each of the 13 keys once; record the source keycodes into `config.json → device.learned` and generate `/etc/keyd/omaremote.conf`; `sudo keyd reload`.
3. Write `~/.config/hypr/omaremote.conf`; append `source = …` to `hyprland.conf` if absent; `hyprctl reload`.
4. Patch only `[audio] device` in Voxtype's `config.toml` to the ATVVoice `NodeName`.
5. `omarchy plugin add <repo> --enable` if not installed.

`omaremote-setup --doctor` performs checks only and prints the same JSON the Panel Doctor renders; both use `lib/Doctor.js` rules so they can never disagree.

## 8. Error handling

- Any missing subsystem degrades that feature only; nothing else stops.
- Never let an exception escape into the Omarchy shell process: every `Process` has `onExited` logging; long-running monitors auto-restart with backoff.
- Corrupt `config.json` → use built-in defaults, mark `unconfigured` with a "config invalid" item, never overwrite the user's file.
- `engine.reset()` (panic) is the single hard-coded escape hatch.

## 9. Testing

| layer | method |
|---|---|
| `lib/*.js` (KeyEngine, Actions, Dbus, Doctor rules) | `node --test tests/`; engine tests use a fake clock and cover every timing window and conflict (double during hold, panic during repeat, release after hold, etc.) |
| QML | `qmllint -I "$OMARCHY_PATH/shell"` + `omarchy plugin validate .`, wired into `make check` |
| integration, no hardware | `tests/fake-remote.sh`: sequences of `hyprctl dispatch global omaremote:<key>` (tap/hold/double) and `gdbus emit --session --object-path /org/atvvoice/Daemon --signal org.atvvoice.Daemon.MicStateChanged streaming|connected`; assert HUD state and `voxtype status` transitions |
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
