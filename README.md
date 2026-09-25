# BD2 L2D Viewer

一个**本地**的 Spine（俗称 L2D）动画查看器。它扫描你硬盘 / 手机上的 Spine 资产目录，
把 `.atlas` + `.json/.skel` + 贴图识别成一套套可播放的资产，然后播放、切动画、切皮肤、
显隐图层、截图和导出。

同一份前端代码，两种运行方式：

| 形态 | 跑在哪 | 数据从哪来 |
|---|---|---|
| **桌面版** | 本机 Node 服务（只监听 `127.0.0.1`），浏览器打开 | 读你配置里声明的目录 |
| **Android APK** | 手写的 WebView 壳（无框架） | 读手机存储 / 你授权的目录 |

---

## ⚠️ 手机端（APK）必读：装完还得做两件事，否则用不了

Android 11+ 的分区存储限制下，**App 没法自己在手机存储根目录建文件夹**（系统会静默拒绝），
也没法直接读别人的目录。所以这两件事必须由你来做：

**① 自己建一个放模组的文件夹**

用任意文件管理器，在手机存储里建一个文件夹（比如「内部存储」根目录下的 `BD2Viewer`，
或者你已经在用的模组目录，例如 `.BD2_Mods`），把资产按「**一个子文件夹 = 一套资产**」放进去。

**② 给 App「所有文件的访问权限」**

`设置 → 应用 → BD2Viewer → 权限 → 所有文件访问权限 → 允许`。
这是**特殊权限**，系统不允许 App 弹窗申请，只能你自己去开 ——
App 里的「打开权限设置」按钮会直接把你送到那一页。

不给会怎样：App 会退回自己的专属目录（卸载即删、文件管理器进不去），
或者只能用「添加目录」走系统文件夹选择器逐个授权 —— 能用，但很别扭。

做完这两步，回到 App 点「重新扫描」就能看到资产了。详细步骤见 [§9.2 Android](#92-android)。

---

> **它不含任何游戏素材。** 仓库里没有角色图、骨骼、语音，一个都没有 ——
> 它只读取你机器上已有的文件。见 [§12 注意事项](#12-注意事项)。

> **本项目基于 [Jelosus2/BD2-L2D-Viewer](https://github.com/Jelosus2/BD2-L2D-Viewer) 构建。**
> 功能形态、交互设计与资产的组织方式都来自该项目（MIT License，Copyright (c) 2025 Jelosus2）。
> 代码是**独立重写**的 —— 上游是 Vue 3 + TypeScript + Vite，本项目是原生 JS + 手写的 WebView 壳，
> **没有复制它的源码**；在此基础上把数据源换成了扫描本地目录，并加上了桌面 Node 宿主与 Android 套壳。
> 详见 [§12.1 上游项目与致谢](#121-上游项目与致谢) 与 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

---

## 目录

1. [项目简介](#1-项目简介)
2. [界面截图](#2-界面截图)
3. [下载 APK](#3-下载-apk)
4. [技术栈](#4-技术栈)
5. [项目结构](#5-项目结构)
6. [环境要求](#6-环境要求)
7. [配置方法](#7-配置方法)
8. [编译 / 运行](#8-编译--运行)
9. [使用方法](#9-使用方法)
10. [主要实现思路](#10-主要实现思路)
11. [开发与测试](#11-开发与测试)
12. [注意事项](#12-注意事项)
13. [已知问题](#13-已知问题)
14. [后续计划](#14-后续计划)
15. [开源许可](#15-开源许可)

---

## 1. 项目简介

做这个东西有两个起因。

**一是想在本地翻自己的 mod。** Spine 资产在游戏里只能按游戏安排的方式看，
想在本地把那一堆 mod 目录里的动画翻出来逐个对比、截图，没有趁手的工具。

**二是为了更好地管理 [BDroid_X](https://github.com/Ark-Repoleved/BDroid_X) 里注入的模组。**
BDroid_X 是一个**免 PC 的安卓端 BD2 模组管理器**：它在手机上解包、转纹理（ASTC）、
重打包并注入模组。它要求你把模组放在一个**模组源目录**里（官方推荐内部存储下的
`.BD2_Mods`，每个模组一个子文件夹，内含 `.skel`/`.json` + `.atlas` + `.png`）。

问题在于：**那个目录一旦攒起来就没法看了。** BDroid_X 只能长按单个模组预览一下动画，
想知道「我到底装了哪些」「这套是不是我要的」「哪几套该删了」，只能靠记性和文件名。
本项目就是把这个模组源目录直接当根目录扫进去：整页平铺缩略图、逐个看动画和皮肤、
拖动排序、多选批量删除 —— 注入之前先挑清楚，比在注入器里一个个长按快得多。

> 两者是**独立的工具**，本项目与 BDroid_X 无隶属关系、未获其背书，
> 也不参与任何注入 / 打包行为 —— 它只是**只读**你指定的那个目录。
> BDroid_X 需要 Shizuku 才能把文件送进游戏目录；本工具不需要，给个目录就能看。

于是有了它：

- **资产从哪来**：扫描本地目录。不下载、不联网、不上传。
- **一套资产是什么**：同一目录下的一个 `.atlas` + 同名的 `.json`（或 `.skel`）+ atlas 里引用到的贴图。
  缺哪样会明确标出来（列表里能看到「缺少骨架文件」「atlas 引用了不存在的图：xxx.png」）。
- **两种形态为什么要都要**：桌面上批量整理 / 对比方便（大屏、键盘快捷键、导出）；
  手机上随手翻看方便（长按批量删、音量键切动画）。
- **前端的形态**：**只有一份** `public/`。桌面版直接用，APK 版被内联成单文件后塞进 WebView。

### 主要功能一览

**浏览** — 左侧资产列表（按目录分组）+ 平铺卡片墙（带缩略图）；
搜索过滤、只显示可播放的、按 手动顺序 / 名称 / 日期 排序；卡片可拖动排序。

**播放** — 动画列表 / 皮肤下拉 / 图层列表（可显隐、可点选模型上的图层）/
播放暂停与速度 / 相机缩放平移 / 重置视图 / 背景色 / 每帧步进。

**输出** — 2K 截图（PNG，可带透明通道）/ 导出帧序列 ZIP / 导出 WebM 视频；
截图与导出可选「用当前镜头」和「截边长上限」。

**管理** — 长按（或右键）进入多选，批量删除整**套**资产（atlas + 骨架 + 贴图一起删），
删完顺手清空目录。桌面版删的是真文件，有二次确认。

**全屏 / 手机外壳** — 全屏模式：顶栏 ◀▶ 切资产、底栏 ◀▶ 切动画、音量键切动画、保持屏幕常亮；
手机上有底部标签栏与底部抽屉；返回键按「当前压着哪一层」逐层退出。

---

## 2. 界面截图

> **本仓库不附带任何截图。**
> 截图必然要用到真实的 L2D 资产，而那些资产是**需要付费获得**的，
> 其中一部分内容也不适合公开传播。把它们放进截图再公开，等于在分发受版权保护的素材，
> 既超出了购买时的授权范围，也可能违反所在平台的内容规则。
> 所以一张都不放 —— 这也是开头「它不含任何游戏素材」那条的延续。

想看实际界面，两条路：

- **自己跑起来看**：clone 后按 [§8 编译 / 运行](#8-编译--运行)，
  最快只要 `node bd2-local-viewer/server.mjs`，浏览器打开就是你自己的资产。
- **自己生成截图**：`node bd2-local-viewer/_test/shot_native.mjs`
  会对你**本机**的资产生成一组界面图（输出到 `_test/`，已被 `.gitignore` 排除，不会误提交）。

> 自己生成的图请自行保管。**不要**把含游戏素材的截图提交到公开仓库、
> 贴到 issue / README / 社交平台 —— 那和分发素材是同一件事。

想了解界面长什么样，可以看 [主要功能一览](#主要功能一览) 与
[§9 使用方法](#9-使用方法)，功能与布局在那里是文字描述的。

---

## 3. 下载 APK

不想自己编译的话，直接装现成的：

- **最新版**：<https://github.com/kakiko123/BD2Viewer/releases/latest>
- **全部版本**：<https://github.com/kakiko123/BD2Viewer/releases>

| 项 | 值 |
|---|---|
| 文件 | `BD2Viewer-debug.apk` |
| 要求 | Android 8.0（API 26）及以上 |
| 安装 | 传到手机上点开即可，需要允许「安装未知来源应用」 |
| 校验 | 每个 release 都附了文件大小与 SHA-1，装之前可以自己对一下 |

> 目前发布的是 **debug 构建**（`assembleDebug`，签名用的是 AGP 自动生成的调试密钥）。
> 功能和自己编译的 release 包完全一致，只是包名与签名不是正式发布用的。
> 要正式的 release 包，请自己生成 keystore 后按 [§7.3](#73-签名凭据只有发正式包时才需要) 配置再构建。

装完之后**别忘了做开头那两件事**（建文件夹 + 给「所有文件访问权限」），
否则 App 只能读它自己的专属目录。

---

## 4. 技术栈

刻意做得**几乎没有依赖** —— 这是能把它塞进 APK 且长期不用维护的前提。

### 前端（`bd2-local-viewer/public/`）

| 组件 | 作用 | 版本 |
|---|---|---|
| 原生 JS（单文件 `app.js`） | 全部界面逻辑。**没有框架、没有构建步骤、没有 npm 依赖** | 约 4000 行 |
| [Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes) `spine-player` | 解析 `.atlas` / `.json` / `.skel` 并渲染（WebGL） | 4.1.55 |
| [JSZip](https://github.com/Stuk/jszip) | 导出帧序列时打包成 zip | 3.10.1 |
| 原生 HTML + CSS | 布局与主题 | — |

两个库以**发行版文件**的形式直接放在 `public/lib/`（不用 npm 装，也不用打包器）。
理由见 [§10.3](#103-为什么把库直接放进仓库)。

### 桌面宿主

| 组件 | 说明 |
|---|---|
| Node.js 内置模块 | `server.mjs` 只用 `http` / `fs` / `path` / `net` 等内置模块。**运行期零依赖** |
| 职责 | 静态托管 `public/`；扫描配置里的 `roots`；用 `/spine/<rootId>/<rel>` 把本地文件喂给浏览器 |

### Android 宿主

| 项 | 值 |
|---|---|
| 语言 / 构建 | Java 17，Gradle 8.7 + AGP 8.5.2 |
| minSdk / targetSdk / compileSdk | 26 / 34 / 34 |
| `androidx.*` | **不使用**（`android.useAndroidX=false`）。纯手写 Activity + WebView |
| 组成 | `MainActivity`（壳、全屏、返回键、文件/目录选择）、`NativeBridge`（JS 桥）、`ScanEngine`（扫描/删除/导入）、`Host`（`shouldInterceptRequest` 里消化所有资源请求）、`KeepAliveService`（前台服务保活） |

### 测试与工具（`bd2-local-viewer/_test/`、`_tools/`、`tools/`）

| 组件 | 说明 |
|---|---|
| 无测试框架 | 测试是普通 Node 脚本，通过 CDP（Chrome DevTools Protocol）驱动无头 Chrome |
| `_test/cdp.mjs` | 自己写的 ~110 行 CDP 客户端（用 Node 22 内置的 `WebSocket`） |
| `_tools/bundle.mjs` | 把 CSS/JS 内联成单文件 `app.bundle.html` |
| `_tools/sync_assets.mjs` | 把产物同步进 APK 的 `assets/web/`，并比对 sha1 |
| `tools/verify_apk.py` | 拆开 APK 验证：资源三方 sha1 一致、清单里 `screenOrientation=fullUser` |

---

## 5. 项目结构

```
.
├── README.md
├── LICENSE                       # MIT
├── THIRD-PARTY-NOTICES.md        # ★ 第三方许可声明，Spine 许可要求它随分发走，不可删
├── .gitignore
│
├── docs/
│   ├── BUILD.md                  # 构建说明（含「为什么别人 clone 后跑不起来」的排查清单）
│   └── DEVELOPMENT.md            # 开发说明：测试怎么写、改代码的注意事项
│
├── tools/
│   ├── build_apk.bat             # 一键：bundle → gradlew assembleDebug → verify
│   └── verify_apk.py             # APK 复验（三方 sha1 + 清单）
│
├── bd2-local-viewer/             # 前端（唯一一份）+ 桌面宿主
│   ├── server.mjs                # 桌面服务：静态托管 + 扫描 + /spine 取文件
│   ├── start.bat                 # Windows 双击启动（纯 ASCII，见 docs/DEVELOPMENT.md）
│   ├── package.json
│   ├── viewer.config.example.json  # 配置示例 → 复制成 viewer.config.json
│   ├── ARCHITECTURE.md           # ★ 分层调用链 + 10 条不变量，改代码前先看
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

---

## 6. 环境要求

| 用途 | 需要 |
|---|---|
| 只看桌面版 | **Node.js 18+**（推荐 22 LTS）。不需要装任何 npm 包 |
| 编译 APK | **JDK 17** + **Android SDK**（platform 34 + build-tools 34）。Gradle 由 wrapper 自带，不用单独装 |
| 跑测试 | **Node.js 22+**（用到全局 `WebSocket`）+ **本机装有 Google Chrome** |
| APK 复验 | Python 3.8+（只用标准库）+ `aapt2`（Android SDK 自带） |
| 用 APK（不编译） | Android 8.0+，见 [§3 下载 APK](#3-下载-apk) |

Android SDK 里需要的东西：

```
platforms;android-34
build-tools;34.0.0
platform-tools
```

---

## 7. 配置方法

配置分三块，**互不影响，按需改**。

### 7.1 桌面版：`bd2-local-viewer/viewer.config.json`

决定「服务允许读哪些目录」。**没配的话桌面版起来是空的。**

```bash
cd bd2-local-viewer
cp viewer.config.example.json viewer.config.json
```

然后编辑 `roots`：

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
>
> 如果你的资产是给 [BDroid_X](https://github.com/Ark-Repoleved/BDroid_X) 准备的模组源目录
> （比如内部存储下的 `.BD2_Mods`），把它整个加进来就行 ——
> 里面「一个子文件夹 = 一套模组」的结构正好是本项目的识别方式。

### 7.2 Android：文件夹 + 权限（**必做**）

APK **不需要任何配置文件**，但需要你先在手机上准备一个目录并授权：

| 步骤 | 做什么 | 不做会怎样 |
|---|---|---|
| ① 建文件夹 | 用文件管理器在手机存储里建一个目录，例如「内部存储」根目录下的 `BD2Viewer`，或直接用你已有的模组目录（如 `.BD2_Mods`）。**一个子文件夹放一套资产** | App 在 Android 11+ 上**建不出来**（分区存储会静默拒绝），只能退回自己的专属目录 |
| ② 给权限 | `设置 → 应用 → BD2Viewer → 权限 → 所有文件访问权限 → 允许`（App 里「打开权限设置」会直接跳过去） | 读不到外部目录，只能逐个用「添加目录」走系统文件夹选择器授权 |
| ③ 放资产 | 数据线 / 文件管理器拷进去，或在 App 里用「导入文件」 | 目录是空的，扫描自然没结果 |

**目录的三种来源**，任选：

| 来源 | 说明 |
|---|---|
| `/sdcard/BD2Viewer` | 默认入口。用文件管理器 / 数据线都能直接放文件进去。**需要「所有文件访问权限」** |
| 自己选的目录 | 点「添加目录」用系统文件夹选择器授权任意目录（会拿到持久化 URI 授权），不用把文件拷来拷去 |
| App 专属目录 | 前两条都拿不到时的兜底，随 App 卸载而删除 |

> Android 11+ 的「所有文件访问权限」是**特殊权限**，系统不允许 App 弹窗申请，
> 只能你自己去设置页开 —— 这是 Android 的规定，不是本 App 偷懒。

### 7.3 签名凭据（只有发正式包时才需要）

```bash
cd bd2-android
cp gradle.local.properties.example gradle.local.properties
# 填 RELEASE_STORE_FILE / RELEASE_STORE_PASSWORD / RELEASE_KEY_ALIAS / RELEASE_KEY_PASSWORD
```

不配也能用 —— `assembleDebug` 的调试签名由 AGP 自动生成；`assembleRelease` 会产出**未签名**包。

---

## 8. 编译 / 运行

### 8.1 桌面版（最快能跑起来的路径）

```bash
git clone https://github.com/kakiko123/BD2Viewer.git
cd BD2Viewer/bd2-local-viewer

# 先按 §7.1 配好 viewer.config.json，然后：
node server.mjs                 # 或 npm start
# 或
node server.mjs --open          # 顺手打开浏览器
```

**不需要 `npm install`**（桌面服务只用 Node 内置模块，两个前端库已经放在 `public/lib/`）。

Windows 上也可以直接双击 **`bd2-local-viewer/start.bat`**（会自动找 Node，找不到会提示）。

浏览器打开 `http://127.0.0.1:8137/`。

### 8.2 编译 APK

**前置**：装好 JDK 17 和 Android SDK，并让 Gradle 知道 SDK 在哪 —— 在 `bd2-android/`
下建一个 `local.properties`（Android Studio 打开工程时会自动生成）：

```properties
sdk.dir=C:/Users/你的用户名/AppData/Local/Android/Sdk
# 如果你的 JDK 不在 JAVA_HOME 上，再加一行：
# org.gradle.java.home=C:/Program Files/Java/jdk-17
```

然后：

```bash
cd bd2-local-viewer && node _tools/bundle.mjs && node _tools/sync_assets.mjs   # ① 打包前端
cd ../bd2-android && ./gradlew.bat assembleDebug                               # ② 编译（macOS/Linux 用 ./gradlew）
python ../tools/verify_apk.py                                                  # ③ 复验（可选但强烈建议）
```

产物：`bd2-android/app/build/outputs/apk/debug/app-debug.apk`
（`verify_apk.py` 会顺手把它复制成仓库根目录的 `BD2Viewer-debug.apk`）

Windows 上等价的一键脚本：**`tools/build_apk.bat`**（三步都做）。

> **① 那一步不能省。** `gradle` 的 `syncWeb` 任务只做「原样拷贝」，
> 它不会重新内联。改了 `public/` 而不跑 `bundle.mjs`，装到手机上还是旧界面 ——
> 这个坑踩过好几次，所以 `verify_apk.py` 会比对资源 sha1，对不上直接报错。

### 8.3 安装到手机

```bash
adb install -r bd2-android/app/build/outputs/apk/debug/app-debug.apk
```

或者把 `BD2Viewer-debug.apk` 传到手机上点开安装（需允许「安装未知来源应用」）。

装完继续看 [§9.2 Android](#92-android)。

### 8.4 跑测试

```bash
cd bd2-local-viewer
node _test/run_all.mjs
```

需要 Node 22+、本机有 Chrome、以及 §7.1 里配好的真实资产目录（原因见下）。

---

## 9. 使用方法

### 9.1 桌面版

1. 按 §7.1 配好 `roots`，启动服务。
2. 左栏是资产列表（按目录分组），右边是平铺卡片墙。缩略图是**后台逐个生成**的，
   首次进一个大目录会一张张冒出来，属正常现象（生成过的会缓存）。
3. 点任意一张卡片进入播放页。
4. 播放页左侧是动画列表 / 皮肤 / 图层；底部是播放控制与速度；右侧是截图与导出。
5. 要批量删：在卡片墙或列表里**长按（或右键）**进入多选 → 勾选 → 删除。
   删的是**磁盘上的真文件**，确认框会列出将被删掉的完整文件清单。

**键盘快捷键**（与 App 内帮助一致）：

| 键 | 作用 | 键 | 作用 |
|---|---|---|---|
| 拖拽 / 滚轮 | 平移 / 缩放视图 | `L` | 切换图层选择模式 |
| 空格 | 播放 / 暂停 | 点击模型 | 图层选择模式下选中该图层 |
| ← / → | 后退 / 前进一帧 | `H` | 隐藏选中的图层 |
| `R` | 重置视图 | `U` | 恢复上一次隐藏 |
| `F` | 适配窗口 | `Esc` | 还原全部隐藏 |
| `[` / `]` | 上一套 / 下一套动画 | ↑ / ↓ | 上一个 / 下一个动画 |

**深链**：`http://127.0.0.1:8137/?item=<relAtlas>` 可以直接打开某一套资产
（`relAtlas` 就是列表项里那个相对路径）。

### 9.2 Android

**先确认 §7.2 那两步做完了**：手机存储里有你自己的资产文件夹，且「所有文件访问权限」已开。

1. **放资产**：把套件拷进你的目录（每个子文件夹放一套），或者在 App 里点「导入文件」直接选文件拷进去。
2. **加目录**（可选）：如果你的资产不在默认目录里，点「添加目录」用系统文件夹选择器选中它。
3. **重新扫描**：回到 App 点「重新扫描」。顶部状态条会显示当前用的是哪个目录；
   拿不到外部目录时它会**明确写出原因**（通常是「系统拒绝了在手机存储根目录建文件夹」），
   这时点「打开权限设置」去开权限。
4. 剩下的交互和桌面版一致。差别在：
   - **返回键**按层级退出：确认框 → 各弹窗 → 全屏侧栏 → 底部抽屉 → 批量选择 → 全屏 → 播放页 → 才退 App。
   - **全屏时音量键**切上一个 / 下一个动画（方向可在设置里改）。
   - 底部 ◀◀ / ▶▶ 切**资产**，画面两侧箭头切**动画**。
5. 导出 / 截图落在 `Downloads/BD2Viewer/`。

**排查清单**：扫不到东西时，按顺序看这三条 ——

| 现象 | 原因 |
|---|---|
| 顶部写着「系统拒绝了在手机存储根目录建文件夹」 | 缺「所有文件访问权限」，或那个目录确实还没建 |
| 目录里有文件但列表为空 | 文件没按「一个子文件夹 = 一套」放，或缺少 `.atlas` / 骨架文件（列表会标出来） |
| 只能看到 App 专属目录 | 权限没开。要么去开权限，要么用「添加目录」授权你那个文件夹 |

---

## 10. 主要实现思路

只讲几个「不知道就很容易做错」的点。更完整的复盘见
[`bd2-local-viewer/ARCHITECTURE.md`](bd2-local-viewer/ARCHITECTURE.md)。

### 10.1 一份前端，两个宿主

前端只有一份，靠一个常量判断自己在哪：

```js
const NATIVE = !!window.BD2Native     // APK 里由 addJavascriptInterface 注入
```

数据源分叉被**限制在少数几处**（扫描 / 删除 / 导入 / 配置 / 存储诊断），
其余代码完全不知道宿主是谁。ARCHITECTURE.md 把这写成了不变量 R9，
新增分叉点必须在文档里登记 —— 否则「同一件事两处真相」的 bug 会复现。

### 10.2 APK 里为什么要把所有东西内联成单文件

WebView 里托管本地资源有两条路：`shouldInterceptRequest` 拦请求，或者手喂字符串。
前者在**某些 WebView 版本上会失效**，一旦失效，主文档拿不到正确的 `Content-Type`，
就会被当纯文本渲染 —— 用户看到的是满屏源码。

所以走后者：`bundle.mjs` 把 CSS/JS 全部内联成一个
`app.bundle.html`，用 `loadDataWithBaseURL()` 注入。这样主文档和它的子资源都不依赖拦截链路，
只剩 `/spine/` 下的资产数据还需要它。

坐标与资源都是同源（`https://bd2.local`），所以 WebGL 贴图能直接上传，没有跨域问题。

### 10.3 为什么把库直接放进仓库

`spine-player.js` / `jszip.min.js` 是**发行版文件**，直接放在 `public/lib/`。

- 不用 npm install，不用打包器 → clone 下来就能跑；
- APK 构建少一个环节，也少一类「本地能跑、别人跑不了」的失败；
- `jszip.min.js` 有一个已知的原始缺陷需要在本地打补丁（见 §10.4），
  用 npm 装反而每次都要重新打。

代价是仓库里多了 ~690KB 的文件，以及升级库要手动替换 + 重跑测试。
这个权衡是有意的。

### 10.4 打了补丁的第三方库

`public/lib/spine-player.js` 里有**一处本地修改**（`bundle_check.mjs` 有断言守着它）：

官方 `Input` 类里有两处 `let dy = this.touch1.x - this.touch0.x` ——
用 `x` 算 `dy`，是复制粘贴笔误。后果是横向双指捏合时初始距离被算成 `√2·|dx|`，
**越捏大画面反而越小**。已改成 `.y`。

换库 / 升级版本时这条修改会丢，测试会立刻报出来。

### 10.5 首屏必须被「钉死」

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

### 10.6 返回键：宿主只问不猜

「现在在哪一层」的知识如果写死在 Java 里，就必然漏 ——
弹窗、抽屉、选择模式、视图层级，Java 全不知道。结果是用户在播放页按返回，App 直接退了。

现在前端出**唯一入口** `handleBack()`，由内到外逐层剥，返回 `true` 表示「这次返回我消化了」；
Java 只负责问（`evaluateJavascript`），拿不到 `true` 就走自己的兜底。

配套的一个坑：异步确认弹窗必须留一个 `handleBack()` 能调到的取消入口
（`mask.__cancel = () => done(false)`），否则弹窗被关掉了却没人 resolve，整个流程永远挂住。

### 10.7 扫描预算

选中 `/sdcard` 根目录时面对的是几万个目录。扫描因此有三道闸：
最大深度、最多目录数（4000）、总时长预算（45s）。超了会在结果里标记 `truncated`。

同时扫描结果**不整体推给 JS**：只推元信息（几十字节），条目由前端分页同步拉取。
早先一次性推几 MB 的 JSON 会把 WebView 进程压崩。

---

## 11. 开发与测试

要点摘录，完整版见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)，
测试目录的逐个文件说明见 [`bd2-local-viewer/_test/README.md`](bd2-local-viewer/_test/README.md)。

```bash
cd bd2-local-viewer
node _test/run_all.mjs                 # 全部
node _test/run_all.mjs bundle_check    # 单个（名字可写前缀）
node _test/run_all.mjs --keep          # 跑完不关自己起的服务
```

| 套件 | 项数 | 需要真实资产 | 守住什么 |
|---|---|---|---|
| `manifest_check.mjs` | 6 | 否 | `screenOrientation=fullUser`、`configChanges`、`minSdk` |
| `bundle_check.mjs` | 18 | 是 | 产物自检：id 一致、内联、遮罩注入、无外链、无控制台报错 |
| `bundle_firstpaint.mjs` | 7 | 是 | 产物首屏第一帧就是资产页、深链仍进播放页 |
| `delete_api.mjs` | 12 | 否（自带临时目录） | 真删磁盘、路径越界必须被拒 |
| `e2e.mjs` | 24 | 是 | 加载 / 相机取景 / 图层 / 截图 / 导出 |
| `native_mode.mjs` | 155 | 是 | 假桥下的整条原生通路（最全的一套） |

改完前端务必走一遍：`bundle.mjs` → `run_all.mjs` → `assembleDebug` → `verify_apk.py`。

---

## 12. 注意事项

### 12.1 上游项目与致谢

本项目**基于 [Jelosus2/BD2-L2D-Viewer](https://github.com/Jelosus2/BD2-L2D-Viewer) 构建**，
不是从零开始的原创设计。必须先说清楚这一点。

**来源与授权**

| 项 | 内容 |
|---|---|
| 上游仓库 | <https://github.com/Jelosus2/BD2-L2D-Viewer> |
| 上游作者 | [Jelosus2](https://github.com/Jelosus2) |
| 上游许可 | **MIT License，Copyright (c) 2025 Jelosus2** |
| 上游定位 | Web-based interactive Live2D and Spine animation viewer for Brown Dust 2 |

**本项目继承了什么**

- **功能形态**：动画列表 / 皮肤切换 / 播放与速度 / 缩放平移 / 图层显隐与点选 / 背景 / 截图 / 导出
  —— 这套「要看什么、怎么操作」的设计来自上游，本项目是在它的功能集上把体验补完。
- **资产的组织方式**：怎么把一堆散文件（`.atlas` + `.json`/`.skel` + 贴图）识别成「一套可播放的资产」，
  这个思路沿用上游。
- **技术选型的起点**：`spine-player 4.1.55` 与 `jszip` 的版本跟随上游。

**本项目改了什么（独立实现的部分）**

- **代码是重写的，没有复制上游源码。** 上游是 **Vue 3 + TypeScript + Vite + Pinia + Tailwind**，
  本项目是**原生 JavaScript**（`public/app.js` 单文件），宿主也是手写的（Node `server.mjs` + 手写 WebView 壳）。
  两边没有共享的代码文件。
- **数据源换了**：上游是「网站 + 预先整理好的在线资产」，本项目改成**扫描你本机的目录**，
  并支持手动上传 Spine 文件。
- **加了上游没有的宿主形态**：桌面 Node 服务、Android WebView 套壳（含 SAF 授权扫描、
  批量删除、导入 zip、导出 WebM、排序、缩略图队列与持久化缓存等）。

**致谢**

感谢 [Jelosus2](https://github.com/Jelosus2) 把这个查看器做出来并开源 ——
本项目的功能清单、交互设计和「把散文件认成一套资产」的思路都来自它。
如果你喜欢这类工具，建议也去上游仓库看看（它是在线的、资产更全）。

> 上游许可是 MIT，因此只要保留版权与许可声明即可自由使用、修改、再分发。
> 本项目在 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 里保留并附上了上游的完整许可原文。

### 12.2 关于 Spine 运行时授权（**请务必了解**）

本项目随仓库分发了 Esoteric Software 的 **Spine Runtimes**。
它的许可**允许**这样分发，但有两条硬性条件：

1. **每一位使用者都需要自己拥有一份 Spine Editor 授权。**
   用本项目查看 / 播放 Spine 资产的人，需要自行到
   <https://esotericsoftware.com/> 获取授权。本项目**不包含、也不能代替**这份授权。
2. **任何形式的分发都必须附带许可与版权声明** ——
   也就是本仓库的 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
   如果你 fork 或再分发，**不要删掉它**。

（`spine-player.js` 是压缩产物，文件头本身不含许可声明，所以那个文件是唯一的声明载体。）

### 12.3 游戏素材与商标

- 仓库**不包含任何游戏素材**，只读取你本机已有的文件。
  **也不要往仓库 / issue / 讨论区里贴素材或含素材的截图**（见 [§2 界面截图](#2-界面截图)）。
- **Brown Dust 2** 及其素材版权归 **NEOWIZ**；**Spine** 是 Esoteric Software LLC 的商标。
- 本项目是非官方工具，与上述两家公司均无隶属关系，未获其背书。
- 本项目与 [BDroid_X](https://github.com/Ark-Repoleved/BDroid_X) 亦无隶属关系，
  只是读取你自己的模组目录；它不参与任何注入 / 打包 / 修改游戏文件的行为。
- 若要用于商业场景，请自行评估商标与素材合规性。

### 12.4 数据安全

- 桌面服务**只监听 `127.0.0.1`**，且只读 `roots` 里声明过的目录，越界请求会被拒绝。
  请不要把它改成 `0.0.0.0`。
- **删除是不可恢复的**，走的是真实文件删除。App 里已有多选 + 二次确认，
  但请仍然把它当成 `rm` 来对待。
- App 会申请 `MANAGE_EXTERNAL_STORAGE`（「所有文件访问权限」）。
  这是 Android 11+ 直接读手机存储根目录的**唯一**途径，也是这个 App 的核心能力。
  如果你不接受这个权限，App 会退回「App 专属目录」模式，或让你用系统文件夹选择器逐个授权，
  功能受限但仍可用。
  注意：这个权限在 Google Play 上架审核很严，不适合直接上架 Play。

### 12.5 首次进大目录会慢

缩略图是逐个生成的，且部分资产需要完整解码才能出图。
大目录首次进入会看到图片一张张冒出来，之后有缓存。这是刻意的取舍（避免一次性卡死）。

---

## 13. 已知问题

诚实记录，都是已知而未处理的：

1. **测试套件依赖真实资产。** `native_mode` / `e2e` / `bundle_check` / `bundle_firstpaint`
   会去读 `viewer.config.json` 里 `id` 为 `bd2-mods` 的目录，并检查其中特定的几套资产。
   没有这份数据（或资产内容不同）就会失败。自包含的只有 `manifest_check` 和 `delete_api`。
   → 想做「可移植的测试」需要先造一套合成的 Spine 测试资产，目前没做。

2. **`app.js` 是约 4000 行的单文件。** 161→163 个顶层函数共享一批模块级状态。
   为什么不拆：它被内联进一个 `<script>` 走全局脚本语义，拆文件要同时改动打包器、
   assets 同步、APK 资源加载和所有测试的加载方式 —— 收益是「好看」，风险面是全绿测试。
   ARCHITECTURE.md 里写了触发条件（出现第三种宿主时）和拆分边界。

3. **SAF（系统文件夹选择器）授权目录下拿不到文件修改时间**，
   因此这类目录的缩略图缓存不按时间失效（只能靠手动清缓存）。
   MediaStore 那条通路同理。

4. **MediaStore 扫描通路当前不可达。** `ScanEngine.walkMs()` 是早期为
   「完全不申请敏感权限也要读 Downloads」准备的，后来实际采用的是「App 专属目录」兜底，
   所以它一直没接线（只有 `root.kind == "ms"` 才会走到，而没有任何地方会产生这种 root）。
   代码保留着并在注释里写明了怎么启用。

5. **`android:allowBackup="true"`。** 允许通过 `adb backup` 导出应用数据。
   对这个 App（数据都在公共存储，私有数据只有几条偏好设置）影响很小，故未改。

6. **`usesCleartextTraffic="true"`。** 为的是让「桌面版指向本机 http 服务」这种用法成立。
   App 内部走的是 `https://bd2.local`（被本地拦截，不出网），所以并非必需，
   但去掉可能影响个别 ROM 的 WebView 行为，故保留。

7. **没有 CI。** 所有检查都是本地的。加 GitHub Actions 的话，
   Android 部分（`assembleDebug` + `manifest_check`）很容易自动化；
   浏览器那几套需要先解决第 1 条。

---

## 14. 后续计划

没有强计划。下面这些是「如果有人用起来了才值得做」的方向：

- 造一套合成的 Spine 测试资产，让测试套件可移植（顺带能上 CI）；
- 桌面版加多选导出 / 批量重命名；
- 图层预设的保存与分享；
- 把 `app.js` 按 `state / render / nav / host-bridge / bind` 拆开（触发条件见已知问题 2）。

---

## 15. 开源许可

本项目采用 **MIT License**，见 [`LICENSE`](LICENSE)。

**但它不覆盖仓库里的第三方组件**：

| 组件 | 许可 |
|---|---|
| `public/lib/spine-player.js` / `.css` | Spine Runtimes License Agreement（需自持 Spine Editor 授权） |
| `public/lib/jszip.min.js` | MIT 或 GPLv3（本项目按 MIT 使用） |
| **上游项目：本项目基于 [Jelosus2/BD2-L2D-Viewer](https://github.com/Jelosus2/BD2-L2D-Viewer) 构建** | MIT，Copyright (c) 2025 Jelosus2（**未复制其源码**，代码为独立重写；详见 [§12.1](#121-上游项目与致谢)） |

完整声明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

> ✅ `LICENSE` 的版权人已填为 **kakiko123**（2026）。
> 仓库地址：<https://github.com/kakiko123/BD2Viewer>
