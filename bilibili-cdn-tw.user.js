// ==UserScript==
// @name         Bilibili CDN 台灣優化
// @namespace    BiliCDN_TW
// @version      1.3.4
// @description  改善台灣網路觀看 Bilibili 影片時的 CDN 連線穩定度，支援自動切換與卡頓監測
// @author       jiyunshi <chocosensei214@gmail.com>
// @license      MIT
// @icon         https://i0.hdslb.com/bfs/static/jinkela/long/images/512.png
// @run-at       document-start
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/festival/*
// @match        https://www.bilibili.com/medialist/play/*
// @match        https://www.bilibili.com/watchlater/*
// @match        https://www.bilibili.com/blackboard/*
// @match        https://www.bilibili.com/mooc/*
// @match        https://www.bilibili.com/cheese/*
// @match        https://www.bilibili.com/v/*
// @match        https://www.bilibili.com/documentary/*
// @match        https://www.bilibili.com/variety/*
// @match        https://www.bilibili.com/tv/*
// @match        https://www.bilibili.com/guochuang/*
// @match        https://www.bilibili.com/movie/*
// @match        https://www.bilibili.com/anime/*
// @match        https://www.bilibili.com/match/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @grant        unsafeWindow
// @downloadURL https://update.greasyfork.org/scripts/579776/Bilibili%20CDN%20%E5%8F%B0%E7%81%A3%E5%84%AA%E5%8C%96.user.js
// @updateURL https://update.greasyfork.org/scripts/579776/Bilibili%20CDN%20%E5%8F%B0%E7%81%A3%E5%84%AA%E5%8C%96.meta.js
// ==/UserScript==

// ── 使用者設定 ────────────────────────────────────────────────────────
// 一般使用者不需要修改；安裝後重整 Bilibili 影片頁即可使用。
// CustomCDN：留空 = 自動輪換；填 host = 固定該 CDN；填 'null' = 清除 GM 設定
var CustomCDN = ''

// ExcludeHostKeywords：host 名稱含這些子字串就不會被選用/probe/重導向
// 例：['cosov']、['cos']（含 cosov）、['ov.bilivideo']（不建議，海外節點全排）
// 動態調整：BiliCDN.exclude("kw") / .include("kw")
//
// 2026-08-20：cosov 維持排除。中間一度以「一次 16KB range 請求回 206」為由解除，
// 隨即被實機推翻——**單次小範圍請求不等於持續播放**。實際開影片時 cosov 會：
//   (1) 對 PROBE_PATH（/crossdomain.xml）**必定**回 403 → 每輪探測固定產生一行紅字；
//   (2) 對真實 m4s 回 `ERR_FAILED 514` 且**不帶 Access-Control-Allow-Origin**，
//       瀏覽器直接報 CORS 錯誤（實測 URL 上是 os=cosovbv、bw=22M 的 4K/HDR 串流）。
// 同一批 log 裡另外四個新增鏡像（alib / ali02 / bos / tf-all-tx）零錯誤，所以問題確實
// 只在 cosov。詳見 CHANGELOG 實驗記錄實驗 4 與實驗 5。
var ExcludeHostKeywords = ['cosov']

// BlockHttpDNS：true = 永遠阻擋；false = 永遠放行；'auto' = 短測 + 評分 + 記憶網路環境
var BlockHttpDNS = 'auto'

// PreferredVideoCodec：'hevc' = 4K 優先 HEVC（省頻寬），但只在瀏覽器回報硬體解碼
// （Media Capabilities API 的 powerEfficient）時才優先，判斷不到就維持樂觀優先 HEVC；
// 'avc' = 最保守，不管硬解與否一律優先 AVC；'auto' = 保留原順序。
// AV1 只有在瀏覽器明確支援該 representation 時才保留，避免 UI 選 AV1 但播放器實際 fallback 成 AVC。
var PreferredVideoCodec = 'hevc'

// BlockWebRTC：true = 阻擋 WebRTC（擋 Bilibili PCDN/P2P 傳輸，跨國連線建議開）；
// false = 放行（頁面其他功能，或其他擴充功能，若也用到 WebRTC 才需要關）
var BlockWebRTC = true

// EnableWorkerIntercept：是否攔截 new Worker() 並改寫其內部 segment 請求的 CDN host。
// 改進工單 B 已埋入 BiliCDN.workerStats() 量測這段攔截是否真的有效（Bilibili 播放器
// 是否真的用 Worker 抓影片分段目前不確定）；觀察數週、確認 mediaSeen 長期為 0 後，
// 可以把這個值改成 false 停用（不用等緊急發版）——設定面板「攔截修改影片 CDN」
// checkbox 停用的是「改寫」，這個開關停用的是整段攔截機制本身，範圍更大。
// 預設 true：維持目前行為不變，真正決定要不要拿掉這 250 行程式碼要等 B 的數據出來。
var EnableWorkerIntercept = true

// ── 版本號 ────────────────────────────────────────────────────────────
// 單一事實來源：優先讀 Tampermonkey 注入的 GM_info（跟著 @version 走，改版不用四處手動同步）。
const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.3.4'
const parseVer = (v) => String(v || '0').split('.').map(n => parseInt(n, 10) || 0)
const verGte = (a, b) => {
    const A = parseVer(a), B = parseVer(b)
    for (let i = 0; i < 3; i++) { if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) > (B[i] || 0) }
    return true
}

// ── 診斷輸出 ──────────────────────────────────────────────────────────
// 預設不輸出背景 log；需要排查時可在 console 執行 BiliCDN.verbose(true)。
const PluginName = 'BiliCDN_TW_v' + VERSION
const Config = { verbose: !!GM_getValue('verbose') }
const log = (...args) => { if (Config.verbose) console.log('[' + PluginName + ']:', ...args) }
const err = (...args) => { if (Config.verbose) console.error('[' + PluginName + ']:', ...args) }

let disabled = !!GM_getValue('disabled')

// 面板注入狀態：預設不輸出 log（Config.verbose 只有排查時才開），如果 Bilibili
// 改版導致 .bpx-player-ctrl-setting-others 選擇器失效，使用者不會看到任何錯誤，
// 只會覺得「面板消失了」卻無從查起。CDN 改寫核心不依賴這個選擇器，會照常運作，
// 但至少讓 BiliCDN.diag() 能一眼看出「是選擇器找不到面板，還是真的沒問題」。
let uiInjectStatus = 'pending'   // 'pending' | 'ok' | 'timeout'

// ── 台灣常見不可用節點 ────────────────────────────────────────────────
// 這些節點在台灣常見 DNS 失敗或區域拒絕，預設先避開以減少無效連線。
const INITIAL_DEAD_HOSTS_TW = [
    'upos-sz-mirrorhwov.bilivideo.com',   // 台灣 DNS 普遍屏蔽
    'upos-sz-mirrorhw.bilivideo.com',     // 台灣 IP 區域拒絕 (HTTP 959)
    'upos-hz-mirroraliov.bilivideo.com',  // 杭州內網域名，台灣 DNS 不解析
]

// ── playurl API 前綴 ──────────────────────────────────────────────────
const PLAYURL_PREFIXES = [
    'https://api.bilibili.com/x/player/wbi/playurl',
    'https://api.bilibili.com/pgc/player/web/v2/playurl',
    'https://api.bilibili.com/x/player/playurl',
    'https://api.bilibili.com/pgc/player/web/playurl',
    'https://api.bilibili.com/pugv/player/web/playurl',
    'https://api.bilibili.com/pugv/player/web/v2/playurl',
    'https://api.bilibili.com/x/player/ugc/playurl',
    'https://api.bilibili.com/x/player/wbi/ugc/playurl',
    'https://api.bilibili.com/x/player/season/playurl',
    'https://api.bilibili.com/x/player/wbi/season/playurl',
]
const isPlayUrlApi = (url) => {
    if (!url) return false
    if (PLAYURL_PREFIXES.some(p => url.startsWith(p))) return true
    try {
        const u = new URL(url)
        return u.hostname === 'api.bilibili.com'
            && /\/player\/.*playurl/.test(u.pathname)
    } catch {
        return false
    }
}

// ── CDN 候選清單（台灣優化）───────────────────────────────────────────
// 順序由台灣常見可用性排列，實際播放時仍會依探測與下載速度自動調整。
// 這個順序只是**沒有任何本機資料時**的起跑序（getHealthyCdnList 在無樣本時的最後退路），
// 一旦有實測延遲/吞吐量就完全由資料接管——所以它不需要、也不應該精準反映某一台機器的
// 排名。2026-08-19 新增的四個鏡像（alib / ali02 / bos / tf-all-tx）與解除排除的 cosov，
// 都是用**真實簽名的 m4s 網址**實測回 206 + 完整位元組才加入的（見 CHANGELOG 實驗記錄
// 實驗 4）；`/crossdomain.xml` 回 200 只證明 host 活著，不足以當作加入的依據。
const PREFERRED_CDN_LIST_RAW = [
    // 海外（ov）：對台灣線路最短，兩次獨立量測都最快
    'upos-sz-mirroraliov.bilivideo.com',
    // cosov 留在 RAW 清單但被 ExcludeHostKeywords 預設排除（見上方說明）。
    // 保留在這裡是為了讓想自己實驗的人 BiliCDN.include("cosov") 就能放行，不必改原始碼。
    'upos-sz-mirrorcosov.bilivideo.com',
    // 境內鏡像：實測都能服務簽名路徑，快慢因人而異，交給本機資料排序
    'upos-sz-mirrorali.bilivideo.com',
    'upos-sz-mirroralib.bilivideo.com',
    'upos-sz-mirrorali02.bilivideo.com',
    'upos-sz-mirrorbos.bilivideo.com',
    'upos-tf-all-tx.bilivideo.com',
    'upos-sz-mirrorcos.bilivideo.com',
    // 以下三個在台灣已知不可用（INITIAL_DEAD_HOSTS_TW），留在清單裡是為了讓
    // 「本機實測成功過一次就自動解除推定」這條路仍然成立（換電信商/VPN 可能可用）
    'upos-sz-mirrorhwov.bilivideo.com',
    'upos-sz-mirrorhw.bilivideo.com',
    'upos-hz-mirroraliov.bilivideo.com',
]

const matchesExclude = (host) => {
    if (!host) return false
    return ExcludeHostKeywords.some(kw => kw && host.indexOf(kw) !== -1)
}

// 資安：CustomCDN / BiliCDN.setCdn() 讓使用者固定某個 host，這個值後續會直接拿去
// 改寫影片 segment 的請求目標。它同時也透過 unsafeWindow.BiliCDN 暴露給「頁面環境」
// 呼叫（DevTools console 就是跑在頁面環境），所以理論上只要頁面環境有任何非我方
// JS 在執行（例如被植入的惡意第三方腳本），就能呼叫 BiliCDN.setCdn() 把這個值改成
// 任意網域，讓腳本把之後所有影片流量重導到攻擊者的伺服器。加一層網域格式驗證，
// 只允許 bilibili 自己的 CDN 網域（含子網域），不接受任意字串當改寫目標——
// 不影響正常使用（本來就只該填 bilivideo 系列的鏡像站），但擋掉這條路徑被濫用時
// 的最壞情況。
const isValidCustomCdnHost = (host) => {
    if (!host || typeof host !== 'string') return false
    return /^[a-z0-9-]+\.bilivideo\.(com|cn)$/i.test(host)
}

const PREFERRED_CDN_LIST = PREFERRED_CDN_LIST_RAW.filter(h => !matchesExclude(h))

// ── 黑名單（24h，session 失敗累積觸發）+ HARD 失敗碼 ─────────────────
// HARD 狀態碼 = 區域/權限永久拒絕，一次就黑名單 + 標死節點
const BLACKLIST_EXPIRE_MS = 24 * 60 * 60 * 1000
const CDN_FAIL_THRESHOLD  = 2
const HARD_FAIL_STATUSES  = new Set([403, 451, 959]) // 959：Bilibili 對台灣 IP 的區域拒絕自訂碼（非標準 HTTP 狀態碼，實測於台灣網路環境觀察到）
const CDN_SOFT_BLOCK_MS   = 10 * 60 * 1000
const CDN_SOFT_BLOCK_ESCALATE = 3
const CDN_HEALTH_KEY = 'cdnHealth_v1'
const CDN_HEALTH_TTL = 6 * 60 * 60 * 1000

const blacklistSet = (() => {
    try {
        const raw   = JSON.parse(GM_getValue('cdnBlacklist') || '[]')
        const now   = Date.now()
        const valid = raw.filter(e => e && e.cdn && e.expireAt > now)
        if (valid.length !== raw.length) GM_setValue('cdnBlacklist', JSON.stringify(valid))
        return new Set(valid.map(e => e.cdn))
    } catch {
        return new Set()
    }
})()

// ── 持久死節點（逾時 1d / 一般 7d / DNS 類 30d，跨 session）───────────
// 跳過所有 probe / preconnect / 賽馬 / 選路，徹底消除 console 紅字
//（任何失敗請求瀏覽器都會印紅字，唯一根治就是「不發」）
// 標記時機：探測 fetch 被 reject（DNS / 連線被拒 / TLS）、探測逾時且確認不可達、
//          HARD 失敗碼（403/451/959）、segment 連線層失敗且確認不可達
const DEAD_HOSTS_KEY = 'knownDeadHosts_v1'
const DEAD_HOSTS_TTL = 7 * 24 * 60 * 60 * 1000
// DNS 解析失敗跟其他失敗不是同一種東西：403、逾時、連線被拒都可能是暫時的（節點壅塞、
// 區域策略調整、對方在維護），7 天後重試一次很合理；但 NXDOMAIN 是「這個網域在這個
// 解析器上不存在」，是穩定事實，7 天後重試只會得到完全一樣的結果 —— 代價是每週一次
// 必定失敗的請求，以及 console 一行紅字。拉長到 30 天。
const DEAD_HOSTS_DNS_TTL = 30 * 24 * 60 * 60 * 1000
// 反過來，「逾時」是這三種死因裡**證據最弱**的一種：它只代表「在我們給的窗口內沒回應」，
// 而沒回應的原因可能是節點壞了，也可能只是冷 TLS 握手比窗口慢（實測上界 8.8 秒）、
// 或起播當下自己在搶連線配額。證據強度要配得上刑期——判 7 天太重，降到 1 天：
// 真的壞掉的節點隔天照樣會再被判一次（成本是一輪探測），誤殺的好節點則隔天就回得來。
const DEAD_HOSTS_TIMEOUT_TTL = 24 * 60 * 60 * 1000
const isDnsReason     = (reason) => typeof reason === 'string' && reason.indexOf('DNS') === 0
const isTimeoutReason = (reason) => typeof reason === 'string' && reason.indexOf('timeout') === 0
const deadTtlFor = (reason) =>
    isDnsReason(reason)     ? DEAD_HOSTS_DNS_TTL
  : isTimeoutReason(reason) ? DEAD_HOSTS_TIMEOUT_TTL
  : DEAD_HOSTS_TTL

// 讀取時順便**依現行規則重算刑期**。這一步是必要的，不是保險：`markHostDead()` 對已經在
// 清單裡的 host 幾乎不會再被呼叫到（probeCdnLatency 與 handleSegmentConnError 開頭都有
// `knownDeadHosts.has(cdn)` 提前 return），所以「改了刑期規則」如果只改寫入端，
// **既有紀錄會一直用舊規則服完刑**。2026-08-19 使用者機器上實測到的就是這個：
// 4 筆死節點全是 7 天，v1.3.3 宣稱的「DNS 類 30 天」從來沒有對它們生效過。
//
// 只往「縮短」的方向校正（超過現行 TTL 就夾回去），不延長：規則放寬（timeout 7d → 1d）要能立刻把
// 誤殺的節點放回候選池；規則收緊則不該追溯加重一個當初依舊規則判下去的刑期。
const knownDeadHosts = (() => {
    try {
        const raw   = JSON.parse(GM_getValue(DEAD_HOSTS_KEY) || '[]')
        const now   = Date.now()
        let changed = false
        const valid = []
        for (const e of raw) {
            if (!e || !e.host || !(e.expireAt > now)) { changed = true; continue }
            const capped = now + deadTtlFor(e.reason)
            if (e.expireAt > capped) { e.expireAt = capped; changed = true }
            valid.push(e)
        }
        if (changed) GM_setValue(DEAD_HOSTS_KEY, JSON.stringify(valid))
        return new Set(valid.map(e => e.host))
    } catch {
        return new Set()
    }
})()

// 升級/首次安裝：清掉舊黑名單 + probe 快取
try {
    const installedVersion = GM_getValue('blicdnVersion')
    if (installedVersion !== VERSION) {
        // 1.1.0+ 改用實測下載速度挑節點；舊 probe 快取是延遲排序，一律清掉重學
        GM_deleteValue('probeCache_v1')
        // 舊版殘留的 '4.4.6'..'4.7.0' 字串跟本專案 1.x 版本序列對不上（疑似複製自其他腳本），
        // 一律視為「≥1.0.0 就是安全版本」：用語意化比較取代硬編碼清單。
        if (!installedVersion || !verGte(installedVersion, '1.0.0')) {
            GM_setValue('cdnBlacklist', '[]')
            GM_deleteValue('probeCache_v1')
        }
        GM_setValue('blicdnVersion', VERSION)
    }
} catch {}

const markHostDead = (host, reason) => {
    if (!host || knownDeadHosts.has(host)) return
    knownDeadHosts.add(host)
    try {
        const raw    = JSON.parse(GM_getValue(DEAD_HOSTS_KEY) || '[]')
        const now    = Date.now()
        const others = raw.filter(e => e && e.host !== host && e.expireAt > now)
        // 刑期依死因分級（見 deadTtlFor）。既有紀錄的刑期改由載入時校正，
        // 因為這個函式對已經死掉的 host 走不到（第一行就 return）。
        others.push({ host, expireAt: now + deadTtlFor(reason), reason: reason || 'unknown' })
        GM_setValue(DEAD_HOSTS_KEY, JSON.stringify(others))
    } catch {}
    const idx = activeCdnList.indexOf(host)
    if (idx !== -1) activeCdnList.splice(idx, 1)
}

// 死節點的「死因 + 還剩多久」。knownDeadHosts 只是個 Set，看不出任何前因後果——
// 而一個好節點被誤殺 7~30 天，使用者唯一能察覺的徵兆就是這份清單多了一筆。
// 診斷輸出一定要能回答「為什麼死的」，否則只能靠猜。
const listDeadHosts = () => {
    try {
        const raw = JSON.parse(GM_getValue(DEAD_HOSTS_KEY) || '[]')
        const now = Date.now()
        return raw
            .filter(e => e && e.host && e.expireAt > now)
            .map(e => ({
                host:     e.host,
                reason:   e.reason || 'unknown',
                daysLeft: +((e.expireAt - now) / 86400000).toFixed(1),
            }))
    } catch { return [...knownDeadHosts].map(h => ({ host: h, reason: 'unknown', daysLeft: 0 })) }
}

// 單獨救回一個節點，不動其他學習狀態。clearDead() 是全清（連真的壞掉的也一起放回去，
// 下一輪探測又會重新撞一次、再印一次紅字），誤殺單一節點時用這個精準得多。
const reviveDeadHost = (host) => {
    if (!host) return false
    knownDeadHosts.delete(host)
    try {
        const raw = JSON.parse(GM_getValue(DEAD_HOSTS_KEY) || '[]')
        GM_setValue(DEAD_HOSTS_KEY, JSON.stringify(raw.filter(e => e && e.host !== host)))
    } catch {}
    const h = cdnHealth[host]
    if (h) { h.probeTimeouts = 0; h.failures = 0 }
    if (!activeCdnList.includes(host) && !blacklistSet.has(host) && PREFERRED_CDN_LIST.includes(host)) {
        activeCdnList.push(host)
    }
    delete cdnFailCount[host]
    delete cdnSoftBlockUntil[host]
    // 探測快取裡存的是「救回之前」的候選清單，不清掉的話下次載入又會照著舊清單重建，
    // 這個節點要等最多兩小時才回得來——等於 revive 當下看起來有效、重整後又不見了。
    try { GM_deleteValue(PROBE_CACHE_KEY) } catch {}
    scheduleCdnHealthSave()
    return true
}

const clearDeadHosts = () => {
    knownDeadHosts.clear()
    try { GM_setValue(DEAD_HOSTS_KEY, '[]') } catch {}
    try { GM_deleteValue(PROBE_CACHE_KEY) } catch {}   // 同 reviveDeadHost：舊快取會把節點擋在外面
    PREFERRED_CDN_LIST.forEach(c => {
        if (!activeCdnList.includes(c) && !blacklistSet.has(c)) activeCdnList.push(c)
    })
    activeCdnList.sort((a, b) => PREFERRED_CDN_LIST.indexOf(a) - PREFERRED_CDN_LIST.indexOf(b))
    log('[死節點] 已清除，所有白名單節點重新啟用')
}

// session 動態健康清單；啟動時排除黑名單（24h）+ 死節點（1~30d，依死因）
const activeCdnList = PREFERRED_CDN_LIST.filter(c => !blacklistSet.has(c) && !knownDeadHosts.has(c))

// 加入黑名單：對任意 bilivideo.com hostname 有效（不限白名單）
// 候選池還剩幾個「真的可以拿來用」的節點。用 PREFERRED_CDN_LIST 而不是 activeCdnList，
// 因為要算的是母體上限，不受當下排序或暫時性狀態影響。
const countUsableCandidates = (excluding) => PREFERRED_CDN_LIST.filter(c =>
    c !== excluding
    && !matchesExclude(c)
    && !knownDeadHosts.has(c)
    && !blacklistSet.has(c)
    && !isPresumedDnsFailHost(c)
).length

// 黑名單至少要留這麼多個可用節點。低於它就不准再關人。
const MIN_USABLE_POOL = 2

const addToBlacklist = (cdn) => {
    if (!cdn || blacklistSet.has(cdn)) return
    // ★ 懲罰的力道要跟「候選池有多大」成比例。
    // 黑名單是 24 小時的重罰，這個設計預設池子夠大、關掉一個的代價很小。但台灣環境的
    // 實際可用候選常常只有 3 個（cosov 被排除、hwov/hz-aliov 是 NXDOMAIN、hw 連不上），
    // 而升級到黑名單的門檻只是 `cdnFailCount >= 2`——**一次 Wi-Fi 斷線或 VPN 重連就能讓
    // 每個正在用的節點各記 2 次失敗**，把整個池子一次關光，接下來 24 小時無節點可用。
    //
    // 所以這裡加一道與池子大小連動的煞車：如果關掉這個之後，可用節點會少於
    // MIN_USABLE_POOL，就**不關**，降級成一次軟隔離（現在的軟隔離是真的會到期的，
    // 見 softBlockCdn 的說明）。這樣「這個節點目前表現不好」仍然被表達出來——選路會
    // 排開它——但不會演變成「整天都沒有節點可用」。
    //
    // 這條規則跟使用者的網路環境無關：不管誰的機器上哪一台最快，池子見底時的正確反應
    // 都是「降級處分」而不是「繼續關人」。
    if (countUsableCandidates(cdn) < MIN_USABLE_POOL) {
        cdnSoftBlockUntil[cdn] = Date.now() + CDN_SOFT_BLOCK_MS
        log('[黑名單] 略過 ' + cdn.split('.')[0]
            + '：關掉它會讓可用節點少於 ' + MIN_USABLE_POOL + ' 個，改為短期軟隔離')
        return
    }
    blacklistSet.add(cdn)
    delete cdnSoftBlockUntil[cdn]
    const idx = activeCdnList.indexOf(cdn)
    if (idx !== -1) activeCdnList.splice(idx, 1)
    try {
        const raw    = JSON.parse(GM_getValue('cdnBlacklist') || '[]')
        const now    = Date.now()
        const others = raw.filter(e => e && e.cdn !== cdn && e.expireAt > now)
        others.push({ cdn, expireAt: now + BLACKLIST_EXPIRE_MS })
        GM_setValue('cdnBlacklist', JSON.stringify(others))
    } catch {}
}

const clearBlacklist = () => {
    blacklistSet.clear()
    Object.keys(cdnSoftBlockUntil).forEach(c => delete cdnSoftBlockUntil[c])
    PREFERRED_CDN_LIST.forEach(c => {
        if (!activeCdnList.includes(c)) activeCdnList.push(c)
    })
    activeCdnList.sort((a, b) => PREFERRED_CDN_LIST.indexOf(a) - PREFERRED_CDN_LIST.indexOf(b))
    try { GM_setValue('cdnBlacklist', '[]') } catch {}
    log('[黑名單] 已全部清除，所有白名單節點重新啟用')
}

// session 失敗計數；HARD 失敗一次就黑名單 + 標死節點
const cdnFailCount = {}
const cdnSoftBlockUntil = {}

// 實際 segment 吞吐評分：probe 只決定初始順序，播放後改由真實下載速度接管。
// 吞吐量取樣規則改版時，既有的 ewmaMbps / samples 是用**舊規則**算出來的，留著會繼續
// 影響選路——修了規則不代表被規則汙染的資料會自己乾淨（這個專案已經踩過好幾次）。
// v2：加入最小樣本門檻（見 recordCdnThroughput）。在那之前，init segment 與 HTTP 快取
// 命中都會被當成「一次量測」，算出 200+ Mbps 的假值。只清吞吐量相關欄位，
// 保留 successes / failures / latencyMs（那幾項不受這條規則影響，清掉等於白白丟資料）。
const THROUGHPUT_SCHEMA_KEY = 'throughputSchema'
const THROUGHPUT_SCHEMA_VER = 2
const throughputSchemaStale = (() => {
    try {
        if ((+GM_getValue(THROUGHPUT_SCHEMA_KEY) || 0) >= THROUGHPUT_SCHEMA_VER) return false
        GM_setValue(THROUGHPUT_SCHEMA_KEY, THROUGHPUT_SCHEMA_VER)
        return true
    } catch { return false }
})()

const cdnHealth = (() => {
    try {
        const raw = JSON.parse(GM_getValue(CDN_HEALTH_KEY) || '{}')
        const now = Date.now()
        const out = {}
        Object.entries(raw).forEach(([cdn, h]) => {
            if (!cdn || !h || !PREFERRED_CDN_LIST.includes(cdn)) return
            if (knownDeadHosts.has(cdn) || blacklistSet.has(cdn)) return
            if (!h.lastSeen || now - h.lastSeen > CDN_HEALTH_TTL) return
            out[cdn] = {
                ewmaMbps: throughputSchemaStale ? 0 : (+h.ewmaMbps || 0),
                varMbps:  throughputSchemaStale ? 0 : (+h.varMbps || 0),
                samples:  throughputSchemaStale ? 0 : Math.min(+h.samples || 0, 12),
                bytes: +h.bytes || 0,
                failures: Math.min(+h.failures || 0, 2),
                successes: Math.min(+h.successes || 0, 12),
                slowSamples: throughputSchemaStale ? 0 : Math.min(+h.slowSamples || 0, 3),
                // ★ 兩個 strike 計數必須讀回來，否則「連續 N 輪才定罪」只在單一頁面
                // session 內成立——重整一次就歸零，等於門檻永遠達不到。
                // probeTimeouts 是既有欄位（有寫入存檔卻從沒被讀回，是個只寫不讀的欄位）；
                // probeSlows 是 2026-08-19 新增時漏接的。兩者都用小上限夾住，
                // 避免任何殘留的異常值一載入就直接把節點定罪。
                // 上限寫字面量而不是引用 PROBE_*_STRIKES：那兩個常數定義在本檔案更後面，
                // 這裡是載入期就會執行的 IIFE，引用會踩到 TDZ。
                probeTimeouts: Math.min(+h.probeTimeouts || 0, 3),
                probeSlows: Math.min(+h.probeSlows || 0, 3),
                softBlocks: 0,
                latencyMs: +h.latencyMs || 0,
                lastSeen: +h.lastSeen || 0,
                lastSlowAt: +h.lastSlowAt || 0,
                lastSoftBlockAt: 0,
                lastSoftBlockReason: '',
            }
        })
        return out
    } catch {
        return {}
    }
})()
const CDN_THROUGHPUT_ALPHA = 0.35
let currentStreamBitsPerSec = 0
// v1.3.3：這支片提供的所有畫質（height + bandwidth），用來把 currentStreamBitsPerSec
// 校正成「實際正在播的畫質」而不是「清單裡最高的畫質」。見 syncStreamBitrateFromVideo。
let streamProfile = null
let cdnHealthSaveTimer = null
// 全域記錄最近一次觀察到的 video 倍速；PerformanceObserver entry 收到時
// 沒有 video 參考，靠 Watchdog.tick 同步更新此值。
let latestPlaybackRate = 1

// seek 保護窗：拖時間軸後一段時間內不換 CDN、不測速、不強制改寫 segment，
// 避免 seek _recovery 期間 abort 重拉造成「緩衝加載更多次」與 Stuck:Rescue。
let seekGraceUntil = 0
const getSeekGraceMs = () => (currentStreamBitsPerSec / 1e6 >= 12) ? 8000 : 5000
const bumpSeekGrace = () => {
    seekGraceUntil = Math.max(seekGraceUntil, Date.now() + getSeekGraceMs())
}
const inSeekGrace = () => Date.now() < seekGraceUntil

const scheduleCdnHealthSave = () => {
    if (cdnHealthSaveTimer) return
    cdnHealthSaveTimer = setTimeout(() => {
        cdnHealthSaveTimer = null
        try {
            const now = Date.now()
            // 多分頁共用 GM 儲存：先讀回其他分頁可能已寫入的最新資料，逐 CDN 以 lastSeen
            // 較新者為準合併，避免分頁互相覆寫造成跨分頁學習丟失。
            let stored = {}
            try { stored = JSON.parse(GM_getValue(CDN_HEALTH_KEY) || '{}') || {} } catch {}
            const payload = {}
            const allCdns = new Set([...Object.keys(stored), ...Object.keys(cdnHealth)])
            allCdns.forEach(cdn => {
                if (!PREFERRED_CDN_LIST.includes(cdn)) return
                if (knownDeadHosts.has(cdn) || blacklistSet.has(cdn)) return
                const mine = cdnHealth[cdn]
                const theirs = stored[cdn]
                const pick = !mine ? theirs
                    : !theirs ? mine
                    : ((mine.lastSeen || 0) >= (theirs.lastSeen || 0) ? mine : theirs)
                if (!pick || !pick.lastSeen || now - pick.lastSeen > CDN_HEALTH_TTL) return
                payload[cdn] = {
                    ewmaMbps: +pick.ewmaMbps || 0,
                    varMbps: +pick.varMbps || 0,
                    samples: +pick.samples || 0,
                    bytes: +pick.bytes || 0,
                    failures: +pick.failures || 0,
                    successes: +pick.successes || 0,
                    slowSamples: +pick.slowSamples || 0,
                    probeTimeouts: +pick.probeTimeouts || 0,
                    probeSlows: +pick.probeSlows || 0,
                    latencyMs: +pick.latencyMs || 0,
                    lastSeen: +pick.lastSeen || 0,
                    lastSlowAt: +pick.lastSlowAt || 0,
                }
            })
            GM_setValue(CDN_HEALTH_KEY, JSON.stringify(payload))
        } catch {}
    }, 1000)
}

// mode='startup'：起播/緩衝充足，下載到碼率的 75% 就算夠快，可以容忍短暫低於碼率。
// mode='steady'（預設）：緩衝已經打平的穩態播放，長期低於碼率必定慢慢吃完緩衝，
// 「夠不夠快」是物理事實，門檻要跟真實碼率一致（留 5% 餘裕）——不該套用起播時的寬鬆係數。
const getRequiredStreamMbps = (playbackRate, mode) => {
    const rate = playbackRate && playbackRate > 0
        ? Math.max(playbackRate, 1)
        : Math.max(latestPlaybackRate || 1, 1)
    const streamMbps = currentStreamBitsPerSec > 0 ? currentStreamBitsPerSec / 1e6 : 4
    const factor = mode === 'startup' ? 0.75 : 1.05
    return Math.max(1.5, streamMbps * rate * factor)
}

const ensureCdnHealth = (cdn) => {
    if (!cdn) return null
    if (!cdnHealth[cdn]) {
        cdnHealth[cdn] = {
            ewmaMbps: 0,
            varMbps: 0,
            samples: 0,
            bytes: 0,
            failures: 0,
            successes: 0,
            slowSamples: 0,
            softBlocks: 0,
            probeTimeouts: 0,
            probeSlows: 0,
            latencyMs: 0,
            lastSeen: 0,
            lastSlowAt: 0,
            lastSoftBlockAt: 0,
            lastSoftBlockReason: '',
        }
    }
    return cdnHealth[cdn]
}

// 台灣不可用清單是「特定時空、特定 ISP」的觀察，不同電信商/VPN 路由差異很大，
// Bilibili 的 CDN 分配也會變。直接標死 7 天等於剝奪部分使用者用到最快節點的機會。
// 改成「起跑墊底」：仍在探索池內、仍會被 reorderCdnsByLatency 探測一次，
// 真的探測失敗時既有邏輯（probe timeout / DNS 失敗）自然會把它升級成標死。
//
// v1.3.3：觸發條件從「首次安裝或從 <1.0.0 升級」（shouldSeedInitialHosts）改成
// 「這個 host 在本機還沒有任何實測樣本」。舊條件對早就裝過的使用者實際上從來沒生效過，
// 這幾個 host 就以「零紀錄」的身分待在候選池裡——而零紀錄在 UCB 計分裡是「有探索加成」的，
// 反而比有幾次成功紀錄的節點更容易在起播那一刻被選中。
// 一旦有了真實資料（successes/samples > 0）就完全不干預，
// 使用者自己的實測永遠優先於這份清單。
if (INITIAL_DEAD_HOSTS_TW.length) {
    INITIAL_DEAD_HOSTS_TW.forEach(h => {
        const existing = cdnHealth[h]
        if (existing && ((existing.successes || 0) > 0 || (existing.samples || 0) > 0)) return
        const c = ensureCdnHealth(h)
        if (c) { c.failures = Math.max(c.failures || 0, 1); c.lastSeen = Date.now() }
    })
}

// ── 已知在台灣不解析的節點：省掉「再確認一次」的那個請求 ──────────────
// 探測失敗時預設會再呼叫一次 confirmHostReachable() 確認，避免一次瞬間拖動就把
// 好節點標死 7~30 天。但對 INITIAL_DEAD_HOSTS_TW 這幾個「已知在台灣就是不解析」、
// 而且本機從來沒有任何成功紀錄的 host，那次確認換不到新資訊（答案幾乎確定是
// DNS 失敗），只會在 console 多印一行紅字 —— 使用者回報過的 `?_c=...` 那行就是它。
//
// 「本機從來沒有成功紀錄」這個條件很重要 —— 它保留了 v1.3.0 的設計意圖：不同電信商 /
// VPN 路由差異很大，只要這個 host 在**你的**網路上真的成功過一次，就不再套用這條捷徑，
// 一律走完整的確認流程。
const KNOWN_BAD_TW_HOSTS = new Set(INITIAL_DEAD_HOSTS_TW)
const isPresumedDnsFailHost = (host) => {
    if (!host || !KNOWN_BAD_TW_HOSTS.has(host)) return false
    const h = cdnHealth[host]
    return !h || ((h.successes || 0) === 0 && (h.samples || 0) === 0)
}

const isCdnSoftBlocked = (cdn) => {
    const until = cdnSoftBlockUntil[cdn] || 0
    if (!until) return false
    if (until <= Date.now()) {
        delete cdnSoftBlockUntil[cdn]
        return false
    }
    return true
}

const recordCdnLatency = (cdn, latencyMs) => {
    if (!cdn || !Number.isFinite(latencyMs) || latencyMs <= 0) return
    const h = ensureCdnHealth(cdn)
    if (!h) return
    if (h.probeTimeouts) h.probeTimeouts = 0   // 這一輪探測有回應了，逾時計數歸零
    h.latencyMs = h.latencyMs
        ? (h.latencyMs * 0.65) + (latencyMs * 0.35)
        : latencyMs
    h.lastSeen = Date.now()
    scheduleCdnHealthSave()
}

const softBlockCdn = (cdn, reason, durationMs) => {
    if (!cdn || blacklistSet.has(cdn) || knownDeadHosts.has(cdn)) return
    const h = ensureCdnHealth(cdn)
    if (!h) return
    h.softBlocks++
    h.lastSoftBlockAt = Date.now()
    h.lastSoftBlockReason = reason || 'slow'
    cdnSoftBlockUntil[cdn] = Date.now() + (durationMs || CDN_SOFT_BLOCK_MS)
    // ★ 刻意**不動** activeCdnList。舊版在這裡 splice 掉這個 host，於是一個號稱
    // 「2~10 分鐘」的暫時處分，實際效果是**把節點移出候選池直到兩小時後的下一輪探測**
    // ——到期時只有 isCdnSoftBlocked() 變回 false，沒有任何路徑把它放回池子
    // （只有 403-single 與斷路器 retraction 兩個窄分支會還原，一般的 probe-slow /
    // probe-timeout / net-fail / fragment-error 都不會）。而被移出池子就選不到，
    // 選不到就不會成功，不成功就更不會有人把它放回來。
    //
    // 這是這份腳本反覆出現的同一個錯誤：**用「此時此刻的狀態」去編輯「整個 session 的
    // 候選池母體」**（reorderCdnsByLatency 與 doBakeoff 的單向棘輪已經各修過一次，
    // 註解就寫在那裡：「只重新排序，不縮減集合」）。軟隔離同樣是瞬時狀態，該由過濾層
    // 表達，不該改變成員資格。
    //
    // 移除 splice 不會讓被隔離的節點被選中——它已經被三層獨立地擋住：
    //   1. isCdnStronglyBad() 內含 isCdnSoftBlocked() → getHealthyCdnList 的 usable 濾掉它
    //   2. getCdnHealthScore() 的 softPenalty = 1.5（大於 1，一定排到最後）
    //   3. getBestCdn / preconnectCdn / 賽馬候選 等處各自都有 isCdnSoftBlocked() 檢查
    // 差別只在於：到期之後它會**自己回到可選狀態**，而不是要等下一輪探測重建。
    // 另外，全部節點都被隔離時 usable 為空會退回 pool（照分數排序），
    // 這比「候選池被掏空」健康得多。
    if (h.softBlocks >= CDN_SOFT_BLOCK_ESCALATE && h.failures >= 2) addToBlacklist(cdn)
    scheduleCdnHealthSave()
}

// 吞吐量取樣的最小門檻。128KB 這個值本來就存在（舊版只拿它判 slowSamples），
// 現在提升為「算不算一次量測」的共同門檻；5ms 則是用來排除 HTTP 快取命中
// （durationMs 會被 Math.max(1, …) 夾成 1ms，除出來是天文數字）。
const MIN_THROUGHPUT_SAMPLE_BYTES = 128 * 1024
const MIN_THROUGHPUT_SAMPLE_MS    = 5

const recordCdnThroughput = (cdn, bytes, durationMs, playbackRate) => {
    if (!cdn || !bytes || !durationMs || durationMs <= 0) return
    if (blacklistSet.has(cdn) || knownDeadHosts.has(cdn) || isUnstableCdnHost(cdn)) return
    const mbps = (bytes * 8) / durationMs / 1000
    if (!Number.isFinite(mbps) || mbps <= 0) return
    const h = ensureCdnHealth(cdn)
    if (!h) return
    h.bytes += bytes
    h.lastSeen = Date.now()

    // ★ 最小樣本門檻。舊版把**每一筆**傳輸都餵進 ewmaMbps，包含 init segment（~1KB）、
    // 小段 Range 請求，以及**從 HTTP 快取回來的回應**（durationMs 被 Math.max(1,…) 夾成
    // 1ms）。這些算出來的不是頻寬，是除以趨近零的分母：64KB / 2ms = 262 Mbps。
    // 使用者實測回報 `cos: {mbps: 201.32, samples: 98}` 就是這樣堆出來的——而
    // ewmaMbps 是選路計分的主要項，於是 `目前最佳` 被推成 cos，儘管同一份診斷裡
    // cos 的 latency 是 516ms、aliov 只有 142ms（curl 實測 TTFB 亦然：cos ~1000ms、
    // aliov ~70ms）。等於「誰剛好命中快取，誰就被判定為最快的節點」。
    //
    // 吞吐量只有在「傳輸夠大、久到脫離 slow-start 並攤平 TTFB」時才有意義。不夠大的
    // 傳輸仍然計入 h.bytes（面板的累計下載量要準），但**不進 ewmaMbps、不算一個樣本**
    // ——samples 的語意就是「有幾次有效的吞吐量量測」，計分與抖動估計都靠它加權。
    if (bytes < MIN_THROUGHPUT_SAMPLE_BYTES || durationMs < MIN_THROUGHPUT_SAMPLE_MS) {
        scheduleCdnHealthSave()
        return
    }
    // 均值之外同步追蹤「抖動」：緩衝夠不夠是看均速，卡不卡頓看的是穩不穩——同樣均速
    // 15~35 Mbps 抖動的節點，比穩定在 20 Mbps 的節點更容易讓緩衝瞬間見底。用標準的
    // EWMA 變異數遞增公式（跟均值同一個 alpha，兩者衰減步調一致），第一個樣本沒有
    // 離散度資訊，變異數維持 0（不因為只有一筆樣本就誤判抖動）。
    if (h.samples) {
        const diff = mbps - h.ewmaMbps
        const incr = CDN_THROUGHPUT_ALPHA * diff
        h.ewmaMbps += incr
        h.varMbps = (1 - CDN_THROUGHPUT_ALPHA) * ((h.varMbps || 0) + diff * incr)
    } else {
        h.ewmaMbps = mbps
        h.varMbps = 0
    }
    h.samples++
    // 走到這裡代表已經通過最小樣本門檻（見上），所以不必再判一次大小。
    // 用真實 playbackRate 計算需求；倍速時 required 等比例放大
    const required = getRequiredStreamMbps(playbackRate, 'steady')
    if (mbps < required) {
        h.slowSamples++
        h.lastSlowAt = h.lastSeen
    } else {
        h.slowSamples = Math.max(0, h.slowSamples - 1)
    }
    scheduleCdnHealthSave()
}

const recordCdnPenalty = (cdn, hard) => {
    const h = ensureCdnHealth(cdn)
    if (!h) return
    h.failures += hard ? 3 : 1
    h.lastSeen = Date.now()
    scheduleCdnHealthSave()
}

const recordCdnHealthSuccess = (cdn) => {
    const h = ensureCdnHealth(cdn)
    if (!h) return
    h.successes++
    h.failures = Math.max(0, h.failures - 1)
    h.slowSamples = Math.max(0, h.slowSamples - 1)
    h.lastSeen = Date.now()
    delete cdnSoftBlockUntil[cdn]
    scheduleCdnHealthSave()
}

// 跨國選節點 = 非平穩多臂老虎機：用 Discounted-UCB 近似最優 online 策略。
// exploit 項：吞吐量 EWMA 隨時間半衰（舊樣本信心打折，貼近擁塞變動）。
// explore 項：低樣本節點給樂觀加成，促使週期性重評估，避免鎖死在次優解。
//
// reward 正規化到 0~1（UCB1 的數學前提），懲罰項也換算成同一級距，否則探索強度會跟
// 節點快慢反著跑：節點很快時 explore 加成被吞吐量淹沒（不再探索），節點很慢時
// explore 加成反而主導排序（過度探索）——跟「越不確定越該試」的設計意圖相反。
const UCB_EXPLORE_C          = 0.6          // 探索強度（0~1 級距下的常數），越大越積極試新節點
const THROUGHPUT_HALFLIFE_MS = 8 * 60 * 1000 // 吞吐量樣本半衰期
// 抖動懲罰的權重／上限：以「最穩定、不卡頓」為最高原則，寧可選一個均速略低但穩定
// 的節點，也不要選均速高但忽快忽慢的節點——0.35 上限跟 slowPenalty 同量級（兩者都是
// 「無法穩定供應緩衝」的懲罰，只是一個看瞬間門檻、一個看長期離散度），但不到 softPenalty
// 那種「直接排到最後」的強度，避免單純因為波動被誤判成壞節點。
// 數值來源：用模擬器跑過「30 分鐘播放、含真實換節點延遲代價」的緊繃/寬鬆/4K 三種情境
// 網格搜尋（不是憑感覺猜）——單獨調這兩個值效果很小且不穩定，關鍵是要先有 CDN_STICKY_MARGIN
// 的滯後保護（見 getHealthyCdnList），兩者一起才會讓卡頓次數穩定下降。
const JITTER_WEIGHT      = 0.4
const JITTER_PENALTY_CAP = 0.35
const JITTER_PRIOR_CV     = 0.25  // 低樣本節點的悲觀先驗抖動假設
const JITTER_PRIOR_WEIGHT = 2     // 先驗的「等效樣本數」，樣本數遠大於這個值後才主要信任實測

// 有效樣本數：跟 reward 用同一個半衰因子折舊。Discounted-UCB 的標準實作要點是分子
// （累積 reward）和分母（樣本數）必須同步打折——只折分子的話，久沒用的好節點雖然
// 吞吐量衰減到接近 0，但因為 samples 還是原本的大數字，explore 加成也很小，
// 分數永遠很低、永遠不會被重新測試，即使它現在其實是最快的。
const getEffectiveSamples = (cdn) => {
    const h = cdnHealth[cdn]
    if (!h || !h.samples) return 0
    const age = Math.max(0, Date.now() - (h.lastSeen || 0))
    return h.samples * Math.pow(0.5, age / THROUGHPUT_HALFLIFE_MS)
}

const getTotalEffectiveSamples = () => {
    let n = 0
    for (const k in cdnHealth) n += getEffectiveSamples(k)
    return n
}

// opts.exploit = true：關閉 UCB 的探索加成，只用「已經實測到的表現」排名。
//
// 為什麼要分兩種模式（v1.3.3）：exploreBonus 是多臂拉霸機的標準設計，會刻意給
// 「樣本少的節點」加分，讓它有機會被選中去累積樣本 —— 這在長期是對的，但代價是
// 「偶爾會中獎選到一個沒把握的節點」。問題在於這個代價會落在最禁不起出事的地方：
// playurl 改寫的當下（也就是使用者剛點進影片、正要起播的那一刻）。
//
// 而探索其實已經有專屬管道了：賽馬（doBakeoff）本來就會挑「缺新鮮樣本」的候選去
// 實測，用 384KB~768KB 的 ranged GET 拿樣本。用賽馬探索的成本是幾百 KB 的背景流量，
// 用起播探索的成本是使用者盯著轉圈圈 —— 沒有理由選後者。
//
// 所以：起播路徑（transformStreamItem / buildBackupUrls）用 exploit 模式，
// 其餘情境（Watchdog 卡頓後換節點、賽馬後重排序）維持完整 UCB —— 那些情境本來就
// 是「現在這個已經不行了，該去試點別的」，探索加成正好派上用場。
const getCdnHealthScore = (cdn, opts) => {
    const h = cdnHealth[cdn]
    const required = getRequiredStreamMbps(undefined, 'steady')

    // ── reward：正規化到 0~1（達到 2 倍需求速度即視為滿分，避免高速節點之間的絕對差距
    // 把分數尺度撐爆，導致 explore 項在快節點之間完全失去作用）
    let throughput = (h && h.samples) ? h.ewmaMbps : 0
    if (h && h.samples && h.lastSeen) {
        const age = Date.now() - h.lastSeen
        if (age > 0) throughput *= Math.pow(0.5, age / THROUGHPUT_HALFLIFE_MS)
    }
    const reward = Math.min(1, throughput / Math.max(1, required * 2))

    // ── explore：標準 UCB1，用折舊後的有效樣本數，讓久沒用的節點自然回到探索池
    // exploit 模式（起播）直接歸零：見上方 getCdnHealthScore 的完整說明。
    const nEff  = getEffectiveSamples(cdn)
    const total = getTotalEffectiveSamples()
    const exploreBonus = (opts && opts.exploit)
        ? 0
        : UCB_EXPLORE_C * Math.sqrt(Math.log(total + 1) / (nEff + 1))

    // ── penalty：同樣換算到 0~1 級距，延遲探測（探測 RTT，資訊量低）權重壓到最多 10%
    const failPenalty    = Math.min(0.6, ((cdnFailCount[cdn] || 0) * 0.15) + (h ? h.failures * 0.10 : 0))
    const slowPenalty    = Math.min(0.4, h ? h.slowSamples * 0.10 : 0)
    const softPenalty    = isCdnSoftBlocked(cdn) ? 1.5 : 0   // 大於 1：一定排到最後
    const latencyPenalty = h && h.latencyMs ? Math.min(0.10, h.latencyMs / 3000) : 0
    // ── 抖動懲罰：緩衝夠不夠看均速，卡不卡頓看的是穩不穩定。同樣均速 20Mbps，
    // 15~35 抖動的節點比穩定 18~22 的節點更容易讓緩衝瞬間見底、觸發卡頓。用變異係數
    // （標準差/均值，無因次，不受節點快慢的絕對量綱影響）換算成跟其他懲罰同級距的分數。
    // 低樣本節點不能假設「零抖動」——那等於暗示「沒測過＝最穩定」，會誘使演算法為了
    // 避開已知節點的抖動懲罰而不斷去測新節點，反而更不穩定（用模擬跑過 900 個 segment
    // 驗證過這個反效果）。改用信賴度加權的悲觀先驗：樣本少時假設中等抖動
    // （JITTER_PRIOR_CV），隨樣本數增加才逐漸信任實測值。
    const measuredCv = h && h.samples ? Math.sqrt(h.varMbps || 0) / Math.max(1e-6, h.ewmaMbps) : JITTER_PRIOR_CV
    const blendedCv = (JITTER_PRIOR_CV * JITTER_PRIOR_WEIGHT + measuredCv * (h ? h.samples : 0))
        / (JITTER_PRIOR_WEIGHT + (h ? h.samples : 0))
    const jitterPenalty = (h && h.ewmaMbps > 0)
        ? Math.min(JITTER_PENALTY_CAP, blendedCv * JITTER_WEIGHT)
        : 0

    return reward + exploreBonus - failPenalty - slowPenalty - softPenalty - latencyPenalty - jitterPenalty
}

const isCdnStronglyBad = (cdn) => {
    if (!cdn) return false
    if (knownDeadHosts.has(cdn)) return true
    if (isCdnSoftBlocked(cdn)) return true
    if ((cdnFailCount[cdn] || 0) >= CDN_FAIL_THRESHOLD) return true
    const h = cdnHealth[cdn]
    if (!h) return false
    if (h.failures >= 2 && h.successes === 0) return true
    if (getEffectiveSamples(cdn) >= 2 && h.slowSamples >= 2 && h.ewmaMbps < getRequiredStreamMbps(undefined, 'steady') * 0.85) return true
    return h.failures >= 3 && h.failures > h.successes
}

// 黏著滯後：getBestCdn() 過去完全沒有「換節點的保護」，每個 segment 都重新算一次
// 最高分，任何分數雜訊（包括下面 jitterPenalty 帶來的）都會在下一個 segment 立刻
// 觸發換節點——但換節點要重新 TCP/TLS 握手，這個代價往往比「換到分數高一點點的
// 節點」換來的好處更大。模擬過（30 分鐘播放、含真實換節點延遲代價）：加上這個
// 滯後讓卡頓次數直接減少 5~6 成，比單獨調 jitterPenalty 的權重有效得多；而且加了
// 滯後之後，jitterPenalty 才真的能發揮作用，不然它造成的額外換節點會抵銷掉它想
// 帶來的穩定度好處。只保護「還在候選池裡」的節點——真的被 isCdnStronglyBad 或
// 失敗次數踢出候選池的節點不受保護，該換照樣換。
//
// 注意：黏著狀態（lastChosenCdn）只能由「真的決定接下來要用哪個節點」的 getBestCdn()
// 讀寫。getHealthyCdnList() 本身保持單純的排序函式——它也被 buildBackupUrls()、
// switchCdn() 算 warmTargets、fragment-error 之後的 preconnect 熱身等「只是要看排名 /
// 順便熱身，不代表接下來真的會拉這個節點的 segment」的場合呼叫，如果那些呼叫也
// 順手把 lastChosenCdn 覆寫掉，黏著保護會被錨定到從未真正服務過 segment 的節點上，
// 跟實際播放路徑（誰在拉 segment）脫鉤。
let lastChosenCdn = null
const CDN_STICKY_MARGIN = 0.20

const getHealthyCdnList = (opts) => {
    // ★ 過濾的**順序**是關鍵，不能只看每一層各自的邏輯。
    // isPresumedDnsFailHost 是「已知連不到」（必定失敗），cdnFailCount 是「最近表現不好」
    // （只是慢）。必須先整批拿掉前者，再談失敗次數——反過來寫的話，當所有可達節點都因為
    // 失敗次數超標被濾掉時，剩下的就只有那些「從沒被用過、所以也從沒失敗過」的不可達節點，
    // 選路會直接把 segment 導去 NXDOMAIN。使用者實測 log 出現過：
    //   [Transport] upos-sz-mirrorcosov → upos-sz-mirrorhwov（非白名單，累計 1 次）
    // 「被懲罰過但連得到」永遠優於「乾淨但連不到」。
    const mk = (cdn, index) => ({ cdn, index, health: cdnHealth[cdn], score: getCdnHealthScore(cdn, opts) })
    const all = activeCdnList.map(mk)
    const reachable  = all.filter(item => !isPresumedDnsFailHost(item.cdn))
    // ★ 上面那條「可達優先於乾淨」的規則有個更上游的漏洞：cdnFailCount 只是「記帳」，
    // 但累積到 CDN_FAIL_THRESHOLD（2 次）就會 addToBlacklist()，而黑名單是直接把節點
    // **從 activeCdnList 移除**的。也就是說一次網路斷線（Wi-Fi 掉線、VPN 重連、切換網路）
    // 就能讓每個正在用的節點各記 2 次失敗，把所有可達節點一次清出候選池——池子裡就只剩
    // 那幾個「從沒被用過、所以也從沒失敗過」的已知不解析節點。接著 base 退回 all，
    // 選路開始把每一顆 segment 都改寫到 NXDOMAIN，而黑名單一綁就是 24 小時：
    // 使用者看到的是「整天都完全播不出來 + console 滿滿 ERR_NAME_NOT_RESOLVED」。
    // 排序層修好了，但成員層還會被掏空——所以退路也要補在成員層。
    // 這裡只在「候選池裡連一個可達節點都不剩」時才啟用，正常情況完全不受影響：
    // 寧可用一個被黑名單過、但至少解得到 IP 的節點，也不要用一個必定失敗的。
    let base = reachable
    if (!base.length) {
        const salvaged = PREFERRED_CDN_LIST
            .filter(c => !isPresumedDnsFailHost(c) && !knownDeadHosts.has(c) && !matchesExclude(c))
            .map(mk)
        base = salvaged.length ? salvaged : all
    }
    const notFailing = base.filter(item => (cdnFailCount[item.cdn] || 0) < CDN_FAIL_THRESHOLD)
    const pool       = notFailing.length ? notFailing : base
    const usable     = pool.filter(item => !isCdnStronglyBad(item.cdn))
    const indexed    = usable.length ? usable : pool

    indexed.sort((a, b) => {
        const aHasSamples = !!(a.health && a.health.samples)
        const bHasSamples = !!(b.health && b.health.samples)
        if (aHasSamples || bHasSamples) {
            if (a.score !== b.score) return b.score - a.score
            if ((a.health ? a.health.ewmaMbps : 0) !== (b.health ? b.health.ewmaMbps : 0)) {
                return (b.health ? b.health.ewmaMbps : 0) - (a.health ? a.health.ewmaMbps : 0)
            }
        }
        // 都還沒有吞吐量樣本（全新安裝、或吞吐量資料剛被重置）時，先比**實測延遲**再退回
        // index。舊版直接退回 index，隱含假設「activeCdnList 的順序就是延遲順序」——
        // 但那只在剛跑完探測時成立：黑名單還原、死節點救回等路徑是照
        // PREFERRED_CDN_LIST.indexOf 重排的，那是一份寫死的靜態順序，跟這台機器的實測
        // 快慢無關。於是在「沒有吞吐量樣本」這段期間（正是起播最需要選對節點的時候），
        // 選路可能完全忽略我們明明已經量到的延遲差距。
        const aMs = (a.health && a.health.latencyMs) || 0
        const bMs = (b.health && b.health.latencyMs) || 0
        if (aMs && bMs && aMs !== bMs) return aMs - bMs
        if (aMs && !bMs) return -1      // 有實測資料的優先於完全沒量過的
        if (!aMs && bMs) return 1
        return a.index - b.index
    })

    return indexed.map(i => i.cdn)
}

// 403 突發偵測：playurl 簽名（deadline/upsig）過期時，播放器對所有 backup_url 重試，
// 短時間內會有多個不同 host 各拿一次 403——這不是節點壞掉，是「門票」全體失效。
// 若照舊把每個 host 都當硬失敗標死 7 天，會在簽名過期的瞬間把所有候選節點一次封光。
const recent403 = new Map()          // host -> ts
const GLOBAL_403_WINDOW_MS = 15000   // 15 秒內
const GLOBAL_403_HOSTS     = 2       // 有 2 個以上不同 host 都 403 → 判定為簽名過期
const isGlobal403Burst = (host) => {
    const now = Date.now()
    recent403.set(host, now)
    for (const [h, t] of recent403) if (now - t > GLOBAL_403_WINDOW_MS) recent403.delete(h)
    return recent403.size >= GLOBAL_403_HOSTS
}

// 突發偵測需要看到「第 2 個」不同 host 才判得出來，所以同一波簽名過期裡最先 403
// 的那個 host 一定會在偵測到突發之前，先走一次「單一 host」分支被軟隔離。等真的
// 確認是突發時，把這波窗口內已經被誤罰的 host 全部補救回來，才符合「不處罰任何
// 節點」的設計目標，不然第一個中獎的 host 永遠會被冤枉 10 分鐘。
const retract403Penalty = (host) => {
    // 不管有沒有真的收回懲罰，這個 host 在這次突發事件裡已經處理過了，从 recent403
    // 移除——否則它會一直留在窗口內（最長到 15 秒後才被自然過期），若之後又對同一個
    // host 記錄一次全新、不相關的單一 403（重新軟隔離、reason 又變回 '403-single'），
    // 剩餘窗口內若再確認一次突發，會把這筆新的、不相關的軟隔離也一併誤收回。
    recent403.delete(host)
    const h = cdnHealth[host]
    // 只收回「這次 403-single 分支造成」的懲罰，不要誤觸該節點因為別的原因
    // （例如吞吐量太慢）本來就存在的軟隔離——用 lastSoftBlockReason 當精確判斷依據，
    // 而不是「只要現在有 soft block 就收回」。
    if (!h || h.lastSoftBlockReason !== '403-single') return
    if (h.failures > 0) h.failures--
    if (cdnSoftBlockUntil[host]) {
        delete cdnSoftBlockUntil[host]
        h.lastSoftBlockReason = ''
        if (h.softBlocks > 0) h.softBlocks--
        if (!activeCdnList.includes(host) && !blacklistSet.has(host) && !knownDeadHosts.has(host)
            && PREFERRED_CDN_LIST.includes(host)) {
            activeCdnList.push(host)
        }
    }
}

const recordCdnFailure = (cdn, hard, status) => {
    if (!cdn) return
    if (blacklistSet.has(cdn) || knownDeadHosts.has(cdn)) return

    if (status === 403) {
        if (isGlobal403Burst(cdn)) {
            log('[403] 偵測到多節點同時 403，判定為 playurl 簽名過期，不標記死節點：' + cdn.split('.')[0])
            for (const h of recent403.keys()) retract403Penalty(h)
            return
        }
        // 只有單一 host 403：先軟隔離觀察，不直接標死（可能只是該節點區域拒絕，也可能是巧合）
        recordCdnPenalty(cdn, false)
        softBlockCdn(cdn, '403-single', 10 * 60 * 1000)
        return
    }

    recordCdnPenalty(cdn, hard)
    if (hard) {
        cdnFailCount[cdn] = CDN_FAIL_THRESHOLD
        addToBlacklist(cdn)
        markHostDead(cdn, 'HARD-fail')
        try { Watchdog.noteHardFail() } catch {}
        return
    }
    cdnFailCount[cdn] = (cdnFailCount[cdn] || 0) + 1
    if (cdnFailCount[cdn] >= CDN_FAIL_THRESHOLD) addToBlacklist(cdn)
    else softBlockCdn(cdn, 'net-fail', 2 * 60 * 1000)
}

const recordCdnSuccess = (cdn) => {
    recordCdnHealthSuccess(cdn)
    if (cdn && cdnFailCount[cdn]) cdnFailCount[cdn] = 0
    // 真的成功過一次，之前那次逾時就不該再累計進「定罪」的計數裡。
    const h = cdn && cdnHealth[cdn]
    if (h && h.probeTimeouts) h.probeTimeouts = 0
}

const getBestCdn = (opts) => {
    const healthy = getHealthyCdnList(opts)
    if (healthy.length) {
        let pick = healthy[0]
        // 黏著滯後：現用節點（lastChosenCdn）沒輸最高分超過 CDN_STICKY_MARGIN、且還在
        // 候選池裡，就留著不換（見上方 lastChosenCdn 宣告處的完整說明）。這是唯一
        // 讀寫 lastChosenCdn 的地方——getHealthyCdnList() 本身保持單純排序，不受
        // 「誰呼叫它」影響黏著狀態。
        if (lastChosenCdn && lastChosenCdn !== pick && healthy.includes(lastChosenCdn)) {
            // 兩邊必須用同一種計分模式，否則一邊有探索加成、一邊沒有，
            // CDN_STICKY_MARGIN 的滯後保護會被這個系統性偏差整個吃掉。
            const curScore = getCdnHealthScore(lastChosenCdn, opts)
            const topScore = getCdnHealthScore(pick, opts)
            if (curScore >= topScore - CDN_STICKY_MARGIN) pick = lastChosenCdn
        }
        lastChosenCdn = pick
        return pick
    }
    if (activeCdnList.length > 0) {
        activeCdnList.forEach(c => { cdnFailCount[c] = 0 })
        return activeCdnList[0]
    }
    err('[警告] 所有白名單節點均失效，自動重置黑名單')
    clearBlacklist()
    if (activeCdnList.length > 0) return activeCdnList[0]
    // 連黑名單清掉後仍無節點 → 代表白名單幾乎全被標死（網路/VPN 變動或誤判殘留）。
    // 救回非預設（學習而來）的死節點，避免完全沒節點可用而失效。
    const allPreferredDead = PREFERRED_CDN_LIST.every(c => knownDeadHosts.has(c) || blacklistSet.has(c))
    if (allPreferredDead) {
        err('[警告] 白名單全數標死，自動清除死節點重新啟用')
        clearDeadHosts()
    }
    return activeCdnList[0] || null
}

const promoteBestCdnNow = () => {
    const best = getBestCdn()
    if (!best) return null
    const idx = activeCdnList.indexOf(best)
    if (idx > 0) {
        activeCdnList.splice(idx, 1)
        activeCdnList.unshift(best)
    } else if (idx === -1 && !blacklistSet.has(best) && !knownDeadHosts.has(best) && !isCdnSoftBlocked(best)) {
        activeCdnList.unshift(best)
    }
    // preconnectCdn(force=true) 是「remove() 舊 <link> 再重建」，會讓瀏覽器有機會回收
    // 那條 idle socket。對「正在服務 segment 的那個節點」做這件事，等於在最需要它的時候
    // 把連線拆掉重來 —— seek 預熱那邊早就註明過這個陷阱（見 warmupSeek 的註解），
    // 但 promoteBestCdnNow 一直是無差別 force=true，而它的呼叫點遍布 switchCdn、
    // handleSegmentConnError、探測快取命中等路徑，很容易正好落在 seek 當下。
    //
    // 規則跟 keep-warm timer 對齊（那裡是 preconnectBatch(hosts, !inSeekGrace())）：
    // seek 保護窗內一律不 force；正在拉 segment 的節點任何時候都只補不拆。
    let playingNow = null
    try { playingNow = getPlayingCdnHost() } catch {}   // 極早期呼叫時尚未定義，忽略即可
    const warmList = activeCdnList.slice(0, 3)
    preconnectBatch(warmList.filter(h => h !== playingNow), !inSeekGrace())
    if (playingNow) preconnectCdn(playingNow, false)
    syncWorkerCdnTarget()
    return best
}

// 解析固定 CDN（CustomCDN 變數 vs GM 儲存）
const resolvedCdn = (() => {
    if (CustomCDN === 'null') CustomCDN = null
    const stored = GM_getValue('CustomCDN')
    let domain
    if (CustomCDN) {
        domain = CustomCDN
        if (CustomCDN !== stored) GM_setValue('CustomCDN', domain)
    } else if (CustomCDN === null && stored !== null) {
        GM_deleteValue('CustomCDN')
    } else {
        domain = stored || null
    }
    // 見 isValidCustomCdnHost 註解：不是合法的 bilibili CDN 網域格式就不採用，
    // 不管來源是腳本頭的變數還是 GM 儲存值（含被 unsafeWindow.BiliCDN.setCdn 竄改的情況）。
    // 這則警告不能只在 Config.verbose 開啟時才顯示（err() 預設就是這樣）——會默默把
    // 使用者先前設定的固定 CDN 改回自動選擇，沒開詳細記錄的人完全不會知道發生過這件事。
    if (domain && !isValidCustomCdnHost(domain)) {
        console.error('[' + PluginName + ']: [安全] CustomCDN 不是合法的 bilibili CDN 網域，已忽略：' + domain)
        domain = null
    }
    return domain
})()

const getCurrentCdn   = (opts) => resolvedCdn || getBestCdn(opts)
const getCdnShortName = () => { const c = getCurrentCdn(); return c ? c.split('.')[0] : 'N/A' }

// 起播（playurl 改寫）專用的計分模式：只信實測表現，不做探索。見 getCdnHealthScore 說明。
const STARTUP_PICK = { exploit: true }

// UI 標題（依瀏覽器語言）
const SettingsBarTitle = (() => {
    const lang = ((navigator.languages || [navigator.language || 'en'])[0]).substring(0, 2)
    return ({ zh: '攔截修改影片 CDN', ja: 'CDNスイッチャー' })[lang] || 'CDN Switcher (TW)'
})()

// ── URL 工具 ──────────────────────────────────────────────────────────
const isAkamaiUrl = (url) => {
    try { return !!url && new URL(url).hostname.endsWith('.akamaized.net') } catch { return false }
}

const isBiliVideoUrl = (url) => {
    try {
        const h = url && new URL(url).hostname
        return !!(h && (h.endsWith('.bilivideo.com') || h.endsWith('.bilivideo.cn')))
    } catch { return false }
}

const getBiliVideoCdn = (url) => {
    try {
        const h = new URL(url).hostname
        return (h.endsWith('.bilivideo.com') || h.endsWith('.bilivideo.cn')) ? h : null
    } catch { return null }
}

const isHttpDnsUrl = (url) => {
    try { return new URL(url).hostname === 'httpdns.bilivideo.com' } catch { return false }
}

const isBiliJsonMetadataApi = (url) => {
    try {
        const u = new URL(url, location.href)
        if (u.hostname !== 'api.bilibili.com') return false
        // 注意：/x/v2/dm/web/view 官方回傳 Protobuf 二進位（高能進度條開關等資訊即在此包內），
        // 強制改寫 Accept 為 JSON 會讓格式與播放器的 arraybuffer 解析不一致，
        // 造成該包解析失敗 → 高能進度條消失（但不影響 playurl 走的影片播放本身）。
        // 只有 subtitle/web/view 本身就是 JSON，才需要這個 header 修正。
        return u.pathname === '/x/v2/subtitle/web/view'
    } catch {
        return false
    }
}

// 頁面 / playurl 曾出現過的穩定 upos host（MCDN/PCDN fallback 用）
let pageDiscoveredCdn = null

const discoverCdnFromPage = () => {
    try {
        const html = (document.head && document.head.innerHTML) || ''
        const m = html.match(/up[\w-]+\.bilivideo\.com/)
        if (!m || !m[0]) return
        if (matchesExclude(m[0]) || knownDeadHosts.has(m[0]) || blacklistSet.has(m[0]) || isCdnSoftBlocked(m[0])) return
        pageDiscoveredCdn = m[0]
        preconnectCdn(m[0])
    } catch {}
}

const noteDiscoveredCdn = (host) => {
    if (!host || !host.endsWith('.bilivideo.com')) return
    if (matchesExclude(host) || knownDeadHosts.has(host) || blacklistSet.has(host) || isCdnSoftBlocked(host)) return
    if (isUnstableCdnHost(host)) return
    pageDiscoveredCdn = host
    preconnectCdn(host)
}

// MCDN / PCDN / 區域自建節點（常見海外卡頓來源）
const isUnstableCdnHost = (host) => {
    if (!host) return false
    if (/\.mcdn\.bilivideo\.(cn|com)$/i.test(host)) return true
    if (/\.szbdyd\.com$/i.test(host)) return true
    // BCache（B 站自建機房）：地區代碼長度不固定，實際看過 cn-tj-cu-01（2 碼）、
    // cn-hbwh-cm-01-11（4 碼）、cn-jxnc-cmcc-bcache-06（4 碼）等寫法。
    // 舊的 [a-z]{2} 只吃得下兩碼，四碼的一律漏判 —— 漏判不會讓它逃過改寫
    // （這些 host 不在白名單，needsRedirect 照樣成立），但會讓 isMediaSegmentUrl、
    // seek 期間的 mustFix、以及 Watchdog 挑「元兇」時的排除條件全部對它失效。
    if (/^cn-[a-z]{2,8}-/i.test(host) && host.endsWith('.bilivideo.com')) return true
    return false
}

const getFallbackCdnHost = () =>
    resolvedCdn || pageDiscoveredCdn || getCurrentCdn() || activeCdnList[0] || PREFERRED_CDN_LIST[0] || null

// PCDN 特化路徑：路徑以 /v1/resource 開頭的 MCDN / IP:Port 型連結，是 B 站專門發給
// PCDN 節點用的網址格式，缺少 trid 等參數，換掉 host 之後正規 CDN 一律拒絕
// （無法靠改 host 重組成正常的 upos 網址）。
//
// 這裡原本沒有判斷路徑，只要 host 命中 mcdn/szbdyd 就直接換 host —— 換出來的網址
// 必定失敗，播放器要等這次請求失敗、再依序去試 backup_url，起播因此多等好幾秒。
// 症狀正好是「偶爾某幾部影片點進去特別慢」（B 站分配 PCDN 是隨機的，只有被分到
// PCDN 的片子會中）。
//
// 正確處理：直接放行不改寫，讓播放器自己走它原本的 backup 流程 —— 那條路徑至少
// 網址是合法的，比我們改出一條必死的網址快得多。真正的解法是在 playurl 階段就從
// backup_url 挑一條原生 Mirror 型連結當主流（未實作，見改進工單）。
const PCDN_RESOURCE_PATH = /^\/v1\/resource/

// v1.3.3：抽成共用判斷式。守門一定要放在「所有改 host 的唯一出入口」，只在
// rewriteUnstableMediaUrl 擋一次是不夠的 —— 同一條網址走到 normalizeMediaUrl 的
// 「一般白名單」分支照樣會被改壞：/v1/resource/xxx.m4s 的路徑以 .m4s 結尾，
// isBiliFragmentUrl() 會成立，接著 needsRedirect() 也成立（PCDN host 本來就不在
// 白名單），於是又被 replaceUrlHost 改了一次。playurl 層（transformStreamItem）
// 更是完全不經過 rewriteUnstableMediaUrl，有同樣的漏洞。
// indexOf 快篩很重要：sanitizePlayInfoUrls 會走訪整包 playurl 回應的幾百個字串欄位，
// 每個都做 new URL() 成本會被放大。
const isPcdnResourceUrl = (urlStr) => {
    if (!urlStr || urlStr.indexOf('/v1/resource') === -1) return false
    try { return PCDN_RESOURCE_PATH.test(new URL(urlStr).pathname) } catch { return false }
}

const rewriteUnstableMediaUrl = (urlStr) => {
    if (!urlStr) return null
    try {
        const u = new URL(urlStr)
        if (!isUnstableCdnHost(u.hostname)) return null

        // ★ v1.3.3：PCDN 特化路徑不可改寫（見上方說明），放行並計數供診斷觀察
        if (PCDN_RESOURCE_PATH.test(u.pathname)) {
            redirectStats.pcdnSkipped++
            return null
        }

        let targetHost = getFallbackCdnHost()

        if (u.hostname.endsWith('.szbdyd.com')) {
            const usource = u.searchParams.get('xy_usource')
            if (usource) {
                let h = usource.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0]
                if (h && !isUnstableCdnHost(h) && !needsRedirect(h)) targetHost = h
            }
        }

        if (!targetHost) return null
        u.hostname = targetHost
        u.port     = ''
        return u.toString()
    } catch {
        return null
    }
}

const redirectStats = {
    unstable: 0,
    // v1.3.3：命中 /v1/resource 而「刻意不改寫」的次數。數字持續增加代表你的網路
    // 環境常被分配到 PCDN —— 這正是舊版會改壞、造成偶發起播變慢的那類連結。
    pcdnSkipped: 0,
    // 2026-08-20：這條串流「換 host 會被 403 拒絕」而刻意不改寫、也不賽馬的次數。
    // 數字 > 0 代表你遇到了 os=<節點>bv 這種綁定節點的簽名（見 hostLockedStreams）。
    hostLocked: 0,
    whitelist: 0,
    httpdns: 0,
    httpdnsAllowed: 0,
    httpdnsAutoSwitch: 0,
    quietRedirects: 0,
}

// ── Segment 位元組計數去重 ────────────────────────────────────────────
// 實測：bilivideo.com 的 m4s/flv 走 Range/206 跨源 XHR，Chrome 在這個情境下
// PerformanceResourceTiming 的 transferSize/encodedBodySize 經常回報 0（即使伺服器
// 有送 Timing-Allow-Origin），導致 Watchdog 完全抓不到下載量 → 面板永遠「緩衝 0%」、
// bps 判斷永遠對 4K 半盲、CDN 吞吐評分永遠沒有真實樣本。改為在 XHR/fetch 攔截層直接
// 用 content-length / response 大小量測真實位元組（見下方 send()/fetch() 攔截），
// PerformanceObserver 僅作為那條路徑量到值時的補位，用這組去重避免同一個 segment 被算兩次。
const segmentByteAccountedUrls = new Map()
const SEGMENT_DEDUP_WINDOW_MS = 5000
const noteSegmentAccounted = (url) => {
    if (!url) return
    const now = Date.now()
    segmentByteAccountedUrls.set(url, now)
    if (segmentByteAccountedUrls.size > 64) {
        segmentByteAccountedUrls.forEach((t, u) => {
            if (now - t > SEGMENT_DEDUP_WINDOW_MS) segmentByteAccountedUrls.delete(u)
        })
    }
}
const wasSegmentAccounted = (url) => {
    const t = url && segmentByteAccountedUrls.get(url)
    return !!t && (Date.now() - t < SEGMENT_DEDUP_WINDOW_MS)
}

// XHR 版：直接從 response 量真實位元組（content-length 優先，量不到才退回 response 大小），
// 不依賴不可靠的 PerformanceResourceTiming。同時餵給 Watchdog（面板 MB/bps 判斷）與
// recordCdnThroughput（CDN 吞吐評分），並標記去重避免 onEntry() 又重算一次。
// alreadyReportedBytes：send() 裡的 progress 事件已經即時、逐步回報過的量（見下方），
// 這裡只把「還沒被 progress 算過的尾巴」補給 Watchdog，避免同一個 segment 被算兩次；
// recordCdnThroughput 仍用完整 bytes + 真正的下載耗時（startedAt→現在）算吞吐分數。
const noteSegmentBytes = (cdn, xhr, startedAt, url, alreadyReportedBytes) => {
    if (!cdn) return
    try {
        let bytes = 0
        const cl = xhr.getResponseHeader && xhr.getResponseHeader('content-length')
        if (cl) bytes = parseInt(cl, 10) || 0
        if (!bytes) {
            try {
                const r = xhr.response
                if (r && typeof r.byteLength === 'number') bytes = r.byteLength
                else if (r && typeof r.size === 'number') bytes = r.size // Blob（responseType: 'blob'）
                else if ((xhr.responseType === '' || xhr.responseType === 'text') && typeof xhr.responseText === 'string') {
                    bytes = xhr.responseText.length
                }
            } catch {}
        }
        if (!bytes) return
        const durationMs = Math.max(1, Date.now() - startedAt)
        const remaining  = Math.max(0, bytes - (alreadyReportedBytes || 0))
        if (remaining) Watchdog.noteExternalBytes(cdn, remaining)
        recordCdnThroughput(cdn, bytes, durationMs, latestPlaybackRate)
        noteSegmentAccounted(url)
    } catch {}
}

// 緩衝目標依碼率動態調整；未知碼率時使用保守預設。
const DEFAULT_BUFFER_TARGET_BYTES = 20 * 1024 * 1024
const MIN_BUFFER_TARGET_BYTES = 16 * 1024 * 1024
const MAX_BUFFER_TARGET_BYTES = 160 * 1024 * 1024
let baseBufferTargetBytes = DEFAULT_BUFFER_TARGET_BYTES

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const setBufferTargetFromBitrate = (totalBitsPerSec, isHighBitrate) => {
    if (!totalBitsPerSec || !Number.isFinite(totalBitsPerSec)) return
    currentStreamBitsPerSec = totalBitsPerSec
    // 高碼率（4K/高 fps）多存一點，下載速度暫時掉下去也有緩衝可以撐
    const targetSeconds = isHighBitrate ? 45 : 20
    baseBufferTargetBytes = clamp(
        (totalBitsPerSec / 8) * targetSeconds,
        MIN_BUFFER_TARGET_BYTES,
        MAX_BUFFER_TARGET_BYTES
    )
}

const getBufferTargetBytes = (playbackRate) => {
    const rate = playbackRate && playbackRate > 1 ? playbackRate : 1
    return clamp(baseBufferTargetBytes * rate, MIN_BUFFER_TARGET_BYTES, MAX_BUFFER_TARGET_BYTES)
}

// ── 實際播放畫質的碼率校正（v1.3.3）───────────────────────────────────
// 問題：currentStreamBitsPerSec 過去是用 playurl 清單裡「最高畫質」的 bandwidth 設定的
// （maxV + maxA），但那不是使用者實際在看的畫質。只要這支片「有提供」4K，即使實際播
// 1080p，這個值也會是 4K 的碼率。後果是連鎖的，而且全部指向同一個方向 —— 誤判：
//
//   1. Watchdog 的 highBitrate 恆為 true → 套用 4K 專用的嚴格門檻
//      （緩衝要 30 秒才算夠、連續 2 tick 就換節點）。
//   2. minBps 直接等於 4K 碼率 ÷ 8（約 2.5~4 MB/s）。實際播 1080p 的播放器
//      穩態只會拉約 0.5 MB/s —— 永遠低於門檻，tooSlow 恆成立。
//   3. 於是每隔幾秒就觸發一次 switchCdn：把當前節點軟隔離 10 分鐘、記一次 failures、
//      清掉 probe 快取、重建連線。連續幾輪就能把手上所有好節點依序全部軟隔離掉。
//   4. 軟隔離會持續 10 分鐘、健康分數的懲罰更久 —— 所以災情會延續到「之後幾部片」，
//      表現出來就是「偶爾有幾部影片點進去特別慢」。
//
// 修法：用 <video>.videoHeight 反查對應的 representation 碼率。videoHeight 是播放器
// 實際解出來的畫面高度，切畫質、ABR 自動降級都會即時反映，比任何清單推測都準。
const syncStreamBitrateFromVideo = (videoEl) => {
    if (!streamProfile || !streamProfile.reps.length || !videoEl) return
    const h = videoEl.videoHeight || 0
    if (!h) return   // 起播初期還沒解出畫面，維持原估計值（Watchdog 此時也還在 grace 期）

    let bestDiff = Infinity, bestBps = 0
    for (const r of streamProfile.reps) {
        const diff = Math.abs(r.height - h)
        // 同一個高度可能有多個 codec（AVC/HEVC/AV1）碼率不同；取較大的那個，
        // 寧可略為高估也不要低估到讓 Watchdog 對真正的卡頓變遲鈍。
        if (diff < bestDiff || (diff === bestDiff && r.bandwidth > bestBps)) {
            bestDiff = diff
            bestBps  = r.bandwidth
        }
    }
    if (!bestBps) return

    const total = bestBps + (streamProfile.audioBps || 0)
    // 變動小於 5% 就不動，避免每秒重算緩衝目標造成 reached 狀態抖動
    if (currentStreamBitsPerSec > 0 && Math.abs(total - currentStreamBitsPerSec) < currentStreamBitsPerSec * 0.05) return
    setBufferTargetFromBitrate(total, total > 12e6)
}

// SPA 換片時呼叫：舊片的碼率不能留給新片用。從 4K 片切到低碼率片而沒重置的話，
// 新片會沿用舊片的高門檻，重演上面那串誤判；反之從低碼率切到 4K 則會反應遲鈍。
const resetStreamProfile = () => {
    // 綁定節點是「這支影片這次簽發」的性質，換片就要重新給機會，不能一路沿用
    hostLockedStreams.clear()
    streamProfile = null
    currentStreamBitsPerSec = 0
    baseBufferTargetBytes = DEFAULT_BUFFER_TARGET_BYTES
    seekGraceUntil = 0
}

// ── HTTPDNS AutoPilot：短測 10 分鐘 → 評分 → 記憶網路環境（最長 6 小時）────────
const HTTPDNS_PROFILE_KEY = 'httpdnsProfile_v2'
const HTTPDNS_STATE_KEY   = 'httpdnsAutoState_v2'
const HTTPDNS_TRIAL_MS    = 10 * 60 * 1000
const HTTPDNS_COMMIT_MS   = 6 * 60 * 60 * 1000
const HTTPDNS_PROFILE_TTL = 7 * 24 * 60 * 60 * 1000
const HTTPDNS_SCORE_MARGIN = 10   // 在新的 0~100+ 級距下 = 滿分的 10%，才有實際判斷意義

const normalizeHttpDnsMode = (mode) =>
    (mode === true || mode === false || mode === 'auto') ? mode : 'auto'

let httpDnsMode = normalizeHttpDnsMode(BlockHttpDNS)

const HttpDnsAutoPilot = (() => {
    const getNetworkKey = () => {
        const tz = (() => {
            try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown' } catch { return 'unknown' }
        })()
        const lang = (navigator.language || 'en').slice(0, 5)
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
        const type = conn ? (conn.effectiveType || conn.type || 'unknown') : 'unknown'
        const downlink = conn && conn.downlink ? String(Math.round(conn.downlink)) : 'x'
        return [tz, lang, type, downlink].join('|')
    }

    // 改成「達成率」而非絕對速度：直接用 Mbps×100 當分數時，正常 4K 播放輕鬆到 300~500 分，
    // 卡頓只扣 50 分等於總分的 10~15%——代價太便宜；而且高碼率片跟低碼率片的分數天生不可比，
    // 混在同一個 blockAvg/allowAvg 平均裡會失真。改成相對於「這支片子實際需要的速度」計算。
    const computeScore = (m) => {
        const elapsedSec = Math.max(1, m.elapsedSec || 1)
        const actualMbps = ((m.totalBytes || 0) * 8) / 1e6 / elapsedSec   // 之前誤標成 Mbps 的其實是 MiB/s
        const needMbps   = Math.max(1.5, getRequiredStreamMbps())
        // 達成率封頂 1.2（超過需求 20% 就算滿分），避免高碼率片主導平均
        const ratio = Math.min(1.2, actualMbps / needMbps)
        const score = ratio * 100
            - (m.stallEvents   || 0) * 25
            - (m.hardFailCount || 0) * 40
            - (m.switchCount   || 0) * 15
            + (m.reachedTarget ? 10 : 0)
        return Math.round(score * 10) / 10
    }

    const emptyProfile = (networkKey) => ({
        networkKey,
        blockAvg: 0,
        allowAvg: 0,
        blockSamples: 0,
        allowSamples: 0,
        decision: 'undecided',
        decisionUntil: 0,
        updatedAt: Date.now(),
    })

    const loadProfile = () => {
        const networkKey = getNetworkKey()
        try {
            const raw = JSON.parse(GM_getValue(HTTPDNS_PROFILE_KEY) || '{}')
            if (raw.networkKey === networkKey && (Date.now() - (raw.updatedAt || 0)) < HTTPDNS_PROFILE_TTL) {
                return raw
            }
        } catch {}
        return emptyProfile(networkKey)
    }

    let profile = loadProfile()

    const saveProfile = () => {
        profile.updatedAt = Date.now()
        profile.networkKey = getNetworkKey()
        try { GM_setValue(HTTPDNS_PROFILE_KEY, JSON.stringify(profile)) } catch {}
    }

    const loadAutoState = () => {
        try {
            const raw = JSON.parse(GM_getValue(HTTPDNS_STATE_KEY) || '{}')
            return {
                phase:           raw.phase || 'none',
                allowUntil:      Number(raw.allowUntil) || 0,
                trialStartedAt:  Number(raw.trialStartedAt) || 0,
                trialScore:      Number(raw.trialScore) || 0,
                lastReason:      raw.lastReason || '',
                lastChangedAt:   Number(raw.lastChangedAt) || 0,
            }
        } catch {
            return { phase: 'none', allowUntil: 0, trialStartedAt: 0, trialScore: 0, lastReason: '', lastChangedAt: 0 }
        }
    }

    let autoState = loadAutoState()

    const saveAutoState = () => {
        try { GM_setValue(HTTPDNS_STATE_KEY, JSON.stringify(autoState)) } catch {}
    }

    // 進入 trial-allow 時記錄 watchdog 累計快照，
    // 結算時用 delta 算分，避免混入 trial 之前的播放數據。
    let trialBaseline = null

    const subtractBaseline = (sample, baseline) => {
        if (!baseline) return sample
        // SPA 換片時 Watchdog.reset() 會把累計數字歸零，sample 會比換片前的 baseline 還小；
        // 相減後全部被 Math.max(0, ...) 夾成 0，trial 必定判定失敗。偵測到這種情況直接用
        // sample 原值（等於放棄扣除舊 baseline，換片後的這一小段當作獨立樣本看待）。
        if ((sample.totalBytes || 0) < (baseline.totalBytes || 0)) return sample
        return {
            totalBytes:    Math.max(0, (sample.totalBytes    || 0) - (baseline.totalBytes    || 0)),
            stallEvents:   Math.max(0, (sample.stallEvents   || 0) - (baseline.stallEvents   || 0)),
            switchCount:   Math.max(0, (sample.switchCount   || 0) - (baseline.switchCount   || 0)),
            hardFailCount: Math.max(0, (sample.hardFailCount || 0) - (baseline.hardFailCount || 0)),
            elapsedSec:    Math.max(1, (sample.elapsedSec    || 1) - (baseline.elapsedSec    || 0)),
            reachedTarget: !!sample.reachedTarget,
        }
    }

    const mergeAvg = (prevAvg, prevN, score) => {
        const n = prevN + 1
        return { avg: Math.round(((prevAvg * prevN) + score) / n * 10) / 10, n }
    }

    const recordSample = (strategy, sample) => {
        const score = computeScore(sample)
        if (strategy === 'allow') {
            const m = mergeAvg(profile.allowAvg, profile.allowSamples, score)
            profile.allowAvg = m.avg
            profile.allowSamples = m.n
        } else {
            const m = mergeAvg(profile.blockAvg, profile.blockSamples, score)
            profile.blockAvg = m.avg
            profile.blockSamples = m.n
        }
        saveProfile()
        return score
    }

    const commitDecision = (decision, reason, score) => {
        profile.decision = decision
        profile.decisionUntil = Date.now() + HTTPDNS_COMMIT_MS
        profile.updatedAt = Date.now()
        saveProfile()
        autoState = {
            phase: decision === 'allow' ? 'committed-allow' : 'none',
            allowUntil: decision === 'allow' ? profile.decisionUntil : 0,
            trialStartedAt: 0,
            trialScore: score || 0,
            lastReason: reason,
            lastChangedAt: Date.now(),
        }
        saveAutoState()
    }

    const startTrialAllow = (reason, baseline) => {
        trialBaseline = baseline ? { ...baseline } : null
        autoState = {
            phase: 'trial-allow',
            allowUntil: Date.now() + HTTPDNS_TRIAL_MS,
            trialStartedAt: Date.now(),
            trialScore: 0,
            lastReason: reason || 'playback-stall',
            lastChangedAt: Date.now(),
        }
        redirectStats.httpdnsAutoSwitch++
        saveAutoState()
        try { GM_deleteValue(PROBE_CACHE_KEY) } catch {}
    }

    const endTrialAllow = (reason, sample) => {
        const trialSample = subtractBaseline(sample, trialBaseline)
        const allowScore = recordSample('allow', trialSample)
        autoState.trialScore = allowScore
        const blockRef = profile.blockAvg || 0
        const pass = allowScore >= blockRef + HTTPDNS_SCORE_MARGIN
        if (pass) {
            commitDecision('allow', 'trial-pass:' + (reason || 'score'), allowScore)
        } else {
            commitDecision('block', 'trial-fail:' + (reason || 'score'), allowScore)
        }
        trialBaseline = null
        redirectStats.httpdnsAutoSwitch++
    }

    const isTrialAllowing = () =>
        httpDnsMode === 'auto'
        && (autoState.phase === 'trial-allow' || autoState.phase === 'committed-allow')
        && autoState.allowUntil > Date.now()

    const isProfileAllowing = () =>
        httpDnsMode === 'auto'
        && profile.decision === 'allow'
        && profile.decisionUntil > Date.now()

    const shouldBlock = () => {
        if (httpDnsMode === true) return true
        if (httpDnsMode === false) return false
        if (isTrialAllowing() || isProfileAllowing()) return false
        return true
    }

    const getStatus = () => {
        const networkKey = getNetworkKey()
        if (httpDnsMode === true) {
            return { mode: 'force-block', block: true, ttlMin: 0, networkKey, scores: { block: profile.blockAvg, allow: profile.allowAvg } }
        }
        if (httpDnsMode === false) {
            return { mode: 'force-allow', block: false, ttlMin: 0, networkKey, scores: { block: profile.blockAvg, allow: profile.allowAvg } }
        }
        const ttlMin = autoState.allowUntil > Date.now()
            ? Math.max(0, Math.ceil((autoState.allowUntil - Date.now()) / 60000))
            : (profile.decisionUntil > Date.now()
                ? Math.max(0, Math.ceil((profile.decisionUntil - Date.now()) / 60000))
                : 0)
        let mode = 'auto-block'
        if (autoState.phase === 'trial-allow' && isTrialAllowing()) mode = 'auto-trial-allow'
        else if (autoState.phase === 'committed-allow' && isTrialAllowing()) mode = 'auto-allow'
        else if (isProfileAllowing()) mode = 'auto-allow-memory'
        return {
            mode,
            block: shouldBlock(),
            ttlMin,
            reason: autoState.lastReason || profile.decision,
            networkKey,
            scores: {
                block: profile.blockAvg,
                allow: profile.allowAvg,
                blockSamples: profile.blockSamples,
                allowSamples: profile.allowSamples,
                trial: autoState.trialScore || null,
            },
            decision: profile.decision,
        }
    }

    const onStall = (reason, watchdogStats) => {
        if (httpDnsMode !== 'auto') return false
        const sample = {
            totalBytes: watchdogStats.totalBytes || 0,
            stallEvents: (watchdogStats.stallEvents || 0) + 1,
            switchCount: watchdogStats.switchCount || 0,
            hardFailCount: watchdogStats.hardFailCount || 0,
            elapsedSec: watchdogStats.elapsedSec || 1,
            reachedTarget: false,
        }
        if (isTrialAllowing()) {
            // trial 期間又卡頓：用 delta 結算 allow 分數後立刻判 block
            const trialSample = subtractBaseline(sample, trialBaseline)
            const score = recordSample('allow', trialSample)
            autoState.trialScore = score
            commitDecision('block', 'trial-stall:' + reason, score)
            trialBaseline = null
            redirectStats.httpdnsAutoSwitch++
            return true
        }
        if (shouldBlock() && redirectStats.httpdns > 0) {
            // 先把目前 block 期間累計值入帳，再以此為 baseline 啟動 trial allow
            recordSample('block', sample)
            startTrialAllow(reason, sample)
            return true
        }
        return false
    }

    const onTargetReached = (watchdogStats) => {
        if (httpDnsMode !== 'auto') return
        const sample = {
            totalBytes: watchdogStats.totalBytes || 0,
            stallEvents: watchdogStats.stallEvents || 0,
            switchCount: watchdogStats.switchCount || 0,
            hardFailCount: watchdogStats.hardFailCount || 0,
            elapsedSec: watchdogStats.elapsedSec || 1,
            reachedTarget: true,
        }
        if (autoState.phase === 'trial-allow' && autoState.trialStartedAt > 0) {
            endTrialAllow('target-reached', sample)
            return
        }
        // 非 trial：直接以 watchdog 累計值（自 start 起）做粗略 sample 記分
        recordSample(shouldBlock() ? 'block' : 'allow', sample)
    }

    const tick = (watchdogStats) => {
        if (httpDnsMode !== 'auto') return
        if (autoState.phase !== 'trial-allow') return
        if (autoState.allowUntil > Date.now()) return
        const sample = {
            totalBytes: watchdogStats.totalBytes || 0,
            stallEvents: watchdogStats.stallEvents || 0,
            switchCount: watchdogStats.switchCount || 0,
            hardFailCount: watchdogStats.hardFailCount || 0,
            elapsedSec: watchdogStats.elapsedSec || 1,
            reachedTarget: watchdogStats.reachedTarget || false,
        }
        endTrialAllow('trial-timeout', sample)
    }

    const reset = () => {
        profile = emptyProfile(getNetworkKey())
        saveProfile()
        autoState = { phase: 'none', allowUntil: 0, trialStartedAt: 0, trialScore: 0, lastReason: '', lastChangedAt: Date.now() }
        saveAutoState()
        trialBaseline = null
    }

    const setMode = (mode) => {
        httpDnsMode = normalizeHttpDnsMode(mode)
        BlockHttpDNS = httpDnsMode
        if (httpDnsMode !== 'auto') reset()
        return getStatus()
    }

    // SPA 換片時 Watchdog.reset() 會把累計數字歸零；trial-allow 期間如果不管它，
    // 下一次結算會拿「換片前的大 baseline」對「換片後才剛開始累計的小 sample」相減，
    // trial 幾乎必然被判定失敗。換片時把這場 trial 的 baseline 歸零重打、觀察窗往後
    // 延一整個 HTTPDNS_TRIAL_MS，讓新片有完整的觀察時間，而不是被腰斬。
    //
    // 但這個展延不能無上限：如果使用者一直看短片、換片間隔小於 HTTPDNS_TRIAL_MS，
    // 每次換片都會把 allowUntil 再往後推一整輪，trial-allow 可能永遠展延、永遠
    // 走不到 tick() 的逾時判斷，autopilot 對這種使用模式就永遠學不到 allow/block
    // 決策（期間會一直維持在「允許 HTTPDNS」，即使實際上該擋）。改成從「這場 trial
    // 最早開始」算起設一個總長上限，展延到頂了就讓它照原訂時間結算，用當下這小段
    // 的樣本判一次，總比永遠卡在 trial-allow 不結算好。
    const HTTPDNS_TRIAL_MAX_MS = HTTPDNS_TRIAL_MS * 3
    const onWatchdogReset = () => {
        if (autoState.phase !== 'trial-allow') return
        trialBaseline = { totalBytes: 0, stallEvents: 0, switchCount: 0, hardFailCount: 0, elapsedSec: 0 }
        const trialStart = autoState.trialStartedAt || Date.now()
        autoState.allowUntil = Math.min(Date.now() + HTTPDNS_TRIAL_MS, trialStart + HTTPDNS_TRIAL_MAX_MS)
        autoState.trialStartedAt = trialStart
        saveAutoState()
    }

    return {
        shouldBlock,
        getStatus,
        onStall,
        onTargetReached,
        tick,
        reset,
        setMode,
        onWatchdogReset,
    }
})()

const getHttpDnsStatus = () => HttpDnsAutoPilot.getStatus()
const shouldBlockHttpDns = () => HttpDnsAutoPilot.shouldBlock()
const setHttpDnsMode = (mode) => HttpDnsAutoPilot.setMode(mode)

// 重導 media segment URL（不穩定節點 → 白名單）
const normalizeMediaUrl = (urlStr) => {
    if (!urlStr) return { url: urlStr, changed: false }

    const unstableUrl = rewriteUnstableMediaUrl(urlStr)
    if (unstableUrl && unstableUrl !== urlStr) {
        redirectStats.unstable++
        let originCdn = '?', targetCdn = '?'
        try {
            originCdn = new URL(urlStr).hostname
            targetCdn = new URL(unstableUrl).hostname
        } catch {}
        logRedirect('不穩定', originCdn, targetCdn, 'MCDN/PCDN')
        return { url: unstableUrl, changed: true, originCdn, targetCdn }
    }

    if (isAkamaiUrl(urlStr)) {
        let originCdn = null
        try { originCdn = new URL(urlStr).hostname } catch {}
        if (!originCdn || !isForcedRedirect(originCdn)) return { url: urlStr, changed: false, originCdn }
        const bestCdn = getCurrentCdn()
        const newUrl = bestCdn ? replaceUrlHost(urlStr, bestCdn) : null
        if (!newUrl || newUrl === urlStr) return { url: urlStr, changed: false, originCdn }
        redirectStats.whitelist++
        logRedirect('Transport', originCdn, bestCdn, 'Akamai 失敗後改寫')
        return { url: newUrl, changed: true, originCdn, targetCdn: bestCdn }
    }

    if (!isBiliFragmentUrl(urlStr)) return { url: urlStr, changed: false }

    const originCdn = getBiliVideoCdn(urlStr)
    if (!needsRedirect(originCdn)) return { url: urlStr, changed: false, originCdn }

    // seek 期間：只改寫「必須改」的 host（排除/黑名單/死節點/不穩定），
    // 其餘 backup 先放行，避免改 host 導致 player abort 再重拉（log 裡 FragmentLoadingAbandoned 連發的主因之一）。
    if (inSeekGrace()) {
        const mustFix = matchesExclude(originCdn) || knownDeadHosts.has(originCdn)
            || blacklistSet.has(originCdn) || isUnstableCdnHost(originCdn)
            || isForcedRedirect(originCdn)
        if (!mustFix) return { url: urlStr, changed: false, originCdn }
    }

    const bestCdn = getCurrentCdn()
    if (!bestCdn || bestCdn === originCdn) return { url: urlStr, changed: false, originCdn }

    const newUrl = replaceUrlHost(urlStr, bestCdn)
    if (!newUrl || newUrl === urlStr) return { url: urlStr, changed: false, originCdn }

    redirectStats.whitelist++
    logRedirect('Transport', originCdn, bestCdn,
        blacklistSet.has(originCdn) ? '黑名單' : '非白名單')
    return { url: newUrl, changed: true, originCdn, targetCdn: bestCdn }
}

const isMediaSegmentUrl = (url) => {
    if (!url) return false
    if (isBiliFragmentUrl(url)) return true
    try {
        const u = new URL(url)
        const host = u.hostname
        if (isUnstableCdnHost(host)) return true
        // Akamai 是 Bilibili 對台灣/海外流量常見的合法 fallback CDN，不是只有被
        // isForcedRedirect 標記過才算「媒體片段」——舊判斷只在已經決定要把它改寫
        // 掉之後才承認它是 segment，導致第一次播放（尚未 forced-redirect）完全
        // 跳過 XHR/fetch 攔截層的位元組計算監聽器（見 send() 的 `if (this._originCdn)`
        // 分支）。實際影響：只要這支影片被分到 Akamai 節點，Watchdog 面板的緩衝
        // 進度條就整支片子動不了（totalMB 永遠 0），即使播放本身完全正常。
        // normalizeMediaUrl() 的 isAkamaiUrl 分支本來就只有 isForcedRedirect 才會
        // 真的改寫網址，這裡放寬只是讓「量測」對 Akamai 節點也生效，不影響改寫邏輯。
        if (host.endsWith('.akamaized.net')) {
            const path = u.pathname
            return path.endsWith('.m4s') || path.endsWith('.flv') || path.includes('/upgcxcode/')
        }
        return false
    } catch { return false }
}

// 重導向 log 節流：同 channel|origin|target 5 秒內只印一次，累計次數
const _redirectLogTs = {}
const _redirectLogTotal = {}
const REDIRECT_LOG_COOLDOWN = 5000
const QUIET_REDIRECT_AFTER = 3
const QUIET_REDIRECT_EVERY = 25
const logRedirect = (channel, originCdn, targetCdn, reason) => {
    const key = channel + '|' + (originCdn || '?') + '|' + targetCdn
    const now = Date.now()
    const last = _redirectLogTs[key] || 0
    const total = (_redirectLogTotal[key] || 0) + 1
    _redirectLogTotal[key] = total
    if (channel === 'Transport' && total > QUIET_REDIRECT_AFTER && total % QUIET_REDIRECT_EVERY !== 0) {
        redirectStats.quietRedirects++
        return
    }
    if (now - last < REDIRECT_LOG_COOLDOWN) return
    _redirectLogTs[key] = now
    // 這行原本漏掉了：整個函式維護了節流狀態（_redirectLogTs / _redirectLogTotal）、
    // 累計了 quietRedirects，卻從來沒有真的輸出過任何東西 —— 上面所有機制等於空轉，
    // reason 參數也完全沒被用到。log() 本身受 Config.verbose 控制，預設靜音，
    // 只有使用者主動 BiliCDN.verbose(true) 排查時才會出現。
    log('[' + channel + '] ' + String(originCdn || '?').split('.')[0]
        + ' → ' + String(targetCdn || '?').split('.')[0]
        + '（' + reason + '，累計 ' + total + ' 次）')
}

// 非白名單 / 已黑名單 / 命中排除關鍵字 → 重導向
const needsRedirect = (cdn) => {
    if (!cdn) return false
    if (matchesExclude(cdn)) return true
    if (isForcedRedirect(cdn)) return true
    return knownDeadHosts.has(cdn) || blacklistSet.has(cdn) || isCdnStronglyBad(cdn) || !PREFERRED_CDN_LIST.includes(cdn)
}

// ── 綁定節點的串流（host-locked）────────────────────────────────────
// 有些 playurl 簽發的網址是**綁定特定節點**的：URL 上會帶 `os=<節點>bv`（例如 os=cosovbv），
// 換掉 host 之後**每一台都回 403**。使用者 2026-08-20 實測回報的就是這種串流：
// 賽馬把同一條 URL 換到 aliov / ali / cosov 三台，三台全部 403；而正常播放的改寫同樣會
// 403，播放器只能一路重試 backup_url —— 表現出來就是「十分不穩定」。
//
// 沒有辦法在**事前**可靠地判斷（實測過 os= 不同值時換 host 是可行的，並非全部綁定），
// 所以改成**學習**：任何一次「換 host 之後拿到 403」就把這條串流登記起來，
// 之後對它完全不改寫、也不賽馬，交還播放器用 B 站原本給的網址跑。
//
// key 優先用 `os` 參數（同一支影片的各種畫質共用同一個 os，一次學習全部適用），
// 沒有 os 就退回 pathname。SPA 換片時清空（新影片要重新給機會）。
const hostLockedStreams = new Set()
const streamLockKey = (urlStr) => {
    try {
        const u = new URL(urlStr)
        return u.searchParams.get('os') || u.pathname
    } catch { return String(urlStr) }
}
const isHostLockedStream = (urlStr) => {
    if (!hostLockedStreams.size || !urlStr) return false
    return hostLockedStreams.has(streamLockKey(urlStr))
}
const noteHostLockedStream = (urlStr) => {
    const k = streamLockKey(urlStr)
    if (!k || hostLockedStreams.has(k)) return false
    hostLockedStreams.add(k)
    redirectStats.hostLocked = (redirectStats.hostLocked || 0) + 1
    log('[綁定節點] 這條串流換 host 會被拒絕（403），之後不再改寫也不賽馬：' + k)
    return true
}

const replaceUrlHost = (urlStr, targetHost) => {
    if (!urlStr || (!isBiliVideoUrl(urlStr) && !isAkamaiUrl(urlStr))) return null
    // ★ v1.3.3：PCDN 特化路徑一律不改 host（見 isPcdnResourceUrl 說明）。
    // 擋在這裡，playurl 層（transformStreamItem / buildBackupUrls / sanitizePlayInfoUrls）
    // 與 Transport 層（normalizeMediaUrl）就全部一次涵蓋，不會再有漏網分支。
    if (isPcdnResourceUrl(urlStr)) return null
    // ★ 綁定節點的串流一律不改 host（見 hostLockedStreams 說明）。跟 PCDN 守門放在同一處，
    // 理由也一樣：這裡是所有改 host 的唯一出入口，擋在這裡就不會有漏網分支。
    if (isHostLockedStream(urlStr)) return null
    const host = targetHost || getCurrentCdn()
    if (!host) return null
    try {
        const u = new URL(urlStr)
        if (u.hostname === host) return urlStr
        u.hostname = host
        u.port     = ''
        return u.toString()
    } catch {
        return urlStr.replace(/https?:\/\/[^/]+\//, 'https://' + host + '/')
    }
}

// 建構 backup_url 陣列（Akamai 為主時也保留，player primary fail 才切）
const buildBackupUrls = (biliSrcUrl) => {
    if (!biliSrcUrl || !isBiliVideoUrl(biliSrcUrl)) return []
    if (resolvedCdn) {
        const u = replaceUrlHost(biliSrcUrl, resolvedCdn)
        return u ? [u] : []
    }
    let primaryHost
    try { primaryHost = new URL(biliSrcUrl).hostname } catch { primaryHost = '' }
    // backup 也用起播模式：主流失敗時會直接切到這裡，同樣禁不起「探索中獎」。
    return getHealthyCdnList(STARTUP_PICK)
        .filter(cdn => cdn !== primaryHost)
        .filter(cdn => !matchesExclude(cdn) && !knownDeadHosts.has(cdn) && !blacklistSet.has(cdn))
        .slice(0, 2)
        .map(cdn => replaceUrlHost(biliSrcUrl, cdn))
        .filter(Boolean)
}

// B 站長片/4K 有時會在深層欄位保留原始 backup URL；
// seek 到未載入區段時 player 會直接拿那些 URL 打，導致 Transport 連續補救。
const sanitizePlayInfoUrls = (root) => {
    const seen = new WeakSet()
    let changed = 0

    const rewrite = (value) => {
        if (typeof value !== 'string' || value.length < 12) return value
        // 便宜快篩：不含 bilivideo 就一定用不到，省下 isBiliVideoUrl/getBiliVideoCdn 裡的 new URL()。
        // playurl 回應在 4K 多畫質 + 多 backup 時可能有幾百個字串欄位，這個成本會被放大。
        if (value.indexOf('.bilivideo.') === -1) return value
        if (!isBiliVideoUrl(value) || isAkamaiUrl(value)) return value
        const host = getBiliVideoCdn(value)
        if (!needsRedirect(host)) return value
        const next = replaceUrlHost(value)
        if (next && next !== value) {
            changed++
            return next
        }
        return value
    }

    const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (seen.has(node)) return
        seen.add(node)

        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                if (typeof node[i] === 'string') node[i] = rewrite(node[i])
                else walk(node[i])
            }
            return
        }

        Object.keys(node).forEach(k => {
            const value = node[k]
            if (typeof value === 'string') node[k] = rewrite(value)
            else walk(value)
        })
    }

    walk(root)
    return changed
}

// 純函式：從 playurl API 回傳的 dash/durl item 找出候選網址（不含任何副作用/模組狀態，
// 只靠 isAkamaiUrl/isBiliVideoUrl 兩個同樣是純函式的判斷式）。改進工單 E：Bilibili 改版
// 最容易壞的就是這裡的欄位形狀（base_url/baseUrl、backup_url/backupUrl 是否為陣列、
// 是否存在），特地切成純函式，改版後能直接用單元測試 3 秒內確認沒把 dash/durl 其中一種
// 格式弄壞，不用等真的連上 Bilibili 播放才發現。
const pickStreamUrls = (item, isDash) => {
    if (!item) return { validUrls: [], akamaiUrl: undefined, biliSrcUrl: undefined, highBitrateItem: false, preferWhitelistPrimary: false }
    const rawUrls = isDash
        ? [item.base_url, item.baseUrl]
            .concat(Array.isArray(item.backup_url) ? item.backup_url : [])
            .concat(Array.isArray(item.backupUrl) ? item.backupUrl : [])
        : [item.url]
            .concat(Array.isArray(item.backup_url) ? item.backup_url : [])
            .concat(Array.isArray(item.backupUrl) ? item.backupUrl : [])

    const validUrls  = rawUrls.filter(u => u && typeof u === 'string')
    const akamaiUrl  = validUrls.find(isAkamaiUrl)
    // v1.3.3：挑「要拿來改 host 的來源」時分兩段挑，對應社群整理的處理順序
    // （先找備援裡現成的 Mirror 型，找不到才退而求其次去改 host）：
    //   第一順位：不是 PCDN 特化路徑、host 也不是 MCDN/BCache 的 —— 這就是 Mirror 型，
    //             改 host 最安全，而且往往 backup_url 裡本來就有一條現成的。
    //   第二順位：至少路徑可改寫的（例如 BCache 型，改 host 是有效的）。
    // 兩者都沒有（整包只剩 /v1/resource 的 PCDN 特化網址）→ undefined，
    // transformStreamItem 就整個不動這個 item，讓播放器照它原本的流程走。
    const isRewritable = (u) => isBiliVideoUrl(u) && !isPcdnResourceUrl(u)
    const biliSrcUrl =
        validUrls.find(u => {
            if (!isRewritable(u)) return false
            try { return !isUnstableCdnHost(new URL(u).hostname) } catch { return false }
        })
        || validUrls.find(isRewritable)
    const highBitrateItem = isDash && ((item.bandwidth || 0) > 12e6 || (item.height || 0) >= 2160)
    const preferWhitelistPrimary = highBitrateItem && biliSrcUrl

    return { validUrls, akamaiUrl, biliSrcUrl, highBitrateItem, preferWhitelistPrimary }
}

// 改寫 dash/durl item 的 base_url + backup_url
// 4K/高碼率：白名單 CDN 為主、Akamai 放 backup，避免首段大 fragment 卡在單一 Akamai。
// 一般碼率：來源含 Akamai 時仍優先 Akamai，純 bilivideo 則換成最佳白名單。
const transformStreamItem = (item, isDash) => {
    if (!item) return false
    isDash = isDash !== false

    const { validUrls, akamaiUrl, biliSrcUrl, preferWhitelistPrimary } = pickStreamUrls(item, isDash)

    validUrls.forEach(u => {
        try {
            const h = new URL(u).hostname
            if (!isUnstableCdnHost(h) && (h.endsWith('.bilivideo.com') || h.endsWith('.bilivideo.cn'))) {
                noteDiscoveredCdn(h)
            }
        } catch {}
    })

    if (!akamaiUrl && biliSrcUrl) {
        try {
            const srcHost = new URL(biliSrcUrl).hostname
            noteDiscoveredCdn(srcHost)
        } catch {}
    }

    if (akamaiUrl) {
        noteAkamaiHost(akamaiUrl)
    }

    if (akamaiUrl && !preferWhitelistPrimary) {
        if (isDash) { item.base_url = akamaiUrl; item.baseUrl = akamaiUrl }
        else         { item.url = akamaiUrl }
        // v1.3.3：buildBackupUrls 可能回空陣列（沒有可用的白名單候選、或來源是
        // 不可改寫的 PCDN 特化網址）。舊寫法會直接把空陣列蓋上去，等於把 B 站原本
        // 給的備援流全部刪掉 —— 主流一失敗就無路可退。空的就不動。
        const backups = buildBackupUrls(biliSrcUrl)
        if (backups.length) {
            item.backup_url = backups
            item.backupUrl  = backups
        }
    } else if (biliSrcUrl) {
        // v1.3.3：這裡就是「使用者剛點進影片、正要起播」的那一刻，
        // 用 exploit 模式挑節點，不讓 UCB 的探索加成拿起播當賭注。
        const bestCdn = getCurrentCdn(STARTUP_PICK)
        const primUrl = bestCdn ? replaceUrlHost(biliSrcUrl, bestCdn) : biliSrcUrl
        if (primUrl) {
            if (isDash) { item.base_url = primUrl; item.baseUrl = primUrl }
            else         { item.url = primUrl }
        }
        // v1.3.3：同上，空陣列不覆蓋（見 Akamai 分支的說明）。
        const backups = buildBackupUrls(primUrl || biliSrcUrl)
        if (akamaiUrl && !backups.includes(akamaiUrl)) {
            backups.unshift(akamaiUrl)
        }
        if (backups.length) {
            item.backup_url = backups
            item.backupUrl  = backups
        }
    } else {
        return false
    }

    return !!akamaiUrl
}

const normalizeCodecName = (item) => {
    const codec = String((item && (item.codecs || item.codec || item.mime_type || item.mimeType)) || '').toLowerCase()
    const codecid = Number(item && (item.codecid || item.codec_id || item.codecId))
    if (codec.includes('av01') || codecid === 13) return 'av1'
    if (codec.includes('hev1') || codec.includes('hvc1') || codecid === 12) return 'hevc'
    if (codec.includes('avc1') || codecid === 7) return 'avc'
    return 'other'
}

// HEVC/AV1 能不能播（canPlayType/isTypeSupported）不等於「播得順不順」——很多 Windows
// 機器沒有 HEVC 硬體解碼，4K HEVC 軟解會讓 CPU 吃滿掉幀，體感比直接看 AVC 還差。
// Media Capabilities API 的 powerEfficient 是「是否硬體解碼」最好的間接指標（2020 起
// Baseline widely available）。全新瀏覽器 profile 第一次查詢會樂觀回報 true，所以這只能
// 當「比現在好很多」的啟發式，不是 100% 準確——沒有查到結果時一律樂觀當硬解，
// 維持跟現在一樣的排序，避免冷啟動時卡住或誤判。
const codecCapability = new Map()   // 'hevc-2160' -> MediaCapabilitiesDecodingInfo
const CODEC_PROBE_STRING = { hevc: 'hev1.1.6.L93.B0', av1: 'av01.0.05M.08', avc: 'avc1.640028' }
const probeCodecCapability = async (kind, height) => {
    const key = kind + '-' + height
    if (codecCapability.has(key)) return codecCapability.get(key)
    let result = { supported: true, smooth: true, powerEfficient: true }
    try {
        if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
            result = await navigator.mediaCapabilities.decodingInfo({
                type: 'media-source',
                video: {
                    contentType: 'video/mp4; codecs="' + CODEC_PROBE_STRING[kind] + '"',
                    width: height >= 2160 ? 3840 : 1920,
                    height,
                    bitrate: height >= 2160 ? 15e6 : 4e6,
                    framerate: 30,
                },
            })
        }
    } catch {}
    codecCapability.set(key, result)
    return result
}
// decodingInfo() 是非同步的，但 codecRank 是同步呼叫（playurl 到達時要立刻排序），來不及等。
// document-start 就先對常見組合預熱，playurl 到達時通常已經有結果可讀；沒有的話樂觀當硬解。
;['hevc', 'av1'].forEach(kind => {
    [1080, 2160].forEach(h => { probeCodecCapability(kind, h).catch(() => {}) })
})

const canPlayDashVideoItem = (() => {
    const cache = {}
    let testVideo = null

    const canPlayCodecString = (codec) => {
        if (!codec) return null
        const key = codec.toLowerCase()
        if (key in cache) return cache[key]
        const mime = 'video/mp4; codecs="' + codec + '"'
        let ok = false
        try {
            const MS = unsafeWindow.MediaSource || (typeof MediaSource !== 'undefined' ? MediaSource : null)
            ok = !!(MS && MS.isTypeSupported && MS.isTypeSupported(mime))
        } catch {}
        if (!ok) {
            try {
                if (!testVideo) testVideo = document.createElement('video')
                ok = !!(testVideo.canPlayType && testVideo.canPlayType(mime))
            } catch {}
        }
        cache[key] = ok
        return ok
    }

    return (item) => {
        const kind = normalizeCodecName(item)
        const codec = item && (item.codecs || item.codec)
        const explicit = canPlayCodecString(codec)
        if (explicit !== null) return explicit
        if (kind === 'av1') return false
        return true
    }
})()

const normalizeDashCodecPreference = (dash) => {
    if (!dash || !Array.isArray(dash.video) || PreferredVideoCodec === 'auto') return

    const codecRank = (item) => {
        const kind = normalizeCodecName(item)
        if (PreferredVideoCodec === 'avc') {
            if (kind === 'avc') return 0
            if (kind === 'hevc') return 1
            if (kind === 'av1') return 2
            return 3
        }
        // 'hevc' 模式：非硬解的 HEVC/AV1 一律降到 AVC 之後——省頻寬的前提是硬解，
        // 軟解 4K HEVC 反而比直接看 AVC 還卡。沒探測到結果（cap 為 undefined）時
        // 樂觀當硬解，維持原本的排序，不因為冷啟動而卡住起播。
        const heightKey = ((item && item.height) || 0) >= 2160 ? 2160 : 1080
        const cap = codecCapability.get(kind + '-' + heightKey)
        const hw  = !cap || cap.powerEfficient !== false
        if (kind === 'hevc') return hw ? 0 : 2
        if (kind === 'avc')  return 1
        if (kind === 'av1')  return hw ? 1.5 : 3
        return 4
    }

    const groups = []
    const byQuality = new Map()
    dash.video.forEach((item, originalIndex) => {
        const quality = String(item && (item.id || item.quality || item.qn || originalIndex))
        if (!byQuality.has(quality)) {
            const group = { quality, items: [] }
            byQuality.set(quality, group)
            groups.push(group)
        }
        byQuality.get(quality).items.push({ item, originalIndex })
    })

    const normalized = []
    groups.forEach(group => {
        let entries = group.items
        const supported = entries.filter(entry => canPlayDashVideoItem(entry.item))
        if (supported.length) entries = supported
        entries.sort((a, b) => {
            const rankDiff = codecRank(a.item) - codecRank(b.item)
            return rankDiff || (a.originalIndex - b.originalIndex)
        })
        entries.forEach(entry => normalized.push(entry.item))
    })

    if (normalized.length) dash.video = normalized
}

// 處理整個 playInfo（dash / durl / durls 三種格式）
const playInfoTransformer = (playInfo) => {
    if (!playInfo) return
    if (playInfo.code !== undefined && playInfo.code !== 0) {
        return
    }

    // 三個呼叫端都不接回傳值，原本回傳的 { total, akamai } 只是白算一輪。
    // 只保留真正需要的副作用：逐個 item 改寫。
    const transformList = (list, isDash) => {
        if (!Array.isArray(list)) return
        list.forEach(item => transformStreamItem(item, isDash))
    }

    let video_info
    if (playInfo.result) {
        video_info = playInfo.result.dash === undefined ? playInfo.result.video_info : playInfo.result
        if (!video_info || !video_info.dash) {
            if (playInfo.result.durl || playInfo.result.durls) video_info = playInfo.result
            if (video_info && video_info.durl)  video_info.durl.forEach(i => transformStreamItem(i, false))
            if (video_info && video_info.durls) video_info.durls.forEach(d => d.durl && d.durl.forEach(i => transformStreamItem(i, false)))
            sanitizePlayInfoUrls(video_info || playInfo.result)
            return
        }
    } else {
        video_info = playInfo.data
    }

    try {
        const dash = video_info && video_info.dash
        if (dash) {
            normalizeDashCodecPreference(dash)

            // 只動 minBufferTime；不能加 maxBufferLength —
            // 4K AV1 + FLAC 設大會觸發 SourceBuffer QuotaExceeded → DecodeError 6003
            // 4K/高碼率用 2s：4.0 會讓 seek 後多等 ~2s 才開播（長片拖曳特明顯）
            try {
                const vids = (dash.video || [])
                const auds = (dash.audio || [])
                const maxV = vids.reduce((m, v) => Math.max(m, v.bandwidth || 0), 0)
                const maxA = auds.reduce((m, a) => Math.max(m, a.bandwidth || 0), 0)
                const is4K = vids.some(v => (v.height || 0) >= 2160 || (v.bandwidth || 0) > 12e6)
                // 4K：首播先讓畫面更快進入 canplay；穩定度交給 Watchdog/HEVC/CDN 切換處理。
                const minBuf = is4K ? 1.0 : 3.0
                // v1.3.3：記下完整畫質清單，讓 Watchdog 之後能用實際播放的畫質校正碼率
                // （見 syncStreamBitrateFromVideo）。這裡的 maxV 只當起播前的初估值，
                // 起播那 3~5 秒 Watchdog 本來就在 grace 期不判定，校正得及。
                streamProfile = {
                    reps: vids
                        .map(v => ({ height: v.height || 0, bandwidth: v.bandwidth || 0 }))
                        .filter(r => r.bandwidth > 0 && r.height > 0),
                    audioBps: maxA,
                }
                setBufferTargetFromBitrate(maxV + maxA, is4K || (maxV + maxA) > 12e6)
                dash.minBufferTime   = minBuf
                dash.min_buffer_time = minBuf
            } catch {}

            const extras = []
            if (dash.flac  && dash.flac.audio)  [].concat(dash.flac.audio).forEach(i  => extras.push(i))
            if (dash.dolby && dash.dolby.audio)  [].concat(dash.dolby.audio).forEach(i => extras.push(i))

            transformList(dash.video, true)
            transformList(dash.audio, true)
            transformList(extras,     true)
            sanitizePlayInfoUrls(dash)

            // 拿一條真實視訊 segment 當賽馬樣本（純 bilivideo 來源時才跑；Akamai 為主不適用）
            try {
                const sample = dash.video && dash.video[0] && (dash.video[0].base_url || dash.video[0].baseUrl)
                if (sample && isBiliVideoUrl(sample) && !isAkamaiUrl(sample)) scheduleBakeoff(sample)
            } catch {}

        } else if (video_info && video_info.durl) {
            video_info.durl.forEach(i => transformStreamItem(i, false))
            sanitizePlayInfoUrls(video_info)
        }
    } catch (e) {
        if (video_info && video_info.durl) video_info.durl.forEach(i => transformStreamItem(i, false))
        else err('playInfoTransformer 例外：', e)
    }
}

// 是否為影片 m4s / flv segment
const isBiliFragmentUrl = (url) => {
    if (!url || !isBiliVideoUrl(url)) return false
    try {
        const path = new URL(url).pathname
        return path.endsWith('.m4s') || path.endsWith('.flv') || path.includes('/upgcxcode/')
    } catch {
        return /bilivideo\.com|bilivideo\.cn/.test(url) &&
               (url.includes('.m4s') || url.includes('.flv') || url.includes('/upgcxcode/'))
    }
}

// ── Network 攔截（XHR + Fetch）─────────────────────────────────────────
// 兩層攔截：
//   1. playurl API 層 (XHR responseText/response、Fetch response) → 改寫 base_url + backup_url
//   2. Transport 層 (m4s/flv segment) → 非白名單/黑名單 CDN 即時改寫成最佳白名單
const interceptNetResponse = (function (theWindow) {
    const interceptors = []
    const interceptNetResponse = (handler) => interceptors.push(handler)
    // v1.3.4：handler 的例外必須就地吃掉。這個函式是從 responseText / response 的
    // **getter** 裡呼叫的——一旦讓例外往外傳，播放器讀一次屬性就等於踩到一次
    // `throw`，playurl 根本解不出來，整支影片直接不能播。任何改寫失敗都應該
    // 退化成「不改寫」，而不是「讓頁面壞掉」。
    const handleInterceptedResponse = (response, url) =>
        interceptors.reduce((m, h) => {
            let r
            try { r = h(m, url) } catch (e) { err('攔截器例外，略過此次改寫：', e); return m }
            return r !== undefined ? r : m
        }, response)

    // playurl 回應的改寫成本不低（JSON.parse → sanitizePlayInfoUrls 走訪整包幾百個字串
    // 欄位 → JSON.stringify；4K 多畫質 + 多 backup 的回應可以到幾百 KB），而
    // responseText / response 是 **getter** —— 播放器每讀一次屬性就整套重跑一次。
    // 兩個後果都不能接受：
    //   1. 速度：這段完全落在起播的關鍵路徑上（playurl 到手到第一個 segment 發出之間），
    //      讀兩次就是兩倍成本，而播放器「先看長度／try 一次 parse／再正式 parse」這種
    //      多次讀取的寫法非常常見。
    //   2. 正確性：redirectStats 的計數（含診斷面板拿來判讀的 pcdnSkipped）會按
    //      「被讀幾次」而不是「有幾包回應」累加，被不明倍率灌水，失去判讀價值。
    // 以「原始值」當 key 記憶化：同一個 XHR 實例、同一份原始回應只轉換一次。
    // responseText 與 response 各自存一格——它們可能被交替讀取，共用一格會互相沖掉，
    // 反而每次都 miss。
    const transformPlayurlOnce = (xhr, kind, raw) => {
        const key    = '_biliPlayurlCache_' + kind
        const cached = xhr[key]
        if (cached && cached.raw === raw) return cached.out
        const out = handleInterceptedResponse(raw, xhr._interceptUrl || xhr.responseURL)
        try { xhr[key] = { raw, out } } catch {}
        return out
    }

    // ── XHR ──────────────────────────────────────────────────
    const OriginalXMLHttpRequest = theWindow.XMLHttpRequest
    class XMLHttpRequest extends OriginalXMLHttpRequest {
        open(method, url, ...rest) {
            const urlStr = String(url)
            this._biliJsonMetadata = isBiliJsonMetadataApi(urlStr)

            if (disabled) {
                this._interceptUrl = urlStr
                return super.open(method, url, ...rest)
            }

            // HTTPDNS 依 true / false / auto 判斷是否直接 abort
            if (isHttpDnsUrl(urlStr) && shouldBlockHttpDns()) {
                this._blockAbort   = true
                this._interceptUrl = urlStr
                redirectStats.httpdns++
                return super.open(method, urlStr, ...rest)
            }
            if (isHttpDnsUrl(urlStr)) {
                redirectStats.httpdnsAllowed++
            }

            if (!disabled && isMediaSegmentUrl(urlStr)) {
                const norm = normalizeMediaUrl(urlStr)
                this._originCdn = norm.originCdn || getBiliVideoCdn(urlStr)
                if (norm.changed) {
                    this._redirectedCdn = norm.targetCdn
                    url = norm.url
                }
            }

            this._interceptUrl = String(url)
            return super.open(method, url, ...rest)
        }

        // v1.3.4：HTTPDNS 阻擋不再補送 error 事件，改成合成一個 503 JSON 回應。
        //
        // v1.3.3 曾為了「別讓呼叫端空等自己的逾時」而補送 error → loadend。實機證實
        // 那是噪音來源：B 站的請求層收到 error 事件就 `reject()`（不帶參數），而那條
        // promise 沒有 .catch()，於是 console 每次都留下一行
        // `Uncaught (in promise) undefined`，堆疊還指回我們的 send()。
        //
        // 阻擋 HTTPDNS 的目的是讓它退回系統 DNS，不是在使用者的 console 留紅字——
        // 阻擋機制本身不該成為噪音來源。fetch 那條路（見下方 theWindow.fetch）早就是
        // 這個結論、合成 503 JSON 回應；XHR 這條當時漏掉了，現在補齊，兩條路一致：
        // 對呼叫端而言這是一次「伺服器回了 503」的**正常完成**，不是網路錯誤，
        // 檢查 status 的會走錯誤分支，直接 parse body 的也解得出東西（不會二次拋錯）。
        //
        // 完全不呼叫 super.send()，所以不會有任何真實請求、network entry 或 console 輸出；
        // 也不再呼叫 abort()（在合成的 load 之後補一個 abort 事件只會讓呼叫端更混亂）。
        _deliverBlockedHttpDns() {
            const body = '{"code":-1,"message":"blocked by BiliCDN","data":null}'
            this._blockedBody = body
            setTimeout(() => {
                // 旗標在派送事件的同一刻才立起來：在那之前呼叫端讀到的 readyState
                // 仍是原生的 OPENED(1)，不會出現「還沒收到回應卻已經是 DONE」的矛盾狀態。
                this._blockedDone = true
                try {
                    // 只用 dispatchEvent：onreadystatechange / onload / onloadend 是事件處理器
                    // IDL 屬性，本來就會被 dispatchEvent 一併呼叫，額外手動呼叫等於觸發兩次。
                    this.dispatchEvent(new Event('readystatechange'))
                    const detail = { lengthComputable: true, loaded: body.length, total: body.length }
                    this.dispatchEvent(new ProgressEvent('load', detail))
                    this.dispatchEvent(new ProgressEvent('loadend', detail))
                } catch (e) { err('HTTPDNS 阻擋回應派送失敗：', e) }
            }, 0)
        }
        // 合成回應期間，這些屬性都要自圓其說——呼叫端讀到「readyState 4 + status 503 +
        // 一份合法 JSON」才會當成正常完成的請求。未被阻擋時一律走原生實作。
        get readyState()  { return this._blockedDone ? 4 : super.readyState }
        get status()      { return this._blockedDone ? 503 : super.status }
        get statusText()  { return this._blockedDone ? 'Service Unavailable' : super.statusText }
        get responseURL() { return this._blockedDone ? (this._interceptUrl || '') : super.responseURL }
        getResponseHeader(name) {
            if (!this._blockedDone) return super.getResponseHeader(name)
            return String(name).toLowerCase() === 'content-type' ? 'application/json' : null
        }
        getAllResponseHeaders() {
            return this._blockedDone ? 'content-type: application/json\r\n' : super.getAllResponseHeaders()
        }

        send(...args) {
            if (this._biliJsonMetadata && !disabled) {
                try { this.setRequestHeader('Accept', 'application/json, text/plain, */*') } catch {}
            }

            if (this._blockAbort) {
                this._deliverBlockedHttpDns()
                return
            }

            // 只在真正的網路錯誤（error 事件）或 4xx/5xx 計失敗
            // status=0 多半是 player 主動 abort（seek/換畫質），不計失敗
            if (this._originCdn) {
                const cdn  = this._redirectedCdn || this._originCdn
                const self = this
                const segStartedAt = Date.now()
                let firstByteAt = 0
                let progressEvents = 0
                let aborted = false
                let lastProgressLoaded = 0
                this.addEventListener('abort', () => { aborted = true })
                this.addEventListener('error', () => {
                    if (aborted) return
                    recordCdnFailure(cdn)
                    // v1.3.3：一個位元組都沒收到的 error = 連線層失敗（多半是 DNS）。
                    // 軟隔離兩分鐘不足以避開它，交給 handleSegmentConnError 確認後標死。
                    handleSegmentConnError(cdn, lastProgressLoaded)
                })
                // XHR 的 'load'/readystatechange DONE 要等整包下載完才觸發，大 segment（4K/
                // 無損）下載期間 Watchdog 完全看不到進度，容易在中段誤判「好幾秒 0 位元組」。
                // 用 progress 事件的累計 loaded 算出每次的增量，即時餵給 Watchdog，
                // 讓面板/停滯偵測看到的下載節奏跟真實網路一致。
                this.addEventListener('progress', (e) => {
                    if (aborted) return
                    if (!firstByteAt) firstByteAt = Date.now()   // 純傳輸時間的起點，扣掉連線/排隊的 TTFB
                    progressEvents++
                    const loaded = (e && e.loaded) || 0
                    const delta = loaded - lastProgressLoaded
                    if (delta > 0) {
                        lastProgressLoaded = loaded
                        Watchdog.noteExternalBytes(cdn, delta)
                        // 邊下載邊刷新去重標記（而不是只在下載完當下標一次）：
                        // 大 segment 下載期間，PerformanceObserver 的 resource-timing entry
                        // 理論上要等整包傳完才會送達，但送達時機沒有跟我們的量測同步保證，
                        // 持續刷新能避免「量測還沒完成、entry 卻先到」造成 onEntry() 重複入帳，
                        // 也避免下載耗時超過去重視窗（5s）導致標記提早過期。
                        noteSegmentAccounted(self._interceptUrl)
                    }
                })
                this.addEventListener('readystatechange', function () {
                    if (self.readyState !== XMLHttpRequest.DONE) return
                    if (aborted) return
                    if (HARD_FAIL_STATUSES.has(self.status)) {
                        // 我們**改寫過**的 segment 拿到 403 = 這條串流很可能綁定節點。
                        // 登記之後 replaceUrlHost() 就不再改寫它，播放器改用 B 站原本
                        // 給的網址，不必再一路重試 backup_url（那正是「很不穩定」的來源）。
                        // 只在有改寫時才登記：沒改寫過的 403 是節點自己的問題，不是綁定。
                        if (self.status === 403 && self._redirectedCdn) {
                            noteHostLockedStream(self._interceptUrl)
                        }
                        recordCdnFailure(cdn, true, self.status)
                    } else if (self.status >= 500) {
                        recordCdnFailure(cdn, false, self.status)
                    } else if (self.status >= 200 && self.status < 400) {
                        recordCdnSuccess(cdn)
                        // 只有觀察到 ≥2 次 progress（真的分批收到）才信任「扣掉 TTFB」的起點；
                        // 小 segment 常常一個 read 就整包到齊，firstByteAt 幾乎等於下載完成時間，
                        // 相減會逼近 0ms，Math.max(1,...) 的下限反而把 Mbps 撐爆成離譜的天文數字。
                        // 這種情況退回含 TTFB 的完整耗時，寧可略為低估也不要產生失真的極端值。
                        const durationBase = progressEvents >= 2 ? (firstByteAt || segStartedAt) : segStartedAt
                        noteSegmentBytes(cdn, self, durationBase, self._interceptUrl, lastProgressLoaded)
                    }
                })
            }

            return super.send(...args)
        }

        get responseText() {
            if (this._blockedDone) return this._blockedBody
            if (this.readyState !== this.DONE) return super.responseText
            if (disabled) return super.responseText
            if (!isPlayUrlApi(this._interceptUrl || this.responseURL)) return super.responseText
            return transformPlayurlOnce(this, 'text', super.responseText)
        }
        get response() {
            if (this._blockedDone) {
                // responseType='json' 的呼叫端要拿到已解析的物件，不是字串（同 R-4 第 2 點）。
                if (this.responseType === 'json') {
                    try { return JSON.parse(this._blockedBody) } catch { return null }
                }
                return this.responseType === '' || this.responseType === 'text' ? this._blockedBody : null
            }
            if (this.readyState !== this.DONE) return super.response
            if (disabled) return super.response
            if (!isPlayUrlApi(this._interceptUrl || this.responseURL)) return super.response
            return transformPlayurlOnce(this, 'response', super.response)
        }
    }
    theWindow.XMLHttpRequest = XMLHttpRequest

    // ── Fetch ────────────────────────────────────────────────
    const OriginalFetch = theWindow.fetch
    theWindow.fetch = (input, init) => {
        if (disabled) return OriginalFetch(input, init)
        const urlStr = (input instanceof Request) ? input.url : String(input)

        if (isHttpDnsUrl(urlStr) && shouldBlockHttpDns()) {
            redirectStats.httpdns++
            // ★ 不能用 Promise.reject()。我們**不控制呼叫端**——B 站的 HTTPDNS 客戶端
            // 若沒有 .catch()，被拒絕的 promise 就會變成 console 上一行
            // `Uncaught (in promise) DOMException: BiliCDN blocked httpdns`。
            // 「阻擋 HTTPDNS」的目的是讓它走系統 DNS，不是在使用者的 console 留下紅字；
            // 阻擋機制本身不該成為噪音來源（跟探測路徑改用 /crossdomain.xml 同一個原則）。
            //
            // fetch 沒有「不 reject 的網路錯誤」可用（那是 fetch 的語意），所以改成
            // **合成一個失敗回應**：503 + 合法 JSON body。這同時滿足兩種常見的客戶端寫法：
            // 檢查 res.ok 的會走錯誤分支，直接 res.json() 的也解得出東西（不會二次拋錯）。
            // 合成的 Response 沒有經過網路層，瀏覽器不會有任何 network entry 或 console 輸出。
            // 對照組：XHR 那條路是補送 error + loadend 事件（XHR 的 error 事件本來就不印紅字）。
            try {
                return Promise.resolve(new Response(
                    '{"code":-1,"message":"blocked by BiliCDN","data":null}',
                    { status: 503, statusText: 'Service Unavailable',
                      headers: { 'Content-Type': 'application/json' } }
                ))
            } catch {
                // 極舊環境沒有 Response 建構子時才退回原本的拒絕行為
                return Promise.reject(new DOMException('BiliCDN blocked httpdns', 'AbortError'))
            }
        }
        if (isHttpDnsUrl(urlStr)) {
            redirectStats.httpdnsAllowed++
        }

        if (isBiliJsonMetadataApi(urlStr)) {
            const headers = new Headers(
                init && init.headers
                    ? init.headers
                    : (input instanceof Request ? input.headers : undefined)
            )
            headers.set('Accept', 'application/json, text/plain, */*')
            if (input instanceof Request) {
                input = new Request(input, { headers })
            } else {
                init = Object.assign({}, init, { headers })
            }
        }

        if (isMediaSegmentUrl(urlStr)) {
            const norm = normalizeMediaUrl(urlStr)
            const targetCdn = norm.targetCdn || norm.originCdn || getBiliVideoCdn(urlStr)
            const effectiveUrl = norm.changed ? norm.url : urlStr

            // 保留原 Request 所有屬性（特別是 signal、referrer、mode）
            // 不能強加 mode:'cors'，會把 same-origin/no-cors 請求打壞
            const fetchInput = (input instanceof Request)
                ? new Request(effectiveUrl, {
                    method:         input.method,
                    headers:        input.headers,
                    body:           (input.method === 'GET' || input.method === 'HEAD') ? undefined : input.body,
                    mode:           input.mode === 'navigate' ? 'same-origin' : input.mode,
                    credentials:    input.credentials,
                    cache:          input.cache,
                    redirect:       input.redirect,
                    referrer:       input.referrer,
                    referrerPolicy: input.referrerPolicy,
                    integrity:      input.integrity,
                    signal:         input.signal,
                  })
                : effectiveUrl

            const fetchStartedAt = Date.now()
            return OriginalFetch(fetchInput, init).then(res => {
                if (res.ok) {
                    recordCdnSuccess(targetCdn)
                    // 注意：fetch() 的 Promise 在「收到 header」就 resolve，body 這時候通常還在傳
                    // （尤其大檔案／跨國高延遲）。這裡不能用 content-length 當「已經下載完」直接
                    // 一次性入帳——那會把整包位元組記在 TTFB 那一刻，duration 也被錯算成只有 TTFB，
                    // 造成吞吐評分嚴重灌水（一個 TTFB 快但傳輸慢的節點會被誤判成最快），
                    // Watchdog 也會看到「這秒突然滿血、之後好幾秒卻是 0 位元組」的假停滯。
                    // 改成用 tee() 分流：一份原封不動交給播放器，另一份逐 chunk 即時回報真實下載
                    // 節奏給 Watchdog，最後用真正的完整下載時間算 CDN 吞吐分數。
                    try {
                        if (res.body && typeof res.body.tee === 'function') {
                            const [forCaller, forCount] = res.body.tee()
                            res = new Response(forCaller, { status: res.status, statusText: res.statusText, headers: res.headers })
                            const reader = forCount.getReader()
                            let counted = 0
                            let firstChunkAt = 0
                            let chunkCount = 0
                            const pump = () => reader.read().then(({ done, value }) => {
                                if (value && value.byteLength) {
                                    if (!firstChunkAt) firstChunkAt = Date.now()   // 純傳輸時間起點，扣掉 TTFB
                                    chunkCount++
                                    counted += value.byteLength
                                    Watchdog.noteExternalBytes(targetCdn, value.byteLength)
                                    // 邊讀邊刷新去重標記：PerformanceObserver 的 resource-timing entry
                                    // 到達時機跟我們這條逐 chunk 讀取的 tee 分支沒有嚴格順序保證，尤其
                                    // 大檔案/慢連線下這條路徑可能還沒讀完、entry 卻先送達，若只在 done
                                    // 時才標記，會讓 onEntry() 把同一包位元組又加一次。持續刷新也順便
                                    // 避免下載耗時超過去重視窗（5s）導致標記提早過期。
                                    noteSegmentAccounted(effectiveUrl)
                                }
                                if (done) {
                                    if (counted) {
                                        // 小 segment 常常整包在同一個 read() 就到齊（chunkCount===1），
                                        // firstChunkAt 幾乎等於下載完成時間，扣 TTFB 後會逼近 0ms，
                                        // Math.max(1,...) 下限反而把 Mbps 撐爆成離譜天文數字（實測見過
                                        // 500+ Mbps 的假樣本毒化 EWMA）。這種情況退回含 TTFB 的完整耗時。
                                        const durationBase = chunkCount >= 2 ? (firstChunkAt || fetchStartedAt) : fetchStartedAt
                                        recordCdnThroughput(targetCdn, counted, Math.max(1, Date.now() - durationBase), latestPlaybackRate)
                                    }
                                    return
                                }
                                return pump()
                            }).catch(() => {})
                            pump()
                        } else {
                            // 極舊環境沒有 ReadableStream.tee()：退回一次性用 content-length 概算，
                            // 不夠準（duration 會偏短）但至少不是完全量不到。
                            const cl = res.headers.get('content-length')
                            const bytes = cl ? (parseInt(cl, 10) || 0) : 0
                            if (bytes) {
                                Watchdog.noteExternalBytes(targetCdn, bytes)
                                recordCdnThroughput(targetCdn, bytes, Math.max(1, Date.now() - fetchStartedAt), latestPlaybackRate)
                                noteSegmentAccounted(effectiveUrl)
                            }
                        }
                    } catch {}
                } else if (HARD_FAIL_STATUSES.has(res.status)) {
                    recordCdnFailure(targetCdn, true, res.status)
                } else if (res.status >= 500) {
                    recordCdnFailure(targetCdn, false, res.status)
                }
                return res
            }).catch(err => {
                if (err && err.name === 'AbortError') throw err
                recordCdnFailure(targetCdn)
                // fetch 的 promise 在「收到 header」就 resolve，會走到這條 catch 代表
                // 連 header 都沒拿到 → 必然是 0 位元組的連線層失敗。
                handleSegmentConnError(targetCdn, 0)
                throw err
            })
        }

        // playurl API 回應攔截
        if (!isPlayUrlApi(urlStr)) return OriginalFetch(input, init)
        // v1.3.4：這裡原本包了一層 `new Promise(resolve => response.text().then(...))`，
        // 而那個 executor **沒有 reject 參數**。`response.text()` 只要 reject
        // （連線在收到 header 之後才斷、或播放器把這次 playurl 請求 abort 掉——
        // 快速連續換片、連點畫質切換時都會發生），內層的 rejection 就無處可去，
        // 外層 Promise 既不 resolve 也不 reject —— 呼叫端的 `await fetch(...)`
        // **永遠不會回來**，播放器停在「載入中」，只能重整。症狀正好是
        // 「偶爾有幾部影片點進去一直轉圈」。
        // 直接回傳 .then() 鏈即可：rejection 會照 Promise 語意往外傳，
        // 播放器的錯誤處理與重試才有機會運作。
        return OriginalFetch(input, init).then(response =>
            response.text().then(text => {
                // 改寫失敗絕不能讓整個回應消失：退回原始 text，寧可不優化也要能播。
                let out = text
                try {
                    const r = handleInterceptedResponse(text, urlStr)
                    if (typeof r === 'string') out = r
                } catch (e) { err('playurl 改寫失敗，改用原始回應：', e) }
                // 204 / 205 / 304 依規範不得帶 body，硬塞會讓 Response 建構子丟 TypeError。
                const nullBody = response.status === 204 || response.status === 205 || response.status === 304
                try {
                    return new Response(nullBody ? null : out, {
                        status: response.status, statusText: response.statusText, headers: response.headers,
                    })
                } catch (e) {
                    // 連合成 Response 都失敗（極少見）時，至少把原始內容以 200 交回去，
                    // 而不是讓呼叫端拿到一個 rejected promise。
                    err('合成 playurl Response 失敗，改用最小回應：', e)
                    return new Response(nullBody ? null : text, { status: response.status || 200 })
                }
            })
        )
    }

    // 測速（probeCdnThroughput/confirmHostReachable）也是用 fetch 發請求，Tampermonkey
    // sandbox 模式下 window.fetch 會轉發到這裡被改寫的 unsafeWindow.fetch——測速請求會
    // 被自己的攔截層改寫到別的節點，量出來的速度記到錯的 CDN 頭上。掛出原生 fetch 供繞過。
    interceptNetResponse.rawFetch = OriginalFetch.bind(theWindow)
    return interceptNetResponse
})(unsafeWindow)

// 若播放器把 segment 請求放進 Worker，補一層輕量 fetch/XHR host 改寫。
// classic Worker 用 importScripts；module Worker 僅包同源 script，避免跨源 module import 破壞 player。
const biliCdnWorkers = new Set()
const getWorkerCdnTarget = () => resolvedCdn || getBestCdn() || activeCdnList[0] || PREFERRED_CDN_LIST[0] || ''

// ── Worker 攔截有效性量測（改進工單 B）───────────────────────────────────
// 這 250 行是全檔最複雜、最脆弱的部分（動態組字串 + importScripts 遠端網址），
// 且下方 new Worker 攔截處自己都不確定播放器是否真的用 Worker 抓 segment。埋四個分層指標，
// 用真實數據決定去留：created（攔到幾次 new Worker）→ netCalls（Worker 內
// 發了幾次網路請求）→ mediaSeen（其中幾次是影片分段）→ rewrites（實際改寫
// 了幾次）。隱私聲明：所有計數只存在使用者本機（GM_setValue），腳本不會
// 自動上傳任何資料，回報完全靠使用者手動 BiliCDN.workerStats() 複製貼上。
const WORKER_STATS_KEY = 'workerStats_v1'
const WORKER_STATS_SAVE_MS = 5000
const WORKER_STATS_MAX_SAMPLES = 5
const workerStats = (() => {
    try {
        const raw = JSON.parse(GM_getValue(WORKER_STATS_KEY) || '{}') || {}
        return {
            created: +raw.created || 0,
            netCalls: +raw.netCalls || 0,
            mediaSeen: +raw.mediaSeen || 0,
            rewrites: +raw.rewrites || 0,
            bytes: +raw.bytes || 0,
            firstAt: +raw.firstAt || 0,
            lastAt: +raw.lastAt || 0,
            samples: Array.isArray(raw.samples) ? raw.samples.slice(0, WORKER_STATS_MAX_SAMPLES) : [],
        }
    } catch {
        return { created: 0, netCalls: 0, mediaSeen: 0, rewrites: 0, bytes: 0, firstAt: 0, lastAt: 0, samples: [] }
    }
})()
let workerStatsSaveTimer = null
const flushWorkerStats = () => {
    if (workerStatsSaveTimer) { clearTimeout(workerStatsSaveTimer); workerStatsSaveTimer = null }
    try { GM_setValue(WORKER_STATS_KEY, JSON.stringify(workerStats)) } catch {}
}
const scheduleWorkerStatsSave = () => {
    if (workerStatsSaveTimer) return
    workerStatsSaveTimer = setTimeout(() => { workerStatsSaveTimer = null; flushWorkerStats() }, WORKER_STATS_SAVE_MS)
}
// patch 可含 created/netCalls/mediaSeen/rewrites/bytes（累加）與 sample（worker script 網址樣本）
const bumpWorkerStats = (patch) => {
    if (!patch) return
    const now = Date.now()
    if (!workerStats.firstAt) workerStats.firstAt = now
    workerStats.lastAt = now
    ;['created', 'netCalls', 'mediaSeen', 'rewrites', 'bytes'].forEach(k => {
        if (patch[k]) workerStats[k] += patch[k]
    })
    if (patch.sample && !workerStats.samples.includes(patch.sample)) {
        workerStats.samples.push(patch.sample)
        if (workerStats.samples.length > WORKER_STATS_MAX_SAMPLES) workerStats.samples.shift()
    }
    scheduleWorkerStatsSave()
}
window.addEventListener('pagehide', flushWorkerStats)
// 判讀規則見改進工單 B：created=0 → 可砍；netCalls=0 → 可砍；mediaSeen=0 → 可砍；
// mediaSeen>0 → 保留（rewrites=0 時也保留，代表當時剛好不需改寫，不代表沒作用）。
const summarizeWorkerStats = () => {
    const days = workerStats.firstAt ? Math.max(1, Math.round((Date.now() - workerStats.firstAt) / 86400000)) : 0
    let verdict = '尚無資料（先播放影片數分鐘再查）'
    if (workerStats.firstAt) {
        if (workerStats.created === 0) verdict = '完全沒攔到 Worker → 可考慮移除'
        else if (workerStats.netCalls === 0) verdict = '有 Worker 但從未發出網路請求 → 可考慮移除'
        else if (workerStats.mediaSeen === 0) verdict = '有網路請求但都不是影片分段 → 可考慮移除'
        else verdict = '有攔到影片分段 → 建議保留'
    }
    return {
        created: workerStats.created,
        netCalls: workerStats.netCalls,
        mediaSeen: workerStats.mediaSeen,
        rewrites: workerStats.rewrites,
        bytesMB: +((workerStats.bytes || 0) / 1024 / 1024).toFixed(2),
        observedDays: days,
        samples: [...workerStats.samples],
        verdict,
    }
}

// worker 強制改寫清單：soft-block / strongly-bad 的 preferred 主機（worker 預設不認這些），
// 外加賽馬勝者切換時明確指定的舊主機。讓中途切換對 worker segment 流量也生效。
// 用有時效的 Map 而非永久 Set：一次偶發錯誤不該讓某個 host 整支長片都被流放，
// softBlockCdn 早就有 TTL 的設計，這裡跟它保持一致。
const forcedRedirectHosts = new Map()   // host -> expireAt
const FORCED_REDIRECT_TTL = 10 * 60 * 1000
const addForcedRedirect = (host, ttl) => {
    if (!host) return
    forcedRedirectHosts.set(host, Date.now() + (ttl || FORCED_REDIRECT_TTL))
}
const isForcedRedirect = (host) => {
    const t = forcedRedirectHosts.get(host)
    if (!t) return false
    if (t <= Date.now()) { forcedRedirectHosts.delete(host); return false }
    return true
}
const getWorkerForceList = () => {
    const out = new Set([...forcedRedirectHosts.keys()].filter(isForcedRedirect))
    PREFERRED_CDN_LIST.forEach(h => {
        if (isCdnSoftBlocked(h) || isCdnStronglyBad(h)) out.add(h)
    })
    out.delete(getWorkerCdnTarget())
    return [...out]
}

const syncWorkerCdnTarget = () => {
    const target = getWorkerCdnTarget()
    if (!target) return
    const force = getWorkerForceList()
    biliCdnWorkers.forEach(worker => {
        try {
            worker.postMessage({ __biliCdnSetTarget: target, __biliCdnForce: force })
        } catch {
            biliCdnWorkers.delete(worker)
        }
    })
}

// 使用者透過設定面板 checkbox 停用/啟用時同步通知既有 Worker，
// 否則已建立的 Worker 會在「停用」後仍持續改寫 segment host（disabled 只擋新建 Worker）。
const syncWorkerDisabledState = () => {
    biliCdnWorkers.forEach(worker => {
        try {
            worker.postMessage({ __biliCdnDisabled: disabled })
        } catch {
            biliCdnWorkers.delete(worker)
        }
    })
}

const setupClassicWorkerIntercept = () => {
    // 安全開關。關閉時整段攔截機制不生效，biliCdnWorkers
    // 維持空 Set——syncWorkerCdnTarget()/syncWorkerDisabledState() 的 forEach 在空 Set
    // 上單純不做事，不會因為開關關閉而丟例外。程式碼刻意保留不刪，等 workerStats()
    // 數據確認這段真的沒用後，才在未來版本整段移除（見 CHANGELOG）。
    if (!EnableWorkerIntercept) return
    try {
        const OriginalWorker = unsafeWindow.Worker
        if (!OriginalWorker || OriginalWorker.__biliCdnPatched) return

        const preferred = [...PREFERRED_CDN_LIST]
        const excludes = [...ExcludeHostKeywords]
        const targetHost = getWorkerCdnTarget()
        if (!targetHost) return
        const forceList = getWorkerForceList()

        const sharedWorkerPatch = (originalUrl) => `
let BILICDN_TARGET_HOST = ${JSON.stringify(targetHost)};
let BILICDN_FORCE = ${JSON.stringify(forceList)};
const BILICDN_PREFERRED = ${JSON.stringify(preferred)};
const BILICDN_EXCLUDES = ${JSON.stringify(excludes)};
const BILICDN_BASE = ${JSON.stringify(originalUrl)};
let BILICDN_BYTES_PORT = null;
let BILICDN_DISABLED = false;
// Worker 被包成 blob 之後 self.location 會變成 blob:https://... ，任何相對路徑
// （./x.js、/api/y）若拿 blob URL 當基準解析就會壞掉。統一先轉絕對路徑再判斷/改寫。
const biliCdnAbs = (url) => {
    try { return new URL(String(url), BILICDN_BASE).href; } catch { return String(url); }
};
const biliCdnMatchesExclude = (host) => BILICDN_EXCLUDES.some((kw) => kw && host.indexOf(kw) !== -1);
const biliCdnIsUnstable = (host) =>
    !!host && (/\\.mcdn\\.bilivideo\\.(cn|com)$/i.test(host)
        || /\\.szbdyd\\.com$/i.test(host)
        || (/^cn-[a-z]{2}-/.test(host) && host.endsWith('.bilivideo.com')));
self.addEventListener('message', (event) => {
    const data = event && event.data;
    if (data && data.__biliCdnSetTarget && typeof data.__biliCdnSetTarget === 'string') {
        BILICDN_TARGET_HOST = data.__biliCdnSetTarget;
    }
    if (data && Array.isArray(data.__biliCdnForce)) {
        BILICDN_FORCE = data.__biliCdnForce;
    }
    if (data && data.__biliCdnBytesPort) {
        BILICDN_BYTES_PORT = data.__biliCdnBytesPort;
        biliCdnFlushStat();
    }
    if (data && typeof data.__biliCdnDisabled === 'boolean') {
        BILICDN_DISABLED = data.__biliCdnDisabled;
    }
});
// 回報 Worker 內下載的 segment 位元組給主執行緒（主執行緒 PerformanceObserver 看不到 Worker 流量）
const biliCdnNoteSeg = (url, bytes) => {
    if (!BILICDN_BYTES_PORT || !bytes) return;
    try {
        const h = new URL(url).hostname;
        if (h.endsWith('.bilivideo.com') || h.endsWith('.bilivideo.cn')) {
            BILICDN_BYTES_PORT.postMessage({ host: h, bytes: +bytes });
        }
    } catch (e) {}
};
// 量測（改進工單 B）：netCalls / mediaSeen / rewrites 三個埋點，節流回報給主執行緒
// 統計。port 到位前的請求不能漏記，先本地累積到 BILICDN_STAT，port 到位（見上方
// __biliCdnBytesPort 分支）或每 BILICDN_REPORT_MS 才送一次，不逐請求 postMessage。
let BILICDN_STAT = { netCalls: 0, mediaSeen: 0, rewrites: 0 };
let BILICDN_STAT_TIMER = null;
const biliCdnFlushStat = () => {
    if (!BILICDN_BYTES_PORT) return;
    if (!BILICDN_STAT.netCalls && !BILICDN_STAT.mediaSeen && !BILICDN_STAT.rewrites) return;
    try {
        BILICDN_BYTES_PORT.postMessage({ __stat: BILICDN_STAT });
        BILICDN_STAT = { netCalls: 0, mediaSeen: 0, rewrites: 0 };
    } catch (e) {}
};
const biliCdnBumpStat = (key) => {
    BILICDN_STAT[key]++;
    if (!BILICDN_STAT_TIMER) {
        BILICDN_STAT_TIMER = setTimeout(() => { BILICDN_STAT_TIMER = null; biliCdnFlushStat(); }, BILICDN_REPORT_MS);
    }
};
const biliCdnIsMedia = (url) => {
    try {
        const u = new URL(url);
        const h = u.hostname;
        if (!(h.endsWith('.bilivideo.com') || h.endsWith('.bilivideo.cn') || biliCdnIsUnstable(h))) return false;
        return u.pathname.endsWith('.m4s') || u.pathname.endsWith('.flv') || u.pathname.includes('/upgcxcode/');
    } catch {
        return false;
    }
};
const biliCdnNeedsRedirect = (host) =>
    !!host && (biliCdnIsUnstable(host) || biliCdnMatchesExclude(host)
        || BILICDN_FORCE.indexOf(host) !== -1
        || BILICDN_PREFERRED.indexOf(host) === -1);
const biliCdnRewrite = (url) => {
    try {
        if (BILICDN_DISABLED) return url;
        biliCdnBumpStat('netCalls');
        const abs = biliCdnAbs(url);
        if (!biliCdnIsMedia(abs)) return abs;
        biliCdnBumpStat('mediaSeen');
        const u = new URL(abs);
        if (!biliCdnNeedsRedirect(u.hostname) || u.hostname === BILICDN_TARGET_HOST) return abs;
        u.hostname = BILICDN_TARGET_HOST;
        u.port = '';
        biliCdnBumpStat('rewrites');
        return u.toString();
    } catch {
        return url;
    }
};
const BILICDN_REPORT_MS = 200;
if (self.fetch) {
    const OriginalFetch = self.fetch.bind(self);
    self.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const rewritten = biliCdnRewrite(url);
        if (rewritten !== url && input instanceof Request) {
            input = new Request(rewritten, {
                method: input.method,
                headers: input.headers,
                body: (input.method === 'GET' || input.method === 'HEAD') ? undefined : input.body,
                mode: input.mode === 'navigate' ? 'same-origin' : input.mode,
                credentials: input.credentials,
                cache: input.cache,
                redirect: input.redirect,
                referrer: input.referrer,
                referrerPolicy: input.referrerPolicy,
                integrity: input.integrity,
                signal: input.signal,
            });
        } else if (rewritten !== url) {
            input = rewritten;
        }
        return OriginalFetch(input, init).then((resp) => {
            try {
                // 跟主執行緒同一個教訓：resp 在收到 header 就 resolve，body 通常還在傳。
                // 用 content-length 在這一刻一次性入帳會把整包位元組記在 TTFB 那一刻，
                // 造成主執行緒的 Watchdog 看到「這秒突然滿血、之後好幾秒卻是 0 位元組」
                // 的假停滯。改用 tee() 逐 chunk 節流回報，比照主執行緒的做法。
                if (resp && resp.body && typeof resp.body.tee === 'function' && biliCdnIsMedia(resp.url || rewritten)) {
                    const [forCaller, forCount] = resp.body.tee();
                    const out = new Response(forCaller, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
                    const reader = forCount.getReader();
                    let pending = 0, lastReport = 0;
                    const flush = (force) => {
                        const now = Date.now();
                        if (!pending) return;
                        if (!force && now - lastReport < BILICDN_REPORT_MS) return;
                        lastReport = now;
                        biliCdnNoteSeg(resp.url || rewritten, pending);
                        pending = 0;
                    };
                    const pump = () => reader.read().then(({ done, value }) => {
                        if (value && value.byteLength) { pending += value.byteLength; flush(false); }
                        if (done) { flush(true); return; }
                        return pump();
                    }).catch(() => flush(true));
                    pump();
                    return out;
                }
                // 沒有 tee()（極舊環境或 opaque/no-body 回應）：退回一次性用 content-length
                // 概算，跟主執行緒同款 fallback 保持一致，避免這條路徑直接零位元組入帳。
                if (resp && biliCdnIsMedia(resp.url || rewritten)) {
                    const cl = resp.headers && resp.headers.get && resp.headers.get('content-length');
                    const bytes = cl ? (parseInt(cl, 10) || 0) : 0;
                    if (bytes) biliCdnNoteSeg(resp.url || rewritten, bytes);
                }
            } catch (e) {}
            return resp;
        });
    };
}
if (self.XMLHttpRequest) {
    const OriginalXHR = self.XMLHttpRequest;
    self.XMLHttpRequest = class XMLHttpRequest extends OriginalXHR {
        open(method, url, ...rest) {
            const rewritten = biliCdnRewrite(String(url));
            try {
                let lastLoaded = 0;
                // XHR 的 'load' 要等整包下載完才觸發，跟主執行緒同樣的問題：大 segment 下載
                // 期間主執行緒完全看不到進度。改掛 'progress'，用累計 loaded 的增量即時回報。
                this.addEventListener('progress', (e) => {
                    try {
                        if (!biliCdnIsMedia(rewritten)) return;
                        const loaded = (e && e.loaded) || 0;
                        const delta = loaded - lastLoaded;
                        if (delta > 0) { lastLoaded = loaded; biliCdnNoteSeg(rewritten, delta); }
                    } catch (e) {}
                });
                this.addEventListener('load', () => {
                    try {
                        if (!biliCdnIsMedia(rewritten)) return;
                        const cl = this.getResponseHeader && this.getResponseHeader('content-length');
                        let n = cl ? parseInt(cl, 10) : 0;
                        if (!n && this.response) {
                            if (this.response.byteLength) n = this.response.byteLength;
                            else if (typeof this.response === 'string') n = this.response.length;
                        }
                        // progress 已經逐步報過 lastLoaded，這裡只補沒被 progress 算到的尾巴，避免重複入帳
                        const remaining = Math.max(0, n - lastLoaded);
                        if (remaining) biliCdnNoteSeg(rewritten, remaining);
                    } catch (e) {}
                });
            } catch (e) {}
            return super.open(method, rewritten, ...rest);
        }
    };
}
`

        const classicWorkerPatch = (originalUrl) => `
${sharedWorkerPatch(originalUrl)}
const BiliCdnOriginalImportScripts = self.importScripts.bind(self);
self.importScripts = (...urls) => BiliCdnOriginalImportScripts(...urls.map((url) => {
    try { return new URL(url, BILICDN_ORIGINAL).href; } catch { return url; }
}));
const BILICDN_ORIGINAL = ${JSON.stringify(originalUrl)};
importScripts(BILICDN_ORIGINAL);
`

        const moduleWorkerPatch = (originalUrl) => `
${sharedWorkerPatch(originalUrl)}
import(${JSON.stringify(originalUrl)}).catch((e) => { try { console.error('[BiliCDN] worker module import 失敗', e); } catch (e2) {} });
`

        const registerWorker = (worker) => {
            biliCdnWorkers.add(worker)
            setTimeout(() => {
                try { worker.postMessage({ __biliCdnSetTarget: getWorkerCdnTarget(), __biliCdnForce: getWorkerForceList(), __biliCdnDisabled: disabled }) } catch {}
            }, 0)
            // 建立專屬 MessagePort 接收 Worker 回報的 segment 下載量（不污染播放器訊息通道、不跨分頁）
            try {
                const mc = new MessageChannel()
                mc.port1.onmessage = (e) => {
                    const d = e && e.data
                    if (d && d.bytes && Watchdog && Watchdog.noteExternalBytes) Watchdog.noteExternalBytes(d.host, d.bytes)
                    if (d && d.bytes) bumpWorkerStats({ bytes: d.bytes })
                    if (d && d.__stat) bumpWorkerStats(d.__stat)
                }
                worker.postMessage({ __biliCdnBytesPort: mc.port2 }, [mc.port2])
            } catch {}
            const originalTerminate = worker.terminate && worker.terminate.bind(worker)
            if (originalTerminate) {
                worker.terminate = () => {
                    biliCdnWorkers.delete(worker)
                    return originalTerminate()
                }
            }
            return worker
        }

        unsafeWindow.Worker = class Worker extends OriginalWorker {
            constructor(scriptURL, options) {
                if (disabled) {
                    return super(scriptURL, options)
                }
                try {
                    const originalUrl = new URL(String(scriptURL), location.href).href
                    if (originalUrl.startsWith('blob:') || originalUrl.startsWith('data:')) {
                        return super(scriptURL, options)
                    }
                    const isModule = !!(options && options.type === 'module')
                    if (isModule && new URL(originalUrl).origin !== location.origin) {
                        return super(scriptURL, options)
                    }
                    // 觀察用：Bilibili 網頁播放器主流實作是主執行緒 MSE，不確定 segment 真的會走
                    // Worker。開 BiliCDN.verbose(true) 觀察一段時間，若從未看到這行，代表這整段
                    // Worker 攔截對目前播放器版本沒有實際效果，未來可以考慮整塊移除。
                    log('[Worker] patched: ' + originalUrl)
                    bumpWorkerStats({ created: 1, sample: originalUrl })
                    const source = isModule ? moduleWorkerPatch(originalUrl) : classicWorkerPatch(originalUrl)
                    const blob = new Blob([source], { type: 'application/javascript' })
                    const blobUrl = URL.createObjectURL(blob)
                    const worker = registerWorker(super(blobUrl, options))
                    // 30 秒可能太短：若 Worker 因故需要重新讀取自己的 script URL（少見但存在），
                    // 太早 revoke 會失敗。延長到 5 分鐘；一個 blob URL 佔用記憶體很小，
                    // Worker 終止時瀏覽器也會回收，不會造成長期洩漏。
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000)
                    return worker
                } catch (e) {
                    return super(scriptURL, options)
                }
            }
        }
        unsafeWindow.Worker.__biliCdnPatched = true
    } catch (e) {}
}
setupClassicWorkerIntercept()

// DOM 工具
const waitForElm = (selector, timeoutMs) => new Promise((resolve, reject) => {
    const ele = document.querySelector(selector)
    if (ele) return resolve(ele)
    let timer = null
    const observer = new MutationObserver(() => {
        const found = document.querySelector(selector)
        if (found) {
            observer.disconnect()
            if (timer) clearTimeout(timer)
            resolve(found)
        }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
    if (timeoutMs) {
        timer = setTimeout(() => {
            observer.disconnect()
            reject(new Error('等待元素逾時：' + selector))
        }, timeoutMs)
    }
})

function fromHTML(html) {
    const template = document.createElement('template')
    template.innerHTML = html
    const result = template.content.children
    return result.length === 1 ? result[0] : result
}

// ── CDN 延遲探測 ──────────────────────────────────────────────────────
// 1. 結果快取 2h，保留穩定排序但避免網路環境變動後卡太久
// 2. 已知死節點 short-circuit，不發任何請求（任何失敗請求瀏覽器都會印紅字，
//    唯一根治就是「不發」）
// 3. 探測路徑用 /crossdomain.xml —— 這是關鍵，見下面 PROBE_PATH 的說明
// 4. 單一 no-cors fetch 同時取得「可達性」與「延遲」：resolve = 伺服器有回應
//    （含 4xx/5xx，opaque response 讀不到狀態碼但那不重要）；reject = 網路層
//    失敗（DNS / 連線被拒 / TLS）。不再需要「Image 探測 + 另一發確認請求」兩步。
//
// ★ 為什麼是 /crossdomain.xml 而不是 /favicon.ico
// 舊版探測 /favicon.ico，但 upos CDN 上**沒有這個檔案**：實測 aliov / cos 回 403、
// ali 回 405。也就是說每一輪探測都會對每個「健康的」節點打出一個必定失敗的請求，
// 而瀏覽器對任何非 2xx 的子資源都會在 console 印一行紅字
// （`Failed to load resource: the server responded with a status of 403`）。
// 使用者看到的紅字有一大半是探測機制自己製造的，跟節點好壞完全無關。
//
// /crossdomain.xml 是 Flash 時代留下來的跨網域政策檔，這些 CDN 至今仍然供應，
// 實測 aliov / ali / cos 以及 Akamai 都回 200（約 250~950 bytes，帶 cache-buster
// 查詢參數也照樣 200）。改用它之後，健康節點的探測是安靜的 —— 紅字只會出現在
// 「這個節點真的有問題」的時候，那時候印出來反而是有用的訊號。
// （upos-sz-mirrorhw 是 TCP 連線直接被丟掉、10 秒不回應，跟路徑無關，本來就該被標死。）
const PROBE_PATH       = '/crossdomain.xml'
const PROBE_CACHE_KEY  = 'probeCache_v1'
const PROBE_CACHE_TTL  = 2 * 60 * 60 * 1000
// 從 1200ms → 2000ms → 8000ms。前兩次都調得不夠，而且不夠的理由一樣：拿**暖機**
// 往返時間去訂一個**永遠發生在冷連線上**的窗口。探測之所以要探測，正是因為那個 host
// 當下沒有熱連線，所以它遇到的必然是冷路徑。curl 實測冷 TLS 握手：ali 6.4 秒、
// 08c 7.9 秒、hw 8.8 秒（暖機後 ali 才 0.35~0.56 秒）。2000ms 的窗對 ali 是**必定逾時**，
// 於是每輪探測都把一台好節點丟進 5 分鐘軟隔離——使用者實測回報的
// `軟隔離（session）: ['upos-sz-mirrorali', ...]` 就是它。
// 8000ms 涵蓋真實候選節點的冷握手，又低於 CONFIRM_TIMEOUT_MS（10 秒）保留確認空間。
// 探測不在起播關鍵路徑上（見 deferStartupProbes）且各候選並行，多等這幾秒沒有代價。
const PROBE_TIMEOUT_MS = 8000
// 「連得到、但比探測窗還慢」要連續兩輪才軟隔離。一次慢有太多無辜的原因（冷握手、
// 頁面自己正在搶連線配額），而軟隔離 5 分鐘等於這段時間完全不考慮這個節點。
// 跟 PROBE_TIMEOUT_STRIKES 同一個原則：證據強度要配得上處分。
const PROBE_SLOW_STRIKES = 2
// 探測逾時 + 確認也連不到 = 完全沒有回應。這是「很可能壞了」，但不是鐵證：
// 起播當下頁面自己也在搶頻寬與連線配額，偶爾整個窗口都撞上並非不可能。
// 而標死的代價是不再使用一個**好**節點——使用者實測回報過 upos-sz-mirrorali 被這樣
// 誤殺（它 DNS 解得到、/crossdomain.xml 回 200）。
// 改成多次才定罪：前幾次只軟隔離觀察 10 分鐘，任何一次成功都會把計數歸零。
// 注意這只放寬「逾時」這條路——fetch 被 reject（DNS/連線被拒/TLS）本來就是明確的網路層
// 失敗，而且已經另外再確認過一次，維持一次定罪。
//
// ★ 2026-08-19 實測修正：舊值（strikes=2、confirm 4 秒 ⇒ 單輪預算 2+4=6 秒）**還是不夠**，
// 而且不夠的方式是系統性的。用 curl 從台灣量到的是：暖機後 ali 約 0.35~0.56 秒沒錯，
// 但**冷 TLS 握手** ali 要 6.4 秒、08c 7.9 秒、hw 8.8 秒。也就是說只要探測撞上冷連線，
// 2 秒的探測窗與 4 秒的確認窗會**一起**爆掉，兩輪就湊滿 2 strike 判死 7 天——
// 使用者瀏覽器裡當場就是這個狀態（dead 清單有 ali，reason=timeout）。
// 調參原則：**判死的時間預算必須大於冷 TLS 的實測上界，而不是大於暖機 RTT。**
const PROBE_TIMEOUT_STRIKES = 3
// 確認窗。要大於冷 TLS 的實測上界（8.8 秒），否則確認本身就會把冷連線判成不可達。
const CONFIRM_TIMEOUT_MS = 10000

// 確認 host 是否真的連得到：no-cors fetch 在「伺服器有回應（含 4xx/5xx）」時 resolve，
// 只有「DNS 失敗 / 連線被拒 / TLS 失敗」等網路層錯誤才 reject。
// 用來在「探測失敗了，但到底是節點壞了還是只是這次不順」之間做最後判斷，避免誤殺好節點。
// 路徑跟 probeCdnLatency 一樣走 PROBE_PATH（見上面說明）：對健康節點是 200，不印紅字。
const confirmHostReachable = (cdn, timeoutMs) => new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    let ctrl = null
    try { ctrl = new AbortController() } catch {}
    const to = setTimeout(() => { try { ctrl && ctrl.abort() } catch {} ; done(false) }, timeoutMs || 4000)
    interceptNetResponse.rawFetch('https://' + cdn + PROBE_PATH + '?_c=' + Date.now(), {
        method: 'GET', mode: 'no-cors', cache: 'no-store',
        credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: ctrl ? ctrl.signal : undefined,
    }).then(() => { clearTimeout(to); done(true) })
      .catch(() => { clearTimeout(to); done(false) })
})

// ── segment 連線層失敗處理（v1.3.3）──────────────────────────────────
// XHR 的 error 事件與 fetch 的 reject 都拿不到瀏覽器的真實原因——ERR_NAME_NOT_RESOLVED
// 這類訊息只會印在 console，程式讀不到，status 一律是 0。唯一能用的線索是
// 「一個位元組都沒收到」：那代表連線根本沒建立（DNS／連線被拒／TLS），而不是傳到一半斷掉。
//
// 這種失敗跟壅塞的性質完全不同：它 100% 會重演。既有的 recordCdnFailure() 只會軟隔離
// 兩分鐘，等於每次起播、每次 seek 都要再撞一次同一顆爛節點，播放器得先等這次失敗才會
// 去試 backup_url——使用者看到的就是轉圈圈。所以這裡確認真的連不到就直接標死（30 天，
// 之後 needsRedirect() 會讓所有指向它的 segment 自動改寫掉），並立刻重排候選、預連線。
const segConnCheckAt = new Map()   // host -> 上次確認時間
const SEG_CONN_CHECK_COOLDOWN = 30 * 1000
const handleSegmentConnError = (cdn, bytesReceived) => {
    if (!cdn) return
    // 收過位元組 = 連線建立過，是傳輸中斷（網路抖動、切畫質、播放器自己取消），
    // 不屬於這裡要處理的情況，交還既有的軟懲罰。
    if (bytesReceived > 0) return
    if (knownDeadHosts.has(cdn) || blacklistSet.has(cdn)) return
    // 起播時播放器會同時併發好幾顆 segment，全部失敗 → 不做節流會一次打出十幾個確認請求。
    const now  = Date.now()
    const last = segConnCheckAt.get(cdn) || 0
    if (now - last < SEG_CONN_CHECK_COOLDOWN) return
    segConnCheckAt.set(cdn, now)
    // 同上：已知不解析的 host 不必再確認一次。
    if (isPresumedDnsFailHost(cdn)) {
        markHostDead(cdn, 'DNS-segment')
        log('[死節點] 已知在台灣不解析的節點又被指派到 segment，直接標死：' + cdn.split('.')[0])
        promoteBestCdnNow()
        return
    }
    // 2026-08-19：確認窗從 2 秒拉到 CONFIRM_TIMEOUT_MS。冷 TLS 握手實測上界 8.8 秒，
    // 2 秒的窗會把「還在握手」的好節點判成「連不到」然後標死 30 天。見 PROBE_TIMEOUT_STRIKES。
    confirmHostReachable(cdn, CONFIRM_TIMEOUT_MS).then((reachable) => {
        // 連得到 → 只是這一次請求出事（伺服器主動斷線之類），recordCdnFailure 已經記過帳，
        // 不需要也不應該升級成標死。
        if (reachable) return
        markHostDead(cdn, 'DNS-segment')
        log('[死節點] segment 連線層失敗且確認連不到，標死 30 天：' + cdn.split('.')[0])
        promoteBestCdnNow()
    })
}

const probeCdnLatency = (cdn) => new Promise((resolve) => {
    if (knownDeadHosts.has(cdn)) return resolve({ cdn, ms: Infinity })

    const t0 = performance.now()
    let done = false
    let timedOut = false
    const finish = (result) => { if (!done) { done = true; resolve(Object.assign({ cdn }, result)) } }
    let ctrl = null
    try { ctrl = new AbortController() } catch {}
    const timer = setTimeout(() => {
        timedOut = true
        try { ctrl && ctrl.abort() } catch {}
        // 逾時不直接標死：可能只是當下壅塞。再用較長時間確認真的連不到才標死。
        // 10 秒（不是 4 秒）：實測冷 TLS 握手的上界約 8.8 秒（hw）／6.4 秒（ali），
        // 確認窗必須完整涵蓋它，否則「冷連線」會被當成「連不到」。見 PROBE_TIMEOUT_STRIKES。
        confirmHostReachable(cdn, CONFIRM_TIMEOUT_MS).then((reachable) => {
            if (reachable) {
                // 確認成功 = 這台其實連得到，只是比探測窗慢。
                // 記錄**真實耗時**而不是捏造一個平坦的 PROBE_TIMEOUT_MS：後者會讓所有
                // 逾時節點看起來一樣慢，也讓 EWMA 收到一個假數字（使用者實測看到的
                // `ali: latency 1701` 就是這樣被摻出來的，那不是任何一次真實量測）。
                const slowMs = Math.max(performance.now() - t0, PROBE_TIMEOUT_MS)
                recordCdnLatency(cdn, slowMs)
                // recordCdnLatency 會重置 probeTimeouts，所以慢速計數要另外記、且在它之後加。
                const hs = ensureCdnHealth(cdn)
                hs.probeSlows = (hs.probeSlows || 0) + 1
                scheduleCdnHealthSave()
                if (hs.probeSlows >= PROBE_SLOW_STRIKES) {
                    softBlockCdn(cdn, 'probe-slow', 5 * 60 * 1000)
                }
                finish({ ms: slowMs })
            } else {
                const h = ensureCdnHealth(cdn)
                h.probeTimeouts = (h.probeTimeouts || 0) + 1
                scheduleCdnHealthSave()
                if (h.probeTimeouts >= PROBE_TIMEOUT_STRIKES) {
                    markHostDead(cdn, 'timeout')
                    finish({ ms: Infinity, reason: 'timeout' })
                } else {
                    // 第一次：只軟隔離觀察，仍留在候選池裡等下一輪重新評估。
                    softBlockCdn(cdn, 'probe-timeout', 10 * 60 * 1000)
                    finish({ ms: PROBE_TIMEOUT_MS, reason: 'timeout-1st' })
                }
            }
        })
    }, PROBE_TIMEOUT_MS)

    interceptNetResponse.rawFetch('https://' + cdn + PROBE_PATH + '?_t=' + Date.now(), {
        method: 'GET', mode: 'no-cors', cache: 'no-store',
        credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: ctrl ? ctrl.signal : undefined,
    }).then(() => {
        // resolve = 伺服器有回應（健康節點是 200，安靜）→ 可達，這段時間就是延遲。
        if (timedOut) return
        clearTimeout(timer)
        const ms = Math.max(performance.now() - t0, 1)
        recordCdnLatency(cdn, ms)
        // 這一輪在窗內回應了 → 連續慢速計數歸零（跟 probeTimeouts 的處理方式一致）。
        const hf = cdnHealth[cdn]
        if (hf && hf.probeSlows) { hf.probeSlows = 0; scheduleCdnHealthSave() }
        finish({ ms })
    }).catch(() => {
        // reject = 網路層失敗（DNS / 連線被拒 / TLS）。
        if (timedOut) return
        clearTimeout(timer)
        // 已知在台灣不解析、本機又從無成功紀錄 → 直接判定，不必再確認一次。
        if (isPresumedDnsFailHost(cdn)) {
            markHostDead(cdn, 'DNS')
            finish({ ms: Infinity, reason: 'DNS' })
            return
        }
        // 其他 host 再確認一次才標死：單一次網路層失敗也可能只是瞬間抖動，
        // 而標死的代價是 7~30 天不再使用這個節點，誤判的傷害遠大於多發一個請求。
        // 這個情境下 console 本來就已經有一行紅字了，多一行不改變什麼。
        // 同上：2.5 秒不足以涵蓋冷 TLS 握手（實測上界 8.8 秒），改用 CONFIRM_TIMEOUT_MS。
        confirmHostReachable(cdn, CONFIRM_TIMEOUT_MS).then((reachable) => {
            if (reachable) {
                const ms = Math.max(performance.now() - t0, 1)
                recordCdnLatency(cdn, ms)
                finish({ ms })
            } else {
                markHostDead(cdn, 'DNS')
                finish({ ms: Infinity, reason: 'DNS' })
            }
        })
    })
})

// ── CDN 吞吐量賽馬（informed init）─────────────────────────────────────
// 延遲（探測 RTT）≠ 下載速度；跨國選節點真正決定卡不卡的是吞吐量。
// 拿攔截到的「真實 segment URL」對候選做小範圍 ranged GET，量實際 Mbps，
// seed 進 cdnHealth.ewmaMbps，讓 getHealthyCdnList 直接選到真最快的節點。
const THRPT_PROBE_BYTES      = 384 * 1024
const THRPT_PROBE_MIN_BYTES  = 64 * 1024     // 樣本太小（slow-start 未展開）不採信
const THRPT_PROBE_TIMEOUT    = 3000
const THRPT_BAKEOFF_COOLDOWN = 90 * 1000     // 兩次賽馬最短間隔
const THRPT_SAMPLE_FRESH_MS  = 60 * 1000     // 此時間內已有真實樣本就跳過該節點
// 固定門檻沒考慮樣本信心：一次 384KB 探測可能剛好碰到 TCP slow-start 未展開或網路瞬間
// 空檔，偏差就很大。樣本數越少，門檻拉得越高，越可信才敢用比較低的門檻。
const switchMarginFor = (samples) => {
    if (samples >= 4) return 1.15
    if (samples >= 2) return 1.30
    return 1.60
}

// ★ 跨分頁共用。舊版這是純記憶體變數，於是**每個分頁各跑一場獨立的賽馬**——
// 每場最多 4 顆候選 × 最多 768KB、每 90 秒一輪。開 5 個 bilibili 分頁就是 5 倍的背景
// 流量在跟正在播的影片搶頻寬，使用者回報的「多開分頁會不穩定」主要來自這裡。
// 賽馬量到的結果本來就寫進共用的 cdnHealth，所以同一個時間窗內**只需要有一個分頁去測**。
//
// 注意這跟既有的 Web Locks / BroadcastChannel 互斥**不重複，是互補的**：
// 那兩者擋的是「同時」（兩個分頁不會同一秒一起測），但擋不住「頻率」——A 分頁測完
// 釋放鎖之後，B 分頁的 90 秒冷卻是它自己記憶體裡的 0，於是立刻接著測，C 分頁再接著測。
// N 個分頁只是把 N 場賽馬**排隊跑完**，總流量一點都沒省。冷卻時間戳必須放在
// 所有分頁看得到的地方（GM storage）才能真正收斂成「每 90 秒全域一場」。
const BAKEOFF_TS_KEY = 'lastBakeoffAt_v1'
const getLastBakeoffAt = () => {
    try { return +GM_getValue(BAKEOFF_TS_KEY, 0) || 0 } catch { return 0 }
}
const setLastBakeoffAt = (ts) => {
    try { GM_setValue(BAKEOFF_TS_KEY, ts) } catch {}
}
let bakeoffRunning       = false
let bakeoffTimer         = null
let lastSampleSegmentUrl = null
let bakeoffNullStreak    = 0   // 連續幾輪賽馬「有候選但全部測速失敗」，用來偵測測速機制被防盜鏈整批擋下
// SPA 換片時遞增；讓仍在跑/排程中的舊片賽馬盡快自我放棄，把頻寬讓給新片。
// 沒有這個機制時，切到重片（4K/長片/無損）當下若剛好卡在舊片的賽馬排程或執行中，
// 舊片會佔住 bakeoffTimer/bakeoffRunning 整個週期（最長可到 ~4s 排程 + 最多 4 顆候選 ×3s
// probe timeout ≈ 12s），新片完全搶不到賽馬，只能沿用舊片留下的健康分數起步，加載明顯變慢。
let bakeoffEpoch         = 0
let bakeoffAbortController = null

// 多分頁協調鉤子（預設放行；Main IIFE 啟動跨分頁協調後覆寫）。
// 多開分頁時若多個分頁同時賽馬會互搶台灣上行頻寬而互相低估吞吐量，故需互斥。
let crossTabShouldBakeoff = () => true
let onBakeoffStart        = () => {}

// 對單一候選量吞吐量：ranged GET，扣掉 TTFB 只算純下載時間，降低 slow-start 偏差。
// probeBytes 可調：高碼率（4K）用較大量，讓 TCP 慢啟動展開、節點之間分得出快慢。
const probeCdnThroughput = (cdn, sampleUrl, probeBytes, externalSignal) => new Promise((resolve) => {
    if (!cdn || blacklistSet.has(cdn) || knownDeadHosts.has(cdn)) return resolve(null)
    // 縱深防禦：呼叫端已經濾過一次，但這裡是唯一真的把請求送出去的地方，再擋一次。
    if (isPresumedDnsFailHost(cdn)) return resolve(null)
    const target = replaceUrlHost(sampleUrl, cdn)
    if (!target) return resolve(null)

    const wantBytes = probeBytes || THRPT_PROBE_BYTES
    const ctrl = new AbortController()
    const to   = setTimeout(() => { try { ctrl.abort() } catch {} }, THRPT_PROBE_TIMEOUT)
    const t0   = performance.now()
    let ttfb   = 0
    let bytes  = 0

    // 換片時外部立刻 abort，不用等滿 THRPT_PROBE_TIMEOUT 才放棄舊片的探測。
    const onExternalAbort = () => { try { ctrl.abort() } catch {} }
    if (externalSignal) {
        if (externalSignal.aborted) onExternalAbort()
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }

    const done = (result) => {
        clearTimeout(to)
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
        try { ctrl.abort() } catch {}
        resolve(result)
    }

    // Bilibili CDN 有防盜鏈機制，'no-referrer' 可能讓 CDN 直接回 403（跟播放器實際
    // 用的 referrer 策略不一致）。改用跟頁面預設一致的策略，避免測速被防盜鏈擋掉。
    interceptNetResponse.rawFetch(target, {
        method: 'GET',
        headers: { Range: 'bytes=0-' + (wantBytes - 1) },
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
        referrerPolicy: 'strict-origin-when-cross-origin',
    }).then(resp => {
        // 403 要跟「慢／逾時」分開回報：它代表這條 URL 換 host 會被拒絕，
        // 再測其餘候選只會多產生幾行紅字（見 hostLockedStreams）。
        if (resp && resp.status === 403) return done({ forbidden: true })
        if (!resp || (!resp.ok && resp.status !== 206)) return done(null)
        const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null
        if (!reader) return done(null)
        ttfb = performance.now() - t0
        const pump = () => reader.read().then(({ done: rdone, value }) => {
            if (rdone || bytes >= wantBytes) {
                const total = performance.now() - t0
                const dl    = Math.max(1, total - ttfb)
                if (bytes >= THRPT_PROBE_MIN_BYTES) {
                    recordCdnThroughput(cdn, bytes, dl, 1)
                    recordCdnLatency(cdn, ttfb)
                    done({ cdn })   // 只有 cdn 會被讀；數值已在上一行入帳
                } else done(null)
                return
            }
            bytes += value ? value.length : 0
            pump()
        }).catch(() => done(null))
        pump()
    }).catch(() => done(null))
})

// 序列探測（非並行）避免候選互搶台灣上行頻寬而互相低估。只測「缺新樣本」的候選。
// skipIfFast：現用節點已經跑得夠快時要不要直接跳過整輪賽馬。
//   true（預設，換片/換畫質起播時用）：夠快就跳過，把頻寬留給正在起播的緩衝。
//   false（Watchdog 偵測到真的卡頓/fragment 錯誤/週期重評估/手動觸發時用）：
//   這些情境代表「已經出事」或「就是要主動找有沒有更好的」，不該再被這個捷徑擋掉。
// v1.3.3：解析「真正在播的節點」。過去一律用 activeCdnList[0]，但那是延遲探測排序
// 的結果，不見得是實際在服務 segment 的那一個（見 Watchdog.getLastSegmentCdn 說明）。
const getPlayingCdnHost = () => {
    try {
        const h = Watchdog.getLastSegmentCdn()
        if (h) return h
    } catch {}
    return lastChosenCdn || activeCdnList[0] || null
}

// v1.3.3：起播緩衝還沒建立起來時，賽馬會直接跟「正在拉的第一批 segment」搶頻寬 ——
// 這正是「開頭加載變慢」最直接的來源。賽馬本身不急，晚幾秒跑結果一樣，但起播慢
// 使用者是立刻看得到的。只延後「起播排程」那種賽馬；Watchdog 偵測到真的卡頓、
// 或週期性重評估（skipIfFast=false）不受影響 —— 那些情境代表已經出事，不能再等。
const STARTUP_MIN_BUFFER_SEC = 12
const MAX_STARTUP_DEFERS     = 3
let bakeoffStartupDefers     = 0
const isStartupBuffering = () => {
    try {
        const st = Watchdog.stats()
        if (!st || st.readyState < 0) return false   // 頁面上沒有播放器，無從判斷
        if (st.paused) return false                  // 使用者還沒開始播，賽馬不會跟誰搶
        return (st.bufferedSec - st.videoTimeSec) < STARTUP_MIN_BUFFER_SEC
    } catch { return false }
}

const runThroughputBakeoff = async (sampleUrl, skipIfFast = true) => {
    if (disabled || resolvedCdn || bakeoffRunning) return
    if (inSeekGrace()) return
    if (!sampleUrl || !isBiliVideoUrl(sampleUrl)) return
    // 綁定節點的串流換 host 必定 403，測了也拿不到任何有效樣本（見 hostLockedStreams）
    if (isHostLockedStream(sampleUrl)) return
    // 冷卻改讀共用時間戳：別的分頁剛測過就不必再測一次（見 BAKEOFF_TS_KEY 說明）
    if (Date.now() - getLastBakeoffAt() < THRPT_BAKEOFF_COOLDOWN) return

    // ★ 起播保護：緩衝還沒到 STARTUP_MIN_BUFFER_SEC 就先讓路，每 2 秒再看一次。
    // 有上限（MAX_STARTUP_DEFERS）—— 否則遇到「怎麼都緩衝不起來」的爛節點時，
    // 這個保護反而會讓賽馬永遠不跑，錯過換掉爛節點的機會。
    if (skipIfFast && bakeoffStartupDefers < MAX_STARTUP_DEFERS && isStartupBuffering()) {
        bakeoffStartupDefers++
        const deferEpoch = bakeoffEpoch
        if (!bakeoffTimer) {
            bakeoffTimer = setTimeout(() => {
                bakeoffTimer = null
                if (deferEpoch !== bakeoffEpoch) return
                runThroughputBakeoff(lastSampleSegmentUrl).catch(() => {})
            }, 2000)
        }
        return
    }

    // 現用節點剛好有新鮮的真實吞吐樣本、且遠高於這支片子實際需要的速度時，
    // 賽馬本身（連續打 1~4 顆候選、每顆最多 768KB）沒有急迫性，反而會在換片起播
    // 最搶頻寬的當下再搶一手頻寬（4K/長片/無損正是這種最禁不起搶的情境）。跳過。
    const preCheckHost = getPlayingCdnHost()
    const preHealth    = preCheckHost && cdnHealth[preCheckHost]
    if (skipIfFast && preHealth && preHealth.samples && preHealth.lastSeen
        && (Date.now() - preHealth.lastSeen) < THRPT_SAMPLE_FRESH_MS
        && preHealth.ewmaMbps >= getRequiredStreamMbps(undefined, 'startup') * 1.5) {
        return
    }

    // 多分頁互斥：優先用 Web Locks API（同源真互斥鎖，跨分頁跨 Worker 都有效，分頁關閉
    // 時瀏覽器自動釋放）。原本只用 BroadcastChannel 心跳判斷「其他分頁是否在測速」，
    // 但那只能盡量避免——兩個分頁幾乎同時決定要測速時，心跳訊息還沒送達對方就都已經
    // 開始了。ifAvailable:true 拿不到鎖立刻回呼 null，不排隊等待。
    if (navigator.locks && navigator.locks.request) {
        return navigator.locks.request('bilicdn-bakeoff', { ifAvailable: true }, (lock) => {
            if (!lock) { log('[Bakeoff] 其他分頁正在測速，本輪跳過'); return }
            return doBakeoff(sampleUrl)
        })
    }
    if (!crossTabShouldBakeoff()) return  // 沒有 Web Locks 的環境：退回心跳判斷
    return doBakeoff(sampleUrl)
}

const doBakeoff = async (sampleUrl) => {
    bakeoffRunning = true
    // 先寫再測：把時間戳提早寫進共用儲存，其他分頁在這一輪還沒跑完時就會被冷卻擋下，
    // 不會出現「兩個分頁同時通過檢查、同時開跑」的競爭窗口。
    setLastBakeoffAt(Date.now())
    // 記下這輪賽馬所屬的片子；換片時 bakeoffEpoch 會遞增，讓下面迴圈提早放棄，
    // 不用等滿整批候選（最多 4 顆 ×3s timeout）才把 bakeoffRunning 讓出來給新片。
    const myEpoch = bakeoffEpoch
    bakeoffAbortController = new AbortController()
    const mySignal = bakeoffAbortController.signal
    onBakeoffStart()                      // 通知其他分頁本分頁開始賽馬
    // 註：不在此 clear forcedRedirectHosts。它是有 10 分鐘 TTL 的 Map（見上方宣告處），
    // 到期會自然過期讓該節點重新進入候選池，不需要也不該在賽馬時手動清空——
    // 手動清空只在 SPA 換片（新的 base_url，舊節點的改寫紀錄已經沒有意義）時做。

    try {
        const now         = Date.now()
        const playingHost = getPlayingCdnHost()
        const candidates  = PREFERRED_CDN_LIST
            .filter(c => !blacklistSet.has(c) && !knownDeadHosts.has(c) && !isCdnSoftBlocked(c) && !matchesExclude(c))
            // ★ 這一行是使用者實測回報的 bug 修正：賽馬只擋 knownDeadHosts，但「已知在台灣
            // 不解析、還沒被標死」的節點不在其中，於是賽馬會拿**真實 segment URL**去打它們，
            // console 出現 ERR_NAME_NOT_RESOLVED（堆疊 doBakeoff → probeCdnThroughput）。
            // 而且傷害不只是紅字：下面那個迴圈是**逐一 await**，每顆死節點都要卡滿
            // THRPT_PROBE_TIMEOUT（3 秒）才輪到下一顆 —— 兩顆就是 6 秒，這 6 秒本來
            // 應該用來測真正可用的節點，時機還正好落在起播附近。
            .filter(c => !isPresumedDnsFailHost(c))
            .filter(c => {
                if (c === playingHost) return false // 正在播放的節點已由 PerformanceObserver 取真樣本
                const h = cdnHealth[c]
                return !(h && h.samples && h.lastSeen && (now - h.lastSeen) < THRPT_SAMPLE_FRESH_MS)
            })
            .slice(0, 4)

        // 高碼率（4K）用較大測速量，分得出節點快慢；一般畫質維持小量省頻寬
        const probeBytes = (currentStreamBitsPerSec / 1e6 >= 12) ? 768 * 1024 : THRPT_PROBE_BYTES
        const ok = []
        for (const c of candidates) {
            if (disabled || myEpoch !== bakeoffEpoch) break
            // 這條串流已知綁定節點 → 剩下的候選不用試了，每一台都會 403（見 hostLockedStreams）
            if (isHostLockedStream(sampleUrl)) break
            const r = await probeCdnThroughput(c, sampleUrl, probeBytes, mySignal)
            // 換 host 拿到 403：登記這條串流，立刻中止本輪。不中止的話剩下的候選會
            // 一顆一顆各再產生一行 403 紅字（使用者實測一輪就看到 3 行）。
            if (r && r.forbidden) { noteHostLockedStream(sampleUrl); break }
            if (r && r.cdn) ok.push(r)
        }

        // 測速被防盜鏈擋掉時 probeCdnThroughput 只會靜默回 null，賽馬形同失效但完全沒有
        // 訊息。連續 3 輪「有候選但全部失敗」才示警，避免單次網路抖動誤報。
        if (candidates.length) {
            if (ok.length === 0) {
                bakeoffNullStreak++
                if (bakeoffNullStreak === 3) {
                    err('[Bakeoff] 連續 3 輪測速全部失敗，可能被 CDN 防盜鏈擋下。'
                        + '可嘗試 BiliCDN.verbose(true) 觀察，或回報此訊息。')
                }
            } else {
                bakeoffNullStreak = 0
            }
        }

        // 這輪賽馬所屬的片子已經被切掉了：拿到的樣本仍照樣入帳（對 CDN 的真實吞吐量測量，
        // 換到哪片都算數），但跳過「中途切換舊主機」這步——playingHost 是舊片的、新片可能
        // 早就用別的 CDN，逼著重導反而多繞一手。新片自己的 scheduleBakeoff 會另外排一輪。
        const stale = myEpoch !== bakeoffEpoch

        // 確保探到的候選在 activeCdnList 內，否則 getHealthyCdnList 不會納入排序
        ok.forEach(r => {
            if (!activeCdnList.includes(r.cdn) && !blacklistSet.has(r.cdn) && !knownDeadHosts.has(r.cdn)) {
                activeCdnList.push(r.cdn)
            }
        })

        // 只重新排序，不縮減集合 —— 跟 reorderCdnsByLatency 裡同一個修正
        //（getHealthyCdnList 的瞬時篩選條件不該寫回候選池母體，否則池子只會越來越薄）。
        // 這裡當初漏改了，是候選池即使修過還是會變薄的第二個來源。
        const ranked = getHealthyCdnList()
        if (ranked.length) {
            const rest = activeCdnList.filter(c => !ranked.includes(c))
            activeCdnList.length = 0
            ranked.forEach(c => activeCdnList.push(c))
            rest.forEach(c => activeCdnList.push(c))
        }

        if (!stale) {
            const best = activeCdnList[0]
            // 勝者明顯比現用節點快 → 強制 worker 把舊主機改寫到勝者（中途切換、不 reload）
            if (best && playingHost && best !== playingHost) {
                const hb = cdnHealth[best], ho = cdnHealth[playingHost]
                const mb = (hb && hb.samples) ? hb.ewmaMbps : 0
                const mo = (ho && ho.samples) ? ho.ewmaMbps : 0
                if (mb > 0 && mb > mo * switchMarginFor(hb ? hb.samples : 0)) {
                    addForcedRedirect(playingHost)
                    // 跟 Watchdog 換節點一樣要給新連線寬限，否則會出現使用者 log 裡那種
                    // 「賽馬切到 cos → 下一個 tick 就懲罰 cos」的序列。
                    try { Watchdog.noteCdnSwitched() } catch {}
                    log('[Bakeoff] 中途切換 ' + playingHost.split('.')[0] + ' → ' + best.split('.')[0]
                        + '（' + mo.toFixed(1) + '→' + mb.toFixed(1) + ' Mbps）')
                }
            }
        }

        promoteBestCdnNow()
        try { GM_setValue(PROBE_CACHE_KEY, JSON.stringify({ t: Date.now(), list: [...activeCdnList] })) } catch {}
    } finally {
        bakeoffRunning = false
        if (bakeoffAbortController && bakeoffAbortController.signal === mySignal) bakeoffAbortController = null
    }
}

const scheduleBakeoff = (sampleUrl) => {
    if (sampleUrl) lastSampleSegmentUrl = sampleUrl
    if (disabled || resolvedCdn || bakeoffTimer) return
    // 4K 開播當下最吃頻寬，測速會跟「初始緩衝」搶頻寬而拖慢起播 →
    // 4K 改為延後較久（先讓畫面開起來、緩衝拉起再測速）；一般畫質維持較短延遲。
    const highBitrate = currentStreamBitsPerSec / 1e6 >= 12
    const myEpoch = bakeoffEpoch
    bakeoffTimer = setTimeout(() => {
        bakeoffTimer = null
        // 換片會在 onSpaNavigate 主動清掉這個 timer，理論上不會用過期 epoch 觸發；
        // 這裡多一層防呆，避免任何遺漏路徑用舊片樣本跑掉這一輪賽馬名額。
        if (myEpoch !== bakeoffEpoch) return
        // 一律用當下最新樣本（而非排程當下 closure 住的那個），避免同一支片內
        // 中途換畫質/CDN 導致 sampleUrl 過期時仍打舊 URL。
        runThroughputBakeoff(lastSampleSegmentUrl).catch(() => {})
    }, highBitrate ? 4000 : 1500)
}

let dashFragmentErrorHooked = false
const installDashFragmentErrorHook = () => {
    if (dashFragmentErrorHooked) return
    dashFragmentErrorHooked = true

    const handleFragmentError = (args) => {
        if (disabled || !args.length) return
        // 便宜篩選優先：Bilibili 播放器在 4K 下 console 很吵，逐則都跑 JSON.stringify
        // 成本不低。先只看字串參數與物件淺層欄位判斷是否命中，命中才做貴的
        // JSON.stringify（用來補撈巢狀較深的 url/code）。
        let hit = false, url = '', code = 0
        for (const arg of args) {
            if (typeof arg === 'string') {
                if (/Fragment Loaded Error|fragmentLoadedError|4105/i.test(arg)) hit = true
            } else if (arg && typeof arg === 'object') {
                if (!url && typeof arg.url === 'string') url = arg.url
                if (!code && Number(arg.code)) code = Number(arg.code)
                if (code === 4105) hit = true
                if (typeof arg.message === 'string' && /Fragment Loaded Error|fragmentLoadedError/i.test(arg.message)) hit = true
            }
        }
        if (!hit) return

        if (!url || !code) {
            const text = args.map(arg => {
                if (arg && typeof arg === 'object') {
                    try { return JSON.stringify(arg) } catch { return '' }
                }
                return String(arg)
            }).join(' ')
            if (!url) {
                const m = text.match(/"url"\s*:\s*"([^"]+)"/)
                if (m) {
                    try { url = JSON.parse('"' + m[1] + '"') } catch { url = m[1] }
                }
            }
            if (!code) {
                const m = text.match(/"code"\s*:\s*(\d+)/)
                if (m) code = Number(m[1])
            }
        }
        if (!url) return

        let host = ''
        try { host = new URL(url).hostname } catch {}
        if (!host) return

        addForcedRedirect(host)
        if (host.endsWith('.bilivideo.com') || host.endsWith('.bilivideo.cn')) {
            recordCdnFailure(host)
            softBlockCdn(host, 'fragment-error-' + (code || 'unknown'), 5 * 60 * 1000)
        }
        promoteBestCdnNow()
        preconnectBatch(getHealthyCdnList().slice(0, 3), true)
        syncWorkerCdnTarget()
        if (lastSampleSegmentUrl && currentStreamBitsPerSec / 1e6 >= 12) {
            setLastBakeoffAt(0)
            // 已經真的出錯（fragment 下載失敗）才會走到這裡，不能被「現用節點目前還算快」擋掉。
            runThroughputBakeoff(lastSampleSegmentUrl, false).catch(() => {})
        }
        log('[Dash] fragment 下載失敗，後續改寫 ' + host.split('.')[0] + ' → ' + getCdnShortName())
    }

    ;['warn', 'error'].forEach(name => {
        const original = console[name]
        if (!original || original.__biliCdnPatched) return
        const wrapped = function (...args) {
            try { handleFragmentError(args) } catch {}
            return original.apply(this, args)
        }
        wrapped.__biliCdnPatched = true
        console[name] = wrapped
    })
}

// 對 host 發 <link rel=preconnect>（同時 dns-prefetch 對較舊瀏覽器雙保險）
// force=true 會 remove 後重插，hint 瀏覽器重評估連線（用於 keep-warm）
const preconnectCdn = (cdn, force) => {
    try {
        if (!cdn) return
        // presumed（已知在台灣不解析、本機從無成功紀錄）也要擋：preconnect 走的一樣是
        // DNS 解析，對 NXDOMAIN 的 host 熱身換不到任何東西。這裡的呼叫端目前都先經過
        // getHealthyCdnList()（會濾掉 presumed），但那是呼叫端的性質、不是這個函式的保證——
        // 死節點機制的設計目標寫的是「跳過所有 probe/preconnect」，就該在這裡也守住。
        if (knownDeadHosts.has(cdn) || blacklistSet.has(cdn) || isCdnSoftBlocked(cdn)
            || matchesExclude(cdn) || isPresumedDnsFailHost(cdn)) return
        const id = 'bilicdn-preconn-' + cdn
        const existing = document.getElementById(id)
        if (existing) {
            if (!force) return
            existing.remove()
        }
        const link = document.createElement('link')
        link.id   = id
        link.rel  = 'preconnect'
        link.href = 'https://' + cdn
        link.crossOrigin = 'anonymous'
        ;(document.head || document.documentElement).appendChild(link)

        const dnsId = 'bilicdn-dns-' + cdn
        if (!document.getElementById(dnsId)) {
            const dns = document.createElement('link')
            dns.id   = dnsId
            dns.rel  = 'dns-prefetch'
            dns.href = 'https://' + cdn
            ;(document.head || document.documentElement).appendChild(dns)
        }
    } catch {}
}

const preconnectBatch = (hosts, force) => {
    ;[...new Set(hosts || [])].forEach(h => h && preconnectCdn(h, force))
}

// 動態收集 Akamai host（從 API/PerformanceObserver 看到的）。只增不減會在長時間
// 連續觀看很多部不同影片時越長越大——每部片可能被導到不同 Akamai edge host，
// keep-warm timer 卻會每 25 秒把整個集合都拿去重新 preconnect，包括幾小時前
// 已經跟目前播放毫無關係的舊片殘留 host，純粹浪費。用上限 + 換片清空控制。
const AKAMAI_HOST_SEEN_MAX = 8
const akamaiHostSeen = new Set()
const noteAkamaiHost = (urlStr) => {
    try {
        const h = new URL(urlStr).hostname
        if (h.endsWith('.akamaized.net') && !akamaiHostSeen.has(h)) {
            if (akamaiHostSeen.size >= AKAMAI_HOST_SEEN_MAX) {
                akamaiHostSeen.delete(akamaiHostSeen.values().next().value)
            }
            akamaiHostSeen.add(h)
            preconnectCdn(h)
        }
    } catch {}
}

// document-start 階段就 preconnect（不等 probe，seek 第一刀已來不及）——這件事現在由
// 下方的 startCdnProbe() 負責，這裡刻意不再做。
//
// v1.3.3：舊版在這裡對「整份白名單」無差別開連線（扣掉死節點與排除關鍵字還有 6 個），
// 但一次播放最多只會用到 3 個（primary + 2 個 backup）。多出來的 3 條全是純浪費，
// 而且浪費的時機正是最不該浪費的 document-start —— 頁面 HTML/JS/CSS 還在下載、
// playurl 正要發出。跨海連線一條 preconnect 是 DNS + TCP(1 RTT) + TLS(約 2 RTT)，
// 六條同時開會佔滿 DNS 解析器與 socket 配額，跟真正要用的那幾條互搶。
// 更糟的是它連「解析不出來的 host」也照開（例如台灣的 upos-hz-mirroraliov），
// 在首次升級、還沒被標死之前，等於在起播當下白白排隊等一次 DNS 失敗。
//
// 改由 startCdnProbe() 用 getCurrentCdn(STARTUP_PICK) + getHealthyCdnList(STARTUP_PICK)
// 精準熱身「playurl 這次真的會寫進去」的那 3 個。兩者中間只有同步的模組初始化，
// 不會有任何網路行為，所以時機完全沒有損失；順帶修掉「腳本已停用（disabled）時
// 這行照樣開六條連線」的舊行為。

// reorderCdnsByLatency 自己的重入旗標：原本完全沒有防呆，兩個 reorderCdnsByLatency(true)
// 幾乎同時觸發時（例如卡頓 switchCdn 與週期性重評估疊在一起）會交錯清空/填入
// activeCdnList，後完成的一個覆蓋先完成的結果。也順便避開跟 runThroughputBakeoff 同時
// 動 activeCdnList——只在這個方向擋（bakeoff 執行中就不搶著跑 reorder），因為
// switchCdn 是先發 reorder 再發 bakeoff，若反向互擋，bakeoff 會被剛啟動的 reorder
// 立刻擋掉，等於卡頓時「立刻實測」這個功能被靜默失效。
let reorderRunning = false
// ── 起播期間不跑全量延遲探測（v1.3.3）────────────────────────────────
// reorderCdnsByLatency 在探測快取沒命中時，會對每個候選發一次 Image 探測（v1.3.3 之後
// 還多一次可達性確認 fetch），而它被呼叫的時機是 document-start —— 頁面 HTML/JS/CSS
// 還在下載、playurl 正要發出的當下。等於在最搶頻寬與 DNS 解析器的那一刻，多打十幾個
// 跟這次播放無關的請求。
//
// 說「無關」是有根據的：這份排序的產物（activeCdnList 的 index 順序）在
// getHealthyCdnList() 裡**只是「所有候選都沒有實測樣本」時的退路**——只要有任何一個
// 候選有 samples，排序就完全由 score 決定，index 只當同分時的 tie-break。也就是說對
// 已經用過一陣子的使用者，這批探測請求對「這次要選哪個節點」毫無貢獻。
//
// 改成：已經有健康資料就延後到起播緩衝建立之後再跑；完全沒有樣本（全新安裝、或剛
// BiliCDN.reset()）才立刻跑，因為那時候真的只能靠延遲排序決定順序。
// 代價：死節點偵測（DNS 解析失敗）也跟著延後。可以接受——handleSegmentConnError 會在
// 第一次真的失敗時就確認並標死，不必等這輪探測；而且探測快取在版本升級時已被清掉，
// 延後的那一輪照樣會把死節點掃出來。
const PROBE_DEFER_CHECK_MS = 2000
const MAX_PROBE_DEFERS     = 6      // 最多讓路 12 秒
let deferStartupProbes = true
let probeDeferCount    = 0
let probeDeferTimer    = null

const hasUsableCdnHealth = () => activeCdnList.some(c => {
    const h = cdnHealth[c]
    return !!h && h.samples > 0 && !knownDeadHosts.has(c) && !blacklistSet.has(c)
})

// 讓路 / 重排共用同一個有界計數器。兩種情況都會走到這裡：
//   1. 還在起播緩衝階段 → 讓路，等一下再看
//   2. reorderCdnsByLatency 被 reorderRunning / bakeoffRunning 擋下 → 重排，不能丟掉
// 兩者都必須有上限：情況 1 沒上限會讓「怎麼都緩衝不起來」的爛節點永遠不被掃出來；
// 情況 2 沒上限的話，萬一 bakeoffRunning 因故卡住，就會變成每 2 秒空轉一次的無窮迴圈。
const scheduleDeferredLatencyProbe = () => {
    if (probeDeferTimer) return
    if (probeDeferCount >= MAX_PROBE_DEFERS) {
        // 讓夠了。放行，交給之後自然會發生的觸發點（換片、卡頓、週期性重評估）。
        deferStartupProbes = false
        return
    }
    probeDeferCount++
    probeDeferTimer = setTimeout(() => {
        probeDeferTimer = null
        if (isStartupBuffering()) { scheduleDeferredLatencyProbe(); return }
        deferStartupProbes = false
        reorderCdnsByLatency().catch(() => {})
    }, PROBE_DEFER_CHECK_MS)
}

const reorderCdnsByLatency = async (force) => {
    if (disabled) return
    if (resolvedCdn) { preconnectCdn(resolvedCdn); return }
    // ★ seek 保護窗：拖時間軸之後播放器要把新位置的 segment 全部重抓，那是全片最吃
    // 頻寬的一刻。這一輪探測會同時對 4~6 個候選各發一個請求，跟 seek 的 segment 直接互搶
    // —— 使用者實測回報「跳轉緩衝變慢」。
    //
    // 這條規則在這支腳本裡本來就成立（賽馬 runThroughputBakeoff、Watchdog 的
    // scheduleDelayedReorder、keep-warm 的 preconnectBatch 都各自檢查 inSeekGrace()），
    // 只有延遲探測漏掉了 —— 因為它以前跑在 document-start，那時候使用者根本還不可能 seek。
    // 改成延後執行之後才暴露出這個缺口。
    //
    // force=true 不受限（使用者手動 BiliCDN.probe()、或 Watchdog 判定已經出事而主動重評估，
    // 那些情境本來就該立刻跑，而且呼叫端自己已經檢查過 seek 狀態）。
    if (reorderRunning || bakeoffRunning || (!force && inSeekGrace())) {
        // 舊版在這裡直接 return，等於把這一輪**永久丟掉**。配合延後探測的設計，
        // 這會變成：延後排程好不容易等到緩衝建立、卻剛好撞上正在跑的賽馬 → 探測整輪消失，
        // 於是「該被標死的節點永遠沒機會被標死」，賽馬每 90 秒又去打它一次。
        // 使用者回報的 ERR_NAME_NOT_RESOLVED 會反覆出現，這是其中一環。改成重新排程。
        // 不看 deferStartupProbes：延後的那一輪自己會先把它設成 false，若在這裡才撞上賽馬，
        // 加上判斷等於又把它丟掉一次。scheduleDeferredLatencyProbe 自己有次數上限。
        scheduleDeferredLatencyProbe()
        return
    }
    reorderRunning = true

    try {
        // Cache hit → 完全不發探測請求
        if (!force) {
            try {
                const cached = JSON.parse(GM_getValue(PROBE_CACHE_KEY) || 'null')
                if (cached && (Date.now() - cached.t) < PROBE_CACHE_TTL && Array.isArray(cached.list)) {
                    // 快取只決定「順序」，不決定「成員」。
                    // 舊版是照著快取清單重建 activeCdnList，於是某一輪縮水後的結果會被
                    // 醃在快取裡整整兩小時：之後每次載入都照著那份短清單重建，池子再也長不回來
                    //（使用者實測回報 active 只剩 1 個節點，就是這樣來的）。
                    // 現在快取裡有的照原順序放前面，其餘「當下沒有任何理由排除」的候選補在後面。
                    const usable = (c) => !blacklistSet.has(c) && !knownDeadHosts.has(c)
                        && !isCdnSoftBlocked(c) && PREFERRED_CDN_LIST.includes(c)
                    activeCdnList.length = 0
                    cached.list.forEach(c => { if (usable(c)) activeCdnList.push(c) })
                    PREFERRED_CDN_LIST.forEach(c => {
                        if (usable(c) && !activeCdnList.includes(c)) activeCdnList.push(c)
                    })
                    if (activeCdnList.length) {
                        promoteBestCdnNow()
                        preconnectBatch(activeCdnList.slice(0, 3))
                        syncWorkerCdnTarget()
                        return
                    }
                }
            } catch {}
        }

        // ★ 起播讓路：快取沒命中、但已經有健康資料足以決定節點時，把「真的發探測請求」
        // 延後到起播緩衝建立之後（見上方 deferStartupProbes 說明）。
        if (deferStartupProbes && !force && hasUsableCdnHealth()) {
            scheduleDeferredLatencyProbe()
            return
        }
        // presumed 節點現在一律跳過探測（見下方候選過濾），不再需要區分「是不是起播那一輪」，
        // 原本的 isStartupRun 也就沒有讀者了，一併移除。
        deferStartupProbes = false

        const candidates = PREFERRED_CDN_LIST.filter(h => {
            if (knownDeadHosts.has(h) || isCdnSoftBlocked(h)) return false
            // 已知在台灣不解析的節點一律不發探測請求：那個請求**必定**失敗、必定在
            // console 印一行 ERR_NAME_NOT_RESOLVED，而它換不到任何新資訊——
            // isPresumedDnsFailHost() 的定義本來就是「在已知壞清單裡，而且本機從來沒有
            // 成功過」，答案已經確定了，再打一次只是把它重新確認一遍。
            //
            // ★ 2026-08-19 修正：舊條件是 `isStartupRun && !force && ...`，有兩個洞，
            // 使用者實測回報的紅字就是從這兩個洞出來的：
            //   1. `!force` —— Watchdog 判定卡頓後會呼叫 reorderCdnsByLatency(true)
            //      重新評估（見 switchCdn），那也是 force=true，於是每次卡頓都繞過這道
            //      過濾、對 hwov / hz-aliov 各打一發必定失敗的請求。這才是紅字的主要來源，
            //      頻率遠高於原本以為的「30 天一次」。
            //   2. `isStartupRun` —— 只擋起播那一輪，延後的那一輪照打不誤。
            // 改成**一律跳過，沒有例外**。曾經留過一個 includePresumed 出口讓
            // BiliCDN.probe() 仍可實測它們，但那是自相矛盾的：探測是 no-cors、讀不到
            // 狀態碼，量到的數字本來就不足以讓節點重回候選池（見候選池重建處的說明）——
            // 於是那一發請求換不到任何能拿來做決定的資訊，只剩下 console 一行紅字。
            // 使用者實測回報 `upos-sz-mirrorhw ... 959` 那行就是它。偵測機制本身不該是噪音來源。
            // 想確認某個節點在你的網路上到底行不行，唯一有意義的作法是讓它**真的去服務
            // segment**：BiliCDN.setCdn("<完整 host>")，成功後 successes/samples 會寫入，
            // isPresumedDnsFailHost() 自動失效。
            //
            // 跳過探測不會讓它們被誤用：getHealthyCdnList() 在選路時本來就會濾掉 presumed
            // 節點，diag() 也有專屬的「已知不解析、暫不使用（presumed）」欄位交代原因；
            // 萬一真的被指派到 segment，handleSegmentConnError 會立刻收拾。
            if (isPresumedDnsFailHost(h)) return false
            return true
        })
        const results = await Promise.all(candidates.map(probeCdnLatency))
        // ★ 排序用「跨輪平滑後的估計值」，不是這一輪的原始值。
        // 單輪的 r.ms 幾乎完全由「這條連線當下是冷是熱」決定（實測冷熱差距：ali 冷 6.4s
        // vs 暖 0.4s，超過十倍），拿它當唯一依據等於讓節點順序隨機跳動。而 activeCdnList
        // 的順序在「所有節點都還沒有吞吐量樣本」時，正是 getHealthyCdnList() 的排序依據
        // （見該函式結尾的 a.index - b.index），所以這個雜訊會一路傳到選路。
        //
        // 使用者實測（2026-08-19，吞吐量資料剛重置、samples 全為 0 的狀態）：
        // 這一輪排出 [ali, cos, aliov]，aliov 敬陪末座——但同一份診斷裡 aliov 的
        // latencyMs 是 142ms、cos 是 516ms，curl 實測 TTFB 更是 aliov ~70ms / ali ~560ms /
        // cos ~1000ms。等於把最快的節點排到最後，而且下次重整可能又換一個順序。
        //
        // cdnHealth[].latencyMs 是 recordCdnLatency() 維護的 EWMA（本輪的值已經併進去了），
        // 天生就是為了吸收這種抖動而存在的，先前卻沒有被排序用到。
        const sortKey = (r) => {
            if (!Number.isFinite(r.ms)) return Infinity
            const hh = cdnHealth[r.cdn]
            return (hh && hh.latencyMs) ? hh.latencyMs : r.ms
        }
        results.sort((a, b) => sortKey(a) - sortKey(b))

        // probeCdnLatency 回傳的 reason（'DNS' / 'timeout'）過去只被寫入、沒有任何地方讀，
        // 是不折不扣的死屬性。選擇補上這行輸出而不是刪掉它：使用者在 console 看到
        // ERR_NAME_NOT_RESOLVED 時，最想知道的就是「腳本有沒有認出這件事、認成什麼」，
        // 而這正是唯一能回答的地方。輸出受 Config.verbose 控制，預設靜音。
        const failed = results.filter(r => r.reason)
        if (failed.length) {
            log('[探測] 判定不可用：' + failed.map(r => r.cdn.split('.')[0] + '(' + r.reason + ')').join('、'))
        }

        // ★ 探測「量到了」不等於「可以用」。`confirmHostReachable()` 與 `probeCdnLatency()`
        // 都是 no-cors fetch，拿到的是 opaque response —— **讀不到狀態碼**。所以對一個
        // 回 959（Bilibili 對台灣 IP 的區域拒絕，本來就在 HARD_FAIL_STATUSES 裡）的節點，
        // 探測層看到的只是「伺服器有回應」＝可達，於是給它一個有限的延遲值。
        // 使用者實測（2026-08-19）跑 BiliCDN.probe() 就撞到這個：`upos-sz-mirrorhw`
        // 回 959，卻被判成可達，**重新回到 activeCdnList 第 4 位**（只被軟隔離 5 分鐘）。
        //
        // 所以候選池重建要把 presumed 節點濾掉：一次 `/crossdomain.xml` 的 opaque 回應
        // 根本回答不了「這台能不能服務影片」這個問題，沒有資格解除「已知在台灣不可用」的
        // 推定。真正有資格解除它的是**實際服務過 segment**（那會寫進 successes/samples，
        // isPresumedDnsFailHost() 隨即轉為 false），而不是一次探測。
        activeCdnList.length = 0
        for (const r of results) {
            if (!blacklistSet.has(r.cdn) && !knownDeadHosts.has(r.cdn)
                && !isPresumedDnsFailHost(r.cdn) && r.ms !== Infinity) {
                activeCdnList.push(r.cdn)
            }
        }
        if (activeCdnList.length === 0) {
            PREFERRED_CDN_LIST.forEach(c => {
                if (!blacklistSet.has(c) && !knownDeadHosts.has(c) && !isPresumedDnsFailHost(c)) {
                    activeCdnList.push(c)
                }
            })
        }
        // 只重新排序，**不縮減集合**。getHealthyCdnList() 會濾掉「此時此刻」失敗次數
        // 超標 / 分數過差 / 已知不解析的節點，那是選路當下該有的判斷；但 activeCdnList
        // 是整個 session 的候選池母體，被它濾掉的節點若就此從母體消失，一次瞬間的壞狀態
        // 就會變成「接下來兩小時都不再考慮這個節點」——要等下一輪探測（PROBE_CACHE_TTL
        // 兩小時）從 PREFERRED_CDN_LIST 重建才回得來。這是個單向棘輪，候選池只會越來越薄，
        // 也是診斷面板裡「白名單順序」有時只剩一兩個節點的成因。
        // 排到的照 ranked 順序放前面，沒排到的維持在後面備用。
        const ranked = getHealthyCdnList()
        if (ranked.length) {
            const rest = activeCdnList.filter(c => !ranked.includes(c))
            activeCdnList.length = 0
            ranked.forEach(c => activeCdnList.push(c))
            rest.forEach(c => activeCdnList.push(c))
        }

        try {
            GM_setValue(PROBE_CACHE_KEY, JSON.stringify({ t: Date.now(), list: [...activeCdnList] }))
        } catch {}

        if (activeCdnList[0]) {
            preconnectBatch(activeCdnList.slice(0, 3), force)
            syncWorkerCdnTarget()
        }
    } finally {
        reorderRunning = false
    }
}

// ── 緩衝 Watchdog ─────────────────────────────────────────────────────
// 用 PerformanceObserver 累計 m4s/flv 下載量，每 1 秒檢查 buffered 是否成長
// 連續 STALL_MAX tick 卡頓 → 黑名單當前 CDN + 重 probe（讓攔截層自動切）
// 達到動態緩衝目標後停止監測，避免跟 player 自救邏輯互相干擾
const Watchdog = (() => {
    const TICK_MS           = 1000
    const STALL_MAX         = 3
    const MIN_BPS_FLOOR     = 350 * 1024
    const URGENT_BUFFER_SEC = 5
    // ★ 換節點的**危險線**，跟上面的目標線是兩回事。
    // minAheadEff（高碼率 30 秒）是「我們希望存這麼多」的目標；換節點是很貴的動作
    // （丟掉熱連線、重做 TCP+TLS、懲罰殘留 10 分鐘），只有在緩衝真的快撐不住時才該做。
    //
    // 用目標線當觸發條件會產生**結構性誤判**：B 站播放器抓 segment 是一陣一陣的
    //（抓一批 → 閒置等緩衝被播掉 → 再抓一批）。閒置期間 buffered.end 不動、
    // bufferAhead 持續下降 —— 完全正常，但這跟「停滯 + 緩衝流失」的特徵一模一樣。
    // 只要播放器自己的穩態緩衝低於我們的目標線（4K 幾乎必然如此），**每一個閒置週期
    // 都會被判成卡頓**，於是每隔幾秒就換一次節點。
    //
    // 使用者實測 log 的鐵證：賽馬量到 cos 有 29.3 Mbps（高於該片需求的 25.65 Mbps），
    // 卻照樣被判「buffered 停滯」並懲罰。速度明明夠，問題出在判定條件。
    const STALL_DANGER_SEC  = 10
    const REACHED_RECHECK_BUFFER_SEC = 10
    const SWITCH_COOL       = 5000
    // 剛 reset（開播/換片）那幾秒，TCP/TLS 連線還在 slow-start，量到的瞬時 bps 天生偏低，
    // 不是 CDN 真的慢。尤其高碼率（4K/長片/無損）換片後最需要這段緩衝時間才能量出真實速度，
    // 太早判定反而白白觸發一次換節點（重新 DNS/TCP/TLS 又更慢）。高碼率多給一點餘裕。
    const STARTUP_GRACE_MS       = 3000
    const STARTUP_GRACE_MS_HIGH  = 5000

    let totalBytes        = 0
    let lastBufferedEnd   = 0
    let lastCurrentTime   = 0
    let stallCount        = 0
    // v1.3.3：bps 與緩衝趨勢的滑動視窗（見 tick 內說明）。長度必須大於「播放器抓一段
    // 的週期」，否則視窗頭尾會落在週期的不同相位，量到的是取樣假象而不是真實趨勢。
    // B 站的 segment 約 4~6 秒，取 8 秒可以穩定跨過一個完整週期；再長則對真正的
    // 卡頓反應會變遲鈍（stallMax 本來就還要連續數個 tick 才動作）。
    const BPS_WINDOW_MS   = 8000
    let byteSamples       = []
    let lastSwitchAt      = 0
    // ── 換節點斷路器 ────────────────────────────────────────────────
    // 舊版 switchCdn 只有 SWITCH_COOL（兩次切換間隔 5 秒）這一道防線，
    // sessionSwitchCount 雖然有累加卻從來沒被拿來當煞車。後果在使用者實測 log 裡很清楚：
    // buffered 停滯持續成立 → 每 5 秒懲罰一個節點 → aliov、cos、hwov、hw 輪流中槍 →
    // 白名單全被封光 → 觸發緊急「已全部清除」→ 從頭再來一輪，一直循環。
    //
    // 但這種情況下瓶頸根本不在節點：那支片需要 25.65 Mbps（4K），跨境線路或使用者頻寬
    // 撐不住時，換到哪個節點都一樣。而繼續換只會更糟——每換一次就丟掉一條熱連線、
    // 重做一次 TCP+TLS 握手，懲罰還會殘留 10 分鐘以上，連帶拖累接下來幾部片。
    //
    // 斷路器：觀察窗內連續切換達到上限就停手一段時間，並**收回這一波的懲罰**
    // （既然判定不是節點的錯，就不該讓它們背這個鍋去影響之後的選路）。
    const SWITCH_BURST_MAX    = 3
    const SWITCH_BURST_WINDOW = 60 * 1000
    const SWITCH_BREAKER_MS   = 90 * 1000
    let switchTimes        = []
    let switchBreakerUntil = 0
    let burstPunished      = []

    const retractBurstPenalties = () => {
        const hosts = [...new Set(burstPunished)]
        burstPunished = []
        hosts.forEach(host => {
            const h = cdnHealth[host]
            if (h && h.failures > 0) h.failures--
            if (cdnSoftBlockUntil[host]) {
                delete cdnSoftBlockUntil[host]
                if (h) {
                    h.lastSoftBlockReason = ''
                    if (h.softBlocks > 0) h.softBlocks--
                }
            }
            if (!activeCdnList.includes(host) && !blacklistSet.has(host)
                && !knownDeadHosts.has(host) && PREFERRED_CDN_LIST.includes(host)) {
                activeCdnList.push(host)
            }
        })
        if (hosts.length) {
            scheduleCdnHealthSave()
            promoteBestCdnNow()
        }
        return hosts
    }
    let lastNudgeDetectAt = 0
    let lastTickAt        = 0
    let observer          = null
    let timer             = null
    let started           = false
    let startedAt         = 0
    // 剛換過節點：新連線要重做 TCP+TLS 並經歷 slow-start，這段期間量到的速度天生偏低、
    // buffered.end 也還沒開始動。不給寬限的話會出現使用者 log 裡那種
    // 「賽馬切到 cos → 下一個 tick 就懲罰 cos」的荒謬序列 —— 新節點根本還沒機會表現。
    let switchGraceUntil  = 0
    let reached           = false
    let sessionSwitchCount = 0
    let sessionStallCount  = 0
    let sessionHardFailCount = 0
    let lastSegmentCdn     = null
    const perCdnBytes     = {}

    const getWatchdogSample = () => ({
        totalBytes,
        stallEvents: sessionStallCount,
        switchCount: sessionSwitchCount,
        hardFailCount: sessionHardFailCount,
        elapsedSec: Math.max(1, (Date.now() - startedAt) / 1000),
        reachedTarget: reached,
    })

    const onEntry = (entry) => {
        if (!entry || !entry.name) return
        if (!/\.m4s($|\?)/i.test(entry.name) && !/\.flv($|\?)/i.test(entry.name)) return
        // 這個 segment 若已經被 XHR/fetch 攔截層直接量過真實位元組（見 noteSegmentBytes /
        // fetch 攔截的 content-length 分支），這裡就跳過，避免同一包重複計入兩次。
        // 這條路徑只在對方量不到時（例如非我方攔截的請求）當備援。
        if (wasSegmentAccounted(entry.name)) return
        const bytes = entry.transferSize || entry.encodedBodySize || 0
        if (!bytes) return
        totalBytes += bytes
        try {
            const h = new URL(entry.name).hostname
            lastSegmentCdn = h
            perCdnBytes[h] = (perCdnBytes[h] || 0) + bytes
            // 用最新觀察到的播放倍速計算 required Mbps，避免倍速下少抓 slow
            const v = getVideo()
            const rate = v && v.playbackRate ? v.playbackRate : latestPlaybackRate
            // entry.duration 含 redirect/DNS/TCP/TLS/TTFB，跟 XHR/fetch 路徑（只算純傳輸時間）
            // 量綱不一致，混在同一個 EWMA 裡會系統性高估這條路徑的速度。優先用
            // responseEnd-responseStart（純傳輸），兩者缺一（未送 Timing-Allow-Origin）才退回 duration。
            const dur = (entry.responseEnd && entry.responseStart)
                ? (entry.responseEnd - entry.responseStart)
                : (entry.duration || 0)
            recordCdnThroughput(h, bytes, dur, rate)
        } catch {}
    }

    // onEntry() 每個 segment 都呼叫一次 getVideo()，4K 下可能每秒好幾次全文件 querySelectorAll。
    // 快取命中的 video 元素，只有它被拔掉（換片重建播放器）才重新掃描。
    let cachedVideo = null
    const getVideo = () => {
        if (cachedVideo && cachedVideo.isConnected && cachedVideo.clientWidth) return cachedVideo
        let best = null, bestArea = 0
        document.querySelectorAll('video').forEach(v => {
            const a = (v.clientWidth || 0) * (v.clientHeight || 0)
            if (a > bestArea) { bestArea = a; best = v }
        })
        cachedVideo = best
        return best
    }

    const bufferedEnd = (v) => {
        try {
            if (!v || !v.buffered || v.buffered.length === 0) return 0
            return v.buffered.end(v.buffered.length - 1)
        } catch { return 0 }
    }

    const fmtMB = (b) => (b / 1024 / 1024).toFixed(2)

    const noteSeek = () => {
        stallCount = 0
        bumpSeekGrace()
    }

    // 任何「換到另一個節點」之後都該呼叫：重置停滯累計與 buffered 基準，
    // 並給新連線一段寬限。Watchdog 自己換節點時會呼叫，賽馬中途切換也會（見 doBakeoff）。
    const noteCdnSwitched = () => {
        stallCount = 0
        lastBufferedEnd = 0
        byteSamples = []
        switchGraceUntil = Date.now()
            + ((currentStreamBitsPerSec / 1e6 >= 12) ? STARTUP_GRACE_MS_HIGH : STARTUP_GRACE_MS)
    }

    const switchCdn = (reason) => {
        if (inSeekGrace()) return
        const nowSw = Date.now()
        if (nowSw < switchBreakerUntil) return
        if (nowSw - lastSwitchAt < SWITCH_COOL) return

        // 斷路器（見上方宣告處的完整說明）：短時間內已經換過太多次還是沒改善，
        // 代表問題不在節點，停手並收回這一波的懲罰。
        switchTimes = switchTimes.filter(t => nowSw - t < SWITCH_BURST_WINDOW)
        if (switchTimes.length >= SWITCH_BURST_MAX) {
            switchBreakerUntil = nowSw + SWITCH_BREAKER_MS
            switchTimes = []
            const retracted = retractBurstPenalties()
            log('[Watchdog] ' + Math.round(SWITCH_BURST_WINDOW / 1000) + ' 秒內已切換 '
                + SWITCH_BURST_MAX + ' 次仍未改善，判定瓶頸不在節點'
                + '（頻寬 / 碼率 / 跨境線路），暫停切換 '
                + Math.round(SWITCH_BREAKER_MS / 1000) + ' 秒'
                + (retracted.length ? '；收回本波懲罰：' + retracted.map(h => h.split('.')[0]).join('、') : ''))
            return
        }
        switchTimes.push(nowSw)
        lastSwitchAt = nowSw
        sessionSwitchCount++
        // 換完之後給新連線一段 slow-start 寬限，別讓下一個 tick 立刻又判它有罪。
        noteCdnSwitched()

        if (HttpDnsAutoPilot.onStall(reason, getWatchdogSample())) {
            promoteBestCdnNow()
            reorderCdnsByLatency(true).catch(() => {})
            return
        }

        // 只懲罰「最近實際在拉 segment」的元兇，避免歷史用過的 CDN 被連坐。
        // 排除 Akamai/MCDN/PCDN/已黑名單/已標死 等本來就會走 fallback 的 host。
        let culprit = null
        if (lastSegmentCdn
            && !lastSegmentCdn.endsWith('.akamaized.net')
            && !isUnstableCdnHost(lastSegmentCdn)
            && !blacklistSet.has(lastSegmentCdn)
            && !knownDeadHosts.has(lastSegmentCdn)) {
            culprit = lastSegmentCdn
        }

        // 沒有 lastSegmentCdn（極少見：尚未拉任何 segment）時，
        // 退回 active 第一名做保守懲罰；同樣排除不穩定/已封鎖節點。
        if (!culprit) {
            const fallback = activeCdnList.find(h =>
                h
                && !h.endsWith('.akamaized.net')
                && !isUnstableCdnHost(h)
                && !blacklistSet.has(h)
                && !knownDeadHosts.has(h)
            )
            if (fallback) culprit = fallback
        }

        if (culprit) {
            recordCdnPenalty(culprit, false)
            softBlockCdn(culprit, reason, CDN_SOFT_BLOCK_MS)
            burstPunished.push(culprit)   // 斷路器跳脫時要能把這一波的懲罰收回去
            log('[Watchdog] 切換觸發：' + reason + '，懲罰 ' + culprit.split('.')[0])
        }

        try { GM_deleteValue(PROBE_CACHE_KEY) } catch {}
        promoteBestCdnNow()
        // 卡頓當下要搶頻寬給「新目標」熱身，但不能連帶拆掉現用節點的連線：
        // preconnectCdn(force=true) 會 remove() 舊 <link> 再重建，讓瀏覽器有機會回收那條
        // idle socket。culprit/lastSegmentCdn 正是現在在用的連線，排除在 force 名單外，
        // 只用 force=false（已存在就不動）補一份，真正需要熱身的是「接下來要換過去」的候選。
        const warmTargets = getHealthyCdnList().slice(0, 3).filter(h => h !== lastSegmentCdn)
        preconnectBatch(warmTargets, true)
        if (lastSegmentCdn) preconnectCdn(lastSegmentCdn, false)
        // 延遲探測（探測 RTT）本身也在搶頻寬，且卡頓當下最有參考價值的是賽馬（真實 segment）。
        // 延後 10 秒、且確認不在 seek 預熱窗內才跑，讓賽馬/換節點先把頻寬用在刀口上。
        // reorderCdnsByLatency 內部有 bakeoffRunning 互斥（見該函式），4K 賽馬最長可能跑
        // 到 ~12 秒，剛好可能跟這裡的 10 秒延遲重疊——若當下還在跑，reorderCdnsByLatency
        // 會直接靜默放棄且不會重試。這裡補一次有限重試，避免整個延遲探測憑運氣决定有沒有跑。
        // seek 預熱窗（inSeekGrace）撞上同一個時間點時道理相同，一併納入重試，不然使用者
        // 剛好在第 10 秒拖曳時間軸，這次延遲探測就會被無聲放棄、不會像 bakeoffRunning
        // 那樣有重試機會。
        const scheduleDelayedReorder = (retriesLeft) => {
            setTimeout(() => {
                if ((inSeekGrace() || bakeoffRunning) && retriesLeft > 0) { scheduleDelayedReorder(retriesLeft - 1); return }
                if (inSeekGrace()) return
                reorderCdnsByLatency(true).catch(() => {})
            }, 10000)
        }
        scheduleDelayedReorder(2)
        // 4K：卡頓多半是節點速度不夠，立刻實測各節點下載速度，確保切到真的夠快的節點
        // Watchdog 已經判定停滯才會走到這裡，不能被「現用節點目前還算快」的捷徑擋掉。
        if (currentStreamBitsPerSec / 1e6 >= 12 && lastSampleSegmentUrl) {
            setLastBakeoffAt(0)
            runThroughputBakeoff(lastSampleSegmentUrl, false).catch(() => {})
        }
        // 不 nudge currentTime：跟 bili player 內建 Stuck:Rescue 搶會 buffer 抖動
        // 軟封鎖 + 下次 segment 走攔截層改 host 就夠
    }

    const tick = () => {
        const v = getVideo()
        if (!v) return

        // v1.3.3：先把碼率校正成「實際正在播的畫質」，下面所有門檻
        // （highBitrate / minBps / minAheadEff / targetBytes）才會是對的。
        syncStreamBitrateFromVideo(v)

        // 背景分頁偵測：瀏覽器會把 timer 節流（背景 ≥1/min、5 分後更嚴）。
        // tick 間隔遠大於 1s 代表剛從背景切回，期間 bps/buffered 取樣全部失真，
        // 此時若照常判定會誤以為 CDN 變慢而切換 → 切回前景反而 reload。
        // 只重設基準、清 stallCount，跳過這一輪。
        const nowTick   = Date.now()
        const sinceLast = lastTickAt ? nowTick - lastTickAt : TICK_MS
        lastTickAt      = nowTick
        if (sinceLast > TICK_MS * 3) {
            byteSamples     = []   // v1.3.3：背景節流期間的取樣全部失真，整批丟掉重來
            lastCurrentTime = v.currentTime
            lastBufferedEnd = bufferedEnd(v)
            stallCount      = 0
            return
        }

        const be  = bufferedEnd(v)
        // v1.3.3：bps 改用滑動視窗，不再用「單一 tick 的位元組差」。
        // 播放器抓 segment 是一陣一陣的：抓完一段就閒置好幾秒，再抓下一段。
        // 用單秒差值來看，這些「正常的段間空檔」會被算成 bps≈0，而 stallMaxEff 在
        // 高碼率下只有 2 —— 也就是「連續兩秒沒下載」就換節點。但連續兩三秒沒下載
        // 對分段下載來說完全正常，於是好節點會被無故懲罰、軟隔離、換掉。
        // 改成看最近 BPS_WINDOW_MS 的平均，跨過段間空檔，量到的才是真實吞吐。
        byteSamples.push({ t: nowTick, bytes: totalBytes, ahead: Math.max(0, be - v.currentTime) })
        while (byteSamples.length > 1 && nowTick - byteSamples[0].t > BPS_WINDOW_MS) byteSamples.shift()
        const oldestSample = byteSamples[0]
        const bpsSpanSec = Math.max(0.2, (nowTick - oldestSample.t) / 1000)
        const bps = (totalBytes - oldestSample.bytes) / bpsSpanSec
        const playRate = v.playbackRate || 1
        latestPlaybackRate = playRate
        const targetBytes = getBufferTargetBytes(playRate)

        if (!reached && totalBytes >= targetBytes) {
            reached = true
            HttpDnsAutoPilot.onTargetReached(getWatchdogSample())
        }

        HttpDnsAutoPilot.tick(getWatchdogSample())

        // 偵測 bili player [Stuck:Rescue]：
        // 1x 正常播放每秒 ctDelta ≈ 1.0，舊邏輯 ctDelta>0.1 && <1.5 會把它誤判為 nudge，
        // 導致 stallCount 永遠被歸零、watchdog 失效。
        // 改成「實際前進量 - 預期前進量」大於 0.15s 才視為 player 自救跳轉。
        const ct           = v.currentTime
        const ctDeltaRaw   = ct - lastCurrentTime
        const ctDeltaAbs   = Math.abs(ctDeltaRaw)
        const expectedDelta = (v.paused || v.seeking) ? 0 : playRate * (TICK_MS / 1000)
        const nudgeOver    = ctDeltaRaw - expectedDelta
        // Stuck:Rescue 通常一次跳 0.1~1.5 秒，外加正常前進量
        const playerNudge  = !v.paused && nudgeOver > 0.15 && nudgeOver < 1.6
        // 大跳（含倒帶）視為 user seek
        const userSeek     = ctDeltaAbs >= 2 || ctDeltaRaw < -0.1
        lastCurrentTime = ct

        if (userSeek) noteSeek()

        if (playerNudge) {
            lastNudgeDetectAt = Date.now()
            stallCount = 0
            lastBufferedEnd = be
            return
        }
        // seek 到未載入區段時，播放器通常會 abort 舊請求並重建新 segment；
        // 這段時間 bps=0 是正常狀態，不能當作 CDN 卡頓。
        if (inSeekGrace()) {
            stallCount = 0
            lastBufferedEnd = be
            return
        }
        // 自救後短時間內不重複判定卡頓
        if (Date.now() - lastNudgeDetectAt < 3000) {
            stallCount = 0
            lastBufferedEnd = be
            return
        }

        // buffered.end 在超前緩衝充足時播放中常不變（僅 start 前移），勿當停滯
        const bufferAhead = Math.max(0, be - ct)
        const playing = !v.paused && !v.seeking && v.readyState >= 2

        // 高碼率（4K / 高 fps）：下載速度只要低於即時碼率，緩衝就會慢慢被吃完最後卡住。
        // 對 4K 更快反應（stallMaxEff 較小）、達標後也更早恢復監看（recheckEff 較大）。
        // 註：這裡原本還有一個 minAheadEff（高碼率 30 秒），它是「希望存這麼多緩衝」的
        // 目標線，卻被拿來當「該不該換節點」的觸發條件 —— 那正是「一直換節點」的根因
        //（見 STALL_DANGER_SEC 的完整說明）。觸發條件改用危險線之後它就沒有讀者了，
        // 一併刪除，不留下「看起來還有作用其實沒有」的變數。
        const streamMbps  = currentStreamBitsPerSec / 1e6
        const highBitrate = streamMbps >= 12
        const recheckEff  = highBitrate ? 20 : REACHED_RECHECK_BUFFER_SEC
        const stallMaxEff = highBitrate ? 2 : STALL_MAX

        // 剛開播/換片幾秒內的 slow-start 緩衝期：只累積 lastBufferedEnd 基準，不判定停滯，
        // 讓連線先把速度跑起來，避免才剛連上就急著換節點。
        const graceMs = highBitrate ? STARTUP_GRACE_MS_HIGH : STARTUP_GRACE_MS
        if (Date.now() - startedAt < graceMs || Date.now() < switchGraceUntil) {
            stallCount = 0
            lastBufferedEnd = be
            return
        }

        // 只有進了危險線才考慮換節點（見 STALL_DANGER_SEC 的說明）。
        // 註：原本這裡還有一個 needMoreBuffer = bufferAhead < minAheadEff，它是舊的觸發條件。
        // 「要不要繼續積極監看」其實是由下面的 monitorAfterReached 在管，跟它無關，
        // 所以連同 minAheadEff 一起刪掉，不留下「看起來還有作用其實沒有」的變數。
        const inDanger = bufferAhead < STALL_DANGER_SEC
        const urgentBuffer = bufferAhead < URGENT_BUFFER_SEC
        const monitorAfterReached = reached && bufferAhead < recheckEff
        if (reached && !monitorAfterReached) {
            stallCount = 0
            lastBufferedEnd = be
            return
        }
        // 4K：門檻 = 即時碼率本身（下載低於它必定耗盡緩衝）；其他畫質沿用較寬鬆的需求值
        const requiredBps = highBitrate
            ? streamMbps * 1e6 / 8
            : getRequiredStreamMbps(v.playbackRate, 'steady') * 1e6 / 8
        // v1.3.3：MIN_BPS_FLOOR 這個絕對下限，本來只是為了「碼率未知時不要訂出荒謬的
        // 低門檻」。但碼率已經知道、而且很低時（480p 只需要約 0.11 MB/s），
        // 350 KB/s 的下限反而變成一個跟這支片無關的高門檻 —— 播放器穩態根本不會拉到
        // 那麼快，於是低碼率影片被永久誤判成「太慢」。下限不該超過實際需求的 1.2 倍。
        const effFloor = requiredBps > 0 ? Math.min(MIN_BPS_FLOOR, requiredBps * 1.2) : MIN_BPS_FLOOR
        const minBps = Math.max(effFloor, requiredBps)
        // v1.3.3：緩衝存量的趨勢才是「跟不跟得上」的物理事實。
        // 只看 bps 對不對得上估算門檻，會有一整類系統性誤判：播放器在穩態下只會拉
        // 「剛好等於碼率」的量（它本來就不該把頻寬吃滿），而門檻是碼率 ×1.05 —— 
        // 於是只要緩衝低於 minAheadEff，bps 就結構性地永遠略低於門檻，判定必然成立。
        // 但如果緩衝存量並沒有在減少，那就代表下載其實跟得上，不管估算門檻怎麼說。
        // 例外：緩衝已經進入危險區（urgentBuffer）時不套用這個條件 —— 那時候就算
        // 打平也只差一次抖動就斷了，該換還是要換。
        const oldestAhead = oldestSample.ahead
        const bufferDraining = typeof oldestAhead === 'number'
            ? (bufferAhead < oldestAhead - 0.5)
            : true
        // stalled（buffered.end 不再前進）有完全一樣的結構性誤判：播放器抓完一段就
        // 閒置到下一段，這段期間 buffered.end 本來就不會動 —— 但播放時間持續前進，
        // 連續 2~3 個 tick 就達到 stallMax。所以它同樣要用「整個視窗看緩衝有沒有真的
        // 在流失」來把關，而不是用 tick 對 tick 的瞬間值。
        const stalled = inDanger
            && (be <= lastBufferedEnd + 0.05)
            && playing
            && (urgentBuffer || bufferDraining)
        const tooSlow = inDanger
            && bps < (urgentBuffer ? minBps * 1.2 : minBps)
            && playing
            && totalBytes > 0
            && (urgentBuffer || bufferDraining)
        lastBufferedEnd = be

        if (stalled || tooSlow) {
            stallCount += urgentBuffer ? 2 : 1
            if (stallCount >= stallMaxEff) {
                stallCount = 0
                sessionStallCount++
                switchCdn(stalled ? 'buffered 停滯' : 'bps=' + Math.round(bps / 1024) + 'KB/s 低於需求')
            }
        } else {
            stallCount = 0
        }
    }

    return {
        // 由 Worker 透過 MessagePort 回報的 segment 下載量（主執行緒 PerformanceObserver 看不到 Worker 流量）。
        // 無 duration 故不更新單節點吞吐 EWMA，但計入總量讓面板 MB 正確、Watchdog 的 bps 判斷不再對 4K 半盲。
        noteExternalBytes(host, bytes) {
            if (!bytes || bytes <= 0) return
            totalBytes += bytes
            if (host) {
                lastSegmentCdn = host
                perCdnBytes[host] = (perCdnBytes[host] || 0) + bytes
            }
        },
        // recordCdnFailure 的 hard-fail 分支呼叫；getWatchdogSample() 的 hardFailCount
        // 過去永遠回 0（沒有任何地方會遞增它），導致 HTTPDNS computeScore 裡的
        // hardFailCount 懲罰項形同虛設。
        noteHardFail() {
            sessionHardFailCount++
        },
        start() {
            if (started) return
            started   = true
            startedAt = Date.now()
            try {
                observer = new PerformanceObserver((list) => list.getEntries().forEach(onEntry))
                observer.observe({ type: 'resource', buffered: true })
            } catch (e) { err('[Watchdog] PerformanceObserver 失敗：', e) }
            timer = setInterval(tick, TICK_MS)
        },
        stop() {
            if (observer) { try { observer.disconnect() } catch {} ; observer = null }
            if (timer) { clearInterval(timer); timer = null }
            started = false
        },
        reset() {
            totalBytes = 0; lastBufferedEnd = 0; stallCount = 0
            lastCurrentTime = 0; lastNudgeDetectAt = 0; lastTickAt = 0
            byteSamples = []
            reached = false; startedAt = Date.now()
            sessionSwitchCount = 0; sessionStallCount = 0; sessionHardFailCount = 0; lastSegmentCdn = null
            switchTimes = []; switchBreakerUntil = 0; burstPunished = []; switchGraceUntil = 0
            cachedVideo = null
            Object.keys(perCdnBytes).forEach(k => delete perCdnBytes[k])
        },
        stats() {
            const v = getVideo()
            const targetBytes = getBufferTargetBytes(v && v.playbackRate)
            return {
                totalMB:       +fmtMB(totalBytes),
                targetMB:      +fmtMB(targetBytes),
                reachedTarget: reached,
                bufferedSec:   +bufferedEnd(v).toFixed(2),
                videoTimeSec:  v ? +v.currentTime.toFixed(2) : 0,
                readyState:    v ? v.readyState : -1,
                paused:        v ? v.paused : null,
                perCdnMB:      Object.fromEntries(
                    Object.entries(perCdnBytes).map(([k, b]) => [k.split('.')[0], +fmtMB(b)])
                ),
                perCdnMbps:    Object.fromEntries(
                    Object.entries(cdnHealth)
                        .filter(([, h]) => h.samples > 0)
                        .map(([k, h]) => [k.split('.')[0], +h.ewmaMbps.toFixed(2)])
                ),
                requiredMbps:  +getRequiredStreamMbps(v && v.playbackRate).toFixed(2),
                cdnScore:      Object.fromEntries(
                    Object.keys(cdnHealth)
                        .filter(k => cdnHealth[k].samples > 0)
                        .map(k => [k.split('.')[0], +getCdnHealthScore(k).toFixed(2)])
                ),
                elapsedSec:    Math.round((Date.now() - startedAt) / 1000),
                // 換節點次數與斷路器狀態。使用者回報「畫面一直卡、log 一直在換節點」時，
                // 這兩個數字是最直接的判讀依據：switchCount 一直漲代表 Watchdog 認為節點有問題；
                // breakerSec > 0 代表已經判定「換也沒用」而停手，瓶頸在頻寬/碼率/跨境線路。
                switchCount:   sessionSwitchCount,
                stallCount:    sessionStallCount,
                breakerSec:    Math.max(0, Math.round((switchBreakerUntil - Date.now()) / 1000)),
            }
        },
        noteSeek,
        // v1.3.3：對外提供「最近真正在拉 segment 的節點」。賽馬過去用 activeCdnList[0]
        // 當作「正在播的節點」，但那是延遲探測/排序的結果，不一定是實際在服務 segment 的
        // 那一個（起播用 STARTUP_PICK 挑的節點會寫進 lastChosenCdn，跟 activeCdnList[0]
        // 可能不同）。認錯節點會導致：把正在播的節點也拿去測速（白白多佔一次頻寬，
        // 而且它本來就有 PerformanceObserver 的真實樣本），以及把 forcedRedirect 加在
        // 一個根本沒在用的 host 上（等於沒切換）。
        getLastSegmentCdn: () => lastSegmentCdn,
        noteCdnSwitched,
    }
})()

// 頁面型態（改進工單 F 用）：只取路徑的類別區段（video/bangumi/play/cheese...），
// 不含 BV 號、ep 號等具體影片識別碼。
const getPageTypeLabel = () => {
    const path = location.pathname
    const m = path.match(/^\/([a-z]+)(?:\/([a-z]+))?/)
    if (!m) return path || '/'
    return '/' + [m[1], m[2]].filter(Boolean).join('/')
}

// 診斷報告一鍵複製（改進工單 F）：組出一段純文字讓使用者回報問題時直接貼上，省掉
// 來回追問版本/狀態的往返。刻意只放 host 與統計數字——不含完整影片網址、cookie、
// IP 等任何可識別使用者身分或觀看紀錄的資訊。
const buildDiagReport = () => {
    const ws = summarizeWorkerStats()
    const httpDns = getHttpDnsStatus()
    const lines = [
        '[BiliCDN_TW 診斷報告]',
        '版本：' + VERSION,
        '頁面型態：' + getPageTypeLabel(),
        'UA：' + navigator.userAgent,
        '面板注入狀態：' + uiInjectStatus,
        '停用狀態：' + disabled,
        'Worker 攔截開關：' + EnableWorkerIntercept,
        '白名單：' + (activeCdnList.map(c => c.split('.')[0]).join(' > ') || '（無）'),
        '黑名單（24h）：' + ([...blacklistSet].map(c => c.split('.')[0]).join(', ') || '（無）'),
        '持久死節點：' + (listDeadHosts()
            .map(e => e.host.split('.')[0] + '(' + e.reason + '，剩 ' + e.daysLeft + 'd)')
            .join(', ') || '（無）'),
        '目前最佳：' + getCdnShortName(),
        '頁面發現 CDN：' + (pageDiscoveredCdn ? pageDiscoveredCdn.split('.')[0] : '（無）'),
        '改寫統計：' + JSON.stringify(redirectStats),
        'HTTPDNS：' + httpDns.mode + (httpDns.ttlMin ? '（' + httpDns.ttlMin + 'm）' : ''),
        'Worker 量測：created=' + ws.created + ' netCalls=' + ws.netCalls + ' mediaSeen=' + ws.mediaSeen
            + ' rewrites=' + ws.rewrites + ' 觀察' + ws.observedDays + '天 判讀=' + ws.verdict,
    ]
    return lines.join('\n')
}

// 剪貼簿 API 在非 HTTPS 或非使用者互動觸發時會失敗（例如純用 console 呼叫 BiliCDN.report()
// 而非點面板按鈕），失敗時退回印在 console，讓使用者手動選取複製。
const copyDiagReport = () => {
    const text = buildDiagReport()
    const fallback = (e) => {
        console.log(text)
        console.log('[BiliCDN] 剪貼簿複製失敗' + (e ? '（' + e.message + '）' : '（非 HTTPS 或無使用者互動）')
            + '，診斷內容已印在上面，手動選取複製即可。')
    }
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                log('[診斷報告] 已複製到剪貼簿')
            }).catch(fallback)
        } else {
            fallback()
        }
    } catch (e) {
        fallback(e)
    }
    return text
}

// ── 診斷 API（在 console 用：BiliCDN.diag() / .verbose(true) 等）────────
unsafeWindow.BiliCDN = {
    diag() {
        console.group('[BiliCDN] 診斷')
        console.log('版本:', PluginName)
        console.log('Verbose（log 開關）:', Config.verbose)
        console.log('停用狀態:', disabled)
        console.log('白名單順序（初始 probe）:', activeCdnList.map(c => c.split('.')[0]))
        console.log('黑名單（24h）:', [...blacklistSet].map(c => c.split('.')[0]))
        console.log('軟隔離（session）:', Object.keys(cdnSoftBlockUntil).filter(isCdnSoftBlocked).map(c => c.split('.')[0]))
        console.log('持久死節點（逾時 1d / 一般 7d / DNS 類 30d）:', listDeadHosts()
            .map(e => e.host.split('.')[0] + '(' + e.reason + '，剩 ' + e.daysLeft + 'd)'))
        console.log('已知不解析、暫不使用（presumed）:',
            PREFERRED_CDN_LIST.filter(isPresumedDnsFailHost).map(c => c.split('.')[0]))
        console.log('失敗計數:', cdnFailCount)
        console.log('最低需求 Mbps:', +getRequiredStreamMbps().toFixed(2))
        console.log('CDN 吞吐評分:', Object.fromEntries(
            Object.entries(cdnHealth).map(([k, h]) => [k.split('.')[0], {
                mbps: +h.ewmaMbps.toFixed(2),
                jitter: h.ewmaMbps > 0 ? +(Math.sqrt(h.varMbps || 0) / h.ewmaMbps).toFixed(2) : 0,
                latency: h.latencyMs ? +h.latencyMs.toFixed(0) : 0,
                samples: h.samples,
                slow: h.slowSamples,
                softBlocks: h.softBlocks,
                bad: isCdnStronglyBad(k),
                score: +getCdnHealthScore(k).toFixed(2),
                // v1.3.3：起播模式（無探索加成）的分數。兩者差距大 = 該節點目前
                // 主要靠「還沒被測過」在拿分，舊版會拿起播去賭它，新版不會。
                scoreStartup: +getCdnHealthScore(k, STARTUP_PICK).toFixed(2),
            }])
        ))
        console.log('固定 CDN:', resolvedCdn || '（自動）')
        console.log('目前最佳:', getCdnShortName())
        console.log('面板注入狀態:', uiInjectStatus === 'ok' ? '正常'
            : uiInjectStatus === 'timeout' ? '⚠ 找不到設定面板錨點（可能 Bilibili 改版，CDN 改寫不受影響仍照常運作）'
            : '等待播放器載入中')
        console.log('頁面發現 CDN:', pageDiscoveredCdn ? pageDiscoveredCdn.split('.')[0] : '（無）')
        console.log('HTTPDNS:', getHttpDnsStatus())
        console.log('WebRTC 阻擋:', BlockWebRTC)
        console.log('改寫統計:', { ...redirectStats })
        console.log('Worker 攔截量測:', summarizeWorkerStats())
        console.groupEnd()
        return {
            active:  [...activeCdnList],
            black:   [...blacklistSet],
            soft:    Object.fromEntries(Object.entries(cdnSoftBlockUntil).filter(([cdn]) => isCdnSoftBlocked(cdn))),
            dead:    listDeadHosts(),
            // 已知在台灣不解析、但還沒有實測證據可以標死的節點。它們不會被選路、
            // 不會進 backup_url、不會被賽馬碰到，但也還沒被判死刑。
            presumed: PREFERRED_CDN_LIST.filter(isPresumedDnsFailHost),
            fail:    { ...cdnFailCount },
            health:  Object.fromEntries(
                Object.entries(cdnHealth).map(([k, h]) => [k, { ...h, score: getCdnHealthScore(k) }])
            ),
            verbose: Config.verbose,
            redirects: { ...redirectStats },
            discovered: pageDiscoveredCdn,
            httpdns: getHttpDnsStatus(),
            uiInjectStatus,
            workerStats: summarizeWorkerStats(),
        }
    },
    // Worker 攔截有效性量測（改進工單 B）：用真實數據決定 setupClassicWorkerIntercept()
    // 這 250 行的去留。所有數字只存在本機，回報請直接複製本方法輸出貼給開發者。
    workerStats() {
        const s = summarizeWorkerStats()
        console.group('[BiliCDN] Worker 攔截量測')
        console.log('created（攔到幾次 new Worker）:', s.created)
        console.log('netCalls（Worker 內發出幾次網路請求）:', s.netCalls)
        console.log('mediaSeen（其中幾次是影片分段）:', s.mediaSeen)
        console.log('rewrites（實際改寫幾次）:', s.rewrites)
        console.log('累計位元組:', s.bytesMB + ' MB')
        console.log('已觀察天數:', s.observedDays)
        console.log('worker script 網址樣本:', s.samples)
        console.log('判讀:', s.verdict)
        console.groupEnd()
        return s
    },
    // 診斷報告一鍵複製（改進工單 F）：回報問題時直接貼給開發者，省掉來回追問。
    // 不含完整影片網址／cookie／IP，只有 host 與統計數字。
    report() {
        const text = copyDiagReport()
        console.log(text)
        return text
    },
    // 注意：這是**改寫統計**，不是 Watchdog 的播放統計。換節點次數 / 卡頓次數 /
    // 斷路器狀態在 BiliCDN.buf() —— 文件曾經把兩者寫成同一個入口，實際上不是。
    stats() {
        console.log('[BiliCDN] 改寫統計:', redirectStats,
            '| HTTPDNS:', getHttpDnsStatus(),
            '| 頁面 CDN:', pageDiscoveredCdn ? pageDiscoveredCdn.split('.')[0] : '—')
        console.log('（換節點/卡頓/斷路器請看 BiliCDN.buf()）')
        return { ...redirectStats, pageDiscoveredCdn, httpdns: getHttpDnsStatus() }
    },
    // 手動觸發吞吐量賽馬（用最近一次播放抓到的真實 segment）；忽略冷卻
    bakeoff() {
        if (!lastSampleSegmentUrl) {
            console.log('[BiliCDN] 尚無 segment 樣本，請先播放影片數秒再試')
            return
        }
        setLastBakeoffAt(0)
        console.log('[BiliCDN] 開始吞吐量賽馬…（約 1~5 秒）')
        // 使用者手動要求的，不能被「現用節點目前還算快」的捷徑靜默跳過。
        return runThroughputBakeoff(lastSampleSegmentUrl, false).then(() => {
            const r = Object.fromEntries(
                Object.entries(cdnHealth)
                    .filter(([, h]) => h.samples > 0)
                    .map(([k, h]) => [k.split('.')[0], { mbps: +h.ewmaMbps.toFixed(2), score: +getCdnHealthScore(k).toFixed(2) }])
            )
            console.log('[BiliCDN] 賽馬結果:', r, '| 目前最佳:', getCdnShortName())
            return r
        })
    },
    verbose(on) {
        if (typeof on !== 'boolean') {
            console.log('[BiliCDN] Verbose =', Config.verbose,
                '\n用法：BiliCDN.verbose(true) 開啟詳細 log，BiliCDN.verbose(false) 關回靜音')
            return Config.verbose
        }
        Config.verbose = on
        try { GM_setValue('verbose', on) } catch {}
        console.log('[BiliCDN] Verbose =', on, '（已持久化）')
        return on
    },
    reset() {
        clearBlacklist()
        clearDeadHosts()
        Object.keys(cdnFailCount).forEach(k => delete cdnFailCount[k])
        Object.keys(cdnHealth).forEach(k => delete cdnHealth[k])
        try { GM_setValue(CDN_HEALTH_KEY, '{}') } catch {}
        lastChosenCdn = null
        Object.assign(redirectStats, {
            unstable: 0,
            pcdnSkipped: 0,
            hostLocked: 0,
            whitelist: 0,
            httpdns: 0,
            httpdnsAllowed: 0,
            httpdnsAutoSwitch: 0,
            quietRedirects: 0,
        })
        HttpDnsAutoPilot.reset()
        hostLockedStreams.clear()
        pageDiscoveredCdn = null
        try { GM_deleteValue(PROBE_CACHE_KEY) } catch {}
        Watchdog.reset()
        log('已重置：黑名單、軟隔離、持久死節點、失敗計數、健康分數、probe 快取、改寫統計、Watchdog')
        return this.diag()
    },
    httpdns(mode) {
        if (mode === undefined) {
            const status = getHttpDnsStatus()
            console.group('[BiliCDN] HTTPDNS AutoPilot')
            console.log('模式:', status.mode, '| 目前阻擋:', status.block)
            if (status.ttlMin) console.log('剩餘:', status.ttlMin + ' 分鐘')
            if (status.reason) console.log('原因:', status.reason)
            if (status.networkKey) console.log('網路鍵:', status.networkKey)
            if (status.scores) {
                console.log('評分 block≈', status.scores.block, '(' + status.scores.blockSamples + ' 次)',
                    '| allow≈', status.scores.allow, '(' + status.scores.allowSamples + ' 次)')
                if (status.scores.trial != null) console.log('短測分數:', status.scores.trial)
            }
            console.log('用法：BiliCDN.httpdns("auto") / BiliCDN.httpdns(true) / BiliCDN.httpdns(false)')
            console.groupEnd()
            return status
        }
        if (mode !== true && mode !== false && mode !== 'auto') {
            console.log('用法：BiliCDN.httpdns("auto") / BiliCDN.httpdns(true) / BiliCDN.httpdns(false)')
            return getHttpDnsStatus()
        }
        return setHttpDnsMode(mode)
    },
    // 手動重跑延遲探測（force：忽略 2 小時快取與起播讓路，含 presumed 節點）。
    // 程式碼註解與 CHANGELOG 都提到過這個入口，但先前並沒有真的實作出來。
    // 使用者明確要求的手動探測：忽略 2 小時快取與起播讓路，重新量一次所有**可用**節點。
    // 不會去打 presumed 節點（已知在台灣不可用的那幾台）——那一發請求換不到任何能用來
    // 做決定的資訊（no-cors 讀不到狀態碼），只會在 console 留一行紅字。它們的狀態改用
    // 已知資訊列出來，並告知唯一真正能翻案的作法。
    probe() {
        try { GM_deleteValue(PROBE_CACHE_KEY) } catch {}
        return reorderCdnsByLatency(true).then(() => {
            console.log('[BiliCDN] 探測完成，候選順序：', [...activeCdnList].map(c => c.split('.')[0]))
            // 這幾台這一輪**刻意沒有被探測**（見候選過濾處說明）。仍然把它們列出來，
            // 否則使用者只會看到「清單裡少了幾台」而不知道發生什麼事。
            const skipped = PREFERRED_CDN_LIST.filter(isPresumedDnsFailHost)
            if (skipped.length) {
                const dead = listDeadHosts()
                console.log('[BiliCDN] 以下節點已知在台灣不可用，本次未探測（避免無謂的失敗請求）：',
                    Object.fromEntries(skipped.map(c => {
                        const d = dead.find(x => x.host === c)
                        return [c.split('.')[0], d ? (d.reason + '，剩 ' + d.daysLeft + 'd') : '預設清單推定']
                    })))
                console.log('[BiliCDN] 要翻案只有一個有效作法——讓它真的去服務 segment：'
                    + 'BiliCDN.setCdn("<完整 host>") 固定使用它並播一段影片，'
                    + '成功後推定會自動失效；想改回自動選路就 BiliCDN.setCdn("null")。')
            }
            return this.diag()
        })
    },
    clearDead() { clearDeadHosts(); return this.diag() },
    // 單獨救回被誤殺的節點：BiliCDN.revive("upos-sz-mirrorali.bilivideo.com")
    // 也接受短名稱：BiliCDN.revive("ali")
    revive(host) {
        if (!host) {
            console.log('用法：BiliCDN.revive("upos-sz-mirrorali.bilivideo.com") 或 BiliCDN.revive("ali")')
            return listDeadHosts()
        }
        // 三種寫法都接受，規則明確不靠巧合：完整 host、去掉網域的短名、去掉
        // upos-{sz|hz}-mirror 前綴的節點代號（'ali' / 'aliov' / 'cos'）。
        // 一定要用完全相等而不是 endsWith——'ali' 用 endsWith 會同時命中 'aliov'。
        const shortOf = (c) => c.split('.')[0]
        const codeOf  = (c) => shortOf(c).replace(/^upos-(sz|hz)-mirror/, '')
        const full = PREFERRED_CDN_LIST.find(c => c === host || shortOf(c) === host || codeOf(c) === host)
        if (!full) { console.warn('[BiliCDN] 找不到符合的白名單節點：' + host); return listDeadHosts() }
        reviveDeadHost(full)
        promoteBestCdnNow()
        console.log('[BiliCDN] 已救回：' + full)
        return this.diag()
    },
    clearSoft() {
        Object.keys(cdnSoftBlockUntil).forEach(c => delete cdnSoftBlockUntil[c])
        Object.values(cdnHealth).forEach(h => {
            h.softBlocks = 0
            h.lastSoftBlockAt = 0
            h.lastSoftBlockReason = ''
        })
        scheduleCdnHealthSave()
        promoteBestCdnNow()
        return this.diag()
    },
    dead() {
        try {
            const raw = JSON.parse(GM_getValue(DEAD_HOSTS_KEY) || '[]')
            console.group('[BiliCDN] 持久死節點清單')
            raw.forEach(e => {
                const leftMs = e.expireAt - Date.now()
                const leftH  = Math.max(0, Math.round(leftMs / 3600000))
                console.log(e.host.split('.')[0] + '  reason=' + e.reason + '  剩餘 ' + leftH + 'h')
            })
            console.groupEnd()
            return raw
        } catch { return [] }
    },
    setCdn(host) {
        if (!host) { GM_deleteValue('CustomCDN'); log('已清除固定 CDN（重整生效）'); return }
        if (!isValidCustomCdnHost(host)) {
            err('[安全] 拒絕設定：「' + host + '」不是合法的 bilibili CDN 網域格式（需為 *.bilivideo.com 或 *.bilivideo.cn）')
            return
        }
        GM_setValue('CustomCDN', host)
        log('已固定 CDN 為 ' + host + '（重整頁面生效）')
    },
    buf() {
        const s = Watchdog.stats()
        console.group('[BiliCDN] 緩衝狀態')
        console.log('累計下載:', s.totalMB + 'MB / ' + s.targetMB + 'MB',
            s.reachedTarget ? '✓ 已達標' : '⌛ 未達標')
        console.log('buffered:', s.bufferedSec + 's | currentTime:', s.videoTimeSec + 's',
            '| readyState:', s.readyState, '| paused:', s.paused)
        console.log('各 CDN 下載量:', s.perCdnMB)
        console.log('各 CDN 速度:', s.perCdnMbps)
        console.log('最低需求 Mbps:', s.requiredMbps)
        console.log('各 CDN 評分:', s.cdnScore)
        console.log('已運行:', s.elapsedSec + 's')
        // 這三個以前只在回傳值裡、沒有印出來——但它們正是「畫面一直卡、log 一直在換節點」
        // 時最直接的判讀依據，只放在回傳物件裡等於使用者看不到。
        console.log('換節點次數:', s.switchCount, '| 卡頓判定次數:', s.stallCount,
            '| 換節點斷路器:', s.breakerSec > 0
                ? ('已跳脫，' + s.breakerSec + 's 後恢復（換也沒用，瓶頸在頻寬/碼率/跨境線路）')
                : '未跳脫')
        console.groupEnd()
        return s
    },
    watchdog: {
        start: () => Watchdog.start(),
        stop:  () => Watchdog.stop(),
        // 跟 SPA 換片時的處理方式一致：Watchdog.reset() 會讓累計位元組歸零，若當下
        // HTTPDNS AutoPilot 正在 trial-allow，沒有同步通知它就會拿舊的大 baseline
        // 對歸零後的小 sample 相減，trial 被誤判失敗——見 onWatchdogReset 註解。
        reset: () => { Watchdog.reset(); try { HttpDnsAutoPilot.onWatchdogReset() } catch {} },
    },
    // 動態排除/恢復 host 關鍵字（即時生效不需重整）
    exclude(kw) {
        if (!kw || typeof kw !== 'string') {
            console.log('用法：BiliCDN.exclude("cosov")  → 排除 host 含 "cosov" 的節點')
            return [...ExcludeHostKeywords]
        }
        if (!ExcludeHostKeywords.includes(kw)) ExcludeHostKeywords.push(kw)
        for (let i = activeCdnList.length - 1; i >= 0; i--) {
            if (activeCdnList[i].indexOf(kw) !== -1) activeCdnList.splice(i, 1)
        }
        try { GM_deleteValue(PROBE_CACHE_KEY) } catch {}
        log('已加入排除：' + kw + '，剩餘：'
            + activeCdnList.map(c => c.split('.')[0]).join(', '))
        return [...ExcludeHostKeywords]
    },
    include(kw) {
        const idx = ExcludeHostKeywords.indexOf(kw)
        if (idx === -1) { log('排除清單中沒有：' + kw); return [...ExcludeHostKeywords] }
        ExcludeHostKeywords.splice(idx, 1)
        // 把符合的 host 依 RAW 順序放回 activeCdnList
        PREFERRED_CDN_LIST_RAW.forEach(h => {
            if (h.indexOf(kw) === -1) return
            if (matchesExclude(h)) return
            if (!activeCdnList.includes(h) && !blacklistSet.has(h)) activeCdnList.push(h)
        })
        try { GM_deleteValue(PROBE_CACHE_KEY) } catch {}
        log('已移除排除：' + kw + '，當前：'
            + activeCdnList.map(c => c.split('.')[0]).join(', '))
        return [...ExcludeHostKeywords]
    },
    excludes() { return [...ExcludeHostKeywords] },
}
// 非同步 probe，不阻塞 main；停用狀態下延到使用者重新啟用後再跑
let cdnProbeStarted = false
const startCdnProbe = () => {
    if (cdnProbeStarted || disabled) return
    cdnProbeStarted = true
    // v1.3.3：先立刻對「這次最可能用到的節點」開連線。延遲探測要跑一秒以上才排得完序，
    // 但 playurl 可能更早到 —— 那樣第一個 segment 就得從零做 DNS + TCP + TLS 握手，
    // 跨國情境下這段就是好幾百毫秒的起播延遲。preconnect 幾乎零成本（沒用到的連線
    // 閒置一陣子就被瀏覽器回收），先開一定比等排序完再開好。
    try {
        // 對準「playurl 這次真的會寫進去」的那組 host：primary 用 getCurrentCdn(STARTUP_PICK)、
        // backup 用 getHealthyCdnList(STARTUP_PICK).slice(0,2)，跟 transformStreamItem /
        // buildBackupUrls 完全一致。舊版 backup 那兩顆取自 activeCdnList 的 index 順序，
        // 而 index 只是「沒有樣本時」的退路排序，跟實際會被寫進 backup_url 的節點常常不同
        // —— 等於熱身了兩條用不到的連線，真正的 backup 反而是冷的。
        // ★ 順序：先剔除 primary、再 slice(2)——不能反過來。buildBackupUrls 就是這樣做的
        // （它 filter(cdn !== primaryHost) 之後才 slice(0, 2)），而 primary 幾乎總是排名第一，
        // 所以先 slice 再交給 Set 去重的話，backup 的第一顆會跟 primary 重複被吃掉，
        // 只剩 2 個 host 被熱身——真正的第二顆 backup 反而是冷的。它正是「primary 失敗後
        // 播放器第二個會試」的節點，起播失敗時要靠它救場，卻得從零做 DNS + TCP + TLS。
        const primary = getCurrentCdn(STARTUP_PICK)
        const backups = getHealthyCdnList(STARTUP_PICK)
            .filter(c => c !== primary)
            .slice(0, 2)
        preconnectBatch([primary, ...backups].filter(Boolean), false)
    } catch {}
    reorderCdnsByLatency().catch(() => {})
}
startCdnProbe()

// ── Tampermonkey 選單 ────────────────────────────────────────────────
// 所有控制原本都要開 DevTools console 打指令，對非開發者的一般使用者門檻很高。
if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('🔄 重置所有學習狀態', () => { unsafeWindow.BiliCDN.reset(); location.reload() })
    GM_registerMenuCommand('📊 顯示診斷資訊', () => unsafeWindow.BiliCDN.diag())
    GM_registerMenuCommand('🏁 立即測速選節點', () => unsafeWindow.BiliCDN.bakeoff())
    GM_registerMenuCommand('🔍 ' + (Config.verbose ? '關閉' : '開啟') + '詳細記錄',
        () => { unsafeWindow.BiliCDN.verbose(!Config.verbose); location.reload() })
    GM_registerMenuCommand('🌐 HTTPDNS 狀態', () => unsafeWindow.BiliCDN.httpdns())
}

// ── Main ──────────────────────────────────────────────────────────────
;(function () {
    'use strict'

    // 攔截 playurl API 回應，改寫 base_url + backup_url
    interceptNetResponse((response, url) => {
        if (disabled || !isPlayUrlApi(url)) return
        // v1.3.4：原本這行是 `if (response === null) return true`。回傳值只要不是
        // undefined 就會被當成「新的回應內容」沿用下去 —— 也就是把回應換成布林值
        // `true`，呼叫端讀到的 responseText 會變成 true。改成直接回傳 undefined，
        // 語意才是「這次不改寫，維持原樣」。
        if (response === null || response === undefined) return
        try {
            // XHR 若設了 responseType='json'，super.response 拿到的是**已解析的物件**，
            // 不是字串。舊寫法一律 JSON.parse(物件) → 被強制轉成 "[object Object]"
            // → 丟 SyntaxError → 落到下面的 catch → 整包回應原封不動送出去。
            // 也就是說走這條路徑的 playurl **從來沒有被改寫過**，而且完全無聲無息。
            const isObj = typeof response === 'object'
            const playInfo = isObj ? response : JSON.parse(response)
            playInfoTransformer(playInfo)
            // 物件是就地改寫，回傳同一個參考即可；字串才需要重新序列化。
            return isObj ? playInfo : JSON.stringify(playInfo)
        } catch (e) { err('playurl parse error:', e) }
    })

    const blockWebRtc = () => {
        if (!BlockWebRTC) return
        try {
            ;['RTCPeerConnection', 'mozRTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']
                .forEach(api => Object.defineProperty(unsafeWindow, api, {
                    get: () => undefined, set: () => {}, configurable: true
                }))
        } catch (e) {}
    }

    const transformInitialPlayInfo = () => {
        if (disabled) return
        // v1.3.4：兩個呼叫點都要保證「改寫失敗 ≠ 播放資訊消失」。
        const safeTransform = (v) => {
            try { playInfoTransformer(v) }
            catch (e) { err('__playinfo__ 改寫失敗，改用原始資料：', e) }
        }
        if (unsafeWindow.__playinfo__) {
            safeTransform(unsafeWindow.__playinfo__)
        } else {
            let internal = unsafeWindow.__playinfo__
            Object.defineProperty(unsafeWindow, '__playinfo__', {
                get: () => internal,
                // ★ 賦值一定要發生。舊寫法是 `set: v => { playInfoTransformer(v); internal = v }`，
                // playInfoTransformer 的前半段（playInfo.result 分支）並不在它自己的
                // try/catch 範圍內，一旦丟出例外，`internal = v` 這行就不會執行 ——
                // 頁面明明寫入了 __playinfo__，讀回來卻是 undefined，播放器拿不到
                // 初始播放資訊，而且例外還會往回炸進 B 站自己的 inline script。
                set: v => { safeTransform(v); internal = v },
                configurable: true
            })
        }
    }

    // ── 背景續播：偽裝 Page Visibility ──────────────────────────────────
    // 切換視窗/分頁時，瀏覽器會送 visibilitychange=hidden，bili 播放器收到後
    // 常只續傳音訊、停止補視訊 segment；加上背景 timer 節流，緩衝被耗盡，
    // 切回時就得重新加載。這裡讓頁面「永遠看起來是前景可見」，
    // 並吞掉 visibilitychange / blur，避免播放器自行降級或暫停拉流。
    let backgroundPlaybackEnabled = !disabled
    let visibilitySpoofInstalled  = false
    let tabReallyHidden           = false  // 真實（非偽裝）可見狀態，供多分頁協調與省頻寬判斷
    const installVisibilitySpoof = () => {
        if (visibilitySpoofInstalled) return
        visibilitySpoofInstalled = true
        const doc = unsafeWindow.document

        const origHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
        const origState  = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
        const realHidden = () => (origHidden && origHidden.get) ? origHidden.get.call(doc) : false
        const realState  = () => (origState && origState.get) ? origState.get.call(doc) : 'visible'
        tabReallyHidden = realState() !== 'visible'

        const def = (key, spoofed, real) => {
            try {
                Object.defineProperty(doc, key, {
                    configurable: true,
                    get: () => backgroundPlaybackEnabled ? spoofed : real(),
                })
            } catch (e) { err('visibility spoof 失敗 (' + key + '):', e) }
        }
        def('hidden',                false,    realHidden)
        def('webkitHidden',          false,    realHidden)
        def('visibilityState',      'visible', realState)
        def('webkitVisibilityState','visible', realState)

        // capture 階段攔截：阻止事件傳到播放器自己的 listener；
        // 同時利用「真實」可見狀態，在切回前景時立即補連線（背景閒置連線約 30s 被斷）。
        const onVisRaw = (e) => {
            tabReallyHidden = realState() !== 'visible'
            if (!backgroundPlaybackEnabled) return
            if (!tabReallyHidden) {
                const hosts = [...activeCdnList.slice(0, 3), ...akamaiHostSeen].filter(Boolean)
                try { preconnectBatch(hosts, true) } catch {}
            }
            e.stopImmediatePropagation()
        }
        doc.addEventListener('visibilitychange', onVisRaw, true)
        doc.addEventListener('webkitvisibilitychange', onVisRaw, true)
        unsafeWindow.addEventListener('blur', (e) => {
            if (backgroundPlaybackEnabled) e.stopImmediatePropagation()
        }, true)
    }

    // ── 多分頁協調（BroadcastChannel）──────────────────────────────────
    // 多開分頁時，若每個分頁各自賽馬/探測會互搶台灣上行頻寬而互相低估吞吐量。
    // 真正的互斥交給 runThroughputBakeoff 內的 navigator.locks；這裡的 BroadcastChannel
    // 只在 Web Locks 不可用的舊環境當備援，靠「剛剛看到別人賽馬」的心跳判斷要不要避讓。
    const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36)
    const FOREIGN_BAKEOFF_QUIET = 8000
    let crossTabChannel = null
    let foreignBakeoffAt = 0

    const setupCrossTab = () => {
        if (crossTabChannel || typeof BroadcastChannel === 'undefined') return
        try { crossTabChannel = new BroadcastChannel('bilicdn_tw') } catch { return }
        crossTabChannel.onmessage = (ev) => {
            const d = ev && ev.data
            if (!d || d.id === TAB_ID) return
            if (d.type === 'bakeoff') foreignBakeoffAt = Date.now()
        }
        crossTabShouldBakeoff = () => (Date.now() - foreignBakeoffAt >= FOREIGN_BAKEOFF_QUIET)
        onBakeoffStart = () => { try { crossTabChannel.postMessage({ type: 'bakeoff', id: TAB_ID }) } catch {} }
    }

    let pageHooksApplied = false
    // v1.3.4：這四個 hook 原本是裸呼叫，而 applyPageHooks() 本身在 Main IIFE 的
    // 頂層被直接執行 —— 任何一個丟出例外，後面三個不會安裝、pageHooksApplied
    // 停在 false，例外再往上炸掉整個 IIFE，於是 **它後面的所有東西**
    //（SPA 換片偵測、Watchdog、seek 預熱、設定面板、選單）全部不會執行。
    // 一個小失誤的爆炸半徑不該是整支腳本。逐項隔離：壞一個只少一個功能。
    const applyPageHooks = () => {
        if (disabled || pageHooksApplied) return
        const step = (name, fn) => { try { fn() } catch (e) { err('page hook 失敗（' + name + '）：', e) } }
        step('transformInitialPlayInfo', transformInitialPlayInfo)
        step('blockWebRtc',              blockWebRtc)
        step('installVisibilitySpoof',   installVisibilitySpoof)
        step('installDashFragmentErrorHook', installDashFragmentErrorHook)
        pageHooksApplied = true
    }
    applyPageHooks()

    // 以下 UI / Watchdog / Prewarm 過去用一個寫死的 isVideoPage 網址判斷式做閘門，
    // 只認 /video/ 與 /bangumi/play/ 兩種網址——但 userscript header 的 @match 其實
    // 涵蓋了電影、紀錄片、劇集、課程、國創等共 13 種路徑，CDN 改寫核心在那些頁面上
    // 照常運作，面板、卡頓自動換源、SPA 換片狀態重置、seek 預熱卻完全不會啟動。
    // 與其維護第二份「該不該啟動」的網址清單（正是這次會漏掉的原因——兩份清單改
    // 一份忘改一份，以後新增 @match 也很容易再犯一次），直接拿掉這個閘門：下面每個
    // 子系統本來就各自能安全處理「頁面上暫時／永遠沒有播放器」——waitForElm 逾時後
    // 自然放棄（見檔案末尾 .catch）、Watchdog.tick() 找不到 <video> 直接 no-op、
    // setupSeekPrewarm 自己有 30 秒的 attach 重試迴圈——不需要額外的頁面類型白名單。

    // Seek 預熱：僅 seeking（不在 waiting 做 DOM/拆連線，避免卡 seek 主路徑）
    let seekPrewarmStarted = false
    // SPA 換片後 player 常換掉 <video> 元素；attach 成功後 tryAttach 的 interval 就停了，
    // 若不重新武裝，換片後新 <video> 永遠收不到 seek 預熱監聽（見 onSpaNavigate 呼叫）。
    let rearmSeekPrewarm = null
    const setupSeekPrewarm = () => {
        if (seekPrewarmStarted) return
        seekPrewarmStarted = true
        let attached = null
        let lastSeekWarmAt = 0
        const SEEK_WARM_GAP_MS = 400
        const ATTACH_TIMEOUT_MS = 30000
        let attachStartedAt = Date.now()
        let attachTimer = null

        const findVideo = () => {
            let best = null, bestArea = 0
            document.querySelectorAll('video').forEach(v => {
                const a = (v.clientWidth || 0) * (v.clientHeight || 0)
                if (a > bestArea) { bestArea = a; best = v }
            })
            return best
        }

        // v1.3.3：第一順位改成「真的在服務 segment 的那一個」（getPlayingCdnHost）。
        // 舊版只從 akamaiHostSeen 與 activeCdnList[0..1] 取，而 activeCdnList 的 index
        // 只是「所有節點都沒有實測樣本」時的退路排序，跟實際在拉 segment 的節點常常不同
        // —— 等於在最需要熱連線的那一刻，熱身了兩條用不到的連線，真正要打的那條反而是冷的。
        //
        // seek 預熱之所以有意義，正是因為緩衝拉滿之後播放器會停止抓取，連線閒置幾秒就被
        // 瀏覽器回收；被回收掉的是「剛剛正在用的那條」，不是排序第一名那條。認錯節點
        // 等於整個機制對 seek 沒有幫助。
        const seekWarmHosts = () => {
            const hosts = []
            const push = (h) => { if (h && hosts.length < 3 && !hosts.includes(h)) hosts.push(h) }
            push(getPlayingCdnHost())
            akamaiHostSeen.forEach(push)
            // 第三順位補上「主流真的失敗時會跳過去」的 backup 候選，順序跟 buildBackupUrls
            // 一致，這樣 seek 之後就算主流出事，備援也是熱的。
            getHealthyCdnList(STARTUP_PICK).forEach(push)
            return hosts
        }

        // force=false：只補缺 link，seek 中 remove 舊 preconnect 會拆掉正在用的連線
        const warmupSeek = () => {
            if (Date.now() - lastSeekWarmAt < SEEK_WARM_GAP_MS) return
            lastSeekWarmAt = Date.now()
            preconnectBatch(seekWarmHosts(), false)
        }

        const scheduleSeekWarmup = () => {
            Watchdog.noteSeek()
            bumpSeekGrace()
            warmupSeek()
        }

        const onSeeked = () => {
            bumpSeekGrace()
            warmupSeek()
        }

        const tryAttach = () => {
            const v = findVideo()
            if (!v && Date.now() - attachStartedAt > ATTACH_TIMEOUT_MS) {
                clearInterval(attachTimer)
                attachTimer = null
                return
            }
            if (!v || v === attached) return
            attached = v
            try { v.preload = 'auto' } catch {}
            // rearmSeekPrewarm() 只重置 attached，不代表 DOM 換了新的 <video> 元素——
            // 有些情境（同一元素僅換 src）換片後還是同一個節點，若不擋，每次換片都會對
            // 同一個 <video> 重複掛一輪監聽，seek 一次觸發 N 次 warmup/Watchdog.noteSeek。
            if (!v.__biliCdnSeekBound) {
                v.__biliCdnSeekBound = true
                v.addEventListener('seeking', scheduleSeekWarmup)
                v.addEventListener('seeked', onSeeked)
                v.addEventListener('ratechange', () => {
                    latestPlaybackRate = v.playbackRate   // 即時同步，onEntry() 不用再靠 getVideo() 現查
                    if (v.playbackRate > 1.5) warmupSeek()
                })
            }
            clearInterval(attachTimer)
            attachTimer = null
        }
        attachTimer = setInterval(tryAttach, 800)
        tryAttach()

        rearmSeekPrewarm = () => {
            attached = null
            attachStartedAt = Date.now()
            if (!attachTimer) attachTimer = setInterval(tryAttach, 800)
        }
    }

    // ── SPA 換片偵測 ────────────────────────────────────────────────────
    // B 站換影片不重載頁面（pushState）；換片＝新的 base_url，須清掉舊片殘留：
    // 解除舊強制改寫、重置賽馬冷卻與 Watchdog，讓新影片重新選最佳節點。
    // v1.3.4：影片識別碼有兩種存放位置，過去只翻了第一種——
    //   (a) pathname 型（/video/BV…、/bangumi/play/ep…）：編號寫在路徑裡。
    //   (b) query 型（/list/、/festival/、/medialist/）：pathname 從頭到尾不變
    //       （例如一路都是 /list/watchlater），換片只改 ?bvid= / ?oid=。
    // 只翻 pathname 的話，(b) 這類頁面在列表裡連播十部片會回傳同一個 key，
    // onSpaNavigate 第一行就 return —— 強制改寫不解除、賽馬冷卻不重置、
    // 碼率與 Watchdog 狀態整包沿用上一部。這跟 v1.3.3 修的「多 P 只改 ?p=」
    // 是同一種病：判斷式沒跟上新的網址型態，而且失敗時完全沒有跡象。
    let videoKeyUsedFallback = false   // 上一次 getVideoKey() 是否兩種來源都落空
    const getVideoKey = () => {
        let sp
        try { sp = new URLSearchParams(location.search) } catch { sp = new URLSearchParams('') }
        // (a) pathname 優先：一般影片頁的結果與 v1.3.3 完全一致，行為不變。
        const m = location.pathname.match(/\/(BV[0-9A-Za-z]+|ep\d+|ss\d+|av\d+)/i)
        // (b) pathname 沒有才看 query。oid/aid 是 av 號的數字部分，補上 'av' 前綴，
        //     讓同一部片不論從哪種頁面進來都收斂到同一個 key。
        const fromQuery = m ? '' : (sp.get('bvid')
            || (sp.get('epid') ? 'ep' + sp.get('epid') : '')
            || (sp.get('oid') ? 'av' + sp.get('oid') : '')
            || (sp.get('aid') ? 'av' + sp.get('aid') : ''))
        videoKeyUsedFallback = !m && !fromQuery
        const base = (m ? m[1] : (fromQuery || location.pathname)).toLowerCase()
        // v1.3.3：多 P 影片切換分集只會改 ?p=，pathname 一個字都不變 —— 不納入的話
        // 換分集不算換片，新分集會整包沿用上一集的碼率、賽馬冷卻與 Watchdog 狀態
        // （長片合集、課程、紀錄片這類多 P 內容最容易中）。
        const part = sp.get('p') || ''
        return part ? base + '#p' + part : base
    }
    // v1.3.4（改進 D-1）：把「認不出這是哪部片」這件事從靜默失敗改成會出聲。
    // 過去兩種來源都落空時會安靜退回 location.pathname —— 看起來很合理，實際上
    // 換片偵測已經整個失效，而且不會留下任何跡象，只能等使用者回報「怪怪的」。
    // 三個刻意的設計：
    //   1. 不受 Config.verbose 控制（同 CustomCDN 安全警告的理由）——要靠它主動
    //      現身，就不能藏在預設關閉的開關後面。
    //   2. 只在 onSpaNavigate 呼叫，不在 getVideoKey 內呼叫。頁面剛載入時
    //      /list/watchlater 可能還沒帶上 ?bvid=（B 站隨後才 pushState 補上），
    //      在 getVideoKey 裡叫會產生誤報。發生過 SPA 導覽卻仍認不出影片，才是真問題。
    //   3. 用 warn 不用 error，並寫明 CDN 改寫不受影響 —— 這是給回報用的線索，
    //      不是故障，不需要讓一般使用者緊張。
    // 這一則涵蓋的是「@match 有涵蓋、但網址型態不認得」的情況；
    // 「@match 根本沒涵蓋」的新頁型腳本不會被載入，偵測不到，只能靠使用者回報。
    let videoKeyFallbackWarned = false
    const warnIfVideoKeyUnresolvable = () => {
        if (!videoKeyUsedFallback || videoKeyFallbackWarned) return
        videoKeyFallbackWarned = true
        console.warn('[' + PluginName + ']: 這個頁面的網址取不到影片識別碼（'
            + location.pathname + '），SPA 換片偵測可能失效——換下一部影片時不會重新'
            + '挑選節點。CDN 改寫本身不受影響，影片仍會正常播放。'
            + '若換片後感覺變卡，請把這個網址型態回報給作者。')
    }
    let currentVideoKey = getVideoKey()
    let spaHooked = false
    const onSpaNavigate = () => {
        const key = getVideoKey()
        // v1.3.4：一定要放在下面的 early return 之前——「認不出影片」的症狀正是
        // key 一直不變、每次都從那一行 return 掉，放在後面等於永遠不會執行。
        warnIfVideoKeyUnresolvable()
        if (key === currentVideoKey) return
        currentVideoKey = key
        forcedRedirectHosts.clear()
        akamaiHostSeen.clear()      // 舊片的 Akamai 殘留跟新片無關，不用留著繼續 keep-warm
        resetStreamProfile()        // v1.3.3：舊片碼率不能留給新片（見該函式說明）
        bakeoffStartupDefers = 0    // v1.3.3：新片重新給滿起播讓路的額度
        setLastBakeoffAt(0)           // 解除冷卻，新片可立即賽馬
        lastSampleSegmentUrl = null
        // 放棄舊片還沒發出/還在跑的賽馬，把名額讓給新片：
        // - 還沒發出（排程中）：epoch 不符，scheduleBakeoff 的 timeout 觸發時直接跳過。
        // - 已經在跑：epoch 不符讓迴圈提早跳出 + abort 訊號讓當前這顆 probe 立刻斷線，
        //   不用等滿 3s timeout，bakeoffRunning 才能盡快讓新片的賽馬排得進去。
        bakeoffEpoch++
        if (bakeoffTimer) { clearTimeout(bakeoffTimer); bakeoffTimer = null }
        if (bakeoffAbortController) { try { bakeoffAbortController.abort() } catch {} ; bakeoffAbortController = null }
        try { Watchdog.reset() } catch {}
        try { HttpDnsAutoPilot.onWatchdogReset() } catch {}
        syncWorkerCdnTarget()
        if (rearmSeekPrewarm) rearmSeekPrewarm()
        log('[SPA] 換片：' + key + '，重置選節點狀態')
    }
    const hookHistory = () => {
        if (spaHooked) return
        spaHooked = true
        const h = unsafeWindow.history
        ;['pushState', 'replaceState'].forEach(name => {
            const orig = h[name]
            if (!orig || orig.__biliCdnHooked) return
            const wrapped = function (...args) {
                const r = orig.apply(this, args)
                try { setTimeout(onSpaNavigate, 0) } catch {}
                return r
            }
            wrapped.__biliCdnHooked = true
            h[name] = wrapped
        })
        unsafeWindow.addEventListener('popstate', () => setTimeout(onSpaNavigate, 0))
    }

    let runtimeStarted = false
    let keepWarmTimer = null
    let periodicBakeoffTimer = null
    const startRuntimeFeatures = () => {
        if (runtimeStarted || disabled) return
        runtimeStarted = true
        backgroundPlaybackEnabled = true
        applyPageHooks()
        startCdnProbe()
        Watchdog.start()
        hookHistory()
        setupCrossTab()
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', discoverCdnFromPage, { once: true })
        } else {
            discoverCdnFromPage()
        }
        setupSeekPrewarm()
        // Keep-warm：瀏覽器 idle connection 約 30s 斷，搶在斷前刷新 Top 3 + Akamai
        if (!keepWarmTimer) {
            keepWarmTimer = setInterval(() => {
                if (disabled) return
                const hosts = [...activeCdnList.slice(0, 3), ...akamaiHostSeen].filter(Boolean)
                preconnectBatch(hosts, !inSeekGrace())
            }, 25000)
        }
        // 週期性賽馬：跨國擁塞會隨時段漂移，每 4 分鐘重評估一次（受 90s 冷卻保護），
        // 找到明顯更快的節點就中途切換 → 播放中持續維持在最佳節點。
        if (!periodicBakeoffTimer) {
            periodicBakeoffTimer = setInterval(() => {
                if (disabled || resolvedCdn || !lastSampleSegmentUrl) return
                // 背景分頁不主動週期賽馬：player 仍靠偽裝續播，省頻寬並避免多分頁互搶
                if (tabReallyHidden) return
                // 這裡就是專門為了「現用節點目前還算快，但擁塞會隨時段漂移，
                // 說不定有更快的」而存在的，不能被同一個理由的捷徑自己擋掉自己。
                runThroughputBakeoff(lastSampleSegmentUrl, false).catch(() => {})
            }, 4 * 60 * 1000)
        }
    }
    const stopRuntimeFeatures = () => {
        runtimeStarted = false
        backgroundPlaybackEnabled = false
        Watchdog.stop()
        if (keepWarmTimer) {
            clearInterval(keepWarmTimer)
            keepWarmTimer = null
        }
        if (periodicBakeoffTimer) {
            clearInterval(periodicBakeoffTimer)
            periodicBakeoffTimer = null
        }
    }
    startRuntimeFeatures()

    // 只認 class，不鎖死中間包裝層數：bangumi/play（OGV 播放器）在 setting box 內部的
    // wrapper 層數與 video（UGC 播放器）不同，鎖死完整路徑會導致 waitForElm 逾時、
    // 「攔截修改影片 CDN」選項在番劇頁完全不出現（且預設不 verbose，使用者看不到任何錯誤）。
    // 只認 class 換來的代價：若頁面同時存在一個以上 .bpx-player-ctrl-setting-others
    // （例如浮動小視窗播放器、續播預覽卡用了同一套播放器元件），document.querySelector
    // 只會拿到 DOM 順序第一個，不一定是實際在播放的主播放器。有多個候選時，挑「最近的
    // <video> 面積最大」那個，跟 findVideo()/getVideo() 判斷主播放器的方式一致。
    const pickMainSettingsAnchor = (first) => {
        const all = document.querySelectorAll('.bpx-player-ctrl-setting-others')
        if (all.length <= 1) return first
        let best = first, bestArea = -1
        all.forEach(node => {
            const root = node.closest('[id*="bilibili-player"], [class*="bpx-player"]') || node
            const video = root.querySelector && root.querySelector('video')
            const area = video ? (video.clientWidth || 0) * (video.clientHeight || 0) : 0
            if (area > bestArea) { bestArea = area; best = node }
        })
        return best
    }
    // Bilibili 換片是 SPA 導航，不會整頁重載，播放器常把設定面板整個重建，
    // 注入的 UI 會被連根拔起。buildUI 抽成可重入函式、由 statusTimer 常駐偵測，
    // 面板消失時直接重建，取代原本「只注入一次、掉了就再也回不來」的作法。
    const buildUI = (settingsBar) => {
        if (!settingsBar || settingsBar.querySelector('#bilicdn-status-panel')) return
        uiInjectStatus = 'ok'

        settingsBar.appendChild(fromHTML(
            '<div class="bpx-player-ctrl-setting-others-title">' + SettingsBarTitle + '</div>'
        ))

        const checkBoxWrapper = fromHTML(
            '<div class="bpx-player-ctrl-setting-checkbox bpx-player-ctrl-setting-blackgap bui bui-checkbox bui-dark">' +
            '<div class="bui-area">' +
            '<input class="bui-checkbox-input" type="checkbox" checked aria-label="自訂影片 CDN">' +
            '<label class="bui-checkbox-label">' +
            '<span class="bui-checkbox-icon bui-checkbox-icon-default">' +
            '<svg xmlns="http://www.w3.org/2000/svg" data-pointer="none" viewBox="0 0 32 32"><path d="M8 6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H8zm0-2h16c2.21 0 4 1.79 4 4v16c0 2.21-1.79 4-4 4H8c-2.21 0-4-1.79-4-4V8c0-2.21 1.79-4 4-4z"></path></svg>' +
            '</span>' +
            '<span class="bui-checkbox-icon bui-checkbox-icon-selected">' +
            '<svg xmlns="http://www.w3.org/2000/svg" data-pointer="none" viewBox="0 0 32 32"><path d="m13 18.25-1.8-1.8c-.6-.6-1.65-.6-2.25 0s-.6 1.5 0 2.25l2.85 2.85c.318.318.762.468 1.2.448.438.02.882-.13 1.2-.448l8.85-8.85c.6-.6.6-1.65 0-2.25s-1.65-.6-2.25 0l-7.8 7.8zM8 4h16c2.21 0 4 1.79 4 4v16c0 2.21-1.79 4-4 4H8c-2.21 0-4-1.79-4-4V8c0-2.21 1.79-4 4-4z"></path></svg>' +
            '</span>' +
            '<span class="bui-checkbox-name">' + SettingsBarTitle + '</span>' +
            '</label></div></div>'
        )

        const checkBox = checkBoxWrapper.querySelector('input')
        checkBox.checked = !disabled
        checkBox.addEventListener('change', () => {
            disabled = !checkBox.checked
            GM_setValue('disabled', disabled)
            if (disabled) stopRuntimeFeatures()
            else startRuntimeFeatures()
            syncWorkerDisabledState()
            updateStatusPanel()
        })

        // 狀態面板（白名單 + 緩衝進度 + 黑名單/死節點）
        const statusPanel = document.createElement('div')
        statusPanel.id = 'bilicdn-status-panel'
        statusPanel.style.cssText = 'font-size:10px;padding:2px 0 6px;line-height:1.6;'
        let lastStatusHtml = ''

        const renderStatusHtml = (html) => {
            if (html === lastStatusHtml) return
            lastStatusHtml = html
            statusPanel.innerHTML = html
            const resetBtn = statusPanel.querySelector('#bilicdn-reset-btn')
            if (resetBtn) {
                resetBtn.addEventListener('click', (e) => {
                    e.stopPropagation()
                    clearBlacklist()
                    clearDeadHosts()
                    updateStatusPanel()
                })
            }
            const reportBtn = statusPanel.querySelector('#bilicdn-report-btn')
            if (reportBtn) {
                reportBtn.addEventListener('click', (e) => {
                    e.stopPropagation()
                    copyDiagReport()
                    reportBtn.textContent = '已複製診斷 ✓'
                    setTimeout(() => { if (document.contains(reportBtn)) reportBtn.textContent = '複製診斷' }, 1500)
                })
            }
        }

        const updateStatusPanel = () => {
            if (disabled) {
                renderStatusHtml('<span style="color:#aaa;">CDN 切換已停用</span>')
                return
            }
            const activeList = activeCdnList.map(c => c.split('.')[0])
            const blackList  = [...blacklistSet].map(c => c.split('.')[0])
            const deadList   = [...knownDeadHosts].map(c => c.split('.')[0])
            const failLog    = Object.entries(cdnFailCount)
                .filter(([, n]) => n > 0)
                .map(([c, n]) => c.split('.')[0] + '×' + n)
                .join(' ')

            const s = Watchdog.stats()
            const pct = Math.min(100, Math.round((s.totalMB / s.targetMB) * 100))
            const barColor = s.reachedTarget ? '#66bb6a' : (pct > 50 ? '#ffb74d' : '#ef5350')
            const bufRow = '<div style="margin-top:4px;color:#90caf9;font-size:10px;">'
                + '緩衝：<b style="color:#fff;">' + s.totalMB + '</b>/' + s.targetMB + 'MB'
                + ' (' + pct + '%)'
                + ' | buf=' + s.bufferedSec + 's'
                + (s.reachedTarget ? ' <span style="color:#66bb6a;">✓達標</span>' : '')
                + '</div>'
                + '<div style="height:3px;background:#333;border-radius:2px;margin-top:2px;overflow:hidden;">'
                + '<div style="width:' + pct + '%;height:100%;background:' + barColor + ';transition:width .3s;"></div>'
                + '</div>'

            let html = '<div style="color:#4fc3f7;">'
                + '白名單：' + (activeList.length ? activeList.join(' > ') : '<span style="color:#ff7043;">無可用節點</span>')
                + '</div>'
                + '<div style="color:#80cbc4;font-size:9px;">非白名單CDN自動重導向 + Watchdog 自動切換</div>'
                + bufRow

            if (blackList.length) {
                html += '<div style="color:#ff7043;margin-top:2px;">黑名單（24h）：' + blackList.join(', ') + '</div>'
            }
            if (deadList.length) {
                html += '<div style="color:#9e9e9e;margin-top:1px;">持久死節點：' + deadList.join(', ') + '</div>'
            }
            if (blackList.length || deadList.length) {
                html += '<div style="margin-top:2px;"><span id="bilicdn-reset-btn" style="cursor:pointer;color:#81c784;text-decoration:underline;">重置黑名單+死節點</span></div>'
            }
            if (failLog) {
                html += '<div style="color:#ffb74d;margin-top:1px;">本次失敗：' + failLog + '</div>'
            }
            if (redirectStats.unstable > 0 || redirectStats.httpdns > 0 || redirectStats.httpdnsAllowed > 0 || redirectStats.httpdnsAutoSwitch > 0) {
                const parts = []
                if (redirectStats.unstable > 0) parts.push('MCDN/PCDN×' + redirectStats.unstable)
                if (redirectStats.httpdns > 0) parts.push('HTTPDNS阻擋×' + redirectStats.httpdns)
                if (redirectStats.httpdnsAllowed > 0) parts.push('HTTPDNS放行×' + redirectStats.httpdnsAllowed)
                if (redirectStats.httpdnsAutoSwitch > 0) parts.push('HTTPDNS自動×' + redirectStats.httpdnsAutoSwitch)
                html += '<div style="color:#ce93d8;margin-top:1px;">改寫：' + parts.join(' | ') + '</div>'
            }
            const httpDnsStatus = getHttpDnsStatus()
            let httpDnsText = httpDnsStatus.mode
            if (httpDnsStatus.ttlMin) httpDnsText += '（' + httpDnsStatus.ttlMin + 'm）'
            if (httpDnsStatus.scores) {
                httpDnsText += ' | block≈' + (httpDnsStatus.scores.block || 0)
                    + ' allow≈' + (httpDnsStatus.scores.allow || 0)
            }
            html += '<div style="color:#9e9e9e;font-size:9px;">HTTPDNS：' + httpDnsText + '</div>'
            if (pageDiscoveredCdn) {
                html += '<div style="color:#9e9e9e;font-size:9px;">頁面 CDN：' + pageDiscoveredCdn.split('.')[0] + '</div>'
            }
            html += '<div style="margin-top:2px;"><span id="bilicdn-report-btn" style="cursor:pointer;color:#4fc3f7;text-decoration:underline;">複製診斷</span></div>'

            renderStatusHtml(html)
        }

        updateStatusPanel()
        const statusTimer = setInterval(() => {
            if (!document.contains(statusPanel)) {
                // 面板被拔掉（換片/切全螢幕重繪）：找錨點重建的工作交給檔案結尾的
                // 常駐看門狗 ensureUiPresent 負責，這裡只偵測「新面板已經生出來」
                // 就收掉自己這顆舊 timer，避免新舊兩套機制同時跑重複建面板。
                if (document.querySelector('#bilicdn-status-panel')) clearInterval(statusTimer)
                return
            }
            if (statusPanel.offsetParent === null) return   // 設定面板收起來時不做無用的更新
            updateStatusPanel()
        }, 1000)

        settingsBar.appendChild(checkBoxWrapper)
        settingsBar.appendChild(statusPanel)
    }

    // 常駐看門狗：waitForElm 只重試 30 秒，若第一次就逾時（網路慢、番劇頁載入久），
    // buildUI 從未執行過，statusTimer 也就從未誕生，面板會永遠不出現。這顆看門狗
    // 不受那次逾時影響，持續每 1.5 秒檢查一次；面板存在時直接休眠 no-op，
    // 面板消失（含「從未建立」與「被拔掉」兩種情況）時才動手找錨點重建。
    const ensureUiPresent = () => {
        if (document.querySelector('#bilicdn-status-panel')) return
        const bar = pickMainSettingsAnchor(document.querySelector('.bpx-player-ctrl-setting-others'))
        if (bar) buildUI(bar)   // buildUI 開頭已有防重入判斷，找到錨點但面板已存在時會自行 no-op
    }

    waitForElm('.bpx-player-ctrl-setting-others', 30000)
        .then(found => buildUI(pickMainSettingsAnchor(found)))
        .catch(e => { uiInjectStatus = 'timeout'; err('UI 注入逾時，改由看門狗持續重試:', e) })

    setInterval(ensureUiPresent, 1500)

})()