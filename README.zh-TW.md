# OmaRemote

[English](README.md) · **繁體中文**

OmaRemote 是一個 [Omarchy](https://omarchy.org) 外掛，讓 ATVV 類型的藍牙語音遙控器變成沙發上的控制器：
按住麥克風鍵就能對目前的視窗語音輸入，其餘 12 個按鍵可以自訂成各種快捷操作。

開發與測試使用的是**小米藍牙語音遙控器（小米蓝牙语音遥控器，RC003，`2717:32b8`）**，設計上也涵蓋其他 ATVV
系列遙控器（例如 G20S Pro）。

<p align="center">
  <img src="docs/images/panel-status.png" width="420" alt="OmaRemote 面板的 Status 分頁">
</p>

## 功能

- **用遙控器語音輸入**：按住麥克風鍵說話，文字會輸入到目前的視窗。
  - **Voxtype** 引擎（預設）：透過 Omarchy 內建的 Voxtype，在本機用 Whisper 辨識。
  - **Typeless** 引擎（選用）：遙控器觸發 Typeless，由 Typeless 自己錄音、辨識和貼上。
- **兩種麥克風模式**
  - `remote`：用遙控器自己的麥克風，經由 [ATVVoice](https://github.com/b0o/ATVVoice) 透過藍牙傳送。
    按住說話，放開結束。
  - `system`：用電腦的麥克風。按一下麥克風鍵開始，再按一下停止。
- **13 鍵對應引擎**：每個按鍵都可以分別設定短按、長按、連按兩下和按住重複。
  動作可以是送出按鍵、執行 Hyprland dispatcher、調整音量、控制媒體播放（`playerctl`），或關閉、鎖定螢幕。
  按住 panic 鍵（預設是 Menu）可以把所有狀態重設。
- **Bar 圖示、面板和 HUD**：bar 上的圖示顯示語音輸入的狀態。面板有 Status、Keys、Voice、Setup 四個分頁，
  全部可以用鍵盤操作。畫面上的 HUD 會顯示錄音時間和錯誤訊息。
- **Doctor 檢查**：Setup 分頁會檢查所有系統需求，失敗的項目都附有可以直接複製的修正指令。

## 截圖

| Status | Keys |
|---|---|
| <img src="docs/images/panel-status.png" width="400" alt="Status 分頁"> | <img src="docs/images/panel-keys.png" width="400" alt="Keys 分頁"> |
| **Voice** | **Setup（Doctor）** |
| <img src="docs/images/panel-voice.png" width="400" alt="Voice 分頁"> | <img src="docs/images/panel-setup.png" width="400" alt="Setup 分頁"> |

- **Status**：語音和 Voxtype 的狀態、遙控器連線、麥克風模式、今天的使用次數，以及 3 秒的麥克風測試。
- **Keys**：每個按鍵的短按、長按、連按兩下動作，以及是否按住重複。可以直接修改、恢復預設，或調整時間參數。
- **Voice**：辨識引擎、麥克風模式、目前啟用的觸發來源、HUD 選項、單次錄音長度上限和使用統計。
- **Setup**：Doctor 檢查 keyd、Hyprland 快捷鍵、Voxtype、ATVVoice、Typeless 的 keytap 和設定檔。

## 系統需求

- 使用 Lua 版 Hyprland 設定的 Omarchy（需要 Hyprland 的 `global` dispatcher）。
- `keyd` ≥ 2.5、PipeWire（`pw-dump`、`wpctl`）、`jq`、`playerctl`。
- Voxtype ≥ 0.8，Omarchy 已內建。
- 只有 `remote` 麥克風模式需要：`git` 和 `cargo`，用來編譯 ATVVoice。
- 只有 Typeless 引擎需要：Typeless，以及使用者加入 `input` 群組。

## 安裝

```bash
git clone https://github.com/kehao-playground/omaremote.git
cd omaremote
make dev-install                 # 把外掛複製到 ~/.config/omarchy/plugins 並重新掃描
bash host/omaremote-setup        # 依序執行所有系統設定步驟（互動式；keyd 和 verify 會用到 sudo）
```

接著把 **OmaRemote** 加到 bar 上，打開面板的 **Setup** 分頁，每一項都應該是 ✓。

`omaremote-setup` 會依序執行下列步驟，每個步驟也可以單獨執行：

| 步驟 | 做什麼 |
|---|---|
| `deps` | 檢查系統工具，列出需要安裝的項目（不會自己安裝） |
| `keyd` | 產生並驗證 `/etc/keyd/omaremote.conf`（遙控器按鍵 → F13–F24 / XF86Xfer），再引導你啟用 keyd |
| `binds` | 設定 xkb 選項，產生 `~/.config/hypr/omaremote.lua` |
| `plugin` | 確認外掛已安裝，且服務有回應 |
| `atvvoice` | 編譯 ATVVoice（固定版本加上解碼修正 patch），寫入它的 user unit，並定義 Voxtype 錄音用的 ALSA PCM |
| `mic` | 套用麥克風模式：`remote` 或 `system` |
| `verify` | 確認快捷鍵已載入，並逐一測試每個按鍵的傳遞路徑 |

加上 `--mic system` 可以跳過 ATVVoice，改用電腦的麥克風語音輸入。

## 使用方式

**預設按鍵**

| 按鍵 | 短按 | 長按 |
|---|---|---|
| 方向鍵 | 方向鍵（按住重複） | |
| OK | Return | Ctrl+C |
| 返回 | Escape | BackSpace |
| Home | Omarchy 選單 | |
| Menu | Tab | **panic 重設**（1.5 秒） |
| 電視 / app | 下一個工作區 | |
| 音量 + / − | 音量 ±5%（按住重複） | |
| 電源 | 關閉螢幕 | 鎖定螢幕 |
| 麥克風 | 語音輸入 | |

可以在 **Keys** 分頁修改。設定存在 `~/.config/omaremote/config.json`，直接手動修改這個檔案也會立刻生效。

**語音輸入**

- `remote` 模式：按住麥克風鍵說話，放開結束。
- `system` 模式：按一下開始，再按一下停止。
- 鍵盤上的 F9（Omarchy 內建的 Voxtype 快捷鍵）可以照常使用。OmaRemote 只會觀察，不會中斷它。

## Typeless 引擎（選用）

在 Voice 分頁選 **Engine: Typeless** 之後，麥克風鍵改成送出 Typeless 的語音輸入快捷鍵，不再控制 Voxtype。
錄音、辨識和貼上都由 Typeless 自己完成，麥克風也在 Typeless 裡選。

1. 執行 `bash host/omaremote-setup typeless`。它會安裝 `omaremote-keytap` 這個 user service，也就是一個
   uinput 虛擬鍵盤，需要使用者在 `input` 群組裡（Typeless 本身也需要）。第一次執行時，會沿用 Typeless 目前的
   語音輸入快捷鍵。要改用其他快捷鍵，加上 `--hotkey RightAlt+RightShift`；要重新讀取 Typeless 的設定，加上
   `--hotkey-from-typeless`。setup 不會幫你切換引擎。
2. 在面板切換引擎：**Voice → Engine: Typeless**。
3. 在 Typeless 裡選對應的麥克風：
   - `remote` 模式：選遙控器（小米蓝牙语音遥控器），按住說話。
   - `system` 模式：選電腦的麥克風或 Auto-detect，每按一下切換一次 Typeless。

注意事項：

- `remote` 模式下，開始錄音前會先等遙控器自己的按鍵事件，最多等 `voice.typeless.pressWaitMs`（預設 250 ms）。
  這是因為只要有其他按鍵事件落在快捷鍵按下和放開之間，Typeless 就會忽略這次快捷鍵。同樣的原因，
  `omaremote-setup keyd` 會把麥克風鍵設成只送一次脈衝（`macro2(0, 0, xfer)`）。升級後請重新執行一次。
- Typeless 可以設定多組語音輸入快捷鍵。OmaRemote 的快捷鍵只要符合其中任何一組，Doctor 就會通過。
- **已知限制**：OmaRemote 看不到 Typeless 的實際狀態。以下情況可能讓兩邊的狀態相反，之後每次按住都會反向切換：
  在鍵盤上按了快捷鍵、Typeless 自己停止（太久沒聲音或到達長度上限），或某次送鍵的結果不明。恢復方法：
  1. 手動停止 Typeless；
  2. 如果 bar 顯示 Typeless 警告，按一下 reset；
  3. 再按住一次。
- 如果在語音輸入途中重啟 shell，請檢查 Typeless，它可能還在錄音。

## 疑難排解

- 先打開 **Setup** 分頁。每個失敗的項目都附有可以複製的修正指令。
- **麥克風鍵沒反應，其他按鍵正常**（`remote` 模式）：用 `systemctl --user restart atvvoice` 重啟 ATVVoice。
  這個狀況目前只出現過一次，原因還不清楚。
- **狀態卡住**：按住 panic 鍵（Menu）1.5 秒，或執行 `omarchy-shell omaremote reset`。

## 開發

```bash
make test          # node --test（純邏輯模組）
make lint          # qmllint + omarchy plugin validate
make integration   # 另開一個 Quickshell 加上 bash 假程式；不會動到正在使用的 shell 或 ~/.config/omaremote
make check         # 以上全部，加上 keytap、CommandRunner 和 setup 的測試
make dev-install   # rsync 到 ~/.config/omarchy/plugins/io.github.kehao-chen.omaremote 並重新掃描
make dev-restart   # 再加上 omarchy-restart-shell（修改 Service.qml 時需要：keepLoaded 的服務在重新掃描後仍會保留）
```

IPC（`omarchy-shell omaremote …`）：`ping`、`status`、`doctor`、`key <name> down|up`、`voice state <state>`、
`voice poll -`、`reset`、`mic remote|system`、`micStatus <id>`、`micToggle`、`engine voxtype|typeless`、
`typelessHotkey <chord>`、`selftestPing`、`selftestArm`、`selftestStatus|selftestReport|selftestDisarm <id>`。

設計文件在 `docs/superpowers/specs/`：核心設計（`2026-09-14-omaremote-design.md`）、系統設定
（`2026-10-02-omaremote-host-setup-design.md`）、遙控器麥克風（`2026-10-12-remote-mic-design.md`），
以及 Typeless 引擎（`2026-10-13-typeless-engine-design.md`）。

## 授權

GPL-3.0-only。
