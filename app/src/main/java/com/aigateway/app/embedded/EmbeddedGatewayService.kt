package com.aigateway.app.embedded

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.aigateway.app.MainActivity
import com.aigateway.app.R
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/**
 * 内置网关的前台服务，运行在独立进程 `:node`。
 *
 * nodejs-mobile 一个进程只能启动一次 Node，因此把运行时放进独立进程：
 * 停止服务即结束该进程，下次启动就是全新的 Node 实例。
 */
class EmbeddedGatewayService : Service() {

    companion object {
        const val ACTION_START = "com.aigateway.app.embedded.START"
        const val ACTION_STOP = "com.aigateway.app.embedded.STOP"
        private const val CHANNEL_ID = "embedded_gateway"
        private const val NOTIFICATION_ID = 4101
        private const val CRASH_GUARD_MS = 60_000L

        fun start(ctx: android.content.Context) {
            val i = Intent(ctx, EmbeddedGatewayService::class.java).setAction(ACTION_START)
            androidx.core.content.ContextCompat.startForegroundService(ctx, i)
        }

        fun stop(ctx: android.content.Context) {
            ctx.stopService(Intent(ctx, EmbeddedGatewayService::class.java))
        }

        /** nodejs-mobile 一个进程只能启动一次 Node；本标志在进程内生效。 */
        private val nodeStarted = java.util.concurrent.atomic.AtomicBoolean(false)
    }

    private val main = Handler(Looper.getMainLooper())
    @Volatile
    private var stopping = false

    private val crashGuardFile: File by lazy { File(filesDir, "embedded-last-exit") }

    override fun onCreate() {
        super.onCreate()
        stopping = false
        createChannel()
        startInForeground(getString(R.string.emb_notif_starting))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopping = true
                EmbeddedPaths.writeStatus(this, "stopped", EmbeddedPaths.portOf(this))
                stopSelf()
                // Immediate: a delayed kill would murder a service restarted moments later.
                android.os.Process.killProcess(android.os.Process.myPid())
                return START_NOT_STICKY
            }
        }
        if (intent == null && recentCrash()) {
            EmbeddedPaths.writeStatus(this, "error", EmbeddedPaths.portOf(this), getString(R.string.emb_err_crash_loop))
            stopSelf()
            return START_NOT_STICKY
        }
        launchNode()
        return START_STICKY
    }

    private fun recentCrash(): Boolean =
        crashGuardFile.exists() && System.currentTimeMillis() - crashGuardFile.lastModified() < CRASH_GUARD_MS

    private fun launchNode() {
        if (stopping) return
        // Repeated START (double tap / sticky restart) must never call node::Start twice.
        if (!Companion.nodeStarted.compareAndSet(false, true)) {
            waitUntilListening()
            return
        }
        val port = EmbeddedPaths.portOf(this)
        // Written synchronously *before* the worker starts, so a stale "error" can never abort the wait.
        EmbeddedPaths.writeStatus(this, "starting", port)
        val pageSize = NodeBridge.pageSize()
        if (pageSize != 4096) {
            fail(getString(R.string.emb_err_pagesize, pageSize))
            return
        }
        if (!NodeBridge.ensureLoaded()) {
            fail(getString(R.string.emb_err_load, NodeBridge.loadFailure().orEmpty()))
            return
        }

        Thread({
            try {
                EmbeddedPaths.installAssets(this)
                EmbeddedPaths.ensureDefaultConfig(this)
            } catch (t: Throwable) {
                fail(getString(R.string.emb_err_assets, t.message ?: ""))
                return@Thread
            }
            EmbeddedPaths.writeStatus(this, "starting", port)
            updateNotification(getString(R.string.emb_notif_starting))

            val script = EmbeddedPaths.mainScript(this)
            if (!script.exists()) {
                fail(getString(R.string.emb_err_assets, script.absolutePath))
                return@Thread
            }
            val rc = NodeBridge.nativeStart(arrayOf("node", script.absolutePath))
            if (!stopping) {
                crashGuardFile.writeText("exit=$rc")
                fail(getString(R.string.emb_err_exit, rc))
            }
        }, "agw-node").start()

        waitUntilListening()
    }

    private fun waitUntilListening() {
        val port = EmbeddedPaths.portOf(this)
        Thread({
            val deadline = System.currentTimeMillis() + 20_000
            while (System.currentTimeMillis() < deadline && !stopping) {
                if (EmbeddedPaths.readStatus(this).state == "error") return@Thread
                val ok = try {
                    Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 300) }
                    true
                } catch (_: Exception) {
                    false
                }
                if (ok) {
                    EmbeddedPaths.writeStatus(this, "running", port)
                    main.post { updateNotification(getString(R.string.emb_notif_running, port)) }
                    return@Thread
                }
                Thread.sleep(400)
            }
            if (!stopping && EmbeddedPaths.readStatus(this).state != "running") {
                fail(getString(R.string.emb_err_timeout, port))
            }
        }, "agw-ready").start()
    }

    private fun fail(message: String) {
        EmbeddedPaths.writeStatus(this, "error", EmbeddedPaths.portOf(this), message)
        main.post {
            updateNotification(message)
            main.postDelayed({ stopSelf() }, 1200)
        }
    }

    private fun startInForeground(text: String) {
        val n = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, EmbeddedGatewayService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_cloud)
            .setContentTitle(getString(R.string.emb_notif_title))
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, getString(R.string.emb_stop), stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.emb_notif_channel), NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
                description = getString(R.string.emb_notif_channel_desc)
            }
        )
    }

    override fun onDestroy() {
        stopping = true
        val st = EmbeddedPaths.readStatus(this)
        // Keep the failure text: the UI polls this file and "stopped" with an empty error hides the cause.
        if (st.state == "error") {
            EmbeddedPaths.writeStatus(this, "error", st.port, st.error)
        } else {
            EmbeddedPaths.writeStatus(this, "stopped", EmbeddedPaths.portOf(this))
        }
        super.onDestroy()
        // The service owns a dedicated process, so this kills only Node -- never the UI process.
        // No delay: a queued kill would murder a service the user restarts moments later.
        main.removeCallbacksAndMessages(null)
        android.os.Process.killProcess(android.os.Process.myPid())
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
