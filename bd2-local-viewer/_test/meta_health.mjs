/**
 * 验证「管道自检」真的会报警（R26 的负面测试）。
 *
 * 手法：临时把 walk() 里的守卫改回**坏的裸字符串 startsWith**，同时把配置里的
 * root.path 写成正斜杠 —— 复现 2026-10-03 那次静默退化。此时 /api/scan 必须：
 *   ① metaHealth.ok === false
 *   ② metaHealth.code === 'meta-search-never-ran'
 *   ③ 服务端 stderr 打一行明确的 [scan] ⚠ 提示
 * 三样缺一，自检就是摆设。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SERVER = path.join(REPO, 'server.mjs')

// ---------- 造一份最小的「Ark 形态」素材：角色目录 + meta.json + runtime/ 三件套 ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-health-'))
const dataRoot = path.join(work, 'root')
const chDir = path.join(dataRoot, '角色', 'H001')
const rt = path.join(chDir, 'runtime')
fs.mkdirSync(rt, { recursive: true })
const ATLAS = 'H001.png\nsize: 1,1\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const body = Buffer.from('4.1.24\0', 'ascii')
const skel = Buffer.alloc(8 + 1 + body.length + 8, 0)
skel[8] = body.length
body.copy(skel, 9)
fs.writeFileSync(path.join(rt, 'H001.atlas'), ATLAS, 'utf-8')
fs.writeFileSync(path.join(rt, 'H001.png'), PNG)
fs.writeFileSync(path.join(rt, 'H001.skel'), skel)
fs.writeFileSync(path.join(chDir, 'meta.json'), JSON.stringify({
  character: { id: 'H001', name: '夏妮', rarity: 5, spineAssets: [{ bundle: 'H001', animations: ['idle'] }] },
}), 'utf-8')

// 现在有两层防护：① scanRoot 边界归一化 ② walk 里走 isInside。
// 要复现 2026-10-03 那次静默退化，得**两层一起回退** —— 只回退任一层都会被另一层兜住
// （这本身就是好事，说明防护是冗余的）。回退后 lookups=0，自检必须报警。
const BAD = [
  ['const rootPath = path.resolve(root.path)', 'const rootPath = root.path'],
  ['d && isInside(rootAbs, d) && up < 6', 'd && d.startsWith(rootPath) && up < 6'],
]
const GOOD_MARK = 'd && isInside(rootAbs, d) && up < 6'

// 变异版会落在仓库根（必须和 server.mjs 同级），跑完要**自己收走** ——
// 沙箱删不掉文件，所以统一 mv 进 _scratch/junk/（移动不被拦截）。
const MUTANTS = []

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
  ok ? pass++ : fail++
}

/** 起一个用「正斜杠 root.path」的服务端；serverSrc 允许传入被改坏的源码 */
async function withServer(serverSrc, fn) {
  // ⚠️ 变异版必须和 server.mjs **同级**（仓库根）：它用相对路径 import
  // （./jczx_support.mjs 等），放进 _scratch/ 会 ERR_MODULE_NOT_FOUND。
  const srcPath = path.join(REPO, `server-mut-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(srcPath, serverSrc, 'utf-8')
  MUTANTS.push(srcPath)
  const cfgPath = path.join(work, `cfg-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: 8231 + Math.floor(Math.random() * 300),
    maxDepth: 6,
    // ⚠️ 故意写正斜杠 —— 用户手填配置就是这种形式
    roots: [{ id: 'ark', label: '健康检查', path: dataRoot.split(path.sep).join('/') }],
  }, null, 2), 'utf-8')
  const p = spawn(process.execPath, [srcPath], {
    cwd: REPO, env: { ...process.env, BD2_CONFIG: cfgPath }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  p.stdout.on('data', d => { log += d })
  p.stderr.on('data', d => { log += d })
  const kill = () => { try { p.kill() } catch { /* ignore */ } }
  try {
    const m = await Promise.race([
      (async () => {
        for (let i = 0; i < 100; i++) {
          const mm = /地址：.*?(http:\/\/[\d.]+:\d+)/.exec(log)
          if (mm) return mm[1]
          await new Promise(r => setTimeout(r, 200))
        }
        return null
      })(),
    ])
    if (!m) throw new Error('服务没起来：' + log.slice(0, 400))
    // ⚠️ 日志在 fn 执行期间还会继续增长，所以传 **getter** 而不是快照字符串
    return await fn(m.replace(/\/$/, ''), () => log)
  } finally { kill() }
}

const scan = async base => (await fetch(`${base}/api/scan?root=ark&mode=ark&refresh=1`)).json()

const original = fs.readFileSync(SERVER, 'utf-8')
if (!original.includes(GOOD_MARK)) {
  console.log('FAIL  找不到待替换的守卫行（server.mjs 结构变了，本探针要同步更新）')
  process.exit(1)
}

try {
  /* ---------- ① 正常代码 + 正斜杠配置：必须健康 ---------- */
  await withServer(original, async (base) => {
    const j = await scan(base)
    const h = j.metaHealth
    check('正常代码：metaHealth 存在且 ok', !!(h && h.ok === true), JSON.stringify(h))
    check('正常代码：中文名读出来了',
      (j.items || []).some(i => i.ark && i.ark.charName === '夏妮'),
      (j.items || []).map(i => i.ark && i.ark.charName).join(','))
  })

  /* ---------- ② 两层防护一起回退 + 正斜杠配置：必须报警 ---------- */
  let broken = original
  for (const [from, to] of BAD) {
    if (!broken.includes(from)) { console.log(`FAIL  注入失败，找不到：${from}`); process.exit(1) }
    broken = broken.replace(from, to)
  }
  await withServer(broken, async (base, getLog) => {
    const j = await scan(base)
    const log = getLog()
    const h = j.metaHealth || {}
    check('坏代码：metaHealth.ok === false', h.ok === false, JSON.stringify(h))
    check('坏代码：code 指出「搜索一次都没执行」', h.code === 'meta-search-never-ran', String(h.code))
    check('坏代码：lookups 确实是 0（证明没去查 meta.json）', h.lookups === 0, String(h.lookups))
    check('坏代码：服务端 stderr 打了明确的 [scan] ⚠ 报警',
      /\[scan\]\s*⚠/.test(log), (log.match(/\[scan\].*/) || ['（无）'])[0])
    check('坏代码：报警里点明了要去查 rootPath 守卫',
      /rootPath/.test(log) && /守卫|startsWith|归一化/.test(log),
      (log.match(/\[scan\].*/) || ['（无）'])[0].slice(0, 160))
    check('坏代码：条目确实没有角色名（复现退化现象）',
      !(j.items || []).some(i => i.ark && i.ark.charName), String((j.items || []).length))
  })
} catch (e) {
  check('测试执行', false, e.stack || e.message)
} finally {
  const junk = path.join(REPO, '_scratch', 'junk')
  for (const f of MUTANTS) {
    try { fs.mkdirSync(junk, { recursive: true }); fs.renameSync(f, path.join(junk, path.basename(f))) } catch { /* ignore */ }
  }
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 失败 ' + fail}  （共 ${pass + fail} 项）`)
  process.exit(fail ? 1 : 0)
}
