/**
 * 扫描结果缓存：冷启动先垫「上次的结果」，不用干等一遍 walk。
 *
 *  手机端扫一遍几万文件的目录要几十秒，每次打开 App 都重来一遍非常难受。
 *  缩略图早就在 IndexedDB 里了，这里再把**条目本身**存一份：打开 → 立刻画出上次的网格
 *  （能翻、能点开看）→ 真扫描在后台跑完再整包替换。桌面端同样受益。
 *
 *  ⚠ 需要真实素材（要够多，扫描才有可观测的耗时）：
 *    BD2_JCZX_ROOT=C:/path/to/交错战线图鉴-20260917 node _test/scan_cache.mjs
 *  没给（或目录不存在）→ 整段跳过并判 PASS。
 *
 *  判据不用「等多久」这种会飘的东西：调试面给了 `scanCacheStats.restores`
 *  （这次会话垫了几次）和 `readScanCache()`（缓存里到底存了什么）—— 都是单调量。
 *  另外顺手看一眼「垫上之后是不是真的能立刻看到卡片」（items>0 且 busy 还是 true）。
 *
 *  自己在同一个脚本里 spawn server.mjs（BD2_CONFIG 指向临时配置），跑完 kill ——
 *  别用 shell `&` 起后台，工具一返回子进程就被杀。
 *  注意别并行开第二个 Chrome：cdp.mjs 端口写死 9333（所以排在 native_mode 之后）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Cdp } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const NODE = process.execPath
let BASE = ''

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/* ---------------------------------------------------------- 素材：没有就跳过 */
const ROOT = process.env.BD2_JCZX_ROOT || ''
if (!ROOT || !fs.existsSync(ROOT)) {
  console.log('SKIP  未设置 BD2_JCZX_ROOT（或目录不存在）→ 跳过扫描缓存验收')
  process.exit(0)
}

/* ---------------------------------------------------------- 拉起服务端 */
// ⚠️ 临时目录必须建在仓库 _scratch/ 下：往系统 temp 写会被沙箱拦。
const work = fs.mkdtempSync(path.join(REPO, '_scratch', 'sc-'))
const cfg = path.join(work, 'viewer.config.json')
fs.writeFileSync(cfg, JSON.stringify({
  port: 8202,
  roots: [{ id: 'jczx', path: ROOT, label: '交错战线图鉴', game: 'jczx' }],
}, null, 2), 'utf-8')
let server = null
let serverLog = ''
function startServer() {
  server = spawn(NODE, ['server.mjs'], {
    cwd: REPO,
    env: { ...process.env, BD2_CONFIG: cfg },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverLog = ''
  server.stdout.on('data', d => { serverLog += d })
  server.stderr.on('data', d => { serverLog += d })
}
function stopServer() {
  try { server && server.kill() } catch { /* ignore */ }
  server = null
}
const cleanup = () => stopServer()
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })

async function waitServer() {
  const pDeadline = Date.now() + 30000
  while (Date.now() < pDeadline) {
    const m = /地址：(http:\/\/[^\s/]+)/.exec(serverLog)
    if (m) { BASE = m[1].replace(/\/$/, ''); break }
    await new Promise(r => setTimeout(r, 200))
  }
  if (!BASE) throw new Error('没读到服务端端口\n' + serverLog.slice(-1500))
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return true
    } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('服务端未就绪 @ ' + BASE + '\n' + serverLog.slice(-2000))
}

const URL0 = () => `${BASE}/?mode=jczx`
const cdp = await Cdp.launch({ size: '1680,950' })
try {
  console.log('\n=== 0. 服务端 ===')
  startServer()
  await waitServer()
  check('服务端就绪', true, BASE)

  console.log('\n=== 1. 第一次打开：没有缓存可垫，扫完要把结果存下来 ===')
  await cdp.goto(URL0())
  await cdp.waitFor(`window.__bd2viewer`, 20000, '__bd2viewer 就绪')
  const first = await cdp.evaluate(`
    const v = window.__bd2viewer
    v.setThumbPersist(false)
    v.setAssetMode('jczx')
    for (let i = 0; i < 600; i++) {
      if ((v.state.items || []).length > 0) break
      await new Promise(r => setTimeout(r, 100))
    }
    // 写入是 fire-and-forget，等它落盘
    for (let i = 0; i < 200; i++) {
      const rec = await v.readScanCache()
      if (rec && rec.items && rec.items.length) break
      await new Promise(r => setTimeout(r, 100))
    }
    const rec = await v.readScanCache()
    return {
      items: (v.state.items || []).length,
      restores: v.scanCacheStats.restores,
      cached: rec ? rec.items.length : 0,
      cachedRootPath: rec ? rec.rootPath : null,
      cachedCounts: rec ? [rec.playableCount, rec.itemCount] : null,
      key: v.scanCacheStats.key,
      stateRootPath: v.state.rootPath,
    }
  `, 120000)
  console.log('    ' + JSON.stringify(first))
  check('第一次打开扫到条目', first.items > 100, `${first.items} 条`)
  check('第一次打开没有「垫底」（本来就没缓存）', first.restores === 0, `restores=${first.restores}`)
  check('扫描结果已存进 IndexedDB', first.cached === first.items,
    `缓存 ${first.cached} 条 / 实际 ${first.items} 条`)
  check('缓存里记了根目录绝对路径', !!first.cachedRootPath && first.cachedRootPath === first.stateRootPath,
    `${first.cachedRootPath} vs ${first.stateRootPath}`)
  check('缓存键带上了 mode', /\|jczx$/.test(first.key || ''), first.key)

  console.log('\n=== 2. 第二次打开（IndexedDB 还在）：应当先垫出来 ===')
  // ⚠️ 服务端也要重启：桌面服务自己有一份内存 scanCache，不重启的话第二次扫描
  //    1ms 就返回了，「垫底发生在真扫描之前」这一刻根本观察不到。
  //    手机冷启动就是两端内存都是空的、只有 IndexedDB 还在 ——  restart 才能复现。
  stopServer()
  await new Promise(r => setTimeout(r, 500))
  startServer()
  await waitServer()
  await cdp.goto(URL0())
  await cdp.waitFor(`window.__bd2viewer`, 20000, '__bd2viewer 就绪')
  // 垫底发生在 scan() 开头，比网络请求早 —— 轮询抓「已经有条目了但还在扫描」这一刻
  const second = await cdp.evaluate(`
    const v = window.__bd2viewer
    let early = null
    for (let i = 0; i < 600; i++) {
      const n = (v.state.items || []).length
      if (n > 0) { early = { items: n, busy: !!v.state.busy, restores: v.scanCacheStats.restores }; break }
      await new Promise(r => setTimeout(r, 20))
    }
    // 再等真扫描收尾
    for (let i = 0; i < 600; i++) {
      if (!v.state.busy && (v.state.items || []).length > 0) break
      await new Promise(r => setTimeout(r, 100))
    }
    return {
      early,
      restores: v.scanCacheStats.restores,
      items: (v.state.items || []).length,
      cards: document.querySelectorAll('#galGrid .card').length,
    }
  `, 180000)
  console.log('    ' + JSON.stringify(second))
  check('第二次打开垫上了缓存', (second.restores || 0) === 1, `restores=${second.restores}`)
  check('垫出来的条目数与缓存一致', !!second.early && second.early.items === first.cached,
    JSON.stringify(second.early))
  check('垫出来的时候真扫描还没完（不是等扫描的结果）', !!second.early && second.early.busy === true,
    `busy=${second.early && second.early.busy}`)
  check('真扫描收尾后条目照常替换', second.items === first.items, `${second.items} 条`)

  console.log('\n=== 3. 清掉缓存再打开：不该再垫 ===')
  await cdp.evaluate(`return window.__bd2viewer.clearScanCache()`)
  await cdp.goto(URL0())
  await cdp.waitFor(`window.__bd2viewer`, 20000, '__bd2viewer 就绪')
  const third = await cdp.evaluate(`
    const v = window.__bd2viewer
    for (let i = 0; i < 600; i++) {
      if (!v.state.busy && (v.state.items || []).length > 0) break
      await new Promise(r => setTimeout(r, 100))
    }
    return { restores: v.scanCacheStats.restores, items: (v.state.items || []).length }
  `, 180000)
  console.log('    ' + JSON.stringify(third))
  check('清掉缓存后不再垫底', third.restores === 0, `restores=${third.restores}`)
  check('仍然正常扫出条目', third.items > 100, `${third.items} 条`)

  const cerr = await cdp.consoleErrors()
  check('页面无错误提示', !cerr, cerr || '')
} catch (err) {
  check('脚本执行', false, err.message + '\n' + (serverLog || '').slice(-1500))
} finally {
  try { await cdp.close() } catch { /* ignore */ }
  cleanup()
  try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* 沙箱不让删就留着 */ }
}

const fail = results.filter(r => !r.ok)
console.log(`\n=== 汇总: ${results.length - fail.length}/${results.length} 通过 ===`)
for (const f of fail) console.log('  FAIL', f.name, '—', f.detail)
process.exit(fail.length ? 1 : 0)
