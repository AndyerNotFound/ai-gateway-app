package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.aigateway.app.MainActivity
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentSettingsHubBinding
import com.aigateway.app.overlay.OverlayService
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/** 管理端 · 设置 hub(底栏第6项): 聚合所有设置入口 */
class SettingsHubFragment : BaseFragment() {

    private var _b: FragmentSettingsHubBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentSettingsHubBinding.inflate(inflater, container, false)
        return b.root
    }

    private data class Row(val icon: Int, val title: Int, val sub: Int, val action: String)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val rows = listOf(
            Row(R.drawable.ic_models, R.string.menu_panel, R.string.st_panel_sub, "panel"),
            Row(R.drawable.ic_person_add, R.string.us_title, R.string.us_sub, "users"),
            Row(R.drawable.ic_key, R.string.st_secondauth, R.string.st_secondauth_sub, "secondauth"),
            Row(R.drawable.ic_sync, R.string.st_tunnel, R.string.st_tunnel_sub, "tunnel"),
            Row(R.drawable.ic_person_add, R.string.st_reg, R.string.st_reg_sub, "reg"),
            Row(R.drawable.ic_palette, R.string.menu_theme, R.string.st_theme_sub, "theme"),
            Row(R.drawable.ic_settings, R.string.menu_connection, R.string.st_conn_sub, "connection"),
            Row(R.drawable.ic_shield, R.string.menu_security, R.string.st_security_sub, "security"),
            Row(R.drawable.ic_key, R.string.menu_config, R.string.st_config_sub, "config"),
            Row(R.drawable.ic_floating, R.string.st_overlay, R.string.st_overlay_sub, "overlay"),
            Row(R.drawable.ic_models, R.string.st_sdui, R.string.st_sdui_sub, "sdui"),
            Row(R.drawable.ic_info, R.string.st_about, R.string.disclaimer_short, "about"),
        )
        val list = b.settingsList
        list.removeAllViews()
        for (r in rows) {
            val v = LayoutInflater.from(requireContext()).inflate(R.layout.item_settings_row, list, false)
            v.tag = r.action
            v.findViewById<ImageView>(R.id.stIcon).setImageResource(r.icon)
            v.findViewById<TextView>(R.id.stTitle).setText(r.title)
            v.findViewById<TextView>(R.id.stSub).setText(r.sub)
            v.setOnClickListener { open(r.action) }
            list.addView(v)
        }
        refreshOverlayRow()

        // 从系统授权页返回时刷新状态(不能覆盖 BaseFragment.onResume: 它未标记 open)
        viewLifecycleOwner.lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onResume(owner: LifecycleOwner) = refreshOverlayRow()
        })
    }

    /** 悬浮窗行副标题显示当前实际状态(未授权/开/关) */
    private fun refreshOverlayRow() {
        val list = _b?.settingsList ?: return
        val row = (0 until list.childCount)
            .map { list.getChildAt(it) }
            .firstOrNull { it.tag == "overlay" } ?: return
        val s = app.settings
        val text = when {
            !s.overlayEnabled -> getString(R.string.st_overlay_off)
            !OverlayService.canShow(requireContext()) -> getString(R.string.st_overlay_need_perm)
            else -> getString(R.string.st_overlay_on)
        }
        row.findViewById<TextView>(R.id.stSub).text = text
    }

    /** SDUI: 预览某页 + 配置哪几个二级页交给服务端渲染 */
    private fun showSduiDialog() {
        val ctx = requireContext()
        val d = resources.displayMetrics.density
        val box = android.widget.LinearLayout(ctx).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            val p = (18 * d).toInt()
            setPadding(p, (8 * d).toInt(), p, 0)
        }
        val edPreview = android.widget.EditText(ctx).apply {
            hint = getString(R.string.sdui_page_hint)
            setSingleLine()
        }
        val edRoutes = android.widget.EditText(ctx).apply {
            hint = getString(R.string.sdui_routes_hint)
            setSingleLine()
            setText(app.settings.sduiPages)
        }
        box.addView(edPreview)
        box.addView(edRoutes)
        MaterialAlertDialogBuilder(ctx)
            .setTitle(R.string.st_sdui)
            .setView(box)
            .setNeutralButton(R.string.sdui_clear) { _, _ ->
                app.settings.sduiPages = ""
                toast(getString(R.string.sdui_clear))
            }
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.ok) { _, _ ->
                app.settings.sduiPages = edRoutes.text.toString().trim()
                val pv = edPreview.text.toString().trim()
                if (pv.isNotEmpty()) (activity as? MainActivity)?.openSecondaryPublic("sdui:$pv")
            }
            .show()
    }

    private fun open(action: String) {
        val ma = activity as? MainActivity ?: return
        when (action) {
            "theme" -> ma.showThemeDialogPublic()
            "connection" -> ma.showConnectionDialogPublic()
            "overlay" -> ma.openSecondaryPublic("overlaylook")
            "sdui" -> showSduiDialog()
            "about" -> com.google.android.material.dialog.MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.st_about)
                .setMessage(R.string.disclaimer_full)
                .setPositiveButton(R.string.ok, null)
                .show()
            else -> ma.openSecondaryPublic(action)
        }
    }
}
