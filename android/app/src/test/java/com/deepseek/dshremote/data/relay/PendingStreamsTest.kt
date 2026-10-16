package com.deepseek.dshremote.data.relay

import java.nio.charset.StandardCharsets
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 多路复用流表 + chunk 重组（契约 §3.2）。
 *
 * 覆盖验收点：id 映射、chunk 重组（乱序/迟到/大帧跨包）、overflow、abort。
 */
class PendingStreamsTest {

    private class Recorder {
        val events = mutableListOf<TunnelEvent>()

        fun callback(event: TunnelEvent) {
            events += event
        }

        val body: ByteArray
            get() = events.filterIsInstance<TunnelEvent.Body>()
                .fold(ByteArray(0)) { acc, chunk -> acc + chunk.bytes }

        val head: TunnelEvent.Head? get() = events.filterIsInstance<TunnelEvent.Head>().firstOrNull()

        val aborted: TunnelEvent.Aborted? get() = events.filterIsInstance<TunnelEvent.Aborted>().firstOrNull()

        val ended: Boolean get() = events.contains(TunnelEvent.End)
    }

    private fun chunk(id: Long, text: String): ChunkFrame =
        ChunkFrame(id, Base64.getEncoder().encodeToString(text.toByteArray(StandardCharsets.UTF_8)))

    @Test
    fun `一个 id 的完整生命周期 res-chunk-end`() {
        val streams = PendingStreams()
        val recorder = Recorder()
        assertTrue(streams.open(1L, recorder::callback))

        assertTrue(streams.onFrame(ResFrame(1L, 200, mapOf("Content-Type" to "application/json"))))
        assertTrue(streams.onFrame(chunk(1L, "{\"a\":")))
        assertTrue(streams.onFrame(chunk(1L, "1}")))
        assertTrue(streams.onFrame(EndFrame(1L)))

        assertEquals(200, recorder.head?.status)
        assertEquals("application/json", recorder.head?.headers?.get("Content-Type"))
        assertEquals("{\"a\":1}", String(recorder.body, StandardCharsets.UTF_8))
        assertTrue(recorder.ended)
        assertEquals("流结束后流表必须清空", 0, streams.size)
    }

    @Test
    fun `多路复用下 id 不串线（交错到达）`() {
        val streams = PendingStreams()
        val first = Recorder()
        val second = Recorder()
        streams.open(1L, first::callback)
        streams.open(2L, second::callback)

        streams.onFrame(ResFrame(1L, 200))
        streams.onFrame(ResFrame(2L, 201))
        streams.onFrame(chunk(2L, "BBB-1"))
        streams.onFrame(chunk(1L, "AAA-1"))
        streams.onFrame(chunk(2L, "BBB-2"))
        streams.onFrame(chunk(1L, "AAA-2"))
        streams.onFrame(EndFrame(1L))
        streams.onFrame(EndFrame(2L))

        assertEquals("AAA-1AAA-2", String(first.body, StandardCharsets.UTF_8))
        assertEquals("BBB-1BBB-2", String(second.body, StandardCharsets.UTF_8))
        assertEquals(200, first.head?.status)
        assertEquals(201, second.head?.status)
    }

    @Test
    fun `res 之前到达的 chunk 不被丢弃（乱序容忍）`() {
        val streams = PendingStreams()
        val recorder = Recorder()
        streams.open(5L, recorder::callback)

        // 中继理论上不会这么发，但客户端不该因此丢数据
        streams.onFrame(chunk(5L, "early"))
        streams.onFrame(ResFrame(5L, 200))
        streams.onFrame(EndFrame(5L))

        assertEquals("early", String(recorder.body, StandardCharsets.UTF_8))
        assertEquals(1, recorder.events.filterIsInstance<TunnelEvent.Head>().size)
    }

    @Test
    fun `end 之后迟到的 chunk 被忽略且不影响结果`() {
        val streams = PendingStreams()
        val recorder = Recorder()
        streams.open(3L, recorder::callback)
        streams.onFrame(ResFrame(3L, 200))
        streams.onFrame(chunk(3L, "real"))
        streams.onFrame(EndFrame(3L))
        // 迟到帧：流已经不在表里，onFrame 返回 false（调用方只记日志）
        assertFalse(streams.onFrame(chunk(3L, "late")))
        assertEquals("real", String(recorder.body, StandardCharsets.UTF_8))
    }

    @Test
    fun `大帧跨多个 chunk 逐段重组（300KiB）`() {
        val streams = PendingStreams()
        val recorder = Recorder()
        streams.open(8L, recorder::callback)

        val payload = ByteArray(300 * 1024) { index -> (index % 127).toByte() }
        val piece = 64 * 1024
        var offset = 0
        streams.onFrame(ResFrame(8L, 200))
        while (offset < payload.size) {
            val end = minOf(offset + piece, payload.size)
            val slice = payload.copyOfRange(offset, end)
            streams.onFrame(ChunkFrame(8L, Base64.getEncoder().encodeToString(slice)))
            offset = end
        }
        streams.onFrame(EndFrame(8L))

        assertEquals(payload.size, recorder.body.size)
        assertArrayEquals(payload, recorder.body)
    }

    @Test
    fun `超过单流上限触发 overflow abort`() {
        val streams = PendingStreams(maxBodyBytes = 1024)
        val recorder = Recorder()
        streams.open(4L, recorder::callback)
        streams.onFrame(ResFrame(4L, 200))
        streams.onFrame(ChunkFrame(4L, Base64.getEncoder().encodeToString(ByteArray(700))))
        streams.onFrame(ChunkFrame(4L, Base64.getEncoder().encodeToString(ByteArray(700))))

        assertEquals(PendingStreams.REASON_OVERFLOW, recorder.aborted?.reason)
        assertEquals("overflow 后流应从表中移除", 0, streams.size)
    }

    @Test
    fun `非法 Base64 的 chunk 触发 bad_chunk`() {
        val streams = PendingStreams()
        val recorder = Recorder()
        streams.open(6L, recorder::callback)
        streams.onFrame(ChunkFrame(6L, "!!!!"))
        assertEquals(PendingStreams.REASON_BAD_CHUNK, recorder.aborted?.reason)
    }

    @Test
    fun `abort 帧把异常原因透传给上层`() {
        val streams = PendingStreams()
        val recorder = Recorder()
        streams.open(7L, recorder::callback)
        streams.onFrame(ResFrame(7L, 200))
        streams.onFrame(AbortFrame(7L, "home_offline"))
        assertEquals("home_offline", recorder.aborted?.reason)
        assertFalse(recorder.ended)
    }

    @Test
    fun `abortAll 一次性失败所有在飞的流`() {
        val streams = PendingStreams()
        val first = Recorder()
        val second = Recorder()
        streams.open(1L, first::callback)
        streams.open(2L, second::callback)
        streams.abortAll("client_disconnect")
        assertEquals("client_disconnect", first.aborted?.reason)
        assertEquals("client_disconnect", second.aborted?.reason)
        assertEquals(0, streams.size)
    }

    @Test
    fun `重复 id 注册被拒绝`() {
        val streams = PendingStreams()
        assertTrue(streams.open(1L) {})
        assertFalse("同一 id 不能注册两次", streams.open(1L) {})
        assertTrue(streams.cancel(1L))
        assertFalse(streams.cancel(1L))
    }

    @Test
    fun `未知 id 的响应帧不会被误认为已处理的流`() {
        val streams = PendingStreams()
        assertFalse(streams.onFrame(ResFrame(99L, 200)))
        assertFalse(streams.onFrame(ChunkFrame(99L, "eA==")))
        assertFalse(streams.onFrame(EndFrame(99L)))
        assertFalse("ping 这类控制帧不属于任何流", streams.onFrame(PingFrame(1L)))
    }

    @Test
    fun `回调抛异常不会破坏流表`() {
        val streams = PendingStreams()
        streams.open(1L) { throw IllegalStateException("boom") }
        streams.onFrame(ResFrame(1L, 200))
        assertTrue(streams.onFrame(EndFrame(1L)))
        assertEquals(0, streams.size)
    }
}
