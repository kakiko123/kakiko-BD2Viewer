package com.kkk.bd2viewer;

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
            "node_modules", ".git", ".svn", "__pycache__", "$recycle.bin", "cache", "code_cache"));
    private static final Set<String> IMG_EXT = new HashSet<>(Arrays.asList(".png", ".jpg", ".jpeg", ".webp"));

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

    /** MediaStore 里拿到的一个文件条目（没有「全部文件访问」时只能这么读） */
    public static final class Entry {
        public String name;
        public File file;   // file 模式
        public Uri uri;     // ms / saf 模式
    }

    /** App 专属外部目录：零权限、一定可读写 */
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

    /** 默认入口：优先外部存储根目录的 /sdcard/BD2Viewer，建不出来就退回 App 专属目录 */
    public static File primaryDir(Context ctx) {
        File p = publicDir();
        return p != null ? p : defaultDir(ctx);
    }

    /**
     * 导入文件：优先落进外部 /sdcard/BD2Viewer，写不了再落 App 专属目录。
     * rel 里带子目录也可以（xx/yy.atlas）。
     */
    public static boolean writeImport(Context ctx, String rel, byte[] bytes) {
        String safe = String.valueOf(rel).replace('\\', '/');
        while (safe.startsWith("/")) safe = safe.substring(1);
        if (safe.trim().isEmpty()) return false;
        File[] targets = new File[]{publicDir(), defaultDir(ctx)};
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

    /** 公共目录 /sdcard/BD2Viewer：只有真能写才启用，否则当它不存在 */
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

    /** 期望的公共目录路径（不管建没建成功），给 UI 显示用 */
    public static String publicDirPath() {
        return new File(Environment.getExternalStorageDirectory(), DIR_NAME).getAbsolutePath();
    }

    /** 给前端的目录/权限诊断信息 */
    public static JSONObject storageStatus(Context ctx) {
        JSONObject o = new JSONObject();
        File app = defaultDir(ctx);
        File p = publicDir();
        File primary = p != null ? p : app;
        boolean allFiles = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R
                || Environment.isExternalStorageManager();
        try {
            // 默认入口：外部 /sdcard/BD2Viewer 优先，拿不到才是 App 专属目录
            o.put("defaultDir", primary.getAbsolutePath());
            o.put("defaultExists", primary.isDirectory());
            o.put("defaultIsPublic", p != null);
            o.put("appDir", app.getAbsolutePath());
            o.put("publicPath", publicDirPath());
            o.put("publicOk", p != null);
            o.put("publicReason", publicProblem);
            o.put("allFilesAccess", allFiles);
            o.put("sdk", android.os.Build.VERSION.SDK_INT);
            o.put("rootCount", ROOTS.size());
        } catch (Exception ignored) {
        }
        return o;
    }

    /** 启动时建好目录并放一份说明，用户把文件拷进去就行 */
    public static void ensureDefaults(Context ctx) {
        // 外部存储根目录优先：能建就建，建不了的原因会显示在顶部状态条上
        File pub = publicDir();
        if (pub != null) {
            writeReadme(pub);
            scanPath(ctx, pub.getAbsolutePath());
        }
        // App 专属目录始终建一份，导入文件随时有地方放
        writeReadme(defaultDir(ctx));
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
        return "把 Spine 动图文件拷进这个文件夹，每个子文件夹放一套：\r\n"
                + "\r\n"
                + "    xxx.atlas\r\n"
                + "    xxx.json  或  xxx.skel\r\n"
                + "    xxx.png   贴图，可能一张也可能好几张\r\n"
                + "\r\n"
                + "拷完回到 App 点顶部「重新扫描」就能看到列表。\r\n"
                + "懒得用数据线的话，也可以直接点 App 里的「导入文件」。\r\n";
    }

    private static void refreshAutoRoots(Context ctx) {
        // 默认入口：外部存储的 /sdcard/BD2Viewer（文件管理器/数据线都进得去）
        File pub = publicDir();
        if (pub != null) putAuto(PUBLIC_ROOT_ID, "手机存储 /BD2Viewer", pub.getAbsolutePath(), "file");
        else dropAuto(PUBLIC_ROOT_ID);
        // 外部目录拿不到时的兜底
        putAuto(DEFAULT_ROOT_ID, "BD2Viewer（App 目录）", defaultDir(ctx).getAbsolutePath(), "file");
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
                r.label = label;
                r.kind = kind;
                r.path = path;
                r.exists = "ms".equals(kind) || new File(path).isDirectory();
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
     */
    public static JSONObject scan(Context ctx, String rootId, boolean force) {
        long t0 = System.currentTimeMillis();
        Root root = rootById(rootId);
        JSONArray items;
        synchronized (SCAN_LOCK) { items = CACHE.get(rootId); }

        if (force || items == null) {
            JSONArray fresh = new JSONArray();
            dirCount = 0;
            deadline = System.currentTimeMillis() + SCAN_BUDGET_MS;
            synchronized (SCAN_LOCK) {
                java.util.Iterator<String> it = DOCS.keySet().iterator();
                while (it.hasNext()) if (it.next().startsWith(rootId + "|")) it.remove();
            }
            if (root != null) {
                if ("ms".equals(root.kind)) {
                    walkMs(ctx, fresh, root);
                } else if ("file".equals(root.kind) && root.path != null) {
                    walkFile(new File(root.path), 0, fresh, root);
                } else if (root.treeUri != null) {
                    walkSaf(ctx, Uri.parse(root.treeUri), "", 0, fresh, root);
                }
            }
            synchronized (SCAN_LOCK) { CACHE.put(rootId, fresh); }
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
            out.put("itemCount", items.length());
            out.put("playableCount", playable);
            out.put("truncated", dirCount >= MAX_DIRS);
            out.put("scanMs", (int) (System.currentTimeMillis() - t0));
        } catch (Exception ignored) {
        }
        return out;
    }

    public static int scanCount(String rootId) {
        synchronized (SCAN_LOCK) {
            JSONArray a = CACHE.get(rootId);
            return a == null ? 0 : a.length();
        }
    }

    /** 分页取扫描结果：一次几十条，避免构造/传递超大 JSON 字符串 */
    public static String scanPage(String rootId, int from, int count) {
        JSONArray items;
        synchronized (SCAN_LOCK) { items = CACHE.get(rootId); }
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

    private static void walkFile(File dir, int depth, JSONArray out, Root root) {
        if (depth > MAX_DEPTH || out.length() >= MAX_ITEMS) return;
        if (++dirCount > MAX_DIRS || System.currentTimeMillis() > deadline) return;
        File[] list = dir.listFiles();
        if (list == null) return;
        Map<String, List<Entry>> byExt = new LinkedHashMap<>();
        List<File> subdirs = new ArrayList<>();
        for (File f : list) {
            if (f.isDirectory()) {
                String n = f.getName().toLowerCase(Locale.ROOT);
                if (!SKIP_DIRS.contains(n)) subdirs.add(f);
            } else if (f.isFile()) {
                Entry e = new Entry();
                e.name = f.getName();
                e.file = f;
                byExt.computeIfAbsent(extOf(f.getName()), k -> new ArrayList<>()).add(e);
            }
        }
        emitEntries(null, root, relDirOf(root, dir), byExt, out);
        for (File d : subdirs) walkFile(d, depth + 1, out, root);
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

    private static void emitEntries(Context ctx, Root root, String dirRel,
                                    Map<String, List<Entry>> byExt, JSONArray out) {
        if (dirRel == null) dirRel = "";
        if (out.length() >= MAX_ITEMS) return;
        List<Entry> atlases = byExt.getOrDefault(".atlas", new ArrayList<>());
        for (Entry atlas : atlases) {
            String base = baseName(atlas.name);
            List<Entry> jsons = byExt.getOrDefault(".json", new ArrayList<>());
            List<Entry> skels = byExt.getOrDefault(".skel", new ArrayList<>());
            Entry skeleton = pickSkeleton(base, jsons, skels);
            String kind = skeleton == null ? null
                    : skeleton.name.toLowerCase(Locale.ROOT).endsWith(".skel") ? "skel" : "json";

            List<String> pages = parseAtlasPages(readTextEntry(ctx, atlas));
            List<Entry> imgs = new ArrayList<>();
            for (String e : IMG_EXT) imgs.addAll(byExt.getOrDefault(e, new ArrayList<>()));
            if (pages.isEmpty()) {
                for (Entry f : imgs) if (baseName(f.name).startsWith(base)) pages.add(f.name);
                if (pages.isEmpty() && !imgs.isEmpty()) pages.add(imgs.get(0).name);
            }
            List<Entry> images = new ArrayList<>();
            List<String> missing = new ArrayList<>();
            for (String p : pages) {
                Entry hit = null;
                for (Entry f : imgs) if (f.name.equals(p) || f.name.equals(new File(p).getName())) { hit = f; break; }
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
                o.put("skeletonKind", kind);
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
                o.put("problems", problems(skeleton, images.isEmpty(), missing));
                // 文件改动时间：前端用它决定缩略图缓存要不要失效
                o.put("mtime", mtimeOf(atlas));
                out.put(o);
                indexEntry(root, atlas, relAtlas);
                if (skeleton != null) indexEntry(root, skeleton, relOf(dirRel, skeleton.name));
                for (Entry f : images) indexEntry(root, f, relOf(dirRel, f.name));
            } catch (Exception e) {
                Log.w(TAG, "json: " + e.getMessage());
            }
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
            // 扫描结果里还留着已删的条目 → 整个缓存作废，下次扫描重新走一遍
            if (deleted.length() > 0) {
                synchronized (SCAN_LOCK) { CACHE.remove(rootId); }
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

    private static Entry pickSkeleton(String base, List<Entry> jsons, List<Entry> skels) {
        for (Entry f : jsons) if (baseName(f.name).equals(base)) return f;
        for (Entry f : skels) if (baseName(f.name).equals(base)) return f;
        if (jsons.size() == 1) return jsons.get(0);
        if (skels.size() == 1) return skels.get(0);
        return null;
    }

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

    private static void walkMs(Context ctx, JSONArray out, Root root) {
        if (ctx == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        ContentResolver cr = ctx.getContentResolver();
        Map<String, Map<String, List<Entry>>> byDir = new LinkedHashMap<>();
        collectMs(cr, MediaStore.Files.getContentUri("external"), byDir);
        collectMs(cr, MediaStore.Downloads.EXTERNAL_CONTENT_URI, byDir);
        List<String> dirs = new ArrayList<>(byDir.keySet());
        dirs.sort(Comparator.comparingInt((String s) -> s.isEmpty() ? 0 : 1).thenComparing(s -> s));
        for (String d : dirs) {
            if (++dirCount > MAX_DIRS || System.currentTimeMillis() > deadline) break;
            emitEntries(ctx, root, d, byDir.get(d), out);
        }
        Log.i(TAG, "ms scan: " + byDir.size() + " 个目录 / " + out.length() + " 项");
    }

    private static void collectMs(ContentResolver cr, Uri base,
                                  Map<String, Map<String, List<Entry>>> byDir) {
        String[] proj = {"_id", "_display_name", "relative_path"};
        try (Cursor c = cr.query(base, proj, "relative_path LIKE ?", new String[]{MS_REL + "%"}, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String name = c.getString(1);
                String relDir = c.getString(2);
                if (name == null || relDir == null) continue;
                String sub = relDir.startsWith(MS_REL) ? relDir.substring(MS_REL.length()) : relDir;
                sub = sub.replaceAll("/+$", "");
                Entry e = new Entry();
                e.name = name;
                e.uri = ContentUris.withAppendedId(base, c.getLong(0));
                Map<String, List<Entry>> m = byDir.computeIfAbsent(sub, k -> new LinkedHashMap<>());
                List<Entry> list = m.computeIfAbsent(extOf(name), k -> new ArrayList<>());
                boolean dup = false;
                for (Entry x : list) if (x.name.equals(name)) { dup = true; break; }
                if (!dup) list.add(e);
            }
        } catch (Exception e) {
            Log.w(TAG, "query ms: " + e.getMessage());
        }
    }

    /* ------------------------------------------------- SAF 模式 */

    private static void walkSaf(Context ctx, Uri tree, String relDir, int depth, JSONArray out, Root root) {
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
                if (!SKIP_DIRS.contains(n)) subdirs.add(e);
            } else {
                byExt.computeIfAbsent(extOf(e.name), k -> new ArrayList<>()).add(e);
            }
        }
        emitSaf(ctx, tree, relDir, byExt, out, root);
        for (SafEntry d : subdirs) {
            walkSaf(ctx, tree, relDir.isEmpty() ? d.name : relDir + "/" + d.name, depth + 1, out, root);
        }
    }

    private static void emitSaf(Context ctx, Uri tree, String relDir,
                                Map<String, List<SafEntry>> byExt, JSONArray out, Root root) {
        List<SafEntry> atlases = byExt.getOrDefault(".atlas", new ArrayList<>());
        for (SafEntry atlas : atlases) {
            String base = baseName(atlas.name);
            List<SafEntry> jsons = byExt.getOrDefault(".json", new ArrayList<>());
            List<SafEntry> skels = byExt.getOrDefault(".skel", new ArrayList<>());
            SafEntry skeleton = pickSkeletonSaf(base, jsons, skels);
            String kind = null;
            if (skeleton != null) kind = skeleton.name.toLowerCase(Locale.ROOT).endsWith(".skel") ? "skel" : "json";

            List<String> pages = parseAtlasPages(readTextSaf(ctx, atlas.docId, tree));
            List<SafEntry> imgs = new ArrayList<>();
            for (String e : IMG_EXT) imgs.addAll(byExt.getOrDefault(e, new ArrayList<>()));
            if (pages.isEmpty()) {
                for (SafEntry f : imgs) if (baseName(f.name).startsWith(base)) pages.add(f.name);
                if (pages.isEmpty() && !imgs.isEmpty()) pages.add(imgs.get(0).name);
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
                o.put("skeletonKind", kind);
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
                o.put("problems", problems(skeleton, images.isEmpty(), missing));
                // 文件改动时间：前端用它决定缩略图缓存要不要失效
                o.put("mtime", mtimeOf(atlas));
                out.put(o);
                indexSaf(root, tree, atlas.docId, relAtlas);
                if (skeleton != null) indexSaf(root, tree, skeleton.docId, join(relDir, skeleton.name));
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

    private static SafEntry pickSkeletonSaf(String base, List<SafEntry> jsons, List<SafEntry> skels) {
        for (SafEntry f : jsons) if (baseName(f.name).equals(base)) return f;
        for (SafEntry f : skels) if (baseName(f.name).equals(base)) return f;
        if (jsons.size() == 1) return jsons.get(0);
        if (skels.size() == 1) return skels.get(0);
        return null;
    }

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

    private static JSONArray problems(Object skeleton, boolean noImages, List<String> missing) {
        JSONArray a = new JSONArray();
        if (skeleton == null) a.put("缺少 .json / .skel 骨架文件");
        if (noImages) a.put("缺少图集贴图 .png");
        if (!missing.isEmpty()) {
            StringBuilder sb = new StringBuilder("atlas 引用了不存在的图：");
            for (int i = 0; i < missing.size(); i++) {
                if (i > 0) sb.append(", ");
                sb.append(missing.get(i));
            }
            a.put(sb.toString());
        }
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
        if (rootId == null) return null;
        Doc d = DOCS.get(rootId + "|" + rel);
        if (d != null) return d;
        // 有些 atlas 里写的页名带目录前缀，做一次后缀匹配
        for (Map.Entry<String, Doc> e : DOCS.entrySet()) {
            if (e.getKey().startsWith(rootId + "|") && e.getKey().endsWith("/" + rel)) return e.getValue();
        }
        return null;
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
