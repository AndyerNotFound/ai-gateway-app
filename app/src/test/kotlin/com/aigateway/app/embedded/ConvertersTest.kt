package com.aigateway.app.embedded

import com.google.gson.JsonParser





fun main() {
    var pass = 0
    var fail = 0
    fun check(name: String, cond: Boolean, detail: String = "") {
        if (cond) { pass++; println("PASS $name") } else { fail++; println("FAIL $name  >> $detail") }
    }
    fun parse(s: String) = JsonParser.parseString(s).asJsonObject

    
    val body1 = parse("""{"model":"gpt-4o","stream":false,"messages":[{"role":"system","content":"You are helpful"},{"role":"user","content":"你好"}],"max_tokens":100,"temperature":0.7}""")
    val canon1 = Converters.openaiToCanonical(body1, null)
    check("openai->canonical model", canon1.str("model") == "gpt-4o")
    check("openai->canonical msg count", canon1.arr("messages")?.size() == 2)
    val backOpenai = Converters.canonicalToOpenAIBody(canon1)
    check("canonical->openai model", backOpenai.str("model") == "gpt-4o")
    check("canonical->openai sys role", backOpenai.arr("messages")?.get(0)?.asJsonObject?.str("role") == "system")
    check("canonical->openai user content", backOpenai.arr("messages")?.get(1)?.asJsonObject?.str("content") == "你好")
    check("canonical->openai max_tokens", backOpenai.int("max_tokens") == 100)

    
    val claudeBody = Converters.canonicalToClaudeBody(canon1)
    check("canonical->claude system extracted", claudeBody.str("system") == "You are helpful", claudeBody.toString())
    check("canonical->claude max_tokens", claudeBody.int("max_tokens") == 100)
    val claudeRoles = claudeBody.arr("messages")?.map { it.asJsonObject.str("role") } ?: emptyList()
    check("canonical->claude no system in messages", "system" !in claudeRoles, claudeRoles.toString())
    check("canonical->claude has user", claudeRoles.contains("user"))

    
    val geminiBody = Converters.canonicalToGeminiBody(canon1)
    check("canonical->gemini contents", geminiBody.arr("contents") != null)
    check("canonical->gemini systemInstruction", geminiBody.obj("systemInstruction") != null)
    check("canonical->gemini maxOutputTokens", geminiBody.obj("generationConfig")?.int("maxOutputTokens") == 100)

    
    val canon2 = Converters.claudeToCanonical(parse("""{"model":"claude-sonnet-4","max_tokens":50,"system":"Be nice","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}"""), null)
    check("claude->canonical sys first", canon2.arr("messages")?.get(0)?.asJsonObject?.str("role") == "system")
    check("claude->canonical user text", toText(canon2.arr("messages")?.get(1)?.asJsonObject?.get("content")) == "hi")
    val openaiFromClaude = Converters.canonicalToOpenAIBody(canon2)
    check("claude->openai sys role", openaiFromClaude.arr("messages")?.get(0)?.asJsonObject?.str("role") == "system")

    
    val canon3 = Converters.geminiToCanonical(parse("""{"contents":[{"role":"user","parts":[{"text":"hello"}]}],"generationConfig":{"maxOutputTokens":32,"temperature":0.5}}"""), "gemini-2.0-flash")
    check("gemini->canonical url model", canon3.str("model") == "gemini-2.0-flash")
    check("gemini->canonical max_tokens", canon3.int("max_tokens") == 32)
    check("gemini->canonical user text", toText(canon3.arr("messages")?.get(0)?.asJsonObject?.get("content")) == "hello")

    
    val cresp1 = Converters.openaiRespToCanonical(parse("""{"id":"chatcmpl-1","choices":[{"index":0,"message":{"role":"assistant","content":"你好!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}"""))
    check("openaiResp->canonical text", cresp1.str("text") == "你好!")
    check("openaiResp->canonical usage in", cresp1.obj("usage")?.int("input") == 10)
    val backResp = Converters.canonicalToOpenAIResp(cresp1, "gpt-4o")
    check("canonicalResp->openai content", backResp.arr("choices")?.get(0)?.asJsonObject?.obj("message")?.str("content") == "你好!")
    check("canonicalResp->openai usage", backResp.obj("usage")?.int("prompt_tokens") == 10)

    
    val cresp2 = Converters.claudeRespToCanonical(parse("""{"id":"msg_1","content":[{"type":"text","text":"Hello"}],"stop_reason":"end_turn","usage":{"input_tokens":8,"output_tokens":3}}"""))
    check("claudeResp->canonical text", cresp2.str("text") == "Hello")
    check("claudeResp->canonical finish", cresp2.str("finish_reason") == "stop")
    check("claudeResp->openai content", Converters.canonicalToOpenAIResp(cresp2, "claude-sonnet-4").arr("choices")?.get(0)?.asJsonObject?.obj("message")?.str("content") == "Hello")

    
    val cresp3 = Converters.geminiRespToCanonical(parse("""{"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":6,"candidatesTokenCount":2}}"""))
    check("geminiResp->canonical text", cresp3.str("text") == "Hi")
    check("geminiResp->canonical usage", cresp3.obj("usage")?.int("input") == 6)
    check("geminiResp->openai content", Converters.canonicalToOpenAIResp(cresp3, "gemini-2.0-flash").arr("choices")?.get(0)?.asJsonObject?.obj("message")?.str("content") == "Hi")

    
    check("claude->gemini contents", Converters.canonicalToGeminiBody(canon2).arr("contents") != null)
    check("claude->gemini sysInstr", Converters.canonicalToGeminiBody(canon2).obj("systemInstruction") != null)

    
    check("gemini->claude messages", Converters.canonicalToClaudeBody(canon3).arr("messages") != null)
    check("gemini->claude max_tokens", Converters.canonicalToClaudeBody(canon3).int("max_tokens") == 32)

    
    val imgBody = parse("""{"model":"gpt-4o","messages":[{"role":"user","content":[{"type":"text","text":"what's this"},{"type":"image_url","image_url":{"url":"data:image/png;base64,ABC123"}}]}]}""")
    val imgCanon = Converters.openaiToCanonical(imgBody, null)
    val imgClaude = Converters.canonicalToClaudeBody(imgCanon)
    val claudeBlocks = imgClaude.arr("messages")?.get(0)?.asJsonObject?.arr("content")
    check("img->claude has image block", claudeBlocks?.any { it.asJsonObject.str("type") == "image" } == true, claudeBlocks.toString())
    val imgGemini = Converters.canonicalToGeminiBody(imgCanon)
    val gemParts = imgGemini.arr("contents")?.get(0)?.asJsonObject?.arr("parts")
    check("img->gemini has inlineData", gemParts?.any { it.asJsonObject.obj("inlineData") != null } == true, gemParts.toString())

    
    val toolCanon = parse("""{"model":"gpt-4o","messages":[{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"BJ\"}"}}]}]}""")
    val tcCanon = Converters.openaiToCanonical(toolCanon, null)
    val tcClaude = Converters.canonicalToClaudeBody(tcCanon)
    val toolBlocks = tcClaude.arr("messages")?.get(0)?.asJsonObject?.arr("content")
    check("tool->claude has tool_use", toolBlocks?.any { it.asJsonObject.str("type") == "tool_use" } == true, toolBlocks.toString())

    
    val respReq = parse("""{"model":"resp-model","instructions":"你是助手","input":[{"role":"user","content":[{"type":"input_text","text":"你好"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"嗨"}]},{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"北京\"}"},{"type":"function_call_output","call_id":"call_1","output":"晴"}],"max_output_tokens":100,"tools":[{"type":"function","name":"get_weather","description":"查天气","parameters":{"type":"object"}}],"tool_choice":{"type":"function","name":"get_weather"}}""")
    val rc = Converters.responsesToCanonical(respReq, null)
    check("responses->canonical model", rc.str("model") == "resp-model")
    check("responses->canonical instructions->system", rc.arr("messages")?.get(0)?.asJsonObject?.str("role") == "system" && rc.arr("messages")?.get(0)?.asJsonObject?.str("content") == "你是助手")
    check("responses->canonical user input_text", rc.arr("messages")?.get(1)?.asJsonObject?.str("content") == "你好")
    check("responses->canonical assistant output_text", rc.arr("messages")?.get(2)?.asJsonObject?.str("content") == "嗨")
    check("responses->canonical function_call", rc.arr("messages")?.get(3)?.asJsonObject?.arr("tool_calls")?.get(0)?.asJsonObject?.obj("function")?.str("name") == "get_weather")
    check("responses->canonical function_call_output", rc.arr("messages")?.get(4)?.asJsonObject?.str("role") == "tool" && rc.arr("messages")?.get(4)?.asJsonObject?.str("tool_call_id") == "call_1")
    check("responses->canonical max_output_tokens->max_tokens", rc.int("max_tokens") == 100)
    check("responses->canonical tools", rc.arr("tools")?.get(0)?.asJsonObject?.obj("function")?.str("name") == "get_weather")
    check("responses->canonical tool_choice", rc.obj("tool_choice")?.obj("function")?.str("name") == "get_weather")

    
    val rb = Converters.canonicalToResponsesBody(parse("""{"model":"m","stream":true,"messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"},{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"f","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call_1","content":"result"}],"max_tokens":50,"temperature":0.5,"tools":[{"type":"function","function":{"name":"f","parameters":{"type":"object"}}}],"tool_choice":"auto"}"""))
    check("canonical->responses instructions", rb.str("instructions") == "sys")
    check("canonical->responses user item", rb.arr("input")?.get(0)?.asJsonObject?.str("type") == "message" && rb.arr("input")?.get(0)?.asJsonObject?.str("role") == "user")
    check("canonical->responses function_call item", rb.arr("input")?.get(1)?.asJsonObject?.str("type") == "function_call" && rb.arr("input")?.get(1)?.asJsonObject?.str("name") == "f")
    check("canonical->responses tool output", rb.arr("input")?.get(2)?.asJsonObject?.str("type") == "function_call_output" && rb.arr("input")?.get(2)?.asJsonObject?.str("output") == "result")
    check("canonical->responses max_output_tokens", rb.int("max_output_tokens") == 50)
    check("canonical->responses tools 扁平格式", rb.arr("tools")?.get(0)?.asJsonObject?.str("name") == "f" && rb.arr("tools")?.get(0)?.asJsonObject?.obj("function") == null)
    check("canonical->responses stream", rb.bool("stream") == true)

    
    val rr = Converters.responsesRespToCanonical(parse("""{"id":"resp_1","object":"response","status":"completed","model":"m","output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"结果文本"}]},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"上海\"}","status":"completed"},{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"思考中"}]}],"usage":{"input_tokens":10,"output_tokens":5}}"""))
    check("responsesResp->canonical text", rr.str("text") == "结果文本")
    check("responsesResp->canonical tool_calls", rr.arr("tool_calls")?.get(0)?.asJsonObject?.obj("function")?.str("name") == "get_weather")
    check("responsesResp->canonical reasoning", rr.str("reasoning") == "思考中")
    check("responsesResp->canonical finish", rr.str("finish_reason") == "tool_calls")
    check("responsesResp->canonical usage", rr.obj("usage")?.int("input") == 10 && rr.obj("usage")?.int("output") == 5)
    check("responsesResp->canonical incomplete", Converters.responsesRespToCanonical(parse("""{"status":"incomplete","output":[],"usage":{}}""")).str("finish_reason") == "length")

    
    val cr = Converters.canonicalToResponsesResp(parse("""{"text":"你好","finish_reason":"stop","usage":{"input":3,"output":4}}"""), "m")
    check("canonicalResp->responses object", cr.str("object") == "response" && cr.str("status") == "completed")
    check("canonicalResp->responses message text", cr.arr("output")?.get(0)?.asJsonObject?.str("type") == "message" && cr.arr("output")?.get(0)?.asJsonObject?.arr("content")?.get(0)?.asJsonObject?.str("text") == "你好")
    check("canonicalResp->responses usage", cr.obj("usage")?.int("input_tokens") == 3 && cr.obj("usage")?.int("output_tokens") == 4)
    val cr2 = Converters.canonicalToResponsesResp(parse("""{"text":"","finish_reason":"length","usage":{"input":0,"output":0}}"""), "m")
    check("canonicalResp->responses length->incomplete", cr2.str("status") == "incomplete" && cr2.obj("incomplete_details")?.str("reason") == "max_output_tokens")

    
    val chunks = Converters.buildResponsesStreamChunks(parse("""{"text":"你好","finish_reason":"stop","usage":{"input":2,"output":3}}"""), "m")
    val joined = chunks.joinToString("\n")
    check("responses chunks created", chunks.any { it.contains("\"type\":\"response.created\"") }, joined.take(200))
    check("responses chunks delta", chunks.any { it.contains("response.output_text.delta") && it.contains("你好") }, joined.take(300))
    check("responses chunks completed", chunks.any { it.contains("\"type\":\"response.completed\"") }, joined.take(300))
    check("responses chunks usage", chunks.any { it.contains("\"input_tokens\":2") && it.contains("\"output_tokens\":3") })

    println("\n=== 结果: $pass 通过, $fail 失败 ===")
    if (fail > 0) System.exit(1)
}
