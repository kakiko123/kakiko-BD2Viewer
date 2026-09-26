# kakiko-BD2Viewer — 架构与分层复盘

> 复盘日期：2026-09-23 · 基线：`public/app.js` 4019 行 / 161 个顶层函数 / 8 个 `render*` 函数
> 触发原因：连续三处 bug（首页多出四个按钮、旋转锁定失效、返回键直接退出软件）指向**同一个病根**——
> 同一件事的"真相"存在两处以上，谁改都得靠记性。这份文档把病根写成规则。

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
  │  S（会话） · filters（可见性） · sortState（顺序）            │
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

### 5.1 `app.js` 是 4019 行单体
- 现状：161 个顶层函数、共享一堆模块级 `let`（`S`、`sheetOpen`、`fsMode`、`selectMode`、`viewMode`…）。
- 为什么现在不拆：`app.js` 被 `bundle.mjs` 内联进一个 `<script>`，走的是**全局脚本**语义而非 ES module。
  拆文件要同时改动打包器、`sync_assets` 的 FILES 列表、APK 资源加载与全部测试的加载方式——
  一次"为了好看"的重构会把当前所有绿色测试变成风险面。
- 拆分边界（真要拆时按这个切）：`state` / `render` / `nav` / `host-bridge` / `bind`，与 §2 的分层一一对应。
- **触发条件**：① 需要两人以上同时改 `app.js`；② 单次改动引发的回归超过 3 处；
  ③ 引入构建期模块化（esbuild/rollup）那一刻，顺手切分。

### 5.2 `NATIVE` 分叉有 16 处
- 其中约 6 处是"桌面没有这个 API"的保护（`requestFullscreen` 等），10 处是真正的数据源分叉
  （扫描、删除、导入、配置、存储诊断）。
- 理想形态是一个 `Host` 适配器接口（`scan/delete/import/roots`），前端不认 `NATIVE`。
- 触发条件：出现**第三种**宿主（比如再包一层 Electron）时立刻抽，否则两路分叉的可控性还行。

### 5.3 `index.html` 143 个元素 id 被 `$()` 直接取
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
| **R6** | 资产导航只有一个入口：`switchItem(±1)`；动画导航只有一个入口：`switchAnimation(±1)`。**四组箭头各归其位，不许再对调**：`#stagePrev/#stageNext`（画面两侧，大而易按）→ 切**动画**；`#mBack/#mFwd`（底部快捷条 ◀◀/▶▶）→ 切**资产**；`#fsPrevFile/#fsNextFile`（全屏顶栏）→ 切**资产**；`#fsPrevAnim/#fsNextAnim`（全屏底栏，兼音量键）→ 切**动画**。推论：`syncStageNav()` 的显隐条件看的是**动画数**（`S.animations.length > 1`），不是资产数 —— 改错就会「箭头在但点了没反应」或「该显示时反而不显示」。 |
| **R7** | 「当前在哪一层」的知识只属于前端 `handleBack()`；宿主只问不猜。 |
| **R8** | 异步确认类弹窗必须留一个可被 `handleBack()` 调到的取消入口（如 `mask.__cancel`），否则 Promise 会挂住。 |
| **R9** | 数据源分叉只在 `NATIVE` 的既有分叉点，不新增；新增需在本文件登记。 |
| **R10** | 对外调试/测试面只有 `window.__bd2viewer`。新增能力先挂这里，不要在测试里摸内部变量。 |
| **R11** | **所有用户可见文案必须过 `t()`。** 判定标准是「会不会进到用户眼睛」——写进 `showError()`、`toast()`、`textContent`、`title`、`placeholder`、`alert`、`prompt` 的都要包；只进 `console` / 内部日志的可以留中文。三种用法：①静态元素用 `data-i18n` / `data-i18n-html` / `data-i18n-title` / `data-i18n-ph` / `data-i18n-aria` 属性；②JS 生成的走 `t('中文原句')`，**中文原句就是 key**（中文模式下恒等返回，零回归）；③带变量的用 `t('已删除 {n} 个', { n: 5 })`，占位符是 `{name}`。含 `<b>`/`<br>` 的整条用 `data-i18n-html` 或 `innerHTML`（用 `textContent` 会把标签抹掉）。查不到就原样返回中文 —— 不显示 key、不崩。 |
| **R11.1** | **有两类中文「本来就不该翻译」**：①**用户数据**（目录下拉里的根目录名 `手机存储 /BD2Viewer`、资产目录名）；②**专名/自称**（语言选择器里的「中文」，英文界面下也必须写「中文」）。它们由 `markKeepText()` 打上 `data-i18n-keep`，**不改内容、只做标记**。用途是让「英文界面不许残留中文」这类测试能区分「漏包 `t()`」和「本来就该是中文」——否则每加一个数据型节点都要去改测试。判定口诀：**这段文字是给人看的，还是给人读的数据？** |
| **R12** | **`#dropText` 是两段结构，不许整体赋值。** 它里面是「主文案 span + `#pickFiles` 链接」，`$('dropText').textContent = ...` 会把链接节点删掉，之后既点不了、切语言也回不来。改它一律走 `setDropText(s)`（只写第一个 span）或 `applyLang()`；还原走 `dropTextDefault()`。 |

---

## 6.1 i18n 是怎么接进来的（2026-09-26）

**为什么要「中文原文即 key」**：这个项目里中文原文本来就是唯一标识，
再另起一套 `nav.assets` 这类符号 key 就多了一份必须手工同步的映射表 ——
而「同一件事的真相存在两处以上」正是本项目反复出 bug 的病根（见 §3）。
现在中文模式下 `t('资产')` 恒等返回 `'资产'`，等于没接 i18n，**中文侧零回归**。

**翻译表必须在 `app.js` 内部**：`_tools/bundle.mjs` 只内联
`app.js` + `lib/spine-player.js` + `lib/jszip.min.js` 三个文件。
拆出独立的 `i18n.js` 会同时破坏「零外链」自检和 bundle 脚本。
同理，`app.js` 被内联后整体包在 IIFE 里且带 `'use strict'`，
顶层不要写 `const spine` / `JSZip` / `S` 这类会和库在 window 上撞名的绑定。

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

## 7. 验证矩阵

| 套件 | 项数 | 守住的规则 |
|---|---|---|
| `_test/manifest_check.mjs` | 6 | 旋转锁定（`fullUser`）、`configChanges`、`minSdk` |
| `_test/bundle_check.mjs` | 18 | id 一致性、单文件 HTML 可跑、标题与内联样式、无控制台错误 |
| `_test/e2e.mjs` | 24 | 加载、相机取景、图层、截图/导出 |
| `_test/native_mode.mjs` | 167 | 假桥下的整条原生通路：拖动、长按、批量删除、**㉒ 箭头语义**、**㉓ 返回键分层**、**㉔ 首屏不闪**、**㉔ 语言切换（7 条）**、**㉕ 资源文件搜索（5 条）** |
| `_test/delete_api.mjs` | 12 | 真删磁盘（自带临时根目录，绝不碰用户 mods） |
| `_test/bundle_firstpaint.mjs` | 7 | **产物级**：`app.bundle.html` 首屏就是资产页、无外链、深链仍进播放页 |
| `_verify_apk.py` | 4+2 | 三方 sha1 一致、`screenOrientation=13`、`configChanges` |

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
