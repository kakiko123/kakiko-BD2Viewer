#!/usr/bin/env python3
"""
JCZX (交错战线) UnityFS → Spine 资产提取（桌面端 Phase A）。

输入通常是「双 UnityFS」打包体：offset 0 与 offset≈83 各有一个 UnityFS 魔数。
整包直接喂 UnityPy 会 LZMA 失败；按 MIT 思路切到**第二个** UnityFS 起再解析即可。

输出到 out_dir：
  *.atlas  (TextAsset)
  *.json   (TextAsset，内容为 Spine JSON；即便原名带 .skel 也写成 .json)
  *.png    (Texture2D)

依赖：UnityPy + Pillow（仓库旁 .venv-jczx；见 setup_jczx.bat/sh 与 requirements-jczx.txt）。
许可：本脚本 MIT（与仓库一致）；UnityPy 本身亦为 MIT。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

UNITYFS = b"UnityFS\x00"


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
    """MIT strip：保留从第二个 UnityFS 魔数开始的字节流。"""
    offs = find_unityfs_offsets(buf)
    if len(offs) >= 2:
        return buf[offs[1] :]
    if len(offs) == 1 and offs[0] > 0:
        return buf[offs[0] :]
    return buf


def looks_like_atlas(name: str, raw: bytes) -> bool:
    ln = name.lower()
    if ln.endswith(".atlas") or "atlas" in ln:
        return True
    head = raw[:200].decode("utf-8", "replace")
    return ("size:" in head) or ("format:" in head) or ("filter:" in head)


def looks_like_json_skel(name: str, raw: bytes) -> bool:
    ln = name.lower()
    if ln.endswith(".json"):
        return True
    s = raw.lstrip()
    if not s.startswith(b"{"):
        return False
    head = s[:120].decode("utf-8", "replace")
    return '"skeleton"' in head or '"spine"' in head or '"bones"' in head


def extract(src: Path, out_dir: Path) -> dict:
    import UnityPy

    raw = src.read_bytes()
    offs = find_unityfs_offsets(raw)
    stripped = strip_to_second_unityfs(raw)
    out_dir.mkdir(parents=True, exist_ok=True)
    # 写一份 stripped 方便排障（同目录 .stripped.bin）；体积大时可选
    # 默认不落盘 stripped，只抽出 spine 三件套

    env = UnityPy.load(stripped)
    summary: dict = {
        "src": str(src),
        "size": len(raw),
        "unityfs_offsets": offs,
        "stripped_size": len(stripped),
        "exported": [],
        "errors": [],
        "counts": {},
    }
    counts: dict[str, int] = {}

    for obj in env.objects:
        tname = obj.type.name if obj.type else str(obj.type)
        counts[tname] = counts.get(tname, 0) + 1
        try:
            if tname == "TextAsset":
                data = obj.read()
                name = data.m_Name or f"text_{obj.path_id}"
                script = data.m_Script
                raw_b = (
                    script.encode("utf-8", "surrogateescape")
                    if isinstance(script, str)
                    else bytes(script)
                )
                if looks_like_atlas(name, raw_b):
                    fname = name if name.lower().endswith(".atlas") else f"{name}.atlas"
                    (out_dir / fname).write_bytes(raw_b)
                    summary["exported"].append(
                        {"kind": "atlas", "name": fname, "size": len(raw_b)}
                    )
                elif looks_like_json_skel(name, raw_b):
                    # 强制 .json：内容是 JSON（探针样本原名 .skel 实为 JSON 4.2）
                    base = name
                    for suf in (".skel", ".json", ".bytes", ".txt"):
                        if base.lower().endswith(suf):
                            base = base[: -len(suf)]
                            break
                    fname = f"{base}.json"
                    (out_dir / fname).write_bytes(raw_b)
                    spine_ver = None
                    try:
                        spine_ver = json.loads(raw_b.decode("utf-8")).get("skeleton", {}).get(
                            "spine"
                        )
                    except Exception:
                        pass
                    summary["exported"].append(
                        {
                            "kind": "json",
                            "name": fname,
                            "size": len(raw_b),
                            "spine": spine_ver,
                        }
                    )
                else:
                    # 其它 TextAsset 忽略（脚本/配置）
                    pass
            elif tname == "Texture2D":
                data = obj.read()
                name = data.m_Name or f"tex_{obj.path_id}"
                img = data.image
                if img is not None and getattr(data, "m_Width", 0):
                    fname = name if name.lower().endswith(".png") else f"{name}.png"
                    img.save(str(out_dir / fname))
                    summary["exported"].append(
                        {
                            "kind": "png",
                            "name": fname,
                            "size": (out_dir / fname).stat().st_size,
                            "wh": f"{data.m_Width}x{data.m_Height}",
                        }
                    )
        except Exception as e:
            summary["errors"].append({"type": tname, "path_id": obj.path_id, "err": repr(e)})

    summary["counts"] = counts
    atlas_ok = any(x["kind"] == "atlas" for x in summary["exported"])
    json_ok = any(x["kind"] == "json" for x in summary["exported"])
    png_ok = any(x["kind"] == "png" for x in summary["exported"])
    summary["ok"] = bool(atlas_ok and json_ok and png_ok)
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description="JCZX UnityFS → Spine extract")
    ap.add_argument("src", type=Path, help="packed AB / UnityFS file")
    ap.add_argument("out_dir", type=Path, help="output directory for .atlas/.json/.png")
    ap.add_argument("--report", type=Path, default=None, help="write JSON report path")
    args = ap.parse_args()
    if not args.src.is_file():
        print(json.dumps({"ok": False, "error": f"not a file: {args.src}"}), flush=True)
        return 2
    try:
        summary = extract(args.src, args.out_dir)
    except Exception as e:
        summary = {"ok": False, "error": repr(e), "src": str(args.src)}
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        if args.report:
            args.report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        return 1
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    if args.report:
        args.report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if summary.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
