package com.aigateway.app.overlay

import android.os.SystemClock

/**
 * 一条事件。四种来源归一到这里：
 *   sys   系统广播（电量/充电/亮灭屏/解锁/耳机/网络）
 *   poll  定时采样（媒体音量）
 *   notif 通知监听（NotificationListenerService）
 *   ext   am broadcast com.aigateway.app.EVENT（脚本/Termux/网关）
 */
data class Ev(
    val on: String,
    val pct: Int? = null,
    val charging: Boolean? = null,
    val temp: Double? = null,
    val vol: Int? = null,
    val ssid: String? = null,
    val screen: String? = null,
    val pkg: String? = null,
    val title: String? = null,
    val text: String? = null,
    /** 外部消息的去重戳（noti 用） */
    val stamp: String? = null,
    val src: String = "sys",
    val at: Long = SystemClock.elapsedRealtime()
) {
    /** 规则 lt/gt 比的数值 */
    fun num(field: String): Double? = when (field) {
        "pct" -> pct?.toDouble()
        "temp" -> temp
        "vol" -> vol?.toDouble()
        "value" -> when (on) {
            "temp" -> temp
            "vol" -> vol?.toDouble()
            else -> pct?.toDouble()
        }
        else -> null
    }

    /** 可被 match 命中的文字面（SSID / 包名 / 标题 / 正文 / 屏幕态） */
    fun hay(): String = listOfNotNull(ssid, pkg, title, text, screen).joinToString(" ")
}

/** 进程内事件总线。服务没跑时 sink 为空, 事件直接丢弃（不排队, 免得醒来一次打一堆过期动作） */
object EventHub {
    @Volatile var sink: ((Ev) -> Unit)? = null
    @Volatile var last: Ev? = null

    fun emit(e: Ev) {
        last = e
        runCatching { sink?.invoke(e) }
    }
}
