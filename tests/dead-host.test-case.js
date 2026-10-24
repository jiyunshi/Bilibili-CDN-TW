// 測試：死節點判定要有對照組（本機斷網不標死）＋ 既有誤殺紀錄的自癒複查
// 用法：node tests/dead-host.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old（old = 對照舊版，需另外提供舊檔）]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'

const H = s => 'upos-sz-mirror' + s + '.bilivideo.com'
const AKAM = 'upos-hz-mirrorakam.akamaized.net'
const HWOV = H('hwov')

// 假網路：down 裡的 host 一律連線層失敗（reject），ALL_DOWN 時整台機器斷網
let down = new Set(), ALL_DOWN = false
const calls = []
const fakeFetch = (url) => {
    const host = new URL(url).hostname
    calls.push(host)
    if (ALL_DOWN || down.has(host)) return Promise.reject(new TypeError('Failed to fetch'))
    return Promise.resolve({ status: 0, ok: false, type: 'opaque', headers: { get: () => null } })
}

const now = Date.now(), DAY = 86400000
// 模擬 2026-10-25 實機看到的狀態：四顆在同一個時間窗被判 DNS-segment，外加不該被複查的兩類
const poisoned = JSON.stringify([
    { host: H('aliov'), reason: 'DNS-segment', expireAt: now + 15.1 * DAY },
    { host: H('alib'),  reason: 'DNS-segment', expireAt: now + 15.1 * DAY },
    { host: AKAM,       reason: 'DNS-segment', expireAt: now + 15.1 * DAY },
    { host: H('cos'),   reason: 'DNS-segment', expireAt: now + 15.1 * DAY },
    { host: H('ali02'), reason: 'timeout',     expireAt: now + 0.5 * DAY },
    { host: 'upos-tf-all-tx.bilivideo.com', reason: 'HARD-fail', expireAt: now + 5 * DAY },
    { host: HWOV,       reason: 'DNS',         expireAt: now + 25 * DAY },
])

const exportsCommon = `segErr: handleSegmentConnError, dead: () => [...knownDeadHosts], list: listDeadHosts, setVerbose: b => { Config.verbose = b }`

;(async () => {
    if (mode === 'old') {
        const { T } = load(file, 'old', { fetchImpl: fakeFetch, exports: `globalThis.__T = { ${exportsCommon} }` })
        await sleep(400)
        ALL_DOWN = true
        T.segErr(H('bos'), 0); await sleep(50)
        ok(!T.dead().includes(H('bos')), '本機斷網時 segment 失敗不會把好節點標死')
        console.log(`\n${pass} passed, ${fail} failed`); process.exit(0)
    }

    const env = load(file, 'new', { fetchImpl: fakeFetch, store: { knownDeadHosts_v1: poisoned },
        exports: `globalThis.__T = { ${exportsCommon}, confirm: confirmHostDead, probe: probeCdnLatency,
            reverify: reverifyDeadHosts, pickControl: pickControlHost, active: () => [...activeCdnList],
            resetSegCooldown: () => segConnCheckAt.clear(), markDead: markHostDead, revive: reviveDeadHost }` })
    const { T, logs, store } = env
    await sleep(400)
    T.setVerbose(true)
    const ctxNav = env.ctx.navigator

    // ── confirmHostDead：四種判決 ──
    down = new Set(); ALL_DOWN = false
    ok(await T.confirm(H('bos')) === 'reachable', '目標連得到 → reachable')
    down = new Set([H('bos')])
    ok(await T.confirm(H('bos')) === 'dead', '目標不通、對照組通 → dead')
    ok(T.pickControl(H('bos')) !== H('bos'), '對照組不會挑到受測的那顆')
    ALL_DOWN = true
    ok(await T.confirm(H('bos')) === 'network-down', '目標與對照組都不通 → network-down（本機斷網）')
    ALL_DOWN = false; down = new Set()
    ctxNav.onLine = false; calls.length = 0
    ok(await T.confirm(H('bos')) === 'network-down' && calls.length === 0, 'navigator.onLine=false → 直接 network-down，不發任何請求')
    ctxNav.onLine = true

    // ── 三個標死點都要套用 ──
    ALL_DOWN = true; T.resetSegCooldown()
    T.segErr(H('bos'), 0); await sleep(50)
    ok(!T.dead().includes(H('bos')), 'segment 連線失敗 + 本機斷網 → 不標死（舊版會標死 30 天）')
    ok(logs.some(l => l.includes('判定為本機網路中斷，不標死')), 'log 有說明為什麼沒標死')
    ALL_DOWN = false; down = new Set([H('bos')]); T.resetSegCooldown()
    T.segErr(H('bos'), 0); await sleep(50)
    ok(T.dead().includes(H('bos')), '對照組通、目標不通 → 照舊標死（真的壞掉的節點仍會被處理）')
    T.revive(H('bos'))

    ALL_DOWN = true
    const r1 = await T.probe(H('ali'))
    ok(!T.dead().includes(H('ali')) && r1.reason === 'network-down' && Number.isFinite(r1.ms),
        '延遲探測失敗 + 本機斷網 → 不標死，且回有限值（留在候選池）')
    ALL_DOWN = false

    // ── 自癒：既有誤殺紀錄 ──
    const before = T.list().map(e => e.host)
    ok(before.includes(H('aliov')) && before.includes(AKAM), '前置：載入時有 4 筆 DNS-segment 誤殺紀錄')
    calls.length = 0; down = new Set()
    const revived = await T.reverify()
    const after = T.dead()
    ok([H('aliov'), H('alib'), AKAM, H('cos'), H('ali02')].every(h => !after.includes(h)), '複查後 DNS-segment 與 timeout 類全部救回')
    ok(after.includes(HWOV), 'KNOWN_BAD_TW_HOSTS（已確認 NXDOMAIN）不複查、不救回')
    ok(!calls.includes(HWOV), '而且根本不對它發請求（不會多印紅字）')
    ok(T.list().some(e => e.reason === 'HARD-fail'), 'HARD-fail（伺服器明確拒絕）不因「連得到」被救回')
    ok(revived.length === 5, '回傳救回清單（5 顆）')
    ok(T.active().includes(H('aliov')), '救回的節點回到候選池')

    // 冷卻：6 小時內不再做
    calls.length = 0
    T.markDead(H('aliov'), 'DNS-segment')
    const again = await T.reverify()
    ok(again.length === 0 && calls.length === 0, '6 小時冷卻內不再複查（跨分頁共用時間戳）')

    // 複查當下本機斷網：一顆都不能救回、也不能誤判
    store.deadReverifyAt_v1 = 0
    ALL_DOWN = true
    const r3 = await T.reverify()
    ok(r3.length === 0 && T.dead().includes(H('aliov')), '複查時本機斷網 → 放棄這一輪，不救回也不加罪')
    ALL_DOWN = false

    // 複查時節點真的還是不通：維持死刑
    store.deadReverifyAt_v1 = 0
    down = new Set([H('aliov')])
    const r4 = await T.reverify()
    ok(r4.length === 0 && T.dead().includes(H('aliov')), '節點真的還不通 → 維持死節點')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
