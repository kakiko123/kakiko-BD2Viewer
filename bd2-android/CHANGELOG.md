# 更新日志（BD2 Viewer APK）

版本号只有两个来源，改版本时**三处一起改**：

| 位置 | 字段 | 本次 |
|---|---|---|
| `bd2-android/app/build.gradle` | `versionCode` / `versionName` | 23 / `1.1` |
| `bd2-local-viewer/package.json` | `version` | `1.1` |
| `bd2-local-viewer/public/app.js` | `APP_VERSION` 兜底常量（桌面版用；APK 读原生 `BuildConfig.VERSION_NAME`） | `1.1` |

`versionCode` 是 Android 判定「能否覆盖安装」的唯一依据，**必须单调递增**；
显示版本可以用同一个小版本号发布多次（历史上 `1.08` 就从 13 发到 19）。

---

## 1.1 — versionCode 23

碧蓝航线（azur lane）那条 **pixi 渲染路**的四连修，全部由用户实测截图驱动。

### ① 图层选择模式：Spine 3.8 / Live2D 都能点画面选层了

- **根因**：碧蓝航线的 Spine 3.8 走 pixi-spine、Live2D 走 pixi-live2d-display，这条路**没有相机**
  （缩放/平移直接改 pixi 显示的 `scale/x/y`），而命中判定与高亮框都在调 `screenToWorld` /
  `worldToClient` —— 那两个函数读 `S.camera`，在这条路上恒为 `null`，于是「点了没反应」。
- **改法**：`pickPixiSpineLayersAt()` / `drawPixiSpineOverlay()` 直接用 pixi 自己的对象 ——
  网格附件的 `vertices` 是骨架世界坐标，乘它自己的 `worldTransform` 就是屏幕坐标（区域附件用
  localBounds 四角），缩放/平移/适配天然跟着走；高亮框挂在 pixi ticker 上**每帧重画**。
- 点选沿用「几何候选 + **渲染确认**」两层筛，另补三条实战判据：
  - **剪裁附件（Clipping）不是图层**，候选阶段跳过（它是遮罩，藏掉它反而会让被裁内容露出来）；
  - **基准像素透明时任何变化都不算「画」**（同上是遮罩级联，实测点空白处会误选 `lc2`）；
  - **同名槽位横跨多层是两码事**：面板按名字列一行（勾选三层一起隐），但高亮框只框
    **点中的那一块**，否则点一下会同时框出好几处 —— 用户看到的正是「选中的层和实际位置不符」。

### ② 同目录多层骨架（`_B` / `_M` / `_T`）归成一张卡、叠着渲染

- **现象**：`的里雅斯特 · 皮肤3 原皮` 点开只有场景，没有人物。
- **根因**：那个目录里是三套骨架 —— `_B` 只有 6 个 `BG-*` 槽位（背景）、`_M` 中层、`_T` 109 个
  槽位（人物），游戏里叠着画成一张图。三者的形态分组键完全相同，旧的「同 pose 只留第一条」
  把 M/T 直接丢掉，留下的还是字母序最靠前的 `_B`。
- **改法**：代表取**最上面那层**（T > M > B），三层挂进 `layerItems`（从下到上），
  其余层既不参与形态归组、也不进 mod 链；渲染时按 B→M→T 加进同一个舞台、取景用并集、
  缩放/复位/动画/逐帧/隐藏每层一起做；删除按 `layerItems` 摊开。
  实测图鉴里有 **16 组 `BMT` + 28 组 `BT`**。

### ③ 修掉「三只手」（爱宕 皮肤2 原皮 · `mail`）

- **根因**：动作文件里带 **`PartOpacity` 曲线**（爱宕 `mail.motion3.json`：106 条 Parameter +
  **11 条 PartOpacity**），那是「手/手臂这些部件的多套变体只留一套」的开关。但 Cubism 框架
  `CubismConfig.setOpacityFromMotion` **默认 false**，此时框架把曲线值写进**同名参数**
  （`getParameterIndex('Part17')`）—— 而 AL 的部件叫 `PartNN`、参数叫 `Param*`，两边对不上
  ⇒ 曲线被静默丢弃 ⇒ 变体一套都没淡出。
- **改法**：建模型前把开关置 `true`（**只对碧蓝航线档**，BD2 / Lost Sword 的 Live2D 沿用框架默认）。
- **实测对照**（先播 `idle` 再点 `mail`，同一帧）：开关关 → 手部可见 drawable **29~31** 个、
  曲线部件被压到 0 的 **0** 个；修好后 → **8~10** 个 / **7** 个。

### ④ 双击定点放大恢复（对 pixi 播放器）

- 以前只认相机，pixi 播放器上双击毫无反应。现在档位沿用同一套 `ZOOM_LADDER`
  （2.6× → 6.8× → 12.4×，顶档再双击 `fitHome()` 回到适配窗口），锚点按落点反算、
  **多层一起动**（实测锚点漂移 0px），缩放比指标 `zoomRatio` 与相机那条保持同一方向。

### ⑤ 更新日志入口

设置弹窗里新增「更新日志」（版本号取原生 `VERSION_NAME`，桌面版取 `APP_VERSION`），
本文档即完整历史。

### 验收

- `_test/al_mode.mjs` **54/54 通过**（新增 §8 多层骨架 7 条、§9 PartOpacity 3 条）
- `_test/native_mode.mjs` PASS（相机那条路的双击放大 8 条全绿，含真机流程）
- `_test/run_all.mjs bundle_check` 34/34
- 规则与实测数字记在 `bd2-local-viewer/ARCHITECTURE.md` 的 **R39 / R40 / R41**

---

## 1.09 — versionCode 20 / 21 / 22

- **versionCode 20**：新增碧蓝航线档 —— Spine 3.8 二进制（`.skel`）与 Live2D（`.moc3`）播放；
  卡面改用同一套运行时离屏渲一帧；修掉 Live2D 被挂两次 Ticker（动作看起来像 2 倍速）。
- **versionCode 21**：扫描缓存 —— 上次扫描结果存 IndexedDB，冷启动先垫出来再慢慢扫；
  原生侧分页从 40 条/趟提到 200 条/趟。
- **versionCode 22**：资产类型改成下拉条（六个模式一眼可见）；切换模式不再重扫（会话内快照
  直接贴回），已有内容时也不再盖全屏遮罩。

## 1.08 — versionCode 11 ~ 19

- 星陨计划（Ark Re:Code）独立资产类型：中文名 + 稀有度、形态归组。
- 箱内重建（12）→ 本机重建（13）：整理树布局 `source|mod1|mod2` → `角色/画册`。
- 后续小步：捏合跟手（17）、图层连选（18）、播放框内缩放（19）—— 显示版本仍为 `1.08`。

## 1.07 — versionCode 10

- NIKKE 的 mod 包（UnityFS）自动解包：桌面 UnityPy / 安卓纯 Java，产物进缓存并自动重扫。

## 1.06 — versionCode 9

- Lost Sword 两层角色：`_B` 背层 + `_F` 前层归成一套资产、叠着渲染。

## 1.05 — versionCode 6 / 7 / 8

- Spine 4.2 运行时 + 交错战线（JCZX）桌面提取 / 一键拖入（6）。
- 安卓 JCZX 一键解包：纯 Java UnityFS strip + extract（7，显示版本仍为 `1.05`）。
- JCZX nested URL + 失效缓存作废（8，显示版本仍为 `1.05`）。

## 1.04 — versionCode 5

- NIKKE 独立模式：角色归组 + 姿势切换；多皮肤骨架合成。

## 1.03 — versionCode 4

- 支持 NIKKE 资产，内置 Spine 4.0 运行时。

## 1.02 — versionCode 3

## 1.01 — versionCode 2

## 1.0 — versionCode 1

- 首个版本：BD2 本地 Live2D / Spine 查看器（基于 Jelosus2/BD2-L2D-Viewer，MIT）。
