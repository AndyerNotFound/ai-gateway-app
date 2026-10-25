package com.aigateway.app.overlay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import androidx.core.content.ContextCompat

/** 系统事件监听: 零轮询、零权限、进程在就收（服务本身是前台服务） */
class EventWatch(private val ctx: Context, private val emit: (Ev) -> Unit) {

    private var started = false
    private var lastVol = -1

    private val rx = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            val it2 = i ?: return
            runCatching { onIntent(it2) }
        }
    }

    private fun onIntent(i: Intent) {
        when (i.action) {
            Intent.ACTION_BATTERY_CHANGED -> {
                val lvl = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                val sc = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1)
                val pct = if (lvl < 0) null else lvl * 100 / sc
                val st = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                val ch = st == BatteryManager.BATTERY_STATUS_CHARGING ||
                    st == BatteryManager.BATTERY_STATUS_FULL
                val raw = i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
                val temp = if (raw == Int.MIN_VALUE) null else raw / 10.0
                val on = when {
                    pct != null && ch && pct >= 100 -> "battery_full"
                    pct != null && pct<= 15 -> "battery_low"
                    else -> "battery"
                }
                emit(Ev(on, pct = pct, charging = ch, temp = temp))
            }
            Intent.ACTION_POWER_CONNECTED -> emit(Ev("charging", charging = true))
            Intent.ACTION_POWER_DISCONNECTED -> emit(Ev("discharging", charging = false))
            Intent.ACTION_SCREEN_ON -> emit(Ev("screen_on", screen = "on"))
            Intent.ACTION_SCREEN_OFF -> emit(Ev("screen_off", screen = "off"))
            Intent.ACTION_USER_PRESENT -> emit(Ev("unlock", screen = "on"))
            Intent.ACTION_HEADSET_PLUG -> {
                val st = i.getIntExtra("state", 0)
                emit(Ev(if (st == 1) "headset_in" else "headset_out"))
            }
            "android.net.conn.CONNECTIVITY_CHANGE" -> emit(Ev("network", ssid = netName()))
        }
    }

    private fun netName(): String = runCatching {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return "none"
        val n = cm.activeNetwork ?: return "none"
        val cap = cm.getNetworkCapabilities(n) ?: return "none"
        when {
            cap.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            cap.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile"
            cap.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }.getOrDefault("none")

    fun start() {
        if (started) return
        started = true
        val f = IntentFilter().apply {
            addAction(Intent.ACTION_BATTERY_CHANGED)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_HEADSET_PLUG)
            addAction("android.net.conn.CONNECTIVITY_CHANGE")
        }
        runCatching { ContextCompat.registerReceiver(ctx, rx, f, ContextCompat.RECEIVER_EXPORTED) }
            .onFailure {
                @Suppress("DEPRECATION")
                runCatching { ctx.registerReceiver(rx, f) }
            }
    }

    fun stop() {
        if (!started) return
        started = false
        runCatching { ctx.unregisterReceiver(rx) }
    }

    /** 音量变化没有广播, 由服务每 20s 采一次, 只在变化时发 */
    fun pollVolume(): Int? = runCatching {
        val am = ctx.getSystemService(AudioManager::class.java) ?: return null
        val v = am.getStreamVolume(AudioManager.STREAM_MUSIC)
        if (v == lastVol) null else v.also { lastVol = it; emit(Ev("vol", vol = it)) }
    }.getOrNull()
}
