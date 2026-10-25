// 測試：播放器用「省略協定」的網址（//api.bilibili.com/x/player/wbi/playurl?…）重新取得 playurl 時，回應照樣要被改寫
// 背景（2026-10-25 實機）：切換 Hi-Res／杜比音軌時播放器就是這樣發請求；v1.3.6 判成「不是 playurl」整包放行，
// 4K AV1 影片軌回到 B 站原本的 Akamai，一個片段下載 7.9 秒，接著 Watchdog 判定停滯。
// 用法：node tests/playurl-relative.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old]
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'

const seg = (host, id) => 'https://' + host + '/upgcxcode/93/07/356/356-1-' + id + '.m4s?e=x&deadline=9999999999&upsig=abc'
const COSOV = 'upos-sz-mirrorcosov.bilivideo.com', AKAM = 'upos-hz-mirrorakam.akamaized.net'
// B 站實機給台灣的樣子：每條軌道只有 2 個網址，主線路在 cosov／Akamai 之間二選一
const RAW = JSON.stringify({ code: 0, data: { dash: {
    video: [{ id: 120, codecid: 13, bandwidth: 2.3e6, height: 2160, base_url: seg(AKAM, 100029), backup_url: [seg(COSOV, 100029)] },
            { id: 80, codecid: 7, bandwidth: 1.2e6, height: 1080, base_url: seg(COSOV, 30080), backup_url: [seg(AKAM, 30080)] }],
    audio: [{ id: 30280, bandwidth: 2e5, base_url: seg(COSOV, 30280), backup_url: [seg(AKAM, 30280)] }],
    flac: { audio: { id: 30251, bandwidth: 1.5e6, base_url: seg(COSOV, 30251), backup_url: [seg(AKAM, 30251)] } },
} } })

// 假 XHR：open 記住網址，讀取時已經是 DONE、回傳上面那包原始 playurl
class FakeXHR {
    get readyState() { return 4 }
    open(m, u) { this._url = u } send() {} setRequestHeader() {} addEventListener() {} abort() {} getResponseHeader() { return null }
    get responseText() { return RAW }
    get response() { return RAW }
    get responseURL() { return 'https://api.bilibili.com' + String(this._url).replace(/^\/\/api\.bilibili\.com/, '') }
}
FakeXHR.prototype.DONE = 4
FakeXHR.DONE = 4

;(async () => {
    // fetch 路徑：假網路對 playurl 回原始內容（腳本的 fetch 攔截會讀 text() 再改寫）
    const fetchImpl = (url) => Promise.resolve({ status: 200, statusText: 'OK', headers: {}, ok: true, text: () => Promise.resolve(RAW) })
    const { ctx } = load(file, mode, { XHR: FakeXHR, fetchImpl, exports: 'globalThis.__T = {}' })
    ctx.Response = class { constructor(body) { this._b = body } text() { return Promise.resolve(this._b) } }
    ctx.Request = class {}
    await sleep(300)
    const host = u => new URL(u).hostname
    const read = (url) => { const x = new ctx.XMLHttpRequest(); x.open('GET', url); return JSON.parse(x.responseText).data.dash }

    const abs = read('https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1&cid=1&qn=120&fnval=4048')
    ok(host(abs.video[0].base_url) !== AKAM, '前置：完整網址的 playurl 會被改寫（4K 軌改以白名單為主線路）')

    const rel = read('//api.bilibili.com/x/player/wbi/playurl?bvid=BV1&cid=1&qn=120&fnval=4048')
    const v4k = rel.video[0]
    console.log('  省略協定：4K 主線路 ' + host(v4k.base_url).split('.')[0] + '，備用 ' + (v4k.backup_url || []).map(u => host(u).split('.')[0]).join('、'))
    ok(host(v4k.base_url) !== AKAM && host(v4k.base_url) !== COSOV, '省略協定的 playurl 也會被改寫：4K 軌不再以 Akamai 為主線路')
    ok((rel.flac.audio.backup_url || []).length > 1, 'Hi-Res 無損音軌的備用線路也補上白名單節點')
    ok(JSON.stringify(rel) === JSON.stringify(abs), '兩種寫法改寫結果相同')

    // ── fetch 路徑（播放器目前用 XHR，但這條路徑也要一致）──
    const viaFetch = JSON.parse(await (await ctx.fetch('//api.bilibili.com/x/player/wbi/playurl?bvid=BV1&cid=1&qn=120')).text()).data.dash
    ok(host(viaFetch.video[0].base_url) !== AKAM && host(viaFetch.video[0].base_url) !== COSOV, 'fetch 省略協定的 playurl 也會被改寫')

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
