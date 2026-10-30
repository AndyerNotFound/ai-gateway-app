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
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * ai-gateway-AI 远程管理后端。
 *
 * 鉴权：config.webToken -> x-agw-token（对应 server/admin.js checkAdminAuth）。
 * 不依赖面板会话 Cookie、/admin/m3 或已删除的 active/context-windows 路由。
 */
class RemoteBackend(
    baseUrl: String,
    val webToken: String,
    private val secondKey: String = "",
    private val totpSecret: String = "",
    private val allowInsecureTls: Boolean = false
) : GatewayBackend {

    private val base = baseUrl.trim().removeSuffix("/")
    private val gson = Gson()
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    @Volatile
    override var lastError: String? = null
        private set

    private val client = buildClient(allowInsecureTls || ConnectionStore.isLoopbackUrl(base))

    private val streamClient = client.newBuilder()
        .readTimeout(5, TimeUnit.MINUTES)
        .build()

    private fun buildClient(trustAll: Boolean): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
        if (trustAll) {
            val trustManager = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            }
            val context = SSLContext.getInstance("TLS")
            context.init(null, arrayOf(trustManager), SecureRandom())
            builder.sslSocketFactory(context.socketFactory, trustManager)
            builder.hostnameVerifier { _, _ -> true }
        }
        return builder.build()
    }

    /** 路径段编码：URLEncoder 把空格编成 +，网关按 %20 解码。 */
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    private fun newRequest(path: String): Request.Builder {
        val b = Request.Builder().url("$base$path")
        if (webToken.isNotBlank()) b.header("x-agw-token", webToken)
        if (secondKey.isNotBlank()) b.header("x-admin-key2", secondKey)
        if (totpSecret.isNotBlank()) {
            val code = Totp.code(totpSecret)
            if (code.isNotEmpty()) b.header("x-totp", code)
        }
        return b
    }

    private fun exec(req: Request): String {
        client.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw BackendException(errMsg(body, resp.code), resp.code)
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

    override suspend fun testConnection(): Boolean = withContext(Dispatchers.IO) {
        try {
            getJson("/admin/api/instances")
            lastError = null
            true
        } catch (e: Exception) {
            lastError = e.message ?: e.javaClass.simpleName
            false
        }
    }

    override suspend fun getInstances(): InstancesResponse = withContext(Dispatchers.IO) {
        getObj("/admin/api/instances")
    }

    override suspend fun getConfig(name: String): GatewayConfig = withContext(Dispatchers.IO) {
        getObj("/admin/api/config/${enc(name)}?reveal=1")
    }

    override suspend fun saveConfig(name: String, patch: JsonObject): ActionResult =
        withContext(Dispatchers.IO) { post("/admin/api/config/${enc(name)}", patch).toActionResult() }

    override suspend fun createInstance(name: String, port: Int, webToken: String): ActionResult =
        withContext(Dispatchers.IO) {
            val p = JsonObject().apply {
                addProperty("port", port)
                addProperty("webToken", webToken)
            }
            post("/admin/api/instance-create/${enc(name)}", p).toActionResult()
        }

    override suspend fun deleteInstance(name: String): ActionResult =
        withContext(Dispatchers.IO) { delete("/admin/api/instance/${enc(name)}").toActionResult() }

    override suspend fun renameInstance(name: String, newName: String): ActionResult =
        withContext(Dispatchers.IO) {
            post("/admin/api/instance-rename/${enc(name)}",
                JsonObject().apply { addProperty("newName", newName) }).toActionResult()
        }

    override suspend fun getKeys(inst: String): KeysResponse = withContext(Dispatchers.IO) {
        getObj("/admin/api/keys/${enc(inst)}")
    }

    override suspend fun createKey(inst: String, body: JsonObject): JsonObject = withContext(Dispatchers.IO) {
        post("/admin/api/keys/${enc(inst)}", body)
    }

    override suspend fun updateKey(inst: String, body: JsonObject): ActionResult = withContext(Dispatchers.IO) {
        post("/admin/api/keys-update/${enc(inst)}", body).toActionResult()
    }

    override suspend fun deleteKey(inst: String, key: String): ActionResult = withContext(Dispatchers.IO) {
        delete("/admin/api/keys/${enc(inst)}/${enc(key)}").toActionResult()
    }

    override suspend fun getAdminAuth(inst: String): JsonObject = withContext(Dispatchers.IO) {
        getObj("/admin/api/admin-auth/${enc(inst)}")
    }

    override suspend fun rotateWebToken(): String = withContext(Dispatchers.IO) {
        val j = post("/admin/api/web-token/rotate")
        j.get("webToken")?.asString?.takeIf { it.isNotBlank() }
            ?: throw BackendException("轮换响应缺少 webToken")
    }

    override suspend fun setAdminAuth(inst: String, body: JsonObject): JsonObject = withContext(Dispatchers.IO) {
        post("/admin/api/admin-auth/${enc(inst)}", body)
    }

    override suspend fun getTunnel(): JsonObject = withContext(Dispatchers.IO) {
        getObj("/admin/api/tunnel")
    }

    override suspend fun tunnelAction(action: String): JsonObject = withContext(Dispatchers.IO) {
        post("/admin/api/tunnel", JsonObject().apply { addProperty("action", action) })
    }

    override suspend fun getBalance(inst: String, ch: String): JsonObject = withContext(Dispatchers.IO) {
        getObj("/admin/api/balance/${enc(inst)}/${enc(ch)}")
    }

    override suspend fun getPlugins(inst: String): JsonObject = withContext(Dispatchers.IO) {
        getObj("/admin/api/plugins/${enc(inst)}")
    }

    override suspend fun installPlugin(inst: String, body: JsonObject): JsonObject = withContext(Dispatchers.IO) {
        post("/admin/api/plugins-install/${enc(inst)}", body)
    }

    override suspend fun removePlugin(inst: String, body: JsonObject): JsonObject = withContext(Dispatchers.IO) {
        post("/admin/api/plugins-remove/${enc(inst)}", body)
    }

    override suspend fun enablePlugin(inst: String, body: JsonObject): JsonObject = withContext(Dispatchers.IO) {
        post("/admin/api/plugins-enable/${enc(inst)}", body)
    }

    override suspend fun setOnceChannel(inst: String, channel: String?): ActionResult =
        withContext(Dispatchers.IO) {
            val p = JsonObject().apply { if (channel != null) addProperty("channel", channel) }
            post("/admin/api/route-once/${enc(inst)}", p).toActionResult()
        }

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
        post("/admin/api/sync-models", JsonObject().apply { addProperty("instance", inst) }).toActionResult()
    }

    override suspend fun getStats(name: String): Stats = withContext(Dispatchers.IO) {
        getObj("/admin/api/stats?instance=${enc(name)}")
    }

    override suspend fun getStatsAll(): StatsAll = withContext(Dispatchers.IO) {
        getObj("/admin/api/stats-all")
    }

    override suspend fun getLogs(name: String, lines: Int): String = withContext(Dispatchers.IO) {
        exec(newRequest("/admin/api/logs/${enc(name)}?lines=$lines").get().build())
    }

    override suspend fun getRequests(name: String): List<RequestEntry> = withContext(Dispatchers.IO) {
        val j = JsonParser.parseString(exec(newRequest("/admin/api/requests/${enc(name)}").get().build()))
        val arr = if (j.isJsonArray) j.asJsonArray else j.asJsonObject.getAsJsonArray("requests")
        arr?.map { gson.fromJson(it, RequestEntry::class.java) } ?: emptyList()
    }

    override suspend fun getRecordBody(name: String, id: String): RecordBody = withContext(Dispatchers.IO) {
        getObj("/admin/api/record-body/${enc(name)}?id=${enc(id)}")
    }

    override suspend fun action(name: String, cmd: String): ActionResult =
        withContext(Dispatchers.IO) { post("/admin/api/action/${enc(name)}/${enc(cmd)}").toActionResult() }

    override suspend fun shutdownAll(): ActionResult =
        withContext(Dispatchers.IO) { post("/admin/api/shutdown-all").toActionResult() }

    override fun close() {
        client.dispatcher.executorService.shutdown()
        streamClient.dispatcher.executorService.shutdown()
    }
}
