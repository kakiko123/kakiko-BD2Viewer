# Kakiko Viewer — 架构与分层复盘

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
> 2026-10-01 修 Lost Sword 两层角色（R19：`<X>_B` 背层 + `<X>_F` 前层是**两套骨架**，
> 游戏里叠着画。实测 LobbyUnit 里 11 个角色成对、两层的 region 集合互补
> （如 Lobby_Merlin：B=9 个 region 只有 1 个与 F 重合），单独打开 `_B` 就只有大头发 /
> 一片裙摆 —— 用户报的「动画加载错误」就是它。现在同一目录的 `_B`/`_F` 归成一套资产、
> 播放页两层叠着渲染（背层在下），卡面缩略图也叠 —— 实测 Lobby_Morganlefay 的 `_F`
> 只有 10 个 region（是前景药瓶），不叠就是一张几乎空的卡）。
> 2026-10-05 打包 v1.1（versionCode 23）：碧蓝航线 pixi 路四连修（R39/R40/R41）+ 设置里新增
> 「更新日志」入口。版本号**三处同改**（`bd2-android/app/build.gradle`、`package.json`、
> 桌面版兜底常量 `APP_VERSION`；APK 读原生 `BuildConfig.VERSION_NAME`），完整历史挪到
> `bd2-android/CHANGELOG.md`。APK 用**本地 Gradle**离线打（wrapper 要联网会超时）：
> `JAVA_HOME=toolchain/jdk17 GRADLE_USER_HOME=toolchain/gradle-home toolchain/gradle/bin/gradle.bat --offline assembleDebug`，
> 打完用 `aapt2 dump badging` 核对 `versionCode=23 versionName=1.1`，再把 APK 内
> `assets/web/*` 与 `public/*` 的 sha1 逐项对一遍（`bd2-local-viewer` 的 `_test/run_all.mjs`
> 与 `native_mode` 在本轮均 PASS）。> 2026-10-05 补 Live2D 的「点画面选层」（R39）：用户报「live2d 没法用图层选择模式选图层」。
> 当初判定「做不到」的依据（Core 上没有 drawable→部件的映射）是**把 Framework 的
> `CubismModel` 当成了 Core** —— raw Core 上有 `drawables.parentPartIndices`。
> 现在几何候选 + **渲染确认**两层筛：前者给坐标，后者挡住「几何压着、贴图全透明」的
> 触摸命中区（实测 169 个采样点里 102 个会被纯几何选错）。验收 `_test/al_mode.mjs` §4e。
> 同日按用户实测三连报再修碧蓝航线那条 **pixi 路**（R40）：「spine 图层选不中 / 选中的层和
> 实际位置不符、不跟缩放平移 / 的里雅斯特原皮只渲染了场景 / 双击放大没了」。根因是同一个 ——
> 这条路**没有相机**，而此前实现都默认有：多层骨架（`_B`/`_M`/`_T` 三套）被「同 pose 只留
> 第一条」丢掉两层、命中与高亮框读的 `S.camera` 恒为 null、双击放大只认相机。验收 §8（7 条）。

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
| **R19** | **Lost Sword 的两层角色是「一套资产、两个骨架」：`<X>_B`（背层）与 `<X>_F`（前层）必须叠着画，别拆成两张卡。**LobbyUnit 里有 11 个角色是这种结构，两层的 atlas region 集合**互补**（实测 Lobby_Merlin：B 的 9 个 region 里只有 1 个在 F 里出现；Lobby_Kei 的 B 只有 1 个 region；Lobby_Morganlefay 反过来 —— F 只有 10 个 region，是前景药瓶）。所以单独打开任一层都是残的（B 单独打开 = 大头发 + 一片裙摆），而**不报任何错** —— 它「可播放」，只是缺一半。约定：①归组同样只发生在可见口径（与 R18 同一层）：**同一目录** + 同名 + `_B`/`_F` → 条目本体是 `_F`，背层挂在 `item.backLayer` 上、`_B` 从可见列表藏掉；只有 `_B` 没有 `_F` 时不归组；②**叠层渲染**：背层用**第二个 SpinePlayer**（`#playerBackHost`，z-index 0，在本体之下，`pointer-events:none`），它 `pause()` + `stopRendering()`，**时间轴与相机完全由主循环的 `syncBackLayer()` 驱动**（逐帧把本体的 `trackTime` 抄过去），两层因此永远同步；背层那套运行时按它自己的骨架头挑（R16）；③**取景用两层并集**（`computeStageBounds()`）—— 背层常比本体宽，只按本体量会把大头发切掉；④**离屏产出走同一条合成路径**：`paintBgAndSource()` 在主体之后补画背层（截图 / 帧序列 / WebM 都经过它），卡面缩略图同理 —— 但缩略图里两个播放器必须都设成**透明**（`alpha:true` + 透明背景），否则主体的不透明背景会把背层整个盖住（实测踩过）；⑤背层加载失败只丢背层，本体照常显示。 |

| **R20** | **打包资产（UnityFS / AssetBundle）在扫描前解包成标准三件套，且**两种宿主各有一套等价实现**。** NIKKE 的 mod 包（无扩展名、未加密、块压缩）里是 `TextAsset xxx.atlas` + `TextAsset xxx.skel`（**二进制** Spine 4.1）+ `Texture2D xxx`（RGBA32）；查看器只认标准导出，所以扫描前先解到根目录下的 `bd2viewer-nikke/<packFolder>/`（**无前导点**，WebView 加载不了 `/.dot-dir/`；需求 6 每包一文件夹）。约定：①**桌面用 Python + UnityPy**（`_tools/nikke_extract.py`，与 JCZX 共用 python 解析/venv 逻辑）、**安卓用纯 Java**（`jczx/NikkeAbExtractor.java`，复用 `UnityFs` + `PngEncoder`，零 Python 依赖）；②两侧都**包级并发 ≤ 10**（优先级队列，点开即优先；需求 1）+ 真实进度（需求 2）；一次扫描绝不允许卡死机器；③缓存与增量：按 `size + mtimeMs` 判断，源包删了就顺手清产出；缓存目录**只在 nikke 档可见**（否则 BD2 档会把抽出来的资产再摆一遍）；④**两边产物必须一致**（同一份对照脚本逐像素比：atlas/skel 字节相同、PNG 解成 RGBA 后逐像素相同 —— 安卓侧 PNG 压缩方式不同，字节不必相同）；⑤解不出来的包**不写半成品**，把原因放进 meta.errors 由前端提示（宁可报错也不写错图）。 |

---

## 6.1 i18n 是怎么接进来的（2026-09-26）
| **R21** | **Spine 3.x 的 JSON 骨架在加载前转换成 4.x 能读的形状，而不是拒收；二进制 3.x 仍然拒收。** 背景：JCZX 缓存里 135 个带骨架的目录有 **131 个是 3.8.99 导出的 JSON**，而查看器只有 4.0 / 4.1 / 4.2 三套运行时。3.x 的 JSON 被 4.x 运行时读时**不报错、只把值读成 undefined → NaN** —— 症状极具迷惑性：骨架能载入、骨头/插槽数量都对、动画列表也正常，但取景算出 NaN，播放器抛 `Animation bounds are invalid: <动画名>`。实测（455 骨 / 302 槽的交错战线 CG）：绑定姿势 100% 正常（0 根坏骨），**只有「应用动画」后 133 根骨头变 NaN**。差异共四处：①旋转时间轴 3.8 用 `angle`、4.x 用 `value`；②曲线写法 —— 3.8 是紧凑系数（`curve` 是数字，其余系数散在 `c2`/`c3`/`c4`），4.x 要 `curve:[cx1,cy1,cx2,cy2]`（缺省规则实测推得：cy1 缺省 = cx1、cy2 缺省 = cx2，正好还原出最常见的 ease-in-out）；③**4.x 的 curve 按分量分槽**（`readCurve` 里 `i = value << 2`）—— 2 分量时间轴要 8 个数、4 分量要 16 个，只给 4 个则第 2 个分量读到 undefined 又变 NaN；④插槽颜色时间轴 3.8 叫 `color`、4.x 叫 `rgba`。约定：转换只在**前端**做（`spineJson38to41()`，纯函数、可单测），产物包成 blob URL 交给播放器，**不动磁盘上的游戏原始文件**；四处建播放器的地方（主播放器 / R19 背层 / 缩略图主体 / 缩略图背层）共用 `spineJsonUrlFor()` + `applySkeletonCfg()`，blob 生命周期统一由 `disposePlayer()` 回收（缩略图那条路用自己的局部数组，因为它与主播放器并发）。`transform`（变换约束）与 `deform`（网格顶点变形）**明确不搬**：4.x 的字段名/挂载位置都不同，硬搬会让约束取值歪成默认值 1（比没有动画更歪），故整段删掉、退回绑定姿势取值 —— 代价是头发/布料的顶点变形动画丢失，骨骼驱动的部分照常。二进制 3.x 除碧蓝航线档的 Spine 3.8（pixi-spine，见 R30）外，仍在初始化前明确拒收，不要丢给 4.x 硬读。 |

| **R30** | **碧蓝航线档在播放页里播 Spine 3.8 二进制和 Cubism moc3，不另开运行时进程。** 4.x SpinePlayer 读不了 3.8 的 `.skel`。约定：①al 扫描额外为每个 `*.model3.json` 出一条 `kind:'live2d'`，贴图相对路径来自 `FileReferences.Textures`；`.model3.json` / `.physics3.json` / `.motions.json` / `manifest.json` 等不进 Spine 骨架桶。②归组 pose 带 `__spine` / `__l2d`，同一皮肤目录里两种资产不会互相盖住。③这两条播放路径不走 SpinePlayer 的 OrthoCamera；捏合只改播放框里 pixi 对象的 scale / position。④JSON 3.8 仍走 `spineJson38to41`，不进 pixi-spine。⑤**卡面必须「和正片同一个运行时渲一帧」，不许拿贴图文件顶。** 以前 Live2D 卡面贴 `relImages[0]`（Cubism 贴图集，眼睛/头发/身体拆开铺在一张图上）→ 卡片是零件图；Spine 3.8 二进制则在 `makeThumb` 里被「不支持的 Spine 版本」直接判失败 → 卡片永远是个占位。现在 `makeThumb` 在最前面分两路：`isLive2dItem()` → `makeLive2dThumb()`（`Live2DModel.from` → 摆 idle → `model.update(dt)` + `app.render()` 三次 → 销毁）、3.8 二进制 → `makeSpine38Thumb()`（复用 `loadSpine38Skeleton()`，`autoUpdate=false` + `fitPixiDisplay`）。三条路共用 `mountOffscreenPixiApp()` + `flattenThumbCanvas()` + `finishThumbCanvas()`（落盘/双格式只写一处）。两条约束：①离屏 `Application` 必须在 `finally` 里 destroy（WebGL 上下文数量有限）；②`relThumb` 只能是落盘过的 `thumb.png` —— 服务端 `appendAlLive2d` 不再拿 `relImages[0]` 顶，`builtinThumbUrl()` 对 Live2D 也只认 `thumb.png` 结尾。（**安卓侧直到 2026-10-04 才对上这条**：`ScanEngine.putLive2d` 一直是 `relThumb = 贴图[0]`，手机端 al 卡面长期显示 Cubism 的贴图集＝零件图。现在新增 `freshLive2dThumb` / `freshLive2dThumbSaf`，跟桌面 `freshThumbRel` 同一口径：thumb 不存在 / mtime 拿不到（SAF 常见为 0）/ 比模型或贴图旧 → null，交给前端离屏重渲，渲完 `writeThumb` 落盘，下次扫描直接命中。）⑥**Live2D 不许被挂两次 Ticker。** pixi-live2d-display 0.4.0 的 `set autoUpdate(true)` 就是一句 `Ticker.shared.add(onTickerUpdate, this)`，**不去重**；库的默认值又是 true，于是「创建 + setPlaying(true)」= 2 个监听 = 一帧累加两次 `deltaMS` = 动作/呼吸/物理一起 2 倍速（`pause()` 会把同 fn 同 context 的全摘掉，所以「暂停再播放」反而会变正常，第一次打开一直偏快，很难复现）。约定：创建时**显式** `{ autoUpdate: false, autoInteract: false }`；`play()` / `pause()` 只在**状态真的变了**时才去动 Ticker（shim 里自有 `autoOn` 标志，不要直接 `model.autoUpdate = true`）。缩略图那条路同样必须 `autoUpdate: false`。 |
| **R31** | **冷启动不许干等一遍扫描：上次的扫描结果存进 IndexedDB，先垫出来再慢慢扫。** 手机端 walk 一遍几万文件的目录要几十秒，缩略图也已经在 IndexedDB 里了 —— 两张缓存一起读出来，打开就是上次的样子、能翻能点。约定：①条目存在 `scan` 仓库（与 `thumbs` 分开，`重建缩略图` 清的是 thumbs），键 `\<rootId>|<mode>`；存档带上 `rootPath`，同一个 rootId 被重新指向别的目录时**不垫**（否则条目里的 dir / 绝对路径全是错的）。②缓存**只垫不替**：真扫描照常发、照常整包替换；用户按「重新扫描」（`force`）时完全不读缓存。③回填也要看 `scanSeq`（代次）与「同一个键一次会话只垫一次」，避免回填盖掉新一轮结果。④写缓存不 await（别挡渲染），超过 20000 条不存。⑤同一个 rootId+mode 的回填只做一次，后台轮询那种 force 重扫不参与。⑥原生侧分页从 40 条/趟提到 **200 条/趟** —— 每趟是「Java 拼 JSON 字符串 + JS 解析」，1625 条时少走 5 倍桥接往返。 |
| **R32** | **一条资产解析失败不许把整档扫描带崩；但也不许静默。** 2026-10-04：`freshThumbRel()` 的第 4 个参数（atlas 名）在 Live2D 这条路上传的是 `null`（Cubism 没有 atlas 文件），而函数里无条件 `path.join(dir, atlasName)` → `TypeError: The "path" argument must be of type string. Received null` → **整个 al 扫描 500、界面上一条都不出**。触发条件是「`*.model3.json` 同目录存在 `thumb.png`」—— 真实素材 1097 个模型里只有 19 个命中，所以症状是「有时能打开、有时整档空」，属于最难查的形状（同一目录换 `mode=bd` 扫又是好的，更容易误判成前端问题）。两层约定：①**可选的路径参数一律先判空**再进 `path.*`（`atlasName ? await mtimeOf(path.join(dir, atlasName)) : 0`）；②`appendAlLive2d` 拆成 `appendAlLive2d` + `appendAlLive2dOne`，逐条 `try/catch` 并 `console.error` 报警 —— **单条坏文件跳过、整档照常出**，但一定要吵（R26 的反面是「静默」，不是「安静」）。验收落点 `_test/format_check.mjs`（纯服务端、自包含，不碰真实素材），夹具必须同时造「有 thumb / 无 thumb / thumb 比模型旧」三种（mtime 用 `fs.utimesSync` 钉死，别指望两次写入之间时间会走）。⚠️ **空数组上的 `.every()` 恒真** —— 扫描 500 时它会假绿，所以判「一条都没认出来」必须另钉条数或加 `some()`（变异测试逮到过）。⚠️ 同类假绿的根源在素材镜像：`al_mode` 套件的镜像里没放 `thumb.png`，于是这条代码路径**从来没被执行过**。 |
| **R33** | **Live2D 切动作必须显式给 FORCE 优先级，否则被静默丢弃。** `model.motion(group, index)` 不传第三个参数时是 `MotionPriority.NORMAL(=2)`，而 pixi-live2d-display 的 `MotionState.reserveMotion(priority)` 在 `currentPriority >= priority` 时**直接返回 false** —— 已经有一个 NORMAL 的动作在播时，新的切动作请求**不报错、不 reject**，界面上的动画名照换，模型不动。用户症状：「切动画很多时候没有效果，偶尔灵一次」（灵的那次是上一个动作刚好播完、`currentPriority` 归 0）。实测（2026-10-04，绫波 皮肤10，`model3.json` 15 组动作每组 1 个文件）：连续切 12 条，默认优先级 **0/12 生效**，`FORCE(=3)` **12/12 生效**，画面指纹也 **6/6 各不相同**。约定：`loadLive2dMember` 里算一次 `MOTION_FORCE = PIXI.live2d.MotionPriority.FORCE || 3` 并传给每一次 `model.motion()`。⚠️ 离屏缩略图那条路（`makeLive2dThumb`）是**新建模型后立刻切 idle**，`currentPriority` 还是 0，所以不传优先级也能成 —— 但**别把两处口径写岔**，以后要改一起改。判据（`_test/al_mode.mjs` §4c，三条）：①`motionManager.state.currentGroup` 跟着点的那条走（改前 0/N）；②`motionManager.motionGroups[group].length > 0`（动作文件真的装上 —— 这个 Map 是**惰性加载**的，没接住就一直是 0）；③取 **3 条**样本要求每条都切到位且三张画面指纹互不相同（样本数必须大于「变异态下还能生效的条数」，实测变异态只有 2/8 生效，取 2 条会蒙过去）。⚠️ 画面指纹要 `renderer.extract.pixels()`（**不传参数** = 视口大小）；写 `pixels(model)` 会渲成「模型包围盒」那么大（实测 8285²）**超过 GPU 最大纹理尺寸 → 拿到空图 → 指纹恒等**。 |
| **R34** | **Live2D 的「图层」= Cubism 部件（part）**，Spine 那条 slot 路照旧。约定：①图层名来自 `coreModel._partIds`（**Core 的 `Model` 上没有 `getPartId`** —— 把原型枚举出来确认过），`slotNames` 因此不再是空数组，图层面板与数据同源。②显隐走 `setPartOpacityByIndex(i, 0)`：它会把该部件下面的 drawable 一起压到 0（实测 drawable opacity 1→0），且**不会被动作重算冲掉**；**隐藏前先记下原值**（部件的默认不透明度不一定是 1），恢复时还回去。③每帧在 `model.update` 包装里重放一次（R27 的教训），另外 `setLayerHidden` 里**立刻**落一次 —— 暂停时 `model.update` 不跑，只靠每帧重放会「勾了没反应」。④**「点画面选层」2026-10-05 补上了**（见 R38）：drawable → 部件的映射就在 **raw Core** 上（`drawables.parentPartIndices`），当初「Core 上没有 `getDrawableParentPartIndex`」的结论是把 Framework 的 `CubismModel` 当成 Core 了（那一版 Framework 确实没有这个方法，但它的 `_model` 就是 Core）。⚠️ al 档的 **Spine 3.8** 资产不走这条路，仍是 117 项 slot，两套口径都要保住。验收 `_test/al_mode.mjs` §4d（三条：列表非空且与数据同源 / 勾选后 opacity=0 且进 `S.hidden` / 取消后回到原值且移出 `S.hidden`）+ §4e（Live2D 点画面选层，见 R38），变异（`slotNames` 还原成 `[]`）§4d 三条全红。 |
| **R35** | **播放页 POSE / MOD 按钮右键 = 删除，但两者口径必须不同。** 姿势按**条目**删（只删它自己那一条），mod 按**目录**删（`modFolderItems()`：把这个 mod 文件夹下的全部文件都收进来）。为什么不能统一：① 姿势按目录删会**误删同目录的其它姿势** —— NIKKE 的 `<id>_00` / `_aim_00` / `_cover_00` 就在同一个目录里，按目录删等于把本体一起干掉；② mod 只删链上那一条会**留残渣** —— `jczxModDedupe()` 会把同一个 mod 的「解包缓存版」藏起来（drop）但它仍躺在磁盘上，一个 mod 目录里也常常同时放了好几个形态的 atlas，下次扫描它们又会冒出来。`modFolderItems()` 里**只在目标是 mod 时**才排除 `layerKind === 'source'`（零成本兜底）—— **原皮那格同样挂右键**：2026-10-04 用户用真实截图纠正过，`皮肤N/` 下面「原皮」与 `mod3`/`mod4` 是**平行**目录，按目录删原皮只会删掉 `原皮/` 自己，不会牵连任何 mod；当初那条无条件的 source 排除是**基于假设**（怕两者同目录），被真实数据否掉了。⚠️ 交给 `runDelete` 之前必须**先把条目的 `members` 摘掉**：`removeItemsOnDisk()` 对带 `members` 的条目会**摊开成全部成员**（那是「删整张卡」的口径，卡片菜单 / 批量选择走它），实测不摘的话删 al 的「原皮」会顺带把**同一张卡其它形态**的文件列进去（`皮肤1/mod3/...` 冒出来，而它根本不在原皮目录里）。删完必须 `nikkeViewFor()` + `layerViewFor()` **重算归组**（`members` / `mods` 挂在上一次归组结果上，不重算会出现「卡还在、切条上还列着刚删掉的项」），再重画两条 bar，最后 `resyncAfterLayerDelete()` 把当前在播的那层**扶正** —— 姿势和 mod 各退一步到**还活着**的那一个（当前 → 默认 → 第一个）。别只把 `currentMod` 置 null 就完事：右键删的往往正是**你正在看的那一格**，「退回去的默认那格」也可能刚被删，那样 `loadCurrent()` 会去读一个不存在的文件、界面直接报错。都会先过 `confirmDelete()`那道**带文件清单**的二次确认（`opts.title` / `opts.note` 让它说清是「删这个姿势」还是「删这个 mod 文件夹」）。验收 `_test/al_mode.mjs` §7（9 条）：**真实素材 + 把 `/api/delete` 拦下来只记录 payload** —— 真人的图鉴目录一个字节都不能动。⚠️ 断言必须能区分「条目口径」和「目录口径」，否则不敏感：给姿势那条往同目录塞一个「兄弟」条目、给 mod 链外塞一条同目录条目（实测**变异 A**：`modFolderItems` 退化成只删链上那条 → 2 条红；**变异 B**：姿势也按目录删 → payload 里当场多出那个兄弟；**变异 C**：原皮又变回无条件排除 source → 原皮只剩 1 条；**变异 D**：不摘 `members` → payload 里当场冒出别的形态的文件）。 |
| **R36** | **图层点选 / 高亮框必须按 `triangles` 判定与绘制，不能拿附件顶点当「一个多边形」。** 2026-10-04 定案的长留 bug「图层选择位置和实际位置不一致」：`pickLayersAt()` 对**所有**附件都用射线法（`isPointInPolygon`），而 `MeshAttachment` 的顶点是**按网格排布**的（不是环绕多边形）—— 把它当简单多边形算「内外」结果完全错，于是「点脸上选到衣服、点身体选到背景」，高亮框也把顶点依次 `lineTo` 连成一团乱线。实测（真实 JCZX 骨架、8116 个三角形重心）：**射线法漏判 1072 个（13.2%）**，重灾区是网格密集处（`04_hair_b_2` 68 次 / `01_chain` 59 次 / `01_thigh_r` 57 次）；离线对 3×3 网格采样 441 点，射线法错 **277 个**。约定：①`isPointInAttachment(px,py,verts,att)` —— 带 `triangles` 就逐三角形判定（`pointInTriangle` 三次叉积同号），否则（region 只有 4 点）才回退射线法；**先用包围盒粗筛**，网格动辄上千顶点，400 多个 slot 全遍历会卡手。②`drawOverlay()` 对 mesh **逐三角形填充**（描边会把每个三角形的边都画出来，太乱，所以 mesh 只填充），非 mesh 保持原来的「描边 + 填充」。③「世界 → 屏幕」抽成**唯一一份** `worldToClient()`（高亮框、命中判定、测试共用）；它与 Spine 官方 `OrthoCamera.worldToScreen(coords, screenWidth, screenHeight)` **逐位一致**（实测差 0px）——官方签名是三个参数（不是 `(coords, stage)`），且返回的 y 是「从下沿往上」，用的时候要翻。⚠️ 测试断言**必须挑有区分度的样本**：只取「射线法会漏」的点（`isPointInAttachment(p, verts, {})` 判 false 的），否则样本恰好落在两法一致的区域 → 假绿（实测第一版 24/24 全过、变异也不红）；改正后修复态 **30/30**、变异（退回射线法）**0/30**。另配一条纯函数断言喂**构造的 3×3 网格**（真实素材不一定含这种网格）。 |
| **R37** | **PC 右键的功能必须在触屏上有等价入口（长按），而且鼠标长按不算。** 播放页的姿势 / MOD 按钮右键删层，手机上没有右键 —— 按 R14 的既有约定（卡片就是「PC 右键 ≡ 触屏长按」）补上 `bindAltAction(el, fn)`：挂 `oncontextmenu` + pointer 长按（`ALT_HOLD_MS = 500`、`ALT_SLOP = 8`，与卡片那套靠齐）。三条硬约定：① **`pointerType === 'mouse'` 直接不起长按计时** —— PC 上按住不动是选文字/拖拽手势，不该弹删除窗；② 长按触发后，抬手那一下 `click` 必须**吃掉**（`altActionSwallowed()`，800ms 窗口），否则会顺手把姿势/mod 也切了 —— 这是最容易漏、用户最容易骂的一条；③ 触屏上要给按钮加 `user-select: none; -webkit-touch-callout: none`，否则浏览器先弹「复制/全选」，删除窗永远等不到。验收 `_test/al_mode.mjs` §7b（4 条）：触屏长按弹出 / 抬手不误切 / **鼠标按住不弹** / 手指挪开放弃；变异（去掉 mouse 判断 + 去掉 slop 判断 + `altActionSwallowed` 恒 false）对应**三条全红**。 |
| **R41** | **Live2D 动作里的 `PartOpacity` 曲线必须真的生效（框架默认把它丢了）——否则「同一部件的多套变体」全留着画。** 2026-10-05 用户截图：「爱宕 皮肤2 原皮 · `mail` 三只手」。根因不在我们的坐标链，而在**框架开关**：`CubismConfig.setOpacityFromMotion` 默认 `false`（见 `lib/cubism4.min.js`），此时 `CubismMotion.updateParameters` 走 else 分支把曲线值写进**同名参数**（`model.getParameterIndex('Part17')`）—— AL 的部件叫 `PartNN`、参数叫 `Param*`，两边对不上 ⇒ `-1 → continue` ⇒ **曲线被静默丢弃**，被它淡出的手/手臂变体一套都没淡出。爱宕 `mail.motion3.json` 实测 106 条 Parameter + **11 条 PartOpacity**（`Part17/20/22/24/27/28/30/32/35/38`）。修法：`enableLive2dPartOpacityFromMotion()` 在**每次建模型前**（`loadLive2dMember` / `makeLive2dThumb`）把开关置 `true`，并把状态挂到调试面（`__bd2viewer.live2dOpacityFromMotion()`）供测试断言。⚠️ 复现必须按**用户的操作顺序**：先让 `idle` 播一会儿再切 `mail`（部件的上一次不透明度会被继承，冷启动直接载入 `mail` 复现不出来 —— 我第一轮就是因此判成「没能复现」）。变异对照（关掉这个开关 = 把 `enableLive2dPartOpacityFromMotion` 提前 `return false`，2026-10-05 实测）：同一帧**手部可见 drawable 29→31**（变体叠着画），修好后 **8→10**；被压到 0 的曲线部件 0 个 → 7 个。验收 `_test/al_mode.mjs` §9（真值取自**动作文件本身**，Node 侧解析 `PartOpacity` 曲线 Id）：开关已开 / 至少 3 个曲线部件被压到 0（实测 7）/ 手部可见 drawable ≤ 16（修复前 29~31）。⚠️ 顺带记两条测试侧的坑：①§1 的「扫到 1 条 Live2D」在夹具加了第二份 Live2D（§9 的爱宕）后必然变红 → 计数改成「至少各一条」，并且 §1/§3/§4 取材要用 `pairSkelRel/pairL2dRel` **锁定夹具那一对**，否则测的模型会悄悄换成爱宕；②`/thumb\\.png$/i` 是写错的正则（正则字面量里 `\\` 是「反斜杠 + 任意字符」），以前因为 `relThumb` 恰好是 null 而没暴露。 |
| **R39** | **Live2D（Cubism）的「点画面选层」= 几何候选 + 渲染确认；高亮框与命中判定共用同一份坐标换算。** 2026-10-05 定案（用户：「live2d 没法用图层选择模式选图层，且选中的层要和实际图层位置一致」）。Live2D 的图层是**部件**（R34），三样东西都从 **raw Core** 拿：`parts.ids`（名字）、`drawables.parentPartIndices[i]`（这块网格属于哪个部件）、`drawables.renderOrders[i]`（**数值大的画在上面**）。约定：<br>①**坐标链**：`画布CSS像素 = worldTransform ∘ localTransform ∘ internalModel.getDrawableVertices(i)`，其中 `getDrawableVertices` 已把 core 顶点换成「原图像素空间、**y 向下**」（`x*ppu + W/2`、`-y*ppu + H/2`）。⚠️ 这条是**实测**出来的，别照渲染器源码推：把单个 drawable 的原始顶点整体 +1 个 core 单位，量屏幕「变化像素」的重心位移 → `kx = +ppu×world.a`、`ky = −ppu×world.a`；拿「渲染器内部链去掉 projection」（`centeringTransform` 不翻 y）去对撞渲染像素，命中率明显更低（24/169 vs 67/169）。⚠️ 别用 bbox 判断整链对不对：moc3 里的触摸命中区坐标能到 ±167 core 单位（可见区域才 ±15），整链 bbox 会被它们撑到画布外 10 倍，看着像「全错」。<br>②**光有几何不够**：这类模型有一批「`hasIsVisibleBit` 为真、opacity 也是 1，却一个像素都不画」的 drawable（触摸命中区在贴图里全透明），几何上还压在最上面 —— 只按几何选，点脸会选到 TouchHead（实测 169 个采样点里 **102 个**选错）。所以几何筛出候选（按部件归并、按渲染顺序自上而下）后，**再用真实渲染确认**：把这个部件临时压透明、渲染一帧、看这个像素变没变。这一条顺带把「被遮罩裁掉的部分」也挡掉了。实测代价（无头 SwiftShader、536 网格 / 71 部件、658×578）：几何 0.4–7.5ms + 确认约 20ms/层，整次点选 **150–350ms**；大头是 `gl.readPixels` 的 GPU 同步（单次约 4.5ms，而单帧渲染只要约 0.9ms），真显卡上会明显更快 —— 所以**别为了「省几帧」把确认砍掉**，那是拿正确性换本来就该由 GPU 承担的开销。<br>③**压透明必须压到 drawable 上**：`setPartOpacityByIndex(pi, 0)` 要等 Core 下一次 `update()` 才传导到 `drawables.opacities`，而确认要的是**立刻**见效（渲染器直接读 drawable 的）。两条都做才稳（`parts.saved` 是「用户手动隐藏」的账本，确认过程**不许碰**，自己存自己还）。<br>④**像素比较阈值取 0**：暗部常常是几层颜色几乎一样的图层叠着，压掉最上面那层底下那层颜色相近 → 阈值一大就判成「没画」，症状是点暗部**一点反应都没有**（实测 `dd > 8` 时整片暗部选不中）。渲染是确定性的，不画这个像素的层压掉它时像素**逐位相同**，所以 0 阈值不会误判。<br>⑤**兜底**：几何候选一个都没确认、但该像素**不透明** → 把几何栈整条交出去（宁可给用户最上层，也不要「点了没反应」）；像素是透明的才算「这儿没东西」，清空选中。<br>⑥**高亮框**：`drawLive2dOverlay()` 用与命中判定**同一个** `live2dVertsToClient()`，逐三角形填充（与 R36 的 mesh 口径一致，不描边）；两处各写一套换算，迟早「框和点选对不上」。<br>⑦**测试判据不许用应用自己的几何**（那会和它一起错）：`_test/al_mode.mjs` §4e 拿**真实渲染**当真值 —— 按渲染顺序从高到低二分地把 drawable 挪出画面，第一个「挪走就让该像素变透明」的就是该点最上层；再要求 ①点选结果 == 像素真值、②几何候选集合**必须包含**真值（把「坐标链算错」和「筛子太严」两类问题分得开）、③高亮框像素落在该部件「真正画出来的像素」上（覆盖率 ≥ 90% + 重心差 ≤ 8px）。实测（阿达尔伯特亲王 94 部件 / 658×578 视口 / 81 个采样点）：有像素 58 点 **58/58** 一致、几何候选漏真值 **0**、其中 **6** 个点的几何最上层≠真值（陷阱真实存在，这条断言不是假绿）。变异：把渲染确认去掉 → ①红；坐标链去掉 y 翻转 → ②红；高亮框换一条不翻 y 的换算 → ③红。 |
| **R40** | **碧蓝航线的 Spine 3.8 是「pixi 播放器」：多层骨架要归成一张卡叠着画，命中/高亮框/双击放大都必须走 pixi 自己的变换。** 2026-10-05 用户实测三连报（「spine 文件没生效」「选中的层和实际渲染位置不符、不跟缩放平移」「的里雅斯特原皮只渲染了场景」），根因是同一条：这条路**没有 `S.camera`**（缩放/平移直接改 pixi 显示的 `scale/x/y`），而此前所有实现都默认有相机。<br>①**多层骨架**：实测图鉴里 **16 组 `BMT` + 28 组 `BT`** —— 同一目录 `<X>_B`/`_M`/`_T` 是**三套骨架**（`_B` 只有 `BG-*` 槽位＝背景（实测的里雅斯特 `_3B` 仅 6 个槽位）、`_M` 中层、`_T` 109 个槽位＝人物），游戏里叠着画成一张图。它们的 `alInfoOf()` pose 键**完全一样**，于是旧的「同 pose 只留第一条」把 M/T 直接丢掉、留下的还是字母序最靠前的 B —— 卡片点开只有场景（用户报的「完全没有渲染人物」就是这个，与 Live2D 无关）。归组放在 `nikkeViewFor()` 的 AL 预处理里（**不能**放 `layerViewFor()`：那个集合只对 lostsword 生效）：代表取**最上面那层**（T>M>B）、`layerItems` 挂从下到上的成员表、其余层进 `alLayerSkip`（形态归组与 `buildJczxModChains()` 都要跳过，否则 T 会被当成「可切 mod」藏进 `modCardKeys`，卡片直接从可见列表消失）＋ `variantKeys`。渲染侧 `loadSpine38Member()` 按 `spine38LayerPlan()` 加载所有层、按 B→M→T 加进同一个 stage（后加的画在上面）、取景用 `unionPixiBounds()` 的并集、缩放/复位/动画/逐帧更新/隐藏**每层一起做**，任一背层失败只丢那一层（R19 ⑤）。删除走 `removeItemsOnDisk()` 的 `layerItems` 摊开（按 relAtlas 去重），不然卡片删了会留背层/中层的残渣。<br>②**命中与高亮框**：`pickPixiSpineLayersAt()` / `drawPixiSpineOverlay()` **直接用 pixi 的对象**——网格附件（`SpineMesh`）的 `vertices` 是骨架世界坐标、乘它自己的 `worldTransform` 就是屏幕坐标（区域附件用 localBounds 四角），所以缩放/平移/适配天然跟着走（pixi-spine 3.8 `settings.yDown = true`，不用再翻 y）。点选沿用 R39 的「几何候选 + 渲染确认」，另加三条实战判据：**剪裁附件（Clipping）不是图层**，候选阶段跳过；**基准像素透明时任何变化都不算「画」**（那是遮罩级联：藏掉遮罩会让被裁内容露出来 —— 实测点空白会误选 `lc2`）；**高亮框必须每帧重画**（`syncPixiOverlay()` 挂在 pixi ticker 上、暂停时也跑），不重画就停在旧位置，这正是「框不跟缩放平移」。⚠️ 同名槽位横跨多层是**两码事**：面板按名字列一行（勾选三层一起隐，刻意如此），但高亮框只框**点中的那一块**（`pickedSlotRefs`；从列表点选时没有实例信息才退回按名字框全部）。<br>③**双击定点放大**：`setupDoubleTapZoom` 原先只认 `S.camera`，pixi 播放器上双击**毫无反应**（用户报的「双击放大做没了」）。现在 `doubleTapZoom` 分叉出 `doubleTapZoomPixi()`：档位沿用同一份 `ZOOM_LADDER`（2.6 → 6.8 → 12.4，顶档再双击 `fitHome()` 还原），锚点用「落点在显示局部坐标里的位置」反算、**多层一起动**；`currentZoomRatio()` 也给 pixi 补了一条，⚠️ **方向必须与相机一致（数值越小画面越大）**，否则 `zoomRatio` / `zoomFactor` 两个指标在不同播放器上含义相反（实测踩过：第一版写成 scale/home，梯度全反）。<br>④验收 `_test/al_mode.mjs` §8（7 条）：归成一张卡且卡片在可见列表 / 三层都真在画（逐层藏掉画面都要变）/ 点选 == 真实渲染最上层（真值＝逐个藏槽位容器）/ 高亮框跟缩放且**罩住**该层像素（缩放后框比足迹大是正常的，漏掉才是错）/ 双击逐档 + 收尾还原 / **锚点漂移 0px**（用变换算，不靠像素猜）/ 勾选与取消勾选双向（旧 `hidePixiSlots` 只藏不回 —— 取消勾选后图层再也回不来；现在只恢复「自己藏过的」下标，别把 pixi-spine 自己设成不可见的空槽位翻出来）。相机那条路（BD2 / JCZX / Lost Sword）由 `_test/native_mode.mjs` §⑮ 继续守（本轮实测 8 条全绿）。 |
| **R38** | **资产类型的六段切换是下拉条；切模式不许重扫。** 两件事一起（2026-10-04）：① **下拉条**：六个 `.gm-btn` 并排在窄屏把标题行挤爆 → 换成 `<select id="galMode">`，`syncModeUI()` 只设 `value`、`onchange` 调 `setAssetMode`（状态仍然只有 `S.mode` 一个来源，R1）。手机上就是原生选择器，交互天然匹配触屏。测试判据随之改成 `option` / `value`（别再用 `.gm-btn[aria-pressed]`）。② **切模式不重扫**：以前是 `await scan(true)` —— force 会绕开**所有**缓存（R31 的 IndexedDB 垫底、服务端 15s 缓存、原生按 `(rootId,mode)` 分的桶），于是每次切回来都要重扫几十秒。现在有两层：`modeSnapshots`（会话内内存快照，键 `rootId|mode`，离开时 `snapshotMode()` 存、切回时**同步贴出**）＋ 照常发 `scan(false)`（让 R31 / 服务端 / 原生的缓存都生效，代替原 force 的另一个理由「Android 自动根按 mode 切目录」—— 那些缓存本来就是按 `(rootId,mode)` 分桶的）。⚠️ 已经有内容时（垫了快照或 R31）**不要上全屏 spinner**（只给顶部细进度条），否则看起来还是「又在加载」。⚠️⚠️ **但这个「不上遮罩」绝不能写成 `if (!S.items.length) setBusy(true, …)`** —— `setBusy` 除了切遮罩还负责置 **`S.busy`**，而 `S.busy` 是「扫描在飞」的**排重护栏**（解包轮询 `if (shouldScan && !S.busy)`、`unpackRescanNeeded` 的消费、导出那条 `if (S.busy) return` 全看它）。漏置会让轮询与手扫**并发**：2026-10-04 实测把 e2e / native_mode / ark_mode 拖成 `Runtime.evaluate 超时`，并让 scan_cache 的「垫出来时真扫描还在跑」假红。正确写法是 `setBusy(true, label, { overlay: !S.items.length })` —— `opts.overlay === false` 只隐藏 spinner，`S.busy` 照常置上（语义写在 `setBusy` 的 doc 里）。用户按「重新扫描」那条路仍然 `scan(true)`。验收 `_test/native_mode.mjs` 加「切回 BD2 的那一刻**就已经有内容**」（dispatch change 之后**不 await**，直接读 `state.items.length` 与卡片数）。⚠️ 附带保留一条**独立护栏**：安卓 `MAX_ITEMS` 2000 → **10000**、`MAX_DIRS` 4000 → **12000** —— al 实测已有 1711 条，2000 的余量太小，顶到就**静默截断**（桌面端没有这个上限，两端会不一致）。⚠️ 本条原有的 ③「al 静态图片」当天**已被用户叫停并完整撤回**（判据与坑保留在 `IMPROVEMENTS.md` 需求 18，撤回前实现在 `_scratch/pre_revert_*`）。 |

| **R22** | **解包轮询不许打断播放页。** 轮询（NIKKE / JCZX 各一条）每轮都可能 `scan(true)`，而 `scan()` 会挂全屏「扫描中…」遮罩 —— 用户正看着动画时会被反复盖住（2026-10-01 用户截图）。约定：轮询里**先看视图**，`viewMode !== 'grid' ` 时只置 `unpackRescanNeeded = true`（并把 `lastScannedDone` 原地不动），回到平铺页时由 `setView('grid')` 消费这个标记补扫。进度条与占位卡照常更新（它们不遮画面）。守它的断言在 `e2e`：临时挪开一个 JCZX 缓存条目的 `.stamp.json` 制造 pending，进播放页等 13 个轮询周期，断言遮罩一次没弹、`unpackPending` 为真、回列表后标记被消费。 |

---

## 6.2 扫描管道不许静默失败（2026-10-03）

| **R26** | **「扫描得出了结果」不等于「扫描是对的」：凡「元数据挂不上」这类管道级退化，服务端必须显式报警，不许静默。** 背景（2026-10-03 实测）：`walk()` 里向上搜索 `meta.json` 的循环有个守卫 `d.startsWith(rootPath)`，而配置里的 `roots[].path` 可能是用户手填的正斜杠 `C:/…`，`path.join` 拼出来的却是反斜杠 `C:\…` —— 守卫**第一轮就 false**，循环体一次都不执行。结果 499 条 Ark 资产**全部**退化成「没有角色名 / 没有稀有度 / 没有立绘 / 没有语音」，而界面**看起来一切正常**：列表不空、不报错、只是名字退回目录 id。这种「静默失败」的诊断成本极高——没有异常、没有日志、没有空列表，接手的人只能逐个猜测原因。约定四条：①**路径比较不许用裸字符串 `startsWith`**，一律走 `isInside(rootAbs, p)`（它两边都 `path.resolve`，并正确处理 `rel === ''`）；`path.relative` 内部自带 resolve 所以容错，**唯独裸字符串比较不容错**。②**在边界处归一化**：`scanRoot()` 里 `const rootPath = path.resolve(root.path)`，下游拿到的永远是同一种形式（不要把归一化推给每个使用点）。两层是**冗余**的——只回退任一层都会被另一层兜住，这是有意为之。③**管道自检**：`makeArkMetaCache()` 自带计数器（`report()` 给出 `lookups` / `probed` / `withMeta`），扫描结束时 `scanRoot` 据此算出 `metaHealth` 挂进响应；`items.length > 0 && itemsWithMeta === 0` 时判 `ok:false`，并按 `lookups === 0` 区分两种根因——`meta-search-never-ran`（搜索逻辑被守卫短路了）与 `meta-not-found`（搜了但目录里没有 `meta.json`，通常是素材根选错层），同时往 stderr 打一行 `[scan] ⚠` 并把排查方向写进提示里。④**自检本身要有元测试**：`_test/meta_health.mjs` 故意把上面两层防护一起改坏（变异测试），断言 `metaHealth.ok === false`、`code === 'meta-search-never-ran'`、`lookups === 0`、stderr 有报警且提示里点名 `rootPath` —— **只断言「正常时能读出中文名」是不够的**，那证明不了坏了会有人告诉你。它已接进 `run_all` 且排在最前（这条红了意味着「以后再出静默失败也没人报警」，优先级最高）。**推论**：这条是通用模式，不只针对 Ark。任何「按目录结构推导元数据」的管道，都要能回答「到底去查过没有 / 查到几个」，并在「该有却一个都没有」时喊出来。 |

## 6.3 档位默认图层可见性（2026-10-03）

| **R27** | **jczx 档里名字含 `hexie` / `tape` 的图层，进播放页时默认关闭 —— 播放页与离屏缩略图两条路都要关。** 背景：交错战线的骨架里有一批补丁图层（实测 slot 名 `hexie_smog_61`、`hexie_light`、`tape_1`、`B_tape_20`、`renwu_booktape_4`、`cheattape_1` 等），默认全开会把角色盖住（实测：关掉规则后整个人被 `hexie_smog` 白雾盖住）。实测素材：710 个骨架里 13 个含 hexie slot、57 个含 tape slot；打开 `source/角色/10010/…alps03…` 时 352 个槽里有 30 个命中。约定：①判据只有**一份** `isDefaultHiddenLayerName()` —— 槽位名子串匹配（`JCZX_DEFAULT_HIDDEN_LAYERS = ['hexie','tape']`，大小写不敏感），**不改骨架数据、不写盘**，用户想看在图层列表里自己勾；②**播放页**：`applyDefaultHiddenLayers()` 把命中名加进 `S.hidden`，调用点必须在 `applySkin()` **之后** —— `applySkin` 内部的 `setSlotsToSetupPose` 会 `S.hidden.clear()`（见该函数），早于它设置会被**静默清掉**，症状是「规则看起来没生效」；③**故意不进 `S.hiddenStack`** —— 那是「用户手动隐藏」的撤销栈（U 键撤销的是用户按的动作），默认隐藏不该被 U 翻出来；④**离屏缩略图**（`makeThumb`）走的是另一条路：离屏播放器不经 `S.hidden`、也没有逐帧回调，所以用 `hideDefaultHiddenSlots(skeleton)` 直接把命中 slot 的 `color.a`/`darkColor.a` 清 0，并且**每次 `drawFrame` 前都要重设一次**（动画的 slot 颜色时间轴会把 alpha 写回去，只设一次的话卡面照样带出补丁层）。⑤切 mod / 切形态都会走 `loadCurrent()`，所以规则对 mod 层同样生效。守它的断言在 `jczx_mode`（9 条）：**先在本地读盘**找一个骨架内容真含 hexie/tape 的**可见**条目（不写死角色 id，素材换了也不失效），打开后断言「命中的全被关掉 + 没有误伤别的图层 + 图层列表里这些行的勾是空的」；缩略图那条路**不能靠比对两张缩略图**（两次渲染的动画时刻不同，图必然不同，差多少都说明不了问题），改用 `thumbLayerHide` 计数器断言「真的执行了（calls/slots > 0）」且「把 `JCZX_DEFAULT_HIDDEN_LAYERS` 清空后归零」。两条都验过退回修复会 FAIL。 |

## 6.4 图层点选（2026-10-03）

| **R29** | **全屏时姿势和皮肤必须还能切：侧栏被藏起来，就由画面上的全屏条补一份，**两个容器填同一份数据、走同一套切换函数**。** 全屏时侧栏不可见，只有点动画的条，姿势/皮肤就点不到了（`BD2Viewer-fs-pose-skin.md`）。约定：①`#fsExtra` 里只放**空壳**（`#fsPoseBar` 姿势按钮容器 + `#fsSkin` 下拉），按钮/选项一律由 `renderPoseBar()` / `renderSkinSelect()` 填 —— **禁止写第二套切换逻辑**（全屏按钮的 `onclick` 只调 `switchPose(m.pose)`；下拉的 `onchange` 只调 `applySkin(name)`）。②「下面一个」的口径按文档，但**造按钮要造两个真按钮**：`cloneNode(true)` **不会带走 `onclick`**（它是属性不是 attribute），用克隆会得到点不动的按钮。③`syncFsExtra()` 是显隐的**唯一口径**：不在全屏 / 全屏文件列表开着（会盖住列表）/ 既没多姿势也没多皮肤 → 整条藏；只有其中一种 → 只显示那一行。调用点：`setFullscreen`、`toggleFsFiles`、`updateFsLabels`、`renderPoseBar`、`renderSkinSelect`、`resetMeta`（`resetMeta` 还要**清空** `#fsSkin`/`#fsPoseBar`，否则切资产的空窗期留着上一个角色的按钮）。④淡出**跟顶栏、底栏同一套计时**（`wakeFsBar()` 里加 `#fsExtra`），不另做一套；「只看画面」（`body.is-cleanui:not(.fs-reveal)`）时和顶底栏一起藏。⑤`applySkin` 成功后把**两个下拉**都设成同一个值（选项里还有才设），失败只 `showError` 不动另一个。⑥桌面全屏同一套 DOM，不是只在 APK 里显示。**顺带修**：R27 的默认遮挡层要在 `applySkin` 里**重新关一次** —— 切皮肤会重建 slot 颜色，否则切一次皮肤 `hexie`/`tape` 就回来了。 |
| **R28** | **再次点选同一个图层时，选中改到它下面一层；第三次及以后继续往下。** 这是图像编辑器的通感习惯（参考用户需求 2026-10-03）。约定：①**两个入口都要**——「图层列表的行」与「模型上直接点选」，语义一致但**「下面一个」的口径不同**：列表按**显示顺序**（`layerNamesInOrder()`，与列表渲染共用同一份，别各写各的）、模型按**该点的命中栈**（`pickLayersAt()` 返回绘制顺序从上到下的全部命中层）。所以 `pickLayerAt()` 只是 `pickLayersAt()[0]`；②钻取锚点：列表用 `list:<行名>`，模型用 `model:<最上层名>`（不看像素、不限时间；手指挪开几个像素仍算同一层）；③**换锚点归零**，且**换资产/换骨架时必须 `resetLayerPickMemory()`**（在 `resetMeta()` 里调），否则换了图还按旧 key 往下数；④到底了就 `clamp` 在最后一层（不静默取消选中）。**注意行为变化**：点已选中的那一行不再立刻取消选中（会改选它下面一层），要取消选中请点别的行或按 Esc。守它的断言在 `_test/layer_pick.mjs`（7 条，需 `BD2_JCZX_ROOT`）：列表连点两/三次断言逐级下移、换行归零；模型在「命中栈 ≥ 2」的螺旋搜索点上连点两次断言穿透到栈里第二层。 |

## 6.5 交错战线「整理树」布局（2026-10-03）

| **R29** | **jczx 档必须同时认「图鉴发布包原布局」与「就地重组后的整理树」两种形状。** 背景：用户 2026-10-03 明确要求把 `source\|mod1\|mod2/角色/<ID>/…` **就地重组**成 `角色/<ID>__<中文名>/<姿势>/{原图\|mod-<id>__<包名>}/…`，理由是「按层堆放完全没法手工管理」（图鉴 App 因此失效、索引作废，用户已知情并接受）。约定：①`jczxLayerOf()` 认**三种**布局 —— 原布局（贴根 `source\|modN`）、解包缓存、整理树；整理树的判据是**第一段必须是 `角色`/`画册`**（`JCZX_TREE_CATEGORY_RE`）+ 必须有「姿势槽位」段（`JCZX_TREE_SLOT_RE`：`原图` 或 `mod-<id>[__包名]`）。刻意同样要求「贴根」，免得把用户普通素材里恰好叫 `角色` 的文件夹当成图鉴包。②整理树的 mod 目录名**不带层号**（`mod-<id>__<包名>`，层号是图鉴打包时的人工分层，对按角色管理没意义），所以要用 `readJczxModLayerTable()`（读 `data/mod_runtime_index.json` 的 `runtimeRoot`）把 `mod1`/`mod2` **找回**，否则副标题退化成笼统的「mod」、mod 链排序也会乱；读不到就退化（`layerIndex:500`），**不算错误**。③jczx 的两份辅助表打成 `jczxAux = { names, modLayer }` 一个参数穿过 `walk()`，别再加第 9 个位置参数。④**图鉴发布包的 `data/`（尤其 `mod_runtime_index.json`）必须留在原地**，它是①②两套布局的共同依赖 —— 重组脚本只动 `source\|mod1\|mod2/角色/…`。⑤重组工具 `_tools/jczx_reorg.mjs`（`--backup` / `--plan` / `--apply` / `--undo`）：**先备份再搬**，备份用**硬链接镜像**（同盘 → 0 额外空间、原路径全保留），每搬一个文件写一行 `_reorg_log.tsv`，`--undo` 直接按日志 rename 回去；`--apply` 在没有备份目录时**拒绝执行**。实测：6794 个文件 0 失败，重组前后 `itemCount` 完全一致（1625），中文名覆盖不变（1076/1625），画册仍在原布局且照常识别。⑥⚠️ 搬完留下的**旧空壳目录**（1285 个空目录）在本机被进程句柄锁住（`EPERM`，提权也解不开），属纯装饰问题，需手工清理。
⑦**画册侧同样重组，但不建「姿势」层、目录名只用 `cgN`**（用户 2026-10-03 明确要求）：实测 56 个 archiveId 里 **52 个只有 1 个 bundle**（CG 就是一张画，没有姿势），那一层纯属多余 → 形状是 `画册/<cgN>/{原图\|mod-<id>__<包名>}/…` + `<cgN>/meta.json`（`jczxLayerOf` 用 `findIndex` 找槽位段，所以「槽位在第 2 段还是第 3 段」都能认）。⚠️ source 侧**必须递归**：实测 `cg42` 是 `runtime/variants/*.png`（多一层），只走一层会漏文件；`variants/` 这类内层子路径**要保留**，摊平会丢信息。
⑧槽位目录里**直接放文件**：mod 的 `runtime/` 一层用 `--flatten` 上提（实测 1081 个目录 / 3444 个文件）。理由：每个 mod 恰好一个 `runtime/`，留着只是多一层要点开，且与同级的 `原图/` 不一致。
⑨脚本**必须幂等**：`--apply` 前先过滤掉「源文件已不存在」的搬运项，所以可以反复跑（第一次搬完角色，第二次只会处理画册），不会报几千条「缺源文件」。 |




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
| `_test/bundle_check.mjs` | 34 | id 一致性、单文件 HTML 可跑、标题与内联样式、无控制台错误、**三套 Spine 运行时（4.0 `spine40` / 4.2 `spine42` 全局名、互不相同、产物里都内联、真实骨架不被误判 —— 守 R16）**、**Spine 3.x→4.x JSON 转换器 7 条纯函数断言（`angle`→`value`、紧凑曲线按分量展开、2 分量要 8 个数、`color`→`rgba`、`transform`/`deform` 丢弃、不残留 c2/c3/c4、非 3.x 返 null —— 守 R21）** |
| `_test/e2e.mjs` | 53 | 加载、相机取景、图层、截图/导出、**PC 侧入口（12 条：播放页「返回列表」回平铺 + 右键复制绝对路径，路径用 Node 侧 `path.join` 独立算一遍并用 `fs.existsSync` 证明真在硬盘上 —— 守 R14/R15）**、**重叠扫描（2 条：先发的慢轮不许顶掉后发的结果、`rootPath` 不许与 `rootId` 脱节 —— 守 R17）**、**真实素材专项（13 条，素材不在自动跳过）：多皮肤骨架的 default 垫底合成、NIKKE 归组 + 姿势切换真渲染（守 R18）、**Lost Sword 两层角色的叠层渲染 + 时间轴逐帧同步（守 R19）**、**解包轮询不打断播放页（3 条：临时挪开一个 JCZX 缓存条目的 `.stamp.json` 制造 pending，进播放页等 13 个轮询周期 → 遮罩一次没弹 / 待补扫标记为真 / 回列表后被消费 —— 守 R22）** |
| `_test/native_mode.mjs` | 192 | 假桥下的整条原生通路：拖动、长按、批量删除、**㉒ 箭头语义**、**㉓ 返回键分层**、**㉔ 首屏不闪**、**㉔ 语言切换（7 条）**、**㉕ 资源文件搜索（5 条）**、**㉖ 资产类型切换（7 条，含 R13 的 mode 传参）**、**㉗ PC 入口在触屏下让位（2 条，含 ⊞ 不被顶掉）**、**㉘ NIKKE 模式（6 条：四段开关、mode 传到原生层、4 原始条目归成 NIKKE 卡且 npc 过滤、成员表、姿势条显隐、切回复原 —— 守 R18）**、**㉙ 两层角色（4 条：`_B` 不单独成卡、backLayer 挂对了、背层 host 建起来 + 副标题标注、切回复原 —— 守 R19；叠层渲染本身由 e2e 在真实素材上覆盖）** |
| `_test/delete_api.mjs` | 12 | 真删磁盘（自带临时根目录，绝不碰用户 mods） |
| `_test/format_check.mjs` | 37 | 资产命名约定多模式（`bd` / `lostsword` / `nikke` / `jczx`）：各套规则互不串味、骨架三级级联、`thumb.png`、`.atlas.bytes` 的 MIME、缓存按 `(root,mode)` 分离、删除含 thumb（自带临时根目录）、**nikke 模式（服务端按 bd 规则认文件 + 独立缓存键）**、**Lost Sword 两层角色（服务端照旧返回 `_B`/`_F` 两个条目 —— 守 R19）** |
| `_test/bundle_firstpaint.mjs` | 7 | **产物级**：`app.bundle.html` 首屏就是资产页、无外链、深链仍进播放页 |
| `_verify_apk.py` | 4+2 | 三方 sha1 一致、`screenOrientation=13`、`configChanges` |

合计 341 项。其中**不依赖任何真实素材**的（可以在别人的机器上全绿）是
`manifest_check` / `delete_api` / `format_check` 三个 —— 它们自造临时根目录。
(e2e 的真实素材专项 13 条需要本机有对应素材（多皮肤 Elin / NIKKE c022 / Lost Sword 两层角色），
重叠扫描 2 条需要两个大小不同的根目录；native_mode 的两层角色归组用合成数据、不需要真素材 ——
不满足条件的都判 PASS 并标注「跳过」。)

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
| [`../docs/AL-PLAYBACK.md`](../docs/AL-PLAYBACK.md) | 碧蓝航线档已落地的扫描/播放，以及缩略图、Live2D 倍速两个未修问题的思路 |
