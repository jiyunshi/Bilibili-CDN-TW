// 改進工單 E：涵蓋《BiliCDN_TW_改進工單.md》第 E 項列出的必測案例。
// 所有受測函式都是直接從 bilibili-cdn-tw.user.js 原始碼抽取（見 extractPure.js），
// 確保測的是真正要出貨的程式碼。
import { describe, it, expect } from 'vitest'
import { slice, buildModule } from './extractPure.js'

describe('isPlayUrlApi', () => {
    const { isPlayUrlApi, PLAYURL_PREFIXES } = buildModule(
        slice('const PLAYURL_PREFIXES = [', '\n\n// ── CDN 候選清單'),
        ['isPlayUrlApi', 'PLAYURL_PREFIXES']
    )

    it('10 個 PLAYURL_PREFIXES 各一個真實網址都回 true', () => {
        expect(PLAYURL_PREFIXES.length).toBe(10)
        PLAYURL_PREFIXES.forEach((prefix) => {
            expect(isPlayUrlApi(prefix + '?bvid=BV1xx411c7mD&cid=123&qn=120')).toBe(true)
        })
    })

    it('非 playurl 的 api.bilibili.com 網址回 false', () => {
        expect(isPlayUrlApi('https://api.bilibili.com/x/web-interface/view')).toBe(false)
    })

    it('空字串／null／畸形網址回 false，不拋錯', () => {
        expect(isPlayUrlApi('')).toBe(false)
        expect(isPlayUrlApi(null)).toBe(false)
        expect(isPlayUrlApi(undefined)).toBe(false)
        expect(() => isPlayUrlApi('not a url')).not.toThrow()
        expect(isPlayUrlApi('not a url')).toBe(false)
    })

    it('api.bilibili.com 底下其他 /player/ 路徑但含 playurl 字樣也算（wbi 變體）', () => {
        expect(isPlayUrlApi('https://api.bilibili.com/x/player/wbi/playurl?x=1')).toBe(true)
    })
})

describe('isValidCustomCdnHost', () => {
    const { isValidCustomCdnHost } = buildModule(
        slice('const isValidCustomCdnHost = (host) => {', '\n\nconst PREFERRED_CDN_LIST = PREFERRED_CDN_LIST_RAW'),
        ['isValidCustomCdnHost']
    )

    it('合法的 bilivideo 鏡像站網域回 true', () => {
        expect(isValidCustomCdnHost('upos-sz-mirrorali.bilivideo.com')).toBe(true)
        expect(isValidCustomCdnHost('upos-sz-mirrorcos.bilivideo.cn')).toBe(true)
    })

    it('完全不相關的網域回 false', () => {
        expect(isValidCustomCdnHost('evil.com')).toBe(false)
    })

    it('［資安關鍵案例］bilivideo.com.evil.com 這種偽裝子網域必須回 false', () => {
        expect(isValidCustomCdnHost('bilivideo.com.evil.com')).toBe(false)
    })

    it('非字串／空值不拋錯，回 false', () => {
        expect(isValidCustomCdnHost('')).toBe(false)
        expect(isValidCustomCdnHost(null)).toBe(false)
        expect(isValidCustomCdnHost(undefined)).toBe(false)
        expect(isValidCustomCdnHost(123)).toBe(false)
    })
})

describe('matchesExclude', () => {
    // matchesExclude 讀取模組層級的 ExcludeHostKeywords（可被 BiliCDN.exclude()/.include() 動態調整），
    // 在測試環境用一顆假的 let 變數注入，跟真正程式碼裡「可被使用者面板改變」的語意一致。
    const code = 'let ExcludeHostKeywords = ["cosov"];\n' +
        slice('const matchesExclude = (host) => {', '\n\n// 資安：CustomCDN')
    const { matchesExclude } = buildModule(code, ['matchesExclude'])

    it('host 含排除關鍵字回 true', () => {
        expect(matchesExclude('upos-sz-mirrorcosov.bilivideo.com')).toBe(true)
    })

    it('host 不含排除關鍵字回 false', () => {
        expect(matchesExclude('upos-sz-mirrorali.bilivideo.com')).toBe(false)
    })

    it('空值回 false，不拋錯', () => {
        expect(matchesExclude('')).toBe(false)
        expect(matchesExclude(null)).toBe(false)
    })
})

describe('verGte', () => {
    const { verGte } = buildModule(
        slice('const parseVer = (v) => String(v || \'0\')', '\n\n// ── 診斷輸出'),
        ['parseVer', 'verGte']
    )

    it('1.3.0 >= 1.2.9', () => {
        expect(verGte('1.3.0', '1.2.9')).toBe(true)
    })

    it('1.3 >= 1.3.0（省略的 patch 視為 0，相等也算 gte）', () => {
        expect(verGte('1.3', '1.3.0')).toBe(true)
    })

    it('1.2.9 >= 1.3.0 應為 false', () => {
        expect(verGte('1.2.9', '1.3.0')).toBe(false)
    })

    it('undefined 不拋錯（視為 0.0.0）', () => {
        expect(() => verGte(undefined, '1.0.0')).not.toThrow()
        expect(verGte(undefined, '1.0.0')).toBe(false)
        expect(verGte(undefined, undefined)).toBe(true)
    })
})

describe('pickStreamUrls（dash/durl 改寫邏輯的純函式部分）', () => {
    const code = slice('const isAkamaiUrl = (url) => {', '\n\nconst getBiliVideoCdn = (url) => {') +
        '\n' +
        slice('const pickStreamUrls = (item, isDash) => {', '\n\n// 改寫 dash/durl item 的 base_url')
    const { pickStreamUrls } = buildModule(code, ['pickStreamUrls', 'isAkamaiUrl', 'isBiliVideoUrl'])

    it('dash 格式（base_url + baseUrl + backupUrl 陣列）正確找出 biliSrcUrl', () => {
        const item = {
            base_url: 'https://upos-sz-mirrorali.bilivideo.com/seg1.m4s',
            baseUrl: 'https://upos-sz-mirrorali.bilivideo.com/seg1.m4s',
            backupUrl: ['https://upos-sz-mirrorcos.bilivideo.com/seg1.m4s'],
            bandwidth: 2e6,
            height: 1080,
        }
        const r = pickStreamUrls(item, true)
        expect(r.biliSrcUrl).toBe('https://upos-sz-mirrorali.bilivideo.com/seg1.m4s')
        expect(r.akamaiUrl).toBeUndefined()
        expect(r.validUrls).toContain('https://upos-sz-mirrorcos.bilivideo.com/seg1.m4s')
        expect(r.highBitrateItem).toBe(false)
    })

    it('dash 格式含 Akamai 來源時正確找出 akamaiUrl', () => {
        const item = {
            base_url: 'https://xxx.akamaized.net/seg1.m4s',
            backup_url: ['https://upos-sz-mirrorali.bilivideo.com/seg1.m4s'],
        }
        const r = pickStreamUrls(item, true)
        expect(r.akamaiUrl).toBe('https://xxx.akamaized.net/seg1.m4s')
        expect(r.biliSrcUrl).toBe('https://upos-sz-mirrorali.bilivideo.com/seg1.m4s')
    })

    it('durl 格式（url + backup_url）欄位齊全，不看 base_url', () => {
        const item = {
            url: 'https://upos-sz-mirrorali.bilivideo.com/full.flv',
            backup_url: ['https://upos-sz-mirrorcos.bilivideo.com/full.flv'],
        }
        const r = pickStreamUrls(item, false)
        expect(r.biliSrcUrl).toBe('https://upos-sz-mirrorali.bilivideo.com/full.flv')
        expect(r.validUrls).toEqual([
            'https://upos-sz-mirrorali.bilivideo.com/full.flv',
            'https://upos-sz-mirrorcos.bilivideo.com/full.flv',
        ])
    })

    it('4K/高碼率 dash item 判定為 highBitrateItem，帶動白名單優先旗標', () => {
        const item = {
            base_url: 'https://upos-sz-mirrorali.bilivideo.com/seg1.m4s',
            bandwidth: 15e6,
            height: 2160,
        }
        const r = pickStreamUrls(item, true)
        expect(r.highBitrateItem).toBe(true)
        expect(r.preferWhitelistPrimary).toBeTruthy()
    })

    it('空 item 不拋錯，回傳空結果', () => {
        expect(() => pickStreamUrls(null, true)).not.toThrow()
        const r = pickStreamUrls(null, true)
        expect(r.validUrls).toEqual([])
        expect(r.akamaiUrl).toBeUndefined()
    })
})
