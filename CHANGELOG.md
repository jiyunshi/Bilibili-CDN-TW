# Changelog

## v1.3.2

> 依《BiliCDN_TW_改進工單》繼續執行 C（安全半套）、E、F。D（時段感知 CDN 健康度）
> 因為要改動即時播放中決定換節點的核心評分邏輯（~15 處呼叫點），且此環境無法用
> 真實 bilibili 流量驗證，先跳過。工單裡原本規劃的 G（儲存層抽象）/ H
> （declarativeNetRequest 兜底）是為了「將來出 Chrome/Edge 擴充套件版」鋪路——
> 確認不做擴充套件版，維持單純 Tampermonkey userscript，G/H 都不採用（G 曾經短暫
> 實作過 `Store.get/set/del` 這層又移除，見下方說明）。

- 新增：`EnableWorkerIntercept` 安全開關（工單 C 的 v1.3.2 半套）。`setupClassicWorkerIntercept()` 那 250 行程式碼保留不刪，只是開頭加了 `if (!EnableWorkerIntercept) return`；預設 `true`，行為不變。真正決定要不要整段刪除，要等 `BiliCDN.workerStats()`（v1.3.1 新增）收集到足夠真實數據後再做。
- 新增：抽出 `pickStreamUrls` 純函式（工單 E）。原本內嵌在 `transformStreamItem` 裡判斷 dash/durl item 該用哪個候選網址的邏輯——也是 Bilibili 改版最容易壞的地方——切成不含副作用的純函式，並用 `vitest` 建立單元測試（`test/pure.test.js`，20 案例），涵蓋 `isPlayUrlApi`、`isValidCustomCdnHost`（含 `bilivideo.com.evil.com` 偽裝子網域的資安案例）、`matchesExclude`、`verGte`、`pickStreamUrls` 的 dash/durl 兩種格式。測試直接從出貨用的 `.user.js` 原始碼抽取比對，不是另外維護一份複製，避免測試跟正式程式碼漂移。
- 新增：`BiliCDN.report()` 診斷報告一鍵複製（工單 F）。狀態面板加「複製診斷」按鈕，組出版本、`uiInjectStatus`、白名單、黑名單、死節點、改寫統計、HTTPDNS 狀態、Worker 量測、瀏覽器 UA、頁面型態（不含 BV/ep 號）的純文字，`navigator.clipboard` 失敗時（非 HTTPS 或無使用者互動）退回印在 console。刻意不含完整影片網址、cookie、IP 等可識別使用者的資訊。
- 撤回：曾短暫加入 `Store.get/set/del` 儲存層抽象（工單 G）把全檔 GM_* 呼叫改走這層，唯一目的是為未來擴充套件版鋪路。確認不做擴充套件版後，這層抽象沒有意義只留下多一層間接呼叫，已改回直接呼叫 `GM_getValue`/`GM_setValue`/`GM_deleteValue`，行為與改動前完全一致。

## v1.3.1

> 依《BiliCDN_TW_改進工單》執行 P0 兩項（A、B）。

- 修正：UI 注入的自我修復機制（`statusTimer`）宣告在 `buildUI` 內部，若第一次 `waitForElm` 等待設定面板錨點就逾時（網路慢、番劇頁載入久），`buildUI` 從未執行過，`statusTimer` 也就從未誕生，狀態面板會永遠不出現，且預設不開 verbose 的使用者完全看不到任何錯誤。改成在檔案結尾新增一顆獨立的常駐看門狗 `ensureUiPresent`（每 1.5 秒檢查一次），不受初次逾時影響持續重試找錨點建面板；原本 `buildUI` 內的 `statusTimer` 專心負責「面板健在時的內容刷新」與「偵測到新面板出現時自我了斷」，兩套機制不會重複建面板。
- 新增：Worker 攔截有效性量測（`BiliCDN.workerStats()`）。`setupClassicWorkerIntercept()` 這 250 行是全檔最複雜脆弱的部分，且不確定播放器是否真的用 Worker 抓影片分段。埋入 `created`（攔到幾次 `new Worker`）→ `netCalls`（Worker 內發出幾次網路請求）→ `mediaSeen`（其中幾次是影片分段）→ `rewrites`（實際改寫幾次）四個分層指標，持久化在本機（`GM_setValue`，5 秒 debounce + `pagehide` 時強制 flush），`BiliCDN.diag()` 一併顯示已觀察天數與判讀建議。所有計數只存在使用者本機，腳本不會自動上傳任何資料，回報完全靠使用者手動複製貼上——用真實數據決定這段程式碼未來的去留（工單 C）。

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
