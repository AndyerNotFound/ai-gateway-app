package com.aigateway.app.ui

import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.aigateway.app.R
import com.aigateway.app.data.InstanceStat
import com.aigateway.app.data.ModelStat
import com.aigateway.app.data.StatsAll
import com.aigateway.app.data.StatsTotals
import com.aigateway.app.databinding.FragmentStatsBinding
import java.util.Locale

/** 统计：实例 / 模型 / 渠道的使用量、Token 与占比。 */
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
        run({
            snack(getString(R.string.load_failed, it))
            showEmpty(true)
        }, {
            try {
                backend.getStatsAll()
            } catch (_: Exception) {
                fromSingle(backend.getStats(app.connectionStore.activeInstance))
            }
        }) { data -> render(data) }
    }

    /** 老服务端没有 /stats-all 时的退路：只显示当前实例。 */
    private fun fromSingle(st: com.aigateway.app.data.Stats): StatsAll {
        val inTok = st.byChannel.values.sumOf { it.inputTokens }
        val outTok = st.byChannel.values.sumOf { it.outputTokens }
        return StatsAll(
            totals = StatsTotals(1, st.requests, st.errors, inTok, outTok),
            byModel = st.byModel,
            instances = listOf(
                InstanceStat(
                    name = app.connectionStore.activeInstance,
                    requests = st.requests, errors = st.errors,
                    inputTokens = inTok, outputTokens = outTok,
                    byChannel = st.byChannel, byModel = st.byModel
                )
            )
        )
    }

    private fun render(data: StatsAll) {
        val t = data.totals
        b.textStatRequests.text = fmt(t.requests)
        b.textStatTokensIn.text = fmt(t.inputTokens)
        b.textStatTokensOut.text = fmt(t.outputTokens)
        b.textStatErrors.text = fmt(t.errors)
        b.statsHint.text = getString(R.string.st_totals_hint, t.instances)

        val totalTok = t.inputTokens + t.outputTokens
        renderInstances(data.instances, totalTok, t.requests)
        renderModels(data.byModel, totalTok, t.requests)
        renderChannels(data.instances)

        val empty = t.requests == 0L && data.instances.isEmpty()
        showEmpty(empty)
    }

    private fun renderInstances(list: List<InstanceStat>, totalTok: Long, totalReq: Long) {
        b.instanceStatsContainer.removeAllViews()
        list.sortedByDescending { it.inputTokens + it.outputTokens }
            .forEach { st ->
                val tok = st.inputTokens + st.outputTokens
                addRow(
                    b.instanceStatsContainer,
                    st.name.ifBlank { "default" },
                    getString(R.string.st_inst_sub, fmt(tok), fmt(st.requests), fmt(st.errors)),
                    pct(tok, totalTok, st.requests, totalReq),
                    color(com.google.android.material.R.attr.colorPrimary)
                )
            }
    }

    private fun renderModels(byModel: Map<String, ModelStat>, totalTok: Long, totalReq: Long) {
        b.modelStatsContainer.removeAllViews()
        byModel.entries
            .sortedByDescending { it.value.inputTokens + it.value.outputTokens }
            .take(15)
            .forEach { (name, st) ->
                val tok = st.inputTokens + st.outputTokens
                addRow(
                    b.modelStatsContainer,
                    name.ifBlank { "(unknown)" },
                    getString(R.string.st_model_sub, fmt(tok), fmt(st.requests)),
                    pct(tok, totalTok, st.requests, totalReq),
                    color(com.google.android.material.R.attr.colorTertiary)
                )
            }
    }

    private fun renderChannels(instances: List<InstanceStat>) {
        val active = app.connectionStore.activeInstance
        // 当前实例没有流量时，退回到用量最大的实例，避免整块渠道统计直接消失。
        val inst = instances.firstOrNull { it.name == active && it.byChannel.isNotEmpty() }
            ?: instances.filter { it.byChannel.isNotEmpty() }.maxByOrNull { it.inputTokens + it.outputTokens }
            ?: instances.firstOrNull()
        val byChannel = inst?.byChannel.orEmpty()
        b.channelSection.text = if (inst != null) getString(R.string.st_by_channel_fmt, inst.name) else getString(R.string.st_by_channel)
        b.channelSection.visibility = if (byChannel.isEmpty()) View.GONE else View.VISIBLE
        b.channelStatsContainer.removeAllViews()
        val totalTok = byChannel.values.sumOf { it.inputTokens + it.outputTokens }
        val totalReq = byChannel.values.sumOf { it.requests }
        byChannel.entries
            .sortedByDescending { it.value.inputTokens + it.value.outputTokens }
            .forEach { (name, st) ->
                val tok = st.inputTokens + st.outputTokens
                val sub = getString(R.string.st_channel_detail, st.requests, st.inputTokens, st.outputTokens)
                addRow(
                    b.channelStatsContainer,
                    name.ifBlank { "(default)" },
                    if (st.errors > 0) getString(R.string.st_channel_errors, sub, st.errors) else sub,
                    pct(tok, totalTok, st.requests, totalReq),
                    color(com.google.android.material.R.attr.colorSecondary)
                )
            }
    }

    private fun addRow(parent: LinearLayout, title: String, sub: String, percent: Double, tint: Int) {
        val ctx = requireContext()
        val d = resources.displayMetrics.density
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, (10 * d).toInt(), 0, (6 * d).toInt())
        }
        val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        head.addView(TextView(ctx).apply {
            text = title
            setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodyLarge)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        head.addView(TextView(ctx).apply {
            text = String.format(Locale.US, "%.1f%%", percent)
            setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_LabelLarge)
            setTextColor(tint)
        })

        val track = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            background = GradientDrawable().apply {
                cornerRadius = 3 * d
                setColor(color(com.google.android.material.R.attr.colorSurfaceVariant))
            }
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, (6 * d).toInt()
            ).apply { topMargin = (6 * d).toInt() }
        }
        val fillWeight = (percent / 100.0).coerceIn(0.0, 1.0).toFloat()
        track.addView(View(ctx).apply {
            background = GradientDrawable().apply { cornerRadius = 3 * d; setColor(tint) }
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, fillWeight))
        track.addView(View(ctx), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f - fillWeight))

        box.addView(head)
        box.addView(track)
        box.addView(TextView(ctx).apply {
            text = sub
            setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodySmall)
            setTextColor(color(com.google.android.material.R.attr.colorOnSurfaceVariant))
            setPadding(0, (4 * d).toInt(), 0, 0)
        })
        parent.addView(box)
    }

    /** 有 Token 数据时按 Token 算占比，否则退回按请求数。 */
    private fun pct(tok: Long, totalTok: Long, req: Long, totalReq: Long): Double =
        if (totalTok > 0) tok * 100.0 / totalTok
        else if (totalReq > 0) req * 100.0 / totalReq
        else 0.0

    private fun fmt(n: Long): String = when {
        n >= 1_000_000_000L -> String.format(Locale.US, "%.1fB", n / 1_000_000_000.0)
        n >= 1_000_000L -> String.format(Locale.US, "%.1fM", n / 1_000_000.0)
        n >= 10_000L -> String.format(Locale.US, "%.1fK", n / 1_000.0)
        else -> n.toString()
    }

    private fun color(attr: Int): Int {
        val ta = requireContext().theme.obtainStyledAttributes(intArrayOf(attr))
        val c = ta.getColor(0, 0)
        ta.recycle()
        return c
    }

    private fun showEmpty(empty: Boolean) {
        if (_b == null) return
        b.emptyHint.visibility = if (empty) View.VISIBLE else View.GONE
    }

    override fun reload() {
        if (_b != null) load()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
