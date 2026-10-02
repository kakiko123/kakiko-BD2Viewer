#!/usr/bin/env python3
"""
NIKKE UnityFS → Spine 资产提取（桌面端）。

游戏里 NIKKE 的立绘/动画是按「一个资产一个 AssetBundle」打包的：包里通常有
  · TextAsset  xxx.atlas   （文本，第一行是贴图页名 xxx.png）
  · TextAsset  xxx.skel    （**二进制** Spine 4.x 骨架）
  · Texture2D  xxx         （RGBA32；常伴随一个 xxx_mask 之类其它格式的贴图）
本脚本把这三样按原名抽到缓存目录，之后查看器按既有的 NIKKE/标准导出规则扫描即可。

与 JCZX 的区别（`jczx_extract.py`）：
  · JCZX 是「双 UnityFS 头」，要 MIT strip 到第二个头；NIKKE 是单头（strip 逻辑对
    只有 1 个头且 offset=0 的文件是恒等变换，仍调用它以免遇到罕见的双头 mod）。
  · JCZX 的骨架是 JSON TextAsset，统一写成 `.json`；NIKKE 的骨架是**二进制**，
    必须原样写 `.skel`（写成 .json 会让读者把它当 JSON 解析而失败）。
  · 贴图只导出「图集真正引用的那一页」（包里可能还有 mask/特效贴图），
    避免往缓存里塞无用大图。

依赖：UnityPy（+ Pillow）—— 仓库旁 `.venv-jczx`，见 requirements-jczx.txt。
许可：本脚本 MIT（与仓库一致）；UnityPy 亦为 MIT。

用法：
  # 单个文件
  python nikke_extract.py --src <bundle> --out <out_dir> [--name xxx] [--report r.json]
  # 批量（一次 import，适合一次性清单）
  python nikke_extract.py --batch <manifest.json> --report r.json
  # 常驻 worker（stdin 每行一个 JSON 任务，stdout 每行一个结果；省掉反复启动/import）
  python nikke_extract.py --worker
  manifest.json = {"items":[{"src":"<绝对路径>","rel":"<相对缓存子路径，可不带扩展>","outDir":"<绝对输出目录>"}]}
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import traceback
from pathlib import Path

UNITYFS = b"UnityFS\x00"
# 二进制骨架的版本串固定在下标 9 开始（[0..7] hash、[8] 变长长度前缀）
SKEL_VER = re.compile(rb"^(\d+\.\d+\.\d+)")
# 图集首行：贴图页文件名
ATLAS_PAGE = re.compile(r"^([A-Za-z0-9_\-. ]+\.png)\s*$", re.M)


def find_unityfs_offsets(buf: bytes) -> list[int]:
    offs: list[int] = []
    start = 0
    while True:
        i = buf.find(UNITYFS, start)
        if i < 0:
            break
        offs.append(i)
        start = i + 1
    return offs


def strip_to_second_unityfs(buf: bytes) -> bytes:
    """双 UnityFS 头时保留第二个头起（单头文件恒等返回）。"""
    offs = find_unityfs_offsets(buf)
    if len(offs) >= 2:
        return buf[offs[1]:]
    if len(offs) == 1 and offs[0] > 0:
        return buf[offs[0]:]
    return buf


def text_bytes(data) -> bytes:
    raw = data.m_Script
    return raw.encode("utf-8", "surrogateescape") if isinstance(raw, str) else bytes(raw)


def looks_like_atlas(name: str, raw: bytes) -> bool:
    if name.lower().endswith(".atlas") or "atlas" in name.lower():
        return True
    head = raw[:200].decode("utf-8", "replace")
    return ("size:" in head) or ("format:" in head) or ("filter:" in head)


def skel_version(raw: bytes) -> str | None:
    m = SKEL_VER.match(raw[9:24])
    return m.group(1).decode() if m else None


def looks_like_json_skel(raw: bytes) -> bool:
    s = raw.lstrip()
    if not s.startswith(b"{"):
        return False
    head = s[:200].decode("utf-8", "replace")
    return '"skeleton"' in head or '"bones"' in head


def atlas_page_name(raw: bytes) -> str | None:
    m = ATLAS_PAGE.search(raw[:400].decode("utf-8", "replace"))
    return m.group(1) if m else None


def strip_ext(name: str) -> str:
    for suf in (".skel", ".atlas", ".json", ".bytes", ".txt", ".png"):
        if name.lower().endswith(suf):
            return name[: -len(suf)]
    return name


def extract_one(src: Path, out_dir: Path) -> dict:
    import UnityPy

    raw = src.read_bytes()
    offs = find_unityfs_offsets(raw)
    env = UnityPy.load(strip_to_second_unityfs(raw))

    out_dir.mkdir(parents=True, exist_ok=True)
    exported: list[dict] = []
    errors: list[dict] = []
    counts: dict[str, int] = {}

    texts: list[tuple[str, bytes]] = []
    textures: list = []

    for obj in env.objects:
        tname = obj.type.name if obj.type else str(obj.type)
        counts[tname] = counts.get(tname, 0) + 1
        try:
            if tname == "TextAsset":
                d = obj.read()
                texts.append((d.m_Name or f"text_{obj.path_id}", text_bytes(d)))
            elif tname == "Texture2D":
                textures.append(obj.read())
        except Exception as e:  # noqa: BLE001
            errors.append({"type": tname, "path_id": obj.path_id, "err": repr(e)})

    # --- atlas ---
    atlas = None
    for name, body in texts:
        if looks_like_atlas(name, body):
            atlas = (name, body)
            break
    page = None
    if atlas:
        name, body = atlas
        fname = name if name.lower().endswith(".atlas") else f"{strip_ext(name)}.atlas"
        (out_dir / fname).write_bytes(body)
        page = atlas_page_name(body)
        exported.append({"kind": "atlas", "name": fname, "size": len(body), "page": page})

    # --- skeleton（二进制的写 .skel；JSON 的写 .json） ---
    skel_done = False
    for name, body in texts:
        if atlas and (name, body) == atlas:
            continue
        ver = skel_version(body)
        if ver:
            fname = f"{strip_ext(name)}.skel"
            (out_dir / fname).write_bytes(body)
            exported.append({"kind": "skel", "name": fname, "size": len(body), "spine": ver})
            skel_done = True
            break
    if not skel_done:
        for name, body in texts:
            if atlas and (name, body) == atlas:
                continue
            if looks_like_json_skel(body):
                fname = f"{strip_ext(name)}.json"
                (out_dir / fname).write_bytes(body)
                ver = None
                try:
                    ver = json.loads(body.decode("utf-8")).get("skeleton", {}).get("spine")
                except Exception:  # noqa: BLE001
                    pass
                exported.append({"kind": "json", "name": fname, "size": len(body), "spine": ver})
                break

    # --- 贴图：只导图集真正引用的那一页 ---
    want = strip_ext(page) if page else None
    picked = None
    if want:
        for d in textures:
            if (d.m_Name or "") == want:
                picked = d
                break
    if picked is None and len(textures) == 1:
        picked = textures[0]
    if picked is None and textures:
        # 兜底：挑第一张宽高最大的（通常就是主贴图）
        picked = max(textures, key=lambda d: (getattr(d, "m_Width", 0) or 0) * (getattr(d, "m_Height", 0) or 0))
    if picked is not None:
        try:
            img = picked.image
            if img is not None and getattr(picked, "m_Width", 0):
                fname = f"{picked.m_Name or 'tex'}.png"
                img.save(str(out_dir / fname))
                exported.append({
                    "kind": "png",
                    "name": fname,
                    "size": (out_dir / fname).stat().st_size,
                    "wh": f"{picked.m_Width}x{picked.m_Height}",
                    "fmt": int(getattr(picked, "m_TextureFormat", -1) or -1),
                })
        except Exception as e:  # noqa: BLE001
            errors.append({"type": "Texture2D", "err": repr(e)})

    kinds = {x["kind"] for x in exported}
    return {
        "src": str(src),
        "size": len(raw),
        "unityfs_offsets": offs,
        "exported": exported,
        "errors": errors,
        "counts": counts,
        "ok": bool(kinds & {"atlas"}) and bool(kinds & {"skel", "json"}) and "png" in kinds,
    }


def worker_loop() -> int:
    """常驻进程：预 import UnityPy，然后按行消费 stdin JSON 任务。"""
    import UnityPy  # noqa: F401  — 启动时预热，后续 extract_one 复用已加载模块
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line in ("QUIT", "EXIT", '{"cmd":"quit"}'):
            break
        try:
            item = json.loads(line)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"bad job json: {e!r}"}), flush=True)
            continue
        if item.get("cmd") == "quit":
            break
        src = Path(item["src"])
        out_dir = Path(item["outDir"])
        try:
            r = extract_one(src, out_dir)
        except Exception as e:  # noqa: BLE001
            r = {"src": str(src), "ok": False, "error": repr(e),
                 "trace": traceback.format_exc()[-800:]}
        r["rel"] = item.get("rel")
        print(json.dumps(r, ensure_ascii=False), flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="NIKKE UnityFS → Spine extract")
    ap.add_argument("--src", type=Path, help="单个 bundle")
    ap.add_argument("--out", type=Path, help="单文件模式的输出目录")
    ap.add_argument("--name", default=None, help="单文件模式下的输出基名（默认取内层名）")
    ap.add_argument("--batch", type=Path, help="批量清单 JSON")
    ap.add_argument("--worker", action="store_true", help="stdin JSONL worker 模式")
    ap.add_argument("--report", type=Path, default=None, help="报告输出路径")
    args = ap.parse_args()

    if args.worker:
        return worker_loop()

    out: dict = {"ok": True, "items": []}

    if args.batch:
        try:
            manifest = json.loads(Path(args.batch).read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"bad manifest: {e!r}"}), flush=True)
            return 2
        for item in manifest.get("items", []):
            src = Path(item["src"])
            out_dir = Path(item["outDir"])
            try:
                r = extract_one(src, out_dir)
            except Exception as e:  # noqa: BLE001
                r = {"src": str(src), "ok": False, "error": repr(e),
                     "trace": traceback.format_exc()[-800:]}
            r["rel"] = item.get("rel")
            out["items"].append(r)
            if not r.get("ok"):
                out["ok"] = False
    elif args.src and args.out:
        try:
            r = extract_one(args.src, args.out)
        except Exception as e:  # noqa: BLE001
            r = {"src": str(args.src), "ok": False, "error": repr(e),
                 "trace": traceback.format_exc()[-800:]}
        out["items"].append(r)
        out["ok"] = bool(r.get("ok"))
    else:
        ap.error("要么给 --src/--out，要么给 --batch")

    print(json.dumps(out, ensure_ascii=False), flush=True)
    if args.report:
        Path(args.report).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
