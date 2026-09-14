# Plan 1 core library — host obligations for Plan 2

The `lib/*.mjs` modules are effect-driven; the QML host (Plan 2) must honour these contracts, which the modules cannot enforce themselves:

- **Polls:** answer every `{ type: "poll" }` from VoiceSession *and* MicApply with a fresh `voxtype status` reading, delivered as `status(cls, now, { fresh: true })` / `backend(cls, now, { fresh: true })`. Only poll answers are `fresh: true`; follow-stream lines are `fresh: false`. Deliver poll answers within 500 ms or they count as stale.
- **ATVVoice reads:** answer every `{ type: "readAtv", requestId }` with `atvRead({ state, requestId, generation }, now)`; on a failed read deliver a non-`"streaming"` state. VoiceSession bounds an unanswered read at 500 ms and stops a dbus-owned session.
- **D-Bus source:** call `setDbusSource({ sender, generation })` after resolving the `org.atvvoice.*` owner and after every monitor (re)start, before delivering signals; signals and property replies without a matching sender and generation are dropped. Discard status buffered by the pre-restart monitor before calling `restartResult(true)`.
- **Verify ids:** `{ type: "verify", id }` from MicApply must be answered with `verifyResult(ok, now, id)`; the host's verifier checks `systemctl --user is-active voxtype`, a new `InvocationID`, and a fresh `idle` within 10 s.
- **systemd jobs:** while a mic operation is queued, applying, or deferred, poll `systemctl --user show voxtype --property=Job,ActiveState,InvocationID --value` at 1 s and call `systemdJob(job !== "", now)`.
- **Commit:** execute `{ type: "commit", mode }` by writing `voice.mic` to `config.json` synchronously; a write failure is an apply failure to surface in Doctor/UI (MicApply reports `succeeded` in the same step).
- **Done effects:** a deferred rollback emits `done` twice for the same `operationId` (once `deferred`, once terminal); the IPC `micStatus` reply should use `statusOf(id)`.
- **External recording:** call `mic.externalRecording(now)` only once an operation has reserved (state `applying`/`verifying`/`rollingBack`); a request that is still `queued` keeps waiting.
- **Timers:** drive `advance(now)` of KeyEngine, VoiceSession, MicApply and SelfTest from one Timer armed at the minimum non-null `nextDeadline()`.
- **Manifest:** `entryPoints` name `Service.qml`/`BarWidget.qml`, which exist only after Plan 2; `omarchy plugin validate` fails until then.

## Plan 2 audit (2026-09-14)

| obligation | where it is honoured | scenario |
|---|---|---|
| answer every `poll` with `fresh:true` within 500 ms | `Service.applyEffect` → `VoxtypeMonitor.poll()` → `onStatus(cls, true)` → `voice.status`/`mic.backend` | dbus_session, mic_apply_system |
| answer every `readAtv` | `AtvvoiceMonitor.readState` → `stateRead` → `voice.atvRead`; "" on failure | dbus_session, dbus_arbitration_short_tap |
| `setDbusSource` after every monitor (re)start | `AtvvoiceMonitor.source` → `voice.setDbusSource` before any signal | remote_warning_disables_dbus_path |
| verify ids answered | `SystemdVerifier.verified("mic", id)` → `mic.verifyResult(ok, now, id)` | mic_apply_system, mic_apply_restart_fails_rolls_back |
| systemd job polling at 1 s | `SystemdVerifier.jobPolling` bound to `mic.pending()` → `mic.systemdJob` | mic_apply_job_pending_blocks |
| commit write synchronous, failure surfaced | `ConfigStore.setVoiceMic` → `saveFailed` → `lastError` | mic_apply_system |
| tolerate double `done` | `applyEffect("done")` idempotent; IPC uses `statusOf` | mic_apply_restart_fails_rolls_back |
| `externalRecording` only after reservation | `onVoiceState` checks `applying/verifying/rollingBack` | (unit-tested in Plan 1; host guard in code) |
| one Timer at min `nextDeadline()` | `Service.rearm()` over engine/voice/mic/selftest/verifier | repeat, start_never_confirms |
| manifest entry points exist | `Service.qml`, `BarWidget.qml` | `omarchy plugin validate .` in `make lint` |
