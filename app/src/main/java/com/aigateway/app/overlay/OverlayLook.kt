package com.aigateway.app.overlay

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import java.util.WeakHashMap

/**
 * 悬浮窗外观工具。
 *
 * [applyScale] 首次调用时记录每个 View 的原始字号/内边距/固定宽高, 之后按同一份基准重算,
 * 因此反复拖动滑块不会累积放大(做法沿用 balance-float 的 Ui.applyScale)。
 */
object OverlayLook {

    private data class Base(
        val textSize: Float,
        val padL: Int, val padT: Int, val padR: Int, val padB: Int,
        val width: Int, val height: Int,
        val marginL: Int, val marginT: Int, val marginR: Int, val marginB: Int,
        val minWidth: Int, val minHeight: Int
    )

    private val baseDims = WeakHashMap<View, Base>()

    /** 预设底色; 0 = 跟随主题。都带 alpha, 叠在玻璃底上。 */
    val BGS: List<Int> = listOf(
        0,
        0xF2101218.toInt(),
        0xF2161B24.toInt(),
        0xF23A3F49.toInt(),
        0xF2142338.toInt(),
        0xF21F1830.toInt()
    )

    /** 指示环/条的预设色; 0 = 跟随主题(正常态) */
    val GAUGES: List<Int> = listOf(
        0,
        0xFFFFFFFF.toInt(),
        0xFF4DD0E1.toInt(),
        0xFF4CAF50.toInt(),
        0xFFFFC107.toInt(),
        0xFFFF7043.toInt(),
        0xFFE91E63.toInt(),
        0xFFB388FF.toInt()
    )

    /** 按比例缩放整棵视图树: 字号 / padding / 固定宽高 / margin / 最小尺寸 */
    fun applyScale(root: View, scale: Float) {
        val s = scale.coerceIn(0.7f, 1.6f)

        fun walk(v: View) {
            val lp = v.layoutParams
            val b = baseDims.getOrPut(v) {
                val m = lp as? ViewGroup.MarginLayoutParams
                Base(
                    textSize = (v as? TextView)?.textSize ?: 0f,
                    padL = v.paddingLeft, padT = v.paddingTop,
                    padR = v.paddingRight, padB = v.paddingBottom,
                    width = lp?.width ?: 0, height = lp?.height ?: 0,
                    marginL = m?.leftMargin ?: 0, marginT = m?.topMargin ?: 0,
                    marginR = m?.rightMargin ?: 0, marginB = m?.bottomMargin ?: 0,
                    minWidth = v.minimumWidth, minHeight = v.minimumHeight
                )
            }

            (v as? TextView)?.let {
                if (b.textSize > 0f) it.setTextSize(TypedValue.COMPLEX_UNIT_PX, b.textSize * s)
            }
            v.setPadding(
                (b.padL * s).toInt(), (b.padT * s).toInt(),
                (b.padR * s).toInt(), (b.padB * s).toInt()
            )
            if (b.minWidth > 0) v.minimumWidth = (b.minWidth * s).toInt()
            if (b.minHeight > 0) v.minimumHeight = (b.minHeight * s).toInt()

            if (lp != null) {
                if (b.width > 0) lp.width = (b.width * s).toInt()
                if (b.height > 0) lp.height = (b.height * s).toInt()
                if (lp is ViewGroup.MarginLayoutParams) {
                    lp.leftMargin = (b.marginL * s).toInt()
                    lp.topMargin = (b.marginT * s).toInt()
                    lp.rightMargin = (b.marginR * s).toInt()
                    lp.bottomMargin = (b.marginB * s).toInt()
                }
                v.layoutParams = lp
            }

            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(root)
    }

    /** 圆角纯色底, 保留 1dp 的 15% 白描边(与内置卡片一致) */
    fun roundedBg(ctx: Context, color: Int, radiusDp: Float): GradientDrawable {
        val d = ctx.resources.displayMetrics.density
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(color)
            cornerRadius = radiusDp * d
            setStroke((1 * d).toInt().coerceAtLeast(1), 0x26FFFFFF)
        }
    }
}
