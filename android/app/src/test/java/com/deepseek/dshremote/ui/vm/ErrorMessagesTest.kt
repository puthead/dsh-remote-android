package com.deepseek.dshremote.ui.vm

import com.deepseek.dshremote.data.ApiException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 错误码 → 用户可见文案的映射测试。
 *
 * 这些用例直接对应验收清单里的硬约束：
 * - 429 `busy`（队列满）与"排队中"必须区分，文案为「服务器繁忙，请稍后重试」；
 * - 401 与 403 必须区分处理；
 * - 409 `conflict`、413 `payload_too_large` 必须有可读中文分支，不允许落到"未知错误"兜底。
 */
class ErrorMessagesTest {

    private fun code(code: String, status: Int, message: String = ""): String =
        ApiException(code = code, message = message.ifEmpty { code }, httpStatus = status)
            .friendlyMessage()

    @Test
    fun `401 提示重新配对`() {
        val text = code("unauthorized", 401, "设备令牌无效或已吊销")
        assertTrue(text, text.contains("设备令牌已失效，请重新配对"))
    }

    @Test
    fun `403 与 401 的处理不同`() {
        val text = code("forbidden", 403)
        assertTrue(text, text.contains("forbidden"))
        assertFalse("403 不应该提示令牌失效：$text", text.contains("设备令牌已失效"))
    }

    @Test
    fun `429 busy 使用服务器繁忙文案`() {
        val text = code("busy", 429)
        assertTrue(text, text.contains("服务器繁忙，请稍后重试"))
        // 与"排队中"必须能区分：busy 表示队列已满，任务根本没进队
        assertTrue(text, text.contains("busy"))
    }

    @Test
    fun `429 rate_limited 也走服务器繁忙文案`() {
        val text = code("rate_limited", 429)
        assertTrue(text, text.contains("服务器繁忙，请稍后重试"))
    }

    @Test
    fun `409 conflict 提示任务仍在执行`() {
        val text = code("conflict", 409)
        assertTrue(text, text.contains("conflict"))
        assertTrue(text, text.contains("仍在执行中"))
    }

    @Test
    fun `413 payload_too_large 提示精简内容`() {
        val text = code("payload_too_large", 413)
        assertTrue(text, text.contains("payload_too_large"))
        assertTrue(text, text.contains("过大"))
    }

    @Test
    fun `配对码错误与未开启配对给出不同指引`() {
        val badCode = code("pairing_bad_code", 401, "配对码错误或已过期")
        assertTrue(badCode, badCode.contains("重新生成"))
        val closed = code("pairing_closed", 403, "网关未开启配对")
        assertTrue(closed, closed.contains("pair.ps1"))
    }

    @Test
    fun `bad_request 与 not_found 都有中文分支`() {
        assertTrue(code("bad_request", 400).contains("请求不合法"))
        assertTrue(code("not_found", 404).contains("任务记录可能已被删除"))
    }

    @Test
    fun `未知错误码不落到未知错误兜底`() {
        val text = code("some_future_code", 500, "网关内部异常，请查看日志")
        assertTrue(text, text.contains("网关内部异常"))
        assertFalse(text, text.contains("未知错误"))
    }

    @Test
    fun `网络层异常给出可执行的排查方向`() {
        val timeout = java.net.SocketTimeoutException("timeout").friendlyMessage()
        assertTrue(timeout, timeout.contains("防火墙") || timeout.contains("同一网段"))
        val refused = java.net.ConnectException("Failed to connect to /192.168.1.8:8787").friendlyMessage()
        assertTrue(refused, refused.contains("网关是否已启动"))
    }
}
