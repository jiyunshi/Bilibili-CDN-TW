# Bilibili CDN 台灣優化

[![version](https://img.shields.io/badge/version-1.3.7-3f8fa3?style=flat-square)](./CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-4f7d4d?style=flat-square)](./LICENSE) ![runtime](https://img.shields.io/badge/runtime-Tampermonkey-a5701f?style=flat-square) ![dependencies](https://img.shields.io/badge/dependencies-zero-4f7d4d?style=flat-square)

**看 Bilibili 卡住、一直轉圈？這支腳本會自動幫你換到在台灣比較順的線路。**

語言：繁體中文 ｜ [English](#english)

---

## 概觀

### 為什麼在台灣看 B 站會卡？

你在 B 站看的影片，其實是被切成一小段一小段，從**很多台不同的伺服器**下載下來的。這些伺服器有的在香港、有的在台灣附近、有的在中國大陸。從台灣連過去，有的很順，有的很慢，有的根本連不上。

B 站的播放器不會特別替台灣的觀眾挑線路。它分配到一台很慢或連不上的伺服器時，只會一直重試，你看到的就是**轉圈圈、黑畫面，或畫質自己掉下去**。冷門影片特別明顯：熱門影片大家常看，伺服器上有現成的檔案，所以很快；冷門影片伺服器得先去遠端拿，第一段就可能要等好幾秒。

### 這支腳本做什麼？

它在你的瀏覽器裡**幫你挑線路**：

- **自動測速**：在背景偷偷量哪幾台伺服器在你的網路上最快，用量到的結果決定從哪台下載。
- **卡住就換**：播放中如果下載跟不上，會自動換一台，不用你手動重新整理。
- **越用越準**：它會記住每台伺服器的表現，下次開影片時直接用最好的那台。換了畫質也會重新評估。
- **不用設定**：裝好就會運作，所有資料都只存在你自己的電腦裡。

實測效果（台灣網路）：冷門影片開始播放的時間，從 **3～9 秒縮短到約 1 秒**。

| 能做到 | 不能做到 |
| :--- | :--- |
| 自動避開在台灣很慢或連不上的伺服器 | 解鎖大會員影片或付費內容 |
| 播放中卡住時自動換線路 | 繞過地區限制或登入限制 |
| 冷門影片、4K、拖時間軸、同時開好幾個分頁都有特別處理 | 讓你的網路本身變快 |
| 不用帳號、不用設定 | — |

> **注意**　如果你的網路本身就不夠快（例如想看 4K 但家裡網路跑不到），換線路也沒用，請先把畫質調低一點。
>
> **隱私**　腳本不會把任何資料傳到別的地方。它記住的只有「哪台伺服器快、哪台慢」，而且只存在你自己的瀏覽器裡。想了解技術細節，請看下方的「[運作原理（技術說明）](#運作原理技術說明)」。

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

點播放器右下角的齒輪，設定選單最下面會出現一塊狀態區：

```text
☑ 攔截修改影片CDN
白名單：upos-sz-mirroraliov > cn-hk-eq-01-03 > cn-hk-eq-01-05 > …
緩衝：21.21/20.00MB (100%) | buf=180s ✓達標
測速：35 秒前完成，量了 3 個節點 → cn-hk-eq-01-03
```

每一列的意思：

| 列 | 白話說明 |
| :--- | :--- |
| ☑ 攔截修改影片CDN | 腳本有在運作。取消勾選就是暫時關掉 |
| 白名單 | 目前挑選的伺服器順序，排第一的就是正在用的 |
| 緩衝 | 已經先下載好多少影片。顯示「✓達標」代表存量夠，不容易卡。**切換畫質後會重新計算**，並標示「（切換畫質後）」 |
| 測速 | 最近一次測速是什麼時候、為什麼測（例如「切換畫質」）、選出了哪一台 |

有勾選、而且緩衝顯示達標，就代表運作正常。

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

### 運作原理（技術說明）

Bilibili 以 DASH 串流播放：影片與音訊各自切成分段（segment），由 playurl API 回傳每條串流的 `base_url` 與 `backup_url`，指向不同的 CDN 節點（upos 鏡像、香港 BCache、Akamai 等）。這些節點從台灣的表現差異極大：有的延遲不到 10 毫秒，有的 NXDOMAIN，有的連得上卻回 HTTP 959（區域拒絕），有的會間歇性完全沒有回應。Akamai 的速度則取決於分段是否在它的邊緣快取裡：熱門片 46～95 Mbps，冷門片回源時只有 0.8～1.6 Mbps。播放器本身只會依序重試，不會替台灣使用者挑選。

本腳本在 `document-start` 攔截 playurl 回應與分段請求（XHR、fetch、Worker），改寫主線路與備援順序：

| 機制 | 說明 |
| :--- | :--- |
| **吞吐量賽馬** | 拿一條真實簽名的分段網址，換成各候選節點的 host，以 Range 請求在檔案**中後段的隨機位置**量測（固定量開頭會量到快取速度）。連 header 都沒收到的節點會排到候選最後 |
| **評分** | Discounted-UCB：吞吐量 EWMA（半衰期 8 分鐘）＋ 探索加成 − 失敗、慢速、抖動、延遲懲罰。2 倍需求內線性計分，超過 2 倍再給對數的餘裕加分，到 10 倍封頂；換節點有 0.20 的黏著邊界，避免來回跳 |
| **主線路選擇** | 4K 以白名單節點為主。一般畫質在白名單有實測證據（至少 2 筆樣本、以 24 小時半衰期折算後達碼率 3 倍）時也以白名單為主，Akamai 降為第一順位備援；沒有證據時維持 Akamai |
| **Watchdog** | 每秒依緩衝存量趨勢與滑動視窗吞吐量判斷是否跟不上，連續成立才換節點，並有斷路器避免無效的頻繁切換。已緩衝到片尾時不判定停滯 |
| **切換畫質** | 以播放器回報的畫質編號（`getQuality().realQ`）偵測切換，立刻改用新畫質的碼率計算緩衝目標並重新起算進度；往上切時重新測速（不因現用節點夠快而跳過） |
| **失效判定** | 標記節點失效前，必須目標連不到、而對照組（另一台健康節點或頁面網域）連得到，避免本機斷網時整批誤判；每 6 小時自動複查連不到類的失效節點 |
| **多分頁** | 測速冷卻與複查時間戳存在 Tampermonkey 共用儲存，開多個分頁也只有一個在測；並以 Web Locks 互斥 |

所有判斷依據的實機量測數據與推翻過的做法，記錄在 [`CHANGELOG.md`](./CHANGELOG.md) 各版本的附錄中。

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

### 開發者：離線測試

不需要安裝任何套件（Node.js 18 以上）：

```bash
node --test tests/run.test.js
```

測試會把腳本載入 Node 的 `vm` 沙箱，直接呼叫內部函式驗證行為，不需要開瀏覽器。選路模擬器 `node tests/sim.js` 會用實測的節點參數模擬 30 分鐘播放，比較卡頓秒數與換節點次數，執行約需數分鐘。

### 支援範圍

| 項目 | 說明 |
| :--- | :--- |
| **腳本管理器** | Tampermonkey（建議）；Violentmonkey 多數情況可用 |
| **不支援** | Greasemonkey 4+、`m.bilibili.com` 行動版網頁、Bilibili App、非 Bilibili 網站 |
| **手機** | Android 上支援擴充功能的瀏覽器（例如 Firefox、Edge）可安裝 Tampermonkey，需開啟「電腦版網站」；iOS 可試 Safari 版 Tampermonkey，同樣需切換為電腦版網站。**兩者皆未實測** |
| **無法處理** | 大會員內容、登入限制、地區限制 |

### 隱私說明

腳本不會將任何資料上傳至第三方伺服器。本機儲存的內容僅限於節點健康度統計（例如某節點近期是否不穩定），用途單純是讓下次能更快避開問題節點。

---

## 版本沿革

完整異動請參閱 [`CHANGELOG.md`](./CHANGELOG.md)。**目前建議使用 `v1.3.7`。**

| 版本 | 重點 |
| :--- | :--- |
| **v1.3.7** | **修正每個分頁只有第一支影片有被優化的問題**：播放器換片、播合集下一集、自動連播、切換 Hi-Res／杜比音軌時重新取得的播放資訊，過去完全沒有經過腳本，冷門影片可能卡在 Akamai（實測一個片段 7.9 秒）。切換畫質或音軌時播放器會清掉緩衝重抓，不再被誤判為節點卡住、懲罰最快的節點。切換解析度後立刻重新計算緩衝並重新測速，設定面板新增「測速」狀態列。修正每支影片播到結尾時正在使用的節點被誤判停滯。測速時連線過慢的節點排到最後。卡住時改為懲罰真正卡住的節點（影片與音訊走不同節點時，過去會罰到無辜的節點）；判斷「本機斷線」改用已知連得快的節點當對照，避免真的壞掉的節點永遠不被處理。 |
| **v1.3.6** | 冷門影片開播由約 3～9 秒縮短至約 1 秒：已有測速紀錄時，一般畫質也改由實測夠快的節點（多為香港節點）供片，Akamai 改為第一順位備援；測速紀錄可沿用約一至兩天。測速時完全沒有回應的節點改排到最後，避免每輪都白等 3 秒。移除對播放器沒有作用的 `minBufferTime` 改寫。 |
| **v1.3.5** | 選路大修，全部以實機量測為依據。新增 3 個香港節點（台灣實測未快取位置 40～101 Mbps，延遲 22～39 毫秒）；修正測速固定量檔案開頭、量到的其實是快取速度的問題；評分改為「夠用之上仍分得出快慢」，並提高延遲權重；Akamai 冷門片速度跟不上時提前切走。另修正筆電休眠或切換網路時好節點被整批誤判失效 30 天的問題（並自動救回已被誤判的節點），以及切換畫質後不會重新測速。新增 `tests/` 離線測試。 |
| **v1.3.4** | 補上遺漏的播放頁比對規則（`/list/`、`/festival/`、`/medialist/play/`、`/watchlater/`），這些頁面過去完全不會載入腳本；修正列表頁換片偵測認不出影片（編號在 `?bvid=` 而非路徑中），以及攔截層五項健壯性問題，其中包含 playurl 請求可能永久停在「載入中」的缺陷。 |
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

[![version](https://img.shields.io/badge/version-1.3.7-3f8fa3?style=flat-square)](./CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-4f7d4d?style=flat-square)](./LICENSE) ![runtime](https://img.shields.io/badge/runtime-Tampermonkey-a5701f?style=flat-square)

**Bilibili keeps buffering? This script automatically switches you to a server that works well from Taiwan.**

Language: [繁體中文](#bilibili-cdn-台灣優化) ｜ English

### Overview

A Bilibili video is downloaded in small pieces from **many different servers** — some in Hong Kong, some close to Taiwan, some in mainland China. From Taiwan, some are fast, some are slow, and some cannot be reached at all. The player does not pick for Taiwanese viewers; when it lands on a bad server it just keeps retrying, which you see as a spinning wheel, a black screen, or the picture quality dropping by itself. Unpopular videos are hit hardest, because the server has to fetch them from far away first.

This script **picks the server for you**, inside your browser:

- **Tests speed in the background** and downloads from whichever server is fastest on your connection.
- **Switches automatically** if playback cannot keep up, without a page reload.
- **Learns over time**, and re-evaluates when you change the video quality.
- **Needs no setup**, and keeps everything on your own computer.

Measured from Taiwan: unpopular videos now start in **about 1 second instead of 3–9**. Technical details are below under *How It Works*.

| It does | It does not |
| :--- | :--- |
| Avoid nodes that are unstable in Taiwan | Unlock paid or membership-only content |
| Switch automatically when playback cannot keep up | Bypass region or login restrictions |
| Handle 4K, seeking, background tabs and multiple tabs | Increase your actual bandwidth |

> **Note**　If your connection cannot sustain 4K, changing CDN will not help — lower the quality instead.
>
> **Privacy**　Nothing is transmitted to any third-party server. All learned node data stays in local Tampermonkey storage.

### How It Works

Bilibili plays DASH streams: the playurl API returns a `base_url` and `backup_url` for each stream, pointing at different CDN nodes (upos mirrors, Hong Kong BCache, Akamai). From Taiwan these range from sub-10 ms edges to hosts that are NXDOMAIN, return HTTP 959, or intermittently never respond; Akamai is fast only when a segment is in its edge cache (46–95 Mbps for popular videos, 0.8–1.6 Mbps on origin fetches). The script intercepts playurl responses and segment requests (XHR, fetch, Worker) at `document-start` and rewrites the primary and backup order. It ranks nodes with a discounted-UCB score over throughput EWMAs measured by Range probes at random, uncached offsets; uses whitelist nodes as primary whenever there is measured evidence they can sustain 3× the stream bitrate; watches buffer trends to switch on real stalls (with a circuit breaker, and never at the end of a fully buffered video); detects quality changes from the player's own quality id; and requires a healthy control host to be reachable before marking any node dead. See [`CHANGELOG.md`](./CHANGELOG.md) for the measurements behind each decision.

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

See [`CHANGELOG.md`](./CHANGELOG.md). **`v1.3.7` is the recommended release.**

| Version | Highlights |
| :--- | :--- |
| **v1.3.7** | **Fixes optimization applying only to the first video in each tab**: the playback info the player fetches when switching videos, playing the next episode of a collection, autoplaying, or toggling Hi-Res / Dolby audio never passed through the script, so unpopular videos could get stuck on Akamai (one segment measured at 7.9 seconds). When the player flushes its buffer to switch resolution or audio track, that is no longer mistaken for a stalled node (which used to penalize the fastest node). Switching resolution now immediately restarts buffer tracking and re-tests throughput, with a new throughput-test row in the settings panel. Fixed the node in use being flagged as stalled at the end of every video. Nodes too slow to connect within a throughput test are moved to the back of the queue. On a stall, the node actually holding up the buffer is penalized (when video and audio come from different nodes, an innocent node used to be blamed), and the "is my own network down?" check now uses a node known to be fast as its control, so genuinely broken nodes are no longer let off indefinitely. |
| **v1.3.6** | Unpopular videos now start in about 1 second instead of 3–9: once throughput data exists, normal-resolution streams are also served from a node measured to be fast enough (usually Hong Kong), with Akamai as the first backup; that data now stays usable for a day or two. Nodes that never respond during throughput tests are moved to the back of the queue instead of costing 3 seconds every round. Removed a `minBufferTime` rewrite that the player never reads for on-demand video. |
| **v1.3.5** | A routing overhaul driven entirely by real-world measurements. Adds three Hong Kong nodes (40–101 Mbps on uncached content and 22–39 ms latency, measured from Taiwan); fixes throughput probes that always read the start of the file and therefore measured cache speed; reworks scoring so nodes stay distinguishable above the "fast enough" line and latency carries more weight; and moves off Akamai early when an unpopular video is served too slowly. Also fixes good nodes being marked dead for 30 days en masse after a laptop sleeps or switches networks (and automatically revives nodes already misjudged), and re-tests throughput after switching to a higher resolution. Adds offline tests under `tests/`. |
| **v1.3.4** | Added the missing match patterns for playlist-style playback pages (`/list/`, `/festival/`, `/medialist/play/`, `/watchlater/`), which previously never loaded the script at all; fixed video-change detection on those pages (the video id lives in `?bvid=` rather than the path); and hardened the network interception layer in five places, including a defect that could leave a playurl request stuck on "loading" forever. |
| **v1.3.3** | Targets the "some videos are simply slow to start" problem. PCDN-only URLs are no longer rewritten into guaranteed failures; stall detection uses the bitrate of the resolution actually playing rather than the highest one offered; throughput is measured over a sliding window so normal gaps between segments are not read as stalls; probes no longer compete with the first segments for bandwidth; and a host that fails DNS resolution is no longer mistaken for a low-latency node. Console noise generated by the script itself has been eliminated, and the candidate pool expanded from 3 nodes to 7. |
| **v1.3.1** | Fixed a silent failure where the settings panel could permanently fail to appear; added Worker interception metrics and the one-click diagnostic report. |
| **v1.3.0** | CDN routing overhaul: fixed a false positive that blacklisted every node at once when the playurl signature expired, inaccurate buffer and throughput measurement, the buffer panel stalling at 0% on Akamai-routed videos, and HTTPDNS detection scoring. |

> **On v1.3.2**　That version number was briefly published and then withdrawn, and its contents differ entirely from the current release. Per this project's versioning rule — a version number, once published, is never reassigned to different content — this release uses `v1.3.3`.
>
> **Do not use v1.2.1**　It proved unstable in real-world playback (403 errors, CORS failures, and 4K playback showing no picture).

### Licence

MIT. Provided as-is, with no guarantee that it improves every network environment. Please ensure your use complies with local law and Bilibili's terms of service.
