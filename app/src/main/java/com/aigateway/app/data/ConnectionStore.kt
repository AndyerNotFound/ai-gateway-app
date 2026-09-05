package com.aigateway.app.data

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.util.UUID

/** 一个连接配置(远程网关) */
data class ConnectionProfile(
    val id: String = UUID.randomUUID().toString(),
    var label: String = "",
    var baseUrl: String = "http://127.0.0.1:16384",
    var adminKey: String = ""
) {
    fun displayName(): String = label.ifBlank { baseUrl }
}

/** 运行模式 */
enum class RunMode { EMBEDDED, TERMUX }

/**
 * 连接/模式配置存储 —— SharedPreferences 持久化。
 */
class ConnectionStore(context: Context) {

    private val sp: SharedPreferences =
        context.getSharedPreferences("ai_gateway_conn", Context.MODE_PRIVATE)
    private val gson = Gson()

    companion object {
        private const val K_SETUP_DONE = "setup_done"
        private const val K_MODE = "run_mode"
        private const val K_PROFILES = "profiles"
        private const val K_CURRENT_ID = "current_profile_id"
        private const val K_ACTIVE_INSTANCE = "active_instance"
        const val DEFAULT_TERMUX_URL = "http://127.0.0.1:16384"
        const val DEFAULT_LAN_URL = "http://192.168.1.7:16384"
    }

    var setupDone: Boolean
        get() = sp.getBoolean(K_SETUP_DONE, false)
        set(v) = sp.edit().putBoolean(K_SETUP_DONE, v).apply()

    var runMode: RunMode?
        get() = sp.getString(K_MODE, null)?.let {
            runCatching { RunMode.valueOf(it) }.getOrNull()
        }
        set(v) = sp.edit().putString(K_MODE, v?.name).apply()

    /** 当前激活实例名(管理面板里选中的实例) */
    var activeInstance: String
        get() = sp.getString(K_ACTIVE_INSTANCE, "default") ?: "default"
        set(v) = sp.edit().putString(K_ACTIVE_INSTANCE, v).apply()

    // ---- 连接配置列表 ----

    fun getProfiles(): MutableList<ConnectionProfile> {
        val raw = sp.getString(K_PROFILES, null) ?: return mutableListOf()
        return runCatching {
            val type = object : TypeToken<MutableList<ConnectionProfile>>() {}.type
            gson.fromJson<MutableList<ConnectionProfile>>(raw, type) ?: mutableListOf()
        }.getOrDefault(mutableListOf())
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

    /** 确保至少有一个默认配置(首次进 TERMUX 模式用) */
    fun ensureDefaultProfiles() {
        if (getProfiles().isEmpty()) {
            saveProfile(ConnectionProfile(label = "本机 Termux", baseUrl = DEFAULT_TERMUX_URL))
        }
    }

    /** 重置全部(调试用) */
    fun clear() = sp.edit().clear().apply()
}
