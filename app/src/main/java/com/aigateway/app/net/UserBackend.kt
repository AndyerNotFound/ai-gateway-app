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

    
    suspend fun login(uid: String, password: String): JsonObject {
        val body = JsonObject().apply {
            addProperty("uid", uid)
            addProperty("password", password)
        }
        return post("/auth/login", body)
    }

    
    suspend fun credits(): JsonObject = get("/credits")

    
    suspend fun plugins(): JsonObject = get("/plugins", base = store.serverUrl)

    
    suspend fun models(): JsonObject = get("/models", store.apiBase())

    
    suspend fun modelsAt(base: String): JsonObject = get("/models", base)

    
    suspend fun status(): JsonObject = get("/status")

    
    suspend fun registerInfo(): JsonObject = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(store.serverUrl + "/auth/register").build()
        client.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw ApiException(resp.code, parseErr(body, resp.code))
            JsonParser.parseString(body).asJsonObject
        }
    }

    
    suspend fun register(uid: String, password: String, email: String): JsonObject {
        val body = JsonObject().apply {
            addProperty("uid", uid)
            addProperty("password", password)
            if (email.isNotBlank()) addProperty("email", email)
        }
        return post("/auth/register", body)
    }

    
    suspend fun branches(): JsonObject = get("/v1/branches")

    
    suspend fun me(): JsonObject = get("/auth/me")

    
    suspend fun updateProfile(nickname: String, avatar: String): JsonObject {
        val body = JsonObject().apply {
            addProperty("nickname", nickname)
            addProperty("avatar", avatar)
        }
        return post("/auth/profile", body)
    }

    
    suspend fun myKeys(): JsonObject = get("/auth/mykeys")

    
    suspend fun createMyKey(name: String, quotaTokens: Long, models: List<String>, branches: List<String>): JsonObject {
        val body = JsonObject().apply {
            addProperty("name", name)
            addProperty("quotaTokens", quotaTokens)
            add("models", com.google.gson.JsonArray().apply { models.forEach { add(it) } })
            add("branches", com.google.gson.JsonArray().apply { branches.forEach { add(it) } })
        }
        return post("/auth/mykeys", body)
    }

    
    suspend fun updateMyKey(key: String, body: JsonObject): JsonObject {
        body.addProperty("key", key)
        return post("/auth/mykeys-update", body)
    }

    
    suspend fun deleteMyKey(key: String): JsonObject {
        return post("/auth/mykeys-delete", JsonObject().apply { addProperty("key", key) })
    }

    
    suspend fun health(): Boolean = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(store.serverUrl + "/health").build()
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) { false }
    }
}
