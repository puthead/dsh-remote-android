package com.deepseek.dshremote.data.store

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.deepseek.dshremote.data.Logger
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 令牌存储的加密层。
 *
 * 约束（契约 §5.6 / 需求 3）：令牌**不得明文落盘**；但设备若不支持 Android Keystore
 * （极少数定制 ROM/模拟器异常）也不能让用户完全用不了，因此保留明文回退并**显式标注前缀**，
 * 让"当前是明文"这件事可被检测、可被提示，而不是悄悄发生。
 *
 * 纯逻辑（前缀、编解码格式）放在 [SecretCodec]，可在 JVM 单测里覆盖；
 * Keystore 相关代码只在真机路径上执行。
 */
interface SecretCipher {
    /** @return 可直接存盘的字符串（带 `enc:`/`plain:` 前缀）。 */
    fun encrypt(plain: String): String

    /** @return 解密后的明文；无法解密返回空串（调用方按"未配对"处理）。 */
    fun decrypt(stored: String): String
}

object SecretCodec {

    const val ENC_PREFIX = "enc:"
    const val PLAIN_PREFIX = "plain:"

    /** 回退到明文时用的包装（让人一眼看出这条记录没加密）。 */
    fun wrapPlain(plain: String): String = PLAIN_PREFIX + plain

    fun isEncrypted(stored: String): Boolean = stored.startsWith(ENC_PREFIX)

    fun isPlainFallback(stored: String): Boolean = stored.startsWith(PLAIN_PREFIX)

    /** 兼容无前缀的历史值（当作明文）。 */
    fun unwrapPlain(stored: String): String = when {
        stored.startsWith(PLAIN_PREFIX) -> stored.removePrefix(PLAIN_PREFIX)
        stored.startsWith(ENC_PREFIX) -> ""
        else -> stored
    }
}

/** 明文实现（单测与 Keystore 不可用时的回退）。 */
class PlainSecretCipher : SecretCipher {
    override fun encrypt(plain: String): String = SecretCodec.wrapPlain(plain)

    override fun decrypt(stored: String): String = SecretCodec.unwrapPlain(stored)
}

/**
 * Android Keystore 实现：AES/GCM/NoPadding，密钥不出安全硬件/系统密钥库。
 *
 * 存储格式：`enc:<base64(iv)>:<base64(ciphertext)>`（IV 随密文一起存，GCM 要求 IV 唯一）。
 */
class KeystoreSecretCipher(
    private val alias: String = DEFAULT_ALIAS,
) : SecretCipher {

    private val fallback = PlainSecretCipher()

    override fun encrypt(plain: String): String = try {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, loadOrCreateKey())
        val encrypted = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val iv = Base64.getEncoder().encodeToString(cipher.iv)
        val body = Base64.getEncoder().encodeToString(encrypted)
        "${SecretCodec.ENC_PREFIX}$iv:$body"
    } catch (t: Throwable) {
        Logger.w(TAG, "Keystore 加密不可用，回退明文存储（前缀 ${SecretCodec.PLAIN_PREFIX}）", t)
        fallback.encrypt(plain)
    }

    override fun decrypt(stored: String): String {
        if (stored.isEmpty()) return ""
        if (SecretCodec.isPlainFallback(stored) || !SecretCodec.isEncrypted(stored)) {
            return SecretCodec.unwrapPlain(stored)
        }
        return try {
            val payload = stored.removePrefix(SecretCodec.ENC_PREFIX)
            val separator = payload.indexOf(':')
            if (separator <= 0) return ""
            val iv = Base64.getDecoder().decode(payload.substring(0, separator))
            val body = Base64.getDecoder().decode(payload.substring(separator + 1))
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, loadOrCreateKey(), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(body), Charsets.UTF_8)
        } catch (t: Throwable) {
            // 密钥被清除（换机/恢复出厂）时会走到这里：返回空串 = 视为未配对，要求重新配对
            Logger.w(TAG, "令牌解密失败（密钥可能已失效），请重新配对", t)
            ""
        }
    }

    private fun loadOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val TAG = "TokenVault"
        private const val DEFAULT_ALIAS = "dsh_remote_token_v2"
        private const val PROVIDER = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
    }
}
