/* 窄屏（360px）布局体检：把 .gal-head 及其子控件的位置/宽度打出来，
 * 用来定位「控件被顶出屏幕」这类问题。native_mode 的 ㉑ 只给结论（在屏内/溢出多少），
 * 这个脚本给数字（每个控件 left/right/width），改 CSS 前先用它量一次。
 *
 * 用法：先起服务 node server.mjs --port=8143，再 node _test/diag_narrow.mjs
 */
import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8143'
const cdp = await Cdp.launch({ size: '1400,900' })
try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.BD2Native = {
      requestRoots() { fetch('/api/config').then(r => r.json()).then(c => {
        const roots = c.roots || []
        roots.unshift({ id: '__default__', label: 'App 目录', kind: 'file', path: '/sdcard/BD2Viewer', exists: true })
        window.__native.onRoots(roots)
      }) },
      __scanCache: [],
      requestScan(rootId, force) {
        const self = this
        fetch('/api/scan?root=bd2-mods').then(r => r.json()).then(d => {
          self.__scanCache = d.items || []
          window.__native.onScanMeta({ rootId, root: d.root, itemCount: self.__scanCache.length,
            playableCount: d.playableCount, scanMs: d.scanMs })
        })
      },
      scanPage(rootId, from, count) { return JSON.stringify((this.__scanCache || []).slice(from, from + count)) },
      scanCount() { return (this.__scanCache || []).length },
      storageStatus() { return '{}' }, toast() {}, copyText() {},
      setFullscreen() {}, setKeepScreenOn() {}, hasAllFilesAccess() { return false },
      defaultPath() { return '/sdcard/BD2Viewer' }, importFile() { return true },
      saveBlob() { return true }, deleteItems() { return '{"ok":true,"deleted":[],"failed":[]}' },
    }
  ` })
  await cdp.goto(`${BASE}/`)
  await cdp.waitFor(`document.querySelectorAll('#galGrid .card').length > 20`, 60000, 'boot')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true })
  await new Promise(r => setTimeout(r, 800))
  const out = await cdp.evaluate(`
    const head = document.querySelector('.gal-head')
    const main = document.querySelector('.gal-head-main')
    const tools = document.querySelector('.gal-head-tools')
    const r = el => { const x = el.getBoundingClientRect(); return { l: Math.round(x.left), r: Math.round(x.right), w: Math.round(x.width), t: Math.round(x.top) } }
    const btns = [...tools.children].map(c => ({ tag: c.tagName + (c.id ? '#' + c.id : ''), ...r(c) }))
    const cs = getComputedStyle(tools)
    return { vw: window.innerWidth, head: r(head), main: r(main), tools: r(tools),
             toolsInside: r(tools).right <= window.innerWidth + 1,
             btns, flexWrap: cs.flexWrap, flex: cs.flex, marginLeft: cs.marginLeft,
             galleryOverflow: getComputedStyle(document.querySelector('.gallery')).overflow,
             docScrollW: document.documentElement.scrollWidth }
  `)
  console.log(JSON.stringify(out, null, 2))
} finally {
  await cdp.close()
}
