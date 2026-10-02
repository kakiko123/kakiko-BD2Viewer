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

  /* 三套 Spine 运行时（1.05 起加 4.2）：NIKKE=4.0、BD2/LS=4.1、JCZX=4.2。
     跨 minor 不能互读。IIFE 默认都写全局 spine，所以 4.0→spine40、4.2→spine42。
     拦两类静默事故：① 升级后忘改全局名顶掉 4.1 ② bundle 内联清单漏某套 */
  {
    const p40 = new URL('../public/lib/spine-player-4.0.js', import.meta.url)
    const p42 = new URL('../public/lib/spine-player-4.2.js', import.meta.url)
    let lib40 = '', lib42 = ''
    try { lib40 = readFileSync(p40, 'utf8') } catch { /* 缺失时下面会判 FAIL */ }
    try { lib42 = readFileSync(p42, 'utf8') } catch { /* 缺失时下面会判 FAIL */ }
    check('存在第二套运行时 lib/spine-player-4.0.js', lib40.length > 0)
    check('存在第三套运行时 lib/spine-player-4.2.js', lib42.length > 0)
    check('4.0 运行时把结果写到全局 spine40（不能叫 spine，否则覆盖 4.1）',
      /var spine40 = \(\(\) => \{/.test(lib40) && !/var spine = \(\(\) => \{/.test(lib40))
    check('4.2 运行时把结果写到全局 spine42（不能叫 spine，否则覆盖 4.1）',
      /var spine42 = \(\(\) => \{/.test(lib42) && !/var spine = \(\(\) => \{/.test(lib42))
    // 4.1 才有 Sequence，4.0 完全没有 —— 用它反证两份文件确实是不同的世代
    check('4.0 与 4.1 确实是不同世代（Sequence 只在 4.1 里）',
      (lib40.match(/Sequence/g) || []).length === 0 &&
      (readFileSync(new URL('../public/lib/spine-player.js', import.meta.url), 'utf8')
        .match(/Sequence/g) || []).length > 0)

    const bundle = readFileSync(new URL('../public/app.bundle.html', import.meta.url), 'utf8')
    check('产物里内联了三套运行时（spine + spine40 + spine42）',
      bundle.includes('var spine = (() => {') &&
      bundle.includes('var spine40 = (() => {') &&
      bundle.includes('var spine42 = (() => {'))
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

  // 关掉「缩略图写回资产目录」（需求 5）：它会把 thumb.png 写进**用户的**资产目录，
  // 测试不该改用户的磁盘（2026-10-02 实测本机被写了 124 个）。
  await cdp.evaluate(`__bd2viewer.setThumbPersist(false); return __bd2viewer.thumbPersist`)

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

  /* 两套运行时都真的活在页面上，而且是两个不同对象；顺带验一次骨架版本探测
     在真实 4.1 骨架上不会误判（真判错的代价是整个 BD2 库渲染全崩）。 */
  const rt = await cdp.evaluate(`
    const v = window.__bd2viewer
    const it = v.state.items.find(i => i.skeletonKind === 'skel')
    return {
      has40: !!window.spine40,
      has41: !!window.spine,
      has42: !!window.spine42,
      has40Player: !!(window.spine40 && window.spine40.SpinePlayer),
      has42Player: !!(window.spine42 && window.spine42.SpinePlayer),
      distinct: !!(window.spine40 && window.spine && window.spine42) &&
        window.spine40.SpinePlayer !== window.spine.SpinePlayer &&
        window.spine42.SpinePlayer !== window.spine.SpinePlayer &&
        window.spine42.SpinePlayer !== window.spine40.SpinePlayer,
      minor: it ? await v.spineMinorOf(it) : null,
      rel: it ? it.relSkeleton : null,
    }
  `)
  check('三套运行时都已加载（spine / spine40 / spine42）', rt.has40 && rt.has41 && rt.has42,
    `40=${rt.has40} 41=${rt.has41} 42=${rt.has42}`)
  check('三套运行时是不同的构造器（没互相顶掉）', rt.distinct && rt.has40Player && rt.has42Player)
  check('骨架版本探测：真实 4.1 骨架判成 4.1（不误判成 4.0）',
    rt.minor === '4.1', `${rt.rel} → ${rt.minor}`)

  /* Spine 3.x JSON → 4.x 的兼容转换（纯函数，喂合成数据即可）。
     为什么值得单测：JCZX 缓存里 131/135 个带骨架的资产是 3.8 JSON，而 4.x 运行时
     读不出来的字段**不报错、只变 NaN**，症状是「骨架能载入、动画列表正常、但取景
     抛 Animation bounds are invalid」——没有这条断言就只能靠肉眼看着像不像。 */
  const cv = await cdp.evaluate(`
    const f = window.__bd2viewer.spineJson38to41
    if (typeof f !== 'function') return { missing: true }
    const src = {
      skeleton: { spine: '3.8.99' },
      bones: [{ name: 'b' }],
      slots: [{ name: 's' }],
      animations: {
        idle: {
          bones: {
            b: {
              rotate: [{ angle: 10, curve: 0.25, c3: 0.75 }, { time: 1, angle: 20 }],
              translate: [{ x: 1, y: 2, curve: 0.3, c2: 0.4 }, { time: 1, x: 3, y: 4 }],
            },
          },
          slots: { s: { color: [{ color: 'ffffff00' }] } },
          transform: { t: [{ time: 0, rotateMix: 0 }] },
          deform: { default: { s: [{ time: 0, vertices: [] }] } },
        },
      },
    }
    const out = f(JSON.stringify(src))
    const j = JSON.parse(out)
    const a = j.animations.idle
    const rot = a.bones.b.rotate
    const tr = a.bones.b.translate
    return {
      keptVersion: j.skeleton.spine,
      rotValue: rot[0].value,
      rotAngleGone: rot[0].angle === undefined,
      rotCurve: rot[0].curve,
      rotSecondNoCurve: rot[1].curve === undefined,
      trCurveLen: Array.isArray(tr[0].curve) ? tr[0].curve.length : -1,
      trCurveHalvesSame: Array.isArray(tr[0].curve) && tr[0].curve.length === 8 &&
        JSON.stringify(tr[0].curve.slice(0, 4)) === JSON.stringify(tr[0].curve.slice(4)),
      rgbaExists: !!a.slots.s.rgba, colorGone: a.slots.s.color === undefined,
      rgbaValue: a.slots.s.rgba ? a.slots.s.rgba[0].color : null,
      transformGone: a.transform === undefined,
      deformGone: a.deform === undefined,
      compactLeft: 'c2' in rot[0] || 'c3' in rot[0] || 'c4' in rot[0],
      not38: f(JSON.stringify({ skeleton: { spine: '4.1.20' }, animations: {} })),
      junk: f('{ not json'),
    }
  `)
  check('3.8 JSON 转换：旋转时间轴 angle → value，且不再残留 angle',
    cv.rotValue === 10 && cv.rotAngleGone === true, JSON.stringify(cv.rotCurve))
  check('3.8 JSON 转换：1 分量时间轴的紧凑曲线 → [cx1,cy1,cx2,cy2]（ease-in-out 缺省规则）',
    JSON.stringify(cv.rotCurve) === JSON.stringify([0.25, 0.25, 0.75, 0.75]),
    JSON.stringify(cv.rotCurve))
  check('3.8 JSON 转换：2 分量时间轴要 8 个数（4.x 的 curve 按分量分槽）',
    cv.trCurveLen === 8 && cv.trCurveHalvesSame === true, `len=${cv.trCurveLen}`)
  check('3.8 JSON 转换：插槽颜色时间轴 color → rgba（值原样搬）',
    cv.rgbaExists === true && cv.colorGone === true && cv.rgbaValue === 'ffffff00')
  check('3.8 JSON 转换：transform / deform 整段删掉（4.x 读法不同，硬搬更歪）',
    cv.transformGone === true && cv.deformGone === true)
  check('3.8 JSON 转换：不残留紧凑系数键（c2/c3/c4）', cv.compactLeft === false)
  check('3.8 JSON 转换：非 3.x 骨架与坏 JSON 都返回 null（调用方保持原样）',
    cv.not38 === null && cv.junk === null)

  check('桌面模式下 isNative=false', info.isNative === false, `isNative=${info.isNative}`)
  check('资产列表非空', info.items > 0, `${info.items} 个`)
  check('动画已载入', info.anims > 0, `${info.anims} 个动画`)
  check('载入遮罩已撤掉（脚本跑到了最后）', info.bootGone)
  check('内联样式生效（不是裸 HTML）',
    info.styleApplied && info.styleApplied !== 'rgba(0, 0, 0, 0)', info.styleApplied)
  // 显示品牌：1.05 起界面名改为「Kakiko Viewer」（Android label 同名）。
  // 断言只守「标题是产品名、不是空/默认」——品牌名改了就改这里一处。
  check('标题正确', /Kakiko Viewer/.test(info.title || ''), info.title)

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
