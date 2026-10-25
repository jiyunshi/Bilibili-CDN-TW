// 測試：已經量過、而且速度撐不起目前畫質的節點，不拿真實播放去探索它（v1.4.0）；全部都不夠快時照原本的規則
// 背景：模擬器（假時鐘＋測速探測＋慢片段補發）裡，探索加成讓 8 Mbps 的節點被拿來播 4K（需要 20 Mbps），
// 每次都卡；固定只用夠快的節點幾乎不卡。
// 用法：node tests/feasibility.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'
const H = s => 'upos-sz-mirror' + s + '.bilivideo.com'

;(async () => {
    const { T } = load(file, mode, { exports: `globalThis.__T = { list: () => getHealthyCdnList().map(c => c.cdn || c), setBitrate: setBufferTargetFromBitrate,
        reset: hs => { for (const k in cdnHealth) delete cdnHealth[k]; activeCdnList.length = 0; hs.forEach(h => activeCdnList.push(h)); lastChosenCdn = null },
        seed: (h, mbps, n, ageMin) => Object.assign(ensureCdnHealth(h), { ewmaMbps: mbps, samples: n, latencyMs: 100, lastSeen: Date.now() - ageMin * 60000, successes: n }) }` })
    await sleep(300)
    const nodes = [H('aliov'), H('bos'), H('ali02')]
    // 4K（約 21 Mbps）：ali02 只量過 8 Mbps，而且很久沒用（探索加成大）
    T.setBitrate(20e6, true)
    T.reset(nodes); T.seed(H('aliov'), 33, 30, 0); T.seed(H('bos'), 26, 30, 0); T.seed(H('ali02'), 8, 1, 120)
    let list = T.list()
    console.log('  4K 候選：' + list.map(h => h.split('.')[0].replace('upos-sz-mirror', '')).join(' > '))
    ok(!list.includes(H('ali02')), '4K：量過只有 8 Mbps 的節點不在播放候選裡（v1.3.7 會因探索加成選上它）')
    // 1080P（約 2 Mbps）：8 Mbps 足夠 → 照常是候選
    T.setBitrate(1.7e6, false)
    T.reset(nodes); T.seed(H('aliov'), 33, 30, 0); T.seed(H('bos'), 26, 30, 0); T.seed(H('ali02'), 8, 1, 120)
    ok(T.list().includes(H('ali02')), '1080P：同一個節點夠快 → 照常是候選（看的是目前畫質的需求）')
    // 全部都不夠快 → 不過濾，照原本規則（不能讓候選池變空）
    T.setBitrate(60e6, true)
    T.reset(nodes); T.seed(H('aliov'), 33, 30, 0); T.seed(H('bos'), 26, 30, 0); T.seed(H('ali02'), 8, 1, 0)
    ok(T.list().length === 3, '全部都撐不起（8K 等級）→ 不過濾，候選池不會變空')
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
