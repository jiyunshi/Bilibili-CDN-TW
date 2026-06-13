[README.md](https://github.com/user-attachments/files/28915727/README.md)
# Bilibili CDN 台灣優化

<a name="zh-tw"></a>
<a name="chinese"></a>

給台灣使用者看的 Bilibili 影片 CDN 自動切換腳本。  
它會在播放影片時自動避開比較慢、容易斷線、黑畫面或卡頓的影片節點，並改用目前比較順的節點。

版本：`1.2.2`  
作者：`Mittag`  
聯絡信箱：<span>chocosensei214</span><span>&#64;</span><span>gmail</span><span>&#46;</span><span>com</span>

語言：[繁體中文](#zh-tw) | [English](#english)

---

## 這是什麼？

Bilibili 播影片時，影片資料會從不同 CDN 節點下載。  
有些節點在台灣很順，有些節點會很慢、連不上、黑畫面，或播放 4K 時一直轉圈。

這個腳本會自動幫你：

- 避開台灣常見不穩的 Bilibili 影片 CDN。
- 開播後測一下實際下載速度，挑比較快的節點。
- 播放中如果下載速度跟不上，會自動換節點。
- 看 4K、高碼率、HEVC、AV1 時，會更早判斷節點是否載不動。
- 拖時間軸時減少重拉與反覆卡住。
- 切到背景分頁後，影片仍盡量持續載入。
- 多開 Bilibili 分頁時，避免每個分頁同時測速互搶頻寬。

你不需要懂 CDN，也不需要手動設定。安裝後重新整理 Bilibili 影片頁即可。

---

## 這不能做什麼？

這不是破解工具。

- 不能解鎖會員影片。
- 不能繞過地區限制。
- 不能繞過登入或授權檢查。
- 不能讓你的網路變快。

如果你的實際網速本來就不夠播放 4K，換 CDN 也無法完全解決，請先降畫質。

---

## 安裝方式

### 1. 安裝 Tampermonkey

先在瀏覽器安裝 Tampermonkey。

- Chrome / Edge / Brave：到 Chrome 線上應用程式商店搜尋 `Tampermonkey`。
- Firefox：到 Firefox Add-ons 搜尋 `Tampermonkey`。

### 2. 安裝腳本

使用 `bili-tw-opt.js` 安裝，或在 Tampermonkey 新增腳本後貼上 `bili-tw-opt.js` 的完整內容並儲存。

### 3. 重新打開 Bilibili 影片頁

建議安裝後先關掉舊的 Bilibili 分頁，再重新打開影片。

支援常見 Bilibili 播放頁，例如：

- `www.bilibili.com/video/*`
- `www.bilibili.com/bangumi/play/*`
- 番劇、電影、紀錄片、課程等播放頁

---

## 一般使用方式

正常情況下不用操作。

1. 開啟 Bilibili 影片頁。
2. 選擇你要看的畫質。
3. 讓腳本自動選 CDN。

腳本預設不會一直跳提示，也不會一直輸出 log。

---

## 如何確認有沒有生效？

在 Bilibili 影片頁右下角點播放器齒輪，設定面板底部會多出 CDN 狀態區塊。

你會看到類似：

```text
☑ 攔截修改影片CDN
白名單：aliov > ali > cos
緩衝：21.21/20.00MB (100%) | buf=180s ✓達標
持久死節點（7d）：hwov, hw, hz-aliov
HTTPDNS：auto / block
```

簡單看這幾個就好：

- `攔截修改影片CDN` 有勾選：代表腳本正在運作。
- `緩衝` 達標：代表目前下載狀況大致足夠。
- `持久死節點`：代表腳本已記住近期不適合你網路的節點，之後會先避開。

---

## 常見情境

### 開播時

腳本會先使用目前排序較好的節點。播放幾秒後，會依實際下載速度重新判斷，如果有更好的 CDN，後續影片片段會自動改用它。

### 看 4K 或高畫質

4K 需要的下載速度比較高。腳本會多留一些緩衝，並更早切換跟不上的節點。

如果還是一直轉圈，通常代表：

- 目前網速不夠 4K。
- Wi-Fi 或 VPN 不穩。
- Bilibili 當下服務不穩。
- 瀏覽器硬體解碼不順。

這時建議先降一階畫質。

### 拖時間軸

拖時間軸時，腳本會暫時避免換 CDN 和測速，減少播放器重拉片段造成的卡頓。

### 切到背景分頁

腳本會讓影片盡量繼續載入，減少切回來時重新加載。背景分頁不會主動測速，以免浪費頻寬。

### 多開分頁

多個 Bilibili 分頁同時播放時，腳本會協調測速，避免每個分頁一起測速互搶頻寬。

---

## 卡頓時先做什麼？

照順序試：

1. 重新整理影片頁。
2. 降一階畫質。
3. 關掉 VPN，或換另一個 VPN 節點。
4. 重開瀏覽器。
5. 如果你剛換網路、VPN、手機熱點，請清除舊紀錄。

清除舊紀錄需要開啟瀏覽器開發者工具，在 `Console` 輸入：

```js
BiliCDN.reset()
location.reload()
```

這會清掉腳本記住的 CDN 狀態，讓它重新學習目前網路環境。

---

## 重要指令

一般使用者通常不需要用指令。只有排查問題時才需要。

開啟方式：按 `F12`，切到 `Console`，輸入指令。

### 查看目前狀態

```js
BiliCDN.diag()
```

### 查看緩衝與下載速度

```js
BiliCDN.buf()
```

### 手動測速並重新挑 CDN

請先播放影片幾秒，再輸入：

```js
BiliCDN.bakeoff()
```

### 清除死節點紀錄

換網路、VPN、手機熱點後可以用：

```js
BiliCDN.clearDead()
location.reload()
```

### 全部重置

遇到狀態怪怪的、不知道怎麼判斷時用：

```js
BiliCDN.reset()
location.reload()
```

---

## 想暫時關閉

有兩種方式：

- 在播放器齒輪設定底部，取消勾選 `攔截修改影片CDN`。
- 到 Tampermonkey 面板停用這個腳本。

---

## 預設設定

一般使用者不用改。

```js
var CustomCDN = ''
var ExcludeHostKeywords = ['cosov']
var BlockHttpDNS = 'auto'
var PreferredVideoCodec = 'hevc'
```

簡單說：

- `CustomCDN = ''`：自動選 CDN，推薦。
- `ExcludeHostKeywords = ['cosov']`：避開部分台灣網路上較不穩的 cosov 類節點。
- `BlockHttpDNS = 'auto'`：自動判斷是否阻擋 HTTPDNS。
- `PreferredVideoCodec = 'hevc'`：優先使用 HEVC，通常比較省頻寬，適合高畫質。

---

## 支援範圍

支援：

- Tampermonkey。
- Violentmonkey 多數情況可用。
- `www.bilibili.com` 常見播放頁。

不支援：

- Greasemonkey 4+。
- `m.bilibili.com` 手機版網頁。
- 非 Bilibili 網站。
- 會員、登入、地區或授權限制繞過。

---

## 更新紀錄

版本變更請看 [`CHANGELOG.md`](./CHANGELOG.md)。

**v1.2.2** 為目前推薦版本：已回滾 v1.2.0 穩定邏輯。**請勿繼續使用 v1.2.1**（對外發布後實測不穩定，可能出現 403、CORS、4K 無畫面、cosov HTTP/2 錯誤等問題）。

---

## 隱私

腳本不會把你的資料上傳到第三方伺服器。

它只會在 Tampermonkey 本機儲存少量狀態，例如：

- 是否開啟詳細 log。
- 固定 CDN 設定。
- 近期失敗或不可用的 CDN。
- CDN 速度與健康分數。
- HTTPDNS 自動判斷結果。

這些資料只用來讓腳本下次更快避開不穩節點。

---

## 授權與聲明

本腳本採用 **MIT License** 發布，腳本 metadata 內含 `// @license MIT`。

本腳本依現況提供，不保證一定改善所有網路環境。使用者需自行確認符合所在地法律、Bilibili 服務條款，以及所使用瀏覽器與 userscript 管理器的規範。

---

<a name="english"></a>
<a name="en"></a>

## English

[繁體中文](#zh-tw)

Bilibili CDN Taiwan Optimization is a userscript for improving Bilibili video playback under Taiwan network conditions. It automatically avoids unstable video CDN nodes and switches to faster ones based on real download speed.

Version: `1.2.2`  
Author: `Mittag`  
Contact: <span>chocosensei214</span><span>&#64;</span><span>gmail</span><span>&#46;</span><span>com</span>

### What It Does

- Avoids unstable Bilibili video CDN nodes.
- Measures real video segment download speed.
- Switches CDN automatically when playback cannot keep up.
- Improves 4K and high-bitrate playback stability.
- Keeps video loading when the tab is in the background.
- Coordinates speed tests across multiple tabs.

This script does not unlock paid videos, bypass region restrictions, or increase your actual bandwidth.

### Installation

1. Install Tampermonkey.
2. Install `bili-tw-opt.js`, or paste the full file into a new Tampermonkey script.
3. Close old Bilibili tabs and reopen a video page.

### Basic Usage

No manual action is required. Open a Bilibili video page, choose the quality, and let the script work automatically.

To confirm it is active, open the player settings from the gear icon. A CDN status panel should appear near the bottom.

### Troubleshooting

If playback still buffers:

1. Reload the video page.
2. Lower the video quality.
3. Disable VPN or try another VPN node.
4. Restart the browser.
5. If you changed network or VPN, reset the learned state:

```js
BiliCDN.reset()
location.reload()
```

Useful console commands:

```js
BiliCDN.diag()
BiliCDN.buf()
BiliCDN.bakeoff()
BiliCDN.clearDead()
BiliCDN.reset()
```

### Changelog

See [`CHANGELOG.md`](./CHANGELOG.md).

**v1.2.2** is the recommended release (rolled back to v1.2.0 stable logic). **Do not use v1.2.1** — it was unstable in real-world playback (403, CORS, 4K no video, cosov HTTP/2 errors).

### License

Released under the **MIT License**. Provided as-is, with no guarantee that it will improve every network environment.
