package com.kkk.bd2viewer;

import com.kkk.bd2viewer.jczx.JczxExtractor;
import com.kkk.bd2viewer.jczx.NikkeAbExtractor;
import com.kkk.bd2viewer.jczx.UnpackCacheHome;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 目录扫描 + 文件索引。
 * 产出的 item 字段与桌面版 server.mjs 完全一致，前端不用改任何解析逻辑。
 *
 * 两种来源：
 *   saf  —— 系统文件夹选择器授权的目录，用 SAF 读，需要 0 权限
 *   file —— 拿到「所有文件访问权限」后直接 File 读，快很多
 */
public final class ScanEngine {
    private static final String TAG = "BD2Scan";
    public static final int MAX_DEPTH = 6;
    private static final int MAX_ITEMS = 2000;

    private static final Set<String> SKIP_DIRS = new HashSet<>(Arrays.asList(
            "node_modules", ".git", ".svn", "__pycache__", "$recycle.bin", "cache", "code_cache",
            ".venv-jczx"));
    private static final Set<String> IMG_EXT = new HashSet<>(Arrays.asList(".png", ".jpg", ".jpeg", ".webp"));

    /* ------------------------------------------------------------ 资产命名约定
     *
     * 不同游戏给同一批 Spine 文件起的扩展名不一样，于是「怎么认出一套资产」有两套规则：
     *   · bd（默认）：标准 Spine 导出 —— xxx.atlas + xxx.json / xxx.skel + 贴图
     *   · lostsword ：Unity TextAsset 导出 —— xxx.atlas.bytes + xxx.skel.bytes
     *                 （JSON 骨架是裸 xxx.bytes），目录里还常带一张预算好的 thumb.png
     *
     * 关键设计：**分桶的键不再用扩展名，而用「角色」**（@atlas / @json / @skel / @thumb，
     * 贴图仍用真实扩展名）。这样 emitEntries / emitSaf 里那些
     * `byExt.getOrDefault(".atlas", ...)` 只要改成 `byExt.getOrDefault(K_ATLAS, ...)`，
     * 主体逻辑一行不用重写，两套规则就同时支持了。
     *
     * 与服务端的 FORMATS（server.mjs）保持同一套语义 —— 改一边记得改另一边。
     */

    static final String K_ATLAS = "@atlas";
    static final String K_JSON = "@json";
    static final String K_SKEL = "@skel";
    static final String K_THUMB = "@thumb";

    static final String MODE_BD = "bd";
    static final String MODE_LOSTSWORD = "lostsword";
    /** NIKKE：文件命名与 bd 完全一样（差别在前端怎么归组 + 骨架是 4.0），归桶直接复用 bd 那套。 */
    static final String MODE_NIKKE = "nikke";
    /** JCZX：打包 AB 先解到 bd2viewer-jczx/，再按 bd 规则扫抽出的 atlas/json/png（Spine 4.2）。 */
    static final String MODE_JCZX = "jczx";
    /** Ark（星陨计划 Ark Re:Code）：文件命名与 bd 完全一样（角色目录 + runtime/ 三件套），
     *  归桶直接复用 bd 那套。差别全在前端：读 meta.json 拿中文名/稀有度、一角色多形态归组、
     *  立绘与语音（.wav 不进资产桶，只当静态资源按需取）。 */
    static final String MODE_ARK = "ark";

    /** classify() 的结果：这个文件在资产里扮演什么角色 */
    static final class Role {
        final String bucket;   // 分桶键：K_ATLAS / K_JSON / K_SKEL / K_THUMB / 真实图片扩展名 / null
        final String base;     // 资产基名（同名匹配用），仅 atlas / skeleton 有
        Role(String bucket, String base) { this.bucket = bucket; this.base = base; }
    }

    /**
     * 按当前模式把文件名归类。
     * 返回 null 表示这个文件不参与资产识别（也不进桶）。
     */
    private static Role classify(String name, String mode) {
        if (name == null) return null;
        String l = name.toLowerCase(Locale.ROOT);
        if (MODE_LOSTSWORD.equals(mode)) {
            // 顺序要紧：.atlas.bytes / .skel.bytes 必须先判，否则会被裸 .bytes 抢走，
            // 基名会算成 "xxx.atlas" 而不是 "xxx"。
            if (l.endsWith(".atlas.bytes")) return new Role(K_ATLAS, name.substring(0, name.length() - 12));
            if (l.endsWith(".skel.bytes")) return new Role(K_SKEL, name.substring(0, name.length() - 11));
            if (l.endsWith(".bytes")) return new Role(K_JSON, name.substring(0, name.length() - 6));
            if (l.equals("thumb.png")) return new Role(K_THUMB, null);
            if (IMG_EXT.contains(extOf(name))) return new Role(extOf(name), null);
            return null;
        }
        // bd / nikke / jczx（抽出后）/ ark 共用同一套归桶规则。
        // NIKKE 差别在前端归组与骨架世代；JCZX 差别在扫描前先解包 AB；
        // Ark 差别在 meta.json 解析 + 一角色多形态归组（全在前端）。
        if (l.endsWith(".atlas")) return new Role(K_ATLAS, baseName(name));
        if (l.endsWith(".skel")) return new Role(K_SKEL, baseName(name));
        if (l.endsWith(".json")) return new Role(K_JSON, baseName(name));
        // 需求 5：生成的 thumb.png 与 Lost Sword 预算图同一角色，避免进图集页候选
        if (l.equals("thumb.png")) return new Role(K_THUMB, null);
        if (IMG_EXT.contains(extOf(name))) return new Role(extOf(name), null);
        return null;
    }

    /**
     * 从候选骨架里挑出与 atlas 配对的那个。三级级联，越靠前越可信：
     *   ① 基名精确相同  ② 骨架基名是 atlas 基名的前缀（取最长）  ③ 目录里唯一候选
     * 实测 Lost Sword 的 430 套里 429 套命中①，剩下一套靠②
     * （skull_Soldier_Green.atlas.bytes ↔ skull_Soldier.skel.bytes）。
     * 不能只用③：有 40 个目录里放着 2~3 个骨架，随便挑会张冠李戴。
     */
    private static <T> T pickByBase(List<T> cands, String base, java.util.function.Function<T, String> nameOf) {
        if (cands == null || cands.isEmpty()) return null;
        for (T c : cands) {
            String n = nameOf.apply(c);
            if (n != null && base.equals(classifyBaseOf(n))) return c;
        }
        T best = null;
        int bestLen = -1;
        for (T c : cands) {
            String n = nameOf.apply(c);
            String sb = n == null ? null : classifyBaseOf(n);
            if (sb != null && !sb.isEmpty() && base.startsWith(sb) && sb.length() > bestLen) {
                best = c;
                bestLen = sb.length();
            }
        }
        if (best != null) return best;
        return cands.size() == 1 ? cands.get(0) : null;
    }

    /** 取基名：丢掉 .atlas.bytes / .skel.bytes 这类中缀 */
    private static String classifyBaseOf(String name) {
        String l = name.toLowerCase(Locale.ROOT);
        if (l.endsWith(".atlas.bytes")) return name.substring(0, name.length() - 12);
        if (l.endsWith(".skel.bytes")) return name.substring(0, name.length() - 11);
        if (l.endsWith(".atlas")) return baseName(name);
        if (l.endsWith(".skel")) return baseName(name);
        if (l.endsWith(".json")) return baseName(name);
        if (l.endsWith(".bytes")) return name.substring(0, name.length() - 6);
        return baseName(name);
    }

        /** 二进制骨架头 → '4.0' / '4.1' / null（与前端 spineMinorFor / server spineMinorFromHead 同一口径）。
     *  优先按 Spine 布局读：[0..7] hash、[8] 长度、[9..] "4.x.y\0"；全头正则可能被 hash
     *  字节里碰巧的 "4.0.x" 误导（NIKKE 解包实为 4.1 却判成 4.0 → 空动画）。 */
    static String spineMinorFromHead(byte[] head) {
        if (head == null || head.length == 0) return null;
        if (head.length > 10) {
            int len = head[8] & 0xff;
            if (len > 0 && len < 24 && 9 + len <= head.length) {
                StringBuilder ver = new StringBuilder(len);
                for (int i = 9; i < 9 + len; i++) {
                    int c = head[i] & 0xff;
                    if (c == 0) break;
                    ver.append((char) c);
                }
                java.util.regex.Matcher vm = java.util.regex.Pattern.compile("^4\\.(\\d)\\.\\d+").matcher(ver.toString());
                if (vm.find()) return "4." + vm.group(1);
            }
        }
        StringBuilder sb = new StringBuilder(32);
        int n = Math.min(head.length, 32);
        for (int i = 0; i < n; i++) sb.append((char) (head[i] & 0xff));
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("4\\.(\\d)\\.\\d+").matcher(sb.toString());
        return m.find() ? ("4." + m.group(1)) : null;
    }

    static String spineMinorOfEntry(Entry e, String kindBucket) {
        if (e == null || !K_SKEL.equals(kindBucket)) return null;
        if (e.file != null) {
            try (FileInputStream in = new FileInputStream(e.file)) {
                byte[] buf = new byte[32];
                int n = in.read(buf);
                if (n <= 0) return null;
                if (n < buf.length) {
                    byte[] slim = new byte[n];
                    System.arraycopy(buf, 0, slim, 0, n);
                    return spineMinorFromHead(slim);
                }
                return spineMinorFromHead(buf);
            } catch (Exception ex) {
                return null;
            }
        }
        return null;
    }

    /** SAF：通过 DocumentsContract Uri 读骨架头前 32 字节 */
    static String spineMinorOfSafEntry(Context ctx, Uri tree, SafEntry e, String kindBucket) {
        if (ctx == null || tree == null || e == null || !K_SKEL.equals(kindBucket) || e.docId == null) return null;
        Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, e.docId);
        try (InputStream in = ctx.getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            byte[] buf = new byte[32];
            int n = in.read(buf);
            if (n <= 0) return null;
            if (n < buf.length) {
                byte[] slim = new byte[n];
                System.arraycopy(buf, 0, slim, 0, n);
                return spineMinorFromHead(slim);
            }
            return spineMinorFromHead(buf);
        } catch (Exception ex) {
            return null;
        }
    }

    /** 骨架桶 → spine-player 需要的 kind（决定走 jsonUrl 还是 binaryUrl） */
    private static String kindOfBucket(String bucket) {
        return K_SKEL.equals(bucket) ? "skel" : "json";
    }


    public static final class Root {
        public String id;
        public String label;
        public String kind;      // "saf" | "file"
        public String path;      // file 模式下的绝对路径
        public String treeUri;   // saf 模式下的 tree uri
        public boolean exists = true;

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("id", id);
                o.put("label", label);
                o.put("path", path == null ? "" : path);
                o.put("kind", kind);
                o.put("exists", exists);
            } catch (Exception ignored) {
            }
            return o;
        }
    }

    /** 一个可读取的文件引用 */
    public static final class Doc {
        public String rel;
        public File file;        // file 模式
        public Uri uri;          // saf 模式
    }

    private static final Object ROOTS_LOCK = new Object();
    private static final Object SCAN_LOCK = new Object();

    private static final ConcurrentHashMap<String, Doc> DOCS = new ConcurrentHashMap<>();
    private static final Map<String, JSONArray> CACHE = new LinkedHashMap<>();
    private static final List<Root> ROOTS = new ArrayList<>();

    /* 扫描预算：选中 /sdcard 根目录时会面对几万个目录，没有上限就会一直跑 */
    private static final int MAX_DIRS = 4000;
    private static final long SCAN_BUDGET_MS = 45000;
    private static int dirCount = 0;
    private static long deadline = 0;

    /* ------------------------------------------------------------ roots */

    /** 注意：这里绝不能和 scan 抢同一把锁 —— 扫描要跑几十秒，主线程会卡成 ANR */
    public static List<Root> roots(Context ctx) {
        synchronized (ROOTS_LOCK) {
            if (ROOTS.isEmpty()) loadRoots(ctx);
            refreshAutoRoots(ctx);
            // 自动目录必须在第一位，前端默认取 roots[0]
            return new ArrayList<>(ROOTS);
        }
    }

    public static Root rootById(String id) {
        if (id == null) return null;
        synchronized (ROOTS_LOCK) {
            for (Root r : ROOTS) if (id.equals(r.id)) return r;
        }
        return null;
    }

    /* ------------------------------------------------- 自动目录（默认入口）

       设计：App 自己建目录、自己扫，用户不用进系统文件夹选择器。
       SAF 的 ACTION_OPEN_DOCUMENT_TREE 在部分机型上会直接把进程带崩，
       所以默认路径一条都不走它。

       外部优先：手机存储根目录的 /sdcard/BD2Viewer 用户用文件管理器就看得见、
       放得进，作为默认入口；拿不到「所有文件访问权限」时才退回 App 专属目录。
    */
    public static final String DEFAULT_ROOT_ID = "__default__";
    public static final String PUBLIC_ROOT_ID = "__public__";
    public static final String DIR_NAME = "BD2Viewer";
    /** 各模式在 BD2Viewer 下的子目录名（与前端 ASSET_MODES 对应；bd → bd2 以免与父目录混淆） */
    public static final String SUB_BD = "bd2";
    public static final String SUB_NIKKE = "nikke";
    public static final String SUB_LOSTSWORD = "lostsword";
    public static final String SUB_JCZX = "jczx";
    public static final String SUB_ARK = "ark";
    /** 最近一次扫描/绑定的 mode，storageStatus / writeImport 用它挑子目录 */
    private static volatile String boundMode = MODE_BD;

    public static String modeFolderName(String mode) {
        if (MODE_NIKKE.equals(mode)) return SUB_NIKKE;
        if (MODE_LOSTSWORD.equals(mode)) return SUB_LOSTSWORD;
        if (MODE_JCZX.equals(mode)) return SUB_JCZX;
        if (MODE_ARK.equals(mode)) return SUB_ARK;
        return SUB_BD;
    }

    public static String[] allModeFolders() {
        return new String[]{SUB_BD, SUB_NIKKE, SUB_LOSTSWORD, SUB_JCZX, SUB_ARK};
    }

    /** MediaStore 里拿到的一个文件条目（没有「全部文件访问」时只能这么读） */
    public static final class Entry {
        public String name;
        public File file;   // file 模式
        public Uri uri;     // ms / saf 模式
    }

    /** App 专属外部目录父级：.../files/BD2Viewer（其下再分 bd2/nikke/lostsword） */
    public static File defaultDir(Context ctx) {
        File base = ctx.getExternalFilesDir(null);
        if (base == null) base = ctx.getFilesDir();
        File d = new File(base, DIR_NAME);
        try {
            if (!d.exists() && !d.mkdirs()) Log.w(TAG, "mkdir failed: " + d);
        } catch (Exception e) {
            Log.w(TAG, "mkdir: " + e.getMessage());
        }
        return d;
    }

    /** App 专属目录下当前 mode 的子目录 */
    public static File defaultModeDir(Context ctx, String mode) {
        File d = new File(defaultDir(ctx), modeFolderName(mode));
        try {
            if (!d.exists() && !d.mkdirs()) Log.w(TAG, "mkdir failed: " + d);
        } catch (Exception e) {
            Log.w(TAG, "mkdir: " + e.getMessage());
        }
        return d;
    }

    /** 默认入口：优先外部 /sdcard/BD2Viewer/<mode>，建不出来就退回 App 专属同名子目录 */
    public static File primaryDir(Context ctx) {
        return primaryDir(ctx, boundMode);
    }

    public static File primaryDir(Context ctx, String mode) {
        File p = publicModeDir(mode);
        return p != null ? p : defaultModeDir(ctx, mode);
    }

    /**
     * 导入文件：优先落进外部 /sdcard/BD2Viewer，写不了再落 App 专属目录。
     * rel 里带子目录也可以（xx/yy.atlas）。
     */
    public static boolean writeImport(Context ctx, String rel, byte[] bytes) {
        String safe = String.valueOf(rel).replace('\\', '/');
        while (safe.startsWith("/")) safe = safe.substring(1);
        if (safe.trim().isEmpty()) return false;
        File[] targets = new File[]{publicModeDir(boundMode), defaultModeDir(ctx, boundMode)};
        for (File dir : targets) {
            if (dir == null) continue;
            try {
                /* 落点必须真的落在这个目录里面。
                   别用 replace("../", "") 那种写法：String.replace 只扫一遍、不会回头再扫，
                   于是 "....//x" 处理完会剩下 "../x"，照样逃出目录。
                   这里用规范化路径做包含性判断（和 pruneEmptyDirs 同一套思路）。 */
                File base = dir.getCanonicalFile();
                File f = new File(base, safe).getCanonicalFile();
                if (!f.getPath().equals(base.getPath())
                        && !f.getPath().startsWith(base.getPath() + File.separator)) {
                    Log.w(TAG, "import rejected, escapes root: " + rel);
                    continue;
                }
                File p = f.getParentFile();
                if (p != null && !p.exists() && !p.mkdirs()) continue;
                try (FileOutputStream os = new FileOutputStream(f)) { os.write(bytes); }
                return true;
            } catch (Exception e) {
                Log.w(TAG, "writeImport: " + e.getMessage());
            }
        }
        return false;
    }

    /**
     * 需求 5：把离屏缩略图写成资产目录里的 thumb.png。
     * rel 相对 root（如 {@code char/foo/thumb.png}）；只允许 basename 为 thumb.png。
     * 父目录必须已存在（atlas 同目录）—— 禁止 mkdirs 在其它 mode 根下新建异游戏文件夹。
     * 写成功后登记进 DOCS，删除联动才能找到它。
     */
    public static boolean writeThumb(Context ctx, String rootId, String rel, byte[] bytes) {
        if (bytes == null || bytes.length == 0) return false;
        String safe = String.valueOf(rel).replace('\\', '/');
        while (safe.startsWith("/")) safe = safe.substring(1);
        if (safe.isEmpty()) return false;
        String base = new File(safe).getName();
        if (!"thumb.png".equalsIgnoreCase(base)) {
            Log.w(TAG, "writeThumb rejected, not thumb.png: " + rel);
            return false;
        }
        Root root = rootById(rootId);
        try {
            if (root != null && root.path != null) {
                File rootFile = new File(root.path).getCanonicalFile();
                File f = new File(rootFile, safe).getCanonicalFile();
                if (!f.getPath().equals(rootFile.getPath())
                        && !f.getPath().startsWith(rootFile.getPath() + File.separator)) {
                    Log.w(TAG, "writeThumb rejected, escapes root: " + rel);
                    return false;
                }
                File p = f.getParentFile();
                // Only write beside an existing asset dir — never mkdir foreign
                // game folders (e.g. BD2 Celia_* under jczx/ after mode switch).
                if (p == null || !p.isDirectory()) {
                    Log.w(TAG, "writeThumb rejected, parent missing (no mkdir): " + safe);
                    return false;
                }
                try (FileOutputStream os = new FileOutputStream(f)) { os.write(bytes); }
                Doc d = new Doc();
                d.rel = safe;
                d.file = f;
                DOCS.put(root.id + "|" + safe, d);
                scanPath(ctx, f.getAbsolutePath());
                return true;
            }
        } catch (Exception e) {
            Log.w(TAG, "writeThumb file: " + e.getMessage());
        }
        // Do NOT fall back to writeImport: that mkdirs arbitrary rel trees under
        // the current mode folder (foreign thumbs in jczx/).
        Log.w(TAG, "writeThumb skipped (no file root / parent): " + rel);
        return false;
    }

    /** 让刚写进去的文件尽快被系统索引到，不触发的话刷新时可能还查不到 */
    public static void scanPath(Context ctx, String path) {
        try {
            android.media.MediaScannerConnection.scanFile(ctx, new String[]{path}, null, null);
        } catch (Exception e) {
            Log.w(TAG, "scan: " + e.getMessage());
        }
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    /* 公共目录建不出来时记下原因，给 UI 显示。
       Android 11+ 分区存储：手机存储根目录没有「所有文件访问权限」就建不了目录，
       静默失败会让用户以为 App 坏了，所以必须把原因说出来。 */
    private static String publicProblem = "";

    /** 公共目录父级 /sdcard/BD2Viewer：只有真能写才启用，否则当它不存在 */
    public static File publicDir() {
        publicProblem = "";
        File d = new File(Environment.getExternalStorageDirectory(), DIR_NAME);
        try {
            if (!d.exists() && !d.mkdirs()) {
                publicProblem = "系统拒绝了在手机存储根目录建文件夹（Android 11+ 分区存储）";
                return null;
            }
        } catch (Exception e) {
            publicProblem = "建目录异常：" + e.getMessage();
            return null;
        }
        try {
            File probe = new File(d, ".write_test");
            if (!(probe.exists() || probe.createNewFile())) {
                publicProblem = "目录存在但不可写";
                return null;
            }
        } catch (Exception e) {
            publicProblem = "写入测试失败：" + e.getMessage();
            return null;
        }
        return d;
    }

    /** 公共目录下当前 mode 的子目录：/sdcard/BD2Viewer/{bd2,nikke,lostsword} */
    public static File publicModeDir(String mode) {
        File parent = publicDir();
        if (parent == null) return null;
        File d = new File(parent, modeFolderName(mode));
        try {
            if (!d.exists() && !d.mkdirs()) {
                publicProblem = "无法在 BD2Viewer 下创建 " + modeFolderName(mode);
                return null;
            }
        } catch (Exception e) {
            publicProblem = "建子目录异常：" + e.getMessage();
            return null;
        }
        return d;
    }

    /** 期望的公共目录父路径（不管建没建成功），给 UI 显示用 */
    public static String publicDirPath() {
        return new File(Environment.getExternalStorageDirectory(), DIR_NAME).getAbsolutePath();
    }

    /** 期望的 mode 子目录路径 */
    public static String publicModeDirPath(String mode) {
        return new File(publicDirPath(), modeFolderName(mode)).getAbsolutePath();
    }

    /** 给前端的目录/权限诊断信息（路径已绑到当前 mode 子目录） */
    public static JSONObject storageStatus(Context ctx) {
        JSONObject o = new JSONObject();
        String mode = boundMode == null ? MODE_BD : boundMode;
        File appParent = defaultDir(ctx);
        File app = defaultModeDir(ctx, mode);
        File pubParent = publicDir();
        File p = publicModeDir(mode);
        File primary = p != null ? p : app;
        boolean allFiles = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R
                || Environment.isExternalStorageManager();
        try {
            o.put("defaultDir", primary.getAbsolutePath());
            o.put("defaultExists", primary.isDirectory());
            o.put("defaultIsPublic", p != null);
            o.put("appDir", app.getAbsolutePath());
            o.put("appParentDir", appParent.getAbsolutePath());
            o.put("publicPath", publicModeDirPath(mode));
            o.put("publicParentPath", publicDirPath());
            o.put("publicOk", p != null);
            o.put("publicReason", publicProblem);
            o.put("mode", mode);
            o.put("modeFolder", modeFolderName(mode));
            o.put("allFilesAccess", allFiles);
            o.put("sdk", android.os.Build.VERSION.SDK_INT);
            o.put("rootCount", ROOTS.size());
        } catch (Exception ignored) {
        }
        return o;
    }

    /** 启动时建好父目录 + 三个 mode 子目录，并各放一份说明 */
    public static void ensureDefaults(Context ctx) {
        File pub = publicDir();
        if (pub != null) {
            writeReadme(pub);
            for (String sub : allModeFolders()) {
                File d = new File(pub, sub);
                try {
                    if (!d.exists()) d.mkdirs();
                } catch (Exception e) {
                    Log.w(TAG, "mkdir mode: " + e.getMessage());
                }
                writeReadme(d);
                scanPath(ctx, d.getAbsolutePath());
            }
            scanPath(ctx, pub.getAbsolutePath());
        }
        File app = defaultDir(ctx);
        writeReadme(app);
        for (String sub : allModeFolders()) {
            writeReadme(defaultModeDir(ctx, modeFolderToMode(sub)));
        }
    }

    private static String modeFolderToMode(String folder) {
        if (SUB_NIKKE.equals(folder)) return MODE_NIKKE;
        if (SUB_LOSTSWORD.equals(folder)) return MODE_LOSTSWORD;
        if (SUB_JCZX.equals(folder)) return MODE_JCZX;
        if (SUB_ARK.equals(folder)) return MODE_ARK;
        return MODE_BD;
    }

    private static void writeReadme(File dir) {
        if (dir == null || !dir.isDirectory()) return;
        File f = new File(dir, "把动图文件放这里.txt");
        if (f.exists()) return;
        try (FileOutputStream os = new FileOutputStream(f)) {
            os.write(readmeText().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "writeReadme: " + e.getMessage());
        }
    }

    private static String readmeText() {
        return "BD2Viewer 按游戏分子目录（App 会自动创建）：\r\n"
                + "\r\n"
                + "    BD2Viewer/bd2/        ← BD2 模式\r\n"
                + "    BD2Viewer/nikke/      ← NIKKE 模式\r\n"
                + "    BD2Viewer/lostsword/  ← Lost Sword 模式\r\n"
                + "    BD2Viewer/jczx/       ← 交错战线 JCZX（可直接放打包 AB）\r\n"
                + "\r\n"
                + "BD2 / NIKKE / Lost Sword：一套 Spine 一个子文件夹（atlas + json/skel + png）。\r\n"
                + "JCZX：把 prefabs_spine_* / UnityFS 包丢进 jczx/，App 扫描时自动解包到\r\n"
                + "bd2viewer-jczx/ 缓存后再播放（Spine 4.2）。大文件建议用文件管理器拷贝。\r\n"
                + "\r\n"
                + "Lost Sword 是 Unity TextAsset：xxx.atlas.bytes + xxx.skel.bytes（或裸 xxx.bytes）+ xxx.png。\r\n"
                + "\r\n"
                + "懒得用数据线的话，也可以直接用 App 里的「导入文件」。\r\n";
    }

    private static void refreshAutoRoots(Context ctx) {
        bindModeRoots(ctx, boundMode);
    }

    /**
     * 按当前资产模式把自动根绑到 BD2Viewer/{bd2,nikke,lostsword}。
     * 切 mode 时由 scan() 调用；路径变了会清掉该 rootId 下所有 mode 缓存。
     */
    public static void bindModeRoots(Context ctx, String mode) {
        if (mode == null || mode.isEmpty()) mode = MODE_BD;
        boundMode = mode;
        String folder = modeFolderName(mode);
        File pub = publicModeDir(mode);
        if (pub != null) {
            String label = "手机存储 /BD2Viewer/" + folder;
            putAuto(PUBLIC_ROOT_ID, label, pub.getAbsolutePath(), "file");
        } else {
            dropAuto(PUBLIC_ROOT_ID);
        }
        File app = defaultModeDir(ctx, mode);
        putAuto(DEFAULT_ROOT_ID, "BD2Viewer/" + folder + "（App 目录）", app.getAbsolutePath(), "file");
        sortAuto();
    }

    /** 自动目录固定排在最前：手机存储根目录 → App 目录 → 用户授权的目录 */
    private static void sortAuto() {
        List<Root> autos = new ArrayList<>();
        List<Root> others = new ArrayList<>();
        for (Root r : ROOTS) {
            if (r.id != null && r.id.startsWith("__")) autos.add(r);
            else others.add(r);
        }
        autos.sort(Comparator.comparingInt(r -> autoOrder(r.id)));
        ROOTS.clear();
        ROOTS.addAll(autos);
        ROOTS.addAll(others);
    }

    private static int autoOrder(String id) {
        if (PUBLIC_ROOT_ID.equals(id)) return 0;
        if (DEFAULT_ROOT_ID.equals(id)) return 1;
        return 2;
    }

    private static void dropAuto(String id) {
        for (int i = ROOTS.size() - 1; i >= 0; i--) {
            if (id.equals(ROOTS.get(i).id)) ROOTS.remove(i);
        }
    }

    /** 自动目录永远排在最前，前端默认选第一个 */
    private static void putAuto(String id, String label, String path, String kind) {
        for (Root r : ROOTS) {
            if (id.equals(r.id)) {
                boolean pathChanged = path != null && !path.equals(r.path);
                r.label = label;
                r.kind = kind;
                r.path = path;
                r.exists = "ms".equals(kind) || new File(path).isDirectory();
                if (pathChanged) {
                    // 切 mode 换了子目录：旧缓存指向另一批文件，所有 mode 桶一起丢
                    synchronized (SCAN_LOCK) {
                        java.util.Iterator<String> cit = CACHE.keySet().iterator();
                        while (cit.hasNext()) {
                            String k = cit.next();
                            if (k.equals(id) || k.startsWith(id + "|")) cit.remove();
                        }
                    }
                }
                return;
            }
        }
        Root r = new Root();
        r.id = id;
        r.label = label;
        r.kind = kind;
        r.path = path;
        r.exists = "ms".equals(kind) || new File(path).isDirectory();
        ROOTS.add(0, r);
    }

    public static void addSafRoot(Context ctx, Uri treeUri, String label) {
        try {
            int flags = android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION;
            ctx.getContentResolver().takePersistableUriPermission(treeUri, flags);
        } catch (Exception e) {
            Log.w(TAG, "persist uri failed: " + e.getMessage());
        }
        synchronized (ROOTS_LOCK) {
            Root r = new Root();
            r.id = "saf" + Math.abs(treeUri.toString().hashCode());
            r.label = label;
            r.kind = "saf";
            r.treeUri = treeUri.toString();
            for (int i = ROOTS.size() - 1; i >= 0; i--) {
                Root old = ROOTS.get(i);
                if (r.id.equals(old.id)) ROOTS.remove(i);
            }
            ROOTS.add(r);
        }
        saveRoots(ctx);
    }


    /**
     * 从配置列表移除用户添加的根路径（不删磁盘文件）。
     * 自动目录（id 以 __ 开头）不可移除。返回 JSON 字符串。
     */
    public static String removeRoot(Context ctx, String rootId) {
        JSONObject out = new JSONObject();
        try {
            if (rootId == null || rootId.trim().isEmpty()) {
                out.put("ok", false);
                out.put("error", "缺少 id");
                return out.toString();
            }
            if (rootId.startsWith("__")) {
                out.put("ok", false);
                out.put("error", "系统自动目录不能从列表移除");
                return out.toString();
            }
            Root removed = null;
            synchronized (ROOTS_LOCK) {
                if (ROOTS.isEmpty()) loadRoots(ctx);
                for (int i = ROOTS.size() - 1; i >= 0; i--) {
                    Root r = ROOTS.get(i);
                    if (rootId.equals(r.id)) {
                        removed = r;
                        ROOTS.remove(i);
                    }
                }
                if (removed == null) {
                    out.put("ok", false);
                    out.put("error", "找不到要移除的根目录");
                    return out.toString();
                }
                // 若是 SAF 根，顺手丢掉持久化读权限（可选，失败不影响）
                if (removed.treeUri != null && !removed.treeUri.isEmpty()) {
                    try {
                        Uri uri = Uri.parse(removed.treeUri);
                        ctx.getContentResolver().releasePersistableUriPermission(
                                uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    } catch (Exception e) {
                        Log.w(TAG, "release uri: " + e.getMessage());
                    }
                }
                saveRoots(ctx);
            }
            invalidateRootCache(rootId);
            JSONObject rjson = new JSONObject();
            rjson.put("id", removed.id);
            rjson.put("label", removed.label == null ? "" : removed.label);
            rjson.put("path", removed.path == null ? "" : removed.path);
            out.put("ok", true);
            out.put("removed", rjson);
            return out.toString();
        } catch (Throwable t) {
            try {
                out.put("ok", false);
                out.put("error", String.valueOf(t.getMessage()));
            } catch (Exception ignored) {
            }
            return out.toString();
        }
    }

    private static void loadRoots(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences("bd2viewer", Context.MODE_PRIVATE);
        String json = sp.getString("roots", "[]");
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Root r = new Root();
                r.id = o.optString("id");
                r.label = o.optString("label");
                r.kind = o.optString("kind", "saf");
                r.path = o.optString("path", null);
                r.treeUri = o.optString("treeUri", null);
                r.exists = o.optBoolean("exists", true);
                ROOTS.add(r);
            }
        } catch (Exception e) {
            Log.w(TAG, "load roots: " + e.getMessage());
        }
    }

    private static void saveRoots(Context ctx) {
        JSONArray arr = new JSONArray();
        for (Root r : ROOTS) {
            if (r.id != null && r.id.startsWith("__")) continue;   // 自动目录不持久化
            JSONObject o = r.toJson();
            try {
                o.put("treeUri", r.treeUri == null ? "" : r.treeUri);
            } catch (Exception ignored) {
            }
            arr.put(o);
        }
        ctx.getSharedPreferences("bd2viewer", Context.MODE_PRIVATE)
                .edit().putString("roots", arr.toString()).apply();
    }

    /**
     * 只返回元信息，不带 items。
     * 原来把整个 items（大目录时是几 MB 的 JSON）用 evaluateJavascript 一次性推给 JS，
     * 会直接把进程压崩；改成 JS 先拿元信息、再分页同步拉取。
     *
     * `mode` 决定用哪套命名约定（见上面「资产命名约定」）。它参与**缓存键** ——
     * 否则切到 Lost Sword 再切回来会拿到另一种约定的旧结果，表现为「切了没反应」。
     */
    public static JSONObject scan(Context ctx, String rootId, boolean force, String mode) {
        long t0 = System.currentTimeMillis();
        if (mode == null || mode.isEmpty()) mode = MODE_BD;
        // 自动根按 mode 切到 BD2Viewer/{bd2,nikke,lostsword}；用户 SAF 根不动
        if (rootId != null && rootId.startsWith("__")) {
            synchronized (ROOTS_LOCK) {
                bindModeRoots(ctx, mode);
            }
        } else {
            boundMode = mode;
        }
        Root root = rootById(rootId);
        String key = cacheKey(rootId, mode);
        JSONArray items;
        synchronized (SCAN_LOCK) { items = CACHE.get(key); }

        JSONObject jczxMeta = null;
        JSONObject nikkeAbMeta = null;
        if (force || items == null) {
            JSONArray fresh = new JSONArray();
            dirCount = 0;
            // JCZX 解包（LZMA→百兆级）在中端机上可能要几十秒；放宽预算避免扫一半被掐。
            // NIKKE 同理：包级并发 ≤ NikkeAbExtractor.MAX_CONCURRENT（优先级队列，后台续解）。
            long budget = MODE_JCZX.equals(mode) ? Math.max(SCAN_BUDGET_MS, 180_000L)
                    : (MODE_NIKKE.equals(mode) ? Math.max(SCAN_BUDGET_MS, 120_000L) : SCAN_BUDGET_MS);
            deadline = System.currentTimeMillis() + budget;
            synchronized (SCAN_LOCK) {
                java.util.Iterator<String> it = DOCS.keySet().iterator();
                while (it.hasNext()) if (it.next().startsWith(rootId + "|")) it.remove();
                // 本次扫描会把这个 rootId 的 DOCS 整个重建，其它 mode 桶的缓存项
                // 此刻已经指向不存在的索引了，必须一起丢掉，否则切回去会 404。
                // 按 rootId| 前缀清（含 bd / lostsword / nikke / jczx），以后加 mode 不用再改这里。
                java.util.Iterator<String> cit = CACHE.keySet().iterator();
                while (cit.hasNext()) {
                    String k = cit.next();
                    if (k.equals(rootId) || k.startsWith(rootId + "|")) cit.remove();
                }
            }
            if (root != null) {
                // JCZX：扫描前把根下双 UnityFS AB 解到 bd2viewer-jczx/（纯 Java，无 Python）
                if (MODE_JCZX.equals(mode) && "file".equals(root.kind) && root.path != null) {
                    try {
                        JczxExtractor.migrateLegacyCache(new File(root.path));
                        jczxMeta = JczxExtractor.prepareRoot(new File(root.path));
                        Log.i(TAG, "jczx prepare: " + jczxMeta);
                    } catch (Throwable e) {
                        Log.e(TAG, "jczx prepare failed", e);
                        try {
                            jczxMeta = new JSONObject();
                            jczxMeta.put("ok", false);
                            jczxMeta.put("bundles", 0);
                            jczxMeta.put("extracted", new JSONArray());
                            jczxMeta.put("reused", new JSONArray());
                            JSONArray errs = new JSONArray();
                            errs.put(new JSONObject().put("src", JSONObject.NULL)
                                    .put("error", String.valueOf(e.getMessage())));
                            jczxMeta.put("errors", errs);
                        } catch (Exception ignored) { /* */ }
                    }
                }
                // NIKKE：把根下的 mod 包（UnityFS，无扩展名）解成标准三件套放进
                // `bd2viewer-nikke/`（纯 Java，无 Python）。**不**过滤可见项 ——
                // NIKKE 档还要照常认用户手里原有的裸 .atlas/.skel 目录。
                if (MODE_NIKKE.equals(mode) && "file".equals(root.kind) && root.path != null) {
                    try {
                        NikkeAbExtractor.migrateLegacyCache(new File(root.path));
                        nikkeAbMeta = NikkeAbExtractor.prepareRoot(new File(root.path));
                        Log.i(TAG, "nikke-ab prepare: " + nikkeAbMeta);
                    } catch (Throwable e) {
                        Log.e(TAG, "nikke-ab prepare failed", e);
                        try {
                            nikkeAbMeta = new JSONObject();
                            nikkeAbMeta.put("found", 0);
                            nikkeAbMeta.put("extracted", 0);
                            nikkeAbMeta.put("reused", 0);
                            nikkeAbMeta.put("pending", 0);
                            nikkeAbMeta.put("ready", false);
                            JSONArray errs = new JSONArray();
                            errs.put(new JSONObject().put("error", String.valueOf(e.getMessage())));
                            nikkeAbMeta.put("errors", errs);
                        } catch (Exception ignored) { /* */ }
                    }
                }
                // prepare（尤其是旧版同步 JCZX）可能已吃掉预算；walk 前重置，
                // 保证已就绪的 bd2viewer-jczx/ / bd2viewer-nikke/ 能被列进 gallery。
                deadline = System.currentTimeMillis() + budget;
                if ("ms".equals(root.kind)) {
                    walkMs(ctx, fresh, root, mode);
                } else if ("file".equals(root.kind) && root.path != null) {
                    walkFile(new File(root.path), 0, fresh, root, mode);
                } else if (root.treeUri != null) {
                    walkSaf(ctx, Uri.parse(root.treeUri), "", 0, fresh, root, mode);
                }
                // 补 `item.jczx`（层信息）与 `item.ark`（中文名/立绘/**语音**）。
                // 必须在 jczx 过滤**之前** —— 过滤要用到刚补出来的 item.jczx。
                enrich(ctx, root, fresh, mode);
                // jczx 模式保留两种来源：解包缓存（bd2viewer-jczx/）**或**带层信息的图鉴包
                // （原布局 source|mod1|mod2，以及 2026-10-03 就地重组后的「整理树」角色/画册）。
                // ⚠️ 旧版只留 `isCacheRel` → 手机端完全看不到图鉴包内容（用户 2026-10-03 反馈）。
                if (MODE_JCZX.equals(mode)) {
                    JSONArray filtered = new JSONArray();
                    for (int i = 0; i < fresh.length(); i++) {
                        JSONObject o = fresh.optJSONObject(i);
                        if (o == null) continue;
                        String rel = o.optString("relAtlas", o.optString("id", ""));
                        if (JczxExtractor.isCacheRel(rel) || o.has("jczx")) filtered.put(o);
                    }
                    fresh = filtered;
                }
            }
            synchronized (SCAN_LOCK) { CACHE.put(key, fresh); }
            items = fresh;
        }

        int playable = 0;
        for (int i = 0; i < items.length(); i++) {
            if (items.optJSONObject(i).optBoolean("ok", false)) playable++;
        }
        JSONObject out = new JSONObject();
        try {
            out.put("root", root == null ? new JSONObject() : root.toJson());
            out.put("rootId", rootId == null ? "" : rootId);
            out.put("mode", mode == null ? MODE_BD : mode);
            out.put("itemCount", items.length());
            out.put("playableCount", playable);
            out.put("truncated", dirCount >= MAX_DIRS);
            out.put("scanMs", (int) (System.currentTimeMillis() - t0));
            if (jczxMeta != null) out.put("jczx", jczxMeta);
            if (nikkeAbMeta != null) out.put("nikkeAb", nikkeAbMeta);
        } catch (Exception ignored) {
        }
        return out;
    }

    private static String cacheKey(String rootId, String mode) {
        return rootId + "|" + (mode == null || mode.isEmpty() ? MODE_BD : mode);
    }

    public static int scanCount(String rootId, String mode) {
        synchronized (SCAN_LOCK) {
            JSONArray a = CACHE.get(cacheKey(rootId, mode));
            return a == null ? 0 : a.length();
        }
    }

    /** 分页取扫描结果：一次几十条，避免构造/传递超大 JSON 字符串 */
    public static String scanPage(String rootId, int from, int count, String mode) {
        JSONArray items;
        synchronized (SCAN_LOCK) { items = CACHE.get(cacheKey(rootId, mode)); }
        if (items == null) return "[]";
        JSONArray page = new JSONArray();
        int start = Math.max(0, from);
        int end = Math.min(items.length(), start + Math.max(1, count));
        for (int i = start; i < end; i++) {
            JSONObject o = items.optJSONObject(i);
            if (o != null) page.put(o);
        }
        return page.toString();
    }

    /* ------------------------------------------------- 直读文件模式 */

    private static void walkFile(File dir, int depth, JSONArray out, Root root, String mode) {
        if (depth > MAX_DEPTH || out.length() >= MAX_ITEMS) return;
        if (++dirCount > MAX_DIRS || System.currentTimeMillis() > deadline) return;
        File[] list = dir.listFiles();
        if (list == null) return;
        Map<String, List<Entry>> byExt = new LinkedHashMap<>();
        List<File> subdirs = new ArrayList<>();
        for (File f : list) {
            if (f.isDirectory()) {
                String n = f.getName().toLowerCase(Locale.ROOT);
                if (SKIP_DIRS.contains(n)) continue;
                // 别的游戏的素材目录一律不 walk（depth 0 也跳）—— 见 APK-fixes §4
                if (UnpackCacheHome.isOtherGameFolder(f.getName(), UnpackCacheHome.folderOfMode(mode))) continue;
                // JCZX 解包缓存（含旧版 .bd2viewer-jczx）：仅 jczx 模式进入
                if (JczxExtractor.isCacheDirName(f.getName()) && !MODE_JCZX.equals(mode)) continue;

                // NIKKE 解包缓存：仅 nikke 档进入（否则 BD2 档会把抽出来的资产再摆一遍）

                if (NikkeAbExtractor.isCacheDirName(f.getName()) && !MODE_NIKKE.equals(mode)) continue;
                subdirs.add(f);
            } else if (f.isFile()) {
                Role r = classify(f.getName(), mode);
                if (r == null || r.bucket == null) continue;
                Entry e = new Entry();
                e.name = f.getName();
                e.file = f;
                byExt.computeIfAbsent(r.bucket, k -> new ArrayList<>()).add(e);
            }
        }
        emitEntries(null, root, relDirOf(root, dir), byExt, out, mode);
        for (File d : subdirs) walkFile(d, depth + 1, out, root, mode);
    }

    /** 目录相对根目录的路径，"" 表示根 */
    private static String relDirOf(Root root, File dir) {
        String full = dir.getAbsolutePath();
        String base = root.path;
        if (base != null && full.startsWith(base)) {
            String r = full.substring(base.length());
            return r.replace("\\", "/").replaceAll("^/+", "").replaceAll("/+$", "");
        }
        return dir.getName();
    }

    /* ------------------------------------------------- 后置补齐：jczx 层 / ark 元数据 */

    /**
     * 给扫描结果补两块桌面 `server.mjs` 有、安卓此前完全没有的数据（逻辑在 {@link PackMeta}）：
     *   · `item.jczx` —— 层信息，前端靠它做「形态 × mod 两级归组」
     *   · `item.ark`  —— 中文名 / 稀有度 / 立绘 / **语音**（语音只能列目录得到，
     *     所以手机端此前一条 wav 都播不出来）
     *
     * 放在 walk 之后做**一次后置遍历**，而不是塞进三个 walker 里 ——
     * 三个 walker（file / SAF / MediaStore）共用这一份逻辑，不会各自跑偏。
     */
    static void enrich(Context ctx, Root root, JSONArray items, String mode) {
        // 补齐只是**锦上添花**（中文名/立绘/语音/层信息），绝不能因为它让整次扫描失败。
        // 这里兜住 Throwable（含 OutOfMemoryError 这类 Error）：扫不到名字也比「一扫描就崩」好。
        try {
            enrich0(ctx, root, items, mode);
        } catch (Throwable t) {
            Log.w(TAG, "enrich 失败（忽略，继续用未补齐的结果）: " + t);
        }
    }

    private static void enrich0(Context ctx, Root root, JSONArray items, String mode) {
        if (items == null || items.length() == 0 || root == null) return;
        boolean jczx = MODE_JCZX.equals(mode);
        boolean ark = MODE_ARK.equals(mode);
        if (!jczx && !ark) return;

        PackMeta.IO io = null;
        try {
            if ("file".equals(root.kind) && root.path != null) {
                io = PackMeta.fileIo(root.path);
            } else if (root.treeUri != null) {
                io = PackMeta.safIo(ctx, Uri.parse(root.treeUri));
            }
        } catch (Throwable e) {
            Log.w(TAG, "enrich io: " + e.getMessage());
        }
        if (io == null) return;

        Map<String, String> names = jczx ? PackMeta.readNameTable(io) : null;
        // 角色目录 → meta（null 表示查过但没有 meta.json）。一次遍历里复用，别反复读盘。
        Map<String, JSONObject> metaCache = new LinkedHashMap<>();

        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            String rel = it.optString("relAtlas", "");
            if (rel.isEmpty()) continue;
            // 单个条目出问题只跳过它自己 —— 别让一条脏数据毁掉整批补齐
            try {
                String base = it.optString("base", "");
                String dir = PackMeta.parentDir(rel);

                JSONObject jczxInfo = jczx ? PackMeta.layerOf(dir) : null;
                if (jczxInfo != null) {
                    String targetId = jczxInfo.optString("targetId", "");
                    PackMeta.fillTargetKey(jczxInfo, targetId, base, jczxInfo.optBoolean("fromCache", false));
                    it.put("jczx", jczxInfo);
                }

                // 角色目录：从条目目录向上找第一个带 meta.json 的祖先（最多 6 层）。
                // 整理树是 `角色/<ID>__名/meta.json`（2 层），原布局是 `角色/<ID>/meta.json`（1 层）。
                String charRel = null;
                JSONObject meta = null;
                int up = 0;
                for (String d = dir; d != null && !d.isEmpty() && up < 6; d = PackMeta.parentDir(d), up++) {
                    JSONObject m;
                    if (metaCache.containsKey(d)) {
                        m = metaCache.get(d);
                    } else {
                        m = PackMeta.readMeta(io, d);
                        metaCache.put(d, m);
                    }
                    if (m != null) { meta = m; charRel = d; break; }
                }
                if (meta != null) it.put("ark", buildArk(meta, base, charRel, jczx, names));
            } catch (Throwable t) {
                Log.w(TAG, "enrich 单条跳过: " + rel + " / " + t);
            }
        }
    }

    /** 与 server.mjs 的 `ark` 对象**同形状**（前端一行都不用改）。 */
    private static JSONObject buildArk(JSONObject meta, String base, String charRel,
                                       boolean jczx, Map<String, String> names) {
        JSONObject out = new JSONObject();
        try {
            String charId = meta.optString("id", "");
            JSONArray assets = meta.optJSONArray("spineAssets");
            if (assets == null) assets = new JSONArray();
            int formIndex = -1;
            for (int i = 0; i < assets.length(); i++) {
                if (base.equals(assets.optJSONObject(i).optString("bundle"))) { formIndex = i; break; }
            }
            boolean isCarrier = base.equals(meta.optString("carrierBundle", ""));

            String code = PackMeta.skinCode(base);
            String metaName = meta.isNull("name") ? null : meta.optString("name", null);
            String metaNameReal = metaName != null && !metaName.matches("^\\d+$") ? metaName : null;
            String codeName = jczx ? PackMeta.zhForSkin(names, code) : null;

            out.put("charId", charId);
            out.put("charName", codeName != null ? codeName : (metaNameReal == null ? JSONObject.NULL : metaNameReal));
            out.put("charAltName", metaNameReal == null ? JSONObject.NULL : metaNameReal);
            out.put("charCode", jczx ? code : JSONObject.NULL);
            out.put("rarity", meta.isNull("rarity") ? JSONObject.NULL : meta.opt("rarity"));
            out.put("group", charId);
            out.put("formBundle", base);
            out.put("formLabel", jczx ? code : base);
            out.put("formIndex", jczx && formIndex >= 0 ? formIndex : JSONObject.NULL);
            out.put("formCount", jczx ? assets.length() : JSONObject.NULL);
            // 默认形态：JCZX 取形态表第一条；Ark 是「bundle 名 == 角色 id」那条
            out.put("isDefaultForm", jczx ? formIndex == 0 : base.equals(charId));
            out.put("isCarrier", isCarrier);

            JSONArray statics = new JSONArray();
            JSONArray voices = new JSONArray();
            if (isCarrier) {
                JSONArray src = meta.optJSONArray("statics");
                if (src != null) {
                    for (int i = 0; i < src.length(); i++) {
                        JSONObject s = src.optJSONObject(i);
                        if (s == null) continue;
                        String f = s.optString("file", "");
                        if (f.isEmpty()) continue;
                        JSONObject o = new JSONObject(s.toString());
                        o.put("url", charRel + "/" + f);
                        statics.put(o);
                    }
                }
                JSONArray vs = meta.optJSONArray("voices");
                if (vs != null) {
                    for (int i = 0; i < vs.length(); i++) {
                        JSONObject v = vs.optJSONObject(i);
                        if (v == null) continue;
                        String f = v.optString("file", "");
                        if (f.isEmpty()) continue;
                        JSONObject o = new JSONObject(v.toString());
                        o.put("url", charRel + "/" + f);
                        voices.put(o);
                    }
                }
            }
            out.put("statics", statics);
            out.put("voices", voices);
        } catch (Exception e) {
            Log.w(TAG, "buildArk: " + e.getMessage());
        }
        return out;
    }

    private static void emitEntries(Context ctx, Root root, String dirRel,
                                    Map<String, List<Entry>> byExt, JSONArray out, String mode) {
        if (dirRel == null) dirRel = "";
        if (out.length() >= MAX_ITEMS) return;
        List<Entry> atlases = byExt.getOrDefault(K_ATLAS, new ArrayList<>());
        for (Entry atlas : atlases) {
            String base = classifyBaseOf(atlas.name);
            List<Entry> jsons = byExt.getOrDefault(K_JSON, new ArrayList<>());
            List<Entry> skels = byExt.getOrDefault(K_SKEL, new ArrayList<>());
            Entry skeleton = pickByBase(jsons, base, e -> e.name);
            String kind = K_JSON;
            if (skeleton == null) {
                skeleton = pickByBase(skels, base, e -> e.name);
                kind = K_SKEL;
            }
            if (skeleton == null) kind = null;
            List<Entry> thumbs = byExt.getOrDefault(K_THUMB, new ArrayList<>());
            Entry thumb = thumbs.isEmpty() ? null : thumbs.get(0);

            List<String> pages = parseAtlasPages(readTextEntry(ctx, atlas));
            List<Entry> imgs = new ArrayList<>();
            for (String e : IMG_EXT) imgs.addAll(byExt.getOrDefault(e, new ArrayList<>()));
            if (pages.isEmpty()) {
                // 兜底按基名前缀猜，但排除预算好的 thumb.png ——
                // 否则 "Agravaine" 这种基名会把 thumb 当图集页（Lost Sword 实测有这个坑）
                for (Entry f : imgs) {
                    if (thumb != null && f.name.equals(thumb.name)) continue;
                    if (baseName(f.name).startsWith(base)) pages.add(f.name);
                }
                if (pages.isEmpty()) {
                    for (Entry f : imgs) {
                        if (thumb != null && f.name.equals(thumb.name)) continue;
                        pages.add(f.name);
                        break;
                    }
                }
            }
            List<Entry> images = new ArrayList<>();
            List<String> missing = new ArrayList<>();
            for (String p : pages) {
                Entry hit = null;
                String pageBase = new File(p).getName();
                for (Entry f : imgs) {
                    if (f.name.equals(p) || f.name.equals(pageBase)
                            || f.name.equalsIgnoreCase(p) || f.name.equalsIgnoreCase(pageBase)) {
                        hit = f; break;
                    }
                }
                if (hit != null) images.add(hit);
                else missing.add(p);
            }
            String relAtlas = relOf(dirRel, atlas.name);
            try {
                JSONObject o = new JSONObject();
                o.put("id", relAtlas);
                o.put("dir", dirRel.isEmpty() ? (root.path == null ? "/" : root.path) : dirRel);
                o.put("group", relAtlas.contains("/") ? relAtlas.split("/")[0] : "（根目录）");
                o.put("folder", folderOf(dirRel.isEmpty() ? root.path : dirRel, "根目录"));
                o.put("base", base);
                o.put("atlas", atlas.name);
                o.put("relAtlas", relAtlas);
                o.put("relSkeleton", skeleton == null ? null : relOf(dirRel, skeleton.name));
                o.put("skeleton", skeleton == null ? null : skeleton.name);
                String spineMinor = spineMinorOfEntry(skeleton, kind);
                o.put("skeletonKind", skeleton == null ? null : kindOfBucket(kind));
                if (spineMinor != null) o.put("spineMinor", spineMinor);
                else o.put("spineMinor", JSONObject.NULL);
                // 需求 5：thumb.png 的 mtime 必须 ≥ 资产文件，否则当无效让前端重渲覆盖
                Entry freshThumb = thumb;
                if (freshThumb != null) {
                    long tm = mtimeOf(freshThumb);
                    long newest = mtimeOf(atlas);
                    if (skeleton != null) newest = Math.max(newest, mtimeOf(skeleton));
                    for (Entry f : images) newest = Math.max(newest, mtimeOf(f));
                    if (tm > 0 && tm < newest) freshThumb = null;
                }
                o.put("relThumb", freshThumb == null ? null : relOf(dirRel, freshThumb.name));
                JSONArray im = new JSONArray();
                for (Entry f : images) im.put(f.name);
                JSONArray rim = new JSONArray();
                for (Entry f : images) rim.put(relOf(dirRel, f.name));
                JSONArray mi = new JSONArray();
                for (String s : missing) mi.put(s);
                o.put("images", im);
                o.put("relImages", rim);
                o.put("missingImages", mi);
                o.put("ok", skeleton != null && !images.isEmpty() && missing.isEmpty());
                o.put("problems", problems(skeleton, images.isEmpty()));
                // 文件改动时间：前端用它决定缩略图缓存要不要失效
                o.put("mtime", mtimeOf(atlas));
                out.put(o);
                indexEntry(root, atlas, relAtlas);
                if (skeleton != null) indexEntry(root, skeleton, relOf(dirRel, skeleton.name));
                if (thumb != null) indexEntry(root, thumb, relOf(dirRel, thumb.name));
                for (Entry f : images) indexEntry(root, f, relOf(dirRel, f.name));
            } catch (Exception e) {
                Log.w(TAG, "json: " + e.getMessage());
            }
        }
        if (atlases.isEmpty() && MODE_JCZX.equals(mode)) emitCgStill(root, dirRel, byExt, out);
    }

    /** JCZX 纯 CG：缓存目录里只有 png、没有 atlas。 */
    private static void emitCgStill(Root root, String dirRel,
                                    Map<String, List<Entry>> byExt, JSONArray out) {
        if (out.length() >= MAX_ITEMS) return;
        if (dirRel == null) dirRel = "";
        String rel = dirRel.replace('\\', '/');
        boolean inCache = rel.equals("bd2viewer-jczx") || rel.startsWith("bd2viewer-jczx/")
                || rel.contains("/bd2viewer-jczx/")
                || rel.equals(".bd2viewer-jczx") || rel.startsWith(".bd2viewer-jczx/")
                || rel.contains("/.bd2viewer-jczx/");
        if (!inCache) return;
        // 只要包名带 _draw 的静态 CG。动画贴图包没有骨架，不能进这里。
        if (!rel.toLowerCase(Locale.ROOT).contains("_draw")) return;
        List<Entry> pngs = new ArrayList<>();
        for (String ext : IMG_EXT) {
            for (Entry f : byExt.getOrDefault(ext, new ArrayList<>())) {
                if (f == null || f.name == null) continue;
                if (f.name.equalsIgnoreCase("thumb.png")) continue;
                if (f.name.toLowerCase(Locale.ROOT).endsWith(".png")) pngs.add(f);
            }
        }
        if (pngs.isEmpty()) return;
        Entry first = pngs.get(0);
        String relFirst = relOf(dirRel, first.name);
        String rawFolder = folderOf(dirRel.isEmpty() ? root.path : dirRel, "根目录");
        String pretty = rawFolder.replaceFirst("^[0-9a-fA-F]{10}_", "");
        try {
            JSONObject o = new JSONObject();
            o.put("id", relFirst);
            o.put("dir", dirRel.isEmpty() ? (root.path == null ? "/" : root.path) : dirRel);
            o.put("group", relFirst.contains("/") ? relFirst.split("/")[0] : "（根目录）");
            o.put("folder", pretty.isEmpty() ? rawFolder : pretty);
            o.put("base", baseName(first.name));
            o.put("atlas", JSONObject.NULL);
            o.put("relAtlas", relFirst);
            o.put("relSkeleton", JSONObject.NULL);
            o.put("skeleton", JSONObject.NULL);
            o.put("skeletonKind", JSONObject.NULL);
            o.put("spineMinor", JSONObject.NULL);
            o.put("imageOnly", true);
            o.put("relThumb", JSONObject.NULL);
            JSONArray im = new JSONArray();
            JSONArray rim = new JSONArray();
            for (Entry f : pngs) {
                im.put(f.name);
                rim.put(relOf(dirRel, f.name));
                indexEntry(root, f, relOf(dirRel, f.name));
            }
            o.put("images", im);
            o.put("relImages", rim);
            o.put("missingImages", new JSONArray());
            o.put("ok", true);
            o.put("problems", new JSONArray());
            o.put("mtime", mtimeOf(first));
            out.put(o);
        } catch (Exception e) {
            Log.w(TAG, "cg json: " + e.getMessage());
        }
    }

    private static void indexEntry(Root root, Entry e, String rel) {
        Doc d = new Doc();
        d.rel = rel;
        d.file = e.file;
        d.uri = e.uri;
        DOCS.put(root.id + "|" + rel, d);
    }

    private static String relOf(String dirRel, String name) {
        return dirRel == null || dirRel.isEmpty() ? name : dirRel + "/" + name;
    }

    /* ------------------------------------------------------------ 删除 */

    /**
     * 删除一整套资产：atlas + skeleton + 它引用的贴图，最后顺手清掉空目录。
     *
     * 路径直接查扫描时索引好的 DOCS（rootId|rel → 绝对 File / SAF uri），
     * 所以不存在越界问题：没被索引过的 rel 一律当失败。
     * 逐条删，一条失败不影响其它条。
     *
     * 这是**不可恢复**的操作。前端在调进来之前已经弹过带文件清单的二次确认。
     */
    public static String deleteItems(Context ctx, String rootId, String json) {
        JSONObject out = new JSONObject();
        JSONArray deleted = new JSONArray();
        JSONArray failed = new JSONArray();
        try {
            Root root = rootById(rootId);
            JSONArray items = new JSONArray(json == null || json.isEmpty() ? "[]" : json);
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it == null) continue;
                String relAtlas = it.optString("relAtlas", "");
                List<String> rels = new ArrayList<>();
                if (!relAtlas.isEmpty()) rels.add(relAtlas);
                String sk = it.optString("relSkeleton", "");
                if (!sk.isEmpty()) rels.add(sk);
                String th = it.optString("relThumb", "");
                if (!th.isEmpty()) rels.add(th);
                JSONArray imgs = it.optJSONArray("relImages");
                if (imgs != null) {
                    for (int j = 0; j < imgs.length(); j++) {
                        String s = imgs.optString(j, "");
                        if (!s.isEmpty()) rels.add(s);
                    }
                }
                if (rels.isEmpty()) {
                    failed.put(failObj(relAtlas, "缺少文件路径"));
                    continue;
                }
                boolean allGone = true;
                for (String rel : rels) {
                    String why = removeRel(ctx, root, rel);
                    if (why != null) {
                        failed.put(failObj(relAtlas, why));
                        allGone = false;
                    }
                }
                if (allGone) {
                    deleted.put(relAtlas);
                    pruneEmptyDirs(root, relAtlas);
                }
            }
            // 扫描结果里还留着已删的条目 → 所有 mode 桶的缓存都作废，下次扫描重新走一遍
            if (deleted.length() > 0) {
                synchronized (SCAN_LOCK) {
                    java.util.Iterator<String> cit = CACHE.keySet().iterator();
                    while (cit.hasNext()) {
                        String k = cit.next();
                        if (k.equals(rootId) || k.startsWith(rootId + "|")) cit.remove();
                    }
                }
            }
            out.put("ok", true);
            out.put("deleted", deleted);
            out.put("failed", failed);
        } catch (Throwable e) {
            try {
                out.put("ok", false);
                out.put("deleted", deleted);
                out.put("failed", failed);
                out.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return out.toString();
    }

    /** 删一个文件。返回 null = 成功（包括「本来就不在」），否则是失败原因。 */
    private static String removeRel(Context ctx, Root root, String rel) {
        Doc d = DOCS.get((root == null ? "" : root.id) + "|" + rel);
        if (d == null) return "找不到文件：" + rel;
        try {
            if (d.file != null) {
                if (!d.file.exists()) return null;
                return d.file.delete() ? null : "删除被系统拒绝：" + rel;
            }
            if (d.uri != null) {
                if (ctx == null) return "拿不到上下文，无法删除：" + rel;
                try {
                    DocumentsContract.deleteDocument(ctx.getContentResolver(), d.uri);
                    return null;
                } catch (Throwable e) {
                    return "该目录不支持删除（SAF）：" + rel;
                }
            }
        } catch (Throwable e) {
            return rel + "：" + e.getMessage();
        }
        return "无法删除：" + rel;
    }

    /** 删完文件往上清空目录，但绝不越过 root 本身 */
    private static void pruneEmptyDirs(Root root, String relAtlas) {
        if (root == null || root.path == null || relAtlas == null || relAtlas.isEmpty()) return;
        try {
            File base = new File(root.path).getCanonicalFile();
            File dir = new File(base, relAtlas).getParentFile();
            while (dir != null && !dir.equals(base)) {
                if (!dir.getCanonicalPath().startsWith(base.getCanonicalPath())) break;
                File[] kids = dir.listFiles();
                if (kids != null && kids.length > 0) break;
                if (!dir.delete()) break;
                dir = dir.getParentFile();
            }
        } catch (Throwable ignored) {
        }
    }

    private static JSONObject failObj(String relAtlas, String reason) {
        JSONObject o = new JSONObject();
        try {
            o.put("relAtlas", relAtlas == null ? "" : relAtlas);
            o.put("reason", reason == null ? "未知原因" : reason);
        } catch (Exception ignored) {
        }
        return o;
    }

    /**
     * 删除整个目录（仅允许当前 root 下的相对路径，不能删 root 本身）。
     * 含 NIKKE/JCZX 源包时先清解包缓存。返回 JSON 字符串。
     */
    public static String deleteDirectory(Context ctx, String rootId, String relDirRaw) {
        JSONObject out = new JSONObject();
        JSONArray clearedCache = new JSONArray();
        try {
            Root root = rootById(rootId);
            if (root == null) {
                out.put("ok", false);
                out.put("error", "找不到根目录");
                out.put("clearedCache", clearedCache);
                return out.toString();
            }
            String rel = relDirRaw == null ? "" : relDirRaw.replace('\\', '/').trim();
            while (rel.startsWith("/")) rel = rel.substring(1);
            while (rel.endsWith("/")) rel = rel.substring(0, rel.length() - 1);
            if (rel.isEmpty() || ".".equals(rel)) {
                out.put("ok", false);
                out.put("error", "不能删除根目录本身");
                out.put("clearedCache", clearedCache);
                return out.toString();
            }
            // 拒绝 .. 与绝对路径
            if (rel.contains("..") || rel.startsWith("/") || rel.matches("^[A-Za-z]:.*")) {
                out.put("ok", false);
                out.put("error", "路径越界，已拒绝：" + rel);
                out.put("clearedCache", clearedCache);
                return out.toString();
            }

            if (root.path != null) {
                File base = new File(root.path).getCanonicalFile();
                File dir = new File(base, rel).getCanonicalFile();
                String bp = base.getPath();
                String dp = dir.getPath();
                if (!dp.equals(bp) && !dp.startsWith(bp + File.separator)) {
                    out.put("ok", false);
                    out.put("error", "路径越界，已拒绝：" + rel);
                    out.put("clearedCache", clearedCache);
                    return out.toString();
                }
                if (dp.equals(bp)) {
                    out.put("ok", false);
                    out.put("error", "不能删除根目录本身");
                    out.put("clearedCache", clearedCache);
                    return out.toString();
                }
                if (!dir.exists()) {
                    out.put("ok", true);
                    out.put("deleted", rel);
                    out.put("missing", true);
                    out.put("clearedCache", clearedCache);
                    invalidateRootCache(rootId);
                    return out.toString();
                }
                if (!dir.isDirectory()) {
                    out.put("ok", false);
                    out.put("error", "不是目录：" + rel);
                    out.put("clearedCache", clearedCache);
                    return out.toString();
                }
                // 清解包缓存（源还在时才能按文件名/前缀匹配）
                try {
                    for (String c : NikkeAbExtractor.clearCacheForDeletedDir(base, rel)) clearedCache.put(c);
                    for (String c : JczxExtractor.clearCacheForDeletedDir(base, rel)) clearedCache.put(c);
                } catch (Throwable ignored) { /* */ }
                deleteRecFile(dir);
                // 清 DOCS 索引里该前缀
                String prefix = root.id + "|" + rel;
                java.util.Iterator<String> it = DOCS.keySet().iterator();
                while (it.hasNext()) {
                    String k = it.next();
                    if (k.equals(prefix) || k.startsWith(prefix + "/")) it.remove();
                }
                invalidateRootCache(rootId);
                out.put("ok", true);
                out.put("deleted", rel);
                out.put("clearedCache", clearedCache);
                return out.toString();
            }

            // SAF：尽量删目录文档
            if (root.treeUri != null && ctx != null) {
                try {
                    Uri tree = Uri.parse(root.treeUri);
                    String docId = docIdOf(tree, rel);
                    Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
                    DocumentsContract.deleteDocument(ctx.getContentResolver(), uri);
                    // 清缓存：SAF 源路径下的解包缓存若在 file root 不可用；跳过 file 清
                    invalidateRootCache(rootId);
                    out.put("ok", true);
                    out.put("deleted", rel);
                    out.put("clearedCache", clearedCache);
                    return out.toString();
                } catch (Throwable e) {
                    out.put("ok", false);
                    out.put("error", "该目录不支持删除（SAF）：" + e.getMessage());
                    out.put("clearedCache", clearedCache);
                    return out.toString();
                }
            }
            out.put("ok", false);
            out.put("error", "无法删除：根目录无本地路径");
            out.put("clearedCache", clearedCache);
        } catch (Throwable e) {
            try {
                out.put("ok", false);
                out.put("error", String.valueOf(e.getMessage()));
                out.put("clearedCache", clearedCache);
            } catch (Exception ignored) { }
        }
        return out.toString();
    }

    private static void invalidateRootCache(String rootId) {
        if (rootId == null) return;
        synchronized (SCAN_LOCK) {
            java.util.Iterator<String> cit = CACHE.keySet().iterator();
            while (cit.hasNext()) {
                String k = cit.next();
                if (k.equals(rootId) || k.startsWith(rootId + "|")) cit.remove();
            }
        }
    }

    /** 递归删目录/文件（file 根专用）。 */
    private static void deleteRecFile(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecFile(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }


    /* pickSkeleton / pickSkeletonSaf 已被通用的 pickByBase 取代 ——
       它按「当前命名约定」算基名，两种游戏共用一套级联逻辑，不再各写一份。 */

    /** 文件修改时间（毫秒）：前端拿它判断缩略图缓存要不要失效 */
    private static long mtimeOf(Entry e) {
        try {
            if (e.file != null) return e.file.lastModified();
        } catch (Exception ignored) {
        }
        return 0;
    }

    /** SAF / ms provider 模式拿不到可靠的 mtime，返回 0（这类目录的缓存就不按时间失效） */
    private static long mtimeOf(SafEntry e) {
        return 0;
    }

    private static String readTextEntry(Context ctx, Entry e) {
        try (InputStream in = openEntry(ctx, e)) {
            return in == null ? "" : readAll(in);
        } catch (Exception ex) {
            return "";
        }
    }

    private static InputStream openEntry(Context ctx, Entry e) {
        try {
            if (e.file != null) return new FileInputStream(e.file);
            if (e.uri != null && ctx != null) return ctx.getContentResolver().openInputStream(e.uri);
        } catch (Exception ex) {
            Log.w(TAG, "open: " + ex.getMessage());
        }
        return null;
    }

    /* ------------------------------------------------- MediaStore 模式
       没有「所有文件访问权限」时，Download 目录只能这样读：
       按 relative_path 前缀从 Downloads / Files 集合里查条目，再用 openInputStream 读内容。
       读的是 Downloads 集合，Android 11+ 对它免权限。

       ⚠ 当前**不可达**：只有 root.kind == "ms" 才会走到 walkMs()，而工程里没有任何
       地方会生成 kind="ms" 的 root（refreshAutoRoots 只用 "file"）。这是当初为
       「拿不到 MANAGE_EXTERNAL_STORAGE 也要能读公共目录」留的备用通路，
       后来实际采用的是「App 专属目录」兜底，所以它一直没被接上。

       保留它的原因：如果哪天要支持「不申请任何敏感权限也能读 Downloads/BD2Viewer」，
       这就是唯一现成的实现。
       要启用：给 Root 的 kind 赋 "ms"（例如在 refreshAutoRoots 里加一个 putAuto(..., "ms")），
       并确认 storageStatus() 的提示文案与之匹配。
       */

    /** MediaStore 备用通路读的位置（Download/BD2Viewer），只在没有直读权限时用得上 */
    private static final String MS_REL = "Download/" + DIR_NAME + "/";

    private static void walkMs(Context ctx, JSONArray out, Root root, String mode) {
        if (ctx == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        ContentResolver cr = ctx.getContentResolver();
        Map<String, Map<String, List<Entry>>> byDir = new LinkedHashMap<>();
        collectMs(cr, MediaStore.Files.getContentUri("external"), byDir, mode);
        collectMs(cr, MediaStore.Downloads.EXTERNAL_CONTENT_URI, byDir, mode);
        List<String> dirs = new ArrayList<>(byDir.keySet());
        dirs.sort(Comparator.comparingInt((String s) -> s.isEmpty() ? 0 : 1).thenComparing(s -> s));
        for (String d : dirs) {
            if (++dirCount > MAX_DIRS || System.currentTimeMillis() > deadline) break;
            emitEntries(ctx, root, d, byDir.get(d), out, mode);
        }
        Log.i(TAG, "ms scan: " + byDir.size() + " 个目录 / " + out.length() + " 项");
    }

    private static void collectMs(ContentResolver cr, Uri base,
                                  Map<String, Map<String, List<Entry>>> byDir, String mode) {
        String[] proj = {"_id", "_display_name", "relative_path"};
        try (Cursor c = cr.query(base, proj, "relative_path LIKE ?", new String[]{MS_REL + "%"}, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String name = c.getString(1);
                String relDir = c.getString(2);
                if (name == null || relDir == null) continue;
                Role role = classify(name, mode);
                if (role == null || role.bucket == null) continue;
                String sub = relDir.startsWith(MS_REL) ? relDir.substring(MS_REL.length()) : relDir;
                sub = sub.replaceAll("/+$", "");
                Entry e = new Entry();
                e.name = name;
                e.uri = ContentUris.withAppendedId(base, c.getLong(0));
                Map<String, List<Entry>> m = byDir.computeIfAbsent(sub, k -> new LinkedHashMap<>());
                List<Entry> list = m.computeIfAbsent(role.bucket, k -> new ArrayList<>());
                boolean dup = false;
                for (Entry x : list) if (x.name.equals(name)) { dup = true; break; }
                if (!dup) list.add(e);
            }
        } catch (Exception e) {
            Log.w(TAG, "query ms: " + e.getMessage());
        }
    }

    /* ------------------------------------------------- SAF 模式 */

    private static void walkSaf(Context ctx, Uri tree, String relDir, int depth, JSONArray out, Root root, String mode) {
        if (depth > MAX_DEPTH || out.length() >= MAX_ITEMS) return;
        if (++dirCount > MAX_DIRS || System.currentTimeMillis() > deadline) return;
        Uri dirUri;
        if (relDir.isEmpty()) {
            dirUri = tree;
        } else {
            dirUri = DocumentsContract.buildDocumentUriUsingTree(tree, docIdOf(tree, relDir));
        }
        List<SafEntry> kids = listSaf(ctx, dirUri);
        Map<String, List<SafEntry>> byExt = new LinkedHashMap<>();
        List<SafEntry> subdirs = new ArrayList<>();
        for (SafEntry e : kids) {
            if (e.isDir) {
                String n = (e.name == null ? "" : e.name.toLowerCase(Locale.ROOT));
                if (SKIP_DIRS.contains(n)) continue;
                // 别的游戏的素材目录一律不 walk（depth 0 也跳）—— 见 APK-fixes §4
                if (UnpackCacheHome.isOtherGameFolder(e.name, UnpackCacheHome.folderOfMode(mode))) continue;
                if (JczxExtractor.isCacheDirName(e.name) && !MODE_JCZX.equals(mode)) continue;

                if (NikkeAbExtractor.isCacheDirName(e.name) && !MODE_NIKKE.equals(mode)) continue;
                subdirs.add(e);
            } else {
                Role r = classify(e.name, mode);
                if (r == null || r.bucket == null) continue;
                byExt.computeIfAbsent(r.bucket, k -> new ArrayList<>()).add(e);
            }
        }
        emitSaf(ctx, tree, relDir, byExt, out, root, mode);
        for (SafEntry d : subdirs) {
            walkSaf(ctx, tree, relDir.isEmpty() ? d.name : relDir + "/" + d.name, depth + 1, out, root, mode);
        }
    }

    private static void emitSaf(Context ctx, Uri tree, String relDir,
                                Map<String, List<SafEntry>> byExt, JSONArray out, Root root, String mode) {
        List<SafEntry> atlases = byExt.getOrDefault(K_ATLAS, new ArrayList<>());
        for (SafEntry atlas : atlases) {
            String base = classifyBaseOf(atlas.name);
            List<SafEntry> jsons = byExt.getOrDefault(K_JSON, new ArrayList<>());
            List<SafEntry> skels = byExt.getOrDefault(K_SKEL, new ArrayList<>());
            SafEntry skeleton = pickByBase(jsons, base, e -> e.name);
            String kind = K_JSON;
            if (skeleton == null) {
                skeleton = pickByBase(skels, base, e -> e.name);
                kind = K_SKEL;
            }
            if (skeleton == null) kind = null;
            List<SafEntry> thumbs = byExt.getOrDefault(K_THUMB, new ArrayList<>());
            SafEntry thumb = thumbs.isEmpty() ? null : thumbs.get(0);

            List<String> pages = parseAtlasPages(readTextSaf(ctx, atlas.docId, tree));
            List<SafEntry> imgs = new ArrayList<>();
            for (String e : IMG_EXT) imgs.addAll(byExt.getOrDefault(e, new ArrayList<>()));
            if (pages.isEmpty()) {
                for (SafEntry f : imgs) {
                    if (thumb != null && f.name.equals(thumb.name)) continue;
                    if (baseName(f.name).startsWith(base)) pages.add(f.name);
                }
                if (pages.isEmpty()) {
                    for (SafEntry f : imgs) {
                        if (thumb != null && f.name.equals(thumb.name)) continue;
                        pages.add(f.name);
                        break;
                    }
                }
            }
            List<SafEntry> images = new ArrayList<>();
            List<String> missing = new ArrayList<>();
            for (String p : pages) {
                SafEntry hit = null;
                for (SafEntry f : imgs) if (f.name.equals(p) || f.name.equals(new File(p).getName())) { hit = f; break; }
                if (hit != null) images.add(hit);
                else missing.add(p);
            }
            String relAtlas = join(relDir, atlas.name);
            try {
                JSONObject o = new JSONObject();
                o.put("id", relAtlas);
                o.put("dir", relDir.isEmpty() ? "/" : relDir);
                o.put("group", relAtlas.contains("/") ? relAtlas.split("/")[0] : "（根目录）");
                o.put("folder", folderOf(relDir, root.label));
                o.put("base", base);
                o.put("atlas", atlas.name);
                o.put("relAtlas", relAtlas);
                o.put("relSkeleton", skeleton == null ? null : join(relDir, skeleton.name));
                o.put("skeleton", skeleton == null ? null : skeleton.name);
                String spineMinor = spineMinorOfSafEntry(ctx, tree, skeleton, kind);
                o.put("skeletonKind", skeleton == null ? null : kindOfBucket(kind));
                if (spineMinor != null) o.put("spineMinor", spineMinor);
                else o.put("spineMinor", JSONObject.NULL);
                // 需求 5：SAF 的 mtime 常为 0（不可靠）—— 只有拿到正数 mtime 才做过期判定
                SafEntry freshThumb = thumb;
                if (freshThumb != null) {
                    long tm = mtimeOf(freshThumb);
                    long newest = mtimeOf(atlas);
                    if (skeleton != null) newest = Math.max(newest, mtimeOf(skeleton));
                    for (SafEntry f : images) newest = Math.max(newest, mtimeOf(f));
                    if (tm > 0 && tm < newest) freshThumb = null;
                }
                o.put("relThumb", freshThumb == null ? null : join(relDir, freshThumb.name));
                JSONArray im = new JSONArray();
                for (SafEntry f : images) im.put(f.name);
                JSONArray rim = new JSONArray();
                for (SafEntry f : images) rim.put(join(relDir, f.name));
                JSONArray mi = new JSONArray();
                for (String s : missing) mi.put(s);
                o.put("images", im);
                o.put("relImages", rim);
                o.put("missingImages", mi);
                o.put("ok", skeleton != null && !images.isEmpty() && missing.isEmpty());
                o.put("problems", problems(skeleton, images.isEmpty()));
                // 文件改动时间：前端用它决定缩略图缓存要不要失效
                o.put("mtime", mtimeOf(atlas));
                out.put(o);
                indexSaf(root, tree, atlas.docId, relAtlas);
                if (skeleton != null) indexSaf(root, tree, skeleton.docId, join(relDir, skeleton.name));
                if (thumb != null) indexSaf(root, tree, thumb.docId, join(relDir, thumb.name));
                for (SafEntry f : images) indexSaf(root, tree, f.docId, join(relDir, f.name));
            } catch (Exception e) {
                Log.w(TAG, "json: " + e.getMessage());
            }
        }
    }

    private static void indexSaf(Root root, Uri tree, String docId, String rel) {
        Doc d = new Doc();
        d.rel = rel;
        d.uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
        DOCS.put(root.id + "|" + rel, d);
    }

    /* pickSkeletonSaf 见上：已并入 pickByBase */

    /** SAF 目录列举。优先用 DocumentsContract 的 child documents 查询，更快也更稳。 */
    private static List<SafEntry> listSaf(Context ctx, Uri dirUri) {
        List<SafEntry> out = new ArrayList<>();
        ContentResolver cr = ctx.getContentResolver();
        String docId;
        try {
            docId = DocumentsContract.getDocumentId(dirUri);
        } catch (Exception e) {
            return out;
        }
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(dirUri, docId);
        String[] proj = {android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE};
        try (android.database.Cursor c = cr.query(children, proj, null, null, null)) {
            if (c != null) {
                while (c.moveToNext()) {
                    SafEntry e = new SafEntry();
                    e.docId = c.getString(0);
                    e.name = c.getString(1);
                    e.isDir = android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2));
                    out.add(e);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "list saf: " + e.getMessage());
        }
        return out;
    }

    private static String readTextSaf(Context ctx, String docId, Uri tree) {
        try (InputStream in = ctx.getContentResolver()
                .openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, docId))) {
            return readAll(in);
        } catch (Exception e) {
            return "";
        }
    }

    /* ------------------------------------------------------------ 通用 */

    private static final class SafEntry {
        String docId;
        String name;
        boolean isDir;
    }

    private static String docIdOf(Uri tree, String relDir) {
        // relDir 是相对路径，这里用 tree 的 docId 拼接（系统 Downloads/外部存储 provider 支持这种形式）
        try {
            String base = DocumentsContract.getTreeDocumentId(tree);
            return base + "/" + relDir;
        } catch (Exception e) {
            return relDir;
        }
    }

    private static String join(String dir, String name) {
        return dir == null || dir.isEmpty() ? name : dir + "/" + name;
    }

    private static String folderOf(String relDir, String fallback) {
        if (relDir == null || relDir.isEmpty()) return fallback;
        int i = relDir.lastIndexOf('/');
        return i >= 0 ? relDir.substring(i + 1) : relDir;
    }

    /**
     * problems 里只放**可翻译的简单键** —— 前端会逐条过 t()（R11）。
     * 「缺哪几张图」不放这里，改由前端的 missingImages 字段拼，
     * 这样原生侧不需要懂语言，也不会把「文案 + 变量」揉成一个翻不动的整串。
     * （与服务端 server.mjs 的 problems 保持同一套键。）
     */
    private static JSONArray problems(Object skeleton, boolean noImages) {
        JSONArray a = new JSONArray();
        if (skeleton == null) a.put("缺少骨架文件");
        if (noImages) a.put("缺少贴图 .png");
        return a;
    }

    static List<String> parseAtlasPages(String text) {
        List<String> pages = new ArrayList<>();
        if (text == null) return pages;
        for (String raw : text.split("\\r?\\n")) {
            String line = raw.trim();
            if (line.isEmpty() || line.contains(":") || line.contains(" ")) continue;
            String low = line.toLowerCase(Locale.ROOT);
            if (low.endsWith(".png") || low.endsWith(".jpg") || low.endsWith(".jpeg") || low.endsWith(".webp")) {
                if (!pages.contains(line)) pages.add(line);
            }
        }
        return pages;
    }

    private static String readAll(InputStream in) {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) > 0) sb.append(buf, 0, n);
        } catch (Exception ignored) {
        }
        return sb.toString();
    }

    private static String extOf(String name) {
        if (name == null) return "";
        int i = name.lastIndexOf('.');
        return i < 0 ? "" : name.substring(i).toLowerCase(Locale.ROOT);
    }

    static String baseName(String name) {
        if (name == null) return "";
        int i = name.lastIndexOf('.');
        return i < 0 ? name : name.substring(0, i);
    }

    /* ------------------------------------------------------------ 取文件 */

    public static Doc find(String rootId, String rel) {
        if (rootId == null || rel == null) return null;
        Doc d = DOCS.get(rootId + "|" + rel);
        if (d != null) return d;
        String alt = altJczxCacheRel(rel);
        if (alt != null) {
            d = DOCS.get(rootId + "|" + alt);
            if (d != null) return d;
        }
        String prefix = rootId + "|";
        String wantExactLower = (prefix + rel).toLowerCase(Locale.ROOT);
        String wantAltLower = alt != null ? (prefix + alt).toLowerCase(Locale.ROOT) : null;
        String wantSuffixLower = ("/" + rel).toLowerCase(Locale.ROOT);
        for (Map.Entry<String, Doc> e : DOCS.entrySet()) {
            String k = e.getKey();
            if (!k.regionMatches(true, 0, prefix, 0, prefix.length())) continue;
            String kl = k.toLowerCase(Locale.ROOT);
            if (kl.equals(wantExactLower) || (wantAltLower != null && kl.equals(wantAltLower)))
                return e.getValue();
            if (kl.endsWith(wantSuffixLower)) return e.getValue();
        }
        return null;
    }

    /** Swap bd2viewer-jczx ↔ .bd2viewer-jczx prefix; null if not a cache rel. */
    static String altJczxCacheRel(String rel) {
        if (rel == null) return null;
        String a = JczxExtractor.CACHE_DIRNAME;
        String b = JczxExtractor.CACHE_DIRNAME_LEGACY;
        if (rel.equals(a) || rel.startsWith(a + "/"))
            return b + rel.substring(a.length());
        if (rel.equals(b) || rel.startsWith(b + "/"))
            return a + rel.substring(b.length());
        return null;
    }

    /**
     * Desktop-style resolve: open root.path + rel when DOCS miss (case-insensitive leaf).
     * Keeps JCZX / large trees loadable even if index drifted.
     */
    public static Doc resolveFile(String rootId, String rel) {
        if (rootId == null || rel == null || rel.contains("..") || rel.startsWith("/")) return null;
        Root root = rootById(rootId);
        if (root == null || root.path == null) return null;
        try {
            File base = new File(root.path).getCanonicalFile();
            File f = new File(base, rel).getCanonicalFile();
            if (!f.getPath().equals(base.getPath())
                    && !f.getPath().startsWith(base.getPath() + File.separator)) {
                return null;
            }
            if (!f.isFile()) {
                // try alternate cache prefix
                String alt = altJczxCacheRel(rel);
                if (alt != null) {
                    f = new File(base, alt).getCanonicalFile();
                    if (!f.getPath().startsWith(base.getPath() + File.separator) || !f.isFile()) {
                        f = caseInsensitiveResolve(base, rel);
                    }
                } else {
                    f = caseInsensitiveResolve(base, rel);
                }
            }
            if (f == null || !f.isFile()) return null;
            Doc d = new Doc();
            d.rel = rel;
            d.file = f;
            // warm index for subsequent page requests
            DOCS.put(rootId + "|" + rel, d);
            return d;
        } catch (Exception e) {
            Log.w(TAG, "resolveFile: " + e.getMessage());
            return null;
        }
    }

    /**
     * Resolve a bare filename (or any rel) by suffix against DOCS, then by
     * scanning bd2viewer-jczx/* and bd2viewer-nikke/* /leaf on disk. Covers
     * bad rawDataURIs remaps that drop the cache prefix.
     */
    public static Doc resolveLeaf(String rootId, String rel) {
        if (rootId == null || rel == null || rel.isEmpty()) return null;
        String leaf = rel.replace('\\', '/');
        int slash = leaf.lastIndexOf('/');
        if (slash >= 0) leaf = leaf.substring(slash + 1);
        if (leaf.isEmpty()) return null;
        String prefix = rootId + "|";
        Doc hit = null;
        int hits = 0;
        for (Map.Entry<String, Doc> e : DOCS.entrySet()) {
            String k = e.getKey();
            if (!k.regionMatches(true, 0, prefix, 0, prefix.length())) continue;
            String name = k.substring(prefix.length());
            int ns = name.lastIndexOf('/');
            String base = ns >= 0 ? name.substring(ns + 1) : name;
            if (base.equalsIgnoreCase(leaf)) {
                hit = e.getValue();
                hits++;
                if (hits > 1) break;
            }
        }
        if (hits == 1) return hit;
        // Disk: root/bd2viewer-jczx|nikke/*/leaf (and legacy dot cache)
        Root root = rootById(rootId);
        if (root == null || root.path == null) return hits == 1 ? hit : null;
        File baseDir = new File(root.path);
        for (String cacheName : new String[]{
                JczxExtractor.CACHE_DIRNAME, JczxExtractor.CACHE_DIRNAME_LEGACY,
                NikkeAbExtractor.CACHE_DIRNAME, NikkeAbExtractor.CACHE_DIRNAME_LEGACY}) {
            File cacheRoot = new File(baseDir, cacheName);
            if (!cacheRoot.isDirectory()) continue;
            File[] kids = cacheRoot.listFiles();
            if (kids == null) continue;
            for (File sub : kids) {
                if (!sub.isDirectory()) continue;
                File f = new File(sub, leaf);
                if (!f.isFile()) {
                    File[] files = sub.listFiles();
                    f = null;
                    if (files != null) {
                        for (File cand : files) {
                            if (cand.isFile() && cand.getName().equalsIgnoreCase(leaf)) {
                                f = cand; break;
                            }
                        }
                    }
                }
                if (f != null && f.isFile()) {
                    Doc d = new Doc();
                    d.rel = cacheName + "/" + sub.getName() + "/" + f.getName();
                    d.file = f;
                    DOCS.put(rootId + "|" + d.rel, d);
                    return d;
                }
            }
        }
        return hits >= 1 ? hit : null;
    }

    /** Walk path segments with case-insensitive match (exFAT / sdcard). */
    private static File caseInsensitiveResolve(File base, String rel) {
        File cur = base;
        for (String seg : rel.replace('\\', '/').split("/")) {
            if (seg.isEmpty()) continue;
            File next = new File(cur, seg);
            if (next.exists()) { cur = next; continue; }
            File[] kids = cur.listFiles();
            if (kids == null) return null;
            File hit = null;
            for (File k : kids) {
                if (k.getName().equalsIgnoreCase(seg)) { hit = k; break; }
            }
            if (hit == null) return null;
            cur = hit;
        }
        return cur;
    }

    public static InputStream open(Context ctx, Doc d) {
        try {
            if (d.file != null) return new FileInputStream(d.file);
            if (d.uri != null) return ctx.getContentResolver().openInputStream(d.uri);
        } catch (Exception e) {
            Log.w(TAG, "open: " + e.getMessage());
        }
        return null;
    }
}
