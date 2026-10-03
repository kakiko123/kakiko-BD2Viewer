package com.kkk.bd2viewer;

import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 给扫描结果补两块**桌面 server.mjs 有、安卓此前完全没有**的数据：
 *
 *  ① `item.jczx` —— 层信息（`layerKind` / `layerLabel` / `targetKey` / `modId` / `targetId`）。
 *     没有它，前端的「形态 × mod 两级归组」（`buildJczxModChains`）整条不工作 ——
 *     手机端此前在 jczx 档只看得见解包缓存，图鉴包（角色/画册）被过滤掉就是这个原因。
 *     判层是**纯字符串**工作：认三种布局，见 {@link #layerOf}。
 *
 *  ② `item.ark` —— 角色元数据（中文名 / 稀有度 / 立绘 / **语音**）。
 *     语音清单只能**列目录**得到（Ark 的 meta.json 里没有语音字段），
 *     所以手机端此前一条 wav 都播不出来。
 *
 * 目录读取抽象成 {@link IO}：`file` 根走 java.io，SAF 根走 ContentResolver，
 * 上层逻辑只有一份。
 *
 * ⚠️ 与 server.mjs 的差异（有意）：整理树布局下 mod 目录名不带层号，
 * 桌面端会去读 9MB 的 `data/mod_runtime_index.json` 找回 mod1/mod2；
 * 手机端**不读那个大文件**（解析开销不值），退化成 `layerIndex=500` / 标签「mod」。
 */
final class PackMeta {

    private static final String TAG = "PackMeta";
    /** 与 server.mjs 一致：整理树布局下拿不到原层号时的兜底排序位。 */
    private static final int LAYER_UNKNOWN = 500;

    private PackMeta() { }

    /* ============================================================ 目录读取抽象 */

    interface IO {
        /** 读 `<root>/<rel>` 文本；失败返回 null。 */
        String readText(String rel);
        /** 列 `<root>/<rel>` 下的名字（文件+目录）；失败返回空表。 */
        List<String> listNames(String rel);
    }

    static IO fileIo(final String rootPath) {
        return new IO() {
            @Override public String readText(String rel) {
                File f = new File(rootPath, rel);
                if (!f.isFile()) return null;
                try (InputStream in = new FileInputStream(f)) {
                    return new String(readAll(in), "UTF-8");
                } catch (Exception e) {
                    return null;
                }
            }
            @Override public List<String> listNames(String rel) {
                File d = new File(rootPath, rel);
                File[] kids = d.listFiles();
                if (kids == null) return Collections.emptyList();
                List<String> out = new ArrayList<>(kids.length);
                for (File k : kids) out.add(k.getName());
                return out;
            }
        };
    }

    static IO safIo(final Context ctx, final Uri tree) {
        return new IO() {
            @Override public String readText(String rel) {
                try (InputStream in = ctx.getContentResolver()
                        .openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, docId(rel)))) {
                    return in == null ? null : new String(readAll(in), "UTF-8");
                } catch (Exception e) {
                    return null;
                }
            }
            @Override public List<String> listNames(String rel) {
                List<String> out = new ArrayList<>();
                try {
                    Uri dir = DocumentsContract.buildDocumentUriUsingTree(tree, docId(rel));
                    ContentResolver cr = ctx.getContentResolver();
                    Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(dir,
                            DocumentsContract.getDocumentId(dir));
                    String[] proj = {android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME};
                    try (android.database.Cursor c = cr.query(children, proj, null, null, null)) {
                        if (c != null) while (c.moveToNext()) out.add(c.getString(0));
                    }
                } catch (Exception e) {
                    Log.w(TAG, "listName saf: " + e.getMessage());
                }
                return out;
            }
            private String docId(String rel) {
                try {
                    String base = DocumentsContract.getTreeDocumentId(tree);
                    return rel == null || rel.isEmpty() ? base : base + "/" + rel;
                } catch (Exception e) {
                    return rel;
                }
            }
        };
    }

    /* ============================================================ ① 层判定 */

    /** `<10位hash>_mods__<类别>__<目标id>__mod-<id>__<bundle>`（我们自己的解包缓存） */
    private static final java.util.regex.Pattern CACHE_PKG =
            java.util.regex.Pattern.compile("^[0-9a-f]{10}_mods__([^_]+)__(.+)__(mod-[0-9a-z]{6,16})__(.+)$",
                    java.util.regex.Pattern.CASE_INSENSITIVE);
    /** 原布局的层目录：`source` / `mod1` / `mod2`… */
    private static final java.util.regex.Pattern LAYER_DIR =
            java.util.regex.Pattern.compile("^(source|mod\\d+)$", java.util.regex.Pattern.CASE_INSENSITIVE);
    private static final java.util.regex.Pattern MOD_ID =
            java.util.regex.Pattern.compile("^mod-([0-9a-z]{6,16})$", java.util.regex.Pattern.CASE_INSENSITIVE);
    /** 整理树：`<角色|画册>/<ID>__<中文名>/<槽位>/{原图|mod-…}/…` */
    private static final java.util.regex.Pattern TREE_CAT =
            java.util.regex.Pattern.compile("^(角色|画册)$");
    private static final java.util.regex.Pattern TREE_SLOT =
            java.util.regex.Pattern.compile("^(原图|mod-[0-9a-z]{6,16}(?:__.*)?)$",
                    java.util.regex.Pattern.CASE_INSENSITIVE);

    private static boolean isCacheDir(String name) {
        return name != null && (name.toLowerCase(Locale.ROOT).equals("bd2viewer-jczx")
                || name.toLowerCase(Locale.ROOT).equals(".bd2viewer-jczx"));
    }

    /**
     * 条目所在目录（相对根）→ 层信息；不属于任何已解包层返回 null。
     * 与 `server.mjs` 的 `jczxLayerOf()` 一一对应，认三种布局：
     *   ① `<layer>/<角色|画册>/<ID|cgN>/[mod-<id>/]runtime`（图鉴发布包原布局）
     *   ② `bd2viewer-jczx/<hash>_mods__…/`（解包缓存）
     *   ③ `<角色|画册>/<ID>__<名>/<槽位>/…`（整理树，2026-10-03 就地重组后的形状）
     */
    static JSONObject layerOf(String relDir) {
        if (relDir == null) return null;
        String rel = relDir.replace('\\', '/');
        while (rel.startsWith("/")) rel = rel.substring(1);
        while (rel.endsWith("/")) rel = rel.substring(0, rel.length() - 1);
        if (rel.isEmpty()) return null;
        String[] seg = rel.split("/");
        if (seg.length < 2) return null;

        JSONObject o = new JSONObject();
        try {
            // ③ 整理树
            if (TREE_CAT.matcher(seg[0]).matches()) {
                int slotIdx = -1;
                for (int i = 1; i < seg.length; i++) if (TREE_SLOT.matcher(seg[i]).matches()) { slotIdx = i; break; }
                if (slotIdx < 0) return null;                       // 还没走到槽位层，不算条目
                String slot = seg[slotIdx];
                boolean isSource = "原图".equals(slot);
                String modId = null;
                if (!isSource) {
                    String head = slot.contains("__") ? slot.substring(0, slot.indexOf("__")) : slot;
                    if (!MOD_ID.matcher(head).matches()) return null;
                    modId = head;
                }
                String idPart = seg[1].contains("__") ? seg[1].substring(0, seg[1].indexOf("__")) : seg[1];
                o.put("layer", isSource ? "source" : "mod");
                o.put("layerKind", isSource ? "source" : "mod");
                o.put("layerIndex", isSource ? 0 : LAYER_UNKNOWN);
                o.put("layerLabel", isSource ? "原图" : "mod");
                o.put("modId", modId == null ? JSONObject.NULL : modId);
                o.put("targetId", idPart);
                o.put("groupDir", seg[0]);
                o.put("fromCache", false);
                o.put("targetKey", idPart + "|" + idPart);          // 见下方 inflate()
                return o;
            }
            // ② 解包缓存
            if (isCacheDir(seg[0])) {
                java.util.regex.Matcher m = CACHE_PKG.matcher(seg.length > 1 ? seg[1] : "");
                if (!m.matches()) return null;
                o.put("layer", seg[0]);
                o.put("layerKind", "mod");
                o.put("layerIndex", 900);
                o.put("layerLabel", "mod");
                o.put("modId", m.group(3));
                o.put("targetId", m.group(2));
                o.put("groupDir", m.group(1));
                o.put("fromCache", true);
                o.put("targetKey", JSONObject.NULL);
                return o;
            }
            // ① 图鉴发布包原布局
            if (!LAYER_DIR.matcher(seg[0]).matches()) return null;
            String layer = seg[0];
            boolean source = layer.equalsIgnoreCase("source");
            String modId = null;
            if (!source) {
                for (int i = 1; i < seg.length; i++) if (MOD_ID.matcher(seg[i]).matches()) { modId = seg[i]; break; }
                if (modId == null) return null;                      // 只有层目录，没有 mod 包
            }
            String targetId = seg.length > 2 ? seg[2] : seg[1];
            o.put("layer", layer);
            o.put("layerKind", source ? "source" : "mod");
            int idx = 0;
            if (!source) {
                String digits = layer.replaceAll("\\D+", "");
                try { idx = digits.isEmpty() ? 0 : Integer.parseInt(digits); } catch (Exception ignore) { idx = 0; }
            }
            o.put("layerIndex", idx);
            o.put("layerLabel", source ? "原图" : layer);
            o.put("modId", modId == null ? JSONObject.NULL : modId);
            o.put("targetId", targetId);
            o.put("groupDir", seg[1]);
            o.put("fromCache", false);
            o.put("targetKey", JSONObject.NULL);
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    /** `targetKey` 与 `bundle` 要等知道条目的 bundle 名才能定 —— 由 enrich() 回调补上。 */
    static void fillTargetKey(JSONObject jczx, String targetId, String bundle, boolean fromCache) {
        if (jczx == null) return;
        try {
            if (fromCache) {
                jczx.put("targetKey", targetId + "|" + bundle);
            } else {
                jczx.put("targetKey", targetId + "|" + bundle);
            }
            jczx.put("bundle", bundle);
        } catch (Exception ignore) { }
    }

    /* ============================================================ ② 名字表 */

    /** 归一化：小写、去掉非字母数字（与 server.mjs 的 jczxNormName 一致）。 */
    static String normName(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    }

    /**
     * `data/biligame_character_catalog.json` 的 `nameEn → nameZh`。
     * 读不到就返回空表（不算错误，只是没有中文名）。
     */
    static Map<String, String> readNameTable(IO io) {
        Map<String, String> out = new HashMap<>();
        String raw = io.readText("data/biligame_character_catalog.json");
        if (raw == null) return out;
        try {
            JSONObject j = new JSONObject(raw);
            JSONArray arr = j.optJSONArray("characters");
            if (arr == null) return out;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject c = arr.optJSONObject(i);
                if (c == null) continue;
                String zh = c.optString("nameZh", "").trim();
                String en = c.optString("nameEn", "").trim();
                if (zh.isEmpty() || en.isEmpty()) continue;
                String k = normName(en);
                if (!k.isEmpty() && !out.containsKey(k)) out.put(k, zh);
            }
        } catch (Exception e) {
            Log.w(TAG, "readNameTable: " + e.getMessage());
        }
        return out;
    }

    /** bundle 名 → 皮肤代号：`prefabs_spine_10010_skin_alps03_spine` → `alps03` */
    static String skinCode(String bundle) {
        if (bundle == null) return "";
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("_skin_([a-z0-9]+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(bundle);
        if (m.find()) return m.group(1).toLowerCase(Locale.ROOT);
        String t = bundle.replaceFirst("(?i)^prefabs_spine_", "").replaceFirst("(?i)_spine$", "");
        return t.toLowerCase(Locale.ROOT);
    }

    /** 皮肤代号 → 中文名（先整串、再去掉尾部数字/字母再试）。 */
    static String zhForSkin(Map<String, String> table, String code) {
        if (table == null || table.isEmpty() || code == null || code.isEmpty()) return null;
        String hit = table.get(normName(code));
        if (hit != null) return hit;
        hit = table.get(normName(code.replaceAll("\\d.*$", "")));
        if (hit != null) return hit;
        // 尾部多一个字母（实测 `garnet03c`）→ 连字母一起剥
        hit = table.get(normName(code.replaceAll("[0-9][a-z]*$", "")));
        return hit;
    }

    /* ============================================================ ③ 角色元数据 */

    /** JSON 里取字符串，空/缺失返回 null（对齐 server 的 `typeof x === 'string' ? x : null`）。 */
    private static String optStr(JSONObject o, String k) {
        if (o == null || o.isNull(k)) return null;
        String s = o.optString(k, null);
        return s == null || s.isEmpty() ? null : s;
    }

    private static final java.util.regex.Pattern AUDIO_RE =
            java.util.regex.Pattern.compile("(?i)\\.(wav|mp3|ogg|m4a)$");

    /**
     * 读 `<charDirRel>/meta.json`，产出与 server.mjs 的 `readArkMeta()` **同形状**的对象。
     * 语音：先试整理树的 `<charDirRel>/voice/`，再试原布局的 `<charDirRel>/runtime/voice/`，
     *      递归最多 3 层（交错战线的语音是 `voice/<批次>/wav/<皮肤>/*.wav` 这种嵌套）。
     */
    static JSONObject readMeta(IO io, String charDirRel) {
        String raw = io.readText(charDirRel + "/meta.json");
        if (raw == null) return null;
        JSONObject j;
        try { j = new JSONObject(raw); } catch (Exception e) { return null; }
        JSONObject c = j.optJSONObject("character");
        JSONObject out = new JSONObject();
        try {
            if (c == null) {
                // 画册条目：没有 character 字段 → 仍要给出完整形状，否则条目层读 undefined
                String id = lastSeg(charDirRel).split("__")[0];
                out.put("hasCharacter", false);
                out.put("id", id);
                out.put("name", JSONObject.NULL);
                out.put("rarity", JSONObject.NULL);
                out.put("statics", new JSONArray());
                out.put("voices", new JSONArray());
                out.put("spineAssets", new JSONArray());
                out.put("carrierBundle", id);
                return out;
            }
            String nm = optStr(c, "name");
            // 占位名「未命名（Bxxx）」当没有名字
            if (nm != null && nm.startsWith("未命名")) nm = null;
            String id = optStr(c, "id");
            if (id == null) id = lastSeg(charDirRel).split("__")[0];

            JSONArray statics = new JSONArray();
            JSONArray sa = c.optJSONArray("staticAssets");
            if (sa != null) {
                for (int i = 0; i < sa.length(); i++) {
                    JSONObject s = sa.optJSONObject(i);
                    if (s == null) continue;
                    String file = optStr(s, "file");
                    if (file == null) continue;
                    JSONObject o = new JSONObject();
                    o.put("file", file);
                    o.put("kind", s.optString("kind", "other"));
                    String label = optStr(s, "label");
                    o.put("label", label == null ? lastSeg(file) : label);
                    o.put("width", s.optInt("width", 0));
                    o.put("height", s.optInt("height", 0));
                    statics.put(o);
                }
            }

            JSONArray spineAssets = new JSONArray();
            JSONArray sp = c.optJSONArray("spineAssets");
            if (sp != null) {
                for (int i = 0; i < sp.length(); i++) {
                    JSONObject a = sp.optJSONObject(i);
                    if (a == null) continue;
                    String bundle = optStr(a, "bundle");
                    if (bundle == null) continue;
                    JSONObject o = new JSONObject();
                    o.put("bundle", bundle);
                    JSONArray anims = a.optJSONArray("animations");
                    o.put("animations", anims == null ? new JSONArray() : anims);
                    String da = optStr(a, "defaultAnimation");
                    o.put("defaultAnimation", da == null ? JSONObject.NULL : da);
                    spineAssets.put(o);
                }
            }

            // 承载角色级立绘/语音的条目：本体（bundle == id）优先，否则第一条
            String carrier = null;
            for (int i = 0; i < spineAssets.length(); i++) {
                if (id.equals(spineAssets.optJSONObject(i).optString("bundle"))) { carrier = id; break; }
            }
            if (carrier == null && spineAssets.length() > 0) {
                carrier = spineAssets.optJSONObject(0).optString("bundle");
            }
            if (carrier == null) carrier = id;

            out.put("hasCharacter", true);
            out.put("id", id);
            out.put("name", nm == null ? JSONObject.NULL : nm);
            String alt = optStr(c, "altName");
            out.put("altName", alt == null ? JSONObject.NULL : alt);
            out.put("rarity", c.has("rarity") && !c.isNull("rarity") ? c.optInt("rarity") : JSONObject.NULL);
            out.put("statics", statics);
            out.put("voices", listVoices(io, charDirRel));
            out.put("spineAssets", spineAssets);
            out.put("carrierBundle", carrier);
        } catch (Exception e) {
            Log.w(TAG, "readMeta: " + e.getMessage());
        }
        return out;
    }

    /** 语音清单：试 `voice/` 与 `runtime/voice/`，递归 ≤3 层。`file` 是**相对角色目录**的路径。 */
    static JSONArray listVoices(IO io, String charDirRel) {
        JSONArray out = new JSONArray();
        for (String base : new String[]{"voice", "runtime/voice"}) {
            collectAudio(io, charDirRel + "/" + base, base, "", out, 0);
            if (out.length() > 0) break;
        }
        return out;
    }

    /**
     * @param base   命中的那个语音根（`voice` 或 `runtime/voice`）—— **必须算进 file**，
     *               否则前端拼出的 URL 会丢掉这一段（实测踩过：Ark 的 `file` 少 `runtime/voice/`
     *               → `<audio>` 404）。与 server.mjs 的 `'runtime/voice/' + name` 对齐。
     * @param subPath base 之下的子路径（交错战线的语音是嵌套的）
     */
    private static void collectAudio(IO io, String relDir, String base, String subPath,
                                     JSONArray out, int depth) {
        if (depth > 3 || out.length() > 2000) return;
        List<String> names = io.listNames(relDir);
        if (names.isEmpty()) return;
        List<String> sorted = new ArrayList<>(names);
        Collections.sort(sorted);
        for (String n : sorted) {
            if (n == null || n.isEmpty()) continue;
            if (AUDIO_RE.matcher(n).find()) {
                try {
                    JSONObject v = new JSONObject();
                    String mid = subPath.isEmpty() ? base : base + "/" + subPath;
                    v.put("file", mid + "/" + n);
                    v.put("name", voiceLabel(n));
                    out.put(v);
                } catch (Exception ignore) { }
            } else if (!n.contains(".")) {
                collectAudio(io, relDir + "/" + n, base,
                        subPath.isEmpty() ? n : subPath + "/" + n, out, depth + 1);
            }
        }
    }

    /** `H001_Death_H001_Death_-5214….wav` → 「Death」（与 server 的 arkVoiceLabel 一致）。 */
    static String voiceLabel(String fileName) {
        if (fileName == null) return "";
        String stem = fileName.replaceAll("(?i)\\.wav$", "");
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("^([A-Za-z]+\\d+)_([A-Za-z0-9]+)_").matcher(stem);
        if (m.find()) return m.group(2);
        String[] p = stem.split("_");
        return p.length >= 3 ? p[0] + "_" + p[1] + "_" + p[2] : stem;
    }

    /* ============================================================ 小工具 */

    private static String lastSeg(String rel) {
        if (rel == null) return "";
        String r = rel.replace('\\', '/');
        int i = r.lastIndexOf('/');
        return i >= 0 ? r.substring(i + 1) : r;
    }

    static String parentDir(String rel) {
        if (rel == null) return "";
        String r = rel.replace('\\', '/');
        int i = r.lastIndexOf('/');
        return i >= 0 ? r.substring(0, i) : "";
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    /** mod 层的排序位：整理树里拿不到原层号 → 500（与 server 的兜底一致）。 */
    static Map<String, Integer> emptyLayerMap() { return new LinkedHashMap<>(); }
}
