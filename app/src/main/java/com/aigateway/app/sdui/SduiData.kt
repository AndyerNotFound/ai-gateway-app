package com.aigateway.app.sdui

import com.aigateway.app.data.GatewayBackend
import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject

/**
 * 页面数据装载：JSON 里声明要哪些数据，这里按声明去问 [GatewayBackend]。
 *
 * 走的是和「实例 / 渠道配置」完全相同的接口，所以：
 *  - 远程模式（Termux 网关）和内嵌模式（Kotlin 引擎）行为一致，JSON 里不出现 URL；
 *  - 单个数据源失败只在那一个键下留 error，不影响整页渲染。
 *
 * 声明写法（值可以是 {} 或省略）：
 *   "data": {
 *     "config": {},                                  // 当前实例配置（含 channels）
 *     "stats":  {"inst": "TRAE2API"},                 // 指定实例，缺省=当前实例
 *     "active": {},
 *     "requests": {"limit": 20},
 *     "logs": {"lines": 80},
 *     "balance": {"channel": "DeepSeek Official"}     // 缺省=配置里的第一个渠道
 *   }
 */
object SduiData {

    private val gson = Gson()

    suspend fun load(backend: GatewayBackend, rules: JsonObject?, inst: String): JsonObject {
        val out = JsonObject()
        if (rules == null) return out
        for ((rawKey, spec) in rules.entrySet()) {
            val key = rawKey.trim()
            val obj = spec as? JsonObject ?: JsonObject()
            val who = obj.get("inst")?.takeIf { it.isJsonPrimitive }?.asString
                ?.takeIf { it.isNotBlank() } ?: inst
            out.add(key, runCatching { fetch(backend, key, obj, who) }.getOrElse { e ->
                JsonObject().apply { addProperty("error", e.message ?: e.javaClass.simpleName) }
            })
        }
        return out
    }

    private suspend fun fetch(
        backend: GatewayBackend,
        key: String,
        spec: JsonObject,
        inst: String
    ): JsonElement = when (key) {
        "instances" -> gson.toJsonTree(backend.getInstances())
        "ball" -> backend.getBall(inst)
        "active" -> gson.toJsonTree(backend.getActive())
        "config" -> gson.toJsonTree(backend.getConfig(inst))
        "stats" -> gson.toJsonTree(backend.getStats(inst))
        "keys" -> gson.toJsonTree(backend.getKeys(inst))
        "requests" -> {
            val limit = spec.intOr("limit", 30).coerceIn(1, 200)
            JsonArray().apply {
                backend.getRequests(inst).take(limit).forEach { add(gson.toJsonTree(it)) }
            }
        }
        "logs" -> {
            val n = spec.intOr("lines", 100).coerceIn(1, 2000)
            val text = backend.getLogs(inst, n)
            val arr = JsonArray()
            text.split('\n').filter { it.isNotBlank() }.takeLast(n).forEach { arr.add(it) }
            JsonObject().apply {
                addProperty("text", text)
                add("lines", arr)
            }
        }
        "balance" -> {
            val ch = spec.get("channel")?.takeIf { it.isJsonPrimitive }?.asString
                ?: backend.getConfig(inst).channels.firstOrNull()?.name
                ?: throw IllegalArgumentException("没有渠道可查余额")
            backend.getBalance(inst, ch)
        }
        else -> throw IllegalArgumentException("未知数据源: $key")
    }

    private fun JsonObject.intOr(k: String, def: Int): Int =
        get(k)?.takeIf { it.isJsonPrimitive }?.asInt ?: def
}
