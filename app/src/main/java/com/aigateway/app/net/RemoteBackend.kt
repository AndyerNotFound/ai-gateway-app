package com.aigateway.app.net

import com.aigateway.app.data.*
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * 远程后端 —— 通过 HTTP 调 gateway 内置 admin API (x-admin-key 鉴权)。
 */
class RemoteBackend(
    baseUrl: String,
    private val adminKey: String
) : GatewayBackend {

    private val base = baseUrl.trim().removeSuffix("/")
    private val gson = Gson()
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // 流式用单独 client(读超时更长)
    private val streamClient = client.newBuilder()
        .readTimeout(5, TimeUnit.MINUTES)
        .build()

    override val modeLabel: String = "远程网关"
    override val connectionDesc: String = base

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun newRequest(path: String): Request.Builder {
        val b = Request.Builder().url("$base$path")
        if (adminKey.isNotBlank()) b.header("x-admin-key", adminKey)
        return b
    }

    /** 执行请求, 返回 body 字符串; 非 2xx 抛异常 */
    private fun exec(req: Request): String {
        client.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw BackendException(errMsg(body, resp.code), resp.code)
            }
            return body
        }
    }

    private fun errMsg(body: String, code: Int): String {
        if (body.isBlank()) return "HTTP $code"
        return runCatching {
            JsonParser.parseString(body).asJsonObject.get("error")?.asString
        }.getOrNull() ?: body.take(200)
    }

    private fun getJson(path: String): JsonObject =
        JsonParser.parseString(exec(newRequest(path).get().build())).asJsonObject

    private inline fun <reified T> getObj(path: String): T =
        gson.fromJson(exec(newRequest(path).get().build()), T::class.java)

    private fun post(path: String, payload: JsonObject? = null): JsonObject {
        val rb = (payload?.toString() ?: "{}").toRequestBody(jsonMedia)
        return JsonParser.parseString(exec(newRequest(path).post(rb).build())).asJsonObject
    }

    private fun delete(path: String): JsonObject =
        JsonParser.parseString(exec(newRequest(path).delete().build())).asJsonObject

    private fun JsonObject.toActionResult(): ActionResult =
        ActionResult(
            ok = get("ok")?.asBoolean ?: false,
            output = get("output")?.asString ?: "",
            restarting = get("restarting")?.asBoolean ?: false,
            self = get("self")?.asBoolean ?: false,
            error = get("error")?.asString
        )

    // ---------- 接口实现 ----------

    override suspend fun testConnection(): Boolean = withContext(Dispatchers.IO) {
        runCatching { getJson("/admin/api/instances"); true }.getOrDefault(false)
    }

    override suspend fun getInstances(): InstancesResponse = withContext(Dispatchers.IO) {
        getObj("/admin/api/instances")
    }

    override suspend fun getConfig(name: String): GatewayConfig = withContext(Dispatchers.IO) {
        getObj("/admin/api/config/${enc(name)}?reveal=1")
    }

    override suspend fun saveConfig(name: String, patch: JsonObject): ActionResult =
        withContext(Dispatchers.IO) { post("/admin/api/config/${enc(name)}", patch).toActionResult() }

    override suspend fun createInstance(name: String, port: Int, adminKey: String): ActionResult =
        withContext(Dispatchers.IO) {
            val p = JsonObject().apply {
                addProperty("port", port)
                addProperty("adminKey", adminKey)
            }
            post("/admin/api/instance-create/${enc(name)}", p).toActionResult()
        }

    override suspend fun deleteInstance(name: String): ActionResult =
        withContext(Dispatchers.IO) { delete("/admin/api/instance/${enc(name)}").toActionResult() }

    override suspend fun saveChannel(inst: String, channel: Channel): ActionResult =
        withContext(Dispatchers.IO) {
            val p = gson.toJson(channel).let { JsonParser.parseString(it).asJsonObject }
            post("/admin/api/channel/${enc(inst)}", p).toActionResult()
        }

    override suspend fun deleteChannel(inst: String, chName: String): ActionResult =
        withContext(Dispatchers.IO) { delete("/admin/api/channel/${enc(inst)}/${enc(chName)}").toActionResult() }

    override suspend fun fetchModels(inst: String, channel: Channel): ModelsResult =
        withContext(Dispatchers.IO) {
            val p = gson.toJson(channel).let { JsonParser.parseString(it).asJsonObject }
            val j = post("/admin/api/channel-models/${enc(inst)}", p)
            val models = j.getAsJsonArray("models")?.map { it.asString } ?: emptyList()
            ModelsResult(models, j.get("error")?.asString)
        }

    override suspend fun syncModels(inst: String): ActionResult = withContext(Dispatchers.IO) {
        val p = JsonObject().apply { addProperty("instance", inst) }
        post("/admin/api/sync-models", p).toActionResult()
    }

    override suspend fun getStats(name: String): Stats = withContext(Dispatchers.IO) {
        getObj("/admin/api/stats?instance=${enc(name)}")
    }

    override suspend fun getLogs(name: String, lines: Int): String = withContext(Dispatchers.IO) {
        exec(newRequest("/admin/api/logs/${enc(name)}?lines=$lines").get().build())
    }

    override suspend fun getRequests(name: String): List<RequestEntry> = withContext(Dispatchers.IO) {
        val j = JsonParser.parseString(exec(newRequest("/admin/api/requests/${enc(name)}").get().build()))
        val arr = if (j.isJsonArray) j.asJsonArray else j.asJsonObject.getAsJsonArray("requests")
        arr?.map { gson.fromJson(it, RequestEntry::class.java) } ?: emptyList()
    }

    override suspend fun getRecordBody(name: String, id: String): RecordBody =
        withContext(Dispatchers.IO) {
            getObj("/admin/api/record-body/${enc(name)}?id=${enc(id)}")
        }

    override suspend fun action(name: String, cmd: String): ActionResult =
        withContext(Dispatchers.IO) { post("/admin/api/action/${enc(name)}/${enc(cmd)}").toActionResult() }

    override suspend fun shutdownAll(): ActionResult =
        withContext(Dispatchers.IO) { post("/admin/api/shutdown-all").toActionResult() }

    override suspend fun chat(
        instance: String,
        model: String,
        messages: List<ChatMessage>,
        onDelta: (String) -> Unit
    ): ActionResult = withContext(Dispatchers.IO) {
        val payload = JsonObject().apply {
            addProperty("instance", instance)
            addProperty("model", model)
            add("messages", gson.toJsonTree(messages))
            addProperty("stream", true)
        }
        val req = newRequest("/admin/api/chat")
            .post(payload.toString().toRequestBody(jsonMedia))
            .build()
        try {
            streamClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    val b = resp.body?.string().orEmpty()
                    return@withContext ActionResult(ok = false, error = errMsg(b, resp.code))
                }
                parseSse(resp, onDelta)
                ActionResult(ok = true)
            }
        } catch (e: Exception) {
            ActionResult(ok = false, error = e.message ?: "连接失败")
        }
    }

    /** 解析 OpenAI SSE 流, 提取 delta.content */
    private fun parseSse(resp: okhttp3.Response, onDelta: (String) -> Unit) {
        val src = resp.body?.source() ?: return
        while (true) {
            val line = src.readUtf8Line() ?: break
            if (!line.startsWith("data:")) continue
            val data = line.substring(5).trim()
            if (data == "[DONE]") break
            runCatching {
                val j = JsonParser.parseString(data).asJsonObject
                val delta = j.getAsJsonArray("choices")?.get(0)?.asJsonObject
                    ?.getAsJsonObject("delta")?.get("content")?.asString
                if (!delta.isNullOrEmpty()) onDelta(delta)
            }
        }
    }

    override fun close() {
        client.dispatcher.executorService.shutdown()
        streamClient.dispatcher.executorService.shutdown()
    }
}
