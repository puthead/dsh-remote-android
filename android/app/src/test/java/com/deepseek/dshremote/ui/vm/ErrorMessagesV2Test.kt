package com.deepseek.dshremote.ui.vm

import com.deepseek.dshremote.data.ApiException
import com.deepseek.dshremote.data.relay.RelayException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2 错误码与隧道异常的中文文案（契约 §3.3 错误码 + §4.4 错误体）。
 *
 * 硬要求与 v1 一致：每个错误码都要有**可读、可行动**的中文分支，
 * 不允许落到"未知错误"这种无信息量的话术。
 */
class ErrorMessagesV2Test {

    private fun api(code: String, status: Int, message: String = ""): String =
        ApiException(code = code, message = message.ifEmpty { code }, httpStatus = status).friendlyMessage()

    @Test
    fun `session_busy 指向电脑端而不是令牌失效`() {
        val text = api("session_busy", 409, "该会话正由电脑端驱动，请在电脑端继续或在手机端新建会话")
        assertTrue(text, text.contains("该会话正由电脑端驱动"))
        assertFalse("409 不该提示重新配对：$text", text.contains("设备令牌已失效"))
    }

    @Test
    fun `session_taken 与 session_not_found 有独立分支`() {
        assertTrue(api("session_taken", 503).contains("另一个轮次占用"))
        assertTrue(api("session_not_found", 404).contains("下拉刷新"))
    }

    @Test
    fun `home_offline 提示电脑离线且给出排查方向`() {
        val text = api("home_offline", 503, "PC 隧道不在线")
        assertTrue(text, text.contains("电脑离线"))
        assertTrue(text, text.contains("网关"))
    }

    @Test
    fun `workspace_outside 提示越界被拒`() {
        val text = api("workspace_outside", 403, "路径越界")
        assertTrue(text, text.contains("工作区之外"))
    }

    @Test
    fun `home_not_found 与 code_conflict 有可读分支`() {
        assertTrue(api("home_not_found", 404).contains("重新注册隧道"))
        assertTrue(api("code_conflict", 409).contains("配对码冲突"))
    }

    @Test
    fun `desktop_unavailable 指出改走仅在手机上执行`() {
        val text = api(
            "desktop_unavailable",
            503,
            "网关未接入桌面端 DSH runtime，无法在电脑端建会话；请改传 host:\"gateway\"，或先启动电脑端 DSH",
        )
        assertTrue(text, text.contains("无法在电脑端建会话"))
        assertTrue("要告诉用户去哪个界面改：$text", text.contains("仅在手机上执行"))
        assertFalse("这不是配对问题：$text", text.contains("重新配对"))
    }

    @Test
    fun `落电脑端缺 workspace 的 400 不补白名单提示`() {
        val text = api("bad_request", 400, "在电脑端新建任务必须指定 workspace（电脑端是按工作区登记会话的）")
        assertTrue(text, text.contains("必须指定 workspace"))
        assertFalse("网关文案已经可执行，补白名单会把人带偏：$text", text.contains("白名单"))
    }

    @Test
    fun `非法 host 的 400 原样透出`() {
        val text = api("bad_request", 400, "host 只能是 desktop 或 gateway")
        assertTrue(text, text.contains("host 只能是 desktop 或 gateway"))
        assertFalse("这不是工作区/配对问题：$text", text.contains("白名单"))
    }

    @Test
    fun `其它 bad_request 仍补上排查方向`() {
        val text = api("bad_request", 400, "缺少 workspace")
        assertTrue("原有分支不能被新分支吃掉：$text", text.contains("白名单"))
    }

    @Test
    fun `隧道异常翻译成人话`() {
        assertTrue(
            RelayException("home_offline", "中继隧道未连接").friendlyMessage().contains("电脑离线"),
        )
        assertTrue(RelayException("timeout", "请求超时（60000ms）").friendlyMessage().contains("请求超时"))
        assertTrue(RelayException("aborted", "overflow").friendlyMessage().contains("中止"))
        assertTrue(
            RelayException("too_many_streams", "并发过多").friendlyMessage().contains("并发"),
        )
        assertTrue(
            RelayException("unauthorized", "令牌无效").friendlyMessage().contains("重新配对"),
        )
    }

    @Test
    fun `隧道协议错误不会显示成未知错误`() {
        val text = RelayException("bad_request", "隧道帧不是合法 JSON：…").friendlyMessage()
        assertTrue(text, text.contains("协议错误"))
        assertFalse(text, text.contains("未知错误"))
    }
}
