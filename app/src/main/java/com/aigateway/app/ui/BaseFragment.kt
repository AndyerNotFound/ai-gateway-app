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


abstract class BaseFragment : Fragment() {

    val app: App get() = requireActivity().application as App

    fun backendOrNull(): GatewayBackend? = app.backend()

    
    private var lastDataKey: String? = null

    
    open fun dataKey(): String =
        app.connectionStore.activeInstance + "|" + (backendOrNull()?.connectionDesc ?: "none")

    


    open fun reload() {}

    override fun onResume() {
        super.onResume()
        val key = dataKey()
        if (lastDataKey == null || lastDataKey != key) {
            lastDataKey = key
            reload()
        }
    }

    
    fun invalidateData() {
        lastDataKey = null
    }

    fun toast(msg: String) {
        if (isAdded) Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }

    fun snack(msg: String) {
        view?.let { Snackbar.make(it, msg, Snackbar.LENGTH_LONG).show() } ?: toast(msg)
    }

    


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
