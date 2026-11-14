// 測試：本分頁強制放行（forceNextBakeoff）遇上「起播讓路」時，2 秒後的重試仍要放行，不能撞冷卻而無聲放棄
// 背景：換片／切畫質不再把共用冷卻時間戳歸零（會連帶解除其他分頁的冷卻），改用本分頁一次性旗標。
// 第一版實作在讓路「之前」就清掉旗標；換片當下幾乎一定在補緩衝而讓路，重試時旗標已不在、
// 共用冷卻又還在（上一支片 90 秒內剛測過），新片就永遠測不到速。harness 沒有播放器，
// isStartupBuffering() 恆為 false，既有測試走不到這條路徑，所以這裡假造 Watchdog.stats()。
// 用法：node tests/force-bakeoff-defer.test-case.js [要測的 .user.js，預設 repo 根目錄那份]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')
const SAMPLE = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/1/2/3/3-1-30080.m4s?e=x&deadline=9999999999'

;(async () => {
    const { T } = load(file, 'new', { exports: `globalThis.__T = { run: runThroughputBakeoff, setLastBakeoffAt, lastBk: getLastBakeoffAt,
        force: () => forceNextBakeoff, setForce: b => { forceNextBakeoff = b }, timer: () => !!bakeoffTimer,
        clearTimer: () => { clearTimeout(bakeoffTimer); bakeoffTimer = null }, resetDefers: () => { bakeoffStartupDefers = 0 },
        setRunning: b => { bakeoffRunning = b }, setSample: u => { lastSampleSegmentUrl = u },
        buffering: b => { Watchdog.stats = () => ({ readyState: 4, paused: false, bufferedSec: b ? 2 : 60, videoTimeSec: 0 }) } }` })
    await sleep(400); T.clearTimer()
    T.setSample(SAMPLE)   // 讓路後的重試用的是 lastSampleSegmentUrl，不是當初傳進來的網址

    // 情境：上一支片剛測過（共用冷卻還在），本分頁換片 → 強制放行，但新片正在補緩衝
    const cooldownAt = Date.now()
    T.setLastBakeoffAt(cooldownAt); T.resetDefers(); T.setForce(true); T.buffering(true)
    await T.run(SAMPLE, true)
    ok(T.timer() && T.lastBk() === cooldownAt, '補緩衝中先讓路，排 2 秒後重試，沒有開跑')
    ok(T.force(), '讓路時保留強制放行旗標')

    T.buffering(false)
    await sleep(2300)
    ok(T.lastBk() > cooldownAt, '緩衝夠了之後重試：通過冷卻關卡、實際開始賽馬')
    ok(!T.force(), '開跑後旗標已用掉，不會留到之後放行無關的賽馬')

    // 對照：沒有強制放行時，冷卻期內照樣擋下（確認上面不是因為冷卻本來就沒作用）
    T.setRunning(false); T.clearTimer()
    const cd2 = Date.now()
    T.setLastBakeoffAt(cd2); T.resetDefers(); T.setForce(false); T.buffering(false)
    await T.run(SAMPLE, false)
    ok(T.lastBk() === cd2 && !T.timer(), '沒有強制放行：冷卻期內不跑')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
