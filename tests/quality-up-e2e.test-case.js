const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
    const { T } = load((process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), 'new')
    await sleep(400); T.clearTimer()
    const AUDIO = 192000
    T.reset(); T.setProfile({ reps: [{ height: 1080, bandwidth: 3e6 }, { height: 2160, bandwidth: 15e6 }], audioBps: AUDIO })
    T.setSample('https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/1/2/3/3-1-30080.m4s?e=x&deadline=9999999999')
    T.setBitrate(15e6 + AUDIO, true)
    T.sync({ videoHeight: 1080 })
    const startedCooldown = Date.now()
    T.setLastBakeoffAt(startedCooldown)          // 模擬起播賽馬剛跑完、仍在 90 秒冷卻內
    T.sync({ videoHeight: 2160 })
    // 跟實機一樣由 Watchdog 每秒呼叫一次。v1.3.7：切畫質開保護窗（4K 8 秒），過了才排程，再走 4K 的 4000ms 延遲
    const switchedAt = Date.now()
    const tick = setInterval(() => T.maybe(), 1000)
    T.maybe()
    const early = T.state().lastBk > startedCooldown
    while (Date.now() - switchedAt < 14000 && !(T.state().lastBk > startedCooldown)) await sleep(250)
    clearInterval(tick)
    const lastBk = T.state().lastBk
    const ran = lastBk > startedCooldown
    const waited = ((lastBk - switchedAt) / 1000).toFixed(1)
    console.log((!early ? 'PASS' : 'FAIL') + ' 切換當下（保護窗內）不立刻測速')
    console.log((ran ? 'PASS' : 'FAIL') + ' 保護窗過後排程、通過冷卻關卡、實際開始賽馬（切換後 ' + waited + ' 秒）')
    process.exit(ran && !early ? 0 : 1)
})()
