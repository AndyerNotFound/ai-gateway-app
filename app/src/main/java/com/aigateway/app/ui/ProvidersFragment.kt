package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.aigateway.app.R
import com.aigateway.app.data.Channel
import com.aigateway.app.databinding.DialogChannelBinding
import com.aigateway.app.databinding.FragmentProvidersBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class ProvidersFragment : BaseFragment() {

    private var _b: FragmentProvidersBinding? = null
    private val b get() = _b!!
    private lateinit var adapter: ChannelAdapter

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentProvidersBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        adapter = ChannelAdapter(
            onEdit = { showChannelDialog(it) },
            onDelete = { confirmDelete(it) },
            onFetchModels = { fetchModels(it) }
        )
        b.channelList.layoutManager = LinearLayoutManager(requireContext())
        b.channelList.adapter = adapter
        b.fabAdd.setOnClickListener { showChannelDialog(null) }
        load()
    }

    /** 基类在实例/连接变化时调用 */
    override fun reload() {
        if (_b != null) load()
    }

    private fun load() {
        val backend = backendOrNull() ?: run { showEmpty(true); return }
        run({ snack(getString(R.string.load_failed, it)); showEmpty(true) }, {
            backend.getConfig(app.connectionStore.activeInstance)
        }) { cfg ->
            adapter.submit(cfg.channels)
            showEmpty(cfg.channels.isEmpty())
        }
    }

    private fun loadAfterDelay() {
        viewLifecycleOwner.lifecycleScope.launch {
            // 网关 self-restart 约 3 秒(scheduleRestart 300ms + stop + start), 太短会读到重启前的旧进程
            delay(3500)
            if (isAdded) load()
        }
    }

    private fun showEmpty(empty: Boolean) {
        b.emptyHint.visibility = if (empty) View.VISIBLE else View.GONE
        b.channelList.visibility = if (empty) View.GONE else View.VISIBLE
    }

    // ---------- 新增/编辑 ----------

    private fun showChannelDialog(existing: Channel?) {
        val db = DialogChannelBinding.inflate(layoutInflater)
        val types = listOf("openai", "gemini", "claude")
        db.editType.setAdapter(ArrayAdapter(requireContext(), android.R.layout.simple_list_item_1, types))

        if (existing != null) {
            db.editName.setText(existing.name)
            db.editName.isEnabled = false
            db.editType.setText(existing.type, false)
            db.editBaseUrl.setText(existing.baseUrl)
            db.editApiKey.setText(existing.apiKey)
            db.editProxy.setText(existing.proxy ?: "")
            db.editModels.setText(existing.models?.joinToString(", ") ?: "")
            db.editModelMap.setText(existing.modelMap?.entries?.joinToString("\n") { "${it.key}=${it.value}" } ?: "")
            db.editDelayMs.setText(existing.delayMs.toString())
            db.switchDefault.isChecked = existing.default
            db.switchUseResponses.isChecked = existing.useResponses
            db.switchInsecure.isChecked = existing.insecure
        } else {
            db.editType.setText("openai", false)
            db.editDelayMs.setText("0")
        }

        MaterialAlertDialogBuilder(requireContext())
            .setTitle(if (existing == null) R.string.pv_add else R.string.pv_edit)
            .setView(db.root)
            .setPositiveButton(R.string.save) { _, _ -> saveChannel(db, existing) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun saveChannel(db: DialogChannelBinding, existing: Channel?) {
        val name = db.editName.text?.toString()?.trim().orEmpty()
        val type = db.editType.text?.toString()?.trim().orEmpty()
        val baseUrl = db.editBaseUrl.text?.toString()?.trim().orEmpty()
        if (name.isBlank() || baseUrl.isBlank()) { snack(getString(R.string.pv_need_fields)); return }
        if (type !in listOf("openai", "gemini", "claude")) { snack(getString(R.string.pv_bad_type)); return }
        val apiKey = db.editApiKey.text?.toString()?.trim().orEmpty()
        val proxy = db.editProxy.text?.toString()?.trim()?.ifBlank { null }
        val models = db.editModels.text?.toString()?.split(",")?.map { it.trim() }?.filter { it.isNotBlank() }?.ifEmpty { null }
        val modelMap = parseModelMap(db.editModelMap.text?.toString().orEmpty())
        val delayMs = db.editDelayMs.text?.toString()?.toIntOrNull() ?: 0
        val channel = Channel(
            name = name, type = type, baseUrl = baseUrl, apiKey = apiKey,
            label = existing?.label, proxy = proxy, models = models, modelMap = modelMap,
            default = db.switchDefault.isChecked, delayMs = delayMs, insecure = db.switchInsecure.isChecked,
            useResponses = db.switchUseResponses.isChecked
        )
        val backend = backendOrNull() ?: return
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.saveChannel(app.connectionStore.activeInstance, channel)
        }) { r ->
            if (r.ok) { toast(getString(R.string.pv_saved)); loadAfterDelay() }
            else snack(getString(R.string.pv_save_failed, r.error ?: ""))
        }
    }

    private fun parseModelMap(text: String): Map<String, String>? {
        val map = linkedMapOf<String, String>()
        text.lines().forEach { line ->
            val t = line.trim()
            if (t.isEmpty()) return@forEach
            val idx = t.indexOf('=')
            if (idx > 0) map[t.substring(0, idx).trim()] = t.substring(idx + 1).trim()
        }
        return map.ifEmpty { null }
    }

    // ---------- 删除 ----------

    private fun confirmDelete(ch: Channel) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.pv_delete_title)
            .setMessage(getString(R.string.pv_delete_msg, ch.name))
            .setPositiveButton(R.string.delete) { _, _ ->
                val backend = backendOrNull() ?: return@setPositiveButton
                run({ snack(getString(R.string.delete_failed, it)) }, {
                    backend.deleteChannel(app.connectionStore.activeInstance, ch.name)
                }) { r ->
                    if (r.ok) { toast(getString(R.string.pv_deleted)); loadAfterDelay() }
                    else snack(getString(R.string.delete_failed, r.error ?: ""))
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    // ---------- 获取模型 ----------

    private fun fetchModels(ch: Channel) {
        val backend = backendOrNull() ?: return
        toast(getString(R.string.pv_fetching))
        run({ snack(getString(R.string.pv_no_models, it)) }, {
            backend.fetchModels(app.connectionStore.activeInstance, ch)
        }) { r ->
            if (r.models.isNotEmpty()) showModelsResult(ch, r.models)
            else snack(getString(R.string.pv_no_models, r.error ?: ""))
        }
    }

    private fun showModelsResult(ch: Channel, models: List<String>) {
        val preview = models.take(50).joinToString("\n") + if (models.size > 50) "\n… ${models.size}" else ""
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(getString(R.string.pv_models_title, models.size))
            .setMessage(preview)
            .setPositiveButton(R.string.pv_fill_models) { _, _ ->
                val updated = ch.copy(models = models)
                val backend = backendOrNull() ?: return@setPositiveButton
                run({ snack(getString(R.string.pv_save_failed, it)) }, {
                    backend.saveChannel(app.connectionStore.activeInstance, updated)
                }) { r ->
                    if (r.ok) { toast(getString(R.string.pv_filled, models.size)); loadAfterDelay() }
                    else snack(getString(R.string.pv_save_failed, r.error ?: ""))
                }
            }
            .setNegativeButton(R.string.close, null)
            .show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
