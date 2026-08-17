// 改進工單 E：直接從真正要出貨的 bilibili-cdn-tw.user.js 原始碼裡，用「起始字串」到
// 「結束字串」切出一段純函式定義來測試——不是另外維護一份複製貼上的副本。這樣
// 「刻意把邏輯改壞一行」時測試一定會抓到，也不會有測試跟正式程式碼漂移的問題。
// 找不到起訖字串就直接丟錯，逼你在改動原始碼形狀的同時更新這裡的 marker。
const fs = require('fs')
const path = require('path')

const SRC_PATH = path.join(__dirname, '..', 'bilibili-cdn-tw.user.js')
// 原始檔是 CRLF；正規化成 LF 純粹是為了讓下面的 marker 字串好寫好比對，
// 不影響抽出程式碼的實際語意（JS 對行尾字元不敏感）。
const source = fs.readFileSync(SRC_PATH, 'utf8').replace(/\r\n/g, '\n')

function slice(startMarker, endMarker) {
    const start = source.indexOf(startMarker)
    if (start === -1) throw new Error('extractPure: 找不到起始字串，原始碼可能已改動：\n' + startMarker)
    const end = source.indexOf(endMarker, start + startMarker.length)
    if (end === -1) throw new Error('extractPure: 找不到結束字串，原始碼可能已改動：\n' + endMarker)
    return source.slice(start, end)
}

// code: 從 .user.js 抽出、串接起來的原始碼片段（可能是多個函式）。
// exportNames: 這段程式碼裡要匯出給測試用的頂層識別字名稱。
function buildModule(code, exportNames) {
    const wrapped = code + '\nmodule.exports = { ' + exportNames.join(', ') + ' };'
    const fn = new Function('module', wrapped)
    const mod = { exports: {} }
    fn(mod)
    return mod.exports
}

module.exports = { slice, buildModule, source }
