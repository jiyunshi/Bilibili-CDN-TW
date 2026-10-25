# 實機驗證清單

離線測試（`node --test tests/run.test.js`）只能驗證「程式照我們的假設運作」。假設本身錯了，離線測試會跟著一起錯——
v1.3.6 以前「每個分頁只有第一支片被優化」就是這樣存在了好幾個版本：所有實機驗證都用整頁載入開影片，而播放器
自己換片時發的請求格式不一樣。所以發版前，**下面每一種「播放資訊的來源」都要實際走過一次**。

## 怎麼判斷有沒有生效

在影片頁的開發者工具 Console：

```js
// 先清空資源紀錄，再做操作
performance.clearResourceTimings(); performance.setResourceTimingBufferSize(5000)
// 操作完之後，看片段來自哪些主機
const n = {}; performance.getEntriesByType('resource')
  .filter(e => /\.m4s/.test(new URL(e.name).pathname))
  .forEach(e => { const h = new URL(e.name).hostname.split('.')[0]; n[h] = (n[h] || 0) + 1 }); n
```

- **通過**：片段主要來自白名單節點（`cn-hk-eq-01-*`、`upos-sz-mirroraliov` 等）。有測速紀錄時，冷門片不該出現 `upos-hz-mirrorakam`。
- **失敗的徵兆**：出現大量 `upos-hz-mirrorakam`／`upos-sz-mirrorcosov`，或 Console 出現 `[Transport] upos-sz-mirrorcosov → …` 的補救紀錄（代表播放資訊沒在 API 階段被改寫）。

## 必走的情境

| # | 情境 | 怎麼操作 | 播放資訊來源 |
|---|---|---|---|
| 1 | 一般影片整頁載入 | 直接開 `/video/BV…` | 網頁內嵌的 `__playinfo__` |
| 2 | 一般影片換片 | 用滑鼠點右側推薦影片（用 JS 改網址不算，頁面不會真的換片） | `//api.bilibili.com/x/player/wbi/playurl`（XHR） |
| 3 | 合集下一集／自動連播 | 合集影片跳到片尾前 25 秒，等它自動播下一集 | 同上（可能事先預取） |
| 4 | 切換 Hi-Res／杜比音軌 | 點控制列的 Hi-Res 按鈕關再開 | 同上（重新取得） |
| 5 | 番劇整頁載入 | 直接開 `/bangumi/play/ep…`（台灣可看的，例如「僅限港澳台地區」） | 網頁內嵌的 `__playinfo__`；片頭（不一定每次有）來自 `//api.bilibili.com/ogv/player/pre/check/drm`（XHR） |
| 6 | 番劇換集 | 用滑鼠點選集清單的另一集 | `//api.bilibili.com/ogv/player/playview`（fetch） |
| 7 | 切換畫質 | `player.requestQuality(32)` 再 `player.requestQuality(80)` | 不重新取得；看面板「緩衝（切換畫質後）」與「測速」列 |
| 8 | 播到片尾 | 跳到片尾前 25 秒播完 | — ；`BiliCDN.buf()` 換節點與卡頓判定都應為 0 |

## 新增情境的方法

B 站改版時可能換 API。找出目前所有會回傳播放資訊的端點：在影片頁或番劇頁 Console 執行

```js
const srcs = [...new Set(performance.getEntriesByType('resource').filter(e => /\.js(\?|$)/.test(e.name)).map(e => e.name))]
const found = {}
for (const s of srcs) { const t = await (await fetch(s)).text()
  ;(t.match(/[a-z]*\/(ogv|pgc|x|pugv)\/[A-Za-z0-9_\/]*(playurl|playview|play_view|playinfo)[A-Za-z0-9_\/]*/g) || [])
    .forEach(m => { found[m] = (found[m] || 0) + 1 }) }
found
```

清單裡出現腳本 `PLAYURL_PREFIXES` 沒有的端點，就是新的漏洞。

## 注意

- 實機播放會進入帳號的觀看紀錄。
- 不要呼叫 `BiliCDN.report()` 做驗證：它會寫入剪貼簿。看狀態用 `BiliCDN.diag()`、`BiliCDN.buf()`。
