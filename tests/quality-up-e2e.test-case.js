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
    T.sync({ videoHeight: 2160 }); T.maybe()
    await sleep(4500)                           // 4K 走 4000ms 延遲
    const lastBk = T.state().lastBk
    const ran = lastBk > startedCooldown
    console.log((ran ? 'PASS' : 'FAIL') + ' 排程觸發後通過冷卻關卡、實際開始賽馬（lastBakeoffAt 已更新）')
    process.exit(ran ? 0 : 1)
})()
