package com.deepseek.dshremote.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SSE 增量解析（契约 §4.2 `GET /api/v2/sessions/stream`）。
 *
 * 弱网下"一条事件被拆成多个 chunk"是常态，所以解析器必须能跨 chunk 拼接；
 * 同时要能给出 `fromSeq` / `Last-Event-ID` 续传游标。
 */
class SseV2ParserTest {

    @Test
    fun `一条事件被拆成三个 chunk 也能解析`() {
        val parser = SseV2Parser()
        assertTrue(parser.feed("event: message.del").isEmpty())
        assertTrue(parser.feed("ta\ndata: {\"sessionId\":\"s1\",\"s").isEmpty())
        val events = parser.feed("eq\":7,\"text\":\"你好 🚀\"}\n\n")

        assertEquals(1, events.size)
        val delta = events[0] as ConsoleEvent.MessageDelta
        assertEquals("s1", delta.sessionId)
        assertEquals(7L, delta.seq)
        assertEquals("你好 🚀", delta.text)
        // data.seq 是 DSH 事件序号，只用于会话内对齐/去重
        assertEquals(7L, parser.lastDataSeq)
        // 没有 id: 行时**不产生总线游标**：否则会把续传游标推到不存在的位置
        assertNull(parser.lastEventId)
        assertNull(parser.resumeFromSeq())
    }

    @Test
    fun `多个事件在一个 chunk 里按序返回`() {
        val parser = SseV2Parser()
        val events = parser.feed(
            """
            event: turn.started
            data: {"sessionId":"s1","turn":3,"fromSeq":100}

            event: message.delta
            data: {"sessionId":"s1","seq":101,"role":"assistant","text":"A"}

            event: heartbeat
            data: {"at":123}

            """.trimIndent() + "\n",
        )
        assertEquals(3, events.size)
        assertTrue(events[0] is ConsoleEvent.TurnStarted)
        assertEquals(3, (events[0] as ConsoleEvent.TurnStarted).turn)
        assertEquals(100L, (events[0] as ConsoleEvent.TurnStarted).fromSeq)
        assertEquals("A", (events[1] as ConsoleEvent.MessageDelta).text)
        assertTrue(events[2] is ConsoleEvent.Heartbeat)
    }

    @Test
    fun `tool call 与 tool result 事件映射正确`() {
        val parser = SseV2Parser()
        val events = parser.feed(
            """
            event: tool.call
            data: {"sessionId":"s1","seq":20,"name":"pwsh","args":{"command":"ls -la"}}

            event: tool.result
            data: {"sessionId":"s1","seq":21,"isError":true,"result":"命令不存在"}

            """.trimIndent() + "\n",
        )
        val call = events[0] as ConsoleEvent.ToolCallStarted
        assertEquals("pwsh", call.name)
        assertEquals("ls -la", org.json.JSONObject(call.argsJson).optString("command"))

        val result = events[1] as ConsoleEvent.ToolResultReady
        assertTrue(result.isError)
        assertEquals("命令不存在", result.result)
    }

    @Test
    fun `id 行是总线游标，心跳不推游标`() {
        val parser = SseV2Parser()
        parser.feed("id: 1779\nevent: message.delta\ndata: {\"sessionId\":\"s1\",\"seq\":1779,\"text\":\"x\"}\n\n")
        assertEquals("1779", parser.lastEventId)
        assertEquals(1779L, parser.resumeFromSeq())

        // 心跳帧不带 id（gateway-dev 明确）：不能因为心跳把续传游标推走
        parser.feed("event: heartbeat\ndata: {\"at\":1}\n\n")
        assertEquals("1779", parser.lastEventId)
        assertEquals(1779L, parser.resumeFromSeq())

        parser.feed("id: 1780\nevent: heartbeat\ndata: {\"at\":2}\n\n")
        assertEquals(1780L, parser.resumeFromSeq())
    }

    @Test
    fun `心跳注释行不产生事件`() {
        val parser = SseV2Parser()
        assertTrue(parser.feed(": ping\n\n").isEmpty())
        assertTrue(parser.feed(":keep-alive\n").isEmpty())
    }

    @Test
    fun `CRLF 与中文多行文本正确处理`() {
        val parser = SseV2Parser()
        val events = parser.feed(
            "event: message.delta\r\n" +
                "data: {\"sessionId\":\"s1\",\"seq\":5,\"text\":\"第一行\\n第二行 ✅\"}\r\n\r\n",
        )
        assertEquals(1, events.size)
        val delta = events[0] as ConsoleEvent.MessageDelta
        assertEquals("第一行\n第二行 ✅", delta.text)
    }

    @Test
    fun `未知事件类型保留原始 data 而不打断流`() {
        val parser = SseV2Parser()
        val events = parser.feed("event: session.future\ndata: {\"a\":1}\n\n")
        assertTrue(events[0] is ConsoleEvent.Unknown)
        assertEquals("session.future", (events[0] as ConsoleEvent.Unknown).name)
    }

    @Test
    fun `半条事件在 reset 后不被派发`() {
        val parser = SseV2Parser()
        assertTrue(parser.feed("event: message.delta\ndata: {\"sessionId\":\"s1\"").isEmpty())
        parser.reset()
        assertTrue(parser.feed("\"seq\":9}\n\n").isEmpty())
    }

    @Test
    fun `续传地址与 Last-Event-ID 头部`() {
        assertEquals("/api/v2/sessions/stream", ConsoleStreams.path(null))
        assertEquals("/api/v2/sessions/stream?fromSeq=100", ConsoleStreams.path(100L))
        assertEquals("/api/v2/sessions/stream?fromSeq=100&tail=50", ConsoleStreams.path(100L, tail = 50))
        assertEquals("/api/v2/sessions/stream?tail=50", ConsoleStreams.path(-1L, tail = 50))
        assertTrue(ConsoleStreams.headers(null).isEmpty())
        assertEquals("1779", ConsoleStreams.headers("1779")["Last-Event-ID"])
    }

    @Test
    fun `turn ended 事件带结束原因`() {
        val parser = SseV2Parser()
        val events = parser.feed("event: turn.ended\ndata: {\"sessionId\":\"s1\",\"turn\":3,\"reason\":\"completed\"}\n\n")
        val ended = events[0] as ConsoleEvent.TurnEnded
        assertEquals("completed", ended.reason)
        assertNull("turn.ended 不带 seq，续传游标由 message.delta 推进", ended.seq)
    }
}
