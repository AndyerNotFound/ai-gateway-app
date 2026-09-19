package com.aigateway.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentTunnelBinding
import com.google.gson.JsonObject


class TunnelFragment : BaseFragment() {

    private var _b: FragmentTunnelBinding? = null
    private val b get() = _b!!
    private val handler = Handler(Looper.getMainLooper())
    private var polling = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentTunnelBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.tnToggle.setOnClickListener { toggle() }
        b.tnCopy.setOnClickListener {
            val t = b.tnUrl.text?.toString().orEmpty()
            if (t.isNotBlank()) {
                val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("tunnel_url", t))
                snack(getString(R.string.cd_copied))
            }
        }
        load()
    }

    override fun onDestroyView() { polling = false; super.onDestroyView() }
    override fun reload() { if (_b != null) load() }

    private fun load() {
        val backend = backendOrNull() ?: return
        run({ b.tnStatus.text = getString(R.string.load_failed, it) }, { backend.getTunnel() }) { j ->
            render(j.get("running")?.asBoolean == true, j.get("url")?.asString ?: "")
            
            if (j.get("running")?.asBoolean == true && j.get("url")?.asString.isNullOrBlank() && !polling) {
                polling = true
                handler.postDelayed({ polling = false; if (_b != null) load() }, 2500)
            }
        }
    }

    private fun render(running: Boolean, url: String) {
        b.tnToggle.text = getString(if (running) R.string.tn_stop else R.string.tn_start)
        when {
            running && url.isNotBlank() -> {
                b.tnStatus.text = getString(R.string.tn_running)
                b.tnUrlRow.visibility = View.VISIBLE
                b.tnUrl.text = url
            }
            running -> {
                b.tnStatus.text = getString(R.string.tn_starting)
                b.tnUrlRow.visibility = View.GONE
            }
            else -> {
                b.tnStatus.text = getString(R.string.tn_stopped)
                b.tnUrlRow.visibility = View.GONE
            }
        }
    }

    private fun toggle() {
        val backend = backendOrNull() ?: return
        run({ snack(it) }, { backend.getTunnel() }) { cur ->
            val action = if (cur.get("running")?.asBoolean == true) "stop" else "start"
            run({ snack(it) }, { backend.tunnelAction(action) }) {
                snack(getString(if (action == "stop") R.string.tn_stopped else R.string.tn_starting))
                handler.postDelayed({ if (_b != null) load() }, 1500)
            }
        }
    }
}
