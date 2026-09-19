package com.aigateway.app.data

import android.content.Context
import android.content.SharedPreferences




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

    
    var token: String
        get() = sp.getString(K_TOKEN, "") ?: ""
        set(v) = sp.edit().putString(K_TOKEN, v.trim()).apply()

    
    var uid: String
        get() = sp.getString(K_UID, "") ?: ""
        set(v) = sp.edit().putString(K_UID, v).apply()

    
    var userName: String
        get() = sp.getString(K_NAME, "") ?: ""
        set(v) = sp.edit().putString(K_NAME, v).apply()

    
    var branch: String
        get() = sp.getString(K_BRANCH, "") ?: ""
        set(v) = sp.edit().putString(K_BRANCH, v.trim()).apply()

    val loggedIn: Boolean get() = serverUrl.isNotBlank() && token.isNotBlank()

    
    fun apiBase(): String {
        val b = branch
        return serverUrl + (if (b.isBlank()) "" else "/$b") + "/v1"
    }

    
    fun apiRoot(): String {
        val b = branch
        return serverUrl + (if (b.isBlank()) "" else "/$b")
    }

    fun clear() = sp.edit().clear().apply()
}
