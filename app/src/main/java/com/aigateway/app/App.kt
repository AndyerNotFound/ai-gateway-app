package com.aigateway.app

import android.app.Application
import com.aigateway.app.data.ConnectionProfile
import com.aigateway.app.data.ConnectionStore
import com.aigateway.app.data.GatewayBackend
import com.aigateway.app.data.SettingsStore
import com.aigateway.app.net.RemoteBackend
import com.google.android.material.color.DynamicColors
import com.google.android.material.color.DynamicColorsOptions

/** Application —— 主题/语言 + 远程管理后端。 */
class App : Application() {

    lateinit var connectionStore: ConnectionStore
        private set

    lateinit var settings: SettingsStore
        private set

    private var remoteBackend: RemoteBackend? = null
    private var remoteKey: String? = null

    override fun onCreate() {
        Thread.setDefaultUncaughtExceptionHandler { _, e ->
            try {
                java.io.File(filesDir, "crash.txt").writeText(
                    (e.message ?: "") + "\n\n" + e.stackTraceToString()
                )
            } catch (_: Exception) {}
            android.os.Process.killProcess(android.os.Process.myPid())
        }
        super.onCreate()
        settings = SettingsStore(this)
        connectionStore = ConnectionStore(this)
        settings.applyThemeMode()
        settings.applyLanguage()
        DynamicColors.applyToActivitiesIfAvailable(
            this,
            DynamicColorsOptions.Builder()
                .setPrecondition { _, _ -> settings.dynamicColors }
                .build()
        )
    }

    /** 当前远程后端；没有连接配置时返回 null。 */
    fun backend(): GatewayBackend? = remoteBackend()

    @Synchronized
    fun remoteBackend(): RemoteBackend? {
        val profile = connectionStore.getCurrentProfile() ?: return null
        val key = profile.baseUrl + "|" + profile.webToken + "|" + profile.secondKey + "|" + profile.totpSecret
        if (remoteBackend != null && remoteKey == key) return remoteBackend
        remoteBackend?.close()
        val b = RemoteBackend(profile.baseUrl, profile.webToken, profile.secondKey, profile.totpSecret)
        remoteBackend = b
        remoteKey = key
        return b
    }

    /** 保存连接并重建后端。 */
    @Synchronized
    fun updateRemoteProfile(profile: ConnectionProfile) {
        connectionStore.saveProfile(profile)
        connectionStore.currentProfileId = profile.id
        remoteBackend?.close()
        remoteBackend = null
        remoteKey = null
    }
}
