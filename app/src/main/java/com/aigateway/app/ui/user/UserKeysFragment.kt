package com.aigateway.app.ui.user

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentCardsBinding
import com.aigateway.app.ui.BaseFragment
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.gson.JsonObject


class UserKeysFragment : BaseFragment() {

    private var _b: FragmentCardsBinding? = null
    private val b get() = _b!!
    private var keys = listOf<JsonObject>()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentCardsBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.fabAddCard.setOnClickListener { createDialog() }
        load()
    }

    override fun reload() { if (_b != null) load() }

    private fun load() {
        val ub = app.userBackend()
        run({ snack(getString(R.string.load_failed, it)) }, { ub.myKeys() }) { j ->
            keys = j.getAsJsonArray("keys")?.map { it.asJsonObject } ?: emptyList()
            render()
        }
    }

    private fun fmtTok(n: Long): String = when {
        n >= 100_000_000 -> getString(R.string.fmt_yi, n / 100_000_000.0)
        n >= 10_000 -> getString(R.string.fmt_wan, n / 10_000.0)
        else -> n.toString()
    }

    private fun render() {
        b.listContainer.removeAllViews()
        b.emptyHint.visibility = if (keys.isEmpty()) View.VISIBLE else View.GONE
        keys.forEach { k -> b.listContainer.addView(makeCard(k)) }
    }

    private fun makeCard(k: JsonObject): View {
        val v = LayoutInflater.from(requireContext()).inflate(R.layout.item_card, b.listContainer, false)
        val isMain = k.get("isMain")?.asBoolean == true
        val key = k.get("key")?.asString ?: ""
        v.findViewById<TextView>(R.id.cdName).text = k.get("name")?.asString + (if (isMain) " · " + getString(R.string.uk_main) else "")
        val quota = k.get("quotaTokens")?.asLong ?: 0
        val used = k.get("usedTokens")?.asLong ?: 0
        val stateRes = if (k.get("enable")?.asBoolean != false) R.string.cd_state_active else R.string.cd_state_disabled
        v.findViewById<TextView>(R.id.cdState).setText(stateRes)
        v.findViewById<TextView>(R.id.cdKey).text = key
        val pct = if (quota > 0) (used * 100 / quota).toInt().coerceIn(0, 100) else 0
        v.findViewById<TextView>(R.id.cdUsage).text = if (quota > 0)
            getString(R.string.cd_usage_fmt, fmtTok(used), fmtTok(quota), pct)
        else getString(R.string.cd_usage_unlimited, fmtTok(used))
        val prog = v.findViewById<com.google.android.material.progressindicator.LinearProgressIndicator>(R.id.cdProgress)
        if (quota > 0) { prog.visibility = View.VISIBLE; prog.progress = pct } else prog.visibility = View.GONE

        v.findViewById<ImageButton>(R.id.cdCopy).setOnClickListener {
            val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("api_key", key))
            snack(getString(R.string.cd_copied))
        }
        
        v.findViewById<ImageButton>(R.id.cdDelete).apply {
            visibility = if (isMain) View.INVISIBLE else View.VISIBLE
            setOnClickListener { deleteKey(key, k.get("name")?.asString ?: "") }
        }
        v.findViewById<ImageButton>(R.id.cdToggle).visibility = View.GONE
        v.findViewById<ImageButton>(R.id.cdRecharge).visibility = View.GONE
        return v
    }

    private fun createDialog() {
        val db = com.aigateway.app.databinding.DialogCardBinding.inflate(layoutInflater)
        db.editCardUid.visibility = View.GONE
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.uk_new)
            .setView(db.root)
            .setPositiveButton(R.string.save) { _, _ ->
                val name = db.editCardName.text?.toString()?.trim().orEmpty()
                if (name.isBlank()) { snack(getString(R.string.cd_need_name)); return@setPositiveButton }
                val quotaWan = db.editCardQuota.text?.toString()?.toDoubleOrNull() ?: 0.0
                val models = db.editCardModels.text?.toString()?.split(",")?.map { it.trim() }?.filter { it.isNotBlank() } ?: emptyList()
                val ub = app.userBackend()
                run({ snack(getString(R.string.pv_save_failed, it)) }, {
                    ub.createMyKey(name, (quotaWan * 10000).toLong(), models, emptyList())
                }) { j ->
                    val nk = j.getAsJsonObject("key")
                    if (nk != null) {
                        val key = nk.get("key")?.asString ?: ""
                        MaterialAlertDialogBuilder(requireContext())
                            .setTitle(R.string.cd_created)
                            .setMessage(getString(R.string.cd_created_msg, key))
                            .setPositiveButton(R.string.cd_copy) { _, _ ->
                                val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                cm.setPrimaryClip(ClipData.newPlainText("api_key", key))
                            }
                            .setNegativeButton(R.string.cancel, null).show()
                        load()
                    }
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun deleteKey(key: String, name: String) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.cd_del_title)
            .setMessage(getString(R.string.cd_del_msg, name.ifBlank { key.take(12) }))
            .setPositiveButton(R.string.delete) { _, _ ->
                val ub = app.userBackend()
                run({ snack(getString(R.string.pv_save_failed, it)) }, { ub.deleteMyKey(key) }) {
                    snack(getString(R.string.cd_deleted)); load()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }
}
