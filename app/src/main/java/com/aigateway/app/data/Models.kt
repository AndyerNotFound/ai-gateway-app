package com.aigateway.app.data

import com.google.gson.JsonObject

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
    // 上游余额透传(查余额用): 相对地址按 baseUrl 拼; path=点路径; unit=展示单位
    // 空串 = 提交时清空该字段(后端对「未提交」才继承旧值)
    val balanceUrl: String? = null,
    val balancePath: String? = null,
    val balanceUnit: String? = null,
    // 渠道级预警阈值: "5" 或 "CNY=5,USD=1"; 空=用全局默认
    val warnBelow: String? = null,
    val hasKey: Boolean = false,
    val keyPrefix: String? = null,
    val oldName: String? = null   // 改名时=原渠道名(仅请求用, Gson 默认跳过 null)
)

/** 卡密(多用户Key) */
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
    val forceChannel: String? = null,
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
    val contextWindows: List<CtxWindow>? = null,
    val contextLimit: CtxLimit? = null,
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
    /** 正在跑的上游请求数(网关内存计数) */
    val inflight: Int = 0,
    val retries: Long = 0,
    val onceChannel: String? = null,
    val context: Ctx? = null,
    val errors: Long = 0,
    val uptime: Long = 0,
    val startedAt: Any? = null,
    val byChannel: Map<String, ChannelStat> = emptyMap()
)

/** 网关记录的最近一次上下文占用(取自上游 usage.prompt_tokens) */
data class Ctx(
    val model: String = "",
    /** 最近这次请求走的渠道 */
    val channel: String = "",
    /** 上游没给 usage, 这个数是本地估算的 */
    val est: Boolean = false,
    val prompt: Long = 0,
    val completion: Long = 0,
    val window: Long = 0,
    val percent: Double? = null,
    val at: Long = 0,
    /** 软上限(百分比): 到这儿开始提示 */
    val soft: Double = 80.0,
    /** 硬上限(百分比): 0=关闭, 超过网关直接 400 */
    val hard: Double = 0.0
)

/** 上下文软/硬上限(占窗口百分比) + 硬上限用的估算比例 */
/** 一个最近活跃实例的上下文快照(轮播用) */
data class ActiveInst(
    val name: String = "",
    val at: Long = 0,
    val model: String = "",
    val channel: String = "",
    val prompt: Long = 0,
    val window: Long = 0,
    val percent: Double? = null,
    val soft: Double = 80.0,
    val hard: Double = 0.0,
    val est: Boolean = false,
    /** 该实例正在跑的请求数 */
    val inflight: Int = 0
)

data class ActiveResp(
    val current: String = "",
    val active: List<ActiveInst> = emptyList()
)

data class CtxLimit(
    val soft: Double = 80.0,
    val hard: Double = 0.0,
    val charsPerToken: Double = 4.0
)

/** 上下文窗口匹配表的一行: 模型名通配 -> 窗口大小 */
data class CtxWindow(
    val match: String = "",
    val window: Long = 0
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
