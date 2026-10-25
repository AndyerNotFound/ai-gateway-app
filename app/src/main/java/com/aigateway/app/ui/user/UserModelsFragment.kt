package com.aigateway.app.ui.user

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentUserModelsBinding
import com.aigateway.app.ui.BaseFragment
import com.google.android.material.chip.Chip
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/** 用户端 · 模型广场: 搜索 + 分组筛选 + 排序 */
class UserModelsFragment : BaseFragment() {

    private var _b: FragmentUserModelsBinding? = null
    private val b get() = _b!!
    private val adapter = ModelAdapter()

    private var allModels = listOf<String>()
    private var query = ""
    private var groupFilter = ""      // 空 = 全部
    private var sortAsc = true        // 名称升序

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentUserModelsBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.umList.adapter = adapter
        b.umList.layoutManager = androidx.recyclerview.widget.LinearLayoutManager(requireContext())
        b.umRefresh.setOnClickListener { load() }
        b.umSort.setOnClickListener { showSortMenu() }
        b.umSearch.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) { query = s?.toString()?.trim()?.lowercase() ?: ""; applyFilter() }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b2: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b2: Int, c: Int) {}
        })
        load()
    }

    override fun reload() { if (_b != null) load() }

    /** 分组键: 实例/分支名(通过 /v1/branches 拿到的实例分组) */
    // 模型按实例分组: allModels 的元素是 "实例名:模型id" 组合, groupOf 提取实例名
    private fun groupOf(model: String): String {
        val cut = model.indexOf(':')
        return if (cut > 0) model.substring(0, cut) else model
    }

    private fun load() {
        val ub = app.userBackend()
        run({ b.umEmpty.visibility = View.VISIBLE; b.umEmpty.text = getString(R.string.load_failed, it) }, {
            // 先拿可访问分支, 逐分支拉模型, 合并为 "分支:模型" 列表
            val branchesJ = ub.branches()
            val branches = branchesJ.getAsJsonArray("branches")?.map { it.asString } ?: listOf("")
            val out = mutableListOf<String>()
            for (br in branches) {
                val base = app.userStore.serverUrl + (if (br.isBlank() || br == "default") "" else "/$br") + "/v1"
                try {
                    val modelsJ = ub.modelsAt(base)
                    modelsJ.getAsJsonArray("data")?.forEach { m ->
                        m.asJsonObject?.get("id")?.asString?.let { out.add((if (br.isBlank()) "default" else br) + ":" + it) }
                    }
                } catch (_: Exception) {}
            }
            com.google.gson.JsonObject().apply { add("list", com.google.gson.JsonArray().apply { out.forEach { add(it) } }) }
        }) { j ->
            allModels = j.getAsJsonArray("list")?.map { it.asString } ?: emptyList()
            buildGroupChips()
            applyFilter()
        }
    }

    private fun buildGroupChips() {
        val cg = b.umGroupChips
        cg.removeAllViews()
        val groups = allModels.groupBy { groupOf(it) }.toSortedMap()
        // "全部" chip
        val chipAll = Chip(requireContext()).apply {
            text = getString(R.string.um_group_all, allModels.size)
            isCheckable = true; isChecked = groupFilter.isEmpty()
            setOnClickListener { groupFilter = ""; syncChips(); applyFilter() }
            tag = ""
        }
        cg.addView(chipAll)
        for ((g, list) in groups) {
            val chip = Chip(requireContext()).apply {
                text = "$g (${list.size})"
                isCheckable = true; isChecked = groupFilter == g
                setOnClickListener { groupFilter = g; syncChips(); applyFilter() }
                tag = g
            }
            cg.addView(chip)
        }
    }

    private fun syncChips() {
        val cg = b.umGroupChips
        for (i in 0 until cg.childCount) {
            val chip = cg.getChildAt(i) as? Chip ?: continue
            chip.isChecked = (chip.tag as? String ?: "") == groupFilter
        }
    }

    private fun applyFilter() {
        var list = allModels
        if (groupFilter.isNotEmpty()) list = list.filter { groupOf(it) == groupFilter }
        if (query.isNotEmpty()) list = list.filter { it.lowercase().contains(query) }
        list = if (sortAsc) list.sorted() else list.sortedDescending()
        b.umCount.text = getString(R.string.um_count, list.size)
        b.umEmpty.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
        adapter.submitList(list)
    }

    private fun showSortMenu() {
        val items = arrayOf(getString(R.string.um_sort_asc), getString(R.string.um_sort_desc))
        val checked = if (sortAsc) 0 else 1
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.um_sort)
            .setSingleChoiceItems(items, checked) { dlg, which ->
                sortAsc = (which == 0)
                applyFilter()
                dlg.dismiss()
            }
            .show()
    }

    class ModelAdapter : ListAdapter<String, ModelAdapter.VH>(object : DiffUtil.ItemCallback<String>() {
        override fun areItemsTheSame(a: String, b: String) = a == b
        override fun areContentsTheSame(a: String, b: String) = a == b
    }) {
        class VH(val tv: TextView) : RecyclerView.ViewHolder(tv)
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val tv = LayoutInflater.from(parent.context)
                .inflate(R.layout.item_simple_text, parent, false) as TextView
            return VH(tv)
        }
        override fun onBindViewHolder(h: VH, position: Int) {
            val full = getItem(position)
            // 显示时去掉 "分支:" 前缀
            h.tv.text = if (full.contains(':')) full.substringAfter(':') else full
        }
    }
}
