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









object QrCodec {

    private const val MAGIC = "AGWQR1:"
    
    private const val MAX_PAYLOAD = 2600

    class QrTooLargeException(val actual: Int, val limit: Int = MAX_PAYLOAD) :
        Exception("payload too large: $actual > $limit")

    
    fun buildPayload(text: String): String {
        val compressed = deflate(text.toByteArray(Charsets.UTF_8))
        val b64 = android.util.Base64.encodeToString(compressed, android.util.Base64.NO_WRAP)
        val payload = MAGIC + b64
        if (payload.length > MAX_PAYLOAD) throw QrTooLargeException(payload.length)
        return payload
    }

    
    fun parsePayload(payload: String): String {
        val t = payload.trim()
        if (!t.startsWith(MAGIC)) return t
        val raw = android.util.Base64.decode(t.substring(MAGIC.length), android.util.Base64.DEFAULT)
        return String(inflate(raw), Charsets.UTF_8)
    }

    
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
        
        for (src in listOf(source, source.invert())) {
            runCatching {
                val result = MultiFormatReader().apply { setHints(hints) }
                    .decodeWithState(BinaryBitmap(HybridBinarizer(src)))
                return result.text
            }
        }
        return null
    }

    

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
