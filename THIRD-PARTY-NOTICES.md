# 第三方组件声明 / Third-Party Notices

本仓库包含或依赖以下第三方组件。**这些组件的版权不属于本项目**，各自适用其自己的许可。
按各许可的要求，完整声明如下。

> **本项目不是从零原创** —— 它**基于 [Jelosus2/BD2-L2D-Viewer](https://github.com/Jelosus2/BD2-L2D-Viewer)
> （MIT，Copyright (c) 2025 Jelosus2）构建**。见 §3。

---

## 1. Spine Runtimes（`spine-player.js` / `spine-player-4.0.js` / `spine-player-4.2.js` / `spine-player.css`）

**这是最重要的一条，请务必读完。**

本仓库内置**三套** Spine 运行时，因为同一份资产库里可能同时存在三代导出的骨架
（NIKKE=4.0.x；BD2 / Lost Sword=4.1.x；交错战线 JCZX=4.2.x）：

| 文件 | 组件 | 服务对象 |
| --- | --- | --- |
| `bd2-local-viewer/public/lib/spine-player.js` | `@esotericsoftware/spine-player` **4.1.55** | BD2、Lost Sword（骨架 4.1.x） |
| `bd2-local-viewer/public/lib/spine-player-4.0.js` | `@esotericsoftware/spine-player` **4.0.31** | NIKKE（骨架 4.0.x） |
| `bd2-local-viewer/public/lib/spine-player-4.2.js` | `@esotericsoftware/spine-player` **4.2.120** | JCZX 等（骨架 4.2.x） |

- 版权：Copyright (c) 2013-2023, Esoteric Software LLC（各包内许可年份标注可能略有不同）
- 官网：https://esotericsoftware.com/
- 仓库：https://github.com/EsotericSoftware/spine-runtimes

三份都是上游 npm 包 `dist/iife/spine-player.js` 的**原样产物**，唯一改动是把
`spine-player-4.0.js` / `spine-player-4.2.js` 的全局变量名分别改成 `spine40` / `spine42`
（各唯一一处 `var` 声明），以便与 4.1 的那份在同一页面共存而不互相覆盖 —— 改动点已写在文件头部注释里。

### 许可原文

```
Spine Runtimes License Agreement
Last updated July 28, 2023. Replaces all prior versions.

Copyright (c) 2013-2023, Esoteric Software LLC

Integration of the Spine Runtimes into software or otherwise creating
derivative works of the Spine Runtimes is permitted under the terms and
conditions of Section 2 of the Spine Editor License Agreement:
http://esotericsoftware.com/spine-editor-license

Otherwise, it is permitted to integrate the Spine Runtimes into software or
otherwise create derivative works of the Spine Runtimes (collectively,
"Products"), provided that each user of the Products must obtain their own
Spine Editor license and redistribution of the Products in any form must
include this license and copyright notice.

THE SPINE RUNTIMES ARE PROVIDED BY ESOTERIC SOFTWARE LLC "AS IS" AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL ESOTERIC SOFTWARE LLC BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THE SPINE RUNTIMES, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### 实务说明（中文）

1. **允许**把 Spine Runtimes 集成进软件、随软件一起分发 —— 本仓库就是这么做的，
   所以把它放到 GitHub 上是许可允许的行为。
2. 但有两个**硬性附加条件**：
   - **每个使用者都必须自己拥有一份 Spine Editor 授权。** 使用本项目来查看/播放
     Spine 资产的人，需要自行到 https://esotericsoftware.com/ 获取授权。
     本项目**不包含、也不能代替**这份授权。
   - **任何形式的分发都必须附带上面这份许可与版权声明。** 也就是说，
     如果你 fork 或再分发本项目，**不能删掉这个文件**。
3. 上游 npm 包里的 `spine-player.js` / `spine-player-4.0.js` 是压缩产物，
   **本身不含许可头** —— 这正是本文件存在的原因：许可要求声明随分发一起走。
   请勿删除。（`spine-player-4.0.js` 的头部注释是我们自己加的改动说明，不是上游内容。）
4. 本项目作者与 Esoteric Software 无隶属关系，本项目未获其背书。

---

## 1b. UnityPy（桌面 JCZX 提取，可选运行时依赖）

- 包：[`UnityPy`](https://pypi.org/project/UnityPy/)（及依赖 `Pillow`）
- 用途：桌面端 `mode=jczx` 时，把双 UnityFS AssetBundle **strip 到第二个 UnityFS** 后解析 TextAsset / Texture2D，写出 `.atlas` / `.json` / `.png` 到 `.bd2viewer-jczx/` 缓存。
- 许可：**MIT License**
- 仓库：https://github.com/K0lb3/UnityPy
- 本仓库脚本：`bd2-local-viewer/_tools/jczx_extract.py`、`jczx_support.mjs`（MIT，与主项目相同）
- **不**随 APK 打包；仅桌面 Node 服务在本机调用。默认自动发现仓库旁 `.venv-jczx` 或 PATH 上的 UnityPy；`BD2_JCZX_PYTHON` 仅可选覆盖。

> 探针阶段评估过 MIT 的 `unityfs-js`；其在纯 Node 下因 Vite `?worker` 导入失败，故 Phase A 桌面提取走 UnityPy。

## 1c. Android JCZX 解包（APK 内置）

- `org.tukaani:xz` 1.9 — public domain（XZ / LZMA）
  - https://tukaani.org/xz/java.html
- `org.lz4:lz4-java` 1.8.0 — Apache-2.0 / BSD（LZ4）
  - https://github.com/lz4/lz4-java
- `com.kkk.bd2viewer.jczx.*` — 本仓库 MIT：UnityFS strip + 块解压 + TextAsset/RGBA32 启发式导出。
  **不是**完整 UnityPy；**不**包含 GPL 的 JCZX_AssetTool 代码。


## 2. JSZip（`jszip.min.js`）

- 组件：jszip 3.10.1（随仓库提供：`bd2-local-viewer/public/lib/jszip.min.js`）
- 版权：Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso
- 仓库：https://github.com/Stuk/jszip
- 许可：**MIT 或 GPLv3（双许可）**。本项目按 **MIT** 使用。

```
JSZip is dual licensed. You may use it under the MIT license *or* the GPLv3
license.

The MIT License

Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## 3. 上游项目：本项目基于 BD2-L2D-Viewer 构建

**本项目不是从零原创，而是基于下面这个项目构建的。**

- 项目：[Jelosus2/BD2-L2D-Viewer](https://github.com/Jelosus2/BD2-L2D-Viewer)
- 作者：[Jelosus2](https://github.com/Jelosus2)
- 版权：**Copyright (c) 2025 Jelosus2**
- 许可：**MIT License**
- 项目定位：*Web-based interactive Live2D and Spine animation viewer for the Brown Dust 2 game.*

### 3.1 本项目继承了什么

- **功能形态与交互设计**：动画列表 / 皮肤切换 / 播放与速度 / 缩放平移 / 图层显隐与点选 /
  背景 / 截图 / 导出 —— 这套「看什么、怎么操作」的设计来自上游。
- **资产的组织方式**：如何把一堆散文件（`.atlas` + `.json`/`.skel` + 贴图）识别成
  「一套可播放的资产」，这个思路沿用上游。
- **依赖选型**：`jszip` 的版本跟随上游；Spine 运行时以上游所用的 **4.1.55** 为主。
  （1.03 起另内置 **4.0.31** 一份，用于 NIKKE 的 4.0.x 骨架 —— 这是本项目自己加的，
  上游没有；双运行时的做法参考了 [Nikke-db/nikke-db-vue](https://github.com/Nikke-db/nikke-db-vue)
  的同一策略，但代码是独立写的，未复制其源码。）

### 3.2 本项目改了/加了什么（独立实现部分）

- **源码为独立重写，未复制上游代码。** 上游技术栈是 **Vue 3 + TypeScript + Vite + Pinia + Tailwind**；
  本项目是**单文件原生 JavaScript**（`public/app.js`），宿主也是自写的
  （桌面 Node 静态服务 + 手写 Android WebView 壳）。两仓库之间**没有共享的代码文件**。
- **数据源不同**：上游面向在线精选资产；本项目改为**扫描用户本机的资产目录**，
  并支持手动上传 Spine 文件。
- **新增的宿主形态与功能**：Android WebView 套壳（SAF 授权扫描、批量删除、导入 zip、
  前台服务保活）、桌面 Node 宿主、排序、缩略图队列与持久化缓存、WebM 导出等。

### 3.3 上游许可原文（MIT）

按 MIT 的要求，保留完整版权与许可声明如下：

```
MIT License

Copyright (c) 2025 Jelosus2

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 3.4 致谢

感谢 [Jelosus2](https://github.com/Jelosus2) 把 BD2 的 L2D / Spine 查看器做出来并开源。
本项目的功能清单、交互设计，以及「把散文件认成一套资产」的思路都来自它。
喜欢这类工具的话，建议也去上游仓库看看（它是在线的、资产更全）。

---

## 4. 商标与素材

- **Brown Dust 2**（棕色尘埃 2 / 브라운더스트2）及其角色、图像、音频等素材，
  版权归 **NEOWIZ** 所有。
- **Spine** 是 Esoteric Software LLC 的商标。
- 本项目是一个**非官方的本地查看工具**：
  - 仓库中**不包含任何游戏素材**（角色图、骨骼、语音一律没有）；
  - 它只读取**用户自己机器上已有的文件**；
  - 与 NEOWIZ、Esoteric Software 均无隶属关系，未获其背书。
- 因本项目的名字与用途涉及第三方商标，若你打算用于商业场景，请自行评估商标与素材合规性。
