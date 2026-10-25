package com.aigateway.app.overlay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 外部事件入口（本机裸开, 靠动作白名单兜底）:
 *
 *   am broadcast -a com.aigateway.app.EVENT --es k cc_done --es text "编译完成 12s"
 *   am broadcast -a com.aigateway.app.EVENT --es k ssid --es ssid "HomeWiFi"
 *   am broadcast -a com.aigateway.app.EVENT --es k battery --ei pct 18 --ei vol 7
 */
class EventReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context?, i: Intent?) {
        val it2 = i ?: return
        val on = (it2.getStringExtra("k") ?: return).take(24)
        val ch = it2.getStringExtra("charging")?.toBooleanOrNull()
            ?: when (on) {
                "charging" -> true
                "discharging" -> false
                else -> null
            }
        EventHub.emit(
            Ev(
                on = on,
                charging = ch,
                pct = it2.getStringExtra("pct")?.toIntOrNull() ?: it2.getIntExtra("pct", -1).takeIf { it >= 0 },
                temp = it2.getStringExtra("temp")?.toDoubleOrNull(),
                vol = it2.getStringExtra("vol")?.toIntOrNull() ?: it2.getIntExtra("vol", -1).takeIf { it >= 0 },
                ssid = it2.getStringExtra("ssid")?.take(64),
                pkg = it2.getStringExtra("pkg")?.take(80),
                title = it2.getStringExtra("title")?.take(80),
                text = it2.getStringExtra("text")?.take(200),
                stamp = it2.getStringExtra("time")?.take(32),
                src = "ext"
            )
        )
    }

    private fun String.toBooleanOrNull(): Boolean? = when (lowercase()) {
        "true", "1", "yes" -> true
        "false", "0", "no" -> false
        else -> null
    }

    companion object {
        const val ACTION = "com.aigateway.app.EVENT"
    }
}
