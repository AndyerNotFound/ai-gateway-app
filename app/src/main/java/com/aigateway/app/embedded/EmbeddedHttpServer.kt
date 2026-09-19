package com.aigateway.app.embedded

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.atomic.AtomicBoolean






class EmbeddedHttpServer(private val engine: GatewayEngine) {

    private var serverSocket: ServerSocket? = null
    private var scope: CoroutineScope? = null
    private val running = AtomicBoolean(false)

    val isRunning: Boolean get() = running.get()

    @Synchronized
    fun start(port: Int): Boolean {
        if (running.get()) return true
        return try {
            val ss = ServerSocket(port)
            serverSocket = ss
            val sc = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            scope = sc
            running.set(true)
            sc.launch { acceptLoop(ss) }
            true
        } catch (e: Exception) {
            running.set(false)
            false
        }
    }

    @Synchronized
    fun stop() {
        running.set(false)
        runCatching { serverSocket?.close() }
        serverSocket = null
        scope?.cancel()
        scope = null
    }

    private suspend fun acceptLoop(ss: ServerSocket) {
        while (running.get()) {
            val socket = try { ss.accept() } catch (e: Exception) { break }
            scope?.launch { runCatching { handleConnection(socket) } }
        }
    }

    

    private fun readHeaderLine(input: InputStream): String? {
        val out = ByteArrayOutputStream()
        var readAny = false
        while (true) {
            val c = input.read()
            if (c == -1) return if (readAny) out.toString(Charsets.ISO_8859_1.name()) else null
            readAny = true
            if (c == 0x0A) break
            if (c != 0x0D) out.write(c)
        }
        return out.toString(Charsets.ISO_8859_1.name())
    }

    private fun readFully(input: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(buf, off, n - off)
            if (r < 0) break
            off += r
        }
        return if (off == n) buf else buf.copyOf(off)
    }

    private class HttpRequest(
        val method: String, val path: String, val query: Map<String, String>,
        val headers: Map<String, String>, val body: String,
        val rawBody: ByteArray = ByteArray(0),
        val contentType: String = ""
    )

    private fun parseRequest(input: InputStream): HttpRequest? {
        val requestLine = readHeaderLine(input) ?: return null
        val parts = requestLine.split(" ")
        if (parts.size < 2) return null
        val method = parts[0].uppercase()
        val fullPath = parts[1]
        val qIdx = fullPath.indexOf('?')
        val path = if (qIdx >= 0) fullPath.substring(0, qIdx) else fullPath
        val query = LinkedHashMap<String, String>()
        if (qIdx >= 0) {
            fullPath.substring(qIdx + 1).split("&").forEach { kv ->
                val eq = kv.indexOf('=')
                if (eq > 0) query[urlDec(kv.substring(0, eq))] = urlDec(kv.substring(eq + 1))
            }
        }
        val headers = LinkedHashMap<String, String>()
        while (true) {
            val line = readHeaderLine(input) ?: break
            if (line.isEmpty()) break
            val idx = line.indexOf(':')
            if (idx > 0) headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
        }
        val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
        
        val rawBody = if (contentLength > 0) readFully(input, contentLength) else ByteArray(0)
        val body = String(rawBody, Charsets.UTF_8)
        return HttpRequest(method, path, query, headers, body, rawBody, headers["content-type"] ?: "")
    }

    private fun urlDec(s: String): String = try { URLDecoder.decode(s, "UTF-8") } catch (e: Exception) { s }

    

    private fun reason(status: Int): String = when (status) {
        200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 404 -> "Not Found"
        405 -> "Method Not Allowed"; 413 -> "Payload Too Large"; 500 -> "Internal Server Error"
        502 -> "Bad Gateway"; 503 -> "Service Unavailable"; else -> "Status"
    }

    private fun writeJson(out: OutputStream, status: Int, json: JsonObject, extraHeaders: Map<String, String> = emptyMap()) {
        val body = json.toString().toByteArray(Charsets.UTF_8)
        val sb = StringBuilder("HTTP/1.1 $status ${reason(status)}\r\n")
        sb.append("Content-Type: application/json; charset=utf-8\r\n")
        sb.append("Access-Control-Allow-Origin: *\r\n")
        extraHeaders.forEach { (k, v) -> sb.append("$k: $v\r\n") }
        sb.append("Content-Length: ${body.size}\r\nConnection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        out.write(body)
        out.flush()
    }

    
    private fun writeRaw(out: OutputStream, status: Int, bytes: ByteArray, contentType: String, extraHeaders: Map<String, String> = emptyMap()) {
        val sb = StringBuilder("HTTP/1.1 $status ${reason(status)}\r\n")
        sb.append("Content-Type: $contentType\r\n")
        sb.append("Access-Control-Allow-Origin: *\r\n")
        extraHeaders.forEach { (k, v) -> sb.append("$k: $v\r\n") }
        sb.append("Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        out.write(bytes)
        out.flush()
    }

    private fun writeSseHead(out: OutputStream, channelName: String) {
        val sb = StringBuilder("HTTP/1.1 200 OK\r\n")
        sb.append("Content-Type: text/event-stream\r\nCache-Control: no-cache\r\n")
        sb.append("Access-Control-Allow-Origin: *\r\nX-AI-Gateway-Channel: $channelName\r\nConnection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        out.flush()
    }

    private fun writeSseData(out: OutputStream, data: String) {
        out.write("data: $data\n\n".toByteArray(Charsets.UTF_8))
        out.flush()
    }

    

    private fun checkGatewayKey(req: HttpRequest): Boolean {
        val k = engine.gatewayKey()
        if (k.isBlank()) return true
        val auth = req.headers["authorization"] ?: ""
        if (auth.startsWith("Bearer ") && auth.substring(7).trim() == k) return true
        if (req.headers["x-api-key"] == k) return true
        if (req.headers["x-goog-api-key"] == k) return true
        if (req.query["key"] == k) return true
        return false
    }

    

    private suspend fun handleConnection(socket: Socket) {
        socket.soTimeout = 120000
        val input = socket.getInputStream()
        val out = socket.getOutputStream()
        try {
            val req = parseRequest(input) ?: return
            route(req, out)
        } finally {
            runCatching { socket.close() }
        }
    }

    private val geminiRe = Regex("^/v1(?:beta|alpha)?/models/([^:]+):(generateContent|streamGenerateContent|countTokens)$")

    
    private val extraEndpoints = setOf(
        "/v1/images/generations", "/v1/images/edits", "/v1/images/variations",
        "/v1/embeddings",
        "/v1/audio/speech", "/v1/audio/transcriptions", "/v1/audio/translations",
        "/v1/completions",
        "/v1/moderations"
    )

    private suspend fun route(req: HttpRequest, out: OutputStream) {
        val p = req.path
        if (req.method == "OPTIONS") {
            out.write("HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: *\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
            out.flush(); return
        }
        if (req.method == "GET" && p == "/health") {
            writeJson(out, 200, jsonObj("ok" to je(true), "version" to je("embedded-0.1"), "uptime" to je(engine.getStats().uptime))); return
        }
        if (req.method == "GET" && p == "/status") {
            val c = engine.getConfig()
            val st = engine.getStats()
            writeJson(out, 200, jsonObj(
                "ok" to je(true), "version" to je("embedded-0.1"), "uptime" to je(st.uptime),
                "port" to je(c.port),
                "stats" to jsonObj("requests" to je(st.requests), "errors" to je(st.errors))
            )); return
        }
        if (req.method == "GET" && (p == "/v1/models" || p == "/v1beta/models")) {
            if (!checkGatewayKey(req)) { writeJson(out, 401, engine.errorBody("openai", 401, "invalid gateway key")); return }
            val fmt = if (p == "/v1beta/models") "gemini" else "openai"
            writeJson(out, 200, engine.modelsResponse(fmt)); return
        }
        
        if (req.method == "POST" && engine.openaiExtrasEnabled() && extraEndpoints.contains(p)) {
            if (!checkGatewayKey(req)) { writeJson(out, 401, engine.errorBody("openai", 401, "invalid gateway key")); return }
            when (val r = engine.extraEndpoint(p, req.rawBody, req.contentType)) {
                is GatewayEngine.ExtraResult.Raw -> writeRaw(out, r.status, r.bytes, r.contentType, mapOf("X-AI-Gateway-Channel" to ""))
                is GatewayEngine.ExtraResult.Fail -> writeJson(out, r.status, engine.errorBody("openai", r.status, r.message))
            }
            return
        }
        if (req.method != "POST") {
            writeJson(out, 404, engine.errorBody("openai", 404, "not found: ${req.method} $p")); return
        }

        
        var clientFormat: String? = null
        var clientApi = "chat"
        var urlModel: String? = null
        var forceStream = false
        when {
            p == "/v1/chat/completions" || p == "/chat/completions" -> clientFormat = "openai"
            p == "/v1/messages" || p == "/messages" -> clientFormat = "claude"
            p == "/v1/responses" -> {
                if (!engine.openaiExtrasEnabled()) {
                    writeJson(out, 404, engine.errorBody("openai", 404, "unknown endpoint: $p (OpenAI 扩展端点未开启)")); return
                }
                clientFormat = "openai"
                clientApi = "responses"
            }
            else -> {
                val m = geminiRe.find(p)
                if (m != null) {
                    clientFormat = "gemini"
                    urlModel = urlDec(m.groupValues[1])
                    forceStream = m.groupValues[2] == "streamGenerateContent"
                    if (m.groupValues[2] == "countTokens") {
                        writeJson(out, 501, engine.errorBody("gemini", 501, "countTokens not supported")); return
                    }
                }
            }
        }
        if (clientFormat == null) {
            writeJson(out, 404, engine.errorBody("openai", 404, "unknown endpoint: $p")); return
        }

        val keyOk = checkGatewayKey(req)
        val bodyJson = try {
            JsonParser.parseString(req.body.ifBlank { "{}" }).asJsonObject
        } catch (e: Exception) {
            writeJson(out, 400, engine.errorBody(clientFormat, 400, "invalid JSON body")); return
        }

        
        var headWritten = false
        engine.chat(clientFormat, bodyJson, urlModel, forceStream, keyOk, clientApi).collect { ev ->
            when (ev) {
                is EngineEvent.Head -> {
                    if (ev.streaming) { writeSseHead(out, ev.channelName); headWritten = true }
                }
                is EngineEvent.Sse -> {
                    if (!headWritten) { writeSseHead(out, ""); headWritten = true }
                    writeSseData(out, ev.data)
                }
                is EngineEvent.JsonBody -> {
                    writeJson(out, 200, ev.body, mapOf("X-AI-Gateway-Channel" to ""))
                }
                is EngineEvent.Fail -> {
                    writeJson(out, ev.status, engine.errorBody(clientFormat, ev.status, ev.message))
                }
            }
        }
        
        if (headWritten && clientFormat == "openai") {
            runCatching {
                out.write("data: [DONE]\n\n".toByteArray(Charsets.UTF_8))
                out.flush()
            }
        }
    }
}
