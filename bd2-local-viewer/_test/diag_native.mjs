/* 原生模式启动卡住时的取证脚本：抓控制台 + 关键状态 */
import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8137'
const FAKE_BRIDGE = `
window.__saved = null
window.__toasts = []
window.__imported = []
window.__pickCalled = false
window.BD2Native = {
  requestRoots() {
    fetch('/api/config').then(function (r) { return r.json() })
      .then(function (c) {
        var roots = c.roots || []
        roots.unshift({ id: '__default__', label: 'BD2Viewer（App 目录）', kind: 'file',
                       path: '/sdcard/Android/data/com.kkk.bd2viewer/files/BD2Viewer', exists: true })
        window.__native.onRoots(roots)
      })
      .catch(function (e) { window.__native.onError('roots: ' + e.message) })
  },
  __scanCache: [],
  requestScan(rootId, force) {
    var self = this
    var real = rootId === '__default__' ? 'bd2-mods' : rootId
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
  defaultPath() { return '/sdcard/Android/data/com.kkk.bd2viewer/files/BD2Viewer' },
  importFile(rel, base64) { window.__imported.push({ rel: rel, bytes: Math.round(base64.length * 3 / 4) }); return true },
  pickFolder() { window.__pickCalled = true; window.__native.onRoots([]) },
  requestAllFilesAccess() {},
  hasAllFilesAccess() { return false },
  saveBlob(name, base64) { window.__saved = { name: name, chars: base64.length }; return true },
  toast(msg) { window.__toasts.push(msg) },
  setKeepScreenOn() {}
}
window.__errs = []
window.addEventListener('error', function (e) { window.__errs.push('error: ' + (e.message || '') + ' @' + e.filename + ':' + e.lineno) })
window.addEventListener('unhandledrejection', function (e) { window.__errs.push('reject: ' + (e.reason && e.reason.message || e.reason)) })
`

const cdp = await Cdp.launch({ size: '1400,900' })
try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BRIDGE })
  await cdp.goto(`${BASE}/`)
  await new Promise(r => setTimeout(r, 12000))
  const st = await cdp.evaluate(`
    return {
      hasSpine: !!window.spine,
      hasViewer: !!window.__bd2viewer,
      native: window.__bd2viewer ? window.__bd2viewer.isNative : null,
      rootId: window.__bd2viewer ? window.__bd2viewer.state.rootId : null,
      rootOpts: [...document.getElementById('rootSelect').options].map(o => o.value + '|' + o.textContent),
      items: window.__bd2viewer ? window.__bd2viewer.state.items.length : null,
      assets: document.querySelectorAll('.asset-item').length,
      env: document.getElementById('envInfo').textContent,
      btnAdd: document.getElementById('btnAddRoot').textContent,
      hasImportInput: !!document.getElementById('importFiles'),
      errBox: document.getElementById('errorBox').hidden ? null : document.getElementById('errorBox').textContent,
      errs: window.__errs,
      busy: document.getElementById('spinner') ? !document.getElementById('spinner').hidden : null,
      scanCache: window.BD2Native.__scanCache.length
    }
  `)
  console.log(JSON.stringify(st, null, 2))
  const logs = await cdp.consoleErrors ? await cdp.consoleErrors() : []
  if (logs && logs.length) console.log('--- console ---\n' + logs.join('\n'))
} finally {
  await cdp.close()
}
