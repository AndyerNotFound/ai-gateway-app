package com.aigateway.app.data

import com.google.gson.JsonObject

/**
 * 网关后端统一抽象 —— 管理面板 UI 只依赖此接口。
 *  - RemoteBackend:   连接 Termux / 局域网 gateway (HTTP admin API)
 *  - EmbeddedBackend: 应用内嵌 Kotlin 引擎
 */
interface GatewayBackend {

    /** 模式标签(用于 UI 显示) */
    val modeLabel: String

    /** 连接描述(地址或"应用内") */
    val connectionDesc: String

    /** 测试连接是否可用 */
    suspend fun testConnection(): Boolean

    suspend fun getInstances(): InstancesResponse
    suspend fun getConfig(name: String): GatewayConfig
    /** patch: 仅含要修改的字段(Gson JsonObject) */
    suspend fun saveConfig(name: String, patch: JsonObject): ActionResult
    suspend fun createInstance(name: String, port: Int, adminKey: String): ActionResult
    suspend fun deleteInstance(name: String): ActionResult
    suspend fun saveChannel(inst: String, channel: Channel): ActionResult
    suspend fun deleteChannel(inst: String, chName: String): ActionResult
    suspend fun fetchModels(inst: String, channel: Channel): ModelsResult
    suspend fun syncModels(inst: String): ActionResult
    suspend fun getStats(name: String): Stats
    suspend fun getLogs(name: String, lines: Int): String
    suspend fun getRequests(name: String): List<RequestEntry>
    suspend fun getRecordBody(name: String, id: String): RecordBody
    suspend fun action(name: String, cmd: String): ActionResult
    suspend fun shutdownAll(): ActionResult

    /**
     * 聊天(流式)。onDelta 回调增量文本; 返回最终结果(ok/error)。
     */
    suspend fun chat(
        instance: String,
        model: String,
        messages: List<ChatMessage>,
        onDelta: (String) -> Unit
    ): ActionResult

    fun close()
}

/** 后端异常 */
class BackendException(message: String, val code: Int = 0) : Exception(message)
