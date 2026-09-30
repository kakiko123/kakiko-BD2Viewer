# -*- coding: utf-8 -*-
"""复验 APK：
  1) 网页资源三方一致（apk 内的 assets/web == 工程 assets == public 源码）
  2) 编译后的清单里 screenOrientation = fullUser（尊重系统的旋转锁定）
  3) configChanges 覆盖转屏所需的四个维度

清单在 APK 里是编译过的 AXML：枚举型属性（screenOrientation）会被编译成整数，
字符串 "fullUser" 在二进制里**根本不存在** —— 所以只能靠 aapt2 反解，
或者直接比对整数。早期用「二进制里搜 fullUser 字符串」的做法是错的（搜不到就误判失败）。

用法： python tools/verify_apk.py
"""
import hashlib
import os
import shutil
import subprocess
import sys
import zipfile

# 本脚本在 tools/ 下，仓库根是它的上一级。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APK_SRC = os.path.join(ROOT, "bd2-android", "app", "build", "outputs", "apk", "debug", "app-debug.apk")
APK_OUT = os.path.join(ROOT, "BD2Viewer-debug.apk")
PUBLIC = os.path.join(ROOT, "bd2-local-viewer", "public")
ASSETS = os.path.join(ROOT, "bd2-android", "app", "src", "main", "assets", "web")
def find_aapt2():
    """找 aapt2（Windows 下是 .exe）。

    本仓库开发时用的是仓库内的 toolchain/，但别人 clone 之后通常只有
    ANDROID_HOME 或 local.properties 里的 sdk.dir。两个都试一遍，
    再退回到 PATH —— 找不到就跳过清单检查（不算失败）。
    """
    candidates = []

    # 1) local.properties 里的 sdk.dir（Android Studio 生成的本地文件）
    lp = os.path.join(ROOT, "bd2-android", "local.properties")
    if os.path.exists(lp):
        try:
            for line in open(lp, encoding="utf-8"):
                if line.strip().startswith("sdk.dir"):
                    sdk = line.split("=", 1)[1].strip().replace("\\\\", "\\").replace("\\:", ":")
                    candidates.append(os.path.join(sdk, "build-tools"))
        except Exception:
            pass

    # 2) 环境变量
    for env in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if os.environ.get(env):
            candidates.append(os.path.join(os.environ[env], "build-tools"))

    # 3) 仓库内置工具链（本项目的开发现场）
    candidates.append(os.path.join(ROOT, "toolchain", "android-sdk", "build-tools"))

    for base in candidates:
        if not os.path.isdir(base):
            continue
        for ver in sorted(os.listdir(base), reverse=True):
            for name in ("aapt2.exe", "aapt2"):
                p = os.path.join(base, ver, name)
                if os.path.exists(p):
                    return p

    # 4) PATH
    found = shutil.which("aapt2")
    return found or ""

FILES = [
    "app.bundle.html", "app.js", "styles.css", "index.html",
    # lib/ 也要一起比：APK 里 bundle 是主通路，lib/ 是「bundle 读不出来」时的兜底通路
    # （MainActivity 会退回 index.html，而 index.html 是外链 /lib/* 的）。
    # 两套 Spine 运行时缺一不可 —— 少了 4.0 那份，NIKKE 资产在兜底通路上就渲染不了。
    "lib/spine-player.js", "lib/spine-player-4.0.js", "lib/spine-player.css", "lib/jszip.min.js",
]

# android.content.pm.ActivityInfo.SCREEN_ORIENTATION_*
ORIENT = {
    0: "landscape", 1: "portrait", 2: "user", 3: "behind", 4: "sensor",
    5: "nosensor", 6: "sensorLandscape", 7: "sensorPortrait", 8: "reverseLandscape",
    9: "reversePortrait", 10: "fullSensor", 11: "userLandscape", 12: "userPortrait",
    13: "fullUser", 14: "locked",
}

# android.content.pm.ActivityInfo.CONFIG_*
CONFIG_BITS = {
    0x0080: "orientation", 0x0100: "screenLayout", 0x0400: "screenSize",
    0x0800: "smallestScreenSize",
}


AAPT2 = find_aapt2()


def sha1(data):
    return hashlib.sha1(data).hexdigest()[:12]


def dump_manifest(apk):
    if not os.path.exists(AAPT2):
        return None
    p = subprocess.run([AAPT2, "dump", "xmltree", "--file", "AndroidManifest.xml", apk],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.stdout if p.returncode == 0 else None


def main():
    if not os.path.exists(APK_SRC):
        print("FAIL  找不到构建产物:", APK_SRC)
        return 1
    shutil.copy2(APK_SRC, APK_OUT)
    failed = 0

    with zipfile.ZipFile(APK_OUT) as z:
        print("== 网页资源三方 sha1（apk / assets / public）==")
        for f in FILES:
            member = "assets/web/" + f
            if member not in z.namelist():
                print("FAIL  APK 里缺少", member)
                failed += 1
                continue
            a = sha1(z.read(member))
            p = sha1(open(os.path.join(PUBLIC, f), "rb").read())
            s_path = os.path.join(ASSETS, f)
            s = sha1(open(s_path, "rb").read()) if os.path.exists(s_path) else "缺失"
            ok = a == p == s
            failed += 0 if ok else 1
            print("%s  %-18s apk=%s assets=%s public=%s" % ("OK  " if ok else "FAIL", f, a, s, p))

    print("\n== 编译后的清单 ==")
    tree = dump_manifest(APK_OUT)
    if tree is None:
        print("SKIP  aapt2 不可用，跳过清单检查")
    else:
        orientation = None
        config_changes = None
        for line in tree.splitlines():
            if "screenOrientation" in line:
                try:
                    orientation = int(line.split("=")[-1].strip())
                except ValueError:
                    pass
            elif "configChanges" in line:
                try:
                    config_changes = int(line.split("=")[-1].strip(), 0)
                except ValueError:
                    pass

        name = ORIENT.get(orientation, "未知(%s)" % orientation)
        ok = orientation == 13
        failed += 0 if ok else 1
        print("%s  screenOrientation = %s(%s)  —— 必须是 fullUser 13：锁定时跟随用户方向，"
              "未锁定时允许 4 个方向" % ("OK  " if ok else "FAIL", orientation, name))

        missing = [v for bit, v in CONFIG_BITS.items() if not (config_changes or 0) & bit]
        ok2 = not missing
        failed += 0 if ok2 else 1
        print("%s  configChanges = 0x%08x 覆盖转屏四维度（缺: %s）"
              % ("OK  " if ok2 else "FAIL", config_changes or 0, ", ".join(missing) or "无"))

    print("\nAPK 字节: %d" % os.path.getsize(APK_OUT))
    print("结果: %s" % ("全部通过" if failed == 0 else "失败 %d 项" % failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
