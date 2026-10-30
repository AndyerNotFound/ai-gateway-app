package com.aigateway.app.data

import com.google.gson.JsonObject

/**
 * ai-gateway-AI 管理 API 抽象。
 *
 * 客户端只保留远程管理：所有方法都对应 server 端 /admin/api/ 下的真实路由。
 * 鉴权使用 config.webToken（请求头 x-agw-token）。
 */
interface GatewayBackend {

    suspend fun testConnection(): Boolean

    suspend fun getInstances(): InstancesResponse
    suspend fun getConfig(name: String): GatewayConfig
    suspend fun saveConfig(name: String, patch: JsonObject): ActionResult
    suspend fun createInstance(name: String, port: Int, webToken: String): ActionResult
    suspend fun deleteInstance(name: String): ActionResult
    suspend fun renameInstance(name: String, newName: String): ActionResult

    // 卡密 / 用户 / 二次验证
    suspend fun getKeys(inst: String): KeysResponse
    suspend fun createKey(inst: String, body: JsonObject): JsonObject
    suspend fun updateKey(inst: String, body: JsonObject): ActionResult
    suspend fun deleteKey(inst: String, key: String): ActionResult
    suspend fun getUsers(inst: String): JsonObject
    suspend fun createUser(inst: String, body: JsonObject): JsonObject
    suspend fun updateUser(inst: String, body: JsonObject): JsonObject
    suspend fun deleteUser(inst: String, uid: String): JsonObject
    suspend fun getAdminAuth(inst: String): JsonObject
    suspend fun setAdminAuth(inst: String, body: JsonObject): JsonObject

    // 隧道 / 余额 / 插件
    suspend fun getTunnel(): JsonObject
    suspend fun tunnelAction(action: String): JsonObject
    suspend fun getBalance(inst: String, ch: String): JsonObject
    suspend fun getPlugins(inst: String): JsonObject
    suspend fun installPlugin(inst: String, body: JsonObject): JsonObject
    suspend fun removePlugin(inst: String, body: JsonObject): JsonObject
    suspend fun enablePlugin(inst: String, body: JsonObject): JsonObject

    // 路由 / 渠道
    suspend fun setOnceChannel(inst: String, channel: String?): ActionResult
    suspend fun saveChannel(inst: String, channel: Channel): ActionResult
    suspend fun deleteChannel(inst: String, chName: String): ActionResult
    suspend fun fetchModels(inst: String, channel: Channel): ModelsResult
    suspend fun syncModels(inst: String): ActionResult

    // 观测 / 运维
    suspend fun getStats(name: String): Stats
    suspend fun getLogs(name: String, lines: Int): String
    suspend fun getRequests(name: String): List<RequestEntry>
    suspend fun getRecordBody(name: String, id: String): RecordBody
    suspend fun action(name: String, cmd: String): ActionResult
    suspend fun shutdownAll(): ActionResult

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
