package com.deepseek.dshremote.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 子智能体（派生）会话的判定与标注 —— Android 侧。
 *
 * 背景（用户诉求）：手机会话列表不要被子智能体会话刷屏。PC 网关只负责"按元数据过滤"，
 * 手机端**必须自己也能判**，否则离线缓存回放、老网关（不下发 origin）时子代理会话会重新冒出来。
 *
 * 判据与服务端 `tools/dsh-remote/lib/dsh-home.mjs` 的 `isDerivedSession` **同源**：
 * 1. `origin == "subagent"` ⇒ 派生（DSH 桌面端自己的判据，两端必须一致）；
 * 2. origin **缺失**时 `delegationDepth > 0` ⇒ 派生；
 * 3. origin **缺失**时 `parentSession` 非空 ⇒ 派生（fork/副本也要折叠）。
 *
 * 最关键的一条：**缺 origin 绝不能默认成 "user"**。真实 DSH 桌面端写顶层会话 header 时
 * 压根不写 origin（实测 138 条会话里 30 条顶层全无此字段），只有子代理会话才由
 * `dsh-subagent` 显式写 `origin:"subagent"`；旧代码 `optString("origin", "user")`
 * 把"没告诉我"读成"它是用户会话"，正是刷屏的成因。
 */
class SessionDerivationTest {

    private fun summary(
        id: String = "session-1",
        origin: String? = null,
        parentSession: String? = null,
        delegationDepth: Int = 0,
        parentTitle: String? = null,
        title: String = "会话",
    ) = SessionSummary(
        id = id,
        title = title,
        workspace = "D:\\Workspace\\dsh_android",
        cwd = "D:\\Workspace\\dsh_android",
        createdAt = 0L,
        updatedAt = 0L,
        turns = 0,
        steps = 0,
        live = false,
        origin = origin,
        parentSession = parentSession,
        delegationDepth = delegationDepth,
        parentTitle = parentTitle,
        agentPreset = "standard",
        bytes = 0L,
        eventCount = 0,
        hasChanges = false,
        changeCount = 0,
        lastTurnState = null,
        lastTurnReason = null,
    )

    @Test
    fun `缺 origin 但 delegationDepth 大于 0 时必须判为子代理`() {
        // 这条会话"没告诉我 origin"——旧代码会把它当成 user 显示出来
        val missingOrigin = summary(id = "0b3c9651-c80e-488c-b911-1d6370388aca", origin = null, delegationDepth = 1)
        assertTrue("深度是父+1 的权威计数，缺 origin 时靠它推断", missingOrigin.isSubagent)
        assertNull("缺 origin 读成 null：这是判据能生效的前提，不许兜底成 \"user\"", missingOrigin.origin)

        // 深层子代理（实测真实 home 里有 depth=2 的 36 条）
        assertTrue(summary(origin = null, delegationDepth = 2).isSubagent)

        // 顶层：没有 origin、没有 parent、深度 0 ⇒ 仍是顶层（不能把正常会话误伤掉）
        assertFalse(summary(origin = null, delegationDepth = 0).isSubagent)
    }

    @Test
    fun `parentSession 非空时必须判为派生会话`() {
        // 真实案例：session-b64b78d8-…（fork「CAN通信库开发虚拟测试环境方案」）
        // header 里没有 origin、delegationDepth=0，只有 parentSession
        val fork = summary(
            id = "session-b64b78d8-5490-4d8c-936a-09a82c4c9616",
            origin = null,
            parentSession = "session-c6116e3f-6f3a-479b-bd34-5d9f13d79007",
            delegationDepth = 0,
        )
        assertTrue("有父会话就不是顶层，无论深度多少", fork.isSubagent)
    }

    @Test
    fun `显式 origin 以 origin 为准，缺失时才回退到深度与父会话`() {
        // DSH 桌面端判据：origin === "subagent" 一律隐藏
        assertTrue(summary(origin = "subagent").isSubagent)
        assertTrue("显式 subagent 即使深度/父会话字段缺失也算派生", summary(origin = "subagent", delegationDepth = 0).isSubagent)
        // 显式 user 就是顶层（服务端表过态，不再拿深度去推翻它）
        assertFalse(summary(origin = "user").isSubagent)
        assertFalse(summary(origin = "user", delegationDepth = 0).isSubagent)
        // 大小写/空白容错（网关不同版本写法可能不同）
        assertTrue(summary(origin = "SUBAGENT").isSubagent)
        assertTrue(summary(origin = " subagent ").isSubagent)
        // 空串等同缺字段 ⇒ 走推断分支
        assertTrue(summary(origin = "", delegationDepth = 1).isSubagent)
        assertFalse(summary(origin = "", delegationDepth = 0).isSubagent)
    }

    @Test
    fun `打开含子代理后条目要能看出父子关系`() {
        // 父标题已回填：显示成「子代理 · 父会话「优化手机端 App 界面」」
        val named = summary(origin = "subagent", parentSession = "session-1716c25b-c832-4e00-bae5-8827a8ee4aa2", parentTitle = "优化手机端 App 界面")
        assertEquals("子代理 · 父会话「优化手机端 App 界面」", named.derivedLabel)

        // 深层：补上第几层（实测真实 home 有 depth=2）
        val deep = summary(origin = "subagent", parentSession = "session-x", delegationDepth = 2, parentTitle = "根任务")
        assertEquals("子代理 · 父会话「根任务」· 第 2 层", deep.derivedLabel)

        // 父不在本批列表里 ⇒ 退化成 id 短写，但**绝不编标题**
        val unknownParent = summary(origin = "subagent", parentSession = "session-1716c25b-c832-4e00-bae5-8827a8ee4aa2")
        assertEquals("子代理 · 父会话 1716c25b", unknownParent.derivedLabel)

        // 顶层会话不加任何徽标
        assertNull("顶层会话没有派生标注", summary(origin = null, delegationDepth = 0).derivedLabel)
    }

    @Test
    fun `父标题只在本批列表里回填，不编造`() {
        val root = summary(id = "session-root", title = "优化手机端 App 界面", origin = null)
        val child = summary(id = "0b3c9651", origin = "subagent", parentSession = "session-root")
        val orphan = summary(id = "orphan", origin = "subagent", parentSession = "session-不在本批里")

        val filled = listOf(root, child, orphan).withParentTitles()
        assertEquals("优化手机端 App 界面", filled[1].parentTitle)
        assertNull("父会话不在本批 ⇒ 保持 null，界面用 id 短写", filled[2].parentTitle)
        assertEquals("子代理 · 父会话「优化手机端 App 界面」", filled[1].derivedLabel)

        // 没有派生会话时原样返回（不白白复制列表）
        val plain = listOf(root)
        assertTrue("没有派生会话时应原样返回", plain.withParentTitles() === plain)
    }

    @Test
    fun `网关下发的派生字段被解析进模型`() {
        val sessions = JsonV2.parseSessions(
            """
            { "sessions": [
                { "id": "session-6a3cd446", "title": "顶层", "workspace": "D:\\W",
                  "origin": "user", "delegationDepth": 0, "source": "computer" },
                { "id": "0b3c9651", "title": "子代理", "workspace": "D:\\W",
                  "parentSession": "session-1716c25b-c832-4e00-bae5-8827a8ee4aa2",
                  "delegationDepth": 1, "origin": "subagent", "source": "computer" },
                { "id": "session-b64b78d8", "title": "fork", "workspace": "D:\\W",
                  "parentSession": "session-c6116e3f-6f3a-479b-bd34-5d9f13d79007",
                  "delegationDepth": 0, "source": "computer" }
            ] }
            """.trimIndent(),
        )
        assertEquals(3, sessions.size)

        assertEquals("显式 origin=user 原样保留", "user", sessions[0].origin)
        assertFalse(sessions[0].isSubagent)

        assertEquals("subagent", sessions[1].origin)
        assertEquals(1, sessions[1].delegationDepth)
        assertEquals("session-1716c25b-c832-4e00-bae5-8827a8ee4aa2", sessions[1].parentSession)
        assertTrue(sessions[1].isSubagent)

        // 缺 origin + 有 parent ⇒ 必须判派生（老网关/桌面端 header 就是这个形状）
        assertNull("缺 origin 必须读成 null，不能默认成 user", sessions[2].origin)
        assertTrue(sessions[2].isSubagent)
    }

    @Test
    fun `离线缓存往返保留派生关系且不把缺 origin 补成 user`() {
        val fork = summary(
            id = "session-b64b78d8-5490-4d8c-936a-09a82c4c9616",
            origin = null,
            parentSession = "session-c6116e3f-6f3a-479b-bd34-5d9f13d79007",
            delegationDepth = 0,
        )
        val child = summary(id = "0b3c9651", origin = "subagent", parentSession = "session-root", delegationDepth = 2)
        val root = summary(id = "session-root", title = "顶层", origin = null)

        val restored = JsonV2.sessionsFromJson(JsonV2.sessionsToJson(listOf(fork, child, root)))
        assertEquals(3, restored.size)
        assertNull("缓存不许把缺失的 origin 写成 \"user\"——那会让折叠判据失效", restored[0].origin)
        assertTrue("缺 origin + 有 parent 的 fork 在离线回放时仍要折叠", restored[0].isSubagent)
        assertEquals("subagent", restored[1].origin)
        assertEquals(2, restored[1].delegationDepth)
        assertTrue(restored[1].isSubagent)
        assertFalse("顶层会话在离线回放时不能被误折叠", restored[2].isSubagent)
    }
}
