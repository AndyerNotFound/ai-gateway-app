package com.aigateway.app.embedded

import com.google.gson.JsonParser

/**
 * Converters 转换逻辑 JVM 测试 (kotlinc 直接编译运行, 不依赖 Android)。
 * 验证三种格式 ↔ canonical 的互转正确性。
 */
fun main() {
    var pass = 0
    var fail = 0
    fun check(name: String, cond: Boolean, detail: String = "") {
        if (cond) { pass++; println("PASS $name") } else { fail++; println("FAIL $name  >> $detail") }
    }
    fun parse(s: String) = JsonParser.parseString(s).asJsonObject

    // 1. OpenAI → canonical → OpenAI body (同格式)
    val body1 = parse("""{"model":"gpt-4o","stream":false,"messages":[{"role":"system","content":"You are helpful"},{"role":"user","content":"你好"}],"max_tokens":100,"temperature":0.7}""")
    val canon1 = Converters.openaiToCanonical(body1, null)
    check("openai->canonical model", canon1.str("model") == "gpt-4o")
    check("openai->canonical msg count", canon1.arr("messages")?.size() == 2)
    val backOpenai = Converters.canonicalToOpenAIBody(canon1)
    check("canonical->openai model", backOpenai.str("model") == "gpt-4o")
    check("canonical->openai sys role", backOpenai.arr("messages")?.get(0)?.asJsonObject?.str("role") == "system")
    check("canonical->openai user content", backOpenai.arr("messages")?.get(1)?.asJsonObject?.str("content") == "你好")
    check("canonical->openai max_tokens", backOpenai.int("max_tokens") == 100)

    // 2. OpenAI → canonical → Claude body (跨格式)
    val claudeBody = Converters.canonicalToClaudeBody(canon1)
    check("canonical->claude system extracted", claudeBody.str("system") == "You are helpful", claudeBody.toString())
    check("canonical->claude max_tokens", claudeBody.int("max_tokens") == 100)
    val claudeRoles = claudeBody.arr("messages")?.map { it.asJsonObject.str("role") } ?: emptyList()
    check("canonical->claude no system in messages", "system" !in claudeRoles, claudeRoles.toString())
    check("canonical->claude has user", claudeRoles.contains("user"))

    // 3. OpenAI → canonical → Gemini body
    val geminiBody = Converters.canonicalToGeminiBody(canon1)
    check("canonical->gemini contents", geminiBody.arr("contents") != null)
    check("canonical->gemini systemInstruction", geminiBody.obj("systemInstruction") != null)
    check("canonical->gemini maxOutputTokens", geminiBody.obj("generationConfig")?.int("maxOutputTokens") == 100)

    // 4. Claude → canonical → OpenAI
    val canon2 = Converters.claudeToCanonical(parse("""{"model":"claude-sonnet-4","max_tokens":50,"system":"Be nice","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}"""), null)
    check("claude->canonical sys first", canon2.arr("messages")?.get(0)?.asJsonObject?.str("role") == "system")
    check("claude->canonical user text", toText(canon2.arr("messages")?.get(1)?.asJsonObject?.get("content")) == "hi")
    val openaiFromClaude = Converters.canonicalToOpenAIBody(canon2)
    check("claude->openai sys role", openaiFromClaude.arr("messages")?.get(0)?.asJsonObject?.str("role") == "system")

    // 5. Gemini → canonical → OpenAI
    val canon3 = Converters.geminiToCanonical(parse("""{"contents":[{"role":"user","parts":[{"text":"hello"}]}],"generationConfig":{"maxOutputTokens":32,"temperature":0.5}}"""), "gemini-2.0-flash")
    check("gemini->canonical url model", canon3.str("model") == "gemini-2.0-flash")
    check("gemini->canonical max_tokens", canon3.int("max_tokens") == 32)
    check("gemini->canonical user text", toText(canon3.arr("messages")?.get(0)?.asJsonObject?.get("content")) == "hello")

    // 6. OpenAI resp → canonical → OpenAI resp
    val cresp1 = Converters.openaiRespToCanonical(parse("""{"id":"chatcmpl-1","choices":[{"index":0,"message":{"role":"assistant","content":"你好!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}"""))
    check("openaiResp->canonical text", cresp1.str("text") == "你好!")
    check("openaiResp->canonical usage in", cresp1.obj("usage")?.int("input") == 10)
    val backResp = Converters.canonicalToOpenAIResp(cresp1, "gpt-4o")
    check("canonicalResp->openai content", backResp.arr("choices")?.get(0)?.asJsonObject?.obj("message")?.str("content") == "你好!")
    check("canonicalResp->openai usage", backResp.obj("usage")?.int("prompt_tokens") == 10)

    // 7. Claude resp → canonical → OpenAI resp
    val cresp2 = Converters.claudeRespToCanonical(parse("""{"id":"msg_1","content":[{"type":"text","text":"Hello"}],"stop_reason":"end_turn","usage":{"input_tokens":8,"output_tokens":3}}"""))
    check("claudeResp->canonical text", cresp2.str("text") == "Hello")
    check("claudeResp->canonical finish", cresp2.str("finish_reason") == "stop")
    check("claudeResp->openai content", Converters.canonicalToOpenAIResp(cresp2, "claude-sonnet-4").arr("choices")?.get(0)?.asJsonObject?.obj("message")?.str("content") == "Hello")

    // 8. Gemini resp → canonical → OpenAI resp
    val cresp3 = Converters.geminiRespToCanonical(parse("""{"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":6,"candidatesTokenCount":2}}"""))
    check("geminiResp->canonical text", cresp3.str("text") == "Hi")
    check("geminiResp->canonical usage", cresp3.obj("usage")?.int("input") == 6)
    check("geminiResp->openai content", Converters.canonicalToOpenAIResp(cresp3, "gemini-2.0-flash").arr("choices")?.get(0)?.asJsonObject?.obj("message")?.str("content") == "Hi")

    // 9. Claude → canonical → Gemini (反向)
    check("claude->gemini contents", Converters.canonicalToGeminiBody(canon2).arr("contents") != null)
    check("claude->gemini sysInstr", Converters.canonicalToGeminiBody(canon2).obj("systemInstruction") != null)

    // 10. Gemini → canonical → Claude
    check("gemini->claude messages", Converters.canonicalToClaudeBody(canon3).arr("messages") != null)
    check("gemini->claude max_tokens", Converters.canonicalToClaudeBody(canon3).int("max_tokens") == 32)

    // 11. 图片块 (OpenAI 多模态 → Claude/Gemini)
    val imgBody = parse("""{"model":"gpt-4o","messages":[{"role":"user","content":[{"type":"text","text":"what's this"},{"type":"image_url","image_url":{"url":"data:image/png;base64,ABC123"}}]}]}""")
    val imgCanon = Converters.openaiToCanonical(imgBody, null)
    val imgClaude = Converters.canonicalToClaudeBody(imgCanon)
    val claudeBlocks = imgClaude.arr("messages")?.get(0)?.asJsonObject?.arr("content")
    check("img->claude has image block", claudeBlocks?.any { it.asJsonObject.str("type") == "image" } == true, claudeBlocks.toString())
    val imgGemini = Converters.canonicalToGeminiBody(imgCanon)
    val gemParts = imgGemini.arr("contents")?.get(0)?.asJsonObject?.arr("parts")
    check("img->gemini has inlineData", gemParts?.any { it.asJsonObject.obj("inlineData") != null } == true, gemParts.toString())

    // 12. 工具调用 (OpenAI tool_calls → Claude tool_use)
    val toolCanon = parse("""{"model":"gpt-4o","messages":[{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"BJ\"}"}}]}]}""")
    val tcCanon = Converters.openaiToCanonical(toolCanon, null)
    val tcClaude = Converters.canonicalToClaudeBody(tcCanon)
    val toolBlocks = tcClaude.arr("messages")?.get(0)?.asJsonObject?.arr("content")
    check("tool->claude has tool_use", toolBlocks?.any { it.asJsonObject.str("type") == "tool_use" } == true, toolBlocks.toString())

    println("\n=== 结果: $pass 通过, $fail 失败 ===")
    if (fail > 0) System.exit(1)
}
