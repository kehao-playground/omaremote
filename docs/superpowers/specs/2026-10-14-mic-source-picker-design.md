# omaremote — microphone source picker (Voxtype)

**Date:** 2026-10-14
**Status:** Draft for review
**Amends:** `2026-09-14-omaremote-design.md` §3 (mic apply contract), §6.2 (Voice tab, Doctor);
`2026-10-12-remote-mic-design.md` §5 (Doctor `voxtype-device`, `last-capture`)

## 1. Goal

Let the user pick, from the panel, which microphone Voxtype records from in `system` mode, without
opening pavucontrol or changing the PipeWire default source.

Success means:
- The Voice tab's Microphone row offers `Remote`, `System default`, and one entry per real capture
  source (for example the C922 and the built-in analog input). Picking one applies it through the
  existing mic apply transaction.
- The choice affects Voxtype only. The PipeWire default source and every other application are untouched.
- A newly plugged microphone can be picked without re-running `omaremote-setup`.
- If Voxtype ends up recording from a different node than the one picked, the user is told.

## 2. Measured facts this design rests on

Measured on 2026-10-14 on the Mac mini (Voxtype 1.1.0, PipeWire with `pipewire-alsa`).

1. **Voxtype captures through ALSA only** (cpal), so `audio.device` must be a name in ALSA's device
   list (`arecord -L`), not a PipeWire node name. This was already known for the remote (Doctor
   comment in `lib/Doctor.mjs`, measured 2026-10-12).
2. **An unknown `audio.device` falls back silently.** The binary contains
   `Found audio device by substring match:` and `Audio device '…' not found, using …`. A name that
   is not in the list is not an error; Voxtype records from the default device.
3. **`pipewire:NODE=<name>` does not help.** ALSA accepts it (`pcm.pipewire` in
   `/usr/share/alsa/alsa.conf.d/50-pipewire.conf` takes a `NODE` argument), but it is not in the
   hinted device list, so by fact 2 Voxtype would silently use the default.
4. **ALSA's own names for real sources bypass PipeWire.** `arecord -L` lists only
   `sysdefault:CARD=Webcam` and `front:CARD=Webcam,DEV=0` for the C922. These open the hardware
   directly and can collide with PipeWire.
5. **A hinted `type pipewire` PCM works.** The remote already records through
   `pcm.atvvoice-xiaomi { type pipewire; capture_node "atvvoice-xiaomi"; hint { … } }` in the managed
   block of `~/.config/alsa/asoundrc` that `omaremote-setup atvvoice` writes.

Therefore Voxtype can only be pointed at a specific PipeWire source through a hinted ALSA PCM of
`type pipewire` in asoundrc.

## 3. Configuration

- `voice.mic` stays `remote | system`. It still decides how the HID mic key and the D-Bus stream are
  treated (`2026-10-12-remote-mic-design.md` §4.2); the picker never changes that meaning.
- New `voice.systemDevice`: `"default"` (the default) or a PipeWire `node.name`. A missing or
  non-string value loads as `"default"`, so an existing config behaves exactly as before.
- `voice.systemDevice` is written only by the mic apply's commit, together with `voice.mic`. A failed
  apply writes neither.

What each choice puts on disk:

| Choice | `voice.mic` | `voice.systemDevice` | Voxtype `audio.device` | asoundrc |
|---|---|---|---|---|
| Remote | `remote` | unchanged | ATVVoice node (today) | untouched |
| System default | `system` | `default` | `default` (today) | untouched |
| A specific source | `system` | its `node.name` | `omaremote-mic` | mic block's `capture_node` = that node |

Picking `Remote` leaves the stored `systemDevice` as it is. It has no effect while `voice.mic` is
`remote`; a later `system` request always names its device (§4.4).

## 4. Components

### 4.1 The managed ALSA block

A second managed block in the same asoundrc file the atvvoice step edits
(`OMAREMOTE_ALSA_RC`, default `${XDG_CONFIG_HOME:-$HOME/.config}/alsa/asoundrc`):

```
# BEGIN omaremote mic (managed by omaremote-setup; do not edit)
pcm.omaremote-mic {
  type pipewire
  capture_node "<node.name>"
  hint { show on description "omaremote picked microphone" }
}
# END omaremote mic
```

It has its own markers and is edited independently of the atvvoice block. It is never removed:
when `audio.device` does not name `omaremote-mic` nothing reads it, so leaving it costs nothing and
saves a delete path.

### 4.2 `omaremote-setup alsa-mic`

A new subcommand, reusing the atvvoice block's marker logic (replace in place, append if absent,
refuse unbalanced markers, keep every line outside the markers).

- `alsa-mic get` prints the block's current `capture_node`, or `none` if there is no block. Exit 0.
  Unbalanced markers exit 2.
- `alsa-mic set <node> --expect <value|none>` compares the file's current value with `--expect`
  first. On a match it writes `<node>` and exits 0. On a mismatch it leaves the file unchanged,
  prints the current value (or `none`) on stdout, and exits 3. Unbalanced markers exit 2. The write is atomic: a temporary file in the same directory,
  then a rename.
- `<node>` must match `^[A-Za-z0-9_.:-]+$`; anything else is a usage error (exit 64), so a node
  name can never inject ALSA config syntax.

It needs no root, prompts nothing, and is safe to call from the plugin.

### 4.3 Source list (`lib/Pipewire.mjs`)

- `captureSources(dump, { exclude })` returns `[{ name, description }]` for every `Audio/Source`
  node, excluding names ending in `.monitor` and the names in `exclude` (the ATVVoice node).
  `description` is `node.description`, falling back to `node.nick`, then to `name`.
- `defaultSource(dump)` returns the `name` from the `default` metadata's `default.audio.source`
  entry, or `null`.
- The Service runs `pw-dump` when the Voice tab is shown and stores the result as
  `root.micSources`, so a microphone plugged in since the last look appears. A stored
  `systemDevice` that is absent from the list is still shown, marked "(not connected)". Nothing ever
  switches to another source on its own.

### 4.4 IPC and CLI

- `mic system` keeps today's meaning: `system` with `default`.
- New: `mic system <node.name>`.
- `mic remote` is unchanged.
- Request-time refusals, before anything is queued:
  - `invalid-source`: the node is a monitor, is the ATVVoice node, or fails the §4.2 name pattern.
  - `no-such-source`: the node is not in the latest `micSources`. The Service refreshes `micSources`
    first if it is older than 2 s, so a CLI call right after plugging in works.
- `omaremote-setup mic system` and `--mic system` are unchanged (they mean `default`).

### 4.5 Panel (Voice tab)

- The Microphone row shows one button per choice: `Remote`, `System default`, then each source by
  its description, truncated. The active choice is selected. A disconnected stored source shows
  "(not connected)" and cannot be picked.
- A click applies at once. With the keyboard, Enter on the row enters editing; Left and Right move
  between choices; Enter applies; Esc leaves without applying. This is the same `editing` pattern the
  Keys tab uses.
- While `micPending`, every choice is disabled (today's behaviour).
- Refusals display through the existing error line: `no-such-source` as "microphone not found
  (unplugged?)", `invalid-source` as "not a usable microphone".

## 5. Mic apply contract changes (`lib/MicApply.mjs`)

`request(mode, now, opts)` gains `opts.device` (`"default"` or a node name, `system` only). The
target becomes:

- `remote`: `audio.device` = ATVVoice node (unchanged).
- `system` + `default`: `audio.device` = `default` (unchanged).
- `system` + node: asoundrc `capture_node` = node, then `audio.device` = `omaremote-mic`.

### 5.1 Phases

Only `system` + node adds the two leading phases; every other request runs exactly today's phases
and issues no `alsa-*` command.

```
queued → reserve (preconditions unchanged)
  → alsa-get   run `alsa-mic get`; record alsaPrev (node or none)
  → alsa-set   run `alsa-mic set <node> --expect <alsaPrev>`; on exit 0, alsaExpected = node
  → get        (today) read audio.device
  → set        (today) write audio.device = omaremote-mic
  → restart    (today)
  → verify     (today) daemon healthy
  → commit     voice.mic = system, voice.systemDevice = node
```

- `alsa-get` failing (non-zero exit) fails the operation with `preflight-failed`; nothing was mutated.
- `alsa-set` exiting 3 fails the operation with `alsa-conflict`; nothing was mutated, so there is no
  rollback. Any other non-zero exit fails it with `alsa-set-failed`, also with no rollback, since
  the write is atomic.
- When `alsaPrev` already equals the node, `alsa-set` is skipped and `alsaExpected = alsaPrev`.
- When `audio.device` already holds `omaremote-mic` (switching between two specific sources), the
  `set` still runs as today. The restart is what makes Voxtype read the new block, so it always runs.
- The `commit` effect carries `device`. `configStore.setVoiceMic(mode, device)` writes both fields;
  `remote` passes no device and leaves `systemDevice` as it is.

### 5.2 Rollback

Rollback runs in reverse order:

1. Restore `audio.device` exactly as today, including the external-edit check.
2. If the asoundrc was changed (`alsaExpected !== alsaPrev`), run
   `alsa-mic set <alsaPrev> --expect <alsaExpected>`. When `alsaPrev` is `none`, the block is left
   holding the new node instead: no `audio.device` names it once step 1 succeeded, and §4.1 never
   removes the block. Exit 3 emits today's `conflict` effect
   (`{ expected: alsaExpected, found: <the value printed by the exit-3 run> }`)
   with the HUD "microphone config changed externally", and the operation ends `failed` with
   rollback `conflict`.
3. Restart, as today.

Reset priority and deferred rollback follow today's rules. The deferred snapshot also carries
`alsaPrev` and `alsaExpected`, and a drained `alsa-set` that exited 0 after a defer corrects
`alsaExpected`, the same way a drained `set` corrects `expected` today.

### 5.3 Detecting a silent fallback

The apply cannot prove the capture node, because Voxtype opens the device only when a session
records (§2 fact 2). The next session does: the existing `captureProbe` already reads which node
Voxtype's stream is linked to. When `voice.mic` is `system` and the linked node differs from the
expected one (§6), the HUD shows "recording from <description>, not <picked description>". The
check runs once per session.

## 6. Doctor

**`voxtype-device`, `system` mode**

- `systemDevice = default`: today's check, unchanged.
- `systemDevice = <node>`: passes only if all three hold. Each failure names its own fix.
  1. `audio.device` is `omaremote-mic`. Fix: `omarchy-shell omaremote mic system <node>`.
  2. The asoundrc mic block's `capture_node` equals `<node>`. This needs a new fact, `alsa.micNode`,
     from `host/omaremote-facts` (the `alsa-mic get` value, or `null` when unreadable). Fix: the same
     command.
  3. `<node>` is in `pipewire.sources` (it is plugged in). Fix: "connect the microphone, or pick
     another one in the Voice tab".

**`last-capture`**

The expected node becomes:
- `remote`: the ATVVoice node (unchanged).
- `system` + node: that node.
- `system` + `default`: the PipeWire default source (`defaultSource()`, exposed as the new fact
  `pipewire.defaultSource`). This fixes a defect: today the row compares the captured node with the
  literal string `"default"`, which never matches, so it always warns in `system` mode.

The row keeps its `warn` level on a mismatch.

## 7. Testing

**Unit**
- `MicApply.test.mjs`:
  - the full `system` + node success path, in phase order;
  - `alsa-get` failure; `alsa-set` exit 3 and other failure, each with no rollback;
  - restart failure, with rollback in order: `audio.device` first, then asoundrc, then restart;
  - the asoundrc rollback hitting exit 3, which emits `conflict`;
  - a reset during `restart`, where the deferred snapshot carries `alsaPrev` and `alsaExpected`, and
    a drained `alsa-set` corrects `alsaExpected`;
  - a source-to-source switch, where `audio.device` is already `omaremote-mic` and the restart still
    runs;
  - `alsaPrev` equal to the node, which skips `alsa-set`;
  - `system` + `default` and `remote`, which issue no `alsa-*` command. Assert this against a
    request that would issue one if the mode branch were wrong, so the absence is not guaranteed by
    construction.
- `Pipewire.test.mjs`: `captureSources` excludes monitors and the ATVVoice node and picks the
  description fallbacks; `defaultSource` reads the metadata and returns `null` without it.
- `Doctor.test.mjs`: each of the three `voxtype-device` conditions failing alone; `last-capture`'s
  expected node in all three cases.
- `Config.test.mjs`: a missing `systemDevice`, and a non-string one, both load as `default`.

**Setup** (new `tests/setup-alsa-mic.sh`, run with `OMAREMOTE_ALSA_RC` in a temp dir)
- `set` into an empty file creates the block.
- `set` replaces the block in place, leaving the atvvoice block and all outside lines byte-identical.
- An `--expect` mismatch exits 3 and leaves the file byte-identical.
- Unbalanced markers exit 2.
- A node name with a quote, space or brace exits 64.
- `get` prints `none` with no block and the node with one.

**Integration** (fake-remote scenarios)
- `s_mic_system_device`: `ipc mic system <fake node>` issues `alsa-get`, `alsa-set`, `set` and
  `restart` in order, and the config ends with `systemDevice` set.
- `s_mic_system_unknown_source`: an unknown node answers `no-such-source` and nothing is queued.

**Hardware acceptance (user present)**
1. Pick the C922 in the panel and dictate. Doctor `last-capture` passes.
2. Pick the built-in input and dictate. The capture is from the built-in input.
3. Pick System default, then Remote, then the C922 again. Each apply succeeds.
4. Unplug the C922. The panel marks it "(not connected)" and Doctor `voxtype-device` fails on
   condition 3.
5. Switch once with the keyboard only: Enter, Left/Right, Enter.

## 8. Out of scope

- Typeless's microphone. It is chosen in Typeless's own settings.
- Changing the PipeWire default source.
- Microphone volume or gain.
- Choosing a different ATVVoice node in `remote` mode.
