# OmaRemote — Design Spec

**Date:** 2026-09-14
**Status:** Revised after review of bcfa1e2; approved for planning
**Target:** Omarchy master ("quattro", Lua Hyprland config), Hyprland with Lua config + `global` dispatcher, keyd ≥ 2.5, Voxtype with `record cancel`, ATVVoice with `--mic-on-demand`
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
│ manifest.json   kinds: ["bar-widget", "service"]                             │
│ Service.qml     engine host: GlobalShortcut×N → KeyEngine → ActionDispatcher │
│                 VoiceSession (owner-based; D-Bus / HID / keyboard sources)    │
│                 IpcHandler "omaremote" (test + scripting entry: key down/up)  │
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
- **Hardware-free testability is a design constraint:** the Service exposes an `IpcHandler` (`key <name> down|up`, `voice <state>`) for deterministic event sequences, and `wtype -P F13 … -p F13` exercises the real Hyprland bind → GlobalShortcut path (Hyprland routes virtual-keyboard events through binds). `hyprctl dispatch global` is **not** usable: it forwards the compositor's internal `m_passPressed`, not an explicit down/up.

### Verification-first items (Plan task 0)

These are assumptions about the Omarchy plugin API that must be confirmed by cloning a built-in plugin (`omarchy plugin clone omarchy.<id> --edit`) before other work starts:

1. A plugin may declare both `bar-widget` and `service` kinds, and BarWidget/Panel can reach the Service singleton's state.
2. A `service` may instantiate its own `PanelWindow` (for the HUD).
3. `Quickshell.Hyprland.GlobalShortcut { appid: "omaremote"; name: "up" }` receives `pressed`/`released` for `hl.bind("F13", hl.dsp.global("omaremote:up"))` (Hyprland's `dsp_global` sets `request_release`, so one bind should deliver both).
4. Voxtype opens its PipeWire capture stream only while recording (so ATVVoice `--mic-on-demand` opens the remote mic per session, not permanently).
5. The exact CLI to reach the plugin's `IpcHandler` inside the Omarchy shell process (`omarchy-shell … ipc call omaremote …` or `qs -c … ipc call …`).

Fallbacks, in order: if (1) fails, the engine moves into BarWidget.qml with Panel/HUD as its children (design unchanged, host changes). If (2) fails, HUD lives under BarWidget's Loader. If (3) fails, bind press and release separately to `exec` of the IPC command from (5). If (4) fails, drop `--mic-on-demand` and have VoiceSession call `MicOpen`/`MicClose` around every session it starts (keyboard-source sessions included).

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
hl.bind("F13", hl.dsp.global("omaremote:up"))
hl.bind("F14", hl.dsp.global("omaremote:down"))
-- … one line per learned key …
hl.bind("XF86Tools", hl.dsp.global("omaremote:mic"))   -- only if the remote has a HID mic key
```

and appends `require("hypr.omaremote")` to `hyprland.lua` once if absent (after the other `require("hypr.*")` lines). `hl.dsp.global` requests the release event itself, so a single bind delivers press and release. Load is verified with `hyprctl reload && hyprctl binds -j | jq '[.[] | select(.dispatcher=="global" and (.arg|startswith("omaremote:")))] | length'`, which must equal the number of learned keys; Doctor runs the same check. Omarchy's own F9 Voxtype binds (`default/hypr/bindings/voxtype.lua`) are never touched.

### ATVVoice

`systemctl --user enable --now atvvoice`, with a drop-in setting `ExecStart=… --mic-on-demand` so the remote mic opens whenever a PipeWire client captures from the node and closes when the client stops. Plugin consumes:

- Bus name `org.atvvoice.<name>` (any suffix; the plugin discovers it by listing names with the prefix), object `/org/atvvoice/Daemon`, interface `org.atvvoice.Daemon`.
- Methods `MicOpen`, `MicClose`, `MicToggle`.
- Properties `State` (`disconnected|connected|opening|streaming`), `DeviceAddress`, `NodeName`.
- Signal `MicStateChanged(string)`.

### Voxtype

`~/.config/voxtype/config.toml`: `[audio] device = "<NodeName>"`, `[output] mode = "type"`. `auto_submit` is left to the user. Control via `voxtype record start|stop|cancel` (`cancel` discards the current recording *or* transcription without output); state via `voxtype status --follow --format json` (`idle|recording|transcribing`).

**Mic policy.** The Voxtype device is global, so F9 (keyboard) sessions also capture from the remote. With `--mic-on-demand` this works without plugin involvement while the remote is connected. When the remote is disconnected the node is absent and F9 has no microphone: Status/Doctor show "Voxtype mic: remote (disconnected)", and the Voice tab offers a two-way switch **Voxtype mic: Remote / System default** that rewrites only the `[audio] device` line. This is the one user-config edit the plugin performs, always on an explicit click.

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
  "voice": { "maxSessionSec": 60, "stopTimeoutMs": 15000, "hud": true, "actionFlash": true }
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

`reset()` clears every key's state, calls `VoiceSession.abort()` (§5.2: `voxtype record cancel` + `MicClose`, never `stop`), closes HUD and Panel. This path is hard-coded and cannot be disabled by config.

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

`idle → recording → transcribing → idle`, plus `unconfigured` (Doctor prerequisites fail) and `recovering` (§5.3). Every session has exactly one **owner** ∈ `{dbus, hid, keyboard}`, fixed at start; only the owner's end event, the safety limits, and `abort()` can end it.

**Start (only from `idle`):**

| event | action | owner |
|---|---|---|
| D-Bus `streaming` | `voxtype record start` | `dbus` |
| HID `mic` press | `voxtype record start` | `hid` |
| Voxtype status `recording` not started by us | none (observe) | `keyboard` |

A start event while not `idle` is ignored and logged at debug level. In particular, D-Bus `streaming` caused by on-demand opening during a `hid` or `keyboard` session is ignored because the session is already `recording`.

**End (`recording → transcribing`):**

| event | owner it applies to | action |
|---|---|---|
| D-Bus leaves `streaming` | `dbus` | `voxtype record stop` |
| HID `mic` release | `hid` | `voxtype record stop` |
| Voxtype status leaves `recording` | `keyboard` | none (observe) |
| `maxSessionSec` elapsed | any | `voxtype record stop`, warning |
| `abort()` (panic / config reload / shell exit) | any | `voxtype record cancel` + `MicClose`, HUD `Reset` |

Non-owner end events are ignored: an HID release during a `keyboard` session does nothing; D-Bus leaving `streaming` during a `hid`/`keyboard` session only sets a "remote audio dropped" warning on the HUD (Voxtype keeps recording silence until its owner stops it).

**`transcribing → idle`:** Voxtype status returns to `idle`. `abort()` in `transcribing` issues `voxtype record cancel`, which discards the pending transcription; this is what makes panic safe at both stages.

### 5.3 Command failures and timeouts

- `voxtype record start` exits non-zero → session never starts; HUD flashes `Voxtype start failed`, error counter +1, state stays `idle`.
- `voxtype record stop` exits non-zero → issue `cancel`; if that also fails → `recovering`.
- `transcribing` exceeds `stopTimeoutMs` (default 15 s) → **`recovering`**: issue `voxtype record cancel`, HUD shows `recovering…`, all start events are refused. Leave `recovering` only when `voxtype status` reports `idle` (normal) or after a further `stopTimeoutMs` with no status at all (then mark the Voxtype daemon unhealthy → `unconfigured` with item "voxtype not responding"). The UI never shows `idle` while Voxtype might still emit text.

### 5.4 Degradation

Missing ATVVoice, no `org.atvvoice.*` name on the bus, Voxtype device ≠ `NodeName`, or `[output] mode ≠ "type"` → state `unconfigured`: bar glyph yellow with tooltip listing the missing items; key mapping keeps working. D-Bus monitor exit → restart with exponential backoff (1 s → 30 s cap).

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
3. **Voice** — active sources, owner of the current session, `maxSessionSec`, HUD and action-flash toggles, **Voxtype mic: Remote / System default** switch (§3), detailed stats.
4. **Setup (Doctor)** — checklist rows (✓/✗ + one-line fix command + Copy): keyd service enabled+active and `keyd check` passes on our conf; remote evdev device grabbed by keyd; `hypr/omaremote.lua` required and `hyprctl binds -j` shows one `global omaremote:*` bind per supported key; ATVVoice service active with `--mic-on-demand`; Voxtype device matches `NodeName` and `voxtype status` responds; `wtype` / `playerctl` present; config valid (§4.2). Header button "Copy full setup command" → `bash <plugin-dir>/host/omaremote-setup`. The panel never installs anything.

Every change writes `config.json` through `JsonAdapter`; the engine hot-reloads.

### 6.3 HUD

A `PanelWindow` owned by Service: layer overlay, top-centre, no exclusive zone, no keyboard focus.

- recording: red dot + `00:04` timer; transcribing: `… transcribing`; fades out on idle.
- Non-tap triggers flash the action name for 600 ms (e.g. `OK · hold → Ctrl+C`), toggleable.
- Panic reset flashes `Reset` for 1 s.

## 7. Host setup script — `host/omaremote-setup`

bash (Omarchy ships bash 5), idempotent, safe to re-run. Steps:

1. `sudo pacman -S --needed keyd wtype playerctl evtest`; `sudo systemctl enable --now keyd` (a host that never ran keyd has nothing to `reload`). ATVVoice has no AUR package: install `rustup` if `cargo` is missing, `cargo install --git https://github.com/b0o/ATVVoice`, write the user unit plus a drop-in with `--mic-on-demand`, `systemctl --user enable --now atvvoice`.
2. **Detect the remote:** list `/proc/bus/input/devices` entries matching `Remote|RC|G20` (or take `--device vendor:product`). **Learn keys:** the 13 *logical* keys are prompted one at a time via `evtest`; for each, the user presses the key, or presses `s` / waits 10 s to mark it `supported: false`. `mic` is prompted last with the hint "most ATVV remotes have no HID mic key — skipping is normal". `up down left right ok back` are required; setup aborts with a message if any of them is skipped. Results go to `config.json → device.learned` / `keys.<k>.supported`, and `/etc/keyd/omaremote.conf` is generated for supported keys only. Then `sudo keyd check /etc/keyd/omaremote.conf` (abort on error) and `sudo keyd reload`; confirm with `keyd -m` for 3 s that the remote now emits F-keys.
3. Write `~/.config/hypr/omaremote.lua` (§3); append `require("hypr.omaremote")` to `hyprland.lua` if absent; `hyprctl reload`; verify the bind count with `hyprctl binds -j` as in §3, abort on mismatch.
4. Patch only `[audio] device` in Voxtype's `config.toml` to the ATVVoice `NodeName`; verify with `voxtype status`.
5. `omarchy plugin add <repo> --enable` if not installed.

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
| integration, no hardware | `tests/fake-remote.sh`, two layers: (a) deterministic sequences through the plugin's `IpcHandler` — `… ipc call omaremote key down ok`, `sleep 0.4`, `… key up ok` — for tap/hold/double/panic and `… voice streaming|connected` for the D-Bus path; (b) real-transport check with `wtype -P F13 -s 400 -p F13`, which drives Hyprland's bind → `GlobalShortcut` without keyd or hardware. `gdbus emit --session --object-path /org/atvvoice/Daemon --signal org.atvvoice.Daemon.MicStateChanged streaming` verifies the `busctl monitor` parser end-to-end. Assert HUD state and `voxtype status` transitions, including that panic during `transcribing` produces no typed text |
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
