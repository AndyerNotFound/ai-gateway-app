package com.aigateway.app

import android.app.Application
import com.aigateway.app.data.ConnectionProfile
import com.aigateway.app.data.ConnectionStore
import com.aigateway.app.data.GatewayBackend
import com.aigateway.app.data.RunMode
import com.aigateway.app.embedded.EmbeddedBackend
import com.aigateway.app.embedded.EmbeddedHttpServer
import com.aigateway.app.embedded.GatewayEngine
import com.aigateway.app.net.RemoteBackend
import com.aigateway.app.data.SettingsStore
import com.google.android.material.color.DynamicColors
import com.google.android.material.color.DynamicColorsOptions
import java.io.File

/**
 * Application —— 主题/语言 + 运行模式/后端管理。
 */
class App : Application() {

    lateinit var connectionStore: ConnectionStore
        private set

    lateinit var settings: SettingsStore
        private set

    // 内嵌
    private var embeddedEngine: GatewayEngine? = null
    private var embeddedServer: EmbeddedHttpServer? = null
    private var embeddedBackend: EmbeddedBackend? = null

    // 远程
    private var remoteBackend: RemoteBackend? = null
    private var remoteKey: String? = null

    override fun onCreate() {
        super.onCreate()
        settings = SettingsStore(this)
        connectionStore = ConnectionStore(this)
        settings.applyThemeMode()
        settings.applyLanguage()
        // 动态取色: 按用户开关决定(每个 Activity 创建时读取)
        DynamicColors.applyToActivitiesIfAvailable(
            this,
            DynamicColorsOptions.Builder()
                .setPrecondition { _, _ -> settings.dynamicColors }
                .build()
        )
    }

    /** 当前后端(按模式)。未设置模式返回 null。 */
    fun backend(): GatewayBackend? = when (connectionStore.runMode) {
        RunMode.EMBEDDED -> embeddedBackend()
        RunMode.TERMUX -> remoteBackend()
        null -> null
    }

    /** 内嵌后端(惰性创建 + 启动服务器) */
    @Synchronized
    fun embeddedBackend(): EmbeddedBackend {
        embeddedBackend?.let { return it }
        val dir = File(filesDir, "embedded")
        val engine = GatewayEngine(File(dir, "config.json"))
        // 注入配置加密口令(启用加密时)
        engine.cryptPassword = if (settings.cryptEnabled) settings.cryptPassword else ""
        engine.load()
        if (engine.getConfig().name.isBlank()) {
            engine.updateConfig { it.copy(name = "default", port = 16384) }
        }
        val server = EmbeddedHttpServer(engine)
        server.start(engine.port())
        engine.log("内嵌网关启动, 端口 ${engine.port()}")
        embeddedEngine = engine
        embeddedServer = server
        applyGuardSettings()
        // 启用了保活则拉起前台服务
        if (settings.bgKeepAlive) {
            runCatching { com.aigateway.app.service.GatewayService.start(this) }
        }
        val b = EmbeddedBackend(engine, server)
        embeddedBackend = b
        return b
    }

    /** 把代码扫描设置应用到内嵌引擎 */
    fun applyGuardSettings() {
        val e = embeddedEngine ?: return
        e.guardEnabled = settings.guardEnabled
        e.guardLevel = runCatching {
            com.aigateway.app.embedded.CodeGuard.Level.valueOf(settings.guardLevel)
        }.getOrDefault(com.aigateway.app.embedded.CodeGuard.Level.MEDIUM)
        e.guardBlock = settings.guardAction == "BLOCK"
    }

    /** 远程后端(按当前连接配置)。配置变化会重建。 */
    @Synchronized
    fun remoteBackend(): RemoteBackend? {
        val profile = connectionStore.getCurrentProfile() ?: return null
        val key = profile.baseUrl + "|" + profile.adminKey
        if (remoteBackend != null && remoteKey == key) return remoteBackend
        remoteBackend?.close()
        val b = RemoteBackend(profile.baseUrl, profile.adminKey)
        remoteBackend = b
        remoteKey = key
        return b
    }

    /** 切换运行模式(清理旧后端) */
    @Synchronized
    fun setMode(mode: RunMode) {
        if (connectionStore.runMode == mode) return
        connectionStore.runMode = mode
        remoteBackend?.close()
        remoteBackend = null
        remoteKey = null
        if (mode == RunMode.EMBEDDED) {
            embeddedBackend() // 预热
        }
    }

    /** 更新远程连接配置并重建后端 */
    @Synchronized
    fun updateRemoteProfile(profile: ConnectionProfile) {
        connectionStore.saveProfile(profile)
        connectionStore.currentProfileId = profile.id
        remoteBackend?.close()
        remoteBackend = null
        remoteKey = null
    }

    fun embeddedEngineOrNull(): GatewayEngine? = embeddedEngine
}
