/**
 * JCZX（交错战线）桌面提取支持：双 UnityFS MIT strip + 调 UnityPy 抽到缓存。
 * 仅 Node 侧使用；产物落在扫描根下 `bd2viewer-jczx/`（无前导点；BD2Viewer/jczx/bd2viewer-jczx 为预期布局）。
 * 旧版 `.bd2viewer-jczx/` 仍识别并在 prepare 时迁移。
 *
 * Python 解析（无需 BD2_JCZX_PYTHON 即可用）：
 *   1. 可选覆盖：process.env.BD2_JCZX_PYTHON
 *   2. 仓库旁 / bd2-local-viewer 旁的 .venv-jczx（Win: Scripts/python.exe；Unix: bin/python）
 *   3. PATH 上能 import UnityPy 的 python3 / python
 * 若都没有且允许自动安装：用系统 python 建 .venv-jczx 并 pip install -r _tools/requirements-jczx.txt
 * （需一次联网）。也可手动跑 setup_jczx.bat / setup_jczx.sh。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  packFingerprint,
  MODE_SOURCE_FOLDERS,
} from './cache_home.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const JCZX_CACHE_DIRNAME = 'bd2viewer-jczx'
/** Legacy leading-dot cache; migrated on prepare when possible. */
export const JCZX_CACHE_DIRNAME_LEGACY = '.bd2viewer-jczx'
export const JCZX_VENV_DIRNAME = '.venv-jczx'

export function isJczxCacheDirName(name) {
  return name === JCZX_CACHE_DIRNAME || name === JCZX_CACHE_DIRNAME_LEGACY
}

export function isJczxCacheRel(rel) {
  const r = String(rel || '').replace(/\\/g, '/')
  return (
    r === JCZX_CACHE_DIRNAME || r.startsWith(JCZX_CACHE_DIRNAME + '/') ||
    r.includes('/' + JCZX_CACHE_DIRNAME + '/') ||
    r === JCZX_CACHE_DIRNAME_LEGACY || r.startsWith(JCZX_CACHE_DIRNAME_LEGACY + '/') ||
    r.includes('/' + JCZX_CACHE_DIRNAME_LEGACY + '/')
  )
}

export function migrateLegacyJczxCache(rootPath) {
  const legacy = path.join(rootPath, JCZX_CACHE_DIRNAME_LEGACY)
  const modern = path.join(rootPath, JCZX_CACHE_DIRNAME)
  if (!fs.existsSync(legacy) || !fs.statSync(legacy).isDirectory()) return false
  if (!fs.existsSync(modern)) {
    try {
      fs.renameSync(legacy, modern)
      return true
    } catch (e) {
      console.warn('[jczx] legacy cache rename failed:', e.message)
      return false
    }
  }
  return false
}
const EXTRACT_PY = path.join(__dirname, '_tools', 'jczx_extract.py')
const REQUIREMENTS = path.join(__dirname, '_tools', 'requirements-jczx.txt')
const UNITYFS = Buffer.from('UnityFS\0')
/** 双头 JCZX 包的第二段 UnityFS 落在文件头附近（实测 offset 83）。多读一点以免假头变长。 */
const BUNDLE_SNIFF_BYTES = 4096
const IS_WIN = process.platform === 'win32'

/** bd2-local-viewer 目录；其父目录通常是仓库根 */
const VIEWER_DIR = __dirname
const REPO_ROOT = path.resolve(__dirname, '..')

let _setupPromise = null
let _cachedPython = null
let _cachedProbe = null

function venvPythonPath(venvRoot) {
  if (IS_WIN) {
    return [
      path.join(venvRoot, 'Scripts', 'python.exe'),
      path.join(venvRoot, 'Scripts', 'python'),
    ]
  }
  return [
    path.join(venvRoot, 'bin', 'python'),
    path.join(venvRoot, 'bin', 'python3'),
  ]
}

/** 候选 venv 根：仓库根、bd2-local-viewer 旁 */
export function jczxVenvRoots() {
  return [path.join(REPO_ROOT, JCZX_VENV_DIRNAME), path.join(VIEWER_DIR, JCZX_VENV_DIRNAME)]
}

function localVenvPythonCandidates() {
  const out = []
  for (const root of jczxVenvRoots()) {
    for (const py of venvPythonPath(root)) out.push(py)
  }
  return out
}

function pathPythonCandidates() {
  return IS_WIN ? ['python', 'python3', 'py'] : ['python3', 'python']
}

/**
 * 探测解释器能否 import UnityPy。返回 { ok, error }。
 */
export function probeUnityPy(pythonBin) {
  if (!pythonBin) return { ok: false, error: 'empty python' }
  try {
    const r = spawnSync(
      pythonBin,
      ['-c', 'import UnityPy; print(getattr(UnityPy, "__version__", "ok"))'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    )
    if (r.error) return { ok: false, error: String(r.error.message || r.error) }
    if (r.status !== 0) {
      const err = (r.stderr || r.stdout || '').trim().slice(0, 400)
      return { ok: false, error: err || `exit ${r.status}` }
    }
    return { ok: true, version: (r.stdout || '').trim() }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
}

function firstExisting(cands) {
  for (const c of cands) {
    if (!c) continue
    if (c === 'python' || c === 'python3' || c === 'py') continue
    if (fs.existsSync(c)) return c
  }
  return null
}

/**
 * 同步解析：只找已有可用解释器，不自动建 venv。
 * 顺序：BD2_JCZX_PYTHON → 本地 .venv-jczx → PATH 上能 import UnityPy 的 python。
 * 若都没有，退回 'python3'/'python'（调用方应再走 ensureJczxPython）。
 */
export function resolveJczxPython() {
  if (_cachedPython && _cachedProbe?.ok) return _cachedPython

  const envPy = process.env.BD2_JCZX_PYTHON
  if (envPy) {
    if (envPy === 'python' || envPy === 'python3' || envPy === 'py' || fs.existsSync(envPy)) {
      const probe = probeUnityPy(envPy)
      if (probe.ok) {
        _cachedPython = envPy
        _cachedProbe = probe
        return envPy
      }
    }
  }

  for (const c of localVenvPythonCandidates()) {
    if (!fs.existsSync(c)) continue
    const probe = probeUnityPy(c)
    if (probe.ok) {
      _cachedPython = c
      _cachedProbe = probe
      return c
    }
  }

  for (const c of pathPythonCandidates()) {
    const probe = probeUnityPy(c)
    if (probe.ok) {
      _cachedPython = c
      _cachedProbe = probe
      return c
    }
  }

  // 无 UnityPy：仍返回一个可尝试的名字，便于错误信息
  if (envPy && (envPy === 'python' || envPy === 'python3' || envPy === 'py' || fs.existsSync(envPy))) {
    return envPy
  }
  const local = firstExisting(localVenvPythonCandidates())
  if (local) return local
  return IS_WIN ? 'python' : 'python3'
}

function findBootstrapPython() {
  const envPy = process.env.BD2_JCZX_PYTHON
  if (envPy && (envPy === 'python' || envPy === 'python3' || envPy === 'py' || fs.existsSync(envPy))) {
    return envPy
  }
  for (const c of pathPythonCandidates()) {
    try {
      const r = spawnSync(c, ['-c', 'import sys; print(sys.executable)'], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      })
      if (r.status === 0 && (r.stdout || '').trim()) return c
    } catch { /* try next */ }
  }
  return null
}

function runLogged(cmd, args, { onLog, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env: { ...process.env },
      windowsHide: true,
      shell: IS_WIN && (cmd === 'py' || /\s/.test(cmd)),
    })
    let stdout = ''
    let stderr = ''
    const emit = (chunk, isErr) => {
      const s = String(chunk)
      if (isErr) stderr += s
      else stdout += s
      if (onLog) {
        for (const line of s.split(/\r?\n/).filter(Boolean)) onLog(line)
      }
    }
    child.stdout.on('data', d => emit(d, false))
    child.stderr.on('data', d => emit(d, true))
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.on('error', err => resolve({ code: -1, stdout, stderr: String(err) }))
  })
}

/**
 * 在仓库根创建 .venv-jczx 并安装 requirements-jczx.txt。
 * 需要本机已有 python，且首次需联网。
 */
export async function setupJczxVenv({ onLog } = {}) {
  const log = (msg) => { if (onLog) onLog(msg); console.log(`[jczx] ${msg}`) }
  const venvRoot = path.join(REPO_ROOT, JCZX_VENV_DIRNAME)
  const bootstrap = findBootstrapPython()
  if (!bootstrap) {
    const err = '未找到系统 Python。请先安装 Python 3.10+ 并勾选 Add to PATH，或运行 setup_jczx.bat / setup_jczx.sh。'
    log(err)
    return { ok: false, error: err, venvRoot }
  }
  log(`正在创建 JCZX 虚拟环境：${venvRoot}（解释器：${bootstrap}）…`)
  await fsp.mkdir(path.dirname(venvRoot), { recursive: true })
  if (!fs.existsSync(venvRoot)) {
    const created = await runLogged(bootstrap, ['-m', 'venv', venvRoot], { onLog: log })
    if (created.code !== 0) {
      const err = `python -m venv 失败：${(created.stderr || created.stdout || '').slice(0, 500)}`
      log(err)
      return { ok: false, error: err, venvRoot }
    }
  } else {
    log(`已存在目录 ${venvRoot}，跳过 venv 创建，继续安装依赖…`)
  }
  const py = venvPythonPath(venvRoot).find(p => fs.existsSync(p))
  if (!py) {
    const err = `venv 已建但找不到 python：${venvRoot}`
    log(err)
    return { ok: false, error: err, venvRoot }
  }
  log('正在 pip install UnityPy + Pillow（需联网一次）…')
  const pip = await runLogged(py, ['-m', 'pip', 'install', '-r', REQUIREMENTS], { onLog: log })
  if (pip.code !== 0) {
    const err = `pip install 失败：${(pip.stderr || pip.stdout || '').slice(0, 800)}`
    log(err)
    return { ok: false, error: err, venvRoot, python: py }
  }
  const probe = probeUnityPy(py)
  if (!probe.ok) {
    const err = `安装后仍无法 import UnityPy：${probe.error}`
    log(err)
    return { ok: false, error: err, venvRoot, python: py }
  }
  _cachedPython = py
  _cachedProbe = probe
  log(`JCZX 环境就绪：${py}（UnityPy ${probe.version || 'ok'}）`)
  return { ok: true, venvRoot, python: py, version: probe.version, created: true }
}

/**
 * 解析可用 Python；若没有 UnityPy 且 autoSetup，则自动建 .venv-jczx。
 * 返回 { python, probe, setup? }。
 */
export async function ensureJczxPython({ autoSetup = true, onLog } = {}) {
  // 已有缓存且可用
  if (_cachedPython && _cachedProbe?.ok) {
    return { python: _cachedPython, probe: _cachedProbe }
  }

  const envPy = process.env.BD2_JCZX_PYTHON
  if (envPy) {
    const probe = probeUnityPy(envPy)
    if (probe.ok) {
      _cachedPython = envPy
      _cachedProbe = probe
      return { python: envPy, probe }
    }
  }

  for (const c of localVenvPythonCandidates()) {
    if (!fs.existsSync(c)) continue
    const probe = probeUnityPy(c)
    if (probe.ok) {
      _cachedPython = c
      _cachedProbe = probe
      return { python: c, probe }
    }
  }

  for (const c of pathPythonCandidates()) {
    const probe = probeUnityPy(c)
    if (probe.ok) {
      _cachedPython = c
      _cachedProbe = probe
      return { python: c, probe }
    }
  }

  if (!autoSetup) {
    const fallback = resolveJczxPython()
    return {
      python: fallback,
      probe: probeUnityPy(fallback),
      setup: {
        ok: false,
        skipped: true,
        message: '未找到带 UnityPy 的 Python。请运行 bd2-local-viewer/setup_jczx.bat（或 .sh），或设置 BD2_JCZX_PYTHON。',
      },
    }
  }

  // 串行化自动安装，避免并发扫根重复建 venv
  if (!_setupPromise) {
    _setupPromise = setupJczxVenv({ onLog }).finally(() => {
      /* keep result via _cachedPython; allow retry later if failed */
    })
  }
  const setup = await _setupPromise
  _setupPromise = setup.ok ? _setupPromise : null
  if (setup.ok && setup.python) {
    return {
      python: setup.python,
      probe: { ok: true, version: setup.version },
      setup: {
        ok: true,
        created: true,
        message: `已自动创建 JCZX 环境（UnityPy ${setup.version || 'ok'}）。下次无需联网。`,
        venvRoot: setup.venvRoot,
      },
    }
  }
  const fallback = resolveJczxPython()
  return {
    python: fallback,
    probe: { ok: false, error: setup.error },
    setup: {
      ok: false,
      message: setup.error || 'JCZX 环境自动安装失败。可手动运行 setup_jczx.bat / setup_jczx.sh（需联网一次）。',
      venvRoot: setup.venvRoot,
    },
  }
}

export function isJczxName(name) {
  const l = String(name || '').toLowerCase()
  if (!l || l.startsWith('.')) return false
  // 已是标准 Spine 件，不当 AB
  if (/\.(atlas|json|skel|png|jpg|jpeg|webp|bytes|txt|md)$/i.test(l)) return false
  // 名字只是提示。真正入队还要看文件头（见 classifyBundleHead）：
  // 无扩展名的 NIKKE 包不能因为「没有后缀」就被当成 JCZX。
  if (/prefabs_spine/i.test(name)) return true
  if (/\.(ab|unity3d|bundle|assets)$/i.test(l)) return true
  return false
}

/** 名字里带 prefabs_spine（可在中间，带 hash 前缀也算）就是交错战线包。 */
export function nameHintsJczx(name) {
  return /prefabs_spine/i.test(String(name || ''))
}

/**
 * 读包头判断游戏。
 * · JCZX：文件名含 prefabs_spine，或开头 4KB 里有第二段 UnityFS（双头 MIT 包）
 * · NIKKE：只有一段 UnityFS，且名字不像 JCZX
 * · 其它：null
 * @param {Buffer} head
 * @returns {'jczx'|'nikke'|null}
 */
export function classifyBundleHead(name, head) {
  if (!head || head.length < 8 || !head.subarray(0, 8).equals(UNITYFS)) return null
  if (nameHintsJczx(name)) return 'jczx'
  if (head.indexOf(UNITYFS, 1) > 0) return 'jczx'
  return 'nikke'
}

export async function readBundleHead(absPath, n = BUNDLE_SNIFF_BYTES) {
  let fh
  try {
    fh = await fsp.open(absPath, 'r')
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

/** @returns {Promise<'jczx'|'nikke'|null>} */
export async function classifyBundleFile(absPath) {
  const head = await readBundleHead(absPath)
  return classifyBundleHead(path.basename(absPath), head)
}

export async function looksLikeUnityFS(absPath) {
  try {
    const fh = await fsp.open(absPath, 'r')
    try {
      const buf = Buffer.alloc(8)
      const { bytesRead } = await fh.read(buf, 0, 8, 0)
      return bytesRead === 8 && buf.equals(UNITYFS)
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
}

export function cacheDirFor(rootPath, abAbs) {
  const rel = path.relative(rootPath, abAbs).split(/[/\\]/).join('/')
  const key = rel.split('/').join('__').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
  const hash = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 10)
  return path.join(rootPath, JCZX_CACHE_DIRNAME, `${hash}_${key}`)
}


/** 源相对路径 → 缓存目录绝对路径（与 cacheDirFor 一致）。 */
export function cacheDirForRel(rootPath, srcRel) {
  const abs = path.resolve(rootPath, String(srcRel || '').split(/[/\\]/).join(path.sep))
  return cacheDirFor(rootPath, abs)
}

/**
 * 用户删掉源目录时清掉对应 JCZX 解包缓存。
 * 正在删缓存目录本身 → 跳过。返回已清的缓存相对路径。
 */
export async function clearJczxCacheForDeletedDir(rootPath, relDir) {
  const rel = String(relDir || '').split(/[/\\]/).filter(Boolean).join('/')
  if (!rel || isJczxCacheRel(rel)) return []
  const rootAbs = path.resolve(rootPath)
  const srcAbs = path.resolve(rootAbs, rel)
  const cleared = []
  const targets = new Set()

  const consider = (srcRel) => {
    const abs = path.resolve(rootAbs, srcRel)
    const c = cacheDirFor(rootAbs, abs)
    targets.add(c)
  }

  const walk = async (dir, r) => {
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const rr = r ? r + '/' + e.name : e.name
      if (e.isDirectory()) {
        if (isJczxCacheDirName(e.name) || e.name === 'bd2viewer-nikke' || e.name === '.bd2viewer-nikke'
          || e.name === 'node_modules' || e.name === '.git' || e.name === JCZX_VENV_DIRNAME) continue
        await walk(abs, rr)
        continue
      }
      if (!e.isFile()) continue
      if ((await classifyBundleFile(abs)) !== 'jczx') continue
      consider(rr)
    }
  }

  try {
    const st = await fsp.stat(srcAbs)
    if (st.isFile()) {
      if ((await classifyBundleFile(srcAbs)) === 'jczx') consider(rel)
    } else if (st.isDirectory()) {
      await walk(srcAbs, rel)
    }
  } catch { /* source gone */ }

  // 也按前缀匹配：缓存目录名里嵌了 __ 分隔的相对路径
  const cacheRoot = path.join(rootAbs, JCZX_CACHE_DIRNAME)
  try {
    const kids = await fsp.readdir(cacheRoot, { withFileTypes: true })
    const needle = rel.replace(/\//g, '__')
    for (const e of kids) {
      if (!e.isDirectory()) continue
      // 形如 <hash>_<key>，key 含源相对路径
      const name = e.name
      const us = name.indexOf('_')
      const key = us >= 0 ? name.slice(us + 1) : name
      if (key === needle || key.startsWith(needle + '__') || key.startsWith(needle + '_')) {
        targets.add(path.join(cacheRoot, name))
      }
    }
  } catch { /* no cache */ }

  for (const abs of targets) {
    await fsp.rm(abs, { recursive: true, force: true }).catch(() => {})
    cleared.push(path.relative(rootAbs, abs).split(path.sep).join('/'))
  }
  return cleared
}

async function runExtract(py, src, outDir) {
  const pool = getJczxPool(py)
  const report = await pool.runJob(src, outDir, null)
  const code = report && report.ok ? 0 : 1
  return { code, stdout: '', stderr: (report && report.error) || '', report }
}

/**
 * 确保 AB 已提取到缓存目录。返回 { cacheDir, report, reused, setup? }。
 */
export async function ensureJczxExtracted(abAbs, rootPath, { python, autoSetup = true, onLog } = {}) {
  let setupMeta = null
  let py = python
  if (!py) {
    const ensured = await ensureJczxPython({ autoSetup, onLog })
    py = ensured.python
    setupMeta = ensured.setup || null
    if (!ensured.probe?.ok) {
      const e = new Error(
        ensured.setup?.message
          || `JCZX 需要 UnityPy：未找到可用 Python（当前尝试：${py}）。请运行 setup_jczx.bat / setup_jczx.sh，或设置 BD2_JCZX_PYTHON。`,
      )
      e.setup = setupMeta
      throw e
    }
  }
  const st = await fsp.stat(abAbs)
  const cacheDir = cacheDirFor(rootPath, abAbs)
  const stampPath = path.join(cacheDir, '.stamp.json')
  await fsp.mkdir(cacheDir, { recursive: true })

  if (fs.existsSync(stampPath)) {
    try {
      const stamp = JSON.parse(await fsp.readFile(stampPath, 'utf8'))
      if (stamp.ok && stamp.size === st.size && stamp.mtimeMs === st.mtimeMs
          && (await cacheHasViewable(cacheDir, stamp))) {
        return { cacheDir, report: stamp.report || null, reused: true, setup: setupMeta }
      }
    } catch { /* re-extract */ }
  }

  // 清掉旧产物（保留目录）
  for (const name of await fsp.readdir(cacheDir)) {
    if (name === '.stamp.json') continue
    await fsp.rm(path.join(cacheDir, name), { recursive: true, force: true })
  }

  const { code, stderr, report } = await runExtract(py, abAbs, cacheDir)
  const ok = !!(report && report.ok)
  const stamp = {
    ok,
    size: st.size,
    mtimeMs: st.mtimeMs,
    src: abAbs,
    code,
    stderr: stderr.slice(0, 2000),
    report,
    extractedAt: new Date().toISOString(),
    python: py,
  }
  await fsp.writeFile(stampPath, JSON.stringify(stamp, null, 2), 'utf8')
  if (!ok) {
    const err = (report && report.error) || stderr || `extract exit ${code}`
    const e = new Error(`JCZX 提取失败：${path.basename(abAbs)} — ${err}`)
    e.report = report
    e.setup = setupMeta
    throw e
  }
  return { cacheDir, report, reused: false, setup: setupMeta }
}

/** 递归收集根下疑似 AB 文件（跳过缓存目录本身） */
export async function findJczxBundles(rootPath, maxDepth = 5) {
  const out = []
  async function walk(dir, depth) {
    if (depth > maxDepth) return
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (isJczxCacheDirName(ent.name) || ent.name === 'bd2viewer-nikke' || ent.name === '.bd2viewer-nikke'
        || ent.name === 'node_modules' || ent.name === '.git'
        || ent.name === JCZX_VENV_DIRNAME) continue
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        // Do not descend into sibling game mode folders (cache lives at parent)
        if (MODE_SOURCE_FOLDERS.has(String(ent.name).toLowerCase())
          && path.resolve(dir) !== path.resolve(rootPath)) {
          continue
        }
        await walk(abs, depth + 1)
        continue
      }
      if (!ent.isFile()) continue
      const kind = await classifyBundleFile(abs)
      if (kind !== 'jczx') continue
      out.push(abs)
    }
  }
  await walk(rootPath, 0)
  return out
}

/* -------- JCZX 包级优先级队列（与 NIKKE 同模型）：并发 ≤ 10，prepare 立即返回 -------- */
export const JCZX_MAX_CONCURRENT = 10
/** 单包 inFlight 超时：超时记 failed 并腾出槽位，避免 toast/进度永远卡在「后台还在处理」。 */
export const JCZX_INFLIGHT_STUCK_MS = 180_000

/** 常驻 Python worker 池：避免每包冷启动 UnityPy（包级并发仍 ≤ JCZX_MAX_CONCURRENT）。 */
class JczxWorkerPool {
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
      env: { ...process.env },
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
    child.stderr.on('data', () => {})
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
    if (this.workers.length < this.size) return this._spawnOne()
    return new Promise(resolve => this.waiters.push(resolve))
  }
  runJob(src, outDir, rel) {
    if (this.closed) return Promise.resolve({ ok: false, error: 'pool closed' })
    return this._acquire().then(child => new Promise(resolve => {
      child._pending = { resolve }
      try {
        child.stdin.write(JSON.stringify({ src, outDir, rel }) + '\n')
      } catch (e) {
        child._pending = null
        resolve({ ok: false, error: String(e) })
        this._release(child)
      }
    }))
  }
}
const jczxPoolsByPy = new Map()
function getJczxPool(py) {
  let pool = jczxPoolsByPy.get(py)
  if (!pool || pool.closed) {
    pool = new JczxWorkerPool(py, JCZX_MAX_CONCURRENT)
    jczxPoolsByPy.set(py, pool)
  }
  return pool
}

const PRI_NORMAL = 0
const PRI_HIGH = 1_000_000
let globalSeq = 0
const rootStates = new Map()

function getJczxState(rootPath) {
  const key = path.resolve(rootPath)
  let st = rootStates.get(key)
  if (!st) {
    st = {
      rootPath: key,
      queue: [],
      inFlight: new Map(), // rel -> { abs, rel, startedAt }
      known: new Map(),
      found: 0,
      reused: 0,
      extracted: 0,
      failed: 0,
      skippedNoSpine: 0,
      errors: [],
      extractedList: [],
      reusedList: [],
      py: null,
      pumping: false,
    }
    rootStates.set(key, st)
  }
  return st
}

function enqueueJczx(st, abs, rel, priority) {
  if (st.inFlight.has(rel)) return
  const existing = st.queue.find(q => q.rel === rel)
  if (existing) {
    if (priority > existing.priority) existing.priority = priority
    st.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq)
    return
  }
  const item = { abs, rel, priority, seq: ++globalSeq }
  st.known.set(rel, item)
  st.queue.push(item)
  st.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq)
}

async function runJczxOne(st, job) {
  try {
    const r = await ensureJczxExtracted(job.abs, st.rootPath, { python: st.py, autoSetup: false })
    const one = {
      src: job.abs,
      cacheDir: r.cacheDir,
      // 二进制 .skel（1.07 修复后才有）与 JSON 骨架都带 spine 版本，任取一个
      spine: (r.report?.exported?.find(x => x.kind === 'json')
        || r.report?.exported?.find(x => x.kind === 'skel'))?.spine || null,
    }
    if (r.reused) { st.reused++; st.reusedList.push(one) }
    else { st.extracted++; st.extractedList.push(one) }
  } catch (err) {
    // 有 extract report 但 ok=false → 包里本来就没有骨架（`textures_bigs_…` 这种纯贴图包
    // 只有 Texture2D，JCZX 里一大把）—— 正常现象，**不进 errors**，否则前端会弹一句
    // 「JCZX 提取失败：…」吓人（用户截图里出现过）。其它硬错误才算 failed。
    if (err && err.report && err.report.ok === false) st.skippedNoSpine++
    else st.failed++
    if (!(err && err.report && err.report.ok === false)) {
      st.errors.push({ src: job.abs, error: (err && err.message) || String(err) })
    }
  }
}

function sweepStuckJczx(st) {
  const now = Date.now()
  for (const [rel, info] of [...st.inFlight.entries()]) {
    const started = (info && info.startedAt) || 0
    if (started && now - started > JCZX_INFLIGHT_STUCK_MS) {
      st.inFlight.delete(rel)
      st.failed++
      st.errors.push({ src: info.abs || rel, error: `inFlight timeout >${JCZX_INFLIGHT_STUCK_MS / 1000}s` })
    }
  }
}

function pumpJczx(st) {
  if (st.pumping) return
  st.pumping = true
  sweepStuckJczx(st)
  while (st.inFlight.size < JCZX_MAX_CONCURRENT && st.queue.length) {
    const job = st.queue.shift()
    if (st.inFlight.has(job.rel)) continue
    st.inFlight.set(job.rel, { abs: job.abs, rel: job.rel, startedAt: Date.now() })
    ;(async () => {
      try { await runJczxOne(st, job) }
      finally {
        st.inFlight.delete(job.rel)
        st.pumping = false
        pumpJczx(st)
      }
    })()
  }
  st.pumping = false
}

export function getJczxUnpackProgress(rootPath) {
  const st = getJczxState(rootPath)
  sweepStuckJczx(st)
  const pending = st.queue.length
  const inFlight = st.inFlight.size
  // 包处理进度：成功复用/新建 + 无 spine 跳过 + 失败，都算「处理完」
  const done = st.reused + st.extracted + st.failed + st.skippedNoSpine
  const playableDone = st.reused + st.extracted
  const total = Math.max(st.found, done + pending + inFlight)
  const pendingRels = st.queue.map(q => q.rel).concat([...st.inFlight.keys()])
  const currentRels = [...st.inFlight.keys()]
  return {
    bundles: st.found,
    found: st.found,
    reused: st.reusedList,
    extracted: st.extractedList,
    reusedCount: st.reused,
    extractedCount: st.extracted,
    failed: st.failed,
    skippedNoSpine: st.skippedNoSpine,
    pending,
    inFlight,
    done,
    playableDone,
    total,
    ready: pending === 0 && inFlight === 0,
    ok: st.errors.length === 0,
    cacheDir: JCZX_CACHE_DIRNAME,
    limit: JCZX_MAX_CONCURRENT,
    errors: st.errors.slice(0, 8),
    pendingRels,
    currentRels,
    current: currentRels.map(r => r.split(/[/\\]/).pop()),
    python: st.py,
  }
}

export function prioritizeJczxUnpack(rootPath, rels = []) {
  const st = getJczxState(rootPath)
  let bumped = 0
  for (const rel of rels || []) {
    if (!rel) continue
    const r = String(rel).replace(/\\/g, '/')
    const known = st.known.get(r)
    const abs = known?.abs || path.join(rootPath, r)
    if (st.inFlight.has(r)) { bumped++; continue }
    if (fs.existsSync(abs)) {
      enqueueJczx(st, abs, r, PRI_HIGH + (++globalSeq))
      bumped++
    }
  }
  pumpJczx(st)
  return { bumped, ...getJczxUnpackProgress(rootPath) }
}

async function stampLooksReusable(abAbs, rootPath) {
  try {
    const st = await fsp.stat(abAbs)
    const cacheDir = cacheDirFor(rootPath, abAbs)
    const stampPath = path.join(cacheDir, '.stamp.json')
    if (!fs.existsSync(stampPath)) return false
    const stamp = JSON.parse(await fsp.readFile(stampPath, 'utf8'))
    if (!(stamp.ok && stamp.size === st.size && stamp.mtimeMs === st.mtimeMs)) return false
    // 光 stamp 说 ok 不够：早期版本只认 JSON 骨架，二进制 `.skel` 被当「其它 TextAsset」
    // 丢掉了 —— 那些缓存 stamp.ok=true 但目录里根本没有骨架，必须重解。
    // （与安卓侧 JczxExtractor.outputsComplete 同一条判据。）
    return await cacheHasViewable(cacheDir, stamp)
  } catch { return false }
}

/** 缓存里有骨架，或是已标记的纯 CG（只有 png）。 */
export async function cacheHasViewable(cacheDir, stamp) {
  if (await cacheHasSkeleton(cacheDir)) return true
  const imageOnly = !!(stamp && stamp.report && stamp.report.imageOnly)
  if (!imageOnly) return false
  try {
    for (const name of await fsp.readdir(cacheDir)) {
      if (name.startsWith('.')) continue
      if (name.toLowerCase().endsWith('.png') && name.toLowerCase() !== 'thumb.png') return true
    }
  } catch { /* ignore */ }
  return false
}

/** 缓存目录里是不是真有骨架文件（.skel 或 .json，排除点开头的 meta）。 */
export async function cacheHasSkeleton(cacheDir) {
  try {
    for (const name of await fsp.readdir(cacheDir)) {
      if (name.startsWith('.')) continue
      const low = name.toLowerCase()
      if (low.endsWith('.skel') || low.endsWith('.json')) return true
    }
  } catch { /* 读不了就当没有 */ }
  return false
}

/**
 * 扫描前预处理：把根下 JCZX AB 排进优先级队列并开始解包（并发 ≤ 10）。
 * **立即返回**：已就绪的 `bd2viewer-jczx/` 立刻进入 walk；未解完的后台续解，
 * 前端用进度条 + 轮询重扫增量刷新。旧实现同步等完全部包 → gallery 显示 0 L2D。
 */
export async function prepareJczxRoot(rootPath, { maxDepth = 5, python, autoSetup = true, onLog } = {}) {
  const logs = []
  const log = (msg) => {
    logs.push(msg)
    if (onLog) onLog(msg)
    else console.log(`[jczx] ${msg}`)
  }

  try {
    if (migrateLegacyJczxCache(rootPath)) log('migrated legacy .bd2viewer-jczx → bd2viewer-jczx')
  } catch (e) {
    log('legacy cache migrate skipped: ' + (e.message || e))
  }

  let py = python
  let setupMeta = null
  if (!py) {
    const ensured = await ensureJczxPython({ autoSetup, onLog: log })
    py = ensured.python
    setupMeta = ensured.setup || null
    if (!ensured.probe?.ok) {
      return {
        bundles: 0, found: 0, extracted: [], reused: [],
        errors: [{
          src: null,
          error: setupMeta?.message
            || `未找到带 UnityPy 的 Python（尝试：${py}）。请运行 setup_jczx.bat / setup_jczx.sh（需联网一次），或设置可选的 BD2_JCZX_PYTHON。`,
        }],
        setup: setupMeta, python: py, logs,
        pending: 0, done: 0, total: 0, ready: false, ok: false,
      }
    }
  }

  const st = getJczxState(rootPath)
  st.py = py
  sweepStuckJczx(st)
  const busy = st.queue.length > 0 || st.inFlight.size > 0
  if (busy && st.found > 0 && st.lastFullPrepareAt && (Date.now() - st.lastFullPrepareAt) < 20000) {
    const snap = getJczxUnpackProgress(rootPath)
    log(`prepare skip (queue busy): done=${snap.done}/${snap.total}`)
    return { ...snap, setup: setupMeta, python: py, logs, skippedRescan: true }
  }
  // 新一轮 full prepare：清计数（保留仍在飞/已排队的 job，避免丢工作）
  st.extracted = 0
  st.failed = 0
  st.skippedNoSpine = 0
  st.errors = []
  st.extractedList = []
  st.reusedList = []
  st.reused = 0

  const bundles = await findJczxBundles(rootPath, maxDepth)
  st.found = bundles.length

  let reused = 0
  const todo = []
  const live = new Set()
  const seenFp = new Set()
  let skippedDup = 0
  for (const ab of bundles) {
    const rel = path.relative(rootPath, ab).split(path.sep).join('/')
    live.add(rel)
    let fp = null
    try {
      const stt = await fsp.stat(ab)
      fp = await packFingerprint(ab, stt.size)
    } catch { /* */ }
    if (fp && seenFp.has(fp)) {
      skippedDup++
      continue
    }
    if (fp) seenFp.add(fp)
    st.known.set(rel, { abs: ab, rel, priority: PRI_NORMAL, seq: 0, fp })
    if (await stampLooksReusable(ab, rootPath)) { reused++; continue }
    todo.push({ abs: ab, rel })
  }
  if (skippedDup) {
    st.skippedDup = (st.skippedDup || 0) + skippedDup
    if (onLog) onLog(`[jczx] dedupe skipped ${skippedDup} duplicate pack(s)`)
  }
  // 丢掉已不在盘上的已知项（防 NIKKE 包曾误入队后残留）
  for (const rel of [...st.known.keys()]) {
    if (!live.has(rel)) st.known.delete(rel)
  }
  st.queue = st.queue.filter(q => live.has(q.rel))
  st.reused = reused

  for (const b of todo) enqueueJczx(st, b.abs, b.rel, PRI_NORMAL)
  pumpJczx(st)

  st.lastFullPrepareAt = Date.now()
  const snap = getJczxUnpackProgress(rootPath)
  log(`queue: done=${snap.done}/${snap.total} inFlight=${snap.inFlight} pending=${snap.pending}`)
  return { ...snap, setup: setupMeta, python: py, logs }
}
