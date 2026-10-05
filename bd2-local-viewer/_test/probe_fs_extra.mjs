/**
 * 验证「全屏下的姿势条 + 皮肤下拉」（BD2Viewer-fs-pose-skin.md）。
 * 断言要点：两个容器**填同一份数据**、点全屏按钮走原来的 switchPose、
 * 显隐规则（不在全屏 / 文件列表开着 / 只有一种 → 藏）、切皮肤两个下拉同步。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Cdp } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const ARK = process.env.BD2_ARK_ROOT || ''
const LOST = process.env.BD2_LOST_ROOT || 'E:/Neowiz/Browndust2/BrownDust2_10000002/BepInEx/plugins/BrownDustX/mods'
if (!ARK || !fs.existsSync(ARK)) { console.log('SKIP 没有 BD2_ARK_ROOT'); process.exit(0) }

let pass = 0, fail = 0
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`)
  ok ? pass++ : fail++
}

const PLAYING = `
  (() => { const p = window.__bd2viewer.state.player
    return !!(p && p.skeleton && (p.skeleton.data.animations||[]).length) })()
`

function startServer(rootId, rootPath, port) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fsextra-'))
  const cfg = path.join(work, 'viewer.config.json')
  fs.writeFileSync(cfg, JSON.stringify({
    port, maxDepth: 7,
    roots: [{ id: rootId, path: rootPath, label: rootId }],
  }, null, 2), 'utf-8')
  const p = spawn(process.execPath, ['server.mjs'], {
    cwd: REPO, env: { ...process.env, BD2_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  p.stdout.on('data', d => { log += d })
  p.stderr.on('data', d => { log += d })
  return { proc: p, logRef: () => log }
}

async function waitBase(getLog, port, deadline = 30000) {
  const dl = Date.now() + deadline
  while (Date.now() < dl) {
    const m = /地址：(http:\/\/\S+)/.exec(getLog())
    if (m) {
      const base = m[1].replace(/\/$/, '')
      try { if ((await fetch(`${base}/api/health`)).ok) return base } catch { /* retry */ }
    }
    await new Promise(r => setTimeout(r, 200))
  }
  return null
}

const cdp = await Cdp.launch({ size: '1280,860' })
let srv = null
try {
  /* ================= ① Ark：多姿势 ================= */
  srv = startServer('ark', ARK, 8285)
  const base = await waitBase(srv.logRef, 8285)
  if (!base) throw new Error('server not up')
  await cdp.goto(`${base}/?mode=ark`)
  await cdp.waitFor('window.__bd2viewer', 20000, '__bd2viewer')
  await cdp.evaluate(`
    const v = window.__bd2viewer
    v.setThumbPersist(false)
    v.setAssetMode('ark')
    let last=-1,same=0
    for (let i=0;i<800;i++){const n=v.allItems().length
      if(n>0&&n===last){if(++same>=3)return n}else same=0;last=n
      await new Promise(r=>setTimeout(r,250))}
    return -1`, 240000)

  const picked = await cdp.evaluate(`
    const v = window.__bd2viewer
    // 挑一个「成员（姿势）> 1」且可播的
    const t = v.allItems().find(i => i.ok && Array.isArray(i.members) && i.members.length > 1)
    if (!t) return { none: true, max: Math.max(0, ...v.allItems().map(i => (i.members||[]).length)) }
    v.openItem(t)
    return { rel: t.relAtlas, forms: t.members.length, names: t.members.map(m => (m.form && m.form.formLabel) || m.pose) }
  `, 60000)
  if (picked.none) {
    check('Ark 里有成员>1 的条目（姿势条的前提）', false, `最多 ${picked.max} 个成员`)
  } else {
    await cdp.waitFor(PLAYING, 90000, 'ark 骨架播起来')
    // ⚠️ 必须在开全屏**之前**读，否则测的就不是「非全屏」了
    const before0 = await cdp.evaluate(`
      const box = document.getElementById('fsExtra')
      return { boxHidden: box.hidden, boxExists: !!box,
               fsCount: document.getElementById('fsPoseBar').childElementCount,
               sideCount: document.getElementById('poseBar').childElementCount }
    `, 20000)
    check('非全屏时整条藏', before0.boxHidden === true, JSON.stringify(before0))
    check('非全屏时按钮已经填好了（只是藏着）',
      before0.boxExists && before0.fsCount === before0.sideCount && before0.fsCount > 1,
      JSON.stringify(before0))
    await cdp.evaluate(`
      const v = window.__bd2viewer
      v.setFullscreen(true)
      await new Promise(r => setTimeout(r, 300))
      const box = document.getElementById('fsExtra')
      const side = document.getElementById('poseBar')
      const fsb = document.getElementById('fsPoseBar')
      return { boxHidden: box.hidden, sideCount: side.childElementCount, fsCount: fsb.childElementCount,
               sideText: [...side.children].map(b => b.textContent), fsText: [...fsb.children].map(b => b.textContent) }
    `, 30000)
    const fs2 = await cdp.evaluate(`
      const v = window.__bd2viewer
      v.setFullscreen(true)
      await new Promise(r => setTimeout(r, 400))
      const box = document.getElementById('fsExtra')
      const side = document.getElementById('poseBar')
      const fsb = document.getElementById('fsPoseBar')
      return { boxHidden: box.hidden, sideCount: side.childElementCount, fsCount: fsb.childElementCount,
               sideText: [...side.children].map(b => b.textContent), fsText: [...fsb.children].map(b => b.textContent),
               pressedSide: [...side.children].map(b => b.getAttribute('aria-pressed')),
               pressedFs: [...fsb.children].map(b => b.getAttribute('aria-pressed')) }
    `, 30000)
    check('全屏时全屏条显示', fs2.boxHidden === false, JSON.stringify(fs2))
    check('姿势按钮数一致（同一份数据）', fs2.sideCount === fs2.fsCount && fs2.sideCount > 1,
      `侧栏 ${fs2.sideCount} / 全屏 ${fs2.fsCount}`)
    check('姿势按钮文案一致', JSON.stringify(fs2.sideText) === JSON.stringify(fs2.fsText),
      JSON.stringify(fs2.fsText))
    check('aria-pressed 状态一致', JSON.stringify(fs2.pressedSide) === JSON.stringify(fs2.pressedFs),
      `侧栏 ${fs2.pressedSide} / 全屏 ${fs2.pressedFs}`)

    // 点全屏条第二个姿势 → 应该切过去
    const before = await cdp.evaluate(`return window.__bd2viewer.state.currentPose || ''`, 20000)
    const after = await cdp.evaluate(`
      const v = window.__bd2viewer
      const btns = [...document.getElementById('fsPoseBar').children]
      const target = btns.find(b => b.getAttribute('aria-pressed') === 'false') || btns[btns.length-1]
      target.click()
      await new Promise(r => setTimeout(r, 2500))
      const side = document.getElementById('poseBar')
      const fsb = document.getElementById('fsPoseBar')
      return { pose: v.state.currentPose, pressedSide: [...side.children].map(b=>b.getAttribute('aria-pressed')),
               pressedFs: [...fsb.children].map(b=>b.getAttribute('aria-pressed')),
               target: target.dataset.pose }
    `, 60000)
    check('点全屏姿势按钮真的切了姿势', after.pose === after.target && after.pose !== before,
      `${before} → ${after.pose}（点了 ${after.target}）`)
    check('切完两个容器的高亮同步', JSON.stringify(after.pressedSide) === JSON.stringify(after.pressedFs),
      `侧栏 ${after.pressedSide} / 全屏 ${after.pressedFs}`)

    // 文件列表开着 → 整条藏
    const hidden2 = await cdp.evaluate(`
      // toggleFsFiles 没挂到 __bd2viewer，走真实入口：点 #fsFiles
      document.getElementById('fsFiles').click()
      await new Promise(r => setTimeout(r, 400))
      const h = document.getElementById('fsExtra').hidden
      document.getElementById('fsFiles').click()
      await new Promise(r => setTimeout(r, 300))
      return { h, back: document.getElementById('fsExtra').hidden }
    `, 30000)
    check('文件列表开着时全屏条藏起来', hidden2.h === true, JSON.stringify(hidden2))

    // 退出全屏 → 藏
    const off = await cdp.evaluate(`
      const v = window.__bd2viewer
      v.setFullscreen(false)
      await new Promise(r => setTimeout(r, 300))
      return document.getElementById('fsExtra').hidden
    `, 30000)
    check('退出全屏后整条藏', off === true, String(off))
  }

  /* ================= ② 皮肤下拉（Lost Sword 多皮肤） ================= */
  if (fs.existsSync(LOST)) {
    try { srv.proc.kill() } catch { /* ignore */ }
    srv = startServer('lost', LOST, 8286)
    const base2 = await waitBase(srv.logRef, 8286, 30000)
    if (base2) {
      await cdp.goto(`${base2}/?mode=lostsword`)
      await cdp.waitFor('window.__bd2viewer', 20000, '__bd2viewer')
      const sk = await cdp.evaluate(`
        const v = window.__bd2viewer
        v.setThumbPersist(false)
        v.setAssetMode('lostsword')
        let last=-1,same=0
        for (let i=0;i<800;i++){const n=v.allItems().length
          if(n>0&&n===last){if(++same>=3)return n}else same=0;last=n
          await new Promise(r=>setTimeout(r,250))}
        return -1`, 240000)
      const skRes = await cdp.evaluate(`
        const v = window.__bd2viewer
        const multi = v.allItems().find(i => i.ok && Array.isArray(v.state.skins) )
        const t = v.allItems().find(i => i.ok)
        if (!t) return { none: true }
        v.openItem(t)
        return { rel: t.relAtlas, picked: t.relAtlas }
      `, 60000)
      if (!skRes.none) {
        await cdp.waitFor(PLAYING, 90000, 'lostsword 骨架播起来')
        const s2 = await cdp.evaluate(`
          const v = window.__bd2viewer
          v.setFullscreen(true)
          await new Promise(r => setTimeout(r, 400))
          const a = document.getElementById('skinSelect')
          const b = document.getElementById('fsSkin')
          const wrap = document.getElementById('fsSkinWrap')
          const out = { skins: v.state.skins.length, aN: a.options.length, bN: b.options.length,
                        aVal: a.value, bVal: b.value, wrapHidden: wrap.hidden, boxHidden: document.getElementById('fsExtra').hidden,
                        aDis: a.disabled, bDis: b.disabled }
          // 切一次皮肤，看两个下拉是否同步
          if (b.options.length > 1) {
            const pick = b.options[1].value
            b.value = pick
            b.dispatchEvent(new Event('change'))
            await new Promise(r => setTimeout(r, 1500))
            out.afterA = a.value; out.afterB = b.value; out.picked = pick
          }
          return out
        `, 60000)
        check('两个皮肤下拉选项数一致', s2.aN === s2.bN, JSON.stringify({ skins: s2.skins, aN: s2.aN, bN: s2.bN }))
        check('disabled 状态一致', s2.aDis === s2.bDis, `侧栏 ${s2.aDis} / 全屏 ${s2.bDis}`)
        if (s2.skins > 1) {
          check('皮肤行在全屏里显示出来', s2.wrapHidden === false && s2.boxHidden === false, JSON.stringify(s2))
          check('选全屏的皮肤后两个下拉同步', s2.afterA === s2.picked && s2.afterB === s2.picked,
            `选中 ${s2.picked} · 侧栏=${s2.afterA} 全屏=${s2.afterB}`)
        } else {
          check('只有一个皮肤时皮肤行藏起来', s2.wrapHidden === true, JSON.stringify(s2))
        }
      }
    }
  } else {
    console.log('（跳过皮肤部分：找不到 Lost Sword 根 ' + LOST + '）')
  }
} catch (e) {
  check('执行', false, e && e.message)
} finally {
  await cdp.close()
  if (srv) { try { srv.proc.kill() } catch { /* ignore */ } }
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 失败 ' + fail}  （共 ${pass + fail} 项）`)
  process.exit(fail ? 1 : 0)
}
