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
  classifyBundleFile,
  nameHintsJczx,
  getJczxUnpackProgress,
  prioritizeJczxUnpack,
  clearJczxCacheForDeletedDir,
} from './jczx_support.mjs'
import {
  NIKKE_CACHE_DIRNAME,
  isNikkeCacheDirName,
  isNikkeCacheRel,
  prepareNikkeRoot,
  ensureNikkeExtracted,
  isNikkeBundleName,
  prioritizeNikkeUnpack,
  getNikkeUnpackProgress,
  clearNikkeCacheForDeletedDir,
} from './nikke_ab_support.mjs'
import {
  resolveUnderRoot,
  isInside,
  MODE_SOURCE_FOLDERS,
} from './cache_home.mjs'

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
      // 需求 5：生成的 thumb.png 与 Lost Sword 预算图走同一角色，避免被当成图集页
      if (l === 'thumb.png') return { role: 'thumb' }
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
   * 标准导出多为 Spine 4.0.x；解包缓存（bd2viewer-nikke）为 4.1 二进制。扫描读骨架头写入
   * spineMinor（给前端选 4.0/4.1 运行时，见 R16），
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
 * 优先按布局偏移读版本串，避免 hash 字节里碰巧的 "4.0.x" 误导（与前端 / Android 同口径）。
 * JSON 骨架（.json / 裸 .bytes）不读文件，返回 null（按 4.1 线处理）。
 */
function spineMinorFromHead(buf) {
  if (!buf || !buf.length) return null
  if (buf.length > 10) {
    const len = buf[8]
    if (len > 0 && len < 24 && 9 + len <= buf.length) {
      let s = ''
      for (let i = 9; i < 9 + len; i++) {
        const c = buf[i]
        if (c === 0) break
        s += String.fromCharCode(c)
      }
      const vm = /^4\.(\d)\.\d+/.exec(s)
      if (vm) return `4.${vm[1]}`
    }
  }
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

/** 判断绝对路径是否落在某个已授权的根目录内（防目录穿越）。
 *  解包缓存可能抬到 mode 子目录的父级（BD2Viewer/bd2viewer-*），一并放行。 */
function isAuthorized(absPath) {
  const resolved = path.resolve(absPath)
  return config.roots.some(r => isInside(path.resolve(r.path), resolved))
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

/**
 * 需求 5：目录里的 thumb.png 只有「不比资产旧」才挂到条目上。
 * 资产变了（atlas / skeleton / 贴图任一更新）→ 返回 null，前端重新离屏渲并覆盖。
 */
async function freshThumbRel(dir, rootPath, thumbName, atlasName, skelName, imageNames) {
  if (!thumbName) return null
  const thumbAbs = path.join(dir, thumbName)
  const tm = await mtimeOf(thumbAbs)
  if (!tm) return null
  let newest = await mtimeOf(path.join(dir, atlasName))
  if (skelName) newest = Math.max(newest, await mtimeOf(path.join(dir, skelName)))
  for (const n of imageNames || []) {
    newest = Math.max(newest, await mtimeOf(path.join(dir, n)))
  }
  if (tm < newest) return null
  return path.relative(rootPath, thumbAbs).split(path.sep).join('/')
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
      // NIKKE 解包缓存同理：只在 nikke 档可见（否则 BD2 档会把抽出来的资产再摆一遍）
      if (isNikkeCacheDirName(entry.name) && fmt.id !== 'nikke') continue
      // Never nest-scan another game's mode folder (bd2/nikke/jczx/lostsword)
      if (MODE_SOURCE_FOLDERS.has(entry.name.toLowerCase())
        && path.resolve(dir) !== path.resolve(rootPath)) continue
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
      // 需求 5：thumb.png 且 mtime ≥ 资产文件才算有效（否则前端走离屏重渲并覆盖）
      relThumb: await freshThumbRel(dir, rootPath, thumb, atlasName, skel && skel.name, found_),
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

  // JCZX 静态 CG：包名带 _draw（textures_bigs_*_draw / *_draw_face），解出来只有 png。
  // 动画用的贴图包同样没有 atlas，不能当成 CG。
  if (atlases.length === 0 && fmt.id === 'jczx' && /_draw/i.test(path.basename(dir))) {
    const pngs = images.filter(n => n !== thumb && /\.png$/i.test(n))
    if (pngs.length) {
      const relOf = (name) => path.relative(rootPath, path.join(dir, name)).split(path.sep).join('/')
      const relFirst = relOf(pngs[0])
      if (isJczxCacheRel(relFirst)) {
        const base = path.basename(pngs[0], path.extname(pngs[0]))
        const rawFolder = path.basename(dir)
        const pretty = rawFolder.replace(/^[0-9a-f]{10}_/, '')
        out.push({
          id: relFirst,
          dir,
          group: relFirst.includes('/') ? relFirst.split('/')[0] : '（根目录）',
          folder: pretty || rawFolder,
          base,
          atlas: null,
          relAtlas: relFirst,
          relSkeleton: null,
          skeleton: null,
          skeletonKind: null,
          spineMinor: null,
          imageOnly: true,
          images: pngs,
          relImages: pngs.map(relOf),
          relThumb: null,
          missingImages: [],
          ok: true,
          mtime: await mtimeOf(path.join(dir, pngs[0])),
          problems: [],
        })
      }
    }
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
  let nikkeMeta = null
  if (exists) {
    // JCZX：先把根下双 UnityFS AB 抽到 `bd2viewer-jczx/`，再按 bd 规则扫
    if (fmt.id === 'jczx') {
      jczxMeta = await prepareJczxRoot(root.path, {
        maxDepth: config.maxDepth || 5,
        autoSetup: true,
      })
    }
    // NIKKE：根下的 mod 包（UnityFS，无扩展名）抽成标准三件套放进 `bd2viewer-nikke/`。
    // 与 JCZX 不同：**不**把结果限制在缓存目录里 —— NIKKE 档还要照常认用户手里的
    // 裸 .atlas/.skel/.png 目录（老 mod）；抽出来的资产和它们同处一个可见列表。
    if (fmt.id === 'nikke') {
      nikkeMeta = await prepareNikkeRoot(root.path, {
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
    // NIKKE 档不展示交错战线的解包结果（哪怕曾经误抽进了 bd2viewer-nikke/<prefabs_spine_*>）
    if (fmt.id === 'nikke') {
      for (let i = items.length - 1; i >= 0; i--) {
        const rel = String(items[i].relAtlas || items[i].folder || '').replace(/\\/g, '/')
        if (isJczxCacheRel(rel) || nameHintsJczx(rel)) items.splice(i, 1)
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
    ...(nikkeMeta ? { nikkeAb: nikkeMeta } : {}),
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

/**
 * 删除整个目录（文件夹），仅允许落在当前 root 内，绝不越过 root 本身。
 * 若目录内含 NIKKE/JCZX 源包，先清对应解包缓存，再递归删目录。
 * 返回 { ok, deleted: relDir, clearedCache:[], error? }
 */
async function deleteDirectory(root, relDirRaw) {
  const rootAbs = path.resolve(root.path)
  const rel = String(relDirRaw || '').split(/[/\\]/).filter(Boolean).join('/')
  if (!rel || rel === '.' ) {
    return { ok: false, deleted: null, clearedCache: [], error: '不能删除根目录本身' }
  }
  const abs = path.resolve(rootAbs, rel)
  if (!isAuthorized(abs)) {
    return { ok: false, deleted: null, clearedCache: [], error: `路径越界，已拒绝：${rel}` }
  }
  // 二次确认：解析后必须仍在本 root 下，且不是 root 本身
  const relCheck = path.relative(rootAbs, abs)
  if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return { ok: false, deleted: null, clearedCache: [], error: `路径越界，已拒绝：${rel}` }
  }
  if (path.resolve(abs) === rootAbs) {
    return { ok: false, deleted: null, clearedCache: [], error: '不能删除根目录本身' }
  }
  if (!fs.existsSync(abs)) {
    return { ok: true, deleted: rel, clearedCache: [], missing: true }
  }
  let st
  try { st = fs.statSync(abs) } catch (e) {
    return { ok: false, deleted: null, clearedCache: [], error: e.message }
  }
  if (!st.isDirectory()) {
    return { ok: false, deleted: null, clearedCache: [], error: `不是目录：${rel}` }
  }

  const clearedCache = []
  try {
    const n = await clearNikkeCacheForDeletedDir(rootAbs, rel)
    const j = await clearJczxCacheForDeletedDir(rootAbs, rel)
    clearedCache.push(...n, ...j)
  } catch (e) {
    // 清缓存失败不阻断删目录，但记下来
    clearedCache.push(`(cache-clear-error:${e.message})`)
  }

  try {
    fs.rmSync(abs, { recursive: true, force: true })
  } catch (e) {
    return { ok: false, deleted: null, clearedCache, error: e.message }
  }
  return { ok: true, deleted: rel, clearedCache }
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
  let pathname
  try {
    // url.pathname is percent-encoded; decode so Chinese / spaces match disk.
    // Do NOT use form-urlencoded rules (+ → space) — path '+' stays '+'.
    pathname = decodeURIComponent(url.pathname)
  } catch {
    pathname = url.pathname
  }

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

  // 需求 5：离屏缩略图落盘为资产目录里的 thumb.png（与 builtinThumbUrl 同源）
  if (pathname === '/api/thumb' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const root = rootById(resolveRootId(String(body.rootId || ''))) || config.roots[0]
      if (!root) {
        sendJson(res, 404, { error: '没有可用的根目录' })
        return
      }
      const rel = String(body.rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
      if (!rel || path.basename(rel).toLowerCase() !== 'thumb.png') {
        sendJson(res, 400, { error: 'rel 必须是 …/thumb.png' })
        return
      }
      const abs = path.resolve(root.path, rel)
      if (!isAuthorized(abs)) {
        sendJson(res, 403, { error: '路径越界，已拒绝' })
        return
      }
      const b64 = String(body.data || '')
      if (!b64) {
        sendJson(res, 400, { error: '缺少 data（base64）' })
        return
      }
      // Never create foreign game folders under this mode root (e.g. BD2 char
      // dirs under jczx/). Thumb only lands next to an existing asset directory.
      const parent = path.dirname(abs)
      try {
        const pst = await fsp.stat(parent)
        if (!pst.isDirectory()) {
          sendJson(res, 400, { error: '缩略图目录不存在（拒绝新建异游戏文件夹）', path: parent })
          return
        }
      } catch {
        sendJson(res, 400, { error: '缩略图目录不存在（拒绝新建异游戏文件夹）', path: parent })
        return
      }
      await fsp.writeFile(abs, Buffer.from(b64, 'base64'))
      // 扫描缓存失效：下次扫描能立刻带上 relThumb
      invalidateScanCache(root.id)
      sendJson(res, 200, { ok: true, rel })
    } catch (err) {
      sendJson(res, 400, { error: err.message })
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

  // 删除整个目录（文件夹）。**不可恢复**；前端已弹确认。
  if (pathname === '/api/delete-dir' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const root = rootById(resolveRootId(String(body.rootId || ''))) || config.roots[0]
      if (!root) {
        sendJson(res, 404, { error: '没有可用的根目录' })
        return
      }
      const relDir = String(body.relDir || body.rel || '').trim()
      const out = await deleteDirectory(root, relDir)
      if (out.ok && out.deleted) invalidateScanCache(root.id)
      sendJson(res, out.ok ? 200 : 400, out)
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

  // 从配置列表移除根路径（只改 viewer.config.json，不删磁盘上任何文件）
  if (pathname === '/api/roots' && req.method === 'DELETE') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const id = String(body.id || '').trim()
      const wantPath = String(body.path || '').trim()
      if (!id && !wantPath) {
        sendJson(res, 400, { error: '缺少 id 或 path' })
        return
      }
      const before = config.roots.length
      let removed = null
      config.roots = config.roots.filter(r => {
        const hit = (id && r.id === id) ||
          (wantPath && path.resolve(r.path) === path.resolve(wantPath))
        if (hit && !removed) removed = r
        return !hit
      })
      if (!removed || config.roots.length === before) {
        sendJson(res, 404, { error: '找不到要移除的根目录', ok: false })
        return
      }
      await saveConfig()
      if (removed.id) invalidateScanCache(removed.id)
      sendJson(res, 200, { ok: true, removed: { id: removed.id, label: removed.label, path: removed.path } })
    } catch (err) {
      sendJson(res, 400, { error: err.message, ok: false })
    }
    return
  }

  // NIKKE 一键丢入：把 mod 包写进当前根目录并立刻解包，返回最新扫描结果。
  // 与 JCZX 的差别：NIKKE 档**不**只认缓存 —— 解包出来的资产和用户原有的裸
  // .atlas/.skel 目录共存于同一个可见列表，所以这里按 nikke 模式重扫。
  // JCZX 解包进度（真实计数；前端进度条轮询，不必整页重扫）
  if (pathname === '/api/jczx/progress') {
    const rootId = url.searchParams.get('root') || (config.roots[0] && config.roots[0].id)
    const root = config.roots.find(r => r.id === rootId)
    if (!root) return sendJson(res, 404, { error: 'unknown root' })
    return sendJson(res, 200, getJczxUnpackProgress(root.path))
  }
  // JCZX 解包优先（不打断 in-flight）
  if (pathname === '/api/jczx/prioritize' && req.method === 'POST') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = {} }
    const rootId = body.root || url.searchParams.get('root') || (config.roots[0] && config.roots[0].id)
    const root = config.roots.find(r => r.id === rootId)
    if (!root) return sendJson(res, 404, { error: 'unknown root' })
    const rels = Array.isArray(body.rels) ? body.rels : (body.rel ? [body.rel] : [])
    return sendJson(res, 200, prioritizeJczxUnpack(root.path, rels))
  }
  // NIKKE 解包进度（真实计数；前端进度条轮询，不必整页重扫）
  if (pathname === '/api/nikke-ab/progress') {
    const rootId = url.searchParams.get('root') || (config.roots[0] && config.roots[0].id)
    const root = config.roots.find(r => r.id === rootId)
    if (!root) return sendJson(res, 404, { error: 'unknown root' })
    return sendJson(res, 200, getNikkeUnpackProgress(root.path))
  }

  // NIKKE 解包优先：点开未解完的卡 / 同角色姿势兄弟抬到队首（不打断 in-flight）
  if (pathname === '/api/nikke-ab/prioritize' && req.method === 'POST') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = {} }
    const rootId = body.root || url.searchParams.get('root') || (config.roots[0] && config.roots[0].id)
    const root = config.roots.find(r => r.id === rootId)
    if (!root) return sendJson(res, 404, { error: 'unknown root' })
    const rels = Array.isArray(body.rels) ? body.rels : (body.rel ? [body.rel] : [])
    // 也接受 siblingKey / keys：按角色 id 抬高所有同键排队项
    const keys = Array.isArray(body.keys) ? body.keys : (body.key ? [body.key] : [])
    if (keys.length) {
      const prog = getNikkeUnpackProgress(root.path)
      const all = [...(prog.currentRels || []), ...((prog.pendingRels) || [])]
      // pendingRels 可能不在 progress 快照里 —— 从 prioritize 内部 known 解决；
      // 这里把 key 转成假 rel（basename=key）也能被 sibling 匹配吃到
      for (const k of keys) rels.push(String(k))
    }
    const out = prioritizeNikkeUnpack(root.path, rels, { sibling: body.sibling !== false })
    return sendJson(res, 200, out)
  }

  if (pathname === '/api/nikke-ab/ingest' && req.method === 'POST') {
    try {
      const rootId = url.searchParams.get('root') || ''
      const root = rootId ? rootById(resolveRootId(rootId)) : config.roots[0]
      if (!root) {
        sendJson(res, 404, { error: '没有可用的根目录，请先添加目录' })
        return
      }
      const filename = String(url.searchParams.get('name') || req.headers['x-filename'] || 'bundle').trim()
      let safeName = path.basename(filename).replace(/[\\/\0]/g, '_') || 'bundle'
      if (!isNikkeBundleName(safeName)) safeName = safeName.replace(/\.(atlas|skel|png|json|bytes)$/i, '') || 'bundle'
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
      const kind = await classifyBundleFile(dest)
      if (kind !== 'nikke') {
        await fsp.unlink(dest).catch(() => {})
        sendJson(res, 400, {
          error: kind === 'jczx'
            ? '这是交错战线（JCZX）资产包，不会在 NIKKE 模式里解包。请切换到 JCZX。'
            : '不是 NIKKE 的 UnityFS 资产包',
        })
        return
      }
      const extracted = await ensureNikkeExtracted(dest, root.path, { autoSetup: true })
      invalidateScanCache(root.id)
      const scan = await scanRoot(root, true, 'nikke')
      sendJson(res, 200, {
        ok: true,
        saved: safeName,
        outDir: extracted.outDir,
        report: extracted.report,
        scan,
      })
    } catch (err) {
      sendJson(res, 500, { error: err.message })
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
      if (!isJczxName(safeName) && !safeName.toLowerCase().includes('prefabs_spine')) {
        // 名字对不上也先落盘，用文件头区分 JCZX / NIKKE，避免无扩展名的 NIKKE 包被收进来
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
      const kind = await classifyBundleFile(dest)
      if (kind !== 'jczx') {
        await fsp.unlink(dest).catch(() => {})
        sendJson(res, 400, {
          error: kind === 'nikke'
            ? '这是 NIKKE 资产包，不会在 JCZX 模式里解包。请切换到 NIKKE。'
            : '不是交错战线的双头 UnityFS 包（文件头缺少第二段 UnityFS）',
        })
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
    const relPath = rest.slice(slash + 1).replace(/\\/g, '/')
    const root = rootById(resolveRootId(rootId))
    if (!root) {
      sendJson(res, 404, { error: `未知的根目录：${rootId}` })
      return
    }
    // Match URL encoding to disk: try scan root + lifted unpack cache home;
    // tolerate double-encoding / separators / bare leaf under bd2viewer-*.
    let abs = resolveUnderRoot(root.path, relPath, {
      cacheDirNames: [
        JCZX_CACHE_DIRNAME, JCZX_CACHE_DIRNAME_LEGACY,
        NIKKE_CACHE_DIRNAME, '.bd2viewer-nikke',
      ],
    })
    if (!abs) {
      // Fallback join for clearer 404 path in JSON (Windows Chinese/space roots)
      abs = path.resolve(root.path, relPath.split('/').join(path.sep))
    }
    if (!isAuthorized(abs)) {
      sendJson(res, 403, { error: '路径越界', path: abs })
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
