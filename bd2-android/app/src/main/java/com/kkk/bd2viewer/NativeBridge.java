package com.kkk.bd2viewer;

import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/** 前端通过 window.BD2Native 调进来；结果用 evaluateJavascript 推回 window.__native。 */
public final class NativeBridge {
    private static final String TAG = "BD2Bridge";

    private final MainActivity act;
    private final Handler ui = new Handler(Looper.getMainLooper());

    NativeBridge(MainActivity act) {
        this.act = act;
    }

    /** 包私有：MainActivity 从权限设置页返回时用它通知页面刷新提示条 */
    void emit(String js) {
        ui.post(() -> {
            try {
                act.web().evaluateJavascript(js, null);
            } catch (Exception e) {
                Log.w(TAG, "emit failed: " + e.getMessage());
            }
        });
    }

    /** U+2028 / U+2029 在 JS 里是行终止符，会让字符串字面量断掉 */
    private static String jsSafe(String s) {
        return s.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }

    void emitRoots() {
        ui.post(() -> {
            List<ScanEngine.Root> roots = ScanEngine.roots(act);
            JSONArray arr = new JSONArray();
            for (ScanEngine.Root r : roots) arr.put(r.toJson());
            emit("window.__native&&window.__native.onRoots(" + jsSafe(arr.toString()) + ")");
        });
    }

    @JavascriptInterface
    public void requestRoots() {
        emitRoots();
    }

    @JavascriptInterface
    public String appVersion() {
        return BuildConfig.VERSION_NAME;
    }

    @JavascriptInterface
    public int appVersionCode() {
        return BuildConfig.VERSION_CODE;
    }

    /**
     * 扫描在后台线程跑，完成后只推元信息给 JS（几十字节）。
     * items 由 JS 用 scanPage 分页同步拉取 —— 一次性推几 MB 的 JSON 会把进程压崩。
     */
    @JavascriptInterface
    public void requestScan(final String rootId, final boolean force, final String mode) {
        new Thread(() -> {
            try {
                JSONObject data = ScanEngine.scan(act, rootId, force, mode);
                emit("window.__native&&window.__native.onScanMeta(" + jsSafe(data.toString()) + ")");
            } catch (Throwable t) {
                Log.e(TAG, "scan failed", t);
                emit("window.__native&&window.__native.onError(" +
                        JSONObject.quote("扫描失败：" + t.getMessage()) + ")");
            }
        }, "bd2-scan").start();
    }

    /** 同步分页取扫描结果；每页控制在几十条，避免超大字符串 */
    @JavascriptInterface
    public String scanPage(String rootId, int from, int count, String mode) {
        try {
            return ScanEngine.scanPage(rootId, from, count, mode);
        } catch (Throwable t) {
            Log.e(TAG, "scanPage failed", t);
            return "[]";
        }
    }

    @JavascriptInterface
    public int scanCount(String rootId, String mode) {
        try {
            return ScanEngine.scanCount(rootId, mode);
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 默认在读的目录绝对路径（外部 /sdcard/BD2Viewer 优先），给前端显示「文件放哪儿」 */
    @JavascriptInterface
    public String defaultPath() {
        try {
            return ScanEngine.primaryDir(act).getAbsolutePath();
        } catch (Throwable t) {
            return "";
        }
    }

    /** 把选中的文件写进默认目录（免数据线）。rel 里带子目录也可以 */
    @JavascriptInterface
    public boolean importFile(String rel, String base64) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            boolean ok = ScanEngine.writeImport(act, rel, bytes);
            if (ok) ScanEngine.scanPath(act, ScanEngine.primaryDir(act).getAbsolutePath());
            return ok;
        } catch (Throwable t) {
            Log.e(TAG, "importFile failed", t);
            return false;
        }
    }

    /**
     * 删除一整套资产（atlas + skeleton + 贴图）。**真正删磁盘文件，不可恢复**。
     * json: [{"relAtlas":"..","relSkeleton":"..","relImages":[".."]}]，全部相对 root。
     * 返回 {"ok":bool,"deleted":[relAtlas..],"failed":[{"relAtlas","reason"}],"error"?}
     */
    @JavascriptInterface
    public String deleteItems(String rootId, String json) {
        try {
            return ScanEngine.deleteItems(act, rootId, json);
        } catch (Throwable t) {
            Log.e(TAG, "deleteItems failed", t);
            // 原来是手工拼 JSON 并只用 replace("\"","'") 处理引号 —— 消息里一旦
            // 出现反斜杠或换行就会拼出非法 JSON，前端 JSON.parse 直接抛。
            // 交给 JSONObject 转义，别自己写。
            JSONObject o = new JSONObject();
            try {
                o.put("ok", false);
                o.put("deleted", new JSONArray());
                o.put("failed", new JSONArray());
                o.put("error", String.valueOf(t.getMessage()));
            } catch (Exception ignored) {
            }
            return o.toString();
        }
    }

    @JavascriptInterface
    public void requestAllFilesAccess() {
        ui.post(act::requestAllFilesAccess);
    }

    /** 用系统文件夹选择器授权一个目录（SAF），授权后直接读，不拷贝文件 */
    @JavascriptInterface
    public void pickFolder() {
        ui.post(act::pickFolder);
    }

    /**
     * 注意：@JavascriptInterface 的方法是被 JS 在「JavaBridge」后台线程上同步调用的，
     * 不是主线程。所以凡是碰 UI / 系统服务（剪贴板、Toast、startActivity）的，
     * 一律 ui.post 回主线程 —— 这里和 requestAllFilesAccess / pickFolder 保持一致。
     */
    @JavascriptInterface
    public void copyText(String text) {
        ui.post(() -> act.copyText(text));
    }

    /** 目录 + 权限诊断，页面上那句「文件放哪儿 / 为什么读不了」靠它 */
    @JavascriptInterface
    public String storageStatus() {
        try {
            return ScanEngine.storageStatus(act).toString();
        } catch (Throwable t) {
            Log.e(TAG, "storageStatus failed", t);
            return "{}";
        }
    }

    @JavascriptInterface
    public boolean hasAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager();
        }
        return true;
    }

    @JavascriptInterface
    public boolean saveBlob(String name, String base64) {
        return act.saveBlob(name, base64);
    }

    @JavascriptInterface
    public void toast(String msg) {
        act.toast(msg);
    }

    @JavascriptInterface
    public void setKeepScreenOn(boolean on) {
        act.keepScreenOn(on);
    }

    /** 进/出全屏：原生负责收起系统栏，并把音量键改道给页面切动画 */
    @JavascriptInterface
    public void setFullscreen(boolean on) {
        act.applyImmersive(on);
    }

    /** MainActivity 拦下音量键后走这里：+1 下一个动画，-1 上一个 */
    void onVolumeKey(int dir) {
        emit("window.__bd2viewer&&window.__bd2viewer.onVolumeKey&&window.__bd2viewer.onVolumeKey(" + dir + ")");
    }
}
