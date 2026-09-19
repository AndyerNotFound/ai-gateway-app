package com.aigateway.app.data

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.util.UUID


data class ConnectionProfile(
    val id: String = UUID.randomUUID().toString(),
    var label: String = "",
    var baseUrl: String = "http://127.0.0.1:16384",
    var adminKey: String = ""
) {
    fun displayName(): String = label.ifBlank { baseUrl }
}


enum class RunMode { EMBEDDED, TERMUX, USER }




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
        const val DEFAULT_LAN_URL = "http://192.168.1.100:16384"
    }

    var setupDone: Boolean
        get() = sp.getBoolean(K_SETUP_DONE, false)
        set(v) = sp.edit().putBoolean(K_SETUP_DONE, v).apply()

    var runMode: RunMode?
        get() = sp.getString(K_MODE, null)?.let {
            runCatching { RunMode.valueOf(it) }.getOrNull()
        }
        set(v) = sp.edit().putString(K_MODE, v?.name).apply()

    
    var activeInstance: String
        get() = sp.getString(K_ACTIVE_INSTANCE, "default") ?: "default"
        set(v) = sp.edit().putString(K_ACTIVE_INSTANCE, v).apply()

    

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

    
    fun ensureDefaultProfiles() {
        if (getProfiles().isEmpty()) {
            saveProfile(ConnectionProfile(label = "本机 Termux", baseUrl = DEFAULT_TERMUX_URL))
        }
    }

    
    fun clear() = sp.edit().clear().apply()
}
