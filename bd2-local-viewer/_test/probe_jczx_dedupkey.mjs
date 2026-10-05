/**
 * 校验去重键 `(targetId, modId)` 会不会误伤图鉴内部的 mod：
 * 如果 mod1 和 mod2 里存在同一个 (targetId, modId)，那这条 mod 会被去重吃掉一份。
 * 同时列出没有任何 jczx 标记的条目（测试断言要求每条都有 targetKey）。
 * 用法：node _test/probe_jczx_dedupkey.mjs
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jczx-dedup-'))
const cfg = path.join(work, 'viewer.config.json')
fs.writeFileSync(cfg, JSON.stringify({
  port: 8204, maxDepth: 6,
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
console.log(`itemCount = ${items.length}`)

const noJczx = items.filter(i => !i.jczx)
console.log(`\n无 jczx 标记 = ${noJczx.length}`)
for (const it of noJczx.slice(0, 10)) {
  console.log(`  ${it.relAtlas}  atlas=${it.atlas} skel=${it.skeleton} imgs=${(it.images || []).length}`)
}

// 图鉴 mod 层内部：同一个 (targetId, modId) 出现在几个层？
const slot = new Map()
for (const it of items) {
  const j = it.jczx
  if (!j || j.layerKind !== 'mod') continue
  const k = `${j.targetId}|${j.modId}`
  if (!slot.has(k)) slot.set(k, [])
  slot.get(k).push(`${j.layer}${j.fromCache ? '(cache)' : ''}`)
}
const multi = [...slot].filter(([, v]) => v.length > 1)
console.log(`\n图鉴 mod 的 (targetId|modId) 槽位 = ${slot.size}，其中被多个条目占的 = ${multi.length}`)
for (const [k, v] of multi.slice(0, 8)) console.log(`  ${k} → ${v.join(', ')}`)

// targetKey 维度：同一个 targetKey 挂了几个 mod
const key = new Map()
for (const it of items) {
  const j = it.jczx
  if (!j || j.layerKind !== 'mod') continue
  if (!key.has(j.targetKey)) key.set(j.targetKey, new Set())
  key.get(j.targetKey).add(j.modId)
}
let maxMods = 0, maxKey = ''
for (const [k, s] of key) if (s.size > maxMods) { maxMods = s.size; maxKey = k }
console.log(`\ntargetKey 数 = ${key.size}，单个槽位最多 ${maxMods} 个不同 modId（${maxKey}）`)
kill()
