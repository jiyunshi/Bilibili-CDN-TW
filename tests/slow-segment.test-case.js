// 測試：慢片段補發（v1.4.0）——卡住緩衝的片段照目前速度來不及下載完時，讓它逾時、由播放器重試到其他節點
// 用法：node tests/slow-segment.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old]
// Watchdog 真的每秒 tick，整支測試約 25 秒。
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const HK3 = 'cn-hk-eq-01-03.bilivideo.com', AKAM = 'upos-hz-mirrorakam.akamaized.net'

;(async () => {
    const { T, ctx } = load(file, mode, { exports: `globalThis.__T = { wd: Watchdog, soft: isCdnSoftBlocked, forced: isForcedRedirect, health: h => cdnHealth[h],
        setBitrate: setBufferTargetFromBitrate, setVerbose: b => { Config.verbose = b },
        clear: () => { for (const k in cdnSoftBlockUntil) delete cdnSoftBlockUntil[k]; forcedRedirectHosts.clear() } }` })
    await sleep(300)
    T.setBitrate(3e6, false); T.setVerbose(true)
    if (!T.wd.noteSegmentProgress) { ok(false, '慢片段補發（v1.3.7 沒有這個機制）'); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }

    // 假影片：緩衝終點固定（只剩幾秒），播放持續前進
    const fake = { clientWidth: 1280, clientHeight: 720, isConnected: true, paused: false, seeking: false, readyState: 4,
        playbackRate: 1, videoHeight: 1080, currentTime: 0, duration: 1000, _be: 0,
        addEventListener() {}, removeEventListener() {}, pause() {}, play() { return Promise.resolve() },
        get buffered() { const be = this._be; return { length: 1, start: () => 0, end: () => be } } }
    const origQSA = ctx.document.querySelectorAll
    ctx.document.querySelectorAll = (sel) => sel === 'video' ? [fake] : origQSA.call(ctx.document, sel)
    // 假 XHR：只記錄有沒有被設成逾時
    const mkXhr = () => ({ timedOut: null, _forceTimeout(ms) { this.timedOut = ms; return true } })

    // 跑一段：開始一個下載中的片段，給定進度，播放 seconds 秒
    const run = async ({ host, ahead, loaded, total, seconds, test }) => {
        T.clear(); T.wd.reset(); T.wd.start()
        fake.currentTime = 0.5; fake._be = 0.5 + ahead   // 從開頭播：跳到 100 秒會被當成拖時間軸、開 5 秒保護期
        const xhr = mkXhr()
        const tok = T.wd.noteSegmentStart(host, xhr)
        T.wd.noteSegmentProgress(tok, loaded, total)
        if (test) T.wd.hedgeTestOnce()
        const tm = setInterval(() => { fake.currentTime = Math.min(fake.currentTime + 0.2, fake._be - 0.1) }, 1000)
        await sleep(seconds * 1000)
        clearInterval(tm)
        T.wd.noteSegmentEnd(tok)
        return { xhr, hedges: T.wd.recentHedges() }
    }

    // ── 1. 白名單節點：2MB 片段 3 秒只下載 100KB、緩衝剩 4 秒 → 逾時、軟隔離＋強制改寫 ──
    let r = await run({ host: HK3, ahead: 4, loaded: 100 * 1024, total: 2048 * 1024, seconds: 4 })
    console.log('  慢片段：逾時設成 ' + r.xhr.timedOut + 'ms，紀錄 ' + JSON.stringify(r.hedges.slice(-1)[0] || null))
    ok(r.xhr.timedOut > 0, '來不及在緩衝用完前下載完 → 讓這個 XHR 逾時（由播放器重試）')
    ok(T.soft(HK3) && T.forced(HK3), '白名單節點：軟隔離＋強制改寫，重試會被改寫到別的節點')
    const hh = T.health(HK3)
    ok(hh && hh.samples >= 1 && hh.ewmaMbps < 5 && hh.failures >= 1, '慢的證據留下來：已下載量÷已經過時間記成一筆樣本（' + (hh ? hh.ewmaMbps.toFixed(2) : '?') + ' Mbps）＋一次失敗，隔離結束後不會又被當成快節點')

    // ── 2. 同一個節點 8 秒內不重複處理（它已經被隔離了）──
    r = await run({ host: HK3, ahead: 4, loaded: 50 * 1024, total: 2048 * 1024, seconds: 3 })
    ok(r.xhr.timedOut === null, '同一個節點 8 秒內不重複處理')

    // ── 2b. 換過去的節點也慢（不同節點）→ 可以再救一次（v1.4.0 以前全域冷卻 8 秒，這次會被擋住、卡很久）──
    r = await run({ host: AKAM, ahead: 4, loaded: 50 * 1024, total: 2048 * 1024, seconds: 3 })
    ok(r.xhr.timedOut > 0 && T.forced(AKAM), '補發換到的節點也慢 → 不同節點可以立刻再救（Akamai 強制改寫）')

    // ── 2c. 全域 30 秒內最多 3 次（整體網路變慢時不會一路把所有節點都隔離）──
    r = await run({ host: 'upos-sz-mirroraliov.bilivideo.com', ahead: 4, loaded: 50 * 1024, total: 2048 * 1024, seconds: 3 })
    const third = r.xhr.timedOut > 0
    r = await run({ host: 'upos-sz-mirrorbos.bilivideo.com', ahead: 4, loaded: 50 * 1024, total: 2048 * 1024, seconds: 3 })
    ok(third && r.xhr.timedOut === null, '30 秒內第 3 次照樣處理、第 4 次停手')
    await sleep(14000)   // 讓 30 秒的視窗過去，後面的情境才不受影響

    // ── 2d. 開播時（緩衝 0）正常下載中的快節點 → 不動（v1.4.0：片段本身要比串流碼率慢才算慢片段）──
    r = await run({ host: 'upos-sz-mirroralib.bilivideo.com', ahead: 0.6, loaded: 3000 * 1024, total: 4096 * 1024, seconds: 3 })   // 3 秒內約 8 Mbps，高於需求
    ok(r.xhr.timedOut === null, '緩衝幾乎為 0，但片段正以 > 串流碼率的速度下載 → 不判成慢片段（舊條件會誤判最快的節點）')

    // ── 3. 緩衝還多（20 秒）→ 不動 ──
    r = await run({ host: HK3, ahead: 20, loaded: 100 * 1024, total: 2048 * 1024, seconds: 3 })
    ok(r.xhr.timedOut === null && !T.soft(HK3), '緩衝還有 20 秒 → 不動（讓它慢慢下載）')

    // ── 4. 快下載完（90%）→ 不動 ──
    r = await run({ host: HK3, ahead: 4, loaded: 1900 * 1024, total: 2048 * 1024, seconds: 3 })
    ok(r.xhr.timedOut === null, '已經下載 90% → 不動（重新下載反而更慢）')

    // ── 5. 速度夠（預估剩餘時間 < 緩衝）→ 不動 ──
    r = await run({ host: HK3, ahead: 5, loaded: 1500 * 1024, total: 2048 * 1024, seconds: 2 })
    ok(r.xhr.timedOut === null, '照目前速度來得及下載完 → 不動')

    // ── 6. hedgeTest()：測試用，下一次檢查一定處理一次 ──
    r = await run({ host: HK3, ahead: 30, loaded: 0, total: 0, seconds: 2, test: true })
    ok(r.xhr.timedOut > 0 && (r.hedges.slice(-1)[0] || {}).test === true, 'BiliCDN.hedgeTest()：下一次檢查把等最久的片段當成慢片段處理一次')

    T.wd.stop()
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
