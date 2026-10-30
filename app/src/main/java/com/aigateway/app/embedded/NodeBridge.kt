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

    /** 系统内存页大小；无需加载 libnode，16KB 设备要先于 dlopen 判断。 */
    fun pageSize(): Int = try {
        android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE).toInt()
    } catch (_: Throwable) {
        4096
    }

    external fun nativeStart(argv: Array<String>): Int

    external fun nativePageSize(): Int
}
