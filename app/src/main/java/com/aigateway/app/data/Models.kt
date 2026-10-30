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
    val path: String? = null,
    val probe: Boolean = false,
    val lockAt: Long? = null,
    val lockUntil: Long? = null,
    val transcreet: String? = null,
    val anthropicVersion: String? = null,
    val addUsage: Boolean? = null,
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

data class ModelSync(
    val enable: Boolean = true,
    val intervalHours: Int = 24,
    val intervalMin: Int? = null
)

/** 实例配置（与管理 API 的 config 字段对齐）。 */
data class GatewayConfig(
    val forceChannel: String? = null,
    val name: String = "",
    val port: Int = 16384,
    val host: String = "0.0.0.0",
    val gatewayKey: String = "",
    val webToken: String = "",
    val tls: Tls = Tls(),
    val redact: Redact = Redact(),
    val replace: Replace = Replace(),
    val record: Record = Record(),
    val modelSync: ModelSync = ModelSync(),
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

data class ModelStat(
    val requests: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cached: Long = 0
)

data class StatsTotals(
    val instances: Int = 0,
    val requests: Long = 0,
    val errors: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0
)

data class InstanceStat(
    val name: String = "",
    val requests: Long = 0,
    val errors: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val byChannel: Map<String, ChannelStat> = emptyMap(),
    val byModel: Map<String, ModelStat> = emptyMap(),
    val disabled: Boolean = false
)

data class StatsAll(
    val totals: StatsTotals = StatsTotals(),
    val byModel: Map<String, ModelStat> = emptyMap(),
    val instances: List<InstanceStat> = emptyList()
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
    val byChannel: Map<String, ChannelStat> = emptyMap(),
    val byModel: Map<String, ModelStat> = emptyMap()
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
