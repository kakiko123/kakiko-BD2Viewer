/**
 * NIKKE 的 UnityFS 资产包 → 标准 Spine 三件套（桌面端）。
 *
 * 背景：从游戏《NIKKE》里提取出来的 mod 包是 **标准 UnityFS AssetBundle**（未加密、
 * 块压缩），文件名没有扩展名（例：`c010_00_aim_Seireiko_SummerRapiSwap`）。包里是
 *   TextAsset `xxx.atlas`（文本，首行是贴图页名）
 *   TextAsset `xxx.skel` （**二进制** Spine 4.x 骨架）
 *   Texture2D `xxx`      （RGBA32，常另有 `xxx_mask` 等其它格式的贴图）
 * 查看器只认标准导出（`.atlas` + `.skel`/`.json` + `.png`），所以这里把三件套抽到
 * 扫描根下缓存目录 `bd2viewer-nikke/`（**无前导点**；BD2Viewer/nikke/bd2viewer-nikke 为预期）。
 * **每个包一个子文件夹**（需求 6）：
 *   `bd2viewer-nikke/<packFolderName>/xxx.atlas|png|skel`
 * burst / 无 spine 的包不留空文件夹。R18 姿势归组按角色 id 跨同层包文件夹合并
 * （不再要求同目录）。旧平铺缓存：layout version 不匹配则整目录清空重建。
 *
 * 提取引擎与 JCZX 共用：Python + UnityPy（`_tools/nikke_extract.py`，
 * python 解释器解析/venv 逻辑直接复用 jczx_support.mjs）。
 * 差别只在「抽什么」：NIKKE 的骨架是二进制 `.skel`，且贴图只导图集引用的那一页。
 *
 * 增量策略：缓存目录里放 `.manifest.json`，按 `size + mtimeMs` 判断是否需要重抽；
 * 源文件消失时连带清掉它的产出。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  ensureJczxPython,   // 同一套「找 python / 装 venv」逻辑，NIKKE 复用
  looksLikeUnityFS,
  isJczxCacheDirName,
  classifyBundleFile,
  nameHintsJczx,
} from './jczx_support.mjs'
import {
  packFingerprint,
  MODE_SOURCE_FOLDERS,
} from './cache_home.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const NIKKE_CACHE_DIRNAME = 'bd2viewer-nikke'
export const NIKKE_CACHE_DIRNAME_LEGACY = '.bd2viewer-nikke'

const EXTRACT_PY = path.join(__dirname, '_tools', 'nikke_extract.py')

export function isNikkeCacheDirName(name) {
  return name === NIKKE_CACHE_DIRNAME || name === NIKKE_CACHE_DIRNAME_LEGACY
}

export function isNikkeCacheRel(rel) {
  const r = String(rel || '').split(path.sep).join('/')
  return (
    r === NIKKE_CACHE_DIRNAME || r.startsWith(NIKKE_CACHE_DIRNAME + '/') ||
    r.includes('/' + NIKKE_CACHE_DIRNAME + '/') ||
    r === NIKKE_CACHE_DIRNAME_LEGACY || r.startsWith(NIKKE_CACHE_DIRNAME_LEGACY + '/') ||
    r.includes('/' + NIKKE_CACHE_DIRNAME_LEGACY + '/')
  )
}

/** 旧版带前导点的缓存目录改名成新版（Android WebView 加载不了 /.dot/ 路径）。 */
export function migrateLegacyNikkeCache(rootPath) {
  const legacy = path.join(rootPath, NIKKE_CACHE_DIRNAME_LEGACY)
  const modern = path.join(rootPath, NIKKE_CACHE_DIRNAME)
  try {
    if (!fs.existsSync(legacy)) return false
    if (fs.existsSync(modern)) return false
    fs.renameSync(legacy, modern)
    return true
  } catch (e) {
    console.warn('[nikke] legacy cache rename failed:', e.message)
    return false
  }
}

/** 长得像 mod 包的文件名（无扩展名 / .ab / .bundle / .unity3d）；标准件排除在外。 */
export function isNikkeBundleName(name) {
  const l = String(name || '').toLowerCase()
  if (!l || l.startsWith('.')) return false
  if (/\.(atlas|json|skel|png|jpg|jpeg|webp|bytes|txt|md|log|bak)$/i.test(l)) return false
  if (/\.(ab|bundle|unity3d|assets)$/i.test(l)) return true
  return !path.extname(name)          // NIKKE 的 mod 包没有扩展名，靠魔数确认
}

const SKIP_DIRS = new Set([
  NIKKE_CACHE_DIRNAME, NIKKE_CACHE_DIRNAME_LEGACY,
  'bd2viewer-jczx', '.bd2viewer-jczx',
  'node_modules', '.git',
])

/**
 * 找到根目录下所有「像 UnityFS 包」的文件。
 * 只看魔数，不看名字 —— 名字千奇百怪，魔数不会说谎。
 */
export async function findNikkeBundles(rootPath, maxDepth = 5) {
  const out = []
  const walk = async (dir, depth, rel) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        if (isJczxCacheDirName(e.name)) continue
        if (MODE_SOURCE_FOLDERS.has(String(e.name).toLowerCase())
          && path.resolve(dir) !== path.resolve(rootPath)) continue
        await walk(abs, depth + 1, r)
        continue
      }
      if (!e.isFile()) continue
      // 交错战线包（双头 UnityFS / 名字含 prefabs_spine，含 hash 前缀）留给 JCZX 档。
      // 只挡「以 prefabs_spine_ 开头」会把 `hash_prefabs_spine_*` 和双头 .ab 误收进 NIKKE。
      if (nameHintsJczx(e.name)) continue
      if (!isNikkeBundleName(e.name)) continue
      const st = await fsp.stat(abs).catch(() => null)
      if (!st || st.size < 16 * 1024) continue
      if ((await classifyBundleFile(abs)) !== 'nikke') continue
      out.push({ abs, rel: r, size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  await walk(rootPath, 0, '')
  return out
}

/** 缓存布局版本：2 = 每包一文件夹。旧平铺（v1）直接 wipe 重建。 */
export const CACHE_LAYOUT_VERSION = 2

function manifestPath(rootPath) {
  return path.join(rootPath, NIKKE_CACHE_DIRNAME, '.manifest.json')
}

/**
 * 包 → 缓存子文件夹名（需求 6）。用包文件名（去 .ab/.bundle 等），不保留源相对目录，
 * 这样根下平铺的 mod 包各自独立，浏览/挑拣更容易。
 */
export function packFolderOf(rel) {
  const base = String(rel || '').split(/[/\\]/).pop() || 'pack'
  let name = base.replace(/\.(ab|bundle|unity3d|assets)$/i, '')
  if (!name) name = base
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_')
  return name || 'pack'
}

/** @deprecated 旧名；请用 packFolderOf。保留以免外部引用炸。 */
function relDirOf(rel) { return packFolderOf(rel) }

/**
 * 用户删掉源目录（或目录里的源包）时，顺手清掉对应的解包缓存。
 * · 正在删的就是缓存目录本身 → 跳过（外层递归删已覆盖）
 * · 否则：扫源目录下像 NIKKE 包的文件，按 packFolderOf 删 bd2viewer-nikke/<pack>/，
 *   并更新 .manifest.json 里对应条目。
 * 返回已清掉的缓存相对路径列表。
 */
export async function clearNikkeCacheForDeletedDir(rootPath, relDir) {
  const rel = String(relDir || '').split(/[/\\]/).filter(Boolean).join('/')
  if (!rel || isNikkeCacheRel(rel)) return []
  const rootAbs = path.resolve(rootPath)
  const srcAbs = rel ? path.resolve(rootAbs, rel) : rootAbs
  const cleared = []
  const packs = new Set()
  const sourceRels = []

  const walk = async (dir, r) => {
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const rr = r ? r + '/' + e.name : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(abs, rr)
        continue
      }
      if (!e.isFile()) continue
      if (!isNikkeBundleName(e.name) || nameHintsJczx(e.name)) continue
      packs.add(packFolderOf(rr))
      sourceRels.push(rr)
    }
  }
  // 若 rel 指向单个文件（源包本体），也认
  try {
    const st = await fsp.stat(srcAbs)
    if (st.isFile()) {
      const name = path.basename(srcAbs)
      if (isNikkeBundleName(name) && !nameHintsJczx(name)) {
        packs.add(packFolderOf(rel || name))
        sourceRels.push(rel || name)
      }
    } else if (st.isDirectory()) {
      await walk(srcAbs, rel)
    }
  } catch { /* 源已不在也无所谓，仍尝试按前缀清 manifest */ }

  // 也清 manifest 里 source rel 落在被删前缀下的条目（源已先删时 walk 可能空）
  const manifest = await readManifest(rootAbs)
  const prefix = rel ? rel.replace(/\/+$/, '') + '/' : ''
  for (const k of Object.keys(manifest.items || {})) {
    const kk = String(k).split(/[/\\]/).join('/')
    if (!rel || kk === rel || (prefix && kk.startsWith(prefix))) {
      packs.add(packFolderOf(kk))
      if (!sourceRels.includes(kk)) sourceRels.push(kk)
    }
  }

  for (const pack of packs) {
    const dir = path.join(rootAbs, NIKKE_CACHE_DIRNAME, pack)
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    cleared.push(NIKKE_CACHE_DIRNAME + '/' + pack)
  }
  let dirty = false
  for (const k of sourceRels) {
    if (manifest.items && manifest.items[k] != null) {
      delete manifest.items[k]
      dirty = true
    }
  }
  // 也被删目录前缀覆盖的条目
  if (manifest.items) {
    for (const k of Object.keys(manifest.items)) {
      const kk = String(k).split(/[/\\]/).join('/')
      if (rel && (kk === rel || kk.startsWith(prefix))) {
        delete manifest.items[k]
        dirty = true
      }
    }
  }
  if (dirty) {
    await fsp.mkdir(path.join(rootAbs, NIKKE_CACHE_DIRNAME), { recursive: true }).catch(() => {})
    await fsp.writeFile(manifestPath(rootAbs), JSON.stringify(manifest, null, 1), 'utf8').catch(() => {})
  }
  return cleared
}

async function readManifest(rootPath) {
  try {
    const txt = await fsp.readFile(manifestPath(rootPath), 'utf8')
    const j = JSON.parse(txt)
    if (j && typeof j === 'object' && j.items && typeof j.items === 'object') return j
  } catch { /* 首次或损坏 */ }
  return { version: CACHE_LAYOUT_VERSION, items: {} }
}

async function writeLayoutMarker(cacheRoot) {
  try {
    await fsp.mkdir(cacheRoot, { recursive: true })
    const p = path.join(cacheRoot, '.layout.json')
    await fsp.writeFile(p, JSON.stringify({ version: CACHE_LAYOUT_VERSION }, null, 1), 'utf8')
  } catch { /* ignore */ }
}

/** 读 layout 版本：优先 .layout.json，其次 manifest.version；有包文件夹无松散文件则视为已是 v2。 */
async function detectLayoutVersion(cacheRoot) {
  try {
    const layoutTxt = await fsp.readFile(path.join(cacheRoot, '.layout.json'), 'utf8')
    const j = JSON.parse(layoutTxt)
    if (j && typeof j.version === 'number') return j.version
  } catch { /* */ }
  try {
    const man = JSON.parse(await fsp.readFile(path.join(cacheRoot, '.manifest.json'), 'utf8'))
    if (man && typeof man.version === 'number') return man.version
  } catch { /* */ }
  // 启发式：顶层只有子目录（+点文件）→ 已是每包一文件夹
  try {
    const entries = await fsp.readdir(cacheRoot, { withFileTypes: true })
    let hasDir = false
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) { hasDir = true; continue }
      if (/\.(atlas|skel|png)$/i.test(e.name)) return 1  // 明确平铺
      if (/\.(json)$/i.test(e.name)) return 1
    }
    if (hasDir) return CACHE_LAYOUT_VERSION
  } catch { /* */ }
  return 0
}

/** 顶层若有松散 .atlas/.skel/.png，或 layout version < 2 → 整目录清空。 */
async function wipeFlatOrStaleCache(rootPath) {
  const cacheRoot = path.join(rootPath, NIKKE_CACHE_DIRNAME)
  if (!fs.existsSync(cacheRoot)) return { wiped: false, reason: null }
  let reason = null
  const ver = await detectLayoutVersion(cacheRoot)
  if (ver < CACHE_LAYOUT_VERSION) reason = `layout v${ver} < ${CACHE_LAYOUT_VERSION}`
  if (!reason) {
    try {
      const entries = await fsp.readdir(cacheRoot, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isFile()) continue
        if (e.name.startsWith('.')) continue
        if (/\.(atlas|skel|png|json)$/i.test(e.name)) {
          reason = `flat file: ${e.name}`
          break
        }
      }
    } catch { /* ignore */ }
  }
  if (!reason) {
    await writeLayoutMarker(cacheRoot)
    return { wiped: false, reason: null }
  }
  await fsp.rm(cacheRoot, { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(cacheRoot, { recursive: true })
  const fresh = { version: CACHE_LAYOUT_VERSION, items: {}, wipedAt: new Date().toISOString(), wipeReason: reason }
  await fsp.writeFile(manifestPath(rootPath), JSON.stringify(fresh, null, 1), 'utf8').catch(() => {})
  await writeLayoutMarker(cacheRoot)
  console.warn(`[nikke] cache wipe (layout v${CACHE_LAYOUT_VERSION}): ${reason}`)
  return { wiped: true, reason }
}

function runBatchExtract(py, manifestFile, onLog) {
  return new Promise((resolve) => {
    const args = [EXTRACT_PY, '--batch', manifestFile]
    const child = spawn(py, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env }, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => {
      let report = null
      try { report = JSON.parse(stdout.trim().split('\n').pop()) } catch { /* ignore */ }
      if (onLog && stderr.trim()) onLog(stderr.trim().slice(0, 500))
      resolve({ code, stdout, stderr, report })
    })
    child.on('error', err => resolve({ code: -1, stdout, stderr: String(err), report: null }))
  })
}

/** 抽好的三件套是否还在（被用户手动删过就要重抽）。 */
async function outputsExist(rootPath, rel, outputs) {
  if (!outputs || !outputs.length) return false
  const dir = path.join(rootPath, NIKKE_CACHE_DIRNAME, packFolderOf(rel))
  for (const o of outputs) {
    try {
      const st = await fsp.stat(path.join(dir, o))
      if (!st.isFile() || st.size <= 0) return false
    } catch { return false }
  }
  return true
}

/** 删掉某个包的整份产物文件夹（空目录 / 无 spine 也清掉）。 */
async function removePackOutputs(rootPath, rel) {
  const dir = path.join(rootPath, NIKKE_CACHE_DIRNAME, packFolderOf(rel))
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
}

/* ==========================================================================
 * 需求 1：包级优先级队列，任意时刻同时在解的包 ≤ MAX_CONCURRENT（10）。
 *   · 不打断正在解的包；槽位空出后立刻取最高优先级下一项
 *   · prioritize() 把指定包（及同角色姿势兄弟）抬到队首
 * 需求 2：进度一律来自真实计数（done/total/current）
 * ========================================================================== */
export const MAX_CONCURRENT = 10

/**
 * 常驻 Python worker 池：每个 worker 预 import UnityPy，按行消费任务。
 * 包级并发仍由 pump 的 inFlight ≤ MAX_CONCURRENT 约束；池大小 = 同上限。
 * 避免「每包 spawn 一次 python」的冷启动（UnityPy import 往往比解一个小包还贵）。
 */
class NikkeWorkerPool {
  constructor(py, size) {
    this.py = py
    this.size = Math.max(1, size | 0)
    this.workers = []
    this.idle = []
    this.waiters = []
    this.closed = false
  }
  _spawnOne() {
    const child = spawn(this.py, [EXTRACT_PY, '--worker'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    })
    child._buf = ''
    child._pending = null
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      child._buf += chunk
      let nl
      while ((nl = child._buf.indexOf('\n')) >= 0) {
        const line = child._buf.slice(0, nl).trim()
        child._buf = child._buf.slice(nl + 1)
        if (!line) continue
        const pending = child._pending
        child._pending = null
        if (!pending) continue
        try { pending.resolve(JSON.parse(line)) }
        catch (e) { pending.resolve({ ok: false, error: 'bad worker json: ' + e }) }
        this._release(child)
      }
    })
    child.stderr.on('data', () => { /* keep drain */ })
    child.on('exit', () => {
      this.workers = this.workers.filter(w => w !== child)
      this.idle = this.idle.filter(w => w !== child)
      if (child._pending) {
        const pending = child._pending
        child._pending = null
        pending.resolve({ ok: false, error: 'worker exited' })
      }
    })
    this.workers.push(child)
    return child
  }
  _release(child) {
    if (this.closed || !this.workers.includes(child)) return
    const next = this.waiters.shift()
    if (next) next(child)
    else this.idle.push(child)
  }
  async _acquire() {
    if (this.idle.length) return this.idle.pop()
    if (this.workers.length < this.size) {
      const w = this._spawnOne()
      // 给一点时间让 python 起进程；真正预热在首个 job
      return w
    }
    return new Promise(resolve => this.waiters.push(resolve))
  }
  runJob(item) {
    if (this.closed) return Promise.resolve({ ok: false, error: 'pool closed', rel: item.rel })
    return this._acquire().then(child => new Promise(resolve => {
      child._pending = { resolve }
      try {
        child.stdin.write(JSON.stringify({
          src: item.src || item.abs,
          outDir: item.outDir,
          rel: item.rel,
        }) + '\n')
      } catch (e) {
        child._pending = null
        resolve({ ok: false, error: String(e), rel: item.rel })
        this._release(child)
      }
    }))
  }
  close() {
    this.closed = true
    for (const w of this.workers) {
      try { w.stdin.write('QUIT\n'); w.stdin.end() } catch { /* */ }
      try { w.kill('SIGTERM') } catch { /* */ }
    }
    this.workers = []
    this.idle = []
    this.waiters = []
  }
}

const poolsByPy = new Map()
function getNikkePool(py) {
  let pool = poolsByPy.get(py)
  if (!pool || pool.closed) {
    pool = new NikkeWorkerPool(py, MAX_CONCURRENT) // package-level cap
    poolsByPy.set(py, pool)
  }
  return pool
}

const PRI_HIGH = 1_000_000
const PRI_NORMAL = 0

/** 同角色键：包名 `c010_00_aim_…` / `c022_standing_…` → `c010` / `c022` */
export function nikkeSiblingKey(relOrName) {
  const base = String(relOrName || '').split(/[/\\]/).pop() || ''
  let m = /^(c\d+)/i.exec(base)
  if (m) return m[1].toLowerCase()
  m = /^(.+?)_(?:standing|aim|cover)(?:_|$)/i.exec(base)
  if (m) return m[1].toLowerCase()
  m = /^(.+?)_\d+(?:_|$)/.exec(base)
  if (m) return m[1].toLowerCase()
  return base.toLowerCase()
}

/**
 * 每个 root 一份队列状态。
 * queue 项：{ abs, rel, size, mtimeMs, priority, seq }
 * inFlight: rel → { abs, rel, startedAt }
 */
const rootStates = new Map()
let globalSeq = 0

function getState(rootPath) {
  let st = rootStates.get(rootPath)
  if (!st) {
    st = {
      rootPath,
      queue: [],            // waiting, sorted by priority desc then seq asc
      inFlight: new Map(), // rel → info
      known: new Map(),    // rel → bundle info (latest)
      found: 0,
      reused: 0,
      extracted: 0,        // session totals (this prepare + background)
      failed: 0,
      skippedNoSpine: 0,
      ungated: 0,
      errors: [],
      py: null,
      pumping: false,
      manifest: null,
      listeners: new Set(),
    }
    rootStates.set(rootPath, st)
  }
  return st
}

function sortQueue(st) {
  st.queue.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq))
}

function enqueueOne(st, b, priority) {
  st.known.set(b.rel, b)
  if (st.inFlight.has(b.rel)) {
    // 已在解：不打断，只记下更高优先级标记（完成后无需再排）
    return
  }
  const existing = st.queue.find(x => x.rel === b.rel)
  if (existing) {
    if (priority > existing.priority) existing.priority = priority
    sortQueue(st)
    return
  }
  st.queue.push({
    abs: b.abs, rel: b.rel, size: b.size, mtimeMs: b.mtimeMs,
    priority: priority || PRI_NORMAL, seq: ++globalSeq,
  })
  sortQueue(st)
}

/** 对外：抬高若干包及其同角色姿势兄弟的优先级（不打断 in-flight）。 */
export function prioritizeNikkeUnpack(rootPath, rels = [], { sibling = true } = {}) {
  const st = getState(rootPath)
  const want = new Set((rels || []).map(r => String(r).split(/[/\\]/).join('/')))
  if (sibling) {
    const keys = new Set()
    for (const r of want) keys.add(nikkeSiblingKey(r))
    // 还在 known/queue/inFlight 里、同键的一起抬
    for (const rel of st.known.keys()) {
      if (keys.has(nikkeSiblingKey(rel))) want.add(rel)
    }
    for (const q of st.queue) {
      if (keys.has(nikkeSiblingKey(q.rel))) want.add(q.rel)
    }
    for (const rel of st.inFlight.keys()) {
      if (keys.has(nikkeSiblingKey(rel))) want.add(rel)
    }
  }
  let bumped = 0
  for (const rel of want) {
    const b = st.known.get(rel)
    if (!b) continue
    if (st.inFlight.has(rel)) { bumped++; continue }
    const existing = st.queue.find(x => x.rel === rel)
    if (existing) {
      existing.priority = PRI_HIGH + (++globalSeq)
      bumped++
    } else {
      // 可能刚被扫到但还没入队：直接高优入队
      enqueueOne(st, b, PRI_HIGH + (++globalSeq))
      bumped++
    }
  }
  sortQueue(st)
  pump(st)
  return { bumped, pending: st.queue.length, inFlight: st.inFlight.size, ...progressSnapshot(st) }
}

/** 真实进度快照（需求 2）。 */
export function progressSnapshot(stOrRoot) {
  const st = typeof stOrRoot === 'string' ? getState(stOrRoot) : stOrRoot
  const pending = st.queue.length
  const inFlight = [...st.inFlight.values()].map(x => x.rel)
  const done = st.reused + st.extracted + st.failed + st.skippedNoSpine
  const playableDone = st.reused + st.extracted
  // total = 已处理 + 排队 + 在飞；found 是本轮发现的包数（含已复用）
  const total = Math.max(st.found, done + pending + inFlight.length)
  return {
    found: st.found,
    reused: st.reused,
    extracted: st.extracted,
    failed: st.failed,
    skippedNoSpine: st.skippedNoSpine,
    pending,
    inFlight: inFlight.length,
    current: inFlight.map(r => String(r).split('/').pop()),
    currentRels: inFlight,
    done,
    playableDone,
    total,
    ready: pending === 0 && inFlight.length === 0,
    cacheDir: NIKKE_CACHE_DIRNAME,
    errors: st.errors.slice(0, 8),
    ungated: st.ungated || 0,
    limit: MAX_CONCURRENT,
    // queue + inFlight：占位卡要盖住「正在解」的包（与 prepare 末尾一致）
    pendingRels: st.queue.map(q => q.rel).concat(inFlight),
  }
}

export function getNikkeUnpackProgress(rootPath) {
  return progressSnapshot(getState(rootPath))
}

function notify(st) {
  const snap = progressSnapshot(st)
  for (const fn of st.listeners) {
    try { fn(snap) } catch { /* ignore */ }
  }
}

async function pump(st) {
  if (st.pumping) return
  st.pumping = true
  try {
    while (st.inFlight.size < MAX_CONCURRENT && st.queue.length) {
      const job = st.queue.shift()
      if (!job) break
      if (st.inFlight.has(job.rel)) continue
      st.inFlight.set(job.rel, { abs: job.abs, rel: job.rel, startedAt: Date.now() })
      // 不 await：并发拉满到 MAX_CONCURRENT
      runOne(st, job).catch(() => {}).finally(() => {
        st.inFlight.delete(job.rel)
        notify(st)
        // 槽位空出 → 继续取最高优先级
        pump(st)
      })
    }
  } finally {
    st.pumping = false
  }
  notify(st)
}

async function runOne(st, job) {
  const rootPath = st.rootPath
  if (!st.py) return
  if (!st.manifest) st.manifest = await readManifest(rootPath)
  const meta = { extracted: 0, reused: 0, failed: 0, skippedNoSpine: 0, errors: [], ungated: 0 }
  await extractChunk(rootPath, st.py, [job], st.manifest, meta, null)
  st.extracted += meta.extracted
  st.failed += meta.failed
  st.skippedNoSpine += meta.skippedNoSpine
  st.ungated = (st.ungated || 0) + (meta.ungated || 0)
  for (const e of meta.errors || []) {
    if (st.errors.length < 12) st.errors.push(e)
  }
  try {
    await fsp.writeFile(manifestPath(rootPath), JSON.stringify(st.manifest), 'utf8')
  } catch { /* ignore */ }
}

/**
 * 把一个根目录下的 NIKKE mod 包排进优先级队列并开始解包。
 *
 * 返回策略（不阻塞 gallery）：
 *   · 已复用的立刻计入（bd2viewer-nikke/ 与手动目录由随后的 walk 立刻列出）
 *   · 待解的全部入队（priority=NORMAL），开泵，并发 ≤ 10
 *   · **不等**首波解包——旧 initialWaitMs(~12s) 会挡住 scan 返回，用户空等
 *   · meta 带真实 done/total/current；pendingRels 含 queue+inFlight 供占位卡
 *   · initialWaitMs 保留参数兼容，已忽略
 */
export async function prepareNikkeRoot(rootPath, {
  maxDepth = 5, python, autoSetup = true, onLog, maxItems, // maxItems 保留兼容，忽略（改由并发模型接管）
  initialWaitMs = 0, // 兼容旧调用；不再同步等待
} = {}) {
  const started = Date.now()
  const st = getState(rootPath)
  // 轮询 force-scan 会反复进来：队列还在跑时跳过全量 findBundles/stamp 检查（昂贵）
  const busy = st.queue.length > 0 || st.inFlight.size > 0
  if (busy && st.found > 0 && st.lastFullPrepareAt && (Date.now() - st.lastFullPrepareAt) < 20000) {
    const snap = progressSnapshot(st)
    if (onLog) onLog(`[nikke] prepare skip (queue busy): done=${snap.done}/${snap.total}`)
    return { ...snap, ms: Date.now() - started, python: st.py, skippedRescan: true }
  }
  migrateLegacyNikkeCache(rootPath)
  const wipe = await wipeFlatOrStaleCache(rootPath)
  if (wipe.wiped) {
    // 旧平铺缓存作废：清空本 root 的队列状态，强制全量重解
    st.queue = []
    st.inFlight.clear()
    st.known.clear()
    st.manifest = null
  }
  // 新一轮 full prepare：清计数（保留仍在飞/已排队的 job）
  st.reused = 0
  st.extracted = 0
  st.failed = 0
  st.skippedNoSpine = 0
  st.errors = []
  st.ungated = 0
  // 新一轮 prepare：保留 in-flight / 已排队项，只刷新 found / known
  const meta = {
    found: 0, extracted: 0, reused: 0, failed: 0, skippedNoSpine: 0, pending: 0,
    cacheDir: NIKKE_CACHE_DIRNAME, ms: 0, errors: [], python: python || null,
    ready: false, limit: MAX_CONCURRENT, current: [], pendingRels: [],
  }

  let bundles = []
  try {
    bundles = await findNikkeBundles(rootPath, maxDepth)
  } catch (e) {
    meta.errors.push({ err: 'find failed: ' + e.message })
    meta.ms = Date.now() - started
    return meta
  }
  st.found = bundles.length
  meta.found = bundles.length
  if (!bundles.length) {
    meta.ready = true
    meta.ms = Date.now() - started
    return meta
  }

  const manifest = await readManifest(rootPath)
  st.manifest = manifest
  const todo = []
  let reused = 0
  const seenFp = new Set()
  let skippedDup = 0
  for (const b of bundles) {
    let fp = null
    try { fp = await packFingerprint(b.abs, b.size) } catch { /* */ }
    if (fp && seenFp.has(fp)) {
      skippedDup++
      continue
    }
    if (fp) seenFp.add(fp)
    b.fp = fp
    st.known.set(b.rel, b)
    const prev = manifest.items[b.rel]
    if (prev && prev.size === b.size && prev.mtimeMs === b.mtimeMs && prev.ok) {
      if (await outputsExist(rootPath, b.rel, prev.outputs)) { reused++; continue }
    }
    // Also skip enqueue if another rel already extracted same fingerprint
    if (fp) {
      let dupDone = false
      for (const [orel, prevItem] of Object.entries(manifest.items)) {
        if (orel === b.rel || !prevItem || !prevItem.ok || prevItem.fp !== fp) continue
        if (await outputsExist(rootPath, orel, prevItem.outputs)) { dupDone = true; break }
      }
      if (dupDone) { reused++; skippedDup++; continue }
    }
    todo.push(b)
  }
  if (skippedDup && onLog) onLog(`[nikke] dedupe skipped ${skippedDup} duplicate pack(s)`)
  meta.skippedDup = skippedDup
  st.reused = reused
  meta.reused = reused

  // 源文件没了 → 连带清掉整份包文件夹（需求 6：outDir = 包名文件夹）
  const live = new Set(bundles.map(b => b.rel))
  for (const rel of Object.keys(manifest.items)) {
    if (live.has(rel)) continue
    await removePackOutputs(rootPath, rel)
    delete manifest.items[rel]
    st.queue = st.queue.filter(q => q.rel !== rel)
    st.known.delete(rel)
  }
  manifest.version = CACHE_LAYOUT_VERSION

  if (todo.length) {
    const py = await resolvePy(python, autoSetup, onLog, meta)
    if (!py) { meta.ms = Date.now() - started; return { ...meta, ...progressSnapshot(st) } }
    st.py = py
    meta.python = py

    for (const b of todo) enqueueOne(st, b, PRI_NORMAL)
    pump(st)
    // 立即返回：scan/walk 马上列出已就绪资产；pending 由 progress 轮询 + 占位卡承接
    void initialWaitMs
  }

  try {
    await fsp.writeFile(manifestPath(rootPath), JSON.stringify(manifest, null, 1), 'utf8')
  } catch (e) {
    meta.errors.push({ err: 'manifest write failed: ' + e.message })
  }
  await writeLayoutMarker(path.join(rootPath, NIKKE_CACHE_DIRNAME))

  const snap = progressSnapshot(st)
  Object.assign(meta, snap)
  meta.extracted = st.extracted
  meta.failed = st.failed
  meta.skippedNoSpine = st.skippedNoSpine
  meta.pendingRels = st.queue.map(q => q.rel).concat([...st.inFlight.keys()])
  meta.ms = Date.now() - started
  if (meta.errors.length > 8) meta.errors = meta.errors.slice(0, 8)
  st.lastFullPrepareAt = Date.now()
  if (onLog) onLog(`[nikke] queue: done=${snap.done}/${snap.total} inFlight=${snap.inFlight} pending=${snap.pending}`)
  return meta
}

/** 找可用 python（复用 JCZX 的解析 / 自动建 venv）；失败时把原因写进 meta。 */
async function resolvePy(python, autoSetup, onLog, meta) {
  if (python) return python
  try {
    const ensured = await ensureJczxPython({ autoSetup, onLog })
    if (!ensured.probe?.ok) {
      meta.errors.push({ err: 'no python with UnityPy', python: ensured.python, setup: ensured.setup || null })
      return null
    }
    return ensured.python
  } catch (e) {
    meta.errors.push({ err: 'python setup failed: ' + e.message })
    return null
  }
}

/**
 * 抽一批：包级并发由上层 pump 控制；这里每次只应收到少量 items（通常 1 个）。
 * 兼容旧调用：若误传入很多项，也只开 1 个 python 进程顺序处理（不再拆 4 worker）。
 */
async function extractChunk(rootPath, py, items, manifest, meta, onLog) {
  if (!items || !items.length) return
  const cacheRoot = path.join(rootPath, NIKKE_CACHE_DIRNAME)
  await fsp.mkdir(cacheRoot, { recursive: true })
  const pool = getNikkePool(py)

  // 常驻 worker：每包一行 JSON，无反复 spawn；包级并发仍由上层 inFlight 控制
  const results = await Promise.all(items.map(async (b) => {
    const outDir = path.join(cacheRoot, packFolderOf(b.rel))
    const r = await pool.runJob({ abs: b.abs, src: b.abs, rel: b.rel, outDir })
    return { b, r }
  }))

  for (const { b, r } of results) {
    if (!r) {
      meta.failed++
      meta.errors.push({ rel: b.rel, err: 'no report from worker' })
      continue
    }
    const packFolder = packFolderOf(b.rel)
    const outputs = (r.exported || []).map(x => ({ ...x, dir: packFolder }))
    const names = outputs.map(x => x.name)
    if (r.ok) {
      manifest.items[b.rel] = {
        size: b.size, mtimeMs: b.mtimeMs, ok: true, outputs: names,
        outDir: packFolder,
        fp: b.fp || null,
        spine: (outputs.find(x => x.kind === 'skel' || x.kind === 'json') || {}).spine || null,
        at: new Date().toISOString(),
      }
      meta.extracted++
    } else {
      const noSpine = !(r.exported || []).some(x => x.kind === 'atlas')
      if (noSpine) meta.skippedNoSpine++
      else meta.failed++
      await removePackOutputs(rootPath, b.rel)
      manifest.items[b.rel] = {
        size: b.size, mtimeMs: b.mtimeMs, ok: false, outputs: [],
        outDir: packFolder,
        reason: r.error || (noSpine ? 'no spine atlas in bundle' : 'incomplete spine set'),
        at: new Date().toISOString(),
      }
      if (!noSpine) {
        meta.errors.push({
          rel: b.rel,
          err: r.error || 'incomplete spine set',
          got: (r.exported || []).map(x => x.kind).join('+'),
        })
      }
    }
    if ((r.errors || []).length) {
      meta.errors.push({ rel: b.rel, err: r.errors[0].err, type: r.errors[0].type })
    }
  }
  void onLog
}

/** 单个包（拖入 / 上传）立即提取；供 /api/nikke-ab/ingest 用。 */
export async function ensureNikkeExtracted(abAbs, rootPath, { python, autoSetup = true, onLog } = {}) {
  const rel = path.relative(rootPath, abAbs).split(path.sep).join('/')
  const st = await fsp.stat(abAbs)
  migrateLegacyNikkeCache(rootPath)
  await wipeFlatOrStaleCache(rootPath)
  const cacheRoot = path.join(rootPath, NIKKE_CACHE_DIRNAME)
  const outDir = path.join(cacheRoot, packFolderOf(rel))
  await fsp.mkdir(outDir, { recursive: true })

  let py = python
  if (!py) {
    const ensured = await ensureJczxPython({ autoSetup, onLog })
    py = ensured.python
    if (!ensured.probe?.ok) throw new Error('未找到带 UnityPy 的 Python（见 setup_jczx.bat）')
  }
  const manifestFile = path.join(cacheRoot, '.batch.json')
  await fsp.writeFile(manifestFile, JSON.stringify({ items: [{ src: abAbs, rel, outDir }] }), 'utf8')
  const { code, report } = await runBatchExtract(py, manifestFile, onLog)
  await fsp.rm(manifestFile, { force: true }).catch(() => {})
  const item = report && report.items && report.items[0]
  if (!item || !item.ok) {
    await removePackOutputs(rootPath, rel)
    const err = (item && item.error) || `extract exit ${code}`
    const e = new Error(`NIKKE 包提取失败：${path.basename(abAbs)} — ${err}`)
    e.report = item || null
    throw e
  }
  const manifest = await readManifest(rootPath)
  manifest.version = CACHE_LAYOUT_VERSION
  manifest.items[rel] = {
    size: st.size, mtimeMs: st.mtimeMs, ok: true,
    outputs: (item.exported || []).map(x => x.name),
    outDir: packFolderOf(rel),
    at: new Date().toISOString(),
  }
  await fsp.writeFile(manifestPath(rootPath), JSON.stringify(manifest, null, 1), 'utf8')
  await writeLayoutMarker(cacheRoot)
  return { outDir, report: item }
}
