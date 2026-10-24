// 測試：測速「完全沒有回應」的節點排到最後、連續兩次暫時隔離、成功一次就清零
// 用法：node tests/bakeoff-miss.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old（old = 對照舊版，需另外提供舊檔）]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const ALI = 'upos-sz-mirrorali.bilivideo.com'
const BOS = 'upos-sz-mirrorbos.bilivideo.com'
const SAMPLE = 'https://' + BOS + '/upgcxcode/11/22/333/333-1-100026.m4s?e=x&deadline=9999999999&upsig=abc'
const short = h => h.split('.')[0].replace('upos-sz-mirror', '').replace('upos-', '')

// 假網路：black 裡的 host 對「影片片段」（帶 Range 的請求）連 header 都不回；/crossdomain.xml 的可達性探測照常回應——
// 跟實機一致（ali 的 crossdomain 正常、只有 segment 間歇性黑洞）。若連探測都不回，ali 會在載入時就被判成死節點，
// 根本進不了賽馬候選，測不到這裡要測的東西。hang=true 時卡住直到被 abort（模擬實機的 3 秒逾時），否則立刻失敗。
let black = new Set([ALI]), hang = false
const order = []
const fakeFetch = (url, init) => {
    const host = new URL(url).hostname
    order.push(host)
    const isSegment = !!(init && init.headers && init.headers.Range)
    if (black.has(host) && isSegment) {
        if (!hang) return Promise.reject(new TypeError('Failed to fetch'))
        return new Promise((_, rej) => {
            const s = init && init.signal
            if (s) s.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
    }
    const chunk = new Uint8Array(64 * 1024); let sent = 0
    return Promise.resolve({ status: 206, ok: true, headers: { get: () => null },
        body: { getReader: () => ({ read: () => new Promise(r => setTimeout(() => (sent++ >= 8 ? r({ done: true }) : r({ done: false, value: chunk })), 1)) }) } })
}

;(async () => {
    const extra = mode === 'old' ? '' : `, miss: noteBakeoffMiss, clear: clearBakeoffMiss`
    const { T, logs } = load(file, mode, { fetchImpl: fakeFetch, exports: `globalThis.__T = { run: runThroughputBakeoff, setLastBakeoffAt,
        clearTimer: () => { clearTimeout(bakeoffTimer); bakeoffTimer = null }, setVerbose: b => { Config.verbose = b },
        stale: () => { for (const k in cdnHealth) if (cdnHealth[k].lastSeen) cdnHealth[k].lastSeen = Date.now() - 10 * 60 * 1000 },
        misses: h => (cdnHealth[h] && cdnHealth[h].bakeoffMisses) || 0, soft: isCdnSoftBlocked,
        unsoft: h => { delete cdnSoftBlockUntil[h] }, reset: () => { for (const k in cdnHealth) delete cdnHealth[k]; for (const k in cdnSoftBlockUntil) delete cdnSoftBlockUntil[k]; knownDeadHosts.clear(); lastChosenCdn = null },
        fresh: hs => hs.forEach(h => Object.assign(ensureCdnHealth(h), { samples: 3, ewmaMbps: 20, lastSeen: Date.now() })),
        list: () => [...PREFERRED_CDN_LIST],
        // 明確指定「正在播放的節點」= 樣本來源 bos；否則 getPlayingCdnHost 會退回 activeCdnList[0]，
        // 而測速成功的節點會被排到第一名、接著被當成「正在播放」排除在候選外
        play: h => { Watchdog.getLastSegmentCdn = () => h } ${extra} }` })
    await sleep(400); T.clearTimer(); T.setVerbose(true); T.play(BOS)
    // 一輪賽馬：樣本全部弄成不新鮮，讓每一輪都重新挑候選；回傳實際送出探測的順序（不含樣本本身的 host）
    const round = async () => { order.length = 0; T.stale(); T.setLastBakeoffAt(0); await T.run(SAMPLE, false); return order.filter(h => h !== BOS) }
    // 讓 ali 一定排進前 4 名：PREFERRED 裡排在 ali 前面的節點，先放 60 秒內的新鮮樣本（賽馬會跳過它們）
    const aliFirst = () => { const L = T.list(); T.fresh(L.slice(0, L.indexOf(ALI))) }
    const roundAli = async () => { order.length = 0; T.stale(); aliFirst(); T.setLastBakeoffAt(0); await T.run(SAMPLE, false); return order.filter(h => h !== BOS) }
    // 只剩 ali 需要量：其他節點全部有新鮮樣本（有無回應紀錄的節點，要等候選有空位才會被重測——這是設計中的行為）
    const roundOnlyAli = async () => { order.length = 0; T.stale(); T.fresh(T.list().filter(h => h !== ALI)); T.setLastBakeoffAt(0); await T.run(SAMPLE, false); return order.filter(h => h !== BOS) }

    T.reset()
    const o1 = await roundAli()
    if (mode === 'old') {
        const o2 = await roundAli()
        console.log('  第 1 輪：' + o1.map(short).join(' → ') + '\n  第 2 輪：' + o2.map(short).join(' → '))
        ok(o2.indexOf(ALI) === -1 || o2.indexOf(ALI) === o2.length - 1, '上一輪沒回應的 ali，下一輪不會排在其他候選前面')
        console.log(`\n${pass} passed, ${fail} failed`); process.exit(0)
    }

    // ── 排序（真的跑賽馬）──
    console.log('  第 1 輪：' + o1.map(short).join(' → '))
    ok(o1.includes(ALI), '前置：第 1 輪 ali 在候選裡（被實際探測）')
    ok(T.misses(ALI) === 1, '第 1 輪 ali 沒回應 → 記 1 次')
    ok(!T.soft(ALI), '只有 1 次不隔離')
    // 第 2 輪用同一組條件（ali 一樣排得進前 4 名），比的是「同樣的候選，ali 排在哪」
    const o2 = await roundAli()
    console.log('  第 2 輪：' + o2.map(short).join(' → '))
    ok(o2.indexOf(ALI) === -1 || o2.indexOf(ALI) === o2.length - 1, '第 2 輪 ali 排到最後（或被擠出前 4 名），不再拖慢排在它後面的節點')
    const L = T.list(), rest = o2.filter(h => h !== ALI).map(h => L.indexOf(h))
    ok(rest.every((v, i) => i === 0 || v > rest[i - 1]), '其餘候選維持白名單原本的相對順序')

    // ── 計數與隔離（直接驗證）──
    T.reset()
    T.miss(ALI)
    ok(T.misses(ALI) === 1 && !T.soft(ALI), 'noteBakeoffMiss 1 次：計數 1、不隔離')
    T.miss(ALI)
    ok(T.misses(ALI) === 2 && T.soft(ALI), '連續 2 次 → 暫時隔離')
    ok(logs.some(l => l.includes('連續 2 次測速沒有回應')), 'log 交代隔離原因')
    T.clear(ALI)
    ok(T.misses(ALI) === 0, '任何一次成功測速就清零')

    // ── 成功的探測會清零（真的跑賽馬）──
    T.reset(); T.miss(ALI); black = new Set()
    const oc = await roundOnlyAli()
    ok(oc.includes(ALI), '前置：候選有空位時，有無回應紀錄的 ali 仍會被重測')
    ok(T.misses(ALI) === 0, 'ali 恢復回應、測速成功 → 計數清零')

    // ── 實機情境：卡住直到 3 秒逾時（不是立刻失敗）也要算 ──
    T.reset(); black = new Set([ALI]); hang = true
    const t0 = Date.now()
    const o3 = await roundAli()
    console.log('  逾時那輪：' + o3.map(short).join(' → '))
    ok(o3.includes(ALI) && T.misses(ALI) === 1, '卡住到逾時（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）也記 1 次')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
