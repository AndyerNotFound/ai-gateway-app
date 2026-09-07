package com.aigateway.app.embedded

import com.aigateway.app.data.*
import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.File
import java.net.URLEncoder

/** 候选渠道 */
data class Candidate(val channel: Channel, val upstreamModel: String)

/** 引擎输出事件(服务器据此写 HTTP 响应) */
sealed class EngineEvent {
    data class Head(val status: Int, val streaming: Boolean, val channelName: String) : EngineEvent()
    data class Sse(val data: String) : EngineEvent()          // 流式 data 内容(不含 "data: " 前缀)
    data class JsonBody(val body: JsonObject) : EngineEvent() // 非流式 JSON
    data class Fail(val status: Int, val message: String) : EngineEvent()
}

/**
 * 内嵌 gateway 转发引擎 —— 移植自 gateway.js 核心。
 * 渠道路由(渠道 modelMap > models > default > 全部) + round-robin + 故障切换。
 */
class GatewayEngine(private val configFile: File) {

    private val gson = Gson()
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    @Volatile private var cfg: GatewayConfig = GatewayConfig()
    private val rr = HashMap<String, Int>()
    private val startedAt = System.currentTimeMillis()

    /** 配置加密口令(空=不加密)。由 App 设置注入。 */
    @Volatile var cryptPassword: String = ""

    /** 代码安全扫描配置(由 App 设置注入) */
    @Volatile var guardEnabled: Boolean = false
    @Volatile var guardLevel: CodeGuard.Level = CodeGuard.Level.MEDIUM
    @Volatile var guardBlock: Boolean = false   // true=拦截, false=仅标注

    // 统计
    private var statRequests = 0L
    private var statErrors = 0L
    private val byChannel = HashMap<String, ChannelStat>()
    private val recent = ArrayDeque<RequestEntry>()
    private val recentLock = Any()

    // 日志环形缓冲
    private val logBuffer = ArrayDeque<String>()
    private val logLock = Any()

    fun log(msg: String) {
        val line = "[${java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())}] $msg"
        synchronized(logLock) {
            logBuffer.addLast(line)
            while (logBuffer.size > 500) logBuffer.removeFirst()
        }
    }

    fun getLogs(lines: Int): String = synchronized(logLock) {
        logBuffer.toList().takeLast(lines).joinToString("\n")
    }

    companion object {
        private val RETRYABLE = setOf(401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 529)
        private const val MAX_RECENT = 200
    }

    // ================= 配置管理 =================

    @Synchronized
    fun load() {
        cfg = if (configFile.exists()) {
            runCatching {
                var raw = configFile.readText()
                // 加密配置: 用口令解密
                if (com.aigateway.app.data.ConfigCrypto.isEncrypted(raw)) {
                    raw = com.aigateway.app.data.ConfigCrypto.decrypt(raw, cryptPassword)
                }
                gson.fromJson(raw, GatewayConfig::class.java)
            }.getOrNull() ?: GatewayConfig(name = "default")
        } else GatewayConfig(name = "default")
    }

    @Synchronized
    fun save() {
        configFile.parentFile?.mkdirs()
        val json = gson.toJson(cfg)
        val out = if (cryptPassword.isNotEmpty())
            com.aigateway.app.data.ConfigCrypto.encrypt(json, cryptPassword) else json
        configFile.writeText(out)
    }

    /** 切换加密口令: 用新口令重写配置文件(空=转明文) */
    @Synchronized
    fun changeCryptPassword(newPass: String) {
        cryptPassword = newPass
        save()
    }

    @Synchronized
    fun getConfig(): GatewayConfig = cfg

    @Synchronized
    fun updateConfig(transform: (GatewayConfig) -> GatewayConfig) {
        cfg = transform(cfg)
        save()
    }

    fun port(): Int = cfg.port
    fun gatewayKey(): String = cfg.gatewayKey
    fun adminKey(): String = cfg.adminKey
    /** OpenAI 扩展端点总开关(路由 /v1/responses 等时判断) */
    fun openaiExtrasEnabled(): Boolean = cfg.openaiExtras.enable

    // ================= OpenAI 扩展直通端点 (images/embeddings/audio/completions/moderations) =================

    sealed class ExtraResult {
        data class Raw(val status: Int, val bytes: ByteArray, val contentType: String) : ExtraResult()
        data class Fail(val status: Int, val message: String) : ExtraResult()
    }

    /** 扩展端点直通: 只支持 openai 渠道; JSON 端点应用 modelMap 改名, multipart 原样透传; 响应字节原样返回 */
    fun extraEndpoint(pathname: String, bodyBytes: ByteArray, contentType: String): ExtraResult {
        if (!cfg.openaiExtras.enable) return ExtraResult.Fail(404, "unknown endpoint: $pathname (OpenAI 扩展端点未开启)")
        var model = ""
        var parsed: JsonObject? = null
        if (contentType.startsWith("application/json")) {
            parsed = runCatching { JsonParser.parseString(String(bodyBytes, Charsets.UTF_8)).asJsonObject }.getOrNull()
            model = parsed?.str("model") ?: ""
        }
        val candidates = pickChannels(model.ifBlank { null }).filter { it.channel.type == "openai" }
        if (candidates.isEmpty()) {
            synchronized(this) { statErrors++ }
            return ExtraResult.Fail(503, "no openai channel for extended endpoint $pathname (扩展端点只支持 openai 类型渠道)")
        }
        synchronized(this) { statRequests++ }
        log("→ [extra] $pathname model=${model.ifBlank { "-" }} (${candidates.size}个候选渠道)")
        var lastErr = ""
        var lastStatus = 0
        for (cand in candidates) {
            val ch = cand.channel
            try {
                var outBytes = bodyBytes
                if (parsed != null && cand.upstreamModel.isNotBlank() && parsed.str("model") != cand.upstreamModel) {
                    parsed.put("model", cand.upstreamModel)
                    outBytes = parsed.toString().toByteArray(Charsets.UTF_8)
                }
                val client = UpstreamClient.clientFor(resolveProxy(ch.proxy), ch.insecure)
                val rb = Request.Builder().url(joinUrl(ch.baseUrl, pathname))
                rb.header("authorization", "Bearer " + ch.apiKey)
                rb.header("Content-Type", contentType.ifBlank { "application/json" })
                rb.post(outBytes.toRequestBody(null))
                val resp = client.newCall(rb.build()).execute()
                val bytes = resp.body?.bytes() ?: ByteArray(0)
                val ct = resp.headers["content-type"] ?: contentType.ifBlank { "application/json" }
                if (!resp.isSuccessful) {
                    lastErr = "渠道 ${ch.name} 返回 ${resp.code}: " + String(bytes, Charsets.UTF_8).take(200)
                    lastStatus = resp.code
                    bumpChannelError(ch.name)
                    if (resp.code in RETRYABLE && candidates.size > 1) { continue }
                    synchronized(this) { statErrors++ }
                    return ExtraResult.Fail(resp.code, lastErr)
                }
                bumpChannel(ch.name, 0, 0)
                log("✓ [extra] $pathname ch=${ch.name} [${ch.type}] ${resp.code}")
                return ExtraResult.Raw(resp.code, bytes, ct)
            } catch (e: Exception) {
                lastErr = e.message ?: "connection error"
                lastStatus = 502
                bumpChannelError(ch.name)
                if (candidates.size > 1) continue
                synchronized(this) { statErrors++ }
                return ExtraResult.Fail(502, "upstream connection failed: $lastErr")
            }
        }
        synchronized(this) { statErrors++ }
        return ExtraResult.Fail(if (lastStatus > 0) lastStatus else 502, lastErr.ifBlank { "all channels failed" })
    }

    private fun resolveProxy(name: String?): Proxy? =
        if (name.isNullOrBlank()) null else cfg.proxies[name]

    // ================= 渠道路由 =================

    @Synchronized
    internal fun pickChannels(model: String?): List<Candidate> {
        val chs = cfg.channels
        val candidates = ArrayList<Candidate>()
        if (!model.isNullOrBlank()) {
            // 1) 渠道级 modelMap 精确命中
            for (ch in chs) {
                ch.modelMap?.get(model)?.let { candidates.add(Candidate(ch, it)) }
            }
            // 2) models 列表命中
            if (candidates.isEmpty()) {
                for (ch in chs) {
                    if (ch.models != null && ch.models.contains(model)) candidates.add(Candidate(ch, model))
                }
            }
        }
        // 3) default 渠道(可多个) 或全部渠道兜底
        if (candidates.isEmpty()) {
            val defs = chs.filter { it.default }
            val pool = if (defs.isNotEmpty()) defs else chs
            for (ch in pool) candidates.add(Candidate(ch, model ?: ""))
        }
        if (candidates.isEmpty()) return emptyList()
        // round-robin 旋转
        val key = model ?: "__nomodel__"
        val rot = ((rr[key] ?: 0) + 1) % candidates.size
        rr[key] = rot
        return candidates.subList(rot, candidates.size) + candidates.subList(0, rot)
    }

    // ================= 模型列表 =================

    @Synchronized
    fun modelsResponse(format: String): JsonObject {
        val set = LinkedHashSet<String>()
        for (ch in cfg.channels) {
            ch.models?.let { set.addAll(it) }
            ch.modelMap?.keys?.let { set.addAll(it) }
        }
        return if (format == "gemini") {
            val arr = JsonArray()
            set.forEach { m -> arr.add(jsonObj("name" to je("models/$m"), "displayName" to je(m))) }
            jsonObj("models" to arr)
        } else {
            val arr = JsonArray()
            set.forEach { m -> arr.add(jsonObj("id" to je(m), "object" to je("model"), "created" to je(nowSec()), "owned_by" to je("ai-gateway"))) }
            jsonObj("object" to je("list"), "data" to arr)
        }
    }

    // ================= 统计 =================

    @Synchronized
    fun getStats(): Stats = Stats(
        requests = statRequests, errors = statErrors,
        uptime = (System.currentTimeMillis() - startedAt) / 1000,
        startedAt = startedAt, byChannel = HashMap(byChannel)
    )

    @Synchronized
    fun getRecent(): List<RequestEntry> = synchronized(recentLock) { recent.toList().reversed() }

    private fun recordRecent(id: String, model: String, chName: String, status: Int, duration: Long, inT: Long, outT: Long) {
        synchronized(recentLock) {
            recent.addLast(RequestEntry(id, java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date()), model, chName, status, duration, inT, outT))
            while (recent.size > MAX_RECENT) recent.removeFirst()
        }
    }

    private fun bumpChannel(chName: String, inT: Long, outT: Long) {
        synchronized(this) {
            val cur = byChannel[chName] ?: ChannelStat()
            byChannel[chName] = ChannelStat(cur.requests + 1, cur.errors, cur.inputTokens + inT, cur.outputTokens + outT)
        }
    }

    private fun bumpChannelError(chName: String) {
        synchronized(this) {
            val cur = byChannel[chName] ?: ChannelStat()
            byChannel[chName] = ChannelStat(cur.requests, cur.errors + 1, cur.inputTokens, cur.outputTokens)
        }
    }

    // ================= chat 转发 =================

    fun chat(
        clientFormat: String,
        body: JsonObject,
        urlModel: String?,
        forceStream: Boolean,
        gatewayKeyOk: Boolean,
        clientApi: String = "chat"
    ): Flow<EngineEvent> = flow {
        if (!gatewayKeyOk) { emit(EngineEvent.Fail(401, "invalid gateway key")); return@flow }
        val toCanon = if (clientApi == "responses") Converters::responsesToCanonical else Converters.TO_CANON[clientFormat]
        if (toCanon == null) { emit(EngineEvent.Fail(400, "unknown client format")); return@flow }
        val canonical = try { toCanon(body, urlModel) } catch (e: Exception) {
            emit(EngineEvent.Fail(400, "invalid body: ${e.message}")); return@flow
        }
        if (forceStream) canonical.put("stream", true)
        val model = canonical.str("model")
        if (model.isNullOrBlank()) { emit(EngineEvent.Fail(400, "missing \"model\"")); return@flow }

        val candidates = pickChannels(model)
        if (candidates.isEmpty()) { emit(EngineEvent.Fail(503, "no channel configured")); return@flow }

        synchronized(this) { statRequests++ }
        val stream = canonical.bool("stream") ?: false
        val t0 = System.currentTimeMillis()
        val reqId = randId("req")
        log("→ [$clientFormat${if (clientApi == "responses") "/responses" else ""}] model=$model stream=$stream (${candidates.size}个候选渠道)")

        var attempt = 0
        var lastStatus = 0
        var lastErr = ""
        for (cand in candidates) {
            attempt++
            val ch = cand.channel
            try {
                val built = buildRequest(ch, clientFormat, clientApi, canonical, body, cand.upstreamModel, stream)
                val client = UpstreamClient.clientFor(resolveProxy(ch.proxy), ch.insecure)
                val reqBuilder = Request.Builder().url(built.url)
                built.headers.forEach { (k, v) -> reqBuilder.header(k, v) }
                reqBuilder.post(built.body.toString().toRequestBody(jsonMedia))
                val resp = client.newCall(reqBuilder.build()).execute()
                if (resp.isSuccessful) {
                    log("✓ ${ch.name} [${ch.type}] ${if (built.direct) "直通" else "转换"}")
                    handleSuccess(resp, ch, clientFormat, clientApi, canonical, built.direct, built.upApi, stream, model, reqId, t0)
                    return@flow
                }
                lastStatus = resp.code
                val errBody = resp.body?.string().orEmpty()
                resp.close()
                lastErr = extractUpstreamError(errBody, resp.code)
                log("✗ ${ch.name}: HTTP ${resp.code} $lastErr${if (resp.code in RETRYABLE && attempt < candidates.size) " → 切换下一渠道" else ""}")
                if (resp.code in RETRYABLE && attempt < candidates.size) {
                    bumpChannelError(ch.name); continue
                }
                bumpChannelError(ch.name)
                synchronized(this) { statErrors++ }
                recordRecent(reqId, model, ch.name, resp.code, System.currentTimeMillis() - t0, 0, 0)
                emit(EngineEvent.Fail(resp.code, lastErr))
                return@flow
            } catch (e: Exception) {
                lastErr = e.message ?: "connection error"
                lastStatus = 502
                bumpChannelError(ch.name)
                if (attempt < candidates.size) continue
                synchronized(this) { statErrors++ }
                recordRecent(reqId, model, ch.name, 502, System.currentTimeMillis() - t0, 0, 0)
                emit(EngineEvent.Fail(502, "upstream connection failed: $lastErr"))
                return@flow
            }
        }
        synchronized(this) { statErrors++ }
        emit(EngineEvent.Fail(if (lastStatus > 0) lastStatus else 502, lastErr.ifBlank { "all channels failed" }))
    }.flowOn(Dispatchers.IO)

    // ---- 构建上游请求 ----

    private data class Built(val url: String, val headers: Map<String, String>, val body: JsonObject, val direct: Boolean, val upApi: String)

    /** OpenAI 渠道是否用 Responses API 上游 (仅 openaiExtras.enable 时生效; 渠道 useResponses 覆盖全局 upstreamResponses) */
    private fun chUsesResponses(ch: Channel): Boolean {
        if (ch.type != "openai") return false
        val oe = cfg.openaiExtras
        if (!oe.enable) return false
        return if (ch.useResponses) true else oe.upstreamResponses
    }

    private fun buildRequest(ch: Channel, clientFormat: String, clientApi: String, canonical: JsonObject, origBody: JsonObject, upstreamModel: String, stream: Boolean): Built {
        val upApi = if (chUsesResponses(ch)) "responses" else "chat"
        val direct = clientFormat == ch.type && clientApi == upApi
        val headers = LinkedHashMap<String, String>()
        var url: String
        val bodyBuf: JsonObject
        if (direct) {
            val body = origBody.deepCopy()
            when (ch.type) {
                "openai" -> {
                    url = joinUrl(ch.baseUrl, if (upApi == "responses") "/v1/responses" else "/v1/chat/completions")
                    body.put("model", upstreamModel)
                    headers["authorization"] = "Bearer " + ch.apiKey
                }
                "claude" -> {
                    url = joinUrl(ch.baseUrl, "/v1/messages")
                    body.put("model", upstreamModel)
                    headers["x-api-key"] = ch.apiKey
                    headers["anthropic-version"] = "2023-06-01"
                }
                else -> {
                    val action = if (stream) "streamGenerateContent" else "generateContent"
                    url = joinUrl(ch.baseUrl, "/v1beta/models/" + URLEncoder.encode(upstreamModel, "UTF-8") + ":" + action) + if (stream) "?alt=sse" else ""
                    headers["x-goog-api-key"] = ch.apiKey
                }
            }
            bodyBuf = body
        } else {
            val uc = canonical.deepCopy()
            uc.put("model", upstreamModel)
            when (ch.type) {
                "openai" -> {
                    url = joinUrl(ch.baseUrl, if (upApi == "responses") "/v1/responses" else "/v1/chat/completions")
                    bodyBuf = if (upApi == "responses") Converters.canonicalToResponsesBody(uc) else Converters.BUILD_BODY["openai"]!!.invoke(uc)
                    headers["authorization"] = "Bearer " + ch.apiKey
                }
                "claude" -> {
                    url = joinUrl(ch.baseUrl, "/v1/messages")
                    bodyBuf = Converters.BUILD_BODY["claude"]!!.invoke(uc)
                    headers["x-api-key"] = ch.apiKey
                    headers["anthropic-version"] = "2023-06-01"
                }
                else -> {
                    val action = if (stream) "streamGenerateContent" else "generateContent"
                    url = joinUrl(ch.baseUrl, "/v1beta/models/" + URLEncoder.encode(upstreamModel, "UTF-8") + ":" + action) + if (stream) "?alt=sse" else ""
                    bodyBuf = Converters.BUILD_BODY["gemini"]!!.invoke(uc)
                    headers["x-goog-api-key"] = ch.apiKey
                }
            }
        }
        if (stream) headers["accept"] = "text/event-stream"
        return Built(url, headers, bodyBuf, direct, upApi)
    }

    private fun joinUrl(base: String, suffix: String): String {
        val b = base.removeSuffix("/")
        return when {
            suffix.startsWith("/v1beta/") && b.endsWith("/v1beta") -> b + suffix.substring(7)
            suffix.startsWith("/v1/") && b.endsWith("/v1") -> b + suffix.substring(3)
            else -> b + suffix
        }
    }

    // ---- 处理成功响应 ----

    private suspend fun FlowCollector<EngineEvent>.handleSuccess(
        resp: Response, ch: Channel, clientFormat: String, clientApi: String, canonical: JsonObject,
        direct: Boolean, upApi: String, stream: Boolean, model: String, reqId: String, t0: Long
    ) {
        if (direct) {
            // 同格式直通: 零损耗原样转发
            emit(EngineEvent.Head(200, stream, ch.name))
            if (stream) {
                var inT = 0L; var outT = 0L
                resp.body?.source()?.use { src ->
                    while (true) {
                        val line = src.readUtf8Line() ?: break
                        if (line.startsWith("data:")) {
                            val data = line.substring(5).trim()
                            if (data == "[DONE]") break
                            emit(EngineEvent.Sse(data))
                            // 尽力提取 usage(仅用于统计, 不阻塞)
                            val u = safeParse(data)?.takeIf { it.isJsonObject }?.asJsonObject?.obj("usage")
                            if (u != null) { inT = u.int("prompt_tokens")?.toLong() ?: inT; outT = u.int("completion_tokens")?.toLong() ?: outT }
                        }
                    }
                }
                bumpChannel(ch.name, inT, outT)
                recordRecent(reqId, model, ch.name, 200, System.currentTimeMillis() - t0, inT, outT)
            } else {
                val txt = resp.body?.string().orEmpty()
                resp.close()
                val j = safeParse(txt)?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
                val u = j.obj("usage")
                val inT = (u?.int("prompt_tokens") ?: u?.int("input_tokens") ?: 0).toLong()
                val outT = (u?.int("completion_tokens") ?: u?.int("output_tokens") ?: 0).toLong()
                bumpChannel(ch.name, inT, outT)
                recordRecent(reqId, model, ch.name, 200, System.currentTimeMillis() - t0, inT, outT)
                emit(EngineEvent.JsonBody(j))
            }
            return
        }

        // 跨格式: 收集上游(可能流式) → canonical 响应 → 客户端格式
        val cresp = collectToCanonical(resp, upApi)
        resp.close()
        val usage = cresp.obj("usage") ?: JsonObject()
        val inT = (usage.int("input") ?: 0).toLong()
        val outT = (usage.int("output") ?: 0).toLong()
        bumpChannel(ch.name, inT, outT)
        recordRecent(reqId, model, ch.name, 200, System.currentTimeMillis() - t0, inT, outT)

        emit(EngineEvent.Head(200, stream, ch.name))
        if (stream) {
            // 伪流式: 按客户端格式发 chunk + 结束
            val chunks = if (clientFormat == "openai" && clientApi == "responses")
                Converters.buildResponsesStreamChunks(applyGuard(cresp), model)
            else
                buildStreamChunks(clientFormat, applyGuard(cresp), model)
            for (chunk in chunks) emit(EngineEvent.Sse(chunk))
        } else {
            val guarded = applyGuard(cresp)
            val out = when {
                clientFormat == "openai" && clientApi == "responses" -> Converters.canonicalToResponsesResp(guarded, model)
                clientFormat == "openai" -> Converters.canonicalToOpenAIResp(guarded, model)
                clientFormat == "claude" -> Converters.canonicalToClaudeResp(guarded, model)
                else -> Converters.canonicalToGeminiResp(guarded, model)
            }
            emit(EngineEvent.JsonBody(out))
        }
    }

    /**
     * 代码安全扫描: 命中时按配置标注或拦截。
     * 仅作用于跨格式路径的 canonical 响应(同格式直通不改动内容)。
     */
    private fun applyGuard(cresp: JsonObject): JsonObject {
        if (!guardEnabled) return cresp
        val text = cresp.str("text") ?: return cresp
        if (text.isBlank()) return cresp
        val r = runCatching { CodeGuard.scan(text, guardLevel) }.getOrNull() ?: return cresp
        if (!r.hasRisk) return cresp
        log("⚠ 代码扫描命中 ${r.findings.size} 条 (${r.maxLevel}): ${r.findings.joinToString { it.ruleId }}")
        val banner = buildString {
            append("\n\n---\n⚠️ ")
            append(if (guardBlock) "内容已被拦截" else "安全提醒")
            append(" · ")
            append(r.findings.size)
            append(" 项风险 (")
            append(r.maxLevel)
            append(")\n")
            r.findings.forEach { append("• [").append(it.level).append("] ").append(it.title).append("\n") }
            append("扫描为辅助提醒, 执行前请自行审查代码。\n---\n")
        }
        val newText = if (guardBlock) banner.trimStart() else text + banner
        val out = cresp.deepCopy()
        out.put("text", newText)
        return out
    }

    /** 收集上游响应为 canonical 响应(支持流式累积或非流式) */
    private fun collectToCanonical(resp: Response, upFormat: String): JsonObject {
        val ct = resp.body?.contentType()?.toString() ?: ""
        val isEventStream = ct.contains("event-stream")
        if (!isEventStream) {
            val j = safeParse(resp.body?.string())?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
            return if (upFormat == "responses") Converters.responsesRespToCanonical(j) else Converters.UP_RESP[upFormat]!!.invoke(j)
        }
        // 流式: 累积文本
        val text = StringBuilder()
        val reasoning = StringBuilder()
        var inT = 0; var outT = 0
        resp.body?.source()?.use { src ->
            while (true) {
                val line = src.readUtf8Line() ?: break
                if (!line.startsWith("data:")) continue
                val data = line.substring(5).trim()
                if (data == "[DONE]") break
                val j = safeParse(data)?.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                when (upFormat) {
                    "responses" -> {
                        when (j.str("type")) {
                            "response.output_text.delta" -> j.str("delta")?.let { text.append(it) }
                            "response.function_call_arguments.delta" -> { /* 伪流式不做工具参数累积到文本 */ }
                            "response.completed", "response.incomplete", "response.failed" -> {
                                val r = j.obj("response")
                                val u = r?.obj("usage")
                                u?.let { inT = it.int("input_tokens") ?: inT; outT = it.int("output_tokens") ?: outT }
                            }
                        }
                    }
                    "openai" -> {
                        val delta = j.arr("choices")?.get(0)?.asJsonObject?.obj("delta")
                        delta?.str("content")?.let { text.append(it) }
                        (delta?.str("reasoning_content") ?: delta?.str("reasoning"))?.let { reasoning.append(it) }
                        j.obj("usage")?.let { inT = it.int("prompt_tokens") ?: inT; outT = it.int("completion_tokens") ?: outT }
                    }
                    "claude" -> {
                        if (j.str("type") == "content_block_delta") {
                            val d = j.obj("delta")
                            d?.str("text")?.let { text.append(it) }
                            d?.str("thinking")?.let { reasoning.append(it) }
                        }
                        j.obj("usage")?.let { outT = it.int("output_tokens") ?: outT }
                        j.obj("message")?.obj("usage")?.let { inT = it.int("input_tokens") ?: inT }
                    }
                    else -> {
                        val parts = j.arr("candidates")?.get(0)?.asJsonObject?.obj("content")?.arr("parts")
                        parts?.forEach { pEl ->
                            if (pEl.isJsonObject) {
                                val p = pEl.asJsonObject
                                p.str("text")?.let { if (p.bool("thought") == true) reasoning.append(it) else text.append(it) }
                            }
                        }
                        val u = j.obj("usageMetadata") ?: j.obj("usage_metadata")
                        u?.let { inT = it.int("promptTokenCount") ?: inT; outT = it.int("candidatesTokenCount") ?: outT }
                    }
                }
            }
        }
        val cresp = JsonObject()
        cresp.put("text", text.toString())
        if (reasoning.isNotEmpty()) cresp.put("reasoning", reasoning.toString())
        cresp.put("finish_reason", "stop")
        cresp.add("usage", jsonObj("input" to je(inT), "output" to je(outT)))
        return cresp
    }

    /** 跨格式伪流式: 构造客户端格式的 SSE chunk */
    private fun buildStreamChunks(clientFormat: String, cresp: JsonObject, model: String): List<String> {
        val out = ArrayList<String>()
        val text = cresp.str("text") ?: ""
        val usage = cresp.obj("usage") ?: JsonObject()
        val inT = usage.int("input") ?: 0
        val outT = usage.int("output") ?: 0
        when (clientFormat) {
            "openai" -> {
                val id = randId("chatcmpl-")
                val created = nowSec()
                out.add(jsonObj("id" to je(id), "object" to je("chat.completion.chunk"), "created" to je(created), "model" to je(model),
                    "choices" to jsonArr(jsonObj("index" to je(0), "delta" to jsonObj("role" to je("assistant"), "content" to je(text)), "finish_reason" to com.google.gson.JsonNull.INSTANCE))).toString())
                out.add(jsonObj("id" to je(id), "object" to je("chat.completion.chunk"), "created" to je(created), "model" to je(model),
                    "choices" to jsonArr(jsonObj("index" to je(0), "delta" to jsonObj(), "finish_reason" to je(cresp.str("finish_reason") ?: "stop"))),
                    "usage" to jsonObj("prompt_tokens" to je(inT), "completion_tokens" to je(outT), "total_tokens" to je(inT + outT))).toString())
            }
            "claude" -> {
                out.add(jsonObj("type" to je("message_start"), "message" to jsonObj("id" to je(randId("msg_")), "type" to je("message"), "role" to je("assistant"), "model" to je(model), "content" to JsonArray(), "usage" to jsonObj("input_tokens" to je(inT), "output_tokens" to je(0)))).toString())
                out.add(jsonObj("type" to je("content_block_start"), "index" to je(0), "content_block" to jsonObj("type" to je("text"), "text" to je(""))).toString())
                out.add(jsonObj("type" to je("content_block_delta"), "index" to je(0), "delta" to jsonObj("type" to je("text_delta"), "text" to je(text))).toString())
                out.add(jsonObj("type" to je("content_block_stop"), "index" to je(0)).toString())
                out.add(jsonObj("type" to je("message_delta"), "delta" to jsonObj("stop_reason" to je(Converters.claudeFinish(cresp.str("finish_reason"))), "stop_sequence" to com.google.gson.JsonNull.INSTANCE), "usage" to jsonObj("output_tokens" to je(outT))).toString())
                out.add(jsonObj("type" to je("message_stop")).toString())
            }
            else -> {
                val resp = Converters.canonicalToGeminiResp(cresp, model)
                out.add(resp.toString())
            }
        }
        return out
    }

    private fun extractUpstreamError(body: String, code: Int): String {
        if (body.isBlank()) return "HTTP $code"
        val j = safeParse(body)?.takeIf { it.isJsonObject }?.asJsonObject ?: return body.take(300)
        return j.obj("error")?.str("message") ?: j.str("message") ?: body.take(300)
    }

    /** 生成客户端格式的错误响应体 */
    fun errorBody(clientFormat: String, status: Int, message: String): JsonObject = when (clientFormat) {
        "claude" -> jsonObj("type" to je("error"), "error" to jsonObj("type" to je("api_error"), "message" to je(message)))
        "gemini" -> jsonObj("error" to jsonObj("code" to je(status), "message" to je(message), "status" to je("UNKNOWN")))
        else -> jsonObj("error" to jsonObj("message" to je(message), "type" to je("server_error"), "code" to je(status)))
    }
}
