package com.aigateway.app.ui

import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.RadioGroup
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentOverlayLookBinding
import com.aigateway.app.overlay.OverlayLook
import com.aigateway.app.overlay.OverlayService
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.slider.Slider
import kotlin.math.roundToInt

/**
 * 悬浮窗的唯一入口: 开关 + 形态 + 尺寸 + 配色 + 显示内容(可排序)。
 * 行为类开关(吸附/变淡/锁定/常驻展开/模糊)在窗内齿轮面板里。
 */
class OverlayLookFragment : BaseFragment() {

    private var _b: FragmentOverlayLookBinding? = null
    private val b get() = _b!!

    private data class RowDef(val bit: Int, val label: Int)

    private val rows = listOf(
        RowDef(OverlayService.ROW_MODE, R.string.ovl_mode),
        RowDef(OverlayService.ROW_INSTANCE, R.string.ovl_instance),
        RowDef(OverlayService.ROW_PORT, R.string.ovl_port),
        RowDef(OverlayService.ROW_REQUESTS, R.string.ovl_requests),
        RowDef(OverlayService.ROW_ERRORS, R.string.ovl_errors),
        RowDef(OverlayService.ROW_UPTIME, R.string.ovl_uptime),
        RowDef(OverlayService.ROW_BALANCE, R.string.ovl_balance)
    )

    private val order = mutableListOf<Int>()
    private var syncing = false

    private val pickIcon =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
            if (uri == null) return@registerForActivityResult
            runCatching {
                requireContext().contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
            }
            app.settings.overlayIconUri = uri.toString()
            app.settings.overlayPill = OverlayService.PILL_ICON
            b.rbIcon.isChecked = true
            syncIcon()
            push()
        }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentOverlayLookBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val s = app.settings

        // ---- 开关 ----
        b.swEnable.setOnCheckedChangeListener { _, on ->
            if (syncing) return@setOnCheckedChangeListener
            val ctx = requireContext()
            if (on && !OverlayService.canShow(ctx)) {
                syncing = true
                b.swEnable.isChecked = false
                syncing = false
                MaterialAlertDialogBuilder(ctx)
                    .setTitle(R.string.ovl_perm_title)
                    .setMessage(R.string.ovl_perm_msg)
                    .setPositiveButton(R.string.ok) { _, _ -> OverlayService.openPermissionSettings(ctx) }
                    .setNegativeButton(R.string.cancel, null)
                    .show()
                return@setOnCheckedChangeListener
            }
            s.overlayEnabled = on
            if (on) OverlayService.start(ctx) else OverlayService.stop(ctx)
            b.tvState.postDelayed({ if (isAdded) syncEnable() }, 400)
        }
        syncEnable()
        viewLifecycleOwner.lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onResume(owner: LifecycleOwner) = syncEnable()
        })

        // ---- 形态 ----
        when (s.overlayShape) {
            OverlayService.SHAPE_PILL -> b.rbPill.isChecked = true
            OverlayService.SHAPE_SQUARE -> b.rbSquare.isChecked = true
            OverlayService.SHAPE_ROUND -> b.rbRound.isChecked = true
            else -> b.rbCircle.isChecked = true
        }
        b.rgShape.setOnCheckedChangeListener { _: RadioGroup, id: Int ->
            s.overlayShape = when (id) {
                R.id.rbPill -> OverlayService.SHAPE_PILL
                R.id.rbSquare -> OverlayService.SHAPE_SQUARE
                R.id.rbRound -> OverlayService.SHAPE_ROUND
                else -> OverlayService.SHAPE_CIRCLE
            }
            push()
        }

        // ---- 自定义图案 ----
        b.btnPickIcon.setOnClickListener {
            runCatching { pickIcon.launch(arrayOf("image/*")) }
        }
        b.btnClearIcon.setOnClickListener {
            s.overlayIconUri = ""
            syncIcon()
            push()
        }
        syncIcon()

        // ---- 尺寸 ----
        b.sliderSize.apply {
            valueFrom = 40f
            valueTo = 88f
            stepSize = 2f
            value = s.overlaySizeDp.coerceIn(40, 88).toFloat()
            b.tvSize.text = getString(R.string.ovl_size) + "  " + value.roundToInt() + "dp"
            addOnChangeListener { _, v, _ ->
                b.tvSize.text = getString(R.string.ovl_size) + "  " + v.roundToInt() + "dp"
            }
            addOnSliderTouchListener(object : Slider.OnSliderTouchListener {
                override fun onStartTrackingTouch(slider: Slider) = Unit
                override fun onStopTrackingTouch(slider: Slider) {
                    s.overlaySizeDp = slider.value.roundToInt()
                    push()
                }
            })
        }

        b.sliderPanelW.apply {
            valueFrom = 240f
            valueTo = 340f
            stepSize = 4f
            value = s.overlayPanelDp.coerceIn(240, 340).toFloat()
            b.tvPanelW.text = getString(R.string.ovl_panel_width) + "  " + value.roundToInt() + "dp"
            addOnChangeListener { _, v, _ ->
                b.tvPanelW.text = getString(R.string.ovl_panel_width) + "  " + v.roundToInt() + "dp"
            }
            addOnSliderTouchListener(object : Slider.OnSliderTouchListener {
                override fun onStartTrackingTouch(slider: Slider) = Unit
                override fun onStopTrackingTouch(slider: Slider) {
                    s.overlayPanelDp = slider.value.roundToInt()
                    push()
                }
            })
        }

        // ---- 自动轮播 ----
        b.swAutoScroll.isChecked = s.overlayAutoScroll
        b.swAutoScroll.setOnCheckedChangeListener { _, on ->
            s.overlayAutoScroll = on
            push()
        }

        b.sliderScrollSec.apply {
            valueFrom = 2f
            valueTo = 30f
            stepSize = 1f
            value = s.overlayScrollSec.coerceIn(2, 30).toFloat()
            b.tvScrollSec.text = getString(R.string.ovl_scroll_sec) + "  " + value.roundToInt() + "s"
            addOnChangeListener { _, v, _ ->
                b.tvScrollSec.text = getString(R.string.ovl_scroll_sec) + "  " + v.roundToInt() + "s"
            }
            addOnSliderTouchListener(object : Slider.OnSliderTouchListener {
                override fun onStartTrackingTouch(slider: Slider) = Unit
                override fun onStopTrackingTouch(slider: Slider) {
                    s.overlayScrollSec = slider.value.roundToInt()
                    push()
                }
            })
        }

        // ---- 变暗: 延时 + 程度 ----
        b.sliderDimDelay.apply {
            valueFrom = 1f
            valueTo = 10f
            stepSize = 1f
            value = s.overlayDimSec.coerceIn(1, 10).toFloat()
            b.tvDimDelay.text = getString(R.string.ovl_dim_delay) + "  " + value.roundToInt() + "s"
            addOnChangeListener { _, v, _ ->
                b.tvDimDelay.text = getString(R.string.ovl_dim_delay) + "  " + v.roundToInt() + "s"
            }
            addOnSliderTouchListener(object : Slider.OnSliderTouchListener {
                override fun onStartTrackingTouch(slider: Slider) = Unit
                override fun onStopTrackingTouch(slider: Slider) {
                    s.overlayDimSec = slider.value.roundToInt()
                    push()
                }
            })
        }

        b.sliderDimLevel.apply {
            valueFrom = 10f
            valueTo = 90f
            stepSize = 5f
            value = s.overlayDimAlpha.coerceIn(10, 90).toFloat()
            b.tvDimLevel.text = getString(R.string.ovl_dim_level) + "  " + value.roundToInt() + "%"
            addOnChangeListener { _, v, _ ->
                b.tvDimLevel.text = getString(R.string.ovl_dim_level) + "  " + v.roundToInt() + "%"
            }
            addOnSliderTouchListener(object : Slider.OnSliderTouchListener {
                override fun onStartTrackingTouch(slider: Slider) = Unit
                override fun onStopTrackingTouch(slider: Slider) {
                    s.overlayDimAlpha = slider.value.roundToInt()
                    push()
                }
            })
        }

        // ---- 气泡内容 ----
        when (s.overlayPill) {
            OverlayService.PILL_BALANCE -> b.rbBalance.isChecked = true
            OverlayService.PILL_REQUESTS -> b.rbRequests.isChecked = true
            else -> b.rbIcon.isChecked = true
        }
        b.rgPill.setOnCheckedChangeListener { _: RadioGroup, id: Int ->
            s.overlayPill = when (id) {
                R.id.rbBalance -> OverlayService.PILL_BALANCE
                R.id.rbRequests -> OverlayService.PILL_REQUESTS
                else -> OverlayService.PILL_ICON
            }
            push()
        }

        // ---- 状态栏芯片(Android 16 Live Update) ----
        when (s.overlayChip) {
            OverlayService.CHIP_SOFT -> b.rbChipSoft.isChecked = true
            OverlayService.CHIP_HARD -> b.rbChipHard.isChecked = true
            OverlayService.CHIP_BALANCE -> b.rbChipBal.isChecked = true
            else -> b.rbChipOff.isChecked = true
        }
        b.rgChip.setOnCheckedChangeListener { _: RadioGroup, id: Int ->
            s.overlayChip = when (id) {
                R.id.rbChipSoft -> OverlayService.CHIP_SOFT
                R.id.rbChipHard -> OverlayService.CHIP_HARD
                R.id.rbChipBal -> OverlayService.CHIP_BALANCE
                else -> OverlayService.CHIP_OFF
            }
            push()
        }

        // ---- 配色 ----
        fillSwatches()

        // ---- 余额预警 ----
        fun warnLabel(v: Float): String {
            val n = v.roundToInt()
            return getString(R.string.ovl_warn_below) + "  " + if (n == 0) "off" else n.toString()
        }
        b.sliderWarn.apply {
            valueFrom = 0f
            valueTo = 100f
            stepSize = 5f
            value = s.balanceWarnBelow.toFloat().coerceIn(0f, 100f)
            b.tvWarn.text = warnLabel(value)
            addOnChangeListener { _, v, _ -> b.tvWarn.text = warnLabel(v) }
            addOnSliderTouchListener(object : Slider.OnSliderTouchListener {
                override fun onStartTrackingTouch(slider: Slider) = Unit
                override fun onStopTrackingTouch(slider: Slider) {
                    s.balanceWarnBelow = slider.value.toDouble()
                    push()
                }
            })
        }

        // ---- 指示环 / 条 ----
        b.sliderGaugeW.apply {
            valueFrom = 60f
            valueTo = 200f
            stepSize = 5f
            value = s.overlayGaugeWidth.coerceIn(60, 200).toFloat()
            b.tvGaugeW.text = getString(R.string.ovl_gauge_w) + "  " + value.roundToInt() + "%"
            addOnChangeListener { _, v, _ ->
                b.tvGaugeW.text = getString(R.string.ovl_gauge_w) + "  " + v.roundToInt() + "%"
            }
            addOnSliderTouchListener(object : Slider.OnSliderTouchListener {
                override fun onStartTrackingTouch(slider: Slider) = Unit
                override fun onStopTrackingTouch(slider: Slider) {
                    s.overlayGaugeWidth = slider.value.roundToInt()
                    push()
                }
            })
        }
        fillGaugeSwatches()

        // ---- 条目(可排序) ----
        order.clear()
        order += currentOrder()
        buildRows()
    }

    override fun reload() = Unit

    // ---------- 开关 ----------

    private fun syncEnable() {
        if (_b == null) return
        val ctx = requireContext()
        val can = OverlayService.canShow(ctx)
        val on = app.settings.overlayEnabled && can
        syncing = true
        b.swEnable.isChecked = on
        syncing = false
        b.tvState.text = when {
            !app.settings.overlayEnabled -> getString(R.string.st_overlay_off)
            !can -> getString(R.string.st_overlay_need_perm)
            else -> getString(R.string.st_overlay_on)
        }
    }

    // ---------- 图案 ----------

    private fun syncIcon() {
        val uri = app.settings.overlayIconUri
        if (uri.isBlank()) {
            b.ivIcon.visibility = View.GONE
            b.btnClearIcon.isEnabled = false
            b.btnClearIcon.alpha = 0.4f
        } else {
            b.ivIcon.visibility = View.VISIBLE
            b.btnClearIcon.isEnabled = true
            b.btnClearIcon.alpha = 1f
            runCatching { b.ivIcon.setImageURI(Uri.parse(uri)) }
        }
    }

    // ---------- 条目排序 ----------

    private fun currentOrder(): List<Int> {
        val all = rows.map { it.bit }
        val parsed = app.settings.overlayRowsOrder.split(',')
            .mapNotNull { it.trim().toIntOrNull() }
            .filter { it in all }
            .distinct()
        return parsed + all.filter { it !in parsed }
    }

    private fun buildRows() {
        val box = b.rowsBox
        box.removeAllViews()
        val s = app.settings
        order.forEachIndexed { idx, bit ->
            val def = rows.first { it.bit == bit }
            val row = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            }
            val sw = MaterialSwitch(requireContext()).apply {
                setText(def.label)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                isChecked = if (bit == OverlayService.ROW_BALANCE) {
                    s.overlayBalanceRow
                } else {
                    s.overlayRows and bit != 0
                }
                setOnClickListener {
                    if (bit == OverlayService.ROW_BALANCE) {
                        s.overlayBalanceRow = isChecked
                    } else {
                        s.overlayRows = if (isChecked) s.overlayRows or bit
                        else s.overlayRows and bit.inv()
                    }
                    push()
                }
            }
            row.addView(sw)
            row.addView(arrow("↑", idx > 0) { move(idx, -1) })
            row.addView(arrow("↓", idx < order.size - 1) { move(idx, 1) })
            box.addView(row)
        }
    }

    private fun arrow(symbol: String, enabled: Boolean, onClick: () -> Unit): TextView {
        val d = resources.displayMetrics.density
        val pad = (10 * d).toInt()
        return TextView(requireContext()).apply {
            text = symbol
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
            alpha = if (enabled) 1f else 0.25f
            isClickable = true
            setOnClickListener { if (enabled) onClick() }
        }
    }

    private fun move(idx: Int, delta: Int) {
        val j = idx + delta
        if (j !in order.indices) return
        val tmp = order[idx]
        order[idx] = order[j]
        order[j] = tmp
        app.settings.overlayRowsOrder = order.joinToString(",")
        buildRows()
        push()
    }

    // ---------- 配色 ----------

    private fun fillSwatches() {
        val row = b.swatchRow
        row.removeAllViews()
        val d = resources.displayMetrics.density
        val selected = app.settings.overlayBg
        OverlayLook.BGS.forEach { color ->
            val on = color == selected
            val size = ((if (on) 30 else 24) * d).toInt()
            val dot = View(requireContext())
            dot.background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                if (color == 0) {
                    setColor(0x00000000)
                    setStroke((1.5f * d).toInt(), 0x8AFFFFFF.toInt())
                } else {
                    setColor(color)
                }
                if (on) setStroke((2.5f * d).toInt(), 0xFFFFFFFF.toInt())
            }
            val lp = LinearLayout.LayoutParams(size, size)
            lp.marginEnd = (10 * d).toInt()
            lp.gravity = Gravity.CENTER_VERTICAL
            dot.layoutParams = lp
            dot.setOnClickListener {
                app.settings.overlayBg = color
                fillSwatches()
                push()
            }
            row.addView(dot)
        }
    }

    private fun fillGaugeSwatches() {
        val row = b.gaugeSwatchRow
        row.removeAllViews()
        val d = resources.displayMetrics.density
        val selected = app.settings.overlayGaugeColor
        OverlayLook.GAUGES.forEach { color ->
            val on = color == selected
            val size = ((if (on) 30 else 24) * d).toInt()
            val dot = View(requireContext())
            dot.background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                if (color == 0) {
                    setColor(0x00000000)
                    setStroke((1.5f * d).toInt(), 0x8AFFFFFF.toInt())
                } else {
                    setColor(color)
                }
                if (on) setStroke((2.5f * d).toInt(), 0xFFFFFFFF.toInt())
            }
            val lp = LinearLayout.LayoutParams(size, size)
            lp.marginEnd = (10 * d).toInt()
            lp.gravity = Gravity.CENTER_VERTICAL
            dot.layoutParams = lp
            dot.setOnClickListener {
                app.settings.overlayGaugeColor = color
                fillGaugeSwatches()
                push()
            }
            row.addView(dot)
        }
    }

    private fun push() {
        runCatching { OverlayService.apply(requireContext()) }
    }
}
