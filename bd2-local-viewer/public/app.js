/* =============================================================================
 * BD2 Local L2D / Spine Viewer
 *
 * 本项目基于 jelosus2/BD2-L2D-Viewer 构建：
 *   https://github.com/Jelosus2/BD2-L2D-Viewer
 *   MIT License, Copyright (c) 2025 Jelosus2
 * 功能形态与交互设计沿用该项目 —— 动画列表 / 皮肤 / 播放与速度 / 缩放平移 /
 * 图层显隐与点选 / 背景 / 截图 / 导出。
 * 源码为独立重写（上游是 Vue 3 + TypeScript + Vite，这里是单文件原生 JS），未复制其源码。
 * 差异：数据源改为扫描本地 BD2 mod 目录（BrownDustX/mods），并支持手动上传 Spine 文件。
 * 完整声明见仓库根目录 THIRD-PARTY-NOTICES.md。
 * ========================================================================== */

const spine = window.spine
const JSZip = window.JSZip

const $ = id => document.getElementById(id)
const clamp = (v, a, b) => Math.min(Math.max(v, a), b)

/* ------------------------------------------------------------------ 状态 */

const S = {
  config: null,
  rootId: null,
  items: [],            // 服务端扫描到的资产
  customItems: [],      // 手动上传的资产
  current: null,
  player: null,
  camera: null,
  bounds: null,
  defaultPos: { x: 0, y: 0 },
  defaultZoom: 1,
  animations: [],
  skins: [],
  slots: [],
  hidden: new Set(),
  hiddenStack: [],
  selectedLayer: null,
  playing: true,
  speed: 1,
  loop: true,
  autoPlay: true,
  autoRefit: true,
  bgColor: '#1f2937',
  bgImageUrl: null,
  premultiplied: true,
  layerSelect: false,
  useCurrentCamera: false,
  maxSize: 3000,
  fps: 60,
  busy: false,
  volDir: (function () {
    try { return localStorage.getItem('bd2.volDir') === 'prev' ? 'prev' : 'next' } catch { return 'next' }
  })(),   // 音量上键 = 下一个（next）还是上一个（prev）
}

let cancelled = false

/* ------------------------------------------------------------------ 小工具 */

function showError(msg) {
  const box = $('errorBox')
  box.textContent = msg
  box.hidden = false
  clearTimeout(showError._t)
  showError._t = setTimeout(() => { box.hidden = true }, 9000)
}

function clearError() { $('errorBox').hidden = true }
function setBusy(on, text) {
  S.busy = on
  const sp = $('spinner')
  sp.hidden = !on
  if (text) sp.lastChild.textContent = text
}

// 没被捕获的 Promise 异常也给出可读提示（不阻塞任何交互，9 秒自动消失）
window.addEventListener('unhandledrejection', e => {
  const r = e?.reason
  showError('后台任务出错：' + (r?.message || String(r)))
})

function hexToRgba(hex, alpha) {
  const h = (hex || '#1f2937').replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0').slice(0, 6)
  return '#' + full + (alpha || 'ff')
}

function download(blobOrUrl, filename) {
  if (NATIVE && typeof blobOrUrl !== 'string') { nativeSave(blobOrUrl, filename); return }
  if (NATIVE && blobOrUrl.startsWith('data:')) {
    // dataURL：转成 blob 再交给原生保存，避免走 a[download]
    fetch(blobOrUrl).then(r => r.blob()).then(b => nativeSave(b, filename))
    return
  }
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 4000)
}

function safeName(s) {
  return String(s || 'spine').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
}

/* ------------------------------------------------- 贴图预乘 alpha 补丁
 * BD2 的 atlas PNG 是直通 alpha。spine-player 的 premultipliedAlpha 只作用于
 * canvas context，上传贴图时并不会预乘，因此需要补丁，否则叠加/加法混合会出错。
 * 这一点是照搬原站 SpineViewer.vue 的做法。
 */

let glPatchState = null
function ensureGLTexturePatch() {
  if (glPatchState) return glPatchState
  const proto = spine.GLTexture.prototype
  const original = proto.update
  const patched = function (useMipMaps) {
    const gl = this.context.gl
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    original.call(this, useMipMaps)
  }
  glPatchState = { proto, original, patched }
  return glPatchState
}

function applyGLTexturePatch(enabled) {
  const { proto, original, patched } = ensureGLTexturePatch()
  proto.update = enabled ? patched : original
}

/* ------------------------------------------------- 数据源：浏览器 / 原生 APK
 * 桌面版由本地 Node 服务提供 /api/* 与 /spine/*。
 * APK 版没有服务端：目录扫描与文件读取都由 Android 原生层做，
 * 结果通过 evaluateJavascript 推回来，资源仍走 /spine/<rootId>/<rel>
 * （由 WebView 的 shouldInterceptRequest 拦截后从磁盘读取）。
 */

const NATIVE = typeof window.BD2Native !== 'undefined' && !!window.BD2Native

const nativeWaiters = {}
function nativeAsk(kind, call, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    nativeWaiters[kind] = resolve
    const timer = setTimeout(() => {
      nativeWaiters[kind] = null
      reject(new Error('原生层无响应：' + kind))
    }, timeoutMs)
    nativeWaiters[kind + ':timer'] = timer
    try { call() } catch (e) { nativeWaiters[kind] = null; clearTimeout(timer); reject(e) }
  })
}
window.__native = {
  onRoots(payload) { const t = nativeWaiters['roots:timer']; if (t) clearTimeout(t); nativeWaiters.roots?.(payload); nativeWaiters.roots = null },
  // 原生只回元信息（几十字节），items 由 scanPage 分页同步取。
  // 一次性推几 MB 的 JSON 给 evaluateJavascript 会把进程压崩。
  onScanMeta(payload) { const t = nativeWaiters['scan:timer']; if (t) clearTimeout(t); nativeWaiters.scan?.(payload); nativeWaiters.scan = null },
  onError(msg) { showError(String(msg)) },
  onCrash(msg) { showError('上次运行崩溃了：\n' + String(msg).split('\n').slice(0, 6).join('\n')) },
  // 从系统权限设置页回到 App：权限可能刚开，重画目录提示并按需重扫
  onPermission() { refreshRootsAndRescan() },
}

/* 原生模式下把产出交回 Android 保存（WebView 里 a[download] 不会落盘） */
function nativeSave(blob, filename) {
  const reader = new FileReader()
  reader.onloadend = () => {
    const dataUrl = String(reader.result || '')
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    try {
      const ok = window.BD2Native.saveBlob(filename, base64)
      if (ok) window.BD2Native.toast('已保存：' + filename)
    } catch (e) { showError('保存失败：' + e.message) }
  }
  reader.onerror = () => showError('读取导出结果失败')
  reader.readAsDataURL(blob)
}

/* ------------------------------------------------------------------ 启动 */

/** 深链参数 ?item=<键>；没有就返回 null */
function deepLinkItem() { return new URLSearchParams(location.search).get('item') }

/** 首次进入该落在哪一页：带 ?item= 深链 → 播放页，否则资产页。 */
function initialView() { return deepLinkItem() ? 'player' : 'grid' }

async function boot() {
  applyGLTexturePatch(true)
  if (NATIVE) applyTouchMode()
  bindUI()
  // 首屏必须在**这里**同步定下来 —— 不能等 scan() 收尾。
  // 之前只有 scan() 末尾那一句 setView('grid')，于是每次启动都会先画一屏
  // 播放页布局（舞台 + 顶栏 + 底部标签），扫描结束再「啪」地跳到资产页；
  // 真机大目录扫描要几秒（实测 2753ms），用户每次都看得到这个闪变。
  // index.html 上的 <body class="view-grid"> 是同一结论的静态预置，
  // 让第一帧就是资产页；这里再对齐一次 JS 的 viewMode，并把「设置」入口摆对。
  setView(initialView())
  updateVolumeKeyHints()
  await loadConfig()
  await scan(false)
}

/* 手机上没有键盘：快捷键入口收起来，改用底部抽屉 + 大按钮的操作方式 */
function applyTouchMode() {
  document.body.classList.add('is-touch')
  const help = $('btnHelp')
  if (help) help.hidden = true
  // 「上传文件」只放进内存不落盘，手机上用「导入文件」（直接写进目录）就够了
  const up = $('btnUpload')
  if (up) up.hidden = true
  // 设置在底部标签里有入口，但平铺页没有标签栏 —— 具体露不露由
  // syncTouchSettingsEntry() 按当前视图决定，这里先按「播放页」的默认藏起来。
  const set = $('btnSettings')
  if (set) set.hidden = true
  // 全屏入口改成画面右上角的 ⛶ 图标，顶栏不再放文字按钮
  const fsTop = $('btnFullscreen')
  if (fsTop) fsTop.hidden = true
  // 平铺入口同理：手机上用画面左上角的 ⊞
  const gridTop = $('btnGrid')
  if (gridTop) gridTop.hidden = true
  const sub = document.querySelector('.empty-sub')
  if (sub) sub.textContent = '点底部「资产」选一套，或用顶部「导入文件」把文件拷进来'
  detectScreenProfile()
  window.addEventListener('resize', scheduleScreenProfile)   // 旋转 / 分屏 / 折叠屏展开
  setupMobileShell()
}

/* resize 之后推迟一拍再测一次。
   实测（2026-09-25）：视口尺寸先变、screen.width/height 晚一点才跟上 ——
   CDP 的 Emulation.setDeviceMetricsOverride 就是这样，真机上旋转/折叠屏展开
   同理。只在 resize 那一刻测，会拿旧屏幕尺寸算出错误的 scr-tall，漏标整块布局。
   多测一次是幂等的，代价只有一次 getter 读取。 */
let screenProfileTimer = 0
function scheduleScreenProfile() {
  detectScreenProfile()
  clearTimeout(screenProfileTimer)
  screenProfileTimer = setTimeout(detectScreenProfile, 260)
}

/* 检测物理分辨率与屏幕比例，给 body 打标记类，CSS 据此做针对性布局：
     .scr-narrow  短边 < 400 或视口 < 420 —— 竖屏手机：全屏面板改底部全宽、顶栏紧凑
     .scr-tall    长:短 >= 1.95           —— 全面屏：顶栏给挖孔/刘海多让一截
   每次启动都现测（比"安装时"更准：旋转、分屏、折叠屏都能跟上）。 */
function detectScreenProfile() {
  const s = window.screen || {}
  const w = s.width || 0
  const h = s.height || 0
  const short = Math.min(w, h) || 0
  const long = Math.max(w, h)
  const ratio = short ? +(long / short).toFixed(2) : 0
  const cls = document.body.classList
  cls.toggle('scr-narrow', (short > 0 && short < 400) || window.innerWidth < 420)
  cls.toggle('scr-tall', short > 0 && ratio >= 1.95)
  return { w, h, ratio }
}

/* ------------------------------------------------- 手机端底部抽屉
   屏幕只有一列宽：左右两栏改成从底部升起的抽屉，底部标签切换，
   选中资产后自动收起，立刻就能看到动画。 */
let sheetOpen = ''

function setupMobileShell() {
  const tabs = $('mTabs')
  if (!tabs) return
  tabs.hidden = false
  const quick = $('mQuick')
  if (quick) quick.hidden = false
  const now = $('mNow')
  if (now) now.hidden = false

  tabs.querySelectorAll('.mtab').forEach(b => {
    b.onclick = () => {
      const name = b.dataset.sheet
      if (name === 'set') { $('settingsModal').hidden = false; return }
      toggleSheet(name)
    }
  })
  const scrim = $('sheetScrim')
  if (scrim) scrim.onclick = () => toggleSheet('')

  $('mPlay').onclick = () => setPlaying(!S.playing)
  // 这两个箭头切**资产**（上一个 / 下一个 L2D），不是逐帧步进 ——
  // 逐帧已经在播放页的 ◀│/│▶ 和键盘 ←/→ 上有了。
  // 和画面两侧的箭头分工是**对调过**的：手机上「换一套 L2D」比「换动作」少见，
  // 所以把大而易按的画面两侧箭头留给换动作（见 bindUI 里的 stagePrev/stageNext）。
  $('mBack').onclick = () => switchItem(-1)
  $('mFwd').onclick = () => switchItem(1)
  $('mReset').onclick = () => resetCamera()

  // 当前资产名：左侧栏收进抽屉后，舞台下方补一行。
  // 用 MutationObserver 跟着 #currentName 走，不必在每个赋值点都改一遍。
  if (now && window.MutationObserver) {
    const src = $('currentName')
    const mirror = () => { now.textContent = src.textContent }
    new MutationObserver(mirror).observe(src, { childList: true, characterData: true, subtree: true })
    mirror()
  }
}

function toggleSheet(name) {
  const left = document.querySelector('.side-left')
  const right = document.querySelector('.side-right')
  if (!left || !right) return
  // 再点一次同一个标签 = 收起
  if (name && name === sheetOpen) name = ''
  sheetOpen = name || ''

  left.classList.toggle('open', name === 'ctrl' || name === 'layer')
  right.classList.toggle('open', name === 'asset')

  if (name === 'ctrl' || name === 'layer') {
    const want = name === 'layer' ? 'layers' : 'controls'
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === want))
    $('paneControls').classList.toggle('hidden', want !== 'controls')
    $('paneLayers').classList.toggle('hidden', want !== 'layers')
  }
  const scrim = $('sheetScrim')
  if (scrim) scrim.hidden = !name
  document.querySelectorAll('.mtab').forEach(b => b.classList.toggle('active', b.dataset.sheet === name))
}

/** 选完资产收起抽屉，直接看动画 */
function closeSheet() { if (sheetOpen) toggleSheet('') }

/* ------------------------------------------------- 全屏（沉浸）模式
   进入后屏幕上只剩舞台：
     · 音量键（真机由 MainActivity 拦截后回调）/ ↑↓ 键：在同一个文件里切换动画
     · ☰ 拉出可收起的文件侧栏：换另一套 L2D，选完自动收起
     · 切换动画不会把缩放打回去 —— 见 refitBounds / currentZoomRatio */
let fsMode = false
let fsFilesOpen = false
let fsDimTimer = 0

function setupFullscreenUI() {
  if (!$('fsBar')) return
  $('fsFiles').onclick = () => toggleFsFiles()
  $('fsExit').onclick = () => setFullscreen(false)
  // 顶部 ◀▶：切换资产（上一个 / 下一个）
  $('fsPrevFile').onclick = () => switchItem(-1)
  $('fsNextFile').onclick = () => switchItem(1)
  // 底部 ◀▶：切换动画（音量键同款）
  $('fsPrevAnim').onclick = () => switchAnimation(-1)
  $('fsNextAnim').onclick = () => switchAnimation(1)
  const btn = $('btnFullscreen')
  if (btn) btn.onclick = () => setFullscreen(!fsMode)
  // 画面右上角的 ⛶ 图标：只作为手机端的全屏入口（桌面仍用顶栏按钮）
  const fab = $('stageFs')
  if (fab && document.body.classList.contains('is-touch')) {
    fab.hidden = false
    fab.onclick = () => setFullscreen(!fsMode)
  }
  // 画面左上角的 ⊞：回平铺页
  const gfab = $('stageGrid')
  if (gfab && document.body.classList.contains('is-touch')) {
    gfab.hidden = false
    gfab.onclick = () => setView('grid')
  }
  // 隐藏界面：全屏时只看画面
  const hide = $('fsHide')
  if (hide) hide.onclick = () => setCleanUI(!cleanUI)

  // 蒙版：抽屉状态下点空白收起
  $('sheetScrim').addEventListener('click', () => { if (fsMode) toggleFsFiles(false) })
  $('stageInner').addEventListener('pointerdown', () => { wakeFsBar(); revealCleanUI() })

  // 双击定点放大（全屏里最常用，播放页也顺手支持）
  setupDoubleTapZoom()

  // 桌面浏览器按 ESC / F11 退出真·全屏时，同步收起沉浸布局
  document.addEventListener('fullscreenchange', () => {
    if (fsMode && !document.fullscreenElement && !NATIVE) setFullscreen(false)
  })
}

function setFullscreen(on) {
  on = !!on
  if (on === fsMode) return
  fsMode = on
  document.body.classList.toggle('is-immersive', on)
  $('fsBar').hidden = !on
  const animBar = $('fsAnimBar')
  if (animBar) {
    animBar.hidden = !on
    animBar.classList.remove('dim')
  }
  if (on) {
    closeSheet()
    updateFsLabels()
    wakeFsBar()
    toast('◀▶ 切资产 · 音量键切动画 · ☰ 换文件 · ✕ 退出')
    try { window.BD2Native.setFullscreen(true) } catch { /* 桌面版没有这个口 */ }
    if (!NATIVE && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      try { document.documentElement.requestFullscreen().catch(() => {}) } catch { /* ignore */ }
    }
  } else {
    toggleFsFiles(false)
    $('fsBar').classList.remove('dim')
    clearTimeout(fsDimTimer)
    if (cleanUI) setCleanUI(false)      // 退出全屏时把「隐藏界面」一起复位
    try { window.BD2Native.setFullscreen(false) } catch { /* ignore */ }
    if (!NATIVE && document.fullscreenElement && document.exitFullscreen) {
      try { document.exitFullscreen().catch(() => {}) } catch { /* ignore */ }
    }
  }
  // 舞台尺寸变了：等布局落定后按新视口重算，并保持用户当前的缩放比例
  requestAnimationFrame(() => requestAnimationFrame(onStageResize))
}

/** 全屏下的文件侧栏（右侧滑出） */
function toggleFsFiles(force) {
  const want = typeof force === 'boolean' ? force : !fsFilesOpen
  fsFilesOpen = want
  const right = document.querySelector('.side-right')
  if (right) right.classList.toggle('fs-open', want)
  const scrim = $('sheetScrim')
  if (scrim) scrim.hidden = !(want || sheetOpen)
  // 文件面板开着时收起底部动画条，别盖住列表
  const animBar = $('fsAnimBar')
  if (animBar && fsMode) animBar.hidden = want
  if (want) { refreshLists(); wakeFsBar() }
}

/** 音量上键的实际方向：+1 = 下一个（默认），-1 = 上一个（设置里可换） */
function volDirMul() { return S.volDir === 'prev' ? -1 : 1 }

/** 设置变化后同步全屏条上的提示文案 */
function updateVolumeKeyHints() {
  const prev = $('fsPrevAnim'), next = $('fsNextAnim')
  if (prev) prev.title = volDirMul() === -1 ? '音量+：上一个动画' : '音量−：上一个动画'
  if (next) next.title = volDirMul() === -1 ? '音量−：下一个动画' : '音量+：下一个动画'
}

/** dir: +1 下一个动画，-1 上一个；到头循环。
 *  调用方：播放页画面两侧箭头、全屏底部 ◀▶、键盘 ↑↓ 与 [ ]、真机音量键。 */
function switchAnimation(dir) {
  if (!S.animations.length) return
  const cur = currentAnimation()?.name
  let i = S.animations.indexOf(cur)
  i = i < 0 ? 0 : (i + dir + S.animations.length) % S.animations.length
  const name = S.animations[i]
  if (!name) return
  playAnimation(name)
  toast(`${name}　${i + 1}/${S.animations.length}`)
}

/** 全局轻提示（保存顺序 / 删除资产 / 切资产 / 缩放倍数都走它）。
 *  原先叫 showFsToast、还包了一层同义的 notice()，名字把作用域说小了 ——
 *  它其实在全屏和平铺页都在用，所以收敛成这一个名字。 */
function toast(text) {
  const t = $('toast')
  if (!t) return
  t.textContent = text
  t.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { t.hidden = true }, 1400)
}

function updateFsLabels() {
  const file = $('fsFile')
  const anim = $('fsAnim')
  if (!file || !anim) return
  file.textContent = S.current?.folder || '未载入'
  const a = currentAnimation()?.name
  const i = a ? S.animations.indexOf(a) : -1
  anim.textContent = a ? `${a}　${i + 1}/${S.animations.length}` : '—'
}

/** 顶部条/底部条静置几秒一起淡出，点一下画面回来 */
function wakeFsBar() {
  const bar = $('fsBar')
  const animBar = $('fsAnimBar')
  if (!bar) return
  bar.classList.remove('dim')
  if (animBar) animBar.classList.remove('dim')
  clearTimeout(fsDimTimer)
  fsDimTimer = setTimeout(() => {
    if (!fsMode) return
    bar.classList.add('dim')
    if (animBar) animBar.classList.add('dim')
  }, 4000)
}

/* ------------------------------------------------- 全屏：隐藏界面（只看画面） */

let cleanUI = false
let cleanRevealTimer = 0

function setCleanUI(on) {
  cleanUI = !!on
  document.body.classList.toggle('is-cleanui', cleanUI)
  if (!cleanUI) {
    document.body.classList.remove('fs-reveal')
    clearTimeout(cleanRevealTimer)
  }
  const btn = $('fsHide')
  if (btn) btn.title = cleanUI ? '显示界面' : '隐藏界面（只看画面）'
  toast(cleanUI ? '已隐藏界面 · 点画面可临时唤出' : '界面已恢复')
  if (!cleanUI) wakeFsBar()
}

/** 隐藏界面状态下点画面：把操作条临时唤出来 4 秒 */
function revealCleanUI() {
  if (!cleanUI) return
  document.body.classList.add('fs-reveal')
  clearTimeout(cleanRevealTimer)
  cleanRevealTimer = setTimeout(() => document.body.classList.remove('fs-reveal'), 4000)
}

/* ------------------------------------------------- 全屏：双击定点放大
   双击哪里就以哪里为中心逐档放大（连按会一直放大，到顶档再双击才还原）。
   锚点用归一化坐标算：要让屏幕点 P 下面的世界坐标在缩放前后保持不动。 */

let lastTap = { t: 0, x: 0, y: 0 }
let zoomAnim = 0

function setupDoubleTapZoom() {
  const host = $('stageInner')
  if (!host) return
  host.addEventListener('pointerdown', e => {
    if (!e.isPrimary || !S.player || !S.camera) return
    const now = performance.now()
    const near = Math.abs(e.clientX - lastTap.x) < 30 && Math.abs(e.clientY - lastTap.y) < 30
    if (now - lastTap.t < 340 && near) {
      lastTap.t = 0
      doubleTapZoom(e.clientX, e.clientY)
      e.preventDefault()
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY }
    }
  }, { passive: false })
}

/** 把相机 viewport 同步成渲染器的真实尺寸。全屏切换/转屏后 S.defaultZoom 可能还是
 *  旧视口算出来的，双击缩放前必须先按当前画布重算，否则「还原」会落空到偏小的一档。 */
function syncCameraViewport() {
  const p = S.player, cam = S.camera
  if (!p || !cam) return
  try { p.sceneRenderer.resize(1) } catch { /* ignore */ }
  const rc = p.sceneRenderer.camera
  cam.viewportWidth = rc.viewportWidth
  cam.viewportHeight = rc.viewportHeight
}

/** 双击放大的档位：每次双击往上走一档，到顶档再双击才还原。
 *  不能写成「放大 / 还原」的二值开关 —— 那样第二下就弹回去了。
 *  顶档取 12.4 而不是 2.6³≈17.7：currentZoomRatio() 把比值夹在 [0.08, 4]，
 *  也就是最多只能读出 12.5×；档位一旦超过它就会「量不出来」，导致永远判定不到顶、
 *  第四下也还原不了（2026-09-25 实测踩到）。 */
const ZOOM_LADDER = [2.6, 6.8, 12.4]
const ZOOM_TOP = ZOOM_LADDER[ZOOM_LADDER.length - 1]

/** 双击：以点击处为锚点，沿 ZOOM_LADDER 逐档放大；已经是顶档才还原到铺满。
 *  注意相机的方向：cam.zoom 越小画面越放大（currentZoomRatio = cam.zoom / fit），
 *  所以「放大」是除以倍数，不是乘。 */
function doubleTapZoom(clientX, clientY) {
  const p = S.player, cam = S.camera
  if (!p || !cam || !S.bounds) return
  syncCameraViewport()
  const ratio = currentZoomRatio()
  const fit = defaultZoomFor(Math.max(cam.viewportWidth, 1), Math.max(cam.viewportHeight, 1))
  const factor = ratio > 0 ? 1 / ratio : 1     // 相对「铺满」当前放大了几倍

  // 到顶（或已经超出可读范围）→ 还原
  if (factor >= ZOOM_TOP * 0.9) { fitToWindow(); toast('已还原'); return }

  // 留 15% 余量：手抖掉一点缩放不该让档位判定来回跳
  const step = ZOOM_LADDER.find(s => s > factor * 1.15) || ZOOM_TOP

  // 锚点：点击处对应的世界坐标（screenToWorld 里算过同样的归一化坐标）
  const world = screenToWorld(clientX, clientY)
  if (!world) { fitToWindow(); return }
  const target = fit / step
  const vw = Math.max(cam.viewportWidth, 1), vh = Math.max(cam.viewportHeight, 1)
  animateCamera({
    x: world.x - world.nx * target * vw / 2,
    y: world.y - world.ny * target * vh / 2,
    z: target,
  }, world)
  toast(`放大 ×${step < 10 ? step.toFixed(1) : Math.round(step)}`)
}

/** 相机从当前位置缓动到目标（约 200ms），到位后刷新调试信息 */
function animateCamera(to, anchor) {
  const p = S.player, cam = S.camera
  if (!p || !cam) return
  const from = { x: cam.position.x, y: cam.position.y, z: cam.zoom }
  const t0 = performance.now()
  const dur = 200
  cancelAnimationFrame(zoomAnim)
  const step = () => {
    const t = clamp((performance.now() - t0) / dur, 0, 1)
    const e = 1 - Math.pow(1 - t, 3)          // easeOutCubic
    // 夹取范围按「起点↔目标」取，不用全局记录值：视口刚变过时记录值可能偏大，
    // 会把合法的放大目标裁掉。
    const zmin = Math.min(from.z, to.z) * 0.5
    const zmax = Math.max(from.z, to.z) * 2
    cam.zoom = clamp(from.z + (to.z - from.z) * e, zmin, zmax)
    cam.position.x = from.x + (to.x - from.x) * e
    cam.position.y = from.y + (to.y - from.y) * e
    cam.update()
    p.drawFrame(false)
    if (t < 1) zoomAnim = requestAnimationFrame(step)
    else debugDump()
  }
  zoomAnim = requestAnimationFrame(step)
}

/**
 * 切上一个 / 下一个资产 —— **全项目唯一的资产导航入口**。
 * 调用方：播放页底部 ◀◀/▶▶、全屏顶部 ◀▶、拖到底后的自动续播。
 * 之前只有全屏那条路在用它，别处各写一遍（画面上就没有可点的入口了）。
 *
 * 顺序口径和左侧资产列表、平铺页完全一致（都走 filteredItems → orderedList），
 * 所以「列表里下一个」和「点箭头下一个」永远指同一个资产。到头循环。
 *
 * @param {number} dir +1 下一个，-1 上一个
 */
function switchItem(dir) {
  const list = filteredItems()
  if (!list.length) return
  const cur = S.current ? itemKey(S.current) : null
  let i = list.findIndex(x => itemKey(x) === cur)
  i = i < 0 ? 0 : (i + dir + list.length) % list.length
  const item = list[i]
  if (!item || itemKey(item) === cur) return
  selectItem(item)
  toast(`${item.folder}　${i + 1}/${list.length}`)
  syncStageNav()
}

/** 播放页左右箭头的显隐：**当前资产有没有第二个动画可切**。
 *  （它俩切的是动画，所以这里的条件必须看 S.animations ——
 *    早先跟着「可见资产数」走，是照着「箭头切资产」写的，对调后就成了错的：
 *    单动画但多资产的目录会亮出一对点了没反应的箭头。）
 *  只在动画列表变化时调用：onLoaded()（载入完成）、resetMeta()（清空换资产）。
 *  有没有动画是**数据**条件，所以类名挂 body、显不显由 CSS 定（ARCHITECTURE.md R1）。 */
function syncStageNav() {
  document.body.classList.toggle('stage-nav-avail', S.animations.length > 1)
}

async function loadConfig() {
  if (NATIVE) {
    try {
      const res = await fetch('/api/config')
      if (res.ok) S.config = await res.json()
      else S.config = { roots: [], host: '', port: 0, maxDepth: 5 }
    } catch { S.config = { roots: [], host: '', port: 0, maxDepth: 5 } }
    S.config.roots = await nativeAsk('roots', () => window.BD2Native.requestRoots(), 15000)
  } else {
    try {
      const res = await fetch('/api/config')
      S.config = await res.json()
    } catch (err) {
      showError('无法连接本地服务：' + err.message)
      return
    }
  }
  if (NATIVE) {
    const dir = nativeDefaultPath()
    $('envInfo').textContent = dir
      ? `文件目录：${dir}`
      : `APK 模式 · 从手机存储读取 · 扫描深度 ${S.config.maxDepth || 6}`
  } else {
    $('envInfo').textContent =
      `本地服务 ${S.config.host}:${S.config.port} · 扫描深度 ${S.config.maxDepth}`
  }
  renderRootOptions()
  renderStorageBar()
}

function nativeDefaultPath() {
  try { return window.BD2Native.defaultPath ? window.BD2Native.defaultPath() : '' }
  catch { return '' }
}

function renderRootOptions() {
  const sel = $('rootSelect')
  sel.innerHTML = ''
  for (const r of S.config.roots) {
    const opt = document.createElement('option')
    opt.value = r.id
    opt.textContent = `${r.label}${r.exists === false ? '（不存在）' : ''}`
    sel.appendChild(opt)
  }
  if (!S.config.roots.length) {
    const opt = document.createElement('option')
    opt.textContent = NATIVE ? '（目录还没建好）' : '（未配置目录）'
    sel.appendChild(opt)
  }
  if (S.rootId == null) {
    // APK 里默认读外部存储根目录（文件管理器放得进去），拿不到才退回 App 专属目录
    const auto = S.config.roots.find(r => r.id === '__public__')
      || S.config.roots.find(r => r.id === '__default__')
    S.rootId = (auto || S.config.roots[0])?.id || null
  }
  sel.value = S.rootId || ''
}

/** 只刷新目录下拉，不打断当前播放 */
async function refreshRoots() {
  if (!NATIVE) return
  try {
    S.config.roots = await nativeAsk('roots', () => window.BD2Native.requestRoots(), 15000)
    renderRootOptions()
  } catch { /* 保持原样 */ }
}

/**
 * 从系统权限设置页回来时用：外部目录可能刚刚可用，
 * 那就把默认目录切到外部并重新扫一遍，省得用户自己点。
 */
async function refreshRootsAndRescan() {
  if (!NATIVE) return
  const before = S.rootId
  await refreshRoots()
  renderStorageBar()
  const auto = S.config.roots.find(r => r.id === '__public__')
    || S.config.roots.find(r => r.id === '__default__')
  const want = (auto || S.config.roots[0])?.id || null
  if (want && want !== before) {
    S.rootId = want
    const sel = $('rootSelect')
    if (sel) sel.value = want
    await scan(true)
  }
}

function nativeStorageStatus() {
  try {
    return JSON.parse(window.BD2Native.storageStatus ? window.BD2Native.storageStatus() : '{}')
  } catch { return {} }
}

/**
 * APK 模式的目录/权限信息。手机端不再在首页占一整条：
 * 内容整体搬进「设置 → 文件目录」，首页只留舞台。
 * 桌面原生模式（基本用不到）仍走顶部状态条。
 */
function renderStorageBar() {
  const bar = $('storageBar')
  if (!bar) return
  if (!NATIVE) { bar.hidden = true; return }
  const st = nativeStorageStatus()
  if (document.body.classList.contains('is-touch')) {
    renderStorageSettings(st)
    bar.hidden = true
    return
  }
  bar.hidden = false
  bar.innerHTML = ''

  const path = document.createElement('span')
  path.className = 'sb-path'
  path.textContent = st.defaultDir
    ? `读取目录：${st.defaultDir}`
    : '读取目录：创建失败'
  bar.appendChild(path)

  const btn = (text, title, fn) => {
    const b = document.createElement('button')
    b.className = 'btn tiny'
    b.textContent = text
    b.title = title
    b.onclick = fn
    bar.appendChild(b)
  }

  btn('复制路径', '复制目录路径，可粘贴到文件管理器', () => {
    try { window.BD2Native.copyText(st.defaultDir || '') } catch { /* ignore */ }
  })
  btn('授权文件夹', '用系统文件夹选择器授权一个目录，直接读取不用拷贝文件', () => {
    try { window.BD2Native.pickFolder() } catch (e) { showError('打不开文件夹选择器：' + e.message) }
  })

  const tip = document.createElement('div')
  tip.className = 'sb-tip'
  if (st.defaultIsPublic) {
    tip.textContent =
      `用手机自带的「文件管理」把 .atlas + .json/.skel + .png 拷进这个目录（每套一个子文件夹），` +
      `回来点顶栏「重新扫描」就能看到；懒得找目录就用「导入文件」直接选文件。`
    bar.appendChild(tip)
  } else if (!st.allFilesAccess) {
    tip.textContent =
      `外部目录 ${st.publicPath} 用不了：Android ${st.sdk || 11}+ 的分区存储不允许 App 在手机存储根目录建目录或读文件，` +
      `现在读的是 App 专属目录（文件管理器进不去）。想在手机存储里直接放文件就点「去开启」` +
      `（系统设置里叫「所有文件访问权限」）；不想开权限，用顶栏「导入文件」把文件拷进来。`
    bar.appendChild(tip)
    btn('去开启', '跳到系统设置页，开启「所有文件访问权限」', () => {
      try { window.BD2Native.requestAllFilesAccess() } catch { /* ignore */ }
      setTimeout(() => { refreshRootsAndRescan() }, 8000)   // 从设置页回来后再刷一次
    })
  } else {
    tip.textContent =
      `已开启全部文件访问，但 ${st.publicPath} 仍不可用：${st.publicReason || '未知原因'}。` +
      `可用顶栏「导入文件」拷进当前目录。`
    bar.appendChild(tip)
  }
}

/** 手机端：目录/权限信息渲染进「设置 → 文件目录」，含路径、操作按钮和说明 */
function renderStorageSettings(st) {
  const box = $('setStorage')
  if (!box) return
  box.hidden = false
  const path = $('setStoragePath')
  if (path) path.textContent = st.defaultDir
    ? `读取目录：${st.defaultDir}`
    : '读取目录：创建失败'
  const tip = $('setStorageTip')
  const actions = $('setStorageActions')
  if (actions) actions.innerHTML = ''

  const btn = (text, title, fn) => {
    const b = document.createElement('button')
    b.className = 'btn tiny'
    b.textContent = text
    b.title = title
    b.onclick = fn
    actions.appendChild(b)
  }

  btn('复制路径', '复制目录路径，可粘贴到文件管理器', () => {
    try { window.BD2Native.copyText(st.defaultDir || '') } catch { /* ignore */ }
  })
  btn('授权文件夹', '用系统文件夹选择器授权一个目录，直接读取不用拷贝文件', () => {
    try { window.BD2Native.pickFolder() } catch (e) { showError('打不开文件夹选择器：' + e.message) }
  })

  let tipText = ''
  if (st.defaultIsPublic) {
    tipText =
      `用手机自带的「文件管理」把 .atlas + .json/.skel + .png 拷进这个目录（每套一个子文件夹），` +
      `回来点顶栏「重新扫描」就能看到；懒得找目录就用「导入文件」直接选文件。`
  } else if (!st.allFilesAccess) {
    tipText =
      `外部目录 ${st.publicPath} 用不了：Android ${st.sdk || 11}+ 的分区存储不允许 App 在手机存储根目录建目录或读文件，` +
      `现在读的是 App 专属目录（文件管理器进不去）。想在手机存储里直接放文件就点「去开启」` +
      `（系统设置里叫「所有文件访问权限」）；不想开权限，用顶栏「导入文件」把文件拷进来。`
    btn('去开启', '跳到系统设置页，开启「所有文件访问权限」', () => {
      try { window.BD2Native.requestAllFilesAccess() } catch { /* ignore */ }
      setTimeout(() => { refreshRootsAndRescan() }, 8000)   // 从设置页回来后再刷一次
    })
  } else {
    tipText =
      `已开启全部文件访问，但 ${st.publicPath} 仍不可用：${st.publicReason || '未知原因'}。` +
      `可用顶栏「导入文件」拷进当前目录。`
  }
  if (tip) tip.textContent = tipText
}

async function scan(force) {
  if (!S.rootId) {
    S.items = []
    refreshLists()
    return
  }
  setBusy(true, '扫描中…')
  try {
    let data
    if (NATIVE) {
      const meta = await nativeAsk('scan', () => window.BD2Native.requestScan(S.rootId, !!force), 300000)
      const items = []
      const PAGE = 40
      for (let from = 0; from < (meta.itemCount || 0); from += PAGE) {
        const chunk = JSON.parse(window.BD2Native.scanPage(meta.rootId, from, PAGE) || '[]')
        for (let i = 0; i < chunk.length; i++) items.push(chunk[i])
      }
      data = Object.assign({}, meta, { items })
      if (meta.truncated) showError('目录太大，扫描已截断：只覆盖了前 4000 个子目录。建议直接选到放 Spine 文件的那一层。')
    } else {
      const res = await fetch(`/api/scan?root=${encodeURIComponent(S.rootId)}${force ? '&refresh=1' : ''}`)
      data = await res.json()
      if (!res.ok) throw new Error(data.error || '扫描失败')
    }
    S.items = data.items || []
    if (!data.exists) showError(`目录不存在：${data.root.path}`)
    $('assetCount').textContent = `${data.playableCount}/${data.itemCount} 可播放` +
      (data.scanMs ? ` · ${data.scanMs}ms` : '')
  } catch (err) {
    showError('扫描失败：' + err.message)
  } finally {
    setBusy(false)
  }
  // 平铺页要用：先把 IndexedDB 里上次生成的缩略图读进内存，
  // 这样卡片一渲染就直接有图，不用每次启动都重新渲一遍。
  await loadThumbCache()
  // 播放顺序的偏好也按目录记着：名称/日期排序要跟着目录一起切
  loadSort()
  applySortUI()
  refreshLists()
  // 深链 ?item=<relAtlas> 第一次进入时直接开播放页；否则主界面就是平铺页。
  // 之后手动「重新扫描」不再抢视图，用户停在哪一页就留在哪一页。
  // （boot() 已经按 initialView() 摆好了首屏，这里只是把深链那条路补完。）
  const wanted = bootedOnce ? null : deepLinkItem()
  bootedOnce = true
  const target = wanted ? allItems().find(i => i.id === wanted || i.relAtlas === wanted || i.base === wanted) : null
  if (target) {
    setView('player')
    selectItem(target)
  } else if (viewMode !== 'player' || !S.current) {
    setView('grid')
  }
}

function allItems() {
  return [...S.customItems, ...S.items]
}

/* ------------------------------------------------------------------ 资产顺序
   三种来源，按目录分别记在 localStorage：
     · manual —— 用户在平铺页拖动卡片排出来的顺序（bd2.order.<rootId> 存键序列）
     · name   —— 按目录名 / 文件名（自然序，illust_special2 排在 illust_special10 前面）
     · date   —— 按 atlas 文件改动时间
   orderedList() 是唯一入口：平铺页、左侧资产列表、播放页 ◀▶ 都走它，
   所以「排序」改的是真正的播放顺序，而不是只把画面重排一下。 */

const orderKeyFor = rid => `bd2.order.${rid || 'default'}`
const sortKeyFor = rid => `bd2.sort.${rid || 'default'}`

const SORT_MODES = ['manual', 'name', 'date']
/** 各排序方式的默认方向：名称 A→Z，日期新的在前 */
const SORT_DEFAULT_DIR = { manual: 1, name: 1, date: -1 }
const SORT_LABEL = { manual: '手动', name: '名称', date: '日期' }

let sortState = { mode: 'manual', dir: SORT_DEFAULT_DIR.manual }

/** 自然序比较器：localeCompare 支持 numeric，避免 2 排在 10 后面 */
const NAME_COLLATOR = (() => {
  try { return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' }) }
  catch { return null }
})()

function cmpText(a, b) {
  if (NAME_COLLATOR) return NAME_COLLATOR.compare(a, b)
  return a < b ? -1 : a > b ? 1 : 0
}

/** 名称序：先比卡片上显示的名字（目录名），再比文件名，最后用 key 兜底保证稳定 */
function cmpName(a, b) {
  return cmpText(a.folder || '', b.folder || '') ||
    cmpText(a.base || '', b.base || '') ||
    cmpText(itemKey(a), itemKey(b))
}

/** 日期序：mtime 取不到（SAF 目录 / 上传的资源）当 0，排在「最旧」那头 */
function cmpDate(a, b) {
  const am = a.mtime || 0, bm = b.mtime || 0
  if (am !== bm) return am - bm
  return cmpName(a, b)
}

function loadSort() {
  try {
    const raw = JSON.parse(localStorage.getItem(sortKeyFor(S.rootId)) || 'null')
    if (raw && SORT_MODES.includes(raw.mode)) {
      sortState = { mode: raw.mode, dir: raw.dir === -1 ? -1 : 1 }
      return sortState
    }
  } catch { /* 坏数据当成没存过 */ }
  sortState = { mode: 'manual', dir: SORT_DEFAULT_DIR.manual }
  return sortState
}

function saveSort() {
  try { localStorage.setItem(sortKeyFor(S.rootId), JSON.stringify(sortState)) } catch { /* 存不下就算了 */ }
}

function loadOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(orderKeyFor(S.rootId)) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}

function saveOrder(keys) {
  try { localStorage.setItem(orderKeyFor(S.rootId), JSON.stringify(keys)) } catch { /* 存不下就算了 */ }
}

/** 手动顺序：有记录的按记录排，没记录的排后面（sort 在 V8 里稳定，保持扫描原序） */
function applyManualOrder(items) {
  const order = loadOrder()
  if (!order.length) return items.slice()
  const idx = new Map(order.map((k, i) => [k, i]))
  const rank = it => (idx.has(itemKey(it)) ? idx.get(itemKey(it)) : 1e9)
  return items.slice().sort((a, b) => rank(a) - rank(b))
}

/**
 * 按当前排序方式排（总是返回新数组）。
 * 名称/日期把方向乘进比较器，而不是排完再整体反转 ——
 * 整体反转会把「同值时按名称兜底」也一起翻过去，同一时刻的文件顺序会莫名其妙倒过来。
 * 手动顺序没有 key 可比，倒序就是整个数组反过来。
 */
function orderedList(items) {
  const st = sortState
  const sign = st.dir === -1 ? -1 : 1
  if (st.mode === 'name') return items.slice().sort((a, b) => sign * cmpName(a, b))
  if (st.mode === 'date') return items.slice().sort((a, b) => sign * cmpDate(a, b))
  const base = applyManualOrder(items)
  return sign === -1 ? base.reverse() : base
}

/**
 * 把「当前排序方式排出来的顺序」固化成手动顺序。
 * 从名称/日期切到手动、或在排序状态下开始拖动时调用 —— 这样切过去画面不跳，
 * 用户接着微调的就是他刚看到的那份顺序。
 */
function seedManualOrderFromSort() {
  const keys = orderedList(allItems()).map(itemKey)
  saveOrder(keys)
  return keys
}

function setSortMode(mode, opts) {
  if (!SORT_MODES.includes(mode)) return
  if (mode === sortState.mode && !opts?.dir) return
  // 从排序模式切回手动：先把当前看到的顺序固化，否则会突然跳回很久以前那份手动顺序
  if (mode === 'manual' && sortState.mode !== 'manual') seedManualOrderFromSort()
  sortState = { mode, dir: opts?.dir ?? SORT_DEFAULT_DIR[mode] }
  saveSort()
  applySortUI()
  refreshLists()
}

/**
 * 升降序。三种模式都靠 sortState.dir 表达（orderedList 统一在最后反转），
 * 所以这里只翻一个标志位，不动存下来的数组 —— 两边都翻会互相抵消。
 *  · 名称 / 日期 —— 切换升/降序（会记住）
 *  · 手动 —— 等于「把当前播放顺序倒过来」播放
 */
function toggleSortDir() {
  const dir = sortState.dir === 1 ? -1 : 1
  sortState = { mode: sortState.mode, dir }
  saveSort()
  applySortUI()
  refreshLists()
  const what = sortState.mode === 'manual'
    ? (dir === 1 ? '正序' : '倒序')
    : sortState.mode === 'date'
      ? (dir === -1 ? '新的在前' : '旧的在前')
      : (dir === 1 ? '升序' : '降序')
  toast(`${SORT_LABEL[sortState.mode]} · ${what}`)
}

/** 把排序状态同步到界面：滑块位置、升降序图标、提示文案 */
function applySortUI() {
  const st = sortState
  const box = $('galSort')
  if (box) {
    box.style.setProperty('--i', String(Math.max(0, SORT_MODES.indexOf(st.mode))))
    for (const b of box.querySelectorAll('.gs-btn')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === st.mode))
    }
  }
  const dir = $('galSortDir')
  if (dir) {
    dir.textContent = st.dir === 1 ? '↑' : '↓'
    dir.title = st.mode === 'manual'
      ? '反转当前播放顺序'
      : (st.dir === 1 ? '当前升序，点一下改降序' : '当前降序，点一下改升序')
    dir.setAttribute('aria-label', dir.title)
  }
  const hint = $('galHint')
  if (hint) {
    if (st.mode === 'manual') {
      hint.textContent = document.body.classList.contains('is-touch')
        ? '长按卡片拖动 = 调整播放顺序 · 按住不动弹删除菜单'
        : '拖动卡片调整播放顺序（按住左上角 ⠿ 立刻拖）· 右键卡片可删除'
    } else {
      const arrow = st.mode === 'date'
        ? (st.dir === -1 ? '新的在前' : '旧的在前')
        : (st.dir === 1 ? '升序' : '降序')
      hint.textContent = `按${SORT_LABEL[st.mode]}（${arrow}）· 拖动卡片会转为手动顺序`
    }
  }
}

/** 扫描出来的资产唯一标识：上传的自定义项有 key，扫描出来的只有 id（= relAtlas） */
function itemKey(i) { return i.key || i.id || i.relAtlas || '' }

/* 过滤条件收在状态里，不再每次去读 DOM。
   「哪些资产可见」是个纯数据问题 —— 原来 filteredItems() 直接读 #assetFilter.value /
   #chkOnlyPlayable.checked，等于把「排序 + 过滤」这一层和左侧抽屉的控件绑死：
   没法单独推理或测试，同一个条件还出现了两个事实来源。
   约定：控件只是**入口**，filters 才是事实来源 —— 控件一变调 syncFilters()，其余人只读 filters。 */
const filters = { q: '', onlyOk: true }

/** 把左侧抽屉那两个控件同步进 filters（只在输入事件里调用） */
function syncFilters() {
  filters.q = $('assetFilter').value.trim().toLowerCase()
  filters.onlyOk = $('chkOnlyPlayable').checked
}

/** 当前过滤条件下、按用户排序排好的资产 —— 全项目唯一的「可见资产」口径 */
function filteredItems() {
  const { q, onlyOk } = filters
  return orderedList(allItems().filter(i =>
    (!onlyOk || i.ok) &&
    (!q || `${i.folder} ${i.base} ${i.group}`.toLowerCase().includes(q))))
}

/**
 * 全项目唯一的「资产视图已变，重画一遍」入口。
 *
 * 一次刷新 = 控件 → 状态 → 两个渲染出口：
 *   · syncFilters()      把左侧抽屉那两个控件读进 filters（控件是入口，filters 是事实来源）
 *   · renderAssetList()  左侧资产列表
 *   · renderGallery()    平铺页（只在当前是平铺页时）
 *
 * 之前这几行散落在 8 处（排序、删除、扫描、导入、清空自定义…），
 * 每次都要靠人记得「列表和平铺页要一起刷」——漏一个就留下
 * 「数据变了、界面还是旧的」这种脏状态。
 * 现在只此一处；`commitCardOrder()` 是唯一的例外（原因见那里）。
 *
 * 注意：播放页左右箭头的显隐**不在这里**。它跟的是「动画列表变了」，
 * 所以由 onLoaded()/resetMeta() 调 syncStageNav() —— 两个条件互不相干。
 */
function refreshLists() {
  syncFilters()
  renderAssetList()
  if (viewMode === 'grid') renderGallery()
}

function renderAssetList() {
  const list = $('assetList')
  list.innerHTML = ''

  // 手动顺序下列表按「分组」成段，好找；
  // 但按名称/日期排序时分组会被打散 —— 每张卡片前面都挂一个组名反而更乱，
  // 所以那种情况下列表拍平，改把组名放进副标题里，信息不丢。
  const grouped = sortState.mode === 'manual'

  let group = null
  let shown = 0
  for (const item of filteredItems()) {
    if (grouped && item.group !== group) {
      group = item.group
      const t = document.createElement('div')
      t.className = 'asset-group-title'
      t.textContent = group
      list.appendChild(t)
    }
    const el = document.createElement('div')
    el.className = 'asset-item' + (item.ok ? '' : ' bad') +
      (S.current && itemKey(S.current) === itemKey(item) ? ' active' : '')
    el.innerHTML = `<div class="ai-name"></div><div class="ai-sub"></div>` +
      (item.problems?.length ? `<div class="ai-warn"></div>` : '')
    el.querySelector('.ai-name').textContent = item.folder
    el.querySelector('.ai-sub').textContent =
      (grouped ? '' : (item.group ? item.group + ' · ' : '')) +
      item.base + (item.skeletonKind ? `.${item.skeletonKind}` : '') +
      ` · ${item.images.length} 图`
    if (item.problems?.length) el.querySelector('.ai-warn').textContent = '⚠ ' + item.problems.join('；')
    el.onclick = () => { openItem(item); closeSheet(); if (fsMode) toggleFsFiles(false) }
    list.appendChild(el)
    shown++
  }

  if (!shown) {
    const empty = document.createElement('div')
    empty.className = 'asset-group-title'
    empty.textContent = S.rootId ? '没有匹配的资产' : '请先添加一个目录'
    list.appendChild(empty)
  }
}

/* ------------------------------------------------------------ 平铺浏览（主界面）
   主界面不直接播动画，而是一张张卡片平铺展示：
     · 点卡片 → 进播放页；卡片右上角 ⛶ → 直接全屏
     · 拖卡片左上角 ⠿ → 调整播放顺序（存 localStorage，影响全屏 ◀▶ 的顺序）
     · 缩略图：卡片进入视野时用它自己的一个离屏 SpinePlayer 渲一帧，转 JPEG 存进
       IndexedDB；缓存 key 带 mtime，重新读取文件夹后文件变了会自动重生成。
   ------------------------------------------------------------------------ */

let viewMode = 'grid'
let bootedOnce = false

const thumbCache = new Map()      // cacheKey -> dataURL
const thumbFailed = new Set()     // 已确认生成不了的 cacheKey（IndexedDB 里存空串），启动不再重试
const thumbAsked = new Set()      // 正在生成 / 已尝试过的 cacheKey，避免重复排
let thumbRunning = false
let thumbDone = 0

/** 缩略图缓存 key：同一套资产文件换了（mtime 变）就换 key，等于自动失效 */
function thumbKey(item) {
  return `${S.rootId || ''}|${itemKey(item)}|${item.mtime || 0}|${item.images.length}`
}

/* IndexedDB：缩略图比 localStorage 大得多，放这儿不会撑爆 5MB 配额 */
let idbPromise = null
function idb() {
  if (idbPromise) return idbPromise
  idbPromise = new Promise((resolve, reject) => {
    try {
      const rq = indexedDB.open('bd2viewer', 1)
      rq.onupgradeneeded = () => { rq.result.createObjectStore('thumbs') }
      rq.onsuccess = () => resolve(rq.result)
      rq.onerror = () => reject(rq.error)
    } catch (e) { reject(e) }
  }).catch(() => null)
  return idbPromise
}

async function idbGet(key) {
  const db = await idb()
  if (!db) return null
  return new Promise(resolve => {
    try {
      const rq = db.transaction('thumbs').objectStore('thumbs').get(key)
      rq.onsuccess = () => resolve(rq.result || null)
      rq.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

async function idbPut(key, value) {
  const db = await idb()
  if (!db) return
  try { db.transaction('thumbs', 'readwrite').objectStore('thumbs').put(value, key) } catch { /* ignore */ }
}

/** 资产被删掉后把它的缩略图也清掉，不然缓存会一直攒着没用的图 */
async function idbDel(key) {
  const db = await idb()
  if (!db) return
  try { db.transaction('thumbs', 'readwrite').objectStore('thumbs').delete(key) } catch { /* ignore */ }
}

async function idbClearThumbs() {
  const db = await idb()
  if (!db) return
  try { db.transaction('thumbs', 'readwrite').objectStore('thumbs').clear() } catch { /* ignore */ }
}

let thumbLoaded = false
let thumbLoadPromise = null

/** 启动后把 IndexedDB 里已生成的缩略图一次性读进内存：
 *  卡片直接显示上次的结果，不用每个都重新开离屏播放器渲一遍。
 *  顺手清掉当前目录下已经不存在的资产留下的旧条目（其它目录的保留）。 */
function loadThumbCache() {
  if (thumbLoadPromise) return thumbLoadPromise
  thumbLoadPromise = (async () => {
    const db = await idb()
    if (!db) { thumbLoaded = true; return }
    await new Promise(resolve => {
      let rq
      try { rq = db.transaction('thumbs').objectStore('thumbs').openCursor() } catch { resolve(); return }
      rq.onsuccess = () => {
        const c = rq.result
        if (!c) { resolve(); return }
        if (typeof c.key !== 'string') { c.continue(); return }
        // 空串 = 上次确认生成不了的坏文件，单独记到失败集合里
        if (c.value === '') thumbFailed.add(c.key)
        else if (typeof c.value === 'string') thumbCache.set(c.key, c.value)
        c.continue()
      }
      rq.onerror = () => resolve()
    })
    thumbLoaded = true
    const prefix = `${S.rootId || ''}|`
    const valid = new Set(allItems().map(i => thumbKey(i)))
    const stale = [...thumbCache.keys()].filter(k => k.startsWith(prefix) && !valid.has(k))
    if (stale.length) {
      try {
        const tx = db.transaction('thumbs', 'readwrite')
        const st = tx.objectStore('thumbs')
        for (const k of stale) st.delete(k)
      } catch { /* ignore */ }
      for (const k of stale) thumbCache.delete(k)
    }
  })()
  return thumbLoadPromise
}

const thumbObserver = (typeof IntersectionObserver === 'function')
  ? new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) en.target.__wantThumb = true
    thumbKick()
  }, { rootMargin: '300px' })
  : null

function setView(mode) {
  viewMode = mode === 'player' ? 'player' : 'grid'
  document.body.classList.toggle('view-grid', viewMode === 'grid')
  if (viewMode === 'grid') {
    // 抽屉不能跨视图留在半开状态：平铺页里底部标签栏整条没了，收不回去就卡住
    if (sheetOpen) toggleSheet('')
    renderGallery()
  }
  syncTouchSettingsEntry()
  // 视口尺寸变了：让播放器按新尺寸重排（回到播放页时画面不能歪）
  requestAnimationFrame(() => requestAnimationFrame(onStageResize))
}

/* 触屏模式（APK）下「设置」的两个入口二选一，不能同时都没有：
     · 播放页 —— 底部标签栏里的「设置」（顶栏那颗藏着，避免重复）
     · 平铺页 —— 底部标签栏整条不显示（CSS: body.view-grid .mtabs），
                 于是把顶栏那颗露出来，否则「文件目录」就改不了了 */
function syncTouchSettingsEntry() {
  if (!document.body.classList.contains('is-touch')) return
  const set = $('btnSettings')
  if (set) set.hidden = viewMode !== 'grid'
}

/** 打开某套资产：切到播放页，可选直接全屏 */
function openItem(item, opts) {
  if (!item) return
  setView('player')
  selectItem(item)
  if (opts && opts.fullscreen) setFullscreen(true)
}

/* 上一次返回被哪一层消化了（'none' = 交给宿主退 App）。
   排障用：真机按返回没反应时，一眼能看出是页面吃掉了还是宿主没接住。 */
let lastBackReason = 'none'

/* ------------------------------------------------------- 返回键的分层消化

   一次「返回」该退到哪：从最上面那层往下一层层剥，剥干净了才轮到退 App。
   层次由内到外 ——
     1. 弹出的对话框（设置 / 上传 / 帮助 / 卡片菜单 / 删除确认）
     2. 全屏下的文件侧栏
     3. 底部抽屉（资产 / 操作 / 图层）
     4. 批量选择模式
     5. 全屏（沉浸）
     6. 播放页 → 资产页（平铺）
     7. 已经在最外层

   这才是「播放页和资产页的层级区分」：播放页是资产页的**下一层**，
   在播放页按返回是回资产页，不是退出软件。

   @returns {boolean} true = 这次返回被页面消化了，调用方不要再往下走
*/
function handleBack() {
  const done = why => { lastBackReason = why; return true }
  // 1. 任何对话框先把它的「取消」跑完（删除确认要靠这个 resolve(false)）
  const confirm = $('confirmModal')
  if (confirm && !confirm.hidden) {
    if (typeof confirm.__cancel === 'function') confirm.__cancel()
    else confirm.hidden = true
    return done('confirm')
  }
  for (const id of ['settingsModal', 'uploadModal', 'helpModal', 'cardMenu']) {
    const m = $(id)
    if (m && !m.hidden) { m.hidden = true; return done('modal:' + id) }
  }
  // 2. 全屏里拉出来的文件侧栏
  if (fsMode && fsFilesOpen) { toggleFsFiles(false); return done('fsFiles') }
  // 3. 底部抽屉
  if (sheetOpen) { closeSheet(); return done('sheet:' + sheetOpen) }
  // 4. 批量选择
  if (selectMode) { setSelectMode(false); return done('selectMode') }
  // 5. 全屏
  if (fsMode) { setFullscreen(false); return done('fullscreen') }
  // 6. 播放页回资产页
  if (viewMode === 'player') { setView('grid'); return done('player->grid') }
  lastBackReason = 'none'          // 已在最外层 —— 该退 App 了
  return false
}

/* ---------------------------------------------------------------- 选择与删除

   一张卡片 = 一整套资产（atlas + skeleton + 它引用的贴图）。
   · 扫描出来的资产 —— 磁盘上的真文件，删除走原生 / 服务端接口，**不可恢复**；
   · 上传的资产 —— 只活在当前会话里，直接把对象丢掉。
   两条路都要先过 confirmDelete() 那道「带文件清单」的二次确认。

   长按（触屏）或右键（桌面）卡片 → 操作菜单；也可以点「选择」进批量模式。 */

let selectMode = false
let selectedKeys = new Set()
let menuItem = null

/** 上传的资产有 key；扫描出来的是磁盘文件。 */
function isDiskItem(item) { return !!item && !item.key }

function setSelectMode(on) {
  selectMode = !!on
  if (!selectMode) selectedKeys.clear()
  document.body.classList.toggle('card-select', selectMode)
  if (viewMode === 'grid') renderGallery()
  applySelectUI()
}

function toggleSelectKey(key) {
  if (selectedKeys.has(key)) selectedKeys.delete(key)
  else selectedKeys.add(key)
  for (const c of document.querySelectorAll('#galGrid .card')) {
    if (c.dataset.key === key) c.classList.toggle('sel', selectedKeys.has(key))
  }
  applySelectUI()
}

function applySelectUI() {
  const bar = $('galSelBar')
  const btn = $('galSelect')
  const n = selectedKeys.size
  if (bar) bar.hidden = !selectMode
  if (btn) {
    btn.textContent = selectMode ? '退出选择' : '选择'
    btn.setAttribute('aria-pressed', String(selectMode))
  }
  const cnt = $('galSelCount')
  if (cnt) cnt.textContent = n ? `已选 ${n} 个` : '未选择'
  const del = $('galSelDelete')
  if (del) del.disabled = n === 0
  const all = $('galSelAll')
  if (all) {
    const total = document.querySelectorAll('#galGrid .card').length
    all.checked = total > 0 && n >= total
    all.indeterminate = n > 0 && n < total
  }
}

/** 把当前选中的 key 还原成资产对象（列表可能刚被过滤过） */
function selectedItems() {
  return allItems().filter(i => selectedKeys.has(itemKey(i)))
}

/** 长按 / 右键卡片弹出的操作菜单 */
function openCardMenu(item) {
  if (!item) return
  menuItem = item
  const name = $('cardMenuName')
  const info = $('cardMenuInfo')
  if (name) name.textContent = `${item.folder} / ${item.base}`
  if (info) {
    if (isDiskItem(item)) {
      const bits = [`atlas: ${item.relAtlas || item.id}`]
      if (item.relSkeleton) bits.push(String(item.relSkeleton))
      if (item.relImages?.length) bits.push(`${item.relImages.length} 张贴图`)
      info.textContent = `磁盘文件 · ${bits.join(' · ')}`
    } else {
      info.textContent = '本次会话上传的资产（不在磁盘上）'
    }
  }
  $('cardMenu').hidden = false
}

/** 二次确认；resolve(true) = 用户确认。删除不可恢复，所以清单必须摆出来。 */
function confirmDelete(items) {
  return new Promise(resolve => {
    const mask = $('confirmModal')
    const list = $('confirmList')
    const diskCount = items.filter(isDiskItem).length

    $('confirmTitle').textContent = items.length === 1 ? '删除这个资产？' : `删除 ${items.length} 个资产？`
    $('confirmWarn').innerHTML = diskCount
      ? '⚠️ 此操作非常危险，可能导致不可逆的数据丢失！<br>将<b>真正删除磁盘上的 '
        + diskCount + ' 套资产文件</b>（atlas / skeleton / 贴图），无法恢复。'
      : '这些是本次会话上传的资产，移除后需要重新上传。'

    list.innerHTML = ''
    for (const it of items) {
      const row = document.createElement('div')
      row.className = 'confirm-row'
      const nm = document.createElement('div')
      nm.className = 'cr-name'
      nm.textContent = `${it.folder || '（根目录）'} / ${it.base}`
      const fl = document.createElement('div')
      fl.className = 'cr-files'
      const bits = []
      if (isDiskItem(it)) {
        if (it.relAtlas || it.id) bits.push(String(it.relAtlas || it.id))
        if (it.relSkeleton) bits.push(String(it.relSkeleton))
        if (it.relImages?.length) bits.push(`+${it.relImages.length} 张贴图`)
      } else {
        bits.push('（会话内上传，不在磁盘上）')
      }
      fl.textContent = bits.join('  ·  ')
      row.appendChild(nm); row.appendChild(fl)
      list.appendChild(row)
    }
    $('confirmYes').textContent = diskCount ? '确认删除' : '移除'
    mask.hidden = false

    const onMask = e => { if (e.target === mask) done(false) }
    const done = ok => {
      mask.hidden = true
      mask.__cancel = null
      mask.removeEventListener('click', onMask)
      $('confirmYes').onclick = null
      $('confirmNo').onclick = null
      resolve(ok)
    }
    // 返回键要能「取消」这个确认框。取消入口挂在元素上，handleBack() 就不必
    // 认识这里的局部闭包 —— 否则 Promise 永远不 resolve，删除流程会挂在半路。
    mask.__cancel = () => done(false)
    mask.addEventListener('click', onMask)
    $('confirmYes').onclick = () => done(true)
    $('confirmNo').onclick = () => done(false)
  })
}

/** 交给原生 / 服务端真删磁盘文件。两边都返回 {deleted:[relAtlas..], failed:[{relAtlas,reason}]} */
async function removeItemsOnDisk(items) {
  const payload = items.map(i => ({
    relAtlas: i.relAtlas || i.id || '',
    relSkeleton: i.relSkeleton || null,
    relImages: i.relImages || [],
  }))
  if (NATIVE) {
    const raw = window.BD2Native.deleteItems(S.rootId || '', JSON.stringify(payload))
    return JSON.parse(raw || '{}')
  }
  const res = await fetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootId: S.rootId, items: payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || '删除失败')
  return data
}

/** 删除 / 移除一批资产（调用前必须已确认）。 */
async function runDelete(items) {
  items = (items || []).filter(Boolean)
  if (!items.length) return

  const disk = items.filter(isDiskItem)
  const local = items.filter(i => !isDiskItem(i))
  const gone = new Set()

  setBusy(true, disk.length ? '正在删除…' : '正在移除…')
  let failed = []
  try {
    if (local.length) {
      S.customItems = S.customItems.filter(i => !local.includes(i))
      for (const it of local) gone.add(itemKey(it))
    }
    if (disk.length) {
      const res = await removeItemsOnDisk(disk)
      for (const k of res.deleted || []) gone.add(String(k))
      failed = res.failed || []
      // 整套没删干净（还有文件残留在磁盘上）就不该从列表里消失
      for (const f of failed) gone.delete(String(f.relAtlas))
    }
  } catch (err) {
    setBusy(false)
    showError('删除失败：' + err.message)
    return
  }
  setBusy(false)

  if (gone.size) {
    S.items = S.items.filter(i => !gone.has(itemKey(i)))
    // 手动顺序里的记录跟着清掉，否则记录会越攒越长
    const order = loadOrder()
    if (order.length) saveOrder(order.filter(k => !gone.has(k)))
    // 缩略图缓存也跟着清，别白占空间
    for (const it of items) {
      const tk = thumbKey(it)
      thumbCache.delete(tk)
      thumbFailed.delete(tk)
      idbDel(tk)
    }
    // 正在看的就是被删的那个 → 退回平铺页
    if (S.current && gone.has(itemKey(S.current))) {
      S.current = null
      disposePlayer()
      const es = $('emptyState')
      if (es) es.hidden = false
      setView('grid')
    }
  }

  // 没删掉的保持选中，方便用户看一眼失败的是哪些再重试
  selectedKeys = new Set(items.filter(i => !gone.has(itemKey(i))).map(itemKey))
  refreshLists()
  applySelectUI()

  if (failed.length) {
    showError(`有 ${failed.length} 个资产没能删除：` + failed.map(f => f.reason || f.relAtlas).join('；'))
  }
  toast(gone.size ? `已删除 ${gone.size} 个资产` : '没有资产被删除')
}

function renderGallery() {
  const grid = $('galGrid')
  if (!grid) return
  const items = filteredItems()
  const count = $('galCount')
  if (count) count.textContent = `平铺浏览 · ${items.length} 个 L2D`
  grid.innerHTML = ''
  for (const item of items) grid.appendChild(galleryCard(item))
  thumbKick()
}

function galleryCard(item) {
  const key = itemKey(item)
  const el = document.createElement('div')
  el.className = 'card' + (item.ok ? '' : ' bad') +
    (S.current && itemKey(S.current) === key ? ' active' : '') +
    (selectMode && selectedKeys.has(key) ? ' sel' : '')
  el.dataset.key = key
  el.__item = item          // 长按菜单要用（拖动引擎只拿到元素）
  el.innerHTML =
    '<div class="card-drag" title="拖动调整播放顺序">⠿</div>' +
    '<div class="card-check" aria-hidden="true"></div>' +
    '<div class="card-thumb pending"></div>' +
    '<button class="card-fs" title="直接全屏播放">⛶</button>' +
    '<div class="card-info"><div class="card-name"></div><div class="card-sub"></div></div>'

  el.querySelector('.card-name').textContent = item.folder
  el.querySelector('.card-sub').textContent =
    item.base + (item.skeletonKind ? `.${item.skeletonKind}` : '') + ` · ${item.images.length} 图`

  const thumb = el.querySelector('.card-thumb')
  const tk = thumbKey(item)
  const cached = thumbCache.get(tk)
  if (cached) setCardThumb(thumb, cached)
  else if (thumbFailed.has(tk)) setCardThumbFailed(thumb)   // 上次就失败了，直接摆出来，不再排队

  el.addEventListener('click', e => {
    // 拖动结束时浏览器补的那一下 click：只吃掉「被拖那张卡」在 700ms 内的这一下，
    // 其它卡片、以及过期之后的操作都不受影响。
    if (suppressClick && e.target.closest('.card') === suppressClick.el &&
        Date.now() < suppressClick.until) { suppressClick = null; return }
    if (e.target.closest('.card-drag') || e.target.closest('.card-fs')) return
    // 选择模式下点击 = 勾选，不打开资产
    if (selectMode) { toggleSelectKey(key); return }
    openItem(item)
  })
  el.querySelector('.card-fs').addEventListener('click', e => {
    e.stopPropagation()
    if (selectMode) { toggleSelectKey(key); return }
    openItem(item, { fullscreen: true })
  })
  // 桌面：右键等同长按。触屏的长按在拖动引擎里判定（按下后一直不动 → 弹菜单）。
  el.addEventListener('contextmenu', e => {
    e.preventDefault()
    if (selectMode) { toggleSelectKey(key); return }
    openCardMenu(item)
  })
  // 整张卡片都能起手拖：把手按下立刻拖；卡片其它地方触屏长按 180ms（鼠标移动 4px）后拖。
  // 短按仍然是「打开资产」、滑动仍然是滚动 —— 判定都在 startCardDrag 里做。
  el.addEventListener('pointerdown', e => {
    if (e.isPrimary === false) return                    // 多指：只认第一根手指，换指时卡片不会跳位
    if (e.button != null && e.button !== 0) return        // 只认主键
    if (e.target.closest('.card-fs')) return              // 全屏按钮有自己的功能
    startCardDrag(e, el)
  })

  // 上次就失败的不再排队（否则每次启动都去重新拉一遍坏文件，还会拖慢队列）
  if (!thumbFailed.has(tk)) {
    if (thumbObserver) thumbObserver.observe(el)
    else el.__wantThumb = true
  }
  return el
}

function setCardThumb(box, url) {
  if (!box) return
  box.classList.remove('pending')
  if (box.querySelector('img')) return
  const img = document.createElement('img')
  img.src = url
  img.alt = ''
  img.draggable = false
  box.appendChild(img)
}

function updateThumbStatus() {
  const el = $('galThumb')
  if (!el) return
  const cards = document.querySelectorAll('#galGrid .card')
  const done = [...cards].filter(c => !c.querySelector('.card-thumb.pending')).length
  if (!cards.length || done >= cards.length) { el.hidden = true; return }
  el.hidden = false
  el.textContent = `缩略图 ${done}/${cards.length}`
}

/** 依次给视野里的卡片生成缩略图；播放页不抢 GL，回平铺页再继续 */
function thumbKick() {
  if (thumbRunning || viewMode !== 'grid') return
  const grid = $('galGrid')
  if (!grid) return
  const itemMap = new Map(filteredItems().map(i => [itemKey(i), i]))
  const card = [...grid.querySelectorAll('.card')].find(c =>
    c.__wantThumb && !c.querySelector('.card-thumb img') && !thumbAsked.has(thumbKey(itemMap.get(c.dataset.key) || {})))
  if (!card) { updateThumbStatus(); return }
  const item = itemMap.get(card.dataset.key)
  if (!item || !item.ok) { card.__wantThumb = false; updateThumbStatus(); setTimeout(thumbKick, 0); return }
  const key = thumbKey(item)
  thumbAsked.add(key)
  thumbRunning = true
  makeThumb(item).then(url => {
    card.__wantThumb = false
    thumbCache.set(key, url)
    idbPut(key, url)
    setCardThumb(card.querySelector('.card-thumb'), url)
    thumbDone++
  }).catch(() => {
    // 生成失败（坏文件 / 超时）：标成失败态、不再重试，队列继续往后走，
    // 不允许一张坏卡片把后面所有缩略图都堵住。
    // 失败结论也存进 IndexedDB（空串），下次启动不再去重新拉那个坏文件。
    card.__wantThumb = false
    thumbFailed.add(key)
    idbPut(key, '')
    setCardThumbFailed(card.querySelector('.card-thumb'))
  }).finally(() => {
    thumbRunning = false
    updateThumbStatus()
    setTimeout(thumbKick, 80)
  })
}

/** 生成失败的卡片：换成「无法生成」的占位（不再是转圈等的 pending 态） */
function setCardThumbFailed(box) {
  if (!box) return
  box.classList.remove('pending')
  box.classList.add('failed')
}

/**
 * 用一次性离屏播放器渲一帧当缩略图。
 * 尺寸小、只取默认动画的中段姿势，渲完立刻 dispose（WebView 的 GL 上下文数量有限）。
 * 坏文件必须「快速失败」：spine-player 内部 JSON.parse 抛的 SyntaxError 不走 error
 * 回调，promise 永不 settle，整个缩略图队列就卡死在那里（2026-09-25 用户实测）。
 * 所以先自己验一遍 JSON，再加兜底超时，保证任何情况下队列都能继续往下走。
 */
async function makeThumb(item, size = 220) {
  const urls = urlsForItem(item)
  // ① 骨架 JSON 预校验（.skel 二进制骨架没有这一步，跳过）
  const jsonUrl = urls.jsonUrl ||
    (urls.skeletonUrl && urls.skeletonKind === 'json' ? urls.skeletonUrl : null)
  if (jsonUrl) {
    const res = await fetch(jsonUrl)
    if (!res.ok) throw new Error(`读不到骨架文件（HTTP ${res.status}）`)
    const text = await res.text()
    try { JSON.parse(text) } catch (e) { throw new Error('JSON 损坏：' + e.message) }
  }

  const host = document.createElement('div')
  host.style.cssText =
    `position:fixed;left:-10000px;top:0;width:${size}px;height:${Math.round(size * 0.72)}px;` +
    'pointer-events:none;visibility:hidden'
  document.body.appendChild(host)
  let player = null
  let done = false
  let timer = 0
  const cleanup = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    try { player?.dispose() } catch { /* ignore */ }
    host.remove()
  }

  try {
    const p = await new Promise((resolve, reject) => {
      // ② 兜底超时：就算播放器内部再出幺蛾子（不走 error 回调），队列也能继续
      timer = setTimeout(() => reject(new Error('缩略图生成超时')), 25000)
      const cfg = {
        showControls: false,
        showLoading: false,
        atlasUrl: urls.atlasUrl,
        backgroundColor: S.bgColor || '#1f2937',
        premultipliedAlpha: S.premultiplied,
        alpha: false,
        preserveDrawingBuffer: true,
        viewport: { padLeft: 6, padRight: 6, padTop: 6, padBottom: 6, transitionTime: 0, animations: {} },
        success: p => resolve(p),
        error: (p, msg) => reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))),
      }
      if (urls.jsonUrl) cfg.jsonUrl = urls.jsonUrl
      else if (urls.skeletonUrl && urls.skeletonKind === 'json') cfg.jsonUrl = urls.skeletonUrl
      else if (urls.skeletonUrl) cfg.binaryUrl = urls.skeletonUrl
      if (Object.keys(urls.rawDataURIs || {}).length) cfg.rawDataURIs = urls.rawDataURIs
      try { player = new spine.SpinePlayer(host, cfg) } catch (e) { reject(e) }
    })
    player = p
    const anims = (p.animationState?.data?.skeletonData?.animations || []).map(a => a.name)
    const name = anims.find(n => /idle/i.test(n)) || anims[0] || null
    if (name) {
      try {
        p.animationState.setAnimation(0, name, true)
        // 让它自己走几帧，避开绑定姿势/起始空帧
        await new Promise(r => setTimeout(r, 260))
        try { p.setViewport(name) } catch { /* 用默认取景 */ }
        for (let i = 0; i < 3; i++) { p.drawFrame(false); await new Promise(r => requestAnimationFrame(r)) }
      } catch { /* 尽力而为 */ }
    }
    const canvas = p.canvas
    let url = null
    try { url = canvas.toDataURL('image/jpeg', 0.62) } catch { url = null }
    if (!url) throw new Error('缩略图渲染失败')
    return url
  } finally {
    cleanup()
  }
}

/* ------------------------------------------------------------ 拖动改顺序

   交互模型（2026-09-25 重写，解决「拖起来不舒服」）：

   起手
     · 按住卡片左上角 ⠿ → 立刻开始拖（把手 touch-action:none，不可能是滚动）
     · 按住卡片其它地方 → 触屏长按 180ms 后开始拖；鼠标/触控笔移动 4px 即开始
     滚动和拖动于是不再互相抢：滑动就是滚动，按住不动才是抬起卡片。

   抬起
     卡片脱离子网格、固定到视口，用 transform 1:1 跟手，并保留「手指按在卡片
     哪一点」的偏移 —— 吸附到中心会立刻破坏「抓住了这个东西」的错觉。

   空位
     网格里留一个同尺寸占位块（.card-ph），它的位置就是落点。越过其他卡片中线
     时占位块移动，被挤开的卡片用 FLIP（先量后写）平移过去，200ms ease-out。
     这样既有实时预览，又不会像旧实现那样让指针底下的卡片乱跳。

   到边自动滚
     指针进入滚动容器上下 56px 内，按深入程度线性加速滚动（最多 1100px/s）。

   松手
     卡片以 200ms ease-out 飞回落点（FLIP 的收尾），顺序写进 localStorage。

   反馈
     抬起 10ms / 落位 8ms 振动（不支持的机型静默跳过），与视觉同一帧触发。
     拖动结束后那一下 click 会被吃掉，不会误开资产。

   排序模式
     处于名称/日期排序时，第一次真的拖动会先把当前看到的顺序固化成手动顺序，
     再切到手动 —— 用户想微调的意图被接住，而不是撞上「这里不能拖」的死胡同。 */

const DRAG = {
  HOLD_MS: 180,      // 触屏长按多久算「抬起」
  MOVE_SLOP: 8,      // 长按判定前允许的抖动（超过就当滚动，放弃拖动）
  MOUSE_SLOP: 4,     // 鼠标按下后移动多少像素开始拖
  MENU_MS: 320,      // 抬起后又保持不动这么久（合计 ~500ms）→ 当长按，弹操作菜单
  EDGE: 56,          // 自动滚动的触发边距
  EDGE_SPEED: 1100,  // 自动滚动最大速度 px/s
  LIFT: 1.04,        // 抬起后的缩放
}

const REDUCE_MOTION = (() => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)') }
  catch { return { matches: false } }
})()

let cardDrag = null              // 当前拖动会话
/* 拖动结束时浏览器还会在「按下和抬起同一个元素」上补一个 click，
   那一下不能当成「打开资产」。但它必须是**针对被拖那张卡**、且有时效的：
   早期版本用一个全局布尔量，结果拖完之后点**别的**卡片也会被吃掉一下
   （2026-09-25 截图脚本里实测到）。 */
let suppressClick = null         // { el, until }

/** 最近一次拖动收尾里被吞掉的异常。
 *  收尾是「不能让半途抛错打断」的路径，所以异常只能兜住；但兜住之后就没人知道了，
 *  于是留一份给脚本化测试断言（正常应该恒为 null）——不然这种问题只会表现为
 *  「偶尔拖完点一下会误开播放页」这种查不出所以然的间歇故障。 */
let lastDragError = null
const dragErrText = e => (e && (e.stack || e.message)) || String(e)

function haptic(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms) } catch { /* 不支持就算了 */ }
}

/** 触屏长按后这个触摸序列不能再变成滚动（自定义手势接管所有轴） */
function blockTouchScroll(ev) {
  if (cardDrag && ev.cancelable) ev.preventDefault()
}

function cardDragReset() {
  cardDrag = null
  document.body.classList.remove('card-dragging')
  window.removeEventListener('touchmove', blockTouchScroll)
}

/**
 * 开始拖动。e 是起手的那次 pointerdown（或长按到期后用它记录的位置）。
 * 只有「指针按在卡片上」这一个前提，其它判定都在这里做。
 */
function startCardDrag(e, card) {
  if (cardDrag) return
  if (selectMode) return                                   // 选择模式下点击 = 勾选，不拖动
  const grid = $('galGrid')
  if (!grid || !card || card.parentElement !== grid) return

  const pid = e.pointerId
  const fromHandle = !!(e.target && e.target.closest && e.target.closest('.card-drag'))
  const isTouch = e.pointerType === 'touch'
  const needHold = isTouch && !fromHandle
  const slop = needHold ? DRAG.MOVE_SLOP : DRAG.MOUSE_SLOP
  const downX = e.clientX, downY = e.clientY

  let holdT = 0
  let started = false
  let waitX = downX, waitY = downY

  const stopWaiting = () => {
    clearTimeout(holdT); holdT = 0
    card.removeEventListener('pointermove', onWaitMove)
    card.removeEventListener('pointerup', onWaitUp)
    card.removeEventListener('pointercancel', onWaitUp)
  }
  function onWaitMove(ev) {
    waitX = ev.clientX; waitY = ev.clientY
    if (Math.abs(waitX - downX) > slop || Math.abs(waitY - downY) > slop) stopWaiting()
  }
  function onWaitUp() { stopWaiting() }

  const begin = (x, y) => {
    if (started || cardDrag) return
    started = true
    stopWaiting()
    beginCardDrag(card, grid, pid, x, y, isTouch)
  }

  if (!needHold) { begin(downX, downY); return }
  card.addEventListener('pointermove', onWaitMove)
  card.addEventListener('pointerup', onWaitUp)
  card.addEventListener('pointercancel', onWaitUp)
  holdT = setTimeout(() => begin(waitX, waitY), DRAG.HOLD_MS)
}

function beginCardDrag(card, grid, pid, x, y, isTouch) {
  const rect = card.getBoundingClientRect()
  const ph = document.createElement('div')
  ph.className = 'card-ph'
  ph.style.height = rect.height + 'px'
  grid.insertBefore(ph, card)   // 空位先占住它原来的格子，网格不会先塌一下

  card.classList.add('dragging')
  card.style.width = rect.width + 'px'
  card.style.height = rect.height + 'px'
  card.style.transition = 'none'   // 跟手不能有过渡（内联优先，压过 .card.dragging 的 CSS）

  cardDrag = {
    card, grid, ph, pid,
    grabX: x - rect.left, grabY: y - rect.top,   // 抓取点偏移：手指按哪儿就一直跟哪儿
    x, y, moved: false,
    // 落点的起手位置（卡片是 fixed 的，不占格子，所以只数「非卡片子元素」的下标）
    startIndex: [...grid.children].filter(el => el !== card).indexOf(ph),
    raf: 0, lastT: 0,
    // 正在飞（或刚飞完）的卡片 → 命中测试要拿它反解 transform，见 layoutRect
    flip: new Map(),
    // 落点判定合并到每帧一次
    pending: false, px: x, py: y,
    holdMenuT: 0,
    onMove: null, onUp: null,
  }

  document.body.classList.add('card-dragging')
  if (isTouch) window.addEventListener('touchmove', blockTouchScroll, { passive: false })
  try { card.setPointerCapture(pid) } catch { /* 合成事件没有真实指针，忽略 */ }

  moveCardTo(x, y)
  haptic(10)

  // 触屏：已经进了拖动态但手指一直没动 —— 那用户要的不是拖动，是长按菜单。
  // 再等 MENU_MS（合计约 500ms）就放弃拖动、把卡片放回原处、弹出删除 / 多选。
  if (isTouch) {
    const d = cardDrag
    d.holdMenuT = setTimeout(() => {
      const cur = cardDrag
      if (!cur || cur !== d || d.moved) return
      abortCardDrag()
      // 手指抬起时浏览器还会补一个 click（按下和抬起是同一张卡）——
      // 那一下会在菜单背后把播放页打开，必须吃掉。走的是同一个「针对这张卡 + 有时效」的抑制。
      suppressClick = { el: card, until: Date.now() + 900 }
      openCardMenu(card.__item)
    }, DRAG.MENU_MS)
  }

  cardDrag.onMove = ev => {
    const d = cardDrag
    if (!d || ev.pointerId !== d.pid) return
    if (!d.moved) {
      d.moved = true
      clearTimeout(d.holdMenuT)      // 真的开始拖了，长按菜单作废
      // 排序不是手动 → 现在真的开始拖了，把当前看到的顺序固化成手动顺序再接住
      if (sortState.mode !== 'manual') {
        seedManualOrderFromSort()
        sortState = { mode: 'manual', dir: 1 }
        saveSort()
        applySortUI()
      }
    }
    moveCardTo(ev.clientX, ev.clientY)
  }
  cardDrag.onUp = ev => {
    const d = cardDrag
    if (!d) return
    if (ev && ev.pointerId != null && ev.pointerId !== d.pid) return
    endCardDrag()
  }

  card.addEventListener('pointermove', cardDrag.onMove)
  card.addEventListener('pointerup', cardDrag.onUp)
  card.addEventListener('pointercancel', cardDrag.onUp)
  window.addEventListener('pointerup', cardDrag.onUp, true)      // 兜住指针跑到窗口外抬起
  window.addEventListener('pointercancel', cardDrag.onUp, true)
  cardDrag.raf = requestAnimationFrame(dragTick)
}

/** 把卡片挪到指针位置（只动 transform，走合成层）并重算落点 */
function moveCardTo(x, y) {
  const d = cardDrag
  if (!d) return
  d.x = x; d.y = y
  d.card.style.transform =
    `translate3d(${x - d.grabX}px, ${y - d.grabY}px, 0) scale(${DRAG.LIFT})`
  placePlaceholder(x, y)
}

/**
 * 算出占位块该待在第几格：按行主序扫一遍，
 * 指针落在某一行之前 → 插到那张卡前面；在同一行里 → 越过中线才插到后面。
 *
 * 判据必须是**布局位置**，不能直接用 getBoundingClientRect 的渲染位置：
 * FLIP 会给被挤开的卡片挂一个 transform，渲染位置已经提前跑到新格子上了，
 * 指针刚好压在两格边界时 dst 就会在两格之间来回翻 —— 每翻一次都重新起一次
 * FLIP，卡片于是来回横跳（就是「反复横跳」那个毛病）。
 * 这里把在飞的 transform 反解掉，只留布局矩形，判据就稳了。
 */
function layoutRect(el, flying) {
  const r = el.getBoundingClientRect()
  if (!flying) return r
  let dx = 0, dy = 0
  try {
    const m = getComputedStyle(el).transform
    if (m && m !== 'none') {
      const mm = new DOMMatrixReadOnly(m)
      dx = mm.m41; dy = mm.m42
    }
  } catch { /* 老引擎没有 DOMMatrix：退回渲染位置，只是灵敏度差一点，不会报错 */ }
  return {
    left: r.left - dx, right: r.right - dx,
    top: r.top - dy, bottom: r.bottom - dy,
    width: r.width, height: r.height,
  }
}

/** 合并到每帧一次：一次拖动能触发几十次 pointermove，边界附近还会叠加自动滚动，
 *  同一帧里反复判定 + 反复重启动画正是抖动的燃料。 */
function placePlaceholder(x, y) {
  const d = cardDrag
  if (!d) return
  d.px = x; d.py = y
  if (d.pending) return
  d.pending = true
  requestAnimationFrame(() => {
    const dd = cardDrag
    if (!dd || dd !== d || !d.pending) return
    d.pending = false
    placePlaceholderNow(d, d.px, d.py)
  })
}

function placePlaceholderNow(d, x, y) {
  const { grid, card, ph } = d

  // 顺手摘掉已经跑完过渡（>300ms）的条目：留着只会让后面多读几次计算样式
  const now = performance.now()
  for (const [el, t] of d.flip) if (now - t > 300) d.flip.delete(el)

  let dst = null
  for (const el of grid.children) {
    if (el === ph || el === card) continue
    const r = layoutRect(el, d.flip.has(el))
    if (y < r.top) { dst = el; break }
    if (y > r.bottom) continue
    if (x < r.left + r.width / 2) { dst = el; break }
  }
  if (dst ? ph.nextElementSibling === dst : !ph.nextElementSibling) return

  const rest = []
  for (const el of grid.children) if (el !== card && el !== ph) rest.push(el)
  const before = rest.map(el => el.getBoundingClientRect())   // 视觉位置（含在飞的位移）

  if (dst) grid.insertBefore(ph, dst)
  else grid.appendChild(ph)

  if (REDUCE_MOTION.matches) return

  // FLIP：起点用「现在看到的位置」，终点用「改完 DOM 后的布局位置」。
  // 起点取视觉位置，正在半路飞行的卡片被再次接管时才是连续的，不会瞬间跳一格。
  const after = rest.map(el => layoutRect(el, d.flip.has(el)))
  let any = false
  rest.forEach((el, i) => {
    const dx = before[i].left - after[i].left
    const dy = before[i].top - after[i].top
    if (!dx && !dy) return
    // 每启动一次 FLIP 就给这张卡换一代号。上一代的清理定时器到点后会自己放弃，
    // 不会把这一代刚写好的起始位移抹掉（两个 FLIP 相隔 ~300ms 是拖动时的常见节奏）。
    el.__flipGen = (el.__flipGen || 0) + 1
    el.style.transition = 'none'
    el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
    d.flip.set(el, performance.now())
    any = true
  })
  if (!any) return
  requestAnimationFrame(() => {
    for (const el of rest) {
      if (!el.style.transform) continue
      const gen = el.__flipGen
      el.style.transition = `transform var(--dur-move) var(--ease-out)`
      el.style.transform = ''
      // 过渡跑完必须把内联 transition 也清掉。只把 transform 清空的话，
      // `style.transition` 会以非空字符串永远留在元素上 ——
      // 而内联值压得过 `.card.dragging{transition:none}`，
      // 后果是这张卡下次被拖时会「追着手指跑」，跟手发飘。
      // （松手瞬间正好有一次 queued 落点判定时最容易踩到：endCardDrag 先清了内联样式，
      //   随后这一帧的 rAF 又把 transition 写回去，从此没人再管它。）
      setTimeout(() => {
        if (el.__flipGen !== gen) return      // 已被新一代 FLIP 接管，别动
        if (cardDrag && cardDrag.card === el) return   // 它正在被拖，内联 transform 归拖动引擎管
        el.style.transition = ''
        el.style.transform = ''
      }, 300)
    }
  })
}

/** 指针贴到滚动容器上下边缘时自动滚动；网格在卡片底下滚，落点要跟着重算 */
function dragTick(t) {
  const d = cardDrag
  if (!d) return
  const dt = d.lastT ? Math.min(64, t - d.lastT) : 16
  d.lastT = t
  const r = d.grid.getBoundingClientRect()
  let v = 0
  if (d.y < r.top + DRAG.EDGE) v = -DRAG.EDGE_SPEED * (1 - (d.y - r.top) / DRAG.EDGE)
  else if (d.y > r.bottom - DRAG.EDGE) v = DRAG.EDGE_SPEED * (1 - (r.bottom - d.y) / DRAG.EDGE)
  v = Math.max(-DRAG.EDGE_SPEED, Math.min(DRAG.EDGE_SPEED, v))
  if (v) {
    const was = d.grid.scrollTop
    d.grid.scrollTop = was + v * dt / 1000
    if (d.grid.scrollTop !== was) placePlaceholder(d.x, d.y)
  }
  d.raf = requestAnimationFrame(dragTick)
}

/** 放弃这次拖动（长按菜单抢走了手势）：把卡片放回原处，不写顺序、不吃点击 */
function abortCardDrag() {
  const d = cardDrag
  if (!d) return
  d.moved = false          // moved=false 会让 endCardDrag 跳过回位动画和 suppressClick
  d.cancelled = true
  endCardDrag()
}

function endCardDrag() {
  const d = cardDrag
  if (!d) return
  cardDragReset()

  const { card, grid, ph, pid } = d
  cancelAnimationFrame(d.raf)
  clearTimeout(d.holdMenuT)
  // 「余波 click」抑制要**最先**装上：浏览器在 pointerup 之后还会补一个 click，
  // 而下面任何一步（补落点判定、FLIP 回位、提交顺序）万一抛错，这一步就被跳过了，
  // 那一下 click 会直接穿到菜单背后把播放页打开 —— 2026-09-25 实测到过这种间歇失败。
  if (d.moved) {
    suppressClick = { el: card, until: Date.now() + 700 }
    haptic(8)
  }
  // 落点判定是合并到每帧一次的，松手可能发生在那次 rAF 之前 ——
  // 先把排队的那一次补上，否则「最后一帧里挪的那一下」会白挪。
  if (d.pending) {
    d.pending = false
    // 兜住异常：宁可少挪一格，也不能让收尾逻辑半途中断（卡片会卡在拖动态）
    try { placePlaceholderNow(d, d.px, d.py) } catch (err) { lastDragError = dragErrText(err) }
  }
  card.removeEventListener('pointermove', d.onMove)
  card.removeEventListener('pointerup', d.onUp)
  card.removeEventListener('pointercancel', d.onUp)
  window.removeEventListener('pointerup', d.onUp, true)
  window.removeEventListener('pointercancel', d.onUp, true)
  try { card.releasePointerCapture(pid) } catch { /* ignore */ }

  // 松手那一刻卡片的可视位置（固定定位 + transform，所以就是这两个数）
  const fromLeft = d.x - d.grabX
  const fromTop = d.y - d.grabY
  // 落点是否真的换了格子 —— 只有换了才值得写顺序 / 弹提示
  const endIndex = [...grid.children].filter(el => el !== card).indexOf(ph)
  const reordered = endIndex !== d.startIndex

  // 复位到占位块那一格，然后按 FLIP 从「松手的位置」滑过去
  grid.insertBefore(card, ph)
  ph.remove()
  card.classList.remove('dragging')
  card.style.cssText = ''
  const to = card.getBoundingClientRect()

  if (d.moved && !REDUCE_MOTION.matches) {
    const dx = fromLeft - to.left
    const dy = fromTop - to.top
    if (dx || dy) {
      card.style.transition = 'none'
      card.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${DRAG.LIFT})`
      card.classList.add('settling')
      requestAnimationFrame(() => {
        card.style.transition = `transform var(--dur-move) var(--ease-out)`
        card.style.transform = ''
      })
      setTimeout(() => {
        card.classList.remove('settling')
        card.style.transition = ''
        card.style.transform = ''
      }, 260)
    }
  }

  // 拖动态给兄弟卡片写过内联 transition/transform（FLIP），这里统一清掉，
  // 不然下次进拖动态时内联的 transition 会压过 .dragging 的 transition:none，跟手发飘。
  for (const el of grid.children) {
    if (el === card) continue
    if (el.style.transition || el.style.transform) {
      el.style.transition = ''
      el.style.transform = ''
    }
  }
  d.flip.clear()

  // 只有「真的拖过」才算重排 —— 放弃的拖动（长按菜单）不该动播放顺序
  if (reordered && d.moved) commitCardOrder()
}

/**
 * 把当前卡片顺序写下来，同步左侧列表（顺序影响全屏 ◀▶）。
 * 手动模式 + 当前是倒序时，把数组反过来存 —— 因为 orderedList 还会再反转一次，
 * 这样屏幕上的顺序和存下来的顺序永远一致，不需要偷偷复位方向。
 */
function commitCardOrder() {
  const grid = $('galGrid')
  if (!grid) return
  let keys = [...grid.querySelectorAll('.card')].map(c => c.dataset.key)
  if (sortState.mode === 'manual' && sortState.dir === -1) keys = keys.slice().reverse()
  saveOrder(keys)
  // 只刷左侧列表，**故意不刷平铺页** —— 卡片刚拖完落地，此刻重建网格 DOM
  // 会把拖动的收尾动画和滚动位置一起打掉；而平铺页的顺序本来就是用户刚摆好的，
  // 不需要再画一遍。这是 refreshLists() 之外唯一的例外。
  renderAssetList()
  toast(`播放顺序已保存（${keys.length} 个）`)
}

/** 重建缩略图：清掉缓存，卡片重新排队 */
async function rebuildThumbs() {
  await idbClearThumbs()
  thumbCache.clear()
  thumbFailed.clear()
  thumbAsked.clear()
  thumbDone = 0
  for (const c of document.querySelectorAll('#galGrid .card')) {
    const box = c.querySelector('.card-thumb')
    if (box) { box.innerHTML = ''; box.classList.remove('failed'); box.classList.add('pending') }
    c.__wantThumb = true
  }
  toast('正在重新生成缩略图…')
  thumbKick()
}

/* ------------------------------------------------------------------ 载入资产 */

function urlsForItem(item) {
  if (item.blobUrls) return item.blobUrls
  const enc = rel => rel.split('/').map(encodeURIComponent).join('/')
  const atlasUrl = `/spine/${S.rootId}/${enc(item.relAtlas)}`
  const skeletonUrl = item.relSkeleton ? `/spine/${S.rootId}/${enc(item.relSkeleton)}` : null
  // 给 spine-player 兜底：告诉它 atlas 里每个页名最终该从哪取。
  const rawDataURIs = {}
  const baseUrl = new URL(atlasUrl, location.href)
  for (let i = 0; i < item.images.length; i++) {
    const pageName = item.images[i].split('/').pop()
    const abs = `/spine/${S.rootId}/${enc(item.images[i])}`
    try { rawDataURIs[new URL(pageName, baseUrl).href] = abs } catch { /* ignore */ }
    rawDataURIs[pageName] = abs
  }
  return { atlasUrl, skeletonUrl, skeletonKind: item.skeletonKind, rawDataURIs }
}

function selectItem(item) {
  S.current = item
  refreshLists()
  if (fsMode) updateFsLabels()
  // 同步到地址栏，方便直接分享 / 刷新回到同一套资产
  const key = item.relAtlas || item.id
  if (key) {
    const q = new URLSearchParams()
    q.set('item', key)
    history.replaceState(null, '', `${location.pathname}?${q}`)
  }
  loadCurrent()
}

async function loadCurrent() {
  const item = S.current
  if (!item) return
  disposePlayer()
  clearError()
  resetMeta()

  $('currentName').textContent = item.folder
  $('currentSub').textContent = [item.group, item.base, item.skeletonKind ? `.${item.skeletonKind}` : '']
    .filter(Boolean).join(' · ')
  $('emptyState').hidden = true
  setBusy(true, '载入中…')

  const urls = urlsForItem(item)
  const cfg = {
    showControls: false,
    showLoading: false,
    atlasUrl: urls.atlasUrl,
    backgroundColor: '00000000',
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    alpha: true,
    viewport: {
      x: 0, y: 0, width: 100, height: 100,
      padLeft: 0, padRight: 0, padTop: 50, padBottom: 50,
      transitionTime: 0,
    },
    update: onFrame,
    success: onLoaded,
    error: (p, msg) => {
      setBusy(false)
      showError('载入失败：' + (typeof msg === 'string' ? msg : JSON.stringify(msg)))
    },
  }
  if (urls.jsonUrl) cfg.jsonUrl = urls.jsonUrl
  else if (urls.skeletonUrl && urls.skeletonKind === 'json') cfg.jsonUrl = urls.skeletonUrl
  else if (urls.skeletonUrl) cfg.binaryUrl = urls.skeletonUrl
  if (Object.keys(urls.rawDataURIs || {}).length) cfg.rawDataURIs = urls.rawDataURIs

  // 骨架 JSON 先自己验一遍再交给播放器：spine-player 内部的 JSON.parse 抛出的
  // SyntaxError 不会走 error 回调，会变成 uncaught error 弹满屏红条还关不掉。
  // 2026-09-24 用户实测：某个 mod 的 .json 是坏文件（50MB+，解析到 5600 万字符处
  // 格式错误），在这里拦下来给一句能看懂的提示，选别的资产继续用。
  if (cfg.jsonUrl) {
    try {
      const res = await fetch(cfg.jsonUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      try {
        JSON.parse(text)
      } catch (e) {
        setBusy(false)
        showError(`「${item.folder}」的 .json 是坏文件（${e.message}）。\n` +
          `多半是下载/拷贝不完整：重新导出一份完整文件，或先看别的资产。`)
        return
      }
    } catch (e) {
      setBusy(false)
      showError('读不到骨架文件：' + e.message)
      return
    }
  }

  try {
    S.player = new spine.SpinePlayer($('playerHost'), cfg)
  } catch (err) {
    setBusy(false)
    showError('初始化播放器失败：' + err.message)
  }
}

function disposePlayer() {
  if (!S.player) return
  try { S.player.dispose() } catch { /* ignore */ }
  S.player = null
  S.camera = null
  $('playerHost').innerHTML = ''
}

function resetMeta() {
  S.animations = []
  S.skins = []
  S.slots = []
  S.hidden = new Set()
  S.hiddenStack = []
  S.selectedLayer = null
  S.bounds = null
  $('animList').innerHTML = ''
  $('skinSelect').innerHTML = ''
  $('layerList').innerHTML = ''
  $('seek').value = 0
  syncStageNav()            // 动画清空了 → 两侧箭头跟着收起来
}

/* ------------------------------------------------------------------ 载入完成 */

function onLoaded(player) {
  const skeleton = player.skeleton
  if (!skeleton) {
    setBusy(false)
    showError('骨架为空：请确认 .json 与 .atlas 是否匹配')
    return
  }

  skeleton.setToSetupPose()
  skeleton.updateWorldTransform()

  // 动画 / 皮肤 / 图层
  S.animations = (player.animationState?.data?.skeletonData?.animations || []).map(a => a.name)
  S.skins = (skeleton.data?.skins || []).map(s => s.name)
  S.slots = (skeleton.data?.slots || []).map(s => s.name)
  renderAnimList()
  renderSkinSelect()
  renderLayerList()
  syncStageNav()            // 动画列表变了 → 两侧箭头的显隐跟着变

  // 默认动画：取景测量必须沿着一个真实动画采样，所以先定动画再算取景框
  const pick = pickDefaultAnimation()
  if (pick) {
    player.animationState.setAnimation(0, pick, S.loop)
    const e = player.animationState.getCurrent(0)
    if (e) e.trackTime = 0
  } else {
    showError('这个骨架里没有任何动画')
  }

  // 取景框（沿当前动画采样实测内容范围）
  S.bounds = computeBounds(skeleton)
  player.config.viewport = {
    x: S.bounds.offset.x, y: S.bounds.offset.y,
    width: Math.max(S.bounds.size.x, 1), height: Math.max(S.bounds.size.y, 1),
    padLeft: 0, padRight: 0, padTop: 50, padBottom: 50,
    transitionTime: 0, animations: {},
  }

  // 自建相机
  const renderCam = player.sceneRenderer.camera
  S.camera = new spine.OrthoCamera(renderCam.viewportWidth, renderCam.viewportHeight)
  S.camera.position.x = S.bounds.offset.x + S.bounds.size.x / 2
  S.camera.position.y = S.bounds.offset.y + S.bounds.size.y / 2
  S.camera.zoom = 1
  S.camera.update()
  fitToWindow()
  new spine.CameraController(player.canvas, S.camera)

  renderAnimList()

  applyBgAlpha(true)
  $('emptyState').hidden = true
  setBusy(false)
  setPlaying(S.autoPlay)
  updatePlayButton()
  updateProgressReadout()
}

/** 默认动画优先级：idle → once → 含 idle 的 → 第一个 */
function pickDefaultAnimation() {
  const a = S.animations
  if (!a.length) return null
  const exact = n => a.find(x => x.toLowerCase() === n)
  return exact('idle') || exact('once') || a.find(x => /idle/i.test(x)) || a[0]
}

/* ------------------------------------------------------------------ 取景范围
 * 不能用 skeleton.getBounds()：BD2 的 cutscene 骨架经常把部件停在绑定姿势的
 * 很远位置（实测有 x≈-5000 的），照绑定姿势算出来的取景框会完全偏到空处。
 * 正确做法是沿动画采样，取每帧实际内容外框的并集。
 */

function contentBoxOf(skeleton) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let found = false
  for (const slot of skeleton.drawOrder) {
    if (slot.color && slot.color.a <= 0) continue
    const att = slot.getAttachment && slot.getAttachment()
    if (!att || typeof att.computeWorldVertices !== 'function') continue
    const n = att.worldVerticesLength || 0
    if (!n) continue
    const v = new Float32Array(n)
    try { att.computeWorldVertices(slot, 0, n, v, 0, 2) } catch { continue }
    for (let i = 0; i < v.length; i += 2) {
      const x = v[i], y = v[i + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      found = true
    }
  }
  return found && maxX > minX && maxY > minY ? { minX, minY, maxX, maxY } : null
}

function unionBoxes(frames) {
  if (!frames.length) return null
  // 去掉面积远超中位数的帧（例如某个特效瞬间飞到很远），避免取景框被撑爆
  const area = f => (f.maxX - f.minX) * (f.maxY - f.minY)
  const sorted = frames.map(area).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 1
  const keep = frames.filter(f => area(f) <= median * 4 + 1)
  const use = keep.length ? keep : frames
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const f of use) {
    if (f.minX < box.minX) box.minX = f.minX
    if (f.minY < box.minY) box.minY = f.minY
    if (f.maxX > box.maxX) box.maxX = f.maxX
    if (f.maxY > box.maxY) box.maxY = f.maxY
  }
  return box
}

/** 沿一个动画采样，返回内容外框（会临时改姿势，结束后恢复） */
function measureAnimationBox(skeleton, entry, samples = 16) {
  const st = S.player?.animationState
  if (!st) return null
  const savedTime = entry ? entry.trackTime : 0
  const frames = []
  for (let i = 0; i < samples; i++) {
    try {
      if (entry) {
        entry.trackTime = (i / samples) * (entry.animation.duration || 0)
        entry.animationLast = -1
        entry.nextAnimationLast = -1
        st.apply(skeleton)
      } else {
        skeleton.setToSetupPose()
      }
      skeleton.updateWorldTransform()
    } catch { continue }
    const b = contentBoxOf(skeleton)
    if (b) frames.push(b)
  }
  if (entry) {
    try {
      entry.trackTime = savedTime
      entry.animationLast = -1
      st.apply(skeleton)
      skeleton.updateWorldTransform()
    } catch { /* ignore */ }
  }
  return unionBoxes(frames)
}

function boundsFromBox(box, padding = 50) {
  if (!box) return null
  const w = box.maxX - box.minX
  const h = box.maxY - box.minY
  if (!(w > 0) || !(h > 0)) return null
  return {
    offset: new spine.Vector2(box.minX - padding, box.minY - padding),
    size: new spine.Vector2(w + padding * 2, h + padding * 2),
  }
}

/**
 * 借用 spine-player 自带的 calculateAnimationViewport（沿动画 100 步采样取并集）来测内容范围。
 * 做法：临时把 config.viewport 的显式范围与内边距清零，调 setViewport(动画名) 让它自动计算，
 * 读完 currentViewport 再还原。
 */
function libraryContentBox(animName) {
  const p = S.player
  if (!p || !p.animationState || !p.skeleton || !animName) return null
  const saved = p.config.viewport
  try {
    const vp = {
      padLeft: 0, padRight: 0, padTop: 0, padBottom: 0,
      transitionTime: 0, animations: {},
    }
    p.config.viewport = vp
    p.setViewport(animName)
    const cur = p.currentViewport
    if (!cur || !(cur.width > 0) || !(cur.height > 0)) return null
    return {
      minX: cur.x, minY: cur.y,
      maxX: cur.x + cur.width, maxY: cur.y + cur.height,
    }
  } catch {
    return null
  } finally {
    p.config.viewport = saved
  }
}

function computeBounds(skeleton) {
  // 1) 库自带算法（最准，100 步采样）
  const box = libraryContentBox(currentAnimation()?.name)
  if (box) {
    const b = boundsFromBox(box)
    if (b) return b
  }

  // 2) 自己采样 16 帧
  const entry = S.player?.animationState?.getCurrent(0)
  const measured = boundsFromBox(measureAnimationBox(skeleton, entry))
  if (measured) return measured

  // 3) 绑定姿势
  try {
    skeleton.setToSetupPose()
    skeleton.updateWorldTransform()
  } catch { /* ignore */ }
  const setup = boundsFromBox(contentBoxOf(skeleton))
  if (setup) return setup

  // 4) 最后退回骨架自带 bounds
  const offset = new spine.Vector2()
  const size = new spine.Vector2()
  try { skeleton.getBounds(offset, size) } catch { /* ignore */ }
  if (!(size.x > 0) || !(size.y > 0)) { offset.x = -500; offset.y = -500; size.x = 1000; size.y = 1000 }
  return { offset, size }
}

/* ------------------------------------------------------------------ 每帧回调 */

function onFrame(player) {
  const cam = player.sceneRenderer.camera
  if (S.camera) {
    // canvas 尺寸变化时同步我自己的相机视口（zoom 不动，交给用户按「适配窗口」重算）
    if (S.camera.viewportWidth !== cam.viewportWidth || S.camera.viewportHeight !== cam.viewportHeight) {
      S.camera.viewportWidth = cam.viewportWidth
      S.camera.viewportHeight = cam.viewportHeight
      S.camera.update()
    }
    cam.position.x = S.camera.position.x
    cam.position.y = S.camera.position.y
    cam.zoom = S.camera.zoom
  }
  applyLayerVisibility(player.skeleton)
  drawOverlay()
  updateProgressReadout()
}

function applyLayerVisibility(skeleton) {
  if (!skeleton || !S.hidden.size) return
  for (const slot of skeleton.slots) {
    const n = slot.data && slot.data.name
    if (!n || !S.hidden.has(n)) continue
    if (slot.color) slot.color.a = 0
    if (slot.darkColor) slot.darkColor.a = 0
  }
}

function restoreLayerAlpha(name) {
  const skeleton = S.player?.skeleton
  if (!skeleton) return
  const slot = skeleton.slots.find(s => s.data && s.data.name === name)
  if (!slot) return
  if (slot.color) {
    const a = slot.data?.color?.a
    slot.color.a = typeof a === 'number' ? a : 1
  }
  if (slot.darkColor) {
    const a = slot.data?.darkColor?.a
    if (typeof a === 'number') slot.darkColor.a = a
  }
}

function updateProgressReadout() {
  const p = S.player
  if (!p || !p.animationState) return
  const entry = p.animationState.getCurrent(0)
  if (!entry || !entry.animation) return
  const d = entry.animation.duration || 0
  if (d <= 0) return
  const t = (entry.trackTime % d + d) % d
  $('seek').value = String(t / d)
}

/* ------------------------------------------------------------------ 动画 */

function currentEntry() {
  return S.player?.animationState?.getCurrent(0) || null
}

function currentAnimation() {
  const e = currentEntry()
  return e?.animation || null
}

function playAnimation(name) {
  const p = S.player
  if (!p || !p.animationState) return
  p.animationState.setAnimation(0, name, S.loop)
  const entry = currentEntry()
  if (entry) entry.trackTime = 0
  p.speed = S.speed
  // 不同动画的内容位置常常差很远（cutscene 骨架尤其明显），按需重新取景。
  // 传 true：重新取景但保留用户当前的放大程度，切动画不会被打回原始大小。
  if (S.autoRefit) refitBounds(true)
  renderAnimList()
  if (S.playing) p.play(); else p.pause()
}

/**
 * 按当前动画重新测量内容范围，并同步给播放器的 viewport。
 * keepUserZoom = true 时保留用户当前的放大程度（同一个文件里换动画用这个）。
 */
function refitBounds(keepUserZoom) {
  const p = S.player
  if (!p || !p.skeleton) return
  const ratio = keepUserZoom ? currentZoomRatio() : 1
  const cam = S.camera
  // 用户已经自己缩放或拖过视角：切动画时别把镜头拽回新动画的中心
  const adjusted = keepUserZoom && cam && S.defaultPos && (
    Math.abs(ratio - 1) > 0.01
    || Math.abs(cam.position.x - S.defaultPos.x) > 1
    || Math.abs(cam.position.y - S.defaultPos.y) > 1)
  const b = computeBounds(p.skeleton)
  if (!b) return
  S.bounds = b
  p.config.viewport = {
    x: b.offset.x, y: b.offset.y,
    width: Math.max(b.size.x, 1), height: Math.max(b.size.y, 1),
    padLeft: 0, padRight: 0, padTop: 50, padBottom: 50,
    transitionTime: 0, animations: {},
  }
  fitToWindow(ratio, !!adjusted)
}

function setPlaying(on) {
  S.playing = on
  const p = S.player
  if (!p) return
  if (on) p.play(); else p.pause()
  updatePlayButton()
}

function updatePlayButton() {
  $('btnPlay').textContent = S.playing ? '暂停' : '播放'
  const m = $('mPlay')
  if (m) m.textContent = S.playing ? '暂停' : '播放'
}

function stepFrame(dir) {
  const p = S.player
  const entry = currentEntry()
  if (!p || !entry || !p.skeleton) return
  p.pause()
  S.playing = false
  updatePlayButton()
  const fps = S.fps || 60
  entry.trackTime = Math.max(0, (entry.trackTime || 0) + dir / fps)
  p.animationState.apply(p.skeleton)
  p.skeleton.updateWorldTransform()
  p.drawFrame(false)
  updateProgressReadout()
}

function renderAnimList() {
  const box = $('animList')
  const q = $('animFilter').value.trim().toLowerCase()
  const cur = currentAnimation()?.name
  box.innerHTML = ''
  for (const name of S.animations) {
    if (q && !name.toLowerCase().includes(q)) continue
    const el = document.createElement('div')
    el.className = 'list-item' + (name === cur ? ' active' : '')
    el.textContent = name
    el.onclick = () => playAnimation(name)
    box.appendChild(el)
  }
  if (!S.animations.length) {
    const el = document.createElement('div')
    el.className = 'list-item'
    el.style.color = '#6b7280'
    el.textContent = '（暂无动画）'
    box.appendChild(el)
  }
  if (fsMode) updateFsLabels()
}

function renderSkinSelect() {
  const sel = $('skinSelect')
  sel.innerHTML = ''
  for (const name of S.skins) {
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = name
    sel.appendChild(opt)
  }
  sel.disabled = S.skins.length <= 1
}

function applySkin(name) {
  const p = S.player
  if (!p || !p.skeleton) return
  try {
    p.skeleton.setSkinByName(name)
    p.skeleton.setSlotsToSetupPose()
  } catch (err) {
    showError('切换皮肤失败：' + err.message)
    return
  }
  p.skeleton.updateWorldTransform()
  S.hidden.clear()
  S.hiddenStack = []
  renderLayerList()
  p.drawFrame(false)
}

/* ------------------------------------------------------------------ 图层 */

function renderLayerList() {
  const box = $('layerList')
  const q = $('layerFilter').value.trim().toLowerCase()
  box.innerHTML = ''
  const names = [...S.slots].sort((a, b) => a.localeCompare(b))
  let n = 0
  for (const name of names) {
    if (q && !name.toLowerCase().includes(q)) continue
    n++
    const row = document.createElement('label')
    row.className = 'layer-row' +
      (S.hidden.has(name) ? ' hidden-layer' : '') +
      (S.selectedLayer === name ? ' selected' : '')
    row.innerHTML = `<input type="checkbox" ${S.hidden.has(name) ? '' : 'checked'}>` +
      `<span class="name"></span>`
    row.querySelector('.name').textContent = name
    row.querySelector('.name').title = name
    row.querySelector('input').onchange = e => {
      e.stopPropagation()
      setLayerHidden(name, !e.target.checked)
    }
    row.onclick = e => {
      if (e.target.tagName === 'INPUT') return
      S.selectedLayer = S.selectedLayer === name ? null : name
      updateLayerToast()
      renderLayerList()
    }
    box.appendChild(row)
  }
  if (!n) {
    const el = document.createElement('div')
    el.className = 'layer-row'
    el.style.color = '#6b7280'
    el.textContent = S.slots.length ? '没有匹配的图层' : '（暂无图层）'
    box.appendChild(el)
  }
}

function setLayerHidden(name, hidden) {
  if (hidden) {
    S.hidden.add(name)
    if (!S.hiddenStack.includes(name)) S.hiddenStack.push(name)
  } else {
    S.hidden.delete(name)
    S.hiddenStack = S.hiddenStack.filter(x => x !== name)
    restoreLayerAlpha(name)
  }
  if (S.selectedLayer === name && hidden) {
    // 保持选中，方便 U 恢复
  }
  updateLayerToast()
  renderLayerList()
  S.player?.drawFrame(false)
}

function updateLayerToast() {
  const t = $('layerToast')
  if (!S.selectedLayer) { t.hidden = true; return }
  t.hidden = false
  t.innerHTML = '已选图层：<b></b>'
  t.querySelector('b').textContent = S.selectedLayer
}

/* ------------------------------------------------------------------ 点选图层 */

function isPointInPolygon(px, py, v) {
  let inside = false
  for (let i = 0, j = v.length - 2; i < v.length; j = i, i += 2) {
    const xi = v[i], yi = v[i + 1], xj = v[j], yj = v[j + 1]
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

function screenToWorld(clientX, clientY) {
  const p = S.player
  const cam = S.camera
  const rect = $('stageInner').getBoundingClientRect()
  if (!p || !cam || !rect.width || !rect.height) return null
  const dpr = window.devicePixelRatio || 1
  const canvas = p.canvas
  const cw = canvas.clientWidth || rect.width
  const ch = canvas.clientHeight || rect.height
  const sx = (clientX - rect.left) * (cw / rect.width)
  const sy = (clientY - rect.top) * (ch / rect.height)
  const nx = (sx / cw) * 2 - 1
  const ny = 1 - (sy / ch) * 2
  // 可见世界宽 = zoom * viewportWidth
  const vw = cam.viewportWidth, vh = cam.viewportHeight
  return {
    x: cam.position.x + nx * (cam.zoom * vw) / 2,
    y: cam.position.y + ny * (cam.zoom * vh) / 2,
    // 归一化屏幕坐标（-1..1，中心为 0）：双击定点放大要用它反推相机位置
    nx,
    ny,
    dpr,
  }
}

function pickLayerAt(clientX, clientY) {
  const p = S.player
  const pt = screenToWorld(clientX, clientY)
  if (!p || !pt || !p.skeleton) return null
  const slots = p.skeleton.drawOrder
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i]
    const name = slot.data && slot.data.name
    if (!name || S.hidden.has(name)) continue
    const att = slot.getAttachment && slot.getAttachment()
    if (!att || typeof att.computeWorldVertices !== 'function') continue
    const n = att.worldVerticesLength || 0
    if (!n) continue
    const verts = new Float32Array(n)
    try { att.computeWorldVertices(slot, 0, n, verts, 0, 2) } catch { continue }
    if (isPointInPolygon(pt.x, pt.y, verts)) return name
  }
  return null
}

function drawOverlay() {
  const canvas = $('overlayCanvas')
  const host = $('stageInner')
  const p = S.player
  if (!canvas || !p) return
  const rect = host.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(rect.width * dpr))
  const h = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (!S.selectedLayer || !S.layerSelect || !p.skeleton) return

  const slot = p.skeleton.slots.find(s => s.data && s.data.name === S.selectedLayer)
  if (!slot || S.hidden.has(S.selectedLayer)) return
  const att = slot.getAttachment && slot.getAttachment()
  if (!att || typeof att.computeWorldVertices !== 'function') return
  const n = att.worldVerticesLength || 0
  if (!n) return
  const verts = new Float32Array(n)
  try { att.computeWorldVertices(slot, 0, n, verts, 0, 2) } catch { return }

  const cam = S.camera
  const canvasEl = p.canvas
  const cw = canvasEl.clientWidth || rect.width
  const ch = canvasEl.clientHeight || rect.height
  const kx = rect.width / cw, ky = rect.height / ch

  ctx.beginPath()
  for (let i = 0; i < verts.length; i += 2) {
    const wx = verts[i], wy = verts[i + 1]
    const nx = ((wx - cam.position.x) / cam.zoom) / (cam.viewportWidth / 2)
    const ny = ((wy - cam.position.y) / cam.zoom) / (cam.viewportHeight / 2)
    const sx = ((nx + 1) / 2 * cw) * kx * dpr
    const sy = ((1 - (ny + 1) / 2) * ch) * ky * dpr
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy)
  }
  ctx.closePath()
  ctx.strokeStyle = '#a5b4fc'
  ctx.lineWidth = 2 * dpr
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.fillStyle = 'rgba(99,102,241,0.35)'
  ctx.fill()
}

/* ------------------------------------------------------------------ 相机 */

/**
 * 用户当前的放大程度 = cam.zoom / 「刚好铺满视口」的 zoom。
 * 记这个比例而不是绝对值：换动画后取景框大小会变，按同一个比例换算，
 * 用户看到的画面占比就不变 —— 也就不会「一切换动画就被打回原始大小」。
 */
function currentZoomRatio() {
  const cam = S.camera
  if (!cam || !S.bounds) return 1
  const fit = defaultZoomFor(Math.max(cam.viewportWidth, 1), Math.max(cam.viewportHeight, 1))
  if (!(fit > 0) || !Number.isFinite(cam.zoom)) return 1
  return clamp(cam.zoom / fit, 0.08, 4)
}

function fitToWindow(zoomRatio = 1, keepPos = false) {
  const p = S.player
  const cam = S.camera
  if (!p || !cam || !S.bounds) return
  // 关键：success 回调触发时 canvas 像素尺寸可能还是默认的 300x150，
  // 必须先让 renderer 按显示尺寸重设 canvas，再拿真实像素尺寸算 zoom。
  p.sceneRenderer.resize(1)
  const canvas = p.canvas
  const rcam = p.sceneRenderer.camera
  cam.viewportWidth = rcam.viewportWidth
  cam.viewportHeight = rcam.viewportHeight

  const { offset, size } = S.bounds
  const vw = Math.max(rcam.viewportWidth, 1)
  const vh = Math.max(rcam.viewportHeight, 1)
  const fit = defaultZoomFor(vw, vh)
  // 用户自己缩放/拖动过视角后，切动画只重换算力，不把镜头拉回新动画的中心
  if (!keepPos) {
    cam.position.x = offset.x + size.x / 2
    cam.position.y = offset.y + size.y / 2
  }
  cam.zoom = fit * zoomRatio
  cam.update()
  S.defaultPos = { x: cam.position.x, y: cam.position.y }
  S.defaultZoom = fit
  debugDump()
  p.drawFrame(false)
}

/** 让取景框恰好铺满给定视口所需的 zoom（可见世界尺寸 = zoom × 视口） */
function defaultZoomFor(vw, vh) {
  const paddedW = Math.max(S.bounds?.size.x || 1, 1)
  const paddedH = Math.max((S.bounds?.size.y || 1) + 100, 1)
  return Math.max(paddedW / Math.max(vw, 1), paddedH / Math.max(vh, 1))
}

/** 把取景框 / 相机参数写到 DOM 上，便于排查（不影响显示） */
function debugDump() {
  const p = S.player
  if (!p || !S.bounds) return
  const canvas = p.canvas
  const cam = S.camera
  $('stageInner').dataset.debug = JSON.stringify({
    canvas: [canvas.width, canvas.height],
    client: [canvas.clientWidth, canvas.clientHeight],
    dpr: window.devicePixelRatio,
    boundsOffset: [+S.bounds.offset.x.toFixed(1), +S.bounds.offset.y.toFixed(1)],
    boundsSize: [+S.bounds.size.x.toFixed(1), +S.bounds.size.y.toFixed(1)],
    camPos: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1)],
    camZoom: +cam.zoom.toFixed(3),
    camViewport: [cam.viewportWidth, cam.viewportHeight],
    visibleWorld: [+(cam.zoom * cam.viewportWidth).toFixed(1), +(cam.zoom * cam.viewportHeight).toFixed(1)],
    anims: S.animations.length,
    slots: S.slots.length,
  })
}

function resetCamera() {
  const p = S.player, cam = S.camera
  if (!p || !cam) return
  cam.position.x = S.defaultPos.x
  cam.position.y = S.defaultPos.y
  cam.zoom = S.defaultZoom
  cam.update()
  p.drawFrame(false)
}

function setZoom(z) {
  const p = S.player, cam = S.camera
  if (!p || !cam) return
  const min = S.defaultZoom * 0.08
  const max = S.defaultZoom * 4
  cam.zoom = clamp(z, min, max)
  cam.update()
  p.drawFrame(false)
}

/**
 * 舞台尺寸变了（进/出全屏、转屏、窗口缩放）：按新视口重设 canvas，
 * 并把 zoom 换算成「同一个比例」，让画面占比保持不变 —— 否则一进全屏
 * 视野就被放大一截，人物反而变小/变大。
 */
function onStageResize() {
  layoutBgImage()
  const p = S.player
  const cam = S.camera
  if (!p || !cam) { if (p && !S.busy) p.drawFrame(false); return }
  const ratio = currentZoomRatio()          // 必须用旧视口算，读完再改 viewport
  try { p.sceneRenderer.resize(1) } catch { /* ignore */ }
  const rc = p.sceneRenderer.camera
  const changed = cam.viewportWidth !== rc.viewportWidth || cam.viewportHeight !== rc.viewportHeight
  cam.viewportWidth = rc.viewportWidth
  cam.viewportHeight = rc.viewportHeight
  if (changed && S.bounds) {
    // 只换 zoom，位置不动 —— 用户当前盯着的那一点继续停在屏幕中心
    const fit = defaultZoomFor(Math.max(rc.viewportWidth, 1), Math.max(rc.viewportHeight, 1))
    cam.zoom = clamp(fit * ratio, fit * 0.08, fit * 4)
    S.defaultZoom = fit
  }
  cam.update()
  if (!S.busy) p.drawFrame(false)
  debugDump()
}

/* ------------------------------------------------------------------ 背景 */

function applyBgAlpha(alwaysTransparentCanvas = true) {
  const p = S.player
  if (!p) return
  // canvas 始终透明，视觉背景由 DOM 层负责（与原站一致）
  p.config.backgroundColor = '00000000'
  try { p.bg.setFromString('00000000') } catch { /* ignore */ }
  p.dom.style.backgroundColor = 'transparent'
  if (p.canvas) p.canvas.style.backgroundColor = 'transparent'
  $('bgLayer').style.background = S.bgColor
  layoutBgImage()
}

function layoutBgImage() {
  const img = $('bgImage')
  const host = $('bgLayer')
  if (!S.bgImageUrl) { img.hidden = true; img.removeAttribute('src'); return }
  if (img.getAttribute('src') !== S.bgImageUrl) img.src = S.bgImageUrl
  img.hidden = false
  const apply = () => {
    const rect = host.getBoundingClientRect()
    const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1
    if (!rect.width || !rect.height) return
    const s = Math.min(rect.width / nw, rect.height / nh)
    const w = nw * s, h = nh * s
    img.style.position = 'absolute'
    img.style.left = `${(rect.width - w) / 2}px`
    img.style.top = `${(rect.height - h) / 2}px`
    img.style.width = `${w}px`
    img.style.height = `${h}px`
    img.style.objectFit = 'fill'
  }
  if (img.complete) apply()
  else img.onload = apply
}

/* ------------------------------------------------------------------ 导出辅助 */

function animDuration() {
  const a = currentAnimation()
  return a && a.duration > 0 ? a.duration : 3
}

function setCanvasSizeForCapture(targetW, targetH) {
  const p = S.player
  const canvas = p.canvas
  const dpr = window.devicePixelRatio || 1
  const state = {
    w: canvas.width, h: canvas.height,
    sw: canvas.style.width, sh: canvas.style.height,
    pos: { x: S.camera.position.x, y: S.camera.position.y },
    zoom: S.camera.zoom,
  }
  canvas.style.width = `${targetW / dpr}px`
  canvas.style.height = `${targetH / dpr}px`
  p.sceneRenderer.resize(1)          // 重设 canvas 像素尺寸 + gl.viewport + 相机 viewport
  state.realW = canvas.width
  state.realH = canvas.height
  // 同步我自己的相机视口
  S.camera.viewportWidth = p.sceneRenderer.camera.viewportWidth
  S.camera.viewportHeight = p.sceneRenderer.camera.viewportHeight
  return state
}

function restoreCanvasSize(state) {
  const p = S.player
  const canvas = p.canvas
  canvas.style.width = state.sw
  canvas.style.height = state.sh
  p.sceneRenderer.resize(1)
  S.camera.position.x = state.pos.x
  S.camera.position.y = state.pos.y
  S.camera.zoom = state.zoom
  S.camera.update()
  p.drawFrame(false)
}

/** 为指定分辨率设置取景：keepCurrent 时保持当前可见世界范围，否则回到默认取景 */
function frameForCapture(realW, realH, keepCurrent, prevW, prevH) {
  const cam = S.camera
  if (keepCurrent) {
    // 视口变大 k 倍 → zoom 也要乘 k，可见世界范围才不变
    const k = Math.max(realW / Math.max(prevW, 1), realH / Math.max(prevH, 1))
    cam.zoom = cam.zoom * k
  } else {
    cam.position.x = S.defaultPos.x
    cam.position.y = S.defaultPos.y
    cam.zoom = defaultZoomFor(realW, realH)
  }
  cam.update()
}

/* 把「背景色 + 背景图 + 模型画布」画进目标 2D 上下文。
 * 页面上的背景是 CSS 层（透视在 WebGL 画布下面），所以任何离屏产出都必须自己合成，
 * 否则导出的图/视频里背景会是黑的。 */
function paintBgAndSource(ctx, source, transparent, targetW, targetH) {
  ctx.clearRect(0, 0, targetW, targetH)
  if (!transparent) {
    ctx.fillStyle = S.bgColor
    ctx.fillRect(0, 0, targetW, targetH)
    const img = $('bgImage')
    if (S.bgImageUrl && img && img.naturalWidth) {
      const host = $('bgLayer').getBoundingClientRect()
      const stage = $('stageInner').getBoundingClientRect()
      const kx = targetW / stage.width, ky = targetH / stage.height
      const x = (host.left - stage.left) * kx +
        (parseFloat(img.style.left) || 0) * kx
      const y = (host.top - stage.top) * ky +
        (parseFloat(img.style.top) || 0) * ky
      const w = (parseFloat(img.style.width) || 0) * kx
      const h = (parseFloat(img.style.height) || 0) * ky
      ctx.drawImage(img, x, y, w, h)
    }
  }
  ctx.drawImage(source, 0, 0, targetW, targetH)
}

function composeToCanvas(source, transparent, targetW, targetH) {
  if (transparent && !S.bgImageUrl) return source
  const off = document.createElement('canvas')
  off.width = targetW
  off.height = targetH
  paintBgAndSource(off.getContext('2d'), source, transparent, targetW, targetH)
  return off
}

/* ------------------------------------------------------------------ 截图 */

async function screenshot(transparent, sizeOverride) {
  const p = S.player
  if (!p || !S.camera) { showError('还没有载入任何资产'); return }
  if (S.busy) return
  S.busy = true
  try {
    const gl = p.context.gl
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096
    const base = Math.min(sizeOverride || S.maxSize, maxTex)
    const prev = p.canvas
    const aspect = prev.height / (prev.width || 1)
    let targetW, targetH
    if (sizeOverride) {
      targetW = base
      targetH = Math.round(base * aspect) || base
    } else {
      targetW = targetH = base
    }
    const st = setCanvasSizeForCapture(targetW, targetH)
    frameForCapture(st.realW, st.realH, S.useCurrentCamera, st.w, st.h)
    p.drawFrame(false)
    const composed = composeToCanvas(p.canvas, transparent, st.realW, st.realH)
    const blob = await new Promise(r => composed.toBlob(r, 'image/png'))
    restoreCanvasSize(st)
    const name = `screenshot_${safeName(S.current?.folder)}_${safeName(currentAnimation()?.name)}${transparent ? '_alpha' : ''}.png`
    // 用 Blob 而非 dataURL：2K 截图的 base64 字符串会有好几 MB，白占内存。
    if (blob) download(blob, name)
    else download(composed.toDataURL('image/png'), name)
  } catch (err) {
    showError('截图失败：' + err.message)
  } finally {
    S.busy = false
  }
}

/* ------------------------------------------------------------------ 导出 WebM */

async function exportWebm(transparent) {
  const p = S.player
  if (!p || !S.camera) { showError('还没有载入任何资产'); return }
  const anim = currentAnimation()
  if (!anim) { showError('没有可导出的动画'); return }
  if (S.busy) return
  S.busy = true
  const note = $('exportNote')
  note.hidden = false
  note.textContent = '正在录制 WebM…'

  const cam = S.camera
  const savedPos = { x: cam.position.x, y: cam.position.y }
  const savedZoom = cam.zoom
  const wasPlaying = S.playing
  let stream = null
  let rec = null

  try {
    // 录制期间暂停引擎自走，改由下面的循环逐帧喂，保证帧数与时长可控。
    setPlaying(false)
    if (!S.useCurrentCamera) {
      const rcam = p.sceneRenderer.camera
      cam.position.x = S.defaultPos.x
      cam.position.y = S.defaultPos.y
      cam.zoom = defaultZoomFor(rcam.viewportWidth, rcam.viewportHeight)
      cam.update()
    }

    const fps = Math.max(1, Math.min(60, Math.round(S.fps || 30)))
    const speed = S.speed || 1
    const total = Math.max(1, Math.round((anim.duration / speed) * fps))
    const frameMs = 1000 / fps

    // 录制源用离屏合成画布：把背景色/背景图烘进画面，
    // 否则 WebGL 画布本身是透明的，视频里背景会变成黑色。
    const out = document.createElement('canvas')
    out.width = Math.max(1, p.canvas.width)
    out.height = Math.max(1, p.canvas.height)
    const outCtx = out.getContext('2d')

    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t))

    // captureStream(0) = 手动帧模式：只有 requestFrame() 时才采一帧。
    // 自动帧模式依赖 rAF，标签页被节流（后台 / 无头 / 最小化）时会一帧都采不到，
    // 表现为「同一份代码有时 1.6MB、有时 0 字节」。
    stream = out.captureStream(0)
    let track = stream.getVideoTracks()[0]
    const manual = !!track && typeof track.requestFrame === 'function'
    if (!manual) {
      stream.getTracks().forEach(t => t.stop())
      stream = out.captureStream(fps)
      track = stream.getVideoTracks()[0]
    }

    const opts = { videoBitsPerSecond: 12_000_000 }
    if (mime) opts.mimeType = mime
    rec = new MediaRecorder(stream, opts)
    const chunks = []
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }

    const done = new Promise((resolve, reject) => {
      rec.onstop = resolve
      rec.onerror = e => reject(e.error || new Error('录制失败'))
    })

    p.animationState.setAnimation(0, anim.name, false)
    const entry = p.animationState.getCurrent(0)

    // 先画好第 0 帧再开录，避免首帧空白
    if (entry) { entry.trackTime = 0; entry.animationLast = -1; entry.nextAnimationLast = -1 }
    p.animationState.apply(p.skeleton)
    p.skeleton.updateWorldTransform()
    p.drawFrame(false)
    paintBgAndSource(outCtx, p.canvas, transparent, out.width, out.height)

    rec.start(400)
    // MediaRecorder 的 start() 是异步进入 recording 的，过早推的帧会被丢掉；
    // 等状态真正就绪再推第一帧，否则偶发「录完 0 字节」。
    const ready = Date.now() + 600
    while (rec.state !== 'recording' && Date.now() < ready) {
      await new Promise(r => setTimeout(r, 10))
    }
    if (manual) track.requestFrame()
    await new Promise(r => setTimeout(r, frameMs))

    const t0 = performance.now()
    let dropped = 0
    for (let i = 0; i < total; i++) {
      if (cancelled) break
      // MediaRecorder 只能按真实时间编码，渲染慢于帧间隔时会拖长视频（慢动作）。
      // 落后超过一帧就跳过这一帧的渲染，让时长保持正确，代价是掉帧。
      const targetMs = i * frameMs
      if (performance.now() - t0 > targetMs + frameMs) { dropped++; continue }
      note.textContent = `正在录制 WebM ${i + 1}/${total} …`
      const t = (i + 1) / fps
      if (entry) { entry.trackTime = t; entry.animationLast = -1; entry.nextAnimationLast = -1 }
      p.animationState.apply(p.skeleton)
      p.skeleton.updateWorldTransform()
      p.drawFrame(false)
      paintBgAndSource(outCtx, p.canvas, transparent, out.width, out.height)
      if (manual) track.requestFrame()
      const wait = t0 + t * 1000 - performance.now()
      await new Promise(r => setTimeout(r, wait > 2 ? wait : 0))
    }
    // 多撑两帧，让编码器把最后一张收进去
    await new Promise(r => setTimeout(r, frameMs * 2 + 60))
    if (rec.state === 'recording') rec.stop()
    await done

    if (!cancelled) {
      const type = rec.mimeType || mime || 'video/webm'
      const blob = new Blob(chunks, { type })
      S.lastWebm = { frames: total, dropped, fps, bytes: blob.size, chunks: chunks.length }
      if (!blob.size) {
        showError('录制结果为空：当前浏览器没能从画布采到帧')
      } else {
        if (dropped > total * 0.15) {
          note.hidden = false
          note.textContent = `提示：渲染跟不上 ${fps} fps，已跳过 ${dropped}/${total} 帧（建议把帧率调低或改用帧序列导出）`
          await new Promise(r => setTimeout(r, 3500))
        }
        download(blob, `animation_${safeName(S.current?.folder)}_${safeName(anim.name)}.webm`)
      }
    }
  } catch (err) {
    showError('导出失败：' + err.message)
  } finally {
    try { if (rec && rec.state !== 'inactive') rec.stop() } catch { /* ignore */ }
    stream?.getTracks().forEach(t => t.stop())
    if (S.animations.length) playAnimation(currentAnimation()?.name || S.animations[0])
    cam.position.x = savedPos.x
    cam.position.y = savedPos.y
    cam.zoom = savedZoom
    cam.update()
    setPlaying(wasPlaying)
    S.busy = false
    note.hidden = true
  }
}

/* ------------------------------------------------------------------ 导出帧序列 */

async function exportFrames(transparent) {
  const p = S.player
  if (!p || !S.camera) { showError('还没有载入任何资产'); return }
  const anim = currentAnimation()
  if (!anim) { showError('没有可导出的动画'); return }
  if (S.busy) return
  S.busy = true
  const note = $('exportNote')
  note.hidden = false

  const cam = S.camera
  const savedPos = { x: cam.position.x, y: cam.position.y }
  const savedZoom = cam.zoom
  const wasPlaying = S.playing

  try {
    setPlaying(false)
    if (!S.useCurrentCamera) {
      const rcam = p.sceneRenderer.camera
      cam.position.x = S.defaultPos.x
      cam.position.y = S.defaultPos.y
      cam.zoom = defaultZoomFor(rcam.viewportWidth, rcam.viewportHeight)
      cam.update()
    }
    const fps = S.fps
    const total = Math.max(1, Math.round(anim.duration * fps))
    const zip = new JSZip()
    const folder = zip.folder(safeName(anim.name)) || zip
    p.animationState.setAnimation(0, anim.name, false)
    const entry = p.animationState.getCurrent(0)

    for (let i = 0; i < total; i++) {
      note.textContent = `正在导出帧 ${i + 1}/${total} …`
      const t = i / fps
      if (entry) {
        entry.trackTime = t
        entry.animationLast = -1
        entry.nextAnimationLast = -1
      }
      p.animationState.apply(p.skeleton)
      p.skeleton.updateWorldTransform()
      p.drawFrame(false)
      const composed = composeToCanvas(p.canvas, transparent, p.canvas.width, p.canvas.height)
      const blob = await new Promise(r => composed.toBlob(r, 'image/png'))
      folder.file(`frame_${String(i).padStart(4, '0')}.png`, blob)
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 0))
    }

    note.textContent = '正在打包 ZIP…'
    const out = await zip.generateAsync({ type: 'blob' })
    download(out, `frames_${safeName(S.current?.folder)}_${safeName(anim.name)}.zip`)
  } catch (err) {
    showError('导出帧序列失败：' + err.message)
  } finally {
    cam.position.x = savedPos.x
    cam.position.y = savedPos.y
    cam.zoom = savedZoom
    cam.update()
    if (S.animations.length) playAnimation(currentAnimation()?.name || S.animations[0])
    setPlaying(wasPlaying)
    S.busy = false
    note.hidden = true
  }
}

/* ------------------------------------------------------------------ 上传 */

const uploaded = { files: [] }

async function blobUrlsFromFiles(files, name) {
  const atlas = files.find(f => f.name.toLowerCase().endsWith('.atlas'))
  const json = files.find(f => f.name.toLowerCase().endsWith('.json'))
  const skel = files.find(f => f.name.toLowerCase().endsWith('.skel'))
  const textures = files.filter(f => /\.(png|jpe?g|webp)$/i.test(f.name))
  if (!atlas) throw new Error('缺少 .atlas 文件')
  if (!json && !skel) throw new Error('缺少 .json 或 .skel 骨架文件')
  if (!textures.length) throw new Error('缺少贴图 .png')

  const atlasText = await await_text(atlas)
  const referenced = [...atlasText.matchAll(/([^\s]+\.(?:png|jpe?g|webp))/gi)].map(m => m[1])
  const base = files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/').slice(0, -1).join('/') : ''
  const missing = referenced.filter(r => {
    const bn = r.split('/').pop()
    return !textures.some(t => t.name === bn)
  })
  if (missing.length) throw new Error('atlas 引用了但没提供这些图：' + missing.join(', '))

  const atlasUrl = URL.createObjectURL(atlas)
  const rawDataURIs = {}
  const baseUrl = new URL(atlasUrl)
  const dir = baseUrl.href.slice(0, baseUrl.href.lastIndexOf('/') + 1)
  for (const t of textures) {
    const u = URL.createObjectURL(t)
    rawDataURIs[dir + t.name] = u
    rawDataURIs[t.name] = u
    if (base) rawDataURIs[`${base}/${t.name}`] = u
  }
  return {
    atlasUrl,
    jsonUrl: json ? URL.createObjectURL(json) : null,
    skeletonUrl: skel ? URL.createObjectURL(skel) : null,
    skeletonKind: json ? 'json' : 'skel',
    rawDataURIs,
  }
}

/** FileReader 同步版（内部 await，命名避免误用） */
function await_text(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('无法读取 atlas'))
    fr.readAsText(file)
  })
}

async function doUpload() {
  const msg = $('uploadMsg')
  msg.textContent = ''
  try {
    const urls = await blobUrlsFromFiles(uploaded.files, $('uploadName').value)
    const label = $('uploadName').value.trim() || uploaded.files[0].name.replace(/\.[^.]+$/, '')
    const item = {
      key: 'custom-' + Date.now(),
      folder: label,
      group: '已上传（本次会话）',
      base: uploaded.files.find(f => f.name.toLowerCase().endsWith('.atlas')).name,
      images: uploaded.files.filter(f => /\.(png|jpe?g|webp)$/i.test(f.name)),
      skeletonKind: urls.skeletonKind,
      blobUrls: urls,
      ok: true,
      problems: [],
      relAtlas: null,
      relSkeleton: null,
    }
    S.customItems.unshift(item)
    $('uploadModal').hidden = true
    uploaded.files = []
    $('dropText').textContent = '把文件拖到这里，或 选择文件'
    selectItem(item)          // 它内部会 refreshLists()，这里不必再刷一遍
  } catch (err) {
    msg.textContent = '✕ ' + err.message
  }
}

/* ---------------------------------------------------------- 导入到 App 目录 */

/* APK 里替代「选择文件夹」：选中的文件直接写进 App 自己的目录，之后照常扫描 */
const IMPORT_MAX_BYTES = 12 * 1024 * 1024

async function onImportFiles(e) {
  const files = [...(e.target.files || [])]
  e.target.value = ''
  if (!files.length || !NATIVE) return

  setBusy(true, `导入 0/${files.length} …`)
  let ok = 0
  const failed = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    setBusy(true, `导入 ${i + 1}/${files.length} · ${f.name}`)
    try {
      if (f.size > IMPORT_MAX_BYTES) throw new Error('超过 12MB')
      const b64 = await fileToBase64(f)
      if (!window.BD2Native.importFile(f.name, b64)) throw new Error('写入失败')
      ok++
    } catch (err) {
      failed.push(`${f.name}（${err.message}）`)
    }
  }
  setBusy(false)
  if (failed.length) showError(`有 ${failed.length} 个文件没导入成功：${failed.join('、')}`)
  else if (ok) {
    try { window.BD2Native.toast(`已导入 ${ok} 个文件`) } catch { /* ignore */ }
  }
  await scan(true)
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      const comma = s.indexOf(',')
      resolve(comma >= 0 ? s.slice(comma + 1) : '')
    }
    r.onerror = () => reject(new Error('读取失败'))
    r.readAsDataURL(file)
  })
}

/* ------------------------------------------------------------------ 界面绑定 */

function bindUI() {
  setupFullscreenUI()
  if (NATIVE) {
    // 不再让用户进系统文件夹选择器 —— 那玩意儿在部分机型上会把进程带崩。
    // 改成「导入文件」：选中的文件直接拷进 App 自己的目录。
    const b = $('btnAddRoot')
    b.textContent = '导入文件'
    b.title = '把手机里的 Spine 文件拷进 App 目录，不用数据线'
  }
  const imp = $('importFiles')
  if (imp) imp.onchange = onImportFiles
  // 顶栏
  $('rootSelect').onchange = e => {
    S.rootId = e.target.value
    S.current = null
    disposePlayer()
    $('emptyState').hidden = false
    $('currentName').textContent = '未载入'
    $('currentSub').textContent = '在右侧列表里选一个资产'
    scan(false)
  }
  $('btnRescan').onclick = () => scan(true)
  // 平铺页（桌面用顶栏按钮，手机用画面左上角 ⊞）
  const gridBtn = $('btnGrid')
  if (gridBtn) gridBtn.onclick = () => setView('grid')
  const galRebuild = $('galRebuild')
  if (galRebuild) galRebuild.onclick = () => rebuildThumbs()
  // 播放顺序：手动 / 名称 / 日期 + 升降序
  const galSort = $('galSort')
  if (galSort) {
    galSort.addEventListener('click', e => {
      const b = e.target.closest('.gs-btn')
      if (b && b.dataset.mode) setSortMode(b.dataset.mode)
    })
  }
  const galSortDir = $('galSortDir')
  if (galSortDir) galSortDir.onclick = () => toggleSortDir()
  // 批量选择 + 删除
  const galSelect = $('galSelect')
  if (galSelect) galSelect.onclick = () => setSelectMode(!selectMode)
  const galSelDone = $('galSelDone')
  if (galSelDone) galSelDone.onclick = () => setSelectMode(false)
  const galSelAll = $('galSelAll')
  if (galSelAll) galSelAll.onchange = () => {
    const cards = document.querySelectorAll('#galGrid .card')
    if (galSelAll.checked) for (const c of cards) selectedKeys.add(c.dataset.key)
    else selectedKeys.clear()
    for (const c of cards) c.classList.toggle('sel', selectedKeys.has(c.dataset.key))
    applySelectUI()
  }
  const galSelDelete = $('galSelDelete')
  if (galSelDelete) galSelDelete.onclick = async () => {
    const items = selectedItems()
    if (!items.length) return
    if (!await confirmDelete(items)) return
    await runDelete(items)
  }
  const cardMenuDelete = $('cardMenuDelete')
  if (cardMenuDelete) cardMenuDelete.onclick = async () => {
    const it = menuItem
    $('cardMenu').hidden = true
    if (!it || !await confirmDelete([it])) return
    await runDelete([it])
  }
  const cardMenuSelect = $('cardMenuSelect')
  if (cardMenuSelect) cardMenuSelect.onclick = () => {
    const it = menuItem
    $('cardMenu').hidden = true
    setSelectMode(true)
    if (it) toggleSelectKey(itemKey(it))
  }
  applySortUI()
  applySelectUI()
  $('btnAddRoot').onclick = async () => {
    if (NATIVE) {
      // 不进系统文件夹选择器（部分机型上会把进程带崩），改拉起文件选择器拷进 App 目录
      $('importFiles').click()
      return
    }
    const p = prompt('输入要添加的本地目录绝对路径（例如 E:\\xxx\\mods）：')
    if (!p) return
    try {
      const res = await fetch('/api/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '添加失败')
      await loadConfig()
      S.rootId = data.root.id
      $('rootSelect').value = S.rootId
      await scan(true)
    } catch (err) {
      showError('添加目录失败：' + err.message)
    }
  }
  $('btnUpload').onclick = () => {
    $('uploadModal').hidden = false
    $('uploadMsg').textContent = ''
  }
  $('btnHelp').onclick = () => { $('helpModal').hidden = false }
  $('btnSettings').onclick = () => { $('settingsModal').hidden = false }
  // 错误提示点一下就关，别挡着下面的操作
  $('errorBox').onclick = clearError

  document.querySelectorAll('[data-close]').forEach(b => {
    b.onclick = () => { $(b.dataset.close).hidden = true }
  })
  document.querySelectorAll('.modal-mask').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.hidden = true })
  })

  // 左侧 tab
  document.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t))
      $('paneControls').classList.toggle('hidden', t.dataset.tab !== 'controls')
      $('paneLayers').classList.toggle('hidden', t.dataset.tab !== 'layers')
    }
  })

  // 动画
  $('animFilter').oninput = renderAnimList
  $('skinSelect').onchange = e => applySkin(e.target.value)

  // 播放
  $('btnPlay').onclick = () => setPlaying(!S.playing)
  $('btnStepBack').onclick = () => stepFrame(-1)
  $('btnStepFwd').onclick = () => stepFrame(1)
  $('chkLoop').onchange = e => {
    S.loop = e.target.checked
    const name = currentAnimation()?.name
    if (name) playAnimation(name)
  }
  $('speedRange').oninput = e => {
    S.speed = Number(e.target.value)
    $('speedVal').textContent = S.speed.toFixed(2) + 'x'
    if (S.player) S.player.speed = S.speed
  }

  // 视图
  $('btnZoomIn').onclick = () => setZoom(S.camera ? S.camera.zoom / 1.2 : 1)
  $('btnZoomOut').onclick = () => setZoom(S.camera ? S.camera.zoom * 1.2 : 1)
  $('btnResetCam').onclick = resetCamera
  $('btnFit').onclick = () => { refitBounds(); fitToWindow() }
  $('chkUseCam').onchange = e => { S.useCurrentCamera = e.target.checked }

  // 背景
  $('bgColor').oninput = e => { S.bgColor = e.target.value; $('setBgColor').value = S.bgColor; applyBgAlpha(true) }
  $('setBgColor').oninput = e => { S.bgColor = e.target.value; $('bgColor').value = S.bgColor; applyBgAlpha(true) }
  $('btnBgImage').onclick = () => $('bgFile').click()
  $('bgFile').onchange = e => {
    const f = e.target.files[0]
    if (!f) return
    const fr = new FileReader()
    fr.onload = () => { S.bgImageUrl = String(fr.result); applyBgAlpha(true) }
    fr.readAsDataURL(f)
  }
  $('btnBgClear').onclick = () => { S.bgImageUrl = null; applyBgAlpha(true) }

  // 截图 / 导出
  $('btnShot').onclick = () => screenshot($('chkTransparent').checked, null)
  $('btnShotBig').onclick = () => screenshot($('chkTransparent').checked, 2048)
  $('btnExportWebm').onclick = () => exportWebm($('chkTransparent').checked)
  $('btnExportFrames').onclick = () => exportFrames($('chkTransparent').checked)

  // 图层
  $('layerFilter').oninput = renderLayerList
  $('chkLayerSelect').onchange = e => {
    S.layerSelect = e.target.checked
    if (!S.layerSelect) { S.selectedLayer = null; updateLayerToast() }
    renderLayerList()
  }
  $('btnShowAll').onclick = () => {
    for (const n of [...S.hidden]) restoreLayerAlpha(n)
    S.hidden.clear(); S.hiddenStack = []
    renderLayerList(); S.player?.drawFrame(false)
  }
  $('btnHideAll').onclick = () => {
    for (const n of S.slots) setLayerHidden(n, true)
  }

  // 右侧
  // 过滤条件变了：走唯一入口 refreshLists()（它内部先 syncFilters() 把控件读进状态）
  $('assetFilter').oninput = refreshLists
  $('chkOnlyPlayable').onchange = refreshLists
  $('btnClearCustom').onclick = () => {
    if (!S.customItems.length) return
    S.customItems = []
    if (S.current?.key?.startsWith('custom-')) { S.current = null; disposePlayer(); $('emptyState').hidden = false }
    refreshLists()
  }

  // 设置
  $('chkPremultiplied').onchange = e => {
    S.premultiplied = e.target.checked
    applyGLTexturePatch(S.premultiplied)
    const cur = S.current
    if (cur) { S.current = null; selectItem(cur) }
  }
  $('chkAutoPlay').onchange = e => { S.autoPlay = e.target.checked }
  $('chkAutoRefit').onchange = e => { S.autoRefit = e.target.checked }
  $('chkAutoRefit').checked = S.autoRefit
  $('setVolumeDir').value = S.volDir
  $('setVolumeDir').onchange = e => {
    S.volDir = e.target.value === 'prev' ? 'prev' : 'next'
    try { localStorage.setItem('bd2.volDir', S.volDir) } catch { /* 无痕模式等 */ }
    updateVolumeKeyHints()
  }
  $('setMaxSize').onchange = e => { S.maxSize = clamp(Number(e.target.value) || 3000, 256, 8192) }
  $('setFps').onchange = e => { S.fps = clamp(Number(e.target.value) || 60, 1, 120) }

  // 播放页左右箭头：切当前资产的**上一个 / 下一个动画**。
  // 与全屏底部 ◀▶、键盘 ↑↓/[ ]、真机音量键共用 switchAnimation() 这一个入口。
  // （切资产是底部那条 ◀◀/▶▶ 的活 —— 两处分工与常见布局相反，别按直觉改回来，
  //   显隐条件也跟着走的是「动画数」而不是「资产数」，见 syncStageNav()。）
  $('stagePrev').onclick = () => switchAnimation(-1)
  $('stageNext').onclick = () => switchAnimation(1)

  // 舞台点选
  const host = $('stageInner')
  let down = null
  host.addEventListener('pointerdown', e => {
    if (!S.layerSelect || e.button !== 0) return
    down = { x: e.clientX, y: e.clientY }
  })
  host.addEventListener('pointerup', e => {
    if (!S.layerSelect || !down) { down = null; return }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
    down = null
    if (moved > 5) return
    const name = pickLayerAt(e.clientX, e.clientY)
    S.selectedLayer = name
    updateLayerToast()
    renderLayerList()
    drawOverlay()
  })

  // 键盘
  window.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return
    const k = e.key.toLowerCase()
    // 全屏模式下音量键切动画。真机由 MainActivity 拦下音量键后回调 onVolumeKey；
    // 这里兜住「WebView/浏览器直接把音量键送到页面」的情况。
    if (k === 'volumeup' || k === 'volumedown') {
      if (!fsMode) return
      e.preventDefault()
      // 音量上键方向可在设置里选「下一个/上一个」，下键永远相反
      switchAnimation((k === 'volumeup' ? 1 : -1) * volDirMul())
      return
    }
    if (k === 'arrowup' || k === 'arrowdown') {
      e.preventDefault()
      switchAnimation(k === 'arrowdown' ? 1 : -1)
      return
    }
    if (k === ' ') { e.preventDefault(); setPlaying(!S.playing); return }
    if (k === 'arrowleft') { e.preventDefault(); stepFrame(-1); return }
    if (k === 'arrowright') { e.preventDefault(); stepFrame(1); return }
    if (k === 'r') { resetCamera(); return }
    if (k === 'f') { refitBounds(); fitToWindow(); return }
    if (k === 'l') { $('chkLayerSelect').checked = !$('chkLayerSelect').checked; $('chkLayerSelect').onchange({ target: $('chkLayerSelect') }); return }
    if (k === 'h') {
      if (S.selectedLayer) {
        const n = S.selectedLayer
        setLayerHidden(n, true)
      }
      return
    }
    if (k === 'u') {
      const n = S.hiddenStack[S.hiddenStack.length - 1]
      if (n) {
        setLayerHidden(n, false)
        S.selectedLayer = n
        updateLayerToast(); renderLayerList(); drawOverlay()
      }
      return
    }
    if (e.key === 'Escape') {
      for (const n of [...S.hidden]) restoreLayerAlpha(n)
      S.hidden.clear(); S.hiddenStack = []; S.selectedLayer = null
      updateLayerToast(); renderLayerList(); S.player?.drawFrame(false)
      return
    }
    if (k === '[' || k === ']') {
      const cur = currentAnimation()?.name
      const i = S.animations.indexOf(cur)
      if (i < 0) return
      const n = S.animations[(i + (k === ']' ? 1 : -1) + S.animations.length) % S.animations.length]
      if (n) playAnimation(n)
    }
  })

  // 拖动上传
  ;['dragenter', 'dragover'].forEach(ev => {
    window.addEventListener(ev, e => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      $('dropzone')?.classList.add('over')
    })
  })
  window.addEventListener('dragleave', () => $('dropzone')?.classList.remove('over'))
  window.addEventListener('drop', async e => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    $('dropzone')?.classList.remove('over')
    const files = [...e.dataTransfer.files]
    const hasSpine = files.some(f => /\.(atlas|json|skel)$/i.test(f.name))
    if (!hasSpine) return
    uploaded.files = files
    $('uploadName').value = files[0].webkitRelativePath?.split('/')[0] || ''
    $('dropzone').classList.add('over')
    $('dropText').textContent = `已接收 ${files.length} 个文件，点「载入」开始`
    $('uploadModal').hidden = false
    $('uploadMsg').textContent = ''
  })

  // 上传弹窗
  $('pickFiles').onclick = e => { e.stopPropagation(); $('filePick').click() }
  $('dropzone').onclick = e => {
    if (e.target.id === 'pickFiles') return
    $('filePick').click()
  }
  $('filePick').onchange = e => {
    uploaded.files = [...e.target.files]
    $('dropzone').classList.add('over')
    $('dropText').textContent = `已接收 ${uploaded.files.length} 个文件，点「载入」开始`
    $('uploadMsg').textContent = ''
  }
  $('btnDoUpload').onclick = doUpload

  // 舞台尺寸变化（全屏 / 转屏 / 窗口缩放）：重排背景 + 按新视口换算 zoom
  let resizeTimer = 0
  new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(onStageResize, 60)
  }).observe($('stageInner'))

  // 滚轮缩放（交给 CameraController，这里只保证缩放后刷新）
  $('playerHost').addEventListener('wheel', () => { if (!S.busy) setTimeout(() => S.player?.drawFrame(false), 0) }, { passive: true })

  // seek
  $('seek').addEventListener('input', e => {
    const p = S.player
    const entry = currentEntry()
    if (!p || !entry || !entry.animation) return
    const d = entry.animation.duration || 0
    if (d <= 0) return
    p.pause()
    S.playing = false
    updatePlayButton()
    entry.trackTime = Number(e.target.value) * d
    p.animationState.apply(p.skeleton)
    p.skeleton.updateWorldTransform()
    p.drawFrame(false)
  })

  // 初始 UI 值
  $('speedVal').textContent = '1.00x'
  $('bgColor').value = S.bgColor
  $('setBgColor').value = S.bgColor
  $('setMaxSize').value = String(S.maxSize)
  $('setFps').value = String(S.fps)

  // 把过滤状态和箭头显隐同控件、数据对齐一次。
  // bindUI 跑在 boot 首次扫描之前，扫描结束后 refreshLists() 会再对齐一次。
  refreshLists()
}

boot()

/* 调试 / 脚本化句柄：便于高级用户在浏览器控制台里直接操作查看器 */
window.__bd2viewer = {
  get state() { return S },
  get isNative() { return NATIVE },
  get player() { return S.player },
  fitToWindow,
  resetCamera,
  refitBounds,
  zoomIn: () => setZoom(S.camera ? S.camera.zoom / 1.2 : 1),
  zoomOut: () => setZoom(S.camera ? S.camera.zoom * 1.2 : 1),
  playAnimation,
  setPlaying,
  get animation() { return currentAnimation()?.name || null },
  get animations() { return S.animations },
  setLayerHidden,
  pickLayerAt,
  screenshot,
  exportWebm,
  exportFrames,
  scan,
  selectItem,
  // 全屏模式：真机的音量键由 MainActivity 拦下后回调这里
  get isFullscreen() { return fsMode },
  setFullscreen,
  switchAnimation,
  // 平铺浏览 / 顺序 / 缩略图
  get view() { return viewMode },
  setView,
  openItem,
  get order() { return loadOrder() },
  setOrder(keys) { saveOrder(keys); refreshLists() },
  rebuildThumbs,
  makeThumb,
  get thumbStats() {
    return { cached: thumbCache.size, done: thumbDone, running: thumbRunning }
  },
  commitCardOrder,
  // 播放顺序：排序方式 + 升降序（同时决定平铺页、左列表、◀▶ 的走向）
  get sort() { return { ...sortState } },
  setSortMode,
  toggleSortDir,
  /** 当前实际生效的播放顺序（键序列，已应用过滤 + 排序） */
  get visibleKeys() { return filteredItems().map(itemKey) },
  get allKeys() { return allItems().map(itemKey) },
  get dragStats() {
    return {
      active: !!cardDrag,
      placeholders: document.querySelectorAll('#galGrid .card-ph').length,
      floating: document.querySelectorAll('#galGrid .card.dragging').length,
      stuckInline: [...document.querySelectorAll('#galGrid .card')]
        .filter(c => c.style.transform || c.style.transition).length,
    }
  },
  /** 拖动收尾里被吞掉的异常（正常恒为 null）—— 间歇性「拖完点一下误开播放页」的探针 */
  get lastDragError() { return lastDragError },
  /** 当前生效的「余波 click 抑制」：脚本化测试用来确认收尾确实装上了它 */
  get suppressClick() {
    return suppressClick
      ? { key: suppressClick.el.dataset.key, until: suppressClick.until, live: Date.now() < suppressClick.until }
      : null
  },
  // 全屏：双击定点放大 / 隐藏界面
  doubleTapZoom,
  get cleanUI() { return cleanUI },
  setCleanUI,
  // 真机音量键：MainActivity 拦下后回调 dir（+1=音量上，-1=音量下），方向由设置决定
  onVolumeKey(dir) { switchAnimation(dir * volDirMul()) },
  get zoomRatio() { return currentZoomRatio() },
  /** 相对「铺满」放大了几倍（脚本化测试双击阶梯用） */
  get zoomFactor() { return 1 / (currentZoomRatio() || 1) },
  ZOOM_LADDER,
  // 选择 / 删除
  get selectMode() { return selectMode },
  setSelectMode,
  toggleSelectKey,
  get selectedKeys() { return [...selectedKeys] },
  selectAllCards() {
    for (const c of document.querySelectorAll('#galGrid .card')) selectedKeys.add(c.dataset.key)
    for (const c of document.querySelectorAll('#galGrid .card')) c.classList.add('sel')
    applySelectUI()
  },
  runDelete,
  confirmDelete,
  openCardMenu,
  // 导航：切上一个/下一个资产、返回键的分层消化
  switchItem,
  handleBack,
  /** 上一次返回被哪一层消化（'none' = 交给宿主）—— 真机按返回没反应时先看这个 */
  get lastBackReason() { return lastBackReason },
  /** 当前过滤条件（只读快照）—— 断言「控件是入口、filters 是事实来源」用 */
  get filters() { return { ...filters } },
  /** 播放页左右箭头此刻是否可见（当前资产有多个动画才显示） */
  get stageNav() { return document.body.classList.contains('stage-nav-avail') },
}
