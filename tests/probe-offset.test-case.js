// 測試：賽馬探測改量隨機、未快取的位置（不再固定 bytes=0-）
// 用法：node tests/probe-offset.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old（old = 對照舊版，需另外提供舊檔）]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const MB = 1048576

const SIG = '/upgcxcode/11/22/333/333-1-100026.m4s?e=x&deadline=9999999999&os=bosbv&upsig=abc'
const akamUrl = 'https://upos-hz-mirrorakam.akamaized.net' + SIG + '&hdnts=x'
const cosovUrl = 'https://upos-sz-mirrorcosov.bilivideo.com' + SIG
// 1080P+ 約 3 Mbps、長度 20 分鐘 → 約 450MB；估計值取一半 = 225MB
const playurl = () => ({ code: 0, data: { timelength: 1200000, dash: { duration: 1200,
    video: [{ id: 112, height: 1080, bandwidth: 3e6, codecs: 'avc1.640032', codecid: 7, base_url: akamUrl, baseUrl: akamUrl, backup_url: [cosovUrl], backupUrl: [cosovUrl] }],
    audio: [{ id: 30280, bandwidth: 192000, base_url: akamUrl, baseUrl: akamUrl, backup_url: [cosovUrl], backupUrl: [cosovUrl] }],
} } })

// 假 CDN：記下每個請求的 Range，回 206 + Content-Range（真實大小 300MB）
const TOTAL = 300 * MB
const seen = []
const fakeFetch = (url, init) => {
    const range = (init && init.headers && init.headers.Range) || ''
    seen.push({ host: new URL(url).hostname, range })
    const m = /bytes=(\d+)-(\d+)/.exec(range)
    const a = m ? +m[1] : 0, b = m ? +m[2] : 0
    const chunk = new Uint8Array(64 * 1024); let sent = 0
    return Promise.resolve({ status: 206, ok: true,
        headers: { get: n => n.toLowerCase() === 'content-range' ? `bytes ${a}-${b}/${TOTAL}` : null },
        body: { getReader: () => ({ read: () => new Promise(r => setTimeout(() => (sent++ >= 8 ? r({ done: true }) : r({ done: false, value: chunk })), 1)) }) } })
}
const starts = () => seen.filter(x => /bilivideo/.test(x.host) && x.range).map(x => +/bytes=(\d+)/.exec(x.range)[1])

;(async () => {
    const exportsCommon = `transform: playInfoTransformer, sample: () => lastSampleSegmentUrl, run: runThroughputBakeoff, setLastBakeoffAt,
        clearTimer: () => { clearTimeout(bakeoffTimer); bakeoffTimer = null }, resetHealth: () => { for (const k in cdnHealth) delete cdnHealth[k] }`
    if (mode === 'old') {
        const { T } = load(file, 'old', { fetchImpl: fakeFetch, exports: `globalThis.__T = { ${exportsCommon} }` })
        await sleep(400); T.clearTimer()
        T.transform(playurl()); T.clearTimer(); T.resetHealth()
        seen.length = 0; T.setLastBakeoffAt(0)
        await T.run(cosovUrl, false)
        const s = starts()
        ok(s.length > 0 && s.every(x => x >= MB), '賽馬探測不會固定量檔案開頭（' + s.length + ' 次，起點 ' + s.map(x => (x / MB).toFixed(1) + 'MB').join(',') + '）')
        console.log(`\n${pass} passed, ${fail} failed`); process.exit(0)
    }

    const { T } = load(file, 'new', { fetchImpl: fakeFetch, exports: `globalThis.__T = { ${exportsCommon},
        pick: pickProbeOffset, est: noteStreamSizeEstimate, learn: learnStreamSizeFromContentRange,
        hint: u => streamSizeHint.get(streamPathKey(u)), hintCount: () => streamSizeHint.size, clearHints: () => streamSizeHint.clear() }` })
    await sleep(400); T.clearTimer()

    // ── 純函式 ──
    const U = cosovUrl
    T.clearHints()
    ok(T.pick(U, 384 * 1024) === 0, '不知道檔案大小 → 退回量開頭（不冒 416 的險）')
    T.est(U, 2 * MB)
    ok(T.hint(U).bytes === MB && T.pick(U, 384 * 1024) === 0, '檔案太小（估計值的一半放不下跳過的開頭 + 探測）→ 量開頭')
    T.clearHints(); T.est(U, 450 * MB)
    ok(T.hint(U).bytes === 225 * MB && !T.hint(U).exact, '估計值只取一半當上限')
    const picks = Array.from({ length: 200 }, () => T.pick(U, 768 * 1024))
    ok(picks.every(p => p >= MB && p + 768 * 1024 <= 225 * MB), '200 次抽樣全部落在 [1MB, 上限 - 探測量] 之間')
    ok(picks.every(p => p % (64 * 1024) === 0), '起點對齊 64KB')
    ok(new Set(picks).size > 150, '位置分散（200 次裡有 ' + new Set(picks).size + ' 種）')
    T.learn(U, 'bytes 1048576-1441791/314572800')
    ok(T.hint(U).bytes === 314572800 && T.hint(U).exact, '從 206 的 Content-Range 學到真實大小')
    T.est(U, 10 * MB)
    ok(T.hint(U).bytes === 314572800, '之後的估計值不會蓋掉實測值')
    T.clearHints(); T.learn(U, 'bytes */5000000')
    ok(T.hint(U).bytes === 5000000, '416 的 `bytes */總長` 也學得到')
    T.clearHints()
    for (let i = 0; i < 40; i++) T.est(U.replace('333-1', 'v' + i), 100 * MB)
    ok(T.hintCount() === 32, '提示最多保留 32 條（不會無限增長）')

    // ── 整合：playurl → 賽馬 → 實際送出的 Range ──
    T.clearHints()
    T.transform(playurl()); T.clearTimer(); T.resetHealth()
    ok(T.hint(T.sample()) && T.hint(T.sample()).bytes === Math.floor(3e6 / 8 * 1200 * 0.5), 'playurl 改寫時依「碼率 × 長度」記下估計值')
    seen.length = 0; T.setLastBakeoffAt(0)
    await T.run(T.sample(), false)
    const s = starts()
    ok(s.length >= 2, '賽馬實際對多個候選送出探測（' + s.length + ' 次）')
    ok(s.every(x => x >= MB), '每一次探測都不是從開頭量（起點 ' + s.map(x => (x / MB).toFixed(1) + 'MB').join(',') + '）')
    ok(new Set(s).size === s.length, '同一輪各候選的位置互不相同')
    ok(T.hint(T.sample()).exact && T.hint(T.sample()).bytes === TOTAL, '第一顆探測回來後就改用實測大小')
    ok(s.every(x => x + 768 * 1024 <= TOTAL), '沒有任何探測超出檔尾（不會 416）')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
