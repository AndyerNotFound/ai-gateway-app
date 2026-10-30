package com.aigateway.app.data

import com.google.gson.JsonObject

/**
 * 余额返回的统一解析: 网关可能给 amounts(多币种) 或单个 balance。
 * 预警级别与 balance-float 同口径: <阈值 见底(2), <阈值×3 偏低(1)。
 */
object BalanceUtil {

    data class Item(val unit: String, val value: String) {
        val text: String get() = if (unit.isBlank()) value else "$value $unit"
        val amount: Double? get() = value.toDoubleOrNull()
    }

    fun parse(j: JsonObject): List<Item> {
        val arr = j.get("amounts")?.takeIf { it.isJsonArray }?.asJsonArray
        if (arr != null) {
            val out = ArrayList<Item>()
            for (e in arr) {
                val o = e.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                val v = o.get("value")?.takeIf { !it.isJsonNull }?.asString?.trim().orEmpty()
                if (v.isBlank()) continue
                out += Item(o.get("unit")?.takeIf { !it.isJsonNull }?.asString.orEmpty(), v)
            }
            if (out.isNotEmpty()) return out
        }
        val v = j.get("balance")?.takeIf { !it.isJsonNull }?.asString?.trim().orEmpty()
        if (v.isBlank() || v == "-") return emptyList()
        return listOf(Item(j.get("unit")?.takeIf { !it.isJsonNull }?.asString.orEmpty(), v))
    }

    /**
     * 渠道级阈值。warn 形如 "5"(所有币种) 或 "CNY=5,USD=1"(逐币种)。
     * 逐币种表里没列的币种 -> 不预警(0), 不退回全局值: 否则另一种币种的 0.00 会一直红。
     */
    fun threshold(warn: String?, unit: String, fallback: Double): Double {
        val t = warn?.trim().orEmpty()
        if (t.isEmpty()) return fallback
        t.toDoubleOrNull()?.let { return it }
        val map = HashMap<String, Double>()
        Regex("([A-Za-z]{2,8})\\s*[=:]\\s*([0-9]*\\.?[0-9]+)").findAll(t).forEach { m ->
            val v = m.groupValues[2].toDoubleOrNull()
            if (v != null) map[m.groupValues[1].uppercase()] = v
        }
        if (map.isEmpty()) return fallback
        val u = unit.trim().uppercase()
        return map[u] ?: map["*"] ?: 0.0
    }

    /** 带渠道配置的判定; warn 为空时用全局默认阈值 */
    fun level(value: String, unit: String, warn: String?, fallback: Double): Int =
        level(value, threshold(warn, unit, fallback))

    fun level(value: String, warnBelow: Double): Int {
        if (warnBelow <= 0.0) return 0
        val a = value.toDoubleOrNull() ?: return 0
        return when {
            a <= 0.0 -> 2
            a < warnBelow -> 2
            a < warnBelow * 3 -> 1
            else -> 0
        }
    }
}
