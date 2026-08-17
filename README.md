# 📡 Bilibili CDN 台灣優化

<a name="zh-tw"></a>
<a name="chinese"></a>

![version](https://img.shields.io/badge/version-1.3.2-3f8fa3?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-4f7d4d?style=flat-square)
![runtime](https://img.shields.io/badge/runtime-Tampermonkey-a5701f?style=flat-square)
![dependencies](https://img.shields.io/badge/dependencies-zero-4f7d4d?style=flat-square)

**你不用懂 CDN，腳本會替你繞開卡住的那一顆節點。**

給台灣使用者的 Bilibili 影片 CDN 自動切換腳本——自動避開卡頓、黑畫面、連不上的節點，換用比較順的。背後是一套跑過模擬網格搜尋調校的即時評分演算法，不是單純「測速排序」而已。

版本 `1.3.2` ・ 作者 `jiyunshi` ・ <span>chocosensei214</span><span>&#64;</span><span>gmail</span><span>&#46;</span><span>com</span>

語言：[繁體中文](#zh-tw) | [English](#english)

---

## 🛰️ 這個腳本在做什麼

Bilibili 的影片資料會從很多不同的 CDN 節點下載，有些在台灣很順，有些會很慢、連不上或一直轉圈。

裝上這個腳本後，它會自動：

- 避開台灣常見不穩的節點，優先用順的。
- 播放中如果下載跟不上，自動換一個節點，不用你手動選。
- 4K／高畫質、拖時間軸、切到背景分頁、多開分頁等情境都有額外優化。

你不用懂 CDN，也不用設定，裝好重整頁面就生效。

它**不是**破解工具：不能解鎖會員影片、不能繞地區限制、也不能讓你的網路變快。如果本來的網速就不夠看 4K，換 CDN 幫不了，請先降畫質。

它也**不打電話回家**：所有學習到的節點資料只存在你的瀏覽器本機，腳本不會把任何東西上傳到任何伺服器。

---

## 📥 安裝

1. **裝 Tampermonkey**：Chrome / Edge / Brave 到線上應用程式商店搜尋 `Tampermonkey`；Firefox 到 Add-ons 搜尋。
2. **裝腳本**：用 `bilibili-cdn-tw.user.js` 安裝，或新增腳本後把內容整份貼上存檔。
3. **重開 Bilibili 影片頁**：建議先關掉舊分頁再重新打開，支援一般影片、番劇、電影、紀錄片、課程等播放頁。

> **Chrome / Edge 完全沒看到 CDN 狀態區塊？** 新版 Chrome 需要額外授權才能讓 Tampermonkey 生效：`chrome://extensions` → Tampermonkey → 詳細資料 → 開啟「允許使用者指令碼」，再重整頁面。這是瀏覽器的設定，腳本自己開不了。

---

## ✅ 怎麼確認它有在運作

播放器右下角點齒輪，設定面板底部會多一塊 CDN 狀態資訊，大概長這樣：

```text
☑ 攔截修改影片CDN
白名單：aliov > ali > cos
緩衝：21.21/20.00MB (100%) | buf=180s ✓達標
```

有勾選 + 緩衝達標，就代表在正常運作。如果齒輪選單裡完全沒有這塊（不是沒勾選、是整個不見），通常是上面提到的 Tampermonkey 授權沒開。

---

## 🩹 卡頓時怎麼辦

依序試：重整頁面 → 降一階畫質 → 關掉/換 VPN 節點 → 重開瀏覽器。

如果是剛換了網路、VPN 或熱點，腳本記住的舊節點資料可能不適用了，開 `F12` 到 Console 貼：

```js
BiliCDN.reset()
location.reload()
```

這樣它會忘記舊資料、重新學習目前的網路環境。

想暫時關掉腳本：在設定面板取消勾選「攔截修改影片CDN」，或直接去 Tampermonkey 面板停用整支腳本。

想回報問題？點狀態面板裡的「複製診斷」按鈕，會組好一段不含個資的純文字直接進剪貼簿，貼給開發者就好，不用自己整理一堆截圖。

---

<details>
<summary><strong>進階：指令、設定選項、支援範圍（一般使用者不需要看）</strong></summary>

### Console / 選單指令

大部分情況用不到，只有排查問題才需要。點 Tampermonkey 圖示 → 這支腳本的選單，就有「重置」「診斷資訊」「立即測速」等按鈕，不用打字。想自己打指令的話，`F12` 開 Console：

| 指令 | 作用 |
|---|---|
| `BiliCDN.diag()` | 看目前狀態 |
| `BiliCDN.buf()` | 看緩衝與下載速度 |
| `BiliCDN.bakeoff()` | 手動重新測速選 CDN（先播放幾秒再打） |
| `BiliCDN.clearDead()` | 只清除「記住的壞節點」，換網路後可用 |
| `BiliCDN.reset()` | 全部重置，狀態怪怪的時候用 |
| `BiliCDN.report()` | 組出一段診斷用純文字並複製到剪貼簿（跟面板的「複製診斷」按鈕一樣） |
| `BiliCDN.workerStats()` | 看 Worker 攔截層有沒有真的攔到影片分段（開發用，一般不需要） |

### 進階設定

腳本開頭有幾個變數可以改，一般不需要動：

```js
var CustomCDN = ''              // 留空 = 自動選 CDN（建議）；填 host 名稱 = 固定用某個節點
var ExcludeHostKeywords = ['cosov']  // host 名稱含這些字就不用（預設避開較不穩的 cosov 類節點）
var BlockHttpDNS = 'auto'       // 'auto' 自動判斷 / true 永遠擋 / false 永遠放行
var PreferredVideoCodec = 'hevc' // 4K 優先用 HEVC 省頻寬，沒有硬解會自動退回 AVC
var BlockWebRTC = true          // 擋 WebRTC，避免拖慢跨國連線；若其他功能需要 WebRTC 可設 false
var EnableWorkerIntercept = true // Worker 內 segment 改寫的攔截層開關，一般不需要關
```

### 支援範圍

- 支援 Tampermonkey、多數情況下 Violentmonkey 也可用，`www.bilibili.com` 常見播放頁。
- 不支援 Greasemonkey 4+、`m.bilibili.com` 手機版網頁、非 Bilibili 網站，也不能繞過會員/登入/地區限制。

### 隱私

不會把任何資料上傳到第三方伺服器，只在 Tampermonkey 本機存一點狀態（例如記住哪些節點最近不穩），純粹是為了下次能更快避開。

</details>

---

## 📜 更新紀錄

完整版本異動請看 [`CHANGELOG.md`](./CHANGELOG.md)。目前建議使用 **v1.3.2**：

- **v1.3.0**：CDN 選路核心大修——修正了簽名過期時全部節點一起被誤判成壞掉、緩衝量測不準、Akamai 節點緩衝卡在 0%、HTTPDNS 判斷失準等問題，也新增了 Tampermonkey 選單指令。
- **v1.3.1**：修掉「設定面板可能永遠不出現」的靜默失敗，新增 Worker 攔截有效性量測。
- **v1.3.2**：新增 `BiliCDN.report()` 診斷報告一鍵複製，其餘為內部程式碼健檢與安全開關。

**請勿繼續使用 v1.2.1**，對外發布後證實不穩定（403、CORS、4K 無畫面等問題）。

---

## 📄 授權

MIT License，依現況提供，不保證能改善所有網路環境。使用時請自行確認符合所在地法律與 Bilibili 服務條款。

---

<a name="english"></a>
<a name="en"></a>

## English

[繁體中文](#zh-tw)

![version](https://img.shields.io/badge/version-1.3.2-3f8fa3?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-4f7d4d?style=flat-square)
![runtime](https://img.shields.io/badge/runtime-Tampermonkey-a5701f?style=flat-square)
![dependencies](https://img.shields.io/badge/dependencies-zero-4f7d4d?style=flat-square)

**You don't need to know what a CDN is — the script routes around the one that's stuck.**

A userscript that improves Bilibili video playback for Taiwan network conditions — it automatically avoids slow or broken CDN nodes and switches to faster ones based on real download speed, using a scoring algorithm tuned against simulated playback runs, not just a plain speed-test sort.

Version `1.3.2` ・ Author `jiyunshi` ・ <span>chocosensei214</span><span>&#64;</span><span>gmail</span><span>&#46;</span><span>com</span>

**What it does:** avoids unstable nodes, switches CDN automatically when playback can't keep up, and adds extra handling for 4K, seeking, background tabs, and multiple open tabs. It does **not** unlock paid videos, bypass region locks, or increase your actual bandwidth. It also doesn't phone home — all learned node data stays in your local browser storage.

**Install:** 1) install Tampermonkey, 2) install `bilibili-cdn-tw.user.js` (or paste the full file into a new script), 3) close old Bilibili tabs and reopen a video page. If the CDN panel never appears on Chrome/Edge, enable **"Allow User Scripts"** for Tampermonkey under `chrome://extensions` → Details (required by Manifest V3), then reload.

**Confirm it's active:** open the player settings gear — a CDN status panel should appear near the bottom.

**If playback still buffers:** reload the page, lower the quality, check your VPN, or restart the browser. If you just changed network/VPN, reset the learned state:

```js
BiliCDN.reset()
location.reload()
```

Other useful commands: `BiliCDN.diag()`, `BiliCDN.buf()`, `BiliCDN.bakeoff()`, `BiliCDN.clearDead()`, `BiliCDN.report()` (copies a privacy-safe diagnostic report to your clipboard for bug reports).

**Changelog:** see [`CHANGELOG.md`](./CHANGELOG.md). **v1.3.2** is the recommended release. v1.3.0 fixed a false-positive that could blacklist every CDN node at once when the playurl signature expires, inaccurate buffer/throughput measurement, the buffer panel getting stuck at 0% on Akamai-routed videos, and HTTPDNS auto-detection scoring; v1.3.1 fixed a silent failure where the settings panel could permanently fail to appear; v1.3.2 added the one-click diagnostic report. **Do not use v1.2.1** — it was unstable in real-world playback.

**License:** MIT, provided as-is with no guarantee it improves every network environment.
