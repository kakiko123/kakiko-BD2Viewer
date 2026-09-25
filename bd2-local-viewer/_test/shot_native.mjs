/* 以「原生/触屏」布局给平铺页、双击放大、隐藏 UI 截图（走 mock BD2Native，同 APK 代码路径） */
import { Cdp } from './cdp.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = 'http://127.0.0.1:8143'

const FAKE_BRIDGE = `
window.__saved = null
window.__toasts = []
window.__imported = []
window.__EXT = true
window.BD2Native = {
  requestRoots() {
    fetch('/api/config').then(function (r) { return r.json() })
      .then(function (c) {
        var roots = c.roots || []
        roots.unshift({ id: '__default__', label: 'BD2Viewer（App 目录）', kind: 'file',
                       path: '/sdcard/Android/data/com.kkk.bd2viewer/files/BD2Viewer', exists: true })
        if (window.__EXT) {
          roots.unshift({ id: '__public__', label: '手机存储 /BD2Viewer', kind: 'file',
                         path: '/sdcard/BD2Viewer', exists: true })
        }
        window.__native.onRoots(roots)
      })
      .catch(function (e) { window.__native.onError('roots: ' + e.message) })
  },
  __scanCache: [],
  requestScan(rootId, force) {
    var self = this
    var real = String(rootId).startsWith('__') ? 'bd2-mods' : rootId
    fetch('/api/scan?root=' + encodeURIComponent(real) + (force ? '&refresh=1' : ''))
      .then(function (r) { return r.json() })
      .then(function (d) {
        self.__scanCache = d.items || []
        window.__native.onScanMeta({ rootId: rootId, root: d.root,
          itemCount: self.__scanCache.length, playableCount: d.playableCount, scanMs: d.scanMs })
      })
      .catch(function (e) { window.__native.onError('scan: ' + e.message) })
  },
  scanPage(rootId, from, count) { return JSON.stringify((this.__scanCache || []).slice(from, from + count)) },
  scanCount(rootId) { return (this.__scanCache || []).length },
  defaultPath() { return '/sdcard/BD2Viewer' },
  importFile(rel, base64) { window.__imported.push({ rel: rel, bytes: Math.round(base64.length * 3 / 4) }); return true },
  storageStatus() {
    return JSON.stringify({ defaultDir: '/sdcard/BD2Viewer', defaultExists: true, defaultIsPublic: true,
      appDir: '/sdcard/Android/data/com.kkk.bd2viewer/files/BD2Viewer', publicPath: '/sdcard/BD2Viewer',
      publicOk: true, publicReason: '', allFilesAccess: true, sdk: 35, rootCount: 2 })
  },
  copyText(t) { window.__copied = t; this.toast('已复制：' + t) },
  requestAllFilesAccess() {},
  pickFolder() { window.__pickCalled = true; window.__native.onRoots([]) },
  hasAllFilesAccess() { return false },
  saveBlob(name, base64) { window.__saved = { name: name, chars: base64.length }; return true },
  toast(msg) { window.__toasts.push(msg) },
  setKeepScreenOn() {},
  setFullscreen(on) { window.__fsOn = on },
}
`

const cdp = await Cdp.launch({ size: '520,940' })
try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BRIDGE })
  // Chrome 无头模式窗口最小 500px，真机宽度要靠设备指标覆盖
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 412, height: 915, deviceScaleFactor: 2, mobile: true })
  await cdp.goto(`${BASE}/`)
  await cdp.waitFor(`document.querySelectorAll('#galGrid .card').length > 20`, 60000, 'native grid boot')

  // ① 平铺卡片墙：等几张缩略图渲出来
  await cdp.evaluate(`
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (document.querySelectorAll('#galGrid .card-thumb img').length >= 8) break
      await new Promise(r => setTimeout(r, 500))
    }
    return 1
  `, 70000)
  await new Promise(r => setTimeout(r, 700))
  await cdp.screenshot(path.join(HERE, 'shot_grid_phone.png'))
  console.log('① 平铺', JSON.stringify(await cdp.evaluate(`
    const g = document.getElementById('galGrid')
    const c = g.querySelector('.card'); const b = c.getBoundingClientRect()
    const head = document.querySelector('.gal-head')
    const tools = document.querySelector('.gal-head-tools')
    return { view: __bd2viewer.view, cards: g.querySelectorAll('.card').length,
             cardH: Math.round(b.height),
             thumbH: Math.round(c.querySelector('.card-thumb').getBoundingClientRect().height),
             cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
             overflowX: document.documentElement.scrollWidth - window.innerWidth,
             thumbs: g.querySelectorAll('.card-thumb img').length,
             status: document.getElementById('galThumb').textContent,
             headRows: new Set([...head.children].map(x => Math.round(x.getBoundingClientRect().top))).size,
             toolsRight: Math.round(tools.getBoundingClientRect().right),
             vw: window.innerWidth,
             sort: __bd2viewer.sort }`)))

  // ①b 排序：名称（升序）/ 名称降序 / 日期（新的在前）——顺带截给用户看
  const sortShot = async (label, file, script) => {
    await cdp.evaluate(`${script}
      await new Promise(r => setTimeout(r, 400))
      return 1`)
    await cdp.screenshot(path.join(HERE, file))
    console.log(`①b ${label}`, JSON.stringify(await cdp.evaluate(`
      const v = __bd2viewer
      const first3 = [...document.querySelectorAll('#galGrid .card-name')].slice(0, 3).map(e => e.textContent)
      return { mode: v.sort.mode, dir: v.sort.dir, first3,
               pill: document.getElementById('galSort').style.getPropertyValue('--i').trim(),
               dirGlyph: document.getElementById('galSortDir').textContent,
               hint: document.getElementById('galHint').textContent }`)))
  }
  await sortShot('按名称', 'shot_sort_name.png',
    `document.querySelector('#galSort .gs-btn[data-mode="name"]').click()`)
  await sortShot('名称降序', 'shot_sort_name_desc.png',
    `document.getElementById('galSortDir').click()`)
  await sortShot('按日期', 'shot_sort_date.png',
    `document.querySelector('#galSort .gs-btn[data-mode="date"]').click()`)

  // ①c 拖动中的定格：卡片抬起跟手、网格里留虚线空位（这是这次重写的核心画面）
  const dragShot = await cdp.evaluate(`
    document.querySelector('#galSort .gs-btn[data-mode="manual"]').click()
    await new Promise(r => setTimeout(r, 400))
    const grid = document.getElementById('galGrid')
    const cards = [...grid.querySelectorAll('.card')]
    const src = cards[1]
    const handle = src.querySelector('.card-drag')
    const hr = handle.getBoundingClientRect()
    const dst = cards[4].getBoundingClientRect()
    const ev = (type, x, y) => handle.dispatchEvent(new PointerEvent(type,
      { clientX: x, clientY: y, bubbles: true, pointerId: 5, isPrimary: true }))
    ev('pointerdown', hr.left + 12, hr.top + 12)
    ev('pointermove', dst.left + dst.width * 0.7, dst.top + dst.height * 0.7)
    await new Promise(r => requestAnimationFrame(r))
    return { ph: grid.querySelectorAll('.card-ph').length,
             floating: grid.querySelectorAll('.card.dragging').length,
             lifted: src.style.transform }
  `)
  await new Promise(r => setTimeout(r, 350))
  await cdp.screenshot(path.join(HERE, 'shot_drag_lifted.png'))
  console.log('①c 拖动中', JSON.stringify(dragShot))
  await cdp.evaluate(`
    const grid = document.getElementById('galGrid')
    const src = grid.querySelector('.card.dragging')
    const r = src.getBoundingClientRect()
    src.dispatchEvent(new PointerEvent('pointerup',
      { clientX: r.left + 12, clientY: r.top + 12, bubbles: true, pointerId: 5, isPrimary: true }))
    await new Promise(x => setTimeout(x, 600))
    return 1`)
  console.log('①d 松手后', JSON.stringify(await cdp.evaluate(`
    return { ...__bd2viewer.dragStats, orderLen: __bd2viewer.order.length }`)))

  // ①e 回到第一张，恢复「名称」排序，方便 ② 用
  await cdp.evaluate(`
    document.querySelector('#galSort .gs-btn[data-mode="name"]').click()
    await new Promise(r => setTimeout(r, 300))
    return 1`)

  // ② 打开第一个资产 → 全屏 → 双击定点放大
  await cdp.evaluate(`document.querySelector('#galGrid .card').click(); return 1`)
  await cdp.waitFor(`__bd2viewer.view === 'player' && !!__bd2viewer.player`, 60000, 'player')
  await new Promise(r => setTimeout(r, 1500))
  await cdp.evaluate(`__bd2viewer.setFullscreen(true); return 1`)
  await new Promise(r => setTimeout(r, 1200))
  const before = await cdp.evaluate(`return __bd2viewer.zoomRatio`)
  await cdp.screenshot(path.join(HERE, 'shot_fs_fit.png'))
  await cdp.evaluate(`__bd2viewer.doubleTapZoom(206, 430); return 1`)
  await new Promise(r => setTimeout(r, 900))
  const after = await cdp.evaluate(`return __bd2viewer.zoomRatio`)
  await cdp.screenshot(path.join(HERE, 'shot_zoom.png'))
  console.log('② 双击放大', JSON.stringify({ before, after }))

  // ③ 隐藏 UI
  await cdp.evaluate(`__bd2viewer.setCleanUI(true); return 1`)
  await new Promise(r => setTimeout(r, 700))
  await cdp.screenshot(path.join(HERE, 'shot_clean.png'))
  console.log('③ 隐藏 UI', JSON.stringify(await cdp.evaluate(`
    return { cleanUI: __bd2viewer.cleanUI,
             fsbar: getComputedStyle(document.getElementById('fsBar')).display }`)))
} finally {
  await cdp.close()
}
