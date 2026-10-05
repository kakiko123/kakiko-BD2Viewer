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
  /* ------------------------------------------------- 几何正确性 + 换算一致性
     2026-10-04 定案：以前对**所有**附件都用射线法（把它当成一个环绕多边形），
     而 mesh 的顶点是按**网格**排布的 —— 算出来的「内外」完全错，于是「点脸上选到衣服、
     点身体选到背景」，高亮框也画成一团乱线。判据用**几何事实**：三角形重心必然在该层内。 */
  const geo = await cdp.evaluate(`
    const v = window.__bd2viewer
    const p = v.player
    if (!p || !p.skeleton) return { err: 'no-skeleton' }
    const sk = p.skeleton
    const rt = p.__spineRt
    const canvasEl = p.canvas
    const cw = canvasEl.clientWidth, ch = canvasEl.clientHeight
    const rcam = p.sceneRenderer.camera
    const host = document.getElementById('stageInner').getBoundingClientRect()

    /* 采样**只取「射线法会漏」的点**：两种判定一致的点没有区分度（变异测试测不出来 ——
       第一版就是这么假绿的：样本恰好都落在射线法也判对的区域）。这些点也正是用户会点错的地方。 */
    const samples = []
    let meshSeen = 0, skippedSame = 0
    for (let si = sk.slots.length - 1; si >= 0 && samples.length < 30; si--) {
      const slot = sk.slots[si]
      const name = slot.data && slot.data.name
      if (!name || v.state.hidden.has(name)) continue
      const att = slot.getAttachment && slot.getAttachment()
      if (!att || !att.triangles || att.triangles.length < 3) continue
      meshSeen++
      const n = att.worldVerticesLength
      const verts = new Float32Array(n)
      try { att.computeWorldVertices(slot, 0, n, verts, 0, 2) } catch { continue }
      const t = att.triangles
      for (let k = 0; k + 2 < t.length && samples.length < 30; k += 3) {
        const a = t[k] * 2, b = t[k + 1] * 2, c = t[k + 2] * 2
        const cxx = (verts[a] + verts[b] + verts[c]) / 3
        const cyy = (verts[a + 1] + verts[b + 1] + verts[c + 1]) / 3
        if (!Number.isFinite(cxx) || !Number.isFinite(cyy)) continue
        // 用「没有 triangles 的附件」= 纯射线法复算同一点；它判中了就说明这题没区分度，跳过
        if (v.isPointInAttachment(cxx, cyy, verts, {})) { skippedSame++; continue }
        const pt = v.worldToClient(cxx, cyy)
        if (!pt) continue
        const hits = v.pickLayersAt(pt.x, pt.y)
        samples.push({ layer: name, hit: hits.indexOf(name) >= 0, stack: hits.length })
      }
    }

    // 真实数据上「射线法」会漏判多少：对每个可见附件的每个三角形取重心，
    // 三角形法必然为 true，看射线法有多少次判 false（= 以前点这里选不中）
    let rayMiss = 0, rayTotal = 0
    const missByLayer = {}
    for (let si = 0; si < sk.slots.length; si++) {
      const slot = sk.slots[si]
      const name = slot.data && slot.data.name
      if (!name || v.state.hidden.has(name)) continue
      const att = slot.getAttachment && slot.getAttachment()
      if (!att || !att.triangles || att.triangles.length < 3) continue
      const n = att.worldVerticesLength
      const verts = new Float32Array(n)
      try { att.computeWorldVertices(slot, 0, n, verts, 0, 2) } catch { continue }
      const t = att.triangles
      for (let k = 0; k + 2 < t.length; k += 3) {
        const a = t[k] * 2, b = t[k + 1] * 2, c = t[k + 2] * 2
        const px = (verts[a] + verts[b] + verts[c]) / 3
        const py = (verts[a + 1] + verts[b + 1] + verts[c + 1]) / 3
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue
        rayTotal++
        const tri = v.isPointInAttachment(px, py, verts, att)
        // 用射线法复算同一点：临时构造一个「没有 triangles」的附件对象
        const ray = v.isPointInAttachment(px, py, verts, {})
        if (tri && !ray) { rayMiss++; missByLayer[name] = (missByLayer[name] || 0) + 1 }
      }
    }

    let diff = null
    try {
      const V3 = rt.Vector3
      const w = v.state.bounds
      const pts = [[w.offset.x, w.offset.y], [w.offset.x + w.size.x, w.offset.y + w.size.y]]
      diff = pts.map(pair => {
        const mine = v.worldToClient(pair[0], pair[1])
        const r = rcam.worldToScreen(new V3(pair[0], pair[1], 0), cw, ch)
        return {
          dx: Math.round(Math.abs(mine.x - (host.left + r.x)) * 100) / 100,
          dy: Math.round(Math.abs(mine.y - (host.top + (ch - r.y))) * 100) / 100,
        }
      })
    } catch (e) { diff = { err: String(e && e.message) } }
    return { samples, meshSeen, skippedSame, diff, rayMiss, rayTotal, missTop: Object.entries(missByLayer).sort((a, b) => b[1] - a[1]).slice(0, 5) }
  `, 180000)
  if (geo && geo.samples) {
    const okN = geo.samples.filter(x => x.hit).length
    const bad = geo.samples.filter(x => !x.hit).slice(0, 4).map(x => x.layer)
    check('网格密集处（射线法会漏的那些点）点选必须命中它所在的图层',
      geo.samples.length >= 10 && okN === geo.samples.length,
      `${okN}/${geo.samples.length} 命中（扫到 ${geo.meshSeen} 个网格附件，另有 ${geo.skippedSame} 个点两法一致已跳过）` +
      (bad.length ? ' · 漏掉：' + bad.join('/') : ''))
  } else {
    check('网格密集处（射线法会漏的那些点）点选必须命中它所在的图层', false, JSON.stringify(geo))
  }
  if (geo) {
    console.log('    [诊断] 真实数据上射线法的漏判：' + geo.rayMiss + '/' + geo.rayTotal +
      ' 个三角形重心（漏得最多的层：' + JSON.stringify(geo.missTop || []) + '）')
  }
  /* 纯函数锁：**构造一个 3×3 网格**（顶点按 row-major 排布、triangles 按标准切分）——
     这是 mesh 的典型形状。射线法把 0→1→2→…→8→0 连成一条蛇形折线，判定结果与真实网格
     差很多（离线算过：441 个采样点里 277 个分歧）。真实素材不一定含这种网格，
     所以这条必须喂构造数据，否则断言不敏感（实测第一版就是假绿的）。 */
  const pure = await cdp.evaluate(`
    const v = window.__bd2viewer
    const V = new Float32Array([
      0,2, 1,2, 2,2,
      0,1, 1,1, 2,1,
      0,0, 1,0, 2,0,
    ])
    const TRI = [0,3,1, 1,3,4, 1,4,2, 2,4,5, 3,6,4, 4,6,7, 4,7,5, 5,7,8]
    const mesh = { triangles: TRI }
    const poly = {}   // 没有 triangles → 走旧的射线法
    const inside = [[0.5,1.5],[1.5,1.5],[0.5,0.5],[1.5,0.5],[0.2,0.2],[1.8,1.8],[1.0,1.0]]
    const outside = [[-0.5,1],[2.5,1],[1,-0.5],[1,2.5],[3,3]]
    return {
      hitInside: inside.map(p => v.isPointInAttachment(p[0], p[1], V, mesh)),
      hitOutside: outside.map(p => v.isPointInAttachment(p[0], p[1], V, mesh)),
      rayInside: inside.map(p => v.isPointInAttachment(p[0], p[1], V, poly)),
    }
  `, 30000)
  check('网格附件：网格内的点必须命中（按三角形判定，不是拿顶点连成多边形）',
    (pure.hitInside || []).every(Boolean) && (pure.hitInside || []).length >= 7,
    `网格内 ${(pure.hitInside || []).filter(Boolean).length}/${(pure.hitInside || []).length} 命中 · ` +
    `网格外误命中 ${(pure.hitOutside || []).filter(Boolean).length}/${(pure.hitOutside || []).length} · ` +
    `同一批点用射线法只有 ${(pure.rayInside || []).filter(Boolean).length}/${(pure.rayInside || []).length}`)
  check('网格附件：网格外的点不许命中', (pure.hitOutside || []).every(x => x === false),
    JSON.stringify(pure.hitOutside))

  if (geo && geo.diff && Array.isArray(geo.diff)) {
    const maxD = Math.max(...geo.diff.map(d => Math.max(d.dx, d.dy)))
    check('自建的「世界→屏幕」与 Spine 官方 worldToScreen 一致（差 < 1px）',
      Number.isFinite(maxD) && maxD < 1,
      `最大差 ${maxD}px（${JSON.stringify(geo.diff)}）`)
  } else {
    check('自建的「世界→屏幕」与 Spine 官方 worldToScreen 一致（差 < 1px）', false, JSON.stringify(geo && geo.diff))
  }
} catch (e) {
  check('执行', false, e && e.message)
} finally {
  await cdp.close()
  try { server.kill() } catch { /* ignore */ }
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 失败 ' + fail}  （共 ${pass + fail} 项）`)
  process.exit(fail ? 1 : 0)
}
