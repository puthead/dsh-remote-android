package com.deepseek.dshremote.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SSE 帧解析器的边界测试。
 *
 * 重点覆盖两个真实会发生的场景（需求 2 明确要求）：
 * 1) 一条事件被 TCP 拆成多个网络包；
 * 2) `data` 里的 JSON 转义换行 `\n` 不能当作行终止符。
 */
class SseFrameParserTest {

    @Test
    fun `完整帧一次到达`() {
        val parser = SseFrameParser()
        val frames = parser.feed(
            "id: 42\nevent: task.output\ndata: {\"seq\":42,\"taskId\":\"task_1\"}\n\n",
        )
        assertEquals(1, frames.size)
        assertEquals("42", frames[0].id)
        assertEquals("task.output", frames[0].event)
        assertEquals("{\"seq\":42,\"taskId\":\"task_1\"}", frames[0].data)
    }

    @Test
    fun `一条事件被拆成多个网络包`() {
        val parser = SseFrameParser()
        // 模拟弱网：字段名、冒号、data 全被切开
        assertTrue(parser.feed("id: 4").isEmpty())
        assertTrue(parser.feed("2\nev").isEmpty())
        assertTrue(parser.feed("ent: task.out").isEmpty())
        assertTrue(parser.feed("put\ndata: {\"seq\":4").isEmpty())
        assertTrue(parser.feed("2,\"taskId\":\"task_1\",\"type\":\"task.output\",\"delta\":\"你好\"}").isEmpty())
        val frames = parser.feed("\n\n")

        assertEquals(1, frames.size)
        assertEquals("42", frames[0].id)
        assertEquals("task.output", frames[0].event)
        assertEquals(
            "{\"seq\":42,\"taskId\":\"task_1\",\"type\":\"task.output\",\"delta\":\"你好\"}",
            frames[0].data,
        )
    }

    @Test
    fun `data 中的转义换行不切行`() {
        val parser = SseFrameParser()
        val frames = parser.feed(
            "data: {\"seq\":1,\"delta\":\"第一行\\n第二行\\n\"}\n\n",
        )
        assertEquals(1, frames.size)
        // 反斜杠 + n 必须原样保留，交给 JSON 解析器还原
        assertEquals("{\"seq\":1,\"delta\":\"第一行\\n第二行\\n\"}", frames[0].data)
    }

    @Test
    fun `多个 data 行按规范用换行连接`() {
        val parser = SseFrameParser()
        val frames = parser.feed("data: line1\ndata: line2\n\n")
        assertEquals(1, frames.size)
        assertEquals("line1\nline2", frames[0].data)
    }

    @Test
    fun `心跳注释被忽略且不产生帧`() {
        val parser = SseFrameParser()
        assertTrue(parser.feed(": ping\n").isEmpty())
        assertTrue(parser.feed(": ping\n\n").isEmpty())
        val frames = parser.feed("data: x\n\n")
        assertEquals(1, frames.size)
    }

    @Test
    fun `CRLF 与 CR 行终止符都支持`() {
        val parser = SseFrameParser()
        val frames = parser.feed("id: 1\r\nevent: task.created\r\ndata: {}\r\n\r\n")
        assertEquals(1, frames.size)
        assertEquals("1", frames[0].id)
        assertEquals("{}", frames[0].data)
    }

    @Test
    fun `包尾的 CR 必须等到下一个包确认是否 CRLF`() {
        val parser = SseFrameParser()
        // 结尾单独一个 \r：如果立刻当行终止符，会把 id 行和后续 data 行都处理错
        assertTrue(parser.feed("data: hello\r").isEmpty())
        val frames = parser.feed("\n\n")
        assertEquals(1, frames.size)
        assertEquals("hello", frames[0].data)
    }

    @Test
    fun `一个包内包含多条帧`() {
        val parser = SseFrameParser()
        val frames = parser.feed(
            "id: 1\ndata: {\"seq\":1}\n\nid: 2\ndata: {\"seq\":2}\n\n",
        )
        assertEquals(2, frames.size)
        assertEquals("{\"seq\":1}", frames[0].data)
        assertEquals("{\"seq\":2}", frames[1].data)
    }

    @Test
    fun `冒号后仅去掉一个空格`() {
        val parser = SseFrameParser()
        val frames = parser.feed("data:  two spaces\n\n")
        assertEquals(" two spaces", frames[0].data)
    }

    @Test
    fun `没有冒号的行按空值字段处理且不影响后续`() {
        val parser = SseFrameParser()
        val frames = parser.feed("data\n\ndata: ok\n\n")
        assertEquals(2, frames.size)
        assertEquals("", frames[0].data)
        assertEquals("ok", frames[1].data)
    }

    @Test
    fun `reset 丢弃半条事件`() {
        val parser = SseFrameParser()
        assertTrue(parser.feed("id: 9\ndata: 半条").isEmpty())
        parser.reset()
        val frames = parser.feed("\n\n")
        assertTrue(frames.isEmpty())
        assertNull(frames.firstOrNull()?.id)
    }

    @Test
    fun `空行单独出现不产生空帧`() {
        val parser = SseFrameParser()
        assertTrue(parser.feed("\n\n\n").isEmpty())
    }
}
