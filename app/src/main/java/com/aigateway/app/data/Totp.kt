package com.aigateway.app.data

import java.io.ByteArrayOutputStream
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** RFC 6238 TOTP（SHA-1 / 30s / 6 位），用于 ai-gateway-AI 的 x-totp 请求头。 */
object Totp {

    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    fun code(secret: String, timeMs: Long = System.currentTimeMillis()): String {
        val key = base32Decode(secret)
        if (key.isEmpty()) return ""
        val counter = timeMs / 1000 / 30
        val msg = ByteArray(8) { i -> (counter ushr (56 - i * 8)).toByte() }
        val mac = Mac.getInstance("HmacSHA1")
        mac.init(SecretKeySpec(key, "HmacSHA1"))
        val hash = mac.doFinal(msg)
        val off = hash[hash.size - 1].toInt() and 0x0f
        val bin = ((hash[off].toInt() and 0x7f) shl 24) or
                ((hash[off + 1].toInt() and 0xff) shl 16) or
                ((hash[off + 2].toInt() and 0xff) shl 8) or
                (hash[off + 3].toInt() and 0xff)
        return (bin % 1_000_000).toString().padStart(6, '0')
    }

    private fun base32Decode(raw: String): ByteArray {
        val s = raw.uppercase().replace(" ", "").replace("-", "").trimEnd('=')
        if (s.isEmpty()) return ByteArray(0)
        val out = ByteArrayOutputStream()
        var buffer = 0
        var bits = 0
        for (c in s) {
            val v = ALPHABET.indexOf(c)
            if (v < 0) continue
            buffer = ((buffer shl 5) or v) and 0x1fff
            bits += 5
            if (bits >= 8) {
                bits -= 8
                out.write((buffer ushr bits) and 0xff)
            }
        }
        return out.toByteArray()
    }
}
