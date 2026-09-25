# 开发说明

给要改这个项目的人。**动手前请先读
[`bd2-local-viewer/ARCHITECTURE.md`](../bd2-local-viewer/ARCHITECTURE.md)** ——
那份文档里有分层调用链和 10 条不变量（R1~R10），本项目的多数 bug 都是违反而来的。

---

## 1. 代码放在哪

| 想改什么 | 改哪里 |
|---|---|
| 界面、交互、播放逻辑 | `bd2-local-viewer/public/app.js`（唯一一份前端逻辑） |
| 布局与主题 | `bd2-local-viewer/public/styles.css` |
| DOM 结构 | `bd2-local-viewer/public/index.html` |
| 桌面宿主（扫描 / 取文件 / 删除） | `bd2-local-viewer/server.mjs` |
| Android 壳、返回键、全屏 | `bd2-android/app/src/main/java/com/kkk/bd2viewer/MainActivity.java` |
| JS ↔ 原生 的接口 | 同目录 `NativeBridge.java`（改完记得同步 `app.js` 的调用点） |
| Android 扫描 / 删除 / 导入 | 同目录 `ScanEngine.java` |
| WebView 里资源怎么取 | 同目录 `Host.java` |

**不要直接改 `bd2-android/app/src/main/assets/web/`** —— 那是生成物，
下次 `sync_assets.mjs` 或 `gradle syncWeb` 会覆盖掉。改 `public/`。

### 加功能时的落点

前端的分层是固定的（见 ARCHITECTURE.md §2）：状态 → 派生 → 渲染 → 刷新 → 交互 → 导航。
新功能按这个顺序落：

1. 状态加到模块级的 `S` / `filters` / `sortState` / `viewMode` 里（**别塞进 DOM**）；
2. 需要「可见资产」就走 `filteredItems()`，别自己再算一遍（R3）；
3. 渲染函数**只读状态，不写状态**（R4）；
4. 状态变了要重画 → 调 `refreshLists()`（R5）。要绕开必须写注释说明理由；
5. 事件处理只做两件事：改状态、调入口函数。

---

## 2. 测试怎么回事

**没有测试框架**，也**没有 npm 依赖**。测试就是普通 Node 脚本，
通过 CDP（Chrome DevTools Protocol）驱动一个无头 Chrome，在真实页面里点、拖、断言。

```
_test/cdp.mjs       自己写的 ~110 行 CDP 客户端
                    （用 Node 22 内置的 WebSocket，所以测试需要 Node 22+）
_test/run_all.mjs   统一入口：起服务 → 顺序跑 → 关服务 → 汇总
```

### 跑测试

```bash
cd bd2-local-viewer
node _test/run_all.mjs                  # 全部
node _test/run_all.mjs native_mode      # 单个（名字可写前缀）
node _test/run_all.mjs --keep           # 跑完不关自己起的服务
```

`run_all.mjs` 会自己按需起服务（8137 / 8143），所以**不用手工起**。
如果你已经手工起了，它会认出来并复用，且不会去关它。

### 端口约定

| 端口 | 谁在用 |
|---|---|
| 8137 | `server.mjs` 默认端口。`bundle_check` / `bundle_firstpaint` / `e2e` 连它 |
| 8143 | `native_mode` 连它（`server.mjs --port=8143`） |
| 8600 起自动找空闲 | `delete_api` 自己起的临时服务（用 `BD2_CONFIG` 指到临时目录） |

---

## 3. 测试的数据依赖（重要）

`native_mode` / `e2e` / `bundle_check` / `bundle_firstpaint` 会去读
**你本机真实的资产目录** —— 具体是 `viewer.config.json` 里 `id` 为 `bd2-mods` 的 root。

它们还会检查其中**特定的几套资产**（比如 `Eclipse Story effect yuk11sh1d4/illust_special6.atlas`，
以及一套只有 1 个动画的、一套有多个动画的）。

所以：

- 你自己跑测试，需要本地有 BD2 mod 资产，并把 root 的 `id` 配成 `bd2-mods`；
- 换一批资产后某些用例可能失败 —— **多半是 fixture 不匹配，不一定是代码坏了**；
- 自包含、不需要任何真实数据的只有 `manifest_check`（纯静态）和 `delete_api`
  （自己建临时根目录，用 `BD2_CONFIG` 指过去，绝不会碰你的真实目录）。

这是当前测试设计的一个已知短板（README §12 已知问题 1）。

---

## 4. 写测试时的几个反模式（都真踩过）

### 4.1 别用固定 `setTimeout` 等异步收尾

拖动的收尾动画、缩略图队列、扫描完成 —— 这些的耗时取决于主线程忙不忙。

写过 `await sleep(700)` 然后断言「状态已经干净」，结果主线程一忙收尾要 430ms 才完，
采样窗口被挤爆 → **偶发 FAIL，冤枉了正确的代码**。

正确做法：**轮询到干净**（带上限），并把实测耗时打进结论里：

```js
const deadline = Date.now() + 5000
let stats
while (Date.now() < deadline) {
  stats = JSON.parse(await cdp.evaluate(`return JSON.stringify(__bd2viewer.dragStats)`))
  if (!stats.active && !stats.placeholders && !stats.stuckInline) break
  await new Promise(r => setTimeout(r, 60))
}
check('松手后状态干净', !stats.active, JSON.stringify(stats))
```

### 4.2 断言前先想清「这条条件归谁」

可见性有两条轨（R1）：**随模式变的归 CSS，随数据变的归 JS 挂 body 类名**。

把两者混进一条断言就会冤枉正确的代码 —— 真实案例：
「资产页不该显示箭头」本来由 CSS 负责，而 `body.stage-nav-avail` 是**数据**条件，
在资产页为 `true` 才是对的。当时断言写成了 `=== false`，结果去"修"没坏的地方。

### 4.3 只测源文件是不够的

多个套件跑的是 `index.html`，但 **APK 真正加载的是内联后的 `app.bundle.html`**。
内联会重排 `<head>`/`<body>`，源文件上成立的事在产物里可能不成立。

真实案例：`index.html` 的 `<body>` 加了 `class="view-grid"` 之后，
`bundle.mjs` 里那句 `html.replace('<body>', ...)` 静默失配，
加载遮罩再也没进产物 —— 而当时那条「遮罩已撤掉」的运行时断言反而**空过**
（查不到遮罩当然就是撤掉了）。

所以：产物级的东西要在产物上断言（见 `bundle_check.mjs` 里那组静态检查）。

### 4.4 一次性诊断脚本别留在正式套件里

`diag_*.mjs` / `probe.mjs` / 早期的 `shot*.mjs` 是开发期一次性脚本，
随意新增、用完可以不管。但**不要**把新功能回归挂在这种脚本上 ——
正式断言请加到 `run_all.mjs` 会跑的那 6 个套件里。

---

## 5. 验证「代码真的生效了」

这个项目最大的时间黑洞是「以为改了，其实没生效」。三个层次都要验：

| 层次 | 怎么验 |
|---|---|
| 源文件 | `grep` 一下确认改动在盘上 |
| 服务返回的内容 | `curl -s http://127.0.0.1:8137/app.js \| grep 你的改动` —— 服务是每次请求读盘的，但如果端口上是**旧进程**就还是旧内容 |
| APK | `python tools/verify_apk.py`，比对三方 sha1 |

**不要靠 APK 体积判断有没有刷新** —— 出现过三次内容完全不同、字节数一模一样（608377）。

---

## 6. 环境相关的坑（Windows 为主）

### 6.1 `.bat` 的编码

cmd 用**当前 ANSI 代码页**（中文系统 = GBK）逐字节读 `.bat`。所以：

| 场景 | 要求 |
|---|---|
| `.bat` 里要写中文 | 存成 **GBK + CRLF**，**并且不要写 `chcp 65001`** |
| `.bat` 要调用「输出 UTF-8 中文」的程序 | `.bat` 自身必须是**纯 ASCII**，再 `chcp 65001`，中文交给被调程序打印 |

本仓库的 `.bat` 一律采用后者（**纯 ASCII**），中文说明写在 README / docs 里 ——
这样跨代码页、跨机器都不会出问题。

两个具体坑：

- **LF 换行同样致命**：cmd 按行读取会错位，必须 CRLF。
- **`if (...)` 块内禁写半角括号**：`echo ComfyUI (8188) is running` 会被 cmd 把 `)` 当块结束符，
  报 `was unexpected at this time.` 并**中断后面整段脚本**（后半段静默不执行）。
  写全角括号，或者干脆避开。

症状速查（UTF-8 中文的 `.bat` 被当 GBK 解析）：`echo` 被吃掉首字母 →
`'xxx' 不是内部或外部命令`，伴随 `系统找不到指定的路径`，且后半段不执行。

### 6.2 代理不要写进 `gradle.properties`

`gradle.properties` 是**公开**的。机器相关的代理地址请写：

- `~/.gradle/gradle.properties`（Gradle 官方的机器级位置，不会被任何仓库收录），或
- 命令行：`gradle -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7890 assembleDebug`

注意 `--no-daemon` 时构建跑在一次性 daemon 里，只有 `org.gradle.jvmargs` 会传给它的 JVM，
所以别把代理塞进 `jvmargs`，要用 `-D` 传给 Gradle 自身。

### 6.3 路径给 Windows 原生程序要写成 `C:/...`

`javac.exe` / `gradle.bat` / `node.exe` 这些原生程序**不认** Git Bash 的 `/c/...` 路径
（会被拼成 `c:\c\...`）。在 Bash 里调它们时，路径一律写 `C:/Users/...` 形式。

### 6.4 长任务用后台运行，别用 `nohup`

Node 的输出在重定向到文件时是**块缓冲**。前台跑一个长任务、被超时杀掉，
会留下一个 **0 字节日志**，看起来像"什么都没输出"。

长任务（几分钟的测试 / 构建）请用工具的 `run_in_background` 直接跑整个命令，
跑完再读日志。

---

## 7. 相关文档

| 文档 | 内容 |
|---|---|
| [`bd2-local-viewer/ARCHITECTURE.md`](../bd2-local-viewer/ARCHITECTURE.md) | 分层调用链、病根复盘、10 条不变量、验证矩阵 |
| [`docs/BUILD.md`](BUILD.md) | 构建、Release 签名、R8、clone 后跑不起来的排查清单 |
| [`README.md`](../README.md) | 面向使用者的完整说明 |
| [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) | 第三方许可（Spine 许可要求它随分发走） |
