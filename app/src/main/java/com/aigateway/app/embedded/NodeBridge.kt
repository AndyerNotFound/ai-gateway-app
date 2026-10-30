package com.aigateway.app.embedded

/** JNI 桥：调用 nodejs-mobile 导出的 node::Start。 */
object NodeBridge {

    @Volatile
    private var loadError: String? = null

    @Volatile
    var loaded: Boolean = false
        private set

    /** libnode.so 是 4KB 页对齐的预编译产物，16KB 页设备无法加载。 */
    fun ensureLoaded(): Boolean {
        if (loaded) return true
        loadError?.let { return false }
        return try {
            System.loadLibrary("agwnode")
            loaded = true
            true
        } catch (t: Throwable) {
            loadError = t.message ?: t.javaClass.simpleName
            false
        }
    }

    fun loadFailure(): String? = loadError

    external fun nativeStart(argv: Array<String>): Int

    external fun nativePageSize(): Int
}
