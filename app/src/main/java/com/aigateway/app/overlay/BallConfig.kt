package com.aigateway.app.overlay

import com.aigateway.app.data.SettingsStore
import com.google.gson.JsonObject

/**
 * 服务端下发的悬浮球外观/文案（GET /admin/api/ball/<inst>）。
 *
 * 约定：
 *  - 只覆盖 look 里出现的键，没出现的保持本地设置（服务端可逐个放权）
 *  - hash 与上次相同直接返回 false：不写 SharedPreferences，不重绘
 *  - 颜色用 "#RRGGBB" / "#AARRGGBB" / 0（跟随主题）
 *  - 本地 UI 改动在服务端配置变化前不会被覆盖（hash 未变就不应用）
 */
object BallConfig {

    fun apply(s: SettingsStore, resp: JsonObject): Boolean {
        val look = resp.getAsJsonObject("look") ?: return false
        if (look.entrySet().isEmpty()) return false
        val hash = look.str("hash") ?: resp.str("hash") ?: look.toString()
        if (hash == s.ballCfgHash) return false

        look.i("sizeDp")?.let { s.overlaySizeDp = it }
        look.i("gaugeWidth")?.let { s.overlayGaugeWidth = it }
        look.i("panelDp")?.let { s.overlayPanelDp = it }
        look.i("shape")?.let { s.overlayShape = it }
        look.i("pill")?.let { s.overlayPill = it }
        look.i("chip")?.let { s.overlayChip = it }
        look.i("rowsMask")?.let { s.overlayRows = it }
        look.i("dimSec")?.let { s.overlayDimSec = it }
        look.i("dimAlpha")?.let { s.overlayDimAlpha = it }
        look.f("scale")?.let { s.overlayScale = it }
        look.d("balanceWarnBelow")?.let { s.balanceWarnBelow = it }
        look.color("gaugeColor")?.let { s.overlayGaugeColor = it }
        look.color("bg")?.let { s.overlayBg = it }
        look.str("rowsOrder")?.let { s.overlayRowsOrder = it }
        look.str("iconUri")?.let { s.overlayIconUri = it }
        look.b("snap")?.let { s.overlaySnap = it }
        look.b("dim")?.let { s.overlayDim = it }
        look.b("blur")?.let { s.overlayBlur = it }
        look.b("lock")?.let { s.overlayLock = it }
        look.b("balanceRow")?.let { s.overlayBalanceRow = it }
        look.b("pinExpanded")?.let { s.overlayPinExpanded = it }
        look.getAsJsonArray("phrases")?.let { arr ->
            s.ballPhrases = arr.mapNotNull { runCatching { it.asString }.getOrNull() }
                .filter { it.isNotBlank() }
        }

        s.ballCfgHash = hash
        return true
    }

    private fun JsonObject.i(k: String): Int? =
        runCatching { get(k)?.takeIf { !it.isJsonNull }?.asInt }.getOrNull()

    private fun JsonObject.f(k: String): Float? =
        runCatching { get(k)?.takeIf { !it.isJsonNull }?.asFloat }.getOrNull()

    private fun JsonObject.d(k: String): Double? =
        runCatching { get(k)?.takeIf { !it.isJsonNull }?.asDouble }.getOrNull()

    private fun JsonObject.b(k: String): Boolean? =
        runCatching { get(k)?.takeIf { !it.isJsonNull }?.asBoolean }.getOrNull()

    private fun JsonObject.str(k: String): String? =
        runCatching { get(k)?.takeIf { !it.isJsonNull }?.asString }.getOrNull()

    private fun JsonObject.color(k: String): Int? {
        val e = get(k)?.takeIf { !it.isJsonNull } ?: return null
        return runCatching {
            val p = e.asJsonPrimitive
            if (p.isNumber) p.asInt else parseColor(p.asString)
        }.getOrNull()
    }

    private fun parseColor(s: String): Int? {
        val t = s.trim()
        if (t.isEmpty() || t == "0") return 0
        val hex = t.removePrefix("#")
        return when (hex.length) {
            6 -> (0xFF000000L or hex.toLong(16)).toInt()
            8 -> hex.toLong(16).toInt()
            else -> null
        }
    }
}
