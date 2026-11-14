// 測試：不是主影片的片段（懸停預覽）不餵給 Watchdog，以及認錯主影片時的保險
// 背景（2026-11-14 實機）：滑鼠停在推薦卡片上，預覽播放器會持續抓那支片的 .m4s，跟主影片的片段交錯。
// 舊版全部算進 Watchdog：緩衝進度與各節點下載量混進別支片的數字，「目前播放節點」也可能被預覽用的節點蓋掉。
// 用法：node tests/foreign-segment.test-case.js [要測的 .user.js，預設 repo 根目錄那份]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')
const COS = 'upos-sz-mirrorcos.bilivideo.com', COSOV = 'upos-sz-mirrorcosov.bilivideo.com'
const seg = (cid, host = COS) => `https://${host}/upgcxcode/11/22/${cid}/${cid}-1-100026.m4s?e=x&deadline=9999999999&os=cosbv&upsig=abc`
const playurl = (cid) => ({ code: 0, data: { timelength: 240000, dash: { duration: 240,
    video: [{ id: 80, height: 1080, bandwidth: 3e6, codecs: 'avc1.640032', codecid: 7, base_url: seg(cid), baseUrl: seg(cid), backup_url: [], backupUrl: [] }],
    audio: [{ id: 30280, bandwidth: 192000, base_url: seg(cid), baseUrl: seg(cid), backup_url: [], backupUrl: [] }] } } })
// 每個片段 4MB；沒有 body.tee → 走 content-length 概算那條分支（夠驗「有沒有入帳」）
const MB4 = 4 * 1048576
const fakeFetch = () => Promise.resolve({ ok: true, status: 206, headers: { get: n => n.toLowerCase() === 'content-length' ? String(MB4) : null }, body: null })

;(async () => {
    const { T, ctx } = load(file, 'new', { fetchImpl: fakeFetch, exports: `const realStats = Watchdog.stats.bind(Watchdog); globalThis.__T = {
        transform: playInfoTransformer, main: () => mainStreamCid, isForeign: isForeignSegment, check: checkForeignFilterSanity,
        st: () => { const s = realStats(); return { totalMB: s.totalMB, per: s.perCdnMB, last: Watchdog.getLastSegmentCdn() } },
        stats: () => ({ ...videoResetStats }), win: () => ({ ...segWindow }),
        fakeBuffer: (end, paused) => { Watchdog.stats = () => ({ bufferedSec: end, paused: !!paused }) },   // 只有保險會讀到這個假值
        clearTimer: () => { clearTimeout(bakeoffTimer); bakeoffTimer = null } }` })
    await sleep(400); T.clearTimer()
    ctx.Request = Request; ctx.Response = Response
    const get = async (u) => { await ctx.fetch(u); await sleep(15) }
    const go = async (path) => { Object.assign(ctx.location, { pathname: path, search: '', href: 'https://www.bilibili.com' + path }); ctx.history.pushState({}, '', path); await sleep(15) }

    // ── 還不知道主影片是誰：一律不過濾（維持舊行為）──
    ok(T.main() === '' && T.isForeign(seg('700999')) === false, '不知道主影片的 cid 時不過濾')
    await get(seg('700999'))
    ok(T.st().totalMB === 4, '此時所有片段照常入帳')

    // ── 主影片 playurl 到了之後 ──
    T.transform(playurl('700001')); T.clearTimer()
    const base = T.st().totalMB
    await get(seg('700001'))
    let a = T.st()
    ok(a.totalMB === base + 4 && a.last === COS, '主影片的片段：入帳，並記為目前播放節點')

    await get(seg('700999', COSOV)); await get(seg('700999', COSOV))
    let b = T.st()
    ok(b.totalMB === base + 4, '★ 別支片（懸停預覽）的片段：不計入這支片的流量')
    ok(!b.per['upos-sz-mirrorcosov'], '不計入各節點下載量')
    ok(b.last === COS, '★ 「目前播放節點」沒有被預覽用的節點蓋掉')
    ok(T.stats().foreignSegs === 2, '診斷統計記下排除了幾個（' + T.stats().foreignSegs + '）')
    ok(T.isForeign('https://x.bilivideo.com/v1/resource/abc.m4s') === false, '網址認不出 cid：不過濾')

    // ── 保險：純懸停預覽不會誤觸發 ──
    T.check()                                             // 清掉上面累積的計數
    for (let i = 0; i < 4; i++) {                         // 主影片與預覽交錯、主影片緩衝持續成長
        await get(seg('700001')); await get(seg('700999', COSOV))
        T.fakeBuffer(100 + i * 10); T.check()
    }
    ok(T.main() === '700001' && !T.stats().filterDisarmed, '主影片片段有在來：不解除過濾')
    for (let i = 0; i < 4; i++) {                         // 主影片緩衝已滿／暫停（不成長），只有預覽在抓
        await get(seg('700999', COSOV))
        T.fakeBuffer(200, i % 2 === 1); T.check()
    }
    ok(T.main() === '700001' && !T.stats().filterDisarmed, '主影片緩衝沒在長（已滿或暫停）、只有預覽在抓：不解除過濾')

    // ── 保險：認錯主影片（真正在播的片段全被當成別支片）──
    T.fakeBuffer(300); await get(seg('700555')); T.check()        // 基準
    T.fakeBuffer(310); await get(seg('700555')); T.check()        // 第 1 次：緩衝在長、只看到「別支片」
    ok(T.main() === '700001', '只出現一個週期：先不動')
    T.fakeBuffer(320); await get(seg('700555')); T.check()        // 第 2 次
    ok(T.main() === '' && T.stats().filterDisarmed === 1, '★ 連續兩個週期「緩衝在長、卻只有別支片的片段」：解除過濾')
    const t1 = T.st().totalMB
    await get(seg('700555'))
    ok(T.st().totalMB === t1 + 4, '解除後片段恢復入帳，Watchdog 不會整支片看不到流量')

    // ── 網址先變的換片：主 playurl 到之前不過濾 ──
    T.transform(playurl('700002')); T.clearTimer()               // 保險解除後重新認得主影片
    T.transform(playurl('700004')); T.clearTimer()               // 合集換片：playurl 先到
    await go('/video/BV1ZZZZZZZZZ')                               // 網址後到，被認領
    ok(T.main() === '700004', 'playurl 先到、網址後到：cid 保留')
    await sleep(10)
    await go('/video/BV1YYYYYYYYY')                               // 換一個入口：網址先變
    ok(T.main() === '' && T.isForeign(seg('700003')) === false, '網址先變：cid 清空，新片的片段在主 playurl 到之前不會被當成別支片')
    T.transform(playurl('700003')); T.clearTimer()
    ok(T.main() === '700003' && T.isForeign(seg('700002')) === true, '主 playurl 到：重新認得主影片，舊片的片段算別支片')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
