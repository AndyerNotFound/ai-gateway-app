package com.aigateway.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.aigateway.app.App
import com.aigateway.app.BuildConfig
import com.aigateway.app.MainActivity
import com.aigateway.app.R
import com.aigateway.app.data.ConnectionProfile
import com.aigateway.app.databinding.FragmentEmbeddedBinding
import com.aigateway.app.embedded.EmbeddedGatewayService
import com.aigateway.app.embedded.EmbeddedPaths
import com.aigateway.app.embedded.NodeBridge
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 内置网关：在手机本地运行 ai-gateway-AI（Node 18.20.4 运行时）。 */
class EmbeddedFragment : Fragment() {

    private var _b: FragmentEmbeddedBinding? = null
    private val b get() = _b!!
    private val app: App get() = requireActivity().application as App
    private val main = Handler(Looper.getMainLooper())
    private var polling = false
    private var probing = false

    private companion object {
        const val PROFILE_LABEL = "Local gateway"
        const val STARTING_TIMEOUT_MS = 45_000L
    }

    private val tick = object : Runnable {
        override fun run() {
            if (!isAdded) return
            refresh()
            if (polling) main.postDelayed(this, 1500)
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentEmbeddedBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.embStart.setOnClickListener { startGateway() }
        b.embStop.setOnClickListener { confirmStop() }
        b.embRefresh.setOnClickListener { refresh() }
        b.embUse.setOnClickListener { useLocalGateway() }
        b.embLogs.setOnClickListener { showLogs() }
        b.embBattery.setOnClickListener { requestBatteryWhitelist() }
    }

    override fun onResume() {
        super.onResume()
        polling = true
        main.removeCallbacks(tick)
        main.post(tick)
    }

    override fun onPause() {
        polling = false
        main.removeCallbacks(tick)
        super.onPause()
    }

    private fun refresh() {
        if (_b == null) return
        val raw = EmbeddedPaths.readStatus(requireContext())
        // A process killed while starting leaves "starting" behind forever; age it out.
        val st = if (raw.state == "starting" && System.currentTimeMillis() - raw.since > STARTING_TIMEOUT_MS)
            raw.copy(state = "stopped") else raw
        val pageSize = NodeBridge.pageSize()
        b.embStatus.text = when (st.state) {
            "running" -> getString(R.string.emb_state_running)
            "starting" -> getString(R.string.emb_state_starting)
            "error" -> getString(R.string.emb_state_error)
            else -> getString(R.string.emb_state_stopped)
        }
        val port = st.port
        b.embDetail.text = buildString {
            append(getString(R.string.emb_detail_url, port))
            if (st.pid > 0) append(" · ").append(getString(R.string.emb_detail_pid, st.pid))
            append("\n").append(getString(R.string.emb_detail_runtime, EmbeddedPaths.NODE_VERSION, BuildConfig.VERSION_NAME))
            if (pageSize > 0) append(" · ").append(getString(R.string.emb_detail_pagesize, pageSize))
        }
        if (st.error.isNotBlank()) {
            b.embDetail.append("\n" + st.error)
        }
        b.embStart.isEnabled = !st.running && st.state != "starting"
        b.embStop.isEnabled = st.running || st.state == "starting"
        b.embUse.isEnabled = st.running
        b.embBatteryState.text = batteryStateText()
        if (st.running && !probing) probe(st.port)
    }

    /** The status file is written by another process; a dead process leaves "running" behind. */
    private fun probe(port: Int) {
        probing = true
        viewLifecycleOwner.lifecycleScope.launch {
            val alive = withContext(Dispatchers.IO) {
                runCatching {
                    java.net.Socket().use { it.connect(java.net.InetSocketAddress("127.0.0.1", port), 300) }
                    true
                }.getOrDefault(false)
            }
            probing = false
            if (_b == null) return@launch
            if (!alive) {
                b.embStatus.text = getString(R.string.emb_state_unreachable)
                b.embUse.isEnabled = false
            }
        }
    }

    private fun batteryStateText(): String {
        val pm = requireContext().getSystemService(PowerManager::class.java)
        val ok = pm?.isIgnoringBatteryOptimizations(requireContext().packageName) == true
        return getString(if (ok) R.string.emb_battery_ok else R.string.emb_battery_limited)
    }

    private fun startGateway() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4102)
        }
        try {
            EmbeddedGatewayService.start(requireContext())
            toast(getString(R.string.emb_starting))
            main.postDelayed({ refresh() }, 800)
        } catch (t: Throwable) {
            toast(getString(R.string.emb_err_start, t.message ?: ""))
        }
    }

    private fun confirmStop() {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.emb_stop)
            .setMessage(R.string.emb_stop_confirm)
            .setPositiveButton(R.string.ok) { _, _ ->
                EmbeddedGatewayService.stop(requireContext())
                main.postDelayed({ refresh() }, 600)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun useLocalGateway() {
        val ctx = requireContext()
        val st = EmbeddedPaths.readStatus(ctx)
        if (!st.running) {
            toast(getString(R.string.emb_need_running))
            return
        }
        val token = EmbeddedPaths.tokenOf(ctx)
        if (token.isBlank()) {
            toast(getString(R.string.emb_err_token))
            return
        }
        // Never overwrite the user's remote server: keep a dedicated local profile instead.
        val store = app.connectionStore
        val profile = store.getProfiles().firstOrNull { it.label == PROFILE_LABEL }
            ?: ConnectionProfile(label = PROFILE_LABEL)
        profile.baseUrl = "http://127.0.0.1:${st.port}"
        profile.webToken = token
        profile.secondKey = ""
        profile.totpSecret = ""
        profile.allowInsecureTls = false
        app.updateRemoteProfile(profile)
        store.currentProfileId = profile.id
        app.connectionStore.activeInstance = "default"
        app.connectionStore.setupDone = true
        (activity as? MainActivity)?.onProfileChanged()
        toast(getString(R.string.emb_switched, st.port))
    }

    private fun showLogs() {
        val f = EmbeddedPaths.logFile(requireContext())
        val content = tail(f, 60_000) ?: getString(R.string.emb_log_empty)
        val tv = TextView(requireContext()).apply {
            text = content
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
            val pad = (16 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
        }
        val scroll = android.widget.ScrollView(requireContext()).apply { addView(tv) }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.emb_logs)
            .setView(scroll)
            .setPositiveButton(R.string.ok, null)
            .show()
    }

    private fun tail(f: java.io.File, max: Int): String? {
        if (!f.exists() || f.length() == 0L) return null
        return runCatching {
            java.io.RandomAccessFile(f, "r").use { raf ->
                val start = maxOf(0L, raf.length() - max)
                raf.seek(start)
                val buf = ByteArray((raf.length() - start).toInt())
                raf.readFully(buf)
                String(buf, Charsets.UTF_8)
            }
        }.getOrNull()
    }

    private fun requestBatteryWhitelist() {
        val ctx = requireContext()
        val pm = ctx.getSystemService(PowerManager::class.java)
        if (pm?.isIgnoringBatteryOptimizations(ctx.packageName) == true) {
            toast(getString(R.string.emb_battery_already))
            return
        }
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.packageName))
            )
        } catch (_: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (t: Exception) {
                toast(getString(R.string.emb_battery_failed, t.message ?: ""))
            }
        }
    }

    private fun toast(msg: String) {
        if (isAdded) Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }

    override fun onDestroyView() {
        polling = false
        main.removeCallbacks(tick)
        super.onDestroyView()
        _b = null
    }
}
