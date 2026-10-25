package com.aigateway.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.aigateway.app.MainActivity
import com.aigateway.app.R
import com.aigateway.app.sdui.SduiData
import com.aigateway.app.sdui.SduiRenderer
import com.google.android.material.color.MaterialColors
import com.google.gson.JsonObject

/**
 * SDUI 页面宿主：拉 /admin/api/ui/<page> → 原生渲染。
 * 页面不存在/JSON 出错/渲染异常 → 显示原因 + 重试，且（若由路由接管）可一键回退到原生页。
 */
class SduiFragment : BaseFragment() {

    /** 在顶部往下拉 70dp 触发刷新；不消费手势，正常滚动不受影响 */
    private class PullHost(
        ctx: android.content.Context,
        child: View,
        private val onPull: () -> Unit
    ) : FrameLayout(ctx) {
        private var downY = 0f
        private var armed = false

        init {
            addView(child, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        }

        override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downY = ev.rawY
                    armed = true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (armed && ev.rawY - downY > 70 * resources.displayMetrics.density) {
                        armed = false
                        onPull()
                    }
                }
                else -> armed = false
            }
            return false
        }
    }

    companion object {
        private const val ARG_PAGE = "page"
        private const val ARG_NATIVE = "native"
        fun newInstance(page: String, nativeTag: String? = null): SduiFragment =
            SduiFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_PAGE, page)
                    putString(ARG_NATIVE, nativeTag)
                }
            }
    }

    private val page: String get() = requireArguments().getString(ARG_PAGE) ?: ""
    private val nativeTag: String? get() = requireArguments().getString(ARG_NATIVE)
    private var content: LinearLayout? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val scroll = ScrollView(requireContext()).apply { isFillViewport = true }
        val box = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            val p = dp(16)
            setPadding(p, p, p, p)
        }
        scroll.addView(box, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        content = box
        // 下拉刷新：SwipeRefreshLayout 的依赖不在离线缓存里，这里自己拦 20 行
        return PullHost(requireContext(), scroll) { if (scroll.scrollY == 0) reload() }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
    }

    override fun reload() {
        if (isAdded && view != null) load()
    }

    private fun load() {
        val box = content ?: return
        val backend = backendOrNull() ?: run {
            fail(box, getString(R.string.sdui_no_backend))
            return
        }
        box.removeAllViews()
        if (nativeTag == null) box.addView(hint(getString(R.string.sdui_loading)))
        android.util.Log.i("SduiFragment", "load page=$page")
        val inst = app.connectionStore.activeInstance
        run({ e ->
            android.util.Log.w("SduiFragment", "fetch failed: $e")
            fail(box, e)
        }, {
            // 页面描述 + 页面声明的数据，一次取齐；数据源与「实例/渠道配置」同一个接口
            val pageJson = backend.getUiPage(page)
            val data = SduiData.load(backend, pageJson.getAsJsonObject("data"), inst)
            pageJson to data
        }) { (pageJson, data) ->
            box.removeAllViews()
            android.util.Log.i("SduiFragment", "data keys=${data.keySet()}")
            val j = mergeState(pageJson, data, inst)
            runCatching {
                SduiRenderer(
                    requireContext(), j, ::onAction,
                    imgLoader = { p -> kotlinx.coroutines.runBlocking { backend.fetchBytes(p) } }
                ).render()
            }
                .onSuccess {
                    android.util.Log.i("SduiFragment", "rendered page=$page childCount=${(it as? android.view.ViewGroup)?.childCount}")
                    val texts = collectText(it)
                    // 单条截断: 日志页 150 行拼起来会超过 logcat 单行上限，整条被丢掉
                    android.util.Log.i(
                        "SduiFragment",
                        "texts(" + texts.size + ")=" + texts.take(30).map { it.take(40) }
                    )
                    // 落一份最近渲染结果, 便于不用截图就能核对 JSON 改对没有
                    runCatching {
                        java.io.File(requireContext().filesDir, "sdui_last.txt")
                            .writeText("page=$page\n" + texts.joinToString("\n"))
                    }
                    box.addView(it)
                }
                .onFailure {
                    android.util.Log.w("SduiFragment", "render failed: ${it::class.java.name}: ${it.message}\n" + it.stackTraceToString().take(1200))
                    fail(box, it.message ?: getString(R.string.sdui_bad_page))
                }
        }
    }

    // ---------- 动作 ----------

    private fun onAction(act: JsonObject) {
        when (val type = act.get("type")?.takeIf { it.isJsonPrimitive }?.asString ?: "") {
            "reload" -> load()
            "copy" -> {
                val t = act.get("text")?.takeIf { it.isJsonPrimitive }?.asString ?: ""
                val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("sdui", t))
                toast(act.get("toast")?.asString ?: getString(R.string.sdui_copied))
            }
            "open" -> {
                val t = act.get("target")?.takeIf { it.isJsonPrimitive }?.asString ?: return
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(t))) }
                    .onFailure { snack(getString(R.string.sdui_no_handler, t)) }
            }
            "intent" -> {
                val ep = act.get("endpoint")?.takeIf { it.isJsonPrimitive }?.asString ?: return
                if (!ep.startsWith("/admin/api/")) {
                    snack(getString(R.string.sdui_bad_endpoint))
                    return
                }
                val backend = backendOrNull() ?: return
                val body = act.getAsJsonObject("body") ?: JsonObject()
                run({ e -> snack(e) }, { backend.postUi(ep, body) }) { r ->
                    r.get("toast")?.takeIf { it.isJsonPrimitive }?.asString?.let { toast(it) }
                    val then = act.get("then")?.takeIf { it.isJsonPrimitive }?.asString
                    if (then == "reload") load()
                }
            }
            "toast" -> toast(act.get("text")?.asString ?: "")
            else -> snack(getString(R.string.sdui_bad_action, type))
        }
    }

    // ---------- 失败态 ----------

    private fun fail(box: LinearLayout, msg: String) {
        // 由路由接管的页：拉不到/渲染失败就直接换回原生，用户不该看到一张错误页
        val routed = nativeTag
        if (!routed.isNullOrBlank()) {
            android.util.Log.w("SduiFragment", "fallback to native: $routed ($msg)")
            view?.post { (activity as? MainActivity)?.openSecondaryNative(routed) }
            return
        }
        box.removeAllViews()
        box.addView(TextView(requireContext()).apply {
            text = msg
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError, 0xFFFF5252.toInt()))
        })
        box.addView(button(getString(R.string.sdui_retry)) { load() })
        val tag = nativeTag
        if (!tag.isNullOrBlank()) {
            box.addView(button(getString(R.string.sdui_back_native)) {
                (activity as? MainActivity)?.openSecondaryNative(tag)
            })
        }
    }

    private fun hint(t: String): TextView = TextView(requireContext()).apply {
        text = t
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant, 0xFF888888.toInt()))
    }

    private fun button(t: String, onClick: () -> Unit): View = TextView(requireContext()).apply {
        text = t
        gravity = Gravity.CENTER
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setPadding(dp(14), dp(9), dp(14), dp(9))
        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorPrimary, 0xFF8888FF.toInt()))
        isClickable = true
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8) }
    }

    /** 页面自带的 state 作为常量底座，实时数据覆盖同名键 */
    private fun mergeState(pageJson: JsonObject, data: JsonObject, inst: String): JsonObject {
        val out = pageJson.deepCopy()
        val state = out.getAsJsonObject("state")?.deepCopy() ?: JsonObject()
        if (!state.has("inst")) state.addProperty("inst", inst)
        for ((k, v) in data.entrySet()) state.add(k, v)
        out.add("state", state)
        return out
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /** 渲染结果自检: 把树里的文本抽出来打一条日志, 便于确认模板替换是否生效 */
    private fun collectText(v: View, out: MutableList<String> = mutableListOf()): List<String> {
        if (v is TextView && v.visibility == View.VISIBLE) v.text?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
        if (v is ViewGroup) for (i in 0 until v.childCount) collectText(v.getChildAt(i), out)
        return out
    }
}
