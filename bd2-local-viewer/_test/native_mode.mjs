/* 模拟 APK 环境：注入假的 window.BD2Native，验证「原生模式」整条通路。
 * 桌面 Node 服务恰好也提供 /api/* 与 /spine/*，所以假桥直接转发它，
 * 前端用的就是 APK 里那份代码路径（NATIVE === true）。 */
import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8143'
const results = []
let failed = 0
const check = (n, ok, d = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  →  ' + d : ''}`); if (!ok) failed++ }

const FAKE_BRIDGE = `
window.__saved = null
window.__toasts = []
window.__EXT = true          // 外部存储根目录 /sdcard/BD2Viewer 是否可用（模拟权限开关）
window.BD2Native = {
  // 真机上的自动目录：外部存储根目录优先，拿不到才退回 App 目录
  requestRoots() {
    fetch('/api/config').then(function (r) { return r.json() })
      .then(function (c) {
        var roots = c.roots || []
        roots.unshift({ id: '__default__', label: 'BD2Viewer（App 目录）', kind: 'file',
                       path: '/sdcard/Android/data/com.kkk.bd2viewer/files/BD2Viewer', exists: true })
        if (window.__EXT) {
          roots.unshift({ id: '__public__', label: '手机存储 /BD2Viewer', kind: 'file',
                         path: '/sdcard/BD2Viewer', exists: true })
        }
        window.__native.onRoots(roots)
      })
      .catch(function (e) { window.__native.onError('roots: ' + e.message) })
  },
  // 真实 APK 只回元信息，items 走 scanPage 分页；假桥照这个协议实现
  __scanCache: [],
  requestScan(rootId, force) {
    var self = this
    // 假桥把自动目录（__ 开头）映射到桌面服务的真实 root
    var real = String(rootId).startsWith('__') ? 'bd2-mods' : rootId
    fetch('/api/scan?root=' + encodeURIComponent(real) + (force ? '&refresh=1' : ''))
      .then(function (r) { return r.json() })
      .then(function (d) {
        self.__scanCache = d.items || []
        window.__native.onScanMeta({
          rootId: rootId,
          root: d.root,
          itemCount: self.__scanCache.length,
          playableCount: d.playableCount,
          scanMs: d.scanMs
        })
      })
      .catch(function (e) { window.__native.onError('scan: ' + e.message) })
  },
  scanPage(rootId, from, count) {
    return JSON.stringify((this.__scanCache || []).slice(from, from + count))
  },
  scanCount(rootId) { return (this.__scanCache || []).length },
  defaultPath() {
    return window.__EXT ? '/sdcard/BD2Viewer'
      : '/sdcard/Android/data/com.kkk.bd2viewer/files/BD2Viewer'
  },
  importFile(rel, base64) { window.__imported.push({ rel: rel, bytes: Math.round(base64.length * 3 / 4) }); return true },
  // 删除：假桥只记录请求 + 回一份成功回执，**不碰磁盘**（真机上是 ScanEngine.deleteItems）。
  // 桌面端真删文件那条路（/api/delete）由 _test/delete_api.mjs 在临时目录里单独验证 ——
  // 那边的根目录是测试自己建的，绝不会碰到用户的 mods 目录。
  deleteItems(rootId, json) {
    var api = this
    var items = []
    try { items = JSON.parse(json || '[]') } catch (e) { items = [] }
    ;(window.__deleted = window.__deleted || []).push({ rootId: rootId, items: items })
    var deleted = []
    for (var i = 0; i < items.length; i++) {
      var k = items[i].relAtlas
      deleted.push(k)
      api.__scanCache = (api.__scanCache || []).filter(function (x) { return x.relAtlas !== k })
    }
    return JSON.stringify({ ok: true, deleted: deleted, failed: [] })
  },
  // 目录/权限诊断：没开「所有文件访问权限」时，/sdcard/BD2Viewer 会被分区存储挡掉
  storageStatus() {
    var ext = window.__EXT
    return JSON.stringify({
      defaultDir: ext ? '/sdcard/BD2Viewer'
        : '/sdcard/Android/data/com.kkk.bd2viewer/files/BD2Viewer',
      defaultExists: true,
      defaultIsPublic: ext,
      appDir: '/sdcard/Android/data/com.kkk.bd2viewer/files/BD2Viewer',
      publicPath: '/sdcard/BD2Viewer',
      publicOk: ext,
      publicReason: ext ? '' : '系统拒绝了在手机存储根目录建文件夹（Android 11+ 分区存储）',
      allFilesAccess: ext,
      sdk: 35, rootCount: ext ? 2 : 1
    })
  },
  copyText(t) { window.__copied = t; this.toast('已复制：' + t) },
  requestAllFilesAccess() { window.__allFilesAsked = (window.__allFilesAsked || 0) + 1 },
  // 留着只为检测「前端还在不在调它」——真机上这条路径会崩，必须不再被调用
  pickFolder() { window.__pickCalled = true; window.__native.onRoots([]) },
  hasAllFilesAccess() { return false },
  saveBlob(name, base64) { window.__saved = { name: name, chars: base64.length }; return true },
  toast(msg) { window.__toasts.push(msg) },
  setKeepScreenOn() {},
  // 全屏：真机由 MainActivity 收起系统栏，并把音量键改道给 onVolumeKey
  setFullscreen(on) { window.__fsOn = on; window.__fsCalls = (window.__fsCalls || 0) + 1 },
}
`

let cdp = await Cdp.launch({ size: '1400,900' })
try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BRIDGE })
  /* 首屏探针：从 document-start 就开始盯 body 的类名与 .stage 的 display。
     这一条守的是「启动不许先画一屏播放页再跳资产页」——
     之所以要盯得这么早，是因为那个闪变只存在于「脚本跑起来之前 / 扫描结束之前」，
     等 __bd2viewer 可用时早就切过去了。实测旧版 +0ms 时 .stage=flex、+2753ms 才变 none。 */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
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
  ` })
  await cdp.goto(`${BASE}/`)
  await cdp.waitFor(`window.__bd2viewer && __bd2viewer.state.items.length > 0
                     && document.querySelectorAll('#galGrid .card').length > 0`, 60000, 'native boot')

  const boot = await cdp.evaluate(`
    return { native: __bd2viewer.isNative,
             env: document.getElementById('envInfo').textContent,
             rootId: document.getElementById('rootSelect').value,
             btnAdd: document.getElementById('btnAddRoot').textContent,
             assets: document.querySelectorAll('.asset-item').length,
             count: document.getElementById('assetCount').textContent }
  `)
  check('① 前端进入原生模式', boot.native === true, `isNative=${boot.native}`)
  check('① 环境条显示默认目录', /BD2Viewer|目录/.test(boot.env), boot.env)
  check('① 默认选中外部存储目录（而不是 App 内部目录）', boot.rootId === '__public__', `rootId=${boot.rootId}`)
  check('① 按钮改为「导入文件」', boot.btnAdd === '导入文件', boot.btnAdd)
  check('① 原生扫描拿到资产列表（分页拉取）', boot.assets > 100, `${boot.assets} 个 · ${boot.count}`)

  // 主界面 = 平铺卡片墙（不再直接播动画）
  const gal = await cdp.evaluate(`
    const grid = document.getElementById('gallery')
    const stage = document.querySelector('.stage')
    return { view: __bd2viewer.view,
             gridShown: getComputedStyle(grid).display !== 'none',
             stageShown: getComputedStyle(stage).display !== 'none',
             cards: document.querySelectorAll('#galGrid .card').length,
             firstKey: document.querySelector('#galGrid .card')?.dataset.key || '',
             hasDrag: !!document.querySelector('#galGrid .card-drag'),
             title: document.getElementById('galCount').textContent }
  `)
  check('① 主界面是平铺卡片墙（舞台收起）',
    gal.view === 'grid' && gal.gridShown === true && gal.stageShown === false && gal.cards > 50,
    `${gal.title} · 卡片=${gal.cards}`)
  check('① 卡片带 ⠿ 拖动把手', gal.hasDrag === true)

  // ㉔ 首屏就是资产页：不允许「先画一屏播放页，扫描结束再跳过去」
  const firstPaint = await cdp.evaluate(`return window.__firstPaint`, 20000)
  const fpTimeline = (firstPaint.timeline || []).map(x => x.cls)
  check('㉔ 首屏第一帧就是资产页（不先画一屏播放页）',
    typeof firstPaint.first === 'string' && firstPaint.first.indexOf('view-grid') >= 0 &&
    firstPaint.stageAtFirst === 'none',
    `首帧类名=「${firstPaint.first}」 .stage=${firstPaint.stageAtFirst}`)
  check('㉔ 整个启动过程里 view-grid 一次都没有缺席（不存在播放页→资产页的跳变）',
    fpTimeline.length > 0 && fpTimeline.every(c => c.indexOf('view-grid') >= 0),
    `类名时间线=${JSON.stringify(firstPaint.timeline || [])}`)

  // 点卡片 → 进播放页并真的载入动画
  await cdp.evaluate(`
    const card = [...document.querySelectorAll('#galGrid .card')].find(c => !c.classList.contains('bad'))
    card.click(); return true
  `)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 60000, 'open item')
  await new Promise(r => setTimeout(r, 800))
  const pv = await cdp.evaluate(`
    const dbg = JSON.parse(document.getElementById('stageInner').dataset.debug)
    return { view: __bd2viewer.view, hasPlayer: !!__bd2viewer.player,
             anims: dbg.anims, slots: dbg.slots }
  `)
  check('① 点卡片进播放页并载入动画/图层',
    pv.view === 'player' && pv.hasPlayer === true && pv.anims > 0 && pv.slots > 0,
    `view=${pv.view} anims=${pv.anims} slots=${pv.slots}`)

  // 手机上没有键盘：快捷键入口必须收起来，按键提示换成触摸说法
  const touch = await cdp.evaluate(`
    const kb = document.querySelector('.kb-only')
    const tc = document.querySelector('.touch-only')
    return { isTouch: document.body.classList.contains('is-touch'),
             helpHidden: document.getElementById('btnHelp').hidden,
             kbShown: kb ? getComputedStyle(kb).display !== 'none' : null,
             tcShown: tc ? getComputedStyle(tc).display !== 'none' : null }
  `)
  check('⑤ 触屏模式下不显示快捷键入口', touch.isTouch && touch.helpHidden === true,
    `is-touch=${touch.isTouch} btnHelp.hidden=${touch.helpHidden}`)
  check('⑤ 按键提示已换成触摸说法', touch.kbShown === false && touch.tcShown === true,
    `键盘提示可见=${touch.kbShown} 触摸提示可见=${touch.tcShown}`)

  // ⑤b 平铺首页底部的「尾巴」：资产名 / 快捷播放条 / 四个标签（资产·播放·图层·设置）
  //     一个都不该出现。2026-09-25 用户截图翻车：平铺页底部还挂着那四个按钮。
  //     标签栏整条藏了之后，「设置」得由顶栏那颗补上，否则「文件目录」就没入口了。
  const bottomBar = await cdp.evaluate(`
    const V = window.__bd2viewer
    const disp = id => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : null }
    const snap = () => ({
      grid: document.body.classList.contains('view-grid'),
      tabs: disp('mTabs'), now: disp('mNow'), quick: disp('mQuick'),
      setHidden: document.getElementById('btnSettings').hidden,
      setDisp: disp('btnSettings'),
    })
    V.setView('grid');   await new Promise(r => setTimeout(r, 140)); const g = snap()
    V.setView('player'); await new Promise(r => setTimeout(r, 140)); const p = snap()
    V.setView('grid');   await new Promise(r => setTimeout(r, 140))
    return { g, p }
  `)
  check('⑤b 平铺首页底部不出现「资产/播放/图层/设置」标签栏',
    bottomBar.g.grid && bottomBar.g.tabs === 'none',
    `view-grid=${bottomBar.g.grid} mTabs.display=${bottomBar.g.tabs}`)
  check('⑤b 平铺首页也不出现资产名与快捷播放条',
    bottomBar.g.now === 'none' && bottomBar.g.quick === 'none',
    `mNow.display=${bottomBar.g.now} mQuick.display=${bottomBar.g.quick}`)
  check('⑤b 平铺页的「设置」改从顶栏进（不然文件目录没入口）',
    bottomBar.g.setHidden === false && bottomBar.g.setDisp !== 'none',
    `btnSettings.hidden=${bottomBar.g.setHidden} display=${bottomBar.g.setDisp}`)
  check('⑤b 回到播放页：标签栏回来、顶栏「设置」收起（不重复占位）',
    bottomBar.p.tabs !== 'none' && bottomBar.p.setHidden === true,
    `mTabs.display=${bottomBar.p.tabs} btnSettings.hidden=${bottomBar.p.setHidden}`)

  // 手机端布局：两栏收进底部抽屉，用底部标签切换，点资产自动收起
  const sheet = await cdp.evaluate(`
    const tabs = document.getElementById('mTabs')
    const quick = document.getElementById('mQuick')
    const left = document.querySelector('.side-left')
    const right = document.querySelector('.side-right')
    const tap = function (n) {
      [...tabs.querySelectorAll('.mtab')].find(function (b) { return b.dataset.sheet === n }).click()
    }
    const vis = function () { return { left: left.classList.contains('open'), right: right.classList.contains('open') } }

    tap('asset');   await new Promise(r => setTimeout(r, 250)); const a = vis()
    tap('layer');   await new Promise(r => setTimeout(r, 250))
    const b = { open: vis(),
                layers: !document.getElementById('paneLayers').classList.contains('hidden'),
                controls: !document.getElementById('paneControls').classList.contains('hidden') }
    tap('ctrl');    await new Promise(r => setTimeout(r, 250))
    const c = { open: vis(),
                controls: !document.getElementById('paneControls').classList.contains('hidden'),
                layers: !document.getElementById('paneLayers').classList.contains('hidden') }

    // 底部快捷播放条：按钮真的能切播放状态，且不经过左侧栏
    const p0 = document.getElementById('mPlay').textContent
    document.getElementById('mPlay').click()
    await new Promise(r => setTimeout(r, 400))
    const p1 = document.getElementById('mPlay').textContent
    document.getElementById('mPlay').click()
    await new Promise(r => setTimeout(r, 400))
    const p2 = document.getElementById('mPlay').textContent

    // 点资产 → 抽屉自动收起，直接看动画
    tap('asset');   await new Promise(r => setTimeout(r, 250))
    document.querySelectorAll('.asset-item')[0].click()
    await new Promise(r => setTimeout(r, 800))
    const d = { open: vis(), now: document.getElementById('mNow').textContent,
                name: document.getElementById('currentName').textContent }

    return { tabsHidden: tabs.hidden, quickHidden: quick.hidden,
             tabCount: tabs.querySelectorAll('.mtab').length,
             a: a, b: b, c: c, play: [p0, p1, p2], d: d }
  `)
  check('⑧ 手机端显示底部标签与快捷播放条',
    sheet.tabsHidden === false && sheet.quickHidden === false && sheet.tabCount === 4,
    `mTabs.hidden=${sheet.tabsHidden} mQuick.hidden=${sheet.quickHidden} 标签数=${sheet.tabCount}`)
  check('⑧ 点「资产」升起右侧抽屉', sheet.a.right === true && sheet.a.left === false,
    JSON.stringify(sheet.a))
  check('⑧ 点「图层」升起左侧抽屉并切到图层页',
    sheet.b.open.left === true && sheet.b.layers === true && sheet.b.controls === false,
    JSON.stringify(sheet.b))
  check('⑧ 点「播放 · 动画」切回控制页',
    sheet.c.open.left === true && sheet.c.controls === true && sheet.c.layers === false,
    JSON.stringify(sheet.c))
  check('⑧ 快捷播放条能切换播放/暂停',
    sheet.play[0] !== sheet.play[1] && sheet.play[0] === sheet.play[2] &&
    ['暂停', '播放'].includes(sheet.play[0]), JSON.stringify(sheet.play))
  check('⑧ 选中资产后抽屉自动收起', sheet.d.open.right === false && sheet.d.open.left === false,
    JSON.stringify(sheet.d.open))
  check('⑧ 舞台下方同步显示当前资产名',
    !!sheet.d.now && sheet.d.now === sheet.d.name, `mNow=「${sheet.d.now}」 currentName=「${sheet.d.name}」`)

  // 画面真的渲染出来了（走 /spine/<rootId>/<rel>）
  const px = await cdp.evaluate(`
    const cv = __bd2viewer.player.canvas
    const t = document.createElement('canvas')
    const W = Math.min(cv.width, 600), H = Math.min(cv.height, 600)
    t.width = W; t.height = H
    const c = t.getContext('2d')
    c.drawImage(cv, 0, 0, W, H)
    const d = c.getImageData(0, 0, W, H).data
    let opaque = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++
    return { cover: +(opaque / (W * H)).toFixed(4), w: cv.width, h: cv.height }
  `)
  check('② 模型通过 /spine 路径渲染出画面', px.cover > 0.02, `覆盖 ${px.cover} canvas=${px.w}×${px.h}`)

  // 切动画仍然正常
  const sw = await cdp.evaluate(`
    document.querySelectorAll('.anim-item, .list-item')[0]?.click()
    await new Promise(r => setTimeout(r, 600))
    return __bd2viewer.player.animationState.getCurrent(0).animation.name
  `)
  check('③ 切换动画正常', !!sw, `当前=${sw}`)

  // 导出走原生保存通道（WebView 里 a[download] 是无效的）
  await cdp.evaluate(`window.__saved = null; document.getElementById('btnShot').click(); return true`)
  const saved = await cdp.evaluate(`
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !window.__saved) await new Promise(r => setTimeout(r, 200))
    return { saved: window.__saved, toasts: window.__toasts,
             err: document.getElementById('errorBox').hidden ? null : document.getElementById('errorBox').textContent }
  `, 25000)
  check('④ 截图交给原生 saveBlob 落盘', !!saved.saved && saved.saved.chars > 1000,
    saved.saved ? `${saved.saved.name} · base64 ${(saved.saved.chars / 1024).toFixed(0)}K chars` : '未触发')
  check('④ 保存后有 toast 提示', (saved.toasts || []).length > 0, JSON.stringify(saved.toasts))
  check('④ 原生通路无报错', !saved.err, saved.err || '')

  // 关键：不能再去调 pickFolder（系统文件夹选择器在部分机型上会把进程带崩）。
  // 点按钮只应该触发隐藏的 file input，把文件拷进 App 目录。
  const btn = await cdp.evaluate(`
    window.__pickCalled = false
    window.__inputClicked = 0
    const inp = document.getElementById('importFiles')
    const orig = inp.click.bind(inp)
    inp.click = function () { window.__inputClicked++ }
    document.getElementById('btnAddRoot').click()
    await new Promise(r => setTimeout(r, 400))
    inp.click = orig
    return { pickCalled: window.__pickCalled, inputClicked: window.__inputClicked,
             label: document.getElementById('btnAddRoot').textContent,
             hasImport: !!window.BD2Native.importFile, path: window.BD2Native.defaultPath() }
  `)
  check('⑥ 不再调用系统文件夹选择器', btn.pickCalled === false,
    `pickFolder 被调用=${btn.pickCalled} · 按钮「${btn.label}」`)
  check('⑥ 点按钮走「导入文件」通道', btn.inputClicked === 1, `触发 file input ${btn.inputClicked} 次`)
  check('⑥ 原生桥提供 importFile + defaultPath', btn.hasImport && !!btn.path, btn.path)

  // 完整走一遍：把文件塞进隐藏 input → 前端读成 base64 → 交给原生写进 App 目录
  const imp = await cdp.evaluate(`
    window.__imported = []
    const inp = document.getElementById('importFiles')
    const dt = new DataTransfer()
    dt.items.add(new File(['hello atlas'], 'zz_test.atlas', { type: 'text/plain' }))
    inp.files = dt.files
    inp.dispatchEvent(new Event('change'))
    const deadline = Date.now() + 25000
    while (Date.now() < deadline && !window.__imported.length) await new Promise(r => setTimeout(r, 200))
    return { imported: window.__imported, toasts: window.__toasts }
  `, 30000)
  check('⑥ 导入文件写进当前默认目录', imp.imported.length === 1 && imp.imported[0].rel === 'zz_test.atlas',
    JSON.stringify(imp.imported))
  check('⑥ 导入完成后有 toast 反馈', (imp.toasts || []).some(t => /导入/.test(t)), JSON.stringify(imp.toasts))

  // 目录/权限信息：手机端不再占首页一条，整体搬进「设置 → 文件目录」
  const bar = await cdp.evaluate(`
    document.getElementById('btnSettings').click()
    await new Promise(r => setTimeout(r, 300))
    const box = document.getElementById('setStorage')
    const btns = [...document.querySelectorAll('#setStorageActions button')].map(function (b) { return b.textContent })
    const out = { barHidden: document.getElementById('storageBar').hidden,
                  boxVisible: !box.hidden,
                  path: document.getElementById('setStoragePath').textContent || '',
                  tip: document.getElementById('setStorageTip').textContent || '', btns: btns }
    document.getElementById('settingsModal').hidden = true
    return out
  `)
  check('⑦ 手机首页不再显示目录条，入口搬进设置',
    bar.barHidden === true && bar.boxVisible === true,
    `storageBar.hidden=${bar.barHidden} 设置里可见=${bar.boxVisible}`)
  check('⑦ 设置里的文件目录指向外部路径', /\/sdcard\/BD2Viewer$/.test(bar.path.trim()),
    bar.path)
  check('⑦ 外部目录可用时给出放文件的指引', /文件管理/.test(bar.tip), bar.tip.slice(0, 40) + '…')
  check('⑦ 提供「复制路径 / 授权文件夹」入口',
    bar.btns.includes('复制路径') && bar.btns.includes('授权文件夹'), JSON.stringify(bar.btns))

  // 关掉外部目录（模拟没开「所有文件访问权限」）：自动切回 App 目录，并把原因说清楚
  const bar2 = await cdp.evaluate(`
    window.__EXT = false
    window.__allFilesAsked = 0
    window.__copied = null
    window.__pickCalled = false
    await window.__native.onPermission()
    await new Promise(r => setTimeout(r, 4000))
    document.getElementById('btnSettings').click()
    await new Promise(r => setTimeout(r, 300))
    const els = [...document.querySelectorAll('#setStorageActions button')]
    const btns = els.map(function (b) { return b.textContent })
    els.find(function (b) { return b.textContent === '去开启' })?.click()
    els.find(function (b) { return b.textContent === '复制路径' })?.click()
    await new Promise(r => setTimeout(r, 300))
    const out = { rootId: document.getElementById('rootSelect').value,
                  path: document.getElementById('setStoragePath').textContent || '',
                  tip: document.getElementById('setStorageTip').textContent || '', btns: btns,
                  asked: window.__allFilesAsked, copied: window.__copied, pickCalled: window.__pickCalled }
    document.getElementById('settingsModal').hidden = true
    return out
  `)
  check('⑦ 外部目录不可用时自动切回 App 目录', bar2.rootId === '__default__',
    `rootId=${bar2.rootId} · ${bar2.path}`)
  check('⑦ 说明 /sdcard/BD2Viewer 为什么不可用',
    /所有文件访问权限/.test(bar2.tip) && /\/sdcard\/BD2Viewer/.test(bar2.tip), bar2.tip.slice(0, 50) + '…')
  check('⑦ 「去开启」走权限设置页，不碰文件夹选择器',
    bar2.asked === 1 && bar2.pickCalled === false,
    `asked=${bar2.asked} pickFolder=${bar2.pickCalled} btns=${JSON.stringify(bar2.btns)}`)
  check('⑦ 「复制路径」把目录复制到剪贴板', !!bar2.copied, bar2.copied || '未复制')

  // ⑨ 全屏（沉浸）模式：屏幕上只剩舞台，音量键切动画，☰ 换文件，缩放不被打回
  const fs1 = await cdp.evaluate(`
    window.__fsOn = null
    document.getElementById('stageFs').click()
    await new Promise(r => setTimeout(r, 900))
    return { on: __bd2viewer.isFullscreen,
             immersive: document.body.classList.contains('is-immersive'),
             bar: !document.getElementById('fsBar').hidden,
             animBar: !document.getElementById('fsAnimBar').hidden,
             nav: getComputedStyle(document.querySelector('.nav')).display,
             tabs: getComputedStyle(document.getElementById('mTabs')).display,
             left: getComputedStyle(document.querySelector('.side-left')).display,
             native: window.__fsOn,
             file: document.getElementById('fsFile').textContent }
  `)
  check('⑨ 进全屏：只剩舞台，顶栏/标签/侧栏都收起',
    fs1.on === true && fs1.immersive === true && fs1.bar === true &&
    fs1.nav === 'none' && fs1.tabs === 'none' && fs1.left === 'none',
    JSON.stringify(fs1))
  check('⑨ 底部动画切换条同时出现', fs1.animBar === true, `animBar=${fs1.animBar}`)
  check('⑨ 通知原生收起系统栏', fs1.native === true, `setFullscreen(${fs1.native})`)
  check('⑨ 顶部条显示当前文件名', !!fs1.file && fs1.file !== '—', fs1.file)

  const fs2 = await cdp.evaluate(`
    __bd2viewer.zoomIn(); __bd2viewer.zoomIn()
    await new Promise(r => setTimeout(r, 200))
    const z0 = __bd2viewer.zoomRatio
    const a0 = __bd2viewer.player.animationState.getCurrent(0).animation.name
    __bd2viewer.onVolumeKey(1)                       // 音量+：下一个动画
    await new Promise(r => setTimeout(r, 800))
    const a1 = __bd2viewer.player.animationState.getCurrent(0).animation.name
    const z1 = __bd2viewer.zoomRatio
    const label = document.getElementById('fsAnim').textContent
    __bd2viewer.onVolumeKey(-1)                      // 音量−：回到上一个
    await new Promise(r => setTimeout(r, 800))
    const a2 = __bd2viewer.player.animationState.getCurrent(0).animation.name
    return { a0: a0, a1: a1, a2: a2, z0: z0, z1: z1, label: label }
  `)
  check('⑨ 音量键在同一文件内切换动画', !!fs2.a1 && fs2.a1 !== fs2.a0, `${fs2.a0} → ${fs2.a1}`)
  check('⑨ 音量− 能切回上一个动画', fs2.a2 === fs2.a0, `${fs2.a1} → ${fs2.a2}`)
  check('⑨ 切换动画不重置放大程度',
    fs2.z0 > 1.05 && Math.abs(fs2.z1 - fs2.z0) / fs2.z0 < 0.02,
    `切前 ×${fs2.z0.toFixed(3)} 切后 ×${fs2.z1.toFixed(3)}`)
  check('⑨ 顶部条同步动画名与序号', fs2.label.includes(fs2.a1) && /\d+\/\d+/.test(fs2.label), fs2.label)

  const fs3 = await cdp.evaluate(`
    document.getElementById('fsFiles').click()       // ☰ 拉出文件侧栏
    await new Promise(r => setTimeout(r, 400))
    const opened = document.querySelector('.side-right').classList.contains('fs-open')
    const items = document.querySelectorAll('.side-right .asset-item').length
    document.querySelectorAll('.side-right .asset-item')[0].click()
    await new Promise(r => setTimeout(r, 1500))
    const closed = !document.querySelector('.side-right').classList.contains('fs-open')
    return { opened: opened, items: items, closed: closed,
             stillFs: __bd2viewer.isFullscreen,
             file: document.getElementById('fsFile').textContent }
  `)
  check('⑨ ☰ 拉出可收起的文件侧栏', fs3.opened === true && fs3.items > 0, `${fs3.items} 个资产`)
  check('⑨ 选完文件侧栏自动收起，且仍在全屏里',
    fs3.closed === true && fs3.stillFs === true, `closed=${fs3.closed} fs=${fs3.stillFs}`)

  const fs4 = await cdp.evaluate(`
    document.getElementById('fsExit').click()
    await new Promise(r => setTimeout(r, 700))
    return { off: !__bd2viewer.isFullscreen,
             immersive: document.body.classList.contains('is-immersive'),
             bar: document.getElementById('fsBar').hidden,
             nav: getComputedStyle(document.querySelector('.nav')).display,
             native: window.__fsOn }
  `)
  check('⑨ ✕ 退出全屏并恢复常规布局',
    fs4.off === true && fs4.immersive === false && fs4.bar === true && fs4.nav !== 'none',
    JSON.stringify(fs4))
  check('⑨ 退出时通知原生恢复系统栏', fs4.native === false, `setFullscreen(${fs4.native})`)

  // ⑩ 分辨率适配：模拟竖屏手机（360×800 dpr3），全屏文件面板必须是全宽底部面板。
  // 2026-09-23 用户截图翻车：is-touch 底部抽屉的 left:0 没被覆盖，全屏面板被钉在
  // 屏幕左边且 340px 盖满竖屏，文件名全部断成两三个字。修复后按分辨率自动换布局。
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 360, height: 800, deviceScaleFactor: 3, mobile: true })
  await new Promise(r => setTimeout(r, 500))
  const fs5 = await cdp.evaluate(`
    document.getElementById('stageFs')?.click()
    await new Promise(r => setTimeout(r, 700))
    document.getElementById('fsFiles').click()
    await new Promise(r => setTimeout(r, 500))
    const d = document.querySelector('.side-right').getBoundingClientRect()
    const name = document.querySelector('.asset-item .ai-name')
    const sub = document.querySelector('.asset-item .ai-sub')
    return { narrow: document.body.classList.contains('scr-narrow'),
             tall: document.body.classList.contains('scr-tall'),
             vw: window.innerWidth,
             dw: Math.round(d.width), dx: Math.round(d.x), dy: Math.round(d.y),
             vh: window.innerHeight,
             nameClip: name ? (name.scrollWidth > name.clientWidth + 1) : null,
             subClip: sub ? (sub.scrollHeight > sub.clientHeight + 1) : null,
             barH: Math.round(document.getElementById('fsBar').getBoundingClientRect().height) }
  `)
  await cdp.send('Emulation.clearDeviceMetricsOverride', {})
  await new Promise(r => setTimeout(r, 400))
  check('⑩ 启动时检测屏幕分辨率与比例（打上 scr-narrow / scr-tall 标记）',
    fs5.narrow === true && fs5.tall === true, JSON.stringify(fs5))
  check('⑩ 竖屏下全屏文件面板改为全宽底部面板（不再盖满全屏）',
    fs5.dw >= fs5.vw * 0.95 && fs5.dy > 100 && fs5.dy + 400 <= fs5.vh,
    `面板 ${fs5.dw}px 宽 · 顶部 y=${fs5.dy} · 视口 ${fs5.vw}×${fs5.vh}`)
  check('⑩ 面板内文件名完整两行、副行单行省略，不再断成半截',
    fs5.nameClip === false && fs5.subClip === false, `nameClip=${fs5.nameClip} subClip=${fs5.subClip}`)
  check('⑩ 竖屏顶栏紧凑化（不再两行撑半屏）', fs5.barH > 0 && fs5.barH <= 90, `barH=${fs5.barH}`)

  // ⑫ 手机首页布局：无重复按钮、无目录条、舞台吃掉剩余空间（不再有大片留白）
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 360, height: 800, deviceScaleFactor: 3, mobile: true })
  await new Promise(r => setTimeout(r, 300))
  await cdp.evaluate(`
    if (__bd2viewer.isFullscreen) document.getElementById('btnFullscreen').click()
    return true
  `)
  await new Promise(r => setTimeout(r, 700))
  const home = await cdp.evaluate(`
    const nav = document.querySelector('.nav')
    const stage = document.querySelector('.stage')
    const quick = document.getElementById('mQuick')
    const navBtns = [...nav.querySelectorAll('.nav-actions .btn')].filter(b => !b.hidden).map(b => b.textContent)
    const quickBtns = [...quick.querySelectorAll('.btn')].map(b => b.textContent)
    const fab = document.getElementById('stageFs')
    const fr = fab.getBoundingClientRect()
    const sr = stage.getBoundingClientRect()
    const stageBottom = Math.round(stage.getBoundingClientRect().bottom)
    const nowTop = Math.round(document.getElementById('mNow').getBoundingClientRect().top)
    return { navH: Math.round(nav.getBoundingClientRect().height),
             navBtns: navBtns,
             settingsHidden: document.getElementById('btnSettings').hidden,
             fsTopHidden: document.getElementById('btnFullscreen').hidden,
             gridTopHidden: document.getElementById('btnGrid').hidden,
             storageDisplay: getComputedStyle(document.getElementById('storageBar')).display,
             quickBtns: quickBtns,
             fabShown: !fab.hidden && getComputedStyle(fab).display !== 'none',
             fabRight: Math.round(fr.right), fabTop: Math.round(fr.top),
             stageRight: Math.round(sr.right), stageTop: Math.round(sr.top),
             stageBottom: stageBottom, nowTop: nowTop,
             stageH: Math.round(stage.getBoundingClientRect().height),
             vh: window.innerHeight }
  `)
  await cdp.send('Emulation.clearDeviceMetricsOverride', {})
  await new Promise(r => setTimeout(r, 400))
  check('⑫ 顶栏只剩「导入文件 / 重新扫描」（设置在底部标签、全屏/平铺在画面角上）',
    home.settingsHidden === true && home.fsTopHidden === true && home.gridTopHidden === true &&
    !home.navBtns.includes('设置') && !home.navBtns.includes('全屏') && !home.navBtns.includes('平铺浏览'),
    `nav 按钮=${JSON.stringify(home.navBtns)}`)
  check('⑫ 快捷播放条不再有重复的「全屏」按钮（顶栏里已有）',
    !home.quickBtns.includes('全屏'), `快捷条=${JSON.stringify(home.quickBtns)}`)
  // 2026-09-25：两个箭头改成「上一个/下一个动作」，「适配」按钮删掉
  check('⑫ 快捷条 = 暂停 / 上一个动作 / 下一个动作 / 重置（「适配」已去掉）',
    home.quickBtns.length === 4 && !home.quickBtns.includes('适配') &&
    home.quickBtns[1] === '◀◀' && home.quickBtns[2] === '▶▶',
    `快捷条=${JSON.stringify(home.quickBtns)}`)
  check('⑫ 全屏入口是画面右上角的 ⛶ 图标',
    home.fabShown === true && home.fabRight >= home.stageRight - 60 &&
    home.fabTop >= home.stageTop && home.fabTop <= home.stageTop + 60,
    `fab right=${home.fabRight} stage right=${home.stageRight} fab top=${home.fabTop} stage top=${home.stageTop}`)
  check('⑫ 首页不再显示目录条（内容在设置 → 文件目录）',
    home.storageDisplay === 'none', `storageBar display=${home.storageDisplay}`)
  check('⑫ 顶栏单行不折行', home.navH > 0 && home.navH <= 90, `navH=${home.navH}`)
  check('⑫ 舞台铺满剩余空间，进度条与资产名之间没有大块留白',
    home.stageH > home.vh * 0.5 && home.nowTop - home.stageBottom <= 14,
    `stage 高=${home.stageH}/${home.vh} · 缝隙=${home.nowTop - home.stageBottom}px`)

  // ⑫b 手机快捷条的两个箭头 = 上一个 / 下一个**资产**
  //     （画面两侧那对才是切动画 —— 两处分工与常见布局相反，见 ㉒）
  //     同时「适配」按钮必须已经从 DOM 里去掉了。
  const quickArrows = await cdp.evaluate(`
    const v = __bd2viewer
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const key = it => it.key || it.id || it.relAtlas || ''
    v.setView('player')
    await wait(400)
    if (!v.state.current) {
      v.openItem(v.state.items.find(i => key(i) === v.visibleKeys[0]))
      await wait(1000)
    }
    for (let w = 0; w < 30 && !(v.animations || []).length; w++) await wait(150)
    const names = v.animations || []
    const keys = v.visibleKeys
    const at = k => keys.indexOf(k)
    if (!names.length || keys.length < 3 || at(key(v.state.current)) < 0) {
      return { skip: true, count: names.length, total: keys.length }
    }

    // 点一下等它真的换过去再采样（换资产要重新载入，别写死睡眠）
    const clickAndSettle = async id => {
      const before = key(v.state.current)
      document.getElementById(id).click()
      for (let w = 0; w < 50 && key(v.state.current) === before; w++) await wait(100)
      for (let w = 0; w < 50 && !(v.animations || []).length; w++) await wait(100)
      await wait(200)
    }

    const p0 = at(key(v.state.current))
    await clickAndSettle('mFwd')
    const p1 = at(key(v.state.current))
    await clickAndSettle('mFwd')
    const p2 = at(key(v.state.current))
    await clickAndSettle('mBack')
    const p3 = at(key(v.state.current))

    // 逐帧步进没有被误删：播放页面板上那两个「◀│ / │▶」还得是逐帧
    const entry = v.state.player.animationState.getCurrent(0)
    const t0 = entry.trackTime
    document.getElementById('btnStepFwd').click()
    const t1 = entry.trackTime
    const t2 = (document.getElementById('btnStepBack').click(), entry.trackTime)

    return { skip: false, count: names.length, total: keys.length, p0, p1, p2, p3,
             stepFwd: t1 - t0, stepBack: t1 - t2, fps: v.state.fps,
             backTitle: document.getElementById('mBack').title,
             fwdTitle: document.getElementById('mFwd').title,
             hasFit: !!document.getElementById('mFit') }
  `, 120000)
  const _qaSkipWhy = `跳过：没拿到可用的资产（动画 ${quickArrows.count} 个 / 资产 ${quickArrows.total} 套）`
  check('⑫b 快捷条箭头 = 下一个资产（连点两下前进两档）',
    !quickArrows.skip && quickArrows.p1 === quickArrows.p0 + 1 && quickArrows.p2 === quickArrows.p0 + 2,
    quickArrows.skip ? _qaSkipWhy
      : `列表档位 ${quickArrows.p0} → ${quickArrows.p1} → ${quickArrows.p2}（共 ${quickArrows.total} 套）`)
  check('⑫b 快捷条箭头 = 上一个资产',
    !quickArrows.skip && quickArrows.p3 === quickArrows.p1,
    quickArrows.skip ? _qaSkipWhy : `第 ${quickArrows.p2} 档 → 回退到第 ${quickArrows.p3} 档`)
  check('⑫b 「适配」按钮已从 DOM 移除，两个箭头是「资产」文案',
    quickArrows.hasFit === false &&
    /资产/.test(quickArrows.fwdTitle || '') && /资产/.test(quickArrows.backTitle || ''),
    `#mFit 存在=${quickArrows.hasFit} 标题=「${quickArrows.backTitle}」「${quickArrows.fwdTitle}」`)
  check('⑫b 逐帧步进仍在播放页面板上（键盘 ←/→ 那条路没被误删）',
    !quickArrows.skip && Math.abs(quickArrows.stepFwd - 1 / quickArrows.fps) < 1e-6 &&
    Math.abs(quickArrows.stepBack - 1 / quickArrows.fps) < 1e-6,
    quickArrows.skip ? _qaSkipWhy
      : `前进 ${quickArrows.stepFwd.toFixed(5)}s / 后退 ${quickArrows.stepBack.toFixed(5)}s（1/${quickArrows.fps}）`)

  // ⑪ 音量键方向可在设置里选（音量上=下一个/上一个），并持久化
  const vk = await cdp.evaluate(`
    [...document.querySelectorAll('.mtab')].find(function (b) { return b.dataset.sheet === 'set' }).click()
    await new Promise(r => setTimeout(r, 300))
    const sel = document.getElementById('setVolumeDir')
    const modal = document.getElementById('settingsModal')
    if (!sel || modal.hidden) return { exists: false }
    sel.value = 'prev'
    sel.dispatchEvent(new Event('change'))
    modal.hidden = true
    document.getElementById('btnFullscreen').click()   // 音量键只在全屏生效
    await new Promise(r => setTimeout(r, 500))
    const anim = () => __bd2viewer.player.animationState.getCurrent(0)?.animation?.name
    const a0 = anim()
    __bd2viewer.onVolumeKey(1)                         // 音量+：现在应该是「上一个」
    await new Promise(r => setTimeout(r, 800))
    const a1 = anim()
    __bd2viewer.onVolumeKey(-1)                        // 音量−：下一个，回到原动画
    await new Promise(r => setTimeout(r, 800))
    const a2 = anim()
    const stored = localStorage.getItem('bd2.volDir')
    // 恢复默认方向
    document.getElementById('btnFullscreen').click()
    sel.value = 'next'
    sel.dispatchEvent(new Event('change'))
    return { exists: true, a0: a0, a1: a1, a2: a2, stored: stored }
  `)
  check('⑪ 设置里有「音量上键方向」选项', vk.exists === true, JSON.stringify(vk).slice(0, 80))
  check('⑪ 选「上一个」后音量+ 切到上一个动画', vk.a1 !== vk.a0, `${vk.a0} → ${vk.a1}`)
  check('⑪ 音量− 方向随之反转回原动画', vk.a2 === vk.a0, `${vk.a1} → ${vk.a2}`)
  check('⑪ 方向选择持久化到 localStorage', vk.stored === 'prev', `stored=${vk.stored}`)

  // ⑬ 坏 JSON 资产：给可读提示（不是 uncaught 红条）、不卡死，换个资产还能继续用
  const bad = await cdp.evaluate(`
    const orig = window.fetch
    window.fetch = function (u, o) {
      const s = String(u)
      if (s.includes('/spine/') && s.endsWith('.json')) {
        return Promise.resolve(new Response('{"bad":1,}', { status: 200 }))
      }
      return orig(u, o)
    }
    const items = document.querySelectorAll('.asset-item')
    items[2].click()
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && __bd2viewer.state.busy) await new Promise(r => setTimeout(r, 300))
    await new Promise(r => setTimeout(r, 500))
    const out = { err: document.getElementById('errorBox').hidden ? '' : document.getElementById('errorBox').textContent,
                  busy: __bd2viewer.state.busy,
                  spinner: !document.getElementById('spinner').hidden }
    window.fetch = orig
    items[0].click()
    const dl = Date.now() + 30000
    while (Date.now() < dl && !__bd2viewer.player) await new Promise(r => setTimeout(r, 300))
    out.recovered = !!__bd2viewer.player
    return out
  `, 45000)
  check('⑬ 坏 JSON 资产给可读提示（不会变成满屏 uncaught 红条）',
    /坏文件|JSON/.test(bad.err) && !/Uncaught/.test(bad.err), (bad.err || '').replace(/\n/g, ' ').slice(0, 70))
  check('⑬ 坏 JSON 加载失败后不卡死：busy 撤掉、载入遮罩消失',
    bad.busy === false && bad.spinner === false, `busy=${bad.busy} spinner=${bad.spinner}`)
  check('⑬ 换个正常资产还能继续播放', bad.recovered === true, `recovered=${bad.recovered}`)

  // ⑬ 资产列表自身可滚动（此前列表被撑出抽屉裁掉、手指翻不动）
  const sc = await cdp.evaluate(`
    [...document.querySelectorAll('.mtab')].find(function (b) { return b.dataset.sheet === 'asset' }).click()
    await new Promise(r => setTimeout(r, 500))
    const el = document.querySelector('.side-right .asset-list')
    const cs = getComputedStyle(el)
    return { oy: cs.overflowY, can: el.scrollHeight > el.clientHeight + 10,
             sh: el.scrollHeight, ch: el.clientHeight }
  `)
  check('⑬ 资产列表自身可滚动（不再被抽屉裁掉翻不动）',
    sc.oy === 'auto' && sc.can === true,
    `overflowY=${sc.oy} 内容=${sc.sh}px 视口=${sc.ch}px`)
  const sc2 = await cdp.evaluate(`
    document.getElementById('sheetScrim').click()
    await new Promise(r => setTimeout(r, 300))
    const el = document.querySelector('.side-right .asset-list')
    el.scrollTop = 99999
    await new Promise(r => setTimeout(r, 300))
    return { scrolled: el.scrollTop > 100, top: el.scrollTop }
  `)
  check('⑬ 列表滚动真的生效（scrollTop 能推下去）', sc2.scrolled === true, `scrollTop=${sc2.top}`)

  // ⑭ 全屏布局重排：顶部 ◀▶ 切换资产，底部 ◀▶ 切换动画；文件面板开着时藏起底部条
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 360, height: 800, deviceScaleFactor: 3, mobile: true })
  await new Promise(r => setTimeout(r, 400))
  const fx = await cdp.evaluate(`
    document.getElementById('stageFs').click()
    await new Promise(r => setTimeout(r, 900))
    const file0 = document.getElementById('fsFile').textContent
    const key0 = __bd2viewer.state.current.relAtlas
    document.getElementById('fsNextFile').click()
    await new Promise(r => setTimeout(r, 1800))
    const file1 = document.getElementById('fsFile').textContent
    const key1 = __bd2viewer.state.current.relAtlas
    document.getElementById('fsPrevFile').click()
    await new Promise(r => setTimeout(r, 1800))
    const file2 = document.getElementById('fsFile').textContent
    const a0 = __bd2viewer.player.animationState.getCurrent(0)?.animation?.name
    document.getElementById('fsNextAnim').click()
    await new Promise(r => setTimeout(r, 900))
    const a1 = __bd2viewer.player.animationState.getCurrent(0)?.animation?.name
    const animLabel = document.getElementById('fsAnim').textContent
    document.getElementById('fsFiles').click()
    await new Promise(r => setTimeout(r, 500))
    const animBarHiddenInPanel = document.getElementById('fsAnimBar').hidden
    document.querySelectorAll('.side-right .asset-item')[1].click()
    await new Promise(r => setTimeout(r, 1800))
    const animBarBack = !document.getElementById('fsAnimBar').hidden
    const panelClosed = !document.querySelector('.side-right').classList.contains('fs-open')
    const rBar = document.getElementById('fsAnimBar').getBoundingClientRect()
    return { file0, file1, file2, key0, key1, a0, a1, animLabel,
             animBarHiddenInPanel, animBarBack, panelClosed,
             barBottom: Math.round(rBar.bottom), vh: window.innerHeight }
  `, 60000)
  await cdp.send('Emulation.clearDeviceMetricsOverride', {})
  await new Promise(r => setTimeout(r, 400))
  check('⑭ 全屏顶部 ▶ 切到下一个资产', fx.key1 !== fx.key0 && fx.file1 !== fx.file0,
    `${fx.file0} → ${fx.file1}`)
  check('⑭ 全屏顶部 ◀ 切回上一个资产', fx.file2 === fx.file0, `${fx.file1} → ${fx.file2}`)
  check('⑭ 底部 ▶ 切换的是动画（不是资产）', fx.a1 !== fx.a0, `${fx.a0} → ${fx.a1}`)
  check('⑭ 底部条显示当前动画名', !!fx.animLabel && fx.animLabel !== '—', fx.animLabel)
  check('⑭ 打开文件面板时藏起底部动画条，选完资产自动恢复',
    fx.animBarHiddenInPanel === true && fx.animBarBack === true && fx.panelClosed === true,
    `panel 中隐藏=${fx.animBarHiddenInPanel} 选完恢复=${fx.animBarBack}`)
  check('⑭ 底部动画条贴着画面下方', fx.barBottom >= fx.vh - 120,
    `bottom=${fx.barBottom} 屏高=${fx.vh}`)

  // ⑮ 全屏：双击定点放大（每次双击往上走一档，到顶档再双击才还原）；隐藏界面按钮
  const dz = await cdp.evaluate(`
    document.getElementById('fsExit').click()
    await new Promise(r => setTimeout(r, 700))
    document.getElementById('stageFs').click()
    await new Promise(r => setTimeout(r, 900))
    __bd2viewer.fitToWindow()                    // 先回到已知的「铺满」状态
    await new Promise(r => setTimeout(r, 300))
    const r = document.getElementById('stageInner').getBoundingClientRect()
    const x = Math.round(r.left + r.width * 0.32)
    const y = Math.round(r.top + r.height * 0.34)
    const tap = () => {
      const o = { clientX: x, clientY: y, isPrimary: true, bubbles: true, pointerId: 1, pointerType: 'touch' }
      document.getElementById('stageInner').dispatchEvent(new PointerEvent('pointerdown', o))
      document.getElementById('stageInner').dispatchEvent(new PointerEvent('pointerup', o))
    }
    const m = () => 1 / __bd2viewer.zoomRatio    // zoomRatio 越小画面越大，取倒数是放大倍数
    const before = __bd2viewer.zoomRatio
    const posBefore = { x: __bd2viewer.state.camera.position.x, y: __bd2viewer.state.camera.position.y }
    const mags = [m()]
    const dbl = async () => { tap(); tap(); await new Promise(r2 => setTimeout(r2, 700)); mags.push(m()) }
    await dbl()                                  // ① 铺满 → 2.6×
    const posAfter = { x: __bd2viewer.state.camera.position.x, y: __bd2viewer.state.camera.position.y }
    await dbl()                                  // ② 仍然放大 → 6.8×
    await dbl()                                  // ③ 继续放大 → 17.7×（顶档）
    await dbl()                                  // ④ 顶档再双击 → 还原
    const back = __bd2viewer.zoomRatio

    // 隐藏界面
    const barVisible = () => getComputedStyle(document.getElementById('fsBar')).display !== 'none'
    const bar0 = barVisible()
    document.getElementById('fsHide').click()
    await new Promise(r2 => setTimeout(r2, 300))
    const clean = __bd2viewer.cleanUI
    const bar1 = barVisible()
    // 点画面 → 临时唤出
    document.getElementById('stageInner').dispatchEvent(new PointerEvent('pointerdown',
      { clientX: x, clientY: y, isPrimary: true, bubbles: true, pointerId: 1 }))
    await new Promise(r2 => setTimeout(r2, 300))
    const revealed = barVisible() && document.body.classList.contains('fs-reveal')
    document.getElementById('fsHide').click()
    await new Promise(r2 => setTimeout(r2, 300))
    const restored = !__bd2viewer.cleanUI && barVisible()
    return { before, mags, back, posBefore, posAfter, bar0, clean, bar1, revealed, restored,
             ladder: __bd2viewer.ZOOM_LADDER }
  `, 60000)
  const mag = r => 1 / r
  check('⑮ 双击画面以该点为中心放大（画面约放大 2.6 倍）',
    dz.mags[1] > dz.mags[0] * 1.8 && Math.abs(dz.mags[1] / dz.mags[0] - 2.6) < 0.6,
    `画面 ${dz.mags[0].toFixed(2)}× → ${dz.mags[1].toFixed(2)}×`)
  check('⑮ 放大时镜头跟着挪（以点击处为锚点，不是只放大中心）',
    Math.abs(dz.posAfter.x - dz.posBefore.x) > 1 || Math.abs(dz.posAfter.y - dz.posBefore.y) > 1,
    `(${dz.posBefore.x.toFixed(0)},${dz.posBefore.y.toFixed(0)}) → (${dz.posAfter.x.toFixed(0)},${dz.posAfter.y.toFixed(0)})`)
  // 2026-09-25：原来第二下就弹回去，用户要的是「第二次双击仍然是放大」
  check('⑮ 第二次双击仍然是放大（不是还原）',
    dz.mags[2] > dz.mags[1] * 1.8,
    `第 2 次双击后 ${dz.mags[2].toFixed(2)}×（前一次 ${dz.mags[1].toFixed(2)}×）`)
  // 断言按 app 导出的档位表算，不写死数字：改档位时这里不会假失败
  const nearLadder = (got, want) => Math.abs(got - want) <= Math.max(0.4, want * 0.12)
  check('⑮ 双击逐档放大到顶档（2.6 → 6.8 → 12.4）',
    dz.ladder.length === 3 &&
    nearLadder(dz.mags[1], dz.ladder[0]) &&
    nearLadder(dz.mags[2], dz.ladder[1]) &&
    nearLadder(dz.mags[3], dz.ladder[2]),
    `档位 ${dz.mags.slice(1).map(v => v.toFixed(2) + '×').join(' → ')} 期望 ${JSON.stringify(dz.ladder)}`)
  check('⑮ 已在顶档时再双击才还原到铺满', Math.abs(dz.back - 1) < 0.12, `画面 ${mag(dz.back).toFixed(2)}×`)
  check('⑮ 隐藏界面按钮收起顶栏', dz.bar0 === true && dz.clean === true && dz.bar1 === false,
    `初始可见=${dz.bar0} cleanUI=${dz.clean} 隐藏后可见=${dz.bar1}`)
  check('⑮ 点画面临时唤出操作条，再点图标恢复',
    dz.revealed === true && dz.restored === true,
    `唤出=${dz.revealed} 恢复=${dz.restored}`)

  // ⑮(2) 真机流程复现：不手动 fitToWindow（真机上没人会调它），直接
  // 进全屏 → 连按到顶档 → 再按一下还原。还原必须精确落回「当前视口的铺满」，
  // 不能用全屏切换前遗留的旧记录值（否则画面会比铺满时更小）。
  const dz2 = await cdp.evaluate(`
    document.getElementById('fsExit').click()
    await new Promise(r => setTimeout(r, 800))
    document.getElementById('stageFs').click()
    await new Promise(r => setTimeout(r, 1500))      // 等 ResizeObserver / 布局稳定
    const mag = () => 1 / __bd2viewer.zoomRatio      // zoomRatio 越小画面越大，取倒数是放大倍数
    const r = document.getElementById('stageInner').getBoundingClientRect()
    const x = Math.round(r.left + r.width * 0.4)
    const y = Math.round(r.top + r.height * 0.5)
    const tap = () => {
      const o = { clientX: x, clientY: y, isPrimary: true, bubbles: true, pointerId: 1, pointerType: 'touch' }
      document.getElementById('stageInner').dispatchEvent(new PointerEvent('pointerdown', o))
      document.getElementById('stageInner').dispatchEvent(new PointerEvent('pointerup', o))
    }
    const dbl = async () => { tap(); tap(); await new Promise(r2 => setTimeout(r2, 700)); return mag() }
    const m0 = mag()
    const m1 = await dbl()      // → 2.6×
    const m2 = await dbl()      // → 6.8×（第二次仍然是放大）
    const m3 = await dbl()      // → 17.7×（顶档）
    const m4 = await dbl()      // 顶档再双击 → 还原
    return { m0, m1, m2, m3, m4 }
  `, 60000)
  check('⑮ 真机流程：进全屏没手动适配，画面也已是铺满',
    Math.abs(dz2.m0 - 1) < 0.15, `画面 ${dz2.m0.toFixed(2)}×`)
  check('⑮ 真机流程：直接双击放大（≈2.6 倍）',
    dz2.m1 > 2.2 && dz2.m1 < 3.0, `画面 ${dz2.m1.toFixed(2)}×`)
  check('⑮ 真机流程：第二次双击继续放大（≈6.8 倍，不是弹回铺满）',
    dz2.m2 > 5.5 && dz2.m2 < 8.5, `画面 ${dz2.m2.toFixed(2)}×`)
  check('⑮ 真机流程：顶档再双击精确还原到铺满（不缩小过头）',
    Math.abs(dz2.m4 - 1) < 0.12, `画面 ${dz2.m3.toFixed(2)}× → ${dz2.m4.toFixed(2)}×`)

  // ⑯ 平铺页：点图标回平铺、拖动改播放顺序、缩略图
  const g1 = await cdp.evaluate(`
    document.getElementById('fsExit').click()
    await new Promise(r => setTimeout(r, 700))
    document.getElementById('stageGrid').click()
    await new Promise(r => setTimeout(r, 600))
    return { view: __bd2viewer.view,
             gridShown: getComputedStyle(document.getElementById('gallery')).display !== 'none',
             stageShown: getComputedStyle(document.querySelector('.stage')).display !== 'none',
             cards: document.querySelectorAll('#galGrid .card').length }
  `)
  check('⑯ ⊞ 从播放页回到平铺页（舞台收起）',
    g1.view === 'grid' && g1.gridShown === true && g1.stageShown === false && g1.cards > 50,
    `view=${g1.view} 卡片=${g1.cards}`)

  // 缩略图：等第一张生成出来（离屏播放器渲一帧 → JPEG dataURL）
  const th = await cdp.evaluate(`
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      if (document.querySelector('#galGrid .card-thumb img')) break
      await new Promise(r => setTimeout(r, 400))
    }
    const img = document.querySelector('#galGrid .card-thumb img')
    return { has: !!img, src: img ? img.src.slice(0, 30) : '',
             stats: __bd2viewer.thumbStats,
             status: document.getElementById('galThumb').textContent }
  `, 60000)
  check('⑯ 卡片缩略图能生成（JPEG dataURL）',
    th.has === true && /^data:image\/jpeg/.test(th.src || ''), `${th.src}… 缓存=${th.stats.cached}`)
  check('⑯ 缩略图进度可见', /缩略图\s*\d+\/\d+/.test(th.status) || th.stats.cached > 0, th.status)

  // 布局回归：卡片带 overflow:hidden，作为网格项时自动最小尺寸会算成 0，
  // 曾导致 grid-auto-rows 塌成 2px、卡片互相重叠。这里守住「撑高 + 不重叠 + 不横向溢出」。
  const lay = await cdp.evaluate(`
    const g = document.getElementById('galGrid')
    const cs = [...g.querySelectorAll('.card')]
    const cols = getComputedStyle(g).gridTemplateColumns.split(' ').length
    const r0 = cs[0].getBoundingClientRect()
    const r1 = cs[cols].getBoundingClientRect()          // 下一行第一张
    const tb = cs[0].querySelector('.card-thumb').getBoundingClientRect()
    return { cardH: Math.round(r0.height), thumbH: Math.round(tb.height),
             pitch: Math.round(r1.top - r0.top), cols,
             overflowX: document.documentElement.scrollWidth - window.innerWidth,
             sameH: Math.abs(r1.height - r0.height) < 2 }
  `)
  check('⑯ 卡片按缩略图正常撑高（不再塌成细条）',
    lay.cardH >= 150 && lay.thumbH >= 100, `卡高=${lay.cardH} 缩略图高=${lay.thumbH} 列=${lay.cols}`)
  check('⑯ 行与行不重叠（行距 ≥ 卡片高）',
    lay.pitch >= lay.cardH && lay.sameH === true, `行距=${lay.pitch} 卡高=${lay.cardH}`)
  check('⑯ 平铺页没有横向溢出', lay.overflowX <= 1, `溢出=${lay.overflowX}px`)

  // ⑱ 拖动排序（2026-09-25 重写交互）。
  // 旧实现只在卡片左上角留一个 30px 的 ⠿、pointerdown 就 preventDefault 开拖，
  // 落点用 elementFromPoint 找 —— 但被拖的卡片本身就在指针底下，判定基本靠巧合；
  // 手指在卡片上滑一下既滚不动也不像拖，就是「不舒服」的来源。现在：
  //   · 按住 ⠿ 立刻拖；卡片其它地方触屏长按 180ms（鼠标移动 4px）后拖
  //   · 卡片脱离网格、保留抓取点偏移 1:1 跟手，网格里留一个占位块当落点
  //   · 松手飞回落点，写进 localStorage
  // 断言用「排列不变式」（其余卡片相对顺序不变 + 集合不变），
  // 不用「换了位置」这种依赖具体网格几何的弱断言。
  const od = await cdp.evaluate(`
    const grid = document.getElementById('galGrid')
    const keysOf = () => [...grid.querySelectorAll('.card')].map(c => c.dataset.key)
    const before = keysOf()
    const origFirst = before[0]
    const cards = [...grid.querySelectorAll('.card')]
    const src = cards[0], dst = cards[2]
    const handle = src.querySelector('.card-drag')
    const hr = handle.getBoundingClientRect()
    const dr = dst.getBoundingClientRect()
    const ev = (type, x, y) => handle.dispatchEvent(new PointerEvent(type,
      { clientX: x, clientY: y, bubbles: true, pointerId: 1, isPrimary: true }))
    const dropX = dr.left + dr.width * 0.75     // 越过第 3 张的水平中线 → 落到它右边的格子
    const dropY = dr.top + dr.height * 0.75

    ev('pointerdown', hr.left + 10, hr.top + 10)     // 从 ⠿ 起手：立刻进入拖动，不用等长按
    await new Promise(r => requestAnimationFrame(r))
    const ph = grid.querySelector('.card-ph')
    const lifted = {
      ph: grid.querySelectorAll('.card-ph').length,
      floating: grid.querySelectorAll('.card.dragging').length,
      pos: getComputedStyle(src).position,
      follows: /translate3d\\(/.test(src.style.transform || ''),
      // 用 offsetHeight：getBoundingClientRect 会把 scale(1.04) 也算进去，量不出真实格子高
      phH: ph ? ph.offsetHeight : 0,
      cardH: src.offsetHeight,
    }
    ev('pointermove', dropX, dropY)
    await new Promise(r => requestAnimationFrame(r))
    ev('pointerup', dropX, dropY)
    await new Promise(r => setTimeout(r, 600))

    const after = keysOf()
    const rid = document.getElementById('rootSelect').value
    const stored = (() => { try { return JSON.parse(localStorage.getItem('bd2.order.' + rid) || '[]') } catch { return [] } })()
    const rest = before.filter(k => k !== origFirst)
    const restAfter = after.filter(k => k !== origFirst)
    return {
      lifted, origFirst, movedIndex: after.indexOf(origFirst), first: after[0],
      sameCount: after.length === before.length,
      sameSet: before.every(k => after.includes(k)),
      restKept: rest.length === restAfter.length && rest.every((k, i) => restAfter[i] === k),
      storedFirst: stored[0], storedLen: stored.length, storedRid: rid,
      orderLen: __bd2viewer.order.length,
      drag: __bd2viewer.dragStats,
      sort: __bd2viewer.sort,
    }
  `, 30000)
  check('⑱ 拖动时卡片脱离网格 1:1 跟手，网格里留同尺寸占位块',
    od.lifted.ph === 1 && od.lifted.floating === 1 && od.lifted.pos === 'fixed' &&
    od.lifted.follows === true && Math.abs(od.lifted.phH - od.lifted.cardH) <= 1,
    `占位=${od.lifted.ph} 抬起=${od.lifted.floating} position=${od.lifted.pos} ` +
    `跟手=${od.lifted.follows} 占位高=${od.lifted.phH}/卡高=${od.lifted.cardH}`)
  check('⑱ 拖动只挪动被拖的卡片，其余卡片相对顺序不变',
    od.sameCount && od.sameSet && od.restKept && od.movedIndex > 0,
    `原第一张 → 第 ${od.movedIndex} 位 · 集合不变=${od.sameSet} 其余顺序不变=${od.restKept}`)
  check('⑱ 拖动结果写进 localStorage 并同步给播放顺序',
    od.storedLen > 50 && od.storedFirst === od.first && od.orderLen > 50,
    `目录=${od.storedRid} 顺序条数=${od.storedLen} 首张=${od.storedFirst}`)
  check('⑱ 松手不留垃圾（占位块 / 抬升态 / 内联 transform·transition 全清掉）',
    od.drag.placeholders === 0 && od.drag.floating === 0 && od.drag.stuckInline === 0,
    `占位=${od.drag.placeholders} 抬起=${od.drag.floating} 残留内联样式=${od.drag.stuckInline}`)
  check('⑱ 拖动即编辑手动顺序（拖完排序方式回到「手动」）',
    od.sort.mode === 'manual', JSON.stringify(od.sort))

  // ⑱c 「反复横跳」回归：指针停在格子中线上抖动 30 帧，落点不能再翻来翻去。
  // 根因是命中测试读的是被 FLIP 位移过的渲染位置：指针压在中线时 dst 会来回翻，
  // 每翻一次就重启一次 FLIP，其它卡片看着就像在横跳（见 2026-09-25 的录屏）。
  const osc = await cdp.evaluate(`
    const grid = document.getElementById('galGrid')
    const cards = [...grid.querySelectorAll('.card')]
    const src = cards[0]
    const handle = src.querySelector('.card-drag')
    const hr = handle.getBoundingClientRect()
    const dst = cards[3].getBoundingClientRect()
    const ev = (t, x, y) => handle.dispatchEvent(new PointerEvent(t,
      { clientX: x, clientY: y, bubbles: true, pointerId: 31, isPrimary: true }))

    const phIndex = () => [...grid.children].indexOf(grid.querySelector('.card-ph'))
    let changes = 0, restarts = 0, last = -1, lastFlying = -1
    const snap = () => {
      const i = phIndex()
      if (last !== -1 && i !== last) changes++
      last = i
      // 挂着一帧内联 transform 的卡片数：每重启一次 FLIP 这个数就会抖一下
      const flying = [...grid.children].filter(c => c.style.transform).length
      if (lastFlying !== -1 && flying !== lastFlying) restarts++
      lastFlying = flying
    }

    ev('pointerdown', hr.left + 10, hr.top + 10)
    const baseX = dst.left + dst.width * 0.5
    ev('pointermove', baseX, dst.top + dst.height * 0.5)
    await new Promise(r => requestAnimationFrame(r))
    await new Promise(r => requestAnimationFrame(r))
    snap()
    for (let i = 0; i < 30; i++) {                 // 停在中线上 ±1px 地抖
      ev('pointermove', baseX + (i % 2 ? 1 : -1), dst.top + dst.height * 0.5)
      await new Promise(r => requestAnimationFrame(r))
      snap()
    }
    const settled = { changes, restarts, ph: phIndex() }
    ev('pointerup', baseX, dst.top + dst.height * 0.5)
    // 收尾 = 飞回动画 + 一次清内联样式的 timeout。别固定睡一觉就采样：
    // 主线程忙时定时器会晚一拍（实测 200ms 拖到 896ms），那样「松手后干净」
    // 会时通时不通 —— 那是指标抖动，不是功能坏了。轮询到干净，留 5s 上限兜真漏。
    const t0 = performance.now()
    let drag = __bd2viewer.dragStats
    while (performance.now() - t0 < 5000) {
      drag = __bd2viewer.dragStats
      if (!drag.active && drag.placeholders === 0 && drag.floating === 0 && drag.stuckInline === 0) break
      await new Promise(r => setTimeout(r, 120))
    }
    return { settled, drag, settleMs: Math.round(performance.now() - t0) }
  `, 40000)
  check('⑱c 指针停在格子中线上抖动：落点判定不再反复横跳',
    osc.settled.changes <= 2,
    `30 帧里落点变化 ${osc.settled.changes} 次（最终落在第 ${osc.settled.ph} 格）`)
  check('⑱c 抖动期间不再反复重启位移动画',
    osc.settled.restarts <= 4, `动画集合变化 ${osc.settled.restarts} 次`)
  check('⑱c 抖动结束松手后状态干净',
    osc.drag.active === false && osc.drag.placeholders === 0 && osc.drag.stuckInline === 0,
    `${JSON.stringify(osc.drag)} · 收尾耗时 ${osc.settleMs}ms`)

  // ⑲ 触屏手势消歧：按住不动 = 抬起卡片；直接滑走 = 滚动，不能误触发拖动。
  const holdTest = await cdp.evaluate(`
    const grid = document.getElementById('galGrid')
    const keysOf = () => [...grid.querySelectorAll('.card')].map(c => c.dataset.key)
    const before = keysOf()
    const body = grid.querySelector('.card')
    const inner = body.querySelector('.card-thumb')
    const r = inner.getBoundingClientRect()
    const ev = (type, x, y) => inner.dispatchEvent(new PointerEvent(type,
      { clientX: x, clientY: y, bubbles: true, pointerId: 7, isPrimary: true, pointerType: 'touch' }))

    // ① 长按判定（180ms）之前就滑走 → 当成滚动，不进入拖动
    ev('pointerdown', r.left + 20, r.top + 20)
    ev('pointermove', r.left + 20, r.top + 70)
    ev('pointerup', r.left + 20, r.top + 70)
    await new Promise(res => setTimeout(res, 340))     // 超过 180ms，看长按定时器有没有被取消
    const swipe = {
      ph: grid.querySelectorAll('.card-ph').length,
      floating: grid.querySelectorAll('.card.dragging').length,
      orderKept: keysOf().join('|') === before.join('|'),
      dragStats: __bd2viewer.dragStats,
    }

    // ② 按住不动 260ms → 卡片抬起（占位块出现），原地放回后一切复原
    const src = grid.querySelectorAll('.card')[1]
    const inner2 = src.querySelector('.card-thumb')
    const rr = inner2.getBoundingClientRect()
    const ev2 = (type, x, y) => inner2.dispatchEvent(new PointerEvent(type,
      { clientX: x, clientY: y, bubbles: true, pointerId: 8, isPrimary: true, pointerType: 'touch' }))
    const mid = keysOf()
    ev2('pointerdown', rr.left + 20, rr.top + 20)
    await new Promise(res => setTimeout(res, 260))
    const lifted = { ph: grid.querySelectorAll('.card-ph').length,
                     floating: grid.querySelectorAll('.card.dragging').length }
    ev2('pointerup', rr.left + 20, rr.top + 20)
    await new Promise(res => setTimeout(res, 500))
    return { swipe, lifted, clean: __bd2viewer.dragStats,
             orderKept: keysOf().join('|') === mid.join('|'), count: keysOf().length }
  `, 30000)
  check('⑲ 触屏一上来就滑动 → 当作滚动，不误触发拖动',
    holdTest.swipe.ph === 0 && holdTest.swipe.floating === 0 &&
    holdTest.swipe.orderKept === true && holdTest.swipe.dragStats.active === false,
    `占位=${holdTest.swipe.ph} 抬起=${holdTest.swipe.floating} 顺序未变=${holdTest.swipe.orderKept}`)
  check('⑲ 触屏按住 180ms → 卡片抬起、占位块出现',
    holdTest.lifted.ph === 1 && holdTest.lifted.floating === 1,
    `占位=${holdTest.lifted.ph} 抬起=${holdTest.lifted.floating}`)
  check('⑲ 抬起后原地放回：不留占位块、顺序不乱',
    holdTest.clean.active === false && holdTest.clean.placeholders === 0 &&
    holdTest.clean.floating === 0 && holdTest.clean.stuckInline === 0 && holdTest.orderKept === true,
    JSON.stringify(holdTest.clean))

  // ⑳ 拖完那一下 click 的抑制必须是「针对被拖的那张卡 + 有时效」的。
  // 早期版本用一个全局布尔量：拖完之后点**别的**卡片也会被吃掉一下
  // （2026-09-25 截图脚本里实测到 —— 拖完再点第一张，播放页死活打不开）。
  const clickAfterDrag = await cdp.evaluate(`
    const grid = document.getElementById('galGrid')
    const cards = [...grid.querySelectorAll('.card')]
    const src = cards[1], other = cards[3]
    const handle = src.querySelector('.card-drag')
    const hr = handle.getBoundingClientRect()
    const dst = cards[4].getBoundingClientRect()
    const ev = (type, x, y) => handle.dispatchEvent(new PointerEvent(type,
      { clientX: x, clientY: y, bubbles: true, pointerId: 9, isPrimary: true }))
    const viewBefore = __bd2viewer.view
    ev('pointerdown', hr.left + 12, hr.top + 12)
    const afterDown = { active: __bd2viewer.dragStats.active, ph: __bd2viewer.dragStats.placeholders }
    ev('pointermove', dst.left + dst.width * 0.7, dst.top + dst.height * 0.7)
    const afterMove = { active: __bd2viewer.dragStats.active, floating: __bd2viewer.dragStats.floating }
    ev('pointerup', dst.left + dst.width * 0.7, dst.top + dst.height * 0.7)
    const upAt = Date.now()

    // 关键在于「立刻」点：真实浏览器就是在 pointerup 之后同一轮里补一个 click。
    // 这里**不能**先 await 一个定时器再点 —— 页面主线程被缩略图渲染占住时，
    // setTimeout(200) 实测能拖到 896ms 才回来，直接越过 700ms 的抑制窗口，
    // 于是测试会间歇性地「证明」一个并不存在的 bug（2026-09-25 踩过）。
    const draggedKey = src.dataset.key
    const dragged = [...grid.querySelectorAll('.card')].find(c => c.dataset.key === draggedKey)
    const sup = __bd2viewer.suppressClick
    dragged.click()
    const sinceUp = Date.now() - upAt
    const diag = {
      suppress: sup,
      matchesDrag: sup ? sup.key === draggedKey : null,
      sinceUp,
      overdue: sup ? upAt - sup.until : null,   // <=0 表示点击时抑制还有效
      sameNode: dragged === src,
      err: __bd2viewer.lastDragError,
      afterDown, afterMove,
    }
    const afterDraggedClick = __bd2viewer.view
    await new Promise(r => setTimeout(r, 400))
    other.click()                         // 点别的卡片：必须照常打开
    await new Promise(r => setTimeout(r, 1200))
    const afterOtherClick = __bd2viewer.view
    const opened = __bd2viewer.state.current
      ? (__bd2viewer.state.current.key || __bd2viewer.state.current.id) : null
    __bd2viewer.setView('grid')
    await new Promise(r => setTimeout(r, 400))
    return { viewBefore, afterDraggedClick, afterOtherClick, opened, diag,
             otherKey: other.dataset.key, cards: grid.querySelectorAll('.card').length }
  `, 40000)
  check('⑲b 拖完立刻点被拖的卡片：余波 click 被吃掉（不会误开播放页）',
    clickAfterDrag.afterDraggedClick === clickAfterDrag.viewBefore,
    `${clickAfterDrag.viewBefore} → ${clickAfterDrag.afterDraggedClick} · ${JSON.stringify(clickAfterDrag.diag)}`)
  check('⑲b 抑制确实装在这一张卡上、且在有效期内（不是上一轮的残留）',
    clickAfterDrag.diag.err === null && clickAfterDrag.diag.suppress !== null &&
    clickAfterDrag.diag.matchesDrag === true && clickAfterDrag.diag.sameNode === true &&
    clickAfterDrag.diag.overdue !== null && clickAfterDrag.diag.overdue <= 0 &&
    clickAfterDrag.diag.sinceUp < 200,
    `异常=${clickAfterDrag.diag.err} 同节点=${clickAfterDrag.diag.sameNode} ` +
    `同一张卡=${clickAfterDrag.diag.matchesDrag} 松手到点击=${clickAfterDrag.diag.sinceUp}ms ` +
    `距失效=${clickAfterDrag.diag.overdue}ms 拖动=${JSON.stringify(clickAfterDrag.diag.afterDown)}/` +
    `${JSON.stringify(clickAfterDrag.diag.afterMove)}`)
  check('⑲b 紧接着点别的卡片：照常打开（抑制不会外溢到其它卡片）',
    clickAfterDrag.afterOtherClick === 'player' && clickAfterDrag.opened === clickAfterDrag.otherKey,
    `view=${clickAfterDrag.afterOtherClick} 打开=${clickAfterDrag.opened} 期望=${clickAfterDrag.otherKey}`)

  // ⑳ 两种快捷排序（名称 / 日期）+ 升降序。
  // 排序必须同时作用于三处：平铺页卡片、左侧资产列表、播放页 ◀▶（= visibleKeys）。
  const sortTest = await cdp.evaluate(`
    const v = __bd2viewer
    const keysOf = () => [...document.querySelectorAll('#galGrid .card')].map(c => c.dataset.key)
    const byKey = new Map(v.state.items.concat(v.state.customItems)
      .map(i => [i.key || i.id || i.relAtlas, i]))
    const nameOf = k => { const i = byKey.get(k) || {}; return [i.folder || '', i.base || '', k] }
    const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    const cmpName = (a, b) => { const A = nameOf(a), B = nameOf(b)
      return collator.compare(A[0], B[0]) || collator.compare(A[1], B[1]) || collator.compare(A[2], B[2]) }
    const cmpDate = (a, b) => (((byKey.get(a) || {}).mtime || 0) - ((byKey.get(b) || {}).mtime || 0)) || cmpName(a, b)
    // dir = +1 要求升序、-1 要求降序（同值时按名称兜底，两个方向都一样）
    const monotone = (keys, cmp, dir = 1) => keys.every((k, i) => i === 0 || dir * cmp(keys[i - 1], k) <= 0)
    const settle = () => new Promise(r => setTimeout(r, 300))
    const tapMode = async m => {
      document.querySelector('#galSort .gs-btn[data-mode="' + m + '"]').click(); await settle()
    }
    const tapDir = async () => { document.getElementById('galSortDir').click(); await settle() }

    const manualKeys = keysOf()
    const manualGroups = document.querySelectorAll('#assetList .asset-group-title').length

    await tapMode('name')
    const byName = keysOf()
    const nameOk = monotone(byName, cmpName)
    const moved = byName.join('|') !== manualKeys.join('|')
    const pill = document.getElementById('galSort').style.getPropertyValue('--i').trim()
    const pressed = [...document.querySelectorAll('#galSort .gs-btn')]
      .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.mode)
    const playName = v.visibleKeys
    const listNames = [...document.querySelectorAll('#assetList .asset-item .ai-name')]
      .slice(0, 5).map(e => e.textContent)
    const nameGroups = document.querySelectorAll('#assetList .asset-group-title').length
    const hintName = document.getElementById('galHint').textContent
    const dirGlyph = document.getElementById('galSortDir').textContent

    await tapDir()                                       // 名称：升序 → 降序
    const byNameDesc = keysOf()

    await tapMode('date')                                // 日期：默认「新的在前」
    const byDate = keysOf()
    const dateOk = monotone(byDate, cmpDate, -1)         // 降序：cmpDate 反过来单调
    const mt = byDate.map(k => (byKey.get(k) || {}).mtime || 0)
    const dateDesc = mt.every((m, i) => i === 0 || mt[i - 1] >= m)

    // 排序状态下开始拖动 → 自动转手动，手动顺序 = 刚才屏幕上那份顺序
    const grid = document.getElementById('galGrid')
    const src = grid.querySelectorAll('.card')[0]
    const handle = src.querySelector('.card-drag')
    const hr = handle.getBoundingClientRect()
    const target = grid.querySelectorAll('.card')[1].getBoundingClientRect()
    const ev = (type, x, y) => handle.dispatchEvent(new PointerEvent(type,
      { clientX: x, clientY: y, bubbles: true, pointerId: 3, isPrimary: true }))
    const dx = target.left + target.width * 0.75
    const dy = target.top + target.height * 0.75
    const dateFirstBefore = byDate[0]
    ev('pointerdown', hr.left + 10, hr.top + 10)
    ev('pointermove', dx, dy)
    // 拖动一开始就应该把「当前排序方式排出来的全量顺序」固化成手动顺序；
    // 这一句必须在 pointerup 之前读 —— 松手后写进去的是屏幕上的（已过滤）那份。
    const seededLen = v.order.length
    const turnedManual = v.sort.mode === 'manual'
    ev('pointerup', dx, dy)
    await new Promise(r => setTimeout(r, 600))
    const afterDrag = {
      sort: v.sort, first: keysOf()[0], seededLen, turnedManual,
      coversAll: seededLen >= v.allKeys.length - 1,
      allCount: v.allKeys.length, committedLen: v.order.length,
    }

    await tapMode('name')                                // 切回名称：仍按名称排
    const back = keysOf()
    return {
      manualLen: manualKeys.length, manualGroups, nameOk, moved, pill, pressed,
      nameFirst: byName[0], dateFirstBefore,
      playMatches: playName.join('|') === byName.join('|'),
      listMatches: listNames.join('|') === byName.slice(0, 5).map(k => nameOf(k)[0]).join('|'),
      listLen: listNames.length, nameGroups, hintName, dirGlyph,
      descReversed: byNameDesc.join('|') === byName.slice().reverse().join('|'),
      dateOk, dateDesc, mtFirst: mt[0], mtLast: mt[mt.length - 1],
      afterDrag, backMatchesName: back.join('|') === byName.join('|'),
      sortRaw: localStorage.getItem('bd2.sort.' + document.getElementById('rootSelect').value),
    }
  `, 60000)
  check('⑳ 按名称排序：卡片严格按名称升序（自然序，2 在 10 前面）',
    sortTest.nameOk === true && sortTest.moved === true && sortTest.manualLen > 50,
    `按名称有序=${sortTest.nameOk} 和手动顺序不同=${sortTest.moved} 首张=${sortTest.nameFirst}`)
  check('⑳ 排序同时作用于卡片墙、左侧列表和播放顺序（三处一致）',
    sortTest.playMatches === true && sortTest.listMatches === true && sortTest.listLen === 5,
    `播放顺序一致=${sortTest.playMatches} 左列表一致=${sortTest.listMatches}`)
  check('⑳ 排序控件状态同步（滑块 + aria-pressed + 提示文案）',
    sortTest.pill === '1' && sortTest.pressed.join(',') === 'name' &&
    /按名称/.test(sortTest.hintName || '') && sortTest.dirGlyph === '↑',
    `滑块=${sortTest.pill} 选中=${sortTest.pressed} 图标=${sortTest.dirGlyph} 提示=${sortTest.hintName}`)
  check('⑳ 排序模式下列表拍平（不再每个分组插一个标题）',
    sortTest.manualGroups > 0 && sortTest.nameGroups === 0,
    `手动分组标题=${sortTest.manualGroups} 排序时分组标题=${sortTest.nameGroups}`)
  check('⑳ 升降序：名称升序点一下变降序（整体倒过来）',
    sortTest.descReversed === true, `完全倒序=${sortTest.descReversed}`)
  check('⑳ 按日期排序：mtime 单调，「新的在前」为默认',
    sortTest.dateOk === true && sortTest.dateDesc === true,
    `按日期有序=${sortTest.dateOk} 新的在前=${sortTest.dateDesc} 首=${sortTest.mtFirst} 末=${sortTest.mtLast}`)
  check('⑳ 排序状态下拖动 → 自动转手动，且手动顺序继承刚看到的顺序',
    sortTest.afterDrag.turnedManual === true && sortTest.afterDrag.coversAll === true &&
    sortTest.afterDrag.first !== sortTest.dateFirstBefore,
    `转手动=${sortTest.afterDrag.turnedManual} 固化条数=${sortTest.afterDrag.seededLen}/` +
    `${sortTest.afterDrag.allCount} 首张 ${sortTest.dateFirstBefore} → ${sortTest.afterDrag.first}`)
  check('⑳ 排序偏好写进 localStorage 并可切回（名称）',
    /"mode":"name"/.test(sortTest.sortRaw || '') && sortTest.backMatchesName === true,
    `存储=${sortTest.sortRaw} 切回名称一致=${sortTest.backMatchesName}`)

  // ㉑ 窄屏（手机宽度）：标题行折行后不能横向溢出，排序控件仍然可点。
  // 新加的排序控件就在顶栏这一行，是最容易撑破布局的地方。
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 360, height: 780, deviceScaleFactor: 2, mobile: true })
  await new Promise(r => setTimeout(r, 600))
  const narrow = await cdp.evaluate(`
    const head = document.querySelector('.gal-head')
    const tools = document.querySelector('.gal-head-tools')
    const sort = document.getElementById('galSort')
    const cols = sort ? [...sort.querySelectorAll('.gs-btn')] : []
    const r = el => el.getBoundingClientRect()
    return {
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      headW: Math.round(r(head).width), toolsW: Math.round(r(tools).width),
      toolsInside: r(tools).right <= window.innerWidth + 1 && r(tools).left >= -1,
      rows: new Set([...head.children].map(c => Math.round(r(c).top))).size,
      btnW: cols.length ? Math.round(r(cols[0]).width) : 0,
      btnH: cols.length ? Math.round(r(cols[0]).height) : 0,
      modes: cols.length,
      gridOverflowX: document.getElementById('galGrid').scrollWidth -
                     document.getElementById('galGrid').clientWidth,
    }
  `)
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  check('㉑ 360px 窄屏：标题行折成两行，没有横向溢出',
    narrow.overflowX <= 1 && narrow.toolsInside === true && narrow.rows === 2,
    `溢出=${narrow.overflowX}px 标题行数=${narrow.rows} 控件在屏内=${narrow.toolsInside}`)
  check('㉑ 窄屏下排序控件完整可用（三个按钮都在，且够大能点）',
    narrow.modes === 3 && narrow.btnW >= 48 && narrow.btnH >= 32,
    `按钮=${narrow.modes} 单个 ${narrow.btnW}×${narrow.btnH}`)
  check('㉑ 栅格没有横向溢出（窄屏两列排得下）',
    narrow.gridOverflowX <= 1, `溢出=${narrow.gridOverflowX}px`)

  // ⑰ 坏文件不能堵住缩略图队列：fixture 里没有真坏文件，用 fetch stub 伪造
  // （和 ⑬ 同一套路，只拦 /spine/*.json）。坏文件必须被标成「无法生成」并跳过，
  // 队列继续把剩下的（.skel 骨架的 16 个）全部生成完，而不是卡死在某一张上。
  const badThumb = await cdp.evaluate(`
    const orig = window.fetch
    window.fetch = function (u, o) {
      const s = String(u || '')
      if (s.includes('/spine/') && s.endsWith('.json')) {
        return Promise.resolve(new Response('{"bad":1,}', { status: 200 }))
      }
      return orig.apply(this, arguments)
    }
    // 重建缩略图：所有卡片重新排队，json 骨架的这批全部在预校验处快速失败。
    // 结束条件用「成功+失败 ≥ 总卡数」（单调），不能用 running——
    // 队列在两张卡之间有 ~80ms 间隙，running 会瞬间变 false。
    await __bd2viewer.rebuildThumbs()
    const deadline = Date.now() + 240000
    while (Date.now() < deadline) {
      const s = __bd2viewer.thumbStats
      const total = document.querySelectorAll('#galGrid .card').length
      const failed = document.querySelectorAll('#galGrid .card-thumb.failed').length
      if (s.done + failed >= total) break
      await new Promise(r => setTimeout(r, 400))
    }
    const cards = [...document.querySelectorAll('#galGrid .card')]
    window.fetch = orig
    // 等最后一条 IndexedDB 写入落盘，否则马上重启会丢最后一张的缓存
    await new Promise(r => setTimeout(r, 1500))
    return { failed: cards.filter(c => c.querySelector('.card-thumb.failed')).length,
             ok: cards.filter(c => c.querySelector('.card-thumb img')).length,
             running: __bd2viewer.thumbStats.running,
             done: __bd2viewer.thumbStats.done }
  `, 210000)
  check('⑰ 坏 JSON 的卡片标成「无法生成」（不再永远转圈）',
    badThumb.failed >= 100 && badThumb.running === false,
    `失败=${badThumb.failed} 成功=${badThumb.ok} 队列已停=${!badThumb.running}`)
  check('⑰ 队列跳过坏文件继续生成（.skel 资产照样出图）',
    badThumb.ok >= 5 && badThumb.done >= 5,
    `成功卡片=${badThumb.ok} 本次生成=${badThumb.done}`)

  // ⑰(2) 持久化：用同一个浏览器配置目录「重启」一次。成功图和失败结论
  // 都应该直接来自 IndexedDB 缓存，一张都不用重新渲、也不用重新拉坏文件。
  // 重启后默认落在另一个目录（没缓存），先拦住 /spine/ 请求不让它真去生成，
  // 等切回上次的目录再放开——否则空窗期那几张会把「零重新渲染」的断言污染掉。
  const rootBefore = await cdp.evaluate(`return document.getElementById('rootSelect').value`)
  const profileDir = cdp.profile
  await cdp.close()
  cdp = await Cdp.launch({ size: '1400,900', profile: profileDir })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (function () {
      const orig = window.fetch
      window.__origFetch = orig
      window.fetch = function (u, o) {
        if (String(u || '').includes('/spine/')) {
          return Promise.resolve(new Response('stub', { status: 500 }))
        }
        return orig.apply(this, arguments)
      }
    })()
  ` })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BRIDGE })
  await cdp.goto(`${BASE}/`)
  await cdp.waitFor(`document.querySelectorAll('#galGrid .card').length > 20`, 60000, '重启后平铺页')
  const per = await cdp.evaluate(`
    // 切回上次的目录：这一整套的缓存键都对得上
    const sel = document.getElementById('rootSelect')
    if (sel.value !== ${JSON.stringify(rootBefore)}) {
      sel.value = ${JSON.stringify(rootBefore)}
      sel.dispatchEvent(new Event('change'))
      await new Promise(r => setTimeout(r, 4000))
    }
    window.fetch = window.__origFetch      // 放开：后面 ⑰(3) 的重建要用真 fetch
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (document.querySelectorAll('#galGrid .card-thumb img').length >= 5) break
      await new Promise(r => setTimeout(r, 300))
    }
    return { imgs: document.querySelectorAll('#galGrid .card-thumb img').length,
             failed: document.querySelectorAll('#galGrid .card-thumb.failed').length,
             done: __bd2viewer.thumbStats.done,
             running: __bd2viewer.thumbStats.running,
             cards: document.querySelectorAll('#galGrid .card').length,
             sort: __bd2viewer.sort,
             sortRaw: localStorage.getItem('bd2.sort.' + document.getElementById('rootSelect').value),
             firstKey: document.querySelector('#galGrid .card')?.dataset.key || '' }
  `, 30000)
  check('⑰ 重启后缩略图直接来自缓存（本次一次都没重新渲染）',
    per.imgs >= 5 && per.done === 0,
    `有图卡片=${per.imgs}/${per.cards} 本次重新生成=${per.done} 队列在跑=${per.running}`)
  check('⑰ 重启后坏文件仍是「无法生成」（失败结论也持久化，不再重新拉坏文件）',
    per.failed >= 100, `失败卡片=${per.failed}`)
  // 排序偏好也是按目录记住的：重启 + 切目录之后必须还是「名称」
  check('⑰ 排序偏好跨重启保留（仍是按名称）',
    per.sort.mode === 'name' && /"mode":"name"/.test(per.sortRaw || ''),
    `mode=${per.sort.mode} 存储=${per.sortRaw}`)

  // ⑰(3) 恢复：文件修好后（这里等于撤掉 stub）重建一次，坏卡要能重新出图
  const rec = await cdp.evaluate(`
    await __bd2viewer.rebuildThumbs()
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (__bd2viewer.thumbStats.done >= 5) break
      await new Promise(r => setTimeout(r, 400))
    }
    return { imgs: document.querySelectorAll('#galGrid .card-thumb img').length,
             done: __bd2viewer.thumbStats.done,
             failed: document.querySelectorAll('#galGrid .card-thumb.failed').length }
  `, 150000)
  check('⑰ 文件恢复后重建，之前失败的卡也能重新出图',
    rec.imgs >= 5 && rec.done >= 5,
    `有图卡片=${rec.imgs} 本次生成=${rec.done} 失败=${rec.failed}`)

  // ㉑(2) 长按 → 操作菜单；批量选择 → 删除。
  // 原生通路这里只验证「前端把正确清单交给了桥、并把结果同步到界面」——
  // 假桥不碰磁盘；真删文件那条路（/api/delete）由 _test/delete_api.mjs 在
  // 它自己建的临时根目录里验证，绝不会碰到用户的 mods 目录。
  const delTest = await cdp.evaluate(`
    const v = __bd2viewer
    const grid = document.getElementById('galGrid')
    const wait = ms => new Promise(r => setTimeout(r, ms))
    v.setView('grid')
    await wait(500)

    // ① 长按（触屏按住不动 560ms > 180+320ms）应弹出操作菜单，且不留下拖动残骸
    const orderBefore = v.visibleKeys.join('|')
    const card0 = grid.querySelector('.card')
    const inner = card0.querySelector('.card-thumb')
    const r = inner.getBoundingClientRect()
    const ev = (t, x, y, id) => inner.dispatchEvent(new PointerEvent(t,
      { clientX: x, clientY: y, bubbles: true, pointerId: id, isPrimary: true, pointerType: 'touch' }))
    ev('pointerdown', r.left + 20, r.top + 20, 41)
    // 轮询等菜单出现（别写死 560ms：主线程忙时定时器会晚一拍，那是指标抖动不是功能坏了）
    const t0 = performance.now()
    let waited = -1
    for (let i = 0; i < 80; i++) {
      await wait(25)
      if (!document.getElementById('cardMenu').hidden) { waited = Math.round(performance.now() - t0); break }
    }
    const menu = {
      open: !document.getElementById('cardMenu').hidden, waited,
      name: document.getElementById('cardMenuName').textContent,
      info: document.getElementById('cardMenuInfo').textContent,
      ph: grid.querySelectorAll('.card-ph').length,
      floating: grid.querySelectorAll('.card.dragging').length,
      active: v.dragStats.active,
    }
    // 抬手：浏览器补的那一下 click 会不会在菜单背后把播放页打开？
    ev('pointerup', r.left + 20, r.top + 20, 41)
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(600)
    const viewAfterHold = v.view
    document.getElementById('cardMenu').hidden = true
    await wait(300)
    const afterHold = { orderKept: v.visibleKeys.join('|') === orderBefore, drag: v.dragStats, viewAfterHold }

    // ② 桌面右键 = 同一个菜单
    card0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const ctxMenu = !document.getElementById('cardMenu').hidden
    document.getElementById('cardMenu').hidden = true

    // ③ 进批量选择 → 勾两张 → 删除（先点取消，再点确认）
    const keysBefore = v.allKeys.length
    const allCards = () => [...grid.querySelectorAll('.card')]
    const cards0 = allCards()
    const victimKeys = [cards0[1].dataset.key, cards0[2].dataset.key]
    const total0 = cards0.length
    document.getElementById('galSelect').click()
    await wait(300)
    const inSelect = { mode: v.selectMode, bar: !document.getElementById('galSelBar').hidden,
                       checks: document.querySelectorAll('#galGrid .card-check').length,
                       total: total0 }
    allCards().find(c => c.dataset.key === victimKeys[0]).click()
    allCards().find(c => c.dataset.key === victimKeys[1]).click()
    await wait(200)
    const picked = { keys: v.selectedKeys.slice(), view: v.view,
                     count: document.getElementById('galSelCount').textContent,
                     canDelete: !document.getElementById('galSelDelete').disabled }

    document.getElementById('galSelDelete').click()
    await wait(500)
    const firstRow = document.querySelector('#confirmList .confirm-row')
    const confirmBox = {
      open: !document.getElementById('confirmModal').hidden,
      warn: document.getElementById('confirmWarn').textContent,
      rows: document.querySelectorAll('#confirmList .confirm-row').length,
      firstFiles: firstRow ? firstRow.querySelector('.cr-files').textContent : '',
      firstTitle: firstRow ? firstRow.querySelector('.cr-name').textContent : '',
      deletedSoFar: (window.__deleted || []).length,
    }
    document.getElementById('confirmNo').click()
    await wait(500)
    const afterCancel = { modalHidden: document.getElementById('confirmModal').hidden,
                          sameCount: v.allKeys.length === keysBefore,
                          stillSelected: v.selectedKeys.length,
                          cards: allCards().length }

    document.getElementById('galSelDelete').click()
    await wait(500)
    document.getElementById('confirmYes').click()
    await wait(1500)
    const sent = (window.__deleted || [])[(window.__deleted || []).length - 1] || { items: [] }
    const afterDelete = {
      cards: allCards().length,
      keys: v.allKeys.length,
      goneKeys: victimKeys.filter(k => !v.allKeys.includes(k)),
      sentKeys: sent.items.map(x => x.relAtlas),
      payloadOk: sent.items.length > 0 && sent.items.every(x =>
        x.relAtlas && Array.isArray(x.relImages) && 'relSkeleton' in x),
      rootId: sent.rootId,
      toast: document.getElementById('toast').textContent,
    }
    document.getElementById('galSelDone').click()
    await wait(300)
    return { menu, afterHold, ctxMenu, inSelect, picked, confirmBox, afterCancel, afterDelete,
             outOfSelect: v.selectMode, keysBefore, total0 }
  `, 120000)
  check('㉑ 长按卡片（按住不动 ~560ms）弹出操作菜单，且没有进入拖动',
    delTest.menu.open === true && delTest.menu.name.includes('/') &&
    /磁盘文件|上传/.test(delTest.menu.info) &&
    delTest.menu.ph === 0 && delTest.menu.floating === 0 && delTest.menu.active === false,
    `菜单=${delTest.menu.open}(${delTest.menu.waited}ms) 名称=「${delTest.menu.name}」信息=「${delTest.menu.info}」`)
  check('㉑ 长按抬手那一下 click 被吃掉（不会在菜单背后打开播放页）',
    delTest.afterHold.viewAfterHold === 'grid', `view=${delTest.afterHold.viewAfterHold}`)
  check('㉑ 长按不写播放顺序（放弃的拖动不算重排）',
    delTest.afterHold.orderKept === true && delTest.afterHold.drag.active === false &&
    delTest.afterHold.drag.placeholders === 0 && delTest.afterHold.drag.stuckInline === 0,
    `顺序未变=${delTest.afterHold.orderKept} ${JSON.stringify(delTest.afterHold.drag)}`)
  check('㉑ 桌面右键也能唤出同一个菜单', delTest.ctxMenu === true, `右键菜单=${delTest.ctxMenu}`)
  check('㉑ 「选择」进入批量模式：操作条出现、每张卡都带选择圈',
    delTest.inSelect.mode === true && delTest.inSelect.bar === true &&
    delTest.inSelect.checks === delTest.inSelect.total && delTest.inSelect.total > 50,
    `模式=${delTest.inSelect.mode} 选择圈=${delTest.inSelect.checks}/${delTest.inSelect.total}`)
  check('㉑ 选择模式下点卡片 = 勾选（不会误开播放页）',
    delTest.picked.keys.length === 2 && delTest.picked.view === 'grid' &&
    delTest.picked.canDelete === true,
    `已选=${JSON.stringify(delTest.picked.keys)} view=${delTest.picked.view} 计数=「${delTest.picked.count}」`)
  check('㉑ 删除前必须先过二次确认（弹窗列出待删文件，此时一个都没删）',
    delTest.confirmBox.open === true && delTest.confirmBox.rows === 2 &&
    /不可恢复|危险/.test(delTest.confirmBox.warn) && /atlas/.test(delTest.confirmBox.firstFiles) &&
    delTest.confirmBox.deletedSoFar === 0,
    `弹窗=${delTest.confirmBox.open} 行数=${delTest.confirmBox.rows} ` +
    `首行=「${delTest.confirmBox.firstTitle}」文件=「${delTest.confirmBox.firstFiles}」`)
  check('㉑ 确认框点「取消」：什么都不删、选中保持、卡片数不变',
    delTest.afterCancel.modalHidden === true && delTest.afterCancel.sameCount === true &&
    delTest.afterCancel.stillSelected === 2 && delTest.afterCancel.cards === delTest.inSelect.total,
    JSON.stringify(delTest.afterCancel))
  check('㉑ 确认删除：交给原生的是 atlas + skeleton + 贴图清单',
    delTest.afterDelete.payloadOk === true && delTest.afterDelete.sentKeys.length === 2,
    `rootId=${delTest.afterDelete.rootId} 清单=${JSON.stringify(delTest.afterDelete.sentKeys)}`)
  check('㉑ 删除后卡片墙与资产列表同步少掉这两个',
    delTest.afterDelete.goneKeys.length === 2 &&
    delTest.afterDelete.cards === delTest.inSelect.total - 2 &&
    delTest.afterDelete.keys === delTest.keysBefore - 2,
    `卡片 ${delTest.inSelect.total} → ${delTest.afterDelete.cards} · ` +
    `资产 ${delTest.keysBefore} → ${delTest.afterDelete.keys} · 提示=「${delTest.afterDelete.toast}」`)
  check('㉑ 「完成」退出选择模式', delTest.outOfSelect === false, `selectMode=${delTest.outOfSelect}`)





  /* ㉒ 播放页两对箭头：画面两侧切「动画」，底部 ◀◀/▶▶ 切「资产」 ------------------
     这两处分工与常见布局是**相反的**（原先是两侧切资产、底部切动画，按要求对调）。
     显示条件被刻意拆成两层：
       · 模式层（沉浸时让位给全屏底部条里那对）→ styles.css
       · 数据层（当前资产有几个动画可切）      → JS 挂 body.stage-nav-avail
     所以既验「两侧点了真的换动画、底部点了真的换资产」，也验「显隐条件跟着动作走」。 */
  const navTest = await cdp.evaluate(`
    const v = __bd2viewer
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const vis = id => getComputedStyle(document.getElementById(id)).display !== 'none'
    const key = it => it.key || it.id || it.relAtlas || ''
    const loadAndWait = async it => {
      v.openItem(it)
      // openItem 里 resetMeta() 是同步跑的（S.animations 立刻清空），
      // 所以「非空」就是本轮载入完成的信号；坏文件会超时，由调用方记成 skipped
      const t0 = performance.now()
      while (performance.now() - t0 < 3000 && !v.animations.length) await wait(80)
      await wait(120)
    }
    const out = { samples: [], skipped: 0 }

    v.setSelectMode(false)
    v.setFullscreen(false)
    v.setView('grid')
    await wait(300)

    // ① 资产页不该出现这对箭头（它们的家是播放页）
    out.gridHidden = !vis('stagePrev') && !vis('stageNext')

    // ② 抽样：记「动画数 / body 类 / 箭头可见」，挑出多动画与单动画各一套。
    //    核心等式：箭头可见 === (当前资产动画数 > 1)。
    let multi = null, single = null
    const deadline = performance.now() + 40000
    // 跨步长取样：目录里各 mod 的动画数差别很大（实测见过 2/3/4/5/7/10/40），
    // 走一遍相邻的几套容易漏掉「只有 1 个动画」那种，边界就覆盖不到。
    for (let i = 0; i < 48 && performance.now() < deadline && !(multi && single); i += 2) {
      const it = v.state.items.find(x => key(x) === v.visibleKeys[i])
      if (!it) continue
      await loadAndWait(it)
      const n = v.animations.length
      if (!n) { out.skipped++; continue }        // 坏 JSON / 懒加载失败 —— 不算样本
      const cls = document.body.classList.contains('stage-nav-avail')
      const shown = vis('stagePrev') && vis('stageNext')
      out.samples.push({ n: n, cls: cls, shown: shown })
      if (n > 1 && !multi) multi = it
      if (n === 1 && !single) single = it
    }
    out.counts = [...new Set(out.samples.map(s => s.n))].sort((a, b) => a - b)
    out.eqOk = out.samples.length > 0 &&
      out.samples.every(s => s.cls === (s.n > 1) && s.shown === s.cls)
    out.hasMulti = !!multi
    out.hasSingle = !!single

    // ③ 多动画资产：画面两侧箭头切**动画**（资产不动）
    if (multi) {
      await loadAndWait(multi)
      out.view = v.view
      out.shown = vis('stagePrev') && vis('stageNext')
      const sp = document.getElementById('stagePrev').getBoundingClientRect()
      const sn = document.getElementById('stageNext').getBoundingClientRect()
      const st = document.getElementById('stageInner').getBoundingClientRect()
      out.sides = sp.left < st.left + st.width / 2 && sn.left > st.left + st.width / 2
      out.animCount = v.animations.length
      const a0 = v.animation
      const i0 = v.animations.indexOf(a0)
      const itemBefore = key(v.state.current)
      document.getElementById('stageNext').click()
      await wait(400)
      out.animNextOk = v.animation === v.animations[(i0 + 1) % v.animations.length]
      out.animToast = document.getElementById('toast').textContent
      out.animKeptItem = key(v.state.current) === itemBefore
      document.getElementById('stagePrev').click()
      await wait(400)
      out.animBack = v.animation === a0
    }

    // ④ 底部 ◀◀ / ▶▶ 切**资产**，顺序与列表同一口径（visibleKeys 是唯一顺序）
    const anyItem = multi || v.state.items.find(x => key(x) === v.visibleKeys[0])
    await loadAndWait(anyItem)
    const itemStart = key(v.state.current)
    const li = v.visibleKeys.indexOf(itemStart)
    const expectNext = v.visibleKeys[(li + 1) % v.visibleKeys.length]
    document.getElementById('mFwd').click()
    await wait(700)
    out.itemChanged = key(v.state.current) !== itemStart
    out.itemIsNextInList = key(v.state.current) === expectNext
    out.itemToast = document.getElementById('toast').textContent
    document.getElementById('mBack').click()
    await wait(700)
    out.itemBack = key(v.state.current) === itemStart

    // ⑤ 单动画资产：两侧箭头自己藏起来（条件跟动作走，不看资产数）
    if (single) {
      await loadAndWait(single)
      out.singleAnims = v.animations.length
      out.singleCls = document.body.classList.contains('stage-nav-avail')
      out.singleHidden = !vis('stagePrev') && !vis('stageNext')
      out.singleAssets = v.visibleKeys.length
    }

    out.listTotal = v.visibleKeys.length
    v.setView('grid')
    v.setFullscreen(false)
    return out
  `, 180000)
  check('㉒ 两侧箭头只属于播放页（资产页看不到）',
    navTest.gridHidden === true, `资产页隐藏=${navTest.gridHidden}`)
  check('㉒ 箭头显隐 === (当前资产动画数 > 1)：逐套资产取样都成立',
    navTest.eqOk === true && navTest.hasMulti === true,
    `样本 ${navTest.samples.length} 套（跳过 ${navTest.skipped} 套载不动的）· ` +
    `出现的动画数=${JSON.stringify(navTest.counts)} · 等式全成立=${navTest.eqOk}`)
  check('㉒ 画面两侧箭头切「动画」：点右 → 下一个动画，点左 → 原路返回',
    navTest.hasMulti === true && navTest.shown === true && navTest.sides === true &&
    navTest.animNextOk === true && navTest.animBack === true && navTest.animKeptItem === true,
    `动画数=${navTest.animCount} 显示=${navTest.shown} 左右站位=${navTest.sides} ` +
    `下一个动画对=${navTest.animNextOk} 切换资产=false(${navTest.animKeptItem}) ` +
    `原路返回=${navTest.animBack} 提示=「${navTest.animToast}」`)
  check('㉒ 底部 ◀◀/▶▶ 切「资产」：点 ▶▶ → 列表里的下一个，点 ◀◀ → 原路返回',
    navTest.itemChanged === true && navTest.itemIsNextInList === true && navTest.itemBack === true,
    `换了资产=${navTest.itemChanged} 正是列表下一个=${navTest.itemIsNextInList} ` +
    `原路返回=${navTest.itemBack} 提示=「${navTest.itemToast}」`)
  check('㉒ 单动画资产：两侧箭头自动藏起来（不是照着资产数亮）',
    navTest.hasSingle === true ? (navTest.singleAnims === 1 && navTest.singleCls === false &&
      navTest.singleHidden === true) : true,
    navTest.hasSingle
      ? `该资产动画数=${navTest.singleAnims} 类名=${navTest.singleCls} 隐藏=${navTest.singleHidden}`
      : `本目录没找到单动画资产（可见 ${navTest.listTotal} 套），等式已在 ${navTest.samples.length} 套上验证`)

  /* ㉓ 返回键的分层消化 ------------------------------------------------
     一次返回从最上面那层往下剥：对话框 → 全屏文件侧栏 → 抽屉 → 批量选择
     → 全屏 → 播放页回资产页 → 才轮到宿主退 App。
     真机里 MainActivity.onBackPressed 先问页面要这个结果（见 JS_BACK）。 */
  const backTest = await cdp.evaluate(`
    const v = __bd2viewer
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const el = id => document.getElementById(id)
    const out = {}

    v.setFullscreen(false)
    v.setSelectMode(false)
    for (const id of ['settingsModal', 'uploadModal', 'helpModal', 'cardMenu', 'confirmModal']) el(id).hidden = true
    v.setView('grid')
    await wait(300)

    // ① 资产页最外层、什么都没开 —— 页面不消化，返回键该交给宿主（退到桌面）
    out.rootSnap = {
      view: v.view, fs: v.isFullscreen, select: v.selectMode,
      sheet: el('sheetScrim').hidden, cardSelect: document.body.classList.contains('card-select'),
      modals: ['confirmModal', 'settingsModal', 'uploadModal', 'helpModal', 'cardMenu']
        .filter(id => !el(id).hidden),
    }
    out.rootFalse = v.handleBack() === false
    out.rootWhy = v.lastBackReason

    // ② 删除确认框：返回键 = 取消；而且 Promise 必须 resolve(false)，不能挂着
    let confirmResult = 'pending'
    const p = v.confirmDelete([v.state.items[0]]).then(r => { confirmResult = r })
    await wait(200)
    out.confirmOpen = !el('confirmModal').hidden
    out.confirmBack = v.handleBack() === true
    await p
    out.confirmClosed = el('confirmModal').hidden
    out.confirmCancelled = confirmResult === false

    // ③ 设置弹窗（走底部「设置」标签这个真实入口）
    document.querySelector('.mtab[data-sheet="set"]').click()
    await wait(200)
    out.setOpen = !el('settingsModal').hidden
    out.setBack = v.handleBack() === true
    out.setClosed = el('settingsModal').hidden

    // ④ 上传 / 帮助弹窗
    el('btnUpload').click()
    await wait(150)
    out.upBack = v.handleBack() === true && el('uploadModal').hidden === true
    el('btnHelp').click()
    await wait(150)
    out.helpBack = v.handleBack() === true && el('helpModal').hidden === true

    // ⑤ 层次优先级：抽屉压在批量选择之上 —— 先收抽屉，选择模式原样留着
    document.querySelector('.mtab[data-sheet="asset"]').click()
    await wait(250)
    v.setSelectMode(true)
    await wait(250)
    out.bothOpen = el('sheetScrim').hidden === false && v.selectMode === true
    out.drawerFirst = v.handleBack() === true
    out.drawerClosed = el('sheetScrim').hidden === true
    out.selectKept = v.selectMode === true
    out.selectNext = v.handleBack() === true && v.selectMode === false

    // ⑥ 全屏：返回键先退全屏
    v.setFullscreen(true)
    await wait(300)
    out.fsOn = v.isFullscreen === true
    out.fsBack = v.handleBack() === true
    out.fsOff = v.isFullscreen === false

    // ⑦ 播放页 → 资产页（是回上一层，不是退出软件）
    v.openItem(v.state.items.find(i => (i.key || i.id || i.relAtlas) === v.visibleKeys[0]))
    await wait(450)
    out.inPlayer = v.view
    out.playerBack = v.handleBack() === true
    out.backToGrid = v.view
    out.gridFalse = v.handleBack() === false

    // ⑧ 一次只剥一层：全屏播放页按返回 → 先退全屏，人还留在播放页
    v.openItem(v.state.items.find(i => (i.key || i.id || i.relAtlas) === v.visibleKeys[0]))
    await wait(450)
    v.setFullscreen(true)
    await wait(300)
    out.fsPlayerOn = v.isFullscreen === true && v.view === 'player'
    v.handleBack()
    await wait(300)
    out.oneLayerOnly = v.isFullscreen === false && v.view === 'player'
    v.handleBack()
    await wait(250)
    out.thenPlayerBack = v.view === 'grid'

    v.setFullscreen(false)
    return out
  `, 90000)
  check('㉓ 资产页最外层按返回 → 页面不消化（交给宿主退 App）',
    backTest.rootFalse === true,
    `handleBack()=${backTest.rootFalse} 被谁吃=${backTest.rootWhy} ` +
    `状态=${JSON.stringify(backTest.rootSnap)}`)
  check('㉓ 删除确认框：返回键 = 取消，且 Promise resolve(false) 不会挂住',
    backTest.confirmOpen === true && backTest.confirmBack === true &&
    backTest.confirmClosed === true && backTest.confirmCancelled === true,
    `弹出=${backTest.confirmOpen} 消化=${backTest.confirmBack} 关闭=${backTest.confirmClosed} ` +
    `已取消=${backTest.confirmCancelled}`)
  check('㉓ 设置弹窗：返回键先关弹窗',
    backTest.setOpen === true && backTest.setBack === true && backTest.setClosed === true,
    `弹出=${backTest.setOpen} 关闭=${backTest.setClosed}`)
  check('㉓ 上传 / 帮助弹窗同样被返回键消化',
    backTest.upBack === true && backTest.helpBack === true,
    `上传=${backTest.upBack} 帮助=${backTest.helpBack}`)
  check('㉓ 层次优先级：抽屉压在批量选择之上（先收抽屉，选择模式保持）',
    backTest.bothOpen === true && backTest.drawerFirst === true &&
    backTest.drawerClosed === true && backTest.selectKept === true && backTest.selectNext === true,
    `两者同开=${backTest.bothOpen} 先收抽屉=${backTest.drawerClosed} 选择模式保持=${backTest.selectKept} ` +
    `再按一次退出选择=${backTest.selectNext}`)
  check('㉓ 全屏时返回键先退全屏',
    backTest.fsOn === true && backTest.fsBack === true && backTest.fsOff === true,
    `进全屏=${backTest.fsOn} 退全屏=${backTest.fsOff}`)
  check('㉓ 播放页按返回 → 回资产页（不是退出软件）',
    backTest.inPlayer === 'player' && backTest.playerBack === true &&
    backTest.backToGrid === 'grid' && backTest.gridFalse === true,
    `播放页=${backTest.inPlayer} → ${backTest.backToGrid} · 回资产页后再按=false(${backTest.gridFalse})`)
  check('㉓ 一次只剥一层：全屏播放页按返回先退全屏，人还在播放页',
    backTest.fsPlayerOn === true && backTest.oneLayerOnly === true && backTest.thenPlayerBack === true,
    `全屏播放→退全屏仍在播放页=${backTest.oneLayerOnly} 再按才回资产页=${backTest.thenPlayerBack}`)

} catch (e) {
  check('测试执行', false, e.message)
} finally {
  console.log(results.join('\n'))
  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 失败 ' + failed}  （共 ${results.length} 项）`)
  await cdp.close()
  process.exit(failed ? 1 : 0)
}
