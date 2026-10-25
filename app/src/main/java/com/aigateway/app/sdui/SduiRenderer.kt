package com.aigateway.app.sdui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.widget.doAfterTextChanged
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import androidx.core.content.getSystemService
import com.google.android.material.card.MaterialCardView
import com.google.android.material.color.MaterialColors
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive

/**
 * gcui 子集渲染器：服务端 JSON → 原生 View。
 *
 * 支持：column / row / card / text / kv / divider / spacer / progress / list / button。
 * 动作：reload / copy / open / intent。
 * 颜色只认主题令牌（"$primary" 等）；裸 hex 会被忽略并记一条日志 —— 远程 JSON 不该能指定任意颜色。
 * 未知组件一律跳过并记录，不抛异常：服务端升级不能把旧 APK 的页面搞崩。
 */
class SduiRenderer(
    private val ctx: Context,
    private val page: JsonObject,
    private val onAction: (JsonObject) -> Unit,
    private val imgLoader: ((String) -> ByteArray?)? = null
) {

    private val main = Handler(Looper.getMainLooper())

    private val state = page.getAsJsonObject("state")
    private val inputs = mutableMapOf<String, JsonElement>()
    private val scope = SduiScope(state = state, inputs = inputs)

    fun render(): View {
        val root = page.getAsJsonObject("root")
            ?: throw IllegalArgumentException("页面缺少 root")
        return build(root, scope) ?: TextView(ctx).apply { text = "（空页面）" }
    }

    private fun build(node: JsonObject, sc: SduiScope): View? {
        if (SduiScope.bool(node, "visible", sc, true) == false) return null
        return when (val t = SduiScope.str(node, "type", sc, "") ?: "") {
            "column" -> stack(node, sc, vertical = true)
            "row" -> stack(node, sc, vertical = false)
            "card" -> card(node, sc)
            "text" -> label(node, sc)
            "kv" -> kv(node, sc)
            "divider" -> View(ctx).apply {
                setBackgroundColor(color(SduiScope.str(node, "color", sc), ATTR_OUTLINE))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
            }
            "spacer" -> View(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(SduiScope.num(node, "height", sc, 8f)!!.toInt())
                )
            }
            "input" -> input(node, sc)
            "switch" -> switch(node, sc)
            "progress" -> progress(node, sc)
            "list" -> list(node, sc)
            "table" -> table(node, sc)
            "tabs" -> tabs(node, sc)
            "badge" -> badge(node, sc)
            "stat" -> stat(node, sc)
            "grid" -> grid(node, sc)
            "image" -> image(node, sc)
            "button" -> button(node, sc)
            else -> {
                Log.w(TAG, "跳过未知组件 type=$t")
                null
            }
        }
    }

    /** 节点自带 action 时可点（卡片 / 文本 / 行）；不改变原有布局 */
    private fun bindAction(v: View, node: JsonObject, sc: SduiScope) {
        val act = node.getAsJsonObject("action") ?: return
        v.isClickable = true
        v.isFocusable = true
        v.setOnClickListener {
            onAction((SduiScope.deep(act, sc) as? JsonObject) ?: act)
        }
    }

    // ---------- 容器 ----------

    private fun stack(node: JsonObject, sc: SduiScope, vertical: Boolean): LinearLayout {
        val box = LinearLayout(ctx).apply {
            orientation = if (vertical) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            gravity = if (vertical) Gravity.TOP else Gravity.CENTER_VERTICAL
        }
        val gap = dp(SduiScope.num(node, "gap", sc, 0f)!!.toInt())
        val children = node.getAsJsonArray("children") ?: JsonArray()
        var added = 0
        for (el in children) {
            val child = el as? JsonObject ?: continue
            val v = build(child, sc) ?: continue
            val lp = v.layoutParams as? LinearLayout.LayoutParams
                ?: LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            SduiScope.num(child, "weight", sc)?.let { if (it > 0f) lp.weight = it }
            if (added > 0 && gap > 0) {
                if (vertical) lp.topMargin = gap else lp.leftMargin = gap
            }
            v.layoutParams = lp
            box.addView(v)
            added++
        }
        return box
    }

    private fun card(node: JsonObject, sc: SduiScope): MaterialCardView {
        val c = MaterialCardView(ctx).apply {
            radius = dp(SduiScope.num(node, "radius", sc, 18f)!!.toInt()).toFloat()
            cardElevation = dp(SduiScope.num(node, "elevation", sc, 0f)!!.toInt()).toFloat()
            setCardBackgroundColor(color(SduiScope.str(node, "bg", sc), ATTR_SURFACE_HIGH))
            strokeWidth = dp(1)
            strokeColor = color(null, ATTR_OUTLINE)
            val pad = SduiScope.num(node, "padding", sc, null)?.toInt()?.let { dp(it) }
            setContentPadding(pad ?: dp(16), pad ?: dp(14), pad ?: dp(16), pad ?: dp(14))
        }
        bindAction(c, node, sc)
        val inner = node.getAsJsonArray("children")
        if (inner != null) {
            val box = stack(node, sc, vertical = true)
            c.addView(box)
        } else {
            c.addView(TextView(ctx).apply { text = "（空卡片）" })
        }
        return c
    }

    // ---------- 叶子 ----------

    private fun label(node: JsonObject, sc: SduiScope): TextView {
        val style = SduiScope.str(node, "style", sc, "body")
        val tv = TextView(ctx).apply {
            text = SduiScope.str(node, "text", sc, "") ?: ""
            if (SduiScope.num(node, "size", sc) != null) {
                setTextSize(TypedValue.COMPLEX_UNIT_SP, SduiScope.num(node, "size", sc)!!)
            }
        }
        when (style) {
            "title" -> {
                tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
                tv.setTypeface(Typeface.DEFAULT, Typeface.BOLD)
                tv.setTextColor(color(SduiScope.str(node, "color", sc), ATTR_ON_SURFACE))
            }
            "caption" -> {
                tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                tv.setTextColor(color(SduiScope.str(node, "color", sc), ATTR_ON_SURFACE_VARIANT))
            }
            "mono" -> {
                tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                tv.typeface = Typeface.MONOSPACE
                tv.setTextColor(color(SduiScope.str(node, "color", sc), ATTR_ON_SURFACE))
            }
            else -> {
                tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                tv.setTextColor(color(SduiScope.str(node, "color", sc), ATTR_ON_SURFACE))
            }
        }
        tone(SduiScope.str(node, "tone", sc, null))?.let { tv.setTextColor(it) }
        if (SduiScope.bool(node, "bold", sc, false) == true) tv.setTypeface(tv.typeface, Typeface.BOLD)
        when (SduiScope.str(node, "align", sc, null)) {
            "center" -> tv.gravity = Gravity.CENTER_HORIZONTAL
            "end" -> tv.gravity = Gravity.END
        }
        if (node.has("action")) {
            bindAction(tv, node, sc)
            tv.setTextColor(color(null, ATTR_PRIMARY))
            tv.paintFlags = tv.paintFlags or android.graphics.Paint.UNDERLINE_TEXT_FLAG
        }
        return tv
    }

    private fun kv(node: JsonObject, sc: SduiScope): LinearLayout {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val k = TextView(ctx).apply {
            text = SduiScope.str(node, "label", sc, "") ?: ""
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(color(null, ATTR_ON_SURFACE_VARIANT))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val v = TextView(ctx).apply {
            text = SduiScope.str(node, "value", sc, "") ?: ""
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            typeface = Typeface.MONOSPACE
            setTextColor(color(null, ATTR_ON_SURFACE))
            gravity = Gravity.END
        }
        tone(SduiScope.str(node, "tone", sc, null))?.let { v.setTextColor(it) }
        row.addView(k)
        row.addView(v)
        return row
    }

    private fun progress(node: JsonObject, sc: SduiScope): LinearProgressIndicator {
        val max = SduiScope.num(node, "max", sc, 100f)!!.coerceAtLeast(1f)
        val value = SduiScope.num(node, "value", sc, 0f)!!.coerceIn(0f, max)
        return LinearProgressIndicator(ctx).apply {
            this.max = max.toInt()
            this.progress = value.toInt()
            trackCornerRadius = dp(4)
            setIndicatorColor(color(SduiScope.str(node, "color", sc), ATTR_PRIMARY))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
    }

    private fun list(node: JsonObject, sc: SduiScope): LinearLayout {
        val box = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val arr = itemsOf(node, sc)
        val tpl = node.getAsJsonObject("template") ?: return box
        val gap = dp(SduiScope.num(node, "gap", sc, 8f)!!.toInt())
        var added = 0
        for (el in arr) {
            // 允许纯字符串数组（如 logs.lines）：包成 {value,text} 供 {{item.value}} 使用
            val item = when {
                el.isJsonObject -> el.asJsonObject
                el.isJsonPrimitive -> JsonObject().apply {
                    add("value", el)
                    add("text", el)
                }
                else -> continue
            }
            val v = build(tpl, SduiScope(state = state, item = item, inputs = inputs)) ?: continue
            val lp = v.layoutParams as? LinearLayout.LayoutParams
                ?: LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            if (added > 0) lp.topMargin = gap
            v.layoutParams = lp
            bindAction(v, tpl, SduiScope(state = state, item = item, inputs = inputs))
            box.addView(v)
            added++
        }
        if (added == 0) {
            box.addView(TextView(ctx).apply {
                text = SduiScope.str(node, "empty", sc, "（无数据）") ?: "（无数据）"
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                setTextColor(color(null, ATTR_ON_SURFACE_VARIANT))
            })
        }
        return box
    }

    /** items 可直接给数组，也可给 "{{state.xxx}}" 引用；解析不到就是空列表 */
    private fun itemsOf(node: JsonObject, sc: SduiScope, key: String = "items"): JsonArray {
        val e = node.get(key)
        if (e == null || e.isJsonNull) return JsonArray()
        if (!e.isJsonPrimitive) return asArray(e)
        val raw = e.asString.trim()
        val ref = if (raw.startsWith("{{")) raw.removePrefix("{{").removeSuffix("}}").trim() else raw
        return asArray(sc.lookup(ref) ?: state?.get(ref))
    }

    /** 数组照用；对象映射会被摊成 [{key, ...字段}]，好让 byChannel 这类结构也能进表格 */
    private fun asArray(el: JsonElement?): JsonArray {
        if (el == null || el.isJsonNull) return JsonArray()
        if (el.isJsonArray) return el.asJsonArray
        if (!el.isJsonObject) return JsonArray()
        return JsonArray().apply {
            for ((k, v) in el.asJsonObject.entrySet()) {
                add(JsonObject().apply {
                    addProperty("key", k)
                    if (v.isJsonObject) v.asJsonObject.entrySet().forEach { (kk, vv) -> add(kk, vv) }
                    else add("value", v)
                })
            }
        }
    }

    private fun button(node: JsonObject, sc: SduiScope): View {
        val style = SduiScope.str(node, "style", sc, "filled")
        val text = SduiScope.str(node, "text", sc, "") ?: ""
        val tv = TextView(ctx).apply {
            this.text = text
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(dp(14), dp(9), dp(14), dp(9))
            isClickable = true
            isFocusable = true
        }
        when (style) {
            "outlined" -> {
                tv.background = com.aigateway.app.overlay.OverlayLook.roundedBg(
                    ctx, 0x00000000, 20f
                ).apply { setStroke(dp(1), color(null, ATTR_OUTLINE)) }
                tv.setTextColor(color(null, ATTR_PRIMARY))
            }
            "tonal" -> {
                tv.background = com.aigateway.app.overlay.OverlayLook.roundedBg(
                    ctx, color(null, ATTR_SECONDARY_CONTAINER), 20f
                )
                tv.setTextColor(color(null, ATTR_ON_SECONDARY_CONTAINER))
            }
            else -> {
                tv.background = com.aigateway.app.overlay.OverlayLook.roundedBg(
                    ctx, color(null, ATTR_PRIMARY), 20f
                )
                tv.setTextColor(color(null, ATTR_ON_PRIMARY))
            }
        }
        node.getAsJsonObject("action")?.let { act ->
            tv.setOnClickListener {
                // 动作体里的 {{input.x}} 在这里求值：整串模板保留类型（布尔/数字不下沉成字符串）
                onAction((SduiScope.deep(act, sc) as? JsonObject) ?: act)
            }
        }
        return tv
    }

    /** 文本输入：值写进 inputs[key]，键名由 JSON 指定 */
    private fun input(node: JsonObject, sc: SduiScope): View {
        val key = SduiScope.str(node, "key", sc, "") ?: ""
        val label = SduiScope.str(node, "label", sc, "")
        val hint = SduiScope.str(node, "hint", sc, "")
        // 注意: 不能叫 type——那是组件类型本身; 用 inputType 区分 text/number/password
        val type = SduiScope.str(node, "inputType", sc, "text") ?: "text"
        val seed = inputs[key]?.let { SduiScope.plain(it) } ?: (SduiScope.str(node, "value", sc, "") ?: "")

        val til = TextInputLayout(ctx).apply {
            this.hint = label ?: hint
            isHintEnabled = !(label.isNullOrBlank() && hint.isNullOrBlank())
        }
        val et = TextInputEditText(ctx).apply {
            setSingleLine()
            inputType = when (type) {
                "number" -> InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or
                    InputType.TYPE_NUMBER_FLAG_SIGNED
                "password" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                else -> InputType.TYPE_CLASS_TEXT
            }
            setText(seed)
            if (!hint.isNullOrBlank() && label.isNullOrBlank()) this.hint = hint
        }
        inputs[key] = JsonPrimitive(seed)
        et.doAfterTextChanged { inputs[key] = JsonPrimitive(it?.toString() ?: "") }
        til.addView(
            et,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        )
        return til
    }

    /** 开关：值写进 inputs[key]，类型是布尔 */
    private fun switch(node: JsonObject, sc: SduiScope): View {
        val key = SduiScope.str(node, "key", sc, "") ?: ""
        val label = SduiScope.str(node, "label", sc, "")
        val seed = inputs[key]
            ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean
            ?: (SduiScope.bool(node, "checked", sc, false) ?: false)
        val sw = MaterialSwitch(ctx).apply {
            text = label
            isChecked = seed
        }
        inputs[key] = JsonPrimitive(seed)
        sw.setOnCheckedChangeListener { _, on -> inputs[key] = JsonPrimitive(on) }
        return sw
    }

    // ---------- 表格 / 标签页 / 徽标 / 图片 ----------

    /** 语义色只有这五档 —— 远程给不了任意色值，也就没法做视觉欺骗 */
    private fun tone(c: String?): Int? = when (c) {
        "ok" -> 0xFF43A047.toInt()
        "warn" -> 0xFFFB8C00.toInt()
        "danger" -> 0xFFE53935.toInt()
        "info" -> 0xFF29B6F6.toInt()
        "muted" -> MaterialColors.getColor(ctx, ATTR_ON_SURFACE_VARIANT, 0xFF888888.toInt())
        null, "", "default" -> null
        else -> {
            Log.w(TAG, "未知 tone=$c")
            null
        }
    }

    private fun badge(node: JsonObject, sc: SduiScope): TextView {
        val label = SduiScope.str(node, "text", sc, "") ?: ""
        var seed = SduiScope.str(node, "tone", sc, "default")
        node.getAsJsonObject("toneMap")?.get(label)?.takeIf { it.isJsonPrimitive }?.asString?.let { seed = it }
        val t = tone(seed)
            ?: MaterialColors.getColor(ctx, ATTR_ON_SURFACE_VARIANT, 0xFF888888.toInt())
        val rgb = t and 0x00FFFFFF
        return TextView(ctx).apply {
            text = label
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setTextColor(t)
            setPadding(dp(8), dp(2), dp(8), dp(2))
            background = com.aigateway.app.overlay.OverlayLook.roundedBg(ctx, rgb or 0x22000000, 20f)
                .apply { setStroke(dp(1), rgb or 0x55000000) }
        }
    }

    /** 数字磁贴：大数字 + 小标签，仪表盘用 */
    private fun stat(node: JsonObject, sc: SduiScope): View {
        val value = SduiScope.str(node, "value", sc, "") ?: ""
        val unit = SduiScope.str(node, "unit", sc, null)
        val t = tone(SduiScope.str(node, "tone", sc, null)) ?: color(null, ATTR_ON_SURFACE)
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(13), dp(11), dp(13), dp(11))
            background = com.aigateway.app.overlay.OverlayLook.roundedBg(
                ctx, color(null, ATTR_SURFACE_HIGH), 15f
            )
        }
        col.addView(TextView(ctx).apply {
            text = if (unit != null) "$value $unit" else value
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 21f)
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(t)
            isSingleLine = true
            ellipsize = android.text.TextUtils.TruncateAt.END
        })
        col.addView(TextView(ctx).apply {
            text = SduiScope.str(node, "label", sc, "") ?: ""
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setTextColor(color(null, ATTR_ON_SURFACE_VARIANT))
        })
        if (node.has("action")) bindAction(col, node, sc)
        return col
    }

    /** 等宽网格：children 按 columns 折行，每格等宽 */
    private fun grid(node: JsonObject, sc: SduiScope): LinearLayout {
        val cols = (SduiScope.num(node, "columns", sc, 2f) ?: 2f).toInt().coerceIn(1, 4)
        val gap = dp(SduiScope.num(node, "gap", sc, 10f)!!.toInt())
        val box = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        var row: LinearLayout? = null
        var i = 0
        for (el in node.getAsJsonArray("children") ?: JsonArray()) {
            val c = el as? JsonObject ?: continue
            if (i % cols == 0) {
                row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                box.addView(row, LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { if (i > 0) topMargin = gap })
            }
            val v = build(c, sc) ?: continue
            val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
            if (i % cols != 0) lp.leftMargin = gap
            row?.addView(v, lp)
            i++
        }
        return box
    }

    private fun table(node: JsonObject, sc: SduiScope): LinearLayout {
        val box = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val cols = node.getAsJsonArray("columns") ?: JsonArray()
        val rows = itemsOf(node, sc, "rows")
        val gap = dp(SduiScope.num(node, "gap", sc, 6f)!!.toInt())
        val weightOf = { col: JsonObject -> SduiScope.num(col, "weight", sc, 1f) ?: 1f }

        if (cols.size() > 0) {
            val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
            for (el in cols) {
                val col = el as? JsonObject ?: continue
                head.addView(TextView(ctx).apply {
                    text = SduiScope.str(col, "label", sc, null)
                        ?: (SduiScope.str(col, "key", sc, "") ?: "")
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                    setTextColor(color(null, ATTR_ON_SURFACE_VARIANT))
                    layoutParams = LinearLayout.LayoutParams(
                        0, ViewGroup.LayoutParams.WRAP_CONTENT, weightOf(col)
                    )
                })
            }
            box.addView(head)
            box.addView(View(ctx).apply {
                setBackgroundColor(color(null, ATTR_OUTLINE))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
            })
        }

        var added = 0
        for (el in rows) {
            val item = el as? JsonObject ?: continue
            val isc = SduiScope(state = state, item = item, inputs = inputs)
            val tr = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(6), 0, dp(6))
            }
            for (cel in cols) {
                val col = cel as? JsonObject ?: continue
                val key = SduiScope.str(col, "key", sc, "") ?: ""
                val raw = item.get(key)
                val via = SduiScope.str(col, "via", sc, null)
                var txt = ""
                var tn = SduiScope.str(col, "tone", sc, null)
                when {
                    via != null -> txt = SduiScope.text(via, isc)
                    raw == null -> txt = ""
                    raw.isJsonObject -> {
                        val o = raw.asJsonObject
                        txt = SduiScope.str(o, "text", isc, null) ?: SduiScope.plain(raw)
                        SduiScope.str(o, "tone", isc, null)?.let { tn = it }
                    }
                    else -> txt = SduiScope.plain(raw)
                }
                // 列级 toneMap: 精确值 -> 前缀（"4xx"）-> 列默认 tone
                col.getAsJsonObject("toneMap")?.let { m ->
                    val hit = m.get(txt)?.takeIf { it.isJsonPrimitive }?.asString
                        ?: m.entrySet().firstOrNull { txt.startsWith(it.key) }
                            ?.takeIf { it.value.isJsonPrimitive }?.value?.asString
                    if (hit != null) tn = hit
                }
                tr.addView(TextView(ctx).apply {
                    text = txt
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                    setTextColor(tone(tn) ?: color(null, ATTR_ON_SURFACE))
                    isSingleLine = true
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    layoutParams = LinearLayout.LayoutParams(
                        0, ViewGroup.LayoutParams.WRAP_CONTENT, weightOf(col)
                    )
                })
            }
            if (cols.size() > 0) {
                node.getAsJsonObject("rowAction")?.let { ra ->
                    bindAction(tr, JsonObject().apply { add("action", ra) }, isc)
                }
                box.addView(tr)
                if (added > 0 && gap > 0) {
                    (tr.layoutParams as LinearLayout.LayoutParams).topMargin = gap
                }
                added++
            }
        }
        Log.i(TAG, "table cols=${cols.size()} rows=$added")
        if (added == 0) {
            box.addView(TextView(ctx).apply {
                text = SduiScope.str(node, "empty", sc, "（无数据）") ?: "（无数据）"
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                setTextColor(color(null, ATTR_ON_SURFACE_VARIANT))
            })
        }
        return box
    }

    /** 自包含标签页：切页只换自己的 children，不跨组件联动 */
    private fun tabs(node: JsonObject, sc: SduiScope): View {
        val key = SduiScope.str(node, "key", sc, "tab") ?: "tab"
        val items = node.getAsJsonArray("items") ?: JsonArray()
        val outer = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        if (items.size() == 0) return outer

        val seed = inputs[key]
            ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asInt ?: 0
        var cur = seed.coerceIn(0, items.size() - 1)
        val chips = mutableListOf<TextView>()
        val strip = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        val body = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }

        fun paint() {
            chips.forEachIndexed { i, tv ->
                val on = i == cur
                tv.background = com.aigateway.app.overlay.OverlayLook.roundedBg(
                    ctx,
                    if (on) color(null, ATTR_SECONDARY_CONTAINER) else 0x00000000,
                    18f
                ).apply { if (!on) setStroke(dp(1), color(null, ATTR_OUTLINE)) }
                tv.setTextColor(
                    if (on) color(null, ATTR_ON_SECONDARY_CONTAINER) else color(null, ATTR_ON_SURFACE_VARIANT)
                )
            }
        }

        fun show(i: Int) {
            cur = i
            inputs[key] = JsonPrimitive(i)
            body.removeAllViews()
            val o = items.get(i) as? JsonObject
            o?.getAsJsonArray("children")?.forEach { c ->
                (c as? JsonObject)?.let { n -> build(n, sc)?.let { body.addView(it) } }
            }
            paint()
        }

        for (i in 0 until items.size()) {
            val o = items.get(i) as? JsonObject ?: continue
            val tv = TextView(ctx).apply {
                text = SduiScope.str(o, "label", sc, "") ?: ""
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                setPadding(dp(12), dp(6), dp(12), dp(6))
                isClickable = true
                setOnClickListener { show(i) }
            }
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
            if (i > 0) lp.leftMargin = dp(8)
            tv.layoutParams = lp
            chips.add(tv)
            strip.addView(tv)
        }

        outer.addView(android.widget.HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            addView(strip)
        })
        outer.addView(
            body,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        )
        show(cur)
        return outer
    }

    /** 只允许内联 base64 或网关同源路径；外链一律拒绝并留日志 */
    private fun image(node: JsonObject, sc: SduiScope): View {
        val src = SduiScope.str(node, "src", sc, "") ?: ""
        val h = dp(SduiScope.num(node, "height", sc, 140f)!!.toInt())
        val iv = ImageView(ctx).apply {
            scaleType = when (SduiScope.str(node, "fit", sc, "centerCrop")) {
                "fitCenter" -> ImageView.ScaleType.FIT_CENTER
                "fitXY" -> ImageView.ScaleType.FIT_XY
                else -> ImageView.ScaleType.CENTER_CROP
            }
            setBackgroundColor(color(null, ATTR_SURFACE_HIGH))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, h)
        }
        val loader = imgLoader
        when {
            src.startsWith("data:image/") -> {
                val b64 = src.substringAfter("base64,", "")
                Thread {
                    decode(runCatching {
                        android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
                    }.getOrNull(), iv)
                }.start()
            }
            src.startsWith("/") && loader != null -> Thread {
                decode(runCatching { loader(src) }.getOrNull(), iv)
            }.start()
            else -> {
                Log.w(TAG, "image 拒绝 $src（只允许 data:image base64 或 /同源路径）")
                return TextView(ctx).apply {
                    text = "（图片已拒绝：非内联、非同源）"
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                    setTextColor(color(null, ATTR_ON_SURFACE_VARIANT))
                }
            }
        }
        return iv
    }

    private fun decode(bytes: ByteArray?, iv: ImageView) {
        if (bytes == null || bytes.isEmpty() || bytes.size > 4 * 1024 * 1024) {
            Log.w(TAG, "image 跳过 size=${bytes?.size}")
            return
        }
        val bmp = runCatching {
            val probe = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, probe)
            var s = 1
            while (probe.outWidth / s > 1600 || probe.outHeight / s > 1600) s *= 2
            BitmapFactory.decodeByteArray(
                bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = s }
            )
        }.getOrNull()
        if (bmp == null) {
            Log.w(TAG, "image 解码失败")
            return
        }
        Log.i(TAG, "image ok ${bmp.width}x${bmp.height} ${bytes.size}B")
        main.post { iv.setImageBitmap(bmp) }
    }

    // ---------- 颜色 / 尺寸 ----------

    /** 只接受主题令牌；未识别的裸色值一律回落并记录 */
    private fun color(token: String?, attr: Int): Int {
        if (token.isNullOrBlank()) return MaterialColors.getColor(ctx, attr, 0xFF888888.toInt())
        if (!token.startsWith("$")) {
            Log.w(TAG, "忽略裸色值 $token（只允许主题令牌）")
            return MaterialColors.getColor(ctx, attr, 0xFF888888.toInt())
        }
        return MaterialColors.getColor(ctx, when (token) {
            "\$primary" -> ATTR_PRIMARY
            "\$onPrimary" -> ATTR_ON_PRIMARY
            "\$surface" -> ATTR_SURFACE
            "\$surfaceVariant" -> ATTR_SURFACE_HIGH
            "\$onSurface" -> ATTR_ON_SURFACE
            "\$onSurfaceVariant" -> ATTR_ON_SURFACE_VARIANT
            "\$error" -> ATTR_ERROR
            "\$outline" -> ATTR_OUTLINE
            else -> {
                Log.w(TAG, "未知颜色令牌 $token")
                attr
            }
        }, 0xFF888888.toInt())
    }

    private fun dp(v: Int): Int = (v * ctx.resources.displayMetrics.density).toInt()

    companion object {
        private const val TAG = "SduiRenderer"
        private val ATTR_PRIMARY = com.google.android.material.R.attr.colorPrimary
        private val ATTR_ON_PRIMARY = com.google.android.material.R.attr.colorOnPrimary
        private val ATTR_SURFACE = com.google.android.material.R.attr.colorSurface
        private val ATTR_SURFACE_HIGH = com.google.android.material.R.attr.colorSurfaceContainerHigh
        private val ATTR_ON_SURFACE = com.google.android.material.R.attr.colorOnSurface
        private val ATTR_ON_SURFACE_VARIANT = com.google.android.material.R.attr.colorOnSurfaceVariant
        private val ATTR_ERROR = com.google.android.material.R.attr.colorError
        private val ATTR_OUTLINE = com.google.android.material.R.attr.colorOutline
        private val ATTR_SECONDARY_CONTAINER = com.google.android.material.R.attr.colorSecondaryContainer
        private val ATTR_ON_SECONDARY_CONTAINER = com.google.android.material.R.attr.colorOnSecondaryContainer
    }
}
