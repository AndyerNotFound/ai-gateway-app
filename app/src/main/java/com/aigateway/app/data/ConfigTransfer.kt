package com.aigateway.app.data

import android.content.Context
import android.net.Uri
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * 配置导入 / 导出。
 *
 * 导出: 明文 JSON 或用本 App 的口令加密为 AGWENC1。
 * 导入: 自动识别 AGWENC1(需输入源口令解密) → 校验为合法配置 → 用本 App 口令重新加密存储。
 */
class ConfigTransfer(private val context: Context) {

    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    /** 导入结果 */
    sealed class ImportResult {
        data class Success(val config: GatewayConfig, val wasEncrypted: Boolean) : ImportResult()
        object NeedPassword : ImportResult()          // 是加密内容但未提供口令
        data class WrongPassword(val message: String) : ImportResult()
        data class Invalid(val message: String) : ImportResult()
    }

    /**
     * 解析导入内容。
     * @param srcPassword 源文件口令(明文文件传 null 或 "")
     */
    fun parseImport(raw: String, srcPassword: String?): ImportResult {
        val text = raw.trim()
        if (text.isEmpty()) return ImportResult.Invalid("文件为空")

        val encrypted = ConfigCrypto.isEncrypted(text)
        val plain: String = if (encrypted) {
            if (srcPassword.isNullOrEmpty()) return ImportResult.NeedPassword
            try {
                ConfigCrypto.decrypt(text, srcPassword)
            } catch (e: ConfigCrypto.CryptoException) {
                return ImportResult.WrongPassword(e.message ?: "解密失败")
            }
        } else text

        // 校验是合法配置 JSON
        val cfg = try {
            val je = JsonParser.parseString(plain)
            if (!je.isJsonObject) return ImportResult.Invalid("不是 JSON 对象")
            val obj = je.asJsonObject
            // 至少要像个 gateway 配置(有 channels 或 listen 之一)
            if (!obj.has("channels") && !obj.has("listen") && !obj.has("port")) {
                return ImportResult.Invalid("不像 ai-gateway 配置(缺 channels / listen)")
            }
            normalize(obj)
        } catch (e: Exception) {
            return ImportResult.Invalid("JSON 解析失败: ${e.message}")
        }
        return ImportResult.Success(cfg, encrypted)
    }

    /** 把导入的 JSON 归一化为 GatewayConfig(兼容 config.json 的 listen.port 结构) */
    private fun normalize(obj: JsonObject): GatewayConfig {
        val copy = obj.deepCopy()
        // listen.port → port / host
        copy.getAsJsonObject("listen")?.let { l ->
            if (!copy.has("port")) l.get("port")?.let { copy.add("port", it) }
            if (!copy.has("host")) l.get("host")?.let { copy.add("host", it) }
        }
        return gson.fromJson(copy, GatewayConfig::class.java) ?: GatewayConfig()
    }

    /**
     * 导出为文本。
     * @param password 非空则加密为 AGWENC1
     */
    fun buildExport(config: GatewayConfig, password: String?): String {
        // 输出成 gateway 兼容格式(listen.port 结构)
        val root = gson.toJsonTree(config).asJsonObject
        val listen = JsonObject().apply {
            addProperty("host", config.host)
            addProperty("port", config.port)
        }
        root.add("listen", listen)
        root.remove("port")
        root.remove("host")
        root.remove("name")
        val json = gson.toJson(root)
        return if (password.isNullOrEmpty()) json else ConfigCrypto.encrypt(json, password)
    }

    // ---------- 文件读写(SAF Uri) ----------

    fun readUri(uri: Uri): String =
        context.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
            ?: throw Exception("无法读取文件")

    fun writeUri(uri: Uri, text: String) {
        context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
            ?: throw Exception("无法写入文件")
    }

    companion object {
        const val DEFAULT_EXPORT_NAME = "ai-gateway-config.json"
        const val DEFAULT_EXPORT_NAME_ENC = "ai-gateway-config.agwenc"
    }
}
