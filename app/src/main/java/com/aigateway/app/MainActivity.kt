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
import com.aigateway.app.setup.SetupFragment
import com.aigateway.app.termux.TermuxHelper
import com.aigateway.app.ui.*
import com.google.android.material.dialog.MaterialAlertDialogBuilder

class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private val app get() = application as App

    /** 主导航页(可滑动切换), 与底栏一一对应 */
    private val pagerTags = listOf("overview", "providers", "routing", "ports", "chat")
    private var secondaryTag: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        if (!app.settings.dynamicColors) {
            theme.applyStyle(app.settings.paletteOverlay(), true)
        }
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        if (app.connectionStore.setupDone && app.connectionStore.runMode != null) showMain()
        else showSetup()
    }

    // ---------- setup ----------

    private fun showSetup() {
        b.setupContainer.visibility = View.VISIBLE
        b.mainContainer.visibility = View.GONE
        supportFragmentManager.beginTransaction()
            .replace(R.id.setupContainer, SetupFragment())
            .commit()
    }

    fun onSetupDone() = showMain()

    // ---------- main ----------

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
        b.bottomNav.setOnItemSelectedListener { item ->
            val tag = tagForNavId(item.itemId)
            if (tag != null) {
                closeSecondary()
                val idx = pagerTags.indexOf(tag)
                if (idx >= 0) b.viewPager.setCurrentItem(idx, true)  // true = 平滑滚动动画
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
                R.id.nav_config -> openSecondary("config")
                R.id.action_theme -> showThemeDialog()
                R.id.action_termux_start -> startTermuxBackend()
                R.id.action_connection -> showConnectionDialog()
            }
            true
        }
    }

    private fun navIdFor(tag: String) = when (tag) {
        "providers" -> R.id.nav_providers
        "routing" -> R.id.nav_routing
        "ports" -> R.id.nav_ports
        "chat" -> R.id.nav_chat
        else -> R.id.nav_overview
    }

    private fun tagForNavId(id: Int) = when (id) {
        R.id.nav_overview -> "overview"
        R.id.nav_providers -> "providers"
        R.id.nav_routing -> "routing"
        R.id.nav_ports -> "ports"
        R.id.nav_chat -> "chat"
        else -> null
    }

    /** 打开二级页(顶栏菜单), 带淡入+上移动画 */
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

    /** 返回键: 二级页优先关闭 */
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
        "proxies" -> ProxiesFragment()
        "security" -> SecurityFragment()
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
        "proxies" -> R.string.title_proxies
        "security" -> R.string.title_security
        else -> R.string.title_overview
    })

    /** 供 Fragment 跳转(总览"查看全部") */
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
            null -> ""
        }
    }

    // ---------- Termux ----------

    fun startTermuxBackendPublic() = startTermuxBackend()

    private fun startTermuxBackend() {
        when (val r = TermuxHelper.startBackendDetailed(this)) {
            is TermuxHelper.RunResult.Success -> toast(getString(R.string.termux_cmd_sent))
            is TermuxHelper.RunResult.NotInstalled -> toast(getString(R.string.termux_not_installed))
            is TermuxHelper.RunResult.Failed -> showTermuxPermDialog()
        }
    }

    /** 未授权外部调用: 给出可复制的开启命令 */
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

    // ---------- 主题 / 语言 ----------

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

    // ---------- 连接设置 ----------

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
                // 刷新所有页(强制重建 pager)
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
