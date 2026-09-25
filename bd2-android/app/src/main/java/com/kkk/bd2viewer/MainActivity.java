package com.kkk.bd2viewer;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final String TAG = "BD2Main";
    private static final int REQ_PICK_FILES = 1002;
    private static final int REQ_PICK_FOLDER = 1001;
    private static final int REQ_STORAGE_PERM = 1003;

    /**
     * 返回键先交给页面按层次消化（见 onBackPressed）。
     * 三层兜底，任何一层缺失都退化成 legacyBack()：
     *   · __bd2viewer 还没挂上（页面还在加载）
     *   · handleBack 抛异常
     *   · handleBack 返回 false（已经在最外层，确实该退 App 了）
     */
    private static final String JS_BACK =
            "(function(){try{var v=window.__bd2viewer;"
            + "return (v&&v.handleBack)?(v.handleBack()?'true':'false'):'none'}"
            + "catch(e){return 'error'}})()";

    private WebView web;
    private NativeBridge bridge;
    private android.webkit.ValueCallback<Uri[]> fileCallback;
    /** 全屏（沉浸）模式：系统栏收起，音量键改用来切换动画 */
    private volatile boolean immersive = false;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setTextZoom(100);
        // WebGL / canvas 需要硬件加速
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        // 只在调试包里允许 chrome://inspect 连上来排查。正式包一律关掉：
        // 开着的话，任何拿到设备的人都能通过 adb 读页面内容、执行任意 JS。
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        bridge = new NativeBridge(this);
        web.addJavascriptInterface(bridge, "BD2Native");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                try {
                    WebResourceResponse r = Host.serve(MainActivity.this, req);
                    if (r != null) return r;
                } catch (Throwable t) {
                    Log.w(TAG, "serve failed: " + t.getMessage());
                }
                return super.shouldInterceptRequest(v, req);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u != null && Host.HOSTNAME.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                // 页面里的 console 输出量不小（缩略图队列、扫描进度），
                // 正式包不往 logcat 里灌，需要时用调试包抓。
                if (BuildConfig.DEBUG) {
                    Log.d("BD2JS", m.sourceId() + ":" + m.lineNumber() + "  " + m.message());
                }
                return true;
            }

            // 「上传文件」按钮走 <input type=file>，WebView 必须自己拉起选择器
            @Override
            public boolean onShowFileChooser(WebView v, android.webkit.ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                fileCallback = cb;
                try {
                    Intent i = params.createIntent();
                    startActivityForResult(i, REQ_PICK_FILES);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    cb.onReceiveValue(null);
                    toast("打不开文件选择器");
                    return false;
                }
            }
        });

        // 崩溃兜底：把栈存下来，下次启动直接显示在页面上。
        // 没有这个的话「选完文件夹就闪退」只能靠猜。
        final Thread.UncaughtExceptionHandler sysHandler =
                Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            Log.e(TAG, "未捕获异常", e);
            saveCrash(e);
            if (sysHandler != null) sysHandler.uncaughtException(t, e);
        });

        // 主文档不走拦截：直接把单文件 HTML 喂给 WebView。
        // 之前用 loadUrl("https://bd2.local/index.html") + shouldInterceptRequest，
        // 一旦拦截链路在某个 WebView 版本上不生效，主文档就丢了 Content-Type，
        // 被当成纯文本渲染 —— 表现就是打开后满屏源码。
        // 现在 CSS/JS 全部内联进 app.bundle.html，零子资源请求，
        // base URL 仍然是 https://bd2.local，/spine/ 数据文件继续走拦截（同源，WebGL 可用）。
        // 基础存储权限（媒体类）。公共目录的非媒体文件（.json/.atlas/.skel）
        // 光有这个不够，还得开「所有文件访问权限」，UI 上有对应引导。
        requestStoragePermissions();
        ScanEngine.ensureDefaults(this);
        loadBundle();

        // 前台服务保活：回桌面 / 切别的 App 时进程不被杀，动画继续
        try {
            startForegroundService(new Intent(this, KeepAliveService.class));
        } catch (Throwable t) {
            Log.w(TAG, "start keep-alive failed: " + t.getMessage());
        }

        // 启动自检：脚本没跑起来时给个可见反馈，别让用户对着空白页猜
        new Handler(Looper.getMainLooper()).postDelayed(this::selfCheck, 4000);

        // 上次崩过就把栈显示出来，省得靠猜
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            String c = takeCrash();
            if (!c.isEmpty() && web != null) {
                web.evaluateJavascript(
                        "window.__native&&window.__native.onCrash(" +
                                org.json.JSONObject.quote(c) + ")", null);
            }
        }, 6000);
    }

    private void requestStoragePermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        java.util.List<String> need = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(android.Manifest.permission.READ_MEDIA_IMAGES)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED)
                need.add(android.Manifest.permission.READ_MEDIA_IMAGES);
            if (checkSelfPermission(android.Manifest.permission.READ_MEDIA_VIDEO)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED)
                need.add(android.Manifest.permission.READ_MEDIA_VIDEO);
            // 后台常驻通知：不授权的话服务照跑，只是通知条不显示
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED)
                need.add(android.Manifest.permission.POST_NOTIFICATIONS);
        } else if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
            if (checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED)
                need.add(android.Manifest.permission.READ_EXTERNAL_STORAGE);
        }
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), REQ_STORAGE_PERM);
    }

    /**
     * 从「所有文件访问权限」设置页回来时，权限可能刚开：
     * 补建 /sdcard/BD2Viewer 并把新的目录列表推给页面，不用杀进程重开。
     */
    @Override
    protected void onResume() {
        super.onResume();
        if (bridge == null) return;
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            ScanEngine.ensureDefaults(this);
            bridge.emitRoots();
            bridge.emit("window.__native&&window.__native.onPermission&&window.__native.onPermission()");
        }, 500);
    }

    private void loadBundle() {
        String html = null;
        try (InputStream in = getAssets().open("web/app.bundle.html")) {
            html = readAll(in);
        } catch (Throwable t) {
            Log.e(TAG, "read bundle failed", t);
        }
        if (html == null || html.isEmpty()) {
            try (InputStream in = getAssets().open("web/index.html")) {
                html = readAll(in);
            } catch (Throwable t) {
                Log.e(TAG, "read index failed", t);
                html = "<html><body style='background:#0f1420;color:#ff9db0;font:14px system-ui'>"
                        + "资源缺失：web/app.bundle.html 与 web/index.html 都读不到</body></html>";
            }
        }
        web.loadDataWithBaseURL(Host.ORIGIN + "/", html, "text/html", "utf-8",
                Host.ORIGIN + "/index.html");
    }

    /** 把崩溃栈存下来，下次启动显示在页面上 */
    private void saveCrash(Throwable t) {
        try {
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            t.printStackTrace(pw);
            pw.flush();
            String s = sw.toString();
            if (s.length() > 3000) s = s.substring(0, 3000);
            getSharedPreferences("bd2viewer", Context.MODE_PRIVATE)
                    .edit().putString("lastCrash", s).apply();
        } catch (Throwable ignored) {
        }
    }

    /** 取走并清空崩溃记录，避免每次启动都弹 */
    String takeCrash() {
        try {
            SharedPreferences sp = getSharedPreferences("bd2viewer", Context.MODE_PRIVATE);
            String s = sp.getString("lastCrash", "");
            if (s != null && !s.isEmpty()) sp.edit().putString("lastCrash", "").apply();
            return s == null ? "" : s;
        } catch (Throwable e) {
            return "";
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    /** 页面脚本没就绪就报出来，省得用户只看到一片空白 */
    private void selfCheck() {
        if (web == null) return;
        web.evaluateJavascript(
                "(function(){return !!window.__bd2viewer && !!window.spine})()", v -> {
                    boolean ok = "true".equals(v);
                    Log.i(TAG, "selfCheck ready=" + ok + " raw=" + v);
                    if (!ok) {
                        toast("脚本未就绪，请查看屏幕顶部提示");
                        web.evaluateJavascript(
                                "(function(){var d=document.createElement('div');" +
                                        "d.style.cssText='position:fixed;left:0;right:0;top:0;padding:10px;" +
                                        "background:#5a1d2b;color:#ffd9e0;font:12px monospace;z-index:99999;" +
                                        "white-space:pre-wrap';" +
                                        "d.textContent='脚本未就绪：window.__bd2viewer='+!!window.__bd2viewer+" +
                                        "' window.spine='+!!window.spine;" +
                                        "document.body&&document.body.appendChild(d)})()", null);
                    }
                });
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        if (web != null) web.saveState(out);
        super.onSaveInstanceState(out);
    }

    /**
     * 返回键。宿主不再自己硬编码「先退全屏」，而是先问页面 —— 页面才知道
     * 此刻最上面压着哪一层：
     *     对话框 → 全屏文件侧栏 → 底部抽屉 → 批量选择 → 全屏 → 播放页回资产页
     * 页面把这次返回消化掉了就回 "true"，宿主什么都不做；
     * 回 "false"（已在最外层）/ 页面还没加载好 —— 一律走宿主自己的兜底。
     *
     * evaluateJavascript 的回调是异步的，所以这里必须立刻 return，
     * 让 onBackPressed 的同步语义由「页面回不回 true」决定，而不是靠等待。
     */
    @Override
    public void onBackPressed() {
        if (web != null) {
            web.evaluateJavascript(JS_BACK, value -> {
                String v = value == null ? "" : value.replace("\"", "").trim();
                if ("true".equals(v)) return;   // 页面已经消化了这次返回
                legacyBack();
            });
            return;
        }
        legacyBack();
    }

    /** 页面没接住返回键时的兜底（也是页面加载完成前的行为） */
    private void legacyBack() {
        // 全屏时先退全屏，别一按返回就把 App 关了
        if (immersive && bridge != null) {
            bridge.emit("window.__bd2viewer&&window.__bd2viewer.setFullscreen&&window.__bd2viewer.setFullscreen(false)");
            return;
        }
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);   // 退到桌面但不销毁：前台服务继续保活，回来还是原样
    }

    @Override
    protected void onDestroy() {
        stopService(new Intent(this, KeepAliveService.class));
        // WebView 持有整个渲染进程与 GPU 资源，Activity 真被销毁时必须显式释放，
        // 否则会连同 Context 一起泄漏（转屏不重建 Activity，所以这里只在真正退出时走到）。
        if (web != null) {
            try {
                web.destroy();
            } catch (Throwable t) {
                Log.w(TAG, "web destroy: " + t.getMessage());
            }
            web = null;
        }
        super.onDestroy();
    }

    /**
     * 全屏模式下把音量键吃掉，改用来切换动画。
     * 不 return true 的话系统会照常改音量，用户一边切动画一边弹音量条，很烦。
     */
    @Override
    public boolean onKeyDown(int keyCode, android.view.KeyEvent event) {
        if (immersive && (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP
                || keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (bridge != null) {
                bridge.onVolumeKey(keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP ? 1 : -1);
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, android.view.KeyEvent event) {
        if (immersive && (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP
                || keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN)) return true;
        return super.onKeyUp(keyCode, event);
    }

    /** 页面请求进/出全屏：收起系统栏 + 保持屏幕常亮
     * 注意别叫 setImmersive —— Activity 里已经有同签名的 public 方法 */
    void applyImmersive(boolean on) {
        immersive = on;
        runOnUiThread(() -> {
            applySystemBars(!on);
            if (web != null) web.setKeepScreenOn(on);
        });
    }

    private void applySystemBars(boolean show) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.view.WindowInsetsController c = getWindow().getInsetsController();
                getWindow().setDecorFitsSystemWindows(show);
                if (c != null) {
                    if (show) c.show(android.view.WindowInsets.Type.systemBars());
                    else c.hide(android.view.WindowInsets.Type.systemBars());
                }
            } else {
                View decor = getWindow().getDecorView();
                int hide = View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
                decor.setSystemUiVisibility(show ? View.SYSTEM_UI_FLAG_VISIBLE : hide);
            }
        } catch (Throwable t) {
            Log.w(TAG, "system bars: " + t.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_PICK_FILES) {
            if (fileCallback == null) return;
            Uri[] picked = null;
            try {
                picked = WebChromeClient.FileChooserParams.parseResult(res, data);
            } catch (Exception e) {
                Log.w(TAG, "parse file result: " + e.getMessage());
            }
            fileCallback.onReceiveValue(picked);
            fileCallback = null;
            return;
        }
        if (req == REQ_PICK_FOLDER) {
            if (res != RESULT_OK || data == null) return;
            Uri tree = data.getData();
            if (tree == null) return;
            String name = niceName(tree);
            ScanEngine.addSafRoot(this, tree, name);
            toast("已授权：" + name + "，去顶部下拉框选它");
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (bridge != null) bridge.emitRoots();
            }, 300);
        }
    }

    static String niceName(Uri tree) {
        try {
            String docId = DocumentsContract.getTreeDocumentId(tree);
            String tail = docId.contains("/") ? docId.substring(docId.lastIndexOf('/') + 1) : docId;
            tail = tail.replace("primary:", "");
            return tail.isEmpty() ? "已选文件夹" : tail;
        } catch (Exception e) {
            return "已选文件夹";
        }
    }

    /* ------------------------------------------------------------ 给 JS 的入口 */

    WebView web() {
        return web;
    }

    void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }

    void keepScreenOn(boolean on) {
        runOnUiThread(() -> {
            if (web != null) web.setKeepScreenOn(on);
        });
    }

    /**
     * 「所有文件访问权限」：Android 11+ 唯一的、能让 App 直接读手机存储根目录的开关。
     * 它是特殊权限，系统不允许 App 弹窗申请，只能把用户送到设置页。
     */
    void requestAllFilesAccess() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
                try {
                    Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                            Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                } catch (Exception e) {
                    // 部分 ROM 没有这个设置页，退回应用详情页
                    Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                }
            } else {
                toast("已具备全部文件访问权限");
            }
        } catch (Exception e) {
            toast("打不开权限设置：" + e.getMessage());
        }
    }

    /** 系统文件夹选择器：授权一个目录后直接读，不用把文件拷来拷去 */
    void pickFolder() {
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(Intent.createChooser(i, "选择放 Spine 文件的文件夹"), REQ_PICK_FOLDER);
        } catch (Exception e) {
            toast("打不开文件夹选择器：" + e.getMessage());
        }
    }

    /** 复制目录路径，方便粘贴到文件管理器 */
    void copyText(String text) {
        try {
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) { toast("复制失败"); return; }
            cm.setPrimaryClip(android.content.ClipData.newPlainText("BD2Viewer", text));
            toast("已复制：" + text);
        } catch (Exception e) {
            toast("复制失败：" + e.getMessage());
        }
    }

    /** 前端导出的 PNG / ZIP / WebM 落到 Downloads/BD2Viewer */
    boolean saveBlob(String name, String base64) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                cv.put(MediaStore.Downloads.MIME_TYPE, mimeOf(name));
                cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/BD2Viewer");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) return false;
                try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                    os.write(bytes);
                }
                return true;
            }
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "BD2Viewer");
            if (!dir.exists() && !dir.mkdirs()) return false;
            try (FileOutputStream os = new FileOutputStream(new File(dir, name))) {
                os.write(bytes);
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "saveBlob failed", e);
            return false;
        }
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".zip")) return "application/zip";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }
}
