package com.aigateway.app.sdui

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive

/**
 * gcui 风格模板作用域：`{{state.a.b}}` / `{{item.x}}` / `{{input.k}}`。
 *
 * 约定（沿用 gcui v1）：整串只有一个模板时保留原始类型（数字仍是数字、布尔仍是布尔），
 * 混排时按字符串拼接。解析失败返回 null，由调用方决定回落。
 */
class SduiScope(
    val state: JsonObject? = null,
    val item: JsonObject? = null,
    val inputs: MutableMap<String, JsonElement> = mutableMapOf()
) {

    fun lookup(path: String): JsonElement? {
        val parts = path.split('.')
        if (parts.isEmpty()) return null
        return when (parts[0]) {
            "input" -> parts.getOrNull(1)?.let { inputs[it] }
            "state" -> walk(state, parts, 1)
            "item" -> walk(item, parts, 1)
            else -> null
        }
    }

    private fun walk(start: JsonObject?, parts: List<String>, from: Int): JsonElement? {
        var cur: JsonElement? = start ?: return null
        for (i in from until parts.size) {
            cur = when (val c = cur) {
                is JsonObject -> c.get(parts[i])
                is JsonArray -> parts[i].toIntOrNull()?.let { idx -> if (idx in 0 until c.size()) c.get(idx) else null }
                else -> null
            }
            if (cur == null) return null
        }
        return cur
    }

    companion object {
        private val TPL = Regex("""\{\{\s*([A-Za-z0-9_.]+)\s*\}\}""")

        /** 字符串 → 解析后的字符串；模板解析不到时保留原样（便于服务端一眼看出漏配） */
        fun text(s: String, sc: SduiScope): String {
            val whole = TPL.matchEntire(s.trim())
            if (whole != null) {
                val v = sc.lookup(whole.groupValues[1]) ?: return s
                return plain(v)
            }
            if (!s.contains("{{")) return s
            return TPL.replace(s) { m -> sc.lookup(m.groupValues[1])?.let { plain(it) } ?: m.value }
        }

        fun plain(e: JsonElement): String = when {
            e.isJsonNull -> ""
            e.isJsonPrimitive -> e.asJsonPrimitive.let { p ->
                if (p.isBoolean) if (p.asBoolean) "是" else "否" else p.asString
            }
            else -> e.toString()
        }

        /** 取字段并解析成字符串（缺字段 → 默认值） */
        fun str(o: JsonObject?, key: String, sc: SduiScope, def: String? = null): String? {
            val e = o?.get(key) ?: return def
            if (e.isJsonNull) return def
            return if (e.isJsonPrimitive) text(e.asString, sc) else e.toString()
        }

        /** 取字段并解析成数字（支持 "{{state.x}}" 与直接数字） */
        fun num(o: JsonObject?, key: String, sc: SduiScope, def: Float? = null): Float? {
            val e = o?.get(key) ?: return def
            val v = if (e.isJsonPrimitive && e.asJsonPrimitive.isNumber) e.asJsonPrimitive.asFloat
            else e.takeIf { it.isJsonPrimitive }?.asString?.let { text(it, sc).toFloatOrNull() }
            return v ?: def
        }

        /** 递归解析：action 里的 endpoint / body / text 都可能是模板 */
        fun deep(el: JsonElement?, sc: SduiScope): JsonElement? {
            if (el == null) return null
            return when {
                el.isJsonObject -> JsonObject().apply {
                    for ((k, v) in el.asJsonObject.entrySet()) deep(v, sc)?.let { add(k, it) }
                }
                el.isJsonArray -> JsonArray().apply { el.asJsonArray.forEach { deep(it, sc)?.let { add(it) } } }
                el.isJsonPrimitive && el.asJsonPrimitive.isString -> {
                    val s = el.asString
                    val whole = TPL.matchEntire(s.trim())
                    if (whole != null) sc.lookup(whole.groupValues[1]) ?: JsonPrimitive(s)
                    else if (s.contains("{{")) JsonPrimitive(text(s, sc)) else JsonPrimitive(s)
                }
                else -> el
            }
        }

        fun bool(o: JsonObject?, key: String, sc: SduiScope, def: Boolean? = null): Boolean? {
            val e = o?.get(key) ?: return def
            if (e.isJsonObject) return true
            if (!e.isJsonPrimitive) return def
            val p = e.asJsonPrimitive
            if (p.isBoolean) return p.asBoolean
            return when (p.asString.trim().lowercase()) {
                "true", "1", "yes", "on" -> true
                "false", "0", "no", "off", "" -> false
                else -> text(p.asString, sc).toFloatOrNull()?.let { it != 0f } ?: def
            }
        }
    }
}
