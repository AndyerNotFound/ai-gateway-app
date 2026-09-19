package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentRegSettingsBinding
import com.google.gson.JsonObject


class RegSettingsFragment : BaseFragment() {

    private var _b: FragmentRegSettingsBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentRegSettingsBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.rgEnable.setOnCheckedChangeListener { _, on ->
            b.rgMore.visibility = if (on) View.VISIBLE else View.GONE
        }
        b.rgSave.setOnClickListener { save() }
        load()
    }

    override fun reload() { if (_b != null) load() }

    private fun load() {
        val backend = backendOrNull() ?: return
        run({}, { backend.getConfig(app.connectionStore.activeInstance) }) { cfg ->
            b.rgKeyLength.setText((cfg.keyLength ?: 24).toString())
            val reg = cfg.registration
            val en = reg?.get("enable")?.asBoolean == true
            b.rgEnable.isChecked = en
            b.rgMore.visibility = if (en) View.VISIBLE else View.GONE
            b.rgDefaultQuota.setText(((reg?.get("defaultQuota")?.asLong ?: 0) / 10000).toString())
            b.rgMinPw.setText((reg?.get("minPasswordLen")?.asInt ?: 8).toString())
            if (reg?.get("captchaProvider")?.asString == "turnstile") b.rgCaptchaTurnstile.isChecked = true
            else b.rgCaptchaNone.isChecked = true
            b.rgCaptchaSiteKey.setText(reg?.get("captchaSiteKey")?.asString ?: "")
            b.rgCaptchaSecret.setText(reg?.get("captchaSecret")?.asString ?: "")
        }
    }

    private fun save() {
        val backend = backendOrNull() ?: return
        val reg = JsonObject().apply {
            addProperty("enable", b.rgEnable.isChecked)
            addProperty("defaultQuota", (b.rgDefaultQuota.text?.toString()?.toLongOrNull() ?: 0) * 10000)
            addProperty("minPasswordLen", b.rgMinPw.text?.toString()?.toIntOrNull() ?: 8)
            addProperty("captchaProvider", if (b.rgCaptchaTurnstile.isChecked) "turnstile" else "none")
            addProperty("captchaSiteKey", b.rgCaptchaSiteKey.text?.toString()?.trim().orEmpty())
            addProperty("captchaSecret", b.rgCaptchaSecret.text?.toString()?.trim().orEmpty())
        }
        val body = JsonObject().apply {
            addProperty("keyLength", b.rgKeyLength.text?.toString()?.toIntOrNull() ?: 24)
            add("registration", reg)
        }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.saveConfig(app.connectionStore.activeInstance, body)
        }) { snack(getString(R.string.pt_saved)) }
    }
}
