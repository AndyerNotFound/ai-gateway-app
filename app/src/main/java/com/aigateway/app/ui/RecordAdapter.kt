package com.aigateway.app.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.aigateway.app.R
import com.aigateway.app.data.RequestRecord
import com.aigateway.app.databinding.ItemExtractRecordBinding

class RecordAdapter(private val onClick: (RequestRecord) -> Unit) :
    RecyclerView.Adapter<RecordAdapter.VH>() {

    private val items = ArrayList<RequestRecord>()

    fun submit(list: List<RequestRecord>) {
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val b = ItemExtractRecordBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return VH(b)
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        holder.bind(items[position])
    }

    inner class VH(private val b: ItemExtractRecordBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(r: RequestRecord) {
            val ctx = b.root.context
            b.recTitle.text = r.time.ifBlank { r.id }.replace("T", " ").take(19) + "  " + r.model
            val st = when {
                r.status <= 0 -> "—"
                r.status in 200..299 -> "✓ ${r.status}"
                else -> "✗ ${r.status}"
            }
            b.recSub.text = ctx.getString(R.string.ext_item_sub, r.channel.ifBlank { "—" }, st, r.duration)
            b.recSub.setTextColor(
                when {
                    r.status <= 0 -> 0xFF9E9E9E.toInt()
                    r.status in 200..299 -> 0xFF2E7D32.toInt()
                    else -> 0xFFC62828.toInt()
                }
            )
            b.root.setOnClickListener { onClick(r) }
        }
    }
}
