/**
 * 验证「真删磁盘文件」那条路（桌面端 = server.mjs 的 POST /api/delete）。
 *
 * 为什么不放在 native_mode.mjs 里：那是浏览器测试，跑在用户的真实 mods 目录上，
 * 一个不小心就把人家的素材删了。这里**自己造一个临时根目录**（_scratch 下），
 * 并且用 BD2_CONFIG 让被测服务只认这个临时配置，跟 viewer.config.json 完全隔离。
 *
 * 断言：
 *   · 整卡删除 = atlas + skeleton + 贴图一起删，目录空了要顺手清掉
 *   · 没被点名的资产一个字节都不能动
 *   · ../ 越界的相对路径必须被拒（isAuthorized）
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = path.join(root, '_scratch', 'delete_api_test')
const dataRoot = path.join(work, 'root')
const cfgPath = path.join(work, 'viewer.config.json')

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
  ok ? pass++ : fail++
}

const freePort = () => new Promise(resolve => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})

const writeAsset = (dir, base) => {
  const full = path.join(dataRoot, dir)
  fs.mkdirSync(full, { recursive: true })
  fs.writeFileSync(path.join(full, `${base}.atlas`), `${base}.png\nsize: 1,1\n`, 'utf-8')
  fs.writeFileSync(path.join(full, `${base}.json`), '{"skeleton":{}}', 'utf-8')
  fs.writeFileSync(path.join(full, `${base}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
}

const exists = p => fs.existsSync(p)
const kill = child => new Promise(res => {
  if (!child || child.exitCode !== null) return res()
  child.once('exit', () => res())
  try { child.kill() } catch { res() }
})

let child = null
try {
  // 干净的临时现场
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  writeAsset('assetA', 'alpha')
  writeAsset('assetB', 'beta')
  writeAsset('sub/assetC', 'gamma')
  fs.writeFileSync(cfgPath, JSON.stringify({
    host: '127.0.0.1', port: 1, maxDepth: 4,
    roots: [{ id: 'tmp', label: '临时测试根目录', path: dataRoot }],
  }, null, 2), 'utf-8')

  const port = await freePort()
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
  cfg.port = port
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8')

  child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root,
    env: { ...process.env, BD2_CONFIG: cfgPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', () => { /* 端口探测日志，忽略 */ })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20000
  let up = false
  while (Date.now() < deadline && !up) {
    try {
      const r = await fetch(`${base}/api/health`)
      up = r.ok
    } catch { await new Promise(r => setTimeout(r, 250)) }
  }
  check('临时服务用 BD2_CONFIG 起来了（不读用户的 viewer.config.json）', up, base)
  if (!up) throw new Error('服务没起来')

  const scan = await (await fetch(`${base}/api/scan?root=tmp&refresh=1`)).json()
  const byId = new Map((scan.items || []).map(i => [i.relAtlas, i]))
  check('临时根目录扫出 3 套资产（含子目录）',
    scan.items.length === 3 && byId.has('assetA/alpha.atlas') &&
    byId.has('sub/assetC/gamma.atlas'),
    (scan.items || []).map(i => i.relAtlas).join(', '))

  const post = (body) => fetch(`${base}/api/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json())

  // ① 越界路径必须被拒
  const evil = await post({ rootId: 'tmp', items: [{ relAtlas: '../../evil.atlas', relImages: [] }] })
  check('越界的相对路径被拒绝（不会删到根目录之外）',
    evil.failed.length === 1 && /越界/.test(evil.failed[0].reason) && evil.deleted.length === 0,
    JSON.stringify(evil.failed))
  check('越界尝试没有在根目录外造/删任何文件',
    !exists(path.join(work, 'evil.atlas')) && !exists(path.join(root, '_scratch', 'evil.atlas')))

  // ② 整卡删除
  const itemA = byId.get('assetA/alpha.atlas')
  const res1 = await post({ rootId: 'tmp', items: [itemA] })
  check('删一套资产：atlas + skeleton + 贴图一起删', res1.deleted.length === 1 && res1.failed.length === 0,
    JSON.stringify(res1))
  check('磁盘上三个文件都没了', !exists(path.join(dataRoot, 'assetA', 'alpha.atlas')) &&
    !exists(path.join(dataRoot, 'assetA', 'alpha.json')) &&
    !exists(path.join(dataRoot, 'assetA', 'alpha.png')))
  check('空目录被顺手清掉', !exists(path.join(dataRoot, 'assetA')), `removedDirs=${JSON.stringify(res1.removedDirs)}`)
  check('没被点名的资产一个字节都没动',
    exists(path.join(dataRoot, 'assetB', 'beta.atlas')) &&
    exists(path.join(dataRoot, 'assetB', 'beta.png')) &&
    exists(path.join(dataRoot, 'sub', 'assetC', 'gamma.png')))

  // ②b 扫描缓存必须失效：服务端 /api/scan 会把结果缓存起来，删完不清缓存的话
  // 下一次「不强制刷新」的扫描会把刚删掉的资产列回来，看着像删除没生效。
  const noForce = await (await fetch(`${base}/api/scan?root=tmp`)).json()
  check('删除后不带 refresh 重扫也不会「诈尸」（扫描缓存已失效）',
    (noForce.items || []).length === 2 &&
    !(noForce.items || []).some(i => i.relAtlas === 'assetA/alpha.atlas'),
    `剩余 ${(noForce.items || []).length} 套`)

  // ③ 批量删除（其中一套在子目录里 → 子目录也要清掉），并且再扫一次确认它真的不在了
  const res2 = await post({ rootId: 'tmp', items: [byId.get('assetB/beta.atlas'), byId.get('sub/assetC/gamma.atlas')] })
  check('批量删除两套资产都成功', res2.deleted.length === 2 && res2.failed.length === 0, JSON.stringify(res2))
  check('子目录里的空目录也被清掉', !exists(path.join(dataRoot, 'sub')))

  const rescan = await (await fetch(`${base}/api/scan?root=tmp&refresh=1`)).json()
  check('重新扫描：目录已空（删除结果真的落到磁盘上）', (rescan.items || []).length === 0,
    `剩余 ${(rescan.items || []).length} 套`)
} catch (e) {
  check('测试执行', false, e.message)
} finally {
  await kill(child)
  try {
    fs.rmSync(work, { recursive: true, force: true })
  } catch { /* 沙箱可能不让删，留在 _scratch 里也无所谓 */ }
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 失败 ' + fail}  （共 ${pass + fail} 项）`)
  process.exit(fail ? 1 : 0)
}
