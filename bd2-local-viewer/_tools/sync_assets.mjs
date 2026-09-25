/**
 * 把 public/ 下的前端产物同步到 APK 工程的 assets/web/。
 *
 * 为什么需要这个脚本：bundle.mjs 只写 public/，APK 读的是
 * bd2-android/app/src/main/assets/web/app.bundle.html。
 * 这一步一直是手工 cp —— 2026-09-25 实测过「代码改了、APK 里还是旧界面」
 * 的假象（4 个文件的 sha1 全都不一致）。所以做成脚本，并在最后比对 sha1。
 *
 * 为什么要连 lib/ 一起同步：app.bundle.html 已经内联了一切，lib/ 是
 * **兜底通路**用的（bundle 读不出来时 MainActivity 会退回 index.html，
 * 而 index.html 是外链 /lib/* 的）。之前这里只同步 4 个顶层文件，
 * lib/ 是某次手工拷进去的 —— 一旦升级 spine-player，兜底通路就会用旧库。
 *
 * 用法：node _tools/sync_assets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../public')
const DST = path.resolve(HERE, '../../bd2-android/app/src/main/assets/web')

const sha1 = p => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')

if (!fs.existsSync(SRC)) {
  console.error(`✕ 找不到前端目录：${SRC}`)
  process.exit(1)
}
if (!fs.existsSync(DST)) {
  console.error(`✕ 找不到 APK assets 目录：${DST}`)
  console.error('  本脚本要求目录布局为 <repo>/bd2-local-viewer 与 <repo>/bd2-android 并列。')
  process.exit(1)
}

/** 递归列出 public/ 下的所有文件，返回相对路径（正斜杠） */
function walk(dir, base = dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full, base))
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

const files = walk(SRC).sort()

// 产物清单：少了核心文件说明 bundle.mjs 没跑过
const REQUIRED = ['app.bundle.html', 'index.html', 'app.js', 'styles.css']
const missing = REQUIRED.filter(f => !files.includes(f))
if (missing.length) {
  console.error(`✕ public/ 缺少核心文件：${missing.join(', ')}`)
  console.error('  先跑 node _tools/bundle.mjs')
  process.exit(1)
}

let copied = 0
const rows = []
for (const rel of files) {
  const from = path.join(SRC, rel)
  const to = path.join(DST, rel.split('/').join(path.sep))
  const want = sha1(from)
  const before = fs.existsSync(to) ? sha1(to) : null
  if (before !== want) {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    copied++
  }
  rows.push([rel, want.slice(0, 8), before === null ? '新增' : before === want ? '已一致' : '已同步', sha1(to) === want])
}

for (const [rel, hash, state, ok] of rows) {
  console.log(`  ${ok ? '✓' : '✕'} ${rel.padEnd(24)} ${hash}  ${state}`)
}

// 反向检查：assets 里有、public 里没有的残留（旧版本文件容易留在这里）
const stale = walk(DST).filter(f => !files.includes(f))
if (stale.length) {
  console.log(`\n⚠ assets 里有 ${stale.length} 个 public/ 已不存在的残留文件（不影响功能，建议清理）：`)
  for (const s of stale) console.log(`    ${s}`)
}

const bad = rows.filter(r => !r[3]).length
console.log(`\n同步 ${copied} 个文件 · 校验通过 ${rows.length - bad}/${rows.length}`)
process.exit(bad ? 1 : 0)
