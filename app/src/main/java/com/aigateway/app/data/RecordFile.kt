package com.aigateway.app.data

import com.google.gson.GsonBuilder
import com.google.gson.JsonElement
import com.google.gson.JsonParser
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader

/** ai-gateway-AI 的本地请求记录（log/requests-<inst>.jsonl 或等价的 JSON 数组）。 */
data class RequestRecord(
    val id: String,
    val time: String,
    val model: String,
    val channel: String,
    val status: Int,
    val duration: Long,
    val format: String,
    val instance: String,
    val request: String,
    val response: String,
)

object RecordParser {

    private val pretty = GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create()
    private const val MAX_ARRAY_CHARS = 32 * 1024 * 1024

    data class Result(val records: List<RequestRecord>, val error: String? = null)

    fun parse(input: InputStream, maxRecords: Int = 2000): Result {
        return try {
            val reader = BufferedReader(InputStreamReader(input, Charsets.UTF_8))
            val first = firstNonWhitespace(reader)
            if (first == '[') Result(parseArray(readBounded(reader, MAX_ARRAY_CHARS), maxRecords))
            else Result(parseLines(reader, maxRecords))
        } catch (t: Throwable) {
            Result(emptyList(), t.message ?: t.javaClass.simpleName)
        }
    }

    /** JSON 数组必须整体解析；超过上限直接报错，避免大文件把内存打爆。 */
    private fun readBounded(reader: BufferedReader, limit: Int): String {
        val sb = StringBuilder()
        val buf = CharArray(16 * 1024)
        var total = 0
        while (true) {
            val n = reader.read(buf)
            if (n < 0) break
            total += n
            if (total > limit) throw IllegalStateException("JSON array larger than ${limit / 1024 / 1024}MB")
            sb.append(buf, 0, n)
        }
        return sb.toString()
    }

    private fun firstNonWhitespace(reader: BufferedReader): Char {
        reader.mark(4096)
        var c = reader.read()
        while (c != -1 && c.toChar().isWhitespace()) c = reader.read()
        reader.reset()
        return if (c == -1) '\u0000' else c.toChar()
    }

    private fun parseArray(text: String, max: Int): List<RequestRecord> {
        val arr = JsonParser.parseString(text)
        if (!arr.isJsonArray) return emptyList()
        val out = ArrayList<RequestRecord>()
        for (el in arr.asJsonArray) {
            toRecord(el)?.let { out.add(it) }
            if (out.size >= max) break
        }
        return out.asReversed()
    }

    private fun parseLines(reader: BufferedReader, max: Int): List<RequestRecord> {
        val out = ArrayList<RequestRecord>()
        reader.forEachLine { line ->
            if (line.isBlank()) return@forEachLine
            try {
                toRecord(JsonParser.parseString(line))?.let { out.add(it) }
            } catch (_: Exception) {}
        }
        if (out.size > max) return out.subList(out.size - max, out.size).asReversed()
        return out.asReversed()
    }

    private fun toRecord(el: JsonElement): RequestRecord? {
        if (!el.isJsonObject) return null
        val o = el.asJsonObject
        val id = o.get("id")?.let { if (it.isJsonPrimitive) it.asString else "" }.orEmpty()
        if (id.isBlank() && !o.has("request") && !o.has("response")) return null
        return RequestRecord(
            id = id,
            time = str(o, "time"),
            model = str(o, "model"),
            channel = str(o, "channel"),
            status = num(o, "status"),
            duration = num(o, "duration").toLong(),
            format = str(o, "format"),
            instance = str(o, "instance"),
            request = render(o.get("request")),
            response = render(o.get("response")),
        )
    }

    private fun str(o: com.google.gson.JsonObject, k: String): String {
        val v = o.get(k) ?: return ""
        return if (v.isJsonPrimitive) v.asString else v.toString()
    }

    private fun num(o: com.google.gson.JsonObject, k: String): Int {
        val v = o.get(k) ?: return 0
        return try { if (v.isJsonPrimitive) v.asInt else 0 } catch (_: Exception) { 0 }
    }

    /** 对象/数组美化；字符串尝试按 JSON 美化（SSE 等多行文本保持原样）。 */
    fun render(el: JsonElement?): String {
        if (el == null || el.isJsonNull) return ""
        return if (el.isJsonPrimitive) {
            val s = el.asString
            val trimmed = s.trim()
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                try { pretty.toJson(JsonParser.parseString(trimmed)) } catch (_: Exception) { s }
            } else s
        } else {
            try { pretty.toJson(el) } catch (_: Exception) { el.toString() }
        }
    }
}
