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
import java.util.List;
import java.util.Locale;
import java.util.Map;
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
        return r.contains(CACHE_DIRNAME + "/") || r.startsWith(CACHE_DIRNAME)
                || r.contains(CACHE_DIRNAME_LEGACY + "/") || r.startsWith(CACHE_DIRNAME_LEGACY);
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
        if (name.regionMatches(true, 0, "prefabs_spine_", 0, "prefabs_spine_".length())) return true;
        if (l.endsWith(".ab") || l.endsWith(".unity3d") || l.endsWith(".bundle") || l.endsWith(".assets")) return true;
        return !name.contains(".");
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

    /** Scan root for UnityFS bundles (skip cache), extract/cached, return meta for toasts. */
    public static JSONObject prepareRoot(File root) {
        JSONObject meta = new JSONObject();
        JSONArray extracted = new JSONArray();
        JSONArray reused = new JSONArray();
        JSONArray errors = new JSONArray();
        List<File> bundles = new ArrayList<>();
        try {
            migrateLegacyCache(root);
            findBundles(root, 0, 5, bundles);
            meta.put("bundles", bundles.size());
            for (File ab : bundles) {
                try {
                    Result r = ensureExtracted(ab, root);
                    JSONObject one = new JSONObject();
                    one.put("src", ab.getAbsolutePath());
                    one.put("cacheDir", r.cacheDir.getAbsolutePath());
                    one.put("spine", r.spineVer == null ? JSONObject.NULL : r.spineVer);
                    if (r.reused) reused.put(one);
                    else extracted.put(one);
                } catch (Exception e) {
                    JSONObject err = new JSONObject();
                    err.put("src", ab.getAbsolutePath());
                    err.put("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
                    errors.put(err);
                }
            }
            meta.put("extracted", extracted);
            meta.put("reused", reused);
            meta.put("errors", errors);
            meta.put("ok", errors.length() == 0);
        } catch (Exception e) {
            try {
                meta.put("bundles", bundles.size());
                meta.put("extracted", extracted);
                meta.put("reused", reused);
                errors.put(new JSONObject().put("src", JSONObject.NULL).put("error", String.valueOf(e.getMessage())));
                meta.put("errors", errors);
                meta.put("ok", false);
            } catch (Exception ignored) { /* */ }
        }
        return meta;
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
        writeText(stamp, stampObj.toString(2));
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

        // --- TextAsset: Spine JSON ---
        TextHit jsonHit = findSpineJson(cab.data);
        String baseName = null;
        if (jsonHit != null) {
            baseName = jsonHit.name != null ? jsonHit.name : "skeleton";
            for (String suf : new String[]{".skel", ".json", ".bytes", ".txt"}) {
                if (baseName.toLowerCase(Locale.ROOT).endsWith(suf)) {
                    baseName = baseName.substring(0, baseName.length() - suf.length());
                    break;
                }
            }
            String fname = baseName + ".json";
            writeBytes(new File(outDir, fname), jsonHit.bytes);
            JSONObject o = new JSONObject();
            o.put("kind", "json");
            o.put("name", fname);
            o.put("size", jsonHit.bytes.length);
            o.put("spine", jsonHit.spineVer == null ? JSONObject.NULL : jsonHit.spineVer);
            exported.put(o);
        } else {
            errors.put(new JSONObject().put("err", "no spine JSON TextAsset"));
        }

        // --- TextAsset: atlas ---
        TextHit atlasHit = findAtlas(cab.data, baseName);
        int texW = 0, texH = 0;
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
            if ("json".equals(k)) jsonOk = true;
            if ("png".equals(k)) pngOk = true;
        }
        summary.put("ok", atlasOk && jsonOk && pngOk);
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
            else if (n.endsWith(".png")) png = k;
        }
        if (atlas == null || png == null) return false;
        // Spine 4.2 JCZX assets are JSON TextAssets; .skel-only (esp. tiny) → re-extract.
        if (json == null) return false;
        if (json.length() < 64) return false;
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
            if (isCacheDirName(n) || "node_modules".equals(n) || ".git".equals(n) || ".venv-jczx".equals(n)) {
                continue;
            }
            if (f.isDirectory()) {
                findBundles(f, depth + 1, maxDepth, out);
            } else if (f.isFile() && isLikelyBundleName(n) && fileLooksLikeUnityFs(f)) {
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
