// ==UserScript==
// @name         Bilibili CDN 台灣優化
// @namespace    BiliCDN_TW
// @version      1.3.1
// @description  改善台灣網路觀看 Bilibili 影片時的 CDN 連線穩定度，支援自動切換與卡頓監測
// @author       jiyunshi <chocosensei214@gmail.com>
// @license      MIT
// @icon         https://i0.hdslb.com/bfs/static/jinkela/long/images/512.png
// @run-at       document-start
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
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
const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.3.1'
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
const PREFERRED_CDN_LIST_RAW = [
    'upos-sz-mirroraliov.bilivideo.com',
    'upos-sz-mirrorhwov.bilivideo.com',
    'upos-sz-mirrorcosov.bilivideo.com',
    'upos-sz-mirrorali.bilivideo.com',
    'upos-sz-mirrorhw.bilivideo.com',
    'upos-sz-mirrorcos.bilivideo.com',
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

// ── 持久死節點（7d，跨 session）────────────────────────────────────────
// 跳過所有 probe/preconnect，徹底消除 console 紅字
// 標記時機：probe Image() onerror < 30ms (DNS 失敗) / probe timeout / HARD 失敗碼
const DEAD_HOSTS_KEY = 'knownDeadHosts_v1'
const DEAD_HOSTS_TTL = 7 * 24 * 60 * 60 * 1000

const knownDeadHosts = (() => {
    try {
        const raw   = JSON.parse(GM_getValue(DEAD_HOSTS_KEY) || '[]')
        const now   = Date.now()
        const valid = raw.filter(e => e && e.host && e.expireAt > now)
        if (valid.length !== raw.length) GM_setValue(DEAD_HOSTS_KEY, JSON.stringify(valid))
        return new Set(valid.map(e => e.host))
    } catch {
        return new Set()
    }
})()

// 升級/首次安裝：清掉舊黑名單+probe 快取，標記需要重新墊底排序預設台灣節點
let shouldSeedInitialHosts = false
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
            shouldSeedInitialHosts = true
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
        others.push({ host, expireAt: now + DEAD_HOSTS_TTL, reason: reason || 'unknown' })
        GM_setValue(DEAD_HOSTS_KEY, JSON.stringify(others))
    } catch {}
    const idx = activeCdnList.indexOf(host)
    if (idx !== -1) activeCdnList.splice(idx, 1)
}

const clearDeadHosts = () => {
    knownDeadHosts.clear()
    try { GM_setValue(DEAD_HOSTS_KEY, '[]') } catch {}
    PREFERRED_CDN_LIST.forEach(c => {
        if (!activeCdnList.includes(c) && !blacklistSet.has(c)) activeCdnList.push(c)
    })
    activeCdnList.sort((a, b) => PREFERRED_CDN_LIST.indexOf(a) - PREFERRED_CDN_LIST.indexOf(b))
    log('[死節點] 已清除，所有白名單節點重新啟用')
}

// session 動態健康清單；啟動時排除黑名單（24h）+ 死節點（7d）
const activeCdnList = PREFERRED_CDN_LIST.filter(c => !blacklistSet.has(c) && !knownDeadHosts.has(c))

// 加入黑名單：對任意 bilivideo.com hostname 有效（不限白名單）
const addToBlacklist = (cdn) => {
    if (!cdn || blacklistSet.has(cdn)) return
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
                ewmaMbps: +h.ewmaMbps || 0,
                varMbps: +h.varMbps || 0,
                samples: Math.min(+h.samples || 0, 12),
                bytes: +h.bytes || 0,
                failures: Math.min(+h.failures || 0, 2),
                successes: Math.min(+h.successes || 0, 12),
                slowSamples: Math.min(+h.slowSamples || 0, 3),
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
if (shouldSeedInitialHosts && INITIAL_DEAD_HOSTS_TW.length) {
    INITIAL_DEAD_HOSTS_TW.forEach(h => {
        const c = ensureCdnHealth(h)
        if (c) { c.failures = 1; c.lastSeen = Date.now() }
    })
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
    const idx = activeCdnList.indexOf(cdn)
    if (idx !== -1) activeCdnList.splice(idx, 1)
    if (h.softBlocks >= CDN_SOFT_BLOCK_ESCALATE && h.failures >= 2) addToBlacklist(cdn)
    scheduleCdnHealthSave()
}

const recordCdnThroughput = (cdn, bytes, durationMs, playbackRate) => {
    if (!cdn || !bytes || !durationMs || durationMs <= 0) return
    if (blacklistSet.has(cdn) || knownDeadHosts.has(cdn) || isUnstableCdnHost(cdn)) return
    const mbps = (bytes * 8) / durationMs / 1000
    if (!Number.isFinite(mbps) || mbps <= 0) return
    const h = ensureCdnHealth(cdn)
    if (!h) return
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
    h.bytes += bytes
    h.lastSeen = Date.now()
    if (bytes >= 128 * 1024) {
        // 用真實 playbackRate 計算需求；倍速時 required 等比例放大
        const required = getRequiredStreamMbps(playbackRate, 'steady')
        if (mbps < required) {
            h.slowSamples++
            h.lastSlowAt = h.lastSeen
        } else {
            h.slowSamples = Math.max(0, h.slowSamples - 1)
        }
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

const getCdnHealthScore = (cdn) => {
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
    const nEff  = getEffectiveSamples(cdn)
    const total = getTotalEffectiveSamples()
    const exploreBonus = UCB_EXPLORE_C * Math.sqrt(Math.log(total + 1) / (nEff + 1))

    // ── penalty：同樣換算到 0~1 級距，延遲探測（favicon RTT，資訊量低）權重壓到最多 10%
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

const getHealthyCdnList = () => {
    const candidates = activeCdnList
        .filter(cdn => (cdnFailCount[cdn] || 0) < CDN_FAIL_THRESHOLD)
        .map((cdn, index) => ({ cdn, index, health: cdnHealth[cdn], score: getCdnHealthScore(cdn) }))
    const usable = candidates.filter(item => !isCdnStronglyBad(item.cdn))
    const indexed = usable.length ? usable : candidates

    indexed.sort((a, b) => {
        const aHasSamples = !!(a.health && a.health.samples)
        const bHasSamples = !!(b.health && b.health.samples)
        if (aHasSamples || bHasSamples) {
            if (a.score !== b.score) return b.score - a.score
            if ((a.health ? a.health.ewmaMbps : 0) !== (b.health ? b.health.ewmaMbps : 0)) {
                return (b.health ? b.health.ewmaMbps : 0) - (a.health ? a.health.ewmaMbps : 0)
            }
        }
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
}

const getBestCdn = () => {
    const healthy = getHealthyCdnList()
    if (healthy.length) {
        let pick = healthy[0]
        // 黏著滯後：現用節點（lastChosenCdn）沒輸最高分超過 CDN_STICKY_MARGIN、且還在
        // 候選池裡，就留著不換（見上方 lastChosenCdn 宣告處的完整說明）。這是唯一
        // 讀寫 lastChosenCdn 的地方——getHealthyCdnList() 本身保持單純排序，不受
        // 「誰呼叫它」影響黏著狀態。
        if (lastChosenCdn && lastChosenCdn !== pick && healthy.includes(lastChosenCdn)) {
            const curScore = getCdnHealthScore(lastChosenCdn)
            const topScore = getCdnHealthScore(pick)
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
    preconnectBatch(activeCdnList.slice(0, 3), true)
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

const getCurrentCdn   = () => resolvedCdn || getBestCdn()
const getCdnShortName = () => { const c = getCurrentCdn(); return c ? c.split('.')[0] : 'N/A' }

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
    if (/^cn-[a-z]{2}-/.test(host) && host.endsWith('.bilivideo.com')) return true
    return false
}

const getFallbackCdnHost = () =>
    resolvedCdn || pageDiscoveredCdn || getCurrentCdn() || activeCdnList[0] || PREFERRED_CDN_LIST[0] || null

const rewriteUnstableMediaUrl = (urlStr) => {
    if (!urlStr) return null
    try {
        const u = new URL(urlStr)
        if (!isUnstableCdnHost(u.hostname)) return null

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
        reloadProfile: () => { profile = loadProfile() },
    }
})()

const getHttpDnsStatus = () => HttpDnsAutoPilot.getStatus()
const shouldBlockHttpDns = () => HttpDnsAutoPilot.shouldBlock()
const setHttpDnsMode = (mode) => HttpDnsAutoPilot.setMode(mode)
const isHttpDnsAutoAllowing = () => !HttpDnsAutoPilot.shouldBlock() && httpDnsMode === 'auto'

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
}

// 非白名單 / 已黑名單 / 命中排除關鍵字 → 重導向
const needsRedirect = (cdn) => {
    if (!cdn) return false
    if (matchesExclude(cdn)) return true
    if (isForcedRedirect(cdn)) return true
    return knownDeadHosts.has(cdn) || blacklistSet.has(cdn) || isCdnStronglyBad(cdn) || !PREFERRED_CDN_LIST.includes(cdn)
}

const replaceUrlHost = (urlStr, targetHost) => {
    if (!urlStr || (!isBiliVideoUrl(urlStr) && !isAkamaiUrl(urlStr))) return null
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
    return getHealthyCdnList()
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
    const biliSrcUrl = validUrls.find(isBiliVideoUrl)
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
        item.backup_url = buildBackupUrls(biliSrcUrl)
        item.backupUrl  = item.backup_url
    } else if (biliSrcUrl) {
        const bestCdn = getCurrentCdn()
        const primUrl = bestCdn ? replaceUrlHost(biliSrcUrl, bestCdn) : biliSrcUrl
        if (primUrl) {
            if (isDash) { item.base_url = primUrl; item.baseUrl = primUrl }
            else         { item.url = primUrl }
        }
        item.backup_url = buildBackupUrls(primUrl || biliSrcUrl)
        if (akamaiUrl && !item.backup_url.includes(akamaiUrl)) {
            item.backup_url.unshift(akamaiUrl)
        }
        item.backupUrl  = item.backup_url
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

    const transformList = (list, isDash) => {
        if (!Array.isArray(list)) return { total: 0, akamai: 0 }
        let akamai = 0
        list.forEach(item => { if (transformStreamItem(item, isDash)) akamai++ })
        return { total: list.length, akamai }
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
    const handleInterceptedResponse = (response, url) =>
        interceptors.reduce((m, h) => { const r = h(m, url); return r !== undefined ? r : m }, response)

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

        send(...args) {
            if (this._biliJsonMetadata && !disabled) {
                try { this.setRequestHeader('Accept', 'application/json, text/plain, */*') } catch {}
            }

            if (this._blockAbort) {
                const self = this
                setTimeout(() => { try { self.abort() } catch {} }, 0)
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
            if (this.readyState !== this.DONE) return super.responseText
            if (disabled) return super.responseText
            if (!isPlayUrlApi(this._interceptUrl || this.responseURL)) return super.responseText
            return handleInterceptedResponse(super.responseText, this._interceptUrl || this.responseURL)
        }
        get response() {
            if (this.readyState !== this.DONE) return super.response
            if (disabled) return super.response
            if (!isPlayUrlApi(this._interceptUrl || this.responseURL)) return super.response
            return handleInterceptedResponse(super.response, this._interceptUrl || this.responseURL)
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
            return Promise.reject(new DOMException('BiliCDN blocked httpdns', 'AbortError'))
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
                throw err
            })
        }

        // playurl API 回應攔截
        if (!isPlayUrlApi(urlStr)) return OriginalFetch(input, init)
        return OriginalFetch(input, init).then(response =>
            new Promise(resolve =>
                response.text().then(text =>
                    resolve(new Response(
                        handleInterceptedResponse(text, urlStr),
                        { status: response.status, statusText: response.statusText, headers: response.headers }
                    ))
                )
            )
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
// 3. Image() 探測：onload/onerror 都代表 TCP+TLS+HTTP roundtrip 完成
//    onerror < 30ms = DNS 失敗 → markHostDead；timeout 也標死
const PROBE_CACHE_KEY  = 'probeCache_v1'
const PROBE_CACHE_TTL  = 2 * 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 1200

// 確認 host 是否真的連得到：no-cors fetch 在「伺服器有回應（含 4xx/5xx）」時 resolve，
// 只有「DNS 失敗 / 連線被拒 / TLS 失敗」等網路層錯誤才 reject。
// 用來區分「預連線下的快速 404（可達）」與「真的連不到（該標死）」，避免誤殺好節點。
const confirmHostReachable = (cdn, timeoutMs) => new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    let ctrl = null
    try { ctrl = new AbortController() } catch {}
    const to = setTimeout(() => { try { ctrl && ctrl.abort() } catch {} ; done(false) }, timeoutMs || 4000)
    interceptNetResponse.rawFetch('https://' + cdn + '/favicon.ico?_c=' + Date.now(), {
        method: 'GET', mode: 'no-cors', cache: 'no-store',
        credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: ctrl ? ctrl.signal : undefined,
    }).then(() => { clearTimeout(to); done(true) })
      .catch(() => { clearTimeout(to); done(false) })
})

const probeCdnLatency = (cdn) => new Promise((resolve) => {
    if (knownDeadHosts.has(cdn)) return resolve({ cdn, ms: Infinity, skipped: true })

    const t0 = performance.now()
    let done = false
    const finish = (result) => { if (!done) { done = true; resolve(Object.assign({ cdn }, result)) } }
    const timer = setTimeout(() => {
        cleanup()
        // 逾時不直接標死：可能只是當下壅塞。再用較長時間確認真的連不到才標死。
        confirmHostReachable(cdn, 4000).then((reachable) => {
            if (reachable) {
                recordCdnLatency(cdn, PROBE_TIMEOUT_MS)
                softBlockCdn(cdn, 'probe-slow', 5 * 60 * 1000)
                finish({ ms: PROBE_TIMEOUT_MS })
            } else {
                markHostDead(cdn, 'timeout')
                finish({ ms: Infinity, reason: 'timeout' })
            }
        })
    }, PROBE_TIMEOUT_MS)

    const img = new Image()
    const cleanup = () => { img.onload = null; img.onerror = null }
    img.onload = () => {
        clearTimeout(timer); cleanup()
        const ms = performance.now() - t0
        recordCdnLatency(cdn, ms)
        finish({ ms })
    }
    img.onerror = () => {
        clearTimeout(timer); cleanup()
        const dt = performance.now() - t0
        if (dt < 30) {
            // <30ms onerror 可能是 DNS 失敗，也可能是預連線下的快速 404（其實可達）。
            // 用 no-cors fetch 確認，避免把好節點誤標死 7 天。
            confirmHostReachable(cdn, 1500).then((reachable) => {
                if (reachable) {
                    const ms = Math.max(dt, 1)
                    recordCdnLatency(cdn, ms)
                    finish({ ms })
                } else {
                    markHostDead(cdn, 'DNS')
                    finish({ ms: Infinity, reason: 'DNS' })
                }
            })
        } else {
            // HTTP 4xx/5xx，TCP+TLS 已通 → 視為可達
            recordCdnLatency(cdn, dt)
            finish({ ms: dt })
        }
    }
    img.src = 'https://' + cdn + '/favicon.ico?_t=' + Date.now()
})

// ── CDN 吞吐量賽馬（informed init）─────────────────────────────────────
// 延遲（favicon RTT）≠ 下載速度；跨國選節點真正決定卡不卡的是吞吐量。
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

let lastBakeoffAt        = 0
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
                    done({ cdn, mbps: (bytes * 8) / dl / 1000, bytes })
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
const runThroughputBakeoff = async (sampleUrl, skipIfFast = true) => {
    if (disabled || resolvedCdn || bakeoffRunning) return
    if (inSeekGrace()) return
    if (!sampleUrl || !isBiliVideoUrl(sampleUrl)) return
    if (Date.now() - lastBakeoffAt < THRPT_BAKEOFF_COOLDOWN) return

    // 現用節點剛好有新鮮的真實吞吐樣本、且遠高於這支片子實際需要的速度時，
    // 賽馬本身（連續打 1~4 顆候選、每顆最多 768KB）沒有急迫性，反而會在換片起播
    // 最搶頻寬的當下再搶一手頻寬（4K/長片/無損正是這種最禁不起搶的情境）。跳過。
    const preCheckHost = activeCdnList[0]
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
    lastBakeoffAt  = Date.now()
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
        const playingHost = activeCdnList[0]
        const candidates  = PREFERRED_CDN_LIST
            .filter(c => !blacklistSet.has(c) && !knownDeadHosts.has(c) && !isCdnSoftBlocked(c) && !matchesExclude(c))
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
            const r = await probeCdnThroughput(c, sampleUrl, probeBytes, mySignal)
            if (r) ok.push(r)
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

        const ranked = getHealthyCdnList()
        if (ranked.length) {
            activeCdnList.length = 0
            ranked.forEach(c => { if (!activeCdnList.includes(c)) activeCdnList.push(c) })
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
            lastBakeoffAt = 0
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
        if (knownDeadHosts.has(cdn) || blacklistSet.has(cdn) || isCdnSoftBlocked(cdn) || matchesExclude(cdn)) return
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

// document-start 階段就 preconnect（不等 probe，seek 第一刀已來不及）
preconnectBatch(PREFERRED_CDN_LIST.filter(h => !knownDeadHosts.has(h)))

// reorderCdnsByLatency 自己的重入旗標：原本完全沒有防呆，兩個 reorderCdnsByLatency(true)
// 幾乎同時觸發時（例如卡頓 switchCdn 與週期性重評估疊在一起）會交錯清空/填入
// activeCdnList，後完成的一個覆蓋先完成的結果。也順便避開跟 runThroughputBakeoff 同時
// 動 activeCdnList——只在這個方向擋（bakeoff 執行中就不搶著跑 reorder），因為
// switchCdn 是先發 reorder 再發 bakeoff，若反向互擋，bakeoff 會被剛啟動的 reorder
// 立刻擋掉，等於卡頓時「立刻實測」這個功能被靜默失效。
let reorderRunning = false
const reorderCdnsByLatency = async (force) => {
    if (disabled) return
    if (resolvedCdn) { preconnectCdn(resolvedCdn); return }
    if (reorderRunning || bakeoffRunning) return
    reorderRunning = true

    try {
        // Cache hit → 完全不發探測請求
        if (!force) {
            try {
                const cached = JSON.parse(GM_getValue(PROBE_CACHE_KEY) || 'null')
                if (cached && (Date.now() - cached.t) < PROBE_CACHE_TTL && Array.isArray(cached.list)) {
                    activeCdnList.length = 0
                    cached.list.forEach(c => {
                        if (blacklistSet.has(c))   return
                        if (knownDeadHosts.has(c)) return
                        if (isCdnSoftBlocked(c)) return
                        if (!PREFERRED_CDN_LIST.includes(c)) return
                        activeCdnList.push(c)
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

        const candidates = PREFERRED_CDN_LIST.filter(h => !knownDeadHosts.has(h) && !isCdnSoftBlocked(h))
        const results = await Promise.all(candidates.map(probeCdnLatency))
        results.sort((a, b) => a.ms - b.ms)

        activeCdnList.length = 0
        for (const r of results) {
            if (!blacklistSet.has(r.cdn) && !knownDeadHosts.has(r.cdn) && r.ms !== Infinity) {
                activeCdnList.push(r.cdn)
            }
        }
        if (activeCdnList.length === 0) {
            PREFERRED_CDN_LIST.forEach(c => {
                if (!blacklistSet.has(c) && !knownDeadHosts.has(c)) activeCdnList.push(c)
            })
        }
        const ranked = getHealthyCdnList()
        if (ranked.length) {
            activeCdnList.length = 0
            ranked.forEach(c => {
                if (!activeCdnList.includes(c)) activeCdnList.push(c)
            })
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
    const MIN_BUFFER_AHEAD  = 16   // 秒；低於這個值才積極判定 CDN 是否拖慢
    const URGENT_BUFFER_SEC = 5
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
    let lastTickBytes     = 0
    let lastSwitchAt      = 0
    let lastNudgeDetectAt = 0
    let lastTickAt        = 0
    let observer          = null
    let timer             = null
    let started           = false
    let startedAt         = 0
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

    const switchCdn = (reason) => {
        if (inSeekGrace()) return
        if (Date.now() - lastSwitchAt < SWITCH_COOL) return
        lastSwitchAt = Date.now()
        sessionSwitchCount++

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
        // 延遲探測（favicon RTT）本身也在搶頻寬，且卡頓當下最有參考價值的是賽馬（真實 segment）。
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
            lastBakeoffAt = 0
            runThroughputBakeoff(lastSampleSegmentUrl, false).catch(() => {})
        }
        // 不 nudge currentTime：跟 bili player 內建 Stuck:Rescue 搶會 buffer 抖動
        // 軟封鎖 + 下次 segment 走攔截層改 host 就夠
    }

    const tick = () => {
        const v = getVideo()
        if (!v) return

        // 背景分頁偵測：瀏覽器會把 timer 節流（背景 ≥1/min、5 分後更嚴）。
        // tick 間隔遠大於 1s 代表剛從背景切回，期間 bps/buffered 取樣全部失真，
        // 此時若照常判定會誤以為 CDN 變慢而切換 → 切回前景反而 reload。
        // 只重設基準、清 stallCount，跳過這一輪。
        const nowTick   = Date.now()
        const sinceLast = lastTickAt ? nowTick - lastTickAt : TICK_MS
        lastTickAt      = nowTick
        if (sinceLast > TICK_MS * 3) {
            lastTickBytes   = totalBytes
            lastCurrentTime = v.currentTime
            lastBufferedEnd = bufferedEnd(v)
            stallCount      = 0
            return
        }

        const be  = bufferedEnd(v)
        const bps = (totalBytes - lastTickBytes) / Math.max(0.2, sinceLast / 1000)
        const playRate = v.playbackRate || 1
        latestPlaybackRate = playRate
        const targetBytes = getBufferTargetBytes(playRate)
        lastTickBytes = totalBytes

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
        // 對 4K 提早判斷（緩衝還很多時就開始看夠不夠快）、更快反應、用「即時碼率」當太慢門檻。
        const streamMbps  = currentStreamBitsPerSec / 1e6
        const highBitrate = streamMbps >= 12
        const minAheadEff = highBitrate ? 30 : MIN_BUFFER_AHEAD
        const recheckEff  = highBitrate ? 20 : REACHED_RECHECK_BUFFER_SEC
        const stallMaxEff = highBitrate ? 2 : STALL_MAX

        // 剛開播/換片幾秒內的 slow-start 緩衝期：只累積 lastBufferedEnd 基準，不判定停滯，
        // 讓連線先把速度跑起來，避免才剛連上就急著換節點。
        if (Date.now() - startedAt < (highBitrate ? STARTUP_GRACE_MS_HIGH : STARTUP_GRACE_MS)) {
            stallCount = 0
            lastBufferedEnd = be
            return
        }

        const needMoreBuffer = bufferAhead < minAheadEff
        const urgentBuffer = bufferAhead < URGENT_BUFFER_SEC
        const monitorAfterReached = reached && bufferAhead < recheckEff
        if (reached && !monitorAfterReached) {
            stallCount = 0
            lastBufferedEnd = be
            return
        }
        // 4K：門檻 = 即時碼率本身（下載低於它必定耗盡緩衝）；其他畫質沿用較寬鬆的需求值
        const minBps = highBitrate
            ? Math.max(MIN_BPS_FLOOR, streamMbps * 1e6 / 8)
            : Math.max(MIN_BPS_FLOOR, getRequiredStreamMbps(v.playbackRate, 'steady') * 1e6 / 8)
        const stalled = needMoreBuffer
            && (be <= lastBufferedEnd + 0.05)
            && playing
        const tooSlow = needMoreBuffer
            && bps < (urgentBuffer ? minBps * 1.2 : minBps)
            && playing
            && totalBytes > 0
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
            lastTickBytes = 0; lastCurrentTime = 0; lastNudgeDetectAt = 0; lastTickAt = 0
            reached = false; startedAt = Date.now()
            sessionSwitchCount = 0; sessionStallCount = 0; sessionHardFailCount = 0; lastSegmentCdn = null
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
            }
        },
        noteSeek,
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
        '持久死節點（7d）：' + ([...knownDeadHosts].map(c => c.split('.')[0]).join(', ') || '（無）'),
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
        console.log('持久死節點（7d）:', [...knownDeadHosts].map(c => c.split('.')[0]))
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
            dead:    [...knownDeadHosts],
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
    stats() {
        console.log('[BiliCDN] 改寫統計:', redirectStats,
            '| HTTPDNS:', getHttpDnsStatus(),
            '| 頁面 CDN:', pageDiscoveredCdn ? pageDiscoveredCdn.split('.')[0] : '—')
        return { ...redirectStats, pageDiscoveredCdn, httpdns: getHttpDnsStatus() }
    },
    // 手動觸發吞吐量賽馬（用最近一次播放抓到的真實 segment）；忽略冷卻
    bakeoff() {
        if (!lastSampleSegmentUrl) {
            console.log('[BiliCDN] 尚無 segment 樣本，請先播放影片數秒再試')
            return
        }
        lastBakeoffAt = 0
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
    async probe() {
        await reorderCdnsByLatency(true)
        return this.diag()
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
            whitelist: 0,
            httpdns: 0,
            httpdnsAllowed: 0,
            httpdnsAutoSwitch: 0,
            quietRedirects: 0,
        })
        HttpDnsAutoPilot.reset()
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
    clearDead() { clearDeadHosts(); return this.diag() },
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
        if (response === null) return true
        try {
            const playInfo = JSON.parse(response)
            playInfoTransformer(playInfo)
            return JSON.stringify(playInfo)
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
        if (unsafeWindow.__playinfo__) {
            playInfoTransformer(unsafeWindow.__playinfo__)
        } else {
            let internal = unsafeWindow.__playinfo__
            Object.defineProperty(unsafeWindow, '__playinfo__', {
                get: () => internal,
                set: v => { playInfoTransformer(v); internal = v },
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
    const applyPageHooks = () => {
        if (disabled || pageHooksApplied) return
        transformInitialPlayInfo()
        blockWebRtc()
        installVisibilitySpoof()
        installDashFragmentErrorHook()
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

        const seekWarmHosts = () => {
            const hosts = []
            akamaiHostSeen.forEach(h => { if (hosts.length < 2) hosts.push(h) })
            if (activeCdnList[0] && !hosts.includes(activeCdnList[0])) hosts.push(activeCdnList[0])
            if (activeCdnList[1] && hosts.length < 3) hosts.push(activeCdnList[1])
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
    const getVideoKey = () => {
        const m = location.pathname.match(/\/(BV[0-9A-Za-z]+|ep\d+|ss\d+|av\d+)/i)
        return m ? m[1].toLowerCase() : location.pathname
    }
    let currentVideoKey = getVideoKey()
    let spaHooked = false
    const onSpaNavigate = () => {
        const key = getVideoKey()
        if (key === currentVideoKey) return
        currentVideoKey = key
        forcedRedirectHosts.clear()
        akamaiHostSeen.clear()      // 舊片的 Akamai 殘留跟新片無關，不用留著繼續 keep-warm
        lastBakeoffAt = 0           // 解除冷卻，新片可立即賽馬
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
                html += '<div style="color:#9e9e9e;margin-top:1px;">持久死節點（7d）：' + deadList.join(', ') + '</div>'
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