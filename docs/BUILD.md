# 构建说明

面向三种人：第一次 clone 想跑起来的人、要出 APK 的人、以及遇到「本地能跑、别人跑不了」的人（看 §6）。

---

## 1. 三种构建产物

| 产物 | 命令 | 产物路径 | 依赖 |
|---|---|---|---|
| 桌面版 | `node server.mjs` | 无产物，直接跑 | Node 18+ |
| `app.bundle.html`（单文件前端） | `node _tools/bundle.mjs` | `bd2-local-viewer/public/app.bundle.html` | Node 18+ |
| debug APK | `gradlew assembleDebug` | `bd2-android/app/build/outputs/apk/debug/app-debug.apk` | JDK 17 + Android SDK |

---

## 2. 环境准备

### 2.1 Node

```bash
node --version      # 需要 >= 18；跑测试需要 >= 22
```

**不需要 `npm install`。** 桌面服务只用 Node 内置模块，前端库已作为发行版文件放在
`bd2-local-viewer/public/lib/`（Spine 运行时是**两套**：`spine-player.js` 4.1.55 +
`spine-player-4.0.js` 4.0.31，见 [`TECHNICAL.md` §4.4](TECHNICAL.md#44-打了补丁的第三方库)）。

`package.json` 里现在只剩 `jszip` 一个可选项 —— 只有你想用 npm 的版本替换掉
`public/lib/` 里的 jszip 时才需要装。**Spine 运行时不在 `dependencies` 里**：
它是随仓库分发的产物，而且 npm 一个包名只能装一个版本，装不出「两套并存」，
所以两套都由 `public/lib/` 提供（`server.mjs` 会优先用 `public/lib/`，
找不到才回落到 `node_modules`）。

### 2.2 JDK + Android SDK

```bash
java -version       # 需要 17
```

Android SDK 需要：

```
platforms;android-34
build-tools;34.0.0
platform-tools
```

让 Gradle 找到 SDK：在 `bd2-android/` 下建 `local.properties`（Android Studio 打开工程时会自动生成，
命令行构建需自己建 —— 这个文件已被 `.gitignore` 忽略，因为它装的是你机器的绝对路径）：

```properties
sdk.dir=C:/Users/你的用户名/AppData/Local/Android/Sdk
# JDK 不在 JAVA_HOME 上时再加一行：
# org.gradle.java.home=C:/Program Files/Java/jdk-17
```

**Gradle 不用单独装**：仓库里带了 Gradle Wrapper（`gradlew` / `gradlew.bat`），
首次运行会自动下载 Gradle 8.7 到 `~/.gradle/wrapper/dists/`。

---

## 3. 完整构建流程（改了前端之后）

顺序不能乱，尤其是第 2 步：

```bash
# ① 把 CSS/JS 内联成单文件（APK 真正加载的就是它）
cd bd2-local-viewer
node _tools/bundle.mjs

# ② 同步进 APK 工程的 assets/web/，并比对 sha1
node _tools/sync_assets.mjs

# ③ 编译
cd ../bd2-android
./gradlew.bat assembleDebug        # macOS / Linux: ./gradlew assembleDebug

# ④ 复验（强烈建议）
cd ..
python tools/verify_apk.py
```

Windows 上 `tools/build_apk.bat` 会把 ①②③**和 ④** 一次做完。

### 为什么第 ① ② 步不能省

`bd2-android/app/build.gradle` 里确实挂了一个 `syncWeb` 任务（`preBuild` 依赖它），
但它只做**原样拷贝** —— 它不知道要不要重新内联。

所以「改了 `public/app.js` → 直接 `assembleDebug` → 装到手机上还是旧界面」是必然会发生的：
`sync_assets` 会把新的 `app.js` 拷过去，但 APK 加载的是 `app.bundle.html`，
而那个文件还是旧的。

这个坑踩过若干次（4 个文件的 sha1 全都不一致），所以：

- `_tools/sync_assets.mjs` 会打印每个文件的 sha1 与状态；
- `tools/verify_apk.py` 会拆开 APK 比对**三方 sha1**（apk 内 / assets / public），对不上直接失败。

### 增量构建的假象

Gradle 的 up-to-date 判断只看输入有没有变。`syncWeb` 会更新 `assets/web/`，
所以正常情况下 `mergeDebugAssets` 会重新执行、APK 会重新打包。

想确认「这次装上去的确实是新代码」，**不要看 APK 体积** ——
这个工程里出现过三次内容不同、字节数完全相同（608377）的情况。
只看 sha1：

```bash
sha1sum BD2Viewer-debug.apk
```

---

## 4. Release 构建

```bash
cd bd2-android
./gradlew.bat assembleRelease
```

**没有配签名的话，产物是未签名的**（`app-release-unsigned.apk`），这是刻意的：
口令不能进仓库。

要签，先建本地凭据文件：

```bash
cd bd2-android
cp gradle.local.properties.example gradle.local.properties
```

填好后重新构建即可。凭据也可以走环境变量（`RELEASE_STORE_FILE` / `RELEASE_STORE_PASSWORD` /
`RELEASE_KEY_ALIAS` / `RELEASE_KEY_PASSWORD`），优先级：本地文件 > 环境变量。

`gradle.local.properties` 已被 `.gitignore` 忽略。

### R8 / ProGuard

当前 `minifyEnabled false` —— **没有开启代码压缩**。

`app/proguard-rules.pro` 里已经把将来开 R8 时必须有的 keep 规则备好了，
最重要的一条是：`@JavascriptInterface` 标注的方法**必须保留**。
它们全是靠反射调用的，Java 侧没有任何调用点，R8 会把它们当死代码删掉，
而症状是「App 起来一切正常，一点任何功能就静默失败」。

真要开的话：把 `release { minifyEnabled true }`，然后先跑一遍
`_test/run_all.mjs`（尤其是 `native_mode.mjs`，它覆盖的正是 JS 桥那条通路）。

---

## 5. 装到设备

```bash
adb install -r bd2-android/app/build/outputs/apk/debug/app-debug.apk
```

或直接把 `BD2Viewer-debug.apk` 传到手机点开安装。

```bash
# 看日志（排查「白屏 / 脚本没起来」）
adb logcat -s BD2Main BD2JS BD2Bridge BD2Scan BD2Host
```

---

## 6. 「我本地能跑，别人 clone 后跑不了」排查清单

出问题时按这个顺序查：

| # | 症状 | 原因 | 处理 |
|---|---|---|---|
| 1 | `local.properties` 不存在 / `SDK location not found` | 这个文件装载机绝对路径，已被 gitignore，clone 下来必然没有 | 按 §2.2 自己建一个；用 Android Studio 打开会自动生成 |
| 2 | `Unsupported class file major version` / `invalid source release: 17` | JDK 版本不是 17（常见：用了 JDK 21 或 8） | 装 JDK 17，在 `local.properties` 里指定 `org.gradle.java.home` |
| 3 | 依赖下载不下来 / 一直卡住 | 网络到 `google()` / `mavenCentral()` 不通 | **不要把代理写进 `gradle.properties`**（那会跟着仓库公开）。写到 `~/.gradle/gradle.properties` 或命令行传 `-Dhttp.proxyHost=...` |
| 4 | 装到手机上还是旧界面 | 没跑 `bundle.mjs`（见 §3） | 跑一遍完整流程；用 `tools/verify_apk.py` 确认 sha1 |
| 5 | 桌面版起来是空的 | 没配 `viewer.config.json` | 见 [TECHNICAL.md §5](TECHNICAL.md#5-桌面版配置文件) |
| 6 | 测试超时 | 没起服务，或端口被占 | 用 `node _test/run_all.mjs`，它自己负责起服务 |
| 7 | 测试失败，报资产列表为空 | 测试需要真实资产（`id=bd2-mods` 的 root） | 见 `docs/DEVELOPMENT.md` §3 |
| 8 | `gradlew: Permission denied` | clone 后丢掉了可执行位 | `chmod +x bd2-android/gradlew` |
| 9 | `aapt2 不可用，跳过清单检查` | `tools/verify_apk.py` 找不到 aapt2 | 设 `ANDROID_HOME` 环境变量，或确保 `local.properties` 里的 `sdk.dir` 正确 |

### 目录布局是硬约束

`bd2-android/app/build.gradle` 里的 `syncWeb` 任务用的是相对路径
`../../bd2-local-viewer/public`，也就是说：

```
<repo-root>/
├── bd2-android/
└── bd2-local-viewer/
```

**这两个目录必须并列。** 单独把 `bd2-android/` 拷出来编译会失败
（而且失败信息是「找不到源目录」，不是很有指向性）。

---

## 7. 清理

```bash
cd bd2-android && ./gradlew.bat clean        # 清 Gradle 产物
# 彻底重来（会重新下载依赖）
rm -rf ~/.gradle/caches
```

仓库里不该出现的构建产物（都在 `.gitignore` 里）：
`bd2-android/build/`、`bd2-android/app/build/`、`bd2-android/.gradle/`、
`*.apk`、`bd2-local-viewer/node_modules/`、`bd2-local-viewer/public/app.bundle.html`（可选）、
`/_scratch/`（仓库根的临时工作区）、`/toolchain/`。
