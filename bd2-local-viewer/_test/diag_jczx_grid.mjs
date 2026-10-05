/**
 * 诊断：jczx 常规档下网格到底出了几张卡、随时间怎么变的，
 * 以及 allItems / filteredItems / 各 key 集合的规模。
 * 用法：BD2_JCZX_ROOT=... node _test/diag_jczx_grid.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Cdp } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const JCZX_ROOT = process.env.BD2_JCZX_ROOT || 'C:/Users/KAKIKO/Videos/新建文件夹/交错战线图鉴-20260917'
if (!fs.existsSync(JCZX_ROOT)) { console.log('SKIP 没有素材根'); process.exit(0) }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jczx-diag-'))
const cfg = path.join(work, 'viewer.config.json')
fs.writeFileSync(cfg, JSON.stringify({
  port: 8205, maxDepth: 6,
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

const cdp = await Cdp.launch({ size: '1680,950' })
try {
  await cdp.goto(`${BASE}/?mode=jczx`)
  await cdp.waitFor(`window.__bd2viewer`, 20000, '__bd2viewer')
  await cdp.evaluate(`window.__bd2viewer.setAssetMode('jczx'); return 1`, 60000)

  console.log('\n--- 网格卡片数随时间 ---')
  const series = await cdp.evaluate(`
    const out = []
    for (let i = 0; i < 40; i++) {
      out.push(document.querySelectorAll('#galGrid .card').length)
      await new Promise(r => setTimeout(r, 500))
    }
    return out
  `, 60000)
  console.log(' ', JSON.stringify(series))

  console.log('\n--- 口径规模 ---')
  const stat = await cdp.evaluate(`
    const v = window.__bd2viewer
    const S = v.state
    const items = S.items || []
    const byLayer = {}
    for (const it of items) { const L = (it.jczx && it.jczx.layer) || '(无)'; byLayer[L] = (byLayer[L]||0)+1 }
    const all = v.allItems()
    const filtered = v.filteredItems()
    // 复算一遍分组，看 charId 分布
    const charIds = new Map()
    let noArk = 0
    for (const it of items) {
      if (!it.ark || !it.ark.charId) { noArk++; continue }
      charIds.set(it.ark.charId, (charIds.get(it.ark.charId)||0)+1)
    }
    const groupsOver2 = [...charIds].filter(([,n]) => n > 2)
    return {
      items: items.length, byLayer,
      allItems: all.length, filtered: filtered.length,
      noArk, distinctCharIds: charIds.size, groupsOver2: groupsOver2.length,
      biggestGroups: [...charIds].sort((a,b)=>b[1]-a[1]).slice(0,5),
      withMembers: all.filter(i => Array.isArray(i.members)).length,
      withMods: all.filter(i => Array.isArray(i.mods) && i.mods.length).length,
      jczxView: v.jczxView,
      sampleAll: all.slice(0,3).map(i => ({ base: i.base, layer: i.jczx && i.jczx.layerLabel,
        charId: i.ark && i.ark.charId, name: i.ark && i.ark.charName,
        members: (i.members||[]).length, mods: (i.mods||[]).length })),
    }
  `, 120000)
  console.log(JSON.stringify(stat, null, 2))
} finally {
  try { await cdp.close() } catch { /* ignore */ }
  kill()
}
