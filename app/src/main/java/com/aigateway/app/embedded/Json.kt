package com.aigateway.app.embedded

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import java.security.SecureRandom





private val random = SecureRandom()

fun randId(prefix: String): String {
    val b = ByteArray(10)
    random.nextBytes(b)
    return prefix + b.joinToString("") { "%02x".format(it) }
}

fun nowSec(): Long = System.currentTimeMillis() / 1000

fun safeParse(s: String?): JsonElement? =
    if (s.isNullOrBlank()) null else runCatching { JsonParser.parseString(s) }.getOrNull()


fun JsonObject.str(k: String): String? =
    get(k)?.takeIf { it.isJsonPrimitive }?.let { if (it.asJsonPrimitive.isString) it.asString else it.asString }

fun JsonObject.bool(k: String): Boolean? =
    get(k)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean

fun JsonObject.num(k: String): Double? =
    get(k)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asDouble

fun JsonObject.int(k: String): Int? = num(k)?.toInt()

fun JsonObject.obj(k: String): JsonObject? = get(k)?.takeIf { it.isJsonObject }?.asJsonObject

fun JsonObject.arr(k: String): JsonArray? = get(k)?.takeIf { it.isJsonArray }?.asJsonArray

fun JsonObject.hasNonNull(k: String): Boolean = has(k) && !get(k).isJsonNull


val JsonElement?.isStr: Boolean get() = this != null && isJsonPrimitive && asJsonPrimitive.isString
val JsonElement?.asStrOrNull: String? get() = if (isStr) this!!.asString else null

fun je(s: String?): JsonElement = if (s == null) JsonNull.INSTANCE else JsonPrimitive(s)
fun je(n: Number?): JsonElement = if (n == null) JsonNull.INSTANCE else JsonPrimitive(n)
fun je(b: Boolean?): JsonElement = if (b == null) JsonNull.INSTANCE else JsonPrimitive(b)

fun jsonObj(vararg pairs: Pair<String, JsonElement?>): JsonObject {
    val o = JsonObject()
    for ((k, v) in pairs) o.add(k, v ?: JsonNull.INSTANCE)
    return o
}

fun jsonArr(vararg items: JsonElement?): JsonArray {
    val a = JsonArray()
    for (it in items) a.add(it ?: JsonNull.INSTANCE)
    return a
}


fun JsonObject.put(k: String, v: String?): JsonObject = apply { if (v != null) addProperty(k, v) }
fun JsonObject.put(k: String, v: Number?): JsonObject = apply { if (v != null) addProperty(k, v) }
fun JsonObject.put(k: String, v: Boolean?): JsonObject = apply { if (v != null) addProperty(k, v) }
fun JsonObject.putEl(k: String, v: JsonElement?): JsonObject = apply { if (v != null) add(k, v) }
fun JsonObject.copyFrom(src: JsonObject, vararg keys: String): JsonObject = apply {
    for (k in keys) src.get(k)?.let { add(k, it) }
}


fun toText(content: JsonElement?): String {
    if (content == null || content.isJsonNull) return ""
    if (content.isJsonPrimitive) return if (content.asJsonPrimitive.isString) content.asString else content.asString
    if (content.isJsonArray) {
        val sb = StringBuilder()
        for (b in content.asJsonArray) {
            if (b.isJsonObject && b.asJsonObject.str("type") == "text") {
                sb.append(b.asJsonObject.str("text") ?: "")
            }
        }
        return sb.toString()
    }
    return ""
}


fun normStop(v: JsonElement?): List<String>? {
    if (v == null || v.isJsonNull) return null
    if (v.isJsonPrimitive) return listOf(v.asString)
    if (v.isJsonArray) {
        val out = v.asJsonArray.mapNotNull { it.asStrOrNull }
        return if (out.isEmpty()) null else out
    }
    return null
}
