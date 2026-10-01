#!/usr/bin/env node
/**
 * BD2 Local L2D (Spine) Viewer - local server
 *
 * 职责：
 *   1. 静态托管前端（public/）与两个第三方库（node_modules 里的 IIFE 构建）
 *   2. 扫描配置的本地根目录，找出所有 Spine 资产组（.atlas + .json/.skel + 引用的 .png）
 *   3. 通过 /asset 把本地文件喂给浏览器（浏览器无法直接读 file:// 之外的本地文件）
 *
 * 只监听 127.0.0.1，只允许读取配置里 roots 声明过的目录。
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import {
  JCZX_CACHE_DIRNAME,
  JCZX_CACHE_DIRNAME_LEGACY,
  isJczxCacheDirName,
  isJczxCacheRel,
  prepareJczxRoot,
  ensureJczxExtracted,
  isJczxName,
  looksLikeUnityFS,
} from './jczx_support.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
// 测试可以指向自己的配置（配一个临时根目录），这样「真删文件」的用例
// 永远不会碰用户的真实 mods 目录。见 _test/delete_api.mjs。
const CONFIG_PATH = process.env.BD2_CONFIG
  ? path.resolve(process.env.BD2_CONFIG)
  : path.join(__dirname, 'viewer.config.json')
const NM = path.join(__dirname, 'node_modules')

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 8137,
  maxDepth: 5,
  roots: [],
}

// 前端有两个第三方库文件（Spine 运行时是两套，见 app.js 的 R16 说明）。
// 优先用项目自带的 public/lib（已经把官方发行版放进去），
// 找不到再退回 node_modules（如果用户执行过 npm install）。
function resolveLib(route) {
  const name = path.basename(route)
  const bundled = path.join(PUBLIC_DIR, 'lib', name)
  if (fs.existsSync(bundled)) return bundled
  const fromNodeModules = {
    'spine-player.js': path.join(NM, '@esotericsoftware/spine-player', 'dist', 'iife', 'spine-player.js'),
    // 4.0 那份同理：装了 4.0.x 版本的 @esotericsoftware/spine-player 才能从 node_modules 拿到。
    // 注意 npm 一个包名只能装一个版本，想同时拥有两套必须靠 public/lib/ 里的产物文件。
    'spine-player-4.0.js': path.join(NM, '@esotericsoftware/spine-player', 'dist', 'iife', 'spine-player.js'),
    'spine-player-4.2.js': path.join(NM, '@esotericsoftware/spine-player', 'dist', 'iife', 'spine-player.js'),
    'spine-player.css': path.join(NM, '@esotericsoftware/spine-player', 'dist', 'spine-player.css'),
    'jszip.min.js': path.join(NM, 'jszip', 'dist', 'jszip.min.js'),
  }[name]
  return fromNodeModules && fs.existsSync(fromNodeModules) ? fromNodeModules : null
}

const LIB_ROUTES = [
  '/lib/spine-player.js', '/lib/spine-player-4.0.js', '/lib/spine-player-4.2.js',
  '/lib/spine-player.css', '/lib/jszip.min.js',
]


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

// ---------------------------------------------------------------- formats

/**
 * 游戏的资产命名约定。
 *
 * 为什么要有这一层：不同游戏（甚至同一游戏的不同导出工具）给同一批 Spine 文件起的
 * 扩展名不一样。BD2 的 mod 是标准 Spine 导出（`x.atlas` / `x.skel` / `x.json`），
 * 而 Lost Sword 是 Unity TextAsset 导出，多套了一层 `.bytes`
 * （`x.atlas.bytes` / `x.skel.bytes`，JSON 骨架干脆叫裸 `x.bytes`）。
 *
 * **判据只写在这里，不要散进 walk()** —— 加第三种游戏时只加一条 format，
 * 扫描主流程一行不用动。前后端与 Android 侧都遵循同一套 `classify()` 语义。
 *
 * `classify(name)` 返回 `null`（这个文件不参与资产识别）或：
 *   `{ role: 'atlas'|'skeleton'|'image'|'thumb', base?, kind? }`
 * 其中 `base` 是**资产的基名**（同名匹配用），`kind` 只对 skeleton 有意义
 * （`'json'` 走 spine-player 的 `jsonUrl`，`'skel'` 走 `binaryUrl`）。
 */

const IMG_RE = /\.(png|jpg|jpeg|webp)$/i

/** 去掉重名的 `.atlas` / `.skel` 中缀，拿到资产基名。 */
function stripAtlasBytes(name) {
  return name.slice(0, -'.atlas.bytes'.length)
}
function stripSkelBytes(name) {
  return name.slice(0, -'.skel.bytes'.length)
}

const FORMATS = {
  /**
   * BD2 / 标准 Spine 导出。
   * `illust.atlas` + `illust.json`（或 `illust.skel`）+ `illust.png`
   */
  bd: {
    id: 'bd',
    classify(name) {
      const l = name.toLowerCase()
      if (l.endsWith('.atlas')) return { role: 'atlas', base: name.slice(0, -'.atlas'.length) }
      if (l.endsWith('.skel')) return { role: 'skeleton', base: name.slice(0, -'.skel'.length), kind: 'skel' }
      if (l.endsWith('.json')) return { role: 'skeleton', base: name.slice(0, -'.json'.length), kind: 'json' }
      if (IMG_RE.test(name)) return { role: 'image' }
      return null
    },
  },

  /**
   * Lost Sword / Unity TextAsset 导出。
   * `Agravaine.atlas.bytes` + `Agravaine.skel.bytes`（二进制 4.1）
   * 或 `beirin.bytes`（JSON 骨架，裸 .bytes）+ 同目录 `*.png`。
   * 目录里常带一张预算好的 `thumb.png`。
   *
   * 注意 `x.atlas.bytes` / `x.skel.bytes` 必须先于裸 `.bytes` 判断 ——
   * 否则 `path.extname` 只能看到最后一段 `.bytes`，基名会算成 `x.atlas`。
   */
  lostsword: {
    id: 'lostsword',
    classify(name) {
      const l = name.toLowerCase()
      if (l.endsWith('.atlas.bytes')) return { role: 'atlas', base: stripAtlasBytes(name) }
      if (l.endsWith('.skel.bytes')) return { role: 'skeleton', base: stripSkelBytes(name), kind: 'skel' }
      if (l.endsWith('.bytes')) return { role: 'skeleton', base: name.slice(0, -'.bytes'.length), kind: 'json' }
      if (l === 'thumb.png') return { role: 'thumb' }
      if (IMG_RE.test(name)) return { role: 'image' }
      return null
    },
  },

  /**
   * NIKKE。文件命名与 BD2 完全一样（`c022_00.atlas` + `c022_00.skel` + `c022_00.png`），
   * 所以归桶规则就是 bd 那一套（classify 直接复用）。它和 bd 的差别在**前端怎么组织**：
   * 同一角色的 `<id>_00`（本体）与 `<id>_aim_00` / `<id>_cover_00`（瞄准/掩体姿势）
   * 归成一套资产，播放页里切姿势 —— 分组逻辑在 app.js（一处实现，见 R18），
   * 这里只负责让 `mode=nikke` 拥有独立的扫描缓存与独立的模式档位。
   * 骨架多为 Spine 4.0.x；扫描仍读骨架头写入 spineMinor（给前端选 4.0/4.1 运行时，见 R16），
   * **不再**按世代丢掉条目——产品不要求跨模式完美隔离，各模式在对应素材在场时能正确查看即可。
   */
  nikke: {
    id: 'nikke',
    classify(name) { return FORMATS.bd.classify(name) },
  },

  /**
   * 交错战线（JCZX）。源文件是 Unity AssetBundle（双 UnityFS 头），
   * 扫描前由 jczx_support 抽到根目录 `bd2viewer-jczx/` 下的标准
   * `.atlas` + `.json` + `.png`，再按 bd 规则归桶。骨架多为 Spine 4.2.x。
   */
  jczx: {
    id: 'jczx',
    classify(name) { return FORMATS.bd.classify(name) },
  },
}

const DEFAULT_FORMAT = 'bd'

function formatOf(id) {
  return FORMATS[id] || FORMATS[DEFAULT_FORMAT]
}

/**
 * 从二进制骨架文件头读出 minor（'4.0' / '4.1'）。
 * 布局：8 字节 hash → 1 字节长度 → "4.x.y\0"。读前 32 字节足够。
 * JSON 骨架（.json / 裸 .bytes）不读文件，返回 null（按 4.1 线处理）。
 */
function spineMinorFromHead(buf) {
  if (!buf || !buf.length) return null
  let text = ''
  const n = Math.min(buf.length, 32)
  for (let i = 0; i < n; i++) text += String.fromCharCode(buf[i])
  const m = /4\.(\d)\.\d+/.exec(text)
  return m ? `4.${m[1]}` : null
}

async function spineMinorOfFile(absPath, kind) {
  try {
    const fh = await fsp.open(absPath, 'r')
    try {
      // JSON 骨架（含 JCZX 抽出的 4.2）：读头几 KB 找 "spine":"4.x
      if (kind === 'json') {
        const buf = Buffer.alloc(4096)
        const { bytesRead } = await fh.read(buf, 0, 4096, 0)
        const text = buf.subarray(0, bytesRead).toString('utf8')
        const m = /"spine"\s*:\s*"4\.(\d)\./.exec(text)
        return m ? `4.${m[1]}` : null
      }
      if (kind !== 'skel') return null
      const buf = Buffer.alloc(32)
      const { bytesRead } = await fh.read(buf, 0, 32, 0)
      return spineMinorFromHead(buf.subarray(0, bytesRead))
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/**
 * 从候选骨架里挑出与 atlas 配对的那个。
 *
 * 三级级联，越靠前越可信（实测 Lost Sword 的 430 套里 429 套命中第一级）：
 *   ① 基名精确相同 —— `Agravaine.atlas.bytes` ↔ `Agravaine.skel.bytes`
 *   ② 骨架基名是 atlas 基名的前缀（取最长者）——
 *      处理 `skull_Soldier_Green.atlas.bytes` ↔ `skull_Soldier.skel.bytes`
 *   ③ 目录里只有一个候选 —— 兜底，仅在① ② 都落空时用（目录里有多个候选时宁可报缺骨架）
 *
 * 为什么不能只用③：实测有 40 个目录里放着 2~3 个骨架，随便挑一个会张冠李戴。
 */
function pickSkeleton(cands, base) {
  if (!cands.length) return null
  const exact = cands.find(c => c.base === base)
  if (exact) return exact
  const prefixed = cands
    .filter(c => c.base && base.startsWith(c.base))
    .sort((a, b) => b.base.length - a.base.length)
  if (prefixed.length) return prefixed[0]
  return cands.length === 1 ? cands[0] : null
}

// ---------------------------------------------------------------- config

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(stripBom(raw))
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      roots: Array.isArray(parsed.roots) ? parsed.roots.filter(r => r && r.path) : [],
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[config] 读取 viewer.config.json 失败：${err.message}`)
    }
    return { ...DEFAULT_CONFIG }
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

let config = loadConfig()

async function saveConfig() {
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}

function rootById(id) {
  return config.roots.find(r => r.id === id) || null
}

/** 判断绝对路径是否落在某个已授权的根目录内（防目录穿越） */
function isAuthorized(absPath) {
  const resolved = path.resolve(absPath)
  return config.roots.some(r => {
    const rootAbs = path.resolve(r.path)
    const rel = path.relative(rootAbs, resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

// ---------------------------------------------------------------- scanning

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '$recycle.bin'])

async function listDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 文件修改时间（毫秒）；拿不到就返回 0 */
async function mtimeOf(file) {
  try { return Math.round((await fsp.stat(file)).mtimeMs) } catch { return 0 }
}

/** 从 atlas 文本里提取所有页（page）图片名。Atlas 里每一页的头部就是单独一行的文件名。 */
function parseAtlasPages(atlasText) {
  const pages = []
  for (const rawLine of atlasText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.includes(':') || line.includes(' ')) continue
    if (/\.(png|jpg|jpeg|webp)$/i.test(line)) pages.push(line)
  }
  return [...new Set(pages)]
}

async function walk(dir, depth, maxDepth, out, rootPath, fmt) {
  if (depth > maxDepth) return
  const entries = await listDir(dir)

  // 按「资产角色」归类，而不是按扩展名 —— 扩展名的差异已经被 fmt.classify 吃掉了。
  // 这正是支持第二种游戏命名的关键：主流程只认角色，不认扩展名。
  const atlases = []      // [{ name, base }]
  const skeletons = []    // [{ name, base, kind }]
  const images = []       // [name]
  let thumb = null        // 预算好的缩略图文件名（Lost Sword 的 thumb.png）
  const subdirs = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
      // JCZX 提取缓存只在 jczx 模式下可见，其它模式扫到会串味
      if (isJczxCacheDirName(entry.name) && fmt.id !== 'jczx') continue
      subdirs.push(path.join(dir, entry.name))
      continue
    }
    if (!entry.isFile()) continue
    const c = fmt.classify(entry.name)
    if (!c) continue
    if (c.role === 'atlas') atlases.push({ name: entry.name, base: c.base })
    else if (c.role === 'skeleton') skeletons.push({ name: entry.name, base: c.base, kind: c.kind })
    else if (c.role === 'thumb') thumb = entry.name
    else if (c.role === 'image') images.push(entry.name)
  }

  for (const atlas of atlases) {
    const base = atlas.base
    const atlasName = atlas.name
    const skel = pickSkeleton(skeletons, base)

    let pages = []
    try {
      const text = stripBom(await fsp.readFile(path.join(dir, atlasName), 'utf-8'))
      pages = parseAtlasPages(text)
    } catch {
      /* 读不了就退回同目录同名 png */
    }

    if (pages.length === 0) {
      // 兜底：按基名前缀猜。注意排除预算好的 thumb.png，
      // 否则「Agravaine」这种基名会把 thumb 当成图集页（实测 Lost Sword 有这个坑）。
      const guess = images.filter(
        n => n !== thumb && path.basename(n, path.extname(n)).startsWith(base),
      )
      pages = guess.length ? guess : images.filter(n => n !== thumb).slice(0, 1)
    }

    const found_ = []
    const missing = []
    for (const page of pages) {
      const hit = images.find(n => n === page) ||
        images.find(n => path.basename(n) === path.basename(page))
      if (hit) found_.push(hit)
      else missing.push(page)
    }

    const relOf = (name) => path.relative(rootPath, path.join(dir, name)).split(path.sep).join('/')
    const relAtlas = relOf(atlasName)
    // 分组用相对根目录的第一段（顶层文件夹）；直接放在根目录里的归到「（根目录）」
    const group = relAtlas.includes('/') ? relAtlas.split('/')[0] : '（根目录）'

    const spineMinor = skel
      ? await spineMinorOfFile(path.join(dir, skel.name), skel.kind)
      : null
    out.push({
      id: relAtlas,
      dir,
      group,
      folder: path.basename(dir),
      base,
      atlas: atlasName,
      relAtlas,
      relSkeleton: skel ? relOf(skel.name) : null,
      skeleton: skel ? skel.name : null,
      skeletonKind: skel ? skel.kind : null,
      spineMinor,
      images: found_,
      relImages: found_.map(relOf),
      // 预算好的缩略图（Lost Sword 的 thumb.png）。有的话前端直接取，不用离屏渲染。
      relThumb: thumb ? relOf(thumb) : null,
      missingImages: missing,
      ok: !!skel && found_.length > 0 && missing.length === 0,
      // 文件改动时间：前端用它决定缩略图缓存要不要失效
      mtime: await mtimeOf(path.join(dir, atlasName)),
      problems: [
        ...(skel ? [] : ['缺少骨架文件']),
        ...(found_.length ? [] : ['缺少贴图 .png']),
      ],
    })
  }

  for (const sub of subdirs) {
    await walk(sub, depth + 1, maxDepth, out, rootPath, fmt)
  }
}

const scanCache = new Map() // rootId -> { time, payload }

// APK 里自动目录的 id 都以 __ 开头（__public__ 外部存储根目录 / __default__ App 目录）。
// 桌面服务为了能跑同一条代码路径，把它们都映射到第一个已配置根目录。
function resolveRootId(id) {
  if (typeof id === 'string' && id.startsWith('__') && config.roots.length) return config.roots[0].id
  return id
}

/**
 * 扫描一个根目录。
 *
 * `mode` 决定用哪套命名约定（见 FORMATS）。它必须参与**缓存键** ——
 * 否则「切到 Lost Sword 模式再切回来」会拿到另一种约定的旧结果，
 * 表现为「切了没反应」。这是全局单一切换方案下最容易漏的一处。
 */
async function scanRoot(root, force = false, mode = DEFAULT_FORMAT) {
  const fmt = formatOf(mode)
  const cacheKey = `${root.id}|${fmt.id}`
  const cached = scanCache.get(cacheKey)
  if (!force && cached && Date.now() - cached.time < 15000) return cached.payload

  const t0 = Date.now()
  const items = []
  const exists = fs.existsSync(root.path)
  let jczxMeta = null
  if (exists) {
    // JCZX：先把根下双 UnityFS AB 抽到 `bd2viewer-jczx/`，再按 bd 规则扫
    if (fmt.id === 'jczx') {
      jczxMeta = await prepareJczxRoot(root.path, {
        maxDepth: config.maxDepth || 5,
        autoSetup: true,
      })
    }
    await walk(root.path, 0, config.maxDepth || 5, items, root.path, fmt)
    // jczx 模式下只保留缓存目录里抽出的条目（避免误认其它命名）
    if (fmt.id === 'jczx') {
      for (let i = items.length - 1; i >= 0; i--) {
        const rel = String(items[i].relAtlas || '').replace(/\\/g, '/')
        if (!isJczxCacheRel(rel)) items.splice(i, 1)
      }
    }
  }

  items.sort((a, b) => {
    const ga = a.group.toLowerCase()
    const gb = b.group.toLowerCase()
    if (ga !== gb) return ga.localeCompare(gb)
    return a.folder.localeCompare(b.folder) || a.base.localeCompare(b.base)
  })

  const payload = {
    root: { id: root.id, label: root.label, path: root.path },
    mode: fmt.id,
    exists,
    itemCount: items.length,
    playableCount: items.filter(i => i.ok).length,
    scanMs: Date.now() - t0,
    items,
    ...(jczxMeta ? { jczx: jczxMeta } : {}),
  }
  scanCache.set(cacheKey, { time: Date.now(), payload })
  return payload
}

/** 根目录删/改之后要把两种约定的缓存都清掉，否则另一种模式还留着旧列表 */
function invalidateScanCache(rootId) {
  for (const key of [...scanCache.keys()]) {
    if (key === rootId || key.startsWith(`${rootId}|`)) scanCache.delete(key)
  }
}

// ---------------------------------------------------------------- helpers

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' })
}

/**
 * Content-Type。
 *
 * 必须看**完整文件名**而不只是 extname：Lost Sword 的 `x.atlas.bytes` 是纯文本 atlas，
 * 而 `x.skel.bytes` / `x.bytes` 是二进制（或 JSON）骨架 —— 三个都是 `.bytes` 结尾。
 * 一律按 extname 走会把 atlas 也发成 octet-stream，前端确实还能读，
 * 但那属于「靠运气」，`<link>` / 预检 之类的场景会翻车。
 */
function contentTypeFor(filePath) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.atlas.bytes')) return 'text/plain; charset=utf-8'
  if (lower.endsWith('.bytes')) return 'application/octet-stream'
  return MIME[path.extname(lower)] || 'application/octet-stream'
}

async function streamFile(res, absPath, { allowOutside = false } = {}) {
  if (!allowOutside && !isAuthorized(absPath)) {
    sendJson(res, 403, { error: '路径不在已授权的根目录内', path: absPath })
    return
  }
  let stat
  try {
    stat = await fsp.stat(absPath)
  } catch {
    sendJson(res, 404, { error: '文件不存在', path: absPath })
    return
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: '不是文件', path: absPath })
    return
  }
  res.writeHead(200, {
    'Content-Type': contentTypeFor(absPath),
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  fs.createReadStream(absPath)
    .on('error', () => res.destroy())
    .pipe(res)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/**
 * 删除一整套资产：atlas + skeleton + 它引用的贴图，最后顺手清掉空目录。
 * 只认相对路径，而且每一条都要过 isAuthorized —— 别让前端传来的 ../ 越界。
 *
 * 这是**不可恢复**的操作。调用方（前端）负责弹二次确认并列出待删文件，
 * 这里只做「照单执行 + 如实回报」：逐条删，失败的不影响其它条。
 */
function deleteItems(root, items) {
  const deleted = []
  const failed = []
  const touchedDirs = []
  const rootAbs = path.resolve(root.path)

  for (const it of items) {
    // thumb.png 也算这套资产的一部分（它是该资产预算出来的缩略图）。
    // 不删的话目录永远清不掉，removedDirs 里也不会带上这一层。
    const rels = [it.relAtlas, it.relSkeleton, it.relThumb, ...(Array.isArray(it.relImages) ? it.relImages : [])]
      .filter(r => typeof r === 'string' && r.trim())
    if (!rels.length) {
      failed.push({ relAtlas: String(it.relAtlas || ''), reason: '缺少文件路径' })
      continue
    }
    let allGone = true
    for (const rel of rels) {
      const abs = path.resolve(rootAbs, rel)
      if (!isAuthorized(abs)) {
        failed.push({ relAtlas: it.relAtlas, reason: `路径越界，已拒绝：${rel}` })
        allGone = false
        continue
      }
      try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs)
      } catch (err) {
        failed.push({ relAtlas: it.relAtlas, reason: `${rel}：${err.message}` })
        allGone = false
      }
    }
    if (allGone) {
      deleted.push(String(it.relAtlas || rels[0]))
      touchedDirs.push(path.dirname(path.resolve(rootAbs, it.relAtlas || rels[0])))
    }
  }

  // 目录空了就往上删，但绝不越过 root 本身
  const removedDirs = []
  for (const d of [...new Set(touchedDirs)].sort((a, b) => b.length - a.length)) {
    let cur = d
    while (cur && cur !== rootAbs && isAuthorized(cur)) {
      try {
        if (!fs.existsSync(cur) || !fs.statSync(cur).isDirectory()) break
        if (fs.readdirSync(cur).length) break
        fs.rmdirSync(cur)
        removedDirs.push(path.relative(rootAbs, cur) || '.')
      } catch {
        break
      }
      cur = path.dirname(cur)
    }
  }

  return { ok: true, deleted, failed, removedDirs }
}

function findFreePort(host, start, tries = 40) {
  return new Promise(resolve => {
    let port = start
    let attempts = 0
    const tryNext = () => {
      if (attempts++ >= tries) return resolve(start)
      const tester = net.createServer()
      tester.once('error', () => {
        port += 1
        tryNext()
      })
      tester.once('listening', () => tester.close(() => resolve(port)))
      tester.listen(port, host)
    }
    tryNext()
  })
}

// ---------------------------------------------------------------- routes

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const pathname = decodeURIComponent(url.pathname)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  // ---- 第三方库
  if (LIB_ROUTES.includes(pathname)) {
    const libPath = resolveLib(pathname)
    if (!libPath) {
      sendJson(res, 500, { error: `缺少前端依赖 ${pathname}，请重新放置 public/lib/ 下的文件` })
      return
    }
    await streamFile(res, libPath, { allowOutside: true })
    return
  }

  // ---- API
  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, version: 1 })
    return
  }

  if (pathname === '/api/config') {
    sendJson(res, 200, {
      host: config.host,
      port: config.port,
      maxDepth: config.maxDepth,
      roots: config.roots.map(r => ({
        id: r.id,
        label: r.label || r.path,
        path: r.path,
        exists: fs.existsSync(r.path),
      })),
    })
    return
  }

  if (pathname === '/api/scan') {
    const rootId = url.searchParams.get('root')
    const force = url.searchParams.get('refresh') === '1'
    const mode = url.searchParams.get('mode') || DEFAULT_FORMAT
    const root = rootId ? rootById(resolveRootId(rootId)) : config.roots[0]
    if (!root) {
      sendJson(res, 404, { error: '没有可用的根目录，请先在 viewer.config.json 里配置 roots' })
      return
    }
    try {
      sendJson(res, 200, await scanRoot(root, force, mode))
    } catch (err) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  // 删除一整套资产（atlas + skeleton + 它引用的贴图）。**不可恢复**，
  // 前端在调过来之前已经弹过带文件清单的二次确认。
  if (pathname === '/api/delete' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const root = rootById(resolveRootId(String(body.rootId || ''))) || config.roots[0]
      if (!root) {
        sendJson(res, 404, { error: '没有可用的根目录' })
        return
      }
      const items = Array.isArray(body.items) ? body.items : []
      const out = deleteItems(root, items)
      // 扫描结果按「根目录 + 约定」双键缓存，删完两种约定都要失效 ——
      // 否则下一次「不强制刷新」的扫描会把刚删掉的资产又从缓存里列出来（看着像删除失败）。
      if (out.deleted.length) invalidateScanCache(root.id)
      sendJson(res, 200, out)
    } catch (err) {
      sendJson(res, 400, { error: err.message })
    }
    return
  }

  if (pathname === '/api/roots' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const newPath = String(body.path || '').trim()
      if (!newPath) {
        sendJson(res, 400, { error: '缺少 path' })
        return
      }
      const label = String(body.label || '').trim() || path.basename(path.resolve(newPath)) || newPath
      const id = String(body.id || '').trim() ||
        label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '') ||
        `root-${Date.now()}`
      const exists = fs.existsSync(newPath)
      const existing = config.roots.find(r => path.resolve(r.path) === path.resolve(newPath))
      if (existing) {
        sendJson(res, 200, { ok: true, root: existing, alreadyExisted: true, exists })
        return
      }
      const root = { id, label, path: newPath }
      config.roots.push(root)
      await saveConfig()
      sendJson(res, 200, { ok: true, root, exists })
    } catch (err) {
      sendJson(res, 400, { error: err.message })
    }
    return
  }

  // JCZX 一键丢入：把 AB 写入当前根目录并立刻提取，返回最新扫描结果
  if (pathname === '/api/jczx/ingest' && req.method === 'POST') {
    try {
      const rootId = url.searchParams.get('root') || ''
      const root = rootId ? rootById(resolveRootId(rootId)) : config.roots[0]
      if (!root) {
        sendJson(res, 404, { error: '没有可用的根目录，请先添加目录' })
        return
      }
      const filename = String(url.searchParams.get('name') || req.headers['x-filename'] || 'bundle').trim()
      const safeName = path.basename(filename).replace(/[\\/\0]/g, '_') || 'bundle'
      if (!isJczxName(safeName) && !safeName.toLowerCase().startsWith('prefabs_spine_')) {
        // 仍允许：魔数在落盘后再验
      }
      const bodyBuf = await new Promise((resolve, reject) => {
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
      })
      if (!bodyBuf.length) {
        sendJson(res, 400, { error: '空文件' })
        return
      }
      if (!fs.existsSync(root.path)) await fsp.mkdir(root.path, { recursive: true })
      const dest = path.join(root.path, safeName)
      if (!isAuthorized(dest) && path.resolve(dest) !== path.resolve(root.path, safeName)) {
        sendJson(res, 403, { error: '路径越界' })
        return
      }
      await fsp.writeFile(dest, bodyBuf)
      if (!(await looksLikeUnityFS(dest))) {
        await fsp.unlink(dest).catch(() => {})
        sendJson(res, 400, { error: '不是 UnityFS / AssetBundle（文件头缺少 UnityFS）' })
        return
      }
      const extracted = await ensureJczxExtracted(dest, root.path, { autoSetup: true })
      invalidateScanCache(root.id)
      const scan = await scanRoot(root, true, 'jczx')
      sendJson(res, 200, {
        ok: true,
        saved: safeName,
        cacheDir: extracted.cacheDir,
        reused: extracted.reused,
        report: extracted.report,
        scan,
      })
    } catch (err) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  // 按目录结构映射本地文件：/spine/<rootId>/<相对路径>
  // 这样 Spine atlas 里写的贴图相对名（如 illust_special6.png）能被浏览器自然解析到。
  if (pathname.startsWith('/spine/')) {
    const rest = pathname.slice('/spine/'.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) {
      sendJson(res, 400, { error: '格式应为 /spine/<rootId>/<相对路径>' })
      return
    }
    const rootId = rest.slice(0, slash)
    const relPath = rest.slice(slash + 1)
    const root = rootById(resolveRootId(rootId))
    if (!root) {
      sendJson(res, 404, { error: `未知的根目录：${rootId}` })
      return
    }
    const abs = path.resolve(root.path, relPath)
    if (!isAuthorized(abs)) {
      sendJson(res, 403, { error: '路径越界' })
      return
    }
    await streamFile(res, abs)
    return
  }

  if (pathname === '/asset') {
    const p = url.searchParams.get('p')
    if (!p) {
      sendJson(res, 400, { error: '缺少参数 p' })
      return
    }
    await streamFile(res, p)
    return
  }

  // ---- 静态资源
  let rel = pathname === '/' ? '/index.html' : pathname
  const staticPath = path.join(PUBLIC_DIR, rel)
  if (!path.resolve(staticPath).startsWith(path.resolve(PUBLIC_DIR))) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    await streamFile(res, staticPath, { allowOutside: true })
    return
  }

  sendJson(res, 404, { error: `Not found: ${pathname}` })
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2)
  const wantOpen = args.includes('--open')
  const portArg = args.find(a => a.startsWith('--port='))
  if (portArg) config.port = Number(portArg.split('=')[1]) || config.port

  const missing = LIB_ROUTES.filter(r => !resolveLib(r))
  if (missing.length) {
    console.error('')
    console.error('[!] 缺少前端依赖文件（应为 public/lib/ 下）：')
    for (const r of missing) console.error(`    - ${r}`)
    console.error('    可从 node_modules 复制，或用 npm install 后再启动。')
    console.error('')
  }

  const host = config.host || '127.0.0.1'
  const port = await findFreePort(host, config.port || 8137)
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error('[error]', err)
      try {
        sendJson(res, 500, { error: err.message })
      } catch {
        /* already sent */
      }
    })
  })

  server.listen(port, host, async () => {
    const url = `http://${host}:${port}/`
    console.log('')
    console.log('  BD2 Local L2D / Spine Viewer')
    console.log('  ------------------------------------------')
    console.log(`  地址：${url}`)
    if (config.roots.length === 0) {
      console.log('  ⚠ 尚未配置根目录，请在页面上点「添加目录」')
    } else {
      for (const r of config.roots) {
        const ok = fs.existsSync(r.path)
        console.log(`  根目录：${r.label} ${ok ? '' : '(不存在!)'}  ${r.path}`)
      }
    }
    console.log('')
    console.log('  按 Ctrl+C 停止服务。')
    console.log('')

    if (wantOpen) {
      const cmd = process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
      import('node:child_process').then(({ spawn }) => {
        try {
          spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref()
        } catch {
          /* 打开失败不影响服务 */
        }
      })
    }
  })

  server.on('error', err => {
    console.error('[server] 启动失败：', err.message)
    process.exit(1)
  })
}

main()
