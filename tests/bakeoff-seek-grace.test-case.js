// 測試：起播測速的 timer 撞上 seek 保護窗時，等窗結束再排一次，不能無聲丟掉
// 背景（2026-11-14 實機）：合集／自動連播／有續播位置的換片，載入後 0.5～1.4 秒播放器會跳到續播位置
// （seeking 事件），開 5～8 秒的保護窗；起播測速排在 playurl 後 1.5～4 秒，正好落在窗內。
// runThroughputBakeoff 在窗內是無聲 return，舊版沒有人會再排一次 → 這支片整支不測速，面板上也看不出來。
// 用法：node tests/bakeoff-seek-grace.test-case.js [要測的 .user.js，預設 repo 根目錄那份]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')
const seg = cid => `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/11/22/${cid}/${cid}-1-100026.m4s?e=x&deadline=9999999999&os=cosbv&upsig=abc`
const playurl = (cid) => ({ code: 0, data: { timelength: 240000, dash: { duration: 240,
    video: [{ id: 80, height: 1080, bandwidth: 3e6, codecs: 'avc1.640032', codecid: 7, base_url: seg(cid), baseUrl: seg(cid), backup_url: [], backupUrl: [] }],
    audio: [{ id: 30280, bandwidth: 192000, base_url: seg(cid), baseUrl: seg(cid), backup_url: [], backupUrl: [] }] } } })

;(async () => {
    const { T } = load(file, 'new', { exports: `globalThis.__T = { transform: playInfoTransformer, lastBk: getLastBakeoffAt,
        setGrace: ms => { seekGraceUntil = Date.now() + ms }, timer: () => !!bakeoffTimer, setRunning: b => { bakeoffRunning = b },
        status: () => lastBakeoffStatus && lastBakeoffStatus.outcome,
        clearTimer: () => { clearTimeout(bakeoffTimer); bakeoffTimer = null } }` })
    await sleep(400); T.clearTimer()

    // 新片 playurl → 排 1.5 秒後測速；0.3 秒後播放器跳到續播位置 → 保護窗（這裡縮成 2.5 秒，實機是 5～8 秒）
    T.transform(playurl('700001'))
    await sleep(300); T.setGrace(2500)
    await sleep(1500)                                   // t=1.8s：測速 timer 已觸發，人還在保護窗內
    ok(T.lastBk() === 0 && !T.status(), '保護窗內：沒有測速（不跟重新填充搶頻寬）')
    ok(T.timer(), '★ 但有重排，不是丟掉')
    await sleep(1800)                                   // t=3.6s：保護窗（到 2.8s）已過 + 300ms 餘裕
    ok(T.lastBk() > 0 && T.status() === 'running', '保護窗過後：測速開始（面板看得到狀態）')

    // 使用者一直拖時間軸（保護窗不斷展延）：重排有上限，不會永遠掛著一顆 timer
    T.setRunning(false); T.clearTimer()
    const before = T.lastBk()
    T.transform(playurl('700001'))
    const keep = setInterval(() => T.setGrace(800), 200)   // 每 200ms 又拖一次，保護窗永遠還剩 0.6～0.8 秒
    T.setGrace(800)
    await sleep(1500 + 3 * 1100 + 700)                  // 起播延遲 1.5s + 3 次重排（各等「窗剩餘 + 300ms」≈ 1.1s）
    ok(!T.timer(), '（此時仍在保護窗內）')
    clearInterval(keep)
    ok(!T.timer() && T.lastBk() === before, '保護窗一直不結束：重排 3 次後放棄，沒有殘留 timer、也沒有硬跑')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
