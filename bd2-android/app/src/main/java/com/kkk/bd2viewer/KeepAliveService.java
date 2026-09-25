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
    private static final String CHANNEL_ID = "bd2_keepalive";
    private static final int NOTIF_ID = 1;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "后台运行",
                NotificationManager.IMPORTANCE_MIN);
        ch.setDescription("保持 BD2Viewer 在后台继续运行");
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
        startForeground(NOTIF_ID, n);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
