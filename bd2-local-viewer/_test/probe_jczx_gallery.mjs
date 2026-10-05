/** 扫描层实测：把「交错战线图鉴」目录当 jczx 根扫一遍，看条目与 mod 层标记对不对。 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const PORT = 8155
const ROOT = 'jczx-gallery'

const srv = spawn(process.execPath, [path.join(DIR, '..', 'server.mjs')], {
  cwd: path.join(DIR, '..'),
  env: { ...process.env, BD2_CONFIG: path.join(DIR, '..', '_scratch', 'jczx_gallery.config.json') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
srv.stdout.on('data', d => { log += d })
srv.stderr.on('data', d => { log += d })

const bye = () => { try { srv.kill() } catch {} }
process.on('exit', bye)

async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/scan?root=${encodeURIComponent(ROOT)}&mode=jczx`)
      if (r.ok) return await r.json()
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('server never became ready\n' + log)
}

const j = await ready()
console.log('itemCount   =', j.itemCount)
console.log('playable    =', j.playableCount)
console.log('scanMs      =', j.scanMs)

const withLayer = j.items.filter(i => i.jczx)
console.log('带 mod 层标记 =', withLayer.length)

const byLayer = {}
for (const i of withLayer) byLayer[i.jczx.layer] = (byLayer[i.jczx.layer] || 0) + 1
console.log('按层分布    =', byLayer)

const withArk = j.items.filter(i => i.ark)
console.log('带 meta     =', withArk.length)
const named = withArk.filter(i => i.ark.charName && !/^\d+$/.test(i.ark.charName))
console.log('有中文名    =', named.length, named.slice(0, 3).map(i => `${i.ark.charName}(${i.ark.charId})`))

// targetKey 对齐：同一 targetKey 下应有 1 个原图 + N 个 mod
const byKey = new Map()
for (const i of withLayer) {
  if (!byKey.has(i.jczx.targetKey)) byKey.set(i.jczx.targetKey, [])
  byKey.get(i.jczx.targetKey).push(i)
}
const multi = [...byKey.entries()].filter(([, v]) => v.length > 1)
console.log('targetKey 总数 =', byKey.size, ' 有多个版本的 =', multi.length)
console.log('\n--- 对齐样本 ---')
for (const [k, v] of multi.slice(0, 5)) {
  console.log(k)
  for (const it of v) {
    console.log(`   ${it.jczx.layer.padEnd(7)} mod=${(it.jczx.modId || '-').padEnd(14)} ` +
      `minor=${(it.spineMinor || '?').padEnd(5)} ok=${it.ok} kind=${it.skeletonKind} ` +
      `form=${(it.ark && it.ark.formLabel) || '-'}`)
  }
}
console.log('\n--- server stderr 尾部 ---')
console.log(log.split('\n').slice(-12).join('\n'))
bye()
process.exit(0)
