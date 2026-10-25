// 測試：切換畫質後「立刻」重新計算緩衝與測速（以播放器回報的畫質編號為準，不等 videoHeight）
// 用法：node tests/quality-switch.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old（old = 對照舊版，需另外提供舊檔）]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const BOS = 'upos-sz-mirrorbos.bilivideo.com'
const SAMPLE = 'https://' + BOS + '/upgcxcode/11/22/333/333-1-100026.m4s?e=x&deadline=9999999999&upsig=abc'
const AUDIO = 192000
// 實機畫質編號：80 = 1080P、64 = 720P、32 = 480P
const profile = { reps: [
    { height: 1080, bandwidth: 3.0e6, qn: 80 }, { height: 720, bandwidth: 1.5e6, qn: 64 }, { height: 480, bandwidth: 0.7e6, qn: 32 },
], audioBps: AUDIO }

// 假 CDN：測速探測一律回 206 + 足量資料
const fakeFetch = () => {
    const chunk = new Uint8Array(64 * 1024); let sent = 0
    return Promise.resolve({ status: 206, ok: true, headers: { get: () => null },
        body: { getReader: () => ({ read: () => new Promise(r => setTimeout(() => (sent++ >= 8 ? r({ done: true }) : r({ done: false, value: chunk })), 1)) }) } })
}

;(async () => {
    const { T, ctx, logs } = load(file, mode, { fetchImpl: fakeFetch, exports: `globalThis.__T = { sync: syncStreamBitrateFromVideo,
        maybe: maybeRunQualityUpBakeoff, reset: resetStreamProfile, setProfile: p => { streamProfile = p },
        setSample: u => { lastSampleSegmentUrl = u }, setBitrate: setBufferTargetFromBitrate, cur: () => currentStreamBitsPerSec,
        wd: Watchdog, lastBk: getLastBakeoffAt, setLastBakeoffAt, setVerbose: b => { Config.verbose = b },
        clearTimer: () => { clearTimeout(bakeoffTimer); bakeoffTimer = null }, setSeekGrace: t => { seekGraceUntil = t }, grace: () => seekGraceUntil,
        status: () => (typeof lastBakeoffStatus === 'undefined' ? null : lastBakeoffStatus),
        // 現用節點 bos 有新鮮、很快的樣本 → 舊版的「夠快就跳過」一定成立
        fastPlaying: () => { Object.assign(ensureCdnHealth('${BOS}'), { ewmaMbps: 80, samples: 6, lastSeen: Date.now(), successes: 6 }); Watchdog.getLastSegmentCdn = () => '${BOS}' } }` })
    await sleep(400); T.clearTimer(); T.setVerbose(true)
    let Q = 64
    ctx.player = { getQuality: () => ({ realQ: Q }) }   // unsafeWindow === ctx
    const video = { videoHeight: 720 }
    const fresh = () => { T.reset(); T.wd.reset(); T.clearTimer(); T.setProfile(profile); T.setSample(SAMPLE); T.setBitrate(3e6 + AUDIO, false) }

    // ── 1. 播放器已切到 480P，但畫面還在播舊緩衝（videoHeight 仍 720）──
    fresh()
    T.sync(video)                                   // 基準：720P
    ok(Math.abs(T.cur() - (1.5e6 + AUDIO)) < 1, '基準：720P 的碼率')
    T.wd.noteExternalBytes(BOS, 30 * 1048576)       // 這一段已經下載 30MB
    const before = T.wd.stats()
    Q = 32
    T.sync(video)                                   // videoHeight 還是 720
    const after = T.wd.stats()
    ok(Math.abs(T.cur() - (0.7e6 + AUDIO)) < 1, '切到 480P 的當下就改用 480P 碼率（videoHeight 仍是 720）')
    ok(before.phaseMB >= 30 && after.phaseMB === 0 && after.phaseReason === 'quality',
        '緩衝進度重新起算（30MB → 0），面板會標示「切換畫質後」')
    ok(after.totalMB >= 30, '整支片的累計量不受影響（HTTPDNS 評分仍用它）')
    ok(logs.some(l => l.includes('[畫質] 切換為約')), 'log 交代切換')
    ok(T.grace() > Date.now(), '切畫質開保護窗：播放器清緩衝重抓那幾秒不判停滯（v1.3.6 會懲罰當時最快的節點）')

    // ── 2. 切回 1080P：往上切 → 重新測速，而且不會被「現用節點夠快」跳過 ──
    T.fastPlaying(); T.setLastBakeoffAt(Date.now())
    const switchedAt = Date.now() + 1   // 測速開始時會把共用時間戳寫成「當下」，必須晚於切換的時間點
    await sleep(5)
    Q = 80
    T.sync({ videoHeight: 480 })                    // 畫面還在播 480P 的緩衝
    T.maybe()
    ok(Math.abs(T.cur() - (3e6 + AUDIO)) < 1, '切到 1080P 的當下就改用 1080P 碼率')
    T.setSeekGrace(0); T.maybe()                    // v1.3.7：切畫質開保護窗；這裡模擬保護窗過後的那一次 tick
    await sleep(2500)                               // 一般畫質排程延遲 1.5 秒 + 探測
    ok(T.lastBk() > switchedAt, '現用節點已經夠快，切畫質仍會真的重新測速（v1.3.5 會無聲跳過）')
    const st = T.status()
    ok(st && st.reason === '切換畫質' && (st.outcome === 'done' || st.outcome === 'running'), '面板的測速狀態顯示「切換畫質」')

    // ── 3. 往下切：重新起算緩衝，但不測速 ──
    fresh(); T.setLastBakeoffAt(0); Q = 80
    T.sync(video); T.maybe(); T.clearTimer()
    const bk0 = T.lastBk()
    Q = 32; T.sync(video); T.maybe()
    await sleep(2000)
    ok(T.lastBk() === bk0, '往下切不重新測速（需求變低，舊判斷仍成立）')
    ok(T.wd.stats().phaseReason === 'quality', '往下切也會重新起算緩衝進度')

    // ── 4. 讀不到播放器時退回 videoHeight（行為同 v1.3.5）──
    delete ctx.player
    fresh()
    T.sync({ videoHeight: 720 })
    T.sync({ videoHeight: 1080 })
    ok(Math.abs(T.cur() - (3e6 + AUDIO)) < 1, '沒有播放器 API 時，照 videoHeight 判斷')
    ok(T.wd.stats().phaseReason === 'quality', '退回 videoHeight 時，碼率明顯變動也會重新起算緩衝')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
