package com.aigateway.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentUsersBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.gson.JsonObject


class UsersFragment : BaseFragment() {

    private var _b: FragmentUsersBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentUsersBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.fabAddUser.setOnClickListener { editDialog(null) }
        load()
    }

    override fun reload() { if (_b != null) load() }

    private fun load() {
        val backend = backendOrNull() ?: return
        run({ snack(getString(R.string.load_failed, it)) }, {
            backend.getUsers(app.connectionStore.activeInstance)
        }) { j ->
            val users = j.getAsJsonArray("users") ?: return@run
            b.listContainer.removeAllViews()
            b.emptyHint.visibility = if (users.size() == 0) View.VISIBLE else View.GONE
            for (el in users) {
                val u = el.asJsonObject
                b.listContainer.addView(makeRow(u))
            }
        }
    }

    private fun makeRow(u: JsonObject): View {
        val v = LayoutInflater.from(requireContext()).inflate(R.layout.item_user, b.listContainer, false)
        val uid = u.get("uid")?.asString ?: ""
        v.findViewById<TextView>(R.id.usName).text = u.get("name")?.asString?.ifBlank { uid } ?: uid
        v.findViewById<TextView>(R.id.usUid).text = uid
        v.findViewById<TextView>(R.id.usMeta).text = getString(R.string.us_keys_fmt, u.get("keyCount")?.asInt ?: 0)
        v.findViewById<ImageButton>(R.id.usEdit).setOnClickListener { editDialog(u) }
        v.findViewById<ImageButton>(R.id.usResetPw).setOnClickListener { resetPwDialog(uid) }
        v.findViewById<ImageButton>(R.id.usDelete).setOnClickListener { deleteUser(uid) }
        return v
    }

    private fun editDialog(existing: JsonObject?) {
        val db = com.aigateway.app.databinding.DialogUserEditBinding.inflate(layoutInflater)
        if (existing != null) {
            db.editUsUid.setText(existing.get("uid")?.asString)
            db.editUsUid.isEnabled = false
            db.editUsName.setText(existing.get("name")?.asString)
            db.editUsNote.setText(existing.get("note")?.asString)
            db.editUsPassword.hint = getString(R.string.us_reset_pw)
            db.usPasswordLayout.hint = getString(R.string.us_reset_pw)
        }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(if (existing == null) R.string.us_new else R.string.pv_edit_btn)
            .setView(db.root)
            .setPositiveButton(R.string.save) { _, _ ->
                val backend = backendOrNull() ?: return@setPositiveButton
                val body = JsonObject().apply {
                    addProperty("uid", db.editUsUid.text?.toString()?.trim().orEmpty())
                    addProperty("name", db.editUsName.text?.toString()?.trim().orEmpty())
                    addProperty("note", db.editUsNote.text?.toString()?.trim().orEmpty())
                    val pw = db.editUsPassword.text?.toString().orEmpty()
                    if (pw.isNotBlank()) addProperty("password", pw)
                }
                if (existing == null && !body.has("password")) { snack(getString(R.string.ul_reg_fill_all)); return@setPositiveButton }
                run({ snack(getString(R.string.pv_save_failed, it)) }, {
                    if (existing == null) backend.createUser(app.connectionStore.activeInstance, body)
                    else backend.updateUser(app.connectionStore.activeInstance, body)
                }) { snack(getString(R.string.pt_saved)); load() }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun resetPwDialog(uid: String) {
        val edit = com.google.android.material.textfield.TextInputEditText(requireContext())
        val tl = com.google.android.material.textfield.TextInputLayout(requireContext()).apply {
            hint = getString(R.string.us_reset_pw)
            val pad = (20 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
        }
        tl.addView(edit)
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(getString(R.string.us_reset_pw) + " · " + uid)
            .setView(tl)
            .setPositiveButton(R.string.save) { _, _ ->
                val pw = edit.text?.toString().orEmpty()
                if (pw.isBlank()) return@setPositiveButton
                val backend = backendOrNull() ?: return@setPositiveButton
                val body = JsonObject().apply { addProperty("uid", uid); addProperty("password", pw) }
                run({ snack(getString(R.string.pv_save_failed, it)) }, {
                    backend.updateUser(app.connectionStore.activeInstance, body)
                }) { snack(getString(R.string.pt_saved)) }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun deleteUser(uid: String) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.cd_del_title)
            .setMessage(getString(R.string.cd_del_msg, uid))
            .setPositiveButton(R.string.delete) { _, _ ->
                val backend = backendOrNull() ?: return@setPositiveButton
                run({ snack(getString(R.string.pv_save_failed, it)) }, {
                    backend.deleteUser(app.connectionStore.activeInstance, uid)
                }) { snack(getString(R.string.cd_deleted)); load() }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }
}
