package com.aigateway.app.overlay

import com.google.gson.JsonObject

/**
 * 悬浮球界面描述。全部是「一组一条」的扁平键，order 排序：
 *
 *  ring_0   { "order":0, "data":"ctxSoft", "color":"warn" }          环
 *  content_0{ "order":0, "label":"实例", "data":"inst", "text":"…" }  面板行
 *  radial_0 { "order":0, "label":"刷新", "do":{"type":"reload"} }     按钮环
 *  touch_0  { "order":0, "on":"click", "do":{"type":"expand"} }       手势
 *  when_0   { "order":0, "on":"battery_low", "lt":20, "do":{…} }      事件规则
 *  chain_0  { "order":0, "on":"battery_low", "do":[{…},{…}], "delay":2 }
 *  perform  { "zoom":1.0, "alpha":100, … }
 *  bubble   { "order":0, "data":"ctxPct", "text":"…" }
 *  radial   { "radius":78 }
 *  noti     { "name":"网关", "text":"…", "time":"…", "silence":1 }
 *
 * 旧格式 rings[] / rows[] / on{} / thing{} / radial.items[] 已移除。
 */
object BallUi {

    data class RingSpec(val from: String?, val value: Float?, val max: Float?, val color: String)
    data class RowSpec(val key: String, val label: String, val value: String)
    data class RadialItem(val label: String, val action: JsonObject?)

    data class Ui(
        val rings: List<RingSpec> = emptyList(),
        val bars: Boolean = false,
        val ringSide: Int = 1,
        val strokeDp: Float? = null,
        val gapDp: Float? = null,
        val rows: List<RowSpec> = emptyList(),
        val bubbleRules: List<Pair<String, String>> = emptyList(),
        val bubbleTexts: List<String> = emptyList(),
        val onTap: JsonObject? = null,
        val onDouble: JsonObject? = null,
        val onLong: JsonObject? = null,
        val longHoldMs: Int = 420,
        val radialRadiusDp: Int = 78,
        val radialItems: List<RadialItem> = emptyList(),
        val zoom: Float = 1f,
        val alpha: Float = 1f,
        val rollSec: Int = 0,
        val sideSec: Int = 0,
        val darkSec: Int = 0,
        val lock: Boolean? = null,
        val icon: String? = null,
        val noti: Noti? = null
    ) {
        val hasRings: Boolean get() = rings.isNotEmpty()
        val hasRows: Boolean get() = rows.isNotEmpty()
    }

    /** noti 组: 发一条系统消息。time 只用于去重, 不显示 */
    data class Noti(val name: String, val text: String, val time: String, val silence: Boolean)

    fun parse(root: JsonObject?): Ui {
        if (root == null) return Ui()
        val j = root.getAsJsonObject("look") ?: root
        val style = j.getAsJsonObject("ringStyle")
        val perform = j.getAsJsonObject("perform")
        val bubble = j.getAsJsonObject("bubble")
        val radial = j.getAsJsonObject("radial")
        val notiObj = j.getAsJsonObject("noti")

        fun groups(prefix: String): List<JsonObject> = j.entrySet()
            .filter { it.key.startsWith(prefix) && it.value.isJsonObject }
            .sortedBy { it.value.asJsonObject.num("order") ?: 99f }
            .map { it.value.asJsonObject }

        val rings = groups("ring_").map {
            RingSpec(
                from = it.str("data") ?: "", value = it.num("value"), max = it.num("max"),
                color = it.str("color") ?: "primary"
            )
        }

        val rows = j.entrySet()
            .filter { it.key.startsWith("content_") && it.value.isJsonObject }
            .sortedBy { it.value.asJsonObject.num("order") ?: 99f }
            .map { (name, v) ->
                val g = v.asJsonObject
                val label = g.str("label") ?: g.str("data") ?: name
                val text = g.get("text")?.let { if (it.isJsonArray) SduiText.join(it.asJsonArray) else it.asString }
                RowSpec(
                    key = name, label = label,
                    value = text ?: ("{{state." + (g.str("data") ?: "") + "}}")
                )
            }

        val bubbleTexts = bubble?.get("text")?.let {
            when {
                it.isJsonArray -> it.asJsonArray.mapNotNull { e -> if (e.isJsonPrimitive) e.asString else null }
                it.isJsonPrimitive -> listOf(it.asString)
                else -> emptyList()
            }
        } ?: emptyList()

        val touches = groups("touch_")
        fun touch(name: String): JsonObject? =
            touches.firstOrNull { it.str("on")?.equals(name, true) == true }?.get("do")?.asAction()

        val radials = groups("radial_").mapNotNull { g ->
            val label = g.str("label") ?: return@mapNotNull null
            RadialItem(label, g.get("do")?.asAction())
        }

        return Ui(
            rings = rings,
            bars = (style?.str("mode") ?: "ring") == "bars",
            ringSide = if (style?.str("side") == "left") -1 else 1,
            strokeDp = style?.num("stroke"),
            gapDp = style?.num("gap"),
            rows = rows,
            bubbleTexts = bubbleTexts,
            onTap = touch("click"),
            onDouble = touch("double"),
            onLong = touch("long"),
            longHoldMs = (touches.firstOrNull { it.str("on") == "long_hold" }?.num("hold")?.toInt() ?: 420)
                .coerceIn(100, 2000),
            radialRadiusDp = (radial?.num("radius")?.toInt() ?: 78).coerceIn(40, 160),
            radialItems = radials,
            zoom = (perform?.num("zoom") ?: 1f).coerceIn(0.5f, 2f),
            alpha = when {
                perform == null -> 1f
                perform.get("alpha")?.isJsonPrimitive != true -> 1f
                else -> {
                    val p = perform.get("alpha").asJsonPrimitive
                    if (p.isNumber) (p.asFloat / 100f).coerceIn(0f, 1f)
                    else {
                        val s2 = p.asString.removePrefix("#")
                        val a2 = s2.toIntOrNull(16) ?: 0xFF
                        if (s2.length <= 2) (a2 / 255f).coerceIn(0f, 1f) else ((a2 shr 24) / 255f).coerceIn(0f, 1f)
                    }
                }
            },
            rollSec = (perform?.num("roll") ?: 0f).toInt(),
            sideSec = (perform?.num("side") ?: 0f).toInt(),
            darkSec = (perform?.num("dark") ?: 0f).toInt(),
            lock = perform?.get("lock")?.takeIf { it.isJsonPrimitive }?.let { it.asInt != 0 },
            icon = perform?.str("icon"),
            noti = notiObj?.let {
                Noti(
                    name = it.str("name") ?: "悬浮球",
                    text = it.str("text") ?: "",
                    time = it.str("time") ?: "",
                    silence = (it.num("silence")?.toInt() ?: 0) == 1
                )
            }
        )
    }

    /** touch 的 do 既可以是单个动作, 也可以是动作数组（顺序执行） */
    private fun com.google.gson.JsonElement.asAction(): JsonObject? = when {
        isJsonObject -> asJsonObject
        isJsonArray && asJsonArray.size() > 0 -> JsonObject().apply {
            addProperty("type", "sequence")
            add("actions", asJsonArray)
        }
        else -> null
    }

    private fun JsonObject.str(k: String): String? =
        get(k)?.takeIf { it.isJsonPrimitive }?.asString

    private fun JsonObject.num(k: String): Float? =
        get(k)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asFloat
}

internal object SduiText {
    fun join(a: com.google.gson.JsonArray): String =
        a.joinToString(" · ") { if (it.isJsonPrimitive) it.asString else "" }
}
