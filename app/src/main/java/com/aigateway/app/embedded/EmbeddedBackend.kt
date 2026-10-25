package com.aigateway.app.embedded

import com.aigateway.app.data.*
import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 内嵌后端 —— 直接调 GatewayEngine(不走 HTTP), 实现管理面板全部操作。
 * 单实例(固定 "default")。
 */
class EmbeddedBackend(
    private val engine: GatewayEngine,
    private val server: EmbeddedHttpServer
) : GatewayBackend {

    private val gson = Gson()

    override val modeLabel: String = "应用内运行"
    override val connectionDesc: String = "内嵌网关 :${engine.port()}"

    override suspend fun testConnection(): Boolean = true

    // ---------- 实例 ----------

    override suspend fun getInstances(): InstancesResponse {
        val c = engine.getConfig()
        return InstancesResponse(
            instances = listOf(Instance("default", c.port, server.isRunning, c.channels.size, c.tls.enable, current = true)),
            current = "default"
        )
    }

    override suspend fun getConfig(name: String): GatewayConfig = engine.getConfig()

    override suspend fun saveConfig(name: String, patch: JsonObject): ActionResult = withContext(Dispatchers.IO) {
        runCatching {
            engine.updateConfig { cur ->
                val curJson = gson.toJsonTree(cur).asJsonObject
                for (key in patch.keySet()) {
                    if (key == "name") continue
                    curJson.add(key, patch.get(key))
                }
                gson.fromJson(curJson, GatewayConfig::class.java)
            }
            // 端口变更需重启服务器
            restartServerIfNeeded()
            ActionResult(ok = true, restarting = true)
        }.getOrElse { ActionResult(ok = false, error = it.message) }
    }

    private fun restartServerIfNeeded() {
        if (server.isRunning) {
            server.stop()
            server.start(engine.port())
        }
    }

    override suspend fun createInstance(name: String, port: Int, adminKey: String): ActionResult =
        ActionResult(ok = false, error = "应用内运行模式仅支持单个实例")

    override suspend fun deleteInstance(name: String): ActionResult =
        ActionResult(ok = false, error = "应用内运行模式不可删除实例")

    override suspend fun renameInstance(name: String, newName: String): ActionResult =
        ActionResult(ok = false, error = "应用内运行模式仅支持单个实例, 无需改名")

    // ---------- 渠道 ----------

    override suspend fun saveChannel(inst: String, channel: Channel): ActionResult = withContext(Dispatchers.IO) {
        runCatching {
            engine.updateConfig { cur ->
                val list = cur.channels.toMutableList()
                if (channel.default) list.replaceAll { it.copy(default = false) }
                // 改名: 有 oldName 且与新名不同 → 找原渠道位置替换(apiKey 为空则保留原 key)
                val oldIdx = if (!channel.oldName.isNullOrBlank() && channel.oldName != channel.name)
                    list.indexOfFirst { it.name == channel.oldName } else -1
                val idx = if (oldIdx >= 0) oldIdx else list.indexOfFirst { it.name == channel.name }
                val merged = if (idx >= 0 && channel.apiKey.isBlank()) channel.copy(apiKey = list[idx].apiKey, oldName = null) else channel.copy(oldName = null)
                if (idx >= 0) list[idx] = merged else list.add(merged)
                cur.copy(channels = list)
            }
            ActionResult(ok = true, restarting = true)
        }.getOrElse { ActionResult(ok = false, error = it.message) }
    }

    override suspend fun deleteChannel(inst: String, chName: String): ActionResult = withContext(Dispatchers.IO) {
        engine.updateConfig { cur -> cur.copy(channels = cur.channels.filterNot { it.name == chName }) }
        ActionResult(ok = true, restarting = true)
    }

    override suspend fun fetchModels(inst: String, channel: Channel): ModelsResult = withContext(Dispatchers.IO) {
        try {
            val client = UpstreamClient.clientFor(resolveProxy(channel.proxy), channel.insecure)
            val (url, headerName) = when (channel.type) {
                "claude" -> channel.baseUrl.removeSuffix("/") + "/v1/models" to "x-api-key"
                "gemini" -> channel.baseUrl.removeSuffix("/") + "/v1beta/models" to "x-goog-api-key"
                else -> channel.baseUrl.removeSuffix("/") + "/v1/models" to "authorization"
            }
            val rb = Request.Builder().url(url)
            if (headerName == "authorization") rb.header("authorization", "Bearer " + channel.apiKey)
            else rb.header(headerName, channel.apiKey)
            if (channel.type == "claude") rb.header("anthropic-version", "2023-06-01")
            val resp = client.newCall(rb.get().build()).execute()
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) return@withContext ModelsResult(emptyList(), "HTTP ${resp.code}: ${body.take(200)}")
            val j = JsonParser.parseString(body).asJsonObject
            val models = ArrayList<String>()
            when (channel.type) {
                "gemini" -> j.getAsJsonArray("models")?.forEach { m ->
                    if (m.isJsonObject) m.asJsonObject.str("name")?.let { models.add(it.removePrefix("models/")) }
                }
                else -> j.getAsJsonArray("data")?.forEach { m ->
                    if (m.isJsonObject) m.asJsonObject.str("id")?.let { models.add(it) }
                }
            }
            ModelsResult(models, null)
        } catch (e: Exception) {
            ModelsResult(emptyList(), e.message ?: "连接失败")
        }
    }

    private fun resolveProxy(name: String?): Proxy? =
        if (name.isNullOrBlank()) null else engine.getConfig().proxies[name]

    override suspend fun syncModels(inst: String): ActionResult =
        ActionResult(ok = false, error = "内嵌模式暂不支持同步, 请用「获取模型列表」手动添加")

    // ---------- 上游余额透传(内嵌模式) ----------
    // 与 Node 版同口径: 渠道 balanceUrl(相对路径按 Base URL 拼) 覆盖内置预设; 走渠道 proxy/insecure; 认证头按渠道类型
    override suspend fun getBalance(inst: String, ch: String): JsonObject = withContext(Dispatchers.IO) {
        val cfg = engine.getConfig()
        val channel = cfg.channels.firstOrNull { it.name == ch }
            ?: throw BackendException("渠道不存在: $ch")
        val target = BalancePresets.target(channel)
            ?: throw BackendException("该渠道无余额接口预设, 请填「余额接口」+「取值路径」")
        val url = BalancePresets.resolveUrl(channel, target.url)
        val rb = Request.Builder().url(url)
        when (channel.type.lowercase()) {
            "claude" -> { rb.header("x-api-key", channel.apiKey); rb.header("anthropic-version", "2023-06-01") }
            "gemini" -> rb.header("x-goog-api-key", channel.apiKey)
            else -> rb.header("authorization", "Bearer " + channel.apiKey)
        }
        val client = UpstreamClient.clientFor(resolveProxy(channel.proxy), channel.insecure)
            .newBuilder().callTimeout(15, TimeUnit.SECONDS).build()
        val resp = try {
            client.newCall(rb.get().build()).execute()
        } catch (e: Exception) {
            throw BackendException("余额查询失败: " + (e.message ?: "连接失败"))
        }
        try {
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw BackendException("上游返回 ${resp.code}: " + body.take(200))
            val j = safeParse(body)?.takeIf { it.isJsonObject }?.asJsonObject
                ?: throw BackendException("上游响应非 JSON")
            val v = BalancePresets.dig(j, target.path)
                ?: throw BackendException("取值路径 ${target.path} 在上游响应中不存在")
            jsonObj(
                "ok" to je(true), "channel" to je(channel.name),
                "balance" to (if (v.isJsonPrimitive) v else je(v.toString())),
                "unit" to je(target.unit), "url" to je(url)
            )
        } finally {
            resp.close()
        }
    }

    // ---------- 统计/日志/请求 ----------

    override suspend fun getStats(name: String): Stats = engine.getStats()

    override suspend fun getLogs(name: String, lines: Int): String = engine.getLogs(lines)

    override suspend fun getRequests(name: String): List<RequestEntry> = engine.getRecent()

    override suspend fun getRecordBody(name: String, id: String): RecordBody =
        RecordBody(ok = false, record = null)

    // ---------- 控制 ----------

    override suspend fun action(name: String, cmd: String): ActionResult = withContext(Dispatchers.IO) {
        when (cmd) {
            "start" -> if (server.start(engine.port())) ActionResult(ok = true, output = "网关已启动 :${engine.port()}")
                       else ActionResult(ok = false, error = "端口 ${engine.port()} 启动失败(可能被占用)")
            "stop" -> { server.stop(); ActionResult(ok = true, output = "网关已停止") }
            "restart" -> { server.stop(); if (server.start(engine.port())) ActionResult(ok = true, output = "已重启") else ActionResult(ok = false, error = "重启失败") }
            else -> ActionResult(ok = false, error = "未知操作: $cmd")
        }
    }

    override suspend fun shutdownAll(): ActionResult {
        server.stop()
        return ActionResult(ok = true, output = "内嵌网关已停止")
    }

    // ---------- 聊天 ----------

    override suspend fun chat(
        instance: String,
        model: String,
        messages: List<ChatMessage>,
        onDelta: (String) -> Unit
    ): ActionResult {
        val body = JsonObject().apply {
            addProperty("model", model)
            add("messages", gson.toJsonTree(messages))
            addProperty("stream", true)
        }
        var error: String? = null
        engine.chat("openai", body, null, forceStream = false, gatewayKeyOk = true).collect { ev ->
            when (ev) {
                is EngineEvent.Sse -> {
                    val j = safeParse(ev.data)?.takeIf { it.isJsonObject }?.asJsonObject
                    val delta = j?.arr("choices")?.get(0)?.asJsonObject?.obj("delta")?.str("content")
                    if (!delta.isNullOrEmpty()) onDelta(delta)
                }
                is EngineEvent.JsonBody -> {
                    val content = ev.body.arr("choices")?.get(0)?.asJsonObject?.obj("message")?.get("content")
                    val txt = if (content != null && content.isStr) content.asString else toText(content)
                    if (txt.isNotEmpty()) onDelta(txt)
                }
                is EngineEvent.Fail -> error = ev.message
                else -> {}
            }
        }
        return ActionResult(ok = error == null, error = error)
    }

    override fun close() {
        server.stop()
    }
}

/** 上游余额目标解析 —— 内置预设与 Node 版 gateway.js BALANCE_PRESETS 同口径 */
private object BalancePresets {
    data class Target(val url: String, val path: String, val unit: String)
    private data class Preset(val keys: List<String>, val target: Target)

    private val LIST = listOf(
        Preset(listOf("api.deepseek.com", "deepseek"), Target("/user/balance", "balance_infos.0.total_balance", "CNY")),
        Preset(listOf("api.siliconflow.cn", "siliconflow.cn"), Target("/v1/user/info", "data.balance", "CNY")),
        Preset(listOf("api.siliconflow.com", "siliconflow.com"), Target("/v1/user/info", "data.balance", "USD")),
        Preset(listOf("api.openai.com", "openai.com"), Target("/dashboard/billing/credit_grants", "total_available", "USD")),
        Preset(listOf("open.bigmodel.cn", "bigmodel"), Target("/api/paas/v4/user/info", "data.balance", "CNY")),
    )

    private fun presetFor(ch: Channel): Target? {
        val base = ch.baseUrl.lowercase()
        val name = ch.name.lowercase()
        return LIST.firstOrNull { p -> p.keys.any { base.contains(it) || name.contains(it) } }?.target
    }

    fun target(ch: Channel): Target? {
        val p = presetFor(ch)
        val url = ch.balanceUrl?.takeIf { it.isNotBlank() } ?: p?.url ?: return null
        val path = ch.balancePath?.takeIf { it.isNotBlank() } ?: p?.path ?: return null
        val unit = ch.balanceUnit?.takeIf { it.isNotBlank() } ?: p?.unit ?: ""
        return Target(url, path, unit)
    }

    fun resolveUrl(ch: Channel, url: String): String {
        if (url.startsWith("http://") || url.startsWith("https://")) return url
        val base = ch.baseUrl.trimEnd('/')
        if (base.isEmpty()) throw BackendException("渠道 ${ch.name} 未配置 Base URL")
        return base + if (url.startsWith("/")) url else "/$url"
    }

    fun dig(e: JsonElement, path: String): JsonElement? {
        var cur: JsonElement? = e
        // 兼容 balance_infos[1].total_balance 这种带下标写法
        for (k in path.replace(Regex("\\[(\\d+)\\]"), ".$1").split('.')) {
            if (k.isEmpty()) continue
            val c = cur ?: return null
            cur = when {
                c.isJsonObject -> c.asJsonObject.get(k)
                c.isJsonArray -> k.toIntOrNull()?.let { i -> if (i >= 0 && i < c.asJsonArray.size()) c.asJsonArray.get(i) else null }
                else -> null
            }
        }
        return cur
    }
}
