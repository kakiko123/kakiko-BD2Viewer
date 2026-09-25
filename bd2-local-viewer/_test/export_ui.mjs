/* 干净复验：完全走 UI 按钮路径导出 WebM / 帧 ZIP / PNG 截图 */
import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8137'
const ITEM = 'Eclipse Story effect yuk11sh1d4/illust_special6.atlas'
const results = []
let failed = 0
const check = (n, ok, d = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  →  ' + d : ''}`); if (!ok) failed++ }

const cdp = await Cdp.launch({ size: '1400,900' })
try {
  await cdp.goto(`${BASE}/?item=${encodeURIComponent(ITEM)}`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 60000, 'init')
  await new Promise(r => setTimeout(r, 1500))

  // 统一安装下载拦截器：捕获 blob / dataURL + 文件名
  const installTap = `
    window.__dl = []; window.__blobs = []
    const _cou = URL.createObjectURL
    URL.createObjectURL = function (b) {
      try { if (b && b.size !== undefined) { window.__blobs.push(b); window.__dl.push({ size: b.size, type: b.type || '', via: 'blob' }) } } catch (e) {}
      return _cou.call(this, b)
    }
    const _click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      const last = window.__dl[window.__dl.length - 1]
      if (this.download) {
        if (last && !last.name) { last.name = this.download }
        else if (!this.href.startsWith('blob:')) {
          // dataURL 路径（旧实现）：按 base64 长度估算体积
          const comma = this.href.indexOf(',')
          const b64 = comma >= 0 ? this.href.length - comma - 1 : 0
          window.__dl.push({ size: Math.round(b64 * 3 / 4), type: this.href.slice(5, this.href.indexOf(';')),
                             via: 'dataurl', name: this.download })
        }
      }
      this.__dlHref = this.href
      return _click.call(this)    }
    true
  `
  await cdp.evaluate(installTap)

  const animInfo = await cdp.evaluate(`
    const st = __bd2viewer.state
    const e = st.player.animationState.getCurrent(0)
    return { running: e.animation.name, duration: +e.animation.duration.toFixed(2),
             animCount: st.animations.length, slotCount: st.slots.length,
             skins: st.animationState ? undefined : undefined }
  `)
  console.log('当前状态:', JSON.stringify(animInfo))

  // ---------- ① WebM（UI 按钮） ----------
  await cdp.evaluate(`window.__dl = []; window.__blobs = []; document.getElementById('btnExportWebm').click(); return true`)
  const webm = await cdp.evaluate(`
    const deadline = Date.now() + 60000
    while (Date.now() < deadline && !window.__dl.length) await new Promise(r => setTimeout(r, 250))
    const note = document.getElementById('exportNote')
    while (Date.now() < deadline && !note.hidden) await new Promise(r => setTimeout(r, 250))
    return { items: window.__dl,
             lastWebm: __bd2viewer.state.lastWebm,
             err: document.getElementById('errorBox').hidden ? null : document.getElementById('errorBox').textContent,
             busy: __bd2viewer.state.busy }
  `, 70000)
  const w = webm.items[0] || {}
  check('① WebM 导出（点按钮）产出视频', !webm.err && w.size > 20000,
    webm.err ? '异常: ' + webm.err
             : `${(w.size / 1024).toFixed(0)} KB  ${w.type}  ${w.name || ''}` +
               `  |  lastWebm=${JSON.stringify(webm.lastWebm)}  items=${JSON.stringify(webm.items)}`)
  check('① 导出后 busy 归位、提示关闭', webm.busy === false, `busy=${webm.busy}`)

  // 把导出的 WebM 回解码，验证：时长对得上、画面非空、背景色真的烘进去了
  const decoded = await cdp.evaluate(`
    const blob = window.__blobs.find(b => (b.type || '').startsWith('video'))
    if (!blob) return { err: '没捕获到 video blob', all: window.__blobs.map(b => ({ t: b.type, s: b.size })) }
    if (!blob.size) return { err: 'video blob 为 0 字节', lastWebm: __bd2viewer.state.lastWebm }
    const v = document.createElement('video')
    v.muted = true
    v.src = URL.createObjectURL(blob)
    await new Promise((res, rej) => {
      v.onloadeddata = res
      v.onerror = () => rej(new Error('视频解码失败'))
      setTimeout(() => rej(new Error('解码超时')), 15000)
    })
    // 找到 metadata 后取时长
    if (!v.videoWidth) {
      await new Promise(res => { v.onloadedmetadata = res; setTimeout(res, 3000) })
    }
    await new Promise(res => { v.onseeked = res; v.currentTime = Math.min(0.5, (v.duration || 1) / 2); setTimeout(res, 4000) })
    const c = document.createElement('canvas')
    c.width = v.videoWidth; c.height = v.videoHeight
    c.getContext('2d').drawImage(v, 0, 0)
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    // 角落像素（背景）与整幅非空比例
    const corner = [d[0], d[1], d[2], d[3]]
    let nonBlack = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 12 || d[i+1] > 12 || d[i+2] > 12) nonBlack++
    const bg = __bd2viewer.state.bgColor
    URL.revokeObjectURL(v.src)
    return { duration: +(v.duration || 0).toFixed(2), w: v.videoWidth, h: v.videoHeight,
             corner, nonBlackRatio: +(nonBlack / (c.width * c.height)).toFixed(4), bgColor: bg,
             lastWebm: __bd2viewer.state.lastWebm }
  `, 40000)
  const expectedBg = { r: parseInt((decoded.bgColor || '#000000ff').slice(1, 3), 16),
                       g: parseInt((decoded.bgColor || '#000000ff').slice(3, 5), 16),
                       b: parseInt((decoded.bgColor || '#000000ff').slice(5, 7), 16) }
  if (decoded.err) {
    check('① 视频可解码且有画面', false,
      `${decoded.err}  |  lastWebm=${JSON.stringify(decoded.lastWebm)}  blobs=${JSON.stringify(decoded.all)}`)
  } else {
    const cornerMatch = Math.abs(decoded.corner[0] - expectedBg.r) < 12 &&
                        Math.abs(decoded.corner[1] - expectedBg.g) < 12 &&
                        Math.abs(decoded.corner[2] - expectedBg.b) < 12
    check('① 视频可解码且有画面', decoded.duration > 1 && decoded.nonBlackRatio > 0.02,
      `时长 ${decoded.duration}s  ${decoded.w}×${decoded.h}  非空像素占比 ${decoded.nonBlackRatio}  ` +
      `帧 ${decoded.lastWebm?.frames} 跳帧 ${decoded.lastWebm?.dropped} @${decoded.lastWebm?.fps}fps chunk ${decoded.lastWebm?.chunks}`)
    check('① 视频时长与动画时长一致（无慢动作）', Math.abs(decoded.duration - animInfo.duration) < 0.45,
      `${decoded.duration}s vs 动画 ${animInfo.duration}s`)
    check('① 视频背景色与预览一致（不是黑底）', cornerMatch,
      `角落 rgb(${decoded.corner.slice(0, 3)}) vs 期望 rgb(${expectedBg.r},${expectedBg.g},${expectedBg.b})`)
  }

  // ---------- ② 帧序列 ZIP（UI 按钮） ----------
  await cdp.evaluate(`window.__dl = []; window.__blobs = []; document.getElementById('btnExportFrames').click(); return true`)
  const zip = await cdp.evaluate(`
    const deadline = Date.now() + 120000
    const note = document.getElementById('exportNote')
    while (Date.now() < deadline && (!window.__dl.length || !note.hidden)) await new Promise(r => setTimeout(r, 300))
    return { items: window.__dl,
             err: document.getElementById('errorBox').hidden ? null : document.getElementById('errorBox').textContent,
             busy: __bd2viewer.state.busy }
  `, 130000)
  const z = zip.items[0] || {}
  check('② 帧序列 ZIP 导出产出压缩包', !zip.err && z.size > 50000,
    zip.err ? '异常: ' + zip.err : `${(z.size / 1024).toFixed(0)} KB  ${z.name || ''}`)

  // 解开 ZIP：帧数应等于 时长×帧率，且首帧是有效非空 PNG
  const zipInfo = await cdp.evaluate(`
    const blob = window.__blobs.find(b => (b.type || '').includes('zip'))
    if (!blob) return { err: '没捕获到 zip blob', all: window.__blobs.map(b => ({ t: b.type, s: b.size })) }
    const z = await JSZip.loadAsync(blob)
    const names = Object.keys(z.files).filter(n => n.endsWith('.png')).sort()
    const first = await z.file(names[0]).async('blob')
    const bmp = await createImageBitmap(first)
    const c = document.createElement('canvas')
    c.width = bmp.width; c.height = bmp.height
    c.getContext('2d').drawImage(bmp, 0, 0)
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let opaque = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++
    return { frameCount: names.length, first: names[0], firstBytes: first.size,
             w: bmp.width, h: bmp.height, cover: +(opaque / (c.width * c.height)).toFixed(4) }
  `, 60000)
  const expectFrames = Math.round(animInfo.duration * 60)
  if (zipInfo.err) {
    check('② ZIP 帧数 = 时长 × 帧率', false, `${zipInfo.err} ${JSON.stringify(zipInfo.all || {})}`)
    check('② 首帧 PNG 有效且非空白', false, zipInfo.err)
  } else {
    check('② ZIP 帧数 = 时长 × 帧率', zipInfo.frameCount === expectFrames,
      `${zipInfo.frameCount} 帧（期望 ${expectFrames}）`)
    check('② 首帧 PNG 有效且非空白', zipInfo.cover > 0.02,
      `${zipInfo.first} ${zipInfo.w}×${zipInfo.h} ${(zipInfo.firstBytes / 1024).toFixed(0)} KB 覆盖 ${zipInfo.cover}`)
  }

  // ---------- ③ PNG 截图（透明 / 2K） ----------
  await cdp.evaluate(`window.__dl = []; document.getElementById('btnShot').click(); return true`)
  const png = await cdp.evaluate(`
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !window.__dl.length) await new Promise(r => setTimeout(r, 200))
    return { items: window.__dl, err: document.getElementById('errorBox').hidden ? null : document.getElementById('errorBox').textContent }
  `, 25000)
  const p = png.items[0] || {}
  check('③ PNG 截图产出图片', !png.err && p.size > 5000,
    png.err ? '异常: ' + png.err : `${(p.size / 1024).toFixed(0)} KB  ${p.type}  ${p.name || ''} (${p.via})`)

  await cdp.evaluate(`window.__dl = []; document.getElementById('btnShotBig').click(); return true`)
  const png2 = await cdp.evaluate(`
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !window.__dl.length) await new Promise(r => setTimeout(r, 200))
    return { items: window.__dl }
  `, 35000)
  const p2 = png2.items[0] || {}
  check('③ 2K 截图产出图片', p2.size > 5000, `${(p2.size / 1024).toFixed(0)} KB  ${p2.name || ''}`)

  const err = await cdp.consoleErrors()
  check('无控制台错误', !err, err || '')
} catch (e) {
  check('测试执行', false, e.message)
} finally {
  console.log('\n' + results.join('\n'))
  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 失败 ' + failed}  （共 ${results.length} 项）`)
  await cdp.close()
  process.exit(failed ? 1 : 0)
}
