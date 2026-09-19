package com.aigateway.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity
import androidx.viewpager2.adapter.FragmentStateAdapter
import androidx.viewpager2.widget.ViewPager2
import com.aigateway.app.data.AppLanguage
import com.aigateway.app.data.ConnectionProfile
import com.aigateway.app.data.Palette
import com.aigateway.app.data.RunMode
import com.aigateway.app.data.ThemeMode
import com.aigateway.app.databinding.ActivityMainBinding
import com.aigateway.app.databinding.DialogConnectionBinding
import com.aigateway.app.databinding.DialogThemeBinding
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.aigateway.app.setup.SetupFragment
import com.aigateway.app.termux.TermuxHelper
import com.aigateway.app.ui.*
import com.aigateway.app.ui.user.*
import com.google.android.material.dialog.MaterialAlertDialogBuilder

class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private val app get() = application as App

    
    private val adminPagerTags = listOf("overview", "providers", "ports", "chat", "settings")

    
    private val userPagerTags = listOf("uhome", "umodels", "ucredits", "uprofile")

    private val pagerTags: List<String> get() = if (app.isUserMode) userPagerTags else adminPagerTags
    private var secondaryTag: String? = null

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
                com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
                    .setTitle("上次崩溃日志(请截图发给开发者)")
                    .setMessage(txt.take(3000))
                    .setPositiveButton("知道了", null)
                    .show()
            }
        } catch (_: Exception) {}

        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        if (app.isUserMode) { if (app.userStore.loggedIn) showMain() else showSetup() }
        else if (app.connectionStore.setupDone && app.connectionStore.runMode != null) showMain()
        else showSetup()
    }

    

    private fun showSetup() {
        b.setupContainer.visibility = View.VISIBLE
        b.mainContainer.visibility = View.GONE
        supportFragmentManager.beginTransaction()
            .replace(R.id.setupContainer, SetupFragment())
            .commit()
    }

    fun onSetupDone() = showMain()

    
    fun showUserLogin() {
        val db = com.aigateway.app.databinding.DialogUserLoginBinding.inflate(layoutInflater)
        val us = app.userStore
        db.editUlServer.setText(us.serverUrl)
        db.editUlBranch.setText(us.branch)
        db.editUlToken.setText(us.token)
        db.ulAuthToggle.check(R.id.ulAuthToken)
        db.ulAuthToggle.addOnButtonCheckedListener { _, id, checked ->
            if (!checked) return@addOnButtonCheckedListener
            db.ulTokenLayout.visibility = if (id == R.id.ulAuthToken) android.view.View.VISIBLE else android.view.View.GONE
            db.ulAccountLayout.visibility = if (id == R.id.ulAuthAccount) android.view.View.VISIBLE else android.view.View.GONE
            db.ulRegisterLayout.visibility = if (id == R.id.ulAuthRegister) android.view.View.VISIBLE else android.view.View.GONE
            if (id == R.id.ulAuthRegister) loadRegisterInfo(db)
        }
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(R.string.ul_title)
            .setView(db.root)
            .setPositiveButton(R.string.ul_login) { _, _ ->
                val server = db.editUlServer.text?.toString()?.trim().orEmpty()
                if (server.isBlank()) { Toast.makeText(this, R.string.ul_need_server, Toast.LENGTH_SHORT).show(); return@setPositiveButton }
                us.serverUrl = server
                us.branch = db.editUlBranch.text?.toString()?.trim().orEmpty()
                when (db.ulAuthToggle.checkedButtonId) {
                    R.id.ulAuthToken -> {
                        us.token = db.editUlToken.text?.toString()?.trim().orEmpty()
                        if (us.token.isBlank()) { Toast.makeText(this, R.string.ul_need_token, Toast.LENGTH_SHORT).show(); return@setPositiveButton }
                        verifyUserLogin(null, null)
                    }
                    R.id.ulAuthAccount -> {
                        verifyUserLogin(db.editUlUid.text?.toString()?.trim().orEmpty(), db.editUlPassword.text?.toString().orEmpty())
                    }
                    R.id.ulAuthRegister -> {
                        doRegister(db)
                    }
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    
    private fun loadRegisterInfo(db: com.aigateway.app.databinding.DialogUserLoginBinding) {
        val us = app.userStore
        if (us.serverUrl.isBlank()) return
        lifecycleScope.launch {
            try {
                val j = withContext(Dispatchers.IO) { app.userBackend().registerInfo() }
                if (j.get("enable")?.asBoolean != true) {
                    db.ulRegHint.text = getString(R.string.ul_reg_closed)
                    db.ulRegisterLayout.alpha = 0.4f
                } else {
                    db.ulRegHint.text = getString(R.string.ul_reg_hint_fmt, j.get("minPasswordLen")?.asInt ?: 8)
                    db.ulRegEmailLayout.visibility = if (j.get("emailRequired")?.asBoolean == true) android.view.View.VISIBLE else android.view.View.GONE
                }
            } catch (e: Exception) {
                db.ulRegHint.text = getString(R.string.ul_reg_query_fail, e.message ?: "")
            }
        }
    }

    
    private fun doRegister(db: com.aigateway.app.databinding.DialogUserLoginBinding) {
        val us = app.userStore
        val uid = db.editUlRegUid.text?.toString()?.trim().orEmpty()
        val pw = db.editUlRegPassword.text?.toString().orEmpty()
        val pw2 = db.editUlRegPassword2.text?.toString().orEmpty()
        val email = db.editUlRegEmail.text?.toString()?.trim().orEmpty()
        if (uid.isBlank() || pw.isBlank()) { Toast.makeText(this, R.string.ul_reg_fill_all, Toast.LENGTH_SHORT).show(); return }
        if (pw != pw2) { Toast.makeText(this, R.string.ul_reg_pw_mismatch, Toast.LENGTH_SHORT).show(); return }
        lifecycleScope.launch {
            try {
                val j = withContext(Dispatchers.IO) { app.userBackend().register(uid, pw, email) }
                val key = j.get("key")?.asString ?: ""
                us.token = key; us.uid = uid; us.userName = uid
                Toast.makeText(this@MainActivity, R.string.ul_reg_ok, Toast.LENGTH_LONG).show()
                app.settings.appMode = "user"
                pagerReady = false
                showMain()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, getString(R.string.ul_reg_fail, e.message ?: ""), Toast.LENGTH_LONG).show()
            }
        }
    }

    
    private fun verifyUserLogin(uid: String?, password: String?) {
        val us = app.userStore
        lifecycleScope.launch {
            try {
                val ub = app.userBackend()
                if (uid != null) {
                    
                    val j = withContext(Dispatchers.IO) { ub.login(uid, password ?: "") }
                    val keys = j.getAsJsonArray("keys")
                    if (keys == null || keys.size() == 0) {
                        Toast.makeText(this@MainActivity, R.string.ul_no_keys, Toast.LENGTH_LONG).show(); return@launch
                    }
                    us.token = keys[0].asJsonObject.get("key").asString
                    us.uid = j.get("uid")?.asString ?: ""
                    us.userName = j.get("name")?.asString ?: ""
                } else {
                    val j = withContext(Dispatchers.IO) { ub.credits() }
                    us.userName = j.get("name")?.asString ?: ""
                }
                Toast.makeText(this@MainActivity, R.string.ul_login_ok, Toast.LENGTH_SHORT).show()
                app.settings.appMode = "user"
                pagerReady = false
                showMain()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, getString(R.string.ul_login_fail, e.message ?: ""), Toast.LENGTH_LONG).show()
            }
        }
    }

    
    fun switchToAdminMode() {
        app.settings.appMode = ""
        pagerReady = false
        if (app.connectionStore.setupDone && app.connectionStore.runMode != null) showMain() else showSetup()
    }

    

    private var pagerReady = false

    private fun showMain() {
        b.setupContainer.visibility = View.GONE
        b.mainContainer.visibility = View.VISIBLE
        if (!pagerReady) { setupPager(); setupNav(); setupBackHandler(); pagerReady = true }
        updateSubtitle()
    }

    private inner class MainPagerAdapter(fa: FragmentActivity) : FragmentStateAdapter(fa) {
        override fun getItemCount() = pagerTags.size
        override fun createFragment(position: Int): Fragment = fragmentFor(pagerTags[position])
    }

    private fun setupPager() {
        b.viewPager.adapter = MainPagerAdapter(this)
        b.viewPager.offscreenPageLimit = 1
        b.viewPager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) {
                val tag = pagerTags[position]
                b.toolbar.title = titleFor(tag)
                b.bottomNav.menu.findItem(navIdFor(tag))?.isChecked = true
                updateSubtitle()
            }
        })
    }

    private fun setupNav() {
        
        if (app.isUserMode) {
            b.bottomNav.menu.clear()
            b.bottomNav.inflateMenu(R.menu.bottom_nav_user)
        }
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
                R.id.nav_security -> openSecondary("security")
                R.id.nav_cards -> openSecondary("cards")
                R.id.nav_panel -> openSecondary("panel")
                R.id.nav_config -> openSecondary("config")
                R.id.nav_plugins -> openSecondary("plugins")
                R.id.action_theme -> showThemeDialog()
                R.id.action_termux_start -> startTermuxBackend()
                R.id.action_connection -> showConnectionDialog()
            }
            true
        }
    }

    private fun navIdFor(tag: String) = when (tag) {
        "uhome" -> R.id.nav_u_home
        "umodels" -> R.id.nav_u_models
        "ucredits" -> R.id.nav_u_credits
        "uprofile" -> R.id.nav_u_profile
        "providers" -> R.id.nav_providers
        "ports" -> R.id.nav_ports
        "chat" -> R.id.nav_chat
        "settings" -> R.id.nav_settings
        else -> R.id.nav_overview
    }

    private fun tagForNavId(id: Int) = when (id) {
        R.id.nav_u_home -> "uhome"
        R.id.nav_u_models -> "umodels"
        R.id.nav_u_credits -> "ucredits"
        R.id.nav_u_profile -> "uprofile"
        R.id.nav_overview -> "overview"
        R.id.nav_providers -> "providers"
        R.id.nav_ports -> "ports"
        R.id.nav_chat -> "chat"
        R.id.nav_settings -> "settings"
        else -> null
    }

    
    
    fun openSecondaryPublic(tag: String) = openSecondary(tag)
    fun showConnectionDialogPublic() = showConnectionDialog()

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
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })
    }

    private fun fragmentFor(tag: String): Fragment = when (tag) {
        "uhome" -> UserHomeFragment()
        "umodels" -> UserModelsFragment()
        "ucredits" -> UserCreditsFragment()
        "uprofile" -> UserProfileFragment()
        "ukeys" -> UserKeysFragment()
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
        "panel" -> PanelFragment()
        "settings" -> SettingsHubFragment()
        "secondauth" -> SecondAuthFragment()
        "tunnel" -> TunnelFragment()
        "reg" -> RegSettingsFragment()
        "users" -> UsersFragment()
        "proxies" -> ProxiesFragment()
        "security" -> SecurityFragment()
        "plugins" -> PluginsMgmtFragment()
        else -> OverviewFragment()
    }

    private fun titleFor(tag: String): String = getString(when (tag) {
        "uhome" -> R.string.nav_u_home
        "umodels" -> R.string.nav_u_models
        "ucredits" -> R.string.nav_u_credits
        "uprofile" -> R.string.nav_u_profile
        "ukeys" -> R.string.up_my_keys
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
        "panel" -> R.string.title_panel
        "settings" -> R.string.nav_settings
        "secondauth" -> R.string.st_secondauth
        "tunnel" -> R.string.st_tunnel
        "reg" -> R.string.st_reg
        "users" -> R.string.us_title
        "proxies" -> R.string.title_proxies
        "security" -> R.string.title_security
        "plugins" -> R.string.title_plugins
        else -> R.string.title_overview
    })

    
    fun showFragment(tag: String) {
        val idx = pagerTags.indexOf(tag)
        if (idx >= 0) { closeSecondary(); b.viewPager.setCurrentItem(idx, true) }
        else openSecondary(tag)
    }

    fun updateSubtitle() {
        val inst = app.connectionStore.activeInstance
        b.toolbar.subtitle = when (app.connectionStore.runMode) {
            RunMode.EMBEDDED -> getString(R.string.setup_embedded) + " · " + inst
            RunMode.TERMUX -> (app.connectionStore.getCurrentProfile()?.baseUrl
                ?: getString(R.string.ov_mode_unset)) + " · " + inst
            RunMode.USER, null -> if (app.isUserMode) app.userStore.serverUrl else ""
        }
    }

    

    fun startTermuxBackendPublic() = startTermuxBackend()

    private fun startTermuxBackend() {
        when (val r = TermuxHelper.startBackendDetailed(this)) {
            is TermuxHelper.RunResult.Success -> toast(getString(R.string.termux_cmd_sent))
            is TermuxHelper.RunResult.NotInstalled -> toast(getString(R.string.termux_not_installed))
            is TermuxHelper.RunResult.Failed -> showTermuxPermDialog()
        }
    }

    
    private fun showTermuxPermDialog() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.termux_perm_title)
            .setMessage(R.string.termux_perm_hint)
            .setPositiveButton(R.string.termux_copy_cmd) { _, _ ->
                val cmd = "mkdir -p ~/.termux && echo 'allow-external-apps=true' >> ~/.termux/termux.properties"
                (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                    .setPrimaryClip(ClipData.newPlainText("termux-cmd", cmd))
                toast(getString(R.string.termux_cmd_copied))
            }
            .setNeutralButton(R.string.termux_open_anyway) { _, _ -> TermuxHelper.openTermux(this) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    

    fun showThemeDialogPublic() = showThemeDialog()

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
                    else -> AppLanguage.SYSTEM
                }
                val needRecreate = s.palette != newPalette || s.dynamicColors != db.switchDynamic.isChecked
                val langChanged = s.language != newLang

                s.themeMode = newMode
                s.dynamicColors = db.switchDynamic.isChecked
                s.palette = newPalette
                s.language = newLang

                s.applyThemeMode()
                if (langChanged) s.applyLanguage()
                else if (needRecreate) recreate()
                toast(getString(R.string.theme_applied))
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    

    fun showConnectionDialog() {
        val db = DialogConnectionBinding.inflate(layoutInflater)
        val curMode = app.connectionStore.runMode
        if (curMode == RunMode.EMBEDDED) db.rbEmbedded.isChecked = true else db.rbTermux.isChecked = true
        db.termuxSection.visibility = if (curMode == RunMode.TERMUX) View.VISIBLE else View.GONE
        app.connectionStore.getCurrentProfile()?.let {
            db.editUrl.setText(it.baseUrl)
            db.editKey.setText(it.adminKey)
        }
        if (db.editUrl.text.isNullOrBlank()) db.editUrl.setText("http://127.0.0.1:16384")

        db.modeGroup.setOnCheckedChangeListener { _, checkedId ->
            db.termuxSection.visibility = if (checkedId == R.id.rbTermux) View.VISIBLE else View.GONE
        }

        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.menu_connection)
            .setView(db.root)
            .setPositiveButton(R.string.save) { _, _ ->
                if (db.rbEmbedded.isChecked) {
                    app.setMode(RunMode.EMBEDDED)
                    app.connectionStore.activeInstance = "default"
                    toast(getString(R.string.connect_switched_embedded))
                } else {
                    val url = db.editUrl.text?.toString()?.trim().orEmpty()
                    val key = db.editKey.text?.toString()?.trim().orEmpty()
                    if (url.isBlank()) { toast(getString(R.string.connect_need_url)); return@setPositiveButton }
                    app.setMode(RunMode.TERMUX)
                    val existing = app.connectionStore.getCurrentProfile()
                    val profile = if (existing != null) existing.also { it.baseUrl = url; it.adminKey = key }
                    else ConnectionProfile(baseUrl = url, adminKey = key)
                    app.updateRemoteProfile(profile)
                    toast(getString(R.string.connect_saved))
                }
                updateSubtitle()
                
                b.viewPager.adapter = MainPagerAdapter(this)
            }
            .setNegativeButton(R.string.cancel, null)
            .setNeutralButton(R.string.connect_reselect_mode) { _, _ ->
                app.connectionStore.setupDone = false
                pagerReady = false
                showSetup()
            }
            .show()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
