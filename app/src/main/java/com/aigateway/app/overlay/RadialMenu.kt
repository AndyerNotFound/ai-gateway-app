package com.aigateway.app.overlay

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.PopupWindow
import android.widget.TextView
import com.google.gson.JsonObject
import kotlin.math.cos
import kotlin.math.sin

/** 围绕球的一圈动作按钮；点空白处关闭 */
class RadialMenu(
    private val ctx: Context,
    private val items: List<BallUi.RadialItem>,
    private val radiusPx: Int,
    private val onPick: (JsonObject?) -> Unit
) {
    private var pop: PopupWindow? = null

    /**
     * 用 showAsDropDown 定位：坐标是「相对锚点视图」的，不是屏幕绝对坐标。
     * 之前用 showAtLocation + 屏幕坐标，PopupWindow 作为子窗口会再叠加一次窗口原点，
     * 表现为整圈按钮被推到屏幕下方。
     */
    fun show(anchor: View, anchorW: Int, anchorH: Int) {
        val d = ctx.resources.displayMetrics.density
        val btn = (46 * d).toInt()
        val size = radiusPx * 2 + btn + (8 * d).toInt()
        val box = FrameLayout(ctx).apply { isClickable = true; setOnClickListener { dismiss() } }
        val n = items.size.coerceAtLeast(1)
        items.forEachIndexed { i, item ->
            val a = Math.toRadians(-90.0 + 360.0 / n * i)
            val cx = (size / 2f + radiusPx * cos(a)).toInt() - btn / 2
            val cy = (size / 2f + radiusPx * sin(a)).toInt() - btn / 2
            val tv = TextView(ctx).apply {
                text = item.label.take(4)
                textSize = 11f
                gravity = Gravity.CENTER
                setTextColor(0xFFFFFFFF.toInt())
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(0xE61A1C22.toInt())
                    setStroke((1 * d).toInt(), 0x66FFFFFF)
                }
                setOnClickListener {
                    dismiss()
                    onPick(item.action)
                }
            }
            box.addView(tv, FrameLayout.LayoutParams(btn, btn).apply {
                leftMargin = cx
                topMargin = cy
            })
        }
        val pw = PopupWindow(box, size, size, true).apply {
            setBackgroundDrawable(null)
            isOutsideTouchable = true
            setOnDismissListener { pop = null }
        }
        pop = pw
        // 目标：弹窗中心 = 锚点中心
        // showAsDropDown 把弹窗左上角放在锚点左下角 + (xoff, yoff)
        val xoff = anchorW / 2 - size / 2
        val yoff = -anchorH / 2 - size / 2
        runCatching { pw.showAsDropDown(anchor, xoff, yoff) }.onFailure { pw.dismiss() }
    }

    fun dismiss() {
        runCatching { pop?.dismiss() }
        pop = null
    }
}
