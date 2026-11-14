// 測試：換片判定改看「主播放器 playurl 的 cid」，並且不把預載的 playurl 當成正在播的片
// 背景（2026-11-14 實機，/zh-Hant/video/ 與一般頁面相同）：
//   - 合集清單／分 P／自動連播：新片的 playurl 回應「先」到（+100ms），pushState「後」到（再 +130～170ms）。
//     舊版在 pushState 時重置，把剛到手的新片碼率、測速樣本、測速排程清掉 → 這支片整支不測速、門檻用預設值。
//   - 點推薦卡片：先 pushState，主 playurl 後到（這條路徑舊版沒事）。
//   - 換片後約 1.5 秒、以及滑鼠停在推薦卡片上時，B 站會打別支影片的 playurl（gaia_source=pre-load）。
//     舊版把它當成正在播的片，覆蓋碼率清單與測速樣本。
// 用法：node tests/video-identity.test-case.js [要測的 .user.js，預設 repo 根目錄那份]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')

const seg = (cid, host = 'upos-sz-mirrorcos.bilivideo.com') =>
    `https://${host}/upgcxcode/11/22/${cid}/${cid}-1-100026.m4s?e=x&deadline=9999999999&os=cosbv&upsig=abc`
// height/bandwidth 每支片給不同值，才看得出「碼率清單是誰的」
const playurl = (cid, height, bw) => ({ code: 0, data: { timelength: 240000, dash: { duration: 240,
    video: [{ id: 120, height, bandwidth: bw, codecs: 'avc1.640032', codecid: 7, base_url: seg(cid), baseUrl: seg(cid), backup_url: [seg(cid, 'upos-sz-mirrorcosov.bilivideo.com')], backupUrl: [seg(cid, 'upos-sz-mirrorcosov.bilivideo.com')] }],
    audio: [{ id: 30280, bandwidth: 192000, base_url: seg(cid), baseUrl: seg(cid), backup_url: [], backupUrl: [] }],
} } })
const cidOf = u => (String(u || '').match(/\/upgcxcode\/\d+\/\d+\/(\d+)\//) || [])[1] || ''

;(async () => {
    let now = Date.now()
    const { T, ctx } = load(file, 'new', { clock: () => now, exports: `globalThis.__T = {
        transform: playInfoTransformer, isPreload: isPreloadPlayUrl, cidFrom: extractStreamCid,
        st: () => ({ epoch: bakeoffEpoch, sample: lastSampleSegmentUrl, timer: !!bakeoffTimer, bps: currentStreamBitsPerSec,
            reps: streamProfile ? streamProfile.reps.map(r => r.height).join(',') : '', main: mainStreamCid, force: forceNextBakeoff }),
        stats: () => ({ ...videoResetStats }),
        clearTimer: () => { clearTimeout(bakeoffTimer); bakeoffTimer = null } }` })
    await sleep(400); T.clearTimer()
    const go = async (path, search = '') => {
        Object.assign(ctx.location, { pathname: path, search, href: 'https://www.bilibili.com' + path + search })
        ctx.history.pushState({}, '', path + search); await sleep(15)
    }
    const s = () => T.st()

    // ── 純函式 ──
    ok(T.isPreload('https://api.bilibili.com/x/player/wbi/playurl?qn=32&gaia_source=pre-load&cid=1') === true, 'gaia_source=pre-load → 預載')
    ok(T.isPreload('//api.bilibili.com/x/player/wbi/playurl?qn=120&gaia_source=&is_main_page=true&cid=1') === false, '主播放器的請求（// 開頭、gaia_source 為空）→ 不是預載')
    ok(T.isPreload('https://api.bilibili.com/x/player/wbi/playurl?qn=32&gaia_source=view-card&is_main_page=false&cid=1') === true, '懸停預覽（gaia_source=view-card、is_main_page=false）→ 不是主請求')
    ok(T.isPreload('https://api.bilibili.com/x/player/wbi/playurl?qn=32&is_main_page=false&cid=1') === true, '只有 is_main_page=false → 不是主請求')
    ok(T.isPreload('https://api.bilibili.com/x/player/wbi/playurl?gaia_source=main_web&is_main_page=true&cid=1') === false, 'is_main_page=true 優先：就算 gaia_source 有值也是主請求')
    ok(T.isPreload('https://api.bilibili.com/x/player/wbi/playurl?cid=1') === false && T.isPreload('https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=1') === false && T.isPreload('') === false, '兩個參數都沒有（番劇等其他 API）或網址是空的 → 照舊當主請求')
    ok(T.cidFrom(playurl('700001', 1080, 3e6).data.dash) === '700001', '從串流網址取出 cid')
    ok(T.cidFrom({ video: [{ base_url: 'https://x.bilivideo.com/v1/resource/abc.m4s' }] }) === '' && T.cidFrom(null) === '', '認不出的網址格式 → 空字串（退回只看網址）')

    // ── 第一支片（整頁載入，__playinfo__ 內嵌，沒有請求網址）──
    T.transform(playurl('700001', 1080, 3e6))
    let a = s()
    ok(a.main === '700001' && a.epoch === 0 && cidOf(a.sample) === '700001' && a.reps === '1080', '第一支片：記下 cid、不重置、樣本與碼率清單是它的')
    T.clearTimer()

    // ── 預載別支影片（換片後 1.5 秒／懸停預覽）──
    const pre = playurl('700999', 2160, 15e6)
    T.transform(pre, { preload: true })
    let b = s()
    ok(b.main === '700001' && b.epoch === 0, '預載：不當成換片')
    ok(cidOf(b.sample) === '700001' && !b.timer, '預載：不換測速樣本、不排測速')
    ok(b.reps === '1080' && b.bps === a.bps, '預載：不覆蓋正在播的片的碼率清單與緩衝門檻')
    ok(pre.data.dash.video[0].base_url !== undefined && typeof pre.data.dash.video[0].base_url === 'string', '預載：回應本身照常處理（網址仍會被改寫）')

    // ── 同一支片重打 playurl（切畫質、續期）──
    T.transform(playurl('700001', 1080, 3e6))
    ok(s().epoch === 0, '同一個 cid 重打 playurl：不重置')
    T.clearTimer()

    // ── 合集清單／分 P／自動連播：playurl 先到，pushState 後到 ──
    T.transform(playurl('700002', 2160, 15e6))
    let c = s()
    ok(c.epoch === 1 && c.main === '700002', '新 cid 的主 playurl：當場重置一次')
    ok(cidOf(c.sample) === '700002' && c.timer && c.reps === '2160' && c.bps > 15e6, '重置發生在套用之前：樣本、測速排程、碼率清單都是新片的')
    await go('/video/BV1BBBBBBBBB')
    let d = s()
    ok(d.epoch === 1, '隨後的 pushState：認領，不再重置一次')
    ok(cidOf(d.sample) === '700002' && d.timer && d.reps === '2160' && d.bps === c.bps, '★ 新片剛到手的樣本、排程、碼率沒有被 pushState 清掉')
    T.clearTimer()

    // ── 點推薦卡片：pushState 先到，主 playurl 後到 ──
    now += 60000
    await go('/video/BV1CCCCCCCCC')
    let e = s()
    ok(e.epoch === 2 && !e.sample && e.bps === 0, '網址先變：先行重置（舊片的樣本與碼率清掉）')
    T.transform(playurl('700003', 1080, 3e6))
    let f = s()
    ok(f.epoch === 2, '隨後的主 playurl：認領，不再重置一次')
    ok(cidOf(f.sample) === '700003' && f.timer && f.reps === '1080', '新片的樣本、排程、碼率清單正常套用')
    T.clearTimer()

    // ── 快速連換（兩種流程交錯，間隔小於認領時間窗）──
    now += 1000
    T.transform(playurl('700004', 720, 1.5e6)); await go('/video/BV1DDDDDDDDD')      // 合集流程
    now += 1000
    await go('/video/BV1EEEEEEEEE'); T.transform(playurl('700005', 1080, 3e6))      // 推薦流程
    let g = s()
    ok(g.epoch === 4, '兩次換片各重置一次（共 ' + (g.epoch - 2) + ' 次），沒有漏也沒有重複')
    ok(cidOf(g.sample) === '700005' && g.reps === '1080', '最後停在最新那支片的資料')
    T.clearTimer()

    // ── 認領有時效：網址變了但新片的 playurl 一直沒來（同一支片的網址被改寫），之後才真的換片 ──
    now += 60000
    await go('/video/BV1FFFFFFFFF')
    const e1 = s().epoch
    now += 6000
    T.transform(playurl('700006', 1080, 3e6))
    ok(s().epoch === e1 + 1 && cidOf(s().sample) === '700006', '過了時間窗才來的新 cid：照常重置，不會被舊的「待認領」吃掉')
    T.clearTimer()

    // ── 預載不影響認領狀態 ──
    now += 60000
    const e2 = s().epoch
    T.transform(playurl('700999', 2160, 15e6), { preload: true })
    await go('/video/BV1GGGGGGGGG')
    ok(s().epoch === e2 + 1, '預載之後的網址變動：照常重置（預載不會被誤認成「已經重置過」）')
    T.transform(playurl('700007', 1080, 3e6))
    ok(s().epoch === e2 + 1 && cidOf(s().sample) === '700007', '接著的主 playurl 認領')
    T.clearTimer()

    // ── 網址判定的兩個誤判 ──
    now += 60000
    await go('/video/BV1GGGGGGGGG/', '?p=1')
    ok(s().epoch === e2 + 1, '補上 ?p=1（跟沒有 p 是同一集）：不算換片')
    await go('/video/BV1GGGGGGGGG/', '?p=2')
    ok(s().epoch === e2 + 2, '?p=2：算換片')
    T.transform(playurl('700008', 1080, 3e6)); T.clearTimer()
    now += 60000
    await go('/video/BV1GGGGGGGGG/', '')
    ok(s().epoch === e2 + 3, '從 ?p=2 回到沒有 p（第一集）：算換片')
    T.transform(playurl('700009', 1080, 3e6)); T.clearTimer()

    now += 60000
    await go('/list/watchlater', '')                         // 認不出影片（退回 pathname）
    const e3 = s().epoch
    T.transform(playurl('700010', 1080, 3e6))                // 第一支片的 playurl
    const e4 = s().epoch
    now += 60000
    await go('/list/watchlater', '?bvid=BV1HHHHHHHHH&oid=1') // B 站晚一步才補上 ?bvid=
    ok(s().epoch === e4 && cidOf(s().sample) === '700010', '同一頁「認不出 → 認得了」：不算換片，第一支片的樣本還在（進入時 +' + (e4 - e3 + 1) + '）')
    now += 60000
    await go('/list/watchlater', '?bvid=BV1JJJJJJJJJ&oid=2')
    ok(s().epoch === e4 + 1, '列表內真的換下一部：算換片')

    // ── 自我檢查：playurl 觸發了重置，卻一直沒有網址變動來認領（預載被誤認成主請求時的樣子）──
    // 計時器用的是真實時間（5.5 秒），判斷用的是假時鐘，兩邊都要推進
    now += 60000
    await go('/video/BV1KKKKKKKKK'); T.transform(playurl('700011', 1080, 3e6)); T.clearTimer()
    const st0 = T.stats()
    ok(st0.orphan === 0 && st0.preloadSeen === 2 && st0.byUrl > 0 && st0.byPlayurl > 0 && st0.claimed > 0,
        '正常流程下沒有異常計數（網址 ' + st0.byUrl + '、playurl ' + st0.byPlayurl + '、認領 ' + st0.claimed + '、略過預載 ' + st0.preloadSeen + '）')
    now += 60000
    T.transform(playurl('700998', 2160, 15e6)); T.clearTimer()     // 沒被標成預載的別支影片，網址沒變
    await sleep(5800); now += 5800
    ok(T.stats().orphan === 1, '網址沒變卻換了 cid：記一次異常（給診斷報告用）')
    await go('/video/BV1LLLLLLLLL')
    ok(s().epoch > 0 && T.stats().byUrl === st0.byUrl + 1, '異常已結案：之後的網址變動照常重置，不會被它認領走')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
