/**
 * 交叉统计：解包缓存（bd2viewer-jczx/）里的 mod 与图鉴发布包（mod1/mod2）的重叠情况。
 * 回答三个问题：
 *   1. 缓存 modId 与图鉴 modId 的交集有多少（决定去重能藏掉多少）
 *   2. 缓存 targetKey 与图鉴 targetKey 的交集（同名同槽位 = 该合并的）
 *   3. 缓存条目里有多少在图鉴 source 层压根没有同名 bundle（这些是「真·图鉴没有」）
 * 用法：node _test/probe_jczx_overlap.mjs
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jczx-overlap-'))
const cfg = path.join(work, 'viewer.config.json')
fs.writeFileSync(cfg, JSON.stringify({
  port: 8203, maxDepth: 6,
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

const items = (await (await fetch(`${BASE}/api/scan?root=jczx&mode=jczx`)).json()).items || []
const cache = items.filter(i => i.jczx && i.jczx.fromCache)
const galMod = items.filter(i => i.jczx && !i.jczx.fromCache && i.jczx.layerKind === 'mod')
const src = items.filter(i => i.jczx && i.jczx.layerKind === 'source')
console.log(`缓存 mod ${cache.length} / 图鉴 mod ${galMod.length} / 原图 ${src.length}`)

const galModIds = new Set(galMod.map(i => i.jczx.modId))
const galModKeys = new Set(galMod.map(i => i.jczx.targetKey))
const srcKeys = new Set(src.map(i => i.jczx.targetKey))

let sameModId = 0, sameKey = 0, onlyCache = 0
const onlyCacheSamples = []
for (const it of cache) {
  if (galModIds.has(it.jczx.modId)) sameModId++
  if (galKeysHit(it)) sameKey++
  if (!galModIds.has(it.jczx.modId) && !galModKeys.has(it.jczx.targetKey)) {
    onlyCache++
    if (onlyCacheSamples.length < 8) onlyCacheSamples.push(`${it.jczx.targetKey}  ${it.jczx.modId}`)
  }
}
function galKeysHit() { return false }

const cacheKeys = new Set(cache.map(i => i.jczx.targetKey))
let keyInGalleryMod = 0, keyInSource = 0
for (const k of cacheKeys) {
  if (galModKeys.has(k)) keyInGalleryMod++
  if (srcKeys.has(k)) keyInSource++
}
console.log(`缓存 modId 命中图鉴 modId : ${sameModId}/${cache.length}`)
console.log(`缓存 targetKey 命中图鉴 mod: ${keyInGalleryMod}/${cacheKeys.size}`)
console.log(`缓存 targetKey 命中原图     : ${keyInSource}/${cacheKeys.size}`)
console.log(`图鉴完全没有的 mod 条目     : ${onlyCache}`)
console.log('  样本:', onlyCacheSamples)

// 同一个 modId 在两边各自的 targetKey 长什么样（targetKey 对不上的原因）
console.log('\n--- 同 modId 的 targetKey 对照（前 6 个）---')
const galByModId = new Map()
for (const i of galMod) {
  if (!galByModId.has(i.jczx.modId)) galByModId.set(i.jczx.modId, i)
}
let shown = 0
for (const i of cache) {
  const g = galByModId.get(i.jczx.modId)
  if (!g || shown >= 6) continue
  shown++
  console.log(`  mod=${i.jczx.modId}`)
  console.log(`    缓存: key=${i.jczx.targetKey}  base=${i.base}  dir=${i.directory || i.dir || ''}`)
  console.log(`    图鉴: key=${g.jczx.targetKey}  base=${g.base}  dir=${g.directory || g.dir || ''}`)
}


// 缓存条目按「图鉴有没有同名 mod」分组，看中文名命中差别
const hitName = it => !!(it.ark && it.ark.charName)
const inGal = cache.filter(i => galModKeys.has(i.jczx.targetKey))
const notInGal = cache.filter(i => !galModKeys.has(i.jczx.targetKey))
console.log(`\n缓存·槽位在图鉴 mod 里 : ${inGal.length} 条，有中文名 ${inGal.filter(hitName).length}`)
console.log(`缓存·槽位不在图鉴 mod 里: ${notInGal.length} 条，有中文名 ${notInGal.filter(hitName).length}`)
console.log('  样本:', notInGal.slice(0, 5).map(i => `${i.jczx.targetKey} base=${i.base} charId=${i.ark && i.ark.charId}`))
kill()
