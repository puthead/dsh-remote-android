package com.deepseek.dshremote.ui.vm

import com.deepseek.dshremote.data.api.SessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 详情页输入框的开关判据（本次改造的核心：电脑端会话从"只读镜像"变成"可实时续聊"）。
 *
 * 只构造 [SessionDetailViewModel.UiState]（嵌套 data class，纯 JVM），不起 ViewModel、
 * 不碰仓库：`ConsoleRepository` 需要 Android Context，纯 JVM 单测起不来。
 */
class SessionDetailUiStateTest {

    private fun session(
        source: String = SessionSummary.SOURCE_COMPUTER,
        writable: Boolean? = null,
        reason: String? = null,
        driver: String? = null,
        live: Boolean = false,
    ) = SessionSummary(
        id = "session-1",
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

    private fun state(
        session: SessionSummary?,
        input: String = "继续把剩下的测试补完",
        sending: Boolean = false,
        resumable: Boolean = true,
    ) = SessionDetailViewModel.UiState(
        session = session,
        input = input,
        sending = sending,
        resumable = resumable,
    )

    @Test
    fun `服务端下发 writable true 的电脑端会话输入框可用`() {
        val ui = state(session(writable = true, driver = "computer"))
        assertTrue("服务端说可写，输入框就必须可用", ui.writable)
        assertTrue(ui.inputEnabled)
        assertTrue("填了内容就能发", ui.canSend)
        // 可写时不该再出现只读横幅
        assertEquals("", ui.readOnlyReason)
        // 但要明确告诉用户消息落到电脑端那段会话里
        assertEquals("电脑端会话：消息交给电脑端 runtime 执行，电脑端的输出会实时同步到这里", ui.livePeerNote)
    }

    @Test
    fun `电脑端会话正在跑时手机仍能续聊`() {
        val ui = state(session(writable = true, driver = "computer", live = true))
        assertTrue("电脑端在跑不等于手机不能发", ui.inputEnabled)
        assertTrue(ui.canSend)
    }

    @Test
    fun `老网关不下发 writable 的电脑端会话输入框不可用`() {
        val ui = state(session(writable = null))
        assertFalse(ui.writable)
        assertFalse("不可写时输入框必须灰掉", ui.inputEnabled)
        assertFalse(ui.canSend)
        assertNull("不可写时不该出现「消息实时同步」的说明", ui.livePeerNote)
        assertTrue(ui.readOnlyReason.contains("电脑端还没把该会话交给网关接管"))
        assertTrue("要给出路：手机端新建任务或回电脑端", ui.readOnlyReason.contains("手机任务"))
    }

    @Test
    fun `网关没接入电脑端时按 writableReason 说清原因`() {
        val ui = state(session(writable = false, reason = SessionSummary.REASON_DESKTOP_DISABLED, driver = "computer"))
        assertFalse(ui.inputEnabled)
        assertTrue(ui.readOnlyReason.startsWith("电脑端还没把该会话交给网关接管；"))
        assertTrue(ui.readOnlyReason.endsWith("请在电脑端继续，或在「手机任务」新建任务"))
        assertNull(ui.livePeerNote)
    }

    @Test
    fun `手机会话不可写时的原因仍指向手机任务`() {
        val ui = state(
            session(
                source = SessionSummary.SOURCE_PHONE,
                writable = false,
                reason = SessionSummary.REASON_RUNTIME_GONE,
                driver = null,
            ),
        )
        assertFalse(ui.inputEnabled)
        assertTrue(ui.readOnlyReason.startsWith("本会话已不可继续"))
        assertTrue(ui.readOnlyReason.endsWith("请到「手机任务」新建任务"))
        assertNull("手机会话不需要「电脑端实时同步」的说明", ui.livePeerNote)
    }

    @Test
    fun `手机会话可写时的既有行为不变`() {
        val ui = state(session(source = SessionSummary.SOURCE_PHONE, writable = true))
        assertTrue(ui.inputEnabled)
        assertTrue(ui.canSend)
        assertEquals("", ui.readOnlyReason)
        // 手机会话本来就是网关驱动，不需要那句"电脑端 runtime"说明
        assertNull(ui.livePeerNote)
    }

    @Test
    fun `输入为空或正在发送时不能重复发送`() {
        val blank = state(session(writable = true), input = "   ")
        assertTrue("输入框仍可用（可以开始打字）", blank.inputEnabled)
        assertFalse("空输入不能发", blank.canSend)

        val sending = state(session(writable = true), sending = true)
        assertFalse("上一轮还在跑时不能重入", sending.canSend)
    }

    @Test
    fun `会话被中止（不可继续）时可写也不能发送`() {
        // 手机会话的中止 = 杀进程，会话作废；这里是 SDK 那套语义
        val ui = state(session(source = SessionSummary.SOURCE_PHONE, writable = true), resumable = false)
        assertTrue("可写性不受中止影响", ui.writable)
        assertFalse("不可继续时不能发", ui.canSend)
        assertFalse(ui.inputEnabled)
        assertTrue("手机会话：说清是停止杀进程造成的", ui.nonResumableReason.contains("SDK 进程"))
    }

    @Test
    fun `电脑端会话不可继续时不说成停止杀进程`() {
        val ui = state(session(writable = true, driver = "computer"), resumable = false)
        assertFalse(ui.inputEnabled)
        assertFalse(ui.nonResumableReason.contains("SDK 进程"))
        assertTrue("要说清是网关重启/没接入", ui.nonResumableReason.contains("网关重启"))
    }

    @Test
    fun `会话还没加载出来时不显示不可写提示`() {
        val ui = state(session = null)
        assertFalse(ui.writable)
        assertFalse(ui.canSend)
        assertEquals("正在加载会话信息…", ui.readOnlyReason)
    }
}
