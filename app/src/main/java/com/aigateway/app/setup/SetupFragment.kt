package com.aigateway.app.setup

import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.aigateway.app.App
import com.aigateway.app.MainActivity
import com.aigateway.app.R
import com.aigateway.app.data.ConnectionProfile
import com.aigateway.app.data.ConnectionStore
import com.aigateway.app.databinding.FragmentSetupBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 首次启动：连接一台已经运行中的 ai-gateway-AI。 */
class SetupFragment : Fragment(R.layout.fragment_setup) {

    private var _b: FragmentSetupBinding? = null
    private val b get() = _b!!
    private val app: App get() = requireActivity().application as App

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        _b = FragmentSetupBinding.bind(view)

        val cur = app.connectionStore.getCurrentProfile()
        b.editUrl.setText(cur?.baseUrl ?: ConnectionStore.DEFAULT_URL)
        b.editKey.setText(cur?.webToken.orEmpty())
        b.cbAllowInsecure.isChecked = cur?.allowInsecureTls == true
        b.btnConnect.setOnClickListener { connectAndEnter() }
    }

    private fun connectAndEnter() {
        val url = b.editUrl.text?.toString()?.trim().orEmpty()
        val token = b.editKey.text?.toString()?.trim().orEmpty()
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            toast(getString(R.string.admin_bad_url)); return
        }
        if (token.isBlank()) {
            toast(getString(R.string.admin_token_required)); return
        }

        val existing = app.connectionStore.getCurrentProfile()
        val profile = (existing ?: ConnectionProfile()).apply {
            baseUrl = url.removeSuffix("/")
            webToken = token
            allowInsecureTls = b.cbAllowInsecure.isChecked
        }
        app.updateRemoteProfile(profile)
        app.connectionStore.activeInstance = "default"
        app.connectionStore.setupDone = true

        b.btnConnect.isEnabled = false
        viewLifecycleOwner.lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { app.remoteBackend()?.testConnection() ?: false }.getOrDefault(false)
            }
            if (!isAdded) return@launch
            b.btnConnect.isEnabled = true
            toast(getString(if (ok) R.string.admin_connected else R.string.admin_connect_failed))
            (activity as? MainActivity)?.onSetupDone()
        }
    }

    private fun toast(msg: String) {
        if (isAdded) Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
