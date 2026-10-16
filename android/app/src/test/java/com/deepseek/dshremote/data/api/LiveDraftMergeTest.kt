package com.deepseek.dshremote.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 电脑端会话的**实时性**就靠这三条合并规则（`assistant/message`、`tool/call`、`tool/result`）。
 *
 * 为什么单独测这一层：`ConsoleRepository` 需要 Android Context，纯 JVM 起不来
 * （同一原因见 TranscriptPagerTest 的说明），所以规则抽成了 [LiveDraftMerge]；
 * 这里既逐条钉死规则，又用真实 SSE 文本串起来验证"一整个电脑端轮次 → 一条消息"。
 */
class LiveDraftMergeTest {

    private fun draft(
        seq: Long = 0L,
        role: String = "assistant",
        text: String = "",
        toolCalls: List<ToolCall> = emptyList(),
    ) = ChatMessage(seq = seq, role = role, at = AT, text = text, toolCalls = toolCalls)

    @Test
    fun `assistant 增量在草稿上累加文本`() {
        val first = LiveDraftMerge.delta(null, seq = 1801L, role = "assistant", text = "正在", at = AT)
        assertEquals("正在", first.text)
        assertEquals(1801L, first.seq)
        assertEquals("assistant", first.role)
        assertEquals(AT, first.at)

        val second = LiveDraftMerge.delta(first, seq = 1802L, role = "assistant", text = "读取文件", at = AT)
        assertEquals("正在读取文件", second.text)
        // 事件给了新 seq 就跟上（详情页据此和 /transcript 对齐）
        assertEquals(1802L, second.seq)
        // 累加而不是替换：草稿必须一直是"整条消息"
        assertTrue(second.isAssistant)
    }

    @Test
    fun `增量事件不带 seq 时保留草稿已有序号`() {
        val existing = draft(seq = 1802L, text = "已累积")
        val merged = LiveDraftMerge.delta(existing, seq = null, role = "assistant", text = "＋新", at = AT)
        assertEquals(1802L, merged.seq)
        assertEquals("已累积＋新", merged.text)
    }

    @Test
    fun `没有草稿时首帧增量新建 assistant 消息`() {
        val created = LiveDraftMerge.delta(null, seq = null, role = "assistant", text = "第一帧", at = AT)
        // 没有 seq 的新草稿用 0：与本地乐观消息同一约定（服务端投影会覆盖）
        assertEquals(0L, created.seq)
        assertEquals("第一帧", created.text)
        assertTrue(created.toolCalls.isEmpty())
    }

    @Test
    fun `工具调用事件没有草稿时先起一条空的 assistant 草稿`() {
        val merged = LiveDraftMerge.toolStarted(
            existing = null,
            seq = 1803L,
            name = "read",
            argsJson = "{\"path\":\"a.kt\"}",
            at = AT,
        )
        assertTrue("工具事件也要挂在 assistant 消息上", merged.isAssistant)
        assertEquals("", merged.text)
        assertEquals(1, merged.toolCalls.size)
        merged.toolCalls[0].let { call ->
            assertEquals("live-1803", call.id)
            assertEquals("read", call.name)
            assertEquals("{\"path\":\"a.kt\"}", call.argsJson)
            // 结果还没回来：留空，等 tool/result 回填（[ToolCall.hasResult] 保持 false）
            assertEquals("", call.result)
            assertFalse(call.isError)
            assertFalse(call.hasResult)
            assertEquals(0L, call.durationMs)
        }
    }

    @Test
    fun `工具调用不清空已累积的文本`() {
        val existing = draft(seq = 1802L, text = "我先看看")
        val merged = LiveDraftMerge.toolStarted(existing, seq = 1803L, name = "read", argsJson = "{}", at = AT)
        assertEquals("我先看看", merged.text)
        assertEquals(1, merged.toolCalls.size)
    }

    @Test
    fun `工具结果回填第一个还没有结果的调用`() {
        val withCall = LiveDraftMerge.toolStarted(draft(text = "跑一下"), seq = 1L, name = "bash", argsJson = "{}", at = AT)
        val filled = requireNotNull(LiveDraftMerge.toolResult(withCall, result = "exit 0", isError = false)) {
            "有草稿时 tool/result 必须回填"
        }
        assertEquals("exit 0", filled.toolCalls[0].result)
        assertFalse(filled.toolCalls[0].isError)
        assertTrue(filled.toolCalls[0].hasResult)
        // 文本与工具列表的其它内容不能被动到
        assertEquals("跑一下", filled.text)
        assertEquals("bash", filled.toolCalls[0].name)
    }

    @Test
    fun `并发工具调用按到达顺序两两配对`() {
        var message = LiveDraftMerge.toolStarted(null, seq = 10L, name = "read", argsJson = "{}", at = AT)
        message = LiveDraftMerge.toolStarted(message, seq = 11L, name = "grep", argsJson = "{}", at = AT)
        assertEquals(2, message.toolCalls.size)

        // 第一个结果回填 read，第二个回填 grep —— 不能两个都写进同一条
        message = LiveDraftMerge.toolResult(message, result = "read ok", isError = false)!!
        message = LiveDraftMerge.toolResult(message, result = "grep 失败", isError = true)!!

        assertEquals("read ok", message.toolCalls[0].result)
        assertFalse(message.toolCalls[0].isError)
        assertEquals("grep 失败", message.toolCalls[1].result)
        assertTrue(message.toolCalls[1].isError)
    }

    @Test
    fun `没有草稿时工具结果被丢弃而不是凭空造一条消息`() {
        // 重连后收到孤立的 tool/result（前面的 tool/call 在断线期间丢了）：
        // 造一条只有结果、没有调用的消息只会让用户看到一段无来由的日志
        assertNull(LiveDraftMerge.toolResult(existing = null, result = "ok", isError = false))
    }

    @Test
    fun `电脑端会话的一串 SSE 事件增量合并成一条完整消息`() {
        val parser = SseV2Parser()
        // 故意从**帧中间**切开，验证分包不影响合并结果
        val head = """
            event: turn.started
            data: {"sessionId":"session-pc","turn":3,"fromSeq":1800,"source":"computer"}

            event: message.delta
            data: {"sessionId":"session-pc","seq":1801,"role":"assistant","text":"正在"}

            event: message.delta
            data: {"sessionId":"session-pc","seq":1802,"role":"assistant","text":"读取文件"}

            """.trimIndent() + "\n"
        val tail = """
            event: tool.call
            data: {"sessionId":"session-pc","seq":1803,"name":"read","args":{"path":"a.kt"}}

            event: tool.result
            data: {"sessionId":"session-pc","seq":1804,"isError":false,"result":"ok"}

            event: message.delta
            data: {"sessionId":"session-pc","seq":1805,"role":"assistant","text":"完成"}

            event: turn.ended
            data: {"sessionId":"session-pc","turn":3,"reason":"completed","resumable":true}

            """.trimIndent() + "\n"

        val events = ArrayList<ConsoleEvent>()
        events += parser.feed(head)
        // 从 `event: tool.call` 中间切开
        events += parser.feed(tail.substring(0, 5))
        events += parser.feed(tail.substring(5))

        assertEquals("7 条事件全部解析出来", 7, events.size)
        val drafts = fold(events)
        val message = requireNotNull(drafts["session-pc"]) { "电脑端会话必须有实时草稿" }
        assertEquals("增量文本按到达顺序拼成一段", "正在读取文件完成", message.text)
        assertEquals("最后一条增量事件的 seq", 1805L, message.seq)
        assertEquals(1, message.toolCalls.size)
        assertEquals("read", message.toolCalls[0].name)
        assertEquals("ok", message.toolCalls[0].result)
        assertTrue(message.isAssistant)
        assertFalse("有文本也有工具结果，不是空消息", message.isEmpty)
    }

    @Test
    fun `同一流里电脑端与手机会话的草稿互不串台`() {
        val parser = SseV2Parser()
        val events = parser.feed(
            """
            event: message.delta
            data: {"sessionId":"session-pc","seq":1,"role":"assistant","text":"电脑端的"}

            event: message.delta
            data: {"sessionId":"sdk-phone","seq":2,"role":"assistant","text":"手机端的"}

            event: message.delta
            data: {"sessionId":"session-pc","seq":3,"role":"assistant","text":"输出"}

            """.trimIndent() + "\n",
        )

        val drafts = fold(events)
        assertEquals(2, drafts.size)
        assertEquals("电脑端的输出", drafts["session-pc"]?.text)
        assertEquals(3L, drafts["session-pc"]?.seq)
        assertEquals("手机端的", drafts["sdk-phone"]?.text)
        assertEquals(2L, drafts["sdk-phone"]?.seq)
    }

    @Test
    fun `电脑端一轮里的两条 turn started 不会往时间线里追加第二条消息`() {
        // 服务端实测：电脑端一轮会推两条 turn.started（桌面端真实事件 + 网关 202 回执）。
        // turn.started 只把会话标成「运行中」，不产生时间线条目，所以重复投递天然幂等。
        val parser = SseV2Parser()
        val events = parser.feed(
            """
            event: turn.started
            data: {"sessionId":"session-pc","turn":3,"fromSeq":1800,"source":"desktop"}

            event: turn.started
            data: {"sessionId":"session-pc","turn":3,"fromSeq":1800,"source":"gateway"}

            event: message.delta
            data: {"sessionId":"session-pc","seq":1801,"role":"assistant","text":"正在处理"}

            event: turn.ended
            data: {"sessionId":"session-pc","turn":3,"reason":"completed","resumable":true}

            """.trimIndent() + "\n",
        )

        val started = events.filterIsInstance<ConsoleEvent.TurnStarted>()
        assertEquals("两条 turn.started 都被解析出来", 2, started.size)
        assertEquals(3, started[0].turn)
        assertEquals(3, started[1].turn)

        val drafts = fold(events)
        assertEquals("时间线里只有增量真实产生的那一条", 1, drafts.size)
        val message = requireNotNull(drafts["session-pc"])
        assertEquals("正在处理", message.text)
        assertEquals(1801L, message.seq)
    }

    @Test
    fun `turn ended 带 resumable true 时不留下任何草稿`() {
        // 电脑端 turn.ended 恒带 resumable:true，不能被当成「会话作废」；草稿在轮末由权威页覆盖。
        val parser = SseV2Parser()
        val events = parser.feed(
            """
            event: message.delta
            data: {"sessionId":"session-pc","seq":1801,"role":"assistant","text":"好了"}

            event: turn.ended
            data: {"sessionId":"session-pc","turn":3,"turnId":"t-3","reason":"completed","resumable":true}

            """.trimIndent() + "\n",
        )

        val ended = requireNotNull(events.filterIsInstance<ConsoleEvent.TurnEnded>().singleOrNull())
        assertEquals(true, ended.resumable)
        assertEquals("t-3", ended.turnId)
        assertEquals(1, fold(events).size)
    }

    /**
     * `ConsoleRepository.applyEvent` 三条规则的等价折叠（键就是 `_drafts` 的 sessionId）。
     *
     * 只复刻与草稿合并有关的分支：会话级/心跳事件不影响草稿，这里直接忽略。
     */
    private fun fold(
        events: List<ConsoleEvent>,
        drafts: MutableMap<String, ChatMessage> = mutableMapOf(),
    ): MutableMap<String, ChatMessage> {
        events.forEach { event ->
            when (event) {
                is ConsoleEvent.MessageDelta -> drafts[event.sessionId] = LiveDraftMerge.delta(
                    existing = drafts[event.sessionId],
                    seq = event.seq,
                    role = event.role,
                    text = event.text,
                    at = AT,
                )

                is ConsoleEvent.ToolCallStarted -> drafts[event.sessionId] = LiveDraftMerge.toolStarted(
                    existing = drafts[event.sessionId],
                    seq = event.seq,
                    name = event.name,
                    argsJson = event.argsJson,
                    at = AT,
                )

                is ConsoleEvent.ToolResultReady -> LiveDraftMerge
                    .toolResult(drafts[event.sessionId], result = event.result, isError = event.isError)
                    ?.let { merged -> drafts[event.sessionId] = merged }

                else -> Unit
            }
        }
        return drafts
    }

    private companion object {
        /** 固定时间戳，避免断言里出现可变值。 */
        const val AT = 1791468699595L
    }
}
