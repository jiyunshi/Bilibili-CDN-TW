// 測試：一般碼率在「白名單有實測證據」時改以白名單為主線路、Akamai 降為第一順位 backup
// 用法：node tests/whitelist-primary.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old（old = 對照舊版，需另外提供舊檔）]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'

const SIG = '/upgcxcode/11/22/333/333-1-100026.m4s?e=x&deadline=9999999999&os=cosovbv&upsig=abc'
const akamUrl  = 'https://upos-hz-mirrorakam.akamaized.net' + SIG + '&hdnts=x'
const cosovUrl = 'https://upos-sz-mirrorcosov.bilivideo.com' + SIG
const HK3 = 'cn-hk-eq-01-03.bilivideo.com'
// 1080P+：約 3 Mbps（低於 4K 門檻，舊版一律 Akamai 為主）
const item = () => ({ id: 112, height: 1080, bandwidth: 3e6, codecs: 'avc1.640032', codecid: 7,
    base_url: akamUrl, baseUrl: akamUrl, backup_url: [cosovUrl], backupUrl: [cosovUrl] })
const isAkam = u => /akamaized\.net/.test(u)

;(async () => {
    const { T } = load(file, mode, { exports: `globalThis.__T = { transform: transformStreamItem,
        reset: () => { for (const k in cdnHealth) delete cdnHealth[k]; lastChosenCdn = null; hostLockedStreams.clear() },
        seed: (mbps, ageMs = 0) => PREFERRED_CDN_LIST.forEach(h => Object.assign(ensureCdnHealth(h), {
            ewmaMbps: h === '${HK3}' ? mbps : 1, samples: 8, latencyMs: h === '${HK3}' ? 90 : 400, lastSeen: Date.now() - ageMs, successes: 8 })),
        lock: u => noteHostLockedStream(u),
        samples: n => PREFERRED_CDN_LIST.forEach(h => { if (cdnHealth[h]) cdnHealth[h].samples = n }) }` })
    await sleep(300)
    const run = () => { const it = item(); T.transform(it, true); return it }

    if (mode === 'old') {
        T.reset(); T.seed(60)
        const it = run()
        ok(!isAkam(it.base_url), '白名單有證據（60 Mbps ≥ 3 Mbps × 3）時，一般碼率改以白名單為主')
        console.log(`\n${pass} passed, ${fail} failed`); process.exit(0)
    }

    T.reset(); T.seed(60)
    let it = run()
    ok(it.base_url.includes(HK3) && it.baseUrl === it.base_url, '有實測證據（60 Mbps ≥ 碼率 3 倍）→ 主線路改為最佳白名單節點（香港）')
    ok(isAkam(it.backup_url[0]) && it.backup_url[0] === akamUrl, 'Akamai 降為第一順位 backup（原網址不變，含 hdnts）')

    T.reset()
    it = run()
    ok(isAkam(it.base_url), '沒有任何測速資料（第一次安裝）→ 維持 Akamai 為主（行為同舊版）')

    T.reset(); T.seed(7)
    it = run()
    ok(isAkam(it.base_url), '證據不足（7 Mbps < 碼率 3 倍 9 Mbps）→ 維持 Akamai')

    T.reset(); T.seed(60, 40 * 60 * 1000)
    it = run()
    ok(!isAkam(it.base_url), '40 分鐘前的樣本仍算數（證據半衰期 24 小時；v1.3.5 用 8 分鐘，隔一陣子再開片就衰減光）')

    T.reset(); T.seed(60, 20 * 60 * 60 * 1000)
    it = run()
    ok(!isAkam(it.base_url), '20 小時前的樣本（每天第一支片的典型情況，衰減後約 34 Mbps）→ 仍以白名單為主')

    T.reset(); T.seed(60, 3 * 24 * 60 * 60 * 1000)
    it = run()
    ok(isAkam(it.base_url), '3 天前的樣本（半衰 3 次 → 7.5 Mbps，不到 3 倍）→ 維持 Akamai')

    T.reset(); T.seed(60); T.samples(1)
    it = run()
    ok(isAkam(it.base_url), '只有 1 筆樣本 → 證據不足，維持 Akamai')

    T.reset(); T.seed(60); T.lock(cosovUrl)
    it = run()
    ok(isAkam(it.base_url), '已知綁定節點的串流（換 host 必 403）→ 維持 Akamai')

    T.reset(); T.seed(60)
    const k4 = { ...item(), height: 2160, bandwidth: 16e6 }
    T.transform(k4, true)
    ok(!isAkam(k4.base_url) && isAkam(k4.backup_url[0]), '4K 照舊以白名單為主、Akamai 為第一順位 backup')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
