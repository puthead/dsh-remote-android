package com.deepseek.dshremote.data.api

import com.deepseek.dshremote.data.ApiException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 审批通道诊断（`state.reason` / `state.hint`）的契约测试。
 *
 * 为什么单开一个文件：`WireApprovalsTest` 管的是"答案长什么样"（编码/校验），
 * 这里管的是"为什么收不到审批"（诊断文案）。两者的失效方式完全不同 ——
 * 前者错了会被网关 400 挡下，后者错了**没有任何报错**，只是用户又看到一片安静，
 * 于是又回来问"为什么手机上没有选项"。所以原因码表要当成一份契约来钉住。
 */
class WireApprovalsReasonTest {

    private fun state(json: String): WireApprovals.BridgeState =
        WireApprovals.parseApprovals("""{"ok":true,"approvals":[],"state":$json}""")!!.state

    // ------------------------------------------------------------ 原因码契约

    @Test
    fun `七个线上原因码逐个认出来`() {
        // 这些字面量必须与 tools/dsh-remote/lib/approvals.mjs 的 APPROVAL_REASONS 完全一致。
        // 网关侧有一条对称的测试（"原因码表与手机端文案是一份契约"）钉住同一组字符串。
        assertEquals(WireApprovals.Reason.NO_CREDENTIALS, WireApprovals.Reason.fromWire("desktop_no_credentials"))
        assertEquals(WireApprovals.Reason.UNAUTHORIZED, WireApprovals.Reason.fromWire("desktop_unauthorized"))
        assertEquals(WireApprovals.Reason.UNREACHABLE, WireApprovals.Reason.fromWire("desktop_unreachable"))
        assertEquals(WireApprovals.Reason.DISABLED, WireApprovals.Reason.fromWire("desktop_disabled"))
        assertEquals(WireApprovals.Reason.DISCONNECTED, WireApprovals.Reason.fromWire("desktop_disconnected"))
        assertEquals(WireApprovals.Reason.NOT_CONNECTED, WireApprovals.Reason.fromWire("not_connected"))
        assertEquals(WireApprovals.Reason.BRIDGE_CRASHED, WireApprovals.Reason.fromWire("bridge_crashed"))
        // 枚举自己的 wire 值也要对：改错一个字母 = 诊断条永远不显示
        assertEquals("desktop_no_credentials", WireApprovals.Reason.NO_CREDENTIALS.wire)
        assertEquals("desktop_disconnected", WireApprovals.Reason.DISCONNECTED.wire)
    }

    @Test
    fun `未知或缺失的原因码退回三态文案_老网关与新网关都不会崩`() {
        // 老网关：根本没有 reason 字段
        assertEquals(WireApprovals.Reason.UNKNOWN, WireApprovals.Reason.fromWire(null))
        // 新网关加了新代码而 App 还没升级：不许猜，退回 UNKNOWN 再走布尔量兜底
        assertEquals(WireApprovals.Reason.UNKNOWN, WireApprovals.Reason.fromWire("desktop_on_fire"))
        assertEquals(WireApprovals.Reason.UNKNOWN, WireApprovals.Reason.fromWire(""))
    }

    @Test
    fun `每种原因都给出不同的中文说明_且不含机器路径`() {
        val described = WireApprovals.Reason.entries
            .filter { it != WireApprovals.Reason.UNKNOWN }
            .map { reason ->
                val note = WireApprovals.BridgeState(reasonCode = reason, available = true, connected = false).note
                // 每条都要说人话：不能是空白，也不能把那串英文码原样丢给用户
                assertTrue("$reason 的说明为空", note.isNotBlank())
                assertFalse("$reason 把原因码直接显示给用户了", note.contains(reason.wire))
                note
            }
        // 七种原因的文案必须互不相同：全都写成"没连上"等于没诊断
        assertEquals(described.size, described.toSet().size)
    }

    // ------------------------------------------------------------ 解析

    @Test
    fun `state 里的 reason 与 hint 都会被解析出来`() {
        val parsed = state(
            """{"available":true,"connected":false,"pending":0,"reconnects":3,
               "reason":"desktop_no_credentials","hint":"电脑端凭据不可用：请先在本机启动 DSH 桌面端"}""",
        )
        assertEquals(WireApprovals.Reason.NO_CREDENTIALS, parsed.reasonCode)
        assertEquals("电脑端凭据不可用：请先在本机启动 DSH 桌面端", parsed.serverHint)
        assertEquals(3, parsed.reconnects)
    }

    @Test
    fun `网关给的下一步优先于本地兜底`() {
        val withHint = state("""{"available":true,"connected":false,"reason":"desktop_unreachable","hint":"去点一下电脑上的 DSH"}""")
        assertEquals("去点一下电脑上的 DSH", withHint.hint)
        // 网关没给 hint（老网关）时用本地兜底，且必须给出一句可操作的话
        val noHint = state("""{"available":true,"connected":false,"reason":"desktop_unreachable"}""")
        assertTrue(noHint.hint.isNotBlank())
        assertTrue(noHint.hint.contains("重启网关") || noHint.hint.contains("电脑端"))
    }

    @Test
    fun `诊断文案里不得出现本机路径或用户名`() {
        // 手机端显示的是从网关 state 来的字符串，一旦回传 C:\Users\<名字>\... 就是泄漏
        val reasons = listOf(
            "desktop_no_credentials", "desktop_unauthorized", "desktop_unreachable",
            "desktop_disabled", "desktop_disconnected", "not_connected", "bridge_crashed",
        )
        for (wire in reasons) {
            val bridge = state("""{"available":true,"connected":false,"reason":"$wire"}""")
            val shown = bridge.note + bridge.hint
            assertFalse(shown, shown.contains("C:\\"))
            assertFalse(shown, shown.contains("Administrator"))
            assertFalse(shown, shown.contains(".credentials.yaml"))
            assertFalse(shown, shown.contains("/Users/"))
        }
    }

    // ------------------------------------------------------------ 显示与否

    @Test
    fun `一切正常时不占位置_出问题才显示诊断条`() {
        // 连上了、也有能力：用户不需要看到"暂无待应答"这行噪声
        assertFalse(WireApprovals.BridgeState(available = true, connected = true).needsAttention)
        // 只是没东西可答也一样不显示
        assertFalse(WireApprovals.BridgeState(available = true, connected = true, pending = 0).needsAttention)
        // 老网关没启用：必须显示
        assertTrue(WireApprovals.BridgeState(available = false).needsAttention)
        // 启用了但没连上：必须显示
        assertTrue(WireApprovals.BridgeState(available = true, connected = false).needsAttention)
        // 网关报了具体原因（哪怕它认为自己 connected）：也要显示
        assertTrue(WireApprovals.BridgeState(available = true, connected = true, reasonCode = WireApprovals.Reason.DISCONNECTED).needsAttention)
    }

    @Test
    fun `老网关三段文案逐字不变_避免回归`() {
        // 这三句是既有测试（WireApprovalsTest / SessionDetailUiStateTest2）与用户已经见过的文案，
        // 一个字都不许动：新原因码只能**另外**加句子，不许借着"优化措辞"改写这三句。
        val off = WireApprovals.BridgeState(available = false).note
        val disc = WireApprovals.BridgeState(available = true, connected = false).note
        val idle = WireApprovals.BridgeState(available = true, connected = true).note
        assertEquals("网关未启用审批通道（旧版本网关）", off)
        assertEquals("网关还没连上电脑端事件流，暂时收不到审批", disc)
        assertEquals("电脑端暂无待应答的审批或提问", idle)
        // 具体原因必须与那三句兜底文案**措辞不同**：否则用户分不清"网关太旧"还是"电脑端没开"。
        // （踩过的坑：把 DISABLED 写成"没有启用审批通道"，与 off 只差一个字，看着像同一件事。）
        val all = listOf(
            "desktop_no_credentials", "desktop_unauthorized", "desktop_unreachable",
            "desktop_disabled", "desktop_disconnected", "bridge_crashed",
        ).map { state("""{"available":false,"connected":false,"reason":"$it"}""").note } +
            listOf(off, disc, idle)
        // 六种具体原因 + 三句兜底 = 九句互不相同（not_connected 复用"没连上"那句，不算新的）
        assertEquals(all.size, all.toSet().size)
        assertEquals(9, all.toSet().size)
        for (specific in all.take(6)) {
            assertTrue("具体原因不能复用兜底文案：$specific", specific !in listOf(off, disc, idle))
        }
    }

    @Test
    fun `reason 缺省时是 UNKNOWN_不会误报具体原因`() {
        assertEquals(WireApprovals.Reason.UNKNOWN, WireApprovals.BridgeState().reasonCode)
        assertEquals(null, WireApprovals.BridgeState().serverHint)
        // 缺 state 块（老网关）也走同一条路
        val noState = WireApprovals.parseApprovals("""{"ok":true,"approvals":[]}""")!!.state
        assertEquals(WireApprovals.Reason.UNKNOWN, noState.reasonCode)
        assertTrue(noState.needsAttention)
    }

    // ------------------------------------------------------------ 点得到、答得上

    @Test
    fun `没有题目的提问不能提交_但清楚说明了原因`() {
        // computer 工具用提问通道问一句纯文本时 questions 会是空的：这时卡上既没有选项
        // 也没有输入框（DetailBits 会补一行说明），提交必须置灰 —— 空提交会被网关判 bad_request
        val entry = WireApprovals.parseEntry(
            JSONObject("""{"eventId":"q1","kind":"question","questions":[]}"""),
        )!!
        val plan = WireApprovals.plan(entry, emptyMap())
        assertFalse(plan.canSubmit)
        assertEquals(0, plan.total)
        // 没有题 ⇒ 也没有"还差几问"可报，按钮文案直接说"提交回答"，靠置灰拦住
        assertTrue(plan.allAnswered)
    }

    @Test
    fun `答过的请求被电脑端先答时_翻译成它已经不在了而不是红错`() {
        // 这一条决定用户看到的是"这条已经没了，刷新一下"还是满屏红字
        assertTrue(WireApprovals.alreadyDecided(ApiException("not_found", "未知接口")))
        assertTrue(WireApprovals.alreadyDecided(ApiException("approval_expired", "已过期")))
        assertFalse(WireApprovals.alreadyDecided(ApiException("bad_request", "形状不对")))
        assertFalse(WireApprovals.alreadyDecided(ApiException("desktop_unreachable", "连不上")))
        assertFalse(WireApprovals.alreadyDecided(RuntimeException("网络断了")))
        val gone = WireApprovals.friendlyApprovalMessage(ApiException("not_found", "这条请求不存在"))
        assertTrue(gone.contains("已经不在了"))
    }
}
