package com.deepseek.dshremote.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 事件排序/去重测试。
 *
 * 契约 §4 要求"客户端按 seq 严格排序、去重"，这里逐条钉住行为：
 * 重复事件不得重复拼接、乱序事件必须按 seq 还原顺序、断线补发的重复必须被丢弃。
 */
class EventReducerTest {

    private fun outputEvent(seq: Long, delta: String) = TaskEvent(
        seq = seq,
        taskId = "task_1",
        at = seq * 10,
        type = TaskEventType.TASK_OUTPUT,
        delta = delta,
    )

    @Test
    fun `顺序事件依次放行并拼接输出`() {
        val reducer = EventReducer()
        val applied = reducer.acceptAll(
            listOf(outputEvent(1, "a"), outputEvent(2, "b"), outputEvent(3, "c")),
        )
        assertEquals("abc", applied.joinToString("") { it.delta })
        assertEquals(3L, reducer.lastAppliedSeq)
    }

    @Test
    fun `重复事件被丢弃`() {
        val reducer = EventReducer()
        reducer.acceptAll(listOf(outputEvent(1, "a"), outputEvent(2, "b")))
        // 断线重连后网关会用 fromSeq 重发边界事件，重复的必须丢掉
        val again = reducer.acceptAll(listOf(outputEvent(1, "a"), outputEvent(2, "b")))
        assertTrue(again.isEmpty())
        assertEquals(2L, reducer.lastAppliedSeq)
    }

    @Test
    fun `同一批乱序事件按 seq 还原顺序`() {
        val reducer = EventReducer()
        val applied = reducer.acceptAll(
            listOf(outputEvent(3, "c"), outputEvent(1, "a"), outputEvent(2, "b")),
        )
        assertEquals("abc", applied.joinToString("") { it.delta })
        assertEquals(3L, reducer.lastAppliedSeq)
    }

    @Test
    fun `乱序到达先暂存等空洞补齐`() {
        val reducer = EventReducer()
        // 先让 seq=1 落地，建立"已知游标"；此时才谈得上"seq=2 缺失"
        assertEquals("a", reducer.accept(outputEvent(1, "a")).joinToString("") { it.delta })
        // seq=3 先到：必须暂存，不能越过 seq=2 直接拼接（否则输出顺序就错了）
        assertTrue(reducer.accept(outputEvent(3, "c")).isEmpty())
        assertTrue(reducer.hasPendingGap)
        val applied = reducer.accept(outputEvent(2, "b"))
        // seq=2 补齐后，2 与 3 一起按序放行
        assertEquals("bc", applied.joinToString("") { it.delta })
        assertFalse(reducer.hasPendingGap)
        assertEquals(3L, reducer.lastAppliedSeq)
    }

    @Test
    fun `空洞迟迟补不齐时强制放行避免停摆`() {
        val reducer = EventReducer()
        reducer.accept(outputEvent(1, "a"))
        // 网关只保留最近 2000 条：断线太久时 seq=2..5 永久丢失
        reducer.accept(outputEvent(6, "f"))
        assertTrue(reducer.hasPendingGap)

        val flushed = reducer.flushPending()
        assertEquals("f", flushed.joinToString("") { it.delta })
        assertEquals(6L, reducer.lastAppliedSeq)
        assertFalse(reducer.hasPendingGap)
    }

    @Test
    fun `终态事件与输出事件混排时保持顺序`() {
        val reducer = EventReducer()
        val events = listOf(
            TaskEvent(1, "task_1", 0, TaskEventType.TASK_CREATED),
            outputEvent(2, "hello "),
            outputEvent(3, "world"),
            TaskEvent(4, "task_1", 0, TaskEventType.TASK_FINISHED),
        )
        val applied = reducer.acceptAll(events)
        assertEquals(
            listOf(
                TaskEventType.TASK_CREATED,
                TaskEventType.TASK_OUTPUT,
                TaskEventType.TASK_OUTPUT,
                TaskEventType.TASK_FINISHED,
            ),
            applied.map { it.type },
        )
        assertEquals("hello world", applied.filter { it.type == TaskEventType.TASK_OUTPUT }
            .joinToString("") { it.delta })
    }

    @Test
    fun `首个事件不必从 seq 1 开始`() {
        // 服务端保留窗口之外的旧事件已被丢弃时，客户端拿到的第一个 seq 可能是 5000
        val reducer = EventReducer()
        val applied = reducer.acceptAll(listOf(outputEvent(5_000, "x"), outputEvent(5_001, "y")))
        assertEquals("xy", applied.joinToString("") { it.delta })
        assertEquals(5_001L, reducer.lastAppliedSeq)
    }

    @Test
    fun `reset 后重新从零开始接收`() {
        val reducer = EventReducer()
        reducer.accept(outputEvent(5, "e"))
        reducer.reset()
        assertEquals(-1L, reducer.lastAppliedSeq)
        val applied = reducer.accept(outputEvent(1, "a"))
        assertEquals("a", applied.joinToString("") { it.delta })
    }

    @Test
    fun `退避序列为 1s 到 30s`() {
        val backoff = ReconnectBackoff()
        assertEquals(1_000L, backoff.delayFor(1))
        assertEquals(2_000L, backoff.delayFor(2))
        assertEquals(4_000L, backoff.delayFor(3))
        assertEquals(8_000L, backoff.delayFor(4))
        assertEquals(16_000L, backoff.delayFor(5))
        assertEquals(30_000L, backoff.delayFor(6))
        assertEquals(30_000L, backoff.delayFor(20))
    }
}
