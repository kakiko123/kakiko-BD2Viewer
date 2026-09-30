# kakiko-BD2Viewer — 架构与分层复盘

> 复盘日期：2026-09-23 · 基线：`public/app.js` 4019 行 / 161 个顶层函数 / 8 个 `render*` 函数
> （基线数字只对那次复盘成立；本文档里凡涉及"现在多少行 / 多少个"的地方，
> 都注明是一次**实测值**，改完记得重新量一遍再改数字。）
> 触发原因：连续三处 bug（首页多出四个按钮、旋转锁定失效、返回键直接退出软件）指向**同一个病根**——
> 同一件事的"真相"存在两处以上，谁改都得靠记性。这份文档把病根写成规则。
>
> 迭代记录：2026-09-26 加 i18n（R11/R11.1/R12 + §6.1）；
> 2026-09-26 加资产命名约定（R13 + §6.2，`app.js` 4845 行 / 184 个顶层函数 / 17 处 `NATIVE` 分叉）；
> 2026-09-28 加 PC 侧入口（R14/R15：播放页「返回列表」+ 右键复制绝对路径，
> 实测 `app.js` 4970 行 / 187 个顶层函数 / 17 处 `NATIVE` 分叉 → 分叉数没涨，
> 剪贴板走「先试原生桥、再浏览器 API」，没有新增 `if (NATIVE)`）。
> 2026-09-28 加 NIKKE 支持（R16：两套 Spine 运行时按骨架世代挑。NIKKE 与 BD2 命名相同，
> 所以**没有新增 `mode`、没有新增 `NATIVE` 分叉**；实测 `app.js` 5100 行 / 191 个顶层函数 /
> 仍是 17 处 `NATIVE` 分叉）。
> 2026-09-28 修扫描重叠（R17：`scan()` 加代次守卫，过期结果整包丢弃。这是从 R15 的一个洞
> 反推出来的 —— 复制路径用的 `S.rootPath` 会被**另一次更早发出、更晚返回**的扫描改写，
> 于是「相对路径属于 A 根、前缀来自 B 根」，拼出一条不存在的路径。实测禁用守卫时
> `e2e` 能稳定复现：停在 0 项的小目录，列表里却是 178 项的另一个根；实测
> `app.js` 5111 行 / 191 个顶层函数 / 未新增 `NATIVE` 分叉）。
> 2026-09-28 加 NIKKE 独立模式（R18：`<id>_00` 本体 + `<id>_aim_00` / `<id>_cover_00`
> 姿势变体归成一张卡，播放页切姿势，默认动画落到 aim_idle / cover_idle —— 与参考站
> Nikke-db 的组织方式一致）+ 多皮肤骨架合成（default 垫底 + 初始挑覆盖最全的皮肤；
> Lost Sword 的 default 皮肤常常只有零头，实测 Elin 81 槽位里 default 只带 11）。
> 修一个自己刚引入的坑：onLoaded（播放器载入上下文）里调 `drawFrame` 会弄坏渲染循环
> （实测唯一多皮肤的 aim 骨架报「Unable to render skeleton」）→ 载入路径只设皮肤不画帧。
> 实测 `app.js` 5323 行 / 199 个顶层函数 / 未新增 `NATIVE` 分叉。
> 2026-09-30 产品口径修订：不要求跨模式完美隔离。各模式在对应素材在场时能正确查看即可；
> 已撤回按骨架世代（4.0 vs 4.1）与命名形（`isNikkeShaped`）过滤可见列表的做法。
> NIKKE 档仍做姿势归组（R18）；Android 仍按 `BD2Viewer/{bd2,nikke,lostsword}` 分子目录。

---

## 1. 三个产物，一份前端

| 产物 | 入口 | 数据来源 | 前端代码 |
|---|---|---|---|
| **桌面版** | `server.mjs`（Node，仅 127.0.0.1） | `fetch('/api/*')` + `/spine/*` | `public/index.html` + `app.js` + `styles.css` |
| **APK** | `MainActivity` → `loadDataWithBaseURL` 载入 `web/app.bundle.html` | `window.BD2Native.*`（`NativeBridge` / `ScanEngine`） | 同上，打包成单文件 |
| **共享前端** | `public/` | 由 `const NATIVE` 一处开关决定走哪条 | —— |

关键设计：**前端只有一份**。`_tools/bundle.mjs` 把 CSS/JS 内联成 `app.bundle.html`，
`_tools/sync_assets.mjs` 同步进 `bd2-android/app/src/main/assets/web/`。
`gradle` 的 `syncWeb` 任务在 `preBuild` 再兜一次。三者 sha1 由 `_verify_apk.py` 强制对齐。

> 踩过的坑：`bundle.mjs` 只写 `public/`，APK 读的是 `assets/web/`。漏了同步这一步，
> 会出现"代码改了、装到手机上还是旧界面"的假象。所以同步做成了脚本 + sha1 校验，不靠手 `cp`。

---

## 2. 前端分层：实际调用链（不是理想图，是代码长成的样子）

```
  ┌─ 宿主适配层 ────────────────────────────────────────────────┐
  │  const NATIVE · window.BD2Native.* · setFullscreen()        │
  │  禁令：除 scan()/removeItemsOnDisk()/导入 这几处，别处不许    │
  │        再出现 if (NATIVE) 的数据源分叉                       │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌─ 状态层 ─────────────────┴──────────────────────────────────┐
  │  S（会话，含 mode） · filters（可见性） · sortState（顺序）   │
  │  selectMode / selectedKeys（选择） · fsMode / viewMode（模式）│
  │  规则：状态是唯一事实来源；DOM 控件只是入口                    │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌─ 派生层 ─────────────────┴──────────────────────────────────┐
  │  allItems() ─→ orderedList() ─→ filteredItems()              │
  │  filteredItems() 是「可见资产」的**唯一口径**                 │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌─ 渲染层 ─────────────────┴──────────────────────────────────┐
  │  renderAssetList · renderGallery · renderAnimList            │
  │  renderLayerList · renderSkinSelect · renderRootOptions …     │
  │  规则：渲染函数**只读状态、不写状态**                          │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌─ 刷新层（本次新增）──────┴───────────────────────────────────┐
  │  refreshLists()   ← 唯一入口：syncFilters → 列表 → 卡片墙 → 箭头 │
  │  例外只有 commitCardOrder()（理由见 §4.4）                     │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌─ 交互层 ─────────────────┴──────────────────────────────────┐
  │  bindUI() · setupMobileShell() · setupFullscreenUI()         │
  │  规则：事件处理只做两件事——改状态、调入口函数                  │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌─ 导航层 ─────────────────┴──────────────────────────────────┐
  │  setView(视图) · openItem(资产) · switchItem(±1) · handleBack()│
  │  「当前在哪一层」的知识只在这一层，宿主（Java）不许自己猜        │
  └──────────────────────────────────────────────────────────────┘
```

---

## 3. 本次复盘的发现

| # | 症状 | 根因 | 判断 | 处置 |
|---|---|---|---|---|
| 1 | 首页（资产页）底部多出「资产/播放/图层/设置」四个按钮 | **可见性双轨制**：JS 写 `.hidden`，CSS 又用 `display:none !important`。`body.view-grid` 那条规则只点名了 `.mnow/.mquick`，漏了 `.mtabs` | 不合理。同一件事"显示与否"有两个作者，必然漏 | 定归属规则（§6 R1），把 `.mtabs` 补进规则；并补 `syncTouchSettingsEntry()` 堵住"设置入口真空" |
| 2 | 手机全局开了旋转锁定，App 仍跟着重力转 | `screenOrientation="fullSensor"` 按官方语义**故意无视**系统旋转锁定；`sensor` 同理 | 不合（用错了属性） | 改 `fullUser`（锁定→跟随用户；未锁→允许 4 向，API 18+）。`manifest_check.mjs` 把这条钉住 |
| 3 | —— | `filteredItems()` 直接读 `#assetFilter.value` / `#chkOnlyPlayable.checked`：把"排序+过滤"这一层和左侧抽屉的控件绑死，同一条件两个事实来源，也没法单独推理/测试 | 不合理 | 引入 `filters` 状态 + `syncFilters()`；`filteredItems()` 只读状态 |
| 4 | —— | "刷新资产视图"那两行（列表 + 平铺页）被复制在 **6 处**，另有 **5 处**只刷了列表。"漏刷"靠人的记性 | 不合理 | 收敛成 `refreshLists()` 唯一入口；`commitCardOrder()` 是唯一有名字的例外 |
| 5 | 播放页按返回直接退出软件 | 返回键的层次知识写死在 Java 里（只有一条"全屏先退全屏"）；页面内部的对话框/抽屉/选择模式/视图层级完全没参与 | 不合理 | 前端出 `handleBack()` 作为唯一分层入口；Java 只负责问、不负责猜（`JS_BACK`） |

---

## 4. 已落地的调整（附锚点）

### 4.1 可见性归属规则
- 规则：**随「模式」变的 → CSS；随「数据」变的 → JS 挂 body 类名**；同一条规则只写一处。
- 落地：`styles.css` 的 `.stage-nav` 一带（`body.stage-nav-avail:not(.view-grid)` 显、`body.is-immersive` 隐）
  与 `app.js` 的 `syncStageNav()` 各管一半，互不越界。

### 4.2 过滤条件收进状态
- `const filters = { q, onlyOk }` + `syncFilters()`（`app.js` ~1063）。
- 约定写在代码里：**控件是入口，`filters` 才是事实来源**。

### 4.3 刷新收敛为唯一入口
```js
function refreshLists() {      // app.js ~1092
  syncFilters()                // 控件 → 状态
  renderAssetList()            // 左侧列表
  if (viewMode === 'grid') renderGallery()
  syncStageNav()               // 播放页左右箭头的显隐
}
```
调用点：扫描完成、排序切换、升降序、删除后、`selectItem`、导入后、过滤控件、`bindUI` 收尾、`setOrder`。

### 4.4 那条"有名字的例外"
`commitCardOrder()`（拖动落位后）**故意只刷列表**：此刻重建网格 DOM 会把拖动的收尾动画和
滚动位置一起打掉，而平铺页的顺序本来就是用户刚摆好的。例外必须带注释说明原因，否则下一个人
会把它当漏写补上。

### 4.5 播放页两组箭头（2026-09-25 对调过一次，语义见 R6）
- 画面两侧 `#stagePrev` / `#stageNext` 走 `switchAnimation(±1)` —— 切当前资产的**上一个 / 下一个动画**。
  之所以把最大、最好按的位置留给动画：一套资产里「找想要的哪个动作」是最高频的操作，
  而「换下一套资产」在底部快捷条上同样够得着。
- 底部快捷条 `#mBack` / `#mFwd`（◀◀ / ▶▶）走 `switchItem(±1)` —— 与全屏顶栏 ◀▶、键盘、
  真机音量键同一条路，顺序口径（`filteredItems → orderedList`）与列表完全一致。
- 连带约束：`syncStageNav()` 的显隐条件必须跟着**动画数**走（`S.animations.length > 1`）。
  对调箭头却忘了改这里，就会出现「三个动画的资产上箭头是灰的」或「单动画资产的箭头点了没反应」。
  测试钉在 `native_mode.mjs` ㉒。

### 4.6 返回键分层消化
`handleBack()`（`app.js` ~1310）由内到外逐层剥，返回 `true` = 这次返回被消化：

```
确认框 → 设置/上传/帮助/卡片菜单 → 全屏文件侧栏 → 底部抽屉 → 批量选择 → 全屏 → 播放页回资产页 → false
```

配套改动：
- `confirmDelete()` 把取消入口挂到蒙版元素上（`mask.__cancel`）。否则 `handleBack` 关掉了弹窗，
  却没人 `resolve(false)`，删除流程会永远挂着。
- `MainActivity.onBackPressed()` 改成**先问页面**（`JS_BACK` + `evaluateJavascript`），
  只有页面回 `"true"` 才什么都不做；`false` / `none` / `error` 一律走宿主的 `legacyBack()` 兜底
  （页面还没加载好时行为与从前一致）。
- 新增探针 `__bd2viewer.lastBackReason`：真机"按返回没反应"时，一眼看出是页面吃掉了还是宿主没接住。

### 4.7 首屏必须被「钉死」，不能靠 JS 事后纠正
症状：每次进 App 都先闪一屏播放页，再跳到资产页。

根因不是逻辑错，而是**时序**：`viewMode` 初值虽然是 `'grid'`，但 `setView('grid')` 原先只在
`scan()` 末尾调用。在 `app.js` 执行到那一行之前，`<body>` 上没有任何 `view-grid` 类，
而 `.stage` 的默认 `display` 是 `flex` —— 于是浏览器先老老实实画了一屏播放页布局。
实测（把 `scan` 人为拖到 2500ms）：`+0ms` 时 `.stage=flex`，`+2753ms` 才变 `none`。
`scan()` 越快闪得越短，所以本地跑几乎看不见，真机（资产多、扫描慢）才刺眼。

处置是两条一起上，缺一不可：
1. **静态钉子**：`index.html` 直接写 `<body class="view-grid">`，让「第一帧该长什么样」在
   HTML 里就确定，不依赖任何脚本执行。
2. **动态对齐**：`boot()` 在 `await scan()` **之前**就调 `setView(initialView())`，
   其中 `initialView()` = 有 `?item=` 深链走 `player`，否则 `grid`。
   深链因此不会被执行顺序误伤。

推论（R1 的延伸）：**凡是「首屏该显示什么」的判定，都不能只存在于 JS 里** ——
JS 到达之前的那段时间是无人管辖的。测试钉在 ㉔ 与 `_test/bundle_firstpaint.mjs`。

### 4.8 清理的冗余
- 删掉别名：`visibleItems()` ≡ `filteredItems()`、`notice()` ≡ `showFsToast()`。
- 改名把作用域说小的：`fs-toast / #fsToast / showFsToast` → `toast / #toast`（它本来就不是全屏专属）。

---

## 5. 判定「暂不动」的三件事（附触发条件）

诚实记录：以下三处**确实不够好，但这次不改**，并写清什么情况下必须动手。

### 5.1 `app.js` 是 5323 行单体
- 现状：199 个顶层函数（口径：`grep -c '^function \|^async function '`）、
  共享一堆模块级 `let`（`S`、`sheetOpen`、`fsMode`、`selectMode`、`viewMode`、`scanSeq`、`nikkeView`…）。
- 为什么现在不拆：`app.js` 被 `bundle.mjs` 内联进一个 `<script>`，走的是**全局脚本**语义而非 ES module。
  拆文件要同时改动打包器、`sync_assets` 的 FILES 列表、APK 资源加载与全部测试的加载方式——
  一次"为了好看"的重构会把当前所有绿色测试变成风险面。
- 拆分边界（真要拆时按这个切）：`state` / `render` / `nav` / `host-bridge` / `bind`，与 §2 的分层一一对应。
- **触发条件**：① 需要两人以上同时改 `app.js`；② 单次改动引发的回归超过 3 处；
  ③ 引入构建期模块化（esbuild/rollup）那一刻，顺手切分。

### 5.2 `NATIVE` 分叉有 17 处
- 其中约 7 处是"桌面没有这个 API"的保护（`requestFullscreen` 等），10 处是真正的数据源分叉
  （扫描、删除、导入、配置、存储诊断）。
  （计数口径：`grep -n NATIVE public/app.js`，扣掉定义那一行与调试面那一行。）
- 理想形态是一个 `Host` 适配器接口（`scan/delete/import/roots`），前端不认 `NATIVE`。
- 触发条件：出现**第三种**宿主（比如再包一层 Electron）时立刻抽，否则两路分叉的可控性还行。

### 5.3 `index.html` 的 138 个元素 id 被 `$()` 直接取
- 口径：`app.js` 里 `$('x')` 的去重集合（`index.html` 本身有 140 个 id，多出的几个由
  `document.getElementById` 或 `data-*` 间接使用）。
- 现状：`bundle_check.mjs` 有一条"`app.js` 引用的 id 都存在于 `index.html`"的静态检查兜底。
- 触发条件：改成模板渲染/组件化时一并处理；现在有测试兜着，收益有限。

---

## 6. 不变量（硬规则，review 与测试都引用这些编号）

| 编号 | 规则 |
|---|---|
| **R1** | 可见性归属：随**模式**变的条件写 CSS；随**数据**变的条件由 JS 挂 `body` 类名。同一条规则只写一处，两处都写就是 bug。 |
| **R2** | 控件是入口，状态是事实来源。控件变化时调 `syncFilters()`，其余代码只读 `filters`。 |
| **R3** | 「可见资产」只有一个口径：`filteredItems()`。列表、卡片墙、`switchItem`、箭头显隐都必须走它。 |
| **R4** | 渲染函数只读状态、不写状态。 |
| **R5** | 状态变了要重画 → 一律 `refreshLists()`。要绕开必须写明理由（现仅 `commitCardOrder()`）。 |
| **R6** | 资产导航只有一个入口：`switchItem(±1)`；动画导航只有一个入口：`switchAnimation(±1)`。**四组箭头各归其位，不许再对调**：`#stagePrev/#stageNext`（画面两侧，大而易按）→ 切**动画**；`#mBack/#mFwd`（底部快捷条 ◀◀/▶▶）→ 切**资产**；`#fsPrevFile/#fsNextFile`（全屏顶栏）→ 切**资产**；`#fsPrevAnim/#fsNextAnim`（全屏底栏，兼音量键）→ 切**动画**。推论：`syncStageNav()` 的显隐条件看的是**动画数**（`S.animations.length > 1`），不是资产数 —— 改错就会「箭头在但点了没反应」或「该显示时反而不显示」。**切视图**（播放页 ↔ 平铺页）不属本条，那是另一件事，入口按 R14 处理。 |
| **R7** | 「当前在哪一层」的知识只属于前端 `handleBack()`；宿主只问不猜。 |
| **R8** | 异步确认类弹窗必须留一个可被 `handleBack()` 调到的取消入口（如 `mask.__cancel`），否则 Promise 会挂住。 |
| **R9** | 数据源分叉只在 `NATIVE` 的既有分叉点，不新增；新增需在本文件登记。 |
| **R10** | 对外调试/测试面只有 `window.__bd2viewer`。新增能力先挂这里，不要在测试里摸内部变量。 |
| **R11** | **所有用户可见文案必须过 `t()`。** 判定标准是「会不会进到用户眼睛」——写进 `showError()`、`toast()`、`textContent`、`title`、`placeholder`、`alert`、`prompt` 的都要包；只进 `console` / 内部日志的可以留中文。三种用法：①静态元素用 `data-i18n` / `data-i18n-html` / `data-i18n-title` / `data-i18n-ph` / `data-i18n-aria` 属性；②JS 生成的走 `t('中文原句')`，**中文原句就是 key**（中文模式下恒等返回，零回归）；③带变量的用 `t('已删除 {n} 个', { n: 5 })`，占位符是 `{name}`。含 `<b>`/`<br>` 的整条用 `data-i18n-html` 或 `innerHTML`（用 `textContent` 会把标签抹掉）。查不到就原样返回中文 —— 不显示 key、不崩。 |
| **R11.1** | **有两类中文「本来就不该翻译」**：①**用户数据**（目录下拉里的根目录名 `手机存储 /BD2Viewer`、资产目录名）；②**专名/自称**（语言选择器里的「中文」，英文界面下也必须写「中文」）。它们由 `markKeepText()` 打上 `data-i18n-keep`，**不改内容、只做标记**。用途是让「英文界面不许残留中文」这类测试能区分「漏包 `t()`」和「本来就该是中文」——否则每加一个数据型节点都要去改测试。判定口诀：**这段文字是给人看的，还是给人读的数据？** |
| **R12** | **`#dropText` 是两段结构，不许整体赋值。** 它里面是「主文案 span + `#pickFiles` 链接」，`$('dropText').textContent = ...` 会把链接节点删掉，之后既点不了、切语言也回不来。改它一律走 `setDropText(s)`（只写第一个 span）或 `applyLang()`；还原走 `dropTextDefault()`。 |
| **R13** | **资产类型（`S.mode`）是全局唯一开关，且必须一路传到数据源。** 它决定用哪套命名约定认资产：`bd`（标准 Spine 导出）与 `lostsword`（Unity TextAsset 导出）。三条硬性推论：①认文件**按「角色」分桶，不按扩展名**（`K_ATLAS/K_JSON/K_SKEL/K_THUMB`，见 §6.2），新增约定只改 `classify()` 一处；②`mode` 必须进**扫描缓存键**（服务端 `rootId\|mode`、安卓 `cacheKey()`），且三个原生调用（`requestScan` / `scanPage` / `scanCount`）**都要带上**——少一个就会拿到另一套结果，症状是「切了没反应」；③手动顺序键带 mode（`bd2.order.<root>.<mode>`，两套资产文件名不同、共用一份顺序必然对不上），排序偏好键不带（`bd2.sort.<root>`，那是用户习惯，切游戏不该被打回默认）。 |
| **R14** | **PC / 触屏两套入口只允许「可见性」不同，动作必须指向同一处。** 由指针类型决定的显隐一律写 CSS（`.kb-only` 默认显示、`body.is-touch` 下 `display:none`；触屏专属的用 `body.is-touch` 条件，如 `.grid-fab`），JS 里**不许为两边各写一份行为**。现例：PC 的「返回列表」`#stageBack` 与触屏的 ⊞ `#stageGrid` 是两个元素，但都只调 `setView('grid')`，层级判断仍只有 `handleBack()` 一份（R7）。推论：**`hidden` 属性与 `display` 不等价**——author 样式的 `display` 会盖掉 UA 的 `[hidden]{display:none}`，所以**测可见性必须量 computed style，别读 `hidden`**（`native_mode` ㉗ 就是按这条写的）。 |
| **R15** | **资产在磁盘上的绝对路径只有一个口径：`absPathOf(item, 'dir' \| 'file')`。** 条目里存的是相对根目录的 `relAtlas`（`/` 分隔），根目录绝对路径来自扫描响应的 `root.path`，收在 `S.rootPath`。分隔符跟根目录走（Windows `\`、其它 `/`）；`kind='dir'` 去掉最后一段（资产直接摆在根下时就是根目录本身）。**拿不到根路径时返回 `null`，上层据此禁用复制入口 —— 不许拼一条看起来像真的的假路径**（原生 SAF 数据源、会话内上传的资产都属于这一类）。`scan()` 开头先清空 `S.rootPath`，否则换目录后会拿旧前缀去拼新资产。 |
| **R16** | **Spine 运行时按「骨架世代」挑，且同一个播放会话必须同源。** 骨架与运行时只有 **major.minor 相同**才能互读，而认错世代**不报版本错误**——4.1 运行时读 4.0 骨架会按 4.1 的布局错位解析，报一句像「图集缺图」的假故障（实测 `Region not found in atlas: add_l_eye23 (sequence: add_l_eye)`，而图集里只有 `add_l_eye`）。三条硬性约定：①**挑运行时只看骨架头**（`spineMinorFor()` 读前 32 字节的 `"4.0.47"` 串，结果缓存在 `item._spineMinor`；JSON 骨架按 4.1，不读文件）；②**整个会话同源**——播放器 / `OrthoCamera` / `CameraController` / `Vector2` / `GLTexture` 预乘补丁都从挑中的那一套取类，会话用的运行时记在 `S.spine`，播放器实例上再挂 `__spineRt`（`onLoaded` 是异步回调，期间用户可能已经切资产）；③**绝不在载入过程中改全局**——缩略图队列与主播放器可能同时在跑，改全局会让两个会话互相踩，所以缩略图用局部变量。**推论（与 R13 的关系）**：`mode` 描述的是**命名约定**，不是游戏；NIKKE 与 BD2 命名相同，因此 NIKKE **不新增 mode**，只在渲染层按世代分流。 |

| **R17** | **同一份异步结果只能由「最后一次请求」落地：`scan()` 用代次（`scanSeq`）作废过期响应。** 两次扫描重叠（快速连点两个根目录、一边刷新一边切资产类型）时，网络回来的顺序**不保证**与发出的顺序一致；「谁后回来谁生效」会让 `S.items` 与 `S.rootPath` 变成一个**混合态**：相对路径来自 A 根、前缀来自 B 根 —— 卡片菜单里的「复制路径」于是拼出一条不存在的路径（R15 于是形同虚设），列表也会显示另一个根的资源。约定：函数第一句 `const seq = ++scanSeq`；拿到响应后 `if (seq !== scanSeq) return`（**在任何状态写入之前**）；`catch` 里对过期结果**连错误提示都不弹**，`finally` 里也不关 spinner（那是新一轮在用的）。这条是**通用模式**：凡「用户切来切去的标识位 + 异步取回整包状态」的地方都要有代次（缩略图队列用 `thumbDone/thumbRunning`、拖动用 `el.__flipGen` 是同一思想的局部实现）。 |

| **R18** | **NIKKE 模式下「一个角色一套资产」：归组 + 变体隐藏都只发生在可见口径这一层，姿势是成员不是卡片。** `<id>_00` 是本体，`<id>_aim_00` / `<id>_cover_00` 是同一角色的瞄准 / 掩体姿势（与参考站 Nikke-db 一致）。约定：①`S.items` 始终存**原始条目** —— 扫描 / 缓存 / 删除 / 上传都不知道分组的存在；`allItems()` 在 NIKKE 档把 aim/cover 变体从可见列表藏掉，并把成员表挂到主条目的 `members` 上（[本体, aim, cover]）；分组结果按 `S.items` 数组身份 + mode 缓存（`nikkeView`）。**不**再按命名形 / 骨架世代挡其它条目（产品不要求跨模式完美隔离）；②当前姿势记在 `S.currentPose`，`loadCurrent` 用 `activeMemberOf()` 取成员的文件 —— **S.current 永远是主条目**（否则 ◀▶ 导航、删除选中、卡片高亮全要跟着改口径）；③变体的文件随主条目一起删（`removeItemsOnDisk` 摊开成员）；④默认动画按姿势落：aim → `aim_idle`、cover → `cover_idle`，没有就退回通用规则。**为什么归组放前端不放服务端/原生**：那要把「成员列表」塞进扫描结果，三个实现得维护同一份分组语义 —— 违反本文档的病根定义。 |

---

## 6.1 i18n 是怎么接进来的（2026-09-26）

**为什么要「中文原文即 key」**：这个项目里中文原文本来就是唯一标识，
再另起一套 `nav.assets` 这类符号 key 就多了一份必须手工同步的映射表 ——
而「同一件事的真相存在两处以上」正是本项目反复出 bug 的病根（见 §3）。
现在中文模式下 `t('资产')` 恒等返回 `'资产'`，等于没接 i18n，**中文侧零回归**。

**翻译表必须在 `app.js` 内部**：`_tools/bundle.mjs` 只内联
`app.js` + `lib/spine-player.js`（4.1）+ `lib/spine-player-4.0.js`（NIKKE 用）+ `lib/jszip.min.js`。
拆出独立的 `i18n.js` 会同时破坏「零外链」自检和 bundle 脚本。
同理，`app.js` 被内联后整体包在 IIFE 里且带 `'use strict'`，
顶层不要写 `const spine` / `JSZip` / `S` 这类会和库在 window 上撞名的绑定。
（这份 IIFE 包装也是 R16 能成立的前提：两套运行时都在全局占着各自的名字
`spine` / `spine40`，而 `app.js` 里的 `SPINE_DEFAULT` / `SPINE40` 是模块内的别名。）

**语言必须在第一帧之前定下来**，两处配合，缺一不可：
1. `index.html` `<head>` 里一段同步脚本，在 `<link rel=stylesheet>` **之前**读
   `localStorage['bd2.lang']` 设 `document.documentElement.lang`；
2. `boot()` 里 `LANG = loadLang(); applyLang()` 要早于 `applyTouchMode()`
   —— 后者内部也有 `t()` 文案（空状态副标题），晚了就会在英文界面上留下一句中文。

这与 §4.7「首屏必须被钉死」是同一条道理：**首屏长什么样不能只存在于 JS 里**。

**查找死条目时注意**：翻译表里带 `\n` 的 key（如 `'上次运行崩溃了：\n'`）
在源码里写作两字符转义、求值后是真换行（charcode 10）。
拿 `new Function` 求出 key 再回源码里 `includes` 会永远找不到 —— 要先把真换行
还原成 `\n` 两字符写法。审计脚本 `_scratch/i18n_audit.mjs` 已处理这一点。

**自查工具**（临时脚本，不进仓库）：
- `_scratch/i18n_audit.mjs` —— key 数 / 重复 / 空值 / `data-i18n*` 引用是否缺 key / 死条目
- `_scratch/i18n_unwrapped.mjs` —— 找「含中文但没包 `t()`」的代码行
- `_scratch/i18n_shadow_check.mjs` —— **找局部变量 `t` 遮蔽全局 `t()` 的地方（必跑）**

> ⚠️ **`t` 这个名字是本项目最大的自伤点，改任何含 `t` 的函数前先想一下。**
> 全局翻译函数叫 `t`，而代码里本来就散着一堆局部 `const t = ...`
> （`trackTime`、`$('toast')`、`$('layerToast')`、`createElement('div')` …）。
> 同一个块作用域里既声明 `const t` 又调 `t('中文')`，后者会撞进 TDZ：
> `Cannot access 't' before initialization`。
> **已经真实炸过两次**：① ZIP / WebM 导出循环里的 `const t = i / fps` 打炸了
> `note.textContent = t('正在导出帧 …')`；② `updateLayerToast()` 里
> `const t = $('layerToast')` 之后紧跟 `t.innerHTML = t('已选图层：<b></b>')` ——
> 直接拿 DOM 元素当函数调，**每次点图层都会抛**。
> 处理办法一律是**把局部变量改名**（`trackT` / `el` / `gt`），
> 不要去改全局 `t()` 的名字。改完跑一遍 `i18n_shadow_check.mjs`。

> ⚠️ 别用「手写词法分析器剥注释」的办法找未包装文案。正则字面量里的 `/`
> （`/\.(png|jpe?g)$/i`）、模板串里的引号都会把状态机带偏，
> 结果几千行被误判成「在字符串里」（已踩过一次）。
> 用行级启发式：先剔注释行，再看引号内是否含中文且该行无 `t(`。

> ✅ **行级启发式的已知假阳性形态**（2026-09-25 逐条核实过，别重复排查）：
> 1. **块注释续行**——`/* ... */` 中间那几行不以 `//` 或 `*` 开头（如 `· 音量键…`、
>    `.scr-narrow 短边 < 400 …`），剔注释只剔了首尾行。约 90 条。
> 2. **多行 `t(` 调用**——`hint.textContent = t(\n  '长按卡片拖动…')`，中文在下一行，
>    而 `t(` 在上一行。约 12 条。
> 3. **把中文当函数入参、由被调方包装**——`btn('复制路径', '复制目录路径…')`、
>    `addBtn(...)`、`storageHint()` 返回的 `actions[].text/title`。被调方内部
>    `b.textContent = t(text)`，**是正确的**。行级扫描看不到这条数据流。约 8 条。
> 4. **`t(cond ? '中文A' : '中文B')`**——先求值三元拿到中文串再查表，**合法且推荐**。
>    `t(SORT_LABEL[st.mode])` 同理。约 16 条。
>
> 所以「未包装 N 条」不等于「有 N 个 bug」。**判据是：该中文字符串最终会不会
> 作为文案直接落进 DOM**——若它只是入参、或先经三元求值，就没问题。
> 目前收敛结果：129 条全部是上述四类假阳性，真实漏网 0。

---

## 6.2 资产命名约定抽象层（2026-09-26）

**要解决的问题**：不同游戏给同一批 Spine 文件起的扩展名不一样，
「怎么认出一套资产」于是有了两套（现在还会再加）规则：

| mode | 图集 | 骨架 | 缩略图 |
|---|---|---|---|
| `bd`（默认） | `x.atlas` | `x.json` / `x.skel` | 无（现场渲一帧） |
| `lostsword` | `x.atlas.bytes` | `x.skel.bytes` / 裸 `x.bytes`（JSON） | 目录里的 `thumb.png` |

**做法：把「扩展名差异」收进一个 `classify()`，主流程只认「角色」。**
三处实现语义必须一致（改一边要改三边）：

| 位置 | 载体 |
|---|---|
| 桌面服务 | `server.mjs` 的 `FORMATS[mode].classify(name)` → `{ role, base?, kind? }` |
| Android 原生 | `ScanEngine.classify(name, mode)` → `Role{ bucket, base }`（桶键是 `@atlas` 等） |
| 上传（桌面） | `app.js` 的 `fileRole(name)` → `'atlas' \| 'skeleton' \| 'json' \| 'image'` |

**为什么按角色分桶、而不是让主流程去数扩展名**：
`server.mjs` 的 `walk()` / `ScanEngine.emitEntries()` 里原本写死了
`byExt.getOrDefault(".atlas", ...)` 这类键。把键换成角色常量之后，
主体逻辑（挑骨架、核贴图、算 problems、记 relThumb）**一行都不用重写**，
两套约定就同时成立了 —— 这正是这次改造没有把扫描器写成两遍的原因。

**两个必须按顺序判断的地方**（顺序写错会静默算错基名）：
1. `.atlas.bytes` / `.skel.bytes` 必须**先于**裸 `.bytes` 判断，
   否则 `path.extname` 只看到最后一段 `.bytes`，基名会算成 `x.atlas` 而不是 `x`。
2. `thumb.png` 必须**先于**通用图片判断，否则它会被当成图集页之一
   （`Agravaine` 这种基名会把 thumb 吸进 images，实测有这个坑）。

**骨架配对是三级级联**（`pickSkeleton()` / `pickByBase()`，短基名优先在前）：
①基名精确相同 → ②骨架基名是 atlas 基名的**前缀**（取最长）→ ③目录里只有一个候选。
实测 Lost Sword 的 430 套里 429 套命中①，剩下 1 套靠②
（`skull_Soldier_Green.atlas.bytes` ↔ `skull_Soldier.skel.bytes`）。
**不能只留③**：有 40 个目录里放着 2~3 个骨架，随便挑会张冠李戴 ——
宁可报「缺骨架」，也不要配错。

**传输侧**：`.atlas.bytes` 必须当**文本**（`text/plain`）返回，
`.skel.bytes` 当二进制；裸 `.bytes` 是 JSON 骨架，前端自己 `fetch().text()` 读，
所以 MIME 落在 `application/octet-stream` 也无妨。
Windows 原生（安卓 `Host.mimeOf`）只看 `lastIndexOf('.')` 会全判成 `bytes`，
必须按下标匹配 `.atlas.bytes` 这一段。

**自带缩略图**：`relThumb` 一旦存在，前端在**卡片渲染时**就直接 `<img src>` 取它
（`builtinThumbUrl()`），不排进离屏渲染队列 —— 既省一次 WebGL 渲染，
也顺带救回「骨架坏 / GL 上下文用满」时渲不出来的卡片。
删除整套资产时 `relThumb` 也在清单里（`relThumb` 必须进 `deletePayload`）。

---

## 7. 验证矩阵

| 套件 | 项数 | 守住的规则 |
|---|---|---|
| `_test/manifest_check.mjs` | 6 | 旋转锁定（`fullUser`）、`configChanges`、`minSdk` |
| `_test/bundle_check.mjs` | 25 | id 一致性、单文件 HTML 可跑、标题与内联样式、无控制台错误、**两套 Spine 运行时（4.0 全局名是 `spine40`、两代确实不同、产物里两份都内联、真实 4.1 骨架不被误判成 4.0 —— 守 R16）** |
| `_test/e2e.mjs` | 45 | 加载、相机取景、图层、截图/导出、**PC 侧入口（12 条：播放页「返回列表」回平铺 + 右键复制绝对路径，路径用 Node 侧 `path.join` 独立算一遍并用 `fs.existsSync` 证明真在硬盘上 —— 守 R14/R15）**、**重叠扫描（2 条：先发的慢轮不许顶掉后发的结果、`rootPath` 不许与 `rootId` 脱节 —— 守 R17）**、**真实素材专项（8 条，素材不在自动跳过）：多皮肤骨架的 default 垫底合成、NIKKE 归组 + 姿势切换真渲染（守 R18）** |
| `_test/native_mode.mjs` | 182 | 假桥下的整条原生通路：拖动、长按、批量删除、**㉒ 箭头语义**、**㉓ 返回键分层**、**㉔ 首屏不闪**、**㉔ 语言切换（7 条）**、**㉕ 资源文件搜索（5 条）**、**㉖ 资产类型切换（7 条，含 R13 的 mode 传参）**、**㉗ PC 入口在触屏下让位（2 条，含 ⊞ 不被顶掉）**、**㉘ NIKKE 模式（6 条：三段开关、mode 传到原生层、4 原始→1 张 NIKKE 卡且 npc 过滤、成员表、姿势条显隐、切回复原 —— 守 R18）** |
| `_test/delete_api.mjs` | 12 | 真删磁盘（自带临时根目录，绝不碰用户 mods） |
| `_test/format_check.mjs` | 30 | 资产命名约定多模式：两套规则互不串味、骨架三级级联、`thumb.png`、`.atlas.bytes` 的 MIME、缓存按 `(root,mode)` 分离、删除含 thumb（自带临时根目录）、**nikke 模式（1.04）：服务端按 bd 规则认文件 + 独立缓存键** |
| `_test/bundle_firstpaint.mjs` | 7 | **产物级**：`app.bundle.html` 首屏就是资产页、无外链、深链仍进播放页 |
| `_verify_apk.py` | 4+2 | 三方 sha1 一致、`screenOrientation=13`、`configChanges` |

合计 307 项。其中**不依赖任何真实素材**的（可以在别人的机器上全绿）是
`manifest_check` / `delete_api` / `format_check` 三个 —— 它们自造临时根目录。
(e2e 的真实素材专项 8 条需要本机有对应素材（多皮肤的 Elin / NIKKE 的 c022），
native_mode 的重叠扫描 2 条需要两个大小不同的根目录 —— 不满足时判 PASS 并标注「跳过」。)

> 注意 **R16 的自动覆盖是「半自动」的**：`bundle_check` 能证明两套运行时都活着、
> 4.0 没顶掉 4.1、真实 4.1 骨架不被误判；但「4.0 骨架能被 4.0 运行时渲染出来」
> 需要真的 4.0 素材，仓库里不放素材，所以那一条靠人工验证（NIKKE `c022` 实测
> 三个子资产各 7~9 个动画、缩略图正常、BD2 对照不回归）。

维护闭环：改完前端 → `bundle.mjs` → `_test/bundle_firstpaint.mjs`（产物级自检）→ `sync_assets.mjs`
→ `gradle assembleDebug` → `_verify_apk.py`。

> `bundle_firstpaint.mjs` 卡在 `bundle.mjs` 之后、`sync_assets` 之前是有意的：内联会重排
> `<head>`/`<body>`，`index.html` 上那句首屏钉子（`<body class="view-grid">`）能不能活着到产物里，
> 只有打完包才知道。其它套件跑的都是 `index.html`，覆盖不到这条。

### 7.1 断言的两条纪律（都从假失败里长出来的）

**① 等条件，别等时长。** 凡是「某个值是异步链条末端算出来的」，都不能用
`await sleep(N)` 然后直接断言。典型：`<canvas>` 的尺寸来自
「舞台尺寸变化 → 换算 fit → `player.resize()`」，中间任何一步被主线程挤占都会延后。
2026-09-25 实测：`applyLang()` 里加了 `refreshLists()`（切语言要重画 179 张卡），
`await sleep(800)` 之后拿到的还是 `<canvas>` 的**默认 300×150**、覆盖 0，
看起来像「渲染挂了」，其实只是没轮到。改法：**轮询直到条件成立**（有上限），
判据用「尺寸已同步（`w > 300`）且画面有内容」。

**② 断言只用单调量。** 「成功 + 失败 ≥ 总数」是单调递增的，可以安全用来判断
「队列跑完了」；`running` 这类布尔量在两件事之间会有**瞬时假值**
（缩略图队列两卡之间有 ~80ms 间隙，`running` 会瞬间 `false`）。
需要确认「真的停了」时，正确做法是**连续两次采样都停**，而不是只看一次 ——
且这个确认是**退出循环的条件**，不要反过来把瞬时量写进断言。
`⑰` 的注释早就写明「不能用 running」，但断言里仍写着 `running === false`，
于是随机假失败 —— **注释与断言不一致时，以那条更严的为准，把两边改齐**。

---

## 8. 相关文档

| 文档 | 内容 |
|---|---|
| [`../README.md`](../README.md) | 面向使用者：快速开始、用法、路线图 |
| [`../docs/TECHNICAL.md`](../docs/TECHNICAL.md) | 技术栈、项目结构、环境要求、实现思路摘要 |
| [`../docs/BUILD.md`](../docs/BUILD.md) | 构建与排查 |
| [`../docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md) | 改代码与写测试的注意事项 |
| [`../docs/KNOWN-ISSUES.md`](../docs/KNOWN-ISSUES.md) | 已知而未处理的问题 |
