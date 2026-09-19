package com.aigateway.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.aigateway.app.R
import com.aigateway.app.data.ApiKeyEntry
import com.aigateway.app.databinding.DialogCardBinding
import com.aigateway.app.databinding.FragmentCardsBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.gson.JsonObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale


class CardsFragment : BaseFragment() {

    private var _b: FragmentCardsBinding? = null
    private val b get() = _b!!
    private var keys = listOf<ApiKeyEntry>()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentCardsBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.fabAddCard.setOnClickListener { showCardDialog() }
        load()
    }

    override fun reload() {
        if (_b != null) load()
    }

    private fun showEmpty(on: Boolean) {
        b.emptyHint.visibility = if (on) View.VISIBLE else View.GONE
    }

    private fun load() {
        val backend = backendOrNull() ?: run { showEmpty(true); return }
        val inst = app.connectionStore.activeInstance
        run({ snack(getString(R.string.load_failed, it)); showEmpty(true) }, {
            backend.getKeys(inst)
        }) { resp ->
            keys = resp.keys
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
        if (keys.isEmpty()) { showEmpty(true); return }
        showEmpty(false)
        keys.forEach { k -> b.listContainer.addView(makeCard(k)) }
    }

    private fun stateOf(k: ApiKeyEntry): Pair<String, Int> {
        val ctx = requireContext()
        if (!k.enable) return getString(R.string.cd_state_disabled) to
                com.google.android.material.R.attr.colorError.let { attr ->
                    val ta = ctx.obtainStyledAttributes(intArrayOf(attr)); val c = ta.getColor(0, 0); ta.recycle(); c
                }
        if (k.expiresAt.isNotBlank()) {
            val t = parseDate(k.expiresAt)
            if (t != null && t < System.currentTimeMillis()) return getString(R.string.cd_state_expired) to colorAttr(com.google.android.material.R.attr.colorError)
        }
        if (k.quotaTokens > 0 && k.usedTokens >= k.quotaTokens)
            return getString(R.string.cd_state_usedup) to colorAttr(com.google.android.material.R.attr.colorError)
        return getString(R.string.cd_state_active) to colorAttr(androidx.appcompat.R.attr.colorPrimary)
    }

    private fun colorAttr(attr: Int): Int {
        val ta = requireContext().obtainStyledAttributes(intArrayOf(attr))
        val c = ta.getColor(0, 0); ta.recycle(); return c
    }

    private fun parseDate(s: String): Long? {
        for (fmt in arrayOf("yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd")) {
            try {
                val f = SimpleDateFormat(fmt, Locale.US)
                @Suppress("SimpleDateFormat") val d = f.parse(s.take(fmt.length.coerceAtMost(s.length)))
                if (d != null) return d.time
            } catch (_: Exception) {}
        }
        return null
    }

    private fun makeCard(k: ApiKeyEntry): View {
        val v = LayoutInflater.from(requireContext()).inflate(R.layout.item_card, b.listContainer, false)
        val (stateText, stateColor) = stateOf(k)
        v.findViewById<android.widget.TextView>(R.id.cdName).text = k.name.ifBlank { getString(R.string.cd_unnamed) }
        v.findViewById<android.widget.TextView>(R.id.cdState).apply { text = stateText; setTextColor(stateColor) }
        v.findViewById<android.widget.TextView>(R.id.cdKey).text = k.key
        val pct = if (k.quotaTokens > 0) (k.usedTokens * 100 / k.quotaTokens).toInt().coerceIn(0, 100) else 0
        val usageText = if (k.quotaTokens > 0)
            getString(R.string.cd_usage_fmt, fmtTok(k.usedTokens), fmtTok(k.quotaTokens), pct)
        else getString(R.string.cd_usage_unlimited, fmtTok(k.usedTokens))
        val limits = buildList {
            if (!k.models.isNullOrEmpty()) add(getString(R.string.cd_limit_models, k.models!!.size))
            if (k.expiresAt.isNotBlank()) add(getString(R.string.cd_limit_expires, k.expiresAt.take(10)))
            if (k.note.isNotBlank()) add(k.note)
        }
        v.findViewById<android.widget.TextView>(R.id.cdUsage).text =
            usageText + if (limits.isNotEmpty()) " · " + limits.joinToString(" · ") else ""
        val prog = v.findViewById<com.google.android.material.progressindicator.LinearProgressIndicator>(R.id.cdProgress)
        if (k.quotaTokens > 0) { prog.visibility = View.VISIBLE; prog.progress = pct } else prog.visibility = View.GONE

        v.findViewById<android.widget.ImageButton>(R.id.cdCopy).setOnClickListener {
            val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("api_key", k.key))
            snack(getString(R.string.cd_copied))
        }
        v.findViewById<android.widget.ImageButton>(R.id.cdToggle).apply {
            setImageResource(if (k.enable) R.drawable.ic_pause else R.drawable.ic_play)
            setOnClickListener { toggleKey(k) }
        }
        v.findViewById<android.widget.ImageButton>(R.id.cdRecharge).setOnClickListener { rechargeKey(k) }
        v.findViewById<android.widget.ImageButton>(R.id.cdDelete).setOnClickListener { deleteKey(k) }
        return v
    }

    
    private fun showCardDialog() {
        val db = DialogCardBinding.inflate(layoutInflater)
        db.editCardQuota.setText("100")
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(getString(R.string.cd_new_title, app.connectionStore.activeInstance))
            .setView(db.root)
            .setPositiveButton(R.string.save) { _, _ ->
                val name = db.editCardName.text?.toString()?.trim().orEmpty()
                if (name.isBlank()) { snack(getString(R.string.cd_need_name)); return@setPositiveButton }
                val quotaWan = db.editCardQuota.text?.toString()?.toDoubleOrNull() ?: 0.0
                val models = db.editCardModels.text?.toString()?.split(",")?.map { it.trim() }?.filter { it.isNotBlank() }
                val body = JsonObject().apply {
                    addProperty("name", name)
                    addProperty("quotaTokens", (quotaWan * 10000).toLong())
                    if (!models.isNullOrEmpty()) add("models", com.google.gson.JsonArray().apply { models.forEach { add(it) } })
                    addProperty("expiresAt", db.editCardExpires.text?.toString()?.trim().orEmpty())
                    addProperty("note", db.editCardNote.text?.toString()?.trim().orEmpty())
                    val uid = db.editCardUid.text?.toString()?.trim().orEmpty()
                    if (uid.isNotBlank()) addProperty("uid", uid)
                }
                val backend = backendOrNull() ?: return@setPositiveButton
                run({ snack(getString(R.string.pv_save_failed, it)) }, {
                    backend.createKey(app.connectionStore.activeInstance, body)
                }) { j ->
                    if (j.has("key")) {
                        val k = j.getAsJsonObject("key")
                        showNewKey(k.get("key")?.asString ?: "")
                        load()
                    } else snack(getString(R.string.pv_save_failed, j.get("error")?.asString ?: ""))
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showNewKey(key: String) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.cd_created)
            .setMessage(getString(R.string.cd_created_msg, key))
            .setPositiveButton(R.string.cd_copy) { _, _ ->
                val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("api_key", key))
                snack(getString(R.string.cd_copied))
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    
    private fun toggleKey(k: ApiKeyEntry) {
        val backend = backendOrNull() ?: return
        val body = JsonObject().apply { addProperty("key", k.key); addProperty("enable", !k.enable) }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.updateKey(app.connectionStore.activeInstance, body)
        }) { r -> if (r.ok) { snack(getString(if (k.enable) R.string.cd_disabled_ok else R.string.cd_enabled_ok)); load() } }
    }

    private fun deleteKey(k: ApiKeyEntry) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.cd_del_title)
            .setMessage(getString(R.string.cd_del_msg, k.name.ifBlank { k.key.take(12) }))
            .setPositiveButton(R.string.delete) { _, _ ->
                val backend = backendOrNull() ?: return@setPositiveButton
                run({ snack(getString(R.string.pv_save_failed, it)) }, {
                    backend.deleteKey(app.connectionStore.activeInstance, k.key)
                }) { r -> if (r.ok) { snack(getString(R.string.cd_deleted)); load() } }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun rechargeKey(k: ApiKeyEntry) {
        val ctx = requireContext()
        val layout = android.widget.LinearLayout(ctx).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            val pad = (24 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
        }
        val tl1 = com.google.android.material.textfield.TextInputLayout(ctx).apply {
            hint = getString(R.string.cd_add_quota)
        }
        val edit1 = com.google.android.material.textfield.TextInputEditText(ctx).apply {
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            setText("0")
        }
        tl1.addView(edit1)
        val check = com.google.android.material.checkbox.MaterialCheckBox(ctx).apply {
            text = getString(R.string.cd_reset_usage)
        }
        layout.addView(tl1)
        layout.addView(check)
        MaterialAlertDialogBuilder(ctx)
            .setTitle(getString(R.string.cd_recharge_title, k.name.ifBlank { k.key.take(12) }))
            .setView(layout)
            .setPositiveButton(R.string.save) { _, _ ->
                val body = JsonObject().apply { addProperty("key", k.key) }
                val addWan = edit1.text?.toString()?.toDoubleOrNull() ?: 0.0
                if (addWan > 0) body.addProperty("addQuota", (addWan * 10000).toLong())
                if (check.isChecked) body.addProperty("resetUsage", true)
                val backend = backendOrNull() ?: return@setPositiveButton
                run({ snack(getString(R.string.pv_save_failed, it)) }, {
                    backend.updateKey(app.connectionStore.activeInstance, body)
                }) { r -> if (r.ok) { snack(getString(R.string.pt_saved)); load() } }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }
}
