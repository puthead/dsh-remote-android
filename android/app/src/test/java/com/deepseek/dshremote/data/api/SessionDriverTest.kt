package com.deepseek.dshremote.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 契约更新：电脑端会话从「只读镜像」变成「可实时续聊」，以及新增 `driver` 字段的缺省推导。
 *
 * 两条必须钉死的兼容性：
 * 1. `driver` 缺失（老网关）时按 `source` 推导：computer → `desktop`，phone → `gateway`；
 * 2. `writable` 缺字段时电脑端会话仍然**不可写**（老网关不会因为我们改了客户端就变成能发）。
 */
class SessionDriverTest {

    private fun session(
        id: String = "session-1",
        source: String = SessionSummary.SOURCE_COMPUTER,
        writable: Boolean? = null,
        reason: String? = null,
        driver: String? = null,
        live: Boolean = false,
    ) = SessionSummary(
        id = id,
        title = "远程控制台开发",
        workspace = "D:\\Workspace\\dsh_android",
        cwd = "D:\\Workspace\\dsh_android",
        createdAt = 1791463029427L,
        updatedAt = 1791468699595L,
        turns = 2,
        steps = 249,
        live = live,
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
        writableReasonFlag = reason,
        driverFlag = driver,
    )

    @Test
    fun `电脑端会话缺 driver 时按 source 推导为 desktop`() {
        val computer = session()
        assertEquals(SessionSummary.DRIVER_DESKTOP, computer.driver)
        assertTrue(computer.isDesktopDriven)
        assertEquals("电脑驱动", computer.driverLabel)
    }

    @Test
    fun `手机任务缺 driver 时按 source 推导为 gateway`() {
        val phone = session(source = SessionSummary.SOURCE_PHONE)
        assertEquals(SessionSummary.DRIVER_GATEWAY, phone.driver)
        assertFalse(phone.isDesktopDriven)
        assertEquals("网关驱动", phone.driverLabel)
    }

    @Test
    fun `服务端显式 driver 优先于 source 推导`() {
        // 电脑端会话也可能由网关代跑（desktop 端不在线时移交），此时 wire 上是 gateway
        assertEquals(
            SessionSummary.DRIVER_GATEWAY,
            session(source = SessionSummary.SOURCE_COMPUTER, driver = "gateway", writable = true).driver,
        )
        assertEquals(
            SessionSummary.DRIVER_DESKTOP,
            session(source = SessionSummary.SOURCE_PHONE, driver = "desktop").driver,
        )
    }

    @Test
    fun `driver 的空白 大小写与未知值都安全回退到 source 推导`() {
        assertEquals(SessionSummary.DRIVER_GATEWAY, session(driver = " Gateway ").driver)
        assertEquals(SessionSummary.DRIVER_DESKTOP, session(driver = "DESKTOP").driver)
        // 未知取值不能当作"没有驱动方"：仍按 source 推导（老网关/新网关混跑时不出空白徽标）
        assertEquals(SessionSummary.DRIVER_DESKTOP, session(driver = "native").driver)
        assertEquals(SessionSummary.DRIVER_GATEWAY, session(source = SessionSummary.SOURCE_PHONE, driver = "").driver)
    }

    @Test
    fun `服务端 wire 上的 driver computer 归一化为 desktop`() {
        // 服务端在 wire 上用 "computer" 表示电脑端 runtime（不是 "desktop"）；
        // 两种写法都必须落到同一个驱动方，否则详情页会把"电脑驱动"显示成"网关驱动"。
        val computer = session(writable = true, driver = SessionSummary.DRIVER_COMPUTER)
        assertTrue("wire 值 computer 必须认成电脑端驱动", computer.isDesktopDriven)
        assertEquals(SessionSummary.DRIVER_DESKTOP, computer.driver)
        assertEquals("电脑驱动", computer.driverLabel)
        assertEquals(
            "wire 值带空白/大写也必须认",
            SessionSummary.DRIVER_DESKTOP,
            session(driver = " COMPUTER ").driver,
        )
    }

    @Test
    fun `writable 为 true 的电脑端会话可续聊且不再标只读`() {
        val computer = session(writable = true, driver = SessionSummary.DRIVER_DESKTOP)
        assertTrue("服务端说可写就必须可写", computer.writable)
        assertEquals("可续聊", computer.accessLabel)
        assertEquals("电脑端正在驱动 · 手机可续聊", computer.liveHint)
        // 来源徽标仍是「电脑」：可续聊不等于变成手机任务
        assertEquals("电脑", computer.sourceLabel)
        assertTrue(computer.isComputerSession)
    }

    @Test
    fun `老网关不下发 writable 时电脑端会话仍是只读`() {
        val missing = session(writable = null)
        assertFalse("缺字段时电脑端会话不能默认可写", missing.writable)
        assertEquals("只读", missing.accessLabel)
        assertEquals("电脑端正在驱动（手机只读）", missing.liveHint)

        val explicitFalse = session(writable = false)
        assertFalse(explicitFalse.writable)
        assertEquals("只读", explicitFalse.accessLabel)
    }

    @Test
    fun `live 不改变可写性——电脑端正在跑时手机仍可续聊`() {
        val running = session(writable = true, live = true)
        assertTrue(running.writable)
        assertEquals("可续聊", running.accessLabel)
        assertEquals("电脑端正在驱动 · 手机可续聊", running.liveHint)
    }

    @Test
    fun `手机任务的既有行为不变`() {
        val phone = session(source = SessionSummary.SOURCE_PHONE)
        assertTrue("手机任务缺 writable 时默认可写", phone.writable)
        // 手机任务从来都可续聊，不需要额外的可写性徽标
        assertNull(phone.accessLabel)
        assertEquals("手机", phone.sourceLabel)
        assertEquals("网关正在运行这一轮", phone.liveHint)

        assertFalse(session(source = SessionSummary.SOURCE_PHONE, writable = false).writable)
    }

    @Test
    fun `列表 JSON 里 writable 为 true 的电脑端会话解析后可续聊`() {
        // 这是本次服务端契约变化在 wire 上的**真实样子**：
        // source=computer + writable=true + writableReason=null + driver="computer"（live 时另有 liveReason）
        val json = """
        {
          "sessions": [
            {
              "id": "session-88e9459c-1111", "title": "远程控制台开发",
              "workspace": "D:\\Workspace\\dsh_android", "cwd": "D:\\Workspace\\dsh_android",
              "createdAt": 1791463029427, "updatedAt": 1791468699595,
              "turns": 2, "steps": 249, "lastTurn": { "state": "ended", "reason": "completed" },
              "live": true, "liveReason": "desktop_running", "origin": "user", "agentPreset": "standard",
              "source": "computer", "writable": true, "writableReason": null, "driver": "computer",
              "bytes": 1598845, "eventCount": 1779, "hasChanges": true, "changeCount": 7
            },
            {
              "id": "sdk-0001", "title": "手机派活", "workspace": "D:\\Workspace\\dsh_android",
              "createdAt": 1791463029427, "updatedAt": 1791468699595, "turns": 1,
              "live": false, "origin": "user", "source": "phone", "steps": 3,
              "writable": true, "writableReason": "runtime_gone", "driver": null
            },
            {
              "id": "session-old-0002", "title": "老网关的电脑端会话",
              "workspace": "D:\\Workspace\\other", "updatedAt": 1791468000000,
              "origin": "user", "source": "computer", "live": false
            },
            {
              "id": "session-sub-0003", "title": "子代理会话",
              "workspace": "D:\\Workspace\\other", "updatedAt": 1791468000100,
              "origin": "subagent", "source": "computer", "live": false,
              "writable": false, "writableReason": "subagent", "driver": "computer"
            }
          ],
          "nextCursor": null
        }
        """.trimIndent()

        val sessions = JsonV2.parseSessions(json)
        assertEquals(4, sessions.size)

        val computer = sessions[0]
        assertEquals(SessionSummary.SOURCE_COMPUTER, computer.source)
        assertTrue(computer.isComputerSession)
        assertTrue("电脑端会话在服务端下发 writable:true 后必须可写", computer.writable)
        assertEquals("可续聊", computer.accessLabel)
        assertTrue("wire 上是 driver=computer，也要认成电脑端驱动", computer.isDesktopDriven)
        assertNull("可写时不该有「不可写原因」", computer.readOnlyHeadline)

        // 手机任务不受影响：driver=null 按 source 推导，writable 仍以服务端为准
        assertTrue(sessions[1].isPhoneTask)
        assertTrue(sessions[1].writable)
        assertNull(sessions[1].accessLabel)
        assertEquals(SessionSummary.DRIVER_GATEWAY, sessions[1].driver)

        // 老网关（不下发 writable / driver）：仍是只读电脑会话，driver 由 source 推导
        assertTrue(sessions[2].isComputerSession)
        assertFalse("老网关电脑端会话必须保持只读", sessions[2].writable)
        assertEquals("只读", sessions[2].accessLabel)
        assertEquals(SessionSummary.DRIVER_DESKTOP, sessions[2].driver)

        // 子代理会话：不单独接管，原因要说得具体（不是笼统一的"不可写"）
        assertFalse(sessions[3].writable)
        assertEquals("子代理会话不单独接管，请在它的上层会话里继续", sessions[3].readOnlyHeadline)
    }

    @Test
    fun `不可写原因按服务端 writableReason 说准而不是笼统只说不可写`() {
        val disabled = session(writable = false, reason = SessionSummary.REASON_DESKTOP_DISABLED)
        assertEquals("电脑端还没把该会话交给网关接管", disabled.readOnlyHeadline)

        val gone = session(
            source = SessionSummary.SOURCE_PHONE,
            writable = false,
            reason = SessionSummary.REASON_RUNTIME_GONE,
        )
        assertEquals("本会话已不可继续（网关重启或被停止过，SDK 无法接管既有会话）", gone.readOnlyHeadline)

        // 可写时没有"原因"可讲（界面据此不显示只读横幅）
        assertNull(session(writable = true, reason = SessionSummary.REASON_DESKTOP_DISABLED).readOnlyHeadline)
        assertNull(session(source = SessionSummary.SOURCE_PHONE, writable = true, reason = "runtime_gone").readOnlyHeadline)

        // 老网关不给原因：按来源兜底，绝不能是空白
        assertFalse(session(writable = false).readOnlyHeadline.isNullOrBlank())
        assertFalse(
            session(source = SessionSummary.SOURCE_PHONE, writable = false).readOnlyHeadline.isNullOrBlank(),
        )
    }

    @Test
    fun `离线缓存往返不丢驱动方与不可写原因`() {
        val original = listOf(
            session(id = "s-computer", writable = true, driver = "computer", live = true),
            session(
                id = "s-disabled",
                writable = false,
                reason = SessionSummary.REASON_DESKTOP_DISABLED,
                driver = "computer",
            ),
            session(id = "s-old-gateway", writable = null, driver = null),
        )

        val restored = JsonV2.sessionsFromJson(JsonV2.sessionsToJson(original))
        assertEquals(3, restored.size)

        // 驱动方必须活着回来：否则断网重连后"电脑端可续聊"的会话会退化成只读镜像
        assertTrue(restored[0].writable)
        assertTrue(restored[0].isDesktopDriven)
        assertEquals("可续聊", restored[0].accessLabel)
        assertFalse("缓存里 live 一律置 false（离线不该看到假的呼吸点）", restored[0].live)

        assertFalse(restored[1].writable)
        assertEquals("电脑端还没把该会话交给网关接管", restored[1].readOnlyHeadline)
        assertTrue(restored[1].isDesktopDriven)

        // 老网关会话：driver 仍未下发，回放后仍按 source 推导且保持只读
        assertFalse(restored[2].writable)
        assertEquals(SessionSummary.DRIVER_DESKTOP, restored[2].driver)
    }
}
