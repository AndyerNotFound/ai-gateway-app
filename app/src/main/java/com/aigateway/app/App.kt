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
import com.aigateway.app.data.UserStore
import com.aigateway.app.net.UserBackend
import com.google.android.material.color.DynamicColors
import com.google.android.material.color.DynamicColorsOptions
import java.io.File




class App : Application() {

    lateinit var connectionStore: ConnectionStore
        private set

    lateinit var settings: SettingsStore
        private set

    lateinit var userStore: UserStore
        private set

    private var userBackend: UserBackend? = null

    
    private var embeddedEngine: GatewayEngine? = null
    private var embeddedServer: EmbeddedHttpServer? = null
    private var embeddedBackend: EmbeddedBackend? = null

    
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
        userStore = UserStore(this)
        settings.applyThemeMode()
        settings.applyLanguage()
        
        DynamicColors.applyToActivitiesIfAvailable(
            this,
            DynamicColorsOptions.Builder()
                .setPrecondition { _, _ -> settings.dynamicColors }
                .build()
        )
    }

    
    fun backend(): GatewayBackend? = when (connectionStore.runMode) {
        RunMode.EMBEDDED -> embeddedBackend()
        RunMode.TERMUX -> remoteBackend()
        RunMode.USER, null -> null
    }

    
    @Synchronized
    fun embeddedBackend(): EmbeddedBackend {
        embeddedBackend?.let { return it }
        val dir = File(filesDir, "embedded")
        val engine = GatewayEngine(File(dir, "config.json"))
        
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
        
        if (settings.bgKeepAlive) {
            runCatching { com.aigateway.app.service.GatewayService.start(this) }
        }
        val b = EmbeddedBackend(engine, server)
        embeddedBackend = b
        return b
    }

    
    fun applyGuardSettings() {
        val e = embeddedEngine ?: return
        e.guardEnabled = settings.guardEnabled
        e.guardLevel = runCatching {
            com.aigateway.app.embedded.CodeGuard.Level.valueOf(settings.guardLevel)
        }.getOrDefault(com.aigateway.app.embedded.CodeGuard.Level.MEDIUM)
        e.guardBlock = settings.guardAction == "BLOCK"
    }

    
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

    
    @Synchronized
    fun setMode(mode: RunMode) {
        if (connectionStore.runMode == mode) return
        connectionStore.runMode = mode
        remoteBackend?.close()
        remoteBackend = null
        remoteKey = null
        if (mode == RunMode.EMBEDDED) {
            embeddedBackend() 
        }
    }

    
    @Synchronized
    fun updateRemoteProfile(profile: ConnectionProfile) {
        connectionStore.saveProfile(profile)
        connectionStore.currentProfileId = profile.id
        remoteBackend?.close()
        remoteBackend = null
        remoteKey = null
    }

    fun embeddedEngineOrNull(): GatewayEngine? = embeddedEngine

    
    @Synchronized
    fun userBackend(): UserBackend {
        userBackend?.let { return it }
        val b = UserBackend(userStore)
        userBackend = b
        return b
    }

    
    val isUserMode: Boolean get() = settings.appMode == "user"
}
