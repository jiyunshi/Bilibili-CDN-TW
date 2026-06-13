// ==UserScript==
// @name         Bilibili CDN 台灣優化
// @namespace    BiliCDN_TW
// @version      1.2.2
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
// @grant        unsafeWindow
// @downloadURL none
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

// PreferredVideoCodec：'hevc' = 4K 優先 HEVC（省頻寬、硬解友善）；'avc' = 最保守；'auto' = 保留原順序
// AV1 只有在瀏覽器明確支援該 representation 時才保留，避免 UI 選 AV1 但播放器實際 fallback 成 AVC。
var PreferredVideoCodec = 'hevc'

// ── 診斷輸出 ──────────────────────────────────────────────────────────
// 預設不輸出背景 log；需要排查時可在 console 執行 BiliCDN.verbose(true)。
const PluginName = 'BiliCDN_TW_v1.2.2'
const Config = { verbose: !!GM_getValue('verbose') }
const log = (...args) => { if (Config.verbose) console.log('[' + PluginName + ']:', ...args) }
const err = (...args) => { if (Config.verbose) console.error('[' + PluginName + ']:', ...args) }

let disabled = !!GM_getValue('disabled')

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

const PREFERRED_CDN_LIST = PREFERRED_CDN_LIST_RAW.filter(h => !matchesExclude(h))

// ── 黑名單（24h，session 失敗累積觸發）+ HARD 失敗碼 ─────────────────
// HARD 狀態碼 = 區域/權限永久拒絕，一次就黑名單 + 標死節點
const BLACKLIST_EXPIRE_MS = 24 * 60 * 60 * 1000
const CDN_FAIL_THRESHOLD  = 2
const HARD_FAIL_STATUSES  = new Set([403, 451, 959])
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

// 升級/首次安裝：清掉舊黑名單+probe 快取，注入預設台灣死節點
try {
    const installedVersion = GM_getValue('blicdnVersion')
    if (installedVersion !== '1.2.2') {
        // 1.1.0+ 改用實測下載速度挑節點；舊 probe 快取是延遲排序，一律清掉重學
        GM_setValue('probeCache_v1', null)
        const stateSafeVersions = new Set(['1.0.0', '1.1.0', '1.2.0', '1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.3.0', '1.4.0', '4.4.6', '4.5.0', '4.5.1', '4.6.1', '4.6.2', '4.6.3', '4.6.4', '4.6.7', '4.6.8', '4.6.9', '4.7.0'])
        if (!installedVersion || !stateSafeVersions.has(installedVersion)) {
            GM_setValue('cdnBlacklist', '[]')
            GM_setValue('probeCache_v1', null)
            if (INITIAL_DEAD_HOSTS_TW.length) {
                try {
                    const raw      = JSON.parse(GM_getValue(DEAD_HOSTS_KEY) || '[]')
                    const existing = new Set(raw.map(e => e.host))
                    const now      = Date.now()
                    let added = 0
                    INITIAL_DEAD_HOSTS_TW.forEach(h => {
                        if (existing.has(h)) return
                        raw.push({ host: h, expireAt: now + DEAD_HOSTS_TTL, reason: 'preset-TW' })
                        knownDeadHosts.add(h)
                        added++
                    })
                    if (added) GM_setValue(DEAD_HOSTS_KEY, JSON.stringify(raw))
                } catch {}
            }
        }
        GM_setValue('blicdnVersion', '1.2.2')
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

const getRequiredStreamMbps = (playbackRate) => {
    const rate = playbackRate && playbackRate > 0
        ? Math.max(playbackRate, 1)
        : Math.max(latestPlaybackRate || 1, 1)
    const streamMbps = currentStreamBitsPerSec > 0 ? currentStreamBitsPerSec / 1e6 : 4
    return Math.max(1.5, streamMbps * rate * 0.75)
}

const ensureCdnHealth = (cdn) => {
    if (!cdn) return null
    if (!cdnHealth[cdn]) {
        cdnHealth[cdn] = {
            ewmaMbps: 0,
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
    h.ewmaMbps = h.samples
        ? (h.ewmaMbps * (1 - CDN_THROUGHPUT_ALPHA)) + (mbps * CDN_THROUGHPUT_ALPHA)
        : mbps
    h.samples++
    h.bytes += bytes
    h.lastSeen = Date.now()
    if (bytes >= 128 * 1024) {
        // 用真實 playbackRate 計算需求；倍速時 required 等比例放大
        const required = getRequiredStreamMbps(playbackRate)
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
const UCB_EXPLORE_C          = 2.5          // 探索強度（≈Mbps 當量），越大越積極試新節點
const THROUGHPUT_HALFLIFE_MS = 8 * 60 * 1000 // 吞吐量樣本半衰期

const getTotalCdnSamples = () => {
    let n = 0
    for (const k in cdnHealth) n += (cdnHealth[k].samples || 0)
    return n
}

const getCdnHealthScore = (cdn) => {
    const h = cdnHealth[cdn]
    const failPenalty = (cdnFailCount[cdn] || 0) * 8 + (h ? h.failures * 5 : 0)
    const slowPenalty = h ? h.slowSamples * 4 : 0
    const softPenalty = isCdnSoftBlocked(cdn) ? 60 : 0
    const latencyPenalty = h && h.latencyMs ? Math.min(8, h.latencyMs / 120) : 0

    const samples = h ? h.samples : 0
    let throughput = (h && samples) ? h.ewmaMbps : 0
    if (h && samples && h.lastSeen) {
        const age = Date.now() - h.lastSeen
        if (age > 0) throughput *= Math.pow(0.5, age / THROUGHPUT_HALFLIFE_MS)
    }

    const total = getTotalCdnSamples()
    const exploreBonus = UCB_EXPLORE_C * Math.sqrt(Math.log(total + 1) / (samples + 1))

    return throughput + exploreBonus - failPenalty - slowPenalty - softPenalty - latencyPenalty
}

const isCdnStronglyBad = (cdn) => {
    if (!cdn) return false
    if (knownDeadHosts.has(cdn)) return true
    if (isCdnSoftBlocked(cdn)) return true
    if ((cdnFailCount[cdn] || 0) >= CDN_FAIL_THRESHOLD) return true
    const h = cdnHealth[cdn]
    if (!h) return false
    if (h.failures >= 2 && h.successes === 0) return true
    if (h.samples >= 2 && h.slowSamples >= 2 && h.ewmaMbps < getRequiredStreamMbps() * 0.85) return true
    return h.failures >= 3 && h.failures > h.successes
}

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

const recordCdnFailure = (cdn, hard) => {
    if (!cdn) return
    if (blacklistSet.has(cdn) || knownDeadHosts.has(cdn)) return
    recordCdnPenalty(cdn, hard)
    if (hard) {
        cdnFailCount[cdn] = CDN_FAIL_THRESHOLD
        addToBlacklist(cdn)
        markHostDead(cdn, 'HARD-fail')
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
    if (healthy.length) return healthy[0]
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
        GM_setValue('CustomCDN', null)
    } else {
        domain = stored || null
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

const isBvcUrl = (url) => !!(url && url.includes('bvc.bilivideo.com'))

const isHttpDnsUrl = (url) => {
    try { return new URL(url).hostname === 'httpdns.bilivideo.com' } catch { return false }
}

const isBiliJsonMetadataApi = (url) => {
    try {
        const u = new URL(url, location.href)
        if (u.hostname !== 'api.bilibili.com') return false
        return u.pathname === '/x/v2/subtitle/web/view'
            || u.pathname === '/x/v2/dm/web/view'
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
const HTTPDNS_SCORE_MARGIN = 8

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

    const computeScore = (m) => {
        const elapsedSec = Math.max(1, m.elapsedSec || 1)
        const mbps = (m.totalBytes || 0) / 1024 / 1024 / elapsedSec
        const score = mbps * 100
            - (m.stallEvents || 0) * 50
            - (m.hardFailCount || 0) * 80
            - (m.switchCount || 0) * 30
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

    let session = null
    // 進入 trial-allow 時記錄 watchdog 累計快照，
    // 結算時用 delta 算分，避免混入 trial 之前的播放數據。
    let trialBaseline = null

    const subtractBaseline = (sample, baseline) => {
        if (!baseline) return sample
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
        try { GM_setValue(PROBE_CACHE_KEY, null) } catch {}
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

    const beginSession = () => {
        session = {
            strategy: shouldBlock() ? 'block' : 'allow',
            startedAt: Date.now(),
            totalBytes: 0,
            stallEvents: 0,
            switchCount: 0,
            hardFailCount: 0,
            reachedTarget: false,
        }
    }

    const noteBytes = (bytes) => { if (session && bytes > 0) session.totalBytes += bytes }

    const noteStall = () => { if (session) session.stallEvents++ }

    const noteSwitch = () => { if (session) session.switchCount++ }

    const noteHardFail = () => { if (session) session.hardFailCount++ }

    const finalizeSession = (patch) => {
        if (!session) return null
        const sample = Object.assign({}, session, patch || {})
        sample.elapsedSec = Math.max(1, (Date.now() - sample.startedAt) / 1000)
        const score = recordSample(sample.strategy, sample)
        session = null
        return { strategy: sample.strategy, score, sample }
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
            session = null
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
            session = null
            endTrialAllow('target-reached', sample)
            return
        }
        // 非 trial：以 watchdog 累計值（自 start 起）做粗略 sample；
        // session 機制名存實亡（patch 會覆蓋累計欄位），直接 recordSample 更乾淨。
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
        session = null
        endTrialAllow('trial-timeout', sample)
    }

    const reset = () => {
        profile = emptyProfile(getNetworkKey())
        saveProfile()
        autoState = { phase: 'none', allowUntil: 0, trialStartedAt: 0, trialScore: 0, lastReason: '', lastChangedAt: Date.now() }
        saveAutoState()
        session = null
        trialBaseline = null
    }

    const setMode = (mode) => {
        httpDnsMode = normalizeHttpDnsMode(mode)
        BlockHttpDNS = httpDnsMode
        if (httpDnsMode !== 'auto') reset()
        beginSession()
        return getStatus()
    }

    beginSession()

    return {
        shouldBlock,
        getStatus,
        onStall,
        onTargetReached,
        tick,
        noteBytes,
        noteStall,
        noteSwitch,
        noteHardFail,
        reset,
        setMode,
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
        if (!originCdn || !forcedRedirectHosts.has(originCdn)) return { url: urlStr, changed: false, originCdn }
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
            || forcedRedirectHosts.has(originCdn)
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
        const host = new URL(url).hostname
        return isUnstableCdnHost(host) || (host.endsWith('.akamaized.net') && forcedRedirectHosts.has(host))
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
    const count = (_redirectLogTs[key + ':n'] || 0) + 1
    const total = (_redirectLogTotal[key] || 0) + 1
    _redirectLogTotal[key] = total
    _redirectLogTs[key + ':n'] = count
    if (channel === 'Transport' && total > QUIET_REDIRECT_AFTER && total % QUIET_REDIRECT_EVERY !== 0) {
        redirectStats.quietRedirects++
        return
    }
    if (now - last < REDIRECT_LOG_COOLDOWN) return
    _redirectLogTs[key] = now
    _redirectLogTs[key + ':n'] = 0
}

// 非白名單 / 已黑名單 / 命中排除關鍵字 → 重導向
const needsRedirect = (cdn) => {
    if (!cdn) return false
    if (matchesExclude(cdn)) return true
    if (forcedRedirectHosts.has(cdn)) return true
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
        if (typeof value !== 'string') return value
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

// 改寫 dash/durl item 的 base_url + backup_url
// 4K/高碼率：白名單 CDN 為主、Akamai 放 backup，避免首段大 fragment 卡在單一 Akamai。
// 一般碼率：來源含 Akamai 時仍優先 Akamai，純 bilivideo 則換成最佳白名單。
const transformStreamItem = (item, isDash) => {
    if (!item) return false
    isDash = isDash !== false

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
        if (kind === 'hevc') return 0
        if (kind === 'avc') return 1
        if (kind === 'av1') return 2
        return 3
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
                const totalMbps = (maxV + maxA) / 1e6
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

            // bvc：直接 abort；HTTPDNS 依 true / false / auto 判斷
            if (isBvcUrl(urlStr) || (isHttpDnsUrl(urlStr) && shouldBlockHttpDns())) {
                this._bvcBlocked   = true
                this._interceptUrl = urlStr
                if (isHttpDnsUrl(urlStr)) {
                    redirectStats.httpdns++
                }
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
            if (this._biliJsonMetadata) {
                try { this.setRequestHeader('Accept', 'application/json, text/plain, */*') } catch {}
            }

            if (this._bvcBlocked) {
                const self = this
                setTimeout(() => { try { self.abort() } catch {} }, 0)
                return
            }

            // 只在真正的網路錯誤（error 事件）或 4xx/5xx 計失敗
            // status=0 多半是 player 主動 abort（seek/換畫質），不計失敗
            if (this._originCdn) {
                const cdn  = this._redirectedCdn || this._originCdn
                const self = this
                let aborted = false
                this.addEventListener('abort', () => { aborted = true })
                this.addEventListener('error', () => {
                    if (aborted) return
                    recordCdnFailure(cdn)
                })
                this.addEventListener('readystatechange', function () {
                    if (self.readyState !== XMLHttpRequest.DONE) return
                    if (aborted) return
                    if (HARD_FAIL_STATUSES.has(self.status)) {
                        recordCdnFailure(cdn, true)
                    } else if (self.status >= 500) {
                        recordCdnFailure(cdn)
                    } else if (self.status >= 200 && self.status < 400) {
                        recordCdnSuccess(cdn)
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

            return OriginalFetch(fetchInput, init).then(res => {
                if (res.ok) {
                    recordCdnSuccess(targetCdn)
                } else if (HARD_FAIL_STATUSES.has(res.status)) {
                    recordCdnFailure(targetCdn, true)
                } else if (res.status >= 500) {
                    recordCdnFailure(targetCdn)
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

    return interceptNetResponse
})(unsafeWindow)

// 若播放器把 segment 請求放進 Worker，補一層輕量 fetch/XHR host 改寫。
// classic Worker 用 importScripts；module Worker 僅包同源 script，避免跨源 module import 破壞 player。
const biliCdnWorkers = new Set()
const getWorkerCdnTarget = () => resolvedCdn || getBestCdn() || activeCdnList[0] || PREFERRED_CDN_LIST[0] || ''

// worker 強制改寫清單：soft-block / strongly-bad 的 preferred 主機（worker 預設不認這些），
// 外加賽馬勝者切換時明確指定的舊主機。讓中途切換對 worker segment 流量也生效。
const forcedRedirectHosts = new Set()
const getWorkerForceList = () => {
    const out = new Set(forcedRedirectHosts)
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

const setupClassicWorkerIntercept = () => {
    try {
        const OriginalWorker = unsafeWindow.Worker
        if (!OriginalWorker || OriginalWorker.__biliCdnPatched) return

        const preferred = [...PREFERRED_CDN_LIST]
        const excludes = [...ExcludeHostKeywords]
        const targetHost = getWorkerCdnTarget()
        if (!targetHost) return
        const forceList = getWorkerForceList()

        const sharedWorkerPatch = () => `
let BILICDN_TARGET_HOST = ${JSON.stringify(targetHost)};
let BILICDN_FORCE = ${JSON.stringify(forceList)};
const BILICDN_PREFERRED = ${JSON.stringify(preferred)};
const BILICDN_EXCLUDES = ${JSON.stringify(excludes)};
let BILICDN_BYTES_PORT = null;
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
        if (!biliCdnIsMedia(url)) return url;
        const u = new URL(url);
        if (!biliCdnNeedsRedirect(u.hostname) || u.hostname === BILICDN_TARGET_HOST) return url;
        u.hostname = BILICDN_TARGET_HOST;
        u.port = '';
        return u.toString();
    } catch {
        return url;
    }
};
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
                if (resp && biliCdnIsMedia(resp.url || rewritten)) {
                    const cl = resp.headers && resp.headers.get && resp.headers.get('content-length');
                    if (cl) biliCdnNoteSeg(resp.url || rewritten, parseInt(cl, 10));
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
                this.addEventListener('load', () => {
                    try {
                        if (!biliCdnIsMedia(rewritten)) return;
                        const cl = this.getResponseHeader && this.getResponseHeader('content-length');
                        let n = cl ? parseInt(cl, 10) : 0;
                        if (!n && this.response) {
                            if (this.response.byteLength) n = this.response.byteLength;
                            else if (typeof this.response === 'string') n = this.response.length;
                        }
                        if (n) biliCdnNoteSeg(rewritten, n);
                    } catch (e) {}
                });
            } catch (e) {}
            return super.open(method, rewritten, ...rest);
        }
    };
}
`

        const classicWorkerPatch = (originalUrl) => `
${sharedWorkerPatch()}
const BiliCdnOriginalImportScripts = self.importScripts.bind(self);
self.importScripts = (...urls) => BiliCdnOriginalImportScripts(...urls.map((url) => {
    try { return new URL(url, BILICDN_ORIGINAL).href; } catch { return url; }
}));
const BILICDN_ORIGINAL = ${JSON.stringify(originalUrl)};
importScripts(BILICDN_ORIGINAL);
`

        const moduleWorkerPatch = (originalUrl) => `
${sharedWorkerPatch()}
import(${JSON.stringify(originalUrl)}).catch(() => {});
`

        const registerWorker = (worker) => {
            biliCdnWorkers.add(worker)
            setTimeout(() => {
                try { worker.postMessage({ __biliCdnSetTarget: getWorkerCdnTarget(), __biliCdnForce: getWorkerForceList() }) } catch {}
            }, 0)
            // 建立專屬 MessagePort 接收 Worker 回報的 segment 下載量（不污染播放器訊息通道、不跨分頁）
            try {
                const mc = new MessageChannel()
                mc.port1.onmessage = (e) => {
                    const d = e && e.data
                    if (d && d.bytes && Watchdog && Watchdog.noteExternalBytes) Watchdog.noteExternalBytes(d.host, d.bytes)
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
                    const source = isModule ? moduleWorkerPatch(originalUrl) : classicWorkerPatch(originalUrl)
                    const blob = new Blob([source], { type: 'application/javascript' })
                    const blobUrl = URL.createObjectURL(blob)
                    const worker = registerWorker(super(blobUrl, options))
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000)
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
// 1. 結果快取 6h，保留穩定排序但避免網路環境變動後卡太久
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
    fetch('https://' + cdn + '/favicon.ico?_c=' + Date.now(), {
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
const THRPT_SWITCH_MARGIN    = 1.25          // 勝者需比現用節點快 25% 才中途切換，避免抖動

let lastBakeoffAt        = 0
let bakeoffRunning       = false
let bakeoffTimer         = null
let lastSampleSegmentUrl = null

// 多分頁協調鉤子（預設放行；Main IIFE 啟動跨分頁協調後覆寫）。
// 多開分頁時若多個分頁同時賽馬會互搶台灣上行頻寬而互相低估吞吐量，故需互斥。
let crossTabShouldBakeoff = () => true
let onBakeoffStart        = () => {}

// 對單一候選量吞吐量：ranged GET，扣掉 TTFB 只算純下載時間，降低 slow-start 偏差。
// probeBytes 可調：高碼率（4K）用較大量，讓 TCP 慢啟動展開、節點之間分得出快慢。
const probeCdnThroughput = (cdn, sampleUrl, probeBytes) => new Promise((resolve) => {
    if (!cdn || blacklistSet.has(cdn) || knownDeadHosts.has(cdn)) return resolve(null)
    const target = replaceUrlHost(sampleUrl, cdn)
    if (!target) return resolve(null)

    const wantBytes = probeBytes || THRPT_PROBE_BYTES
    const ctrl = new AbortController()
    const to   = setTimeout(() => { try { ctrl.abort() } catch {} }, THRPT_PROBE_TIMEOUT)
    const t0   = performance.now()
    let ttfb   = 0
    let bytes  = 0

    const done = (result) => { clearTimeout(to); try { ctrl.abort() } catch {} ; resolve(result) }

    fetch(target, {
        method: 'GET',
        headers: { Range: 'bytes=0-' + (wantBytes - 1) },
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
        referrerPolicy: 'no-referrer',
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
const runThroughputBakeoff = async (sampleUrl) => {
    if (disabled || resolvedCdn || bakeoffRunning) return
    if (inSeekGrace()) return
    if (!sampleUrl || !isBiliVideoUrl(sampleUrl)) return
    if (Date.now() - lastBakeoffAt < THRPT_BAKEOFF_COOLDOWN) return
    if (!crossTabShouldBakeoff()) return  // 其他分頁正在賽馬 → 本輪跳過
    bakeoffRunning = true
    lastBakeoffAt  = Date.now()
    onBakeoffStart()                      // 通知其他分頁本分頁開始賽馬
    // 註：不在此 clear forcedRedirectHosts——原始 base_url 主機一旦被切走必須永遠保持改寫，
    // 否則 segment 會跑回慢節點。清除只在 SPA 換片（新的 base_url）時做。

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
            if (disabled) break
            const r = await probeCdnThroughput(c, sampleUrl, probeBytes)
            if (r) ok.push(r)
        }

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

        const best = activeCdnList[0]
        // 勝者明顯比現用節點快 → 強制 worker 把舊主機改寫到勝者（中途切換、不 reload）
        if (best && playingHost && best !== playingHost) {
            const hb = cdnHealth[best], ho = cdnHealth[playingHost]
            const mb = (hb && hb.samples) ? hb.ewmaMbps : 0
            const mo = (ho && ho.samples) ? ho.ewmaMbps : 0
            if (mb > 0 && mb > mo * THRPT_SWITCH_MARGIN) {
                forcedRedirectHosts.add(playingHost)
                log('[Bakeoff] 中途切換 ' + playingHost.split('.')[0] + ' → ' + best.split('.')[0]
                    + '（' + mo.toFixed(1) + '→' + mb.toFixed(1) + ' Mbps）')
            }
        }

        promoteBestCdnNow()
        try { GM_setValue(PROBE_CACHE_KEY, JSON.stringify({ t: Date.now(), list: [...activeCdnList] })) } catch {}
    } finally {
        bakeoffRunning = false
    }
}

const scheduleBakeoff = (sampleUrl) => {
    if (sampleUrl) lastSampleSegmentUrl = sampleUrl
    if (disabled || resolvedCdn || bakeoffTimer) return
    // 4K 開播當下最吃頻寬，測速會跟「初始緩衝」搶頻寬而拖慢起播 →
    // 4K 改為延後較久（先讓畫面開起來、緩衝拉起再測速）；一般畫質維持較短延遲。
    const highBitrate = currentStreamBitsPerSec / 1e6 >= 12
    bakeoffTimer = setTimeout(() => {
        bakeoffTimer = null
        runThroughputBakeoff(sampleUrl).catch(() => {})
    }, highBitrate ? 4000 : 1500)
}

let dashFragmentErrorHooked = false
const installDashFragmentErrorHook = () => {
    if (dashFragmentErrorHooked) return
    dashFragmentErrorHooked = true

    const handleFragmentError = (args) => {
        if (disabled) return
        let url = ''
        let code = 0
        const text = args.map(arg => {
            if (arg && typeof arg === 'object') {
                if (!url && typeof arg.url === 'string') url = arg.url
                if (!code && Number(arg.code)) code = Number(arg.code)
                try { return JSON.stringify(arg) } catch { return '' }
            }
            return String(arg)
        }).join(' ')

        if (!/Fragment Loaded Error|fragmentLoadedError|4105/i.test(text)) return
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
        if (!url) return

        let host = ''
        try { host = new URL(url).hostname } catch {}
        if (!host) return

        forcedRedirectHosts.add(host)
        if (host.endsWith('.bilivideo.com') || host.endsWith('.bilivideo.cn')) {
            recordCdnFailure(host)
            softBlockCdn(host, 'fragment-error-' + (code || 'unknown'), 5 * 60 * 1000)
        }
        promoteBestCdnNow()
        preconnectBatch(getHealthyCdnList().slice(0, 3), true)
        syncWorkerCdnTarget()
        if (lastSampleSegmentUrl && currentStreamBitsPerSec / 1e6 >= 12) {
            lastBakeoffAt = 0
            runThroughputBakeoff(lastSampleSegmentUrl).catch(() => {})
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

// 動態收集 Akamai host（從 API/PerformanceObserver 看到的）
const akamaiHostSeen = new Set()
const noteAkamaiHost = (urlStr) => {
    try {
        const h = new URL(urlStr).hostname
        if (h.endsWith('.akamaized.net') && !akamaiHostSeen.has(h)) {
            akamaiHostSeen.add(h)
            preconnectCdn(h)
        }
    } catch {}
}

// document-start 階段就 preconnect（不等 probe，seek 第一刀已來不及）
preconnectBatch(PREFERRED_CDN_LIST.filter(h => !knownDeadHosts.has(h)))

const reorderCdnsByLatency = async (force) => {
    if (disabled) return
    if (resolvedCdn) { preconnectCdn(resolvedCdn); return }

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

    let totalBytes        = 0
    let lastBufferedEnd   = 0
    let lastCurrentTime   = 0
    let stallCount        = 0
    let lastTickBytes     = 0
    let lastSwitchAt      = 0
    let lastNudgeDetectAt = 0
    let lastSeekAt        = 0
    let lastTickAt        = 0
    let observer          = null
    let timer             = null
    let started           = false
    let startedAt         = 0
    let reached           = false
    let sessionSwitchCount = 0
    let sessionStallCount  = 0
    let lastSegmentCdn     = null
    const perCdnBytes     = {}

    const getWatchdogSample = () => ({
        totalBytes,
        stallEvents: sessionStallCount,
        switchCount: sessionSwitchCount,
        hardFailCount: 0,
        elapsedSec: Math.max(1, (Date.now() - startedAt) / 1000),
        reachedTarget: reached,
    })

    const onEntry = (entry) => {
        if (!entry || !entry.name) return
        if (!/\.m4s($|\?)/i.test(entry.name) && !/\.flv($|\?)/i.test(entry.name)) return
        const bytes = entry.transferSize || entry.encodedBodySize || 0
        if (!bytes) return
        totalBytes += bytes
        HttpDnsAutoPilot.noteBytes(bytes)
        try {
            const h = new URL(entry.name).hostname
            lastSegmentCdn = h
            perCdnBytes[h] = (perCdnBytes[h] || 0) + bytes
            // 用最新觀察到的播放倍速計算 required Mbps，避免倍速下少抓 slow
            const v = getVideo()
            const rate = v && v.playbackRate ? v.playbackRate : latestPlaybackRate
            recordCdnThroughput(h, bytes, entry.duration || 0, rate)
        } catch {}
    }

    const getVideo = () => {
        let best = null, bestArea = 0
        document.querySelectorAll('video').forEach(v => {
            const a = (v.clientWidth || 0) * (v.clientHeight || 0)
            if (a > bestArea) { bestArea = a; best = v }
        })
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
        lastSeekAt = Date.now()
        stallCount = 0
        bumpSeekGrace()
    }

    const switchCdn = (reason) => {
        if (inSeekGrace()) return
        if (Date.now() - lastSwitchAt < SWITCH_COOL) return
        lastSwitchAt = Date.now()
        sessionSwitchCount++
        HttpDnsAutoPilot.noteSwitch()

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

        try { GM_setValue(PROBE_CACHE_KEY, null) } catch {}
        promoteBestCdnNow()
        preconnectBatch(getHealthyCdnList().slice(0, 3), true)
        reorderCdnsByLatency(true).catch(() => {})
        // 4K：卡頓多半是節點速度不夠，立刻實測各節點下載速度，確保切到真的夠快的節點
        if (currentStreamBitsPerSec / 1e6 >= 12 && lastSampleSegmentUrl) {
            lastBakeoffAt = 0
            runThroughputBakeoff(lastSampleSegmentUrl).catch(() => {})
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
        const bps = (totalBytes - lastTickBytes) / (TICK_MS / 1000)
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
            : Math.max(MIN_BPS_FLOOR, getRequiredStreamMbps(v.playbackRate) * 1e6 / 8)
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
                HttpDnsAutoPilot.noteStall()
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
            try { HttpDnsAutoPilot.noteBytes(bytes) } catch {}
            if (host) {
                lastSegmentCdn = host
                perCdnBytes[host] = (perCdnBytes[host] || 0) + bytes
            }
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
            lastTickBytes = 0; lastCurrentTime = 0; lastNudgeDetectAt = 0; lastSeekAt = 0; lastTickAt = 0
            reached = false; startedAt = Date.now()
            sessionSwitchCount = 0; sessionStallCount = 0; lastSegmentCdn = null
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
        console.log('頁面發現 CDN:', pageDiscoveredCdn ? pageDiscoveredCdn.split('.')[0] : '（無）')
        console.log('HTTPDNS:', getHttpDnsStatus())
        console.log('改寫統計:', { ...redirectStats })
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
        }
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
        return runThroughputBakeoff(lastSampleSegmentUrl).then(() => {
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
        try { GM_setValue(PROBE_CACHE_KEY, null) } catch {}
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
        if (!host) { GM_setValue('CustomCDN', null); log('已清除固定 CDN（重整生效）'); return }
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
        reset: () => Watchdog.reset(),
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
        try { GM_setValue(PROBE_CACHE_KEY, null) } catch {}
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
        try { GM_setValue(PROBE_CACHE_KEY, null) } catch {}
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
                crossTabPing()
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
    // 用同源 BroadcastChannel 做心跳 + 賽馬互斥：同一時間只讓一個分頁實測。
    const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36)
    const FOREIGN_BAKEOFF_QUIET = 8000
    const PEER_STALE_MS = 15000
    let crossTabChannel = null
    let foreignBakeoffAt = 0
    const peerTabs = new Map() // id -> { t, hidden }

    const crossTabPing = () => {
        if (!crossTabChannel) return
        try { crossTabChannel.postMessage({ type: 'hb', id: TAB_ID, hidden: tabReallyHidden }) } catch {}
    }
    const setupCrossTab = () => {
        if (crossTabChannel || typeof BroadcastChannel === 'undefined') return
        try { crossTabChannel = new BroadcastChannel('bilicdn_tw') } catch { return }
        crossTabChannel.onmessage = (ev) => {
            const d = ev && ev.data
            if (!d || d.id === TAB_ID) return
            if (d.type === 'hb')           peerTabs.set(d.id, { t: Date.now(), hidden: !!d.hidden })
            else if (d.type === 'bye')     peerTabs.delete(d.id)
            else if (d.type === 'bakeoff') foreignBakeoffAt = Date.now()
        }
        const beat = () => {
            crossTabPing()
            const now = Date.now()
            peerTabs.forEach((p, id) => { if (now - p.t > PEER_STALE_MS) peerTabs.delete(id) })
        }
        beat()
        setInterval(beat, 5000)
        unsafeWindow.addEventListener('pagehide', () => {
            try { crossTabChannel.postMessage({ type: 'bye', id: TAB_ID }) } catch {}
        })
        // 覆寫模組層賽馬鉤子
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

    // 以下 UI / Watchdog / Prewarm 只在影片頁啟動
    const isVideoPage =
        location.href.startsWith('https://www.bilibili.com/video/') ||
        location.href.startsWith('https://www.bilibili.com/bangumi/play/')
    if (!isVideoPage) return

    // Seek 預熱：僅 seeking（不在 waiting 做 DOM/拆連線，避免卡 seek 主路徑）
    let seekPrewarmStarted = false
    const setupSeekPrewarm = () => {
        if (seekPrewarmStarted) return
        seekPrewarmStarted = true
        let attached = null
        let lastSeekWarmAt = 0
        const SEEK_WARM_GAP_MS = 400
        const ATTACH_TIMEOUT_MS = 30000
        const attachStartedAt = Date.now()

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
                return
            }
            if (!v || v === attached) return
            attached = v
            try { v.preload = 'auto' } catch {}
            v.addEventListener('seeking', scheduleSeekWarmup)
            v.addEventListener('seeked', onSeeked)
            v.addEventListener('ratechange', () => {
                if (v.playbackRate > 1.5) warmupSeek()
            })
            clearInterval(attachTimer)
        }
        const attachTimer = setInterval(tryAttach, 800)
        tryAttach()
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
        lastBakeoffAt = 0           // 解除冷卻，新片可立即賽馬
        lastSampleSegmentUrl = null
        try { Watchdog.reset() } catch {}
        syncWorkerCdnTarget()
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
                runThroughputBakeoff(lastSampleSegmentUrl).catch(() => {})
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

    waitForElm(
        '#bilibili-player > div > div > div.bpx-player-primary-area > div.bpx-player-video-area > div.bpx-player-control-wrap > div.bpx-player-control-entity > div.bpx-player-control-bottom > div.bpx-player-control-bottom-right > div.bpx-player-ctrl-btn.bpx-player-ctrl-setting > div.bpx-player-ctrl-setting-box > div > div > div > div > div > div > div.bpx-player-ctrl-setting-others'
    , 30000).then(settingsBar => {

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
            updateStatusPanel()
        })

        // 狀態面板（白名單 + 緩衝進度 + 黑名單/死節點）
        const statusPanel = document.createElement('div')
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

            renderStatusHtml(html)
        }

        updateStatusPanel()
        const statusTimer = setInterval(() => {
            if (!document.contains(statusPanel)) {
                clearInterval(statusTimer)
                return
            }
            updateStatusPanel()
        }, 1000)

        settingsBar.appendChild(checkBoxWrapper)
        settingsBar.appendChild(statusPanel)
    }).catch(e => err('UI 注入失敗:', e))

})()
