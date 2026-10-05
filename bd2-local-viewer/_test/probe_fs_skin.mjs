/** 单独验「全屏皮肤下拉」：两个下拉填同一份数据、disabled 一致、选一个两边同步。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Cdp } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const LOST = process.env.BD2_LOST_ROOT || 'E:/Neowiz/Browndust2/BrownDust2_10000002/BepInEx/plugins/BrownDustX/mods'
if (!fs.existsSync(LOST)) { console.log('SKIP 找不到素材根：' + LOST); process.exit(0) }
console.log('根存在（bd 档，lostsword 档在这个根上扫出 0 条）：' + LOST)

let pass = 0, fail = 0
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`)
  ok ? pass++ : fail++
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fsskin-'))
const cfg = path.join(work, 'viewer.config.json')
fs.writeFileSync(cfg, JSON.stringify({
  port: 8291, maxDepth: 5,
  roots: [{ id: 'lost', path: LOST, label: 'BD2' }],
}, null, 2), 'utf-8')
const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: REPO, env: { ...process.env, BD2_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
srv.stdout.on('data', d => { log += d })
srv.stderr.on('data', d => { log += d })

let BASE = ''
for (let i = 0; i < 150 && !BASE; i++) {
  const m = /地址：(http:\/\/\S+)/.exec(log)
  if (m) {
    const cand = m[1].replace(/\/$/, '')
    try { if ((await fetch(`${cand}/api/health`)).ok) BASE = cand } catch { /* retry */ }
  }
  if (!BASE) await new Promise(r => setTimeout(r, 200))
}
if (!BASE) {
  console.log('FAIL 服务端没起来。日志尾部：\n' + log.slice(-1200))
  process.exit(1)
}
console.log('服务端：' + BASE)

const cdp = await Cdp.launch({ size: '1280,860' })
try {
  await cdp.goto(`${BASE}/?mode=bd`)
  await cdp.waitFor('window.__bd2viewer', 20000, '__bd2viewer')
  const n = await cdp.evaluate(`
    const v = window.__bd2viewer
    v.setThumbPersist(false)
    v.setAssetMode('bd')
    let last=-1,same=0
    for (let i=0;i<800;i++){const c=v.allItems().length
      if(c>0&&c===last){if(++same>=3)return c}else same=0;last=c
      await new Promise(r=>setTimeout(r,250))}
    return -1`, 240000)
  console.log('可见条目：' + n)

  // 直接打开**已知的多皮肤骨架**（逐个试会超时）：illust_dating7 有 4 个皮肤
  const opened = await cdp.evaluate(`
    const v = window.__bd2viewer
    const t = v.allItems().find(i => /illust_dating7|dating14|dating16/.test(String(i.relAtlas)))
    if (!t) return { none: true, sample: v.allItems().slice(0,3).map(i => i.relAtlas) }
    v.openItem(t)
    for (let k = 0; k < 80; k++) {
      await new Promise(r => setTimeout(r, 250))
      if (v.state.skins && v.state.skins.length > 1) {
        return { rel: t.relAtlas, skins: v.state.skins.length, names: v.state.skins.slice(0, 6) }
      }
    }
    return { none: true, rel: t.relAtlas, maxSkins: (v.state.skins||[]).length }
  `, 90000)
  if (opened.none) {
    check('找到多皮肤条目（皮肤行的前提）', false, JSON.stringify(opened))
  } else {
    await cdp.waitFor(`
      (() => { const p = window.__bd2viewer.state.player
        return !!(p && p.skeleton && (p.skeleton.data.animations||[]).length) })()
    `, 90000, '骨架播起来')
    const r = await cdp.evaluate(`
      const v = window.__bd2viewer
      v.setFullscreen(true)
      await new Promise(r => setTimeout(r, 500))
      const a = document.getElementById('skinSelect')
      const b = document.getElementById('fsSkin')
      const wrap = document.getElementById('fsSkinWrap')
      const out = { skins: v.state.skins.length, aN: a.options.length, bN: b.options.length,
                    aDis: a.disabled, bDis: b.disabled, wrapHidden: wrap.hidden,
                    boxHidden: document.getElementById('fsExtra').hidden, poseHidden: document.getElementById('fsPoseBar').hidden }
      const pick = b.options[1] ? b.options[1].value : null
      if (pick) {
        b.value = pick
        b.dispatchEvent(new Event('change'))
        await new Promise(r => setTimeout(r, 2000))
        out.picked = pick; out.afterA = a.value; out.afterB = b.value
      }
      return out
    `, 60000)
    console.log('  实测：' + JSON.stringify(r))
    check('两个皮肤下拉选项数一致', r.aN === r.bN && r.aN === r.skins, JSON.stringify({ skins: r.skins, aN: r.aN, bN: r.bN }))
    check('disabled 状态一致', r.aDis === r.bDis, `侧栏 ${r.aDis} / 全屏 ${r.bDis}`)
    check('皮肤行在全屏里显示出来', r.wrapHidden === false && r.boxHidden === false, JSON.stringify(r))
    check('选全屏的皮肤后两个下拉同步', r.afterA === r.picked && r.afterB === r.picked,
      `选中 ${r.picked} · 侧栏=${r.afterA} 全屏=${r.afterB}`)
  }
} catch (e) {
  check('执行', false, e && e.message)
} finally {
  await cdp.close()
  try { srv.kill() } catch { /* ignore */ }
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 失败 ' + fail}  （共 ${pass + fail} 项）`)
  process.exit(fail ? 1 : 0)
}
