package com.kkk.bd2viewer.jczx;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Shared constants for unpack/scan. Unpack caches stay under the mode scan root
 * (e.g. {@code BD2Viewer/jczx/bd2viewer-jczx}). Foreign thumb folders for other
 * games must not be created under another mode root — see ScanEngine.writeThumb.
 */
public final class UnpackCacheHome {
    private UnpackCacheHome() {}

    public static final Set<String> MODE_SOURCE_FOLDERS = new HashSet<>(Arrays.asList(
            "bd2", "nikke", "lostsword", "jczx", "ark"));

    /** 扫描模式 → 它在 /sdcard/BD2Viewer 下的文件夹名。 */
    public static String folderOfMode(String mode) {
        if (mode == null) return null;
        String m = mode.toLowerCase(java.util.Locale.ROOT);
        return "bd".equals(m) ? "bd2" : m;
    }

    /**
     * 这个目录名是不是「**别的**游戏的素材目录」？是就跳过。
     *
     * ⚠️ 两个关键点（BD2Viewer-APK-fixes.md §4，2026-10-03 移植）：
     *   ① **depth 0 也要跳**。老代码写的是 `depth > 0 && 命中就 continue`，
     *      于是「扫描根正好是 BD2Viewer 父目录」时，第一层就会 walk 进 `nikke/`，
     *      把 NIKKE 的无扩展名包当 JCZX 包解进 `bd2viewer-jczx/`（列表里混进一堆 NIKKE 文件）。
     *   ② 要带 `myFolder`：命中表里但是**自己那一格**时不能跳，否则会把当前模式的目录也排除掉。
     */
    public static boolean isOtherGameFolder(String name, String myFolder) {
        if (name == null) return false;
        String n = name.toLowerCase(java.util.Locale.ROOT);
        if (!MODE_SOURCE_FOLDERS.contains(n)) return false;
        if (myFolder == null) return true;
        return !n.equals(myFolder.toLowerCase(java.util.Locale.ROOT));
    }
}
