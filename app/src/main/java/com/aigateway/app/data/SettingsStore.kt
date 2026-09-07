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
    SYSTEM(""), ENGLISH("en"), CHINESE("zh-CN")
}

/**
 * 外观/语言设置存储 —— SharedPreferences 持久化 + 应用到 AppCompat。
 */
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
    }

    // ---- 代码拦截(CodeGuard) ----

    /** 是否启用代码安全扫描 */
    var guardEnabled: Boolean
        get() = sp.getBoolean(K_GUARD_ENABLE, false)
        set(v) = sp.edit().putBoolean(K_GUARD_ENABLE, v).apply()

    /** 最低报告等级: LOW / MEDIUM / HIGH */
    var guardLevel: String
        get() = sp.getString(K_GUARD_LEVEL, "MEDIUM") ?: "MEDIUM"
        set(v) = sp.edit().putString(K_GUARD_LEVEL, v).apply()

    /** 命中动作: WARN(仅标注) / BLOCK(拦截替换内容) */
    var guardAction: String
        get() = sp.getString(K_GUARD_ACTION, "WARN") ?: "WARN"
        set(v) = sp.edit().putString(K_GUARD_ACTION, v).apply()

    /** 启用云端扫描 API */
    var guardCloudEnabled: Boolean
        get() = sp.getBoolean(K_GUARD_CLOUD, false)
        set(v) = sp.edit().putBoolean(K_GUARD_CLOUD, v).apply()

    var guardCloudUrl: String
        get() = sp.getString(K_GUARD_CLOUD_URL, "") ?: ""
        set(v) = sp.edit().putString(K_GUARD_CLOUD_URL, v).apply()

    var guardCloudKey: String
        get() = sp.getString(K_GUARD_CLOUD_KEY, "") ?: ""
        set(v) = sp.edit().putString(K_GUARD_CLOUD_KEY, v).apply()

    /** Termux 类型: zero=ZeroTermux(旧协议), official=官方 Termux(新协议) */
    var termuxVariant: String
        get() = sp.getString(K_TERMUX_VARIANT, "zero") ?: "zero"
        set(v) = sp.edit().putString(K_TERMUX_VARIANT, v).apply()

    // ---- 后台保活 ----

    /** 启用前台服务保活(仅应用内运行模式有意义) */
    var bgKeepAlive: Boolean
        get() = sp.getBoolean(K_BG_KEEPALIVE, false)
        set(v) = sp.edit().putBoolean(K_BG_KEEPALIVE, v).apply()

    /** 内嵌配置是否加密存储 */
    var cryptEnabled: Boolean
        get() = sp.getBoolean(K_CRYPT_ENABLE, false)
        set(v) = sp.edit().putBoolean(K_CRYPT_ENABLE, v).apply()

    /** 配置加密口令(用于内嵌配置文件 + 导入导出默认口令) */
    var cryptPassword: String
        get() = sp.getString(K_CRYPT_PASS, "") ?: ""
        set(v) = sp.edit().putString(K_CRYPT_PASS, v).apply()

    var themeMode: ThemeMode
        get() = runCatching { ThemeMode.valueOf(sp.getString(K_MODE, ThemeMode.SYSTEM.name)!!) }
            .getOrDefault(ThemeMode.SYSTEM)
        set(v) = sp.edit().putString(K_MODE, v.name).apply()

    /** Material You 动态取色(Android 12+) */
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

    /** 应用深色模式(立即生效) */
    fun applyThemeMode() {
        AppCompatDelegate.setDefaultNightMode(
            when (themeMode) {
                ThemeMode.LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
                ThemeMode.DARK -> AppCompatDelegate.MODE_NIGHT_YES
                ThemeMode.SYSTEM -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            }
        )
    }

    /** 应用语言(per-app language, 立即生效) */
    fun applyLanguage() {
        val locales = if (language == AppLanguage.SYSTEM) LocaleListCompat.getEmptyLocaleList()
        else LocaleListCompat.forLanguageTags(language.tag)
        AppCompatDelegate.setApplicationLocales(locales)
    }

    /** 配色方案对应的 theme overlay 资源 id */
    fun paletteOverlay(): Int = when (palette) {
        Palette.PURPLE -> com.aigateway.app.R.style.ThemeOverlay_Palette_Purple
        Palette.BLUE -> com.aigateway.app.R.style.ThemeOverlay_Palette_Blue
        Palette.GREEN -> com.aigateway.app.R.style.ThemeOverlay_Palette_Green
        Palette.ORANGE -> com.aigateway.app.R.style.ThemeOverlay_Palette_Orange
        Palette.RED -> com.aigateway.app.R.style.ThemeOverlay_Palette_Red
    }
}
