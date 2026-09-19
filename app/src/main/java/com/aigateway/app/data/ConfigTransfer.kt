package com.aigateway.app.data

import android.content.Context
import android.net.Uri
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser







class ConfigTransfer(private val context: Context) {

    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    
    sealed class ImportResult {
        data class Success(val config: GatewayConfig, val wasEncrypted: Boolean) : ImportResult()
        object NeedPassword : ImportResult()          
        data class WrongPassword(val message: String) : ImportResult()
        data class Invalid(val message: String) : ImportResult()
    }

    



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

        
        val cfg = try {
            val je = JsonParser.parseString(plain)
            if (!je.isJsonObject) return ImportResult.Invalid("不是 JSON 对象")
            val obj = je.asJsonObject
            
            if (!obj.has("channels") && !obj.has("listen") && !obj.has("port")) {
                return ImportResult.Invalid("不像 ai-gateway 配置(缺 channels / listen)")
            }
            normalize(obj)
        } catch (e: Exception) {
            return ImportResult.Invalid("JSON 解析失败: ${e.message}")
        }
        return ImportResult.Success(cfg, encrypted)
    }

    
    private fun normalize(obj: JsonObject): GatewayConfig {
        val copy = obj.deepCopy()
        
        copy.getAsJsonObject("listen")?.let { l ->
            if (!copy.has("port")) l.get("port")?.let { copy.add("port", it) }
            if (!copy.has("host")) l.get("host")?.let { copy.add("host", it) }
        }
        return gson.fromJson(copy, GatewayConfig::class.java) ?: GatewayConfig()
    }

    



    fun buildExport(config: GatewayConfig, password: String?): String {
        
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
