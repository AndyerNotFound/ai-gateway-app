package com.aigateway.app.ui

import android.content.res.ColorStateList
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.aigateway.app.MainActivity
import com.aigateway.app.R
import com.aigateway.app.data.ChannelStat
import com.aigateway.app.data.RequestEntry
import com.aigateway.app.data.RunMode
import com.aigateway.app.databinding.FragmentOverviewBinding
import com.aigateway.app.termux.TermuxHelper
import com.google.android.material.card.MaterialCardView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 总览 —— 状态 + 统计 + 最近请求 + 快捷操作 */
class OverviewFragment : BaseFragment() {

    private var _b: FragmentOverviewBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentOverviewBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.btnRefresh.setOnClickListener { load() }
        b.btnConnection.setOnClickListener { (activity as? MainActivity)?.showConnectionDialog() }
        b.btnTheme.setOnClickListener { (activity as? MainActivity)?.showThemeDialogPublic() }
        b.btnAllStats.setOnClickListener { (activity as? MainActivity)?.showFragment("stats") }
        b.btnAllRequests.setOnClickListener { (activity as? MainActivity)?.showFragment("requests") }
        b.btnStartTermux.setOnClickListener {
            (activity as? MainActivity)?.startTermuxBackendPublic()
        }
        b.btnStartTermux.visibility = if (app.connectionStore.runMode == RunMode.TERMUX) View.VISIBLE else View.GONE
        load()
    }

    /** 运行时间本地秒进 + 定期全量刷新 */
    private var uptimeBase = 0L          // 上次从后端取到的运行秒数
    private var uptimeAt = 0L            // 取到的时刻(SystemClock)
    private var ticking = false
    private val tickHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            if (!isAdded || _b == null) return
            if (uptimeAt > 0) {
                val elapsed = (android.os.SystemClock.elapsedRealtime() - uptimeAt) / 1000
                b.textUptime.text = formatUptime(uptimeBase + elapsed)
            }
            refreshTick++
            // 每 10 秒全量刷新一次统计
            if (refreshTick % 10 == 0) load()
            tickHandler.postDelayed(this, 1000)
        }
    }
    private var refreshTick = 0

    override fun onResume() {
        super.onResume()
        if (!ticking) { ticking = true; tickHandler.postDelayed(tick, 1000) }
    }

    override fun onPause() {
        super.onPause()
        ticking = false
        tickHandler.removeCallbacks(tick)
    }

    override fun reload() {
        if (_b != null) {
            b.btnStartTermux.visibility = if (app.connectionStore.runMode == RunMode.TERMUX) View.VISIBLE else View.GONE
            load()
        }
    }

    private fun load() {
        val backend = backendOrNull()
        b.textMode.text = when (app.connectionStore.runMode) {
            RunMode.EMBEDDED -> getString(R.string.ov_mode_embedded)
            RunMode.TERMUX -> getString(R.string.ov_mode_remote,
                app.connectionStore.getCurrentProfile()?.baseUrl ?: getString(R.string.ov_mode_unset))
            null -> getString(R.string.ov_mode_unset)
        }
        if (backend == null) {
            setStatus(false, getString(R.string.ov_not_connected))
            b.textInstance.text = getString(R.string.ov_configure_first)
            return
        }
        viewLifecycleOwner.lifecycleScope.launch {
            val reachable = withContext(Dispatchers.IO) {
                runCatching { backend.testConnection() }.getOrDefault(false)
            }
            if (!isAdded || _b == null) return@launch
            setStatus(reachable, getString(if (reachable) R.string.ov_connected else R.string.ov_connect_failed))
            if (!reachable) {
                b.textInstance.text = getString(R.string.ov_unreachable)
                b.channelStatsContainer.removeAllViews()
                b.recentRequestsContainer.removeAllViews()
                return@launch
            }
            // 实例信息
            runCatching {
                val inst = withContext(Dispatchers.IO) { backend.getInstances() }
                if (!isAdded || _b == null) return@runCatching
                val active = app.connectionStore.activeInstance
                val cur = inst.instances.firstOrNull { it.name == active }
                    ?: inst.instances.firstOrNull { it.name == inst.current }
                    ?: inst.instances.firstOrNull()
                b.textInstance.text = if (cur != null)
                    "${cur.name} · :${cur.port} · ${getString(R.string.pt_channels, cur.chCount)} · " +
                            getString(if (cur.running) R.string.pt_running else R.string.pt_stopped) +
                            (if (cur.tlsOn) " · TLS" else "")
                else getString(R.string.ov_no_instance)
            }.onFailure {
                if (isAdded && _b != null) b.textInstance.text = getString(R.string.ov_load_failed, it.message ?: "")
            }
            // 统计
            val stats = withContext(Dispatchers.IO) {
                runCatching { backend.getStats(app.connectionStore.activeInstance) }.getOrNull()
            }
            if (!isAdded || _b == null) return@launch
            b.textRequests.text = (stats?.requests ?: 0).toString()
            b.textErrors.text = (stats?.errors ?: 0).toString()
            // 记录基准, 由 tick 每秒本地累加
            uptimeBase = stats?.uptime ?: 0
            uptimeAt = android.os.SystemClock.elapsedRealtime()
            b.textUptime.text = formatUptime(uptimeBase)
            renderChannelStats(stats?.byChannel ?: emptyMap())
            // 最近请求(取前 5 条)
            val reqs = withContext(Dispatchers.IO) {
                runCatching { backend.getRequests(app.connectionStore.activeInstance) }.getOrDefault(emptyList())
            }
            if (!isAdded || _b == null) return@launch
            renderRecentRequests(reqs.take(5))
        }
    }

    // ---------- 渲染 ----------

    private fun renderChannelStats(byChannel: Map<String, ChannelStat>) {
        b.channelStatsContainer.removeAllViews()
        if (byChannel.isEmpty()) {
            b.channelStatsContainer.addView(hintText(getString(R.string.st_empty)))
            return
        }
        byChannel.entries.sortedByDescending { it.value.requests }.take(5).forEach { (name, stat) ->
            var detail = getString(R.string.st_channel_detail, stat.requests, stat.inputTokens, stat.outputTokens)
            if (stat.errors > 0) detail = getString(R.string.st_channel_errors, detail, stat.errors)
            b.channelStatsContainer.addView(smallCard(name, detail))
        }
    }

    private fun renderRecentRequests(list: List<RequestEntry>) {
        b.recentRequestsContainer.removeAllViews()
        if (list.isEmpty()) {
            b.recentRequestsContainer.addView(hintText(getString(R.string.ov_no_requests)))
            return
        }
        list.forEach { e ->
            val title = "${e.model}  ·  ${e.status}"
            val detail = "${e.time} · ${e.channel} · ${e.duration}ms · ↑${e.inputTokens} ↓${e.outputTokens}"
            val card = smallCard(title, detail)
            card.setOnClickListener { (activity as? MainActivity)?.showFragment("requests") }
            b.recentRequestsContainer.addView(card)
        }
    }

    private fun hintText(text: String): TextView = TextView(requireContext()).apply {
        this.text = text
        setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodySmall)
        setTextColor(resolveAttr(com.google.android.material.R.attr.colorOnSurfaceVariant))
        val p = (8 * resources.displayMetrics.density).toInt()
        setPadding(p, p, p, p)
    }

    private fun smallCard(title: String, detail: String): MaterialCardView {
        val ctx = requireContext()
        val d = resources.displayMetrics.density
        val card = MaterialCardView(ctx).apply {
            radius = 14f * d
            cardElevation = 0f
            setCardBackgroundColor(resolveAttr(com.google.android.material.R.attr.colorSurfaceContainer))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = (8 * d).toInt() }
        }
        val inner = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            val p = (14 * d).toInt()
            setPadding(p, p, p, p)
        }
        inner.addView(TextView(ctx).apply {
            text = title
            setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_TitleSmall)
        })
        inner.addView(TextView(ctx).apply {
            text = detail
            setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodySmall)
            setTextColor(resolveAttr(com.google.android.material.R.attr.colorOnSurfaceVariant))
        })
        card.addView(inner)
        return card
    }

    private fun resolveAttr(attr: Int): Int {
        val ta = requireContext().theme.obtainStyledAttributes(intArrayOf(attr))
        val c = ta.getColor(0, 0)
        ta.recycle()
        return c
    }

    private fun formatUptime(sec: Long): String = when {
        sec < 3600 -> String.format("%d:%02d", sec / 60, sec % 60)
        sec < 86400 -> String.format("%d:%02d:%02d", sec / 3600, (sec % 3600) / 60, sec % 60)
        else -> "${sec / 86400}d ${(sec % 86400) / 3600}h"
    }

    private fun setStatus(ok: Boolean, text: String) {
        b.textStatus.text = text
        val color = ContextCompat.getColor(requireContext(),
            if (ok) android.R.color.holo_green_dark else android.R.color.holo_red_dark)
        b.statusDot.backgroundTintList = ColorStateList.valueOf(color)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
