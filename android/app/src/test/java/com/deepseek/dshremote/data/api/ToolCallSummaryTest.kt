package com.deepseek.dshremote.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 工具参数摘要与待办投影（对话流可读性的关键）。
 */
class ToolCallSummaryTest {

    @Test
    fun `摘要优先取最有信息量的参数`() {
        assertEquals(
            "gradlew :app:testDebugUnitTest",
            ToolCallSummary.summarize("pwsh", """{"command":"gradlew :app:testDebugUnitTest","timeoutMs":60000}"""),
        )
        assertEquals(
            "android/app/build.gradle.kts",
            ToolCallSummary.summarize("read", """{"path":"android/app/build.gradle.kts"}"""),
        )
        assertEquals("找 TODO", ToolCallSummary.summarize("grep", """{"query":"找 TODO"}"""))
    }

    @Test
    fun `多行参数被压成一行`() {
        val summary = ToolCallSummary.summarize("pwsh", "{\"command\":\"line1\\nline2\\nline3\"}")
        assertEquals("line1 line2 line3", summary)
    }

    @Test
    fun `无参数时退回工具名，未知字段也能给出可见摘要`() {
        assertEquals("pwsh", ToolCallSummary.summarize("pwsh", "{}"))
        val summary = ToolCallSummary.summarize("custom", """{"weirdField":"值"}""")
        assertTrue(summary, summary.contains("weirdField"))
    }

    @Test
    fun `非法 JSON 直接截断显示而不是抛异常`() {
        val summary = ToolCallSummary.summarize("x", "<not json>")
        assertEquals("<not json>", summary)
    }

    @Test
    fun `pretty 输出缩进 JSON`() {
        val pretty = ToolCallSummary.pretty("""{"b":2,"a":1}""")
        assertTrue(pretty, pretty.contains("\n"))
        assertTrue(pretty, pretty.contains("\"a\""))
    }

    @Test
    fun `待办从最后一次 todo 调用投影`() {
        val messages = listOf(
            message(
                seq = 1,
                toolCall = toolCall("todo", """{"todos":[{"content":"旧任务","status":"completed"}]}"""),
            ),
            message(
                seq = 2,
                toolCall = toolCall(
                    "write_todos",
                    """{"todos":[
                        {"content":"改 UI 主题","status":"completed"},
                        {"content":"跑单元测试","status":"in_progress"},
                        {"title":"写真机证据","status":"pending"}
                    ]}""",
                ),
            ),
        )
        val todos = TodoExtractor.fromMessages(messages)
        assertEquals(3, todos.size)
        assertTrue(todos[0].done)
        assertFalse(todos[1].done)
        assertEquals("写真机证据", todos[2].text)
        assertFalse(todos[2].done)
    }

    @Test
    fun `没有待办时返回空列表`() {
        val messages = listOf(message(seq = 1, toolCall = toolCall("pwsh", """{"command":"ls"}""")))
        assertTrue(TodoExtractor.fromMessages(messages).isEmpty())
    }

    @Test
    fun `items 与 tasks 字段名也被识别`() {
        val items = TodoExtractor.fromToolCall(toolCall("todo", """{"items":[{"text":"A","state":"done"}]}"""))
        assertEquals(1, items.size)
        assertTrue(items[0].done)

        val tasks = TodoExtractor.fromToolCall(toolCall("plan", """{"tasks":[{"task":"B"}]}"""))
        assertEquals("B", tasks[0].text)
        assertFalse(tasks[0].done)
    }

    @Test
    fun `待办工具名判定`() {
        assertTrue(TodoExtractor.isTodoTool("todo"))
        assertTrue(TodoExtractor.isTodoTool("write_todos"))
        assertTrue(TodoExtractor.isTodoTool("Plan"))
        assertFalse(TodoExtractor.isTodoTool("pwsh"))
    }

    private fun toolCall(name: String, args: String) = ToolCall(
        id = "call-$name",
        name = name,
        argsJson = args,
        result = "",
        isError = false,
        truncated = false,
        durationMs = 0L,
    )

    private fun message(seq: Long, toolCall: ToolCall) = ChatMessage(
        seq = seq,
        role = "assistant",
        at = 0L,
        text = "",
        toolCalls = listOf(toolCall),
    )
}
