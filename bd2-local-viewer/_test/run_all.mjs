/**
 * 一条命令跑完所有测试套件。
 *
 *   node _test/run_all.mjs
 *   node _test/run_all.mjs --keep        # 跑完不关自己起的服务
 *   node _test/run_all.mjs bundle_check  # 只跑指定套件（名字可以写前缀）
 *
 * 为什么要它：这些套件各自需要「某个端口上有服务」这个前置条件，
 * 手工起服务很容易起错端口或忘了起，于是得到一堆莫名其妙的超时。
 * 这里统一负责：起服务 → 顺序跑 → 关服务 → 汇总。
 *
 * 依赖：Node 18+（全局 fetch）。跑 native_mode 那类需要 Node 22+（全局 WebSocket）。
 *
 * ⚠ 关于数据依赖：native_mode / e2e / bundle_firstpaint 会去读**你本机的真实资产**
 *   （viewer.config.json 里 id 为 bd2-mods 的那个 root）。
 *   没有这份数据的话它们会失败 —— 这是设计如此，它们测的就是真实解码链路。
 *   自包含、不需要任何真实数据的套件：manifest_check / delete_api / format_check。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import net from 'node:net'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VIEWER = path.resolve(HERE, '..')
const CONFIG = path.join(VIEWER, 'viewer.config.json')

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const filters = argv.filter(a => !a.startsWith('--'))

/** 顺序有讲究：静态/快的放前面，出问题时先看到便宜的那条。 */
const SUITES = [
  { name: 'manifest_check',    file: 'manifest_check.mjs',    needs: null,        data: false, desc: '清单：旋转/fullUser、configChanges、minSdk' },
  { name: 'bundle_check',      file: 'bundle_check.mjs',      needs: '8137',      data: true,  desc: '单文件产物：id 一致性、内联、遮罩、无外链' },
  { name: 'bundle_firstpaint', file: 'bundle_firstpaint.mjs', needs: '8137',      data: true,  desc: '产物级首屏：第一帧就是资产页、深链可用' },
  { name: 'delete_api',        file: 'delete_api.mjs',        needs: null,        data: false, desc: '真删磁盘 + 路径越界拒绝（自带临时根目录）' },
  { name: 'format_check',      file: 'format_check.mjs',      needs: null,        data: false, desc: '命名约定双模式：bd / lostsword 互不串味、thumb、MIME、缓存分离（自带临时根目录）' },
  { name: 'e2e',               file: 'e2e.mjs',               needs: '8137',      data: true,  desc: '端到端：加载/相机/图层/截图/导出' },
  { name: 'native_mode',       file: 'native_mode.mjs',       needs: '8143',      data: true,  desc: '假桥原生通路：拖动/长按/批删/箭头/返回键/首屏' },
  // 自带服务端（BD2_CONFIG 指临时配置），不占 8137/8143 —— 但要用 Chrome，
  // 所以**必须排在 native_mode 之后**，别和它抢 cdp 的 9333 端口。
  { name: 'ark_mode',          file: 'ark_mode.mjs',          needs: null,        data: true,  desc: 'Ark 星陨计划档：中文名/多形态归组/立绘/语音（需 BD2_ARK_ROOT，否则跳过）' },
]

/** 服务端口 → 启动参数 */
const SERVERS = {
  8137: [],
  8143: ['--port=8143'],
}

function portBusy(port) {
  return new Promise(resolve => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    s.setTimeout(1500, () => { s.destroy(); resolve(false) })
  })
}

function run(file) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(HERE, file)], { cwd: VIEWER, stdio: 'inherit' })
    p.on('exit', code => resolve(code ?? 1))
    p.on('error', () => resolve(1))
  })
}

/* ---------------------------------------------------------------- 前置检查 */

const major = Number(process.versions.node.split('.')[0])
if (major < 18) {
  console.error(`✕ Node 版本过低：${process.versions.node}，需要 18+（建议 22+）`)
  process.exit(1)
}
if (major < 22) {
  console.log(`⚠ Node ${process.versions.node}：WebSocket 在 22 之前不是全局的，native_mode 可能跑不起来。`)
}

const hasConfig = fs.existsSync(CONFIG)
if (!hasConfig) {
  console.log('⚠ 没有找到 bd2-local-viewer/viewer.config.json')
  console.log('  照 viewer.config.example.json 建一份，否则需要真实数据的套件会失败。')
}

/* ---------------------------------------------------------------- 起服务 */

const started = []
for (const [portStr, args] of Object.entries(SERVERS)) {
  const port = Number(portStr)
  if (await portBusy(port)) {
    console.log(`· 端口 ${port} 已有服务，直接用（不会由本脚本关闭）`)
    continue
  }
  const p = spawn(process.execPath, [path.join(VIEWER, 'server.mjs'), ...args], {
    cwd: VIEWER, stdio: ['ignore', 'ignore', 'ignore'], detached: false,
  })
  started.push({ port, proc: p })

  // 轮询就绪，别用固定 sleep
  const deadline = Date.now() + 15000
  let up = false
  while (Date.now() < deadline) {
    if (await portBusy(port)) { up = true; break }
    await new Promise(r => setTimeout(r, 200))
  }
  if (up) console.log(`· 已启动本地服务 :${port}`)
  else { console.error(`✕ 服务 :${port} 起不来`); p.kill() }
}

function shutdown() {
  if (keep) return
  for (const { proc } of started) {
    try { proc.kill() } catch { /* ignore */ }
  }
}
process.on('exit', shutdown)
process.on('SIGINT', () => { shutdown(); process.exit(130) })

/* ---------------------------------------------------------------- 跑套件 */

const picked = filters.length
  ? SUITES.filter(s => filters.some(f => s.name.startsWith(f) || s.file.startsWith(f)))
  : SUITES

if (!picked.length) {
  console.error('✕ 没有匹配的套件。可选：' + SUITES.map(s => s.name).join(' / '))
  shutdown()
  process.exit(1)
}

const results = []
for (const s of picked) {
  if (s.needs && !(await portBusy(Number(s.needs)))) {
    console.log(`\n${'='.repeat(64)}\nSKIP  ${s.name}（端口 ${s.needs} 上没有服务）\n${'='.repeat(64)}`)
    results.push([s.name, 'SKIP'])
    continue
  }
  console.log(`\n${'='.repeat(64)}\n▶ ${s.name} — ${s.desc}\n${'='.repeat(64)}`)
  const t0 = Date.now()
  const code = await run(s.file)
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  results.push([s.name, code === 0 ? 'PASS' : 'FAIL', secs])
}

/* ---------------------------------------------------------------- 汇总 */

console.log(`\n${'='.repeat(64)}\n汇总\n${'='.repeat(64)}`)
for (const [name, state, secs] of results) {
  const mark = state === 'PASS' ? '✓' : state === 'SKIP' ? '·' : '✕'
  console.log(`  ${mark} ${name.padEnd(20)} ${state}${secs ? '  ' + secs + 's' : ''}`)
}
const failed = results.filter(r => r[1] === 'FAIL').length
console.log(`\n${failed ? `❌ ${failed} 个套件失败` : '✅ 已选套件全部通过'}`)

shutdown()
process.exit(failed ? 1 : 0)
