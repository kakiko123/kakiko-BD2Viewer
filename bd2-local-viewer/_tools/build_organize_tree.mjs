/**
 * 「整理树」生成器 —— 把图鉴发布包的 `source|mod1|mod2` 三层，重排成
 *   角色/<ID>__<中文名>/<姿势>/原图|mod-<id>__<包名>/
 *   画册/<cgN>__<中文名>/<姿势>/原图|mod-<id>__<包名>/
 *
 * ⚠️ 姿势归属**只信索引**，不靠文件名猜：
 *   · mod 的姿势 = `data/mod_runtime_index.json` 里该 mod 的 `targetBundle`（权威）
 *   · 原图的姿势 = `public/runtime/index.json` / `mod_runtime_index` 里该角色的 spineBundles
 * 名字：角色中文名来自 `data/biligame_character_catalog.json`（nameEn→nameZh）。
 *
 * 两种模式：
 *   node _tools/build_organize_tree.mjs 10010              # 干跑：在 _scratch 里用硬链接搭样例（不碰素材）
 *   node _tools/build_organize_tree.mjs --all --out <目录>  # 全量搭到指定目录（同样默认硬链接）
 * 只用硬链接，原素材一个字节都不动。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SRC = process.env.BD2_JCZX_ROOT || 'C:/Users/KAKIKO/Videos/新建文件夹/交错战线图鉴-20260917'

const args = process.argv.slice(2)
const ALL = args.includes('--all')
const outIdx = args.indexOf('--out')
const OUT = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(REPO, '_scratch', '整理树样例')
const ONLY = args.filter(a => !a.startsWith('--') && a !== (outIdx >= 0 ? args[outIdx + 1] : ''))[0] || '10010'

const jread = p => JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''))
const jreadSafe = p => { try { return jread(p) } catch { return null } }

/* ---------------------------------------------------------------- 索引 */
const modIndex = jreadSafe(path.join(SRC, 'data/mod_runtime_index.json')) || { characters: [], archives: [] }
const charCat = jreadSafe(path.join(SRC, 'data/biligame_character_catalog.json')) || { characters: [] }

/** 归一化键：小写去非字母数字 */
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** 角色中文名：角色 id → 名字。走 bundle 里的皮肤代号 → nameEn → nameZh */
const charZhById = new Map()
const zhByNameEn = new Map()
for (const c of (charCat.characters || [])) {
  if (c && c.nameEn && c.nameZh) zhByNameEn.set(norm(c.nameEn), c.nameZh)
}
/** 皮肤代号（`alps03`）→ 去掉尾数字母（`alps`） */
const skinBase = code => String(code || '').replace(/\d.*$/, '')
const zhForSkin = code => zhByNameEn.get(norm(skinBase(code))) || zhByNameEn.get(norm(code)) || null

/** bundle 名 → 皮肤代号：`prefabs_spine_10010_skin_alps03_spine` → `alps03` */
function bundleSkin(bundle) {
  const m = /_skin_([a-z0-9]+)/i.exec(String(bundle || ''))
  if (m) return m[1].toLowerCase()
  const t = String(bundle || '').replace(/^prefabs_spine_/i, '').replace(/_spine$/i, '')
  return t.toLowerCase()
}
/** 人读的姿势目录名：`alps03` → `alps03__阿尔卑斯`（查不到中文就只用代号） */
const poseDirName = bundle => {
  const code = bundleSkin(bundle)
  const zh = zhForSkin(code)
  return zh ? `${code}__${zh}` : code
}
/** 目录名消毒：Windows 不允许 \ / : * ? " < > | */
const safeName = s => String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60)
/** mod 目录名：`mod-1ab28bbfc1__阿尔卑斯-醉心可人（带预览）` */
const modDirName = (modId, packageName) => {
  const pkg = safeName(packageName)
  return pkg && pkg !== '根目录' ? `${modId}__${pkg}` : modId
}

/* ---------------------------------------------------------------- 建树 */
const link = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (fs.existsSync(to)) return false
  try { fs.linkSync(from, to) } catch { fs.copyFileSync(from, to) }
  return true
}

const stats = { files: 0, unposed: 0, missing: 0 }
const unposedSamples = []

/** 把 `<layer>/<类别>/<ID>/[mod-xxx/]runtime/` 里的文件按姿势分发 */
function placeCharacter(id, zh) {
  const leaf = zh ? `${id}__${zh}` : id
  const info = (modIndex.characters || []).find(x => String(x.characterId) === String(id))
  const bundles = new Set()
  for (const md of (info?.mods || [])) if (md.targetBundle) bundles.add(md.targetBundle)
  // 原图侧的 bundle：问 runtime 索引拿不到（只有 10010 有），退而用 spineBundles / 文件名兜
  const rtIdx = jreadSafe(path.join(SRC, 'public/runtime/index.json'))
  const rtCh = (rtIdx?.characters || []).find(x => String(x.id) === String(id))
  for (const b of (rtCh?.spineBundles || [])) bundles.add(b)

  /**
   * 文件 → 姿势 bundle。
   * ⚠️ 必须**先长后短**匹配 + 校验词边界：`alps` 是 `alps06` 的子串，
   * 只做 `includes` 会让 alps03~06 的原图全被 `alps` 那个 bundle 抢走
   * （干跑样例里 alps06 缺 `原图/` 就是这么来的）。
   */
  const cands = [...bundles].map(b => ({ b, code: bundleSkin(b) }))
    .sort((x, y) => y.code.length - x.code.length)
  const boundaryOk = (s, i, len) => {
    const after = s[i + len]
    return after === undefined || !/[a-z0-9]/.test(after)
  }
  const poseOfFile = name => {
    const n = String(name).toLowerCase()
    for (const { b, code } of cands) {
      const base = b.toLowerCase()
      const i = n.indexOf(base)
      if (i >= 0 && boundaryOk(n, i, base.length)) return b
      if (code) {
        const j = n.indexOf(code)
        if (j >= 0 && boundaryOk(n, j, code.length)) return b
      }
    }
    return null
  }

  /* ① 原图：source/<类别>/<ID>/runtime 是**平铺**的，按姿势分发 */
  const srcDir = path.join(SRC, 'source', '角色', id)
  const srcRt = path.join(srcDir, 'runtime')
  if (fs.existsSync(srcRt)) {
    for (const f of fs.readdirSync(srcRt)) {
      if (!fs.statSync(path.join(srcRt, f)).isFile()) continue
      const b = poseOfFile(f)
      const destDir = b ? path.join(OUT, '角色', leaf, poseDirName(b), '原图')
        : path.join(OUT, '角色', leaf, '_未分姿势', '原图')
      if (!b) { stats.unposed++; if (unposedSamples.length < 6) unposedSamples.push(`角色/${id}/${f}`) }
      if (link(path.join(srcRt, f), path.join(destDir, f))) stats.files++
    }
  }
  const meta = path.join(srcDir, 'meta.json')
  if (fs.existsSync(meta)) { if (link(meta, path.join(OUT, '角色', leaf, 'meta.json'))) stats.files++ }

  /* ② mod 层：姿势**只信索引的 targetBundle** */
  const byMod = new Map()
  for (const md of (info?.mods || [])) byMod.set(md.modId, md)
  for (const layer of ['mod1', 'mod2']) {
    const base = path.join(SRC, layer, '角色', id)
    if (!fs.existsSync(base)) continue
    for (const modId of fs.readdirSync(base)) {
      const rt = path.join(base, modId, 'runtime')
      if (!fs.existsSync(rt)) continue
      const md = byMod.get(modId)
      const b = md?.targetBundle || null
      const destDir = b ? path.join(OUT, '角色', leaf, poseDirName(b), modDirName(modId, md?.packageName))
        : path.join(OUT, '角色', leaf, '_未分姿势', modDirName(modId, md?.packageName))
      if (!b) { stats.unposed++; if (unposedSamples.length < 6) unposedSamples.push(`角色/${id}/${modId}`) }
      for (const f of fs.readdirSync(rt)) {
        if (!fs.statSync(path.join(rt, f)).isFile()) continue
        if (link(path.join(rt, f), path.join(destDir, f))) stats.files++
      }
    }
  }
  return bundles.size
}

/* ---------------------------------------------------------------- 主流程 */
if (!fs.existsSync(SRC)) { console.log('SKIP 没有素材根'); process.exit(0) }
fs.rmSync(OUT, { recursive: true, force: true })

const ids = []
if (ALL) {
  for (const d of fs.readdirSync(path.join(SRC, 'source', '角色'))) ids.push({ kind: '角色', id: d })
  for (const d of fs.readdirSync(path.join(SRC, 'source', '画册'))) ids.push({ kind: '画册', id: d })
} else {
  ids.push({ kind: '角色', id: ONLY })
}

for (const { kind, id } of ids) {
  if (kind !== '角色') continue      // 画册的姿势归属还没确认映射键，先不动（见 IMPROVEMENTS 需求 9-B）
  const zh = zhForSkin(id) || null
  const n = placeCharacter(id, zh)
  if (!ALL) console.log(`${kind}/${id} → 姿势 ${n} 个`)
}

console.log(`\n输出：${OUT}`)
console.log(`硬链接文件 ${stats.files} 个；落进 _未分姿势 的 ${stats.unposed} 个`)
if (unposedSamples.length) console.log('未分姿势样本：\n  ' + unposedSamples.join('\n  '))

if (!ALL) {
  console.log('\n目录树（前 4 层）：')
  const walk = (d, pfx = '', depth = 0) => {
    if (depth > 3) return
    const es = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1)))
    es.slice(0, 14).forEach((e, i) => {
      const last = i === Math.min(es.length, 14) - 1
      console.log(pfx + (last ? '└─ ' : '├─ ') + e.name + (e.isDirectory() ? '/' : ''))
      if (e.isDirectory()) walk(path.join(d, e.name), pfx + (last ? '   ' : '│  '), depth + 1)
    })
    if (es.length > 14) console.log(pfx + `└─ …（还有 ${es.length - 14} 项）`)
  }
  walk(OUT)
}
