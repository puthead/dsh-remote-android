package com.deepseek.dshremote.ui.vm

import com.deepseek.dshremote.data.api.SessionSummary
import com.deepseek.dshremote.data.api.WireApprovals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 详情页的审批接管判据（契约 §7.7）。
 *
 * 与 [SessionDetailUiStateTest] 同一套路：只构造 [SessionDetailViewModel.UiState] 这个嵌套
 * data class，不起 ViewModel、不碰仓库（`ConsoleRepository` 要 Android Context，纯 JVM 起不来）。
 *
 * 这里钉的是"界面凭什么决定显示什么"，也就是三条原型硬约束在状态层的落点：
 * 等待应答的琥珀提示优先级高于"运行中"、提问卡片必须能装下多选与自由文本、
 * 以及**本地校验**——没答完的提问不许提交（`selected:[]` 在协议里合法，
 * 但用户没划过选项就提交，等于替用户做了一个"跳过"的决定）。
 */
class SessionDetailUiStateTest2 {

    private fun approvalEntry(
        eventId: String = "evt-1",
        tool: String? = "Bash",
        expiresAt: Long = 0L,
    ) = WireApprovals.ApprovalEntry(
        eventId = eventId,
        sessionId = "session-1",
        kind = WireApprovals.Kind.APPROVAL,
        toolName = tool,
        callId = "call-1",
        reason = "需要在工作区里跑构建",
        at = 1791463000000L,
        expiresAt = expiresAt,
    )

    private fun questionEntry(vararg questions: WireApprovals.ApprovalQuestion) =
        WireApprovals.ApprovalEntry(
            eventId = "evt-q1",
            sessionId = "session-1",
            kind = WireApprovals.Kind.QUESTION,
            toolName = "ask_user_question",
            callId = "call-2",
            questions = questions.toList(),
            at = 1791463000000L,
            expiresAt = 1791463900000L,
        )

    private fun option(label: String) = WireApprovals.ApprovalOption(label)

    private fun typed(
        entry: WireApprovals.ApprovalEntry? = null,
        drafts: Map<String, WireApprovals.ApprovalDraft> = emptyMap(),
        submitting: Boolean = false,
        bridge: WireApprovals.BridgeState = WireApprovals.BridgeState(),
        input: String = "",
        sending: Boolean = false,
        resumable: Boolean = true,
        live: Boolean = false,
    ) = SessionDetailViewModel.UiState(
        session = SessionSummary(
            id = "session-1",
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
            lastTurnState = "running",
            lastTurnReason = null,
            source = SessionSummary.SOURCE_COMPUTER,
            writableFlag = true,
            driverFlag = SessionSummary.DRIVER_COMPUTER,
        ),
        input = input,
        sending = sending,
        resumable = resumable,
        live = live,
        pendingApproval = entry,
        approvalDrafts = drafts,
        approvalSubmitting = submitting,
        approvalBridge = bridge,
    )

    // ------------------------------------------------------------ 没有请求时

    @Test
    fun `没有待应答请求时输入区照常可用`() {
        val ui = typed(input = "继续")
        assertNull(ui.pendingApproval)
        assertTrue("没有审批时不能拦住用户打字", ui.inputEnabled)
        assertTrue(ui.canSend)
        assertFalse("没有请求就不可提交", ui.approvalPlan.canSubmit)
        assertEquals(0, ui.approvalPlan.total)
        assertTrue("「全部答完」在没题时也不该说缺题", ui.approvalPlan.allAnswered)
    }

    @Test
    fun `空列表时按桥的诊断说清是没有还是没连上`() {
        assertTrue(
            typed(bridge = WireApprovals.BridgeState(available = true, connected = true)).approvalNote
                .contains("暂无"),
        )
        assertTrue(
            typed(bridge = WireApprovals.BridgeState(available = true, connected = false)).approvalNote
                .contains("没连上"),
        )
        assertTrue(
            typed(bridge = WireApprovals.BridgeState(available = false)).approvalNote
                .contains("未启用"),
        )
    }

    // ------------------------------------------------------------ 接管输入区

    @Test
    fun `等在电脑端的请求会把输入区换成应答卡`() {
        // 原型硬约束③：审批/提问等待时**接管**输入区，而不是混在消息流里。
        // 界面判据就是这个非空字段——它同时负责收起输入框与发送键。
        val ui = typed(entry = approvalEntry())
        assertNotNull(ui.pendingApproval)
        assertEquals("请求使用工具 Bash", ui.pendingApproval!!.headline)
        assertTrue(ui.pendingApproval!!.warning.contains("审批"))
    }

    @Test
    fun `接管输入区不影响已经在输入框里的草稿`() {
        // 接管只是把输入区换成卡片：用户打了一半的字必须还在，答完审批就能接着发
        val ui = typed(entry = approvalEntry(), input = "答完这条我接着说")
        assertEquals("答完这条我接着说", ui.input)
        assertTrue("可写且可继续时会话仍然能发", ui.canSend)
    }

    @Test
    fun `运行中的会话等待应答时两个状态并存`() {
        // 琥珀（等待你响应）优先级高于运行中绿：界面先渲染应答卡，运行条退到消息流里。
        // 状态层要保证两者不是互斥字段——否则"跑着跑着被问到"会丢掉其中一个状态。
        val ui = typed(entry = approvalEntry(), live = true)
        assertTrue("会话仍在运行（live）", ui.live)
        assertNotNull("同时有未决请求", ui.pendingApproval)
    }

    // ------------------------------------------------------------ 审批卡

    @Test
    fun `提出审批的会话即使不可写也能看到并提交`() {
        // 审批是"电脑端挂住了等你答"，与手机能不能发消息无关：
        // 拿 inputEnabled 当卡片可见性判据，会让只读会话的审批永远消失。
        val ui = typed(entry = approvalEntry(), resumable = false)
        assertFalse("不可继续时输入框灰掉", ui.inputEnabled)
        assertNotNull("但审批卡仍然要在", ui.pendingApproval)
    }

    @Test
    fun `没有任何题目时审批卡不可提交`() {
        val ui = typed(entry = approvalEntry())
        assertEquals(0, ui.approvalPlan.total)
        assertFalse(ui.approvalPlan.canSubmit)
        assertTrue(ui.approvalPlan.allAnswered)
    }

    // ------------------------------------------------------------ 提问卡

    @Test
    fun `多选题两问只答一问时提交键不可用`() {
        val entry = questionEntry(
            WireApprovals.ApprovalQuestion(id = "q1", question = "发到哪个环境？", options = listOf(option("staging"))),
            WireApprovals.ApprovalQuestion(id = "q2", question = "通知谁？", options = listOf(option("我"))),
        )
        val ui = typed(
            entry = entry,
            drafts = mapOf("q1" to WireApprovals.ApprovalDraft(selected = setOf("staging"))),
        )
        assertFalse("少答一问不许提交", ui.approvalPlan.canSubmit)
        assertEquals(listOf("q2"), ui.approvalPlan.unanswered)
        assertEquals(2, ui.approvalPlan.total)
        assertFalse(ui.approvalPlan.allAnswered)
    }

    @Test
    fun `自由文本填了字就算答过这一问`() {
        val entry = questionEntry(
            WireApprovals.ApprovalQuestion(id = "q1", question = "叫什么名字？", options = emptyList()),
        )
        val empty = typed(entry = entry)
        assertTrue("自由文本问题没有选项可选", empty.approvalPlan.canSubmit.not())
        assertEquals(listOf("q1"), empty.approvalPlan.unanswered)

        val filled = typed(
            entry = entry,
            drafts = mapOf("q1" to WireApprovals.ApprovalDraft(custom = "dsh-remote")),
        )
        assertTrue(filled.approvalPlan.canSubmit)
    }

    @Test
    fun `全部答完才允许提交`() {
        val entry = questionEntry(
            WireApprovals.ApprovalQuestion(id = "q1", question = "一", options = listOf(option("a"))),
            WireApprovals.ApprovalQuestion(id = "q2", question = "二", multiSelect = true, options = listOf(option("b"), option("c"))),
        )
        val ui = typed(
            entry = entry,
            drafts = mapOf(
                "q1" to WireApprovals.ApprovalDraft(selected = setOf("a")),
                "q2" to WireApprovals.ApprovalDraft(selected = setOf("b", "c")),
            ),
        )
        assertTrue(ui.approvalPlan.canSubmit)
        assertTrue(ui.approvalPlan.allAnswered)
    }

    @Test
    fun `选项描述为空时不算答过`() {
        // 划过一个标签才算答过；只把 description 读出来不算
        val entry = questionEntry(
            WireApprovals.ApprovalQuestion(id = "q1", question = "选", options = emptyList()),
        )
        val blank = typed(entry = entry, drafts = mapOf("q1" to WireApprovals.ApprovalDraft(custom = "   ")))
        assertFalse("只有空白不算答过", blank.approvalPlan.canSubmit)
    }

    // ------------------------------------------------------------ 提交中

    @Test
    fun `提交中时审批卡不会被当成已答`() {
        // 提交中只影响按钮可用性，不得让卡片消失：请求还没回，界面不能先假装答完了
        val ui = typed(entry = approvalEntry(), submitting = true)
        assertTrue(ui.approvalSubmitting)
        assertNotNull(ui.pendingApproval)
    }
}
