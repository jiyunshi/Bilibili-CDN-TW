// 執行方式（不需要安裝任何套件）：node --test tests/run.test.js
// 每個 *.test-case.js 都是獨立的 Node 程式：把 bilibili-cdn-tw.user.js 載進 vm 沙箱（見 harness.js），
// 印出 PASS/FAIL，有任何 FAIL 就以非 0 結束。這裡逐一執行並檢查結束碼。
// 選路模擬器 sim.js 跑一次要幾分鐘，不在這裡執行：node tests/sim.js [user.js] [標籤]
const { test } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const cases = fs.readdirSync(__dirname).filter(f => f.endsWith('.test-case.js')).sort()
for (const f of cases) {
    test(f, () => {
        const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 120000 })
        const out = (r.stdout || '') + (r.stderr || '')
        assert.strictEqual(r.status, 0, out)
        assert.match(out, /\d+ passed, 0 failed|^PASS /m, out)
    })
}
