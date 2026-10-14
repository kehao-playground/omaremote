# omaremote — microphone source picker (Voxtype)

**Date:** 2026-10-14
**Status:** Draft rev 2 for review (rev 2 answers the 2026-10-14 review: snapshot before write, locked
compare-and-set, rollback partial outcomes, cache-miss refresh, structured block state)
**Amends:** `2026-09-14-omaremote-design.md` §3 (mic apply contract), §6.2 (Voice tab, Doctor);
`2026-10-12-remote-mic-design.md` §3 (the atvvoice asoundrc write becomes locked and atomic), §5 (Doctor
`voxtype-device`, `last-capture`)

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

It has its own markers and is edited independently of the atvvoice block. A forward apply only
creates or rewrites it. Only a rollback removes it, and only to restore a file that had no block
before (§5.2), so a rollback always returns the file to its exact earlier state.

The block's state is one of:
- `absent`: neither marker is present.
- `present <node>`: one BEGIN before one END, and between them exactly one `capture_node "<node>"`
  line whose value matches the §4.2 name pattern.
- `bad`: anything else. That covers unbalanced or misordered markers, and balanced markers with no
  `capture_node`, more than one, or a value that fails the pattern.

### 4.2 `omaremote-setup alsa-mic`

A new subcommand, reusing the atvvoice block's marker logic (replace in place, append if absent,
keep every line outside the markers byte-identical).

Output is one line of JSON, so "no block" can never be confused with a node name:
`{"state":"absent"}` or `{"state":"present","node":"<node>"}`.

- `alsa-mic get` prints the current state. Exit 0. A `bad` block exits 2.
- `alsa-mic set (<node> | --absent) (--expect <node> | --expect-absent)` sets the block to `<node>`,
  or removes it with `--absent`. It compares the current state with the expectation first. On a match
  it writes and exits 0. On a mismatch it leaves the file unchanged, prints the current state, and
  exits 3. A `bad` block exits 2, and the file is unchanged. Any other failure (I/O, lock timeout)
  exits 1, and the file is unchanged.
- `<node>` must match `^[A-Za-z0-9_.:-]+$`; anything else is a usage error (exit 64), so a node name
  can never inject ALSA config syntax. No sentinel value is reserved, so every name that passes the
  pattern is a valid node.

**Locking.** Every writer of this file in the repo takes an exclusive `flock` on a separate lock file,
`<asoundrc>.omaremote.lock`, and holds it from the read through the compare, generate and rename.
The wait is bounded at 5 s; a timeout exits 1. The writers are `alsa-mic set` and the existing
`omaremote-setup atvvoice` step. The atvvoice step also changes from `cp` to the same atomic write:
a temporary file in the same directory, then a rename. Readers (`alsa-mic get`, `omaremote-facts`)
take no lock, because the rename means they only ever see a whole file.

**What the lock does not cover.** An editor or tool outside the repo does not take the lock. If one
saves the file inside the window between `alsa-mic set`'s read and its rename, its edit is lost. An
outside edit made at any other time is preserved. If it changed the mic block, it is detected by the
compare (exit 3). Edits outside the managed blocks are always kept, as long as they do not land in
that window.

It needs no root, prompts nothing, and is safe to call from the plugin.

### 4.3 Source list (`lib/Pipewire.mjs`)

- `captureSources(dump, { exclude })` returns `[{ name, description }]` for every `Audio/Source`
  node, excluding names ending in `.monitor` and the names in `exclude` (the ATVVoice node).
  `description` is `node.description`, falling back to `node.nick`, then to `name`.
- `defaultSource(dump)` returns the `name` from the `default` metadata's `default.audio.source`
  entry, or `null`.
- The Service runs `pw-dump` when the Voice tab is shown and stores the result as
  `root.micSources`. A microphone plugged in since the last look therefore appears. A stored
  `systemDevice` that is absent from the list is still shown, marked "(not connected)". Nothing ever
  switches to another source on its own.
- Each refresh records when it started (`startedAt`), and its outcome: a list, or failed when
  `pw-dump` exits non-zero, its JSON does not parse, or it runs past 3 s.

### 4.4 IPC and CLI

- `mic system` keeps today's meaning: `system` with `default`.
- New: `mic system <node.name>`.
- `mic remote` is unchanged.
- Request-time refusals, before anything is queued:
  - `invalid-source`: the node is a monitor, is the ATVVoice node, or fails the §4.2 name pattern.
  - **A cache miss refreshes before refusing.** `ipcMic` answers at once, but `pw-dump` is
    asynchronous, so the caller retries. When the node is not in `micSources`:
    - If no refresh has started since this node's first miss, the Service records the miss time,
      starts a refresh, and answers `busy` with `detail: "sourcesRefreshing"` and `retryAfterMs: 300`.
      This is the same convention as `backendStale`.
    - If a refresh that started after that miss is still running, the answer is the same `busy`.
    - If such a refresh completed and the node is still missing, the answer is `no-such-source`.
    - If such a refresh failed, the answer is `sources-unavailable`.

    The miss record is cleared once it has been answered with a terminal reason, or the node is found.
    A cache hit is accepted without a refresh. A source unplugged since then is caught later, by the
    capture check (§5.3) and Doctor (§6).
- `omaremote-setup mic system` and `--mic system` are unchanged (they mean `default`).

### 4.5 Panel (Voice tab)

- The Microphone row shows one button per choice: `Remote`, `System default`, then each source by
  its description, truncated. The active choice is selected. A disconnected stored source shows
  "(not connected)" and cannot be picked.
- A click applies at once. With the keyboard, Enter on the row enters editing; Left and Right move
  between choices; Enter applies; Esc leaves without applying. This is the same `editing` pattern the
  Keys tab uses.
- While `micPending`, every choice is disabled (today's behaviour).
- Refusals display through the existing error line:
  - `no-such-source`: "microphone not found (unplugged?)"
  - `invalid-source`: "not a usable microphone"
  - `sources-unavailable`: "cannot list microphones (pw-dump failed)"

  The panel retries `busy`/`sourcesRefreshing` on its own, so the user never sees it.

## 5. Mic apply contract changes (`lib/MicApply.mjs`)

`request(mode, now, opts)` gains `opts.device` (`"default"` or a node name, `system` only). The
target becomes:

- `remote`: `audio.device` = ATVVoice node (unchanged).
- `system` + `default`: `audio.device` = `default` (unchanged).
- `system` + node: asoundrc block = `present <node>`, then `audio.device` = `omaremote-mic`.

### 5.1 Phases: snapshot everything, then write

Only `system` + node adds the two ALSA phases. Every other request runs exactly today's phases and
issues no `alsa-*` command.

```
queued → reserve (preconditions unchanged)
  ── snapshot (nothing written; any failure ends the operation without rollback) ──
  → get        (today) read audio.device → prev, expected
  → alsa-get   run `alsa-mic get` → alsaPrev (absent | present <n>), alsaExpected = alsaPrev
  → job check  jobPending → fail `job-pending`, no rollback (as today's get does)
  ── write (mutated from the first successful write on) ──
  → alsa-set   `alsa-mic set <node> --expect <alsaPrev>`
  → set        (today) write audio.device = omaremote-mic
  → restart    (today)
  → verify     (today) daemon healthy
  → commit     voice.mic = system, voice.systemDevice = node
```

**Snapshot failures.** `get` failing keeps today's `preflight-failed`. `alsa-get` exiting non-zero
(including 2, a `bad` block) also fails with `preflight-failed`. Neither has a rollback, because
nothing was written.

**`alsa-set`.** This is the first write.
- Exit 0: set `mutated = true`, `serviceDirty = true` and `alsaExpected = present <node>`. The flags
  are set the moment the write succeeds, before the restart. alsa-lib re-reads changed config files
  when a PCM is opened, so the running daemon's next session would already use the new block.
- Exit 3: fail with `alsa-conflict`. Nothing was written, so there is no rollback.
- Exit 1, 2 or other: fail with `alsa-set-failed`. Nothing was written (§4.2), so there is no
  rollback.
- When `alsaPrev` already equals `present <node>`, `alsa-set` is skipped. `mutated` and
  `serviceDirty` then become true at `set`, exactly as today.

**After the first write, every failure rolls back or defers.** This covers `set` failing, a
`job-pending` found before `set` or `restart`, a reset or external recording, and a verify failure.
They take today's paths (`beginRollback` or `deferOp`). Those paths now also restore the ALSA block
(§5.2). This holds even when `audio.device` itself was never written.

**Other rules.**
- When `audio.device` already holds `omaremote-mic` (switching between two specific sources), `set`
  still runs as today, and the restart always runs.
- The `commit` effect carries `device`. `configStore.setVoiceMic(mode, device)` writes both fields;
  `remote` passes no device and leaves `systemDevice` as it is.

### 5.2 Rollback

Rollback runs in this order:

1. **`audio.device`**, exactly as today, including the external-edit check (`rollback-get`, then
   `rollback-set` if needed). A conflict or failure here ends the rollback as today, with no ALSA
   step. The ALSA block is then left as it is, and the `conflict`/`unconfigured` effect already tells
   the user the microphone config needs attention.
2. **`rollback-alsa`**, when `alsaExpected !== alsaPrev`: run
   `alsa-mic set <alsaPrev as node | --absent> --expect <alsaExpected>`. Removing the block restores
   a file that had none, so the restore is exact in every case.
   - Exit 0: `alsaExpected = alsaPrev`. Continue to step 3.
   - Exit 3: emit today's `conflict` effect,
     `{ expected: alsaExpected, found: <the state printed by the exit-3 run> }`, with the HUD
     "microphone config changed externally". Still run step 3, because `audio.device` was restored
     and the daemon must reload it. The final rollback is `conflict`.
   - Exit 1, 2 or other: still run step 3, for the same reason. The final rollback is `failed`, with
     an `unconfigured` effect, reason "microphone partly restored". Nothing is deferred: a `bad` block
     or a lock timeout does not fix itself, and the effect plus Doctor (§6, condition 2) point the user
     at it.
3. **Restart and verify**, as today, when `serviceDirty`. The final rollback is `verified` only when
   both steps 1 and 2 restored exactly. If step 2 ended `conflict` or `failed`, that outcome stands
   even if the restart verifies.

A `job-pending` reading before `rollback-alsa` or the restart defers the rest, as today.

**Deferred rollback.** Reset priority and deferral follow today's rules. The deferred snapshot also
carries `alsaPrev` and `alsaExpected`. A drained `alsa-set` that exited 0 after a defer sets
`alsaExpected = present <node>`, the same way a drained `set` corrects `expected` today. A drained
`rollback-alsa` that exited 0 sets `alsaExpected = alsaPrev`.

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
  2. The asoundrc mic block is `present <node>`. This needs a new fact, `alsa.mic`, from
     `host/omaremote-facts`: the `alsa-mic get` JSON, `{"state":"bad"}` on exit 2, or `null` when it
     cannot run (`null` makes the row `unknown`). Fix for `absent` or another node: the same command.
     Fix for `bad`: "repair the omaremote mic block in <asoundrc> by hand".
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
  - the full `system` + node success path, in phase order (`get`, `alsa-get`, `alsa-set`, `set`,
    `restart`, verify, commit with `device`);
  - snapshot failures, each ending `preflight-failed` with no write and no rollback: `get` failing,
    `alsa-get` failing, and `alsa-get` exiting 2;
  - `job-pending` at the job check ends the operation with no `alsa-set` issued;
  - `alsa-set` exit 3 (`alsa-conflict`) and exit 1/2 (`alsa-set-failed`), each with no rollback;
  - after `alsa-set` succeeds:
    - `set` fails, so the rollback restores the ALSA block, then restarts;
    - a `job-pending` is found before `set`, so the operation defers, and the deferred rollback later
      restores the block;
    - a reset arrives, so the operation defers with `alsaPrev` and `alsaExpected` in the snapshot;
  - a restart or verify failure rolls back in order: `audio.device`, then `rollback-alsa`, then the
    restart;
  - `rollback-alsa` from `absent` issues `--absent` with `--expect` the new node;
  - `rollback-alsa` exit 3 emits `conflict`, still restarts, and ends with rollback `conflict` even
    when the restart verifies;
  - `rollback-alsa` exit 2 still restarts and ends with rollback `failed` and the "partly restored"
    `unconfigured` effect, with nothing deferred;
  - a conflict in step 1 (`audio.device`) issues no `rollback-alsa`;
  - a drained `alsa-set`, and a drained `rollback-alsa`, after a defer correct `alsaExpected`;
  - a source-to-source switch, where `audio.device` is already `omaremote-mic` and the restart still
    runs;
  - `alsaPrev` equal to the node skips `alsa-set`, and `mutated` first becomes true at `set`;
  - `system` + `default` and `remote` issue no `alsa-*` command. Assert this against a request that
    would issue one if the mode branch were wrong, so the absence is not guaranteed by construction.
- Service source check (unit-testable helper `lib/MicSources.mjs`, which owns the miss record):
  - a cache hit is accepted;
  - a miss starts a refresh and answers `sourcesRefreshing`, even when the cache is fresh, since the
    device was plugged in after the last refresh;
  - a retry while that refresh runs answers `sourcesRefreshing` again and starts no second refresh;
  - a completed refresh that started after the miss and contains the node accepts it; one that lacks
    it answers `no-such-source`;
  - a refresh that started *before* the miss never answers `no-such-source`;
  - a failed refresh answers `sources-unavailable`.
- `Pipewire.test.mjs`: `captureSources` excludes monitors and the ATVVoice node and picks the
  description fallbacks; `defaultSource` reads the metadata and returns `null` without it.
- `Doctor.test.mjs`: each of the three `voxtype-device` conditions failing alone; `last-capture`'s
  expected node in all three cases.
- `Config.test.mjs`: a missing `systemDevice`, and a non-string one, both load as `default`.

**Setup** (new `tests/setup-alsa-mic.sh`, run with `OMAREMOTE_ALSA_RC` in a temp dir)
- `set <node> --expect-absent` on an empty or missing file creates the block.
- `set` replaces the block in place, leaving the atvvoice block and all outside lines byte-identical.
- `set --absent --expect <node>` removes the block, and the file is byte-identical to the one before
  the block was added.
- An expectation mismatch exits 3, prints the current state as JSON, and leaves the file
  byte-identical.
- `bad` blocks exit 2 for both `get` and `set` and leave the file byte-identical. The cases are
  unbalanced markers, misordered markers, no `capture_node`, two `capture_node` lines, and a value
  failing the pattern.
- A node name with a quote, space or brace exits 64.
- A node literally named `none` or `absent` round-trips as `present`.
- `get` prints `{"state":"absent"}` with no block and `{"state":"present","node":…}` with one.
- **Concurrency:**
  - Run `alsa-mic set` and the atvvoice block writer at the same time, 50 times. Each run must end
    with both blocks present and every outside line intact.
  - Hold the lock from the test with `flock`. `set` waits, then succeeds once the lock is released
    within 5 s; held past 5 s, it exits 1 with the file unchanged.
- The existing atvvoice setup tests still pass with the atomic, locked write.

**Integration** (fake-remote scenarios)
- `s_mic_system_device`: `ipc mic system <fake node>` issues `alsa-get`, `alsa-set`, `set` and
  `restart` in order, and the config ends with `systemDevice` set.
- `s_mic_system_unknown_source`: an unknown node first answers `busy`/`sourcesRefreshing`; after
  the retry it answers `no-such-source`, and nothing is queued.
- `s_mic_system_late_plug`: the fake `pw-dump` gains the node right after a refresh; the request
  answers `sourcesRefreshing`, then the retry is accepted.

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
