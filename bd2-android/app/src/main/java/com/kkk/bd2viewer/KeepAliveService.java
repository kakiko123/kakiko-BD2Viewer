package com.kkk.bd2viewer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * 前台服务：回到桌面 / 切到别的 App 时进程不被系统杀掉，
 * WebView 里的动画和状态都还在，点通知或重新点图标直接回到原样。
 * Android 8+ 只有前台服务能长期驻留后台，所以用一条常驻低调通知换这个能力。
 */
public class KeepAliveService extends Service {
    /**
     * ⚠️ 渠道 id 带 `_v2`：通知渠道的**重要程度建好之后不能改**，
     * 早期版本用的是 IMPORTANCE_MIN（国产 ROM 会把这个级别的前台服务当空闲进程收掉），
     * 所以换策略必须**换 id**，否则老用户机器上还是旧的 MIN。（APK-fixes §3）
     */
    private static final String CHANNEL_ID = "bd2_keepalive_v2";
    private static final int NOTIF_ID = 1;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "后台运行",
                NotificationManager.IMPORTANCE_LOW);   // 不要用 IMPORTANCE_MIN
        ch.setDescription("保持 Kakiko Viewer 在后台继续运行");
        ch.setShowBadge(false);
        if (nm != null) nm.createNotificationChannel(ch);

        PendingIntent pi = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class)
                        .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification n = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(getString(R.string.app_name))
                .setContentText("正在后台运行，点按返回")
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
        goForeground(n);
    }

    /**
     * Android 14（API 34）必须用**三参数** startForeground。
     * 并且：启动后 5 秒内没成功调用 startForeground，系统会直接杀进程 ——
     * 所以 onCreate 里就要调，且外面必须套 try/catch(Throwable)。
     */
    private void goForeground(Notification n) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_ID, n,
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Throwable t) {
            System.err.println("[KeepAlive] startForeground 失败: " + t);
            t.printStackTrace();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 被系统重启（START_STICKY）时 intent 可能是 null，这里补一次前台化
        try {
            if (intent == null) {
                NotificationManager nm = getSystemService(NotificationManager.class);
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "后台运行",
                        NotificationManager.IMPORTANCE_LOW);
                if (nm != null) nm.createNotificationChannel(ch);
                Notification n = new Notification.Builder(this, CHANNEL_ID)
                        .setSmallIcon(android.R.drawable.ic_media_play)
                        .setContentTitle(getString(R.string.app_name))
                        .setContentText("正在后台运行，点按返回")
                        .setOngoing(true)
                        .build();
                goForeground(n);
            }
        } catch (Throwable t) {
            System.err.println("[KeepAlive] onStartCommand 前台化失败: " + t);
        }
        return START_STICKY;
    }

    /** 划掉最近任务后系统会回调这里：再前台化一次，别让进程就此降级被杀。 */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "后台运行",
                    NotificationManager.IMPORTANCE_LOW);
            if (nm != null) nm.createNotificationChannel(ch);
            PendingIntent pi = PendingIntent.getActivity(this, 0,
                    new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = new Notification.Builder(this, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentTitle(getString(R.string.app_name))
                    .setContentText("正在后台运行，点按返回")
                    .setOngoing(true)
                    .setContentIntent(pi)
                    .build();
            goForeground(n);
        } catch (Throwable t) {
            System.err.println("[KeepAlive] onTaskRemoved 前台化失败: " + t);
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
