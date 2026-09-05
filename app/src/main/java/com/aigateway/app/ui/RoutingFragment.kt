package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.aigateway.app.R
import com.aigateway.app.data.Channel
import com.aigateway.app.databinding.FragmentRoutingBinding
import com.google.gson.JsonArray
import com.google.gson.JsonObject

/** 路由 —— 自动更新模型列表 + 隐私数据过滤 + 模型路由表 */
class RoutingFragment : BaseFragment() {

    private var _b: FragmentRoutingBinding? = null
    private val b get() = _b!!

    data class RouteRow(val name: String, val channel: String, val upstream: String, val via: String)

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentRoutingBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.btnSaveRouting.setOnClickListener { save() }
        b.btnSyncNow.setOnClickListener { syncNow() }
        load()
    }

    override fun reload() {
        if (_b != null) load()
    }

    private fun load() {
        val backend = backendOrNull() ?: run { showEmpty(true); return }
        run({ snack(getString(R.string.load_failed, it)); showEmpty(true) }, {
            backend.getConfig(app.connectionStore.activeInstance)
        }) { cfg ->
            // 自动更新模型列表
            b.switchModelSync.isChecked = cfg.modelSync.enable
            b.editSyncInterval.setText(cfg.modelSync.intervalHours.toString())
            // 隐私数据过滤
            b.switchRedact.isChecked = cfg.redact.enable
            b.editRedactExtra.setText(cfg.redact.extra?.joinToString("\n") ?: "")
            // 路由表
            renderRoutes(cfg.channels)
        }
    }

    private fun renderRoutes(channels: List<Channel>) {
        b.routingContainer.removeAllViews()
        val names = linkedSetOf<String>()
        channels.forEach { ch ->
            ch.models?.let { names.addAll(it) }
            ch.modelMap?.keys?.let { names.addAll(it) }
        }
        if (names.isEmpty()) { showEmpty(true); return }
        showEmpty(false)
        names.sorted().forEach { name ->
            val r = resolveRoute(name, channels)
            val row = RouteRow(name, r?.first ?: getString(R.string.rt_no_channel), r?.second ?: "", r?.third ?: "")
            val v = LayoutInflater.from(requireContext()).inflate(R.layout.item_routing, b.routingContainer, false)
            v.findViewById<TextView>(R.id.routeName).text = row.name
            v.findViewById<TextView>(R.id.routeChannel).text = row.channel
            v.findViewById<TextView>(R.id.routeUpstream).text =
                if (row.upstream == row.name) "via ${row.via}" else "${row.upstream} · via ${row.via}"
            b.routingContainer.addView(v)
        }
    }

    /** 模拟 pickChannels 第一候选: modelMap > models > default > 第一个渠道 */
    private fun resolveRoute(model: String, channels: List<Channel>): Triple<String, String, String>? {
        for (ch in channels) ch.modelMap?.get(model)?.let { return Triple(ch.name, it, "modelMap") }
        for (ch in channels) if (ch.models?.contains(model) == true) return Triple(ch.name, model, "models")
        val defs = channels.filter { it.default }
        val pool = if (defs.isNotEmpty()) defs else channels
        val first = pool.firstOrNull() ?: return null
        return Triple(first.name, model, if (defs.isNotEmpty()) "default" else "first")
    }

    private fun save() {
        val backend = backendOrNull() ?: return
        val interval = b.editSyncInterval.text?.toString()?.toIntOrNull()?.coerceAtLeast(1) ?: 24
        val extra = b.editRedactExtra.text?.toString()?.lines()
            ?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
        // 校验自定义正则
        for (p in extra) {
            try { Regex(p) } catch (e: Exception) {
                snack(getString(R.string.rp_bad_regex, "$p: ${e.message}")); return
            }
        }
        val patch = JsonObject().apply {
            add("modelSync", JsonObject().apply {
                addProperty("enable", b.switchModelSync.isChecked)
                addProperty("intervalHours", interval)
            })
            add("redact", JsonObject().apply {
                addProperty("enable", b.switchRedact.isChecked)
                add("extra", JsonArray().apply { extra.forEach { add(it) } })
            })
        }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.saveConfig(app.connectionStore.activeInstance, patch)
        }) { r ->
            if (r.ok) toast(getString(R.string.rt_saved)) else snack(getString(R.string.pv_save_failed, r.error ?: ""))
        }
    }

    private fun syncNow() {
        val backend = backendOrNull() ?: return
        toast(getString(R.string.rt_syncing))
        run({ snack(getString(R.string.op_failed, it)) }, {
            backend.syncModels(app.connectionStore.activeInstance)
        }) { r ->
            if (r.ok) { toast(r.output.ifBlank { getString(R.string.rt_sync_done) }); load() }
            else snack(getString(R.string.op_failed, r.error ?: ""))
        }
    }

    private fun showEmpty(empty: Boolean) {
        b.emptyHint.visibility = if (empty) View.VISIBLE else View.GONE
        b.routingContainer.visibility = if (empty) View.GONE else View.VISIBLE
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
