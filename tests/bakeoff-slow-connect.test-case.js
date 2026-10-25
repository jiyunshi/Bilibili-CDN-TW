// 測試：已知「建立連線就超過測速逾時（3 秒）」的節點排到測速候選最後，不佔前 4 名的名額
// 背景（2026-10-25 實機）：ali02 冷連線約 9 秒才連上（連上後也只有 4～10 Mbps），排進前 4 名只會白等 3 秒。
// 用法：node tests/bakeoff-slow-connect.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old（old = 對照舊版，需另外提供舊檔）]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const ALI02 = 'upos-sz-mirrorali02.bilivideo.com'
const BOS = 'upos-sz-mirrorbos.bilivideo.com'
const SAMPLE = 'https://' + BOS + '/upgcxcode/11/22/333/333-1-100026.m4s?e=x&deadline=9999999999&upsig=abc'
const short = h => h.split('.')[0].replace('upos-sz-mirror', '').replace('upos-', '')

const order = []
const fakeFetch = (url) => {
    order.push(new URL(url).hostname)
    const chunk = new Uint8Array(64 * 1024); let sent = 0
    return Promise.resolve({ status: 206, ok: true, headers: { get: () => null },
        body: { getReader: () => ({ read: () => new Promise(r => setTimeout(() => (sent++ >= 8 ? r({ done: true }) : r({ done: false, value: chunk })), 1)) }) } })
}

;(async () => {
    const { T } = load(file, mode, { fetchImpl: fakeFetch, exports: `globalThis.__T = { run: runThroughputBakeoff, setLastBakeoffAt,
        clearTimer: () => { clearTimeout(bakeoffTimer); bakeoffTimer = null },
        reset: () => { for (const k in cdnHealth) delete cdnHealth[k]; for (const k in cdnSoftBlockUntil) delete cdnSoftBlockUntil[k]; knownDeadHosts.clear(); lastChosenCdn = null },
        fresh: hs => hs.forEach(h => Object.assign(ensureCdnHealth(h), { samples: 3, ewmaMbps: 20, lastSeen: Date.now() })),
        latency: (h, ms) => { Object.assign(ensureCdnHealth(h), { latencyMs: ms }) },
        list: () => [...PREFERRED_CDN_LIST],
        play: h => { Watchdog.getLastSegmentCdn = () => h } }` })
    await sleep(400); T.clearTimer(); T.play(BOS)
    const L = T.list()
    // 讓 ali02 一定排得進前 4 名：PREFERRED 裡排在 ali02 前面的節點，只留 2 台沒有新鮮樣本
    const ahead = L.slice(0, L.indexOf(ALI02)).filter(h => h !== BOS)
    const round = async (ali02LatencyMs) => {
        T.reset(); order.length = 0
        T.fresh(ahead.slice(0, -2))
        if (ali02LatencyMs) T.latency(ALI02, ali02LatencyMs)
        T.setLastBakeoffAt(0)
        await T.run(SAMPLE, false)
        return order.filter(h => h !== BOS)
    }

    const base = await round(0)
    console.log('  沒有延遲紀錄：' + base.map(short).join(' → '))
    ok(base.includes(ALI02) && base.indexOf(ALI02) < base.length - 1, '前置：沒有延遲紀錄時，ali02 照白名單順序排在中間（不是最後）')

    const slow = await round(8999)
    console.log('  ali02 冷連線 9 秒：' + slow.map(short).join(' → '))
    ok(slow.indexOf(ALI02) === -1 || slow.indexOf(ALI02) === slow.length - 1, '已知冷連線 9 秒 → 排到最後（或被擠出前 4 名）')
    const rest = slow.filter(h => h !== ALI02).map(h => L.indexOf(h))
    ok(rest.every((v, i) => i === 0 || v > rest[i - 1]), '其餘候選維持白名單原本的相對順序')

    const okLat = await round(600)
    ok(JSON.stringify(okLat) === JSON.stringify(base), '延遲 0.6 秒（在測速逾時內）不受影響，順序跟沒有紀錄時一樣')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
