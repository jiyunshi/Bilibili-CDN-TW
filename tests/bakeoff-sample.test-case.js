// 測試：賽馬樣本來源（Akamai 主線路時從 backup 取）＋ Akamai 為現用節點時不中途切走
// 用法：node tests/bakeoff-sample.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old（old = 對照舊版，需另外提供舊檔）]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'

const SIG = '/upgcxcode/11/22/333/333-1-100026.m4s?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M%3D&deadline=9999999999&os=bosbv&og=hw&upsig=abc'
const akamUrl = 'https://upos-hz-mirrorakam.akamaized.net' + SIG.replace('os=bosbv', 'os=akam') + '&hdnts=x'
const cosovUrl = 'https://upos-sz-mirrorcosov.bilivideo.com' + SIG
const pcdnUrl = 'https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/v1/resource/333-1-100026.m4s?x=1'

// 台灣常見的 1080P+ playurl：Akamai 主線路 + cosov 備援（2026-10-25 實機所見的組合）
const playurl = () => ({ code: 0, data: { dash: {
    video: [
        { id: 112, height: 1080, bandwidth: 3e6, codecs: 'avc1.640032', codecid: 7, base_url: akamUrl, baseUrl: akamUrl, backup_url: [cosovUrl], backupUrl: [cosovUrl] },
        { id: 64,  height: 720,  bandwidth: 1.2e6, codecs: 'avc1.640028', codecid: 7, base_url: akamUrl, baseUrl: akamUrl, backup_url: [cosovUrl], backupUrl: [cosovUrl] },
    ],
    audio: [{ id: 30280, bandwidth: 192000, base_url: akamUrl, baseUrl: akamUrl, backup_url: [cosovUrl], backupUrl: [cosovUrl] }],
} } })

// 假 CDN：任何 bilivideo host 都回 206 + 足夠的位元組，讓賽馬每顆候選都量得到
const fakeFetch = (url) => {
    const host = new URL(url).hostname
    const chunk = new Uint8Array(64 * 1024)
    let sent = 0
    return Promise.resolve({ status: 206, ok: true, url, host,
        body: { getReader: () => ({ read: () => new Promise(r => setTimeout(() => {
            if (sent >= 8) return r({ done: true })
            sent++; r({ done: false, value: chunk })
        }, 1)) }) } })
}

const commonExports = `transform: playInfoTransformer, sample: () => lastSampleSegmentUrl,
    clearTimer: () => { clearTimeout(bakeoffTimer); bakeoffTimer = null }, setVerbose: b => { Config.verbose = b }`

;(async () => {
    if (mode === 'old') {
        const { T } = load(file, 'old', { exports: `globalThis.__T = { ${commonExports} }` })
        await sleep(400); T.clearTimer()
        T.transform(playurl()); T.clearTimer()
        const s = T.sample()
        ok(!!s && /bilivideo\.com/.test(new URL(s).hostname), 'Akamai 主線路的 1080P+ 也拿得到 bilivideo 樣本')
        console.log(`\n${pass} passed, ${fail} failed`); process.exit(0)
    }

    const { T, logs } = load(file, 'new', { fetchImpl: fakeFetch, exports: `globalThis.__T = { ${commonExports},
        pick: pickBakeoffSampleUrl, run: runThroughputBakeoff, setLastBakeoffAt,
        setPlaying: h => { Watchdog.getLastSegmentCdn = () => h },
        health: h => ensureCdnHealth(h), isForced: isForcedRedirect, clearForced: () => forcedRedirectHosts.clear(),
        noteLocked: noteHostLockedStream, clearLocked: () => hostLockedStreams.clear(),
        reset: () => { for (const k in cdnHealth) delete cdnHealth[k] } }` })
    await sleep(400); T.clearTimer()

    // ── 樣本挑選（純函式）──
    ok(T.pick(null) === null && T.pick([]) === null, '空清單回 null')
    const pAkamOnly = T.pick([{ base_url: akamUrl, backup_url: [] }])
    ok(pAkamOnly === null, '只有 Akamai、沒有 bilivideo 時不取樣')
    const pBackup = T.pick([{ base_url: akamUrl, backup_url: [cosovUrl] }])
    ok(pBackup === cosovUrl, 'Akamai 主線路時改用 backup 的 bilivideo 網址')
    const pPrimary = T.pick([{ base_url: cosovUrl.replace('cosov', 'bos'), backup_url: [cosovUrl] }])
    ok(pPrimary && pPrimary.includes('mirrorbos'), '主線路本身是 bilivideo 時優先用主線路（行為同舊版）')
    ok(T.pick([{ base_url: akamUrl, backup_url: [pcdnUrl] }]) === null, 'PCDN 特化網址不當樣本')
    T.noteLocked(cosovUrl)
    ok(T.pick([{ base_url: akamUrl, backup_url: [cosovUrl] }]) === null, '已知綁定節點的串流不當樣本')
    T.clearLocked()
    ok(T.pick([{ base_url: akamUrl, backup_url: [] }, { base_url: akamUrl, backup_url: [cosovUrl] }]) === cosovUrl,
        '第一個 item 沒有可用網址時往下一個找')

    // ── 整合：真的走 playInfoTransformer ──
    const info = playurl()
    T.transform(info); T.clearTimer()
    const s = T.sample()
    ok(!!s && /\.bilivideo\.com$/.test(new URL(s).hostname), 'playInfoTransformer 之後有 bilivideo 樣本（舊版為 null）')
    ok(info.data.dash.video[0].base_url.includes('akamaized.net'), '一般碼率仍保留 Akamai 為主線路（播放行為不變）')

    // ── 賽馬：現用節點是 Akamai 時不中途切走 ──
    const akamHost = 'upos-hz-mirrorakam.akamaized.net'
    T.reset(); T.clearForced()
    const ha = T.health(akamHost); ha.samples = 5; ha.ewmaMbps = 0.5; ha.lastSeen = Date.now() - 120000   // 很慢、樣本不新鮮
    T.setPlaying(akamHost); T.setLastBakeoffAt(0)
    await T.run(s, false)
    const probed = logs.length
    ok(!T.isForced(akamHost), 'Akamai 為現用節點：賽馬只重排，不強制把 Akamai 改寫走')

    // 對照組：同樣條件但現用節點是 bilivideo → 應該要中途切換，證明上面那項不是因為賽馬根本沒跑
    const slowHost = 'upos-sz-mirrorcosov.bilivideo.com'
    T.reset(); T.clearForced()
    const hs = T.health(slowHost); hs.samples = 5; hs.ewmaMbps = 0.5; hs.lastSeen = Date.now() - 120000
    T.setPlaying(slowHost); T.setLastBakeoffAt(0)
    T.setVerbose(true)
    await T.run(s, false)
    ok(T.isForced(slowHost), '對照組：現用節點是慢的 bilivideo 時仍會中途切換（既有行為不變）')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
