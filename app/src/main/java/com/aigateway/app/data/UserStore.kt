package com.aigateway.app.data

import android.content.Context
import android.content.SharedPreferences

/**
 * 用户端凭据存储 —— 服务器地址 + 卡密(或账密登录后的卡密) + 分支(实例名)。
 */
class UserStore(context: Context) {

    private val sp: SharedPreferences =
        context.getSharedPreferences("ai_gateway_user", Context.MODE_PRIVATE)

    companion object {
        private const val K_SERVER = "server_url"
        private const val K_TOKEN = "token"
        private const val K_UID = "uid"
        private const val K_NAME = "user_name"
        private const val K_BRANCH = "branch"
    }

    var serverUrl: String
        get() = sp.getString(K_SERVER, "") ?: ""
        set(v) = sp.edit().putString(K_SERVER, v.trim().removeSuffix("/")).apply()

    /** 卡密 (sk-xxx) */
    var token: String
        get() = sp.getString(K_TOKEN, "") ?: ""
        set(v) = sp.edit().putString(K_TOKEN, v.trim()).apply()

    /** 账密登录的 UID (仅展示用) */
    var uid: String
        get() = sp.getString(K_UID, "") ?: ""
        set(v) = sp.edit().putString(K_UID, v).apply()

    /** 用户昵称/卡名 */
    var userName: String
        get() = sp.getString(K_NAME, "") ?: ""
        set(v) = sp.edit().putString(K_NAME, v).apply()

    /** 分支名(实例名, 空=default) */
    var branch: String
        get() = sp.getString(K_BRANCH, "") ?: ""
        set(v) = sp.edit().putString(K_BRANCH, v.trim()).apply()

    val loggedIn: Boolean get() = serverUrl.isNotBlank() && token.isNotBlank()

    /** API base: http://host:port/[分支/]v1 */
    fun apiBase(): String {
        val b = branch
        return serverUrl + (if (b.isBlank()) "" else "/$b") + "/v1"
    }

    /** 无 /v1 的根(用于 /credits /status 等) */
    fun apiRoot(): String {
        val b = branch
        return serverUrl + (if (b.isBlank()) "" else "/$b")
    }

    fun clear() = sp.edit().clear().apply()
}
