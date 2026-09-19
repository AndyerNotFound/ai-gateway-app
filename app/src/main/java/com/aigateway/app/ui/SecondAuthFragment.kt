package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentSecondauthBinding
import com.google.gson.JsonObject


class SecondAuthFragment : BaseFragment() {

    private var _b: FragmentSecondauthBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentSecondauthBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.saSaveSecond.setOnClickListener { saveSecondKey() }
        b.saTotpEnable.setOnClickListener { totp("enable") }
        b.saTotpDisable.setOnClickListener { totp("disable") }
        load()
    }

    override fun reload() { if (_b != null) load() }

    private fun load() {
        val backend = backendOrNull() ?: return
        run({ b.saStatus.text = getString(R.string.load_failed, it) }, {
            backend.getAdminAuth(app.connectionStore.activeInstance)
        }) { j ->
            val hasMain = j.get("hasAdminKey")?.asBoolean == true
            val second = j.get("secondKeySet")?.asBoolean == true
            val totp = j.get("totpEnabled")?.asBoolean == true
            b.saStatus.text = getString(
                R.string.sa_status_fmt,
                if (hasMain) "✓" else "✗",
                if (second) "✓" else "✗",
                if (totp) "✓" else "✗"
            )
            b.saTotpInfo.visibility = View.GONE
        }
    }

    private fun saveSecondKey() {
        val backend = backendOrNull() ?: return
        val body = JsonObject().apply { addProperty("secondKey", b.saSecondKey.text?.toString().orEmpty()) }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.setAdminAuth(app.connectionStore.activeInstance, body)
        }) { snack(getString(R.string.pt_saved)); load() }
    }

    private fun totp(action: String) {
        val backend = backendOrNull() ?: return
        val body = JsonObject().apply { addProperty("totpAction", action) }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.setAdminAuth(app.connectionStore.activeInstance, body)
        }) { j ->
            if (action == "enable" && j.has("totpSecret")) {
                b.saTotpInfo.visibility = View.VISIBLE
                b.saTotpInfo.text = getString(R.string.sa_totp_secret_fmt, j.get("totpSecret").asString)
                snack(getString(R.string.sa_totp_save_warn))
            }
            load()
        }
    }
}
