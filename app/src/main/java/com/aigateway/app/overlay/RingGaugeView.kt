package com.aigateway.app.overlay

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View

/**
 * 悬浮球的三个指示位(固定槽位, 缺数据只留空, 避免跳动):
 *   1 = 上下文占用 / 软上限
 *   2 = 上下文占用 / 硬上限
 *   3 = 余额预警(整圈, 只表状态)
 *
 * 两种画法:
 *   RINGS —— 圆/胶囊球: 三圈贴着球的外形画(胶囊就是胶囊, 不是椭圆)
 *   BARS  —— 方/圆角方球: 三条横条画在球左或右侧的留白里(由上到下)
 */
class RingGaugeView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    /** progress 0..1; color 前景; track 底环/底条 */
    data class Ring(val progress: Float, val color: Int, val track: Int)

    /** 顺序 = 由外到内；长度不限（视觉上 4 圈是上限） */
    private var rings: Array<Ring?> = emptyArray()

    private var bars = false

    /** 条带贴哪一侧: -1 左 / 1 右(仅 BARS 生效) */
    private var side = 1

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }
    private val solid = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val path = Path()
    private val seg = Path()
    private val pm = PathMeasure()
    private val rect = RectF()
    private val d = resources.displayMetrics.density

    private var stroke = 2.4f * d
    private var gap = 2f * d
    private var barThick = 4f * d
    private var strip = 28f * d
    private val edge = 1f * d

    fun setRings(soft: Ring?, hard: Ring?, bal: Ring?) = setRingList(listOf(soft, hard, bal))

    fun setRingList(list: List<Ring?>) {
        val next = list.toTypedArray()
        if (next.contentEquals(rings)) return
        rings = next
        invalidate()
    }

    fun setMode(useBars: Boolean, barSide: Int) {
        if (useBars == bars && barSide == side) return
        bars = useBars
        side = barSide
        invalidate()
    }

    /** stroke/gap: 圈宽与圈距; thick: 条厚; stripW: 条带宽度; 0 表示该模式不用 */
    fun setMetrics(strokePx: Float, gapPx: Float, thickPx: Float, stripW: Float) {
        if (strokePx == stroke && gapPx == gap && thickPx == barThick && stripW == strip) return
        stroke = strokePx.coerceAtLeast(0.5f)
        gap = gapPx.coerceAtLeast(0.5f)
        barThick = thickPx.coerceAtLeast(1f)
        strip = stripW.coerceAtLeast(1f)
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val list = rings
        if (list.isEmpty() || list.all { it == null }) return
        if (bars) drawBars(canvas, list) else drawRings(canvas, list)
    }

    private fun drawRings(canvas: Canvas, list: Array<Ring?>) {
        paint.strokeWidth = stroke
        var inset = edge + stroke / 2f
        for (r in list) {
            val l = inset
            val t = inset
            val rr = width - inset
            val bb = height - inset
            if (r != null && rr - l > stroke * 2f && bb - t > stroke * 2f) {
                buildCapsule(l, t, rr, bb)
                paint.color = r.track
                canvas.drawPath(path, paint)
                // 大于 0 就至少画出一点点, 否则 0.1% 和 0 看起来一样
                val raw = r.progress.coerceIn(0f, 1f)
                val sweep = if (raw > 0f) maxOf(raw, 0.012f) else 0f
                if (sweep > 0f) {
                    pm.setPath(path, false)
                    val len = pm.length
                    if (len > 0f) {
                        seg.reset()
                        pm.getSegment(0f, len * sweep, seg, true)
                        paint.color = r.color
                        canvas.drawPath(seg, paint)
                    }
                }
            }
            inset += stroke + gap
        }
    }

    /**
     * 球外形的等距外扩线。圆 → 圆; 胶囊 → 胶囊。
     * 从顶边中点起顺时针, 进度 0 在正上方。
     */
    private fun buildCapsule(l: Float, t: Float, r: Float, b: Float) {
        path.reset()
        val rad = minOf((b - t) / 2f, (r - l) / 2f)
        if (rad <= 0f) return
        val cy = (t + b) / 2f
        path.moveTo((l + r) / 2f, cy - rad)
        path.lineTo(r - rad, cy - rad)
        path.arcTo(r - rad * 2f, cy - rad, r, cy + rad, -90f, 180f, false)
        path.lineTo(l + rad, cy + rad)
        path.arcTo(l, cy - rad, l + rad * 2f, cy + rad, 90f, 180f, false)
        path.close()
    }

    private fun drawBars(canvas: Canvas, list: Array<Ring?>) {
        val step = barThick * 1.85f
        val total = barThick + step * (list.size - 1).coerceAtLeast(0)
        var top = (height - total) / 2f
        val x0 = if (side < 0) edge else width - strip + edge
        val x1 = if (side < 0) strip - edge else width - edge
        if (x1 - x0 < barThick) return
        val radius = barThick / 2f
        for (r in list) {
            if (r != null) {
                rect.set(x0, top, x1, top + barThick)
                solid.color = r.track
                canvas.drawRoundRect(rect, radius, radius, solid)
                val raw = r.progress.coerceIn(0f, 1f)
                val w = (x1 - x0) * raw
                if (raw > 0f) {
                    rect.set(x0, top, x0 + w.coerceAtLeast(barThick), top + barThick)
                    solid.color = r.color
                    canvas.drawRoundRect(rect, radius, radius, solid)
                }
            }
            top += step
        }
    }
}
