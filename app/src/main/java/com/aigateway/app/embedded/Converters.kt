package com.aigateway.app.embedded

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject








object Converters {

    

    fun openaiToCanonical(body: JsonObject, urlModel: String?): JsonObject {
        val messages = JsonArray()
        body.arr("messages")?.forEach { mEl ->
            if (!mEl.isJsonObject) return@forEach
            val m = mEl.asJsonObject
            var role = m.str("role")
            if (role == "developer") role = "system"
            if (role == "function") {
                messages.add(jsonObj(
                    "role" to je("tool"),
                    "name" to je(m.str("name")),
                    "tool_call_id" to je("call_fn_" + (m.str("name") ?: "")),
                    "content" to je(toText(m.get("content")))
                ))
                return@forEach
            }
            val out = JsonObject()
            out.put("role", role)
            out.add("content", m.get("content") ?: je(""))
            m.str("name")?.let { out.put("name", it) }
            m.str("tool_call_id")?.let { out.put("tool_call_id", it) }
            m.arr("tool_calls")?.takeIf { it.size() > 0 }?.let { tcs ->
                out.add("tool_calls", normOpenAIToolCalls(tcs))
            }
            messages.add(out)
        }
        return JsonObject()
            .put("model", body.str("model") ?: urlModel)
            .put("stream", body.bool("stream") ?: false)
            .putEl("messages", messages)
            .putEl("temperature", body.get("temperature"))
            .putEl("top_p", body.get("top_p"))
            .putEl("max_tokens", body.get("max_tokens") ?: body.get("max_completion_tokens"))
            .putEl("stop", normStop(body.get("stop"))?.let { l -> JsonArray().apply { l.forEach { add(it) } } })
            .putEl("tools", body.arr("tools")?.takeIf { it.size() > 0 })
            .putEl("tool_choice", body.get("tool_choice"))
    }

    private fun normOpenAIToolCalls(tcs: JsonArray): JsonArray {
        val arr = JsonArray()
        tcs.forEach { tcEl ->
            if (!tcEl.isJsonObject) return@forEach
            val tc = tcEl.asJsonObject
            val fn = tc.obj("function")
            val args = fn?.get("arguments")
            arr.add(jsonObj(
                "id" to (tc.get("id") ?: JsonNull.INSTANCE),
                "type" to je("function"),
                "function" to jsonObj(
                    "name" to je(fn?.str("name") ?: ""),
                    "arguments" to je(if (args == null || args.isJsonNull) "{}" else if (args.isStr) args.asString else args.toString())
                )
            ))
        }
        return arr
    }

    private fun claudeToolsToOpenAI(tools: JsonArray?): JsonArray? {
        if (tools == null) return null
        val out = JsonArray()
        tools.forEach { tEl ->
            if (!tEl.isJsonObject) return@forEach
            val t = tEl.asJsonObject
            out.add(jsonObj(
                "type" to je("function"),
                "function" to jsonObj(
                    "name" to je(t.str("name")),
                    "description" to je(t.str("description") ?: ""),
                    "parameters" to (t.obj("input_schema") ?: jsonObj("type" to je("object")))
                )
            ))
        }
        return if (out.size() > 0) out else null
    }

    private fun claudeChoiceToOpenAI(tc: JsonElement?): JsonElement? {
        if (tc == null || !tc.isJsonObject) return null
        val o = tc.asJsonObject
        return when (o.str("type")) {
            "auto" -> je("auto")
            "any" -> je("required")
            "tool" -> o.str("name")?.let { jsonObj("type" to je("function"), "function" to jsonObj("name" to je(it))) }
            else -> null
        }
    }

    fun claudeToCanonical(body: JsonObject, urlModel: String?): JsonObject {
        val messages = JsonArray()
        
        body.get("system")?.let { sysEl ->
            val s = if (sysEl.isStr) sysEl.asString
            else if (sysEl.isJsonArray) sysEl.asJsonArray
                .filter { it.isJsonObject && it.asJsonObject.str("type") == "text" }
                .joinToString("\n") { it.asJsonObject.str("text") ?: "" }
            else ""
            if (s.isNotEmpty()) messages.add(jsonObj("role" to je("system"), "content" to je(s)))
        }
        body.arr("messages")?.forEach { mEl ->
            if (!mEl.isJsonObject) return@forEach
            val m = mEl.asJsonObject
            val contentEl = m.get("content")
            val blocks = when {
                contentEl != null && contentEl.isJsonArray -> contentEl.asJsonArray
                contentEl == null || contentEl.isJsonNull -> JsonArray()
                else -> JsonArray().apply { add(jsonObj("type" to je("text"), "text" to je(contentEl.asString))) }
            }
            val textParts = JsonArray()
            val toolCalls = JsonArray()
            blocks.forEach { bEl ->
                if (!bEl.isJsonObject) return@forEach
                val b = bEl.asJsonObject
                when (b.str("type")) {
                    "text" -> textParts.add(jsonObj("type" to je("text"), "text" to je(b.str("text") ?: "")))
                    "image" -> b.obj("source")?.let { s ->
                        when (s.str("type")) {
                            "base64" -> textParts.add(jsonObj("type" to je("image_url"), "image_url" to jsonObj(
                                "url" to je("data:${s.str("media_type") ?: "image/png"};base64,${s.str("data") ?: ""}"))))
                            "url" -> textParts.add(jsonObj("type" to je("image_url"), "image_url" to jsonObj("url" to je(s.str("url")))))
                        }
                    }
                    "tool_use" -> toolCalls.add(jsonObj(
                        "id" to je(b.str("id") ?: randId("call_")),
                        "type" to je("function"),
                        "function" to jsonObj(
                            "name" to je(b.str("name") ?: ""),
                            "arguments" to je((b.get("input") ?: jsonObj()).toString())
                        )
                    ))
                    "tool_result" -> {
                        val c = b.get("content")
                        val txt = if (c != null && c.isStr) c.asString
                        else if (c != null && c.isJsonArray) c.asJsonArray
                            .filter { it.isJsonObject && it.asJsonObject.str("type") == "text" }
                            .joinToString("\n") { it.asJsonObject.str("text") ?: "" }
                        else ""
                        messages.add(jsonObj("role" to je("tool"), "tool_call_id" to je(b.str("tool_use_id") ?: ""), "content" to je(txt)))
                    }
                }
            }
            if (m.str("role") == "assistant") {
                if (textParts.size() > 0 || toolCalls.size() > 0) {
                    val out = jsonObj("role" to je("assistant"), "content" to (if (textParts.size() > 0) textParts else je("")))
                    if (toolCalls.size() > 0) out.add("tool_calls", toolCalls)
                    messages.add(out)
                }
            } else if (textParts.size() > 0) {
                messages.add(jsonObj("role" to je("user"), "content" to textParts))
            }
        }
        return JsonObject()
            .put("model", body.str("model") ?: urlModel)
            .put("stream", body.bool("stream") ?: false)
            .putEl("messages", messages)
            .putEl("temperature", body.get("temperature"))
            .putEl("top_p", body.get("top_p"))
            .putEl("max_tokens", body.get("max_tokens"))
            .putEl("stop", normStop(body.get("stop_sequences"))?.let { l -> JsonArray().apply { l.forEach { add(it) } } })
            .putEl("tools", claudeToolsToOpenAI(body.arr("tools")))
            .putEl("tool_choice", claudeChoiceToOpenAI(body.get("tool_choice")))
    }

    fun geminiToCanonical(body: JsonObject, urlModel: String?): JsonObject {
        val messages = JsonArray()
        val sys = body.obj("systemInstruction") ?: body.obj("system_instruction")
        sys?.arr("parts")?.let { parts ->
            val t = parts.joinToString("") { if (it.isJsonObject) it.asJsonObject.str("text") ?: "" else "" }
            if (t.isNotEmpty()) messages.add(jsonObj("role" to je("system"), "content" to je(t)))
        }
        var callSeq = 0
        val lastName = HashMap<String, String>()
        body.arr("contents")?.forEach { cEl ->
            if (!cEl.isJsonObject) return@forEach
            val c = cEl.asJsonObject
            val partsArr = c.arr("parts") ?: return@forEach
            val role = if (c.str("role") == "model") "assistant" else "user"
            val textParts = JsonArray()
            val toolCalls = JsonArray()
            val toolMsgs = JsonArray()
            partsArr.forEach { pEl ->
                if (!pEl.isJsonObject) return@forEach
                val p = pEl.asJsonObject
                val text = p.str("text")
                when {
                    text != null -> if (p.bool("thought") != true) textParts.add(jsonObj("type" to je("text"), "text" to je(text)))
                    p.obj("inlineData") != null || p.obj("inline_data") != null -> {
                        val d = p.obj("inlineData") ?: p.obj("inline_data")!!
                        textParts.add(jsonObj("type" to je("image_url"), "image_url" to jsonObj(
                            "url" to je("data:${d.str("mimeType") ?: d.str("mime_type") ?: "image/png"};base64,${d.str("data") ?: ""}"))))
                    }
                    p.obj("fileData") != null || p.obj("file_data") != null -> {
                        val d = p.obj("fileData") ?: p.obj("file_data")!!
                        val uri = d.str("fileUri") ?: d.str("file_uri")
                        if (uri != null) textParts.add(jsonObj("type" to je("image_url"), "image_url" to jsonObj("url" to je(uri))))
                    }
                    p.obj("functionCall") != null || p.obj("function_call") != null -> {
                        val f = p.obj("functionCall") ?: p.obj("function_call")!!
                        val id = "call_gm_" + (f.str("name") ?: "fn") + "_" + (callSeq++)
                        toolCalls.add(jsonObj(
                            "id" to je(id), "type" to je("function"),
                            "function" to jsonObj("name" to je(f.str("name") ?: ""), "arguments" to je((f.get("args") ?: jsonObj()).toString()))
                        ))
                        lastName[f.str("name") ?: ""] = id
                    }
                    p.obj("functionResponse") != null || p.obj("function_response") != null -> {
                        val f = p.obj("functionResponse") ?: p.obj("function_response")!!
                        val nm = f.str("name") ?: ""
                        toolMsgs.add(jsonObj(
                            "role" to je("tool"), "name" to je(nm),
                            "tool_call_id" to je(lastName[nm] ?: "call_gm_$nm"),
                            "content" to je((f.get("response") ?: jsonObj()).toString())
                        ))
                    }
                }
            }
            if (role == "assistant" && (textParts.size() > 0 || toolCalls.size() > 0)) {
                val out = jsonObj("role" to je("assistant"), "content" to (if (textParts.size() > 0) textParts else je("")))
                if (toolCalls.size() > 0) out.add("tool_calls", toolCalls)
                messages.add(out)
            } else if (textParts.size() > 0) {
                messages.add(jsonObj("role" to je(role), "content" to textParts))
            }
            toolMsgs.forEach { messages.add(it) }
        }
        val g = body.obj("generationConfig") ?: body.obj("generation_config") ?: JsonObject()
        val tools = JsonArray()
        body.arr("tools")?.forEach { tEl ->
            if (!tEl.isJsonObject) return@forEach
            val fds = tEl.asJsonObject.arr("functionDeclarations") ?: tEl.asJsonObject.arr("function_declarations") ?: return@forEach
            fds.forEach { fdEl ->
                if (!fdEl.isJsonObject) return@forEach
                val fd = fdEl.asJsonObject
                tools.add(jsonObj(
                    "type" to je("function"),
                    "function" to jsonObj(
                        "name" to je(fd.str("name")),
                        "description" to je(fd.str("description") ?: ""),
                        "parameters" to (fd.get("parameters") ?: fd.get("parametersJsonSchema") ?: fd.get("parameters_json_schema") ?: jsonObj("type" to je("object")))
                    )
                ))
            }
        }
        var toolChoice: JsonElement? = null
        val tcfg = body.obj("toolConfig")?.obj("functionCallingConfig") ?: body.obj("tool_config")?.obj("function_calling_config")
        if (tcfg != null) {
            val mode = (tcfg.str("mode") ?: "AUTO").uppercase()
            toolChoice = when (mode) {
                "ANY" -> {
                    val allowed = tcfg.arr("allowedFunctionNames")
                    if (allowed != null && allowed.size() == 1) jsonObj("type" to je("function"), "function" to jsonObj("name" to je(allowed[0].asString)))
                    else je("required")
                }
                "NONE" -> je("none")
                else -> je("auto")
            }
        }
        return JsonObject()
            .put("model", urlModel ?: body.str("model"))
            .put("stream", body.bool("stream") ?: false)
            .putEl("messages", messages)
            .putEl("temperature", g.get("temperature"))
            .putEl("top_p", g.get("topP") ?: g.get("top_p"))
            .putEl("max_tokens", g.get("maxOutputTokens") ?: g.get("max_output_tokens"))
            .putEl("stop", normStop(g.get("stopSequences") ?: g.get("stop_sequences"))?.let { l -> JsonArray().apply { l.forEach { add(it) } } })
            .putEl("tools", if (tools.size() > 0) tools else null)
            .putEl("tool_choice", toolChoice)
    }

    

    fun canonicalToOpenAIBody(c: JsonObject, addUsage: Boolean = true): JsonObject {
        val messages = JsonArray()
        c.arr("messages")?.forEach { mEl ->
            if (!mEl.isJsonObject) return@forEach
            val m = mEl.asJsonObject
            when (m.str("role")) {
                "assistant" -> {
                    val content = toText(m.get("content"))
                    val hasTools = (m.arr("tool_calls")?.size() ?: 0) > 0
                    val out = JsonObject()
                    out.put("role", "assistant")
                    out.add("content", if (content == "" && hasTools) JsonNull.INSTANCE else je(content))
                    if (hasTools) out.add("tool_calls", m.arr("tool_calls"))
                    m.str("name")?.let { out.put("name", it) }
                    messages.add(out)
                }
                "tool" -> {
                    val out = jsonObj("role" to je("tool"), "tool_call_id" to je(m.str("tool_call_id") ?: ""), "content" to je(toText(m.get("content"))))
                    m.str("name")?.let { out.put("name", it) }
                    messages.add(out)
                }
                "system" -> messages.add(jsonObj("role" to je("system"), "content" to je(toText(m.get("content")))))
                else -> {
                    var content = m.get("content")
                    if (content != null && content.isJsonArray && content.asJsonArray.all { it.isJsonObject && it.asJsonObject.str("type") == "text" }) {
                        content = je(content.asJsonArray.joinToString("") { it.asJsonObject.str("text") ?: "" })
                    }
                    messages.add(jsonObj("role" to je("user"), "content" to (content ?: je(""))))
                }
            }
        }
        if (messages.size() == 0) messages.add(jsonObj("role" to je("user"), "content" to je(" ")))
        val body = JsonObject()
        body.put("model", c.str("model"))
        body.add("messages", messages)
        body.put("stream", c.bool("stream") ?: false)
        c.get("temperature")?.let { body.add("temperature", it) }
        c.get("top_p")?.let { body.add("top_p", it) }
        c.get("max_tokens")?.let {
            if (Regex("^o[0-9]").containsMatchIn(c.str("model") ?: "")) body.add("max_completion_tokens", it) else body.add("max_tokens", it)
        }
        c.arr("stop")?.takeIf { it.size() > 0 }?.let { body.add("stop", it) }
        c.arr("tools")?.takeIf { it.size() > 0 }?.let {
            body.add("tools", it)
            c.get("tool_choice")?.let { tc -> body.add("tool_choice", tc) }
        }
        if ((c.bool("stream") ?: false) && addUsage) body.add("stream_options", jsonObj("include_usage" to je(true)))
        return body
    }

    private fun blocksToClaude(content: JsonElement?): JsonArray {
        if (content == null || content.isJsonNull) return JsonArray()
        if (content.isStr) return if (content.asString == "") JsonArray() else jsonArr(jsonObj("type" to je("text"), "text" to je(content.asString)))
        val out = JsonArray()
        content.asJsonArrayOrNull()?.forEach { pEl ->
            if (!pEl.isJsonObject) return@forEach
            val p = pEl.asJsonObject
            when (p.str("type")) {
                "text" -> p.str("text")?.let { out.add(jsonObj("type" to je("text"), "text" to je(it))) }
                "image_url" -> p.obj("image_url")?.str("url")?.let { url ->
                    val m = Regex("^data:([^;,]+);base64,([\\s\\S]*)$").find(url)
                    if (m != null) out.add(jsonObj("type" to je("image"), "source" to jsonObj("type" to je("base64"), "media_type" to je(m.groupValues[1]), "data" to je(m.groupValues[2]))))
                    else out.add(jsonObj("type" to je("image"), "source" to jsonObj("type" to je("url"), "url" to je(url))))
                }
            }
        }
        return out
    }

    fun canonicalToClaudeBody(c: JsonObject): JsonObject {
        val turns = JsonArray()
        fun pushTurn(role: String, blocks: JsonArray) {
            if (blocks.size() == 0) return
            val last = if (turns.size() > 0) turns[turns.size() - 1].asJsonObject else null
            if (last != null && last.str("role") == role) blocks.forEach { last.arr("content")!!.add(it) }
            else turns.add(jsonObj("role" to je(role), "content" to blocks))
        }
        c.arr("messages")?.forEach { mEl ->
            if (!mEl.isJsonObject) return@forEach
            val m = mEl.asJsonObject
            when (m.str("role")) {
                "system" -> {}
                "tool" -> pushTurn("user", jsonArr(jsonObj("type" to je("tool_result"), "tool_use_id" to je(m.str("tool_call_id") ?: ""), "content" to je(toText(m.get("content"))))))
                "assistant" -> {
                    val blocks = blocksToClaude(m.get("content"))
                    m.arr("tool_calls")?.forEach { tcEl ->
                        if (!tcEl.isJsonObject) return@forEach
                        val tc = tcEl.asJsonObject
                        val fn = tc.obj("function")
                        var input: JsonElement = jsonObj()
                        fn?.str("arguments")?.let { argsStr ->
                            val p = safeParse(argsStr)
                            if (p != null && !p.isJsonNull) input = if (p.isJsonObject) p else jsonObj("value" to p)
                        }
                        blocks.add(jsonObj("type" to je("tool_use"), "id" to je(tc.str("id") ?: randId("toolu_")), "name" to je(fn?.str("name") ?: ""), "input" to input))
                    }
                    if (blocks.size() == 0) blocks.add(jsonObj("type" to je("text"), "text" to je("")))
                    pushTurn("assistant", blocks)
                }
                else -> pushTurn("user", blocksToClaude(m.get("content")))
            }
        }
        if (turns.size() == 0) turns.add(jsonObj("role" to je("user"), "content" to jsonArr(jsonObj("type" to je("text"), "text" to je(" ")))))
        val sysParts = c.arr("messages")?.mapNotNull { if (it.isJsonObject && it.asJsonObject.str("role") == "system") toText(it.asJsonObject.get("content")) else null }?.filter { it.isNotEmpty() } ?: emptyList()
        val body = JsonObject()
        body.put("model", c.str("model"))
        body.add("messages", turns)
        body.put("max_tokens", c.int("max_tokens") ?: 4096)
        body.put("stream", c.bool("stream") ?: false)
        if (sysParts.isNotEmpty()) body.put("system", sysParts.joinToString("\n"))
        c.get("temperature")?.let { body.add("temperature", it) }
        c.get("top_p")?.let { body.add("top_p", it) }
        c.arr("stop")?.takeIf { it.size() > 0 }?.let { body.add("stop_sequences", it) }
        c.arr("tools")?.takeIf { it.size() > 0 }?.let { tools ->
            val arr = JsonArray()
            tools.forEach { tEl ->
                if (!tEl.isJsonObject) return@forEach
                val fn = tEl.asJsonObject.obj("function")
                arr.add(jsonObj(
                    "name" to je(fn?.str("name")),
                    "description" to je(fn?.str("description") ?: ""),
                    "input_schema" to (fn?.obj("parameters") ?: jsonObj("type" to je("object")))
                ))
            }
            body.add("tools", arr)
            when {
                c.str("tool_choice") == "auto" -> body.add("tool_choice", jsonObj("type" to je("auto")))
                c.str("tool_choice") == "required" -> body.add("tool_choice", jsonObj("type" to je("any")))
                c.obj("tool_choice")?.obj("function") != null -> body.add("tool_choice", jsonObj("type" to je("tool"), "name" to je(c.obj("tool_choice")!!.obj("function")!!.str("name"))))
            }
        }
        return body
    }

    private fun blocksToGeminiParts(content: JsonElement?): JsonArray {
        if (content == null || content.isJsonNull) return JsonArray()
        if (content.isStr) return if (content.asString == "") JsonArray() else jsonArr(jsonObj("text" to je(content.asString)))
        val out = JsonArray()
        content.asJsonArrayOrNull()?.forEach { pEl ->
            if (!pEl.isJsonObject) return@forEach
            val p = pEl.asJsonObject
            when (p.str("type")) {
                "text" -> p.str("text")?.let { out.add(jsonObj("text" to je(it))) }
                "image_url" -> p.obj("image_url")?.str("url")?.let { url ->
                    val m = Regex("^data:([^;,]+);base64,([\\s\\S]*)$").find(url)
                    if (m != null) out.add(jsonObj("inlineData" to jsonObj("mimeType" to je(m.groupValues[1]), "data" to je(m.groupValues[2]))))
                    else out.add(jsonObj("fileData" to jsonObj("fileUri" to je(url))))
                }
            }
        }
        return out
    }

    fun canonicalToGeminiBody(c: JsonObject): JsonObject {
        val contents = JsonArray()
        fun push(role: String, parts: JsonArray) {
            if (parts.size() == 0) return
            val last = if (contents.size() > 0) contents[contents.size() - 1].asJsonObject else null
            if (last != null && last.str("role") == role) parts.forEach { last.arr("parts")!!.add(it) }
            else contents.add(jsonObj("role" to je(role), "parts" to parts))
        }
        val nameById = HashMap<String, String>()
        val sysParts = ArrayList<String>()
        c.arr("messages")?.forEach { mEl ->
            if (!mEl.isJsonObject) return@forEach
            val m = mEl.asJsonObject
            when (m.str("role")) {
                "system" -> toText(m.get("content")).takeIf { it.isNotEmpty() }?.let { sysParts.add(it) }
                "tool" -> {
                    val nm = m.str("name") ?: nameById[m.str("tool_call_id")] ?: "function"
                    var resp = safeParse(toText(m.get("content")))
                    if (resp == null || resp.isJsonNull) resp = jsonObj("result" to je(""))
                    if (!resp.isJsonObject) resp = jsonObj("result" to resp)
                    push("user", jsonArr(jsonObj("functionResponse" to jsonObj("name" to je(nm), "response" to resp))))
                }
                "assistant" -> {
                    val parts = blocksToGeminiParts(m.get("content"))
                    m.arr("tool_calls")?.forEach { tcEl ->
                        if (!tcEl.isJsonObject) return@forEach
                        val tc = tcEl.asJsonObject
                        val fn = tc.obj("function")
                        var args = fn?.str("arguments")?.let { safeParse(it) }
                        if (args == null || args.isJsonNull) args = jsonObj()
                        if (!args.isJsonObject) args = jsonObj("value" to args)
                        parts.add(jsonObj("functionCall" to jsonObj("name" to je(fn?.str("name") ?: ""), "args" to args)))
                        tc.str("id")?.let { id -> fn?.str("name")?.let { nm -> nameById[id] = nm } }
                    }
                    push("model", parts)
                }
                else -> push("user", blocksToGeminiParts(m.get("content")))
            }
        }
        if (contents.size() == 0) contents.add(jsonObj("role" to je("user"), "parts" to jsonArr(jsonObj("text" to je(" ")))))
        val body = JsonObject()
        body.add("contents", contents)
        if (sysParts.isNotEmpty()) body.add("systemInstruction", jsonObj("parts" to jsonArr(jsonObj("text" to je(sysParts.joinToString("\n"))))))
        val gen = JsonObject()
        c.get("temperature")?.let { gen.add("temperature", it) }
        c.get("top_p")?.let { gen.add("topP", it) }
        c.get("max_tokens")?.let { gen.add("maxOutputTokens", it) }
        c.arr("stop")?.takeIf { it.size() > 0 }?.let { gen.add("stopSequences", it) }
        if (gen.size() > 0) body.add("generationConfig", gen)
        c.arr("tools")?.takeIf { it.size() > 0 }?.let { tools ->
            val fds = JsonArray()
            tools.forEach { tEl ->
                if (!tEl.isJsonObject) return@forEach
                val fn = tEl.asJsonObject.obj("function")
                fds.add(jsonObj(
                    "name" to je(fn?.str("name")),
                    "description" to je(fn?.str("description") ?: ""),
                    "parameters" to (fn?.obj("parameters") ?: jsonObj("type" to je("object")))
                ))
            }
            body.add("tools", jsonArr(jsonObj("functionDeclarations" to fds)))
            when {
                c.str("tool_choice") == "auto" -> body.add("toolConfig", jsonObj("functionCallingConfig" to jsonObj("mode" to je("AUTO"))))
                c.str("tool_choice") == "required" -> body.add("toolConfig", jsonObj("functionCallingConfig" to jsonObj("mode" to je("ANY"))))
                c.str("tool_choice") == "none" -> body.add("toolConfig", jsonObj("functionCallingConfig" to jsonObj("mode" to je("NONE"))))
                c.obj("tool_choice")?.obj("function") != null -> body.add("toolConfig", jsonObj("functionCallingConfig" to jsonObj("mode" to je("ANY"), "allowedFunctionNames" to jsonArr(je(c.obj("tool_choice")!!.obj("function")!!.str("name"))))))
            }
        }
        return body
    }

    

    fun openaiRespToCanonical(j: JsonObject): JsonObject = cresp(
        text = run {
            val msg = j.arr("choices")?.get(0)?.asJsonObject?.obj("message")
            val content = msg?.get("content")
            if (content != null && content.isStr) content.asString else toText(content)
        },
        reasoning = j.arr("choices")?.get(0)?.asJsonObject?.obj("message")?.let { it.str("reasoning_content") ?: it.str("reasoning") },
        toolCalls = j.arr("choices")?.get(0)?.asJsonObject?.obj("message")?.arr("tool_calls")?.let { normOpenAIToolCalls(it) },
        finish = mapFinish(j.arr("choices")?.get(0)?.asJsonObject?.str("finish_reason"), mapOf(
            "stop" to "stop", "length" to "length", "tool_calls" to "tool_calls", "content_filter" to "content_filter", "function_call" to "tool_calls"), "stop"),
        inT = j.obj("usage")?.int("prompt_tokens") ?: 0,
        outT = j.obj("usage")?.int("completion_tokens") ?: 0
    )

    fun claudeRespToCanonical(j: JsonObject): JsonObject {
        val text = StringBuilder()
        val reasoning = ArrayList<String>()
        val toolCalls = JsonArray()
        j.arr("content")?.forEach { bEl ->
            if (!bEl.isJsonObject) return@forEach
            val b = bEl.asJsonObject
            when (b.str("type")) {
                "text" -> text.append(b.str("text") ?: "")
                "thinking" -> b.str("thinking")?.let { reasoning.add(it) }
                "tool_use" -> toolCalls.add(jsonObj("id" to (b.get("id") ?: JsonNull.INSTANCE), "type" to je("function"),
                    "function" to jsonObj("name" to je(b.str("name") ?: ""), "arguments" to je((b.get("input") ?: jsonObj()).toString()))))
            }
        }
        return cresp(text.toString(), if (reasoning.isEmpty()) null else reasoning.joinToString("\n"),
            if (toolCalls.size() > 0) toolCalls else null,
            mapFinish(j.str("stop_reason"), mapOf("end_turn" to "stop", "stop_sequence" to "stop", "max_tokens" to "length", "tool_use" to "tool_calls", "refusal" to "content_filter"), "stop"),
            j.obj("usage")?.int("input_tokens") ?: 0, j.obj("usage")?.int("output_tokens") ?: 0)
    }

    fun geminiRespToCanonical(j: JsonObject): JsonObject {
        val cand = j.arr("candidates")?.get(0)?.asJsonObject
        val text = StringBuilder()
        val reasoning = ArrayList<String>()
        val toolCalls = JsonArray()
        cand?.obj("content")?.arr("parts")?.forEach { pEl ->
            if (!pEl.isJsonObject) return@forEach
            val p = pEl.asJsonObject
            val t = p.str("text")
            if (t != null) {
                if (p.bool("thought") == true) reasoning.add(t) else text.append(t)
            } else {
                val f = p.obj("functionCall") ?: p.obj("function_call")
                if (f != null) toolCalls.add(jsonObj("id" to je(randId("call_")), "type" to je("function"),
                    "function" to jsonObj("name" to je(f.str("name") ?: ""), "arguments" to je((f.get("args") ?: jsonObj()).toString()))))
            }
        }
        val u = j.obj("usageMetadata") ?: j.obj("usage_metadata") ?: JsonObject()
        val fr = (cand?.str("finishReason") ?: cand?.str("finish_reason") ?: "STOP").uppercase()
        var finish = mapOf("STOP" to "stop", "MAX_TOKENS" to "length", "SAFETY" to "content_filter", "RECITATION" to "content_filter",
            "PROHIBITED_CONTENT" to "content_filter", "BLOCKLIST" to "content_filter", "SPII" to "content_filter")[fr] ?: "stop"
        if (toolCalls.size() > 0) finish = "tool_calls"
        return cresp(text.toString(), if (reasoning.isEmpty()) null else reasoning.joinToString("\n"),
            if (toolCalls.size() > 0) toolCalls else null, finish,
            u.int("promptTokenCount") ?: u.int("prompt_token_count") ?: 0,
            u.int("candidatesTokenCount") ?: u.int("candidates_token_count") ?: 0)
    }

    private fun mapFinish(v: String?, map: Map<String, String>, def: String): String = map[v] ?: def

    private fun cresp(text: String, reasoning: String?, toolCalls: JsonArray?, finish: String, inT: Int, outT: Int): JsonObject {
        val o = JsonObject()
        o.put("text", text)
        reasoning?.let { o.put("reasoning", it) }
        toolCalls?.let { o.add("tool_calls", it) }
        o.put("finish_reason", finish)
        o.add("usage", jsonObj("input" to je(inT), "output" to je(outT)))
        return o
    }

    

    fun canonicalToOpenAIResp(cresp: JsonObject, model: String): JsonObject {
        val text = cresp.str("text") ?: ""
        val toolCalls = cresp.arr("tool_calls")
        val message = JsonObject()
        message.put("role", "assistant")
        message.add("content", if (text == "") JsonNull.INSTANCE else je(text))
        cresp.str("reasoning")?.let { message.put("reasoning_content", it) }
        if (toolCalls != null && toolCalls.size() > 0) message.add("tool_calls", toolCalls)
        if (text == "" && (toolCalls == null || toolCalls.size() == 0)) message.add("content", je(""))
        val usage = cresp.obj("usage") ?: JsonObject()
        val inT = usage.int("input") ?: 0
        val outT = usage.int("output") ?: 0
        return jsonObj(
            "id" to je(randId("chatcmpl-")), "object" to je("chat.completion"), "created" to je(nowSec()), "model" to je(model),
            "choices" to jsonArr(jsonObj("index" to je(0), "message" to message, "finish_reason" to je(cresp.str("finish_reason") ?: "stop"))),
            "usage" to jsonObj("prompt_tokens" to je(inT), "completion_tokens" to je(outT), "total_tokens" to je(inT + outT))
        )
    }

    fun canonicalToClaudeResp(cresp: JsonObject, model: String): JsonObject {
        val content = JsonArray()
        cresp.str("reasoning")?.let { content.add(jsonObj("type" to je("thinking"), "thinking" to je(it))) }
        val text = cresp.str("text") ?: ""
        if (text != "") content.add(jsonObj("type" to je("text"), "text" to je(text)))
        cresp.arr("tool_calls")?.forEach { tcEl ->
            if (!tcEl.isJsonObject) return@forEach
            val tc = tcEl.asJsonObject
            val fn = tc.obj("function")
            var input = fn?.str("arguments")?.let { safeParse(it) }
            if (input == null || input.isJsonNull) input = jsonObj()
            if (!input.isJsonObject) input = jsonObj("value" to input)
            content.add(jsonObj("type" to je("tool_use"), "id" to je(tc.str("id") ?: randId("toolu_")), "name" to je(fn?.str("name") ?: ""), "input" to input))
        }
        if (content.size() == 0) content.add(jsonObj("type" to je("text"), "text" to je("")))
        val usage = cresp.obj("usage") ?: JsonObject()
        return jsonObj(
            "id" to je(randId("msg_")), "type" to je("message"), "role" to je("assistant"), "model" to je(model),
            "content" to content,
            "stop_reason" to je(claudeFinish(cresp.str("finish_reason"))), "stop_sequence" to JsonNull.INSTANCE,
            "usage" to jsonObj("input_tokens" to je(usage.int("input") ?: 0), "output_tokens" to je(usage.int("output") ?: 0))
        )
    }

    fun canonicalToGeminiResp(cresp: JsonObject, model: String): JsonObject {
        val parts = JsonArray()
        cresp.str("reasoning")?.let { parts.add(jsonObj("text" to je(it), "thought" to je(true))) }
        val text = cresp.str("text") ?: ""
        if (text != "") parts.add(jsonObj("text" to je(text)))
        cresp.arr("tool_calls")?.forEach { tcEl ->
            if (!tcEl.isJsonObject) return@forEach
            val tc = tcEl.asJsonObject
            val fn = tc.obj("function")
            var args = fn?.str("arguments")?.let { safeParse(it) }
            if (args == null || args.isJsonNull) args = jsonObj()
            if (!args.isJsonObject) args = jsonObj("value" to args)
            parts.add(jsonObj("functionCall" to jsonObj("name" to je(fn?.str("name") ?: ""), "args" to args)))
        }
        if (parts.size() == 0) parts.add(jsonObj("text" to je("")))
        val usage = cresp.obj("usage") ?: JsonObject()
        val inT = usage.int("input") ?: 0
        val outT = usage.int("output") ?: 0
        return jsonObj(
            "candidates" to jsonArr(jsonObj("content" to jsonObj("role" to je("model"), "parts" to parts), "finishReason" to je(geminiFinish(cresp.str("finish_reason"))), "index" to je(0))),
            "usageMetadata" to jsonObj("promptTokenCount" to je(inT), "candidatesTokenCount" to je(outT), "totalTokenCount" to je(inT + outT)),
            "modelVersion" to je(model)
        )
    }

    

    
    private fun responsesContentToContent(content: JsonElement?): JsonElement {
        if (content == null || content.isJsonNull) return je("")
        if (content.isJsonPrimitive) return content
        if (content.isJsonArray) {
            val out = JsonArray()
            for (p in content.asJsonArray) {
                if (!p.isJsonObject) continue
                val po = p.asJsonObject
                when (po.str("type")) {
                    "input_text", "output_text", "text" -> po.str("text")?.let { out.add(jsonObj("type" to je("text"), "text" to je(it))) }
                    "input_image" -> {
                        val img = po.get("image_url")
                        if (img != null && !img.isJsonNull) {
                            out.add(jsonObj("type" to je("image_url"), "image_url" to (if (img.isJsonPrimitive) jsonObj("url" to img) else img)))
                        }
                    }
                    "input_file" -> {
                        val fu = po.str("file_url")
                        if (fu != null && fu.isNotEmpty()) out.add(jsonObj("type" to je("image_url"), "image_url" to jsonObj("url" to je(fu))))
                    }
                }
            }
            if (out.size() == 0) return je("")
            if (out.size() == 1 && out.get(0).isJsonObject && out.get(0).asJsonObject.str("type") == "text") {
                return je(out.get(0).asJsonObject.str("text"))
            }
            return out
        }
        return je("")
    }

    
    fun responsesToCanonical(body: JsonObject, urlModel: String?): JsonObject {
        val messages = JsonArray()
        val instructions = body.get("instructions")
        if (instructions != null && !instructions.isJsonNull) {
            val s = if (instructions.isJsonPrimitive) instructions.asString
            else if (instructions.isJsonArray) instructions.asJsonArray.filter { it.isJsonObject }.joinToString("\n") { it.asJsonObject.str("text") ?: "" }
            else ""
            if (s.isNotEmpty()) messages.add(jsonObj("role" to je("system"), "content" to je(s)))
        }
        val rawInput = when {
            body.get("input")?.isJsonPrimitive == true -> jsonArr(body.get("input"))
            body.arr("input") != null -> body.arr("input")!!
            else -> JsonArray()
        }
        for (itemEl in rawInput) {
            if (itemEl.isJsonPrimitive) { messages.add(jsonObj("role" to je("user"), "content" to itemEl)); continue }
            if (!itemEl.isJsonObject) continue
            val item = itemEl.asJsonObject
            when (item.str("type")) {
                "function_call" -> {
                    val fn = JsonObject()
                    fn.put("name", item.str("name") ?: "")
                    fn.put("arguments", item.get("arguments")?.let { if (it.isJsonPrimitive) it.asString else it.toString() } ?: "{}")
                    messages.add(jsonObj(
                        "role" to je("assistant"), "content" to je(""),
                        "tool_calls" to jsonArr(jsonObj("id" to je(item.str("call_id") ?: item.str("id") ?: randId("call_")), "type" to je("function"), "function" to fn))
                    ))
                }
                "function_call_output" -> messages.add(jsonObj(
                    "role" to je("tool"), "tool_call_id" to je(item.str("call_id") ?: ""),
                    "content" to je(item.get("output")?.let { if (it.isJsonPrimitive) it.asString else it.toString() } ?: "")
                ))
                "message", null -> {
                    if (item.str("role") != null || item.str("type") == "message") {
                        var role = item.str("role") ?: "user"
                        if (role == "developer") role = "system"
                        if (role == "system" && messages.size() > 0 && messages.get(0).isJsonObject && messages.get(0).asJsonObject.str("role") == "system") {
                            val first = messages.get(0).asJsonObject
                            first.put("content", toText(first.get("content")) + "\n" + toText(responsesContentToContent(item.get("content"))))
                            continue
                        }
                        messages.add(jsonObj("role" to je(role), "content" to responsesContentToContent(item.get("content"))))
                    }
                }
                else -> {} 
            }
        }
        var tools: JsonElement? = null
        body.arr("tools")?.takeIf { it.size() > 0 }?.let { arr ->
            val out = JsonArray()
            for (t in arr) {
                if (!t.isJsonObject) continue
                val to = t.asJsonObject
                if (to.str("type") == "function") {
                    out.add(jsonObj("type" to je("function"), "function" to jsonObj(
                        "name" to je(to.str("name")), "description" to je(to.str("description") ?: ""),
                        "parameters" to (to.obj("parameters") ?: jsonObj("type" to je("object")))
                    )))
                } else out.add(t)
            }
            tools = out
        }
        var toolChoice: JsonElement? = null
        val tc = body.get("tool_choice")
        if (tc != null && !tc.isJsonNull) {
            if (tc.isJsonPrimitive) toolChoice = tc
            else if (tc.isJsonObject && tc.asJsonObject.str("type") == "function") {
                toolChoice = jsonObj("type" to je("function"), "function" to jsonObj("name" to je(tc.asJsonObject.str("name"))))
            }
        }
        return JsonObject()
            .put("model", body.str("model") ?: urlModel)
            .put("stream", body.bool("stream") ?: false)
            .putEl("messages", messages)
            .putEl("temperature", body.get("temperature"))
            .putEl("top_p", body.get("top_p"))
            .putEl("max_tokens", body.get("max_output_tokens") ?: body.get("max_tokens"))
            .putEl("stop", normStop(body.get("stop"))?.let { l -> JsonArray().apply { l.forEach { add(it) } } })
            .putEl("tools", tools)
            .putEl("tool_choice", toolChoice)
    }

    
    fun canonicalToResponsesBody(c: JsonObject): JsonObject {
        val instructions = StringBuilder()
        val input = JsonArray()
        c.arr("messages")?.forEach { mEl ->
            if (!mEl.isJsonObject) return@forEach
            val m = mEl.asJsonObject
            val role = m.str("role")
            when (role) {
                "system", "developer" -> toText(m.get("content")).takeIf { it.isNotEmpty() }?.let {
                    if (instructions.isNotEmpty()) instructions.append("\n")
                    instructions.append(it)
                }
                "assistant" -> {
                    val parts = JsonArray()
                    val content = m.get("content")
                    if (content != null && !content.isJsonNull) {
                        if (content.isJsonPrimitive) { if (content.asString.isNotEmpty()) parts.add(jsonObj("type" to je("output_text"), "text" to content)) }
                        else if (content.isJsonArray) {
                            for (p in content.asJsonArray) {
                                if (!p.isJsonObject) continue
                                val po = p.asJsonObject
                                if (po.str("type") == "text" && po.str("text") != null) parts.add(jsonObj("type" to je("output_text"), "text" to je(po.str("text"))))
                                else if (po.str("type") == "image_url" && po.obj("image_url")?.str("url") != null) parts.add(jsonObj("type" to je("input_image"), "image_url" to je(po.obj("image_url")!!.str("url"))))
                            }
                        }
                    }
                    m.arr("tool_calls")?.forEach { tcEl ->
                        if (!tcEl.isJsonObject) return@forEach
                        val tc = tcEl.asJsonObject
                        val fn = tc.obj("function")
                        input.add(jsonObj(
                            "type" to je("function_call"),
                            "call_id" to je(tc.str("id") ?: randId("call_")),
                            "name" to je(fn?.str("name") ?: ""),
                            "arguments" to je(fn?.get("arguments")?.let { if (it.isJsonPrimitive) it.asString else it.toString() } ?: "{}")
                        ))
                    }
                    if (parts.size() > 0) input.add(jsonObj("type" to je("message"), "role" to je("assistant"), "content" to parts))
                }
                "tool" -> input.add(jsonObj("type" to je("function_call_output"), "call_id" to je(m.str("tool_call_id") ?: ""), "output" to je(toText(m.get("content")))))
                else -> {
                    val content = m.get("content")
                    val contentEl: JsonElement = when {
                        content == null || content.isJsonNull -> je(" ")
                        content.isJsonPrimitive -> content
                        content.isJsonArray -> {
                            val arr = JsonArray()
                            for (p in content.asJsonArray) {
                                if (!p.isJsonObject) continue
                                val po = p.asJsonObject
                                when (po.str("type")) {
                                    "text" -> po.str("text")?.let { arr.add(jsonObj("type" to je("input_text"), "text" to je(it))) }
                                    "image_url" -> po.obj("image_url")?.str("url")?.let { arr.add(jsonObj("type" to je("input_image"), "image_url" to je(it))) }
                                }
                            }
                            arr
                        }
                        else -> je(" ")
                    }
                    input.add(jsonObj("type" to je("message"), "role" to je("user"), "content" to contentEl))
                }
            }
        }
        if (input.size() == 0) input.add(je(" "))
        val body = JsonObject()
            .put("model", c.str("model"))
            .putEl("input", input)
            .put("stream", c.bool("stream") ?: false)
        if (instructions.isNotEmpty()) body.put("instructions", instructions.toString())
        body.putEl("temperature", c.get("temperature"))
        body.putEl("top_p", c.get("top_p"))
        c.int("max_tokens")?.let { body.put("max_output_tokens", it) }
        c.arr("stop")?.takeIf { it.size() > 0 }?.let { body.add("stop", it) }
        c.arr("tools")?.takeIf { it.size() > 0 }?.let { arr ->
            val out = JsonArray()
            for (t in arr) {
                if (!t.isJsonObject) continue
                val to = t.asJsonObject
                if (to.str("type") == "function" && to.obj("function") != null) {
                    val f = to.obj("function")!!
                    out.add(jsonObj("type" to je("function"), "name" to je(f.str("name")), "description" to je(f.str("description") ?: ""),
                        "parameters" to (f.obj("parameters") ?: jsonObj("type" to je("object")))))
                } else out.add(t)
            }
            body.add("tools", out)
            val tc = c.get("tool_choice")
            when {
                tc == null || tc.isJsonNull -> {}
                tc.isJsonPrimitive && (tc.asString == "required" || tc.asString == "none" || tc.asString == "auto") -> body.add("tool_choice", tc)
                tc.isJsonObject && tc.asJsonObject.str("type") == "function" && tc.asJsonObject.obj("function")?.str("name") != null ->
                    body.add("tool_choice", jsonObj("type" to je("function"), "name" to je(tc.asJsonObject.obj("function")!!.str("name"))))
                else -> body.put("tool_choice", "auto")
            }
        }
        return body
    }

    
    fun responsesRespToCanonical(j: JsonObject): JsonObject {
        val text = StringBuilder()
        val reasoning = StringBuilder()
        val toolCalls = JsonArray()
        j.arr("output")?.forEach { itemEl ->
            if (!itemEl.isJsonObject) return@forEach
            val item = itemEl.asJsonObject
            when (item.str("type")) {
                "message" -> item.arr("content")?.forEach { p ->
                    if (p.isJsonObject && p.asJsonObject.str("type") == "output_text") text.append(p.asJsonObject.str("text") ?: "")
                }
                "function_call" -> {
                    val fn = JsonObject()
                    fn.put("name", item.str("name") ?: "")
                    fn.put("arguments", item.get("arguments")?.let { if (it.isJsonPrimitive) it.asString else it.toString() } ?: "{}")
                    toolCalls.add(jsonObj("id" to je(item.str("id") ?: item.str("call_id") ?: randId("call_")), "type" to je("function"), "function" to fn))
                }
                "reasoning" -> item.arr("summary")?.forEach { s ->
                    if (s.isJsonObject && s.asJsonObject.str("type") == "summary_text") reasoning.append(s.asJsonObject.str("text") ?: "")
                }
            }
        }
        val usage = j.obj("usage") ?: JsonObject()
        val st = j.str("status") ?: "completed"
        var finish = "stop"
        if (st == "incomplete") finish = "length"
        else if (st == "failed") finish = "content_filter"
        if (toolCalls.size() > 0) finish = "tool_calls"
        val out = JsonObject()
            .put("text", text.toString())
            .apply { if (reasoning.isNotEmpty()) put("reasoning", reasoning.toString()) }
            .apply { if (toolCalls.size() > 0) add("tool_calls", toolCalls) }
            .put("finish_reason", finish)
        out.add("usage", jsonObj("input" to je(usage.int("input_tokens") ?: 0), "output" to je(usage.int("output_tokens") ?: 0)))
        return out
    }

    
    fun canonicalToResponsesResp(cresp: JsonObject, model: String): JsonObject {
        val output = JsonArray()
        cresp.str("reasoning")?.let {
            output.add(jsonObj("type" to je("reasoning"), "id" to je(randId("rs_")),
                "summary" to jsonArr(jsonObj("type" to je("summary_text"), "text" to je(it)))))
        }
        cresp.arr("tool_calls")?.forEach { tcEl ->
            if (!tcEl.isJsonObject) return@forEach
            val tc = tcEl.asJsonObject
            val fn = tc.obj("function")
            output.add(jsonObj(
                "type" to je("function_call"), "id" to je(randId("fc_")), "call_id" to je(tc.str("id") ?: randId("call_")),
                "name" to je(fn?.str("name") ?: ""),
                "arguments" to je(fn?.get("arguments")?.let { if (it.isJsonPrimitive) it.asString else it.toString() } ?: "{}"),
                "status" to je("completed")
            ))
        }
        val text = cresp.str("text") ?: ""
        val msgContent = JsonArray()
        if (text.isNotEmpty()) msgContent.add(jsonObj("type" to je("output_text"), "text" to je(text), "annotations" to JsonArray()))
        output.add(jsonObj("type" to je("message"), "id" to je(randId("msg_")), "status" to je("completed"), "role" to je("assistant"), "content" to msgContent))
        val usage = cresp.obj("usage") ?: JsonObject()
        val inT = usage.int("input") ?: 0
        val outT = usage.int("output") ?: 0
        val finish = cresp.str("finish_reason")
        val status = if (finish == "length" || finish == "content_filter") "incomplete" else "completed"
        return jsonObj(
            "id" to je(randId("resp_")), "object" to je("response"), "created_at" to je(nowSec()), "status" to je(status), "model" to je(model),
            "output" to output,
            "incomplete_details" to (if (finish == "length") jsonObj("reason" to je("max_output_tokens")) else JsonNull.INSTANCE),
            "instructions" to JsonNull.INSTANCE, "metadata" to jsonObj(), "parallel_tool_calls" to je(true),
            "usage" to jsonObj("input_tokens" to je(inT), "output_tokens" to je(outT), "total_tokens" to je(inT + outT)),
            "error" to JsonNull.INSTANCE
        )
    }

    
    fun buildResponsesStreamChunks(cresp: JsonObject, model: String): List<String> {
        val out = ArrayList<String>()
        val respId = randId("resp_")
        val msgId = randId("msg_")
        val created = nowSec()
        val text = cresp.str("text") ?: ""
        val usage = cresp.obj("usage") ?: JsonObject()
        val inT = usage.int("input") ?: 0
        val outT = usage.int("output") ?: 0
        val finish = cresp.str("finish_reason") ?: "stop"
        fun base(status: String) = jsonObj(
            "id" to je(respId), "object" to je("response"), "created_at" to je(created), "status" to je(status), "model" to je(model),
            "output" to JsonArray(), "incomplete_details" to JsonNull.INSTANCE, "instructions" to JsonNull.INSTANCE,
            "metadata" to jsonObj(), "parallel_tool_calls" to je(true), "temperature" to JsonNull.INSTANCE, "top_p" to JsonNull.INSTANCE,
            "max_output_tokens" to JsonNull.INSTANCE, "tools" to JsonArray(), "tool_choice" to je("auto"), "usage" to JsonNull.INSTANCE, "error" to JsonNull.INSTANCE
        )
        out.add(jsonObj("type" to je("response.created"), "response" to base("in_progress")).toString())
        out.add(jsonObj("type" to je("response.in_progress"), "response" to base("in_progress")).toString())
        var nextIdx = 0
        cresp.str("reasoning")?.let { r ->
            val rid = randId("rs_")
            out.add(jsonObj("type" to je("response.output_item.added"), "output_index" to je(nextIdx),
                "item" to jsonObj("id" to je(rid), "type" to je("reasoning"), "status" to je("in_progress"), "summary" to JsonArray())).toString())
            out.add(jsonObj("type" to je("response.reasoning_summary_text.delta"), "item_id" to je(rid), "output_index" to je(nextIdx), "delta" to je(r)).toString())
            out.add(jsonObj("type" to je("response.output_item.done"), "output_index" to je(nextIdx),
                "item" to jsonObj("id" to je(rid), "type" to je("reasoning"), "status" to je("completed"), "summary" to jsonArr(jsonObj("type" to je("summary_text"), "text" to je(r))))).toString())
            nextIdx++
        }
        cresp.arr("tool_calls")?.forEach { tcEl ->
            if (!tcEl.isJsonObject) return@forEach
            val tc = tcEl.asJsonObject
            val fn = tc.obj("function")
            val fcId = randId("fc_")
            val callId = tc.str("id") ?: randId("call_")
            val args = fn?.get("arguments")?.let { if (it.isJsonPrimitive) it.asString else it.toString() } ?: "{}"
            out.add(jsonObj("type" to je("response.output_item.added"), "output_index" to je(nextIdx),
                "item" to jsonObj("id" to je(fcId), "type" to je("function_call"), "status" to je("in_progress"), "call_id" to je(callId), "name" to je(fn?.str("name") ?: ""), "arguments" to je(""))).toString())
            out.add(jsonObj("type" to je("response.function_call_arguments.delta"), "item_id" to je(fcId), "output_index" to je(nextIdx), "delta" to je(args)).toString())
            out.add(jsonObj("type" to je("response.output_item.done"), "output_index" to je(nextIdx),
                "item" to jsonObj("id" to je(fcId), "type" to je("function_call"), "status" to je("completed"), "call_id" to je(callId), "name" to je(fn?.str("name") ?: ""), "arguments" to je(args))).toString())
            nextIdx++
        }
        val part = jsonObj("type" to je("output_text"), "text" to je(text), "annotations" to JsonArray())
        out.add(jsonObj("type" to je("response.output_item.added"), "output_index" to je(nextIdx),
            "item" to jsonObj("id" to je(msgId), "type" to je("message"), "status" to je("in_progress"), "role" to je("assistant"), "content" to JsonArray())).toString())
        out.add(jsonObj("type" to je("response.content_part.added"), "item_id" to je(msgId), "output_index" to je(nextIdx), "content_index" to je(0), "part" to part).toString())
        if (text.isNotEmpty()) out.add(jsonObj("type" to je("response.output_text.delta"), "item_id" to je(msgId), "output_index" to je(nextIdx), "content_index" to je(0), "delta" to je(text)).toString())
        out.add(jsonObj("type" to je("response.output_text.done"), "item_id" to je(msgId), "output_index" to je(nextIdx), "content_index" to je(0), "part" to part).toString())
        out.add(jsonObj("type" to je("response.content_part.done"), "item_id" to je(msgId), "output_index" to je(nextIdx), "content_index" to je(0), "part" to part).toString())
        out.add(jsonObj("type" to je("response.output_item.done"), "output_index" to je(nextIdx),
            "item" to jsonObj("id" to je(msgId), "type" to je("message"), "status" to je("completed"), "role" to je("assistant"), "content" to jsonArr(part))).toString())
        val finStatus = if (finish == "length") "incomplete" else if (finish == "content_filter") "failed" else "completed"
        val full = base(finStatus)
        full.add("incomplete_details", if (finStatus == "incomplete") jsonObj("reason" to je("max_output_tokens")) else JsonNull.INSTANCE)
        full.add("usage", jsonObj("input_tokens" to je(inT), "output_tokens" to je(outT), "total_tokens" to je(inT + outT)))
        if (finStatus == "failed") full.add("error", jsonObj("code" to je("server_error"), "message" to je("upstream finished with content_filter")))
        out.add(jsonObj("type" to je("response.$finStatus"), "response" to full).toString())
        return out
    }

    fun claudeFinish(reason: String?): String =
        mapOf("stop" to "end_turn", "length" to "max_tokens", "tool_calls" to "tool_use", "content_filter" to "refusal")[reason] ?: "end_turn"

    fun geminiFinish(reason: String?): String =
        mapOf("stop" to "STOP", "length" to "MAX_TOKENS", "tool_calls" to "STOP", "content_filter" to "SAFETY")[reason] ?: "STOP"

    
    private fun JsonElement.asJsonArrayOrNull(): JsonArray? = if (isJsonArray) asJsonArray else null

    val TO_CANON: Map<String, (JsonObject, String?) -> JsonObject> = mapOf(
        "openai" to { b, m -> openaiToCanonical(b, m) },
        "claude" to { b, m -> claudeToCanonical(b, m) },
        "gemini" to { b, m -> geminiToCanonical(b, m) }
    )

    val UP_RESP: Map<String, (JsonObject) -> JsonObject> = mapOf(
        "openai" to { j -> openaiRespToCanonical(j) },
        "claude" to { j -> claudeRespToCanonical(j) },
        "gemini" to { j -> geminiRespToCanonical(j) }
    )

    val BUILD_BODY: Map<String, (JsonObject) -> JsonObject> = mapOf(
        "openai" to { c -> canonicalToOpenAIBody(c) },
        "claude" to { c -> canonicalToClaudeBody(c) },
        "gemini" to { c -> canonicalToGeminiBody(c) }
    )
}
