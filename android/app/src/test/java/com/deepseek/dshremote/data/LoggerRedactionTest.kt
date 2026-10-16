package com.deepseek.dshremote.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 日志脱敏（契约 §5.5：令牌/配对码一律前 4 位 + `****`）。
 *
 * 这些断言是"令牌不落日志"的唯一可执行保障：调用点写什么由人决定，
 * 但**输出的每一行**都会过这里。
 */
class LoggerRedactionTest {

    @Test
    fun `设备令牌只保留前 4 位`() {
        val redacted = Logger.redact("Authorization 已保存 token=dshr_9f2cAbCdEfGh1234567890")
        assertFalse(redacted, redacted.contains("dshr_9f2cAbCdEfGh1234567890"))
        assertTrue(redacted, redacted.contains("dshr****"))
    }

    @Test
    fun `Bearer 头被脱敏`() {
        val redacted = Logger.redact("GET /api/v2/sessions Authorization: Bearer dshr_abcdefghijklmnop")
        assertFalse(redacted, redacted.contains("dshr_abcdefghijklmnop"))
        assertTrue(redacted, redacted.contains("Bearer dshr****"))
    }

    @Test
    fun `homeId 与 tokenId 被脱敏但枚举值不被误伤`() {
        val redacted = Logger.redact("homeId=home_9f2cAbCdEfGh1234567890 tokenId=tok_7a1b2c3d4e")
        assertFalse(redacted, redacted.contains("home_9f2cAbCdEfGh1234567890"))
        assertFalse(redacted, redacted.contains("tok_7a1b2c3d4e"))

        // 关键：home_offline / home_not_found 是错误码枚举，不能被当成凭据打码，
        // 否则排障时日志变成一堆 home****，什么都看不出来
        val enumLine = Logger.redact("收到 notice home_offline，错误码 home_not_found")
        assertTrue(enumLine, enumLine.contains("home_offline"))
        assertTrue(enumLine, enumLine.contains("home_not_found"))
    }

    @Test
    fun `六位配对码被脱敏`() {
        val redacted = Logger.redact("""{"code":"482913","deviceName":"Pixel 8"}""")
        assertFalse(redacted, redacted.contains("482913"))
        assertTrue(redacted, redacted.contains("******"))

        val inline = Logger.redact("pair code=391204 已生成")
        assertFalse(inline, inline.contains("391204"))
    }

    @Test
    fun `普通文本原样保留`() {
        val line = "会话列表已刷新 count=7 workspace=D:\\Workspace\\dsh_android"
        assertTrue(Logger.redact(line) == line)
    }

    @Test
    fun `日志环形缓冲记录脱敏后的行`() {
        Logger.clearBuffer()
        Logger.i("TestTag", "token=dshr_secret_value_123456 已保存")
        val snapshot = Logger.snapshot()
        assertTrue(snapshot.isNotEmpty())
        assertTrue(snapshot.last(), snapshot.last().contains("TestTag"))
        assertFalse("环形缓冲里也不能有明文令牌", snapshot.any { it.contains("dshr_secret_value_123456") })
        Logger.clearBuffer()
        assertTrue(Logger.snapshot().isEmpty())
    }
}
