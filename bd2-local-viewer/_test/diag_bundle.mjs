import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8137'
const ITEM = 'Eclipse Story effect yuk11sh1d4/illust_special6.atlas'

const cdp = await Cdp.launch()
try {
  const logs = []
  cdp.onConsole = m => logs.push(`[${m.type}] ${m.text}`)

  await cdp.goto(`${BASE}/app.bundle.html?item=${encodeURIComponent(ITEM)}`)
  await new Promise(r => setTimeout(r, 6000))

  const st = await cdp.evaluate(`
    const v = window.__bd2viewer
    return {
      hasViewer: !!v,
      hasSpine: !!window.spine,
      hasJsZip: !!window.JSZip,
      items: v ? (v.state.items || []).length : -1,
      current: v && v.state.current ? v.state.current.relAtlas : null,
      hasPlayer: !!(v && v.player),
      bootEl: !!document.getElementById('__boot'),
      bootText: (document.getElementById('__boot')||{}).textContent || '',
      errBox: document.getElementById('errorBox')
        ? (document.getElementById('errorBox').hidden ? null
           : document.getElementById('errorBox').textContent) : 'no-box',
      bodyBg: getComputedStyle(document.body).backgroundColor,
      scripts: document.querySelectorAll('script').length,
      styles: document.querySelectorAll('style').length,
      docLen: document.documentElement.outerHTML.length,
    }
  `)
  console.log('页面状态:', JSON.stringify(st, null, 2))
  console.log('\n控制台输出:')
  for (const l of logs.slice(0, 25)) console.log('  ' + l)
  if (!logs.length) console.log('  (无)')
} finally {
  await cdp.close()
}
