package com.deepseek.dshremote.data.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 隧道文本帧的逐行容错。
 *
 * 中继会把多条帧合并进一个 WebSocket 文本帧（心跳、`end` 常和业务帧挤在一起）。
 * 修复前 `decodeLines` 是 `map { decode(it) }`：只要有一行被截断就整体抛异常，
 * 调用方（`RelayClient.runLoop`）的 `getOrElse { emptyList() }` 会把**整批**扔掉，
 * 同批里完好的 `end`/`pong` 一起消失 —— 表现是"流永远不结束"，比重试一次难查得多。
 */
class FrameDecodeResilienceTest {

    /** 缺 `t` 的帧在 [FrameCodec.decode] 里必然是协议错误（`RelayException`）。 */
    private val brokenLine = """{"id":1}"""

    @Test
    fun `多行 NDJSON 里混入坏行时只丢坏行`() {
        val text = listOf(
            FrameCodec.encode(PingFrame(id = 7L)),
            brokenLine,
            FrameCodec.encode(EndFrame(id = 9L)),
        ).joinToString("\n")

        val frames = FrameCodec.decodeLines(text)

        assertEquals("坏行只该丢自己：$frames", 2, frames.size)
        assertTrue("第一行必须是 ping：$frames", frames[0] is PingFrame)
        assertEquals(7L, (frames[0] as PingFrame).id)
        assertTrue("坏行之后的 end 必须活下来：$frames", frames[1] is EndFrame)
        assertEquals(9L, (frames[1] as EndFrame).id)
    }

    @Test
    fun `单行文本帧坏掉时返回空列表而不是抛异常`() {
        assertTrue(FrameCodec.decodeLines("{ 截断的帧").isEmpty())
        assertTrue(FrameCodec.decodeLines(brokenLine).isEmpty())
        assertTrue(FrameCodec.decodeLines("not-json").isEmpty())
    }

    @Test
    fun `整批都是坏行时也只是空列表`() {
        val frames = FrameCodec.decodeLines(listOf(brokenLine, "不是 JSON", "{").joinToString("\n"))
        assertTrue(frames.isEmpty())
    }

    @Test
    fun `正常的多行帧仍然逐行全部解析`() {
        val text = listOf(
            FrameCodec.encode(ResFrame(1L, 200, emptyMap())),
            FrameCodec.encode(ChunkFrame(1L, "aGVsbG8=")),
            FrameCodec.encode(EndFrame(1L)),
        ).joinToString("\n")

        val frames = FrameCodec.decodeLines(text)

        assertEquals(3, frames.size)
        assertTrue(frames[0] is ResFrame)
        assertTrue(frames[1] is ChunkFrame)
        assertTrue(frames[2] is EndFrame)
    }

    @Test
    fun `坏行不影响同一批里 chunk 的载荷`() {
        val text = listOf(
            brokenLine,
            FrameCodec.encode(ChunkFrame(1L, "aGVsbG8=")),
        ).joinToString("\n")

        val frames = FrameCodec.decodeLines(text)

        assertEquals(1, frames.size)
        val body = FrameCodec.decodeBody((frames[0] as ChunkFrame).dataB64)
        assertEquals("hello", String(body!!, Charsets.UTF_8))
    }

    @Test
    fun `typesOf 对坏帧不再抛异常`() {
        // 调试入口，同样不能因为一行坏帧炸掉调用方
        assertEquals(listOf(FrameType.PING), FrameCodec.typesOf("{\"t\":\"ping\"}\n$brokenLine"))
    }

    @Test
    fun `单帧的 decode 仍然严格抛协议错误`() {
        // 逐行解析放宽了，但单帧解析必须保持"协议错误可见"，
        // 否则 FrameCodecTest 里 `非法 JSON 与缺 t 都抛协议错误` 那条契约就没了
        try {
            FrameCodec.decode(brokenLine)
            fail("缺 t 应抛 RelayException")
        } catch (e: RelayException) {
            assertEquals("bad_request", e.code)
        }
    }
}
