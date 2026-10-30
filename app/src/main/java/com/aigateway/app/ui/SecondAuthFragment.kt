package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentSecondauthBinding
import com.google.gson.JsonObject

/** 管理端 · 第二验证设置(第二密码 + TOTP) */
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
            val hasMain = (j.get("hasWebToken") ?: j.get("hasAdminKey"))?.asBoolean == true
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
        val secondValue = b.saSecondKey.text?.toString().orEmpty()
        val body = JsonObject().apply { addProperty("secondKey", secondValue) }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.setAdminAuth(app.connectionStore.activeInstance, body)
        }) {
            syncProfile(second = secondValue)
            snack(getString(R.string.pt_saved)); load()
        }
    }

    /** default 是 baseUrl 承载实例；只有它的第二因子会影响当前连接。 */
    private fun syncProfile(second: String? = null, totp: String? = null) {
        if (app.connectionStore.activeInstance != "default") return
        val p = app.connectionStore.getCurrentProfile() ?: return
        var changed = false
        if (second != null && p.secondKey != second) { p.secondKey = second; changed = true }
        if (totp != null && p.totpSecret != totp) { p.totpSecret = totp; changed = true }
        if (changed) app.updateRemoteProfile(p)
    }

    private fun totp(action: String) {
        val backend = backendOrNull() ?: return
        val body = JsonObject().apply { addProperty("totpAction", action) }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.setAdminAuth(app.connectionStore.activeInstance, body)
        }) { j ->
            if (action == "enable" && j.has("totpSecret")) {
                val secret = j.get("totpSecret").asString
                b.saTotpInfo.visibility = View.VISIBLE
                b.saTotpInfo.text = getString(R.string.sa_totp_secret_fmt, secret)
                syncProfile(totp = secret)
                snack(getString(R.string.sa_totp_save_warn))
            } else if (action == "disable") {
                syncProfile(totp = "")
            }
            load()
        }
    }
}
