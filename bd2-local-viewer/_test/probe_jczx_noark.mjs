/**
 * 定位 jczx 里「有 jczx 标记但 ark 为 null / charId 为空」的条目。
 * 用法：node _test/probe_jczx_noark.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const JCZX_ROOT = process.env.BD2_JCZX_ROOT || 'C:/Users/KAKIKO/Videos/新建文件夹/交错战线图鉴-20260917'
if (!fs.existsSync(JCZX_ROOT)) { console.log('SKIP 没有素材根'); process.exit(0) }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jczx-noark-'))
const cfg = path.join(work, 'viewer.config.json')
fs.writeFileSync(cfg, JSON.stringify({
  port: 8206, maxDepth: 6,
  roots: [{ id: 'jczx', path: JCZX_ROOT, label: '交错战线图鉴' }],
}, null, 2), 'utf-8')
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: REPO, env: { ...process.env, BD2_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', d => { log += d })
server.stderr.on('data', d => { log += d })
const kill = () => { try { server.kill() } catch { /* ignore */ } }
process.on('exit', kill)
let BASE = ''
const p0 = Date.now() + 20000
while (Date.now() < p0) {
  const m = /地址：(http:\/\/[^\s/]+)/.exec(log)
  if (m) { BASE = m[1].replace(/\/$/, ''); break }
  await new Promise(r => setTimeout(r, 200))
}
if (!BASE) { console.log('服务端没起来'); process.exit(1) }
const dl = Date.now() + 180000
while (Date.now() < dl) {
  try { const r = await fetch(`${BASE}/api/scan?root=jczx&mode=jczx`); if (r.ok) break } catch { /* wait */ }
  await new Promise(r => setTimeout(r, 500))
}

const items = (await (await fetch(`${BASE}/api/scan?root=jczx&mode=jczx`)).json()).items || []
const bad = items.filter(i => i.jczx && !i.ark)
console.log(`有 jczx 标记但 ark 为 null = ${bad.length} / ${items.length}`)

const byDir = new Map()
for (const it of bad) {
  // 目录形状：<layer>/<角色|画册>/<ID>/[mod-<id>/]runtime
  const rel = String(it.relAtlas || '')
  const seg = rel.split('/')
  const key = seg.slice(0, 3).join('/')
  byDir.set(key, (byDir.get(key) || 0) + 1)
}
console.log('\n按 <层>/<类别>/<ID> 归类（前 20）:')
for (const [k, n] of [...byDir].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${n}  ${k}   [该 ID 下有 meta 吗: ${fs.existsSync(path.join(JCZX_ROOT, 'source', k.split('/')[1], k.split('/')[2], 'meta.json'))}]`)
}
console.log('\n样本 dir:')
for (const it of bad.slice(0, 6)) console.log(`  ${it.dir}\n    rel=${it.relAtlas}`)

// 画册类是否有 meta
const cg = items.filter(i => i.jczx && (i.jczx.groupDir || '').includes('画册'))
console.log(`\n画册类条目 = ${cg.length}，其中 ark 为 null = ${cg.filter(i => !i.ark).length}`)
kill()
