/** 把搬空后的旧布局空壳目录（`<layer>/角色`）整体挪进备份区。只 mv，不删。 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.env.BD2_JCZX_ROOT || 'C:/Users/KAKIKO/Videos/新建文件夹/交错战线图鉴-20260917'
const dest = path.join(ROOT, '__原布局备份_20261003', '_empty_dirs')
fs.mkdirSync(dest, { recursive: true })

const countFiles = d => {
  let n = 0
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(d, e.name))
    else n++
  }
  return n
}

for (const layer of ['source', 'mod1', 'mod2']) {
  const from = path.join(ROOT, layer, '角色')
  if (!fs.existsSync(from)) { console.log(`跳过 ${layer}/角色（不存在）`); continue }
  const n = countFiles(from)
  if (n > 0) { console.log(`!! ${layer}/角色 还有 ${n} 个文件 → 跳过（这个不能动）`); continue }
  const to = path.join(dest, `${layer}__角色`)
  if (fs.existsSync(to)) { console.log(`跳过 ${layer}/角色（目标已存在）`); continue }
  fs.renameSync(from, to)
  console.log(`已挪走 ${layer}/角色（整个空壳，0 文件）`)
}
console.log('\n剩余：')
for (const layer of ['source', 'mod1', 'mod2']) {
  const p = path.join(ROOT, layer)
  console.log(` ${layer}/ →`, fs.existsSync(p) ? fs.readdirSync(p).join(' ') : '（不存在）')
}
