package com.aigateway.app

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.fragment.app.FragmentActivity
import androidx.viewpager2.adapter.FragmentStateAdapter
import androidx.viewpager2.widget.ViewPager2
import com.aigateway.app.data.AppLanguage
import com.aigateway.app.data.ConnectionProfile
import com.aigateway.app.data.ConnectionStore
import com.aigateway.app.data.Palette
import com.aigateway.app.data.ThemeMode
import com.aigateway.app.databinding.ActivityMainBinding
import com.aigateway.app.databinding.DialogConnectionBinding
import com.aigateway.app.databinding.DialogThemeBinding
import com.aigateway.app.net.RemoteBackend
import com.aigateway.app.setup.SetupFragment
import com.aigateway.app.ui.*
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 管理端主界面：5 个 Tab + 二级管理页。 */
class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private val app get() = application as App

    private val pagerTags = listOf("overview", "providers", "ports", "chat", "settings")
    private var secondaryTag: String? = null
    private var pendingPage: String? = null
    private var pagerReady = false

    private val pageCallback = object : ViewPager2.OnPageChangeCallback() {
        override fun onPageSelected(position: Int) {
            val tag = pagerTags[position]
            b.toolbar.title = titleFor(tag)
            b.bottomNav.menu.findItem(navIdFor(tag))?.isChecked = true
            updateSubtitle()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        if (!app.settings.dynamicColors) {
            theme.applyStyle(app.settings.paletteOverlay(), true)
        }
        super.onCreate(savedInstanceState)

        try {
            val cf = java.io.File(filesDir, "crash.txt")
            if (cf.exists()) {
                val txt = cf.readText()
                cf.delete()
                MaterialAlertDialogBuilder(this)
                    .setTitle("Last crash (please send this to the developer)")
                    .setMessage(txt.take(3000))
                    .setPositiveButton("OK", null)
                    .show()
            }
        } catch (_: Exception) {}

        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        if (app.connectionStore.setupDone && app.connectionStore.getCurrentProfile() != null) showMain()
        else showSetup()

        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
        window.decorView.post { consumePendingPage() }
    }

    override fun onResume() {
        super.onResume()
        consumePendingPage()
    }

    private fun handleIntent(i: Intent?) {
        if (i == null) return
        val tag = i.getStringExtra("page")?.trim().orEmpty()
        if (tag.isNotEmpty()) pendingPage = tag
        i.removeExtra("page")
    }

    private fun consumePendingPage() {
        val t = pendingPage ?: return
        pendingPage = null
        if (pagerReady) openSecondaryPublic(t)
    }

    private fun showSetup() {
        b.setupContainer.visibility = View.VISIBLE
        b.mainContainer.visibility = View.GONE
        supportFragmentManager.beginTransaction()
            .replace(R.id.setupContainer, SetupFragment())
            .commit()
    }

    fun onSetupDone() = showMain()

    private fun showMain() {
        b.setupContainer.visibility = View.GONE
        b.mainContainer.visibility = View.VISIBLE
        if (!pagerReady) {
            setupPager()
            setupNav()
            setupBackHandler()
            pagerReady = true
        }
        updateSubtitle()
        consumePendingPage()
    }

    private inner class MainPagerAdapter(fa: FragmentActivity) : FragmentStateAdapter(fa) {
        override fun getItemCount() = pagerTags.size
        override fun createFragment(position: Int): Fragment = fragmentFor(pagerTags[position])
    }

    private fun setupPager() {
        b.viewPager.adapter = MainPagerAdapter(this@MainActivity)
        b.viewPager.offscreenPageLimit = 1
        b.viewPager.unregisterOnPageChangeCallback(pageCallback)
        b.viewPager.registerOnPageChangeCallback(pageCallback)
    }

    private fun setupNav() {
        b.bottomNav.setOnItemSelectedListener { item ->
            val tag = tagForNavId(item.itemId)
            if (tag != null) {
                closeSecondary()
                val idx = pagerTags.indexOf(tag)
                if (idx >= 0) b.viewPager.setCurrentItem(idx, true)
            }
            true
        }
        b.toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.nav_keys -> openSecondary("keys")
                R.id.nav_replace -> openSecondary("replace")
                R.id.nav_stats -> openSecondary("stats")
                R.id.nav_requests -> openSecondary("requests")
                R.id.nav_logs -> openSecondary("logs")
                R.id.nav_proxies -> openSecondary("proxies")
                R.id.nav_cards -> openSecondary("cards")
                R.id.nav_config -> openSecondary("config")
                R.id.nav_plugins -> openSecondary("plugins")
                R.id.action_theme -> showThemeDialog()
                R.id.action_connection -> showConnectionDialog()
            }
            true
        }
    }

    private fun navIdFor(tag: String) = when (tag) {
        "providers" -> R.id.nav_providers
        "ports" -> R.id.nav_ports
        "chat" -> R.id.nav_chat
        "settings" -> R.id.nav_settings
        else -> R.id.nav_overview
    }

    private fun tagForNavId(id: Int) = when (id) {
        R.id.nav_overview -> "overview"
        R.id.nav_providers -> "providers"
        R.id.nav_ports -> "ports"
        R.id.nav_chat -> "chat"
        R.id.nav_settings -> "settings"
        else -> null
    }

    fun openSecondaryPublic(tag: String) = openSecondary(tag)
    fun showConnectionDialogPublic() = showConnectionDialog()
    fun showThemeDialogPublic() = showThemeDialog()

    private fun openSecondary(tag: String) {
        secondaryTag = tag
        b.toolbar.title = titleFor(tag)
        b.viewPager.visibility = View.GONE
        b.secondaryContainer.visibility = View.VISIBLE
        supportFragmentManager.beginTransaction()
            .setCustomAnimations(R.anim.slide_in_up, R.anim.fade_out, R.anim.fade_in, R.anim.slide_out_down)
            .replace(R.id.secondaryContainer, fragmentFor(tag))
            .commit()
        updateSubtitle()
    }

    private fun closeSecondary() {
        if (secondaryTag == null) return
        secondaryTag = null
        b.secondaryContainer.visibility = View.GONE
        b.viewPager.visibility = View.VISIBLE
        supportFragmentManager.findFragmentById(R.id.secondaryContainer)?.let {
            supportFragmentManager.beginTransaction().remove(it).commit()
        }
    }

    private fun setupBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (secondaryTag != null) {
                    closeSecondary()
                    val tag = pagerTags.getOrNull(b.viewPager.currentItem) ?: "overview"
                    b.toolbar.title = titleFor(tag)
                    updateSubtitle()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })
    }

    private fun fragmentFor(tag: String): Fragment = when (tag) {
        "providers" -> ProvidersFragment()
        "routing" -> RoutingFragment()
        "keys" -> KeysFragment()
        "ports" -> PortsFragment()
        "replace" -> ReplaceFragment()
        "stats" -> StatsFragment()
        "requests" -> RequestsFragment()
        "logs" -> LogsFragment()
        "chat" -> ChatFragment()
        "config" -> ConfigFragment()
        "cards" -> CardsFragment()
        "settings" -> SettingsHubFragment()
        "secondauth" -> SecondAuthFragment()
        "tunnel" -> TunnelFragment()
        "reg" -> RegSettingsFragment()
        "users" -> UsersFragment()
        "proxies" -> ProxiesFragment()
        "plugins" -> PluginsMgmtFragment()
        else -> OverviewFragment()
    }

    private fun titleFor(tag: String): String = getString(when (tag) {
        "providers" -> R.string.title_providers
        "routing" -> R.string.title_routing
        "keys" -> R.string.title_keys
        "ports" -> R.string.title_ports
        "replace" -> R.string.title_replace
        "stats" -> R.string.title_stats
        "requests" -> R.string.title_requests
        "logs" -> R.string.title_logs
        "chat" -> R.string.title_chat
        "config" -> R.string.menu_config
        "cards" -> R.string.title_cards
        "settings" -> R.string.nav_settings
        "secondauth" -> R.string.st_secondauth
        "tunnel" -> R.string.st_tunnel
        "reg" -> R.string.st_reg
        "users" -> R.string.us_title
        "proxies" -> R.string.title_proxies
        "plugins" -> R.string.title_plugins
        else -> R.string.title_overview
    })

    fun showFragment(tag: String) {
        val idx = pagerTags.indexOf(tag)
        if (idx >= 0) {
            closeSecondary()
            b.viewPager.setCurrentItem(idx, true)
        } else {
            openSecondary(tag)
        }
    }

    fun updateSubtitle() {
        val profile = app.connectionStore.getCurrentProfile()
        b.toolbar.subtitle = (profile?.baseUrl ?: getString(R.string.ov_mode_unset)) +
            " · " + app.connectionStore.activeInstance
    }

    private fun showThemeDialog() {
        val db = DialogThemeBinding.inflate(layoutInflater)
        val s = app.settings

        when (s.themeMode) {
            ThemeMode.SYSTEM -> db.rbModeSystem.isChecked = true
            ThemeMode.LIGHT -> db.rbModeLight.isChecked = true
            ThemeMode.DARK -> db.rbModeDark.isChecked = true
        }
        db.switchDynamic.isChecked = s.dynamicColors
        val dynamicSupported = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S
        db.switchDynamic.isEnabled = dynamicSupported
        when (s.palette) {
            Palette.PURPLE -> db.rbPalettePurple.isChecked = true
            Palette.BLUE -> db.rbPaletteBlue.isChecked = true
            Palette.GREEN -> db.rbPaletteGreen.isChecked = true
            Palette.ORANGE -> db.rbPaletteOrange.isChecked = true
            Palette.RED -> db.rbPaletteRed.isChecked = true
        }
        when (s.language) {
            AppLanguage.SYSTEM -> db.rbLangSystem.isChecked = true
            AppLanguage.ENGLISH -> db.rbLangEn.isChecked = true
            AppLanguage.CHINESE -> db.rbLangZh.isChecked = true
            AppLanguage.CHINESE_TW -> db.rbLangZhTw.isChecked = true
            AppLanguage.JAPANESE -> db.rbLangJa.isChecked = true
            AppLanguage.KOREAN -> db.rbLangKo.isChecked = true
            AppLanguage.RUSSIAN -> db.rbLangRu.isChecked = true
            AppLanguage.SPANISH -> db.rbLangEs.isChecked = true
            AppLanguage.FRENCH -> db.rbLangFr.isChecked = true
            AppLanguage.ESPERANTO -> db.rbLangEo.isChecked = true
        }
        fun syncPaletteEnabled() {
            val on = db.switchDynamic.isChecked && dynamicSupported
            db.paletteGroup.isEnabled = !on
            for (i in 0 until db.paletteGroup.childCount) db.paletteGroup.getChildAt(i).isEnabled = !on
            db.textPaletteTitle.alpha = if (on) 0.4f else 1f
        }
        syncPaletteEnabled()
        db.switchDynamic.setOnCheckedChangeListener { _, _ -> syncPaletteEnabled() }

        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.theme_title)
            .setView(db.root)
            .setPositiveButton(R.string.save) { _, _ ->
                val newMode = when {
                    db.rbModeLight.isChecked -> ThemeMode.LIGHT
                    db.rbModeDark.isChecked -> ThemeMode.DARK
                    else -> ThemeMode.SYSTEM
                }
                val newPalette = when {
                    db.rbPaletteBlue.isChecked -> Palette.BLUE
                    db.rbPaletteGreen.isChecked -> Palette.GREEN
                    db.rbPaletteOrange.isChecked -> Palette.ORANGE
                    db.rbPaletteRed.isChecked -> Palette.RED
                    else -> Palette.PURPLE
                }
                val newLang = when {
                    db.rbLangEn.isChecked -> AppLanguage.ENGLISH
                    db.rbLangZh.isChecked -> AppLanguage.CHINESE
                    db.rbLangZhTw.isChecked -> AppLanguage.CHINESE_TW
                    db.rbLangJa.isChecked -> AppLanguage.JAPANESE
                    db.rbLangKo.isChecked -> AppLanguage.KOREAN
                    db.rbLangRu.isChecked -> AppLanguage.RUSSIAN
                    db.rbLangEs.isChecked -> AppLanguage.SPANISH
                    db.rbLangFr.isChecked -> AppLanguage.FRENCH
                    db.rbLangEo.isChecked -> AppLanguage.ESPERANTO
                    else -> AppLanguage.SYSTEM
                }
                val needRecreate = s.palette != newPalette || s.dynamicColors != db.switchDynamic.isChecked
                val langChanged = s.language != newLang

                s.themeMode = newMode
                s.dynamicColors = db.switchDynamic.isChecked
                s.palette = newPalette
                s.language = newLang

                s.applyThemeMode()
                if (langChanged) s.applyLanguage() else if (needRecreate) recreate()
                toast(getString(R.string.theme_applied))
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showConnectionDialog() {
        val db = DialogConnectionBinding.inflate(layoutInflater)
        val cur = app.connectionStore.getCurrentProfile()
        db.editUrl.setText(cur?.baseUrl ?: ConnectionStore.DEFAULT_URL)
        db.editKey.setText(cur?.webToken.orEmpty())
        db.editSecondKey.setText(cur?.secondKey.orEmpty())
        db.editTotpSecret.setText(cur?.totpSecret.orEmpty())
        db.cbAllowInsecure.isChecked = cur?.allowInsecureTls == true

        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.menu_connection)
            .setView(db.root)
            .setPositiveButton(R.string.save, null)
            .setNegativeButton(R.string.cancel, null)
            .create()
        dialog.show()

        fun setBusy(busy: Boolean) {
            db.btnTest.isEnabled = !busy
            db.btnRotate.isEnabled = !busy
        }

        fun formProfile(): ConnectionProfile? {
            val url = db.editUrl.text?.toString()?.trim().orEmpty()
            val token = db.editKey.text?.toString()?.trim().orEmpty()
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                toast(getString(R.string.admin_bad_url)); return null
            }
            if (token.isBlank()) {
                toast(getString(R.string.admin_token_required)); return null
            }
            return (cur?.copy() ?: ConnectionProfile()).apply {
                baseUrl = url.removeSuffix("/")
                webToken = token
                secondKey = db.editSecondKey.text?.toString()?.trim().orEmpty()
                totpSecret = db.editTotpSecret.text?.toString()?.trim().orEmpty()
                allowInsecureTls = db.cbAllowInsecure.isChecked
            }
        }

        fun backendFor(p: ConnectionProfile) = RemoteBackend(
            p.baseUrl, p.webToken, p.secondKey, p.totpSecret, p.allowInsecureTls
        )

        fun applyProfile(p: ConnectionProfile) {
            app.updateRemoteProfile(p)
            app.connectionStore.activeInstance = "default"
            app.connectionStore.setupDone = true
            updateSubtitle()
            b.viewPager.adapter = MainPagerAdapter(this@MainActivity)
        }

        dialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE).setOnClickListener {
            val p = formProfile() ?: return@setOnClickListener
            applyProfile(p)
            toast(getString(R.string.connect_saved))
            dialog.dismiss()
        }

        db.btnTest.setOnClickListener {
            val p = formProfile() ?: return@setOnClickListener
            setBusy(true)
            lifecycleScope.launch {
                val backend = backendFor(p)
                val ok = withContext(Dispatchers.IO) { backend.testConnection() }
                val err = backend.lastError
                backend.close()
                if (isFinishing || isDestroyed) return@launch
                setBusy(false)
                toast(
                    if (ok) getString(R.string.admin_test_ok)
                    else getString(R.string.admin_test_failed, err ?: "")
                )
            }
        }

        db.btnRotate.setOnClickListener {
            val p = formProfile() ?: return@setOnClickListener
            setBusy(true)
            lifecycleScope.launch {
                val backend = backendFor(p)
                val result = withContext(Dispatchers.IO) {
                    runCatching { backend.rotateWebToken() }
                }
                backend.close()
                if (isFinishing || isDestroyed) return@launch
                setBusy(false)
                result.onSuccess { token ->
                    p.webToken = token
                    db.editKey.setText(token)
                    applyProfile(p)
                    toast(getString(R.string.admin_rotate_ok))
                    dialog.dismiss()
                }.onFailure {
                    toast(getString(R.string.admin_rotate_failed, it.message ?: ""))
                }
            }
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    override fun onDestroy() {
        super.onDestroy()
        if (::b.isInitialized) b.viewPager.unregisterOnPageChangeCallback(pageCallback)
    }
}
