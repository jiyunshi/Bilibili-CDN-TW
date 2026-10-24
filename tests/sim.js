// 選路模擬器：直接呼叫腳本真正的 getBestCdn / recordCdnThroughput / recordCdnLatency，
// 節點參數取自 2026-10-25 公平實驗（未快取位置）的實測值。
// 用法：node tests/sim.js [要測的 .user.js，預設 repo 根目錄那份] [標籤]；HK=1 加入香港節點、ADVERSARIAL=1 跑反例
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), label = process.argv[3] || ''

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
    const { T } = load(file, 'new', { exports: `globalThis.__T = { best: getBestCdn, thr: recordCdnThroughput, lat: recordCdnLatency,
        setBitrate: setBufferTargetFromBitrate,
        reset: (hosts) => { for (const k in cdnHealth) delete cdnHealth[k]; lastChosenCdn = null; for (const k in cdnFailCount) delete cdnFailCount[k];
            for (const k in cdnSoftBlockUntil) delete cdnSoftBlockUntil[k]; knownDeadHosts.clear(); activeCdnList.length = 0; hosts.forEach(h => activeCdnList.push(h)) } }` })
    await sleep(300)
    const r = rng(seed)
    T.reset(Object.keys(NODES))
    T.setBitrate(bps, bps > 12e6)
    // 首輪延遲探測：每顆一筆 RTT（跟 reorderCdnsByLatency 起播那一輪一樣）
    for (const [h, n] of Object.entries(NODES)) T.lat(h, n.lat * (1 + 0.3 * r()))
    let buffer = 0, stall = 0, switches = 0, prev = null, ttfbSum = 0
    const share = {}
    const segBytes = bps / 8 * SEG_SEC
    for (let i = 0; i < SEGMENTS; i++) {
        const pick = T.best()
        if (prev && pick !== prev) switches++
        prev = pick
        share[pick] = (share[pick] || 0) + 1
        const n = NODES[pick]
        let mbps = Math.max(0.3, n.mean + n.sd * gauss(r))
        if (n.hole && r() < n.hole) mbps = 0.3
        const lat = n.lat * (1 + 0.3 * r())
        const dlMs = segBytes * 8 / (mbps * 1e6) * 1000
        const totalSec = (lat + dlMs) / 1000
        ttfbSum += lat
        buffer -= totalSec
        if (buffer < 0) { stall += -buffer; buffer = 0 }
        buffer = Math.min(BUF_CAP, buffer + SEG_SEC)
        T.thr(pick, segBytes, dlMs, 1)
        T.lat(pick, lat)
    }
    const top = Object.entries(share).sort((a, b) => b[1] - a[1]).map(([h, c]) => h.split('.')[0].replace('upos-sz-mirror', '').replace('upos-', '') + ' ' + Math.round(c / SEGMENTS * 100) + '%').slice(0, 3)
    return { stall, switches, ttfb: ttfbSum / SEGMENTS, top }
}

;(async () => {
    console.log('== ' + label + ' ==')
    for (const [name, bps] of Object.entries(SCENARIOS)) {
        let stall = 0, sw = 0, ttfb = 0; const tops = []
        for (let s = 1; s <= SEEDS; s++) {
            const o = await runOne(bps, s * 7919)
            stall += o.stall; sw += o.switches; ttfb += o.ttfb; tops.push(o.top[0])
        }
        console.log(`${name.padEnd(16)} 卡頓 ${(stall / SEEDS).toFixed(1).padStart(5)}s  換節點 ${(sw / SEEDS).toFixed(1).padStart(5)}  平均首位元組 ${Math.round(ttfb / SEEDS).toString().padStart(4)}ms  主要節點 ${tops.join(' / ')}`)
    }
    process.exit(0)
})()
