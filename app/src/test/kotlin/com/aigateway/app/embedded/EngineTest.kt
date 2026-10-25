package com.aigateway.app.embedded

import com.aigateway.app.data.Channel
import java.io.File

/**
 * GatewayEngine 渠道路由 JVM 测试。
 * 验证 pickChannels: 渠道 modelMap > models > default > 第一个 + round-robin。
 */
fun main() {
    var pass = 0
    var fail = 0
    fun check(name: String, cond: Boolean, detail: String = "") {
        if (cond) { pass++; println("PASS $name") } else { fail++; println("FAIL $name  >> $detail") }
    }
    fun names(c: List<Candidate>) = c.map { it.channel.name }.toString()

    val engine = GatewayEngine(File("engine-test-config.json"))
    engine.load()

    engine.updateConfig {
        it.copy(channels = listOf(
            Channel(name = "ch-a", type = "openai", baseUrl = "https://a.com", apiKey = "k1", models = listOf("gpt-4o", "gpt-4")),
            Channel(name = "ch-b", type = "gemini", baseUrl = "https://b.com", apiKey = "k2", modelMap = mapOf("gpt-4o" to "gemini-2.0-flash")),
            Channel(name = "ch-c", type = "claude", baseUrl = "https://c.com", apiKey = "k3", default = true)
        ))
    }

    // 1. modelMap 精确命中(优先于 models)
    var cands = engine.pickChannels("gpt-4o")
    check("modelMap 优先命中", cands.isNotEmpty() && cands.all { it.channel.name == "ch-b" }, names(cands))
    check("modelMap upstreamModel 改写", cands.first().upstreamModel == "gemini-2.0-flash")

    // 2. models 列表命中
    cands = engine.pickChannels("gpt-4")
    check("models 命中 ch-a", cands.isNotEmpty() && cands.all { it.channel.name == "ch-a" }, names(cands))
    check("models upstreamModel 原样", cands.first().upstreamModel == "gpt-4")

    // 3. default 渠道兜底
    cands = engine.pickChannels("unknown-model")
    check("default 兜底 ch-c", cands.isNotEmpty() && cands.all { it.channel.name == "ch-c" }, names(cands))
    check("default upstreamModel 原样", cands.first().upstreamModel == "unknown-model")

    // 4. round-robin 旋转(两个 default 渠道)
    engine.updateConfig {
        it.copy(channels = listOf(
            Channel(name = "d1", type = "openai", baseUrl = "https://d1.com", apiKey = "k", default = true),
            Channel(name = "d2", type = "openai", baseUrl = "https://d2.com", apiKey = "k", default = true)
        ))
    }
    val seen = mutableSetOf<String>()
    repeat(4) { engine.pickChannels("m").firstOrNull()?.let { c -> seen.add(c.channel.name) } }
    check("round-robin 覆盖多渠道", seen.size >= 2, seen.toString())

    // 5. modelsResponse
    val resp = engine.modelsResponse("openai")
    check("modelsResponse 含 data", resp.has("data"))

    // 6. 空渠道
    engine.updateConfig { it.copy(channels = emptyList()) }
    check("空渠道返回空", engine.pickChannels("x").isEmpty())

    println("\n=== 结果: $pass 通过, $fail 失败 ===")
    if (fail > 0) System.exit(1)
}
