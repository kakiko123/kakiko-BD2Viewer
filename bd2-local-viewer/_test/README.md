# 测试目录说明

这里没有测试框架（没有 Jest / Vitest / Playwright）。所有套件都是**独立可执行的 `node` 脚本**，
通过 Node 22 内置的 `WebSocket` 直接驱动无头 Chrome（CDP），断言写在脚本里，靠退出码报告结果。

设计取舍：零依赖、零安装，`git clone` 之后 `node _test/xxx.mjs` 就能跑。
代价是没有断言库和报告器，所以每个脚本最后会自己打印逐条 `PASS/FAIL` 和总数。

---

## 1. 怎么跑

```bash
cd bd2-local-viewer
node _test/run_all.mjs            # 跑全部套件（自己起服务、跑完自己关）
node _test/run_all.mjs --keep     # 跑完不关自己起的服务
node _test/run_all.mjs native     # 只跑名字以 native 开头的套件
```

`run_all.mjs` 负责**起服务**这件事（`8137` 桌面模式 / `8143` 原生模式）。
单独跑某个套件时，端口上必须已经有服务，否则会超时 —— 这是最常见的踩坑点：

```bash
node server.mjs &                 # 或者 node server.mjs --port=8143
node _test/e2e.mjs
```

或者干脆用 `run_all.mjs <套件名前缀>`，它会帮你起。

---

## 2. 七个回归套件（`run_all.mjs` 覆盖）

| 文件 | 项数 | 需要真实资产 | 覆盖内容 |
|---|---|---|---|
| `manifest_check.mjs` | 6 | 否 | 编译后清单：`screenOrientation=fullUser`、`configChanges` 四维度、`minSdk` |
| `bundle_check.mjs` | 18 | 是 | 单文件产物：id 一致性、CSS/JS 是否真的内联、加载遮罩注入、标记区无外链 |
| `bundle_firstpaint.mjs` | 7 | 是 | 产物级首屏：第一帧就是资产页、深链 `?item=` 可用、无错误横幅 |
| `delete_api.mjs` | 12 | 否 | 真删磁盘 + 路径越界拒绝（自带临时根目录，不碰你的数据） |
| `format_check.mjs` | 31 | 否 | 资产命名约定多模式（`bd` / `lostsword` / `nikke`）：各套规则互不串味、骨架三级级联、自带 `thumb.png`、`.atlas.bytes` 的 MIME、扫描缓存按 `(root,mode)` 分离（自带临时根目录） |
| `e2e.mjs` | 45 | 是 | 端到端：加载 / 相机 / 图层 / 截图 / 导出；**PC 侧入口**（播放页「返回列表」回平铺、右键复制文件夹 / 图集文件绝对路径 —— 期望路径在 Node 侧独立算一遍，并用 `fs.existsSync` 证明真在硬盘上）；**重叠扫描**（先发的慢轮不许顶掉后发的结果、`rootPath` 不许与 `rootId` 脱节 —— 需要本机有两个大小不同的根目录，只有一个时自动跳过）；**真实素材专项**（多皮肤骨架的 default 垫底合成、NIKKE 归组 + 姿势切换真渲染 —— 素材不在时自动跳过） |
| `native_mode.mjs` | 182 | 是 | 假桥原生通路：拖动 / 长按 / 批量删除 / 箭头 / 返回键 / 首屏 / 排序 / 缩略图队列 / 资产类型切换 / PC 入口在触屏下让位 / **NIKKE 模式归组与姿势条** |

**「需要真实资产」是什么意思**：这几个套件会去读 `viewer.config.json` 里 `id` 为 `bd2-mods`
的那个 root，也就是**你本机的 BD2 mod 目录**。没有这份数据它们会失败 —— 这是设计如此，
它们测的就是真实解码链路，不是 mock。没有游戏数据的人请直接跳过这几个：

```bash
node _test/run_all.mjs manifest_check delete_api format_check   # 自包含，不需要任何游戏数据
```

这三个是**自包含**的，任何机器上都能跑通，适合当「环境是否正常」的探针。

> `format_check.mjs` 用的是**自己造的假资产**（假 `.atlas` 文本 + 假骨架字节 + 12 字节 PNG）。
> 扫描器只认「文件在不在、名字对不对」，所以够用；但「能不能真的解码渲染」它覆盖不到，
> 那部分仍然只能靠 `e2e` / `native_mode` 在真实素材上跑。

---

## 3. 共享代码

- **`cdp.mjs`** —— 极简 CDP 客户端（`Cdp.launch` / `goto` / `waitFor` / `evaluate` / 截图）。
  所有套件都 `import { Cdp } from './cdp.mjs'`。它自己负责拉一个无头 Chrome 并在退出时收掉。
- **`run_all.mjs`** —— 套件运行器（起服务 → 顺序跑 → 汇总 → 关服务）。

`native_mode.mjs` 里的**假桥**（`mock BD2Native`）是从 `MainActivity` / `NativeBridge` 的
`@JavascriptInterface` 签名逐个对齐手写的，改 Java 侧的桥接口时**必须同步改它**，
否则测的就不是真实契约了。别的脚本需要原生环境时，用正则从它里面抠（见 `bundle_firstpaint.mjs`），
不要复制一份出来，避免两份一起漂移。

---

## 4. 一次性诊断脚本（手工跑，不属于回归）

这些是排查具体问题时写的取证/体检脚本，**不进 `run_all.mjs`**。保留是为了下次遇到同类问题能直接复用。

| 文件 | 用途 |
|---|---|
| `debug.mjs` | 通用手工调试入口：打开页面、打印状态，改代码时最常用 |
| `diag_narrow.mjs` | 窄屏（360px）控件布局体检，**给数字**（每个控件 left/right/width），定位「控件被顶出屏幕」 |
| `diag_grid.mjs` | 栅格页布局诊断 |
| `diag_bundle.mjs` | 单文件产物（`app.bundle.html`）诊断 |
| `diag_native.mjs` | 原生模式「启动卡住」取证：抓控制台 + 关键状态 |
| `probe.mjs` | 通用探测（DOM/状态快照） |
| `smoke.mjs` | 跨资产冒烟：逐个载入不同类型资产，检查是否都能渲染（读 `sample.json`） |
| `export_ui.mjs` | 完全走 UI 按钮路径的导出复验（WebM / 帧 ZIP / PNG） |
| `webm.mjs` / `webm_stress.mjs` | WebM 导出 / 连续导出 5 次的压力测试（抓偶发 0 字节） |
| `extra.mjs` | 补充测试：真实 `file input` 上传流程、加根目录接口 |
| `shot_native.mjs` / `pics.mjs` | 批量出截图（走 mock 原生桥，与 APK 同一代码路径） |
| `zoomleft.mjs` | 缩放到左下角的定位精度复验 |

---

## 5. 夹具与残留产物

- **`sample.json`** —— `smoke.mjs` 用的资产清单夹具（相对路径，不含机器绝对路径）。需要保留。
- **运行残留，已被 `.gitignore` 忽略，可随时删**：
  `*.log`、`dom*.html`、`shot*.png`、`pick_*.png`、`zoom*.png`、`e2e.png`。
  截图类残留里也会有 `nav_*.png` 这种，统一放在 `_test/_scratch/` 或套件自己覆盖写。

---

## 6. 写新测试时的两条硬规矩

这两条都是踩过坑才写下来的，违反会导致「偶发失败」或「假通过」：

1. **不要用固定 `setTimeout` 等状态收敛，要轮询条件。**
   拖动/动画收尾在主线程忙时要 430ms，写 `setTimeout(700)` 采样窗口会被挤爆 → 偶发 FAIL。
   正确做法是轮询直到状态干净（设一个 5s 上限兜底），并把实测耗时打印出来。

2. **断言要指向「存在某个东西」，不要指向「找不到某个东西」。**
   `bundle_check.mjs` 里曾有一条 `bootGone: !document.getElementById('__boot')` ——
   当时注入遮罩的代码已经静默失效，而「找不到遮罩」恰好让这条断言**空过**，
   等于用一个失效的测试掩盖了一个真实的回归。现在是先断言「遮罩确实在产物里」，再断言运行时被移除。
