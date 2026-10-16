package com.deepseek.dshremote.data.relay

import java.io.IOException
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.cancelAndJoin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 隧道客户端行为（契约 §3）：握手、多路复用、chunk 重组、心跳、退避、控制面通知。
 *
 * 用 [FakeTunnel] 驱动同一份 [RelayClient] 代码，因此这些用例能跑在纯 JVM 上，
 * 不需要模拟器也不需要真实中继。
 */
class RelayClientTest {

    private fun scope() = CoroutineScope(Dispatchers.Unconfined)

    private fun connectedClient(
        tunnel: FakeTunnel,
        client: RelayClient,
        homeOnline: Boolean = true,
    ): RelayClient {
        tunnel.onClientFrame = { frame ->
            if (frame is HelloFrame) {
                tunnel.serverSend(
                    ReadyFrame(homeId = "home_9f2c0000000000000000ab", homeName = "DESKTOP-DEV", homeOnline = homeOnline),
                )
            }
        }
        client.setEndpoint("ws://10.0.2.2:9443", "dshr_token_value_1234567890", "Pixel 8")
        client.connect()
        return client
    }

    @Test
    fun `hello 首帧带协议版本与设备名，ready 后进入已连接`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()))

        assertEquals("ws://10.0.2.2:9443/api/v2/tunnel/device", tunnel.lastUrl)
        assertEquals("Bearer dshr_token_value_1234567890", tunnel.lastHeaders["Authorization"])
        assertEquals("2", tunnel.lastHeaders["X-Api-Version"])

        val hello = tunnel.frames().first()
        assertTrue("首帧必须是 hello（契约 §3.1）", hello is HelloFrame)
        assertEquals(RelayRole.DEVICE, (hello as HelloFrame).role)
        assertEquals("Pixel 8", hello.name)

        val state = client.state.value
        assertTrue("应进入 Connected：$state", state is RelayState.Connected)
        assertEquals("DESKTOP-DEV", (state as RelayState.Connected).homeName)
        assertFalse(state.isComputerOffline)
        assertTrue(client.isConnected)
    }

    @Test
    fun `请求响应用同一个 id 往返，响应体完整`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()))
        tunnel.onClientFrame = { frame ->
            if (frame is ReqFrame) {
                tunnel.serverSend(ResFrame(frame.id, 200, mapOf("Content-Type" to "application/json")))
                tunnel.serverSend(ChunkFrame(frame.id, b64("{\"sessions\":")))
                tunnel.serverSend(ChunkFrame(frame.id, b64("[]}")))
                tunnel.serverSend(EndFrame(frame.id))
            }
        }

        val response = client.request("GET", "/api/v2/sessions?limit=50")
        assertEquals(200, response.status)
        assertEquals("{\"sessions\":[]}", response.bodyText())
        assertEquals("application/json", response.headers["Content-Type"])

        val req = tunnel.lastRequest()!!
        assertEquals("GET", req.method)
        assertEquals("/api/v2/sessions?limit=50", req.path)
        assertEquals("响应结束后不应留下悬挂的流", 0, client.pendingStreams)
    }

    @Test
    fun `多路复用：并发两个请求交错回包也不串线`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()))
        val requests = CopyOnWriteArrayList<Long>()
        tunnel.onClientFrame = { frame -> if (frame is ReqFrame) requests += frame.id }

        val first = async(Dispatchers.Default) { client.request("GET", "/first") }
        val second = async(Dispatchers.Default) { client.request("GET", "/second") }
        withTimeout(5_000) { while (requests.size < 2) delay(5) }

        val (idA, idB) = requests[0] to requests[1]
        assertTrue("id 必须单调且互不相同", idA != idB)

        tunnel.serverSend(ResFrame(idA, 200))
        tunnel.serverSend(ResFrame(idB, 200))
        tunnel.serverSend(ChunkFrame(idB, b64("BBBB")))
        tunnel.serverSend(ChunkFrame(idA, b64("AAAA")))
        tunnel.serverSend(ChunkFrame(idB, b64("-2")))
        tunnel.serverSend(ChunkFrame(idA, b64("-2")))
        tunnel.serverSend(EndFrame(idB))
        tunnel.serverSend(EndFrame(idA))

        assertEquals("AAAA-2", first.await().bodyText())
        assertEquals("BBBB-2", second.await().bodyText())
    }

    @Test
    fun `大响应跨多个 chunk 逐段重组（300KiB）`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()))
        val payload = ByteArray(300 * 1024) { (it % 199).toByte() }
        tunnel.onClientFrame = { frame ->
            if (frame is ReqFrame) {
                tunnel.serverSend(ResFrame(frame.id, 200))
                var offset = 0
                val piece = 64 * 1024
                while (offset < payload.size) {
                    val end = minOf(offset + piece, payload.size)
                    tunnel.serverSend(
                        ChunkFrame(frame.id, Base64.getEncoder().encodeToString(payload.copyOfRange(offset, end))),
                    )
                    offset = end
                }
                tunnel.serverSend(EndFrame(frame.id))
            }
        }

        val response = client.request("GET", "/api/v2/sessions/x/transcript")
        assertEquals(payload.size, response.body.size)
        assertTrue(payload.contentEquals(response.body))
        assertEquals(0, client.pendingStreams)
    }

    @Test
    fun `隧道未连接时请求立刻失败为 home_offline`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = RelayClient(tunnel, scope())
        try {
            client.request("GET", "/api/v2/sessions")
            fail("未连接时应抛异常")
        } catch (e: RelayException) {
            assertEquals("home_offline", e.code)
        }
    }

    @Test
    fun `断线后按 1s 到 30s 指数退避重连`() = runBlocking {
        val tunnel = FakeTunnel().apply { failOnConnect = IOException("connection refused") }
        // 必须用 rendezvous：无限容量会让重连循环不挂起地自旋，测不出真实节奏
        val delays = Channel<Long>()
        val client = RelayClient(tunnel, scope(), sleeper = { delays.send(it) })
        client.setEndpoint("ws://10.0.2.2:9443", "dshr_token_value_1234567890", "Pixel 8")
        client.connect()

        val recorded = withTimeout(5_000) { List(6) { delays.receive() } }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L), recorded)
        assertTrue("每次退避后都应真的重连", tunnel.connections >= 6)
        assertTrue(client.state.value is RelayState.Retrying)
        client.disconnect()
        assertEquals(RelayState.Idle, client.state.value)
    }

    @Test
    fun `心跳 30s 无 pong 判死链并重建隧道`() = runBlocking {
        val tunnel = FakeTunnel()
        // 只回 ready，故意不回 pong
        tunnel.onClientFrame = { frame ->
            if (frame is HelloFrame) tunnel.serverSend(ReadyFrame(homeId = "home_1", homeName = "PC", homeOnline = true))
        }
        val client = RelayClient(
            tunnel,
            scope(),
            heartbeatIntervalMs = 40,
            heartbeatTimeoutMs = 40,
        )
        client.setEndpoint("ws://10.0.2.2:9443", "dshr_token_value_1234567890", "Pixel 8")
        client.connect()
        assertEquals(1, tunnel.connections)

        withTimeout(5_000) { while (tunnel.connections < 2) delay(10) }
        assertTrue("判死后必须重新建连", tunnel.connections >= 2)
        assertTrue("ping 必须真的发出去", tunnel.frames().any { it is PingFrame })
        client.disconnect()
    }

    @Test
    fun `收到 pong 后不判死链`() = runBlocking {
        val tunnel = FakeTunnel()
        tunnel.onClientFrame = { frame ->
            if (frame is HelloFrame) tunnel.serverSend(ReadyFrame(homeId = "home_1", homeName = "PC", homeOnline = true))
            if (frame is PingFrame) tunnel.serverSend(PongFrame(frame.id))
        }
        val client = RelayClient(tunnel, scope(), heartbeatIntervalMs = 30, heartbeatTimeoutMs = 60)
        client.setEndpoint("ws://10.0.2.2:9443", "dshr_token_value_1234567890", "Pixel 8")
        client.connect()
        delay(200)
        assertEquals("有 pong 就不该重连", 1, tunnel.connections)
        client.disconnect()
    }

    @Test
    fun `notice home_offline 让状态变成电脑离线`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()))
        assertFalse((client.state.value as RelayState.Connected).isComputerOffline)

        tunnel.serverSend(NoticeFrame(NoticeKind.HOME_OFFLINE, "home_1"))
        assertTrue((client.state.value as RelayState.Connected).isComputerOffline)

        tunnel.serverSend(NoticeFrame(NoticeKind.HOME_ONLINE, "home_1"))
        assertFalse((client.state.value as RelayState.Connected).isComputerOffline)
        client.disconnect()
    }

    @Test
    fun `notice revoked 进入凭据失效且不再重连`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()))
        val connectionsBefore = tunnel.connections

        tunnel.serverSend(NoticeFrame(NoticeKind.REVOKED, "home_1"))
        assertTrue(client.state.value is RelayState.Unauthorized)
        delay(50)
        assertEquals("被吊销后不该再重连", connectionsBefore, tunnel.connections)
    }

    @Test
    fun `握手被拒 unauthorized 时停止重连并给出可行动状态`() = runBlocking {
        val tunnel = FakeTunnel()
        val delays = Channel<Long>(Channel.UNLIMITED)
        val client = RelayClient(tunnel, scope(), sleeper = { delays.send(it) })
        tunnel.onClientFrame = { frame ->
            if (frame is HelloFrame) tunnel.rejectWith("unauthorized", "设备令牌无效或已吊销")
        }
        client.setEndpoint("ws://10.0.2.2:9443", "dshr_bad_token_1234567890", "Pixel 8")
        client.connect()

        val state = client.state.value
        assertTrue("应进入 Unauthorized：$state", state is RelayState.Unauthorized)
        delay(50)
        assertEquals("凭据错了不该反复重连", 1, tunnel.connections)
    }

    @Test
    fun `SSE 长流逐 chunk 吐出，取消时发送 cancel 帧`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()))
        val received = CopyOnWriteArrayList<TunnelEvent>()

        val job = launch(Dispatchers.Default) {
            client.openStream("GET", "/api/v2/sessions/stream?fromSeq=10").collect { received += it }
        }
        withTimeout(5_000) { while (tunnel.frames().none { it is ReqFrame }) delay(5) }
        val req = tunnel.lastRequest()!!
        assertEquals("/api/v2/sessions/stream?fromSeq=10", req.path)

        tunnel.serverSend(ResFrame(req.id, 200, mapOf("Content-Type" to "text/event-stream")))
        tunnel.serverSend(ChunkFrame(req.id, b64("event: heartbeat\ndata: {\"at\":1}\n\n")))
        tunnel.serverSend(ChunkFrame(req.id, b64("event: message.delta\ndata: {\"sessionId\":\"s1\",\"text\":\"你\"}\n\n")))
        withTimeout(5_000) { while (received.size < 3) delay(5) }

        assertTrue(received.first() is TunnelEvent.Head)
        assertEquals(2, received.filterIsInstance<TunnelEvent.Body>().size)

        job.cancelAndJoin()
        // 契约 §3.1：SSE 客户端离开必须发 cancel，否则中继/网关会留着这条流
        withTimeout(5_000) { while (tunnel.frames().none { it is CancelFrame }) delay(5) }
        assertTrue(tunnel.frames().any { it is CancelFrame && it.id == req.id })
    }

    @Test
    fun `请求超时会取消流、抛 timeout 并发出 cancel`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()))
        tunnel.onClientFrame = { } // 收到 req 也不回

        try {
            client.request("GET", "/hang", timeoutMs = 200)
            fail("应超时失败")
        } catch (e: RelayException) {
            assertEquals("timeout", e.code)
        }
        assertEquals("超时后必须清掉流，否则流表会泄漏", 0, client.pendingStreams)
        assertTrue("超时后要发 cancel 帧", tunnel.frames().any { it is CancelFrame })
        client.disconnect()
    }

    private fun b64(text: String): String =
        Base64.getEncoder().encodeToString(text.toByteArray(Charsets.UTF_8))

    // ---------- waitOnline：主动刷新撞上重连窗口时的等待（2026-10-15 用户真机"刷新失败：电脑离线"） ----------

    @Test
    fun `waitOnline 已在线时立刻返回 true`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()))

        val started = System.currentTimeMillis()
        assertTrue("已在线不该白等", client.waitOnline(timeoutMs = 5_000))
        assertTrue("必须是立刻返回：${System.currentTimeMillis() - started}ms", System.currentTimeMillis() - started < 1_000)
        client.disconnect()
    }

    @Test
    fun `waitOnline 隧道未连接时超时返回 false 而不是抛异常`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = RelayClient(tunnel, scope())
        client.setEndpoint("ws://10.0.2.2:9443", "dshr_token_value_1234567890", "Pixel 8")
        // 故意不 connect：端点配了但隧道一直没建起来（等价于 PC 网关关机）
        assertFalse("等待超时必须返回 false，让调用方如实报错", client.waitOnline(timeoutMs = 150))
    }

    @Test
    fun `waitOnline 未配置端点时立刻返回 false`() = runBlocking {
        val client = RelayClient(FakeTunnel(), scope())
        assertFalse("没配对就不该等", client.waitOnline(timeoutMs = 5_000))
    }

    @Test
    fun `waitOnline 在等待期间等到 home_online 就返回 true`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()), homeOnline = false)
        assertTrue("ready 已说自己离线", client.state.value.let { it is RelayState.Connected && it.isComputerOffline })

        // 中继在 PC 重新注册后推 home_online（契约 §3.2 的控制面通知）
        val flip = launch(Dispatchers.Default) {
            delay(120)
            tunnel.serverSend(NoticeFrame(NoticeKind.HOME_ONLINE, "home_1"))
        }
        assertTrue("等到了 home_online 就该放行请求", client.waitOnline(timeoutMs = 5_000))
        flip.join()
        assertFalse((client.state.value as RelayState.Connected).isComputerOffline)
        client.disconnect()
    }

    @Test
    fun `waitOnline 遇到凭据失效立刻返回 false，不等满超时`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()), homeOnline = false)

        val started = System.currentTimeMillis()
        val flip = launch(Dispatchers.Default) {
            delay(100)
            tunnel.serverSend(NoticeFrame(NoticeKind.REVOKED, "home_1"))
        }
        assertFalse("令牌被吊销时重试没有意义", client.waitOnline(timeoutMs = 10_000))
        val waited = System.currentTimeMillis() - started
        assertTrue("必须提前返回而不是等满 10s：${waited}ms", waited < 5_000)
        flip.join()
    }

    @Test
    fun `waitOnline 遇到已死的句柄会主动踢掉并重连，而不是干等`() = runBlocking {
        val tunnel = FakeTunnel()
        val client = connectedClient(tunnel, RelayClient(tunnel, scope()))

        // 半开连接：socket 已经死了、句柄标记为 closed，但 runLoop 还挂在 closed.await() 上，
        // 状态流仍然是 Connected（要等心跳丢 pong 才察觉，最多 30s）。
        tunnel.serverClose(1006, "socket error")

        val started = System.currentTimeMillis()
        assertTrue("踢掉死句柄后应能等到重连成功", client.waitOnline(timeoutMs = 5_000))
        val waited = System.currentTimeMillis() - started
        // 不踢的话状态流一直停在 Connected，这里会瞬间"通过"——但那是假的：
        // 请求会打在死句柄上照样失败。所以必须真的重连过（connections 增加）。
        assertTrue("必须真的重连（现有 ${tunnel.connections} 次连接）", tunnel.connections >= 2)
        assertTrue("重连不能靠等到超时：${waited}ms", waited < 5_000)
        assertTrue(client.isConnected)
        client.disconnect()
    }

    @Test
    fun `waitOnline 不会拿已经死掉的句柄冒充可用`() = runBlocking {
        val tunnel = FakeTunnel()
        // 重连退避设为 0：这条用例测的是"判定"，不是退避时长
        val client = connectedClient(tunnel, RelayClient(tunnel, scope(), sleeper = {}))
        assertTrue(client.state.value is RelayState.Connected && client.isConnected)

        // 半开连接：socket 已死、状态流还停在 Connected。
        // 只看状态值会**瞬间**返回 true，调用方拿这个句柄去重试就会再吃一次 home_offline。
        tunnel.serverClose(1006, "socket error")

        val started = System.currentTimeMillis()
        assertTrue("踢掉死句柄后必须能等到真正重连成功", client.waitOnline(timeoutMs = 5_000))
        val waited = System.currentTimeMillis() - started
        assertTrue("必须真的重连过（现有 ${tunnel.connections} 次连接）", tunnel.connections >= 2)
        assertTrue("重连不能靠等到超时：${waited}ms", waited < 5_000)
        assertTrue("返回 true 时句柄必须真的是活的", client.isConnected)
        client.disconnect()
    }
}
