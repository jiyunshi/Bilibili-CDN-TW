// 測試：評分公式的關鍵性質（兩段式 reward + 延遲懲罰）
// 用法：node tests/score.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old（old = 對照舊版，需另外提供舊檔）]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const H = s => 'upos-sz-mirror' + s + '.bilivideo.com'

;(async () => {
    const { T } = load(file, 'new', { exports: `globalThis.__T = { score: getCdnHealthScore, setBitrate: setBufferTargetFromBitrate, req: getRequiredStreamMbps,
        set: (cdn, o) => { const h = ensureCdnHealth(cdn); Object.assign(h, { ewmaMbps: 0, varMbps: 0, samples: 0, failures: 0, slowSamples: 0, latencyMs: 0, lastSeen: Date.now() }, o) },
        reset: () => { for (const k in cdnHealth) delete cdnHealth[k]; for (const k in cdnFailCount) delete cdnFailCount[k] } }` })
    await sleep(300)
    // 用 exploit 模式比較，排除探索加成，只看 reward 與懲罰
    const X = { exploit: true }
    const S = (cdn) => T.score(cdn, X)

    // 重現 2026-10-25 實機：1080P（需求約 1.8 Mbps），cos 3.5 Mbps 1 筆樣本 vs aliov 33 Mbps
    T.reset(); T.setBitrate(1.7e6, false)
    T.set(H('cos'),   { ewmaMbps: 3.5, samples: 1, latencyMs: 500 })
    T.set(H('aliov'), { ewmaMbps: 33,  samples: 6, latencyMs: 12, varMbps: 16 })
    T.set(H('bos'),   { ewmaMbps: 26,  samples: 6, latencyMs: 400, varMbps: 9 })
    console.log('  需求 ' + T.req(undefined, 'steady').toFixed(2) + ' Mbps；分數 aliov ' + S(H('aliov')).toFixed(3) + ' / bos ' + S(H('bos')).toFixed(3) + ' / cos ' + S(H('cos')).toFixed(3))
    ok(S(H('aliov')) > S(H('cos')) + 0.2, '1080P：33 Mbps 的 aliov 明顯高於 3.5 Mbps 的 cos（差距超過黏著邊界 0.20）')
    ok(S(H('aliov')) > S(H('bos')) + 0.2, '1080P：同樣夠快時，首位元組 12ms 的 aliov 明顯高於 400ms 的 bos（超過黏著邊界才換得過去）')

    // 4K：2 倍需求以內維持線性，排序與差距跟 v1.3.4 相同
    T.reset(); T.setBitrate(20e6, true)
    T.set(H('aliov'), { ewmaMbps: 33, samples: 6, latencyMs: 12 })
    T.set(H('cos'),   { ewmaMbps: 10, samples: 6, latencyMs: 12 })
    const req4k = T.req(undefined, 'steady')
    const expGap = Math.min(1, 33 / req4k / 2) - Math.min(1, 10 / req4k / 2)
    const gap = S(H('aliov')) - S(H('cos'))
    ok(Math.abs(gap - expGap) < 1e-9, '4K：2 倍以內的分差 = 舊版線性公式的分差（' + gap.toFixed(3) + '）')

    // 連續性與單調性：從 0.5 倍到 20 倍需求，分數只增不減，2 倍處沒有跳階
    T.reset(); T.setBitrate(1.7e6, false)
    const req = T.req(undefined, 'steady')
    let prev = -Infinity, mono = true, jump = 0
    for (let r = 0.5; r <= 20; r += 0.05) {
        T.set(H('ali'), { ewmaMbps: req * r, samples: 6 })
        const s = S(H('ali'))
        if (s < prev - 1e-12) mono = false
        if (Math.abs(r - 2) < 0.03) jump = s - prev
        prev = s
    }
    ok(mono, '分數隨速度單調遞增（0.5～20 倍需求）')
    ok(jump < 0.05, '2 倍需求處沒有跳階（相鄰步差 ' + jump.toFixed(4) + '）')
    T.set(H('ali'), { ewmaMbps: req * 10, samples: 6 }); const s10 = S(H('ali'))
    T.set(H('ali'), { ewmaMbps: req * 40, samples: 6 }); const s40 = S(H('ali'))
    ok(Math.abs(s10 - s40) < 1e-9, '10 倍以上不再加分（飽和）')
    T.set(H('ali'), { ewmaMbps: req * 2, samples: 6 }); const s2 = S(H('ali'))
    ok(Math.abs((s10 - s2) - 0.3) < 1e-9, '2 倍到 10 倍之間的餘裕加分總共 0.3')

    // 延遲懲罰有上限：冷 TLS 的 8.8 秒樣本不會無限扣分
    T.set(H('ali'), { ewmaMbps: req * 10, samples: 6, latencyMs: 400 });  const l400 = S(H('ali'))
    T.set(H('ali'), { ewmaMbps: req * 10, samples: 6, latencyMs: 8800 }); const l8800 = S(H('ali'))
    ok(Math.abs(l400 - l8800) < 1e-9, '延遲 400ms 以上懲罰封頂（冷 TLS 8.8 秒不會再多扣）')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
