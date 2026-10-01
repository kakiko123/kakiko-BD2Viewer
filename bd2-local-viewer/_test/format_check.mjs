/**
 * 资产命名约定（format）双模式自包含回归。
 *
 * 为什么单独一个套件：delete_api 只测删除，native_mode / e2e 都依赖用户的真实素材，
 * 而「认不认得出 Lost Sword 那套 .atlas.bytes / .skel.bytes / .bytes / thumb.png」
 * 恰恰是**纯逻辑**，可以用自造的小文件完整覆盖。所以这里自己造目录、自己起服务
 * （BD2_CONFIG 指向临时配置），不读 viewer.config.json，也不碰任何真实素材。
 *
 * 覆盖：
 *   · bd 模式只认标准导出，lostsword 模式只认 Unity TextAsset 导出，互不串味
 *   · 三级骨架级联的 ①精确 ②前缀 两个分支（③「目录里唯一候选」在 bd 用例里）
 *   · 自带 thumb.png → 落到 relThumb，且能按 PNG 取到
 *   · 传输 MIME：.atlas.bytes 必须当文本，.skel.bytes 当二进制
 *   · 扫描缓存按 (root, mode) 分离 —— 切模式不许拿到另一套结果
 *   · 删除整套资产时 thumb.png 也要一起删
 *   · problems 是简单键（不带文件名变量拼接）
 *   · nikke 模式（1.04）：服务端用 bd 那套命名认文件、有独立缓存键；
 *     「角色归组 + 姿势」在前端（R18），由 native_mode 用假桥数据覆盖
 *   · jczx 模式（1.05）：双 UnityFS AB → 提取缓存 → 按 bd 规则认 .atlas/.json/.png
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = path.join(root, '_scratch', 'format_test')
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const ATLAS_BODY = n => `${n}.png\nsize: 1,1\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n`

/** 一套标准 Spine 导出（bd） */
const writeBd = (dir, base) => {
  const full = path.join(dataRoot, dir)
  fs.mkdirSync(full, { recursive: true })
  fs.writeFileSync(path.join(full, `${base}.atlas`), ATLAS_BODY(base), 'utf-8')
  fs.writeFileSync(path.join(full, `${base}.json`), '{"skeleton":{"spine":"4.1.24"}}', 'utf-8')
  fs.writeFileSync(path.join(full, `${base}.png`), PNG)
}

/** 一套 Unity TextAsset 导出（lostsword）。skelName 传 null 就走裸 .bytes 的 JSON 骨架。 */

/** 造一份带版本串的假 .skel 头（8 字节 hash + 1 字节长度 + "4.x.y\0"），供世代过滤用 */
const skelHead = (ver) => {
  const body = Buffer.from(ver + '\0', 'ascii')
  const buf = Buffer.alloc(8 + 1 + body.length + 8, 0)
  buf[8] = body.length
  body.copy(buf, 9)
  return buf
}

/** NIKKE：标准命名 + 二进制 4.0 骨架（spineMinor 供运行时选用；不再按世代过滤列表） */
const writeNikke = (dir, base) => {
  const full = path.join(dataRoot, dir)
  fs.mkdirSync(full, { recursive: true })
  fs.writeFileSync(path.join(full, `${base}.atlas`), ATLAS_BODY(base), 'utf-8')
  fs.writeFileSync(path.join(full, `${base}.skel`), skelHead('4.0.47'))
  fs.writeFileSync(path.join(full, `${base}.png`), PNG)
}

const writeLs = (dir, base, skelName, withThumb) => {
  const full = path.join(dataRoot, dir)
  fs.mkdirSync(full, { recursive: true })
  fs.writeFileSync(path.join(full, `${base}.atlas.bytes`), ATLAS_BODY(base), 'utf-8')
  if (skelName) fs.writeFileSync(path.join(full, skelName), Buffer.alloc(64, 7))
  else fs.writeFileSync(path.join(full, `${base}.bytes`), '{"skeleton":{"spine":"4.1.24"}}', 'utf-8')
  fs.writeFileSync(path.join(full, `${base}.png`), PNG)
  if (withThumb) fs.writeFileSync(path.join(full, 'thumb.png'), PNG)
}

const exists = p => fs.existsSync(p)
const kill = child => new Promise(res => {
  if (!child || child.exitCode !== null) return res()
  child.once('exit', () => res())
  try { child.kill() } catch { res() }
})

let child = null
try {
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  writeBd('bdset', 'hero')
  writeLs('lsset', 'wolf', 'wolf.skel.bytes', true)
  // ② 前缀级联：atlas 基名比骨架基名长（真实数据里 skull_Soldier_Green 就是这样）
  writeLs('lsprefix', 'skull_Soldier_Green', 'skull_Soldier.skel.bytes', false)
  // 裸 .bytes = JSON 骨架
  writeLs('lsjson', 'beirin', null, false)

  const port = await freePort()
  fs.writeFileSync(cfgPath, JSON.stringify({
    host: '127.0.0.1', port, maxDepth: 4,
    roots: [{ id: 'tmp', label: '格式约定测试', path: dataRoot }],
  }, null, 2), 'utf-8')

  child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root,
    env: { ...process.env, BD2_CONFIG: cfgPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', () => { /* 端口探测日志 */ })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20000
  let up = false
  while (Date.now() < deadline && !up) {
    try { up = (await fetch(`${base}/api/health`)).ok } catch { await new Promise(r => setTimeout(r, 250)) }
  }
  check('临时服务起来了（BD2_CONFIG 隔离，不读 viewer.config.json）', up, base)
  if (!up) throw new Error('服务没起来')

  const scan = async (mode, refresh = false) =>
    (await fetch(`${base}/api/scan?root=tmp&mode=${mode}${refresh ? '&refresh=1' : ''}`)).json()
  const rels = s => (s.items || []).map(i => i.relAtlas).sort()

  /* ---------------------------------------------------- 两种模式互不串味 */
  const bd = await scan('bd', true)
  check('bd 模式只认标准导出（1 套）', bd.itemCount === 1 && rels(bd)[0] === 'bdset/hero.atlas',
    rels(bd).join(', '))
  check('bd 模式返回里的 mode 是 bd', bd.mode === 'bd', String(bd.mode))

  const ls = await scan('lostsword', true)
  check('lostsword 模式认全 3 套 Unity 导出',
    ls.itemCount === 3 && rels(ls).join(',') === 'lsjson/beirin.atlas.bytes,lsprefix/skull_Soldier_Green.atlas.bytes,lsset/wolf.atlas.bytes',
    rels(ls).join(', '))
  check('lostsword 模式全部可播放（骨架 + 图集页都配上了）',
    ls.playableCount === 3, `${ls.playableCount}/${ls.itemCount}`)
  check('lostsword 模式返回里的 mode 是 lostsword', ls.mode === 'lostsword', String(ls.mode))

  /* ---------------------------------------------------- 骨架配对级联 */
  const byRel = new Map(ls.items.map(i => [i.relAtlas, i]))
  check('① 精确同名：wolf.atlas.bytes ↔ wolf.skel.bytes',
    byRel.get('lsset/wolf.atlas.bytes').relSkeleton === 'lsset/wolf.skel.bytes',
    String(byRel.get('lsset/wolf.atlas.bytes').relSkeleton))
  check('② 前缀级联：skull_Soldier_Green 配到 skull_Soldier 的骨架',
    byRel.get('lsprefix/skull_Soldier_Green.atlas.bytes').relSkeleton === 'lsprefix/skull_Soldier.skel.bytes',
    String(byRel.get('lsprefix/skull_Soldier_Green.atlas.bytes').relSkeleton))
  const bj = byRel.get('lsjson/beirin.atlas.bytes')
  check('裸 .bytes 当作 JSON 骨架（skeletonKind=json）', bj.skeletonKind === 'json' && bj.ok,
    `${bj.skeletonKind} / ${bj.skeleton}`)

  /* ---------------------------------------------------- 自带缩略图 */
  const wolf = byRel.get('lsset/wolf.atlas.bytes')
  check('自带 thumb.png 落到 relThumb', wolf.relThumb === 'lsset/thumb.png', String(wolf.relThumb))
  check('没有 thumb.png 的资产 relThumb 为 null',
    byRel.get('lsjson/beirin.atlas.bytes').relThumb === null)
  const rt = await fetch(`${base}/spine/tmp/lsset/thumb.png`)
  const tb = Buffer.from(await rt.arrayBuffer())
  check('relThumb 能按 PNG 取到（前端直接当缩略图用）',
    rt.ok && tb[0] === 0x89 && tb[1] === 0x50 &&
    (rt.headers.get('content-type') || '').startsWith('image/png'),
    `HTTP ${rt.status} ${rt.headers.get('content-type')} ${tb.length}B`)

  /* ---------------------------------------------------- 传输 MIME */
  const mimeOf = async rel => (await fetch(`${base}/spine/tmp/${rel.split('/').map(encodeURIComponent).join('/')}`))
  const mAtlas = await mimeOf('lsset/wolf.atlas.bytes')
  const atlasText = await mAtlas.text()
  check('.atlas.bytes 当文本传（否则图集内容读不出来）',
    (mAtlas.headers.get('content-type') || '').startsWith('text/plain') && atlasText.includes('wolf.png'),
    `${mAtlas.headers.get('content-type')} | ${atlasText.slice(0, 9).replace(/\n/g, '\\n')}`)
  const mSkel = await mimeOf('lsset/wolf.skel.bytes')
  const skelLen = (await mSkel.arrayBuffer()).byteLength
  check('.skel.bytes 当二进制传（不能走文本通道）',
    !(mSkel.headers.get('content-type') || '').startsWith('text/plain') && skelLen === 64,
    `${mSkel.headers.get('content-type')} | ${skelLen}B`)
  const mJson = await mimeOf('lsjson/beirin.bytes')
  check('裸 .bytes 不作为文本（JSON 骨架由前端 fetch().text() 读，不走 MIME）',
    !(mJson.headers.get('content-type') || '').startsWith('text/plain'),
    String(mJson.headers.get('content-type')))

  /* ---------------------------------------------------- 缓存按 (root, mode) 分离 */
  const bdAgain = await scan('bd')      // 不带 refresh → 走缓存
  const lsAgain = await scan('lostsword')
  check('切回去拿到的是各自缓存的结论（bd 仍 1 套）', bdAgain.itemCount === 1, `itemCount=${bdAgain.itemCount}`)
  check('切回去拿到的是各自缓存的结论（lostsword 仍 3 套）', lsAgain.itemCount === 3, `itemCount=${lsAgain.itemCount}`)

  /* ---------------------------------------------------- problems 是简单键 */
  const probs = new Set()
  for (const it of [...bd.items, ...ls.items]) for (const p of (it.problems || [])) probs.add(p)
  check('problems 是简单键，没有把文件名拼进去',
    ![...probs].some(p => /[\\/]|\.png|\.atlas/.test(p)),
    [...probs].join(' / ') || '（本轮无 problems）')

  /* ---------------------------------------------------- 删除整套（含 thumb.png） */
  const del = await (await fetch(`${base}/api/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootId: 'tmp', items: [wolf] }),
  })).json()
  check('删除整套 Unity 导出成功', del.deleted.length === 1 && del.failed.length === 0, JSON.stringify(del.failed))
  check('atlas.bytes / skel.bytes / 贴图 / thumb.png 四个文件全没了',
    !exists(path.join(dataRoot, 'lsset', 'wolf.atlas.bytes')) &&
    !exists(path.join(dataRoot, 'lsset', 'wolf.skel.bytes')) &&
    !exists(path.join(dataRoot, 'lsset', 'wolf.png')) &&
    !exists(path.join(dataRoot, 'lsset', 'thumb.png')))
  check('空目录被顺手清掉', !exists(path.join(dataRoot, 'lsset')))
  check('没被点名的资产一个字节都没动',
    exists(path.join(dataRoot, 'bdset', 'hero.atlas')) &&
    exists(path.join(dataRoot, 'lsprefix', 'skull_Soldier.skel.bytes')))

  const after = await scan('lostsword')   // 不带 refresh，验缓存失效
  check('删除后重扫不会「诈尸」（两种模式的扫描缓存都已失效）',
    after.itemCount === 2 && !after.items.some(i => i.relAtlas.startsWith('lsset/')),
    `剩余 ${after.itemCount} 套`)
  const bdAfter = await scan('bd')
  check('另一种模式的缓存也被清掉，bd 结果照旧正确', bdAfter.itemCount === 1, `itemCount=${bdAfter.itemCount}`)

  /* ---------------------------------------------------- NIKKE 模式（1.04 起，放最后：会写入新文件）
   * 服务端只负责「认文件」（规则与 bd 相同）+ 独立缓存键；
   * 「一个角色归成一套（本体 + aim/cover 姿势）」发生在前端（R18），由 native_mode
   * 用假桥数据覆盖。这里验证：原始条目三套都被完整扫出、骨架都配上 —— 那是分组的前提。 */
  writeNikke('nk', 'char_00')
  writeNikke('nk/aim', 'char_aim_00')
  writeNikke('nk/cover', 'char_cover_00')
  const nk = await scan('nikke', true)
  // 产品不再按骨架世代隔离：同根下 bd 命名的 hero 也会出现在 nikke 扫结果里
  check('nikke 模式认标准命名（hero + char 三件套 = 4；姿势归组是前端的事）',
    nk.itemCount === 4 &&
    rels(nk).join(',') === 'bdset/hero.atlas,nk/aim/char_aim_00.atlas,nk/char_00.atlas,nk/cover/char_cover_00.atlas',
    rels(nk).join(', '))
  check('nikke 写入的 .skel 带 spineMinor=4.0（供运行时选用）',
    (nk.items || []).filter(i => String(i.relAtlas || '').startsWith('nk/')).every(i => i.spineMinor === '4.0'),
    JSON.stringify((nk.items || []).map(i => [i.relAtlas, i.spineMinor])))
  check('nikke 模式返回里的 mode 是 nikke', nk.mode === 'nikke', String(nk.mode))
  check('nikke 模式骨架都配上（全部可播放）', nk.playableCount === 4,
    `${nk.playableCount}/${nk.itemCount}`)
  const bdCached = await scan('bd')
  check('bd 的缓存没被 nikke 动过（不带 refresh 仍是 1 套）', bdCached.itemCount === 1, `itemCount=${bdCached.itemCount}`)
  const bdWithNk = await scan('bd', true)
  check('bd 强刷同样认标准命名（含刚写入的 nikke 三件套；不靠世代挡）',
    bdWithNk.itemCount === 4 && rels(bdWithNk).includes('bdset/hero.atlas') &&
    rels(bdWithNk).includes('nk/char_00.atlas'),
    rels(bdWithNk).join(', '))
  const nkAgain = await scan('nikke')
  check('nikke 有独立的缓存键（不带 refresh 再扫结果一致）',
    nkAgain.itemCount === 4 && nkAgain.mode === 'nikke', `itemCount=${nkAgain.itemCount}`)

  /* ---------------------------------------------------- JCZX 模式（1.05 Phase A）
   * 真实样例 AB（双 UnityFS）→ MIT strip + UnityPy → `bd2viewer-jczx/` 下标准三件套。
   * 样例路径可通过 BD2_JCZX_SAMPLE 指定；缺失则整段跳过（不红）。 */
  {
    const sample = process.env.BD2_JCZX_SAMPLE
      || '/workspace/_scratch_jczx/prefabs_spine_30490_skin_mareerouge04_spine'
    if (!fs.existsSync(sample)) {
      check('jczx 样例缺失时跳过（不红）', true, `missing ${sample}`)
    } else {
      const jdir = path.join(dataRoot, 'jczx_in')
      fs.mkdirSync(jdir, { recursive: true })
      const dest = path.join(jdir, 'prefabs_spine_30490_skin_mareerouge04_spine')
      fs.copyFileSync(sample, dest)
      const jz = await scan('jczx', true)
      check('jczx 模式返回 mode=jczx', jz.mode === 'jczx', String(jz.mode))
      check('jczx 抽出至少 1 套可播放资产', jz.playableCount >= 1,
        `playable=${jz.playableCount} items=${jz.itemCount} meta=${JSON.stringify(jz.jczx || {}).slice(0, 200)}`)
      const one = (jz.items || []).find(i => i.ok)
      check('jczx 条目落在 bd2viewer-jczx 缓存下',
        !!(one && /(?:^|\/)\.?bd2viewer-jczx\//.test(String(one.relAtlas || ''))),
        one && one.relAtlas)
      check('jczx JSON 骨架标 spineMinor=4.2',
        !!(one && one.skeletonKind === 'json' && one.spineMinor === '4.2'),
        one && `${one.skeletonKind}/${one.spineMinor}`)
      const bdNoJ = await scan('bd', true)
      check('bd 模式扫不到 jczx 缓存（不串味）',
        !(bdNoJ.items || []).some(i => /(?:^|\/)\.?bd2viewer-jczx\//.test(String(i.relAtlas || ''))),
        rels(bdNoJ).join(', '))
    }
  }
} catch (e) {
  check('测试执行', false, e.stack || e.message)
} finally {
  await kill(child)
  try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* 沙箱不让删就留在 _scratch */ }
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 失败 ' + fail}  （共 ${pass + fail} 项）`)
  process.exit(fail ? 1 : 0)
}
