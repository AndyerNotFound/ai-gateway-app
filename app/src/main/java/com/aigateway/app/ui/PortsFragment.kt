package com.aigateway.app.ui

import android.content.res.ColorStateList
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.aigateway.app.MainActivity
import com.aigateway.app.R
import com.aigateway.app.data.Instance
import com.google.gson.JsonObject
import com.aigateway.app.databinding.DialogInstanceBinding
import com.aigateway.app.databinding.FragmentPortsBinding
import android.widget.ImageButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class PortsFragment : BaseFragment() {

    private var _b: FragmentPortsBinding? = null
    private val b get() = _b!!
    private val adapter = InstanceAdapter()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentPortsBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        adapter.onAction = { inst, cmd -> doAction(inst, cmd) }
        adapter.onDelete = { confirmDelete(it) }
        adapter.onSelect = { selectInstance(it) }
        adapter.onEdit = { showInstanceDialog(it) }
        b.instanceList.layoutManager = LinearLayoutManager(requireContext())
        b.instanceList.adapter = adapter
        b.btnNewInstance.setOnClickListener { showInstanceDialog(null) }
        b.btnShutdownAll.setOnClickListener { confirmShutdownAll() }
        load()
    }

    private fun load() {
        val backend = backendOrNull() ?: return
        run({ snack(getString(R.string.load_failed, it)) }, { backend.getInstances() }) { resp ->
            adapter.current = resp.current
            adapter.submit(resp.instances)
            loadStats(resp.instances)
        }
    }

    /** 并发拉取各实例统计, 用于卡片上显示请求数(帮助定位哪个实例在被使用) */
    private fun loadStats(instances: List<Instance>) {
        val backend = backendOrNull() ?: return
        viewLifecycleOwner.lifecycleScope.launch {
            val results = withContext(Dispatchers.IO) {
                instances.filter { it.running }.map { inst ->
                    async {
                        inst.name to runCatching { backend.getStats(inst.name) }.getOrNull()
                    }
                }.awaitAll()
            }
            if (!isAdded || _b == null) return@launch
            val map = HashMap<String, Pair<Long, Long>>()
            results.forEach { (name, st) ->
                if (st != null) map[name] = st.requests to st.errors
            }
            adapter.setStats(map)
        }
    }

    private fun loadAfterDelay() {
        viewLifecycleOwner.lifecycleScope.launch {
            delay(1500)
            if (isAdded) load()
        }
    }

    private fun selectInstance(inst: Instance) {
        app.connectionStore.activeInstance = inst.name
        (activity as? MainActivity)?.updateSubtitle()
        toast(getString(R.string.pt_switched, inst.name))
        load()
    }

    private fun doAction(inst: Instance, cmd: String) {
        val backend = backendOrNull() ?: return
        run({ snack(getString(R.string.op_failed, it)) }, { backend.action(inst.name, cmd) }) { r ->
            if (r.ok) toast(r.output.ifBlank { cmd })
            else snack(getString(R.string.op_failed, r.error ?: r.output))
            loadAfterDelay()
        }
    }

    private fun confirmDelete(inst: Instance) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.pt_delete_title)
            .setMessage(getString(R.string.pt_delete_msg, inst.name))
            .setPositiveButton(R.string.delete) { _, _ ->
                val backend = backendOrNull() ?: return@setPositiveButton
                run({ snack(getString(R.string.delete_failed, it)) }, { backend.deleteInstance(inst.name) }) { r ->
                    if (r.ok) {
                        if (app.connectionStore.activeInstance == inst.name) {
                            app.connectionStore.activeInstance = "default"
                        }
                        toast(getString(R.string.pv_deleted)); loadAfterDelay()
                    } else snack(getString(R.string.delete_failed, r.error ?: ""))
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun confirmShutdownAll() {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.pt_shutdown_title)
            .setMessage(R.string.pt_shutdown_msg)
            .setPositiveButton(R.string.pt_shutdown_all) { _, _ ->
                val backend = backendOrNull() ?: return@setPositiveButton
                run({ snack(getString(R.string.op_failed, it)) }, { backend.shutdownAll() }) { r ->
                    toast(if (r.ok) getString(R.string.pt_stopped_all) else getString(R.string.op_failed, r.error ?: ""))
                    loadAfterDelay()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** 新建/编辑实例。existing=null 为新建 */
    private fun showInstanceDialog(existing: Instance?) {
        val db = DialogInstanceBinding.inflate(layoutInflater)
        db.switchTls.setOnCheckedChangeListener { _, on ->
            db.tlsSection.visibility = if (on) View.VISIBLE else View.GONE
        }
        if (existing == null) {
            db.editInstHost.setText("0.0.0.0")
            db.editTlsCert.setText("cert.pem")
            db.editTlsKey.setText("key.pem")
            showDialog(db, null)
        } else {
            // 编辑: 先拉取完整配置(端口/host/TLS/Web Token)
            db.editInstName.setText(existing.name)
            db.editInstName.isEnabled = (existing.name != "default")  // default 主实例不可改名, 其他可改
            db.editInstPort.setText(existing.port.toString())
            val backend = backendOrNull() ?: return
            run({ snack(getString(R.string.load_failed, it)) }, {
                backend.getConfig(existing.name)
            }) { cfg ->
                db.editInstPort.setText(cfg.port.toString())
                db.editInstHost.setText(cfg.host)
                db.editInstKey.setText(cfg.webToken)
                db.switchTls.isChecked = cfg.tls.enable
                db.tlsSection.visibility = if (cfg.tls.enable) View.VISIBLE else View.GONE
                db.editTlsPort.setText(cfg.tls.port?.toString() ?: "")
                db.editTlsCert.setText(cfg.tls.cert)
                db.editTlsKey.setText(cfg.tls.key)
                showDialog(db, existing)
            }
        }
    }

    private fun showDialog(db: DialogInstanceBinding, existing: Instance?) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(if (existing == null) R.string.pt_new_title else R.string.pt_edit_title)
            .setView(db.root)
            .setPositiveButton(if (existing == null) R.string.pt_create else R.string.save) { _, _ ->
                saveInstance(db, existing)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun saveInstance(db: DialogInstanceBinding, existing: Instance?) {
        val name = db.editInstName.text?.toString()?.trim().orEmpty()
        val port = db.editInstPort.text?.toString()?.toIntOrNull() ?: 0
        val host = db.editInstHost.text?.toString()?.trim()?.ifBlank { "0.0.0.0" } ?: "0.0.0.0"
        val key = db.editInstKey.text?.toString()?.trim().orEmpty()
        if (name.isBlank() || port <= 0 || port > 65535) { snack(getString(R.string.pt_need_valid)); return }
        if (existing != null && existing.name == "default" && key.isBlank()) {
            snack(getString(R.string.admin_token_required)); return
        }
        val tlsOn = db.switchTls.isChecked
        val tlsPortTxt = db.editTlsPort.text?.toString()?.trim().orEmpty()
        val tlsPort = tlsPortTxt.toIntOrNull()
        if (tlsOn && tlsPortTxt.isNotEmpty() && (tlsPort == null || tlsPort <= 0 || tlsPort > 65535)) {
            snack(getString(R.string.pt_need_valid)); return
        }
        val tlsJson = JsonObject().apply {
            addProperty("enable", tlsOn)
            addProperty("cert", db.editTlsCert.text?.toString()?.trim()?.ifBlank { "cert.pem" } ?: "cert.pem")
            addProperty("key", db.editTlsKey.text?.toString()?.trim()?.ifBlank { "key.pem" } ?: "key.pem")
            if (tlsPort != null) addProperty("port", tlsPort) else add("port", com.google.gson.JsonNull.INSTANCE)
        }
        val backend = backendOrNull() ?: return
        if (existing == null) {
            // 新建: 先创建, 再补 TLS 配置
            run({ snack(getString(R.string.pt_create_failed, it)) }, {
                backend.createInstance(name, port, key)
            }) { r ->
                if (!r.ok) { snack(getString(R.string.pt_create_failed, r.error ?: "")); return@run }
                val patch = JsonObject().apply { add("tls", tlsJson); addProperty("host", host) }
                run({ snack(getString(R.string.pv_save_failed, it)) }, {
                    backend.saveConfig(name, patch)
                }) { toast(getString(R.string.pt_created, name)); loadAfterDelay() }
            }
        } else {
            val patch = JsonObject().apply {
                addProperty("port", port)
                addProperty("host", host)
                addProperty("webToken", key)
                add("tls", tlsJson)
            }
            run({ snack(getString(R.string.pv_save_failed, it)) }, {
                // 改名: 名字变了先调 rename(热生效), 失败就不再保存
                if (name != existing.name) {
                    val rr = backend.renameInstance(existing.name, name)
                    if (!rr.ok) return@run rr
                }
                backend.saveConfig(name, patch)
            }) { r ->
                if (r.ok) {
                    if (app.connectionStore.activeInstance == existing.name && name != existing.name) {
                        app.connectionStore.activeInstance = name
                    }
                    // default 是 baseUrl 承载实例，只有它的 token 才是本 App 的连接凭据
                    if (existing.name == "default" && key.isNotBlank()) {
                        app.connectionStore.getCurrentProfile()?.let { p ->
                            if (p.webToken != key) {
                                p.webToken = key
                                app.updateRemoteProfile(p)
                            }
                        }
                    }
                    // 主实例开关 TLS 会改变同一端口的协议；不同步 scheme 会立刻连不上
                    if (existing.name == "default" && existing.tlsOn != tlsOn) {
                        app.connectionStore.getCurrentProfile()?.let { p ->
                            val next = if (tlsOn) p.baseUrl.replaceFirst("http://", "https://")
                            else p.baseUrl.replaceFirst("https://", "http://")
                            if (next != p.baseUrl) {
                                p.baseUrl = next
                                app.updateRemoteProfile(p)
                                toast(getString(R.string.admin_tls_url_switched, next))
                            }
                        }
                    }
                    toast(getString(R.string.pt_saved)); loadAfterDelay()
                } else snack(getString(R.string.pv_save_failed, r.error ?: ""))
            }
        }
    }

    // ---------- Adapter ----------

    inner class InstanceAdapter : RecyclerView.Adapter<InstanceAdapter.VH>() {
        var current: String = ""
        var onAction: ((Instance, String) -> Unit)? = null
        var onDelete: ((Instance) -> Unit)? = null
        var onSelect: ((Instance) -> Unit)? = null
        var onEdit: ((Instance) -> Unit)? = null
        private val items = mutableListOf<Instance>()
        /** 实例名 → (请求数, 错误数) */
        private val stats = HashMap<String, Pair<Long, Long>>()

        fun setStats(m: Map<String, Pair<Long, Long>>) {
            stats.clear(); stats.putAll(m); notifyDataSetChanged()
        }

        fun submit(list: List<Instance>) {
            items.clear(); items.addAll(list); notifyDataSetChanged()
        }

        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val dot: View = v.findViewById(R.id.instanceDot)
            val name: TextView = v.findViewById(R.id.instanceName)
            val cur: TextView = v.findViewById(R.id.instanceCurrent)
            val meta: TextView = v.findViewById(R.id.instanceMeta)
            val btnStart: ImageButton = v.findViewById(R.id.btnStart)
            val btnStop: ImageButton = v.findViewById(R.id.btnStop)
            val btnRestart: ImageButton = v.findViewById(R.id.btnRestart)
            val btnEdit: ImageButton = v.findViewById(R.id.btnEditInstance)
            val btnDelete: ImageButton = v.findViewById(R.id.btnDeleteInstance)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_instance, parent, false)
            return VH(v)
        }

        override fun onBindViewHolder(h: VH, position: Int) {
            val inst = items[position]
            // 主题切换后可能存在残留旧配色的回收视图: 每次绑定按当前主题完整重着色
            val cPrimary = resolveColor(com.google.android.material.R.attr.colorPrimary)
            val cOnSurface = resolveColor(com.google.android.material.R.attr.colorOnSurface)
            val cOnSurfaceVariant = resolveColor(com.google.android.material.R.attr.colorOnSurfaceVariant)
            val cSurfaceContainer = resolveColor(com.google.android.material.R.attr.colorSurfaceContainer)
            val cError = resolveColor(com.google.android.material.R.attr.colorError)
            (h.itemView as? com.google.android.material.card.MaterialCardView)
                ?.setCardBackgroundColor(cSurfaceContainer)
            h.cur.setTextColor(cPrimary)
            h.meta.setTextColor(cOnSurfaceVariant)
            h.btnStart.imageTintList = ColorStateList.valueOf(cPrimary)
            h.btnStop.imageTintList = ColorStateList.valueOf(cPrimary)
            h.btnRestart.imageTintList = ColorStateList.valueOf(cPrimary)
            h.btnEdit.imageTintList = ColorStateList.valueOf(cPrimary)
            h.btnDelete.imageTintList = ColorStateList.valueOf(cError)

            h.name.text = inst.name
            h.cur.visibility = if (inst.name == current) View.VISIBLE else View.GONE
            val st = stats[inst.name]
            val reqPart = when {
                st == null -> ""
                st.first > 0 -> " · " + getString(R.string.pt_req_count, st.first) +
                        (if (st.second > 0) "/" + getString(R.string.pt_err_count, st.second) else "")
                else -> " · " + getString(R.string.pt_no_traffic)
            }
            h.meta.text = ":${inst.port} · ${getString(R.string.pt_channels, inst.chCount)}" +
                    (if (inst.tlsOn) " · TLS" else "") +
                    (if (!inst.pathPrefix.isNullOrBlank()) " · ${inst.pathPrefix}/v1" else "") + reqPart
            // 有流量的实例名用主色强调, 方便一眼定位
            val hasTraffic = (st?.first ?: 0L) > 0L
            h.name.setTextColor(if (hasTraffic) cPrimary else cOnSurface)
            val dotColor = ContextCompat.getColor(requireContext(),
                if (inst.running) android.R.color.holo_green_dark else android.R.color.holo_red_dark)
            h.dot.backgroundTintList = ColorStateList.valueOf(dotColor)
            h.btnStart.isEnabled = !inst.running
            h.btnStart.alpha = if (inst.running) 0.35f else 1f
            h.btnStop.isEnabled = inst.running
            h.btnStop.alpha = if (inst.running) 1f else 0.35f
            h.btnStart.setOnClickListener { onAction?.invoke(inst, "start") }
            h.btnStop.setOnClickListener { onAction?.invoke(inst, "stop") }
            h.btnRestart.setOnClickListener { onAction?.invoke(inst, "restart") }
            h.btnEdit.setOnClickListener { onEdit?.invoke(inst) }
            h.btnDelete.setOnClickListener { onDelete?.invoke(inst) }
            h.itemView.setOnClickListener { onSelect?.invoke(inst) }
        }

        override fun getItemCount(): Int = items.size

        private fun resolveColor(attr: Int): Int {
            val ta = requireContext().theme.obtainStyledAttributes(intArrayOf(attr))
            val c = ta.getColor(0, 0); ta.recycle(); return c
        }
    }

    /** 基类在实例/连接变化时调用 */
    override fun reload() {
        if (_b != null) load()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
