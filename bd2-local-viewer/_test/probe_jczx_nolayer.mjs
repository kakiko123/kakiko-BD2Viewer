/**
 * 起 server（临时配置）→ 跑探针 → kill。避免手工留进程占端口。
 * 用法：node _test/probe_jczx_nolayer.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const JCZX_ROOT = process.env.BD2_JCZX_ROOT || 'C:/Users/KAKIKO/Videos/新建文件夹/交错战线图鉴-20260917'
if (!fs.existsSync(JCZX_ROOT)) { console.log('SKIP 没有素材根', JCZX_ROOT); process.exit(0) }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jczx-nolayer-'))
const cfg = path.join(work, 'viewer.config.json')
fs.writeFileSync(cfg, JSON.stringify({
  port: 8202, maxDepth: 6,
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
const pDeadline = Date.now() + 20000
while (Date.now() < pDeadline) {
  const m = /地址：(http:\/\/[^\s/]+)/.exec(log)
  if (m) { BASE = m[1].replace(/\/$/, ''); break }
  await new Promise(r => setTimeout(r, 200))
}
if (!BASE) { console.log('服务端没起来\n', log.slice(-1500)); process.exit(1) }
const dl = Date.now() + 180000
while (Date.now() < dl) {
  try { const r = await fetch(`${BASE}/api/scan?root=jczx&mode=jczx`); if (r.ok) break } catch { /* wait */ }
  await new Promise(r => setTimeout(r, 500))
}

const r = await fetch(`${BASE}/api/scan?root=jczx&mode=jczx`)
const j = await r.json()
const items = j.items || []
console.log(`itemCount = ${items.length}`)

const noLayer = items.filter(it => !it.jczx)
console.log(`\n无 jczx 标记 = ${noLayer.length}`)
const byPrefix = new Map()
for (const it of noLayer) {
  const seg = String(it.relAtlas || '').split('/')
  const key = seg.slice(0, 3).join('/')
  byPrefix.set(key, (byPrefix.get(key) || 0) + 1)
}
for (const [k, n] of [...byPrefix].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${n}  ${k}`)
console.log('  样本:', noLayer.slice(0, 6).map(it => it.relAtlas))

const byLayer = new Map()
for (const it of items) {
  const L = (it.jczx && it.jczx.layer) || '(无)'
  let s = byLayer.get(L)
  if (!s) { s = { n: 0, meta: 0, zh: 0, cache: 0 }; byLayer.set(L, s) }
  s.n++
  if (it.ark) s.meta++
  if (it.ark && it.ark.charName) s.zh++
  if (it.jczx && it.jczx.fromCache) s.cache++
}
console.log('\n层          条目  带meta  有名  来自缓存')
for (const [k, s] of byLayer) {
  console.log(`  ${k.padEnd(12)} ${String(s.n).padStart(5)} ${String(s.meta).padStart(6)} ${String(s.zh).padStart(5)} ${String(s.cache).padStart(6)}`)
}
kill()
