#!/usr/bin/env python3
"""ai-gateway-app 多实例化适配: 实例/渠道改名 + pathPrefix 显示"""
import sys
BASE = '/workspace/ai-gateway-app/app/src/main/java/com/aigateway/app'

def patch(fname, pairs):
    f = f'{BASE}/{fname}'
    src = open(f, encoding='utf8').read()
    for tag, old, new, n in pairs:
        c = src.count(old)
        if c != n:
            print(f'FAIL [{fname}#{tag}] 期望{n}处, 实际{c}处')
            return False
        src = src.replace(old, new)
    open(f, 'w', encoding='utf8').write(src)
    print(f'OK {fname} ({len(pairs)} 处)')
    return True

ok = True

# ============ 1. Models.kt ============
ok &= patch('data/Models.kt', [
    ('instance-prefix', '''    val tlsOn: Boolean = false,
    val current: Boolean = false
)''', '''    val tlsOn: Boolean = false,
    val current: Boolean = false,
    val pathPrefix: String? = null
)''', 1),
    ('instances-multi', '''data class InstancesResponse(
    val instances: List<Instance> = emptyList(),
    val current: String = ""
)''', '''data class InstancesResponse(
    val instances: List<Instance> = emptyList(),
    val current: String = "",
    val multi: Boolean = false,
    val mainPort: Int = 0
)''', 1),
    ('channel-oldname', '''    val hasKey: Boolean = false,
    val keyPrefix: String? = null
)''', '''    val hasKey: Boolean = false,
    val keyPrefix: String? = null,
    val oldName: String? = null   // 改名时=原渠道名(仅请求用, Gson 默认跳过 null)
)''', 1),
])

# ============ 2. GatewayBackend.kt ============
ok &= patch('data/GatewayBackend.kt', [
    ('iface-rename', '''    suspend fun deleteInstance(name: String): ActionResult''',
     '''    suspend fun deleteInstance(name: String): ActionResult
    suspend fun renameInstance(name: String, newName: String): ActionResult''', 1),
])

# ============ 3. RemoteBackend.kt ============
ok &= patch('net/RemoteBackend.kt', [
    ('remote-rename', '''    override suspend fun deleteInstance(name: String): ActionResult =
        withContext(Dispatchers.IO) { delete("/admin/api/instance/${enc(name)}").toActionResult() }''',
     '''    override suspend fun deleteInstance(name: String): ActionResult =
        withContext(Dispatchers.IO) { delete("/admin/api/instance/${enc(name)}").toActionResult() }

    override suspend fun renameInstance(name: String, newName: String): ActionResult =
        withContext(Dispatchers.IO) {
            val p = JsonObject().apply { addProperty("newName", newName) }
            post("/admin/api/instance-rename/${enc(name)}", p).toActionResult()
        }''', 1),
])

# ============ 4. EmbeddedBackend.kt ============
ok &= patch('embedded/EmbeddedBackend.kt', [
    ('emb-rename', '''    override suspend fun deleteInstance(name: String): ActionResult =
        ActionResult(ok = false, error = "应用内运行模式不可删除实例")''',
     '''    override suspend fun deleteInstance(name: String): ActionResult =
        ActionResult(ok = false, error = "应用内运行模式不可删除实例")

    override suspend fun renameInstance(name: String, newName: String): ActionResult =
        ActionResult(ok = false, error = "应用内运行模式仅支持单个实例, 无需改名")''', 1),
    ('emb-savechannel-oldname', '''            engine.updateConfig { cur ->
                val list = cur.channels.toMutableList()
                if (channel.default) list.replaceAll { it.copy(default = false) }
                val idx = list.indexOfFirst { it.name == channel.name }
                // apiKey 为空且已存在 → 保留原 key
                val merged = if (idx >= 0 && channel.apiKey.isBlank()) channel.copy(apiKey = list[idx].apiKey) else channel
                if (idx >= 0) list[idx] = merged else list.add(merged)
                cur.copy(channels = list)
            }''',
     '''            engine.updateConfig { cur ->
                val list = cur.channels.toMutableList()
                if (channel.default) list.replaceAll { it.copy(default = false) }
                // 改名: 有 oldName 且与新名不同 → 找原渠道位置替换(apiKey 为空则保留原 key)
                val oldIdx = if (!channel.oldName.isNullOrBlank() && channel.oldName != channel.name)
                    list.indexOfFirst { it.name == channel.oldName } else -1
                val idx = if (oldIdx >= 0) oldIdx else list.indexOfFirst { it.name == channel.name }
                val merged = if (idx >= 0 && channel.apiKey.isBlank()) channel.copy(apiKey = list[idx].apiKey, oldName = null) else channel.copy(oldName = null)
                if (idx >= 0) list[idx] = merged else list.add(merged)
                cur.copy(channels = list)
            }''', 1),
])

# ============ 5. PortsFragment.kt ============
ok &= patch('ui/PortsFragment.kt', [
    ('ports-name-editable', '''            db.editInstName.setText(existing.name)
            db.editInstName.isEnabled = false''',
     '''            db.editInstName.setText(existing.name)
            db.editInstName.isEnabled = (existing.name != "default")  // default 主实例不可改名, 其他可改''', 1),
    ('ports-save-rename', '''            run({ snack(getString(R.string.pv_save_failed, it)) }, {
                backend.saveConfig(name, patch)
            }) { r ->
                if (r.ok) { toast(getString(R.string.pt_saved)); loadAfterDelay() }
                else snack(getString(R.string.pv_save_failed, r.error ?: ""))
            }''',
     '''            run({ snack(getString(R.string.pv_save_failed, it)) }, {
                // 改名: 名字变了先调 rename(热生效), 再用新名保存配置
                if (name != existing.name) backend.renameInstance(existing.name, name)
                backend.saveConfig(name, patch)
            }) { r ->
                if (r.ok) { toast(getString(R.string.pt_saved)); loadAfterDelay() }
                else snack(getString(R.string.pv_save_failed, r.error ?: ""))
            }''', 1),
    ('ports-meta-prefix', '''            h.meta.text = ":${inst.port} · ${getString(R.string.pt_channels, inst.chCount)}" +
                    (if (inst.tlsOn) " · TLS" else "") + reqPart''',
     '''            h.meta.text = ":${inst.port} · ${getString(R.string.pt_channels, inst.chCount)}" +
                    (if (inst.tlsOn) " · TLS" else "") +
                    (if (!inst.pathPrefix.isNullOrBlank()) " · ${inst.pathPrefix}/v1" else "") + reqPart''', 1),
])

# ============ 6. ProvidersFragment.kt ============
ok &= patch('ui/ProvidersFragment.kt', [
    ('pv-name-editable', '''            db.editName.setText(existing.name)
            db.editName.isEnabled = false''',
     '''            db.editName.setText(existing.name)
            // 渠道名可编辑: 改名时后端按 oldName 原子替换(不丢 apiKey)''', 1),
    ('pv-savechannel-oldname', '''        val channel = Channel(
            name = name, type = type, baseUrl = baseUrl, apiKey = apiKey,
            label = existing?.label, proxy = proxy, models = models, modelMap = modelMap,
            default = db.switchDefault.isChecked, delayMs = delayMs, insecure = db.switchInsecure.isChecked,
            useResponses = db.switchUseResponses.isChecked
        )''',
     '''        val channel = Channel(
            name = name, type = type, baseUrl = baseUrl, apiKey = apiKey,
            label = existing?.label, proxy = proxy, models = models, modelMap = modelMap,
            default = db.switchDefault.isChecked, delayMs = delayMs, insecure = db.switchInsecure.isChecked,
            useResponses = db.switchUseResponses.isChecked,
            oldName = if (existing != null && existing.name != name) existing.name else null
        )''', 1),
])

print('=== 全部完成 ===' if ok else '=== 有失败 ===')
sys.exit(0 if ok else 1)
