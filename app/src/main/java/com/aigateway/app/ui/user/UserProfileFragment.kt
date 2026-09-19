package com.aigateway.app.ui.user

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.aigateway.app.BuildConfig
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentUserProfileBinding
import com.aigateway.app.ui.BaseFragment


class UserProfileFragment : BaseFragment() {

    private var _b: FragmentUserProfileBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentUserProfileBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val us = app.userStore
        b.upName.text = us.userName.ifBlank { us.uid.ifBlank { getString(R.string.up_token_user) } }
        b.upServer.text = us.serverUrl
        b.upBranch.text = getString(R.string.up_branch_fmt, us.branch.ifBlank { "default" })
        b.upVersion.text = "ai-gateway ${BuildConfig.VERSION_NAME} · " + getString(R.string.disclaimer_short)
        b.upMyKeys.setOnClickListener { (activity as? com.aigateway.app.MainActivity)?.openSecondaryPublic("ukeys") }
        b.upEditProfile.setOnClickListener { editProfile() }
        b.upSwitchAccount.setOnClickListener { (activity as? com.aigateway.app.MainActivity)?.showUserLogin() }
        b.upSwitchMode.setOnClickListener { (activity as? com.aigateway.app.MainActivity)?.switchToAdminMode() }
    }

    private fun editProfile() {
        val layout = android.widget.LinearLayout(requireContext()).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            val pad = (20 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
        }
        val nickLayout = com.google.android.material.textfield.TextInputLayout(requireContext()).apply { hint = getString(R.string.up_nickname) }
        val nickEdit = com.google.android.material.textfield.TextInputEditText(requireContext()).apply { setText(app.userStore.userName) }
        nickLayout.addView(nickEdit)
        val avatarLayout = com.google.android.material.textfield.TextInputLayout(requireContext()).apply { hint = getString(R.string.up_avatar) }
        val avatarEdit = com.google.android.material.textfield.TextInputEditText(requireContext())
        avatarLayout.addView(avatarEdit)
        layout.addView(nickLayout); layout.addView(avatarLayout)
        com.google.android.material.dialog.MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.up_edit_profile)
            .setView(layout)
            .setPositiveButton(R.string.save) { _, _ ->
                val ub = app.userBackend()
                run({ snack(getString(R.string.pv_save_failed, it)) }, {
                    ub.updateProfile(nickEdit.text?.toString()?.trim().orEmpty(), avatarEdit.text?.toString()?.trim().orEmpty())
                }) {
                    app.userStore.userName = nickEdit.text?.toString()?.trim().orEmpty()
                    b.upName.text = app.userStore.userName.ifBlank { app.userStore.uid }
                    snack(getString(R.string.pt_saved))
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }
}
