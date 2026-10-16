package com.deepseek.dshremote.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 隧道 chunk → 文本的增量解码，以及错误体这类无界累积的封顶。
 *
 * 这两个类是 DshApiV2.sessionEvents 的内部件，单独测的理由：
 * 它们的缺陷都表现为"不报错的错"（静默乱码 / 静默吃内存），端到端用例很难稳定复现，
 * 必须在这一层把切片位置钉死。
 */
class StreamTextTest {

    private val head = """{"text":""""

    /** 第一个汉字"中"的首字节下标：`{"text":"` + 1 一定落在它的三个字节中间。 */
    private val cutInsideChinese = head.toByteArray(Charsets.UTF_8).size + 1

    @Test
    fun `中文被 chunk 边界劈开时能拼回原文且没有替换字符`() {
        val payload = (head + "中文消息，一段正常的中文\"}").toByteArray(Charsets.UTF_8)
        val decoder = StreamTextDecoder()

        val merged = decoder.decode(payload.copyOfRange(0, cutInsideChinese)) +
            decoder.decode(payload.copyOfRange(cutInsideChinese, payload.size))

        assertEquals(String(payload, Charsets.UTF_8), merged)
        assertFalse("不允许出现 U+FFFD", merged.contains('\uFFFD'))
    }

    @Test
    fun `旧实现逐 chunk 直接转换在同样的切片下必然产生替换字符`() {
        // 这条不是测新代码，而是把"修之前确实会坏"钉在测试里：
        // 一旦有人把实现改回 String(bytes, Charsets.UTF_8)，上面的用例会红，这条会绿。
        val payload = (head + "中文消息\"}").toByteArray(Charsets.UTF_8)
        val wrong = String(payload.copyOfRange(0, cutInsideChinese), Charsets.UTF_8) +
            String(payload.copyOfRange(cutInsideChinese, payload.size), Charsets.UTF_8)
        assertTrue(wrong.contains('\uFFFD'))
        assertFalse(wrong == String(payload, Charsets.UTF_8))
    }

    @Test
    fun `四字节 emoji 跨 chunk 也能拼回`() {
        val payload = "前缀✅后缀".toByteArray(Charsets.UTF_8)
        // "前缀" 各 3 字节 = 6，再切 2 字节正好落进 ✅ 的 4 字节中间
        val cut = 8
        val decoder = StreamTextDecoder()
        val merged = decoder.decode(payload.copyOfRange(0, cut)) +
            decoder.decode(payload.copyOfRange(cut, payload.size))
        assertEquals("前缀✅后缀", merged)
    }

    @Test
    fun `逐字节喂入也能还原整段文本`() {
        val payload = "一✅二".toByteArray(Charsets.UTF_8)
        val decoder = StreamTextDecoder()
        val builder = StringBuilder()
        payload.forEach { builder.append(decoder.decode(byteArrayOf(it))) }
        assertEquals("一✅二", builder.toString())
    }

    @Test
    fun `空 chunk 返回空串且不打断后续解码`() {
        val payload = "中文".toByteArray(Charsets.UTF_8)
        val decoder = StreamTextDecoder()
        assertEquals("", decoder.decode(ByteArray(0)))
        // 先喂半个字，再来一个空 chunk，最后补齐
        val first = decoder.decode(payload.copyOfRange(0, 1))
        assertEquals("", first)
        assertEquals("", decoder.decode(ByteArray(0)))
        assertEquals("中文", first + decoder.decode(payload.copyOfRange(1, payload.size)))
    }

    @Test
    fun `坏字节按替换字符处理而不是抛异常`() {
        // 0xC3 是一个未完成的两字节前缀，后面直接接 ASCII：隧道里出现脏字节不能把事件流打断
        val decoder = StreamTextDecoder()
        val text = decoder.decode(byteArrayOf(0xC3.toByte(), 'a'.code.toByte()))
        assertTrue(text.contains('\uFFFD'))
        assertTrue(text.endsWith("a"))
        // 解码器仍然可用
        assertEquals("好", decoder.decode("好".toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun `错误体只保留前 N 个字符`() {
        val bounded = BoundedText(10)
        bounded.append("0123456789ABCDEF")
        assertEquals("0123456789", bounded.toString())
        assertEquals(10, bounded.length)
    }

    @Test
    fun `错误体刚好等于上限时一个字都不丢`() {
        val bounded = BoundedText(4)
        bounded.append("abcd")
        assertEquals("abcd", bounded.toString())
    }

    @Test
    fun `错误体到达上限后继续追加不再增长`() {
        val bounded = BoundedText(8)
        repeat(100) { bounded.append("12345678") }
        assertEquals(8, bounded.length)
        assertEquals("12345678", bounded.toString())
    }

    @Test
    fun `错误体单次追加超过剩余空间时被裁到上限`() {
        val bounded = BoundedText(5)
        bounded.append("ab")
        bounded.append("cdefghij")
        assertEquals("abcde", bounded.toString())
    }
}
