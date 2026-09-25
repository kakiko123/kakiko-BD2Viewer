import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8137'
const cdp = await Cdp.launch({ size: '1400,900' })
try {
  await cdp.goto(`${BASE}/`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 40000, '初始载入')

  const dump = async (tag) => {
    const s = await cdp.evaluate(`
      const st = __bd2viewer.state
      return {
        tag: ${JSON.stringify(tag)},
        current: st.current ? st.current.relAtlas : null,
        hasPlayer: !!st.player,
        hasSkeleton: !!(st.player && st.player.skeleton),
        disposed: st.player ? !!st.player.disposed : null,
        errorFlag: st.player ? !!st.player.error : null,
        anims: st.animations.length,
        busy: st.busy,
        spinnerHidden: document.getElementById('spinner').hidden,
        errorBox: document.getElementById('errorBox').hidden ? null : document.getElementById('errorBox').textContent,
        debug: document.getElementById('stageInner').dataset.debug || null,
      }
    `)
    console.log(tag, JSON.stringify(s, null, 1))
    return s
  }

  await dump('after-boot')

  const rel = '【2026.6.5 更新 】ut登录 mod/specialillust181.atlas'
  const r = await cdp.evaluate(`
    const st = __bd2viewer.state
    const item = st.items.find(i => i.relAtlas === ${JSON.stringify(rel)})
    if (!item) return 'not-found'
    __bd2viewer.selectItem(item)
    return 'selected'
  `)
  console.log('select ->', r)
  await new Promise(res => setTimeout(res, 3000))
  await dump('after-3s')

  // 再等一会
  await new Promise(res => setTimeout(res, 6000))
  await dump('after-9s')

  // 检查网络与 GL
  const extra = await cdp.evaluate(`
    const st = __bd2viewer.state
    const p = st.player
    const out = { ok: true }
    try {
      out.canvas = p && p.canvas ? [p.canvas.width, p.canvas.height, p.canvas.clientWidth, p.canvas.clientHeight] : null
      out.assetErrors = p && p.assetManager ? Object.keys(p.assetManager.errors || {}) : null
      out.isLoading = p && p.assetManager ? p.assetManager.isLoadingComplete() : null
    } catch (e) { out.ok = false; out.err = e.message }
    return out
  `)
  console.log('extra', JSON.stringify(extra, null, 1))
} finally {
  await cdp.close()
}
