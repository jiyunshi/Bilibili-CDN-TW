// 測試：香港節點最快時 backup 也要分散到不同機房；香港機房整個出事時，主線路、backup、已發出的請求都改走別處（沒有寫死香港）
// 用法：node tests/backup-diversity.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const HK = ['cn-hk-eq-01-05.bilivideo.com', 'cn-hk-eq-01-03.bilivideo.com', 'cn-hk-eq-01-01.bilivideo.com']
const ALIOV = 'upos-sz-mirroraliov.bilivideo.com', BOS = 'upos-sz-mirrorbos.bilivideo.com', COS = 'upos-sz-mirrorcos.bilivideo.com'
const SIG = '/upgcxcode/1/2/3/3-1-100026.m4s?e=x&deadline=9999999999&upsig=abc'
const host = u => new URL(u).hostname
const isHK = h => /^cn-hk-/.test(h)

;(async () => {
    const { T } = load(file, mode, { exports: `globalThis.__T = { transform: transformStreamItem, normalize: normalizeMediaUrl,
        best: () => getCurrentCdn(STARTUP_PICK), soft: (h, ms) => softBlockCdn(h, 'test', ms), dead: h => markHostDead(h, 'timeout'),
        reset: () => { for (const k in cdnHealth) delete cdnHealth[k]; for (const k in cdnSoftBlockUntil) delete cdnSoftBlockUntil[k]; knownDeadHosts.clear(); lastChosenCdn = null },
        zero: h => Object.assign(ensureCdnHealth(h), { ewmaMbps: 0, samples: 0, successes: 0 }),
        seed: (h, mbps, lat) => Object.assign(ensureCdnHealth(h), { ewmaMbps: mbps, samples: 8, latencyMs: lat, lastSeen: Date.now(), successes: 8 }) }` })
    await sleep(300)
    const seedAll = () => {
        T.reset()
        T.seed(HK[0], 120, 30); T.seed(HK[1], 110, 32); T.seed(HK[2], 100, 35)   // 香港三台明顯最好
        T.seed(ALIOV, 30, 80); T.seed(BOS, 25, 400)
    }
    // 4K 項目：一律白名單為主，backup 由 buildBackupUrls 決定
    const item = () => ({ id: 120, height: 2160, bandwidth: 15e6, base_url: 'https://upos-hz-mirrorakam.akamaized.net' + SIG + '&hdnts=x',
        backup_url: ['https://upos-sz-mirrorcosov.bilivideo.com' + SIG] })

    // ── 1. 香港最快：主線路香港，白名單 backup 至少一台不同機房 ──
    seedAll()
    let it = item(); T.transform(it, true)
    const wlBackups = it.backup_url.map(host).filter(h => !h.endsWith('.akamaized.net'))
    console.log('  香港最快：主線路 ' + host(it.base_url).split('.')[0] + '，backup ' + it.backup_url.map(u => host(u).split('.')[0]).join('、'))
    ok(isHK(host(it.base_url)), '前置：香港實測最快 → 主線路是香港（由分數決定，不是寫死）')
    ok(wlBackups.some(h => !isHK(h)), '白名單 backup 至少一台來自不同機房（v1.3.7 會是另外兩台香港，同機房一起出事就全滅）')
    ok(wlBackups[0] && !isHK(wlBackups[0]), '第一個白名單 backup 就是不同機房的節點')

    if (mode !== 'old') {
        // ── 2. 香港機房整個出事（三台都被隔離）：主線路、backup 都不再是香港 ──
        seedAll()
        HK.forEach(h => T.soft(h, 10 * 60 * 1000))
        it = item(); T.transform(it, true)
        console.log('  香港全被隔離：主線路 ' + host(it.base_url).split('.')[0] + '，backup ' + it.backup_url.map(u => host(u).split('.')[0]).join('、'))
        ok(!isHK(host(it.base_url)) && !it.backup_url.map(host).some(isHK), '香港三台都出事 → 主線路與 backup 全部改用其他節點')
        ok(T.best() === ALIOV, '最佳節點自動退到下一名（aliov）')

        // ── 3. 播放器手上還拿著舊的香港網址 → 送出時被改寫走 ──
        const n = T.normalize('https://' + HK[0] + SIG)
        ok(n.changed && !isHK(host(n.url)), '已經拿到的香港網址，請求送出時也被改寫到其他節點')

        // ── 3b. v1.4.1：不同機房的節點都沒量過 → 實測可靠的同機房節點排前面，沒量過的不同機房節點仍保留當退路 ──
        //    （使用者回報的狀態：香港 05／03 有實測，cos 從沒量過、延遲 636ms；v1.4.0 會讓 cos 排第一個白名單 backup）
        T.reset()
        T.seed(HK[0], 145, 92); T.seed(HK[1], 42, 62)
        T.seed(COS, 0, 636); T.zero(COS)
        it = item(); T.transform(it, true)
        const wl3 = it.backup_url.map(host).filter(h => !h.endsWith('.akamaized.net'))
        console.log('  不同機房都沒量過：主線路 ' + host(it.base_url).split('.')[0] + '，backup ' + it.backup_url.map(u => host(u).split('.')[0]).join('、'))
        ok(isHK(wl3[0]) && wl3[0] !== host(it.base_url), '不同機房的節點都沒量過 → 第一個白名單 backup 是另一台實測可靠的香港節點（v1.4.0 會是沒量過的 cos）')
        ok(wl3.some(h => !isHK(h)), '仍保留一個不同機房的 backup（同機房一起出事時的退路）')

        // ── 4. 標死（連不上）同樣成立 ──
        seedAll()
        HK.forEach(h => T.dead(h))
        it = item(); T.transform(it, true)
        ok(!isHK(host(it.base_url)) && !it.backup_url.map(host).some(isHK), '香港三台被判定連不上 → 同樣全部改用其他節點')
    }
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
