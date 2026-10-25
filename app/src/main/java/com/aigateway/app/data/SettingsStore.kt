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
        private const val K_OVERLAY = "overlay_enabled"
        private const val K_OVERLAY_X = "overlay_x"
        private const val K_OVERLAY_Y = "overlay_y"
        private const val K_OVERLAY_SIZE = "overlay_size_dp"
        private const val K_OVERLAY_GAUGE_C = "overlay_gauge_color"
        private const val K_OVERLAY_GAUGE_W = "overlay_gauge_w"
        private const val K_OVERLAY_PANEL_W = "overlay_panel_w"
        private const val K_OVERLAY_SCALE = "overlay_scale"
        private const val K_OVERLAY_BG = "overlay_bg"
        private const val K_OVERLAY_ROWS = "overlay_rows"
        private const val K_OVERLAY_SNAP = "overlay_snap"
        private const val K_OVERLAY_DIM = "overlay_dim"
        private const val K_OVERLAY_DIM_SEC = "overlay_dim_sec"
        private const val K_OVERLAY_DIM_ALPHA = "overlay_dim_alpha"
        private const val K_OVERLAY_LOCK = "overlay_lock"
        private const val K_OVERLAY_PIN = "overlay_pin_expanded"
        private const val K_OVERLAY_BLUR = "overlay_blur"
        private const val K_OVERLAY_PILL = "overlay_pill"
        private const val K_OVERLAY_CHIP = "overlay_chip"
        private const val K_OVERLAY_BALANCE = "overlay_balance_row"
        private const val K_OVERLAY_SHAPE = "overlay_shape"
        private const val K_OVERLAY_ICON = "overlay_icon_uri"
        private const val K_OVERLAY_ORDER = "overlay_rows_order"
        private const val K_OVERLAY_AUTOSCROLL = "overlay_autoscroll"
        private const val K_OVERLAY_SCROLL_SEC = "overlay_scroll_sec"
        private const val K_BALANCE_WARN = "balance_warn_below"
        private const val K_APP_MODE = "app_mode"
        private const val K_BALL_HASH = "ball_cfg_hash"
        private const val K_BALL_PHRASES = "ball_phrases"
        private const val K_SDUI_PAGES = "sdui_pages"
        private const val K_SDUI_ALL = "sdui_all"
    }

    /**
     * 把数值压回滑块所在的 step 网格。
     * Material Slider 遇到 value 不等于 valueFrom + n*stepSize 会在 layout 期直接抛
     * IllegalStateException（不是警告），写偏好的一方必须保证对齐：
     * 滑块的 step 是 2/4/5/0.05，而服务端下发、旧版本残留、换算结果都可能是任意值。
     */
    private fun snapI(v: Int, from: Int, step: Int): Int =
        if (step <= 1) v else from + Math.round((v - from).toFloat() / step) * step

    private fun snapF(v: Float, from: Float, step: Float): Float =
        if (step <= 0f) v else from + Math.round((v - from) / step) * step

    /** 应用模式: "admin"(管理端) / "user"(用户端) */
    var appMode: String
        get() = sp.getString(K_APP_MODE, "") ?: ""
        set(v) = sp.edit().putString(K_APP_MODE, v).apply()

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

    // ---- 悬浮窗 ----

    /** 悬浮窗开关(持久化, 重启应用后恢复) */
    var overlayEnabled: Boolean
        get() = sp.getBoolean(K_OVERLAY, false)
        set(v) = sp.edit().putBoolean(K_OVERLAY, v).apply()

    /** 悬浮窗 X(像素); -1 = 未设置, 首次按 dp 默认值摆放 */
    var overlayX: Int
        get() = sp.getInt(K_OVERLAY_X, -1)
        set(v) = sp.edit().putInt(K_OVERLAY_X, v).apply()

    /** 悬浮窗 Y(像素); -1 = 未设置 */
    var overlayY: Int
        get() = sp.getInt(K_OVERLAY_Y, -1)
        set(v) = sp.edit().putInt(K_OVERLAY_Y, v).apply()

    /** 气泡直径(dp) */
    var overlaySizeDp: Int
        get() = snapI(sp.getInt(K_OVERLAY_SIZE, 56), 40, 2)
        set(v) = sp.edit().putInt(K_OVERLAY_SIZE, snapI(v.coerceIn(40, 88), 40, 2)).apply()

    /** 指示环/条的颜色; 0 = 跟随主题(正常态), 预警/见顶仍用琥珀/红 */
    var overlayGaugeColor: Int
        get() = sp.getInt(K_OVERLAY_GAUGE_C, 0)
        set(v) = sp.edit().putInt(K_OVERLAY_GAUGE_C, v).apply()

    /** 指示环/条的粗细(%) 60..200, 100 = 默认 */
    var overlayGaugeWidth: Int
        get() = snapI(sp.getInt(K_OVERLAY_GAUGE_W, 100), 60, 5)
        set(v) = sp.edit().putInt(K_OVERLAY_GAUGE_W, snapI(v.coerceIn(60, 200), 60, 5)).apply()

    /** 面板宽度(dp) */
    var overlayPanelDp: Int
        get() = snapI(sp.getInt(K_OVERLAY_PANEL_W, 272), 240, 4)
        set(v) = sp.edit().putInt(K_OVERLAY_PANEL_W, snapI(v.coerceIn(240, 340), 240, 4)).apply()

    /** 整体缩放(字号/内边距/固定尺寸一起缩放) */
    var overlayScale: Float
        get() = snapF(sp.getFloat(K_OVERLAY_SCALE, 1f), 0.8f, 0.05f)
        set(v) = sp.edit().putFloat(K_OVERLAY_SCALE, snapF(v.coerceIn(0.8f, 1.3f), 0.8f, 0.05f)).apply()

    /** 卡片底色；0 = 跟随主题 */
    var overlayBg: Int
        get() = sp.getInt(K_OVERLAY_BG, 0)
        set(v) = sp.edit().putInt(K_OVERLAY_BG, v).apply()

    /** 面板信息行位掩码: 1 模式 / 2 实例 / 4 端口 / 8 请求 / 16 错误 / 32 运行时长 */
    var overlayRows: Int
        get() = sp.getInt(K_OVERLAY_ROWS, 0x3F)
        set(v) = sp.edit().putInt(K_OVERLAY_ROWS, v and 0x3F).apply()

    /** 贴边半隐藏(只露 40%) */
    var overlaySnap: Boolean
        get() = sp.getBoolean(K_OVERLAY_SNAP, true)
        set(v) = sp.edit().putBoolean(K_OVERLAY_SNAP, v).apply()

    /** 静止一段时间后变淡 */
    var overlayDim: Boolean
        get() = sp.getBoolean(K_OVERLAY_DIM, true)
        set(v) = sp.edit().putBoolean(K_OVERLAY_DIM, v).apply()

    /** 静止多少秒后变淡 */
    var overlayDimSec: Int
        get() = sp.getInt(K_OVERLAY_DIM_SEC, 3)
        set(v) = sp.edit().putInt(K_OVERLAY_DIM_SEC, v.coerceIn(1, 30)).apply()

    /** 变淡后的不透明度(百分比) */
    var overlayDimAlpha: Int
        get() = snapI(sp.getInt(K_OVERLAY_DIM_ALPHA, 35), 10, 5)
        set(v) = sp.edit().putInt(K_OVERLAY_DIM_ALPHA, snapI(v.coerceIn(10, 100), 10, 5)).apply()

    /** 锁定位置(禁用拖动) */
    var overlayLock: Boolean
        get() = sp.getBoolean(K_OVERLAY_LOCK, false)
        set(v) = sp.edit().putBoolean(K_OVERLAY_LOCK, v).apply()

    /** 常驻展开 */
    var overlayPinExpanded: Boolean
        get() = sp.getBoolean(K_OVERLAY_PIN, false)
        set(v) = sp.edit().putBoolean(K_OVERLAY_PIN, v).apply()

    /** 窗口级背景模糊(Android 12+) */
    var overlayBlur: Boolean
        get() = sp.getBoolean(K_OVERLAY_BLUR, false)
        set(v) = sp.edit().putBoolean(K_OVERLAY_BLUR, v).apply()

    /** 气泡内容: 0 图标 / 1 余额 / 2 请求数 */
    var overlayPill: Int
        get() = sp.getInt(K_OVERLAY_PILL, 0)
        set(v) = sp.edit().putInt(K_OVERLAY_PILL, v.coerceIn(0, 2)).apply()

    /** 状态栏芯片文本: 0 关 / 1 软上限% / 2 硬上限% / 3 余额 */
    var overlayChip: Int
        get() = sp.getInt(K_OVERLAY_CHIP, 1)
        set(v) = sp.edit().putInt(K_OVERLAY_CHIP, v.coerceIn(0, 3)).apply()

    /** 面板显示余额行 */
    var overlayBalanceRow: Boolean
        get() = sp.getBoolean(K_OVERLAY_BALANCE, true)
        set(v) = sp.edit().putBoolean(K_OVERLAY_BALANCE, v).apply()

    /** 气泡形态: 0 圆形 / 1 胶囊 / 2 方形 / 3 圆角方 */
    var overlayShape: Int
        get() = sp.getInt(K_OVERLAY_SHAPE, 0)
        set(v) = sp.edit().putInt(K_OVERLAY_SHAPE, v.coerceIn(0, 3)).apply()

    /** 自定义气泡图案的 content:// uri; 空 = 内置图标 */
    var overlayIconUri: String
        get() = sp.getString(K_OVERLAY_ICON, "") ?: ""
        set(v) = sp.edit().putString(K_OVERLAY_ICON, v).apply()

    /** 服务端球配置的 hash; 与下发值相同 = 视为无变化 */
    var ballCfgHash: String
        get() = sp.getString(K_BALL_HASH, "") ?: ""
        set(v) = sp.edit().putString(K_BALL_HASH, v).apply()

    /** 全量接管: 凡是网关上有 JSON 的二级页都优先走 SDUI；关闭 = 全部原生 */
    var sduiAll: Boolean
        get() = sp.getBoolean(K_SDUI_ALL, true)
        set(v) = sp.edit().putBoolean(K_SDUI_ALL, v).apply()

    /** 额外指定交给 SDUI 的页(逗号分隔); 页面 JSON 不存在时仍会回退原生 */
    var sduiPages: String
        get() = sp.getString(K_SDUI_PAGES, "") ?: ""
        set(v) = sp.edit().putString(K_SDUI_PAGES, v).apply()

    /** 服务端下发的说话语料; 空 = 用内置 R.array.ball_phrases */
    var ballPhrases: List<String>
        get() = (sp.getString(K_BALL_PHRASES, "") ?: "").split('\n').filter { it.isNotBlank() }
        set(v) = sp.edit().putString(K_BALL_PHRASES, v.joinToString("\n")).apply()


    /** 余额预警阈值(低于它标红, 低于 3 倍标黄; <=0 关闭) */
    var balanceWarnBelow: Double
        get() = snapF(sp.getFloat(K_BALANCE_WARN, 0f), 0f, 5f).toDouble()
        set(v) = sp.edit().putFloat(K_BALANCE_WARN, snapF(v.coerceAtLeast(0.0).toFloat(), 0f, 5f)).apply()

    /** 余额自动轮播 */
    var overlayAutoScroll: Boolean
        get() = sp.getBoolean(K_OVERLAY_AUTOSCROLL, true)
        set(v) = sp.edit().putBoolean(K_OVERLAY_AUTOSCROLL, v).apply()

    /** 轮播间隔(秒) */
    var overlayScrollSec: Int
        get() = sp.getInt(K_OVERLAY_SCROLL_SEC, 5)
        set(v) = sp.edit().putInt(K_OVERLAY_SCROLL_SEC, v.coerceIn(2, 60)).apply()

    /** 面板条目显示顺序: 逗号分隔的位值, 128 = 余额行 */
    var overlayRowsOrder: String
        get() = sp.getString(K_OVERLAY_ORDER, "1,2,4,8,16,32,128") ?: "1,2,4,8,16,32,128"
        set(v) = sp.edit().putString(K_OVERLAY_ORDER, v).apply()

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
