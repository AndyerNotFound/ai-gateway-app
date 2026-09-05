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
import com.aigateway.app.data.RunMode
import com.aigateway.app.databinding.FragmentSetupBinding
import com.aigateway.app.termux.TermuxHelper
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 首次启动: 模式选择 + 可选连接 + Termux 操作 */
class SetupFragment : Fragment(R.layout.fragment_setup) {

    private var _b: FragmentSetupBinding? = null
    private val b get() = _b!!
    private val app: App get() = requireActivity().application as App

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        _b = FragmentSetupBinding.bind(view)

        b.cardEmbedded.setOnClickListener {
            app.setMode(RunMode.EMBEDDED)
            finishSetup()
        }

        b.cardTermux.setOnClickListener {
            val show = b.termuxPanel.visibility != View.VISIBLE
            b.termuxPanel.visibility = if (show) View.VISIBLE else View.GONE
            if (show) updateTermuxStatus()
        }

        b.btnQuickLocal.setOnClickListener { b.editUrl.setText(ConnectionStore.DEFAULT_TERMUX_URL) }
        b.btnQuickLan.setOnClickListener { b.editUrl.setText(ConnectionStore.DEFAULT_LAN_URL) }

        b.btnConnect.setOnClickListener { connectAndEnter() }
        b.btnSkipConnect.setOnClickListener {
            app.setMode(RunMode.TERMUX)
            finishSetup()
        }

        b.btnStartBackend.setOnClickListener {
            when (TermuxHelper.startBackendDetailed(requireContext())) {
                is TermuxHelper.RunResult.Success -> toast(getString(R.string.termux_cmd_sent))
                is TermuxHelper.RunResult.NotInstalled -> toast(getString(R.string.termux_not_installed))
                is TermuxHelper.RunResult.Failed -> showPermHint()
            }
        }
        b.btnDeploy.setOnClickListener { confirmDeploy() }
        b.btnOpenTermux.setOnClickListener {
            if (!TermuxHelper.openTermux(requireContext())) toast(getString(R.string.termux_not_installed))
        }

        updateTermuxStatus()
    }

    private fun updateTermuxStatus() {
        val installed = TermuxHelper.isTermuxInstalled(requireContext())
        b.textTermuxStatus.text = getString(if (installed) R.string.termux_detected else R.string.termux_not_detected)
        val enable = installed
        b.btnStartBackend.isEnabled = enable
        b.btnDeploy.isEnabled = enable
        b.btnOpenTermux.isEnabled = enable
    }

    private fun connectAndEnter() {
        val url = b.editUrl.text?.toString()?.trim().orEmpty()
        val key = b.editKey.text?.toString()?.trim().orEmpty()
        if (url.isBlank()) { toast(getString(R.string.connect_need_url)); return }
        val profile = ConnectionProfile(label = "", baseUrl = url, adminKey = key)
        app.setMode(RunMode.TERMUX)
        app.updateRemoteProfile(profile)
        b.btnConnect.isEnabled = false
        b.btnConnect.text = getString(R.string.connecting)
        viewLifecycleOwner.lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { app.remoteBackend()?.testConnection() ?: false }.getOrDefault(false)
            }
            if (!isAdded) return@launch
            b.btnConnect.isEnabled = true
            b.btnConnect.text = getString(R.string.setup_connect_enter)
            toast(getString(if (ok) R.string.connect_ok else R.string.connect_failed_entered))
            finishSetup()
        }
    }

    private fun confirmDeploy() {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.termux_deploy_title)
            .setMessage(R.string.termux_deploy_msg)
            .setPositiveButton(R.string.termux_deploy_start) { _, _ ->
                val ok = TermuxHelper.deployAndInstall(requireContext())
                toast(getString(if (ok) R.string.termux_deploy_ok else R.string.termux_deploy_failed))
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Termux 未授权外部调用: 提示开启方法 */
    private fun showPermHint() {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.termux_perm_title)
            .setMessage(R.string.termux_perm_hint)
            .setPositiveButton(R.string.termux_copy_cmd) { _, _ ->
                val cmd = "mkdir -p ~/.termux && echo 'allow-external-apps=true' >> ~/.termux/termux.properties"
                val cm = requireContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("termux-cmd", cmd))
                toast(getString(R.string.termux_cmd_copied))
            }
            .setNeutralButton(R.string.termux_open_anyway) { _, _ -> TermuxHelper.openTermux(requireContext()) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun finishSetup() {
        app.connectionStore.setupDone = true
        (activity as? MainActivity)?.onSetupDone()
    }

    private fun toast(msg: String) {
        if (isAdded) Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
