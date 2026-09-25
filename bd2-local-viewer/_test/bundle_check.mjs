/**
 * 验证内联后的单文件 HTML（app.bundle.html）在真实浏览器里能跑。
 * 这一步是 APK 的预演：APK 里就是把这个文件直接喂给 WebView。
 */
import { Cdp } from './cdp.mjs'
import { readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:8137'
const ITEM = 'Eclipse Story effect yuk11sh1d4/illust_special6.atlas'
let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
  ok ? pass++ : fail++
}

const cdp = await Cdp.launch()
try {
  /* 静态自检：app.js 里 $('xxx') 取的元素必须在 index.html 里真的存在。
     2026-09-23 踩过：改快捷条时删掉了 #mFit，setupMobileShell 里 $('mFit').onclick
     抛 TypeError → boot() 中断，页面一片空白，而控制台连一条 error 都没有（是
     unhandledrejection）。这类问题在浏览器测试里表现为「等待超时」，很难定位。 */
  {
    const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
    const ids = [...new Set([...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]))]
    const missing = ids.filter(id => !html.includes(`id="${id}"`))
    check('app.js 引用的元素 id 都存在于 index.html', missing.length === 0, missing.join(', '))
  }

  /* spine-player 库的 pinch 修复必须一直在：官方 Input 类有两处
     `let dy = this.touch1.x - this.touch0.x`（dy 用 x 算，复制粘贴笔误），
     导致横向双指捏合时初始距离 = √2·|dx| → 越捏大画面反而越小。
     2026-09-23 已修成 .y；换库/升级时这条断言会拦住回归。 */
  {
    const lib = readFileSync(new URL('../public/lib/spine-player.js', import.meta.url), 'utf8')
    const bad = [...lib.matchAll(/let dy = this\.touch1\.x - this\.touch0\.x/g)].length
    const good = [...lib.matchAll(/let dy = this\.touch1\.y - this\.touch0\.y/g)].length
    check('spine-player 捏合缩放 dy 笔误已修复（且无回归）', bad === 0 && good === 2,
      `bad=${bad} good=${good}`)
  }

  /* 产物级静态自检：bundle.mjs 的注入到底有没有生效。
     2026-09-25 踩过：index.html 的 <body> 加了 class 之后，bundle.mjs 里那句
     html.replace('<body>', ...) 静默失配 → 加载遮罩再也没进产物，而下面那条
     「遮罩已撤掉」的运行时断言反而**空过**（查不到遮罩当然就是撤掉了）。
     所以这里先把「产物里必须有什么」钉死，运行时那条才有意义。 */
  {
    const bundle = readFileSync(new URL('../public/app.bundle.html', import.meta.url), 'utf8')
    check('产物里注入了加载遮罩 #__boot', bundle.includes('id="__boot"'))
    // 首屏钉子必须活着进产物：内联会重排 <head>/<body>，只有打完包才知道
    check('产物的 <body> 仍带着 view-grid（首屏钉子没被内联弄丢）',
      /<body[^>]*class="[^"]*view-grid/.test(bundle))
    // 只数标记区，避免把内联 JS 里提到 "<link"/"<script src" 的说明文字算成外链
    const markupOnly = bundle
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>')
    const extLinks = (markupOnly.match(/<link[^>]*>/gi) || []).length
    const extScripts = (markupOnly.match(/<script[^>]*\ssrc=/gi) || []).length
    check('产物的标记区没有任何外链资源（CSS/JS 全部内联）',
      extLinks === 0 && extScripts === 0, `link=${extLinks} scriptSrc=${extScripts}`)
  }

  const errs = []
  cdp.onConsole = m => { if (m.type === 'error') errs.push(m.text) }

  await cdp.goto(`${BASE}/app.bundle.html?item=${encodeURIComponent(ITEM)}`)

  const ready = await cdp.waitFor(
    `!!(window.__bd2viewer && window.__bd2viewer.player` +
    ` && window.__bd2viewer.player.skeleton` +
    ` && window.__bd2viewer.state.items.length)`,
    30000)
  check('单文件 HTML 里脚本执行、资产扫描完成', ready)

  const info = await cdp.evaluate(`
    const v = window.__bd2viewer
    return {
      isNative: v.isNative,
      hasSpine: !!window.spine,
      hasJsZip: !!window.JSZip,
      items: v.state.items.length,
      anims: v.player ? v.player.skeleton.data.animations.map(a => a.name).length : 0,
      cur: v.state.current ? v.state.current.relAtlas : null,
      bootGone: !document.getElementById('__boot'),
      styleApplied: getComputedStyle(document.body).backgroundColor,
      title: document.title,
    }
  `)
  check('spine 运行时已内联可用', info.hasSpine)
  check('JSZip 已内联可用', info.hasJsZip)
  check('桌面模式下 isNative=false', info.isNative === false, `isNative=${info.isNative}`)
  check('资产列表非空', info.items > 0, `${info.items} 个`)
  check('动画已载入', info.anims > 0, `${info.anims} 个动画`)
  check('载入遮罩已撤掉（脚本跑到了最后）', info.bootGone)
  check('内联样式生效（不是裸 HTML）',
    info.styleApplied && info.styleApplied !== 'rgba(0, 0, 0, 0)', info.styleApplied)
  check('标题正确', /BD2/.test(info.title || ''), info.title)

  // 画面真的画出来了吗
  const px = await cdp.evaluate(`
    const c = window.__bd2viewer.player.canvas
    const g = c.getContext('webgl') || c.getContext('webgl2')
    const w = c.width, h = c.height
    if (!g) return { err: 'no webgl' }
    const buf = new Uint8Array(w * h * 4)
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, buf)
    let nz = 0
    for (let i = 3; i < buf.length; i += 4) if (buf[i] > 8) nz++
    return { w, h, cover: +(nz / (w * h)).toFixed(3) }
  `)
  check('画面有内容', !px.err && px.cover > 0.02,
    px.err || `${px.w}x${px.h} 覆盖 ${px.cover}`)

  // 全局错误横幅（APK 里唯一的 uncaught error 出口）：
  // 2026-09-24 实测一个坏 JSON 让它弹了满屏红条且挡住所有交互。现在必须：
  // 不拦截指针 + 自动消失（setTimeout），坏资产只影响自己不影响别的操作。
  const banner = await cdp.evaluate(`
    window.dispatchEvent(new ErrorEvent('error', { message: 'banner-check' }))
    await new Promise(r => setTimeout(r, 300))
    const b = document.getElementById('__boot')
    if (!b) return { shown: false }
    const cs = getComputedStyle(b)
    return { shown: true, pe: cs.pointerEvents, text: b.textContent }
  `)
  check('全局错误横幅仍然弹出', banner.shown === true && /banner-check/.test(banner.text || ''),
    JSON.stringify(banner).slice(0, 120))
  check('错误横幅不拦截指针（不会挡住交互）', banner.pe === 'none', `pointer-events=${banner.pe}`)

  check('无控制台错误', errs.length === 0, errs.slice(0, 3).join(' | '))
} finally {
  await cdp.close()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
