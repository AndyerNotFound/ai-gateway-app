package com.aigateway.app.data

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.io.ByteArrayOutputStream
import java.util.zip.Deflater
import java.util.zip.Inflater

/**
 * 二维码编解码 —— 配置导入导出用。
 *
 * 容量: QR 版本40 + 纠错L 最多约 2953 字节。配置常超限, 所以:
 *   1) 先 deflate 压缩 + Base64 → 通常能压到 30-40%
 *   2) 仍超限则报明确错误(建议改用文件导出)
 * 载荷格式: "AGWQR1:" + base64(deflate(json 或 AGWENC1 文本))
 */
object QrCodec {

    private const val MAGIC = "AGWQR1:"
    /** QR 单码安全容量(字节, 留余量) */
    private const val MAX_PAYLOAD = 2600

    class QrTooLargeException(val actual: Int, val limit: Int = MAX_PAYLOAD) :
        Exception("payload too large: $actual > $limit")

    /** 把文本编码为二维码载荷字符串 */
    fun buildPayload(text: String): String {
        val compressed = deflate(text.toByteArray(Charsets.UTF_8))
        val b64 = android.util.Base64.encodeToString(compressed, android.util.Base64.NO_WRAP)
        val payload = MAGIC + b64
        if (payload.length > MAX_PAYLOAD) throw QrTooLargeException(payload.length)
        return payload
    }

    /** 从二维码载荷还原文本; 非本格式则原样返回(兼容直接扫明文 JSON) */
    fun parsePayload(payload: String): String {
        val t = payload.trim()
        if (!t.startsWith(MAGIC)) return t
        val raw = android.util.Base64.decode(t.substring(MAGIC.length), android.util.Base64.DEFAULT)
        return String(inflate(raw), Charsets.UTF_8)
    }

    /** 生成二维码位图 */
    fun encodeBitmap(payload: String, size: Int = 720): Bitmap {
        val hints = mapOf(
            EncodeHintType.CHARACTER_SET to "UTF-8",
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.L,
            EncodeHintType.MARGIN to 1
        )
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size, hints)
        val w = matrix.width
        val h = matrix.height
        val pixels = IntArray(w * h)
        for (y in 0 until h) {
            val off = y * w
            for (x in 0 until w) {
                pixels[off + x] = if (matrix[x, y]) Color.BLACK else Color.WHITE
            }
        }
        return Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply {
            setPixels(pixels, 0, w, 0, 0, w, h)
        }
    }

    /** 从位图解码二维码; 失败返回 null */
    fun decodeBitmap(bitmap: Bitmap): String? {
        val w = bitmap.width
        val h = bitmap.height
        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
        val source = RGBLuminanceSource(w, h, pixels)
        val hints = mapOf(
            DecodeHintType.TRY_HARDER to true,
            DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
            DecodeHintType.CHARACTER_SET to "UTF-8"
        )
        // 正常 + 反色两次尝试
        for (src in listOf(source, source.invert())) {
            runCatching {
                val result = MultiFormatReader().apply { setHints(hints) }
                    .decodeWithState(BinaryBitmap(HybridBinarizer(src)))
                return result.text
            }
        }
        return null
    }

    // ---------- 压缩 ----------

    private fun deflate(data: ByteArray): ByteArray {
        val deflater = Deflater(Deflater.BEST_COMPRESSION)
        deflater.setInput(data)
        deflater.finish()
        val out = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        while (!deflater.finished()) {
            val n = deflater.deflate(buf)
            out.write(buf, 0, n)
        }
        deflater.end()
        return out.toByteArray()
    }

    private fun inflate(data: ByteArray): ByteArray {
        val inflater = Inflater()
        inflater.setInput(data)
        val out = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        while (!inflater.finished()) {
            val n = inflater.inflate(buf)
            if (n == 0 && inflater.needsInput()) break
            out.write(buf, 0, n)
        }
        inflater.end()
        return out.toByteArray()
    }
}
