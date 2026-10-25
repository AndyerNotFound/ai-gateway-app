package com.aigateway.app.data

import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 配置加解密 —— 与 ai-gateway 的 crypt.js 完全兼容。
 *
 * 格式: "AGWENC1:" + base64(salt[16] | iv[12] | authTag[16] | ciphertext)
 * 算法: AES-256-GCM, 密钥 = scrypt(pass, salt, N=16384, r=8, p=1) → 32 字节
 *
 * 注: Android 无内置 scrypt API, 这里用纯 Kotlin 实现(RFC 7914)。
 */
object ConfigCrypto {

    const val MAGIC = "AGWENC1:"
    private const val SALT_LEN = 16
    private const val IV_LEN = 12
    private const val TAG_LEN = 16
    private const val KEY_LEN = 32
    private const val SCRYPT_N = 16384
    private const val SCRYPT_R = 8
    private const val SCRYPT_P = 1

    fun isEncrypted(text: String): Boolean = text.trimStart().startsWith(MAGIC)

    /** 加密为 AGWENC1 文本 */
    fun encrypt(plain: String, pass: String): String {
        val rnd = SecureRandom()
        val salt = ByteArray(SALT_LEN).also { rnd.nextBytes(it) }
        val iv = ByteArray(IV_LEN).also { rnd.nextBytes(it) }
        val key = deriveKey(pass, salt)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_LEN * 8, iv))
        val out = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        // Java GCM 输出 = ciphertext || tag; Node 格式是 tag 在前
        val ct = out.copyOfRange(0, out.size - TAG_LEN)
        val tag = out.copyOfRange(out.size - TAG_LEN, out.size)
        val body = salt + iv + tag + ct
        return MAGIC + Base64.encodeToString(body, Base64.NO_WRAP)
    }

    /**
     * 解密 AGWENC1 文本。口令错误/数据损坏抛 CryptoException。
     */
    fun decrypt(enc: String, pass: String): String {
        val trimmed = enc.trim()
        if (!isEncrypted(trimmed)) throw CryptoException("不是 AGWENC1 加密内容")
        val body = try {
            Base64.decode(trimmed.substring(MAGIC.length), Base64.DEFAULT)
        } catch (e: Exception) {
            throw CryptoException("Base64 解码失败: ${e.message}")
        }
        if (body.size < SALT_LEN + IV_LEN + TAG_LEN) throw CryptoException("加密数据不完整")
        val salt = body.copyOfRange(0, SALT_LEN)
        val iv = body.copyOfRange(SALT_LEN, SALT_LEN + IV_LEN)
        val tag = body.copyOfRange(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN)
        val ct = body.copyOfRange(SALT_LEN + IV_LEN + TAG_LEN, body.size)
        val key = deriveKey(pass, salt)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_LEN * 8, iv))
            String(cipher.doFinal(ct + tag), Charsets.UTF_8)  // Java 需要 ct||tag
        } catch (e: javax.crypto.AEADBadTagException) {
            throw CryptoException("口令错误或数据被篡改")
        } catch (e: Exception) {
            throw CryptoException("解密失败: ${e.message}")
        }
    }

    private fun deriveKey(pass: String, salt: ByteArray): ByteArray =
        Scrypt.derive(pass.toByteArray(Charsets.UTF_8), salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LEN)

    class CryptoException(message: String) : Exception(message)
}

/**
 * scrypt (RFC 7914) 纯 Kotlin 实现 —— Android 无内置 API。
 * 与 Node crypto.scryptSync 结果一致。
 */
internal object Scrypt {

    fun derive(pass: ByteArray, salt: ByteArray, n: Int, r: Int, p: Int, dkLen: Int): ByteArray {
        require(n > 1 && (n and (n - 1)) == 0) { "N 必须是 >1 的 2 的幂" }
        val mfLen = r * 128
        val b = pbkdf2Sha256(pass, salt, 1, p * mfLen)
        val v = IntArray(32 * n * r)
        val xy = IntArray(64 * r)
        val bi = IntArray(p * mfLen / 4)
        // little-endian 解包
        for (i in bi.indices) {
            bi[i] = (b[i * 4].toInt() and 0xff) or
                    ((b[i * 4 + 1].toInt() and 0xff) shl 8) or
                    ((b[i * 4 + 2].toInt() and 0xff) shl 16) or
                    ((b[i * 4 + 3].toInt() and 0xff) shl 24)
        }
        for (i in 0 until p) {
            sMix(bi, i * 32 * r, r, n, v, xy)
        }
        // 打包回字节
        val b2 = ByteArray(b.size)
        for (i in bi.indices) {
            b2[i * 4] = (bi[i] and 0xff).toByte()
            b2[i * 4 + 1] = ((bi[i] ushr 8) and 0xff).toByte()
            b2[i * 4 + 2] = ((bi[i] ushr 16) and 0xff).toByte()
            b2[i * 4 + 3] = ((bi[i] ushr 24) and 0xff).toByte()
        }
        return pbkdf2Sha256(pass, b2, 1, dkLen)
    }

    private fun sMix(b: IntArray, bi: Int, r: Int, n: Int, v: IntArray, xy: IntArray) {
        val xi = 0
        val yi = 32 * r
        System.arraycopy(b, bi, xy, xi, 32 * r)
        for (i in 0 until n) {
            System.arraycopy(xy, xi, v, i * (32 * r), 32 * r)
            blockMixSalsa8(xy, xi, yi, r)
        }
        for (i in 0 until n) {
            val j = xy[xi + (2 * r - 1) * 16] and (n - 1)
            for (k in 0 until 32 * r) xy[xi + k] = xy[xi + k] xor v[j * (32 * r) + k]
            blockMixSalsa8(xy, xi, yi, r)
        }
        System.arraycopy(xy, xi, b, bi, 32 * r)
    }

    private fun blockMixSalsa8(by: IntArray, bi: Int, yi: Int, r: Int) {
        val x = IntArray(16)
        System.arraycopy(by, bi + (2 * r - 1) * 16, x, 0, 16)
        for (i in 0 until 2 * r) {
            for (k in 0 until 16) x[k] = x[k] xor by[bi + i * 16 + k]
            salsa20_8(x)
            System.arraycopy(x, 0, by, yi + i * 16, 16)
        }
        for (i in 0 until r) {
            System.arraycopy(by, yi + i * 2 * 16, by, bi + i * 16, 16)
            System.arraycopy(by, yi + (i * 2 + 1) * 16, by, bi + (i + r) * 16, 16)
        }
    }

    private fun rot(a: Int, b: Int) = (a shl b) or (a ushr (32 - b))

    private fun salsa20_8(b: IntArray) {
        val x = b.copyOf(16)
        var i = 8
        while (i > 0) {
            x[4] = x[4] xor rot(x[0] + x[12], 7);  x[8] = x[8] xor rot(x[4] + x[0], 9)
            x[12] = x[12] xor rot(x[8] + x[4], 13); x[0] = x[0] xor rot(x[12] + x[8], 18)
            x[9] = x[9] xor rot(x[5] + x[1], 7);   x[13] = x[13] xor rot(x[9] + x[5], 9)
            x[1] = x[1] xor rot(x[13] + x[9], 13); x[5] = x[5] xor rot(x[1] + x[13], 18)
            x[14] = x[14] xor rot(x[10] + x[6], 7); x[2] = x[2] xor rot(x[14] + x[10], 9)
            x[6] = x[6] xor rot(x[2] + x[14], 13); x[10] = x[10] xor rot(x[6] + x[2], 18)
            x[3] = x[3] xor rot(x[15] + x[11], 7); x[7] = x[7] xor rot(x[3] + x[15], 9)
            x[11] = x[11] xor rot(x[7] + x[3], 13); x[15] = x[15] xor rot(x[11] + x[7], 18)
            x[1] = x[1] xor rot(x[0] + x[3], 7);   x[2] = x[2] xor rot(x[1] + x[0], 9)
            x[3] = x[3] xor rot(x[2] + x[1], 13);  x[0] = x[0] xor rot(x[3] + x[2], 18)
            x[6] = x[6] xor rot(x[5] + x[4], 7);   x[7] = x[7] xor rot(x[6] + x[5], 9)
            x[4] = x[4] xor rot(x[7] + x[6], 13);  x[5] = x[5] xor rot(x[4] + x[7], 18)
            x[11] = x[11] xor rot(x[10] + x[9], 7); x[8] = x[8] xor rot(x[11] + x[10], 9)
            x[9] = x[9] xor rot(x[8] + x[11], 13); x[10] = x[10] xor rot(x[9] + x[8], 18)
            x[12] = x[12] xor rot(x[15] + x[14], 7); x[13] = x[13] xor rot(x[12] + x[15], 9)
            x[14] = x[14] xor rot(x[13] + x[12], 13); x[15] = x[15] xor rot(x[14] + x[13], 18)
            i -= 2
        }
        for (k in 0 until 16) b[k] = b[k] + x[k]
    }

    /** PBKDF2-HMAC-SHA256 —— 自实现, 直接处理原始字节(避免 PBEKeySpec char[] 二次编码) */
    private fun pbkdf2Sha256(pass: ByteArray, salt: ByteArray, iterations: Int, dkLen: Int): ByteArray {
        val hLen = 32
        val blocks = (dkLen + hLen - 1) / hLen
        val out = ByteArray(blocks * hLen)
        for (i in 1..blocks) {
            val idx = byteArrayOf(
                ((i ushr 24) and 0xff).toByte(), ((i ushr 16) and 0xff).toByte(),
                ((i ushr 8) and 0xff).toByte(), (i and 0xff).toByte()
            )
            var u = hmacSha256(pass, salt + idx)
            val t = u.copyOf()
            for (j in 1 until iterations) {
                u = hmacSha256(pass, u)
                for (k in t.indices) t[k] = (t[k].toInt() xor u[k].toInt()).toByte()
            }
            System.arraycopy(t, 0, out, (i - 1) * hLen, hLen)
        }
        return out.copyOf(dkLen)
    }

    /** HMAC-SHA256(手工实现, 支持空密钥) */
    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val blockSize = 64
        val md = java.security.MessageDigest.getInstance("SHA-256")
        val k0 = if (key.size > blockSize) md.digest(key) else key
        val kPad = ByteArray(blockSize)
        System.arraycopy(k0, 0, kPad, 0, k0.size)
        val ipad = ByteArray(blockSize) { (kPad[it].toInt() xor 0x36).toByte() }
        val opad = ByteArray(blockSize) { (kPad[it].toInt() xor 0x5c).toByte() }
        md.reset(); md.update(ipad); md.update(data)
        val inner = md.digest()
        md.reset(); md.update(opad); md.update(inner)
        return md.digest()
    }
}
