package com.aigateway.app.ui

import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.aigateway.app.R
import com.aigateway.app.data.ChatMessage
import com.google.android.material.card.MaterialCardView

/** 聊天气泡适配器(用户靠右 / AI 靠左) */
class ChatAdapter : RecyclerView.Adapter<ChatAdapter.VH>() {

    val messages = mutableListOf<ChatMessage>()

    fun add(msg: ChatMessage) {
        messages.add(msg)
        notifyItemInserted(messages.size - 1)
    }

    fun appendToLast(delta: String) {
        val idx = messages.indexOfLast { it.role == "assistant" }
        if (idx >= 0) {
            messages[idx] = messages[idx].copy(content = messages[idx].content + delta)
            notifyItemChanged(idx)
        }
    }

    fun setLastError(err: String) {
        val idx = messages.indexOfLast { it.role == "assistant" }
        if (idx >= 0) {
            messages[idx] = messages[idx].copy(content = err)
            notifyItemChanged(idx)
        }
    }

    class VH(v: View) : RecyclerView.ViewHolder(v) {
        val container: LinearLayout = v as LinearLayout
        val bubble: MaterialCardView = v.findViewById(R.id.bubble)
        val text: TextView = v.findViewById(R.id.textMessage)
        val role: TextView = v.findViewById(R.id.textRole)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_chat_message, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(h: VH, position: Int) {
        val msg = messages[position]
        h.text.text = msg.content.ifBlank { "…" }
        val ctx = h.itemView.context
        if (msg.role == "user") {
            h.container.gravity = Gravity.END
            h.bubble.setCardBackgroundColor(resolveAttr(ctx, com.google.android.material.R.attr.colorPrimary))
            h.text.setTextColor(resolveAttr(ctx, com.google.android.material.R.attr.colorOnPrimary))
            h.role.text = ctx.getString(R.string.ch_you)
        } else {
            h.container.gravity = Gravity.START
            h.bubble.setCardBackgroundColor(resolveAttr(ctx, com.google.android.material.R.attr.colorSurfaceContainerHigh))
            h.text.setTextColor(resolveAttr(ctx, com.google.android.material.R.attr.colorOnSurface))
            h.role.text = ctx.getString(R.string.ch_ai)
        }
    }

    private fun resolveAttr(ctx: android.content.Context, attr: Int): Int {
        val ta = ctx.theme.obtainStyledAttributes(intArrayOf(attr))
        val c = ta.getColor(0, 0)
        ta.recycle()
        return c
    }

    override fun getItemCount(): Int = messages.size
}
