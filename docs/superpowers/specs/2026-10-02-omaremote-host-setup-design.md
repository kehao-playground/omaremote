# OmaRemote host setup (Plan 3) — Design Spec

Supplements `2026-09-14-omaremote-design.md` (the main spec). Where the two disagree, §9 of this
document lists the main spec's text to be corrected; until that edit lands, this document wins for
the areas it covers.

Written 2026-10-02, after Plan 2 (QML host) was merged and verified on real hardware. Plan 2 proved
the plugin works when something feeds it key events. Nothing feeds it yet: this host has no keyd, no
Hyprland binds, and no setup script. Plan 3 closes that gap for one specific machine and one specific
remote, and settles one measurement that the main spec currently gets wrong.

## 1. Goal

Make the Xiaomi BT voice remote (`2717:32b8`, key map in `docs/hw-keymap-xiaomi-voice-remote.md`)
genuinely usable on this Omarchy host: button → keyd → neutral key → Hyprland bind → `GlobalShortcut`
→ plugin → action, with the microphone button starting Voxtype dictation.

### Success criteria

1. Every temporary hack from the Plan 2 verification round is gone; `host/omaremote-setup` can be
   re-run on this host from a clean state and reproduce the working configuration.
2. All 13 keys behave per `lib/Defaults.mjs DEFAULT_KEYS` — taps, holds, and repeat.
3. A long press that loses its release can no longer produce an unbounded action stream.
4. The number of `hl.bind` lines per key is backed by a measured matrix, not a guess.
5. Pressing the remote's microphone button dictates into the focused window, with audio from the
   system microphone. `DEFAULT_VOICE.mic` stays `"remote"`; `system` is reached by driving the main
   spec §3 mic-apply contract, which commits `voice.mic` to `config.json`, not by changing the default.

### In scope

- keyd installation and `/etc/keyd/omaremote.conf` for this device, seeded from the learned key map.
- Generated `~/.config/hypr/omaremote.lua` and its load verification.
- A uinput key injector, as a development tool, and the bind-edge measurement it enables.
- `lib/KeyEngine.mjs` stuck-key timeout (`timing.stuckMs`) and the `stuckKey` effect.
- Self-test lease length chosen by the caller, and a reason attached to `arm`'s `busy`.
- `host/omaremote-setup` with per-step subcommands, idempotent and re-runnable.
- The main-spec corrections in §9.

### Explicitly out of scope

- ATVVoice and `voice.mic = "remote"`. The remote's microphone *button* works without it; only the
  audio *source* needs it. `voice.mic = "system"` is what this round configures, which the main spec
  §3 already supports ("Voxtype healthy only; ATVVoice rows are informational").
- Interactive key learning (main spec §7 step 2). The learned map for this device already exists, and
  the main spec already skips learning when `device.learned` is present.
- `omaremote-setup --doctor`, `docs/hw-checklist.md`, and automating the §7 step 6 self-test.
- The mic-apply stale-error finding and the Plan 2 parked minors (final review #9–#12, #14, #17, #18, N4).

## 2. Stuck-key timeout — `lib/KeyEngine.mjs`

### Problem

Four phases can hold a key forever when a release is lost:

| location | phase | current behaviour |
|---|---|---|
| `KeyEngine.mjs:35-39` | `repeating` | each `fire` sets `deadline = now + repeatMs`, unconditionally and without bound |
| `KeyEngine.mjs:31` | `held` | no deadline at all |
| `KeyEngine.mjs:80` | `consumeRelease` | no deadline at all |
| `KeyEngine.mjs:89` | `down` | no deadline for a key with `double` but no `hold`/`repeat`/`panic` — `keyClass` gives it `long: false, simple: false`, so neither the hold nor the panic timer is armed |

Six keys are `repeat: true` (`up`, `down`, `left`, `right`, `volup`, `voldown`), so for those a lost
release is an unbounded stream of injected keystrokes recoverable only by the panic reset. This was
observed live on 2026-10-02. The other three phases produce no action stream, but a key stuck in any
of them keeps `heldKeys()` non-empty, which permanently blocks `selftestArm`. The `down` case is not
reachable with the shipped profile — no default key sets `double` — but `config.json` may set `double`
on any key, so it is a real hole rather than a theoretical one.

### Design

`DEFAULT_TIMING` gains `stuckMs: 10000`. `lib/Config.mjs:53` already iterates
`Object.keys(DEFAULT_TIMING)`, so validation and defaulting follow with no further change, and users
can override it in `config.json` like the other timings.

Patching each phase separately would be four fixes with four chances to miss a fifth. Instead the
engine gains one absolute bound per key, independent of the phase machinery:

- Per-key state gains `stuckAt`, alongside the existing `deadline`.
- `press()` sets `s.stuckAt = now + stuckMs` whenever a key leaves `idle`, and it is **not** recomputed
  on phase transitions. It therefore bounds how long a single physical press may be believed, measured
  from the press itself, which is the property actually wanted — `down → held → repeating` is one press.
- Entering `waitDouble` clears `stuckAt`: that phase is entered on release, the key is no longer
  physically down, and its `doubleMs` deadline is already bounded.
- `release()` returning a key to `idle` clears `stuckAt`.
- `fire()` checks, **before any phase-specific logic**, whether `s.stuckAt !== null && now >= s.stuckAt`.
  If so the key goes to `idle`, both timers clear, and `{ type: "stuckKey", key: n }` is pushed — and
  nothing else. The timeout must emit no `tap`, `hold`, `double` or `repeat` action of any kind. This
  ordering is a contract, not an implementation detail: if the stuck check ran after the phase logic,
  a timeout in `down` would be indistinguishable from a release and would be reported as a tap, which
  is exactly the wrong reading of a lost release.
- `advance()` and `nextDeadline()` operate on an effective due time — the earlier of `deadline` and
  `stuckAt`, ignoring nulls — so a stuck bound schedules the `tick` Timer exactly like any other deadline.
- `fresh()` and `clearAll()` reset `stuckAt` with the rest of the state.

This makes the `repeating` case fall out of the same rule rather than needing its own elapsed-time
check, and it covers the `down` hole above without special-casing `double`.

`release()` on an `idle` key already falls through `default: break` and emits nothing, so a release
arriving after the timeout is harmless without any change. `panicMs` (1500) is below `stuckMs`, so a
panic key still fires its reset first.

Chosen value: 10 s is far longer than any deliberate hold on a remote (10 s of 80 ms repeats is
already 125 actions) and far shorter than forever. It is a bound, not a UX feature.

This is an accepted tradeoff and must be documented as one rather than filed as a bug later: a user
who genuinely holds a direction key for more than `stuckMs` will see the repeat stream stop. That is
the safety boundary doing its job. The remedy is to raise `timing.stuckMs` in `config.json`, not to
weaken the bound.

### `stuckKey` is observable, but not by the §5 sweep

Service logs the effect and exposes the most recent one in `statusJson()` as `lastStuckKey`
(`{ key, at }` or null), so a release being lost in **normal operation** is visible rather than
merely suspected.

**Correction (2026-10-06).** An earlier draft of this section claimed `lastStuckKey` was §5's
measurement instrument and that the sweep should lower `stuckMs` to 2000. Both were wrong. While a
self-test lease is active, `onKeyEdge` hands each edge to `selftest.record()` and returns
(`Service.qml:213-219`), so KeyEngine never receives the edge, accumulates no per-key state, and
cannot fire `stuckKey` at all; and `selftestReport` ends the lease, after which `onSelftestEnded()`
clears `root.heldKeys` (`Service.qml:456`). The sweep's valid held-key observation is the report's
own `.held`, computed from the lease's down-without-up tracking. `lastStuckKey` belongs to the
end-to-end check with the real remote, not to the sweep.

Editing `stuckMs` from `TimingEditor.qml` is not part of this round; accepting and defaulting it in
the config schema is.

### Tests (RED first, `tests/KeyEngine.test.mjs`)

- A `repeat: true` key pressed and never released: the action stream stops, exactly one `stuckKey` is
  emitted, `heldKeys()` becomes empty, and `nextDeadline()` is finite throughout.
- One case per remaining phase, each reaching `idle` with exactly one `stuckKey`: a non-repeat long key
  (`held`), a `double` key whose release is lost after the double fired (`consumeRelease`), and a
  `double`-only key held down (`down`, the phase with no timer at all).
- A release delivered after the timeout produces no effects.
- `stuckAt` is measured from the press, not from the last phase transition: a key that transitions
  `down → held` partway through still times out at `pressedAt + stuckMs`.
- Entering `waitDouble` clears the bound, so a double-tap sequence is never cut short by it.
- `stuckMs` from `config.json` is honoured; a panic key still resets at `panicMs`.

## 3. uinput injector — `tests/inject-key.py`

Python 3, standard library only — no `python-evdev`. `fcntl.ioctl` on `/dev/uinput`: `UI_SET_EVBIT`
(EV_KEY), `UI_SET_KEYBIT` per key, `UI_DEV_SETUP`, `UI_DEV_CREATE`, write `input_event` structs,
`UI_DEV_DESTROY`. Key name to code comes from `/usr/include/linux/input-event-codes.h`, the approach
already proven by the Plan 2 `learn-keys.py` reader.

Interface:

```
sudo ./tests/inject-key.py f13 --hold-ms 120
sudo ./tests/inject-key.py --seq f13:120,f18:3000
```

**Settle delay.** After `UI_DEV_CREATE` the script waits for libinput and the compositor to finish
adding the device (300–1000 ms, tunable) before sending anything. Without it the first events are
silently dropped, and that failure reads exactly like "the bind rule is strange" — the thing this
tool exists to measure. The delay is mandatory and documented in the script.

**The injector must prove itself before it is allowed to judge.** Two independent checks, both
required before any matrix result is trusted:

1. Read the virtual device's own evdev node with `learn-keys.py` and confirm the press/release pair
   and the requested duration. Proves uinput emission and timing accuracy.
2. Inject into an ordinary Hyprland bind — not a `GlobalShortcut`. A temporary
   `hl.bind("F24", …)` running something observable (writing a file, or `notify-send`) is added, the
   injector fires F24, and the effect is confirmed. F24 is chosen because it is outside the §5 sweep
   and nothing on this host binds it. The temporary bind is removed afterwards. This proves the events
   reach the compositor's bind layer, separately from whether `GlobalShortcut` then reaches the plugin.

Safety: it emits only F13–F24 and `prog1`, which nothing on this host binds by default, so a stray
injection is inert. It never injects modifiers. Releases are sent from a `finally` block, and the
device is destroyed on every exit path.

Placement: `tests/`, because this round it is a measurement tool, not a shipped artifact. Promotion to
a product component belongs to the round that automates the §7 step 6 self-test.

## 4. keyd installation and rescue

keyd 2.6.0 (`extra`, no dependencies). Facts verified on 2026-10-02 by extracting the package without
installing it: all 26 key names this device needs pass `keyd list-keys`; the subcommands are
`monitor`, `check`, `list-keys`, `reload`, `bind`, `listen` (there is **no** injection subcommand);
`keyd.service` is exactly `ExecStart=/usr/bin/keyd`; the `[ids]` explicit-list form matches only the
listed ids; and `backspace+escape+enter` terminates keyd, which its README documents alongside a
warning that a bad config can render a machine unusable.

The steps that need root are run by the user, not by the agent — there is no askpass in this
environment, and an installer being run by its own user is the honest arrangement anyway.

1. `sudo pacman -S --needed keyd`. Install only; do not enable.
2. Stage the generated conf in a temporary directory and pass `keyd check` **before** anything is
   written under `/etc`.
3. Confirm the device id from keyd's own point of view: `sudo keyd monitor -t`, press one remote
   button, read the id, compare with `2717:32b8`. The man page names `keyd monitor` as the source of
   ids, so `/proc/bus/input/devices` is corroboration, not authority. Only on a match is
   `/etc/keyd/omaremote.conf` written.
4. **Foreground first:** `sudo /usr/bin/keyd`, which is exactly what the unit runs. While it is up,
   read the remote's evdev node with `learn-keys.py` to confirm it now emits F13–F24 and that the
   keyboard is unaffected. Ctrl-C ends it, and closing the terminal ends it.
5. The rescue paths are stated to the user *before* step 4: `backspace+escape+enter` terminates keyd;
   the conf matches only `2717:32b8`, so the keyboard is never grabbed; Ctrl+Alt+F2 gives a second TTY
   where `sudo systemctl stop keyd` works; removing the conf and running `keyd reload` reverts.
6. Only after a clean foreground run: `sudo systemctl enable --now keyd`.

`omaremote-setup keyd` never reaches step 6 without an interactive confirmation or an explicit
`--yes`. Nothing is enabled silently.

The conf for this device is the one already recorded in `docs/hw-keymap-xiaomi-voice-remote.md`.

## 5. Bind-edge measurement protocol

### Why this exists

Main spec §3 asserts "`hl.dsp.global` requests the release event itself, so a single bind delivers
press and release". Live measurement on 2026-10-02 disproved it: with one bind, `XF86Back` delivered
both edges for a short press but **lost the release on a long press**; with two binds (press plus
`{ release = true }`), the release arrived but was duplicated on short presses. That was measured on
one key, chosen because 11 of the remote's 13 native codes collide with the keyboard. With keyd in
place the real neutral keys are available and the question can be settled properly.

### Instrument

The existing self-test lease. `SelfTest.record()` counts raw press/release per key *instead of*
letting `KeyEngine` consume them (`Service.qml:213-219`), keeping IPC injections in a separate
bucket, which is exactly the measurement needed: `counts.shortcut.<key>.{down,up}` plus `.held`.

Two consequences of the engine being out of the loop are easy to get wrong, so they are stated here:
the sweep must read `.held` from the report rather than `heldKeys` from the status, and no
`stuckKey` can be produced inside a lease.

### Known limitation

A trial is discarded and retried when counts appear for a key that was not injected, but a real
press of the *same* key being injected is indistinguishable from the injection in the raw counts.
No retry can cover it, which is why not touching the remote during the sweep is a precondition of
the measurement rather than a courtesy.

### Variables

| variable | values | reason |
|---|---|---|
| bind configuration | (a) one `hl.bind`; (b) two binds, press + `{ release = true }` | the open question |
| press duration | 120 ms, 600 ms, 3000 ms | below `holdMs` (350), above hold but below `panicMs` (1500), and a long hold — duration is the variable that changed the outcome last time |
| key class | `up` (F13, `repeat: true`) and `back` (F18, long, non-repeat) | they occupy different engine phases, `repeating` versus `held`, which is where the lost release appeared |

`power` (F24) is excluded from the sweep: its tap action blanks the screen.

### Procedure, once per bind configuration

1. Write `~/.config/hypr/omaremote.lua` for that configuration, `hyprctl reload`, and verify with the
   `hyprctl binds -j` description check from main spec §3.
2. `selftestArmFor 120000` (§7) to obtain a lease id.
3. For each (key, duration): `selftestStatus <id>` to confirm the lease is still active, inject, then
   wait a settle margin.
4. `selftestReport <id>` for the counts matrix.
5. Take the held-key observation from that same report (`.held`), **not** from `ipc status`: by the
   time the report returns, the lease has ended and `root.heldKeys` has been cleared.

### Decision rule

A configuration qualifies when, for every duration and both key classes, `down >= 1` and `up >= 1`,
and the report's `.held` is empty. If both qualify, prefer one bind: fewer generated lines and no
duplicate releases. If only the two-bind configuration delivers releases, take it — `KeyEngine`
tolerating a duplicate release is verified, a loss it cannot.

**If neither configuration qualifies**, the result is reported rather than worked around: the sweep
output names which (key, duration) cells lost or duplicated an edge, and the least-bad configuration
is identified as the one with the fewest lost releases — a loss being the failure mode `stuckMs` now
bounds, and a duplicate being the one `KeyEngine` already tolerates.

**A least-bad configuration is a diagnostic, not a result.** It is explicitly not a pass, and three
things follow with no discretion: §6 stays blocked, so no official `~/.config/hypr/omaremote.lua` is
generated or installed from it; `omaremote-setup` must report failure rather than success, and must
never treat the least-bad outcome as a qualifying one; and the identified configuration may be used
only for further diagnosis, carried in the sweep output, never written to the generated file. The
reason for the rule is that this is the single most likely place for a setup script to quietly install
a known-defective configuration because it was the best of the options it saw. A per-key mixed configuration is permitted
only if the matrix shows a key class genuinely needs it; it is not adopted pre-emptively, because a
generated file with inconsistent rules per key is harder to verify than one with a uniform rule. If
the sweep cannot produce a configuration where every supported key delivers both edges at every
duration, that is a finding about the Hyprland Lua bind layer and it blocks §6, rather than being
papered over by picking the least bad option silently.

**The weighting has changed since the last round, and the matrix must record why.** When this was
first measured, a lost release on a `repeat: true` key was catastrophic: an unbounded action stream
recoverable only by the panic reset. §2's `stuckMs` closes that, so a lost release is now a bounded
defect rather than a runaway. A future reader comparing the two rounds' conclusions must be able to
see that the premise changed, not merely the taste.

### Output

The measured matrix replaces the "How many `hl.bind` lines per key is still open" bullet in
`docs/hw-keymap-xiaomi-voice-remote.md` and the corresponding passage in
`docs/superpowers/plans/2026-09-14-omaremote-qml-host-task0.md` "Correction (2026-10-02)".

## 6. Generated Hyprland config

`~/.config/hypr/omaremote.lua`, from a template in `host/`:

- A header comment marking the file generated and not to be edited by hand.
- One or two `hl.bind` lines per supported key — the count comes from §5's result — each carrying
  `description = "omaremote:<key>"`, which is what load verification keys on.
- The keyboard escape hatch from main spec §3, independent of the remote:
  `o.bind("SUPER + CTRL + ALT + R", "OmaRemote reset", "omarchy-shell omaremote reset")`.

`require("hypr.omaremote")` is appended to `~/.config/hypr/hyprland.lua` only if absent, among the
existing `require("hypr.*")` lines (currently lines 19–23). Verification after `hyprctl reload`:
`hyprctl binds -j | jq -r '.[].description | select(startswith("omaremote:"))'` must yield exactly the
expected count for every supported key, with no extras. Omarchy's own F9 Voxtype binds are never
touched. Modifier combinations are never generated: a combo stops matching once the modifier is
released first, which loses the release edge.

## 7. Self-test lease length and `arm` diagnostics

Two defects found while using the lease as a measurement instrument:

**No reason on `busy`.** `SelfTest.mjs:20` collapses six distinct conditions into one `busy`, so a
caller cannot tell "retry in 300 ms" from "a key is stuck and will never clear". `arm` gains a
`detail` field: `leaseActive`, `voiceBusy`, `backendStale`, `heldKeys:<names>`, `pendingCmds:<n>`, or
`gate`, alongside the existing `retryAfterMs`. A consumer branches on `reason` first and tolerates
`detail === undefined`: the host's own `not-ready` and `error` results carry no `detail`.

**30 s is too short.** It cannot cover a measurement sweep or any human-in-the-loop check. The lease
length becomes caller-chosen, and the default rises to 120 s with a 600 s cap.

`selftestArm()` is a zero-argument `IpcHandler` function and `tests/fake-remote.sh` calls it that way,
so its arity is not changed. A new verb `selftestArmFor(leaseMs: string)` is added; both delegate to
one `root.selftestArm(leaseMs)`, with `selftestArm()` passing the default. Out-of-range values are
clamped to [1000, 600000] ms; zero, negative, and unparseable values fall back to the 120 s default.

## 8. `host/omaremote-setup`

bash, `set -euo pipefail`, idempotent, every step runnable alone:

```
omaremote-setup              # every step in order
omaremote-setup deps         # pacman -S --needed keyd; verify jq, wtype, pw-dump, wpctl, voxtype
omaremote-setup keyd         # seed conf, keyd check, id verification, install, foreground prompt, enable on confirmation
omaremote-setup binds        # generate omaremote.lua, require line, hyprctl reload, description verification
omaremote-setup plugin       # omarchy plugin add --enable, rescanPlugins, wait for selftestPing
omaremote-setup mic system   # drive the main spec §3 mic-apply contract, poll micStatus to a terminal state
omaremote-setup verify       # description check plus one selftest arm/report sweep with the injector
```

`verify` is the only step that needs root after installation, because the injector writes to
`/dev/uinput`; run without it, the step performs the description check, reports that the transport
sweep was skipped, and does not claim a pass.

Every write is staged to a temporary file, validated, compared against the current contents, and
replaces it only on a difference, keeping the prior version as `.bak`. `device.learned` is seeded from
a table embedded in the script for this device, marked `TODO(plan4): interactive learning`, with a
`--device vendor:product` override. The script is not considered complete until it has been run on
this host and produced the working configuration — a script that only describes what was done by hand
is not a deliverable.

## 9. Corrections to the main spec

Section numbers in the left column refer to `2026-09-14-omaremote-design.md`, not to this document.

| main spec section | correction |
|---|---|
| §3 Hyprland | Delete "`hl.dsp.global` requests the release event itself, so a single bind delivers press and release" — disproved by measurement. Replace with §5's matrix result, and state that modifier combos lose the release edge. |
| §2, §7 step 6 | `wtype -P <neutral> -s 100 -p <neutral>` cannot trigger Hyprland binds on this host (Hyprland 0.56.2, Omarchy Lua config; `hyprctl keyword bind` also fails under the non-legacy parser). Replace with the uinput injector of §3. |
| §7 step 2 | `keyd -m` is not a keyd 2.6.0 subcommand; it is `keyd monitor`. Add that the `[ids]` explicit-list form guarantees the keyboard is never grabbed, the `backspace+escape+enter` rescue, and the foreground-validation-before-enable sequence of §4. |
| §3 Voxtype, §7 step 5 | `systemctl show --property=A,B,C --value` prints in systemd's own order, not request order. The host parses `Key=Value` lines without `--value`. Job format is `<id> <type>`. |
| §5.2 | The shell-exit best-effort `voxtype record cancel` is a host obligation, implemented in `Service.qml Component.onDestruction`. |
| §4.1, §4.3 | Add `timing.stuckMs` and the `stuckKey` effect from §2. Neither section currently says anything about a lost release. |
| §7 step 6 | The lease length is chosen by the caller and defaults to 120 s; `arm`'s `busy` carries a reason. |

## 10. Testing

| layer | method |
|---|---|
| `lib/KeyEngine.mjs`, `lib/SelfTest.mjs` | `node --test`, fake clock, RED first — the cases listed in §2 and §7 |
| `tests/inject-key.py` | self-verification of §3, both checks, before any matrix result is believed |
| generated keyd conf | `keyd check` on the staged file before it is installed |
| generated Lua | `hyprctl binds -j` description count per supported key |
| `host/omaremote-setup` | run on this host; each subcommand run twice to demonstrate idempotence |
| end to end | every one of the 13 keys exercised from the remote, tap and hold, plus dictation from the microphone button |

## 11. Ordering

The order is a safety property, not tidiness:

1. `lib/KeyEngine.mjs` stuck-key timeout, and the `lib/SelfTest.mjs` lease and diagnostic changes.
   Pure JS, fake clock, no host risk.
2. `tests/inject-key.py`, self-verified against an ordinary Hyprland bind while keyd is still absent.
3. keyd installed and validated per §4.
4. The §5 sweep.
5. Lua generated from the measured result.
6. `host/omaremote-setup` wrapping steps 3–5, then run on this host.
7. The §9 corrections and the documentation updates from §5.

Step 1 must precede step 4 because what step 4 deliberately provokes — a long press whose release is
lost on a `repeat: true` key — is precisely the runaway that happened on 2026-10-02. Step 2 must
precede step 3 so that "the injector is broken" and "the bind rule is strange" cannot be confused.

## 12. Known risks

- A bad keyd conf can make a machine unusable. Mitigated by `keyd check` before installation, an
  `[ids]` list that matches only the remote, foreground validation before enabling the unit, and the
  documented rescue paths. Residual risk accepted.
- The injector creates a virtual input device, so it proves "a Hyprland bind on F13 delivers these
  edges", not "the remote delivers these edges". keyd's own output is itself a uinput device, which
  makes this a close analogue rather than an equivalence. The §10 end-to-end row, with real button
  presses, is what closes the gap.
