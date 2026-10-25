package com.aigateway.app.ui

import android.content.Context
import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.aigateway.app.R
import com.aigateway.app.data.Channel
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView

class ChannelAdapter(
    private val onEdit: (Channel) -> Unit,
    private val onDelete: (Channel) -> Unit,
    private val onFetchModels: (Channel) -> Unit,
    private val onLongPress: (Channel) -> Unit
) : RecyclerView.Adapter<ChannelAdapter.VH>() {

    private val items = mutableListOf<Channel>()

    /** 渠道名 -> (余额文本, 预警级别 0/1/2) */
    private val balances = HashMap<String, Pair<String, Int>>()

    fun setBalance(channel: String, text: String, level: Int) {
        balances[channel] = text to level
        val i = items.indexOfFirst { it.name == channel }
        if (i >= 0) notifyItemChanged(i)
    }

    /** 当前主题的上下文(由 Fragment 赋值), 绑定时用它取色, 保证陈旧视图也能刷新为当前主题 */
    var themeContext: Context? = null

    fun submit(list: List<Channel>) {
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }

    class VH(v: View) : RecyclerView.ViewHolder(v) {
        val name: TextView = v.findViewById(R.id.channelName)
        val type: TextView = v.findViewById(R.id.channelType)
        val url: TextView = v.findViewById(R.id.channelUrl)
        val meta: TextView = v.findViewById(R.id.channelMeta)
        val balance: TextView = v.findViewById(R.id.channelBalance)
        val star: ImageView = v.findViewById(R.id.defaultStar)
        val btnEdit: MaterialButton = v.findViewById(R.id.btnEdit)
        val btnDelete: MaterialButton = v.findViewById(R.id.btnDelete)
        val btnFetch: MaterialButton = v.findViewById(R.id.btnFetchModels)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_channel, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(h: VH, position: Int) {
        val ch = items[position]
        val ctx = themeContext ?: h.itemView.context
        // 主题切换后可能存在残留旧配色的回收视图: 每次绑定按当前主题完整重着色
        val cPrimary = resolveColor(ctx, com.google.android.material.R.attr.colorPrimary)
        val cOnSurface = resolveColor(ctx, com.google.android.material.R.attr.colorOnSurface)
        val cOnSurfaceVariant = resolveColor(ctx, com.google.android.material.R.attr.colorOnSurfaceVariant)
        val cSurfaceContainer = resolveColor(ctx, com.google.android.material.R.attr.colorSurfaceContainer)
        val cError = resolveColor(ctx, com.google.android.material.R.attr.colorError)
        (h.itemView as? MaterialCardView)?.setCardBackgroundColor(cSurfaceContainer)
        h.name.setTextColor(cOnSurface)
        h.type.setTextColor(cPrimary)
        h.url.setTextColor(cOnSurfaceVariant)
        h.meta.setTextColor(cOnSurfaceVariant)
        h.star.imageTintList = ColorStateList.valueOf(cPrimary)
        h.btnFetch.setTextColor(cPrimary)
        h.btnEdit.setTextColor(cPrimary)
        h.btnDelete.setTextColor(cError)

        h.name.text = ch.name
        h.type.text = ch.type.uppercase()
        h.url.text = ch.baseUrl
        val modelCount = (ch.models?.size ?: 0) + (ch.modelMap?.size ?: 0)
        val parts = mutableListOf<String>()
        parts.add(ctx.getString(R.string.pv_models_count, modelCount))
        parts.add(if (ch.hasKey || ch.apiKey.isNotBlank()) "key ✓" else ctx.getString(R.string.pv_no_key))
        if (!ch.proxy.isNullOrBlank()) parts.add("proxy:${ch.proxy}")
        if (ch.delayMs > 0) parts.add("${ch.delayMs}ms")
        if (ch.insecure) parts.add("insecure")
        h.meta.text = parts.joinToString(" · ")
        h.star.visibility = if (ch.default) View.VISIBLE else View.GONE

        val bal = balances[ch.name]
        if (bal == null || bal.first.isBlank()) {
            h.balance.visibility = View.GONE
        } else {
            h.balance.visibility = View.VISIBLE
            h.balance.text = bal.first
            h.balance.setTextColor(
                when (bal.second) {
                    2 -> cError
                    1 -> 0xFFFFB300.toInt()
                    else -> cPrimary
                }
            )
        }

        h.itemView.setOnClickListener { onEdit(ch) }
        h.itemView.setOnLongClickListener { onLongPress(ch); true }
        h.btnEdit.setOnClickListener { onEdit(ch) }
        h.btnDelete.setOnClickListener { onDelete(ch) }
        h.btnFetch.setOnClickListener { onFetchModels(ch) }
    }

    override fun getItemCount(): Int = items.size

    private fun resolveColor(ctx: Context, attr: Int): Int {
        val ta = ctx.theme.obtainStyledAttributes(intArrayOf(attr))
        val c = ta.getColor(0, 0); ta.recycle(); return c
    }
}
