// 測試：影片已經緩衝到片尾時，Watchdog 不可把正在用的節點判成「buffered 停滯」
// 用法：node tests/stall-at-end.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old（old = 對照舊版，需另外提供舊檔）]
// 這支測試讓 Watchdog 真的每秒 tick（約 20 秒）。
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const ALIOV = 'upos-sz-mirroraliov.bilivideo.com'

;(async () => {
    const { T, ctx, logs } = load(file, mode, { exports: `globalThis.__T = { wd: Watchdog, soft: isCdnSoftBlocked,
        unsoft: () => { for (const k in cdnSoftBlockUntil) delete cdnSoftBlockUntil[k] }, setVerbose: b => { Config.verbose = b }, forced: h => isForcedRedirect(h), setBitrate: setBufferTargetFromBitrate }` })
    await sleep(300)
    T.setBitrate(3e6, false)

    // 假影片：Watchdog 用 document.querySelectorAll('video') 找最大的那個
    // readyState 跟真的瀏覽器一樣：前方緩衝用完（< 0.5 秒）就掉到 HAVE_CURRENT_DATA（2），播放器開始轉圈
    const fake = { clientWidth: 1280, clientHeight: 720, isConnected: true, paused: false, seeking: false,
        get readyState() { return this._be - this.currentTime < 0.5 && this._be < this.duration - 0.5 ? 2 : 4 },
        playbackRate: 1, videoHeight: 1080, currentTime: 0, duration: 0, _be: 0,
        addEventListener() {}, removeEventListener() {}, pause() {}, play() { return Promise.resolve() },
        get buffered() { const be = this._be; return { length: 1, start: () => 0, end: () => be } } }
    const origQSA = ctx.document.querySelectorAll
    ctx.document.querySelectorAll = (sel) => sel === 'video' ? [fake] : origQSA.call(ctx.document, sel)

    // 播放：每秒前進 1 秒；buffered 終點固定（片尾情境 = 影片長度；卡住情境 = 遠小於影片長度）
    const run = async ({ duration, be, from, seconds }) => {
        T.unsoft(); T.wd.reset(); T.wd.start()
        T.wd.noteExternalBytes(ALIOV, 4 * 1048576)   // 讓 Watchdog 知道正在用 aliov
        fake.duration = duration; fake._be = be; fake.currentTime = from
        const timer = setInterval(() => { fake.currentTime = Math.min(fake.currentTime + 1, be - 0.2) }, 1000)
        await sleep(seconds * 1000)
        clearInterval(timer)
        return T.wd.stats()
    }

    // ── 片尾：整支 100 秒的片都緩衝完了，從 92 秒播到快結尾 ──
    const end = await run({ duration: 100, be: 100, from: 92, seconds: 9 })
    console.log('  片尾：換節點 ' + end.switchCount + ' 次、卡頓判定 ' + end.stallCount + ' 次')
    ok(end.switchCount === 0 && end.stallCount === 0, '已經緩衝到片尾 → 不判定停滯、不換節點')
    ok(!T.soft(ALIOV), '正在用的 aliov 沒有被軟隔離')
    if (mode !== 'old') ok(end.stallCheck === '已緩衝到片尾', 'v1.4.0：BiliCDN.buf() 顯示這一秒沒判定卡住的原因（' + end.stallCheck + '）')

    // ── v1.4.0：實機片尾——duration 是四捨五入的 2954、buffered.end 是 2953.0（差 1 秒），播放順暢 ──
    const endRounded = await run({ duration: 100, be: 99, from: 90, seconds: 8 })
    ok(endRounded.switchCount === 0, '片尾 duration 比 buffered.end 多 1 秒（播放器還沒更新成實際長度）→ 不懲罰（v1.3.7 在片尾前約 8 秒會罰）')
    if (mode !== 'old') ok(endRounded.stallCheck === '已緩衝到片尾', '面板顯示「已緩衝到片尾」（容許差距 1.5 秒）')

    // ── v1.4.0：緩衝只剩 5 秒、終點不動，但播放器還在順暢播（readyState 4）→ 不懲罰（交給慢片段補發）──
    const predicted = await run({ duration: 1000, be: 106, from: 96, seconds: 8 })   // 緩衝 10 → 2 秒，一直在播
    console.log('  快見底但還在播：換節點 ' + predicted.switchCount + ' 次')
    ok(predicted.switchCount === 0, '緩衝快見底但播放器還沒卡住 → 不懲罰節點（v1.3.7 會預測性懲罰）')

    // ── 對照：影片中段真的卡住（1000 秒的片，buffered 停在 100 秒，從 92 秒往前播）──
    const stuck = await run({ duration: 1000, be: 100, from: 95, seconds: 10 })   // 約 5 秒後緩衝用完、readyState 掉到 2
    console.log('  中段卡住：換節點 ' + stuck.switchCount + ' 次、卡頓判定 ' + stuck.stallCount + ' 次')
    ok(stuck.switchCount > 0, '對照組：中段真的卡住時照樣換節點（證明這支測試抓得到停滯）')
    const pen = (stuck.recentPenalties || []).slice(-1)[0]
    if (mode !== 'old') ok(pen && pen.reason === 'buffered 停滯' && pen.bufferedEnd === 100 && pen.duration === 1000 && typeof pen.ahead === 'number',
        'v1.4.0：懲罰時記下判定當下的情境（緩衝終點、影片長度、緩衝秒數）')

    if (mode !== 'old') T.setVerbose(true)
    // ── 播放器自己清掉前方緩衝（切 Hi-Res／畫質）：buffered.end 從 150 掉到 92.5，之後重新填充得慢 ──
    // v1.3.7 前：緩衝見底、終點不動、正在播 → 判停滯、懲罰正在用的節點（實機香港 03／05、aliov 都這樣中槍）
    T.unsoft(); T.wd.reset(); T.wd.start()
    T.wd.noteExternalBytes(ALIOV, 4 * 1048576)
    fake.duration = 1000; fake._be = 150; fake.currentTime = 92
    const timer = setInterval(() => { fake.currentTime = Math.min(fake.currentTime + 1, fake._be - 0.2) }, 1000)
    await sleep(4000)                       // 先正常播幾秒，讓 Watchdog 記住終點 150
    fake._be = fake.currentTime + 0.5       // 清緩衝：終點往回掉到播放位置附近
    await sleep(5000)
    clearInterval(timer)
    const flush = T.wd.stats()
    console.log('  清緩衝：換節點 ' + flush.switchCount + ' 次、卡頓判定 ' + flush.stallCount + ' 次')
    if (mode !== 'old') ok(logs.some(l => l.includes('播放器清除了前方緩衝')), 'log 交代偵測到播放器清緩衝')
    ok(flush.switchCount === 0 && !T.soft(ALIOV), '播放器清掉前方緩衝重新填充 → 保護窗內不判停滯、不懲罰節點')

    // ── 懲罰對象：卡住緩衝的是「等最久還沒下載完」的片段，不是最後一個收到資料的 ──
    const AKAM = 'upos-hz-mirrorakam.akamaized.net', HK03 = 'cn-hk-eq-01-03.bilivideo.com'
    T.setVerbose(true)
    // 隔離有節流（同一顆短時間內不重複隔離），所以直接看 log 裡這一輪懲罰了誰
    const punishedSince = (i) => logs.slice(i).filter(l => l.includes('懲罰 ')).map(l => l.split('懲罰 ').pop().trim())
    let logMark = 0
    const stuckWith = async (blockHost) => {
        logMark = logs.length
        T.unsoft(); T.wd.reset(); T.wd.start()
        const tok = T.wd.noteSegmentStart ? T.wd.noteSegmentStart(blockHost) : 0   // 影片片段卡在 blockHost
        T.wd.noteExternalBytes(ALIOV, 4 * 1048576)                                 // 音訊片段在 aliov 正常下載完（最後一筆資料）
        fake.duration = 1000; fake._be = 100; fake.currentTime = 95
        const tm = setInterval(() => { fake.currentTime = Math.min(fake.currentTime + 1, fake._be - 0.2) }, 1000)
        await sleep(10000)
        clearInterval(tm)
        if (T.wd.noteSegmentEnd) T.wd.noteSegmentEnd(tok)
        return T.wd.stats()
    }
    const a = await stuckWith(AKAM)
    const pa = punishedSince(logMark)
    console.log('  卡在 Akamai：換節點 ' + a.switchCount + ' 次、懲罰 [' + pa.join('、') + ']、Akamai 改寫 ' + T.forced(AKAM))
    ok(a.switchCount >= 1 && pa.length === 0, '影片片段卡在 Akamai → 不懲罰任何白名單節點（v1.3.6 會罰到無辜的節點）')
    ok(T.forced(AKAM), '卡住的是 Akamai → 改寫到白名單節點')
    const h = await stuckWith(HK03)
    const ph = punishedSince(logMark)
    console.log('  卡在香港 03：換節點 ' + h.switchCount + ' 次、懲罰 [' + ph.join('、') + ']')
    ok(ph.length >= 1 && ph.every(x => x.includes('cn-hk-eq-01-03')), '影片片段卡在香港 03 → 懲罰香港 03，不是最後收到資料的 aliov')

    if (mode !== 'old') { T.wd.reset(); ok(T.wd.stats().recentPenalties.length > 0, '換片（Watchdog 重置）後懲罰紀錄仍保留，片尾接自動連播時也查得到') }

    T.wd.stop()
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
