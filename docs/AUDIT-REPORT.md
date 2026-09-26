# kakiko-BD2Viewer — 开源发布前最终复盘报告

审计日期：2026-09-25
审计范围：全仓库（`bd2-local-viewer/` + `bd2-android/` + 文档 + 构建配置）
结论：**可以上传 GitHub**。代码功能未改动，修掉 11 个真 bug、清掉 5 处隐私/凭据泄漏、补齐开源工程要件，
并按上游 MIT 的署名要求写明「本项目基于 Jelosus2/BD2-L2D-Viewer 构建」（§3.5，共六处）；
剩余 4 项需要你本人手动完成（见 §8.3）。

---

## 1. 项目整体复盘

### 1.1 它是什么

一个**本地 L2D（Spine 动画）浏览器**，用来浏览和播放《Brown Dust 2》mod 目录里的
Spine 4.1 资源。带两个宿主：桌面网页版，和安卓 WebView 套壳 APK。

### 1.2 功能清单

| 模块 | 能力 |
|---|---|
| 资产栅格页 | 自动扫描目录树找出所有 `.atlas`；缩略图队列后台逐个出图；缓存到 IndexedDB；失败的标「无法生成」并持久化结论 |
| 播放页 | Spine 4.1 运行时播放；相机取景/捏合缩放/拖拽平移；图层开关；动画切换 |
| 导航 | 两侧箭头切**动画**，底部 ◀◀/▶▶ 切**资产**（各归其位，互不串台） |
| 排序 | 按名称 / 按日期 / 按大小，方向可切换，偏好跨重启保留 |
| 批量操作 | 长按 / 右键唤出菜单；多选模式；删除前必过二次确认并列出待删文件 |
| 导入 | 上传 zip 解包导入到指定 root |
| 导出 | WebM 录屏、逐帧 ZIP、PNG 截图 |
| 搜索 | 按名称过滤 |
| 安卓侧 | SAF / 文件树两套扫描通路；前台服务保活；返回键分层处理 |

### 1.3 架构：一份前端，两个宿主

```
                 bd2-local-viewer/public/  ← 唯一的一份前端源码
                 (app.js 4044 行 / styles.css 1545 / index.html 448)
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
   桌面宿主 (server.mjs 650 行)              安卓宿主 (bd2-android, WebView)
   Node 内置模块，零依赖                     MainActivity 566 / ScanEngine 1065
   扫 roots → /api/scan → JSON              NativeBridge 210 / Host 176 / KeepAlive 54
```

分叉点只有一个全局判据：`const NATIVE = !!window.BD2Native`。
数据源分叉**只允许**出现在 扫描 / 删除 / 导入 / 配置 / 存储诊断 五处 —— 这是不变量 **R9**，
写在 `bd2-local-viewer/ARCHITECTURE.md` 里，review 与测试都引用它。

### 1.4 两个关键实现决策（不是随手写的）

1. **APK 里的前端是内联单文件。**
   `_tools/bundle.mjs` 把 CSS/JS 全部内联进 `app.bundle.html`，用
   `loadDataWithBaseURL` 加载。原因：`shouldInterceptRequest` 在部分 WebView 版本上会失败，
   表现为「页面被当纯文本渲染」。
2. **首屏被钉死在 HTML 里。**
   `index.html` 直接写 `<body class="view-grid">`，且 `boot()` 在 `await scan()` **之前**
   调 `setView(initialView())`。否则会出现「进软件先从播放页闪一下再切回资产页」。

### 1.5 技术栈

- 前端：原生 JS（无框架）+ spine-player 4.1.55（已打补丁）+ JSZip 3.10
- 桌面宿主：Node 18+，**只用内置模块，不需要 `npm install`**
- 安卓：Gradle 8.7 / AGP 8.x / JDK 17 / compileSdk 34 / minSdk 26 / targetSdk 34
- 测试：无框架，Node 22 内置 WebSocket 驱动无头 Chrome（CDP）

### 1.6 代码规模

| 部分 | 行数 |
|---|---|
| 前端（app.js + styles.css + index.html） | 6037 |
| 桌面宿主 server.mjs | 650 |
| 安卓 Java（5 个文件） | 2071 |
| 构建/打包脚本（_tools） | 224 |
| **合计** | **约 9000 行** |
| 文档 | 约 1640 行 |

### 1.7 测试现状（本次实测全绿）

一条命令跑完：`node _test/run_all.mjs`（自己起服务、跑完自己关，约 3.5 分钟）

| 套件 | 项数 | 需要真实游戏数据 |
|---|---|---|
| `manifest_check.mjs` | 6 | 否 |
| `bundle_check.mjs` | 18 | 是 |
| `bundle_firstpaint.mjs` | 7 | 是 |
| `delete_api.mjs` | 12 | 否 |
| `e2e.mjs` | 24 | 是 |
| `native_mode.mjs` | **155** | 是 |
| **合计** | **222** | |

### 1.8 已知的、**刻意保留**的技术债

- `app.js` 是 4044 行单文件，没拆模块。判定「暂不动」——触发条件写在
  `ARCHITECTURE.md` §5：**出现第三个宿主时**才拆。
- `ScanEngine` 里的 MediaStore 扫描通路当前不可达（没有任何 root 会是 `kind="ms"`）。
  已加注释说明它是什么、怎么启用，没有删除——因为删了将来要重写。
- R8 / ProGuard **未开启**（`minifyEnabled false`）。keep 规则已写好放在
  `app/proguard-rules.pro`，按需开启。

---

## 2. 本次发现的问题

### 2.1 必须修改（11 项，**已全部修复**）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| 1 | `_tools/bundle.mjs` | `html.replace('<body>', …)` 在 `index.html` 的 `<body>` 加上 `class="view-grid"` 后**再也匹配不上** | **加载遮罩 `#__boot` 从未进过产物**；且测试断言 `!getElementById('__boot')` 因此**空过**（"找不到"被当成"已移除"）→ 一个失效的测试掩盖了一个真实回归 |
| 2 | `Host.java` `decode()` | 用 `URLDecoder.decode`，它把 `+` 解码成空格 | 文件名含 `+`（如 `xxx+diffuse.png`）变成 `xxx diffuse.png` → 贴图 **404** |
| 3 | `Host.java` `text()/json()` | `s.getBytes()` 用平台默认编码（中文 Windows = GBK），HTTP 头却声明 `utf-8` | 非 ASCII 内容**乱码** |
| 4 | `NativeBridge.deleteItems` | 失败分支手拼 JSON 字符串 + `.replace('"','\'')` | 遇反斜杠/换行产出**非法 JSON** → 前端 `JSON.parse` 抛异常，删除失败无提示 |
| 5 | `NativeBridge.copyText` | 在 JavaBridge 后台线程直接操作 UI | **违反 Android 线程模型**，行为未定义 |
| 6 | `ScanEngine.writeImport` | `rel.replace("../","")` 是**单次替换** | `....//x` 能活下来 → **路径穿越**，可写到目标目录之外 |
| 7 | `MainActivity` | `setWebContentsDebuggingEnabled(true)` 无条件开启；`onDestroy` 不 `destroy()` WebView | release 包把 WebView 暴露给 `adb`；**WebView/Context 泄漏** |
| 8 | 仓库根 / `bd2-android/` | **没有 `gradlew` / `gradlew.bat` / wrapper** | **别人 clone 下来根本编译不了**（最典型的"我本地能跑"） |
| 9 | 仓库内多个文件 | 提交了 `debug.keystore`（2 份）、`gradle.properties` 里的**个人代理** `127.0.0.1:7892` 与 SDK 绝对路径、`viewer.config.json` 的**真实游戏目录**、`_scan.json`（180KB）里的**真实磁盘路径** | **隐私/安全泄漏**；共享调试签名是反模式 |
| 10 | `_test/cdp.mjs` | `const CHROME = 'C:\\Program Files\\Google\\Chrome\\…'` **写死了作者本机的 Chrome 安装路径** | **只有作者那台机器能跑测试**；macOS / Linux 直接跑不了，Chrome 装在别处也跑不了（且报错是难懂的 `spawn ENOENT`） |
| 11 | `_test/extra.mjs` | 硬编码了作者的**真实游戏资产绝对路径** `E:\…\BrownDustX\mods\…` | 又一个**个人路径泄漏**；且别人跑必然失败 |

> 第 10、11 项是在最后一次全仓库复扫时发现的 —— 说明「逐文件扫一遍」这一步不能省，
> 光看 `.gitignore` 覆盖了哪些**目录**，看不出某个**已跟踪文件内部**还藏着本机路径。

### 2.2 建议修改（7 项，**已全部完成**）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `_tools/sync_assets.mjs` | 只硬编码同步 4 个顶层文件，**不拷 `lib/`**；而 `index.html` 的回落路径需要 `lib/*` → 升级 spine-player 后必炸 |
| 2 | `app/build.gradle` | `debug` signingConfig 内联引用已提交的 keystore（口令 `android`）；release 无签名通路 |
| 3 | `Host.serveAsset()` | 没有 `..` 拒绝（纵深防御缺失） |
| 4 | `ScanEngine.java` | 有真死代码 `readText(File)`（早被 `readTextEntry` 取代）；`addSafRoot()` 缩进错位（看起来在 `synchronized` 块外） |
| 5 | `bundle_firstpaint.mjs` | 摘要文案写「5+1 项」，实际 7 项 |
| 6 | `_test/` | 22 个 `.mjs` 混在一起，没有说明谁是回归套件、谁是一次性诊断脚本 |
| 7 | `gradle.properties` | 混着**机器相关配置**（代理、SDK 路径）——这些应该进 `~/.gradle/gradle.properties`，不该跟着仓库公开 |

### 2.3 可以保持（5 项，**刻意不动**）

| # | 项 | 为什么不改 |
|---|---|---|
| 1 | `app.js` 4044 行单文件 | 拆分收益 < 风险；触发条件（第三个宿主）已写进 `ARCHITECTURE.md` §5 |
| 2 | R8 未开启 | 这个工程的 `@JavascriptInterface` 方法全靠反射调用，Java 侧没有调用点，R8 会把它们当死代码删掉，症状是「App 正常但一点功能就静默失败」。keep 规则已备好，等有需要（如体积/混淆诉求）再开 |
| 3 | `usesCleartextTraffic="true"` | 服务只在 `127.0.0.1`，明文仅限本机回环 |
| 4 | 不用 npm 依赖（`public/lib/` 直接放发行版文件） | 换取「clone 后零安装即可运行」；`package.json` 的 dependencies 是可选覆盖路径 |
| 5 | `MANAGE_EXTERNAL_STORAGE` + `minSdk 26` | 由应用性质决定（mod 目录位置任意）。**注意：这个权限会导致无法上架 Google Play**，但本项目定位是自用/侧载工具，这是合理取舍 |

### 2.4 权限清单（复核结论：每一项都有正当理由）

`INTERNET`（WebView 内部请求，不出网）、`READ_EXTERNAL_STORAGE`(≤32)、
`READ_MEDIA_IMAGES`/`VIDEO`、`MANAGE_EXTERNAL_STORAGE`、`WRITE_EXTERNAL_STORAGE`(≤28)、
`FOREGROUND_SERVICE` + `_SPECIAL_USE`（保活）、`POST_NOTIFICATIONS`。
Manifest 里每一项都带注释说明用途，`KeepAliveService` 的 `specialUse` 也按规范填了
`PROPERTY_SPECIAL_USE_FGS_SUBTYPE`。

---

## 3. 实际做了哪些改动

### 3.1 修 bug（11 处，见 §2.1）

全部是**在不改变对外功能**的前提下修的：

- `bundle.mjs`：新增 `replaceOnce()`（出现次数 ≠1 直接抛错），改用正则取 `<body …>` 再注入，
  并加**产物级后置断言**（遮罩在不在、`<style>` 在不在）。同时修了「外链统计」误把
  `app.js` 自己源码里出现的 `<link` 字符串算成外链的问题（现在先剥掉 `<script>/<style>` 内容再统计）。
- `Host.java`：`decode()` 换成手写 `%XX` 解码（认 UTF-8、放过 `+`）；
  `text()/json()` 改 `StandardCharsets.UTF_8`；`serveAsset()` 拒绝 `..`；删掉不再需要的 `import URLDecoder`。
- `NativeBridge.java`：失败分支改用 `JSONObject` 构造；`copyText` 改 `ui.post(...)`。
- `ScanEngine.java`：`writeImport` 改为「规范化路径 + 目标目录包含性校验」；删死代码 `readText(File)`；
  修 `addSafRoot()` 缩进；给不可达的 MediaStore 通路加说明注释。
- `MainActivity.java`：调试开关与 console 日志都收敛到 `BuildConfig.DEBUG`；
  `onDestroy()` 补 `web.destroy()` + 置 null。
- `_test/cdp.mjs`：新增 `findChrome()` —— 按 **`CHROME_PATH` 环境变量 → 各平台常见安装位置
  （Windows / macOS / Linux 各一套）→ `PATH` 搜索** 的顺序查找浏览器，找不到时给出
  「怎么指定」的可操作提示，替换掉写死的 `C:\Program Files\Google\Chrome\…`。
  同时支持 `Cdp.launch({ chrome })` 显式指定。
- `_test/extra.mjs`：删掉写死的本机资产路径，改为**从 `viewer.config.json` 的第一个 root 推导**
  （也可用 `BD2_TEST_SRC` 覆盖），配置缺失时给出明确指引而不是抛 path 错误。
- 生成 Gradle Wrapper（`gradle wrapper --gradle-version 8.7`）。

### 3.2 安全清理

- **移出仓库**（隔离到仓库外的隔离目录，可随时找回）：
  `debug.keystore`（根 + `bd2-android/`）、`_ref/`（别人的参考工程，自带 `.git`，221K）、
  `_ref_bd2viewer/`、`_bd2viewer.zip`、`_tree.json`、根目录过时的 `assets/` 副本、
  根目录 `_build.ps1`（中文乱码）、`_scan.json`、`_scratch_shots.log`。
- **改为本地化**：代理配置 → 引导到 `~/.gradle/gradle.properties` 或 `-D` 参数；
  release 签名 → `gradle.local.properties`（已 gitignore）> 环境变量；没配就出未签名包。
- **补 `.gitignore`**：120 行，含构建产物、本地配置、密钥、IDE、Node、OS、开发辅助目录、
  测试残留。**已用临时 git 仓库实测验证**：18 条"应忽略"规则全部命中，
  14 条"应跟踪"路径全部未被误伤。

### 3.3 补齐开源工程要件

新增 16 项（详见 §5.1）：许可与声明、README 与两份专项文档、截图、配置模板 ×2、
构建/复验工具 ×2、测试运行器与测试目录说明、R8 keep 规则、Gradle Wrapper、本报告。

### 3.4 文档

- `README.md`（760 行，15 节）：**顶部「手机端必读」**（自建文件夹 + 所有文件访问权限）、
  项目简介（含 BDroid_X 模组管理这条起因）/ 截图（说明为何不附图）/ **下载 APK（Release）** /
  技术栈 / 结构 / 环境 / 配置 / 编译运行 / 使用方法 / 实现思路 / 开发测试 / 注意事项 /
  已知问题 / 路线图 / 许可。
- `docs/BUILD.md`（205 行）：三种产物、环境准备、**为什么第 ①② 步不能省**、
  「增量构建的假象」、release 签名、R8 说明、**「clone 后跑不了」9 行排查表**、目录布局硬约束。
- `docs/DEVELOPMENT.md`（210 行）：改哪里、测试架构、数据依赖、**测试反模式**（禁用固定
  `setTimeout`、条件归属 R1）、验证层次、Windows `.bat` 编码坑。
- `THIRD-PARTY-NOTICES.md`（125 行）：Spine Runtimes License 原文 + 中文实务说明 +
  JSZip 双许可 + Jelosus2 上游归属 + 商标声明。
- `_test/README.md`（109 行，新增）：22 个脚本逐个说明，区分回归套件 / 共享库 /
  一次性诊断脚本 / 夹具 / 残留。

### 3.5 上游署名（回答「本项目基于谁构建」）

按用户要求，明确标注**本项目基于 [Jelosus2/BD2-L2D-Viewer](https://github.com/Jelosus2/BD2-L2D-Viewer) 构建**，
四处一起改，且措辞保持一致（「**基于**它构建」而不是含糊的「参考」）：

| 位置 | 改法 | 为什么放这里 |
|---|---|---|
| `README.md` **顶部** | 标题下方的醒目引用块 + §1 简介 + 新增 **§11.1 上游项目与致谢**（含「继承了什么 / 改了什么 / 致谢」三张清单） | 任何人打开仓库第一眼就能看到，这是最该被看见的位置 |
| `THIRD-PARTY-NOTICES.md` §3 | 从「思路来源」升级为「**上游项目：本项目基于它构建**」，并**附上上游 MIT 许可原文全文** | 这是法律声明的载体；MIT 要求保留版权与许可声明 |
| `LICENSE` | 「注意事项」里新增一条，写明上游归属并指向 `THIRD-PARTY-NOTICES.md §3` | 让只看 LICENSE 的人也不会错过 |
| `package.json` | `description` 改为 `Based on Jelosus2/BD2-L2D-Viewer (MIT, (c) 2025 Jelosus2)...`，并补 `license: "MIT"` | 包元数据里也能被检索到 |
| **应用内**（帮助弹窗「快捷键」底部） | 加了一个三行署名块：`本项目基于 Jelosus2/BD2-L2D-Viewer 构建` + 仓库地址 + `MIT License, Copyright (c) 2025 Jelosus2` | 使用者不一定去看仓库；源代码头部也同步补了同样的声明 |

**上游事实（已直接核实，不是转述）**：仓库 `Jelosus2/BD2-L2D-Viewer`，
定位 *Web-based interactive Live2D and Spine animation viewer for the Brown Dust 2 game.*，
许可 **MIT License, Copyright (c) 2025 Jelosus2**（已读取到许可全文），
技术栈 **Vue 3 + TypeScript + Vite + Pinia + Tailwind**（比对上游快照的 `package.json` 确认）。

**措辞上的两个刻意选择**：

1. **说「基于它构建」，同时说清「源码为独立重写」** ——
   两者都是事实：功能形态、交互设计、资产组织方式来自上游；而代码是重写的
   （上游 Vue+TS，本项目原生 JS，两仓库没有共享代码文件）。
   只写「基于」会让读者以为抄了代码，只写「参考」又弱化了实际继承关系，所以两个都写。
2. **应用内的仓库地址写成纯文本，不做成可点击链接** ——
   桌面版是单页应用，点击跳转会让页面离开并**丢掉已载入的资产**。
   （Android 侧其实已经安全：`shouldOverrideUrlLoading` 会把外部链接交给系统浏览器，
   但为了两个宿主行为一致，统一用纯文本。）

**顺带修掉一个布局 bug**：署名块第一版写完后，弹窗最后一行被**裁掉**（尾行只露出半截）。
量了一下根因：`.modal-body` 是 `flex-direction: column` 的滚动容器，
**最后一个子元素的 `margin-top` 不会被算进容器高度**，于是内容比容器高 21px 被裁。
改成用父级的 `gap` 做间距 + 压成三行后复测：`bodyScrollable = 0`，不再裁切。

---

## 4. 最终 GitHub 目录树

```
<repo-root>/
├── README.md                      # 项目门面，15 节（开头就是手机端必读）
├── LICENSE                        # MIT（占位符待填，见 §8）
├── THIRD-PARTY-NOTICES.md         # ★ Spine 许可要求它随分发走，不可删
├── .gitignore                     # 120 行，已实测验证
│
├── docs/
│   ├── BUILD.md                   # 构建 + 排查
│   ├── DEVELOPMENT.md             # 开发 + 测试约定
│   ├── AUDIT-REPORT.md            # 本文件（发布后可删）
│   └── (screenshots 已移除，见下)
│
├── tools/
│   ├── verify_apk.py              # APK 三方 sha1 + 清单校验
│   └── build_apk.bat              # Windows 一键：bundle → sync → build → verify
│
├── bd2-local-viewer/              # 桌面版 + 唯一的前端源码
│   ├── server.mjs                 # 桌面宿主（Node 内置模块，零依赖）
│   ├── package.json               # 可选依赖（默认不需要 npm install）
│   ├── start.bat                  # Windows 双击启动（纯 ASCII）
│   ├── ARCHITECTURE.md            # ★ 分层调用链 + 10 条不变量
│   ├── viewer.config.example.json # 配置模板（真配置已 gitignore）
│   ├── public/                    # 前端源码
│   │   ├── index.html
│   │   ├── app.js                 # 4044 行，主逻辑
│   │   ├── styles.css
│   │   ├── app.bundle.html        # 内联产物（APK 的实际输入，必须进仓库）
│   │   └── lib/                   # spine-player 4.1.55（已打补丁）、JSZip
│   ├── _tools/
│   │   ├── bundle.mjs             # CSS/JS 内联成单文件
│   │   └── sync_assets.mjs        # 同步 public/ → APK assets/，逐文件比对 sha1
│   └── _test/                     # 222 项断言，无框架
│       ├── README.md              # ★ 逐个文件说明
│       ├── run_all.mjs            # 一条命令跑全套
│       ├── cdp.mjs                # 极简 CDP 客户端（共享）
│       ├── manifest_check.mjs     (6)   bundle_check.mjs        (18)
│       ├── delete_api.mjs         (12)  e2e.mjs                 (24)
│       ├── bundle_firstpaint.mjs  (7)   native_mode.mjs         (155)
│       └── diag_*.mjs / smoke / probe / webm…  一次性诊断脚本
│
└── bd2-android/                   # 安卓宿主（必须与上一目录并列！）
    ├── settings.gradle
    ├── build.gradle
    ├── gradle.properties          # 只有构建相关的通用设置
    ├── gradle.local.properties.example   # 签名凭据模板（真文件已 gitignore）
    ├── gradlew / gradlew.bat / gradle/wrapper/   # ★ 本次新生成
    └── app/
        ├── build.gradle           # 签名外部化、packaging、syncWeb
        ├── proguard-rules.pro     # ★ 为将来开 R8 备好的 keep 规则
        └── src/main/
            ├── AndroidManifest.xml
            ├── java/com/kkk/bd2viewer/
            │   ├── MainActivity.java     (566)  扫描/权限/返回键/WebView 生命周期
            │   ├── ScanEngine.java      (1065)  SAF + 文件树扫描、导入、删除
            │   ├── NativeBridge.java     (210)  @JavascriptInterface 桥
            │   ├── Host.java             (176)  本地资源服务（WebViewAssetLoader 回落）
            │   └── KeepAliveService.java  (54)  前台服务保活
            ├── assets/web/            # 由 sync_assets.mjs 生成（副本）
            └── res/                   # ic_app / strings / themes
```

**硬约束**：`bd2-android/` 与 `bd2-local-viewer/` **必须并列**。
`app/build.gradle` 的 `syncWeb` 用相对路径 `../../bd2-local-viewer/public`，
把 `bd2-android/` 单独拷出去编译会失败。

---

## 5. 文件清单

### 5.1 新增（16 项）

| 路径 | 作用 |
|---|---|
| `.gitignore` | 忽略规则（已用临时仓库实测验证） |
| `README.md` | 项目门面 |
| `LICENSE` | MIT，含第三方例外说明 |
| `THIRD-PARTY-NOTICES.md` | Spine / JSZip / 上游归属 / 商标 |
| `docs/BUILD.md` | 构建与排查 |
| `docs/DEVELOPMENT.md` | 开发与测试约定 |
| `docs/screenshots/` | **已从仓库移除** —— 截图必然用到付费取得的 L2D 资产，且部分内容不适合公开传播；随仓库分发等于分发受版权保护的素材。README §2 改为说明「为什么不附图」+ 如何自行生成 |
| `tools/verify_apk.py` | 由 `_verify_apk.py` 迁入，并修 ROOT 路径、新增 aapt2 自动查找 |
| `tools/build_apk.bat` | 由 `_build.ps1` 重写为纯 ASCII + CRLF，改用 gradlew，严格错误处理 |
| `bd2-local-viewer/_test/run_all.mjs` | 测试运行器 |
| `bd2-local-viewer/_test/README.md` | 测试目录说明 |
| `bd2-local-viewer/viewer.config.example.json` | 配置模板 |
| `bd2-android/gradle.local.properties.example` | 签名凭据模板 |
| `bd2-android/app/proguard-rules.pro` | R8 keep 规则 |
| `bd2-android/gradlew` / `gradlew.bat` / `gradle/wrapper/*` | Gradle Wrapper（本次生成） |
| `docs/AUDIT-REPORT.md` | 本报告 |

### 5.2 修改（19 项）

Java：`MainActivity.java`、`Host.java`、`NativeBridge.java`、`ScanEngine.java`
前端/工具：`public/app.js`（头部补上游署名）、`public/index.html`（帮助弹窗加署名块）、
`_tools/bundle.mjs`（修回归）、`_tools/sync_assets.mjs`（改为递归）、
`_test/cdp.mjs`（Chrome 路径跨平台自动查找）、`_test/extra.mjs`（去掉写死的本机路径）、
`_test/bundle_check.mjs`（加 3 条产物级静态断言）、`_test/bundle_firstpaint.mjs`（修正摘要文案）
构建：`app/build.gradle`（签名外部化 + packaging + proguardFiles）、`gradle.properties`（去个人配置）、
`bd2-local-viewer/package.json`（补上游归属与 `license` 字段）
文档：`README.md`（交叉链接修正 + 上游署名）、`LICENSE`（补上游归属说明）、
`THIRD-PARTY-NOTICES.md`（§3 扩写为完整上游声明）、`docs/BUILD.md`（清理路径修正）、
`docs/AUDIT-REPORT.md`（本文件）、`bd2-local-viewer/ARCHITECTURE.md`、`bd2-local-viewer/start.bat`

### 5.3 移出仓库（隔离保留，未删除）

`_ref/`、`_ref_bd2viewer/`、`_bd2viewer.zip`、`_tree.json`、`_probe.txt`、`_dl.log`、`_dl.ps1`、
`_build.ps1`、根目录 `assets/`（过时副本）、`debug.keystore` ×2、
`bd2-local-viewer/_scan.json`、`bd2-local-viewer/_scratch_shots.log`

### 5.4 删除（真删）

无。所有清理都走「移出」而不是「删除」——沙箱环境也拦删除，这样更安全。

---

## 6. GitHub 开源安全检查结果

| 检查项 | 结果 |
|---|---|
| API Key / Secret / Token / Cookie | **无** |
| 数据库凭据 | **无**（本工程不用数据库） |
| **签名密钥库 / keystore** | 曾存在 2 份 `debug.keystore` → **已移出**；`.gitignore` 覆盖 `*.jks/*.keystore/*.p12/*.pfx/*.pem/*.key` |
| 签名口令 | 曾以明文 `'android'`（调试签名）内联在 `build.gradle` → **已移除**，release 改走本地文件/环境变量 |
| **私有服务器 / 内网地址** | 曾配置个人代理 `127.0.0.1:7892` → **已从公开文件移除**，改为引导到用户自己的 `~/.gradle/gradle.properties` |
| **本地绝对路径 / 个人路径** | ① `gradle.properties` / `local.properties` 里的 SDK 与 JDK 路径 → **已移除/已 gitignore**；② `viewer.config.json` 里的真实游戏目录 → **已 gitignore**（模板为 `viewer.config.example.json`）；③ **`_scan.json`（180KB 扫描转储）内含真实磁盘路径，且不在旧 `.gitignore` 里** → **本次新发现，已移出并补进 `.gitignore`**；④ `_test/cdp.mjs` 写死了**本机 Chrome 安装路径** → **已改为跨平台自动查找**；⑤ `_test/extra.mjs` 写死了**本机游戏资产绝对路径** → **已改为从配置文件推导** |
| 个人信息 / PII | **无**姓名、邮箱、手机号、账号 |
| 文档/示例里的真实密钥 | **无**（模板文件全部用占位符） |
| `.gitignore` 完整性 | **已实测验证**（临时 git 仓库 + `git check-ignore`）：18 条应忽略规则全部命中，14 条应跟踪路径全部未被误伤 |

**Spine 许可合规（重要，不是可选项）**：
仓库分发了 Esoteric Software 的 Spine Runtimes。其许可要求**每个使用者自行持有 Spine Editor 授权**，
且**分发必须附带许可原文**。而 `spine-player.js` 是压缩文件、**自身没有许可头** ——
所以 `THIRD-PARTY-NOTICES.md` 不是"补充说明"，它是许可要求的一部分，**不可删除**。
`LICENSE` 里也注明 MIT **不覆盖**第三方组件。

**上游归属合规（MIT 的署名要求）**：
上游 `Jelosus2/BD2-L2D-Viewer` 是 MIT。MIT 要求在副本或实质性部分中**保留版权声明与许可声明**。
因此：`THIRD-PARTY-NOTICES.md §3` 已附上上游许可**原文全文**；
`README.md` 顶部 / §1 / §11.1、`LICENSE` 注意事项、`package.json`、应用内帮助弹窗、
`app.js` 文件头 **六处**都写明「本项目基于它构建」。详见 §3.5。

---

## 7. clone 之后怎么跑起来

### 7.1 只想看桌面版（最快路径，0 依赖）

```bash
git clone https://github.com/kakiko123/BD2Viewer.git
cd BD2Viewer/bd2-local-viewer
cp viewer.config.example.json viewer.config.json
# 编辑 viewer.config.json，把 roots[0].path 改成你自己的 BD2 mod 目录
node server.mjs
# 浏览器打开 http://127.0.0.1:8137
```

**不需要 `npm install`** —— `server.mjs` 只用 Node 内置模块，两个前端库（spine-player / JSZip）
已作为发行版文件放在 `public/lib/`。

### 7.2 想自己编译 APK

```bash
# 前置：JDK 17 + Android SDK（platforms;android-34、build-tools;34.0.0、platform-tools）

cd BD2Viewer/bd2-android
echo "sdk.dir=C:/你的路径/Android/Sdk" > local.properties
# JDK 不在 JAVA_HOME 上时再加：org.gradle.java.home=C:/Program Files/Java/jdk-17

cd ../bd2-local-viewer && node _tools/bundle.mjs && node _tools/sync_assets.mjs
cd ../bd2-android && ./gradlew.bat assembleDebug      # macOS/Linux: ./gradlew assembleDebug
cd .. && python tools/verify_apk.py                   # 建议：确认打进包里的确实是新代码
```

Windows 上 `tools/build_apk.bat` 会把上面全套（含复验）一次做完。
**Gradle 不用单独装**：仓库自带 Wrapper，首次运行自动下载 Gradle 8.7。

> ⚠️ 顺序不能省第 ①② 步。`app/build.gradle` 里确实挂了 `syncWeb` 任务，
> 但它**只做原样拷贝**、不知道要不要重新内联 —— 「改了 `app.js` → 直接 `assembleDebug`
> → 装到手机上还是旧界面」是必然会发生的。详见 `docs/BUILD.md` §3。

### 7.3 想跑测试

```bash
cd bd2-local-viewer
node _test/run_all.mjs                 # 全部（约 3.5 分钟）
node _test/run_all.mjs manifest_check delete_api   # 自包含，不需要游戏数据
```

需要 Node 22+（全局 WebSocket）。`native_mode` / `e2e` / `bundle_*` 会读你本机的真实资产，
没有游戏数据的人会失败 —— 这是设计如此。

测试会自己去找 Chrome / Chromium（Windows / macOS / Linux 各自的常见位置，再退到 `PATH`）。
装在非标准位置就设一下环境变量：

```bash
# Windows PowerShell
$env:CHROME_PATH = "D:\Apps\Chrome\chrome.exe"
# macOS / Linux
export CHROME_PATH="/path/to/chrome"
```

### 7.4 常见「跑不起来」的 9 种情形

已整理成表格放在 `docs/BUILD.md` §6（`local.properties` 缺失、JDK 版本错、依赖下不动、
装上去还是旧界面、桌面版空白、测试超时、资产列表为空、`gradlew` 丢可执行位、`aapt2` 找不到）。

---

## 8. 最终发布检查

### 8.1 已经满足的

- [x] 无密钥 / 无凭据 / 无个人路径泄漏（`.gitignore` 已实测验证）
- [x] `LICENSE` 存在，第三方许可合规（`THIRD-PARTY-NOTICES.md`）
- [x] `README.md` 完整（结构、环境、配置、编译、使用、已知问题、路线图）
- [x] **不含付费素材 / 不适内容**：`docs/screenshots/` 6 张图已从仓库移除，README §2 说明原因
- [x] 独立构建文档 + 「clone 后跑不了」排查表
- [x] Gradle Wrapper 齐备（clone 后无需装 Gradle）
- [x] 配置模板齐备（`viewer.config.example.json` / `gradle.local.properties.example`）
- [x] release 签名通路外部化，未配就出未签名包
- [x] `debug` 构建实测通过；`verify_apk.py` 三方 sha1 + 清单校验通过
- [x] 222 项测试全绿
- [x] 无临时/调试文件混入（诊断脚本已在 `_test/README.md` 里归类说明）
- [x] 目录结构符合标准开源安卓工程惯例

### 8.2 本次实测证据

| 项目 | 结果 |
|---|---|
| `node _test/run_all.mjs` | **6/6 套件通过**，222 项断言（6+18+7+12+24+155），用时约 3 分 25 秒，退出码 0 |
| 改动后复跑 | 修完 `cdp.mjs`（Chrome 跨平台查找）与 `extra.mjs`（去本机路径）后**再跑一遍全套，仍全绿** |
| `bundle.mjs` 产物一致性 | 输出稳定，894 KB；标记区外链 `<link>`=0、`<script src>`=0 |
| `sync_assets.mjs` | 7/7 文件 sha1 一致（`app.bundle.html`/`app.js`/`index.html`/`lib/` ×3/`styles.css`） |
| `assembleDebug` | **BUILD SUCCESSFUL**（所有任务 up-to-date，说明输入未变、构建可复现） |
| `verify_apk.py` | **全部通过**：`app.bundle.html` / `app.js` / `styles.css` / `index.html` 三方 sha1 全一致；`screenOrientation=13(fullUser)`；`configChanges=0x1fa0` 四维度齐全 |
| APK 内容 | `assets/web/` **7 个文件齐全**（`app.bundle.html` 917,018 B / `lib/spine-player.js` 563,604 B / `app.js` 156,967 B 等），无缺漏、无重复条目 |
| APK sha1 | `c44218d140e0ee4d7ef899340eedfdc527e13cca`（**557,013 字节**，clean 构建），与 `app-debug.apk` 同源 |
| APK 体积异常排查 | 增量构建出来是 811,623 B，比 `compress_size` 总和多出 **258KB**。逐字节查明：是 AGP `zipflinger` 增量 zip 更新留下的**死区**（一个空文件名 + 65505 字节 extra field 的占位 local header，后面跟一长段零填充），**不是损坏**。`clean assembleDebug` 后死区降到 4,797 B（即正常的 APK Signing Block），体积回落 557,013 B |
| 帮助弹窗署名渲染 | 实测 `bodyScrollable = 0`（不裁切）、快捷键 12 行完整、`hasUpstream / hasMit / hasUrl` 全部为真；另附截图人工复核 |
| `.gitignore` | 18 条「应忽略」规则全部命中；14 条「应跟踪」路径全部未被误伤（临时 git 仓库实测） |
| 泄漏复扫 | 全仓库 `grep` 个人路径/用户名，**所有将被提交的文件均已干净**（仅 UI 提示与示例文档保留通用举例路径） |

### 8.3 还差什么（**必须你本人做，我改不了**）

| # | 事项 | 为什么我做不了 | 怎么做 |
|---|---|---|---|
| ~~1~~ | ~~填 `LICENSE` 的 `<COPYRIGHT HOLDER>`~~ | ~~我不知道你的名字 / GitHub ID~~ | ✅ **已完成**：用户提供了 GitHub ID，已填为 `Copyright (c) 2026 kakiko123`；仓库地址 `https://github.com/kakiko123/BD2Viewer` 也已写进 README §7.1 的 clone 命令 |
| 2 | **决定是否 `git init` 并推远端** | 这是你的决定；原目录也不是 git 仓库 | `git init && git add . && git commit -m "Initial public release"`；提交前用 `git status` 复核一遍没有敏感文件 |
| 3 | **建 `bd2-android/local.properties`** | 里面装的是机器绝对路径，已被 gitignore，**任何人 clone 后都必须自建** | `sdk.dir=C:/.../Android/Sdk`（用 Android Studio 打开工程会自动生成） |
| 4 | **（仅当要发正式包）生成 release keystore** | 口令/密钥不该由我生成或持有 | `keytool -genkeypair …` → 填 `gradle.local.properties`（模板已备） |

### 8.4 可选的上线前动作

- `docs/AUDIT-REPORT.md`（本文件）是开发过程记录，**发布前可以删掉**，也可以留着当透明的变更说明。
- 建议在 GitHub 仓库设置里加上 **Topics**：`spine`、`l2d`、`android`、`webview`、`browndust2`、`game-tools`。
- 建议在 README 顶部加 CI 徽章（如果将来接 GitHub Actions）。
- 若想接 CI：`_test/manifest_check` 与 `_test/delete_api` 是**自包含**的，最适合当 CI 探针
  （不需要游戏数据）；其余套件需要真实资产，不适合放在公开 CI 上。

---

## 附：判定「暂不动」的技术债与触发条件

| 项 | 触发条件 |
|---|---|
| 拆分 `app.js` | 出现**第三个宿主**时（当前只有桌面 + 安卓） |
| 启用 R8 | 有明确体积/混淆诉求时；先补 keep 规则再跑 `native_mode`（它覆盖的正是 JS 桥通路） |
| 启用 MediaStore 扫描通路 | 需要扫描非 SAF 可达的系统媒体目录时（注释里写了启用方式） |
| 把 `public/lib` 换成 npm 依赖 | 需要跟随上游版本频繁升级时（会牺牲「零安装可运行」） |
