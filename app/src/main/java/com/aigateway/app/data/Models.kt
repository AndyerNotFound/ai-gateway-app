package com.aigateway.app.data

import com.google.gson.JsonObject






data class Instance(
    val name: String = "",
    val port: Int = 16384,
    val running: Boolean = false,
    val chCount: Int = 0,
    val tlsOn: Boolean = false,
    val current: Boolean = false,
    val pathPrefix: String? = null
)

data class InstancesResponse(
    val instances: List<Instance> = emptyList(),
    val current: String = "",
    val multi: Boolean = false,
    val mainPort: Int = 0
)

data class Proxy(
    val type: String = "socks5",
    val host: String = "",
    val port: Int = 0,
    val username: String? = null,
    val password: String? = null
)

data class Channel(
    val name: String = "",
    val type: String = "openai",
    val baseUrl: String = "",
    val apiKey: String = "",
    val label: String? = null,
    val proxy: String? = null,
    val models: List<String>? = null,
    val modelMap: Map<String, String>? = null,
    val default: Boolean = false,
    val delayMs: Int = 0,
    val insecure: Boolean = false,
    val useResponses: Boolean = false,
    val hasKey: Boolean = false,
    val keyPrefix: String? = null,
    val oldName: String? = null   
)


data class ApiKeyEntry(
    val key: String = "",
    val name: String = "",
    val enable: Boolean = true,
    val quotaTokens: Long = 0,
    val usedTokens: Long = 0,
    val models: List<String>? = null,
    val channels: List<String>? = null,
    val expiresAt: String = "",
    val note: String = "",
    val createdAt: String = ""
)

data class KeysResponse(
    val keys: List<ApiKeyEntry> = emptyList(),
    val gatewayKeySet: Boolean = false
)

data class Tls(
    val enable: Boolean = false,
    val cert: String = "cert.pem",
    val key: String = "key.pem",
    val port: Int? = null
)

data class Redact(val enable: Boolean = true, val extra: List<String>? = null)

data class ReplaceRule(
    val re: String = "",
    val to: String = "",
    val ci: Boolean = false
)

data class Replace(
    val out: List<ReplaceRule> = emptyList(),
    val inc: List<ReplaceRule> = emptyList()
)

data class Record(
    val enable: Boolean = false,
    val server: String = "",
    val maxChars: Int = 200000
)

data class ThinkingSummary(
    val enable: Boolean = false,
    val mode: String = "truncate",        
    val maxCharsPerSegment: Int = 80,
    val summarizeBaseUrl: String = "",    
    val summarizeApiKey: String = "",     
    val summarizeModel: String = "",      
    val summarizePrompt: String = "用一句话中文概括以下思考片段:",
    val maxSegments: Int = 12
)

data class ModelSync(
    val enable: Boolean = true,
    val intervalHours: Int = 24
)


data class OpenaiExtras(
    val enable: Boolean = false,
    val upstreamResponses: Boolean = false
)

data class GatewayConfig(
    val name: String = "",
    val port: Int = 16384,
    val host: String = "0.0.0.0",
    val gatewayKey: String = "",
    val adminKey: String = "",
    val tls: Tls = Tls(),
    val redact: Redact = Redact(),
    val replace: Replace = Replace(),
    val record: Record = Record(),
    val thinkingSummary: ThinkingSummary = ThinkingSummary(),
    val modelSync: ModelSync = ModelSync(),
    val openaiExtras: OpenaiExtras = OpenaiExtras(),
    val keyLength: Int? = null,
    val registration: JsonObject? = null,
    val proxies: Map<String, Proxy> = emptyMap(),
    val channels: List<Channel> = emptyList(),
    val modelMap: Map<String, String> = emptyMap(),
    val models: List<String> = emptyList()
)

data class ChannelStat(
    val requests: Long = 0,
    val errors: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0
)

data class Stats(
    val requests: Long = 0,
    val errors: Long = 0,
    val uptime: Long = 0,
    val startedAt: Any? = null,
    val byChannel: Map<String, ChannelStat> = emptyMap()
)

data class RequestEntry(
    val id: String = "",
    val time: String = "",
    val model: String = "",
    val channel: String = "",
    val status: Int = 0,
    val duration: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0
)

data class RecordBody(
    val ok: Boolean = false,
    val record: RecordDetail? = null
)

data class RecordDetail(
    val id: String = "",
    val time: String = "",
    val model: String = "",
    val channel: String = "",
    val status: Int = 0,
    val duration: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val request: Any? = null,
    val response: Any? = null
)


data class ChatMessage(
    val role: String = "user",
    val content: String = ""
)


data class ActionResult(
    val ok: Boolean = false,
    val output: String = "",
    val restarting: Boolean = false,
    val self: Boolean = false,
    val error: String? = null
)


data class ModelsResult(
    val models: List<String> = emptyList(),
    val error: String? = null
)
