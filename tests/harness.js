const fs = require('fs'), vm = require('vm')

module.exports = (file, mode, opts) => {
    const store = Object.assign({}, (opts && opts.store) || {})
    const mkEl = () => ({
        children: [], style: {}, setAttribute(){}, getAttribute(){ return null },
        appendChild(c){ this.children.push(c); c.parentNode = this; return c },
        remove(){ if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this) },
        addEventListener(){}, removeEventListener(){}, querySelector(){ return null }, querySelectorAll(){ return [] },
    })
    const head = mkEl(), body = mkEl()
    const findById = (n, id) => { for (const c of n.children) { if (c.id === id) return c; const r = findById(c, id); if (r) return r } return null }
    class Doc {}
    Object.defineProperty(Doc.prototype, 'hidden', { get(){ return false }, configurable: true })
    Object.defineProperty(Doc.prototype, 'visibilityState', { get(){ return 'visible' }, configurable: true })
    const document = Object.assign(new Doc(), {
        head, body, documentElement: mkEl(), readyState: 'loading', createElement: mkEl,
        getElementById: id => findById(head, id) || findById(body, id),
        querySelector(){ return null }, querySelectorAll(){ return [] }, addEventListener(){}, removeEventListener(){}, cookie: '',
    })
    class XHRStub { open(){} send(){} setRequestHeader(){} addEventListener(){} abort(){} getResponseHeader(){ return null } }
    Object.defineProperty(XHRStub.prototype, 'responseText', { get(){ return '' } })
    Object.defineProperty(XHRStub.prototype, 'response', { get(){ return '' } })
    XHRStub.prototype.DONE = 4
    const logs = []
    const ctx = {
        console: { log: (...a) => logs.push(a.join(' ')), warn(){}, error(){}, info(){}, debug(){} },
        setTimeout, clearTimeout, setInterval, clearInterval, Promise, URL, URLSearchParams, Map, Set, WeakMap, JSON, Math, Date, AbortController, TextEncoder, TextDecoder,
        GM_getValue: (k, d) => (k in store ? store[k] : d), GM_setValue: (k, v) => { store[k] = v }, GM_deleteValue: k => { delete store[k] }, GM_registerMenuCommand(){},
        GM_info: { script: { version: 'test' } }, document, Document: Doc, Image: class { set src(v){} }, XMLHttpRequest: XHRStub,
        MutationObserver: class { observe(){} disconnect(){} },
        PerformanceObserver: Object.assign(class { observe(){} disconnect(){} }, { supportedEntryTypes: ['resource'] }),
        ProgressEvent: class {},
        RTCPeerConnection: class { createDataChannel(){} createOffer(){ return Promise.resolve() } setLocalDescription(){ return Promise.resolve() } close(){} },
        Worker: class { postMessage(){} terminate(){} addEventListener(){} }, Blob: class {},
        performance: { now: () => Date.now(), getEntriesByType: () => [], getEntriesByName: () => [] },
        fetch: () => new Promise(() => {}),
        location: { href: 'https://www.bilibili.com/video/BV1xx411c7mD', hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '', origin: 'https://www.bilibili.com' },
        navigator: { userAgent: 'node', connection: null, onLine: true }, history: { pushState(){}, replaceState(){} },
        addEventListener(){}, removeEventListener(){}, dispatchEvent(){},
    }
    ctx.window = ctx; ctx.unsafeWindow = ctx; ctx.globalThis = ctx; ctx.self = ctx
    vm.createContext(ctx)
    // 測試端可在載入前設定 ctx.__fetchImpl 模擬 CDN 回應（rawFetch 綁的是載入當下的 fetch）
    ctx.fetch = (...a) => (ctx.__fetchImpl ? ctx.__fetchImpl(...a) : new Promise(() => {}))
    if (opts && opts.fetchImpl) ctx.__fetchImpl = opts.fetchImpl
    const exp = (opts && opts.exports) ? opts.exports : mode === 'new'
        ? `globalThis.__T = { sync: syncStreamBitrateFromVideo, maybe: maybeRunQualityUpBakeoff, reset: resetStreamProfile,
            setProfile: p => { streamProfile = p }, setSample: u => { lastSampleSegmentUrl = u }, setSeekGrace: t => { seekGraceUntil = t },
            setRunning: b => { bakeoffRunning = b }, clearTimer: () => { clearTimeout(bakeoffTimer); bakeoffTimer = null },
            setLastBakeoffAt, setBitrate: setBufferTargetFromBitrate, setVerbose: b => { Config.verbose = b },
            state: () => ({ pending: qualityUpPendingBps, base: lastSyncedStreamBps, done: [...qualityUpBakeoffDone], timer: !!bakeoffTimer, cur: currentStreamBitsPerSec, lastBk: getLastBakeoffAt() }) }`
        : `globalThis.__T = { sync: syncStreamBitrateFromVideo, setProfile: p => { streamProfile = p }, setSample: u => { lastSampleSegmentUrl = u },
            clearTimer: () => { clearTimeout(bakeoffTimer); bakeoffTimer = null }, setBitrate: setBufferTargetFromBitrate,
            state: () => ({ timer: !!bakeoffTimer, cur: currentStreamBitsPerSec }) }`
    vm.runInContext(fs.readFileSync(file, 'utf8') + '\n;' + exp, ctx, { filename: file })
    return { T: ctx.__T, logs, store, ctx }
}
