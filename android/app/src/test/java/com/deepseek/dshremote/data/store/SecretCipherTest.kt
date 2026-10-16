package com.deepseek.dshremote.data.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 令牌存储的加密外壳（前缀与回退语义）。
 *
 * Keystore 本体只能在真机上验证，但"密文/明文前缀如何解释"必须可在 JVM 上锁住：
 * 一旦前缀判断写错，用户会在"换机/清密钥后"直接卡在无法配对的状态。
 */
class SecretCipherTest {

    @Test
    fun `明文回退带可识别前缀`() {
        val cipher = PlainSecretCipher()
        val stored = cipher.encrypt("dshr_token_value_123")
        assertTrue(stored.startsWith(SecretCodec.PLAIN_PREFIX))
        assertTrue(SecretCodec.isPlainFallback(stored))
        assertFalse(SecretCodec.isEncrypted(stored))
        assertEquals("dshr_token_value_123", cipher.decrypt(stored))
    }

    @Test
    fun `历史无前缀值按明文处理`() {
        assertFalse(SecretCodec.isEncrypted("dshr_legacy_token"))
        assertFalse(SecretCodec.isPlainFallback("dshr_legacy_token"))
        assertEquals("dshr_legacy_token", SecretCodec.unwrapPlain("dshr_legacy_token"))
        assertEquals("dshr_legacy_token", PlainSecretCipher().decrypt("dshr_legacy_token"))
    }

    @Test
    fun `enc 前缀的值不会被当成明文返回`() {
        // 关键安全性质：密文即使解不开也绝不能原样当成令牌用
        assertEquals("", SecretCodec.unwrapPlain("enc:AAAA:BBBB"))
        assertEquals("", PlainSecretCipher().decrypt("enc:AAAA:BBBB"))
    }

    @Test
    fun `空值处理`() {
        assertEquals("", PlainSecretCipher().decrypt(""))
        assertEquals(SecretCodec.PLAIN_PREFIX, PlainSecretCipher().encrypt(""))
    }

    @Test
    fun `密文格式可被解析出 IV 与正文`() {
        // 模拟 Keystore 输出格式：enc:<base64(iv)>:<base64(body)>
        val stored = SecretCodec.ENC_PREFIX + "aXYxMjM0NTY3ODkw" + ":" + "Ym9keQ=="
        val payload = stored.removePrefix(SecretCodec.ENC_PREFIX)
        val separator = payload.indexOf(':')
        assertTrue(separator > 0)
        assertEquals("aXYxMjM0NTY3ODkw", payload.substring(0, separator))
        assertEquals("Ym9keQ==", payload.substring(separator + 1))
    }
}
