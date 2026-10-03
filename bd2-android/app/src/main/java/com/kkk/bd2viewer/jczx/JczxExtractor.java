package com.kkk.bd2viewer.jczx;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
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
 * JCZX (交错战线) on-device extract: dual-UnityFS strip + UnityFS decompress +
 * heuristic TextAsset (atlas/json) + RGBA32 Texture2D → PNG.
 *
 * Phase 1 scope: typical JCZX spine ABs (Unity 2022.x, embedded RGBA32, JSON Spine 4.2).
 * Not a full UnityPy port — no Mesh/Audio/etc. MIT; does not ship GPL AssetTool.
 */
public final class JczxExtractor {
    /**
     * Cache folder under the jczx scan root.
     * Must NOT start with '.' — Android WebView / Chromium often fail to load
     * https://bd2.local/spine/.../.dot-dir/... (Image + XHR → "Couldn't load …").
     * Legacy ".bd2viewer-jczx" is still recognized and migrated on prepare.
     */
    public static final String CACHE_DIRNAME = "bd2viewer-jczx";
    /** Legacy cache name (leading dot); still scanned / migrated. */
    public static final String CACHE_DIRNAME_LEGACY = ".bd2viewer-jczx";
    /** Bump when extract heuristics change so stale cache re-runs. */
    public static final String EXTRACT_ENGINE = "android-jczx-phase1.2";

    public static boolean isCacheDirName(String name) {
        return CACHE_DIRNAME.equals(name) || CACHE_DIRNAME_LEGACY.equals(name);
    }

    public static boolean isCacheRel(String rel) {
        if (rel == null) return false;
        String r = rel.replace('\\', '/');
        return r.equals(CACHE_DIRNAME) || r.startsWith(CACHE_DIRNAME + "/")
                || r.contains("/" + CACHE_DIRNAME + "/")
                || r.equals(CACHE_DIRNAME_LEGACY) || r.startsWith(CACHE_DIRNAME_LEGACY + "/")
                || r.contains("/" + CACHE_DIRNAME_LEGACY + "/");
    }

    /** Rename legacy ".bd2viewer-jczx" → "bd2viewer-jczx" when safe. */
    public static void migrateLegacyCache(File root) {
        if (root == null) return;
        File legacy = new File(root, CACHE_DIRNAME_LEGACY);
        File modern = new File(root, CACHE_DIRNAME);
        if (!legacy.isDirectory()) return;
        if (!modern.exists()) {
            if (!legacy.renameTo(modern)) {
                System.err.println("JczxExtract: legacy cache rename failed: " + legacy);
            }
            return;
        }
        // Both exist: leave legacy; walk will see both until user clears.
    }
    private static final Pattern ATLAS_HEAD = Pattern.compile(
            "(?m)^([A-Za-z0-9_\\-]+\\.png)\\r?\\nsize:(\\d+),(\\d+)\\r?\\n");
    private static final byte[] SKELETON_MARK = "{\"skeleton\"".getBytes(StandardCharsets.UTF_8);

    private JczxExtractor() {}

    public static boolean isLikelyBundleName(String name) {
        if (name == null || name.isEmpty() || name.startsWith(".")) return false;
        String l = name.toLowerCase(Locale.ROOT);
        if (l.endsWith(".atlas") || l.endsWith(".json") || l.endsWith(".skel")
                || l.endsWith(".png") || l.endsWith(".jpg") || l.endsWith(".jpeg")
                || l.endsWith(".webp") || l.endsWith(".bytes") || l.endsWith(".txt")
                || l.endsWith(".md") || l.endsWith(".stamp.json") || l.equals(".extract_report.json")) {
            return false;
        }
        // 名字只是提示。无扩展名的 NIKKE 包不能因为没有后缀就入队。
        // 真正入队看 looksLikeJczxPack：prefabs_spine（可带 hash 前缀）或双头 UnityFS。
        if (l.contains("prefabs_spine")) return true;
        if (l.endsWith(".ab") || l.endsWith(".unity3d") || l.endsWith(".bundle") || l.endsWith(".assets")) return true;
        return false;
    }

    /**
     * JCZX 包：名字含 prefabs_spine，或文件头 4KB 内有第二段 UnityFS。
     * 单头 UnityFS（NIKKE 的无扩展名 mod）返回 false，避免两个模式互相扫到。
     */
    public static boolean looksLikeJczxPack(File f) {
        if (f == null || !f.isFile() || f.length() < 16) return false;
        String name = f.getName();
        if (name.toLowerCase(Locale.ROOT).contains("prefabs_spine")) return fileLooksLikeUnityFs(f);
        byte[] head = new byte[4096];
        int nread;
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            nread = in.read(head);
        } catch (Exception e) {
            return false;
        }
        if (nread < 8 || !UnityFs.looksLikeUnityFs(head)) return false;
        byte[] magic = UnityFs.MAGIC;
        for (int i = 1; i + magic.length <= nread; i++) {
            boolean ok = true;
            for (int k = 0; k < magic.length; k++) {
                if (head[i + k] != magic[k]) { ok = false; break; }
            }
            if (ok) return true;
        }
        return false;
    }

    public static boolean fileLooksLikeUnityFs(File f) {
        if (f == null || !f.isFile() || f.length() < 16) return false;
        byte[] head = new byte[8];
        try (FileInputStream in = new FileInputStream(f)) {
            if (in.read(head) != 8) return false;
            return UnityFs.looksLikeUnityFs(head);
        } catch (Exception e) {
            return false;
        }
    }


    /**
     * 包级并发上限。
     *
     * ⚠️ **必须是 1**（2026-10-03 按 `BD2Viewer-APK-fixes.md` §2.1 改，原值 10）。
     * 手机内存经不起同时解 10 个 UnityFS；`OutOfMemoryError` 是 **Error 不是 Exception**，
     * `catch (Exception)` 接不住 → 默认未捕获处理器会把整个进程杀掉，
     * 表现就是「一点读取就闪退」。
     */
    public static final int MAX_CONCURRENT = 1;
    /** 单包 inFlight 超时：超时记 failed 并腾槽，避免进度/toast 永远卡住。 */
    public static final long INFLIGHT_STUCK_MS = 180_000L;
    private static final int PRI_NORMAL = 0;
    private static final int PRI_HIGH = 1_000_000;
    private static final AtomicInteger GLOBAL_SEQ = new AtomicInteger();

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
        final Map<String, Long> inFlightStarted = new HashMap<>();
        int found, reused, extracted, failed, skippedNoSpine;
        final JSONArray errors = new JSONArray();
        // legacy toast fields (arrays of objects) kept for older UI
        final JSONArray extractedList = new JSONArray();
        final JSONArray reusedList = new JSONArray();
        long lastFullPrepareAt;
        RootQueue(File root) { this.root = root; }
    }
    private static final Map<String, RootQueue> ROOT_QUEUES = new HashMap<>();
    private static final ExecutorService JCZX_POOL =
            Executors.newFixedThreadPool(MAX_CONCURRENT, r -> {
                Thread t = new Thread(r, "jczx-unpack");
                t.setDaemon(true);
                // 只打日志，**不要**再交给系统默认处理器（那会杀进程）。
                // ⚠️ 本类刻意保持**纯 Java**（无 android import，桌面端 Java 测试也复用它），
                // 所以用 printStackTrace（Android 会把它转到 logcat 的 System.err）。
                t.setUncaughtExceptionHandler((th, e) -> {
                    System.err.println("[" + th.getName() + "] 解包线程未捕获异常: " + e);
                    e.printStackTrace();
                });
                return t;
            });
    private static final Comparator<QItem> QUEUE_CMP =
            (a, b) -> b.priority != a.priority ? Integer.compare(b.priority, a.priority)
                    : Integer.compare(a.seq, b.seq);

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

    private static String relOfRoot(File root, File ab) {
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
        String rel = relOfRoot(rq.root, ab);
        synchronized (rq.lock) {
            if (rq.inFlight.contains(rel)) {
                QItem existing = rq.known.get(rel);
                if (existing != null && priority > existing.priority) existing.priority = priority;
                return;
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

    private static void sweepStuck(RootQueue rq) {
        long now = System.currentTimeMillis();
        List<String> stuck = new ArrayList<>();
        for (Map.Entry<String, Long> e : rq.inFlightStarted.entrySet()) {
            if (e.getValue() != null && now - e.getValue() > INFLIGHT_STUCK_MS) stuck.add(e.getKey());
        }
        for (String rel : stuck) {
            rq.inFlight.remove(rel);
            rq.inFlightStarted.remove(rel);
            rq.failed++;
            try {
                rq.errors.put(new JSONObject()
                        .put("src", rel)
                        .put("error", "inFlight timeout >" + (INFLIGHT_STUCK_MS / 1000) + "s"));
            } catch (Exception ignored) { /* */ }
        }
    }

    private static void pump(RootQueue rq) {
        synchronized (rq.lock) {
            sweepStuck(rq);
            while (rq.inFlight.size() < MAX_CONCURRENT && !rq.queue.isEmpty()) {
                QItem job = rq.queue.remove(0);
                if (rq.inFlight.contains(job.rel)) continue;
                rq.inFlight.add(job.rel);
                rq.inFlightStarted.put(job.rel, System.currentTimeMillis());
                final QItem j = job;
                JCZX_POOL.execute(() -> {
                    try {
                        runOne(rq, j);
                    } finally {
                        synchronized (rq.lock) {
                            rq.inFlight.remove(j.rel);
                            rq.inFlightStarted.remove(j.rel);
                        }
                        pump(rq);
                    }
                });
            }
        }
    }

    private static void runOne(RootQueue rq, QItem job) {
        try {
            Result r = ensureExtracted(job.ab, rq.root);
            synchronized (rq.lock) {
                JSONObject one = new JSONObject();
                try {
                    one.put("src", job.ab.getAbsolutePath());
                    one.put("cacheDir", r.cacheDir.getAbsolutePath());
                    one.put("spine", r.spineVer == null ? JSONObject.NULL : r.spineVer);
                } catch (Exception ignored) { /* */ }
                if (r.reused) {
                    rq.reused++;
                    rq.reusedList.put(one);
                } else if (r.ok) {
                    rq.extracted++;
                    rq.extractedList.put(one);
                } else {
                    // 无完整三件套 → skippedNoSpine（计入 done）；硬错误走 catch → failed
                    rq.skippedNoSpine++;
                }
            }
        } catch (Throwable e) {
            // 必须接 Throwable：OutOfMemoryError 是 Error 不是 Exception，
            // 漏出去就会被默认未捕获处理器杀掉进程（APK-fixes §2.1）
            synchronized (rq.lock) {
                rq.failed++;
                try {
                    rq.errors.put(new JSONObject()
                            .put("src", job.ab.getAbsolutePath())
                            .put("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage()));
                } catch (Exception ignored) { /* */ }
            }
        }
    }

    public static JSONObject progressOf(File root) {
        return progressOf(queueFor(root));
    }

    private static JSONObject progressOf(RootQueue rq) {
        JSONObject meta = new JSONObject();
        try {
            List<String> pendingRels = new ArrayList<>();
            List<String> currentRels = new ArrayList<>();
            List<String> current = new ArrayList<>();
            int pending, inFlight;
            synchronized (rq.lock) {
                sweepStuck(rq);
                pending = rq.queue.size();
                inFlight = rq.inFlight.size();
                for (String r : rq.inFlight) {
                    currentRels.add(r);
                    int slash = Math.max(r.lastIndexOf('/'), r.lastIndexOf('\\'));
                    current.add(slash >= 0 ? r.substring(slash + 1) : r);
                }
                for (QItem q : rq.queue) pendingRels.add(q.rel);
                for (String r : rq.inFlight) {
                    if (!pendingRels.contains(r)) pendingRels.add(r);
                }
                int done = rq.reused + rq.extracted + rq.failed + rq.skippedNoSpine;
                int playableDone = rq.reused + rq.extracted;
                int total = Math.max(rq.found, done + pending + inFlight);
                meta.put("found", rq.found);
                meta.put("bundles", rq.found);
                meta.put("reusedCount", rq.reused);
                meta.put("extractedCount", rq.extracted);
                meta.put("failed", rq.failed);
                meta.put("skippedNoSpine", rq.skippedNoSpine);
                meta.put("pending", pending);
                meta.put("inFlight", inFlight);
                meta.put("done", done);
                meta.put("playableDone", playableDone);
                meta.put("total", total);
                meta.put("ready", pending == 0 && inFlight == 0);
                meta.put("ok", rq.errors.length() == 0);
                meta.put("cacheDir", CACHE_DIRNAME);
                meta.put("limit", MAX_CONCURRENT);
                meta.put("errors", rq.errors);
                // toast UI historically reads extracted/reused as object arrays
                meta.put("extracted", rq.extractedList);
                meta.put("reused", rq.reusedList);
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

    /** 抬高指定包优先级（不打断 in-flight）。 */
    public static JSONObject prioritize(File root, List<String> rels) {
        RootQueue rq = queueFor(root);
        int bumped = 0;
        if (rels != null) {
            for (String rel : rels) {
                if (rel == null || rel.isEmpty()) continue;
                String r = rel.replace('\\', '/');
                File ab;
                synchronized (rq.lock) {
                    QItem it = rq.known.get(r);
                    if (rq.inFlight.contains(r)) { bumped++; continue; }
                    ab = (it != null) ? it.ab : new File(root, r);
                }
                if (ab != null && ab.isFile()) {
                    enqueue(rq, ab, PRI_HIGH + GLOBAL_SEQ.incrementAndGet());
                    bumped++;
                }
            }
        }
        pump(rq);
        JSONObject out = progressOf(rq);
        try { out.put("bumped", bumped); } catch (Exception ignored) { /* */ }
        return out;
    }

    /**
     * 扫描前把根下 JCZX AB 排进优先级队列并开始解包（并发 ≤ 10）。
     * <b>立即返回</b>：已就绪的 {@code bd2viewer-jczx/} 立刻进入 walk；
     * 未解完的包后台续解，前端用进度条 + 轮询重扫增量刷新。
     * 旧实现同步等完全部包 → 截止时间被吃光 → gallery 显示 0 L2D。
     */
    public static JSONObject prepareRoot(File root) {
        JSONObject meta = new JSONObject();
        try {
            RootQueue rq = queueFor(root);
            synchronized (rq.lock) {
                boolean busy = !rq.queue.isEmpty() || !rq.inFlight.isEmpty();
                if (busy && rq.found > 0 && rq.lastFullPrepareAt > 0
                        && (System.currentTimeMillis() - rq.lastFullPrepareAt) < 20000L) {
                    return progressOf(rq);
                }
            }
            migrateLegacyCache(root);
            List<File> bundles = new ArrayList<>();
            findBundles(root, 0, 5, bundles);
            synchronized (rq.lock) {
                sweepStuck(rq);
                // 新一轮 full prepare：清计数（保留 in-flight / 已排队）
                rq.extracted = 0;
                rq.failed = 0;
                rq.skippedNoSpine = 0;
                while (rq.errors.length() > 0) rq.errors.remove(0);
                while (rq.extractedList.length() > 0) rq.extractedList.remove(0);
                while (rq.reusedList.length() > 0) rq.reusedList.remove(0);
                rq.reused = 0;
                rq.found = bundles.size();
            }
            int reused = 0;
            List<File> todo = new ArrayList<>();
            java.util.Set<String> live = new HashSet<>();
            for (File ab : bundles) {
                String rel = relOfRoot(root, ab);
                live.add(rel);
                try {
                    Result r = peekReuse(ab, root);
                    if (r != null && r.reused) { reused++; continue; }
                } catch (Exception ignored) { /* need extract */ }
                todo.add(ab);
            }
            synchronized (rq.lock) {
                rq.known.keySet().retainAll(live);
                rq.queue.removeIf(q -> !live.contains(q.rel));
                rq.reused = reused;
            }
            for (File ab : todo) enqueue(rq, ab, PRI_NORMAL);
            pump(rq);
            synchronized (rq.lock) { rq.lastFullPrepareAt = System.currentTimeMillis(); }
            meta = progressOf(rq);
        } catch (Throwable e) {
            try {
                meta.put("bundles", 0);
                meta.put("found", 0);
                meta.put("pending", 0);
                meta.put("ready", false);
                meta.put("ok", false);
                meta.put("extracted", new JSONArray());
                meta.put("reused", new JSONArray());
                JSONArray errs = new JSONArray();
                errs.put(new JSONObject().put("src", JSONObject.NULL)
                        .put("error", String.valueOf(e.getMessage())));
                meta.put("errors", errs);
            } catch (Exception ignored) { /* */ }
        }
        return meta;
    }

    /** Stamp-only reuse check without clearing/extracting. */
    private static Result peekReuse(File ab, File root) {
        Result r = new Result();
        try {
            r.cacheDir = cacheDirFor(root, ab);
        } catch (Exception e) {
            return null;
        }
        File stamp = new File(r.cacheDir, ".stamp.json");
        long size = ab.length();
        long mtime = ab.lastModified();
        if (!stamp.isFile()) return null;
        try {
            String text = readText(stamp);
            JSONObject st = new JSONObject(text);
            if (st.optBoolean("ok", false) && st.optLong("size") == size && st.optLong("mtimeMs") == mtime
                    && EXTRACT_ENGINE.equals(st.optString("engine", ""))
                    && cacheOutputsValid(r.cacheDir)) {
                r.reused = true;
                r.ok = true;
                return r;
            }
        } catch (Exception ignored) { /* */ }
        return null;
    }

    public static final class Result {
        public File cacheDir;
        public boolean reused;
        public boolean ok;
        public String spineVer;
        public JSONObject report;
    }

    public static Result ensureExtracted(File ab, File root) throws Exception {
        Result r = new Result();
        r.cacheDir = cacheDirFor(root, ab);
        File stamp = new File(r.cacheDir, ".stamp.json");
        long size = ab.length();
        long mtime = ab.lastModified();
        if (stamp.isFile()) {
            try {
                String text = readText(stamp);
                JSONObject st = new JSONObject(text);
                if (st.optBoolean("ok", false) && st.optLong("size") == size && st.optLong("mtimeMs") == mtime
                        && EXTRACT_ENGINE.equals(st.optString("engine", ""))
                        && cacheOutputsValid(r.cacheDir)) {
                    r.reused = true;
                    r.ok = true;
                    r.report = st.optJSONObject("report");
                    if (r.report != null) {
                        JSONArray ex = r.report.optJSONArray("exported");
                        if (ex != null) {
                            for (int i = 0; i < ex.length(); i++) {
                                JSONObject o = ex.optJSONObject(i);
                                if (o != null && "json".equals(o.optString("kind")) && o.has("spine")) {
                                    r.spineVer = o.optString("spine", null);
                                }
                            }
                        }
                    }
                    return r;
                }
            } catch (Exception ignored) { /* re-extract */ }
        }
        if (!r.cacheDir.exists() && !r.cacheDir.mkdirs()) {
            throw new IOException("mkdir cache failed: " + r.cacheDir);
        }
        // clear old outputs except stamp
        File[] kids = r.cacheDir.listFiles();
        if (kids != null) {
            for (File k : kids) {
                if (".stamp.json".equals(k.getName())) continue;
                deleteRec(k);
            }
        }
        JSONObject report = extract(ab, r.cacheDir);
        r.report = report;
        r.ok = report.optBoolean("ok", false);
        JSONArray ex = report.optJSONArray("exported");
        if (ex != null) {
            for (int i = 0; i < ex.length(); i++) {
                JSONObject o = ex.optJSONObject(i);
                if (o != null && "json".equals(o.optString("kind"))) {
                    r.spineVer = o.optString("spine", null);
                }
            }
        }
        JSONObject stampObj = new JSONObject();
        stampObj.put("ok", r.ok);
        stampObj.put("size", size);
        stampObj.put("mtimeMs", mtime);
        stampObj.put("src", ab.getAbsolutePath());
        stampObj.put("report", report);
        stampObj.put("extractedAt", java.time.Instant.now().toString());
        stampObj.put("engine", EXTRACT_ENGINE);
        writeText(stamp, stampObj.toString());
        if (!r.ok) {
            throw new IOException("JCZX extract failed: " + ab.getName() + " — " + report.optString("error", "incomplete"));
        }
        return r;
    }

    public static JSONObject extract(File src, File outDir) throws Exception {
        JSONObject summary = new JSONObject();
        summary.put("src", src.getAbsolutePath());
        byte[] raw = readAll(src);
        summary.put("size", raw.length);
        List<Integer> offs = UnityFs.findUnityFsOffsets(raw);
        JSONArray offsArr = new JSONArray();
        for (Integer o : offs) offsArr.put(o.intValue());
        summary.put("unityfs_offsets", offsArr);
        byte[] stripped = UnityFs.stripToSecondUnityFs(raw);
        summary.put("stripped_size", stripped.length);
        // free original if stripped is a copy
        raw = null;

        Map<String, byte[]> nodes = UnityFs.readNodes(stripped);
        stripped = null;
        ByteArrayJoin cab = joinCab(nodes);
        JSONArray exported = new JSONArray();
        JSONArray errors = new JSONArray();

        // --- TextAsset: Spine JSON（JCZX 4.2 是 JSON） ---
        TextHit jsonHit = findSpineJson(cab.data);
        String jsonBase = null;
        if (jsonHit != null) {
            jsonBase = jsonHit.name != null ? jsonHit.name : "skeleton";
            for (String suf : new String[]{".skel", ".json", ".bytes", ".txt"}) {
                if (jsonBase.toLowerCase(Locale.ROOT).endsWith(suf)) {
                    jsonBase = jsonBase.substring(0, jsonBase.length() - suf.length());
                    break;
                }
            }
        }

        // --- TextAsset: atlas ---
        TextHit atlasHit = findAtlas(cab.data, jsonBase);
        int texW = 0, texH = 0;
        String baseName = jsonBase;
        if (atlasHit != null) {
            String an = atlasHit.name != null ? atlasHit.name : (baseName != null ? baseName : "atlas");
            if (!an.toLowerCase(Locale.ROOT).endsWith(".atlas")) an = an + ".atlas";
            // Prefer basename from atlas content first line / size match
            Matcher m = ATLAS_HEAD.matcher(new String(atlasHit.bytes, StandardCharsets.UTF_8));
            if (m.find()) {
                texW = Integer.parseInt(m.group(2));
                texH = Integer.parseInt(m.group(3));
            }
            writeBytes(new File(outDir, an), atlasHit.bytes);
            JSONObject o = new JSONObject();
            o.put("kind", "atlas");
            o.put("name", an);
            o.put("size", atlasHit.bytes.length);
            exported.put(o);
            if (baseName == null) {
                baseName = an.endsWith(".atlas") ? an.substring(0, an.length() - 6) : an;
            }
        } else {
            errors.put(new JSONObject().put("err", "no atlas TextAsset"));
        }

        // --- 骨架：JSON 优先，二进制 .skel 兜底 ---
        // 大部分 mod 包（NIKKE 等）的骨架是**二进制** .skel；这里曾经只认 JSON，
        // 结果几百个包解出来只有 atlas + png，卡片能列出来却播不了。
        boolean skeletonOk = false;
        if (jsonHit != null) {
            String fname = baseName + ".json";
            writeBytes(new File(outDir, fname), jsonHit.bytes);
            JSONObject o = new JSONObject();
            o.put("kind", "json");
            o.put("name", fname);
            o.put("size", jsonHit.bytes.length);
            o.put("spine", jsonHit.spineVer == null ? JSONObject.NULL : jsonHit.spineVer);
            exported.put(o);
            skeletonOk = true;
        } else if (baseName != null) {
            TextHit skelHit = findSpineSkel(cab.data, baseName);
            if (skelHit != null) {
                String fname = baseName + ".skel";
                writeBytes(new File(outDir, fname), skelHit.bytes);
                JSONObject o = new JSONObject();
                o.put("kind", "skel");
                o.put("name", fname);
                o.put("size", skelHit.bytes.length);
                o.put("spine", skelHit.spineVer == null ? JSONObject.NULL : skelHit.spineVer);
                exported.put(o);
                skeletonOk = true;
            }
        }
        if (!skeletonOk) {
            errors.put(new JSONObject().put("err", "no skeleton TextAsset (.json/.skel)"));
        }

        // --- Texture2D RGBA32 (Unity bottom-up; flip for PNG/Spine top-left) ---
        if (texW > 0 && texH > 0) {
            try {
                long needL = (long) texW * texH * 4L;
                if (needL > Integer.MAX_VALUE) throw new IOException("texture too large");
                int need = (int) needL;
                int dataAt = findRgbaBlob(cab.data, need);
                if (dataAt < 0) throw new IOException("RGBA blob " + need + " not found");
                byte[] rgba = new byte[need];
                System.arraycopy(cab.data, dataAt, rgba, 0, need);
                flipVerticalInPlace(rgba, texW, texH);
                String pname = (baseName != null ? baseName : "tex") + ".png";
                try (FileOutputStream fos = new FileOutputStream(new File(outDir, pname))) {
                    PngEncoder.writeRGBA(fos, rgba, texW, texH);
                }
                JSONObject o = new JSONObject();
                o.put("kind", "png");
                o.put("name", pname);
                o.put("size", new File(outDir, pname).length());
                o.put("wh", texW + "x" + texH);
                exported.put(o);
            } catch (Exception e) {
                errors.put(new JSONObject().put("err", "texture: " + e.getMessage()));
            }
        } else {
            errors.put(new JSONObject().put("err", "no atlas size for texture"));
        }

        summary.put("exported", exported);
        summary.put("errors", errors);
        boolean atlasOk = false, jsonOk = false, pngOk = false;
        for (int i = 0; i < exported.length(); i++) {
            String k = exported.optJSONObject(i).optString("kind");
            if ("atlas".equals(k)) atlasOk = true;
            if ("json".equals(k) || "skel".equals(k)) jsonOk = true;
            if ("png".equals(k)) pngOk = true;
        }
        boolean cgName = src.getName().toLowerCase(java.util.Locale.ROOT).contains("_draw");
        boolean imageOnly = pngOk && !atlasOk && !jsonOk && cgName;
        summary.put("imageOnly", imageOnly);
        // 立绘三件套，或静态 CG（包名带 _draw）。动画贴图包同样没有骨架，不当 CG。
        summary.put("ok", (atlasOk && jsonOk && pngOk) || imageOnly);
        return summary;
    }

    /**
     * Stale-cache guard: engine stamp alone is not enough — phones may keep a
     * phase-matched folder that only has a tiny stub PNG and/or a .skel with no
     * readable Spine 4.2 animations (UnityPy/desktop export .json). Force
     * re-extract when outputs look wrong.
     */
    public static boolean cacheOutputsValid(File cacheDir) {
        if (cacheDir == null || !cacheDir.isDirectory()) return false;
        File atlas = null, json = null, png = null, skel = null;
        File[] kids = cacheDir.listFiles();
        if (kids == null) return false;
        for (File k : kids) {
            if (!k.isFile()) continue;
            String n = k.getName().toLowerCase(Locale.ROOT);
            if (n.endsWith(".atlas")) atlas = k;
            else if (n.endsWith(".json")) json = k;
            else if (n.endsWith(".skel") || n.endsWith(".skel.bytes")) skel = k;
            else if (n.endsWith(".png") && !"thumb.png".equals(n)) png = k;
        }
        if (atlas == null && json == null && skel == null) {
            // 纯 CG：目录里只有一张像样的 png，且缓存名带来源包的 _draw
            String dirName = cacheDir.getName().toLowerCase(Locale.ROOT);
            return png != null && png.length() > 1024 && dirName.contains("_draw");
        }
        if (atlas == null || png == null) return false;
        // 骨架：JSON（JCZX 4.2）或二进制 .skel（NIKKE / 大部分 mod 包）都算数，
        // 但两者都没有 → 旧缓存里那批「只有图集没有骨架」的产物必须重解。
        if (json == null && skel == null) return false;
        if (json != null && json.length() < 64) return false;
        // Peek atlas size: WxH → raw bytes; reject stub/garbled PNGs (~256KB for multi-MB).
        int[] wh = peekAtlasSize(atlas);
        if (wh != null && wh[0] > 0 && wh[1] > 0) {
            long need = (long) wh[0] * (long) wh[1] * 4L;
            if (need >= 1_000_000L && png.length() < 400_000L) return false;
            if (need >= 4_000_000L && png.length() * 200L < need) return false;
        }
        return true;
    }

    private static int[] peekAtlasSize(File atlas) {
        try {
            String head = readText(atlas);
            if (head.length() > 512) head = head.substring(0, 512);
            Matcher m = ATLAS_HEAD.matcher(head);
            if (!m.find()) return null;
            return new int[]{Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3))};
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Locate embedded RGBA32 pixels in joined CAB(+resS) bytes.
     * Unity Texture2D (2020+/2022) layout near the blob:
     *   m_Width (i32) | m_Height (i32) | m_CompleteImageSize (i32 == w*h*4)
     *   … a few dozen bytes of format/mip/settings …
     *   image data length prefix (i32 == need) | pixels
     * Preferring the last bare length-prefix match is wrong when JSON/atlas
     * contain coincidental LE int32s equal to need (Kunlun03 → neon garbage).
     */
    private static int findRgbaBlob(byte[] cab, int need) {
        if (need <= 0 || need % 4 != 0) return -1;
        byte[] needLe = new byte[]{
                (byte) (need & 0xff),
                (byte) ((need >> 8) & 0xff),
                (byte) ((need >> 16) & 0xff),
                (byte) ((need >> 24) & 0xff)
        };
        // pixels = w*h; try factor pairs matching atlas dimensions by reading
        // w,h immediately before each m_CompleteImageSize (== need).
        int from = 0;
        while (from + 12 + need <= cab.length) {
            int p = indexOf(cab, needLe, from);
            if (p < 0) break;
            // Require this need to be m_CompleteImageSize: preceded by m_Width, m_Height
            // with w*h*4 == need.
            if (p >= 8) {
                int w = u32le(cab, p - 8);
                int h = u32le(cab, p - 4);
                long wh4 = (long) w * (long) h * 4L;
                if (w > 0 && h > 0 && wh4 == (long) need) {
                    // Image byte[] length prefix is the NEXT needLe within a short meta window.
                    int metaFrom = p + 4;
                    int metaEnd = Math.min(cab.length, metaFrom + 256);
                    int q = indexOf(cab, needLe, metaFrom);
                    if (q >= metaFrom && q < metaEnd) {
                        int dataAt = q + 4;
                        if (dataAt + need <= cab.length) {
                            // First solid layout hit is the Texture2D.
                            return dataAt;
                        }
                    }
                }
            }
            from = p + 1;
        }
        // Fallback: last length-prefix (legacy MareeRouge-class when layout odd)
        int last = -1;
        from = 0;
        while (from + 4 + need <= cab.length) {
            int p = indexOf(cab, needLe, from);
            if (p < 0) break;
            int dataAt = p + 4;
            if (dataAt + need <= cab.length) last = dataAt;
            from = p + 1;
        }
        return last;
    }

    private static int u32le(byte[] b, int off) {
        return (b[off] & 0xff)
                | ((b[off + 1] & 0xff) << 8)
                | ((b[off + 2] & 0xff) << 16)
                | ((b[off + 3] & 0xff) << 24);
    }

    private static void flipVerticalInPlace(byte[] rgba, int w, int h) {
        int row = w * 4;
        byte[] tmp = new byte[row];
        for (int y = 0; y < h / 2; y++) {
            int a = y * row;
            int b = (h - 1 - y) * row;
            System.arraycopy(rgba, a, tmp, 0, row);
            System.arraycopy(rgba, b, rgba, a, row);
            System.arraycopy(tmp, 0, rgba, b, row);
        }
    }

    private static final class TextHit {
        String name;
        byte[] bytes;
        String spineVer;
    }

    private static TextHit findSpineJson(byte[] cab) {
        int idx = indexOf(cab, SKELETON_MARK, 0);
        if (idx < 0) return null;
        int end = matchJsonEnd(cab, idx);
        if (end < 0) return null;
        TextHit h = new TextHit();
        h.bytes = new byte[end - idx];
        System.arraycopy(cab, idx, h.bytes, 0, h.bytes.length);
        h.name = nameBefore(cab, idx);
        try {
            String s = new String(h.bytes, 0, Math.min(h.bytes.length, 512), StandardCharsets.UTF_8);
            Matcher m = Pattern.compile("\"spine\"\\s*:\\s*\"([^\"]+)\"").matcher(s);
            if (m.find()) h.spineVer = m.group(1);
        } catch (Exception ignored) { /* */ }
        return h;
    }

    /**
     * 二进制 Spine 骨架（`.skel`）TextAsset。CAB 里的布局是
     * `[u32 LE 名字长度][名字][补齐4][u32 LE 数据长度][数据]`，
     * 数据开头是 `[8 字节 hash][u8 版本串长度][版本串]`。
     *
     * 桌面端曾经只接受 JSON 骨架，把二进制 .skel 当「其它 TextAsset」丢掉，
     * 于是几百个包解出来只有 atlas + png —— 卡片列得出来，点开却播不了。
     */
    // 包内可见：便于桌面 JVM 上跑真实包做验证（org.json 在 android.jar 里是 stub，
    // 桌面 JVM 没法直接调 extract()，只能单独验这个方法）
    static TextHit findSpineSkel(byte[] cab, String base) {
        if (base == null || base.isEmpty()) return null;
        for (String nm : new String[]{base + ".skel", base + ".skel.bytes"}) {
            byte[] nb = nm.getBytes(StandardCharsets.UTF_8);
            int from = 0;
            while (true) {
                int p = indexOf(cab, nb, from);
                if (p < 0) break;
                from = p + 1;
                if (p < 4 || u32le(cab, p - 4) != nb.length) continue;   // 不是对象名
                // Unity 的字符串是「长度前缀 + 恰好 len 字节」，之后 AlignStream(4)。
                // 没有 NUL、也不额外补位 —— 写成 `+1+3` 会偏 4 字节，读出来是垃圾长度
                // （实测：c224_00.skel 的长度前缀就在名字末尾，不在 +1 处）。
                int q = (p + nb.length + 3) & ~3;
                if (q + 4 > cab.length) continue;
                int len = u32le(cab, q);
                if (len < 64 || (long) q + 4L + len > cab.length) continue;
                int start = q + 4;
                String ver = binarySpineVersion(cab, start, len);
                if (ver == null) continue;                                // 不像骨架
                TextHit h = new TextHit();
                h.bytes = new byte[len];
                System.arraycopy(cab, start, h.bytes, 0, len);
                h.name = nm;
                h.spineVer = ver;
                return h;
            }
        }
        return null;
    }

    /**
     * 二进制骨架头：`[8 字节 hash][varint 长度][版本串]`。不像就返回 null。
     *
     * ⚠️ 长度用的是 Spine 的 varint 字符串编码：**`0` = null、`1` = 空串**，所以真实字符数是
     * `n - 1`。直接按 `n` 读会多吃一个字节（实测 c224_00.skel 读成 `4.1.20\xc4`，
     * 正则不匹配 → 整个骨架被判成「不是骨架」）。
     */
    static String binarySpineVersion(byte[] cab, int at, int len) {
        if (len < 12 || at + 10 > cab.length) return null;
        int n = cab[at + 8] & 0xFF;
        if (n < 2 || n > 25 || at + 9 + n > cab.length) return null;
        int take = n - 1;                       // Spine 的字符串长度编码：n-1 个实际字符
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < take; i++) {
            int c = cab[at + 9 + i] & 0xFF;
            if (c == 0) break;
            sb.append((char) c);
        }
        String s = sb.toString();
        return s.matches("[34]\\.\\d+\\.\\d+") ? s : null;
    }

    private static TextHit findAtlas(byte[] cab, String preferBase) {
        byte[] marker = ".png\nsize:".getBytes(StandardCharsets.UTF_8);
        byte[] markerCr = ".png\r\nsize:".getBytes(StandardCharsets.UTF_8);
        TextHit fallback = null;
        int searchFrom = 0;
        while (searchFrom < cab.length) {
            int a = indexOf(cab, marker, searchFrom);
            int b = indexOf(cab, markerCr, searchFrom);
            int hit;
            if (a < 0) hit = b;
            else if (b < 0) hit = a;
            else hit = Math.min(a, b);
            if (hit < 0) break;
            int lineStart = hit;
            while (lineStart > 0 && cab[lineStart - 1] != '\n' && cab[lineStart - 1] != 0) lineStart--;
            int windowEnd = Math.min(cab.length, lineStart + 256);
            String head = new String(cab, lineStart, windowEnd - lineStart, StandardCharsets.UTF_8);
            Matcher m = ATLAS_HEAD.matcher(head);
            if (m.find()) {
                int atlasStart = lineStart;
                Integer scriptLen = lengthPrefixBefore(cab, atlasStart);
                byte[] bytes;
                if (scriptLen != null && scriptLen > 32 && scriptLen < 5_000_000
                        && atlasStart + scriptLen <= cab.length) {
                    bytes = new byte[scriptLen];
                    System.arraycopy(cab, atlasStart, bytes, 0, scriptLen);
                } else {
                    int k = atlasStart;
                    while (k < cab.length && cab[k] != 0) k++;
                    bytes = new byte[k - atlasStart];
                    System.arraycopy(cab, atlasStart, bytes, 0, bytes.length);
                }
                String pngName = m.group(1);
                TextHit h = new TextHit();
                h.bytes = bytes;
                h.name = nameBefore(cab, atlasStart);
                if (h.name == null) {
                    h.name = pngName.endsWith(".png") ? pngName.substring(0, pngName.length() - 4) : pngName;
                }
                boolean matchPrefer = preferBase != null
                        && pngName.regionMatches(true, 0, preferBase, 0, Math.min(preferBase.length(), pngName.length()));
                if (matchPrefer) return h;
                if (fallback == null) fallback = h;
            }
            searchFrom = hit + 1;
        }
        return fallback;
    }

    private static Integer lengthPrefixBefore(byte[] cab, int contentStart) {
        // TextAsset: name (aligned string) then int32 LE length then bytes. Content starts after length.
        if (contentStart >= 4) {
            int p = contentStart - 4;
            int v = (cab[p] & 0xff) | ((cab[p + 1] & 0xff) << 8)
                    | ((cab[p + 2] & 0xff) << 16) | ((cab[p + 3] & 0xff) << 24);
            if (v > 0 && contentStart + v <= cab.length) return v;
        }
        return null;
    }

    private static String nameBefore(byte[] cab, int contentStart) {
        // look back over length prefix (4) then null-terminated name with length prefix
        int p = contentStart - 4;
        if (p < 8) return null;
        // before length is name ending with 0
        int nameEnd = p; // points at length field; name null is at p-1 if aligned string includes trailing 0
        if (nameEnd <= 0 || cab[nameEnd - 1] != 0) {
            // sometimes no extra alignment
            return null;
        }
        int nameNul = nameEnd - 1;
        int nameStart = nameNul;
        while (nameStart > 0 && cab[nameStart - 1] != 0 && (nameNul - nameStart) < 256) nameStart--;
        // optional: length prefix before name
        if (nameStart >= 4) {
            int np = nameStart - 4;
            int nlen = (cab[np] & 0xff) | ((cab[np + 1] & 0xff) << 8)
                    | ((cab[np + 2] & 0xff) << 16) | ((cab[np + 3] & 0xff) << 24);
            if (nlen > 0 && nlen < 256 && np + 4 + nlen == nameNul) {
                return new String(cab, nameStart, nlen, StandardCharsets.UTF_8);
            }
        }
        if (nameNul > nameStart) {
            return new String(cab, nameStart, nameNul - nameStart, StandardCharsets.UTF_8);
        }
        return null;
    }

    private static int matchJsonEnd(byte[] cab, int start) {
        int depth = 0;
        boolean inStr = false;
        boolean esc = false;
        for (int i = start; i < cab.length; i++) {
            int c = cab[i] & 0xff;
            if (inStr) {
                if (esc) { esc = false; continue; }
                if (c == '\\') { esc = true; continue; }
                if (c == '"') inStr = false;
                continue;
            }
            if (c == '"') { inStr = true; continue; }
            if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) return i + 1;
            }
        }
        return -1;
    }

    private static final class ByteArrayJoin {
        byte[] data;
    }

    private static ByteArrayJoin joinCab(Map<String, byte[]> nodes) {
        // Prefer concatenating CAB then resS in map order; search spans all
        int total = 0;
        for (byte[] b : nodes.values()) total += b.length;
        byte[] all = new byte[total];
        int o = 0;
        for (byte[] b : nodes.values()) {
            System.arraycopy(b, 0, all, o, b.length);
            o += b.length;
        }
        ByteArrayJoin j = new ByteArrayJoin();
        j.data = all;
        return j;
    }

    static File cacheDirFor(File root, File ab) throws Exception {
        String rel = relativize(root, ab);
        String key = rel.replace('/', '_').replace('\\', '_').replaceAll("[^\\w.\\-\\u4e00-\\u9fa5]+", "_");
        MessageDigest md = MessageDigest.getInstance("SHA-1");
        byte[] dig = md.digest(rel.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (int i = 0; i < 5; i++) hex.append(String.format("%02x", dig[i]));
        return new File(new File(root, CACHE_DIRNAME), hex + "_" + key);
    }

    private static String relativize(File root, File file) {
        String r = root.getAbsolutePath();
        String f = file.getAbsolutePath();
        if (f.startsWith(r)) {
            String s = f.substring(r.length());
            while (s.startsWith("/") || s.startsWith("\\")) s = s.substring(1);
            return s.replace('\\', '/');
        }
        return file.getName();
    }

    private static void findBundles(File dir, int depth, int maxDepth, List<File> out) {
        if (dir == null || depth > maxDepth || !dir.isDirectory()) return;
        File[] list = dir.listFiles();
        if (list == null) return;
        for (File f : list) {
            String n = f.getName();
            // 跳过本缓存、NIKKE 缓存与杂项目录，避免跨 mode 串包
            if (isCacheDirName(n)
                    || NikkeAbExtractor.isCacheDirName(n)
                    || "node_modules".equals(n) || ".git".equals(n) || ".venv-jczx".equals(n)) {
                continue;
            }
            if (f.isDirectory()) {
                // Never enter sibling game mode folders (cache lives at BD2Viewer parent)
                // ⚠️ **不加 depth>0 条件**：扫描根正好是 BD2Viewer 父目录时，第一层就要跳过兄弟游戏目录
                if (UnpackCacheHome.isOtherGameFolder(n, "jczx")) {
                    continue;
                }
                findBundles(f, depth + 1, maxDepth, out);
            } else if (f.isFile() && looksLikeJczxPack(f)) {
                out.add(f);
            }
        }
    }

    private static byte[] readAll(File f) throws IOException {
        long len = f.length();
        if (len > Integer.MAX_VALUE - 8) throw new IOException("file too large");
        byte[] buf = new byte[(int) len];
        try (FileInputStream in = new FileInputStream(f)) {
            int off = 0;
            while (off < buf.length) {
                int n = in.read(buf, off, buf.length - off);
                if (n < 0) break;
                off += n;
            }
            if (off != buf.length) throw new IOException("short read");
        }
        return buf;
    }

    private static String readText(File f) throws IOException {
        return new String(readAll(f), StandardCharsets.UTF_8);
    }

    private static void writeText(File f, String s) throws IOException {
        writeBytes(f, s.getBytes(StandardCharsets.UTF_8));
    }

    private static void writeBytes(File f, byte[] b) throws IOException {
        File p = f.getParentFile();
        if (p != null && !p.exists() && !p.mkdirs()) throw new IOException("mkdir " + p);
        try (FileOutputStream os = new FileOutputStream(f)) {
            os.write(b);
        }
    }


    /**
     * 源目录被删时清掉对应 bd2viewer-jczx/<hash>_* 缓存。
     * relDir 本身在缓存内则跳过。
     */
    public static List<String> clearCacheForDeletedDir(File root, String relDir) {
        List<String> cleared = new ArrayList<>();
        if (root == null || relDir == null) return cleared;
        String rel = relDir.replace('\\', '/');
        while (rel.startsWith("/")) rel = rel.substring(1);
        while (rel.endsWith("/")) rel = rel.substring(0, rel.length() - 1);
        if (rel.isEmpty() || isCacheRel(rel)) return cleared;
        Set<File> targets = new HashSet<>();
        File src = new File(root, rel);
        collectJczxCacheTargets(root, src, rel, targets);
        // 前缀匹配缓存目录名里的 key
        File cacheRoot = new File(root, CACHE_DIRNAME);
        String needle = rel.replace("/", "__");
        File[] kids = cacheRoot.isDirectory() ? cacheRoot.listFiles() : null;
        if (kids != null) {
            for (File k : kids) {
                if (!k.isDirectory()) continue;
                String name = k.getName();
                int us = name.indexOf('_');
                String key = us >= 0 ? name.substring(us + 1) : name;
                if (key.equals(needle) || key.startsWith(needle + "__") || key.startsWith(needle + "_")) {
                    targets.add(k);
                }
            }
        }
        for (File abs : targets) {
            deleteRec(abs);
            String r = relativize(root, abs);
            cleared.add(r.replace('\\', '/'));
        }
        return cleared;
    }

    private static void collectJczxCacheTargets(File root, File node, String rel, Set<File> targets) {
        if (node == null || !node.exists()) return;
        try {
            if (node.isFile()) {
                if (isLikelyBundleName(node.getName())) {
                    targets.add(cacheDirFor(root, node));
                }
                return;
            }
        } catch (Exception ignored) { return; }
        if (!node.isDirectory()) return;
        File[] kids = node.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            String n = k.getName();
            if (isCacheDirName(n) || NikkeAbExtractor.isCacheDirName(n)
                    || "node_modules".equals(n) || ".git".equals(n) || ".venv-jczx".equals(n)) continue;
            String rr = rel.isEmpty() ? n : rel + "/" + n;
            collectJczxCacheTargets(root, k, rr, targets);
        }
    }

    private static void deleteRec(File f) {
        if (f == null) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRec(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static int indexOf(byte[] hay, byte[] needle, int from) {
        outer:
        for (int i = from; i <= hay.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) continue outer;
            }
            return i;
        }
        return -1;
    }

    /** CLI for box / host JVM unit test (no Android). */
    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("Usage: JczxExtractor <srcAB> <outDir>");
            System.exit(2);
        }
        File src = new File(args[0]);
        File out = new File(args[1]);
        if (!out.exists() && !out.mkdirs()) throw new IOException("mkdir " + out);
        JSONObject report = extract(src, out);
        System.out.println(report.toString(2));
        System.exit(report.optBoolean("ok") ? 0 : 1);
    }
}
