package com.deepseek.dshremote.data

import com.deepseek.dshremote.data.relay.RelayException
import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `刷新失败：电脑离线：中继隧道未连接…`（2026-10-15 用户真机）的回归保护。
 *
 * 两条必须钉死的语义：
 * 1. **只有** `home_offline` 可以等待重试。业务错误（越界、令牌失效、参数错）必须一次就返回，
 *    否则用户为确定性失败白等，真实原因还会被"重试过"掩盖；
 * 2. 等不到隧道就**如实返回原始错误**（不是超时错误、不是空结果），界面才能照旧显示"电脑离线"。
 */
class TunnelRetryTest {

    @Test
    fun `home_offline 两种来源都判为可等待`() {
        assertTrue(
            "本地判据：没有可写句柄（RelayClient.writableHandle）",
            TunnelRetry.isTunnelGap(RelayException("home_offline", "中继隧道未连接，请检查中继地址或等待重连")),
        )
        assertTrue(
            "服务端判据：网关透传 503 home_offline（ApiException）",
            TunnelRetry.isTunnelGap(ApiException("home_offline", "PC 隧道不在线", httpStatus = 503)),
        )
    }

    @Test
    fun `业务错误与网络异常都不等待重试`() {
        val cases: List<Pair<String, Throwable>> = listOf(
            "403 越界" to ApiException("workspace_outside", "路径越界", httpStatus = 403),
            "401 令牌失效" to ApiException("unauthorized", "令牌失效", httpStatus = 401),
            "503 电脑端不可用" to ApiException("desktop_unavailable", "电脑端未接入", httpStatus = 503),
            "404" to ApiException("not_found", "没有这个会话", httpStatus = 404),
            "参数错" to ApiException("bad_request", "host 非法", httpStatus = 400),
            "隧道超时" to RelayException("timeout", "请求超时（60000ms）"),
            "隧道被中止" to RelayException("aborted", "中继终止了本次请求"),
            "隧道凭据失效" to RelayException("unauthorized", "设备令牌无效"),
            "本地 IO" to IOException("Failed to connect to /10.0.2.2:9443"),
            "普通异常" to IllegalStateException("boom"),
        )
        cases.forEach { (why, error) ->
            assertFalse("$why 不该被判成隧道抖动，否则用户白等一次重试", TunnelRetry.isTunnelGap(error))
        }
    }

    @Test
    fun `第一次就成功时不等待、不重试`() = runBlocking {
        var calls = 0
        var waited = false
        val result = TunnelRetry.withRetry(
            block = { calls++; "ok" },
            waitOnline = { waited = true; true },
        )
        assertEquals("ok", result.getOrNull())
        assertEquals(1, calls)
        assertFalse("成功路径不该去等隧道", waited)
    }

    @Test
    fun `重连窗口里的抖动：等一下就重试成功`() = runBlocking {
        var calls = 0
        var waited = false
        val result = TunnelRetry.withRetry(
            block = {
                calls++
                if (calls == 1) throw RelayException("home_offline", "中继隧道未连接，请检查中继地址或等待重连")
                "3 个会话"
            },
            waitOnline = { waited = true; true },
        )
        assertTrue("抖动必须被这次重试吃掉", result.isSuccess)
        assertEquals("3 个会话", result.getOrNull())
        assertEquals("恰好重试一次", 2, calls)
        assertTrue(waited)
    }

    @Test
    fun `等待超时则如实返回原始 home_offline 错误`() = runBlocking {
        val original = RelayException("home_offline", "中继隧道未连接，请检查中继地址或等待重连")
        var calls = 0
        val result = TunnelRetry.withRetry(
            block = { calls++; throw original },
            waitOnline = { false },
        )
        assertEquals("等不到隧道时不能重试第二次（否则是白等）", 1, calls)
        assertTrue(result.isFailure)
        assertTrue(
            "必须把原始异常原样交回，界面才显示得出'电脑离线'",
            result.exceptionOrNull() === original,
        )
    }

    @Test
    fun `业务错误不进入等待分支，也不会被重试掩盖`() = runBlocking {
        val original = ApiException("workspace_outside", "路径越界（不在工作区内）", httpStatus = 403)
        var calls = 0
        var waited = false
        val result = TunnelRetry.withRetry(
            block = { calls++; throw original },
            waitOnline = { waited = true; true },
        )
        assertEquals(1, calls)
        assertFalse("业务错误不该触发等待", waited)
        assertTrue(result.exceptionOrNull() === original)
    }

    @Test
    fun `重试后的结果照原样返回（成功或失败都算一次重试）`() = runBlocking {
        var calls = 0
        val stillOffline = RelayException("home_offline", "隧道写入失败（连接正在关闭）")
        var retried: Result<String>? = null
        val result = TunnelRetry.withRetry(
            block = {
                calls++
                throw if (calls == 1) RelayException("home_offline", "中继隧道未连接") else stillOffline
            },
            waitOnline = { true },
            onResult = { retried = it },
        )
        assertEquals("恰好一次重试，失败就是失败，不再循环", 2, calls)
        assertTrue(retried!!.isFailure)
        assertTrue(result.exceptionOrNull() === stillOffline)
    }

    @Test
    fun `重试成功后回调 onResult，调用方才能立刻清除离线态`() = runBlocking {
        var calls = 0
        var recovered = 0
        val result = TunnelRetry.withRetry(
            block = {
                calls++
                if (calls == 1) throw RelayException("home_offline", "中继隧道未连接")
                "3 个会话"
            },
            waitOnline = { true },
            onResult = { if (it.isSuccess) recovered++ },
        )
        assertTrue(result.isSuccess)
        assertEquals("这一次请求真的打通了隧道，界面不该再挂着'电脑离线'", 1, recovered)
    }

    @Test
    fun `重试仍失败时不给成功回调（不能假装已恢复）`() = runBlocking {
        var calls = 0
        var recovered = 0
        val result = TunnelRetry.withRetry(
            block = { calls++; throw RelayException("home_offline", "中继隧道未连接") },
            waitOnline = { true },
            onResult = { if (it.isSuccess) recovered++ },
        )
        assertTrue(result.isFailure)
        assertEquals(0, recovered)
        assertEquals(2, calls)
    }

    @Test
    fun `第一次就成功不回调 onResult（本来就在线，没有恢复可言）`() = runBlocking {
        var callbacks = 0
        val result = TunnelRetry.withRetry(
            block = { "ok" },
            waitOnline = { true },
            onResult = { callbacks++ },
        )
        assertTrue(result.isSuccess)
        assertEquals("快路径不该触发恢复副作用", 0, callbacks)
    }
}
