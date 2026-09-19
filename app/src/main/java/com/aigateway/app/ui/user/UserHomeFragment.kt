package com.aigateway.app.ui.user

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentUserHomeBinding
import com.aigateway.app.ui.BaseFragment


class UserHomeFragment : BaseFragment() {

    private var _b: FragmentUserHomeBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentUserHomeBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.uhServer.text = app.userStore.serverUrl + app.userStore.apiRoot().removePrefix(app.userStore.serverUrl).ifBlank { "" }
        b.uhBranchEdit.setText(app.userStore.branch)
        b.uhBranchSave.setOnClickListener {
            app.userStore.branch = b.uhBranchEdit.text?.toString()?.trim().orEmpty()
            snack(getString(R.string.uh_branch_saved))
            load()
        }
        load()
    }

    override fun reload() { if (_b != null) load() }

    private fun load() {
        val ub = app.userBackend()
        run({ b.uhInfo.text = getString(R.string.uh_offline, it) }, { ub.status() }) { j ->
            b.uhInfo.text = getString(
                R.string.uh_info_fmt,
                j.get("version")?.asString ?: "?",
                j.get("uptime")?.asLong?.let { fmtUptime(it) } ?: "--"
            )
            renderProbe(j)
        }
        
        run({ b.uhPluginHint.text = it }, { ub.plugins() }) { j ->
            renderPlugins(j.getAsJsonArray("plugins"))
        }
    }

    private fun renderPlugins(arr: com.google.gson.JsonArray) {
        b.uhPluginList.removeAllViews()
        if (arr == null || arr.size() == 0) {
            b.uhPluginHint.visibility = View.VISIBLE
            b.uhPluginHint.text = getString(R.string.uh_plugins_empty)
            return
        }
        b.uhPluginHint.visibility = View.GONE
        val ctx = requireContext()
        val dp16 = (16 * ctx.resources.displayMetrics.density).toInt()
        val dp10 = (10 * ctx.resources.displayMetrics.density).toInt()
        for (p in arr) {
            val o = p.asJsonObject
            val id = o.get("id")?.asString ?: continue
            val name = o.get("name")?.asString ?: id
            val desc = o.get("description")?.asString ?: ""
            val userPage = o.get("userPage")?.asString ?: "pages/user.html"
            val tv = TextView(ctx).apply {
                text = "🧩  $name\n$desc"
                setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodyMedium)
                setPadding(dp16, dp10, dp16, dp10)
                setOnClickListener {
                    val intent = android.content.Intent(ctx, PluginWebActivity::class.java)
                    intent.putExtra("pluginId", id)
                    intent.putExtra("userPage", userPage)
                    intent.putExtra("name", name)
                    startActivity(intent)
                }
            }
            b.uhPluginList.addView(tv)
        }
    }

    private fun fmtUptime(sec: Long): String {
        val h = sec / 3600; val m = (sec % 3600) / 60
        return if (h > 0) "${h}h${m}m" else "${m}m${sec % 60}s"
    }

    private fun renderProbe(j: com.google.gson.JsonObject) {
        val list = b.uhProbeList
        list.removeAllViews()
        val probe = j.getAsJsonObject("probe")
        if (probe == null || probe.size() == 0) {
            b.uhProbeHint.visibility = View.VISIBLE
            return
        }
        b.uhProbeHint.visibility = View.GONE
        for (entry in probe.entrySet()) {
            val p = entry.value.asJsonObject
            val rate = if (p.get("rate").isJsonNull) null else p.get("rate").asInt
            val tv = TextView(requireContext()).apply {
                text = getString(
                    R.string.uh_probe_row,
                    entry.key,
                    rate?.let { "$it%" } ?: "--",
                    p.get("total")?.asInt ?: 0
                )
                setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodyMedium)
            }
            list.addView(tv)
        }
    }
}
