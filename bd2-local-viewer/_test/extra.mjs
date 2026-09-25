/* 补充测试：① 真实 file input 上传流程 ② WebM 导出 ③ 添加根目录接口 */
import fs from 'node:fs'
import path from 'node:path'
import { Cdp } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8137'

/* 测试用的源文件目录：从 viewer.config.json 的第一个 root 推出来（不要在代码里写死本机路径）。
   也可以用环境变量 BD2_TEST_SRC 直接指定。 */
function resolveSrc() {
  if (process.env.BD2_TEST_SRC) return process.env.BD2_TEST_SRC
  if (!fs.existsSync('viewer.config.json')) {
    console.error('✕ 找不到 viewer.config.json，也没有设 BD2_TEST_SRC —— 无法定位测试用资产。')
    console.error('  照 viewer.config.example.json 建一份，或：$env:BD2_TEST_SRC="C:\\path\\to\\mods\\<某套资产>"')
    process.exit(2)
  }
  const cfg = JSON.parse(fs.readFileSync('viewer.config.json', 'utf8'))
  const root = cfg.roots?.[0]?.path
  if (!root) {
    console.error('✕ viewer.config.json 里没有 roots[0].path')
    process.exit(2)
  }
  return path.join(root, 'Eclipse Story effect yuk11sh1d4')
}

const SRC = resolveSrc()
const results = []
let failed = 0
const check = (n, ok, d = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  →  ' + d : ''}`); if (!ok) failed++ }

const cdp = await Cdp.launch({ size: '1500,900' })
try {
  // ---------- ① 上传流程 ----------
  await cdp.goto(`${BASE}/`)
  await cdp.waitFor(`document.getElementById('stageInner').dataset.debug`, 40000, 'init')

  await cdp.evaluate(`document.getElementById('btnUpload').click(); return true`)
  await cdp.send('DOM.enable')
  const doc = await cdp.send('DOM.getDocument', { depth: -1 })
  const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#filePick' })

  const files = ['illust_special6.json', 'illust_special6.atlas', 'illust_special6.png']
    .map(f => path.join(SRC, f))
  const exist = files.every(f => fs.existsSync(f))
  check('测试用 Spine 文件存在', exist, files.map(f => path.basename(f)).join(', '))
  if (!exist) throw new Error('源文件缺失')

  await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files })
  await new Promise(r => setTimeout(r, 500))
  const picked = await cdp.evaluate(`
    return document.getElementById('dropText').textContent
  `)
  check('文件选择器接受了 3 个文件', /3\s*个文件/.test(picked), picked)

  await cdp.evaluate(`
    document.getElementById('uploadName').value = '上传测试资产'
    document.getElementById('btnDoUpload').click()
    return true
  `)
  const upload = await cdp.evaluate(`
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      const st = __bd2viewer.state
      const cur = st.current
      if (cur && cur.folder === '上传测试资产' && !st.busy && st.player && st.player.skeleton && st.animations.length) {
        await new Promise(r => setTimeout(r, 900))
        const dbg = JSON.parse(document.getElementById('stageInner').dataset.debug)
        const cv = st.player.canvas
        const t = document.createElement('canvas')
        const W = Math.min(cv.width, 600), H = Math.min(cv.height, 600)
        t.width = W; t.height = H
        const c = t.getContext('2d')
        c.drawImage(cv, 0, 0, W, H)
        const d = c.getImageData(0, 0, W, H).data
        let opaque = 0
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++
        return { anims: dbg.anims, slots: dbg.slots, opaque, cover: +(opaque / (W * H)).toFixed(4),
                 customCount: st.customItems.length,
                 err: document.getElementById('errorBox').hidden ? null : document.getElementById('errorBox').textContent }
      }
      await new Promise(r => setTimeout(r, 200))
    }
    return { timeout: true, msg: document.getElementById('uploadMsg').textContent }
  `)
  check('上传的资产被载入并渲染',
    !upload.timeout && upload.opaque > 60,
    upload.timeout ? '超时: ' + upload.msg : JSON.stringify(upload))
  check('上传资产进入了「已上传」列表', upload.customCount === 1, `customItems=${upload.customCount}`)

  // ---------- ② WebM 导出 ----------
  await cdp.evaluate(`__bd2viewer.state.fps = 30; return true`)
  const webm = await cdp.evaluate(`
    let blobs = []
    const orig = URL.createObjectURL
    URL.createObjectURL = function (b) { blobs.push(b); return orig.call(this, b) }
    let err = null
    try { await __bd2viewer.exportWebm(false) } catch (e) { err = e.message }
    URL.createObjectURL = orig
    const b = blobs[0]
    return { err, count: blobs.length, size: b ? b.size : 0, type: b ? b.type : null }
  `, 60000)
  check('WebM 导出产出视频 blob',
    !webm.err && webm.size > 10000,
    webm.err ? '异常: ' + webm.err : `${(webm.size / 1024).toFixed(0)} KB ${webm.type}`)

  // ---------- ③ 添加根目录接口 ----------
  const rootsApi = await cdp.evaluate(`
    const res = await fetch('/api/roots', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ${JSON.stringify(SRC)}, label: '单目录测试' })
    })
    const data = await res.json()
    const cfg = await (await fetch('/api/config')).json()
    return { ok: res.ok, root: data.root, exists: data.exists, rootCount: cfg.roots.length }
  `)
  check('添加根目录 API 可用', rootsApi.ok && rootsApi.rootCount >= 2,
    `roots=${rootsApi.rootCount} exists=${rootsApi.exists}`)

  const single = await cdp.evaluate(`
    const res = await fetch('/api/scan?root=' + ${JSON.stringify(rootsApi.root?.id || '')} + '&refresh=1')
    const d = await res.json()
    return { items: d.itemCount, playable: d.playableCount, first: d.items[0] && d.items[0].relAtlas }
  `)
  check('单目录根也能扫到资产', single.items >= 1 && single.playable === single.items,
    JSON.stringify(single))

  const err = await cdp.consoleErrors()
  check('无错误提示', !err, err || '')
} catch (e) {
  check('测试执行', false, e.message)
} finally {
  console.log(results.join('\n'))
  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 失败 ' + failed}  （共 ${results.length} 项）`)
  await cdp.close()
  process.exit(failed ? 1 : 0)
}
