const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const SAMPLE = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/1/2/3/3-1-30080.m4s?e=x&deadline=9999999999'
const AUDIO = 192000
const profile = { reps: [{ height: 720, bandwidth: 1.5e6 }, { height: 1080, bandwidth: 3e6 }, { height: 1080, bandwidth: 2.4e6 }, { height: 2160, bandwidth: 15e6 }], audioBps: AUDIO }
const v = h => ({ videoHeight: h })

;(async () => {
    const mode = process.argv[3] || 'new'
    const { T, logs } = load((process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode)
    await sleep(400)
    T.clearTimer()

    if (mode === 'old') {
        // 對照組：舊版切到 4K 後不會排任何賽馬
        T.setProfile(profile); T.setSample(SAMPLE); T.setBitrate(15e6 + AUDIO, true)
        T.sync(v(1080)); T.sync(v(2160))
        ok(T.state().timer, '1080p→4K 後有排賽馬')
        console.log(`\n${pass} passed, ${fail} failed`); process.exit(0)
    }

    const fresh = () => { T.reset(); T.clearTimer(); T.setProfile(profile); T.setSample(SAMPLE); T.setSeekGrace(0); T.setRunning(false); T.setBitrate(15e6 + AUDIO, true) }

    fresh(); T.sync(v(1080)); T.maybe()
    ok(T.state().pending === 0 && !T.state().timer && T.state().base === 3e6 + AUDIO, '起播第一次校正只建立基準，不排賽馬')

    T.setVerbose(true); T.setLastBakeoffAt(Date.now())
    T.sync(v(2160)); ok(T.state().pending === 15e6 + AUDIO, '1080p→4K 登記待辦')
    T.maybe(); let s = T.state()
    ok(s.timer && s.pending === 0 && s.lastBk === 0, '冷卻期內切 4K 仍會排賽馬（冷卻已解除）')
    ok(logs.some(l => l.includes('畫質提高至約 15.2 Mbps')), 'log 有說明重新測速原因')
    T.clearTimer()

    T.sync(v(1080)); T.maybe()
    ok(T.state().pending === 0 && !T.state().timer, '往下切不觸發')

    T.sync(v(2160)); T.maybe()
    ok(T.state().pending === 0 && !T.state().timer, '來回切同一畫質，同片只測一次')

    fresh(); T.sync(v(720)); T.setSeekGrace(Date.now() + 60000); T.sync(v(1080)); T.maybe()
    ok(T.state().pending === 3e6 + AUDIO && !T.state().timer, 'seek 保護窗內不排程、待辦保留')
    T.setSeekGrace(0); T.maybe()
    ok(T.state().timer && T.state().pending === 0, 'seek 保護窗過後補排')
    T.clearTimer()

    fresh(); T.sync(v(1080)); T.setRunning(true); T.sync(v(2160)); T.maybe()
    ok(T.state().pending > 0 && !T.state().timer, '賽馬進行中先等待')
    T.setRunning(false); T.maybe(); ok(T.state().timer, '賽馬結束後補排'); T.clearTimer()

    fresh(); T.sync(v(1080)); T.setBitrate(15e6 + AUDIO, true); T.sync(v(2160)); T.maybe()
    ok(T.state().timer, 'playurl 重打蓋掉估計值後切 4K 仍會觸發'); T.clearTimer()

    fresh(); T.setProfile({ reps: [{ height: 1080, bandwidth: 2.4e6 }], audioBps: AUDIO }); T.sync(v(1080))
    T.setProfile({ reps: [{ height: 1080, bandwidth: 3e6 }], audioBps: AUDIO }); T.sync(v(1080)); T.maybe()
    ok(T.state().pending === 0 && !T.state().timer, '同畫質換 codec 不觸發')

    fresh(); T.sync(v(1080)); T.sync(v(2160)); T.reset()
    s = T.state(); ok(s.pending === 0 && s.base === 0 && s.done.length === 0, '換片清空待辦、基準與紀錄')

    fresh(); T.setSample(null); T.sync(v(1080)); T.sync(v(2160)); T.maybe()
    ok(T.state().pending === 0 && !T.state().timer, '沒有 segment 樣本時放棄待辦')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
