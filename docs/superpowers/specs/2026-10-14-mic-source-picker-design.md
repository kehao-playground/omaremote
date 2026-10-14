# omaremote — microphone source picker (Voxtype)

**Date:** 2026-10-14
**Status:** Rev 4 (2026-10-14): CLI verb `micSystem`/`micSources`, Keys-tab keyboard pattern, retry
ownership, and a node pattern that only forbids a leading `-`; decided while reviewing the implementation plan.
Rev 3 for review. Rev 2 answered the first 2026-10-14 review: snapshot before write, locked
compare-and-set, partial rollback outcomes, cache-miss refresh, structured block state. Rev 3 answers the
second: an in-flight `alsa-set` counts as mutated, single-snapshot parsing, rollback progress across a
defer, and a restore promise limited to semantic state.
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
before (§5.2).

**What a rollback restores.** A rollback restores the block's *semantic state* (`absent` or
`present <node>`). It does not restore the file's earlier bytes. The writer always emits the canonical
block above, so comments or formatting someone added inside the markers are not brought back. Lines
outside the markers are kept as they are *now*, including edits made since the apply. A missing file
and an empty file are both `absent`, and removing the last block leaves an empty file, never a
deleted one.

**Layout rules**, so that adding and then removing the block returns the outside lines unchanged:
- Append: if the file is non-empty and does not end in a newline, write one newline first. Then
  append the block, with no extra blank line.
- Remove: delete exactly the lines from BEGIN through END, nothing around them.

Adding then removing the block is therefore byte-identical when the file was empty, missing, or
ended in a newline. Otherwise it differs only by the trailing newline that was added.

The block's state is one of:
- `absent`: neither marker is present.
- `present <node>`: one BEGIN before one END, and between them exactly one `capture_node "<node>"`
  line whose value matches the §4.2 name pattern.
- `bad`: anything else. That covers unbalanced or misordered markers, and balanced markers with no
  `capture_node`, more than one, or a value that fails the pattern.

### 4.2 `omaremote-setup alsa-mic`

A new subcommand, reusing the atvvoice block's marker logic (replace in place, append if absent,
keep every line outside the markers byte-identical, under §4.1's layout rules).

Output is one line of JSON, so "no block" can never be confused with a node name:
`{"state":"absent"}` or `{"state":"present","node":"<node>"}`.

- `alsa-mic get` prints the current state. Exit 0. A `bad` block exits 2.
- `alsa-mic set (<node> | --absent) (--expect <node> | --expect-absent)` sets the block to `<node>`,
  or removes it with `--absent`. It compares the current state with the expectation first. On a match
  it writes and exits 0. On a mismatch it leaves the file unchanged, prints the current state, and
  exits 3. A `bad` block exits 2, and the file is unchanged. Any other failure (I/O, lock timeout)
  exits 1, and the file is unchanged.
- `<node>` must match `^[A-Za-z0-9_.:][A-Za-z0-9_.:-]*$`; anything else is a usage error (exit 64), so a
  node name can never inject ALSA config syntax, and can never be read as an option (it cannot start
  with `-`). No sentinel value is reserved, so every name that passes the
  pattern is a valid node.

**Locking.** Every writer of this file in the repo takes an exclusive `flock` on a separate lock file,
`<asoundrc>.omaremote.lock`, and holds it from the read through the compare, generate and rename.
The wait is bounded at 5 s; a timeout exits 1. The writers are `alsa-mic set` and the existing
`omaremote-setup atvvoice` step. The atvvoice step also changes from `cp` to the same atomic write:
a temporary file in the same directory, then a rename. Readers (`alsa-mic get`, `omaremote-facts`)
take no lock. The rename means any single open sees one whole version of the file.

**Single-snapshot parsing.** That guarantee holds per open, so every parse of the file opens it
exactly once. It reads the whole content into memory, then parses the markers, the block state and
the outside lines from that copy. This applies to `alsa-mic get` and `set`, to the atvvoice step's
state check and generator, and to `omaremote-facts` (which calls `alsa-mic get`). Today's
`alsa_rc_state` and `gen_alsa_rc` run several `grep`s against the pathname. A rename landing between
them could mix two versions and be misread as `bad`, so both are rewritten to parse one in-memory
copy. A writer, under the lock, also parses its one copy and never re-reads the file before its
rename. This holds only against writers that replace the file atomically. A tool that rewrites the
file in place can still be seen half-written, and is then reported as `bad`.

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
- New: `micSystem <node.name>` (for example `omarchy-shell omaremote micSystem alsa_input…`). Quickshell
  IPC functions have a fixed arity, so `mic` cannot take an optional second argument without breaking
  `mic system` and `omaremote-setup`'s `ipc mic "$mode"`.
- New: `micSources` refreshes the source list and returns `{ sources, refreshing }`, so a CLI user can
  find node names.
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
- A click applies at once. With the keyboard, the row works like the Keys tab: with the cursor on the
  Microphone row, Left and Right move the highlight between choices, and Enter applies the highlighted
  one. There is no separate edit mode, and Esc keeps its panel-wide meaning (close). Enter on the
  choice that is already active does nothing.
- Each user choice supersedes the previous one. A pending `sourcesRefreshing` retry belongs to the
  choice that started it, and is dropped when a newer choice is made, when that choice's request is
  answered with anything else, or when the panel closes.
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
  ── write (mutated from the first write command issued) ──
  → alsa-set   `alsa-mic set <node> --expect <alsaPrev>`
  → set        (today) write audio.device = omaremote-mic
  → restart    (today)
  → verify     (today) daemon healthy
  → commit     voice.mic = system, voice.systemDevice = node
```

**Comparing block states.** `alsaPrev`, `alsaExpected` and `alsaWrites` are block states parsed from
JSON. Every equality in this section, written `===`/`!==`, means *same `state`, and the same `node`
when both are `present`*. It is one helper, `sameAlsa(a, b)`, never object identity.

**Snapshot failures.** `get` failing keeps today's `preflight-failed`. `alsa-get` exiting non-zero
(including 2, a `bad` block) also fails with `preflight-failed`. Neither has a rollback, because
nothing was written.

**`alsa-set`.** This is the first write. Like today's `set`, the operation becomes `mutated` when
the command is *issued*, not when it exits. The command is tagged with the state it writes
(`alsaWrites = present <node>`), as `set` is tagged with `writes` today.

While it runs, the write is in flight and its outcome is unknown. `alsaExpected` still equals
`alsaPrev`, and `serviceDirty` is still false. A reset or external recording in this window takes
today's mutated path, `deferOp`. The deferred snapshot holds `alsaPrev`, `alsaExpected` (still the
old state) and the rest, and `tryDeferred` already waits for in-flight commands to drain before it
rolls back. When the command drains:
- Exit 0 sets `deferred.alsaExpected = present <node>` and `deferred.serviceDirty = true`. The
  rollback then restores the block and restarts.
- Any other exit leaves both as they were. Nothing was written, so `rollback-alsa` is skipped
  (`alsaExpected === alsaPrev`).

When the operation is still live, the exit is handled in place:
- Exit 0 sets `serviceDirty = true` and `alsaExpected = present <node>`. alsa-lib re-reads changed
  config files when a PCM is opened, so the running daemon's next session would already use the new
  block. The service is therefore dirty from this write on, before the restart.
- Exit 3 fails the operation with `alsa-conflict`. Exit 1, 2 or any other code fails it with
  `alsa-set-failed`. In both cases nothing was written (§4.2), so the operation ends `failed` with
  rollback `verified` and no restart: `alsaExpected === alsaPrev`, `audio.device` was never written,
  and `serviceDirty` is false. This reuses today's "service never saw the new value" ending.
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
   the `absent` state, so the block's semantic state is restored in every case (§4.1).
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
   step 1 restored `audio.device` and step 2 ended `done`. If step 2 ended `conflict` or `failed`, that outcome stands
   even if the restart verifies.

A `job-pending` reading before `rollback-alsa` or the restart defers the rest, as today.

**Progress survives a defer.** A rollback can be deferred part-way, for example after `rollback-alsa`
and before the restart. The deferred snapshot therefore also carries the rollback's progress:
- `rbDevice`: `pending | done`. It becomes `done` once step 1 finishes, whether `rollback-set` ran
  or was not needed.
- `rbAlsa`: `pending | done | conflict | failed`. It records step 2's outcome, and is `done` when
  the step was not needed.

A resumed rollback continues from the first `pending` step. It never re-runs a finished step, and
never retries a step that ended `conflict` or `failed`. Its final rollback value is the carried
outcome when `rbAlsa` is `conflict` or `failed`, even if the restart verifies; otherwise today's
rules apply. When the defer bound expires before the rollback resumes, the record is today's
`unresolved`, with the carried outcome kept beside it as `partial: "conflict" | "failed"`, so it is
not lost. The Voice tab shows both values.

**Deferred rollback.** Reset priority and deferral follow today's rules. The deferred snapshot also
carries `alsaPrev`, `alsaExpected`, `rbDevice` and `rbAlsa`. A drained `alsa-set` that exited 0 after
a defer sets `alsaExpected = present <node>` and `serviceDirty = true` (see `alsa-set` above). A
drained `rollback-alsa` sets `rbAlsa` from its exit (0 → `done` with `alsaExpected = alsaPrev`;
3 → `conflict`; other → `failed`).

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
  1. `audio.device` is `omaremote-mic`. Fix: `omarchy-shell omaremote micSystem <node>`.
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
  - a reset while `alsa-set` is in flight, the most important case. The order is: issue `alsa-set`,
    reset, then `alsa-set` exits 0. The operation defers rather than finishing, the drained exit sets
    `alsaExpected` and `serviceDirty`, and the deferred rollback issues `rollback-alsa`, then the
    restart, ending `verified`. The variant where the drained exit is 3 issues no `rollback-alsa`;
  - `alsa-set` failing while the operation is live ends with rollback `verified` and no restart;
  - a restart or verify failure rolls back in order: `audio.device`, then `rollback-alsa`, then the
    restart;
  - `rollback-alsa` from `absent` issues `--absent` with `--expect` the new node;
  - `rollback-alsa` exit 3 emits `conflict`, still restarts, and ends with rollback `conflict` even
    when the restart verifies;
  - `rollback-alsa` exit 2 still restarts and ends with rollback `failed` and the "partly restored"
    `unconfigured` effect, with nothing deferred;
  - a conflict in step 1 (`audio.device`) issues no `rollback-alsa`;
  - a drained `alsa-set`, and a drained `rollback-alsa`, after a defer correct `alsaExpected` and
    `rbAlsa`;
  - partial outcomes across a defer: `rollback-alsa` exits 2 (or 3), then `job-pending` defers it,
    then the resumed rollback restarts and verifies. The result stays `failed` (or `conflict`), the
    resumed rollback issues neither `rollback-get` nor `rollback-alsa` again, and the restart runs
    once;
  - a defer that expires with `rbAlsa = conflict` records `unresolved` with `partial: "conflict"`;
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
- `set --absent --expect <node>` after a `set` that created the block returns the file byte-identical
  when the original was empty, missing (it leaves an empty file) or ended in a newline. For a file
  without a final newline, it differs only by that added newline.
- A rollback to `present <old>` over a block whose inner lines were reformatted by hand writes the
  canonical block: the semantic state is restored, the formatting is not.
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
- **Unlocked readers during writes:** a loop of `alsa-mic get` runs while a writer alternates the
  block between two nodes and the atvvoice block is rewritten, 500 reads. Every read prints
  `present` with one of the two nodes, never `bad`. The same loop against the atvvoice state check
  never reports `bad`.
- The existing atvvoice setup tests still pass with the atomic, locked, single-read write.

**Integration** (fake-remote scenarios)
- `s_mic_system_device`: `ipc micSystem <fake node>` reaches Voxtype, the ALSA block and systemd, and
  the config ends with `systemDevice` set. The order `get`, `alsa-get`, `alsa-set`, `set`, `restart`
  is pinned by the MicApply unit tests, which see every command in one effect stream; the fake harness
  logs the processes in separate files.
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
