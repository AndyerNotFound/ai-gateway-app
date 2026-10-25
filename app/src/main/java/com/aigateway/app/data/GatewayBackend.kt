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

    /** 完整管理面板(m3) URL; null = 当前模式不支持(内嵌) */
    fun panelUrl(): String? = null

    /** 测试连接是否可用 */
    suspend fun testConnection(): Boolean

    suspend fun getInstances(): InstancesResponse
    suspend fun getConfig(name: String): GatewayConfig
    /** patch: 仅含要修改的字段(Gson JsonObject) */
    suspend fun saveConfig(name: String, patch: JsonObject): ActionResult
    suspend fun createInstance(name: String, port: Int, adminKey: String): ActionResult
    suspend fun deleteInstance(name: String): ActionResult
    suspend fun renameInstance(name: String, newName: String): ActionResult

    // ---- 卡密(多用户Key): 默认不支持(内嵌模式), 远程模式由 RemoteBackend 实现 ----
    suspend fun getKeys(inst: String): KeysResponse =
        throw BackendException("当前模式不支持卡密管理")
    suspend fun createKey(inst: String, body: JsonObject): JsonObject =
        throw BackendException("当前模式不支持卡密管理")
    suspend fun updateKey(inst: String, body: JsonObject): ActionResult =
        ActionResult(ok = false, error = "当前模式不支持卡密管理")
    suspend fun deleteKey(inst: String, key: String): ActionResult =
        ActionResult(ok = false, error = "当前模式不支持卡密管理")

    // ---- 用户/第二验证/隧道/余额(默认不支持, 远程模式实现) ----
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
    suspend fun setForceChannel(inst: String, channel: String?): ActionResult = throw BackendException("当前模式不支持")
    /** 一次性路由: 只作用于下一次请求, 网关侧用完自清 */
    suspend fun setOnceChannel(inst: String, channel: String?): ActionResult = throw BackendException("当前模式不支持")
    /** 上下文窗口匹配表(有序, 支持 * 通配) */
    suspend fun setContextWindows(inst: String, windows: List<CtxWindow>, soft: Int, hard: Int, cpt: Double = 4.0): ActionResult = throw BackendException("当前模式不支持")
    suspend fun saveChannel(inst: String, channel: Channel): ActionResult
    suspend fun deleteChannel(inst: String, chName: String): ActionResult
    suspend fun fetchModels(inst: String, channel: Channel): ModelsResult
    suspend fun syncModels(inst: String): ActionResult
    /** 最近活跃实例(球轮播用); 内嵌模式没有实例池, 默认返回空 */
    suspend fun getActive(): ActiveResp = ActiveResp()

    /** 悬浮球外观/文案配置(GET /admin/api/ball/<inst>); 不支持时返回空对象 */
    suspend fun getBall(inst: String): JsonObject = JsonObject()

    /** SDUI 页面(GET /admin/api/ui/<page>); 不支持时返回空对象 */
    /** 取同源二进制（图片用）；不支持的后端返回 null */
    suspend fun fetchBytes(path: String): ByteArray? = null

    suspend fun getUiPage(page: String): JsonObject = JsonObject()

    /** 网关上有哪些 SDUI 页面; 不支持时返回空(→ 全部走原生) */
    suspend fun getUiPages(): List<String> = emptyList()

    /** SDUI 按钮动作转发(POST 到网关既有 admin 端点) */
    suspend fun postUi(endpoint: String, body: JsonObject): JsonObject = JsonObject()

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
