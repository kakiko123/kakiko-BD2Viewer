/**
 * 碧蓝航线图鉴：把「按层堆放」就地收成三层目录。
 *
 *   角色/<id>__<中文名>/<皮肤N>/原皮/<形态>/
 *   角色/<id>__<中文名>/<皮肤N>/mod1/<包名>@@<形态>/
 *   角色/<id>__<中文名>/<皮肤N>/mod2/<包名>@@<形态>/
 *   图鉴/头像|背景|漫画|插画/原皮/
 *
 * 皮肤槽：base / 1 → 皮肤1，以数字开头的（2、2_n、3_hx）→ 皮肤2 / 皮肤3，
 * 其余（jz、rw、hx）→ 皮肤_<代号>。
 * 第三层：runtime = 原皮；mods/角色 = mod1；mods/其他/modN = modN。
 * 角色级的 meta.json / voice 放在角色目录下，不塞进某一张皮肤。
 *
 *   node _tools/al_reorg.mjs --plan
 *   node _tools/al_reorg.mjs --apply
 *   node _tools/al_reorg.mjs --undo
 *
 * 日志：<根>/_al_reorg_log.tsv （from \\t to）。只 rename，不复制。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.env.AL_ROOT || 'C:/Users/KAKIKO/Videos/新建文件夹')
const LOG = path.join(ROOT, '_al_reorg_log.tsv')
const mode = ['--plan', '--apply', '--undo'].find(a => process.argv.includes(a))
if (!mode) {
  console.log('用法：--plan | --apply | --undo')
  process.exit(0)
}
if (!fs.existsSync(ROOT)) {
  console.error('没有素材根：' + ROOT)
  process.exit(1)
}

const safeName = s => String(s || '')
  .replace(/[\\/:*?"<>|]/g, '_')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 80)

function skinSlot(token) {
  const t = String(token || '').trim()
  if (!t || t === 'base' || t === '1') return '皮肤1'
  const m = /^(\d+)/.exec(t)
  if (m) return '皮肤' + m[1]
  return '皮肤_' + safeName(t)
}

function relKey(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
}

const SKIP_KEYS = new Set([
  'live2dRuntime', 'spineAssets', 'staticAssets', 'searchTokens',
  'animations', 'hitAreas', 'motions', 'playableMotions', 'clipMotions',
  'spineUnity', 'clean', 'materials',
])

function shortToken(v) {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  if (!s || s.includes('/') || s.includes('\\') || s.length > 48) return ''
  return s
}

function tailKey(runtime) {
  const s = String(runtime || '').replace(/\\/g, '/')
  const m = /mods\/(?:角色|其他)\/.+$/i.exec(s)
  return (m ? m[0] : s).replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
}

function layerOfRel(rel) {
  const s = tailKey(rel)
  const m = /(?:^|\/)mods\/其他\/(mod\d+)\//.exec(s)
  if (m) return m[1]
  if (/(?:^|\/)mods\/角色\//.test(s)) return 'mod1'
  return ''
}

/* ---------------------------------------------------------------- 索引 */

function loadNames() {
  const idx = readJson(path.join(ROOT, 'data/api/index.json'))
  const map = new Map()
  for (const c of idx.characters || []) {
    if (!c || !c.id) continue
    map.set(c.id, safeName(c.localizedName || c.name || c.id) || c.id)
  }
  return map
}

function loadModIndex() {
  const dir = path.join(ROOT, 'data/api/characters')
  const byRuntime = new Map()
  if (!fs.existsSync(dir)) return byRuntime
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const charId = name.slice(0, -'.json'.length)
    let data
    try { data = readJson(path.join(dir, name)) } catch { continue }
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const x of node) walk(x)
        return
      }
      const runtime = node.runtimeDir || node.sourcePath
      if (typeof runtime === 'string' && (node.modId || node.sourceMod2Id)) {
        const token = shortToken(node.bundleName) || shortToken(node.variantSuffix)
          || shortToken(node.formFileName) || ''
        const layer = layerOfRel(runtime)
        const rec = { charId, token, layer, modId: String(node.sourceMod2Id || node.modId || '') }
        const key = tailKey(runtime)
        if (key && !byRuntime.has(key)) byRuntime.set(key, rec)
        const parent = key.replace(/\/runtime$/, '')
        if (parent && parent !== key && !byRuntime.has(parent)) byRuntime.set(parent, rec)
      }
      for (const k of Object.keys(node)) {
        if (SKIP_KEYS.has(k)) continue
        const v = node[k]
        if (v && typeof v === 'object') walk(v)
      }
    }
    walk(data)
  }
  return byRuntime
}

/* ---------------------------------------------------------------- 计划 */

const ops = []
const notes = []
function addDir(from, to, kind) {
  if (!from || !to) return
  const a = path.resolve(from)
  const b = path.resolve(to)
  if (a.toLowerCase() === b.toLowerCase()) return
  ops.push({ from: a, to: b, kind, dir: true })
}
function addFile(from, to, kind) {
  if (!from || !to) return
  const a = path.resolve(from)
  const b = path.resolve(to)
  if (a.toLowerCase() === b.toLowerCase()) return
  ops.push({ from: a, to: b, kind, dir: false })
}

function charLeaf(id, names) {
  const zh = names.get(id)
  return zh && zh !== id ? `${safeName(id)}__${zh}` : safeName(id)
}

function listDir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }) } catch { return [] }
}

function matchCharToken(text, charIds) {
  const s = String(text || '')
  const ids = [...charIds].sort((a, b) => b.length - a.length)
  for (const id of ids) {
    if (s !== id && !s.startsWith(id + '_') && !s.startsWith(id)) continue
    const rest = s.slice(id.length).replace(/^[_-]/, '')
    const m = /^(\d+)/.exec(rest)
    return { id, token: m ? m[1] : 'base' }
  }
  return null
}

function guessTokenFromFiles(charIds, dir) {
  for (const base of [dir, path.join(dir, 'runtime')]) {
    for (const name of ['mod.json', 'mod2.json', 'mod3.json', 'mod4.json']) {
      const p = path.join(base, name)
      if (!fs.existsSync(p)) continue
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'))
        const hit = matchCharToken(j.label || j.sourceGroup || j.id || '', charIds)
        if (hit) return hit
      } catch { /* 读不到就继续猜文件名 */ }
    }
  }
  const names = []
  const pull = (d, depth) => {
    if (depth > 4) return
    for (const e of listDir(d)) {
      if (e.isDirectory()) pull(path.join(d, e.name), depth + 1)
      else names.push(e.name)
      if (names.length > 40) return
    }
  }
  pull(dir, 0)
  for (const fileName of names) {
    const stem = fileName.replace(/\.(moc3|atlas|skel|png|json)$/i, '')
    const hit = matchCharToken(stem, charIds)
    if (hit) return hit
  }
  return null
}

function planOfficial(names) {
  const root = path.join(ROOT, 'runtime', '角色')
  if (!fs.existsSync(root)) { notes.push('没有 runtime/角色'); return }
  for (const id of fs.readdirSync(root)) {
    const base = path.join(root, id)
    if (!fs.statSync(base).isDirectory()) continue
    const leaf = path.join(ROOT, '角色', charLeaf(id, names))
    const meta = path.join(base, 'meta.json')
    if (fs.existsSync(meta)) addFile(meta, path.join(leaf, 'meta.json'), 'meta')
    const rt = path.join(base, 'runtime')
    if (!fs.existsSync(rt)) continue
    const voice = path.join(rt, 'voice')
    if (fs.existsSync(voice)) addDir(voice, path.join(leaf, 'voice'), 'voice')
    for (const extra of ['build_summary.json', 'README.md']) {
      const p = path.join(rt, extra)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) addFile(p, path.join(leaf, extra), 'meta')
    }
    for (const bucket of ['spinepainting', 'spine', 'live2d']) {
      const dir = path.join(rt, bucket)
      if (!fs.existsSync(dir)) continue
      for (const token of fs.readdirSync(dir)) {
        const src = path.join(dir, token)
        if (!fs.statSync(src).isDirectory()) continue
        const dest = path.join(leaf, skinSlot(token), '原皮', token)
        addDir(src, dest, bucket === 'live2d' ? 'live2d' : 'spine')
      }
    }
    const painting = path.join(rt, 'painting')
    if (fs.existsSync(painting)) {
      for (const name of fs.readdirSync(painting)) {
        const src = path.join(painting, name)
        if (!fs.statSync(src).isFile()) continue
        const token = name.replace(/\.card(?=\.png$)/i, '').replace(/\.png$/i, '')
        addFile(src, path.join(leaf, skinSlot(token), '原皮', 'paint', name), 'painting')
      }
    }
  }
}

function lookupPack(modIndex, packDir) {
  const rel = tailKey(path.relative(ROOT, packDir))
  return modIndex.get(rel) || modIndex.get(rel + '/runtime') || modIndex.get(rel.replace(/\/runtime$/, '')) || null
}

/** 一个 mod 包里按形态拆开的目录：runtime/live2d/<形态>、runtime/spinepainting/<形态>。 */
function tokenDirs(packDir) {
  const out = []
  const roots = [packDir, path.join(packDir, 'runtime')]
  for (const base of roots) {
    for (const bucket of ['live2d', 'spinepainting', 'spine', 'painting']) {
      const dir = path.join(base, bucket)
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
      for (const name of fs.readdirSync(dir)) {
        const src = path.join(dir, name)
        if (!fs.statSync(src).isDirectory() && bucket !== 'painting') continue
        if (fs.statSync(src).isDirectory()) out.push({ token: name, src, bucket })
      }
    }
  }
  return out
}

function planOnePack(packDir, layer, modIndex, names, forcedCharId) {
  const packId = path.basename(packDir)
  const api = lookupPack(modIndex, packDir) || lookupPack(modIndex, path.join(packDir, 'runtime'))
  const guess = (api && api.charId) ? null : guessTokenFromFiles(names.keys(), packDir)
  const charId = forcedCharId || (api && api.charId) || (guess && guess.id) || ''
  if (!charId) {
    notes.push('未归属 ' + path.relative(ROOT, packDir))
    addDir(packDir, path.join(ROOT, '角色', '_未归属', layer, packId), 'unmapped')
    return
  }
  const tokens = tokenDirs(packDir)
  const apiToken = api && api.token
  if (!tokens.length) {
    const used = apiToken || (guess && guess.token) || 'base'
    addDir(packDir, path.join(ROOT, '角色', charLeaf(charId, names), skinSlot(used), layer, `${packId}@@${used}`), 'mod')
    return
  }
  const seen = new Set()
  for (const part of tokens) {
    // 索引写明了皮肤号时以索引为准（磁盘上常把换装放在 live2d/base）。
    const token = apiToken || part.token
    const key = token + '|' + part.src
    if (seen.has(key)) continue
    seen.add(key)
    const dest = path.join(ROOT, '角色', charLeaf(charId, names), skinSlot(token), layer, `${packId}@@${token}`)
    if (part.bucket === 'painting') {
      addDir(part.src, path.join(dest, 'paint'), 'mod')
    } else {
      addDir(part.src, dest, 'mod')
    }
  }
}

function planMods(modIndex, names) {
  const charRoot = path.join(ROOT, 'mods', '角色')
  if (fs.existsSync(charRoot)) {
    for (const id of fs.readdirSync(charRoot)) {
      const dir = path.join(charRoot, id)
      if (!fs.statSync(dir).isDirectory()) continue
      for (const pack of fs.readdirSync(dir)) {
        const packDir = path.join(dir, pack)
        if (!fs.statSync(packDir).isDirectory()) continue
        planOnePack(packDir, 'mod1', modIndex, names, id)
      }
    }
  }
  const other = path.join(ROOT, 'mods', '其他')
  if (!fs.existsSync(other)) return
  for (const layer of fs.readdirSync(other)) {
    if (!/^mod\d+$/i.test(layer)) {
      notes.push('跳过 mods/其他/' + layer)
      continue
    }
    const layerDir = path.join(other, layer)
    if (!fs.statSync(layerDir).isDirectory()) continue
    for (const pack of fs.readdirSync(layerDir)) {
      const packDir = path.join(layerDir, pack)
      if (!fs.statSync(packDir).isDirectory()) continue
      planOnePack(packDir, layer.toLowerCase(), modIndex, names, '')
    }
  }
}

function planGallery() {
  const src = path.join(ROOT, 'runtime', '画册')
  if (!fs.existsSync(src)) { notes.push('没有 runtime/画册'); return }
  const map = {
    avatars: '头像',
    backgrounds: '背景',
    manga: '漫画',
    pictures: '插画',
  }
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name)
    const label = map[name]
    if (!label) {
      notes.push('画册未识别分类 ' + name)
      addDir(from, path.join(ROOT, '图鉴', '_其他', '原皮', name), 'gallery')
      continue
    }
    addDir(from, path.join(ROOT, '图鉴', label, '原皮'), 'gallery')
  }
}

/* ---------------------------------------------------------------- 执行 */

function ensureParent(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
}

function moveOne(from, to) {
  ensureParent(to)
  if (fs.existsSync(to)) {
    const st = fs.statSync(from)
    if (st.isDirectory() && fs.statSync(to).isDirectory()) {
      for (const name of fs.readdirSync(from)) {
        moveOne(path.join(from, name), path.join(to, name))
      }
      fs.rmdirSync(from)
      return
    }
    throw new Error('目标已存在 ' + to)
  }
  try {
    fs.renameSync(from, to)
  } catch (err) {
    if (err && (err.code === 'ENAMETOOLONG' || err.code === 'ENOENT')) {
      const pref = p => (process.platform === 'win32' ? '\\\\?\\' + path.resolve(p) : p)
      fs.renameSync(pref(from), pref(to))
      return
    }
    throw err
  }
}

function summarize() {
  const by = new Map()
  for (const op of ops) by.set(op.kind, (by.get(op.kind) || 0) + 1)
  console.log('根目录 ' + ROOT)
  console.log('计划 ' + ops.length + ' 次移动')
  for (const [k, n] of [...by.entries()].sort((a, b) => b[1] - a[1])) console.log('  ' + k + '  ' + n)
  console.log('备注 ' + notes.length)
  for (const n of notes.slice(0, 30)) console.log('  ' + n)
  if (notes.length > 30) console.log('  …还有 ' + (notes.length - 30) + ' 条')
  const tos = new Map()
  for (const op of ops) {
    const k = op.to.toLowerCase()
    const arr = tos.get(k)
    if (arr) arr.push(op.from)
    else tos.set(k, [op.from])
  }
  const dups = [...tos.entries()].filter(([, v]) => v.length > 1)
  console.log('同一目标 ' + dups.length)
  for (const [to, froms] of dups.slice(0, 8)) {
    console.log('  ' + path.relative(ROOT, to))
    for (const f of froms) console.log('    ' + path.relative(ROOT, f))
  }
  console.log('样例')
  for (const op of ops.filter(o => o.kind === 'mod').slice(0, 4)) {
    console.log('  ' + path.relative(ROOT, op.from) + '  →  ' + path.relative(ROOT, op.to))
  }
  for (const op of ops.filter(o => o.kind === 'gallery')) {
    console.log('  ' + path.relative(ROOT, op.from) + '  →  ' + path.relative(ROOT, op.to))
  }
}

function applyOps() {
  const lines = []
  let done = 0
  let missing = 0
  for (const op of ops) {
    if (!fs.existsSync(op.from)) { missing++; continue }
    moveOne(op.from, op.to)
    lines.push(op.from + '\t' + op.to)
    done++
    if (done % 400 === 0) console.log('已移动 ' + done)
  }
  if (lines.length) {
    fs.appendFileSync(LOG, lines.join('\n') + '\n', 'utf8')
  }
  console.log('完成 ' + done + '，源已不在 ' + missing + '，日志 ' + LOG)
}

function removeEmpty(dir, stop) {
  if (!fs.existsSync(dir)) return
  for (const e of listDir(dir)) {
    if (e.isDirectory()) removeEmpty(path.join(dir, e.name), stop)
  }
  if (path.resolve(dir) === path.resolve(stop)) return
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
}

if (mode === '--undo') {
  if (!fs.existsSync(LOG)) { console.error('没有日志 ' + LOG); process.exit(1) }
  const rows = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean)
  let n = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const [from, to] = rows[i].split('\t')
    if (!from || !to || !fs.existsSync(to)) continue
    ensureParent(from)
    if (fs.existsSync(from)) { console.log('撤销时源还在，跳过 ' + from); continue }
    fs.renameSync(to, from)
    n++
  }
  console.log('撤销 ' + n + ' 条')
  process.exit(0)
}

const names = loadNames()
console.log('角色名 ' + names.size)
const modIndex = loadModIndex()
console.log('mod 索引 ' + modIndex.size)
planOfficial(names)
planMods(modIndex, names)
planGallery()
summarize()
if (mode === '--apply') {
  applyOps()
  for (const d of ['runtime/角色', 'runtime/画册', 'mods/角色', 'mods/其他', 'mods', 'runtime']) {
    const abs = path.join(ROOT, d)
    if (fs.existsSync(abs)) removeEmpty(abs, ROOT)
  }
}
