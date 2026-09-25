/* 压力测试：同页面连续导出 5 次 WebM，检查体积/时长是否稳定（重点抓偶发 0 字节） */
import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8137'
const ITEM = 'Eclipse Story effect yuk11sh1d4/illust_special6.atlas'
const N = 5

const cdp = await Cdp.launch({ size: '1400,900' })
try {
  await cdp.goto(`${BASE}/?item=${encodeURIComponent(ITEM)}`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 60000, 'init')
  await new Promise(r => setTimeout(r, 1200))

  await cdp.evaluate(`
    window.__dl = []; window.__blobs = []
    const _cou = URL.createObjectURL
    URL.createObjectURL = function (b) {
      try { if (b && b.size !== undefined) { window.__blobs.push(b); window.__dl.push({ size: b.size, type: b.type || '' }) } } catch (e) {}
      return _cou.call(this, b)
    }
    const _click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { const l = window.__dl[window.__dl.length - 1]; if (l && !l.name) l.name = this.download }
      return _click.call(this)
    }
    true
  `)

  const rows = []
  for (let i = 1; i <= N; i++) {
    const r = await cdp.evaluate(`
      window.__dl = []; window.__blobs = []
      document.getElementById('btnExportWebm').click()
      const deadline = Date.now() + 35000
      const note = document.getElementById('exportNote')
      while (Date.now() < deadline && (!window.__dl.length || !note.hidden)) await new Promise(r => setTimeout(r, 200))
      const blob = window.__blobs.find(b => (b.type || '').startsWith('video'))
      let duration = 0, w = 0, h = 0, cornerOk = null
      if (blob && blob.size) {
        const v = document.createElement('video'); v.muted = true
        v.src = URL.createObjectURL(blob)
        try {
          await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('decode')); setTimeout(res, 8000) })
          await new Promise(res => { v.onseeked = res; v.currentTime = (v.duration || 1) / 2; setTimeout(res, 3000) })
          const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight
          const cx = c.getContext('2d'); cx.drawImage(v, 0, 0)
          const d = cx.getImageData(0, 0, 4, 4).data
          const bg = __bd2viewer.state.bgColor
          cornerOk = Math.abs(d[0] - parseInt(bg.slice(1,3),16)) < 14 &&
                     Math.abs(d[1] - parseInt(bg.slice(3,5),16)) < 14 &&
                     Math.abs(d[2] - parseInt(bg.slice(5,7),16)) < 14
          duration = +(v.duration || 0).toFixed(2); w = v.videoWidth; h = v.videoHeight
        } catch (e) { duration = -1 }
        URL.revokeObjectURL(v.src)
      }
      return { bytes: blob ? blob.size : 0, duration, w, h, cornerOk, last: __bd2viewer.state.lastWebm,
               err: document.getElementById('errorBox').hidden ? null : document.getElementById('errorBox').textContent }
    `, 45000)
    rows.push(r)
    console.log(`第 ${i} 次: ${(r.bytes / 1024).toFixed(0).padStart(5)} KB  ${String(r.duration).padStart(5)}s  ` +
      `${r.w}×${r.h}  背景OK=${r.cornerOk}  chunk=${r.last?.chunks} 跳帧=${r.last?.dropped}` +
      (r.err ? `  ⚠ ${r.err}` : ''))
  }

  const bad = rows.filter(r => r.bytes < 20000 || r.duration <= 1)
  const times = rows.map(r => r.duration).filter(d => d > 0)
  console.log(`\n成功 ${rows.length - bad.length}/${rows.length}  时长区间 ${Math.min(...times)}–${Math.max(...times)}s  ` +
    `体积区间 ${(Math.min(...rows.map(r => r.bytes)) / 1024).toFixed(0)}–${(Math.max(...rows.map(r => r.bytes)) / 1024).toFixed(0)} KB`)
  console.log(bad.length === 0 ? '✅ 5/5 稳定' : `❌ 有 ${bad.length} 次异常`)
} finally { await cdp.close() }
