package com.aigateway.app.overlay

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.view.ContextThemeWrapper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.view.doOnLayout
import com.aigateway.app.App
import com.aigateway.app.MainActivity
import com.aigateway.app.R
import com.aigateway.app.data.ActiveInst
import com.aigateway.app.data.BalanceUtil
import com.aigateway.app.data.Ctx
import com.aigateway.app.data.GatewayBackend
import com.aigateway.app.data.Instance
import com.aigateway.app.data.RunMode
import com.aigateway.app.data.SettingsStore
import com.aigateway.app.data.Stats
import kotlin.random.Random
import com.aigateway.app.databinding.OverlayFloatingBinding
import com.google.android.material.color.DynamicColors
import com.google.android.material.color.MaterialColors
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.roundToInt
import com.google.android.material.R as MR

/**
 * 悬浮窗服务 —— 在其他应用上层显示网关状态球 / 状态卡。
 *
 * 独立于 [com.aigateway.app.service.GatewayService]: 不依赖「后台保活」开关,
 * Termux 远程模式同样可用。窗口必须 SYSTEM_ALERT_WINDOW 已授权, 否则直接退出,
 * 由设置页负责引导授权。
 *
 * 交互: 拖动移位(可锁定) · 单击展开 · 双击收起/刷新 · 长按刷新 ·
 *       贴边后滑入只露 40% · 静止若干秒变淡。
 */
class OverlayService : Service() {

    companion object {
        private const val TAG = "OverlayService"
        const val CHANNEL_ID = "overlay_floating"
        const val NOTIF_ID = 1002
        const val CH_EV = "overlay_events"
        const val CH_EV_SILENT = "overlay_events_silent"
        const val ACTION_STOP = "com.aigateway.app.STOP_OVERLAY"
        const val ACTION_APPLY = "com.aigateway.app.APPLY_OVERLAY"

        /** 面板信息行位掩码 */
        const val ROW_MODE = 1
        const val ROW_INSTANCE = 2
        const val ROW_PORT = 4
        const val ROW_REQUESTS = 8
        const val ROW_ERRORS = 16
        const val ROW_UPTIME = 32
        const val ROW_BALANCE = 128
        /** 路由行(常驻, 不属于显示内容开关) */
        const val ROW_ROUTE = 256
        /** 上下文占用行(常驻) */
        const val ROW_CTX = 512
        const val ROW_ALL = 63

        /** 气泡形态 */
        const val SHAPE_CIRCLE = 0
        const val SHAPE_PILL = 1
        const val SHAPE_SQUARE = 2
        const val SHAPE_ROUND = 3

        /** 气泡内容 */
        const val PILL_ICON = 0
        const val PILL_BALANCE = 1
        const val PILL_REQUESTS = 2

        /** 预警通知(一次性, 不进常驻通道) */
        const val ALERT_CHANNEL_ID = "overlay_alert"
        const val ALERT_ID_BASE = 2000

        /** 状态栏芯片文本(Android 16 Live Update) */
        const val CHIP_OFF = 0
        const val CHIP_SOFT = 1
        const val CHIP_HARD = 2
        const val CHIP_BALANCE = 3

        const val ANIM_MS = 230L
        const val SLIDE_MS = 220L

        @Volatile
        var isRunning = false
            private set

        /** 启动悬浮窗服务(需已授权), 未授权时静默忽略 —— 调用方负责提示。 */
        fun start(context: Context) {
            if (!Settings.canDrawOverlays(context)) return
            val i = Intent(context, OverlayService::class.java)
            runCatching { context.startForegroundService(i) }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, OverlayService::class.java)) }
        }

        /** 外观/行为设置改动后让运行中的窗口立即套用 */
        fun apply(context: Context) {
            if (!isRunning) return
            runCatching {
                context.startService(Intent(context, OverlayService::class.java).setAction(ACTION_APPLY))
            }
        }

        /** 是否已授权「显示在其他应用上层」 */
        fun canShow(context: Context): Boolean = Settings.canDrawOverlays(context)

        fun openPermissionSettings(context: Context) {
            runCatching {
                context.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        android.net.Uri.parse("package:${context.packageName}")
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
    }

    private data class Bal(
        val channel: String,
        val value: String,
        val unit: String,
        val error: String? = null,
        val warn: String? = null
    ) {
        val text: String get() = if (unit.isBlank()) value else "$value $unit"
    }

    private val app get() = application as App
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var wm: WindowManager
    private lateinit var themedCtx: Context
    private var binding: OverlayFloatingBinding? = null
    private var params: WindowManager.LayoutParams? = null

    private var expanded = false
    private var gatewayRunning = false
    private var refreshing = false

    // 位置: restX/restY 是「完全可见」时的坐标; 半隐藏只是视觉偏移, 不改逻辑坐标
    private var restX = 0
    private var restY = 0
    private var hiddenSide = 0   // 0 未隐藏 / -1 贴左 / 1 贴右

    // 手势
    private var downRawX = 0f
    private var downRawY = 0f
    private var startRestX = 0
    private var startY = 0
    private var dragging = false
    private var longPressFired = false
    private var lastTapAt = 0L
    private var tapRunnable: Runnable? = null

    // 动画
    private var modeAnim: ValueAnimator? = null
    private var slideAnim: ValueAnimator? = null

    // 行控件(位掩码 -> 行)
    private val rowViews = LinkedHashMap<Int, View>()
    private var valMode: TextView? = null
    private var valInstance: TextView? = null
    private var valPort: TextView? = null
    private var valRequests: TextView? = null
    private var valErrors: TextView? = null
    private var valUptime: TextView? = null
    private var valBalance: TextView? = null

    // 渲染数据
    private var balances: List<Bal> = emptyList()
    private var balIndex = 0
    private var lastStats: Stats? = null
    private var lastInstance: Instance? = null
    private var lastOnline = false
    private var lastNoBackend = false

    /** 轮播: 最近活跃实例快照(来自 /admin/api/active) */
    private var activeList: List<ActiveInst> = emptyList()
    /** 轮播当前跟随的实例; 空 = 用应用里选中的那个 */
    private var followName = ""
    /** 手动选过实例后, 这段时间内不跟随轮播 */
    private var pinUntil = 0L
    /** balances 属于哪个实例, 切实例后不会串台 */
    private var balInstanceName = ""

    /** 当前数据绑定的实例名; 应用里切实例后要立刻换数据 */
    private var boundInstance = ""

    /** 查不到余额的渠道 -> 下次重试时间(避免每轮都打空接口) */
    private val noBalance = HashMap<String, Long>()

    private var iconBitmap: android.graphics.Bitmap? = null
    private var iconKey = ""

    /** 面板里的余额列表容器(可滚动) */
    private var balanceBox: LinearLayout? = null

    /** 查询失败的渠道 -> 错误文本 */
    private var balanceFails: List<Pair<String, String>> = emptyList()

    /** 面板里的路由行(常驻) */
    private var valRoute: TextView? = null

    /** 面板里的上下文占用量(常驻) */
    private var valCtx: TextView? = null

    /** 上下文占用量下面那行: 最近一次请求是谁跑的(常驻) */
    private var valCtxWho: TextView? = null

    /** 已排队的一次性路由(null=自动) */
    private var pendingRoute: String? = null

    /** 当前实例的渠道名(路由选择用), 随余额刷新更新 */
    private var channelNames: List<String> = emptyList()

    /** 每个可拖视图自己的长按动作, 在 ACTION_DOWN 时注入 */
    private var longPressAction: () -> Unit = {}

    private val longPress = Runnable {
        longPressFired = true
        binding?.root?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        longPressAction()
    }

    private val dimRunnable = Runnable {
        if (binding == null) return@Runnable
        if (expanded || dragging) return@Runnable
        if (!app.settings.overlayDim) return@Runnable
        setRootAlpha(app.settings.overlayDimAlpha / 100f, 400L)
    }

    private val rotateRunnable = object : Runnable {
        override fun run() {
            if (!app.settings.overlayAutoScroll) return
            if (balances.size > 1) {
                balIndex = nextChannelIndex(balIndex)
                renderBubble()
                renderBalance()
            }
            ui.postDelayed(this, app.settings.overlayScrollSec.coerceIn(2, 60) * 1000L)
        }
    }

    /** 设置变了(开关/间隔/条目数)重新排定轮播 */
    private fun restartRotation() {
        ui.removeCallbacks(rotateRunnable)
        if (balances.size > 1 && app.settings.overlayAutoScroll) {
            ui.postDelayed(rotateRunnable, app.settings.overlayScrollSec.coerceIn(2, 60) * 1000L)
        }
    }

    override fun onCreate() {
        super.onCreate()
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        themedCtx = buildThemedContext()
        isRunning = true
        // 事件总线: 系统广播 + 通知 + 外部 broadcast 都到 handleEvent
        EventHub.sink = { ev -> ui.post { handleEvent(ev) } }
        watch = EventWatch(this) { ev -> EventHub.emit(ev) }.also { it.start() }
        ensureEvChannel()
        startVolPoll()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            app.settings.overlayEnabled = false
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_APPLY) {
            if (binding != null) {
                applyLook()
                syncPanel()
                if (app.settings.overlayPinExpanded && !expanded) setExpanded(true)
            }
            return START_NOT_STICKY
        }

        createChannel()
        startForeground(NOTIF_ID, buildNotification())

        if (!Settings.canDrawOverlays(this)) {
            app.settings.overlayEnabled = false
            stopSelf()
            return START_NOT_STICKY
        }
        if (binding == null) showWindow()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        binding?.root?.doOnLayout { clampInto() }
    }

    override fun onDestroy() {
        isRunning = false
        runCatching { EventHub.sink = null }
        runCatching { watch?.stop() }
        runCatching { volPoll?.let { ui.removeCallbacks(it) } }
        scope.cancel()
        ui.removeCallbacksAndMessages(null)
        modeAnim?.cancel()
        slideAnim?.cancel()
        binding?.let { b -> runCatching { wm.removeViewImmediate(b.root) } }
        binding = null
        params = null
        super.onDestroy()
    }

    // ---------- 窗口 ----------

    /** Material 组件在 Service 里 inflate 必须有 Material 主题, 且动态取色不会自动生效 */
    private fun buildThemedContext(): Context {
        val s = app.settings
        val base = ContextThemeWrapper(this, R.style.Theme_AIGateway)
        if (!s.dynamicColors) base.theme.applyStyle(s.paletteOverlay(), true)
        return DynamicColors.wrapContextIfAvailable(base)
    }

    private fun showWindow() {
        val s = app.settings
        val b = OverlayFloatingBinding.inflate(LayoutInflater.from(themedCtx))
        val p = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            // 未保存过位置时按 dp 摆, 避免默认值被当成像素贴到状态栏下
            x = if (s.overlayX >= 0) s.overlayX else dp(16)
            y = if (s.overlayY >= 0) s.overlayY else dp(240)
        }
        applyBlurFlag(p)

        try {
            wm.addView(b.root, p)
        } catch (e: Exception) {
            // 权限被撤销 / ROM 拦截 —— 不留「开关开着但没有窗」的状态
            toast(getString(R.string.ovl_perm_denied))
            app.settings.overlayEnabled = false
            stopSelf()
            return
        }

        binding = b
        params = p
        restX = p.x
        restY = p.y
        bindWindow(b)

        // 尺寸/配色/行先就位, 再按「常驻展开」定初始形态
        expanded = s.overlayPinExpanded
        b.panelCard.visibility = if (expanded) View.VISIBLE else View.GONE
        b.bubbleWrap.visibility = if (expanded) View.GONE else View.VISIBLE
        applyLook()
        b.root.doOnLayout { clampInto() }

        startPolling()
        restartRotation()
        scheduleDim()
    }

    private fun bindWindow(b: OverlayFloatingBinding) {
        // 气泡: 单击展开/收起, 双击刷新
        b.bubbleCard.setOnTouchListener(
            touchHandler(
                {
                    runActionOr(ballUi?.onTap) {
                        if (hiddenSide != 0) reveal() else { pulse(); say(randomPhrase()) }
                    }
                },
                { runActionOr(ballUi?.onDouble) { refreshNow(); pulse() } },
                { runActionOr(ballUi?.onLong) { setExpanded(!expanded) } }
            )
        )
        // 面板顶部: 单击收起详情, 双击刷新; 不打开 App(面板里已有 App 按钮)
        b.panelHeader.setOnTouchListener(
            touchHandler(
                { if (expanded) setExpanded(false) },
                { refreshNow() },
                { if (expanded) setExpanded(false) }
            )
        )
        b.btnClose.setOnClickListener { closeSelf() }
        b.btnCollapse.setOnClickListener { setExpanded(false) }
        b.btnOpenApp.setOnClickListener { openApp() }
        b.btnToggleGw.setOnClickListener { toggleGateway() }
        b.btnGear.setOnClickListener { toggleSettings() }
        b.btnReset.setOnClickListener { resetLook() }
        bindSettingsPanel(b)
    }

    private fun applyBlurFlag(p: WindowManager.LayoutParams) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        @Suppress("DEPRECATION")
        val flag = WindowManager.LayoutParams.FLAG_BLUR_BEHIND
        if (app.settings.overlayBlur) {
            p.flags = p.flags or flag
            p.blurBehindRadius = dp(30)
        } else {
            p.flags = p.flags and flag.inv()
            p.blurBehindRadius = 0
        }
    }

    // ---------- 外观 ----------

    private fun applyLook() {
        val b = binding ?: return
        val s = app.settings
        val scale = s.overlayScale
        Log.i(TAG, "look: size=${s.overlaySizeDp} scale=$scale gaugeW=${s.overlayGaugeWidth}")

        // 行先按掩码重建, 再统一缩放(新建的 View 没有基准尺寸, 必须在缩放前建好)
        rebuildRows()
        OverlayLook.applyScale(b.panelContent, scale)

        val panelW = dp((s.overlayPanelDp * scale).roundToInt())
        (b.panelCard.layoutParams as? FrameLayout.LayoutParams)?.let {
            it.width = panelW
            b.panelCard.layoutParams = it
        }

        applyBubbleLook(b)

        val bg = s.overlayBg
        if (bg == 0) {
            val c = MaterialColors.getColor(b.panelCard, MR.attr.colorSurfaceContainerHigh)
            b.bubbleCard.setCardBackgroundColor(c)
            b.panelCard.setCardBackgroundColor(c)
        } else {
            b.bubbleCard.setCardBackgroundColor(bg)
            b.panelCard.setCardBackgroundColor(bg)
        }

        params?.let {
            applyBlurFlag(it)
            update(it)
        }
        bindSettingsValues(b)
        renderBubble()
        renderPanel()
        settle()
        b.root.doOnLayout { clampInto() }
    }

    /** 显示顺序: 逗号分隔的位值, 128 = 余额行; 缺项补在末尾 */
    // ---------- 服务端下发的球界面描述 ----------
    private var ballUi: BallUi.Ui? = null
    private var jsonRows = false
    private val rowValueViews = mutableMapOf<String, TextView>()
    private var muteUntil = 0L
    private var radial: RadialMenu? = null
    private var rules: List<EventRules.Rule> = emptyList()
    private val ruleLast = HashMap<String, Long>()
    private var watch: EventWatch? = null
    private var lastEv: Ev? = null
    private var volPoll: Runnable? = null

    private fun rowsOrder(): List<Int> {
        val all = listOf(ROW_MODE, ROW_INSTANCE, ROW_PORT, ROW_REQUESTS, ROW_ERRORS, ROW_UPTIME, ROW_BALANCE)
        val parsed = app.settings.overlayRowsOrder.split(',')
            .mapNotNull { it.trim().toIntOrNull() }
            .filter { it in all }
            .distinct()
        return parsed + all.filter { it !in parsed }
    }

    private fun rebuildRows() {
        val b = binding ?: return
        val s = app.settings
        b.rowsContainer.removeAllViews()
        val ui = ballUi
        if (ui != null && ui.hasRows) {
            buildJsonRows(b, ui)
            return
        }
        jsonRows = false
        rowViews.clear()

        valMode = null
        valInstance = null
        valPort = null
        valRequests = null
        valErrors = null
        valUptime = null
        valBalance = null
        balanceBox = null
        valRoute = null
        valCtx = null
        valCtxWho = null

        for (bit in rowsOrder()) {
            when (bit) {
                ROW_BALANCE -> if (s.overlayBalanceRow) addBalanceRow(b)
                ROW_MODE -> valMode = addRow(b, bit, R.string.ovl_mode, s.overlayRows)
                ROW_INSTANCE -> {
                    valInstance = addRow(b, bit, R.string.ovl_instance, s.overlayRows)
                    valInstance?.setOnClickListener { showInstancePicker() }
                }
                ROW_PORT -> valPort = addRow(b, bit, R.string.ovl_port, s.overlayRows)
                ROW_REQUESTS -> valRequests = addRow(b, bit, R.string.ovl_requests, s.overlayRows)
                ROW_ERRORS -> valErrors = addRow(b, bit, R.string.ovl_errors, s.overlayRows)
                ROW_UPTIME -> valUptime = addRow(b, bit, R.string.ovl_uptime, s.overlayRows)
            }
        }
        // 上下文占用 + 路由行常驻在底部
        valCtx = addRow(b, ROW_CTX, R.string.ovl_ctx, ROW_CTX)
        addCtxWho(b)
        valRoute = addRow(b, ROW_ROUTE, R.string.ovl_route, ROW_ROUTE)
        (rowViews[ROW_ROUTE] as? View)?.apply {
            isClickable = true
            setOnClickListener { routePicker() }
        }
    }

    private fun addBalanceRow(b: OverlayFloatingBinding) {
        val ctx = b.rowsContainer.context
        val header = TextView(ctx).apply {
            setText(R.string.ovl_balance)
            setTextAppearance(MR.style.TextAppearance_Material3_BodySmall)
            setTextColor(MaterialColors.getColor(this, MR.attr.colorOnSurfaceVariant))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(2) }
        }
        val box = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val sv = android.widget.ScrollView(ctx).apply {
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            addView(
                box,
                android.widget.FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            )
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        b.rowsContainer.addView(header)
        b.rowsContainer.addView(sv)
        rowViews[ROW_BALANCE] = sv
        balanceBox = box
    }

    /** 面板里的一行: 渠道名 + 余额 */
    private fun balRowView(ctx: android.content.Context): LinearLayout {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(22)
            )
            isClickable = true
        }
        val name = TextView(ctx).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val value = TextView(ctx).apply {
            maxLines = 1
            gravity = Gravity.END
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { marginStart = dp(8) }
        }
        row.addView(name)
        row.addView(value)
        return row
    }

    /** 气泡形态 / 自定义图案 */
    private fun applyBubbleLook(b: OverlayFloatingBinding) {
        val s = app.settings
        val h = dp((s.overlaySizeDp * s.overlayScale).roundToInt())
        val w = if (s.overlayShape == SHAPE_PILL) (h * 1.8f).roundToInt() else h
        (b.bubbleCard.layoutParams as? FrameLayout.LayoutParams)?.let {
            it.width = w
            it.height = h
            b.bubbleCard.layoutParams = it
        }
        b.bubbleCard.radius = when (s.overlayShape) {
            SHAPE_PILL -> h / 2f
            SHAPE_SQUARE -> dp(6).toFloat()
            SHAPE_ROUND -> h * 0.28f
            else -> h / 2f
        }
        val lp = b.bubbleIcon.layoutParams as? FrameLayout.LayoutParams
        val bmp = if (s.overlayIconUri.isNotBlank()) loadIcon(s.overlayIconUri) else null
        if (bmp != null) {
            b.bubbleIcon.setImageBitmap(bmp)
            b.bubbleIcon.imageTintList = null
            b.bubbleIcon.scaleType = android.widget.ImageView.ScaleType.CENTER_CROP
            lp?.let {
                it.width = w
                it.height = h
                b.bubbleIcon.layoutParams = it
            }
        } else {
            b.bubbleIcon.setImageResource(R.drawable.ic_power)
            b.bubbleIcon.imageTintList = ColorStateList.valueOf(
                MaterialColors.getColor(b.bubbleCard, MR.attr.colorPrimary)
            )
            b.bubbleIcon.scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
            val side = (h * 0.46f).roundToInt()
            lp?.let {
                it.width = side
                it.height = side
                b.bubbleIcon.layoutParams = it
            }
        }

        layoutGauge()
    }

    /**
     * 三圈/三条的留白: 圆与胶囊用球外三圈, 方与圆角方用贴着屏幕中心那侧的三条。
     * 只改球的边距与笔宽, 不动球本身尺寸。
     */
    private fun layoutGauge() {
        val b = binding ?: return
        val s = app.settings
        val rings = s.overlayShape == SHAPE_CIRCLE || s.overlayShape == SHAPE_PILL
        val h = dp((s.overlaySizeDp * s.overlayScale).roundToInt())
        val d0 = resources.displayMetrics.density
        val pw = s.overlayGaugeWidth.coerceIn(60, 200) / 100f
        val band = if (rings) (h * 0.30f * pw).roundToInt() else 0
        val strip = if (rings) 0 else (h * 0.50f * pw).roundToInt()
        val side = if (rings) 0 else barSide()
        val left = if (rings) band else if (side < 0) strip else 0
        val right = if (rings) band else if (side > 0) strip else 0
        val vpad = if (rings) band else 0

        (b.bubbleCard.layoutParams as? FrameLayout.LayoutParams)?.let {
            if (it.leftMargin != left || it.rightMargin != right ||
                it.topMargin != vpad || it.bottomMargin != vpad
            ) {
                it.setMargins(left, vpad, right, vpad)
                b.bubbleCard.layoutParams = it
            }
        }
        if (rings) {
            // 三条描边 + 两条间隙 + 两边留白正好填满带宽
            val sw = ((band - 2f * d0 / 3f) / 4.7f).coerceAtLeast(1.2f * d0)
            b.bubbleRings.setMetrics(sw, sw * 0.85f, sw * 2f, 0f)
        } else {
            val thick = (h * 0.08f * pw).coerceIn(2f * d0, 8f * d0)
            b.bubbleRings.setMetrics(thick, thick, thick, strip.toFloat())
        }
        // 环视图必须写死尺寸: match_parent 在 wrap_content 容器里会被量成整屏
        val cw = b.bubbleCard.layoutParams.width.takeIf { it > 0 } ?: h
        val ch = b.bubbleCard.layoutParams.height.takeIf { it > 0 } ?: h
        (b.bubbleRings.layoutParams as? FrameLayout.LayoutParams)?.let {
            val rw = cw + left + right
            val rh = ch + vpad * 2
            if (it.width != rw || it.height != rh) {
                it.width = rw
                it.height = rh
                b.bubbleRings.layoutParams = it
            }
        }
        b.bubbleRings.setMode(!rings, side)

        // 上方文字与球左缘对齐(球被外侧留白推开了 left)
        (b.bubbleLabel.layoutParams as? FrameLayout.LayoutParams)?.let {
            if (it.marginStart != left) {
                it.marginStart = left
                b.bubbleLabel.layoutParams = it
            }
        }
    }

    /** 三条贴向屏幕中心那一侧: 球在左半屏给右侧, 反之给左侧 */
    private fun barSide(): Int {
        val bounds = screenBounds()
        val w = binding?.root?.width?.takeIf { it > 0 } ?: dp(56)
        return if (restX + w / 2 < bounds.width() / 2) 1 else -1
    }

    /** 自定义图案解码到 <=256px, 结果按 uri 缓存 */
    private fun loadIcon(uriStr: String): android.graphics.Bitmap? {
        if (iconKey == uriStr) return iconBitmap
        val uri = android.net.Uri.parse(uriStr)
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        runCatching {
            contentResolver.openInputStream(uri)?.use {
                android.graphics.BitmapFactory.decodeStream(it, null, bounds)
            }
        }
        val side = maxOf(bounds.outWidth, bounds.outHeight).coerceAtLeast(1)
        var sample = 1
        while (side / sample > 256) sample *= 2
        val bmp = runCatching {
            contentResolver.openInputStream(uri)?.use {
                android.graphics.BitmapFactory.decodeStream(
                    it, null,
                    android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }
                )
            }
        }.getOrNull()
        iconBitmap = bmp
        iconKey = if (bmp != null) uriStr else ""
        return bmp
    }

    /** 应用里换了实例: 旧数据作废, 否则端口/余额会一直停在旧实例 */
    /** 实际显示的实例: 轮播跟随优先, 否则用应用里选中的那个 */
    private fun effectiveInstance(): String =
        if (followName.isNotBlank()) followName else app.connectionStore.activeInstance

    /** 余额只显示"属于当前实例"的那份 */
    private fun balShown(): Bal? =
        balances.getOrNull(balIndex)?.takeIf { balInstanceName == effectiveInstance() }

    private fun bindInstance(): Boolean {
        val cur = effectiveInstance()
        if (cur == boundInstance) return false
        boundInstance = cur
        balances = emptyList()
        balanceFails = emptyList()
        balInstanceName = ""
        balIndex = 0
        noBalance.clear()
        lastInstance = null
        lastStats = null
        alertArmed = false
        prevInflight = 0
        return true
    }

    private fun nextBalance() {
        if (balances.size <= 1) return
        balIndex = nextChannelIndex(balIndex)
        renderBalance()
        renderBubble()
    }

    /** 上下文行下面的小字: 模型 · 渠道 · 多久以前 */
    private fun addCtxWho(b: OverlayFloatingBinding) {
        val ctx = b.rowsContainer.context
        val tv = TextView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 10.5f)
            setTextColor(MaterialColors.getColor(this, MR.attr.colorOnSurfaceVariant))
        }
        b.rowsContainer.addView(tv)
        valCtxWho = tv
    }

    /** 3s / 4m / 2h / 1d —— 不带词, 各语言都读得懂 */
    private fun agoText(at: Long): String {
        if (at <= 0) return "—"
        val s = (System.currentTimeMillis() - at) / 1000
        return when {
            s < 60 -> s.toString() + "s"
            s < 3600 -> (s / 60).toString() + "m"
            s < 86400 -> (s / 3600).toString() + "h"
            else -> (s / 86400).toString() + "d"
        }
    }

    private fun addRow(b: OverlayFloatingBinding, bit: Int, labelRes: Int, mask: Int): TextView? {
        if (mask and bit == 0) return null
        val ctx = b.rowsContainer.context
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) }
        }
        val label = TextView(ctx).apply {
            setText(labelRes)
            setTextAppearance(MR.style.TextAppearance_Material3_BodySmall)
            setTextColor(MaterialColors.getColor(this, MR.attr.colorOnSurfaceVariant))
        }
        val value = TextView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                .apply { marginStart = dp(12) }
            gravity = Gravity.END
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setTextAppearance(MR.style.TextAppearance_Material3_BodySmall)
            setTextColor(MaterialColors.getColor(this, MR.attr.colorOnSurface))
            text = "—"
        }
        row.addView(label)
        row.addView(value)
        b.rowsContainer.addView(row)
        rowViews[bit] = row
        return value
    }

    private fun toggleSettings() {
        val b = binding ?: return
        val show = b.settingsPanel.visibility != View.VISIBLE
        b.settingsPanel.visibility = if (show) View.VISIBLE else View.GONE
        if (show) bindSettingsValues(b)
        b.root.doOnLayout { clampInto() }
    }

    private fun resetLook() {
        val s = app.settings
        s.overlayScale = 1f
        s.overlayDimAlpha = 35
        s.overlaySnap = true
        s.overlayDim = true
        s.overlayLock = false
        s.overlayPinExpanded = false
        s.overlayBlur = false
        applyLook()
    }

    // ---------- 手势 ----------

    private fun touchHandler(
        onSingleTap: () -> Unit,
        onDoubleTap: () -> Unit = {},
        onLongPress: () -> Unit = {},
    ): View.OnTouchListener {
        val slop = ViewConfiguration.get(this).scaledTouchSlop
        return View.OnTouchListener { _, ev ->
            val p = params
            val s = app.settings
            if (p == null) false else when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = ev.rawX
                    downRawY = ev.rawY
                    startRestX = restX
                    startY = p.y
                    dragging = false
                    longPressFired = false
                    longPressAction = onLongPress
                    ui.removeCallbacks(longPress)
                    ui.postDelayed(longPress, (ballUi?.longHoldMs ?: 420).toLong())
                    wake()
                    true
                }

                MotionEvent.ACTION_MOVE -> {
                    val dx = ev.rawX - downRawX
                    val dy = ev.rawY - downRawY
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) {
                        dragging = true
                        ui.removeCallbacks(longPress)
                    }
                    if (dragging && !s.overlayLock) {
                        hiddenSide = 0
                        restX = startRestX + dx.toInt()
                        p.x = restX
                        p.y = startY + dy.toInt()
                        update(p)
                    }
                    true
                }

                MotionEvent.ACTION_UP -> {
                    ui.removeCallbacks(longPress)
                    if (dragging) {
                        dragging = false
                        settle()
                    } else if (!longPressFired) {
                        singleTap(onSingleTap, onDoubleTap)
                    }
                    scheduleDim()
                    true
                }

                MotionEvent.ACTION_CANCEL -> {
                    ui.removeCallbacks(longPress)
                    dragging = false
                    scheduleDim()
                    true
                }

                else -> false
            }
        }
    }

    /** 单击立即生效; 260ms 内的第二次点击改判为「收起」——用 210ms 延迟窗口换不闪烁 */
    private fun singleTap(action: () -> Unit, onDouble: () -> Unit) {
        // 单击延迟 220ms 生效, 期间再点一次算双击(刷新)
        val now = SystemClock.uptimeMillis()
        if (now - lastTapAt in 1..280) {
            lastTapAt = 0L
            tapRunnable?.let { ui.removeCallbacks(it) }
            tapRunnable = null
            onDouble()
        } else {
            lastTapAt = now
            val r = Runnable {
                tapRunnable = null
                action()
            }
            tapRunnable = r
            ui.postDelayed(r, 220)
        }
    }

    // ---------- 位置 / 吸附 / 半隐藏 ----------

    private fun update(p: WindowManager.LayoutParams) {
        val v = binding?.root ?: return
        runCatching { wm.updateViewLayout(v, p) }
    }

    /**
     * 可用区域。悬浮窗的 params.x/y 是相对「状态栏以下」的父容器, 所以要把系统栏扣掉,
     * 否则展开到屏幕下半部时窗口底部会被裁掉(实测差 141px = 状态栏高度)。
     */
    private fun screenBounds(): Rect =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val m = wm.currentWindowMetrics
            val ins = m.windowInsets.getInsetsIgnoringVisibility(
                android.view.WindowInsets.Type.statusBars() or
                        android.view.WindowInsets.Type.navigationBars()
            )
            val b = m.bounds
            Rect(0, 0, b.width(), (b.height() - ins.top - ins.bottom).coerceAtLeast(0))
        } else {
            Rect(0, 0, resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
        }

    /** 松手后: 夹进屏内 -> 贴边判定 -> 半隐藏 */
    private fun settle() {
        val b = binding ?: return
        val p = params ?: return
        val bounds = screenBounds()
        val w = b.root.width.takeIf { it > 0 } ?: dp(68)
        val h = b.root.height.takeIf { it > 0 } ?: dp(68)
        val maxX = (bounds.width() - w).coerceAtLeast(0)
        restX = restX.coerceIn(0, maxX)
        restY = p.y.coerceIn(0, (bounds.height() - h).coerceAtLeast(0))

        val edge = dp(24)
        hiddenSide = if (app.settings.overlaySnap && !expanded) {
            when {
                restX <= edge -> -1
                restX >= maxX - edge -> 1
                else -> 0
            }
        } else {
            0
        }
        slideAnimated()
        savePos()
    }

    private fun slideAnimated() {
        val b = binding ?: return
        val p = params ?: return
        val w = b.root.width.takeIf { it > 0 } ?: dp(68)
        val target = when (hiddenSide) {
            -1 -> -(w * 0.6f).roundToInt()
            1 -> screenBounds().width() - (w * 0.4f).roundToInt()
            else -> restX
        }
        slideAnim?.cancel()
        val from = p.x
        if (from == target) return
        val anim = ValueAnimator.ofInt(from, target)
        anim.duration = SLIDE_MS
        anim.interpolator = PathInterpolator(0.2f, 0f, 0f, 1f)
        anim.addUpdateListener {
            p.x = it.animatedValue as Int
            p.y = restY
            update(p)
        }
        anim.start()
        slideAnim = anim
    }

    /** 从半隐藏滑出: 只滑出来, 不展开 */
    private fun reveal() {
        hiddenSide = 0
        slideAnimated()
    }

    /** 夹到屏幕内并持久化坐标(旋转/展开后都必须调用) */
    private fun clampInto() {
        val b = binding ?: return
        val p = params ?: return
        val bounds = screenBounds()
        val w = b.root.width.takeIf { it > 0 } ?: dp(68)
        val h = b.root.height.takeIf { it > 0 } ?: dp(68)
        restX = restX.coerceIn(0, (bounds.width() - w).coerceAtLeast(0))
        restY = restY.coerceIn(0, (bounds.height() - h).coerceAtLeast(0))
        hiddenSide = 0
        p.x = restX
        p.y = restY
        update(p)
        savePos()
    }

    private fun savePos() {
        app.settings.overlayX = restX
        app.settings.overlayY = restY
    }

    // ---------- 静止变淡 ----------

    private fun wake() {
        ui.removeCallbacks(dimRunnable)
        setRootAlpha(1f, 120L)
    }

    /**
     * 静止变淡走 View alpha, 不能动 params.alpha ——
     * 实测本 ROM 上窗口 alpha<1 后 InputDispatcher 不再投递触摸, 气泡会变得点不动。
     */
    private fun setRootAlpha(target: Float, ms: Long) {
        val b = binding ?: return
        // 只淡化气泡: 整个 root 一起淡会让详情窗口也半透明
        if (abs(b.bubbleWrap.alpha - target) < 0.005f) return
        b.bubbleWrap.animate().alpha(target).setDuration(ms).start()
        b.bubbleLabel.animate().alpha(target).setDuration(ms).start()
    }

    private fun scheduleDim() {
        ui.removeCallbacks(dimRunnable)
        if (!app.settings.overlayDim) {
            wake()
            return
        }
        ui.postDelayed(dimRunnable, app.settings.overlayDimSec * 1000L)
    }

    // ---------- 展开 / 收起 ----------

    private fun setExpanded(on: Boolean, animate: Boolean = true) {
        val b = binding ?: return
        val p = params ?: return
        if (on == expanded && b.root.width > 0 && modeAnim == null) return
        modeAnim?.cancel()
        slideAnim?.cancel()
        hiddenSide = 0
        expanded = on
        if (on) b.bubbleLabel.visibility = View.GONE

        val from = if (on) b.bubbleWrap else b.panelCard
        val to = if (on) b.panelCard else b.bubbleWrap

        if (!animate) {
            from.visibility = View.GONE
            to.visibility = View.VISIBLE
            to.alpha = 1f
            p.width = WindowManager.LayoutParams.WRAP_CONTENT
            p.height = WindowManager.LayoutParams.WRAP_CONTENT
            p.x = restX
            p.y = restY
            update(p)
            b.root.doOnLayout { clampInto() }
            if (on) refreshNow() else renderBubble()
            scheduleDim()
            return
        }

        val oldW = b.root.width.takeIf { it > 0 } ?: dp(68)
        val oldH = b.root.height.takeIf { it > 0 } ?: dp(68)

        // 本地量一次目标尺寸, 不提交窗口尺寸
        to.visibility = View.VISIBLE
        from.visibility = View.GONE
        val bounds = screenBounds()
        b.root.measure(
            View.MeasureSpec.makeMeasureSpec(bounds.width(), View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(bounds.height(), View.MeasureSpec.AT_MOST)
        )
        val newW = b.root.measuredWidth.coerceAtLeast(dp(40))
        val newH = b.root.measuredHeight.coerceAtLeast(dp(40))
        from.visibility = View.VISIBLE
        to.visibility = View.GONE

        // 目标卡宽度固定, 补间过程中不会被压窄导致文字重排;
        // 气泡容器必须保持 wrap_content —— 球尺寸含外侧留白, 写死会把它压变形
        if (to !== b.bubbleWrap) {
            val toLp = to.layoutParams
            if (toLp.width <= 0) {
                toLp.width = dp((app.settings.overlayPanelDp * app.settings.overlayScale).roundToInt())
            }
            to.layoutParams = toLp
        }

        p.width = oldW
        p.height = oldH
        p.x = restX
        p.y = restY
        to.visibility = View.VISIBLE
        to.alpha = 0f
        from.alpha = 1f
        update(p)

        val anim = ValueAnimator.ofFloat(0f, 1f)
        anim.duration = ANIM_MS
        anim.interpolator = PathInterpolator(0.2f, 0f, 0f, 1f)
        anim.addUpdateListener { a ->
            val t = a.animatedValue as Float
            p.width = (oldW + (newW - oldW) * t).roundToInt()
            p.height = (oldH + (newH - oldH) * t).roundToInt()
            from.alpha = 1f - t
            to.alpha = t
            update(p)
        }
        anim.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(a: Animator) {
                modeAnim = null
                from.visibility = View.GONE
                from.alpha = 1f
                to.alpha = 1f
                p.width = WindowManager.LayoutParams.WRAP_CONTENT
                p.height = WindowManager.LayoutParams.WRAP_CONTENT
                update(p)
                b.root.doOnLayout {
                    clampInto()
                    if (on) refreshNow() else renderBubble()
                }
                scheduleDim()
            }
        })
        modeAnim = anim
        anim.start()
    }

    // ---------- 窗内设置 ----------

    private var syncing = false

    private fun bindSettingsPanel(b: OverlayFloatingBinding) {
        val s = app.settings

        b.sliderScale.apply {
            valueFrom = 0.8f
            valueTo = 1.3f
            stepSize = 0.05f
            addOnChangeListener { _, v, fromUser ->
                b.tvScaleLabel.text = getString(R.string.ovl_scale) + "  " + (v * 100).roundToInt() + "%"
                if (fromUser) s.overlayScale = v
            }
            addOnSliderTouchListener(object : com.google.android.material.slider.Slider.OnSliderTouchListener {
                override fun onStartTrackingTouch(slider: com.google.android.material.slider.Slider) = Unit
                override fun onStopTrackingTouch(slider: com.google.android.material.slider.Slider) {
                    applyLook()
                }
            })
        }

        b.sliderDim.apply {
            valueFrom = 10f
            valueTo = 100f
            stepSize = 5f
            addOnChangeListener { _, v, fromUser ->
                b.tvDimLabel.text = getString(R.string.ovl_dim_alpha) + "  " + v.roundToInt() + "%"
                if (fromUser) s.overlayDimAlpha = v.roundToInt()
            }
            addOnSliderTouchListener(object : com.google.android.material.slider.Slider.OnSliderTouchListener {
                override fun onStartTrackingTouch(slider: com.google.android.material.slider.Slider) = Unit
                override fun onStopTrackingTouch(slider: com.google.android.material.slider.Slider) {
                    wake()
                    scheduleDim()
                }
            })
        }

        b.swSnap.setOnCheckedChangeListener { _, on ->
            if (syncing) return@setOnCheckedChangeListener
            s.overlaySnap = on
            if (on) settle() else {
                hiddenSide = 0
                slideAnimated()
            }
        }
        b.swDim.setOnCheckedChangeListener { _, on ->
            if (syncing) return@setOnCheckedChangeListener
            s.overlayDim = on
            if (on) scheduleDim() else wake()
        }
        b.swLock.setOnCheckedChangeListener { _, on ->
            if (syncing) return@setOnCheckedChangeListener
            s.overlayLock = on
        }
        b.swPin.setOnCheckedChangeListener { _, on ->
            if (syncing) return@setOnCheckedChangeListener
            s.overlayPinExpanded = on
            if (on && !expanded) setExpanded(true)
        }
        b.swBlur.setOnCheckedChangeListener { _, on ->
            if (syncing) return@setOnCheckedChangeListener
            s.overlayBlur = on
            params?.let {
                applyBlurFlag(it)
                update(it)
            }
        }
    }

    private fun bindSettingsValues(b: OverlayFloatingBinding) {
        val s = app.settings
        syncing = true
        runCatching {
            b.sliderScale.value = s.overlayScale.coerceIn(0.8f, 1.3f)
            b.sliderDim.value = (s.overlayDimAlpha.coerceIn(10, 100) / 5 * 5).toFloat()
        }
        b.tvScaleLabel.text = getString(R.string.ovl_scale) + "  " + (s.overlayScale * 100).roundToInt() + "%"
        b.tvDimLabel.text = getString(R.string.ovl_dim_alpha) + "  " + s.overlayDimAlpha + "%"
        b.swSnap.isChecked = s.overlaySnap
        b.swDim.isChecked = s.overlayDim
        b.swLock.isChecked = s.overlayLock
        b.swPin.isChecked = s.overlayPinExpanded
        b.swBlur.isChecked = s.overlayBlur
        syncing = false
    }

    private fun syncPanel() {
        binding?.let { bindSettingsValues(it) }
    }

    // ---------- 数据 ----------

    private fun startPolling() {
        scope.launch {
            while (isActive) {
                // 单次失败(网络/解析)不应打断轮询
                runCatching { refresh() }
                // 展开态看得见, 3s 一次; 收起态只探活, 20s 一次(远程模式省流量)
                delay(if (expanded) 3_000L else 20_000L)
            }
        }
        scope.launch {
            // 每 5s 问一次"谁在活跃": 只读网关内存, 不打上游; 有新请求就立刻刷上下文
            while (isActive) {
                runCatching { pollActive() }
                delay(5_000L)
            }
        }
        scope.launch {
            // 余额是每家渠道一次真实上游请求, 低频刷新, 需要时靠长按立即拉
            while (isActive) {
                runCatching { refreshBalances() }
                delay(60_000L)
            }
        }
        scope.launch {
            // 服务端球外观/文案: 只在 hash 变化时写偏好并重绘, 平时零开销
            while (isActive) {
                runCatching { pollBall() }
                delay(60_000L)
            }
        }
    }

    /**
     * 拉服务端下发的球外观/文案。hash 没变时 BallConfig.apply 返回 false, 不写偏好不重绘;
     * 网关不支持(内嵌模式/旧版本)时 getBall 返回空对象, 直接跳过。
     */
    private suspend fun pollBall() {
        val backend = app.backend() ?: return
        val inst = effectiveInstance().ifBlank { "default" }
        val j = withContext(Dispatchers.IO) {
            runCatching { backend.getBall(inst) }.getOrNull()
        } ?: return
        if (j.entrySet().isEmpty()) return
        val ui = BallUi.parse(j)
        val structChanged = (ui.hasRows != jsonRows) || (ui.rings.size != (ballUi?.rings?.size ?: -1))
        ballUi = ui
        runCatching { checkNoti(ui.noti, null) }
        rules = EventRules.parse(j)
        if (rules.isNotEmpty()) {
            Log.i(TAG, "when: " + rules.joinToString(", ") { "${it.key}=${it.on}" })
        }
        if (BallConfig.apply(app.settings, j)) {
            val n = j.getAsJsonObject("look")?.entrySet()?.size ?: 0
            Log.i(TAG, "ball cfg applied: inst=$inst keys=$n")
            applyLook()
        }
        applyUiPerform(ui)
        applyRingStyle()
        if (structChanged) rebuildRows()
        updateRings()
        renderPanel()
        Log.i(TAG, "ball ui: rings=${ui.rings.size} rows=${ui.rows.size} radial=${ui.radialItems.size} bars=${ui.bars} when=${rules.size}")
    }

    /** perform: 透明度 / 缩放 / 锁定; 其余(icon/roll/side/dark)先只记录 */
    private fun applyUiPerform(ui: BallUi.Ui) {
        val p = params
        if (p != null && p.alpha != ui.alpha) {
            p.alpha = ui.alpha
            runCatching { wm.updateViewLayout(binding?.root ?: return, p) }
        }
        applyRingStyle()
        Log.i(
            TAG,
            "perform: zoom=${ui.zoom} alpha=${ui.alpha} roll=${ui.rollSec}s side=${ui.sideSec}s " +
                "dark=${ui.darkSec}s lock=${ui.lock} icon=${ui.icon ?: "-"} longHold=${ui.longHoldMs}ms"
        )
    }

    /** 数据快照: data 里的路径在这棵树上取值 */
    private fun snapshot(): com.google.gson.JsonObject {
        val o = com.google.gson.JsonObject()
        val st = lastStats
        val cx = st?.context
        o.addProperty("inst", lastInstance?.name ?: app.connectionStore.activeInstance.ifBlank { "—" })
        o.add("stats", com.google.gson.JsonObject().apply {
            addProperty("requests", st?.requests ?: 0)
            addProperty("errors", st?.errors ?: 0)
            addProperty("inflight", 0)
            addProperty("uptime", st?.uptime ?: 0)
            add("context", com.google.gson.JsonObject().apply {
                addProperty("percent", cx?.percent ?: 0.0)
                addProperty("prompt", cx?.prompt ?: 0)
                addProperty("window", cx?.window ?: 0)
                addProperty("soft", cx?.soft ?: 0.0)
                addProperty("hard", cx?.hard ?: 0.0)
                addProperty("model", cx?.model ?: "")
                addProperty("channel", cx?.channel ?: "")
            })
        })
        o.add("local", com.google.gson.JsonObject().apply {
            addProperty("expanded", expanded)
            addProperty("online", lastOnline)
            addProperty("hiddenSide", hiddenSide)
        })
        val bal = balShown()
        if (bal != null) {
            o.add("balance", com.google.gson.JsonObject().apply {
                addProperty("value", bal.value)
                addProperty("unit", bal.unit)
            })
        }
        return o
    }

    /** 点路径取值; 拒绝 config.* 与 stats.byKey.*（可能含密钥） */
    private fun pickPath(path: String): Float? {
        if (path.startsWith("config.") || path.startsWith("stats.byKey")) return null
        var cur: com.google.gson.JsonElement? = snapshot()
        for (part in path.split('.')) {
            val e = cur ?: return null
            cur = when {
                e.isJsonObject -> e.asJsonObject.get(part)
                e.isJsonArray -> part.toIntOrNull()?.let { i ->
                    if (i >= 0 && i < e.asJsonArray.size()) e.asJsonArray.get(i) else null
                }
                else -> null
            }
        }
        val e = cur ?: return null
        return when {
            e.isJsonPrimitive && e.asJsonPrimitive.isNumber -> e.asFloat
            e.isJsonPrimitive && e.asJsonPrimitive.isBoolean -> if (e.asBoolean) 1f else 0f
            else -> null
        }
    }

    /** ringStyle: 环形/条形、贴哪一侧、线宽与间隙 */
    private fun applyRingStyle() {
        val b = binding ?: return
        val ui = ballUi ?: return
        b.bubbleRings.setMode(ui.bars, ui.ringSide)
        val d = resources.displayMetrics.density
        if (ui.strokeDp != null) {
            b.bubbleRings.setMetrics(
                ui.strokeDp * d * ui.zoom,
                (ui.gapDp ?: 2f) * d * ui.zoom,
                4f * d,
                28f * d
            )
        }
    }

    /**
     * 跟随最近活跃实例: 2 个以上在跑就每 5s 换一个; 只有 1 个时按需即时刷新。
     * 只读网关内存(_lastCtx), 不产生上游请求。
     */
    private suspend fun pollActive() {
        if (binding == null) return
        val backend = app.backend() ?: return
        val r = withContext(Dispatchers.IO) {
            runCatching { backend.getActive() }.getOrNull()
        } ?: return
        activeList = r.active
        val names = r.active.map { it.name }
        runCatching {
            checkThinking(r.active.firstOrNull { it.name == effectiveInstance() }?.inflight ?: 0)
        }
        val pinned = SystemClock.elapsedRealtime() < pinUntil

        if (pinned) return
        if (names.size >= 2) {
            val idx = names.indexOf(followName)
            val next = if (idx < 0) names[0] else names[(idx + 1) % names.size]
            if (next != followName) {
                followName = next
                refreshOnly()
            } else if (newerThanShown(r.active, next)) {
                refreshOnly()
            }
        } else {
            if (followName.isNotBlank()) {
                followName = ""
                refreshOnly()
                return
            }
            val only = names.firstOrNull()
            if (only != null && only == app.connectionStore.activeInstance &&
                newerThanShown(r.active, only)
            ) {
                refreshOnly()
            }
        }
    }

    /** 网关那边的最近一次上下文比球上显示的更新 */
    private fun newerThanShown(list: List<ActiveInst>, name: String): Boolean {
        val at = list.firstOrNull { it.name == name }?.at ?: 0L
        if (name != effectiveInstance()) return false
        return at > (lastStats?.context?.at ?: 0L)
    }

    private fun refreshOnly() {
        scope.launch { runCatching { refresh() } }
    }

    private fun refreshNow() {
        noBalance.clear()
        scope.launch { runCatching { refresh() } }
        scope.launch { runCatching { refreshBalances() } }
    }

    private suspend fun refresh() {
        if (binding == null) return
        if (bindInstance()) {
            renderPanel()
            renderBubble()
        }
        if (refreshing) return
        refreshing = true
        try {
            val backend = app.backend()
            if (backend == null) {
                lastNoBackend = true
                lastOnline = false
                lastStats = null
                renderPanel()
                renderBubble()
                return
            }
            val inst = effectiveInstance()
            val reachable = withContext(Dispatchers.IO) {
                runCatching { backend.testConnection() }.getOrDefault(false)
            }
            if (binding == null) return
            if (!reachable) {
                lastNoBackend = false
                lastOnline = false
                lastStats = null
                renderPanel()
                renderBubble()
                return
            }
            val stats = withContext(Dispatchers.IO) {
                runCatching { backend.getStats(inst) }.getOrNull()
            }
            pendingRoute = stats?.onceChannel
            val cur: Instance? = if (expanded) {
                withContext(Dispatchers.IO) {
                    runCatching { backend.getInstances() }.getOrNull()
                }?.let { r ->
                    r.instances.firstOrNull { it.name == inst }
                        ?: r.instances.firstOrNull { it.name == r.current }
                        ?: r.instances.firstOrNull()
                }
            } else {
                lastInstance
            }
            if (binding == null) return
            lastStats = stats
            lastInstance = cur
            lastOnline = true
            lastNoBackend = false
            gatewayRunning = cur?.running ?: gatewayRunning
            runCatching { checkThinking(stats?.inflight ?: 0) }
            renderPanel()
            renderBubble()
            runCatching { checkAlerts() }
        } finally {
            refreshing = false
        }
    }

    private suspend fun refreshBalances() {
        if (binding == null) return
        val backend = app.backend() ?: return
        if (bindInstance()) {
            renderPanel()
            renderBubble()
        }
        val inst = effectiveInstance()
        val list = withContext(Dispatchers.IO) { loadBalances(backend, inst) }
        if (binding == null) return
        // list 为空 = 本轮全部命中重试黑名单, 保留上次结果, 否则失败行会被自己擦掉
        if (list.isNotEmpty()) {
            balanceFails = list.filter { it.error != null }.map { it.channel to it.error.orEmpty() }
            balances = list.filter { it.error == null }
            balInstanceName = inst
            if (balIndex >= balances.size) balIndex = 0
        }
        renderBalance()
        renderBubble()
        restartRotation()
        runCatching { checkAlerts() }
    }

    /**
     * 逐渠道查余额: 只有真配了余额接口的渠道才会有值, 查不到的记 10 分钟后再试,
     * 避免每轮都去打一遍没配余额的渠道。
     */
    private suspend fun loadBalances(backend: GatewayBackend, inst: String): List<Bal> {
        val cfg = runCatching { backend.getConfig(inst) }.onFailure {
            android.util.Log.w("OvlBal", "getConfig($inst) 失败: ${it.message}")
        }.getOrNull() ?: return emptyList()
        val out = ArrayList<Bal>()
        val now = System.currentTimeMillis()
        channelNames = cfg.channels.map { it.name }
        for (ch in cfg.channels) {
            if (out.count { it.error == null } >= 8) break
            if (ch.name.isBlank()) continue
            if (ch.apiKey.isBlank() && !ch.hasKey) continue
            if (now < (noBalance[ch.name] ?: 0L)) continue
            val j = runCatching { backend.getBalance(inst, ch.name) }.onFailure {
                android.util.Log.w("OvlBal", "getBalance(${ch.name}) 失败: ${it.message}")
            }.getOrNull()
            val err = j?.get("error")?.takeIf { !it.isJsonNull }?.asString
            if (j == null || err != null) {
                val msg = err ?: "请求失败"
                out += Bal(ch.name, "", "", msg)
                // 配置类问题(没预设/路径不对)等 10 分钟, 网络/鉴权类只等 45 秒
                val cfgErr = msg.contains("预设") || msg.contains("取值路径")
                noBalance[ch.name] = now + if (cfgErr) 10 * 60_000L else 45_000L
                continue
            }
            val many = parseAmounts(j)
            if (many.isNotEmpty()) {
                many.forEach { (unit, v) -> out += Bal(ch.name, v, unit, warn = ch.warnBelow) }
                continue
            }
            val v = j.get("balance")?.takeIf { !it.isJsonNull }?.asString?.trim().orEmpty()
            if (v.isBlank() || v == "-") {
                out += Bal(ch.name, "", "", "上游无余额字段")
                noBalance[ch.name] = now + 45_000L
                continue
            }
            val unit = j.get("unit")?.takeIf { !it.isJsonNull }?.asString.orEmpty()
            out += Bal(ch.name, v, unit, warn = ch.warnBelow)
        }
        return out
    }

    /** 网关若返回多币种(amounts: [{unit, value}]), 每种货币单独一行 */
    private fun parseAmounts(j: com.google.gson.JsonObject): List<Pair<String, String>> {
        val arr = j.get("amounts")?.takeIf { it.isJsonArray }?.asJsonArray ?: return emptyList()
        val out = ArrayList<Pair<String, String>>()
        for (e in arr) {
            val o = e.takeIf { it.isJsonObject }?.asJsonObject ?: continue
            val v = o.get("value")?.takeIf { !it.isJsonNull }?.asString?.trim().orEmpty()
            if (v.isBlank()) continue
            val u = o.get("unit")?.takeIf { !it.isJsonNull }?.asString.orEmpty()
            out += u to v
        }
        return out
    }

    // ---------- 渲染 ----------

    private fun dotColor(): Int {
        val gray = ContextCompat.getColor(this, android.R.color.darker_gray)
        val green = ContextCompat.getColor(this, android.R.color.holo_green_dark)
        val amber = ContextCompat.getColor(this, android.R.color.holo_orange_dark)
        return when {
            !lastOnline -> gray
            (lastStats?.errors ?: 0) > 0 -> amber
            else -> green
        }
    }

    private fun renderPanel() {
        val b = binding ?: return
        val c = ColorStateList.valueOf(dotColor())
        b.panelDot.backgroundTintList = c
        b.bubbleDot.backgroundTintList = c

        b.panelStatus.text = getString(
            when {
                lastNoBackend -> R.string.ovl_no_backend
                lastOnline -> R.string.ovl_online
                else -> R.string.ovl_offline
            }
        )

        val stats = lastStats
        val inst = lastInstance
        val visible = app.settings.overlayRows
        if (visible and ROW_MODE != 0) {
            valMode?.text = when (app.connectionStore.runMode) {
                RunMode.EMBEDDED -> getString(R.string.ov_mode_embedded)
                RunMode.TERMUX -> getString(
                    R.string.ov_mode_remote,
                    app.connectionStore.getCurrentProfile()?.baseUrl ?: ""
                )
                else -> getString(R.string.ov_mode_unset)
            }
        }
        if (visible and ROW_INSTANCE != 0) {
            valInstance?.text = inst?.name ?: app.connectionStore.activeInstance.ifBlank { "—" }
        }
        if (visible and ROW_PORT != 0) valPort?.text = inst?.port?.toString() ?: "—"
        if (visible and ROW_REQUESTS != 0) valRequests?.text = (stats?.requests ?: 0).toString()
        if (visible and ROW_ERRORS != 0) valErrors?.text = (stats?.errors ?: 0).toString()
        if (visible and ROW_UPTIME != 0) valUptime?.text = formatUptime(stats?.uptime ?: 0)

        b.btnToggleGw.text = getString(if (gatewayRunning) R.string.ovl_stop else R.string.ovl_start)
        val cx = lastStats?.context
        if (valCtx != null) {
            val p = cx?.percent
            if (cx == null || cx.window <= 0L || p == null) {
                valCtx?.text = getString(R.string.ovl_ctx_none)
                valCtx?.setTextColor(MaterialColors.getColor(b.root, MR.attr.colorOnSurfaceVariant))
            } else {
                val est = if (cx.est) "\u2248" else ""
                valCtx?.text = est + shortTokens(cx.prompt) + " / " + shortTokens(cx.window) +
                    " \u00b7 " + est + trimNum(p) + "%"
                valCtx?.setTextColor(
                    when (ctxLevel(cx)) {
                        2 -> MaterialColors.getColor(b.root, MR.attr.colorError)
                        1 -> 0xFFFFB300.toInt()
                        else -> MaterialColors.getColor(b.root, MR.attr.colorOnSurface)
                    }
                )
            }
        }
        valCtxWho?.text = when {
            cx == null -> ""
            else -> buildString {
                append(cx.model.ifBlank { "—" })
                if (cx.channel.isNotBlank()) append("  \u00b7  ").append(cx.channel)
                append("  \u00b7  ").append(agoText(cx.at))
            }
        }
        valRoute?.text = (pendingRoute?.let { "\u2192 " + it } ?: getString(R.string.ovl_route_auto)) + " \u203a"
        renderBalance()
        if (jsonRows) renderJsonRows()
    }

    /** 三圈: 外=占用量/软上限, 中=占用量/硬上限, 内=余额预警(整圈) */
    private fun updateRings() {
        runCatching { updateNotif() }
        val b = binding ?: return
        val ui = ballUi
        if (ui != null && ui.hasRings) {
            b.bubbleRings.setRingList(ui.rings.map { specToRing(it) })
            return
        }
        val custom = app.settings.overlayGaugeColor
        val primary = if (custom != 0) custom else MaterialColors.getColor(b.root, MR.attr.colorPrimary)
        val err = MaterialColors.getColor(b.root, MR.attr.colorError)
        val amber = 0xFFFFB300.toInt()
        val cx = lastStats?.context
        val pct = cx?.percent
        val softRaw = cx?.soft ?: 0.0
        val soft = if (softRaw > 0.0) softRaw else 80.0
        val hard = cx?.hard ?: 0.0
        var softRing: RingGaugeView.Ring? = null
        var hardRing: RingGaugeView.Ring? = null
        if (cx != null && cx.window > 0L && pct != null) {
            val softColor = if (pct >= soft) amber else primary
            softRing = RingGaugeView.Ring((pct / soft).toFloat(), softColor, withAlpha(softColor))
            if (hard > 0.0) {
                val hardColor = if (pct >= hard) err else amber
                hardRing = RingGaugeView.Ring((pct / hard).toFloat(), hardColor, withAlpha(hardColor))
            }
        }
        var balRing: RingGaugeView.Ring? = null
        val bal = balShown()
        if (bal != null) {
            val warn = app.settings.balanceWarnBelow
            val g = balGroup(bal)
            if (g.any { BalanceUtil.threshold(it.warn, it.unit, warn) > 0.0 }) {
                val c = when (balGroupLevel(g)) {
                    2 -> err
                    1 -> amber
                    else -> primary
                }
                balRing = RingGaugeView.Ring(1f, c, withAlpha(c))
            }
        }
        b.bubbleRings.setRings(softRing, hardRing, balRing)
    }

    private fun withAlpha(color: Int): Int = (color and 0x00FFFFFF) or (0x30 shl 24)

    // ---------- 球界面描述: 环 / 行 / 气泡 / 动作 / 按钮环 ----------

    /** 语义色: 只有这几档, 不接受任意色值 */
    private fun toneColor(t: String): Int {
        val root = binding?.root ?: return 0xFF888888.toInt()
        return when (t) {
            "ok" -> 0xFF43A047.toInt()
            "warn" -> 0xFFFFB300.toInt()
            "danger" -> MaterialColors.getColor(root, MR.attr.colorError)
            "info" -> 0xFF29B6F6.toInt()
            "muted" -> MaterialColors.getColor(root, MR.attr.colorOnSurfaceVariant)
            else -> {
                val custom = app.settings.overlayGaugeColor
                if (custom != 0) custom else MaterialColors.getColor(root, MR.attr.colorPrimary)
            }
        }
    }

    /** 一个环: from 让 APP 现算, value/max 让服务端直接给数 */
    private fun specToRing(spec: BallUi.RingSpec): RingGaugeView.Ring? {
        val cx = lastStats?.context
        val pct = cx?.percent
        val soft = if ((cx?.soft ?: 0.0) > 0.0) cx!!.soft else 80.0
        val hard = cx?.hard ?: 0.0
        val progress = when (spec.from) {
            "ctxSoft" -> pct?.let { (it / soft).toFloat() }
            "ctxHard" -> if (hard > 0.0) pct?.let { (it / hard).toFloat() } else null
            "ctxPct" -> pct?.let { (it / 100.0).toFloat() }
            "balance" -> if (balShown() != null) 1f else 0f
            else -> {
                val v = spec.value
                if (v != null) {
                    val m = spec.max?.takeIf { it > 0f } ?: 100f
                    v / m
                } else {
                    val expr = spec.from ?: return null
                    val parts = expr.split('/')
                    val base = pickPath(parts[0]) ?: return null
                    if (parts.size == 1) base else {
                        val div = parts[1].toFloatOrNull() ?: pickPath(parts[1]) ?: return null
                        if (div == 0f) null else base / div
                    }
                }
            }
        } ?: return null
        val c = toneColor(spec.color)
        return RingGaugeView.Ring(progress.coerceIn(0f, 1f), c, withAlpha(c))
    }

    private fun buildJsonRows(b: OverlayFloatingBinding, ui: BallUi.Ui) {
        jsonRows = true
        rowValueViews.clear()
        val ctx = b.rowsContainer.context
        val d = resources.displayMetrics.density
        for (row in ui.rows) {
            val line = android.widget.LinearLayout(ctx).apply {
                orientation = android.widget.LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                setPadding(0, (3 * d).toInt(), 0, (3 * d).toInt())
            }
            val lab = TextView(ctx).apply {
                text = row.label
                textSize = 12f * ui.zoom
                setTextColor(MaterialColors.getColor(b.root, MR.attr.colorOnSurfaceVariant))
                layoutParams = android.widget.LinearLayout.LayoutParams(
                    0, android.view.ViewGroup.LayoutParams.WRAP_CONTENT, 1f
                )
            }
            val value = TextView(ctx).apply {
                textSize = 12f * ui.zoom
                typeface = android.graphics.Typeface.MONOSPACE
                gravity = android.view.Gravity.END
                setTextColor(MaterialColors.getColor(b.root, MR.attr.colorOnSurface))
            }
            line.addView(lab)
            line.addView(value)
            b.rowsContainer.addView(line)
            rowValueViews[row.key] = value
        }
    }

    private fun renderJsonRows() {
        val ui = ballUi ?: return
        val sc = com.aigateway.app.sdui.SduiScope(state = uiState())
        for (row in ui.rows) {
            val tv = rowValueViews[row.key] ?: continue
            runCatching { tv.text = com.aigateway.app.sdui.SduiScope.text(row.value, sc) }
        }
    }

    /** 行与气泡可用的变量; 模板写法 {{state.xxx}} */
    private fun uiState(): com.google.gson.JsonObject {
        val g = com.google.gson.JsonObject()
        val st = lastStats
        val inst = lastInstance
        val cx = st?.context
        val bal = balShown()
        g.addProperty("inst", inst?.name ?: app.connectionStore.activeInstance.ifBlank { "—" })
        g.addProperty("port", inst?.port?.toString() ?: "—")
        g.addProperty("requests", (st?.requests ?: 0).toString())
        g.addProperty("errors", (st?.errors ?: 0).toString())
        g.addProperty("uptime", formatUptime(st?.uptime ?: 0))
        g.addProperty(
            "online",
            getString(
                when {
                    lastNoBackend -> R.string.ovl_no_backend
                    lastOnline -> R.string.ovl_online
                    else -> R.string.ovl_offline
                }
            )
        )
        g.addProperty("ctxPct", cx?.percent?.let { trimNum(it) } ?: "—")
        g.addProperty(
            "ctxText",
            if (cx != null && cx.window > 0L) shortTokens(cx.prompt) + " / " + shortTokens(cx.window)
            else getString(R.string.ovl_ctx_none)
        )
        g.addProperty("ctxModel", cx?.model ?: "—")
        g.addProperty("ctxChannel", cx?.channel ?: "")
        g.addProperty("ctxAgo", cx?.let { agoText(it.at) } ?: "")
        g.addProperty("route", pendingRoute ?: "自动")
        g.addProperty("balance", bal?.text ?: "—")
        g.addProperty("mode", app.connectionStore.runMode?.name ?: "")
        return g
    }

    private fun bubbleRuleText(): CharSequence? {
        val ui = ballUi ?: return null
        val sc = com.aigateway.app.sdui.SduiScope(state = uiState())
        if (ui.bubbleRules.isEmpty() && ui.bubbleTexts.isNotEmpty()) {
            return com.aigateway.app.sdui.SduiScope.text(ui.bubbleTexts[0], sc)
        }
        val rules = ui.bubbleRules
        if (rules.isEmpty()) return null
        val key = when {
            expanded -> "expanded"
            lastNoBackend -> "noBackend"
            !lastOnline -> "offline"
            else -> "default"
        }
        val hit = rules.firstOrNull { it.first == key } ?: return null
        return com.aigateway.app.sdui.SduiScope.text(
            hit.second, com.aigateway.app.sdui.SduiScope(state = uiState())
        )
    }

    private fun runActionOr(a: com.google.gson.JsonObject?, fallback: () -> Unit) {
        if (a == null) fallback() else runAction(a)
    }

    /** 动作集: 只认这些类型; intent 只允许打网关自己的 /admin/api/ */
    private fun runAction(a: com.google.gson.JsonObject?, trusted: Boolean = true) {
        if (a == null) return
        val type = a.get("type")?.takeIf { it.isJsonPrimitive }?.asString ?: return
        val str = { k: String -> a.get(k)?.takeIf { it.isJsonPrimitive }?.asString }
        when (type) {
            "expand" -> setExpanded(true)
            "collapse" -> setExpanded(false)
            "toggle" -> setExpanded(!expanded)
            "menu" -> showRadial()
            "reload" -> refreshNow()
            "open" -> if (trusted) openAppPage(str("page")) else toast("外部事件不允许 open")
            "copy" -> {
                if (!trusted) { toast("外部事件不允许 copy"); return }
                val t = str("text") ?: return
                runCatching {
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("ball", t))
                }
                toast("已复制")
            }
            "toast" -> toast(str("text") ?: "")
            "mute" -> {
                val m = a.get("minutes")?.takeIf { it.isJsonPrimitive }?.asInt ?: 30
                muteUntil = SystemClock.elapsedRealtime() + m * 60_000L
                toast("静音 $m 分钟")
            }
            "intent" -> {
                if (!trusted) { toast("外部事件不允许 intent"); return }
                val ep = str("endpoint") ?: return
                if (!ep.startsWith("/admin/api/")) {
                    toast("只允许 /admin/api/")
                    return
                }
                val body = a.getAsJsonObject("body") ?: com.google.gson.JsonObject()
                scope.launch {
                    runCatching {
                        withContext(Dispatchers.IO) { app.backend()?.postUi(ep, body) }
                        refreshNow()
                    }.onFailure { toast("请求失败: " + (it.message ?: "")) }
                }
            }
            "bubble" -> {
                val hold = (a.get("hold")?.takeIf { it.isJsonPrimitive }?.asDouble ?: 3.0).coerceIn(1.0, 30.0)
                say(EventRules.render(str("text") ?: "", lastEv), (hold * 1000).toLong(), force = true)
            }
            "notify" -> postNotify(
                EventRules.render(str("title") ?: "悬浮球", lastEv),
                EventRules.render(str("text") ?: "", lastEv)
            )
            "sequence" -> a.getAsJsonArray("actions")?.forEach {
                runAction(it as? com.google.gson.JsonObject, trusted)
            }
            else -> toast("未知动作 $type")
        }
    }

    // ---------- 事件 ----------

    private fun handleEvent(ev: Ev) {
        lastEv = ev
        if (ev.on == "noti") checkNoti(ballUi?.noti, ev)
        if (rules.isEmpty()) return
        val now = SystemClock.elapsedRealtime()
        var hits = 0
        for (r in rules) {
            if (hits >= 4) break
            if (!EventRules.match(r, ev)) continue
            val last = ruleLast[r.key]
            if (last != null && now - last < r.cooldownMs) {
                Log.i(TAG, "ev skip ${r.label} 冷却 ${
                    (now - last) / 1000
                }s/${r.cooldownMs / 1000}s")
                continue
            }
            ruleLast[r.key] = now
            hits++
            Log.i(TAG, "ev hit ${r.label} on=${ev.on} src=${ev.src} 动作×${r.actions.size}")
            val trusted = ev.src == "sys"
            r.actions.forEachIndexed { i, act ->
                if (i == 0 || r.delaySec <= 0) runAction(act, trusted)
                else ui.postDelayed({ runAction(act, trusted) }, r.delaySec * 1000L * i)
            }
        }
        if (hits == 0 && ev.on != "battery" && ev.on != "battery_low") {
            Log.i(TAG, "ev ${ev.on} src=${ev.src} pct=${ev.pct} vol=${ev.vol} pkg=${ev.pkg ?: "-"} rules=${rules.size} hits=0")
        }
    }

    private fun startVolPoll() {
        if (volPoll != null) return
        val r = object : Runnable {
            override fun run() {
                runCatching { watch?.pollVolume() }
                ui.postDelayed(this, 20_000L)
            }
        }
        volPoll = r
        ui.postDelayed(r, 20_000L)
    }

    private fun ensureEvChannel() {
        runCatching {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CH_EV) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CH_EV, "悬浮球事件", NotificationManager.IMPORTANCE_DEFAULT)
                )
            }
            if (nm.getNotificationChannel(CH_EV_SILENT) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CH_EV_SILENT, "悬浮球消息（静默）", NotificationManager.IMPORTANCE_LOW)
                )
            }
        }
    }

    /** 事件动作 notify: 走独立通道, 不占用前台通知 id */
    private fun postNotify(title: String, text: String) = postNotifyCard(title, text, false)

    private fun postNotifyCard(title: String, text: String, silent: Boolean) {
        runCatching {
            val nm = getSystemService(NotificationManager::class.java)
            val b = Notification.Builder(this, if (silent) CH_EV_SILENT else CH_EV)
                .setSmallIcon(R.drawable.ic_power)
                .setContentTitle(title.take(48).ifBlank { "悬浮球" })
                .setContentText(text.take(240))
                .setAutoCancel(true)
                .build()
            nm.notify((SystemClock.elapsedRealtime() % 900).toInt() + 200, b)
        }.onFailure { Log.w(TAG, "notify fail: ${it.message}") }
    }

    // ---------- noti 组: 发一条系统消息 ----------

    private var lastNotiStamp = ""

    /**
     * noti 两条路都走这里：
     *  ev != null  → 外部广播立即发（场景: ballctl noti "内容"）
     *  ev == null  → 60s 轮询发现 noti.time 变了，补发一次
     * time 只用于去重，不显示。
     */
    private fun checkNoti(n: BallUi.Noti?, ev: Ev?) {
        if (ev != null) {
            val stamp = ev.stamp ?: ""
            if (stamp.isNotEmpty() && stamp == lastNotiStamp) return
            lastNotiStamp = stamp.ifEmpty { n?.time ?: "" }
            val body = (ev.text ?: "").ifBlank { n?.text ?: "" }
            if (body.isBlank()) return
            postNotifyCard(ev.title ?: n?.name ?: "悬浮球", renderData(body), n?.silence ?: false)
            return
        }
        if (n == null || n.text.isBlank()) return
        val stamp = n.time.ifBlank { n.text }
        if (stamp == lastNotiStamp) return
        lastNotiStamp = stamp
        postNotifyCard(n.name, renderData(n.text), n.silence)
    }

    private val DATA_TPL = Regex("""\{\{([^}]+)\}\}""")

    /** noti.text 里的 {{数据路径}} / {{state.xxx}} */
    private fun renderData(tpl: String): String {
        if (!tpl.contains("{{")) return tpl
        return DATA_TPL.replace(tpl) { m ->
            pickText(m.groupValues[1].trim().removePrefix("state.")) ?: "-"
        }
    }

    private fun pickText(path: String): String? {
        if (path.startsWith("config.") || path.startsWith("stats.byKey")) return null
        var cur: com.google.gson.JsonElement? = snapshot()
        for (part in path.split(".")) {
            val e = cur ?: return null
            cur = when {
                e.isJsonObject -> e.asJsonObject.get(part)
                e.isJsonArray -> part.toIntOrNull()?.let { i ->
                    if (i >= 0 && i < e.asJsonArray.size()) e.asJsonArray.get(i) else null
                }
                else -> null
            }
        }
        val e = cur ?: return null
        return when {
            e.isJsonPrimitive && e.asJsonPrimitive.isString -> e.asString
            e.isJsonPrimitive -> e.asString
            else -> null
        }
    }

    private fun openAppPage(page: String?) {
        runCatching {
            val i = Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (!page.isNullOrBlank()) {
                if (page.startsWith("sdui:")) i.putExtra("sdui_page", page.removePrefix("sdui:"))
                else i.putExtra("page", page)
            }
            startActivity(i)
        }
    }

    private fun showRadial() {
        val b = binding ?: return
        val ui = ballUi ?: return
        if (ui.radialItems.isEmpty()) {
            toast("没有菜单项")
            return
        }
        radial?.dismiss()
        val v = if (expanded) b.panelCard else b.bubbleWrap
        if (v.width == 0 || v.height == 0) {
            toast("球还没布局完成")
            return
        }
        val d = resources.displayMetrics.density
        radial = RadialMenu(this, ui.radialItems, (ui.radialRadiusDp * d).toInt()) { runAction(it) }
        radial?.show(v, v.width, v.height)
    }

    /** 上下文占用等级: 0 正常 / 1 偏高(>=soft) / 2 见顶(>=hard) */
    private fun ctxLevel(c: Ctx?): Int {
        if (c == null || c.window <= 0L) return 0
        val p = c.percent ?: return 0
        val soft = if (c.soft > 0.0) c.soft else 80.0
        val hard = if (c.hard > 0.0) c.hard else 95.0
        return when {
            p >= hard -> 2
            p >= soft -> 1
            else -> 0
        }
    }

    /** 96000 -> 96k, 128000 -> 128k, 1250 -> 1.3k */
    private fun shortTokens(v: Long): String = when {
        v >= 1_000_000L -> trimNum(v / 100_000.0 / 10.0) + "M"
        v >= 1_000L -> trimNum(v / 1000.0) + "k"
        else -> v.toString()
    }

    private fun trimNum(d: Double): String {
        val r = Math.round(d * 10) / 10.0
        return if (r == Math.floor(r)) r.toLong().toString() else r.toString()
    }

    /** 悬浮球里点一次: 选个渠道只走下一次请求 */
    private fun routePicker() {
        val names = channelNames
        if (names.isEmpty()) {
            Toast.makeText(this, getString(R.string.ovl_route_empty), Toast.LENGTH_SHORT).show()
            return
        }
        val items = ArrayList<String>(names.size + 1)
        items.add(getString(R.string.ovl_route_auto))
        items.addAll(names)
        val cur = pendingRoute
        val shown = items.mapIndexed { i, t ->
            val hit = if (i == 0) cur == null else t == cur
            if (hit) "\u2713 " + t else t
        }
        val dlg = com.google.android.material.dialog.MaterialAlertDialogBuilder(themedCtx)
            .setTitle(R.string.ovl_route_pick)
            .setItems(shown.toTypedArray()) { _, i ->
                val target = if (i == 0) null else names[i - 1]
                scope.launch {
                    val backend = app.backend() ?: return@launch
                    val r = runCatching {
                        backend.setOnceChannel(app.connectionStore.activeInstance, target)
                    }.getOrNull()
                    if (r != null && r.ok) {
                        pendingRoute = target
                        renderPanel()
                    } else {
                        Toast.makeText(this@OverlayService, getString(R.string.ovl_route_fail), Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .create()
        // Service 里没有 Activity token, 弹窗必须显式用悬浮窗类型, 否则 BadTokenException
        dlg.window?.apply {
            setType(android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY)
            clearFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        }
        dlg.show()
    }

    private fun renderBalance() {
        val box = balanceBox ?: return
        val ctx = box.context
        val total = balances.size + balanceFails.size
        if (total == 0) {
            box.removeAllViews()
            box.addView(
                TextView(ctx).apply {
                    setText(R.string.ovl_balance_none)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                    setTextColor(MaterialColors.getColor(this, MR.attr.colorOnSurfaceVariant))
                    setPadding(0, dp(2), 0, dp(2))
                }
            )
            return
        }
        // 空状态塞的是 TextView, 直接复用会 ClassCastException, 先清掉
        if (box.childCount > 0 && box.getChildAt(0) !is LinearLayout) box.removeAllViews()
        while (box.childCount < total) box.addView(balRowView(ctx))
        while (box.childCount > total) box.removeViewAt(box.childCount - 1)

        var i = 0
        balances.forEachIndexed { idx, bal ->
            val row = box.getChildAt(i) as LinearLayout
            val name = row.getChildAt(0) as TextView
            val value = row.getChildAt(1) as TextView
            val active = bal.channel == balances.getOrNull(balIndex)?.channel
            name.text = bal.channel
            name.setTextColor(
                MaterialColors.getColor(
                    name,
                    if (active) MR.attr.colorOnSurface else MR.attr.colorOnSurfaceVariant
                )
            )
            value.text = prettyAmount(bal.value, bal.unit)
            value.setTextColor(
                when (BalanceUtil.level(bal.value, bal.unit, bal.warn, app.settings.balanceWarnBelow)) {
                    2 -> MaterialColors.getColor(value, MR.attr.colorError)
                    1 -> 0xFFFFB300.toInt()
                    else -> MaterialColors.getColor(value, MR.attr.colorOnSurface)
                }
            )
            value.typeface =
                if (active) android.graphics.Typeface.DEFAULT_BOLD else android.graphics.Typeface.DEFAULT
            name.alpha = if (active) 1f else 0.72f
            value.alpha = if (active) 1f else 0.72f
            row.setOnClickListener {
                balIndex = idx
                renderBalance()
                renderBubble()
            }
            i++
        }
        // 查询失败的渠道也列出来, 否则用户只看到一句 "无余额数据"
        balanceFails.forEach { (ch, err) ->
            val row = box.getChildAt(i) as LinearLayout
            val name = row.getChildAt(0) as TextView
            val value = row.getChildAt(1) as TextView
            val code = Regex("(?:返回|HTTP)\\s*(\\d{3})").find(err)?.groupValues?.get(1)
            name.text = ch
            name.setTextColor(MaterialColors.getColor(name, MR.attr.colorOnSurfaceVariant))
            name.alpha = 0.72f
            value.text = getString(R.string.ovl_fail) + " " + (code ?: err.take(10))
            value.setTextColor(MaterialColors.getColor(value, MR.attr.colorError))
            value.typeface = android.graphics.Typeface.DEFAULT
            value.alpha = 1f
            row.setOnClickListener(null)
            i++
        }
        // 超过 4 行就限高, 内部滚动
        (rowViews[ROW_BALANCE] as? android.widget.ScrollView)?.let { sv ->
            (sv.layoutParams as? LinearLayout.LayoutParams)?.let { lp ->
                lp.height = if (total > 4) dp(92) else ViewGroup.LayoutParams.WRAP_CONTENT
                sv.layoutParams = lp
            }
        }
    }

    /** 余额原值可能是一长串小数, 显示时收敛到最多两位 */
    private fun prettyAmount(v: String, unit: String): String {
        val d = v.toDoubleOrNull()
        val num = if (d == null) v else {
            val t = String.format("%.2f", d).trimEnd('0').trimEnd('.')
            if (t.isEmpty()) "0" else t
        }
        return num + unit
    }

    /** 换值时淡出淡入, 轮播时不突兀 */
    private fun setFade(tv: TextView, text: String) {
        if (tv.text.toString() == text) return
        tv.animate().cancel()
        tv.animate().alpha(0f).setDuration(90).withEndAction {
            tv.text = text
            tv.animate().alpha(1f).setDuration(140).start()
        }.start()
    }

    private fun renderBubble() {
        val b = binding ?: return
        b.bubbleDot.backgroundTintList = ColorStateList.valueOf(dotColor())
        val s = app.settings
        // 三个数值放球上方的气泡里, 球内只放图标/图案
        val cx = lastStats?.context
        val lvlCtx = ctxLevel(cx)
        b.bubbleCard.strokeWidth = if (lvlCtx > 0) dp(2) else 0
        if (lvlCtx > 0) {
            b.bubbleCard.strokeColor = when (lvlCtx) {
                2 -> MaterialColors.getColor(b.root, MR.attr.colorError)
                else -> 0xFFFFB300.toInt()
            }
        }
        val label = b.bubbleLabel
        val text: CharSequence? = bubbleRuleText() ?: labelSpans(s)
        if (text == null || expanded) {
            label.visibility = View.GONE
        } else {
            label.text = text
            label.visibility = View.VISIBLE
        }
        // 上方文字占位改由容器承担(球外侧留白 + 24dp 文字行)
        (b.bubbleWrap.layoutParams as? FrameLayout.LayoutParams)?.let {
            val want = if (label.visibility == View.VISIBLE) dp(24) else 0
            if (it.topMargin != want) {
                it.topMargin = want
                b.bubbleWrap.layoutParams = it
            }
        }
        b.bubbleIcon.visibility = View.VISIBLE
        b.bubbleIcon.alpha = 1f
        layoutGauge()
        updateRings()
    }

    /**
     * 球上方气泡: 软上限占用% · 硬上限占用% · 余额(可选前缀请求数)。
     * 与球外三圈(或三条)一一对应, 每段用自己的等级色; 没数据就不出现。
     */
    private fun labelSpans(s: SettingsStore): CharSequence? {
        if (s.overlayPill == PILL_ICON) return null
        val b = binding ?: return null
        val white = 0xFFFFFFFF.toInt()
        val amber = 0xFFFFB300.toInt()
        val err = MaterialColors.getColor(b.root, MR.attr.colorError)
        val sb = android.text.SpannableStringBuilder()
        fun add(t: String, c: Int) {
            if (sb.isNotEmpty()) sb.append("  \u00b7  ")
            val st = sb.length
            sb.append(t)
            sb.setSpan(
                android.text.style.ForegroundColorSpan(c),
                st, sb.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            )
        }
        val cx = lastStats?.context
        val ok = cx != null && cx.window > 0L && cx.percent != null
        val p = if (ok) cx!!.percent!! else 0.0
        val soft = if ((cx?.soft ?: 0.0) > 0.0) cx!!.soft else 80.0
        val hard = cx?.hard ?: 0.0
        if (s.overlayPill == PILL_REQUESTS) add(compact(lastStats?.requests ?: 0), white)
        val eq = if (cx != null && cx.est) "\u2248" else ""
        if (ok) {
            add(eq + trimNum(p / soft * 100.0) + "%", if (p >= soft) amber else white)
            if (hard > 0.0) {
                add(eq + trimNum(p / hard * 100.0) + "%", if (p >= hard) err else if (p >= soft) amber else white)
            }
        }
        val bal = balShown()
        if (bal != null) {
            val g = balGroup(bal)
            val lvl = balVisible(g).maxOfOrNull {
                BalanceUtil.level(it.value, it.unit, it.warn, s.balanceWarnBelow)
            } ?: 0
            add(balGroupText(g), when (lvl) { 2 -> err; 1 -> amber; else -> white })
        }
        return if (sb.isEmpty()) null else sb
    }

    /** 47.86 CNY -> ¥47.9; 无对应符号时退回币种代码 */
    /** 同一渠道的所有币种(DeepSeek 会同时返回 CNY 和 USD) */
    private fun balGroup(bal: Bal?): List<Bal> =
        if (bal == null) emptyList() else balances.filter { it.channel == bal.channel }

    /** 0 的那一侧不显示(DeepSeek 总返 USD 0.00); 两侧都 0 时全显示 */
    private fun balVisible(list: List<Bal>): List<Bal> {
        val nz = list.filter { (it.value.toDoubleOrNull() ?: 0.0) != 0.0 }
        return if (nz.isNotEmpty()) nz else list
    }

    /** 组内最差等级: 只看真正显示的那些币种, 否则 0.00 的副币种会把主币种染红 */
    private fun balGroupLevel(list: List<Bal>): Int =
        balVisible(list).maxOfOrNull {
            BalanceUtil.level(it.value, it.unit, it.warn, app.settings.balanceWarnBelow)
        } ?: 0

    /** ¥12384 · $0.0 —— 每个币种带自己的符号; 0 的那一侧不占地方(DeepSeek 会返 USD 0.00) */
    private fun balGroupText(list: List<Bal>): String =
        balVisible(list).joinToString(" \u00b7 ") { balText(it) }

    /** 轮播按"渠道"跳, 不再在同一个渠道的多个币种之间来回 */
    private fun nextChannelIndex(from: Int): Int {
        if (balances.isEmpty()) return 0
        val cur = balances[from.coerceIn(0, balances.size - 1)].channel
        for (k in 1..balances.size) {
            val i = (from + k) % balances.size
            if (balances[i].channel != cur) return i
        }
        return from
    }

    private fun balText(bal: Bal): String {
        val sym = when (bal.unit.trim().uppercase()) {
            "CNY", "RMB" -> "\u00a5"
            "USD" -> "$"
            "EUR" -> "\u20ac"
            "JPY" -> "JP\u00a5"
            "HKD" -> "HK$"
            else -> ""
        }
        val v = shortAmount(bal.value)
        return when {
            sym.isNotEmpty() -> sym + v
            bal.unit.isBlank() -> v
            else -> v + " " + bal.unit
        }
    }

    private fun shortAmount(v: String): String {
        val d = v.toDoubleOrNull() ?: return v.take(4)
        return if (d >= 100) d.roundToInt().toString() else String.format("%.1f", d)
    }

    private fun compact(n: Long): String =
        if (n >= 1_000_000) String.format("%.1fM", n / 1_000_000f)
        else if (n >= 1_000) String.format("%.1fk", n / 1_000f)
        else n.toString()

    private fun formatUptime(sec: Long): String = when {
        sec <= 0 -> "—"
        sec < 3600 -> String.format("%d:%02d", sec / 60, sec % 60)
        sec < 86400 -> String.format("%d:%02d:%02d", sec / 3600, (sec % 3600) / 60, sec % 60)
        else -> "${sec / 86400}d ${(sec % 86400) / 3600}h"
    }

    // ---------- 动作 ----------

    private fun toggleGateway() {
        val backend = app.backend()
        if (backend == null) {
            toast(getString(R.string.ovl_no_backend))
            return
        }
        val inst = app.connectionStore.activeInstance
        val cmd = if (gatewayRunning) "stop" else "start"
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching { backend.action(inst, cmd) }.getOrNull()
            }
            val msg = when {
                r == null -> getString(R.string.op_failed, "")
                r.ok -> r.output.ifBlank { getString(R.string.ok) }
                else -> r.error ?: getString(R.string.op_failed, "")
            }
            toast(msg)
            refresh()
        }
    }

    private fun openApp() {
        runCatching {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            )
        }
        setExpanded(false)
    }

    private fun closeSelf() {
        app.settings.overlayEnabled = false
        stopSelf()
    }

    private fun toast(msg: String) {
        runCatching { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).roundToInt()

    // ---------- 通知 ----------

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.ovl_notif_title),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.ovl_notif_desc)
            setShowBadge(false)
        }
        nm.createNotificationChannel(ch)

        if (nm.getNotificationChannel(ALERT_CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    ALERT_CHANNEL_ID,
                    getString(R.string.alert_channel),
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply { setShowBadge(true) }
            )
        }
    }

    private var alertArmed = false
    private var prevCtxLvl = 0
    private var prevBalLvl = 0
    private var alertSeq = 0
    private val lastAlertAt = HashMap<String, Long>()

    private var lastNotifKey = ""
    private var lastNotifAt = 0L

    private fun buildNotification(
        title: String = getString(R.string.ovl_notif_title),
        text: String = getString(R.string.ovl_notif_desc),
        big: String? = null,
        chip: String? = null,
    ): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val closeIntent = PendingIntent.getService(
            this, 1,
            Intent(this, OverlayService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_power)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openIntent)
            .addAction(0, getString(R.string.ovl_close), closeIntent)
            .apply {
                if (!big.isNullOrEmpty()) setStyle(NotificationCompat.BigTextStyle().bigText(big))
                // Android 16 Live Update: 请求提升成状态栏芯片, 芯片上只放一段短文本
                if (chip != null) {
                    if (Build.VERSION.SDK_INT >= 35) runCatching { setRequestPromotedOngoing(true) }
                    if (Build.VERSION.SDK_INT >= 36) runCatching { setShortCriticalText(chip) }
                }
            }
            .build()
    }

    private var prevInflight = 0

    /** 从"没在跑"变成"在跑"时说一句; 结束后重新武装 */
    private fun checkThinking(n: Int) {
        if (n > 0 && prevInflight == 0) say(getString(R.string.ball_thinking))
        prevInflight = n
    }

    /** 球说话: 借用上方气泡显示一句话, 2.6s 后自动还原成数字 */
    private fun say(text: String) = say(text, 2600L, false)

    /** holdMs: 气泡显示多久; force: 忽略静音(事件动作允许) */
    private fun say(text: String, holdMs: Long, force: Boolean = false) {
        if (!force && SystemClock.elapsedRealtime() < muteUntil) return
        val b = binding ?: return
        runCatching {
            b.bubbleLabel.text = text
            b.bubbleLabel.visibility = View.VISIBLE
            ui.removeCallbacks(restoreLabel)
            ui.postDelayed(restoreLabel, holdMs.coerceIn(500L, 30_000L))
        }
    }

    private val restoreLabel = Runnable {
        runCatching { renderBubble() }
    }

    private fun randomPhrase(): String {
        val remote = app.settings.ballPhrases
        if (remote.isNotEmpty()) return remote[Random.nextInt(remote.size)]
        val arr = runCatching { resources.getStringArray(R.array.ball_phrases) }.getOrNull()
        if (arr.isNullOrEmpty()) return "\u2026"
        return arr[Random.nextInt(arr.size)]
    }

    /** 一次性互动: 球缩放一下; 不循环, 空闲零开销 */
    private fun pulse() {
        val v = binding?.bubbleWrap ?: return
        runCatching {
            v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            v.animate().cancel()
            v.scaleX = 1f
            v.scaleY = 1f
            v.animate().scaleX(1.12f).scaleY(1.12f).setDuration(110L)
                .setInterpolator(PathInterpolator(0.2f, 0f, 0.4f, 1f))
                .withEndAction {
                    v.animate().scaleX(1f).scaleY(1f).setDuration(150L)
                        .setInterpolator(PathInterpolator(0.2f, 0f, 0.4f, 1f))
                        .start()
                }
                .start()
        }
    }

    /** 面板里点"实例"一行: 选一个实例, 球和面板立刻换过去 */
    private fun showInstancePicker() {
        scope.launch {
            val backend = app.backend() ?: return@launch
            val r = withContext(Dispatchers.IO) {
                runCatching { backend.getInstances() }.getOrNull()
            } ?: return@launch
            val names = r.instances.map { it.name }.filter { it.isNotBlank() }
            if (names.isEmpty()) return@launch
            val cur = names.indexOf(app.connectionStore.activeInstance)
            runCatching {
                MaterialAlertDialogBuilder(ContextThemeWrapper(this@OverlayService, R.style.Theme_AIGateway))
                    .setTitle(R.string.ovl_instance)
                    .setSingleChoiceItems(names.toTypedArray(), cur) { d, i ->
                        app.connectionStore.activeInstance = names[i]
                        followName = ""
                        pinUntil = SystemClock.elapsedRealtime() + 60_000L
                        d.dismiss()
                        refreshNow()
                    }
                    .create()
                    .also { it.window?.setType(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY) }
                    .show()
            }
        }
    }

    /**
     * 预警: 上下文跨过软/硬上限、余额跌破阈值时各弹一次(静默通知 + 球闪一下)。
     * 边沿触发, 同一事件 10 分钟内只报一次; 切实例后重新校准基线, 不误报。
     */
    private fun checkAlerts() {
        val cx = lastStats?.context
        val lvl = ctxLevel(cx)
        val bal = balShown()
        val bl = balGroupLevel(balGroup(bal))

        if (!alertArmed) {
            alertArmed = true
            prevCtxLvl = lvl
            prevBalLvl = bl
            return
        }
        if (lvl > prevCtxLvl && cx != null && cx.window > 0L && cx.percent != null) {
            val soft = if (cx.soft > 0.0) cx.soft else 80.0
            val hard = if (cx.hard > 0.0) cx.hard else 95.0
            val lim = if (lvl >= 2) hard else soft
            val who = listOf(cx.model, cx.channel,
                lastInstance?.name ?: app.connectionStore.activeInstance)
                .filter { it.isNotBlank() }.joinToString(" \u00b7 ")
            alert(if (lvl >= 2) "ctx2" else "ctx1",
                getString(if (lvl >= 2) R.string.alert_ctx_hard else R.string.alert_ctx_soft),
                who + "\n" + trimNum(cx.percent!!) + "% / " + trimNum(lim) + "%")
        }
        if (bl > prevBalLvl && bal != null) {
            val th = BalanceUtil.threshold(bal.warn, bal.unit, app.settings.balanceWarnBelow)
            alert("bal", getString(R.string.alert_bal),
                balGroupText(balGroup(bal)) + " < " + trimNum(th) +
                    (if (bal.unit.isBlank()) "" else " " + bal.unit))
        }
        prevCtxLvl = lvl
        prevBalLvl = bl
    }

    private fun alert(key: String, title: String, text: String) {
        val now = SystemClock.elapsedRealtime()
        if (now - (lastAlertAt[key] ?: 0L) < 10 * 60_000L) return
        lastAlertAt[key] = now
        runCatching {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val n = NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_power)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .build()
            nm.notify(ALERT_ID_BASE + (alertSeq++ % 16), n)
        }
        pulse()
        say(title)
    }

    /**
     * 常驻通知内容: 收起态一行、展开态三行(软上限 / 硬上限 / 余额), 芯片文本按设置取其中一个。
     * 没数据时退回原来的"悬浮窗运行中"文案。
     */
    private fun updateNotif() {
        val cx = lastStats?.context
        val soft = if ((cx?.soft ?: 0.0) > 0.0) cx!!.soft else 80.0
        val hard = cx?.hard ?: 0.0
        val pct = cx?.percent
        val eq = if (cx?.est == true) "\u2248" else ""
        val hasCtx = cx != null && cx.window > 0L && pct != null
        val softTxt = if (hasCtx) eq + trimNum(pct!! / soft * 100.0) + "%" else null
        val hardTxt = if (hasCtx && hard > 0.0) eq + trimNum(pct!! / hard * 100.0) + "%" else null
        val balTxt = balShown()?.let { balGroupText(balGroup(it)) }

        val title: String
        val text: String
        val big: String?
        if (hasCtx) {
            title = getString(R.string.notif_soft) + " " + softTxt
            text = shortTokens(cx!!.prompt) + " / " + shortTokens(cx.window) +
                (if (cx.channel.isNotBlank()) " \u00b7 " + cx.channel else "")
            val lines = ArrayList<String>(4)
            lines += getString(R.string.notif_soft) + " " + softTxt + "   " +
                shortTokens(cx.prompt) + " / " + shortTokens(cx.window)
            if (hardTxt != null) lines += getString(R.string.notif_hard) + " " + hardTxt
            if (balTxt != null) lines += getString(R.string.notif_bal) + " " + balTxt
            if (cx.model.isNotBlank()) {
                lines += cx.model +
                    (if (cx.channel.isNotBlank()) " \u00b7 " + cx.channel else "") +
                    " \u00b7 " + agoText(cx.at)
            }
            big = lines.joinToString("\n")
        } else {
            title = getString(R.string.ovl_notif_title)
            text = getString(R.string.ovl_notif_desc)
            big = balTxt?.let { getString(R.string.notif_bal) + " " + it }
        }

        val chip: String? = when (app.settings.overlayChip) {
            CHIP_SOFT -> softTxt
            CHIP_HARD -> hardTxt
            CHIP_BALANCE -> balTxt
            else -> null
        }
        val key = title + "|" + text + "|" + big + "|" + chip
        if (key == lastNotifKey) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastNotifAt < 500L) return
        lastNotifKey = key
        lastNotifAt = now
        runCatching {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIF_ID, buildNotification(title, text, big, chip))
        }
    }
}
