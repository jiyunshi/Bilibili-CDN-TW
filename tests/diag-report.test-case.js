// 測試：「複製診斷」的報告（v1.4.1）——要包含 v1.4.0 的診斷資訊（各節點實測、卡住判定、懲罰、補發、起播賽跑），
// 而且不能夾帶網址、簽名參數等可能識別使用者或觀看紀錄的內容。
// 用法：node tests/diag-report.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const HK5 = 'cn-hk-eq-01-05.bilivideo.com', ALIOV = 'upos-sz-mirroraliov.bilivideo.com', ALI = 'upos-sz-mirrorali.bilivideo.com'

;(async () => {
    const { T } = load(file, mode, { exports: `globalThis.__T = { report: buildDiagReport,
        seed: (h, mbps, lat, n) => Object.assign(ensureCdnHealth(h), { ewmaMbps: mbps, samples: n, latencyMs: lat, lastSeen: Date.now(), successes: n }),
        soft: h => softBlockCdn(h, 'test', 60000), fail: h => recordCdnPenalty(h, false) }` })
    await sleep(300)
    T.seed(HK5, 80, 30, 6); T.seed(ALIOV, 33, 12, 3); T.seed(ALI, 2, 80, 2); T.fail(ALI); T.soft(ALI)
    const text = T.report()
    console.log(text.split('\n').map(l => '  | ' + l).join('\n'))

    ok(/版本：/.test(text) && /白名單：/.test(text), '原本的欄位都還在（版本、白名單…）')
    ok(/── 播放狀態 ──/.test(text) && /卡住判定：/.test(text), '包含播放狀態與卡住判定')
    ok(/── 各節點實測/.test(text), '包含各節點實測')
    const row = (text.split('\n').find(l => l.startsWith('cn-hk-eq-01-05：')) || '')
    ok(/80\.0 \/ 30 \/ 6 \//.test(row), '節點列寫出實際的速度、延遲、樣本數（香港 05：' + row + '）')
    const order = text.split('\n').filter(l => /^(cn-hk|upos-)[^：]*：/.test(l)).map(l => l.split('：')[0])
    ok(order.indexOf('cn-hk-eq-01-05') < order.indexOf('upos-sz-mirrorali'), '節點依分數排序（快的在前）')
    ok(/upos-sz-mirrorali：[^\n]*暫時避開/.test(text), '被暫時避開的節點有標示')
    ok(/── 最近的停滯懲罰 ──/.test(text) && /── 最近的慢片段補發 ──/.test(text) && /── 最近的起播賽跑 ──/.test(text) && /── 測速 ──/.test(text),
        '包含停滯懲罰、慢片段補發、起播賽跑、測速四段')
    ok(!/https?:|\/\/[a-z0-9.-]+\/|upsig|deadline=|hdnts|bilivideo\.com|akamaized/.test(text), '不含網址、簽名參數或完整主機名稱')
    ok(!/讀取失敗/.test(text), '每一段都讀取成功')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
