package com.aigateway.app.ui.user

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentUserCreditsBinding
import com.aigateway.app.ui.BaseFragment


class UserCreditsFragment : BaseFragment() {

    private var _b: FragmentUserCreditsBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentUserCreditsBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.ucRefresh.setOnClickListener { load() }
        load()
    }

    override fun reload() { if (_b != null) load() }

    private fun fmtTok(n: Long): String = when {
        n >= 100_000_000 -> getString(R.string.fmt_yi, n / 100_000_000.0)
        n >= 10_000 -> getString(R.string.fmt_wan, n / 10_000.0)
        else -> n.toString()
    }

    private fun load() {
        val ub = app.userBackend()
        run({
            b.ucRemaining.text = "--"
            b.ucDetail.text = getString(R.string.load_failed, it)
        }, { ub.credits() }) { j ->
            if (j.get("admin")?.asBoolean == true) {
                b.ucName.text = getString(R.string.uc_admin)
                b.ucRemaining.text = "∞"
                b.ucDetail.text = getString(R.string.uc_unlimited)
                b.ucProgress.visibility = View.GONE
            } else {
                val name = j.get("name")?.asString ?: ""
                val quota = j.get("quotaTokens")?.asLong ?: 0
                val used = j.get("usedTokens")?.asLong ?: 0
                val remaining = if (j.get("remainingTokens")?.isJsonNull == false) j.get("remainingTokens").asLong else null
                b.ucName.text = name.ifBlank { getString(R.string.cd_unnamed) }
                if (remaining != null) {
                    b.ucRemaining.text = fmtTok(remaining)
                    val pct = if (quota > 0) (used * 100 / quota).toInt().coerceIn(0, 100) else 0
                    b.ucProgress.visibility = View.VISIBLE
                    b.ucProgress.progress = pct
                    b.ucDetail.text = getString(R.string.cd_usage_fmt, fmtTok(used), fmtTok(quota), pct)
                } else {
                    b.ucRemaining.text = "∞"
                    b.ucProgress.visibility = View.GONE
                    b.ucDetail.text = getString(R.string.cd_usage_unlimited, fmtTok(used))
                }
                val exp = j.get("expiresAt")?.asString.orEmpty()
                b.ucExpires.text = if (exp.isBlank()) getString(R.string.uc_no_expire)
                else getString(R.string.cd_limit_expires, exp.take(10))
                val models = j.getAsJsonArray("models")
                b.ucModels.text = if (models == null || models.size() == 0) getString(R.string.uc_all_models)
                else getString(R.string.uc_models_limited, models.joinToString(", ") { it.asString })
            }
            b.ucKey.text = app.userStore.token
        }
    }
}
