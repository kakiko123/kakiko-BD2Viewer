# 技术说明

面向想了解「这东西是怎么搭起来的」的人。只想用起来的话看 [`README.md`](../README.md) 就够了。

| 相关文档 | 内容 |
|---|---|
| [`BUILD.md`](BUILD.md) | 构建、签名、clone 后跑不起来的排查清单 |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | 改代码 / 写测试的注意事项 |
| [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) | 已知而未处理的问题 |
| [`../bd2-local-viewer/ARCHITECTURE.md`](../bd2-local-viewer/ARCHITECTURE.md) | ★ 分层调用链、18 条不变量、验证矩阵 —— **改代码前先看它** |

---

## 1. 技术栈

刻意做得**几乎没有依赖** —— 这是能把它塞进 APK 且长期不用维护的前提。

### 1.1 前端（`bd2-local-viewer/public/`）

| 组件 | 作用 | 版本 |
|---|---|---|
| 原生 JS（单文件 `app.js`） | 全部界面逻辑。**没有框架、没有构建步骤、没有 npm 依赖** | 约 4300 行 |
| [Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes) `spine-player` | 解析 `.atlas` / `.json` / `.skel` 并渲染（WebGL）。**两套并存**：4.1.55 给 BD2 / Lost Sword，4.0.31 给 NIKKE | 4.1.55 + 4.0.31 |
| [JSZip](https://github.com/Stuk/jszip) | 导出帧序列时打包成 zip | 3.10.1 |
| 原生 HTML + CSS | 布局与主题 | — |

三个库以**发行版文件**的形式直接放在 `public/lib/`（不用 npm 装，也不用打包器），理由见 §4.3。
注意 `package.json` 的 `dependencies` 里**不再列 spine-player** —— 它是随仓库分发的产物，
不是构建期依赖（列一个版本号反而会让人以为另一个版本没被覆盖）。

### 1.2 桌面宿主

| 组件 | 说明 |
|---|---|
| Node.js 内置模块 | `server.mjs` 只用 `http` / `fs` / `path` / `net` 等内置模块。**运行期零依赖** |
| 职责 | 静态托管 `public/`；扫描配置里的 `roots`；用 `/spine/<rootId>/<rel>` 把本地文件喂给浏览器 |

### 1.3 Android 宿主

| 项 | 值 |
|---|---|
| 语言 / 构建 | Java 17，Gradle 8.7 + AGP 8.5.2 |
| minSdk / targetSdk / compileSdk | 26 / 34 / 34 |
| `androidx.*` | **不使用**（`android.useAndroidX=false`）。纯手写 Activity + WebView |
| 组成 | `MainActivity`（壳、全屏、返回键、文件/目录选择）、`NativeBridge`（JS 桥）、`ScanEngine`（扫描/删除/导入）、`Host`（`shouldInterceptRequest` 里消化所有资源请求）、`KeepAliveService`（前台服务保活） |

### 1.4 测试与工具（`bd2-local-viewer/_test/`、`_tools/`、`tools/`）

| 组件 | 说明 |
|---|---|
| 无测试框架 | 测试是普通 Node 脚本，通过 CDP（Chrome DevTools Protocol）驱动无头 Chrome |
| `_test/cdp.mjs` | 自己写的 ~110 行 CDP 客户端（用 Node 22 内置的 `WebSocket`） |
| `_tools/bundle.mjs` | 把 CSS/JS 内联成单文件 `app.bundle.html` |
| `_tools/sync_assets.mjs` | 把产物同步进 APK 的 `assets/web/`，并比对 sha1 |
| `tools/verify_apk.py` | 拆开 APK 验证：资源三方 sha1 一致、清单里 `screenOrientation=fullUser` |

---

## 2. 项目结构

```
.
├── README.md
├── LICENSE                       # MIT
├── THIRD-PARTY-NOTICES.md        # ★ 第三方许可声明，Spine 许可要求它随分发走，不可删
├── .gitignore
│
├── docs/
│   ├── BUILD.md                  # 构建说明（含「别人 clone 后跑不起来」的排查清单）
│   ├── DEVELOPMENT.md            # 开发说明：测试怎么写、改代码的注意事项
│   ├── TECHNICAL.md              # 本文件：技术栈 / 结构 / 实现思路
│   └── KNOWN-ISSUES.md           # 已知而未处理的问题
│
├── tools/
│   ├── build_apk.bat             # 一键：bundle → gradlew assembleDebug → verify
│   └── verify_apk.py             # APK 复验（三方 sha1 + 清单）
│
├── bd2-local-viewer/             # 前端（唯一一份）+ 桌面宿主
│   ├── server.mjs                # 桌面服务：静态托管 + 扫描 + /spine 取文件
│   ├── start.bat                 # Windows 双击启动（纯 ASCII，见 DEVELOPMENT.md §6.1）
│   ├── package.json
│   ├── viewer.config.example.json  # 配置示例 → 复制成 viewer.config.json
│   ├── ARCHITECTURE.md           # ★ 分层调用链 + 18 条不变量，改代码前先看
│   ├── public/                   # ← 前端源码全在这
│   │   ├── index.html
│   │   ├── app.js                # 全部逻辑（单文件）
│   │   ├── styles.css
│   │   ├── app.bundle.html       # 由 bundle.mjs 生成（APK 用）
│   │   └── lib/                  # 两个第三方库的发行版文件
│   ├── _tools/
│   │   ├── bundle.mjs            # 内联打包
│   │   └── sync_assets.mjs       # 同步到 APK assets
│   └── _test/                    # 测试与开发脚本（无框架，纯 Node）
│       ├── run_all.mjs           # ★ 一条命令跑全部
│       ├── cdp.mjs               # 极简 CDP 客户端
│       ├── manifest_check.mjs    # 清单静态检查
│       ├── bundle_check.mjs      # 单文件产物自检
│       ├── bundle_firstpaint.mjs # 产物级首屏自检
│       ├── e2e.mjs               # 端到端功能
│       ├── native_mode.mjs       # 假桥模拟 APK 环境（最全的一套）
│       ├── delete_api.mjs        # 真删磁盘 + 路径越界
│       ├── format_check.mjs      # 资产命名约定双模式（bd / lostsword，自带临时根目录）
│       ├── shot_native.mjs       # 给自己生成本地界面截图（不进仓库）
│       └── diag_*.mjs 等         # 开发期一次性诊断脚本，可无视
│
└── bd2-android/                  # Android WebView 壳
    ├── settings.gradle
    ├── build.gradle
    ├── gradle.properties         # 与机器无关的配置（别把代理/口令写这里）
    ├── gradle.local.properties.example  # 签名凭据示例 → 复制成 gradle.local.properties
    ├── gradlew / gradlew.bat / gradle/wrapper/   # Gradle Wrapper（不用自己装 Gradle）
    └── app/
        ├── build.gradle
        ├── proguard-rules.pro    # 当前未启用 R8，但规则先备好
        └── src/main/
            ├── AndroidManifest.xml
            ├── java/com/kkk/bd2viewer/
            │   ├── MainActivity.java      # 壳、返回键分层、全屏、文件/目录选择
            │   ├── NativeBridge.java      # window.BD2Native 的实现
            │   ├── ScanEngine.java        # 扫描 / 删除 / 导入 / 目录诊断
            │   ├── Host.java              # https://bd2.local 下的请求本地消化
            │   └── KeepAliveService.java  # 前台服务保活
            ├── res/
            └── assets/web/          # 由 _tools/sync_assets.mjs 同步进来（勿手改）
```

> `app/src/main/assets/web/` 里是**生成物**。要改前端请改 `bd2-local-viewer/public/`，
> 然后跑 `_tools/sync_assets.mjs`。直接改 assets 会在下次构建时被覆盖。

> **目录布局是硬约束**：`syncWeb` 用的是相对路径 `../../bd2-local-viewer/public`，
> 所以 `bd2-android/` 与 `bd2-local-viewer/` **必须并列**。

---

## 3. 环境要求

| 用途 | 需要 |
|---|---|
| 只看桌面版 | **Node.js 18+**（推荐 22 LTS）。不需要装任何 npm 包 |
| 编译 APK | **JDK 17** + **Android SDK**（platform 34 + build-tools 34）。Gradle 由 wrapper 自带，不用单独装 |
| 跑测试 | **Node.js 22+**（用到全局 `WebSocket`）+ **本机装有 Google Chrome** |
| APK 复验 | Python 3.8+（只用标准库）+ `aapt2`（Android SDK 自带） |
| 用 APK（不编译） | Android 8.0+ |

Android SDK 里需要的东西：

```
platforms;android-34
build-tools;34.0.0
platform-tools
```

---

## 4. 主要实现思路

只讲几个「不知道就很容易做错」的点。更完整的复盘见
[`bd2-local-viewer/ARCHITECTURE.md`](../bd2-local-viewer/ARCHITECTURE.md)。

### 4.1 一份前端，两个宿主

前端只有一份，靠一个常量判断自己在哪：

```js
const NATIVE = !!window.BD2Native     // APK 里由 addJavascriptInterface 注入
```

数据源分叉被**限制在少数几处**（扫描 / 删除 / 导入 / 配置 / 存储诊断），
其余代码完全不知道宿主是谁。ARCHITECTURE.md 把这写成了不变量 R9，
新增分叉点必须在文档里登记 —— 否则「同一件事两处真相」的 bug 会复现。

### 4.2 APK 里为什么要把所有东西内联成单文件

WebView 里托管本地资源有两条路：`shouldInterceptRequest` 拦请求，或者手喂字符串。
前者在**某些 WebView 版本上会失效**，一旦失效，主文档拿不到正确的 `Content-Type`，
就会被当纯文本渲染 —— 用户看到的是满屏源码。

所以走后者：`bundle.mjs` 把 CSS/JS 全部内联成一个
`app.bundle.html`，用 `loadDataWithBaseURL()` 注入。这样主文档和它的子资源都不依赖拦截链路，
只剩 `/spine/` 下的资产数据还需要它。

坐标与资源都是同源（`https://bd2.local`），所以 WebGL 贴图能直接上传，没有跨域问题。

### 4.3 为什么把库直接放进仓库

`spine-player.js` / `spine-player-4.0.js` / `jszip.min.js` 是**发行版文件**，直接放在 `public/lib/`。

- 不用 npm install，不用打包器 → clone 下来就能跑；
- APK 构建少一个环节，也少一类「本地能跑、别人跑不了」的失败；
- 分发出去的产物就是被测试过的那一份字节，不会被依赖解析换成别的版本。

代价是仓库里多了 ~1.2MB 的文件，以及升级库要手动替换 + 重跑测试。
这个权衡是有意的。

### 4.4 打了补丁的第三方库

`public/lib/spine-player-4.0.js` 里有**一处本地修改**（`bundle_check.mjs` 有断言守着它）：

两个 IIFE 产物默认都把结果写到全局 `spine`，同时引入就会互相覆盖。所以 4.0 那份的
`var spine = (() => {` 改成了 `var spine40 = (() => {`（全文件只有这一处 `var` 声明，
改完不影响任何内部引用）。文件头加了一段中文注释说明这件事 ——
**那是我们写的，不是上游内容**，升级时要注意合并。

`public/lib/spine-player.js`（4.1）里另有一处**上游代码的修订**：

官方 `Input` 类里有两处 `let dy = this.touch1.x - this.touch0.x` ——
用 `x` 算 `dy`，是复制粘贴笔误。后果是横向双指捏合时初始距离被算成 `√2·|dx|`，
**越捏大画面反而越小**。已改成 `.y`。

换库 / 升级版本时这两条修改会丢，测试会立刻报出来。

### 4.5 首屏必须被「钉死」

症状：每次进 App 都先闪一屏播放页再跳到资产页。**真机明显，本地几乎看不见**
（磁盘快 → 扫描快 → 闪一下就过去了）。

根因是时序不是逻辑：视图状态的初值是对的，但真正生效的 `setView()` 原先在扫描**结束之后**
才调用；在那之前 `<body>` 上没有任何标识类，而播放页容器默认就是显示状态，
浏览器于是先老实画了一屏。

修法是两条一起上，缺一不可：

1. `index.html` 里直接写 `<body class="view-grid">` —— 首帧长什么样写在 HTML 里，不依赖脚本；
2. `boot()` 在**加载数据之前**就调 `setView(initialView())`（有 `?item=` 深链则进播放页）。

推论：**凡是「首屏该显示什么」的判定，都不能只存在于 JS 里** ——
脚本到达之前那段时间是无人管辖的。

### 4.6 返回键：宿主只问不猜

「现在在哪一层」的知识如果写死在 Java 里，就必然漏 ——
弹窗、抽屉、选择模式、视图层级，Java 全不知道。结果是用户在播放页按返回，App 直接退了。

现在前端出**唯一入口** `handleBack()`，由内到外逐层剥，返回 `true` 表示「这次返回我消化了」；
Java 只负责问（`evaluateJavascript`），拿不到 `true` 就走自己的兜底。

配套的一个坑：异步确认弹窗必须留一个 `handleBack()` 能调到的取消入口
（`mask.__cancel = () => done(false)`），否则弹窗被关掉了却没人 resolve，整个流程永远挂住。

### 4.7 扫描预算

选中 `/sdcard` 根目录时面对的是几万个目录。扫描因此有三道闸：
最大深度、最多目录数（4000）、总时长预算（45s）。超了会在结果里标记 `truncated`。

同时扫描结果**不整体推给 JS**：只推元信息（几十字节），条目由前端分页同步拉取。
早先一次性推几 MB 的 JSON 会把 WebView 进程压崩。

**重叠扫描只认最后一次发出的那一轮**（1.03 起，见 `ARCHITECTURE.md` R17）。
连点两个根目录 / 一边刷新一边切资产类型时两次扫描会重叠，而响应回来的顺序不保证与
发出的顺序一致。用户要切换的目录、资产类型都是「当前选择」这一类状态，
让**先发但后到**的结果落地，就会出现「条目来自 A 根、绝对路径前缀来自 B 根」的混合态 ——
「复制路径」于是拼出一条不存在的路径。做法是给 `scan()` 一个代次号：
发请求前自增并记下本地值，响应回来后先比代次，过期就整包丢弃
（不写条目、不写 `rootPath`、不更新计数、不弹错误、也不关 spinner —— 那是新一轮在用的）。

### 4.8 资产命名约定（多种游戏、一套代码）

同一个引擎导出的文件，不同游戏给的扩展名不一样，于是「怎么认出一套资产」有多套规则：

| 资产类型 | 图集 | 骨架 | 缩略图 | 骨架世代 |
|---|---|---|---|---|
| **BD2** | `x.atlas` | `x.json` / `x.skel` | 无（现场渲一帧） | 4.1.x |
| **Lost Sword** | `x.atlas.bytes` | `x.skel.bytes` / 裸 `x.bytes`（JSON） | 目录里的 `thumb.png` | 4.1.x |
| **NIKKE** | `x.atlas`（同 BD2） | `x.skel`（同 BD2） | 无 | **4.0.x** |

NIKKE 的命名与 BD2 **完全相同**，所以它**不占一个新的 `mode`** —— 用 BD2 模式扫就能认出来，
真正的差别在渲染（见 §4.8.1）。这也说明「模式」这个维度描述的是**命名约定**，
不是「哪个游戏」。

做法是**把扩展名差异收进一个 `classify()`，主流程只认「角色」**
（图集 / 骨架 / 缩略图 / 贴图）。这样扫目录那段主体逻辑一行都不用改，
新增第三种约定也只加一个 `classify` 分支。三处实现的语义必须一致：

| 位置 | 实现 |
|---|---|
| 桌面服务 | `server.mjs` 的 `FORMATS[mode].classify()` |
| Android 原生 | `ScanEngine.classify(name, mode)` |
| 手动上传（桌面） | `app.js` 的 `fileRole(name)` |

### 4.8.1 骨架世代：两套 Spine 运行时（1.03 起）

NIKKE 的骨架是 Spine **4.0.x** 导出，BD2 / Lost Sword 是 **4.1.x**。Spine 的约定是
**只有 major.minor 相同才能互读**，而 4.1 运行时读 4.0 骨架时**不会报版本错误** ——
它按 4.1 的二进制布局继续读，把字节读成 4.1 才有的 sequence 名，最后抛一句
看起来像「图集缺图」的假故障（实测：`Region not found in atlas: add_l_eye23 (sequence: add_l_eye)`，
而图集里只有 `add_l_eye`）。这类错误指向的地方和真正的病因隔着两层，非常费时间。

做法：`index.html` 同时引入两套运行时（两份都在浏览器里常驻，各自持有
`OrthoCamera` / `CameraController` / `Vector2` / `GLTexture`），载入每个资产时读它的
**骨架头**判 minor —— 二进制骨架的版本串固定写在头部：

```
[0..7]  骨架 hash（低/高各 4 字节）
[8]     变长长度前缀
[9..]   "4.0.47\0"
```

只取头 32 字节即可，用 `ReadableStream` 读到第一块就 `cancel()`（不依赖 Range 支持；
个别 WebView 对拦截响应不给 body 流时退回整读）。判定结果按条目录在 `item._spineMinor` 上。

选中运行时后，**整个播放会话（播放器 / 自建相机 / GLTexture 预乘补丁）都从同一套取类**：
`S.spine` 记当前会话的运行时，播放器实例上再挂一份 `__spineRt`（`onLoaded` 是异步回调，
期间用户可能已经切到别的资产）。缩略图队列用局部变量，绝不去动全局 ——
缩略图与主播放器可能同时在跑，改全局会让两个会话互相踩。

JSON 骨架不读文件（BD2 / Lost Sword 的 `.json` 都是 4.1），直接按 4.1 处理。

**两个必须按顺序判断的地方**（写错会**静默**算错文件名）：

1. `.atlas.bytes` / `.skel.bytes` 先于裸 `.bytes`，否则基名会算成 `x.atlas` 而不是 `x`；
2. `thumb.png` 先于通用图片，否则它会被当成图集的一页吸进去。

**骨架配对用的是三级级联**：①基名精确相同 → ②骨架基名是图集基名的前缀（取最长）
→ ③目录里只有一个候选。实测 430 套里 429 套命中①，剩下 1 套靠②
（`skull_Soldier_Green.atlas.bytes` ↔ `skull_Soldier.skel.bytes`）。
不能只留③：有 40 个目录里放着 2~3 个骨架，随便挑会张冠李戴。

**传输上有一处必须特判**：`.atlas.bytes` 是**文本**（按 `text/plain` 返回），
`.skel.bytes` 是二进制。只看最后一个 `.` 会把两者都判成 `bytes`。

**切资产类型这件事会连带动三样东西**（都在前端不变量 R13 里）：
扫描缓存键（服务端 `rootId|mode`、安卓同理）、
每个目录的手动播放顺序键（`bd2.order.<root>.<mode>`）、
以及**三个原生调用都要带上 mode**（`requestScan` / `scanPage` / `scanCount`）——
少传一个就会出现「切了没反应」：界面切了，拿回来的还是上一套结果。

### 4.8.2 NIKKE 模式：一个角色一套资产（1.04 起）

NIKKE 的文件命名与 BD2 完全一样，所以**归桶规则**就是 bd 那套（`FORMATS.nikke`
直接复用 `FORMATS.bd.classify`，原生侧同理）——服务端和原生层都不需要第三个分支。
它和 bd 的真正差别在**前端怎么组织**：

- `<id>_00`（如 `c022_00`）是本体；`<id>_aim_00` / `<id>_cover_00` 是**同一个角色**的
  瞄准 / 掩体姿势。参考站（Nikke-db）就是这么组织的：一个角色一份，播放页里切姿势。
- 分组只发生在**可见口径**这一层（`ARCHITECTURE.md` R18）：`S.items` 始终存原始条目，
  变体从 `allItems()` 隐藏、并把成员表挂到主条目的 `members` 上；删除时摊开成员一起删。
  服务端 / 原生若要维护「成员列表」，三个实现就得同步同一份分组语义 —— 不放那儿。
- 播放姿势记在 `S.currentPose`，`loadCurrent` 按它取成员的文件；
  `S.current` 永远是主条目（导航 / 删除选中 / 卡片高亮都不用改口径）。
- 默认动画按姿势落：aim → `aim_idle`、cover → `cover_idle`（没有就退回通用规则）。

### 4.8.3 多皮肤骨架：default 垫底合成（1.04 起）

有些骨架把身体部件放在具名皮肤里，`default` 皮肤只带零头（实测 Lost Sword 的 Elin：
81 个槽位里 default 只带 11 个，所以照书选 default 就只显示一小块角色）。两条对策：

1. **初始皮肤挑「覆盖槽位最多」的那个**（数的是 `skin.attachments` 里不同槽位的个数，
   不是附件数 —— 一个槽位常挂好几个换装变体）；
2. **切到具名皮肤时把 default 垫在下面合成**（`new Skin(def.name + '+' + name)` +
   `addSkin(default)` + `addSkin(chosen)`），两套运行时（4.0 / 4.1）的 Skin 都支持。

**载入路径只设皮肤、不主动画帧**：`onLoaded` 处在播放器的载入上下文里，
那里调 `drawFrame` 会弄坏它自己的渲染循环（实测唯一多皮肤的 aim 骨架报
`Unable to render skeleton`，而单皮肤的资产全都没事）—— 所以 `applySkin` 有个
`{redraw:false}` 档，让播放器自己的循环去画第一帧。缩略图同理：合成皮肤后
不额外 draw，交给既有的出图流程。

---

## 5. 桌面版配置文件

`bd2-local-viewer/viewer.config.json` 决定「服务允许读哪些目录」。
**没配的话桌面版起来是空的。**

```bash
cd bd2-local-viewer
cp viewer.config.example.json viewer.config.json
```

```json
{
  "host": "127.0.0.1",
  "port": 8137,
  "maxDepth": 5,
  "roots": [
    {
      "id": "my-mods",
      "label": "我的 Spine 资产",
      "path": "E:/path/to/your/spine/assets"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `host` | 保持 `127.0.0.1`。**不建议改成 0.0.0.0** —— 那等于把本地文件读接口暴露到局域网 |
| `port` | 默认 8137。被占用时服务会自动往后找一个空闲端口 |
| `maxDepth` | 往下扫几层子目录 |
| `roots[].id` | 前端用它记排序 / 筛选，建议纯 ASCII |
| `roots[].label` | 显示在顶部下拉框里的名字 |
| `roots[].path` | 允许读取的目录。**服务只读这里声明过的路径**，越界请求会被拒绝 |

> `viewer.config.json` 已被 `.gitignore` 忽略 —— 它装的是你个人的磁盘路径，不该提交。
> 想加更多目录直接在 `roots` 里追加即可。

Android 端**不需要任何配置文件**，但需要在手机上准备目录并授权，见 README §1.2。


## Android 自动根按模式分子目录

自动读取路径为 `/sdcard/BD2Viewer/{bd2,nikke,lostsword}`（以及 App 专属目录下同名子目录）。
`ScanEngine.bindModeRoots(mode)` 在扫描自动根时把 `__public__` / `__default__` 绑到对应子目录；切模式会强制重扫并在路径变化时清掉该 rootId 下所有 mode 缓存。
同根混放时列表**不再**按 `spineMinor` 世代过滤（产品不要求跨模式完美隔离）；`spineMinor` 仍写入条目，供前端选 4.0/4.1 运行时。各模式靠 Android 分子目录`BD2Viewer/{bd2,nikke,lostsword}` 分开存放即可正确查看。
