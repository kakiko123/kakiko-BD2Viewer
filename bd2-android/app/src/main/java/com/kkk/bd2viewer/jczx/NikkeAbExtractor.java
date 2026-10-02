package com.kkk.bd2viewer.jczx;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * NIKKE（胜利女神）资产包 → 标准 Spine 三件套，**纯 Java、无 Python**（Android 端）。
 *
 * 包是标准 UnityFS AssetBundle（未加密、块压缩），无扩展名（例 `c010_00_aim_Seireiko_…`）。
 * 包里通常有：TextAsset `xxx.atlas`（文本）、TextAsset `xxx.skel`（二进制 Spine 4.1）、
 * Texture2D `xxx`（RGBA32，常另有 `xxx_mask` 等其它格式贴图）。
 *
 * 定位方式（不解析 SerializedFile 对象表，与 JCZX 同一套启发式，但换成更准的
 * 「名字 + 长度前缀」）：Unity 序列化字符串是 `[u32 LE 长度][字节][补齐到 4]`，
 * 因此只要在解压后的 CAB 数据里找到名字字节，就能顺着读出紧随其后的 `m_Script` /
 * `m_ImageData` 的准确长度与起始位置：
 *   · atlas / skel：`[u32 len][bytes]`
 *   · png：Texture2D 的 `m_ImageData` 是 `[u32 len = W*H*4][RGBA 像素]`（Unity 自下而上，
 *     需要垂直翻转 —— 与桌面 UnityPy 的产物一致）
 * 名字本身来自图集首行（`xxx.png` → 基名 xxx），不依赖包内命名小写/大小写差异。
 *
 * 为什么不用 JCZX 那套「只按尺寸找 RGBA 块」：NIKKE 的包里常同时有 mask 贴图，
 * 只按尺寸匹配会撞车；加上「名字 → 长度前缀」这一层后每种对象都能精确定位。
 *
 * 缓存（需求 6）：`<root>/bd2viewer-nikke/<packFolderName>/`（无前导点，WebView 才加载得了），
 * 每个包一个文件夹（名=包名），内含三件套 + `.stamp.json`（size+mtime+engine）。
 * 旧平铺缓存：layout version / 顶层松散文件检测到后整目录 wipe 重建。
 *
 * MIT（与仓库一致）；不依赖 UnityPy / AssetStudio。
 */
public final class NikkeAbExtractor {

    public static final String CACHE_DIRNAME = "bd2viewer-nikke";
    public static final String CACHE_DIRNAME_LEGACY = ".bd2viewer-nikke";
    /** 改动启发式就 +1，让旧缓存重解。 */
    public static final String EXTRACT_ENGINE = "android-nikke-ab-1.1";
    /** 缓存布局版本：2 = 每包一文件夹（与桌面 CACHE_LAYOUT_VERSION 对齐）。 */
    public static final int CACHE_LAYOUT_VERSION = 2;

    /** 包级并发上限（需求 1）：任意时刻同时在解的包 ≤ 10；与桌面端一致。 */
    public static final int MAX_CONCURRENT = 10;
    /** @deprecated 使用 {@link #MAX_CONCURRENT}；保留别名以免旧引用编译失败。 */
    @Deprecated
    public static final int MAX_PER_PASS = MAX_CONCURRENT;
    private static final int MAX_DEPTH = 5;
    private static final int PRI_HIGH = 1_000_000;
    private static final int PRI_NORMAL = 0;
    private static final AtomicInteger GLOBAL_SEQ = new AtomicInteger();
    private static final long MIN_BUNDLE_BYTES = 16 * 1024L;

    // 注意**不能**加 `^` 锚定行首：图集文本在 CAB 数据里紧跟在 m_Script 的长度前缀后面，
    // 前一个字节是长度值（不是换行），加了 ^ 会一条都匹配不到（实测踩过）。
    private static final Pattern ATLAS_HEAD = Pattern.compile(
            "([A-Za-z0-9_\\-. ]{1,120}\\.png)\\r?\\nsize:(\\d{1,5}),(\\d{1,5})\\r?\\n");

    private NikkeAbExtractor() {}

    public static boolean isCacheDirName(String name) {
        return CACHE_DIRNAME.equals(name) || CACHE_DIRNAME_LEGACY.equals(name);
    }

    public static boolean isCacheRel(String rel) {
        if (rel == null) return false;
        String r = rel.replace('\\', '/');
        return r.contains(CACHE_DIRNAME + "/") || r.startsWith(CACHE_DIRNAME)
                || r.contains(CACHE_DIRNAME_LEGACY + "/") || r.startsWith(CACHE_DIRNAME_LEGACY);
    }

    public static void migrateLegacyCache(File root) {
        if (root == null) return;
        File legacy = new File(root, CACHE_DIRNAME_LEGACY);
        File modern = new File(root, CACHE_DIRNAME);
        if (!legacy.isDirectory() || modern.exists()) return;
        if (!legacy.renameTo(modern)) {
            System.err.println("NikkeAb: legacy cache rename failed: " + legacy);
        }
    }

    /**
     * 包文件名 → 缓存子文件夹名（与桌面 packFolderOf 对齐）。
     * 去 .ab/.bundle 等扩展；替换非法路径字符。
     */
    public static String packFolderOf(String relOrName) {
        if (relOrName == null || relOrName.isEmpty()) return "pack";
        String base = relOrName.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) base = base.substring(slash + 1);
        String name = base.replaceAll("(?i)\\.(ab|bundle|unity3d|assets)$", "");
        if (name.isEmpty()) name = base;
        StringBuilder sb = new StringBuilder(name.length());
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c < 32 || "<>:\"/\\|?*".indexOf(c) >= 0) sb.append('_');
            else sb.append(c);
        }
        name = sb.toString();
        while (name.startsWith(".")) name = "_" + name.substring(1);
        return name.isEmpty() ? "pack" : name;
    }

    /** 旧平铺 / layout version 落后 → 整目录清空（与桌面 wipeFlatOrStaleCache 对齐）。 */
    public static boolean wipeFlatOrStaleCache(File root) {
        if (root == null) return false;
        File cacheRoot = new File(root, CACHE_DIRNAME);
        if (!cacheRoot.isDirectory()) return false;
        boolean wipe = false;
        String reason = null;
        int ver = detectLayoutVersion(cacheRoot);
        if (ver < CACHE_LAYOUT_VERSION) {
            wipe = true;
            reason = "layout v" + ver + " < " + CACHE_LAYOUT_VERSION;
        }
        if (!wipe) {
            File[] kids = cacheRoot.listFiles();
            if (kids != null) {
                for (File k : kids) {
                    if (!k.isFile() || k.getName().startsWith(".")) continue;
                    String n = k.getName().toLowerCase(Locale.ROOT);
                    if (n.endsWith(".atlas") || n.endsWith(".skel") || n.endsWith(".png") || n.endsWith(".json")) {
                        wipe = true;
                        reason = "flat file: " + k.getName();
                        break;
                    }
                }
            }
        }
        if (!wipe) {
            writeLayoutMarker(cacheRoot);
            return false;
        }
        deleteRec(cacheRoot);
        if (!cacheRoot.mkdirs()) {
            System.err.println("NikkeAb: cache wipe mkdir failed: " + cacheRoot);
            return true;
        }
        try {
            JSONObject j = new JSONObject();
            j.put("version", CACHE_LAYOUT_VERSION);
            j.put("wipedAt", java.time.Instant.now().toString());
            j.put("wipeReason", reason);
            writeText(new File(cacheRoot, ".layout.json"), j.toString(2));
        } catch (Exception e) {
            System.err.println("NikkeAb: layout write failed: " + e.getMessage());
        }
        System.err.println("NikkeAb: cache wipe (layout v" + CACHE_LAYOUT_VERSION + "): " + reason);
        return true;
    }

    /** 优先 .layout.json，其次 .manifest.json；仅有包文件夹无松散文件 → 视为已是 v2。 */
    private static int detectLayoutVersion(File cacheRoot) {
        File layout = new File(cacheRoot, ".layout.json");
        if (layout.isFile()) {
            try {
                return new JSONObject(readText(layout)).optInt("version", 0);
            } catch (Exception ignored) { /* */ }
        }
        File man = new File(cacheRoot, ".manifest.json");
        if (man.isFile()) {
            try {
                return new JSONObject(readText(man)).optInt("version", 0);
            } catch (Exception ignored) { /* */ }
        }
        File[] kids = cacheRoot.listFiles();
        if (kids == null) return 0;
        boolean hasDir = false;
        for (File k : kids) {
            if (k.getName().startsWith(".")) continue;
            if (k.isDirectory()) { hasDir = true; continue; }
            String n = k.getName().toLowerCase(Locale.ROOT);
            if (n.endsWith(".atlas") || n.endsWith(".skel") || n.endsWith(".png") || n.endsWith(".json")) {
                return 1; // flat
            }
        }
        return hasDir ? CACHE_LAYOUT_VERSION : 0;
    }

    private static void writeLayoutMarker(File cacheRoot) {
        try {
            File layout = new File(cacheRoot, ".layout.json");
            if (layout.isFile()) {
                try {
                    JSONObject j = new JSONObject(readText(layout));
                    if (j.optInt("version", 0) >= CACHE_LAYOUT_VERSION) return;
                } catch (Exception ignored) { /* rewrite */ }
            }
            JSONObject j = new JSONObject();
            j.put("version", CACHE_LAYOUT_VERSION);
            writeText(layout, j.toString(2));
        } catch (Exception ignored) { /* */ }
    }

    /** 源包消失 → 清掉对应包文件夹。 */
    private static void purgeOrphanPackFolders(File root, List<File> liveBundles) {
        File cacheRoot = new File(root, CACHE_DIRNAME);
        if (!cacheRoot.isDirectory()) return;
        Set<String> livePacks = new HashSet<>();
        for (File ab : liveBundles) livePacks.add(packFolderOf(ab.getName()));
        File[] kids = cacheRoot.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (!k.isDirectory()) continue;
            if (livePacks.contains(k.getName())) continue;
            File stamp = new File(k, ".stamp.json");
            boolean ours = stamp.isFile();
            if (!ours) {
                File[] inner = k.listFiles();
                if (inner != null) {
                    for (File f : inner) {
                        String n = f.getName().toLowerCase(Locale.ROOT);
                        if (n.endsWith(".atlas") || n.endsWith(".skel") || n.endsWith(".png")) {
                            ours = true; break;
                        }
                    }
                }
            }
            if (ours) deleteRec(k);
        }
    }

    /** 长得像 NIKKE 资产包的文件名：无扩展名 / .ab / .bundle / .unity3d。 */
    public static boolean isLikelyBundleName(String name) {
        if (name == null || name.isEmpty() || name.startsWith(".")) return false;
        String l = name.toLowerCase(Locale.ROOT);
        if (l.matches(".*\\.(atlas|json|skel|png|jpg|jpeg|webp|bytes|txt|md|log|bak)$")) return false;
        if (l.matches(".*\\.(ab|bundle|unity3d|assets)$")) return true;
        return name.lastIndexOf('.') < 0;
    }

    public static boolean fileLooksLikeUnityFs(File f) {
        if (f == null || !f.isFile() || f.length() < MIN_BUNDLE_BYTES) return false;
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] head = new byte[8];
            int n = in.read(head);
            return n == 8 && UnityFs.looksLikeUnityFs(head);
        } catch (Exception e) {
            return false;
        }
    }

    /* -------- 需求 1：每 root 一份优先级队列 + 包级并发 ≤ MAX_CONCURRENT -------- */
    private static final class QItem {
        final File ab;
        final String rel;
        int priority;
        final int seq;
        QItem(File ab, String rel, int priority) {
            this.ab = ab; this.rel = rel; this.priority = priority;
            this.seq = GLOBAL_SEQ.incrementAndGet();
        }
    }
    private static final class RootQueue {
        final File root;
        final Object lock = new Object();
        final List<QItem> queue = new ArrayList<>();
        final Map<String, QItem> known = new HashMap<>();
        final Set<String> inFlight = new HashSet<>();
        int found, reused, extracted, failed, skipped, ungated;
        final JSONArray errors = new JSONArray();
        boolean workerStarted;
        long lastFullPrepareAt;
        RootQueue(File root) { this.root = root; }
    }
    private static final Map<String, RootQueue> ROOT_QUEUES = new HashMap<>();
    private static final ExecutorService NIKKE_POOL =
            Executors.newFixedThreadPool(MAX_CONCURRENT, r -> {
                Thread t = new Thread(r, "nikke-ab-unpack");
                t.setDaemon(true);
                return t;
            });

    private static RootQueue queueFor(File root) {
        String key = root.getAbsolutePath();
        synchronized (ROOT_QUEUES) {
            RootQueue q = ROOT_QUEUES.get(key);
            if (q == null) {
                q = new RootQueue(root);
                ROOT_QUEUES.put(key, q);
            }
            return q;
        }
    }

    /** 同角色键：`c010_00_aim_…` → `c010`（与桌面 nikkeSiblingKey 对齐）。 */
    public static String siblingKey(String relOrName) {
        if (relOrName == null) return "";
        String base = relOrName;
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.substring(slash + 1);
        Matcher m = Pattern.compile("^(c\\d+)", Pattern.CASE_INSENSITIVE).matcher(base);
        if (m.find()) return m.group(1).toLowerCase(Locale.ROOT);
        m = Pattern.compile("^(.+?)_(?:standing|aim|cover)(?:_|$)", Pattern.CASE_INSENSITIVE).matcher(base);
        if (m.find()) return m.group(1).toLowerCase(Locale.ROOT);
        m = Pattern.compile("^(.+?)_\\d+(?:_|$)").matcher(base);
        if (m.find()) return m.group(1).toLowerCase(Locale.ROOT);
        return base.toLowerCase(Locale.ROOT);
    }

    private static String relOf(File root, File ab) {
        String rp = root.getAbsolutePath();
        String ap = ab.getAbsolutePath();
        if (ap.startsWith(rp)) {
            String r = ap.substring(rp.length());
            if (r.startsWith("/") || r.startsWith("\\")) r = r.substring(1);
            return r.replace('\\', '/');
        }
        return ab.getName();
    }

    private static void enqueue(RootQueue rq, File ab, int priority) {
        String rel = relOf(rq.root, ab);
        synchronized (rq.lock) {
            if (rq.inFlight.contains(rel)) {
                QItem existing = rq.known.get(rel);
                if (existing != null && priority > existing.priority) existing.priority = priority;
                return; // 不打断正在解的包
            }
            for (QItem q : rq.queue) {
                if (q.rel.equals(rel)) {
                    if (priority > q.priority) q.priority = priority;
                    rq.queue.sort(QUEUE_CMP);
                    return;
                }
            }
            QItem it = new QItem(ab, rel, priority);
            rq.known.put(rel, it);
            rq.queue.add(it);
            rq.queue.sort(QUEUE_CMP);
        }
    }

    private static final Comparator<QItem> QUEUE_CMP =
            (a, b) -> b.priority != a.priority ? Integer.compare(b.priority, a.priority)
                    : Integer.compare(a.seq, b.seq);

    /** 抬高指定包及同角色姿势兄弟（不打断 in-flight）。 */
    public static JSONObject prioritize(File root, List<String> rels, boolean sibling) {
        RootQueue rq = queueFor(root);
        Set<String> want = new HashSet<>();
        if (rels != null) for (String r : rels) if (r != null) want.add(r.replace('\\', '/'));
        if (sibling && !want.isEmpty()) {
            Set<String> keys = new HashSet<>();
            for (String r : want) keys.add(siblingKey(r));
            synchronized (rq.lock) {
                for (String rel : rq.known.keySet()) {
                    if (keys.contains(siblingKey(rel))) want.add(rel);
                }
            }
        }
        int bumped = 0;
        for (String rel : want) {
            File ab;
            synchronized (rq.lock) {
                QItem it = rq.known.get(rel);
                if (rq.inFlight.contains(rel)) { bumped++; continue; }
                ab = (it != null) ? it.ab : new File(root, rel);
            }
            if (ab != null && ab.isFile()) {
                enqueue(rq, ab, PRI_HIGH + GLOBAL_SEQ.incrementAndGet());
                bumped++;
            }
        }
        pump(rq);
        JSONObject out = progressOf(rq);
        try { out.put("bumped", bumped); } catch (Exception ignored) { /* */ }
        return out;
    }

    public static JSONObject progressOf(File root) {
        return progressOf(queueFor(root));
    }

    private static JSONObject progressOf(RootQueue rq) {
        JSONObject meta = new JSONObject();
        try {
            List<String> current = new ArrayList<>();
            List<String> pendingRels = new ArrayList<>();
            int pending, inFlight;
            synchronized (rq.lock) {
                pending = rq.queue.size();
                inFlight = rq.inFlight.size();
                List<String> currentRels = new ArrayList<>();
                for (String r : rq.inFlight) {
                    current.add(baseName(r));
                    currentRels.add(r);
                }
                for (QItem q : rq.queue) pendingRels.add(q.rel);
                // in-flight 也进 pendingRels，前端占位卡才能盖住「正在解」的包
                for (String r : rq.inFlight) {
                    if (!pendingRels.contains(r)) pendingRels.add(r);
                }
                int done = rq.reused + rq.extracted + rq.failed + rq.skipped;
                int playableDone = rq.reused + rq.extracted;
                int total = Math.max(rq.found, done + pending + inFlight);
                meta.put("found", rq.found);
                meta.put("reused", rq.reused);
                meta.put("extracted", rq.extracted);
                meta.put("failed", rq.failed);
                meta.put("skippedNoSpine", rq.skipped);
                meta.put("ungated", rq.ungated);
                meta.put("pending", pending);
                meta.put("inFlight", inFlight);
                meta.put("done", done);
                meta.put("playableDone", playableDone);
                meta.put("total", total);
                meta.put("ready", pending == 0 && inFlight == 0);
                meta.put("cacheDir", CACHE_DIRNAME);
                meta.put("limit", MAX_CONCURRENT);
                meta.put("errors", rq.errors);
                meta.put("ok", rq.errors.length() == 0);
                JSONArray cur = new JSONArray();
                for (String c : current) cur.put(c);
                meta.put("current", cur);
                JSONArray pr = new JSONArray();
                for (String r : pendingRels) pr.put(r);
                meta.put("pendingRels", pr);
                JSONArray cr = new JSONArray();
                for (String r : currentRels) cr.put(r);
                meta.put("currentRels", cr);
            }
        } catch (Exception ignored) { /* */ }
        return meta;
    }

    private static String baseName(String rel) {
        if (rel == null) return "";
        int i = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
        return i >= 0 ? rel.substring(i + 1) : rel;
    }

    private static void pump(RootQueue rq) {
        synchronized (rq.lock) {
            while (rq.inFlight.size() < MAX_CONCURRENT && !rq.queue.isEmpty()) {
                QItem job = rq.queue.remove(0);
                if (rq.inFlight.contains(job.rel)) continue;
                rq.inFlight.add(job.rel);
                final QItem j = job;
                NIKKE_POOL.execute(() -> {
                    try {
                        runOne(rq, j);
                    } finally {
                        synchronized (rq.lock) { rq.inFlight.remove(j.rel); }
                        pump(rq);
                    }
                });
            }
        }
    }

    private static void runOne(RootQueue rq, QItem job) {
        try {
            JSONObject rep = extractCached(job.ab, rq.root);
            synchronized (rq.lock) {
                if (rep.optBoolean("ok", false)) {
                    rq.extracted++;
                    JSONArray ex = rep.optJSONArray("exported");
                    for (int i = 0; ex != null && i < ex.length(); i++) {
                        JSONObject o = ex.optJSONObject(i);
                        if (o != null && o.has("gated") && !o.optBoolean("gated", true)) {
                            rq.ungated++;
                            break;
                        }
                    }
                } else if (rep.optBoolean("noSpine", false)) {
                    rq.skipped++;
                } else {
                    rq.failed++;
                    if (rq.errors.length() < 6) {
                        try {
                            rq.errors.put(new JSONObject()
                                    .put("src", job.ab.getAbsolutePath())
                                    .put("error", rep.optString("error", "incomplete")));
                        } catch (Exception ignored) { /* */ }
                    }
                }
            }
        } catch (Exception e) {
            synchronized (rq.lock) {
                rq.failed++;
                if (rq.errors.length() < 6) {
                    try {
                        rq.errors.put(new JSONObject()
                                .put("src", job.ab.getAbsolutePath())
                                .put("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage()));
                    } catch (Exception ignored) { /* */ }
                }
            }
        }
    }

    /**
     * 扫描前把根目录下的 NIKKE 包排进优先级队列并开始解包（并发 ≤ 10）。
     * 永不抛出：失败原因写进 meta.errors，扫描照常进行。
     * <p>
     * <b>不</b>同步等待首波解包：已就绪的 {@code bd2viewer-nikke/} 与手动目录
     * 必须立刻进入 walk/列表；待解包仅入队后台续解，前端用占位卡 + 进度条 overlay。
     * 否则 gallery 会空等最多 ~12s（旧「首波等待」），用户投诉卡在解包/扫描。
     */
    public static JSONObject prepareRoot(File root) {
        JSONObject meta = new JSONObject();
        try {
            RootQueue rq = queueFor(root);
            // 轮询 force-scan 反复 prepare：队列忙且 20s 内刚全量扫过 → 只回进度
            synchronized (rq.lock) {
                boolean busy = !rq.queue.isEmpty() || !rq.inFlight.isEmpty();
                if (busy && rq.found > 0 && rq.lastFullPrepareAt > 0
                        && (System.currentTimeMillis() - rq.lastFullPrepareAt) < 20000L) {
                    return progressOf(rq);
                }
            }
            migrateLegacyCache(root);
            wipeFlatOrStaleCache(root);
            List<File> bundles = new ArrayList<>();
            findBundles(root, 0, bundles);
            purgeOrphanPackFolders(root, bundles);
            writeLayoutMarker(new File(root, CACHE_DIRNAME));
            synchronized (rq.lock) {
                // 新一轮 full prepare：清计数（保留 in-flight / 已排队）
                rq.extracted = 0;
                rq.failed = 0;
                rq.skipped = 0;
                rq.ungated = 0;
                while (rq.errors.length() > 0) rq.errors.remove(0);
                rq.reused = 0;
                rq.found = bundles.size();
            }
            int reused = 0;
            List<File> todo = new ArrayList<>();
            for (File ab : bundles) {
                try {
                    if (isUpToDate(ab, root)) { reused++; continue; }
                } catch (Exception ignored) { /* 当作需要重解 */ }
                todo.add(ab);
            }
            synchronized (rq.lock) { rq.reused = reused; }
            for (File ab : todo) enqueue(rq, ab, PRI_NORMAL);
            pump(rq);
            synchronized (rq.lock) { rq.lastFullPrepareAt = System.currentTimeMillis(); }
            // 立即返回：scan 马上 walk 已就绪缓存；pending 由 progress 轮询 + 占位卡承接
            meta = progressOf(rq);
        } catch (Throwable e) {
            try {
                meta.put("found", meta.optInt("found", 0));
                meta.put("pending", 0);
                meta.put("ready", false);
                meta.put("ok", false);
                JSONArray errors = new JSONArray();
                errors.put(new JSONObject()
                        .put("src", JSONObject.NULL)
                        .put("error", String.valueOf(e.getMessage())));
                meta.put("errors", errors);
            } catch (Exception ignored) { /* */ }
        }
        return meta;
    }

    /** 单个包（拖入 / 上传）：解到缓存并返回 report。 */
    public static JSONObject extractCached(File ab, File root) throws Exception {
        File outDir = cacheDirFor(root, ab);
        File stamp = new File(outDir, ".stamp.json");
        long size = ab.length();
        long mtime = ab.lastModified();
        if (stamp.isFile()) {
            try {
                JSONObject st = new JSONObject(readText(stamp));
                if (st.optBoolean("ok", false) && st.optLong("size") == size
                        && st.optLong("mtimeMs") == mtime
                        && EXTRACT_ENGINE.equals(st.optString("engine", ""))
                        && outputsValid(outDir)) {
                    JSONObject rep = st.optJSONObject("report");
                    if (rep != null) { rep.put("reused", true); return rep; }
                }
            } catch (Exception ignored) { /* 重解 */ }
        }
        if (!outDir.isDirectory() && !outDir.mkdirs()) throw new IOException("mkdir cache failed: " + outDir);
        File[] kids = outDir.listFiles();
        if (kids != null) {
            for (File k : kids) {
                if (".stamp.json".equals(k.getName())) continue;
                deleteRec(k);
            }
        }
        JSONObject report = toJson(extract(ab, outDir), ab);
        // burst / 无 spine / 不完整：不留空（或半成品）包文件夹
        if (!report.optBoolean("ok", false)) {
            deleteRec(outDir);
            return report;
        }
        JSONObject stampObj = new JSONObject();
        stampObj.put("ok", true);
        stampObj.put("size", size);
        stampObj.put("mtimeMs", mtime);
        stampObj.put("src", ab.getAbsolutePath());
        stampObj.put("report", report);
        stampObj.put("engine", EXTRACT_ENGINE);
        stampObj.put("packFolder", packFolderOf(ab.getName()));
        stampObj.put("extractedAt", java.time.Instant.now().toString());
        try { writeText(stamp, stampObj.toString()); } catch (Exception ignored) { /* */ }
        // layout marker 只在 prepareRoot 写一次，避免每包刷盘
        return report;
    }

    /** 提取产物条目（纯 Java 结构，方便 CLI / 单测；JSON 只在 API 边界组装）。 */
    public static final class Item {
        public String kind;      // atlas | skel | json | png
        public String name;
        public long size;
        public String wh;
        public String spine;
        public long at = -1;   // 排障用：像素数据在 CAB 里的偏移
        public boolean gated = true;  // 贴图定位是否过了验收闸门（false = 启发式兜底，可能不准）
    }

    /** 提取结果（不含 JSON，便于在桌面 JVM 上直接验证核心逻辑）。 */
    public static final class Out {
        public boolean ok;
        public boolean noSpine;     // 包里没有 atlas → 不是 spine 资产（burst/特效包），不算失败
        public String error;
        public final List<Item> items = new ArrayList<>();
        public final List<String> errors = new ArrayList<>();
    }

    /** 三件套提取本体（纯 Java，不碰 org.json）。 */
    public static Out extract(File src, File outDir) {
        Out out = new Out();
        try {
            byte[] raw = readAll(src);
            byte[] stripped = UnityFs.stripToSecondUnityFs(raw);
            raw = null;
            Map<String, byte[]> nodes = UnityFs.readNodes(stripped);
            stripped = null;
            // CAB 节点（非 .resS）就是 SerializedFile；优先用**对象表**精确定位，
            // 拿不到（旧版/异常）再退回「名字 + 长度前缀」的启发式。
            byte[] cab = null;
            for (Map.Entry<String, byte[]> e : nodes.entrySet()) {
                if (!e.getKey().endsWith(".resS")) { cab = e.getValue(); break; }
            }
            if (cab == null) throw new IOException("no CAB node in bundle");
            byte[] blob = joinNodes(nodes);
            nodes = null;

            // --- 图集：文本，首行是贴图页名；顺带拿到 W/H ---
            byte[] atlasBytes = null;
            String base = null;
            int texW = 0, texH = 0;
            // 在数据里找「xxx.png + size:W,H」
            if (atlasBytes == null) {
                Matcher m = ATLAS_HEAD.matcher(new String(blob, StandardCharsets.ISO_8859_1));
                if (m.find()) {
                    String page = m.group(1);
                    base = page.toLowerCase(Locale.ROOT).endsWith(".png")
                            ? page.substring(0, page.length() - 4) : page;
                    atlasBytes = readSerializedBytes(blob, base + ".atlas");
                    if (atlasBytes == null) atlasBytes = printableRunAround(blob, m.start());
                }
            }
            if (atlasBytes != null) {
                Matcher m = ATLAS_HEAD.matcher(new String(atlasBytes, StandardCharsets.ISO_8859_1));
                if (m.find()) {
                    texW = parseIntSafe(m.group(2));
                    texH = parseIntSafe(m.group(3));
                }
            }
            if (atlasBytes != null && base != null) {
                Item it = new Item();
                it.kind = "atlas";
                it.name = base + ".atlas";
                it.size = atlasBytes.length;
                it.wh = texW + "x" + texH;
                writeBytes(new File(outDir, it.name), atlasBytes);
                out.items.add(it);
            } else {
                out.noSpine = true;
                out.errors.add("no atlas in bundle");
            }

            // --- 骨架：NIKKE 是二进制 .skel（少数可能是 .json） ---
            if (base != null) {
                byte[] skel = readSerializedBytes(blob, base + ".skel");
                if (skel != null) {
                    Item it = new Item();
                    it.kind = "skel";
                    it.name = base + ".skel";
                    it.size = skel.length;
                    it.spine = spineVersionOf(skel);
                    writeBytes(new File(outDir, it.name), skel);
                    out.items.add(it);
                } else {
                    byte[] js = readSerializedBytes(blob, base + ".json");
                    if (js != null && looksLikeJsonSkeleton(js)) {
                        Item it = new Item();
                        it.kind = "json";
                        it.name = base + ".json";
                        it.size = js.length;
                        writeBytes(new File(outDir, it.name), js);
                        out.items.add(it);
                    } else {
                        out.errors.add("no .skel TextAsset");
                    }
                }
            }

            // --- 贴图：按「[u32 LE = W*H*4][像素]」精确定位，翻转成自上而下 ---
            if (base != null && texW > 0 && texH > 0) {
                long needL = (long) texW * texH * 4L;
                if (needL > 96L * 1024 * 1024) {
                    out.errors.add("texture too large: " + needL);
                } else if (needL > 0) {
                    int need = (int) needL;
                    int at = findTextureData(blob, base, need);
                    if (at < 0) out.errors.add("RGBA blob " + need + " not found");
                    else {
                        byte[] rgba = new byte[need];
                        System.arraycopy(blob, at, rgba, 0, need);
                        flipVerticalInPlace(rgba, texW, texH);
                        File png = new File(outDir, base + ".png");
                        try (FileOutputStream fos = new FileOutputStream(png)) {
                            PngEncoder.writeRGBA(fos, rgba, texW, texH);
                        }
                        Item it = new Item();
                        it.kind = "png";
                        it.name = png.getName();
                        it.size = png.length();
                        it.wh = texW + "x" + texH;
                        it.at = at;
                        it.gated = lastTextureGated;
                        out.items.add(it);
                    }
                }
            } else if (base != null) {
                out.errors.add("no atlas size for texture");
            }

            boolean atlasOk = false, skelOk = false, pngOk = false;
            for (Item it : out.items) {
                if ("atlas".equals(it.kind)) atlasOk = true;
                else if ("skel".equals(it.kind) || "json".equals(it.kind)) skelOk = true;
                else if ("png".equals(it.kind)) pngOk = true;
            }
            out.ok = atlasOk && skelOk && pngOk;
            if (!out.ok && !out.errors.isEmpty()) out.error = out.errors.get(0);
        } catch (Throwable e) {
            out.ok = false;
            out.error = e.getClass().getSimpleName() + ": " + e.getMessage();
            out.errors.add(out.error);
        }
        return out;
    }

    private static JSONObject toJson(Out out, File src) {
        JSONObject rep = new JSONObject();
        try {
            rep.put("src", src.getAbsolutePath());
            rep.put("ok", out.ok);
            rep.put("noSpine", out.noSpine);
            if (out.error != null) rep.put("error", out.error);
            JSONArray exported = new JSONArray();
            for (Item it : out.items) {
                JSONObject o = new JSONObject();
                o.put("kind", it.kind);
                o.put("name", it.name);
                o.put("size", it.size);
                if (!it.gated) o.put("gated", false);
                if (it.wh != null) o.put("wh", it.wh);
                if (it.spine != null) o.put("spine", it.spine);
                exported.put(o);
            }
            rep.put("exported", exported);
            JSONArray errs = new JSONArray();
            for (String e : out.errors) errs.put(new JSONObject().put("err", e));
            rep.put("errors", errs);
        } catch (Exception ignored) { /* */ }
        return rep;
    }

    /* ------------------------------------------------------------------ 工具 */

    /** 把所有 CAB 节点拼成一整块（对象数据在节点内是连续的）。 */
    private static byte[] joinNodes(Map<String, byte[]> nodes) {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(1 << 20);
        for (Map.Entry<String, byte[]> e : nodes.entrySet()) bos.write(e.getValue(), 0, e.getValue().length);
        return bos.toByteArray();
    }

    /** 顺着「名字字节」读 Unity 序列化的字节数组字段：
     * 布局是 `[u32 LE 名字长度][名字][补齐4] [u32 LE 数据长度][数据]`。
     * 找不到名字或长度不合理就返回 null。
     */
    private static byte[] readSerializedBytes(byte[] blob, String name) {
        byte[] nb = name.getBytes(StandardCharsets.UTF_8);
        int from = 0;
        while (true) {
            int p = indexOf(blob, nb, from);
            if (p < 0) return null;
            from = p + 1;
            if (p < 4) continue;
            // 名字长度前缀（u32 LE）应当等于 nb.length
            if (readU32LE(blob, p - 4) != nb.length) continue;
            int aligned = (p + nb.length + 3) & ~3;
            if (aligned + 4 > blob.length) continue;
            long len = readU32LE(blob, aligned);
            if (len <= 0 || len > blob.length) continue;
            int start = aligned + 4;
            if (start + len > blob.length) continue;
            byte[] out = new byte[(int) len];
            System.arraycopy(blob, start, out, 0, (int) len);
            return out;
        }
    }

    /**
     * 定位 Texture2D 的 `m_ImageData`（`[u32 LE == need][像素]`）。
     *
     * 只说结论（都是实测踩出来的）：**在 Texture2D 对象名后面取「最后一个」候选**。
     *  - 对象头里先出现 `m_CompleteImageSize`（值同样是 need！），再出现 `m_ImageData` 的长度前缀，
     *    两者都是 4 对齐、都满足「后面还有 need 字节」—— 取第一个会切到字段中间（图尺寸对、像素错）。
     *  - 对象头只有 96~104 字节，所以窗口取 1024 字节足够；再放大到图像数据里就有撞车风险。
     *  - 图集基名同时是 Texture2D 的名字；用「名字 + u32 LE 名前缀」把它与 `xxx.atlas` 区分开。
     *  - 找不到对象名时才退回「全表搜 + 要求 4 对齐」的兜底。
     */
    /** 最近一次 findTextureData 是否「过了验收闸门」（false = 走的兜底，可能不准）。 */
    public static boolean lastTextureGated = false;

    private static int findTextureData(byte[] blob, String base, int need) {
        lastTextureGated = false;
        byte[] pat = new byte[]{
                (byte) (need & 0xFF), (byte) ((need >>> 8) & 0xFF),
                (byte) ((need >>> 16) & 0xFF), (byte) ((need >>> 24) & 0xFF),
        };
        byte[] nb = base.getBytes(StandardCharsets.UTF_8);
        int from = 0;
        while (true) {
            int namePos = indexOf(blob, nb, from);
            if (namePos < 0) break;
            from = namePos + 1;
            if (namePos < 4 || readU32LE(blob, namePos - 4) != nb.length) continue;  // 不是对象名
            for (int window : new int[]{256, 1024, 4096}) {
                int limit = Math.min(blob.length - 4, namePos + window);
                int fallback = -1;
                // 从后往前：m_ImageData 是对象最后一个字段（取最后一个候选），
                // 但优先要「过闸门」（数据末尾紧接着对象结束）的那个。
                for (int p = limit; p >= namePos; p--) {
                    if ((p & 3) != 0) continue;
                    if (blob[p] != pat[0] || blob[p + 1] != pat[1]
                            || blob[p + 2] != pat[2] || blob[p + 3] != pat[3]) continue;
                    int start = p + 4;
                    if (start + need > blob.length) continue;
                    if (fallback < 0) fallback = start;
                    if (objectBoundaryAfter(blob, start + need)) {
                        lastTextureGated = true;
                        return start;
                    }
                }
                if (fallback >= 0) return fallback;      // 都不合格：用最后一个，标记未过闸门
            }
        }
        return -1;
    }

    /**
     * 验收闸门：`m_ImageData` 是对象的最后一个字段，所以数据后面**紧接着就是对象结束**。
     * 判据二选一：
     *  ① 数据末尾之后 512 字节内出现「下一个对象的头部」（u32 LE 名字长度 + 可打印名字）；
     *  ② 数据末尾正好顶到节点末尾（±16 字节）—— 贴图是最后一个对象时就是这种情况。
     *
     * 为什么需要：CAB 头部与图像内部都可能出现与尺寸相同的 4 字节，命中了就会切出一张
     * 「尺寸对、像素错」的图（实测 c022 这种贴满整张图的图集就会撞）。**宁可报错也不写错图** ——
     * 写错图用户看不出来，报错至少知道要去 PC 端解包。
     */
    private static boolean objectBoundaryAfter(byte[] blob, int at) {
        if (at >= blob.length - 16) return true;                       // ② 顶到节点末尾
        int limit = Math.min(blob.length - 8, at + 512);
        for (int p = at; p <= limit; p += 4) {
            int len = readU32LE(blob, p);
            if (len < 1 || len > 256) continue;
            int q = p + 4;
            if (q + len > blob.length) continue;
            boolean printable = true;
            for (int i = 0; i < len; i++) {
                int c = blob[q + i] & 0xFF;
                if (c < 0x20 || c > 0x7e) { printable = false; break; }
            }
            if (printable) return true;                                // ① 后面有对象头
        }
        return false;
    }

    /** 从某个位置向前后各取一段连续可打印字符（图集兜底定位）。 */
    private static byte[] printableRunAround(byte[] blob, int at) {
        int start = at;
        while (start > 0 && isPrintable(blob[start - 1])) start--;
        int end = at;
        while (end < blob.length && isPrintable(blob[end])) end++;
        byte[] out = new byte[end - start];
        System.arraycopy(blob, start, out, 0, out.length);
        return out;
    }

    private static boolean isPrintable(byte b) {
        int v = b & 0xFF;
        return v == 9 || v == 10 || v == 13 || (v >= 32 && v < 127);
    }

    /** 二进制骨架的版本串在下标 9 起（[0..7] hash、[8] 变长长度前缀）。 */
    private static String spineVersionOf(byte[] skel) {
        if (skel == null || skel.length < 16) return null;
        int i = 9;
        int end = Math.min(skel.length, 24);
        StringBuilder sb = new StringBuilder();
        while (i < end) {
            char c = (char) (skel[i] & 0xFF);
            if (c == 0) break;
            if (!(Character.isDigit(c) || c == '.')) break;
            sb.append(c);
            i++;
        }
        String s = sb.toString();
        return s.matches("\\d+\\.\\d+\\.\\d+") ? s : null;
    }

    private static boolean looksLikeJsonSkeleton(byte[] b) {
        if (b == null || b.length < 16) return false;
        String head = new String(b, 0, Math.min(b.length, 200), StandardCharsets.UTF_8);
        return head.indexOf("\"skeleton\"") >= 0 || head.indexOf("\"bones\"") >= 0;
    }

    private static void flipVerticalInPlace(byte[] rgba, int w, int h) {
        int stride = w * 4;
        byte[] row = new byte[stride];
        for (int y = 0; y < h / 2; y++) {
            int a = y * stride;
            int b = (h - 1 - y) * stride;
            System.arraycopy(rgba, a, row, 0, stride);
            System.arraycopy(rgba, b, rgba, a, stride);
            System.arraycopy(row, 0, rgba, b, stride);
        }
    }

    private static File cacheDirFor(File root, File ab) {
        // 需求 6：每个包独立文件夹（名=包名），缓存在扫描根下 bd2viewer-nikke/
        return new File(new File(root, CACHE_DIRNAME), packFolderOf(ab.getName()));
    }

    /** 缓存是否已是最新（stamp 匹配且产物齐全）。 */
    private static boolean isUpToDate(File ab, File root) {
        File outDir = cacheDirFor(root, ab);
        File stamp = new File(outDir, ".stamp.json");
        if (!stamp.isFile()) return false;
        try {
            JSONObject st = new JSONObject(readText(stamp));
            return st.optBoolean("ok", false)
                    && st.optLong("size") == ab.length()
                    && st.optLong("mtimeMs") == ab.lastModified()
                    && EXTRACT_ENGINE.equals(st.optString("engine", ""))
                    && outputsValid(outDir);
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean outputsValid(File outDir) {
        File atlas = null, skel = null, png = null;
        File[] kids = outDir.listFiles();
        if (kids == null) return false;
        for (File k : kids) {
            String n = k.getName().toLowerCase(Locale.ROOT);
            if (n.endsWith(".atlas")) atlas = k;
            else if (n.endsWith(".skel") || n.endsWith(".json")) skel = k;
            else if (n.endsWith(".png")) png = k;
        }
        return atlas != null && skel != null && png != null
                && atlas.length() > 32 && skel.length() > 32 && png.length() > 1024;
    }

    private static void findBundles(File dir, int depth, List<File> out) {
        if (dir == null || depth > MAX_DEPTH) return;
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File f : kids) {
            String n = f.getName();
            if (f.isDirectory()) {
                if (depth > 0 && UnpackCacheHome.MODE_SOURCE_FOLDERS.contains(
                        n.toLowerCase(Locale.ROOT))) continue;
                // 跳过本缓存 + JCZX 缓存（含 legacy 点目录），避免 NIKKE 档串入 JCZX 产物
                if (n.startsWith(".") || isCacheDirName(n) || JczxExtractor.isCacheDirName(n)) continue;
                findBundles(f, depth + 1, out);
                continue;
            }
            // JCZX 包名（prefabs_spine_*）交给 JCZX 档，不在 NIKKE 队列里解
            if (n.regionMatches(true, 0, "prefabs_spine_", 0, "prefabs_spine_".length())) continue;
            if (!isLikelyBundleName(n)) continue;
            if (!fileLooksLikeUnityFs(f)) continue;
            out.add(f);
        }
    }

    private static int parseIntSafe(String s) {
        try { return Integer.parseInt(s); } catch (Exception e) { return 0; }
    }

    private static int readU32LE(byte[] b, int at) {
        if (at < 0 || at + 4 > b.length) return -1;
        return (b[at] & 0xFF) | ((b[at + 1] & 0xFF) << 8)
                | ((b[at + 2] & 0xFF) << 16) | ((b[at + 3] & 0xFF) << 24);
    }

    private static int indexOf(byte[] hay, byte[] needle, int from) {
        if (needle.length == 0) return -1;
        outer:
        for (int i = Math.max(0, from); i <= hay.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) if (hay[i + j] != needle[j]) continue outer;
            return i;
        }
        return -1;
    }

    private static byte[] readAll(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f)) {
            long len = f.length();
            if (len > 256L * 1024 * 1024) throw new IOException("bundle too large: " + len);
            byte[] out = new byte[(int) len];
            int off = 0;
            while (off < out.length) {
                int n = in.read(out, off, out.length - off);
                if (n <= 0) break;
                off += n;
            }
            if (off != out.length) throw new IOException("short read");
            return out;
        }
    }

    private static String readText(File f) throws IOException {
        return new String(readAll(f), StandardCharsets.UTF_8);
    }

    private static void writeBytes(File f, byte[] data) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("mkdir failed: " + parent);
        }
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(data);
        }
    }

    private static void writeText(File f, String s) throws IOException {
        writeBytes(f, s.getBytes(StandardCharsets.UTF_8));
    }


    /**
     * 源目录被删前/时：清掉对应 bd2viewer-nikke/<pack>/ 与 manifest 条目。
     * 若 relDir 本身落在缓存目录内则跳过（外层递归删已覆盖）。
     */
    public static List<String> clearCacheForDeletedDir(File root, String relDir) {
        List<String> cleared = new ArrayList<>();
        if (root == null || relDir == null) return cleared;
        String rel = relDir.replace('\\', '/');
        while (rel.startsWith("/")) rel = rel.substring(1);
        while (rel.endsWith("/")) rel = rel.substring(0, rel.length() - 1);
        if (rel.isEmpty() || isCacheRel(rel)) return cleared;
        File src = new File(root, rel);
        Set<String> packs = new HashSet<>();
        List<String> sourceRels = new ArrayList<>();
        collectNikkePacksUnder(src, rel, packs, sourceRels);
        // manifest 前缀
        File manFile = new File(new File(root, CACHE_DIRNAME), ".manifest.json");
        JSONObject manifest = null;
        if (manFile.isFile()) {
            try {
                manifest = new JSONObject(readText(manFile));
            } catch (Exception ignored) { manifest = null; }
        }
        if (manifest != null) {
            JSONObject items = manifest.optJSONObject("items");
            if (items != null) {
                String prefix = rel + "/";
                List<String> keys = new ArrayList<>();
                for (java.util.Iterator<String> it = items.keys(); it.hasNext(); ) keys.add(it.next());
                for (String k : keys) {
                    String kk = k.replace('\\', '/');
                    if (kk.equals(rel) || kk.startsWith(prefix)) {
                        packs.add(packFolderOf(kk));
                        if (!sourceRels.contains(kk)) sourceRels.add(kk);
                    }
                }
            }
        }
        for (String pack : packs) {
            File dir = new File(new File(root, CACHE_DIRNAME), pack);
            deleteRec(dir);
            cleared.add(CACHE_DIRNAME + "/" + pack);
        }
        if (manifest != null) {
            JSONObject items = manifest.optJSONObject("items");
            if (items != null) {
                boolean dirty = false;
                String prefix = rel + "/";
                List<String> keys = new ArrayList<>();
                for (java.util.Iterator<String> it = items.keys(); it.hasNext(); ) keys.add(it.next());
                for (String k : keys) {
                    String kk = k.replace('\\', '/');
                    if (sourceRels.contains(kk) || kk.equals(rel) || kk.startsWith(prefix)) {
                        items.remove(k);
                        dirty = true;
                    }
                }
                if (dirty) {
                    try {
                        File cacheRoot = new File(root, CACHE_DIRNAME);
                        //noinspection ResultOfMethodCallIgnored
                        cacheRoot.mkdirs();
                        writeText(manFile, manifest.toString(1));
                    } catch (Exception ignored) { /* */ }
                }
            }
        }
        return cleared;
    }

    private static void collectNikkePacksUnder(File node, String rel, Set<String> packs, List<String> sourceRels) {
        if (node == null || !node.exists()) return;
        if (node.isFile()) {
            String name = node.getName();
            if (isLikelyBundleName(name) && !name.toLowerCase(Locale.ROOT).startsWith("prefabs_spine_")) {
                packs.add(packFolderOf(rel.isEmpty() ? name : rel));
                sourceRels.add(rel.isEmpty() ? name : rel);
            }
            return;
        }
        if (!node.isDirectory()) return;
        File[] kids = node.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            String n = k.getName();
            if (isCacheDirName(n) || JczxExtractor.isCacheDirName(n)
                    || "node_modules".equals(n) || ".git".equals(n) || n.startsWith(".")) continue;
            String rr = rel.isEmpty() ? n : rel + "/" + n;
            collectNikkePacksUnder(k, rr, packs, sourceRels);
        }
    }

    private static void deleteRec(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRec(k);
        }
        if (!f.delete()) f.deleteOnExit();
    }

    /** CLI（仅桌面排障用）：java … NikkeAbExtractor <bundle> <outDir> */
    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: NikkeAbExtractor <bundle> <outDir>");
            System.exit(2);
        }
        File src = new File(args[0]);
        File outDir = new File(args[1]);
        if (!outDir.isDirectory() && !outDir.mkdirs()) throw new IOException("mkdir " + outDir);
        Out out = extract(src, outDir);
        System.out.println("src=" + src.getAbsolutePath());
        System.out.println("ok=" + out.ok + " noSpine=" + out.noSpine + " error=" + out.error);
        for (Item it : out.items) {
            System.out.println("  [" + it.kind + "] " + it.name + " size=" + it.size
                    + (it.wh != null ? " wh=" + it.wh : "")
                    + (it.spine != null ? " spine=" + it.spine : "") + (it.at >= 0 ? " at=" + it.at : ""));
        }
        for (String e : out.errors) System.out.println("  ! " + e);
        System.exit(out.ok ? 0 : 1);
    }

    /** 供 ScanEngine 复用：从包里拿到相对缓存目录。 */
    public static String cacheRelOf(File root, File ab) {
        return cacheDirFor(root, ab).getPath();
    }

    /** 保留给以后做「按目录批量」用。 */
    public static Map<String, byte[]> debugNodes(File f) throws Exception {
        return UnityFs.readNodes(UnityFs.stripToSecondUnityFs(readAll(f)));
    }

    @SuppressWarnings("unused")
    private static final Map<String, byte[]> UNUSED = new LinkedHashMap<>();
}
