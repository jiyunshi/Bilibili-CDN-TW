// 測試：起播賽跑（v1.4.0）——主線路是 Akamai 的第一個大型片段，先同時向 Akamai 與白名單節點各要 256KB，先到的贏
// 背景（2026-10-25 實機）：沒有測速紀錄時一般畫質以 Akamai 為主線路，冷門片第一個影片片段在 Akamai 上要 8 秒以上。
// 用法：node tests/startup-race.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'

const AKAM = 'upos-hz-mirrorakam.akamaized.net'
const seg = (host, id) => 'https://' + host + '/upgcxcode/11/22/333/333-1-' + id + '.m4s?e=x&deadline=9999999999&upsig=abc&hdnts=tok'
const host = u => new URL(u).hostname

// 假網路：每個 host 的行為可調（每個 64KB chunk 的延遲、狀態碼）
let net = {}
const fetchLog = []
const fakeFetch = (url, init) => {
    const h = host(url)
    fetchLog.push(h)
    const cfg = net[h.endsWith('.akamaized.net') ? 'akam' : 'wl'] || { delay: 1, status: 206 }
    if (cfg.fail) return Promise.reject(new TypeError('Failed to fetch'))
    const chunk = new Uint8Array(64 * 1024); let sent = 0
    const signal = init && init.signal
    return new Promise(res => setTimeout(() => res({ status: cfg.status, ok: cfg.status >= 200 && cfg.status < 300, headers: { get: () => null },
        body: { getReader: () => ({ read: () => new Promise((r, rej) => {
            if (signal && signal.aborted) return rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            setTimeout(() => (sent++ >= 4 ? r({ done: true }) : r({ done: false, value: chunk })), cfg.delay)
        }) }) } }), cfg.ttfb || 1))
}

// 假 XHR：記錄真正送出的請求（網址＋標頭）
class FakeXHR {
    constructor() { this._h = []; this._listeners = {} }
    get readyState() { return 1 }
    open(m, u) { this._url = u; this._h = [] }
    setRequestHeader(k, v) { this._h.push([k, v]) }
    send() { FakeXHR.sent.push({ url: this._url, headers: this._h.slice() }) }
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f) }
    removeEventListener() {}
    abort() { FakeXHR.aborted++ }
    getResponseHeader() { return null }
    get responseText() { return '' }
    get response() { return null }
}
FakeXHR.prototype.DONE = 4
FakeXHR.sent = []
FakeXHR.aborted = 0

;(async () => {
    const { ctx, logs } = load(file, mode, { XHR: FakeXHR, fetchImpl: fakeFetch, exports: `globalThis.__T = {
        forced: h => isForcedRedirect(h), setVerbose: b => { Config.verbose = b },
        health: h => cdnHealth[h] }` })
    await sleep(400)
    const T = ctx.__T
    T.setVerbose(true)
    const req = (url, range) => { const x = new ctx.XMLHttpRequest(); x.open('GET', url); x.setRequestHeader('Range', range); x.send(); return x }
    const lastSent = () => FakeXHR.sent[FakeXHR.sent.length - 1]
    const BIG = 'bytes=1000-800000', SMALL = 'bytes=0-1000'

    // ── A. Akamai 冷（每 64KB 要 400ms），白名單快 → 正式請求改送白名單 ──
    net = { akam: { delay: 400, status: 206 }, wl: { delay: 5, status: 206 } }
    FakeXHR.sent.length = 0
    req(seg(AKAM, 100026), BIG)
    const queued = FakeXHR.sent.length === 0
    await sleep(1600)
    const a = lastSent()
    console.log('  A. Akamai 冷：正式請求送到 ' + (a ? host(a.url).split('.')[0] : '（還沒送）') + '，標頭 ' + (a ? JSON.stringify(a.headers) : ''))
    ok(a && !host(a.url).endsWith('.akamaized.net'), 'Akamai 冷、白名單快 → 正式請求改送白名單節點（v1.3.7 直接送 Akamai）')
    if (mode !== 'old') {
        ok(queued, '賽跑期間正式請求先暫緩（不會兩邊都下載整個片段）')
        ok(a && a.headers.some(([k, v]) => k === 'Range' && v === BIG), '換主機重新 open 後 Range 標頭照樣帶上')
        ok(T.forced(AKAM), '白名單贏了 → 這個 Akamai 主機改寫 10 分鐘，之後的片段直接走白名單')
        ok(logs.some(l => l.includes('[起播賽跑]')), 'log 交代賽跑結果')
        const wl = a && host(a.url)
        ok(wl && T.health(wl) && T.health(wl).samples >= 1, '賽跑量到的速度記成測速資料（下一支片就有證據）')
    }

    // 之後的情境要重新載入（A 已經把 Akamai 改寫 10 分鐘）
    const fresh = async () => { const env = load(file, mode, { XHR: FakeXHR, fetchImpl: fakeFetch, exports: `globalThis.__T = { forced: h => isForcedRedirect(h), setVerbose: b => { Config.verbose = b }, diag: () => StartupRace.history() }` }); await sleep(400); return env.ctx }
    const reqIn = (c, url, range) => { const x = new c.XMLHttpRequest(); x.open('GET', url); x.setRequestHeader('Range', range); x.send(); return x }

    if (mode !== 'old') {
        // ── B. Akamai 快（熱門片）、白名單慢 → 照原本送 Akamai ──
        let c = await fresh()
        net = { akam: { delay: 5, status: 206 }, wl: { delay: 400, status: 206 } }
        FakeXHR.sent.length = 0
        reqIn(c, seg(AKAM, 100026), BIG); await sleep(1600)
        ok(lastSent() && host(lastSent().url) === AKAM && !c.__T.forced(AKAM), 'Akamai 快、白名單慢 → 照原本送 Akamai，不改寫')

        // ── C. 白名單換主機回 403（綁定節點的串流）→ Akamai ──
        c = await fresh()
        net = { akam: { delay: 100, status: 206 }, wl: { delay: 1, status: 403 } }
        FakeXHR.sent.length = 0
        reqIn(c, seg(AKAM, 100026), BIG); await sleep(1600)
        ok(lastSent() && host(lastSent().url) === AKAM, '白名單回 403 → 送 Akamai')

        // ── D. 小片段（init／索引）不賽，立刻送出 ──
        c = await fresh()
        net = { akam: { delay: 400, status: 206 }, wl: { delay: 1, status: 206 } }
        FakeXHR.sent.length = 0
        reqIn(c, seg(AKAM, 100026), SMALL)
        ok(FakeXHR.sent.length === 1 && host(lastSent().url) === AKAM, '小於 64KB 的請求（init／索引）不賽、立刻送出')

        // ── D2. 音訊片段（約 100KB）也要賽（v1.4.0 門檻 128KB → 64KB）──
        c = await fresh()
        net = { akam: { delay: 400, status: 206 }, wl: { delay: 5, status: 206 } }
        FakeXHR.sent.length = 0
        reqIn(c, seg(AKAM, 30280), 'bytes=1000-101000'); await sleep(1600)
        ok(lastSent() && !host(lastSent().url).endsWith('.akamaized.net'), '約 100KB 的音訊片段也會賽跑，Akamai 冷時改送白名單')
        const hist = c.__T.diag ? c.__T.diag() : null
        ok(hist && hist.length === 1 && hist[0].track === '30280' && hist[0].winner !== 'upos-hz-mirrorakam', 'BiliCDN.diag() 看得到最近的賽跑結果（軌道、勝者）')

        // ── E. 同一條軌道只賽一次 ──
        FakeXHR.sent.length = 0
        reqIn(c, seg(AKAM, 100026), BIG); await sleep(1600)
        const n1 = FakeXHR.sent.length
        FakeXHR.sent.length = 0
        fetchLog.length = 0
        const c2 = await fresh()   // 新環境但先讓第一次賽完，再送第二個同軌道請求
        reqIn(c2, seg(AKAM, 30280), BIG); await sleep(1600)
        fetchLog.length = 0; FakeXHR.sent.length = 0
        reqIn(c2, seg(AKAM, 30280), 'bytes=800001-1600000')
        ok(n1 === 1 && FakeXHR.sent.length === 1 && fetchLog.length === 0, '同一條軌道第二個片段不再賽跑（立刻送出、沒有額外探測）')

        // ── F. 賽跑中播放器取消請求 → 不再送出 ──
        c = await fresh()
        net = { akam: { delay: 400, status: 206 }, wl: { delay: 50, status: 206 } }
        FakeXHR.sent.length = 0
        const xf = reqIn(c, seg(AKAM, 100026), BIG); xf.abort(); await sleep(1600)
        ok(FakeXHR.sent.length === 0, '賽跑中被播放器取消（seek／換畫質）→ 不再送出正式請求')

        // ── G. 主線路本來就是白名單 → 不賽 ──
        c = await fresh()
        FakeXHR.sent.length = 0
        reqIn(c, seg('cn-hk-eq-01-03.bilivideo.com', 100026), BIG)
        ok(FakeXHR.sent.length === 1, '主線路本來就是白名單節點 → 不賽、立刻送出')

        // ── H. 兩邊都失敗 → 照原本送 Akamai（交給播放器自己的重試）──
        c = await fresh()
        net = { akam: { fail: true }, wl: { fail: true } }
        FakeXHR.sent.length = 0
        reqIn(c, seg(AKAM, 100026), BIG); await sleep(600)
        ok(FakeXHR.sent.length === 1 && host(lastSent().url) === AKAM, '兩邊探測都失敗 → 照原本送 Akamai，不卡住')

        // ── I. 兩邊都慢到時限 → 1.2 秒內一定送出（B 站「首位元組 2 秒」計時從播放器呼叫 send 起算）──
        c = await fresh()
        net = { akam: { delay: 3000, status: 206 }, wl: { delay: 3000, status: 206 } }
        FakeXHR.sent.length = 0
        const t0 = Date.now()
        reqIn(c, seg(AKAM, 100026), BIG)
        while (!FakeXHR.sent.length && Date.now() - t0 < 3000) await sleep(20)
        const waited = Date.now() - t0
        console.log('  I. 兩邊都慢：' + waited + 'ms 後送出')
        ok(FakeXHR.sent.length === 1 && waited < 1400, '兩邊都慢 → 最多約 1.2 秒就送出，不讓播放器的 2 秒計時逾時')
    }

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
