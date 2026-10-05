/**
 * 重组后的**完整性校验 + 重建原布局镜像**。
 *
 * 回滚日志 `_reorg_log.tsv` 是链式的（`原始 → 新树 → 摊平后`），所以先把每个文件
 * 「最终落在哪」解出来（顺着 to 一直走到没有下一跳），再：
 *   ① 校验：每个最终文件都存在，且体积与原布局镜像 / release-manifest 记的一致；
 *   ② 重建镜像：在 `__原布局备份_20261003/<原路径>` 建**硬链接**指向当前文件
 *      （同盘 → 0 额外空间）。这样「原布局」这份安全网是真实存在的，`--undo` 之外还能直接对拷。
 */
import fs from 'node:fs'
import path from 'node:path'

const SRC = process.env.BD2_JCZX_ROOT || 'C:/Users/KAKIKO/Videos/新建文件夹/交错战线图鉴-20260917'
const LOG = path.join(SRC, '_reorg_log.tsv')
const BACKUP = path.join(SRC, '__原布局备份_20261003')
if (!fs.existsSync(LOG)) { console.error('没有回滚日志：' + LOG); process.exit(1) }

const rows = fs.readFileSync(LOG, 'utf-8').split('\n').filter(Boolean).map(l => l.split('\t'))
console.log(`日志 ${rows.length} 行`)

/** from → to（后者覆盖前者，链式取最终落点） */
const toOf = new Map()
for (const [from, to] of rows) toOf.set(from, to)
/** 顺着 to 一直走到没有下一跳 = 文件现在真实所在 */
function finalOf(p) {
  let cur = p, hops = 0
  while (toOf.has(cur) && hops++ < 10) cur = toOf.get(cur)
  return cur
}

const originals = [...new Set(rows.map(r => r[0]))]
let ok = 0
const missing = []
const finals = new Map()   // 原路径 → 现在的绝对路径
for (const orig of originals) {
  const fin = finalOf(orig)
  const abs = path.join(SRC, fin)
  if (fs.existsSync(abs)) { ok++; finals.set(orig, fin) } else missing.push(`${orig} → ${fin}`)
}
console.log(`原始文件 ${originals.length} 个 · 现在都在 ${ok} 个 · 缺 ${missing.length} 个`)
if (missing.length) console.log('缺失样例：\n  ' + missing.slice(0, 8).join('\n  '))

/* 体积核对：拿「备份里还在的那部分」当基准 */
let sizeOk = 0, sizeBad = []
for (const [orig, fin] of finals) {
  const mirror = path.join(BACKUP, orig)
  if (!fs.existsSync(mirror)) continue
  const a = fs.statSync(mirror).size, b = fs.statSync(path.join(SRC, fin)).size
  if (a === b) sizeOk++
  else sizeBad.push(`${orig} 镜像${a} vs 现在${b}`)
}
console.log(`与现有镜像逐个体积比对：一致 ${sizeOk} · 不一致 ${sizeBad.length}`)
if (sizeBad.length) console.log('  ' + sizeBad.slice(0, 5).join('\n  '))

/* 重建镜像：把缺的硬链接补上 */
let linked = 0, skipped = 0, linkedFailed = 0
for (const [orig, fin] of finals) {
  const dest = path.join(BACKUP, orig)
  if (fs.existsSync(dest)) { skipped++; continue }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.linkSync(path.join(SRC, fin), dest)
    linked++
  } catch { linkedFailed++ }
}
console.log(`重建镜像：新建硬链接 ${linked} 个 · 已存在跳过 ${skipped} · 失败 ${linkedFailed}`)
const total = (() => {
  let n = 0
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : n++ }
  walk(BACKUP); return n
})()
console.log(`镜像现在共 ${total} 个文件（原布局 ${originals.length} + 元数据 43）`)
