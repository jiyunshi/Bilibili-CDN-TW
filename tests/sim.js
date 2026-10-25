// 選路模擬器：直接呼叫腳本真正的 getBestCdn / recordCdnThroughput / recordCdnLatency，
// 節點參數取自 2026-10-25 公平實驗（未快取位置）的實測值。
// 用法：node tests/sim.js [要測的 .user.js，預設 repo 根目錄那份] [標籤]；HK=1 加入香港節點、ADVERSARIAL=1 跑反例
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), label = process.argv[3] || ''
// 受測版本的補發是否會把慢的證據記下來（照原始碼判斷，模擬器才能比較不同版本）
const SRC = require('fs').readFileSync(file, 'utf8')
const HEDGE_RECORDS_EVIDENCE = SRC.includes('recordCdnPenalty(host, false)')
const HEDGE_NEEDS_SLOW_RATE = SRC.includes("if (rateMbps >= getRequiredStreamMbps(undefined, 'steady')) return")
const HEDGE_BURST_LIMIT = SRC.includes('HEDGE_BURST_MAX')

const H = s => 'upos-sz-mirror' + s + '.bilivideo.com'
// mean/sd：Mbps；lat：首位元組 ms；hole：每個 segment 變成黑洞（幾乎收不到資料）的機率
const NODES = {
    [H('aliov')]: { mean: 33, sd: 8,  lat: 12 },
    [H('ali')]:   { mean: 35, sd: 15, lat: 80,  hole: 0.08 },
    [H('alib')]:  { mean: 20, sd: 8,  lat: 205 },
    [H('bos')]:   { mean: 26, sd: 5,  lat: 400 },
    [H('cos')]:   { mean: 10, sd: 6,  lat: 500 },
    ['upos-tf-all-tx.bilivideo.com']: { mean: 15, sd: 8, lat: 600 },
    [H('ali02')]: { mean: 8,  sd: 4,  lat: 900, hole: 0.3 },
}
// 香港 BCache（2026-10-25 公平實驗：未快取位置 hk03 59~100、hk05 50~244、hk01 40~46 Mbps）
if (process.env.HK) {
    NODES['cn-hk-eq-01-03.bilivideo.com'] = { mean: 70, sd: 20, lat: 90 }
    NODES['cn-hk-eq-01-05.bilivideo.com'] = { mean: 60, sd: 25, lat: 120 }
    NODES['cn-hk-eq-01-01.bilivideo.com'] = { mean: 43, sd: 8,  lat: 130 }
}
// 反例：延遲最低的 aliov 變成很慢的節點、延遲高的 bos 反而最快——驗證新公式不會因為加重延遲權重而死守慢節點
if (process.env.ADVERSARIAL) {
    NODES[H('aliov')] = { mean: 9,  sd: 3,  lat: 12 }
    NODES[H('bos')]   = { mean: 45, sd: 8,  lat: 400 }
}
const SCENARIOS = {
    '1080P(1.7Mbps)': 1.7e6,
    '1080P60(6Mbps)': 6e6,
    '4K(20Mbps)':     20e6,
}
const SEG_SEC = 4, SEGMENTS = 450, BUF_CAP = 30, SEEDS = 6

const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r())

const runOne = async (bps, seed) => {
    // 假時鐘：每播一個片段前進 SEG_SEC 秒。結果可重現（同版本跑兩次完全相同），而且吞吐量樣本的半衰期（8 分鐘）
    // 在 30 分鐘的模擬播放裡真的會作用——舊版用真實時間，模擬整段只跑幾秒，衰減幾乎不存在，連跑兩次結果還會不同。
    let clock = 1.75e12
    const { T } = load(file, 'new', { clock: () => clock, exports: `globalThis.__T = { best: getBestCdn, thr: recordCdnThroughput, lat: recordCdnLatency,
        setBitrate: setBufferTargetFromBitrate, soft: (h, ms) => softBlockCdn(h, 'slow-segment', ms),
        hasHedge: typeof Watchdog.hedgeTestOnce === 'function', penalty: h => recordCdnPenalty(h, false),
        req: () => getRequiredStreamMbps(undefined, 'steady'),
        miss: h => { if (typeof noteBakeoffMiss === 'function') noteBakeoffMiss(h) },
        lastSeen: h => (cdnHealth[h] && cdnHealth[h].lastSeen) || 0,
        reset: (hosts) => { for (const k in cdnHealth) delete cdnHealth[k]; lastChosenCdn = null; for (const k in cdnFailCount) delete cdnFailCount[k];
            for (const k in cdnSoftBlockUntil) delete cdnSoftBlockUntil[k]; knownDeadHosts.clear(); activeCdnList.length = 0; hosts.forEach(h => activeCdnList.push(h)) } }` })
    await sleep(300)
    const r = rng(seed)
    T.reset(Object.keys(NODES))
    T.setBitrate(bps, bps > 12e6)
    // 首輪延遲探測：每顆一筆 RTT（跟 reorderCdnsByLatency 起播那一輪一樣）
    for (const [h, n] of Object.entries(NODES)) T.lat(h, n.lat * (1 + 0.3 * r()))
    let buffer = 0, stall = 0, switches = 0, prev = null, ttfbSum = 0, hedges = 0, lastHedgeAt = -1e12
    const hedgeTimes = [], hedgeHostAt = new Map()
    const share = {}
    const segBytes = bps / 8 * SEG_SEC
    for (let i = 0; i < SEGMENTS; i++) {
        // 測速探測（runThroughputBakeoff）：開播第一段之後、之後每 90 秒（約 23 段）量一輪。
        // 照腳本：挑 4 台 60 秒內沒有新樣本的節點（最久沒量的優先），各量一次 384KB；
        // 掉包的節點在探測時撐滿 3 秒逾時、連 header 都沒有 → 只記「沒回應」、不產生樣本。不佔播放頻寬（簡化）。
        if (i === 1 || (i > 1 && i % 23 === 0)) {
            const cands = Object.keys(NODES).filter(h => clock - T.lastSeen(h) >= 60000)
                .sort((a, b) => T.lastSeen(a) - T.lastSeen(b)).slice(0, 4)
            for (const h of cands) {
                const n = NODES[h]
                if (n.hole && r() < n.hole) { T.miss(h); continue }
                const pm = Math.max(0.3, n.mean + n.sd * gauss(r))
                const bytes = 384 * 1024
                T.thr(h, bytes, bytes * 8 / (pm * 1e6) * 1000, 1)
                T.lat(h, n.lat * (1 + 0.3 * r()))
            }
        }
        const pick = T.best()
        if (prev && pick !== prev) switches++
        prev = pick
        share[pick] = (share[pick] || 0) + 1
        const n = NODES[pick]
        let mbps = Math.max(0.3, n.mean + n.sd * gauss(r))
        if (n.hole && r() < n.hole) mbps = 0.3
        const lat = n.lat * (1 + 0.3 * r())
        const dlMs = segBytes * 8 / (mbps * 1e6) * 1000
        let totalSec = (lat + dlMs) / 1000
        ttfbSum += lat
        // v1.4.0 起腳本有「慢片段補發」（Watchdog.maybeHedgeSlowSegment）：照腳本的規則模擬——
        // 下載滿 1.5 秒、緩衝低於 6 秒、照目前速度來不及下載完、還沒到 80% → 隔離該節點 60 秒，播放器重試到下一個最佳節點。
        // 最早可觸發的時間點是 max(1.5, 緩衝 − 6)；條件「剩餘時間 > 剩餘緩衝 × 0.8」只會隨時間變難，所以只需檢查這一點。
        let recorded = false
        // 頻率限制照受測腳本：新版是「同節點 8 秒＋全域 30 秒 3 次」，舊版是「全域 8 秒」
        while (hedgeTimes.length && clock - hedgeTimes[0] > 30000) hedgeTimes.shift()
        const hedgeAllowed = HEDGE_BURST_LIMIT
            ? (hedgeTimes.length < 3 && clock - (hedgeHostAt.get(pick) || -1e12) >= 8000)
            : (clock - lastHedgeAt >= 8000)
        if (T.hasHedge && hedgeAllowed) {
            const t0 = Math.max(1.5, buffer - 6)
            const frac = Math.max(0, t0 - lat / 1000) / (dlMs / 1000)
            // 片段本身要真的慢（目前速度低於串流需求）——照受測腳本：有這條判斷的版本才套用（HEDGE_NEEDS_SLOW_RATE）
            const slowEnough = !HEDGE_NEEDS_SLOW_RATE || (t0 * 1000 > lat ? mbps : 0) < T.req()
            if (t0 < totalSec && frac < 0.8 && (totalSec - t0) > (buffer - t0) * 0.8 && slowEnough) {
                lastHedgeAt = clock
                hedgeTimes.push(clock); hedgeHostAt.set(pick, clock)
                hedges++
                // 腳本會把這次已下載量 ÷ 已經過時間記成一筆樣本、並記一次失敗（見 maybeHedgeSlowSegment）
                const loadedBytes = Math.max(0, t0 - lat / 1000) * mbps * 1e6 / 8
                if (HEDGE_RECORDS_EVIDENCE) { if (loadedBytes > 0) T.thr(pick, loadedBytes, t0 * 1000, 1, true); T.penalty(pick) }
                T.soft(pick, 60 * 1000)
                const pick2 = T.best()
                const n2 = NODES[pick2]
                let mbps2 = Math.max(0.3, n2.mean + n2.sd * gauss(r))
                if (n2.hole && r() < n2.hole) mbps2 = 0.3
                const lat2 = n2.lat * (1 + 0.3 * r())
                const dl2 = segBytes * 8 / (mbps2 * 1e6) * 1000
                totalSec = t0 + (lat2 + dl2) / 1000
                if (pick2 !== pick) switches++
                prev = pick2
                T.thr(pick2, segBytes, dl2, 1)
                T.lat(pick2, lat2)
                recorded = true
            }
        }
        buffer -= totalSec
        if (buffer < 0) { stall += -buffer; buffer = 0 }
        buffer = Math.min(BUF_CAP, buffer + SEG_SEC)
        if (!recorded) { T.thr(pick, segBytes, dlMs, 1); T.lat(pick, lat) }
        clock += SEG_SEC * 1000
    }
    const top = Object.entries(share).sort((a, b) => b[1] - a[1]).map(([h, c]) => h.split('.')[0].replace('upos-sz-mirror', '').replace('upos-', '') + ' ' + Math.round(c / SEGMENTS * 100) + '%').slice(0, 3)
    return { stall, switches, hedges, ttfb: ttfbSum / SEGMENTS, top }
}

;(async () => {
    console.log('== ' + label + ' ==')
    for (const [name, bps] of Object.entries(SCENARIOS)) {
        let stall = 0, sw = 0, ttfb = 0, hd = 0; const tops = []
        for (let s = 1; s <= SEEDS; s++) {
            const o = await runOne(bps, s * 7919)
            stall += o.stall; sw += o.switches; ttfb += o.ttfb; hd += o.hedges; tops.push(o.top[0])
        }
        console.log(`${name.padEnd(16)} 卡頓 ${(stall / SEEDS).toFixed(1).padStart(5)}s  換節點 ${(sw / SEEDS).toFixed(1).padStart(5)}  補發 ${(hd / SEEDS).toFixed(1).padStart(4)}  平均首位元組 ${Math.round(ttfb / SEEDS).toString().padStart(4)}ms  主要節點 ${tops.join(' / ')}`)
    }
    process.exit(0)
})()
