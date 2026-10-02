/* =============================================================================
 * BD2 Local L2D / Spine Viewer
 *
 * 本项目基于 jelosus2/BD2-L2D-Viewer 构建：
 *   https://github.com/Jelosus2/BD2-L2D-Viewer
 *   MIT License, Copyright (c) 2025 Jelosus2
 * 功能形态与交互设计沿用该项目 —— 动画列表 / 皮肤 / 播放与速度 / 缩放平移 /
 * 图层显隐与点选 / 背景 / 截图 / 导出。
 * 源码为独立重写（上游是 Vue 3 + TypeScript + Vite，这里是单文件原生 JS），未复制其源码。
 * 差异：数据源改为扫描本地 BD2 mod 目录（BrownDustX/mods），并支持手动上传 Spine 文件。
 * 完整声明见仓库根目录 THIRD-PARTY-NOTICES.md。
 * ========================================================================== */

/* ------------------------------------------------------ 两套 Spine 运行时

   index.html 同时引入两套运行时（见那里的注释）：
     · window.spine    —— spine-player 4.1.55，BD2 / Lost Sword 的骨架是 4.1.x 导出
     · window.spine40  —— spine-player 4.0.31，NIKKE 的骨架是 4.0.x 导出
     · window.spine42  —— spine-player 4.2.120，交错战线 (JCZX) 等 4.2.x 骨架

   为什么要两套：Spine 的骨架与运行时只在 **major.minor 相同**时互通。4.1 运行时读 4.0
   骨架不会报「版本不符」，而是照 4.1 的二进制布局去读，把字节读成 4.1 才有的 sequence
   名，最后报一句看起来像图集缺图的假故障（实测：「Region not found in atlas: add_l_eye23
   (sequence: add_l_eye)」，而图集里明明只有 add_l_eye）。

   同一个 minor 内不受影响：4.0.31 能读 4.0.47 导出的骨架，4.1.55 能读 4.1.11 的。
   所以只需要「按 minor 挑一套」，不需要精确到补丁号。

   挑出来的一套会记在 S.spine 上，**整个播放会话（含自建相机、Vector2）都从它取类**。
   绝不在载入过程中改全局 —— 缩略图队列与主播放器可能同时在跑，改全局会让两个会话
   互相踩。 */
const SPINE_DEFAULT = window.spine      // 4.1.55
const SPINE40 = window.spine40 || null  // 4.0.31；老的无 4.0 产物里会是 null
const SPINE42 = window.spine42 || null  // 4.2.120；JCZX 等 4.2.x 骨架
const SPINE_BY_MINOR = {
  '4.0': SPINE40 || SPINE_DEFAULT,
  '4.1': SPINE_DEFAULT,
  '4.2': SPINE42 || SPINE_DEFAULT,
}
const spine = SPINE_DEFAULT             // 无会话时的默认运行时

/** 骨架 minor 版本（'4.0' / '4.1' / '4.2'）→ 运行时。认不出来时用默认（4.1）。 */
function spineRuntimeForVer(minor) { return SPINE_BY_MINOR[minor] || SPINE_DEFAULT }

/** 当前播放会话的运行时。载入资产时定在 S.spine 上，没有会话时退回默认。 */
function activeSpine() { return S.spine || SPINE_DEFAULT }


/** Spine 4.2+：Skeleton#updateWorldTransform(physics) 必传 Physics 枚举；
 *  漏传会抛 "physics is undefined"，而 onLoaded 跑在 spine-player 的 drawFrame
 *  try/catch 里 → 被包成「Unable to render skeleton」。4.0/4.1 无此参，原样空调。
 *  mode 省略时用 Physics.update（与官方 player 渲染循环一致）。 */
function skeletonUpdateWorld(skeleton, mode) {
  if (!skeleton) return
  const Physics = (S.spine || SPINE_DEFAULT)?.Physics
  if (Physics != null) {
    skeleton.updateWorldTransform(mode != null ? mode : Physics.update)
  } else {
    skeleton.updateWorldTransform()  // 4.0 / 4.1：无 physics 参数
  }
}


const JSZip = window.JSZip

const $ = id => document.getElementById(id)
const clamp = (v, a, b) => Math.min(Math.max(v, a), b)

/* ------------------------------------------------------------------ 状态 */

const S = {
  config: null,
  rootId: null,
  // 当前根目录的**绝对路径**（扫描响应里带回来的）。资产条目只存相对路径，
  // 想拼出「这个资产在硬盘哪一层」只能靠它。数据源不暴露路径时是空串。
  rootPath: '',
  items: [],            // 服务端扫描到的资产
  customItems: [],      // 手动上传的资产
  current: null,
  player: null,
  camera: null,
  // Lost Sword 两层角色（R19）：背层 `_B` 单独一个播放器，叠在本体（`_F`）下面
  backPlayer: null,
  backItem: null,
  bounds: null,
  // 当前播放会话使用的 Spine 运行时（4.1 或 4.0，随资产骨架版本挑）。见 activeSpine()。
  spine: null,
  defaultPos: { x: 0, y: 0 },
  defaultZoom: 1,
  animations: [],
  skins: [],
  slots: [],
  hidden: new Set(),
  hiddenStack: [],
  selectedLayer: null,
  playing: true,
  speed: 1,
  loop: true,
  autoPlay: true,
  autoRefit: true,
  bgColor: '#1f2937',
  bgImageUrl: null,
  // 初值在 boot() 里按 mode 默认覆写（需求 4：bd 开 / 其余关）
  premultiplied: true,
  layerSelect: false,
  useCurrentCamera: false,
  maxSize: 3000,
  fps: 60,
  busy: false,
  // 资产类型（'bd' | 'lostsword'）——决定扫描用哪套文件名约定，全局一个。
  // 真正的初值在 boot() 里从 localStorage 读（见 ASSET_MODES / loadMode）。
  mode: 'bd',
  volDir: (function () {
    try { return localStorage.getItem('bd2.volDir') === 'prev' ? 'prev' : 'next' } catch { return 'next' }
  })(),   // 音量上键 = 下一个（next）还是上一个（prev）
}

let cancelled = false

/* ------------------------------------------------------------------ 多语言
 *
 * 设计取向：**中文原文就是 key**，不发明一套抽象标识符。
 *
 *   t('删除这个资产？')                      → 英文时查表；查不到就原样返回中文
 *   t('已删除 {n} 个资产', { n: 3 })          → 带参数，中英模板都用 {n} 占位
 *
 * 为什么这么做：
 *   ① 中文侧零回归 —— 中文模式下 t() 恒等于「返回原文」，界面与加翻译前逐字节一致。
 *      这条很重要：这个项目的中文文案是长期打磨过的（措辞、标点、术语），
 *      任何「先把中文改写成 key、再翻译回来」的方案都会在途中走样。
 *   ② 查不到不会炸 —— 新加一句中文忘了翻译，英文界面显示中文原文，功能照常，
 *      而不是显示 `asset.delete.confirm` 这种给开发者看的东西。
 *   ③ 翻译表和代码在同一屏里对得上 —— 改文案和改翻译是一件事，不会被拆到两个文件里
 *      越走越远（这个项目已经被「同一件事的真相存在两处」坑过三次）。
 *
 * 代价：英文表里要照抄一遍中文原文当 key。这是**故意**的取舍 ——
 * 换来的是中文侧物理上不可能被这次改动影响。
 */

const I18N_EN = {
  /* ---- 顶栏 / 导航 ---- */
  '本地复刻版': 'Local Edition',
  '立绘': 'Illustration',
  '头像': 'Portrait',
  '语音': 'Voice',
  '播放中…': 'Playing…',
  '语音加载失败': 'Voice failed to load',
  '语音播放失败': 'Voice playback failed',
  '{n} 个形态': '{n} forms',
  '{n} 图': '{n} images',
  '{w}×{h}': '{w}x{h}',
  '{n} 个动画': '{n} animations',
  '{n} 张': '{n}',
  '战斗形态': 'Battle form',
  'CG {x}': 'CG {x}',
  '选择资产根目录': 'Choose asset root folder',
  '添加目录': 'Add Folder',
  '把任意本地文件夹加为根目录': 'Add any local folder as a root',
  '重新扫描': 'Rescan',
  '上传文件': 'Upload Files',
  '拖入 .json/.skel + .atlas + .png': 'Drop .json/.skel + .atlas + .png',
  '平铺浏览': 'Grid',
  '回到平铺浏览': 'Back to grid',
  '全屏': 'Fullscreen',
  '全屏观看（音量键/↑↓ 切动画，☰ 换文件）': 'Fullscreen (volume keys / ↑↓ switch animation, ☰ switch file)',
  '全屏观看（音量键切动画）': 'Fullscreen (volume keys switch animation)',
  '快捷键': 'Shortcuts',
  '设置': 'Settings',
  '导出错误日志': 'Export error log',
  '把这次打开期间的载入和解包错误存成 bd2viewer-error-log.txt。': 'Saves load and unpack errors from this session as bd2viewer-error-log.txt.',
  '已保存：': 'Saved: ',

  /* ---- 左栏：控制 ---- */
  '控制': 'Controls',
  '图层': 'Layers',
  '未载入': 'Not loaded',
  '在右侧列表里选一个资产': 'Pick an asset from the list on the right',
  '动画': 'Animations',
  '过滤动画…': 'Filter animations…',
  '皮肤 (Skin)': 'Skin',
  '播放': 'Play',
  '暂停': 'Pause',
  '后退一帧': 'Step back one frame',
  '前进一帧': 'Step forward one frame',
  '循环播放': 'Loop',
  '速度': 'Speed',
  '视图': 'View',
  '放大 +': 'Zoom In +',
  '缩小 −': 'Zoom Out −',
  '重置视图': 'Reset View',
  '适配窗口': 'Fit to Window',
  '截图 / 导出时使用当前镜头': 'Use current camera for screenshots / exports',
  '背景': 'Background',
  '选背景图': 'Choose Image',
  '清除': 'Clear',
  '截图 / 导出': 'Screenshot / Export',
  '透明背景': 'Transparent background',
  '截图 PNG': 'Screenshot PNG',
  '2K 截图': '2K Screenshot',
  '导出 WebM 视频': 'Export WebM Video',
  '导出帧序列 (ZIP)': 'Export Frame Sequence (ZIP)',
  '视频按「时长 × 帧率」逐帧录制（最高 60 fps），背景色/背景图会烘进画面；浏览器限制 WebM 不带透明通道，「透明背景」只对 PNG 截图与帧序列生效。需要更高帧率请用帧序列导出。':
    'Video is recorded frame by frame at duration × frame rate (up to 60 fps); background color/image is baked in. Browsers cannot write alpha into WebM, so "Transparent background" only affects PNG screenshots and frame sequences. Use frame sequence export for higher frame rates.',

  /* ---- 左栏：图层 ---- */
  '开启「图层选择」后可直接点模型选层。': 'Turn on "Layer Selection" to pick layers by clicking the model.',
  '隐藏选中层，': 'hide the selected layer, ',
  '恢复上一次，': 'restore the previous one, ',
  '全部还原。': 'restore all.',
  '选中后在下方图层列表里直接隐藏 / 恢复。': 'After selecting, hide / restore layers directly in the list below.',
  '图层选择模式': 'Layer selection mode',
  '过滤图层…': 'Filter layers…',
  '全部显示': 'Show All',
  '全部隐藏': 'Hide All',
  '没有匹配的图层': 'No matching layers',
  '（暂无图层）': '(no layers)',

  /* ---- 舞台 ---- */
  '加载中…': 'Loading…',
  '从右侧选一个资产开始查看': 'Pick an asset on the right to start',
  '也可以点「上传文件」，再在投放区拖入文件夹': 'Or tap Upload, then drop a folder onto the drop zone',
  '上一个动画': 'Previous animation',
  '下一个动画': 'Next animation',

  /* ---- 平铺页 ---- */
  '平铺浏览 · {n} 个 L2D': 'Grid · {n} L2D',
  '播放顺序': 'Play order',
  '手动': 'Manual',
  '名称': 'Name',
  '日期': 'Date',
  '切换升序降序': 'Toggle ascending / descending',
  '切换升序 / 降序': 'Toggle ascending / descending',
  '反转当前播放顺序': 'Reverse current play order',
  '当前升序，点一下改降序': 'Currently ascending — click for descending',
  '当前降序，点一下改升序': 'Currently descending — click for ascending',
  '重建缩略图': 'Rebuild Thumbnails',
  '删掉缓存，重新生成缩略图': 'Clear cache and regenerate thumbnails',
  '重建这张缩略图': 'Rebuild this thumbnail',
  '正在重建这张缩略图…': 'Rebuilding this thumbnail…',
  '这张没有可重建的缩略图': 'This card has no thumbnail to rebuild',
  '选择': 'Select',
  '进入批量选择，可一次删除多个资产': 'Enter multi-select to delete several assets at once',
  '全选': 'Select All',
  '未选择': 'None selected',
  '删除所选': 'Delete Selected',
  '完成': 'Done',
  '退出选择': 'Exit selection',
  '拖动卡片调整播放顺序（按住左上角 ⠿ 立刻拖）· 右键卡片可复制路径 / 删除':
    'Drag cards to reorder playback (hold ⠿ at top-left to drag immediately) · right-click a card to copy its path or delete it',
  '长按卡片拖动 = 调整播放顺序 · 按住不动弹删除菜单':
    'Long-press and drag a card = reorder · hold still = delete menu',
  '按{mode}（{dir}）· 切回「手动」才能拖动排序': 'By {mode} ({dir}) · switch back to Manual to drag-reorder',
  '未生成': 'not generated',
  '拖动调整播放顺序': 'Drag to reorder playback',
  '直接全屏播放': 'Play in fullscreen',
  '取消': 'Cancel',
  '删除': 'Delete',

  /* ---- 右栏：资产 ---- */
  '资产浏览': 'Assets',
  '搜索：目录名 / 文件名 / 图集内资源…': 'Search: folder / file name / inner assets…',
  '清空搜索': 'Clear search',
  '过滤：目录名 / 文件名…': 'Filter: folder / file name…',
  '仅可播放': 'Playable only',
  '清除已上传': 'Clear Uploaded',
  '没有匹配的资产': 'No matching assets',
  '请先添加一个目录': 'Add a folder first',
  '匹配 {n} 个': '{n} matched',
  '无匹配': 'No match',

  /* ---- 手机端 ---- */
  '上一个资产': 'Previous asset',
  '下一个资产': 'Next asset',

  /* ---- 全屏 ---- */
  '文件列表': 'File list',
  '隐藏界面（只看画面）': 'Hide UI (artwork only)',
  '隐藏界面 · 点画面可临时唤出': 'UI hidden · tap the artwork to show temporarily',
  '显示界面': 'Show UI',
  '退出全屏': 'Exit fullscreen',
  '上一个动画（音量−）': 'Previous animation (Vol−)',
  '下一个动画（音量+）': 'Next animation (Vol+)',
  '◀▶ 切资产 · 音量键切动画 · ☰ 换文件 · ✕ 退出': '◀▶ asset · volume keys animation · ☰ files · ✕ exit',

  /* ---- 设置 ---- */
  '文件目录': 'File Folder',
  '贴图预乘 alpha（BD2 / NIKKE / JCZX 建议开启；NIKKE·JCZX 图集已是 PMA，关开会黑边；BD2 为直通 PNG 需开启）':
    'Premultiply texture alpha (on for BD2 / NIKKE / JCZX; NIKKE·JCZX atlases are already PMA — turning off causes dark fringes; BD2 uses straight PNGs and needs this on)',
  '切换资产后自动播放': 'Auto-play after switching asset',
  '切换动画时自动重新取景（会保留你当前的缩放倍数，不会打回原始大小；想完全固定视角就关掉）':
    'Refit when switching animation (keeps your current zoom level, does not reset to original size; turn off to lock the view)',
  '音量上键': 'Volume Up key',
  '切到下一个动画': 'Next animation',
  '切到上一个动画': 'Previous animation',
  '音量键切动画只在全屏模式生效；音量下键方向相反。':
    'Volume keys switch animations in fullscreen only; Volume Down is the opposite direction.',
  '默认背景色': 'Default background',
  '截图边长上限': 'Screenshot max side',
  '导出帧率': 'Export frame rate',
  '界面语言': 'Language',
  '中文': '中文',
  'English': 'English',
  '语言只影响界面文字，不改动你的资产和排序设置。': 'Language only affects UI text; it does not touch your assets or sort settings.',

  /* ---- 语言首次询问 ---- */
  '选择界面语言': 'Choose your language',
  '可随时在「设置」里修改': 'You can change this anytime in Settings',
  '继续': 'Continue',

  /* ---- 上传 ---- */
  '上传 Spine 文件': 'Upload Spine Files',
  '选择或拖入同一个 Spine 4.1 资产组的 .json（或 .skel）+ .atlas + 全部 .png。也可以直接拖入整个文件夹。':
    'Select or drop the .json (or .skel) + .atlas + all .png of one Spine 4.1 asset group. You can also drop an entire folder.',
  '显示名称（可留空）': 'Display name (optional)',
  '把文件拖到这里，或 选择文件': 'Drop files here, or choose files',
  '选择文件': 'choose files',
  '载入': 'Load',
  '导入文件': 'Import Files',
  '资产': 'Assets',
  '把文件拖到这里，或': 'Drop files here, or ',
  '本次会话上传的资产（不在磁盘上）': 'Assets uploaded this session (not on disk)',
  '这些是本次会话上传的资产，移除后需要重新上传。':
    'These assets were uploaded this session; removing them means uploading again.',

  /* ---- 快捷键弹窗 ---- */
  '拖拽 / 滚轮': 'Drag / Wheel',
  '平移 / 缩放视图': 'Pan / zoom the view',
  '空格': 'Space',
  '播放 / 暂停': 'Play / pause',
  '← / →': '← / →',
  '后退 / 前进一帧': 'Step back / forward one frame',
  'R': 'R',
  'F': 'F',
  'L': 'L',
  '切换图层选择模式': 'Toggle layer selection mode',
  '点击模型': 'Click model',
  '图层选择模式下选中该图层': 'Select that layer in layer-selection mode',
  'H': 'H',
  '隐藏选中的图层': 'Hide the selected layer',
  'U': 'U',
  '恢复上一次隐藏': 'Restore the last hidden layer',
  'Esc': 'Esc',
  '还原全部隐藏': 'Restore all hidden layers',
  '[ / ]': '[ / ]',
  '上一套 / 下一套动画': 'Previous / next animation set',
  '↑ / ↓': '↑ / ↓',
  '上一个 / 下一个动画（全屏时也可用音量键）': 'Previous / next animation (volume keys work in fullscreen)',
  '知道了': 'Got it',
  '本项目基于': 'Built upon',
  '构建 · MIT License, Copyright (c) 2025 Jelosus2': ' · MIT License, Copyright (c) 2025 Jelosus2',
  '功能形态沿用上游，源码为独立重写（未复制其源码）。':
    'Feature design follows the upstream project; source code is an independent rewrite (no code copied).',

  /* ---- 卡片菜单 / 删除确认 ---- */
  '资产操作': 'Asset Actions',
  '删除这个资产': 'Delete this asset',
  '批量选择…': 'Multi-select…',
  '复制文件夹路径': 'Copy folder path',
  '复制图集文件路径': 'Copy atlas file path',
  '路径已复制': 'Path copied',
  '复制失败，可手动选中路径复制': 'Copy failed — select the path below and copy it manually',
  '这个数据源没有可复制的本地路径': 'This source has no local path to copy',
  /* ---- 播放页返回（PC） ---- */
  '回到项目选择页': 'Back to items',
  '返回列表': 'Back',
  /* ---- NIKKE 姿势（R18：同一角色的 aim / cover 变体） ---- */
  '姿势 (Pose)': 'Pose',
  '普通': 'Normal',
  '瞄准': 'Aim',
  '掩体': 'Cover',
  '+{n} 个姿势文件': '+{n} pose file(s)',
  /* ---- Lost Sword 两层角色（R19：`_B` 背层 + `_F` 前层） ---- */
  '含背层': 'with back layer',
  /* ---- NIKKE mod 包解包（UnityFS → 标准三件套） ---- */
  '解包中 {done}/{total}': 'unpacking {done}/{total}',
  '解包 {done}/{total} · {name}': 'Unpack {done}/{total} · {name}',
  '解包 {done}/{total}': 'Unpack {done}/{total}',
  '包处理进度 {done}/{total} · {name}': 'Pack progress {done}/{total} · {name}',
  '包处理进度 {done}/{total}': 'Pack progress {done}/{total}',
  '包处理中 {done}/{total}': 'Processing packs {done}/{total}',
  '扫描中…': 'Scanning…',
  '缩略图 {done}/{total}': 'Thumbs {done}/{total}',
  '阶段：解包': 'Stage: unpack',
  '阶段：加载骨架': 'Stage: load skeleton',
  '阶段：渲染': 'Stage: render',
  '等待解包…': 'Waiting to unpack…',
  '尚未解包': 'Not unpacked yet',
  '解包优先已排到队首': 'Unpack bumped to front of queue',
  '资产可能尚未解包完成，请稍后再打开。':
    'The bundle may still be unpacking — please try again later.',
  '不支持的 Spine 版本：{v}': 'Unsupported Spine version: {v}',
  '这套资产由 Spine {v} 导出，查看器目前支持 Spine 4.0 / 4.1 / 4.2，暂时播不了。\n可以用 Spine 官方编辑器把它重新导出为 4.x 再放进目录。':
    'This asset was exported by Spine {v}; the viewer currently supports Spine 4.0 / 4.1 / 4.2 and cannot play it.\nRe-export it as 4.x with the official Spine editor and put it back into the folder.',

  '正在解包 NIKKE 资产包：已就绪 {done} 套，后台还在处理 {left} 个…':
    'Unpacking NIKKE bundles: {done} ready, {left} still processing in background…',
  'NIKKE 资产解包完成：{done} 套可播放': 'NIKKE unpack finished: {done} playable',
  'NIKKE 解包出错：{msg}': 'NIKKE unpack error: {msg}',
  'NIKKE 资产包仍在后台解包，稍后点「重新扫描」查看':
    'NIKKE bundles are still being unpacked in the background — hit Rescan later.',
  '有 {n} 个包的贴图可能不准（压缩/流式贴图），建议在 PC 端解包后把产物拷到手机':
    'Textures of {n} bundle(s) may be inaccurate (compressed/streamed) — unpack on PC and copy the result over.',
  '确认删除': 'Confirm Delete',
  '删除这个资产？': 'Delete this asset?',
  '删除这个文件路径': 'Remove this folder path',
  '从配置列表移除当前根目录（不删磁盘文件）':
    'Remove the current root from the config list (does not delete files on disk)',
  '移除这个文件路径？': 'Remove this folder path?',
  '⚠️ 只会从查看器配置里去掉这条根路径，<b>不会删除磁盘上的任何文件</b>。之后可再点「添加目录」加回来。':
    '⚠️ This only removes the root path from the viewer config list. <b>No files on disk will be deleted.</b> You can add it again later with "Add Folder".',
  '确认移除': 'Confirm Remove',
  '已从配置移除：{label}': 'Removed from config: {label}',
  '移除路径失败：': 'Failed to remove path: ',
  '没有可移除的根目录': 'No root path to remove',
  '系统自动目录不能从列表移除': 'Built-in system folders cannot be removed from the list',
  '请先添加一个目录（顶栏「添加目录」）': 'Add a folder first (top bar "Add Folder")',
  '正在删除…': 'Deleting…',
  '删除 {n} 个资产？': 'Delete {n} assets?',
  '⚠️ 此操作非常危险，可能导致不可逆的数据丢失！': '⚠️ This is irreversible and may cause permanent data loss!',
  '将真正删除磁盘上的 ': 'This will permanently delete ',
  ' 套资产文件</b>（atlas / skeleton / 贴图），无法恢复。':
    ' asset file set(s) from disk (atlas / skeleton / textures). It cannot be undone.',

  /* ---- 含行内标签的段落（用 data-i18n-html / innerHTML 整条替换） ----
     用 `textContent` 会把 <b> 一起抹掉，所以这些单独列出来。
     key 和值都必须带标签，两边形状一致才不会出现「中文有粗体、英文没有」。
     ⚠ 只允许放我们自己写的常量 —— 绝不能把资产名 / 路径塞进这些字符串再 innerHTML。 */
  '选择或拖入同一个 Spine 4.1 资产组的 <b>.json</b>（或 <b>.skel</b>）+ <b>.atlas</b> + 全部 <b>.png</b>。也可以直接拖入整个文件夹。':
    'Select or drop the <b>.json</b> (or <b>.skel</b>) + <b>.atlas</b> + all <b>.png</b> of one Spine 4.1 asset group. You can also drop an entire folder.',
  '⚠️ 此操作非常危险，可能导致不可逆的数据丢失！<br>将<b>真正删除磁盘上的 {n} 套资产文件</b>（atlas / skeleton / 贴图），无法恢复。':
    '⚠️ This is irreversible and may cause permanent data loss!<br>This will <b>permanently delete {n} asset file set(s)</b> from disk (atlas / skeleton / textures). It cannot be undone.',

  /* ---- toast / 状态 ---- */
  '扫描中…': 'Scanning…',
  '扫描失败': 'Scan failed',
  '扫描失败：': 'Scan failed: ',
  '载入中…': 'Loading…',
  '载入失败：': 'Load failed: ',
  '初始化播放器失败：': 'Failed to initialize player: ',
  '切换皮肤失败：': 'Failed to switch skin: ',
  '保存失败：': 'Save failed: ',
  '写入失败': 'Write failed',
  '删除失败': 'Delete failed',
  '导出失败：': 'Export failed: ',
  '导出帧序列失败：': 'Frame sequence export failed: ',
  '截图失败：': 'Screenshot failed: ',
  '录制失败': 'Recording failed',
  '读取失败': 'Read failed',
  '读取导出结果失败': 'Failed to read export result',
  '读取目录：创建失败': 'Folder: creation failed',
  '读取目录：{dir}': 'Folder: {dir}',
  '添加失败': 'Add failed',
  '添加目录失败：': 'Failed to add folder: ',
  '移除目录失败：': 'Failed to remove folder: ',
  '打不开文件夹选择器：': 'Could not open folder picker: ',
  '后台任务出错：': 'Background task error: ',
  '原生层无响应：': 'Native layer not responding: ',
  '无法连接本地服务：': 'Cannot reach local service: ',
  '缩略图渲染失败': 'Thumbnail render failed',
  '缩略图生成超时': 'Thumbnail generation timed out',
  '无法读取 atlas': 'Cannot read atlas',
  '读不到骨架文件：': 'Cannot read skeleton file: ',
  '读不到骨架文件（HTTP {status}）': 'Cannot read skeleton file (HTTP {status})',
  'JSON 损坏：{msg}': 'Corrupt JSON: {msg}',
  '「{folder}」的 .json 是坏文件（{msg}）。\n': 'The .json for "{folder}" is a corrupt file ({msg}).\n',
  '骨架为空：请确认 .json 与 .atlas 是否匹配': 'Empty skeleton: check that the .json matches the .atlas',
  '这个骨架里没有任何动画': 'This skeleton has no animations',
  '没有可导出的动画': 'No animation to export',
  '缺少 .atlas / .atlas.bytes 图集文件': 'Missing .atlas / .atlas.bytes atlas file',
  '缺少骨架文件（.json / .skel / .bytes）': 'Missing skeleton file (.json / .skel / .bytes)',
  '缺少贴图 .png': 'Missing texture .png',
  'atlas 引用了但没提供这些图：': 'atlas references these missing images: ',
  '缩略图 {done}/{total}': 'Thumbnails {done}/{total}',
  '正在重新生成缩略图…': 'Regenerating thumbnails…',
  '正在移除…': 'Removing…',
  '正在录制 WebM…': 'Recording WebM…',
  '正在打包 ZIP…': 'Packaging ZIP…',
  '正在录制 WebM {i}/{total} …': 'Recording WebM {i}/{total} …',
  '正在导出帧 {i}/{total} …': 'Exporting frame {i}/{total} …',
  '录制结果为空：当前浏览器没能从画布采到帧':
    'Recording produced nothing: this browser could not capture frames from the canvas',
  '提示：渲染跟不上 {fps} fps，已跳过 {dropped}/{total} 帧（建议把帧率调低或改用帧序列导出）':
    'Note: rendering cannot keep up with {fps} fps; skipped {dropped}/{total} frames (lower the frame rate or use frame sequence export)',
  '已保存：': 'Saved: ',
  '已删除 {n} 个资产': 'Deleted {n} assets',
  '没有资产被删除': 'No assets deleted',
  '有 {n} 个资产没能删除：': '{n} asset(s) could not be deleted: ',
  '有 {n} 个文件没导入成功：{list}': '{n} file(s) failed to import: {list}',
  '已导入 {n} 个文件': '{n} file(s) imported',
  '正在提取 JCZX 资产…': 'Extracting JCZX assets…',
  '正在提取资产…': 'Extracting assets…',
  'CG · {n} 张': 'CG · {n}',
  'CG {i}/{n}': 'CG {i}/{n}',
  '提取完成，正在刷新列表…': 'Extract done, refreshing…',
  '提取失败：{msg}': 'Extract failed: {msg}',
  '两种包已分开：JCZX {j} 个，NIKKE {n} 个。用顶栏切换查看。':
    'Split apart: {j} JCZX, {n} NIKKE. Switch modes in the top bar to view each.',
  'JCZX 提取完成，正在刷新列表…': 'JCZX extract done, refreshing…',
  'JCZX 提取失败：{msg}': 'JCZX extract failed: {msg}',
  '正在准备 JCZX 环境（首次需联网安装 UnityPy）…': 'Preparing JCZX env (first time needs network for UnityPy)…',
  'JCZX 环境已就绪': 'JCZX environment ready',
  'JCZX 环境未就绪：{msg}': 'JCZX env not ready: {msg}',
  'JCZX 提取：新建 {n}，复用 {m}': 'JCZX extract: {n} new, {m} reused',
  '已接收 {n} 个文件，点「载入」开始': '{n} file(s) received — click Load to start',
  '导入 {i}/{total} · {name}': 'Importing {i}/{total} · {name}',
  '导入 0/{total} …': 'Importing 0/{total} …',
  '已还原': 'Restored',
  '界面已恢复': 'UI restored',
  '已选 {n} 个': '{n} selected',
  '已选图层：<b>{name}</b>': 'Selected layer: <b>{name}</b>',
  '已隐藏界面 · 点画面可临时唤出': 'UI hidden · tap the artwork to show temporarily',
  '播放顺序已保存（{n} 个）': 'Play order saved ({n} items)',
  '放大 ×{step}': 'Zoom ×{step}',
  '正序': 'forward',
  '倒序': 'reversed',
  '升序': 'ascending',
  '降序': 'descending',
  '新的在前': 'newest first',
  '旧的在前': 'oldest first',
  '（根目录）': '(root)',
  '（不存在）': '(not found)',
  '（未配置目录）': '(no folder configured)',
  '（目录还没建好）': '(folder not ready)',
  '（暂无动画）': '(no animations)',
  '（会话内上传，不在磁盘上）': '(uploaded this session, not on disk)',
  '已上传（本次会话）': 'Uploaded (this session)',
  '磁盘文件 · {bits}': 'On disk · {bits}',
  '{n} 张贴图': '{n} textures',
  '+{n} 张贴图': '+{n} textures',
  ' · {n} 图': ' · {n} images',
  '超过 12MB': 'over 12MB',
  '超过 48MB（更大请拷到手机存储 /BD2Viewer/jczx/ 后点重新扫描）':
    'Over 48MB (for larger files, copy into /BD2Viewer/jczx/ then Rescan)',
  '未知原因': 'unknown reason',

  /* ---- 手机端存储条 ---- */
  '去开启': 'Enable',
  '跳转到系统设置页，开启「所有文件访问权限」': 'Open system settings to grant "All files access"',
  '授权文件夹': 'Authorize Folder',
  '用系统文件夹选择器授权一个目录，直接读取不用拷贝文件':
    'Authorize a folder with the system picker to read files directly, no copying',
  '把手机里的 Spine 文件拷进 App 目录，不用数据线':
    'Copy Spine files from your phone into the App folder, no cable needed',
  '复制路径': 'Copy Path',
  '复制目录路径，可粘贴到文件管理器': 'Copy the folder path to paste into a file manager',
  '文件目录：{path}': 'Folder: {path}',
  'APK 模式 · 从手机存储读取 · 扫描深度 {depth}': 'APK mode · reading from phone storage · scan depth {depth}',
  '本地服务 {host}:{port} · 扫描深度 {depth}': 'Local service {host}:{port} · scan depth {depth}',
  '用手机自带的「文件管理」把 .atlas + .json/.skel + .png 拷进这个目录（每套一个子文件夹），':
    'Use your phone file manager to copy .atlas + .json/.skel + .png into this folder (one subfolder per set), ',
  '回来点顶栏「重新扫描」就能看到；懒得找目录就用「导入文件」直接选文件。':
    'then tap "Rescan" in the top bar. If you would rather not hunt for folders, use "Import Files" instead.',
  '可用顶栏「导入文件」拷进当前目录。': 'You can use "Import Files" in the top bar to copy into this folder.',
  '外部目录 {path} 用不了：Android {sdk}+ 的分区存储不允许 App 在手机存储根目录建目录或读文件，':
    'External folder {path} is unavailable: scoped storage on Android {sdk}+ does not let apps create or read folders at phone-storage root, ',
  '（系统设置里叫「所有文件访问权限」）；不想开权限，用顶栏「导入文件」把文件拷进来。':
    ' (called "All files access" in system settings). If you prefer not to grant it, use "Import Files" to copy them in.',
  '已开启全部文件访问，但 {path} 仍不可用：{reason}。':
    'All-files access is granted, but {path} is still unavailable: {reason}.',
  '现在读的是 App 专属目录（文件管理器进不去）。想在手机存储里直接放文件就点「去开启」':
    'Currently reading the app-private folder (file managers cannot reach it). Tap "Enable" to put files in phone storage instead.',
  '目录不存在：{path}': 'Folder does not exist: {path}',
  '多半是下载/拷贝不完整：重新导出一份完整文件，或先看别的资产。':
    'Probably an incomplete download/copy: re-export a full set, or view another asset first.',
  '目录太大，扫描已截断：只覆盖了前 4000 个子目录。建议直接选到放 Spine 文件的那一层。':
    'Folder too large — scan truncated to the first 4000 subfolders. Point the root directly at the folder holding the Spine files.',
  '输入要添加的本地目录绝对路径（例如 E:\\xxx\\mods）：':
    'Enter the absolute path of the local folder to add (e.g. E:\\xxx\\mods):',
  '上次运行崩溃了：\n': 'The previous run crashed:\n',
  '资产类型': 'Asset type',
  '资产类型：{name}': 'Asset type: {name}',
}

/** 当前语言：'zh' | 'en'。中文是源语言，也是任何异常情况下的兜底。 */
let LANG = 'zh'
const LANG_KEY = 'bd2.lang'

/** 读一次语言偏好。注意**不在这里判断「是否首次」** —— 那个由 boot 决定，
 *  因为要在界面画出来之前就把语言定下来，否则会先闪一屏中文。 */
function loadLang() {
  try {
    const v = localStorage.getItem(LANG_KEY)
    if (v === 'en' || v === 'zh') return v
  } catch { /* 读不到就靠下面兜底 */ }
  // 没存过：跟随系统。桌面版没弹窗时（比如直接开 localhost）也有个合理默认。
  return systemLangGuess()
}

function systemLangGuess() {
  try {
    const l = (navigator.language || '').toLowerCase()
    return l.startsWith('zh') ? 'zh' : 'en'
  } catch { return 'zh' }
}

function saveLang(v) {
  LANG = v === 'en' ? 'en' : 'zh'
  try { localStorage.setItem(LANG_KEY, LANG) } catch { /* 存不下就算了，本次会话内仍生效 */ }
  applyLang()
}

/* ------------------------------------------------- 资产类型（全局单一切换）

   两个游戏给同一批 Spine 文件起的扩展名不一样，认「一套资产」的规则也就不同：
     · bd        —— 标准 Spine 导出：xxx.atlas + xxx.json / xxx.skel + 贴图
     · lostsword —— Unity TextAsset 导出：xxx.atlas.bytes + xxx.skel.bytes
                    （JSON 骨架是裸 xxx.bytes），目录里常带一张预算好的 thumb.png

   这个值参与两处键，两处都不能省：
     · 扫描缓存键（服务端 cacheKey、安卓 MODE_*）—— 省了就会拿到上一套规则的结果，
       表现为「切了没反应」；
     · 每个目录的手动播放顺序 bd2.order.<root>.<mode> —— 两套资产的文件名完全不同，
       共用一份顺序只会得到一份对不上的列表。
   排序偏好（bd2.sort.<root>）跨模式共用：那是用户习惯，不是资产数据。

   全局单一切换（不分目录）：用户同一时间只在看一个游戏。
   id 必须与 server.mjs 的 FORMATS 键、ScanEngine 的 MODE_* 一致。 */

const MODE_KEY = 'bd2.mode'
const ASSET_MODES = ['bd', 'lostsword', 'nikke', 'jczx', 'ark']
/** 专名：中英界面都写原文，不进翻译表（R11.1） */
const MODE_LABEL = { bd: 'BD2', lostsword: 'Lost Sword', nikke: 'NIKKE', jczx: 'JCZX', ark: '星陨计划' }
/** 需求 4（修正）：spine-player 的 premultipliedAlpha =「按 PMA 混合」。
 *  · BD2 图集 PNG 是直通 alpha → 需要混合开 + 上传时 UNPACK 预乘（见下）。
 *  · NIKKE / JCZX / Ark 从 Unity RGBA32 抽出的 PNG 本身已是 PMA（atlas `pma:true`）
 *    → 混合必须开；若再 UNPACK 预乘会双预乘，眼睛/半透明处发黑；关掉混合则
 *    经典「PMA 贴图 + 直通混合」黑边。故 nikke/jczx/ark 默认混合开、上传预乘关。
 *  · lostsword 暂保持关（未确认图集 PMA）。 */
const PREMULTIPLY_DEFAULT = { bd: true, lostsword: false, nikke: true, jczx: true, ark: true }
/** 上传时 UNPACK_PREMULTIPLY：仅直通 alpha 图集需要（BD2）。已是 PMA 的切勿开。 */
const UPLOAD_PREMULTIPLY_BY_MODE = { bd: true, lostsword: false, nikke: false, jczx: false, ark: false }
function defaultPremultiply(mode) {
  return ASSET_MODES.includes(mode) ? !!PREMULTIPLY_DEFAULT[mode] : true
}
function needsUploadPremultiply(mode) {
  return ASSET_MODES.includes(mode) ? !!UPLOAD_PREMULTIPLY_BY_MODE[mode] : true
}
/** 勾选/模式变更后：混合标志与「是否在上传时预乘」分开套。 */
function syncPremultiplyGl() {
  applyGLTexturePatch(!!S.premultiplied && needsUploadPremultiply(S.mode))
}
/** 切模式时套默认值，并同步勾选框 + GL 贴图补丁（不重建播放器——调用方负责）。 */
function applyPremultiplyForMode(mode) {
  S.premultiplied = !!PREMULTIPLY_DEFAULT[mode]
  const chk = $('chkPremultiplied')
  if (chk) chk.checked = S.premultiplied
  syncPremultiplyGl()
}

function loadMode() {
  try {
    const v = localStorage.getItem(MODE_KEY)
    if (ASSET_MODES.includes(v)) return v
  } catch { /* 隐私模式下读不到 → 用默认 */ }
  return 'bd'
}

/** 把 S.mode 同步到分段控件（唯一的状态来源是 S.mode，控件只是它的显示） */
function syncModeUI() {
  const box = $('galMode')
  if (!box) return
  for (const b of box.querySelectorAll('.gm-btn')) {
    b.setAttribute('aria-pressed', String(b.dataset.assetMode === S.mode))
  }
}

/**
 * 切资产类型：落盘 → 刷控件 → 按新规则重扫。
 * 重扫是必须的：S.items 是上一个模式扫出来的结论，留着就会摆出一堆
 * 不属于当前类型的卡片（点开必然报错）。
 */
async function setAssetMode(mode) {
  if (!ASSET_MODES.includes(mode) || mode === S.mode) return
  S.mode = mode
  try { localStorage.setItem(MODE_KEY, mode) } catch { /* 存不下就算了 */ }
  syncModeUI()
  // Drop in-flight thumb jobs from the previous mode so we never mkdir their
  // paths under the new mode root (Celia_* / 神悠* under jczx/, etc.).
  try { thumbAsked.clear() } catch { /* */ }
  // 需求 4：切模式套该 mode 的预乘默认（手动开关保留到下次切模式为止）
  applyPremultiplyForMode(mode)
  // 上一个模式选中的那套资产已经不在新列表里了，先放掉 ——
  // 否则播放页会继续挂着一套不属于当前类型的画面（而且它的文件按新规则根本不成立）。
  if (S.current) { disposePlayer(); S.current = null }
  S.currentPose = 'normal'
  // 切档时把 ark 的两块 UI 收起来：disposePlayer 不走 resetMeta，光靠它这些组会
  // 顶着上一个模式的立绘/语音留在侧栏里（切到 bd 档后还看得到星陨计划的语音列表）。
  for (const id of ['arkStaticGroup', 'arkVoiceGroup']) {
    const g = $(id)
    if (g) g.hidden = true
  }
  stopArkVoice()
  // 立刻清空可见列表并刷一帧：S.items 还是上一 mode 扫出来的结论，
  // 若等 await scan 回来才清，切换瞬间会出现「NIKKE 档亮着、格子却仍是 BD2 卡」
  // （大目录扫描要几百毫秒到数秒，截图像素级证据就是这么来的）。
  S.items = []
  nikkeView = null
  refreshLists()
  toast(t('资产类型：{name}', { name: MODE_LABEL[mode] }))
  // 强制重扫：① Android 自动根会按 mode 切到 BD2Viewer/{bd2,nikke,lostsword}
  // ② force 时原生会清掉该 rootId 下所有 mode 桶（见 ScanEngine.scan）
  await scan(true)
}

/**
 * 翻译函数。中文模式下直接返回原文（**恒等**，保证中文界面零回归）。
 *
 * 参数替换用 {name} 占位。中英两侧的模板都写 {name}，
 * 所以 t('已删除 {n} 个资产', {n: 3}) 在中文下得到「已删除 3 个资产」，
 * 而不是「已删除 {n} 个资产」—— 这一条必须对，否则中文界面会漏出占位符。
 */
function t(zh, params) {
  let s = zh
  if (LANG === 'en') {
    const en = I18N_EN[zh]
    if (en != null) s = en
  }
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m))
  }
  return s
}

/** 给节点设文字（已经用 textContent 的地方可以不改；这个是为了表达意图统一） */
function setText(el, zh, params) {
  if (el) el.textContent = t(zh, params)
}

/**
 * 把界面上的静态文案刷成当前语言。
 *
 * 做法：index.html 里给要翻译的元素加 `data-i18n="中文原文"`，
 * 这里按属性去查表并写回。中文时会把 data-i18n 的值原样写回 ——
 * 也就是说**中文界面的文字来自 HTML 自己**，JS 一个字符都没改。
 *
 * 带 title / placeholder / aria-label 的另有两种属性：
 *   data-i18n-title / data-i18n-ph / data-i18n-aria
 */
function applyLang() {
  document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN'
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'))
  }
  // 含 <b> / <br> 这类行内标签的段落在翻译表里整条存 HTML。
  // 只有这几处的翻译值是**我们自己写的常量**，不含用户数据 ——
  // 用 innerHTML 是安全的；绝不要拿它去渲染任何来自资产/路径的字符串。
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.getAttribute('data-i18n-html'))
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.getAttribute('data-i18n-title'))
  }
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.getAttribute('data-i18n-ph'))
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')))
  }
  // 这些是 JS 生成的文案，静态替换覆盖不到 → 重刷一遍（它们都读状态，是纯渲染函数）
  if (typeof applySortUI === 'function') applySortUI()
  if (typeof refreshLists === 'function' && S.rootId) refreshLists()
  if (typeof renderStorageBar === 'function') renderStorageBar()
  // #dropText 是「主文案 + 选择文件链接」两段结构，任何地方改了它都要能还原
  if (typeof dropTextDefault === 'function') dropTextDefault()
}

/**
 * 写 #dropText。**不要**直接 `$('dropText').textContent = ...` ——
 * 那个容器里是两个 span（主文案 + 「选择文件」链接），整体赋值会把链接节点一起删掉，
 * 之后既点不了、切语言也回不来。所以只在第一个 span 上写，链接始终留着。
 */
function setDropText(s) {
  const box = $('dropText')
  if (!box) return
  const head = box.querySelector('span[data-i18n]')
  if (head) head.textContent = s
  else box.textContent = s
}

/** 把 #dropText 恢复成「拖到这里 / 选择文件」的默认两段结构 */
function dropTextDefault() {
  setDropText(t('把文件拖到这里，或'))
}

/* ------------------------------------------------------------------ 小工具 */

const errorLog = []
function logError(msg) {
  const line = new Date().toISOString() + ' ' + String(msg == null ? '' : msg).replace(/\s+/g, ' ').slice(0, 2000)
  errorLog.push(line)
  if (errorLog.length > 300) errorLog.shift()
}
window.__bd2PushLog = logError

function exportErrorLog() {
  const lines = [
    'BD2Viewer ' + (typeof APP_VERSION !== 'undefined' ? APP_VERSION : ''),
    'mode=' + ((typeof S !== 'undefined' && S.mode) || ''),
    'root=' + ((typeof S !== 'undefined' && S.rootId) || ''),
    'ua=' + (navigator.userAgent || ''),
    '',
  ]
  if (!errorLog.length) lines.push('(no errors recorded this session)')
  else lines.push(...errorLog)
  const text = lines.join('\n')
  const name = 'bd2viewer-error-log.txt'
  try {
    if (NATIVE && window.BD2Native && window.BD2Native.saveErrorLog) {
      const path = window.BD2Native.saveErrorLog(S.rootId || '', text)
      if (path) return
    }
  } catch (e) {
    logError('export native ' + e.message)
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  a.download = name
  a.click()
}

function showError(msg) {
  try { logError(msg) } catch { /* 日志本身不能再炸 */ }
  const box = $('errorBox')
  box.textContent = msg
  box.hidden = false
  clearTimeout(showError._t)
  showError._t = setTimeout(() => { box.hidden = true }, 9000)
}

function clearError() { $('errorBox').hidden = true }
function setBusy(on, text) {
  S.busy = on
  const sp = $('spinner')
  if (!sp) return
  sp.hidden = !on
  const label = sp.querySelector('.spinner-text') || sp.querySelector('span:not(.dot)')
  if (text && label) label.textContent = text
  // 必须传 {} / 无参：setLoadProgress(null) 会因解构 null 抛
  //「Cannot destructure property 'stage' … as it is null」，
  // 打断 onLoaded → 表现为任意资产「Unable to render skeleton」+ 后台任务出错。
  if (!on) setLoadProgress()
}

/* ---------------- 需求 2：真实进度 UI（解包 / 扫描 / 缩略图 / 单资产） ---------------- */
function setWorkRow(rowId, fillId, labelId, opts) {
  const { done, total, label, indeterminate } = opts || {}
  const row = $(rowId)
  const fill = $(fillId)
  const lab = $(labelId)
  const wrap = $('workProgress')
  if (!row) return
  const show = indeterminate || (total > 0 && done < total)
  row.hidden = !show
  if (lab) lab.textContent = label || ''
  if (fill) {
    const track = fill.parentElement
    if (track) track.classList.toggle('indeterminate', !!indeterminate)
    if (indeterminate) fill.style.width = '35%'
    else fill.style.width = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) + '%' : '0%'
  }
  if (wrap) {
    const any = [...wrap.querySelectorAll('.work-progress-row')].some(r => !r.hidden)
    wrap.hidden = !any
  }
}

function setUnpackProgress(meta) {
  if (!meta || !(meta.found > 0)) {
    setWorkRow('unpackProgressRow', 'unpackFill', 'unpackLabel', { done: 0, total: 0 })
    return
  }
  const done = meta.done != null ? meta.done : ((meta.reused || 0) + (meta.extracted || 0)
    + (meta.failed || 0) + (meta.skippedNoSpine || 0))
  const total = meta.total != null ? meta.total : meta.found
  const pending = meta.pending || 0
  const inFlight = meta.inFlight || 0
  const cur = Array.isArray(meta.current) && meta.current.length ? meta.current[0] : ''
  // done 含 failed/skipped 时不是「可播放套数」→ 用包处理进度
  const packProgress = !!(meta.failed || meta.skippedNoSpine
    || (meta.playableDone != null && meta.playableDone !== done)
    || meta.packProgress)
  const label = packProgress
    ? (cur
      ? t('包处理进度 {done}/{total} · {name}', { done, total, name: cur })
      : t('包处理进度 {done}/{total}', { done, total }))
    : (cur
      ? t('解包 {done}/{total} · {name}', { done, total, name: cur })
      : t('解包 {done}/{total}', { done, total }))
  setWorkRow('unpackProgressRow', 'unpackFill', 'unpackLabel', {
    done, total, label, indeterminate: false,
  })
  // 队列空闲即清条：勿再依赖 done>=total（失败包曾导致 toast/进度永不消失）
  if (pending <= 0 && !(inFlight > 0)) {
    setWorkRow('unpackProgressRow', 'unpackFill', 'unpackLabel', { done: 0, total: 0 })
  }
}

function setScanProgress(on, text) {
  setWorkRow('scanProgressRow', 'scanFill', 'scanLabel', {
    done: 0, total: on ? 1 : 0, label: text || t('扫描中…'), indeterminate: !!on,
  })
  // 扫描期间只显示真实进度条；不要用固定数量的空卡片填充图库。
}

function setThumbProgress(done, total) {
  setWorkRow('thumbProgressRow', 'thumbFill', 'thumbLabel', {
    done, total,
    label: total > 0 && done < total ? t('缩略图 {done}/{total}', { done, total }) : '',
  })
}

/** 播放页加载遮罩：有天然计数就用确定进度，否则不定长 + 阶段文字。
 *  无参 / null / undefined 都表示「清掉进度」（勿对 null 解构）。 */
function setLoadProgress(opts) {
  const { stage, done, total, indeterminate, text } = opts || {}
  const track = $('loadTrack')
  const fill = $('loadFill')
  const st = $('loadStage')
  if (!track) return
  const show = !!(stage || text || (total > 0) || indeterminate)
  track.hidden = !show && !indeterminate
  if (st) {
    st.hidden = !stage && !text
    st.textContent = stage || text || ''
  }
  if (fill) {
    track.classList.toggle('indeterminate', !!indeterminate || !(total > 0))
    if (total > 0 && !indeterminate) fill.style.width = Math.max(0, Math.min(100, (done / total) * 100)) + '%'
    else fill.style.width = '35%'
  }
  if (!show) {
    track.hidden = true
    if (st) st.hidden = true
  }
}

async function fetchNikkeProgress() {
  if (NATIVE) {
    try {
      const raw = window.BD2Native.nikkeUnpackProgress(S.rootId)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }
  try {
    const res = await fetch(`/api/nikke-ab/progress?root=${encodeURIComponent(S.rootId)}`)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function prioritizeNikke(rels, keys) {
  const list = Array.isArray(rels) ? rels.filter(Boolean) : []
  const keyList = Array.isArray(keys) ? keys.filter(Boolean) : []
  if (!list.length && !keyList.length) return null
  if (NATIVE) {
    try {
      const payload = list.length ? list : keyList
      const raw = window.BD2Native.nikkeUnpackPrioritize(S.rootId, JSON.stringify(payload), true)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }
  try {
    const res = await fetch('/api/nikke-ab/prioritize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: S.rootId, rels: list, keys: keyList, sibling: true }),
    })
    return await res.json()
  } catch { return null }
}

/** 从解包队列的 pendingRels 生成可点的占位卡（尚未解包完）。 */
function mergePendingUnpackPlaceholders(pendingRels) {
  if ((S.mode !== 'nikke' && S.mode !== 'jczx') || !Array.isArray(pendingRels) || !pendingRels.length) return
  const have = new Set(S.items.map(i => i.bundleRel || i.relAtlas || i.id))
  for (const rel of pendingRels) {
    const r = String(rel || '').replace(/\\/g, '/')
    if (!r || have.has(r)) continue
    const base = r.split('/').pop()
    S.items.push({
      id: 'pending:' + r,
      ok: false,
      pendingUnpack: true,
      bundleRel: r,
      base,
      folder: base,
      group: base,
      relAtlas: '',
      images: [],
      problems: [t('尚未解包')],
    })
    have.add(r)
  }
}

// 没被捕获的 Promise 异常也给出可读提示（不阻塞任何交互，9 秒自动消失）
window.addEventListener('unhandledrejection', e => {
  const r = e?.reason
  showError(t('后台任务出错：') + (r?.message || String(r)))
})

function hexToRgba(hex, alpha) {
  const h = (hex || '#1f2937').replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0').slice(0, 6)
  return '#' + full + (alpha || 'ff')
}

function download(blobOrUrl, filename) {
  if (NATIVE && typeof blobOrUrl !== 'string') { nativeSave(blobOrUrl, filename); return }
  if (NATIVE && blobOrUrl.startsWith('data:')) {
    // dataURL：转成 blob 再交给原生保存，避免走 a[download]
    fetch(blobOrUrl).then(r => r.blob()).then(b => nativeSave(b, filename))
    return
  }
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 4000)
}

function safeName(s) {
  return String(s || 'spine').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
}

/* ------------------------------------------------- 贴图预乘 alpha 补丁
 * BD2 的 atlas PNG 是直通 alpha。spine-player 的 premultipliedAlpha 只改混合方程，
 * 上传贴图时并不会预乘，因此 BD2 需要本补丁（UNPACK_PREMULTIPLY_ALPHA_WEBGL）。
 * NIKKE / JCZX 图集本身已是 PMA（atlas pma:true）—— 只能开混合、不能再 UNPACK，
 * 否则双预乘（眼睛/半透明发黑）。由 syncPremultiplyGl() 按 mode 决定是否挂补丁。
 */

let glPatchState = null           // 4.1 那份（保持原语义，别的地方可能读它）
const glPatchStates = new Map()   // 运行时对象 → 该套的 {proto,original,patched}

function makeGLTexturePatch(rt) {
  const proto = rt.GLTexture.prototype
  const original = proto.update
  const patched = function (useMipMaps) {
    const gl = this.context.gl
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    original.call(this, useMipMaps)
  }
  return { proto, original, patched }
}

function ensureGLTexturePatch() {
  if (!glPatchState) glPatchState = makeGLTexturePatch(SPINE_DEFAULT)
  return glPatchState
}

function applyGLTexturePatch(enabled) {
  // 两套运行时各有一份 GLTexture，只打一套的话切到另一代的资产就失效了
  // （NIKKE 用 4.0，BD2 用 4.1，同一目录里可能混着）。两套的 patched/original
  // 分开记，反复开关也不会把 patch 叠成两层。
  for (const rt of new Set([SPINE_DEFAULT, SPINE40, SPINE42].filter(Boolean))) {
    let st = glPatchStates.get(rt)
    if (!st) { st = makeGLTexturePatch(rt); glPatchStates.set(rt, st) }
    st.proto.update = enabled ? st.patched : st.original
  }
  glPatchState = glPatchStates.get(SPINE_DEFAULT)
}

/* ------------------------------------------------- 数据源：浏览器 / 原生 APK
 * 桌面版由本地 Node 服务提供 /api/* 与 /spine/*。
 * APK 版没有服务端：目录扫描与文件读取都由 Android 原生层做，
 * 结果通过 evaluateJavascript 推回来，资源仍走 /spine/<rootId>/<rel>
 * （由 WebView 的 shouldInterceptRequest 拦截后从磁盘读取）。
 */

const NATIVE = typeof window.BD2Native !== 'undefined' && !!window.BD2Native
/** UI / about version — keep in sync with package.json + Android versionName. */
const APP_VERSION = (NATIVE && window.BD2Native.appVersion)
  ? (window.BD2Native.appVersion() || '1.05')
  : '1.05'

const nativeWaiters = {}
function nativeAsk(kind, call, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    nativeWaiters[kind] = resolve
    const timer = setTimeout(() => {
      nativeWaiters[kind] = null
      reject(new Error(t('原生层无响应：') + kind))
    }, timeoutMs)
    nativeWaiters[kind + ':timer'] = timer
    try { call() } catch (e) { nativeWaiters[kind] = null; clearTimeout(timer); reject(e) }
  })
}
window.__native = {
  onRoots(payload) { const tm = nativeWaiters['roots:timer']; if (tm) clearTimeout(tm); nativeWaiters.roots?.(payload); nativeWaiters.roots = null },
  // 原生只回元信息（几十字节），items 由 scanPage 分页同步取。
  // 一次性推几 MB 的 JSON 给 evaluateJavascript 会把进程压崩。
  onScanMeta(payload) { const tm = nativeWaiters['scan:timer']; if (tm) clearTimeout(tm); nativeWaiters.scan?.(payload); nativeWaiters.scan = null },
  onError(msg) { showError(String(msg)) },
  onCrash(msg) { showError(t('上次运行崩溃了：\n') + String(msg).split('\n').slice(0, 6).join('\n')) },
  // 从系统权限设置页回到 App：权限可能刚开，重画目录提示并按需重扫
  onPermission() { refreshRootsAndRescan() },
}

/* 原生模式下把产出交回 Android 保存（WebView 里 a[download] 不会落盘） */
function nativeSave(blob, filename) {
  const reader = new FileReader()
  reader.onloadend = () => {
    const dataUrl = String(reader.result || '')
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    try {
      const ok = window.BD2Native.saveBlob(filename, base64)
      if (ok) window.BD2Native.toast(t('已保存：') + filename)
    } catch (e) { showError(t('保存失败：') + e.message) }
  }
  reader.onerror = () => showError(t('读取导出结果失败'))
  reader.readAsDataURL(blob)
}

/* ------------------------------------------------------------------ 启动 */

/** 深链参数 ?item=<键>；没有就返回 null */
function deepLinkItem() { return new URLSearchParams(location.search).get('item') }

/** 首次进入该落在哪一页：带 ?item= 深链 → 播放页，否则资产页。 */
function initialView() { return deepLinkItem() ? 'player' : 'grid' }

async function boot() {
  // 语言必须在**画第一帧之前**定下来，而且要比 applyTouchMode() 更早 ——
  // 那个函数里也有 t() 文案（空状态的副标题），晚了就会在英文界面上留下一句中文。
  LANG = loadLang()
  applyLang()
  $('setLang').value = LANG
  setupLangPicker()
  // 资产类型同样要在**首次扫描之前**定下来：scan() 会带着它去要数据，
  // 晚了第一次就会用 bd 的规则扫一遍 lostsword 的目录（结果是 0 个资产）。
  S.mode = loadMode()
  syncModeUI()
  // 需求 4：预乘默认随 mode；勾选框与 GL 补丁一并对齐
  applyPremultiplyForMode(S.mode)
  if (NATIVE) applyTouchMode()
  bindUI()
  // 首屏必须在**这里**同步定下来 —— 不能等 scan() 收尾。
  // 之前只有 scan() 末尾那一句 setView('grid')，于是每次启动都会先画一屏
  // 播放页布局（舞台 + 顶栏 + 底部标签），扫描结束再「啪」地跳到资产页；
  // 真机大目录扫描要几秒（实测 2753ms），用户每次都看得到这个闪变。
  // index.html 上的 <body class="view-grid"> 是同一结论的静态预置，
  // 让第一帧就是资产页；这里再对齐一次 JS 的 viewMode，并把「设置」入口摆对。
  setView(initialView())
  updateVolumeKeyHints()
  // 首次启动（从没选过语言）才弹一次。**故意不 await**：让扫描并行跑起来，
  // 用户点完语言时资产列表已经就绪，而不是干等两个来回。
  if (!langPicked()) askLanguage()
  await loadConfig()
  await scan(false)
}

/** 用户有没有主动选过语言。和 loadLang() 分开：
 *  loadLang() 负责「现在用哪种语言」（没选过就跟随系统），
 *  这个只负责「要不要弹询问框」—— 两件事，别混。 */
function langPicked() {
  try {
    const v = localStorage.getItem(LANG_KEY)
    return v === 'en' || v === 'zh'
  } catch { return false }
}

/** 首次语言询问：亮出弹窗并接管两个按钮 */
function askLanguage() {
  const modal = $('langModal')
  if (!modal) return
  modal.hidden = false
  for (const btn of modal.querySelectorAll('.lang-pick')) {
    btn.onclick = () => {
      saveLang(btn.dataset.lang)
      $('setLang').value = LANG
      modal.hidden = true
    }
  }
}

/** 设置里的语言下拉。切换立即生效并落盘（不需要点「完成」）。 */
function setupLangPicker() {
  const sel = $('setLang')
  if (sel) sel.onchange = () => saveLang(sel.value)
}

/* 手机上没有键盘：快捷键入口收起来，改用底部抽屉 + 大按钮的操作方式 */
function applyTouchMode() {
  document.body.classList.add('is-touch')
  const help = $('btnHelp')
  if (help) help.hidden = true
  // 「上传文件」只放进内存不落盘，手机上用「导入文件」（直接写进目录）就够了
  const up = $('btnUpload')
  if (up) up.hidden = true
  // 设置在底部标签里有入口，但平铺页没有标签栏 —— 具体露不露由
  // syncTouchSettingsEntry() 按当前视图决定，这里先按「播放页」的默认藏起来。
  const set = $('btnSettings')
  if (set) set.hidden = true
  // 全屏入口改成画面右上角的 ⛶ 图标，顶栏不再放文字按钮
  const fsTop = $('btnFullscreen')
  if (fsTop) fsTop.hidden = true
  // 平铺入口同理：手机上用画面左上角的 ⊞
  const gridTop = $('btnGrid')
  if (gridTop) gridTop.hidden = true
  const sub = document.querySelector('.empty-sub')
  if (sub) sub.textContent = t('点底部「资产」选一套，或用顶部「导入文件」把文件拷进来')
  detectScreenProfile()
  window.addEventListener('resize', scheduleScreenProfile)   // 旋转 / 分屏 / 折叠屏展开
  setupMobileShell()
}

/* resize 之后推迟一拍再测一次。
   实测（2026-09-25）：视口尺寸先变、screen.width/height 晚一点才跟上 ——
   CDP 的 Emulation.setDeviceMetricsOverride 就是这样，真机上旋转/折叠屏展开
   同理。只在 resize 那一刻测，会拿旧屏幕尺寸算出错误的 scr-tall，漏标整块布局。
   多测一次是幂等的，代价只有一次 getter 读取。 */
let screenProfileTimer = 0
function scheduleScreenProfile() {
  detectScreenProfile()
  clearTimeout(screenProfileTimer)
  screenProfileTimer = setTimeout(detectScreenProfile, 260)
}

/* 检测物理分辨率与屏幕比例，给 body 打标记类，CSS 据此做针对性布局：
     .scr-narrow  短边 < 400 或视口 < 420 —— 竖屏手机：全屏面板改底部全宽、顶栏紧凑
     .scr-tall    长:短 >= 1.95           —— 全面屏：顶栏给挖孔/刘海多让一截
   每次启动都现测（比"安装时"更准：旋转、分屏、折叠屏都能跟上）。 */
function detectScreenProfile() {
  const s = window.screen || {}
  const w = s.width || 0
  const h = s.height || 0
  const short = Math.min(w, h) || 0
  const long = Math.max(w, h)
  const ratio = short ? +(long / short).toFixed(2) : 0
  const cls = document.body.classList
  cls.toggle('scr-narrow', (short > 0 && short < 400) || window.innerWidth < 420)
  cls.toggle('scr-tall', short > 0 && ratio >= 1.95)
  return { w, h, ratio }
}

/* ------------------------------------------------- 手机端底部抽屉
   屏幕只有一列宽：左右两栏改成从底部升起的抽屉，底部标签切换，
   选中资产后自动收起，立刻就能看到动画。 */
let sheetOpen = ''

function setupMobileShell() {
  const tabs = $('mTabs')
  if (!tabs) return
  tabs.hidden = false
  const quick = $('mQuick')
  if (quick) quick.hidden = false
  const now = $('mNow')
  if (now) now.hidden = false

  tabs.querySelectorAll('.mtab').forEach(b => {
    b.onclick = () => {
      const name = b.dataset.sheet
      if (name === 'set') { $('settingsModal').hidden = false; return }
      toggleSheet(name)
    }
  })
  const scrim = $('sheetScrim')
  if (scrim) scrim.onclick = () => toggleSheet('')

  $('mPlay').onclick = () => setPlaying(!S.playing)
  // 这两个箭头切**资产**（上一个 / 下一个 L2D），不是逐帧步进 ——
  // 逐帧已经在播放页的 ◀│/│▶ 和键盘 ←/→ 上有了。
  // 和画面两侧的箭头分工是**对调过**的：手机上「换一套 L2D」比「换动作」少见，
  // 所以把大而易按的画面两侧箭头留给换动作（见 bindUI 里的 stagePrev/stageNext）。
  $('mBack').onclick = () => switchItem(-1)
  $('mFwd').onclick = () => switchItem(1)
  $('mReset').onclick = () => resetCamera()

  // 当前资产名：左侧栏收进抽屉后，舞台下方补一行。
  // 用 MutationObserver 跟着 #currentName 走，不必在每个赋值点都改一遍。
  if (now && window.MutationObserver) {
    const src = $('currentName')
    const mirror = () => { now.textContent = src.textContent }
    new MutationObserver(mirror).observe(src, { childList: true, characterData: true, subtree: true })
    mirror()
  }
}

function toggleSheet(name) {
  const left = document.querySelector('.side-left')
  const right = document.querySelector('.side-right')
  if (!left || !right) return
  // 再点一次同一个标签 = 收起
  if (name && name === sheetOpen) name = ''
  sheetOpen = name || ''

  left.classList.toggle('open', name === 'ctrl' || name === 'layer')
  right.classList.toggle('open', name === 'asset')

  if (name === 'ctrl' || name === 'layer') {
    const want = name === 'layer' ? 'layers' : 'controls'
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === want))
    $('paneControls').classList.toggle('hidden', want !== 'controls')
    $('paneLayers').classList.toggle('hidden', want !== 'layers')
  }
  const scrim = $('sheetScrim')
  if (scrim) scrim.hidden = !name
  document.querySelectorAll('.mtab').forEach(b => b.classList.toggle('active', b.dataset.sheet === name))
}

/** 选完资产收起抽屉，直接看动画 */
function closeSheet() { if (sheetOpen) toggleSheet('') }

/* ------------------------------------------------- 全屏（沉浸）模式
   进入后屏幕上只剩舞台：
     · 音量键（真机由 MainActivity 拦截后回调）/ ↑↓ 键：在同一个文件里切换动画
     · ☰ 拉出可收起的文件侧栏：换另一套 L2D，选完自动收起
     · 切换动画不会把缩放打回去 —— 见 refitBounds / currentZoomRatio */
let fsMode = false
let fsFilesOpen = false
let fsDimTimer = 0

function setupFullscreenUI() {
  if (!$('fsBar')) return
  $('fsFiles').onclick = () => toggleFsFiles()
  $('fsExit').onclick = () => setFullscreen(false)
  // 顶部 ◀▶：切换资产（上一个 / 下一个）
  $('fsPrevFile').onclick = () => switchItem(-1)
  $('fsNextFile').onclick = () => switchItem(1)
  // 底部 ◀▶：切换动画（音量键同款）
  $('fsPrevAnim').onclick = () => switchAnimation(-1)
  $('fsNextAnim').onclick = () => switchAnimation(1)
  const btn = $('btnFullscreen')
  if (btn) btn.onclick = () => setFullscreen(!fsMode)
  // 画面右上角的 ⛶ 图标：只作为手机端的全屏入口（桌面仍用顶栏按钮）
  const fab = $('stageFs')
  if (fab && document.body.classList.contains('is-touch')) {
    fab.hidden = false
    fab.onclick = () => setFullscreen(!fsMode)
  }
  // 画面左上角的 ⊞：回平铺页
  const gfab = $('stageGrid')
  if (gfab && document.body.classList.contains('is-touch')) {
    gfab.hidden = false
    gfab.onclick = () => setView('grid')
  }
  // 隐藏界面：全屏时只看画面
  const hide = $('fsHide')
  if (hide) hide.onclick = () => setCleanUI(!cleanUI)

  // 蒙版：抽屉状态下点空白收起
  $('sheetScrim').addEventListener('click', () => { if (fsMode) toggleFsFiles(false) })
  $('stageInner').addEventListener('pointerdown', () => { if (cleanUI) revealCleanUI(); else wakeFsBar() })

  // 双击定点放大（全屏里最常用，播放页也顺手支持）
  setupDoubleTapZoom()

  // 桌面浏览器按 ESC / F11 退出真·全屏时，同步收起沉浸布局
  document.addEventListener('fullscreenchange', () => {
    if (fsMode && !document.fullscreenElement && !NATIVE) setFullscreen(false)
  })
}

function setFullscreen(on) {
  on = !!on
  if (on === fsMode) return
  fsMode = on
  document.body.classList.toggle('is-immersive', on)
  $('fsBar').hidden = !on
  const animBar = $('fsAnimBar')
  if (animBar) {
    animBar.hidden = !on
    animBar.classList.remove('dim')
  }
  if (on) {
    closeSheet()
    updateFsLabels()
    wakeFsBar()
    toast(t('◀▶ 切资产 · 音量键切动画 · ☰ 换文件 · ✕ 退出'))
    try { window.BD2Native.setFullscreen(true) } catch { /* 桌面版没有这个口 */ }
    if (!NATIVE && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      try { document.documentElement.requestFullscreen().catch(() => {}) } catch { /* ignore */ }
    }
  } else {
    toggleFsFiles(false)
    $('fsBar').classList.remove('dim')
    clearTimeout(fsDimTimer)
    if (cleanUI) setCleanUI(false)      // 退出全屏时把「隐藏界面」一起复位
    try { window.BD2Native.setFullscreen(false) } catch { /* ignore */ }
    if (!NATIVE && document.fullscreenElement && document.exitFullscreen) {
      try { document.exitFullscreen().catch(() => {}) } catch { /* ignore */ }
    }
  }
  // 舞台尺寸变了：等布局落定后按新视口重算，并保持用户当前的缩放比例
  requestAnimationFrame(() => requestAnimationFrame(onStageResize))
}

/** 全屏下的文件侧栏（右侧滑出） */
function toggleFsFiles(force) {
  const want = typeof force === 'boolean' ? force : !fsFilesOpen
  fsFilesOpen = want
  const right = document.querySelector('.side-right')
  if (right) right.classList.toggle('fs-open', want)
  const scrim = $('sheetScrim')
  if (scrim) scrim.hidden = !(want || sheetOpen)
  // 文件面板开着时收起底部动画条，别盖住列表
  const animBar = $('fsAnimBar')
  if (animBar && fsMode) animBar.hidden = want
  if (want) { refreshLists(); wakeFsBar() }
}

/** 音量上键的实际方向：+1 = 下一个（默认），-1 = 上一个（设置里可换） */
function volDirMul() { return S.volDir === 'prev' ? -1 : 1 }

/** 设置变化后同步全屏条上的提示文案 */
function updateVolumeKeyHints() {
  const prev = $('fsPrevAnim'), next = $('fsNextAnim')
  if (prev) prev.title = t(volDirMul() === -1 ? '音量+：上一个动画' : '音量−：上一个动画')
  if (next) next.title = t(volDirMul() === -1 ? '音量−：下一个动画' : '音量+：下一个动画')
}

/** dir: +1 下一个动画，-1 上一个；到头循环。
 *  调用方：播放页画面两侧箭头、全屏底部 ◀▶、键盘 ↑↓ 与 [ ]、真机音量键。 */
function switchAnimation(dir) {
  if (S.current && S.current.imageOnly) {
    cycleStillImage(dir)
    return
  }
  if (!S.animations.length) return
  const cur = currentAnimation()?.name
  let i = S.animations.indexOf(cur)
  i = i < 0 ? 0 : (i + dir + S.animations.length) % S.animations.length
  const name = S.animations[i]
  if (!name) return
  playAnimation(name)
  // 隐藏界面（只看画面）时别弹 toast：内容和底栏一样，看起来像控件又露出来了
  if (!cleanUI) toast(`${name}　${i + 1}/${S.animations.length}`)
}

/** 全局轻提示（保存顺序 / 删除资产 / 切资产 / 缩放倍数都走它）。
 *  原先叫 showFsToast、还包了一层同义的 notice()，名字把作用域说小了 ——
 *  它其实在全屏和平铺页都在用，所以收敛成这一个名字。 */
function toast(text) {
  // 局部变量别叫 t：全局 t() 是翻译函数，同作用域既声明又调用会炸 TDZ（已炸过两次）
  const el = $('toast')
  if (!el) return
  el.textContent = text
  el.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { el.hidden = true }, 1400)
}

function updateFsLabels() {
  const file = $('fsFile')
  const anim = $('fsAnim')
  if (!file || !anim) return
  file.textContent = S.current?.folder || t('未载入')
  const a = currentAnimation()?.name
  const i = a ? S.animations.indexOf(a) : -1
  anim.textContent = a ? `${a}　${i + 1}/${S.animations.length}` : '—'
}

/** 顶部条/底部条静置几秒一起淡出，点一下画面回来 */
function wakeFsBar() {
  const bar = $('fsBar')
  const animBar = $('fsAnimBar')
  if (!bar) return
  bar.classList.remove('dim')
  if (animBar) animBar.classList.remove('dim')
  clearTimeout(fsDimTimer)
  fsDimTimer = setTimeout(() => {
    if (!fsMode) return
    bar.classList.add('dim')
    if (animBar) animBar.classList.add('dim')
  }, 4000)
}

/* ------------------------------------------------- 全屏：隐藏界面（只看画面） */

let cleanUI = false
let cleanRevealTimer = 0

function setCleanUI(on) {
  on = !!on
  if (on === cleanUI) return
  cleanUI = on
  document.body.classList.toggle('is-cleanui', cleanUI)
  if (!cleanUI) {
    document.body.classList.remove('fs-reveal')
    clearTimeout(cleanRevealTimer)
  }
  const btn = $('fsHide')
  if (btn) btn.title = t(cleanUI ? '显示界面' : '隐藏界面（只看画面）')
  toast(t(cleanUI ? '已隐藏界面 · 点画面可临时唤出' : '界面已恢复'))
  if (!cleanUI) wakeFsBar()
}

/** 隐藏界面状态下点画面：把操作条临时唤出来 4 秒 */
function revealCleanUI() {
  if (!cleanUI) return
  document.body.classList.add('fs-reveal')
  clearTimeout(cleanRevealTimer)
  cleanRevealTimer = setTimeout(() => document.body.classList.remove('fs-reveal'), 4000)
}

/* ------------------------------------------------- 全屏：双击定点放大
   双击哪里就以哪里为中心逐档放大（连按会一直放大，到顶档再双击才还原）。
   锚点用归一化坐标算：要让屏幕点 P 下面的世界坐标在缩放前后保持不动。 */

let lastTap = { t: 0, x: 0, y: 0 }
let zoomAnim = 0

function setupDoubleTapZoom() {
  const host = $('stageInner')
  if (!host) return
  host.addEventListener('pointerdown', e => {
    if (!e.isPrimary || !S.player || !S.camera) return
    const now = performance.now()
    const near = Math.abs(e.clientX - lastTap.x) < 30 && Math.abs(e.clientY - lastTap.y) < 30
    if (now - lastTap.t < 340 && near) {
      lastTap.t = 0
      doubleTapZoom(e.clientX, e.clientY)
      e.preventDefault()
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY }
    }
  }, { passive: false })
}

/** 把相机 viewport 同步成渲染器的真实尺寸。全屏切换/转屏后 S.defaultZoom 可能还是
 *  旧视口算出来的，双击缩放前必须先按当前画布重算，否则「还原」会落空到偏小的一档。 */
function syncCameraViewport() {
  const p = S.player, cam = S.camera
  if (!p || !cam) return
  try { p.sceneRenderer.resize(1) } catch { /* ignore */ }
  const rc = p.sceneRenderer.camera
  cam.viewportWidth = rc.viewportWidth
  cam.viewportHeight = rc.viewportHeight
}

/** 双击放大的档位：每次双击往上走一档，到顶档再双击才还原。
 *  不能写成「放大 / 还原」的二值开关 —— 那样第二下就弹回去了。
 *  顶档取 12.4（约等于旧 UI 按钮/夹取上限 1/0.08=12.5×）作为双击阶梯的终点；
 *  双指捏合仍可越过此档——切动画 / 转屏时必须按真实比例保留，不能再夹回 12.5×。 */
const ZOOM_LADDER = [2.6, 6.8, 12.4]
const ZOOM_TOP = ZOOM_LADDER[ZOOM_LADDER.length - 1]

/** 双击：以点击处为锚点，沿 ZOOM_LADDER 逐档放大；已经是顶档才还原到铺满。
 *  注意相机的方向：cam.zoom 越小画面越放大（currentZoomRatio = cam.zoom / fit），
 *  所以「放大」是除以倍数，不是乘。 */
function doubleTapZoom(clientX, clientY) {
  const p = S.player, cam = S.camera
  if (!p || !cam || !S.bounds) return
  syncCameraViewport()
  const ratio = currentZoomRatio()
  const fit = defaultZoomFor(Math.max(cam.viewportWidth, 1), Math.max(cam.viewportHeight, 1))
  const factor = ratio > 0 ? 1 / ratio : 1     // 相对「铺满」当前放大了几倍

  // 到顶（或已经超出可读范围）→ 还原
  if (factor >= ZOOM_TOP * 0.9) { fitToWindow(); toast(t('已还原')); return }

  // 留 15% 余量：手抖掉一点缩放不该让档位判定来回跳
  const step = ZOOM_LADDER.find(s => s > factor * 1.15) || ZOOM_TOP

  // 锚点：点击处对应的世界坐标（screenToWorld 里算过同样的归一化坐标）
  const world = screenToWorld(clientX, clientY)
  if (!world) { fitToWindow(); return }
  const target = fit / step
  const vw = Math.max(cam.viewportWidth, 1), vh = Math.max(cam.viewportHeight, 1)
  animateCamera({
    x: world.x - world.nx * target * vw / 2,
    y: world.y - world.ny * target * vh / 2,
    z: target,
  }, world)
  toast(t('放大 ×{step}', { step: step < 10 ? step.toFixed(1) : Math.round(step) }))
}

/** 相机从当前位置缓动到目标（约 200ms），到位后刷新调试信息 */
function animateCamera(to, anchor) {
  const p = S.player, cam = S.camera
  if (!p || !cam) return
  const from = { x: cam.position.x, y: cam.position.y, z: cam.zoom }
  const t0 = performance.now()
  const dur = 200
  cancelAnimationFrame(zoomAnim)
  const step = () => {
    const k = clamp((performance.now() - t0) / dur, 0, 1)
    const e = 1 - Math.pow(1 - k, 3)          // easeOutCubic
    // 夹取范围按「起点↔目标」取，不用全局记录值：视口刚变过时记录值可能偏大，
    // 会把合法的放大目标裁掉。
    const zmin = Math.min(from.z, to.z) * 0.5
    const zmax = Math.max(from.z, to.z) * 2
    cam.zoom = clamp(from.z + (to.z - from.z) * e, zmin, zmax)
    cam.position.x = from.x + (to.x - from.x) * e
    cam.position.y = from.y + (to.y - from.y) * e
    cam.update()
    p.drawFrame(false)
    if (k < 1) zoomAnim = requestAnimationFrame(step)
    else debugDump()
  }
  zoomAnim = requestAnimationFrame(step)
}

/**
 * 切上一个 / 下一个资产 —— **全项目唯一的资产导航入口**。
 * 调用方：播放页底部 ◀◀/▶▶、全屏顶部 ◀▶、拖到底后的自动续播。
 * 之前只有全屏那条路在用它，别处各写一遍（画面上就没有可点的入口了）。
 *
 * 顺序口径和左侧资产列表、平铺页完全一致（都走 filteredItems → orderedList），
 * 所以「列表里下一个」和「点箭头下一个」永远指同一个资产。到头循环。
 *
 * @param {number} dir +1 下一个，-1 上一个
 */
function switchItem(dir) {
  const list = filteredItems()
  if (!list.length) return
  const cur = S.current ? itemKey(S.current) : null
  let i = list.findIndex(x => itemKey(x) === cur)
  i = i < 0 ? 0 : (i + dir + list.length) % list.length
  const item = list[i]
  if (!item || itemKey(item) === cur) return
  selectItem(item)
  // 隐藏界面模式下别用 toast 当「顶栏替代品」，否则看起来像 chrome 又回来了
  if (!cleanUI) toast(`${item.folder}　${i + 1}/${list.length}`)
  syncStageNav()
}

/** 播放页左右箭头的显隐：**当前资产有没有第二个动画可切**。
 *  （它俩切的是动画，所以这里的条件必须看 S.animations ——
 *    早先跟着「可见资产数」走，是照着「箭头切资产」写的，对调后就成了错的：
 *    单动画但多资产的目录会亮出一对点了没反应的箭头。）
 *  只在动画列表变化时调用：onLoaded()（载入完成）、resetMeta()（清空换资产）。
 *  有没有动画是**数据**条件，所以类名挂 body、显不显由 CSS 定（ARCHITECTURE.md R1）。 */
function syncStageNav() {
  document.body.classList.toggle('stage-nav-avail', S.animations.length > 1)
}

async function loadConfig() {
  if (NATIVE) {
    try {
      const res = await fetch('/api/config')
      if (res.ok) S.config = await res.json()
      else S.config = { roots: [], host: '', port: 0, maxDepth: 5 }
    } catch { S.config = { roots: [], host: '', port: 0, maxDepth: 5 } }
    S.config.roots = await nativeAsk('roots', () => window.BD2Native.requestRoots(), 15000)
  } else {
    try {
      const res = await fetch('/api/config')
      S.config = await res.json()
    } catch (err) {
      showError(t('无法连接本地服务：') + err.message)
      return
    }
  }
  if (NATIVE) {
    const dir = nativeDefaultPath()
    const base = dir
      ? t('文件目录：{path}', { path: dir })
      : t('APK 模式 · 从手机存储读取 · 扫描深度 {depth}', { depth: S.config.maxDepth || 6 })
    $('envInfo').textContent = base + ' · v' + APP_VERSION
  } else {
    $('envInfo').textContent = t('本地服务 {host}:{port} · 扫描深度 {depth}', {
      host: S.config.host, port: S.config.port, depth: S.config.maxDepth,
    }) + ' · v' + APP_VERSION
  }
  renderRootOptions()
  renderStorageBar()
}

function nativeDefaultPath() {
  try { return window.BD2Native.defaultPath ? window.BD2Native.defaultPath() : '' }
  catch { return '' }
}

/**
 * 目录下拉。
 *
 * `data-i18n-keep` 协议（R11.1）：有两类中文**本来就不该翻译** ——
 *   ① **用户数据**：根目录名（"手机存储 /BD2Viewer"）是系统/用户给的名字，翻译它是错的；
 *   ② **专名/自称**：语言选择器里的「中文」，英文界面下也必须写「中文」。
 * 打上这个属性只是**做标记、不改内容**，用途是让「英文界面不许残留中文」的测试
 * 能区分「漏包 t()」和「本来就该是中文」。静态的那批（语言选择器）直接写在
 * index.html 的属性上，JS 生成的（就是这里的 option）就地打标。
 */
function renderRootOptions() {
  const sel = $('rootSelect')
  sel.innerHTML = ''
  for (const r of S.config.roots) {
    const opt = document.createElement('option')
    opt.value = r.id
    // r.label 是**用户/系统给的目录名**（"手机存储 /BD2Viewer"），属于数据不是文案，
    // 不翻译；只有「（不存在）」这个后缀是界面文案。就地打 keep 标记（R11.1）。
    opt.textContent = r.label + (r.exists === false ? t('（不存在）') : '')
    opt.dataset.i18nKeep = ''
    sel.appendChild(opt)
  }
  if (!S.config.roots.length) {
    const opt = document.createElement('option')
    opt.textContent = t(NATIVE ? '（目录还没建好）' : '（未配置目录）')
    opt.dataset.i18nKeep = ''
    sel.appendChild(opt)
  }
  if (S.rootId == null) {
    // APK 里默认读外部存储根目录（文件管理器放得进去），拿不到才退回 App 专属目录
    const auto = S.config.roots.find(r => r.id === '__public__')
      || S.config.roots.find(r => r.id === '__default__')
    S.rootId = (auto || S.config.roots[0])?.id || null
  }
  sel.value = S.rootId || ''
  syncRemoveRootBtn()
}

/** 只刷新目录下拉，不打断当前播放 */
async function refreshRoots() {
  if (!NATIVE) return
  try {
    S.config.roots = await nativeAsk('roots', () => window.BD2Native.requestRoots(), 15000)
    renderRootOptions()
  } catch { /* 保持原样 */ }
}

/**
 * 从系统权限设置页回来时用：外部目录可能刚刚可用，
 * 那就把默认目录切到外部并重新扫一遍，省得用户自己点。
 */
async function refreshRootsAndRescan() {
  if (!NATIVE) return
  const before = S.rootId
  await refreshRoots()
  renderStorageBar()
  const auto = S.config.roots.find(r => r.id === '__public__')
    || S.config.roots.find(r => r.id === '__default__')
  const want = (auto || S.config.roots[0])?.id || null
  if (want && want !== before) {
    S.rootId = want
    const sel = $('rootSelect')
    if (sel) sel.value = want
    await scan(true)
  }
}

function nativeStorageStatus() {
  try {
    return JSON.parse(window.BD2Native.storageStatus ? window.BD2Native.storageStatus() : '{}')
  } catch { return {} }
}

/**
 * APK 模式的目录/权限信息。手机端不再在首页占一整条：
 * 内容整体搬进「设置 → 文件目录」，首页只留舞台。
 * 桌面原生模式（基本用不到）仍走顶部状态条。
 */
function renderStorageBar() {
  const bar = $('storageBar')
  if (!bar) return
  if (!NATIVE) { bar.hidden = true; return }
  const st = nativeStorageStatus()
  if (document.body.classList.contains('is-touch')) {
    renderStorageSettings(st)
    bar.hidden = true
    return
  }
  bar.hidden = false
  bar.innerHTML = ''

  const path = document.createElement('span')
  path.className = 'sb-path'
  path.textContent = st.defaultDir
    ? t('读取目录：{dir}', { dir: st.defaultDir })
    : t('读取目录：创建失败')
  bar.appendChild(path)

  const btn = (text, title, fn) => {
    const b = document.createElement('button')
    b.className = 'btn tiny'
    b.textContent = t(text)
    b.title = t(title)
    b.onclick = fn
    bar.appendChild(b)
  }

  btn('复制路径', '复制目录路径，可粘贴到文件管理器', () => {
    try { window.BD2Native.copyText(st.defaultDir || '') } catch { /* ignore */ }
  })
  btn('授权文件夹', '用系统文件夹选择器授权一个目录，直接读取不用拷贝文件', () => {
    try { window.BD2Native.pickFolder() } catch (e) { showError(t('打不开文件夹选择器：') + e.message) }
  })

  // 说明文字与「去开启」按钮跟手机设置页共用一份（见 storageHint）
  const hint = storageHint(st)
  for (const a of hint.actions) btn(a.text, a.title, a.fn)
  const tip = document.createElement('div')
  tip.className = 'sb-tip'
  tip.textContent = hint.tip
  bar.appendChild(tip)
}

/** 手机端：目录/权限信息渲染进「设置 → 文件目录」，含路径、操作按钮和说明 */
/**
 * 手机端存储状态说明：**唯一一份文案来源**。
 *
 * 桌面状态条（renderStorageBar）和手机设置页（renderStorageSettings）原本各写了一
 * 遍同样的三条提示，改一处忘一处 —— 加语言时这种重复立刻变成两倍翻译成本，
 * 而且很容易只改了一边（英文界面漏出中文）。现在两边都调这个函数。
 *
 * 返回 { tip, actions }：tip 是说明文字，actions 是只在这种状态下该出现的按钮。
 */
function storageHint(st) {
  if (st.defaultIsPublic) {
    return {
      tip: t('按当前模式读 BD2Viewer 下对应子目录（bd2 / nikke / lostsword）。用「文件管理」把 .atlas + .json/.skel + .png 拷进这个目录（每套一个子文件夹），') +
        t('回来点顶栏「重新扫描」就能看到；懒得找目录就用「导入文件」直接选文件。'),
      actions: [],
    }
  }
  if (!st.allFilesAccess) {
    return {
      tip: t('外部目录 {path} 用不了：Android {sdk}+ 的分区存储不允许 App 在手机存储根目录建目录或读文件，', { path: st.publicPath, sdk: st.sdk || 11 }) +
        t('现在读的是 App 专属目录（文件管理器进不去）。想在手机存储里直接放文件就点「去开启」') +
        t('（系统设置里叫「所有文件访问权限」）；不想开权限，用顶栏「导入文件」把文件拷进来。'),
      actions: [{
        text: '去开启',
        title: '跳到系统设置页，开启「所有文件访问权限」',
        fn: () => {
          try { window.BD2Native.requestAllFilesAccess() } catch { /* ignore */ }
          setTimeout(() => { refreshRootsAndRescan() }, 8000)   // 从设置页回来后再刷一次
        },
      }],
    }
  }
  return {
    tip: t('已开启全部文件访问，但 {path} 仍不可用：{reason}。', { path: st.publicPath, reason: st.publicReason || t('未知原因') }) +
      t('可用顶栏「导入文件」拷进当前目录。'),
    actions: [],
  }
}

/** 手机端：目录/权限信息渲染进「设置 → 文件目录」，含路径、操作按钮和说明 */
function renderStorageSettings(st) {
  const box = $('setStorage')
  if (!box) return
  box.hidden = false
  const path = $('setStoragePath')
  if (path) path.textContent = st.defaultDir
    ? t('读取目录：{dir}', { dir: st.defaultDir })
    : t('读取目录：创建失败')
  const tip = $('setStorageTip')
  const actions = $('setStorageActions')
  if (actions) actions.innerHTML = ''

  const addBtn = (text, title, fn) => {
    const b = document.createElement('button')
    b.className = 'btn tiny'
    b.textContent = t(text)
    b.title = t(title)
    b.onclick = fn
    if (actions) actions.appendChild(b)
    return b
  }

  addBtn('复制路径', '复制目录路径，可粘贴到文件管理器', () => {
    try { window.BD2Native.copyText(st.defaultDir || '') } catch { /* ignore */ }
  })
  addBtn('授权文件夹', '用系统文件夹选择器授权一个目录，直接读取不用拷贝文件', () => {
    try { window.BD2Native.pickFolder() } catch (e) { showError(t('打不开文件夹选择器：') + e.message) }
  })

  const hint = storageHint(st)
  for (const a of hint.actions) addBtn(a.text, a.title, a.fn)
  if (tip) tip.textContent = hint.tip
}

/* 扫描代次：只有**最后一次**发出的扫描允许把结果写进状态。
   两次扫描重叠时（快速连点两个根目录、一边刷新一边切资产类型）网络回来的顺序不保证，
   「谁后回来谁生效」会让 S.rootPath 与 S.rootId 对不上 —— 卡片菜单里的「复制路径」
   会拿旧根的路径去拼新资产的相对路径，拼出一条根本不存在的路径（R15 的反面）。
   过期的结果整包丢弃：不写 items、不写 rootPath、不更新计数、连错误提示都不弹，
   也不去关 spinner（那是新一轮在用的）。 */
let scanSeq = 0

/* ---------------- NIKKE mod 包解包进度（需求 1+2：优先级队列 + 真实进度条） ----------------
   解包在后台以包级并发 ≤ 10 跑；前端：
   · 常驻细进度条（done/total + 当前包名）
   · 轻量轮询 /api/nikke-ab/progress（不必每次整页重扫）
   · 每隔几轮再 force scan，把新解出的资产拼进列表
   · 点开尚未解包的占位卡 → prioritize 抬到队首 → 等它解完再播 */
let nikkePollGen = 0
let nikkePollTries = 0
let nikkeAbPrev = null
let nikkeErrShown = false
let nikkeUngatedShown = false
// 后台解包期间想重扫、但用户正停在播放页：先记着，回平铺页再扫。
// 不这样做的话，全屏「扫描中…」会一遍遍盖在正在看的动画上（2026-10-01 用户截图）。
let unpackRescanNeeded = false
const NIKKE_POLL_MS = 400
const NIKKE_POLL_MAX = 3000         // ≈20 分钟（0.4s 间隔）
const NIKKE_RESCAN_EVERY = 8       // 兜底：即使 done 未变也偶尔扫一次（防漏）
let nikkeLastScannedDone = -1

function handleNikkeAbMeta(meta) {
  if (!meta || !meta.found) {
    setUnpackProgress(null)
    return
  }
  const done = meta.done != null ? meta.done : ((meta.reused || 0) + (meta.extracted || 0)
    + (meta.failed || 0) + (meta.skippedNoSpine || 0))
  const playableDone = meta.playableDone != null ? meta.playableDone
    : ((meta.reused || 0) + (meta.extracted || 0))
  const prev = nikkeAbPrev
  nikkeAbPrev = meta
  setUnpackProgress(meta)
  mergePendingUnpackPlaceholders([...(meta.pendingRels || []), ...(meta.currentRels || [])])

  if (meta.errors && meta.errors.length && !nikkeErrShown) {
    nikkeErrShown = true
    const e = meta.errors[0]
    toast(t('NIKKE 解包出错：{msg}', { msg: String(e.err || e.error || e).slice(0, 120) }))
  }
  if (meta.ungated > 0 && !nikkeUngatedShown) {
    nikkeUngatedShown = true
    toast(t('有 {n} 个包的贴图可能不准（压缩/流式贴图），建议在 PC 端解包后把产物拷到手机', { n: meta.ungated }))
  }

  const left = (meta.pending || 0) + (meta.inFlight || 0)
  const busy = left > 0
  if (busy) {
    const el = $('assetCount')
    if (el && !/\u89e3\u5305/.test(el.textContent) && !/unpack/i.test(el.textContent)) {
      el.textContent += ' · ' + t('包处理中 {done}/{total}', { done, total: meta.total || meta.found })
    }
    if (!prev || !(prev.pending > 0 || prev.inFlight > 0)) {
      toast(t('正在解包 NIKKE 资产包：已就绪 {done} 套，后台还在处理 {left} 个…',
        { done: playableDone, left }))
    }
    if (S.mode === 'nikke') {
      nikkePollTries = (!prev || !(prev.pending > 0 || prev.inFlight > 0)) ? 0 : nikkePollTries
      scheduleNikkePoll()
    }
  } else {
    if (prev && (prev.pending > 0 || prev.inFlight > 0)) {
      toast(t('NIKKE 资产解包完成：{done} 套可播放', { done: playableDone }))
    }
    setUnpackProgress(null)
    nikkePollGen++
    nikkePollTries = 0
  }
}

function scheduleNikkePoll() {
  if (nikkePollTries >= NIKKE_POLL_MAX) {
    if (nikkePollTries === NIKKE_POLL_MAX) {
      nikkePollTries++
      toast(t('NIKKE 资产包仍在后台解包，稍后点「重新扫描」查看'))
    }
    return
  }
  const gen = ++nikkePollGen
  nikkePollTries++
  setTimeout(async () => {
    if (gen !== nikkePollGen) return
    if (S.mode !== 'nikke') return
    const prog = await fetchNikkeProgress()
    if (prog && prog.found) {
      setUnpackProgress(prog)
      nikkeAbPrev = prog
      mergePendingUnpackPlaceholders([...(prog.pendingRels || []), ...(prog.currentRels || [])])
      if (viewMode === 'grid') refreshLists()
      const done = prog.done != null ? prog.done : ((prog.reused || 0) + (prog.extracted || 0)
        + (prog.failed || 0) + (prog.skippedNoSpine || 0))
      const busy = (prog.pending > 0) || (prog.inFlight > 0)
      if (!busy) {
        handleNikkeAbMeta(prog)
        nikkeLastScannedDone = done
        // 播放页不打扰：解包全部完成后也等回平铺页再扫（否则全屏遮罩盖住正在看的动画）
        if (!S.busy && viewMode === 'grid') scan(true)
        else if (viewMode !== 'grid') unpackRescanNeeded = true
        return
      }
      // done 增加才 force scan（避免每次轮询都 prepare+walk 全库）；偶发兜底防漏
      const shouldScan = (done > nikkeLastScannedDone) || (nikkePollTries % NIKKE_RESCAN_EVERY === 0)
      if (shouldScan && !S.busy) {
        if (viewMode !== 'grid') {
          unpackRescanNeeded = true      // 回平铺页再扫，nikkeLastScannedDone 保持不动
        } else {
          nikkeLastScannedDone = done
          await scan(true)
        }
      }
    }
    scheduleNikkePoll()
  }, NIKKE_POLL_MS)
}


/* ---------------- JCZX 解包进度（与 NIKKE 同模型：并发队列 + 轮询重扫） ---------------- */
let jczxPollGen = 0
let jczxPollTries = 0
let jczxPrev = null
let jczxErrShown = false
const JCZX_POLL_MS = 400
const JCZX_POLL_MAX = 3000
const JCZX_RESCAN_EVERY = 8
let jczxLastScannedDone = -1

function handleJczxMeta(meta) {
  if (!meta) { setUnpackProgress(null); return }
  const done = meta.done != null ? meta.done
    : ((meta.reusedCount || 0) + (meta.extractedCount || 0)
      + (meta.failed || 0) + (meta.skippedNoSpine || 0)
      || ((Array.isArray(meta.reused) ? meta.reused.length : 0)
        + (Array.isArray(meta.extracted) ? meta.extracted.length : 0)))
  const playableDone = meta.playableDone != null ? meta.playableDone
    : ((meta.reusedCount || 0) + (meta.extractedCount || 0)
      || ((Array.isArray(meta.reused) ? meta.reused.length : 0)
        + (Array.isArray(meta.extracted) ? meta.extracted.length : 0)))
  const total = meta.total || meta.found || meta.bundles || 0
  const prev = jczxPrev
  jczxPrev = meta
  mergePendingUnpackPlaceholders([...(meta.pendingRels || []), ...(meta.currentRels || [])])

  if (meta.setup && meta.setup.message) {
    if (meta.setup.ok) toast(meta.setup.message)
    else toast(t('JCZX 环境未就绪：{msg}', { msg: meta.setup.message }))
  }
  if (meta.errors && meta.errors.length) {
    for (const e of meta.errors) {
      logError('jczx ' + (e.rel || e.name || '') + ' ' + (e.error || e.err || JSON.stringify(e)))
    }
  }
  if (meta.errors && meta.errors.length && !jczxErrShown && !(meta.setup && meta.setup.message)) {
    jczxErrShown = true
    toast(t('JCZX 提取失败：{msg}', { msg: meta.errors[0].error || String(meta.errors.length) }))
  }

  const left = (meta.pending || 0) + (meta.inFlight || 0)
  // 仅看队列是否空闲：失败/跳过计入 done 后也不再靠 done<total 卡住 toast
  const busy = left > 0
  if (busy) {
    setUnpackProgress({
      done, total: total || Math.max(done, 1),
      current: meta.current, pending: meta.pending, inFlight: meta.inFlight,
      failed: meta.failed, skippedNoSpine: meta.skippedNoSpine,
      playableDone, packProgress: true,
    })
    const el = $('assetCount')
    if (el && !/\u89e3\u5305/.test(el.textContent) && !/unpack/i.test(el.textContent)) {
      el.textContent += ' · ' + t('包处理中 {done}/{total}', { done, total: total || '?' })
    }
    if (!prev || !(prev.pending > 0 || prev.inFlight > 0)) {
      toast(t('正在解包 JCZX 资产：已就绪 {done} 套，后台还在处理 {left} 个…',
        { done: playableDone, left }))
    }
    if (S.mode === 'jczx') {
      jczxPollTries = (!prev || !(prev.pending > 0 || prev.inFlight > 0)) ? 0 : jczxPollTries
      scheduleJczxPoll()
    }
  } else {
    setUnpackProgress(null)
    if (prev && (prev.pending > 0 || prev.inFlight > 0)) {
      toast(t('JCZX 提取完成：{done} 套可播放', { done: playableDone }))
    } else if ((Array.isArray(meta.extracted) && meta.extracted.length)
      || (Array.isArray(meta.reused) && meta.reused.length)) {
      const n = (meta.extracted || []).length
      const m = (meta.reused || []).length
      if (n || m) toast(t('JCZX 提取：新建 {n}，复用 {m}', { n, m }))
    }
    jczxPollGen++
    jczxPollTries = 0
  }
}

async function fetchJczxProgress() {
  try {
    if (NATIVE) {
      const raw = window.BD2Native.jczxUnpackProgress(S.rootId)
      return raw ? JSON.parse(raw) : null
    }
    const res = await fetch(`/api/jczx/progress?root=${encodeURIComponent(S.rootId)}`)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

function scheduleJczxPoll() {
  if (jczxPollTries >= JCZX_POLL_MAX) {
    if (jczxPollTries === JCZX_POLL_MAX) {
      jczxPollTries++
      toast(t('JCZX 资产仍在后台解包，稍后点「重新扫描」查看'))
    }
    return
  }
  const gen = ++jczxPollGen
  jczxPollTries++
  setTimeout(async () => {
    if (gen !== jczxPollGen) return
    if (S.mode !== 'jczx') return
    const prog = await fetchJczxProgress()
    if (prog && (prog.found || prog.bundles)) {
      const done = prog.done != null ? prog.done : ((prog.reusedCount || 0) + (prog.extractedCount || 0)
        + (prog.failed || 0) + (prog.skippedNoSpine || 0))
      setUnpackProgress({
        done,
        total: prog.total || prog.found || prog.bundles || 1,
        current: prog.current, pending: prog.pending, inFlight: prog.inFlight,
        failed: prog.failed, skippedNoSpine: prog.skippedNoSpine,
        playableDone: prog.playableDone, packProgress: true,
      })
      jczxPrev = prog
      mergePendingUnpackPlaceholders([...(prog.pendingRels || []), ...(prog.currentRels || [])])
      if (viewMode === 'grid') refreshLists()
      const busy = (prog.pending > 0) || (prog.inFlight > 0)
      if (!busy) {
        handleJczxMeta(prog)
        jczxLastScannedDone = done
        if (!S.busy && viewMode === 'grid') scan(true)
        else if (viewMode !== 'grid') unpackRescanNeeded = true
        return
      }
      const shouldScan = (done > jczxLastScannedDone) || (jczxPollTries % JCZX_RESCAN_EVERY === 0)
      if (shouldScan && !S.busy) {
        if (viewMode !== 'grid') {
          unpackRescanNeeded = true
        } else {
          jczxLastScannedDone = done
          await scan(true)
        }
      }
    }
    scheduleJczxPoll()
  }, JCZX_POLL_MS)
}

async function scan(force) {
  const seq = ++scanSeq
  if (!S.rootId) {
    S.items = []
    refreshLists()
    return
  }
  setBusy(true, S.mode === 'jczx' ? t('正在提取 JCZX 资产…') : t('扫描中…'))
  setScanProgress(true, S.mode === 'jczx' ? t('正在提取 JCZX 资产…') : t('扫描中…'))
  // 先清掉：换了目录 / 扫描失败时不能留着上一个目录的绝对路径，
  // 否则菜单里会拿旧前缀去拼新资产的相对路径，拼出一条不存在的路径。
  S.rootPath = ''
  try {
    let data
    if (NATIVE) {
      // mode 三个调用都要带上：原生侧按 (rootId, mode) 分两份缓存，
      // 只给 scan 不带 scanPage/scanCount，取回来的会是另一套资产。
      const meta = await nativeAsk('scan', () => window.BD2Native.requestScan(S.rootId, !!force, S.mode), 300000)
      const items = []
      const PAGE = 40
      for (let from = 0; from < (meta.itemCount || 0); from += PAGE) {
        const chunk = JSON.parse(window.BD2Native.scanPage(meta.rootId, from, PAGE, S.mode) || '[]')
        for (let i = 0; i < chunk.length; i++) items.push(chunk[i])
      }
      data = Object.assign({}, meta, { items })
      if (meta.truncated) showError(t('目录太大，扫描已截断：只覆盖了前 4000 个子目录。建议直接选到放 Spine 文件的那一层。'))
    } else {
      const res = await fetch(`/api/scan?root=${encodeURIComponent(S.rootId)}` +
        `&mode=${encodeURIComponent(S.mode)}${force ? '&refresh=1' : ''}`)
      data = await res.json()
      if (!res.ok) throw new Error(data.error || t('扫描失败'))
    }
    // 过期的一轮：请求已经被后来的一次取代，整包丢弃（下面 catch/finally 同样只看代次）
    if (seq !== scanSeq) return
    S.items = data.items || []
    // 归组立刻算一次（NIKKE 姿势 R18 / Lost Sword 两层角色 R19）：缩略图队列、删除、
    // 深链都直接读条目上的 members / backLayer —— 不能指望「总会有人先渲染一遍列表」。
    nikkeViewFor()
    layerViewFor()
    // 绝对路径也一起收下：卡片菜单里的「复制路径」要靠它把相对路径拼成整条。
    // 两个数据源（Node 服务 / 原生壳）的扫描响应里都带 root.path，没有就是空串。
    S.rootPath = (data.root && data.root.path) || ''
    if (!data.exists) showError(t('目录不存在：{path}', { path: data.root.path }))
    $('assetCount').textContent = t('{ok}/{total} 可播放', { ok: data.playableCount, total: data.itemCount }) +
      (data.scanMs ? ` · ${data.scanMs}ms` : '')
    if (data.jczx) handleJczxMeta(data.jczx)
    // NIKKE 的 mod 包（UnityFS）在服务端/原生侧解包，**分批进行**：第一次扫描只解
    // 前一批（几十个包），剩下的在后台继续。这里给提示并轮询重扫，直到 pending 归零。
    // 轮询用 force（绕开服务端 15s 的扫描缓存），并且只在 NIKKE 档做。
    if (data.nikkeAb) handleNikkeAbMeta(data.nikkeAb)
    else if (S.mode === 'nikke' && nikkeAbPrev) {
      mergePendingUnpackPlaceholders([
        ...(nikkeAbPrev.pendingRels || []),
        ...(nikkeAbPrev.currentRels || []),
      ])
    }
  } catch (err) {
    if (seq === scanSeq) showError(t('扫描失败：') + err.message)
  } finally {
    if (seq === scanSeq) { setBusy(false); setScanProgress(false) }
  }
  // 平铺页要用：先把 IndexedDB 里上次生成的缩略图读进内存，
  // 这样卡片一渲染就直接有图，不用每次启动都重新渲一遍。
  await loadThumbCache()
  // 播放顺序的偏好也按目录记着：名称/日期排序要跟着目录一起切
  loadSort()
  applySortUI()
  refreshLists()
  // 深链 ?item=<relAtlas> 第一次进入时直接开播放页；否则主界面就是平铺页。
  // 之后手动「重新扫描」不再抢视图，用户停在哪一页就留在哪一页。
  // （boot() 已经按 initialView() 摆好了首屏，这里只是把深链那条路补完。）
  const wanted = bootedOnce ? null : deepLinkItem()
  bootedOnce = true
  const target = wanted ? allItems().find(i => i.id === wanted || i.relAtlas === wanted || i.base === wanted) : null
  if (target) {
    setView('player')
    selectItem(target)
  } else if (viewMode !== 'player' || !S.current) {
    setView('grid')
  }
}

/**
 * 模式隔离：按路径缓存目录过滤，避免 JCZX / NIKKE 解包产物串味。
 * 骨架世代仍由 spineMinorFor 选运行时；这里只管「该不该出现在当前档的 gallery」。
 */
function matchesAssetMode(item) {
  if (!item) return false
  const rel = String(item.relAtlas || item.id || '').replace(/\\/g, '/')
  const isJczx = rel === 'bd2viewer-jczx' || rel.startsWith('bd2viewer-jczx/')
    || rel.includes('/bd2viewer-jczx/')
    || rel === '.bd2viewer-jczx' || rel.startsWith('.bd2viewer-jczx/')
    || rel.includes('/.bd2viewer-jczx/')
  const isNikkeCache = rel === 'bd2viewer-nikke' || rel.startsWith('bd2viewer-nikke/')
    || rel.includes('/bd2viewer-nikke/')
    || rel === '.bd2viewer-nikke' || rel.startsWith('.bd2viewer-nikke/')
    || rel.includes('/.bd2viewer-nikke/')
  if (S.mode === 'jczx') return isJczx || !!item.pendingUnpack
  if (isJczx) return false
  // 名字里带 prefabs_spine 的是交错战线包（含 hash 前缀），其它档不展示
  if (/prefabs_spine/i.test(rel)) return false
  if (S.mode !== 'nikke' && isNikkeCache) return false
  return true
}

function allItems() {
  const base = [...S.customItems, ...S.items].filter(matchesAssetMode)
  if (S.mode === 'nikke' || S.mode === 'ark') {
    // nikke：藏姿势变体；ark：藏同一角色的其它形态（都挂在主条目 members 上，见 R18）
    return base.filter(i => !nikkeViewFor().variantKeys.has(itemKey(i)))
  }
  if (S.mode === 'lostsword') {
    // Lost Sword 档：藏「两层角色」的背层（`_B`，挂到 `_F` 上叠着渲染，见 R19）
    return base.filter(i => !layerViewFor().hiddenKeys.has(itemKey(i)))
  }
  return base
}

/* ---------------- Lost Sword：两层角色（`_B` 背层 + `_F` 前层）（R19）
   LobbyUnit 里 11 个角色的骨架是**两套**：`Lobby_Merlin_B`（背层：大头发 / 披风，
   实测只有 10 个槽位）与 `Lobby_Merlin_F`（前层：完整人物，36 个槽位）。
   游戏里是背层在下、前层在上叠着画的 —— 单独打开背层看着就是「残的」
   （用户反馈的「动画加载错误」就是这个：能播、不报错，但只有半个角色）。

   所以：**同一目录**里 `<X>_B` 与 `<X>_F` 成对出现时归成一套资产：
   · 条目本体是 `_F`（完整的那层），背层挂在 `item.backLayer` 上；
   · `_B` 不再单独成卡（从可见口径里藏掉），播放时两层一起渲染；
   · 只有 `_B` 没有 `_F` 时不归组（照旧单独成卡，用户还能看到一个"半层"）。
   与 NIKKE 归组一样，只改可见口径，`S.items` 仍然是原始条目。 */

let layerView = null   // { src, mode, hiddenKeys } —— S.items 或 S.mode 变了就重算

/** `Lobby_Merlin_B` → { id: 'Lobby_Merlin', side: 'B' }；不匹配返回 null。 */
function layerPartsOf(base) {
  const m = /^(.*)_([BF])$/.exec(String(base || ''))
  return m ? { id: m[1], side: m[2] } : null
}

function layerViewFor() {
  if (layerView && layerView.src === S.items && layerView.mode === S.mode) return layerView
  const hiddenKeys = new Set()
  if (S.mode === 'lostsword') {
    const groups = new Map()      // 目录 + '/' + id → { B, F }
    for (const it of S.items) {
      const p = layerPartsOf(it.base)
      if (!p) continue
      const dir = String(it.relAtlas || '').split('/').slice(0, -1).join('/')
      const gk = dir + '|' + p.id
      let g = groups.get(gk)
      if (!g) { g = {}; groups.set(gk, g) }
      if (!g[p.side]) g[p.side] = it
    }
    for (const g of groups.values()) {
      if (!g.B || !g.F) continue
      g.F.backLayer = g.B
      g.B.frontLayer = g.F
      hiddenKeys.add(itemKey(g.B))
    }
  }
  layerView = { src: S.items, mode: S.mode, hiddenKeys }
  return layerView
}

/* ---------------- NIKKE 模式：一个角色一套资产（R18） ----------------
   `<id>_00` 是本体；`<id>_aim_00` / `<id>_cover_00` 是**同一个角色**的
   「瞄准 / 掩体」姿势 —— 与参考站（Nikke-db）的组织方式一致：一个角色一份，
   播放页里切姿势，而不是把三套骨架摆成三张卡。

   需求 6 之后解包缓存是「每包一文件夹」：
     bd2viewer-nikke/<packFolder>/c022_00.atlas
     bd2viewer-nikke/<otherPack>/c022_aim_00.atlas
   同一角色的 standing / aim / cover 落在**不同包文件夹**里。归组键 =
   （缓存 `c|` / 用户自有 `r|`）+ 从骨架基名解析的角色 id（`nikkeGroupOf`），
   **跨同层包文件夹合并**，不再要求同目录。同一姿势多份 mod 只留第一份。

   分组 + 变体隐藏都只发生在「可见口径」这一层：
   · `S.items` 始终存**原始条目** —— 删除 / 扫描缓存 / 上传 / 缩略图队列都不必知道分组存在；
   · 变体从可见列表里隐藏，并把成员挂到主条目的 `members` 上（[自身, ...变体]，按
     本体 → aim → cover 排序），删除时随主条目一起删（见 removeItemsOnDisk）；
   · 播放姿势记在 `S.currentPose`，loadCurrent 按它取成员的文件（activeMemberOf）；
   · 产品不要求跨模式完美隔离：不按命名形 / 骨架世代再挡其它条目。

   为什么不让服务端/原生归组：那要把「成员列表」塞进扫描结果，三个实现
   （server / ScanEngine / 前端）都得维护同一份分组语义；放前端一处就够了。 */

let nikkeView = null   // { src, mode, variantKeys } —— S.items 或 S.mode 变了就重算

/** 'c022_aim_00' → {id:'c022', pose:'aim'}；'c022_00' → {id:'c022', pose:'normal'}；
 *  认不出尾缀时整个基名就是 id（pose=normal）。id 本身可以带下划线。 */
function nikkeGroupOf(base) {
  const b = String(base || '')
  let m = /^(.+)_(aim|cover)(?:_\d+)?$/i.exec(b)
  if (m) return { id: m[1], pose: m[2].toLowerCase() }
  m = /^(.+)_(\d+)$/.exec(b)
  if (m) return { id: m[1], pose: 'normal' }
  return { id: b, pose: 'normal' }
}

function nikkeViewFor() {
  if (nikkeView && nikkeView.src === S.items && nikkeView.mode === S.mode) return nikkeView
  const variantKeys = new Set()
  if (S.mode === 'nikke') {
    const groups = new Map()
    const sorted = [...S.items].sort((a, b) =>
      String(a.relAtlas || '').localeCompare(String(b.relAtlas || '')))
    for (const it of sorted) {
      const g = nikkeGroupOf(it.base)
      // 分组键 = 角色id + **来源**（解包缓存 / 用户自有文件）。1.07 踩过的坑：
      // 解包缓存里的 `c022_00`（mod 包内名）会和用户自己的 `c022/c022_00.atlas`
      // 撞成一组，缓存项排前面还把主条目顶掉 —— 同一角色两份来源应当是两张卡。
      // 需求 6：缓存侧跨 sibling 包文件夹归组（key 不含 folder；同 id 的 aim/cover
      // 即使在不同 <packFolder> 里也会并到一张卡）。
      const key = (isNikkeCacheItem(it) ? 'c|' : 'r|') + g.id
      let grp = groups.get(key)
      if (!grp) { grp = []; groups.set(key, grp) }
      grp.push({ item: it, pose: g.pose })
    }
    for (const grp of groups.values()) {
      // 本体在最前；其余按 pose 名排，保证顺序稳定
      grp.sort((a, b) => (a.pose === 'normal' ? -1 : b.pose === 'normal' ? 1 : a.pose.localeCompare(b.pose)))
      // 同一姿势出现多次（同一个角色姿势的多份 mod）只保留第一份，否则姿势切换对不上一一映射
      const seen = new Set()
      const uniq = grp.filter(m => (seen.has(m.pose) ? false : (seen.add(m.pose), true)))
      if (uniq.length < 2) continue
      const main = uniq[0].item
      main.members = uniq
      main.groupId = nikkeGroupOf(main.base).id
      for (const m of uniq.slice(1)) variantKeys.add(itemKey(m.item))
    }
  }
  if (S.mode === 'ark') {
    // Ark（星陨计划）：一个角色目录里的多个 bundle 是**同一个角色的不同形态**
    // （本体 / `<ID>_S` 战斗形态 / `<ID>_N` / `CG_<ID>_a|b` 剧情CG骨骼）。
    //
    // 与 NIKKE 的关键差别：Ark 的形态**视觉完全不同**（CG 骨骼是剧情立绘级别的构图，
    // `_S` 是战斗骨骼），不是「同一角色换个姿势」—— 所以播放页的切换入口必须标出形态名
    // （见 buildFormSwitcher / formLabel），否则用户会以为点坏了。
    //
    // 分组键直接用服务端在 meta.json 里给的 charId —— 它已经处理了「本体是否存在」
    // （只有 189/267 个角色目录真有本体，猜不出就要靠 meta 的 spineAssets 兜底）。
    const groups = new Map()
    const sorted = [...S.items].sort((a, b) =>
      String(a.relAtlas || '').localeCompare(String(b.relAtlas || '')))
    for (const it of sorted) {
      const ak = it && it.ark
      if (!ak || !ak.charId) continue
      const key = ak.charId
      let grp = groups.get(key)
      if (!grp) { grp = []; groups.set(key, grp) }
      // pose 用 formBundle（唯一且稳定）；本体（isDefaultForm）排在最前。
      grp.push({ item: it, pose: ak.formBundle || it.base, form: ak })
    }
    for (const [key, grp] of groups) {
      // 本体优先，其余按 bundle 名排，保证顺序稳定
      grp.sort((a, b) => {
        const da = a.form && a.form.isDefaultForm ? 0 : 1
        const db = b.form && b.form.isDefaultForm ? 0 : 1
        return da !== db ? da - db : String(a.pose).localeCompare(String(b.pose))
      })
      const seen = new Set()
      const uniq = grp.filter(m => (seen.has(m.pose) ? false : (seen.add(m.pose), true)))
      if (uniq.length < 2) continue
      const main = uniq[0].item
      main.members = uniq
      main.groupId = key
      // 立绘/语音只在承载条目上（服务端已保证唯一），归组后要把它**搬到主条目**上，
      // 否则主条目可能不是那个 isCarrier 的 bundle（本体缺失时），播放页就找不到立绘了。
      const carrier = uniq.find(m => m.form && m.form.isCarrier)
      if (carrier) {
        main.ark = main.ark || {}
        main.ark.statics = carrier.form.statics || []
        main.ark.voices = carrier.form.voices || []
        main.ark.charName = main.ark.charName || carrier.form.charName
        main.ark.rarity = main.ark.rarity != null ? main.ark.rarity : carrier.form.rarity
        main.ark.carrierBundle = carrier.pose
      }
      for (const m of uniq.slice(1)) variantKeys.add(itemKey(m.item))
    }
  }
  nikkeView = { src: S.items, mode: S.mode, variantKeys }
  return nikkeView
}

/** 解包缓存里的条目（目录名与服务端 /ScanEngine 的常量保持一致）。 */
function isNikkeCacheItem(it) {
  const r = String(it && it.relAtlas || '')
  return r.startsWith('bd2viewer-nikke/') || r.includes('/bd2viewer-nikke/')
    || r.startsWith('.bd2viewer-nikke/') || r.includes('/.bd2viewer-nikke/')
}
function isJczxCacheItem(it) {
  const r = String(it.relAtlas || '')
  return r.startsWith('bd2viewer-jczx/') || r.includes('/bd2viewer-jczx/')
    || r.startsWith('.bd2viewer-jczx/') || r.includes('/.bd2viewer-jczx/')
}

/** 当前播放姿势实际指向的条目：主条目本身，或它 members 里的那个变体。
 *  NIKKE 的默认成员是 pose==='normal'；Ark 没有 normal，members[0] 就是本体（见 defaultPoseOf）。 */
function activeMemberOf(item) {
  if (!item || !Array.isArray(item.members) || !item.members.length) return item
  const pose = S.currentPose || defaultPoseOf(item)
  if (pose === 'normal') return item
  const m = item.members.find(x => x.pose === pose)
  return m ? m.item : item
}

/* ------------------------------------------------------------------ Ark 显示口径
   星陨计划（Ark Re:Code）的卡片不该只显示 `H001` —— 素材 `meta.json` 里就有中文名。
   但实测这批元数据**不完整**，所以每一层都要能退回 id：

   · `角色/H001` 有 character 字段 → 「夏妮」+ 稀有度 5
   · `角色/B001` 的 name 是占位「未命名（B001）」→ 服务端已转成 null → 退回显示 `B001`
   · `画册/A0001` 的 meta.json **根本没有 character 字段**（381 个全是）→ 退回显示目录 id
   · 分组后主条目可能不是承载条目（本体缺失时），立绘/语音由 nikkeViewFor 搬过来 */

const RARITY_MARK = ['✦', '✦✦', '✦✦✦', '✦✦✦✦', '✦✦✦✦✦']

/** 卡片主标题：Ark 有中文名就用中文名，否则退回 bundle id。
 *  ⚠️ 退回用 `item.base` 而不是 `item.folder` —— folder 是**骨架文件所在目录**的末段，
 *  Ark 的骨架全在 `<角色>/runtime/` 下，folder 恒为 "runtime"，596 张卡会全叫这个名字。 */
function displayNameOf(item) {
  if (item && item.ark && item.ark.charName) return item.ark.charName
  return item ? (item.base || item.folder || '') : ''
}

/** 卡片副标题：稀有度 + 形态数 + 贴图数。Ark 特有（其它模式走原来的 base 写法）。 */
function arkCardSub(item) {
  const ak = item && item.ark
  if (!ak) return ''
  const bits = []
  if (ak.rarity != null) {
    const n = Math.max(0, Math.min(RARITY_MARK.length - 1, ak.rarity - 1))
    bits.push(RARITY_MARK[n])
  }
  const forms = Array.isArray(item.members) ? item.members.length : 1
  if (forms > 1) bits.push(t('{n} 个形态', { n: forms }))
  bits.push(t('{n} 图', { n: (item.images || []).length }))
  return bits.join(' ')
}

/** 播放页副标题：中文名 · 稀有度 · 形态 · 动画数。 */
function arkCurrentSub(item) {
  const ak = item && item.ark
  if (!ak) return ''
  const bits = []
  if (ak.charName) bits.push(ak.charName)
  if (ak.charId) bits.push(ak.charId)
  if (ak.rarity != null) {
    const n = Math.max(0, Math.min(RARITY_MARK.length - 1, ak.rarity - 1))
    bits.push(RARITY_MARK[n] + t('稀有度 {n}', { n: ak.rarity }))
  }
  if (ak.formLabel) bits.push(ak.formLabel)
  if (ak.animationCount != null) bits.push(t('{n} 个动画', { n: ak.animationCount }))
  return bits.join(' · ')
}

/** 这个条目的立绘（kind==='full'）—— 播放页大图用。 */
function arkIllustrationOf(item) {
  const ak = item && item.ark
  if (!ak || !Array.isArray(ak.statics)) return null
  return ak.statics.find(s => s.kind === 'full' && s.url) || null
}

/* ------------------------------------------------------------------ 资产顺序
   三种来源，按目录分别记在 localStorage：
     · manual —— 用户在平铺页拖动卡片排出来的顺序（bd2.order.<rootId>.<mode> 存键序列）
     · name   —— 按目录名 / 文件名（自然序，illust_special2 排在 illust_special10 前面）
     · date   —— 按 atlas 文件改动时间
   orderedList() 是唯一入口：平铺页、左侧资产列表、播放页 ◀▶ 都走它，
   所以「排序」改的是真正的播放顺序，而不是只把画面重排一下。

   顺序键带 mode：两套资产的文件名完全不同，共用一份顺序只会排出一份对不上的列表。
   排序偏好（mode/dir）不带 mode：那是用户习惯，切游戏不该被打回默认。 */

const orderKeyFor = rid => `bd2.order.${rid || 'default'}.${S.mode || 'bd'}`
const sortKeyFor = rid => `bd2.sort.${rid || 'default'}`

const SORT_MODES = ['manual', 'name', 'date']
/** 各排序方式的默认方向：名称 A→Z，日期新的在前 */
const SORT_DEFAULT_DIR = { manual: 1, name: 1, date: -1 }
/** 排序方式 → 界面文案。**不预先把中文烤进常量** —— 那样切语言时这个表
 *  还是旧语言。取值时即时查表（t() 在中英之间恒等/翻译）。 */
const SORT_LABEL = { manual: '手动', name: '名称', date: '日期' }

let sortState = { mode: 'manual', dir: SORT_DEFAULT_DIR.manual }

/** 自然序比较器：localeCompare 支持 numeric，避免 2 排在 10 后面 */
const NAME_COLLATOR = (() => {
  try { return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' }) }
  catch { return null }
})()

function cmpText(a, b) {
  if (NAME_COLLATOR) return NAME_COLLATOR.compare(a, b)
  return a < b ? -1 : a > b ? 1 : 0
}

/** 名称序：先比卡片上显示的名字（目录名），再比文件名，最后用 key 兜底保证稳定 */
function cmpName(a, b) {
  return cmpText(a.folder || '', b.folder || '') ||
    cmpText(a.base || '', b.base || '') ||
    cmpText(itemKey(a), itemKey(b))
}

/** 日期序：mtime 取不到（SAF 目录 / 上传的资源）当 0，排在「最旧」那头 */
function cmpDate(a, b) {
  const am = a.mtime || 0, bm = b.mtime || 0
  if (am !== bm) return am - bm
  return cmpName(a, b)
}

function loadSort() {
  try {
    const raw = JSON.parse(localStorage.getItem(sortKeyFor(S.rootId)) || 'null')
    if (raw && SORT_MODES.includes(raw.mode)) {
      sortState = { mode: raw.mode, dir: raw.dir === -1 ? -1 : 1 }
      return sortState
    }
  } catch { /* 坏数据当成没存过 */ }
  sortState = { mode: 'manual', dir: SORT_DEFAULT_DIR.manual }
  return sortState
}

function saveSort() {
  try { localStorage.setItem(sortKeyFor(S.rootId), JSON.stringify(sortState)) } catch { /* 存不下就算了 */ }
}

function loadOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(orderKeyFor(S.rootId)) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}

function saveOrder(keys) {
  try { localStorage.setItem(orderKeyFor(S.rootId), JSON.stringify(keys)) } catch { /* 存不下就算了 */ }
}

/** 手动顺序：有记录的按记录排，没记录的排后面（sort 在 V8 里稳定，保持扫描原序） */
function applyManualOrder(items) {
  const order = loadOrder()
  if (!order.length) return items.slice()
  const idx = new Map(order.map((k, i) => [k, i]))
  const rank = it => (idx.has(itemKey(it)) ? idx.get(itemKey(it)) : 1e9)
  return items.slice().sort((a, b) => rank(a) - rank(b))
}

/**
 * 按当前排序方式排（总是返回新数组）。
 * 名称/日期把方向乘进比较器，而不是排完再整体反转 ——
 * 整体反转会把「同值时按名称兜底」也一起翻过去，同一时刻的文件顺序会莫名其妙倒过来。
 * 手动顺序没有 key 可比，倒序就是整个数组反过来。
 */
function orderedList(items) {
  const st = sortState
  const sign = st.dir === -1 ? -1 : 1
  if (st.mode === 'name') return items.slice().sort((a, b) => sign * cmpName(a, b))
  if (st.mode === 'date') return items.slice().sort((a, b) => sign * cmpDate(a, b))
  const base = applyManualOrder(items)
  return sign === -1 ? base.reverse() : base
}

/**
 * 把「当前排序方式排出来的顺序」固化成手动顺序。
 * 从名称/日期切到手动、或在排序状态下开始拖动时调用 —— 这样切过去画面不跳，
 * 用户接着微调的就是他刚看到的那份顺序。
 */
function seedManualOrderFromSort() {
  const keys = orderedList(allItems()).map(itemKey)
  saveOrder(keys)
  return keys
}

function setSortMode(mode, opts) {
  if (!SORT_MODES.includes(mode)) return
  if (mode === sortState.mode && !opts?.dir) return
  // 从排序模式切回手动：先把当前看到的顺序固化，否则会突然跳回很久以前那份手动顺序
  if (mode === 'manual' && sortState.mode !== 'manual') seedManualOrderFromSort()
  sortState = { mode, dir: opts?.dir ?? SORT_DEFAULT_DIR[mode] }
  saveSort()
  applySortUI()
  refreshLists()
}

/**
 * 升降序。三种模式都靠 sortState.dir 表达（orderedList 统一在最后反转），
 * 所以这里只翻一个标志位，不动存下来的数组 —— 两边都翻会互相抵消。
 *  · 名称 / 日期 —— 切换升/降序（会记住）
 *  · 手动 —— 等于「把当前播放顺序倒过来」播放
 */
function toggleSortDir() {
  const dir = sortState.dir === 1 ? -1 : 1
  sortState = { mode: sortState.mode, dir }
  saveSort()
  applySortUI()
  refreshLists()
  const what = sortState.mode === 'manual'
    ? t(dir === 1 ? '正序' : '倒序')
    : sortState.mode === 'date'
      ? t(dir === -1 ? '新的在前' : '旧的在前')
      : t(dir === 1 ? '升序' : '降序')
  toast(`${t(SORT_LABEL[sortState.mode])} · ${what}`)
}

/** 把排序状态同步到界面：滑块位置、升降序图标、提示文案 */
function applySortUI() {
  const st = sortState
  const box = $('galSort')
  if (box) {
    box.style.setProperty('--i', String(Math.max(0, SORT_MODES.indexOf(st.mode))))
    for (const b of box.querySelectorAll('.gs-btn')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === st.mode))
    }
  }
  const dir = $('galSortDir')
  if (dir) {
    dir.textContent = st.dir === 1 ? '↑' : '↓'
    dir.title = st.mode === 'manual'
      ? t('反转当前播放顺序')
      : t(st.dir === 1 ? '当前升序，点一下改降序' : '当前降序，点一下改升序')
    dir.setAttribute('aria-label', dir.title)
  }
  const hint = $('galHint')
  if (hint) {
    if (st.mode === 'manual') {
      hint.textContent = t(document.body.classList.contains('is-touch')
        ? '长按卡片拖动 = 调整播放顺序 · 按住不动弹删除菜单'
        : '拖动卡片调整播放顺序（按住左上角 ⠿ 立刻拖）· 右键卡片可复制路径 / 删除')
    } else {
      const arrow = st.mode === 'date'
        ? t(st.dir === -1 ? '新的在前' : '旧的在前')
        : t(st.dir === 1 ? '升序' : '降序')
      hint.textContent = t('按{mode}（{dir}）· 切回「手动」才能拖动排序',
        { mode: t(SORT_LABEL[st.mode]), dir: arrow })
    }
  }
  // 以名称 / 日期排序时拖不动，「⠿」手柄就不该出现 —— 看得见却拖不动比直接没有更让人困惑。
  // 归 JS 挂类名（而不是 :has() 或内联样式）：这是**随数据变**的条件，见 ARCHITECTURE R1。
  document.body.classList.toggle('sort-locked', st.mode !== 'manual')
}

/** 扫描出来的资产唯一标识：上传的自定义项有 key，扫描出来的只有 id（= relAtlas） */
function itemKey(i) { return i.key || i.id || i.relAtlas || '' }

/* 过滤条件收在状态里，不再每次去读 DOM。
   「哪些资产可见」是个纯数据问题 —— 原来 filteredItems() 直接读 #assetFilter.value /
   #chkOnlyPlayable.checked，等于把「排序 + 过滤」这一层和左侧抽屉的控件绑死：
   没法单独推理或测试，同一个条件还出现了两个事实来源。
   约定：控件只是**入口**，filters 才是事实来源 —— 控件一变调 syncFilters()，其余人只读 filters。 */
const filters = { q: '', onlyOk: true }

/* 搜索的「命中理由」：assetKey → 命中的资源文件名。
   它**不是**第二个可见性口径 —— 可见性仍然只由 filteredItems() 决定。
   这里只是那条过滤顺手留下的副产物，纯粹给界面解释「这条为什么被搜出来」用
   （搜 illust_special6 时卡片显示的是目录名，不解释一句会让人以为搜错了）。
   每次 filteredItems() 开头清空重建，读它的人必须在同一次渲染里读。 */
const searchHits = new Map()

/** 把左侧抽屉那两个控件同步进 filters（只在输入事件里调用） */
function syncFilters() {
  filters.q = $('assetFilter').value.trim().toLowerCase()
  filters.onlyOk = $('chkOnlyPlayable').checked
}

/**
 * 一套资产里所有「可被搜到的名字」—— 目录名、组名、骨架名，以及**内部资源文件**的
 * 真实文件名（.atlas / .skel / .json / 每个 .png）。
 *
 * 为什么要搜资源文件：资产卡片上显示的是目录名，但人们记得住的常常是图叫什么
 * （「illust_special6 那套在哪来着」）。只比目录名的话，这类记忆完全搜不到。
 *
 * 全部走已经扫出来的字段，不再读一次磁盘；`relSkeleton` 在「只有 atlas 没有骨架」的
 * 残缺资产上是 null，所以逐个判空。
 */
function searchHaystack(i) {
  const parts = [i.folder, i.base, i.group, i.atlas, i.relAtlas]
  if (i.relSkeleton) parts.push(i.relSkeleton)
  if (i.skeleton) parts.push(i.skeleton)
  if (Array.isArray(i.relImages)) parts.push(...i.relImages)
  // NIKKE 模式下变体（aim/cover）属于同一张卡：变体的文件名也要能被搜到
  if (Array.isArray(i.members)) {
    for (const m of i.members) {
      const it = m.item || m
      if (it !== i) parts.push(it.base, it.relAtlas, it.relSkeleton)
    }
  }
  return parts.filter(Boolean).join(' ').toLowerCase()
}

/** 资产 → 这次搜索命中的资源文件名（给界面显示「为什么这条被搜出来」）。
 *  只在没有任何「表面字段」命中时才需要它，所以按需算。 */
function hitReason(i, q) {
  const surface = `${i.folder} ${i.base} ${i.group}`.toLowerCase()
  if (surface.includes(q)) return ''
  const files = []
  if (i.relSkeleton) files.push(i.relSkeleton)
  if (Array.isArray(i.relImages)) files.push(...i.relImages)
  if (i.atlas) files.push(i.atlas)
  const hit = files.find(f => String(f).toLowerCase().includes(q))
  // 取文件名做展示。**两种分隔符都要切**：relImages 在磁盘扫描时可能拿到
  // Windows 的反斜杠形式（"sub\\img.png"），只 split('/') 会把 "sub\\img.png"
  // 整串当成文件名显示在卡片上。
  return hit ? String(hit).split(/[/\\]/).pop() : ''
}

/** 当前过滤条件下、按用户排序排好的资产 —— 全项目唯一的「可见资产」口径 */
function filteredItems() {
  const { q, onlyOk } = filters
  searchHits.clear()
  return orderedList(allItems().filter(i => {
    // 尚未解包的占位卡（需求 1）即使开了「仅可播放」也要看得见，才能点开优先解包
    if (onlyOk && !i.ok && !i.pendingUnpack) return false
    if (!q) return true
    if (!searchHaystack(i).includes(q)) return false
    const why = hitReason(i, q)
    if (why) searchHits.set(itemKey(i), why)
    return true
  }))
}

/**
 * 全项目唯一的「资产视图已变，重画一遍」入口。
 *
 * 一次刷新 = 控件 → 状态 → 两个渲染出口：
 *   · syncFilters()      把左侧抽屉那两个控件读进 filters（控件是入口，filters 是事实来源）
 *   · renderAssetList()  左侧资产列表
 *   · renderGallery()    平铺页（只在当前是平铺页时）
 *
 * 之前这几行散落在 8 处（排序、删除、扫描、导入、清空自定义…），
 * 每次都要靠人记得「列表和平铺页要一起刷」——漏一个就留下
 * 「数据变了、界面还是旧的」这种脏状态。
 * 现在只此一处；`commitCardOrder()` 是唯一的例外（原因见那里）。
 *
 * 注意：播放页左右箭头的显隐**不在这里**。它跟的是「动画列表变了」，
 * 所以由 onLoaded()/resetMeta() 调 syncStageNav() —— 两个条件互不相干。
 */
function refreshLists() {
  syncFilters()
  syncSearchUI()
  renderAssetList()
  if (viewMode === 'grid') renderGallery()
}

/** 搜索框的附属 UI：有内容才显示「✕」清空键。
 *  放在这里而不是 input 事件里 —— 清空也可能来自别处（比如「重新扫描」后重置），
 *  状态同步只该有一个出口。
 *  计数故意**不在这里算**：那要多跑一遍 filteredItems()，大目录下白费一次全量排序。
 *  交给 renderAssetList() 末尾顺手更新（它本来就要遍历一遍结果）。 */
function syncSearchUI() {
  // 两个搜索框（抽屉 + 平铺页头部）各有一个清空键，显隐要跟着各自的输入框走
  for (const [inpId, clearId] of [['assetFilter', 'assetFilterClear'], ['galFilter', 'galFilterClear']]) {
    const input = $(inpId)
    const clear = $(clearId)
    if (clear) clear.hidden = !(input && input.value)
  }
}

function renderAssetList() {
  const list = $('assetList')
  list.innerHTML = ''

  // 手动顺序下列表按「分组」成段，好找；
  // 但按名称/日期排序时分组会被打散 —— 每张卡片前面都挂一个组名反而更乱，
  // 所以那种情况下列表拍平，改把组名放进副标题里，信息不丢。
  const grouped = sortState.mode === 'manual'

  let group = null
  let shown = 0
  for (const item of filteredItems()) {
    if (grouped && item.group !== group) {
      group = item.group
      // 同理避开 t()：局部叫 gt（group title）
      const gt = document.createElement('div')
      gt.className = 'asset-group-title'
      gt.textContent = group
      list.appendChild(gt)
    }
    const el = document.createElement('div')
    el.className = 'asset-item' + (item.ok ? '' : ' bad') +
      (S.current && itemKey(S.current) === itemKey(item) ? ' active' : '')
    el.innerHTML = `<div class="ai-name"></div><div class="ai-sub"></div>` +
      (item.problems?.length ? `<div class="ai-warn"></div>` : '')
    el.querySelector('.ai-name').textContent = item.folder
    let sub = (grouped ? '' : (item.group ? item.group + ' · ' : '')) +
      item.base + (item.skeletonKind ? `.${item.skeletonKind}` : '') +
      t(' · {n} 图', { n: item.images.length })
    // 搜索命中的是内部资源文件 → 副标题里补上命中的那个文件名（否则看不出为什么它在结果里）
    const hit = searchHits.get(itemKey(item))
    if (hit) sub += ` · 🔍 ${hit}`
    el.querySelector('.ai-sub').textContent = sub
    if (item.problems?.length) el.querySelector('.ai-warn').textContent = '⚠ ' + item.problems.join('；')
    el.onclick = () => { openItem(item); closeSheet(); if (fsMode) toggleFsFiles(false) }
    // PC：右键列表项也给同一个操作菜单（复制路径 / 删除）。触屏没有右键，行为不变。
    el.addEventListener('contextmenu', e => { e.preventDefault(); openCardMenu(item) })
    list.appendChild(el)
    shown++
  }

  if (!shown) {
    const empty = document.createElement('div')
    empty.className = 'asset-group-title'
    empty.textContent = t(S.rootId ? '没有匹配的资产' : '请先添加一个目录')
    list.appendChild(empty)
  }

  // 搜索时把右上角计数换成命中数 —— 复用刚遍历完的 shown，不再多跑一遍 filteredItems()。
  // 没在搜索就别动它：那个计数是 scan() 写的「N/M 可播放 · 耗时」，另有含义。
  const count = $('assetCount')
  if (count && filters.q) count.textContent = shown ? t('匹配 {n} 个', { n: shown }) : t('无匹配')
}

/* ------------------------------------------------------------ 平铺浏览（主界面）
   主界面不直接播动画，而是一张张卡片平铺展示：
     · 点卡片 → 进播放页；卡片右上角 ⛶ → 直接全屏
     · 拖卡片左上角 ⠿ → 调整播放顺序（存 localStorage，影响全屏 ◀▶ 的顺序）
     · 缩略图：卡片进入视野时用它自己的一个离屏 SpinePlayer 渲一帧，转 JPEG 存进
       IndexedDB；缓存 key 带 mtime，重新读取文件夹后文件变了会自动重生成。
   ------------------------------------------------------------------------ */

let viewMode = 'grid'
let bootedOnce = false

const thumbCache = new Map()      // cacheKey -> dataURL
const thumbFailed = new Set()     // 已确认生成不了的 cacheKey（IndexedDB 里存空串），启动不再重试
const thumbAsked = new Set()      // 正在生成 / 已尝试过的 cacheKey，避免重复排
let thumbRunning = false
let thumbDone = 0
// 生成后是否把缩略图写回资产目录（需求 5：源文件夹里放一个 thumb.png，重开不用重灌）。
// 自动化测试必须关掉 —— 它会改用户磁盘，也会让「有多少资产需要生成」这个前提漂移。
let thumbPersist = true
// 用户点了「重建」的资产：即使测试关掉了自动落盘，也要覆盖目录里的 thumb.png。
const thumbForceWrite = new Set()

/** 丢掉一套资产在内存 / IndexedDB 里的缩略图，并忽略磁盘上已有的 thumb.png。 */
function forgetThumb(item) {
  if (!item) return
  const prefix = thumbKeyPrefix(item)
  for (const k of [...thumbCache.keys()]) {
    if (typeof k === 'string' && k.startsWith(prefix)) {
      thumbCache.delete(k)
      idbDel(k)
    }
  }
  for (const k of [...thumbFailed]) {
    if (typeof k === 'string' && k.startsWith(prefix)) {
      thumbFailed.delete(k)
      idbDel(k)
    }
  }
  thumbAsked.delete(thumbKey(item))
  item.relThumb = null
  thumbForceWrite.add(thumbKey(item))
}
function thumbKey(item) {
  return `${S.rootId || ''}|${itemKey(item)}|${item.mtime || 0}|${(item.images || []).length}`
}

/** 前缀：同一 root + 同一资产（忽略 mtime / 图数漂移）。用于复用已生成的本地缓存。 */
function thumbKeyPrefix(item) {
  return `${S.rootId || ''}|${itemKey(item)}|`
}

/**
 * 优先读已有缓存。精确 key 命中即用；
 * 仅当 mtime 不可靠（0，SAF/部分机型）时，才回退到同资产的旧 key，避免无意义重渲。
 * 真有 mtime 时仍靠 key 失效 —— 文件改了就该重生成。
 * @returns {{ url: string } | { failed: true } | null}
 */
function thumbCacheLookup(item) {
  const exact = thumbKey(item)
  const hit = thumbCache.get(exact)
  if (typeof hit === 'string' && hit) return { url: hit }
  if (thumbFailed.has(exact)) return { failed: true }
  // mtime 可靠时不模糊匹配，否则改文件后还会贴旧图
  if ((item.mtime || 0) !== 0 || !itemKey(item)) return null
  const prefix = thumbKeyPrefix(item)
  for (const [k, v] of thumbCache) {
    if (typeof k === 'string' && k.startsWith(prefix) && typeof v === 'string' && v) {
      thumbCache.set(exact, v)
      idbPut(exact, v)
      return { url: v }
    }
  }
  for (const k of thumbFailed) {
    if (typeof k === 'string' && k.startsWith(prefix)) {
      thumbFailed.add(exact)
      idbPut(exact, '')
      return { failed: true }
    }
  }
  return null
}

/* IndexedDB：缩略图比 localStorage 大得多，放这儿不会撑爆 5MB 配额 */
let idbPromise = null
function idb() {
  if (idbPromise) return idbPromise
  idbPromise = new Promise((resolve, reject) => {
    try {
      const rq = indexedDB.open('bd2viewer', 1)
      rq.onupgradeneeded = () => { rq.result.createObjectStore('thumbs') }
      rq.onsuccess = () => resolve(rq.result)
      rq.onerror = () => reject(rq.error)
    } catch (e) { reject(e) }
  }).catch(() => {
    idbPromise = null   // 下次再试：WebView 偶发第一次 open 失败
    return null
  })
  return idbPromise
}

async function idbGet(key) {
  const db = await idb()
  if (!db) return null
  return new Promise(resolve => {
    try {
      const rq = db.transaction('thumbs').objectStore('thumbs').get(key)
      rq.onsuccess = () => resolve(rq.result || null)
      rq.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

async function idbPut(key, value) {
  const db = await idb()
  if (!db) return
  try { db.transaction('thumbs', 'readwrite').objectStore('thumbs').put(value, key) } catch { /* ignore */ }
}

/** 资产被删掉后把它的缩略图也清掉，不然缓存会一直攒着没用的图 */
async function idbDel(key) {
  const db = await idb()
  if (!db) return
  try { db.transaction('thumbs', 'readwrite').objectStore('thumbs').delete(key) } catch { /* ignore */ }
}

async function idbClearThumbs() {
  const db = await idb()
  if (!db) return
  try { db.transaction('thumbs', 'readwrite').objectStore('thumbs').clear() } catch { /* ignore */ }
}

let thumbLoaded = false
let thumbLoadPromise = null

/** 启动后把 IndexedDB 里已生成的缩略图一次性读进内存：
 *  卡片直接显示上次的结果，不用每个都重新开离屏播放器渲一遍。
 *  顺手清掉当前目录下已经不存在的资产留下的旧条目（其它目录的保留）。 */
function loadThumbCache() {
  if (thumbLoadPromise) return thumbLoadPromise
  thumbLoadPromise = (async () => {
    const db = await idb()
    if (!db) {
      thumbLoaded = true
      thumbLoadPromise = null   // 允许下次 scan 再读盘上的已生成缩略图
      return
    }
    await new Promise(resolve => {
      let rq
      try { rq = db.transaction('thumbs').objectStore('thumbs').openCursor() } catch { resolve(); return }
      rq.onsuccess = () => {
        const c = rq.result
        if (!c) { resolve(); return }
        if (typeof c.key !== 'string') { c.continue(); return }
        // 空串 = 上次确认生成不了的坏文件，单独记到失败集合里
        if (c.value === '') thumbFailed.add(c.key)
        else if (typeof c.value === 'string') thumbCache.set(c.key, c.value)
        c.continue()
      }
      rq.onerror = () => resolve()
    })
    thumbLoaded = true
    const prefix = `${S.rootId || ''}|`
    const valid = new Set(allItems().map(i => thumbKey(i)))
    const stale = [...thumbCache.keys()].filter(k => k.startsWith(prefix) && !valid.has(k))
    if (stale.length) {
      try {
        const tx = db.transaction('thumbs', 'readwrite')
        const st = tx.objectStore('thumbs')
        for (const k of stale) st.delete(k)
      } catch { /* ignore */ }
      for (const k of stale) thumbCache.delete(k)
    }
  })()
  return thumbLoadPromise
}

const thumbObserver = (typeof IntersectionObserver === 'function')
  ? new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) en.target.__wantThumb = true
    thumbKick()
  }, { rootMargin: '300px' })
  : null

function setView(mode) {
  viewMode = mode === 'player' ? 'player' : 'grid'
  document.body.classList.toggle('view-grid', viewMode === 'grid')
  if (viewMode === 'grid') {
    // 抽屉不能跨视图留在半开状态：平铺页里底部标签栏整条没了，收不回去就卡住
    if (sheetOpen) toggleSheet('')
    renderGallery()
    // 播放页里攒下的后台解包重扫：回到平铺页再补一次（不在播放页打扰观看）
    if (unpackRescanNeeded && !S.busy) {
      unpackRescanNeeded = false
      scan(true)
    }
  }
  syncTouchSettingsEntry()
  // 视口尺寸变了：让播放器按新尺寸重排（回到播放页时画面不能歪）
  requestAnimationFrame(() => requestAnimationFrame(onStageResize))
}

/* 触屏模式（APK）下「设置」的两个入口二选一，不能同时都没有：
     · 播放页 —— 底部标签栏里的「设置」（顶栏那颗藏着，避免重复）
     · 平铺页 —— 底部标签栏整条不显示（CSS: body.view-grid .mtabs），
                 于是把顶栏那颗露出来，否则「文件目录」就改不了了 */
function syncTouchSettingsEntry() {
  if (!document.body.classList.contains('is-touch')) return
  const set = $('btnSettings')
  if (set) set.hidden = viewMode !== 'grid'
}

/** 打开某套资产：切到播放页，可选直接全屏。
 *  需求 1：尚未解包的占位卡 → 抬优先级并等解完再播；已解的 NIKKE 卡也抬同角色姿势兄弟。 */
function openItem(item, opts) {
  if (!item) return
  setView('player')
  if (item.pendingUnpack && item.bundleRel) {
    openPendingUnpack(item, opts)
    return
  }
  if (S.mode === 'nikke') {
    const keys = []
    if (item.groupId) keys.push(item.groupId)
    else if (item.base) {
      const g = nikkeGroupOf(item.base)
      if (g && g.id) keys.push(g.id)
    }
    if (keys.length) prioritizeNikke([], keys)
  }
  selectItem(item)
  if (opts && opts.fullscreen) setFullscreen(true)
}

async function prioritizeJczx(rels) {
  const list = (rels || []).filter(Boolean)
  if (!list.length) return null
  if (NATIVE) {
    try {
      const raw = window.BD2Native.jczxUnpackPrioritize && window.BD2Native.jczxUnpackPrioritize(S.rootId, JSON.stringify(list))
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }
  try {
    const res = await fetch('/api/jczx/prioritize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: S.rootId, rels: list }),
    })
    return await res.json()
  } catch { return null }
}

async function openPendingUnpack(item, opts) {
  const rel = item.bundleRel
  setBusy(true, t('等待解包…'))
  setLoadProgress({ stage: t('阶段：解包'), indeterminate: true })
  if (S.mode === 'jczx') await prioritizeJczx([rel])
  else await prioritizeNikke([rel], [])
  toast(t('解包优先已排到队首'))
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const prog = S.mode === 'jczx' ? await fetchJczxProgress() : await fetchNikkeProgress()
    if (prog) setUnpackProgress(prog)
    const still = prog && ((prog.pendingRels || []).includes(rel) || (prog.currentRels || []).includes(rel)
      || (prog.current || []).includes(String(rel).split('/').pop()))
    // 不在 pending/inFlight 里了 → 认为已经处理完（成功或跳过）
    if (prog && !still && (prog.found || prog.bundles)) break
    await new Promise(r => setTimeout(r, 400))
  }
  // 强制重扫拿到真资产
  await scan(true)
  const base = String(rel).split('/').pop()
  const found = allItems().find(i => i.ok && !i.pendingUnpack && (
    i.bundleRel === rel ||
    (i.folder && i.folder.includes(base)) ||
    (i.base && base.startsWith(i.base)) ||
    (i.relAtlas && i.relAtlas.includes(base))
  ))
  setBusy(false)
  if (found) {
    selectItem(found)
    if (opts && opts.fullscreen) setFullscreen(true)
  } else {
    showError(t('等待解包…') + ' — ' + base)
    setView('grid')
  }
}

/* 上一次返回被哪一层消化了（'none' = 交给宿主退 App）。
   排障用：真机按返回没反应时，一眼能看出是页面吃掉了还是宿主没接住。 */
let lastBackReason = 'none'

/* ------------------------------------------------------- 返回键的分层消化

   一次「返回」该退到哪：从最上面那层往下一层层剥，剥干净了才轮到退 App。
   层次由内到外 ——
     1. 弹出的对话框（设置 / 上传 / 帮助 / 卡片菜单 / 删除确认）
     2. 全屏下的文件侧栏
     3. 底部抽屉（资产 / 操作 / 图层）
     4. 批量选择模式
     5. 全屏（沉浸）
     6. 播放页 → 资产页（平铺）
     7. 已经在最外层

   这才是「播放页和资产页的层级区分」：播放页是资产页的**下一层**，
   在播放页按返回是回资产页，不是退出软件。

   @returns {boolean} true = 这次返回被页面消化了，调用方不要再往下走
*/
function handleBack() {
  const done = why => { lastBackReason = why; return true }
  // 1. 任何对话框先把它的「取消」跑完（删除确认要靠这个 resolve(false)）
  const confirm = $('confirmModal')
  if (confirm && !confirm.hidden) {
    if (typeof confirm.__cancel === 'function') confirm.__cancel()
    else confirm.hidden = true
    return done('confirm')
  }
  for (const id of ['settingsModal', 'uploadModal', 'helpModal', 'cardMenu']) {
    const m = $(id)
    if (m && !m.hidden) { m.hidden = true; return done('modal:' + id) }
  }
  // 2. 全屏里拉出来的文件侧栏
  if (fsMode && fsFilesOpen) { toggleFsFiles(false); return done('fsFiles') }
  // 3. 底部抽屉
  if (sheetOpen) { closeSheet(); return done('sheet:' + sheetOpen) }
  // 4. 批量选择
  if (selectMode) { setSelectMode(false); return done('selectMode') }
  // 5. 全屏
  if (fsMode) { setFullscreen(false); return done('fullscreen') }
  // 6. 播放页回资产页
  if (viewMode === 'player') { setView('grid'); return done('player->grid') }
  lastBackReason = 'none'          // 已在最外层 —— 该退 App 了
  return false
}

/* ---------------------------------------------------------------- 选择与删除

   一张卡片 = 一整套资产（atlas + skeleton + 它引用的贴图）。
   · 扫描出来的资产 —— 磁盘上的真文件，删除走原生 / 服务端接口，**不可恢复**；
   · 上传的资产 —— 只活在当前会话里，直接把对象丢掉。
   两条路都要先过 confirmDelete() 那道「带文件清单」的二次确认。

   长按（触屏）或右键（桌面）卡片 → 操作菜单；也可以点「选择」进批量模式。 */

let selectMode = false
let selectedKeys = new Set()
let menuItem = null

/** 上传的资产有 key；扫描出来的是磁盘文件。 */
function isDiskItem(item) { return !!item && !item.key }

function setSelectMode(on) {
  selectMode = !!on
  if (!selectMode) selectedKeys.clear()
  document.body.classList.toggle('card-select', selectMode)
  if (viewMode === 'grid') renderGallery()
  applySelectUI()
}

function toggleSelectKey(key) {
  if (selectedKeys.has(key)) selectedKeys.delete(key)
  else selectedKeys.add(key)
  for (const c of document.querySelectorAll('#galGrid .card')) {
    if (c.dataset.key === key) c.classList.toggle('sel', selectedKeys.has(key))
  }
  applySelectUI()
}

function applySelectUI() {
  const bar = $('galSelBar')
  const btn = $('galSelect')
  const n = selectedKeys.size
  if (bar) bar.hidden = !selectMode
  if (btn) {
    btn.textContent = t(selectMode ? '退出选择' : '选择')
    btn.setAttribute('aria-pressed', String(selectMode))
  }
  const cnt = $('galSelCount')
  if (cnt) cnt.textContent = n ? t('已选 {n} 个', { n }) : t('未选择')
  const del = $('galSelDelete')
  if (del) del.disabled = n === 0
  const all = $('galSelAll')
  if (all) {
    const total = document.querySelectorAll('#galGrid .card').length
    all.checked = total > 0 && n >= total
    all.indeterminate = n > 0 && n < total
  }
}

/** 把当前选中的 key 还原成资产对象（列表可能刚被过滤过） */
function selectedItems() {
  return allItems().filter(i => selectedKeys.has(itemKey(i)))
}

/**
 * 资产在磁盘上的绝对路径。
 *   kind = 'dir'  → 这个资产**所在的目录**（BD2 的 mod 一个目录就是一套，日常最常用这个）
 *   kind = 'file' → 图集文件本身
 *
 * 资产条目里存的是相对根目录的路径（`relAtlas`，用 `/` 分隔），
 * 根目录的绝对路径在 `S.rootPath`（扫描响应带回来的）。
 * 拿不到根路径（原生 SAF 数据源 / 会话内上传的资产）时返回 null ——
 * 上层据此把复制按钮禁掉，而不是拼一条假的路径给用户。
 */
function absPathOf(item, kind = 'dir') {
  if (!item || !S.rootPath) return null
  const rel = String(item.relAtlas || item.id || '')
  if (!rel) return null
  // Windows 的根目录形如 `E:\a\b`，相对路径一律 `/` 分隔 —— 分隔符跟着根目录走
  const sep = S.rootPath.includes('\\') ? '\\' : '/'
  const root = S.rootPath.replace(/[\\/]+$/, '')
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length) return null
  if (kind === 'file') return root + sep + parts.join(sep)
  const dir = parts.slice(0, -1)
  // 资产就摆在根目录下（没有子目录）时，「所在目录」就是根目录本身
  return dir.length ? root + sep + dir.join(sep) : root
}

/**
 * 复制文本到剪贴板。三条路，按「哪条更可能成功」排：
 *   ① 安卓壳的原生剪贴板口 —— WebView 里 navigator.clipboard 经常不可用
 *      （照 setFullscreen 的写法：直接调，桌面没有这个口会被 try 吞掉）
 *   ② 浏览器 Clipboard API —— 桌面版跑在 http://127.0.0.1，属于安全上下文，可用
 *   ③ 临时 textarea + execCommand —— 非安全上下文 / 剪贴板权限被拒时的兜底
 */
/**
 * 资产相对根目录的「所在文件夹」路径（用 /）。
 * 资产直接放在根下时返回 ''（空 = 根目录本身，不能整夹删除）。
 */
function relDirOfItem(item) {
  const rel = String(item?.relAtlas || item?.id || '').split(/[/\\]/).filter(Boolean)
  if (rel.length <= 1) return ''
  return rel.slice(0, -1).join('/')
}

/** 与某文件夹同目录（或更深）的磁盘资产 */
function itemsUnderRelDir(relDir) {
  const prefix = relDir ? relDir.replace(/\/+$/, '') + '/' : ''
  return allItems().filter(i => {
    if (!isDiskItem(i)) return false
    const d = relDirOfItem(i)
    if (!relDir) return true
    return d === relDir || d.startsWith(prefix)
  })
}


async function copyToClipboard(text) {
  if (!text) return false
  try { window.BD2Native.copyText(text); return true } catch { /* 桌面版没有这个口 */ }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch { /* 没权限 / 非安全上下文，往下兜 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // 不能 display:none（选不中），放到屏幕外再选
    ta.style.cssText = 'position:fixed;top:0;left:-10000px;opacity:0'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch { return false }
}

/** 卡片菜单里那两颗「复制路径」按钮：有绝对路径才可点，顺手把路径摆在下面给人看 */
function syncCardMenuPath(item) {
  const box = $('cardMenuPath')
  const dirBtn = $('cardMenuCopyDir')
  const fileBtn = $('cardMenuCopyFile')
  const dir = absPathOf(item, 'dir')
  const file = absPathOf(item, 'file')

  if (box) {
    if (dir) {
      box.hidden = false
      box.textContent = dir           // 路径是用户数据，不进翻译表
      box.title = file || dir
    } else {
      box.hidden = true
      box.textContent = ''
      box.title = ''
    }
  }
  const why = t('这个数据源没有可复制的本地路径')
  for (const [btn, val] of [[dirBtn, dir], [fileBtn, file]]) {
    if (!btn) continue
    btn.disabled = !val
    btn.title = val || why
  }
  return { dir, file }
}

/** 长按 / 右键卡片弹出的操作菜单 */
function openCardMenu(item) {
  if (!item) return
  menuItem = item
  const name = $('cardMenuName')
  const info = $('cardMenuInfo')
  if (name) name.textContent = `${item.folder} / ${item.base}`
  if (info) {
    if (isDiskItem(item)) {
      const bits = [`atlas: ${item.relAtlas || item.id}`]
      if (item.relSkeleton) bits.push(String(item.relSkeleton))
      if (item.relImages?.length) bits.push(t('{n} 张贴图', { n: item.relImages.length }))
      info.textContent = t('磁盘文件 · {bits}', { bits: bits.join(' · ') })
    } else {
      info.textContent = t('本次会话上传的资产（不在磁盘上）')
    }
  }
  // 绝对路径 + 两颗复制按钮的可用性，跟着当前这张卡走（每开一次都要重算）
  syncCardMenuPath(item)
  $('cardMenu').hidden = false
}

/** 二次确认；resolve(true) = 用户确认。删除不可恢复，所以清单必须摆出来。 */
function confirmDelete(items) {
  return new Promise(resolve => {
    const mask = $('confirmModal')
    const list = $('confirmList')
    const diskCount = items.filter(isDiskItem).length

    $('confirmTitle').textContent = items.length === 1 ? t('删除这个资产？') : t('删除 {n} 个资产？', { n: items.length })
    $('confirmWarn').innerHTML = diskCount
      ? t('⚠️ 此操作非常危险，可能导致不可逆的数据丢失！<br>将<b>真正删除磁盘上的 {n} 套资产文件</b>（atlas / skeleton / 贴图），无法恢复。', { n: diskCount })
      : t('这些是本次会话上传的资产，移除后需要重新上传。')

    list.innerHTML = ''
    for (const it of items) {
      const row = document.createElement('div')
      row.className = 'confirm-row'
      const nm = document.createElement('div')
      nm.className = 'cr-name'
      nm.textContent = `${it.folder || t('（根目录）')} / ${it.base}`
      const fl = document.createElement('div')
      fl.className = 'cr-files'
      const bits = []
      if (isDiskItem(it)) {
        if (it.relAtlas || it.id) bits.push(String(it.relAtlas || it.id))
        if (it.relSkeleton) bits.push(String(it.relSkeleton))
        if (it.relImages?.length) bits.push(t('+{n} 张贴图', { n: it.relImages.length }))
        // 资产自带的缩略图（Lost Sword 的 thumb.png）也在这次删除范围内，别漏报
        if (it.relThumb) bits.push(String(it.relThumb))
        // NIKKE 分组（R18）：姿势变体的文件随这套一起删，要一并列出来给人核对
        if (Array.isArray(it.members) && it.members.length > 1) {
          bits.push(t('+{n} 个姿势文件', {
            n: it.members.slice(1).map(m => m.item || m).filter(isDiskItem).length,
          }))
        }
      } else {
        bits.push(t('（会话内上传，不在磁盘上）'))
      }
      fl.textContent = bits.join('  ·  ')
      row.appendChild(nm); row.appendChild(fl)
      list.appendChild(row)
    }
    $('confirmYes').textContent = t(diskCount ? '确认删除' : '移除')
    mask.hidden = false

    const onMask = e => { if (e.target === mask) done(false) }
    const done = ok => {
      mask.hidden = true
      mask.__cancel = null
      mask.removeEventListener('click', onMask)
      $('confirmYes').onclick = null
      $('confirmNo').onclick = null
      resolve(ok)
    }
    // 返回键要能「取消」这个确认框。取消入口挂在元素上，handleBack() 就不必
    // 认识这里的局部闭包 —— 否则 Promise 永远不 resolve，删除流程会挂在半路。
    mask.__cancel = () => done(false)
    mask.addEventListener('click', onMask)
    $('confirmYes').onclick = () => done(true)
    $('confirmNo').onclick = () => done(false)
  })
}

/** 交给原生 / 服务端真删磁盘文件。两边都返回 {deleted:[relAtlas..], failed:[{relAtlas,reason}]}
 *  NIKKE 分组条目（R18）在这里摊开成成员 —— 变体的文件跟主条目一起删。 */
async function removeItemsOnDisk(items) {
  const payload = []
  for (const i of items) {
    for (const m of (Array.isArray(i.members) ? i.members : [i])) {
      const it = m.item || m
      payload.push({
        relAtlas: it.relAtlas || it.id || '',
        relSkeleton: it.relSkeleton || null,
        relThumb: it.relThumb || null,
        relImages: it.relImages || [],
      })
    }
  }
  if (NATIVE) {
    const raw = window.BD2Native.deleteItems(S.rootId || '', JSON.stringify(payload))
    return JSON.parse(raw || '{}')
  }
  const res = await fetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootId: S.rootId, items: payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || t('删除失败'))
  return data
}

/** 删除 / 移除一批资产（调用前必须已确认）。 */
async function runDelete(items) {
  items = (items || []).filter(Boolean)
  if (!items.length) return

  const disk = items.filter(isDiskItem)
  const local = items.filter(i => !isDiskItem(i))
  const gone = new Set()

  setBusy(true, t(disk.length ? '正在删除…' : '正在移除…'))
  let failed = []
  try {
    if (local.length) {
      S.customItems = S.customItems.filter(i => !local.includes(i))
      for (const it of local) gone.add(itemKey(it))
    }
    if (disk.length) {
      const res = await removeItemsOnDisk(disk)
      for (const k of res.deleted || []) gone.add(String(k))
      failed = res.failed || []
      // 整套没删干净（还有文件残留在磁盘上）就不该从列表里消失
      for (const f of failed) gone.delete(String(f.relAtlas))
    }
  } catch (err) {
    setBusy(false)
    showError(t('删除失败：') + err.message)
    return
  }
  setBusy(false)

  if (gone.size) {
    S.items = S.items.filter(i => !gone.has(itemKey(i)))
    // 手动顺序里的记录跟着清掉，否则记录会越攒越长
    const order = loadOrder()
    if (order.length) saveOrder(order.filter(k => !gone.has(k)))
    // 缩略图缓存也跟着清，别白占空间（NIKKE 分组的成员一并清，R18）
    for (const it of items) {
      for (const m of (Array.isArray(it.members) ? it.members : [it])) {
        const tk = thumbKey(m.item || m)
        thumbCache.delete(tk)
        thumbFailed.delete(tk)
        idbDel(tk)
      }
    }
    // 正在看的就是被删的那个 → 退回平铺页
    if (S.current && gone.has(itemKey(S.current))) {
      S.current = null
      disposePlayer()
      const es = $('emptyState')
      if (es) es.hidden = false
      setView('grid')
    }
  }

  // 没删掉的保持选中，方便用户看一眼失败的是哪些再重试
  selectedKeys = new Set(items.filter(i => !gone.has(itemKey(i))).map(itemKey))
  refreshLists()
  applySelectUI()

  if (failed.length) {
    showError(t('有 {n} 个资产没能删除：', { n: failed.length }) + failed.map(f => f.reason || f.relAtlas).join('；'))
  }
  toast(gone.size ? t('已删除 {n} 个资产', { n: gone.size }) : t('没有资产被删除'))
}

/** 当前选中的根是否允许从配置列表移除（安卓自动目录 __* 不可移除）。 */
function canRemoveRoot(rootId) {
  if (!rootId) return false
  if (NATIVE && String(rootId).startsWith('__')) return false
  return !!(S.config && Array.isArray(S.config.roots) && S.config.roots.some(r => r.id === rootId))
}

/** 顶栏「删除这个文件路径」可用性：跟当前下拉选中项走。
 *  安卓只有用户授权的 SAF 根可移除；若列表里一个都没有，整颗按钮藏起来，避免顶栏挤。 */
function syncRemoveRootBtn() {
  const btn = $('btnRemoveRoot')
  if (!btn) return
  const roots = (S.config && S.config.roots) || []
  const anyRemovable = roots.some(r => r && r.id && !(NATIVE && String(r.id).startsWith('__')))
  // 桌面始终显示（配置里的 roots 都能移除）；安卓无用户根时隐藏
  btn.hidden = NATIVE && !anyRemovable
  const id = S.rootId
  const ok = canRemoveRoot(id)
  btn.disabled = !ok
  if (!id) {
    btn.title = t('没有可移除的根目录')
  } else if (NATIVE && String(id).startsWith('__')) {
    btn.title = t('系统自动目录不能从列表移除')
  } else {
    btn.title = t('从配置列表移除当前根目录（不删磁盘文件）')
  }
}

/** 二次确认：只从配置列表去掉根路径，不碰磁盘。 */
function confirmRemoveRoot(root) {
  return new Promise(resolve => {
    const mask = $('confirmModal')
    const list = $('confirmList')
    const label = (root && (root.label || root.path || root.id)) || ''
    const pathStr = (root && root.path) || ''
    $('confirmTitle').textContent = t('移除这个文件路径？')
    $('confirmWarn').innerHTML = t(
      '⚠️ 只会从查看器配置里去掉这条根路径，<b>不会删除磁盘上的任何文件</b>。之后可再点「添加目录」加回来。',
    )
    list.innerHTML = ''
    const row = document.createElement('div')
    row.className = 'confirm-row'
    const nm = document.createElement('div')
    nm.className = 'cr-name'
    nm.textContent = label
    const fl = document.createElement('div')
    fl.className = 'cr-files'
    fl.textContent = pathStr || String((root && root.id) || '')
    row.appendChild(nm); row.appendChild(fl)
    list.appendChild(row)
    $('confirmYes').textContent = t('确认移除')
    mask.hidden = false
    const onMask = e => { if (e.target === mask) done(false) }
    const done = ok => {
      mask.hidden = true
      mask.__cancel = null
      mask.removeEventListener('click', onMask)
      $('confirmYes').onclick = null
      $('confirmNo').onclick = null
      resolve(ok)
    }
    mask.__cancel = () => done(false)
    mask.addEventListener('click', onMask)
    $('confirmYes').onclick = () => done(true)
    $('confirmNo').onclick = () => done(false)
  })
}

/** 调服务端 / 原生：从配置列表移除根路径（不删磁盘）。 */
async function removeRootFromConfig(rootId) {
  if (NATIVE) {
    if (!window.BD2Native.removeRoot) throw new Error(t('移除路径失败：') + 'native removeRoot unavailable')
    const raw = window.BD2Native.removeRoot(String(rootId || ''))
    const data = JSON.parse(raw || '{}')
    if (!data.ok) throw new Error(data.error || t('删除失败'))
    return data
  }
  const res = await fetch('/api/roots', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rootId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || t('删除失败'))
  return data
}

/**
 * 从配置列表移除当前根路径（不删磁盘文件）。
 * 成功后刷新根列表；若还有剩余则切到第一个并重扫，否则清空并提示添加。
 */
async function runRemoveRoot() {
  const id = S.rootId
  if (!canRemoveRoot(id)) {
    showError(id && NATIVE && String(id).startsWith('__')
      ? t('系统自动目录不能从列表移除')
      : t('没有可移除的根目录'))
    return
  }
  const root = (S.config.roots || []).find(r => r.id === id)
  if (!root) {
    showError(t('没有可移除的根目录'))
    return
  }
  if (!await confirmRemoveRoot(root)) return
  try {
    await removeRootFromConfig(id)
  } catch (err) {
    showError(t('移除路径失败：') + err.message)
    return
  }
  // 刷新配置里的 roots
  if (NATIVE) {
    try {
      S.config.roots = await nativeAsk('roots', () => window.BD2Native.requestRoots(), 15000)
    } catch {
      S.config.roots = (S.config.roots || []).filter(r => r.id !== id)
    }
  } else {
    await loadConfig()
  }
  const label = root.label || root.path || id
  // 清掉当前播放 / 列表，避免还指向已移除的根
  S.current = null
  disposePlayer()
  S.items = []
  S.rootPath = ''
  selectedKeys.clear()
  const remain = S.config.roots || []
  S.rootId = remain.length ? remain[0].id : null
  renderRootOptions()
  syncRemoveRootBtn()
  applySelectUI()
  const es = $('emptyState')
  if (es) es.hidden = false
  setView('grid')
  if (S.rootId) {
    try { await scan(true) } catch { refreshLists() }
  } else {
    refreshLists()
  }
  toast(t('已从配置移除：{label}', { label }))
}

function renderGallery() {
  const grid = $('galGrid')
  if (!grid) return
  const items = filteredItems()
  const count = $('galCount')
  if (count) count.textContent = t('平铺浏览 · {n} 个 L2D', { n: items.length })
  grid.innerHTML = ''
  for (const item of items) grid.appendChild(galleryCard(item))
  thumbKick()
}

function galleryCard(item) {
  const key = itemKey(item)
  const el = document.createElement('div')
  el.className = 'card' + (item.ok ? '' : ' bad') +
    (item.pendingUnpack ? ' pending-unpack' : '') +
    (S.current && itemKey(S.current) === key ? ' active' : '') +
    (selectMode && selectedKeys.has(key) ? ' sel' : '')
  el.dataset.key = key
  el.__item = item          // 长按菜单要用（拖动引擎只拿到元素）
  // 这两条 title 只含我们自己写的常量（从翻译表取），不含用户数据 → 直接拼进 HTML 是安全的。
  el.innerHTML =
    `<div class="card-drag" title="${t('拖动调整播放顺序')}">⠿</div>` +
    '<div class="card-check" aria-hidden="true"></div>' +
    '<div class="card-thumb pending"></div>' +
    `<button class="card-fs" title="${t('直接全屏播放')}">⛶</button>` +
    '<div class="card-info"><div class="card-name"></div><div class="card-sub"></div>' +
    '<div class="card-hit" hidden></div></div>'

  el.querySelector('.card-name').textContent = displayNameOf(item)
  el.querySelector('.card-sub').textContent = item.pendingUnpack
    ? t('尚未解包')
    : item.imageOnly
      ? t('CG · {n} 张', { n: (item.images || []).length })
      : (S.mode === 'ark' && item.ark ? arkCardSub(item)
        : item.base + (item.skeletonKind ? `.${item.skeletonKind}` : '') +
          t(' · {n} 图', { n: (item.images || []).length }))

  // 搜索命中的是**内部资源文件**（不是目录名 / 文件名）时，卡片上要说明一句，
  // 否则用户看到一堆名字里没有关键词的卡片会以为搜错了。
  const hit = searchHits.get(key)
  if (hit) {
    const box = el.querySelector('.card-hit')
    box.hidden = false
    box.textContent = `🔍 ${hit}`
    box.title = t('匹配到的资源文件：{name}', { name: hit })
  }

  const thumb = el.querySelector('.card-thumb')
  // 优先：内存/IndexedDB 已生成的图 → 磁盘自带 thumb.png → 再离屏渲。
  // 有现成的就绝不进队列（以前缓存命中仍 observe，偶发会重渲）。
  const lookup = thumbCacheLookup(item)
  const builtin = builtinThumbUrl(item)
  const stillUrl = item.imageOnly && item.relImages && item.relImages[0] ? assetUrl(item.relImages[0]) : null
  if (lookup && lookup.url) setCardThumb(thumb, lookup.url)
  else if (lookup && lookup.failed) setCardThumbFailed(thumb)
  else if (builtin) setCardThumb(thumb, builtin)
  else if (stillUrl) setCardThumb(thumb, stillUrl)

  el.addEventListener('click', e => {
    // 拖动结束时浏览器补的那一下 click：只吃掉「被拖那张卡」在 700ms 内的这一下，
    // 其它卡片、以及过期之后的操作都不受影响。
    if (suppressClick && e.target.closest('.card') === suppressClick.el &&
        Date.now() < suppressClick.until) { suppressClick = null; return }
    if (e.target.closest('.card-drag') || e.target.closest('.card-fs')) return
    // 选择模式下点击 = 勾选，不打开资产
    if (selectMode) { toggleSelectKey(key); return }
    openItem(item)
  })
  el.querySelector('.card-fs').addEventListener('click', e => {
    e.stopPropagation()
    if (selectMode) { toggleSelectKey(key); return }
    openItem(item, { fullscreen: true })
  })
  // 桌面：右键等同长按。触屏的长按在拖动引擎里判定（按下后一直不动 → 弹菜单）。
  el.addEventListener('contextmenu', e => {
    e.preventDefault()
    if (selectMode) { toggleSelectKey(key); return }
    openCardMenu(item)
  })
  // 需求 3：只有 ⠿ 把手起手才拖；主体 click / 短按 = 打开；触屏主体长按 = 菜单。
  // 放大镜 (.card-fs) 独立，不进拖拽状态机。判定都在 startCardDrag 里做。
  el.addEventListener('pointerdown', e => {
    if (e.isPrimary === false) return                    // 多指：只认第一根手指，换指时卡片不会跳位
    if (e.button != null && e.button !== 0) return        // 只认主键
    if (e.target.closest('.card-fs')) return              // 全屏按钮有自己的功能
    startCardDrag(e, el)
  })

  // 已有缓存 / 失败标记 / 磁盘 thumb.png / 尚未解包占位：都不进离屏渲染队列
  if (!item.pendingUnpack && !item.imageOnly && !(lookup && (lookup.url || lookup.failed)) && !builtin) {
    if (thumbObserver) thumbObserver.observe(el)
    else el.__wantThumb = true
  }
  return el
}

function setCardThumb(box, url) {
  if (!box) return
  box.classList.remove('pending')
  if (box.querySelector('img')) return
  const img = document.createElement('img')
  img.src = url
  img.alt = ''
  img.draggable = false
  box.appendChild(img)
}

function updateThumbStatus() {
  const el = $('galThumb')
  const cards = document.querySelectorAll('#galGrid .card')
  const total = cards.length
  const done = [...cards].filter(c => !c.querySelector('.card-thumb.pending')).length
  if (!total || done >= total) {
    if (el) el.hidden = true
    setThumbProgress(0, 0)
    return
  }
  if (el) {
    el.hidden = false
    el.textContent = t('缩略图 {done}/{total}', { done, total })
  }
  setThumbProgress(done, total)
}

/** 依次给视野里的卡片生成缩略图；播放页不抢 GL，回平铺页再继续 */
function thumbKick() {
  if (thumbRunning || viewMode !== 'grid') return
  const grid = $('galGrid')
  if (!grid) return
  const itemMap = new Map(filteredItems().map(i => [itemKey(i), i]))
  const card = [...grid.querySelectorAll('.card')].find(c =>
    c.__wantThumb && !c.querySelector('.card-thumb img') && !thumbAsked.has(thumbKey(itemMap.get(c.dataset.key) || {})))
  if (!card) { updateThumbStatus(); return }
  const item = itemMap.get(card.dataset.key)
  if (!item || !item.ok) { card.__wantThumb = false; updateThumbStatus(); setTimeout(thumbKick, 0); return }
  const key = thumbKey(item)
  // 已有本地缓存（含 mtime 漂移后的旧 key）→ 直接贴上，绝不重渲/重拉
  const existing = thumbCacheLookup(item)
  if (existing && existing.url) {
    card.__wantThumb = false
    setCardThumb(card.querySelector('.card-thumb'), existing.url)
    updateThumbStatus()
    setTimeout(thumbKick, 0)
    return
  }
  if (existing && existing.failed) {
    card.__wantThumb = false
    setCardThumbFailed(card.querySelector('.card-thumb'))
    updateThumbStatus()
    setTimeout(thumbKick, 0)
    return
  }
  const disk = builtinThumbUrl(item)
  if (disk) {
    card.__wantThumb = false
    setCardThumb(card.querySelector('.card-thumb'), disk)
    updateThumbStatus()
    setTimeout(thumbKick, 0)
    return
  }
  thumbAsked.add(key)
  thumbRunning = true
  makeThumb(item).then(url => {
    card.__wantThumb = false
    thumbCache.set(key, url)
    idbPut(key, url)
    setCardThumb(card.querySelector('.card-thumb'), url)
    thumbDone++
  }).catch(() => {
    // 生成失败（坏文件 / 超时）：标成失败态、不再重试，队列继续往后走，
    // 不允许一张坏卡片把后面所有缩略图都堵住。
    // 失败结论也存进 IndexedDB（空串），下次启动不再去重新拉那个坏文件。
    card.__wantThumb = false
    thumbFailed.add(key)
    idbPut(key, '')
    setCardThumbFailed(card.querySelector('.card-thumb'))
  }).finally(() => {
    thumbRunning = false
    updateThumbStatus()
    setTimeout(thumbKick, 80)
  })
}

/** 生成失败的卡片：换成「无法生成」的占位（不再是转圈等的 pending 态） */
function setCardThumbFailed(box) {
  if (!box) return
  box.classList.remove('pending')
  box.classList.add('failed')
}

/**
 * 用一次性离屏播放器渲一帧当缩略图。
 * 尺寸小、只取默认动画的中段姿势，渲完立刻 dispose（WebView 的 GL 上下文数量有限）。
 * 坏文件必须「快速失败」：spine-player 内部 JSON.parse 抛的 SyntaxError 不走 error
 * 回调，promise 永不 settle，整个缩略图队列就卡死在那里（2026-09-25 用户实测）。
 * 所以先自己验一遍 JSON，再加兜底超时，保证任何情况下队列都能继续往下走。
 */
async function makeThumb(item, size = 220) {
  const urls = urlsForItem(item)
  // 离屏播放器用到的 blob（3.x→4.x 转换产物）在本函数结束时回收 —— 缩略图队列
  // 和主播放器可能同时在跑，所以用局部数组，不碰主播放器那份。
  const thumbBlobs = []
  attachNativeSkeleton(item, urls)
  if (urls.__nativeBlob) thumbBlobs.push(urls.__nativeBlob)
  // ① 骨架 JSON 预校验（.skel 二进制骨架没有这一步，跳过）。
  //    3.x 的顺手转成 4.x 能读的形状，直接用转换结果建 blob URL（省一次下载）。
  const rawJsonUrl = urls.jsonUrl ||
    (urls.skeletonUrl && urls.skeletonKind === 'json' ? urls.skeletonUrl : null)
  let jsonCompat = null
  if (rawJsonUrl) {
    const res = await fetch(rawJsonUrl)
    if (!res.ok) throw new Error(t('读不到骨架文件（HTTP {status}）', { status: res.status }))
    const text = await res.text()
    try { JSON.parse(text) } catch (e) { throw new Error(t('JSON 损坏：{msg}', { msg: e.message })) }
    if (/"spine"\s*:\s*"3\./.test(text.slice(0, 4096))) {
      item._spine38 = true
      const fixed = spineJson38to41(text)
      if (fixed) {
        const blob = URL.createObjectURL(new Blob([fixed], { type: 'application/json' }))
        thumbBlobs.push(blob)
        jsonCompat = { url: blob, blob }
      }
    }
  }

  // ② 按骨架版本挑运行时（NIKKE 4.0 / BD2·Lost Sword 4.1）。缩略图队列和主播放器
  //    可能同时在跑，所以这里用局部 rt，不去动 S.spine。
  const minor = await spineMinorFor(item)
  // 旧世代的**二进制**骨架没有对应运行时：与其拿 4.x 硬读出一张坏图（还会浪费一次
  // 离屏渲染），直接判失败让卡片走「无缩略图」占位 —— 点进去时正片会给那句明确提示。
  // （JSON 的 3.x 已被上面的转换救回来，spineMinorFor 会报 4.1，不会走到这里。）
  if (minor && !/^4\.[012]$/.test(minor)) throw new Error(t('不支持的 Spine 版本：{v}', { v: minor }))
  const rt = spineRuntimeForVer(minor)

  const host = document.createElement('div')
  host.style.cssText =
    `position:fixed;left:0;top:0;width:${size}px;height:${Math.round(size * 0.72)}px;` +
    'pointer-events:none;opacity:0;z-index:-1'
  document.body.appendChild(host)
  let player = null
  let done = false
  let timer = 0
  const cleanup = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    try { player?.dispose() } catch { /* ignore */ }
    host.remove()
    for (const u of thumbBlobs) { try { URL.revokeObjectURL(u) } catch { /* ignore */ } }
  }

  try {
    // 两层角色（R19）时两个播放器都必须**透明**（alpha:true + 透明背景），
    // 由合成画布负责铺底色 —— 否则主体的不透明背景会把背层整个盖住（实测过）。
    const layered = !!item.backLayer
    const p = await new Promise((resolve, reject) => {
      // ② 兜底超时：就算播放器内部再出幺蛾子（不走 error 回调），队列也能继续
      timer = setTimeout(() => reject(new Error(t('缩略图生成超时'))), 25000)
      const cfg = {
        showControls: false,
        showLoading: false,
        atlasUrl: urls.atlasUrl,
        backgroundColor: layered ? '00000000' : (S.bgColor || '#1f2937'),
        premultipliedAlpha: S.premultiplied,
        alpha: layered,
        preserveDrawingBuffer: true,
        viewport: { padLeft: 6, padRight: 6, padTop: 6, padBottom: 6, transitionTime: 0, animations: {} },
        success: p => resolve(p),
        error: (p, msg) => reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))),
      }
      applySkeletonCfg(cfg, urls, jsonCompat)
      if (Object.keys(urls.rawDataURIs || {}).length) cfg.rawDataURIs = urls.rawDataURIs
      try { player = new rt.SpinePlayer(host, cfg) } catch (e) { reject(e) }
    })
    player = p
    // 多皮肤骨架（Lost Sword 常见）的 default 皮肤只有零头：缩略图同样挑覆盖最全的
    // 皮肤 + default 垫底合成，否则卡片上是个残缺角色。失败不影响出图。
    try {
      const data = p.skeleton?.data
      if (data && (data.skins || []).length > 1) {
        const best = fullestSkin(data, rt)
        const composed = composeSkin(rt, data, best.name)
        if (composed) p.skeleton.setSkin(composed)
        else p.skeleton.setSkinByName(best.name)
        p.skeleton.setSlotsToSetupPose()
      }
    } catch { /* 尽力而为 */ }
    const anims = (p.animationState?.data?.skeletonData?.animations || []).map(a => a.name)
    const name = anims.find(n => /idle/i.test(n)) || anims[0] || null
    if (name) {
      try {
        p.animationState.setAnimation(0, name, true)
        // 让它自己走几帧，避开绑定姿势/起始空帧
        await new Promise(r => setTimeout(r, 260))
        try { p.setViewport(name) } catch { /* 用默认取景 */ }
        for (let i = 0; i < 3; i++) { p.drawFrame(false); await new Promise(r => requestAnimationFrame(r)) }
      } catch { /* 尽力而为 */ }
    }
    // 两层角色（R19）：把背层也渲进卡面 —— 有些角色 `_F` 只有十来个 region
    // （实测 Lobby_Morganlefay：F=10 / B=94），只画本体层卡片几乎是空的。
    // 背层失败就当单层，不影响出图。
    const backUrl = item.backLayer ? urlsForItem(item.backLayer) : null
    // 背层理论上也是 4.x（Lost Sword），但同一套兜底顺手接上，免得以后出个 3.8 背层又踩一遍
    const backCompat = backUrl && backUrl.skeletonKind === 'json'
      ? await spineJsonUrlFor(item.backLayer, backUrl) : null
    if (backCompat && backCompat.blob) thumbBlobs.push(backCompat.blob)
    let backP = null
    if (backUrl) {
      try {
        const brt = spineRuntimeForVer(await spineMinorFor(item.backLayer))
        const bhost = document.createElement('div')
        bhost.style.cssText = host.style.cssText
        document.body.appendChild(bhost)
        host.__backHost = bhost
        backP = await new Promise((resolve, reject) => {
          const bt = setTimeout(() => reject(new Error('back timeout')), 20000)
          const bcfg = Object.assign({}, {
            showControls: false, showLoading: false,
            atlasUrl: backUrl.atlasUrl,
            backgroundColor: '00000000',
            premultipliedAlpha: S.premultiplied,
            alpha: true, preserveDrawingBuffer: true,
            viewport: { padLeft: 6, padRight: 6, padTop: 6, padBottom: 6, transitionTime: 0, animations: {} },
            success: bp => { clearTimeout(bt); resolve(bp) },
            error: (bp, msg) => { clearTimeout(bt); reject(new Error(String(msg))) },
          })
          applySkeletonCfg(bcfg, backUrl, backCompat)
          if (Object.keys(backUrl.rawDataURIs || {}).length) bcfg.rawDataURIs = backUrl.rawDataURIs
          try { const bp = new brt.SpinePlayer(bhost, bcfg); host.__backPlayer = bp } catch (e) { clearTimeout(bt); reject(e) }
        })
        // 背层跟本体用同一个姿势：同一个动画名 + 同一时间点
        try {
          const bAnims = (backP.animationState?.data?.skeletonData?.animations || []).map(a => a.name)
          const bn = name && bAnims.includes(name) ? name : (bAnims.find(n => /idle/i.test(n)) || bAnims[0])
          if (bn) {
            backP.animationState.setAnimation(0, bn, true)
            await new Promise(r => setTimeout(r, 200))
            // 和主体那条路一样：先按动画名让播放器算好取景，否则背层会被画到画布外
            try { backP.setViewport(bn) } catch { /* 用默认取景 */ }
            const me = p.animationState.getCurrent(0)
            const be = backP.animationState.getCurrent(0)
            if (me && be) be.trackTime = me.trackTime
            backP.animationState.apply(backP.skeleton)
            backP.skeleton.updateWorldTransform()
          }
          backP.drawFrame(false)
        } catch { /* 背层姿势同步失败也用它的默认姿势 */ }
      } catch { backP = null }
    }
    const canvas0 = p.canvas
    let canvas = canvas0
    if (backP && backP.canvas && backP.canvas.width) {
      try {
        const off = document.createElement('canvas')
        off.width = canvas0.width
        off.height = canvas0.height
        const c = off.getContext('2d')
        c.fillStyle = S.bgColor || '#1f2937'                     // 底色由合成层负责
        c.fillRect(0, 0, off.width, off.height)
        c.drawImage(backP.canvas, 0, 0, off.width, off.height)   // 背层在下
        c.drawImage(canvas0, 0, 0, off.width, off.height)        // 本体在上
        canvas = off
      } catch { /* 合成失败就用本体那张 */ }
    }
    // 内存/IndexedDB 仍用 jpeg（体积小）；磁盘 thumb.png 用最终合成图的 PNG（需求 5 / R19）
    let url = null
    let pngUrl = null
    try { url = canvas.toDataURL('image/jpeg', 0.62) } catch { url = null }
    try { pngUrl = canvas.toDataURL('image/png') } catch { pngUrl = null }
    if (!url) throw new Error(t('缩略图渲染失败'))
    // 落盘失败不挡卡面：内存缓存照常可用；下次扫描仍会重渲
    // ⚠️ 落盘会**往用户的资产目录里写文件**（需求 5：生成后放一个 thumb.png 免得重复加载）。
    // 自动化测试必须关掉它（__bd2viewer.setThumbPersist(false)）—— 否则跑一次测试就在
    // 用户的 mods 目录里多出一堆 thumb.png（2026-10-02 实测：本机被写进 124 个），
    // 而且会改掉「有多少资产需要生成缩略图」这个前提，让测试自己把自己搞脆。
    if (pngUrl && (thumbPersist || thumbForceWrite.has(thumbKey(item)))) {
      thumbForceWrite.delete(thumbKey(item))
      try { await persistThumbPng(item, pngUrl) } catch { /* ignore */ }
    }
    return url
  } finally {
    try { host.__backPlayer?.dispose() } catch { /* ignore */ }
    try { host.__backHost?.remove() } catch { /* ignore */ }
    cleanup()
  }
}

/* ------------------------------------------------------------ 拖动改顺序

   交互模型（2026-10-01 需求 3：PC 点击对齐手机）：

   起手（PC / 触屏同一状态机，R14）
     · 只有按住卡片左上角 ⠿ 把手才进入拖拽排序（立刻抬起；把手 touch-action:none）
     · 卡片主体：鼠标单击 = 进播放页；触屏短按 = 进播放页，长按 ≈500ms = 操作菜单
     · 放大镜（.card-fs）保持独立，不进本状态机
     主体上按住移动不再触发排序 —— 避免 PC 上「想点开却拖走了」。

   抬起
     卡片脱离子网格、固定到视口，用 transform 1:1 跟手，并保留「手指按在卡片
     哪一点」的偏移 —— 吸附到中心会立刻破坏「抓住了这个东西」的错觉。

   空位
     网格里留一个同尺寸占位块（.card-ph），它的位置就是落点。越过其他卡片中线
     时占位块移动，被挤开的卡片用 FLIP（先量后写）平移过去，200ms ease-out。
     命中测试用 layoutRect()（反解 transform），与落点判定同源。

   到边自动滚
     指针进入滚动容器上下 56px 内，按深入程度线性加速滚动（最多 1100px/s）。

   松手
     卡片以 200ms ease-out 飞回落点（FLIP 的收尾），顺序写进 localStorage。

   反馈
     抬起 10ms / 落位 8ms 振动（不支持的机型静默跳过），与视觉同一帧触发。
     真的拖过之后 endCardDrag 装 700ms click 抑制窗，不会误开资产。

   排序模式
     非手动排序时把手也不能拖（名称/日期是算出来的）；触屏长按菜单仍可用。 */

const DRAG = {
  HOLD_MS: 180,      // 触屏长按菜单的前半段
  MOVE_SLOP: 8,      // 长按判定前允许的抖动（超过就当滚动，放弃菜单）
  MOUSE_SLOP: 4,     // 保留：历史阈值；需求 3 后拖拽只从把手起手，不再用
  MENU_MS: 320,      // 再保持不动这么久（合计 ~500ms）→ 弹操作菜单
  EDGE: 56,          // 自动滚动的触发边距
  EDGE_SPEED: 1100,  // 自动滚动最大速度 px/s
  LIFT: 1.04,        // 抬起后的缩放
}

const REDUCE_MOTION = (() => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)') }
  catch { return { matches: false } }
})()

let cardDrag = null              // 当前拖动会话
/* 拖动结束时浏览器还会在「按下和抬起同一个元素」上补一个 click，
   那一下不能当成「打开资产」。但它必须是**针对被拖那张卡**、且有时效的：
   早期版本用一个全局布尔量，结果拖完之后点**别的**卡片也会被吃掉一下
   （2026-09-25 截图脚本里实测到）。 */
let suppressClick = null         // { el, until }

/** 最近一次拖动收尾里被吞掉的异常。
 *  收尾是「不能让半途抛错打断」的路径，所以异常只能兜住；但兜住之后就没人知道了，
 *  于是留一份给脚本化测试断言（正常应该恒为 null）——不然这种问题只会表现为
 *  「偶尔拖完点一下会误开播放页」这种查不出所以然的间歇故障。 */
let lastDragError = null
const dragErrText = e => (e && (e.stack || e.message)) || String(e)

function haptic(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms) } catch { /* 不支持就算了 */ }
}

/** 触屏长按后这个触摸序列不能再变成滚动（自定义手势接管所有轴） */
function blockTouchScroll(ev) {
  if (cardDrag && ev.cancelable) ev.preventDefault()
}

function cardDragReset() {
  cardDrag = null
  document.body.classList.remove('card-dragging')
  window.removeEventListener('touchmove', blockTouchScroll)
}

/**
 * 卡片指针起手（需求 3 / R14：PC+触屏同一状态机）。
 * · ⠿ 把手 → 立刻拖（仅手动排序）
 * · 主体 → 不进拖拽；触屏长按弹菜单；鼠标交给 click 打开播放页
 */
function startCardDrag(e, card) {
  if (cardDrag) return
  if (selectMode) return                                   // 选择模式下点击 = 勾选，不拖动
  const grid = $('galGrid')
  if (!grid || !card || card.parentElement !== grid) return

  // 非手动排序（名称 / 日期）下不给拖 —— 那两个顺序是算出来的，拖了也无处可存。
  // 触屏长按菜单与排序无关，所以只掐拖动，不掐菜单分支。
  const canDrag = sortState.mode === 'manual'

  const pid = e.pointerId
  const fromHandle = !!(e.target && e.target.closest && e.target.closest('.card-drag'))
  const isTouch = e.pointerType === 'touch'
  const downX = e.clientX, downY = e.clientY

  let holdT = 0
  let waitX = downX, waitY = downY

  const stopWaiting = () => {
    clearTimeout(holdT); holdT = 0
    card.removeEventListener('pointermove', onWaitMove)
    card.removeEventListener('pointerup', onWaitUp)
    card.removeEventListener('pointercancel', onWaitUp)
  }
  function onWaitMove(ev) {
    waitX = ev.clientX; waitY = ev.clientY
    // 抖动超 slop → 当滚动，放弃长按菜单
    if (Math.abs(waitX - downX) > DRAG.MOVE_SLOP || Math.abs(waitY - downY) > DRAG.MOVE_SLOP) {
      stopWaiting()
    }
  }
  function onWaitUp() { stopWaiting() }

  const armLongPressMenu = () => {
    card.addEventListener('pointermove', onWaitMove)
    card.addEventListener('pointerup', onWaitUp)
    card.addEventListener('pointercancel', onWaitUp)
    holdT = setTimeout(() => {
      stopWaiting()
      // 手指一直没动、也没抬 → 用户要的是长按菜单，不是滚动
      suppressClick = { el: card, until: Date.now() + 900 }
      haptic(10)
      openCardMenu(card.__item)
    }, DRAG.HOLD_MS + DRAG.MENU_MS)
  }

  // 需求 3：非把手区域绝不进入拖拽排序（PC 主体 click = 播放；触屏主体长按 = 菜单）
  if (!fromHandle) {
    if (!isTouch) return
    armLongPressMenu()
    return
  }

  // 把手区：非手动排序时触屏仍可长按菜单；鼠标无操作（右键有 contextmenu）
  if (!canDrag) {
    if (!isTouch) return
    armLongPressMenu()
    return
  }

  // 把手 + 手动排序：立刻抬起（PC / 触屏同一路径）
  beginCardDrag(card, grid, pid, downX, downY, isTouch)
}

function beginCardDrag(card, grid, pid, x, y, isTouch) {
  const rect = card.getBoundingClientRect()
  const ph = document.createElement('div')
  ph.className = 'card-ph'
  ph.style.height = rect.height + 'px'
  grid.insertBefore(ph, card)   // 空位先占住它原来的格子，网格不会先塌一下

  card.classList.add('dragging')
  card.style.width = rect.width + 'px'
  card.style.height = rect.height + 'px'
  card.style.transition = 'none'   // 跟手不能有过渡（内联优先，压过 .card.dragging 的 CSS）

  cardDrag = {
    card, grid, ph, pid,
    grabX: x - rect.left, grabY: y - rect.top,   // 抓取点偏移：手指按哪儿就一直跟哪儿
    x, y, moved: false,
    // 落点的起手位置（卡片是 fixed 的，不占格子，所以只数「非卡片子元素」的下标）
    startIndex: [...grid.children].filter(el => el !== card).indexOf(ph),
    raf: 0, lastT: 0,
    // 正在飞（或刚飞完）的卡片 → 命中测试要拿它反解 transform，见 layoutRect
    flip: new Map(),
    // 落点判定合并到每帧一次
    pending: false, px: x, py: y,
    holdMenuT: 0,
    onMove: null, onUp: null,
  }

  document.body.classList.add('card-dragging')
  if (isTouch) window.addEventListener('touchmove', blockTouchScroll, { passive: false })
  try { card.setPointerCapture(pid) } catch { /* 合成事件没有真实指针，忽略 */ }

  moveCardTo(x, y)
  haptic(10)

  // 触屏：已经进了拖动态但手指一直没动 —— 那用户要的不是拖动，是长按菜单。
  // 再等 MENU_MS（合计约 500ms）就放弃拖动、把卡片放回原处、弹出删除 / 多选。
  if (isTouch) {
    const d = cardDrag
    d.holdMenuT = setTimeout(() => {
      const cur = cardDrag
      if (!cur || cur !== d || d.moved) return
      abortCardDrag()
      // 手指抬起时浏览器还会补一个 click（按下和抬起是同一张卡）——
      // 那一下会在菜单背后把播放页打开，必须吃掉。走的是同一个「针对这张卡 + 有时效」的抑制。
      suppressClick = { el: card, until: Date.now() + 900 }
      openCardMenu(card.__item)
    }, DRAG.MENU_MS)
  }

  cardDrag.onMove = ev => {
    const d = cardDrag
    if (!d || ev.pointerId !== d.pid) return
    if (!d.moved) {
      d.moved = true
      clearTimeout(d.holdMenuT)      // 真的开始拖了，长按菜单作废
    }
    moveCardTo(ev.clientX, ev.clientY)
  }
  cardDrag.onUp = ev => {
    const d = cardDrag
    if (!d) return
    if (ev && ev.pointerId != null && ev.pointerId !== d.pid) return
    endCardDrag()
  }

  card.addEventListener('pointermove', cardDrag.onMove)
  card.addEventListener('pointerup', cardDrag.onUp)
  card.addEventListener('pointercancel', cardDrag.onUp)
  window.addEventListener('pointerup', cardDrag.onUp, true)      // 兜住指针跑到窗口外抬起
  window.addEventListener('pointercancel', cardDrag.onUp, true)
  cardDrag.raf = requestAnimationFrame(dragTick)
}

/** 把卡片挪到指针位置（只动 transform，走合成层）并重算落点 */
function moveCardTo(x, y) {
  const d = cardDrag
  if (!d) return
  d.x = x; d.y = y
  d.card.style.transform =
    `translate3d(${x - d.grabX}px, ${y - d.grabY}px, 0) scale(${DRAG.LIFT})`
  placePlaceholder(x, y)
}

/**
 * 算出占位块该待在第几格：按行主序扫一遍，
 * 指针落在某一行之前 → 插到那张卡前面；在同一行里 → 越过中线才插到后面。
 *
 * 判据必须是**布局位置**，不能直接用 getBoundingClientRect 的渲染位置：
 * FLIP 会给被挤开的卡片挂一个 transform，渲染位置已经提前跑到新格子上了，
 * 指针刚好压在两格边界时 dst 就会在两格之间来回翻 —— 每翻一次都重新起一次
 * FLIP，卡片于是来回横跳（就是「反复横跳」那个毛病）。
 * 这里把在飞的 transform 反解掉，只留布局矩形，判据就稳了。
 */
function layoutRect(el, flying) {
  const r = el.getBoundingClientRect()
  if (!flying) return r
  let dx = 0, dy = 0
  try {
    const m = getComputedStyle(el).transform
    if (m && m !== 'none') {
      const mm = new DOMMatrixReadOnly(m)
      dx = mm.m41; dy = mm.m42
    }
  } catch { /* 老引擎没有 DOMMatrix：退回渲染位置，只是灵敏度差一点，不会报错 */ }
  return {
    left: r.left - dx, right: r.right - dx,
    top: r.top - dy, bottom: r.bottom - dy,
    width: r.width, height: r.height,
  }
}

/** 合并到每帧一次：一次拖动能触发几十次 pointermove，边界附近还会叠加自动滚动，
 *  同一帧里反复判定 + 反复重启动画正是抖动的燃料。 */
function placePlaceholder(x, y) {
  const d = cardDrag
  if (!d) return
  d.px = x; d.py = y
  if (d.pending) return
  d.pending = true
  requestAnimationFrame(() => {
    const dd = cardDrag
    if (!dd || dd !== d || !d.pending) return
    d.pending = false
    placePlaceholderNow(d, d.px, d.py)
  })
}

function placePlaceholderNow(d, x, y) {
  const { grid, card, ph } = d

  // 顺手摘掉已经跑完过渡（>300ms）的条目：留着只会让后面多读几次计算样式
  const now = performance.now()
  for (const [el, t] of d.flip) if (now - t > 300) d.flip.delete(el)

  let dst = null
  for (const el of grid.children) {
    if (el === ph || el === card) continue
    const r = layoutRect(el, d.flip.has(el))
    if (y < r.top) { dst = el; break }
    if (y > r.bottom) continue
    if (x < r.left + r.width / 2) { dst = el; break }
  }
  if (dst ? ph.nextElementSibling === dst : !ph.nextElementSibling) return

  const rest = []
  for (const el of grid.children) if (el !== card && el !== ph) rest.push(el)
  const before = rest.map(el => el.getBoundingClientRect())   // 视觉位置（含在飞的位移）

  if (dst) grid.insertBefore(ph, dst)
  else grid.appendChild(ph)

  if (REDUCE_MOTION.matches) return

  // FLIP：起点用「现在看到的位置」，终点用「改完 DOM 后的布局位置」。
  // 起点取视觉位置，正在半路飞行的卡片被再次接管时才是连续的，不会瞬间跳一格。
  const after = rest.map(el => layoutRect(el, d.flip.has(el)))
  let any = false
  rest.forEach((el, i) => {
    const dx = before[i].left - after[i].left
    const dy = before[i].top - after[i].top
    if (!dx && !dy) return
    // 每启动一次 FLIP 就给这张卡换一代号。上一代的清理定时器到点后会自己放弃，
    // 不会把这一代刚写好的起始位移抹掉（两个 FLIP 相隔 ~300ms 是拖动时的常见节奏）。
    el.__flipGen = (el.__flipGen || 0) + 1
    el.style.transition = 'none'
    el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
    d.flip.set(el, performance.now())
    any = true
  })
  if (!any) return
  requestAnimationFrame(() => {
    for (const el of rest) {
      if (!el.style.transform) continue
      const gen = el.__flipGen
      el.style.transition = `transform var(--dur-move) var(--ease-out)`
      el.style.transform = ''
      // 过渡跑完必须把内联 transition 也清掉。只把 transform 清空的话，
      // `style.transition` 会以非空字符串永远留在元素上 ——
      // 而内联值压得过 `.card.dragging{transition:none}`，
      // 后果是这张卡下次被拖时会「追着手指跑」，跟手发飘。
      // （松手瞬间正好有一次 queued 落点判定时最容易踩到：endCardDrag 先清了内联样式，
      //   随后这一帧的 rAF 又把 transition 写回去，从此没人再管它。）
      setTimeout(() => {
        if (el.__flipGen !== gen) return      // 已被新一代 FLIP 接管，别动
        if (cardDrag && cardDrag.card === el) return   // 它正在被拖，内联 transform 归拖动引擎管
        el.style.transition = ''
        el.style.transform = ''
      }, 300)
    }
  })
}

/** 指针贴到滚动容器上下边缘时自动滚动；网格在卡片底下滚，落点要跟着重算 */
function dragTick(t) {
  const d = cardDrag
  if (!d) return
  const dt = d.lastT ? Math.min(64, t - d.lastT) : 16
  d.lastT = t
  const r = d.grid.getBoundingClientRect()
  let v = 0
  if (d.y < r.top + DRAG.EDGE) v = -DRAG.EDGE_SPEED * (1 - (d.y - r.top) / DRAG.EDGE)
  else if (d.y > r.bottom - DRAG.EDGE) v = DRAG.EDGE_SPEED * (1 - (r.bottom - d.y) / DRAG.EDGE)
  v = Math.max(-DRAG.EDGE_SPEED, Math.min(DRAG.EDGE_SPEED, v))
  if (v) {
    const was = d.grid.scrollTop
    d.grid.scrollTop = was + v * dt / 1000
    if (d.grid.scrollTop !== was) placePlaceholder(d.x, d.y)
  }
  d.raf = requestAnimationFrame(dragTick)
}

/** 放弃这次拖动（长按菜单抢走了手势）：把卡片放回原处，不写顺序、不吃点击 */
function abortCardDrag() {
  const d = cardDrag
  if (!d) return
  d.moved = false          // moved=false 会让 endCardDrag 跳过回位动画和 suppressClick
  d.cancelled = true
  endCardDrag()
}

function endCardDrag() {
  const d = cardDrag
  if (!d) return
  cardDragReset()

  const { card, grid, ph, pid } = d
  cancelAnimationFrame(d.raf)
  clearTimeout(d.holdMenuT)
  // 「余波 click」抑制要**最先**装上：浏览器在 pointerup 之后还会补一个 click，
  // 而下面任何一步（补落点判定、FLIP 回位、提交顺序）万一抛错，这一步就被跳过了，
  // 那一下 click 会直接穿到菜单背后把播放页打开 —— 2026-09-25 实测到过这种间歇失败。
  if (d.moved) {
    suppressClick = { el: card, until: Date.now() + 700 }
    haptic(8)
  }
  // 落点判定是合并到每帧一次的，松手可能发生在那次 rAF 之前 ——
  // 先把排队的那一次补上，否则「最后一帧里挪的那一下」会白挪。
  if (d.pending) {
    d.pending = false
    // 兜住异常：宁可少挪一格，也不能让收尾逻辑半途中断（卡片会卡在拖动态）
    try { placePlaceholderNow(d, d.px, d.py) } catch (err) { lastDragError = dragErrText(err) }
  }
  card.removeEventListener('pointermove', d.onMove)
  card.removeEventListener('pointerup', d.onUp)
  card.removeEventListener('pointercancel', d.onUp)
  window.removeEventListener('pointerup', d.onUp, true)
  window.removeEventListener('pointercancel', d.onUp, true)
  try { card.releasePointerCapture(pid) } catch { /* ignore */ }

  // 松手那一刻卡片的可视位置（固定定位 + transform，所以就是这两个数）
  const fromLeft = d.x - d.grabX
  const fromTop = d.y - d.grabY
  // 落点是否真的换了格子 —— 只有换了才值得写顺序 / 弹提示
  const endIndex = [...grid.children].filter(el => el !== card).indexOf(ph)
  const reordered = endIndex !== d.startIndex

  // 复位到占位块那一格，然后按 FLIP 从「松手的位置」滑过去。
  // 解包轮询会整表重画，占位块可能已经不在网格里，这时 insertBefore 会抛
  // NotFoundError，顶上那条红字就是它。
  if (ph.parentNode === grid) grid.insertBefore(card, ph)
  else if (card.parentNode !== grid) grid.appendChild(card)
  if (ph.parentNode) ph.remove()
  card.classList.remove('dragging')
  card.style.cssText = ''
  const to = card.getBoundingClientRect()

  if (d.moved && !REDUCE_MOTION.matches) {
    const dx = fromLeft - to.left
    const dy = fromTop - to.top
    if (dx || dy) {
      card.style.transition = 'none'
      card.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${DRAG.LIFT})`
      card.classList.add('settling')
      requestAnimationFrame(() => {
        card.style.transition = `transform var(--dur-move) var(--ease-out)`
        card.style.transform = ''
      })
      setTimeout(() => {
        card.classList.remove('settling')
        card.style.transition = ''
        card.style.transform = ''
      }, 260)
    }
  }

  // 拖动态给兄弟卡片写过内联 transition/transform（FLIP），这里统一清掉，
  // 不然下次进拖动态时内联的 transition 会压过 .dragging 的 transition:none，跟手发飘。
  for (const el of grid.children) {
    if (el === card) continue
    if (el.style.transition || el.style.transform) {
      el.style.transition = ''
      el.style.transform = ''
    }
  }
  d.flip.clear()

  // 只有「真的拖过」才算重排 —— 放弃的拖动（长按菜单）不该动播放顺序
  if (reordered && d.moved) commitCardOrder()
}

/**
 * 把当前卡片顺序写下来，同步左侧列表（顺序影响全屏 ◀▶）。
 * 手动模式 + 当前是倒序时，把数组反过来存 —— 因为 orderedList 还会再反转一次，
 * 这样屏幕上的顺序和存下来的顺序永远一致，不需要偷偷复位方向。
 */
function commitCardOrder() {
  const grid = $('galGrid')
  if (!grid) return
  let keys = [...grid.querySelectorAll('.card')].map(c => c.dataset.key)
  if (sortState.mode === 'manual' && sortState.dir === -1) keys = keys.slice().reverse()
  saveOrder(keys)
  // 只刷左侧列表，**故意不刷平铺页** —— 卡片刚拖完落地，此刻重建网格 DOM
  // 会把拖动的收尾动画和滚动位置一起打掉；而平铺页的顺序本来就是用户刚摆好的，
  // 不需要再画一遍。这是 refreshLists() 之外唯一的例外。
  renderAssetList()
  toast(t('播放顺序已保存（{n} 个）', { n: keys.length }))
}

/** 重建缩略图。不传 item = 当前网格里全部可播放资产，包括目录里已经有 thumb.png 的。
 *  传 item = 只重建右键选中的那一张，并覆盖它的 thumb.png。 */
async function rebuildThumbs(onlyItem) {
  const onlyKey = onlyItem ? itemKey(onlyItem) : null
  if (!onlyItem) {
    await idbClearThumbs()
    thumbCache.clear()
    thumbFailed.clear()
    thumbAsked.clear()
    thumbDone = 0
  }
  let queued = 0
  for (const c of document.querySelectorAll('#galGrid .card')) {
    const item = c.__item
    if (onlyKey && (!item || itemKey(item) !== onlyKey)) continue
    const box = c.querySelector('.card-thumb')
    if (item && (item.imageOnly || item.pendingUnpack || !item.ok)) {
      c.__wantThumb = false
      continue
    }
    if (item) forgetThumb(item)
    if (box) { box.innerHTML = ''; box.classList.remove('failed'); box.classList.add('pending') }
    c.__wantThumb = true
    queued++
  }
  toast(t(onlyItem ? '正在重建这张缩略图…' : '正在重新生成缩略图…'))
  if (queued) thumbKick()
}

/* ------------------------------------------------------------------ 载入资产 */

/** root 相对路径 → 可取的 URL。两个数据源（Node 服务 / WebView 拦截）都认 /spine/<rootId>/<rel>。 */
function assetUrl(rel) {
  if (!rel) return null
  // Encode rootId too so Chinese/space roots round-trip with server decodeURIComponent.
  const rootSeg = String(S.rootId || '').split('/').map(encodeURIComponent).join('/')
  const relSeg = String(rel).replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return `/spine/${rootSeg}/${relSeg}`
}

/** 需求 5：把离屏合成图写成资产目录里的 thumb.png（与 builtinThumbUrl 同源）。
 *  路径 = atlas 同目录；解包缓存（bd2viewer-nikke/…）同样适用。
 *  写成功后立刻挂上 item.relThumb，本会话内不必等重扫。 */
async function persistThumbPng(item, pngDataUrl) {
  if (!item || !pngDataUrl || !isDiskItem(item)) return null
  // Mode isolation: never write a BD2 path under jczx/nikke root (mkdir would
  // create foreign folders like Celia_* / 神悠* inside the JCZX game directory).
  if (typeof matchesAssetMode === 'function' && !matchesAssetMode(item)) return null
  if (item.pendingUnpack) return null
  const relAtlas = item.relAtlas || item.id
  if (!relAtlas || typeof relAtlas !== 'string') return null
  const slash = relAtlas.lastIndexOf('/')
  // Must be nested under an existing asset folder — refuse bare root thumb.png
  if (slash < 0) return null
  const relThumb = relAtlas.slice(0, slash + 1) + 'thumb.png'
  const comma = pngDataUrl.indexOf(',')
  const b64 = comma >= 0 ? pngDataUrl.slice(comma + 1) : ''
  if (!b64) return null
  if (NATIVE) {
    try {
      const ok = window.BD2Native.writeThumb && window.BD2Native.writeThumb(S.rootId || '', relThumb, b64)
      if (ok) { item.relThumb = relThumb; return relThumb }
    } catch { /* 原生写失败就算了 */ }
    return null
  }
  const res = await fetch('/api/thumb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootId: S.rootId, rel: relThumb, data: b64 }),
  })
  if (!res.ok) return null
  item.relThumb = relThumb
  return relThumb
}

/** 资产目录里自带的缩略图（Lost Sword 的 thumb.png）。没有就返回 null。
 *  有了它就不用开离屏播放器渲一帧 —— 更快，而且不受「骨架坏 / GL 上下文用满」影响。 */
function builtinThumbUrl(item) {
  return item && item.relThumb ? assetUrl(item.relThumb) : null
}

function urlsForItem(item) {
  if (item.blobUrls) return item.blobUrls
  const atlasUrl = assetUrl(item.relAtlas)
  const skeletonUrl = assetUrl(item.relSkeleton)
  // 给 spine-player 兜底：告诉它 atlas 里每个页名最终该从哪取。
  // 必须用 relImages（相对根的完整路径）。images[] 只有文件名；
  // JCZX 缓存在 bd2viewer-jczx/<hash>_…/ 下，用裸文件名会拼成
  // /spine/<root>/foo.png（丢前缀）→ WebView 404 → Assets could not be loaded。
  const rawDataURIs = {}
  const baseUrl = new URL(atlasUrl, location.href)
  const imgs = item.images || []
  for (let i = 0; i < imgs.length; i++) {
    const pageName = String(imgs[i]).split('/').pop()
    let rel = (item.relImages && item.relImages[i]) || null
    if (!rel || !String(rel).includes('/')) {
      // 从 atlas 同目录推导（嵌套缓存 / 旧扫描缺 relImages）
      if (item.relAtlas && String(item.relAtlas).includes('/')) {
        rel = String(item.relAtlas).replace(/[^/]+$/, pageName)
      } else {
        rel = rel || imgs[i]
      }
    }
    const abs = assetUrl(rel)
    try {
      const absUrl = new URL(pageName, baseUrl)
      rawDataURIs[absUrl.href] = abs
      rawDataURIs[absUrl.pathname] = abs
    } catch { /* ignore */ }
    rawDataURIs[pageName] = abs
    if (abs) rawDataURIs[abs] = abs
  }
  return { atlasUrl, skeletonUrl, skeletonKind: item.skeletonKind, rawDataURIs }
}

/**
 * 读出骨架是哪个 minor 导出的（'4.0' / '4.1'），用来挑运行时。
 *
 * 二进制骨架（.skel / .skel.bytes）的版本串写在文件头里：
 *   8 字节 hash（低/高各 4 字节）→ 1 字节长度 → "4.0.47\0"
 * 所以读头 32 字节就够，不用把整个骨架拉下来（大骨架几百 KB ~ 几 MB）。
 * 用 ReadableStream 只取第一块就 cancel：Range 头不一定被服务端/WebView 支持，
 * 但分流读取到哪一层都管用；个别 WebView 对「被 shouldInterceptRequest 拦截的响应」
 * 不给 body 流，那时退回整读一次（见下面的 ②）。
 *
 * JSON 骨架（.json，含 Lost Sword 那种实为 JSON 的裸 .bytes）不读文件 —— 这两条
 * 线都是 4.1，直接按 4.1。真出了 4.0 的 JSON 骨架，回退到默认运行时也能跑（会报错，
 * 但那是「这个组合本来就不受支持」，不是静默错渲染）。
 *
 * 结果按条目录在 item._spineMinor 上：缩略图与正片只会各测一次，之后命中缓存。
 */

/** 探测失败时按当前 mode / 条目来源选默认骨架世代。
 *  JCZX 实测绝大多数是 3.8.99 JSON，转成 4.1 再播。默认若写成 4.2，
 *  blob 地址不以 .json 结尾时会被 4.2 当二进制读，报 boneData cannot be null。
 *  真正的 4.2 JSON 仍以文件里的 spine 字段为准。
 *  NIKKE 解包缓存（bd2viewer-nikke，UnityFS 抽出的是 4.1 二进制）→ 4.1；
 *  其余 NIKKE（标准导出）→ 4.0；其它 → 4.1。 */
function modeDefaultSpineMinor(item) {
  if (S.mode === 'jczx') return '4.1'
  if (S.mode === 'nikke') {
    // 解包缓存是 4.1；误用 4.0 运行时读 4.1 .skel → 动画列表空 →「这个骨架里没有任何动画」
    if (item && isNikkeCacheItem(item)) return '4.1'
    return '4.0'
  }
  return '4.1'
}

/* ------------------------------------------------------------------ 3.x JSON 兼容层
 *
 * Spine 3.8 与 4.x 的 JSON 不是同一套数。4.x 运行时读不到的字段不报错，只变成
 * undefined → NaN，或者按默认值 1 把约束拉满。JCZX 这批骨架大多是 3.8.99。
 *
 * 骨骼会「运动错乱」的两处：
 *   ① 贝塞尔。3.8 的 curve/c2/c3/c4 是 0–1 的百分比
 *      （c2=cy1 缺省 0，c3=cx2 缺省 1，c4=cy2 缺省 1，见 Spine JSON 格式说明）。
 *      4.x 的 curve 数组是绝对时间/绝对数值，而且按分量分槽
 *      （readCurve 里 i = value << 2）。把 0.25 这种百分比直接塞进去，
 *      控制点会落在关键帧时间之外，插值就把骨头甩飞。
 *   ② 变换约束。3.8 叫 rotateMix/translateMix/scaleMix/shearMix，
 *      4.x 叫 mixRotate/mixX/mixY/mixScaleX/mixScaleY/mixShearY。
 *      对不上时 4.x 一律当 1。这份素材里大量约束的 mix 是 -1 或接近 0，
 *      被当成 1 之后肩膀、头发、挂件会被拽到反方向。
 *
 * 网格变形（deform）3.8 挂在动画根上，4.1 要挂到
 * attachments[皮肤][插槽][网格].deform，曲线的 Y 是 0–1 的混合而不是顶点坐标。
 * 丢掉的话眼睛、布料、脸的顶点动画会停在绑定姿势，看起来像动画坏了。
 *
 * 返回转换后的 JSON 文本；不是 3.x 骨架则返回 null（调用方保持原样）。
 */
function spineJson38to41(text) {
  let j
  try { j = JSON.parse(text) } catch { return null }
  const ver = (j.skeleton && j.skeleton.spine) || ''
  if (!/^3\./.test(ver)) return null

  const num = (v, d) => (typeof v === 'number' ? v : d)
  const field = (key, d) => (kf) => num(kf[key], d)

  // 百分比在删 c2/c3/c4 之前读出，再写成 4.x 的绝对 curve。每个 getter 是一个分量。
  const convertCurves = (frames, getters) => {
    if (!Array.isArray(frames)) return
    for (const kf of frames) {
      if (kf && kf.angle !== undefined && kf.value === undefined) {
        kf.value = kf.angle
        delete kf.angle
      }
    }
    for (let i = 0; i < frames.length; i++) {
      const kf = frames[i]
      if (!kf || typeof kf !== 'object') continue
      if (kf.angle !== undefined && kf.value === undefined) {
        kf.value = kf.angle
        delete kf.angle
      }
      const c = kf.curve
      const c2 = kf.c2, c3 = kf.c3, c4 = kf.c4
      delete kf.c2; delete kf.c3; delete kf.c4
      if (c == null || c === 'stepped') continue
      const next = frames[i + 1]
      if (!next || typeof next !== 'object' || !getters.length) {
        delete kf.curve
        continue
      }
      let cx1, cy1, cx2, cy2
      if (typeof c === 'number') {
        cx1 = c
        cy1 = c2 !== undefined ? c2 : 0
        cx2 = c3 !== undefined ? c3 : 1
        cy2 = c4 !== undefined ? c4 : 1
      } else if (Array.isArray(c) && c.length) {
        cx1 = c[0]
        cy1 = c.length > 1 ? c[1] : 0
        cx2 = c.length > 2 ? c[2] : 1
        cy2 = c.length > 3 ? c[3] : 1
      } else {
        delete kf.curve
        continue
      }
      const t1 = num(kf.time, 0)
      const t2 = num(next.time, 0)
      const dt = t2 - t1
      const out = []
      for (const get of getters) {
        const v1 = get(kf)
        const dv = get(next) - v1
        out.push(t1 + cx1 * dt, v1 + cy1 * dv, t1 + cx2 * dt, v1 + cy2 * dv)
      }
      kf.curve = out
    }
  }

  // 4.1 的 DeformTimeline 只用一条曲线，Y 是 0–1，不是每个顶点一份。
  const convertDeformCurves = (frames) => {
    if (!Array.isArray(frames)) return
    for (let i = 0; i < frames.length; i++) {
      const kf = frames[i]
      if (!kf || typeof kf !== 'object') continue
      const c = kf.curve
      const c2 = kf.c2, c3 = kf.c3, c4 = kf.c4
      delete kf.c2; delete kf.c3; delete kf.c4
      if (c == null || c === 'stepped') continue
      const next = frames[i + 1]
      if (!next || typeof next !== 'object') { delete kf.curve; continue }
      let cx1, cy1, cx2, cy2
      if (typeof c === 'number') {
        cx1 = c
        cy1 = c2 !== undefined ? c2 : 0
        cx2 = c3 !== undefined ? c3 : 1
        cy2 = c4 !== undefined ? c4 : 1
      } else if (Array.isArray(c) && c.length) {
        cx1 = c[0]
        cy1 = c.length > 1 ? c[1] : 0
        cx2 = c.length > 2 ? c[2] : 1
        cy2 = c.length > 3 ? c[3] : 1
      } else {
        delete kf.curve
        continue
      }
      const t1 = num(kf.time, 0)
      const dt = num(next.time, 0) - t1
      kf.curve = [t1 + cx1 * dt, cy1, t1 + cx2 * dt, cy2]
    }
  }

  const hoistDeform = (anim) => {
    const deform = anim.deform
    if (!deform || typeof deform !== 'object') return
    if (!anim.attachments || typeof anim.attachments !== 'object') anim.attachments = {}
    for (const skin in deform) {
      const slots = deform[skin]
      if (!slots || typeof slots !== 'object') continue
      if (!anim.attachments[skin]) anim.attachments[skin] = {}
      for (const slot in slots) {
        const meshes = slots[slot]
        if (!meshes || typeof meshes !== 'object' || Array.isArray(meshes)) continue
        if (!anim.attachments[skin][slot]) anim.attachments[skin][slot] = {}
        for (const mesh in meshes) {
          const frames = meshes[mesh]
          if (!Array.isArray(frames)) continue
          convertDeformCurves(frames)
          const dest = anim.attachments[skin][slot][mesh]
            || (anim.attachments[skin][slot][mesh] = {})
          if (!dest.deform) dest.deform = frames
        }
      }
    }
    delete anim.deform
  }

  const hex4 = (s) => {
    if (typeof s !== 'string' || s.length < 6) return [1, 1, 1, 1]
    const h = s.charAt(0) === '#' ? s.slice(1) : s
    const ch = (i) => {
      const n = parseInt(h.substr(i, 2), 16)
      return (Number.isFinite(n) ? n : 255) / 255
    }
    return [ch(0), ch(2), ch(4), h.length < 8 ? 1 : ch(6)]
  }

  // 3.8 的单个 mix 对应 4.x 拆开的一对。只在 4.x 名字还没写的时候填。
  const liftMix = (obj) => {
    if (!obj || typeof obj !== 'object') return
    if (obj.mixRotate === undefined && obj.rotateMix !== undefined) obj.mixRotate = obj.rotateMix
    if (obj.mixX === undefined && obj.translateMix !== undefined) obj.mixX = obj.translateMix
    if (obj.mixY === undefined && obj.translateMix !== undefined) obj.mixY = obj.translateMix
    if (obj.mixScaleX === undefined && obj.scaleMix !== undefined) obj.mixScaleX = obj.scaleMix
    if (obj.mixScaleY === undefined && obj.scaleMix !== undefined) obj.mixScaleY = obj.scaleMix
    if (obj.mixShearY === undefined && obj.shearMix !== undefined) obj.mixShearY = obj.shearMix
    delete obj.rotateMix
    delete obj.translateMix
    delete obj.scaleMix
    delete obj.shearMix
  }

  if (Array.isArray(j.transform)) {
    for (const tc of j.transform) liftMix(tc)
  }

  const mixGetters = [
    (kf) => num(kf.mixRotate, 1),
    (kf) => num(kf.mixX, 1),
    (kf) => (kf.mixY !== undefined ? kf.mixY : num(kf.mixX, 1)),
    (kf) => num(kf.mixScaleX, 1),
    (kf) => (kf.mixScaleY !== undefined ? kf.mixScaleY : num(kf.mixScaleX, 1)),
    (kf) => num(kf.mixShearY, 1),
  ]

  const anims = j.animations || {}
  for (const name in anims) {
    const a = anims[name]
    if (!a || typeof a !== 'object') continue
    if (a.slots && typeof a.slots === 'object') {
      for (const s in a.slots) {
        const ent = a.slots[s]
        if (!ent || typeof ent !== 'object') continue
        if (ent.color && !ent.rgba) { ent.rgba = ent.color; delete ent.color }
        if (ent.twoColor && !ent.rgba2) { ent.rgba2 = ent.twoColor; delete ent.twoColor }
        for (const tn in ent) {
          const frames = ent[tn]
          if (tn === 'rgba') {
            convertCurves(frames, [0, 1, 2, 3].map(i => (kf) => hex4(kf.color)[i]))
          } else if (tn === 'rgb') {
            convertCurves(frames, [0, 1, 2].map(i => (kf) => hex4(kf.color)[i]))
          } else if (tn === 'alpha') {
            convertCurves(frames, [field('value', 0)])
          } else if (tn === 'rgba2') {
            convertCurves(frames, [0, 1, 2, 3, 4, 5, 6].map(i => (kf) => {
              const light = hex4(kf.light)
              const dark = hex4(kf.dark)
              return i < 4 ? light[i] : dark[i - 4]
            }))
          } else if (tn === 'attachment') {
            if (Array.isArray(frames)) {
              for (const kf of frames) {
                if (kf && typeof kf.curve === 'number') delete kf.curve
                if (kf) { delete kf.c2; delete kf.c3; delete kf.c4 }
              }
            }
          } else {
            convertCurves(frames, [])
          }
        }
      }
    }
    if (a.bones && typeof a.bones === 'object') {
      for (const b in a.bones) {
        const ent = a.bones[b]
        if (!ent || typeof ent !== 'object') continue
        if (ent.rotate) convertCurves(ent.rotate, [field('value', 0)])
        if (ent.translate) convertCurves(ent.translate, [field('x', 0), field('y', 0)])
        if (ent.scale) convertCurves(ent.scale, [field('x', 1), field('y', 1)])
        if (ent.shear) convertCurves(ent.shear, [field('x', 0), field('y', 0)])
        if (ent.translatex) convertCurves(ent.translatex, [field('value', 0)])
        if (ent.translatey) convertCurves(ent.translatey, [field('value', 0)])
        if (ent.scalex) convertCurves(ent.scalex, [field('value', 1)])
        if (ent.scaley) convertCurves(ent.scaley, [field('value', 1)])
        if (ent.shearx) convertCurves(ent.shearx, [field('value', 0)])
        if (ent.sheary) convertCurves(ent.sheary, [field('value', 0)])
      }
    }
    if (a.ik && typeof a.ik === 'object') {
      for (const n in a.ik) convertCurves(a.ik[n], [field('mix', 1), field('softness', 0)])
    }
    if (a.transform && typeof a.transform === 'object') {
      for (const n in a.transform) {
        const frames = a.transform[n]
        if (Array.isArray(frames)) for (const kf of frames) liftMix(kf)
        convertCurves(frames, mixGetters)
      }
    }
    hoistDeform(a)
  }
  return JSON.stringify(j)
}

/** 当前正在用的「3.x → 4.x 转换后」骨架 blob URL（每帧只可能有一套主骨架 + 一个背层）。
 *  建新播放器之前统一回收 —— 不回收会一直占内存（3.8 CG 的 JSON 有几 MB）。 */
let spineJsonBlobs = []
function dropSpineJsonBlobs() {
  for (const u of spineJsonBlobs) {
    try { URL.revokeObjectURL(u) } catch { /* ignore */ }
  }
  spineJsonBlobs = []
}

/**
 * 取「该用哪个地址当 jsonUrl」：3.x 骨架先转换、包成 blob URL。
 * 返回 `{ url, blob }`；blob 非 null 表示这次真做了转换（调用方负责回收）。
 */
async function spineJsonUrlFor(item, urls) {
  const orig = (urls && (urls.jsonUrl || (urls.skeletonKind === 'json' ? urls.skeletonUrl : null))) || null
  if (!orig) return null
  const memory = item && item.__jsonText
  if (!item || !item._spine38) return { url: orig, blob: null }
  try {
    let text = memory || ''
    if (!text) {
      const res = await fetch(orig)
      if (!res.ok) return { url: orig, blob: null }
      text = await res.text()
    }
    const fixed = spineJson38to41(text)
    if (!fixed) return { url: orig, blob: null }
    const blob = URL.createObjectURL(new Blob([fixed], { type: 'application/json' }))
    return { url: blob, blob }
  } catch {
    return { url: orig, blob: null }
  }
}

/** 把「骨架该从哪取」装进播放器配置：优先用转换后的 blob（3.x JSON 才有），
 *  否则按老规矩 jsonUrl / binaryUrl。四处建播放器的地方共用，别各写一份。 */
function applySkeletonCfg(cfg, urls, compat) {
  if (compat && compat.url) { cfg.jsonUrl = compat.url; return }
  if (urls.jsonUrl) cfg.jsonUrl = urls.jsonUrl
  else if (urls.skeletonUrl && urls.skeletonKind === 'json') cfg.jsonUrl = urls.skeletonUrl
  else if (urls.skeletonUrl) cfg.binaryUrl = urls.skeletonUrl
}

async function spineMinorFor(item) {
  const jsonKind = !!(item && item.skeletonKind === 'json')
  // ⚠️ 这里**不能**对 NIKKE 缓存一律钉死 4.1。
  // 解包缓存里绝大多数骨架是 4.1，但**不是全部**（2026-10-02 实测 496 个骨架里 61 个
  // 是 4.0.47，来自另一个导出器）。当年那条「一律 4.1」是为了绕开全头正则误判，
  // 而现在 server / Android / 前端三处都按 Spine 二进制布局精确读版本
  // （[8]=n-1 长度、[9..]="4.x.y"），在本机 496 个文件上与服务端逐个一致。
  // 所以：**有明确版本就信它**，只在完全没有版本信息时才按 NIKKE 默认 4.1 兜底。
  //
  // 2026-10-02 之前这条规则还在时，c022_cover_00（4.0.47）被强塞进 4.1 运行时，
  // 报「Attachment name must not be null」；更糟的是它连报错里的「换一个 minor 再试」
  // 兜底都救不回来 —— 重试把 _spineMinor 设成 '4.0'，下一次 spineMinorFor 又被这条
  // 规则改回 '4.1'，于是永远在 4.1 上打转。
  if (isNikkeCacheItem(item) && !item.spineMinor && !item._spineMinor) {
    item.spineMinor = '4.1'
  }
  // 二进制可以缓存。JSON 不行：扫描经常把 JCZX 标成 4.2，或者第一次探测时
  // 文件还没读到，缓存下来之后 3.8.99 就会进 4.2 播放器。
  if (!jsonKind && item && item._spineMinor !== undefined) return item._spineMinor
  if (jsonKind && item.__spineSniffed && item._spineMinor !== undefined) return item._spineMinor
  const fallback = () => modeDefaultSpineMinor(item)
  if (jsonKind) {
    let text = item.__jsonText || ''
    if (!text) {
      const url = (urlsForItem(item) || {}).skeletonUrl
      if (!url) return fallback()
      try {
        const res = await fetch(url)
        if (!res.ok) return fallback()
        text = await res.text()
        item.__jsonText = text
      } catch {
        return fallback()
      }
    }
    const m = /"spine"\s*:\s*"(\d+)\.(\d+)/.exec(text.slice(0, 8192))
    item.__spineSniffed = true
    if (!m) return (item._spineMinor = fallback())
    // 3.x 的 JSON：字段格式与 4.x 不同（angle/value、紧凑曲线系数……），但我们能在
    // 加载前把它转成 4.x 能读的形状（spineJson38to41）→ 用 4.1 运行时正常播。
    if (m[1] === '3') {
      item._spine38 = true
      item.spineMinor = '4.1'
      return (item._spineMinor = '4.1')
    }
    const minor = `4.${m[2]}`
    item.spineMinor = minor
    return (item._spineMinor = minor)
  }
  // 服务端扫描已读过二进制骨架头
  if (item.spineMinor === '4.0' || item.spineMinor === '4.1' || item.spineMinor === '4.2') {
    return (item._spineMinor = item.spineMinor)
  }
  if (item.skeletonKind !== 'skel') return (item._spineMinor = fallback())
  // 走 urlsForItem 而不是直接拼 assetUrl：手动上传的条目只有 blob URL，
  // 没有 relSkeleton / rootId，直接拼会拼出 null 再去 fetch 当前页面。
  const url = (urlsForItem(item) || {}).skeletonUrl
  if (!url) return (item._spineMinor = fallback())

  let head = null
  // ① 优先分流读，只取头部就 cancel（大骨架不必整份拉下来）
  try {
    const res = await fetch(url)
    if (!res.ok) return (item._spineMinor = fallback())
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      let buf = new Uint8Array(0)
      try {
        while (buf.length < 32) {
          const { value, done } = await reader.read()
          if (done) break
          const merged = new Uint8Array(buf.length + value.length)
          merged.set(buf, 0)
          merged.set(value, buf.length)
          buf = merged
        }
        head = buf
      } finally {
        try { await reader.cancel() } catch { /* 已经读完/已取消 */ }
      }
    } else {
      head = new Uint8Array(await res.arrayBuffer()).slice(0, 32)
    }
  } catch { /* 分流这条路不通（个别 WebView 对拦截响应不给 body 流）→ 下面整读兜底 */ }

  // ② 兜底：重新整读。只在 ① 失败时发生，正常路径不会多下这一次。
  if (!head) {
    try {
      const res = await fetch(url)
      if (!res.ok) return (item._spineMinor = fallback())
      head = new Uint8Array(await res.arrayBuffer()).slice(0, 32)
    } catch {
      return (item._spineMinor = fallback())
    }
  }

  // 优先按 Spine 二进制布局读： [0..7] hash、[8] 长度、[9..] "4.x.y\0"
  // 全头正则可能被 hash 字节里碰巧出现的 "4.0.x" 误导（解包 4.1 却判成 4.0）。
  let ver = null
  if (head.length > 10) {
    // 长度字节的编码是「实际长度 + 1」：0 = null、1 = 空串。所以字符数 = head[8] - 1。
    // （按 n 读会多吃一个字节，串尾带上 0xc4 之类的垃圾 —— 之前只靠正则没要求结尾才没炸。）
    const n = (head[8] | 0) - 1
    if (n > 0 && n < 24 && 9 + n <= head.length) {
      let s = ''
      for (let i = 9; i < 9 + n; i++) {
        const c = head[i]
        if (c === 0) break
        s += String.fromCharCode(c)
      }
      const vm = /^(\d+)\.(\d+)\.\d+$/.exec(s)
      if (vm) ver = vm[1] === '4' ? `4.${vm[2]}` : `${vm[1]}.x`
    }
  }
  // 头对不上就用模式默认值。不要在 hash 字节里再搜 "4.x.y"：
  // 解包出来的 4.1 骨架经常被碰巧的 "4.0.xx" 判成 4.0，动画列表就是空的。
  return (item._spineMinor = ver || fallback())
}

function selectItem(item, pose) {
  S.current = item
  // NIKKE 分组条目：默认姿势 = 成员表第一项的 pose（通常是本体 normal；
  // 只有 aim/cover 没有本体时，第一项就是那个姿势）
  S.currentPose = pose || (Array.isArray(item?.members) ? (item.members[0].pose || 'normal') : 'normal')
  refreshLists()
  if (fsMode) updateFsLabels()
  // 同步到地址栏，方便直接分享 / 刷新回到同一套资产
  const key = item.relAtlas || item.id
  if (key) {
    const q = new URLSearchParams()
    q.set('item', key)
    history.replaceState(null, '', `${location.pathname}?${q}`)
  }
  loadCurrent()
}

/** 分段把本地文件读进内存。WebView 对 shouldInterceptRequest 的 XHR arraybuffer
 *  会截断 .skel，必须绕开网络。单段 192KB，避开 Binder 约 1MB 的上限。 */
function nativeAssetBytes(rel) {
  const api = window.BD2Native
  if (!NATIVE || !api || !rel || String(rel).includes('..')) return null
  const root = S.rootId || ''
  try {
    if (typeof api.readAssetSize === 'function' && typeof api.readAssetB64Range === 'function') {
      const n = api.readAssetSize(root, rel) | 0
      if (n <= 0 || n > 32 * 1024 * 1024) return null
      const chunk = 192 * 1024
      const out = new Uint8Array(n)
      let pos = 0
      for (let off = 0; off < n; off += chunk) {
        const len = Math.min(chunk, n - off)
        const b64 = api.readAssetB64Range(root, rel, off, len)
        if (!b64) return null
        const bin = atob(b64)
        if (bin.length !== len) return null
        for (let i = 0; i < bin.length; i++) out[pos++] = bin.charCodeAt(i)
      }
      return out
    }
    if (typeof api.readAssetB64 !== 'function') return null
    const b64 = api.readAssetB64(root, rel)
    if (!b64) return null
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function bytesToB64(u8) {
  // 不能把 Uint8Array 直接丢给 apply：部分 Android WebView 会把它展开错，
  // base64 解出来比原文件短，Spine 读到一半就 DataView 越界。
  let s = ''
  const step = 8192
  for (let i = 0; i < u8.length; i += step) {
    const n = Math.min(step, u8.length - i)
    const arr = new Array(n)
    for (let j = 0; j < n; j++) arr[j] = u8[i + j]
    s += String.fromCharCode.apply(null, arr)
  }
  return btoa(s)
}

/** Spine 二进制头：[0..7] hash，[8] 是「版本串字符数 + 1」，[9..] "4.x.y"。 */
function spineMinorFromBytes(bin) {
  if (!bin || bin.length < 12) return null
  const n = (bin[8] | 0) - 1
  if (!(n > 0 && n < 24 && 9 + n <= bin.length)) return null
  let s = ''
  for (let i = 9; i < 9 + n; i++) {
    const c = bin[i]
    if (!c) break
    s += String.fromCharCode(c)
  }
  const vm = /^(\d+)\.(\d+)\.\d+$/.exec(s)
  if (!vm) return null
  return vm[1] === '4' ? `4.${vm[2]}` : `${vm[1]}.x`
}

/** 二进制骨架放进 rawDataURIs（data URI），播放器不再用 XHR 拉 /spine/。
 *  JSON 做成 blob，3.8 转换和正片都读这份完整文本。 */
function attachNativeSkeleton(item, urls) {
  if (!NATIVE || !item || !urls || !item.relSkeleton) return false
  const bin = nativeAssetBytes(item.relSkeleton)
  if (!bin || bin.length < 16) return false
  const kind = item.skeletonKind || urls.skeletonKind
  if (kind === 'json') {
    let text = ''
    try { text = new TextDecoder('utf-8').decode(bin) } catch { return false }
    if (!text) return false
    item.__jsonText = text
    const u = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    urls.skeletonUrl = u
    urls.jsonUrl = u
    urls.__nativeBlob = u
    return true
  }
  const ver = spineMinorFromBytes(bin)
  // 重试别的运行时时不要被文件头版本盖回去，否则会永远停在第一次那个 minor。
  if (ver && !(item.__spineTried && item.__spineTried.length)) {
    if (!(isNikkeCacheItem(item) && ver === '4.0')) {
      item._spineMinor = ver
      item.spineMinor = ver
    }
  }
  item.__skelBytes = bin.length
  if (!urls.rawDataURIs) urls.rawDataURIs = {}
  try {
    urls.rawDataURIs[urls.skeletonUrl] = 'data:application/octet-stream;base64,' + bytesToB64(bin)
    return true
  } catch { /* 落到 blob */ }
  const u = URL.createObjectURL(new Blob([bin], { type: 'application/octet-stream' }))
  urls.skeletonUrl = u
  urls.__nativeBlob = u
  return true
}

/** 播放页里切姿势（NIKKE 的 普通/瞄准/掩体；Ark 的形态：本体/战斗形态/CG a…）。S.current 不变（还是那张卡），
 *  只是把「实际加载的骨架」指到对应成员再重走一遍载入。 */
function switchPose(pose) {
  const it = S.current
  if (!it || !Array.isArray(it.members) || it.members.length < 2) return
  if (pose === (S.currentPose || defaultPoseOf(it))) return
  S.currentPose = pose
  loadCurrent()
}

/** 一个分组条目的「默认成员」。NIKKE 是 pose==='normal' 的本体；Ark 没有 normal 概念 ——
 *  默认成员就是 members[0]（nikkeViewFor 已把本体排在最前）。 */
function defaultPoseOf(item) {
  if (!item || !Array.isArray(item.members) || !item.members.length) return 'normal'
  const n = item.members.find(m => m.pose === 'normal')
  return n ? 'normal' : item.members[0].pose
}

async function loadCurrent() {
  const item = S.current
  if (!item) return
  // Never start spine-player on an unpack placeholder — invalid bounds / 404.
  if (item.pendingUnpack) {
    openPendingUnpack(item)
    return
  }
  disposePlayer()
  clearError()
  resetMeta()

  $('currentName').textContent = S.mode === 'ark' ? displayNameOf(item) : item.folder
  if (item.imageOnly) {
    const n = (item.relImages || []).length
    $('currentSub').textContent = [item.group, t('CG · {n} 张', { n })].filter(Boolean).join(' · ')
    $('emptyState').hidden = true
    showStillImage(item, 0)
    setBusy(false)
    setLoadProgress(null)
    renderAnimList()
    return
  }
  // NIKKE 姿势变体：副标题里写明当前加载的是哪个成员（c022_aim_00），别让人以为还在本体上
  const member = activeMemberOf(item)
  $('currentSub').textContent = S.mode === 'ark'
    // Ark：形态切换后副标题要跟着换（member 可能是另一个 bundle），形态名用 formLabel
    ? (() => {
        const mk = member && member.ark ? member.ark : item.ark
        const forms = Array.isArray(item.members) && item.members.length > 1
          ? t('{n} 个形态', { n: item.members.length }) : ''
        return [arkCurrentSub(Object.assign({}, item, { ark: mk })), forms].filter(Boolean).join(' · ')
      })()
    : [item.group, member.base, item.skeletonKind ? `.${item.skeletonKind}` : '',
      item.backLayer ? t('含背层') : '']
        .filter(Boolean).join(' · ')
  $('emptyState').hidden = true
  setBusy(true, t('载入中…'))
  setLoadProgress({ stage: t('阶段：加载骨架'), indeterminate: true })

  const urls = urlsForItem(member)
  // 手机 WebView 的 XHR arraybuffer 会把拦截到的 .skel 截断，4.1 运行时就读出空动画。
  // 二进制改走 data URI，播放器内部不再发 XHR。
  if (attachNativeSkeleton(member, urls) && urls.__nativeBlob) spineJsonBlobs.push(urls.__nativeBlob)

  // 骨架版本 → 运行时。要 await（读骨架头），所以放在建播放器之前。
  // 除了钉在 S.spine 上，还挂到 player 实例上（__spineRt / __spineMinor）：onLoaded
  // 是异步回调，期间用户可能已经切到别的资产并把 S.spine 改成另一套，只有实例上
  // 的那份不会错。__spineMinor 供 onLoaded 对照骨架自报版本，错世代时重载一次。
  const spineMinor = await spineMinorFor(member)
  // 旧世代的**二进制**骨架：4.x 的 SkeletonBinary 读不了（会抛一句看不懂的话），
  // 与其给用户一条无从下手的报错，不如在初始化前说清楚。
  //
  // ⚠️ 只对二进制拦。**JSON 骨架不要拦** —— 实测 3.8.99 导出的 JSON 用 4.1 运行时
  // 能正常读（骨/槽/动画都在，逐条播放无 NaN）。JCZX 缓存里 131/135 就是这种，
  // 一揽子拦掉等于把这批资产全废掉。（当初看到「Animation bounds are invalid」
  // 以为是世代问题，其实是提取器漏导骨架导致的空骨架，见 jczx_extract.py。）
  if (member.skeletonKind === 'skel' && spineMinor && !/^4\.[012]$/.test(spineMinor)) {
    setBusy(false)
    setLoadProgress(null)
    showError(t('这套资产由 Spine {v} 导出，查看器目前支持 Spine 4.0 / 4.1 / 4.2，暂时播不了。\n'
      + '可以用 Spine 官方编辑器把它重新导出为 4.x 再放进目录。', { v: spineMinor.replace(/\.x$/, '') }))
    return
  }
  const rt = spineRuntimeForVer(spineMinor)
  S.spine = rt

  const cfg = {
    showControls: false,
    showLoading: false,
    atlasUrl: urls.atlasUrl,
    backgroundColor: '00000000',
    premultipliedAlpha: S.premultiplied,
    preserveDrawingBuffer: true,
    alpha: true,
    viewport: {
      x: 0, y: 0, width: 100, height: 100,
      padLeft: 0, padRight: 0, padTop: 50, padBottom: 50,
      transitionTime: 0,
    },
    update: onFrame,
    success: onLoaded,
    error: (p, msg) => {
      setBusy(false)
      const m = typeof msg === 'string' ? msg : JSON.stringify(msg)
      // 4.2 运行时读 4.1（或反过来）会在 DataView 上越界，而不是报「没有动画」。
      // 换一个 minor 再试，最多两次。
      if (/DataView|Could not load skeleton/i.test(m) && member.skeletonKind !== 'json') {
        const tried = member.__spineTried || []
        const used = (p && p.__spineMinor) || member._spineMinor
        const next = ['4.1', '4.2', '4.0'].find(v => v !== used && !tried.includes(v))
        if (next && tried.length < 2) {
          member.__spineTried = tried.concat(used || '')
          member._spineMinor = next
          member.spineMinor = next
          setTimeout(() => { try { loadCurrent() } catch { /* ignore */ } }, 0)
          return
        }
      }
      // Spine-player: incomplete extract / missing textures → empty getBounds.
      // If unpack toast still running, send user back to wait instead of hard fail.
      if (/Animation bounds are invalid/i.test(m)) {
        // 只有真的还有包在后台解包时才提示「等解包」——别把 3.x 旧骨架等其它原因
        // 也误报成「尚未解包完成」（2026-10-01 用户截图）。
        const unpacking = (jczxPrev && ((jczxPrev.pending || 0) + (jczxPrev.inFlight || 0) > 0))
          || (nikkeAbPrev && ((nikkeAbPrev.pending || 0) + (nikkeAbPrev.inFlight || 0) > 0))
        if (unpacking) {
          toast(t('等待解包…'))
          showError(t('载入失败：') + m + '\n' + t('资产可能尚未解包完成，请稍后再打开。'))
          return
        }
      }
      showError(t('载入失败：') + m)
    },
  }
  // 3.x 的 JSON 骨架先转成 4.x 能读的形状（见 spineJson38to41），包成 blob URL 给播放器。
  // 不回收会一直占内存 → 每轮加载开头统一回收上一轮的（见 disposePlayer）。
  const jsonCompat = await spineJsonUrlFor(member, urls)
  if (jsonCompat && jsonCompat.blob) spineJsonBlobs.push(jsonCompat.blob)
  applySkeletonCfg(cfg, urls, jsonCompat)
  if (Object.keys(urls.rawDataURIs || {}).length) cfg.rawDataURIs = urls.rawDataURIs

  // 骨架 JSON 先自己验一遍再交给播放器：spine-player 内部的 JSON.parse 抛出的
  // SyntaxError 不会走 error 回调，会变成 uncaught error 弹满屏红条还关不掉。
  // 2026-09-24 用户实测：某个 mod 的 .json 是坏文件（50MB+，解析到 5600 万字符处
  // 格式错误），在这里拦下来给一句能看懂的提示，选别的资产继续用。
  if (cfg.jsonUrl) {
    try {
      const res = await fetch(cfg.jsonUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      try {
        JSON.parse(text)
      } catch (e) {
        setBusy(false)
        showError(t('「{folder}」的 .json 是坏文件（{msg}）。\n', { folder: item.folder, msg: e.message }) +
          t('多半是下载/拷贝不完整：重新导出一份完整文件，或先看别的资产。'))
        return
      }
    } catch (e) {
      setBusy(false)
      showError(t('读不到骨架文件：') + e.message)
      return
    }
  }

  try {
    setLoadProgress({ stage: t('阶段：渲染'), indeterminate: true })
    S.player = new rt.SpinePlayer($('playerHost'), cfg)
    S.player.__spineRt = rt
    S.player.__spineMinor = spineMinor
    S.player.__spineVerRetry = !!member.__spineVerRetry
    member.__spineVerRetry = false
  } catch (err) {
    setBusy(false)
    showError(t('初始化播放器失败：') + err.message)
  }

  // Lost Sword 两层角色：背层单独一个播放器，叠在本体下面（R19）。
  // 背层加载失败只丢背层，本体照常显示 —— 不能因为一层坏了整张卡打不开。
  if (S.mode === 'lostsword' && item.backLayer) createBackLayer(item.backLayer, rt)
}

/** 建背层播放器（Lost Sword 的 `_B`）。它被 stopRendering + 暂停，
 *  时间轴与相机全由主循环的 syncBackLayer() 驱动，所以两层永远同步。 */
function createBackLayer(backItem, mainRt) {
  const host = document.createElement('div')
  host.className = 'player-host-back'
  host.id = 'playerBackHost'
  const stage = $('stageInner')
  const mainHost = $('playerHost')
  if (!stage || !mainHost) return
  stage.insertBefore(host, mainHost)     // 主体之下
  S.backItem = backItem

  const build = async () => {
    let rt = mainRt
    try { rt = spineRuntimeForVer(await spineMinorFor(backItem)) } catch { /* 用本体的运行时 */ }
    const urls = urlsForItem(backItem)
    const cfg = {
      showControls: false,
      showLoading: false,
      atlasUrl: urls.atlasUrl,
      backgroundColor: '00000000',
      premultipliedAlpha: S.premultiplied,
      preserveDrawingBuffer: true,
      alpha: true,
      viewport: {
        x: 0, y: 0, width: 100, height: 100,
        padLeft: 0, padRight: 0, padTop: 50, padBottom: 50,
        transitionTime: 0,
      },
      success: bp => {
        if (S.backPlayer !== bp) return       // 期间用户已经切走 → 丢掉这一层
        try {
          const data = bp.skeleton?.data
          const best = data && (data.skins || []).length > 1 ? fullestSkin(data, rt) : null
          if (best) {
            const composed = composeSkin(rt, data, best.name)
            if (composed) bp.skeleton.setSkin(composed)
            else bp.skeleton.setSkinByName(best.name)
          }
          bp.skeleton.setSlotsToSetupPose()
          skeletonUpdateWorld(bp.skeleton)
        } catch { /* 尽力而为 */ }
        bp.pause()
        bp.stopRendering()                    // 只由主循环驱动，避免两套 rAF 各画一帧
        drawBackLayer()
        if (S.bounds) refitBounds(false)      // 背层常比本体宽，重新取景把两层都框进来
      },
      error: () => { /* 背层失败：静默丢掉，本体照常 */ },
    }
    if (urls.skeletonKind === 'json' && backItem._spine38) {
      // 背层是 3.8 JSON 的话也走一遍转换（Lost Sword 全是 4.1，但别留死角）
      const bc = await spineJsonUrlFor(backItem, urls)
      if (bc && bc.blob) spineJsonBlobs.push(bc.blob)
      applySkeletonCfg(cfg, urls, bc)
    } else {
      applySkeletonCfg(cfg, urls, null)
    }
    if (Object.keys(urls.rawDataURIs || {}).length) cfg.rawDataURIs = urls.rawDataURIs
    try {
      const bp = new rt.SpinePlayer(host, cfg)
      bp.__spineRt = rt
      bp.__item = backItem
      S.backPlayer = bp
    } catch { /* 建不起来就当没有背层 */ }
  }
  build().catch(() => { /* 背层整条链失败也不影响本体 */ })
}

/** 背层沿**它自己的**动画采样测内容框。
 *  不能用本体的 animationState：Spine 的时间轴按各自骨架的索引算，交叉 apply 会错位。 */
function backLayerBounds() {
  const bp = S.backPlayer
  if (!bp || !bp.skeleton) return null
  const st = bp.animationState
  const entry = st && st.getCurrent(0)
  const frames = []
  if (entry && entry.animation) {
    const saved = entry.trackTime
    for (let i = 0; i < 16; i++) {
      try {
        entry.trackTime = (i / 16) * (entry.animation.duration || 0)
        entry.animationLast = -1
        entry.nextAnimationLast = -1
        st.apply(bp.skeleton)
        skeletonUpdateWorld(bp.skeleton)
      } catch { continue }
      const box = contentBoxOf(bp.skeleton)
      if (box) frames.push(box)
    }
    try {
      entry.trackTime = saved
      st.apply(bp.skeleton)
      skeletonUpdateWorld(bp.skeleton)
    } catch { /* ignore */ }
  } else {
    try {
      bp.skeleton.setToSetupPose()
      skeletonUpdateWorld(bp.skeleton)
    } catch { /* ignore */ }
  }
  const box = frames.length ? unionBoxes(frames) : contentBoxOf(bp.skeleton)
  return boundsFromBox(box)
}

function unionBounds(a, b) {
  if (!a) return b
  if (!b) return a
  const V2 = activeSpine().Vector2
  const minX = Math.min(a.offset.x, b.offset.x)
  const minY = Math.min(a.offset.y, b.offset.y)
  const maxX = Math.max(a.offset.x + a.size.x, b.offset.x + b.size.x)
  const maxY = Math.max(a.offset.y + a.size.y, b.offset.y + b.size.y)
  return { offset: new V2(minX, minY), size: new V2(maxX - minX, maxY - minY) }
}

/** 取景用的内容框 = 本体 ∪ 背层（R19）。背层（大头发 / 披风）常比本体宽，只按本体量会切边。 */
function computeStageBounds() {
  const p = S.player
  if (!p || !p.skeleton) return null
  const main = computeBounds(p.skeleton)
  return unionBounds(main, backLayerBounds())
}

function showStillImage(item, index) {
  const imgs = item.relImages || []
  if (!imgs.length) {
    showError(t('缺少贴图 .png'))
    return
  }
  const i = ((index % imgs.length) + imgs.length) % imgs.length
  item._stillIndex = i
  const host = $('playerHost')
  host.innerHTML = ''
  const img = document.createElement('img')
  img.id = 'stillImage'
  img.alt = ''
  img.draggable = false
  img.src = assetUrl(imgs[i])
  img.style.cssText = 'position:absolute;inset:0;margin:auto;max-width:100%;max-height:100%;object-fit:contain;'
  host.appendChild(img)
  const n = imgs.length
  $('currentSub').textContent = [item.group, n > 1 ? t('CG {i}/{n}', { i: i + 1, n }) : t('CG · {n} 张', { n })]
    .filter(Boolean).join(' · ')
}

function cycleStillImage(dir) {
  const item = S.current
  if (!item || !item.imageOnly) return
  const n = (item.relImages || []).length
  if (n < 2) return
  const i = (item._stillIndex || 0) + dir
  showStillImage(item, i)
  if (!cleanUI) toast(t('CG {i}/{n}', { i: ((i % n) + n) % n + 1, n }))
}

/* ------------------------------------------------------- Ark：立绘网格 / 语音列表

   星陨计划的每个角色目录里除了骨架，还有一整套静图与语音（实测 2231 张 PNG、
   1000 条 wav），素材自己的 viewer 能看，我们原来只拿它们当缩略图背景。

   · 立绘（meta.staticAssets 里 kind==='full'，实测 160 张）竖幅大图，点开看原图；
     头像/技能图标也列出来，方便认人。
   · 语音（`runtime/voice/*.wav`，命名绑定事件如 `H001_Death_*.wav`）点一下就播。
   两块的显隐都只在 ark 档为真（resetMeta 收起来，onLoaded 按 S.current 重挂），
   别的档不受影响。 */

/** 立绘/图标网格。非 ark 档或没有静图时整组隐藏。 */
function renderArkStatics() {
  const group = $('arkStaticGroup')
  const grid = $('arkStaticGrid')
  if (!group || !grid) return
  const item = S.current
  const list = (S.mode === 'ark' && item && item.ark && Array.isArray(item.ark.statics))
    ? item.ark.statics.filter(s => s && s.url) : []
  grid.innerHTML = ''
  group.hidden = list.length === 0
  if (!list.length) return

  // 立绘排前面（用户最常看的就是它），其余按 kind 再排
  const order = { full: 0, face: 1 }
  const sorted = [...list].sort((a, b) =>
    (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.label.localeCompare(b.label))

  for (const s of sorted) {
    const cell = document.createElement('div')
    cell.className = 'ark-static-cell'
    const img = document.createElement('img')
    img.alt = ''
    img.loading = 'lazy'
    img.draggable = false
    img.src = assetUrl(s.url)
    img.title = s.label + (s.width ? t(' · {w}×{h}', { w: s.width, h: s.height }) : '')
    cell.appendChild(img)
    const kind = document.createElement('div')
    kind.className = 'ark-kind'
    kind.textContent = arkStaticKindLabel(s)
    cell.appendChild(kind)
    cell.addEventListener('click', () => openArkImage(s))
    grid.appendChild(cell)
  }
}

function arkStaticKindLabel(s) {
  if (s.kind === 'full') return t('立绘')
  if (s.kind === 'face') return t('头像')
  return s.label
}

/** 点立绘 → 在播放页叠一张看原图的图层。
 *  ⚠️ **别用 host.innerHTML = ''** —— 那会把播放器（连它的 canvas）从 DOM 上摘掉，
 *  之后 disposePlayer / 渲染循环再摸这个 canvas 就抛 "Unable to render skeleton"。
 *  正解是新建一个覆盖层，原样保留播放器节点，关闭时只摘掉覆盖层。
 *  （`host.innerHTML` 备份再恢复也不可行：canvas 的 WebGL 上下文会随节点移动丢失。）
 */
function openArkImage(s) {
  if (!s || !s.url) return
  const host = $('playerHost')
  if (!host) return
  closeArkImage(true)            // 已经在看图就换一张，别叠两层
  const layer = document.createElement('div')
  layer.id = 'arkImageLayer'
  layer.style.cssText = 'position:absolute;inset:0;z-index:5;background:var(--g900);display:flex;align-items:center;justify-content:center;cursor:zoom-out;'
  const img = document.createElement('img')
  img.id = 'arkFullImage'
  img.alt = ''
  img.draggable = false
  img.src = assetUrl(s.url)
  img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;'
  layer.appendChild(img)
  layer.addEventListener('click', () => closeArkImage())
  host.appendChild(layer)
  $('currentSub').textContent = [s.label, s.width ? t('{w}×{h}', { w: s.width, h: s.height }) : '']
    .filter(Boolean).join(' · ')
}

/** 关掉立铺大图。quiet=true 时只是清掉覆盖层、不重载（内部换图用）。 */
function closeArkImage(quiet) {
  const layer = $('arkImageLayer')
  if (!layer) return
  layer.remove()
  if (!quiet && S.current) loadCurrent()   // 副标题回到角色信息
}

/** 语音列表。点一条播一次，同时停掉上一条（别叠音）。 */
let arkVoiceAudio = null
function renderArkVoices() {
  const group = $('arkVoiceGroup')
  const list = $('arkVoiceList')
  if (!group || !list) return
  const item = S.current
  const voices = (S.mode === 'ark' && item && item.ark && Array.isArray(item.ark.voices))
    ? item.ark.voices.filter(v => v && v.url) : []
  list.innerHTML = ''
  group.hidden = voices.length === 0
  if (!voices.length) return

  for (const v of voices) {
    const row = document.createElement('div')
    row.className = 'list-item'
    const nm = document.createElement('div')
    nm.className = 'voice-name'
    nm.textContent = v.name
    nm.title = v.file
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn'
    btn.textContent = t('播放')
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      playArkVoice(v, btn)
    })
    row.appendChild(nm)
    row.appendChild(btn)
    list.appendChild(row)
  }
}

function playArkVoice(v, btn) {
  // 正在播的就是这条 → 当成「停止」；否则先掐掉上一条再放新的（别叠音）。
  // 顺序要紧：先记住是不是同一条，再把句柄清掉，反过来就永远判不相等。
  const same = !!arkVoiceAudio && arkVoiceAudio.__rel === v.url
  stopArkVoice()
  if (btn) btn.textContent = t('播放')
  if (same) return
  const a = new Audio(assetUrl(v.url))
  a.__rel = v.url
  a.addEventListener('ended', () => { if (btn) btn.textContent = t('播放') })
  a.addEventListener('error', () => {
    if (btn) btn.textContent = t('播放')
    showError(t('语音加载失败'))
  })
  if (btn) btn.textContent = t('播放中…')
  arkVoiceAudio = a
  S.__arkAudio = a         // 调试面探针（R10）：new Audio 的元素不在 DOM 里，排障只能靠它
  a.play().catch(err => {
    if (btn) btn.textContent = t('播放')
    // 自动播放被浏览器策略拒（NotAllowedError）不是故障 —— 音频已解码，
    // 用户再点一次就能播。别在这种情形下弹错误框吓人。
    if (err && err.name === 'NotAllowedError') return
    showError(t('语音播放失败'))
  })
}

/** 停掉正在播的语音（切资产 / 切形态 / 卸载时用）。 */
function stopArkVoice() {
  if (!arkVoiceAudio) return
  try { arkVoiceAudio.pause() } catch { /* 忽略 */ }
  arkVoiceAudio = null
  for (const b of document.querySelectorAll('#arkVoiceList .btn')) b.textContent = t('播放')
}

function disposePlayer() {
  // 本轮加载用过的「3.x→4.x 转换后」blob 在这里回收（必须在下面的 early return 之前，
  // 否则「主体还没建起来就切走」的情况会把 blob 漏掉）
  dropSpineJsonBlobs()
  // 背层先拆（它是独立的播放器 + DOM，不跟着本体走）
  if (S.backPlayer) {
    try { S.backPlayer.dispose() } catch { /* ignore */ }
    S.backPlayer = null
  }
  S.backItem = null
  const bh = document.getElementById('playerBackHost')
  if (bh) bh.remove()
  const host = $('playerHost')
  if (host && !S.player) host.innerHTML = ''
  if (!S.player) return
  try { S.player.dispose() } catch { /* ignore */ }
  S.player = null
  S.camera = null
  $('playerHost').innerHTML = ''
}

function resetMeta() {
  S.animations = []
  S.skins = []
  S.slots = []
  S.hidden = new Set()
  S.hiddenStack = []
  S.selectedLayer = null
  S.bounds = null
  $('animList').innerHTML = ''
  $('skinSelect').innerHTML = ''
  $('layerList').innerHTML = ''
  const pg = $('poseGroup')
  if (pg) pg.hidden = true       // 姿势条随数据重挂（onLoaded → renderPoseBar）
  // Ark 的立绘网格 / 语音列表同理：先收起来，等 onLoaded 后按新资产重挂。
  // 语音还要停 —— 正在播的音频属于上一个角色，别让它接着响。
  for (const id of ['arkStaticGroup', 'arkVoiceGroup']) {
    const g = $(id)
    if (g) g.hidden = true
  }
  stopArkVoice()
  $('seek').value = 0
  syncStageNav()            // 动画清空了 → 两侧箭头跟着收起来
}

/* ------------------------------------------------------------------ 载入完成 */

function onLoaded(player) {
  const skeleton = player.skeleton
  if (!skeleton) {
    setBusy(false)
    showError(t('骨架为空：请确认 .json 与 .atlas 是否匹配'))
    return
  }

  // R16：错世代运行时读二进制时，版本串往往仍正确，但动画会被读空。
  // 对照骨架自报版本，不一致则按正确 minor 重载一次（解包 NIKKE=4.1 却落到 4.0 默认时）。
  const reported = String(skeleton.data?.version || '')
  const rm = /^4\.(\d)\./.exec(reported)
  if (rm) {
    const actual = `4.${rm[1]}`
    const used = player.__spineMinor
    if (used && actual !== used && !player.__spineVerRetry) {
      const member = S.current ? activeMemberOf(S.current) : null
      if (member) {
        member._spineMinor = actual
        member.spineMinor = actual
        member.__spineVerRetry = true
        setTimeout(() => { try { loadCurrent() } catch { /* ignore */ } }, 0)
        return
      }
    }
  }

  skeleton.setToSetupPose()
  skeletonUpdateWorld(skeleton)

  // 动画 / 皮肤 / 图层（优先 animationState；空时回退 skeleton.data，避免偶发空列表）
  const animSrc = player.animationState?.data?.skeletonData?.animations
  const animFallback = skeleton.data?.animations
  const animList = (animSrc && animSrc.length ? animSrc : (animFallback || []))
  // 4.0 运行时读 4.1 骨架时，版本串有时也读不出来，上面的对照不会触发，动画直接是空的。
  // 解包缓存只可能是 4.1，空列表就换 4.1 再载一次。
  if (!animList.length && !player.__spineVerRetry) {
    const member = S.current ? activeMemberOf(S.current) : null
    if (member && (S.mode === 'nikke' || isNikkeCacheItem(member))) {
      const tried = member.__spineTried || []
      const next = ['4.1', '4.2', '4.0'].find(v => v !== player.__spineMinor && !tried.includes(v))
      if (next) {
        member.__spineTried = tried.concat(player.__spineMinor || '')
        member._spineMinor = next
        member.spineMinor = next
        member.__spineVerRetry = true
        setTimeout(() => { try { loadCurrent() } catch { /* ignore */ } }, 0)
        return
      }
    }
  }
  S.animations = animList.map(a => a.name)
  S.skins = (skeleton.data?.skins || []).map(s => s.name)
  S.slots = (skeleton.data?.slots || []).map(s => s.name)
  renderAnimList()
  renderSkinSelect()
  renderPoseBar()
  // Ark：立绘网格 + 语音列表。非 ark 档这两块自己 hidden 掉（函数内有守卫）。
  renderArkStatics()
  renderArkVoices()
  // 初始皮肤挑覆盖最全的（多皮肤骨架里 default 常常只有零头，见皮肤一节的说明），
  // 必须在算取景框之前定下来，否则取景是按残缺身体量的。
  // 口径是「摆好姿势后实际出图的槽位数」，所以要把当前播放器的运行时传进去。
  const bestSkin = fullestSkin(skeleton.data, player.__spineRt || activeSpine())
  if (bestSkin && S.skins.length > 1) {
    $('skinSelect').value = bestSkin.name
    applySkin(bestSkin.name, { redraw: false })
  }
  renderLayerList()
  syncStageNav()            // 动画列表变了 → 两侧箭头的显隐跟着变

  // 默认动画：取景测量必须沿着一个真实动画采样，所以先定动画再算取景框
  const pick = pickDefaultAnimation()
  if (pick) {
    player.animationState.setAnimation(0, pick, S.loop)
    const e = player.animationState.getCurrent(0)
    if (e) e.trackTime = 0
  } else {
    const reported = String((player.skeleton && player.skeleton.data && player.skeleton.data.version) || '')
    const memberNow = S.current ? activeMemberOf(S.current) : null
    showError(t('这个骨架里没有任何动画')
      + `\nruntime ${player.__spineMinor || '?'} / skeleton ${reported || '?'} / bytes ${memberNow && memberNow.__skelBytes || '?'}`)
  }

  // 取景框（沿当前动画采样实测内容范围；有背层时按两层并集，R19）
  S.bounds = computeStageBounds()
  player.config.viewport = {
    x: S.bounds.offset.x, y: S.bounds.offset.y,
    width: Math.max(S.bounds.size.x, 1), height: Math.max(S.bounds.size.y, 1),
    padLeft: 0, padRight: 0, padTop: 50, padBottom: 50,
    transitionTime: 0, animations: {},
  }

  // 自建相机。类必须和播放器同源（4.0 的播放器配 4.0 的 OrthoCamera）——
  // 实例上记着的那套最准，S.spine 只作兜底。
  const rt = player.__spineRt || activeSpine()
  const renderCam = player.sceneRenderer.camera
  S.camera = new rt.OrthoCamera(renderCam.viewportWidth, renderCam.viewportHeight)
  S.camera.position.x = S.bounds.offset.x + S.bounds.size.x / 2
  S.camera.position.y = S.bounds.offset.y + S.bounds.size.y / 2
  S.camera.zoom = 1
  S.camera.update()
  fitToWindow()
  new rt.CameraController(player.canvas, S.camera)

  renderAnimList()

  applyBgAlpha(true)
  $('emptyState').hidden = true
  setBusy(false)
  setPlaying(S.autoPlay)
  updatePlayButton()
  updateProgressReadout()
}

/** 默认动画优先级：姿势专属的 idle（aim→aim_idle、cover→cover_idle，与参考站一致）
 *  → idle → once → 含 idle 的 → 第一个
 *  Ark 的 pose 是 bundle 名（`H001_S`），不是动画名的一部分，所以只当字面量用
 *  （并且这里只做 startsWith 判定，别把来路不明的字符串塞进 RegExp）。 */
function pickDefaultAnimation() {
  const a = S.animations
  if (!a.length) return null
  const pose = S.currentPose || defaultPoseOf(S.current)
  if (pose && pose !== 'normal') {
    const want = String(pose).toLowerCase() + '_idle'
    const poseIdle = a.find(x => String(x).toLowerCase() === want)
    if (poseIdle) return poseIdle
  }
  const exact = n => a.find(x => x.toLowerCase() === n)
  return exact('idle') || exact('once') || a.find(x => /idle/i.test(x)) || a[0]
}

/* ------------------------------------------------------------------ 取景范围
 * 不能用 skeleton.getBounds()：BD2 的 cutscene 骨架经常把部件停在绑定姿势的
 * 很远位置（实测有 x≈-5000 的），照绑定姿势算出来的取景框会完全偏到空处。
 * 正确做法是沿动画采样，取每帧实际内容外框的并集。
 */

function contentBoxOf(skeleton) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let found = false
  for (const slot of skeleton.drawOrder) {
    if (slot.color && slot.color.a <= 0) continue
    const att = slot.getAttachment && slot.getAttachment()
    if (!att || typeof att.computeWorldVertices !== 'function') continue
    const n = att.worldVerticesLength || 0
    if (!n) continue
    const v = new Float32Array(n)
    try { att.computeWorldVertices(slot, 0, n, v, 0, 2) } catch { continue }
    for (let i = 0; i < v.length; i += 2) {
      const x = v[i], y = v[i + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      found = true
    }
  }
  return found && maxX > minX && maxY > minY ? { minX, minY, maxX, maxY } : null
}

function unionBoxes(frames) {
  if (!frames.length) return null
  // 去掉面积远超中位数的帧（例如某个特效瞬间飞到很远），避免取景框被撑爆
  const area = f => (f.maxX - f.minX) * (f.maxY - f.minY)
  const sorted = frames.map(area).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 1
  const keep = frames.filter(f => area(f) <= median * 4 + 1)
  const use = keep.length ? keep : frames
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const f of use) {
    if (f.minX < box.minX) box.minX = f.minX
    if (f.minY < box.minY) box.minY = f.minY
    if (f.maxX > box.maxX) box.maxX = f.maxX
    if (f.maxY > box.maxY) box.maxY = f.maxY
  }
  return box
}

/** 沿一个动画采样，返回内容外框（会临时改姿势，结束后恢复） */
function measureAnimationBox(skeleton, entry, samples = 16) {
  const st = S.player?.animationState
  if (!st) return null
  const savedTime = entry ? entry.trackTime : 0
  const frames = []
  for (let i = 0; i < samples; i++) {
    try {
      if (entry) {
        entry.trackTime = (i / samples) * (entry.animation.duration || 0)
        entry.animationLast = -1
        entry.nextAnimationLast = -1
        st.apply(skeleton)
      } else {
        skeleton.setToSetupPose()
      }
      skeletonUpdateWorld(skeleton)
    } catch { continue }
    const b = contentBoxOf(skeleton)
    if (b) frames.push(b)
  }
  if (entry) {
    try {
      entry.trackTime = savedTime
      entry.animationLast = -1
      st.apply(skeleton)
      skeletonUpdateWorld(skeleton)
    } catch { /* ignore */ }
  }
  return unionBoxes(frames)
}

function boundsFromBox(box, padding = 50) {
  if (!box) return null
  const w = box.maxX - box.minX
  const h = box.maxY - box.minY
  if (!(w > 0) || !(h > 0)) return null
  const V2 = activeSpine().Vector2
  return {
    offset: new V2(box.minX - padding, box.minY - padding),
    size: new V2(w + padding * 2, h + padding * 2),
  }
}

/**
 * 借用 spine-player 自带的 calculateAnimationViewport（沿动画 100 步采样取并集）来测内容范围。
 * 做法：临时把 config.viewport 的显式范围与内边距清零，调 setViewport(动画名) 让它自动计算，
 * 读完 currentViewport 再还原。
 */
function libraryContentBox(animName) {
  const p = S.player
  if (!p || !p.animationState || !p.skeleton || !animName) return null
  const saved = p.config.viewport
  try {
    const vp = {
      padLeft: 0, padRight: 0, padTop: 0, padBottom: 0,
      transitionTime: 0, animations: {},
    }
    p.config.viewport = vp
    p.setViewport(animName)
    const cur = p.currentViewport
    if (!cur || !(cur.width > 0) || !(cur.height > 0)) return null
    return {
      minX: cur.x, minY: cur.y,
      maxX: cur.x + cur.width, maxY: cur.y + cur.height,
    }
  } catch {
    return null
  } finally {
    p.config.viewport = saved
  }
}

function computeBounds(skeleton) {
  // 1) 库自带算法（最准，100 步采样）
  const box = libraryContentBox(currentAnimation()?.name)
  if (box) {
    const b = boundsFromBox(box)
    if (b) return b
  }

  // 2) 自己采样 16 帧
  const entry = S.player?.animationState?.getCurrent(0)
  const measured = boundsFromBox(measureAnimationBox(skeleton, entry))
  if (measured) return measured

  // 3) 绑定姿势
  try {
    skeleton.setToSetupPose()
    skeletonUpdateWorld(skeleton)
  } catch { /* ignore */ }
  const setup = boundsFromBox(contentBoxOf(skeleton))
  if (setup) return setup

  // 4) 最后退回骨架自带 bounds
  const V2 = activeSpine().Vector2
  const offset = new V2()
  const size = new V2()
  try { skeleton.getBounds(offset, size) } catch { /* ignore */ }
  if (!(size.x > 0) || !(size.y > 0)) { offset.x = -500; offset.y = -500; size.x = 1000; size.y = 1000 }
  return { offset, size }
}

/* ------------------------------------------------------------------ 每帧回调 */

function onFrame(player) {
  const cam = player.sceneRenderer.camera
  if (S.camera) {
    // canvas 尺寸变化时同步我自己的相机视口（zoom 不动，交给用户按「适配窗口」重算）
    if (S.camera.viewportWidth !== cam.viewportWidth || S.camera.viewportHeight !== cam.viewportHeight) {
      S.camera.viewportWidth = cam.viewportWidth
      S.camera.viewportHeight = cam.viewportHeight
      S.camera.update()
    }
    cam.position.x = S.camera.position.x
    cam.position.y = S.camera.position.y
    cam.zoom = S.camera.zoom
  }
  applyLayerVisibility(player.skeleton)
  drawOverlay()
  updateProgressReadout()
  syncBackLayer()
}

/** 背层跟随本体：动画名 → 时间轴 → 相机（R19）。
 *  背层是 pause + stopRendering 的，所以它每一帧的画面完全由这里驱动 ——
 *  两层用同一个时间轴，动作不会错位。 */
function syncBackLayer() {
  const bp = S.backPlayer
  if (!bp || !bp.skeleton) return
  try {
    const mainEntry = S.player?.animationState?.getCurrent(0)
    if (mainEntry && mainEntry.animation) {
      const name = mainEntry.animation.name
      const cur = bp.animationState.getCurrent(0)
      if (!cur || cur.animation.name !== name) {
        // 两层的动画集合可能不同：背层没有同名动画时保持它自己的，别清空
        const has = (bp.animationState.data?.skeletonData?.animations || []).some(a => a.name === name)
        if (has) bp.animationState.setAnimation(0, name, S.loop)
      }
      const be = bp.animationState.getCurrent(0)
      if (be) be.trackTime = mainEntry.trackTime
      bp.animationState.apply(bp.skeleton)
      skeletonUpdateWorld(bp.skeleton)
    }
  } catch { /* 背层同步失败不该影响本体 */ }
  if (S.camera) {
    const bcam = bp.sceneRenderer.camera
    bcam.position.x = S.camera.position.x
    bcam.position.y = S.camera.position.y
    bcam.zoom = S.camera.zoom
  }
  drawBackLayer()
}

function applyLayerVisibility(skeleton) {
  if (!skeleton || !S.hidden.size) return
  for (const slot of skeleton.slots) {
    const n = slot.data && slot.data.name
    if (!n || !S.hidden.has(n)) continue
    if (slot.color) slot.color.a = 0
    if (slot.darkColor) slot.darkColor.a = 0
  }
}

function restoreLayerAlpha(name) {
  const skeleton = S.player?.skeleton
  if (!skeleton) return
  const slot = skeleton.slots.find(s => s.data && s.data.name === name)
  if (!slot) return
  if (slot.color) {
    const a = slot.data?.color?.a
    slot.color.a = typeof a === 'number' ? a : 1
  }
  if (slot.darkColor) {
    const a = slot.data?.darkColor?.a
    if (typeof a === 'number') slot.darkColor.a = a
  }
}

function updateProgressReadout() {
  const p = S.player
  if (!p || !p.animationState) return
  const entry = p.animationState.getCurrent(0)
  if (!entry || !entry.animation) return
  const d = entry.animation.duration || 0
  if (d <= 0) return
  const cur = (entry.trackTime % d + d) % d
  $('seek').value = String(cur / d)
}

/* ------------------------------------------------------------------ 动画 */

function currentEntry() {
  return S.player?.animationState?.getCurrent(0) || null
}

function currentAnimation() {
  const e = currentEntry()
  return e?.animation || null
}

function playAnimation(name) {
  const p = S.player
  if (!p || !p.animationState) return
  p.animationState.setAnimation(0, name, S.loop)
  const entry = currentEntry()
  if (entry) entry.trackTime = 0
  p.speed = S.speed
  // 不同动画的内容位置常常差很远（cutscene 骨架尤其明显），按需重新取景。
  // 传 true：重新取景但保留用户当前的放大程度，切动画不会被打回原始大小。
  if (S.autoRefit) refitBounds(true)
  renderAnimList()
  if (S.playing) p.play(); else p.pause()
}

/**
 * 按当前动画重新测量内容范围，并同步给播放器的 viewport。
 * keepUserZoom = true 时保留用户当前的放大程度（同一个文件里换动画用这个）。
 */
function refitBounds(keepUserZoom) {
  const p = S.player
  if (!p || !p.skeleton) return
  const ratio = keepUserZoom ? currentZoomRatio() : 1
  const cam = S.camera
  // 用户已经自己缩放或拖过视角：切动画时别把镜头拽回新动画的中心
  const adjusted = keepUserZoom && cam && S.defaultPos && (
    Math.abs(ratio - 1) > 0.01
    || Math.abs(cam.position.x - S.defaultPos.x) > 1
    || Math.abs(cam.position.y - S.defaultPos.y) > 1)
  const b = computeStageBounds()      // 有背层时是两层并集（R19）
  if (!b) return
  S.bounds = b
  p.config.viewport = {
    x: b.offset.x, y: b.offset.y,
    width: Math.max(b.size.x, 1), height: Math.max(b.size.y, 1),
    padLeft: 0, padRight: 0, padTop: 50, padBottom: 50,
    transitionTime: 0, animations: {},
  }
  fitToWindow(ratio, !!adjusted)
}

function setPlaying(on) {
  S.playing = on
  const p = S.player
  if (!p) return
  if (on) p.play(); else p.pause()
  updatePlayButton()
}

function updatePlayButton() {
  $('btnPlay').textContent = t(S.playing ? '暂停' : '播放')
  const m = $('mPlay')
  if (m) m.textContent = t(S.playing ? '暂停' : '播放')
}

function stepFrame(dir) {
  const p = S.player
  const entry = currentEntry()
  if (!p || !entry || !p.skeleton) return
  p.pause()
  S.playing = false
  updatePlayButton()
  const fps = S.fps || 60
  entry.trackTime = Math.max(0, (entry.trackTime || 0) + dir / fps)
  p.animationState.apply(p.skeleton)
  skeletonUpdateWorld(p.skeleton)
  p.drawFrame(false)
  updateProgressReadout()
}

function renderAnimList() {
  const box = $('animList')
  const q = $('animFilter').value.trim().toLowerCase()
  const cur = currentAnimation()?.name
  box.innerHTML = ''
  for (const name of S.animations) {
    if (q && !name.toLowerCase().includes(q)) continue
    const el = document.createElement('div')
    el.className = 'list-item' + (name === cur ? ' active' : '')
    el.textContent = name
    el.onclick = () => playAnimation(name)
    box.appendChild(el)
  }
  if (!S.animations.length) {
    const el = document.createElement('div')
    el.className = 'list-item'
    el.style.color = '#6b7280'
    el.textContent = t('（暂无动画）')
    box.appendChild(el)
  }
  if (fsMode) updateFsLabels()
}

/* ------------------------------------------------- 皮肤
   Lost Sword 一类骨架的「default」皮肤常常只有零头：身体部件放在具名皮肤里
   （实测 Elin：81 个槽位里 default 只带 11 个，"1" 带 33 个 —— 所以选 default
   就只显示一小块）。两件事必须做：
   ①初始皮肤挑「覆盖最多」的那个，而不是照书选第一个（default）；
   ②切到具名皮肤时把 default 垫在下面合成（default 皮肤放的是各套共用的部件）。

   ⚠️ 覆盖量**既不能数皮肤声明的槽位数、也不能数 attachments 的条目数**，
   唯一可信的口径是「摆好姿势后真正有附件的槽位数」（2026-10-02 实测 Ark H092 费南雪）：
     default：声明 45 槽 / attachments 45 条 → 实际出图 42 个附件（只有头+头发+表情+武器）
     LV1   ：声明 39 槽 / attachments 39 条 → 实际出图 81 个附件（全身衣服都在这里）
   两套计数法在这里都会选中残的那个，症状是「立绘和动画都只有一个头」。
   原因：槽位在 setup pose 下会按 attachmentName 链解析到别的附件，
   所以「皮肤里写了几条」和「画面上出了几个」根本不是一回事。 */

/** 皮肤自己声明的槽位数 / attachments 条目数。只用于平手时打破平局，**不代表出图量**。 */
function skinSlotCount(skin) {
  const a = skin && skin.attachments
  if (!a) return 0
  if (typeof a.size === 'number' && typeof a.forEach === 'function') return a.size // Map 形态
  return Object.keys(a).length
}

/** 摆好姿势后，某个皮肤真正能显示的槽位数。maxBones 用于给 probe 骨架一个上界。 */
function visibleSlotsForSkin(rt, data, skin, maxBones) {
  let sk
  try {
    sk = new rt.Skeleton(data)
    sk.setSlotsToSetupPose()
    sk.setSkin(skin)
    // 槽位名 → 骨骼的解析要在骨骼矩阵就绪后才是稳定的
    sk.updateWorldTransform(0 /* x */, 0 /* y */, 0 /* a */)
    sk.setToSetupPose()
  } catch (err) {
    return 0
  }
  let n = 0
  for (const slot of sk.slots) {
    if (slot.getAttachment()) n++
  }
  void maxBones
  return n
}

/**
 * 初始皮肤 = 「摆好姿势后可见附件最多」的那个。
 * 需要运行时（要建一个临时 Skeleton 来试），所以拿不到 rt 就退回静态计数。
 * 平手时偏向声明槽位多的，再平手取靠前者，保证结果确定（不随 Map 顺序漂）。
 */
function fullestSkin(data, rt) {
  const list = data.skins || []
  if (!list.length) return null
  if (!rt || !rt.Skeleton) {
    // 退化路径：只能数条目数
    let best = null, bestN = -1
    for (const s of list) {
      const n = skinSlotCount(s)
      if (n > bestN) { bestN = n; best = s }
    }
    return best
  }
  let best = null
  let bestV = -1
  let bestS = -1
  for (const s of list) {
    const v = visibleSlotsForSkin(rt, data, s, data.bones ? data.bones.length : 0)
    const sl = skinSlotCount(s)
    if (v > bestV || (v === bestV && sl > bestS)) { bestV = v; bestS = sl; best = s }
  }
  return best
}

/** default 垫底 + 具名皮肤的合成皮。选的就是 default（或没有 default / 找不到）时返回 null。 */
function composeSkin(rt, data, name) {
  const def = data.defaultSkin
  if (!def || !name || name === def.name) return null
  const chosen = (data.skins || []).find(s => s.name === name)
  if (!chosen || chosen === def) return null
  const s = new rt.Skin(def.name + '+' + name)
  s.addSkin(def)
  s.addSkin(chosen)
  return s
}

/* ------------------------------------------------- 姿势（NIKKE 的 aim / cover）
   分组条目才有这一节（见 R18）：members 里有几个成员就摆几个按钮。
   可见性随**数据**变（有没有变体），所以这里用 JS 摘 hidden，不走 CSS（R1）。 */

const POSE_LABEL = { normal: '普通', aim: '瞄准', cover: '掩体' }

function renderPoseBar() {
  const bar = $('poseBar')
  const group = $('poseGroup')
  if (!bar || !group) return
  const members = Array.isArray(S.current?.members) ? S.current.members : null
  const show = !!(members && members.length > 1)
  group.hidden = !show
  bar.innerHTML = ''
  if (!show) return
  const cur = S.currentPose || defaultPoseOf(S.current)
  for (const m of members) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'gm-btn'
    b.dataset.pose = m.pose
    b.setAttribute('aria-pressed', String(m.pose === cur))
    // Ark 的成员带 formLabel（本体 / 战斗形态 / CG a…）—— 用它，别把 bundle 名甩给用户。
    // Ark 的形态视觉完全不同（CG 骨骼 vs 战斗骨骼），名字必须能区分开。
    const raw = (m.form && m.form.formLabel) || POSE_LABEL[m.pose] || m.pose
    b.textContent = t(raw)
    b.title = m.form ? `${m.form.formBundle}（${m.form.animationCount == null ? '?' : m.form.animationCount} 个动画）` : ''
    b.onclick = () => switchPose(m.pose)
    bar.appendChild(b)
  }
}

function renderSkinSelect() {
  const sel = $('skinSelect')
  sel.innerHTML = ''
  for (const name of S.skins) {
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = name
    sel.appendChild(opt)
  }
  sel.disabled = S.skins.length <= 1
}

/** opts.redraw = false 时不主动画帧 —— onLoaded（播放器载入上下文）里调 drawFrame
 *  会弄坏它自己的渲染循环（实测：aim 骨架「Unable to render skeleton」，而它恰好是
 *  唯一多皮肤的）。载入路径只设皮肤，让播放器自己的循环去画。 */
function applySkin(name, opts) {
  const p = S.player
  if (!p || !p.skeleton) return
  const redraw = !(opts && opts.redraw === false)
  const rt = p.__spineRt || activeSpine()
  try {
    const composed = composeSkin(rt, p.skeleton.data, name)
    if (composed) p.skeleton.setSkin(composed)
    else p.skeleton.setSkinByName(name)
    p.skeleton.setSlotsToSetupPose()
  } catch (err) {
    showError(t('切换皮肤失败：') + err.message)
    return
  }
  skeletonUpdateWorld(p.skeleton)
  S.hidden.clear()
  S.hiddenStack = []
  renderLayerList()
  if (redraw) p.drawFrame(false)
}

/* ------------------------------------------------------------------ 图层 */

function renderLayerList() {
  const box = $('layerList')
  const q = $('layerFilter').value.trim().toLowerCase()
  box.innerHTML = ''
  const names = [...S.slots].sort((a, b) => a.localeCompare(b))
  let n = 0
  for (const name of names) {
    if (q && !name.toLowerCase().includes(q)) continue
    n++
    const row = document.createElement('label')
    row.className = 'layer-row' +
      (S.hidden.has(name) ? ' hidden-layer' : '') +
      (S.selectedLayer === name ? ' selected' : '')
    row.innerHTML = `<input type="checkbox" ${S.hidden.has(name) ? '' : 'checked'}>` +
      `<span class="name"></span>`
    row.querySelector('.name').textContent = name
    row.querySelector('.name').title = name
    row.querySelector('input').onchange = e => {
      e.stopPropagation()
      setLayerHidden(name, !e.target.checked)
    }
    row.onclick = e => {
      if (e.target.tagName === 'INPUT') return
      S.selectedLayer = S.selectedLayer === name ? null : name
      updateLayerToast()
      renderLayerList()
    }
    box.appendChild(row)
  }
  if (!n) {
    const el = document.createElement('div')
    el.className = 'layer-row'
    el.style.color = '#6b7280'
    el.textContent = t(S.slots.length ? '没有匹配的图层' : '（暂无图层）')
    box.appendChild(el)
  }
}

function setLayerHidden(name, hidden) {
  if (hidden) {
    S.hidden.add(name)
    if (!S.hiddenStack.includes(name)) S.hiddenStack.push(name)
  } else {
    S.hidden.delete(name)
    S.hiddenStack = S.hiddenStack.filter(x => x !== name)
    restoreLayerAlpha(name)
  }
  if (S.selectedLayer === name && hidden) {
    // 保持选中，方便 U 恢复
  }
  updateLayerToast()
  renderLayerList()
  S.player?.drawFrame(false)
}

function updateLayerToast() {
  // 局部变量叫 el 而不是 t —— 全局 t() 是翻译函数，同名会把这个元素当函数调（真的崩过）。
  const el = $('layerToast')
  if (!S.selectedLayer) { el.hidden = true; return }
  el.hidden = false
  el.innerHTML = t('已选图层：<b></b>')
  el.querySelector('b').textContent = S.selectedLayer
}

/* ------------------------------------------------------------------ 点选图层 */

function isPointInPolygon(px, py, v) {
  let inside = false
  for (let i = 0, j = v.length - 2; i < v.length; j = i, i += 2) {
    const xi = v[i], yi = v[i + 1], xj = v[j], yj = v[j + 1]
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

function screenToWorld(clientX, clientY) {
  const p = S.player
  const cam = S.camera
  const rect = $('stageInner').getBoundingClientRect()
  if (!p || !cam || !rect.width || !rect.height) return null
  const dpr = window.devicePixelRatio || 1
  const canvas = p.canvas
  const cw = canvas.clientWidth || rect.width
  const ch = canvas.clientHeight || rect.height
  const sx = (clientX - rect.left) * (cw / rect.width)
  const sy = (clientY - rect.top) * (ch / rect.height)
  const nx = (sx / cw) * 2 - 1
  const ny = 1 - (sy / ch) * 2
  // 可见世界宽 = zoom * viewportWidth
  const vw = cam.viewportWidth, vh = cam.viewportHeight
  return {
    x: cam.position.x + nx * (cam.zoom * vw) / 2,
    y: cam.position.y + ny * (cam.zoom * vh) / 2,
    // 归一化屏幕坐标（-1..1，中心为 0）：双击定点放大要用它反推相机位置
    nx,
    ny,
    dpr,
  }
}

function pickLayerAt(clientX, clientY) {
  const p = S.player
  const pt = screenToWorld(clientX, clientY)
  if (!p || !pt || !p.skeleton) return null
  const slots = p.skeleton.drawOrder
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i]
    const name = slot.data && slot.data.name
    if (!name || S.hidden.has(name)) continue
    const att = slot.getAttachment && slot.getAttachment()
    if (!att || typeof att.computeWorldVertices !== 'function') continue
    const n = att.worldVerticesLength || 0
    if (!n) continue
    const verts = new Float32Array(n)
    try { att.computeWorldVertices(slot, 0, n, verts, 0, 2) } catch { continue }
    if (isPointInPolygon(pt.x, pt.y, verts)) return name
  }
  return null
}

function drawOverlay() {
  const canvas = $('overlayCanvas')
  const host = $('stageInner')
  const p = S.player
  if (!canvas || !p) return
  const rect = host.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(rect.width * dpr))
  const h = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (!S.selectedLayer || !S.layerSelect || !p.skeleton) return

  const slot = p.skeleton.slots.find(s => s.data && s.data.name === S.selectedLayer)
  if (!slot || S.hidden.has(S.selectedLayer)) return
  const att = slot.getAttachment && slot.getAttachment()
  if (!att || typeof att.computeWorldVertices !== 'function') return
  const n = att.worldVerticesLength || 0
  if (!n) return
  const verts = new Float32Array(n)
  try { att.computeWorldVertices(slot, 0, n, verts, 0, 2) } catch { return }

  const cam = S.camera
  const canvasEl = p.canvas
  const cw = canvasEl.clientWidth || rect.width
  const ch = canvasEl.clientHeight || rect.height
  const kx = rect.width / cw, ky = rect.height / ch

  ctx.beginPath()
  for (let i = 0; i < verts.length; i += 2) {
    const wx = verts[i], wy = verts[i + 1]
    const nx = ((wx - cam.position.x) / cam.zoom) / (cam.viewportWidth / 2)
    const ny = ((wy - cam.position.y) / cam.zoom) / (cam.viewportHeight / 2)
    const sx = ((nx + 1) / 2 * cw) * kx * dpr
    const sy = ((1 - (ny + 1) / 2) * ch) * ky * dpr
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy)
  }
  ctx.closePath()
  ctx.strokeStyle = '#a5b4fc'
  ctx.lineWidth = 2 * dpr
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.fillStyle = 'rgba(99,102,241,0.35)'
  ctx.fill()
}

/* ------------------------------------------------------------------ 相机 */

/**
 * 用户当前的放大程度 = cam.zoom / 「刚好铺满视口」的 zoom。
 * 记这个比例而不是绝对值：换动画后取景框大小会变，按同一个比例换算，
 * 用户看到的画面占比就不变 —— 也就不会「一切换动画就被打回原始大小」。
 *
 * 注意：不要把比值夹在 [0.08, 4]（对应最多 12.5×）。CameraController 的
 * 双指捏合没有上限；夹取会让「捏到 >12.5× 再切动画」被 refitBounds 打回 12.5×。
 * 这里只做数值合法性检查（非正 / 非有限 → 当作 1）。
 */
function currentZoomRatio() {
  const cam = S.camera
  if (!cam || !S.bounds) return 1
  const fit = defaultZoomFor(Math.max(cam.viewportWidth, 1), Math.max(cam.viewportHeight, 1))
  if (!(fit > 0) || !Number.isFinite(cam.zoom) || !(cam.zoom > 0)) return 1
  return cam.zoom / fit
}

function fitToWindow(zoomRatio = 1, keepPos = false) {
  const p = S.player
  const cam = S.camera
  if (!p || !cam || !S.bounds) return
  // 关键：success 回调触发时 canvas 像素尺寸可能还是默认的 300x150，
  // 必须先让 renderer 按显示尺寸重设 canvas，再拿真实像素尺寸算 zoom。
  p.sceneRenderer.resize(1)
  const canvas = p.canvas
  const rcam = p.sceneRenderer.camera
  cam.viewportWidth = rcam.viewportWidth
  cam.viewportHeight = rcam.viewportHeight

  const { offset, size } = S.bounds
  const vw = Math.max(rcam.viewportWidth, 1)
  const vh = Math.max(rcam.viewportHeight, 1)
  const fit = defaultZoomFor(vw, vh)
  // 用户自己缩放/拖动过视角后，切动画只重换算力，不把镜头拉回新动画的中心
  if (!keepPos) {
    cam.position.x = offset.x + size.x / 2
    cam.position.y = offset.y + size.y / 2
  }
  cam.zoom = fit * zoomRatio
  cam.update()
  S.defaultPos = { x: cam.position.x, y: cam.position.y }
  S.defaultZoom = fit
  debugDump()
  p.drawFrame(false)
}

/** 让取景框恰好铺满给定视口所需的 zoom（可见世界尺寸 = zoom × 视口） */
function defaultZoomFor(vw, vh) {
  const paddedW = Math.max(S.bounds?.size.x || 1, 1)
  const paddedH = Math.max((S.bounds?.size.y || 1) + 100, 1)
  return Math.max(paddedW / Math.max(vw, 1), paddedH / Math.max(vh, 1))
}

/** 把取景框 / 相机参数写到 DOM 上，便于排查（不影响显示） */
function debugDump() {
  const p = S.player
  if (!p || !S.bounds) return
  const canvas = p.canvas
  const cam = S.camera
  $('stageInner').dataset.debug = JSON.stringify({
    canvas: [canvas.width, canvas.height],
    client: [canvas.clientWidth, canvas.clientHeight],
    dpr: window.devicePixelRatio,
    boundsOffset: [+S.bounds.offset.x.toFixed(1), +S.bounds.offset.y.toFixed(1)],
    boundsSize: [+S.bounds.size.x.toFixed(1), +S.bounds.size.y.toFixed(1)],
    camPos: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1)],
    camZoom: +cam.zoom.toFixed(3),
    camViewport: [cam.viewportWidth, cam.viewportHeight],
    visibleWorld: [+(cam.zoom * cam.viewportWidth).toFixed(1), +(cam.zoom * cam.viewportHeight).toFixed(1)],
    anims: S.animations.length,
    slots: S.slots.length,
  })
}

function resetCamera() {
  const p = S.player, cam = S.camera
  if (!p || !cam) return
  cam.position.x = S.defaultPos.x
  cam.position.y = S.defaultPos.y
  cam.zoom = S.defaultZoom
  cam.update()
  p.drawFrame(false)
}

/** 按钮 +/- 的软夹取：比旧的 12.5× 宽很多，与捏合可越过 12.5× 的行为对齐。
 *  仅防极端值；真正「保留用户缩放」的路径（切动画 / 转屏）不走这里。 */
const ZOOM_BTN_RATIO_MIN = 0.02   // ≈50× 放大
const ZOOM_BTN_RATIO_MAX = 8      // ≈0.125× 缩小

function setZoom(z) {
  const p = S.player, cam = S.camera
  if (!p || !cam) return
  const min = S.defaultZoom * ZOOM_BTN_RATIO_MIN
  const max = S.defaultZoom * ZOOM_BTN_RATIO_MAX
  cam.zoom = clamp(z, min, max)
  cam.update()
  p.drawFrame(false)
}

/**
 * 舞台尺寸变了（进/出全屏、转屏、窗口缩放）：按新视口重设 canvas，
 * 并把 zoom 换算成「同一个比例」，让画面占比保持不变 —— 否则一进全屏
 * 视野就被放大一截，人物反而变小/变大。
 */
function onStageResize() {
  layoutBgImage()
  const p = S.player
  const cam = S.camera
  if (!p || !cam) { if (p && !S.busy) p.drawFrame(false); return }
  const ratio = currentZoomRatio()          // 必须用旧视口算，读完再改 viewport
  try { p.sceneRenderer.resize(1) } catch { /* ignore */ }
  const rc = p.sceneRenderer.camera
  const changed = cam.viewportWidth !== rc.viewportWidth || cam.viewportHeight !== rc.viewportHeight
  cam.viewportWidth = rc.viewportWidth
  cam.viewportHeight = rc.viewportHeight
  if (changed && S.bounds) {
    // 只换 zoom，位置不动 —— 用户当前盯着的那一点继续停在屏幕中心。
    // 不要夹回 [0.08, 4]：否则捏合超过 12.5× 后一转屏/一进全屏就被打回去。
    const fit = defaultZoomFor(Math.max(rc.viewportWidth, 1), Math.max(rc.viewportHeight, 1))
    if (fit > 0 && Number.isFinite(ratio) && ratio > 0) cam.zoom = fit * ratio
    S.defaultZoom = fit
  }
  cam.update()
  if (!S.busy) p.drawFrame(false)
  debugDump()
}

/* ------------------------------------------------------------------ 背景 */

function applyBgAlpha(alwaysTransparentCanvas = true) {
  const p = S.player
  if (!p) return
  // canvas 始终透明，视觉背景由 DOM 层负责（与原站一致）
  p.config.backgroundColor = '00000000'
  try { p.bg.setFromString('00000000') } catch { /* ignore */ }
  p.dom.style.backgroundColor = 'transparent'
  if (p.canvas) p.canvas.style.backgroundColor = 'transparent'
  $('bgLayer').style.background = S.bgColor
  layoutBgImage()
}

function layoutBgImage() {
  const img = $('bgImage')
  const host = $('bgLayer')
  if (!S.bgImageUrl) { img.hidden = true; img.removeAttribute('src'); return }
  if (img.getAttribute('src') !== S.bgImageUrl) img.src = S.bgImageUrl
  img.hidden = false
  const apply = () => {
    const rect = host.getBoundingClientRect()
    const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1
    if (!rect.width || !rect.height) return
    const s = Math.min(rect.width / nw, rect.height / nh)
    const w = nw * s, h = nh * s
    img.style.position = 'absolute'
    img.style.left = `${(rect.width - w) / 2}px`
    img.style.top = `${(rect.height - h) / 2}px`
    img.style.width = `${w}px`
    img.style.height = `${h}px`
    img.style.objectFit = 'fill'
  }
  if (img.complete) apply()
  else img.onload = apply
}

/* ------------------------------------------------------------------ 导出辅助 */

function animDuration() {
  const a = currentAnimation()
  return a && a.duration > 0 ? a.duration : 3
}

function setCanvasSizeForCapture(targetW, targetH) {
  const p = S.player
  const canvas = p.canvas
  const dpr = window.devicePixelRatio || 1
  const state = {
    w: canvas.width, h: canvas.height,
    sw: canvas.style.width, sh: canvas.style.height,
    pos: { x: S.camera.position.x, y: S.camera.position.y },
    zoom: S.camera.zoom,
  }
  canvas.style.width = `${targetW / dpr}px`
  canvas.style.height = `${targetH / dpr}px`
  p.sceneRenderer.resize(1)          // 重设 canvas 像素尺寸 + gl.viewport + 相机 viewport
  state.realW = canvas.width
  state.realH = canvas.height
  // 背层（Lost Sword 两层角色，R19）也用同一分辨率重画一次，免得导出时被拉伸
  const bp = S.backPlayer
  if (bp && bp.canvas) {
    state.back = { sw: bp.canvas.style.width, sh: bp.canvas.style.height }
    bp.canvas.style.width = `${targetW / dpr}px`
    bp.canvas.style.height = `${targetH / dpr}px`
    bp.sceneRenderer.resize(1)
  }
  // 同步我自己的相机视口
  S.camera.viewportWidth = p.sceneRenderer.camera.viewportWidth
  S.camera.viewportHeight = p.sceneRenderer.camera.viewportHeight
  return state
}

function restoreCanvasSize(state) {
  const p = S.player
  const canvas = p.canvas
  canvas.style.width = state.sw
  canvas.style.height = state.sh
  p.sceneRenderer.resize(1)
  if (state.back && S.backPlayer) {
    S.backPlayer.canvas.style.width = state.back.sw
    S.backPlayer.canvas.style.height = state.back.sh
    S.backPlayer.sceneRenderer.resize(1)
  }
  S.camera.position.x = state.pos.x
  S.camera.position.y = state.pos.y
  S.camera.zoom = state.zoom
  S.camera.update()
  p.drawFrame(false)
  drawBackLayer()
}

/** 把背层的画面画到它自己的 canvas 上（背层被 pause，时间轴由本体驱动）。 */
function drawBackLayer() {
  const bp = S.backPlayer
  if (!bp || !bp.skeleton) return
  try { bp.drawFrame(false) } catch { /* 背层失败不该影响本体 */ }
}

/** 为指定分辨率设置取景：keepCurrent 时保持当前可见世界范围，否则回到默认取景 */
function frameForCapture(realW, realH, keepCurrent, prevW, prevH) {
  const cam = S.camera
  if (keepCurrent) {
    // 视口变大 k 倍 → zoom 也要乘 k，可见世界范围才不变
    const k = Math.max(realW / Math.max(prevW, 1), realH / Math.max(prevH, 1))
    cam.zoom = cam.zoom * k
  } else {
    cam.position.x = S.defaultPos.x
    cam.position.y = S.defaultPos.y
    cam.zoom = defaultZoomFor(realW, realH)
  }
  cam.update()
}

/* 把「背景色 + 背景图 + 模型画布」画进目标 2D 上下文。
 * 页面上的背景是 CSS 层（透视在 WebGL 画布下面），所以任何离屏产出都必须自己合成，
 * 否则导出的图/视频里背景会是黑的。 */
function paintBgAndSource(ctx, source, transparent, targetW, targetH) {
  ctx.clearRect(0, 0, targetW, targetH)
  if (!transparent) {
    ctx.fillStyle = S.bgColor
    ctx.fillRect(0, 0, targetW, targetH)
    const img = $('bgImage')
    if (S.bgImageUrl && img && img.naturalWidth) {
      const host = $('bgLayer').getBoundingClientRect()
      const stage = $('stageInner').getBoundingClientRect()
      const kx = targetW / stage.width, ky = targetH / stage.height
      const x = (host.left - stage.left) * kx +
        (parseFloat(img.style.left) || 0) * kx
      const y = (host.top - stage.top) * ky +
        (parseFloat(img.style.top) || 0) * ky
      const w = (parseFloat(img.style.width) || 0) * kx
      const h = (parseFloat(img.style.height) || 0) * ky
      ctx.drawImage(img, x, y, w, h)
    }
  }
  ctx.drawImage(source, 0, 0, targetW, targetH)
  paintBackLayer(ctx, targetW, targetH)
}

/** Lost Sword 两层角色（R19）：背层画在背景之上、本体之下。
 *  离屏产出（截图 / 帧序列 / WebM）走的是同一条合成路径，所以两层都不会丢。 */
function backLayerCanvas() {
  const bp = S.backPlayer
  const cv = bp && bp.canvas
  return cv && cv.width ? cv : null
}

function paintBackLayer(ctx, targetW, targetH) {
  const cv = backLayerCanvas()
  if (!cv) return
  try { ctx.drawImage(cv, 0, 0, targetW, targetH) } catch { /* 尺寸不合法时跳过背层 */ }
}

function composeToCanvas(source, transparent, targetW, targetH) {
  if (transparent && !S.bgImageUrl && !S.backPlayer) return source
  const off = document.createElement('canvas')
  off.width = targetW
  off.height = targetH
  paintBgAndSource(off.getContext('2d'), source, transparent, targetW, targetH)
  return off
}

/* ------------------------------------------------------------------ 截图 */

async function screenshot(transparent, sizeOverride) {
  const p = S.player
  if (!p || !S.camera) { showError(t('还没有载入任何资产')); return }
  if (S.busy) return
  S.busy = true
  try {
    const gl = p.context.gl
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096
    const base = Math.min(sizeOverride || S.maxSize, maxTex)
    const prev = p.canvas
    const aspect = prev.height / (prev.width || 1)
    let targetW, targetH
    if (sizeOverride) {
      targetW = base
      targetH = Math.round(base * aspect) || base
    } else {
      targetW = targetH = base
    }
    const st = setCanvasSizeForCapture(targetW, targetH)
    frameForCapture(st.realW, st.realH, S.useCurrentCamera, st.w, st.h)
    p.drawFrame(false)
    const composed = composeToCanvas(p.canvas, transparent, st.realW, st.realH)
    const blob = await new Promise(r => composed.toBlob(r, 'image/png'))
    restoreCanvasSize(st)
    const name = `screenshot_${safeName(S.current?.folder)}_${safeName(currentAnimation()?.name)}${transparent ? '_alpha' : ''}.png`
    // 用 Blob 而非 dataURL：2K 截图的 base64 字符串会有好几 MB，白占内存。
    if (blob) download(blob, name)
    else download(composed.toDataURL('image/png'), name)
  } catch (err) {
    showError(t('截图失败：') + err.message)
  } finally {
    S.busy = false
  }
}

/* ------------------------------------------------------------------ 导出 WebM */

async function exportWebm(transparent) {
  const p = S.player
  if (!p || !S.camera) { showError(t('还没有载入任何资产')); return }
  const anim = currentAnimation()
  if (!anim) { showError(t('没有可导出的动画')); return }
  if (S.busy) return
  S.busy = true
  const note = $('exportNote')
  note.hidden = false
  note.textContent = t('正在录制 WebM…')

  const cam = S.camera
  const savedPos = { x: cam.position.x, y: cam.position.y }
  const savedZoom = cam.zoom
  const wasPlaying = S.playing
  let stream = null
  let rec = null

  try {
    // 录制期间暂停引擎自走，改由下面的循环逐帧喂，保证帧数与时长可控。
    setPlaying(false)
    if (!S.useCurrentCamera) {
      const rcam = p.sceneRenderer.camera
      cam.position.x = S.defaultPos.x
      cam.position.y = S.defaultPos.y
      cam.zoom = defaultZoomFor(rcam.viewportWidth, rcam.viewportHeight)
      cam.update()
    }

    const fps = Math.max(1, Math.min(60, Math.round(S.fps || 30)))
    const speed = S.speed || 1
    const total = Math.max(1, Math.round((anim.duration / speed) * fps))
    const frameMs = 1000 / fps

    // 录制源用离屏合成画布：把背景色/背景图烘进画面，
    // 否则 WebGL 画布本身是透明的，视频里背景会变成黑色。
    const out = document.createElement('canvas')
    out.width = Math.max(1, p.canvas.width)
    out.height = Math.max(1, p.canvas.height)
    const outCtx = out.getContext('2d')

    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t))

    // captureStream(0) = 手动帧模式：只有 requestFrame() 时才采一帧。
    // 自动帧模式依赖 rAF，标签页被节流（后台 / 无头 / 最小化）时会一帧都采不到，
    // 表现为「同一份代码有时 1.6MB、有时 0 字节」。
    stream = out.captureStream(0)
    let track = stream.getVideoTracks()[0]
    const manual = !!track && typeof track.requestFrame === 'function'
    if (!manual) {
      stream.getTracks().forEach(t => t.stop())
      stream = out.captureStream(fps)
      track = stream.getVideoTracks()[0]
    }

    const opts = { videoBitsPerSecond: 12_000_000 }
    if (mime) opts.mimeType = mime
    rec = new MediaRecorder(stream, opts)
    const chunks = []
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }

    const done = new Promise((resolve, reject) => {
      rec.onstop = resolve
      rec.onerror = e => reject(e.error || new Error(t('录制失败')))
    })

    p.animationState.setAnimation(0, anim.name, false)
    const entry = p.animationState.getCurrent(0)

    // 先画好第 0 帧再开录，避免首帧空白
    if (entry) { entry.trackTime = 0; entry.animationLast = -1; entry.nextAnimationLast = -1 }
    p.animationState.apply(p.skeleton)
    skeletonUpdateWorld(p.skeleton)
    p.drawFrame(false)
    paintBgAndSource(outCtx, p.canvas, transparent, out.width, out.height)

    rec.start(400)
    // MediaRecorder 的 start() 是异步进入 recording 的，过早推的帧会被丢掉；
    // 等状态真正就绪再推第一帧，否则偶发「录完 0 字节」。
    const ready = Date.now() + 600
    while (rec.state !== 'recording' && Date.now() < ready) {
      await new Promise(r => setTimeout(r, 10))
    }
    if (manual) track.requestFrame()
    await new Promise(r => setTimeout(r, frameMs))

    const t0 = performance.now()
    let dropped = 0
    for (let i = 0; i < total; i++) {
      if (cancelled) break
      // MediaRecorder 只能按真实时间编码，渲染慢于帧间隔时会拖长视频（慢动作）。
      // 落后超过一帧就跳过这一帧的渲染，让时长保持正确，代价是掉帧。
      const targetMs = i * frameMs
      if (performance.now() - t0 > targetMs + frameMs) { dropped++; continue }
      note.textContent = t('正在录制 WebM {i}/{total} …', { i: i + 1, total })
      // 同上：避开全局 t() 的名字
      const trackT = (i + 1) / fps
      if (entry) { entry.trackTime = trackT; entry.animationLast = -1; entry.nextAnimationLast = -1 }
      p.animationState.apply(p.skeleton)
      skeletonUpdateWorld(p.skeleton)
      p.drawFrame(false)
      paintBgAndSource(outCtx, p.canvas, transparent, out.width, out.height)
      if (manual) track.requestFrame()
      const wait = t0 + trackT * 1000 - performance.now()
      await new Promise(r => setTimeout(r, wait > 2 ? wait : 0))
    }
    // 多撑两帧，让编码器把最后一张收进去
    await new Promise(r => setTimeout(r, frameMs * 2 + 60))
    if (rec.state === 'recording') rec.stop()
    await done

    if (!cancelled) {
      const type = rec.mimeType || mime || 'video/webm'
      const blob = new Blob(chunks, { type })
      S.lastWebm = { frames: total, dropped, fps, bytes: blob.size, chunks: chunks.length }
      if (!blob.size) {
        showError(t('录制结果为空：当前浏览器没能从画布采到帧'))
      } else {
        if (dropped > total * 0.15) {
          note.hidden = false
          note.textContent = t('提示：渲染跟不上 {fps} fps，已跳过 {dropped}/{total} 帧（建议把帧率调低或改用帧序列导出）', { fps, dropped, total })
          await new Promise(r => setTimeout(r, 3500))
        }
        download(blob, `animation_${safeName(S.current?.folder)}_${safeName(anim.name)}.webm`)
      }
    }
  } catch (err) {
    showError(t('导出失败：') + err.message)
  } finally {
    try { if (rec && rec.state !== 'inactive') rec.stop() } catch { /* ignore */ }
    stream?.getTracks().forEach(t => t.stop())
    if (S.animations.length) playAnimation(currentAnimation()?.name || S.animations[0])
    cam.position.x = savedPos.x
    cam.position.y = savedPos.y
    cam.zoom = savedZoom
    cam.update()
    setPlaying(wasPlaying)
    S.busy = false
    note.hidden = true
  }
}

/* ------------------------------------------------------------------ 导出帧序列 */

async function exportFrames(transparent) {
  const p = S.player
  if (!p || !S.camera) { showError(t('还没有载入任何资产')); return }
  const anim = currentAnimation()
  if (!anim) { showError(t('没有可导出的动画')); return }
  if (S.busy) return
  S.busy = true
  const note = $('exportNote')
  note.hidden = false

  const cam = S.camera
  const savedPos = { x: cam.position.x, y: cam.position.y }
  const savedZoom = cam.zoom
  const wasPlaying = S.playing

  try {
    setPlaying(false)
    if (!S.useCurrentCamera) {
      const rcam = p.sceneRenderer.camera
      cam.position.x = S.defaultPos.x
      cam.position.y = S.defaultPos.y
      cam.zoom = defaultZoomFor(rcam.viewportWidth, rcam.viewportHeight)
      cam.update()
    }
    const fps = S.fps
    const total = Math.max(1, Math.round(anim.duration * fps))
    const zip = new JSZip()
    const folder = zip.folder(safeName(anim.name)) || zip
    p.animationState.setAnimation(0, anim.name, false)
    const entry = p.animationState.getCurrent(0)

    for (let i = 0; i < total; i++) {
      note.textContent = t('正在导出帧 {i}/{total} …', { i: i + 1, total })
      // 局部变量叫 trackT 而不是 t —— 全局 t() 是翻译函数，
      // 同名会在本块形成 TDZ，把上面的 note.textContent = t(...) 打炸。
      const trackT = i / fps
      if (entry) {
        entry.trackTime = trackT
        entry.animationLast = -1
        entry.nextAnimationLast = -1
      }
      p.animationState.apply(p.skeleton)
      skeletonUpdateWorld(p.skeleton)
      p.drawFrame(false)
      const composed = composeToCanvas(p.canvas, transparent, p.canvas.width, p.canvas.height)
      const blob = await new Promise(r => composed.toBlob(r, 'image/png'))
      folder.file(`frame_${String(i).padStart(4, '0')}.png`, blob)
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 0))
    }

    note.textContent = t('正在打包 ZIP…')
    const out = await zip.generateAsync({ type: 'blob' })
    download(out, `frames_${safeName(S.current?.folder)}_${safeName(anim.name)}.zip`)
  } catch (err) {
    showError(t('导出帧序列失败：') + err.message)
  } finally {
    cam.position.x = savedPos.x
    cam.position.y = savedPos.y
    cam.zoom = savedZoom
    cam.update()
    if (S.animations.length) playAnimation(currentAnimation()?.name || S.animations[0])
    setPlaying(wasPlaying)
    S.busy = false
    note.hidden = true
  }
}

/* ------------------------------------------------------------------ 上传 */

const uploaded = { files: [] }

/**
 * 认一个上传文件扮演什么角色。两套命名约定都要认 —— 语义与
 * server.mjs 的 FORMATS / 安卓 ScanEngine 的 classify() 保持一致，改一边要改三边：
 *   · bd        —— x.atlas / x.json / x.skel
 *   · lostsword —— x.atlas.bytes（文本图集）/ x.skel.bytes（二进制骨架）/ x.bytes（JSON 骨架）
 * 判断顺序要紧：`.atlas.bytes` 必须先于 `.bytes`，否则它会被当成骨架，基名也算错。
 */
function fileRole(name) {
  const l = String(name || '').toLowerCase()
  if (l.endsWith('.atlas.bytes')) return 'atlas'
  if (l.endsWith('.skel.bytes')) return 'skel'
  if (l.endsWith('.atlas')) return 'atlas'
  if (l.endsWith('.skel')) return 'skel'
  if (l.endsWith('.json')) return 'json'
  if (l.endsWith('.bytes')) return 'json'
  if (/\.(png|jpe?g|webp)$/.test(l)) return 'image'
  return null
}

async function blobUrlsFromFiles(files, name) {
  const atlas = files.find(f => fileRole(f.name) === 'atlas')
  const json = files.find(f => fileRole(f.name) === 'json')
  const skel = files.find(f => fileRole(f.name) === 'skel')
  const textures = files.filter(f => fileRole(f.name) === 'image')
  if (!atlas) throw new Error(t('缺少 .atlas / .atlas.bytes 图集文件'))
  if (!json && !skel) throw new Error(t('缺少骨架文件（.json / .skel / .bytes）'))
  if (!textures.length) throw new Error(t('缺少贴图 .png'))

  const atlasText = await await_text(atlas)
  const referenced = [...atlasText.matchAll(/([^\s]+\.(?:png|jpe?g|webp))/gi)].map(m => m[1])
  const base = files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/').slice(0, -1).join('/') : ''
  const missing = referenced.filter(r => {
    const bn = r.split('/').pop()
    return !textures.some(t => t.name === bn)
  })
  if (missing.length) throw new Error(t('atlas 引用了但没提供这些图：') + missing.join(', '))

  const atlasUrl = URL.createObjectURL(atlas)
  const rawDataURIs = {}
  const baseUrl = new URL(atlasUrl)
  const dir = baseUrl.href.slice(0, baseUrl.href.lastIndexOf('/') + 1)
  for (const t of textures) {
    const u = URL.createObjectURL(t)
    rawDataURIs[dir + t.name] = u
    rawDataURIs[t.name] = u
    if (base) rawDataURIs[`${base}/${t.name}`] = u
  }
  return {
    atlasUrl,
    jsonUrl: json ? URL.createObjectURL(json) : null,
    skeletonUrl: skel ? URL.createObjectURL(skel) : null,
    skeletonKind: json ? 'json' : 'skel',
    rawDataURIs,
  }
}

/** FileReader 同步版（内部 await，命名避免误用） */
function await_text(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error(t('无法读取 atlas')))
    fr.readAsText(file)
  })
}

async function doUpload() {
  const msg = $('uploadMsg')
  msg.textContent = ''
  try {
    const urls = await blobUrlsFromFiles(uploaded.files, $('uploadName').value)
    const label = $('uploadName').value.trim() || uploaded.files[0].name.replace(/\.[^.]+$/, '')
    const item = {
      key: 'custom-' + Date.now(),
      folder: label,
      group: t('已上传（本次会话）'),
      base: uploaded.files.find(f => fileRole(f.name) === 'atlas').name,
      images: uploaded.files.filter(f => fileRole(f.name) === 'image'),
      skeletonKind: urls.skeletonKind,
      blobUrls: urls,
      ok: true,
      problems: [],
      relAtlas: null,
      relSkeleton: null,
      relThumb: null,
    }
    S.customItems.unshift(item)
    $('uploadModal').hidden = true
    uploaded.files = []
    // 不能直接给 #dropText 赋 textContent —— 它里面是两个 span（主文案 + 「选择文件」链接），
    // 覆盖会连链接一起抹掉。走 applyLang() 按 data-i18n 还原结构。
    applyLang()
    selectItem(item)          // 它内部会 refreshLists()，这里不必再刷一遍
  } catch (err) {
    msg.textContent = '✕ ' + err.message
  }
}

/* ---------------------------------------------------------- 导入到 App 目录 */

/* APK 里替代「选择文件夹」：选中的文件直接写进 App 自己的目录，之后照常扫描 */
const IMPORT_MAX_BYTES = 12 * 1024 * 1024
/** JCZX 打包 AB 常见 20–40MB；Base64 过桥仍吃内存，超大请用文件管理器拷到 BD2Viewer/jczx/ */
const IMPORT_MAX_BYTES_JCZX = 48 * 1024 * 1024

async function onImportFiles(e) {
  const files = [...(e.target.files || [])]
  e.target.value = ''
  if (!files.length || !NATIVE) return

  const maxBytes = S.mode === 'jczx' ? IMPORT_MAX_BYTES_JCZX : IMPORT_MAX_BYTES
  setBusy(true, t('导入 0/{total} …', { total: files.length }))
  let ok = 0
  const failed = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    setBusy(true, t('导入 {i}/{total} · {name}', { i: i + 1, total: files.length, name: f.name }))
    try {
      if (f.size > maxBytes) {
        throw new Error(S.mode === 'jczx'
          ? t('超过 48MB（更大请拷到手机存储 /BD2Viewer/jczx/ 后点重新扫描）')
          : t('超过 12MB'))
      }
      const b64 = await fileToBase64(f)
      if (!window.BD2Native.importFile(f.name, b64)) throw new Error(t('写入失败'))
      ok++
    } catch (err) {
      failed.push(`${f.name}（${err.message}）`)
    }
  }
  setBusy(false)
  if (failed.length) showError(t('有 {n} 个文件没导入成功：{list}', { n: failed.length, list: failed.join('、') }))
  else if (ok) {
    try { window.BD2Native.toast(t('已导入 {n} 个文件', { n: ok })) } catch { /* ignore */ }
  }
  await scan(true)
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      const comma = s.indexOf(',')
      resolve(comma >= 0 ? s.slice(comma + 1) : '')
    }
    r.onerror = () => reject(new Error(t('读取失败')))
    r.readAsDataURL(file)
  })
}

/* ------------------------------------------------------------------ 界面绑定 */

function bindUI() {
  setupFullscreenUI()
  if (NATIVE) {
    // 不再让用户进系统文件夹选择器 —— 那玩意儿在部分机型上会把进程带崩。
    // 改成「导入文件」：选中的文件直接拷进 App 自己的目录。
    const b = $('btnAddRoot')
    b.textContent = t('导入文件')
    b.title = t('把手机里的 Spine 文件拷进 App 目录，不用数据线')
  }
  const imp = $('importFiles')
  if (imp) imp.onchange = onImportFiles
  // 顶栏
  $('rootSelect').onchange = e => {
    S.rootId = e.target.value
    S.current = null
    disposePlayer()
    $('emptyState').hidden = false
    $('currentName').textContent = t('未载入')
    $('currentSub').textContent = t('在右侧列表里选一个资产')
    syncRemoveRootBtn()
    scan(false)
  }
  $('btnRescan').onclick = () => scan(true)
  // 平铺页（桌面用顶栏按钮，手机用画面左上角 ⊞）
  const gridBtn = $('btnGrid')
  if (gridBtn) gridBtn.onclick = () => setView('grid')
  const galRebuild = $('galRebuild')
  if (galRebuild) galRebuild.onclick = () => rebuildThumbs()
  // 资产类型：BD2 / Lost Sword（全局单一切换，切完按新规则重扫）
  const galMode = $('galMode')
  if (galMode) {
    galMode.addEventListener('click', e => {
      const b = e.target.closest('.gm-btn')
      if (b && b.dataset.assetMode) setAssetMode(b.dataset.assetMode)
    })
  }
  // 播放顺序：手动 / 名称 / 日期 + 升降序
  const galSort = $('galSort')
  if (galSort) {
    galSort.addEventListener('click', e => {
      const b = e.target.closest('.gs-btn')
      if (b && b.dataset.mode) setSortMode(b.dataset.mode)
    })
  }
  const galSortDir = $('galSortDir')
  if (galSortDir) galSortDir.onclick = () => toggleSortDir()
  // 批量选择 + 删除
  const galSelect = $('galSelect')
  if (galSelect) galSelect.onclick = () => setSelectMode(!selectMode)
  const galSelDone = $('galSelDone')
  if (galSelDone) galSelDone.onclick = () => setSelectMode(false)
  const galSelAll = $('galSelAll')
  if (galSelAll) galSelAll.onchange = () => {
    const cards = document.querySelectorAll('#galGrid .card')
    if (galSelAll.checked) for (const c of cards) selectedKeys.add(c.dataset.key)
    else selectedKeys.clear()
    for (const c of cards) c.classList.toggle('sel', selectedKeys.has(c.dataset.key))
    applySelectUI()
  }
  const galSelDelete = $('galSelDelete')
  if (galSelDelete) galSelDelete.onclick = async () => {
    const items = selectedItems()
    if (!items.length) return
    if (!await confirmDelete(items)) return
    await runDelete(items)
  }
  const cardMenuDelete = $('cardMenuDelete')
  if (cardMenuDelete) cardMenuDelete.onclick = async () => {
    const it = menuItem
    $('cardMenu').hidden = true
    if (!it || !await confirmDelete([it])) return
    await runDelete([it])
  }
  const cardMenuSelect = $('cardMenuSelect')
  if (cardMenuSelect) cardMenuSelect.onclick = () => {
    const it = menuItem
    $('cardMenu').hidden = true
    setSelectMode(true)
    if (it) toggleSelectKey(itemKey(it))
  }
  // 复制路径：**故意不关菜单** —— 目录和文件两条常要连着复制，也让人能核对
  // 下面那行路径；菜单本身点蒙版 / ✕ 就能关。
  const copyFromMenu = async kind => {
    const p = absPathOf(menuItem, kind)
    if (!p) return
    const ok = await copyToClipboard(p)
    toast(ok ? t('路径已复制') : t('复制失败，可手动选中路径复制'))
  }
  const cardMenuCopyDir = $('cardMenuCopyDir')
  if (cardMenuCopyDir) cardMenuCopyDir.onclick = () => copyFromMenu('dir')
  const cardMenuCopyFile = $('cardMenuCopyFile')
  if (cardMenuCopyFile) cardMenuCopyFile.onclick = () => copyFromMenu('file')
  const cardMenuRebuildThumb = $('cardMenuRebuildThumb')
  if (cardMenuRebuildThumb) cardMenuRebuildThumb.onclick = () => {
    const it = menuItem
    $('cardMenu').hidden = true
    if (!it || it.pendingUnpack || it.imageOnly || !it.ok) {
      toast(t('这张没有可重建的缩略图'))
      return
    }
    rebuildThumbs(it)
  }
  // PC 播放页左上角的「返回列表」。触屏那套是 ⊞ 悬浮键（见 setupFullscreenUI），
  // 两边都只调 setView('grid') —— 层级判断仍然只有 handleBack() 一份。
  const stageBack = $('stageBack')
  if (stageBack) stageBack.onclick = () => setView('grid')
  applySortUI()
  applySelectUI()
    const btnRemoveRoot = $('btnRemoveRoot')
  if (btnRemoveRoot) btnRemoveRoot.onclick = () => runRemoveRoot()
  syncRemoveRootBtn()
  $('btnAddRoot').onclick = async () => {
    if (NATIVE) {
      // 不进系统文件夹选择器（部分机型上会把进程带崩），改拉起文件选择器拷进 App 目录
      $('importFiles').click()
      return
    }
    const p = prompt(t('输入要添加的本地目录绝对路径（例如 E:\\xxx\\mods）：'))
    if (!p) return
    try {
      const res = await fetch('/api/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || t('添加失败'))
      await loadConfig()
      S.rootId = data.root.id
      $('rootSelect').value = S.rootId
      syncRemoveRootBtn()
      await scan(true)
    } catch (err) {
      showError(t('添加目录失败：') + err.message)
    }
  }
  $('btnUpload').onclick = () => {
    $('uploadModal').hidden = false
    $('uploadMsg').textContent = ''
  }
  $('btnHelp').onclick = () => { $('helpModal').hidden = false }
  $('btnSettings').onclick = () => { $('settingsModal').hidden = false }
  // 错误提示点一下就关，别挡着下面的操作
  $('errorBox').onclick = clearError

  document.querySelectorAll('[data-close]').forEach(b => {
    b.onclick = () => { $(b.dataset.close).hidden = true }
  })
  document.querySelectorAll('.modal-mask').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.hidden = true })
  })

  // 左侧 tab
  document.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t))
      $('paneControls').classList.toggle('hidden', t.dataset.tab !== 'controls')
      $('paneLayers').classList.toggle('hidden', t.dataset.tab !== 'layers')
    }
  })

  // 动画
  $('animFilter').oninput = renderAnimList
  $('skinSelect').onchange = e => applySkin(e.target.value)

  // 播放
  $('btnPlay').onclick = () => setPlaying(!S.playing)
  $('btnStepBack').onclick = () => stepFrame(-1)
  $('btnStepFwd').onclick = () => stepFrame(1)
  $('chkLoop').onchange = e => {
    S.loop = e.target.checked
    const name = currentAnimation()?.name
    if (name) playAnimation(name)
  }
  $('speedRange').oninput = e => {
    S.speed = Number(e.target.value)
    $('speedVal').textContent = S.speed.toFixed(2) + 'x'
    if (S.player) S.player.speed = S.speed
  }

  // 视图
  $('btnZoomIn').onclick = () => setZoom(S.camera ? S.camera.zoom / 1.2 : 1)
  $('btnZoomOut').onclick = () => setZoom(S.camera ? S.camera.zoom * 1.2 : 1)
  $('btnResetCam').onclick = resetCamera
  $('btnFit').onclick = () => { refitBounds(); fitToWindow() }
  $('chkUseCam').onchange = e => { S.useCurrentCamera = e.target.checked }

  // 背景
  $('bgColor').oninput = e => { S.bgColor = e.target.value; $('setBgColor').value = S.bgColor; applyBgAlpha(true) }
  $('setBgColor').oninput = e => { S.bgColor = e.target.value; $('bgColor').value = S.bgColor; applyBgAlpha(true) }
  $('btnBgImage').onclick = () => $('bgFile').click()
  $('bgFile').onchange = e => {
    const f = e.target.files[0]
    if (!f) return
    const fr = new FileReader()
    fr.onload = () => { S.bgImageUrl = String(fr.result); applyBgAlpha(true) }
    fr.readAsDataURL(f)
  }
  $('btnBgClear').onclick = () => { S.bgImageUrl = null; applyBgAlpha(true) }

  // 截图 / 导出
  $('btnShot').onclick = () => screenshot($('chkTransparent').checked, null)
  $('btnShotBig').onclick = () => screenshot($('chkTransparent').checked, 2048)
  $('btnExportWebm').onclick = () => exportWebm($('chkTransparent').checked)
  $('btnExportFrames').onclick = () => exportFrames($('chkTransparent').checked)

  // 图层
  $('layerFilter').oninput = renderLayerList
  $('chkLayerSelect').onchange = e => {
    S.layerSelect = e.target.checked
    if (!S.layerSelect) { S.selectedLayer = null; updateLayerToast() }
    renderLayerList()
  }
  $('btnShowAll').onclick = () => {
    for (const n of [...S.hidden]) restoreLayerAlpha(n)
    S.hidden.clear(); S.hiddenStack = []
    renderLayerList(); S.player?.drawFrame(false)
  }
  $('btnHideAll').onclick = () => {
    for (const n of S.slots) setLayerHidden(n, true)
  }

  // 右侧
  // 过滤条件变了：走唯一入口 refreshLists()（它内部先 syncFilters() 把控件读进状态）。
  // 搜索框有两个入口 —— 播放页右侧抽屉一个、平铺页头部一个 —— 但事实来源仍然只有
  // filters.q 一个：任一个输入都先把值同步给另一个（syncFilters 只从 #assetFilter 读），
  // 再走 refreshLists()。清空同理。这样两个框永远显示同一个词，不会各搜各的。
  const SEARCH_INPUTS = ['assetFilter', 'galFilter']
  const onSearchInput = e => {
    const v = e.target.value
    for (const id of SEARCH_INPUTS) {
      const inp = $(id)
      if (inp && inp !== e.target && inp.value !== v) inp.value = v
    }
    refreshLists()
  }
  const clearSearch = focusId => {
    for (const id of SEARCH_INPUTS) { const i = $(id); if (i) i.value = '' }
    refreshLists()
    const f = $(focusId)
    if (f) f.focus()
  }
  $('assetFilter').oninput = onSearchInput
  $('galFilter').oninput = onSearchInput
  $('assetFilterClear').onclick = () => clearSearch('assetFilter')
  $('galFilterClear').onclick = () => clearSearch('galFilter')
  $('chkOnlyPlayable').onchange = refreshLists
  $('btnClearCustom').onclick = () => {
    if (!S.customItems.length) return
    S.customItems = []
    if (S.current?.key?.startsWith('custom-')) { S.current = null; disposePlayer(); $('emptyState').hidden = false }
    refreshLists()
  }

  // 设置
  $('chkPremultiplied').onchange = e => {
    S.premultiplied = e.target.checked
    syncPremultiplyGl()
    const cur = S.current
    if (cur) { S.current = null; selectItem(cur) }
  }
  $('chkAutoPlay').onchange = e => { S.autoPlay = e.target.checked }
  $('chkAutoRefit').onchange = e => { S.autoRefit = e.target.checked }
  $('chkAutoRefit').checked = S.autoRefit
  $('setVolumeDir').value = S.volDir
  $('setVolumeDir').onchange = e => {
    S.volDir = e.target.value === 'prev' ? 'prev' : 'next'
    try { localStorage.setItem('bd2.volDir', S.volDir) } catch { /* 无痕模式等 */ }
    updateVolumeKeyHints()
  }
  $('setMaxSize').onchange = e => { S.maxSize = clamp(Number(e.target.value) || 3000, 256, 8192) }
  $('setFps').onchange = e => { S.fps = clamp(Number(e.target.value) || 60, 1, 120) }
  const btnExportLog = $('btnExportLog')
  if (btnExportLog) btnExportLog.onclick = () => exportErrorLog()

  // 播放页左右箭头：切当前资产的**上一个 / 下一个动画**。
  // 与全屏底部 ◀▶、键盘 ↑↓/[ ]、真机音量键共用 switchAnimation() 这一个入口。
  // （切资产是底部那条 ◀◀/▶▶ 的活 —— 两处分工与常见布局相反，别按直觉改回来，
  //   显隐条件也跟着走的是「动画数」而不是「资产数」，见 syncStageNav()。）
  $('stagePrev').onclick = () => switchAnimation(-1)
  $('stageNext').onclick = () => switchAnimation(1)

  // 舞台点选
  const host = $('stageInner')
  let down = null
  host.addEventListener('pointerdown', e => {
    if (!S.layerSelect || e.button !== 0) return
    down = { x: e.clientX, y: e.clientY }
  })
  host.addEventListener('pointerup', e => {
    if (!S.layerSelect || !down) { down = null; return }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
    down = null
    if (moved > 5) return
    const name = pickLayerAt(e.clientX, e.clientY)
    S.selectedLayer = name
    updateLayerToast()
    renderLayerList()
    drawOverlay()
  })

  // 键盘
  window.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return
    const k = e.key.toLowerCase()
    // 全屏模式下音量键切动画。真机由 MainActivity 拦下音量键后回调 onVolumeKey；
    // 这里兜住「WebView/浏览器直接把音量键送到页面」的情况。
    if (k === 'volumeup' || k === 'volumedown') {
      if (!fsMode) return
      e.preventDefault()
      // 音量上键方向可在设置里选「下一个/上一个」，下键永远相反
      switchAnimation((k === 'volumeup' ? 1 : -1) * volDirMul())
      return
    }
    if (k === 'arrowup' || k === 'arrowdown') {
      e.preventDefault()
      switchAnimation(k === 'arrowdown' ? 1 : -1)
      return
    }
    if (k === ' ') { e.preventDefault(); setPlaying(!S.playing); return }
    if (k === 'arrowleft') { e.preventDefault(); stepFrame(-1); return }
    if (k === 'arrowright') { e.preventDefault(); stepFrame(1); return }
    if (k === 'r') { resetCamera(); return }
    if (k === 'f') { refitBounds(); fitToWindow(); return }
    if (k === 'l') { $('chkLayerSelect').checked = !$('chkLayerSelect').checked; $('chkLayerSelect').onchange({ target: $('chkLayerSelect') }); return }
    if (k === 'h') {
      if (S.selectedLayer) {
        const n = S.selectedLayer
        setLayerHidden(n, true)
      }
      return
    }
    if (k === 'u') {
      const n = S.hiddenStack[S.hiddenStack.length - 1]
      if (n) {
        setLayerHidden(n, false)
        S.selectedLayer = n
        updateLayerToast(); renderLayerList(); drawOverlay()
      }
      return
    }
    if (e.key === 'Escape') {
      for (const n of [...S.hidden]) restoreLayerAlpha(n)
      S.hidden.clear(); S.hiddenStack = []; S.selectedLayer = null
      updateLayerToast(); renderLayerList(); S.player?.drawFrame(false)
      return
    }
    if (k === '[' || k === ']') {
      const cur = currentAnimation()?.name
      const i = S.animations.indexOf(cur)
      if (i < 0) return
      const n = S.animations[(i + (k === ']' ? 1 : -1) + S.animations.length) % S.animations.length]
      if (n) playAnimation(n)
    }
  })

  // 拖动上传：整窗 preventDefault（避免浏览器打开文件），但只在 #dropzone 内真正接收
  function isOverDropzone(e) {
    const zone = $('dropzone')
    if (!zone) return false
    const path = typeof e.composedPath === 'function' ? e.composedPath() : null
    if (path && path.includes(zone)) return true
    return zone === e.target || zone.contains(e.target)
  }
  ;['dragenter', 'dragover'].forEach(ev => {
    window.addEventListener(ev, e => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      if (isOverDropzone(e)) $('dropzone')?.classList.add('over')
      else $('dropzone')?.classList.remove('over')
    })
  })
  window.addEventListener('dragleave', e => {
    if (!isOverDropzone(e)) $('dropzone')?.classList.remove('over')
  })
  /** 拖进来的包属于哪一档。与服务端 classifyBundleHead 同一条规则。 */
  async function sniffDroppedBundle(file) {
    const name = file?.name || ''
    if (/\.(atlas|json|skel|png|jpg|jpeg|webp|bytes|txt|md)$/i.test(name)) return null
    let buf
    try { buf = new Uint8Array(await file.slice(0, 4096).arrayBuffer()) } catch { return null }
    const magic = [0x55, 0x6e, 0x69, 0x74, 0x79, 0x46, 0x53, 0x00]
    const at = (i) => {
      if (i < 0 || i + 8 > buf.length) return false
      for (let k = 0; k < 8; k++) if (buf[i + k] !== magic[k]) return false
      return true
    }
    if (!at(0)) return null
    if (/prefabs_spine/i.test(name)) return 'jczx'
    for (let i = 1; i + 8 <= buf.length; i++) if (at(i)) return 'jczx'
    return 'nikke'
  }
  window.addEventListener('drop', async e => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    $('dropzone')?.classList.remove('over')
    // 项目页 / 舞台上随便拖：只挡默认行为，不触发导入
    if (!isOverDropzone(e)) return
    const files = [...e.dataTransfer.files]
    // 同一目录里两种包都有：用文件头分流，不能靠「有没有扩展名」。
    // JCZX = 名字含 prefabs_spine，或开头 4KB 里有第二段 UnityFS。
    // NIKKE = 只有一段 UnityFS（无扩展名的 mod 包）。
    const bundles = []
    for (const f of files) {
      const kind = await sniffDroppedBundle(f)
      if (kind) bundles.push({ f, kind })
    }
    if (bundles.length && !NATIVE) {
      const jczxFiles = bundles.filter(b => b.kind === 'jczx')
      const nikkeFiles = bundles.filter(b => b.kind === 'nikke')
      try {
        setDropText(t('正在提取资产…'))
        for (const { f, kind } of bundles) {
          const buf = await f.arrayBuffer()
          const q = new URLSearchParams({ root: S.rootId || '', name: f.name || 'bundle' })
          const url = kind === 'jczx' ? '/api/jczx/ingest' : '/api/nikke-ab/ingest'
          const res = await fetch(`${url}?${q}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': f.name || 'bundle' },
            body: buf,
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
        }
        const target = (jczxFiles.length && !nikkeFiles.length) ? 'jczx'
          : (nikkeFiles.length && !jczxFiles.length) ? 'nikke'
          : S.mode
        if (jczxFiles.length && nikkeFiles.length) {
          setDropText(t('两种包已分开：JCZX {j} 个，NIKKE {n} 个。用顶栏切换查看。', {
            j: jczxFiles.length, n: nikkeFiles.length,
          }))
        } else {
          setDropText(t('提取完成，正在刷新列表…'))
        }
        if (target !== S.mode) await setAssetMode(target)
        else await scan(true)
      } catch (err) {
        setDropText(t('提取失败：{msg}', { msg: err.message || String(err) }))
      }
      return
    }
    const hasSpine = files.some(f => /\.(atlas|json|skel)$/i.test(f.name))
    if (!hasSpine) return
    uploaded.files = files
    $('uploadName').value = files[0].webkitRelativePath?.split('/')[0] || ''
    $('dropzone').classList.add('over')
    setDropText(t('已接收 {n} 个文件，点「载入」开始', { n: files.length }))
    $('uploadModal').hidden = false
    $('uploadMsg').textContent = ''
  })

  // 上传弹窗
  $('pickFiles').onclick = e => { e.stopPropagation(); $('filePick').click() }
  $('dropzone').onclick = e => {
    if (e.target.id === 'pickFiles') return
    $('filePick').click()
  }
  $('filePick').onchange = e => {
    uploaded.files = [...e.target.files]
    $('dropzone').classList.add('over')
    setDropText(t('已接收 {n} 个文件，点「载入」开始', { n: uploaded.files.length }))
    $('uploadMsg').textContent = ''
  }
  $('btnDoUpload').onclick = doUpload

  // 舞台尺寸变化（全屏 / 转屏 / 窗口缩放）：重排背景 + 按新视口换算 zoom
  let resizeTimer = 0
  new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(onStageResize, 60)
  }).observe($('stageInner'))

  // 滚轮缩放（交给 CameraController，这里只保证缩放后刷新）
  $('playerHost').addEventListener('wheel', () => { if (!S.busy) setTimeout(() => S.player?.drawFrame(false), 0) }, { passive: true })

  // seek
  $('seek').addEventListener('input', e => {
    const p = S.player
    const entry = currentEntry()
    if (!p || !entry || !entry.animation) return
    const d = entry.animation.duration || 0
    if (d <= 0) return
    p.pause()
    S.playing = false
    updatePlayButton()
    entry.trackTime = Number(e.target.value) * d
    p.animationState.apply(p.skeleton)
    skeletonUpdateWorld(p.skeleton)
    p.drawFrame(false)
  })

  // 初始 UI 值
  $('speedVal').textContent = '1.00x'
  $('bgColor').value = S.bgColor
  $('setBgColor').value = S.bgColor
  $('setMaxSize').value = String(S.maxSize)
  $('setFps').value = String(S.fps)

  // 把过滤状态和箭头显隐同控件、数据对齐一次。
  // bindUI 跑在 boot 首次扫描之前，扫描结束后 refreshLists() 会再对齐一次。
  refreshLists()
}

boot()

/* 调试 / 脚本化句柄：便于高级用户在浏览器控制台里直接操作查看器 */
window.__bd2viewer = {
  get state() { return S },
  get isNative() { return NATIVE },
  get player() { return S.player },
  fitToWindow,
  resetCamera,
  refitBounds,
  zoomIn: () => setZoom(S.camera ? S.camera.zoom / 1.2 : 1),
  zoomOut: () => setZoom(S.camera ? S.camera.zoom * 1.2 : 1),
  playAnimation,
  setPlaying,
  get animation() { return currentAnimation()?.name || null },
  get animations() { return S.animations },
  // Spine 运行时：4.1 常驻、4.0 供 NIKKE 用。distinct 用来证「没互相覆盖」。
  get spineRuntimes() {
    return {
      has41: !!SPINE_DEFAULT,
      has40: !!SPINE40,
      has42: !!SPINE42,
      distinct: SPINE40 !== SPINE_DEFAULT && SPINE42 !== SPINE_DEFAULT && SPINE40 !== SPINE42,
    }
  },
  /** 读骨架头判定 minor 版本（'4.0' / '4.1' / null）。测试与排障用。 */
  spineMinorOf: item => spineMinorFor(item),
  /** 3.x JSON → 4.x JSON 的兼容转换（纯函数，测试直接喂字符串就能验）。
   *  不是 3.x 返回 null；转换结果用 JSON.parse 校验。 */
  spineJson38to41,
  /** 关掉「缩略图写回资产目录」（需求 5）。自动化测试必须关：它会写用户磁盘，
   *  而且写完之后卡片走「自带 thumb.png」捷径、不再进离屏队列，
   *  让「坏文件不堵队列」这类断言失去前提。 */
  setThumbPersist(on) { thumbPersist = !!on; return thumbPersist },
  get thumbPersist() { return thumbPersist },
  setLayerHidden,
  pickLayerAt,
  screenshot,
  exportWebm,
  exportFrames,
  scan,
  selectItem,
  // 全屏模式：真机的音量键由 MainActivity 拦下后回调这里
  get isFullscreen() { return fsMode },
  setFullscreen,
  switchAnimation,
  // 平铺浏览 / 顺序 / 缩略图
  get view() { return viewMode },
  setView,
  openItem,
  // 绝对路径：relAtlas 只是相对根目录的那一截，拼成整条要 rootPath + sep
  absPathOf,
  copyToClipboard,
  get order() { return loadOrder() },
  setOrder(keys) { saveOrder(keys); refreshLists() },
  rebuildThumbs,
  makeThumb,
  get thumbStats() {
    return { cached: thumbCache.size, done: thumbDone, running: thumbRunning }
  },
  commitCardOrder,
  // 播放顺序：排序方式 + 升降序（同时决定平铺页、左列表、◀▶ 的走向）
  get sort() { return { ...sortState } },
  setSortMode,
  toggleSortDir,
  // 资产类型（BD2 / Lost Sword / NIKKE）。setAssetMode 会落盘 + 重扫，测试用它代替点按钮。
  get mode() { return S.mode },
  setAssetMode, matchesAssetMode,
  // NIKKE 姿势（R18）：测试与排障用。switchPose 走真实链路（重走 loadCurrent）。
  get pose() { return S.currentPose || 'normal' },
  switchPose,
  renderPoseBar,
  // Ark 语音（星陨计划）：正在播的 Audio 实例。new Audio 的元素从不进 DOM，
  // 没有这个探针就没法判断「点了到底播没播」。
  get arkAudio() {
    const a = S.__arkAudio
    return a ? { readyState: a.readyState, networkState: a.networkState, error: a.error ? a.error.code : null, duration: a.duration, paused: a.paused, src: a.currentSrc } : null
  },
  // Lost Sword 两层角色（R19）：测试用它确认背层真的起来了、且跟着本体同步
  get layers() {
    const bp = S.backPlayer
    const be = bp && bp.animationState && bp.animationState.getCurrent(0)
    return {
      hasBack: !!bp,
      backBase: S.backItem?.base || null,
      backAnim: be && be.animation ? be.animation.name : null,
      backTrackTime: be ? be.trackTime : null,
      backCanvases: document.querySelectorAll('#playerBackHost canvas').length,
    }
  },
  /** 当前视图（grid=资产页 / player=播放页）—— 测试用它确认「轮询守卫」的语义：
   *  在播放页里解包轮询不许触发重扫（否则全屏「扫描中…」盖住正在看的动画） */
  get viewMode() { return viewMode },
  /** 解包期间在播放页攒下的「回列表再扫」标记（回到平铺页时被消费 → 置回 false） */
  get unpackPending() { return unpackRescanNeeded },
  /** 当前实际生效的播放顺序（键序列，已应用过滤 + 排序） */
  get visibleKeys() { return filteredItems().map(itemKey) },
  get allKeys() { return allItems().map(itemKey) },
  get dragStats() {
    return {
      active: !!cardDrag,
      placeholders: document.querySelectorAll('#galGrid .card-ph').length,
      floating: document.querySelectorAll('#galGrid .card.dragging').length,
      stuckInline: [...document.querySelectorAll('#galGrid .card')]
        .filter(c => c.style.transform || c.style.transition).length,
    }
  },
  /** 拖动收尾里被吞掉的异常（正常恒为 null）—— 间歇性「拖完点一下误开播放页」的探针 */
  get lastDragError() { return lastDragError },
  /** 当前生效的「余波 click 抑制」：脚本化测试用来确认收尾确实装上了它 */
  get suppressClick() {
    return suppressClick
      ? { key: suppressClick.el.dataset.key, until: suppressClick.until, live: Date.now() < suppressClick.until }
      : null
  },
  // 全屏：双击定点放大 / 隐藏界面
  doubleTapZoom,
  get cleanUI() { return cleanUI },
  setCleanUI,
  // 真机音量键：MainActivity 拦下后回调 dir（+1=音量上，-1=音量下），方向由设置决定
  onVolumeKey(dir) { switchAnimation(dir * volDirMul()) },
  get zoomRatio() { return currentZoomRatio() },
  /** 相对「铺满」放大了几倍（脚本化测试双击阶梯用） */
  get zoomFactor() { return 1 / (currentZoomRatio() || 1) },
  ZOOM_LADDER,
  // 选择 / 删除
  get selectMode() { return selectMode },
  setSelectMode,
  toggleSelectKey,
  get selectedKeys() { return [...selectedKeys] },
  selectAllCards() {
    for (const c of document.querySelectorAll('#galGrid .card')) selectedKeys.add(c.dataset.key)
    for (const c of document.querySelectorAll('#galGrid .card')) c.classList.add('sel')
    applySelectUI()
  },
  runDelete,
  confirmDelete,
  runRemoveRoot,
  confirmRemoveRoot,
  canRemoveRoot,
  relDirOfItem,
  openCardMenu,
  // 导航：切上一个/下一个资产、返回键的分层消化
  switchItem,
  handleBack,
  /** 上一次返回被哪一层消化（'none' = 交给宿主）—— 真机按返回没反应时先看这个 */
  get lastBackReason() { return lastBackReason },
  /** 当前过滤条件（只读快照）—— 断言「控件是入口、filters 是事实来源」用 */
  get filters() { return { ...filters } },
  /** 播放页左右箭头此刻是否可见（当前资产有多个动画才显示） */
  get stageNav() { return document.body.classList.contains('stage-nav-avail') },

  /* ---- i18n（脚本化测试用；见 ARCHITECTURE R11） ---- */
  /** 当前语言：'zh' | 'en' */
  get lang() { return LANG },
  /** 翻译函数本体（测试里直接查表，不必读 HTML） */
  t,
  /** 切语言并落盘（等同设置里那个下拉） */
  setLang: v => { saveLang(v); $('setLang').value = LANG },
  /** 用户主动选过语言没有 —— 决定首次启动弹不弹询问框 */
  get langPicked() { return langPicked() },
  /** 手动亮出 / 收起首次语言询问框（测试流程用） */
  showLangModal: () => askLanguage(),
  /** 当前这次搜索的命中理由表：assetKey → 命中的资源文件名 */
  get searchHits() { return Object.fromEntries(searchHits) },
}
