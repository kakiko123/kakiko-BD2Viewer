import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8137'
const ITEM = 'Eclipse Story effect yuk11sh1d4/illust_special6.atlas'
const cdp = await Cdp.launch({ size: '1280,800' })
try {
  const errs = []
  cdp.onConsole = m => { if (m.type === 'error') errs.push(m.text); console.log('[console]', m.type, m.text.slice(0, 200)) }
  await cdp.goto(`${BASE}/?item=${encodeURIComponent(ITEM)}`)
  await new Promise(r => setTimeout(r, 8000))
  const st = await cdp.evaluate(`
    return { view: window.__bd2viewer?.view,
             items: __bd2viewer?.state.items.length,
             current: __bd2viewer?.state.current?.id || null,
             hasPlayer: !!__bd2viewer?.player,
             cards: document.querySelectorAll('#galGrid .card').length,
             gridDisplay: getComputedStyle(document.getElementById('gallery')).display,
             stageDisplay: getComputedStyle(document.querySelector('.stage')).display,
             err: document.getElementById('errorBox').hidden ? '' : document.getElementById('errorBox').textContent }
  `)
  console.log(JSON.stringify(st, null, 2))
  console.log('errors:', errs.slice(0, 5))
} finally {
  await cdp.close()
}
