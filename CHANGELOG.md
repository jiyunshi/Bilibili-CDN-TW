# Changelog

## v1.3.4

> 本版起因是一則使用者回報：`https://www.bilibili.com/list/*` 必須自己在 Tampermonkey
> 加「自訂 matches」才能載入腳本。順著查下去發現的不只是漏掉一條 `@match`，而是**同一個
> 疏漏的兩層後果**——列表頁沒被載入（一），以及就算載入了，換片偵測也認不出列表頁的影片
> （二，影片編號在 `?bvid=` 而不是路徑裡）。修完再把「認不出這是哪部片」從靜默失敗改成會
> 出聲（三），並藉主動巡檢一併修掉攔截層四個「平常不會發生、一發生就很嚴重」的問題
> （四，R-1～R-5，非使用者回報；其中 R-5 是 v1.3.3 一項修正的實機回退）。
>
> 一般影片頁的行為零變化，已離線驗證。

**本版導覽**

- 一、播放頁涵蓋範圍（`@match`）
- 二、換片偵測支援 query 型頁面
- 三、把靜默失敗改成會出聲
- 四、攔截層健壯性（主動巡檢）
- 離線驗證結果
- 實機迴歸測試清單
- 本次刻意不做的事
- 巡檢中「看過但不改」的項目

---

### 一、播放頁涵蓋範圍（`@match`）

- 修正：`@match` 清單缺少 `/list/*`——稍後再看、收藏夾播放、UP 主合集／系列的連續播放頁全部走這個網址，腳本**根本不會被載入**。回報者只能自己在 Tampermonkey 的「使用者包含規則」手動補一條當暫時解法，那是個人端補丁，對其他人無效。一併補上同類遺漏的 `/festival/*`（跨年晚會、拜年紀等活動播放頁，走同一套 playurl API）、`/medialist/play/*`（舊版收藏夾播放頁，現多會轉址到 `/list/`，但舊連結仍在流通）、`/watchlater/*`（舊版稍後再看，保險性質）。
- 說明：`@match` 的萬用字元 `*` 會一併涵蓋問號後的 query string，所以 `/list/*` 能正確匹配 `…/list/watchlater?oid=…`，不需要額外規則。
- 說明：**為什麼只補 `@match` 就會動**——v1.3.3 已經拿掉內部那道寫死的 `isVideoPage` 閘門（見原始碼「以下 UI / Watchdog / Prewarm 過去用一個寫死的 isVideoPage…」那段註解），所以目前唯一擋住這些頁面的就只有中繼資料這一層。

### 二、換片偵測支援 query 型頁面

- 修正（**本版最重要**）：`getVideoKey()` 只翻 `location.pathname`，但影片識別碼有兩種存放位置——**pathname 型**（`/video/BV1xx…`、`/bangumi/play/ep123`，編號寫在路徑裡）與 **query 型**（`/list/`、`/festival/`、`/medialist/`，pathname 從頭到尾都是 `/list/watchlater` 這種固定字串，換片只改 `?bvid=` / `?oid=`）。結果是在列表裡連播十部片，`getVideoKey()` 十次回傳同一個值，`onSpaNavigate()` 在第一行 `if (key === currentVideoKey) return` 就掉頭走人，於是 `forcedRedirectHosts` 不清除（上一部片的強制改寫套用到新片）、`resetStreamProfile()` 不執行（新片沿用上一部的碼率判斷）、`setLastBakeoffAt(0)` 不執行（賽馬冷卻沒解除，新片無法立即重新選節點）、`Watchdog.reset()` / `rearmSeekPrewarm()` 不執行（卡頓判斷與 seek 預熱狀態殘留）。改成 pathname 優先、query 補位：`m` 沒中才依序看 `bvid` / `epid` / `oid` / `aid`，其中 `oid` / `aid` 是 av 號的數字部分，補上 `av` 前綴，讓同一部片不論從哪種頁面進來都收斂到同一個 key。順手把重複建立的 `URLSearchParams` 收斂成一個 `sp` 變數。
- 說明：**行為相容性**——`m` 永遠優先，所以 `/video/`、`/bangumi/play/` 等 pathname 型頁面的結果與 v1.3.3 逐字元相同（已離線驗證，見下）。v1.3.3 修正的「多 P 影片切換分集只改 `?p=`」也原封保留。

> **這一輪的教訓**：這與 v1.3.3 修的「多 P 只改 `?p=`」是**同一種病**——判斷式沒跟上新的網址型態，而且**失敗時完全沒有跡象**。v1.3.3 當時是留了一段註解提醒自己，事實證明「寫下來提醒自己」擋不住同類問題再犯一次；真正有效的防線是下面第三節那種會自己出聲的機制。

### 三、把靜默失敗改成會出聲

- 新增：`warnIfVideoKeyUnresolvable()`——`getVideoKey()` 的 `|| location.pathname` 是個**靜默退路**：拿不到影片編號時不報錯，還回傳一個看起來很合理的值，整個換片偵測已經失效卻不留任何跡象，只能等使用者回報「怪怪的」。這正是本次問題拖到現在才被發現的原因。改成兩種來源都落空時在 console 印一則警告（每個分頁只印一次）。
- 說明：三個刻意的設計決定——(1) **不受 `Config.verbose` 控制**，用 `console.warn` 直接輸出（與既有的 CustomCDN 安全警告同理由）：要靠它主動現身，就不能藏在預設關閉的開關後面。(2) **只在 `onSpaNavigate()` 呼叫，不在 `getVideoKey()` 內呼叫**：頁面剛載入時 `/list/watchlater` 可能還沒帶上 `?bvid=`（B 站隨後才 pushState 補上），在 `getVideoKey()` 裡呼叫會產生誤報；「發生過 SPA 導覽卻仍認不出影片」才是真正的問題訊號。(3) **呼叫點必須在 early return 之前**：失效的症狀正是 key 一直不變、每次都從 `if (key === currentVideoKey) return` 那行離開，放在後面等於永遠不會執行。
- 說明：用 `warn` 而非 `error`，訊息中寫明「CDN 改寫本身不受影響，影片仍會正常播放」——這是給回報用的線索，不是故障，不需要讓一般使用者緊張。
- 說明：**已知涵蓋範圍（誠實說明）**——這則警告涵蓋的是「`@match` 有涵蓋、但網址型態不認得」的情況。**「`@match` 根本沒涵蓋」的新頁型，腳本不會被載入，任何自檢機制都偵測不到**，只能靠使用者回報，也就是本次的情況。這是設計上的天花板，不是疏漏。

### 四、攔截層健壯性（主動巡檢）

> 修完上述問題後對全檔做了一次系統性巡檢：ESLint 靜態檢查（no-undef / no-unused-vars /
> no-dupe-keys / no-unreachable 等）**零錯誤**，人工審視則在網路攔截層找到四個問題。
> 四項都屬於「平常不會發生、一發生就很嚴重」的類型，且修正方向都是單向的（失敗時退化成
> 「不優化」而非「壞掉」），因此一併納入本版。**非使用者回報。**

- 修正（R-1，嚴重）：`unsafeWindow.fetch` 攔截 playurl 時，原本包了一層 `new Promise(resolve => response.text().then(text => resolve(...)))`——那個 executor **沒有 reject 參數**。`response.text()` 只要 reject，內層的 rejection 就無處可去（瀏覽器印一行 `Uncaught (in promise)`），而外層 Promise **既不 resolve 也不 reject**——呼叫端的 `await fetch(...)` 永遠不會回來，播放器停在「載入中」，只能重整頁面。觸發條件：fetch 的 promise 在**收到 header** 時就 resolve，body 還在傳；所以「header 已到、body 中斷」這個窗口內發生連線中斷，或播放器把這次 playurl 請求 abort 掉（快速連續換片、連點畫質切換），就會踩到。症狀對得上先前回報的「偶爾有幾部影片點進去一直轉圈」。改成拿掉多餘的 `new Promise` 包裝，直接回傳 `.then()` 鏈，讓 rejection 照 Promise 語意往外傳，播放器的錯誤處理與重試才有機會運作。同時補上 `204 / 205 / 304` 的 null body 處理（依規範這些狀態碼不得帶 body，硬塞會讓 `Response` 建構子丟 TypeError），以及「改寫丟例外就退回原始 text」「連合成 `Response` 都失敗就交回最小回應」兩層退路。
- 修正（R-2，嚴重）：`applyPageHooks()` 裡的四個 hook 原本是裸呼叫，而 `applyPageHooks()` 本身在 Main IIFE 頂層被直接執行——任何一個丟出例外，後面三個不會安裝、`pageHooksApplied` 停在 `false`，例外再往上炸掉整個 IIFE，於是**它後面的所有東西**（SPA 換片偵測、Watchdog、seek 預熱、設定面板、Tampermonkey 選單）全部不會執行。一個小失誤的爆炸半徑不該是整支腳本。改成逐項用 `try/catch` 隔離，壞一個只少一個功能。
- 修正（R-3，嚴重）：`__playinfo__` 的 setter 舊寫法是 `set: v => { playInfoTransformer(v); internal = v }`，而 `playInfoTransformer` 的前半段（`playInfo.result` 分支，含 `sanitizePlayInfoUrls` 與 `transformStreamItem` 呼叫）**不在它自己的 try/catch 範圍內**。一旦丟出例外，`internal = v` 就不會執行——頁面明明寫入了 `__playinfo__`，讀回來卻是 `undefined`，播放器拿不到初始播放資訊；例外還會往回炸進 B 站自己的 inline script。改成把改寫包進 `safeTransform()`，無論成敗都保證 `internal = v`。搭配 R-2，攔截層任何一處失敗最多只是「這次不優化」，不會讓影片播不出來。
- 修正（R-4，中）：三個回應處理的邊界問題。(1) `if (response === null) return true`——攔截器鏈的規則是「回傳值只要不是 `undefined` 就當成新的回應內容」，所以這行等於把回應**換成布林值 `true`**；改成回傳 `undefined`，語意才是「這次不改寫」。(2) XHR 若設了 `responseType='json'`，`super.response` 拿到的是**已解析的物件**而不是字串，舊寫法一律 `JSON.parse(物件)` → 被強制轉成 `"[object Object]"` → 丟 SyntaxError → 落到 catch → 整包回應原封不動送出；也就是走這條路徑的 playurl **從來沒有被改寫過**，而且完全無聲無息。改成先判型別，物件就地改寫後回傳同一個參考。(3) 攔截器鏈 `handleInterceptedResponse` 的 handler 呼叫補上 `try/catch`——這個函式是從 `responseText` / `response` 的 **getter** 裡呼叫的，讓例外往外傳等於播放器讀一次屬性就踩一次 `throw`。
- 待確認：R-4 的第 2 點是否真的會被觸發，取決於 B 站的播放器實際用哪條路徑取 playurl。修正本身是單向安全的（原本不會改寫 → 現在會改寫；型別不符時行為與過去相同），但**改寫是否真的生效需要實機確認**：在 `/video/` 頁切換畫質，看 `BiliCDN.diag()` 的改寫計數有沒有增加。
- 修正（R-5，中，**v1.3.3 一項修正的回退**）：HTTPDNS 阻擋的 XHR 路徑不再補送 `error` 事件，改成合成一個 `503` + 合法 JSON 的回應。v1.3.3 為了「別讓 B 站的 HTTPDNS 客戶端空等自己的逾時」而補送 `error → loadend`，但 B 站的請求層收到 `error` 事件就 `reject()`（**不帶參數**，印出來就是 `undefined`），而那條 promise 沒有 `.catch()` —— 每一次阻擋都會在 console 留下一行 `Uncaught (in promise) undefined`。阻擋 HTTPDNS 的目的是讓它退回系統 DNS，不是在使用者的 console 留紅字——**阻擋機制本身不該成為噪音來源**。fetch 那條路早在 v1.3.3 就是這個結論（合成 503 JSON 回應），XHR 這條當時漏掉了，現在補齊，兩條路一致：對呼叫端而言這是一次「伺服器回了 503」的**正常完成**，不是網路錯誤。實作上完全不呼叫 `super.send()`（不產生任何真實請求或 network entry），也不再呼叫 `abort()`；`readyState` / `status` / `statusText` / `responseURL` / `responseText` / `response` / `getResponseHeader` / `getAllResponseHeaders` 在阻擋期間一併自圓其說，其中 `response` 依 `responseType==='json'` 回傳已解析的物件（同 R-4 第 2 點）。
- 結案（R-5 的證據層級，誠實說明）：**R-5 不是那行紅字的解方**，它是一項原理上正確、但與該症狀無關的對稱性修正。2026-08-24 的實機取樣定案：紅字（`Uncaught (in promise) undefined`，`loadVideoData` 路徑）**出現的同時** `改寫統計.httpdns` 仍為 **0** —— R-5 修的 HTTPDNS 阻擋路徑在該次載入從未執行，卻照樣有紅字。堆疊指向的 `send @ userscript.html…:2454` 對應本檔的 `return super.send(...args)`，也就是「原封不動交給原生 XHR」那一行。加上 reject 值是 `undefined`（本腳本任何一處都不會 `reject()` 不帶參數），三項證據一致指向 B 站自己的請求層。R-5 仍保留：不主動製造 `error` 事件、與 fetch 路徑對稱，這兩點與症狀歸屬無關地成立。
- 更正一項判別法（原先寫錯，一併記錄）：**不能**用「堆疊裡有沒有 `send @ userscript.html`」來判斷紅字是不是本腳本造成的。我們的 `send()` 覆寫包住的是**每一個 XHR**，所以任何一條經過它的請求——包含 B 站自己失敗、自己 `reject()` 的——在 async 堆疊上都會出現這個框架。它只代表「這條請求經過我們」，不代表「是我們弄壞的」。真正能區分的是 `改寫統計.httpdns` 有沒有在增加。

### 離線驗證結果

以 Node 直接跑新舊兩版 `getVideoKey()` 比對（一次性驗證腳本，未入版控）：

| 情境 | 舊 (1.3.3) | 新 (1.3.4) |
|---|---|---|
| `/video/BV1xx411c7mD` | `bv1xx411c7md` | `bv1xx411c7md` |
| `/video/BV1xx411c7mD?p=2` | `bv1xx411c7md#p2` | `bv1xx411c7md#p2` |
| `/bangumi/play/ep123456` | `ep123456` | `ep123456` |
| `/bangumi/play/ss12345` | `ss12345` | `ss12345` |
| `/list/watchlater?oid=111&bvid=BV1aa…` | `/list/watchlater` ❌ | `bv1aa4y1x7zn` ✅ |
| `/list/watchlater?oid=222&bvid=BV1bb…` | `/list/watchlater` ❌ | `bv1bb4y1x7zn` ✅ |
| `/list/ml3344556?oid=333&bvid=BV1cc…` | `/list/ml3344556` ❌ | `bv1cc4y1x7zn` ✅ |
| `/list/12345?type=season&…&bvid=BV1dd…` | `/list/12345` ❌ | `bv1dd4y1x7zn` ✅ |
| `/festival/2026bnj?bvid=BV1ff…` | `/festival/2026bnj` ❌ | `bv1ff4y1x7zn` ✅ |
| `/list/watchlater`（尚未帶片） | `/list/watchlater` | `/list/watchlater`（觸發 fallback 旗標） |
| `/some/new/page?foo=bar`（未知頁型） | `/some/new/page` | `/some/new/page`（觸發 fallback 旗標） |

- 列表內換片，舊版判定為同一部：**是**（這就是 bug）→ 新版判定為同一部：**否**（已修正）
- 一般影片頁新舊結果完全一致：**是**（既有行為未改變）

R-1 的 fetch 攔截路徑（用假的 `Response` 模擬 body 中斷）：

| 情境 | 舊 (1.3.3) | 新 (1.3.4) |
|---|---|---|
| body 正常收到 | resolved | resolved |
| header 已到、body 中斷 / 被 abort | **永不 settle（掛起）** | rejected（可重試） |
| 204 無 body 狀態碼 | 會丟 TypeError（依 `Response` 建構子規範推論，測試未實跑舊路徑） | body = `null` |
| 改寫是否仍生效 | ✅ | ✅ |

R-5 的 HTTPDNS 阻擋路徑（用假的原生 XHR + B 站式 promise 包裝重現）：

| 觀察項 | 舊 (1.3.3) | 新 (1.3.4) |
|---|---|---|
| 呼叫端 promise | `rejected`，reject 值為 `undefined` ←（這就是回報的紅字） | `resolved` |
| 呼叫端讀到的 status / Content-Type | —（網路錯誤，沒有回應） | `503` / `application/json` |
| `responseType='json'` 時的 `response` | — | 已解析的物件（`code = -1`） |
| 事件觸發次數 | — | `readystatechange(DONE)` / `load` / `loadend` 各 1 次，`error` 0 次 |

`node --check bilibili-cdn-tw.user.js` 語法檢查：**通過**。

### 實機迴歸測試清單

2026-08-24 以 Chrome（使用者本人的瀏覽器與已安裝的 Tampermonkey）逐項實測，
結果標記如下。**沒有勾的項目一律附上未測原因，不以推論代替實測。**

**必測（本次改動直接影響）**

- [x] `https://www.bilibili.com/list/watchlater` 腳本有載入（`BiliCDN.diag()` 有輸出、`uiInjectStatus: "ok"`）——v1.3.3 在這頁完全不會載入
- [x] 列表頁實際播放正常，且**改寫真的生效**：`改寫統計` 累計 `whitelist: 21` / `quietRedirects: 18`，console 出現 `[Transport] upos-sz-mirrorcosov → upos-tf-all-tx（非白名單）`
- [x] 按「下一部」出現 `[SPA] 換片：bv13ylx6aeyr，重置選節點狀態`，且換片後改寫繼續累加（21 → 43）
- [x] 連續換多部片，每次都出現該行且 key 不同（`bv13ylx6aeyr` → `bv1vnqjyneu2` → `bv1ywidbde8k` → `bv19v4y1374z`）
- [x] 收藏夾（`/list/ml…`）、UP 主合集（`/list/{mid}?type=season…`）的**網址型態**解析正確：分別得到 `bv1cc4y1x7zn`、`bv1dd4y1x7zn`（以 `pushState` 送出 B 站換片時完全相同的網址變化來驗證）
- [ ] 收藏夾／合集的**真實頁面**播放：未測。需要具體的收藏夾 ID 與合集 ID，測試帳號手上沒有現成的；網址型態已如上驗證，缺的是「該頁確實會載入腳本」這一層——與 `/list/watchlater` 是同一條 `@match` 規則（`/list/*`），該規則已實測有效
- [x] `/medialist/play/watchlater`（舊版收藏夾播放）：實測會 302 轉址到 `/list/watchlater`，轉址後腳本正常載入
- [ ] `/festival/*` 真實頁面：未測。`2025bnj` / `2024bnj` 兩個網址都已下架（轉 `/404`），手上沒有仍存活的活動頁網址。網址型態已驗證（`bv1ff4y1x7zn`），`@match` 規則形狀與已實測有效的 `/list/*` 相同

**回歸（確認沒弄壞既有功能）**

- [x] 一般影片頁 `/video/BV…` 播放正常（`readyState 4`、2160p、時間持續前進），面板正常
- [x] 多 P 影片切換分集（只改 `?p=`）仍觸發換片重置：`bv1xx411c7md` → `#p2` → `#p3` 各觸發一次（v1.3.3 的修正未被破壞）
- [x] 番劇 `/bangumi/play/ep…` 頁面載入正常、面板正常
- [ ] 番劇實際播放：未測。抽到的 `ep5054570` 是**版權地區限制**（「您所在的地区无法观看本片」），與本腳本無關
- [ ] 課程 `/cheese/…`：未測（`@match` 自 v1.3.3 起未改動）

**診斷警告（第三節）**

- [x] `/video/BV…` 與 `/list/watchlater` 正常換片時**未**出現該警告（無誤報）
- [x] `/list/watchlater` 剛載入、B 站尚未 pushState 補上 `?bvid=` 的瞬間**未**出現該警告（這正是「只在 `onSpaNavigate` 呼叫」的設計目的）
- [x] 導覽到未知頁型（`/some/brand/new/page`）時**正確**出現警告，且同一分頁只印一次、不洗版

**攔截層健壯性（R-1～R-5）**

- [x] 一般影片頁正常播放，快速連點畫質切換 **7 次**（4K ↔ 1080p ↔ 480p 來回）：播放器**沒有**卡在「載入中」，`readyState` 維持 4、播放時間持續前進（20.4s → 82.5s），`video.error` 為 `null`
- [x] 快速連續換片 **5 次**（列表頁按「下一部」不等它播完就再按）：最終正常起播，`video.error` 為 `null`，改寫累計 96 次
- [x] 上述兩項全程 console **零錯誤、零例外**（`onlyErrors` 讀取結果為空），無 `page hook 失敗`、無 `攔截器例外`、無 `改寫失敗`
- [x] **R-5 的決定性測試**（結論見四之 R-5）：紅字與 `改寫統計.httpdns = 0` 同時成立 → 紅字來自 B 站自己的請求層，非本腳本
- [ ] R-5 本身（HTTPDNS 阻擋仍有效）：未測。整輪實測 `改寫統計.httpdns` 始終為 **0**，B 站在這些頁面根本沒發出 HTTPDNS 請求，該路徑無從觸發
- [ ] R-4 第 2 點（`responseType='json'` 的 playurl 改寫）是否真的被走到：未測。改寫確實生效（96 次），但無法從外部分辨播放器走的是 XHR-json、XHR-text 還是 fetch 路徑

**升級路徑**

- [x] 從 v1.3.3 升級後既有 GM 設定保留：實測 `BiliCDN.verbose(true)` 設定跨頁面導覽持續有效，黑名單／軟隔離／健康分數等既有資料在 `diag()` 中完整延續
- [ ] 已自行加過「自訂 matches」的使用者升級後功能正常：未測（需要一個有該設定的環境；重複規則在 Tampermonkey 中無害）

### 不是本腳本造成的 console 訊息（一併記錄，省得下次再追一輪）

- `Uncaught (in promise) undefined`（無論堆疊是 `bili-comments.*.js` 的 `n` / `l` / `s` / `reloadComment`，或 `video.*.js` 的 `loadVideoData` → `inject.js` → `video.*.js:90`）——B 站自己的請求層在請求失敗或被取消時 `reject()` **不帶參數**、又沒有 `.catch()`，就會印出這一行。不影響播放。**已於 2026-08-24 實機定案**（見四之 R-5 的三項證據）。刻意不處理：要讓它消失只能掛一個全域 `unhandledrejection` 監聽去吞掉，那會連帶蓋掉真正該被看見的錯誤——**我們不吞別人的錯誤**。
- **判別方式（別用堆疊框架判斷）**：我們的 `send()` 覆寫包住每一個 XHR，所以任何經過它的請求都會在 async 堆疊留下 `send @ userscript.html…` 這個框架，**有這個框架不等於是本腳本造成的**。要區分只能看 `BiliCDN.diag()` 的 `改寫統計.httpdns`：長期為 0 就代表 HTTPDNS 阻擋路徑（R-5 修的那條）從未執行，紅字必然來自 B 站自己。

### 本次刻意不做的事

| 項目 | 決定 | 理由 |
|---|---|---|
| `player.bilibili.com/*`（外嵌播放器） | 不做 | 無人回報需求；面板掛在 `.bpx-player-ctrl-setting-others`，在小 iframe 內的體驗未經實測 |
| `live.bilibili.com/*`（直播） | 不做 | 直播串流機制與攔 playurl 改 `base_url` 的核心邏輯不同源，未經實測 |
| 啟動自檢（用 `GM_info.script.matches` 對照內部頁面型態表） | 延後 | 需先在實機 console 確認 Tampermonkey 是否提供 `matches` 陣列 |
| 改用 playurl 的 `cid` 判斷換片 | 延後 | 治本解，但會改變重置動作的觸發時序，對賽馬排程與 `bakeoffStartupDefers` 的影響需實測 |
| CHANGELOG 頁面對照表當防呆機制 | 降級 | v1.3.3 的註解已證明「寫下來提醒自己」擋不住這類問題；保留為查詢用途，不當防線 |

### 巡檢中「看過但不改」的項目

| 項目 | 判斷 |
|---|---|
| ESLint 兩則 `require-atomic-updates` 警告（`activeCdnList` / `reorderRunning`） | 誤報。`reorderRunning` 是 try/finally 保護的重入旗標，`activeCdnList` 的重建在該旗標保護範圍內 |
| 死節點 TTL 校正用 `now + TTL` 而非 `判刑時間 + TTL` | 因為沒有存 `markedAt`。效果是「規則放寬時最多再多關一個 TTL」，方向仍是縮短，可接受 |
| `pageDiscoveredCdn` 換片時不重置 | upos host 與影片無關，沿用是合理的 |
| `res.body.tee()` 後合成的 `Response` 會遺失 `url` / `type` / `redirected` | 理論上有影響，但 segment 路徑是否用得到需實機驗證，未動 |
| `theWindow.fetch` 改成箭頭函式後 `length` / `name` 改變 | 理論風險，無實證，未動 |
| seek 預熱重複掛監聽、UI 雙 timer、除以零 | 已有 `__biliCdnSeekBound`、`clearInterval` 交接、`Math.max` 下限保護，無問題 |


## v1.3.3

> **為什麼跳過 1.3.2**：`1.3.2` 這個版號先前已經 commit + push 到 GitHub 過一次
> （`126fa77 發布 v1.3.2：儲存層抽象 Store adapter`），內容與本版完全不同，隨後被
> `cd44fee` / `69978bb` 撤回並把版號改回 1.3.1。依本專案的版本號規則——**版號一旦
> push 到遠端就不能再指派給不同內容**（Tampermonkey 用 `@version` 做嚴格比較，
> 腳本自身的狀態遷移也用版本字串判斷）——本批改動改用 1.3.3 發布。

> 本版主題是「修正偶爾有幾部影片點進去加載很慢」。追下去發現慢的成因不只一個，而是四類
> 各自獨立、但症狀完全一樣的問題：**改壞網址**（對不能改 host 的 PCDN 連結硬改，請求必失敗，
> 播放器要等失敗才走 backup）、**誤判卡頓**（把「清單最高畫質」當成「實際播放畫質」，門檻整整
> 高一個數量級）、**取樣假象**（用單秒瞬間值判斷分段下載的速度，把正常的段間空檔看成卡頓）、
> **起播搶頻寬**（測速跟第一批 segment 同時搶頻寬）。後續追查 `ERR_NAME_NOT_RESOLVED` 又補上
> 第五類：**把解析不出來的 host 誤判成延遲極低的好節點**。以下依主題分類。

**本版導覽**

- 一、網址改寫的正確性
- 二、卡頓判定與量測
- 三、節點健康度與懲罰機制
- 四、選路與起播
- 五、console 錯誤與多分頁
- 六、診斷、API 與死碼清理
- 怎麼驗證這一版有沒有用
- 已知未處理項目
- 附錄 A：實驗記錄
- 附錄 B：開發過程中被推翻或排除的判斷
- 附錄 C：資訊來源與可信度

---

### 一、網址改寫的正確性

**PCDN / 改壞網址**

- 修正：路徑以 `/v1/resource` 開頭的 MCDN / IP:Port 型連結，是 Bilibili 專門發給 PCDN 節點的網址格式，缺少 `trid` 等參數，**換掉 host 之後正規 CDN 一律拒絕**，也無法靠改 host 重組成正常的 upos 網址。舊版直接改，等於保證這次請求失敗，播放器要等這次失敗、再依序試 `backup_url`，起播多等好幾秒。新增 `isPcdnResourceUrl()` 守門。開發過程中的關鍵教訓：第一次只擋在 `rewriteUnstableMediaUrl()` 並**沒有修好**——同一條網址還有兩條路會被改壞（`/v1/resource/xxx.m4s` 以 `.m4s` 結尾，`isBiliFragmentUrl()` 成立後會走進 `normalizeMediaUrl()` 的一般白名單分支；playurl 層的 `transformStreamItem()` 根本不經過 `rewriteUnstableMediaUrl()`）。守門最後放在 `replaceUrlHost()`——**所有改 host 的唯一出入口**，playurl 層與 transport 層一次涵蓋。快篩先用 `indexOf` 再 `new URL()`，因為 `sanitizePlayInfoUrls` 會走訪整包 playurl 回應的幾百個字串欄位。
- 修正：`pickStreamUrls()` 舊版用 `validUrls.find(isBiliVideoUrl)` 挑來源網址，而 `isBiliVideoUrl` 會匹配 `*.mcdn.bilivideo.cn`——所以 `base_url` 是 PCDN 時，**就算 `backup_url` 裡有現成的 Mirror 型連結可用也不會被選中**，反而拿 PCDN 那條去改 host（必失敗）。改成兩段挑：第一順位是「路徑可改寫、host 也不是 MCDN/BCache」的 Mirror 型，第二順位是至少路徑可改寫的（例如 BCache 型，改 host 有效）；兩者都沒有（整包只剩 `/v1/resource`）就整個不動這個 item，交還播放器照它原本的流程走。備援連結與主流來自同一包 playurl 回應，簽名/deadline 一致，換用不會有額外風險。
- 修正：`item.backup_url = buildBackupUrls(...)` 直接賦值，當 `buildBackupUrls()` 回空陣列時（沒有可用白名單候選、或來源是不可改寫的 PCDN 網址），**等於把 Bilibili 原本給的備援流全部刪掉**，主流一失敗就無路可退。改成只有 `backups.length` 非零才覆寫。

**綁定節點的串流：`os=<節點>bv` 換 host 必定 403（2026-08-20 實機回報「十分不穩定」）**

> 使用者回報極度不穩定並附上完整 log。關鍵線索藏在 URL 的參數裡：那條 segment 網址帶
> **`os=cosovbv`**，而賽馬把同一條 URL 換到 `aliov` / `ali` / `cosov` 三台——**三台全部 403**。

- 修正（**本輪最重要**）：Bilibili 有一類 playurl 簽發的網址是**綁定特定節點**的，URL 上帶 `os=<節點>bv`，**換掉 host 之後每一台都回 403**。這造成兩層傷害：
  1. **賽馬每 90 秒製造 3~4 行紅字**——`probeCdnThroughput` 把 403 吞成 `null`，所以賽馬分不出「這節點慢」和「這條網址誰都不給」，於是逐一把剩下的候選全試一遍，每顆各留一行 403。
  2. **正常播放也被改壞**——`transformStreamItem` / `normalizeMediaUrl` 照樣改寫，播放器拿到 403 只能一路重試 `backup_url`，表現出來就是「十分不穩定」。
  
  **沒有辦法在事前可靠判斷**（實測過 `os` 是別的值時換 host 完全可行，並非全部綁定），所以改成**學習**：任何一次「換 host 之後拿到 403」就把這條串流登記進 `hostLockedStreams`，之後對它完全不改寫、也不賽馬，交還播放器用 B 站原本給的網址跑。學習的觸發點有兩個——賽馬的 403，以及**播放層被我們改寫過的 segment 拿到 403**（只在有改寫時才登記；沒改寫過的 403 是節點自己的問題，不是綁定）。
  
  key 優先用 `os` 參數（同一支影片的各種畫質共用同一個 `os`，**一次學習全部畫質適用**），沒有 `os` 才退回 pathname。守門放在 `replaceUrlHost()`——所有改 host 的唯一出入口，跟 PCDN 守門同一處，playurl 層與 transport 層一次涵蓋。SPA 換片（`resetStreamProfile`）與 `BiliCDN.reset()` 都會清空，新影片重新給機會。
- 修正：`probeCdnThroughput()` 現在把 403 明確回報（`{ forbidden: true }`）而不是吞成 `null`；`doBakeoff` 收到第一個 403 就**登記並立刻中止本輪**，不再逐一試完剩下的候選。`runThroughputBakeoff` 入口也先檢查一次，已知綁定的串流連 Web Locks 都不用搶。
- 新增：診斷的 `改寫統計` 多一個 `hostLocked` 欄位——數字 > 0 代表你遇過綁定節點的簽名。長期為 0 表示你的環境沒碰到這類串流。

> **這一輪的教訓**：`probeCdnThroughput` 把所有失敗都壓成 `null`，是「**把不同的失敗原因抹平成同一種**」的典型代價。慢、逾時、DNS 失敗、403 需要完全不同的反應（重試 / 降級 / 標死 / **停止對整條串流動手**），而一旦在最底層就丟掉了區別，上層就只能一視同仁地繼續試下去——每試一顆多一行紅字。回報失敗時，**先問「呼叫端會因為知道原因而做出不同決定嗎」**，會的話就不能只回 null。

**其他**

- 修正：`isUnstableCdnHost()` 的 BCache 節點辨識正則 `/^cn-[a-z]{2}-/` 只吃得下兩碼地區代碼，實際看過的寫法包含 `cn-tj-cu-01`（2 碼）、`cn-hbwh-cm-01-11`（4 碼）、`cn-jxnc-cmcc-bcache-06`（4 碼），**四碼的一律漏判**。漏判不會讓它逃過改寫（這些 host 不在白名單，`needsRedirect()` 照樣成立），但會讓 `isMediaSegmentUrl()`、seek 期間的 `mustFix`、以及 Watchdog 挑「元兇」時的排除條件全部對它失效。放寬為 `{2,8}`。
- 修正：阻擋 HTTPDNS 的 XHR 補送失敗事件。依 XHR 規範，`abort()` 在「已 `open()` 但未 `send()`」的狀態下**不會觸發任何事件**，舊寫法等於讓 Bilibili 的 HTTPDNS 客戶端拿不到任何回呼，只能靠它自己的逾時才會放棄。改成補送一組跟真實網路錯誤一致的事件（`error` → `loadend`）再 `abort()`。這是本版最優先回退的候選項——若觀察到 HTTPDNS 行為異常，先看這裡。
- 修正：`getVideoKey()` 只看 `location.pathname`，但多 P 影片切換分集**只會改 `?p=`，pathname 一個字都不變**，於是不算換片，新分集整包沿用上一集的碼率、賽馬冷卻與 Watchdog 狀態。長片合集、課程、紀錄片這類多 P 內容最容易中。改成把 `?p=` 併入 key。
- 修正：SPA 換片時重置碼率狀態（新增 `resetStreamProfile()`，由 `onSpaNavigate()` 呼叫）。從 4K 片切到低碼率片時，`currentStreamBitsPerSec` / `baseBufferTargetBytes` 會殘留舊值，新片沿用舊片的高門檻，重演上面的碼率誤判；反之從低碼率切到 4K 則反應遲鈍。

### 二、卡頓判定與量測

**Watchdog 卡頓判定**

- 修正（本版最重要）：`currentStreamBitsPerSec` 是用 playurl 清單裡**最高畫質**的 bandwidth 設定的（`maxV + maxA`），那不是使用者實際在看的畫質——**只要這支片「有提供」4K，即使實際播 1080p，這個值也會是 4K 的碼率**。連鎖後果全部指向同一個方向：Watchdog 的 `highBitrate` 恆為 `true`，套用 4K 專用嚴格門檻（`minAheadEff` 30 秒、`stallMaxEff` 2）；`minBps` 直接等於 4K 碼率 ÷ 8（約 2.5~4 MB/s），而實際播 1080p 的播放器穩態只會拉約 0.5 MB/s，**永遠低於門檻、`tooSlow` 恆成立**；於是每隔幾秒觸發一次 `switchCdn()`，軟隔離當前節點 10 分鐘、記一次 `failures`、清掉 probe 快取、重建連線，**連續幾輪就能把手上所有好節點依序全部軟隔離掉**，而軟隔離持續 10 分鐘、健康分數的懲罰更久，**災情會延續到之後幾部片**。改用 `<video>.videoHeight` 反查對應 representation 的碼率（新增 `streamProfile` 與 `syncStreamBitrateFromVideo()`，`Watchdog.tick()` 每秒校正一次）——`videoHeight` 是播放器實際解出來的畫面高度，切畫質、ABR 自動降級都會即時反映，比任何清單推測都準。同高度有多個 codec（AVC/HEVC/AV1）時取較大的碼率，寧可略為高估也不要低估到讓 Watchdog 對真正的卡頓變遲鈍；變動小於 5% 不重算，避免 `reached` 狀態每秒抖動。模擬一支提供 2160p/1080p/480p 的影片：實際播 2160p 門檻維持 3.70 MB/s 且仍套用 4K 嚴格模式（不變），實際播 1080p 從 3.70 降到 0.45 MB/s、480p 從 3.70 降到 0.11 MB/s，後兩者都不再誤觸 4K 嚴格模式。
- 修正（取樣假象）：`bps` 過去是「這一個 tick 的位元組差」，但播放器抓 segment 是**一陣一陣**的——抓完一段就閒置好幾秒，再抓下一段。用單秒差值來看，這些**正常的段間空檔會被算成 bps ≈ 0**，而高碼率下 `stallMaxEff` 只有 2，也就是「連續兩秒沒下載」就換節點。改用最近 `BPS_WINDOW_MS` 的滑動視窗平均；視窗長度**必須大於播放器抓一段的週期**（Bilibili 約 4~6 秒），否則視窗頭尾落在週期的不同相位，量到的還是取樣假象，取 8 秒。原本的 `lastTickBytes` 已無人讀取，一併移除。
- 修正（本批最重要）：`tooSlow` 只比對 bps 與估算門檻，有一整類**系統性誤判**——播放器在穩態下只會拉「剛好等於碼率」的量（它本來就不該把頻寬吃滿），而門檻是碼率 × 1.05，**只要緩衝低於 `minAheadEff`，bps 就結構性地永遠略低於門檻，判定必然成立**。`stalled` 有完全一樣的缺陷：段間空檔期間 `buffered.end` 本來就不會動，但播放時間持續前進，連續 2~3 個 tick 就達到 `stallMax`。改成加一個「緩衝真的在流失」的條件（`bufferAhead` 低於視窗起點 0.5 秒以上）——緩衝存量的**趨勢**才是「跟不跟得上」的物理事實，沒有流失就不判定，不管估算門檻怎麼說；例外是緩衝已進入危險區（`urgentBuffer`，< 5 秒）時不套用，那時候就算打平也只差一次抖動就斷了。60 秒模擬統計換節點次數：健康情境（分段下載、緩衝穩定 12 秒但低於 16 秒門檻）從 14 次誤判降到 0 次；真的變慢（下載只有需求的 6 成、緩衝持續流失）26 → 25，仍正常偵測；完全斷流 5 → 5，完全不受影響。
- 修正：`MIN_BPS_FLOOR`（350 KB/s）本來只是為了「碼率未知時不要訂出荒謬的低門檻」，但碼率已知且很低時（480p 只需約 0.10 MB/s），這個下限反而變成一個**跟這支片無關的高門檻**，播放器穩態根本不會拉到那麼快，於是低碼率影片被永久誤判成「太慢」。改成下限不得超過實際需求的 1.2 倍：4K（3.36 MB/s）與 1080p（0.43 MB/s）門檻不變，480p 從 0.34 降到 0.12 MB/s。

### 三、節點健康度與懲罰機制

**DNS 解析失敗（`ERR_NAME_NOT_RESOLVED`）**

- 修正：延遲探測的 `img.onerror` 用 `dt < 30ms` 當「是不是 DNS 失敗」的判準，其餘一律歸類成「TCP+TLS 已通的 4xx/5xx」。但 `<img>` 的 `onerror` 根本分不出 HTTP 404 與 DNS 解析失敗，而 NXDOMAIN 常常要 30~300ms 才回（要走到上游 DNS），穩穩落在舊版「視為可達」的那一側——於是 `recordCdnLatency()` 會把一個**根本解析不出來的 host 記成延遲極低的優等生**，比真的要跨海握手的節點還快，`reorderCdnsByLatency` 再依延遲把它推到第一位。後果就是起播與 seek 的 segment 整批 `ERR_NAME_NOT_RESOLVED`，播放器只能等這次失敗再逐一重試 `backup_url`。改成 `onerror` 一律用 no-cors fetch 確認可達性（伺服器只要有回應就 resolve，只有 DNS 失敗／連線被拒／TLS 失敗才 reject）；已經有本機實測樣本（`successes`/`samples > 0`）的節點維持原本不多發請求的快速路徑。實測案例：`upos-hz-mirroraliov.bilivideo.com`。
- 新增：segment 連線層失敗的專屬處理 `handleSegmentConnError()`。XHR 的 `error` 事件與 fetch 的 reject 都拿不到瀏覽器的真實原因（`ERR_NAME_NOT_RESOLVED` 這類訊息只印在 console，程式讀不到，`status` 一律是 0），唯一能用的線索是「一個位元組都沒收到」——那代表連線根本沒建立，而不是傳到一半斷掉。這種失敗跟壅塞的性質完全不同：**它 100% 會重演**，而既有的 `recordCdnFailure()` 只軟隔離兩分鐘，等於每次起播、每次 seek 都要再撞一次同一顆爛節點。現在確認真的連不到就直接標死 7 天（之後 `needsRedirect()` 會讓所有指向它的 segment 自動改寫掉），並立刻 `promoteBestCdnNow()` 重排候選、預連線。起播時播放器會併發好幾顆 segment，加 30 秒冷卻避免一次打出十幾個確認請求；有收到位元組的中斷（網路抖動、切畫質、播放器主動取消）完全不走這條路。
- 修正：`INITIAL_DEAD_HOSTS_TW`（台灣常見不解析的節點）的「起跑墊底」觸發條件從「首次安裝或從 <1.0.0 升級」改成「這個 host 在本機還沒有任何實測樣本」。舊條件對早就裝過的使用者實際上從來沒生效過，這幾個 host 就以「零紀錄」的身分待在候選池裡——而零紀錄在 UCB 計分裡是**有探索加成的**，反而比有幾次成功紀錄的節點更容易在起播那一刻被選中。一旦有了真實資料就完全不干預，使用者自己的實測永遠優先於這份清單。連帶移除已無人讀取的 `shouldSeedInitialHosts`。
- 修正：console 紅字本身。上面兩項修好之後，`ERR_NAME_NOT_RESOLVED` 反而變成**兩行**——一行來自延遲探測的 `favicon.ico?_t=`，另一行來自新加的可達性確認 `favicon.ico?_c=`。這牴觸了死節點機制當初寫下的設計目標（「跳過所有 probe/preconnect，徹底消除 console 紅字」）。三處一起改：（1）`confirmHostReachable()` 存在的理由是分辨「favicon 404（其實可達）」與「DNS 失敗」，但對 `INITIAL_DEAD_HOSTS_TW` 這幾個「已知在台灣就是不解析」、而且**本機從來沒有任何成功紀錄**的 host，這個分辨沒有意義——多打的那次請求換不到新資訊，只多印一行紅字，改成直接判定（`probeCdnLatency` 與 `handleSegmentConnError` 兩處都套用）；（2）起播那一輪（全新安裝的第一次探測）根本不碰這些 host，留給之後的延後排程或手動 `BiliCDN.probe()` 去測，那時候測失敗只是背景雜訊，不會落在使用者盯著畫面等起播的時候；（3）DNS 類的死節點 TTL 從 7 天拉長到 **30 天**——403、逾時、連線被拒都可能是暫時的（節點壅塞、區域策略、對方維護），7 天後重試合理，但 NXDOMAIN 是「這個網域在這個解析器上不存在」的穩定事實，7 天後重試只會得到一模一樣的結果，代價是每週一次必定失敗的請求加一行紅字。
- 修正（紅字的真正根因）：**探測路徑從 `/favicon.ico` 換成 `/crossdomain.xml`**。上一項只處理了「已知不解析的節點」，但使用者接著回報 `upos-sz-mirrorcos.bilivideo.com/favicon.ico?_c=... 403` —— 那台**解析得到、也活得好好的**。判斷邏輯其實是對的（403 代表伺服器有回應＝可達，所以沒被標死），問題在於：**upos CDN 上根本沒有 `favicon.ico` 這個檔案**。實測 aliov / cos 回 403、ali 回 405，也就是說每一輪探測都會對每個**健康**節點打出一個必定失敗的請求，而瀏覽器對任何非 2xx 的子資源都會印一行紅字。使用者看到的紅字有一大半是探測機制自己製造的，跟節點好壞完全無關。改用 `/crossdomain.xml`（Flash 時代的跨網域政策檔，這些 CDN 至今仍供應）——實測 aliov / ali / cos 與 Akamai 都回 **200**（250~950 bytes，帶 cache-buster 查詢參數也照樣 200）。健康節點的探測從此是安靜的，紅字只會出現在「這個節點真的有問題」的時候，那時候印出來反而是有用的訊號。
- 重構：延遲探測從「`Image` 探測 + 另一發確認請求」兩步，併成**單一 no-cors fetch**。`no-cors` 的語意剛好就是我們要的：resolve = 伺服器有回應（含 4xx/5xx，opaque response 讀不到狀態碼但那不重要）＝可達，這段時間就是延遲；reject = 網路層失敗（DNS / 連線被拒 / TLS）。`<img>` 的 `onerror` 分不出這兩者才是當初需要第二發請求的原因，換成 fetch 之後這個歧義從根本消失。每個節點每輪探測從 2 個請求降到 1 個。探測失敗時仍會再確認一次才標死——單次網路層失敗可能只是瞬間抖動，而標死的代價是 7~30 天不用這個節點，誤判的傷害遠大於多發一個請求；何況那個情境下 console 本來就已經有一行紅字了。
- 調整：`PROBE_TIMEOUT_MS` 從 1200ms 放寬到 2000ms。實測從台灣連 ali / cos 的完整往返（含 TCP+TLS 冷啟）就要 0.8~1.0 秒，1200ms 太貼近真實值，會讓好節點偶爾被誤判成 `probe-slow` 而白白軟隔離 5 分鐘。探測已經不在起播關鍵路徑上，多等這 800ms 沒有任何代價。
- 保留：「本機真的成功過就不套用捷徑」這個條件是刻意的，它保住了 v1.3.0 的設計意圖——不同電信商 / VPN 路由差異很大，只要這個 host 在**你的**網路上成功過一次（`successes`/`samples > 0`），就一律走完整的確認流程，不會因為它出現在預設清單上就被判死。
- 修正（使用者實測回報，堆疊 `doBakeoff → probeCdnThroughput`）：**吞吐量賽馬會對已知不解析的節點發測速請求**。賽馬只擋 `knownDeadHosts`，但上一項刻意讓「已知在台灣不解析、尚未標死」的節點跳過起播探測——結果它們既沒被標死、也就沒被賽馬擋下，於是賽馬拿**真實 segment URL** 去打它們，`ERR_NAME_NOT_RESOLVED` 又回來了。這是修正的副作用：**擋掉偵測、卻沒同步擋掉使用**。而且傷害不只是紅字——`doBakeoff` 的候選迴圈是逐一 `await`，每顆死節點都要卡滿 `THRPT_PROBE_TIMEOUT`（3 秒）才輪到下一顆，兩顆就是 **6 秒**，這 6 秒本來該用來測真正可用的節點，時機還正好落在起播附近。現在 `getHealthyCdnList()`（選路與 `backup_url`）、`doBakeoff`（賽馬候選）、`probeCdnThroughput`（真正送出請求的地方）三層都擋；`getHealthyCdnList` 用「還有別的可選才排除」的軟性寫法，避免極端情況下把候選池清空。
- 修正：延後探測撞上進行中的賽馬時會被**永久丟掉**。`reorderCdnsByLatency` 開頭是 `if (reorderRunning || bakeoffRunning) return`，配合延後探測的設計就變成：好不容易等到緩衝建立、卻剛好撞上正在跑的賽馬 → 這一輪整個消失 → 「該被標死的節點永遠沒機會被標死」→ 賽馬每 90 秒又去打它一次。使用者看到的紅字會反覆出現，這是其中一環。改成重新排程而不是丟棄。
- 修正：探測結束時用 `getHealthyCdnList()` 的結果**重寫** `activeCdnList`，等於讓「此時此刻」的選路條件去縮減整個 session 的候選池母體——一次瞬間的壞狀態（失敗次數超標、分數過差）就會變成「接下來兩小時都不再考慮這個節點」，要等下一輪探測從 `PREFERRED_CDN_LIST` 重建才回得來。這是個單向棘輪，候選池只會越來越薄，也是診斷面板「白名單順序」有時只剩一兩個節點的成因。改成只重新排序、不縮減：排到的照名次放前面，沒排到的留在後面備用。
- 修復（死屬性）：`probeCdnLatency` 回傳的 `reason`（`'DNS'` / `'timeout'`）過去只被寫入、沒有任何地方讀。比照 `logRedirect` 的處理方式補上一行 `log()` 輸出而不是刪掉——使用者在 console 看到 `ERR_NAME_NOT_RESOLVED` 時最想知道的就是「腳本有沒有認出這件事、認成什麼」，而這是唯一能回答的地方。輸出受 `Config.verbose` 控制，預設靜音。
- 修正（誤殺好節點）：**探測逾時不再一次定罪**。舊版是「探測逾時（2 秒）→ 再確認一次（4 秒）→ 還是沒回應就標死 7 天」。但 6 秒沒回應是「很可能壞了」而不是鐵證——實測從台灣連 ali / cos 正常往返就要 0.8~1.0 秒，起播當下頁面自己也在搶頻寬與連線配額，偶爾整個窗口都撞上並非不可能。使用者實測回報 `upos-sz-mirrorali` 被標死，但它 DNS 解得到、`/crossdomain.xml` 回 200，是明確的誤殺。改成兩次逾時才定罪（`PROBE_TIMEOUT_STRIKES`），第一次只軟隔離觀察 10 分鐘，中間任何一次成功（`recordCdnSuccess` 或探測有回應）都會把計數歸零。這條只放寬「逾時」——fetch 被 reject（DNS/連線被拒/TLS）是明確的網路層失敗、而且已經另外再確認過一次，維持一次定罪。
- 新增：`BiliCDN.diag()` 的 `dead` 欄位從單純的 host 陣列改成帶 **`reason` 與 `daysLeft`** 的物件。`knownDeadHosts` 本來只是個 Set，看不出任何前因後果——而一個好節點被誤殺 7~30 天，使用者唯一能察覺的徵兆就是這份清單多了一筆，卻無從判斷是該修 bug 還是那個節點真的壞了。同時新增 `presumed` 欄位，列出「已知在台灣不解析、但還沒有實測證據可以標死」的節點：它們不會被選路、不會進 `backup_url`、不會被賽馬碰到，但也還沒被判死刑，過去在診斷輸出裡完全隱形。
- 新增：`BiliCDN.revive("ali")` 單獨救回被誤殺的節點，不動其他學習狀態。`clearDead()` 是全清——連真的壞掉的也一起放回候選池，下一輪探測又會重新撞一次、再印一次紅字。接受完整 host 或短名稱。
- 修正（推版前最終檢查抓到）：**探測快取只決定「順序」，不決定「成員」**。舊版命中 2 小時快取時是照著快取清單重建 `activeCdnList`，於是某一輪縮水後的結果會被醃在快取裡整整兩小時——之後每次載入都照那份短清單重建，池子再也長不回來。使用者實測回報 `active` 只剩 1 個節點就是這樣來的：候選池被歷史狀態鎖死，而且因為版本號沒變（同一個版號反覆重貼），升級時清快取的那段遷移也不會觸發。現在快取裡有的照原順序放前面，其餘「當下沒有任何理由排除」的候選一律補在後面。
- 修正：`reviveDeadHost()` / `clearDeadHosts()` 沒有連帶清掉探測快取。不清的話，救回的節點在**當下**看起來有效，重整頁面後又被舊快取擋在外面，最多要等兩小時才真的回得來。
- 修正：延後探測撞上賽馬時的重排有兩個洞。一是判斷式寫成 `if (deferStartupProbes) scheduleDeferredLatencyProbe()`，但延後的那一輪自己會先把 `deferStartupProbes` 設成 `false`，若在那之後才撞上賽馬，等於又把這一輪丟掉一次；二是重排沒有次數上限，萬一 `bakeoffRunning` 因故卡住就會變成每 2 秒空轉的無窮迴圈。改成無條件重排，並讓「讓路」與「重排」共用同一個有界計數器（`MAX_PROBE_DEFERS`），用完就放行交給之後自然會發生的觸發點。
- 修正：`BiliCDN.revive()` 的短名稱比對原本用 `endsWith`，`revive("ali")` 會同時命中 `aliov`。改成明確規則：完整 host、去掉網域的短名、或去掉 `upos-{sz|hz}-mirror` 前綴的節點代號，三者皆用完全相等比對。
- 新增：`BiliCDN.probe()`——手動重跑延遲探測（忽略 2 小時快取與起播讓路，含 presumed 節點）。程式碼註解與本文件先前都引用過這個入口，但它其實**從來沒有被實作出來**；推版前的 API 完整性檢查抓到這個文件與實作不一致。
- 修正：三處診斷輸出還寫著「持久死節點（7d）」，但 DNS 類的 TTL 已經是 30 天。改成顯示各自的死因與剩餘天數。
- 修正（**本版最嚴重的一項**，v1.3.1 就存在）：**卡頓時會輪流把每個節點懲罰一遍，直到白名單全被封光**。`switchCdn()` 過去只有兩道防線——`inSeekGrace()` 與 `SWITCH_COOL`（兩次切換間隔 5 秒）；`sessionSwitchCount` 雖然一直在累加，卻從來沒被拿來當煞車。於是只要卡頓判定持續成立，就會每 5 秒懲罰一個節點，把 aliov、cos、hwov、hw 依序打完，接著觸發緊急的「黑名單已全部清除」，然後從頭再來一輪。使用者實測 log 裡這個循環在一支 4K 影片（需求 25.65 Mbps）上跑了兩輪。**問題是這種情況下瓶頸根本不在節點**：跨境線路或使用者頻寬撐不住那個碼率時，換到哪個節點都一樣，而繼續換只會更糟——每換一次就丟掉一條熱連線、重做一次 TCP+TLS 握手，懲罰還會殘留 10 分鐘以上，連帶拖累接下來幾部片（正是本版一開始要解決的「災情延續到之後幾部片」）。新增**換節點斷路器**：60 秒觀察窗內切換達 3 次就停手 90 秒，並**收回這一波的懲罰**（既然判定不是節點的錯，就不該讓它們背鍋去污染之後的選路）。換片時重置，新影片重新給機會。
- 修正：`getHealthyCdnList()` 的**過濾順序**寫反了。`isPresumedDnsFailHost`（已知連不到、必定失敗）原本排在 `cdnFailCount`（最近表現不好、只是慢）之後，於是當所有可達節點都因為失敗次數超標被濾掉時，剩下的就只有那些「從沒被用過、所以也從沒失敗過」的不可達節點——選路會直接把 segment 導去 NXDOMAIN。使用者實測 log 出現過 `[Transport] upos-sz-mirrorcosov → upos-sz-mirrorhwov`。改成先整批拿掉「已知連不到」再談失敗次數：**「被懲罰過但連得到」永遠優於「乾淨但連不到」**。
- 新增：`Watchdog.stats()`（對外入口是 **`BiliCDN.buf()`**，不是 `BiliCDN.stats()` —— 後者是改寫統計，兩者完全不同，本文件先前寫錯，2026-08-19 的驗證抓到）加上 `switchCount`、`stallCount`、`breakerSec`，而且**實際印出來**（舊版只放在回傳物件裡，等於使用者看不到）。`BiliCDN.stats()` 也補一行指路。使用者回報「畫面一直卡、log 一直在換節點」時，這三個數字是最直接的判讀依據：`switchCount` 一直漲代表 Watchdog 認為節點有問題；`breakerSec > 0` 代表已經判定「換也沒用」而停手，瓶頸在頻寬 / 碼率 / 跨境線路。
- 修正（跳轉變慢，本版自己造成的迴歸）：**延遲探測會在 seek 保護窗內開跑**。拖完時間軸之後播放器要把新位置的 segment 全部重抓，那是全片最吃頻寬的一刻；而這一輪探測會同時對 4~6 個候選各發一個請求，直接跟 seek 的 segment 互搶。這條「seek 期間不要發背景請求」的規則在本腳本裡本來就成立——賽馬 `runThroughputBakeoff`、Watchdog 的 `scheduleDelayedReorder`、keep-warm 的 `preconnectBatch` 都各自檢查了 `inSeekGrace()`——**唯獨延遲探測漏掉**，因為它以前跑在 document-start，那時候使用者根本還不可能 seek；本版把它改成「延後到起播緩衝建立之後」才暴露出這個缺口。現在 `reorderCdnsByLatency` 在 seek 保護窗內改為重新排程；`force=true`（手動 `BiliCDN.probe()`、Watchdog 判定已出事的重評估）不受限，那些呼叫端自己已經檢查過。實測對照：舊版在 seek 當下會發出 **6 個**探測請求，新版 0 個。
- 修正（同上）：**`promoteBestCdnNow()` 會在 seek 當下把正在用的連線拆掉重建**。`preconnectCdn(force=true)` 的作法是「`remove()` 舊 `<link>` 再重建」，對「正在服務 segment 的那個節點」做這件事，等於在最需要它的時候讓瀏覽器有機會回收那條 socket。seek 預熱那邊早就註明過這個陷阱（`warmupSeek` 一律用 `force=false`），keep-warm timer 也寫成 `preconnectBatch(hosts, !inSeekGrace())`，但 `promoteBestCdnNow` 一直是無差別 `force=true`，而它的呼叫點遍布 `switchCdn`、`handleSegmentConnError`、探測快取命中等路徑，很容易正好落在 seek 當下。改成：seek 保護窗內一律不 force，且「正在拉 segment 的節點」任何時候都只補不拆。
- 修正（**「一直換節點」的真正根因**）：換節點的觸發條件用的是**目標線**而不是**危險線**。`minAheadEff`（高碼率 30 秒）的語意是「我們希望存這麼多緩衝」，但它同時被拿來當「該不該換節點」的判斷依據——而換節點是很貴的動作（丟掉熱連線、重做 TCP+TLS、懲罰殘留 10 分鐘），只有在緩衝真的快撐不住時才該做。用目標線當觸發會產生**結構性誤判**：B 站播放器抓 segment 是一陣一陣的（抓一批 → 閒置等緩衝被播掉 → 再抓一批），閒置期間 `buffered.end` 不動、`bufferAhead` 持續下降——完全正常，但這跟「停滯 + 緩衝流失」的特徵一模一樣。**只要播放器自己的穩態緩衝低於我們的目標線（4K 幾乎必然如此），每一個閒置週期都會被判成卡頓**，於是每隔幾秒就換一次節點。使用者實測 log 的鐵證：賽馬量到 `cos` 有 **29.3 Mbps**（高於該片需求的 25.65 Mbps），卻照樣被判「buffered 停滯」並懲罰——速度明明夠，問題出在判定條件。新增 `STALL_DANGER_SEC = 10`，`stalled` / `tooSlow` 改用它當觸發；`needMoreBuffer` 保留給「要不要繼續積極監看」，但不再是動手的理由。實測對照（模擬緩衝穩定在 20~25 秒的健康播放）：舊版切換 **2 次**、軟隔離 **2 個節點**，新版 **0 次 / 0 個**。
- 修正：剛換完節點沒有給新連線 slow-start 的時間。新連線要重做 TCP+TLS 並經歷慢啟動，這段期間量到的速度天生偏低、`buffered.end` 也還沒開始動——不給寬限就會出現使用者 log 裡那種「賽馬切到 `cos` → 下一個 tick 就懲罰 `cos`」的荒謬序列，新節點根本還沒機會表現。新增 `Watchdog.noteCdnSwitched()`，Watchdog 自己換節點與賽馬中途切換都會呼叫，重置停滯累計與 `buffered` 基準並套用一段寬限。
- 修正：`doBakeoff` 裡也有一份「用 `getHealthyCdnList()` 的結果整個重寫 `activeCdnList`」的候選池單向棘輪——跟 `reorderCdnsByLatency` 是同一個 bug，但當初只改了後者。這是候選池即使修過還是會變薄的第二個來源。

**2026-08-19 實機驗證抓到的（本版仍未推版，直接併入 v1.3.3）**

> 這一輪是「腳本已經寫完之後，實際去量它」。分三條路徑：Node vm 沙箱（43 項行為斷言）、
> 從台灣本機用 `Resolve-DnsName` / `curl` 量所有候選節點、以及在真實 bilibili 頁面上讀
> `BiliCDN.diag()` / `.buf()` / 面板與 `performance` 時間軸。**通過的部分**：載入無例外、
> 無未捕捉的 promise rejection、console 全程沒有任何紅字（`ERR_NAME_NOT_RESOLVED` 一行都沒有）、
> 探測路徑確實是 `/crossdomain.xml`、起播當下探測數為 0（延後機制生效）、
> preconnect 剛好 3 個 host 且無重複 `<link>`、PCDN 守門與 BCache 4 碼辨識都正確。
> 以下是**沒通過**的四項。

- 修正（**最嚴重，實機當場重現**）：**判死的時間預算比冷 TLS 握手還短，`upos-sz-mirrorali` 會被系統性誤殺。** 進到使用者瀏覽器時，死節點清單有 4 筆、候選池只剩 **1 個節點**（`cos`），而且最快的 `aliov` 還被關在 24h 黑名單裡。根因量得出來：舊值是 `PROBE_TIMEOUT_MS 2s` + `confirmHostReachable(cdn, 4s)`＝單輪預算 6 秒，`PROBE_TIMEOUT_STRIKES = 2`。但用 curl 從台灣實測，**冷 TLS 握手** `ali` 要 **6.4 秒**、`08c` 7.9 秒、`hw` 8.8 秒（暖機後 `ali` 才降到 0.35~0.56 秒）。也就是說只要探測撞上冷連線，2 秒的探測窗與 4 秒的確認窗會**一起**爆掉，兩輪湊滿 strike 就判死 7 天。v1.3.3 原本的「不再一次定罪」只放寬了次數，**沒有放寬單次的時間預算**，而問題出在後者。改動：新增 `CONFIRM_TIMEOUT_MS = 10000`（大於冷 TLS 實測上界 8.8 秒）並套用到**全部三個** `confirmHostReachable()` 呼叫點——探測逾時那條原本 4 秒、`handleSegmentConnError` 那條只有 2 秒、fetch 被 reject 那條只有 2.5 秒，後兩者都是確認完就直接 `markHostDead()`，同樣會把還在握手的好節點判死；`PROBE_TIMEOUT_STRIKES` 2 → 3。**調參原則寫在常數旁邊：判死的時間預算必須大於冷 TLS 的實測上界，而不是大於暖機 RTT。**
- 修正：**刑期與證據強度不相稱。**「逾時」是三種死因裡證據最弱的一種——它只代表「在我們給的窗口內沒回應」，而沒回應可能只是冷握手比窗口慢；`DNS`（NXDOMAIN）則是穩定事實。舊版兩者都判 7 天。新增 `DEAD_HOSTS_TIMEOUT_TTL = 1 天`（`deadTtlFor()` 依死因分級：逾時 1d / 一般 7d / DNS 30d）。真的壞掉的節點隔天照樣會再被判一次，成本只是一輪探測；誤殺的好節點則隔天就回得來。
- 修正：**改了刑期規則，既有紀錄卻永遠用舊規則服完刑。** `markHostDead()` 第一行是 `if (knownDeadHosts.has(host)) return`，而 `probeCdnLatency` 與 `handleSegmentConnError` 開頭也都有 `knownDeadHosts.has(cdn)` 提前 return——所以一個 host 一旦死了，就**不會再有任何程式碼路徑去更新它的刑期**。實機證據：使用者機器上 4 筆死節點全是舊版寫的 7 天，v1.3.3 宣稱的「DNS 類 30 天」對它們從來沒生效過。修法是把校正移到**載入時**（`knownDeadHosts` 的 IIFE）依 `deadTtlFor(e.reason)` 重算，且**只往縮短的方向夾**：規則放寬要能立刻把誤殺的節點放回候選池，規則收緊則不該追溯加重當初依舊規則判下去的刑期。這是 [[cached_state_outlives_fix]] 的同一類問題——只改寫入端不夠，得有一條讓既有狀態自己跟上的路。
- 修正（文件與實作不一致）：CHANGELOG 把 `Watchdog.stats()` 的對外入口寫成 `BiliCDN.stats()`，但後者是**改寫統計**，兩者是不同的函式；真正的入口是 `BiliCDN.buf()`。而且 `buf()` 算了 `switchCount` / `stallCount` / `breakerSec` 卻**只放進回傳物件、沒有印出來**——被本文件稱為「最直接的判讀依據」的三個數字，使用者在 console 裡其實看不到。兩邊都修：`buf()` 補印一行（斷路器跳脫時直接寫出「換也沒用，瓶頸在頻寬/碼率/跨境線路」），`stats()` 補一行指路。

**第三輪實測：把「暖機值當冷路徑用」的最後兩處清掉（2026-08-19）**

> 使用者重貼後再跑一次 `BiliCDN.probe()`，紅字剩一行、但診斷裡浮出兩件更值得修的事：
> `軟隔離（session）: ['upos-sz-mirrorali', 'upos-sz-mirrorhw']`（**好節點又被隔離了**），
> 以及 `cos: {mbps: 201.32, samples: 98}` —— 而 `目前最佳` 正是被這個數字推成 cos 的。

- 修正（**紅字歸零**）：上一輪留下的 `includePresumed` 出口自相矛盾，整個移除。當時的想法是「背景邏輯不打、但使用者手動 `BiliCDN.probe()` 時仍可實測」，可是同一輪也才剛確立「探測是 no-cors、讀不到狀態碼，量到的值不足以讓節點重回候選池」——既然量到也不能用來做任何決定，那一發請求就換不到任何資訊，**只剩下 console 一行紅字**。使用者實測的 `upos-sz-mirrorhw ... 959` 就是它。改成一律不打，`probe()` 改為把這幾台的已知狀態（死因＋剩餘天數／預設清單推定）列出來，並說明唯一有效的翻案方式：`BiliCDN.setCdn("<完整 host>")` 讓它真的去服務 segment，成功後 `successes` 寫入、推定自動失效。**至此腳本在任何情況下都不會主動產生失敗請求。**
- 修正：**`PROBE_TIMEOUT_MS` 2000 → 8000。** 這是同一個錯誤犯的第三次：1200ms → 2000ms → 8000ms，前兩次都拿**暖機**往返時間去訂一個**永遠發生在冷連線上**的窗口。探測之所以要探測，正是因為那個 host 當下沒有熱連線，所以它遇到的必然是冷路徑。curl 實測冷 TLS：`ali` 6.4 秒、`08c` 7.9 秒、`hw` 8.8 秒（暖機後 `ali` 才 0.35~0.56 秒）。2000ms 對 `ali` 是**必定逾時**，於是每輪探測都把一台好節點丟進 5 分鐘軟隔離。8000ms 涵蓋真實候選的冷握手，又低於 `CONFIRM_TIMEOUT_MS`（10 秒）保留確認空間；探測不在起播關鍵路徑上且各候選並行，多等這幾秒沒有代價。
- 修正：逾時但確認可達時，舊版 `recordCdnLatency(cdn, PROBE_TIMEOUT_MS)` 記的是一個**捏造的平坦常數**，讓所有逾時節點看起來一樣慢，也把假數字摻進 EWMA——使用者看到的 `ali: latency 1701` 不對應任何一次真實量測。改記真實耗時。同時新增 `PROBE_SLOW_STRIKES = 2`：「連得到、只是比窗口慢」要**連續兩輪**才軟隔離。一次慢有太多無辜原因（冷握手、頁面自己在搶連線配額），而軟隔離 5 分鐘等於這段時間完全不考慮這個節點。任何一次窗內回應都會把計數歸零。
- 修正（**選路被假數據主導**）：`recordCdnThroughput()` 把**每一筆**傳輸都餵進 `ewmaMbps`，包含 init segment（~1KB）、小段 Range 請求，以及**從 HTTP 快取回來的回應**（`durationMs` 被 `Math.max(1, …)` 夾成 1ms）。這些算出來的不是頻寬，是除以趨近零的分母：64KB / 2ms = 262 Mbps。使用者實測的 `cos: {mbps: 201.32, samples: 98}` 就是這樣堆出來的——而 `ewmaMbps` 是選路計分的主要項，於是 `目前最佳` 被推成 cos，儘管**同一份診斷裡** cos 的 latency 是 516ms、`aliov` 只有 142ms（curl 實測 TTFB 亦然：cos ~1000ms、aliov ~70ms）。實質效果是「**誰剛好命中快取，誰就被判定為最快的節點**」。新增最小樣本門檻 `MIN_THROUGHPUT_SAMPLE_BYTES = 128KB` 與 `MIN_THROUGHPUT_SAMPLE_MS = 5`：不夠大／太短的傳輸仍計入 `h.bytes`（面板累計下載量要準），但**不進 `ewmaMbps`、不算一個 sample**——`samples` 的語意就是「有幾次有效的吞吐量量測」，計分與抖動估計都靠它加權。順帶：128KB 這個門檻本來就存在，舊版只拿它判 `slowSamples`，現在提升為兩者共用。
- 新增：吞吐量資料的一次性重置（`throughputSchema` = 2）。修了規則不代表被規則汙染的資料會自己乾淨——使用者機器上那 98 個假樣本會繼續影響選路直到 TTL 過期。載入時若 schema 版本落後就清掉 `ewmaMbps` / `varMbps` / `samples` / `slowSamples`，**保留 `successes` / `failures` / `latencyMs`**（那幾項不受這條規則影響，清掉等於白白丟資料）。同 [[cached_state_outlives_fix]] 的處理原則。

> **這三輪回頭看，同一個根因反覆換皮出現了三次**：把「暖機情境量到的數字」當成
> 「冷路徑會遇到的數字」（PROBE_TIMEOUT_MS 三次調參）、把「有回應」當成「可以用」
> （no-cors 讀不到 959）、把「傳完了」當成「量到頻寬了」（1KB / 快取命中也算一個樣本）。
> 共通點是**量測的前提條件沒有跟著判斷一起被檢查**。下次新增任何「用輕量觀測代替真實
> 情境」的機制時，先寫下這三個問題：我量的是不是我要判斷的那件事？這個值在最壞情況下
> 是多少？拿它做決定的門檻有沒有涵蓋那個最壞情況？

**軟隔離其實不是暫時的：一個 2~10 分鐘的處分把節點鎖到兩小時後（2026-08-19，本輪的結構性修正）**

> 使用者問「這是不是最優解，不然一直改不是辦法」。答案是：前面每一項修的都是真 bug，
> 但它們有一個共同的上游沒被處理。`BiliCDN.diag()` 的完整狀態暴露了它——
> `black: [ali]`、`soft: {cos, aliov}`：**三個候選節點同時處於處分中**，
> 選路已經完全靠 fallback 在跑。

- 修正（**結構性**）：`softBlockCdn()` 除了設到期時間，還做了 `activeCdnList.splice(idx, 1)`，把節點**從候選池母體移除**。但到期時只有 `isCdnSoftBlocked()` 變回 `false`，**沒有任何路徑把它放回池子**——只有 `403-single` 與斷路器 retraction 兩個窄分支會還原，而一般的 `probe-slow` / `probe-timeout` / `net-fail` / `fragment-error-*` / Watchdog 的 `CDN_SOFT_BLOCK_MS` 都不會。於是一個號稱「2~10 分鐘」的暫時處分，實際效果是**移出候選池直到兩小時後的下一輪探測重建**。而且會自我強化：被移出池子就選不到，選不到就不會成功，不成功就更不會有人把它放回來。
  這正是這份腳本反覆出現的同一個錯誤：**用「此時此刻的狀態」去編輯「整個 session 的候選池母體」**。`reorderCdnsByLatency` 與 `doBakeoff` 的單向棘輪已經各修過一次，註解就寫在那裡（「只重新排序，**不縮減集合**」），但沒有人回頭檢查 `softBlockCdn` 犯的是同一個錯。
  修法是直接移除那行 splice。被隔離的節點已經被**三層獨立地**擋住：(1) `isCdnStronglyBad()` 內含 `isCdnSoftBlocked()`，`getHealthyCdnList()` 的 `usable` 會濾掉它；(2) `getCdnHealthScore()` 的 `softPenalty = 1.5`（大於 1，必定排到最後）；(3) `getBestCdn` / `preconnectCdn` / 賽馬候選等處各自都有檢查。差別只在於：到期之後它會**自己回到可選狀態**。另外，全部節點都被隔離時 `usable` 為空會退回 `pool`（照分數排序），比候選池被掏空健康得多。

**懲罰力道要跟候選池大小成比例（2026-08-19，發布版的正確一般解）**

> 使用者指出上一節的結論不能用：「僅針對我目前這台電腦的狀況而已，我這是要面向其他使用者」。
> 完全正確。把 `aliov` 寫死等於把一台機器的實測結果強加給所有人——別人的電信商、路由、
> 是否掛 VPN 都不同，而這份腳本的整個價值就在於**它會自己學出每個人網路上最快的節點**。
> 真正該修的不是「選哪個節點」，而是「懲罰機制假設了一個不存在的大池子」。

- 修正：`addToBlacklist()` 加上與候選池大小連動的煞車。黑名單是 **24 小時**的重罰，這個設計預設池子夠大、關掉一個的代價很小；但升級門檻只是 `cdnFailCount >= 2`，而台灣環境的實際可用候選常常只有 3 個。也就是說**一次 Wi-Fi 斷線或 VPN 重連，就能讓每個正在使用的節點各記 2 次失敗，把整個池子一次關光**，接下來 24 小時無節點可用。新增 `MIN_USABLE_POOL = 2` 與 `countUsableCandidates()`：若關掉這個之後可用節點會少於門檻，就**不關**，降級成一次軟隔離（現在的軟隔離是真的會到期的，見上一節）。「這個節點目前表現不好」仍然被表達出來——選路會排開它——但不會演變成「整天都沒有節點可用」。
  這條規則**與使用者的網路環境無關**：不管誰的機器上哪一台最快，池子見底時的正確反應都是「降級處分」而不是「繼續關人」。實測驗證：連續對三個節點各觸發一次黑名單，舊版會全關 24 小時，新版最多關到剩 2 個可用。

**關於 `upos-sz-mirroraliov` 是不是「一個節點」**：不是，它 CNAME 到 `queniuaa.com`、8 個 A 記錄、TTL 3 秒——`setCdn()` 固定它不等於綁死單一台機器。詳見下面的〈實驗記錄〉實驗 3。

**探測讀不到狀態碼：`BiliCDN.probe()` 會把區域拒絕的節點放回候選池（2026-08-19 使用者實測回報）**

> 使用者按建議跑了一次 `BiliCDN.probe()`，結果 console 出現
> `upos-sz-mirrorhw.bilivideo.com/crossdomain.xml?_c=... 959`，而診斷顯示
> `白名單順序` 從 3 個變成 4 個、多出來的正是 `upos-sz-mirrorhw`，只被軟隔離 5 分鐘。

- 修正：**探測「量到了」不等於「可以用」。** `probeCdnLatency()` 與 `confirmHostReachable()` 都是 `mode: 'no-cors'` 的 fetch，拿到的是 **opaque response ——讀不到狀態碼**。這在設計上是刻意的（見前面「重構：延遲探測併成單一 no-cors fetch」：resolve = 有回應 = 可達），但它有個沒被想到的後果：**959 這種「伺服器明確拒絕你」的回應，在探測層看起來跟 200 完全一樣**。959 是 Bilibili 對台灣 IP 的區域拒絕自訂碼，它本來就列在 `HARD_FAIL_STATUSES`（403/451/959）裡、在 segment 層一次就會被判死——但探測層永遠看不到它。於是 `upos-sz-mirrorhw` 被判成「可達、只是慢」，拿到一個有限的延遲值，重新進入 `activeCdnList`。
  修法不是去猜狀態碼（opaque 就是讀不到），而是修正**資格認定**：候選池重建時一併濾掉 presumed 節點。一次 `/crossdomain.xml` 的 opaque 回應根本回答不了「這台能不能服務影片」，沒有資格解除「已知在台灣不可用」的推定；真正有資格解除它的是**實際服務過 segment**——那會寫進 `successes` / `samples`，`isPresumedDnsFailHost()` 隨即自動轉為 `false`。這條路本來就存在，只是先前沒有把「探測成功」與「服務成功」區分開。
- 修正（可用性）：`BiliCDN.probe()` 現在會把 presumed 節點的實測結果**單獨列出來**（標明「僅供參考，不會放回候選池」），並說明真正要解除推定的作法（`BiliCDN.setCdn("<完整 host>")` 固定使用它，成功服務過就自動解除；`BiliCDN.setCdn("null")` 改回自動）。不加這段的話，使用者會看到「我手動測了、它有回應、但清單裡還是沒有它」而無從理解——這正是實測當下的困惑點。

> **這一題的通則**：把「可達性」和「可用性」當成同一件事，是這份腳本反覆踩到的坑。
> `no-cors` 換來的是「不會被 CORS 擋、不會噴 CORS 錯誤」，代價是**放棄所有回應內容**，
> 包括你最需要的狀態碼。用它做的判斷，結論只能停在「有東西回應了」，
> 不能延伸成「這台可以拿來播影片」。

### 四、選路與起播

**選路與起播**

- 修正：起播改用純 exploit 計分。`getCdnHealthScore()` 的 `exploreBonus` 是多臂拉霸機的標準設計，會刻意給樣本少的節點加分讓它有機會被選中；長期是對的，但代價是「偶爾會中獎選到一個沒把握的節點」——而這個代價會落在最禁不起出事的地方：playurl 改寫的當下，也就是使用者剛點進影片正要起播的那一刻。探索其實已經有專屬管道，賽馬（`doBakeoff`）本來就會挑「缺新鮮樣本」的候選去實測；用賽馬探索的成本是幾百 KB 的背景流量，用起播探索的成本是使用者盯著轉圈圈。新增 `STARTUP_PICK = { exploit: true }`，由 `transformStreamItem()` 與 `buildBackupUrls()` 套用。刻意維持完整 UCB 的路徑：Watchdog 卡頓後換節點、賽馬後重排序、`promoteBestCdnNow()`——那些情境本來就是「現在這個已經不行了，該去試點別的」。注意 `getBestCdn()` 的黏著滯後比較，兩個分數必須用同一種模式，否則一邊有探索加成一邊沒有，`CDN_STICKY_MARGIN` 的保護會被系統性偏差整個吃掉。
- 修正：起播緩衝未建立前不跑賽馬。`scheduleBakeoff` 在 playurl 之後 1.5 秒（高碼率 4 秒）就開跑，正好落在「播放器正在抓第一批 segment」的當下——測速會連續打 1~4 顆候選、每顆最多 768 KB，**直接跟起播搶頻寬**。原本有 `skipIfFast` 捷徑，但它拿 `activeCdnList[0]` 的健康資料判斷，而起播實際用的節點是 `getCurrentCdn(STARTUP_PICK)` 挑的，兩者可能不同，捷徑常常判不到、照跑不誤。改成緩衝未達 `STARTUP_MIN_BUFFER_SEC`（12 秒）就讓路，每 2 秒再看一次，且**有上限**（`MAX_STARTUP_DEFERS` = 3）——否則遇到「怎麼都緩衝不起來」的爛節點時，這個保護反而會讓賽馬永遠不跑，錯過換掉爛節點的機會。只延後「起播排程」那種賽馬；Watchdog 偵測到真卡頓、週期性重評估（`skipIfFast=false`）完全不受影響，那些情境代表已經出事，不能再等。
- 修正：賽馬改用「真正在拉 segment 的節點」。`playingHost` 過去一律取 `activeCdnList[0]`，但那是延遲探測排序的結果，**不一定是實際在服務 segment 的那一個**。認錯節點造成兩個後果：把正在播的節點也拿去測速（白白多佔一次頻寬，而且它本來就有 PerformanceObserver 的真實樣本，測了也是重複）、`addForcedRedirect()` 加在一個根本沒在用的 host 上（等於沒切換）。新增 `Watchdog.getLastSegmentCdn()` 與 `getPlayingCdnHost()`（優先用真實 segment host，退回 `lastChosenCdn`，最後才是 `activeCdnList[0]`）。
- 優化：`startCdnProbe()` 在 document-start 立刻對「這次最可能用到的節點」preconnect，再去跑排序。舊版要等延遲探測跑完（一秒以上）才會 preconnect，但 playurl 可能更早到，那樣第一個 segment 就得從零做 DNS + TCP + TLS 握手，跨國情境下就是好幾百毫秒的起播延遲。preconnect 幾乎零成本，沒用到的連線閒置一陣子就被瀏覽器回收。

**起播關鍵路徑上的浪費**

> 這一組是把「起播那幾百毫秒裡，腳本自己做了哪些其實不必做的事」逐項清掉。共通的判斷標準是：
> 這件事對「這次要用哪個節點」有沒有貢獻？沒有貢獻卻佔用 document-start 的頻寬、DNS 解析器
> 或 CPU，就該延後或刪掉。

- 修正：document-start 不再對**整份白名單**無差別 preconnect。舊版有一行 `preconnectBatch(PREFERRED_CDN_LIST.filter(h => !knownDeadHosts.has(h)))`，扣掉死節點與排除關鍵字之後會一次開 6 條連線，但一次播放最多只用到 3 個（primary + 2 個 backup）——多出來的 3 條全是純浪費，而且浪費在最不該浪費的時機：頁面 HTML/JS/CSS 還在下載、playurl 正要發出的當下。跨海一條 preconnect 是 DNS + TCP（1 RTT）+ TLS（約 2 RTT），六條同時開會佔滿 DNS 解析器與 socket 配額，跟真正要用的那幾條互搶。更糟的是它連**解析不出來的 host 也照開**（例如台灣的 `upos-hz-mirroraliov`），在首次升級、還沒被標死之前等於在起播當下白白排隊等一次 DNS 失敗。改由 `startCdnProbe()` 精準熱身，順帶修掉「腳本已停用（`disabled`）時這行照樣開六條連線」的舊行為。
- 修正：起播 preconnect 熱身的對象改成「playurl 這次真的會寫進去」的那組 host——primary 用 `getCurrentCdn(STARTUP_PICK)`、backup 用 `getHealthyCdnList(STARTUP_PICK).slice(0, 2)`，跟 `transformStreamItem` / `buildBackupUrls` 完全一致。舊版 backup 那兩顆取自 `activeCdnList` 的 index 順序，而 index 只是「所有候選都沒有實測樣本」時的退路排序，跟實際會被寫進 `backup_url` 的節點常常不同——等於熱身了兩條用不到的連線，真正的 backup 反而是冷的。
- 修正：起播期間不再跑全量延遲探測。`reorderCdnsByLatency` 在探測快取沒命中時會對每個候選發一次 Image 探測（v1.3.3 之後還多一次可達性確認 fetch），而它被呼叫的時機正是 document-start。但這份排序的產物（`activeCdnList` 的 index 順序）在 `getHealthyCdnList()` 裡**只是「所有候選都沒有實測樣本」時的退路**——只要有任何一個候選有 `samples`，排序就完全由 score 決定，index 只當同分時的 tie-break。也就是說對已經用過一陣子的使用者，這批探測請求對「這次要選哪個節點」毫無貢獻，卻實實在在跟起播搶頻寬與 DNS 解析器。改成有健康資料就延後到起播緩衝建立之後再跑（沿用賽馬那套讓路機制，最多讓 12 秒），完全沒有樣本（全新安裝、或剛 `BiliCDN.reset()`）才立刻跑；`BiliCDN.probe()` 手動觸發的 `force=true` 不受影響。代價是死節點偵測跟著延後，可以接受——`handleSegmentConnError` 會在第一次真的失敗時就確認並標死，不必等這輪探測。
- 修正：playurl 改寫結果加上記憶化。`responseText` / `response` 是 **getter**，舊版每被讀一次就整套重跑一次「`JSON.parse` → `sanitizePlayInfoUrls` 走訪整包幾百個字串欄位 → `JSON.stringify`」，而 4K 多畫質 + 多 backup 的 playurl 回應可以到幾百 KB。這有兩個後果：**速度**上這段完全落在起播的關鍵路徑（playurl 到手到第一個 segment 發出之間），而播放器「先看長度／try 一次 parse／再正式 parse」這種多次讀取的寫法非常常見，讀兩次就是兩倍成本；**正確性**上 `redirectStats` 的計數（包含診斷面板拿來判讀的 `pcdnSkipped`）會按「被讀幾次」而不是「有幾包回應」累加，被不明倍率灌水，失去判讀價值。改成以原始值當 key 記憶化，`responseText` 與 `response` 各存一格（它們可能被交替讀取，共用一格會互相沖掉反而每次都 miss）。
- 修正：seek 預熱熱身的是「真的在服務 segment 的那一個」（`getPlayingCdnHost()`）。舊版 `seekWarmHosts()` 只從 `akamaiHostSeen` 與 `activeCdnList[0..1]` 取，一樣犯了拿 index 當實際節點的錯。seek 預熱之所以有意義，正是因為緩衝拉滿之後播放器會停止抓取、連線閒置幾秒就被瀏覽器回收——被回收掉的是「剛剛正在用的那條」，不是排序第一名那條，認錯節點等於整個機制對 seek 沒有幫助。第三順位補上 `getHealthyCdnList(STARTUP_PICK)`，順序跟 `buildBackupUrls` 一致，這樣 seek 之後就算主流出事，備援也是熱的。

以上五項用 Node `vm` 載入腳本 + DOM/GM 樁做行為測試，並把改動還原成舊實作當對照組跑同一套測試，實測差異：讀 3 次 `responseText` 從轉換 3 次降到 1 次；起播當下發出的延遲探測從 6 個降到 0 個；載入當下的 preconnect 從 6 個 host 降到 3 個。

**節點順序不穩：單輪冷連線就能把最快的節點排到最後（2026-08-19 使用者回報「不太穩定」）**

> 使用者回報紅字已經消失，但「順暢度沒上來、偶爾拉進度條跳轉會加載蠻慢」。
> 診斷裡有一個直接的矛盾：`目前最佳: upos-sz-mirrorali`，但 `頁面發現 CDN: upos-sz-mirroraliov`，
> 而白名單順序是 `[ali, cos, aliov]` —— **最快的節點被排到最後**。

- 修正：`reorderCdnsByLatency()` 用**這一輪的原始值** `r.ms` 排序。但單輪的 `r.ms` 幾乎完全由「這條連線當下是冷是熱」決定（實測冷熱差距：`ali` 冷 6.4 秒 vs 暖 0.4 秒，超過十倍），拿它當唯一依據等於讓節點順序隨機跳動——而 `activeCdnList` 的順序在「所有節點都還沒有吞吐量樣本」時，正是 `getHealthyCdnList()` 的排序依據。於是這個雜訊會一路傳到選路：使用者那一輪排出 `[ali, cos, aliov]`，但同一份診斷裡 `aliov` 的 `latencyMs` 是 142ms、`cos` 是 516ms，curl 實測 TTFB 更是 `aliov` ~70ms / `ali` ~560ms / `cos` ~1000ms。改成用 `cdnHealth[].latencyMs`（`recordCdnLatency()` 維護的 EWMA，本輪的值已併入）排序——這個欄位本來就是為了吸收抖動而存在的，先前卻沒有被排序用到。
- 修正：`getHealthyCdnList()` 在「雙方都沒有吞吐量樣本」時直接退回 `a.index - b.index`，隱含假設「`activeCdnList` 的順序就是延遲順序」。那只在剛跑完探測時成立——黑名單還原、死節點救回等路徑是照 `PREFERRED_CDN_LIST.indexOf` 重排的，那是一份**寫死的靜態順序**，跟這台機器的實測快慢無關。於是在「還沒有吞吐量樣本」這段期間（正是剛裝好、或吞吐量資料剛被重置、而且起播最需要選對節點的時候），選路可能完全忽略我們明明已經量到的延遲差距。補上：先比實測延遲，有量測資料的優先於完全沒量過的，都沒有才退回 index。有吞吐量樣本時維持原本由 `getCdnHealthScore()` 決定，不受影響。

> 補充說明「seek 偶爾很慢」的其餘部分：節點順序修正之後仍可能發生，因為主要成因是
> **CDN 對那個位元組範圍沒有快取、要回源**——那屬於下面「已知未處理項目」的 `og` 議題，
> 腳本層面沒有安全的解法（`og` 對應的境內 mirror 命中快取機率高，但從台灣連過去的線路
> 品質不一定更好，沒有實測數據不能賭）。想要最穩定的體驗，可以直接固定最快的節點：
> `BiliCDN.setCdn("upos-sz-mirroraliov.bilivideo.com")`，恢復自動用 `BiliCDN.setCdn("null")`。

**推版前 Node vm 實測抓到的**

> 用 `vm.runInContext()` 把整份 userscript 載進 Node 沙箱（DOM / GM / XHR / fetch 全樁），
> 對照本版每一項改動逐條驗證。載入無錯誤、無未捕捉的 promise rejection，43 項行為斷言中
> 41 項一次通過；以下兩項不符預期，都是本版新程式碼與既有機制的交界處。

- 修正：`startCdnProbe()` 的起播預熱**少熱一個 host**，而且少的正好是最需要它的那一個。本版把預熱對象改成「playurl 這次真的會寫進去的那 3 個」，寫法是 `[getCurrentCdn(STARTUP_PICK), ...getHealthyCdnList(STARTUP_PICK).slice(0, 2)]`——但 primary 幾乎總是排名第一，所以先 `slice(0, 2)` 再交給 `preconnectBatch` 的 `Set` 去重時，backup 的第一顆會跟 primary 重複被吃掉，實際只熱身到 **2 個**。而 `buildBackupUrls()` 是先 `filter(cdn !== primaryHost)` **才** `slice(0, 2)`，拿到的是不重複的兩顆——於是第二顆 backup 永遠是冷的，它偏偏就是「primary 失敗後播放器第二個會試」的節點，要救場時卻得從零做 DNS + TCP + TLS。修法是讓兩邊的順序一致（先剔除 primary 再 slice）。實測對照：修正前預熱 `cos, ali`／實際寫入 `cos, ali, aliov`（`aliov` 冷連線）；修正後兩者完全重合。
- 修正（**與上一版那條「過濾順序寫反了」是同一個 bug 的上游**）：`getHealthyCdnList()` 的可達性優先只補在**排序層**，但候選池會從**成員層**被掏空。`cdnFailCount` 累積到 `CDN_FAIL_THRESHOLD`（**2 次**）就會 `addToBlacklist()`，而黑名單是直接把節點從 `activeCdnList` **移除**的。也就是說一次網路斷線（Wi-Fi 掉線、VPN 重連、切換行動網路）就能讓每個正在用的節點各記 2 次失敗、一次全部清出候選池——池子裡只剩那幾個「從沒被用過、所以也從沒失敗過」的已知不解析節點，`reachable` 篩完是空的，`base` 退回 `all`，於是**每一顆 segment 都被改寫到 NXDOMAIN**。而黑名單一綁就是 **24 小時**：使用者看到的是整天完全播不出來加上滿螢幕 `ERR_NAME_NOT_RESOLVED`，比原本那個網路問題嚴重得多。修法是在「候選池裡連一個可達節點都不剩」時，從 `PREFERRED_CDN_LIST` 撈回可達的節點當退路——**寧可用一個被黑名單過、但至少解得到 IP 的節點，也不要用一個必定失敗的**。正常情況（只要還有任何一個可達節點在池內）完全不受影響。實測對照：修正前 `getBestCdn()` 回傳 `upos-sz-mirrorhwov`、segment 實際被改寫過去；修正後回到 `upos-sz-mirroraliov`。

### 五、console 錯誤與多分頁

**紅字回歸：`force` 是個過寬的旗標（2026-08-19 使用者實測回報）**

> 使用者回報 console 又出現 `ERR_NAME_NOT_RESOLVED`，堆疊是
> `probeCdnLatency ← reorderCdnsByLatency ← (3904)`，對象是 `hwov` 與 `hz-aliov`
> 這兩個確定 NXDOMAIN 的 host。追下去發現不是回歸，是**這道防線從一開始就有兩個洞**，
> 只是先前的驗證剛好都沒走到那兩條路徑。

- 修正（**紅字的真正根因**）：擋掉 presumed 節點探測的條件寫成 `isStartupRun && !force && isPresumedDnsFailHost(h)`，而 `force` 這個旗標**被兩種完全不同的意圖共用**：一種是「忽略快取與起播讓路，現在就重排」（內部邏輯用的：Watchdog 判定卡頓後的重新評估、救回節點之後的重排），另一種是「我要重新確認那些已知壞掉的節點」（使用者手動 `BiliCDN.probe()`）。於是 **Watchdog 每判定一次卡頓，就會繞過這道過濾、對 `hwov` / `hz-aliov` 各打一發必定失敗的請求**——頻率遠高於原本以為的「30 天一次」，而且剛好發生在使用者正在為卡頓皺眉的時候。第二個洞是 `isStartupRun`：它只擋起播那一輪，延後執行的那一輪照打不誤。改法是把兩種意圖拆成兩個參數：`reorderCdnsByLatency(force, includePresumed)`，過濾條件改成 `!includePresumed`，而 `includePresumed` 只有 `BiliCDN.probe()` 會傳 `true`。（**後續修正**：這個出口在同一天稍後被整個移除——見下一節，它自相矛盾且是最後一行紅字的來源。）
- 修正：`preconnectCdn()` 只擋 `knownDeadHosts` / 黑名單 / 軟隔離 / 排除關鍵字，**沒有擋 presumed**。目前所有呼叫端都先經過 `getHealthyCdnList()`（會濾掉 presumed）所以還沒出事，但那是呼叫端的性質、不是這個函式的保證——死節點機制的設計目標寫的就是「跳過所有 probe/**preconnect**」，這一半一直沒實作。補上。
- 修復（死碼）：`BiliCDN.probe()` **被定義了兩次**（`async probe()` 與 `probe()`），同一個物件字面量裡的重複鍵後者覆蓋前者，所以前面那個從來沒有被執行過。這是 v1.3.3 補實作 `probe()` 時重複加上去的。刪掉被覆蓋的那個，保留會清探測快取的版本。
- 清理：`isStartupRun` 在上述修正之後失去唯一讀者（過濾條件不再需要區分「是不是起播那一輪」），一併移除。

> **這一題的通則**：一個布林旗標一旦被兩種不同的意圖共用，它就會在其中一種意圖下做錯事，
> 而且錯的那一次通常不在測試涵蓋範圍內——因為寫測試的人心裡想的是另一種意圖。
> 這次是 `force`：驗證時測的是「起播不打紅字」（`isStartupRun` 那條），
> 而漏掉的是「卡頓後重排也不該打紅字」（`force` 那條）。

**全面稽核：把「腳本自己會製造的 console 錯誤」逐類清掉（2026-08-20）**

> 目標訂得很明確：**主控台不該出現任何本腳本造成的錯誤**。做法是把「腳本會發出的請求」
> 與「腳本會產生的例外／拒絕」兩類來源逐一列舉、逐一驗證，而不是等使用者回報再追。

- 修正：**HTTPDNS 阻擋會製造 `Uncaught (in promise)`**。`fetch` 那條路是 `Promise.reject(new DOMException(...))`，但我們**不控制呼叫端**——B 站的 HTTPDNS 客戶端若沒有 `.catch()`，被拒絕的 promise 就會在 console 留下一行紅字。阻擋機制本身不該是噪音來源（跟探測路徑改用 `/crossdomain.xml` 同一個原則）。fetch 沒有「不 reject 的網路錯誤」可用，所以改成**合成一個失敗回應**：503 + 合法 JSON body，同時滿足「檢查 `res.ok`」與「直接 `res.json()`」兩種客戶端寫法，且不會二次拋錯。合成的 Response 沒有經過網路層，瀏覽器不會有任何 network entry 或 console 輸出。對照組：XHR 那條路本來就是補送 `error` + `loadend` 事件（XHR 的 error 事件不印紅字），這次是讓 fetch 對齊它的行為。
- 修正（**狀態持久化不完整**，兩個欄位）：`probeSlows`（2026-08-19 新增）在 `ensureCdnHealth` 預設值、存檔 payload、載入器**三處都沒有接上**；`probeTimeouts`（既有）則是**有寫入存檔卻從未被讀回**，是個只寫不讀的欄位。後果一樣：兩個「連續 N 輪才定罪」的 strike 計數**只在單一頁面 session 內成立**，重整一次就歸零——而探測最快兩小時才跑一輪，等於門檻永遠達不到，機制形同虛設。三處一起補齊，載入時用小上限夾住避免殘留異常值一載入就定罪（上限寫字面量而非引用 `PROBE_*_STRIKES`，那兩個常數定義在檔案更後面，載入期引用會踩 TDZ）。
- 查證後確認**沒有問題**：`cdnHealth` 的跨分頁合併**早就實作了**（`scheduleCdnHealthSave()` 存檔前先讀回 GM 最新內容，逐 CDN 以 `lastSeen` 較新者為準）。前一節把它列為「待處理」是誤判——從「共用儲存 + 整包寫入」這個模式直接推論，而沒有先讀那段程式碼。
- 稽核結果（無需修改）：全檔無死碼（本批新增的 15 個符號全部有被引用）；沒有漏接 `.catch` 的自有 promise 鏈；`err()` 預設被 `Config.verbose`（false）擋住；只有 3 處未經 verbose 把關的 `console.error/warn`，分別只在「CustomCDN 填了非法網域」「Worker module import 失敗」「`revive()` 傳入不存在的 host」時觸發，正常使用不會出現。

**驗證方式**

- 新增 `tests11.js`：把**每一個對外 API** 與媒體 URL 的攔截路徑都跑一遍，並在 **`ok` / `fail` / `403` 三種網路模式**下各跑一次（沙箱的 fetch/XHR 樁可切換成全部拒絕或全部 403），斷言**零未捕捉的 rejection、零例外**。含「全部節點都死」的極端狀態。
- 新增 `tests12.js`：驗證狀態持久化的三處一致性，含「存檔後再讀回不遺失」與「較新的另一分頁資料不被覆寫」。
- 12 套測試共 **212 項，連跑 3 輪全部 0 失敗**；`tests11` 另外在 3 種網路模式下各 38 項全過。
- 用 curl 重新確認 7 個候選節點的探測路徑**全部回 200**（cosov 對照組確認仍是 403，證明排除正確）。過程中量到 `upos-sz-mirrorali` 是**間歇性黑洞**（4 輪裡 1 輪 TCP 完全連不上、15 秒無回應，其餘 3 輪 0.56~0.77s 正常），且它的 IP 段一天內從 `221.178.37.x` 換成 `116.77.74.x`——這正是 8 秒探測窗 + 10 秒確認 + 連續 3 次才判死的設計要吸收的情況，且我們的 abort 一定早於 Chrome 自己的 TCP timeout，不會留下紅字。

> **能保證與不能保證**：腳本**自己發出的請求**現在全部指向已實測回 200/206 的端點，
> 且不會產生未捕捉的 rejection——這部分可以保證。但**不能保證 console 永遠乾淨**：
> 被改寫後的 segment 請求若打到當下正好故障的節點（如上述 ali 的間歇性黑洞），
> 瀏覽器仍會記錄該次失敗，那是任何 CDN 都可能發生的事，只能靠健康評分把它排開。

**實驗 5：cosov 回退，與「多開分頁不穩定」（2026-08-20 實機回報）**

> 使用者重貼後回報：console 又有紅字，而且**多開 bilibili 分頁會造成不穩定**。
> 兩份 log 逐行清點的結果：**所有錯誤都來自 cosov**，上一輪新增的其他四個鏡像
> （`alib` / `ali02` / `bos` / `tf-all-tx`）**零錯誤**。

- 回退：`ExcludeHostKeywords` 預設改回 `['cosov']`。**實驗 4 的結論範圍下錯了。**那個實驗證明的是「cosov 能服務一次 16KB 的 range 請求」，我卻拿它推論成「cosov 可以當候選節點」。實機打臉的兩種方式：
  1. **探測必定 403**：`PROBE_PATH` 是 `/crossdomain.xml`，而實驗 2 早就量到 cosov 對這個路徑回 403。把它放進候選池，等於保證每一輪探測都固定產生一行紅字——這是我在實驗 2 的表格裡寫下、卻在做決策時沒有回頭看的資料。
  2. **真實播放會失敗**：`ERR_FAILED 514`，且回應**不帶 `Access-Control-Allow-Origin`**，瀏覽器直接報 CORS 錯誤（實測 URL 是 `os=cosovbv`、`bw=22M` 的 4K/HDR 串流）。一次 16KB 的小範圍請求量不到這個。
  `cosov` 仍保留在 `PREFERRED_CDN_LIST_RAW` 裡，想自己實驗的人 `BiliCDN.include("cosov")` 就能放行，不必改原始碼。
- 修正（**多開分頁不穩定的主因**）：`lastBakeoffAt` 是**純記憶體變數**，於是每個分頁各跑一場獨立的吞吐量賽馬——每場最多 4 顆候選 × 最多 768KB、每 90 秒一輪。開 5 個分頁就是 5 倍的背景流量在跟正在播的影片搶頻寬。
  值得注意的是**既有的跨分頁機制擋不住這個**：`runThroughputBakeoff` 已經有 Web Locks（`ifAvailable`）與 BroadcastChannel 心跳，但那兩者擋的是「**同時**」，不是「**頻率**」——A 分頁測完釋放鎖，B 分頁的 90 秒冷卻是它自己記憶體裡的 `0`，於是立刻接著測，C 分頁再接著測。N 個分頁只是把 N 場賽馬**排隊跑完**，總流量一點都沒省。
  修法：冷卻時間戳改存 GM storage（`lastBakeoffAt_v1`），所有分頁共用，真正收斂成「每 90 秒全域一場」。賽馬結果本來就寫進共用的 `cdnHealth`，所以同一個時間窗內只需要一個分頁去測。時間戳在 `doBakeoff()` 開頭就先寫入（不是跑完才寫），避免兩個分頁同時通過檢查的競爭窗口。

> **這一輪的教訓**：實驗結論的**適用範圍**要跟實驗設計一樣嚴格地寫下來。
> 「一次 16KB range 請求回 206」和「這個節點可以拿來播影片」之間差了：持續傳輸、
> 大位元組數、高碼率/HDR 串流、以及探測路徑本身的行為。我在同一份文件的實驗 2
> 就記下了「cosov 對 /crossdomain.xml 回 403」，做決策時卻沒有回頭交叉比對——
> **有記錄不等於有用到記錄。**

### 六、診斷、API 與死碼清理

**診斷面板新增欄位**

- `改寫統計` → `pcdnSkipped`：命中 `/v1/resource` 而**刻意不改寫**的次數。持續增加＝你的網路環境常被分配到 PCDN，代表 PCDN 那組修正對你有實質效果；長期為 0＝你沒被分到 PCDN，慢片原因在別處。`BiliCDN.reset()` 已同步重置。
- `CDN 吞吐評分` → `scoreStartup`：起播模式（無探索加成）的分數。與 `score` 差距大＝該節點目前主要靠「還沒被測過」在拿分。

**死碼清理**

- 用 acorn 做 AST 分析（先前用正則的版本有 bug：`'https://'` 裡的 `//` 會被誤判成註解，把整行後半吃掉，導致漏報）。刪除：`isHttpDnsAutoAllowing`（宣告後全檔零引用）、`HttpDnsAutoPilot.reloadProfile`（定義後從未被呼叫）、`transformList` 的計數與回傳值（三個呼叫端都不接 `{ total, akamai }`，等於每次都白算一輪）、`probeCdnLatency` 的 `skipped: true`（沒有任何地方讀）、`probeCdnThroughput` 的 `mbps` / `bytes`（數值早在前一行的 `recordCdnThroughput` 就已入帳）。
- 修復（比刪除更好的處理）：**`logRedirect()` 從來沒有真的輸出過任何東西**——它維護了節流狀態（`_redirectLogTs` / `_redirectLogTotal`）、累計了 `redirectStats.quietRedirects`、接收了 `reason` 參數，然後什麼都沒印，整套機制（含 3 個常數、2 個 Map、3 個呼叫點，約 25 行）全部空轉。選擇補回那一行 `log()` 而不是刪掉整套：輸出本來就受 `Config.verbose` 控制、預設靜音，只有使用者主動 `BiliCDN.verbose(true)` 排查時才會出現，刪掉等於永久失去一個本來已經寫好的排查工具；`reason` 參數同時恢復作用。
- 追加清理：換節點觸發條件改用危險線之後，`needMoreBuffer`、`minAheadEff`、`MIN_BUFFER_AHEAD` 三者連鎖失去讀者，一併刪除。這是死碼掃描在推版前抓到的——當時註解還寫著「`needMoreBuffer` 保留給要不要繼續積極監看用」，但那件事其實是由 `monitorAfterReached` 在管，註解是錯的。**不留下「看起來還有作用其實沒有」的變數。**
- 保留（工具誤判，刻意不動）：`pickStreamUrls` 的 `highBitrateItem`（回傳物件裡沒人接，但該函式的註解明說是「特地切成純函式，改版後能直接用單元測試確認」，這是測試介面不是死碼）、`probeCodecCapability` 的 `supported` / `smooth`（只有 `powerEfficient` 會被讀，但保持與 Media Capabilities API 回傳形狀一致有其價值）。另有一批被工具標記、經人工確認是誤判的：公開 API 方法（`BiliCDN.probe` 等，使用者在 console 直接呼叫）、診斷輸出欄位（`jitter`、`scoreStartup` 等，是印給使用者看的）、Worker 訊息協定（`__biliCdn*`，在樣板字串裡以字串形式存取）、動態存取（`CODEC_PROBE_STRING[kind]`）、瀏覽器 API 設定鍵（`childList`、`subtree`）。

---

### 怎麼驗證這一版有沒有用

**怎麼驗證這一版有沒有用**

- PCDN 那組：`BiliCDN.diag()` → `改寫統計` → 看 `pcdnSkipped` 是否在增加。
- 速度判斷那組：播放時 `BiliCDN.diag()` 的 `軟隔離（session）` 應該長時間維持空白；舊版在緩衝略低於門檻時會反覆把節點丟進去。
- 碼率誤判：找一支**有 4K 選項但只看 1080p** 的長片播 10 分鐘，之後看 `軟隔離（session）` 清單。舊版通常會累積好幾個節點，新版應該是空的。
- DNS 那組：**健康節點的探測不該再產生任何 console 紅字**——舊版每輪對每個節點打 `favicon.ico` 必定 403/405，現在打 `crossdomain.xml` 回 200。Network 面板篩 `crossdomain` 可以看到探測請求本身（每個節點每輪 1 個，不是 2 個）。真的連不到的節點仍會紅一次，出現當下 `BiliCDN.diag()` 的死節點清單應該立刻多出那個 host（reason `DNS` 或 `DNS-segment`），之後 30 天內不再出現；若同一個 host 每隔幾天就再紅一次，代表標死沒有被持久化，那是 bug。
- 起播路徑的浪費：F12 → Network → 開影片頁 → 看載入最前面那段有沒有一堆對不同 `upos-*.bilivideo.com` 的 `favicon.ico` 請求。新版對「已經用過一陣子」的使用者應該一個都沒有（延後到緩衝建立之後才跑）；preconnect 的 host 數量應該是 3 個而不是 6 個。
- 遇到慢片時的通用排查：F12 → Network → 篩 `m4s` → 看第一個請求。403/404 後面跟著同路徑不同 host 的重試＝改寫改壞了（本版應已修掉）；200 但 Waiting/TTFB > 1 秒＝節點沒快取正在回源（見下面 `og` 議題）；200、TTFB 短但下載慢＝單純頻寬/節點壅塞，屬正常，腳本會自己切。

### 已知未處理項目

**已知未處理項目**（需實測才能決定）

- **依 `og` 參數選對應 mirror**：`og` 對應的通常是中國境內 mirror（ali/cos/hw），命中快取機率高，但從台灣連過去的線路品質不一定比海外 `ov` 節點好。是「有貨但線路遠」對上「線路好但可能沒貨」，沒實測數據不能賭。影響：熱門片幾乎無差；冷門/舊片首段可能仍多等 0.5~3 秒。
- ~~**放寬候選池**~~ → **已完成（2026-08-20 定案）**。`alib` / `ali02` / `bos` / `tf-all-tx` 經實驗 4 驗證並經實機確認零錯誤，已加入清單，**候選池 3 → 7**。`cosov` 一度解除排除但被實機推翻（實驗 5），維持排除。`INITIAL_DEAD_HOSTS_TW`（hwov / hw / hz-aliov）維持不變，那三個是 NXDOMAIN 或 TCP 握不完，且仍保留「本機成功過一次就自動解除推定」的路徑。
- **4K 強制不用 Akamai**：`preferWhitelistPrimary`（bandwidth > 12M 或 height ≥ 2160）會把 Akamai 從 primary 拉下來。Akamai 在台灣有時解析到美國 IP、有時很快，純調參。影響：部分 4K 片起播可能變慢。
- **保留原始 URL 當保命 backup**：原本要做，實作到一半判定**幫助有限**——播放器只在「硬失敗」時才跳 backup，對「連得上但很慢」完全沒用，而主要症狀正是慢。加了只是徒增複雜度（還要在 `sanitizePlayInfoUrls` 與 `normalizeMediaUrl` 兩處各加白名單保護）。
- **`reorderCdnsByLatency` 的前段排序看似被覆蓋**：檢查後確認**不能刪**——它決定 `activeCdnList` 的 index 順序，而 `getHealthyCdnList()` 在「所有節點都沒有樣本」時正是用 index 排序。（誤判，已排除）

---

### 附錄 A：實驗記錄

**實驗記錄（2026-08-19，台灣網路環境）**

> 這一節把當天所有實測集中在一起，含**方法、結果、以及每個結果能推論到什麼程度**。
> 分開記在各修正條目裡的數字容易被斷章取義——尤其有一組結果事後被判定為無效（見「方法論陷阱」）。

**實驗 1：DNS 解析（`Resolve-DnsName -Type A -DnsOnly`）**

掃過 29 個社群整理過的 upos / bcache host。可解析的：`aliov`、`ali`、`cos`、`cosov`、`hw`、
`bdov`、`alib`、`ali02`、`coso1`、`bos`、`08c`、`upcdnbda2`、`tf-all-tx`、`akam`(akamaized.net)。
**NXDOMAIN**：`hwov`、`hz-aliov`、`ks3`、`ks3b`、`kodo`、`wcs`、`wcsov`、`tfov`、`upcdntx`、
`upcdnws`、`upcdnhw`、`upcdnqn`、`tf-all-js`、`cn-hk-eq-bcache-01`。

→ 可推論：`INITIAL_DEAD_HOSTS_TW` 裡的 `hwov` / `hz-aliov` **確實不存在**，不是「當下連不到」。
→ 不可推論：解析得到不代表可用（見實驗 2、3）。

**實驗 2：連通性與延遲（`curl /crossdomain.xml`，暖機後 3 輪取值）**

| host | 結果 | 是否在候選清單 |
|---|---|---|
| `upos-sz-mirroraliov` | **200，70~140ms** | ✔ |
| `upos-hz-mirrorakam`（Akamai） | 200，~320ms | 只沿用，不主動改寫 |
| `upos-sz-mirroralib` | 200，~600ms | ✘ 清單外 |
| `upos-sz-mirrorali02` | 200，~630ms | ✘ 清單外 |
| `upos-sz-mirrorbos` | 200，~770ms | ✘ 清單外 |
| `upos-tf-all-tx` | 200，~820ms | ✘ 清單外 |
| `upos-sz-mirrorali` | 200，~560ms（暖）／**冷 TLS 6.4s** | ✔ |
| `upos-sz-mirrorcos` | 200，~1000ms | ✔ |
| `upos-sz-mirrorcoso1` | 200，~2000ms | ✘ |
| `upos-sz-upcdnbda2` | 200，~2100ms | ✘ |
| `upos-sz-mirrorcosov` | TLS 僅 103ms，但該路徑回 **403** | ✔ 但被 `ExcludeHostKeywords` 排除 |
| `upos-sz-mirrorbdov` | TCP 通、**TLS 失敗** | ✘ |
| `upos-sz-mirror08c` | **冷 TLS 7.9s** 後失敗 | ✘ |
| `upos-sz-mirrorhw` | **TCP 通但 TLS 永不完成（8.8s）** | ✔（正確判死） |

→ 可推論：**冷 TLS 握手比暖機往返慢一個數量級**（ali 6.4s vs 0.4s）。這是 `PROBE_TIMEOUT_MS`
三次調參都不夠的直接原因，也是這一天最有價值的一個數字。
→ 可推論：海外（`ov`）系列**沒有漏掉任何真正可用的**——`aliov` 在用、`hwov`/`hz-aliov` 是
NXDOMAIN、`bdov` TLS 失敗、`cosov` 見下。
→ **不可推論**：`/crossdomain.xml` 回 200 只證明 host 活著，**不證明它能服務帶簽名的 upos 路徑**。
`cosov` 回 403 也同理不能反證它不行（`aliov` 對 `/favicon.ico` 一樣回 403，卻服務得好好的）。
所以 `alib` / `ali02` / `bos` / `tf-all-tx` 雖然比 `cos` 快 20~40%，**必須通過實驗 4 才能加入清單**——後來確實通過了，已加入。

**實驗 3：DNS 背後的機器數量與變動**

`upos-sz-mirroraliov` CNAME 到 `upos-sz-mirroraliov.bilivideo.com.queniuaa.com`，
**8 個 A 記錄（155.102.184.142~148、173），TTL 僅 3 秒**。`ali` 8 個 IP、
`cos` 7 個 IP 且散落在 218.61 / 101.72 / 58.250 / 60.28 / 58.251 / 60.220 / 36.35 等多個網段。

→ 可推論：`setCdn()` 固定某個 host **不等於**綁死單一台機器，底下仍有 DNS 層負載平衡與故障轉移。
→ 可推論：**這些 host 背後的機器會換**——同一天內 `ali` 的 IP 段就從 `183.214.1.x` 變成
`221.178.37.x`。任何「哪個 IP 快」的結論都不該寫死。

**實驗 4：能否服務帶簽名的 upos 路徑（已完成）**

> 這是唯一能決定「一個 host 該不該進候選池」的實驗。前三次嘗試都因為方法有缺陷而作廢，
> 過程本身比結果更值得記——每一次作廢的原因都是「量測環境被自己汙染了卻沒察覺」。

**方法（最終有效版）**：在播放中的影片頁取 `window.__playinfo__` 裡**第一個 `upos-*` 的
`base_url`／`backup_url`**（不能拿 Akamai 的，簽名參數不同），只置換 hostname，
發 `Range: bytes=0-16383`，判定標準是 **206 + 恰好 16384 bytes**。
兩道自我檢查缺一不可：(1) 先原封不動打一次當**對照組**，拿不到 206 就是簽名過期，中止；
(2) 每一列都用 `performance.getEntriesByName(url)` 回頭核對**真正送出的 URL 的 hostname**，
確認沒有被腳本改寫。

**結果（2026-08-19，台灣）**：對照組 206 / 16384B / 245ms。八個候選**全部 206 + 16384B，
且 `送出` 全部一致**：

| host | ms | 判定 | 先前狀態 |
|---|---|---|---|
| `upos-sz-mirroraliov` | 9 | 可用 ✅ | 白名單 |
| `upos-sz-mirrorcosov` | **24** | **可用 ✅** | **被 `ExcludeHostKeywords` 排除** |
| `upos-sz-mirrorali` | 119 | 可用 ✅ | 白名單 |
| `upos-sz-mirroralib` | 185 | **可用 ✅** | **清單外** |
| `upos-tf-all-tx` | 268 | **可用 ✅** | **清單外** |
| `upos-sz-mirrorbos` | 294 | **可用 ✅** | **清單外** |
| `upos-sz-mirrorcos` | 693 | 可用 ✅ | 白名單 |
| `upos-sz-mirrorali02` | 705 | **可用 ✅** | **清單外** |

→ **決策（部分回退，見實驗 5）**：`alib` / `ali02` / `bos` / `tf-all-tx` 加入 `PREFERRED_CDN_LIST_RAW`（實機零錯誤，保留）。**但 `cosov` 的解除排除隨即被實機推翻並回退**——本實驗只證明它能服務一次 16KB range 請求，不足以推論它能拿來播影片。**候選池從 3 個擴到 7 個。**
這同時讓上一節的 `MIN_USABLE_POOL` 煞車幾乎不會再被觸發——**給選路足夠的選擇空間，
比繼續調懲罰參數更根本**。實測驗證：即使把所有節點都判失敗，仍會保留最快的兩個海外節點。

→ **ms 欄位的效力**：單次取樣、冷熱混雜，**只用來確認「數量級合理」**（跨境節點不該是個位數），
不可拿來排序。排序一律交給腳本自己累積的 EWMA。

**三次作廢的嘗試（保留下來，因為每一次都是可重複踩到的坑）**

1. **直接在 console 用 `fetch()` 打各個 host** → 作廢。腳本包了 `theWindow.fetch`，
   `isMediaSegmentUrl()` 成立時會走 `normalizeMediaUrl()` **把 host 改寫成當下選中的 CDN**，
   所以「三個 host 都回 206」其實可能三次都打到同一台。
2. **改用 `about:blank` iframe 取乾淨的 `fetch`** → 作廢。iframe 的 **`Origin` 是 `null`**，
   upos 的 CORS 政策直接拒絕，**連對照組都 403**。「繞開包裝」和「保持正確 Origin」
   必須同時成立。
3. **改回頁面 fetch，靠 `BiliCDN.exclude('upos')` 讓腳本沒有改寫目標** → 作廢。
   `getCurrentCdn()` 是 `resolvedCdn || getBestCdn()`，而 **`resolvedCdn` 排在最前面、
   完全不受排除關鍵字影響**——頁面早就決定好的節點仍然是有效的改寫目標。
   識破它的線索是**物理上不可能的數字**：`ali02` 解析到中國大陸卻回報 3ms。

> **這四次的通則**：在有攔截層的環境裡做網路實驗，「我以為我在測 A」和「我實際在測 A」
> 是兩件事。**每次都要有(1) 已知答案的對照組，(2) 獨立於受測程式碼的事後驗證管道**
> （這裡是 Resource Timing），(3) 一個物理合理性檢查（跨境延遲不可能是個位數毫秒）。
> 三者缺一，就可能像前三次一樣得到看起來很漂亮、實際上完全錯誤的結論。

**貫穿全部實驗的方法論教訓**

- 量測的前提條件要跟「用它做的判斷」一起檢查：暖機值 vs 冷路徑、有回應 vs 可用、
  傳完了 vs 量到頻寬。三個 bug 同一個根因。
- 用輕量請求代替真實請求之前，先問「我讀得到我要判斷的那個訊號嗎？」——`no-cors` 讀不到
  狀態碼，959（區域拒絕）看起來就跟 200 一樣。
- 在有攔截層的環境裡做網路實驗，先確認**實驗本身沒有被攔截層改寫**，並保留對照組。

**測試環境限制（重要，會影響下一輪怎麼驗）**

- **在 claude-in-chrome / CDP 驅動的分頁裡，bilibili 播放器不會起播**：`video.readyState` 恆為 0、`duration` 為 `null`、`buffered.length` 為 0，畫面全黑顯示 `00:00 / 00:00`。試過 5 支影片、重整、實際點擊給 user gesture 都一樣。**已排除是腳本造成的**——決定性 A/B 是在頁面內跑 `BiliCDN.exclude('upos')`（把整份白名單排掉 ⇒ `activeCdnList` 清空 ⇒ `replaceUrlHost()` 沒有改寫目標 ⇒ 等同停用改寫），再 SPA 換片，症狀完全相同；而且直接 `fetch` playurl 給的 `base_url` / `backup_url` 都回 **206 + 65536 bytes**，節點與簽名都是好的。另外那個環境的 `setTimeout` / XHR 回呼在 eval 之間不會推進，fire-and-forget 式的量測全部拿不到結果。
- 後果：**起播速度、seek 流暢度、緩衝顯示這三類「要真的播得動才能量」的項目，無法用瀏覽器自動化驗證**，只能由使用者在自己的一般 Chrome 視窗操作。同理，「`alib` / `ali02` / `bos` / `tf-all-tx` 能不能服務真實的簽名 m4s」也還沒驗過——`/crossdomain.xml` 回 200 只證明 host 活著，不證明它認得別台簽的 upos 路徑。**在驗過之前不要把它們加進 `PREFERRED_CDN_LIST_RAW`。**

### 附錄 B：開發過程中被推翻或排除的判斷

**設計層面的結論（回答「這是不是最優解」）**

> 程式碼層面：目前每一個已知缺陷都已修正，125 項行為斷言全通過，console 零紅字。
> 但要誠實指出一個**設計與實際選擇空間不匹配**的問題，它不是 bug，改不改是取捨：

本腳本有 **7 套彼此重疊的懲罰機制**——持久死節點（1/7/30 天）、黑名單（24 小時）、
軟隔離（2~10 分鐘）、`cdnFailCount`（2 次即升級黑名單）、`cdnHealth.failures`、
`slowSamples`、Watchdog 換節點斷路器——而且彼此會**升級**（軟隔離累積 → 黑名單；
失敗 2 次 → 黑名單；HARD 狀態碼 → 黑名單 ＋ 死節點）。這套設計預設候選池夠大，
移除一個節點的代價很小。

但台灣環境的實際候選池是 **3 個**（`aliov` / `ali` / `cos`；`cosov` 被排除，
`hwov` / `hz-aliov` 是 NXDOMAIN，`hw` 的 TCP 握不完），而且**極度不對稱**：
curl 實測 TTFB `aliov` ~70ms、`ali` ~560ms、`cos` ~1000ms。也就是說
(1) 任何一次處分就砍掉三分之一的池子，(2) 七套機制疊加使得幾乎總有節點在處分中，
(3) 就算換成功了，第二名也比第一名慢 8 倍——**換節點在這個環境幾乎必然是降級**。

**（此結論隨即被修正，見下一節。）** 當時的建議是「固定最快的節點」
（`BiliCDN.setCdn(...)`），但那是**針對單一台機器實測結果**的結論——這是一份要發布給
其他使用者的腳本，別人的電信商 / 路由 / 是否掛 VPN 都不同，把某個 host 寫死給所有人
是錯的方向。正確的一般解是讓**懲罰力道跟候選池大小成比例**，見下一節。
`setCdn()` 仍然保留為使用者層級的手動選項，但不作為預設建議。

**查證後確認**不是**問題的（一併記錄，免得下次又追一輪）**

- `最低需求 Mbps: 27.17`（使用者在 `diag()` 看到，懷疑是碼率誤判沒修好）——**是正常的暫時值**。`setStreamProfile` 在 playurl 當下先用清單最高畫質（`maxV + maxA`）當初估，之後由 `syncStreamBitrateFromVideo()` 在 Watchdog `tick()` 裡用 `videoEl.videoHeight` 校正成實際播放的畫質；而 `videoHeight` 在影片解出第一張畫面之前是 `0`，此時函式會直接 `return` 維持初估值（刻意的：寧可高估也不要低估到讓 Watchdog 對真正的卡頓變遲鈍）。沙箱重現：清單含 4K(25.4M)+1080p(3.0M)+720p(1.2M) 與音訊 0.5M 時，校正前是 **27.20 Mbps**（與使用者看到的 27.17 幾乎完全相同），餵進 `videoHeight = 1080` 之後降到 **3.68 Mbps**；餵 `videoHeight = 2160` 則維持高門檻，餵 `0` 維持初估值。**判讀方式：要看這個數字對不對，必須在影片「已經播出畫面」之後才執行 `diag()`**，在起播前或暫停於黑畫面時看到 4K 等級的數字是預期行為。

**不是本腳本造成的 console 訊息（一併記錄，省得下次再追一輪）**

- `[Violation] Permissions policy violation: unload is not allowed in this document.`（來源 `video.*.js` 的 `reportPerformance`）——Bilibili 自己的效能回報程式在用已被 Chrome Permissions-Policy 停用的 `unload` 事件。與本腳本無關，也不影響播放。
- `api.bilibili.com/client_info?type=json` 回 **404**——Bilibili 自己的端點，本腳本不攔截也不改寫 `client_info`（`isPlayUrlApi()` 只匹配 `/player/*playurl`）。與本腳本無關。

### 附錄 C：資訊來源與可信度

**資訊來源與可信度**

`og` / `os` / `/v1/resource` 等 Bilibili CDN 內部行為**沒有任何官方文件**，本版依據的是社群逆向工程整理（linux.do 技術貼、ReVanced 漫游模組原始碼、Bilibili-Evolved issue 討論）。CDN 分類共四型：Mirror（商業 CDN，最好）、UPOS/estg（物件儲存，冷門片常見，要回源）、BCache（自建機房，品質因地區而異）、MCDN/PCDN（最差）。邏輯上合理且與實際症狀吻合，但**非官方或學術來源**；反方說法也存在，有海外使用者回報「換成國內節點反而更順」，代表節點好壞的地區差異極大。**任何時候你自己實測的數據都優先於任何清單。**


## v1.3.1

> 依《BiliCDN_TW_改進工單》執行 A、B（P0）、C（安全半套）、E、F。D（時段感知 CDN
> 健康度）因為要改動即時播放中決定換節點的核心評分邏輯（~15 處呼叫點），且此環境
> 無法用真實 bilibili 流量驗證，先跳過。工單裡原本規劃的 G（儲存層抽象）/ H
> （declarativeNetRequest 兜底）是為了「將來出 Chrome/Edge 擴充套件版」鋪路——
> 確認不做擴充套件版，維持單純 Tampermonkey userscript，G/H 都不採用（G 開發過程中
> 曾短暫實作過 `Store.get/set/del` 這層，確認方向後隨即移除，未曾對外發布）。

- 修正：UI 注入的自我修復機制（`statusTimer`）宣告在 `buildUI` 內部，若第一次 `waitForElm` 等待設定面板錨點就逾時（網路慢、番劇頁載入久），`buildUI` 從未執行過，`statusTimer` 也就從未誕生，狀態面板會永遠不出現，且預設不開 verbose 的使用者完全看不到任何錯誤。改成在檔案結尾新增一顆獨立的常駐看門狗 `ensureUiPresent`（每 1.5 秒檢查一次），不受初次逾時影響持續重試找錨點建面板；原本 `buildUI` 內的 `statusTimer` 專心負責「面板健在時的內容刷新」與「偵測到新面板出現時自我了斷」，兩套機制不會重複建面板。
- 新增：Worker 攔截有效性量測（`BiliCDN.workerStats()`）。`setupClassicWorkerIntercept()` 這 250 行是全檔最複雜脆弱的部分，且不確定播放器是否真的用 Worker 抓影片分段。埋入 `created`（攔到幾次 `new Worker`）→ `netCalls`（Worker 內發出幾次網路請求）→ `mediaSeen`（其中幾次是影片分段）→ `rewrites`（實際改寫幾次）四個分層指標，持久化在本機（`GM_setValue`，5 秒 debounce + `pagehide` 時強制 flush），`BiliCDN.diag()` 一併顯示已觀察天數與判讀建議。所有計數只存在使用者本機，腳本不會自動上傳任何資料，回報完全靠使用者手動複製貼上——用真實數據決定這段程式碼未來的去留。
- 新增：`EnableWorkerIntercept` 安全開關。`setupClassicWorkerIntercept()` 那 250 行程式碼保留不刪，只是開頭加了 `if (!EnableWorkerIntercept) return`；預設 `true`，行為不變。真正決定要不要整段刪除，要等 `BiliCDN.workerStats()` 收集到足夠真實數據後再做。
- 重構：抽出 `pickStreamUrls` 純函式。原本內嵌在 `transformStreamItem` 裡判斷 dash/durl item 該用哪個候選網址的邏輯——也是 Bilibili 改版最容易壞的地方——切成不含副作用的純函式，行為完全不變，方便日後單獨檢查/除錯。
- 新增：`BiliCDN.report()` 診斷報告一鍵複製。狀態面板加「複製診斷」按鈕，組出版本、`uiInjectStatus`、白名單、黑名單、死節點、改寫統計、HTTPDNS 狀態、Worker 量測、瀏覽器 UA、頁面型態（不含 BV/ep 號）的純文字，`navigator.clipboard` 失敗時（非 HTTPS 或無使用者互動）退回印在 console。刻意不含完整影片網址、cookie、IP 等可識別使用者的資訊。

**已知未處理項目**（原稽核文件《BiliCDN_TW_改進工單.md》已刪除，技術細節留存於此供未來評估）

- **時段感知的 CDN 健康度**：目前 `cdnHealth`（`cdnHealth_v1` key，`CDN_HEALTH_TTL` 6 小時）只認 host，不分時段，但台灣連中國 CDN 的擁塞高度時段性（晚間尖峰 vs 凌晨差很多）。規劃方案：key 從 `host` 改為 `host|bucket`（bucket = 平日/假日 × 早/午/晚/深夜，共 8 桶），各桶各自維持 EWMA，選節點時讀當下 bucket、樣本數不足時回退跨桶平均（沿用既有 `JITTER_PRIOR_WEIGHT` 先驗機制），升級儲存 key 為 `cdnHealth_v2` 並寫一次性遷移（讀到舊 v1 資料就平均攤到所有桶當初始先驗，之後刪掉舊 key）。**沒做的原因**：會動到 `getBestCdn`/`getCdnHealthScore`/Watchdog 節點比較等即時播放路由決策的 ~15 處呼叫點，分桶會讓每桶樣本數變成原本的 1/8，先驗權重需要重新調校，這個環境沒有能力對 bilibili.com 做真實播放測試驗證調校是否正確，只能靠使用者自己拿真實用量測試一段時間才敢動。
- **（替代/補充方案）網路環境感知的 CDN 健康度**：2026-08-17 重新審視選路架構時發現，`HttpDnsAutoPilot` 已經有一套「網路環境指紋」`getNetworkKey()`（時區 + 語言 + `navigator.connection` 的 `effectiveType` + `downlink`）用來記住「這個網路環境該不該擋 HTTPDNS」，但決定選哪個 CDN 的 `cdnHealth` 完全沒用到同一招，純粹用 host 當 key。换 WiFi/用 VPN 對 CDN 路由現實的影響，理論上比單純時段更直接、更有因果關係，可以考慮把 `cdnHealth` 的 key 也比照 `getNetworkKey()` 分維度，當作上面「時段感知」方案的替代或補充。**風險與時段方案完全相同**（同一組即時路由呼叫點、需要真實流量驗證調校），一併留到之後真的要動這塊時再評估，不是現在就要做的待辦。

## v1.3.0

> 本版全面對照 v1.2.4 逐項稽核結果（3 項 P0、7 項 P1、9 項 P2、10 項 P3，共 29 項）落地修正，共處理 27/29 項。以下依主題分類。

**CDN 選路核心邏輯**

- 修正：Bilibili playurl 網址簽名（`deadline`/`upsig`）過期時，播放器會對所有 `backup_url` 重試，短時間內多個不同節點各拿一次 403——這不是節點壞掉，是「門票」全體失效。舊版把每個 403 都當硬失敗標死 7 天，等於在簽名過期的瞬間把所有候選節點一次封光。現在 15 秒內偵測到 ≥2 個不同 host 都 403 會判定為簽名過期、不處罰任何節點；只有單一 host 403 才軟隔離觀察 10 分鐘（不直接標死）。
- 修正：節點評分（UCB 選路演算法）的分數尺度沒有正規化——吞吐量用原始 Mbps（可能到 100+），探索加成固定在 2.5 左右，導致節點越快、探索力道越弱，節點越慢、探索反而越強，跟演算法設計的初衷相反。改為把吞吐量正規化到 0~1（2 倍需求速度視為滿分），懲罰項換算到同一級距。
- 修正：折扣式 UCB 只把吞吐量樣本的「分數」隨時間衰減，沒有同步衰減「樣本數」，導致久沒測過的好節點因為 samples 仍是舊的大數字，探索加成低，永遠不會被重新測試，即使它現在其實最快。改為樣本數也用同一個半衰期（8 分鐘）衰減，讓久未使用的節點自然回到探索池。
- 修正：`forcedRedirectHosts`（賽馬中途切換 / fragment 下載失敗後強制改寫的主機清單）只增不減，只有換片才清空——長片裡一次偶發網路抖動就會讓某節點整部片被永久放逐。改成有 10 分鐘時效的 Map，跟 `softBlockCdn` 的機制一致。
- 修正：`getRequiredStreamMbps` 統一用「下載到碼率的 75%」當門檻，這在起播/緩衝充足時合理，但在穩態播放（緩衝已打平）時長期低於碼率必定慢慢吃完緩衝，門檻理應更接近 100%。加入 `mode` 參數區分 `startup`（75%，可容忍暫時性不足）與 `steady`（105%，跟真實碼率一致），各呼叫點按情境套用正確模式。
- 優化：賽馬中途切換的門檻從固定的 1.25 倍改成依候選節點樣本數動態調整（樣本 ≥4 時 1.15 倍即可切、只有 1 個樣本時要快 60% 才切），避免單次 384KB 探測剛好撞上 slow-start 或網路瞬間空檔就誤觸切換。
- 優化：首次安裝時預設判定「台灣不可用」的節點（`hwov`/`hw`/`hz-aliov`）不再直接標死 7 天，改成起跑墊底（仍在探索池內，會被實測一次），避免不同 ISP/VPN 路由差異下誤殺實際上最快的節點。
- 修正：`reorderCdnsByLatency` 與賽馬測速都會整批清空重寫 `activeCdnList`，兩者若同時觸發（例如卡頓瞬間）可能出現「瞬間沒有任何節點」的空窗。加上重入防呆旗標，並讓兩者互斥執行。

**緩衝量測 / 吞吐量準確度**

- 修正：量測「下載耗時」的方式在 XHR segment、fetch segment、賽馬 probe、`PerformanceResourceTiming` 四個地方定義不一致，有的含 TCP/TLS 握手與排隊時間、有的不含，跨國連線的握手可能佔 200~400ms，混在同一個 EWMA 裡等於在比較不同量綱的數字，會讓賽馬測到的速度系統性高於播放時測到的速度，誘發不必要的中途切換與抖動。統一改成優先使用「純傳輸時間」（扣除 TTFB），只有樣本不足以判斷起點時才退回含 TTFB 的完整耗時，避免除以接近 0 的時間差撐出天文數字的假 Mbps 污染 EWMA。
- 修正：Worker 內的 fetch/XHR 攔截，先前是收到 response header 就把 `content-length` 整包入帳，或等整包下完才報一次，導致主執行緒的 Watchdog 看到「好幾秒 0 位元組、突然一大包」的假停滯而誤判卡頓換節點。改成跟主執行緒一致：fetch 用 `tee()` 逐 chunk 節流回報，XHR 改用 `progress` 事件累計回報。
- 修正：只要影片被 Bilibili 分到 Akamai 節點，緩衝面板的下載進度就整支片子動不了（永遠 0%），即使播放完全正常——因為量測攔截層過去只認「已經被標記為 forced-redirect」的 Akamai host 才算媒體片段。放寬判斷邏輯讓 Akamai 的 `.m4s`/`.flv`/`upgcxcode` 一律計入量測（不影響原本的改寫邏輯，只是讓「量測」對它也生效）。
- 修正：XHR 若以 `responseType: 'blob'` 取得 segment，且伺服器沒送 `content-length`，位元組量測會直接失敗、既不計入緩衝面板也不計入 CDN 吞吐評分（承接自 v1.2.4 遺留問題的延伸修正）。
- 優化：Watchdog 的即時下載速度（bps）過去用固定 1 秒當分母，`setInterval` 實際間隔漂移（主執行緒忙碌、背景節流）時會被高估最多 3 倍，導致該判定「太慢」時漏判。改用實際經過時間當分母。

**HTTPDNS AutoPilot**

- 修正：評分公式把 MiB/s 誤標成變數名 `mbps`（實際少算了 8 倍），且用絕對速度（`mbps*100`）打分——正常 4K 播放輕鬆到 300~500 分，卡頓只扣 50 分等於總分的 10~15%，代價太便宜，且判斷通過的門檻 `HTTPDNS_SCORE_MARGIN=8` 對上這個級距形同虛設，任何雜訊都能跨過。改成相對於「這支片子實際需要的速度」計算達成率（封頂 120%），卡頓/硬失敗/切換的懲罰佔比重新配平，門檻同步調整到有實際意義的比例。
- 修正：SPA 換片時 `Watchdog.reset()` 會把累計位元組歸零，若 HTTPDNS 正在跑 trial（短期試放行觀察），下一次結算會拿「換片前的大 baseline」對「換片後才剛開始累計的小 sample」相減，變成負數被夾成 0，trial 幾乎必然被判定失敗、進而被誤鎖定「阻擋 HTTPDNS」6 小時。換片時偵測到 baseline 異常就直接用新片的 sample 原值，並重新起算觀察窗，讓新片有完整的試用時間。
- 清理：移除名存實亡的 `session`/`beginSession`/`noteBytes`/`noteStall`/`noteSwitch`/`noteHardFail`/`finalizeSession` 機制（約 40 行死碼，`noteBytes` 尤其在每個下載 chunk 都會被呼叫一次），直接用 Watchdog 的累計值記分。
- 修正：`Watchdog.noteHardFail()` 過去沒有任何地方會被呼叫，導致 HTTPDNS 評分公式裡的「硬失敗次數」懲罰項形同虛設，現在正確串接到 `recordCdnFailure` 的硬失敗分支。

**畫質 / 硬體解碼**

- 優化：`PreferredVideoCodec = 'hevc'` 過去只檢查瀏覽器「能不能播」HEVC/AV1，不檢查「播得順不順」——很多 Windows 機器沒有 HEVC 硬體解碼，4K HEVC 軟解會讓 CPU 吃滿掉幀，體感比直接看 AVC 還差。改用 Media Capabilities API 偵測是否硬體解碼（`powerEfficient`），軟解時 HEVC/AV1 自動降到 AVC 之後；偵測不到結果時樂觀維持原排序，不影響冷啟動起播速度。

**多分頁協調 / 測速機制健壯性**

- 修正：多分頁互斥過去只靠 BroadcastChannel 心跳判斷「其他分頁是否在測速」，兩個分頁幾乎同時決定要測速時，心跳訊息還沒送達對方就都已經開始了，不是真正的互斥。改用 Web Locks API 做同源真互斥鎖（分頁關閉時瀏覽器自動釋放），沒有 Web Locks 的環境退回原本的心跳機制。
- 修正：測速（賽馬 `probeCdnThroughput` 與可達性檢測 `confirmHostReachable`）過去直接用頁面的 `fetch()`，但 Tampermonkey sandbox 模式下 `window.fetch` 會轉發到被腳本自己改寫過的 `unsafeWindow.fetch`——測速請求可能被自己的攔截層改到別的節點，量出來的速度記錯到別的 CDN 頭上。現在測速改走保留下來的原生 `fetch` 參考（`rawFetch`），不受自身攔截層影響。
- 修正：測速請求的 `referrerPolicy` 過去是 `no-referrer`，可能跟 Bilibili CDN 的防盜鏈 Referer 檢查不一致而直接被拒（403），導致賽馬永遠沒有結果卻完全沒有任何訊息。改成與頁面預設策略一致的 `strict-origin-when-cross-origin`，並新增「連續 3 輪測速全部失敗」的示警，方便使用者察覺並回報。
- 修正：Worker 被包成 blob 載入後，`self.location` 會變成 `blob:https://...`，任何相對路徑（`./x.js`、`/api/y`）若拿 blob URL 當基準解析就會壞掉。改成先統一絕對化再判斷/改寫。同時把 module worker 載入失敗的錯誤從完全吞掉改成印出來，並把 blob URL 撤銷延遲從 30 秒延長到 5 分鐘，避免 Worker 罕見情況下需要重新讀取自己 script URL 時失敗。

**設定面板 / 易用性**

- 修正：Bilibili 換片是 SPA 導航，播放器常把設定面板整個重建，先前注入的 CDN 狀態面板只會注入一次，掉了就再也回不來，只能重整頁面。改成偵測到面板消失時自動就地重建。
- 新增：Tampermonkey 選單指令（重置學習狀態、顯示診斷資訊、立即測速選節點、切換詳細記錄、HTTPDNS 狀態），不用再開 DevTools console 才能操作。
- 新增：`BlockWebRTC` 設定開關（預設 `true`，維持原本擋 WebRTC/PCDN 的行為），需要放行的使用者現在可以自行關閉，不用改程式碼。

**版本管理 / 內部清理**

- 修正：版本號過去散落在 `@version`、`PluginName`、升級判斷、`GM_setValue` 四處，改版容易漏改。現在以 Tampermonkey 注入的 `GM_info.script.version` 為單一事實來源，並用語意化版本比較取代舊有的硬編碼版本白名單（原本混了 `4.4.6`~`4.7.0` 等跟本專案版本序列對不上的殘留字串）。
- 清理：`GM_setValue(key, null)` 的用法全面改用語意更明確的 `GM_deleteValue`（新增 `@grant GM_deleteValue`）。
- 清理：移除數個只寫不讀的死碼（`peerTabs`、`_redirectLogTs` 計數、未使用的 `totalMbps` 變數、只寫不讀的 `lastSeekAt`）。
- 優化：`sanitizePlayInfoUrls` 對 playurl 回應的每個字串欄位都呼叫 `new URL()` 才能判斷是否為 Bilibili 影片網址，4K 多畫質/多 backup 時欄位可能有幾百個。加上長度與 `.bilivideo.` 子字串的便宜前置篩選，不改變判斷結果，只避免不必要的 `new URL()` 呼叫。
- 優化：`Watchdog.getVideo()` 過去在每個 segment 下載完成時都重新 `querySelectorAll('video')` 掃描全文件，改成快取目前使用中的 video 元素，只有它被拔掉（換片重建播放器）才重新掃描；同時讓 `ratechange` 事件即時同步播放倍速，取代原本靠下一次 tick 才更新的做法。
- 優化：`console.warn`/`console.error` 攔截（用來偵測 fragment 下載失敗）過去對每一則 log 都先做一次 `JSON.stringify` 才做正規表示式篩選，4K 下 console 很吵時成本不低。改成先用字串/物件淺層欄位做便宜篩選，只有確定命中才做貴的 `JSON.stringify` 補撈細節。
- 優化：CDN 延遲探測（`probeCdnLatency`）結果快取時間從 6 小時縮短為 2 小時，網路環境變動後不會卡太久。

**已知未處理項目**（這次先保留原行為，供下一版評估）

- Watchdog 判定卡頓、觸發 `switchCdn()` 換節點的當下，仍會同時做「強制重建 preconnect」「立即對所有候選節點發延遲探測」「（4K 時）跑一輪賽馬」三件事，理論上會在最需要省頻寬的時刻反而多搶一手頻寬。稽核清單已有具體修正方案（只 warm 新目標、不拆現用節點的連線、延遲探測延後 10 秒），但屬於行為調整、需要實機驗證才敢動，這次先不動。

## v1.2.4

**設定面板 / 相容性**

- 修正：`bangumi/play/*`（番劇）播放器齒輪選單完全看不到「攔截修改影片CDN」選項。原因是設定面板注入用了鎖死中間包裝層數的完整 CSS 選擇器路徑，番劇播放器（OGV）與一般影片播放器（UGC）的 wrapper 層數不同，導致選擇器找不到節點、`waitForElm` 逾時，且預設不輸出 log，使用者完全看不到任何錯誤。改為只認 class 名稱（`.bpx-player-ctrl-setting-others`），不再綁定包裝層數。
- 修正：使用者在播放器設定裡取消勾選「攔截修改影片CDN」停用腳本後，若播放器已把片段請求丟進 Worker（部分畫質/瀏覽器情境），該 Worker 內建立的 CDN 改寫邏輯沒有收到停用通知，仍會持續改寫影片片段的 CDN host。現在停用/啟用時會同步廣播給所有已建立的 Worker。
- 修正：`/x/v2/subtitle/web/view` 的 Accept header 修正邏輯，在腳本已停用時仍會被套用，與其餘攔截邏輯的停用判斷不一致。
- 修正：SPA 換片（同頁切下一集/下一部影片）後，如果播放器換掉了 `<video>` 元素，拖曳時間軸的預熱（seek prewarm）監聽器不會重新綁定，導致換片後的拖曳體驗回到未優化前的狀態。

**緩衝量測 / Watchdog 準確度**

- 修正：XHR／`fetch()` 攔截層之前完全依賴 `PerformanceResourceTiming` 的 `transferSize`/`encodedBodySize` 判斷 segment 下載量，但 bilivideo.com 的 m4s/flv 走跨源 Range/206 請求時，Chrome 在這個情境下經常回報 0（即使伺服器有送 `Timing-Allow-Origin`），導致面板永遠「緩衝 0%」、bps 判斷對 4K 半盲、CDN 吞吐評分永遠沒有真實樣本。改為：
  - XHR 用 `content-length` / response 大小量測真實位元組，並用 `progress` 事件逐步回報下載中的即時進度。
  - `fetch()` 一律用 `ReadableStream.tee()` 分流：一份原封不動交給播放器，另一份逐 chunk 即時回報真實下載節奏，最後用真正的下載完成時間換算吞吐分數（不能只看 `content-length` 就當作已下載完——`fetch()` 的 Promise 在收到 header 就 resolve，body 這時候通常還在傳，直接整包入帳會讓吞吐評分嚴重灌水、也會讓 Watchdog 誤判「這秒突然滿血、之後好幾秒卻 0 位元組」的假停滯）。
  - `PerformanceResourceTiming` 只在以上路徑都量不到時當最後備援；去重標記改成邊下載邊持續刷新（而非下載完才標一次），避免大檔案下載期間 entry 提早送達、或下載耗時超過去重視窗，造成同一包位元組被算兩次。
- 修正：XHR 若以 `responseType: 'blob'` 取得 segment、且伺服器沒有暴露 `content-length`，位元組量測會完全失敗（沒有檢查 Blob 的 `.size`），導致該次請求既不計入緩衝面板也不計入 CDN 吞吐評分。

**其他穩健性**

- 修正：SPA 換片時若播放器實際上重用同一個 `<video>` 元素（只換 `src`，未整個替換節點），拖曳時間軸的預熱監聽器會被重複掛在同一個節點上，換片次數一多，單次拖曳會觸發等量倍數的重複回呼。現在每個 `<video>` 元素只會綁定一次。
- 修正：設定面板的注入位置（`.bpx-player-ctrl-setting-others`）在頁面同時存在多個播放器實例時（例如浮動小視窗），只用 class 找可能命中 DOM 順序上第一個、不一定是正在播放的主播放器。現在有多個候選時會挑「旁邊 `<video>` 面積最大」的那個。

**換片起播（4K／小時級長片／無損音軌等重內容）加載變慢**

- 修正：SPA 換片時沒有清掉舊片留下的吞吐量賽馬排程／執行狀態（`bakeoffTimer`/`bakeoffRunning`）。若切片剛好卡在舊片的賽馬排程（最長延遲 4 秒）或執行中（最多 4 顆候選 ×3 秒 timeout，合計可達 12 秒），新片會完全搶不到賽馬名額，只能沿用舊片留下的健康分數起步，加載明顯變慢。改為換片時遞增一個 epoch 版本號並用 `AbortController` 立刻中止舊片還在跑的探測，讓新片的賽馬能盡快排進去。
- 修正：Watchdog 在剛開播/換片後沒有任何緩衝期，TCP/TLS 連線還在 slow-start、瞬時速度天生偏低時就可能被誤判成「CDN 太慢」而觸發換節點——換節點本身要重新 DNS/TCP/TLS，反而更慢。新增開播/換片後的短暫緩衝期（一般 3 秒、高碼率 5 秒）不做停滯判定。
- 優化：新增「現用節點剛好有新鮮的真實吞吐樣本、且遠高於這支片子實際需要的速度」時跳過賽馬的判斷，避免換片起播最搶頻寬的當下，賽馬探測（連續打 1~4 顆候選）又跟正在起播的緩衝搶頻寬。只套用在「換片/換畫質起播」這個情境，Watchdog 判定真的卡頓、fragment 下載失敗、週期性重評估（每 4 分鐘）、手動觸發 `BiliCDN.bakeoff()` 這幾種「已經出事」或「使用者主動要求」的情境都不受影響，維持原本的即時反應。

## v1.2.3

- 修正：`/x/v2/dm/web/view` 是 Protobuf 二進位回應（高能進度條開關等資訊即在此包內），先前版本會強制把它的 Accept header 改成 JSON，造成播放器解析失敗、高能進度條消失。改為只對真正的 JSON 端點（`/x/v2/subtitle/web/view`）套用這個修正。
- 補上 `@downloadURL` / `@updateURL`，讓 Tampermonkey / Violentmonkey 能正確偵測並提示更新。**先前版本（v1.2.2 以前）沒有這兩個欄位，代表已安裝的舊版無法自動更新到本版，需要手動重新安裝一次才能之後持續收到更新。**

## v1.2.2

- 回滾至 v1.2.0 的穩定選節點邏輯。

## v1.2.1（已下架，請勿使用）

- 對外發布後實測不穩定：可能出現 403、CORS、4K 無畫面、cosov 節點 HTTP/2 錯誤等問題。

## v1.2.0 及更早

- 初始版本與基礎功能：CDN 白名單、黑名單、死節點記憶、HTTPDNS 判斷、Watchdog 卡頓偵測與自動換源、多分頁協調測速。
