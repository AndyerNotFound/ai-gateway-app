package com.aigateway.app.data

import android.content.Context
import android.content.SharedPreferences
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat


enum class ThemeMode { SYSTEM, LIGHT, DARK }


enum class Palette { PURPLE, BLUE, GREEN, ORANGE, RED }


enum class AppLanguage(val tag: String) {
    SYSTEM(""), ENGLISH("en"), CHINESE("zh-CN")
}




class SettingsStore(context: Context) {

    private val sp: SharedPreferences =
        context.getSharedPreferences("ai_gateway_settings", Context.MODE_PRIVATE)

    companion object {
        private const val K_MODE = "theme_mode"
        private const val K_DYNAMIC = "dynamic_colors"
        private const val K_PALETTE = "palette"
        private const val K_LANG = "language"
        private const val K_CRYPT_ENABLE = "crypt_enable"
        private const val K_CRYPT_PASS = "crypt_pass"
        private const val K_GUARD_ENABLE = "guard_enable"
        private const val K_GUARD_LEVEL = "guard_level"
        private const val K_GUARD_ACTION = "guard_action"
        private const val K_GUARD_CLOUD = "guard_cloud"
        private const val K_GUARD_CLOUD_URL = "guard_cloud_url"
        private const val K_GUARD_CLOUD_KEY = "guard_cloud_key"
        private const val K_TERMUX_VARIANT = "termux_variant"
        private const val K_BG_KEEPALIVE = "bg_keepalive"
        private const val K_APP_MODE = "app_mode"
    }

    
    var appMode: String
        get() = sp.getString(K_APP_MODE, "") ?: ""
        set(v) = sp.edit().putString(K_APP_MODE, v).apply()

    

    
    var guardEnabled: Boolean
        get() = sp.getBoolean(K_GUARD_ENABLE, false)
        set(v) = sp.edit().putBoolean(K_GUARD_ENABLE, v).apply()

    
    var guardLevel: String
        get() = sp.getString(K_GUARD_LEVEL, "MEDIUM") ?: "MEDIUM"
        set(v) = sp.edit().putString(K_GUARD_LEVEL, v).apply()

    
    var guardAction: String
        get() = sp.getString(K_GUARD_ACTION, "WARN") ?: "WARN"
        set(v) = sp.edit().putString(K_GUARD_ACTION, v).apply()

    
    var guardCloudEnabled: Boolean
        get() = sp.getBoolean(K_GUARD_CLOUD, false)
        set(v) = sp.edit().putBoolean(K_GUARD_CLOUD, v).apply()

    var guardCloudUrl: String
        get() = sp.getString(K_GUARD_CLOUD_URL, "") ?: ""
        set(v) = sp.edit().putString(K_GUARD_CLOUD_URL, v).apply()

    var guardCloudKey: String
        get() = sp.getString(K_GUARD_CLOUD_KEY, "") ?: ""
        set(v) = sp.edit().putString(K_GUARD_CLOUD_KEY, v).apply()

    
    var termuxVariant: String
        get() = sp.getString(K_TERMUX_VARIANT, "zero") ?: "zero"
        set(v) = sp.edit().putString(K_TERMUX_VARIANT, v).apply()

    

    
    var bgKeepAlive: Boolean
        get() = sp.getBoolean(K_BG_KEEPALIVE, false)
        set(v) = sp.edit().putBoolean(K_BG_KEEPALIVE, v).apply()

    
    var cryptEnabled: Boolean
        get() = sp.getBoolean(K_CRYPT_ENABLE, false)
        set(v) = sp.edit().putBoolean(K_CRYPT_ENABLE, v).apply()

    
    var cryptPassword: String
        get() = sp.getString(K_CRYPT_PASS, "") ?: ""
        set(v) = sp.edit().putString(K_CRYPT_PASS, v).apply()

    var themeMode: ThemeMode
        get() = runCatching { ThemeMode.valueOf(sp.getString(K_MODE, ThemeMode.SYSTEM.name)!!) }
            .getOrDefault(ThemeMode.SYSTEM)
        set(v) = sp.edit().putString(K_MODE, v.name).apply()

    
    var dynamicColors: Boolean
        get() = sp.getBoolean(K_DYNAMIC, true)
        set(v) = sp.edit().putBoolean(K_DYNAMIC, v).apply()

    var palette: Palette
        get() = runCatching { Palette.valueOf(sp.getString(K_PALETTE, Palette.PURPLE.name)!!) }
            .getOrDefault(Palette.PURPLE)
        set(v) = sp.edit().putString(K_PALETTE, v.name).apply()

    var language: AppLanguage
        get() = runCatching { AppLanguage.valueOf(sp.getString(K_LANG, AppLanguage.SYSTEM.name)!!) }
            .getOrDefault(AppLanguage.SYSTEM)
        set(v) = sp.edit().putString(K_LANG, v.name).apply()

    
    fun applyThemeMode() {
        AppCompatDelegate.setDefaultNightMode(
            when (themeMode) {
                ThemeMode.LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
                ThemeMode.DARK -> AppCompatDelegate.MODE_NIGHT_YES
                ThemeMode.SYSTEM -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            }
        )
    }

    
    fun applyLanguage() {
        val locales = if (language == AppLanguage.SYSTEM) LocaleListCompat.getEmptyLocaleList()
        else LocaleListCompat.forLanguageTags(language.tag)
        AppCompatDelegate.setApplicationLocales(locales)
    }

    
    fun paletteOverlay(): Int = when (palette) {
        Palette.PURPLE -> com.aigateway.app.R.style.ThemeOverlay_Palette_Purple
        Palette.BLUE -> com.aigateway.app.R.style.ThemeOverlay_Palette_Blue
        Palette.GREEN -> com.aigateway.app.R.style.ThemeOverlay_Palette_Green
        Palette.ORANGE -> com.aigateway.app.R.style.ThemeOverlay_Palette_Orange
        Palette.RED -> com.aigateway.app.R.style.ThemeOverlay_Palette_Red
    }
}
