/* 端到端功能验证：载入 / 动画 / 皮肤 / 图层 / 相机 / 截图 / 导出 */
import { Cdp } from './cdp.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 用脚本自身位置定位输出目录，避免依赖调用时的 cwd（Bash shim 有时会丢工作目录）
const HERE = path.dirname(fileURLToPath(import.meta.url))

const BASE = 'http://127.0.0.1:8137'
const ITEM = 'Eclipse Story effect yuk11sh1d4/illust_special6.atlas'
const results = []
let failed = 0

function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  →  ' + detail : ''}`)
  if (!ok) failed++
  return ok
}

const cdp = await Cdp.launch({ size: '1680,950' })

try {
  await cdp.goto(`${BASE}/?item=${encodeURIComponent(ITEM)}`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 40000, '资产载入')
  await new Promise(r => setTimeout(r, 1500))

  const d0 = JSON.parse(await cdp.evaluate(`return document.getElementById('stageInner').dataset.debug`))
  check('canvas 尺寸已同步显示尺寸', d0.canvas[0] === d0.client[0] && d0.canvas[1] === d0.client[1],
    `canvas=${d0.canvas} client=${d0.client}`)
  check('相机视口匹配 canvas', d0.camViewport[0] === d0.canvas[0] && d0.camViewport[1] === d0.canvas[1],
    `viewport=${d0.camViewport}`)
  check('取景框被正确铺满（可见世界高 ≈ 取景框高）',
    Math.abs(d0.visibleWorld[1] - (d0.boundsSize[1] + 100)) < 2,
    `visibleH=${d0.visibleWorld[1]} boundsH+100=${(d0.boundsSize[1] + 100).toFixed(1)}`)
  check('动画列表已填充', d0.anims >= 2, `anims=${d0.anims}`)
  const animNames = await cdp.evaluate(`
    return [...document.querySelectorAll('#animList .list-item')].map(e => e.textContent)
  `)
  check('动画项含 idle / once', animNames.includes('idle') && animNames.includes('once'), JSON.stringify(animNames))

  const counts = await cdp.evaluate(`
    return {
      assets: document.querySelectorAll('.asset-item').length,
      slots: __bd2viewer.state.slots.length,
      skins: __bd2viewer.state.skins.length,
      layers: document.querySelectorAll('#layerList .layer-row').length,
    }
  `)
  check('资产列表非空', counts.assets > 100, `assets=${counts.assets}`)
  check('图层列表已渲染', counts.layers === counts.slots && counts.slots > 50,
    `layers=${counts.layers} slots=${counts.slots}`)
  check('皮肤已列出', counts.skins >= 1, `skins=${counts.skins}`)

  // ---- 是否真的渲染出了东西（非纯背景）
  const px = await cdp.evaluate(`
    const cv = __bd2viewer.player.canvas
    const t = document.createElement('canvas')
    t.width = 200; t.height = 200
    const c = t.getContext('2d')
    c.drawImage(cv, 0, 0, 200, 200)
    const d = c.getImageData(0, 0, 200, 200).data
    let opaque = 0, minA = 255
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 8) opaque++; if (d[i] < minA) minA = d[i] }
    return { opaque, total: d.length / 4, minA }
  `)
  check('画布已渲染出像素（存在不透明内容）', px.opaque > 200, JSON.stringify(px))
  check('画布背景是透明的（alpha=0 区域存在）', px.minA === 0, `minAlpha=${px.minA}`)

  // ---- 切换动画
  await cdp.evaluate(`
    const items = [...document.querySelectorAll('#animList .list-item')]
    const t = items.find(e => e.textContent === 'once') || items[1]
    t.click(); return true
  `)
  await new Promise(r => setTimeout(r, 800))
  const animNow = await cdp.evaluate(`return __bd2viewer.state.player.animationState.getCurrent(0).animation.name`)
  check('点击动画列表可切换动画', animNow === 'once', `当前=${animNow}`)

  // ---- 暂停 / 播放
  await cdp.evaluate(`document.getElementById('btnPlay').click(); return true`)
  await new Promise(r => setTimeout(r, 300))
  const paused = await cdp.evaluate(`return __bd2viewer.player.paused`)
  check('暂停按钮生效', paused === true, `paused=${paused}`)
  await cdp.evaluate(`document.getElementById('btnPlay').click(); return true`)
  await new Promise(r => setTimeout(r, 300))
  check('播放按钮生效', (await cdp.evaluate(`return __bd2viewer.player.paused`)) === false)

  // ---- 速度
  await cdp.evaluate(`
    const s = document.getElementById('speedRange')
    s.value = '0.5'; s.dispatchEvent(new Event('input'))
    return true
  `)
  await new Promise(r => setTimeout(r, 300))
  const sp = await cdp.evaluate(`return __bd2viewer.player.speed`)
  check('速度滑块生效', Math.abs(sp - 0.5) < 1e-6, `speed=${sp}`)

  // ---- 图层隐藏 / 恢复
  const layerTest = await cdp.evaluate(`
    const rows = [...document.querySelectorAll('#layerList .layer-row')]
    const target = rows.find(r => r.querySelector('.name').textContent.includes('bang'))
    const name = target.querySelector('.name').textContent
    target.querySelector('input').click()
    return { name }
  `)
  await new Promise(r => setTimeout(r, 500))
  const hiddenInfo = await cdp.evaluate(`
    const row = [...document.querySelectorAll('#layerList .layer-row')]
      .find(r => r.querySelector('.name').textContent === ${JSON.stringify(layerTest.name)})
    const sk = __bd2viewer.player.skeleton
    const slot = sk.slots.find(s => s.data.name === ${JSON.stringify(layerTest.name)})
    return { uiHidden: row.classList.contains('hidden-layer'), alpha: slot.color.a }
  `)
  check('取消勾选可隐藏图层（UI + 实际 alpha=0）',
    hiddenInfo.uiHidden === true && hiddenInfo.alpha === 0, JSON.stringify(hiddenInfo))

  const slotName = layerTest.name
  await cdp.evaluate(`
    __bd2viewer.state.layerSelect = true
    __bd2viewer.state.selectedLayer = ${JSON.stringify(slotName)}
    document.getElementById('btnShowAll').click(); return true
  `)
  await new Promise(r => setTimeout(r, 500))
  const restored = await cdp.evaluate(`
    const sk = __bd2viewer.player.skeleton
    const slot = sk.slots.find(s => s.data.name === ${JSON.stringify(slotName)})
    return { alpha: slot.color.a, hiddenUi: document.querySelectorAll('#layerList .hidden-layer').length }
  `)
  check('「全部显示」恢复图层 alpha', restored.alpha > 0 || restored.hiddenUi === 0, JSON.stringify(restored))

  // ---- 缩放 / 重置视图
  const zoom0 = await cdp.evaluate(`return __bd2viewer.state.camera.zoom`)
  await cdp.evaluate(`__bd2viewer.zoomIn(); return true`)
  await new Promise(r => setTimeout(r, 200))
  const zoom1 = await cdp.evaluate(`return __bd2viewer.state.camera.zoom`)
  check('放大有效（zoom 变小 = 视野变小）', zoom1 < zoom0, `${zoom0.toFixed(3)} → ${zoom1.toFixed(3)}`)
  await cdp.evaluate(`__bd2viewer.zoomOut(); __bd2viewer.zoomOut(); __bd2viewer.resetCamera(); return true`)
  await new Promise(r => setTimeout(r, 200))
  const zoom2 = await cdp.evaluate(`return __bd2viewer.state.camera.zoom`)
  check('重置视图回到默认 zoom', Math.abs(zoom2 - zoom0) < 1e-6, `zoom=${zoom2.toFixed(3)}`)

  // ---- 缩放范围限制
  const clampTest = await cdp.evaluate(`
    __bd2viewer.state.camera.zoom = __bd2viewer.state.defaultZoom * 1000
    __bd2viewer.zoomOut()
    return __bd2viewer.state.camera.zoom
  `)
  check('zoom 有上限保护', clampTest <= (await cdp.evaluate(`return __bd2viewer.state.defaultZoom * 4`)) + 1e-6,
    `zoom=${clampTest.toFixed(3)}`)
  await cdp.evaluate(`__bd2viewer.resetCamera(); return true`)

  // ---- 截图管线（拦截下载。screenshot 是异步的，要等锚点真的被点）
  const shot = await cdp.evaluate(`
    const cap = []
    let blobs = []
    const _cou = URL.createObjectURL
    URL.createObjectURL = function (b) { blobs.push(b); return _cou.call(this, b) }
    const orig = HTMLAnchorElement.prototype.click
    let fire
    const done = new Promise(r => fire = r)
    HTMLAnchorElement.prototype.click = function () { cap.push({ href: this.href, name: this.download }); fire() }
    __bd2viewer.screenshot(true, 512)
    await done
    HTMLAnchorElement.prototype.click = orig
    URL.createObjectURL = _cou
    const s = cap[0]
    const b = blobs[0]
    return s ? { name: s.name, isPng: !!b && (b.type || '').startsWith('image/png'),
                 bytes: b ? b.size : 0, href: s.href.slice(0, 24) } : null
  `)
  check('截图生成 PNG', !!shot && shot.isPng && shot.bytes > 2000,
    shot ? `${shot.name} · ${(shot.bytes / 1024).toFixed(0)} KB ${shot.href}…` : 'null')

  const shotBig = await cdp.evaluate(`
    const cap = []
    let blobs = []
    const _cou = URL.createObjectURL
    URL.createObjectURL = function (b) { blobs.push(b); return _cou.call(this, b) }
    const orig = HTMLAnchorElement.prototype.click
    let fire
    const done = new Promise(r => fire = r)
    HTMLAnchorElement.prototype.click = function () { cap.push({ href: this.href, name: this.download }); fire() }
    __bd2viewer.screenshot(false, 1024)
    await done
    HTMLAnchorElement.prototype.click = orig
    URL.createObjectURL = _cou
    const b = blobs[0]
    return cap[0] ? { name: cap[0].name, bytes: b ? b.size : 0 } : null
  `)
  check('非透明截图生成 PNG', !!shotBig && shotBig.bytes > 2000,
    shotBig ? `${shotBig.name} · ${(shotBig.bytes / 1024).toFixed(0)} KB` : 'null')
  check('截图后画布尺寸已还原',
    await cdp.evaluate(`
      const cv = __bd2viewer.player.canvas
      return cv.width === cv.clientWidth && cv.height === cv.clientHeight
    `))

  // ---- 帧序列导出（ZIP）
  await cdp.evaluate(`
    __bd2viewer.state.fps = 12
    __bd2viewer.state.maxSize = 512
    return true
  `)
  const zip = await cdp.evaluate(`
    let blob = null
    const orig = URL.createObjectURL
    URL.createObjectURL = function (b) { blob = b; return orig.call(this, b) }
    await __bd2viewer.exportFrames(true)
    URL.createObjectURL = orig
    return blob ? { size: blob.size, type: blob.type } : null
  `)
  check('帧序列导出产出 ZIP blob', !!zip && zip.size > 1000, zip ? `${(zip.size / 1024).toFixed(0)} KB ${zip.type}` : 'null')

  const err = await cdp.consoleErrors()
  check('过程中没有出现错误提示', !err, err || '')

  await cdp.screenshot(path.join(HERE, 'e2e.png'))
} catch (err) {
  check('测试脚本执行', false, err.message)
} finally {
  console.log(results.join('\n'))
  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 失败 ' + failed + ' 项'}  （共 ${results.length} 项）`)
  await cdp.close()
  process.exit(failed === 0 ? 0 : 1)
}
