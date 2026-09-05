package com.aigateway.app.ui

import android.os.Bundle
import com.aigateway.app.R
import android.view.View
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.aigateway.app.App
import com.aigateway.app.data.GatewayBackend
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Fragment 基类 —— 后端访问 / 协程 / 提示 / 实例变化自动刷新 */
abstract class BaseFragment : Fragment() {

    val app: App get() = requireActivity().application as App

    fun backendOrNull(): GatewayBackend? = app.backend()

    /** 上次加载时的 (实例 + 连接) 标识, 用于检测变化 */
    private var lastDataKey: String? = null

    /** 当前数据标识: 实例名 + 后端连接 */
    private fun dataKey(): String =
        app.connectionStore.activeInstance + "|" + (backendOrNull()?.connectionDesc ?: "none")

    /**
     * 子类覆盖以支持自动刷新(切实例/切连接后回到该页会自动重载)。
     */
    open fun reload() {}

    override fun onResume() {
        super.onResume()
        val key = dataKey()
        if (lastDataKey == null || lastDataKey != key) {
            lastDataKey = key
            reload()
        }
    }

    /** 强制标记需要重载(下次 onResume 生效) */
    fun invalidateData() {
        lastDataKey = null
    }

    fun toast(msg: String) {
        if (isAdded) Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }

    fun snack(msg: String) {
        view?.let { Snackbar.make(it, msg, Snackbar.LENGTH_LONG).show() } ?: toast(msg)
    }

    /**
     * 后台执行后端调用, 主线程回调, 自动捕获异常。
     */
    fun <T> run(
        onError: (String) -> Unit = { snack(it) },
        block: suspend () -> T,
        onDone: (T) -> Unit
    ) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = withContext(Dispatchers.IO) { block() }
                if (isAdded) onDone(r)
            } catch (e: Exception) {
                if (isAdded) onError(e.message ?: getString(com.aigateway.app.R.string.op_failed, ""))
            }
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
    }
}
