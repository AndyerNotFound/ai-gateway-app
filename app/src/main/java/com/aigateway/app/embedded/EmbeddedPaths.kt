package com.aigateway.app.embedded

import android.content.Context
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.security.SecureRandom

/** 内置网关的文件布局：assets/nodejs-project 复制到 filesDir 后可写。 */
object EmbeddedPaths {

    const val NODE_VERSION = "18.20.4"
    const val DEFAULT_PORT = 16385

    fun root(ctx: Context): File = File(ctx.filesDir, "nodejs-project")
    fun dataDir(ctx: Context): File = File(root(ctx), "data")
    fun configFile(ctx: Context): File = File(dataDir(ctx), "config.json")
    fun logFile(ctx: Context): File = File(dataDir(ctx), "embedded.log")
    fun mainScript(ctx: Context): File = File(root(ctx), "main.js")
    fun statusFile(ctx: Context): File = File(ctx.filesDir, "embedded-status.json")

    data class Status(
        val state: String,
        val port: Int,
        val pid: Int,
        val since: Long,
        val error: String,
    ) {
        val running: Boolean get() = state == "running"
    }

    fun readStatus(ctx: Context): Status {
        val f = statusFile(ctx)
        if (!f.exists()) return Status("stopped", portOf(ctx), 0, 0, "")
        return try {
            val o = JsonParser.parseString(f.readText()).asJsonObject
            Status(
                state = o.get("state")?.asString ?: "stopped",
                port = o.get("port")?.asInt ?: portOf(ctx),
                pid = o.get("pid")?.asInt ?: 0,
                since = o.get("since")?.asLong ?: 0,
                error = o.get("error")?.asString ?: "",
            )
        } catch (_: Exception) {
            Status("stopped", portOf(ctx), 0, 0, "")
        }
    }

    fun writeStatus(ctx: Context, state: String, port: Int, error: String = "") {
        val o = JsonObject().apply {
            addProperty("state", state)
            addProperty("port", port)
            addProperty("pid", android.os.Process.myPid())
            addProperty("since", System.currentTimeMillis())
            addProperty("error", error)
        }
        try { statusFile(ctx).writeText(o.toString()) } catch (_: Exception) {}
    }

    fun portOf(ctx: Context): Int = try {
        val o = JsonParser.parseString(configFile(ctx).readText()).asJsonObject
        o.getAsJsonObject("listen")?.get("port")?.asInt ?: DEFAULT_PORT
    } catch (_: Exception) {
        DEFAULT_PORT
    }

    fun tokenOf(ctx: Context): String = try {
        val o = JsonParser.parseString(configFile(ctx).readText()).asJsonObject
        o.get("webToken")?.asString.orEmpty()
    } catch (_: Exception) {
        ""
    }

    /** 首次启动/版本升级时把 JS 资产铺到 filesDir，data/ 目录保持不变。 */
    fun installAssets(ctx: Context) {
        val root = root(ctx)
        val stamp = File(root, ".assets-version")
        val want = "${BuildConfigVersion.NAME}-${BuildConfigVersion.CODE}"
        if (stamp.exists() && stamp.readText().trim() == want && File(root, "main.js").exists()) return

        root.mkdirs()
        root.listFiles()?.forEach { f ->
            if (f.name != "data") f.deleteRecursively()
        }
        copyAssetDir(ctx, "nodejs-project", root)
        stamp.writeText(want)
        ensureDefaultConfig(ctx)
    }

    private fun copyAssetDir(ctx: Context, assetPath: String, dest: File) {
        val children = ctx.assets.list(assetPath) ?: return
        if (children.isEmpty()) {
            dest.parentFile?.mkdirs()
            ctx.assets.open(assetPath).use { input ->
                dest.outputStream().use { out -> input.copyTo(out, 64 * 1024) }
            }
            return
        }
        dest.mkdirs()
        for (name in children) copyAssetDir(ctx, "$assetPath/$name", File(dest, name))
    }

    fun ensureDefaultConfig(ctx: Context): File {
        val f = configFile(ctx)
        if (f.exists() && f.length() > 0) return f
        f.parentFile?.mkdirs()
        val token = randomToken()
        val o = JsonObject().apply {
            add("listen", JsonObject().apply {
                addProperty("host", "127.0.0.1")
                addProperty("port", DEFAULT_PORT)
            })
            addProperty("webToken", token)
            addProperty("gatewayKey", "")
            add("panel", JsonObject().apply { addProperty("openBrowser", false) })
            add("modelSync", JsonObject().apply {
                addProperty("enable", true)
                addProperty("intervalHours", 24)
            })
            add("probe", JsonObject().apply { addProperty("enable", false) })
            add("record", JsonObject().apply {
                addProperty("enable", true)
                addProperty("server", "")
                addProperty("maxChars", 200000)
            })
            addProperty("keyLength", 24)
            add("channels", com.google.gson.JsonArray())
            add("apiKeys", com.google.gson.JsonArray())
        }
        f.writeText(o.toString())
        return f
    }

    private fun randomToken(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return android.util.Base64.encodeToString(
            bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING
        )
    }

    /** 避免 embedded 包反向依赖 BuildConfig 造成 R8 移除。 */
    private object BuildConfigVersion {
        val NAME = com.aigateway.app.BuildConfig.VERSION_NAME
        val CODE = com.aigateway.app.BuildConfig.VERSION_CODE
    }
}
