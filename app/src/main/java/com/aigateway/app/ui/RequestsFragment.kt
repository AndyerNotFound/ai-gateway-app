package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.aigateway.app.R
import com.aigateway.app.data.RequestEntry
import com.aigateway.app.databinding.FragmentRequestsBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.gson.GsonBuilder
import com.google.gson.JsonParser

class RequestsFragment : BaseFragment() {

    private var _b: FragmentRequestsBinding? = null
    private val b get() = _b!!
    private val adapter = RequestAdapter()
    private val prettyGson = GsonBuilder().setPrettyPrinting().create()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentRequestsBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        adapter.onClick = { showDetail(it) }
        b.requestList.layoutManager = LinearLayoutManager(requireContext())
        b.requestList.adapter = adapter
        b.fabRefresh.setOnClickListener { load() }
        load()
    }

    private fun load() {
        val backend = backendOrNull() ?: run { showEmpty(true); return }
        run({ snack(getString(R.string.load_failed, it)); showEmpty(true) }, {
            backend.getRequests(app.connectionStore.activeInstance)
        }) { list ->
            adapter.submit(list)
            showEmpty(list.isEmpty())
        }
    }

    private fun showEmpty(empty: Boolean) {
        b.emptyHint.visibility = if (empty) View.VISIBLE else View.GONE
        b.requestList.visibility = if (empty) View.GONE else View.VISIBLE
    }

    private fun showDetail(entry: RequestEntry) {
        val backend = backendOrNull() ?: return
        run({ snack(getString(R.string.load_failed, it)) }, {
            backend.getRecordBody(app.connectionStore.activeInstance, entry.id)
        }) { rb ->
            val rec = rb.record
            val sb = StringBuilder()
            sb.append("${entry.time}\n${entry.model}\n${entry.channel} · ${entry.status}\n")
            sb.append("${entry.duration}ms · ↑${entry.inputTokens} ↓${entry.outputTokens}\n\n")
            if (rec != null) {
                sb.append(getString(R.string.rq_section_request)).append("\n").append(pretty(rec.request)).append("\n\n")
                sb.append(getString(R.string.rq_section_response)).append("\n").append(pretty(rec.response))
            } else {
                sb.append(getString(R.string.rq_no_body))
            }
            MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.rq_detail_title)
                .setMessage(sb.toString())
                .setPositiveButton(R.string.close, null)
                .show()
        }
    }

    private fun pretty(v: Any?): String {
        if (v == null) return getString(R.string.rq_empty_value)
        return runCatching {
            if (v is String) {
                val j = JsonParser.parseString(v)
                prettyGson.toJson(j)
            } else prettyGson.toJson(v)
        }.getOrDefault(v.toString())
    }

    

    inner class RequestAdapter : RecyclerView.Adapter<RequestAdapter.VH>() {
        var onClick: ((RequestEntry) -> Unit)? = null
        private val items = mutableListOf<RequestEntry>()

        fun submit(list: List<RequestEntry>) {
            items.clear(); items.addAll(list); notifyDataSetChanged()
        }

        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val time: TextView = v.findViewById(R.id.reqTime)
            val status: TextView = v.findViewById(R.id.reqStatus)
            val model: TextView = v.findViewById(R.id.reqModel)
            val meta: TextView = v.findViewById(R.id.reqMeta)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_request, parent, false)
            return VH(v)
        }

        override fun onBindViewHolder(h: VH, position: Int) {
            val e = items[position]
            h.time.text = e.time
            h.status.text = e.status.toString()
            val ok = e.status in 200..299
            val ta = requireContext().theme.obtainStyledAttributes(intArrayOf(
                if (ok) com.google.android.material.R.attr.colorPrimary else com.google.android.material.R.attr.colorError))
            h.status.setTextColor(ta.getColor(0, 0)); ta.recycle()
            h.model.text = e.model
            h.meta.text = "${e.channel} · ${e.duration}ms · ↑${e.inputTokens} ↓${e.outputTokens}"
            h.itemView.setOnClickListener { onClick?.invoke(e) }
        }

        override fun getItemCount(): Int = items.size
    }

    
    override fun reload() {
        if (_b != null) load()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
