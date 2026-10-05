/**
 * 碧蓝航线档（al）端到端验收：卡面缩略图 + Live2D 播放速度。
 *
 *  覆盖 docs/AL-PLAYBACK.md 里那两个「还没改代码」的问题：
 *
 *  §2 缩略图是零件图
 *    · Live2D 卡面以前直接贴 `relImages[0]`（Cubism 贴图集 = 拆开的零件），
 *      现在要和正片用同一套 pixi + cubism4 渲一帧（makeLive2dThumb）。
 *    · Spine 3.8 二进制以前在 makeThumb 里直接抛「不支持的 Spine 版本」，
 *      卡片上永远是个「无法生成」占位，现在走 makeSpine38Thumb。
 *
 *  §3 Live2D 看起来像开了倍速
 *    `set autoUpdate(true)` 就是一句 `Ticker.shared.add(...)`，不去重。创建时默认 true
 *    挂 1 个，setPlaying(true) 再挂 1 个 → 一帧累加两次 deltaMS → 2 倍速。
 *
 *  ⚠ 需要真实素材。根目录从环境变量读：
 *    BD2_AL_ROOT=C:/path/to/碧蓝航线图鉴 node _test/al_mode.mjs
 *  没给（或目录不存在）→ 整段跳过并判 PASS，别把「没素材」报成回归。
 *
 *  为了让套件跑得快、且不受图鉴里另外 7.8 万个文件影响，这里**只复制一个角色的两套
 *  原皮**（一套 .skel、一套 .model3.json）到临时根，保留 `角色/<id>__<名>/皮肤N/原皮/<形态>/`
 *  的相对结构（前端 alInfoOf 就是按路径当归组信息的）。
 *
 *  自己在同一个脚本里 spawn server.mjs（BD2_CONFIG 指向临时配置），跑完 kill ——
 *  别用 shell `&` 起后台，工具一返回子进程就被杀。
 *  注意别并行开第二个 Chrome：cdp.mjs 端口写死 9333（所以要排在 native_mode 之后）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Cdp } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const NODE = process.execPath
let BASE = ''

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/* ---------------------------------------------------------- 素材：没有就跳过 */
const AL_ROOT = process.env.BD2_AL_ROOT || 'C:/Users/KAKIKO/Videos/新建文件夹'
const SKIP = !AL_ROOT || !fs.existsSync(path.join(AL_ROOT, '角色'))
if (SKIP) {
  console.log('SKIP  未设置 BD2_AL_ROOT（或目录下没有 角色/）→ 跳过碧蓝航线档验收')
  console.log('      形如：BD2_AL_ROOT=C:/path/to/碧蓝航线图鉴-20260831')
  process.exit(0)
}

/* ---------------------------------------------------------- 挑一个「两套都有」的角色 */
/** 递归找第一个同时含 .skel 和 .model3.json 的角色目录，返回这两个文件所在目录。 */
function findCharPair(root) {
  const charsDir = path.join(root, '角色')
  const names = fs.readdirSync(charsDir)
  for (const cname of names) {
    const cdir = path.join(charsDir, cname)
    if (!fs.statSync(cdir).isDirectory()) continue
    const skel = { dir: null, file: null }
    const l2d = { dir: null, file: null }
    const walk = (d, depth) => {
      if (depth > 6 || (skel.file && l2d.file)) return
      let ents = []
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        if (!e.isDirectory()) {
          const low = e.name.toLowerCase()
          if (!skel.file && low.endsWith('.skel')) { skel.dir = d; skel.file = e.name }
          if (!l2d.file && low.endsWith('.model3.json')) { l2d.dir = d; l2d.file = e.name }
          continue
        }
        walk(path.join(d, e.name), depth + 1)
      }
    }
    walk(cdir, 0)
    if (skel.file && l2d.file) return { cname, skel, l2d }
  }
  return null
}

const pair = findCharPair(AL_ROOT)
if (!pair) {
  console.log('SKIP  图鉴里没有「同一个角色既有 .skel 又有 .model3.json」的目录 → 跳过')
  process.exit(0)
}

/** 找一个「同目录里带多层骨架（`_B`/`_M`/`_T`）」的目录（R39），返回目录与层字母。
 *  判据与前端 `alLayerPartsOf` 一致：同前缀 + 后面紧跟不同层字母。找不到返回 null（§8 跳过）。
 *  ⚠️ 优先挑**非 mod 目录**（`原皮`/`base` 那种）：AL 的 mod 会被「形态 × mod 链」归组
 *  收进 `members[].mods`，可见列表里那一档本来就只剩链头，验不出「多层归一张卡」。 */
function findAlLayerGroup(root, limit = 8000) {
  const stack = [path.join(root, '角色')]
  const found = []
  let seen = 0
  while (stack.length && seen < limit && found.length < 40) {
    const d = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    seen++
    const skels = ents.filter(e => e.isFile() && /\.skel$/i.test(e.name))
      .map(e => e.name.replace(/\.skel$/i, ''))
    if (skels.length >= 2) {
      const groups = new Map()
      for (const b of skels) {
        const m = /^(.*[^BMT])([BMT])$/.exec(b)
        if (!m) continue
        if (!groups.has(m[1])) groups.set(m[1], new Map())
        groups.get(m[1]).set(m[2], b)
      }
      for (const g of groups.values()) {
        if (g.size >= 2) found.push({ dir: d, layers: [...g.keys()].sort().join('') })
      }
    }
    for (const e of ents) if (e.isDirectory()) stack.push(path.join(d, e.name))
  }
  if (!found.length) return null
  const score = f => {
    let s = f.layers.length
    if (/原皮|[\\/]base[\\/]?$/i.test(f.dir)) s += 4
    if (/[\\/](mod-|mochi-spine|mochi-live2d)/i.test(f.dir)) s -= 6
    return s
  }
  found.sort((a, b) => score(b) - score(a))
  return found[0]
}
const layerGroup = findAlLayerGroup(AL_ROOT)
/* §9 用：爱宕「三只手」那条（动作里的 PartOpacity 曲线）。整份素材在不在由下面判断。 */
const ATAGO_DIR = '角色/aidang__爱宕/皮肤2/原皮/2'
const ATAGO_ANIM = 'mail'
const atagoAbs = path.join(AL_ROOT, ATAGO_DIR.split('/').join(path.sep))
const atagoOk = fs.existsSync(path.join(atagoAbs, `${'aidang_2'}.moc3`))
/** 从动作文件里读出所有 `PartOpacity` 曲线的部件名（**独立于运行时的真值**）。 */
function partOpacityIdsOf(absDir, anim) {
  const file = path.join(absDir, 'motions', `${anim}.motion3.json`)
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const ids = []
    for (const c of (j.Curves || [])) {
      if (c && c.Target === 'PartOpacity' && c.Id && !ids.includes(c.Id)) ids.push(c.Id)
    }
    return ids
  } catch { return [] }
}
const atagoParts = atagoOk ? partOpacityIdsOf(atagoAbs, ATAGO_ANIM) : []

/* ---------------------------------------------------------- 造一个只含这两套的临时根 */
// ⚠️ 临时根必须建在仓库的 _scratch/ 下：往系统 temp（os.tmpdir()）拷几十 MB
//    会被沙箱静默杀掉（退出码 127、连一行输出都没有）—— 排查了半天才定位到。
const work = fs.mkdtempSync(path.join(REPO, '_scratch', 'al-'))
const fixture = path.join(work, 'root')
const cfg = path.join(work, 'viewer.config.json')
const relOf = (abs) => path.relative(AL_ROOT, abs).split(path.sep).join('/')
/* 夹具里那一对的相对目录：§1/§3/§4 取材要**锁定这一对**（§8/§9 还会往夹具里加别的素材，
   不锁的话「第一条 Live2D」可能就换成爱宕了，测的东西跟夹具对不上）。 */
const pairSkelRel = relOf(pair.skel.dir)
const pairL2dRel = relOf(pair.l2d.dir)
// ⚠️ 用**硬链接**而不是复制：贴图和 moc3 动辄几十 MB，复制会被沙箱按写入量直接杀掉
// （退出码 127、连一行报错都没有 —— 排查了半天）。硬链接在同一盘上零额外空间，
// 而且 Dirent.isFile() 照样为 true，服务端 walk 认得出来（jczx 的备份镜像就是这么做的）。
// 跨盘（EXDEV）时才退回复制。
const linkTree = (s, d) => {
  fs.mkdirSync(d, { recursive: true })
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const from = path.join(s, e.name)
    const to = path.join(d, e.name)
    if (e.isDirectory()) { linkTree(from, to); continue }
    try { fs.linkSync(from, to) } catch { fs.copyFileSync(from, to) }
  }
}
for (const which of ['skel', 'l2d']) {
  const src = pair[which].dir
  linkTree(src, path.join(fixture, relOf(src)))
}
// §8 用：多层骨架（B/M/T）那一档也带上（同目录三层，R40）
if (layerGroup) linkTree(layerGroup.dir, path.join(fixture, relOf(layerGroup.dir)))
// §9 用：爱宕原皮（动作里的 PartOpacity 曲线 = 手部变体只留一套）
if (atagoOk) linkTree(path.join(AL_ROOT, ATAGO_DIR.split('/').join(path.sep)), path.join(fixture, ATAGO_DIR))
console.log(`  素材：${pair.cname}`)
console.log(`    skel  ${relOf(pair.skel.dir)}  (${pair.skel.file})`)
console.log(`    live2d ${relOf(pair.l2d.dir)}  (${pair.l2d.file})`)
if (layerGroup) console.log(`    多层  ${relOf(layerGroup.dir)}  (${layerGroup.layers})`)
fs.writeFileSync(cfg, JSON.stringify({
  port: 8201,
  roots: [{ id: 'al', path: fixture, label: '碧蓝航线素材', game: 'al' }],
}, null, 2), 'utf-8')

/* ---------------------------------------------------------- 拉起服务端 */
const server = spawn(NODE, ['server.mjs'], {
  cwd: REPO,
  env: { ...process.env, BD2_CONFIG: cfg },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', d => { serverLog += d })
server.stderr.on('data', d => { serverLog += d })

const cleanup = () => { try { server.kill() } catch { /* ignore */ } }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })

async function waitServer() {
  const pDeadline = Date.now() + 20000
  while (Date.now() < pDeadline) {
    const m = /地址：(http:\/\/[^\s/]+)/.exec(serverLog)
    if (m) { BASE = m[1].replace(/\/$/, ''); break }
    await new Promise(r => setTimeout(r, 200))
  }
  if (!BASE) throw new Error('没读到服务端端口\n' + serverLog.slice(-1500))
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/scan?root=al&mode=al`)
      if (r.ok) return true
    } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error('服务端未就绪 @ ' + BASE + '\n' + serverLog.slice(-2000))
}

const cdp = await Cdp.launch({ size: '1680,950' })
try {
  console.log('\n=== 0. 服务端 ===')
  await waitServer()
  check('服务端就绪', true, BASE)

  console.log('\n=== 1. 切到 al 档并扫描 ===')
  await cdp.goto(`${BASE}/?mode=al`)
  await cdp.waitFor(`window.__bd2viewer`, 20000, '__bd2viewer 就绪')
  const scanned = await cdp.evaluate(`
    const v = window.__bd2viewer
    v.setThumbPersist(false)
    v.setAssetMode('al')
    for (let i = 0; i < 300; i++) {
      const n = document.querySelectorAll('#galGrid .card').length
      if (v.mode === 'al' && n > 0) return true
      await new Promise(r => setTimeout(r, 100))
    }
    return false
  `, 60000)
  const st = await cdp.evaluate(`
    const items = window.__bd2viewer.state.items || []
    return {
      mode: window.__bd2viewer.mode,
      cards: document.querySelectorAll('#galGrid .card').length,
      total: items.length,
      l2d: items.filter(i => i.kind === 'live2d').length,
      skel: items.filter(i => i.skeletonKind === 'skel').length,
      l2dRelThumb: (items.find(i => i.kind === 'live2d' && i.relAtlas.indexOf(${JSON.stringify(pairL2dRel)}) >= 0) || {}).relThumb,
      l2dImg0: (items.find(i => i.kind === 'live2d' && i.relAtlas.indexOf(${JSON.stringify(pairL2dRel)}) >= 0) || {}).relImages
        ? items.find(i => i.kind === 'live2d' && i.relAtlas.indexOf(${JSON.stringify(pairL2dRel)}) >= 0).relImages[0] : null,
    }
  `)
  check('切到 al 档并渲染出卡片', scanned === true && st.cards > 0, `mode=${st.mode} 卡片${st.cards}`)
  // 夹具里除了那一对（1 条 Live2D + 1 条 3.8 二进制）还挂了 §8 用的多层素材（≥2 层）——
  // 所以这里只钉「至少各有一条」，具体条数由 §8 自己验归组
  check('扫到 Live2D + Spine 3.8 二进制（多层/爱宕素材另计）', st.l2d >= 1 && st.skel >= 1,
    `live2d=${st.l2d} skel=${st.skel}（共 ${st.total} 条）`)
  // 服务端以前把 relThumb 设成第一张贴图（Cubism 贴图集），前端 builtinThumbUrl 直接贴 → 零件图
  check('Live2D 条目的 relThumb 不是第一张贴图',
    st.l2dRelThumb == null || /thumb\.png$/i.test(String(st.l2dRelThumb)),
    `relThumb=${st.l2dRelThumb} relImages[0]=${st.l2dImg0}`)

  console.log('\n=== 2. 缩略图：两条都要渲出「拼好的人」（§2）===')
  // 直接调 makeThumb（调试面已暴露），比等 IntersectionObserver 队列稳。
  // 「修好了」的判据：返回的是 data URL 且边长 = 缩略图尺寸（220），
  // 而不是贴图原尺寸（4096）也不是抛错。
  const thumbs = await cdp.evaluate(`
    const v = window.__bd2viewer
    const items = v.state.items || []
    const l2d = items.find(i => i.kind === 'live2d' && i.relAtlas.indexOf(${JSON.stringify(pairL2dRel)}) >= 0)
    const skel = items.find(i => i.skeletonKind === 'skel' && i.relAtlas.indexOf(${JSON.stringify(pairSkelRel)}) >= 0)
    const measure = (dataUrl) => new Promise((res, rej) => {
      const im = new Image()
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight })
      im.onerror = () => rej(new Error('data URL 解不出来'))
      im.src = dataUrl
    })
    const out = {}
    for (const [k, it] of [['l2d', l2d], ['skel', skel]]) {
      if (!it) { out[k] = { err: '没有这条资产' }; continue }
      try {
        const url = await v.makeThumb(it)
        const m = await measure(url)
        out[k] = { ok: true, dataUrl: url.slice(0, 24), ...m }
      } catch (e) {
        out[k] = { ok: false, err: String(e && e.message || e) }
      }
    }
    return out
  `, 120000)
  console.log('    ' + JSON.stringify(thumbs))
  for (const k of ['skel', 'l2d']) {
    const t = thumbs[k] || {}
    const label = k === 'skel' ? 'Spine 3.8 二进制' : 'Live2D (moc3)'
    check(`${label} 卡面能渲出来`, !!t.ok, t.ok ? `${t.w}×${t.h}` : (t.err || '未知'))
    if (t.ok) {
      // 220 = makeThumb 的默认尺寸。贴原图的话会是 4096 / 贴图集的大尺寸。
      check(`${label} 卡面是缩略图尺寸，不是贴图原图`, t.w === 220 && t.h > 100,
        `${t.w}×${t.h}（${t.dataUrl}…）`)
    }
  }

  console.log('\n=== 3. 网格里的 Live2D 卡面不再贴第一张贴图（§2）===')
  // 队列是异步的：等卡片上真的出现 <img>，再看它的 src 是不是 data:（离屏渲出来的）。
  // ⚠️ 只看**没有自带 thumb.png 的**那些卡片：夹具里的多层素材（§8）是从图鉴直接链过来的，
  //    它带 thumb.png（服务端认它、卡片走 /spine/ 直链）—— 那是另一条合法路径，不归这节管。
  const cardSrc = await cdp.evaluate(`
    const v = window.__bd2viewer
    const items = v.state.items || []
    const l2d = items.find(i => i.kind === 'live2d' && i.relAtlas.indexOf(${JSON.stringify(pairL2dRel)}) >= 0)
    if (!l2d) return { err: 'no-l2d' }
    for (let i = 0; i < 200; i++) {
      const c = document.querySelector('#galGrid .card .card-thumb img')
      if (c && c.getAttribute('src')) break
      await new Promise(r => setTimeout(r, 100))
    }
    const cards = [...document.querySelectorAll('#galGrid .card')]
    const imgs = []
    for (const card of cards) {
      const img = card.querySelector('.card-thumb img')
      if (!img) continue
      const it = card.__item || null
      const rel = it && it.relThumb ? String(it.relThumb) : null
      if (rel && /thumb\.png$/i.test(rel)) continue        // 自带卡面：走直链，合法
      imgs.push(img.getAttribute('src'))
    }
    const tex = (l2d.relImages || [])[0]
    return {
      imgs: imgs.map(s => String(s).slice(0, 40)),
      texRel: tex,
      anyAsset: imgs.some(s => String(s).includes('/api/') || String(s).includes('/asset/')),
      allData: imgs.length > 0 && imgs.every(s => String(s).startsWith('data:')),
    }
  `, 90000)
  console.log('    ' + JSON.stringify(cardSrc))
  check('卡片上的缩略图是离屏渲出来的 data URL', !!cardSrc.allData,
    JSON.stringify(cardSrc.imgs || cardSrc))

  console.log('\n=== 4. Live2D 播放速度：Ticker 上只能有一个监听（§3）===')
  const opened = await cdp.evaluate(`
    const v = window.__bd2viewer
    const l2d = (v.state.items || []).find(i => i.kind === 'live2d' && i.relAtlas.indexOf(${JSON.stringify(pairL2dRel)}) >= 0)
    if (!l2d) return { err: 'no-l2d' }
    v.setView('player')
    v.selectItem(l2d)
    for (let i = 0; i < 300; i++) {
      const p = v.player
      if (p && p.kind === 'live2d' && (v.animations || []).length) break
      await new Promise(r => setTimeout(r, 100))
    }
    const p = v.player
    return { kind: p && p.kind, anims: (v.animations || []).length, playing: v.state.playing }
  `, 90000)
  console.log('    ' + JSON.stringify(opened))
  check('Live2D 播放页载入成功', opened.kind === 'live2d' && opened.anims > 0,
    `kind=${opened.kind} 动画=${opened.anims}`)

  // 数监听：pixi 的 Ticker 是一条 TickerListener 链，按 context 找这个模型的那几条
  const listeners = await cdp.evaluate(`
    const v = window.__bd2viewer
    const model = v.player && v.player.model
    if (!model) return { err: 'no-model' }
    const T = window.PIXI.Ticker.shared
    const count = () => {
      let n = 0
      for (let l = T._head && T._head.next; l; l = l.next) {
        if (l.context === model) n++
      }
      return n
    }
    return { onOpen: count(), autoUpdate: model.autoUpdate }
  `, 30000)
  console.log('    自动播放中：' + JSON.stringify(listeners))
  check('自动播放时该模型在 Ticker 上只有 1 个监听', listeners.onOpen === 1,
    `${listeners.onOpen} 个（autoUpdate=${listeners.autoUpdate}）`)

  // ⚠️ 这条**必须**在下面「来回切播放」之前测：pause() 会把同 fn 同 context 的监听
  //    全部摘掉，切一次之后重复监听就没了、速度也变回正常 —— 测晚了就测不到这个 bug。
  //    （第一版就踩了这个坑：变异测试里「监听数」红了、「速度」却还是绿的。）
  console.log('\n=== 4b. 模型推进的时间 ≈ 墙钟（不是 2 倍）===')
  // elapsedTime 和 deltaTime 走同一个累加器：一帧被累加两次就会变成 2 倍。
  // 这是比「数监听」更直接的判据 —— 它测的就是用户看到的那个现象。
  const rate = await cdp.evaluate(`
    const v = window.__bd2viewer
    const model = v.player && v.player.model
    if (!model) return { err: 'no-model' }
    if (!v.state.playing) { document.getElementById('btnPlay').click() }
    // 先放两帧，别把「刚点播放那一下」算进来
    await new Promise(r => setTimeout(r, 300))
    const e0 = model.elapsedTime
    const w0 = performance.now()
    let frames = 0
    const tick = () => { frames++; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    await new Promise(r => setTimeout(r, 1500))
    const e1 = model.elapsedTime
    const w1 = performance.now()
    return { dModel: e1 - e0, dWall: w1 - w0, frames, speed: v.state.speed }
  `, 60000)
  console.log('    ' + JSON.stringify(rate))
  // ⚠️ 上界取 1.25 而不是 1.6：headless 里 rAF 被限到 ~8fps，pixi 的 Ticker 会把
  //    deltaMS 夹到 100ms，于是**正常情况实测只有 0.79x**；挂两个监听是 1.58x ——
  //    第一版把上界写成 1.6，变异测试里这条就没红（等于没锁住）。
  //    下界只用来确认模型确实在走（rAF 完全不跑时为 0），不要求精确等于 1。
  if (rate && rate.dWall > 0 && rate.frames > 5) {
    const ratio = rate.dModel / rate.dWall
    check('模型推进不超过墙钟的 1.25 倍（挂两个监听就是 ~2 倍）', ratio > 0.3 && ratio < 1.25,
      `模型走了 ${Math.round(rate.dModel)}ms / 墙钟 ${Math.round(rate.dWall)}ms = ${ratio.toFixed(2)}x` +
      `（${rate.frames} 帧，speed=${rate.speed}）`)
  } else {
    check('模型推进不超过墙钟的 1.25 倍（挂两个监听就是 ~2 倍）', false,
      '拿不到有效样本（headless 没跑 rAF？）：' + JSON.stringify(rate))
  }

  console.log('\n=== 4c. 切动作：每次都要真的换（不许被优先级静默吞掉）===')
  /* 2026-10-04 回归：`model.motion(group, index)` 不传优先级时默认 NORMAL(=2)，而
     pixi-live2d-display 的 `MotionState.reserveMotion(priority)` 在
     `currentPriority >= priority` 时**直接返回 false**（Promise 不 reject、界面上的动画名
     照换）→ 已有一个 NORMAL 的动作在播时，切动作被静默丢弃。用户症状是
     「切动画很多时候没有效果、偶尔灵一次」。
     判据用两个单调量，都不看时长：
       · `motionManager.state.currentGroup` —— 请求有没有被接住（改前 0/N，改后 N/N）
       · `motionGroups[group].length`        —— 该组动作文件**真的装上**了（惰性加载，
                                                没接住就一直是 0） */
  const sw = await cdp.evaluate(`
    const v = window.__bd2viewer
    const model = v.player && v.player.model
    if (!model) return { err: 'no-model' }
    const mm = model.internalModel.motionManager
    const names = (v.animations || []).slice(0, 8)
    const rows = []
    for (const name of names) {
      const h = name.indexOf(' #')
      const group = h > 0 ? name.slice(0, h) : name
      const index = h > 0 ? Number(name.slice(h + 2)) - 1 : 0
      v.playAnimation(name)
      // 等条件（有上限），不等时长
      const dl = Date.now() + 5000
      let cur = null, loaded = 0
      while (Date.now() < dl) {
        const st = mm.state || {}
        cur = st.currentGroup === undefined ? null : st.currentGroup
        const g = mm.motionGroups && mm.motionGroups[group]
        loaded = g ? g.length : 0
        if (cur === group && loaded > 0) break
        await new Promise(r => setTimeout(r, 100))
      }
      rows.push({ name, group, cur, loaded, uiName: v.animation })
    }
    // 画面指纹：两条明显不同的动作，画出来不该一模一样
    const app = v.player.app
    const fp = () => {
      try {
        const ex = app.renderer.extract || (app.renderer.plugins && app.renderer.plugins.extract)
        // ⚠️ **不要写 ex.pixels(model)** —— 那样渲的是「模型包围盒」那么大的一张图
        //    （Live2D 单位坐标很粗，实测 1680×950 视口下是 8285²），超过 GPU 的
        //    最大纹理尺寸后 extract 给你一张**空图**，两条不同动作的指纹就恒等了。
        //    不传参数 = 渲整个舞台 = 视口大小，才是我们要比的那张画面。
        const px = ex.pixels()
        let hh = 2166136261
        for (let i = 0; i < px.length; i += 97) { hh ^= px[i]; hh = (hh * 16777619) >>> 0 }
        return { h: hh, len: px.length }
      } catch (e) { return { err: String(e && e.message) } }
    }
    /* 再取 3 条样本，**每条都要真的切过去**，并且三张画面互不相同。
       ⚠️ 样本数必须大于「变异态下还能生效的条数」—— 实测去掉 FORCE 后只有 2/8 生效，
          所以取 3 条就必然红；取 2 条会凑巧蒙过去（第一版就是取 2 条，变异测试里这条没红）。 */
    const pics = []
    for (const n of names.slice(0, 3)) {
      const h2 = n.indexOf(' #')
      const g2 = h2 > 0 ? n.slice(0, h2) : n
      v.playAnimation(n)
      const dl2 = Date.now() + 5000
      let cur2 = null
      while (Date.now() < dl2) {
        const st = model.internalModel.motionManager.state || {}
        cur2 = st.currentGroup === undefined ? null : st.currentGroup
        if (cur2 === g2) break
        await new Promise(r => setTimeout(r, 100))
      }
      await new Promise(r => setTimeout(r, 900))
      pics.push({ name: n, cur: cur2, want: g2, fp: fp() })
    }
    return { rows, pics, names }
  `, 180000)
  if (sw && sw.rows) {
    const hit = sw.rows.filter(r => r.cur === r.group).length
    const installed = sw.rows.filter(r => r.loaded > 0).length
    for (const r of sw.rows) {
      const ok = r.cur === r.group && r.loaded > 0
      console.log(`    ${ok ? '生效' : '没生效'}  点「${r.name}」 → currentGroup=${r.cur} 该组装上 ${r.loaded} 个动作`)
    }
    check('切动作每次都被接住（currentGroup 跟着点的那条走）',
      hit === sw.rows.length && sw.rows.length >= 2,
      `${hit}/${sw.rows.length}（改之前是 0/N —— 只有一个动作在播时后续全被静默丢弃）`)
    check('每次切过去的动作文件都真的装上了（不是空组）',
      installed === sw.rows.length && sw.rows.length >= 2,
      `${installed}/${sw.rows.length}`)
    const pics = sw.pics || []
    const distinct = new Set(pics.map(x => x.fp && x.fp.h)).size
    check('三条不同动作：每条都真的切过去，且三张画面互不相同（不是名字换了画面没换）',
      pics.length === 3 && pics.every(x => x.cur === x.want) && distinct === 3,
      `切到位的 ${pics.filter(x => x.cur === x.want).length}/3 · 不同指纹 ${distinct}/3 · ` +
      pics.map(x => `${x.name}:${x.fp && x.fp.h}`).join(' | '))
  } else {
    check('切动作每次都被接住（currentGroup 跟着点的那条走）', false, JSON.stringify(sw))
    check('每次切过去的动作文件都真的装上了（不是空组）', false, '拿不到样本')
    check('三条不同动作：每条都真的切过去，且三张画面互不相同（不是名字换了画面没换）', false, '拿不到样本')
  }

  console.log('\n=== 4d. 图层：Live2D 的图层是 Cubism 部件，列表能勾选显隐 ===')
  /* 以前 `slotNames: []` 是硬编码的 → 面板永远「（暂无图层）」；`pickLayersAt()` 又要求
     `player.skeleton`（Live2D 没有），于是「图层选择」开着、点画面静默无反应。
     现在把部件接上：`_partIds` 当图层名，勾选走 `setPartOpacityByIndex`。
     判据只用单调量（不依赖具体部件名，也不拿素材内容当前提）：
       `getPartOpacityByIndex(i)` 勾选后为 0、取消后回到勾选前的值；`S.hidden` 同步。 */
  const lyr = await cdp.evaluate(`
    const v = window.__bd2viewer
    const model = v.player && v.player.model
    if (!model || v.player.kind !== 'live2d') return { err: 'not-live2d' }
    const cm = model.internalModel.coreModel
    const names = v.state.slots.slice()
    const rows = () => [...document.querySelectorAll('#layerList .layer-row')]
    const rowCount = rows().length
    if (!names.length) return { names: 0, rowCount, err: 'no-layers' }
    const pick = names[0]
    const idx = cm._partIds.indexOf(pick)
    const before = cm.getPartOpacityByIndex(idx)
    const findRow = () => rows().find(r => (r.querySelector('.name') || {}).textContent === pick)
    const r1 = findRow()
    if (!r1) return { names: names.length, rowCount, err: 'no-row' }
    const cb1 = r1.querySelector('input')
    cb1.checked = false
    cb1.dispatchEvent(new Event('change'))
    await new Promise(r => setTimeout(r, 400))
    const hiddenOp = cm.getPartOpacityByIndex(idx)
    const inHidden = v.state.hidden ? v.state.hidden.has(pick) : null
    const r2 = findRow()
    const cb2 = r2 && r2.querySelector('input')
    if (cb2) { cb2.checked = true; cb2.dispatchEvent(new Event('change')) }
    await new Promise(r => setTimeout(r, 400))
    const backOp = cm.getPartOpacityByIndex(idx)
    const stillHidden = v.state.hidden ? v.state.hidden.has(pick) : null
    return {
      names: names.length, rowCount, pick, idx,
      before, hiddenOp, backOp, inHidden, stillHidden,
      head: names.slice(0, 5),
    }
  `, 120000)
  if (lyr && lyr.names) {
    console.log(`    部件 ${lyr.names} 个 / 列表 ${lyr.rowCount} 行 · 取样「${lyr.pick}」` +
      ` 不透明度 ${lyr.before} → ${lyr.hiddenOp} → ${lyr.backOp}`)
    check('Live2D 的图层列表不再为空（部件就是图层，列表与数据同源）',
      lyr.names > 0 && lyr.rowCount === lyr.names,
      `部件 ${lyr.names} 个 · 列表 ${lyr.rowCount} 行 · 前几个：${(lyr.head || []).join('/')}`)
    check('勾选一个部件 → 它的不透明度真的被压到 0，并记进 S.hidden',
      lyr.hiddenOp === 0 && lyr.inHidden === true,
      `opacity=${lyr.hiddenOp} S.hidden.has=${lyr.inHidden}`)
    check('取消勾选 → 不透明度回到勾选前的值，S.hidden 移除（不留脏状态）',
      lyr.backOp === lyr.before && lyr.stillHidden === false,
      `opacity=${lyr.backOp}（勾选前 ${lyr.before}） S.hidden.has=${lyr.stillHidden}`)
  } else {
    check('Live2D 的图层列表不再为空（部件就是图层，列表与数据同源）', false, JSON.stringify(lyr))
    check('勾选一个部件 → 它的不透明度真的被压到 0，并记进 S.hidden', false, '拿不到样本')
    check('取消勾选 → 不透明度回到勾选前的值，S.hidden 移除（不留脏状态）', false, '拿不到样本')
  }

  console.log('\n=== 4e. Live2D 点画面选层：选中的层必须和该像素上真正画的层一致 ===')
  /* 2026-10-05：以前 Live2D 上点画面只弹一句「请在图层列表里勾选」，现在做出来了。
     判据**不用应用自己的几何**（那会和它一起错），而是拿**真实渲染**当真值：
     按渲染顺序从高到低二分地把 drawable 挪出画面，第一个「挪走就让该像素变透明」的
     就是该点最上层。三件事必须同时成立：
       ① 点选结果 == 像素真值（尤其不能选到「几何上压着、贴图却是全透明」的触摸命中区）；
       ② 几何候选集合必须**包含**真值 —— 否则是坐标链算错，而不是筛子太严（两类问题要分得开）；
       ③ 高亮框画的像素必须落在该部件「真正画出来的像素」上（框和图层位置一致）。
     变异（都必须变红，实测过）：去掉渲染确认 → ①77 个采样点红；坐标链去掉 y 翻转 → ②红；
     高亮框换成不翻 y 的变换 → ③红。 */
  const live2dPick = await cdp.evaluate(`
    const v = window.__bd2viewer
    const p = v.player
    if (!p || p.kind !== 'live2d' || !p.model) return { err: 'not-live2d' }
    const chk = document.getElementById('chkLayerSelect')
    const chkWas = chk ? chk.checked : null
    if (chk && !chk.checked) { chk.checked = true; chk.dispatchEvent(new Event('change')) }
    if (!v.state.layerSelect) return { err: '图层选择模式没打开' }
    const model = p.model, im = model.internalModel, cm = im.coreModel, core = cm._model
    const app = p.app, gl = app.renderer.gl
    const canvas = app.renderer.view, W = canvas.width, H = canvas.height
    const parts = Array.from(core.parts.ids)
    const nD = core.drawables.count
    const raw = []
    for (let d = 0; d < nD; d++) raw.push(core.drawables.vertexPositions[d])
    const wasPlaying = !!p.playing
    try { p.pause() } catch {}
    try { model.autoUpdate = false } catch {}
    app.render()

    const cRect = canvas.getBoundingClientRect()
    const readPx = (x, y) => {
      const buf = new Uint8Array(4)
      const px = Math.round((x - cRect.left) * (canvas.width / cRect.width))
      const py = Math.round((y - cRect.top) * (canvas.height / cRect.height))
      if (px < 0 || py < 0 || px >= W || py >= H) return null
      gl.readPixels(px, H - 1 - py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      return buf
    }

    /* ---- 真值：与 app 无关的一套实现（自己算几何 + 把顶点挪出画面看像素变没变）
       判据是「**最上层参与了这个像素**的 drawable」，不是「删掉它像素就透明」——
       两者在「半透明层压在不透明层上」时不是一回事：删掉那层半透明阴影，底下照旧不透明，
       但用户看见的那一层**就是**阴影层。第一版真值按「删了会透明」取，测出来 6 个点
       全是这一类假红（app 其实是对的）。 */
    const applyM = (m, x, y) => ({ x: m.a * x + m.c * y + m.tx, y: m.b * x + m.d * y + m.ty })
    const sxC = cRect.width / Math.max(app.screen.width, 1)
    const syC = cRect.height / Math.max(app.screen.height, 1)
    const clientVerts = d => {
      const src = im.getDrawableVertices(d)
      const out = new Float64Array(src.length)
      const loc = im.localTransform, wd = model.worldTransform
      for (let i = 0; i + 1 < src.length; i += 2) {
        let q = applyM(loc, src[i], src[i + 1])
        q = applyM(wd, q.x, q.y)
        out[i] = cRect.left + q.x * sxC
        out[i + 1] = cRect.top + q.y * syC
      }
      return out
    }
    const inTri = (px, py, ax, ay, bx, by, cx, cy) => {
      const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
      const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
      const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
    }
    const geoAt = (x, y) => {
      const out = []
      for (let d = 0; d < nD; d++) {
        const idx = core.drawables.indices[d]
        if (!idx || idx.length < 3) continue
        const vs = clientVerts(d)
        for (let i = 0; i + 2 < idx.length; i += 3) {
          const a = idx[i] * 2, b = idx[i + 1] * 2, e = idx[i + 2] * 2
          if (inTri(x, y, vs[a], vs[a + 1], vs[b], vs[b + 1], vs[e], vs[e + 1])) { out.push(d); break }
        }
      }
      out.sort((a, b) => core.drawables.renderOrders[b] - core.drawables.renderOrders[a])
      return out
    }
    const parked = new Uint8Array(nD)
    const savedVerts = new Map()
    /* ⚠️ 挪走再挪回来**必须按原值还**，不能靠 +1e7 / -1e7 相抵：
       raw 是 Float32Array（Core 的 WASM 堆视图），1e7 附近的 float32 间隔就是 1 —— 
       「+1e7 再 -1e7」会把坐标**吸附成整数**（0.5 个 core 单位 ≈ 10 像素），
       而真值的几何候选是同一次里按未吸附的顶点算的，两边就此对不上（第一版就踩了）。 */
    const setParked = (d, on) => {
      if (!!parked[d] === !!on) return
      const a = raw[d]
      if (on) {
        if (!savedVerts.has(d)) savedVerts.set(d, a.slice())
        for (let i = 0; i < a.length; i += 2) a[i] += 1e7
      } else {
        const sv = savedVerts.get(d)
        if (sv) { a.set(sv); savedVerts.delete(d) }
      }
      parked[d] = on ? 1 : 0
    }
    const unparkAll = () => { for (let d = 0; d < nD; d++) setParked(d, false) }
    const truthAt = (x, y) => {
      unparkAll()
      app.render()
      const base = readPx(x, y)
      if (!base || base[3] <= 8) return { kind: 'empty' }
      const cands = geoAt(x, y)
      if (!cands.length) return { kind: 'unknown' }
      for (const d of cands) {
        setParked(d, true)
        app.render()
        const a = readPx(x, y)
        setParked(d, false)
        if (a) {
          let dd = 0
          for (let i = 0; i < 4; i++) dd += Math.abs(a[i] - base[i])
          if (dd > 0) return { kind: 'drawable', d }
        }
      }
      return { kind: 'unknown' }
    }

    /* ---- 逐点对撞 ---- */
    const N = 9
    const rows = []
    for (let iy = 1; iy <= N; iy++) {
      for (let ix = 1; ix <= N; ix++) {
        const x = Math.round(cRect.left + cRect.width * ix / (N + 1))
        const y = Math.round(cRect.top + cRect.height * iy / (N + 1))
        const t = truthAt(x, y)
        unparkAll()
        app.render()                      // ⚠️ 必须还原成「什么都没改」那一帧再叫应用
        const truthPart = t.kind === 'drawable' ? parts[core.drawables.parentPartIndices[t.d]] : null
        const geo = v.live2dPartsAt(x, y).map(c => c.name)
        // 应用自己那一份像素读法（排障用：两边读到的像素值必须一致）
        const ap = v.pixiReadPixel(x, y)
        const appPx = ap ? Array.from(ap) : null
        const hits = v.pickLayersAt(x, y)
        rows.push({
          x, y, kind: t.kind, truthPart, geoTop: geo[0] || null, hits, appPx,
          geoHas: truthPart ? geo.indexOf(truthPart) >= 0 : null,
        })
      }
    }
    const painted = rows.filter(r => r.kind === 'drawable')
    const agree = painted.filter(r => r.hits[0] === r.truthPart)
    const empty = rows.filter(r => r.kind === 'empty')
    const emptyOk = empty.filter(r => r.hits.length === 0)
    const unknown = rows.filter(r => r.kind === 'unknown')
    const geoMiss = painted.filter(r => r.geoHas === false)
    const trap = painted.filter(r => r.geoTop && r.geoTop !== r.truthPart)

    /* 下钻用例需要「命中栈 >= 2」的点。9×9 网格里未必有 —— 有没有取决于暂停那一刻模型的姿态
       （实测同一份素材有的跑法有、有的没有，第一版就因为这个偶发红）。所以先用**几何候选**
       在更密的网格上找重叠点（live2dPartsAt 不渲染，很便宜），再对它们跑点选确认。 */
    let drillRows = painted.filter(r => r.hits.length >= 2)
    if (!drillRows.length) {
      /* 逐帧找重叠点：9×9 网格 + 两轮更密的错开网格。⚠️ 轮与轮之间必须让模型**真的动起来**
         （seekFraction 只改时间轴，暂停状态下 model.update 不跑、姿势不会变 —— 实测那样
         两轮扫的是同一帧，等于白扫）。所以 play → 等一会儿 → pause。 */
      const dense = []
      let scanned = 0
      const grids = [[16, 0], [22, 0.5]]
      for (let round = 0; round < 3 && !drillRows.length; round++) {
        if (round) {
          try { p.play() } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 900))
          try { p.pause() } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 150))
          app.render()
        }
        for (const [N, off] of grids) {
          for (let iy = 1; iy <= N && dense.length < 12 && scanned < 400; iy++) {
            for (let ix = 1; ix <= N && dense.length < 12 && scanned < 400; ix++) {
              const x = Math.round(cRect.left + cRect.width * (ix + off) / (N + 1))
              const y = Math.round(cRect.top + cRect.height * (iy + off) / (N + 1))
              scanned++
              if (v.live2dPartsAt(x, y).length >= 2) dense.push([x, y])
            }
          }
        }
        for (const [x, y] of dense) {
          const hits = v.pickLayersAt(x, y)
          if (hits.length >= 2) { drillRows = [{ x, y, hits }]; break }
        }
      }
    }

    /* ---- 真实手势：pointerdown/up 走一遍（不是直接调函数）---- */
    const host = document.getElementById('stageInner')
    const clickAt = (x, y) => {
      const opts = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }
      host.dispatchEvent(new PointerEvent('pointerdown', opts))
      host.dispatchEvent(new PointerEvent('pointerup', opts))
    }
    /* 高亮框要拿一个「既不被遮罩裁、也不给别人当遮罩」的部件来验：
       遮罩会把部件裁掉一块，几何框却画整个形状 —— 那种部件上「框 ⊃ 可见足迹」是正常的，
       拿它断覆盖率会误判。挑不到就退回任意一个（那时只报指标不苛求）。 */
    const maskUsers = new Set()
    for (let d = 0; d < nD; d++) {
      const ms = core.drawables.masks[d], mc = core.drawables.maskCounts[d]
      for (let i = 0; i < mc; i++) maskUsers.add(ms[i])
    }
    const partDrawables = name => {
      const pi = parts.indexOf(name), out = []
      for (let d = 0; d < nD; d++) if (core.drawables.parentPartIndices[d] === pi) out.push(d)
      return out
    }
    const partIsMaskFree = name => {
      const ds = partDrawables(name)
      if (!ds.length) return false
      for (const d of ds) if (core.drawables.maskCounts[d] > 0 || maskUsers.has(d)) return false
      return true
    }
    // 下钻用「命中栈 >= 2」的点（上面找过）；手势与高亮框优先用「最上层不被遮罩」的点
    const drillRow = drillRows[0] || null
    const pickable = painted.filter(r => r.hits.length >= 1)
    const gestureRow = pickable.find(r => partIsMaskFree(r.hits[0])) || pickable[0] || null
    v.state.selectedLayer = null
    let gesture = null
    if (gestureRow) {
      clickAt(gestureRow.x, gestureRow.y)
      const toast = document.getElementById('layerToast')
      gesture = {
        expect: gestureRow.hits[0], got: v.state.selectedLayer,
        truth: gestureRow.truthPart, maskFree: partIsMaskFree(gestureRow.hits[0]),
        toastShown: !!(toast && !toast.hidden && toast.textContent.indexOf(gestureRow.hits[0]) >= 0),
      }
    }
    let drill = null
    if (drillRow) {
      v.state.selectedLayer = null
      const seq = []
      for (let i = 0; i < Math.min(3, drillRow.hits.length); i++) { clickAt(drillRow.x, drillRow.y); seq.push(v.state.selectedLayer) }
      drill = { hits: drillRow.hits.slice(0, 4), seq }
    }

    /* ---- 高亮框：框必须落在「这个部件真正画出来的像素」上 ----
       注意判据的方向：框画的是**整个图层形状**（被上面几层盖住的部分也框），
       所以要求是「框 ⊇ 可见足迹」，不是「框 ⊆ 足迹」。位置算错（少翻一次 y / 少叠一层
       变换）时覆盖率会掉到 0，这条正是抓那个的。 */
    let overlay = null
    if (gestureRow && v.state.selectedLayer) {
      v.state.selectedLayer = gestureRow.hits[0]     // 下钻那步可能把选中改掉了，定回本行
      v.drawOverlay()
      const name = v.state.selectedLayer
      const own = partDrawables(name)
      /* 该部件的「真实足迹」= 把它那几块 drawable 直接压成透明前后，画面变化的像素。
         ⚠️ 不能只压 setPartOpacityByIndex：部件不透明度要等 Core 下一次 update() 才传导到
         drawables.opacities，而这里渲染一帧就要看结果 —— 实测那样量出来足迹恒为 0。 */
      app.render()
      const before = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, before)
      const opsArr = core.drawables.opacities
      const svOps = []
      for (const d of own) { svOps.push(opsArr[d]); opsArr[d] = 0 }
      app.render()
      const after = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, after)
      for (let i = 0; i < own.length; i++) opsArr[own[i]] = svOps[i]
      app.render()
      // 足迹像素 → client 整数格点
      const px2client = (fx, fy) => [
        Math.round(cRect.left + fx * cRect.width / canvas.width),
        Math.round(cRect.top + (canvas.height - 1 - fy) * cRect.height / canvas.height),
      ]
      const footKeys = []
      let fn = 0, fsx = 0, fsy = 0
      for (let i = 0; i < before.length; i += 4) {
        const dd = Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) +
          Math.abs(before[i + 2] - after[i + 2]) + Math.abs(before[i + 3] - after[i + 3])
        if (dd <= 0) continue
        const q = i >> 2
        const c = px2client(q % W, Math.floor(q / W))
        footKeys.push(c); fn++; fsx += c[0]; fsy += c[1]
      }
      const ov = document.getElementById('overlayCanvas')
      const octx = ov.getContext('2d')
      const img = octx.getImageData(0, 0, ov.width, ov.height)
      const dpr = window.devicePixelRatio || 1
      const hRect = document.getElementById('stageInner').getBoundingClientRect()
      const ovKeys = new Set()
      let on = 0, osx = 0, osy = 0
      for (let y = 0; y < ov.height; y++) {
        for (let x = 0; x < ov.width; x++) {
          if (img.data[(y * ov.width + x) * 4 + 3] <= 8) continue
          const cx = Math.round(hRect.left + x / dpr)
          const cy = Math.round(hRect.top + y / dpr)
          on++; osx += cx; osy += cy
          ovKeys.add(cx + ',' + cy)
        }
      }
      // 两边各膨胀 2 像素（抗锯齿/边缘差一像素不算错）
      const near = (set, cx, cy, r) => {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) if (set.has((cx + dx) + ',' + (cy + dy))) return true
        return false
      }
      let covered = 0
      for (const [cx, cy] of footKeys) if (near(ovKeys, cx, cy, 2)) covered++
      overlay = {
        part: name, overlayPx: on, footprintPx: fn, covered,
        coverRatio: fn ? Math.round(covered / fn * 1000) / 1000 : 0,
        maskFree: partIsMaskFree(name),
        centroidGap: (on && fn)
          ? Math.round(Math.hypot(osx / on - fsx / fn, osy / on - fsy / fn) * 10) / 10
          : null,
      }
    }

    /* ---- 收尾：把画面与状态还原 ---- */
    unparkAll()
    v.state.selectedLayer = null
    if (chk) { chk.checked = !!chkWas; chk.dispatchEvent(new Event('change')) }
    if (wasPlaying) { try { p.play() } catch { /* ignore */ } }
    v.drawOverlay()
    app.render()

    return {
      total: rows.length, painted: painted.length, unknown: unknown.length,
      agree: agree.length, empty: empty.length, emptyOk: emptyOk.length,
      geoMiss: geoMiss.length, geoMissSample: geoMiss.slice(0, 3),
      trap: trap.length, trapSample: trap.slice(0, 3).map(r => ({ at: [r.x, r.y], geoTop: r.geoTop, truth: r.truthPart, hits: r.hits })),
      gesture, drill, overlay,
      emptyBad: empty.filter(r => r.hits.length !== 0).slice(0, 3)
        .map(r => ({ at: [r.x, r.y], hits: r.hits, appPx: r.appPx })),
      missSample: painted.filter(r => r.hits[0] !== r.truthPart).slice(0, 4)
        .map(r => ({ at: [r.x, r.y], truth: r.truthPart, hits: r.hits.slice(0, 3), geo: r.geoTop, appPx: r.appPx })),
    }
  `, 1800000)
  fs.writeFileSync(path.join(HERE, '_live2d_pick_last.json'), JSON.stringify(live2dPick, null, 1), 'utf-8')
  if (live2dPick.err) {
    check('Live2D 点画面选层：能拿到样本', false, live2dPick.err)
  } else {
    console.log(`    采样 ${live2dPick.total} 点（有像素 ${live2dPick.painted} / 空 ${live2dPick.empty} / 真值不可判 ${live2dPick.unknown}）·` +
      ` 点选与像素一致 ${live2dPick.agree}/${live2dPick.painted} ·` +
      ` 几何候选漏真值 ${live2dPick.geoMiss} · 几何最上层≠真值 ${live2dPick.trap}`)
    check('点画面选中的层 == 该像素真正画的层（真值来自真实渲染，不看应用的几何）',
      live2dPick.painted > 0 && live2dPick.agree === live2dPick.painted,
      `${live2dPick.agree}/${live2dPick.painted}` +
      (live2dPick.missSample.length ? ' 例：' + JSON.stringify(live2dPick.missSample) : ''))
    check('几何候选集合必须包含真值（坐标链对了，剩下的才是筛子的事）',
      live2dPick.geoMiss === 0,
      `漏 ${live2dPick.geoMiss} 个` + (live2dPick.geoMissSample.length ? ' 例：' + JSON.stringify(live2dPick.geoMissSample) : ''))
    check('点空白处不选任何层（不许「点了没反应」也不许乱选）',
      live2dPick.emptyOk === live2dPick.empty,
      `${live2dPick.emptyOk}/${live2dPick.empty}` +
      (live2dPick.emptyBad && live2dPick.emptyBad.length ? ' 例：' + JSON.stringify(live2dPick.emptyBad) : ''))
    check('真实素材里确实存在「几何压着、实际没画」的层（否则上面那条是假绿）',
      live2dPick.trap > 0,
      `${live2dPick.trap} 个采样点的几何最上层不是真值，例：${JSON.stringify(live2dPick.trapSample.slice(0, 2))}`)
    const g = live2dPick.gesture
    check('真实 pointer 手势：选中的就是该点的真值层，且提示条报出层名',
      !!g && g.got === g.truth && g.got === g.expect && g.toastShown === true,
      JSON.stringify(g))
    const dr = live2dPick.drill
    check('模型上连点同一处 → 按命中栈逐层下钻（与列表那条路语义一致）',
      !!dr && dr.seq.length >= 2 && dr.seq[0] === dr.hits[0] && dr.seq[1] === dr.hits[1],
      dr ? JSON.stringify(dr) : '没有命中栈 >= 2 的采样点')
    const ov = live2dPick.overlay
    check('高亮框落在该部件真正画出来的像素上（框的位置与图层位置一致）',
      !!ov && ov.overlayPx > 0 && ov.footprintPx > 0 && ov.coverRatio >= 0.95 &&
      (ov.centroidGap === null || ov.centroidGap <= 20),
      ov ? JSON.stringify(ov) : '拿不到高亮框')
  }

  console.log('\n=== 5. 反复暂停/播放不会累积监听 ===')
  const toggled = await cdp.evaluate(`
    const v = window.__bd2viewer
    const model = v.player && v.player.model
    const T = window.PIXI.Ticker.shared
    const count = () => {
      let n = 0
      for (let l = T._head && T._head.next; l; l = l.next) if (l.context === model) n++
      return n
    }
    const play = () => document.getElementById('btnPlay').click()
    const snap = {}
    play();  snap.afterPause = count()      // 播放态 → 暂停
    play();  snap.afterPlay = count()       // 暂停态 → 播放
    play();  snap.afterPause2 = count()
    play();  snap.afterPlay2 = count()
    return snap
  `, 30000)
  console.log('    来回切：' + JSON.stringify(toggled))
  check('暂停时监听归零', toggled.afterPause === 0 && toggled.afterPause2 === 0, JSON.stringify(toggled))
  check('反复播放不会累积监听', toggled.afterPlay === 1 && toggled.afterPlay2 === 1, JSON.stringify(toggled))

  console.log('\n=== 6. Spine 3.8 播放页照常能载入 ===')
  const sp = await cdp.evaluate(`
    const v = window.__bd2viewer
    const skel = (v.state.items || []).find(i => i.skeletonKind === 'skel' && i.relAtlas.indexOf(${JSON.stringify(pairSkelRel)}) >= 0)
    if (!skel) return { err: 'no-skel' }
    v.selectItem(skel)
    for (let i = 0; i < 300; i++) {
      const p = v.player
      if (p && (v.animations || []).length) break
      await new Promise(r => setTimeout(r, 100))
    }
    const p = v.player
    return { kind: p && p.kind, anims: (v.animations || []).length, pixi: !!(p && p.__pixi) }
  `, 90000)
  console.log('    ' + JSON.stringify(sp))
  check('Spine 3.8 走 pixi-spine 播放器', sp.kind === 'spine38' && sp.pixi === true, JSON.stringify(sp))
  check('Spine 3.8 动画列表非空', sp.anims > 0, `${sp.anims} 个`)

  console.log('\n=== 7. POSE / MOD 右键删除（真实素材 + 拦下 /api/delete，不删一个字节）===')
  /* 2026-10-04 新功能：播放页的姿势按钮 / mod 按钮右键 → 弹删除确认窗。
     两个口径故意不同：
       · 姿势 → **只删它自己那一条**（NIKKE 的 `<id>_00` / `_aim_00` 就在同一个目录里，
         按目录删会把本体一起干掉）
       · mod  → **删这个 mod 文件夹下的全部文件**（同一目录里可能还躺着被 jczxModDedupe
         藏起来的解包缓存版、以及别的形态的 atlas；只删链上那一条会留残渣）
     ⚠️ 这里**绝不真删**：把 window.fetch 里的 /api/delete 拦下来只记录 payload。
       真实素材是真人的图鉴目录，一个字节都不能动。 */
  const del = await cdp.evaluate(`
    const v = window.__bd2viewer
    const out = { delCalls: [] }
    window.__delCalls = []
    const of = window.fetch
    window.fetch = function (u, o) {
      if (String(u).indexOf('/api/delete') >= 0) {
        const body = JSON.parse((o && o.body) || '{}')
        window.__delCalls.push(body)
        // 回一份「真的删掉了」的回执：只有 gone 非空，runDelete 才会把条目从 S.items 移除，
        // 「删掉正在播的那一层之后有没有扶正」才观测得到。**只删内存里的条目，磁盘没动。**
        const deleted = (body.items || []).map(x => x.relAtlas)
        return Promise.resolve(new Response(JSON.stringify({ deleted, failed: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return of.apply(this, arguments)
    }
    const waitPlayer = async () => {
      const dl = Date.now() + 60000
      while (Date.now() < dl) { if (v.player && (v.animations || []).length) break; await new Promise(r => setTimeout(r, 300)) }
      await new Promise(r => setTimeout(r, 400))
    }
    const dirOf = it => {
      const r = String((it && (it.relAtlas || it.id)) || '')
      return r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : ''
    }
    const rightClick = el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const modal = () => ({
      open: !document.getElementById('confirmModal').hidden,
      title: document.getElementById('confirmTitle').textContent,
      rows: document.querySelectorAll('#confirmList .confirm-row').length,
      warn: document.getElementById('confirmWarn').textContent,
    })

    /* ---- ① MOD / 原皮：右键 → 取消（不许发请求）→ 右键 → 确认 ----
       al_mode 的素材镜像是「一个角色、一套 skel + 一套 model3」的小镜像，**没有 mod 目录**
       （实测 itMods=0 / memMods=0）—— mod 栏在它这儿不会出现。所以自造几条 mod 条目：
       **沿用真实条目的 targetKey/targetId**，这样 layerViewFor 会把它们归进真实的链里
       （DOM、右键、确认框、payload、删完的归组重算全走真实链路，只有这几条数据是造的）。
       同目录特意多塞一条不在链上的，用来证明口径是「整个文件夹」而不是「链上那一条」。 */
    v.setView('grid')
    const card0 = v.state.items.find(it => Array.isArray(it.members) && it.members.length) || v.state.items[0]
    if (card0) {
      const mem0 = (card0.members && card0.members[0] && card0.members[0].item) || card0
      const realJ = mem0.jczx || card0.jczx || {}
      const jz = (targetId, modId, targetKey, layerKind) => ({ targetId, modId, targetKey, layerKind })
      const fakeMod = (rel, j) => ({ id: rel, relAtlas: rel, relImages: [], problems: [], ok: true, jczx: j })
      const m1a = fakeMod('F/mod1/a.atlas', jz(realJ.targetId, 'm1', realJ.targetKey, 'mod'))
      const m1b = fakeMod('F/mod1/b.atlas', jz(realJ.targetId, 'm1', (realJ.targetKey || '') + '_2', 'mod'))
      const m2 = fakeMod('F/mod2/c.atlas', jz(realJ.targetId, 'm2', realJ.targetKey, 'mod'))
      const saved0 = v.state.items.slice()
      v.state.items = saved0.concat([m1a, m1b, m2])
      v.openItem(card0)
      await waitPlayer()
      const chain0 = (Array.isArray(card0.mods) && card0.mods.length)
        ? card0.mods
        : (card0.members || []).map(m => (m.item && m.item.mods) || m.mods).find(c => Array.isArray(c) && c.length)
      const realSrc = (chain0 || []).find(m => m.jczx && m.jczx.layerKind === 'source') || null
      out.modButtons = document.querySelectorAll('#modBar .gm-btn').length
      out.modTargetRel = m1a.relAtlas
      out.modExpected = ['F/mod1/a.atlas', 'F/mod1/b.atlas']
      out.modSourceRel = realSrc ? (realSrc.relAtlas || realSrc.id) : null
      const btn = [...document.querySelectorAll('#modBar .gm-btn')].find(b => b.dataset.mod === m1a.relAtlas)
      out.modBtnFound = !!btn
      if (btn) {
        rightClick(btn)
        await new Promise(r => setTimeout(r, 200))
        out.modModal = modal()
        document.getElementById('confirmNo').click()
        await new Promise(r => setTimeout(r, 200))
        out.modCallsAfterCancel = window.__delCalls.length
        // 模拟「你正在看的就是这个 mod」——右键删掉它之后必须能被扶正
        v.state.currentMod = m1a.relAtlas
        const b2 = [...document.querySelectorAll('#modBar .gm-btn')].find(b => b.dataset.mod === m1a.relAtlas)
        rightClick(b2 || btn)
        await new Promise(r => setTimeout(r, 200))
        document.getElementById('confirmYes').click()
        await new Promise(r => setTimeout(r, 900))
        out.modPayload = ((window.__delCalls[0] || {}).items || []).map(x => x.relAtlas).sort()
        out.modCurrentAfter = v.state.currentMod
        out.modResynced = v.state.currentMod !== m1a.relAtlas
        out.modErrAfter = (function () { const e = document.getElementById('errorBox'); return (e && !e.hidden) ? e.textContent : null })()
        out.modGone = !v.state.items.some(it => (it.relAtlas || it.id) === m1a.relAtlas)
      }
      // 原皮那格也要能右键：皮肤N/ 下面「原皮」与 mod3/mod4 是**平行**目录，
      // 按目录删原皮不会牵连任何 mod。往原皮目录塞一条兄弟，证明收的是「整个文件夹」。
      if (realSrc) {
        const srcRel = String(realSrc.relAtlas || realSrc.id || '')
        const srcDir = srcRel.includes('/') ? srcRel.slice(0, srcRel.lastIndexOf('/')) : ''
        const sibRel = srcDir + '/__sib_source.atlas'
        v.state.items = v.state.items.concat([
          { id: sibRel, relAtlas: sibRel, relImages: [], problems: [], ok: true,
            jczx: jz('ZZZ', null, 'ZZZ', 'source') },
        ])
        const sbtn = [...document.querySelectorAll('#modBar .gm-btn')].find(b => b.dataset.mod === 'source')
        out.srcBtnFound = !!sbtn
        out.srcRel = srcRel
        out.srcExpected = [srcRel, sibRel].sort()
        if (sbtn) {
          const beforeS = window.__delCalls.length
          rightClick(sbtn)
          await new Promise(r => setTimeout(r, 200))
          out.srcModal = modal()
          document.getElementById('confirmYes').click()
          await new Promise(r => setTimeout(r, 700))
          out.srcPayload = ((window.__delCalls[beforeS] || {}).items || []).map(x => x.relAtlas).sort()
        }
      }
      v.state.items = saved0
      await new Promise(r => setTimeout(r, 200))
    }

    /* ---- ② POSE：右键第 2 个姿势 → 确认 ---- */
    v.setView('grid')
    const poseCard = v.state.items.find(it => Array.isArray(it.members) && it.members.length > 1)
    if (poseCard) {
      v.openItem(poseCard)
      await waitPlayer()
      const btns = [...document.querySelectorAll('#poseBar .gm-btn')]
      out.poseButtons = btns.length
      const btn = btns[1]
      if (btn) {
        const mem = poseCard.members.find(m => String(m.pose) === btn.dataset.pose)
        const target = (mem && mem.item) || poseCard
        out.poseTargetRel = target.relAtlas || target.id
        // 往**同一个目录**里塞一条「兄弟」再点 —— 不然这条断言不敏感：素材里同目录只有
        // 一条时，「只删这一条」和「按目录全删」结果一样，变异测试测不出来。
        // 真实数据里 NIKKE 的 <id>_00 / _aim_00 就住在同一个目录，按目录删会把本体一起干掉。
        const targetRel = String(target.relAtlas || target.id || '')
        const sibRel = targetRel.replace(/[^/]+$/, 'sib.atlas')
        const sib = sibRel && sibRel !== targetRel
          ? { id: sibRel, relAtlas: sibRel, relImages: [], problems: [], ok: true } : null
        const savedP = v.state.items.slice()
        if (sib) v.state.items = savedP.concat([sib])
        out.poseSameDirCount = v.state.items.filter(it => !it.key && dirOf(it) === dirOf(target)).length
        out.poseSibling = sib ? sib.relAtlas : null
        const before = window.__delCalls.length
        rightClick(btn)
        await new Promise(r => setTimeout(r, 200))
        out.poseModal = modal()
        document.getElementById('confirmYes').click()
        await new Promise(r => setTimeout(r, 600))
        out.posePayload = ((window.__delCalls[before] || {}).items || []).map(x => x.relAtlas)
        out.posePayloadImages = ((window.__delCalls[before] || {}).items || []).reduce((n, x) => n + (x.relImages || []).length, 0)
        v.state.items = savedP
      }
    }

    /* ---- ③ 纯函数：mod 文件夹口径（喂假条目，不依赖素材内容）---- */
    const saved = v.state.items
    const fake = (rel, j) => ({ id: rel, relAtlas: rel, relImages: [], problems: [], ok: true, jczx: j })
    v.state.items = [
      fake('A/原图/x.atlas', { targetId: 'T', modId: null, targetKey: 'K', layerKind: 'source' }),
      fake('A/mod1/x.atlas', { targetId: 'T', modId: 'm1', targetKey: 'K', layerKind: 'mod' }),
      fake('A/mod1/y.atlas', { targetId: 'T', modId: 'm1', targetKey: 'K2', layerKind: 'mod' }),
      fake('A/mod2/z.atlas', { targetId: 'T', modId: 'm2', targetKey: 'K', layerKind: 'mod' }),
      fake('B/mod1/w.atlas', { targetId: 'T', modId: 'm1', targetKey: 'K', layerKind: 'mod' }),
    ]
    out.folderPick = v.modFolderItems(v.state.items[1]).map(i => i.relAtlas).sort()
    out.folderPickSource = v.modFolderItems(v.state.items[0]).map(i => i.relAtlas)
    v.state.items = saved
    out.delCalls = window.__delCalls.length
    return out
  `, 300000)
  if (del && del.modModal) {
    console.log(`    mod：${del.modButtons} 个按钮 · 目标 ${del.modTargetRel}`)
    console.log(`    弹窗「${del.modModal.title}」 · ${del.modModal.rows} 行 · 取消后请求数=${del.modCallsAfterCancel}`)
    console.log(`    payload=${JSON.stringify(del.modPayload)}（期望 ${JSON.stringify(del.modExpected)}）`)
    check('右键 mod 按钮 → 弹出「删除这个 mod 文件夹？」并列出文件清单',
      del.modModal.open === true && del.modModal.title.indexOf('mod 文件夹') >= 0 && del.modModal.rows > 0,
      `open=${del.modModal.open} title="${del.modModal.title}" rows=${del.modModal.rows}`)
    check('mod 弹窗里写明「这个文件夹下的全部文件都会被删除」',
      String(del.modModal.warn).indexOf('全部文件') >= 0, del.modModal.warn)
    check('点「取消」→ 一个删除请求都不发（不能碰磁盘）',
      del.modCallsAfterCancel === 0, `取消后累计请求数=${del.modCallsAfterCancel}`)
    check('确认后交给后端的清单 = 这个 mod 目录下的条目，且不含原图',
      (del.modPayload || []).join('|') === (del.modExpected || []).join('|') &&
      !!del.modPayload.length && !(del.modPayload || []).includes(del.modSourceRel),
      `payload=${JSON.stringify(del.modPayload)} 期望=${JSON.stringify(del.modExpected)} 原图=${del.modSourceRel}`)
  } else {
    check('右键 mod 按钮 → 弹出「删除这个 mod 文件夹？」并列出文件清单', false, JSON.stringify(del))
    check('mod 弹窗里写明「这个文件夹下的全部文件都会被删除」', false, '拿不到样本')
    check('点「取消」→ 一个删除请求都不发（不能碰磁盘）', false, '拿不到样本')
    check('确认后交给后端的清单 = 这个 mod 目录下的条目，且不含原图', false, '拿不到样本')
  }
  if (del && del.modModal && del.modResynced !== undefined) {
    check('删掉「正在播的那一层」之后会被扶正（不再指向已删条目，也不报错）',
      del.modResynced === true && del.modGone === true && !del.modErrAfter,
      `currentMod=${del.modCurrentAfter}（被删的是 ${del.modTargetRel}）已从 S.items 移除=${del.modGone} errorBox=${del.modErrAfter || '空'}`)
  } else {
    check('删掉「正在播的那一层」之后会被扶正（不再指向已删条目，也不报错）', false, '拿不到样本')
  }
  if (del && del.srcModal) {
    console.log(`    原皮：${del.srcRel}`)
    console.log(`    弹窗「${del.srcModal.title}」 · payload=${JSON.stringify(del.srcPayload)}`)
    check('原皮那格也能右键 → 弹出「删除这个原皮文件夹？」并列出文件清单',
      del.srcModal.open === true && del.srcModal.title.indexOf('原皮') >= 0 && del.srcModal.rows > 0,
      `open=${del.srcModal.open} title="${del.srcModal.title}" rows=${del.srcModal.rows}`)
    check('原皮按目录删：收的是原皮文件夹里的全部文件，且不牵连任何 mod',
      (del.srcPayload || []).join('|') === (del.srcExpected || []).join('|') &&
      (del.srcPayload || []).length >= 2,
      `payload=${JSON.stringify(del.srcPayload)} 期望=${JSON.stringify(del.srcExpected)}`)
  } else {
    check('原皮那格也能右键 → 弹出「删除这个原皮文件夹？」并列出文件清单', false, JSON.stringify(del))
    check('原皮按目录删：收的是原皮文件夹里的全部文件，且不牵连任何 mod', false, '拿不到样本')
  }
  if (del && del.poseModal) {
    console.log(`    pose：${del.poseButtons} 个按钮 · 目标 ${del.poseTargetRel}`)
    console.log(`    弹窗「${del.poseModal.title}」 · payload=${JSON.stringify(del.posePayload)}`)
    check('右键姿势按钮 → 弹出「删除这个姿势？」并列出文件清单',
      del.poseModal.open === true && del.poseModal.title.indexOf('姿势') >= 0 && del.poseModal.rows > 0,
      `open=${del.poseModal.open} title="${del.poseModal.title}" rows=${del.poseModal.rows}`)
    check('姿势只删它自己那一条（同目录的其它姿势 / 本体不动）',
      (del.posePayload || []).length === 1 && del.posePayload[0] === del.poseTargetRel &&
      (del.poseSameDirCount || 0) >= 2,
      `payload=${JSON.stringify(del.posePayload)} 目标=${del.poseTargetRel} ` +
      `同目录共 ${del.poseSameDirCount} 条（其中一条是塞进去的兄弟 ${del.poseSibling}，必须没被带上）`)
  } else {
    check('右键姿势按钮 → 弹出「删除这个姿势？」并列出文件清单', false, JSON.stringify(del))
    check('姿势只删它自己那一条（同目录的其它姿势 / 本体不动）', false, '拿不到样本')
  }
  if (del && del.folderPick) {
    check('mod 文件夹口径：同目录兄弟一起收，原图排除，别的目录不收',
      (del.folderPick || []).join('|') === 'A/mod1/x.atlas|A/mod1/y.atlas' &&
      (del.folderPickSource || []).join('|') === 'A/原图/x.atlas',
      `同目录=${JSON.stringify(del.folderPick)} 传原图时=${JSON.stringify(del.folderPickSource)}`)
  } else {
    check('mod 文件夹口径：同目录兄弟一起收，原图排除，别的目录不收', false, '拿不到样本')
  }

  console.log('\n=== 7b. 触屏：长按 = 右键的等价入口 ===')
  /* 手机上没有右键 —— 姿势 / MOD 的删除入口必须同时支持**触屏长按**（项目里卡片的约定，
     R14：PC 右键 ≡ 触屏长按）。四条：长按弹出、抬手那一下 click 被吃掉（不许顺手切姿势）、
     鼠标按住不动**不弹**（PC 上长按不是这个手势）、手指挪开就放弃。 */
  const touch = await cdp.evaluate(`
    const v = window.__bd2viewer
    const out = {}
    v.setView('grid')
    const card = v.state.items.find(it => Array.isArray(it.members) && it.members.length > 1)
    if (!card) return { err: 'no-members-card' }
    v.openItem(card)
    let dl = Date.now() + 60000
    while (Date.now() < dl) { if (v.player && (v.animations || []).length) break; await new Promise(r => setTimeout(r, 300)) }
    await new Promise(r => setTimeout(r, 400))
    const btns = [...document.querySelectorAll('#poseBar .gm-btn')]
    out.buttons = btns.length
    const btn = btns[1]
    if (!btn) return { err: 'no-second-btn' }
    out.targetPose = btn.dataset.pose
    // 当前姿势若已经等于它，先切到第一个 —— 否则「没有被切成它」这条断言区分不出来
    if (v.state.currentPose === btn.dataset.pose) {
      v.switchPose(btns[0].dataset.pose)
      await new Promise(r => setTimeout(r, 600))
    }
    out.poseBefore = v.state.currentPose
    const down = t => btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: t, clientX: 40, clientY: 40 }))
    const up = t => btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: t, clientX: 40, clientY: 40 }))
    const open0 = () => !document.getElementById('confirmModal').hidden
    const closeIfOpen = async () => { if (open0()) { document.getElementById('confirmNo').click(); await new Promise(r => setTimeout(r, 200)) } }

    down('mouse')
    await new Promise(r => setTimeout(r, 700))
    out.mouseOpened = open0()
    up('mouse')
    await closeIfOpen()

    down('touch')
    await new Promise(r => setTimeout(r, 700))
    out.touchOpened = open0()
    out.touchTitle = document.getElementById('confirmTitle').textContent
    up('touch')
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 250))
    out.poseAfter = v.state.currentPose
    await closeIfOpen()

    down('touch')
    btn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'touch', clientX: 300, clientY: 300 }))
    await new Promise(r => setTimeout(r, 700))
    out.moveOpened = open0()
    up('touch')
    await closeIfOpen()
    return out
  `, 120000)
  if (touch && touch.touchOpened !== undefined) {
    console.log('    长按姿势按钮「' + (touch.targetPose || '') + '」：弹窗=' + touch.touchOpened +
      ' 标题="' + touch.touchTitle + '" · 长按前姿势=' + touch.poseBefore + ' 抬手后=' + touch.poseAfter)
    check('触屏长按姿势按钮 → 弹出「删除这个姿势？」（手机上没有右键）',
      touch.touchOpened === true && String(touch.touchTitle).indexOf('姿势') >= 0,
      `弹窗=${touch.touchOpened} 标题="${touch.touchTitle}"`)
    check('长按抬手那一下 click 被吃掉（不会顺手把姿势也切了）',
      touch.poseAfter === touch.poseBefore && touch.poseAfter !== touch.targetPose,
      `长按前=${touch.poseBefore} 抬手后=${touch.poseAfter} 按钮指向=${touch.targetPose}`)
    check('鼠标按住不动不弹删除窗（PC 上长按不是这个手势）',
      touch.mouseOpened === false, `鼠标按住 700ms → 弹窗=${touch.mouseOpened}`)
    check('触屏长按期间手指挪开 → 放弃长按（当作滑动）',
      touch.moveOpened === false, `挪开后弹窗=${touch.moveOpened}`)
  } else {
    check('触屏长按姿势按钮 → 弹出「删除这个姿势？」（手机上没有右键）', false, JSON.stringify(touch))
    check('长按抬手那一下 click 被吃掉（不会顺手把姿势也切了）', false, '拿不到样本')
    check('鼠标按住不动不弹删除窗（PC 上长按不是这个手势）', false, '拿不到样本')
    check('触屏长按期间手指挪开 → 放弃长按（当作滑动）', false, '拿不到样本')
  }

  console.log('\n=== 8. 碧蓝航线 Spine 3.8：多层骨架（B/M/T）归组 + 点画面选层 + 双击放大 ===')
  /* 2026-10-05 用户实测反馈三件事，都在这一节钉住：
       ①「的里雅斯特原皮只渲染了场景」→ 同目录 `_B`/`_M`/`_T` 是三套骨架（B 只有 BG-* 槽位），
         以前各成一张卡、点开第一张只有背景。现在归成一张卡、三层叠着画（R39）。
       ②「图层选不中 / 高亮框不跟缩放平移」→ 这条路走 pixi-spine，**没有相机**，
         命中与高亮框都要用 pixi 自己的变换，而且每帧要重画。
       ③「双击放大做没了」→ 双击定点放大以前只认相机，pixi 播放器上双击毫无反应。 */
  const al38 = layerGroup
    ? await cdp.evaluate(`
    const LAYER_DIR = ${JSON.stringify(layerGroup ? relOf(layerGroup.dir) : '')}
    const v = window.__bd2viewer
    const out = {}
    const inDir = x => String(x.relAtlas || '').indexOf(LAYER_DIR) >= 0
    const visible = v.filteredItems ? v.filteredItems() : (v.state.items || [])
    out.dirCards = visible.filter(inDir).map(x => x.base)
    // 卡片 = 挂了 layerItems 的那一条（S.items 是原始条目；mod 目录里可见列表只剩链头）
    const all = v.state.items || []
    const card = all.find(x => inDir(x) && Array.isArray(x.layerItems) && x.layerItems.length >= 2) ||
      visible.find(inDir) || all.find(inDir)
    if (!card) return { err: 'no-card', dirCards: out.dirCards, scanned: all.length }
    out.card = card.base
    out.layerItems = (card.layerItems || []).map(x => x.base)
    out.visibleHasCard = visible.some(x => x === card)
    v.setView('player')
    v.selectItem(card)
    let p = null
    for (let i = 0; i < 400; i++) {
      p = v.player
      if (p && (v.animations || []).length) break
      await new Promise(r => setTimeout(r, 100))
    }
    await new Promise(r => setTimeout(r, 1200))
    if (!p || p.kind !== 'spine38') return { err: 'not-spine38', kind: p && p.kind, card: out.card }
    out.layers = (p.layers || []).length
    out.layerNames = (p.layers || []).map(l => l.name)
    out.slots = v.state.slots.length
    out.anims = v.animations.length
    const chk = document.getElementById('chkLayerSelect')
    const chkWas = chk ? chk.checked : null
    if (chk && !chk.checked) { chk.checked = true; chk.dispatchEvent(new Event('change')) }
    out.layerSelect = !!v.state.layerSelect
    await new Promise(r => setTimeout(r, 200))
    try { p.pause() } catch {}

    const app = p.app, gl = app.renderer.gl
    const canvas = app.renderer.view, W = canvas.width, H = canvas.height
    /* ⚠️ 画布 rect 必须在**开完点选模式之后**再量：勾选会动布局（多一条提示条），
       用旧 rect 算出来的采样点会和 app 内部按新 rect 算的像素错开（实测「空白误选」就是它）。 */
    const rect = canvas.getBoundingClientRect()
    const bufA = new Uint8Array(W * H * 4), bufB = new Uint8Array(W * H * 4)
    const grab = b => gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b)
    const diffCount = () => {
      let n = 0
      for (let i = 0; i < bufA.length; i += 4) {
        if (bufA[i] !== bufB[i] || bufA[i + 1] !== bufB[i + 1] ||
            bufA[i + 2] !== bufB[i + 2] || bufA[i + 3] !== bufB[i + 3]) n++
      }
      return n
    }
    const px = (x, y) => {
      const b = new Uint8Array(4)
      const cx = Math.round((x - rect.left) * (canvas.width / rect.width))
      const cy = Math.round((y - rect.top) * (canvas.height / rect.height))
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null
      gl.readPixels(cx, H - 1 - cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b)
      return b
    }
    const same = (a, b) => !!(a && b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]

    // ① 每一层都真的在画（藏掉任一层，画面都要变）
    out.layerDiff = []
    for (let li = 0; li < p.layers.length; li++) {
      app.render(); grab(bufA)
      p.layers[li].spine.visible = false
      app.render(); grab(bufB)
      p.layers[li].spine.visible = true
      out.layerDiff.push({ name: p.layers[li].name, diff: diffCount() })
    }
    app.render()

    // ② 点选 vs 真实渲染：自上而下逐个藏槽位容器，谁让该像素变就是谁
    //    ⚠️ order 保留**每一个容器**（不按名字去重）：同名槽位横跨多层时，
    //    高亮框只框「几何上覆盖该点」的那几块，测试的足迹也必须量同一块才对得上。
    const order = []
    const nameCount = new Map()
    const CLIP_TYPE = (window.PIXI && window.PIXI.spine && window.PIXI.spine.AttachmentType &&
      typeof window.PIXI.spine.AttachmentType.Clipping === 'number')
      ? window.PIXI.spine.AttachmentType.Clipping : 6
    for (let li = p.layers.length - 1; li >= 0; li--) {
      const sp = p.layers[li].spine
      const kids = sp.children || []
      for (let ci = kids.length - 1; ci >= 0; ci--) {
        const si = sp.slotContainers.indexOf(kids[ci])
        if (si < 0) continue
        const slot = sp.skeleton.slots[si]
        const nm = slot && slot.data ? slot.data.name : null
        if (!nm) continue
        // 剪裁附件不是图层（app 的候选阶段就跳过它们）：藏掉它会让被裁的内容露出来，
        // 看着像「它画了」，其实只是在当遮罩 —— 真值必须用同一口径。
        let att = null
        try { att = slot.getAttachment() } catch { att = null }
        if (att && att.type === CLIP_TYPE) continue
        nameCount.set(nm, (nameCount.get(nm) || 0) + 1)
        order.push({ name: nm, box: kids[ci] })
      }
    }
    const truthAt = (x, y) => {
      app.render()
      const base = px(x, y)
      if (!base || base[3] <= 8) return { kind: 'empty' }
      for (const c of order) {
        // ⚠️ 收尾必须还原**原来的** visible：pixi-spine 自己会把「没有附件的槽位」设成不可见，
        //    一律写 true 会把它们翻出来，之后每一帧都多出东西（点选跟着就"误选"，实测踩过）。
        const keep = c.box.visible
        c.box.visible = false
        app.render()
        const a = px(x, y)
        c.box.visible = keep
        if (a && !same(a, base)) return { kind: 'slot', name: c.name }
      }
      return { kind: 'unknown' }
    }
    const rows = []
    const N = 4
    for (let iy = 1; iy <= N; iy++) {
      for (let ix = 1; ix <= N; ix++) {
        const x = Math.round(rect.left + rect.width * ix / (N + 1))
        const y = Math.round(rect.top + rect.height * iy / (N + 1))
        const t = truthAt(x, y)
        app.render()
        const hits = v.pickLayersAt(x, y)
        // 两边各读一次像素：读法一致时「空白」才可信；不一致的样本判不了，单列出来（见下）
        const ap = v.pixiReadPixel(x, y)
        const testPx = px(x, y)
        const disagree = !!(ap && testPx) &&
          ((ap[3] <= 8) !== (testPx[3] <= 8))
        rows.push({
          at: [x, y], kind: disagree ? 'unknown' : t.kind, truth: t.name || null,
          got: hits[0] || null, hitsN: hits.length, disagree,
        })
      }
    }
    out.rows = rows
    out.painted = rows.filter(r => r.kind === 'slot').length
    out.agree = rows.filter(r => r.kind === 'slot' && r.got === r.truth).length
    out.disagreeReads = rows.filter(r => r.disagree).length
    out.emptyBadSample = rows.filter(r => r.kind === 'empty' && r.got)
      .slice(0, 3).map(r => ({ at: r.at, got: r.got, hitsN: r.hitsN }))
    out.emptyBad = out.emptyBadSample.length
    out.miss = rows.filter(r => r.kind === 'slot' && r.got !== r.truth).slice(0, 4)

    // ③ 高亮框：挑一个「框和真实足迹完全重合」的槽位，缩放后再验一次
    const footBox = (box) => {
      app.render(); grab(bufA)
      const keep = box.visible          // 同上：还原原值，别一律写 true
      box.visible = false
      app.render(); grab(bufB)
      box.visible = keep
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
      for (let i = 0; i < bufA.length; i += 4) {
        if (bufA[i] === bufB[i] && bufA[i + 1] === bufB[i + 1] &&
            bufA[i + 2] === bufB[i + 2] && bufA[i + 3] === bufB[i + 3]) continue
        const q = i >> 2, fx = q % W, fy = Math.floor(q / W)
        n++
        if (fx < x0) x0 = fx
        if (fx > x1) x1 = fx
        if (fy < y0) y0 = fy
        if (fy > y1) y1 = fy
      }
      app.render()
      if (!n) return null
      return {
        n,
        l: rect.left + x0 * rect.width / canvas.width,
        t: rect.top + (canvas.height - 1 - y1) * rect.height / canvas.height,
        r: rect.left + x1 * rect.width / canvas.width,
        b: rect.top + (canvas.height - 1 - y0) * rect.height / canvas.height,
      }
    }
    const ov = document.getElementById('overlayCanvas')
    const octx = ov.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const hRect = document.getElementById('stageInner').getBoundingClientRect()
    const ovBox = () => {
      const img = octx.getImageData(0, 0, ov.width, ov.height)
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
      for (let y = 0; y < ov.height; y++) {
        for (let x = 0; x < ov.width; x++) {
          if (img.data[(y * ov.width + x) * 4 + 3] <= 8) continue
          n++
          const cx = hRect.left + x / dpr, cy = hRect.top + y / dpr
          if (cx < x0) x0 = cx
          if (cx > x1) x1 = cx
          if (cy < y0) y0 = cy
          if (cy > y1) y1 = cy
        }
      }
      return n ? { n, l: x0, t: y0, r: x1, b: y1 } : null
    }
    const boxGap = (a, b) => (a && b)
      ? Math.round(Math.max(Math.abs(a.l - b.l), Math.abs(a.t - b.t), Math.abs(a.r - b.r), Math.abs(a.b - b.b)) * 10) / 10
      : null
    /** 框是否**罩住**了足迹（容差 tol 像素）。缩放后框会盖到画布外、比足迹大是正常的，
     *  但绝不能漏掉足迹里的像素 —— 那才是「框和图层位置不符」。 */
    const boxCovers = (o, f, tol) => (o && f)
      ? (o.l <= f.l + tol && o.t <= f.t + tol && o.r >= f.r - tol && o.b >= f.b - tol)
      : false
    /* 挑一个「框 == 该层真实足迹」的干净样本：优先拿**没有东西压在它上面**的槽位
       （采样点命中栈长度 = 1），并且**用真点选来选它**（这样 app 记住的是「点中的那一块」，
       同名槽位横跨多层时才不会框到别处去）。容差 6px 吸收抗锯齿。 */
    const cands2 = []
    for (const r of rows) {
      if (r.kind === 'slot' && r.got === r.truth && r.hitsN === 1 &&
        nameCount.get(r.got) === 1 && !cands2.some(c => c.name === r.got)) {
        cands2.push({ name: r.got, at: r.at })
      }
    }
    for (const r of rows) {
      if (r.kind === 'slot' && r.got === r.truth && nameCount.get(r.got) === 1 &&
        !cands2.some(c => c.name === r.got)) {
        cands2.push({ name: r.got, at: r.at })
      }
    }
    let clean = null
    for (const cand of cands2.slice(0, 8)) {
      const name = cand.name
      const entry = order.find(o => o.name === name)
      if (!entry) continue
      if (v.state.hidden && v.state.hidden.has(name)) continue
      const f = footBox(entry.box)
      if (!f || f.n < 400) continue
      // 真点选一次：让 app 记下「点中的那一块」（pickLayersAt 不会改 S.selectedLayer，
      // 那是 pointerup 处理器的活），再手动把它设为当前选中。
      v.pickLayersAt(cand.at[0], cand.at[1])
      v.state.selectedLayer = name
      v.drawOverlay()
      const o = ovBox()
      if (o && boxGap(o, f) !== null && boxGap(o, f) <= 6) {
        clean = { c: entry, f, o, layerAtTap: v.pickLayersAt(cand.at[0], cand.at[1])[0] || null }
        break
      }
    }
    let overlayTest = null
    if (clean) {
      // 双击定点放大（真实 pointerdown 两下，间隔 < 340ms）
      const host = document.getElementById('stageInner')
      const tap = (x, y) => host.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, isPrimary: true, button: 0, clientX: x, clientY: y,
      }))
      const zoomAt = (x, y) => { tap(x, y); tap(x, y) }
      const tapX = Math.round(rect.left + rect.width * 0.45)
      const tapY = Math.round(rect.top + rect.height * 0.45)
      const snap = () => {
        app.render()
        const f = footBox(clean.c.box)
        return { f, o: ovBox() }
      }
      const mags = []
      const r0 = v.zoomRatio
      // 「定点」判据用**变换**算（与像素无关，精确）：落点在显示局部坐标里的位置，缩放前后必须一样。
      // 每层都要对 —— 多层只动一层会错位，这里也一并钉住。
      const txLocal = tapX - rect.left
      const tyLocal = tapY - rect.top
      const localOf = (d) => [(txLocal - d.x) / (d.scale.x || 1), (tyLocal - d.y) / (d.scale.x || 1)]
      const anchorsBefore = p.layers.map(l => localOf(l.spine))
      const layerAtTapBefore = v.pickLayersAt(tapX, tapY)[0] || null
      // ① 第一次双击 → 2.6×：先量「框 vs 真实足迹」，再继续走完档位
      zoomAt(tapX, tapY)
      await new Promise(r => setTimeout(r, 200))
      const s1 = snap()
      const anchorsAfter = p.layers.map(l => localOf(l.spine))
      const anchorErr = Math.max(...anchorsBefore.map((a, i) =>
        Math.hypot(a[0] - anchorsAfter[i][0], a[1] - anchorsAfter[i][1])))
      mags.push(Math.round((1 / v.zoomRatio) * 100) / 100)
      const layerAtTap1 = v.pickLayersAt(tapX, tapY)[0] || null
      for (let i = 0; i < 3; i++) {
        zoomAt(tapX, tapY)
        await new Promise(r => setTimeout(r, 150))
        app.render()
        mags.push(Math.round((1 / v.zoomRatio) * 100) / 100)
      }
      overlayTest = {
        slot: clean.c.name,
        before: { gap: boxGap(clean.o, clean.f), overlayN: clean.o.n, footN: clean.f.n },
        after: {
          gap: boxGap(s1.o, s1.f),
          covers: boxCovers(s1.o, s1.f, 6),
          overlayN: s1.o ? s1.o.n : 0,
          footN: s1.f ? s1.f.n : 0,
          moved: (clean.o && s1.o)
            ? Math.round(Math.hypot((s1.o.l + s1.o.r) / 2 - (clean.o.l + clean.o.r) / 2,
              (s1.o.t + s1.o.b) / 2 - (clean.o.t + clean.o.b) / 2))
            : null,
        },
        mags, zoomStart: Math.round((1 / r0) * 100) / 100, ratioEnd: Math.round(v.zoomRatio * 1000) / 1000,
        anchorErr: Math.round(anchorErr * 1000) / 1000,
        layerAtTap: layerAtTap1,
        layerAtTapBefore,
      }
    }
    out.overlay = overlayTest

    // ④ 勾选 / 取消勾选双向（藏得住也要放得回来）
    let hideTest = null
    if (clean) {
      const f = clean.f
      const at = [(f.l + f.r) / 2, (f.t + f.b) / 2]
      const r0 = px(at[0], at[1])
      v.setLayerHidden(clean.c.name, true)
      app.render()
      const r1 = px(at[0], at[1])
      v.setLayerHidden(clean.c.name, false)
      app.render()
      const r2 = px(at[0], at[1])
      hideTest = { slot: clean.c.name, before: Array.from(r0 || []), hidden: Array.from(r1 || []), restored: Array.from(r2 || []), restoredOk: same(r0, r2) }
    }
    out.hide = hideTest

    v.state.selectedLayer = null
    v.drawOverlay()
    if (chk) { chk.checked = !!chkWas; chk.dispatchEvent(new Event('change')) }
    return out
  `, 1800000)
    : null
  if (!layerGroup) {
    console.log('SKIP  图鉴里没有「同目录多层骨架（_B/_M/_T）」的素材 → 跳过 §8')
  } else if (al38.err) {
    check('§8 多层素材能打开', false, JSON.stringify(al38))
  } else {
    console.log(`    卡片 ${al38.card} · 层 ${JSON.stringify(al38.layerNames)} · 槽位 ${al38.slots} · ` +
      `可见卡片 ${JSON.stringify(al38.dirCards)}`)
    console.log(`    逐层藏掉后的像素变化 ${JSON.stringify(al38.layerDiff)}`)
    check('同目录 `_B`/`_M`/`_T` 归成一张卡（不再各成一张、点开第一张只有背景）',
      (al38.layerItems || []).length >= 2 && al38.visibleHasCard === true && al38.dirCards.length === 1,
      `可见卡片=${JSON.stringify(al38.dirCards)} layerItems=${JSON.stringify(al38.layerItems)} 卡片在可见列表=${al38.visibleHasCard}`)
    check('三层一起渲染（藏掉任何一层画面都会变）',
      al38.layers === (al38.layerItems || []).length && al38.layerDiff.length === al38.layers &&
      al38.layerDiff.every(d => d.diff > 0),
      `layers=${al38.layers} ${JSON.stringify(al38.layerDiff)}`)
    check('点画面选中的层 == 该像素真正画的层（真值来自逐个藏槽位容器）',
      al38.painted > 0 && al38.agree === al38.painted && al38.emptyBad === 0,
      `${al38.agree}/${al38.painted} 一致 · 空白误选 ${al38.emptyBad} · 两侧读像素不一致(判不了) ${al38.disagreeReads}` +
      (al38.emptyBadSample && al38.emptyBadSample.length ? ' 空白误选例：' + JSON.stringify(al38.emptyBadSample) : '') +
      (al38.miss && al38.miss.length ? ' 例：' + JSON.stringify(al38.miss) : ''))
    const ovz = al38.overlay
    check('高亮框跟着缩放走，且缩放后仍罩住该层真实画出来的像素',
      !!ovz && ovz.before.gap <= 6 && ovz.after.moved > 5 && ovz.after.covers === true,
      ovz ? JSON.stringify(ovz) : '拿不到「框=足迹」的干净样本')
    check('双击定点放大：逐档 2.6 → 6.8 → 12.4，到顶再双击还原',
      !!ovz && ovz.mags.length === 4 &&
      Math.abs(ovz.mags[0] - 2.6) < 0.35 && Math.abs(ovz.mags[1] - 6.8) < 0.7 &&
      Math.abs(ovz.mags[2] - 12.4) < 1.3 && Math.abs(ovz.mags[3] - 1) < 0.15 && Math.abs(ovz.ratioEnd - 1) < 0.15,
      ovz ? `放大倍数=${JSON.stringify(ovz.mags)} 收尾 zoomRatio=${ovz.ratioEnd}` : '拿不到样本')
    check('缩放锚在落点上（每层在落点处的局部坐标都不许漂）',
      !!ovz && ovz.anchorErr < 0.5,
      ovz ? `锚点漂移=${ovz.anchorErr}px（落点 ${JSON.stringify(ovz.layerAtTapBefore)} → ${JSON.stringify(ovz.layerAtTap)}）` : '拿不到样本')
    const hd = al38.hide
    check('勾选能隐藏、取消勾选能恢复（hidePixiSlots 双向）',
      !!hd && hd.before.join() !== hd.hidden.join() && hd.restoredOk === true,
      hd ? JSON.stringify(hd) : '拿不到样本')
  }

  console.log('\n=== 9. 碧蓝航线 Live2D：动作里的 PartOpacity 曲线（手部变体只留一套）===')
  /* 2026-10-05 用户截图「爱宕 皮肤2 原皮 · mail：三只手」。
     根因：动作里的 `PartOpacity` 曲线在框架里**默认不生效**（`CubismConfig.setOpacityFromMotion
     = false` → 曲线值被写进同名参数，而 AL 的部件叫 `PartNN`、参数叫 `Param*` → 查不到 → 丢弃）。
     实测对照（先播 idle 再点 mail，同一帧）：
       开关关：手部可见 drawable 29 → 31（多出来的变体都在画）
       开关开：8 → 10
     这条真值来自**动作文件本身**（Node 侧解析），不依赖运行时。 */
  const al9 = atagoOk && atagoParts.length
    ? await cdp.evaluate(`
    const v = window.__bd2viewer
    const out = { partIds: ${JSON.stringify(atagoParts)} }
    out.flag = v.live2dOpacityFromMotion()
    v.setView('grid')
    const items = v.state.items || []
    const item = items.find(x => String(x.relAtlas || '').indexOf(${JSON.stringify(ATAGO_DIR)}) >= 0)
    if (!item) return { err: 'no-item', flag: out.flag }
    v.setView('player')
    v.selectItem(item)
    for (let i = 0; i < 400; i++) {
      const p = v.player
      if (p && p.kind === 'live2d' && p.model && (v.animations || []).length) break
      await new Promise(r => setTimeout(r, 100))
    }
    await new Promise(r => setTimeout(r, 1000))
    const p = v.player
    if (!p || p.kind !== 'live2d') return { err: 'not-live2d', flag: out.flag }
    let autoOn = false
    // 复现用户的操作顺序：先让 idle 播一会儿，再切到 mail
    const anims = v.animations || []
    for (let i = 0; i < anims.length + 2; i++) {
      const nm = (p.animationState.getCurrent(0) || {}).animation
      if (nm && /^idle$/i.test(nm.name)) break
      v.switchAnimation(1)
      await new Promise(r => setTimeout(r, 200))
    }
    await new Promise(r => setTimeout(r, 1800))
    for (let i = 0; i < anims.length + 2; i++) {
      const nm = (p.animationState.getCurrent(0) || {}).animation
      if (nm && nm.name === ${JSON.stringify(ATAGO_ANIM)}) break
      v.switchAnimation(1)
      await new Promise(r => setTimeout(r, 150))
    }
    out.anim = ((p.animationState.getCurrent(0) || {}).animation || {}).name || null
    v.state.playing = false
    const core = p.model.internalModel.coreModel._model
    const pids = Array.from(core.parts.ids)
    const dids = Array.from(core.drawables.ids)
    const rows = []
    for (const frac of [0.13, 0.5, 0.88]) {
      try { p.seekFraction(frac) } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 260))
      const zeros = []
      for (const id of out.partIds) {
        const i = pids.indexOf(id)
        if (i >= 0 && core.parts.opacities[i] < 0.02) zeros.push(id)
      }
      let hands = 0
      for (let d = 0; d < dids.length; d++) {
        if (!/hand|finger/i.test(String(dids[d]))) continue
        if (Live2DCubismCore.Utils.hasIsVisibleBit(core.drawables.dynamicFlags[d]) &&
            core.drawables.opacities[d] > 0.02) hands++
      }
      rows.push({ frac, zeros: zeros.length, handDrawables: hands })
    }
    out.rows = rows
    out.zeroMin = Math.min(...rows.map(r => r.zeros))
    out.handMax = Math.max(...rows.map(r => r.handDrawables))
    return out
  `, 600000)
    : null
  if (!atagoOk || !atagoParts.length) {
    console.log('SKIP  素材里没有爱宕原皮（或动作里没有 PartOpacity 曲线）→ 跳过 §9')
  } else if (al9.err) {
    check('§9 爱宕原皮能打开', false, JSON.stringify(al9))
  } else {
    console.log(`    动作 ${ATAGO_ANIM} · 文件里的 PartOpacity 部件 ${al9.partIds.length} 个 · ` +
      `逐帧：${JSON.stringify(al9.rows)}`)
    check('动作里的 PartOpacity 曲线开关已打开（关着 = 手部变体不会淡出）',
      al9.flag === true, `setOpacityFromMotion=${al9.flag}`)
    check('带 PartOpacity 曲线的部件在播放中真的被压到 0（文件真值 → 运行时）',
      al9.zeroMin >= 3, `最少被压到 0 的部件数=${al9.zeroMin}（共 ${al9.partIds.length} 个曲线部件）`)
    check('可见的手部 drawable 数量收敛（三只手 = 变体没淡出）',
      al9.handMax > 0 && al9.handMax <= 16,
      `最多 ${al9.handMax} 个（修复前实测 29~31；>16 基本就是变体叠着画）`)
  }

  const cerr = await cdp.consoleErrors()
  check('页面无错误提示', !cerr, cerr || '')
} catch (err) {
  check('脚本执行', false, err.message + '\n' + (serverLog || '').slice(-1500))
} finally {
  try { await cdp.close() } catch { /* ignore */ }
  cleanup()
  try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* 沙箱不让删就留着 */ }
}

const fail = results.filter(r => !r.ok)
console.log(`\n=== 汇总: ${results.length - fail.length}/${results.length} 通过 ===`)
for (const f of fail) console.log('  FAIL', f.name, '—', f.detail)
process.exit(fail.length ? 1 : 0)
