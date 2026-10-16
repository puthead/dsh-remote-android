package com.deepseek.dshremote.data.api

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「谁发起的」与「在哪执行」这两件事必须分开：手机新建的任务默认落在**电脑端** DSH 上，
 * 于是同一条会话是 `source:"computer" + createdBy:"phone" + driver:"desktop"`。
 *
 * 钉死三组契约：
 * 1. `createdBy` 只描述发起方，缺字段（老网关）时按 `source` 回退，行为与本轮改造前**逐字一致**；
 * 2. `host` 决定这次任务落在哪跑，从而决定请求体带不带权限档、回执怎么念给用户听；
 * 3. 落电脑端时**不许**谈权限档——手机根本没指定（请求里不带 `access`），说成"已按某档执行"是撒谎。
 */
class TaskOriginTest {

    private fun session(
        id: String = "session-1",
        source: String = SessionSummary.SOURCE_COMPUTER,
        createdBy: String? = null,
        writable: Boolean? = null,
        driver: String? = null,
    ) = SessionSummary(
        id = id,
        title = "远程控制台开发",
        workspace = "D:\\Workspace\\dsh_android",
        cwd = "D:\\Workspace\\dsh_android",
        createdAt = 1791463029427L,
        updatedAt = 1791468699595L,
        turns = 2,
        steps = 249,
        live = true,
        origin = "user",
        agentPreset = "standard",
        bytes = 1598845L,
        eventCount = 1779,
        hasChanges = false,
        changeCount = 0,
        lastTurnState = "ended",
        lastTurnReason = "completed",
        source = source,
        writableFlag = writable,
        driverFlag = driver,
        createdByFlag = createdBy,
    )

    // ---------- createdBy：谁发起的 ----------

    @Test
    fun `老网关缺 createdBy 时按 source 回退，行为与本轮改造前一致`() {
        val computer = session()
        assertEquals(SessionSummary.CREATED_BY_DESKTOP, computer.createdBy)
        assertFalse("电脑端原生会话不是我的任务", computer.isPhoneTask)
        assertTrue(computer.isComputerSession)
        assertEquals("电脑", computer.originLabel)

        val phone = session(source = SessionSummary.SOURCE_PHONE)
        assertEquals(SessionSummary.CREATED_BY_PHONE, phone.createdBy)
        assertTrue("手机会话必须仍算我的任务", phone.isPhoneTask)
        assertEquals("手机", phone.originLabel)
    }

    @Test
    fun `手机发起但落在电脑端的会话算我的任务，并说清在哪执行`() {
        val mine = session(
            source = SessionSummary.SOURCE_COMPUTER,
            createdBy = SessionSummary.CREATED_BY_PHONE,
            writable = true,
            driver = SessionSummary.DRIVER_DESKTOP,
        )
        assertTrue("手机派出去的任务不能从「我的任务」里消失", mine.isPhoneTask)
        assertTrue("它同时是电脑端会话", mine.isComputerSession)
        assertEquals("电脑", mine.sourceLabel)
        assertEquals("手机发起", mine.createdByLabel)
        assertEquals("电脑执行", mine.executionLabel)
        assertEquals("手机发起 · 电脑执行", mine.originLabel)
        assertTrue("电脑端可续聊的会话手机必须能发", mine.writable)
        assertEquals(SessionSummary.DRIVER_DESKTOP, mine.driver)
        assertTrue(mine.isDesktopDriven)
    }

    @Test
    fun `电脑自己发起的会话即使能续聊也不算我的任务`() {
        val theirs = session(
            source = SessionSummary.SOURCE_COMPUTER,
            createdBy = SessionSummary.CREATED_BY_DESKTOP,
            writable = true,
            driver = SessionSummary.DRIVER_DESKTOP,
        )
        assertFalse(theirs.isPhoneTask)
        assertEquals("电脑发起", theirs.createdByLabel)
        assertEquals("电脑", theirs.originLabel)
        assertTrue("也不算我的任务，但仍然是可续聊的电脑端会话", theirs.writable)
    }

    @Test
    fun `createdBy 是脏值（空白 大小写 未知）时安全回退到 source`() {
        assertTrue(session(createdBy = " Phone ").isPhoneTask)
        assertEquals(
            SessionSummary.CREATED_BY_DESKTOP,
            session(createdBy = "DESKTOP").createdBy,
        )
        // 未知取值不许当成"我的任务"：gateway host 的会话 source 本来就是 phone，
        // 而电脑端会话遇到看不懂的 createdBy 时按 source 回退 = 不是我的任务。
        assertEquals(SessionSummary.CREATED_BY_DESKTOP, session(createdBy = "robot").createdBy)
        assertFalse(session(createdBy = "robot").isPhoneTask)
        assertTrue(session(source = SessionSummary.SOURCE_PHONE, createdBy = "").isPhoneTask)
    }

    @Test
    fun `落电脑端但不可续聊的会话仍算我的任务（只是发不出去）`() {
        val stale = session(
            source = SessionSummary.SOURCE_COMPUTER,
            createdBy = SessionSummary.CREATED_BY_PHONE,
            writable = false,
        )
        assertTrue(stale.isPhoneTask)
        assertFalse(stale.writable)
        assertEquals("电脑", stale.sourceLabel)
        assertEquals("手机发起 · 电脑执行", stale.originLabel)
    }

    @Test
    fun `列表 JSON 里读得到 createdBy`() {
        val sessions = JsonV2.parseSessions(
            """
            {
              "sessions": [
                {
                  "id": "session-a", "title": "我派的任务", "workspace": "D:\\Workspace\\dsh_android",
                  "createdAt": 1791463029427, "updatedAt": 1791468699595, "turns": 1, "steps": 3,
                  "live": false, "origin": "user", "source": "computer", "createdBy": "phone",
                  "writable": true, "driver": "desktop"
                },
                {
                  "id": "session-b", "title": "老网关", "workspace": "D:\\Workspace\\dsh_android",
                  "updatedAt": 1791468699595, "origin": "user", "source": "computer"
                }
              ]
            }
            """.trimIndent(),
        )
        assertEquals(2, sessions.size)
        assertTrue(sessions[0].isPhoneTask)
        assertEquals("手机发起 · 电脑执行", sessions[0].originLabel)
        assertFalse("老网关没有 createdBy → 不是我的任务", sessions[1].isPhoneTask)
        assertNull(sessions[1].createdByFlag)
    }

    @Test
    fun `离线缓存往返不丢 createdBy，也不给老网关凭空造字段`() {
        val mine = session(
            source = SessionSummary.SOURCE_COMPUTER,
            createdBy = SessionSummary.CREATED_BY_PHONE,
            writable = true,
            driver = SessionSummary.DRIVER_DESKTOP,
        )
        val legacy = session(id = "session-2", source = SessionSummary.SOURCE_COMPUTER)

        val cache = JsonV2.sessionsToJson(listOf(mine, legacy))
        val restored = JsonV2.sessionsFromJson(cache)
        assertEquals(2, restored.size)
        assertTrue("离线回放时我的任务不能从列表里消失", restored[0].isPhoneTask)
        assertEquals("手机发起 · 电脑执行", restored[0].originLabel)
        assertNull("老网关会话不该被凭空补上 createdBy", restored[1].createdByFlag)
        assertFalse(restored[1].isPhoneTask)

        val raw = JSONObject(cache).getJSONArray("sessions")
        assertEquals("phone", raw.getJSONObject(0).optString("createdBy"))
        assertFalse("没有就整条不写", raw.getJSONObject(1).has("createdBy"))
    }

    // ---------- host：这次任务落在哪跑 ----------

    @Test
    fun `TaskHost 归一化只认 desktop 与 gateway`() {
        assertEquals(TaskHost.DESKTOP, TaskHost.fromWireOrNull(" Desktop "))
        assertEquals(TaskHost.GATEWAY, TaskHost.fromWireOrNull("GATEWAY"))
        assertNull(TaskHost.fromWireOrNull(null))
        assertNull(TaskHost.fromWireOrNull(""))
        assertNull(TaskHost.fromWireOrNull("   "))
        assertNull("看不懂的值不许瞎猜", TaskHost.fromWireOrNull("native"))
    }

    @Test
    fun `落网关才带权限档，落电脑端不带`() {
        assertEquals(
            TaskAccess.FULL,
            accessForHost(TaskAccess.FULL, TaskHost.GATEWAY),
        )
        assertNull(
            "落电脑端时权限跟随电脑端 DSH，带上就是自欺欺人",
            accessForHost(TaskAccess.FULL, TaskHost.DESKTOP),
        )
        assertNull("host 缺省 = 交给网关定，缺省按落电脑端处理", accessForHost(TaskAccess.FULL, null))
        assertNull(accessForHost(TaskAccess.FULL, "native"))
    }

    @Test
    fun `host 选择决定请求体里的 host 与 access`() {
        val desktop = JSONObject(
            buildCreateTaskPayload(
                workspace = "D:\\Workspace\\dsh_android",
                prompt = "跑一下测试",
                host = TaskHost.DESKTOP,
                access = accessForHost(TaskAccess.FULL, TaskHost.DESKTOP),
            ),
        )
        assertEquals("desktop", desktop.getString("host"))
        assertFalse("落电脑端不带权限档：$desktop", desktop.has("access"))

        val gateway = JSONObject(
            buildCreateTaskPayload(
                workspace = "D:\\Workspace\\dsh_android",
                prompt = "跑一下测试",
                host = TaskHost.GATEWAY,
                access = accessForHost(TaskAccess.FULL, TaskHost.GATEWAY),
            ),
        )
        assertEquals("gateway", gateway.getString("host"))
        assertEquals("full", gateway.getString("access"))

        val legacy = JSONObject(
            buildCreateTaskPayload(
                workspace = "D:\\Workspace\\dsh_android",
                prompt = "跑一下测试",
            ),
        )
        assertFalse("缺省不带 host，由网关决定", legacy.has("host"))
        assertTrue("旧调用方仍然带上默认档", legacy.has("access"))
    }

    @Test
    fun `回执的 host 决定这次任务算在哪跑`() {
        val onDesktop = JsonV2.parseCreateTask(
            """{"sessionId":"session-x","accepted":true,"source":"computer","createdBy":"phone","host":"desktop"}""",
        )
        assertTrue(onDesktop.runsOnDesktop)
        assertEquals(TaskHost.DESKTOP, TaskHost.fromWireOrNull(onDesktop.host))
        assertEquals("phone", onDesktop.createdBy)

        val onGateway = JsonV2.parseCreateTask(
            """{"task":{"sessionId":"session-y","accepted":true,"source":"phone","host":"gateway","access":"workspace"}}""",
        )
        assertFalse(onGateway.runsOnDesktop)
        assertEquals(TaskAccess.WORKSPACE, onGateway.taskAccess)

        val legacy = JsonV2.parseCreateTask("""{"sessionId":"session-z","accepted":true,"source":"computer"}""")
        assertNull(legacy.host)
        assertTrue("旧网关不回 host 时按 source 推导", legacy.runsOnDesktop)
        assertNull(legacy.createdBy)
    }

    // ---------- 回执文案：先说清在哪跑，再谈权限 ----------

    @Test
    fun `落电脑端时不许谈权限档`() {
        val note = CreateTaskOutcome(
            sessionId = "session-x",
            turnId = "turn-1",
            accepted = true,
            source = SessionSummary.SOURCE_COMPUTER,
            host = TaskHost.DESKTOP,
        ).placementNote()
        assertTrue(note, note.contains("电脑端"))
        assertTrue("要说清权限归谁管：$note", note.contains("跟随电脑端"))
        assertFalse("手机没指定权限档，不许说成已按某档执行：$note", note.contains("已按"))
        assertFalse(note, note.contains("全部权限"))
        assertFalse(note, note.contains("仅当前工作区"))
    }

    @Test
    fun `落网关时按回执的权限档说清`() {
        val full = CreateTaskOutcome(
            sessionId = "session-y",
            turnId = "turn-1",
            accepted = true,
            source = SessionSummary.SOURCE_PHONE,
            host = TaskHost.GATEWAY,
            access = "full",
        ).placementNote()
        assertTrue(full, full.contains("全部权限"))

        val workspaceOnly = CreateTaskOutcome(
            sessionId = "session-y",
            turnId = "turn-1",
            accepted = true,
            source = SessionSummary.SOURCE_PHONE,
            host = TaskHost.GATEWAY,
            access = "workspace",
        ).placementNote()
        assertTrue(workspaceOnly, workspaceOnly.contains("仅当前工作区"))
    }

    @Test
    fun `旧网关不回执权限档时说清是按默认档执行的`() {
        val legacy = CreateTaskOutcome(
            sessionId = "session-z",
            turnId = "turn-1",
            accepted = true,
            source = SessionSummary.SOURCE_PHONE,
            access = null,
        ).placementNote()
        assertTrue("勾了「全部权限」却只拿到工作区档，必须让人知道：$legacy", legacy.contains("未回执"))
        assertTrue(legacy, legacy.contains("仅当前工作区"))
        assertFalse("别把没回执说成已按全部权限：$legacy", legacy.contains("全部权限"))
    }

    // ---------- 模型：选了什么发什么，没选就一个字段都不发（需求：新建任务时能换模型） ----------

    @Test
    fun `带模型的新建任务发 model provider 与推理等级`() {
        val picked = JSONObject(
            buildCreateTaskPayload(
                workspace = "D:\\Workspace\\dsh_android",
                prompt = "用 pro 跑一遍全量单测",
                clientTurnId = "ct-3",
                model = "deepseek-v4-pro",
                provider = "deepseek-official",
                reasoningEffort = "high",
                host = TaskHost.DESKTOP,
                // 与 ConsoleRepository.createPhoneTask 同形：落电脑端时 accessForHost 给的就是 null
                access = accessForHost(TaskAccess.FULL, TaskHost.DESKTOP),
            ),
        )
        assertEquals("deepseek-v4-pro", picked.getString("model"))
        assertEquals("deepseek-official", picked.getString("provider"))
        assertEquals("high", picked.getString("reasoningEffort"))
        assertEquals("desktop", picked.getString("host"))
        assertFalse("落电脑端的任务不许带权限档：$picked", picked.has("access"))
    }

    @Test
    fun `没选模型时不许带 provider 也不许带推理等级`() {
        val none = JSONObject(
            buildCreateTaskPayload(
                workspace = "D:\\Workspace\\dsh_android",
                prompt = "跑测试",
                clientTurnId = "ct-4",
                model = null,
                provider = "deepseek-official",
                reasoningEffort = "high",
            ),
        )
        assertFalse("没选就按执行端当前模型跑：$none", none.has("model"))
        assertFalse("单独一个 provider 网关选不出模型：$none", none.has("provider"))
        assertFalse("没有模型时推理等级同样无意义：$none", none.has("reasoningEffort"))
    }

    @Test
    fun `模型名只有空白等于没选`() {
        val blank = JSONObject(
            buildCreateTaskPayload(
                workspace = "D:\\Workspace\\dsh_android",
                prompt = "跑测试",
                model = "   ",
                provider = "deepseek-official",
                reasoningEffort = "  ",
            ),
        )
        assertFalse("空串不许发出去让网关去猜：$blank", blank.has("model"))
        assertFalse(blank.has("provider"))
        assertFalse(blank.has("reasoningEffort"))
    }
}
