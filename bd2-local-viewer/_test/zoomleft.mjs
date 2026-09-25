import { Cdp } from './cdp.mjs'
const BASE = 'http://127.0.0.1:8137'
const cdp = await Cdp.launch({ size: '1680,950' })
try {
  await cdp.goto(`${BASE}/?item=${encodeURIComponent('Eclipse Story effect yuk11sh1d4/illust_special6.atlas')}`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 40000, 'init')
  await new Promise(r => setTimeout(r, 1500))
  // 左上侧栏底部区域放大 4 倍
  const r1 = await cdp.send('Page.captureScreenshot', {
    format: 'png', clip: { x: 150, y: 520, width: 200, height: 80, scale: 4 },
  })
  const fs = await import('node:fs')
  fs.writeFileSync('_test/zoom_leftbottom.png', Buffer.from(r1.data, 'base64'))

  // 顺便把该区域的 DOM 里可见文字列出来
  const info = await cdp.evaluate(`
    const out = []
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        if (r.top > 500 && r.top < 640 && r.left < 350) {
          const t = (el.childElementCount === 0 ? el.textContent : '').trim()
          if (t) out.push({ tag: el.tagName, id: el.id, cls: el.className, text: t.slice(0, 50),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            color: cs.color })
        }
      }
    }
    walk(document.body)
    return out
  `)
  console.log(JSON.stringify(info, null, 1))
} finally { await cdp.close() }
