import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8137'
const cdp = await Cdp.launch({ size: '1400,900' })
try {
  await cdp.goto(`${BASE}/`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 40000, 'init')
  const rel = '【2026.6.5 更新 】达丽安启示之梦皮肤Darian Prophetic Dream/cutscene_char004091_1/cutscene_char004091_1.atlas'
  const out = await cdp.evaluate(`
    const item = __bd2viewer.state.items.find(i => i.relAtlas === ${JSON.stringify(rel)})
    __bd2viewer.selectItem(item)
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      const st = __bd2viewer.state
      if (st.current === item && !st.busy && st.player && st.player.skeleton && st.animations.length) break
      await new Promise(r => setTimeout(r, 200))
    }
    const p = __bd2viewer.player
    const sk = p.skeleton
    const res = { anims: st => st }
    const anims = p.animationState.data.skeletonData.animations.map(a => ({ n: a.name, d: a.duration }))
    // 逐动画测可见性
    const report = []
    for (const a of anims) {
      p.animationState.setAnimation(0, a.n, false)
      p.animationState.update(0)
      p.animationState.apply(sk)
      sk.updateWorldTransform()
      // 统计 slot 有效 alpha 与顶点范围
      let vis = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9
      for (const slot of sk.drawOrder) {
        if (!(slot.color.a > 0)) continue
        const att = slot.getAttachment && slot.getAttachment()
        if (!att || typeof att.computeWorldVertices !== 'function') continue
        const n = att.worldVerticesLength || 0
        if (!n) continue
        vis++
        const v = new Float32Array(n)
        try { att.computeWorldVertices(slot, 0, n, v, 0, 2) } catch { continue }
        for (let i = 0; i < v.length; i += 2) {
          if (v[i] < minX) minX = v[i]; if (v[i] > maxX) maxX = v[i]
          if (v[i+1] < minY) minY = v[i+1]; if (v[i+1] > maxY) maxY = v[i+1]
        }
      }
      report.push({ anim: a.n, duration: a.d, visibleSlots: vis,
        bbox: vis ? [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)] : null })
    }
    const dbg = JSON.parse(document.getElementById('stageInner').dataset.debug)
    return { anims: anims.map(a => a.n), report, dbg }
  `)
  console.log(JSON.stringify(out, null, 1))
} finally { await cdp.close() }
