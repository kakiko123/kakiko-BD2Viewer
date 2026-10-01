# kakiko-BD2Viewer v1.05（Phase A + Android JCZX）

> 版本名 `1.05` · 当前 `versionCode 8` · 快照 2026-10-01（Asia/Hong_Kong）
> 这是统一的 1.05 发布线：包含桌面端 Phase A 与 Android JCZX 一键解包。versionCode 现为 **8**（Phase A 曾为 6，Android JCZX 曾为 7）；显示版本名仍统一为 1.05。

## 新增

1. **第三套 Spine 运行时 4.2.120**（`public/lib/spine-player-4.2.js` → 全局 `spine42`）
   - `SPINE_BY_MINOR` 现为 `4.0` / `4.1` / `4.2`
   - JSON 骨架也会读 `"spine":"4.x"`（JCZX 抽出的就是 JSON）
2. **JCZX 资产类型**（桌面）
   - 扫描 `mode=jczx`：根目录下 `prefabs_spine_*` / `.ab` / 无扩展名 UnityFS
   - **MIT strip 第二个 UnityFS** + **UnityPy** 抽到 `.bd2viewer-jczx/` 缓存
   - 得到标准 `.atlas` + `.json` + `.png` 后再按 BD2 规则归桶
   - 拖入 AB：`POST /api/jczx/ingest` 写入当前根并提取，然后重扫
3. 依赖：Python `UnityPy` + `Pillow`（见 `bd2-local-viewer/_tools/requirements-jczx.txt`）
   - **无需**设 `BD2_JCZX_PYTHON`：自动发现仓库旁 / `bd2-local-viewer` 旁的 `.venv-jczx`，或 PATH 上能 `import UnityPy` 的 python
   - 首次 JCZX 扫描若缺 UnityPy：自动 `python -m venv .venv-jczx` + `pip install -r …`（需联网一次；也可先跑 `setup_jczx.bat` / `setup_jczx.sh`）
   - `BD2_JCZX_PYTHON` 仅作可选覆盖

## 测试

- `bundle_check`：断言三套运行时文件 + 内联 + 页面全局
- `format_check`：有样例 AB 时验 jczx 提取 / `spineMinor=4.2` / 与 bd 不串味
  （`BD2_JCZX_SAMPLE` 指向样例；缺失则跳过不红）

## 注意

- 游戏素材不进仓库；本机提取缓存 `.bd2viewer-jczx/` 也不提交
- unityfs-js 在 Node 下因 Vite `?worker` 不可用；桌面提取走 UnityPy（MIT）
- Phase A **不**改 Android `ScanEngine` 提取；APK 仍可带上 4.2 运行时供后续

## 构建

同 v1.04 闭环：`bundle.mjs` → `sync_assets.mjs` → gradle → `verify_apk.py`。

## Android JCZX（同一 1.05 发布线）

1. **Android JCZX 模式真正解包**
   - `BD2Viewer/jczx/`（或 App 专属同名目录）放入 `prefabs_spine_*` / UnityFS AB。
   - 扫描时：双 UnityFS MIT strip → UnityFS 块解压（LZMA/LZ4）→ 抽出 `.atlas` / `.json` / `.png`。
   - 缓存目录：`bd2viewer-jczx/`（无前导点；旧 `.bd2viewer-jczx/` 扫描时自动迁移）；列表只展示缓存内抽出的 Spine。
   - Toast：`JCZX 提取：新建 n，复用 m` / 失败原因。
2. **纯 Java 实现**（`com.kkk.bd2viewer.jczx`）
   - 依赖：`org.tukaani:xz`、`org.lz4:lz4-java`（见 `THIRD-PARTY-NOTICES`）。
   - Phase 1 范围：典型 JCZX spine AB（Unity 2022.x、嵌入 RGBA32、JSON Spine 4.2）。
3. 导入上限：JCZX 模式 48MB（更大请用文件管理器拷到 `/sdcard/BD2Viewer/jczx/` 后重新扫描）。

## 同版本 bugfix

- 修复 Mobile JCZX 缓存点目录导致的 `Couldn't load image/texture/atlas`（缓存改为 `bd2viewer-jczx/`，支持 legacy 迁移、磁盘回退与大小写不敏感查找）。
- 修复桌面投放区外的 drop 仍触发导入；仅 `#dropzone` 内才执行 ingest。
- 桌面与 Android UI、`package.json`、Gradle `versionName` 统一显示 `1.05`；Android `versionCode` 现为 `8`（显示仍为 1.05）。

## 已知缺口（Android Phase 1）

- 非 RGBA32 / 流式 `.resS` 大贴图 / ASTC·ETC 压缩纹理：未覆盖。
- 完整 TypeTree 解析未做（启发式 TextAsset + 尺寸匹配 RGBA）。
- 超大 AB 经 WebView Base64 导入可能 OOM —— 优先文件管理器落盘。

## 构建

`bundle.mjs` → `sync_assets.mjs` → `bd2-android` assembleDebug/Release → `verify_apk.py`。

## 其他修复（v1.05 / versionCode 8）

- 手机全屏动画 UI：进入全屏后控件保持隐藏（不误显）。
- 缩略图优先使用本地缓存。
- 切换动画时不再把 pinch 缩放钳到约 12.5×。
- 桌面拖放：仅 `#dropzone` 内才 ingest（投放区外 drop 不再触发导入）。
- JCZX 加载修复：点前缀目录处理；`urlsForItem` 使用完整 `relImages`；坏缓存强制重抽需 `.json` + 合理 PNG；Unity Texture2D 像素布局修正。
