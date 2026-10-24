// 測試：Akamai 冷門片提早切走
// 用法：node tests/akamai-escape.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old（old = 對照舊版，需另外提供舊檔）]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const AKAM = 'upos-hz-mirrorakam.akamaized.net', ALIOV = 'upos-sz-mirroraliov.bilivideo.com'
const AKAM_URL = 'https://' + AKAM + '/upgcxcode/11/22/333/333-1-100026.m4s?e=x&deadline=9999999999&upsig=abc&hdnts=y'
const KB = 1024

;(async () => {
    const { T, logs } = load(file, 'new', { exports: `globalThis.__T = { thr: recordCdnThroughput, setBitrate: setBufferTargetFromBitrate,
        req: () => getRequiredStreamMbps(undefined, 'steady'), forced: isForcedRedirect, normalize: normalizeMediaUrl, best: () => getCurrentCdn(),
        setVerbose: b => { Config.verbose = b },
        reset: () => { for (const k in cdnHealth) delete cdnHealth[k]; forcedRedirectHosts.clear(); lastChosenCdn = null;
            if (typeof akamaiSlowStrikes !== 'undefined') akamaiSlowStrikes.clear() },
        spaReset: () => resetStreamProfile(),
        seed: (strong) => { PREFERRED_CDN_LIST.forEach(h => Object.assign(ensureCdnHealth(h), { ewmaMbps: 4, samples: 10, latencyMs: 300, lastSeen: Date.now(), successes: 10 }));
            Object.assign(ensureCdnHealth('${ALIOV}'), { ewmaMbps: strong, samples: 10, latencyMs: 12, lastSeen: Date.now(), successes: 10 }) } }` })
    await sleep(300)
    T.setVerbose(true)
    // 1080P+：約 3 Mbps → 需求約 3.35 Mbps
    const setup = (strong = 30) => { T.reset(); T.setBitrate(3e6 + 192000, false); T.seed(strong) }
    // mbps → 給 recordCdnThroughput 的 (bytes, durationMs)
    const seg = (mbps, bytes = 512 * KB) => T.thr(AKAM, bytes, bytes * 8 / (mbps * 1000), 1)

    if (mode === 'old') {
        setup(); seg(1.2); seg(1.0)
        ok(T.forced(AKAM), '連續 2 個慢 Akamai segment 後會切走')
        console.log(`\n${pass} passed, ${fail} failed`); process.exit(0)
    }

    setup()
    console.log('  需求 ' + T.req().toFixed(2) + ' Mbps；目前最佳 ' + T.best().split('.')[0])
    seg(1.2)
    ok(!T.forced(AKAM), '1 個慢 segment 不切（避免一次抖動就觸發）')
    seg(1.0)
    ok(T.forced(AKAM), '連續 2 個低於需求 → 切走')
    const n = T.normalize(AKAM_URL)
    ok(n.changed && n.url.includes(ALIOV) && n.url.includes('hdnts='), '之後的 Akamai segment 改寫到 aliov（保留原本的路徑與參數）')
    ok(logs.some(l => l.includes('[Akamai] 冷門片') && l.includes('aliov')), 'log 說明切走原因與目標')

    setup(); seg(1.2); seg(40); seg(1.0)
    ok(!T.forced(AKAM), '慢、快、慢 → 不切（中間有一個跟得上就重新計算）')

    setup(); seg(1.0, 100 * KB); seg(1.0, 100 * KB); seg(1.0, 200 * KB)
    ok(!T.forced(AKAM), '太小的 segment（< 256KB）不算數')

    setup(); seg(8); seg(9); seg(7)
    ok(!T.forced(AKAM), 'Akamai 跟得上需求 → 不動')

    setup(4); seg(1.2); seg(1.0)
    ok(!T.forced(AKAM), '其他節點也沒有證據跟得上（< 需求 1.5 倍）→ 維持 Akamai（使用者網路整體變慢時換也沒用）')
    ok(logs.some(l => l.includes('沒有證據顯示其他節點跟得上')), '不切的時候也有 log 交代原因')

    setup(); seg(1.2); T.spaReset(); T.setBitrate(3e6 + 192000, false); seg(1.0)
    ok(!T.forced(AKAM), '換片會清空計數（上一支片的慢 segment 不算到新片頭上）')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
