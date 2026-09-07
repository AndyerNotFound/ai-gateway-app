package com.aigateway.app.data

/**
 * ai-gateway 数据模型 —— 与 Node 版 admin API / config.json 字段对齐。
 * Gson 解析: 未知字段忽略, 缺失字段取默认值, 保证健壮。
 */

data class Instance(
    val name: String = "",
    val port: Int = 16384,
    val running: Boolean = false,
    val chCount: Int = 0,
    val tlsOn: Boolean = false,
    val current: Boolean = false
)

data class InstancesResponse(
    val instances: List<Instance> = emptyList(),
    val current: String = ""
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
    val keyPrefix: String? = null
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
    val mode: String = "truncate",        // truncate=按段截取开头(零延迟) | summarize=用便宜模型逐段总结
    val maxCharsPerSegment: Int = 80,
    val summarizeBaseUrl: String = "",    // OpenAI 兼容端点, 如 https://api.deepseek.com 或 http://127.0.0.1:16392
    val summarizeApiKey: String = "",     // 对应 apiKey(指向另一 gateway 实例时填该实例 gatewayKey)
    val summarizeModel: String = "",      // 模型名
    val summarizePrompt: String = "用一句话中文概括以下思考片段:",
    val maxSegments: Int = 12
)

data class ModelSync(
    val enable: Boolean = true,
    val intervalHours: Int = 24
)

/** OpenAI 扩展端点: enable=对外开放 /v1/responses 与 images/embeddings/audio 等; upstreamResponses=全局默认上游用 Responses API */
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

/** 聊天消息(简化, 支持 OpenAI 格式) */
data class ChatMessage(
    val role: String = "user",
    val content: String = ""
)

/** 后端通用操作结果 */
data class ActionResult(
    val ok: Boolean = false,
    val output: String = "",
    val restarting: Boolean = false,
    val self: Boolean = false,
    val error: String? = null
)

/** 模型列表拉取结果 */
data class ModelsResult(
    val models: List<String> = emptyList(),
    val error: String? = null
)
