package com.kkk.bd2viewer;

import android.content.Context;
import android.content.res.AssetManager;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 把 https://bd2.local 下的所有请求都在本地消化掉：
 *   /            -> assets/web/index.html
 *   /app.js ...  -> assets/web/...
 *   /spine/<rootId>/<rel>  -> 从手机存储里读（SAF 或直读文件）
 * 全部同源，所以没有跨域问题，WebGL 贴图也能直接上传。
 */
public final class Host {
    public static final String HOSTNAME = "bd2.local";
    public static final String ORIGIN = "https://" + HOSTNAME;
    private static final String TAG = "BD2Host";

    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("htm", "text/html; charset=utf-8");
        MIME.put("js", "application/javascript; charset=utf-8");
        MIME.put("mjs", "application/javascript; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("atlas", "text/plain; charset=utf-8");
        MIME.put("skel", "application/octet-stream");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("gif", "image/gif");
        MIME.put("svg", "image/svg+xml");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("txt", "text/plain; charset=utf-8");
        MIME.put("webm", "video/webm");
        MIME.put("mp4", "video/mp4");
    }

    static String mimeOf(String path) {
        // Lost Sword 用 Unity TextAsset 导出：x.atlas.bytes(文本图集) / x.skel.bytes(二进制骨架)。
        // lastIndexOf('.') 只会看到最末的 "bytes"，按它判会全落到 octet-stream。
        // 这里按下标而不是文件尾匹配，避免 "atlas.bytes" 里那段被当成后缀。
        String lower = path.toLowerCase();
        if (lower.endsWith(".atlas.bytes")) return "text/plain; charset=utf-8";
        if (lower.endsWith(".skel.bytes")) return "application/octet-stream";
        int dot = path.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String ext = path.substring(dot + 1).toLowerCase();
        String m = MIME.get(ext);
        return m != null ? m : "application/octet-stream";
    }

    public static WebResourceResponse serve(Context ctx, WebResourceRequest req) {
        Uri uri = req.getUrl();
        if (uri == null || !HOSTNAME.equals(uri.getHost())) return null;
        String raw = uri.getPath() == null ? "/" : uri.getPath();

        if (raw.startsWith("/spine/")) {
            String rest = raw.substring("/spine/".length());
            int slash = rest.indexOf('/');
            if (slash < 0) return text(404, "bad spine path");
            String rootId = decode(rest.substring(0, slash));
            String rel = decode(rest.substring(slash + 1));
            return serveSpine(ctx, rootId, rel);
        }
        if (raw.startsWith("/api/")) {
            return json("{\"ok\":true,\"native\":true}");
        }
        return serveAsset(ctx, raw);
    }

    /** 同源请求不需要，但个别 WebView 版本对资源请求的检查更严，补上省事 */
    private static Map<String, String> corsHeaders() {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Access-Control-Allow-Headers", "*");
        h.put("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
        return h;
    }

    private static WebResourceResponse ok(String mime, InputStream in) {
        return new WebResourceResponse(mime, null, 200, "OK", corsHeaders(), in);
    }

    private static WebResourceResponse serveAsset(Context ctx, String path) {
        String p = path;
        if (p.equals("/") || p.isEmpty()) p = "/index.html";
        // 和 /spine/ 一样挡一下路径穿越。AssetManager.open 本身不会逃出 assets/，
        // 但没必要让它去解析 "web/../.." 这种路径，拒绝掉更明确。
        if (p.contains("..")) return text(403, "bad path");
        String assetPath = "web" + p;
        AssetManager am = ctx.getAssets();
        try {
            InputStream in = am.open(assetPath);
            return ok(mimeOf(assetPath), in);
        } catch (IOException e) {
            Log.w(TAG, "asset miss: " + assetPath);
            return text(404, "not found: " + p);
        }
    }

    private static WebResourceResponse serveSpine(Context ctx, String rootId, String rel) {
        if (rel == null) return text(404, "empty spine path");
        if (rel.contains("..") || rel.startsWith("/")) return text(403, "bad path");
        // Normalize: WebView / spine-player sometimes emit //, \, or ./ segments.
        String look = rel.replace('\\', '/');
        while (look.contains("//")) look = look.replace("//", "/");
        while (look.startsWith("./")) look = look.substring(2);
        if (look.startsWith("/")) look = look.substring(1);

        String alt = ScanEngine.altJczxCacheRel(look);
        ScanEngine.Doc doc = ScanEngine.find(rootId, look);
        if (doc == null && alt != null) doc = ScanEngine.find(rootId, alt);
        // Desktop parity: resolve from disk when DOCS miss (import / race / case)
        if (doc == null) doc = ScanEngine.resolveFile(rootId, look);
        if (doc == null && alt != null) doc = ScanEngine.resolveFile(rootId, alt);
        // Bare leaf (e.g. /spine/__public__/foo.png) after a bad rawDataURIs remap:
        // search DOCS / bd2viewer-jczx/* / leaf.
        if (doc == null) doc = ScanEngine.resolveLeaf(rootId, look);
        if (doc == null) {
            Log.w(TAG, "no doc for " + rootId + "/" + rel + " (look=" + look + ")");
            return text(404, "not scanned: " + rel);
        }
        try {
            InputStream in = ScanEngine.open(ctx, doc);
            if (in == null) return text(404, "cannot open: " + rel);
            // Prefer on-disk name for MIME when look was a bare leaf.
            String mimePath = doc.rel != null ? doc.rel : rel;
            return ok(mimeOf(mimePath), in);
        } catch (Exception e) {
            Log.w(TAG, "open failed " + rel + ": " + e.getMessage());
            return text(500, "open failed: " + e.getMessage());
        }
    }

    /**
     * 路径段的百分号解码。
     *
     * 注意**不能**用 URLDecoder：它是给 application/x-www-form-urlencoded 用的，
     * 会把「+」解成空格 —— 而 URL 路径里的「+」就是个普通字符。
     * 用户的贴图文件名里带「+」并不罕见（例如 xxx+diffuse.png），
     * 用 URLDecoder 就会变成 xxx diffuse.png，然后 404 且看不出原因。
     * 这里手写一遍，只处理 %XX。
     */
    private static String decode(String s) {
        if (s == null || s.indexOf('%') < 0) return s;
        StringBuilder out = new StringBuilder(s.length());
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%' && i + 2 < s.length()) {
                int hi = Character.digit(s.charAt(i + 1), 16);
                int lo = Character.digit(s.charAt(i + 2), 16);
                if (hi >= 0 && lo >= 0) {
                    bytes.write((hi << 4) + lo);
                    i += 2;
                    continue;
                }
            }
            // 遇到非转义字符：先把攒着的字节按 UTF-8 落下来
            if (bytes.size() > 0) {
                out.append(new String(bytes.toByteArray(), java.nio.charset.StandardCharsets.UTF_8));
                bytes.reset();
            }
            out.append(c);
        }
        if (bytes.size() > 0) {
            out.append(new String(bytes.toByteArray(), java.nio.charset.StandardCharsets.UTF_8));
        }
        return out.toString();
    }

    private static WebResourceResponse text(int code, String msg) {
        return new WebResourceResponse("text/plain", "utf-8", code, "Error",
                new HashMap<String, String>(), new ByteArrayInputStream(
                        msg.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private static WebResourceResponse json(String s) {
        // 声明的编码必须和实际写入的字节一致：原来这里用 s.getBytes()（跟随平台默认编码，
        // 中文 Windows 上是 GBK），却声明 utf-8 —— 一旦响应里出现非 ASCII 就会乱码。
        return new WebResourceResponse("application/json", "utf-8",
                new ByteArrayInputStream(s.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }
}
