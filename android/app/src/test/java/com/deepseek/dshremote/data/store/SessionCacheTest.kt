package com.deepseek.dshremote.data.store

import com.deepseek.dshremote.data.api.ChatMessage
import com.deepseek.dshremote.data.api.JsonV2
import com.deepseek.dshremote.data.api.SessionSummary
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 离线缓存（会话列表 + 对话记录）与文件安全化。
 *
 * 缓存是"best effort"：损坏必须是降级成空，而不是让 App 起不来。
 */
class SessionCacheTest {

    private val dir = Files.createTempDirectory("dsh-cache-test").toFile()

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    @Test
    fun `会话列表与对话记录往返保留中文与 emoji`() {
        val cache = SessionCache(dir)
        val sessions = JsonV2.parseSessions(
            """{ "sessions": [ { "id":"session-1","title":"远程控制台开发 🚀","workspace":"D:\\W",
                 "updatedAt":2,"source":"computer" } ] }""",
        )
        cache.saveSessions(sessions)
        val restored = cache.loadSessions()
        assertEquals(1, restored.size)
        assertEquals("远程控制台开发 🚀", restored[0].title)
        assertTrue(cache.hasSessionsCache())

        val messages = listOf(
            ChatMessage(seq = 1, role = "user", at = 1, text = "帮我看看构建失败的原因 😅"),
            ChatMessage(seq = 2, role = "assistant", at = 2, text = "定位到 AGP 版本不匹配…"),
        )
        cache.saveTranscript("session-1", messages)
        val restoredMessages = cache.loadTranscript("session-1")
        assertEquals(2, restoredMessages.size)
        assertEquals("帮我看看构建失败的原因 😅", restoredMessages[0].text)
        assertEquals("定位到 AGP 版本不匹配…", restoredMessages[1].text)
    }

    @Test
    fun `未写过的会话返回空而不是抛异常`() {
        val cache = SessionCache(dir)
        assertTrue(cache.loadSessions().isEmpty())
        assertTrue(cache.loadTranscript("not-exist").isEmpty())
        assertFalse(cache.hasSessionsCache())
    }

    @Test
    fun `损坏的缓存文件降级为空`() {
        val cache = SessionCache(dir)
        dir.mkdirs()
        java.io.File(dir, "sessions.json").writeText("{ this is not json")
        assertTrue(cache.loadSessions().isEmpty())

        java.io.File(dir, "transcript-session-1.json").writeText("<<broken>>")
        assertTrue(cache.loadTranscript("session-1").isEmpty())
    }

    @Test
    fun `clear 清掉缓存文件`() {
        val cache = SessionCache(dir)
        cache.saveSessions(
            listOf(
                SessionSummary(
                    id = "s1",
                    title = "t",
                    workspace = "D:\\W",
                    cwd = "D:\\W",
                    createdAt = 1,
                    updatedAt = 2,
                    turns = 0,
                    steps = 0,
                    live = false,
                    origin = "user",
                    agentPreset = "",
                    bytes = 0,
                    eventCount = 0,
                    hasChanges = false,
                    changeCount = 0,
                    lastTurnState = null,
                    lastTurnReason = null,
                ),
            ),
        )
        assertTrue(cache.hasSessionsCache())
        cache.clear()
        assertFalse(cache.hasSessionsCache())
        assertTrue(cache.loadSessions().isEmpty())
    }

    @Test
    fun `文件名安全化不会跳出目录`() {
        val name = SessionCache.safeName("../../etc/passwd")
        assertFalse(name.contains(".."))
        assertFalse(name.contains("/"))
        assertTrue(name, name.isNotEmpty())

        val long = SessionCache.safeName("s".repeat(400))
        assertTrue("超长 id 必须被截断，避免文件名超限", long.length <= 120)
    }
}
