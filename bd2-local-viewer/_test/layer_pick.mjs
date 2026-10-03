/**
 * 图层点选：再次选中同一个图层 → 改选它下面一层（列表 + 模型两个入口）。
 *
 * 需求：「第二次选择如果还是同一个图层，就选它下面一层；第三次点击以此类推」。
 *
 * 需要 BD2_JCZX_ROOT（真实骨架才有足够多的图层可点），否则 SKIP 退出 0。
 * 用 Chrome → 必须排在 native_mode 之后（cdp 固定 9333）。
 *   BD2_JCZX_ROOT=C:/path/to/交错战线图鉴-20260917 node _test/layer_pick.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Cdp } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const R = process.env.BD2_JCZX_ROOT || 'C:/Users/KAKIKO/Videos/新建文件夹/交错战线图鉴-20260917'
if (!fs.existsSync(R)) { console.log('SKIP'); process.exit(0) }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-cycle-'))
const cfg = path.join(work, 'viewer.config.json')
fs.writeFileSync(cfg, JSON.stringify({
  port: 8261, maxDepth: 6,
  roots: [{ id: 'jczx', path: R, label: '图鉴' }],
}, null, 2), 'utf-8')
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: REPO, env: { ...process.env, BD2_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', d => { log += d })
server.stderr.on('data', d => { log += d })
process.on('exit', () => { try { server.kill() } catch { /* ignore */ } })

let BASE = ''
const dl = Date.now() + 30000
while (Date.now() < dl) {
  const m = /地址：(http:\/\/[^\s/]+)/.exec(log)
  if (m) { BASE = m[1].replace(/\/$/, ''); break }
  await new Promise(r => setTimeout(r, 200))
}
if (!BASE) { console.log('服务没起来'); process.exit(1) }

let pass = 0, fail = 0
const check = (n, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); ok ? pass++ : fail++ }

const cdp = await Cdp.launch({ size: '1280,860' })
try {
  await cdp.goto(`${BASE}/?mode=jczx`)
  await cdp.waitFor('window.__bd2viewer', 20000, '__bd2viewer')
  await cdp.evaluate(`
    const v = window.__bd2viewer
    v.setThumbPersist(false)
    v.setAssetMode('jczx')
    let last = -1, same = 0
    for (let i = 0; i < 900; i++) {
      const n = v.allItems().length
      if (n > 0 && n === last) { if (++same >= 3) return n } else same = 0
      last = n
      await new Promise(r => setTimeout(r, 250))
    }
    return -1
  `, 260000)

  // 打开一个能播的条目
  await cdp.evaluate(`
    const v = window.__bd2viewer
    const t = v.allItems().find(i => i.ok)
    if (t) v.openItem(t)
    return !!t
  `, 120000)
  await cdp.waitFor(`
    (() => { const p = window.__bd2viewer.state.player
      return !!(p && p.skeleton && (p.skeleton.data.animations||[]).length) })()
  `, 90000, '骨架播起来')

  /* ---- ① 列表：连点同一行两次 ---- */
  const listRes = await cdp.evaluate(`
    const v = window.__bd2viewer
    const rows = [...document.querySelectorAll('#layerList .layer-row')]
      .filter(el => el.querySelector('.name'))
    if (rows.length < 3) return { err: '图层太少 ' + rows.length }
    const idx = 2
    const rowName = rows[idx].querySelector('.name').textContent
    const nextName = rows[idx + 1].querySelector('.name').textContent
    const thirdName = rows[idx + 2].querySelector('.name').textContent
    const clickRow = i => {
      const el = [...document.querySelectorAll('#layerList .layer-row')]
        .filter(x => x.querySelector('.name'))[i]
      el.click()
    }
    const out = {}
    clickRow(idx)
    out.first = v.state.selectedLayer
    clickRow(idx)                     // 窗口内再点同一行
    out.second = v.state.selectedLayer
    clickRow(idx)                     // 再点
    out.third = v.state.selectedLayer
    out.expect = [rowName, nextName, thirdName]
    return out
  `)
  if (listRes.err) { check('列表用例', false, listRes.err); }
  else {
    check('列表：第一次点选中的就是那一行', listRes.first === listRes.expect[0],
      `${listRes.first} vs ${listRes.expect[0]}`)
    check('列表：再点同一行 → 挪到下面一行', listRes.second === listRes.expect[1],
      `${listRes.second} vs ${listRes.expect[1]}`)
    check('列表：继续点 → 再往下挪一行', listRes.third === listRes.expect[2],
      `${listRes.third} vs ${listRes.expect[2]}`)
  }

  /* ---- ② 换成点别的行 → 记忆归零 ---- */
  const switchRes = await cdp.evaluate(`
    const v = window.__bd2viewer
    const rows = () => [...document.querySelectorAll('#layerList .layer-row')].filter(x => x.querySelector('.name'))
    const nm = i => rows()[i].querySelector('.name').textContent
    rows()[5].click()
    const a = v.state.selectedLayer
    rows()[5].click()
    const b = v.state.selectedLayer
    rows()[9].click()               // 换一行 → 应该直接选中它本身
    const c = v.state.selectedLayer
    return { a: a, b: b, c: c, n5: nm(5), n6: nm(6), n9: nm(9) }
  `)
  check('列表：换一行点选 → 直接从它本身开始（记忆归零）',
    switchRes.c === switchRes.n9, `${switchRes.c} vs ${switchRes.n9}（b=${switchRes.b}）`)

  /* ---- ③ 模型点选：同一处连点两次 → 穿透到下一层 ---- */
  const modelRes = await cdp.evaluate(`
    const v = window.__bd2viewer
    // ⚠️ 必须先打开「图层选择模式」——pointerup 处理器第一句就是 if (!S.layerSelect) return
    const chk = document.getElementById('chkLayerSelect')
    if (chk && !chk.checked) { chk.checked = true; chk.dispatchEvent(new Event('change')) }
    if (!v.state.layerSelect) return { err: '图层选择模式没打开' }
    const box = document.getElementById('stageInner').getBoundingClientRect()
    // 找一个「命中栈 >= 2」的点（中心往外螺旋找）
    let found = null
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2
    for (const r of [0, 20, 40, 70, 100, 140]) {
      for (const a of [0, 45, 90, 135, 180, 225, 270, 315]) {
        const x = cx + r * Math.cos(a * Math.PI / 180)
        const y = cy + r * Math.sin(a * Math.PI / 180)
        const hits = v.pickLayersAt(x, y)
        if (hits.length >= 2) { found = { x: x, y: y, hits: hits }; break }
      }
      if (found) break
    }
    if (!found) return { err: '找不到命中栈 >= 2 的点' }
    const host = document.getElementById('stageInner')
    const clickAt = (x, y) => {
      const opts = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }
      host.dispatchEvent(new PointerEvent('pointerdown', opts))
      host.dispatchEvent(new PointerEvent('pointerup', opts))
    }
    const out = { hits: found.hits }
    v.state.selectedLayer = null
    clickAt(found.x, found.y)
    out.first = v.state.selectedLayer
    clickAt(found.x, found.y)
    out.second = v.state.selectedLayer
    clickAt(found.x, found.y)
    out.third = v.state.selectedLayer
    return out
  `)
  if (modelRes.err) { check('模型用例', false, modelRes.err); }
  else {
    check('模型：第一次点选中最上面那层', modelRes.first === modelRes.hits[0],
      `${modelRes.first} vs ${modelRes.hits[0]}`)
    check('模型：再点同一处 → 穿透到下一层', modelRes.second === modelRes.hits[1],
      `${modelRes.second} vs ${modelRes.hits[1]}（栈 ${modelRes.hits.slice(0, 4).join(' > ')}）`)
    check('模型：继续点 → 再往下穿透', modelRes.third === modelRes.hits[2],
      `${modelRes.third} vs ${modelRes.hits[2]}`)
  }
} catch (e) {
  check('执行', false, e && e.message)
} finally {
  await cdp.close()
  try { server.kill() } catch { /* ignore */ }
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 失败 ' + fail}  （共 ${pass + fail} 项）`)
  process.exit(fail ? 1 : 0)
}
