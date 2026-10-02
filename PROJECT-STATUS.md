# Kakiko Viewer — 项目进度与说明

> 快照日期：**2026-10-01** · 当前代码版本 **v1.07**（`versionCode 10`；显示名 Kakiko Viewer）
> 本文只讲「现在是什么状态、为什么这么做、下一步做什么」。
> 面向使用者的说明在 [`README.md`](README.md)；技术细节在 [`docs/`](docs) 与
> [`bd2-local-viewer/ARCHITECTURE.md`](bd2-local-viewer/ARCHITECTURE.md)。

---

## 0. 一句话现状

一个**完全本地**的 Spine（俗称 L2D）动画查看器，同一份前端代码出两种形态
（桌面版：本机 Node 服务 + 浏览器；Android APK：手写 WebView 壳）。
已经支持 **BD2 / Lost Sword / NIKKE / JCZX** 四种资产来源，跨 **Spine 4.0 / 4.1 / 4.2** 三代骨架；
NIKKE 的整包 mod 文件（UnityFS）在两个平台都能自动解包。7 个测试套件 **341 项断言全绿**，
v1.07 的 APK 已构建并通过校验（1,499,122 B）。

**悬着的事**：v1.06 还没 commit / push / 发 release ——
远端 `origin/main` 现在停在 v1.05（v1.02–v1.05 已提交，见 §8）。

**箱内未发版改动（仍标 1.07 / versionCode 10，需求 7 冻结）**：
需求 1+2（解包并发≤10 + 优先级 / 四类进度条）+ **需求 6**（NIKKE 解包按包分文件夹）+
**需求 3+4+5**（PC 点击=播放/拖仅⠿；预乘默认随 mode；thumb.png 持久化）。
未同步 PC、未出 APK。

---

## 1. 这是什么

扫描你手机或电脑上的 Spine 资产目录，把 `.atlas` + 骨架 + 贴图认成「一套套可播放的资产」，
然后平铺浏览、播放、切动画、切皮肤（NIKKE 还能切姿势）、显隐图层、截图和导出。
**不含任何游戏素材**，只读你机器上已有的文件；不联网、不上传。

三个产物，一份前端：

| 产物 | 入口 | 数据来源 | 前端代码 |
|---|---|---|---|
| **桌面版** | `bd2-local-viewer/server.mjs`（Node，只监听 127.0.0.1） | `fetch('/api/*')` + `/spine/*` | `bd2-local-viewer/public/` |
| **APK** | `MainActivity` → `loadDataWithBaseURL` 载入 `web/app.bundle.html` | `window.BD2Native.*`（`NativeBridge` / `ScanEngine`） | 同上，打包成单文件 |
| **共享前端** | `public/index.html` + `app.js` + `styles.css` | 由 `const NATIVE` 一处开关决定走哪条 | —— |

`_tools/bundle.mjs` 把 CSS/JS 内联成 `public/app.bundle.html`，
`_tools/sync_assets.mjs` 把它同步进 `bd2-android/app/src/main/assets/web/`，
`tools/verify_apk.py` 强制三者 sha1 一致 —— 这条闭环是「一份代码两个宿主」不跑偏的保证。

---

## 2. 版本进度

| 版本 | versionCode | APK 体积 | SHA-1 | 主要内容 |
|---|---|---|---|---|
| v1.0 | 1 | —— | —— | 初始发布：BD2 资产浏览 / 播放 / 截图导出（Spine 4.1） |
| **v1.01** | 2 | 596,077 B | `b51b56e4…` | 改名 kakiko-BD2Viewer、英文 UI、排序时锁拖动、平铺页资源文件搜索 |
| **v1.02** | 3 | 605,337 B | `a48c0129…` | **第二种命名约定：Lost Sword**（`.atlas.bytes` / `.skel.bytes` / 裸 `.bytes` / 自带 `thumb.png`）+ 资产类型开关 + PC 右键复制绝对路径 + 播放页「← 返回列表」 |
| **v1.03** | 4 | 845,945 B | `83f1ca20…` | **NIKKE 可渲染**：内置第二套 Spine 4.0 运行时、按骨架头自动选世代；顺带修掉「重叠扫描谁后回来谁生效」（R17） |
| **v1.04** | 5 | 855,457 B | `1e98f629…` | **NIKKE 独立成第三档模式**：一个角色一张卡 + 姿势切换；**多皮肤骨架合成**（Lost Sword 的「只显示一部分」）；测试工装两处修复 |
| **v1.05** | 6（Phase A）→ 7（Android JCZX）→ 8（Host/cache fix） | 1,432,382 B（含 1.06 的前端改动；1.05 本身未单独出包） | `8088b72a…` | **Spine 4.2 + JCZX 全平台**：桌面 UnityPy 提取、Android 纯 Java UnityFS strip+LZMA/LZ4+启发式导出；`BD2Viewer/jczx/`；界面名改为 **Kakiko Viewer** |
| **v1.06** | 9 | 1,432,382 B（同上一行，本次只改前端） | `8088b72a…` | **Lost Sword 两层角色修复**：`_B` 背层 + `_F` 前层归成一套资产并**叠层渲染**（修「Lobby 角色只看得到半个」）；卡面缩略图也叠两层；顺带修 1.05 遗留的两条过期断言（标题 / 缩放上限） |
| **v1.07** | **10** | 1,499,122 B | `42a20270…` | **NIKKE 整包 mod 文件自动解包**（UnityFS → 标准三件套）：桌面 UnityPy / 安卓纯 Java，分批 + 后台续解 + 进度提示；解包缓存只在 NIKKE 档可见。**同版本内追加两条用户反馈的修复**：①播放页不再被「扫描中…」全屏遮罩反复打断（R22）；②JCZX 解包后播不了 —— 提取器漏导二进制 `.skel`（497 个目录只有图集没骨架，两侧同源 bug）+ Spine 3.8 的 JSON 被 4.x 运行时读成 NaN（载入前就地转换，R21）。**按用户要求未升版本号**，改动全部计入 1.07 |

> 当前仓库根目录的 `BD2Viewer-debug.apk` 就是 **v1.07**（`versionCode 10`，1,499,122 B）。
> `kakiko-BD2Viewer 1.0.1.apk` / `kakiko-BD2Viewer 1.0.1 .apk` 是 v1.01 时期的产物，留在本地做对照。
> 体积从 v1.02 跳到 v1.03 的 +234 KB 是**第二套 Spine 运行时**；1.04 → 1.05 再涨约 577 KB 是
> **第三套运行时（4.2.120）**；1.06 本身只加前端逻辑，没有再引入依赖。

每个版本的发布说明：`RELEASE-NOTES-v1.01.md` … `RELEASE-NOTES-v1.06.md`。

---

## 3. 支持的资产类型

| 资产类型 | 图集 | 骨架 | 缩略图 | 骨架世代 | 组织方式 |
|---|---|---|---|---|---|
| **BD2**（标准导出） | `x.atlas` | `x.json` / `x.skel` | 无（现场渲一帧） | 4.1.x | 一套文件一张卡 |
| **Lost Sword**（Unity TextAsset 导出） | `x.atlas.bytes` | `x.skel.bytes` / 裸 `x.bytes`(JSON) | 目录里的 `thumb.png` | 4.1.x | 一套文件一张卡 |
| **NIKKE**（标准导出） | `x.atlas` | `x.skel` | 无 | **4.0.x** | **一个角色一张卡**：只显 NIKKE 形（`<id>_00` + aim/cover）；纯 BD2 名单件不进本档；mod 包解包缓存为 `bd2viewer-nikke/<pack>/`（需求 6） |

三件容易搞混的事：

1. **资产类型（`mode`）描述的是「命名约定」，不是「哪个游戏」。** NIKKE 的文件名与 BD2 完全一样，
   所以服务端与原生侧的归桶规则直接复用 bd（`FORMATS.nikke.classify = FORMATS.bd.classify`），
   新增它没有产生任何新的归桶分支。NIKKE 与 BD2 的差别全在**前端怎么组织 + 用哪代运行时**。
2. **骨架与运行时必须 major.minor 相同才能互读**，而且认错世代**不报版本错误** ——
   4.1 读 4.0 会错位解析，报一句像「图集缺图」的假故障。所以两套运行时都内置，
   载入每个资产时读它的骨架头（前 32 字节）自动挑。
3. **多皮肤骨架的 `default` 常常是残缺的**（实测 Lost Sword 的 Elin：81 个槽位里 default 只带 11 个）。
   现在初始就挑覆盖最全的皮肤，并把 `default` 垫在下面合成。

---

## 4. 架构与关键技术决策

一份前端、两个宿主，最大的风险是「同一件事的真相存在两处以上」。
`ARCHITECTURE.md` §6 把这类规则写成 **R1–R22 不变量**，review 与测试都引用编号。摘要：

| 编号 | 一句话 |
|---|---|
| R1–R5 | 随模式变的写 CSS、随数据变的用 JS 改类名；`filters` 是可见性唯一事实源；可见资产只有 `filteredItems()`；渲染函数只读不写；状态一变就 `refreshLists()` |
| R6–R10 | 四组箭头各归其位；返回键的层级只由前端 `handleBack()` 决定；异步弹窗留 `mask.__cancel`；不新增 `NATIVE` 分叉；调试面只有 `window.__bd2viewer` |
| R11–R12 | 用户可见文案必须过 `t()`（专名打 `data-i18n-keep`）；拖拽提示走 `setDropText()` |
| R13 | 资产类型是全局单值，凡随游戏而变的（扫描 / 缓存 / 顺序 / 文件角色判定）都必须带 `mode` |
| R14 | PC 与触屏两个入口**只许可见性不同、动作必须同一处**（`hidden` ≠ `display`，测可见性要量 computed style） |
| R15 | 绝对路径只有一个口径 `absPathOf()`；拿不到根路径就返回 null 并禁用入口，绝不拼假路径 |
| R16 | Spine 运行时按骨架世代挑、整个会话同源、**载入过程中绝不改全局** |
| R17 | 异步取回的整包状态要有**代次**（`scanSeq`），过期结果整包丢弃 |
| R18 | NIKKE 同角色归组（`*_NN` / aim / cover → 一张卡 + 姿势条）；归组只发生在可见口径；**不**再按命名形 / 骨架世代挡其它条目 |
| R19 | **Lost Sword 两层角色**（`<X>_B` 背层 + `<X>_F` 前层）归成一套资产并**叠层渲染**；时间轴由主循环驱动、取景按两层并集、离屏产出走同一条合成路径 |

几个值得记住的决策（都是被 bug 逼出来的）：

- **按「角色」归桶，不按扩展名建表。** 加新游戏只改 `roleBucket()` / `fileRole()` 一处，
  主体逻辑（挑骨架、核贴图、算 problems、记 relThumb）一行都不用动。
- **归组放前端，不放服务端/原生。** 若把「成员列表」塞进扫描结果，三个实现就得同步同一份分组语义。
- **`S.current` 永远是主条目**：NIKKE 切姿势只改 `S.currentPose`，
  导航、删除选中、卡片高亮都不用跟着改口径。
- **`app.js` 不拆**：它被内联进单个 `<script>` 走全局脚本语义，拆文件要同时改打包器、
  资源同步、APK 加载与全部测试的加载方式 —— 收益只是「好看」，风险面是全绿测试（见 KNOWN-ISSUES §2）。

实测规模（2026-10-01）：`app.js` **5995 行 / 216 个顶层函数**、`server.mjs` 786 行、
`ScanEngine.java` 1213 行、`MainActivity.java` 566 行、`styles.css` 1668 行、`index.html` 551 行。

---

## 5. 构建闭环（可照抄）

```bash
# 1) 改完前端 → 打包成单文件 → 同步进安卓壳（比 sha1）
node bd2-local-viewer/_tools/bundle.mjs
node bd2-local-viewer/_tools/sync_assets.mjs

# 2) 编译 APK（env 与 --offline 都不能省，沙箱无外网）
export JAVA_HOME=<repo>/toolchain/jdk17
export ANDROID_HOME=<repo>/toolchain/android-sdk
export ANDROID_SDK_ROOT=<repo>/toolchain/android-sdk
export GRADLE_USER_HOME=<repo>/toolchain/gradle-home
cd bd2-android
<repo>/toolchain/gradle/bin/gradle.bat --offline clean        # 发版前必 clean
<repo>/toolchain/gradle/bin/gradle.bat --offline assembleDebug

# 3) 复制到根目录并校验（三方 sha1 + 旋转锁 + configChanges）
cp bd2-android/app/build/outputs/apk/debug/app-debug.apk BD2Viewer-debug.apk
python tools/verify_apk.py
```

三条纪律：

- **发版前必须 `gradle clean`**：zipflinger 增量打包会留死区，同一份代码能虚胖近 50%。
- **判断「APK 是否刷新」要抽 `assets/web/*` 比 sha1**，不要看 APK 体积。
- **版本号改两处**：`app/build.gradle` 的 `versionCode`（单调递增，覆盖安装的唯一依据）
  + `versionName`，以及 `package.json` 的 `version`。真值用 `aapt2 dump badging` 读。

---

## 6. 测试

```bash
node bd2-local-viewer/_test/run_all.mjs                    # 全量，约 6-7 分钟，341 项
node bd2-local-viewer/_test/run_all.mjs manifest_check delete_api format_check   # 自包含组，秒级
```

| 套件 | 项数 | 跑什么 | 需要真实素材 |
|---|---|---|---|
| `manifest_check` | 6 | 旋转锁 `fullUser`、`configChanges`、`minSdk` | 否 |
| `bundle_check` | 34 | 单文件产物：id 一致性、内联、无外链、三套 Spine 运行时（4.0 / 4.2）都在且不同源 | 否（产物级） |
| `bundle_firstpaint` | 7 | 产物级首屏：第一帧就是资产页、深链仍进播放页 | 否（产物级） |
| `delete_api` | 12 | 真删磁盘（自带临时根目录，绝不碰用户 mods） | 否 |
| `format_check` | 37 | 四种命名约定互不串味、骨架三级级联、`thumb.png`、MIME、缓存按 `(root,mode)` 分离、nikke 模式、两层角色在服务端仍是两个条目、**NIKKE 解包缓存的档位可见性** | 否 |
| `e2e` | 53 | 端到端：相机 / 图层 / 截图 / 导出 / PC 侧入口 / 重叠扫描 / 真实素材专项（多皮肤合成、NIKKE 姿势、**Lost Sword 两层叠层与时间轴同步**） | 是 |
| `native_mode` | 192 | 假桥下的整条原生通路：拖动 / 长按 / 批删 / 箭头 / 返回键 / 首屏 / 语言 / 搜索 / 资产类型 / NIKKE 归组与姿势 / 两层角色归组 / **NIKKE 解包进度提示** | 是 |

- 端口：`8137`（源码与产物套件）、`8143`（native_mode）。`run_all` 自己 spawn 两个服务，
  跑之前先杀掉占端口的旧进程；**跑测试时不要并行起第二个 Chrome**（调试端口固定 9333，会互杀）。
- **依赖真实素材的两套**（`e2e` / `native_mode`）里，凡需要特定素材的断言都做了「素材不在就判 PASS 并标注跳过」，
  不会在别人的机器上整组飘红。
- 断言纪律（写在 `_test/README.md` 与 ARCHITECTURE §7.1）：**等条件别等时长**、只用单调量断言、
  别用 `sleep` 模拟紧接的用户动作、路径类期望值放 Node 侧独立算、拖拽用排列不变式、
  **新断言必须验「去掉修复会 FAIL」**。

---

## 7. 文档地图

| 想了解什么 | 看哪里 |
|---|---|
| 怎么用、支持什么、怎么装到手机 | [`README.md`](README.md) |
| 技术栈 / 实现思路 / 命名约定 / 运行时世代 | [`docs/TECHNICAL.md`](docs/TECHNICAL.md) |
| 自己从源码构建 | [`docs/BUILD.md`](docs/BUILD.md) |
| 开发约定、目录结构、测试怎么加 | [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) |
| 已知问题（8 条，含取舍理由） | [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md) |
| 不变量 R1–R22、验证矩阵、断言纪律 | [`bd2-local-viewer/ARCHITECTURE.md`](bd2-local-viewer/ARCHITECTURE.md) |
| 测试套件与自检脚本 | [`bd2-local-viewer/_test/README.md`](bd2-local-viewer/_test/README.md) |
| 2026-09-25 的代码审计快照 | [`docs/AUDIT-REPORT.md`](docs/AUDIT-REPORT.md)（**故意不更新**：那是历史快照） |
| 第三方许可与署名 | [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) / [`LICENSE`](LICENSE) |

---

## 8. 仓库与开源状态

- 远端：<https://github.com/kakiko123/BD2Viewer>（MIT，版权人 kakiko123）。
- **`origin/main` 现在停在 v1.05**（提交 `c6214c1`）。v1.06 / v1.07 两轮改动都在本地工作区没提交：

  | 未提交内容 | 说明 |
  |---|---|
  | v1.06 前端改动 | `public/app.js`（R19 两层角色归组 + 叠层渲染 + 缩略图叠层）、`styles.css`（`#playerBackHost`）、`index.html`（若有） |
  | v1.06 测试 | `format_check`（+2）、`e2e`（+5）、`native_mode`（+4 ㉙）、`bundle_check` / `e2e` 两条过期断言修正 |
  | v1.06 文档 | `RELEASE-NOTES-v1.06.md`、ARCHITECTURE（R19 + 矩阵 323）、`docs/TECHNICAL.md` §4.8.4、README、本文件 |
  | 版本号 | `app/build.gradle` versionCode 8→9 / versionName 1.05→1.06、`package.json` |
  | v1.07 改动 | NIKKE 整包自动解包（`_tools/nikke_extract.py` + `nikke_ab_support.mjs` + `jczx/NikkeAbExtractor.java`）、解包进度提示、`RELEASE-NOTES-v1.07.md`、版本号 1.07/vc10 |
  | 产物 | `BD2Viewer-debug.apk`（1,446,278 B）、`assets/web/*` 已同步 |

- **根目录还躺着上一轮同步留下的临时文件**（未跟踪，别误加进提交）：
  `_PHASE_A_BOX_NOTES.md`、`_SYNC_BACKUP_NOTE.txt`、`_sync_sha256.txt`、
  `_kakiko-BD2Viewer-sync-20261001.{zip,tar.gz}`、`_sync_from_box.zip`、
  `_sync_preserve_live/`、`_sync_preserve_backup/`。要么删掉、要么挪进 `_scratch/`。

- 不进仓库：`local.properties`、`gradle.local.properties`、`viewer.config.json`、keystore、
  `/toolchain/`、`/_scratch/`、`/.workbuddy/`、`build/`、`.gradle/`、APK、测试截图。
  必须进：`public/app.bundle.html`、`gradle-wrapper.jar`、`assets/web/*`。
- 首个版本上传时踩过的两个坑已固化在 `.gitattributes` / `.gitignore`：
  `gradlew` 要 `git update-index --chmod=+x`，`push_to_github.bat` 纯 ASCII + CRLF 且必须留在 `.gitignore`。
- 署名（不可删）：`README.md`、`THIRD-PARTY-NOTICES.md`、`LICENSE`、`app.js` 头部注释、帮助弹窗。
  本项目基于 [Jelosus2/BD2-L2D-Viewer](https://github.com/Jelosus2/BD2-L2D-Viewer)（MIT, (c) 2025）构建，
  源码为独立重写；NIKKE 的组织方式参考了 [Nikke-db/nikke-db-vue](https://github.com/Nikke-db/nikke-db-vue)。

---

## 9. 已知问题与取舍

八条都在 `docs/KNOWN-ISSUES.md`，其中三条说明性的取舍值得在这里重复：

1. **测试依赖真实素材**（`e2e` / `native_mode`）：仓库不放素材，所以那两套只能在有素材的机器上全绿；
   需要特定素材的断言会自动跳过。
2. **`app.js` 是约 5300 行的单文件**：不拆的理由见 §4；触发拆分条件是「需要两人以上同时改它」或
   「单次改动的回归超过 3 处」。
3. **`android:allowBackup="true"` / `usesCleartextTraffic="true"`**：前者方便换机、后者是本地 127.0.0.1
   明文请求所需；都是有意为之，不是遗漏。

其它五条：SAF 授权目录拿不到文件修改时间、MediaStore 扫描通路当前不可达、没有 CI、首次进大目录会慢。

---

## 10. 下一步

**待办（需要你点头才能做的对外动作）**

1. 提交 v1.06 这一轮（前端 R19 + 测试 + 文档 + 版本号 + APK），**显式列出要提交的文件**，
   别 `git add -A`（根目录有一批上一轮同步留下的临时文件，见 §8）；
2. 推送 `main`，按版本建 GitHub Release（附 APK 与 SHA-1）；
3. 之后每个版本的常规闭环：改前端 → bundle → sync → 全量测试 → clean 构建 → `verify_apk.py` → 提交发版。

**顺手清一下（可选）**：根目录那批 `_sync*` / `_PHASE_A_BOX_NOTES.md` 临时文件挪进 `_scratch/` 或删掉。

**路线图（README §4 里已写明方向）**

- 视觉上向 BD2 客户端靠拢（配色、字体、圆角、按钮与弹窗语言），功能不变；
- 继续纳更多游戏的导出方式；**NIKKE 的 4.0 JSON 骨架目前不在支持范围内**（只覆盖二进制 `.skel`），
  遇到再补；
- 造一套合成的测试资产，让「依赖真实素材」的那两套也能在任意机器上跑；
- 按目录批量导出。

---

*本文是 2026-09-30 的状态快照。改完一个版本后，§2 的版本表与 §6 的测试项数需要跟着更新。*

## 9. 需求 1+2（2026-10-01 箱内）

- **基线**：PC `C:\Users\KAKIKO\WorkBuddy\2026-09-21-22-05-24` → 箱 `/workspace/kakiko-BD2Viewer`（保留原 `viewer.config.json`）。
- **需求 1**：NIKKE 解包包级并发 ≤ 10 + 优先级队列（桌面/安卓）；点开未解包卡抬队首。
- **需求 2**：解包/扫描/缩略图/打开单资产均有真实进度 UI（无假进度）。
- **需求 7**：未改 version（仍 1.07 / 10）。未回同步 PC、未打 APK。

## 10. 需求 3+4+5（2026-10-01 箱内）

- **需求 3**：卡片主体 click → 播放；拖拽排序只从 ⠿；两端同一状态机；700ms click 抑制保留。
- **需求 4**：预乘默认 bd 开 / lostsword·nikke·jczx 关；切模式套默认；变更重建播放器。
- **需求 5**：离屏后写 atlas 同目录 `thumb.png`；扫描 mtime 新鲜则跳过队列；安卓删除补 relThumb。
- **需求 7**：未改 version（仍 1.07 / 10）。已 `bundle` + `sync_assets`；未回同步 PC、未打 APK。

## 11. 加载 UX + stage null 崩溃（2026-10-01 箱内）

- **打开崩溃**：`setLoadProgress(null)` 解构 null → stage 报错 → BD2/NIKKE 等任意打开失败；已改为无参/`opts||{}`。
- **就绪即显**：去掉 prepareRoot 首波 ~12s 同步等待；进度条非阻塞 overlay；占位卡不挡就绪卡。
- **需求 7**：仍 1.07 / vc 10。未回同步 PC、未打 APK。
