package com.aigateway.app.ui

import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.aigateway.app.R
import com.aigateway.app.data.RecordParser
import com.aigateway.app.data.RequestRecord
import com.aigateway.app.databinding.FragmentExtractorBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 文件提取器：用 SAF 打开本地 / 下载目录里的 JSONL 或 JSON 请求记录，
 * 列出每一次请求并可查看请求体与响应正文。
 */
class FileExtractorFragment : Fragment() {

    private var _b: FragmentExtractorBinding? = null
    private val b get() = _b!!
    private val adapter = RecordAdapter { showRecord(it) }

    private val picker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) load(uri)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentExtractorBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        b.extList.layoutManager = LinearLayoutManager(requireContext())
        b.extList.adapter = adapter
        b.extPick.setOnClickListener {
            picker.launch(arrayOf("application/json", "application/x-ndjson", "text/plain", "*/*"))
        }
    }

    private fun load(uri: Uri) {
        val ctx = requireContext()
        b.extFile.text = displayName(uri)
        b.extProgress.visibility = View.VISIBLE
        b.extEmpty.visibility = View.GONE
        b.extList.visibility = View.GONE
        viewLifecycleOwner.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    ctx.contentResolver.openInputStream(uri)?.use { RecordParser.parse(it) }
                        ?: RecordParser.Result(emptyList(), "无法打开文件")
                }.getOrElse { RecordParser.Result(emptyList(), it.message ?: "") }
            }
            if (_b == null) return@launch
            b.extProgress.visibility = View.GONE
            if (result.error != null) {
                toast(getString(R.string.ext_parse_error, result.error))
                b.extEmpty.visibility = View.VISIBLE
                return@launch
            }
            adapter.submit(result.records)
            val empty = result.records.isEmpty()
            b.extEmpty.visibility = if (empty) View.VISIBLE else View.GONE
            b.extList.visibility = if (empty) View.GONE else View.VISIBLE
            if (!empty) toast(getString(R.string.ext_loaded, result.records.size))
        }
    }

    private fun displayName(uri: Uri): String {
        try {
            requireContext().contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { c ->
                    if (c.moveToFirst() && !c.isNull(0)) return c.getString(0)
                }
        } catch (_: Exception) {}
        return uri.lastPathSegment ?: uri.toString()
    }

    private fun showRecord(r: RequestRecord) {
        val ctx = requireContext()
        val pad = (14 * resources.displayMetrics.density).toInt()
        val req = TextView(ctx).apply {
            text = r.request.ifBlank { getString(R.string.ext_no_body) }
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
            setPadding(pad, pad, pad, pad)
        }
        val resp = TextView(ctx).apply {
            text = r.response.ifBlank { getString(R.string.ext_no_body) }
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
            setPadding(pad, pad, pad, pad)
        }
        val head = TextView(ctx).apply {
            text = getString(R.string.ext_meta, r.id, r.time, r.model, r.channel, r.status, r.duration, r.format)
            textSize = 12f
            setPadding(pad, pad, pad, 0)
        }
        val col = android.widget.LinearLayout(ctx).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            addView(head)
            addView(section(ctx, getString(R.string.ext_request_body)))
            addView(req)
            addView(section(ctx, getString(R.string.ext_response_body)))
            addView(resp)
        }
        val scroll = ScrollView(ctx).apply { addView(col) }
        MaterialAlertDialogBuilder(ctx)
            .setTitle(R.string.ext_detail)
            .setView(scroll)
            .setPositiveButton(R.string.ok, null)
            .show()
    }

    private fun section(ctx: android.content.Context, title: String) = TextView(ctx).apply {
        text = title
        textSize = 13f
        setTypeface(typeface, android.graphics.Typeface.BOLD)
        val d = resources.displayMetrics.density
        setPadding((14 * d).toInt(), (18 * d).toInt(), (14 * d).toInt(), (4 * d).toInt())
    }

    private fun toast(msg: String) {
        if (isAdded) Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
