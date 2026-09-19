package com.aigateway.app.data

import com.google.gson.JsonObject






interface GatewayBackend {

    
    val modeLabel: String

    
    val connectionDesc: String

    
    fun panelUrl(): String? = null

    
    suspend fun testConnection(): Boolean

    suspend fun getInstances(): InstancesResponse
    suspend fun getConfig(name: String): GatewayConfig
    
    suspend fun saveConfig(name: String, patch: JsonObject): ActionResult
    suspend fun createInstance(name: String, port: Int, adminKey: String): ActionResult
    suspend fun deleteInstance(name: String): ActionResult
    suspend fun renameInstance(name: String, newName: String): ActionResult

    
    suspend fun getKeys(inst: String): KeysResponse =
        throw BackendException("当前模式不支持卡密管理")
    suspend fun createKey(inst: String, body: JsonObject): JsonObject =
        throw BackendException("当前模式不支持卡密管理")
    suspend fun updateKey(inst: String, body: JsonObject): ActionResult =
        ActionResult(ok = false, error = "当前模式不支持卡密管理")
    suspend fun deleteKey(inst: String, key: String): ActionResult =
        ActionResult(ok = false, error = "当前模式不支持卡密管理")

    
    suspend fun getUsers(inst: String): JsonObject = throw BackendException("当前模式不支持")
    suspend fun createUser(inst: String, body: JsonObject): JsonObject = throw BackendException("当前模式不支持")
    suspend fun updateUser(inst: String, body: JsonObject): JsonObject = throw BackendException("当前模式不支持")
    suspend fun deleteUser(inst: String, uid: String): JsonObject = throw BackendException("当前模式不支持")
    suspend fun getAdminAuth(inst: String): JsonObject = throw BackendException("当前模式不支持")
    suspend fun setAdminAuth(inst: String, body: JsonObject): JsonObject = throw BackendException("当前模式不支持")
    suspend fun getTunnel(): JsonObject = throw BackendException("当前模式不支持")
    suspend fun tunnelAction(action: String): JsonObject = throw BackendException("当前模式不支持")
    suspend fun getBalance(inst: String, ch: String): JsonObject = throw BackendException("当前模式不支持")
    suspend fun getPlugins(inst: String): JsonObject = throw BackendException("当前模式不支持")
    suspend fun installPlugin(inst: String, body: JsonObject): JsonObject = throw BackendException("当前模式不支持")
    suspend fun removePlugin(inst: String, body: JsonObject): JsonObject = throw BackendException("当前模式不支持")
    suspend fun enablePlugin(inst: String, body: JsonObject): JsonObject = throw BackendException("当前模式不支持")
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

    


    suspend fun chat(
        instance: String,
        model: String,
        messages: List<ChatMessage>,
        onDelta: (String) -> Unit
    ): ActionResult

    fun close()
}


class BackendException(message: String, val code: Int = 0) : Exception(message)
