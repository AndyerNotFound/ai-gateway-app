package com.aigateway.app.overlay

import android.app.Notification
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/** 通知监听。需要在系统设置里手动勾选授权, 否则不会收到任何回调 */
class NotifHook : NotificationListenerService() {

    private val seen = HashMap<String, Long>()

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val n = sbn ?: return
        if (n.packageName == packageName) return   // 自己发的 notify 不再回灌, 否则会自激
        val now = SystemClock.elapsedRealtime()
        val key = n.key ?: (n.packageName + "#" + n.id)
        val prev = seen[key]
        if (prev != null && now - prev < 3000) return
        seen[key] = now
        if (seen.size > 200) seen.clear()
        val ex = n.notification?.extras ?: return
        val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = ex.getCharSequence(Notification.EXTRA_TEXT)?.toString()
            ?: ex.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
        EventHub.emit(
            Ev(
                on = "notif",
                pkg = n.packageName,
                title = title.take(60),
                text = text.take(160),
                src = "notif"
            )
        )
    }
}
