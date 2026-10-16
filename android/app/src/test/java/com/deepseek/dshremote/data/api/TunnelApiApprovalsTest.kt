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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 审批 / 提问两个端点**经隧道的 HTTP 连线**（契约 §7.7）。
 *
 * 为什么单独一个文件：`WireApprovalsTest` 只证明"JSON 与请求体的形状对"，
 * 证明不了"手机真的按 `/api/v2/approvals` 去发、路径参数真的被编码、事件 id 真的进了 URL"。
 * 这两件事出错时的症状一样（点提交没反应 / 404），必须分开钉住。
 *
 * 与既有 `TunnelApiV2Test` 用同一条栈（FakeTunnel → RelayClient → TunnelHttp → DshApiV2），
 * 但刻意**另开一个类**：验收夹具类的增删不该牵动既有文件的 diff。
 */
class TunnelApiApprovalsTest {

    private class Stack(val tunnel: FakeTunnel, val client: RelayClient, val api: DshApiV2) {
        val lastReq: ReqFrame? get() = tunnel.lastRequest()
    }

    private fun stack(onRequest: (FakeTunnel, ReqFrame) -> Unit): Stack {
        val token = "dshr_api_token_123456789"
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
        return Stack(tunnel, client, DshApiV2(TunnelHttp(client, tokenProvider = { token })))
    }

    private fun respondJson(tunnel: FakeTunnel, id: Long, status: Int, body: String) {
        tunnel.serverSend(ResFrame(id, status, mapOf("Content-Type" to "application/json")))
        tunnel.serverSend(ChunkFrame(id, b64(body)))
        tunnel.serverSend(EndFrame(id))
    }

    private fun b64(text: String): String = Base64.getEncoder().encodeToString(text.toByteArray(Charsets.UTF_8))

    /** 解码**真正上线的**请求体：断言帧里的字节，而不是断言 API 的返回值。 */
    private fun bodyOf(req: ReqFrame?): String =
        String(Base64.getDecoder().decode(req!!.bodyB64!!), Charsets.UTF_8)

    /** 网关 `publicEntry` 的真实形状（kind=question 带 questions，kind=approval 时 questions 为 null）。 */
    private val approvalsBody = """
        {
          "ok": true,
          "approvals": [
            {
              "eventId": "evt-1",
              "sessionId": "s-computer",
              "kind": "question",
              "toolName": "ask_user_question",
              "callId": "call_1",
              "reason": "需要你选一个环境",
              "at": 1791988706509,
              "expiresAt": 1791989606509,
              "questions": [
                {
                  "id": "q1",
                  "header": "发布环境",
                  "question": "这次发到哪个环境？",
                  "detail": null,
                  "options": [ { "label": "预发", "description": null }, { "label": "生产", "description": null } ],
                  "multiSelect": false
                }
              ]
            }
          ],
          "state": { "available": true, "connected": true, "pending": 1, "startedAt": 1, "reconnects": 0, "lastError": null }
        }
    """.trimIndent()

    @Test
    fun `未决列表默认请求不带 sessionId 且解析出条目与桥状态`() = runBlocking {
        var captured: ReqFrame? = null
        val stack = stack { tunnel, req ->
            captured = req
            respondJson(tunnel, req.id, 200, approvalsBody)
        }

        val response = stack.api.approvals()

        assertEquals("GET", captured!!.method)
        assertEquals("/api/v2/approvals", captured!!.path)
        assertNotNull(response)
        assertEquals(1, response!!.approvals.size)
        assertEquals("evt-1", response.approvals[0].eventId)
        assertEquals(WireApprovals.Kind.QUESTION, response.approvals[0].kind)
        assertEquals("预发", response.approvals[0].questions!![0].options[0].label)
        assertTrue(response.state.available)
        assertEquals(1, response.state.pending)
    }

    @Test
    fun `带 sessionId 时作为查询参数而不是路径`() = runBlocking {
        var captured: ReqFrame? = null
        val stack = stack { tunnel, req ->
            captured = req
            respondJson(tunnel, req.id, 200, """{"ok":true,"approvals":[],"state":{"available":true,"connected":true,"pending":0}}""")
        }

        val response = stack.api.approvals("s-computer")

        assertEquals("/api/v2/approvals?sessionId=s-computer", captured!!.path)
        assertEquals(0, response!!.approvals.size)
    }

    @Test
    fun `审批结论 POST 到 approvals 加 eventId 且请求体就是 WireApprovals 编出来的那串`() = runBlocking {
        var captured: ReqFrame? = null
        val stack = stack { tunnel, req ->
            captured = req
            respondJson(tunnel, req.id, 200, """{"ok":true,"event":{"eventId":"evt-1"},"outcome":{"kind":"result","value":"allowed-once"}}""")
        }

        val body = WireApprovals.encodeApproval(WireApprovals.Outcome.ALLOWED_ONCE)
        stack.api.submitApproval("evt-1", body)

        assertEquals("POST", captured!!.method)
        assertEquals("/api/v2/approvals/evt-1", captured!!.path)
        // 线上字节必须与网关 APPROVAL_OUTCOMES 的字面量一致，且只有 outcome 一个键
        assertEquals("""{"outcome":"allowed-once"}""", bodyOf(captured))
    }

    @Test
    fun `提问回答的请求体里 selected 是数组且自由文本用 custom 键`() = runBlocking {
        var captured: ReqFrame? = null
        val stack = stack { tunnel, req ->
            captured = req
            respondJson(tunnel, req.id, 200, """{"ok":true,"event":{"eventId":"evt-2"},"outcome":{"kind":"result"}}""")
        }
        val questions = WireApprovals.parseQuestions(
            org.json.JSONArray(
                """[
                     {"id":"q1","question":"环境？","options":[{"label":"预发"},{"label":"生产"}],"multiSelect":false},
                     {"id":"q2","question":"备注？","options":[]}
                   ]""",
            ),
        )
        val drafts = mapOf(
            "q1" to WireApprovals.ApprovalDraft(selected = setOf("生产")),
            "q2" to WireApprovals.ApprovalDraft(custom = "周五发"),
        )

        val body = WireApprovals.encodeAnswers(questions, drafts)!!
        stack.api.submitApproval("evt-2", body)
        val sent = bodyOf(captured)

        // 桌面端会对 selected 做 [...answer.selected]：裸字符串会被静默拆成单字符，必须是数组
        assertTrue("实际请求体=$sent", sent.contains(""""selected":["生产"]"""))
        assertTrue("实际请求体=$sent", sent.contains(""""selected":[]"""))
        assertTrue("实际请求体=$sent", sent.contains(""""custom":"周五发""""))
        assertTrue("自由文本字段名只能是 custom，不能是 text：$sent", !sent.contains("\"text\""))
        // id 必须在（网关会拒掉空 id 的答案项）
        assertTrue("实际请求体=$sent", sent.contains(""""id":"q1""""))
    }

    @Test
    fun `弃权请求体是单个 abstain 真值`() = runBlocking {
        var captured: ReqFrame? = null
        val stack = stack { tunnel, req ->
            captured = req
            respondJson(tunnel, req.id, 200, """{"ok":true,"event":{},"outcome":{"kind":"next"}}""")
        }

        stack.api.submitApproval("evt-3", WireApprovals.encodeAbstain())

        assertEquals("/api/v2/approvals/evt-3", captured!!.path)
        // 弃权不是拒绝：网关读到 abstain 才会把机会交给下一个应答者
        assertEquals("""{"abstain":true}""", bodyOf(captured))
    }

    @Test
    fun `eventId 里的特殊字符必须被编码否则路径会被劈开`() = runBlocking {
        var captured: ReqFrame? = null
        val stack = stack { tunnel, req ->
            captured = req
            respondJson(tunnel, req.id, 200, """{"ok":true,"event":{},"outcome":{"kind":"next"}}""")
        }

        stack.api.submitApproval("evt/with space", """{"abstain":true}""")

        val path = captured!!.path
        assertEquals("/api/v2/approvals/evt%2Fwith%20space", path)
        assertEquals("""{"abstain":true}""", bodyOf(captured))
    }

    @Test
    fun `过期 409 的错误码按响应体而不是 HTTP 状态推断`() = runBlocking {
        val stack = stack { tunnel, req ->
            // 网关的 approvalErrorCode 把内部的 expired 映射成 approval_expired + 409，
            // 而 defaultCode(409) 会给出 conflict —— 必须信响应体里的 code
            respondJson(tunnel, req.id, 409, """{"ok":false,"error":{"code":"approval_expired","message":"这条请求已经过期"}}""")
        }

        try {
            stack.api.submitApproval("evt-4", """{"outcome":"rejected"}""")
            fail("应抛 ApiException")
        } catch (e: ApiException) {
            assertEquals("approval_expired", e.code)
            assertEquals(409, e.httpStatus)
            assertTrue("过期要能被翻译成'它已经不在了'", WireApprovals.alreadyDecided(e))
        }
    }

    @Test
    fun `电脑端不可达 503 的错误码与文案`() = runBlocking {
        val stack = stack { tunnel, req ->
            respondJson(tunnel, req.id, 503, """{"ok":false,"error":{"code":"desktop_unavailable","message":"电脑端不在线"}}""")
        }

        try {
            stack.api.submitApproval("evt-5", """{"outcome":"allowed-once"}""")
            fail("应抛 ApiException")
        } catch (e: ApiException) {
            assertEquals("desktop_unavailable", e.code)
            assertEquals(503, e.httpStatus)
            // 同一条 503 在别的端点是 home_offline，这里必须按审批的语义解释
            val text = WireApprovals.friendlyApprovalMessage(e)
            assertTrue(text, text.contains("电脑端"))
        }
    }

    @Test
    fun `响应不是 JSON 时列表返回 null 而不抛异常`() = runBlocking {
        val stack = stack { tunnel, req ->
            respondJson(tunnel, req.id, 200, "<html>502 Bad Gateway</html>")
        }

        assertNull(stack.api.approvals("s-1"))
    }
}
