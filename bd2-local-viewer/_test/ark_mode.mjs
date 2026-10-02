/**
 * Ark（星陨计划 Ark Re:Code）档端到端验收。
 *
 *  覆盖 format_check 覆盖不到的那一半 —— 那些是**前端可见口径**：
 *  中文名/稀有度上卡片、多形态归组成一张卡 + 播放页形态切换、立绘网格与原图、
 *  语音列表与解码、切回 BD2 档不留残影。
 *
 *  ⚠ 需要真实素材（20GB+，用户自己的 Ark 目录）。根目录从环境变量读：
 *    BD2_ARK_ROOT=C:/path/to/runtime/source node _test/ark_mode.mjs
 *  没给或目录不存在 → 整段跳过并判 PASS（别把「没素材」报成回归）。
 *  路径写死在代码里会随机器失效，所以走环境变量。
 *
 *  自己在同一个脚本里 spawn server.mjs（BD2_CONFIG 指向临时配置），
 *  跑完 kill —— 别用 shell `&` 起后台，工具一返回子进程就被杀。
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
// 服务端会用 findFreePort 从配置端口顺延避让，占用时就换一个 —— 所以实际端口
// 从启动横幅里读出来，别写死。
let BASE = ''

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/* ---------------------------------------------------------- 素材：没有就跳过 */
const ARK_ROOT = process.env.BD2_ARK_ROOT || ''
const SKIP = !ARK_ROOT || !fs.existsSync(ARK_ROOT)
if (SKIP) {
  console.log('SKIP  未设置 BD2_ARK_ROOT（或目录不存在）→ 跳过 Ark 端到端验收')
  console.log('      形如：BD2_ARK_ROOT=C:/path/to/星陨计划.../runtime/source')
  process.exit(0)
}

/* ---------------------------------------------------------- 拉起服务端 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-mode-'))
const cfg = path.join(work, 'viewer.config.json')
fs.writeFileSync(cfg, JSON.stringify({
  port: 8199,
  roots: [{ id: 'ark', path: ARK_ROOT, label: 'Ark Re:Code 素材', game: 'ark' }],
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
  // 先从横幅里抠出真实端口
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
      const r = await fetch(`${BASE}/api/scan?root=ark&mode=ark`)
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

  console.log('\n=== 1. 切到 ark 档 ===')
  await cdp.goto(`${BASE}/?mode=ark`)
  try {
    // waitFor 自己会包 !!()，别在表达式里写 return
    await cdp.waitFor(`window.__bd2viewer`, 20000, '__bd2viewer 就绪')
  } catch (e) {
    const diag = await cdp.evaluate(`
      return {
        url: location.href,
        title: document.title,
        hasBody: !!document.body,
        bodyChildren: document.body ? document.body.children.length : -1,
        scripts: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')),
        readyState: document.readyState,
        dbg: typeof window.__bd2viewer,
      }
    `)
    console.log('    诊断:', JSON.stringify(diag))
    console.log('    错误框:', await cdp.consoleErrors())
    throw e
  }
  // 切档：setAssetMode 会落盘 + 重扫。等模式真的变成 ark 且条目渲染出来。
  await cdp.evaluate(`
    window.__bd2viewer.setAssetMode('ark')
    // 上限 20s：evaluate 超时给 40s（见下面第二个参数），留足余量 ——
    // 循环顶满 evaluate 超时的话，报出来的是看不懂的「超时: Runtime.evaluate」，
    // 看不出其实是没等到 / 出了别的问题。
    for (let i = 0; i < 200; i++) {
      const n = document.querySelectorAll('#galGrid .card').length
      if (window.__bd2viewer.mode === 'ark' && n > 5) return true
      await new Promise(r => setTimeout(r, 100))
    }
    return false
  `, 40000)
  const st = await cdp.evaluate(`
    const v = window.__bd2viewer
    const cards = [...document.querySelectorAll('#galGrid .card')]
    const name = c => (c.querySelector('.card-name') || {}).textContent || ''
    const sub = c => (c.querySelector('.card-sub') || {}).textContent || ''
    return {
      mode: v.mode,
      cards: cards.length,
      // 按 relAtlas 排序时画册（A000x）一定排在角色（H001）前面 ——
      // 所以不能只看前几张就判「有没有中文名」，要全量分类统计。
      named: cards.filter(c => /[一-鿿]/.test(name(c))).length,
      idOnly: cards.filter(c => /^[A-Z]\\d+$/.test(name(c))).length,
      firstNamed: cards.map(name).find(n => /[一-鿿]/.test(n)) || null,
      multiSub: cards.map(sub).find(s => /形态/.test(s)) || null,
      raritySub: cards.map(sub).find(s => /✦/.test(s)) || null,
    }
  `)
  check('模式 = ark', st.mode === 'ark', st.mode)
  check('卡片已渲染', st.cards > 50, `${st.cards} 张`)
  check('卡片显示中文名', st.named > 100, `${st.named} 张中文名（例：${st.firstNamed}）`)
  check('无中文名的退回 bundle id', st.idOnly > 50, `${st.idOnly} 张显示 id`)
  check('副标题含稀有度', !!st.raritySub, st.raritySub || '没找到 ✦ 副标题')
  check('副标题含形态数', !!st.multiSub, st.multiSub || '没找到形态副标题')

  console.log('\n=== 2. 找一个多形态角色并打开 ===')
  // 挑**角色目录**里带中文名 + 有立绘/语音的那张卡（画册 A0001 那些没有 meta.character，
  // 用它们测立绘/语音只会得到空列表）。先在搜索框里打中文名缩小范围。
  const pick = await cdp.evaluate(`
    const v = window.__bd2viewer
    // 直接从状态里挑，再 selectItem —— 比在 DOM 上猜哪个是哪个可靠
    const S = v.state
    const cands = S.items.filter(i => i.ark && i.ark.charName && Array.isArray(i.ark.statics) && i.ark.statics.length
      && Array.isArray(i.ark.voices) && i.ark.voices.length)
    const multi = cands.find(i => Array.isArray(i.members) && i.members.length > 1) || cands[0]
    if (!multi) return { err: '没有带立绘+语音的角色条目', withName: S.items.filter(i => i.ark && i.ark.charName).length }
    v.setView('player')
    v.selectItem(multi)
    return { base: multi.base, charId: multi.ark.charId, charName: multi.ark.charName,
             forms: (multi.members || []).length, statics: multi.ark.statics.length, voices: multi.ark.voices.length,
             rarity: multi.ark.rarity, rel: multi.relAtlas,
             static0: multi.ark.statics[0] && multi.ark.statics[0].url,
             voice0: multi.ark.voices[0] && multi.ark.voices[0].url }
  `)
  console.log('    选中:', JSON.stringify(pick))
  if (pick && pick.err) {
    check('找到带立绘+语音的角色', false, pick.err)
  } else {
    check('找到带立绘+语音的角色', true, `${pick.charName} (${pick.base}) 形态${pick.forms} 立绘${pick.statics} 语音${pick.voices}`)
    // 等 onLoaded —— 别等 currentName（loadCurrent 开头就同步设好了，永远立刻满足）。
    // 真正的信号是动画列表非空，或者错误框弹出来。
    const waited = await cdp.evaluate(`
      for (let i = 0; i < 200; i++) {
        const err = document.getElementById('errorBox')
        if (err && !err.hidden && err.textContent) return 'ERR: ' + err.textContent.slice(0, 200)
        if ((window.__bd2viewer.animations || []).length > 0) return 'OK'
        await new Promise(r => setTimeout(r, 100))
      }
      return 'TIMEOUT'
    `, 40000)
    console.log('    载入:', waited)
    /* 立绘网格是 loading="lazy"（renderArkStatics），刚建好时首格可能还没开始下载。
       采样 naturalWidth 必须**等它解码完**，否则读到 complete:false 就误报。
       2026-10-02踩过：断言里写了「等一小会儿」的注释但代码没等 → 首格必红。 */
    const staticImg = await cdp.evaluate(`
      const sel = '#arkStaticGrid .ark-static-cell img'
      for (let i = 0; i < 100; i++) {
        const el = document.querySelector(sel)
        if (el && el.complete && el.naturalWidth > 0) {
          return { w: el.naturalWidth, complete: el.complete, src: el.getAttribute('src') }
        }
        await new Promise(r => setTimeout(r, 100))
      }
      const el = document.querySelector(sel)
      return el ? { w: el.naturalWidth, complete: el.complete, src: el.getAttribute('src') } : null
    `, 30000)
    console.log('    立绘首格:', JSON.stringify(staticImg))
    const pl = await cdp.evaluate(`
      const v = window.__bd2viewer
      const btns = [...document.querySelectorAll('#poseBar .gm-btn')]
      return {
        name: document.getElementById('currentName').textContent,
        sub: document.getElementById('currentSub').textContent,
        poseLabels: btns.map(b => b.textContent),
        poseTitles: btns.map(b => b.title),
        poseCur: v.pose,
        anims: v.animations ? v.animations.length : -1,
        staticsShown: !document.getElementById('arkStaticGroup').hidden,
        staticCells: document.querySelectorAll('#arkStaticGrid .ark-static-cell').length,
        voicesShown: !document.getElementById('arkVoiceGroup').hidden,
        voiceRows: document.querySelectorAll('#arkVoiceList .list-item').length,
        staticImgOk: (() => {
          const i = document.querySelector('#arkStaticGrid .ark-static-cell img')
          if (!i) return null
          return { w: i.naturalWidth, complete: i.complete, src: i.getAttribute('src') }
        })(),
      }
    `)
    console.log('    ' + JSON.stringify(pl, null, 0))
    check('播放页显示中文名', /[一-鿿]/.test(pl.name), pl.name)
    check('形态条出现', pl.poseLabels.length >= 2, pl.poseLabels.join(' / '))
    check('形态名不是 bundle id', !pl.poseLabels.some(l => /^(H|B|CG)[\d_]+$/.test(l)), pl.poseLabels.join(' / '))
    check('动画非空', pl.anims > 0, `${pl.anims} 个`)
    check('立绘网格已渲染', pl.staticCells > 0, `${pl.staticCells} 格`)
    check('立绘缩略图真的解码了', !!pl.staticImgOk && pl.staticImgOk.w > 0, JSON.stringify(pl.staticImgOk))
    check('语音列表已渲染', pl.voiceRows > 0, `${pl.voiceRows} 条`)
    await cdp.screenshot(path.join(work, 'ark_player.png'))
    console.log('    截图: ' + path.join(work, 'ark_player.png'))

    console.log('\n=== 3. 切形态 ===')
    if (pl.poseLabels.length >= 2) {
      const before = pl.poseCur
      await cdp.evaluate(`
        const bs = [...document.querySelectorAll('#poseBar .gm-btn')]
        const target = bs.find(b => b.getAttribute('aria-pressed') !== 'true')
        if (!target) return 'no-other'
        target.click()
        return target.textContent
      `)
      const sw = await cdp.evaluate(`
        for (let i = 0; i < 200; i++) {
          const err = document.getElementById('errorBox')
          if (err && !err.hidden && err.textContent) return 'ERR: ' + err.textContent
          const bs = [...document.querySelectorAll('#poseBar .gm-btn')]
          const on = bs.find(b => b.getAttribute('aria-pressed') === 'true')
          if (on && on.textContent !== ${JSON.stringify(pl.poseLabels[0])}) {
            return { pose: on.textContent, anims: (window.__bd2viewer.animations || []).length, sub: document.getElementById('currentSub').textContent }
          }
          await new Promise(r => setTimeout(r, 100))
        }
        return null
      `, 40000)
      if (sw && typeof sw === 'object') {
        check('形态已切换', sw.pose !== pl.poseLabels[0], `${before} → ${sw.pose}（${sw.anims} 动画）`)
        check('切形态后副标题跟着换', /形态|CG|本体|战斗/.test(sw.sub), sw.sub)
      } else {
        check('形态已切换', false, String(sw))
      }
    }

    console.log('\n=== 4. 点立绘看原图 ===')
    const img = await cdp.evaluate(`
      const c = document.querySelector('.ark-static-cell')
      if (!c) return 'no-cell'
      c.click()
      await new Promise(r => setTimeout(r, 400))
      const i = document.getElementById('arkFullImage')
      if (!i) return 'no-img'
      return { ok: i.naturalWidth > 0, w: i.naturalWidth, h: i.naturalHeight, sub: document.getElementById('currentSub').textContent }
    `, 30000)
    if (img && typeof img === 'object') {
      check('立绘原图打开且解码', img.ok, `${img.w}x${img.h} · ${img.sub}`)
      await cdp.screenshot(path.join(work, 'ark_art.png'))
      await cdp.evaluate(`document.getElementById('arkImageLayer').click()`)
      await cdp.evaluate(`
        for (let i = 0; i < 150; i++) {
          if (!document.getElementById('arkImageLayer')) return true
          await new Promise(r => setTimeout(r, 100))
        }
        return false
      `, 30000)
      check('关掉原图后回到骨骼画面', await cdp.evaluate(`return !document.getElementById('arkImageLayer')`))
    } else {
      check('立绘原图打开', false, String(img))
    }

  console.log('\n=== 5. 语音 ===')
  // ⚠️ 别用 querySelectorAll('audio') 判成败 —— playArkVoice 用的是 `new Audio()`，
  // 元素从不挂进 DOM，DOM 里永远查不到。要听 play() 的 promise 与 readyState。
  const voice = await cdp.evaluate(`
    const b = document.querySelector('#arkVoiceList .list-item .btn')
    if (!b) return 'no-btn'
    const row = b.closest('.list-item')
    const src = window.__bd2viewer.state.current.ark.voices[0].url
    b.click()
    // 轮询等解码完成，别死等固定时长 —— 头几毫秒 readyState 常常还是 0
    for (let i = 0; i < 60; i++) {
      const a = window.__bd2viewer.arkAudio
      if (a && (a.readyState >= 2 || a.error)) break
      await new Promise(r => setTimeout(r, 100))
    }
    const a = window.__bd2viewer.arkAudio
    return {
      label: b.textContent,
      src,
      probe: a || 'no-probe',
      err: document.getElementById('errorBox') ? document.getElementById('errorBox').textContent : '',
    }
  `, 30000)
  if (voice && typeof voice === 'object') {
    const p = voice.probe
    // ⚠️ headless 里没有「用户手势」，play() 常被 autoplay 策略拒 → 报「播放失败」。
    // 那不是功能坏了。真正的判据是**音频有没有解码出来**（readyState>=2 = HAVE_CURRENT_DATA）。
    const decoded = p !== 'no-probe' && p.readyState >= 2 && !p.error
    check('语音解码成功', decoded, p === 'no-probe' ? '没探到 Audio' : `readyState=${p.readyState} error=${p.error} src=${p.src}`)
    if (!decoded) {
      check('语音可点播放', false, `readyState=${p.readyState} error=${p.error}`)
    } else {
      console.log(`    注: headless 无用户手势，play() 可能被 autoplay 策略拒（错误框: ${voice.err || '无'}）—— 解码成功即功能正常`)
    }
  } else {
    check('语音解码成功', false, String(voice))
  }
  }

  console.log('\n=== 6. 初始皮肤要挑「出图最多」的那个（不是 default）===')
  // 回归锁：Ark 的 default 皮肤只带头+头发+表情+武器，全身衣服在 LV1/LV2/LV3 里。
  // 而**数槽位/数 attachments 条目都会选错**（default 声明 45 条、LV1 只有 39 条，
  // 但实际出图 default=42、LV1=81）—— 唯一可信的口径是「摆好姿势后可见的附件数」。
  // 症状：立绘和动画都只有一个头。
  const skinProbe = await cdp.evaluate(`
    const v = window.__bd2viewer
    const hit = (v.state.items || []).find(i => /H092/.test(i.relSkeleton || ''))
    if (!hit) return { skipped: true }
    await v.selectItem(hit)
    for (let i = 0; i < 300; i++) { if (v.player && v.player.skeleton) break; await new Promise(r => setTimeout(r, 100)) }
    await new Promise(r => setTimeout(r, 1200))
    const sk = v.player.skeleton
    let visible = 0
    for (const s of sk.slots) if (s.getAttachment()) visible++
    // 逐皮肤实测出图量（复刻产品口径，顺便证明 default 确实是最差的）
    const rt = v.player.__spineRt || window.spine
    const per = {}
    for (const nm of (sk.data.skins || []).map(s => s.name)) {
      try {
        sk.setSlotsToSetupPose(); sk.setSkinByName(nm); sk.setSlotsToSetupPose()
        sk.updateWorldTransform(0, 0, 0); sk.setToSetupPose()
        let n = 0
        for (const s of sk.slots) if (s.getAttachment()) n++
        per[nm] = n
      } catch (e) { per[nm] = -1 }
    }
    void rt
    return {
      skipped: false,
      charName: hit.ark && hit.ark.charName,
      picked: (document.getElementById('skinSelect') || {}).value,
      visible,
      per,
    }
  `, 60000)
  if (skinProbe.skipped) {
    check('初始皮肤挑出图最多的（素材里没有 H092，跳过）', true, '跳过')
  } else {
    const per = skinProbe.per || {}
    const names = Object.keys(per)
    const maxN = Math.max(...names.map(n => per[n]))
    const defaultN = per.default
    console.log(`    ${skinProbe.charName}：选中 ${skinProbe.picked}，出图 ${skinProbe.visible}；` +
      `各皮肤出图量 ${names.map(n => n + '=' + per[n]).join(' ')}`)
    check('初始皮肤不是残缺的 default（Ark 的 default 只有一个头）',
      skinProbe.picked !== 'default' && skinProbe.visible > 60,
      `选中=${skinProbe.picked} 出图=${skinProbe.visible} default=${defaultN} 最多=${maxN}`)
    check('实际选中的皮肤就是出图最多的那个',
      skinProbe.visible === maxN,
      `选中=${skinProbe.picked} 出图=${skinProbe.visible} 最多=${maxN}`)
  }

  console.log('\n=== 7. 切回 BD2 不受影响 ===')
  await cdp.evaluate(`
    window.__bd2viewer.setAssetMode('bd')
    for (let i = 0; i < 200; i++) {
      if (window.__bd2viewer.mode === 'bd') return true
      await new Promise(r => setTimeout(r, 100))
    }
    return false
  `, 40000)
  const back = await cdp.evaluate(`
    return {
      mode: window.__bd2viewer.mode,
      staticHidden: document.getElementById('arkStaticGroup').hidden,
      voiceHidden: document.getElementById('arkVoiceGroup').hidden,
    }
  `)
  check('切回 BD2', back.mode === 'bd', back.mode)
  check('BD2 档立绘/语音组已收起', back.staticHidden && back.voiceHidden, JSON.stringify(back))

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
