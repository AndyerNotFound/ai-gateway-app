package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import com.aigateway.app.R
import com.aigateway.app.data.Proxy
import com.aigateway.app.databinding.DialogProxyBinding
import com.aigateway.app.databinding.FragmentProxiesBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.gson.JsonObject


class ProxiesFragment : BaseFragment() {

    private var _b: FragmentProxiesBinding? = null
    private val b get() = _b!!
    private val proxies = linkedMapOf<String, Proxy>()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentProxiesBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.fabAddProxy.setOnClickListener { showProxyDialog(null) }
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
            proxies.clear()
            proxies.putAll(cfg.proxies)
            render()
        }
    }

    private fun render() {
        b.listContainer.removeAllViews()
        if (proxies.isEmpty()) { showEmpty(true); return }
        showEmpty(false)
        proxies.forEach { (name, px) ->
            b.listContainer.addView(makeCard(name, px))
        }
    }

    private fun makeCard(name: String, px: Proxy): View {
        val v = LayoutInflater.from(requireContext()).inflate(R.layout.item_proxy, b.listContainer, false)
        v.findViewById<TextView>(R.id.pxName).text = name
        v.findViewById<TextView>(R.id.pxType).text = px.type.uppercase()
        val auth = if (!px.username.isNullOrEmpty()) " · ${getString(R.string.px_has_auth)}" else ""
        v.findViewById<TextView>(R.id.pxAddr).text = "${px.host}:${px.port}$auth"
        v.findViewById<ImageButton>(R.id.pxEdit).setOnClickListener { showProxyDialog(name) }
        v.findViewById<ImageButton>(R.id.pxDelete).setOnClickListener { confirmDelete(name) }
        v.setOnClickListener { showProxyDialog(name) }
        return v
    }

    private fun showEmpty(empty: Boolean) {
        b.emptyHint.visibility = if (empty) View.VISIBLE else View.GONE
    }

    

    private fun showProxyDialog(existingName: String?) {
        val db = DialogProxyBinding.inflate(layoutInflater)
        val types = listOf("socks5", "http")
        db.editPxType.setAdapter(ArrayAdapter(requireContext(), android.R.layout.simple_list_item_1, types))
        val existing = existingName?.let { proxies[it] }
        if (existing != null) {
            db.editPxName.setText(existingName)
            db.editPxName.isEnabled = false
            db.editPxType.setText(existing.type, false)
            db.editPxHost.setText(existing.host)
            db.editPxPort.setText(existing.port.toString())
            db.editPxUser.setText(existing.username ?: "")
            db.editPxPass.setText(existing.password ?: "")
        } else {
            db.editPxType.setText("socks5", false)
            db.editPxHost.setText("127.0.0.1")
            db.editPxPort.setText("7890")
        }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(if (existing == null) R.string.px_add else R.string.px_edit)
            .setView(db.root)
            .setPositiveButton(R.string.save) { _, _ -> saveProxy(db, existingName) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun saveProxy(db: DialogProxyBinding, existingName: String?) {
        val name = (existingName ?: db.editPxName.text?.toString()?.trim().orEmpty())
        val type = db.editPxType.text?.toString()?.trim()?.lowercase().orEmpty()
        val host = db.editPxHost.text?.toString()?.trim().orEmpty()
        val port = db.editPxPort.text?.toString()?.toIntOrNull() ?: 0
        if (name.isBlank() || host.isBlank() || port <= 0 || port > 65535) {
            snack(getString(R.string.px_need_valid)); return
        }
        if (type !in listOf("socks5", "http")) { snack(getString(R.string.px_bad_type)); return }
        val user = db.editPxUser.text?.toString()?.trim().orEmpty()
        val pass = db.editPxPass.text?.toString().orEmpty()
        proxies[name] = Proxy(type, host, port, user.ifBlank { null }, pass.ifBlank { null })
        pushProxies(getString(R.string.px_saved))
    }

    private fun confirmDelete(name: String) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.px_delete_title)
            .setMessage(getString(R.string.px_delete_msg, name))
            .setPositiveButton(R.string.delete) { _, _ ->
                proxies.remove(name)
                pushProxies(getString(R.string.pv_deleted))
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    
    private fun pushProxies(successMsg: String) {
        val backend = backendOrNull() ?: return
        val obj = JsonObject()
        proxies.forEach { (name, px) ->
            obj.add(name, JsonObject().apply {
                addProperty("type", px.type)
                addProperty("host", px.host)
                addProperty("port", px.port)
                if (!px.username.isNullOrEmpty()) addProperty("username", px.username)
                if (!px.password.isNullOrEmpty()) addProperty("password", px.password)
            })
        }
        val patch = JsonObject().apply { add("proxies", obj) }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.saveConfig(app.connectionStore.activeInstance, patch)
        }) { r ->
            if (r.ok) { toast(successMsg); render() }
            else snack(getString(R.string.pv_save_failed, r.error ?: ""))
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
