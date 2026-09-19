package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import com.aigateway.app.MainActivity
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentSettingsHubBinding


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
            Row(R.drawable.ic_info, R.string.st_about, R.string.disclaimer_short, "about"),
        )
        val list = b.settingsList
        list.removeAllViews()
        for (r in rows) {
            val v = LayoutInflater.from(requireContext()).inflate(R.layout.item_settings_row, list, false)
            v.findViewById<ImageView>(R.id.stIcon).setImageResource(r.icon)
            v.findViewById<TextView>(R.id.stTitle).setText(r.title)
            v.findViewById<TextView>(R.id.stSub).setText(r.sub)
            v.setOnClickListener { open(r.action) }
            list.addView(v)
        }
    }

    private fun open(action: String) {
        val ma = activity as? MainActivity ?: return
        when (action) {
            "theme" -> ma.showThemeDialogPublic()
            "connection" -> ma.showConnectionDialogPublic()
            "about" -> com.google.android.material.dialog.MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.st_about)
                .setMessage(R.string.disclaimer_full)
                .setPositiveButton(R.string.ok, null)
                .show()
            else -> ma.openSecondaryPublic(action)
        }
    }
}
