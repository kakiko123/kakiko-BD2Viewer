/**
 * 交错战线图鉴（JCZX 已解包发布包）档端到端验收。
 *
 *  覆盖 format_check 覆盖不到的那一半 —— 那些是**前端可见口径 + 真机播放**：
 *  · 扫得进已解包层（source / mod1 / mod2），mod 条目不再被「只保留缓存目录」锁丢掉
 *  · 中文名（皮肤代号 → wiki 名表）上卡片
 *  · 形态归组：多皮肤收成一张卡 + 播放页形态切换
 *  · **mod 和原图切换**：mod 栏列出 原图/mod1/mod2，切过去播的确实是 mod 的骨架
 *    （原图 4.2 与 mod 3.8 各播一次 —— 3.8 走 spineJson38to41 转 4.1）
 *  · 「只看 Mod」档：mod 各占一张卡、原图层收起来
 *  · 切回 BD2 档不留残影
 *
 *  ⚠ 需要真实素材（29G，用户自己的图鉴发布包）。根目录从环境变量读：
 *    BD2_JCZX_ROOT=C:/path/to/交错战线图鉴-20260917 node _test/jczx_mode.mjs
 *  没给或目录不存在 → 整段跳过并判 PASS（别把「没素材」报成回归）。
 *
 *  自己在同一个脚本里 spawn server.mjs（BD2_CONFIG 指向临时配置），跑完 kill。
 *  注意别并行开第二个 Chrome：cdp.mjs 端口写死 9333。
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
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
const JCZX_ROOT = process.env.BD2_JCZX_ROOT || ''
const SKIP = !JCZX_ROOT || !fs.existsSync(JCZX_ROOT)
if (SKIP) {
  console.log('SKIP  未设置 BD2_JCZX_ROOT（或目录不存在）→ 跳过交错战线图鉴端到端验收')
  console.log('      形如：BD2_JCZX_ROOT=C:/path/to/交错战线图鉴-20260917')
  process.exit(0)
}
// 这套布局的判定依据：根下要有 source/角色 且有 mod 层目录。
// 只有 source/ 没有 mod 层 → 是普通的散装 jczx 素材，本套件大部分用例会失效。
const HAS_MOD_LAYER = ['mod1', 'mod2'].some(d => fs.existsSync(path.join(JCZX_ROOT, d)))
if (!HAS_MOD_LAYER) {
  console.log('SKIP  根下没有 mod1/ mod2 层 → 不是图鉴发布包布局，跳过')
  process.exit(0)
}

/* ---------------------------------------------------------- 拉起服务端 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jczx-mode-'))
const cfg = path.join(work, 'viewer.config.json')
fs.writeFileSync(cfg, JSON.stringify({
  port: 8201,
  maxDepth: 6,
  roots: [{ id: 'jczx', path: JCZX_ROOT, label: '交错战线图鉴' }],
}, null, 2), 'utf-8')
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
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/scan?root=jczx&mode=jczx`)
      if (r.ok) return true
    } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error('服务端未就绪 @ ' + BASE + '\n' + serverLog.slice(-2000))
}

/** 播放页是否已经挂上一个有动画的骨架（等异步链末端，不等时长） */
const PLAYING = `
  (() => {
    const v = window.__bd2viewer
    const p = v && v.state && v.state.player
    const sk = p && p.skeleton
    if (!sk) return false
    const anims = (sk.data && sk.data.animations) || []
    return anims.length > 0 && !!(p.animationState && p.animationState.data)
  })()
`

const cdp = await Cdp.launch({ size: '1680,950' })
try {
  console.log('\n=== 0. 服务端 ===')
  await waitServer()
  check('服务端就绪', true, BASE)

  console.log('\n=== 1. 切到 jczx 档 ===')
  await cdp.goto(`${BASE}/?mode=jczx`)
  await cdp.waitFor(`window.__bd2viewer`, 20000, '__bd2viewer 就绪')
  // 首次可能弹语言选择框 —— 它会盖住播放页，先关掉。
  //
  // ⚠️ **必须等卡片数稳定，不能只等 >0**：网格是分批追加的，第一张卡出现得很快，
  // 后面还有上千张（实测「>0」就返回 → 拿到 1 张，后续断言全在错误的数量上跑）。
  // 这里连续 3 次读到同一个非零数才算稳。
  const cardCount = await cdp.evaluate(`
    // ⚠️ 必须关掉「缩略图落盘」（需求 5 的功能）：不关的话跑一次测试就往**用户的图鉴素材**
    // 里写一堆 thumb.png（本机实测已积累 155 个）。别的套件都关了，这里是漏的。
    window.__bd2viewer.setThumbPersist(false)
    window.__bd2viewer.setAssetMode('jczx')
    let last = -1, same = 0
    for (let i = 0; i < 600; i++) {
      const n = document.querySelectorAll('#galGrid .card').length
      if (n > 0 && n === last) { if (++same >= 3) return n } else same = 0
      last = n
      await new Promise(r => setTimeout(r, 250))
    }
    return document.querySelectorAll('#galGrid .card').length
  `, 200000)
  check('网格里出卡了', cardCount > 1, `${cardCount} 张`)

  console.log('\n=== 2. 扫描口径：mod 层收进来了 ===')
  const scan = await cdp.evaluate(`
    const v = window.__bd2viewer
    const items = (v.state && v.state.items) || []
    const byLayer = {}
    let withTarget = 0, marked = 0
    const bare = []
    for (const it of items) {
      if (!it.jczx) { if (bare.length < 5) bare.push(it.relAtlas || it.atlas || '?'); continue }
      marked++
      byLayer[it.jczx.layer] = (byLayer[it.jczx.layer] || 0) + 1
      if (it.jczx.targetKey) withTarget++
    }
    return { total: items.length, marked, bare, byLayer, withTarget }
  `)
  check('扫到已解包条目（不是 0）', scan.total > 0, `${scan.total} 条`)
  check('source 层收进来了', (scan.byLayer.source || 0) > 0, `source=${scan.byLayer.source || 0}`)
  check('mod 层收进来了', (scan.byLayer.mod1 || 0) + (scan.byLayer.mod2 || 0) > 0,
    `mod1=${scan.byLayer.mod1 || 0} mod2=${scan.byLayer.mod2 || 0}`)
  // 绝大多数条目必须落在图鉴布局里且能对齐到槽位。允许极少数例外（比如用户
  // 自己丢在根下的散装文件），但要把例外列出来 —— 「静默漏标」是真正要防的。
  check('绝大多数条目落在图鉴布局里', scan.marked / scan.total >= 0.99,
    `${scan.marked}/${scan.total}`)
  check('已标记的都有 targetKey（mod↔原图 对齐依据）', scan.withTarget === scan.marked,
    `${scan.withTarget}/${scan.marked}`)
  if (scan.bare.length) console.log('    未标记样本:', JSON.stringify(scan.bare))

  console.log('\n=== 3. 卡片显示：中文名 + mod 数 ===')
  const cardInfo = await cdp.evaluate(`
    const v = window.__bd2viewer
    const vis = v.allItems()
    let named = 0, withMods = 0
    for (const it of vis) {
      if (it.ark && it.ark.charName) named++
      if (it.jczx && it.jczx.layerKind === 'source' && v.modCountOf(it) > 0) withMods++
    }
    const first = vis.find(i => v.modCountOf(i) > 0) || vis[0]
    return {
      visCount: vis.length, named, withMods,
      sample: first ? { name: first.ark && first.ark.charName, id: first.ark && first.ark.charId,
                         mods: v.modCountOf(first), rel: first.relAtlas } : null,
    }
  `)
  check('可见卡片有中文名', cardInfo.named > 0, `${cardInfo.named}/${cardInfo.visCount}`)
  check('有卡片挂了 mod 链', cardInfo.withMods > 0, `${cardInfo.withMods} 张`)
  console.log('    样本:', JSON.stringify(cardInfo.sample))

  console.log('\n=== 4. 归组：一个角色的多个皮肤收成一张卡 ===')
  const grouped = await cdp.evaluate(`
    const v = window.__bd2viewer
    const vis = v.allItems()
    const multi = vis.filter(i => Array.isArray(i.members) && i.members.length > 1)
    const withModsMulti = multi.filter(i => i.members.some(m => v.modCountOf(m) > 0))
    // 可见列表里同一个 charId 只能出现一次（形态收干净了）
    const seen = new Map()
    let dup = 0
    for (const it of vis) {
      const id = it.ark && it.ark.charId
      if (!id) continue
      if (seen.has(id)) dup++
      seen.set(id, 1)
    }
    return { multiCount: multi.length, withModsMulti: withModsMulti.length, dupCharIds: dup }
  `)
  check('有卡片是多形态归组', grouped.multiCount > 0, `${grouped.multiCount} 张`)
  check('同一角色没在网格里重复出现', grouped.dupCharIds === 0, `重复 ${grouped.dupCharIds} 个`)

  console.log('\n=== 5. 打开一个带 mod 的角色，原图能播 ===')
  const opened = await cdp.evaluate(`
    const v = window.__bd2viewer
    const vis = v.allItems()
    // 优先挑「多形态 + 每个形态都有 mod」且可播的（3.8 转换路径也一起覆盖）
    let target = vis.find(i => Array.isArray(i.members) && i.members.length > 1
      && i.members.every(m => v.modCountOf(m) > 0) && i.ok)
    if (!target) target = vis.find(i => v.modCountOf(i) > 0 && i.ok)
    if (!target) return { picked: null }
    v.selectItem(target)
    return { picked: { rel: target.relAtlas, name: target.ark && target.ark.charName,
                        forms: (target.members || []).length } }
  `)
  check('挑到一个带 mod 的角色', !!opened.picked, JSON.stringify(opened.picked))
  if (opened.picked) {
    let ok = false
    try {
      await cdp.waitFor(PLAYING, 90000, '原图骨架播起来')
      ok = true
    } catch { /* 下面报细节 */ }
    const playInfo = await cdp.evaluate(`
      const v = window.__bd2viewer
      const p = v.state && v.state.player
      const sk = p && p.skeleton
      const it = v.activeSpineItemOf(v.state.current)
      return {
        minor: p && p.__spineMinor,
        anims: sk && sk.data ? (sk.data.animations || []).length : 0,
        rel: it && it.relAtlas,
        layer: it && it.jczx && it.jczx.layerLabel,
        modBarShown: !document.getElementById('modGroup').hidden,
        modBtns: [...document.querySelectorAll('#modBar .gm-btn')].map(b => b.textContent),
      }
    `)
    check('原图播得起来', ok, `runtime=${playInfo.minor} 动画 ${playInfo.anims} 个`)
    check('当前是原图层', playInfo.layer === '原图', String(playInfo.layer))
    check('mod 栏出现了', playInfo.modBarShown, playInfo.modBtns.join(' / '))
    check('mod 栏第一项是原图', playInfo.modBtns[0] === '原图', playInfo.modBtns[0])

    console.log('\n=== 6. 切到 mod（3.8 骨架走 38→41 转换） ===')
    const before = await cdp.evaluate(`
      const v = window.__bd2viewer
      const p = v.state && v.state.player
      const it = v.activeSpineItemOf(v.state.current)
      return { rel: it && it.relAtlas, minor: p && p.__spineMinor,
               anims: (p && p.skeleton && p.skeleton.data.animations || []).length }
    `)
    // 点 mod 栏的第二个按钮
    const clicked = await cdp.evaluate(`
      const btns = [...document.querySelectorAll('#modBar .gm-btn')]
      if (btns.length < 2) return false
      btns[1].click()
      return true
    `)
    check('mod 栏可点（有第 2 项）', clicked)
    let modOk = false
    try {
      await cdp.waitFor(PLAYING, 90000, 'mod 骨架播起来')
      modOk = true
    } catch { /* 下面报细节 */ }
    const after = await cdp.evaluate(`
      const v = window.__bd2viewer
      const p = v.state && v.state.player
      const it = v.activeSpineItemOf(v.state.current)
      return {
        rel: it && it.relAtlas, layer: it && it.jczx && it.jczx.layerLabel,
        modId: it && it.jczx && it.jczx.modId,
        minor: p && p.__spineMinor,
        anims: (p && p.skeleton && p.skeleton.data.animations || []).length,
        err: (document.getElementById('errorBox') || {}).textContent || '',
        sub: (document.getElementById('currentSub') || {}).textContent || '',
      }
    `)
    check('mod 播得起来', modOk, `runtime=${after.minor} 动画 ${after.anims} 个 layer=${after.layer}`)
    check('确实换成了 mod 那份骨架', after.rel !== before.rel,
      `${before.rel} → ${after.rel}`)
    check('mod 层标记正确（非原图）', after.layer && after.layer !== '原图', String(after.layer))
    check('副标题标出了 mod 层', /mod/i.test(after.sub), after.sub)
    if (!modOk) console.log('    错误框:', after.err)

    console.log('\n=== 7. 切回原图（走完回到原图，和图鉴 App 一致） ===')
    const backOk = await cdp.evaluate(`
      const v = window.__bd2viewer
      const btns = [...document.querySelectorAll('#modBar .gm-btn')]
      if (!btns.length) return false
      btns[0].click()   // 原图
      return true
    `)
    check('能点回原图', backOk)
    let backPlaying = false
    try {
      await cdp.waitFor(PLAYING, 90000, '原图重新播起来')
      backPlaying = true
    } catch { /* ignore */ }
    const back = await cdp.evaluate(`
      const v = window.__bd2viewer
      const it = v.activeSpineItemOf(v.state.current)
      return { rel: it && it.relAtlas, layer: it && it.jczx && it.jczx.layerLabel }
    `)
    check('切回原图后播得起来', backPlaying, back.layer)
    check('确实回到原图层', back.layer === '原图', String(back.layer))
  }

  /* ------------------------------------------------- R27 默认关闭 hexie / tape 图层 */
  console.log('\n=== 7b. jczx 档默认不开启 hexie / tape 图层（R27）===')
  // 先从可见条目里找一个**骨架内容真含** hexie/tape 的（本地读盘判断，
  // 不写死具体角色 id —— 素材换了也不会失效）。
  // ⚠️ 本地（Node）可以用正则；cdp.evaluate 的模板串里**不许写正则**（踩过坑），
  // 所以浏览器那段一律用 includes。
  const visible = await cdp.evaluate(`
    return window.__bd2viewer.allItems()
      .filter(i => i.ok && i.relSkeleton && i.relAtlas)
      .map(i => ({ rel: i.relAtlas, skel: i.relSkeleton }))
  `)
  const MARK = /hexie|tape/i
  let hit = null
  for (const c of (visible || [])) {
    const abs = path.join(JCZX_ROOT, String(c.skel).split('/').join(path.sep))
    let buf
    try { buf = fs.readFileSync(abs) } catch { continue }
    if (MARK.test(buf.toString('latin1'))) { hit = c; break }
  }
  check('真实素材里存在含 hexie/tape 的骨架（否则本用例无意义）', !!hit,
    hit ? hit.skel : `查了 ${(visible || []).length} 个可见条目都没命中`)
  if (hit) {
    let up = false
    try {
      const found = await cdp.evaluate(`
        const v = window.__bd2viewer
        const t = v.allItems().find(i => i.relAtlas === ${JSON.stringify(hit.rel)})
        if (t) v.selectItem(t)
        return !!t
      `)
      if (found) { await cdp.waitFor(PLAYING, 90000, 'hexie/tape 骨架播起来'); up = true }
    } catch { /* 下面报细节 */ }
    check('这个骨架能打开并播起来', up)
    const layerInfo = await cdp.evaluate(`
      const v = window.__bd2viewer
      const S = v.state
      const KEYS = ['hexie', 'tape']
      const isHit = n => { const s = String(n).toLowerCase(); return KEYS.some(k => s.includes(k)) }
      const slots = (S.slots || [])
      const matched = slots.filter(isHit)
      const rows = [...document.querySelectorAll('#layerList .layer-row')]
        .map(el => ({
          name: (el.querySelector('.name') || {}).textContent || '',
          checked: !!(el.querySelector('input') || {}).checked,
        }))
        .filter(r => isHit(r.name))
      return {
        total: slots.length,
        matched: matched,
        hiddenMatched: matched.filter(n => S.hidden.has(n)),
        hiddenOther: [...S.hidden].filter(n => !isHit(n)),
        rows: rows,
      }
    `)
    check('骨架里确实有 hexie/tape 图层', layerInfo.matched.length > 0,
      `共 ${layerInfo.total} 槽，命中 ${layerInfo.matched.length}：${layerInfo.matched.slice(0, 5).join(', ')}`)
    check('这些图层默认全被关掉',
      layerInfo.matched.length > 0 && layerInfo.hiddenMatched.length === layerInfo.matched.length,
      `隐藏 ${layerInfo.hiddenMatched.length}/${layerInfo.matched.length}`)
    check('没有误伤别的图层', layerInfo.hiddenOther.length === 0,
      layerInfo.hiddenOther.slice(0, 5).join(', ') || '（无）')
    check('图层列表里这些行的勾确实是空的',
      layerInfo.rows.length === layerInfo.matched.length && layerInfo.rows.every(r => r.checked === false),
      `${layerInfo.rows.filter(r => !r.checked).length}/${layerInfo.rows.length} 未勾`)

    // 平铺页缩略图走的是**离屏渲染**（不经 S.hidden、也没有逐帧回调）—— 同一条规则也得生效。
    // ⚠️ 断言方式：比对两张缩略图**不可靠**（两次渲染的动画时刻不同，图必然不同，
    // 差多少都说明不了问题）。所以用计数器断言「这条路真的执行了、且关掉规则后归零」。
    const thumbRule = await cdp.evaluate(`
      const v = window.__bd2viewer
      const it = v.allItems().find(i => i.relAtlas === ${JSON.stringify(hit.rel)})
      if (!it) return { err: '条目不在可见列表' }
      v.setThumbPersist(false)          // 绝不往用户素材目录写 thumb.png
      const keys = v.defaultHiddenLayerKeys
      v.resetThumbLayerHide()
      await v.makeThumb(it, 220)
      const on = v.thumbLayerHide
      v.setDefaultHiddenLayerKeys([])   // 临时清空规则，作为对照
      v.resetThumbLayerHide()
      await v.makeThumb(it, 220)
      const off = v.thumbLayerHide
      v.setDefaultHiddenLayerKeys(keys) // 复原
      return { on: on, off: off, keys: v.defaultHiddenLayerKeys, err: null }
    `, 120000)
    check('缩略图（离屏渲染）也执行了默认关闭',
      !thumbRule.err && thumbRule.on.calls > 0 && thumbRule.on.slots > 0,
      thumbRule.err || JSON.stringify(thumbRule.on))
    check('把规则键清空后缩略图不再关任何图层（证明是这条规则在起作用）',
      !thumbRule.err && thumbRule.off.slots === 0, JSON.stringify(thumbRule.off))
    check('规则键用完复原（没污染后续用例）',
      !thumbRule.err && thumbRule.keys.length === 2, JSON.stringify(thumbRule.keys))
  }

  console.log('\n=== 8. 「只看 Mod」档 ===')
  const modOnly = await cdp.evaluate(`
    const v = window.__bd2viewer
    const before = v.allItems().length
    const chk = document.getElementById('chkModsOnly')
    if (!chk) return { noCheckbox: true }
    chk.checked = true
    chk.dispatchEvent(new Event('change'))
    for (let i = 0; i < 60; i++) {
      const n = document.querySelectorAll('#galGrid .card').length
      if (n > 0 && v.allItems().length !== before) break
      await new Promise(r => setTimeout(r, 150))
    }
    const vis = v.allItems()
    let modCards = 0, srcCards = 0
    for (const it of vis) {
      if (!it.jczx) continue
      if (it.jczx.layerKind === 'mod') modCards++
      else srcCards++
    }
    return { before, after: vis.length, modCards, srcCards,
             shown: document.querySelectorAll('#galGrid .card').length }
  `, 60000)
  check('mod 档：mod 卡片出现了', modOnly.modCards > 0,
    `${modOnly.modCards} 张 mod / ${modOnly.srcCards} 张原图（原来 ${modOnly.before} 张）`)
  check('mod 档：原图层收起来了', modOnly.srcCards === 0, `${modOnly.srcCards} 张残留`)

  console.log('\n=== 9. mod 档里点开一个能播 ===')
  const modPlay = await cdp.evaluate(`
    const v = window.__bd2viewer
    const target = v.allItems().find(i => i.ok && i.jczx && i.jczx.layerKind === 'mod')
    if (!target) return { picked: null }
    v.selectItem(target)
    return { picked: { rel: target.relAtlas, layer: target.jczx.layerLabel,
                       modId: target.jczx.modId } }
  `)
  check('mod 档里挑到一个条目', !!modPlay.picked, JSON.stringify(modPlay.picked))
  if (modPlay.picked) {
    let ok = false
    try {
      await cdp.waitFor(PLAYING, 90000, 'mod 档条目播起来')
      ok = true
    } catch { /* ignore */ }
    const info = await cdp.evaluate(`
      const v = window.__bd2viewer
      const p = v.state && v.state.player
      const it = v.state.current
      return { minor: p && p.__spineMinor,
               anims: (p && p.skeleton && p.skeleton.data.animations || []).length,
               name: it && it.ark && it.ark.charName,
               err: (document.getElementById('errorBox') || {}).textContent || '' }
    `)
    check('mod 档条目播得起来', ok,
      `runtime=${info.minor} 动画 ${info.anims} 个 名字=${info.name}`)
    if (!ok) console.log('    错误框:', info.err)
  }

  console.log('\n=== 10. 切回 BD2 档不留残影 ===')
  await cdp.evaluate(`window.__bd2viewer.setAssetMode('bd')`, 60000)
  const backToBd = await cdp.evaluate(`
    const v = window.__bd2viewer
    return {
      mode: v.state && v.state.mode,
      modsOnly: v.filters.modsOnly,
      modRowHidden: document.getElementById('modFilterRow').hidden,
      modGroupHidden: document.getElementById('modGroup').hidden,
    }
  `)
  check('模式回到 bd', backToBd.mode === 'bd', String(backToBd.mode))
  check('「只看 Mod」勾被清掉', backToBd.modsOnly === false, String(backToBd.modsOnly))
  check('mod 筛选行藏起来了', backToBd.modRowHidden === true)
  check('播放页 mod 栏藏起来了', backToBd.modGroupHidden === true)

  // cdp.consoleErrors() 在某些情况下返回 null（不是空数组）——直接 .filter 会炸，
  // 而它就挂在 try 末尾，一炸整轮测试被判「测试执行」失败、把前面的结论全盖掉。
  const errors = (await cdp.consoleErrors()) || []
  const real = errors.filter(e => !/favicon|Autofill|net::ERR_ABORTED.*favicon/i.test(e))
  check('控制台没有报错', real.length === 0, real.slice(0, 3).join(' | '))
} catch (e) {
  check('测试执行', false, String(e && e.message || e))
  console.log('  诊断:', JSON.stringify(await cdp.evaluate(`
    return { url: location.href, mode: (window.__bd2viewer||{}).state
             ? window.__bd2viewer.state.mode : '?' }
  `).catch(() => ({}))))
  const cerr = await Promise.resolve(cdp.consoleErrors()).catch(() => [])
  console.log('  console:', (cerr || []).slice(0, 6).join(' | '))
} finally {
  try { await cdp.close() } catch { /* ignore */ }
  cleanup()
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
