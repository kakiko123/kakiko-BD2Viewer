/* 验证 **真正会打进 APK 的那份 app.bundle.html** 首屏就是资产页。
 *
 * 为什么单独写这一个：native_mode.mjs 打的是 `${BASE}/`（即 index.html + 外链 app.js），
 * 而 APK 的 WebView 加载的是 assets/web/app.bundle.html（CSS/JS 已内联）。
 * 内联过程会重排 <head> 和 <body>，谁也不能保证 index.html 上那个
 * `<body class="view-grid">` 的「首屏钉子」一定还在 —— 而那正是用户报的
 * 「每次进软件都先从播放页闪一下再跳资产页」的修复点。
 *
 * 假桥直接从 native_mode.mjs 里抠出来，避免两份 FAKE_BRIDGE 各自漂移。
 */
import { Cdp } from './cdp.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NM = path.join(HERE, 'native_mode.mjs')
const src = readFileSync(NM, 'utf8')
const m = src.match(/const FAKE_BRIDGE = `([\s\S]*?)`\n/)
if (!m) { console.log('FAIL  没能从 native_mode.mjs 里抠出 FAKE_BRIDGE'); process.exit(1) }
const FAKE_BRIDGE = m[1]

const BASE = 'http://127.0.0.1:8137'
const TARGET = `${BASE}/app.bundle.html`
let failed = 0
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  →  ' + d : ''}`); if (!ok) failed++ }

const PROBE = `
(function () {
  var P = window.__firstPaint = { first: null, stageAtFirst: null, timeline: [] }
  function snap () {
    if (!document.body) return
    var cls = document.body.className || ''
    var st = document.querySelector('.stage')
    var d = st ? getComputedStyle(st).display : null
    if (P.first === null) { P.first = cls; P.stageAtFirst = d }
    var last = P.timeline[P.timeline.length - 1]
    if (!last || last.cls !== cls) {
      P.timeline.push({ t: Math.round(performance.now()), cls: cls, stage: d })
    }
  }
  function start () {
    if (!document.body) { setTimeout(start, 0); return }
    snap()
    new MutationObserver(snap).observe(document.documentElement,
      { subtree: true, attributes: true, attributeFilter: ['class'] })
  }
  setTimeout(start, 0)
})()
`

const cdp = await Cdp.launch({ size: '1400,900' })
try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BRIDGE })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })

  // 先确认这份 bundle 确实是「单文件」——没有任何 <link rel=stylesheet> / <script src>
  // （bundle.mjs 自报的「残留外链」是 1/1，那两条是 favicon / manifest 之类的良性外链，
  //  这里用 DOM 实测，而不是只看它的自报数字。）
  await cdp.goto(TARGET)
  await cdp.waitFor(`window.__bd2viewer && __bd2viewer.state.items.length > 0`, 60000, 'bundle boot')

  const external = await cdp.evaluate(`
    return {
      css: [...document.querySelectorAll('link[rel=stylesheet]')].map(e => e.getAttribute('href')),
      js: [...document.querySelectorAll('script[src]')].map(e => e.getAttribute('src')),
    }
  `)
  check('bundle 里没有外链样式表（CSS 已内联）', external.css.length === 0, JSON.stringify(external.css))
  check('bundle 里没有外链脚本（JS 已内联）', external.js.length === 0, JSON.stringify(external.js))

  const fp = await cdp.evaluate('return window.__firstPaint', 20000)
  const tl = (fp.timeline || []).map(x => x.cls)
  check('首屏第一帧就是资产页（.stage 是 none，不是 flex）',
    typeof fp.first === 'string' && fp.first.indexOf('view-grid') >= 0 && fp.stageAtFirst === 'none',
    `首帧类名=「${fp.first}」 .stage=${fp.stageAtFirst}`)
  check('整个启动过程里 view-grid 一次都没缺席（不存在播放页→资产页跳变）',
    tl.length > 0 && tl.every(c => c.indexOf('view-grid') >= 0),
    `时间线=${JSON.stringify(fp.timeline || [])}`)

  const st = await cdp.evaluate(`
    const stage = document.querySelector('.stage')
    return { view: __bd2viewer.view,
             stageShown: getComputedStyle(stage).display !== 'none',
             cards: document.querySelectorAll('#galGrid .card').length }
  `)
  check('落定后也确实停在资产页', st.view === 'grid' && st.stageShown === false && st.cards > 50,
    `view=${st.view} 卡片=${st.cards}`)

  // 深链 (?item=) 应该直接进播放页 —— 修首屏的时候不能把深链搞坏
  await cdp.goto(`${BASE}/app.bundle.html?item=${encodeURIComponent('Eclipse Story effect yuk11sh1d4/illust_special6.atlas')}`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 60000, 'deep link')
  const dl = await cdp.evaluate('return { view: __bd2viewer.view }')
  check('带 ?item= 深链时仍然直接进播放页（没被首屏钉子锁在资产页）', dl.view === 'player', `view=${dl.view}`)

  const err = await cdp.consoleErrors()
  check('全程没有弹出错误横幅', err === null, String(err))
} finally {
  await cdp.close()
}

console.log(failed === 0 ? '\n✅ 全部通过（bundle 首屏 7 项）' : `\n❌ 失败 ${failed} 项`)
process.exit(failed ? 1 : 0)
