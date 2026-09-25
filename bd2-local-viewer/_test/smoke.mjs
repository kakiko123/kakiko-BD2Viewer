/* 跨资产冒烟测试：逐个载入不同类型的 Spine 资产，检查是否成功渲染 */
import fs from 'node:fs'
import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8137'
const samples = JSON.parse(fs.readFileSync('_test/sample.json', 'utf-8'))

const cdp = await Cdp.launch({ size: '1400,900' })
const rows = []
let failed = 0

try {
  await cdp.goto(`${BASE}/`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 40000, '初始载入')

  for (const rel of samples) {
    const label = rel.length > 62 ? '…' + rel.slice(-60) : rel
    const t0 = Date.now()
    let row
    try {
      const info = await cdp.evaluate(`
        const item = __bd2viewer.state.items.find(i => i.relAtlas === ${JSON.stringify(rel)})
        if (!item) return { missing: true }
        __bd2viewer.selectItem(item)
        // 等这一套资产真正装载完成（current 已切换 + 不在读取中 + 有动画）
        const deadline = Date.now() + 30000
        while (Date.now() < deadline) {
          const st = __bd2viewer.state
          const err = document.getElementById('errorBox')
          if (!err.hidden) return { error: err.textContent }
          if (st.current === item && !st.busy && st.player && st.player.skeleton && st.animations.length > 0) {
            await new Promise(r => setTimeout(r, 900))
            const p = st.player
            const dbg = JSON.parse(document.getElementById('stageInner').dataset.debug)
            const cv = p.canvas
            const W = Math.min(cv.width, 800), H = Math.min(cv.height, 800)
            const t = document.createElement('canvas')
            t.width = W; t.height = H
            const c = t.getContext('2d')
            c.drawImage(cv, 0, 0, W, H)
            const d = c.getImageData(0, 0, W, H).data
            let opaque = 0, border = 0
            const R = 2
            for (let y = 0; y < H; y++) {
              for (let x = 0; x < W; x++) {
                if (d[(y * W + x) * 4 + 3] > 8) {
                  opaque++
                  if (x < R || y < R || x >= W - R || y >= H - R) border++
                }
              }
            }
            return { k: item.skeletonKind, anims: dbg.anims, slots: dbg.slots,
                     imgs: item.images.length, opaque, W, H, border,
                     cover: +(opaque / (W * H)).toFixed(4),
                     bounds: dbg.boundsSize, zoom: dbg.camZoom }
          }
          await new Promise(r => setTimeout(r, 200))
        }
        return { timeout: true, where: JSON.stringify({
          cur: __bd2viewer.state.current && __bd2viewer.state.current.relAtlas,
          busy: __bd2viewer.state.busy,
          anims: __bd2viewer.state.animations.length,
          hasSk: !!(__bd2viewer.state.player && __bd2viewer.state.player.skeleton),
        }) }
      `)
      if (info.missing) { row = { ok: false, note: '未在扫描结果里找到' } }
      else if (info.error) { row = { ok: false, note: '错误框: ' + info.error.slice(0, 90) } }
      else if (info.timeout) { row = { ok: false, note: '载入超时 ' + (info.where || '') } }
      else {
        const clipped = info.border > 40
        const ok = info.opaque > 60 && info.anims > 0 && !clipped
        row = {
          ok,
          note: `${info.k} · ${info.anims} 动画 · ${info.slots} 图层 · ${info.imgs} 图 · 占比 ${(info.cover * 100).toFixed(1)}% · 触边 ${info.border}${clipped ? ' ← 被裁切' : ''} · zoom ${info.zoom}`,
        }
      }
    } catch (err) {
      row = { ok: false, note: err.message.slice(0, 120) }
    }
    if (!row.ok) failed++
    rows.push(`${row.ok ? 'PASS' : 'FAIL'}  ${label}\n        ${row.note}   [${Date.now() - t0}ms]`)
  }
} finally {
  console.log(rows.join('\n'))
  console.log(`\n${failed === 0 ? '✅ 全部载入成功' : '❌ 失败 ' + failed + ' / ' + samples.length}`)
  await cdp.close()
  process.exit(failed === 0 ? 0 : 1)
}
