package com.aigateway.app.overlay

import com.google.gson.JsonObject

/**
 * 事件规则表。两种组，同构、同一套条件，order 排序：
 *
 *   when_0  { "order":0, "on":"battery_low", "lt":20, "cooldown":600,
 *             "do":{"type":"bubble","text":"电量 {{event.pct}}%"} }        ← 一个动作
 *   chain_0 { "order":0, "on":"battery_low", "lt":20, "delay":2,
 *             "do":[{…},{…}] }                                            ← 多个动作，间隔 delay 秒
 *
 * 条件：on（* 通配）/ field（比哪个数，默认 value）/ lt / gt / eq / match（* 通配）
 */
object EventRules {

    data class Rule(
        val key: String,
        val order: Int,
        val on: String,
        val field: String,
        val lt: Double?,
        val gt: Double?,
        val eq: String?,
        val match: String?,
        val cooldownMs: Long,
        val delaySec: Int,
        val actions: List<JsonObject>,
        val label: String
    )

    fun parse(root: JsonObject?): List<Rule> {
        if (root == null) return emptyList()
        val j = root.getAsJsonObject("look") ?: root
        val out = ArrayList<Rule>()
        runCatching {
            j.entrySet().forEach { e ->
                if ((e.key.startsWith("when_") || e.key.startsWith("chain_")) && e.value.isJsonObject) {
                    rule(e.key, e.value.asJsonObject, 99)?.let { out += it }
                }
            }
        }
        runCatching {
            j.getAsJsonArray("when")?.forEachIndexed { i, el ->
                val o = el?.takeIf { it.isJsonObject }?.asJsonObject ?: return@forEachIndexed
                rule("when[$i]", o, i)?.let { out += it }
            }
        }
        return out.sortedWith(compareBy({ it.order }, { it.key }))
    }

    private fun rule(key: String, o: JsonObject, defOrder: Int): Rule? {
        val on = str(o, "on") ?: return null
        val doEl = o.get("do") ?: return null
        val acts = when {
            doEl.isJsonArray -> doEl.asJsonArray.mapNotNull { it as? JsonObject }
            doEl.isJsonObject -> listOf(doEl.asJsonObject)
            else -> emptyList()
        }
        if (acts.isEmpty()) return null
        return Rule(
            key = key,
            order = (num(o, "order") ?: defOrder.toDouble()).toInt(),
            on = on,
            field = str(o, "field") ?: "value",
            lt = num(o, "lt"),
            gt = num(o, "gt"),
            eq = str(o, "eq"),
            match = str(o, "match"),
            cooldownMs = ((num(o, "cooldown") ?: 30.0).coerceIn(0.0, 86400.0) * 1000).toLong(),
            delaySec = (num(o, "delay") ?: 0.0).coerceIn(0.0, 60.0).toInt(),
            actions = acts,
            label = str(o, "label") ?: key
        )
    }

    fun match(r: Rule, e: Ev): Boolean {
        if (r.on != "*" && !r.on.equals(e.on, true)) return false
        r.eq?.let { q ->
            val hit = when {
                e.charging != null && (q == "true" || q == "false") -> e.charging.toString() == q
                else -> e.hay().contains(q, true)
            }
            if (!hit) return false
        }
        r.match?.let { if (!glob(it, e.hay())) return false }
        val v = e.num(r.field)
        if (r.lt != null && (v == null || v >= r.lt)) return false
        if (r.gt != null && (v == null || v<= r.gt)) return false
        return true
    }

    /** 子串命中；带 * 时按通配 */
    private fun glob(pat: String, hay: String): Boolean {
        if (pat.isEmpty()) return true
        if (!pat.contains('*')) return hay.contains(pat, true)
        val re = pat.split('*').joinToString(".*") { Regex.escape(it) }
        return runCatching { Regex(re, RegexOption.IGNORE_CASE).containsMatchIn(hay) }.getOrDefault(false)
    }

    private val TPL = Regex("""\{\{event\.(\w+)\}\}""")

    fun render(tpl: String, e: Ev?): String {
        if (tpl.isEmpty() || e == null || !tpl.contains("{{event.")) return tpl
        return TPL.replace(tpl) { m ->
            when (m.groupValues[1]) {
                "pct" -> e.pct?.toString() ?: "-"
                "temp" -> e.temp?.let { String.format("%.1f", it) } ?: "-"
                "vol" -> e.vol?.toString() ?: "-"
                "charging" -> e.charging?.let { if (it) "充电中" else "未充电" } ?: "-"
                "ssid" -> e.ssid ?: "-"
                "screen" -> e.screen ?: "-"
                "pkg" -> e.pkg ?: "-"
                "title" -> e.title ?: ""
                "text" -> e.text ?: ""
                "on" -> e.on
                else -> ""
            }
        }
    }

    private fun str(o: JsonObject, k: String): String? =
        runCatching { o.get(k)?.takeIf { it.isJsonPrimitive }?.asString }.getOrNull()

    private fun num(o: JsonObject, k: String): Double? =
        runCatching { o.get(k)?.takeIf { it.isJsonPrimitive }?.asDouble }.getOrNull()
}
