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

  /* ------------------------------------------------ Lost Sword 两层角色（R19）
   * 服务端**不做**归组：`<X>_B` 与 `<X>_F` 照旧是两个独立资产（各配各的骨架）。
   * 「同一目录 + 同名 + _B/_F → 一套资产、叠着渲染」是前端可见口径的事（R19）。
   * 这一条守住「扫描层里不含分组语义」—— 别哪天有人把分组挪进服务端。 */
  writeLs('layer', 'Hero_B', 'Hero_B.skel.bytes', false)
  writeLs('layer', 'Hero_F', 'Hero_F.skel.bytes', false)
  const ly = await scan('lostsword', true)
  const lyItems = (ly.items || []).filter(i => i.relAtlas.indexOf('layer/') === 0)
  check('两层角色：服务端照旧返回两个独立条目（归组是前端的事）',
    lyItems.length === 2 &&
    lyItems.map(i => i.relAtlas).sort().join(',') === 'layer/Hero_B.atlas.bytes,layer/Hero_F.atlas.bytes',
    lyItems.map(i => i.relAtlas).join(', '))
  check('两层角色：两层的骨架都各自配上了（前端才叠得起来）',
    lyItems.every(i => i.ok && !!i.relSkeleton && i.relSkeleton.indexOf('layer/') === 0),
    lyItems.map(i => i.base + '→' + String(i.relSkeleton || '无').split('/').pop()).join(' , '))

  /* ------------------------------------------------ NIKKE 解包缓存（bd2viewer-nikke/）
   * NIKKE 的 mod 包（UnityFS）在扫描前会被解到根目录下的 `bd2viewer-nikke/`。
   * 这张缓存**只在 nikke 档可见**：否则 BD2 档会把抽出来的资产再摆一遍。
   * 这里造一份「解包产物」，验两边的可见性（解包本身要 UnityPy + 真包，
   * 由 _tools/nikke_extract.py 与 e2e 的真实素材用例覆盖）。 */
  writeBd('bd2viewer-nikke/mods', 'char_00')
  // 解包产物实为二进制 4.1（RELEASE 1.07）；用带毒 hash 的头验证「按布局读版本」不被误导成 4.0
  {
    const pack = path.join(dataRoot, 'bd2viewer-nikke', 'c010_00_pack')
    fs.mkdirSync(pack, { recursive: true })
    fs.writeFileSync(path.join(pack, 'c010_00.atlas'), ATLAS_BODY('c010_00'), 'utf-8')
    const body = Buffer.from('4.1.24\0', 'ascii')
    const skel = Buffer.alloc(8 + 1 + body.length + 8, 0)
    Buffer.from('4.0.99').copy(skel, 0)  // 毒 hash：旧全头正则会判 4.0
    skel[8] = body.length
    body.copy(skel, 9)
    fs.writeFileSync(path.join(pack, 'c010_00.skel'), skel)
    fs.writeFileSync(path.join(pack, 'c010_00.png'), PNG)
  }
  const nkCacheBd = await scan('bd', true)
  check('NIKKE 解包缓存在 BD2 档里不出现（不串味）',
    !(nkCacheBd.items || []).some(i => String(i.relAtlas || '').indexOf('bd2viewer-nikke/') >= 0),
    rels(nkCacheBd).join(', '))
  const nkCacheNk = await scan('nikke', true)
  check('NIKKE 解包缓存在 nikke 档里正常可见（能直接播）',
    nkCacheNk.playableCount > 0 &&
    (nkCacheNk.items || []).some(i => i.relAtlas === 'bd2viewer-nikke/mods/char_00.atlas' && i.ok),
    (nkCacheNk.items || []).filter(i => i.relAtlas.indexOf('bd2viewer-nikke/') >= 0)
      .map(i => i.relAtlas).join(', '))
  const nkSkel41 = (nkCacheNk.items || []).find(i => i.relAtlas === 'bd2viewer-nikke/c010_00_pack/c010_00.atlas')
  check('NIKKE 解包 .skel（毒 hash）仍标 spineMinor=4.1（不误判 4.0）',
    !!(nkSkel41 && nkSkel41.skeletonKind === 'skel' && nkSkel41.spineMinor === '4.1'),
    nkSkel41 && `${nkSkel41.skeletonKind}/${nkSkel41.spineMinor}`)

  /* ------------------------------------------------ Ark 模式（星陨计划 Ark Re:Code）
   * 素材布局（实测 596 套骨架）：
   *   `角色/H001/`            meta.json + runtime/{H001,H001_S,CG_H001_a}.{atlas,skel,png}
   *                            + runtime/static/*.png（立绘/图标）+ runtime/voice/*.wav
   *   `画册/A0001/`           同上但 meta.json **没有 character 字段**（381 个全是）
   *
   * 服务端只负责「读 meta.json → 挂 ark 元数据 + 标形态」；归组/形态切换在前端（R18 同款）。
   * 这一段守的是 meta 解析的三条硬规则：
   *   ① 立绘/语音**只挂一次**（每个角色有多个 bundle，挂到每个上会翻倍 —— 实测踩过 1907 vs 1000）
   *   ② 占位名「未命名（Bxxx）」当成没有名字（别把占位符显示给用户）
   *   ③ 形态标记：bundle 名 == charId 才是本体（isDefaultForm）
   */
  {
    const chDir = path.join(dataRoot, '角色', 'H001')
    const rt = path.join(chDir, 'runtime')
    fs.mkdirSync(path.join(rt, 'static'), { recursive: true })
    fs.mkdirSync(path.join(rt, 'voice'), { recursive: true })
    for (const b of ['H001', 'H001_S', 'CG_H001_a']) {
      fs.writeFileSync(path.join(rt, `${b}.atlas`), ATLAS_BODY(b), 'utf-8')
      fs.writeFileSync(path.join(rt, `${b}.png`), PNG)
      const body = Buffer.from('4.1.24\0', 'ascii')
      const skel = Buffer.alloc(8 + 1 + body.length + 8, 0)
      skel[8] = body.length
      body.copy(skel, 9)
      fs.writeFileSync(path.join(rt, `${b}.skel`), skel)
    }
    fs.writeFileSync(path.join(rt, 'static', 'H001_Sex_LoveTalk.png'), PNG)
    fs.writeFileSync(path.join(rt, 'static', 'H001_Icon.png'), PNG)
    fs.writeFileSync(path.join(rt, 'voice', 'H001_Death_x.wav'), Buffer.from('RIFF----WAVEfmt '))
    fs.writeFileSync(path.join(chDir, 'meta.json'), JSON.stringify({
      character: {
        id: 'H001', name: '夏妮', rarity: 5,
        // ⚠️ 字段都在 character 里面（实测 596 套都这样），file 带 `runtime/` 前缀。
        staticAssets: [
          { file: 'runtime/static/H001_Sex_LoveTalk.png', kind: 'full', label: 'H001 Sex LoveTalk', width: 337, height: 169 },
          { file: 'runtime/static/H001_Icon.png', kind: 'icon' },
        ],
        spineAssets: [
          { bundle: 'H001', skeletonJson: { spineVersion: '4.1.23' }, animations: ['idle'] },
          { bundle: 'H001_S', skeletonJson: { spineVersion: '4.1.23' }, animations: ['idle'] },
          { bundle: 'CG_H001_a', skeletonJson: { spineVersion: '4.1.23' }, animations: ['idle', 'talk'] },
        ],
      },
    }), 'utf-8')
    // 画册：没有 character 字段 —— 必须优雅退化，不能抛
    const alDir = path.join(dataRoot, '画册', 'A0001')
    const alRt = path.join(alDir, 'runtime')
    fs.mkdirSync(alRt, { recursive: true })
    fs.writeFileSync(path.join(alRt, 'A0001.atlas'), ATLAS_BODY('A0001'), 'utf-8')
    fs.writeFileSync(path.join(alRt, 'A0001.png'), PNG)
    fs.writeFileSync(path.join(alDir, 'meta.json'), JSON.stringify({ generatedAt: 'x' }), 'utf-8')
    // 占位名：name 是「未命名（B001）」这种模板 → 当成没有名字
    const phDir = path.join(dataRoot, '角色', 'B001')
    const phRt = path.join(phDir, 'runtime')
    fs.mkdirSync(phRt, { recursive: true })
    fs.writeFileSync(path.join(phRt, 'B001.atlas'), ATLAS_BODY('B001'), 'utf-8')
    fs.writeFileSync(path.join(phRt, 'B001.png'), PNG)
    fs.writeFileSync(path.join(phDir, 'meta.json'), JSON.stringify({
      character: { id: 'B001', name: '未命名（B001）', rarity: 3 },
    }), 'utf-8')

    const ak = await scan('ark', true)
    check('ark 模式返回 mode=ark', ak.mode === 'ark', String(ak.mode))
    const akItems = (ak.items || []).filter(i => i.ark)
    // 这个临时根里同时躺着 bdset/ nk/ 等**别的档**的目录（在 ark 规则下也认，
    // 因为 ark 复用 bd 的命名规则），它们本来就没有 meta.json → ark 为 null。
    // 所以只要求「认得出的角色目录都挂了 ark」，别要求全部。
    const charItems = (ak.items || []).filter(i => /^(角色|画册)\//.test(String(i.relAtlas || '')))
    check('ark：角色/画册目录下的条目都挂上 ark 元数据（含无 character 的画册）',
      charItems.length === 5 && charItems.every(i => i.ark),
      `${charItems.filter(i => i.ark).length}/${charItems.length} · ${charItems.map(i => i.relAtlas).join(', ')}`)

    const h1 = akItems.find(i => i.ark.charId === 'H001' && i.ark.formBundle === 'H001')
    check('ark：读出中文名 + 稀有度', !!(h1 && h1.ark.charName === '夏妮' && h1.ark.rarity === 5),
      h1 && `${h1.ark.charName}/${h1.ark.rarity}`)
    check('ark：本体形态标出来了（bundle 名 == charId）', !!(h1 && h1.ark.isDefaultForm === true),
      h1 && `isDefaultForm=${h1.ark.isDefaultForm}`)
    const h1s = akItems.find(i => i.ark.charId === 'H001' && i.ark.formBundle === 'H001_S')
    check('ark：非本体形态不算 default（战斗形态 / CG 骨骼）',
      !!(h1s && h1s.ark.isDefaultForm === false && h1s.ark.formLabel && h1s.ark.formLabel !== h1s.ark.formBundle),
      h1s && `${h1s.ark.formBundle}→${h1s.ark.formLabel}`)

    // ① 立绘/语音只挂一次
    const carriers = akItems.filter(i => i.ark.isCarrier)
    const staticsTotal = carriers.reduce((a, i) => a + i.ark.statics.length, 0)
    const voicesTotal = carriers.reduce((a, i) => a + i.ark.voices.length, 0)
    check('ark：立绘不按 bundle 重复计数（3 个形态也只有一份）', staticsTotal === 2,
      `statics=${staticsTotal}（期望 2）`)
    check('ark：语音不按 bundle 重复计数', voicesTotal === 1,
      `voices=${voicesTotal}（期望 1）`)
    check('ark：立绘只挂在「承载条目」上（每个角色目录恰好一个 isCarrier）',
      carriers.length === 3,
      carriers.map(i => i.ark.charId).join(','))

    // ② 占位名
    const ph = akItems.find(i => i.ark.charId === 'B001')
    check('ark：占位名「未命名（B001）」当成没有名字（前端会退回 id）',
      !!(ph && ph.ark.charName == null && ph.ark.rarity === 3),
      ph && `charName=${JSON.stringify(ph.ark.charName)} rarity=${ph.ark.rarity}`)
    // ③ 画册没有 character
    const al = akItems.find(i => i.ark.charId === 'A0001')
    check('ark：画册条目（meta 无 character）不崩、名字退回 null',
      !!al && al.ark.charName == null && al.ark.statics.length === 0,
      al && `charName=${JSON.stringify(al.ark.charName)}`)

    // 语音 MIME：不补 .wav 的话 <audio> 拿到 octet-stream 就不播
    const wavUrl = '/spine/tmp/' +
      String('角色/H001/runtime/voice/H001_Death_x.wav').split('/').map(encodeURIComponent).join('/')
    const wavRes = await fetch(`${base}${wavUrl}`)
    check('ark：.wav 按 audio/wav 发（<audio> 才认）',
      wavRes.status === 200 && /audio\//.test(wavRes.headers.get('content-type') || ''),
      `${wavRes.status} ${wavRes.headers.get('content-type')}`)

    // 切档隔离
    const bdNoArk = await scan('bd', true)
    check('ark 资产在 bd 档里也认（同名规则），但 ark 元数据不串味',
      !(bdNoArk.items || []).some(i => i.ark && i.ark.charId === 'H001'),
      rels(bdNoArk).filter(r => r.indexOf('角色/') === 0).join(', '))
  }

  /* ---------------------------------------------------- 根目录斜杠形式（回归） */
  // 用户手填 / 前端 POST 进来的 root.path **不保证是反斜杠**。配置写成正斜杠时，
  // walk() 里那句 `d.startsWith(rootPath)` 的守卫第一轮就 false（`path.join` 出来
  // 一律是 `C:\…`）→ 向上搜索 meta.json 整条短路 → 角色名/稀有度/立绘/语音全丢，
  // 而且**一条错都不报**（实测 499/499 条连 ark 对象都没有，界面只显示目录 id）。
  // 本机 viewer.config.json 恰好是反斜杠才一直没暴露 —— 这里故意用正斜杠钉住。
  // ⚠️ `path.relative` 内部自带 resolve 所以容错，唯独裸字符串 startsWith 不容错。
  {
    const port2 = await freePort()
    const cfg2 = path.join(work, 'viewer.slash.config.json')
    const slashRoot = dataRoot.split(path.sep).join('/')
    fs.writeFileSync(cfg2, JSON.stringify({
      host: '127.0.0.1', port: port2, maxDepth: 4,
      roots: [{ id: 'tmp', label: '正斜杠配置', path: slashRoot }],
    }, null, 2), 'utf-8')
    const child2 = spawn(process.execPath, [path.join(root, 'server.mjs')], {
      cwd: root,
      env: { ...process.env, BD2_CONFIG: cfg2 },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child2.stderr.on('data', () => { /* 端口探测日志 */ })
    const base2 = `http://127.0.0.1:${port2}`
    const dl2 = Date.now() + 20000
    let up2 = false
    while (Date.now() < dl2 && !up2) {
      try { up2 = (await fetch(`${base2}/api/health`)).ok } catch { await new Promise(r => setTimeout(r, 250)) }
    }
    check('正斜杠配置的服务也起来了', up2, `${base2} · ${slashRoot}`)
    if (up2) {
      const ak2 = await (await fetch(`${base2}/api/scan?root=tmp&mode=ark&refresh=1`)).json()
      const h2 = (ak2.items || []).filter(i => i.ark && i.ark.charId === 'H001')
      check('正斜杠根目录：ark 元数据照常挂上（startsWith 守卫不许短路）',
        h2.length > 0 && h2.some(i => i.ark.charName === '夏妮'),
        `H001 带 ark 的条目 ${h2.length} 个 · ${h2.map(i => i.ark.charName).join(',')}`)
    }
    await kill(child2)
  }
} catch (e) {
  check('测试执行', false, e.stack || e.message)
} finally {
  await kill(child)
  try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* 沙箱不让删就留在 _scratch */ }
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 失败 ' + fail}  （共 ${pass + fail} 项）`)
  process.exit(fail ? 1 : 0)
}
