package com.deepseek.dshremote.data.api

import com.deepseek.dshremote.data.ApiException
import com.deepseek.dshremote.data.relay.ChunkFrame
import com.deepseek.dshremote.data.relay.EndFrame
import com.deepseek.dshremote.data.relay.FakeTunnel
import com.deepseek.dshremote.data.relay.HelloFrame
import com.deepseek.dshremote.data.relay.ReadyFrame
import com.deepseek.dshremote.data.relay.RelayClient
import com.deepseek.dshremote.data.relay.ReqFrame
import com.deepseek.dshremote.data.relay.ResFrame
import com.deepseek.dshremote.data.relay.TunnelHttp
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * v2 API 层经隧道的端到端行为（FakeTunnel → RelayClient → TunnelHttp → DshApiV2）。
 *
 * 这一层是"手机不直连 PC"的落点：只要这里全部走通，就证明所有业务请求都是
 * `req`/`res`/`chunk`/`end` 帧，而不是任何形式的直连 HTTP。
 */
class TunnelApiV2Test {

    private class Stack(val tunnel: FakeTunnel, val client: RelayClient, val api: DshApiV2) {
        /** 最近一次请求帧。 */
        val lastReq: ReqFrame? get() = tunnel.lastRequest()
    }

    private fun stack(
        token: String = "dshr_api_token_123456789",
        onRequest: (FakeTunnel, ReqFrame) -> Unit,
    ): Stack {
        val tunnel = FakeTunnel()
        val client = RelayClient(tunnel, CoroutineScope(Dispatchers.Unconfined))
        tunnel.onClientFrame = { frame ->
            when (frame) {
                is HelloFrame -> tunnel.serverSend(ReadyFrame(homeId = "home_test", homeName = "DESKTOP", homeOnline = true))
                is ReqFrame -> onRequest(tunnel, frame)
                else -> Unit
            }
        }
        client.setEndpoint("ws://10.0.2.2:9443", token, "Pixel 8")
        client.connect()
        val tunnelHttp = TunnelHttp(client, tokenProvider = { token })
        return Stack(tunnel, client, DshApiV2(tunnelHttp))
    }

    private fun respondJson(tunnel: FakeTunnel, id: Long, status: Int, body: String) {
        tunnel.serverSend(ResFrame(id, status, mapOf("Content-Type" to "application/json")))
        tunnel.serverSend(ChunkFrame(id, b64(body)))
        tunnel.serverSend(EndFrame(id))
    }

    @Test
    fun `会话列表请求带 v2 头与 Bearer 且解析结果正确`() = runBlocking {
        var captured: ReqFrame? = null
        val stack = stack { tunnel, req ->
            captured = req
            respondJson(
                tunnel,
                req.id,
                200,
                """{ "sessions": [
                     { "id":"s-computer","title":"电脑上的活","workspace":"D:\\W","live":true,"source":"computer","writable":false,"updatedAt":2 },
                     { "id":"s-phone","title":"手机任务","workspace":"D:\\W","live":false,"source":"phone","writable":true,"updatedAt":1 }
                   ] }""",
            )
        }

        val sessions = stack.api.sessions()
        assertEquals(2, sessions.size)
        assertTrue(sessions[0].isComputerSession)
        assertFalse(sessions[0].writable)
        assertTrue(sessions[1].isPhoneTask)
        assertTrue(sessions[1].writable)

        val req = captured!!
        assertEquals("GET", req.method)
        assertTrue(req.path, req.path.startsWith("/api/v2/sessions"))
        assertEquals("Bearer dshr_api_token_123456789", req.headers["Authorization"])
        assertEquals("2", req.headers["X-Api-Version"])
        assertTrue("不应对 GET 带请求体", req.bodyB64 == null)
    }

    @Test
    fun `中文与 emoji 的 transcript 经隧道还原`() = runBlocking {
        val stack = stack { tunnel, req ->
            respondJson(
                tunnel,
                req.id,
                200,
                """{ "sessionId":"s1", "messages": [
                     { "seq":1,"role":"user","at":1,"text":"帮我看构建失败 😅","toolCalls":[],"deliverables":[] },
                     { "seq":2,"role":"assistant","at":2,"text":"定位到 AGP 版本不匹配…",
                       "toolCalls":[{"id":"c1","name":"pwsh","args":{"command":"gradlew test"},"result":"BUILD SUCCESSFUL","isError":false}],
                       "deliverables":[{"path":"a/b.apk","description":"包"}] } ] }""",
            )
        }
        val messages = stack.api.transcript("s1")
        assertEquals("帮我看构建失败 😅", messages[0].text)
        assertEquals("gradlew test", messages[1].toolCalls[0].argsSummary)
        assertEquals("a/b.apk", messages[1].deliverables[0].path)
    }

    @Test
    fun `续聊 POST turns 带 prompt 与 clientTurnId`() = runBlocking {
        var captured: ReqFrame? = null
        val stack = stack { tunnel, req ->
            captured = req
            respondJson(tunnel, req.id, 202, """{"accepted":true,"sessionId":"s1","turnId":"turn_1","fromSeq":10}""")
        }
        val accepted = stack.api.postTurn("s1", "把测试跑一遍", "client-1")
        assertTrue(accepted.accepted)
        assertEquals("turn_1", accepted.turnId)
        assertEquals(10L, accepted.fromSeq)

        val req = captured!!
        assertEquals("POST", req.method)
        assertEquals("/api/v2/sessions/s1/turns", req.path)
        assertEquals("application/json; charset=utf-8", req.headers["Content-Type"])
        val body = String(Base64.getDecoder().decode(req.bodyB64!!), Charsets.UTF_8)
        assertTrue(body, body.contains("把测试跑一遍"))
        assertTrue(body, body.contains("client-1"))
    }

    @Test
    fun `新建手机任务走 POST 点 api 点 v2 点 tasks 并解析 202`() = runBlocking {
        var captured: ReqFrame? = null
        val stack = stack { tunnel, req ->
            captured = req
            respondJson(
                tunnel,
                req.id,
                202,
                """{"sessionId":"session-new","accepted":true,"source":"phone","fromSeq":0}""",
            )
        }
        val outcome = stack.api.createPhoneTask("""{"workspace":"D:\\W","prompt":"跑测试"}""")
        assertEquals("session-new", outcome.sessionId)
        assertTrue(outcome.accepted)
        assertEquals(SessionSummary.SOURCE_PHONE, outcome.source)

        val req = captured!!
        assertEquals("POST", req.method)
        assertEquals("/api/v2/tasks", req.path)
    }

    @Test
    fun `工作区请求的路径参数被 URL 编码`() = runBlocking {
        var captured: ReqFrame? = null
        val stack = stack { tunnel, req ->
            captured = req
            respondJson(tunnel, req.id, 200, """{"workspace":"D:\\W","path":"D:\\W","entries":[],"truncated":false}""")
        }
        stack.api.entries("D:\\Workspace\\dsh_android\\android")
        val path = captured!!.path
        assertTrue(path, path.startsWith("/api/v2/workspaces/files?"))
        assertTrue("Windows 路径必须编码：$path", path.contains("D%3A%5CWorkspace%5Cdsh_android%5Candroid"))
    }

    @Test
    fun `非 2xx 响应映射成带错误码的 ApiException`() = runBlocking {
        val stack = stack { tunnel, req ->
            respondJson(tunnel, req.id, 403, """{"error":{"code":"workspace_outside","message":"路径越界"}}""")
        }
        try {
            stack.api.file("C:\\Windows\\System32\\config\\SAM")
            fail("应抛 ApiException")
        } catch (e: ApiException) {
            assertEquals("workspace_outside", e.code)
            assertEquals(403, e.httpStatus)
            assertEquals("路径越界", e.message)
            assertTrue(e.isForbidden)
        }
    }

    @Test
    fun `会话忙 409 的错误码可被 UI 文案层识别`() = runBlocking {
        val stack = stack { tunnel, req ->
            respondJson(
                tunnel,
                req.id,
                409,
                """{"error":{"code":"session_busy","message":"该会话正由电脑端驱动，请在电脑端继续或在手机端新建会话"}}""",
            )
        }
        try {
            stack.api.postTurn("s-computer", "再改一下", "client-2")
            fail("应抛 ApiException")
        } catch (e: ApiException) {
            assertEquals("session_busy", e.code)
            assertEquals(409, e.httpStatus)
        }
    }

    @Test
    fun `SSE 事件流逐 chunk 增量解析并支持续传参数`() = runBlocking {
        val requests = CopyOnWriteArrayList<ReqFrame>()
        val stack = stack { tunnel, req ->
            requests += req
            tunnel.serverSend(ResFrame(req.id, 200, mapOf("Content-Type" to "text/event-stream")))
            // 故意把一条事件拆成 3 个 chunk，且 chunk 边界落在中文中间
            tunnel.serverSend(ChunkFrame(req.id, b64("event: turn.started\ndata: {\"sessionId\":\"s-pho")))
            tunnel.serverSend(ChunkFrame(req.id, b64("ne\",\"turn\":1,\"fromSeq\":100,\"source\":\"phone\"}\n\nevent: message.delta\ndata: {\"sess")))
            tunnel.serverSend(ChunkFrame(req.id, b64("ionId\":\"s-phone\",\"seq\":101,\"role\":\"assistant\",\"text\":\"好 ✅\"}\n\n")))
            tunnel.serverSend(EndFrame(req.id))
        }

        val events = stack.api.sessionEvents(fromSeq = 100L, lastEventId = "100").toList()
        assertEquals(2, events.size)
        assertTrue(events[0] is ConsoleEvent.TurnStarted)
        assertEquals("phone", (events[0] as ConsoleEvent.TurnStarted).source)
        assertEquals("好 ✅", (events[1] as ConsoleEvent.MessageDelta).text)

        val req = requests.first()
        assertTrue(req.path, req.path.contains("fromSeq=100"))
        assertEquals("100", req.headers["Last-Event-ID"])
    }

    @Test
    fun `网关 health 的 v2 能力只看 supportedApiVersions`() = runBlocking {
        val stack = stack { tunnel, req ->
            respondJson(
                tunnel,
                req.id,
                200,
                """{"ok":true,"apiVersion":1,"supportedApiVersions":[1,2],"serverName":"DESKTOP","gatewayVersion":"2.0.0","dshVersion":"0.9"}""",
            )
        }
        val health = stack.api.gatewayHealth()
        assertEquals("契约 §4.5：apiVersion 恒为 1", 1, health.apiVersion)
        assertTrue(health.supportsV2)
        assertEquals("DESKTOP", health.serverName)

        // 老网关（没有该字段）必须被判成不支持 v2，而不是猜
        val oldStack = stack { tunnel, req ->
            respondJson(tunnel, req.id, 200, """{"ok":true,"apiVersion":1,"serverName":"OLD"}""")
        }
        assertFalse(oldStack.api.gatewayHealth().supportsV2)
    }

    private fun b64(text: String): String =
        Base64.getEncoder().encodeToString(text.toByteArray(Charsets.UTF_8))
}
