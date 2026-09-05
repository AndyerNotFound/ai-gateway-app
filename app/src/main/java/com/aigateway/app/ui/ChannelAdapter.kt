package com.aigateway.app.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.aigateway.app.R
import com.aigateway.app.data.Channel
import com.google.android.material.button.MaterialButton

class ChannelAdapter(
    private val onEdit: (Channel) -> Unit,
    private val onDelete: (Channel) -> Unit,
    private val onFetchModels: (Channel) -> Unit
) : RecyclerView.Adapter<ChannelAdapter.VH>() {

    private val items = mutableListOf<Channel>()

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
        val ctx = h.itemView.context
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

        h.itemView.setOnClickListener { onEdit(ch) }
        h.btnEdit.setOnClickListener { onEdit(ch) }
        h.btnDelete.setOnClickListener { onDelete(ch) }
        h.btnFetch.setOnClickListener { onFetchModels(ch) }
    }

    override fun getItemCount(): Int = items.size
}
