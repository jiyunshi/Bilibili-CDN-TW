# Bilibili CDN 台灣優化

[![version](https://img.shields.io/badge/version-1.4.0-3f8fa3?style=flat-square)](./CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-4f7d4d?style=flat-square)](./LICENSE) ![runtime](https://img.shields.io/badge/runtime-Tampermonkey-a5701f?style=flat-square) ![dependencies](https://img.shields.io/badge/dependencies-zero-4f7d4d?style=flat-square)

**在台灣觀看 Bilibili 時，自動挑選連線較順暢的影片伺服器，減少轉圈與卡頓。**

語言：繁體中文 ｜ [English](#english)

---

## 目錄

- [簡介](#簡介)
- [安裝](#安裝)
- [確認是否正常運作](#確認是否正常運作)
- [常見問題](#常見問題)
- [版本沿革](#版本沿革)
- [進階參考](#進階參考)（一般使用者不需閱讀）
- [授權](#授權)

---

## 簡介

### 為什麼在台灣觀看 B 站容易卡頓？

B 站的影片並不是一次下載完成，而是切成許多數秒長的小段，邊播放邊下載。這些小段存放在**許多不同地點的伺服器**上，有的在香港，有的在中國大陸各地，也有國際廠商的伺服器。

從台灣連線到這些伺服器，速度差異非常大：有些很快，有些很慢，有些甚至完全連不上。B 站的播放器不會特別替台灣的使用者挑選，被分配到較慢的伺服器時，只會反覆重試。使用者看到的就是**轉圈圈、黑畫面，或畫質自動下降**。

冷門影片的情況通常更嚴重。熱門影片因為觀看的人多，伺服器上已經有現成的檔案，下載很快；冷門影片則需要伺服器先從遠端取得檔案，第一段就可能要等好幾秒。

### 這個腳本能做什麼？

本腳本在您的瀏覽器中運作，**替您挑選連線較快的伺服器**：

| 功能 | 說明 |
| :--- | :--- |
| **自動測速** | 在背景測量各伺服器在您網路上的速度，並優先使用最快的伺服器。 |
| **開播時同時嘗試兩條線路** | 影片剛開始播放時，同時向兩台伺服器下載第一段，採用先完成的那一台，減少等待。 |
| **下載太慢時提早更換** | 某一段下載速度明顯跟不上播放時，在畫面卡住之前就改由其他伺服器下載。 |
| **卡住時自動更換** | 畫面真的卡住時，自動避開造成問題的伺服器，不需要重新整理頁面。 |
| **保留備用線路** | 備用線路會分散在不同地點，即使某個地點的伺服器全部故障，仍有其他線路可用。 |
| **越用越準確** | 記住每台伺服器的表現，下次開啟影片時直接使用表現最好的伺服器。 |

在台灣實際測試的結果：冷門影片從點下播放到開始播放的時間，由 **3～9 秒縮短為約 1 秒**。

| 可以做到 | 無法做到 |
| :--- | :--- |
| 自動避開在台灣很慢或連不上的伺服器 | 解鎖大會員影片或付費內容 |
| 播放中卡住時自動更換線路 | 繞過地區限制或登入限制 |
| 一般影片、番劇、4K、拖曳進度條、切換畫質、同時開啟多個分頁皆有處理 | 提升您網路本身的速度 |
| 不需要帳號，也不需要任何設定 | — |

> **注意**　如果您的網路本身速度不足（例如家中網路無法負荷 4K），更換伺服器也無法改善，請先調低畫質。
>
> **隱私**　本腳本不會將任何資料傳送到其他地方。它只記錄「哪台伺服器快、哪台伺服器慢」，而且只儲存在您自己的瀏覽器中。

---

## 安裝

本腳本需要透過瀏覽器擴充功能 **Tampermonkey**（一種用來執行小型網頁腳本的工具）來使用。

| 步驟 | 操作方式 |
| :--: | :--- |
| **1** | 安裝 Tampermonkey：Chrome、Edge、Brave 使用者請至「Chrome 線上應用程式商店」搜尋 Tampermonkey；Firefox 使用者請至「附加元件」搜尋。 |
| **2** | 安裝本腳本：前往 [Greasy Fork 的腳本頁面](https://greasyfork.org/scripts/579776) 點選「安裝此腳本」，Tampermonkey 會顯示安裝畫面，確認即可。也可以在 Tampermonkey 中新增空白腳本，將 `bilibili-cdn-tw.user.js` 的內容完整貼上後儲存。 |
| **3** | 關閉所有已開啟的 Bilibili 分頁，再重新開啟影片頁面。 |

支援一般影片、番劇、電影、紀錄片、國創、綜藝、課程、賽事等 `www.bilibili.com` 上的播放頁面。

### Chrome 與 Edge 使用者請務必完成這一步

新版 Chrome 與 Edge 需要額外允許，Tampermonkey 才能執行腳本。**如果安裝後完全看不到下一節所說的狀態區塊，通常就是缺少這個設定。**

1. 在網址列輸入 `chrome://extensions`（Edge 為 `edge://extensions`）並按 Enter。
2. 找到 Tampermonkey，點選 **「詳細資料」**。
3. 開啟 **「允許使用者指令碼」**。
4. 重新整理 Bilibili 頁面。

這是瀏覽器本身的權限設定，腳本無法自行開啟。

---

## 確認是否正常運作

點選播放器右下角的**齒輪（設定）圖示**，選單最下方會出現一個狀態區塊，內容類似：

```text
☑ 攔截修改影片 CDN
白名單：cn-hk-eq-01-05 > upos-sz-mirroraliov > cn-hk-eq-01-03 > …
緩衝：21.21/20.00MB (100%) | buf=180s ✓達標
測速：35 秒前完成，量了 3 個節點 → cn-hk-eq-01-05
```

各列的意思如下：

| 項目 | 說明 |
| :--- | :--- |
| ☑ 攔截修改影片 CDN | 腳本正在運作。取消勾選即可暫時停用。 |
| 白名單 | 腳本目前挑選的伺服器順序，排在第一位的就是正在使用的伺服器。 |
| 緩衝 | 已經預先下載了多少影片。顯示「✓達標」表示存量足夠，不容易卡頓。切換畫質後會重新計算，並標示「（切換畫質後）」。 |
| 測速 | 最近一次測速的時間、原因，以及選出的伺服器。 |

**有勾選，且緩衝顯示達標，就代表運作正常。**

如果齒輪選單中**完全沒有**這個區塊（不是沒有勾選，而是整個區塊不存在），請回到上一節，確認 Tampermonkey 的「允許使用者指令碼」已經開啟。

---

## 常見問題

### 播放仍然卡頓怎麼辦？

請依序嘗試：

1. 重新整理頁面。
2. 將畫質調低一個等級。
3. 關閉 VPN，或更換 VPN 的連線地點。
4. 重新啟動瀏覽器。

### 更換了網路、VPN 或手機熱點之後變慢

腳本記住的伺服器表現，是在先前的網路環境中學到的，換了網路之後可能不再準確。請清除學習紀錄，讓腳本重新學習：

- **方法一（建議）**：點選瀏覽器右上角的 Tampermonkey 圖示，在本腳本的選單中點選 **「🔄 重置所有學習狀態」**。
- **方法二**：按鍵盤 `F12` 開啟開發者工具，切換到「Console（主控台）」分頁，輸入以下內容並按 Enter：

```js
BiliCDN.reset(); location.reload()
```

### 如何暫時停用？

在狀態區塊中取消勾選「攔截修改影片 CDN」，或在 Tampermonkey 中停用整個腳本。

### 如何回報問題？

點選狀態區塊中的 **「複製診斷」**，腳本會產生一份**不含個人資料**的文字報告並複製下來，直接貼給開發者即可，不需要另外截圖。

**歡迎提供不同網路環境的回報**：目前所有測試數據都來自同一條家用網路。如果您使用的是其他電信業者、學校或公司網路、手機網路，即使播放正常，也歡迎到 GitHub Issues 貼上一份診斷報告，並註明電信業者與大概地區。哪些伺服器在您的網路上快、哪些連不上，正是改善本腳本最需要、也最缺少的資料。

---

## 版本沿革

完整的變更內容請參閱 [`CHANGELOG.md`](./CHANGELOG.md)。**目前建議使用 `v1.4.0`。**

| 版本 | 重點 |
| :--- | :--- |
| **v1.4.0** | **從「卡住之後再換」改為「事先避免卡住」。** 影片剛開始播放時，同時向兩台伺服器下載第一段，採用先完成的那一台；某一段下載太慢、來不及在預先下載的影片播完前完成時，提早改由其他伺服器下載；只有在畫面真的卡住時才判定伺服器有問題，不再於影片結尾或切換畫質時誤判。番劇切換集數與片頭、MP4 格式的影片，也改由實測較快的伺服器提供。備用線路改為分散在不同地點，香港的伺服器即使同時故障也有其他線路可用。模擬測試中，4K 每 30 分鐘的卡頓時間由約 1,491 秒降至約 8 秒。另移除一項經長期量測證實沒有作用的功能。 |
| **v1.3.7** | **修正每個分頁只有第一支影片有被優化的問題**：之後切換影片、播放合集下一集、自動連播、切換 Hi-Res 或杜比音軌時，過去都沒有經過腳本處理。切換畫質或音軌時不再誤判伺服器卡住；切換畫質後會立刻重新計算緩衝並重新測速，設定面板新增「測速」狀態列。卡住時改為處理真正造成卡頓的伺服器。 |
| **v1.3.6** | 冷門影片的開播時間由約 3～9 秒縮短為約 1 秒：已有測速紀錄時，改由實測夠快的伺服器（多為香港）提供影片；測速紀錄可沿用約一至兩天。測速時完全沒有回應的伺服器改排到最後。 |
| **v1.3.5** | 依實際量測結果全面調整伺服器的挑選方式。新增 3 台香港伺服器；修正測速只量到快取速度的問題；修正筆電休眠或切換網路後，正常的伺服器被整批誤判為故障長達 30 天的問題（並自動救回已被誤判的伺服器）。新增離線測試。 |
| **v1.3.4** | 補上遺漏的播放頁面（播放清單、稍後再看等），這些頁面過去完全不會啟動腳本；並修正多項網路處理的穩定性問題。 |
| **v1.3.3** | 專門處理「某些影片特別慢」的問題，修正多項測速與卡頓判斷的錯誤，並將候選伺服器由 3 台擴充為 7 台。 |
| **v1.3.1** | 修正設定面板可能永遠不出現的問題；新增一鍵診斷報告。 |
| **v1.3.0** | 伺服器挑選核心大幅修正，並新增 Tampermonkey 選單指令。 |

> **關於 v1.3.2**　此版號曾短暫發布後撤回，內容與現行版本完全不同。依本專案規則（版號一經發布，即不得用於不同內容），之後的版本改用 `v1.3.3`。
>
> **關於 v1.3.8**　此版號從未發布。原規劃的內容併入 `v1.4.0`。
>
> **請勿繼續使用 v1.2.1**　該版本經實際使用後證實不穩定，會出現無法播放、4K 沒有畫面等問題。

---

## 進階參考

**一般使用者不需要閱讀本節。** 以下內容提供給想了解運作原理、或需要手動調整的使用者。

### 名詞說明

| 名詞 | 意思 |
| :--- | :--- |
| **CDN／節點** | 存放影片的伺服器。B 站在各地設有許多台，本文中「節點」即指其中一台。 |
| **白名單** | 腳本認為可以使用、並依速度排好順序的節點清單。 |
| **Akamai** | 一家國際 CDN 廠商。B 站分配給台灣的線路經常是它；熱門影片很快，冷門影片很慢。 |
| **緩衝** | 已經預先下載、還沒播放到的影片長度。緩衝越多，越不容易卡頓。 |
| **片段** | 影片被切成的小段，每段約數秒。 |
| **主線路／備用線路** | 播放器優先使用的網址，以及主線路失敗時依序嘗試的其他網址。 |

### 運作原理

B 站的播放器在開始播放前，會先向 B 站取得一份「播放資訊」，裡面列出每個畫質的影片與音訊要從哪個網址下載，包含一條主線路與一至兩條備用線路。腳本在網頁載入的最早階段就開始運作，主要做以下幾件事：

| 機制 | 說明 |
| :--- | :--- |
| **改寫播放資訊** | 把主線路與備用線路改成實測較快的節點。涵蓋網頁載入時內嵌的資訊，以及之後播放器自行取得的資訊（切換影片、合集下一集、切換音軌、番劇換集與片頭）。 |
| **測速** | 用真實的影片網址，在檔案中後段的隨機位置向各節點下載一小段來測量速度（固定從檔案開頭測量，量到的會是快取速度，不準確）。 |
| **評分** | 依各節點的平均速度、穩定度、延遲與失敗次數計算分數；速度超過影片所需時仍分得出快慢。目前使用中的節點享有些許優勢，避免來回切換。 |
| **主線路的選擇** | 4K 與 MP4／FLV 影片一律以白名單節點為主。一般畫質在白名單節點有足夠的測速證據時以白名單為主，Akamai 改為第一條備用線路；沒有證據時維持 Akamai，交由「起播賽跑」決定。 |
| **起播賽跑** | 主線路是 Akamai 時，每條影片或音訊軌的第一段，同時向 Akamai 與最快的白名單節點各下載開頭 256KB，採用先完成的一方。最多等待 1.2 秒，以免超過播放器「2 秒內沒有收到資料就換線路」的限制。 |
| **慢片段補發** | 某一段已經下載 1.5 秒以上、緩衝不到 6 秒、照目前速度來不及在緩衝用完前下載完，而且目前速度低於影片所需時，讓這次下載提前結束；播放器會自動重新下載同一段，腳本把它導向其他節點。同一節點 8 秒內不重複處理，所有節點合計 30 秒內最多處理 3 次。 |
| **卡頓監測** | 只有在播放器真的在等待資料（畫面無法繼續、前方緩衝不到 1 秒）連續 2～3 秒時，才判定節點有問題，並處理「等待最久仍未下載完成」的那一段所在的節點。拖曳進度條、切換畫質、播放器清除緩衝、剛更換節點時都有保護時間。 |
| **備用線路分散** | 第一條白名單備用線路必須與主線路位於不同機房，避免同一地點故障時全部失效。 |
| **故障判定** | 判定節點連不上之前，會同時測試一個已知速度快的節點作為對照；兩者都連不上時，視為您自己的網路斷線，不會誤判節點故障。連不上的節點每 6 小時自動重新檢查。 |
| **多分頁** | 測速的冷卻時間記錄在 Tampermonkey 的共用儲存空間，同時開啟多個分頁時也只有一個分頁在測速。 |

每項判斷所依據的實際量測數據，以及曾經嘗試但被推翻的做法，都記錄在 [`CHANGELOG.md`](./CHANGELOG.md) 各版本的說明中。

### Tampermonkey 選單

大部分操作不需要使用開發者工具。點選 Tampermonkey 圖示，在本腳本的選單中即可使用：

| 選單項目 | 作用 |
| :--- | :--- |
| 🔄 重置所有學習狀態 | 清除全部學習紀錄並重新整理頁面。 |
| 📊 顯示診斷資訊 | 在主控台輸出目前各節點的狀態與分數。 |
| 🏁 立即測速選節點 | 立刻執行一次測速。 |
| 🔍 開啟／關閉詳細記錄 | 切換是否在主控台輸出詳細的運作紀錄。 |
| 🌐 HTTPDNS 狀態 | 顯示 HTTPDNS（B 站自有的網址查詢服務）的攔截判定結果。 |

### 主控台指令

按 `F12` 開啟開發者工具，切換到「Console（主控台）」分頁後即可使用。

**查看狀態**

| 指令 | 作用 |
| :--- | :--- |
| `BiliCDN.diag()` | 完整狀態：候選順序、被排除與故障的節點、各節點分數、最近的起播賽跑結果、判斷斷線時使用的對照節點。 |
| `BiliCDN.buf()` | 緩衝與下載狀態：緩衝秒數、下載速度、更換節點次數、正在下載的片段、目前是否在判定卡頓（或不判定的原因）、最近的卡頓判定與慢片段補發紀錄。 |
| `BiliCDN.stats()` | 網址改寫的統計數字。 |
| `BiliCDN.report()` | 產生文字診斷報告並複製到剪貼簿（與狀態區塊的「複製診斷」相同）。 |

**管理學習紀錄**

| 指令 | 作用 |
| :--- | :--- |
| `BiliCDN.reset()` | 清除全部學習紀錄。 |
| `BiliCDN.clearDead()` | 只清除記住的故障節點，適合更換網路後使用。 |
| `BiliCDN.clearSoft()` | 清除本次使用期間暫時避開的節點。 |
| `BiliCDN.revive("ali")` | 單獨恢復某個被誤判的節點，不影響其他學習紀錄。 |

**手動操作與設定**

| 指令 | 作用 |
| :--- | :--- |
| `BiliCDN.probe()` | 重新測量各節點的延遲。 |
| `BiliCDN.bakeoff()` | 立刻執行一次測速（請先播放數秒）。 |
| `BiliCDN.setCdn("<節點名稱>")` | 固定使用指定節點；`BiliCDN.setCdn("null")` 恢復自動選擇。 |
| `BiliCDN.exclude("關鍵字")` | 排除名稱含有該關鍵字的節點；`BiliCDN.include("關鍵字")` 取消排除。 |
| `BiliCDN.verbose(true)` | 開啟詳細記錄。 |
| `BiliCDN.hedgeTest()` | 測試用：接下來 30 秒內，把第一個下載超過 0.15 秒的片段當成慢片段處理一次，用來確認慢片段補發的流程。 |

### 腳本設定

腳本開頭有以下設定，一般情況下不需要修改：

```js
var CustomCDN = ''                   // 留空 = 自動選擇（建議）；填入節點名稱 = 固定使用該節點
var ExcludeHostKeywords = ['cosov']  // 名稱含有這些字的節點不使用（預設避開實測不穩定的 cosov）
var BlockHttpDNS = 'auto'            // 'auto' 自動判斷／true 一律阻擋／false 一律允許
var PreferredVideoCodec = 'hevc'     // 4K 優先使用 HEVC 格式以節省流量；電腦不支援時自動改用 AVC
var BlockWebRTC = true               // 阻擋 WebRTC 點對點連線，避免拖慢跨國連線
```

### 支援範圍

| 項目 | 說明 |
| :--- | :--- |
| **腳本管理工具** | 建議使用 Tampermonkey；Violentmonkey 大多數情況可用。 |
| **不支援** | Greasemonkey 4 以上版本、`m.bilibili.com` 手機版網頁、Bilibili App、Bilibili 以外的網站。 |
| **手機版網頁** | `m.bilibili.com` 只提供單一 720P 影片，網址綁定特定伺服器，更換伺服器可能導致無法播放，可改善的空間也很小，因此刻意不支援。 |
| **手機與平板** | Android 上支援擴充功能的瀏覽器（例如 Firefox、Edge）可安裝 Tampermonkey，並需切換為「電腦版網站」；iPhone 與 iPad 可試用 Safari 版 Tampermonkey，同樣需切換為電腦版網站。**以上皆尚未實際測試。** |
| **杜比全景聲／杜比視界** | 腳本會改寫這兩種格式的下載網址（實測改寫後可以正常下載），但需要瀏覽器本身支援才能播放；開發測試使用的 Edge 不支援，**尚未實際播放驗證**。 |
| **無法處理** | 大會員內容、登入限制、地區限制。 |

### 隱私說明

本腳本不會將任何資料上傳到任何伺服器。儲存在您電腦中的內容只有各節點的表現紀錄（例如某節點最近是否不穩定），用途是讓下次能更快避開有問題的節點。

### 開發者：離線測試

需要 Node.js 18 以上版本，不需要安裝其他套件：

```bash
node --test tests/run.test.js
```

測試會把腳本載入 Node.js 的隔離環境，直接驗證內部函式的行為，不需要開啟瀏覽器。`node tests/sim.js` 是選路模擬器，以實測的節點數據模擬 30 分鐘播放，比較卡頓秒數與更換節點次數，執行約需數分鐘。發布前的實機檢查步驟記錄在 [`tests/manual-checklist.md`](./tests/manual-checklist.md)。

---

## 授權

MIT License。本軟體依現況提供，不保證能改善所有網路環境。使用時請自行確認符合所在地法律規範與 Bilibili 服務條款。

作者 `jiyunshi` ・ <span>chocosensei214</span><span>&#64;</span><span>gmail</span><span>&#46;</span><span>com</span>

---

## English

[![version](https://img.shields.io/badge/version-1.4.0-3f8fa3?style=flat-square)](./CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-4f7d4d?style=flat-square)](./LICENSE) ![runtime](https://img.shields.io/badge/runtime-Tampermonkey-a5701f?style=flat-square)

**Automatically picks faster video servers when watching Bilibili from Taiwan, so videos spin and stall less.**

Language: [繁體中文](#bilibili-cdn-台灣優化) ｜ English

### Overview

A Bilibili video is not downloaded all at once. It is split into short pieces, each a few seconds long, that are downloaded as you watch. Those pieces live on **many servers in different places** — Hong Kong, various cities in mainland China, and international providers. From Taiwan, some are fast, some are slow, and some cannot be reached at all. The player does not choose with Taiwanese viewers in mind; when it lands on a slow server it just keeps retrying, which you see as a spinning wheel, a black screen, or the picture quality dropping by itself. Unpopular videos suffer most, because the server has to fetch them from far away first.

This script runs in your browser and **picks the server for you**:

- **Tests speed in the background** and prefers whichever server is fastest on your connection.
- **Tries two servers at once when a video starts**, and uses whichever delivers the first piece sooner.
- **Switches early** when a piece is downloading too slowly to arrive before the video catches up to it.
- **Switches automatically** if playback actually stalls, without a page reload.
- **Keeps backups in different locations**, so a whole site going down still leaves a working route.
- **Learns over time** and remembers which servers perform well.

Measured from Taiwan: unpopular videos now start in **about 1 second instead of 3–9**.

| It does | It does not |
| :--- | :--- |
| Avoid servers that are slow or unreachable from Taiwan | Unlock paid or membership-only content |
| Switch automatically when playback cannot keep up | Bypass region or login restrictions |
| Handle regular videos, bangumi, 4K, seeking, quality changes and multiple tabs | Make your internet connection itself faster |

> **Note**　If your connection cannot sustain 4K, changing servers will not help — lower the quality instead.
>
> **Privacy**　Nothing is sent anywhere. The script only remembers which servers were fast or slow, stored in your own browser.

### Installation

1. Install the **Tampermonkey** browser extension from your browser's extension store.
2. Open the [Greasy Fork script page](https://greasyfork.org/scripts/579776) and click Install; Tampermonkey will show its install screen. Alternatively, create a blank script in Tampermonkey and paste the full contents of `bilibili-cdn-tw.user.js`.
3. Close any open Bilibili tabs and open a video page again.

**Chrome / Edge users:** newer versions require explicit permission for Tampermonkey to run scripts. If the status block described below never appears, go to `chrome://extensions` (or `edge://extensions`) → Tampermonkey → **Details** → turn on **"Allow User Scripts"**, then reload the page.

### Checking That It Works

Click the gear (settings) icon in the player's lower-right corner. A status block appears at the bottom showing the server order in use, how much video is already downloaded ahead, and the last speed test. If it is checked and the buffer shows "✓達標" (target reached), it is working. If the block is missing entirely, the permission above is most likely not enabled.

### Troubleshooting

If playback still stalls, try in order: reload the page, lower the quality one step, turn off or change your VPN location, restart the browser.

After switching networks, VPN, or a mobile hotspot, what the script learned may no longer apply. Click the Tampermonkey icon and choose **"🔄 重置所有學習狀態"** (reset all learned data), or press `F12`, open the Console tab and run:

```js
BiliCDN.reset(); location.reload()
```

To report a problem, click **"複製診斷"** (copy diagnostics) in the status block and paste the result into a GitHub issue; it contains no personal information. Reports from other ISPs and networks are especially welcome, even if playback works fine.

### How It Works (Technical)

Bilibili plays DASH streams: before playback the player fetches "playback info" listing a primary URL and backup URLs for each video and audio stream, pointing at different CDN nodes (upos mirrors, Hong Kong BCache, Akamai). From Taiwan these range from sub-10 ms edges to hosts that are unreachable; Akamai is fast only when a segment is in its edge cache. The script rewrites that playback info at `document-start` — including the copies the player fetches itself on video switches, audio-track toggles, bangumi episode changes and bangumi pre-rolls, some via protocol-relative URLs — and also rewrites segment requests (XHR and fetch). It ranks nodes with a discounted-UCB score over throughput EWMAs; uses whitelist nodes as primary for 4K, for single-file MP4/FLV streams, and whenever there is measured evidence they can sustain 3× the stream bitrate; otherwise races Akamai against the best whitelist node on the first segment of each track and sends the real request to whichever delivers 256 KB first; lets a segment that is downloading slower than the stream bitrate and cannot finish before the buffer runs out time out early, so the player's own retry lands on another node (per-host 8 s cooldown, at most 3 times per 30 s overall); penalizes a node only when playback is genuinely starving (`readyState` < 3 with under 1 s buffered), and then the node actually holding up the buffer; places the first whitelist backup in a different site from the primary; and requires a fast, healthy control host to be reachable before marking any node dead. See [`CHANGELOG.md`](./CHANGELOG.md) for the measurements behind each decision.

**Useful console commands**

| Command | Purpose |
| :--- | :--- |
| `BiliCDN.diag()` | Full state: candidate order, excluded and dead nodes, per-node scores, recent startup races |
| `BiliCDN.buf()` | Buffer level, throughput, switch count, in-flight segments, stall checks, recent penalties and slow-segment hedges |
| `BiliCDN.probe()` | Re-measure node latency |
| `BiliCDN.bakeoff()` | Run a throughput test |
| `BiliCDN.clearDead()` | Clear remembered dead nodes |
| `BiliCDN.report()` | Copy a privacy-safe diagnostic report |

### Releases

See [`CHANGELOG.md`](./CHANGELOG.md). **`v1.4.0` is the recommended release.**

| Version | Highlights |
| :--- | :--- |
| **v1.4.0** | **Moves from "switch after it stalls" to "avoid the stall in the first place."** When a video starts, the first piece is requested from two servers at once and the faster one wins; a piece downloading too slowly to arrive in time is moved to another server before the picture freezes; and a server is only blamed when playback has genuinely stopped, so the end of a video or a quality change no longer counts as a stall. Bangumi episode changes and pre-rolls, and MP4-format videos, are now served from servers measured to be fast. Backups are spread across different locations, so even a simultaneous failure of all Hong Kong servers leaves another route. In simulation, 4K stalling drops from about 1,491 to about 8 seconds per 30 minutes. A feature that long-term measurement showed never did anything (Worker interception) has been removed. |
| **v1.3.7** | **Fixes optimization applying only to the first video in each tab**: video switches, the next item in a collection, autoplay, and Hi-Res / Dolby audio toggles previously bypassed the script. Quality or audio-track switches are no longer mistaken for a stalled server; switching resolution immediately recalculates the buffer and re-tests speed. On a stall, the server actually holding up playback is the one penalized. |
| **v1.3.6** | Unpopular videos start in about 1 second instead of 3–9: once speed data exists, normal-resolution streams are also served from a server measured to be fast enough (usually Hong Kong). Servers that never respond during speed tests are moved to the back of the queue. |
| **v1.3.5** | Server selection reworked around real-world measurements: three Hong Kong servers added; speed tests no longer measure only cached data; good servers are no longer marked dead for 30 days after a laptop sleeps or switches networks. Offline tests added. |
| **v1.3.4** | Added missing playback pages (playlists, watch later and others) that previously never loaded the script, and fixed several network-handling robustness issues. |
| **v1.3.3** | Targets "some videos are just slow": fixes several speed-measurement and stall-detection errors and expands the candidate pool from 3 servers to 7. |
| **v1.3.1** | Fixed the settings panel sometimes never appearing; added the one-click diagnostic report. |
| **v1.3.0** | Core server-selection overhaul and Tampermonkey menu commands. |

> **On v1.3.2**　That version number was briefly published and then withdrawn; its contents differ entirely from later releases. Per this project's rule that a published version number is never reused for different content, the next release was `v1.3.3`.
>
> **On v1.3.8**　This version number was never published; its planned contents shipped in `v1.4.0`.
>
> **Do not use v1.2.1**　It proved unstable in real-world use (playback failures and 4K showing no picture).

### Licence

MIT. Provided as-is, with no guarantee that it improves every network environment. Please make sure your use complies with local law and Bilibili's terms of service.
