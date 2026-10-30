package com.aigateway.app.data

import android.content.Context
import android.content.SharedPreferences
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat

/** 深色模式 */
enum class ThemeMode { SYSTEM, LIGHT, DARK }

/** 配色方案 */
enum class Palette { PURPLE, BLUE, GREEN, ORANGE, RED }

/** 语言 */
enum class AppLanguage(val tag: String) {
    SYSTEM(""), ENGLISH("en"), CHINESE("zh-CN"), CHINESE_TW("zh-TW"),
    JAPANESE("ja"), KOREAN("ko"), RUSSIAN("ru"), SPANISH("es"),
    FRENCH("fr"), ESPERANTO("eo")
}

/** 外观/语言设置 —— 管理端不再需要内嵌网关、悬浮球等本地运行配置。 */
class SettingsStore(context: Context) {

    private val sp: SharedPreferences =
        context.getSharedPreferences("ai_gateway_settings", Context.MODE_PRIVATE)

    companion object {
        private const val K_MODE = "theme_mode"
        private const val K_DYNAMIC = "dynamic_colors"
        private const val K_PALETTE = "palette"
        private const val K_LANG = "language"
        private const val K_BALANCE_WARN = "balance_warn_below"
    }

    var themeMode: ThemeMode
        get() = runCatching { ThemeMode.valueOf(sp.getString(K_MODE, ThemeMode.SYSTEM.name)!!) }
            .getOrDefault(ThemeMode.SYSTEM)
        set(v) = sp.edit().putString(K_MODE, v.name).apply()

    /** Material You 动态取色（Android 12+）。 */
    var dynamicColors: Boolean
        get() = sp.getBoolean(K_DYNAMIC, true)
        set(v) = sp.edit().putBoolean(K_DYNAMIC, v).apply()

    var palette: Palette
        get() = runCatching { Palette.valueOf(sp.getString(K_PALETTE, Palette.PURPLE.name)!!) }
            .getOrDefault(Palette.PURPLE)
        set(v) = sp.edit().putString(K_PALETTE, v.name).apply()

    /** 余额低于该值时的 UI 告警阈值（仅本地显示）。 */
    var balanceWarnBelow: Double
        get() = sp.getFloat(K_BALANCE_WARN, 5f).toDouble()
        set(v) = sp.edit().putFloat(K_BALANCE_WARN, v.toFloat()).apply()

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
