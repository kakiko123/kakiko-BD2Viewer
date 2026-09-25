import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8137'
const picks = [
  ['01-target-illust_special6', 'Eclipse Story effect yuk11sh1d4/illust_special6.atlas'],
  ['02-skel-standing-char004091', '【2026.6.5 更新 】达丽安启示之梦皮肤Darian Prophetic Dream/char004091/char004091.atlas'],
  ['03-skel-cutscene-fixed', '【2026.6.5 更新 】达丽安启示之梦皮肤Darian Prophetic Dream/cutscene_char004091_1/cutscene_char004091_1.atlas'],
  ['04-dating-11pages', '帕莱特奇迹紫罗兰Palette Miracle Violet/帕莱特奇迹紫罗兰Palette Miracle Violet/illust_dating17/illust_dating17.atlas'],
  ['05-json-40anim', '【2026.9.5更新 内服预览】Aquila_Savage_Warrior_standing_yuk11sh1d4/Aquila_Savage_Warrior_standing_yuk11sh1d4/char067901.atlas'],
  ['06-skillcut-multipage', '【2026.5.21更新 内附预览】Mamonir Miracle Marine skillcut yuk11sh1d4 v1/Mamonir Miracle Marine skillcut yuk11sh1d4 v1/cutscene_char067803.atlas'],
]

const cdp = await Cdp.launch({ size: '1680,950' })
try {
  await cdp.goto(`${BASE}/`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 40000, 'init')
  for (const [name, rel] of picks) {
    const info = await cdp.evaluate(`
      const item = __bd2viewer.state.items.find(i => i.relAtlas === ${JSON.stringify(rel)})
      if (!item) return { err: 'not found' }
      __bd2viewer.selectItem(item)
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const st = __bd2viewer.state
        if (st.current === item && !st.busy && st.anims !== 0 && st.player && st.player.skeleton && st.animations.length) {
          await new Promise(r => setTimeout(r, 1200))
          const d = JSON.parse(document.getElementById('stageInner').dataset.debug)
          return { anims: d.anims, slots: d.slots, zoom: d.camZoom, bounds: d.boundsSize }
        }
        await new Promise(r => setTimeout(r, 200))
      }
      return { err: 'timeout' }
    `)
    await cdp.screenshot(`_test/pick_${name}.png`)
    console.log(name, JSON.stringify(info))
  }
} finally { await cdp.close() }
