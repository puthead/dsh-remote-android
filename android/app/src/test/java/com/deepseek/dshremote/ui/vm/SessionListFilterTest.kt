package com.deepseek.dshremote.ui.vm

import com.deepseek.dshremote.data.api.SessionSummary
import com.deepseek.dshremote.data.api.withParentTitles
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 电脑会话列表的「默认不显示子智能体会话」过滤（用户诉求 m00121）。
 *
 * 只构造 [SessionsViewModel.UiState]（嵌套 data class，纯 JVM）：`ConsoleRepository`
 * 需要 Android Context，纯 JVM 单测起不来，所以这里验证的是**界面真正拿到的那个列表**。
 *
 * 双层防线：服务端（网关 `lib/dsh-home.mjs` 的 `isDerivedSession`）已经不回派生会话，
 * 但 [SessionsViewModel.UiState.visible] 还会再按 [SessionSummary.isSubagent] 挡一次——
 * 因为仓库快照可能来自按 id 抓取的单会话刷新（那份是全量的）。
 */
class SessionListFilterTest {

    private fun session(
        id: String,
        origin: String? = null,
        parentSession: String? = null,
        delegationDepth: Int = 0,
        live: Boolean = false,
        source: String = SessionSummary.SOURCE_COMPUTER,
        title: String = "会话 $id",
        workspace: String = "D:\\Workspace\\dsh_android",
    ) = SessionSummary(
        id = id,
        title = title,
        workspace = workspace,
        cwd = workspace,
        createdAt = 0L,
        updatedAt = 0L,
        turns = 0,
        steps = 0,
        live = live,
        origin = origin,
        parentSession = parentSession,
        delegationDepth = delegationDepth,
        agentPreset = "standard",
        bytes = 0L,
        eventCount = 0,
        hasChanges = false,
        changeCount = 0,
        lastTurnState = null,
        lastTurnReason = null,
        source = source,
    )

    /** 真实 home 的形状：29 条顶层（无 origin）+ 2 层子代理 + 1 条 fork。 */
    private val realWorld = listOf(
        session(id = "session-a", title = "优化手机端 App 界面"),
        session(id = "session-b", title = "折叠工具调用并修复移动端稳定性"),
        session(id = "0b3c9651", origin = "subagent", parentSession = "session-a", delegationDepth = 1),
        session(id = "0d77a600", origin = "subagent", parentSession = "session-a", delegationDepth = 1),
        session(id = "deep-001", origin = "subagent", parentSession = "0b3c9651", delegationDepth = 2),
        // 缺 origin、有 parent（fork）：旧判据会把它当顶层放出来
        session(id = "session-b64b78d8", parentSession = "session-c6116e3f", title = "CAN通信库开发虚拟测试环境方案"),
    )

    @Test
    fun `默认状态不显示子智能体会话`() {
        val ui = SessionsViewModel.UiState(sessions = realWorld)
        assertEquals("默认只留顶层会话", 2, ui.visible.size)
        assertEquals(listOf("session-a", "session-b"), ui.visible.map { it.id })
        assertFalse("缺 origin 的 fork 也不能漏出来", ui.visible.any { it.id == "session-b64b78d8" })
    }

    @Test
    fun `打开含子代理后能看到全部并算得出折叠了多少条`() {
        val closed = SessionsViewModel.UiState(sessions = realWorld)
        assertEquals("关着时提示还有 4 条被折叠", 4, closed.hiddenDerivedCount)
        assertEquals("顶层计数不受开关影响", 2, closed.topLevelCount)

        val opened = SessionsViewModel.UiState(sessions = realWorld, includeSubagent = true)
        assertEquals(6, opened.visible.size)
        assertEquals("打开后不再有被折叠的", 0, opened.hiddenDerivedCount)
        assertEquals(2, opened.topLevelCount)
    }

    @Test
    fun `本地过滤挡住服务端漏回的派生会话`() {
        // 模拟"仓库快照来自单会话刷新（全量）"：服务端的默认过滤在这份快照上没有生效
        val leaked = realWorld + session(id = "leaked-1", origin = "subagent", parentSession = "session-a", delegationDepth = 1)
        val ui = SessionsViewModel.UiState(sessions = leaked)
        assertFalse("第二层防线必须挡住它", ui.visible.any { it.id == "leaked-1" })
        assertEquals(2, ui.visible.size)
    }

    @Test
    fun `手机任务与搜索词一起生效`() {
        val sessions = listOf(
            session(id = "session-a", title = "优化手机端 App 界面"),
            session(id = "sdk-1", source = SessionSummary.SOURCE_PHONE, title = "手机派活"),
            session(id = "0b3c9651", origin = "subagent", parentSession = "session-a", delegationDepth = 1, title = "优化手机端 App 界面"),
        )
        val ui = SessionsViewModel.UiState(sessions = sessions)
        assertEquals("电脑会话页不列手机任务", 1, ui.visible.size)

        val searched = ui.copy(query = "手机")
        assertEquals("搜索也不该把子代理搜出来", 1, searched.visible.size)
        assertEquals("session-a", searched.visible[0].id)
    }

    @Test
    fun `打开开关后子代理条目带父子关系标注`() {
        val withTitles = realWorld.withParentTitles()
        val ui = SessionsViewModel.UiState(sessions = withTitles, includeSubagent = true)

        val child = ui.visible.first { it.id == "0b3c9651" }
        assertEquals("子代理 · 父会话「优化手机端 App 界面」", child.derivedLabel)

        val grandChild = ui.visible.first { it.id == "deep-001" }
        assertEquals("子代理 · 父会话「会话 0b3c9651」· 第 2 层", grandChild.derivedLabel)

        // 顶层会话不带徽标；父不在本批里时退回 id 短写
        assertEquals(null, ui.visible.first { it.id == "session-a" }.derivedLabel)
        assertEquals("子代理 · 父会话 c6116e3f", ui.visible.first { it.id == "session-b64b78d8" }.derivedLabel)
    }

    @Test
    fun `live 与只读计数按可见列表算`() {
        val sessions = listOf(
            session(id = "session-a", live = true),
            session(id = "session-b"),
            session(id = "0b3c9651", origin = "subagent", parentSession = "session-a", delegationDepth = 1, live = true),
        )
        val ui = SessionsViewModel.UiState(sessions = sessions)
        assertEquals(1, ui.liveCount)
        assertTrue("子代理的 live 不该抬高中文计数", ui.liveCount <= ui.visible.size)
    }
}
