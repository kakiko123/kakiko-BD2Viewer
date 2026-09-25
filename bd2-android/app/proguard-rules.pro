# ============================================================
#  R8 / ProGuard 规则
#
#  当前构建**没有**开启代码压缩（app/build.gradle 里 minifyEnabled false），
#  这个文件因此暂时不生效。放它在这里是为了：将来谁想开 R8 时，
#  下面这几条必须已经在，否则会在真机上炸得很隐蔽。
# ============================================================

# ------------------------------------------------------------
# 1. 给 WebView 注入的 JS 桥
# ------------------------------------------------------------
# NativeBridge 的每个方法都是靠 @JavascriptInterface 反射调用的，名字即协议：
# Java 侧叫 deleteItems，JS 侧就写 window.BD2Native.deleteItems。
# R8 会把「没有 Java 调用点」的公开方法当作死代码删掉 —— 而它们确实
# 全都没有 Java 调用点，于是会被全部抹掉，表现是：
#   App 起来看着一切正常，一点任何功能就静默失败（JS 侧 object has no method）。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.kkk.bd2viewer.NativeBridge { *; }

# ------------------------------------------------------------
# 2. 反射 / 序列化用到的类
# ------------------------------------------------------------
# MainActivity 用 Thread.setDefaultUncaughtExceptionHandler 落崩溃栈，
# 异常类名会进到日志与 SharedPreferences 里，混淆后没法读。保留可读性。
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
-keepattributes Exceptions,InnerClasses,Signature,Deprecated,Annotation

# org.json 是本工程唯一用到的「反射敏感」库（Android 平台自带），
# 它的 JSONObject/JSONArray 不要被优化掉
-keep class org.json.** { *; }

# ------------------------------------------------------------
# 3. 资源与原生入口
# ------------------------------------------------------------
# Activity / Service 由清单按类名引用，AGP 默认规则已经保留；
# 这里再显式写一遍，免得将来换构建方式时被绕开。
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Service

# 方案 1：如果将来真的开启 R8，请把 app/build.gradle 里
#   release { minifyEnabled false }
# 改成 true，然后先跑一遍 _test 全量用例 —— 尤其是 native_mode.mjs，
# 它覆盖的就是 JS 桥那条通路。
