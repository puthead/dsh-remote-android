package com.deepseek.dshremote.data.relay

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 建连失败不允许把进程带崩。
 *
 * 现场：用户在设置里填了畸形中继地址（例如端口写成 `70000`），
 * `OkHttpWsTransport.connect` 在建 `Request` 阶段就抛 `IllegalArgumentException("unexpected url")`；
 * 而 `transport.connect(...)` 原先落在 `runLoop` 的 try 之外，异常顺着 `Graph.appScope`
 * （只有 `SupervisorJob`，没有 `CoroutineExceptionHandler`）直达线程默认 handler →
 * **进程崩溃**，而且重连循环一起死掉、再也起不来。
 *
 * 修复后它必须走"和握手失败同一条"退避重连路径。
 */
class RelayConnectResilienceTest {

    /** 一个只在 connect 阶段炸掉的传输：模拟 OkHttp 对畸形 URL 的行为。 */
    private class ThrowingTransport(private val error: Throwable) : WsTransport {
        override fun connect(url: String, headers: Map<String, String>, listener: WsListener): WsHandle =
            throw error
    }

    @Test
    fun `建连抛异常时进入退避重试而不是崩溃`() = runBlocking {
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val slept = mutableListOf<Long>()
        // sleeper 只记录一次就挂起：默认的 delay 会让用例真的等，不注入就没法断言序列
        val gate = Channel<Long>()
        val client = RelayClient(
            transport = ThrowingTransport(
                IllegalArgumentException("unexpected url: ws://relay.example.com:70000/api/v2/tunnel/device"),
            ),
            scope = scope,
            sleeper = { delayMs ->
                slept += delayMs
                gate.receive()
            },
        )

        try {
            client.setEndpoint("ws://relay.example.com:70000", "dshr_token_value_1234567890", "Pixel 8")
            client.connect()

            // Unconfined：connect() 返回时循环已经跑到 sleeper 挂起处
            val state = client.state.value
            assertTrue("应进入 Retrying 而不是把异常抛出去：$state", state is RelayState.Retrying)
            assertEquals(
                "unexpected url: ws://relay.example.com:70000/api/v2/tunnel/device",
                (state as RelayState.Retrying).reason,
            )
            assertEquals("重试前必须先退避一次", 1, slept.size)
        } finally {
            gate.close()
            scope.cancel()
        }
    }

    @Test
    fun `反复建连失败不会累积成崩溃或空转`() = runBlocking {
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val attempts = mutableListOf<String>()
        val gate = Channel<Unit>()
        var calls = 0
        val client = RelayClient(
            transport = object : WsTransport {
                override fun connect(
                    url: String,
                    headers: Map<String, String>,
                    listener: WsListener,
                ): WsHandle {
                    calls += 1
                    attempts += url
                    throw IllegalStateException("第 $calls 次建连失败")
                }
            },
            scope = scope,
            sleeper = { gate.receive() },
        )

        try {
            client.setEndpoint("ws://10.0.2.2:9443", "dshr_token_value_1234567890", "Pixel 8")
            client.connect()

            assertTrue(client.state.value is RelayState.Retrying)
            assertEquals(1, calls)
            // 放行第一次退避，让它再试一轮
            gate.trySend(Unit)
            withTimeout(2_000L) { while (calls < 2) yield() }
            assertEquals("重连循环必须还活着，而不是随异常一起死掉", 2, calls)
            assertTrue(client.state.value is RelayState.Retrying)
        } finally {
            gate.close()
            scope.cancel()
        }
    }
}
