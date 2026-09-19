package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentPluginsMgmtBinding
import com.aigateway.app.databinding.ItemPluginMgmtBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.gson.JsonObject


class PluginsMgmtFragment : BaseFragment() {
    private var _b: FragmentPluginsMgmtBinding? = null
    private val b get() = _b!!

    override fun dataKey(): String = app.connectionStore.activeInstance + "|plugins"

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        FragmentPluginsMgmtBinding.inflate(inflater, container, false).also { _b = it }.root

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.pmInstall.setOnClickListener { showInstall() }
    }

    override fun reload() = load()

    private fun load() {
        val inst = app.connectionStore.activeInstance
        b.pmInst.text = getString(R.string.pm_instance, inst)
        val db = app.backend()
        if (db == null) { b.pmEmpty.visibility = View.VISIBLE; b.pmEmpty.text = getString(R.string.pm_no_backend); return }
        run({ snack(it); b.pmEmpty.visibility = View.VISIBLE; b.pmEmpty.text = it }, { db.getPlugins(inst) }) { j ->
            renderPlugins(j.getAsJsonArray("plugins"))
        }
    }

    private fun renderPlugins(arr: com.google.gson.JsonArray) {
        b.pmList.removeAllViews()
        if (arr == null || arr.size() == 0) {
            b.pmEmpty.visibility = View.VISIBLE
            b.pmEmpty.text = getString(R.string.pm_empty)
            return
        }
        b.pmEmpty.visibility = View.GONE
        val inst = app.connectionStore.activeInstance
        for (p in arr) {
            val o = p.asJsonObject
            val id = o.get("id")?.asString ?: continue
            val enabled = o.get("enabled")?.asBoolean ?: false
            val ib = ItemPluginMgmtBinding.inflate(LayoutInflater.from(requireContext()), b.pmList, false)
            ib.pmName.text = o.get("name")?.asString ?: id
            ib.pmVer.text = o.get("version")?.asString?.let { "v$it" } ?: ""
            ib.pmDesc.text = o.get("description")?.asString ?: ""
            ib.pmEnable.text = if (enabled) getString(R.string.pm_enabled) else getString(R.string.pm_disabled)
            ib.pmEnable.setOnClickListener {
                val d = app.backend() ?: return@setOnClickListener
                run({ snack(it) }, {
                    d.enablePlugin(inst, JsonObject().apply {
                        addProperty("id", id); addProperty("enable", !enabled)
                    })
                }) { load() }
            }
            ib.pmRemove.setOnClickListener {
                val d = app.backend() ?: return@setOnClickListener
                MaterialAlertDialogBuilder(requireContext())
                    .setTitle(R.string.pm_remove_title)
                    .setMessage(getString(R.string.pm_remove_msg, ib.pmName.text))
                    .setPositiveButton(R.string.ok) { _, _ ->
                        run({ snack(it) }, {
                            d.removePlugin(inst, JsonObject().apply { addProperty("id", id) })
                        }) { snack(getString(R.string.pm_removed)); load() }
                    }
                    .setNegativeButton(R.string.cancel, null)
                    .show()
            }
            b.pmList.addView(ib.root)
        }
    }

    private fun showInstall() {
        val ctx = requireContext()
        val dp = ctx.resources.displayMetrics.density
        val etUrl = EditText(ctx).apply {
            hint = "https://.../plugin.tar.gz"
            setSingleLine()
        }
        val etSha = EditText(ctx).apply {
            hint = "SHA256 (可选, 强烈建议填)"
            setSingleLine()
        }
        val lay = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            val p = (16 * dp).toInt()
            setPadding(p, p, p, 0)
            addView(etUrl)
            addView(etSha)
        }
        MaterialAlertDialogBuilder(ctx)
            .setTitle(R.string.pm_install_title)
            .setMessage(R.string.pm_install_hint)
            .setView(lay)
            .setPositiveButton(R.string.ok) { _, _ ->
                val url = etUrl.text.toString().trim()
                if (url.isEmpty()) { snack(getString(R.string.pm_url_empty)); return@setPositiveButton }
                val body = JsonObject().apply {
                    addProperty("url", url)
                    val s = etSha.text.toString().trim()
                    if (s.isNotEmpty()) addProperty("sha256", s)
                }
                val d = app.backend() ?: return@setPositiveButton
                val inst = app.connectionStore.activeInstance
                run({ snack(it) }, { d.installPlugin(inst, body) }) {
                    snack(getString(R.string.pm_installed)); load()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
