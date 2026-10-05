/**
 * 交错战线图鉴：把 `source|mod1|mod2/角色/<ID>/...` 就地重组成
 *
 *   角色/<ID>__<中文名>/<皮肤代号>__<中文名>/原图/*
 *                                          /mod-<id>__<包名>/*
 *                            /_未分姿势/原图/*      ← 立绘/UI/thumb 等分不出姿势的
 *                            /meta.json
 *
 * 姿势归属**只信索引**：mod 用 `data/mod_runtime_index.json` 的 `targetBundle`；
 * 原图用 `public/runtime/index.json` 的 `spineBundles` + 文件名兜底（带词边界，防
 * `alps` 抢走 `alps06`）。
 *
 * 四档（默认只打印用法，什么也不做）：
 *   node _tools/jczx_reorg.mjs --backup      硬链接镜像原三层（占 0 空间）+ 拷元数据
 *   node _tools/jczx_reorg.mjs --plan        只算不搬：输出计划与异常
 *   node _tools/jczx_reorg.mjs --apply       真搬（逐个 rename，逐条写日志）
 *   node _tools/jczx_reorg.mjs --undo        按日志回滚
 * 日志：<root>/_reorg_log_<时间戳>.tsv   （from \t to）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SRC = process.env.BD2_JCZX_ROOT || 'C:/Users/KAKIKO/Videos/新建文件夹/交错战线图鉴-20260917'
const BACKUP = path.join(SRC, '__原布局备份_20261003')
const LOG = path.join(SRC, '_reorg_log.tsv')

const mode = ['--backup', '--plan', '--apply', '--flatten', '--undo'].find(a => process.argv.includes(a))
if (!mode) {
  console.log('用法：--backup | --plan | --apply | --flatten | --undo')
  process.exit(0)
}
if (!fs.existsSync(SRC)) { console.error('没有素材根：' + SRC); process.exit(1) }

const jread = p => JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''))
const jreadSafe = p => { try { return jread(p) } catch { return null } }
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const safeName = s => String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60)

/* ---------------------------------------------------------------- 索引 */
const modIndex = jreadSafe(path.join(SRC, 'data/mod_runtime_index.json')) || { characters: [], archives: [] }
const charCat = jreadSafe(path.join(SRC, 'data/biligame_character_catalog.json')) || { characters: [] }
const rtIdx = jreadSafe(path.join(SRC, 'public/runtime/index.json')) || { characters: [] }

const zhByNameEn = new Map()
for (const c of (charCat.characters || [])) if (c && c.nameEn && c.nameZh) zhByNameEn.set(norm(c.nameEn), c.nameZh)
/**
 * 皮肤**代号**（`alps04`，不是完整 bundle 名！）→ 中文名。
 * ⚠️ 里面这条 `\d.*$` 的意图是「去掉尾部的数字+后缀」（alps04→alps）。
 * 如果误传完整 bundle 名（`prefabs_spine_10010_skin_alps04_spine`），它会从**第一个数字**开始
 * 截断成 `prefabs_spine_` → 全员查不到名字（2026-10-03 踩过：119 个角色目录全没后缀）。
 * 所以调用方**必须先 bundleSkin()**。
 */
const zhForSkin = code => zhByNameEn.get(norm(String(code || '').replace(/\d.*$/, ''))) || zhByNameEn.get(norm(code)) || null

function bundleSkin(bundle) {
  const m = /_skin_([a-z0-9]+)/i.exec(String(bundle || ''))
  if (m) return m[1].toLowerCase()
  return String(bundle || '').replace(/^prefabs_spine_/i, '').replace(/_spine$/i, '').toLowerCase()
}
const poseLeaf = bundle => { const c = bundleSkin(bundle); const zh = zhForSkin(c); return zh ? `${c}__${zh}` : c }
const modLeaf = (modId, pkg) => { const p = safeName(pkg); return p && p !== '根目录' ? `${modId}__${p}` : modId }

/* ---------------------------------------------------------------- 计划 */
/** 收集一个角色的所有 (from → to) */
function planOne(id) {
  const out = []
  const info = (modIndex.characters || []).find(x => String(x.characterId) === String(id))
  const rt = (rtIdx.characters || []).find(x => String(x.id) === String(id))
  const zh = zhForSkin(bundleSkin(info?.mods?.[0]?.targetBundle || ''))
    || zhForSkin(bundleSkin(rt?.spineBundles?.[0] || ''))
    || null
  const leaf = zh ? `${id}__${zh}` : id
  const bundles = new Set()
  for (const md of (info?.mods || [])) if (md.targetBundle) bundles.add(md.targetBundle)
  for (const b of (rt?.spineBundles || [])) bundles.add(b)
  // 兜底：从 source 的 spine 文件名里认出 bundle（索引不一定全）
  const srcCharDir = path.join(SRC, 'source', '角色', id)
  const srcRt = path.join(srcCharDir, 'runtime')
  if (fs.existsSync(srcRt)) {
    for (const f of fs.readdirSync(srcRt)) {
      const m = /^(prefabs_spine_[a-z0-9_]+?)(?:_[-\d]+)?\.(?:atlas|json|skel|png)$/i.exec(f)
      if (m) bundles.add(m[1])
    }
  }
  const cands = [...bundles].map(b => ({ b, code: bundleSkin(b) })).sort((x, y) => y.code.length - x.code.length)
  const boundaryOk = (s, i, len) => { const a = s[i + len]; return a === undefined || !/[a-z0-9]/.test(a) }
  const poseOf = name => {
    const n = String(name).toLowerCase()
    for (const { b, code } of cands) {
      const base = b.toLowerCase()
      const i = n.indexOf(base); if (i >= 0 && boundaryOk(n, i, base.length)) return b
      if (code) { const j = n.indexOf(code); if (j >= 0 && boundaryOk(n, j, code.length)) return b }
    }
    return null
  }

  const base = path.join('角色', leaf)
  /* ① source：runtime 平铺 → 按姿势分发；其余文件（meta.json 等）挂角色根 */
  if (fs.existsSync(srcCharDir)) {
    const walkSrc = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walkSrc(p, path.join(rel, e.name)); continue }
        const b = poseOf(e.name)
        const dest = b
          ? path.join(base, poseLeaf(b), '原图', e.name)
          : (rel === '' ? path.join(base, e.name) : path.join(base, '_未分姿势', '原图', e.name))
        out.push([path.relative(SRC, p), dest])
      }
    }
    walkSrc(srcCharDir, '')
  }
  /* ② mod 层。槽位目录里**直接放文件**（摊平掉原来的 `runtime/` 一层）——
     每个 mod 恰好有一个 runtime/，留着只是多一层要点开，和「原图/」也不一致。 */
  const byMod = new Map()
  for (const md of (info?.mods || [])) byMod.set(md.modId, md)
  for (const layer of ['mod1', 'mod2']) {
    const baseDir = path.join(SRC, layer, '角色', id)
    if (!fs.existsSync(baseDir)) continue
    for (const modId of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!modId.isDirectory()) continue
      const md = byMod.get(modId.name)
      const b = md?.targetBundle || null
      const destDir = b
        ? path.join(base, poseLeaf(b), modLeaf(modId.name, md?.packageName))
        : path.join(base, '_未分姿势', modLeaf(modId.name, md?.packageName))
      const dp = path.join(baseDir, modId.name)
      const walkMod = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name)
          if (e.isDirectory()) { walkMod(p); continue }
          out.push([path.relative(SRC, p), path.join(destDir, e.name)])
        }
      }
      walkMod(dp)
    }
  }
  return { id, leaf, zh, poses: cands.length, moves: out }
}

/**
 * 画册侧的计划。**不建「姿势」层** —— 实测 56 个 archiveId 里 52 个只有**一个** bundle
 * （CG 就是一张画，没有姿势），那一层纯属多余。目录名按用户 2026-10-03 的要求**只用 cgN**。
 *   画册/<cgN>/{原图 | mod-<id>__<包名>}/…
 */
function planArchive(id) {
  const moves = []
  const base = path.join('画册', id)
  const push = (from, to) => moves.push([path.relative(SRC, from), to])
  const clean = d => { try { return fs.readdirSync(d, { withFileTypes: true }) } catch { return [] } }
  /* ① 原图：<root>/source/画册/<id>/runtime/** → 画册/<id>/原图/**；
        meta.json 挂 cgN 根。
        ⚠️ 必须**递归**：实测 cg42 是 `runtime/variants/*.png`（多一层），
        只走一层会漏掉（2026-10-03 第一次跑就漏了 2 个文件）。内层子路径**保留**
        （`variants/` 是有意义的分类，摊平会丢信息）。 */
  const srcDir = path.join(SRC, 'source', '画册', id)
  const walkSrc = (d, sub) => {
    for (const e of clean(d)) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walkSrc(p, sub ? path.join(sub, e.name) : e.name); continue }
      let dest
      if (!sub) {
        dest = e.name === 'meta.json' ? path.join(base, 'meta.json') : path.join(base, '原图', e.name)
      } else {
        // 去掉最外层的 `runtime/`（它只是导出惯例），内层子路径原样保留
        const inner = sub.split(path.sep)
        if (inner[0] === 'runtime') inner.shift()
        dest = inner.length ? path.join(base, '原图', ...inner, e.name) : path.join(base, '原图', e.name)
      }
      push(p, dest)
    }
  }
  walkSrc(srcDir, '')
  /* ② mod 层：<root>/<layer>/画册/<id>/<modId>/** → 画册/<id>/<modLeaf>/**（摊平 runtime/） */
  const byMod = new Map()
  const arch = (modIndex.archives || []).find(x => String(x.archiveId) === String(id))
  for (const md of (arch?.mods || [])) byMod.set(md.modId, md)
  for (const layer of ['mod1', 'mod2']) {
    const baseDir = path.join(SRC, layer, '画册', id)
    for (const md of clean(baseDir)) {
      if (!md.isDirectory()) continue
      const info = byMod.get(md.name)
      const destDir = path.join(base, modLeaf(md.name, info?.packageName))
      const walkMod = d => {
        for (const e of clean(d)) {
          const p = path.join(d, e.name)
          if (e.isDirectory()) { walkMod(p); continue }
          push(p, path.join(destDir, e.name))
        }
      }
      walkMod(path.join(baseDir, md.name))
    }
  }
  return { id, leaf: id, zh: null, poses: 1, moves, isArchive: true }
}

/* ---------------------------------------------------------------- 分支 */
if (mode === '--backup') {
  fs.mkdirSync(BACKUP, { recursive: true })
  let n = 0, skipped = 0
  for (const layer of ['source', 'mod1', 'mod2']) {
    for (const cat of ['角色', '画册']) {
      const root = path.join(SRC, layer, cat)
      if (!fs.existsSync(root)) continue
      const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name)
          const rel = path.relative(SRC, p)
          const dest = path.join(BACKUP, rel)
          if (e.isDirectory()) { fs.mkdirSync(dest, { recursive: true }); walk(p); continue }
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          if (fs.existsSync(dest)) { skipped++; continue }
          try { fs.linkSync(p, dest); n++ } catch { fs.copyFileSync(p, dest); n++ }
        }
      }
      walk(root)
    }
  }
  // 元数据（这些是搬完就失效的东西，必须单独拷一份）
  const metaDir = path.join(BACKUP, '_meta')
  fs.mkdirSync(metaDir, { recursive: true })
  const copyMeta = rel => {
    const from = path.join(SRC, rel)
    if (!fs.existsSync(from)) return
    // ⚠️ data/ 下面可能有**目录**（实测 data/visual-verification）→ 必须递归，
    // 直接 copyFileSync 会 EISDIR 崩掉。
    const st = fs.statSync(from)
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(from)) copyMeta(path.join(rel, e))
      return
    }
    const to = path.join(metaDir, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
  for (const f of ['release-manifest.json', 'launcher.config.json', 'gallery-release.json', 'other_page_plugins.mjs']) copyMeta(f)
  for (const f of fs.readdirSync(path.join(SRC, 'data'))) copyMeta(path.join('data', f))
  for (const f of fs.readdirSync(path.join(SRC, 'public/runtime'))) {
    if (f.endsWith('.json')) copyMeta(path.join('public/runtime', f))
  }
  console.log(`备份完成：${BACKUP}`)
  console.log(`  硬链接 ${n} 个（跳过已存在 ${skipped}）· 额外占用约 0 字节`)
  console.log('  元数据副本在 _meta/（release-manifest.json / data/*.json / public/runtime/*.json）')
  process.exit(0)
}

if (mode === '--plan' || mode === '--apply') {
  const collect = cat => {
    const ids = new Set()
    for (const layer of ['source', 'mod1', 'mod2']) {
      const d = path.join(SRC, layer, cat)
      if (!fs.existsSync(d)) continue
      for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) ids.add(e.name)
    }
    return [...ids].sort()
  }
  /**
   * ⚠️ 只保留**源文件还在**的搬运项 → 脚本天然**幂等/可续跑**：
   * 第一次跑完了角色，第二次再跑就只会处理还没搬的（画册），不会报 6794 个「缺源文件」。
   */
  const keepExisting = plans => plans.map(p => ({
    ...p, done: p.moves.length - p.moves.filter(([from]) => fs.existsSync(path.join(SRC, from))).length,
    moves: p.moves.filter(([from]) => fs.existsSync(path.join(SRC, from))),
  }))

  const charPlans = keepExisting(collect('角色').map(planOne))
  const archPlans = keepExisting(collect('画册').map(planArchive))
  const plans = [...charPlans, ...archPlans]
  const totalMoves = plans.reduce((a, p) => a + p.moves.length, 0)
  const doneMoves = plans.reduce((a, p) => a + p.done, 0)
  const noName = charPlans.filter(p => !p.zh)
  const unposedMoves = charPlans.flatMap(p => p.moves).filter(m => m[1].includes('_未分姿势'))
  const unposed = unposedMoves.length
  // 「分不出姿势」的都是什么？分三类看清：mod（索引里没 targetBundle）/ spine 三件套 / 其它图
  const bucket = { mod没索引: 0, spine文件: 0, 其它图: 0 }
  for (const [, to] of unposedMoves) {
    const f = path.basename(to)
    if (/^mod-/.test(path.basename(path.dirname(to)))) bucket.mod没索引++
    else if (/\.(atlas|skel)$/i.test(f) || /^prefabs_spine_/i.test(f)) bucket.spine文件++
    else bucket.其它图++
  }
  console.log(`角色 ${charPlans.length} 个 + 画册 ${archPlans.length} 个`)
  console.log(`待搬 ${totalMoves} 个文件（源文件已不在的自动跳过 —— 脚本幂等，可反复跑）· 角色里「分不出姿势」${unposed} 个`)
  console.log(`  分不出姿势的构成：${JSON.stringify(bucket)}`)
  console.log(`没查到中文名的角色 ${noName.length} 个：${noName.slice(0, 12).map(p => p.id).join(', ')}${noName.length > 12 ? ' …' : ''}`)
  console.log(`命名样例：${charPlans.slice(0, 4).map(p => `${p.id}→${p.leaf}`).join('  ')}`)
  console.log(`画册命名（按用户要求只用 cgN）：${archPlans.slice(0, 6).map(p => p.leaf).join(', ')} …`)
  console.log('\n画册样例：')
  for (const p of archPlans.slice(0, 2)) {
    console.log(`【${p.id}】→ 画册/${p.leaf}/   （搬 ${p.moves.length} 个文件）`)
    for (const [from, to] of p.moves.slice(0, 5)) console.log(`   ${from}\n      → ${to}`)
  }

  if (mode === '--plan') {
    fs.writeFileSync(path.join(REPO, '_scratch', 'reorg_plan.tsv'),
      plans.flatMap(p => p.moves).map(([a, b]) => `${a}\t${b}`).join('\n'), 'utf-8')
    console.log(`\n完整计划已写 _scratch/reorg_plan.tsv（${totalMoves} 行）`)
    process.exit(0)
  }

  /* ---- 真搬 ---- */
  if (!fs.existsSync(BACKUP)) { console.error(`✕ 没有备份（${BACKUP}）→ 拒绝执行。先跑 --backup`); process.exit(1) }
  const lines = []
  let moved = 0, failed = 0
  const errs = []
  for (const p of plans) {
    for (const [from, to] of p.moves) {
      const a = path.join(SRC, from), b = path.join(SRC, to)
      try {
        if (!fs.existsSync(a)) { failed++; if (errs.length < 10) errs.push(`缺源文件：${from}`); continue }
        if (fs.existsSync(b)) { failed++; if (errs.length < 10) errs.push(`目标已存在：${to}`); continue }
        fs.mkdirSync(path.dirname(b), { recursive: true })
        fs.renameSync(a, b)
        lines.push(`${from}\t${to}`)
        moved++
      } catch (e) { failed++; if (errs.length < 10) errs.push(`${from} → ${e.message}`) }
    }
    // 每个角色一批：日志即时落盘，保证中断也能回滚
    fs.appendFileSync(LOG, lines.splice(0).map(l => l + '\n').join(''), 'utf-8')
    process.stdout.write(`\r已搬 ${moved} 个文件（失败 ${failed}）…`)
  }
  console.log(`\n完成：搬了 ${moved} 个，失败 ${failed} 个`)
  if (errs.length) console.log('前几条失败：\n  ' + errs.join('\n  '))
  console.log(`回滚日志：${LOG}`)
  process.exit(failed ? 2 : 0)
}

if (mode === '--flatten') {
  /**
   * 把「槽位目录」下多余的一层 `runtime/` 上提：`<…>/mod-xxx__包名/runtime/*` → `<…>/mod-xxx__包名/*`。
   * 为什么：每个 mod 恰好只有一个 `runtime/`，留着只是多一层要点开，跟同级的 `原图/`（本来就是摊平的）
   * 也不一致。**只动新整理树里的槽位目录**（`角色|画册/**`），备份镜像一个字节不碰。
   */
  const targets = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = path.join(d, e.name)
      if (e.name === 'runtime') { targets.push(p); continue }   // 不再往里走
      walk(p)
    }
  }
  for (const cat of ['角色', '画册']) {
    const root = path.join(SRC, cat)
    if (fs.existsSync(root)) walk(root)
  }
  let moved = 0, failed = 0
  const log = []
  for (const rt of targets) {
    const parent = path.dirname(rt)
    const walkFiles = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { walkFiles(p); continue }
        const to = path.join(parent, e.name)
        try {
          if (fs.existsSync(to)) { failed++; continue }
          fs.renameSync(p, to)
          log.push(`${path.relative(SRC, p)}\t${path.relative(SRC, to)}`)
          moved++
        } catch { failed++ }
      }
    }
    walkFiles(rt)
  }
  if (log.length) fs.appendFileSync(LOG, log.join('\n') + '\n', 'utf-8')
  console.log(`摊平：上提 ${moved} 个文件（失败 ${failed}）· 涉及 ${targets.length} 个 runtime/ 目录`)
  console.log(`（空掉的 runtime/ 目录自己留着 —— 删不掉，需手工清）`)
  process.exit(failed ? 2 : 0)
}

if (mode === '--undo') {
  if (!fs.existsSync(LOG)) { console.error('没有日志，无法回滚'); process.exit(1) }
  const rows = fs.readFileSync(LOG, 'utf-8').split('\n').filter(Boolean).map(l => l.split('\t'))
  let back = 0, failed = 0
  for (const [from, to] of rows.reverse()) {
    const a = path.join(SRC, to), b = path.join(SRC, from)
    try { if (fs.existsSync(a)) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); back++ } } catch { failed++ }
  }
  console.log(`回滚：搬回 ${back} 个，失败 ${failed} 个`)
}
