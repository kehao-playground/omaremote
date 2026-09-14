# OmaRemote QML Host Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the pure `lib/*.mjs` core (Plan 1) into a working Omarchy Quickshell plugin — `Service.qml` (engine host, voice session, mic apply, HUD, IPC), `BarWidget.qml` + `Panel.qml` (4 tabs), a hardware-free integration harness with fake adapters — so a remote mapped by keyd drives Hyprland and Voxtype end to end.

**Architecture:** `Service.qml` is the only place that spawns processes or owns timers. It instantiates the Plan 1 modules, drives all of them from **one** `Timer` armed at the minimum `nextDeadline()`, and routes every returned effect (`cmd`, `poll`, `readAtv`, `hud`, `state`, `verify`, `commit`, …) to small adapter components under `components/` (`CommandRunner`, `VoxtypeMonitor`, `AtvvoiceMonitor`, `SystemdVerifier`, `ConfigStore`, `StatsStore`, `Hud`). New pure helpers for the host (systemd parsing/verification, config-file patching, PipeWire capture lookup, presentation text) go into `lib/` with `node --test` coverage first; QML stays thin. Integration tests run a second Quickshell instance (`tests/harness`) that loads the same `Service.qml` with `PATH` pointed at bash fakes of `voxtype`, `busctl`, `systemctl`, `wtype`, … and drive it through IPC (`tests/fake-remote.sh`). UI files (`BarWidget.qml`, `Panel.qml`, tabs) are verified with `qmllint`, `omarchy plugin validate`, and an install into the live shell.

**Tech Stack:** Quickshell 0.3.1 (Qt 6.11: `Quickshell`, `Quickshell.Io`, `Quickshell.Wayland`, `Quickshell.Hyprland`), Omarchy shell plugin API (`qs.Ui`, `qs.Commons` — `BarWidget`, `Panel`, `KeyboardPanel`, `PanelKeyCatcher`, `Button`, `ToggleSwitch`, `Dropdown`, `NumberField`, `TextField`, `Style`, `Color`), Hyprland 0.56 (`global` dispatcher), voxtype 1.0.1 CLI, `busctl`, `systemctl --user`, bash 5 fakes, Node ≥ 20 `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-14-omaremote-design.md` (§N below). Read §2 (architecture, verification-first items), §3 (host contract, mic apply), §5 (voice session — only the *host obligations* matter here; the state machine is done), §6 (UI), §7 step 6 (self-test), §8, §9 before starting. Also read `docs/superpowers/plans/2026-09-14-omaremote-core-lib-host-obligations.md` — every bullet there is a requirement of this plan.

## Global Constraints

- Plugin id `io.github.kehao-chen.omaremote`; global-shortcut appid `omaremote`; IPC target `omaremote` (§2). Both are **overridable by environment only for the test harness**: `OMAREMOTE_APPID`, `OMAREMOTE_IPC_TARGET` (Hyprland rejects a second registration of the same appid:name, and IPC targets are global per shell).
- Repo root is the plugin. No symlinks anywhere in the tree (§2). `manifest.json` already declares `kinds: ["bar-widget","service"]`, `keepLoaded: true`, entry points `BarWidget.qml` / `Service.qml`.
- **Service.qml hosts the engine; BarWidget/Panel only read state and write config** (§2). The BarWidget reaches the service through the shell facade: `bar.shell.serviceFor("io.github.kehao-chen.omaremote")` (verified in `/usr/share/omarchy/shell/shell.qml` `pluginShellFor` → `_serviceLookup` with `allowOwnService`).
- **Only one `IpcHandler` per target in the whole plugin** — two handlers on one target cancel each other ("Function not found"). The Service owns target `omaremote`; `Panel.qml` sets `manageIpc: false` and `ipcTarget: ""`.
- **IPC functions have fixed arity** (verified: `Too few arguments provided`). Verbs: `ping`, `key <name> <down|up>`, `voice <verb> <arg>`, `reset`, `mic <remote|system>`, `micStatus <id>`, `selftestPing`, `selftestArm`, `selftestStatus <id>`, `selftestReport <id>`, `selftestDisarm <id>`, `micToggle`, `status`, `doctor`. (§7's `selftest ping|arm` spelling is split into `selftestPing`/`selftestArm` for this reason; Plan 3 uses these names.)
- Commands are argument arrays, never shell strings (§2). The only allowed external commands: `wtype`, `wpctl`, `playerctl`, `voxtype`, `busctl`, `hyprctl`, `pw-dump`, `omarchy-lock-screen`, `systemctl --user` (+ `mkdir -p` for our own two directories, and `host/omaremote-facts`, our own script). Nothing privileged, nothing installed (§2).
- Voice commands are exactly `voxtype record start|stop|cancel` — produced by `lib/VoiceSession.mjs`; the host never composes them (§4.3, §5.2).
- Short read/config commands: 2 s deadline; restart + verification: 10 s (§3 step 3). systemd job polling at 1 s while an operation is pending (§3, host obligations).
- Config: `$XDG_CONFIG_HOME/omaremote/config.json` (default `~/.config/omaremote/config.json`), created with defaults on first run, **never overwritten when corrupt** (§3, §8). Stats: `$XDG_DATA_HOME/omaremote/stats.json` (§5.5). Unknown fields preserved on write (§4.2) — the plugin writes the full raw JSON object it loaded, patched; it does **not** use `JsonAdapter` (declared-property adapters drop unknown keys, which would violate §4.2).
- `lib/` files must not import Node built-ins and stay ES2018 (no `??`, `?.`, optional catch binding) until Task 0 proves otherwise; every code file starts with a one-line comment naming the spec section it implements (Plan 1 convention; applies to `.qml`, `.mjs`, `.sh`).
- QML files must pass `qmllint -I "$OMARCHY_PATH/shell"` (qmllint lives at `/usr/lib/qt6/bin/qmllint` on Omarchy; the Makefile finds it). `omarchy plugin validate .` must pass from Task 0 on.
- Timing constants come from the loaded config (`timing.*`, `voice.*`); the host adds only these constants: `POLL_STALE_MS = 500` (host obligations), `JOB_POLL_MS = 1000`, `SHORT_CMD_MS = 2000`, `RESTART_CMD_MS = 10000`, `FLASH_MS = 600`, `RESET_FLASH_MS = 1000` (§6.3), D-Bus/status monitor backoff 1 s → 30 s cap (§5.4).
- Commit after every task with the message shown; append whatever attribution trailer your harness requires.

## File Structure

```
OmaRemote/
├── manifest.json                    # unchanged (Plan 1)
├── Service.qml                      # effect host: modules, one Timer, effect router, IPC, adapters (Tasks 0,5,6,7,8)
├── BarWidget.qml                    # glyph by state; Loader → Panel.qml; bar-widget contract (Task 9)
├── Panel.qml                        # Ui.Panel + KeyboardPanel, 4 tabs, keyboard navigation (Tasks 9–11)
├── components/
│   ├── CommandRunner.qml            # bounded Process per `cmd` effect, stdout capture, kill on deadline, reap by source (Task 6)
│   ├── VoxtypeMonitor.qml           # `voxtype status --follow` stream + one-shot polls + backoff (Task 6)
│   ├── AtvvoiceMonitor.qml          # busctl monitor, owner discovery, State/NodeName reads, MicClose/MicToggle (Task 6)
│   ├── SystemdVerifier.qml          # job polling, recovery restart, verification via lib/Systemd.mjs (Task 7)
│   ├── ConfigStore.qml              # FileView config.json: load/normalize/patch/write, internal-write guard (Task 5)
│   ├── StatsStore.qml               # FileView stats.json (Task 7)
│   ├── Hud.qml                      # PanelWindow overlay, top-centre, no focus (Task 6)
│   ├── TabBar.qml                   # 4-tab header (Task 9)
│   ├── StatusTab.qml                # (Task 9)
│   ├── KeysTab.qml, KeyRow.qml, ActionEditor.qml, TimingEditor.qml   # (Task 10)
│   ├── VoiceTab.qml                 # (Task 11)
│   └── SetupTab.qml, DoctorRow.qml  # (Task 11)
├── host/omaremote-facts             # bash: prints Doctor facts JSON; shared with Plan 3 `--doctor` (Task 8)
├── lib/
│   ├── Systemd.mjs                  # parseShow, backoffMs, createRestartVerifier (Task 1)
│   ├── ConfigFile.mjs               # load/serialize/withPatch/withKey — unknown fields preserved (Task 2)
│   ├── Pipewire.mjs                 # captureSourceOf(pw-dump JSON) (Task 2)
│   └── Presentation.mjs             # elapsedText, flashText, glyphLook, keysFromQtEvent, micStatusLine (Task 3)
├── tests/
│   ├── Systemd.test.mjs, ConfigFile.test.mjs, Pipewire.test.mjs, Presentation.test.mjs
│   ├── fixtures/pw-dump.json        # trimmed real pw-dump with one voxtype capture stream (Task 2)
│   ├── harness/shell.qml            # second Quickshell instance loading ../../Service.qml (Task 4)
│   ├── fakes/bin/{voxtype,busctl,systemctl,wtype,wpctl,playerctl,hyprctl,pw-dump,omarchy-lock-screen}  (Task 4)
│   ├── fake-remote.sh               # §9 integration scenarios over IPC (Tasks 4–8 add scenarios)
│   └── spike-task0.sh               # §2 verification-first items, run once on the live shell (Task 0)
├── docs/superpowers/plans/2026-09-14-omaremote-qml-host-task0.md   # spike findings (Task 0)
└── Makefile                         # test / lint / check / dev-install / dev-restart / integration
```

## Conventions for every QML task

- Each QML file starts with `// Spec §…` and uses `id: root`.
- Time is always `Date.now()` captured once per entry point (`var now = Date.now()`), then passed to every module call in that handler; every entry point (shortcut, IPC, process exit, monitor line, timer) ends with `root.rearm()`.
- `root.dispatch(effects, src)` is the *only* consumer of module effects. Never call a module and drop its return value.
- Log with `console.log("omaremote: …")`; never throw out of a handler (§8): wrap process-output parsing in `try/catch` and log.
- Verification of Service tasks = `make integration` (harness + fakes, no hardware, does not touch the live shell or the user's config). Verification of UI tasks = `make lint` + `make dev-install` + a look at the bar.

---

### Task 0: Verification spikes (§2 "Verification-first items") and the dev loop

**Files:**
- Modify: `Makefile`
- Create: `Service.qml` (spike version — replaced in Task 5), `BarWidget.qml` (spike version — replaced in Task 9)
- Create: `tests/spike-task0.sh`
- Create: `docs/superpowers/plans/2026-09-14-omaremote-qml-host-task0.md`

**Interfaces:**
- Consumes: `lib/Defaults.mjs` (`KEY_NAMES`, `DEFAULT_CONFIG`), `lib/Config.mjs` (`normalizeConfig`), `lib/KeyEngine.mjs` (`createKeyEngine`).
- Produces: `make dev-install` (rsync repo → `~/.config/omarchy/plugins/io.github.kehao-chen.omaremote/` + `rescanPlugins`), `make dev-restart` (dev-install + `omarchy-restart-shell`), `make lint` that finds `/usr/lib/qt6/bin/qmllint`; the findings document that later tasks cite.

> **This task runs on the developer's live Omarchy session and restarts `omarchy-shell`. Ask the user before running `make dev-restart` and before step 6 (it presses F13 through `wtype` and starts/cancels a real Voxtype recording).**

- [ ] **Step 1: Makefile — dev loop and qmllint discovery**

Replace `Makefile` with:

```make
.PHONY: test lint check dev-install dev-restart integration
PLUGIN_ID := io.github.kehao-chen.omaremote
PLUGIN_DIR := $(HOME)/.config/omarchy/plugins/$(PLUGIN_ID)
OMARCHY_SHELL := $(or $(OMARCHY_PATH),/usr/share/omarchy)/shell
QMLLINT := $(shell command -v qmllint 2>/dev/null || ls /usr/lib/qt6/bin/qmllint 2>/dev/null)

test:
	node --test "tests/*.test.mjs"

# qmllint and omarchy are only present on an Omarchy host; skip gracefully elsewhere.
lint:
	@if [ -n "$(QMLLINT)" ]; then "$(QMLLINT)" -I "$(OMARCHY_SHELL)" *.qml components/*.qml tests/harness/*.qml; else echo "qmllint not found - skipped"; fi
	@if command -v omarchy >/dev/null 2>&1; then omarchy plugin validate .; else echo "omarchy CLI not found - skipped"; fi

check: test lint

# Integration scenarios against a second Quickshell instance with fake adapters (Task 4+).
integration:
	bash tests/fake-remote.sh

# Copy the plugin into the user plugin directory (Omarchy forbids symlinks) and hot-reload.
dev-install:
	mkdir -p "$(PLUGIN_DIR)"
	rsync -a --delete --exclude .git --exclude node_modules --exclude tests --exclude docs --exclude .superpowers --exclude .claude ./ "$(PLUGIN_DIR)/"
	-omarchy-shell shell rescanPlugins

# keepLoaded services only pick up code changes on a shell restart.
dev-restart: dev-install
	omarchy-restart-shell
```

- [ ] **Step 2: Spike Service.qml**

Create `Service.qml`:

```qml
// Spec §2 verification-first items — spike host (replaced by the real Service in Task 5).
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Hyprland
import "lib/Defaults.mjs" as Defaults
import "lib/Config.mjs" as Config
import "lib/KeyEngine.mjs" as KeyEngine

Item {
  id: root
  property var shell: null
  property int pressCount: 0
  property int releaseCount: 0
  property bool widgetAttached: false
  readonly property string state: "spike"

  function esCheck() {
    var m = new Map([["a", 1]])
    var s = new Set([1, 2])
    var o = { ...{ x: 1 }, y: 2 }
    var eng = KeyEngine.createKeyEngine(Config.normalizeConfig(Defaults.DEFAULT_CONFIG).config)
    var fx = eng.press("home", 0)
    var cls = (function(a = 5) { return a })()
    return JSON.stringify({ keys: Defaults.KEY_NAMES.length, map: m.get("a"), set: s.size, spread: o.x + o.y,
      tpl: `t${o.y}`, includes: [1].includes(1), defaults: cls, engineAction: fx.length ? fx[0].type : null })
  }

  GlobalShortcut {
    appid: "omaremote"
    name: "up"
    onPressed: root.pressCount++
    onReleased: root.releaseCount++
  }

  PanelWindow {
    id: hud
    anchors.top: true
    exclusiveZone: 0
    implicitWidth: 260
    implicitHeight: 40
    color: "transparent"
    visible: root.pressCount > 0
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    WlrLayershell.namespace: "omaremote-hud"
    Rectangle {
      anchors.fill: parent
      radius: 8
      color: "#cc101315"
      Text { anchors.centerIn: parent; color: "#cacccc"; text: "omaremote spike " + root.pressCount + "/" + root.releaseCount }
    }
  }

  IpcHandler {
    target: "omaremote"
    function ping(): string { return "ok" }
    function es(): string { return root.esCheck() }
    function counts(): string {
      return JSON.stringify({ press: root.pressCount, release: root.releaseCount, widget: root.widgetAttached, hudVisible: hud.visible })
    }
  }
}
```

- [ ] **Step 3: Spike BarWidget.qml**

Create `BarWidget.qml`:

```qml
// Spec §2 verification-first item 1 — spike widget (replaced in Task 9).
import QtQuick
import qs.Ui

BarWidget {
  id: root
  moduleName: "io.github.kehao-chen.omaremote"
  readonly property string pluginId: "io.github.kehao-chen.omaremote"
  property var service: null

  // Bar contract (Bar.findPanelWidget needs these on the widget root).
  readonly property bool opened: false
  readonly property bool popoutSwitchClosing: false
  function open() {}
  function close() {}
  function toggle() {}
  function closeForPopoutSwitch() {}

  function findService() {
    var s = bar && bar.shell && typeof bar.shell.serviceFor === "function" ? bar.shell.serviceFor(pluginId) : null
    if (!s) return
    service = s
    s.widgetAttached = true
    retry.stop()
  }
  Timer { id: retry; interval: 500; repeat: true; running: true; onTriggered: root.findService() }
  onBarChanged: findService()

  implicitWidth: label.implicitWidth + 16
  implicitHeight: barSize
  Text {
    id: label
    anchors.centerIn: parent
    text: root.service ? "󰍬 " + root.service.pressCount : "󰍬 ?"
    color: root.bar ? root.bar.barForeground : "white"
    font.family: root.bar ? root.bar.fontFamily : ""
    font.pixelSize: 14
  }
}
```

- [ ] **Step 4: Lint + validate**

Run: `make lint`
Expected: qmllint prints nothing (or only warnings about unqualified access — fix those, they are errors under `omarchy plugin validate` later); `omarchy plugin validate .` prints an OK line and exits 0 (it previously failed with `entry point file not found: 'BarWidget.qml'`).

- [ ] **Step 5: Spike script**

Create `tests/spike-task0.sh`:

```bash
#!/usr/bin/env bash
# Spec §2 "Verification-first items" (1)-(4) + ES-module check. Run on a live Omarchy session
# after `make dev-restart` and `omarchy plugin enable io.github.kehao-chen.omaremote right`.
set -uo pipefail
say() { printf '%s\n' "$*"; }
streams() {
  pw-dump | jq '[.[] | select(.type == "PipeWire:Interface:Node")
                     | select((.info.props["media.class"] // "") == "Stream/Input/Audio")
                     | select(((.info.props["application.name"] // "") + (.info.props["node.name"] // "")) | test("voxtype"; "i"))] | length'
}
say "## versions"
hyprctl version | head -1; quickshell --version; voxtype --version; pacman -Q keyd 2>/dev/null || say "keyd: not installed"
say "## 0a ES modules from QML (Map/Set/spread/template/default params/includes/engine)"
omarchy-shell omaremote es
say "## 0b bar widget reaches the service through bar.shell.serviceFor (expect widget:true)"
sleep 1; omarchy-shell omaremote counts
say "## 0c GlobalShortcut press+release from one 'global' bind (hl.dsp.global equivalent)"
hyprctl keyword bind ",F13,global,omaremote:up" >/dev/null
before=$(omarchy-shell omaremote counts)
wtype -P F13 -s 100 -p F13; sleep 0.3
after=$(omarchy-shell omaremote counts)
say "before=$before"; say "after=$after   (expect press and release each +1)"
hyprctl reload >/dev/null
say "## 0d service-owned PanelWindow (expect hudVisible:true after the press above)"
omarchy-shell omaremote counts
say "## 0e Voxtype opens its capture stream only while recording (expect 0 / >=1 / 0)"
say "idle: $(streams)"
voxtype record start; sleep 1.5
say "recording: $(streams)"
voxtype record cancel; sleep 0.7
say "after cancel: $(streams)"
```

- [ ] **Step 6: Run the spikes (with the user's go-ahead)**

Run:
```bash
make dev-restart
sleep 3
omarchy plugin enable io.github.kehao-chen.omaremote right
sleep 2
bash tests/spike-task0.sh | tee /tmp/omaremote-spike.txt
```
Expected: `es` returns `{"keys":13,"map":1,"set":2,"spread":3,"tpl":"t2","includes":true,"defaults":5,"engineAction":"action"}`; `widget:true`; press/release both +1; `hudVisible:true`; streams `0`, `≥1`, `0`.

If 0c shows press but no release: try a Lua bind instead — append `hl.bind("F13", hl.dsp.global("omaremote:up"), { description = "omaremote:up" })` to a temporary `~/.config/hypr/omaremote.lua` + `require("hypr.omaremote")` in `hyprland.lua`, `hyprctl reload`, repeat, then remove. Record which form delivered release. If neither does, **stop and report** — §2 names the `exec` IPC fallback and requires a revised contract before continuing.

- [ ] **Step 7: Record findings**

Create `docs/superpowers/plans/2026-09-14-omaremote-qml-host-task0.md` with the tee'd output and a verdict table:

```markdown
# Plan 2 Task 0 — verification findings (2026-09-14)

| item | result | evidence |
|---|---|---|
| ES modules (`.mjs` named exports, Map/Set/spread/template/default params/includes) | pass/fail | `es` output |
| (1) bar-widget + service kinds; widget reaches service via `bar.shell.serviceFor` | pass/fail | `counts` widget:true |
| (2) service-owned PanelWindow | pass/fail | hudVisible:true |
| (3) one `global` bind delivers press and release | pass/fail (+ which bind form) | counts before/after |
| (4) Voxtype capture stream only while recording | pass/fail | stream counts |

Versions: hyprland …, quickshell …, voxtype …, keyd …
```

Any failure here gates the rest of the plan (§2 fallbacks) — report it before continuing.

- [ ] **Step 8: Commit**

```bash
git add Makefile Service.qml BarWidget.qml tests/spike-task0.sh docs/superpowers/plans/2026-09-14-omaremote-qml-host-task0.md
git commit -m "chore(host): task-0 spikes, dev-install loop, qmllint discovery"
```

---

### Task 1: `lib/Systemd.mjs` — systemd show parsing, backoff, restart verifier

**Files:**
- Create: `lib/Systemd.mjs`
- Test: `tests/Systemd.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseShow(stdout) → { job, activeState, invocationId, jobPending }` (input is the three `--value` lines of `systemctl --user show voxtype --property=Job,ActiveState,InvocationID --value`, in that order — verified on the host: an empty `Job` prints an empty first line); `backoffMs(attempt) → 1000·2^attempt capped at 30000` (§5.4); `createRestartVerifier({ deadlineMs = 10000 }) → { begin(id, prevInvocation, now), show(info, now), status(cls, fresh, now), advance(now), nextDeadline(), active(), id() }` emitting effects `{type:"show"}`, `{type:"poll"}` (1 s cadence) and `{type:"verified", id, ok, reason}` (§3 step 3: active + new InvocationID + fresh idle within 10 s; transient `stopped` retried, old-invocation idle discarded).

- [ ] **Step 1: Write the failing tests**

Create `tests/Systemd.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShow, backoffMs, createRestartVerifier } from "../lib/Systemd.mjs";
import { byType, last } from "./helpers.mjs";

test("parseShow reads job/active/invocation lines; empty job means no pending job", () => {
  assert.deepEqual(parseShow("\nactive\n9ca6e278\n"), { job: "", activeState: "active", invocationId: "9ca6e278", jobPending: false });
  assert.deepEqual(parseShow("1234 restart\nactivating\nabc"), { job: "1234 restart", activeState: "activating", invocationId: "abc", jobPending: true });
  assert.deepEqual(parseShow(""), { job: "", activeState: "", invocationId: "", jobPending: false });
  assert.equal(parseShow(null).jobPending, false);
});

test("backoffMs doubles from 1 s and caps at 30 s", () => {
  assert.deepEqual([0, 1, 2, 4, 5, 9].map(backoffMs), [1000, 2000, 4000, 16000, 30000, 30000]);
});

test("verifier succeeds only after a new invocation, active state and a fresh idle", () => {
  const v = createRestartVerifier();
  const fx = v.begin("mic-1", "old", 0);
  assert.deepEqual(fx.map(e => e.type), ["show", "poll"]);
  assert.equal(v.active(), true);
  assert.deepEqual(v.show({ job: "", activeState: "active", invocationId: "new" }, 100), []);
  const done = v.status("idle", true, 150);
  assert.deepEqual(last(done, "verified"), { type: "verified", id: "mic-1", ok: true, reason: undefined });
  assert.equal(v.active(), false);
});

test("an idle observed before the invocation changed is discarded", () => {
  const v = createRestartVerifier();
  v.begin("r", "old", 0);
  assert.deepEqual(v.status("idle", true, 50), []);                                   // old daemon's idle
  assert.deepEqual(v.show({ job: "", activeState: "active", invocationId: "old" }, 60), []);
  assert.deepEqual(v.show({ job: "", activeState: "active", invocationId: "new" }, 1100), []);   // still needs a newer idle
  assert.equal(last(v.status("idle", true, 1200), "verified").ok, true);
});

test("non-fresh status and transient stopped do not verify; a later fresh idle does", () => {
  const v = createRestartVerifier();
  v.begin("r", "old", 0);
  v.show({ job: "", activeState: "active", invocationId: "new" }, 100);
  assert.deepEqual(v.status("idle", false, 110), []);
  assert.deepEqual(v.status("stopped", true, 120), []);
  assert.equal(last(v.status("idle", true, 130), "verified").ok, true);
});

test("verifier times out at the deadline and reports failure once", () => {
  const v = createRestartVerifier({ deadlineMs: 10000 });
  v.begin("r", "old", 0);
  assert.deepEqual(byType(v.advance(9999), "verified"), []);
  const fx = v.advance(10000);
  assert.deepEqual(last(fx, "verified"), { type: "verified", id: "r", ok: false, reason: "timeout" });
  assert.equal(v.active(), false);
  assert.deepEqual(v.advance(20000), []);
  assert.equal(v.nextDeadline(), null);
});

test("verifier re-polls show+status every second while pending", () => {
  const v = createRestartVerifier();
  v.begin("r", "old", 0);
  assert.equal(v.nextDeadline(), 1000);
  assert.deepEqual(v.advance(500), []);
  assert.deepEqual(v.advance(1000).map(e => e.type), ["show", "poll"]);
  assert.equal(v.nextDeadline(), 2000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/Systemd.test.mjs`
Expected: FAIL — `Cannot find module '../lib/Systemd.mjs'`.

- [ ] **Step 3: Implement**

Create `lib/Systemd.mjs`:

```js
// Spec §3 (systemd job contract, restart verified by active + new InvocationID + fresh idle within 10 s), §5.3 (bounded recovery restart), §5.4 (monitor backoff 1 s → 30 s).
const POLL_MS = 1000;

export function parseShow(stdout) {
  const lines = String(stdout === undefined || stdout === null ? "" : stdout).split("\n");
  const job = (lines[0] || "").trim();
  const activeState = (lines[1] || "").trim();
  const invocationId = (lines[2] || "").trim();
  return { job, activeState, invocationId, jobPending: job !== "" };
}

export function backoffMs(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(30000, 1000 * Math.pow(2, n));
}

export function createRestartVerifier({ deadlineMs = 10000 } = {}) {
  let v = null;   // { id, prev, until, nextPoll, changed, active, idle }

  function finish(ok, reason) { const id = v.id; v = null; return { type: "verified", id, ok, reason }; }
  function check(now) {
    if (!v) return [];
    if (v.changed && v.active && v.idle) return [finish(true, undefined)];
    if (now >= v.until) return [finish(false, "timeout")];
    return [];
  }

  return {
    begin(id, prevInvocation, now) {
      v = { id, prev: prevInvocation || "", until: now + deadlineMs, nextPoll: now + POLL_MS, changed: false, active: false, idle: false };
      return [{ type: "show" }, { type: "poll" }];
    },
    show(info, now) {
      if (!v) return [];
      v.changed = !!info.invocationId && info.invocationId !== v.prev;
      v.active = info.activeState === "active";
      if (!v.changed) v.idle = false;        // an idle seen before the new invocation belongs to the old daemon
      return check(now);
    },
    status(cls, fresh, now) {
      if (!v || !fresh) return [];
      v.idle = v.changed && cls === "idle";  // transient stopped/other classes are retried until the deadline
      return check(now);
    },
    advance(now) {
      const out = check(now);
      if (v && now >= v.nextPoll) { v.nextPoll = now + POLL_MS; out.push({ type: "show" }, { type: "poll" }); }
      return out;
    },
    nextDeadline() { return v ? Math.min(v.until, v.nextPoll) : null; },
    active() { return v !== null; },
    id() { return v ? v.id : null; },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/Systemd.test.mjs` → 7 pass. Then `make test` → all pass (152 + 7).

- [ ] **Step 5: Commit**

```bash
git add lib/Systemd.mjs tests/Systemd.test.mjs
git commit -m "feat(host): systemd show parsing, backoff and restart verifier"
```

---

### Task 2: `lib/ConfigFile.mjs` and `lib/Pipewire.mjs`

**Files:**
- Create: `lib/ConfigFile.mjs`, `lib/Pipewire.mjs`, `tests/fixtures/pw-dump.json`
- Test: `tests/ConfigFile.test.mjs`, `tests/Pipewire.test.mjs`

**Interfaces:**
- Consumes: `lib/Defaults.mjs` (`DEFAULT_CONFIG`, `DEFAULT_KEYS`), `lib/Config.mjs` (`normalizeConfig`).
- Produces: `ConfigFile.load(text) → { raw, config, problems, missing, invalid }`; `serialize(raw) → string`; `withPatch(raw, path[], value) → raw'` (`undefined` deletes); `withKey(raw, name, fields) → raw'` (merge into `keys[name]`, `undefined` deletes a field); `withDefaultKeys(raw) → raw'` (keeps `supported:false` flags); `Pipewire.captureSourceOf(dump, match=/voxtype/i) → { streamFound, node }`; `Pipewire.sourceNames(dump) → string[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/ConfigFile.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, serialize, withPatch, withKey, withDefaultKeys } from "../lib/ConfigFile.mjs";
import { DEFAULT_CONFIG } from "../lib/Defaults.mjs";

test("empty or missing text loads defaults and flags missing (first run creates the file)", () => {
  const r = load("");
  assert.equal(r.missing, true); assert.equal(r.invalid, false);
  assert.deepEqual(r.raw, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  assert.equal(r.config.voice.mic, "remote");
  assert.equal(load(undefined).missing, true);
});

test("invalid JSON or a non-object loads defaults, flags invalid and reports config-invalid", () => {
  const r = load("{ not json");
  assert.equal(r.invalid, true); assert.equal(r.missing, false);
  assert.equal(r.problems[0].code, "config-invalid");
  assert.equal(load("[1,2]").invalid, true);
});

test("a valid file keeps raw (unknown fields) and normalizes config", () => {
  const r = load(JSON.stringify({ version: 1, extra: { a: 1 }, keys: { ok: { tap: { type: "key", keys: "Return" }, note: "mine" } } }));
  assert.equal(r.invalid, false);
  assert.deepEqual(r.raw.extra, { a: 1 });
  assert.equal(r.raw.keys.ok.note, "mine");
  assert.equal(r.config.keys.up.repeat, true);         // defaults filled in for missing keys
  assert.equal(r.config.keys.ok.note, "mine");         // §4.2 unknown per-key fields preserved
});

test("withPatch sets a nested path without touching other fields and deletes on undefined", () => {
  const raw = { version: 1, extra: 1, voice: { mic: "remote", custom: true } };
  const next = withPatch(raw, ["voice", "mic"], "system");
  assert.equal(next.voice.mic, "system"); assert.equal(next.voice.custom, true); assert.equal(next.extra, 1);
  assert.equal(raw.voice.mic, "remote");                 // input untouched
  assert.deepEqual(withPatch({}, ["timing", "holdMs"], 400), { timing: { holdMs: 400 } });
  assert.deepEqual(withPatch({ a: { b: 1 } }, ["a", "b"], undefined), { a: {} });
});

test("withKey merges fields into keys[name], deletes undefined fields, keeps unknown fields", () => {
  const raw = { keys: { ok: { tap: { type: "key", keys: "Return" }, hold: { type: "key", keys: "ctrl+c" }, note: "x" } } };
  const next = withKey(raw, "ok", { hold: undefined, repeat: true });
  assert.deepEqual(next.keys.ok, { tap: { type: "key", keys: "Return" }, repeat: true, note: "x" });
  assert.deepEqual(withKey({}, "up", { repeat: false }).keys.up, { repeat: false });
});

test("withDefaultKeys restores default actions but keeps supported:false", () => {
  const raw = { keys: { app: { supported: false, tap: { type: "none" } }, ok: { tap: { type: "none" } } }, device: { name: "G20S" } };
  const next = withDefaultKeys(raw);
  assert.equal(next.keys.app.supported, false);
  assert.equal(next.keys.app.tap.type, "dispatch");
  assert.equal(next.keys.ok.tap.keys, "Return");
  assert.equal(next.device.name, "G20S");
});

test("serialize round-trips with a trailing newline", () => {
  const raw = { version: 1, extra: [1, 2] };
  assert.deepEqual(JSON.parse(serialize(raw)), raw);
  assert.ok(serialize(raw).endsWith("\n"));
});
```

Create `tests/fixtures/pw-dump.json` (trimmed to the object shapes `pw-dump` emits — `type`, `id`, `info.props`, and for links `info["output-node-id"]` / `info["input-node-id"]`):

```json
[
  { "id": 30, "type": "PipeWire:Interface:Node", "info": { "props": { "node.name": "alsa_output.pci-0000_00_1f.3.analog-stereo", "media.class": "Audio/Sink" } } },
  { "id": 40, "type": "PipeWire:Interface:Node", "info": { "props": { "node.name": "atvvoice_mic", "node.description": "ATVVoice Remote Mic", "media.class": "Audio/Source" } } },
  { "id": 41, "type": "PipeWire:Interface:Node", "info": { "props": { "node.name": "alsa_input.pci-0000_00_1f.3.analog-stereo", "media.class": "Audio/Source" } } },
  { "id": 60, "type": "PipeWire:Interface:Node", "info": { "props": { "node.name": "voxtype", "application.name": "voxtype", "media.class": "Stream/Input/Audio" } } },
  { "id": 61, "type": "PipeWire:Interface:Port", "info": { "props": { "node.id": 60, "port.direction": "in" } } },
  { "id": 70, "type": "PipeWire:Interface:Link", "info": { "output-node-id": 40, "output-port-id": 42, "input-node-id": 60, "input-port-id": 61, "state": "active" } }
]
```

Create `tests/Pipewire.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { captureSourceOf, sourceNames } from "../lib/Pipewire.mjs";

const dump = JSON.parse(readFileSync(new URL("./fixtures/pw-dump.json", import.meta.url), "utf8"));

test("captureSourceOf finds the node linked into voxtype's capture stream", () => {
  assert.deepEqual(captureSourceOf(dump), { streamFound: true, node: "atvvoice_mic" });
});

test("no voxtype stream means not yet verified, never a pass", () => {
  const noStream = dump.filter(o => o.id !== 60 && o.id !== 70);
  assert.deepEqual(captureSourceOf(noStream), { streamFound: false, node: null });
  assert.deepEqual(captureSourceOf(null), { streamFound: false, node: null });
});

test("a stream with no link reports the stream but no node", () => {
  const unlinked = dump.filter(o => o.id !== 70);
  assert.deepEqual(captureSourceOf(unlinked), { streamFound: true, node: null });
});

test("sourceNames lists Audio/Source node names", () => {
  assert.deepEqual(sourceNames(dump), ["atvvoice_mic", "alsa_input.pci-0000_00_1f.3.analog-stereo"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/ConfigFile.test.mjs tests/Pipewire.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `lib/ConfigFile.mjs`:

```js
// Spec §3 plugin-side files, §4.2 (unknown fields preserved on write), §8 (corrupt config → defaults, never overwritten).
import { DEFAULT_CONFIG, DEFAULT_KEYS, KEY_NAMES } from "./Defaults.mjs";
import { normalizeConfig } from "./Config.mjs";

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function defaults(problems, missing, invalid) {
  const raw = clone(DEFAULT_CONFIG);
  return { raw, config: normalizeConfig(raw).config, problems, missing, invalid };
}

export function load(text) {
  const t = text === undefined || text === null ? "" : String(text);
  if (t.trim() === "") return defaults([], true, false);
  let raw;
  try { raw = JSON.parse(t); } catch (e) {
    return defaults([{ code: "config-invalid", message: "config.json is not valid JSON; using defaults" }], false, true);
  }
  if (!isObj(raw)) return defaults([{ code: "config-invalid", message: "config.json is not an object; using defaults" }], false, true);
  const n = normalizeConfig(raw);
  return { raw, config: n.config, problems: n.problems, missing: false, invalid: false };
}

export function serialize(raw) { return JSON.stringify(raw, null, 2) + "\n"; }

export function withPatch(raw, path, value) {
  const next = clone(isObj(raw) ? raw : {});
  let cur = next;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isObj(cur[path[i]])) cur[path[i]] = {};
    cur = cur[path[i]];
  }
  const leaf = path[path.length - 1];
  if (value === undefined) delete cur[leaf]; else cur[leaf] = clone(value);
  return next;
}

export function withKey(raw, name, fields) {
  const next = clone(isObj(raw) ? raw : {});
  if (!isObj(next.keys)) next.keys = {};
  const merged = isObj(next.keys[name]) ? { ...next.keys[name] } : {};
  for (const k of Object.keys(fields)) {
    if (fields[k] === undefined) delete merged[k]; else merged[k] = clone(fields[k]);
  }
  next.keys[name] = merged;
  return next;
}

export function withDefaultKeys(raw) {
  const next = clone(isObj(raw) ? raw : {});
  const prev = isObj(next.keys) ? next.keys : {};
  next.keys = {};
  for (const name of KEY_NAMES) {
    next.keys[name] = clone(DEFAULT_KEYS[name] || {});
    if (isObj(prev[name]) && prev[name].supported === false) next.keys[name].supported = false;
  }
  return next;
}
```

Create `lib/Pipewire.mjs`:

```js
// Spec §3 ("capture device is verified on the next session: pw-dump must show Voxtype's stream linked to the expected node"), §6.2 Doctor facts.
const props = (o) => (o && o.info && o.info.props) || {};
const nodesOf = (dump) => (Array.isArray(dump) ? dump : []).filter(o => o && o.type === "PipeWire:Interface:Node");

export function captureSourceOf(dump, match = /voxtype/i) {
  const nodes = nodesOf(dump);
  const stream = nodes.find(n => props(n)["media.class"] === "Stream/Input/Audio"
    && match.test(`${props(n)["application.name"] || ""} ${props(n)["node.name"] || ""}`));
  if (!stream) return { streamFound: false, node: null };
  const links = (Array.isArray(dump) ? dump : []).filter(o => o && o.type === "PipeWire:Interface:Link" && o.info && o.info["input-node-id"] === stream.id);
  const src = nodes.find(n => links.some(l => l.info["output-node-id"] === n.id));
  return { streamFound: true, node: src ? (props(src)["node.name"] || null) : null };
}

export function sourceNames(dump) {
  return nodesOf(dump).filter(n => props(n)["media.class"] === "Audio/Source").map(n => props(n)["node.name"]).filter(Boolean);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ConfigFile.test.mjs tests/Pipewire.test.mjs` → 11 pass; `make test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/ConfigFile.mjs lib/Pipewire.mjs tests/ConfigFile.test.mjs tests/Pipewire.test.mjs tests/fixtures/pw-dump.json
git commit -m "feat(host): config-file patching with unknown-field preservation and pw-dump capture lookup"
```

---

### Task 3: `lib/Presentation.mjs` — text and glyph rules for HUD, bar and panel

**Files:**
- Create: `lib/Presentation.mjs`
- Test: `tests/Presentation.test.mjs`

**Interfaces:**
- Consumes: `lib/Actions.mjs` (`describe`).
- Produces: `elapsedText(ms) → "mm:ss"`; `keyLabel(name)`; `flashText(key, trigger, action) → "OK · hold → Ctrl+C"` (§6.3); `glyphLook(s) → "selftest"|"busy"|"recording"|"transcribing"|"pending"|"unconfigured"|"disconnected"|"ready"` (§6.1 precedence: active voice/operation states before disconnected/ready); `hudLine({ voiceState, hudText, elapsedMs, flash }) → string` (§6.3); `micStatusLine(status) → string`; `keysFromQtEvent(key, modifiers, text) → "ctrl+shift+Return" | null` (Keys tab capture mode, §6.2; bare modifiers return null).

- [ ] **Step 1: Write the failing tests**

Create `tests/Presentation.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { elapsedText, keyLabel, flashText, glyphLook, hudLine, micStatusLine, keysFromQtEvent } from "../lib/Presentation.mjs";

test("elapsedText formats mm:ss and clamps negatives", () => {
  assert.equal(elapsedText(4000), "00:04");
  assert.equal(elapsedText(61999), "01:01");
  assert.equal(elapsedText(-5), "00:00");
});

test("flashText names key, trigger and action", () => {
  assert.equal(flashText("ok", "hold", { type: "key", keys: "ctrl+c" }), "OK · hold → Ctrl+C");
  assert.equal(flashText("volup", "tap", { type: "volume", delta: "+5" }), "Vol+ · tap → Volume +5");
  assert.equal(keyLabel("unknown"), "unknown");
});

test("glyphLook precedence: self-test > busy > recording > transcribing > pending > unconfigured > disconnected > ready", () => {
  assert.equal(glyphLook({ selftest: true, voiceState: "recording" }), "selftest");
  assert.equal(glyphLook({ voiceState: "recovering", remoteState: "disconnected" }), "busy");
  assert.equal(glyphLook({ voiceState: "idle", micPending: true }), "busy");
  assert.equal(glyphLook({ voiceState: "recording", unconfigured: true }), "recording");
  assert.equal(glyphLook({ voiceState: "stopping" }), "transcribing");
  assert.equal(glyphLook({ voiceState: "transcribing" }), "transcribing");
  assert.equal(glyphLook({ voiceState: "arbitrating" }), "pending");
  assert.equal(glyphLook({ voiceState: "starting" }), "pending");
  assert.equal(glyphLook({ voiceState: "unconfigured" }), "unconfigured");
  assert.equal(glyphLook({ voiceState: "idle", unconfigured: true }), "unconfigured");
  assert.equal(glyphLook({ voiceState: "idle", remoteState: "disconnected" }), "disconnected");
  assert.equal(glyphLook({ voiceState: "idle", remoteState: "absent" }), "disconnected");
  assert.equal(glyphLook({ voiceState: "idle", remoteState: "connected" }), "ready");
});

test("hudLine: flash wins, recording shows the timer, transcribing is fixed text, else the session text", () => {
  assert.equal(hudLine({ voiceState: "recording", elapsedMs: 4000, flash: "OK · hold → Ctrl+C" }), "OK · hold → Ctrl+C");
  assert.equal(hudLine({ voiceState: "recording", elapsedMs: 4000, hudText: "recording" }), "● 00:04");
  assert.equal(hudLine({ voiceState: "recording", elapsedMs: 4000, hudText: "mic change applies after this dictation" }), "● 00:04 · mic change applies after this dictation");   // §3 step 1
  assert.equal(hudLine({ voiceState: "transcribing", hudText: "recording" }), "… transcribing");
  assert.equal(hudLine({ voiceState: "starting", hudText: "starting…" }), "starting…");
  assert.equal(hudLine({ voiceState: "idle", hudText: "" }), "");
});

test("micStatusLine renders queued/applying/failed with rollback", () => {
  assert.equal(micStatusLine(null), "");
  assert.equal(micStatusLine({ state: "queued" }), "queued");
  assert.equal(micStatusLine({ state: "failed", error: "restart-failed", rollback: "verified" }), "failed: restart-failed (rollback: verified)");
  assert.equal(micStatusLine({ state: "succeeded" }), "succeeded");
});

test("keysFromQtEvent maps Qt key codes and modifiers to wtype keysyms", () => {
  const CTRL = 0x04000000, SHIFT = 0x02000000, ALT = 0x08000000, SUPER = 0x10000000;
  assert.equal(keysFromQtEvent(0x01000004, 0, "\r"), "Return");
  assert.equal(keysFromQtEvent(0x43, CTRL | SHIFT, ""), "ctrl+shift+c");
  assert.equal(keysFromQtEvent(0x41, ALT | SUPER, "a"), "alt+super+a");
  assert.equal(keysFromQtEvent(0x01000030, 0, ""), "F1");
  assert.equal(keysFromQtEvent(0x0100003b, 0, ""), "F12");
  assert.equal(keysFromQtEvent(0x20, 0, " "), "space");
  assert.equal(keysFromQtEvent(0x01000021, CTRL, ""), null);       // bare Control
  assert.equal(keysFromQtEvent(0x01000020, SHIFT, ""), null);      // bare Shift
  assert.equal(keysFromQtEvent(0x2e, 0, "."), ".");
  assert.equal(keysFromQtEvent(0x01ffffff, 0, ""), null);          // Key_unknown
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/Presentation.test.mjs` → FAIL, module not found.

- [ ] **Step 3: Implement**

Create `lib/Presentation.mjs`:

```js
// Spec §6.1 (bar glyph by state, precedence), §6.3 (HUD lines and flashes), §6.2 (Keys tab capture, Voice tab mic status).
import { describe } from "./Actions.mjs";

const pad2 = (n) => (n < 10 ? "0" : "") + n;
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

const KEY_LABEL = { up: "Up", down: "Down", left: "Left", right: "Right", ok: "OK", back: "Back", home: "Home", menu: "Menu", app: "App", volup: "Vol+", voldown: "Vol−", power: "Power", mic: "Mic" };
export function keyLabel(name) { return KEY_LABEL[name] || String(name); }
export function flashText(key, trigger, action) { return `${keyLabel(key)} · ${trigger} → ${describe(action)}`; }

export function glyphLook(s) {
  const st = s.voiceState || "idle";
  if (s.selftest) return "selftest";
  if (st === "recovering" || s.micPending) return "busy";
  if (st === "recording") return "recording";
  if (st === "transcribing" || st === "stopping") return "transcribing";
  if (st === "arbitrating" || st === "starting") return "pending";
  if (st === "unconfigured" || s.unconfigured) return "unconfigured";
  if (s.remoteState === "disconnected" || s.remoteState === "absent") return "disconnected";
  return "ready";
}

export function hudLine(s) {
  if (s.flash) return s.flash;
  if (s.voiceState === "recording") {
    const extra = s.hudText && s.hudText !== "recording" ? ` · ${s.hudText}` : "";   // e.g. "mic change applies after this dictation" (§3 step 1)
    return `● ${elapsedText(s.elapsedMs || 0)}${extra}`;
  }
  if (s.voiceState === "transcribing") return "… transcribing";
  return s.hudText || "";
}

export function micStatusLine(status) {
  if (!status) return "";
  let line = status.state;
  if (status.error) line += `: ${status.error}`;
  if (status.rollback) line += ` (rollback: ${status.rollback})`;
  return line;
}

// Qt::Key values are stable ABI; listed so the panel needs no QML enum plumbing.
const QT_KEYS = {
  0x01000000: "Escape", 0x01000001: "Tab", 0x01000003: "BackSpace", 0x01000004: "Return", 0x01000005: "KP_Enter",
  0x01000006: "Insert", 0x01000007: "Delete", 0x01000010: "Home", 0x01000011: "End", 0x01000012: "Left",
  0x01000013: "Up", 0x01000014: "Right", 0x01000015: "Down", 0x01000016: "Page_Up", 0x01000017: "Page_Down", 0x20: "space",
};
for (let i = 0; i < 12; i++) QT_KEYS[0x01000030 + i] = `F${i + 1}`;
const MODIFIER_KEYS = [0x01000020, 0x01000021, 0x01000022, 0x01000023];               // Shift, Control, Meta, Alt
const MODIFIERS = [[0x04000000, "ctrl"], [0x02000000, "shift"], [0x08000000, "alt"], [0x10000000, "super"]];

export function keysFromQtEvent(key, modifiers, text) {
  if (MODIFIER_KEYS.includes(key)) return null;
  const mods = MODIFIERS.filter(m => (modifiers & m[0]) !== 0).map(m => m[1]);
  let name = QT_KEYS[key];
  if (!name && key >= 0x21 && key <= 0x7e) name = String.fromCharCode(key).toLowerCase();   // printable ASCII: Qt key = uppercase code
  if (!name) {
    const t = String(text || "");
    if (t.length === 1 && t.charCodeAt(0) > 32) name = t.toLowerCase(); else return null;
  }
  return mods.concat([name]).join("+");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/Presentation.test.mjs` → 6 pass; `make test` → all pass. Also `grep -n '??\|?\.\|catch {' lib/*.mjs` → no output.

- [ ] **Step 5: Commit**

```bash
git add lib/Presentation.mjs tests/Presentation.test.mjs
git commit -m "feat(host): presentation rules for glyph, HUD, flashes and key capture"
```

---

### Task 4: Integration harness, fake adapters and `tests/fake-remote.sh`

**Files:**
- Create: `tests/harness/shell.qml`, `tests/fakes/bin/voxtype`, `tests/fakes/bin/busctl`, `tests/fakes/bin/systemctl`, `tests/fakes/bin/wtype`, `tests/fakes/bin/wpctl`, `tests/fakes/bin/playerctl`, `tests/fakes/bin/hyprctl`, `tests/fakes/bin/pw-dump`, `tests/fakes/bin/omarchy-lock-screen`, `tests/fakes/bin/fake-log.sh`
- Create: `tests/fake-remote.sh`

**Interfaces:**
- Consumes: the spike `Service.qml` from Task 0 (IPC `ping`).
- Produces: `make integration`; shell helpers `ipc <verb> [args]`, `jget <jq-expr>`, `wait_for <jq-expr> <value> [timeout-s]`, `scenario <name> <fn>`; fake state files under `$OMAREMOTE_FAKE_DIR` (documented in the fake headers) that later scenarios manipulate. **Environment contract of `Service.qml`** (Task 5 implements it): `OMAREMOTE_IPC_TARGET`, `OMAREMOTE_APPID`, `OMAREMOTE_DISPATCH=hyprctl` (route `dispatch` actions through `hyprctl dispatch …` — the fake — instead of `Hyprland.dispatch`, which would reach the live compositor), `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `PATH`.

- [ ] **Step 1: Harness**

Create `tests/harness/shell.qml`:

```qml
// Spec §9 "integration, no hardware": a second Quickshell instance hosting the real Service.qml with fake adapters on PATH.
import QtQuick
import Quickshell

ShellRoot {
  id: harness
  property var service: null
  Component.onCompleted: {
    var comp = Qt.createComponent(Qt.resolvedUrl("../../Service.qml"))
    if (comp.status === Component.Error) { console.error("harness: " + comp.errorString()); Qt.quit(); return }
    harness.service = comp.createObject(null)
    if (!harness.service) { console.error("harness: createObject failed: " + comp.errorString()); Qt.quit() }
  }
}
```

- [ ] **Step 2: Fakes**

All fakes live in `tests/fakes/bin/`, are `chmod +x`, and keep their state in `$OMAREMOTE_FAKE_DIR`. Create `tests/fakes/bin/fake-log.sh` (sourced by the action fakes):

```bash
# Spec §9: action fakes append their argv to actions.log instead of touching the desktop.
fake_log() { printf '%s\n' "$*" >> "${OMAREMOTE_FAKE_DIR:?OMAREMOTE_FAKE_DIR unset}/actions.log"; }
```

Create `tests/fakes/bin/wtype`, `wpctl`, `playerctl`, `omarchy-lock-screen` (identical bodies except the header):

```bash
#!/usr/bin/env bash
# Spec §9: fake wtype — logs argv.
source "$(dirname "$0")/fake-log.sh"; fake_log "$(basename "$0") $*"; exit 0
```

Create `tests/fakes/bin/hyprctl`:

```bash
#!/usr/bin/env bash
# Spec §9: fake hyprctl — logs argv; `binds -j` prints the bind list from $OMAREMOTE_FAKE_DIR/hypr-binds.json (default []).
source "$(dirname "$0")/fake-log.sh"; fake_log "hyprctl $*"
if [[ ${1:-} == binds ]]; then cat "$OMAREMOTE_FAKE_DIR/hypr-binds.json" 2>/dev/null || echo "[]"; fi
if [[ ${1:-} == version ]]; then echo "Hyprland 0.56.2 (fake)"; fi
exit 0
```

Create `tests/fakes/bin/pw-dump`:

```bash
#!/usr/bin/env bash
# Spec §9: fake pw-dump — prints $OMAREMOTE_FAKE_DIR/pw-dump.json (default []).
source "$(dirname "$0")/fake-log.sh"; fake_log "pw-dump $*"
cat "$OMAREMOTE_FAKE_DIR/pw-dump.json" 2>/dev/null || echo "[]"
exit 0
```

Create `tests/fakes/bin/voxtype`:

```bash
#!/usr/bin/env bash
# Spec §9: fake Voxtype CLI. State files in $OMAREMOTE_FAKE_DIR:
#   vox.state      idle|recording|transcribing (default idle)      vox.config   audio.device literal (absent = unset)
#   vox.log        every invocation                                 vox.stopped  status reports "stopped"
#   knobs: vox.start-fails (start exits 1), vox.no-confirm (start never records), vox.start-delay (seconds),
#          vox.stop-fails, vox.stop-hangs (stop never leaves recording), vox.cancel-ignored, vox.set-fails,
#          vox.hang (daemon hung: one-shot status never answers, follow stream goes silent; cleared by a fake restart)
set -u
d=${OMAREMOTE_FAKE_DIR:?}
printf '%s\n' "voxtype $*" >> "$d/vox.log"
state() { cat "$d/vox.state" 2>/dev/null || echo idle; }
setstate() { printf '%s\n' "$1" > "$d/vox.state"; }
json() { printf '{"text":"x","alt":"%s","class":"%s","tooltip":""}\n' "$1" "$1"; }
case "${1:-}" in
  --version) echo "voxtype 1.0.1" ;;
  record)
    case "${2:-}" in
      start)
        [[ -e $d/vox.start-fails ]] && exit 1
        [[ -e $d/vox.no-confirm ]] && exit 0
        ( sleep "$(cat "$d/vox.start-delay" 2>/dev/null || echo 0.05)"; setstate recording ) & ;;
      stop)
        [[ -e $d/vox.stop-fails ]] && exit 1
        [[ -e $d/vox.stop-hangs ]] && exit 0
        ( sleep 0.05; setstate transcribing; sleep 0.2; setstate idle ) & ;;
      cancel) [[ -e $d/vox.cancel-ignored ]] || setstate idle ;;
    esac ;;
  status)
    if [[ -e $d/vox.stopped ]]; then json stopped; exit 0; fi
    if [[ " $* " == *" --follow "* ]]; then
      last=""
      while :; do s=$(state); if [[ $s != "$last" && ! -e $d/vox.hang ]]; then json "$s"; last=$s; fi; sleep 0.05; done
    else
      while [[ -e $d/vox.hang ]]; do sleep 0.2; done
      json "$(state)"
    fi ;;
  config)
    case "${2:-}" in
      get)
        case "${3:-}" in
          audio.device)
            if [[ -e $d/vox.config ]]; then v=$(cat "$d/vox.config"); printf '{"file_value":"%s","key":"audio.device","value":"%s"}\n' "$v" "$v"
            else printf '{"file_value":null,"key":"audio.device","value":"default"}\n'; fi ;;
          output.mode) printf '{"file_value":"type","key":"output.mode","value":"type"}\n' ;;
        esac ;;
      set) [[ -e $d/vox.set-fails ]] && exit 1; printf '%s' "${4:-}" > "$d/vox.config" ;;
      unset) rm -f "$d/vox.config" ;;
    esac ;;
esac
exit 0
```

Create `tests/fakes/bin/busctl`:

```bash
#!/usr/bin/env bash
# Spec §9: fake busctl for ATVVoice. State files in $OMAREMOTE_FAKE_DIR:
#   atv.present  exists → org.atvvoice.fake owned by :1.99      atv.state   connected|streaming|disconnected
#   atv.signals  append a state per line to emit MicStateChanged from `monitor`      atv.log  every invocation
set -u
d=${OMAREMOTE_FAKE_DIR:?}
printf '%s\n' "busctl $*" >> "$d/atv.log"
sub=""; for a in "$@"; do case $a in --*) ;; *) sub=$a; break ;; esac; done
present() { [[ -e $d/atv.present ]]; }
case "$sub" in
  list)
    echo ":1.1 858 dbus-broker kehao :1.1 user@1000.service - -"
    present && echo "org.atvvoice.fake 4242 atvvoice kehao :1.99 user@1000.service - -" ;;
  call)
    if [[ " $* " == *" GetNameOwner "* ]]; then
      present && { echo 's ":1.99"'; exit 0; }
      echo "Call failed: The name is not activatable" >&2; exit 1
    fi
    [[ " $* " == *" MicClose "* ]] && printf 'connected\n' > "$d/atv.state"
    if [[ " $* " == *" MicToggle "* ]]; then
      if [[ $(cat "$d/atv.state" 2>/dev/null) == streaming ]]; then printf 'connected\n' > "$d/atv.state"; else printf 'streaming\n' > "$d/atv.state"; fi
    fi ;;
  get-property)
    present || { echo "Failed to get property: no such name" >&2; exit 1; }
    case "${*: -1}" in
      State) printf 's "%s"\n' "$(cat "$d/atv.state" 2>/dev/null || echo connected)" ;;
      NodeName) echo 's "atvvoice_mic"' ;;
      DeviceAddress) echo 's "AA:BB:CC:DD:EE:FF"' ;;
    esac ;;
  monitor)
    : >> "$d/atv.signals"
    tail -n 0 -F "$d/atv.signals" 2>/dev/null | while read -r s; do
      printf '%s\n' "$s" > "$d/atv.state"
      printf '{"type":"signal","sender":":1.99","destination":null,"path":"/org/atvvoice/Daemon","interface":"org.atvvoice.Daemon","member":"MicStateChanged","payload":{"signature":"s","data":["%s"]}}\n' "$s"
    done &
    tp=$!
    trap 'kill $tp 2>/dev/null; exit 0' TERM INT
    wait $tp ;;
esac
exit 0
```

Create `tests/fakes/bin/systemctl`:

```bash
#!/usr/bin/env bash
# Spec §9: fake `systemctl --user`. State files in $OMAREMOTE_FAKE_DIR:
#   sysd.job          non-empty → a job is pending           sysd.invocation   current InvocationID (default inv-0)
#   sysd.log          every invocation                        sysd.restart-count
#   knobs: sysd.restart-fails (exit 1), sysd.restart-fails-once (first restart exits 1 and removes the knob),
#          sysd.restart-hangs (leaves a job pending, no restart), vox.stopped (voxtype inactive)
set -u
d=${OMAREMOTE_FAKE_DIR:?}
printf '%s\n' "systemctl $*" >> "$d/sysd.log"
args=("$@"); [[ ${args[0]:-} == --user ]] && args=("${args[@]:1}")
unit=""; for a in "${args[@]:1}"; do case $a in --*) ;; *) unit=$a; break ;; esac; done
case "${args[0]:-}" in
  show)
    printf '%s\n' "$(cat "$d/sysd.job" 2>/dev/null)"
    if [[ $unit == voxtype && -e $d/vox.stopped ]]; then echo inactive; else echo active; fi
    printf '%s\n' "$(cat "$d/sysd.invocation" 2>/dev/null || echo inv-0)" ;;
  restart)
    [[ -e $d/sysd.restart-fails ]] && exit 1
    if [[ -e $d/sysd.restart-fails-once ]]; then rm -f "$d/sysd.restart-fails-once"; exit 1; fi
    if [[ -e $d/sysd.restart-hangs ]]; then printf '77 restart\n' > "$d/sysd.job"; exit 0; fi
    n=$(cat "$d/sysd.restart-count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$d/sysd.restart-count"
    printf 'inv-%s\n' "$n" > "$d/sysd.invocation"
    rm -f "$d/vox.stopped" "$d/vox.hang" "$d/vox.cancel-ignored"; printf 'idle\n' > "$d/vox.state" ;;   # a restart heals a hung daemon
  is-active) if [[ $unit == voxtype && -e $d/vox.stopped ]]; then echo inactive; exit 3; fi; echo active ;;
  is-enabled) echo enabled ;;
esac
exit 0
```

Run: `chmod +x tests/fakes/bin/*` (except `fake-log.sh`, which is sourced).

- [ ] **Step 3: fake-remote.sh with the first scenario**

Create `tests/fake-remote.sh`:

```bash
#!/usr/bin/env bash
# Spec §9 "integration, no hardware": deterministic IPC sequences against fake process/status/D-Bus adapters.
# Runs a second Quickshell instance (tests/harness) — never the user's omarchy-shell — with PATH prefixed by tests/fakes/bin
# and XDG dirs pointed at a temp directory, so nothing types into the desktop or touches ~/.config/omaremote.
# Usage: tests/fake-remote.sh [scenario-name]
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HARNESS=$ROOT/tests/harness
OMAREMOTE_FAKE_DIR=$(mktemp -d /tmp/omaremote-fake.XXXXXX); export OMAREMOTE_FAKE_DIR
export XDG_CONFIG_HOME=$OMAREMOTE_FAKE_DIR/config XDG_DATA_HOME=$OMAREMOTE_FAKE_DIR/data
export OMAREMOTE_IPC_TARGET=omaremote-test OMAREMOTE_APPID=omaremote-test
export OMAREMOTE_DISPATCH=hyprctl            # dispatch actions go to the fake hyprctl, never to the live compositor
export PATH=$ROOT/tests/fakes/bin:$PATH
ONLY=${1:-}
pass=0; fail=0; failed=(); HPID=""
F=$OMAREMOTE_FAKE_DIR

ipc() { qs ipc -p "$HARNESS" call -- omaremote-test "$@"; }
jget() { ipc status | jq -r "$1"; }
wait_for() {   # wait_for <jq-expr> <expected> [timeout-s]
  local expr=$1 want=$2 t=${3:-3} i=0 got=""
  while (( i < t * 20 )); do got=$(jget "$expr" 2>/dev/null || true); [[ $got == "$want" ]] && return 0; sleep 0.05; i=$((i + 1)); done
  echo "    wait_for '$expr' == '$want' timed out (last: '$got')"; return 1
}
has_line() { grep -qxF "$2" "$1" || { echo "    expected line '$2' in $(basename "$1"):"; sed 's/^/      /' "$1" 2>/dev/null; return 1; }; }
no_line() { ! grep -qxF "$2" "$1" || { echo "    unexpected line '$2' in $(basename "$1")"; return 1; }; }
reset_fakes() {
  rm -rf "${F:?}"/*; mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
  echo idle > "$F/vox.state"; echo inv-0 > "$F/sysd.invocation"; : > "$F/actions.log"
  : > "$F/atv.present"; echo connected > "$F/atv.state"; printf 'atvvoice_mic' > "$F/vox.config"
  cp "$ROOT/tests/fixtures/pw-dump.json" "$F/pw-dump.json"
}
start_harness() {
  qs -p "$HARNESS" --no-duplicate > "$F/harness.log" 2>&1 & HPID=$!
  for _ in $(seq 1 100); do [[ $(ipc ping 2>/dev/null) == ok ]] && return 0; sleep 0.1; done
  echo "    harness did not answer ping:"; sed 's/^/      /' "$F/harness.log"; return 1
}
stop_harness() { [[ -n $HPID ]] && { kill "$HPID" 2>/dev/null; wait "$HPID" 2>/dev/null; }; HPID=""; }
scenario() {   # scenario <name> <function>
  local name=$1 fn=$2
  [[ -n $ONLY && $ONLY != "$name" ]] && return 0
  reset_fakes
  if ! start_harness; then fail=$((fail + 1)); failed+=("$name (harness)"); stop_harness; return 0; fi
  if "$fn"; then pass=$((pass + 1)); echo "ok   $name"; else fail=$((fail + 1)); failed+=("$name"); echo "FAIL $name"; grep -i 'omaremote\|error\|warn' "$F/harness.log" | tail -20 | sed 's/^/      /'; fi
  stop_harness
}
trap 'stop_harness; rm -rf "$OMAREMOTE_FAKE_DIR"' EXIT

# ---- scenarios (each task appends its own below its marker) ----------------------
s_ping() { [[ $(ipc ping) == ok ]]; }
scenario ping s_ping

# ---- summary ---------------------------------------------------------------------
echo "integration: $pass passed, $fail failed"
(( fail == 0 )) || { printf '  %s\n' "${failed[@]}"; exit 1; }
exit 0
```

- [ ] **Step 4: Run**

Run: `chmod +x tests/fake-remote.sh && make integration`
Expected: `ok   ping` and `integration: 1 passed, 0 failed`. If `qs ipc` cannot find the instance, check `$F/harness.log` — the spike Service imports `Quickshell.Wayland`/`Quickshell.Hyprland`, which need the Wayland session (run from inside the desktop).

- [ ] **Step 5: Lint the harness**

Run: `make lint` → passes (the Makefile lints `tests/harness/*.qml`).

- [ ] **Step 6: Commit**

```bash
git add tests/harness tests/fakes tests/fake-remote.sh
git commit -m "test(host): quickshell harness, bash fakes for voxtype/busctl/systemctl/actions, fake-remote runner"
```

---

### Task 5: Service core — config store, key engine, GlobalShortcut, single timer, actions, IPC

**Files:**
- Create: `components/ConfigStore.qml`
- Replace: `Service.qml`
- Modify: `tests/fake-remote.sh` (append scenarios)

**Interfaces:**
- Consumes: `lib/ConfigFile.mjs`, `lib/KeyEngine.mjs` (`createKeyEngine(config) → { press, release, advance, nextDeadline, reset, reload, heldKeys }`), `lib/Actions.mjs` (`toArgv`, `describe`), `lib/Presentation.mjs` (`flashText`), `lib/Defaults.mjs` (`KEY_NAMES`).
- Produces (read by BarWidget/Panel and later tasks): `Service` properties `config`, `configProblems`, `configInvalid`, `hudText`, `flash`, `lastAction`, `errorCount`, `lastError`, `heldKeys`; functions `dispatch(effects, src)`, `applyEffect(e, src)`, `rearm()`, `deadlines()`, `advanceAll()`, `onKeyEdge(name, edge, source) → bool`, `doReset(origin)`, `showFlash(text, ms)`, `statusJson()`; signal `resetHappened()`; `ConfigStore` API `config/raw/problems/invalid/loaded`, `setVoiceMic(mode)`, `setKey(name, fields)`, `setTiming(t)`, `setVoiceField(field, value)`, `resetKeys()`, signal `changed(kind)` with kinds `load|external|keys|timing|voice|commit|reset-keys`.

- [ ] **Step 1: Append failing scenarios**

Append to `tests/fake-remote.sh` **before** the `# ---- summary` line:

```bash
# ---- Task 5: config + engine + actions ----
s_config_created() {
  wait_for '.config' true 5 || return 1
  jq -e '.version == 1 and .keys.menu.panic == true' "$XDG_CONFIG_HOME/omaremote/config.json" > /dev/null
}
s_tap_and_hold() {
  wait_for '.config' true 5 || return 1
  ipc key ok down > /dev/null; sleep 0.45; ipc key ok up > /dev/null; sleep 0.15
  has_line "$F/actions.log" "wtype -M ctrl -k c -m ctrl" || return 1
  [[ $(jget '.lastAction') == "ok:hold:Ctrl+C" ]] || { echo "    lastAction=$(jget '.lastAction')"; return 1; }
  [[ $(jget '.flash') == "OK · hold → Ctrl+C" ]] || return 1
  ipc key ok down > /dev/null; ipc key ok up > /dev/null; sleep 0.15
  has_line "$F/actions.log" "wtype -k Return"
}
s_simple_key_fires_on_press() {
  wait_for '.config' true 5 || return 1
  ipc key home down > /dev/null; sleep 0.15
  [[ $(jget '.lastAction') == "home:tap:exec omarchy-menu" ]] || return 1
  has_line "$F/actions.log" "hyprctl dispatch exec omarchy-menu"      # OMAREMOTE_DISPATCH=hyprctl in the harness; live shell uses Hyprland.dispatch
}
s_repeat() {
  wait_for '.config' true 5 || return 1
  ipc key up down > /dev/null; sleep 0.65; ipc key up up > /dev/null; sleep 0.1
  (( $(grep -cxF "wtype -k Up" "$F/actions.log") >= 3 ))
}
s_panic_reset() {
  wait_for '.config' true 5 || return 1
  ipc key menu down > /dev/null; sleep 1.6
  [[ $(jget '.flash') == Reset ]] || { echo "    flash=$(jget '.flash')"; return 1; }
  [[ $(jget '.heldKeys | length') == 0 ]] || return 1
  ipc key menu up > /dev/null; sleep 0.1
  no_line "$F/actions.log" "wtype -k Tab"
}
s_ipc_reset_clears_held_keys() {
  wait_for '.config' true 5 || return 1
  ipc key ok down > /dev/null; sleep 0.05
  [[ $(jget '.heldKeys | join(",")') == ok ]] || return 1
  [[ $(ipc reset) == ok ]] && wait_for '.heldKeys | length' 0
}
s_config_external_reload() {
  wait_for '.config' true 5 || return 1
  local f=$XDG_CONFIG_HOME/omaremote/config.json
  jq '.timing.holdMs = 900 | .keep_me = {"x": 1}' "$f" > "$F/c.json" && cat "$F/c.json" > "$f"     # in-place: keep the watched inode
  wait_for '.timing.holdMs' 900 5 || return 1
  ipc key ok down > /dev/null; sleep 0.5; ipc key ok up > /dev/null; sleep 0.15
  has_line "$F/actions.log" "wtype -k Return"                                                        # 500 ms < new holdMs: tap, not hold
}
s_corrupt_config_never_overwritten() {
  wait_for '.config' true 5 || return 1
  local f=$XDG_CONFIG_HOME/omaremote/config.json
  printf '{ broken' > "$f"
  wait_for '.configInvalid' true 5 || return 1
  ipc key ok down > /dev/null; ipc key ok up > /dev/null; sleep 0.15
  has_line "$F/actions.log" "wtype -k Return" || return 1          # defaults keep working
  [[ $(cat "$f") == '{ broken' ]]
}
scenario config_created s_config_created
scenario tap_and_hold s_tap_and_hold
scenario simple_key_fires_on_press s_simple_key_fires_on_press
scenario repeat s_repeat
scenario panic_reset s_panic_reset
scenario ipc_reset_clears_held_keys s_ipc_reset_clears_held_keys
scenario config_external_reload s_config_external_reload
scenario corrupt_config_never_overwritten s_corrupt_config_never_overwritten
```

- [ ] **Step 2: Run to verify they fail**

Run: `make integration`
Expected: `ping` ok, every new scenario FAIL (`status` is not a function on the spike).

- [ ] **Step 3: ConfigStore**

Create `components/ConfigStore.qml`:

```qml
// Spec §3 plugin-side files (config.json created with defaults on first run), §4.2 (unknown fields preserved),
// §6.2 (hot reload; the internal voice.mic commit reloads nothing), §8 (corrupt config → defaults, never overwritten).
import QtQuick
import Quickshell.Io
import "../lib/ConfigFile.mjs" as ConfigFile

Item {
  id: root
  required property string path
  property bool ready: false                   // parent directory exists (Service runs mkdir -p first)
  property var raw: null                       // file object as loaded, unknown fields intact
  property var config: null                    // normalized (lib/Config.mjs)
  property var problems: []
  property bool invalid: false
  property bool loaded: false
  signal changed(string kind)                  // load | external | keys | timing | voice | commit | reset-keys
  signal saveFailed(string reason)
  property string _lastWritten: ""

  FileView {
    id: file
    path: root.ready ? root.path : ""
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root._ingest(file.text(), false)
    onLoadFailed: function(error) { root._ingest("", error === FileViewError.FileNotFound) }
    onFileChanged: file.reload()
    onSaveFailed: function(error) { root.saveFailed(String(error)) }
  }

  function _ingest(text, createIfMissing) {
    if (root.loaded && text === root._lastWritten) return          // our own write echoed by the watcher
    var r = ConfigFile.load(text)
    root.raw = r.raw; root.config = r.config; root.problems = r.problems; root.invalid = r.invalid
    var first = !root.loaded
    root.loaded = true
    if (r.missing && createIfMissing) root._write(r.raw)
    root.changed(first ? "load" : "external")
  }

  function _write(raw) {
    if (root.invalid) { root.saveFailed("config.json is invalid; not overwriting it (§8)"); return false }
    var text = ConfigFile.serialize(raw)
    var r = ConfigFile.load(text)
    root._lastWritten = text
    root.raw = r.raw; root.config = r.config; root.problems = r.problems
    file.setText(text)
    return true
  }

  function setVoiceMic(mode) { if (root._write(ConfigFile.withPatch(root.raw, ["voice", "mic"], mode))) root.changed("commit") }
  function setKey(name, fields) { if (root._write(ConfigFile.withKey(root.raw, name, fields))) root.changed("keys") }
  function setTiming(timing) { if (root._write(ConfigFile.withPatch(root.raw, ["timing"], timing))) root.changed("timing") }
  function setVoiceField(field, value) { if (root._write(ConfigFile.withPatch(root.raw, ["voice", field], value))) root.changed("voice") }
  function resetKeys() { if (root._write(ConfigFile.withDefaultKeys(root.raw))) root.changed("reset-keys") }
}
```

- [ ] **Step 4: Service.qml (core)**

Replace `Service.qml` with:

```qml
// Spec §2 (Service hosts the engine; BarWidget/Panel only read state), §4.1/§4.3 (GlobalShortcut → KeyEngine, hard-coded reset),
// §4.4 (actions), §3 plugin-side files, §6.3 (flashes), §8 (never throw into the shell). Voice/mic/self-test sections follow in Tasks 6–8.
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "lib/Defaults.mjs" as Defaults
import "lib/KeyEngine.mjs" as KeyEngine
import "lib/Actions.mjs" as Actions
import "lib/Presentation.mjs" as Presentation
import "components"

Item {
  id: root
  property var shell: null                        // scoped shell facade injected by omarchy-shell; unused, kept for the contract

  // ---- environment (overrides exist for the test harness only) --------------
  readonly property string ipcTarget: Quickshell.env("OMAREMOTE_IPC_TARGET") || "omaremote"
  readonly property string shortcutAppid: Quickshell.env("OMAREMOTE_APPID") || "omaremote"
  readonly property string configHome: Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config")
  readonly property string dataHome: Quickshell.env("XDG_DATA_HOME") || (Quickshell.env("HOME") + "/.local/share")
  readonly property string pluginDir: Qt.resolvedUrl(".").toString().replace(/^file:\/\//, "").replace(/\/$/, "")
  readonly property bool dispatchViaHyprctl: Quickshell.env("OMAREMOTE_DISPATCH") === "hyprctl"   // harness only

  // ---- host constants --------------------------------------------------------
  readonly property int flashMs: 600
  readonly property int resetFlashMs: 1000
  readonly property int shortCmdMs: 2000
  readonly property int restartCmdMs: 10000

  // ---- state read by BarWidget/Panel (never written by them) -----------------
  readonly property var config: configStore.config
  readonly property var configProblems: configStore.problems
  readonly property bool configInvalid: configStore.invalid
  property string hudText: ""
  property string flash: ""
  property string lastAction: ""
  property int errorCount: 0
  property string lastError: ""
  property var heldKeys: []
  signal resetHappened()                          // §4.3: BarWidget closes the Panel

  // ---- modules ---------------------------------------------------------------
  property var engine: null

  // ---- effect router (the only consumer of module effects) -------------------
  function dispatch(effects, src) {
    if (!effects) return
    for (var i = 0; i < effects.length; i++) {
      var e = effects[i]
      try { root.applyEffect(e, src) } catch (err) { console.log("omaremote: effect " + e.type + " from " + src + " threw: " + err) }
    }
  }
  function applyEffect(e, src) {
    switch (e.type) {
      case "action": root.runAction(e); break
      case "reset": root.onEngineReset(); break
      case "hud": root.hudText = e.text; break
      case "error": root.errorCount++; root.lastError = e.reason; console.log("omaremote: " + src + " error " + e.reason); break
      // ---- voice effects (Task 6) ----
      // ---- mic/stat effects (Task 7) ----
      // ---- self-test effects (Task 8) ----
      default: console.log("omaremote: unhandled effect " + e.type + " from " + src)
    }
  }

  // ---- one Timer for every module (host obligations) -------------------------
  Timer { id: tick; repeat: false; onTriggered: root.advanceAll() }
  function deadlines() {
    return [engine ? engine.nextDeadline() : null]
    // ---- more deadlines (Tasks 6–8) ----
  }
  function rearm() {
    var ds = root.deadlines(), d = null
    for (var i = 0; i < ds.length; i++) if (ds[i] !== null && ds[i] !== undefined && (d === null || ds[i] < d)) d = ds[i]
    if (d === null) { tick.stop(); return }
    tick.interval = Math.max(1, d - Date.now())
    tick.restart()
  }
  function advanceAll() {
    var now = Date.now()
    if (engine) root.dispatch(engine.advance(now), "engine")
    // ---- more advances (Tasks 6–8) ----
    root.rearm()
  }

  // ---- config ----------------------------------------------------------------
  Process {
    id: mkdirs
    command: ["mkdir", "-p", root.configHome + "/omaremote", root.dataHome + "/omaremote"]
    running: true
    onExited: function(code, status) { configStore.ready = true }
  }
  ConfigStore {
    id: configStore
    path: root.configHome + "/omaremote/config.json"
    onChanged: function(kind) { root.onConfigChanged(kind) }
    onSaveFailed: function(reason) { root.errorCount++; root.lastError = "config-write: " + reason }
  }
  function onConfigChanged(kind) {
    var now = Date.now()
    if (kind === "load") { root.startModules(now); root.rearm(); return }
    if (kind === "commit") return                                  // §6.2: the internal voice.mic write reloads nothing
    if (kind !== "voice") { root.dispatch(engine.reload(configStore.config), "engine"); root.heldKeys = engine.heldKeys() }   // §4.3 reset without emitting
    // ---- config change → voice (Task 6) ----
    root.rearm()
  }
  function startModules(now) {
    engine = KeyEngine.createKeyEngine(configStore.config)
    // ---- module start (Tasks 6–8) ----
  }

  // ---- key input (§4.1): GlobalShortcut per logical key ---------------------
  Instantiator {
    model: Defaults.KEY_NAMES
    delegate: GlobalShortcut {
      required property string modelData
      appid: root.shortcutAppid
      name: modelData
      onPressed: root.onKeyEdge(modelData, "down", "shortcut")
      onReleased: root.onKeyEdge(modelData, "up", "shortcut")
    }
  }
  function onKeyEdge(name, edge, source) {
    if (!engine || Defaults.KEY_NAMES.indexOf(name) < 0 || (edge !== "down" && edge !== "up")) return false
    var now = Date.now()
    // ---- self-test recorder (Task 8) ----
    // ---- HID mic key → VoiceSession (Task 6) ----
    root.dispatch(edge === "down" ? engine.press(name, now) : engine.release(name, now), "engine")
    root.heldKeys = engine.heldKeys()
    root.rearm()
    return true
  }

  // ---- actions (§4.4) ----------------------------------------------------------
  function runAction(e) {
    var r = Actions.toArgv(e.action)
    if (r.kind === "dispatch") {
      if (root.dispatchViaHyprctl) Quickshell.execDetached(["hyprctl", "dispatch"].concat(r.cmd.split(" ")))
      else Hyprland.dispatch(r.cmd)
    } else if (r.kind === "process") Quickshell.execDetached(r.argv)
    root.lastAction = e.key + ":" + e.trigger + (e.repeat ? ":repeat" : "") + ":" + Actions.describe(e.action)
    if (e.trigger !== "tap" && root.config && root.config.voice.actionFlash)
      root.showFlash(Presentation.flashText(e.key, e.trigger, e.action), root.flashMs)      // §6.3 600 ms flash
  }
  Timer { id: flashTimer; repeat: false; onTriggered: root.flash = "" }
  function showFlash(text, ms) { root.flash = text; flashTimer.interval = ms; flashTimer.restart() }

  // ---- reset (§4.3 hard-coded escape hatch) ------------------------------------
  function onEngineReset() {                        // the engine already cleared its keys before emitting {type:"reset"}
    root.heldKeys = []
    root.showFlash("Reset", root.resetFlashMs)     // §6.3 1 s
    // ---- reset → voice abort (Task 6) ----
    root.resetHappened()
  }
  function doReset(origin) {
    if (engine) root.dispatch(engine.reset(), "engine")   // emits {type:"reset"} → onEngineReset
    root.rearm()
  }

  // ---- IPC (§2 hardware-free testability) ---------------------------------------
  function statusJson() {
    return JSON.stringify({
      config: !!engine, configInvalid: root.configInvalid, configProblems: root.configProblems,
      timing: root.config ? root.config.timing : null,
      heldKeys: root.heldKeys, lastAction: root.lastAction, hud: root.hudText, flash: root.flash,
      errorCount: root.errorCount, lastError: root.lastError
      // ---- more status (Tasks 6–8) ----
    })
  }
  IpcHandler {
    target: root.ipcTarget
    function ping(): string { return "ok" }
    function key(name: string, edge: string): string { return root.onKeyEdge(name, edge, "ipc") ? "ok" : "unknown-key" }
    function reset(): string { root.doReset("ipc"); return "ok" }
    function status(): string { return root.statusJson() }
    // ---- more verbs (Tasks 6–8) ----
  }
}
```

- [ ] **Step 5: Run the scenarios**

Run: `make integration`
Expected: all 9 scenarios `ok`. Common failures and what they mean: `config_created` fails → `FileView` never fired `loadFailed` for a missing file; check `$F/harness.log` and, if the signal is `loaded` with empty text, change `onLoaded` to `root._ingest(file.text(), true)`. `repeat` < 3 lines → `rearm()` not called after `press`, or `Timer.interval` computed before `Date.now()` advanced. `corrupt_config_never_overwritten` fails on the last line → `_write` ran while `invalid`.

- [ ] **Step 6: Lint**

Run: `make lint` → clean.

- [ ] **Step 7: Commit**

```bash
git add Service.qml components/ConfigStore.qml tests/fake-remote.sh
git commit -m "feat(host): Service core — config store, key engine host, GlobalShortcut input, single timer, action dispatch, IPC"
```

---

### Task 6: Voice adapters — command runner, Voxtype monitor, ATVVoice monitor, HUD, VoiceSession wiring

**Files:**
- Create: `components/CommandRunner.qml`, `components/VoxtypeMonitor.qml`, `components/AtvvoiceMonitor.qml`, `components/Hud.qml`
- Modify: `Service.qml` (fill the marked `Task 6` anchors), `tests/fake-remote.sh` (append scenarios)

**Interfaces:**
- Consumes: `lib/VoiceSession.mjs` (`createVoiceSession(config) → { hidPress, hidRelease, dbus, atvRead, status, cmdExit, restartResult, abort, advance, nextDeadline, setDbusEnabled, setDbusSource, setConfig, gate, snapshot, micOpened, micClosed }`), `lib/VoxStatus.mjs` (`parseStatusLine`), `lib/Dbus.mjs` (`createSignalParser`, `parseProperty`, `atvvoiceNames`), `lib/Systemd.mjs` (`backoffMs`), `lib/MicApply.mjs` (`parseConfigGet`), `lib/Presentation.mjs` (`hudLine`).
- Produces: `CommandRunner { run(src, id, argv, deadlineMs); cancelAll(src); pending(src) → int; signal finished(src, id, code, stdout, timedOut) }`; `VoxtypeMonitor { start(); restart(); poll(); generation; signal status(cls, fresh, raw) }`; `AtvvoiceMonitor { start(); readState(requestId); micClose(); micToggle(); busName; sender; generation; path; iface; signals source(sender, generation, busName), signalEvent(ev), stateRead(requestId, state, generation), nodeName(name) }`; `Hud { line, recording, enabled }`; Service properties `voice`, `voiceState`, `voiceOwner`, `voiceInferred`, `backendClass`, `remoteState`, `remoteNode`, `atvBusName`, `remoteWarning`, `voxAudioDevice`, `recordingSince`, `elapsedMs`, `hudLine`; functions `updateRemoteWarning()`, `refreshAudioDevice()`, `ipcVoice(verb, arg)`; IPC verb `voice <state|poll> <arg>`; status JSON fields `voice{state,owner,inferred,pendingCmds,gates}`, `backend`, `remote{state,node,bus,sender,warning}`, `audioDevice`.

- [ ] **Step 1: Append failing scenarios**

Append to `tests/fake-remote.sh` before `# ---- summary`:

```bash
# ---- Task 6: voice session through real adapters + fakes ----
ready() { wait_for '.config' true 5 && wait_for '.backend' idle 5 && wait_for '.remote.sender' ":1.99" 5; }
s_hid_session() {
  ready || return 1
  ipc key mic down > /dev/null
  wait_for '.voice.state' recording 3 || return 1
  [[ $(jget '.voice.owner') == hid ]] || return 1
  [[ $(jget '.hud') == "● 00:00" || $(jget '.hud') == "● 00:01" ]] || { echo "    hud=$(jget '.hud')"; return 1; }
  has_line "$F/vox.log" "voxtype record start" || return 1
  ipc key mic up > /dev/null
  wait_for '.voice.state' idle 5 || return 1
  has_line "$F/vox.log" "voxtype record stop" || return 1
  no_line "$F/vox.log" "voxtype record cancel"
}
s_hid_release_while_starting() {          # §9: no stop before confirmed recording; exactly one stop on confirmation
  ready || return 1
  echo 0.4 > "$F/vox.start-delay"
  ipc key mic down > /dev/null; sleep 0.1; ipc key mic up > /dev/null; sleep 0.1
  no_line "$F/vox.log" "voxtype record stop" || return 1
  wait_for '.voice.state' idle 5 || return 1
  (( $(grep -cxF "voxtype record stop" "$F/vox.log") == 1 ))
}
s_start_never_confirms() {                # §9: 1500 ms without recording → cancel + recovering; settles without a daemon restart
  ready || return 1
  : > "$F/vox.no-confirm"
  ipc key mic down > /dev/null
  wait_for '.voice.state' recovering 3 || return 1
  has_line "$F/vox.log" "voxtype record cancel" || return 1
  ipc key mic up > /dev/null
  wait_for '.voice.state' idle 6 || return 1
  no_line "$F/sysd.log" "systemctl --user restart voxtype"
}
s_dbus_arbitration_short_tap() {          # §9: release before 250 ms → no plugin start
  ready || return 1
  echo streaming >> "$F/atv.signals"
  wait_for '.voice.state' arbitrating 2 || return 1
  echo connected >> "$F/atv.signals"
  wait_for '.voice.state' idle 2 || return 1
  no_line "$F/vox.log" "voxtype record start"
}
s_dbus_session() {                        # button held: fresh re-reads at 250 ms allow the start; release → re-read → stop
  ready || return 1
  echo streaming >> "$F/atv.signals"
  wait_for '.voice.state' recording 3 || return 1
  [[ $(jget '.voice.owner') == dbus ]] || return 1
  [[ $(jget '.voice.inferred') == true ]] || return 1
  echo connected >> "$F/atv.signals"
  wait_for '.voice.state' idle 5 || return 1
  has_line "$F/vox.log" "voxtype record stop"
}
s_voice_state_verb() {                    # §2: `voice state <state>` injects a D-Bus state for deterministic tests
  ready || return 1
  ipc voice state streaming > /dev/null
  wait_for '.voice.state' arbitrating 2 || return 1
  ipc voice state connected > /dev/null
  wait_for '.voice.state' idle 2
}
s_keyboard_session_observed() {           # F9 elsewhere: recording not requested by us → owner keyboard, no plugin commands
  ready || return 1
  echo recording > "$F/vox.state"
  wait_for '.voice.state' recording 3 || return 1
  [[ $(jget '.voice.owner') == keyboard ]] || return 1
  echo transcribing > "$F/vox.state"
  wait_for '.voice.state' transcribing 3 || return 1
  [[ $(jget '.hud') == "… transcribing" ]] || return 1
  echo idle > "$F/vox.state"
  wait_for '.voice.state' idle 3 || return 1
  ! grep -q "voxtype record" "$F/vox.log"
}
s_panic_during_recording() {              # §9: reset cancels (never stops) and recovers
  ready || return 1
  ipc key mic down > /dev/null
  wait_for '.voice.state' recording 3 || return 1
  ipc reset > /dev/null
  wait_for '.voice.state' recovering 2 || return 1
  has_line "$F/vox.log" "voxtype record cancel" || return 1
  no_line "$F/vox.log" "voxtype record stop" || return 1
  [[ $(jget '.flash') == Reset ]] || return 1
  ipc key mic up > /dev/null
  wait_for '.voice.state' idle 6
}
s_config_reload_aborts_session() {        # §5.2: abort on config reload; keys still hot-reload
  ready || return 1
  ipc key mic down > /dev/null
  wait_for '.voice.state' recording 3 || return 1
  local f=$XDG_CONFIG_HOME/omaremote/config.json
  jq '.timing.holdMs = 700' "$f" > "$F/c.json" && cat "$F/c.json" > "$f"
  wait_for '.voice.state' recovering 5 || return 1
  has_line "$F/vox.log" "voxtype record cancel" || return 1
  ipc key mic up > /dev/null
  wait_for '.timing.holdMs' 700 2
}
s_voxtype_absent_is_unconfigured() {      # §5.4: stopped → unconfigured, starts refused; healthy again → idle
  ready || return 1
  : > "$F/vox.stopped"
  ipc voice poll - > /dev/null
  wait_for '.voice.state' unconfigured 3 || return 1
  ipc key mic down > /dev/null; sleep 0.1; ipc key mic up > /dev/null
  no_line "$F/vox.log" "voxtype record start" || return 1
  rm "$F/vox.stopped"; ipc voice poll - > /dev/null
  wait_for '.voice.state' idle 3
}
s_remote_warning_disables_dbus_path() {   # §5.4: audio.device ≠ NodeName in remote mode → warning, D-Bus start path off, HID still works
  ready || return 1
  printf 'default' > "$F/vox.config"
  ipc voice audioDevice - > /dev/null
  wait_for '.remote.warning' true 3 || return 1
  echo streaming >> "$F/atv.signals"; sleep 0.4
  [[ $(jget '.voice.state') == idle ]] || return 1
  echo connected >> "$F/atv.signals"
  ipc key mic down > /dev/null
  wait_for '.voice.state' recording 3 || return 1
  ipc key mic up > /dev/null
  wait_for '.voice.state' idle 5
}
scenario hid_session s_hid_session
scenario hid_release_while_starting s_hid_release_while_starting
scenario start_never_confirms s_start_never_confirms
scenario dbus_arbitration_short_tap s_dbus_arbitration_short_tap
scenario dbus_session s_dbus_session
scenario voice_state_verb s_voice_state_verb
scenario keyboard_session_observed s_keyboard_session_observed
scenario panic_during_recording s_panic_during_recording
scenario config_reload_aborts_session s_config_reload_aborts_session
scenario voxtype_absent_is_unconfigured s_voxtype_absent_is_unconfigured
scenario remote_warning_disables_dbus_path s_remote_warning_disables_dbus_path
```

- [ ] **Step 2: Run to verify they fail**

Run: `make integration` → the 11 new scenarios FAIL (`.backend` never becomes `idle`; `voice` is not a function).

- [ ] **Step 3: CommandRunner**

Create `components/CommandRunner.qml`:

```qml
// Spec §5.3 (plugin command processes are tagged, bounded, reaped before a replacement daemon starts), §3 (2 s reads, 10 s restart).
import QtQuick
import Quickshell.Io

Item {
  id: root
  signal finished(string src, int id, int code, string stdout, bool timedOut)
  property var _live: ({})                        // "src:id" → job Item

  function run(src, id, argv, deadlineMs) {
    var job = jobComponent.createObject(root, { src: src, opId: id, argv: argv, deadlineMs: deadlineMs })
    if (!job) { console.log("omaremote: could not start " + argv.join(" ")); root.finished(src, id, 127, "", false); return }
    var next = ({}); for (var k in root._live) next[k] = root._live[k]
    next[src + ":" + id] = job
    root._live = next
  }
  function cancelAll(src) {                       // §5.3: terminate + reap outstanding plugin commands of one module
    var keep = ({})
    for (var k in root._live) {
      if (k.indexOf(src + ":") === 0) root._live[k].kill(); else keep[k] = root._live[k]
    }
    root._live = keep
  }
  function pending(src) { var n = 0; for (var k in root._live) if (k.indexOf(src + ":") === 0) n++; return n }
  function _finish(job) {
    var next = ({}); for (var k in root._live) if (root._live[k] !== job) next[k] = root._live[k]
    root._live = next
    root.finished(job.src, job.opId, job.code, job.outText, job.timedOut)
    job.destroy(0)
  }

  Component {
    id: jobComponent
    Item {
      id: job
      property string src
      property int opId
      property var argv
      property int deadlineMs
      property bool timedOut: false
      property bool exitedSeen: false
      property bool streamDone: false
      property bool killed: false
      property int code: -1
      property string outText: ""
      function maybeDone() { if (exitedSeen && streamDone) root._finish(job) }
      function kill() { killed = true; if (proc.running) proc.signal(9) }
      Process {
        id: proc
        command: job.argv
        stdout: StdioCollector {
          waitForEnd: true
          onStreamFinished: { job.outText = text; job.streamDone = true; job.maybeDone() }
        }
        onExited: function(exitCode, exitStatus) {
          job.code = job.timedOut ? 124 : (job.killed ? 137 : exitCode)
          job.exitedSeen = true
          job.maybeDone()
        }
      }
      Timer {
        interval: job.deadlineMs
        running: true
        repeat: false
        onTriggered: { if (proc.running) { job.timedOut = true; proc.signal(15) } }
      }
      Component.onCompleted: proc.running = true
    }
  }
}
```

- [ ] **Step 4: VoxtypeMonitor**

Create `components/VoxtypeMonitor.qml`:

```qml
// Spec §3 Voxtype (change-driven `status --follow`; explicit polls give freshness; no answer → `stopped`), §5.4 (backoff 1 s → 30 s).
import QtQuick
import Quickshell.Io
import "../lib/VoxStatus.mjs" as VoxStatus
import "../lib/Systemd.mjs" as Systemd

Item {
  id: root
  signal status(string cls, bool fresh, var raw)   // fresh=true only for one-shot poll answers (host obligations)
  property int generation: 0                       // bumped on every follow (re)start
  property int attempts: 0
  property bool _restartNow: false
  property bool _pollAgain: false
  property bool _pollKilled: false

  function start() { root.generation++; follow.running = true }
  function restart() {                             // after a Voxtype restart: drop the old monitor and its buffered lines
    root.generation++
    if (follow.running) { root._restartNow = true; follow.signal(15) } else follow.running = true
  }
  function poll() { if (pollProc.running) { root._pollAgain = true; return } pollProc.running = true }

  Process {
    id: follow
    command: ["voxtype", "status", "--follow", "--format", "json"]
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        var r = VoxStatus.parseStatusLine(line)
        if (!r) return
        root.attempts = 0
        root.status(r.cls, false, r.raw)
      }
    }
    onExited: function(code, st) {
      if (root._restartNow) { root._restartNow = false; root.generation++; follow.running = true; return }
      backoff.interval = Systemd.backoffMs(root.attempts++)
      backoff.restart()
    }
  }
  Timer { id: backoff; repeat: false; onTriggered: { root.generation++; follow.running = true } }

  Process {
    id: pollProc
    command: ["voxtype", "status", "--format", "json"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (root._pollKilled) { root._pollKilled = false; console.log("omaremote: voxtype status poll timed out"); return }   // hung daemon: no answer, let recovery time out into its bounded restart (§5.3)
        var first = String(text || "").trim().split("\n")[0]
        var r = VoxStatus.parseStatusLine(first)
        root.status(r ? r.cls : "stopped", true, r ? r.raw : null)                 // a prompt "no daemon" answer is `stopped` (§3)
      }
    }
    onRunningChanged: if (running) pollGuard.restart(); else pollGuard.stop()
    onExited: function(code, st) { if (root._pollAgain) { root._pollAgain = false; pollProc.running = true } }
  }
  Timer { id: pollGuard; interval: 2000; repeat: false; onTriggered: if (pollProc.running) { root._pollKilled = true; pollProc.signal(9) } }
}
```

- [ ] **Step 5: AtvvoiceMonitor**

Create `components/AtvvoiceMonitor.qml`:

```qml
// Spec §3 ATVVoice (bus name discovered by prefix; State/NodeName; MicClose/MicToggle), §5.1 (only the selected sender,
// exact path and interface; a generation per monitor (re)connect; State and NodeName read on start and reconnect), §5.4 (backoff).
import QtQuick
import Quickshell
import Quickshell.Io
import "../lib/Dbus.mjs" as Dbus
import "../lib/Systemd.mjs" as Systemd

Item {
  id: root
  readonly property string path: "/org/atvvoice/Daemon"
  readonly property string iface: "org.atvvoice.Daemon"
  property string busName: ""
  property string sender: ""                     // unique name (":1.42"); "" while absent
  property int generation: 0
  property int attempts: 0
  property var _reads: []                        // requestIds waiting for a State read
  property var parser: Dbus.createSignalParser({
    path: root.path, iface: root.iface, member: "MicStateChanged",
    acceptSender: function(s) { return root.sender !== "" && s === root.sender }
  })
  signal source(string sender, int generation, string busName)
  signal signalEvent(var ev)
  signal stateRead(string requestId, string state, int generation)   // state "" on failure
  signal nodeName(string name)

  function start() { if (!discover.running) discover.running = true }
  function readState(requestId) {
    if (!root.busName) { root.stateRead(requestId, "", root.generation); return }
    root._reads.push(requestId)
    if (!stateProc.running) stateProc.running = true
  }
  function micClose() { if (root.busName) Quickshell.execDetached(["busctl", "--user", "call", root.busName, root.path, root.iface, "MicClose"]) }
  function micToggle() { if (root.busName) Quickshell.execDetached(["busctl", "--user", "call", root.busName, root.path, root.iface, "MicToggle"]) }

  function _lost() {                             // monitor gone or owner unresolvable: fail closed, then rediscover with backoff
    root.sender = ""
    root.generation = root.parser.bumpGeneration()
    root.source("", root.generation, root.busName)
    backoff.interval = Systemd.backoffMs(root.attempts++)
    backoff.restart()
  }
  Timer { id: backoff; repeat: false; onTriggered: root.start() }

  Process {                                      // 1. names with the org.atvvoice. prefix
    id: discover
    command: ["busctl", "--user", "list", "--no-legend"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var names = Dbus.atvvoiceNames(text)
      if (names.length === 0) { root.busName = ""; root._lost(); return }
      root.busName = names[0]
      owner.running = true
    } }
  }
  Process {                                      // 2. unique name of the owner → the only accepted sender
    id: owner
    command: ["busctl", "--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", "s", root.busName]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var s = Dbus.parseProperty(text)
      if (!s) { root._lost(); return }
      root.sender = s
      root.generation = root.parser.bumpGeneration()
      root.source(root.sender, root.generation, root.busName)     // host obligation: setDbusSource before any signal
      monitor.running = true
      nodeProc.running = true
      initState.running = true
    } }
  }
  Process {                                      // 3. signal monitor
    id: monitor
    command: ["busctl", "--user", "--json=short", "monitor", "--match", "type='signal',interface='org.atvvoice.Daemon',member='MicStateChanged'"]
    stdout: SplitParser { splitMarker: "\n"; onRead: function(line) {
      var evs = root.parser.feed(line + "\n")
      for (var i = 0; i < evs.length; i++) { root.attempts = 0; root.signalEvent(evs[i]) }
    } }
    onExited: function(code, st) { root._lost() }
  }
  Process {                                      // 4. NodeName on (re)connect
    id: nodeProc
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "NodeName"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: { var n = Dbus.parseProperty(text); if (n) root.nodeName(n) } }
  }
  Process {                                      // 5. State on (re)connect, delivered like a signal
    id: initState
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "State"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var s = Dbus.parseProperty(text)
      if (s) root.signalEvent({ state: s, sender: root.sender, path: root.path, interface: root.iface, member: "MicStateChanged", generation: root.generation })
    } }
  }
  Process {                                      // 6. explicit re-reads (readAtv effects); answers every queued request
    id: stateProc
    command: ["busctl", "--user", "get-property", root.busName, root.path, root.iface, "State"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var s = Dbus.parseProperty(text) || ""
      var ids = root._reads; root._reads = []
      for (var i = 0; i < ids.length; i++) root.stateRead(ids[i], s, root.generation)
    } }
    onExited: function(code, st) { if (root._reads.length > 0) stateProc.running = true }
  }
}
```

- [ ] **Step 6: Hud**

Create `components/Hud.qml`:

```qml
// Spec §6.3: PanelWindow owned by the Service — layer overlay, top-centre, no exclusive zone, no keyboard focus, click-through.
import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons

PanelWindow {
  id: root
  property string line: ""
  property bool recording: false
  property bool enabled: true

  anchors.top: true
  margins.top: Style.gapsOut
  exclusiveZone: 0
  color: "transparent"
  visible: root.enabled && root.line !== ""
  implicitWidth: card.implicitWidth
  implicitHeight: card.implicitHeight
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
  WlrLayershell.namespace: "omaremote-hud"
  mask: Region {}

  Rectangle {
    id: card
    implicitWidth: label.implicitWidth + Style.space(28)
    implicitHeight: label.implicitHeight + Style.space(14)
    radius: Style.cornerRadius
    color: Color.popups.background
    border.color: Color.popups.border
    border.width: 1
    Text {
      id: label
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: root.line
      color: root.recording ? Color.urgent : Color.popups.text
      font.family: Style.font.family
      font.pixelSize: Style.font.body
    }
    SequentialAnimation on opacity {          // slow pulse while recording (§6.1)
      running: root.recording
      loops: Animation.Infinite
      NumberAnimation { to: 0.55; duration: 900 }
      NumberAnimation { to: 1.0; duration: 900 }
    }
  }
}
```

- [ ] **Step 7: Service.qml — voice wiring**

Edit `Service.qml` at the marked anchors:

Add imports after `import "lib/Presentation.mjs" as Presentation`:
```qml
import "lib/VoiceSession.mjs" as VoiceSession
import "lib/MicApply.mjs" as MicApply
```

Replace the `// ---- modules ----` block's `property var engine: null` with:
```qml
  property var engine: null
  property var voice: null
  property string voiceState: "idle"
  property string voiceOwner: ""
  property bool voiceInferred: false
  property string backendClass: "unknown"
  property string remoteState: "unknown"          // last ATVVoice State; "absent" when no org.atvvoice.* on the bus
  property string remoteNode: ""
  property string atvBusName: ""
  property bool remoteWarning: false
  property string voxAudioDevice: ""
  property double recordingSince: 0
  property int elapsedMs: 0
  readonly property string hudLine: Presentation.hudLine({ voiceState: root.voiceState, hudText: root.hudText, elapsedMs: root.elapsedMs, flash: root.flash })
  Timer { interval: 250; repeat: true; running: root.voiceState === "recording"; onTriggered: root.elapsedMs = Date.now() - root.recordingSince }
```

Replace `// ---- voice effects (Task 6) ----` with:
```qml
      case "cmd": runner.run(src, e.id, e.argv, e.kind === "restart" ? root.restartCmdMs : root.shortCmdMs); break
      case "state": root.onVoiceState(e); break
      case "poll": vox.poll(); break
      case "readAtv": atv.readState(e.requestId); break
      case "micClose": atv.micClose(); voice.micClosed(); break
```

Replace `// ---- more deadlines (Tasks 6–8) ----` line so the function reads:
```qml
  function deadlines() {
    return [engine ? engine.nextDeadline() : null, voice ? voice.nextDeadline() : null]
    // ---- more deadlines (Tasks 7–8) ----
  }
```

Replace `// ---- more advances (Tasks 6–8) ----` with:
```qml
    if (voice) root.dispatch(voice.advance(now), "voice")
    // ---- more advances (Tasks 7–8) ----
```

Replace `// ---- config change → voice (Task 6) ----` with:
```qml
    if (voice) {
      if (kind === "external") root.dispatch(voice.abort(now), "voice")     // §5.2: config reload aborts
      voice.setConfig(configStore.config)
      root.updateRemoteWarning()
    }
```

Replace `// ---- module start (Tasks 6–8) ----` with:
```qml
    voice = VoiceSession.createVoiceSession(configStore.config)
    vox.start()
    atv.start()
    root.refreshAudioDevice()
    // ---- module start (Tasks 7–8) ----
```

Replace `// ---- HID mic key → VoiceSession (Task 6) ----` with:
```qml
    if (name === "mic" && root.config.keys.mic.ptt) {                          // §5.1 HID mic key
      root.dispatch(edge === "down" ? voice.hidPress(now) : voice.hidRelease(now), "voice")
      root.rearm()
      return true
    }
```

Replace `// ---- reset → voice abort (Task 6) ----` with:
```qml
    if (voice) root.dispatch(voice.abort(Date.now()), "voice")                // §4.3: cancel, never stop
```

Add these members before `// ---- IPC` :
```qml
  // ---- voice adapters (§5.1, §3) ---------------------------------------------
  function onVoiceState(e) {
    var prev = root.voiceState
    root.voiceState = e.state
    root.voiceOwner = e.owner || ""
    root.voiceInferred = e.owner === "dbus" || e.owner === "keyboard"
    if (e.state === "recording" && prev !== "recording") { root.recordingSince = Date.now(); root.elapsedMs = 0 }
    // ---- external recording → mic apply / self-test (Tasks 7–8) ----
  }
  function updateRemoteWarning() {                                              // §5.4
    var mode = root.config ? root.config.voice.mic : "remote"
    var warn = mode === "remote" && (!root.atvBusName || !root.remoteNode || root.voxAudioDevice !== root.remoteNode)
    root.remoteWarning = warn
    if (voice) voice.setDbusEnabled(!warn)
  }
  Process {
    id: audioDeviceProbe
    command: ["voxtype", "config", "get", "audio.device", "--json"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var r = MicApply.parseConfigGet(text)
      root.voxAudioDevice = r.effective === null || r.effective === undefined ? "" : String(r.effective)
      root.updateRemoteWarning()
    } }
  }
  function refreshAudioDevice() { if (!audioDeviceProbe.running) audioDeviceProbe.running = true }

  CommandRunner {
    id: runner
    onFinished: function(src, id, code, stdout, timedOut) {
      var now = Date.now()
      if (src === "voice" && voice) root.dispatch(voice.cmdExit(id, code, now), "voice")
      // ---- mic command exits (Task 7) ----
      root.rearm()
    }
  }
  VoxtypeMonitor {
    id: vox
    onStatus: function(cls, fresh, raw) {
      var now = Date.now()
      root.backendClass = cls
      if (voice) root.dispatch(voice.status(cls, now, { fresh: fresh }), "voice")
      // ---- fresh polls → mic apply / verifier (Task 7) ----
      root.rearm()
    }
  }
  AtvvoiceMonitor {
    id: atv
    onSource: function(sender, generation, busName) {
      root.atvBusName = busName
      if (!busName) root.remoteState = "absent"
      if (voice) voice.setDbusSource({ sender: sender || null, generation: generation })
      root.updateRemoteWarning()
    }
    onSignalEvent: function(ev) {
      root.remoteState = ev.state
      if (voice) root.dispatch(voice.dbus(ev, Date.now()), "voice")
      root.rearm()
    }
    onStateRead: function(requestId, state, generation) {
      if (state) root.remoteState = state
      if (voice) root.dispatch(voice.atvRead({ state: state || "unknown", requestId: requestId, generation: generation }, Date.now()), "voice")
      root.rearm()
    }
    onNodeName: function(name) { root.remoteNode = name; root.updateRemoteWarning() }
  }
  Loader {
    id: hudLoader
    source: Qt.resolvedUrl("components/Hud.qml")
    onLoaded: root.syncHud()
    onStatusChanged: if (status === Loader.Error) console.log("omaremote: HUD unavailable outside omarchy-shell")
  }
  function syncHud() {
    var h = hudLoader.item
    if (!h) return
    h.line = root.hudLine
    h.recording = root.voiceState === "recording"
    h.enabled = root.config ? root.config.voice.hud : true
  }
  onHudLineChanged: syncHud()
  onVoiceStateChanged: syncHud()
  onConfigChanged: syncHud()

  function ipcVoice(verb, arg) {
    var now = Date.now()
    if (!voice) return JSON.stringify({ ok: false, reason: "not-ready" })
    if (verb === "state") {
      if (!atv.sender) return JSON.stringify({ ok: false, reason: "no-atvvoice" })
      root.dispatch(voice.dbus({ state: arg, sender: atv.sender, path: atv.path, interface: atv.iface, member: "MicStateChanged", generation: atv.generation }, now), "voice")
      root.remoteState = arg
      root.rearm()
      return JSON.stringify({ ok: true })
    }
    if (verb === "poll") { vox.poll(); return JSON.stringify({ ok: true }) }
    if (verb === "audioDevice") { root.refreshAudioDevice(); return JSON.stringify({ ok: true }) }
    return JSON.stringify({ ok: false, reason: "unknown-verb" })
  }
```

Replace `// ---- more status (Tasks 6–8) ----` with:
```qml
      , voice: voice ? (function(s) { return { state: s.state, owner: s.owner, inferred: s.inferred, pendingCmds: s.pendingCmds, gates: s.gates, backendFresh: s.backendFresh } })(voice.snapshot()) : null
      , backend: root.backendClass
      , remote: { state: root.remoteState, node: root.remoteNode, bus: root.atvBusName, sender: atv.sender, warning: root.remoteWarning }
      , audioDevice: root.voxAudioDevice
      // ---- more status (Tasks 7–8) ----
```

Replace `// ---- more verbs (Tasks 6–8) ----` with:
```qml
    function voice(verb: string, arg: string): string { return root.ipcVoice(verb, arg) }
    // ---- more verbs (Tasks 7–8) ----
```

- [ ] **Step 8: Run**

Run: `make integration`
Expected: all scenarios `ok` (20). Diagnostics: `.remote.sender` never `:1.99` → check `$F/atv.log` for the `list`/`GetNameOwner` calls and `harness.log`; `dbus_session` stuck in `arbitrating` → the `readAtv` answer or the fresh poll did not arrive within 500 ms (`stateProc` queue or `pollProc` collector), inspect `.voice.pendingCmds`; `keyboard_session_observed` stuck → the follow stream line was not parsed (`SplitParser` needs `splitMarker: "\n"`).

- [ ] **Step 9: Lint and commit**

Run: `make lint` → clean.

```bash
git add Service.qml components/CommandRunner.qml components/VoxtypeMonitor.qml components/AtvvoiceMonitor.qml components/Hud.qml tests/fake-remote.sh
git commit -m "feat(host): voice session wiring — command runner, voxtype/atvvoice monitors, HUD"
```

---

### Task 7: Mic apply, systemd verifier, recovery restart, stats, capture verification

**Files:**
- Create: `components/SystemdVerifier.qml`, `components/StatsStore.qml`
- Modify: `Service.qml` (Task 7 anchors), `tests/fake-remote.sh` (append scenarios)

**Interfaces:**
- Consumes: `lib/MicApply.mjs` (`createMicApply({ voice }) → { request(mode, now, { nodeName }) → { effects, result }, statusOf(id) → { state, phase, mode, error, rollback } | null, pending(), backend(cls, now, { fresh }), systemdJob(pending, now), cmdExit(id, code, stdout, now), verifyResult(ok, now, id), externalRecording(now), reset(now, reason), advance(now), nextDeadline() }`), `lib/Systemd.mjs`, `lib/Stats.mjs` (`createStats(initial) → { add, entries, summary(now) }`), `lib/Pipewire.mjs`.
- Produces: `SystemdVerifier { jobPolling; lastShow; invocationBeforeRestart; markRestart(); beginVerify(kind, id, now); beginRecovery(now); status(cls, fresh, now); advance(now); nextDeadline(); signals jobInfo(info), pollRequested(), verified(kind, id, ok), recoveryRestarting() }`; `StatsStore { entries; loaded; save(list); signal statsLoaded() }`; Service properties `mic`, `stats`, `micPending`, `micCurrentId`, `micLast`, `micConflict`, `unconfiguredReason`, `lastCapture`, `statsSummary`; functions `ipcMic(mode)`, `ipcMicStatus(id)`, `micStatusOf(id)`; IPC verbs `mic <mode>`, `micStatus <id>`; status fields `mic{pending,current,last,conflict}`, `stats`, `lastCapture`, `unconfiguredReason`.

- [ ] **Step 1: Append failing scenarios**

Append to `tests/fake-remote.sh` before `# ---- summary`:

```bash
# ---- Task 7: mic apply, recovery restart, stats, capture ----
mic_wait() {   # mic_wait <id> [timeout-s] → prints terminal state
  local id=$1 t=${2:-15} i=0 st=""
  while (( i < t * 10 )); do st=$(ipc micStatus "$id" | jq -r .state); [[ $st == succeeded || $st == failed ]] && { echo "$st"; return 0; }; sleep 0.1; i=$((i + 1)); done
  echo "$st"; return 1
}
s_mic_apply_system() {
  ready || return 1
  local r; r=$(ipc mic system)
  [[ $(jq -r .ok <<<"$r") == true && $(jq -r .state <<<"$r") == queued ]] || { echo "    $r"; return 1; }
  local id; id=$(jq -r .operationId <<<"$r")
  [[ $(mic_wait "$id") == succeeded ]] || { ipc micStatus "$id"; return 1; }
  has_line "$F/vox.log" "voxtype config get audio.device --json" || return 1
  has_line "$F/vox.log" "voxtype config set audio.device default" || return 1
  has_line "$F/sysd.log" "systemctl --user restart voxtype" || return 1
  has_line "$F/sysd.log" "systemctl --user show voxtype --property=Job,ActiveState,InvocationID --value" || return 1
  [[ $(jq -r .voice.mic "$XDG_CONFIG_HOME/omaremote/config.json") == system ]] || return 1     # commit only after verification
  [[ $(jget '.voice.state') == idle && $(jget '.mic.pending') == false ]] || return 1
  [[ $(jget '.audioDevice') == default ]]                                                         # re-read after commit
}
s_mic_apply_second_request_is_busy() {
  ready || return 1
  local id; id=$(ipc mic system | jq -r .operationId)
  [[ $(ipc mic remote | jq -r .reason) == busy ]] || return 1
  [[ $(mic_wait "$id") == succeeded ]]
}
s_mic_apply_unknown_id_is_failure() { ready || return 1; [[ $(ipc micStatus mic-99 | jq -r .ok) == false ]]; }
s_mic_apply_waits_for_session() {         # §3 step 1: no mutation while a session runs; HUD explains; applies afterwards
  ready || return 1
  ipc key mic down > /dev/null; wait_for '.voice.state' recording 3 || return 1
  local id; id=$(ipc mic system | jq -r .operationId)
  sleep 0.6
  no_line "$F/vox.log" "voxtype config set audio.device default" || return 1
  [[ $(jget '.hud') == *"mic change applies after this dictation"* ]] || { echo "    hud=$(jget '.hud')"; return 1; }
  ipc key mic up > /dev/null
  [[ $(mic_wait "$id") == succeeded ]]
}
s_mic_apply_restart_fails_rolls_back() {  # §9: verification fails → rollback restores the old literal; mode not committed
  ready || return 1
  : > "$F/sysd.restart-fails-once"
  local id; id=$(ipc mic system | jq -r .operationId)
  [[ $(mic_wait "$id" 25) == failed ]] || return 1
  local s; s=$(ipc micStatus "$id")
  [[ $(jq -r .rollback <<<"$s") == verified ]] || { echo "    $s"; return 1; }
  [[ $(cat "$F/vox.config") == atvvoice_mic ]] || return 1
  [[ $(jq -r .voice.mic "$XDG_CONFIG_HOME/omaremote/config.json") == remote ]] || return 1
  [[ $(jget '.voice.state') == idle ]]
}
s_mic_apply_job_pending_blocks() {         # §3: a live systemd job (any origin) blocks the initial mutation
  ready || return 1
  printf '55 start\n' > "$F/sysd.job"
  local id; id=$(ipc mic system | jq -r .operationId)
  [[ $(mic_wait "$id" 8) == failed ]] || return 1
  no_line "$F/vox.log" "voxtype config set audio.device default" || return 1
  no_line "$F/sysd.log" "systemctl --user restart voxtype" || return 1
  : > "$F/sysd.job"
  id=$(ipc mic system | jq -r .operationId)
  [[ $(mic_wait "$id") == succeeded ]]
}
s_recovery_restart_bounded() {             # §5.3/§9: daemon hangs after abort (cancel ignored, polls unanswered) → one bounded restart → verified → idle
  ready || return 1
  ipc key mic down > /dev/null; wait_for '.voice.state' recording 3 || return 1
  : > "$F/vox.cancel-ignored"; : > "$F/vox.hang"
  ipc reset > /dev/null
  wait_for '.voice.state' recovering 2 || return 1
  has_line "$F/vox.log" "voxtype record cancel" || return 1
  sleep 5; [[ $(jget '.voice.state') == recovering ]] || return 1          # no premature restart or unconfigured
  no_line "$F/sysd.log" "systemctl --user restart voxtype" || return 1
  for _ in $(seq 1 200); do grep -qxF "systemctl --user restart voxtype" "$F/sysd.log" && break; sleep 0.1; done   # ≈15 s budget
  has_line "$F/sysd.log" "systemctl --user restart voxtype" || return 1
  [[ $(jget '.hud') == "restarting Voxtype" || $(jget '.voice.state') == idle ]] || return 1
  ipc key mic up > /dev/null
  wait_for '.voice.state' idle 15 || return 1                              # verified restart → fresh idle → settle
  (( $(grep -cxF "systemctl --user restart voxtype" "$F/sysd.log") == 1 ))
}
s_stats_and_capture() {                    # §5.5 + §3 capture verification
  ready || return 1
  ipc key mic down > /dev/null; wait_for '.voice.state' recording 3 || return 1
  sleep 0.6
  ipc key mic up > /dev/null; wait_for '.voice.state' idle 5 || return 1
  wait_for '.stats.all.count' 1 3 || return 1
  jq -e 'length == 1 and .[0].source == "hid" and .[0].inferred == false' "$XDG_DATA_HOME/omaremote/stats.json" > /dev/null || return 1
  [[ $(jget '.lastCapture.node') == atvvoice_mic ]] || { echo "    lastCapture=$(jget '.lastCapture')"; return 1; }
  has_line "$F/actions.log" "pw-dump"
}
scenario mic_apply_system s_mic_apply_system
scenario mic_apply_second_request_is_busy s_mic_apply_second_request_is_busy
scenario mic_apply_unknown_id_is_failure s_mic_apply_unknown_id_is_failure
scenario mic_apply_waits_for_session s_mic_apply_waits_for_session
scenario mic_apply_restart_fails_rolls_back s_mic_apply_restart_fails_rolls_back
scenario mic_apply_job_pending_blocks s_mic_apply_job_pending_blocks
scenario recovery_restart_bounded s_recovery_restart_bounded
scenario stats_and_capture s_stats_and_capture
```

- [ ] **Step 2: Run to verify they fail**

Run: `make integration` → the 8 new scenarios FAIL (`mic` verb missing).

- [ ] **Step 3: SystemdVerifier**

Create `components/SystemdVerifier.qml`:

```qml
// Spec §3 (systemd job contract: poll Job/ActiveState/InvocationID at 1 s while an operation is pending; never submit a competing
// restart; verify active + new InvocationID + fresh idle within 10 s), §5.3 (bounded recovery restart with the same contract).
import QtQuick
import Quickshell.Io
import "../lib/Systemd.mjs" as Systemd

Item {
  id: root
  property var verifier: Systemd.createRestartVerifier({ deadlineMs: 10000 })
  property var lastShow: ({ job: "", activeState: "", invocationId: "", jobPending: false })
  property string invocationBeforeRestart: ""
  property bool jobPolling: false                       // Service sets this while a mic operation is pending
  property string recoveryPhase: ""                     // "" | waitJob | restarting | verifying
  signal jobInfo(var info)
  signal pollRequested()                                 // answered by the Service with a fresh status poll
  signal verified(string kind, string id, bool ok)       // kind: mic | recovery
  signal recoveryRestarting()

  function pollJob() { if (!showProc.running) showProc.running = true }
  Timer {
    id: jobTimer
    interval: 1000; repeat: true; triggeredOnStart: true
    running: root.jobPolling || root.recoveryPhase === "waitJob"
    onTriggered: root.pollJob()
  }

  function markRestart() { root.invocationBeforeRestart = root.lastShow.invocationId }   // call when a restart command is issued
  function beginVerify(kind, id, now) { root.handle(root.verifier.begin(kind + ":" + id, root.invocationBeforeRestart, now), now) }
  function beginRecovery(now) {
    if (root.recoveryPhase !== "") return
    root.recoveryPhase = "waitJob"                       // §5.3: a non-empty Job blocks the restart whatever its origin
    root.pollJob()
  }
  function handle(fx, now) {
    for (var i = 0; i < fx.length; i++) {
      var e = fx[i]
      if (e.type === "show") root.pollJob()
      else if (e.type === "poll") root.pollRequested()
      else if (e.type === "verified") {
        var p = e.id.indexOf(":")
        var kind = e.id.slice(0, p)
        if (kind === "recovery") root.recoveryPhase = ""
        root.verified(kind, e.id.slice(p + 1), e.ok)
      }
    }
  }
  function status(cls, fresh, now) { if (root.verifier.active()) root.handle(root.verifier.status(cls, fresh, now), now) }
  function advance(now) { if (root.verifier.active()) root.handle(root.verifier.advance(now), now) }
  function nextDeadline() { return root.verifier.nextDeadline() }

  Process {
    id: showProc
    command: ["systemctl", "--user", "show", "voxtype", "--property=Job,ActiveState,InvocationID", "--value"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      var info = Systemd.parseShow(text)
      var now = Date.now()
      root.lastShow = info
      root.jobInfo(info)
      if (root.verifier.active()) root.handle(root.verifier.show(info, now), now)
      if (root.recoveryPhase === "waitJob" && !info.jobPending) {
        root.recoveryPhase = "restarting"
        root.markRestart()
        root.recoveryRestarting()
        restartGuard.restart()
        restartProc.running = true
      }
    } }
  }
  Process {
    id: restartProc
    command: ["systemctl", "--user", "restart", "voxtype"]
    onExited: function(code, st) {
      restartGuard.stop()
      var now = Date.now()
      if (root.recoveryPhase !== "restarting") return
      if (code !== 0) { root.recoveryPhase = ""; root.verified("recovery", "", false); return }
      root.recoveryPhase = "verifying"
      root.handle(root.verifier.begin("recovery:", root.invocationBeforeRestart, now), now)
    }
  }
  Timer { id: restartGuard; interval: 10000; repeat: false; onTriggered: if (restartProc.running) restartProc.signal(15) }
}
```

- [ ] **Step 4: StatsStore**

Create `components/StatsStore.qml`:

```qml
// Spec §5.5: per-session stats appended to $XDG_DATA_HOME/omaremote/stats.json; no audio or transcribed text is stored.
import QtQuick
import Quickshell.Io

Item {
  id: root
  required property string path
  property bool ready: false
  property var entries: []
  property bool loaded: false
  signal statsLoaded()

  FileView {
    id: file
    path: root.ready ? root.path : ""
    printErrors: false
    atomicWrites: true
    onLoaded: {
      try { var v = JSON.parse(file.text()); root.entries = Array.isArray(v) ? v : [] } catch (e) { root.entries = [] }
      root.loaded = true; root.statsLoaded()
    }
    onLoadFailed: function(error) { root.entries = []; root.loaded = true; root.statsLoaded() }
  }
  function save(list) { root.entries = list; file.setText(JSON.stringify(list) + "\n") }
}
```

- [ ] **Step 5: Service.qml — mic/stats wiring**

Add imports:
```qml
import "lib/Stats.mjs" as Stats
import "lib/Pipewire.mjs" as Pipewire
```

After `property int elapsedMs: 0` add:
```qml
  property var mic: null
  property var stats: null
  property bool micPending: false
  property string micCurrentId: ""
  property var micLast: null                      // last terminal `done` effect
  property var micConflict: null                  // { expected, found } from a `conflict` effect
  property string unconfiguredReason: ""
  property var lastCapture: null                  // null = not yet verified (§3); { node, at, mode }
  property var statsSummary: ({ today: { count: 0, seconds: 0 }, week: { count: 0, seconds: 0 }, all: { count: 0, seconds: 0 }, longest: null })
```

Replace `// ---- mic/stat effects (Task 7) ----` with:
```qml
      case "restart": runner.cancelAll("voice"); vox.restart(); verifier.beginRecovery(Date.now()); break   // §5.3: reap, then bounded restart
      case "verify": verifier.beginVerify("mic", e.id, Date.now()); break
      case "commit": configStore.setVoiceMic(e.mode); root.refreshAudioDevice(); break                 // §3 step 4
      case "done": root.micLast = e; root.micPending = mic.pending(); if (e.state !== "queued") root.refreshDoctor(); break
      case "conflict": root.micConflict = { expected: e.expected, found: e.found }; break
      case "unconfigured": root.unconfiguredReason = e.reason; break
      case "stat": stats.add(e.session); statsStore.save(stats.entries()); root.statsSummary = stats.summary(Date.now()); break
```
(`refreshDoctor()` is defined in Task 8; until then add a stub `function refreshDoctor() {}` next to `refreshAudioDevice()` and remove it in Task 8.)

`cmd` case: change to
```qml
      case "cmd":
        if (src === "mic" && e.kind === "restart") { verifier.markRestart(); vox.restart() }
        runner.run(src, e.id, e.argv, e.kind === "restart" ? root.restartCmdMs : root.shortCmdMs)
        break
```

`deadlines()` → `[engine…, voice…, mic ? mic.nextDeadline() : null, verifier.nextDeadline()]` (keep the Task 8 anchor comment). `advanceAll()` → add `if (mic) root.dispatch(mic.advance(now), "mic")` and `verifier.advance(now)` before the Task 8 anchor.

Replace `// ---- module start (Tasks 7–8) ----` with:
```qml
    mic = MicApply.createMicApply({ voice: voice })
    stats = Stats.createStats(statsStore.loaded ? statsStore.entries : [])
    root.statsSummary = stats.summary(now)
    // ---- module start (Task 8) ----
```

In `rearm()` first line add: `root.micPending = mic ? mic.pending() : false; verifier.jobPolling = root.micPending`.

Replace `// ---- mic command exits (Task 7) ----` with:
```qml
      if (src === "mic" && mic) root.dispatch(mic.cmdExit(id, code, stdout, now), "mic")
```

Replace `// ---- fresh polls → mic apply / verifier (Task 7) ----` with:
```qml
      if (mic) root.dispatch(mic.backend(cls, now, { fresh: fresh }), "mic")
      verifier.status(cls, fresh, now)
```

Replace `// ---- external recording → mic apply / self-test (Tasks 7–8) ----` with:
```qml
    if (e.state === "unconfigured") root.unconfiguredReason = root.lastError
    if (e.state === "recording" && prev !== "recording") captureDelay.restart()                 // §3 capture verification
    if (e.state === "recording" && e.owner === "keyboard" && mic && root.micCurrentId) {
      var cur = mic.statusOf(root.micCurrentId)
      if (cur && (cur.state === "applying" || cur.state === "verifying" || cur.state === "rollingBack"))
        root.dispatch(mic.externalRecording(Date.now()), "mic")                                  // §3: observed interference
    }
    // ---- external recording → self-test (Task 8) ----
```

Add after the `AtvvoiceMonitor { … }` block:
```qml
  SystemdVerifier {
    id: verifier
    onJobInfo: function(info) { if (mic && mic.pending()) { root.dispatch(mic.systemdJob(info.jobPending, Date.now()), "mic"); root.rearm() } }
    onPollRequested: vox.poll()
    onRecoveryRestarting: root.hudText = "restarting Voxtype"
    onVerified: function(kind, id, ok) {
      var now = Date.now()
      if (kind === "mic" && mic) root.dispatch(mic.verifyResult(ok, now, id), "mic")
      else if (kind === "recovery" && voice) { if (ok) vox.restart(); root.dispatch(voice.restartResult(ok, now), "voice") }   // discard the old monitor before restartResult(true)
      root.rearm()
    }
  }
  StatsStore {
    id: statsStore
    path: root.dataHome + "/omaremote/stats.json"
    ready: configStore.ready
    onStatsLoaded: { if (stats) { stats = Stats.createStats(statsStore.entries); root.statsSummary = stats.summary(Date.now()) } }
  }
  Timer { id: captureDelay; interval: 400; repeat: false; onTriggered: if (!captureProbe.running) captureProbe.running = true }
  Process {
    id: captureProbe
    command: ["pw-dump"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      try {
        var r = Pipewire.captureSourceOf(JSON.parse(text))
        if (r.streamFound) root.lastCapture = { node: r.node, at: Date.now(), mode: root.config.voice.mic }
      } catch (e) { console.log("omaremote: pw-dump parse failed: " + e) }
    } }
  }
  function ipcMic(mode) {
    if (!mic) return JSON.stringify({ ok: false, reason: "not-ready" })
    var now = Date.now()
    var r = mic.request(mode, now, { nodeName: root.remoteNode })
    root.dispatch(r.effects, "mic")
    if (r.result.ok) { root.micCurrentId = r.result.operationId; root.micConflict = null }
    root.rearm()
    return JSON.stringify(r.result.ok ? { ok: true, operationId: r.result.operationId, state: "queued" } : { ok: false, reason: r.result.reason })
  }
  function micStatusOf(id) { return mic ? mic.statusOf(id) : null }
  function ipcMicStatus(id) {
    var s = root.micStatusOf(id)
    return JSON.stringify(s ? { ok: true, operationId: id, state: s.state, phase: s.phase, mode: s.mode, error: s.error, rollback: s.rollback }
                            : { ok: false, reason: "unknown-operation" })                         // §3: unknown ID is a failure, never success
  }
```

Status JSON (replace `// ---- more status (Tasks 7–8) ----`):
```qml
      , mic: { pending: root.micPending, current: root.micCurrentId ? root.micStatusOf(root.micCurrentId) : null, last: root.micLast, conflict: root.micConflict }
      , stats: root.statsSummary
      , lastCapture: root.lastCapture
      , unconfiguredReason: root.unconfiguredReason
      // ---- more status (Task 8) ----
```

IPC verbs (replace `// ---- more verbs (Tasks 7–8) ----`):
```qml
    function mic(mode: string): string { return root.ipcMic(mode) }
    function micStatus(id: string): string { return root.ipcMicStatus(id) }
    // ---- more verbs (Task 8) ----
```

- [ ] **Step 6: Run**

Run: `make integration` → all 28 `ok`. Diagnostics: `mic_apply_system` stuck `queued` → the fresh poll never reached `mic.backend(...{fresh:true})` or `jobPolling` never delivered `systemdJob(false)`; `stats_and_capture` `lastCapture` null → `captureDelay` fired before the fake's `recording` line or `pw-dump.json` missing from `$F`; `recovery_restart_bounded` never restarts → `verifier.beginRecovery` never saw a job-free `show` (check `$F/sysd.log`).

- [ ] **Step 7: Lint and commit**

Run: `make lint` → clean.

```bash
git add Service.qml components/SystemdVerifier.qml components/StatsStore.qml tests/fake-remote.sh
git commit -m "feat(host): mic apply transaction host, systemd verifier and recovery restart, stats and capture verification"
```

---

### Task 8: Self-test lease, doctor facts script, doctor evaluation, mic toggle

**Files:**
- Create: `host/omaremote-facts`
- Modify: `Service.qml` (Task 8 anchors), `tests/fake-remote.sh` (append scenarios)

**Interfaces:**
- Consumes: `lib/SelfTest.mjs` (`createSelfTest({ supportedKeys, gate }) → { arm(now, ctx) → { ok, id | reason }, active(), record(source, key, edge, now), status(id, now), report(id, now), disarm(id, now), externalRecording(now), advance(now), nextDeadline() }`), `lib/Doctor.mjs` (`evaluate(facts, config) → rows`, `summarize(rows, config)`).
- Produces: `host/omaremote-facts` (prints one JSON object with `tools`, `keyd`, `hypr`, `voxtype`, `atvvoice`, `pipewire` — the facts keys `lib/Doctor.mjs` reads; Plan 3 `--doctor` runs the same script); Service properties `selftest`, `selftestActive`, `doctorRows`, `doctorSummary`, `doctorFacts`, `doctorAt`, `unconfigured`; functions `refreshDoctor()`, `micToggle()`; IPC verbs `selftestPing`, `selftestArm`, `selftestStatus <id>`, `selftestReport <id>`, `selftestDisarm <id>`, `doctor`, `micToggle`; status fields `selftest{active}`, `doctorSummary`, `unconfigured`.

- [ ] **Step 1: Append failing scenarios**

Append before `# ---- summary`:

```bash
# ---- Task 8: self-test lease, doctor ----
s_selftest_counts_shortcut_not_ipc() {   # §7 step 6: IPC-injected events are tracked separately and cannot pass the transport check
  ready || return 1
  [[ $(ipc selftestPing) == ok ]] || return 1
  local r; r=$(ipc selftestArm)
  [[ $(jq -r .ok <<<"$r") == true ]] || { echo "    $r"; return 1; }
  local id; id=$(jq -r .id <<<"$r")
  [[ $(jget '.selftest.active') == true && $(jget '.hud') == self-test ]] || return 1
  [[ $(ipc selftestStatus "$id" | jq -r .active) == true ]] || return 1
  ipc key ok down > /dev/null; ipc key ok up > /dev/null; sleep 0.15
  no_line "$F/actions.log" "wtype -k Return" || return 1                       # real actions suppressed
  local rep; rep=$(ipc selftestReport "$id")
  [[ $(jq -r .ok <<<"$rep") == false ]] || { echo "    $rep"; return 1; }
  jq -e '.missing | index("ok") != null' <<<"$rep" > /dev/null || return 1     # ok never arrived through GlobalShortcut
  jq -e '.counts.ipc.ok.down == 1' <<<"$rep" > /dev/null || return 1
  [[ $(jget '.selftest.active') == false && $(jget '.hud') == "" ]]
}
s_selftest_busy_during_session() {       # §9: arm returns busy without cancelling the session
  ready || return 1
  ipc key mic down > /dev/null; wait_for '.voice.state' recording 3 || return 1
  [[ $(ipc selftestArm | jq -r .reason) == busy ]] || return 1
  [[ $(jget '.voice.state') == recording ]] || return 1
  no_line "$F/vox.log" "voxtype record cancel" || return 1
  ipc key mic up > /dev/null; wait_for '.voice.state' idle 5
}
s_selftest_external_f9_fails_test() {    # §9: external recording fails the test and stays observed, never cancelled
  ready || return 1
  local id; id=$(ipc selftestArm | jq -r .id); [[ $id == st-* ]] || return 1
  echo recording > "$F/vox.state"
  wait_for '.voice.state' recording 3 || return 1
  wait_for '.selftest.active' false 2 || return 1
  local rep; rep=$(ipc selftestReport "$id")
  [[ $(jq -r .failed <<<"$rep") == external-recording ]] || { echo "    $rep"; return 1; }
  no_line "$F/vox.log" "voxtype record cancel" || return 1
  echo idle > "$F/vox.state"; wait_for '.voice.state' idle 3
}
s_selftest_unknown_or_used_id() {
  ready || return 1
  [[ $(ipc selftestReport st-99 | jq -r .reason) == unknown ]] || return 1
  [[ $(ipc selftestStatus st-99 | jq -r .ok) == false ]] || return 1
  local id; id=$(ipc selftestArm | jq -r .id)
  [[ $(ipc selftestDisarm "$id") == ok ]] || return 1
  [[ $(ipc selftestReport "$id" | jq -r .reason) == expired ]]
}
s_selftest_blocks_voice_starts() {       # §7 step 6: HID and D-Bus starts suppressed while the lease is active
  ready || return 1
  local id; id=$(ipc selftestArm | jq -r .id)
  ipc key mic down > /dev/null; sleep 0.1; ipc key mic up > /dev/null
  echo streaming >> "$F/atv.signals"; sleep 0.4; echo connected >> "$F/atv.signals"; sleep 0.2
  no_line "$F/vox.log" "voxtype record start" || return 1
  [[ $(jget '.voice.state') == idle ]] || return 1
  ipc selftestDisarm "$id" > /dev/null
}
s_doctor_rows() {                          # §6.2 item 4 through host/omaremote-facts + lib/Doctor.mjs
  ready || return 1
  ipc doctor > /dev/null
  for _ in $(seq 1 50); do [[ $(ipc doctor | jq -r '.rows | length') == 15 ]] && break; sleep 0.1; done
  local d; d=$(ipc doctor)
  [[ $(jq -r '.rows | length' <<<"$d") == 15 ]] || { echo "    $d"; return 1; }
  [[ $(jq -r '.summary' <<<"$d") == ready ]] || { echo "    $d"; return 1; }
  [[ $(jq -r '.rows[] | select(.id == "voxtype-device") | .status' <<<"$d") == pass ]] || return 1
  [[ $(jq -r '.rows[] | select(.id == "last-capture") | .detail' <<<"$d") == "not yet verified" ]] || return 1
  [[ $(jq -r '.rows[] | select(.id == "config-valid") | .status' <<<"$d") == pass ]]
}
s_mic_toggle_owned_mic_closed_on_reset() {   # §5.1/§6.1: a plugin-opened remote mic is the only mic reset ever closes
  ready || return 1
  [[ $(ipc micToggle) == ok ]] || return 1
  sleep 0.2; has_line "$F/atv.log" "busctl --user call org.atvvoice.fake /org/atvvoice/Daemon org.atvvoice.Daemon MicToggle" || return 1
  ipc reset > /dev/null; sleep 0.2
  has_line "$F/atv.log" "busctl --user call org.atvvoice.fake /org/atvvoice/Daemon org.atvvoice.Daemon MicClose"
}
scenario selftest_counts_shortcut_not_ipc s_selftest_counts_shortcut_not_ipc
scenario selftest_busy_during_session s_selftest_busy_during_session
scenario selftest_external_f9_fails_test s_selftest_external_f9_fails_test
scenario selftest_unknown_or_used_id s_selftest_unknown_or_used_id
scenario selftest_blocks_voice_starts s_selftest_blocks_voice_starts
scenario doctor_rows s_doctor_rows
scenario mic_toggle_owned_mic_closed_on_reset s_mic_toggle_owned_mic_closed_on_reset
```

- [ ] **Step 2: Run to verify they fail**

Run: `make integration` → 7 new FAIL.

- [ ] **Step 3: Facts script**

Create `host/omaremote-facts` (`chmod +x`):

```bash
#!/usr/bin/env bash
# Spec §6.2 item 4 and §7 `--doctor`: collect host facts as one JSON object for lib/Doctor.mjs, so the panel and the
# setup script can never disagree. Read-only; needs jq and awk (Omarchy ships both). Never sudo.
set -u
has() { command -v "$1" >/dev/null 2>&1; }
jbool() { if "$@" >/dev/null 2>&1; then echo true; else echo false; fi; }
jstr() { if [[ -n ${1:-} ]]; then jq -Rn --arg v "$1" '$v'; else echo null; fi; }

tools=""
for t in keyd wtype playerctl wpctl pw-dump voxtype evtest jq node; do tools+="\"$t\":$(jbool has "$t"),"; done
tools="{${tools%,}}"

keyd_enabled=$(jbool systemctl is-enabled keyd)
keyd_active=$(jbool systemctl is-active keyd)
if has keyd && [[ -r /etc/keyd/omaremote.conf ]]; then keyd_check=$(jbool keyd check /etc/keyd/omaremote.conf); else keyd_check=null; fi
# The evdev grab itself is only visible to root; keyd's virtual keyboard existing while keyd is active is the observable proxy.
keyd_grab=$(jbool grep -q 'keyd virtual keyboard' /proc/bus/input/devices)

hypr_required=$(jbool grep -q 'require("hypr.omaremote")' "$HOME/.config/hypr/hyprland.lua")
if has hyprctl; then hypr_desc=$(hyprctl binds -j 2>/dev/null | jq -c '[.[] | (.description // "") | select(startswith("omaremote:"))]' 2>/dev/null); fi
hypr_desc=${hypr_desc:-null}

if has voxtype; then
  vox_version=$(jstr "$(voxtype --version 2>/dev/null | awk '{print $2}')")
  vox_class=$(voxtype status --format json 2>/dev/null | jq -c '.class // "stopped"' 2>/dev/null); vox_class=${vox_class:-\"stopped\"}
  vox_out=$(voxtype config get output.mode --json 2>/dev/null | jq -c '.value' 2>/dev/null); vox_out=${vox_out:-null}
  vox_dev=$(voxtype config get audio.device --json 2>/dev/null | jq -c '.value' 2>/dev/null); vox_dev=${vox_dev:-null}
else
  vox_version=null; vox_class=null; vox_out=null; vox_dev=null
fi

atv_active=$(jbool systemctl --user is-active atvvoice)
atv_ondemand=$(jbool bash -c 'systemctl --user show atvvoice --property=ExecStart --value 2>/dev/null | grep -q -- "--mic-on-demand"')
atv_names=$(busctl --user list --no-legend 2>/dev/null | awk '$1 ~ /^org\.atvvoice\./ { print $1 }' | jq -R . | jq -sc .)
atv_first=$(jq -r '.[0] // empty' <<<"$atv_names")
atv_node=null
if [[ -n $atv_first ]]; then
  atv_node=$(jstr "$(busctl --user get-property "$atv_first" /org/atvvoice/Daemon org.atvvoice.Daemon NodeName 2>/dev/null | sed -n 's/^s "\(.*\)"$/\1/p')")
fi

if has pw-dump; then
  pw_sources=$(pw-dump 2>/dev/null | jq -c '[.[] | select(.type == "PipeWire:Interface:Node") | select((.info.props["media.class"] // "") == "Audio/Source") | .info.props["node.name"]]' 2>/dev/null)
fi
pw_sources=${pw_sources:-null}

cat <<JSON
{"tools":$tools,
 "keyd":{"enabled":$keyd_enabled,"active":$keyd_active,"checkOk":$keyd_check,"grabbed":$keyd_grab},
 "hypr":{"required":$hypr_required,"descriptions":$hypr_desc},
 "voxtype":{"version":$vox_version,"statusClass":$vox_class,"outputMode":$vox_out,"audioDevice":$vox_dev},
 "atvvoice":{"active":$atv_active,"micOnDemand":$atv_ondemand,"busNames":$atv_names,"nodeName":$atv_node},
 "pipewire":{"sources":$pw_sources}}
JSON
```

Run it by hand: `host/omaremote-facts | jq .` on the live host prints a JSON object (voxtype/atvvoice values reflect the real machine). Under the fakes: `OMAREMOTE_FAKE_DIR=$(mktemp -d) PATH=tests/fakes/bin:$PATH host/omaremote-facts | jq .atvvoice` → `busNames: []` (no `atv.present`).

- [ ] **Step 4: Service.qml — self-test, doctor, mic toggle**

Add imports:
```qml
import "lib/SelfTest.mjs" as SelfTest
import "lib/Doctor.mjs" as Doctor
```

After `property var statsSummary: …` add:
```qml
  property var selftest: null
  property bool selftestActive: false
  property var doctorRows: []
  property string doctorSummary: "unknown"
  property var doctorFacts: null
  property double doctorAt: 0
  readonly property bool unconfigured: root.voiceState === "unconfigured" || root.doctorSummary === "unconfigured" || root.configInvalid
```

Replace `// ---- self-test effects (Task 8) ----` with:
```qml
      case "selftestExpired": case "selftestFailed": root.onSelftestEnded(); break
```

`deadlines()`: add `selftest ? selftest.nextDeadline() : null`. `advanceAll()`: add `if (selftest) root.dispatch(selftest.advance(now), "selftest")`.

Replace `// ---- module start (Task 8) ----` with:
```qml
    root.rebuildSelftest()
    root.refreshDoctor()
```
and in `onConfigChanged`, after the engine reload line, add `if (!selftestActive) root.rebuildSelftest()`.

Replace `// ---- self-test recorder (Task 8) ----` (in `onKeyEdge`) with:
```qml
    if (selftest && selftest.active()) {                                   // §7 step 6: raw counts before the engine; IPC tracked separately
      selftest.record(source === "ipc" ? "ipc" : "shortcut", name, edge, now)
      root.rearm()
      return true
    }
```

In `runAction`, first line: `if (selftest && selftest.active()) return   // §7 step 6: no real actions under a lease`.

Replace `// ---- external recording → self-test (Task 8) ----` with:
```qml
    if (e.state === "recording" && e.owner === "keyboard" && selftest && selftest.active())
      root.dispatch(selftest.externalRecording(Date.now()), "selftest")     // §7 step 6: fail the test, keep observing
```

Remove the Task 7 stub `function refreshDoctor() {}` and add before `// ---- IPC`:
```qml
  // ---- self-test (§7 step 6) ---------------------------------------------------
  function rebuildSelftest() {
    var keys = Defaults.KEY_NAMES.filter(function(k) { return root.config.keys[k].supported !== false })
    selftest = SelfTest.createSelfTest({ supportedKeys: keys, gate: voice.gate })
  }
  function selftestArm() {
    var now = Date.now()
    if (!selftest || !voice) return { ok: false, reason: "not-ready" }
    if (mic && mic.pending()) return { ok: false, reason: "busy", detail: "mic operation pending" }
    var s = voice.snapshot()
    var fresh = s.backend === "idle" && s.backendFresh && now - s.backendAt <= 500
    if (!fresh) { vox.poll(); return { ok: false, reason: "busy", detail: "backend not fresh; retry" } }
    var r = selftest.arm(now, { voiceIdle: s.state === "idle", backendIdleFresh: fresh, heldKeys: engine.heldKeys(), pendingCmds: s.pendingCmds + runner.pending("voice") })
    if (r.ok) { root.selftestActive = true; root.hudText = "self-test" }
    root.rearm()
    return r
  }
  function onSelftestEnded() {
    root.selftestActive = false
    if (root.hudText === "self-test") root.hudText = ""
    if (engine) engine.reset()                                             // quarantine: no queued action can fire after the lease
    root.heldKeys = []
  }
  function selftestReport(id) { var r = selftest ? selftest.report(id, Date.now()) : { ok: false, reason: "not-ready" }; if (!selftest || !selftest.active()) root.onSelftestEnded(); root.rearm(); return r }
  function selftestDisarm(id) { var ok = selftest ? selftest.disarm(id, Date.now()) : false; if (ok) root.onSelftestEnded(); root.rearm(); return ok }

  // ---- doctor (§6.2 item 4; same rules as host/omaremote-setup --doctor) --------
  Process {
    id: factsProc
    command: [root.pluginDir + "/host/omaremote-facts"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: {
      try { root.doctorFacts = JSON.parse(text) } catch (e) { console.log("omaremote: facts parse failed: " + e); root.doctorFacts = null }
      root.evaluateDoctor()
    } }
  }
  function refreshDoctor() { if (!factsProc.running) factsProc.running = true }
  function evaluateDoctor() {
    if (!root.config) return
    var facts = ({})
    if (root.doctorFacts) for (var k in root.doctorFacts) facts[k] = root.doctorFacts[k]
    facts.lastCapture = root.lastCapture                                      // null = not yet verified
    facts.configProblems = root.configProblems
    facts.now = Date.now()
    root.doctorRows = Doctor.evaluate(facts, root.config)
    root.doctorSummary = Doctor.summarize(root.doctorRows, root.config)
    root.doctorAt = Date.now()
  }
  onLastCaptureChanged: evaluateDoctor()
  onConfigProblemsChanged: evaluateDoctor()

  // ---- mic test (§6.1 middle click) ----------------------------------------------
  function micToggle() {
    if (!voice || (mic && mic.pending()) || root.voiceState === "recovering" || root.selftestActive) return "busy"
    if (!root.atvBusName) return "no-atvvoice"
    atv.micToggle()
    if (root.remoteState === "streaming") voice.micClosed(); else voice.micOpened()   // §5.1: plugin-owned only after our own toggle
    return "ok"
  }
```

Status JSON (replace `// ---- more status (Task 8) ----`):
```qml
      , selftest: { active: root.selftestActive }
      , doctorSummary: root.doctorSummary
      , unconfigured: root.unconfigured
```

IPC verbs (replace `// ---- more verbs (Task 8) ----`):
```qml
    function selftestPing(): string { return "ok" }
    function selftestArm(): string { return JSON.stringify(root.selftestArm()) }
    function selftestStatus(id: string): string {
      var s = selftest ? selftest.status(id, Date.now()) : null
      return JSON.stringify(s ? { ok: true, id: id, active: s.active, remainingMs: s.remainingMs, failed: s.failed } : { ok: false, reason: "unknown" })
    }
    function selftestReport(id: string): string { return JSON.stringify(root.selftestReport(id)) }
    function selftestDisarm(id: string): string { return root.selftestDisarm(id) ? "ok" : "unknown" }
    function doctor(): string { root.refreshDoctor(); return JSON.stringify({ rows: root.doctorRows, summary: root.doctorSummary, facts: root.doctorFacts, at: root.doctorAt }) }
    function micToggle(): string { return root.micToggle() }
```

- [ ] **Step 5: Run**

Run: `make integration` → all 35 `ok`. Then `make lint` → clean; `make test` → all pass.

- [ ] **Step 6: Commit**

```bash
git add Service.qml host/omaremote-facts tests/fake-remote.sh
git commit -m "feat(host): self-test lease host, doctor facts script and evaluation, mic toggle"
```

---

### Task 9: BarWidget, Panel shell with tabs and keyboard navigation, Status tab

**Files:**
- Replace: `BarWidget.qml`
- Create: `Panel.qml`, `components/TabBar.qml`, `components/StatusTab.qml`, `components/KeysTab.qml` (stub page), `components/VoiceTab.qml` (stub page), `components/SetupTab.qml` (stub page)

**Interfaces:**
- Consumes: Service properties from Tasks 5–8 (`voiceState`, `voiceOwner`, `voiceInferred`, `backendClass`, `remoteState`, `remoteNode`, `atvBusName`, `remoteWarning`, `unconfigured`, `micPending`, `selftestActive`, `elapsedMs`, `statsSummary`, `lastCapture`, `doctorRows`, `config`, `errorCount`, `lastError`), functions `micToggle()`, `refreshDoctor()`, signal `resetHappened()`; `lib/Presentation.mjs` (`glyphLook`, `elapsedText`, `keyLabel`).
- Produces: **tab page contract** used by Tasks 10–11 — every `components/*Tab.qml` is an `Item` with `property var service`, `property QtObject bar`, `property color fg`, `property string fontFamily`, `property int cursor: -1`, `readonly property int rowCount`, `property bool editing: false`, `function moveCursor(dy)`, `function activate()`, `function onShown()`; `Panel.qml` properties `tabIndex`, `currentTab`, `editing`; `BarWidget` contract (`open/close/toggle/closeForPopoutSwitch/opened/popoutSwitchClosing`) and `service`.

- [ ] **Step 1: BarWidget.qml**

Replace `BarWidget.qml`:

```qml
// Spec §6.1: one remote glyph coloured by Service state with Omarchy theme tokens; active voice/operation states take precedence;
// left click toggles the Panel, middle click is the quick mic test; bar-widget contract for Bar.findPanelWidget.
import QtQuick
import qs.Commons
import qs.Ui
import "lib/Presentation.mjs" as Presentation

BarWidget {
  id: root
  moduleName: "io.github.kehao-chen.omaremote"
  readonly property string pluginId: "io.github.kehao-chen.omaremote"
  property var service: null
  readonly property color warningColor: "#e5c07b"      // no Omarchy token for "warning"; §6.1 asks for yellow

  function findService() {
    var s = bar && bar.shell && typeof bar.shell.serviceFor === "function" ? bar.shell.serviceFor(pluginId) : null
    if (s) service = s
  }
  Timer { id: retry; interval: 500; repeat: true; running: !root.service; onTriggered: root.findService() }
  onBarChanged: findService()
  Connections { target: root.service; function onResetHappened() { root.close() } }   // §4.3: reset closes HUD and Panel

  readonly property string look: service ? Presentation.glyphLook({
      voiceState: service.voiceState, unconfigured: service.unconfigured, remoteState: service.remoteState,
      micPending: service.micPending, selftest: service.selftestActive }) : "disconnected"
  readonly property string glyph: look === "selftest" ? "󰙨" : (look === "unconfigured" || look === "disconnected" ? "󰍭" : "󰍬")
  readonly property color fg: bar ? bar.barForeground : Color.foreground
  readonly property color glyphColor: look === "recording" ? (bar ? bar.urgent : Color.urgent)
                                    : look === "unconfigured" ? root.warningColor
                                    : look === "disconnected" ? Qt.darker(fg, 1.6) : fg
  readonly property string elapsed: service && look === "recording" ? Presentation.elapsedText(service.elapsedMs) : ""
  readonly property string tooltipText: {
    if (!service) return "OmaRemote: service not loaded"
    if (look === "unconfigured") {
      var missing = []
      for (var i = 0; i < service.doctorRows.length; i++) if (service.doctorRows[i].status === "fail") missing.push(service.doctorRows[i].label)
      return "OmaRemote unconfigured: " + (missing.length ? missing.join(", ") : service.unconfiguredReason || "see Setup tab")
    }
    if (look === "busy") return service.micPending ? "OmaRemote: changing microphone…" : "OmaRemote: recovering…"
    if (look === "recording") return "Recording (" + service.voiceOwner + (service.voiceInferred ? ", inferred" : "") + ")"
    if (service.remoteWarning) return "OmaRemote: remote mic not ready (" + (service.remoteState === "absent" ? "ATVVoice not running" : "audio.device ≠ " + service.remoteNode) + ")"
    return "OmaRemote: " + look + (service.remoteState !== "unknown" ? " · remote " + service.remoteState : "")
  }

  implicitWidth: row.implicitWidth + Style.space(12)
  implicitHeight: barSize

  Row {
    id: row
    anchors.centerIn: parent
    spacing: Style.space(4)
    Text {
      id: glyphText
      textFormat: Text.PlainText
      text: root.glyph
      color: root.glyphColor
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.icon
      anchors.verticalCenter: parent.verticalCenter
      SequentialAnimation on opacity {                    // slow pulse while recording
        running: root.look === "recording"; loops: Animation.Infinite
        NumberAnimation { to: 0.4; duration: 900 } NumberAnimation { to: 1.0; duration: 900 }
      }
      onTextChanged: opacity = 1
    }
    Text {                                                // spinner for transcribing / recovering / mic apply, pending dot for arbitrating/starting
      textFormat: Text.PlainText
      visible: root.look === "transcribing" || root.look === "busy" || root.look === "pending"
      text: root.look === "pending" ? "…" : ""
      color: root.fg
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.bodySmall
      anchors.verticalCenter: parent.verticalCenter
      RotationAnimation on rotation { running: root.look !== "pending" && parent.visible; loops: Animation.Infinite; from: 0; to: 360; duration: 1400 }
    }
    Text {
      textFormat: Text.PlainText
      visible: root.elapsed !== "" && !root.vertical
      text: root.elapsed
      color: root.bar ? root.bar.urgent : Color.urgent
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.bodySmall
      anchors.verticalCenter: parent.verticalCenter
    }
    Rectangle {                                           // §5.4 remoteWarning dot
      visible: root.service && root.service.remoteWarning && root.look === "ready"
      width: Style.space(6); height: width; radius: width / 2
      color: root.warningColor
      anchors.verticalCenter: parent.verticalCenter
    }
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton | Qt.MiddleButton
    cursorShape: Qt.PointingHandCursor
    onClicked: function(mouse) {
      if (mouse.button === Qt.MiddleButton) { if (root.service) root.service.micToggle() }   // §6.1 quick mic test (busy-guarded by the Service)
      else root.toggle()
    }
    onEntered: if (root.bar) root.bar.showTooltip(root, root.tooltipText)
    onExited: if (root.bar) root.bar.hideTooltip(root)
  }

  // ---- Panel popup (Bar.findPanelWidget requires open/close/opened on the widget root) ----
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  function open() { if (panelLoader.item) panelLoader.item.openFromHotkey() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }
  function injectPanel() {
    var t = panelLoader.item
    if (!t) return
    t.bar = root.bar; t.settings = root.settings; t.anchorItem = root; t.hostWidget = root; t.service = root.service
  }
  onServiceChanged: injectPanel()
  onSettingsChanged: injectPanel()
  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: { root.injectPanel(); Qt.callLater(root.injectPanel) }
  }
}
```

- [ ] **Step 2: TabBar**

Create `components/TabBar.qml`:

```qml
// Spec §6.2: four-tab header; the Panel drives `current` from keys (←/→, 1–4) and clicks.
import QtQuick
import qs.Commons

Row {
  id: root
  property var tabs: ["Status", "Keys", "Voice", "Setup"]
  property int current: 0
  property color fg: Color.foreground
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  signal selected(int index)
  spacing: Style.space(6)
  Repeater {
    model: root.tabs
    Rectangle {
      required property int index
      required property string modelData
      readonly property bool active: index === root.current
      width: label.implicitWidth + Style.space(16)
      height: label.implicitHeight + Style.space(8)
      radius: Style.cornerRadius
      color: active ? Style.selectedFillFor(root.fg, root.accent) : "transparent"
      Text {
        id: label
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: (parent.index + 1) + " " + parent.modelData
        color: parent.active ? root.accent : Qt.darker(root.fg, 1.3)
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: parent.active
      }
      MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.selected(parent.index) }
    }
  }
}
```

- [ ] **Step 3: Tab page stubs (replaced in Tasks 10–11) and the Status tab**

Create `components/KeysTab.qml`, `components/VoiceTab.qml`, `components/SetupTab.qml` with this body (change the header comment and the placeholder text per file):

```qml
// Spec §6.2 tab 2 — Keys (implemented in Task 10).
import QtQuick
import qs.Commons

Item {
  id: root
  property var service: null
  property QtObject bar: null
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int cursor: -1
  readonly property int rowCount: 0
  property bool editing: false
  function moveCursor(dy) {}
  function activate() {}
  function onShown() {}
  implicitHeight: placeholder.implicitHeight
  Text { id: placeholder; textFormat: Text.PlainText; text: "Keys — coming in Task 10"; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body }
}
```

Create `components/StatusTab.qml`:

```qml
// Spec §6.2 tab 1 — Status: remote / ATVVoice state and node, Voxtype status, today's stats, "Test mic (3 s)" button.
import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Presentation.mjs" as Presentation

Item {
  id: root
  property var service: null
  property QtObject bar: null
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int cursor: -1
  readonly property int rowCount: 1                   // the mic-test button is the only activatable row
  property bool editing: false
  property int micTestLeft: 0
  function moveCursor(dy) { cursor = cursor < 0 ? 0 : Math.max(0, Math.min(rowCount - 1, cursor + dy)) }
  function activate() { if (cursor === 0) root.micTest() }
  function onShown() { cursor = -1 }
  function micTest() {                                  // §6.2: 3 s MicToggle round trip through the same voice rules
    if (!service || micTestLeft > 0) return
    if (service.micToggle() !== "ok") return
    micTestLeft = 3
    micTimer.restart()
  }
  Timer { id: micTimer; interval: 1000; repeat: true; onTriggered: { root.micTestLeft--; if (root.micTestLeft <= 0) { micTimer.stop(); if (root.service) root.service.micToggle() } } }

  readonly property var s: service
  readonly property var rows: !s ? [] : [
    ["Voice", s.voiceState + (s.voiceOwner ? " · " + s.voiceOwner + (s.voiceInferred ? " (inferred)" : "") : "") + (s.voiceState === "recording" ? " · " + Presentation.elapsedText(s.elapsedMs) : "")],
    ["Voxtype", s.backendClass + (s.unconfiguredReason ? " · " + s.unconfiguredReason : "")],
    ["Remote", s.remoteState + (s.atvBusName ? " · " + s.atvBusName : "") + (s.remoteNode ? " · " + s.remoteNode : "")],
    ["Mic mode", s.config ? s.config.voice.mic + (s.remoteWarning ? " · remote mic: " + (s.remoteState === "absent" ? "ATVVoice missing" : s.remoteState === "disconnected" ? "disconnected" : "device mismatch") : "") : ""],
    ["Last capture", s.lastCapture ? s.lastCapture.node + " · " + s.lastCapture.mode + " · " + Qt.formatTime(new Date(s.lastCapture.at), "HH:mm") : "not yet verified"],
    ["Today", s.statsSummary.today.count + " sessions · " + Math.round(s.statsSummary.today.seconds) + " s"],
    ["Errors", String(s.errorCount) + (s.lastError ? " · " + s.lastError : "")]
  ]

  implicitHeight: column.implicitHeight
  Column {
    id: column
    width: parent.width
    spacing: Style.space(6)
    Repeater {
      model: root.rows
      Row {
        required property var modelData
        width: column.width
        spacing: Style.space(8)
        Text { textFormat: Text.PlainText; text: parent.modelData[0]; width: Style.space(96); color: Qt.darker(root.fg, 1.3); font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall }
        Text { textFormat: Text.PlainText; text: parent.modelData[1]; width: parent.width - Style.space(104); wrapMode: Text.WordWrap; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall }
      }
    }
    Button {
      text: root.micTestLeft > 0 ? "Testing mic… " + root.micTestLeft : "Test mic (3 s)"
      foreground: root.fg
      hasCursor: root.cursor === 0
      enabled: root.service && !root.service.micPending && !root.service.selftestActive && root.service.voiceState !== "recovering"
      onClicked: root.micTest()
    }
  }
}
```

- [ ] **Step 4: Panel.qml**

Create `Panel.qml`:

```qml
// Spec §6.2: KeyboardPanel with four tabs (Status, Keys, Voice, Setup), fully keyboard-navigable: ←/→ or 1–4 switch tabs,
// ↑/↓ move the row cursor, Enter activates, Esc closes; the Service owns the only "omaremote" IpcHandler (manageIpc: false).
import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "components"

Panel {
  id: root
  moduleName: "io.github.kehao-chen.omaremote"
  ipcTarget: ""
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var service: null
  readonly property var barIdentity: hostWidget || root
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  property int tabIndex: 0
  readonly property var pages: [statusTab, keysTab, voiceTab, setupTab]
  readonly property var currentTab: pages[tabIndex]
  readonly property bool editing: currentTab ? currentTab.editing : false

  function open() { setCenterHoverRevealSuppressed(false); root.controller.show(); currentTab.onShown(); if (service) service.refreshDoctor() }
  function openFromHotkey() { open(); Qt.callLater(function() { if (root.opened) setCenterHoverRevealSuppressed(true) }) }
  function close() { setCenterHoverRevealSuppressed(false); root.controller.hide() }
  function toggle() { if (root.opened) root.close(); else root.openFromHotkey() }
  function switchPanel(direction) { return root.bar && typeof root.bar.switchPanelFrom === "function" ? root.bar.switchPanelFrom(root.barIdentity, direction) : false }
  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function") root.bar.setCenterHoverRevealSuppressed(value)
  }
  function selectTab(i) { tabIndex = Math.max(0, Math.min(3, i)); currentTab.onShown() }
  function switchTab(dx) { selectTab((tabIndex + dx + 4) % 4) }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.editing
      onMoveRequested: function(dx, dy) { if (dx !== 0) root.switchTab(dx); else root.currentTab.moveCursor(dy) }
      onActivateRequested: root.currentTab.activate()
      onReturnRequested: root.currentTab.activate()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        var n = parseInt(t, 10)
        if (n >= 1 && n <= 4) root.selectTab(n - 1)
        else if (t === "r" && root.service) root.service.refreshDoctor()
      }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: "OmaRemote"
          meta: root.service ? (root.service.voiceState + (root.service.remoteWarning ? " · remote mic not ready" : "")).toUpperCase() : "SERVICE NOT LOADED"
          foreground: root.contentForeground
          fontFamily: root.contentFontFamily
          iconComponent: Component { Text { textFormat: Text.PlainText; text: "󰍬"; color: root.contentForeground; font.family: root.contentFontFamily; font.pixelSize: Style.font.display } }
        }
        TabBar {
          id: tabs
          current: root.tabIndex
          fg: root.contentForeground
          fontFamily: root.contentFontFamily
          onSelected: function(i) { root.selectTab(i) }
        }
        PanelSeparator { foreground: root.contentForeground }
        Item {
          width: parent.width
          implicitHeight: root.currentTab ? root.currentTab.implicitHeight : 0
          StatusTab { id: statusTab; width: parent.width; visible: root.tabIndex === 0; service: root.service; bar: root.bar; fg: root.contentForeground; fontFamily: root.contentFontFamily }
          KeysTab   { id: keysTab;   width: parent.width; visible: root.tabIndex === 1; service: root.service; bar: root.bar; fg: root.contentForeground; fontFamily: root.contentFontFamily }
          VoiceTab  { id: voiceTab;  width: parent.width; visible: root.tabIndex === 2; service: root.service; bar: root.bar; fg: root.contentForeground; fontFamily: root.contentFontFamily }
          SetupTab  { id: setupTab;  width: parent.width; visible: root.tabIndex === 3; service: root.service; bar: root.bar; fg: root.contentForeground; fontFamily: root.contentFontFamily }
        }
        Text {
          textFormat: Text.PlainText
          text: "←→ tabs · ↑↓ rows · Enter · Esc · r refresh"
          color: Qt.darker(root.contentForeground, 1.6)
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
```

- [ ] **Step 5: Lint, validate, install, look**

Run: `make lint` → clean (fix any `unqualified access` warnings by prefixing `root.`/`parent.`). Then `make dev-install` (widget/Panel hot-reload; the Service is unchanged since Task 8 so no restart is needed — if the Service was never restarted after Task 8, run `make dev-restart`).
Expected on the bar: the glyph shows in the right section; hovering shows the tooltip; left click opens the panel with four tabs, `1`–`4` and ←/→ switch tabs, Esc closes; middle click toggles the remote mic (or does nothing when ATVVoice is absent); `omarchy-shell omaremote status | jq .voice.state` still answers.

- [ ] **Step 6: Commit**

```bash
git add BarWidget.qml Panel.qml components/TabBar.qml components/StatusTab.qml components/KeysTab.qml components/VoiceTab.qml components/SetupTab.qml
git commit -m "feat(ui): bar glyph by state, tabbed keyboard panel, status tab"
```

---

### Task 10: Keys tab — rows, action editor with key capture, timing editor, reset to defaults

**Files:**
- Replace: `components/KeysTab.qml`
- Create: `components/KeyRow.qml`, `components/ActionEditor.qml`, `components/TimingEditor.qml`
- Modify: `Service.qml` (expose config writers)

**Interfaces:**
- Consumes: `ConfigStore.setKey(name, fields)`, `setTiming(t)`, `resetKeys()` (exposed through Service functions added here), `lib/Presentation.mjs` (`keyLabel`, `keysFromQtEvent`), `lib/Actions.mjs` (`describe`, `validateAction`, `ACTION_TYPES`), `lib/Defaults.mjs` (`KEY_NAMES`), `lib/Config.mjs` (`keyClass`).
- Produces: Service functions `setKeyField(name, fields)`, `setTiming(t)`, `resetKeys()`; `ActionEditor { open(keyName, trigger, action); signal saved(keyName, trigger, action|null); signal cancelled() }`; `TimingEditor { open(timing); signal saved(timing) }`.

- [ ] **Step 1: Service writers**

Add to `Service.qml` before `// ---- IPC`:

```qml
  // ---- config writers for the Panel (§6.2: BarWidget/Panel write config only through the Service) ----
  function setKeyField(name, fields) { configStore.setKey(name, fields) }
  function setTiming(t) { configStore.setTiming(t) }
  function resetKeys() { configStore.resetKeys() }
  function setVoiceField(field, value) { configStore.setVoiceField(field, value) }
```

- [ ] **Step 2: KeyRow**

Create `components/KeyRow.qml`:

```qml
// Spec §6.2 tab 2: one row — key · tap · hold · double · repeat☐ (greyed when supported: false; panic keys show "panic" instead of hold).
import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Presentation.mjs" as Presentation
import "../lib/Actions.mjs" as Actions

Item {
  id: root
  property string keyName: ""
  property var keyConfig: ({})
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property bool hasCursor: false
  property int column: 0                       // 0 tap, 1 hold, 2 double, 3 repeat (cursor column)
  signal editRequested(string trigger)
  signal repeatToggled()
  readonly property bool supported: keyConfig.supported !== false
  readonly property bool panic: keyConfig.panic === true
  readonly property bool isMic: keyName === "mic"
  function cell(trigger) { var a = keyConfig[trigger]; return a ? Actions.describe(a) : "—" }

  implicitHeight: Style.space(26)
  Rectangle { anchors.fill: parent; radius: Style.cornerRadius; color: root.hasCursor ? Style.selectedFillFor(root.fg, Color.accent) : "transparent" }
  Row {
    anchors.fill: parent
    anchors.leftMargin: Style.space(6)
    spacing: Style.space(6)
    opacity: root.supported ? 1.0 : 0.4
    Text { width: Style.space(58); textFormat: Text.PlainText; text: Presentation.keyLabel(root.keyName); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall; font.bold: true; anchors.verticalCenter: parent.verticalCenter }
    Repeater {
      model: root.isMic ? [] : ["tap", "hold", "double"]
      Rectangle {
        required property int index
        required property string modelData
        width: Style.space(96); height: Style.space(22)
        radius: Style.cornerRadius
        color: root.hasCursor && root.column === index ? Style.selectedFillFor(root.fg, Color.accent) : "transparent"
        border.width: root.hasCursor && root.column === index ? 1 : 0
        border.color: Color.accent
        anchors.verticalCenter: parent.verticalCenter
        Text {
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: parent.modelData === "hold" && root.panic ? "panic (" + root.cell("tap") + " <1.5 s)" : root.cell(parent.modelData)
          elide: Text.ElideRight
          width: parent.width - Style.space(8)
          horizontalAlignment: Text.AlignHCenter
          color: root.fg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
        MouseArea { anchors.fill: parent; enabled: root.supported && !(parent.modelData === "hold" && root.panic); cursorShape: Qt.PointingHandCursor; onClicked: root.editRequested(parent.modelData) }
      }
    }
    Text { visible: root.isMic; textFormat: Text.PlainText; text: root.keyConfig.ptt !== false ? "push-to-talk" : "ptt off"; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
    ToggleSwitch {
      visible: !root.isMic
      checked: root.keyConfig.repeat === true
      interactive: root.supported && !root.panic          // §4.2: panic excludes hold/repeat
      hasCursor: root.hasCursor && root.column === 3
      foreground: root.fg
      anchors.verticalCenter: parent.verticalCenter
      onToggled: root.repeatToggled()
    }
  }
}
```

- [ ] **Step 3: ActionEditor**

Create `components/ActionEditor.qml`:

```qml
// Spec §6.2 tab 2: popover editing one action — type combo + type-specific fields; `key` has a "press a key to capture" mode.
// Lives inside the KeyboardPanel content so it keeps the panel's keyboard focus (the PanelKeyCatcher is blocked while open).
import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Actions.mjs" as Actions
import "../lib/Presentation.mjs" as Presentation

Rectangle {
  id: root
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property string keyName: ""
  property string trigger: ""
  property string type: "none"
  property string keys: ""
  property string dispatcher: ""
  property string arg: ""
  property string delta: "+5"
  property string media: "play-pause"
  property string screen: "off"
  property bool capturing: false
  property string error: ""
  signal saved(string keyName, string trigger, var action)     // action null = unbind
  signal cancelled()

  function open(keyName, trigger, action) {
    root.keyName = keyName; root.trigger = trigger; root.error = ""; root.capturing = false
    var a = action || { type: "none" }
    root.type = a.type; root.keys = a.keys || ""; root.dispatcher = a.dispatcher || ""; root.arg = a.arg || ""
    root.delta = a.delta || "+5"; root.media = a.cmd && a.type === "media" ? a.cmd : "play-pause"; root.screen = a.cmd && a.type === "screen" ? a.cmd : "off"
    root.visible = true
    captureArea.forceActiveFocus()
  }
  function build() {
    switch (root.type) {
      case "key": return { type: "key", keys: root.keys.trim() }
      case "dispatch": return { type: "dispatch", dispatcher: root.dispatcher.trim(), arg: root.arg.trim() }
      case "volume": return { type: "volume", delta: root.delta }
      case "media": return { type: "media", cmd: root.media }
      case "screen": return { type: "screen", cmd: root.screen }
      default: return null
    }
  }
  function save() {
    var a = root.build()
    if (a) { var errs = Actions.validateAction(a); if (errs.length) { root.error = errs.join("; "); return } }
    root.visible = false
    root.saved(root.keyName, root.trigger, a)
  }
  function cancel() { root.visible = false; root.cancelled() }

  visible: false
  radius: Style.cornerRadius
  color: Color.popups.background
  border.color: Color.popups.border
  border.width: 1
  implicitHeight: body.implicitHeight + Style.space(24)

  Item {                                                       // key capture target (§6.2 "press a key to capture")
    id: captureArea
    anchors.fill: parent
    focus: true
    Keys.onPressed: function(event) {
      if (event.key === Qt.Key_Escape) { if (root.capturing) root.capturing = false; else root.cancel(); event.accepted = true; return }
      if (root.capturing) {
        var k = Presentation.keysFromQtEvent(event.key, event.modifiers, event.text)
        if (k) { root.keys = k; root.capturing = false }
        event.accepted = true; return
      }
      if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !keysField.activeFocus && !dispField.activeFocus && !argField.activeFocus) { root.save(); event.accepted = true }
    }
  }

  Column {
    id: body
    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
    anchors.margins: Style.space(12)
    spacing: Style.space(8)
    Text { textFormat: Text.PlainText; text: Presentation.keyLabel(root.keyName) + " · " + root.trigger; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle; font.bold: true }
    Dropdown {
      label: "Type"
      value: root.type
      options: Actions.ACTION_TYPES
      foreground: root.fg
      fontFamily: root.fontFamily
      onChanged: function(v) { root.type = v; root.error = "" }
    }
    Row {
      visible: root.type === "key"
      spacing: Style.space(6)
      TextField { id: keysField; width: Style.space(200); text: root.keys; placeholderText: "ctrl+shift+Return"; foreground: root.fg; onTextEdited: root.keys = text }
      Button { text: root.capturing ? "press a key…" : "Capture"; foreground: root.fg; selected: root.capturing; onClicked: { root.capturing = !root.capturing; captureArea.forceActiveFocus() } }
    }
    Row {
      visible: root.type === "dispatch"
      spacing: Style.space(6)
      TextField { id: dispField; width: Style.space(120); text: root.dispatcher; placeholderText: "dispatcher"; foreground: root.fg; onTextEdited: root.dispatcher = text }
      TextField { id: argField; width: Style.space(160); text: root.arg; placeholderText: "arg"; foreground: root.fg; onTextEdited: root.arg = text }
    }
    Dropdown { visible: root.type === "volume"; label: "Delta"; value: root.delta; options: ["+5", "-5", "mute"]; foreground: root.fg; fontFamily: root.fontFamily; onChanged: function(v) { root.delta = v } }
    Dropdown { visible: root.type === "media"; label: "Command"; value: root.media; options: ["play-pause", "next", "previous"]; foreground: root.fg; fontFamily: root.fontFamily; onChanged: function(v) { root.media = v } }
    Dropdown { visible: root.type === "screen"; label: "Command"; value: root.screen; options: ["off", "lock"]; foreground: root.fg; fontFamily: root.fontFamily; onChanged: function(v) { root.screen = v } }
    Text { visible: root.error !== ""; textFormat: Text.PlainText; text: root.error; color: Color.urgent; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
    Row {
      spacing: Style.space(6)
      Button { text: "Save"; foreground: root.fg; onClicked: root.save() }
      Button { text: "Unbind"; foreground: root.fg; onClicked: { root.type = "none"; root.save() } }
      Button { text: "Cancel"; foreground: root.fg; onClicked: root.cancel() }
    }
  }
}
```

If `TextField` from `qs.Ui` has no `placeholderText`/`onTextEdited` (check `/usr/share/omarchy/shell/Ui/TextField.qml`), use the property/signal it does expose (it wraps a `TextInput`; `text` and `textChanged` always exist).

- [ ] **Step 4: TimingEditor**

Create `components/TimingEditor.qml`:

```qml
// Spec §6.2 tab 2 footer "Timing…": holdMs / doubleMs / repeatMs (panicMs stays at its §4.2 default; the escape hatch is not tunable here).
import QtQuick
import qs.Commons
import qs.Ui

Rectangle {
  id: root
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int holdMs: 350
  property int doubleMs: 250
  property int repeatMs: 80
  property int panicMs: 1500
  signal saved(var timing)
  signal cancelled()
  function open(t) { holdMs = t.holdMs; doubleMs = t.doubleMs; repeatMs = t.repeatMs; panicMs = t.panicMs; visible = true; focusItem.forceActiveFocus() }

  visible: false
  radius: Style.cornerRadius
  color: Color.popups.background
  border.color: Color.popups.border
  border.width: 1
  implicitHeight: body.implicitHeight + Style.space(24)
  Item { id: focusItem; anchors.fill: parent; focus: true; Keys.onEscapePressed: { root.visible = false; root.cancelled() } }
  Column {
    id: body
    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
    anchors.margins: Style.space(12)
    spacing: Style.space(8)
    Text { textFormat: Text.PlainText; text: "Timing (ms)"; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle; font.bold: true }
    NumberField { label: "holdMs"; value: root.holdMs; from: 100; to: 2000; stepSize: 10; foreground: root.fg; fontFamily: root.fontFamily; onModified: function(v) { root.holdMs = v } }
    NumberField { label: "doubleMs"; value: root.doubleMs; from: 100; to: 1000; stepSize: 10; foreground: root.fg; fontFamily: root.fontFamily; onModified: function(v) { root.doubleMs = v } }
    NumberField { label: "repeatMs"; value: root.repeatMs; from: 20; to: 500; stepSize: 5; foreground: root.fg; fontFamily: root.fontFamily; onModified: function(v) { root.repeatMs = v } }
    Row {
      spacing: Style.space(6)
      Button { text: "Save"; foreground: root.fg; onClicked: { root.visible = false; root.saved({ holdMs: root.holdMs, doubleMs: root.doubleMs, repeatMs: root.repeatMs, panicMs: root.panicMs }) } }
      Button { text: "Cancel"; foreground: root.fg; onClicked: { root.visible = false; root.cancelled() } }
    }
  }
}
```

- [ ] **Step 5: KeysTab**

Replace `components/KeysTab.qml`:

```qml
// Spec §6.2 tab 2 — Keys: 13 rows (key · tap · hold · double · repeat☐), editor popover, footer "Reset to defaults" and "Timing…".
// Writes go through the Service (§2); the engine hot-reloads on the ConfigStore change signal (§6.2).
import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Defaults.mjs" as Defaults

Item {
  id: root
  property var service: null
  property QtObject bar: null
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int cursor: -1
  property int column: 0
  readonly property int rowCount: Defaults.KEY_NAMES.length + 2       // rows + "Reset to defaults" + "Timing…"
  readonly property bool editing: editor.visible || timing.visible
  readonly property var keys: service && service.config ? service.config.keys : ({})
  readonly property var problems: service ? service.configProblems : []

  function onShown() { cursor = -1; column = 0 }
  function moveCursor(dy) { cursor = cursor < 0 ? 0 : Math.max(0, Math.min(rowCount - 1, cursor + dy)) }
  function moveColumn(dx) { column = Math.max(0, Math.min(3, column + dx)) }
  function activate() {
    if (cursor < 0) return
    if (cursor === Defaults.KEY_NAMES.length) { if (service) service.resetKeys(); return }
    if (cursor === Defaults.KEY_NAMES.length + 1) { timing.open(service.config.timing); return }
    var name = Defaults.KEY_NAMES[cursor]
    if (name === "mic") return
    if (column === 3) root.toggleRepeat(name)
    else root.edit(name, ["tap", "hold", "double"][column])
  }
  function edit(name, trigger) { if (!service || keys[name].supported === false) return; editor.open(name, trigger, keys[name][trigger] || null) }
  function toggleRepeat(name) {
    if (!service || keys[name].panic) return
    service.setKeyField(name, { repeat: !keys[name].repeat })
  }

  implicitHeight: column_.implicitHeight
  Column {
    id: column_
    width: parent.width
    spacing: Style.space(2)
    Repeater {
      model: Defaults.KEY_NAMES
      KeyRow {
        required property int index
        required property string modelData
        width: column_.width
        keyName: modelData
        keyConfig: root.keys[modelData] || ({})
        fg: root.fg
        fontFamily: root.fontFamily
        hasCursor: root.cursor === index
        column: root.column
        onEditRequested: function(trigger) { root.edit(modelData, trigger) }
        onRepeatToggled: root.toggleRepeat(modelData)
      }
    }
    Text {
      visible: root.problems.length > 0
      textFormat: Text.PlainText
      width: parent.width
      wrapMode: Text.WordWrap
      text: root.problems.map(function(p) { return p.message }).join("\n")
      color: Color.urgent
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
    Row {
      spacing: Style.space(6)
      Button { text: "Reset to defaults"; foreground: root.fg; hasCursor: root.cursor === Defaults.KEY_NAMES.length; onClicked: if (root.service) root.service.resetKeys() }
      Button { text: "Timing…"; foreground: root.fg; hasCursor: root.cursor === Defaults.KEY_NAMES.length + 1; onClicked: timing.open(root.service.config.timing) }
    }
    ActionEditor {
      id: editor
      width: parent.width
      fg: root.fg
      fontFamily: root.fontFamily
      onSaved: function(keyName, trigger, action) { var f = ({}); f[trigger] = action === null ? undefined : action; root.service.setKeyField(keyName, f) }
    }
    TimingEditor {
      id: timing
      width: parent.width
      fg: root.fg
      fontFamily: root.fontFamily
      onSaved: function(t) { root.service.setTiming(t) }
    }
  }
}
```

In `Panel.qml`, extend the key catcher so ←/→ move the column when the Keys tab has a cursor: change `onMoveRequested` to
```qml
      onMoveRequested: function(dx, dy) {
        if (dx !== 0 && root.tabIndex === 1 && keysTab.cursor >= 0 && keysTab.cursor < 13) keysTab.moveColumn(dx)
        else if (dx !== 0) root.switchTab(dx)
        else root.currentTab.moveCursor(dy)
      }
```

- [ ] **Step 6: Lint, install, verify by hand and by IPC**

Run: `make lint` → clean; `make dev-install`.
Check in the panel: Keys tab lists 13 rows; `ok` row shows `Return · Ctrl+C · —`; `menu` shows `panic (Tab <1.5 s)`; toggling `repeat` on `back` writes `~/.config/omaremote/config.json` (`jq .keys.back.repeat` → `true`) and `omarchy-shell omaremote status | jq .heldKeys` still answers; editing `ok · double` → Capture → press `ctrl+d` → Save → `jq .keys.ok.double ~/.config/omaremote/config.json` → `{"type":"key","keys":"ctrl+d"}`; Timing… → holdMs 400 → Save → `omarchy-shell omaremote status | jq .timing.holdMs` → `400`; "Reset to defaults" restores `ok.double` to absent and keeps `supported:false` keys greyed.

- [ ] **Step 7: Commit**

```bash
git add Service.qml Panel.qml components/KeysTab.qml components/KeyRow.qml components/ActionEditor.qml components/TimingEditor.qml
git commit -m "feat(ui): keys tab with action editor, key capture, timing editor and reset"
```

---

### Task 11: Voice tab and Setup (Doctor) tab

**Files:**
- Replace: `components/VoiceTab.qml`, `components/SetupTab.qml`
- Create: `components/DoctorRow.qml`

**Interfaces:**
- Consumes: Service `ipcMic(mode)` (returns JSON string), `micStatusOf(id)`, `micPending`, `micCurrentId`, `micLast`, `micConflict`, `statsSummary`, `voiceState`, `voiceOwner`, `voiceInferred`, `atvBusName`, `remoteState`, `setVoiceField(field, value)`, `doctorRows`, `doctorSummary`, `doctorAt`, `refreshDoctor()`, `pluginDir`, `config`; `lib/Presentation.mjs` (`micStatusLine`).
- Produces: `DoctorRow { row, fg, fontFamily, hasCursor; signal copyRequested(string text) }`.

- [ ] **Step 1: VoiceTab**

Replace `components/VoiceTab.qml`:

```qml
// Spec §6.2 tab 3 — Voice: active sources, current owner (inferred label), maxSessionSec, HUD/action-flash toggles,
// Voxtype mic Remote/System switch (§3 transaction: active and requested modes shown separately, second request disabled,
// terminal error/rollback shown), detailed stats.
import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Presentation.mjs" as Presentation

Item {
  id: root
  property var service: null
  property QtObject bar: null
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int cursor: -1
  readonly property int rowCount: 4                    // mic switch, HUD toggle, flash toggle, maxSessionSec (+/- via ←/→ not needed: Enter cycles 30/60/120)
  property bool editing: false
  property string requestedMode: ""
  property string lastError: ""
  readonly property var s: service
  readonly property var cfg: s && s.config ? s.config : null
  readonly property var current: s && s.micCurrentId ? s.micStatusOf(s.micCurrentId) : null

  function onShown() { cursor = -1 }
  function moveCursor(dy) { cursor = cursor < 0 ? 0 : Math.max(0, Math.min(rowCount - 1, cursor + dy)) }
  function activate() {
    if (!cfg) return
    if (cursor === 0) root.requestMic(cfg.voice.mic === "remote" ? "system" : "remote")
    else if (cursor === 1) s.setVoiceField("hud", !cfg.voice.hud)
    else if (cursor === 2) s.setVoiceField("actionFlash", !cfg.voice.actionFlash)
    else if (cursor === 3) s.setVoiceField("maxSessionSec", cfg.voice.maxSessionSec >= 120 ? 30 : cfg.voice.maxSessionSec >= 60 ? 120 : 60)
  }
  function requestMic(mode) {                           // §3: returns immediately; the Service polls micStatus internally
    if (!s || s.micPending) return
    var r = JSON.parse(s.ipcMic(mode))
    root.requestedMode = r.ok ? mode : ""
    root.lastError = r.ok ? "" : r.reason
  }

  implicitHeight: column.implicitHeight
  Column {
    id: column
    width: parent.width
    spacing: Style.space(8)

    PanelSectionHeader { text: "Microphone"; foreground: root.fg; fontFamily: root.fontFamily }
    Row {
      spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Voxtype mic: " + (root.cfg ? root.cfg.voice.mic : "?"); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      Button { text: "Remote"; selected: root.cfg && root.cfg.voice.mic === "remote"; hasCursor: root.cursor === 0; foreground: root.fg; enabled: root.s && !root.s.micPending; onClicked: root.requestMic("remote") }
      Button { text: "System default"; selected: root.cfg && root.cfg.voice.mic === "system"; hasCursor: root.cursor === 0; foreground: root.fg; enabled: root.s && !root.s.micPending; onClicked: root.requestMic("system") }
    }
    Text {
      textFormat: Text.PlainText
      width: parent.width; wrapMode: Text.WordWrap
      visible: text !== ""
      text: {
        if (!root.s) return ""
        if (root.s.micPending && root.current) return "requested: " + root.requestedMode + " · " + Presentation.micStatusLine(root.current) + " — changing microphones restarts Voxtype; leave F9 alone until it finishes"
        if (root.lastError) return "request refused: " + root.lastError
        if (root.s.micLast && root.s.micLast.state === "failed") return "last change failed: " + Presentation.micStatusLine(root.s.micLast)
        if (root.s.micConflict) return "conflict: Voxtype audio.device is " + root.s.micConflict.found + " (expected " + root.s.micConflict.expected + ") — reconcile in Setup"
        return ""
      }
      color: root.s && root.s.micLast && root.s.micLast.state === "failed" ? Color.urgent : Qt.darker(root.fg, 1.3)
      font.family: root.fontFamily; font.pixelSize: Style.font.caption
    }

    PanelSectionHeader { text: "Sources"; foreground: root.fg; fontFamily: root.fontFamily }
    Text {
      textFormat: Text.PlainText; width: parent.width; wrapMode: Text.WordWrap
      text: !root.s ? "" :
        "remote button (D-Bus): " + (root.s.atvBusName ? (root.s.remoteWarning ? "disabled — remote mic not ready" : "active · " + root.s.remoteState) : "ATVVoice not on the bus") +
        "\nHID mic key: " + (root.cfg && root.cfg.keys.mic.supported !== false && root.cfg.keys.mic.ptt !== false ? "push-to-talk" : "not available") +
        "\nkeyboard (F9): observed" +
        (root.s.voiceState !== "idle" ? "\ncurrent session: " + root.s.voiceState + " · owner " + root.s.voiceOwner + (root.s.voiceInferred ? " (inferred attribution)" : "") : "")
      color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall
    }

    PanelSectionHeader { text: "Options"; foreground: root.fg; fontFamily: root.fontFamily }
    Row { spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "HUD"; width: Style.space(120); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      ToggleSwitch { checked: root.cfg ? root.cfg.voice.hud : true; hasCursor: root.cursor === 1; foreground: root.fg; onToggled: root.s.setVoiceField("hud", !root.cfg.voice.hud) }
    }
    Row { spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Action flash"; width: Style.space(120); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      ToggleSwitch { checked: root.cfg ? root.cfg.voice.actionFlash : true; hasCursor: root.cursor === 2; foreground: root.fg; onToggled: root.s.setVoiceField("actionFlash", !root.cfg.voice.actionFlash) }
    }
    Row { spacing: Style.space(8)
      Text { textFormat: Text.PlainText; text: "Max session (s)"; width: Style.space(120); color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
      NumberField { value: root.cfg ? root.cfg.voice.maxSessionSec : 60; from: 5; to: 600; stepSize: 5; hasCursor: root.cursor === 3; foreground: root.fg; fontFamily: root.fontFamily; onModified: function(v) { root.s.setVoiceField("maxSessionSec", v) } }
    }

    PanelSectionHeader { text: "Stats"; foreground: root.fg; fontFamily: root.fontFamily }
    Text {
      textFormat: Text.PlainText; width: parent.width
      text: !root.s ? "" :
        "today " + root.s.statsSummary.today.count + " · " + Math.round(root.s.statsSummary.today.seconds) + " s\n" +
        "this week " + root.s.statsSummary.week.count + " · " + Math.round(root.s.statsSummary.week.seconds) + " s\n" +
        "all time " + root.s.statsSummary.all.count + " · " + Math.round(root.s.statsSummary.all.seconds) + " s" +
        (root.s.statsSummary.longest ? "\nlongest " + Math.round(root.s.statsSummary.longest.durationSec) + " s" : "")
      color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall
    }
  }
}
```

- [ ] **Step 2: DoctorRow and SetupTab**

Create `components/DoctorRow.qml`:

```qml
// Spec §6.2 tab 4: one checklist row — status glyph, label (with the mode it applies to), detail, fix command + Copy.
import QtQuick
import qs.Commons
import qs.Ui

Item {
  id: root
  property var row: ({})
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property bool hasCursor: false
  signal copyRequested(string text)
  readonly property string glyph: ({ pass: "", warn: "", fail: "", unknown: "", info: "" })[row.status] || ""
  readonly property color glyphColor: row.status === "pass" ? root.fg : row.status === "fail" ? Color.urgent : row.status === "warn" ? "#e5c07b" : Qt.darker(root.fg, 1.5)

  implicitHeight: body.implicitHeight + Style.space(6)
  Rectangle { anchors.fill: parent; radius: Style.cornerRadius; color: root.hasCursor ? Style.selectedFillFor(root.fg, Color.accent) : "transparent" }
  Row {
    id: body
    anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.space(6)
    spacing: Style.space(8)
    Text { textFormat: Text.PlainText; text: root.glyph; color: root.glyphColor; font.family: root.fontFamily; font.pixelSize: Style.font.body; width: Style.space(18) }
    Column {
      width: parent.width - Style.space(26) - (copyBtn.visible ? copyBtn.width + Style.space(8) : 0)
      spacing: Style.space(1)
      Text { textFormat: Text.PlainText; width: parent.width; elide: Text.ElideRight; text: root.row.label + " [" + (root.row.modes || []).join("/") + "]"; color: root.fg; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall }
      Text { visible: text !== ""; textFormat: Text.PlainText; width: parent.width; wrapMode: Text.WordWrap; text: root.row.detail || ""; color: Qt.darker(root.fg, 1.3); font.family: root.fontFamily; font.pixelSize: Style.font.caption }
      Text { visible: text !== "" && root.row.status !== "pass"; textFormat: Text.PlainText; width: parent.width; elide: Text.ElideMiddle; text: root.row.fix || ""; color: Qt.darker(root.fg, 1.2); font.family: "monospace"; font.pixelSize: Style.font.caption }
    }
    Button { id: copyBtn; visible: !!root.row.fix && root.row.status !== "pass"; text: "Copy"; foreground: root.fg; onClicked: root.copyRequested(root.row.fix) }
  }
}
```

Replace `components/SetupTab.qml`:

```qml
// Spec §6.2 tab 4 — Setup (Doctor): rows from lib/Doctor.mjs (same rules as host/omaremote-setup --doctor), Copy per fix,
// header "Copy full setup command" → `bash <plugin-dir>/host/omaremote-setup`. The panel never installs anything.
import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

Item {
  id: root
  property var service: null
  property QtObject bar: null
  property color fg: Color.foreground
  property string fontFamily: Style.font.family
  property int cursor: -1
  readonly property var rows: service ? service.doctorRows : []
  readonly property int rowCount: rows.length + 1                  // + header button
  property bool editing: false
  property string copied: ""
  function onShown() { cursor = -1; if (service) service.refreshDoctor() }
  function moveCursor(dy) { cursor = cursor < 0 ? 0 : Math.max(0, Math.min(rowCount - 1, cursor + dy)) }
  function activate() {
    if (cursor === 0) root.copy(root.setupCommand)
    else if (cursor > 0 && rows[cursor - 1] && rows[cursor - 1].fix) root.copy(rows[cursor - 1].fix)
  }
  readonly property string setupCommand: service ? "bash " + service.pluginDir + "/host/omaremote-setup" : ""
  function copy(text) {                                             // wl-copy is what Omarchy's own panels use for clipboard writes
    Quickshell.execDetached(["wl-copy", "--", text])
    root.copied = text
    copiedTimer.restart()
  }
  Timer { id: copiedTimer; interval: 1500; repeat: false; onTriggered: root.copied = "" }

  implicitHeight: column.implicitHeight
  Column {
    id: column
    width: parent.width
    spacing: Style.space(4)
    Row {
      spacing: Style.space(8)
      Button { text: "Copy full setup command"; hasCursor: root.cursor === 0; foreground: root.fg; onClicked: root.copy(root.setupCommand) }
      Text { textFormat: Text.PlainText; text: root.service ? root.service.doctorSummary + (root.service.doctorAt ? " · " + Qt.formatTime(new Date(root.service.doctorAt), "HH:mm:ss") : "") : ""; color: Qt.darker(root.fg, 1.3); font.family: root.fontFamily; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
      Text { visible: root.copied !== ""; textFormat: Text.PlainText; text: "copied"; color: Color.accent; font.family: root.fontFamily; font.pixelSize: Style.font.caption; anchors.verticalCenter: parent.verticalCenter }
    }
    Repeater {
      model: root.rows
      DoctorRow {
        required property int index
        required property var modelData
        width: column.width
        row: modelData
        fg: root.fg
        fontFamily: root.fontFamily
        hasCursor: root.cursor === index + 1
        onCopyRequested: function(text) { root.copy(text) }
      }
    }
  }
}
```

Check `wl-copy` is what the shell uses: `grep -rn "wl-copy" /usr/share/omarchy/shell/plugins | head -1`. If the shell uses `Quickshell.clipboardText` or another helper instead, use that.

- [ ] **Step 3: Lint, install, verify**

Run: `make lint` → clean; `make dev-install`.
Panel checks: Voice tab shows `Voxtype mic: remote`, the Remote/System buttons, source lines, HUD/flash toggles (toggling writes `voice.hud` in `config.json`, and the HUD disappears/reappears on the next voice event), stats. Clicking "System default" shows `requested: system · applying…` then `succeeded`; `omarchy-shell omaremote micStatus <id>` agrees; `voxtype config get audio.device` → `default`; switch back to Remote afterwards. Setup tab lists 15 rows with pass/fail glyphs and fix commands; Copy puts the command on the clipboard (`wl-paste`); `r` refreshes; the tooltip on the bar glyph lists failing rows when unconfigured.

- [ ] **Step 4: Commit**

```bash
git add components/VoiceTab.qml components/SetupTab.qml components/DoctorRow.qml
git commit -m "feat(ui): voice tab with mic-mode transaction status, setup/doctor tab"
```

---

### Task 12: `make check`, host-obligation audit, README, live smoke test

**Files:**
- Modify: `README.md`, `docs/superpowers/plans/2026-09-14-omaremote-core-lib-host-obligations.md` (append "satisfied by" column), `Makefile` (`check` includes `integration` when a Wayland session is present)

- [ ] **Step 1: Makefile `check`**

Change the `check` target to:
```make
check: test lint
	@if [ -n "$$WAYLAND_DISPLAY" ] && command -v qs >/dev/null 2>&1; then bash tests/fake-remote.sh; else echo "integration skipped (no Wayland session / quickshell)"; fi
```

Run: `make check` → `node --test` all pass, lint clean, integration all `ok`.

- [ ] **Step 2: Host-obligation audit**

Append to `docs/superpowers/plans/2026-09-14-omaremote-core-lib-host-obligations.md`:

```markdown

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
```

- [ ] **Step 3: README developer section**

Append to `README.md`:

```markdown
## Development

```bash
make test          # node --test (pure lib)
make lint          # qmllint + omarchy plugin validate
make integration   # second Quickshell instance + bash fakes; never touches the live shell or ~/.config/omaremote
make check         # all of the above
make dev-install   # rsync into ~/.config/omarchy/plugins/io.github.kehao-chen.omaremote and rescan
make dev-restart   # + omarchy-restart-shell (needed for Service.qml changes: keepLoaded services survive rescans)
```

IPC (`omarchy-shell omaremote …`): `ping`, `status`, `doctor`, `key <name> down|up`, `voice state <state>`, `voice poll -`, `reset`,
`mic remote|system`, `micStatus <id>`, `micToggle`, `selftestPing`, `selftestArm`, `selftestStatus|selftestReport|selftestDisarm <id>`.
```

- [ ] **Step 4: Live smoke (with the user's go-ahead)**

Run: `make dev-restart`, wait 3 s, then:
```bash
omarchy-shell omaremote ping                                   # ok
omarchy-shell omaremote status | jq '{voice: .voice.state, backend, remote: .remote.state, unconfigured, doctorSummary}'
omarchy-shell omaremote doctor | jq -r '.rows[] | "\(.status)\t\(.id)\t\(.detail)"'
omarchy-shell omaremote key ok down; sleep 0.5; omarchy-shell omaremote key ok up     # HUD flashes "OK · hold → Ctrl+C"; a terminal receives Ctrl+C
omarchy-shell omaremote reset                                  # HUD "Reset"; panel closes if open
```
Expected: `ping` → `ok`; `voice` `idle`; `backend` `idle` (Voxtype installed on this host); `doctor` rows reflect the real machine (keyd/binds fail until Plan 3 runs setup — that is correct); the HUD appears top-centre and fades; nothing crashes (`journalctl --user -u omarchy-shell` or the shell's stderr shows no `omaremote:` errors).

- [ ] **Step 5: Commit**

```bash
git add Makefile README.md docs/superpowers/plans/2026-09-14-omaremote-core-lib-host-obligations.md
git commit -m "chore(host): make check runs integration, host-obligation audit, README dev notes"
```

---

## Self-review notes (written with the plan)

- **Spec coverage:** §2 verification items → Task 0; §3 host contract (ATVVoice/Voxtype adapters, mic apply, systemd job contract, capture verification, plugin files) → Tasks 6–7; §4.1/4.3/4.4 → Task 5; §5 host obligations → Tasks 6–7; §5.4 degradation (backoff, unconfigured/remoteWarning) → Tasks 6, 8; §5.5 → Task 7; §6.1 → Task 9; §6.2 tabs → Tasks 9–11 (Status, Keys, Voice, Setup); §6.3 HUD → Task 6; §7 step 6 self-test → Task 8; §8 → ConfigStore/never-throw dispatch; §9 integration table → scenarios in Tasks 5–8; `make check` with qmllint + validate → Tasks 0, 12. Not in this plan (Plan 3): `host/omaremote-setup`, `docs/hw-checklist.md`, README zh-TW/English user docs.
- **Known deviations recorded:** IPC verbs `selftestPing/selftestArm/…` instead of `selftest ping|arm` (fixed arity); no `JsonAdapter` (unknown-field preservation); `OMAREMOTE_*` env overrides exist only for the harness; a hung `voxtype status` poll reports nothing (recovery times out into its bounded restart) while a prompt "no daemon" answer is `stopped` (§3).
- **Deferred to follow-ups (not blocking):** `heldKeys` after a self-test lease ends are quarantined by `engine.reset()` rather than per-key release tracking; the Keys tab has no per-key "supported" toggle (setup owns it, §7); doctor refresh is on demand (panel open, `r`, IPC) plus after mic apply, not periodic.
