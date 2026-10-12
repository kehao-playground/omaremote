# omaremote — remote microphone via ATVVoice (Plan 4)

**Date:** 2026-10-12
**Status:** Draft for review
**Amends:** `2026-09-14-omaremote-design.md` §2, §3 (ATVVoice), §5.1, §5.2; `2026-10-02-omaremote-host-setup-design.md` (adds a step)

## 1. Goal

With `voice.mic = "remote"`, holding the Xiaomi remote's mic button and speaking dictates into the
focused window through Voxtype; releasing the button ends the session. No second press.

Success means: a hold of 3 s or more produces a Voxtype session that captured from the ATVVoice node
and ends on release by itself. Transcription *quality* (language, model) is out of scope; the user
configures Voxtype separately.

## 2. Measured facts this design rests on

All measured on 2026-10-09..12 against the Xiaomi Bluetooth Remote 2 Pro / RC003
(`bluetooth:v2717p32B8d00A4`) with b0o/ATVVoice at `0e8f6413dc4bad7a04e3c6b648945439d7a22fac`.

1. The remote exposes standard ATVV (`ab5e0001…`: TX `0002`, AUDIO `0003`, CTL `0004`), reachable by
   the logged-in user over BlueZ D-Bus. No root is needed to capture.
2. CAPS negotiation reports v1.0, ADPCM 16 kHz, frame size 120, model `HoldToTalk`.
3. **The audio stream lasts exactly as long as the button is physically held.** The remote sends
   `AUDIO_START(HoldToTalk)` on press and `AUDIO_STOP(HttButtonRelease)` on release. Holds of 3.3–7.3 s
   streamed continuously in every configuration tried, the normal path included (keyd running,
   omaremote running a session, Voxtype recording). A short press gives 0.1–0.2 s.
4. **Host-initiated `MIC_OPEN` yields no audio.** The remote answers with `AUDIO_START(MicOpen)`
   and then sends zero frames. A PipeWire capture during an 8 s host open was all zeros. This held
   in all three negotiated models (HTT, PTT, OnRequest). Therefore ATVVoice `--mic-on-demand`
   cannot work on this remote.
5. The remote ignores the negotiated model: advertising PTT-only or OnRequest-only changes the
   CAPS_RESP field, but the firmware still behaves as HoldToTalk and never sends `START_SEARCH`.
6. The HID mic key (F5 → keyd `xfer`) is a press-time pulse. A self-test lease counted one `down`
   per hold, whatever its length. It carries no release information, so the D-Bus stream state is
   the only release signal.
7. ATVVoice derives its D-Bus and PipeWire names from the BLE device name. The Chinese name
   `小米蓝牙语音遥控器` strips to an empty suffix, so the D-Bus name `org.atvvoice.` is invalid and
   registration fails. `--name xiaomi` avoids this (`org.atvvoice.xiaomi`, node `atvvoice-xiaomi`).
8. An earlier conclusion, "the mic button is a ~0 ms pulse and push-to-talk is impossible",
   referred to the HID layer only. Some early ATVV runs showed ~0.1 s streams on what were reported
   as holds. Their cause is still unexplained: they did not reproduce, and neither keyd nor
   Voxtype start accounts for them. Every later long hold streamed continuously, so this design
   adopts HoldToTalk as measured in (3).

## 3. Host (setup)

New `omaremote-setup atvvoice` subcommand. The default flow (`cmd_all`) becomes
`deps → keyd → binds → plugin → atvvoice → mic remote → verify`. A new option `--mic system`
skips the `atvvoice` step and ends with `mic system`, which is today's flow, for hosts that use an
external microphone. `--mic remote` is the default. Any other value is a usage error.

The `atvvoice` step:

- **Toolchain.** If `cargo` is missing, print `sudo pacman -S rustup && rustup default stable`
  and stop. This is the only step needing root; the user runs it, as with every other `sudo`.
- **Build.** `cargo install --git https://github.com/b0o/ATVVoice --rev 0e8f6413dc4bad7a04e3c6b648945439d7a22fac --locked atvvoice`
  into `~/.cargo/bin`. Skip it when `cargo install --list` already shows `atvvoice` at the pinned
  `rev` (the binary has no `--version` flag).
- **Device.** Resolve the remote's address from `bluetoothctl devices` plus
  `bluetoothctl info <addr>`, choosing the device whose UUIDs include `ab5e0001-…`. The address is
  written into the unit, not left to auto-detection. With zero or several candidates, the step
  stops and names them.
- **Unit.** Write `~/.config/systemd/user/atvvoice.service` with
  `ExecStart=%h/.cargo/bin/atvvoice --device <addr> --name xiaomi`. Do **not** pass
  `--mic-on-demand` (§2.4). `--frame-timeout` and `--keep-alive` keep their defaults.
- **Idempotence.** Three separate rules:
  - Unit content changed: write it and run `systemctl --user daemon-reload`. Unchanged: neither
    rewrite nor reload.
  - Always ensure the service is enabled and active (`enable --now`), whatever the unit content.
    A re-run therefore repairs a stopped or disabled service.
  - Restart the service when the unit changed or the build step installed a new binary, and it was
    already active, so the running process uses the new unit or binary.
- **Config.** Write `voice.remoteOnDemand: false` into omaremote's `config.json`. This is the only
  config edit this step makes, and the step announces it.
- **Mic apply.** The existing `omaremote mic remote` sets Voxtype `audio.device` to
  `atvvoice-xiaomi`. No new code.

The upstream naming bug is worked around with `--name`. Reporting it upstream is outside this plan.

## 4. Plugin — voice session

### 4.1 `voice.remoteOnDemand` (bool, default `false`)

This field describes how ATVVoice runs; it is not a user preference. `Config` normalizes any
non-boolean value to `false` and preserves unknown fields.

- `false` means a D-Bus `streaming` can only come from the physical button. From `idle`, with the
  D-Bus path enabled and no gate held, `streaming` starts a session **at once**: `voxtype record
  start`, owner `dbus`, state `starting`, all in the same tick. There is no `arbitrating` state and
  no `arbitrationMs` wait. The exception from §5.2 still applies: if the backend already reports
  `recording`, adopt it as `keyboard`.
- `true` keeps today's arbitration unchanged (§5.2 of the base spec), together with its code and
  tests.

Why: arbitration exists to tell a button press from an on-demand open caused by a capture client.
Without on-demand that ambiguity cannot arise, and the 250 ms wait plus Voxtype's start latency
would cut the first word.

### 4.2 The HID mic key in `remote` mode

`keys.mic.trigger` (`toggle | ptt | key`) applies **only when `voice.mic = "system"`**. In `remote`
mode, `Service.onKeyEdge` drops both `mic` edges before the voice path and before the engine.
Otherwise one press would arrive twice: HID would start an `hid` session, and the D-Bus start and
end would then be ignored as non-owner events.

The key is dropped even while `remoteWarning` is set. Voxtype's device is then the ATVVoice node,
so an HID-started session would record silence. Status and the HUD already say that the remote mic
is unavailable.

### 4.3 End

No change. When the owner is `dbus` and the remote leaves `streaming`, the existing re-read runs and
the stop follows. A release during `starting` latches a stop that fires on confirmation. A very
short accidental press gives a ~0.1 s ATVV stream. The resulting Voxtype session is longer, because
it includes the start command, the wait for `recording` confirmation and the stop. Voxtype handles
that short, mostly silent session. A minimum-hold threshold is
deliberately left out until use shows a need.

### 4.4 Faster discovery

`AtvvoiceMonitor` keeps its backoff rediscovery (1 s → 30 s cap). It also follows
`NameOwnerChanged` on the session bus. When a name with the `org.atvvoice.` prefix gains an owner,
it rediscovers immediately and resets the backoff. Today a daemon that starts after the Service can
take up to 30 s to be noticed.

The status JSON's `remote` object gains two fields:

- `retryMs`: the current backoff interval, kept for diagnosis.
- `retryAt`: the epoch-millisecond deadline of the next scheduled rediscovery, or 0 while a daemon
  is connected or no retry is pending.

The interval alone does not say how soon the next retry fires: with `retryMs = 4000` and the timer
3 s in, the backoff would still find a daemon 1 s later. The late-discovery test therefore reads
`retryAt`.

### 4.5 Consequence: F9 in `remote` mode

Without on-demand, a keyboard (F9) session in `remote` mode captures from the ATVVoice node and
receives silence, unless the remote's button is held at the same time. The base spec's mode table
row "keyboard F9: audio from remote via on-demand" is replaced by "no audio unless the remote button
is held; use `system` mode for F9". The Voice tab shows this line in `remote` mode.

## 5. Doctor

New rows, informational in `system` mode as today:

- `atvvoice` user unit active.
- An `org.atvvoice.*` name on the bus, with `NodeName` equal to Voxtype `audio.device` (existing
  remote checks).
- **On-demand consistency.** The unit's `ExecStart` contains `--mic-on-demand` exactly when
  `voice.remoteOnDemand` is `true`. A mismatch is an error. With on-demand running but the config
  saying `false`, an on-demand open would start an unarbitrated session.

## 6. Testing

Unit tests (`node --test`) come first:

- `Config`:
  - `voice.remoteOnDemand` defaults to `false`.
  - Non-booleans normalize to `false`.
  - Unknown fields survive.
- `VoiceSession`:
  - With `remoteOnDemand=false`, `streaming` from `idle` emits `cmd start` and state `starting` in
    the same call. To discriminate, it must also assert that no `arbitrating` state and no
    arbitration deadline exist (`nextDeadline()` is not the arbitration time).
  - With `remoteOnDemand=true`, the existing arbitration tests pass unchanged.
  - Backend `recording` plus `streaming` adopts `keyboard`.
  - A release during `starting` latches the stop.
- `Doctor`: the on-demand consistency row fails on mismatch in each direction and passes when both
  sides agree.

Integration (`tests/fake-remote.sh`, fake `busctl`):

- `s_remote_hold_session`: `streaming` reaches `recording` without passing `arbitrating`; then
  `connected` returns to `idle`.
- `s_remote_mode_ignores_hid_mic`: in `remote` mode, `ipc key mic down/up` leaves voice `idle` and
  writes nothing to `actions.log`.
- `s_atvvoice_appears_late`: start with no daemon. The backoff schedules 1 s, 2 s and then 4 s, so
  wait for the third failed discovery, when `remote.retryMs` reaches 4000. Immediately before the
  emit, read `remote.retryAt` and require `retryAt - now > 2000`; if not, wait for the next
  failure, which doubles the interval, and check again. Then let the fake daemon appear, emit
  `NameOwnerChanged`, and require `remote.state == connected` within 2 s and before `retryAt`.
  Since the next backoff retry is provably more than 2 s away at the emit, only the
  `NameOwnerChanged` handling can satisfy the assertion.
- Existing scenarios keep passing, including the six `use_ptt` scenarios, `mic_toggle_session` and
  the arbitration scenarios. Scenarios that rely on arbitration set `remoteOnDemand: true`
  explicitly.

Setup (`atvvoice` step, fake `cargo`, `systemctl` and `bluetoothctl` on `PATH`):

- The generated unit has the address and `--name xiaomi`, and no `--mic-on-demand`.
- Re-run with unchanged unit and binary: no rewrite, no `daemon-reload`, no restart, but
  `enable --now` is still issued.
- Re-run after the service was stopped or disabled: `enable --now` brings it back.
- Re-run where only the binary changed: restart, no rewrite.
- Default flow ends with `mic remote`; `--mic system` skips `atvvoice` and ends with `mic system`;
  `--mic bogus` is a usage error.
- Zero or two ATVV candidates stop the step with their names.

Hardware acceptance (user):

1. After `omaremote-setup`, check the configuration rows in the Setup tab (or
   `omarchy-shell omaremote doctor`): Voxtype healthy, `atvvoice` unit active, an
   `org.atvvoice.*` name present, `NodeName` equal to `audio.device`, and on-demand consistent.
   The last-capture row may still be unknown at this point. That is expected before the first
   session.
2. Hold the remote's mic and speak for 3 s or more, then release. Text appears without a second press.
3. The Status tab's "Last capture" row shows `atvvoice-xiaomi · remote`.
4. After `omarchy-shell omaremote mic system`, the toggle behaves as before.

## 7. Documentation changes

- Base spec §2 diagram (`atvvoice … --mic-on-demand`), §3 ATVVoice, the §5.1 D-Bus bullet and the
  pulse paragraph, and the §5.2 mode table are updated to this design, citing §2 here.
- `docs/hw-keymap-xiaomi-voice-remote.md` gains an ATVV section with facts 1–8.
- The host-setup spec lists the new step, the new default flow and the `--mic` option.

## 8. Out of scope

- Voxtype language and model configuration.
- Upstream issue or PR for the ATVVoice naming bug.
- A pre-roll buffer to recover speech before Voxtype starts.
- Minimum-hold or debounce handling.
- Typeless.
