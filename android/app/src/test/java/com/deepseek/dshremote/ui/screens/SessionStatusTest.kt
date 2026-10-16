package com.deepseek.dshremote.ui.screens

import com.deepseek.dshremote.data.api.SessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 会话行状态语言的单元测试（纯 JVM：`SessionStatus.kt` 不引用任何 Android / Compose 类型）。
 *
 * 这组测试守的是**一条产品规则**，不是一个函数：
 * 「默认状态不表达，值得说的状态才出现」——所以最重要的断言是
 * [普通可写会话什么状态都不显示]：它一旦回归，42 行的列表又会变回一片复读的胶囊。
 *
 * 另一半守的是"优先级不许含糊"：`live`、`writable`、`isPhoneTask` 三个布尔有 8 种组合，
 * 两两同时成立时显示哪个必须写死（见 SessionStatus.kt 的真值表），不能靠 `when` 的书写顺序碰运气。
 */
class SessionStatusTest {

    private fun session(
        id: String = "session-1",
        live: Boolean = false,
        source: String = SessionSummary.SOURCE_COMPUTER,
        writable: Boolean? = true,
        reason: String? = null,
        createdBy: String? = null,
        turns: Int = 3,
        hasChanges: Boolean = false,
        changeCount: Int = 0,
        lastTurnState: String? = null,
        lastTurnReason: String? = null,
        origin: String? = null,
        parentSession: String? = null,
        delegationDepth: Int = 0,
        parentTitle: String? = null,
    ) = SessionSummary(
        id = id,
        title = "会话 $id",
        workspace = "D:\\Workspace\\dsh_android",
        cwd = "D:\\Workspace\\dsh_android",
        createdAt = 0L,
        updatedAt = 0L,
        turns = turns,
        steps = 0,
        live = live,
        origin = origin,
        parentSession = parentSession,
        delegationDepth = delegationDepth,
        parentTitle = parentTitle,
        agentPreset = "standard",
        bytes = 0L,
        eventCount = 0,
        hasChanges = hasChanges,
        changeCount = changeCount,
        lastTurnState = lastTurnState,
        lastTurnReason = lastTurnReason,
        source = source,
        writableFlag = writable,
        writableReasonFlag = reason,
        createdByFlag = createdBy,
    )

    // ---- 运行中：唯一的动态状态，唯一常显 ----

    @Test
    fun `运行中的会话显示运行中并带呼吸点`() {
        val status = SessionStatus.resolve(session(live = true))
        assertEquals(SessionStatus.SessionStatusKind.Live, status.kind)
        assertEquals("运行中", status.label)
        assertTrue("运行中要有圆点（且是呼吸点，界面按 showsDot 决定）", status.showsDot)
        assertTrue(status.visible)
        assertEquals("电脑端正在运行这一轮", status.hint)
    }

    @Test
    fun `运行中的手机会话不谎报电脑端在驱动`() {
        val status = SessionStatus.resolve(
            session(live = true, source = SessionSummary.SOURCE_PHONE, createdBy = SessionSummary.CREATED_BY_PHONE),
        )
        assertEquals("网关正在运行这一轮", status.hint)
    }

    @Test
    fun `离线快照里的 live 不算运行中`() {
        // 断线那一刻的 live 是残留值：继续画呼吸点会让人以为电脑端还在跑一个早已停下的任务
        val status = SessionStatus.resolve(session(live = true, writable = false), stale = true)
        assertFalse("快照里不显示运行中", status.kind == SessionStatus.SessionStatusKind.Live)
        assertEquals(SessionStatus.SessionStatusKind.ReadOnly, status.kind)
        assertTrue(status.hint.contains("离线快照"))
    }

    @Test
    fun `离线快照里可写的会话也不显示运行中（宁可不说，不可说错）`() {
        val status = SessionStatus.resolve(session(live = true, writable = true), stale = true)
        assertEquals(SessionStatus.SessionStatusKind.Idle, status.kind)
        assertFalse(status.visible)
    }

    // ---- 只读：中性灰 + 必有原因（不静默） ----

    @Test
    fun `只读会话显示只读且给出原因`() {
        val status = SessionStatus.resolve(
            session(writable = false, reason = SessionSummary.REASON_DESKTOP_DISABLED),
        )
        assertEquals(SessionStatus.SessionStatusKind.ReadOnly, status.kind)
        assertEquals("只读", status.label)
        assertFalse("只读不带点：配文字，不靠颜色区分", status.showsDot)
        assertEquals("只读：电脑端还没把该会话交给网关接管", status.hint)
    }

    @Test
    fun `只读的手机端会话原因指向运行时已消失`() {
        val status = SessionStatus.resolve(
            session(
                writable = false,
                source = SessionSummary.SOURCE_PHONE,
                reason = SessionSummary.REASON_RUNTIME_GONE,
                createdBy = SessionSummary.CREATED_BY_PHONE,
            ),
        )
        assertEquals(SessionStatus.SessionStatusKind.ReadOnly, status.kind)
        assertEquals(
            "只读：本会话已不可继续（网关重启或被停止过，SDK 无法接管既有会话）",
            status.hint,
        )
    }

    @Test
    fun `缺 writable 的老网关电脑端会话不说成被停止过`() {
        // readOnlyHeadline 的兜底对电脑端镜像是假话（老网关只是没下发 writable），
        // 这里必须退到与来源相符的说法，否则用户会去电脑端找一个不存在的重启记录
        val status = SessionStatus.resolve(session(writable = null, source = SessionSummary.SOURCE_COMPUTER))
        assertEquals(SessionStatus.SessionStatusKind.ReadOnly, status.kind)
        assertTrue(
            "兜底原因不能声称网关重启过，实际：${status.hint}",
            !status.hint.contains("重启") && status.hint.contains("交给网关"),
        )
    }

    @Test
    fun `老网关没下发 writable 时手机端会话按可写处理`() {
        // ModelsV2 的兜底是 `writableFlag ?: (source == SOURCE_PHONE)`：手机端会话本来就可续，
        // 老网关不下发这个字段不该把用户自己的任务变成只读
        val status = SessionStatus.resolve(
            session(writable = null, source = SessionSummary.SOURCE_PHONE, createdBy = SessionSummary.CREATED_BY_PHONE),
        )
        assertEquals(SessionStatus.SessionStatusKind.Phone, status.kind)
        assertFalse(status.hint.contains("重启"))
    }

    @Test
    fun `手机端会话被显式判只读时才指向运行时消失`() {
        val status = SessionStatus.resolve(
            session(
                writable = false,
                source = SessionSummary.SOURCE_PHONE,
                reason = SessionSummary.REASON_RUNTIME_GONE,
                createdBy = SessionSummary.CREATED_BY_PHONE,
            ),
        )
        assertEquals(SessionStatus.SessionStatusKind.ReadOnly, status.kind)
        assertTrue(status.hint.contains("网关重启"))
    }

    @Test
    fun `只读的后续动作按来源分流`() {
        assertEquals(
            "在它的上层会话里继续。",
            SessionStatus.readOnlyAction(session(writable = false, reason = SessionSummary.REASON_SUBAGENT)),
        )
        assertTrue(
            SessionStatus.readOnlyAction(session(writable = false, source = SessionSummary.SOURCE_PHONE))
                .contains("新建"),
        )
        assertTrue(SessionStatus.readOnlyAction(session(writable = false)).contains("电脑端"))
    }

    // ---- 手机发起：极轻的出处标记 ----

    @Test
    fun `手机发起的可写会话只给一个手机标记`() {
        val status = SessionStatus.resolve(
            session(
                source = SessionSummary.SOURCE_PHONE,
                writable = true,
                createdBy = SessionSummary.CREATED_BY_PHONE,
            ),
        )
        assertEquals(SessionStatus.SessionStatusKind.Phone, status.kind)
        assertEquals("手机", status.label)
        assertFalse("出处不是动态状态，不带点", status.showsDot)
        assertTrue(status.visible)
    }

    @Test
    fun `手机发起但落在电脑端的会话同样是手机标记`() {
        // 契约 §4.2 的三个字段各说各的事：谁发起(phone) / 数据在哪(computer) / 谁驱动(desktop)
        val status = SessionStatus.resolve(
            session(
                source = SessionSummary.SOURCE_COMPUTER,
                writable = true,
                createdBy = SessionSummary.CREATED_BY_PHONE,
            ),
        )
        assertEquals(SessionStatus.SessionStatusKind.Phone, status.kind)
    }

    // ---- 普通可写会话：这才是重点，什么都不显示 ----

    @Test
    fun `普通可写会话什么状态都不显示`() {
        val status = SessionStatus.resolve(session())
        assertEquals(SessionStatus.SessionStatusKind.Idle, status.kind)
        assertFalse("默认态不许出现胶囊——42 行都挂同一个标记等于没有信息", status.visible)
        assertEquals("", status.label)
        assertEquals("", status.hint)
    }

    @Test
    fun `电脑发起的可写会话也不显示（可写不是新闻）`() {
        val status = SessionStatus.resolve(
            session(source = SessionSummary.SOURCE_COMPUTER, createdBy = SessionSummary.CREATED_BY_DESKTOP, writable = true),
        )
        assertFalse(status.visible)
    }

    // ---- 组合优先级 ----

    @Test
    fun `运行中压过只读——此刻想知道的是它在跑`() {
        val status = SessionStatus.resolve(session(live = true, writable = false))
        assertEquals(SessionStatus.SessionStatusKind.Live, status.kind)
        assertEquals("运行中", status.label)
    }

    @Test
    fun `只读压过手机发起——发不出去比谁发起的更重要`() {
        val status = SessionStatus.resolve(
            session(
                writable = false,
                createdBy = SessionSummary.CREATED_BY_PHONE,
                source = SessionSummary.SOURCE_COMPUTER,
            ),
        )
        assertEquals(SessionStatus.SessionStatusKind.ReadOnly, status.kind)
    }

    @Test
    fun `运行中压过手机发起`() {
        val status = SessionStatus.resolve(
            session(
                live = true,
                source = SessionSummary.SOURCE_PHONE,
                writable = true,
                createdBy = SessionSummary.CREATED_BY_PHONE,
            ),
        )
        assertEquals(SessionStatus.SessionStatusKind.Live, status.kind)
    }

    @Test
    fun `同一行最多只有一个状态胶囊`() {
        // 八种布尔组合全跑一遍：可见时标签必须非空，不可见时标签必须为空
        for (live in listOf(false, true)) {
            for (writable in listOf(false, true)) {
                for (phone in listOf(false, true)) {
                    val status = SessionStatus.resolve(
                        session(
                            live = live,
                            writable = writable,
                            createdBy = if (phone) SessionSummary.CREATED_BY_PHONE else SessionSummary.CREATED_BY_DESKTOP,
                            source = if (phone) SessionSummary.SOURCE_PHONE else SessionSummary.SOURCE_COMPUTER,
                        ),
                    )
                    if (status.visible) {
                        assertTrue("live=$live writable=$writable phone=$phone 可见却没标签", status.label.isNotEmpty())
                        assertTrue("live=$live writable=$writable phone=$phone 可见却没说明", status.hint.isNotEmpty())
                    } else {
                        assertEquals("", status.label)
                    }
                }
            }
        }
    }

    // ---- 元信息 / 预览行 ----

    @Test
    fun `元信息行只放计数不放状态词`() {
        val line = sessionMetaLine(session(turns = 12, hasChanges = true, changeCount = 3))
        assertEquals("12 轮 · 3 个文件", line)
        assertFalse("状态词只能出现在状态胶囊里", line.contains("运行中") || line.contains("只读"))
    }

    @Test
    fun `零轮零改动的会话元信息行整段省略`() {
        assertEquals("", sessionMetaLine(session(turns = 0, hasChanges = false)))
        assertEquals("", sessionMetaLine(session(turns = 0, hasChanges = true, changeCount = 0)))
    }

    @Test
    fun `线上的英文枚举转成中文再显示`() {
        assertEquals("最后：已完成", sessionPreviewText(session(lastTurnReason = "completed")))
        assertEquals("最后：已停止", sessionPreviewText(session(lastTurnReason = "aborted")))
        assertEquals("最后：上一轮 已结束", sessionPreviewText(session(lastTurnState = "ended")))
        assertEquals("最后：正在执行…", sessionPreviewText(session(live = true)))
        assertEquals("最后：暂无摘要", sessionPreviewText(session()))
        // 认不出来的取值原样透出：编一个中文词比显示原始值更危险
        assertEquals("最后：weird_state", sessionPreviewText(session(lastTurnReason = "weird_state")))
    }
}
