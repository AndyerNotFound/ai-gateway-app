package com.aigateway.app.ui

import android.content.ClipData
import android.content.ClipboardManager
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

    /** 刚启用/本机已保存的 TOTP 密钥。服务端只在 enable 那一次返回，必须留在界面上。 */
    private var shownSecret: String? = null
    private var shownUrl: String? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentSecondauthBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.saSaveSecond.setOnClickListener { saveSecondKey() }
        b.saTotpEnable.setOnClickListener { totp("enable") }
        b.saTotpDisable.setOnClickListener { totp("disable") }
        b.saTotpInfo.setOnClickListener { copySecret() }
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
            if (!totp) {
                shownSecret = null
                shownUrl = null
            } else if (shownSecret.isNullOrBlank() && app.connectionStore.activeInstance == "default") {
                // The server never returns the secret again; the copy saved in the profile is the only
                // way to show it after leaving this page.
                val stored = app.connectionStore.getCurrentProfile()?.totpSecret.orEmpty()
                if (stored.isNotBlank()) shownSecret = stored
            }
            renderTotp()
        }
    }

    /** 不要把刚显示的密钥再藏起来：load() 每次成功都会走到这里。 */
    private fun renderTotp() {
        val secret = shownSecret
        if (secret.isNullOrBlank()) {
            b.saTotpInfo.visibility = View.GONE
            return
        }
        b.saTotpInfo.visibility = View.VISIBLE
        b.saTotpInfo.text = buildString {
            append(getString(R.string.sa_totp_secret_fmt, secret))
            val url = shownUrl
            if (!url.isNullOrBlank()) {
                append("\n")
                append(getString(R.string.sa_totp_url_fmt, url))
            }
        }
    }

    private fun copySecret() {
        val secret = shownSecret ?: return
        val cm = requireContext().getSystemService(ClipboardManager::class.java) ?: return
        cm.setPrimaryClip(ClipData.newPlainText("TOTP", secret))
        toast(getString(R.string.sdui_copied))
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
                shownSecret = secret
                shownUrl = j.get("otpauthUrl")?.asString
                    ?: "otpauth://totp/ai-gateway-${app.connectionStore.activeInstance}?secret=$secret&issuer=ai-gateway"
                syncProfile(totp = secret)
                renderTotp()
                snack(getString(R.string.sa_totp_save_warn))
            } else if (action == "disable") {
                shownSecret = null
                shownUrl = null
                syncProfile(totp = "")
                renderTotp()
            }
            load()
        }
    }
}
