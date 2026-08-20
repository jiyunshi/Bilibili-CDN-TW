# Bilibili CDN 台灣優化

[![version](https://img.shields.io/badge/version-1.3.3-3f8fa3?style=flat-square)](./CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-4f7d4d?style=flat-square)](./LICENSE) ![runtime](https://img.shields.io/badge/runtime-Tampermonkey-a5701f?style=flat-square) ![dependencies](https://img.shields.io/badge/dependencies-zero-4f7d4d?style=flat-square)

**自動繞開卡住的節點，換用連得順的那一個。**

語言：繁體中文 ｜ [English](#english)

---

## 概觀

Bilibili 的影片分段（segment）會從多個 CDN 節點下載。這些節點在台灣的可用性差異極大：有的延遲不到 100 毫秒，有的完全解析不到網域，有的解析得到卻永遠無法完成 TCP 交握。播放器本身不會替台灣使用者挑選，遇到不通的節點只能反覆重試，表現出來就是黑畫面、無限轉圈或畫質被迫下降。

本腳本在瀏覽器端接手節點選擇：持續量測各節點的實際延遲與下載吞吐量，並在播放過程中依即時表現自動切換。評分演算法經過模擬網格搜尋調校，並非單純的「測速後排序」。

| 能做到 | 不能做到 |
| :--- | :--- |
| 自動避開在台灣不穩定的節點 | 解鎖大會員影片或付費內容 |
| 播放中下載跟不上時自動換節點 | 繞過地區限制或登入限制 |
| 針對 4K、時間軸跳轉、背景分頁、多分頁並開分別最佳化 | 提升您實際的網路頻寬 |
| 學習資料全部存於本機，不需帳號或設定 | — |

> **注意**　若您的頻寬本來就不足以負荷 4K，更換 CDN 無法改善，請先調降畫質。
>
> **隱私**　腳本不會將任何資料傳送至第三方伺服器。所有學習到的節點狀態僅保存於 Tampermonkey 的本機儲存空間。

---

## 安裝

| 步驟 | 操作 |
| :--: | :--- |
| **1** | 安裝 **Tampermonkey**：Chrome / Edge / Brave 於「線上應用程式商店」搜尋；Firefox 於「附加元件」搜尋。 |
| **2** | 安裝腳本：以 `bilibili-cdn-tw.user.js` 安裝，或新增空白腳本後將檔案內容完整貼上並儲存。 |
| **3** | 重新開啟 Bilibili 影片頁：建議先關閉既有分頁再重新開啟。 |

支援一般影片、番劇、電影、紀錄片、國創、綜藝、課程、賽事等 13 種 `www.bilibili.com` 播放頁。

### ⚠️ Chrome / Edge 使用者請務必閱讀

自 Manifest V3 起，Chrome 需要額外授權才能執行使用者腳本。**若播放器設定選單中完全找不到 CDN 狀態區塊，多半就是這個原因。**

前往 `chrome://extensions` → Tampermonkey → **詳細資料** → 開啟 **「允許使用者指令碼」**，然後重新整理頁面。

這是瀏覽器層級的權限設定，腳本無法自行開啟。

---

## 確認運作狀態

點擊播放器右下角的齒輪按鈕，設定面板底部會出現 CDN 狀態區塊：

```text
☑ 攔截修改影片CDN
白名單：aliov > ali > cos
緩衝：21.21/20.00MB (100%) | buf=180s ✓達標
```

已勾選且緩衝達標，即表示運作正常。

若齒輪選單中**完全沒有**這個區塊（並非未勾選，而是整塊不存在），通常是上方提到的 Tampermonkey 權限未開啟。

---

## 疑難排解

### 播放仍然卡頓

請依序嘗試：重新整理頁面 → 調降一階畫質 → 關閉或更換 VPN 節點 → 重新啟動瀏覽器。

### 剛更換網路、VPN 或行動熱點

腳本記憶的節點資料是依前一個網路環境學習而來，換網路後可能不再適用。請按 `F12` 開啟主控台並執行：

```js
BiliCDN.reset()
location.reload()
```

腳本會清除既有學習結果，重新適應目前的網路環境。

### 暫時停用

於設定面板取消勾選「攔截修改影片CDN」，或直接在 Tampermonkey 面板停用整支腳本。

### 回報問題

點擊狀態面板中的 **「複製診斷」**，腳本會產生一段**不含個人資訊**的純文字診斷報告並複製至剪貼簿，直接提供給開發者即可，無須自行整理截圖。

---

## 進階參考

一般使用者無須閱讀本節。

### Tampermonkey 選單指令

多數情況下無須使用主控台。點擊 Tampermonkey 圖示 → 本腳本選單，即可直接操作：

| 選單項目 | 作用 |
| :--- | :--- |
| 🔄 重置所有學習狀態 | 清除全部學習資料並重新整理頁面 |
| 📊 顯示診斷資訊 | 輸出目前的節點狀態與評分 |
| 🏁 立即測速選節點 | 手動觸發一次吞吐量測試 |
| 🔍 開啟／關閉詳細記錄 | 切換 verbose 記錄模式 |
| 🌐 HTTPDNS 狀態 | 顯示 HTTPDNS 攔截判定結果 |

### 主控台指令

按 `F12` 開啟主控台後可使用下列指令。

**日常診斷**

| 指令 | 作用 |
| :--- | :--- |
| `BiliCDN.diag()` | 檢視完整狀態：候選順序、黑名單、死節點、各節點評分 |
| `BiliCDN.buf()` | 檢視緩衝量、下載速度、換節點次數與斷路器狀態 |
| `BiliCDN.stats()` | 檢視改寫統計（含 `pcdnSkipped`、`hostLocked` 等指標） |
| `BiliCDN.report()` | 產生純文字診斷報告並複製至剪貼簿 |

**狀態管理**

| 指令 | 作用 |
| :--- | :--- |
| `BiliCDN.reset()` | 完整重置所有學習狀態 |
| `BiliCDN.clearDead()` | 僅清除記憶中的失效節點，更換網路後適用 |
| `BiliCDN.clearSoft()` | 清除本次工作階段的暫時隔離名單 |
| `BiliCDN.revive("ali")` | 單獨救回某個被誤判的節點，不影響其他學習資料 |

**手動觸發與設定**

| 指令 | 作用 |
| :--- | :--- |
| `BiliCDN.probe()` | 重新量測各節點延遲（忽略兩小時快取） |
| `BiliCDN.bakeoff()` | 手動觸發吞吐量測試（請先播放數秒） |
| `BiliCDN.setCdn("<host>")` | 固定使用指定節點；`setCdn("null")` 恢復自動 |
| `BiliCDN.exclude("kw")` | 即時新增排除關鍵字；`include("kw")` 為移除 |
| `BiliCDN.verbose(true)` | 開啟詳細記錄 |

### 設定選項

腳本開頭提供下列變數，一般情況無須調整：

```js
var CustomCDN = ''                   // 留空 = 自動選擇（建議）；填入 host = 固定使用該節點
var ExcludeHostKeywords = ['cosov']  // host 含這些字串即排除（預設避開實測不穩的 cosov）
var BlockHttpDNS = 'auto'            // 'auto' 自動判定 / true 永遠阻擋 / false 永遠放行
var PreferredVideoCodec = 'hevc'     // 4K 優先 HEVC 以節省頻寬，無硬體解碼時自動退回 AVC
var BlockWebRTC = true               // 阻擋 WebRTC，避免拖慢跨國連線
var EnableWorkerIntercept = true     // Worker 內 segment 改寫的攔截層開關
```

### 支援範圍

| 項目 | 說明 |
| :--- | :--- |
| **腳本管理器** | Tampermonkey（建議）；Violentmonkey 多數情況可用 |
| **不支援** | Greasemonkey 4+、`m.bilibili.com` 行動版網頁、非 Bilibili 網站 |
| **無法處理** | 大會員內容、登入限制、地區限制 |

### 隱私說明

腳本不會將任何資料上傳至第三方伺服器。本機儲存的內容僅限於節點健康度統計（例如某節點近期是否不穩定），用途單純是讓下次能更快避開問題節點。

---

## 版本沿革

完整異動請參閱 [`CHANGELOG.md`](./CHANGELOG.md)。**目前建議使用 `v1.3.3`。**

| 版本 | 重點 |
| :--- | :--- |
| **v1.3.3** | 專治「偶爾有幾部影片特別慢」。修正 PCDN 專用網址被改壞、卡頓判定誤用最高畫質碼率、下載速度取樣把段間空檔誤判為卡頓、起播與測速搶頻寬，以及解析失敗的節點被誤判為低延遲優等生等問題。同時清除主控台中由腳本自身產生的錯誤訊息，並將候選節點池由 3 個擴充至 7 個。 |
| **v1.3.1** | 修正設定面板可能永遠不出現的靜默失敗；新增 Worker 攔截有效性量測與一鍵診斷報告。 |
| **v1.3.0** | CDN 選路核心大修：修正簽名過期時全部節點遭誤判、緩衝量測失準、Akamai 節點緩衝停留 0%、HTTPDNS 判定失準等問題；新增 Tampermonkey 選單指令。 |

> **關於 v1.3.2**　該版號曾短暫發布後撤回，內容與現行版本完全不同。依本專案版本號規則（版號一經發布即不得指派給不同內容），本次改用 `v1.3.3`。
>
> **請勿繼續使用 v1.2.1**　該版本經實際發布後證實不穩定，存在 403、CORS 錯誤與 4K 無畫面等問題。

---

## 授權

MIT License。本軟體依現況提供，不保證能改善所有網路環境。使用時請自行確認符合所在地法律規範與 Bilibili 服務條款。

作者 `jiyunshi` ・ <span>chocosensei214</span><span>&#64;</span><span>gmail</span><span>&#46;</span><span>com</span>

---

## English

[![version](https://img.shields.io/badge/version-1.3.3-3f8fa3?style=flat-square)](./CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-4f7d4d?style=flat-square)](./LICENSE) ![runtime](https://img.shields.io/badge/runtime-Tampermonkey-a5701f?style=flat-square)

**Routes around the stuck node, so playback keeps up.**

Language: [繁體中文](#bilibili-cdn-台灣優化) ｜ English

### Overview

Bilibili serves video segments from a range of CDN nodes whose reachability from Taiwan varies enormously — some answer in under 100 ms, some fail DNS resolution entirely, and some resolve but never complete a TCP handshake. The player does not select on behalf of Taiwanese viewers; when it lands on an unreachable node it simply retries, which the viewer experiences as a black screen, endless buffering, or a forced drop in quality.

This userscript takes over node selection in the browser. It continuously measures the real latency and download throughput of each candidate and switches during playback based on observed performance. The scoring algorithm was tuned against simulated playback runs rather than being a plain speed-test sort.

| It does | It does not |
| :--- | :--- |
| Avoid nodes that are unstable in Taiwan | Unlock paid or membership-only content |
| Switch automatically when playback cannot keep up | Bypass region or login restrictions |
| Handle 4K, seeking, background tabs and multiple tabs | Increase your actual bandwidth |

> **Note**　If your connection cannot sustain 4K, changing CDN will not help — lower the quality instead.
>
> **Privacy**　Nothing is transmitted to any third-party server. All learned node data stays in local Tampermonkey storage.

### Installation

1. Install **Tampermonkey** from your browser's extension store.
2. Install `bilibili-cdn-tw.user.js`, or create a blank script and paste the file's full contents.
3. Close any existing Bilibili tabs and open a video page afresh.

**Chrome / Edge users:** since Manifest V3, Chrome requires explicit permission to run userscripts. If the CDN status panel never appears, go to `chrome://extensions` → Tampermonkey → **Details** → enable **"Allow User Scripts"**, then reload the page.

### Verifying It Works

Open the player's settings gear. A CDN status block should appear at the bottom, showing the active whitelist order and buffer level. If the block is absent entirely, the permission above is most likely not enabled.

### Troubleshooting

If playback still buffers, in order: reload the page, lower the quality one step, check or change your VPN, restart the browser.

After switching network, VPN, or mobile hotspot, the learned node data no longer reflects your environment. Press `F12` and run:

```js
BiliCDN.reset()
location.reload()
```

**Useful commands**

| Command | Purpose |
| :--- | :--- |
| `BiliCDN.diag()` | Full state: candidate order, blacklist, dead nodes, per-node scores |
| `BiliCDN.buf()` | Buffer level, throughput, switch count, breaker status |
| `BiliCDN.probe()` | Re-measure node latency |
| `BiliCDN.bakeoff()` | Run a throughput test |
| `BiliCDN.clearDead()` | Clear remembered dead nodes |
| `BiliCDN.report()` | Copy a privacy-safe diagnostic report for bug reports |

### Releases

See [`CHANGELOG.md`](./CHANGELOG.md). **`v1.3.3` is the recommended release.**

| Version | Highlights |
| :--- | :--- |
| **v1.3.3** | Targets the "some videos are simply slow to start" problem. PCDN-only URLs are no longer rewritten into guaranteed failures; stall detection uses the bitrate of the resolution actually playing rather than the highest one offered; throughput is measured over a sliding window so normal gaps between segments are not read as stalls; probes no longer compete with the first segments for bandwidth; and a host that fails DNS resolution is no longer mistaken for a low-latency node. Console noise generated by the script itself has been eliminated, and the candidate pool expanded from 3 nodes to 7. |
| **v1.3.1** | Fixed a silent failure where the settings panel could permanently fail to appear; added Worker interception metrics and the one-click diagnostic report. |
| **v1.3.0** | CDN routing overhaul: fixed a false positive that blacklisted every node at once when the playurl signature expired, inaccurate buffer and throughput measurement, the buffer panel stalling at 0% on Akamai-routed videos, and HTTPDNS detection scoring. |

> **On v1.3.2**　That version number was briefly published and then withdrawn, and its contents differ entirely from the current release. Per this project's versioning rule — a version number, once published, is never reassigned to different content — this release uses `v1.3.3`.
>
> **Do not use v1.2.1**　It proved unstable in real-world playback (403 errors, CORS failures, and 4K playback showing no picture).

### Licence

MIT. Provided as-is, with no guarantee that it improves every network environment. Please ensure your use complies with local law and Bilibili's terms of service.
