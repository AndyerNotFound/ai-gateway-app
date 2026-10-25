package com.aigateway.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.aigateway.app.App
import com.aigateway.app.MainActivity
import com.aigateway.app.R

/**
 * 前台服务 —— 保持内嵌网关在后台存活。
 *
 * 仅在「应用内运行」模式下需要: 内嵌 HTTP 服务器跑在 App 进程里,
 * 没有前台服务时进程可能被系统回收, 导致网关中断。
 */
class GatewayService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    companion object {
        const val CHANNEL_ID = "gateway_running"
        const val NOTIF_ID = 1001
        const val ACTION_STOP = "com.aigateway.app.STOP_SERVICE"
        private const val WAKELOCK_TAG = "AIGateway::GatewayService"

        fun start(context: Context) {
            val intent = Intent(context, GatewayService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, GatewayService::class.java))
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(NOTIF_ID, buildNotification())
        acquireWakeLock()
        return START_STICKY   // 被杀后尽量重启
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---------- 通知 ----------

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.svc_channel_name),
            NotificationManager.IMPORTANCE_LOW   // 无声音, 不打扰
        ).apply {
            description = getString(R.string.svc_channel_desc)
            setShowBadge(false)
        }
        nm.createNotificationChannel(ch)
    }

    private fun buildNotification(): Notification {
        val app = application as App
        val engine = app.embeddedEngineOrNull()
        val port = engine?.port() ?: 16384
        val chCount = engine?.getConfig()?.channels?.size ?: 0

        val openIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this, 1, Intent(this, GatewayService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_power)
            .setContentTitle(getString(R.string.svc_title))
            .setContentText(getString(R.string.svc_text, port, chCount))
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openIntent)
            .addAction(0, getString(R.string.stop), stopIntent)
            .build()
    }

    // ---------- WakeLock(部分唤醒, 仅保 CPU) ----------

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
            setReferenceCounted(false)
            runCatching { acquire() }
        }
    }

    private fun releaseWakeLock() {
        runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
        wakeLock = null
    }
}
