package com.aigateway.app.net

import com.aigateway.app.data.UserStore
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * 用户端后端 —— 卡密/账密访问网关的公开端点。
 * 端点: POST /auth/login(账密) · GET /credits(余额) · GET /v1/models(模型) · GET /status(状态/成功率)
 */
class UserBackend(private val store: UserStore) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    class ApiException(val code: Int, message: String) : Exception(message)

    private suspend fun get(path: String, base: String = store.apiRoot()): JsonObject =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url(base + path)
                .header("Authorization", "Bearer " + store.token)
                .build()
            client.newCall(req).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw ApiException(resp.code, parseErr(body, resp.code))
                JsonParser.parseString(body).asJsonObject
            }
        }

    private suspend fun post(path: String, body: JsonObject): JsonObject =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url(store.serverUrl + path)
                .header("Content-Type", "application/json")
                .post(body.toString().toRequestBody())
                .build()
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw ApiException(resp.code, parseErr(text, resp.code))
                JsonParser.parseString(text).asJsonObject
            }
        }

    private fun parseErr(body: String, code: Int): String = try {
        val j = JsonParser.parseString(body).asJsonObject
        val e = j.getAsJsonObject("error")
        (e?.get("message")?.asString ?: j.get("error")?.asString) ?: "HTTP $code"
    } catch (_: Exception) { "HTTP $code" }

    /** 账密登录 → 返回该用户的卡密列表 [{key, quotaTokens, usedTokens, ...}] */
    suspend fun login(uid: String, password: String): JsonObject {
        val body = JsonObject().apply {
            addProperty("uid", uid)
            addProperty("password", password)
        }
        return post("/auth/login", body)
    }

    /** 卡密验证 + 余额 */
    suspend fun credits(): JsonObject = get("/credits")

    /** 用户可见插件列表: GET /plugins（全局路径，不随分支变，故用 serverUrl 不走 apiRoot） */
    suspend fun plugins(): JsonObject = get("/plugins", base = store.serverUrl)

    /** 模型列表 */
    suspend fun models(): JsonObject = get("/models", store.apiBase())

    /** 指定 base 的模型列表(按分支聚合用) */
    suspend fun modelsAt(base: String): JsonObject = get("/models", base)

    /** 服务状态(含成功率 probe) */
    suspend fun status(): JsonObject = get("/status")

    /** 注册开关状态(无需认证) */
    suspend fun registerInfo(): JsonObject = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(store.serverUrl + "/auth/register").build()
        client.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw ApiException(resp.code, parseErr(body, resp.code))
            JsonParser.parseString(body).asJsonObject
        }
    }

    /** 注册 → 返回 {ok, uid, key} */
    suspend fun register(uid: String, password: String, email: String): JsonObject {
        val body = JsonObject().apply {
            addProperty("uid", uid)
            addProperty("password", password)
            if (email.isNotBlank()) addProperty("email", email)
        }
        return post("/auth/register", body)
    }

    /** 可访问分支列表(实例) */
    suspend fun branches(): JsonObject = get("/v1/branches")

    /** 我的信息(含卡密列表/资料) */
    suspend fun me(): JsonObject = get("/auth/me")

    /** 改个人信息 */
    suspend fun updateProfile(nickname: String, avatar: String): JsonObject {
        val body = JsonObject().apply {
            addProperty("nickname", nickname)
            addProperty("avatar", avatar)
        }
        return post("/auth/profile", body)
    }

    /** 我的卡密列表 */
    suspend fun myKeys(): JsonObject = get("/auth/mykeys")

    /** 自助发卡 */
    suspend fun createMyKey(name: String, quotaTokens: Long, models: List<String>, branches: List<String>): JsonObject {
        val body = JsonObject().apply {
            addProperty("name", name)
            addProperty("quotaTokens", quotaTokens)
            add("models", com.google.gson.JsonArray().apply { models.forEach { add(it) } })
            add("branches", com.google.gson.JsonArray().apply { branches.forEach { add(it) } })
        }
        return post("/auth/mykeys", body)
    }

    /** 改我的卡 */
    suspend fun updateMyKey(key: String, body: JsonObject): JsonObject {
        body.addProperty("key", key)
        return post("/auth/mykeys-update", body)
    }

    /** 删我的卡 */
    suspend fun deleteMyKey(key: String): JsonObject {
        return post("/auth/mykeys-delete", JsonObject().apply { addProperty("key", key) })
    }

    /** 健康检查(无需认证, 探测服务器可达性) */
    suspend fun health(): Boolean = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(store.serverUrl + "/health").build()
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) { false }
    }
}
