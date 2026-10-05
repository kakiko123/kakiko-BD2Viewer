# 碧蓝航线档：已完成的事，以及两个未修问题的思路

日期：2026-10-04。这份文档只记账和写修复思路。缩略图和 Live2D 倍速**还没有改代码**。

桌面查看器已经能在「碧蓝航线」档里播 Spine 3.8 二进制和 Cubism moc3。不需要再单做一套 Unity APK。手机包还没打。

---

## 1. 已经落地的事

### 1.1 图鉴目录

`C:\Users\KAKIKO\Videos\新建文件夹` 是碧蓝航线图鉴 20260831，大约 7.8 万个文件。整理脚本是 `bd2-local-viewer/_tools/al_reorg.mjs`，已经 `--apply` 过：9161 次移动，源缺失 0。日志在该目录的 `_al_reorg_log.tsv`。不要再跑一次 `--apply`。撤销是在 `bd2-local-viewer` 下执行 `node _tools/al_reorg.mjs --undo`（根目录用环境变量 `AL_ROOT`，否则就是上面这个文件夹）。

整理后的样子：

```
角色/<id>__<中文名>/皮肤N/原皮/<形态>/...
角色/<id>__<中文名>/皮肤N/mod1/<modId>@@<形态>/...
角色/<id>__<中文名>/皮肤N/mod2|mod3|mod4/<包名>@@<形态>/...
角色/<id>__<中文名>/meta.json
角色/<id>__<中文名>/voice/
图鉴/头像|背景|漫画|插画/原皮/...
```

皮肤槽：`base` 或 `1` 进皮肤1；开头是数字的（`2`、`2_n`、`3_hx`）进皮肤N；不是数字的（`hx`、`jz`、`rw`、`g`）进 `皮肤_<记号>`。`原皮` 是官方层的文件夹名，不是皮肤的显示名。图鉴自带的 `data/`、`dist/`、`server.mjs` 没有搬。

官方 Spine 图集在第 5 层目录。服务端 `maxDepth` 仍是 5，扫得到这一层的文件；`textures/` 在第 6 层，walk 不会再往下走，所以贴图不会被当成另一套 Spine。Live2D 的贴图从 `FileReferences.Textures` 读，相对模型所在目录。

### 1.2 扫描

`server.mjs` 的 `FORMATS.al.classify`：`.model3.json`、`.physics3.json`、`.motions.json`、`.motion3.json`、`manifest.json`、`animator-controller.json`、`prefab-runtime.json` 返回 null，不进 Spine 骨架桶。其余交给 BD2 的分类。

`appendAlLive2d` 在 al 模式的 walk 末尾额外推一条 `kind: 'live2d'`。`relAtlas` 就是模型的相对路径，`relImages` 是贴图，`live2dMotions` 是动作组名。没有贴图则 `ok: false`，问题写成「缺少贴图」。

Android `ScanEngine.java` 写了同样的分类和两条发射（普通目录和 SAF），**没有编译，也没有打进 APK**。

### 1.3 归组

前端 `alInfoOf` 用路径本身当归组信息，扫描端不再挂一份元数据。同一角色一张卡，皮肤是形态。pose 带种类后缀，避免同一目录里的 Spine 和 Live2D 互相盖住：

```
004__4__spine
003__3__l2d
```

`targetKey` 是 `<角色id>|<pose>`。原皮且皮肤1 当作默认形态。卡片副标题对 Live2D 加 ` · Live2D`。

### 1.4 播放

4.x 仍走原来的 SpinePlayer（`binaryUrl` + `OrthoCamera` + `attachCameraGestures`）。这两条新路径不进那个播放器。

| 资产 | 运行时 | 入口 |
|---|---|---|
| Spine 3.8 `.skel` | `public/lib/pixi-spine-3.8.umd.js`（`@pixi-spine/all-3.8` 3.1.2） | `loadSpine38Member` |
| Cubism `.model3.json` | 图鉴自带的 `live2dcubismcore.min.js` + `cubism4.min.js`（pixi-live2d-display 0.4.0） | `loadLive2dMember` |
| Spine 3.x 的 **JSON** | 仍是 `spineJson38to41`，然后交给 4.1 | 不进 pixi-spine |

脚本顺序在 `public/index.html` 的 head 里，不能换：Cubism 核心 → pixi 6.5.10 → cubism4 → pixi-spine 3.8。`server.mjs` 的 `LIB_ROUTES` 放行了这四个文件。`.moc3` 的 MIME 是 `application/octet-stream`。

`loadCurrent` 在版本拒收之前分流：Live2D 直接进 `loadLive2dMember`；`skeletonKind === 'skel'` 且次版本是 `3.8` 进 `loadSpine38Member`。其它非 4.x 的二进制仍然拒收。JSON 3.8（例如贝尔法斯特 `皮肤_g`）继续走转换器。

3.8 的二进制头不是 4.x 那种「第 8 字节起的短版本串」。版本串在变长 hash 后面，`spine38MinorFromHead` 用 64 字节窗口才能看到 `3.8.99`。传给 `SkeletonBinary.readSkeletonData` 的必须是自己拥有 `ArrayBuffer` 的 `Uint8Array`（`new Uint8Array(await res.arrayBuffer())`）。pixi-spine 的 `DataView` 不看 `byteOffset`，切片视图会读错。

播放器是一个带 `__pixi: true` 的壳，挂在原来的 `S.player` 上。`S.camera` 保持 null，所以原来的 Spine 相机会捏不到这页。捏合在 `attachPixiGestures` 里，监听 `#stageInner`，改的是 pixi 显示对象的 `scale` / `position`。Spine 的 zoom 越大画面越小；pixi 的 scale 越大画面越大。按钮放大走 `zoomInStep` / `zoomOutStep`。导出视频和导出帧会提示「这个播放器暂时不能导出」。

`public/lib/pixi-spine.umd.js`（约 1.2 MB，3.7+3.8+4.0 合包）没有引用，不要打进包。

### 1.5 架构约定

`bd2-local-viewer/ARCHITECTURE.md` 的 R21 末句和 R30 已经改过。R30 ⑤ 写的是「Live2D 卡面用第一张贴图，不进 Spine 离屏缩略图队列」。这是当前代码的行为，也是下面第 2 节那个缩略图问题的来源。修的时候要改这句。

### 1.6 验证过的，和没做的

2026-10-04 用临时配置（没有改 `viewer.config.json`）和阿达尔伯特亲王的两套原皮，在无头 Chrome 里加载过：

- `皮肤4/原皮/4/adaerbote_4.skel`：播放器 `kind === 'spine38'`，动画 `1`–`7` 和 `normal`，画面是红底白发那张，画布上有不透明像素。
- `皮肤3/原皮/3/adaerbote_3.model3.json`：`kind === 'live2d'`，34 个动作，默认 `idle`，浴室那张模型画出来了。同一张卡上能在两个形态之间切换。
- 扫描这两套目录得到 2 条：1 条 skel、1 条 live2d。副文件没有混进骨架桶。

没有在真机上验。没有模拟双指。没有跑 `bundle.mjs` / `sync_assets.mjs` / `gradlew`。仓库根上的 `BD2Viewer-debug.apk` 仍是 versionCode 19、versionName 1.08，里面没有这套播放器。`public/app.bundle.html` 和 `bd2-android/.../assets/web` 也还是那一版。

桌面服务直接读 `public/`。改完 `server.mjs` 或 `index.html` 之后要重启服务再刷新页面。资产类型选「碧蓝航线」，根目录选图鉴根，不要选到某一层角色文件夹里（前端只认 `角色/` 和 `图鉴/` 开头的相对路径）。

---

## 2. 缩略图是零件图，不是拼好的角色

### 现在为什么是这样

卡面在 `galleryCard`（`public/app.js`）。

Live2D 被特意排除在离屏缩略图队列之外。卡片用的是第一张贴图：

```javascript
const stillUrl = (item.imageOnly || isLive2dItem(item)) && item.relImages && item.relImages[0]
  ? assetUrl(item.relImages[0]) : null
```

`relImages[0]` 来自 `FileReferences.Textures`，阿达尔伯特皮肤3 是 `textures/texture_00.png`。那是 Cubism 的贴图集，眼睛、头发、身体拆开铺在一张图上。卡面把这张原图贴上去，所以看起来是「骨架贴图」，不是播放页里拼好的那个人。

Spine 3.8 会进队列，但 `makeThumb` 在建播放器之前就丢掉了：

```javascript
if (minor && !/^4\.[012]$/.test(minor)) throw new Error(...)
```

这句是为了不让 4.x 的 SpinePlayer 去硬读 3.8 二进制。失败后 `setCardThumbFailed` 只给卡片加上 `failed`，不会画一帧。所以 Spine 3.8 现在也没有「拼好的样子」。

网格里往往只看得到一张角色卡。归组时 `__l2d` 的 pose 字符串排在 `__spine` 前面，露在外面的常常是 Live2D 那条，卡面就整卡都是零件图。Spine 那条藏在形态里，它自己的缩略图根本没画成。

同目录如果已经有不比资产旧的 `thumb.png`，`freshThumbRel` 会把它当成成品，队列也不会重渲。这次整理没有写 `thumb.png`。修的时候如果看到某张卡已经是一张小图而不是零件图，先看是不是这条捷径。

### 修复思路

不要拿贴图文件当卡面。两种资产都用「和正片同一个运行时渲一帧」。

1. Live2D 去掉 `stillUrl` 这条捷径，让它进缩略图队列。队列里不要走 `makeThumb` 现在的 SpinePlayer。另写一条短路径：`Live2DModel.from` → 摆到 `idle`（没有就用动作表第一项）→ 等贴图上传后再 `app.render()` → `canvas.toDataURL` → `model.destroy()` 并且 `app.destroy`。`autoInteract: false`，并且 `autoUpdate: false`，只要一帧，不要让缩略图也去订 Ticker（见第 3 节）。
2. Spine 3.8 在 `makeThumb` 里按次版本分叉，而不是继续抛「不支持的 Spine 版本」。3.8 二进制复用 `loadSpine38Member` 那套：`TextureAtlas` + `SkeletonBinary` + `PIXI.spine.Spine`，`autoUpdate = false`，播 `idle` 或第一段动画，`update(0)`，套 `fitPixiDisplay`，渲一帧，销毁。其它非 4.x 的二进制（不是 3.8）仍按现在这样失败，避免 4.x 播放器去读。
3. 队列维持现在的单张在飞（`thumbRunning`）。每张卡的 pixi `Application` 必须在 `finally` 里销毁，WebGL 上下文数量有限。
4. 落盘沿用现有的 `thumb.png` 规则即可，测试仍要 `setThumbPersist(false)`，避免往图鉴目录里写文件。
5. 一张角色卡只展示默认形态的缩略图，这是现有归组，不用为每个皮肤各画一张卡。默认形态画出来的应是拼好的人，而不是它的第一张贴图。
6. 怎么判断修好了：卡面图片的边长应是缩略图尺寸（大约 220），不是贴图原尺寸（4096 或 Live2D 那张大图）。和 `texture_00.png` / `*.atlas` 的第一页比，内容不该是同一张零件图。用阿达尔伯特皮肤3、皮肤4 各看一张就够。

播放页里已经能拼出来，所以这不是运行时缺失，是卡面走了另一条更短的路。

---

## 3. Live2D 看起来像开了倍速

### 现在为什么是这样

`pixi-live2d-display` 0.4.0 的计时是：

```text
onTickerUpdate() → model.update(Ticker.shared.deltaMS)
model.update(dt) → 只把 dt 累加进 this.deltaTime
_render()        → internalModel.update(this.deltaTime, this.elapsedTime)，然后把 deltaTime 清零
内部模型         → 两个参数都除以 1000，变成秒，再交给动作、呼吸、物理
```

一帧只应累加一次 `deltaMS`。累加两次，同一次 `_render` 就会吃掉两帧的时间，动作、呼吸、物理一起变成 2 倍。这和「倍速」的感觉一致，不是毫秒/秒弄反（弄反会快几百倍，不是两倍）。

`Ticker.shared.add` 不去重。pixi 6.5.10 的 `_addListener` 是直接 `connect` 一个新监听。`autoUpdate` 的 setter 在设为 `true` 时也不看当前是不是已经是 `true`，每次都 `add`。

实际发生的顺序：

1. `Live2DModel.from(url, { autoInteract: false })` 没有关 `autoUpdate`。库的默认是 `autoUpdate: true`。`init()` 里设一次，Ticker 上有 1 个 `onTickerUpdate`。
2. `finishPixiSession` → `setPlaying(S.autoPlay)`。`S.autoPlay` 默认 true，于是 `play()` 再执行 `model.autoUpdate = true`，Ticker 上变成 2 个。
3. 自动播放的第一轮就是 2 倍。`pause()` 的 setter 会把同函数同 context 的监听全部摘掉；再按播放只会加回 1 个。所以「暂停再播放」之后可能变回正常，第一次打开一直是快的。

速度旋钮包了一层 `model.update`，1.00x 时乘的是 1，不是这次变快的原因。进度条那个 `app.ticker` 回调只改 `entry.trackTime`，不推模型。模型走了两倍、进度条走一倍的话，滑条会比画面慢。

### 修复思路

1. 创建时写明 `{ autoUpdate: false, autoInteract: false }`。不要依赖库的默认值。
2. `play()` 只在当前不是自动更新时设 `autoUpdate = true`。`pause()` 设回 false。不要在已经是 true 的时候再设一次 true。
3. 速度旋钮继续乘在这一次 `update(dt)` 上。1.00x 的墙钟应和动作文件的 `_loopDurationSeconds` 对得上：一条 4 秒的动作，墙钟大约 4 秒。
4. 修完先别改内部模型那次 `deltaTime / 1000`。那是库自己的换算。若去掉重复监听之后仍然偏快，再查 `motionManager.update` 拿到的是帧间隔还是累计时间。`doUpdateMotion` 把第二个参数当绝对时间用；`updateMotion` 则是 `_userTimeSeconds += e`。现在这条看起来是 2 倍，优先对监听次数，不对这条换算动手。
5. 怎么判断修好了：自动播放、不先按暂停。在控制台看 `PIXI.Ticker.shared.count` 里 `onTickerUpdate` 只有一个（或播放期间模型只被推一次）。把速度拨到 0.5，画面应变成半速；若现在的 bug还在，0.5 会看起来像正常速度。用阿达尔伯特皮肤3 的 `idle` 看呼吸和头发，不要只看某一条很短的动作。

---

## 4. 接下来如果要打进手机

播放已经在桌面证实。要进 APK 时再做这三步，并且把 versionCode 从 19 升到 20，versionName 保持 1.08：

```text
node _tools/bundle.mjs
node _tools/sync_assets.mjs
JAVA_HOME=<toolchain\jdk17> GRADLE_USER_HOME=<toolchain\gradle-home> gradlew.bat --offline --no-daemon assembleDebug
```

`bundle.mjs` 的内联列表已经包含那四个新库，但打包还没跑。不要把 `pixi-spine.umd.js` 加进去。Java 的 Live2D 发射还没编译过。
