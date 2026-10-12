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
9. Voxtype 1.1.0 captures only through cpal's ALSA host (it links libasound only). `audio.device`
   must be an ALSA PCM name that ALSA lists through its hints. A PipeWire node name is not one:
   with `audio.device = atvvoice-xiaomi` every start logged `Audio device not found:
   'atvvoice-xiaomi'. Available devices: pipewire, default, sysdefault:CARD=PCH` and the session
   ended in `start-timeout` (hardware acceptance, 2026-10-12). Defining
   `pcm.atvvoice-xiaomi { type pipewire; capture_node "atvvoice-xiaomi"; hint { show on ... } }`
   makes `arecord -L` list it and `arecord -D atvvoice-xiaomi` capture from the remote's node
   (`pw-link` shows the stream linked to `atvvoice-xiaomi:capture_MONO`). Hyphens are fine in the
   PCM id. Naming the PCM exactly like the node means `audio.device = <NodeName>` and the doctor's
   equality check need no change.

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
- **Config.** No omaremote config edit: `voice.remoteOnDemand` defaults to `false`, which matches
  the unit this step writes. A user who later adds `--mic-on-demand` must also set the field to
  `true`. Doctor (§5) reports a mismatch.
- **ALSA PCM.** (§2.9) Maintain a marker block in `${OMAREMOTE_ALSA_RC:-~/.config/alsa/asoundrc}`
  (alsa.conf loads this XDG path):
  `# BEGIN omaremote atvvoice (managed by omaremote-setup; do not edit)` ... `# END omaremote atvvoice`
  around `pcm.atvvoice-xiaomi { type pipewire; capture_node "atvvoice-xiaomi"; hint { show on
  description "ATVVoice remote (atvvoice-xiaomi)" } }`. The PCM name, the node and the unit's
  `--name` derive from one constant. The block is replaced in place or appended; every line outside
  the markers is preserved, unbalanced markers stop the step, and the file is written only when the
  result differs. **Prerequisite:** the PipeWire ALSA plugin
  (`/usr/share/alsa/alsa.conf.d/50-pipewire.conf` or `libasound_module_pcm_pipewire.so`), checked
  with the device resolution, before the build; if absent the step stops with
  `sudo pacman -S --needed pipewire-alsa`. When the block changed and the `voxtype` user service is
  active it is `try-restart`ed so it re-reads ALSA's config. Order: resolve device and prerequisite,
  build, unit, ALSA block, enable/restart.
- **Mic apply.** The existing `omaremote mic remote` sets Voxtype `audio.device` to
  `atvvoice-xiaomi`. The plugin refuses it until it has read ATVVoice's `NodeName`, and
  `enable --now` returns before ATVVoice has connected to the remote, so setup first polls
  `status → .remote.node` for up to 30 s, asks once for a button press to wake the remote, and on
  timeout stops naming `omaremote-setup mic remote` as the retry.

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

The same signal reports a departure: the name, the old owner, and an empty new owner. When the name
being used loses its owner, the monitor stops the `MicStateChanged` monitor process. Its exit then
runs the existing `_lost()` path, and Status reports `absent`. Today a stopped daemon goes unnoticed,
because `busctl monitor` filters by match rule and keeps running after the sender disappears.
Measured signal shape:
`{"sender":"org.freedesktop.DBus","member":"NameOwnerChanged","payload":{"type":"sss","data":["org.atvvoice.xiaomi","",":1.66819"]}}`.

**Owner changes, including races.** Losing the current owner revokes the source *at once*: the
sender and bus name are cleared, the generation is bumped, and the old `MicStateChanged` monitor is
told to stop. It must not wait for that monitor's exit callback. A rediscovery requested while the
old monitor is still exiting is kept pending, and the old monitor's exit then neither clears the new
connection nor triggers a backoff. Two orders must work:

- A departure immediately followed by an arrival, possibly before the old monitor has exited.
- A direct owner replacement: a non-empty old owner and a different non-empty new owner in one
  signal.

While connected, only the current name's own owner change matters. Another `org.atvvoice.*` name
appearing or leaving leaves the current source alone; before a connection exists, any arrival
triggers discovery.

Every owner lookup carries a request id, and only the latest lookup's result is accepted. A result
from a lookup started before a revocation or a newer discovery is stale, even when the bus name has
been filled in again since. A source *epoch* advances on every change of source. Each property read
(`NodeName`, the initial `State`, explicit `State` re-reads) records the epoch at launch, and a reply
from an older epoch is dropped. Otherwise a departed daemon's `streaming` could be taken as the new
daemon's signal and start a session. A read requested while the same read is still in flight runs
again after it, rather than being lost. This logic is a pure module,
`lib/AtvSource.mjs`, driven by `AtvvoiceMonitor.qml`, so the orderings are unit-tested
deterministically rather than raced in integration.

The status JSON's `remote` object gains two fields:

- `retryMs`: the current backoff interval, kept for diagnosis.
- `retryAt`: the epoch-millisecond deadline of the next scheduled rediscovery, or 0 while a daemon
  is connected or no retry is pending.

The interval alone does not say how soon the next retry fires: with `retryMs = 4000` and the timer
3 s in, the backoff would still find a daemon 1 s later. The late-discovery test therefore reads
`retryAt`.

### 4.5 The daemon disappearing mid-session

When the source is revoked (§4.4) or lost, the voice session is told so explicitly with
`VoiceSession.sourceLost(now)`. Without this, ATVVoice exiting during a hold leaves Voxtype recording
until `maxSessionSec`, because no `connected` signal can ever arrive. By owner:

- `dbus` owner, `recording`: stop at once. There is nothing to re-read, so this does not go through
  the D-Bus end re-read.
- `dbus` owner, `starting`: latch the stop, which fires on confirmation.
- `arbitrating`: abandon to `idle`.
- `keyboard` and `hid` owners are untouched: their audio does not depend on the source.

The last known remote state becomes `absent`, so the next daemon's first `streaming` counts as a
transition.

### 4.6 Consequence: F9 in `remote` mode

Without on-demand, a keyboard (F9) session in `remote` mode captures from the ATVVoice node and
receives silence, unless the remote's button is held at the same time. The base spec's mode table
row "keyboard F9: audio from remote via on-demand" is replaced by "no audio unless the remote button
is held; use `system` mode for F9". The Voice tab shows this line in `remote` mode.

## 5. Doctor

New rows, informational in `system` mode as today:

- `atvvoice` user unit active.
- An `org.atvvoice.*` name on the bus, with `NodeName` equal to Voxtype `audio.device` (existing
  remote checks).
- **Voxtype device (remote mode).** `audio.device` must equal the node, **and** `arecord -L`
  (fact `alsa.pcms`) must list a PCM of that name: Voxtype cannot open a bare node (§2.9). If ALSA
  lacks it the row fails with fix `omaremote-setup atvvoice`; if the list is unavailable it is
  `unknown`.
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
- `AtvSource`: departure then arrival before the old monitor exits; direct owner replacement; a
  duplicate arrival of the current owner; a stale owner result after revocation; unexpected monitor
  exit; the 1/2/4 s backoff with `retryAt`, and an arrival cancelling it.
- `VoiceSession.sourceLost`: stop for `dbus`/`recording`, latch for `dbus`/`starting`, abandon from
  `arbitrating`, nothing for `keyboard` and `hid`; the remote state resets so a new `streaming` is a
  transition.
- `Doctor`: the on-demand consistency row fails on mismatch in each direction and passes when both
  sides agree.

Integration (`tests/fake-remote.sh`, fake `busctl`):

- `s_remote_hold_session`: `streaming` reaches `recording` without passing `arbitrating`; then
  `connected` returns to `idle`.
- `s_remote_mode_ignores_hid_mic`: in `remote` mode, `ipc key mic down/up` leaves voice `idle` and
  writes nothing to `actions.log`.
- `s_atvvoice_departure_stops_session`: a `dbus`-owned recording, then the daemon departs; Voxtype
  receives `record stop` and the session returns to `idle`.
- `s_atvvoice_owner_replaced`: the fake daemon's owner changes from `:1.99` to `:1.77` in one
  NameOwnerChanged; `remote.sender` becomes `:1.77`. The race orderings themselves are pinned by
  `lib/AtvSource.mjs` unit tests.
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
