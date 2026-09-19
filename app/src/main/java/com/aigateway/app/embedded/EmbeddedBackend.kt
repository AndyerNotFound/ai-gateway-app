package com.aigateway.app.embedded

import com.aigateway.app.data.*
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File





class EmbeddedBackend(
    private val engine: GatewayEngine,
    private val server: EmbeddedHttpServer
) : GatewayBackend {

    private val gson = Gson()

    override val modeLabel: String = "应用内运行"
    override val connectionDesc: String = "内嵌网关 :${engine.port()}"

    override suspend fun testConnection(): Boolean = true

    

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

    

    override suspend fun saveChannel(inst: String, channel: Channel): ActionResult = withContext(Dispatchers.IO) {
        runCatching {
            engine.updateConfig { cur ->
                val list = cur.channels.toMutableList()
                if (channel.default) list.replaceAll { it.copy(default = false) }
                
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

    

    override suspend fun getStats(name: String): Stats = engine.getStats()

    override suspend fun getLogs(name: String, lines: Int): String = engine.getLogs(lines)

    override suspend fun getRequests(name: String): List<RequestEntry> = engine.getRecent()

    override suspend fun getRecordBody(name: String, id: String): RecordBody =
        RecordBody(ok = false, record = null)

    

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
