package com.aigateway.app.data

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.JsonParser
import com.google.gson.reflect.TypeToken
import java.util.UUID

/** 一个远程网关连接配置。webToken 对应 ai-gateway-AI 的 config.webToken。 */
data class ConnectionProfile(
    val id: String = UUID.randomUUID().toString(),
    var label: String = "",
    var baseUrl: String = ConnectionStore.DEFAULT_URL,
    var webToken: String = "",
    /** ai-gateway-AI 第二因子：第二密码（请求头 x-admin-key2）。 */
    var secondKey: String = "",
    /** ai-gateway-AI 第二因子：TOTP secret（base32，用于生成 x-totp）。 */
    var totpSecret: String = ""
) {
    fun displayName(): String = label.ifBlank { baseUrl }
}

/** 连接配置存储 —— 只保留远程管理所需的地址与令牌。 */
class ConnectionStore(context: Context) {

    private val sp: SharedPreferences =
        context.getSharedPreferences("ai_gateway_conn", Context.MODE_PRIVATE)
    private val gson = Gson()

    companion object {
        private const val K_SETUP_DONE = "setup_done"
        private const val K_PROFILES = "profiles"
        private const val K_CURRENT_ID = "current_profile_id"
        private const val K_ACTIVE_INSTANCE = "active_instance"
        const val DEFAULT_URL = "http://127.0.0.1:16384"
    }

    var setupDone: Boolean
        get() = sp.getBoolean(K_SETUP_DONE, false)
        set(v) = sp.edit().putBoolean(K_SETUP_DONE, v).apply()

    /** 当前激活实例名（管理页里的实例选择）。 */
    var activeInstance: String
        get() = sp.getString(K_ACTIVE_INSTANCE, "default") ?: "default"
        set(v) = sp.edit().putString(K_ACTIVE_INSTANCE, v).apply()

    /**
     * 读取连接列表。兼容旧版本把管理令牌存成 adminKey 的配置：
     * 迁移到 webToken，并补上缺失的 id。
     */
    fun getProfiles(): MutableList<ConnectionProfile> {
        val raw = sp.getString(K_PROFILES, null) ?: return mutableListOf()
        val list = runCatching {
            val arr = JsonParser.parseString(raw).asJsonArray
            for (el in arr) {
                if (!el.isJsonObject) continue
                val o = el.asJsonObject
                if (!o.has("id")) o.addProperty("id", UUID.randomUUID().toString())
                if (o.get("label")?.isJsonPrimitive != true) o.addProperty("label", "")
                if (o.get("baseUrl")?.isJsonPrimitive != true) o.addProperty("baseUrl", DEFAULT_URL)
                if (!o.has("webToken") && o.has("adminKey")) {
                    o.addProperty("webToken", o.get("adminKey")?.takeIf { it.isJsonPrimitive }?.asString ?: "")
                }
                if (o.get("webToken")?.isJsonPrimitive != true) o.addProperty("webToken", "")
                if (o.get("secondKey")?.isJsonPrimitive != true) o.addProperty("secondKey", "")
                if (o.get("totpSecret")?.isJsonPrimitive != true) o.addProperty("totpSecret", "")
                o.remove("adminKey")
            }
            val type = object : TypeToken<MutableList<ConnectionProfile>>() {}.type
            gson.fromJson<MutableList<ConnectionProfile>>(arr.toString(), type) ?: mutableListOf()
        }.getOrDefault(mutableListOf())
        return list
    }

    private fun saveProfiles(list: List<ConnectionProfile>) {
        sp.edit().putString(K_PROFILES, gson.toJson(list)).apply()
    }

    fun saveProfile(p: ConnectionProfile) {
        val list = getProfiles()
        val idx = list.indexOfFirst { it.id == p.id }
        if (idx >= 0) list[idx] = p else list.add(p)
        saveProfiles(list)
        if (currentProfileId == null) currentProfileId = p.id
    }

    fun deleteProfile(id: String) {
        val list = getProfiles().filterNot { it.id == id }
        saveProfiles(list)
        if (currentProfileId == id) currentProfileId = list.firstOrNull()?.id
    }

    var currentProfileId: String?
        get() = sp.getString(K_CURRENT_ID, null)
        set(v) = sp.edit().putString(K_CURRENT_ID, v).apply()

    fun getCurrentProfile(): ConnectionProfile? {
        val id = currentProfileId ?: return null
        return getProfiles().firstOrNull { it.id == id }
    }

    /** 首次启动创建一个本机默认配置。 */
    fun ensureDefaultProfiles() {
        if (getProfiles().isEmpty()) {
            saveProfile(ConnectionProfile(label = "Local gateway", baseUrl = DEFAULT_URL))
        }
    }

    fun clear() = sp.edit().clear().apply()
}
