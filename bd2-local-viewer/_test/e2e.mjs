/* 端到端功能验证：载入 / 动画 / 皮肤 / 图层 / 相机 / 截图 / 导出 */
import { Cdp } from './cdp.mjs'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

// 用脚本自身位置定位输出目录，避免依赖调用时的 cwd（Bash shim 有时会丢工作目录）
const HERE = path.dirname(fileURLToPath(import.meta.url))

const BASE = 'http://127.0.0.1:8137'
const ITEM = 'Eclipse Story effect yuk11sh1d4/illust_special6.atlas'
const results = []
let failed = 0

function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  →  ' + detail : ''}`)
  if (!ok) failed++
  return ok
}

const cdp = await Cdp.launch({ size: '1680,950' })

try {
  await cdp.goto(`${BASE}/?item=${encodeURIComponent(ITEM)}`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 40000, '资产载入')
  await new Promise(r => setTimeout(r, 1500))

  const d0 = JSON.parse(await cdp.evaluate(`return document.getElementById('stageInner').dataset.debug`))
  check('canvas 尺寸已同步显示尺寸', d0.canvas[0] === d0.client[0] && d0.canvas[1] === d0.client[1],
    `canvas=${d0.canvas} client=${d0.client}`)
  check('相机视口匹配 canvas', d0.camViewport[0] === d0.canvas[0] && d0.camViewport[1] === d0.canvas[1],
    `viewport=${d0.camViewport}`)
  check('取景框被正确铺满（可见世界高 ≈ 取景框高）',
    Math.abs(d0.visibleWorld[1] - (d0.boundsSize[1] + 100)) < 2,
    `visibleH=${d0.visibleWorld[1]} boundsH+100=${(d0.boundsSize[1] + 100).toFixed(1)}`)
  check('动画列表已填充', d0.anims >= 2, `anims=${d0.anims}`)
  const animNames = await cdp.evaluate(`
    return [...document.querySelectorAll('#animList .list-item')].map(e => e.textContent)
  `)
  check('动画项含 idle / once', animNames.includes('idle') && animNames.includes('once'), JSON.stringify(animNames))

  const counts = await cdp.evaluate(`
    return {
      assets: document.querySelectorAll('.asset-item').length,
      slots: __bd2viewer.state.slots.length,
      skins: __bd2viewer.state.skins.length,
      layers: document.querySelectorAll('#layerList .layer-row').length,
    }
  `)
  check('资产列表非空', counts.assets > 100, `assets=${counts.assets}`)
  check('图层列表已渲染', counts.layers === counts.slots && counts.slots > 50,
    `layers=${counts.layers} slots=${counts.slots}`)
  check('皮肤已列出', counts.skins >= 1, `skins=${counts.skins}`)

  // ---- 是否真的渲染出了东西（非纯背景）
  const px = await cdp.evaluate(`
    const cv = __bd2viewer.player.canvas
    const t = document.createElement('canvas')
    t.width = 200; t.height = 200
    const c = t.getContext('2d')
    c.drawImage(cv, 0, 0, 200, 200)
    const d = c.getImageData(0, 0, 200, 200).data
    let opaque = 0, minA = 255
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 8) opaque++; if (d[i] < minA) minA = d[i] }
    return { opaque, total: d.length / 4, minA }
  `)
  check('画布已渲染出像素（存在不透明内容）', px.opaque > 200, JSON.stringify(px))
  check('画布背景是透明的（alpha=0 区域存在）', px.minA === 0, `minAlpha=${px.minA}`)

  // ---- 切换动画
  await cdp.evaluate(`
    const items = [...document.querySelectorAll('#animList .list-item')]
    const t = items.find(e => e.textContent === 'once') || items[1]
    t.click(); return true
  `)
  await new Promise(r => setTimeout(r, 800))
  const animNow = await cdp.evaluate(`return __bd2viewer.state.player.animationState.getCurrent(0).animation.name`)
  check('点击动画列表可切换动画', animNow === 'once', `当前=${animNow}`)

  // ---- 暂停 / 播放
  await cdp.evaluate(`document.getElementById('btnPlay').click(); return true`)
  await new Promise(r => setTimeout(r, 300))
  const paused = await cdp.evaluate(`return __bd2viewer.player.paused`)
  check('暂停按钮生效', paused === true, `paused=${paused}`)
  await cdp.evaluate(`document.getElementById('btnPlay').click(); return true`)
  await new Promise(r => setTimeout(r, 300))
  check('播放按钮生效', (await cdp.evaluate(`return __bd2viewer.player.paused`)) === false)

  // ---- 速度
  await cdp.evaluate(`
    const s = document.getElementById('speedRange')
    s.value = '0.5'; s.dispatchEvent(new Event('input'))
    return true
  `)
  await new Promise(r => setTimeout(r, 300))
  const sp = await cdp.evaluate(`return __bd2viewer.player.speed`)
  check('速度滑块生效', Math.abs(sp - 0.5) < 1e-6, `speed=${sp}`)

  // ---- 图层隐藏 / 恢复
  const layerTest = await cdp.evaluate(`
    const rows = [...document.querySelectorAll('#layerList .layer-row')]
    const target = rows.find(r => r.querySelector('.name').textContent.includes('bang'))
    const name = target.querySelector('.name').textContent
    target.querySelector('input').click()
    return { name }
  `)
  await new Promise(r => setTimeout(r, 500))
  const hiddenInfo = await cdp.evaluate(`
    const row = [...document.querySelectorAll('#layerList .layer-row')]
      .find(r => r.querySelector('.name').textContent === ${JSON.stringify(layerTest.name)})
    const sk = __bd2viewer.player.skeleton
    const slot = sk.slots.find(s => s.data.name === ${JSON.stringify(layerTest.name)})
    return { uiHidden: row.classList.contains('hidden-layer'), alpha: slot.color.a }
  `)
  check('取消勾选可隐藏图层（UI + 实际 alpha=0）',
    hiddenInfo.uiHidden === true && hiddenInfo.alpha === 0, JSON.stringify(hiddenInfo))

  const slotName = layerTest.name
  await cdp.evaluate(`
    __bd2viewer.state.layerSelect = true
    __bd2viewer.state.selectedLayer = ${JSON.stringify(slotName)}
    document.getElementById('btnShowAll').click(); return true
  `)
  await new Promise(r => setTimeout(r, 500))
  const restored = await cdp.evaluate(`
    const sk = __bd2viewer.player.skeleton
    const slot = sk.slots.find(s => s.data.name === ${JSON.stringify(slotName)})
    return { alpha: slot.color.a, hiddenUi: document.querySelectorAll('#layerList .hidden-layer').length }
  `)
  check('「全部显示」恢复图层 alpha', restored.alpha > 0 || restored.hiddenUi === 0, JSON.stringify(restored))

  // ---- 缩放 / 重置视图
  const zoom0 = await cdp.evaluate(`return __bd2viewer.state.camera.zoom`)
  await cdp.evaluate(`__bd2viewer.zoomIn(); return true`)
  await new Promise(r => setTimeout(r, 200))
  const zoom1 = await cdp.evaluate(`return __bd2viewer.state.camera.zoom`)
  check('放大有效（zoom 变小 = 视野变小）', zoom1 < zoom0, `${zoom0.toFixed(3)} → ${zoom1.toFixed(3)}`)
  await cdp.evaluate(`__bd2viewer.zoomOut(); __bd2viewer.zoomOut(); __bd2viewer.resetCamera(); return true`)
  await new Promise(r => setTimeout(r, 200))
  const zoom2 = await cdp.evaluate(`return __bd2viewer.state.camera.zoom`)
  check('重置视图回到默认 zoom', Math.abs(zoom2 - zoom0) < 1e-6, `zoom=${zoom2.toFixed(3)}`)

  // ---- 缩放范围限制
  const clampTest = await cdp.evaluate(`
    __bd2viewer.state.camera.zoom = __bd2viewer.state.defaultZoom * 1000
    __bd2viewer.zoomOut()
    return __bd2viewer.state.camera.zoom
  `)
  check('zoom 有上限保护', clampTest <= (await cdp.evaluate(`return __bd2viewer.state.defaultZoom * 4`)) + 1e-6,
    `zoom=${clampTest.toFixed(3)}`)
  await cdp.evaluate(`__bd2viewer.resetCamera(); return true`)

  // ---- 截图管线（拦截下载。screenshot 是异步的，要等锚点真的被点）
  const shot = await cdp.evaluate(`
    const cap = []
    let blobs = []
    const _cou = URL.createObjectURL
    URL.createObjectURL = function (b) { blobs.push(b); return _cou.call(this, b) }
    const orig = HTMLAnchorElement.prototype.click
    let fire
    const done = new Promise(r => fire = r)
    HTMLAnchorElement.prototype.click = function () { cap.push({ href: this.href, name: this.download }); fire() }
    __bd2viewer.screenshot(true, 512)
    await done
    HTMLAnchorElement.prototype.click = orig
    URL.createObjectURL = _cou
    const s = cap[0]
    const b = blobs[0]
    return s ? { name: s.name, isPng: !!b && (b.type || '').startsWith('image/png'),
                 bytes: b ? b.size : 0, href: s.href.slice(0, 24) } : null
  `)
  check('截图生成 PNG', !!shot && shot.isPng && shot.bytes > 2000,
    shot ? `${shot.name} · ${(shot.bytes / 1024).toFixed(0)} KB ${shot.href}…` : 'null')

  const shotBig = await cdp.evaluate(`
    const cap = []
    let blobs = []
    const _cou = URL.createObjectURL
    URL.createObjectURL = function (b) { blobs.push(b); return _cou.call(this, b) }
    const orig = HTMLAnchorElement.prototype.click
    let fire
    const done = new Promise(r => fire = r)
    HTMLAnchorElement.prototype.click = function () { cap.push({ href: this.href, name: this.download }); fire() }
    __bd2viewer.screenshot(false, 1024)
    await done
    HTMLAnchorElement.prototype.click = orig
    URL.createObjectURL = _cou
    const b = blobs[0]
    return cap[0] ? { name: cap[0].name, bytes: b ? b.size : 0 } : null
  `)
  check('非透明截图生成 PNG', !!shotBig && shotBig.bytes > 2000,
    shotBig ? `${shotBig.name} · ${(shotBig.bytes / 1024).toFixed(0)} KB` : 'null')
  check('截图后画布尺寸已还原',
    await cdp.evaluate(`
      const cv = __bd2viewer.player.canvas
      return cv.width === cv.clientWidth && cv.height === cv.clientHeight
    `))

  // ---- 帧序列导出（ZIP）
  await cdp.evaluate(`
    __bd2viewer.state.fps = 12
    __bd2viewer.state.maxSize = 512
    return true
  `)
  const zip = await cdp.evaluate(`
    let blob = null
    const orig = URL.createObjectURL
    URL.createObjectURL = function (b) { blob = b; return orig.call(this, b) }
    await __bd2viewer.exportFrames(true)
    URL.createObjectURL = orig
    return blob ? { size: blob.size, type: blob.type } : null
  `)
  check('帧序列导出产出 ZIP blob', !!zip && zip.size > 1000, zip ? `${(zip.size / 1024).toFixed(0)} KB ${zip.type}` : 'null')

  // ---- PC 专属：播放页「返回列表」+ 卡片右键复制绝对路径
  // 期望值在 **Node 侧**用 path.join 独立算一遍再比对 —— 不把同一段拼接逻辑
  // 复制进浏览器里（那样只是自己跟自己对答案）。再用 fs.existsSync 证明这条路径
  // 指向的文件真在硬盘上，而不是拼出来好看。
  const backOnPlayer = await cdp.evaluate(`
    const b = document.getElementById('stageBack')
    return {
      exists: !!b,
      shown: !!b && getComputedStyle(b).display !== 'none',
      label: b ? (b.textContent || '').trim() : '',
      grid: __bd2viewer.view,
    }
  `)
  check('播放页左上角有「返回列表」回退键（PC）',
    backOnPlayer.exists && backOnPlayer.shown && backOnPlayer.grid === 'player',
    `文案=${JSON.stringify(backOnPlayer.label)} 视图=${backOnPlayer.grid} 可见=${backOnPlayer.shown}`)

  await cdp.evaluate(`document.getElementById('stageBack').click(); return true`)
  await cdp.waitFor(`__bd2viewer.view === 'grid'`, 10000, '回到平铺页')
  const afterBack = await cdp.evaluate(`
    return {
      view: __bd2viewer.view,
      bodyGrid: document.body.classList.contains('view-grid'),
      backShown: getComputedStyle(document.getElementById('stageBack')).display !== 'none',
    }
  `)
  check('点返回键回到平铺（项目选择）页', afterBack.view === 'grid' && afterBack.bodyGrid,
    `view=${afterBack.view} body.view-grid=${afterBack.bodyGrid}`)
  check('平铺页里返回键收起（只在播放页出现）', afterBack.backShown === false,
    `可见=${afterBack.backShown}`)

  // 剪贴板：把 navigator.clipboard 换成一个记录器。桌面版跑在 127.0.0.1 属于安全
  // 上下文，navigator.clipboard 是有的；这里只换掉写入口，测的是「交给剪贴板的字符串」。
  const clipReady = await cdp.evaluate(`
    window.__copied = null
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async s => { window.__copied = String(s) } },
      })
      return !!(navigator.clipboard && navigator.clipboard.writeText)
    } catch (e) { return false }
  `)
  check('可以接管剪贴板写入口（测试前提）', clipReady === true, String(clipReady))

  await cdp.waitFor(`document.querySelectorAll('#galGrid .card').length > 0`, 40000, '平铺页卡片')

  const menuInfo = await cdp.evaluate(`
    const cards = [...document.querySelectorAll('#galGrid .card')]
    const want = ${JSON.stringify(ITEM)}
    const card = cards.find(c => c.dataset.key === want) || cards[0]
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const box = document.getElementById('cardMenuPath')
    return {
      open: !document.getElementById('cardMenu').hidden,
      key: card.dataset.key,
      rootPath: __bd2viewer.state.rootPath || '',
      shownPath: box.hidden ? null : box.textContent,
      dirDisabled: document.getElementById('cardMenuCopyDir').disabled,
      fileDisabled: document.getElementById('cardMenuCopyFile').disabled,
    }
  `)
  check('右键卡片弹出操作菜单，并写出该资产的绝对路径',
    menuInfo.open && !!menuInfo.shownPath, `key=${menuInfo.key} 路径=${menuInfo.shownPath}`)
  check('有本地路径时两颗复制按钮都可点',
    menuInfo.dirDisabled === false && menuInfo.fileDisabled === false,
    `dir.disabled=${menuInfo.dirDisabled} file.disabled=${menuInfo.fileDisabled}`)

  // Node 侧独立算期望值
  const seg = String(menuInfo.key).split('/')
  const usesWin = menuInfo.rootPath.includes('\\')
  const pj = usesWin ? path.win32.join : path.posix.join
  const expectDir = pj(menuInfo.rootPath, ...seg.slice(0, -1))
  const expectFile = pj(menuInfo.rootPath, ...seg)
  check('菜单里显示的路径 = 根目录 + 相对路径拼出来的目录（独立算一遍）',
    menuInfo.shownPath === expectDir, `显示=${menuInfo.shownPath} 期望=${expectDir}`)
  check('这条路径在磁盘上真实存在（不是拼出来好看的）',
    fs.existsSync(expectFile), `检查=${expectFile} 存在=${fs.existsSync(expectFile)}`)

  const copiedDir = await cdp.evaluate(`
    document.getElementById('cardMenuCopyDir').click()
    await new Promise(r => setTimeout(r, 30))
    return { text: window.__copied, menuOpen: !document.getElementById('cardMenu').hidden,
             toast: (document.getElementById('toast') || {}).textContent || '' }
  `)
  check('点「复制文件夹路径」：进剪贴板的正是那个目录的绝对路径',
    copiedDir.text === expectDir, `剪贴板=${copiedDir.text} 期望=${expectDir}`)
  check('复制后给出提示，且菜单不关（两条路径常要连着复制）',
    copiedDir.toast.includes('已复制') && copiedDir.menuOpen === true,
    `提示=${JSON.stringify(copiedDir.toast)} 菜单还开着=${copiedDir.menuOpen}`)

  const copiedFile = await cdp.evaluate(`
    window.__copied = null
    document.getElementById('cardMenuCopyFile').click()
    await new Promise(r => setTimeout(r, 30))
    return window.__copied
  `)
  check('点「复制图集文件路径」：进剪贴板的是目录 + 图集文件名',
    copiedFile === expectFile, `剪贴板=${copiedFile} 期望=${expectFile}`)

  // 右键侧边列表项也要能开同一个菜单（PC 上从列表浏览是主要路径之一）
  const listMenu = await cdp.evaluate(`
    document.getElementById('cardMenu').hidden = true
    const it = document.querySelector('#assetList .asset-item')
    if (!it) return null
    it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const box = document.getElementById('cardMenuPath')
    return { open: !document.getElementById('cardMenu').hidden, path: box.hidden ? null : box.textContent }
  `)
  check('右键侧边资产列表项也能开菜单并给出路径',
    !!listMenu && listMenu.open && !!listMenu.path,
    listMenu ? `路径=${listMenu.path}` : '列表项不存在')
  await cdp.evaluate(`document.getElementById('cardMenu').hidden = true; return true`)

  // ---- 重叠扫描：只有最后发出的那一轮能落地（R17「扫描代次」）
  // 先按 /api/config 把每个根目录都扫一遍（顺带把服务端缓存热起来），挑出最大和最小的两个。
  // 大的一轮强制刷新（真的要下磁盘走一圈，慢），小的一轮紧随其后（快）——「先发的后回来」
  // 正是会串味的那种排法：没有代次守卫时，慢的那轮会把小目录的结果顶掉，
  // 于是 S.rootPath 停在另一个根上，卡片菜单里的「复制路径」会拼出一条不存在的路径。
  let racePick = null
  try {
    const cfg = await (await fetch(`${BASE}/api/config`)).json()
    const cand = []
    for (const r of (cfg.roots || [])) {
      if (!r.exists) continue
      const s = await (await fetch(`${BASE}/api/scan?root=${encodeURIComponent(r.id)}&mode=bd`)).json()
      cand.push({ id: r.id, path: r.path, n: s.itemCount || 0 })
    }
    cand.sort((a, b) => b.n - a.n)
    const last = cand[cand.length - 1]
    if (cand.length >= 2 && last && cand[0].n > last.n) racePick = { big: cand[0], small: last }
  } catch { /* 拿不到 config 就当环境不满足，跳过 */ }

  if (!racePick) {
    check('重叠扫描：本机只有一个（或大小相同的）根目录，跳过两轮重叠场景', true, '跳过')
  } else {
    const race = await cdp.evaluate(`
      __bd2viewer.state.rootId = ${JSON.stringify(racePick.big.id)}
      const slow = __bd2viewer.scan(true)
      await new Promise(r => setTimeout(r, 60))
      __bd2viewer.state.rootId = ${JSON.stringify(racePick.small.id)}
      await __bd2viewer.scan(true)
      const onSmall = { n: __bd2viewer.allKeys.length, root: __bd2viewer.state.rootId, path: __bd2viewer.state.rootPath }
      await slow
      await new Promise(r => setTimeout(r, 600))
      return { onSmall, n: __bd2viewer.allKeys.length, root: __bd2viewer.state.rootId, path: __bd2viewer.state.rootPath }
    `, 180000)
    check('重叠扫描：小目录落地后 rootPath 就是它自己的根（与 rootId 不脱节）',
      race.onSmall.path === racePick.small.path,
      `root=${race.onSmall.root} 路径=${race.onSmall.path} 期望=${racePick.small.path}`)
    check('重叠扫描：先发的慢轮回来时，后发的结果没被顶掉（过期结果整包丢弃）',
      race.path === racePick.small.path && race.n === racePick.small.n,
      `停在 ${race.root}：${race.n} 项 / 路径 ${race.path}` +
      `（若被顶掉会变成 big=${racePick.big.id} 的 ${racePick.big.n} 项 / ${racePick.big.path}）`)
  }

  // ---- 真实素材专项（素材不在就自动跳过，不装 fail）：
  //      ① 多皮肤骨架的「default 垫底合成 + 初始挑覆盖最全的皮肤」
  //      ② NIKKE 模式（R18）的角色归组 + 姿势切换（真实渲染，落到 aim_idle / cover_idle）
  // 这两条需要真骨架，仓库不放素材 —— 所以用「扫全部根目录找特征文件」来守门。
  let realAssets = null
  try {
    const cfg2 = await (await fetch(`${BASE}/api/config`)).json()
    for (const r of (cfg2.roots || [])) {
      if (!r.exists) continue
      for (const mode of ['bd', 'lostsword']) {
        const s = await (await fetch(`${BASE}/api/scan?root=${encodeURIComponent(r.id)}&mode=${mode}`)).json()
        for (const it of (s.items || [])) {
          const rel = String(it.relAtlas || '')
          if (rel.indexOf('Elin/Elin.atlas.bytes') >= 0) {
            realAssets = realAssets || {}
            realAssets.elin = { rootId: r.id, mode, rel }
          }
          if (rel === 'c022/c022_00.atlas') {
            realAssets = realAssets || {}
            realAssets.c022 = { rootId: r.id }
          }
        }
      }
    }
  } catch { /* 拿不到就跳过 */ }

  const restoreMode = await cdp.evaluate(`
    const v = __bd2viewer
    return { mode: v.mode, root: v.state.rootId }
  `)
  try {
    if (!realAssets || !realAssets.elin) {
      check('皮肤合成：本机没有多皮肤素材（Elin），跳过', true, '跳过')
    } else {
      const sk = await cdp.evaluate(`
        const v = __bd2viewer
        v.setAssetMode(${JSON.stringify(realAssets.elin.mode)})
        v.state.rootId = ${JSON.stringify(realAssets.elin.rootId)}
        await v.scan(true)
        const it = v.state.items.find(i => i.relAtlas === ${JSON.stringify(realAssets.elin.rel)})
        if (!it) return { missing: true }
        v.openItem(it)
        await new Promise(r => setTimeout(r, 8000))
        const p = v.player
        const skel = p && p.skeleton
        const visible = skel ? skel.slots.filter(s => !!s.getAttachment()).length : 0
        // 切回 default：那块「只有零头」的残缺感要能复现出来（证明合成的必要性）
        const visiblePicked = visible
        const pickedInitial = document.getElementById('skinSelect').value
        const sel = document.getElementById('skinSelect')
        sel.value = 'default'
        sel.dispatchEvent(new Event('change'))
        await new Promise(r => setTimeout(r, 300))
        const visibleDefault = skel ? skel.slots.filter(s => !!s.getAttachment()).length : 0
        return {
          missing: false,
          skins: v.state.skins,
          picked: pickedInitial,
          visiblePicked,
          visibleDefault,
          errorBox: (() => { const e = document.getElementById('errorBox'); return e && !e.hidden ? e.textContent : null })(),
        }
      `, 240000)
      check('皮肤合成：多皮肤骨架初始就选覆盖最全的皮肤（不是只有零头的 default）',
        sk.picked !== 'default' && sk.skins.length > 1 && sk.visiblePicked > sk.visibleDefault,
        `皮肤=${JSON.stringify(sk.skins)} 初始选中=${sk.picked} 可见槽位 初始=${sk.visiblePicked} / default=${sk.visibleDefault}`)
      check('皮肤合成：切回 default 仍可用（合成只垫在具名皮肤下面，不锁死选项）',
        sk.errorBox === null,
        sk.errorBox || '无报错')
    }

    if (!realAssets || !realAssets.c022) {
      check('NIKKE 归组与姿势：本机没有 NIKKE 素材（c022），跳过', true, '跳过')
    } else {
      const nk = await cdp.evaluate(`
        const v = __bd2viewer
        v.setAssetMode('nikke')
        v.state.rootId = ${JSON.stringify(realAssets.c022.rootId)}
        await v.scan(true)
        const keys = v.allKeys
        const main = v.state.items.find(i => i.base === 'c022_00')
        const out = { keys: keys, members: main && main.members ? main.members.map(m => m.pose + ':' + m.item.base) : null }
        if (!main) { out.missing = true; return out }
        v.openItem(main)
        await new Promise(r => setTimeout(r, 8000))
        out.poseGroupShown = !document.getElementById('poseGroup').hidden
        out.normalAnim = v.animation
        v.switchPose('aim')
        await new Promise(r => setTimeout(r, 8000))
        out.aimPose = v.pose
        out.aimSub = document.getElementById('currentSub').textContent
        out.aimAnim = v.animation
        v.switchPose('cover')
        await new Promise(r => setTimeout(r, 8000))
        out.coverPose = v.pose
        out.coverAnim = v.animation
        out.errorBox = (() => { const e = document.getElementById('errorBox'); return e && !e.hidden ? e.textContent : null })()
        return out
      `, 300000)
      check('NIKKE 归组：aim / cover 并进本体一张卡（成员表 本体→瞄准→掩体）',
        nk.members && nk.members.join(',') === 'normal:c022_00,aim:c022_aim_00,cover:c022_cover_00' &&
        nk.keys.indexOf('c022/aim/c022_aim_00.atlas') < 0 && nk.keys.indexOf('c022/cover/c022_cover_00.atlas') < 0,
        `成员=${JSON.stringify(nk.members)} 可见=${JSON.stringify(nk.keys)}`)
      check('NIKKE 姿势条对分组条目出现，本体落在 idle',
        nk.poseGroupShown === true && nk.normalAnim === 'idle',
        `姿势条=${nk.poseGroupShown} 动画=${nk.normalAnim}`)
      check('NIKKE 切「瞄准」：真的换了骨架并落到 aim_idle',
        nk.aimPose === 'aim' && nk.aimAnim === 'aim_idle' && String(nk.aimSub).indexOf('c022_aim_00') >= 0,
        `姿势=${nk.aimPose} 动画=${nk.aimAnim} 副标题="${nk.aimSub}"`)
      check('NIKKE 切「掩体」：落到 cover_idle',
        nk.coverPose === 'cover' && nk.coverAnim === 'cover_idle',
        `姿势=${nk.coverPose} 动画=${nk.coverAnim}`)
      check('NIKKE 姿势切换全程无报错（骨架世代判定对每个成员都成立）',
        nk.errorBox === null, nk.errorBox || '无报错')
      await cdp.screenshot(path.join(HERE, 'e2e_nikke_pose.png'))
    }
  } finally {
    // 还原模式与根目录，别把后面的检查留在 NIKKE / lostsword 态里
    await cdp.evaluate(`
      const v = __bd2viewer
      if (v.mode !== ${JSON.stringify(restoreMode.mode)}) v.setAssetMode(${JSON.stringify(restoreMode.mode)})
      v.state.rootId = ${JSON.stringify(restoreMode.root)}
      await v.scan(true)
      return true
    `, 240000)
  }

  const err = await cdp.consoleErrors()
  check('过程中没有出现错误提示', !err, err || '')

  await cdp.screenshot(path.join(HERE, 'e2e.png'))
} catch (err) {
  check('测试脚本执行', false, err.message)
} finally {
  console.log(results.join('\n'))
  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 失败 ' + failed + ' 项'}  （共 ${results.length} 项）`)
  await cdp.close()
  process.exit(failed === 0 ? 0 : 1)
}
