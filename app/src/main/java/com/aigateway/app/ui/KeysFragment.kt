package com.aigateway.app.ui

import android.os.Bundle
import com.aigateway.app.R
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.aigateway.app.databinding.FragmentKeysBinding
import com.google.gson.JsonObject

class KeysFragment : BaseFragment() {

    private var _b: FragmentKeysBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentKeysBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.btnSaveKeys.setOnClickListener { save() }
        load()
    }

    private fun load() {
        val backend = backendOrNull() ?: return
        run({ snack(getString(R.string.load_failed, it)) }, {
            backend.getConfig(app.connectionStore.activeInstance)
        }) { cfg ->
            b.editGatewayKey.setText(cfg.gatewayKey)
            b.editAdminKey.setText(cfg.adminKey)
        }
    }

    private fun save() {
        val backend = backendOrNull() ?: return
        val patch = JsonObject().apply {
            addProperty("gatewayKey", b.editGatewayKey.text?.toString()?.trim().orEmpty())
            addProperty("adminKey", b.editAdminKey.text?.toString()?.trim().orEmpty())
        }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.saveConfig(app.connectionStore.activeInstance, patch)
        }) { r ->
            if (r.ok) toast(getString(R.string.keys_saved))
            else snack(getString(R.string.pv_save_failed, r.error ?: ""))
        }
    }

    
    override fun reload() {
        if (_b != null) load()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
