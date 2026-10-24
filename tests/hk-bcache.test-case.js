// 測試：香港 BCache 進入白名單後，主執行緒與 Worker 的處理一致
// 用法：node tests/hk-bcache.test-case.js [要測的 .user.js，預設 repo 根目錄那份] [new|old（old = 對照舊版，需另外提供舊檔）]
const fs = require('fs')
const load = require('./harness')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m) }
const file = (process.argv[2] || require('path').join(__dirname, '..', 'bilibili-cdn-tw.user.js')), mode = process.argv[3] || 'new'

const HK3 = 'cn-hk-eq-01-03.bilivideo.com', HK5 = 'cn-hk-eq-01-05.bilivideo.com', HK1 = 'cn-hk-eq-01-01.bilivideo.com'
const HK2 = 'cn-hk-eq-01-02.bilivideo.com'   // 同系列但沒驗證過 → 不在白名單
const SIG = '/upgcxcode/11/22/333/333-1-100026.m4s?e=x&deadline=9999999999&upsig=abc'

;(async () => {
    const { T } = load(file, 'new', { exports: `globalThis.__T = { unstable: isUnstableCdnHost, list: PREFERRED_CDN_LIST,
        thr: recordCdnThroughput, health: h => cdnHealth[h], rewriteUnstable: rewriteUnstableMediaUrl,
        normalize: normalizeMediaUrl, needs: needsRedirect, isMedia: isMediaSegmentUrl }` })
    await sleep(300)

    if (mode === 'old') {
        T.thr(HK3, 2 * 1048576, 300, 1)
        ok(!!(T.health(HK3) && T.health(HK3).samples), '香港節點的吞吐量會被記錄')
        console.log(`\n${pass} passed, ${fail} failed`); process.exit(0)
    }

    // ── 主執行緒 ──
    ok([HK3, HK5, HK1].every(h => T.list.includes(h)), '三台驗證過的香港節點在白名單裡')
    ok(!T.list.includes(HK2), '沒驗證過的 01-02 不在白名單')
    ok([HK3, HK5, HK1].every(h => !T.unstable(h)), '白名單裡的香港節點不算不穩定')
    ok(T.unstable(HK2), '同系列但沒驗證過的 01-02 仍算不穩定')
    ok(T.unstable('cn-hbwh-cm-01-11.bilivideo.com') && T.unstable('cn-tj-cu-01-02.bilivideo.com'), '大陸 BCache 照舊排除（2 碼與 4 碼地區）')
    ok(T.unstable('xy1x2x3x4xy.mcdn.bilivideo.cn') && T.unstable('abc.szbdyd.com'), 'MCDN / PCDN 照舊排除')
    T.thr(HK3, 2 * 1048576, 300, 1)
    ok(!!(T.health(HK3) && T.health(HK3).samples === 1), '香港節點的吞吐量會被記錄（舊版直接丟掉）')
    ok(T.rewriteUnstable('https://' + HK3 + SIG) === null, '播放器打到香港節點時，不會被「不穩定節點改寫」換走')
    ok(T.needs(HK3) === false, 'needsRedirect：健康的香港節點不需要改寫')
    const n = T.normalize('https://' + HK2 + SIG)
    ok(n.changed && !/cn-hk-eq-01-02/.test(n.url), '沒驗證過的 01-02 仍會被改寫到白名單節點')
    ok(T.isMedia('https://' + HK3 + SIG), '香港節點的 m4s 仍被認成媒體片段（位元組計算、Watchdog 都看得到）')

    // ── Worker：從原始檔抽出注入 Worker 的那段，照 template literal 還原後執行 ──
    const src = fs.readFileSync(file, 'utf8')
    const start = src.indexOf('const biliCdnIsUnstable = (host) =>')
    const end = src.indexOf("host.endsWith('.bilivideo.com')));", start) + "host.endsWith('.bilivideo.com')));".length
    const snippet = src.slice(start, end)
    const workerCode = eval('`' + snippet + '`')   // 還原成 Worker 實際拿到的程式碼（\\. → \.）
    const fn = new Function('BILICDN_PREFERRED', workerCode + '\nreturn biliCdnIsUnstable')(T.list)
    ok([HK3, HK5, HK1].every(h => !fn(h)), 'Worker：白名單裡的香港節點不算不穩定（跟主執行緒一致）')
    ok(fn(HK2), 'Worker：沒驗證過的 01-02 仍算不穩定')
    ok(fn('cn-hbwh-cm-01-11.bilivideo.com'), 'Worker：4 碼地區的大陸 BCache 也排除（舊規則 [a-z]{2} 會漏判）')
    ok(fn('xy1x2x3x4xy.mcdn.bilivideo.cn') && !fn('upos-sz-mirroraliov.bilivideo.com'), 'Worker：MCDN 排除、一般鏡像不排除')
    // 主執行緒與 Worker 對一整組 host 的判斷完全一致
    const sample = [HK1, HK2, HK3, HK5, 'cn-hbwh-cm-01-11.bilivideo.com', 'cn-tj-cu-01-02.bilivideo.com', 'cn-jxnc-cmcc-bcache-06.bilivideo.com',
        'xy.mcdn.bilivideo.cn', 'a.szbdyd.com', 'upos-sz-mirroraliov.bilivideo.com', 'upos-sz-mirrorbos.bilivideo.com']
    const diff = sample.filter(h => fn(h) !== T.unstable(h))
    ok(diff.length === 0, '主執行緒與 Worker 對 ' + sample.length + ' 個 host 的判斷完全一致' + (diff.length ? '（不一致：' + diff.join(',') + '）' : ''))

    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
})()
