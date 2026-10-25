// 測試：播放時的被動樣本累積到 1MB 才算一筆（v1.4.0），小片段的噴發速率被平均掉
// 用法：node tests/passive-throughput.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const HK = 'cn-hk-eq-01-03.bilivideo.com', AKAM = 'upos-hz-mirrorakam.akamaized.net'
const KB = 1024
// 2026-10-25 實機：同一台香港節點連續 7 個 ≥128KB 片段 [KB, 扣掉 TTFB 的傳輸毫秒]（26～119 Mbps）。重複兩輪模擬連續播放。
const real7 = [[290, 90], [395, 40], [832, 70], [419, 33], [248, 28], [247, 17], [581, 63]]
const real = real7.concat(real7)
const cv = h => Math.sqrt(h.varMbps || 0) / Math.max(1e-6, h.ewmaMbps)

;(async () => {
    const { T } = load(file, mode, { exports: `globalThis.__T = { thr: recordCdnThroughput, health: cdnHealth, setBitrate: setBufferTargetFromBitrate,
        passive: typeof notePassiveThroughput === 'function' ? notePassiveThroughput : null, forced: isForcedRedirect,
        fresh: (h, mbps) => Object.assign(ensureCdnHealth(h), { ewmaMbps: mbps, samples: 6, lastSeen: Date.now(), successes: 6 }),
        setBest: h => { activeCdnList.length = 0; activeCdnList.push(h) } }` })
    await sleep(300)
    T.setBitrate(1.9e6, false)
    const totalKB = real.reduce((a, [kb]) => a + kb, 0)
    if (!T.passive) { ok(false, '被動樣本合併（v1.3.7 沒有這個機制，每段直接算一筆）'); console.log(`
${pass} passed, ${fail} failed`); process.exit(1) }
    // 同一組真實數據、同一個版本：一台節點「每段一筆」、另一台「合併到 1MB」
    const PER = 'cn-hk-eq-01-05.bilivideo.com'
    real.forEach(([kb, ms]) => { T.thr(PER, kb * KB, ms, 1); T.passive(HK, kb * KB, ms, 1) })
    const per = T.health[PER], agg = T.health[HK]
    console.log('  每段一筆：' + per.samples + ' 筆、變異係數 ' + cv(per).toFixed(2) + '；合併：' + agg.samples + ' 筆、變異係數 ' + cv(agg).toFixed(2) + '（共 ' + totalKB + 'KB）')
    ok(agg.samples >= 3 && agg.samples <= Math.floor(totalKB / 1024), '累積滿 1MB 才算一筆（' + totalKB + 'KB → ' + agg.samples + ' 筆）')
    ok(cv(agg) < cv(per), '合併後變異係數比每段一筆低（噴發速率被平均掉）')
    ok(agg.bytes >= totalKB * KB * 0.99, '還沒湊滿的位元組照樣計入累計下載量')

    // Akamai 提早切走仍逐片段判斷：兩個 512KB 慢片段（0.8 Mbps）就觸發，不必等湊滿 1MB 樣本
    if (T.passive) {
        T.fresh('upos-sz-mirroraliov.bilivideo.com', 30); T.setBest('upos-sz-mirroraliov.bilivideo.com')
        T.passive(AKAM, 512 * KB, 512 * KB * 8 / 800, 1); T.passive(AKAM, 512 * KB, 512 * KB * 8 / 800, 1)
        ok(T.forced(AKAM), 'Akamai 冷門片提早切走仍逐片段判斷（兩個慢片段就觸發）')
    }
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
