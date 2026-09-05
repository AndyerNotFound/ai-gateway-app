package com.aigateway.app.ui

import android.os.Bundle
import com.aigateway.app.R
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.aigateway.app.data.ChannelStat
import com.aigateway.app.databinding.FragmentStatsBinding
import com.google.android.material.card.MaterialCardView

class StatsFragment : BaseFragment() {

    private var _b: FragmentStatsBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentStatsBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.btnRefreshStats.setOnClickListener { load() }
        load()
    }

    private fun load() {
        val backend = backendOrNull() ?: run { showEmpty(true); return }
        run({ snack(getString(R.string.load_failed, it)); showEmpty(true) }, {
            backend.getStats(app.connectionStore.activeInstance)
        }) { stats ->
            b.textStatRequests.text = stats.requests.toString()
            b.textStatErrors.text = stats.errors.toString()
            b.textStatUptime.text = formatUptime(stats.uptime)
            b.statsHint.text = getString(R.string.st_hint, app.connectionStore.activeInstance)
            renderChannels(stats.byChannel)
        }
    }

    private fun renderChannels(byChannel: Map<String, ChannelStat>) {
        b.channelStatsContainer.removeAllViews()
        if (byChannel.isEmpty()) { showEmpty(true); return }
        showEmpty(false)
        byChannel.entries.sortedByDescending { it.value.requests }.forEach { (name, stat) ->
            b.channelStatsContainer.addView(makeChannelCard(name, stat))
        }
    }

    private fun makeChannelCard(name: String, stat: ChannelStat): View {
        val ctx = requireContext()
        val card = MaterialCardView(ctx).apply {
            radius = 18f * resources.displayMetrics.density
            cardElevation = 0f
            setCardBackgroundColor(resolveAttr(com.google.android.material.R.attr.colorSurfaceContainer))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = (8 * resources.displayMetrics.density).toInt()
            }
        }
        val inner = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            val p = (16 * resources.displayMetrics.density).toInt()
            setPadding(p, p, p, p)
        }
        val title = TextView(ctx).apply {
            text = name
            setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_TitleMedium)
        }
        val detail = TextView(ctx).apply {
            text = getString(R.string.st_channel_detail, stat.requests, stat.inputTokens, stat.outputTokens).let { d ->
                if (stat.errors > 0) getString(R.string.st_channel_errors, d, stat.errors) else d }
            setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodySmall)
            setTextColor(resolveAttr(com.google.android.material.R.attr.colorOnSurfaceVariant))
        }
        inner.addView(title)
        inner.addView(detail)
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
        sec < 60 -> "${sec}s"
        sec < 3600 -> "${sec / 60}m ${sec % 60}s"
        else -> "${sec / 3600}h ${(sec % 3600) / 60}m"
    }

    private fun showEmpty(empty: Boolean) {
        b.emptyHint.visibility = if (empty) View.VISIBLE else View.GONE
    }

    /** 基类在实例/连接变化时调用 */
    override fun reload() {
        if (_b != null) load()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
