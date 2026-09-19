package com.aigateway.app.ui

import android.content.ClipData
import com.aigateway.app.R
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import com.aigateway.app.databinding.FragmentLogsBinding

class LogsFragment : BaseFragment() {

    private var _b: FragmentLogsBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentLogsBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val linesOptions = listOf("50", "100", "200", "500")
        b.linesInput.setAdapter(ArrayAdapter(requireContext(), android.R.layout.simple_list_item_1, linesOptions))
        b.linesInput.setOnItemClickListener { _, _, _, _ -> load() }
        b.btnRefreshLogs.setOnClickListener { load() }
        b.btnCopyLogs.setOnClickListener { copyLogs() }
        load()
    }

    private fun currentLines(): Int = b.linesInput.text?.toString()?.toIntOrNull() ?: 100

    private fun load() {
        val backend = backendOrNull() ?: run { b.textLogs.text = getString(R.string.lg_not_connected); return }
        b.textLogs.text = getString(R.string.lg_loading)
        run({ b.textLogs.text = getString(R.string.lg_load_failed, it) }, {
            backend.getLogs(app.connectionStore.activeInstance, currentLines())
        }) { logs ->
            b.textLogs.text = logs.ifBlank { getString(R.string.lg_empty) }
        }
    }

    private fun copyLogs() {
        val text = b.textLogs.text?.toString().orEmpty()
        if (text.isBlank()) return
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("gateway-logs", text))
        toast(getString(R.string.lg_copied))
    }

    
    override fun reload() {
        if (_b != null) load()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
