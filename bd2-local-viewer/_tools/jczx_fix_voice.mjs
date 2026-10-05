/**
 * 修一处重组遗留：交错战线的语音被摊平进了 `<姿势>/原图/`。
 *
 * 原结构（日志可见）：`source/角色/<ID>/runtime/voice/<批次>/wav/<皮肤>/xxx.wav`（嵌套）
 * 重组后错误地变成：`角色/<ID>__名/<姿势>/原图/xxx.wav`（丢了 voice 子树、还污染了原图目录）
 * 正确目标：`角色/<ID>__名/voice/<批次>/wav/<皮肤>/xxx.wav`
 *
 * 只 mv、写日志（可回滚）。跑完打印统计。
 */
import fs from 'node:fs'
import path from 'node:path'

const SRC = process.env.BD2_JCZX_ROOT || 'C:/Users/KAKIKO/Videos/新建文件夹/交错战线图鉴-20260917'
const LOG = path.join(SRC, '_reorg_log.tsv')
if (!fs.existsSync(LOG)) { console.error('没有回滚日志'); process.exit(1) }

const rows = fs.readFileSync(LOG, 'utf-8').split('\n').filter(Boolean).map(l => l.split('\t'))
const toOf = new Map()
for (const [from, to] of rows) toOf.set(from, to)
const finalOf = p => { let c = p, h = 0; while (toOf.has(c) && h++ < 10) c = toOf.get(c); return c }

const VOICE_RE = /(?:^|[\\/])runtime[\\/]voice[\\/](.+)$/i
const AUDIO_RE = /\.(wav|mp3|ogg|m4a)$/i

const moveLog = []
let moved = 0, missing = 0, skipped = 0
const samples = []
for (const [from] of rows) {
  const m = VOICE_RE.exec(from)
  if (!m || !AUDIO_RE.test(from)) continue
  const tail = m[1].split(/[\\/]/).filter(Boolean)          // <批次>/wav/<皮肤>/xxx.wav
  const cur = path.join(SRC, finalOf(from))
  if (!fs.existsSync(cur)) { missing++; continue }
  const seg = finalOf(from).split(path.sep).filter(Boolean)  // 角色 / <leaf> / ...
  if (seg[0] !== '角色' || !seg[1]) { skipped++; continue }
  const dest = path.join(SRC, '角色', seg[1], 'voice', ...tail)
  if (path.resolve(dest) === path.resolve(cur)) { skipped++; continue }
  try {
    if (fs.existsSync(dest)) { skipped++; continue }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(cur, dest)
    moveLog.push(`${path.relative(SRC, cur)}\t${path.relative(SRC, dest)}`)
    moved++
    if (samples.length < 4) samples.push(`${path.relative(SRC, dest)}`)
  } catch (e) { skipped++; if (samples.length < 8) samples.push('失败 ' + e.message) }
}
if (moveLog.length) fs.appendFileSync(LOG, moveLog.join('\n') + '\n', 'utf-8')
console.log(`语音归位：移动 ${moved} · 缺源 ${missing} · 跳过 ${skipped}`)
console.log('样例：\n  ' + samples.join('\n  '))
// 收尾核对：原图目录里还剩多少音频
let left = 0
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/原图/.test(d) && AUDIO_RE.test(e.name)) left++
  }
}
const rootCh = path.join(SRC, '角色')
if (fs.existsSync(rootCh)) walk(rootCh)
console.log(`原图目录里残留音频：${left} 个`)
