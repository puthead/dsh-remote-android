package com.deepseek.dshremote.data.store

import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 离线待发队列（Outbox）：损坏降级、幂等键、尝试次数。
 *
 * 幂等键 `clientTurnId` 必须落盘：补发两次也只能执行一次（契约 §4.2 的用途）。
 */
class OutboxCodecTest {

    private val dir = Files.createTempDirectory("dsh-outbox-test").toFile()

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    private fun turn(id: String, session: String = "session-1") = PendingTurn(
        sessionId = session,
        prompt = "把测试跑一遍 🚀",
        clientTurnId = id,
        createdAt = 1_791_463_030_000L,
    )

    @Test
    fun `编解码往返保留中文与 emoji`() {
        val encoded = OutboxCodec.encode(listOf(turn("client-1"), turn("client-2", session = "s2")))
        val decoded = OutboxCodec.decode(encoded)
        assertEquals(2, decoded.size)
        assertEquals("把测试跑一遍 🚀", decoded[0].prompt)
        assertEquals("client-1", decoded[0].clientTurnId)
        assertEquals(1_791_463_030_000L, decoded[0].createdAt)
        assertEquals("s2", decoded[1].sessionId)
    }

    @Test
    fun `损坏或空内容返回空列表`() {
        assertTrue(OutboxCodec.decode("{ broken").isEmpty())
        assertTrue(OutboxCodec.decode("{}").isEmpty())
        assertTrue(OutboxCodec.decode("").isEmpty())
    }

    @Test
    fun `缺字段的条目不进队列`() {
        val json = """{"pending":[{"prompt":"没有 sessionId"},{"sessionId":"s1"}]}"""
        assertTrue(OutboxCodec.decode(json).isEmpty())
    }

    @Test
    fun `入队去重且持久化`() {
        val outbox = Outbox(java.io.File(dir, "outbox.json"))
        assertTrue(outbox.load().isEmpty())

        outbox.enqueue(turn("client-1"))
        outbox.enqueue(turn("client-2"))
        assertEquals(2, outbox.load().size)

        // 同一个 clientTurnId 重复入队（重试场景）不应产生第二条
        outbox.enqueue(turn("client-1"))
        assertEquals(2, outbox.load().size)

        // 新建的实例读同一文件：验证真的落盘了
        assertEquals(2, Outbox(java.io.File(dir, "outbox.json")).load().size)
    }

    @Test
    fun `补发尝试次数累加并可移除`() {
        val outbox = Outbox(java.io.File(dir, "outbox.json"))
        outbox.enqueue(turn("client-1"))
        assertEquals(1, outbox.markAttempt("client-1").first().attempts)
        assertEquals(2, outbox.markAttempt("client-1").first().attempts)
        assertTrue(outbox.remove("client-1").isEmpty())
        assertTrue(outbox.load().isEmpty())
    }

    @Test
    fun `清空队列`() {
        val outbox = Outbox(java.io.File(dir, "outbox.json"))
        outbox.enqueue(turn("client-1"))
        assertTrue(outbox.clear().isEmpty())
        assertTrue(outbox.load().isEmpty())
    }

    @Test
    fun `损坏文件时不抛异常且可继续入队`() {
        val file = java.io.File(dir, "outbox.json")
        file.writeText("!!!not json!!!")
        val outbox = Outbox(file)
        assertTrue(outbox.load().isEmpty())
        assertEquals(1, outbox.enqueue(turn("client-1")).size)
        assertEquals(1, Outbox(file).load().size)
    }

    @Test
    fun `preview 压成一行并截断`() {
        val long = PendingTurn("s", "第一行\n第二行" + "x".repeat(200), "c", 0L)
        assertFalse(long.preview.contains('\n'))
        assertTrue(long.preview.length <= 60)
    }
}
