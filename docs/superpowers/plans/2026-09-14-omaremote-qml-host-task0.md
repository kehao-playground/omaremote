# Plan 2 Task 0 — verification findings (2026-09-14)

Run on the live Omarchy desktop (Hyprland 0.56.2, Quickshell 0.3.1, voxtype 1.0.1, keyd not
installed). `make dev-restart` + `omarchy plugin enable io.github.kehao-chen.omaremote right`
were run with the user's pre-granted go-ahead.

## Verdict table

| item | result | evidence |
|---|---|---|
| ES modules (`.mjs` named exports, Map/Set/spread/template/default params/includes) | **FAIL** (object spread) / pass (everything else) | see "ES-modules / object-spread finding" below; `es` output after work-around: `{"keys":13,"map":1,"set":2,"spread":3,"tpl":"t2","includes":true,"defaults":5,"engineAction":"action"}` |
| (1) bar-widget + service kinds; widget reaches service via `bar.shell.serviceFor` | pass | `counts` → `"widget":true` |
| (2) service-owned PanelWindow | pass | `counts` → `"hudVisible":true` after a press |
| (3) one `global` bind delivers press and release | **PASS** — settled 2026-10-07 by measurement (Plan 3 Task 6): one bind, both edges, 12/12 cells at 120/600/3000 ms | see "GlobalShortcut press+release finding", "Resolution" and "Correction (2026-10-02)" below |
| (4) Voxtype capture stream only while recording | pass | idle `0`, recording `1`, after cancel `0` |

Versions: Hyprland 0.56.2 (commit `efb50993`), Quickshell 0.3.1 (Arch package), voxtype 1.0.1,
keyd not installed (`pacman -Q keyd` → "package 'keyd' was not found").

## Raw spike output (`tests/spike-task0.sh`, real run)

```
## versions
Hyprland 0.56.2 built from branch v0.56.2 at commit efb50993780079460b0cbed1363e2166a2de1d9f clean ([gha] Nix: update inputs).
Quickshell 0.3.1 (revision , distributed by Arch Linux)
voxtype 1.0.1
keyd: not installed
## 0a ES modules from QML (Map/Set/spread/template/default params/includes/engine)
{"keys":13,"map":1,"set":2,"spread":3,"tpl":"t2","includes":true,"defaults":5,"engineAction":"action"}
## 0b bar widget reaches the service through bar.shell.serviceFor (expect widget:true)
{"press":1,"release":0,"widget":true,"hudVisible":true}
## 0c GlobalShortcut press+release from one 'global' bind (hl.dsp.global equivalent)
before={"press":1,"release":0,"widget":true,"hudVisible":true}
after={"press":1,"release":0,"widget":true,"hudVisible":true}   (expect press and release each +1)
## 0d service-owned PanelWindow (expect hudVisible:true after the press above)
{"press":1,"release":0,"widget":true,"hudVisible":true}
## 0e Voxtype opens its capture stream only while recording (expect 0 / >=1 / 0)
idle: 0
recording: 1
after cancel: 0
```

(The `press:1` visible from the first line onward is left over from the manual
`hyprctl dispatch` probe done while diagnosing item (3), run against the same live service
before this script executed — see below. It does not affect the pass/fail calls above.)

## ES-modules / object-spread finding — plan-gating, out of Task 0's file scope

**`Service.qml`, as given verbatim in the brief, does not load.** The shell's journal
(`journalctl --user -t omarchy-shell`) showed:

```
WARN qml: service plugin load failed for io.github.kehao-chen.omaremote: file:///…/Service.qml:22:15: Expected token `}'
```

pointing at the ES-check line `var o = { ...{ x: 1 }, y: 2 }`. `qmllint` reproduces the same
parse failure standalone (`Expected token \`}'  [syntax]`, exit 255) and also rejects the plain
`{ ...base, y: 2 }` form (`Unexpected token '...'`). Isolated tests of every other ES feature the
check exercises — array spread, rest params, `Map`, `Set`, default parameters, template
literals, `Array.prototype.includes` — all parse and lint clean. **Object-spread syntax
(`{...obj}`) specifically is not supported by Quickshell/Qt 6.11.2's QML JS engine**, in inline
QML script blocks or in imported `.mjs` ES modules — both go through the same QQmlJS-based
parser.

I fixed the one occurrence inside `Service.qml` (in Task 0's own file scope) by replacing it with
`Object.assign({}, { x: 1 }, { y: 2 })`, which is semantically identical and is what the `es`
output above reflects. **This does not fix the underlying library code.** `lib/*.mjs` (a Plan 1
deliverable, out of Task 0's file list, already reviewed and committed across three commits with
176 passing `node --test` tests) uses real object-spread in at least 8 places across 6 files:

```
lib/ConfigFile.mjs:42   { ...next.keys[name] }
lib/Config.mjs:21       { ...src }
lib/Config.mjs:48       { ...raw }
lib/Config.mjs:50       { ...DEFAULT_CONFIG.device, ...(isObj(raw.device) ? raw.device : {}) }
lib/Config.mjs:52       { ...t }
lib/Config.mjs:55       { ...v }
lib/SelfTest.mjs:51     { ok: …, ...r, failed: undefined }
lib/SelfTest.mjs:61     { ok: false, ...compute(lease), failed: "external-recording" }
lib/Stats.mjs:11        { ...session }
lib/Defaults.mjs:55     { ...DEFAULT_TIMING }
lib/Defaults.mjs:57     { ...DEFAULT_VOICE }
lib/MicApply.mjs:42     { state, phase: null, ...extra }
```

With the real `lib/Defaults.mjs` in place, the shell's journal shows the plugin failing to load
for exactly this reason:

```
WARN qml: service plugin load failed for io.github.kehao-chen.omaremote: file:///…/Service.qml:7:1: Script file:///…/lib/Defaults.mjs unavailable
file:///…/lib/Defaults.mjs:55:13: Unexpected token `...'
file:///…/lib/Defaults.mjs:57:12: Unexpected token `...'
```

Since `Config.mjs` imports `Defaults.mjs` and itself uses spread five more times, and
`KeyEngine.mjs` imports `Config.mjs`, **none of the three modules `Service.qml` is required to
import can load as-is.** To gather the remaining spike evidence (items 1, 2, 4, and a completed
ES check) I temporarily patched the *deployed* copies only — `~/.config/omarchy/plugins/
io.github.kehao-chen.omaremote/lib/{Defaults,Config}.mjs` — replacing each `{ ...x }` with
`Object.assign({}, x)`, confirmed the service then loads and `ping`/`es`/`counts` all respond
correctly, then restored the deployed directory to the pristine repo copy via `make dev-install`
before finishing (verified: `grep -c '\.\.\.'` back to 2 and 5 in the deployed
Defaults.mjs/Config.mjs). **The git-tracked `lib/*.mjs` files were never modified.**

**This gates Tasks 4+**: the real `Service.qml` (Task 5) imports these same modules unmodified,
per the plan's premise of reusing the Node-tested pure core as-is. Every object-spread call site
above needs rewriting to `Object.assign` (or manual property copies) before that will work. This
needs a plan-level decision, not a Task-0-scope fix.

## GlobalShortcut press+release finding — STOP, per the brief's own gate

The brief's step 6 says: "If neither [bind form] does [deliver release], **STOP and report
BLOCKED** — the plan gates on it." That is the outcome here, and it is worse than "press but no
release": **neither bind form delivered press or release at all** when triggered through
`wtype`.

1. **`hyprctl keyword bind ",F13,global,omaremote:up"`** (the brief's/script's literal form)
   fails outright on this host: `keyword can't work with non-legacy parsers. Use eval.`
   Hyprland 0.56 here uses Omarchy's Lua-based config (`~/.config/hypr/hyprland.lua` →
   `hl.bind(...)`/`o.bind(...)`), and `hyprctl keyword` does not work against it at all — the
   bind is never registered (`hyprctl binds -j` shows zero `omaremote` entries afterward).

2. **Lua fallback**, exactly as the brief describes: temporary `~/.config/hypr/omaremote.lua`
   with `hl.bind("F13", hl.dsp.global("omaremote:up"), { description = "omaremote:up" })`,
   `require("hypr.omaremote")` added to `hyprland.lua`, `hyprctl reload`. This *does* register
   correctly — `hyprctl binds -j` shows the bind (`"key":"F13","dispatcher":"__lua","arg":"11"`)
   — but `wtype -P F13 -s 100 -p F13` produced **no press and no release** (`counts` unchanged
   before/after).

3. To isolate whether this was a Quickshell/GlobalShortcut-specific problem, I bound `F13` (and
   separately `F5`, to rule out an F13-keysym quirk) to a plain `hl.dsp.exec_cmd("touch …")`
   (no Quickshell/global-shortcuts involvement at all) and ran `wtype -k F13` / `-k F5` several
   times each, with the bind confirmed present in `hyprctl binds -j` beforehand. **The exec bind
   never fired either.** This rules out anything specific to the QML `GlobalShortcut` item or the
   Wayland global-shortcuts protocol — `wtype`'s virtual-keyboard key events are not triggering
   *any* Hyprland keybind in this session, even though `hyprctl devices -j` confirms
   `hl-virtual-keyboard-wtype` registers and briefly becomes the `"main": true` keyboard while
   `wtype` runs.

4. As a sanity check on the other half of the mechanism, I dispatched the global shortcut
   directly, bypassing key injection entirely: `hyprctl dispatch 'hl.dsp.global("omaremote:up")'`
   (the plain `hyprctl dispatch global,omaremote:up` form errors — this Hyprland build routes
   `hyprctl dispatch` through the same Lua layer and needs `hl.dsp.global(...)` as the literal
   argument). **This worked**: `counts` went from `press:0` to `press:1` and `hudVisible` flipped
   to `true` in the same call — i.e. the Wayland global-shortcuts wiring between Hyprland and the
   QML `GlobalShortcut`/`PanelWindow` is functioning correctly end-to-end. It only ever delivers
   a press, though (no corresponding release from a second dispatch), and it isn't a real key
   event, so it doesn't answer item (3) as specified.

**Net finding**: items depending on the QML/Wayland side (1, 2, and the `GlobalShortcut`
plumbing itself, per the direct-dispatch probe) work. The specific thing item (3) needs —
one physical-or-virtual key producing both a press and a release through a `global` bind — could
not be demonstrated with `wtype` on this host. This may be a `wtype`/virtual-keyboard limitation
of the test method rather than a defect in the production path (the shipped design maps real
Bluetooth-remote keys through `keyd`, which is not installed here, to ordinary physical-looking
input; a real key event may behave differently from `wtype`'s virtual-keyboard-protocol
injection). That distinction could not be verified without either `keyd` configured with the
actual remote, or physical access to a key that reaches Hyprland as a normal hardware event.
Per the brief: **this stops here and is reported BLOCKED** rather than guessed at further.

## Host cleanup performed

- Deployed plugin directory (`~/.config/omarchy/plugins/io.github.kehao-chen.omaremote/`)
  restored to the pristine repo copy via `make dev-install` (temporary `Object.assign` patches
  used only to complete the other spikes were never committed and are gone from disk).
- `~/.config/hypr/omaremote.lua` removed; the `require("hypr.omaremote")` line removed from
  `~/.config/hypr/hyprland.lua`; `hyprctl reload` run — `hyprctl binds -j` shows zero
  `omaremote`-related binds, matching the pre-task baseline.
- The plugin was disabled again (`omarchy plugin disable io.github.kehao-chen.omaremote`) after
  the spikes, since it cannot load with the real (unpatched) `lib/*.mjs` — leaving it enabled
  would just sit on the bar as a permanently-broken icon. `omarchy-restart-shell` run once more
  so the live shell matches the committed repo state exactly.

## Resolution (2026-09-15, user at the machine)

Verified with a real key. Under Omarchy's Lua config every bind runs as Hyprland's `__lua`
dispatcher, so Hyprland's native press/release pairing for the `global` dispatcher does **not**
apply: a single `hl.bind(KEY, hl.dsp.global("omaremote:<name>"))` delivers the press only, and a
repeating key (`up`) ran away until `omarchy-shell omaremote reset` (the §4.3 panic path worked as
designed). Binding **both edges** delivers both:

```lua
hl.bind("Pause", hl.dsp.global("omaremote:back"))
hl.bind("Pause", hl.dsp.global("omaremote:back"), { release = true })
```

Observed: tap → `lastAction: "back:tap:Escape"`, hold ≈1 s → `"back:hold:BackSpace"`, `heldKeys: []`
after each release. Two caveats for Plan 3's setup script: (a) use unmodified keys (keyd emits plain
F13–F25) — a `SUPER + F12` test bind failed on the release edge because Omarchy's SUPER-release binds
(menu / workspaces) and modifier release ordering interfere; (b) emit two `hl.bind` lines per key,
the second with `release = true`. The temporary bind and `require("hypr.omaremote")` were removed
afterwards (`hyprctl binds -j` shows zero omaremote entries).

## Correction (2026-10-02, real remote in hand)

The 2026-09-15 conclusion above ("bind both edges") was drawn from a single keyboard key and is
**not the rule**. Measured against the real Xiaomi remote (`XF86Back`, keyd absent, counts taken
from the self-test lease, which counts raw `GlobalShortcut` edges before the engine):

| bind configuration | key | short press | long press (~2 s) |
|---|---|---|---|
| one bind | `SUPER + F12` (keyboard) | — | press only, no release → `up` ran away |
| two binds (press + `release = true`) | `Pause` (keyboard) | both edges | both edges, `heldKeys` clean |
| two binds | `XF86Back` (remote) | both edges | `down: 1, up: 2` — a duplicate release |
| one bind | `XF86Back` (remote) | both edges (`back:tap:Escape`) | hold fired, **no release** → `heldKeys: ["back"]` stuck |

So: the native `global` press/release pairing does work from a Lua-dispatched bind, but only
reliably for a short press on an unmodified key; a modifier combination loses the release (the
modmask stops matching once the modifier is released first), and on this host a long press loses it
too unless a second `release = true` bind is present — which then double-delivers the release on
short presses. `lib/KeyEngine.mjs` tolerates a duplicate `up` (verified directly: tap, hold, and
tap-then-hold with duplicated releases all resolve one action and leave `heldKeys` empty), so the
duplicate is harmless; a *missing* release is not.

**Settled 2026-10-07 (Plan 3 Task 6): ONE bind per key.** With keyd installed, the real neutral keys,
and press durations driven by `tests/inject-key.py` (accurate to under 1 ms), a single `hl.bind`
delivered both edges in 12 of 12 cells — `up`/F13 (a `repeat: true` key) and `back`/F18 (a long
non-repeat key) at 120, 600 and 3000 ms — with nothing lost, duplicated or left held. Two binds
duplicated the release in all 12. The matrix is in
`docs/hw-keymap-xiaomi-voice-remote.md`; the sweep is `tests/bind-matrix.sh`.

So the table above does **not** generalise, and the pessimistic reading of it was wrong: main spec §3's
claim that `hl.dsp.global` requests the release event itself is correct. Three things about the
2026-10-02 round explain the difference, and all three are reasons not to have promoted it to a rule:

1. **Different key, different code path.** `XF86Back` is the remote's native `KEY_BACK`, a
   consumer-control code. The product's path is keyd → `F13`–`F24`, plain function keys.
2. **Hand-timed presses.** "Long press (~2 s)" was a human holding a button. The 3000 ms cell above is
   accurate to under a millisecond, read back off the injector's own evdev node.
3. **The modifier row was always a separate phenomenon.** `SUPER + F12` losing the release is the
   modmask ceasing to match once the modifier is released first — still true, and still a reason never
   to use modifier combinations. It is not evidence about unmodified keys.

**A trap discovered while settling this, which this document's `F13`–`F24` assumption walked into.**
`/usr/share/X11/xkb/symbols/pc` never maps `<FK13>`–`<FK24>`; the default `inet(evdev)` keymap gives
them `XF86Tools`, `XF86Launch5`–`Launch9`, `XF86AudioMicMute` and `XF86Touchpad*`, with only `F19` and
`F24` keeping their own names. So "the real path is keyd → `F13`–`F24`, plain function keys" was not
true of this host: those binds could not match at all. The first sweep returned `down=0, up=0` in all
12 cells. The xkb option `fkeys:basic_13-24` makes `F13`–`F24` real, and the measurement above was
taken with it applied. Details and the full keysym table are in
`docs/hw-keymap-xiaomi-voice-remote.md`.

**Robustness finding for the spec — IMPLEMENTED 2026-10-06 (Plan 3 Task 1).** A lost release left the
key in `heldKeys` indefinitely, and for a `repeat: true` key that meant an unbounded action stream
(observed: the `up` runaway). `lib/KeyEngine.mjs` now arms one absolute per-key bound, `stuckAt =
press + timing.stuckMs` (default 10 s), checked before any phase logic, emitting a single
`{ type: "stuckKey", key }` and returning the key to `idle`. `lib/Config.mjs` raises any configured
`stuckMs` below `max(holdMs, panicMs, doubleMs) + 1` so the bound can never pre-empt a key's own
timer — including the panic reset's. `Service.qml` publishes `lastStuckKey` and a monotonic
`stuckKeyCount`.

Worth noting for anyone re-reading the trade-off above: this bound is what made the one-bind
configuration safe to choose. When this document was written, a lost release on a repeat key was
catastrophic and recoverable only by the panic reset, so the duplicate-release cost of two binds
looked cheap. The premise changed, not merely the taste — and in the end the measurement showed one
bind loses nothing anyway.

