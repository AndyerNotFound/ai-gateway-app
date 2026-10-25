package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.aigateway.app.R
import com.aigateway.app.data.ReplaceRule
import com.aigateway.app.databinding.DialogReplaceRuleBinding
import com.aigateway.app.databinding.FragmentReplaceBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject

class ReplaceFragment : BaseFragment() {

    private var _b: FragmentReplaceBinding? = null
    private val b get() = _b!!
    private val outRules = mutableListOf<ReplaceRule>()
    private val incRules = mutableListOf<ReplaceRule>()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentReplaceBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.btnAddOut.setOnClickListener { editRule(outRules, -1, getString(R.string.rp_dir_out)) }
        b.btnAddInc.setOnClickListener { editRule(incRules, -1, getString(R.string.rp_dir_inc)) }
        b.btnSaveReplace.setOnClickListener { save() }
        // 正则速查表折叠
        b.cheatHeader.setOnClickListener {
            val show = b.cheatBody.visibility != View.VISIBLE
            b.cheatBody.visibility = if (show) View.VISIBLE else View.GONE
            b.cheatToggle.text = if (show) "▲" else "▼"
        }
        load()
    }

    private fun load() {
        val backend = backendOrNull() ?: return
        run({ snack(getString(R.string.load_failed, it)) }, {
            backend.getConfig(app.connectionStore.activeInstance)
        }) { cfg ->
            outRules.clear(); outRules.addAll(cfg.replace.out)
            incRules.clear(); incRules.addAll(cfg.replace.inc)
            render()
        }
    }

    private fun render() {
        renderContainer(b.outContainer, outRules, getString(R.string.rp_dir_out))
        renderContainer(b.incContainer, incRules, getString(R.string.rp_dir_inc))
    }

    private fun renderContainer(container: LinearLayout, rules: MutableList<ReplaceRule>, label: String) {
        container.removeAllViews()
        if (rules.isEmpty()) {
            val tv = TextView(requireContext())
            tv.text = getString(R.string.rp_empty_rules, label)
            tv.setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodySmall)
            val ta = requireContext().theme.obtainStyledAttributes(intArrayOf(com.google.android.material.R.attr.colorOnSurfaceVariant))
            tv.setTextColor(ta.getColor(0, 0)); ta.recycle()
            container.addView(tv)
            return
        }
        rules.forEachIndexed { idx, rule ->
            val v = LayoutInflater.from(requireContext()).inflate(R.layout.item_replace_rule, container, false)
            v.findViewById<TextView>(R.id.ruleRe).text = "/${rule.re}/"
            v.findViewById<TextView>(R.id.ruleTo).text = "→ " + rule.to.ifBlank { getString(R.string.rp_delete_match) }
            v.findViewById<TextView>(R.id.ruleCi).visibility = if (rule.ci) View.VISIBLE else View.GONE
            v.findViewById<View>(R.id.btnDeleteRule).setOnClickListener {
                rules.removeAt(idx); render()
            }
            v.setOnClickListener { editRule(rules, idx, label) }
            container.addView(v)
        }
    }

    private fun editRule(rules: MutableList<ReplaceRule>, idx: Int, label: String) {
        val db = DialogReplaceRuleBinding.inflate(layoutInflater)
        val existing = if (idx >= 0) rules[idx] else null
        existing?.let {
            db.editRe.setText(it.re)
            db.editTo.setText(it.to)
            db.switchCi.isChecked = it.ci
        }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(if (existing == null) getString(R.string.rp_add_rule, label) else getString(R.string.rp_edit_rule, label))
            .setView(db.root)
            .setPositiveButton(R.string.ok) { _, _ ->
                val re = db.editRe.text?.toString().orEmpty()
                val to = db.editTo.text?.toString().orEmpty()
                if (re.isBlank()) { snack(getString(R.string.rp_need_regex)); return@setPositiveButton }
                try { Regex(re) } catch (e: Exception) { snack(getString(R.string.rp_bad_regex, e.message ?: "")); return@setPositiveButton }
                val rule = ReplaceRule(re, to, db.switchCi.isChecked)
                if (idx >= 0) rules[idx] = rule else rules.add(rule)
                render()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun save() {
        val backend = backendOrNull() ?: return
        fun toArr(list: List<ReplaceRule>): JsonArray {
            val arr = JsonArray()
            list.forEach { r ->
                arr.add(JsonObject().apply {
                    addProperty("re", r.re)
                    addProperty("to", r.to)
                    addProperty("ci", r.ci)
                })
            }
            return arr
        }
        val patch = JsonObject().apply {
            add("replace", JsonObject().apply {
                add("out", toArr(outRules))
                add("inc", toArr(incRules))
            })
        }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.saveConfig(app.connectionStore.activeInstance, patch)
        }) { r ->
            if (r.ok) toast(getString(R.string.rp_saved))
            else snack(getString(R.string.pv_save_failed, r.error ?: ""))
        }
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
