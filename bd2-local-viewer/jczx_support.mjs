/**
 * JCZX（交错战线）桌面提取支持：双 UnityFS MIT strip + 调 UnityPy 抽到缓存。
 * 仅 Node 侧使用；产物落在根目录下 `bd2viewer-jczx/`（无前导点，避免 Android WebView
 * 加载 /.dot-dir/ 路径失败）。旧版 `.bd2viewer-jczx/` 仍识别并在 prepare 时迁移。
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
    r.includes(JCZX_CACHE_DIRNAME + '/') ||
    r === JCZX_CACHE_DIRNAME_LEGACY || r.startsWith(JCZX_CACHE_DIRNAME_LEGACY + '/') ||
    r.includes(JCZX_CACHE_DIRNAME_LEGACY + '/')
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
  if (/^prefabs_spine_/i.test(name)) return true
  if (/\.(ab|unity3d|bundle|assets)$/i.test(l)) return true
  // 无扩展名：交由魔数判定
  if (!path.extname(name)) return true
  return false
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

function cacheDirFor(rootPath, abAbs) {
  const rel = path.relative(rootPath, abAbs)
  const key = rel.split(path.sep).join('__').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
  const hash = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 10)
  return path.join(rootPath, JCZX_CACHE_DIRNAME, `${hash}_${key}`)
}

function runExtract(py, src, outDir) {
  return new Promise((resolve) => {
    const reportPath = path.join(outDir, '.extract_report.json')
    const child = spawn(py, [EXTRACT_PY, src, outDir, '--report', reportPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => {
      let report = null
      try {
        if (fs.existsSync(reportPath)) report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
        else if (stdout.trim()) report = JSON.parse(stdout.trim().split('\n').pop())
      } catch { /* ignore */ }
      resolve({ code, stdout, stderr, report })
    })
    child.on('error', err => {
      resolve({ code: -1, stdout, stderr: String(err), report: null })
    })
  })
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
      if (stamp.ok && stamp.size === st.size && stamp.mtimeMs === st.mtimeMs) {
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
      if (isJczxCacheDirName(ent.name) || ent.name === 'node_modules' || ent.name === '.git'
        || ent.name === JCZX_VENV_DIRNAME) continue
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(abs, depth + 1)
        continue
      }
      if (!ent.isFile()) continue
      if (!isJczxName(ent.name)) continue
      if (await looksLikeUnityFS(abs)) out.push(abs)
    }
  }
  await walk(rootPath, 0)
  return out
}

/**
 * 扫描前预处理：把根下所有 JCZX AB 抽到 `bd2viewer-jczx/`。
 * 返回 { bundles, extracted, reused, errors, setup, python }
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
        bundles: 0,
        extracted: [],
        reused: [],
        errors: [{
          src: null,
          error: setupMeta?.message
            || `未找到带 UnityPy 的 Python（尝试：${py}）。请运行 setup_jczx.bat / setup_jczx.sh（需联网一次），或设置可选的 BD2_JCZX_PYTHON。`,
        }],
        setup: setupMeta,
        python: py,
        logs,
      }
    }
  }

  const bundles = await findJczxBundles(rootPath, maxDepth)
  const extracted = []
  const reused = []
  const errors = []
  for (const ab of bundles) {
    try {
      const r = await ensureJczxExtracted(ab, rootPath, { python: py, autoSetup: false })
      ;(r.reused ? reused : extracted).push({
        src: ab,
        cacheDir: r.cacheDir,
        spine: r.report?.exported?.find(x => x.kind === 'json')?.spine || null,
      })
    } catch (err) {
      errors.push({ src: ab, error: err.message })
    }
  }
  return { bundles: bundles.length, extracted, reused, errors, setup: setupMeta, python: py, logs }
}
