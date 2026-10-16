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
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 会话事件流（SSE）在隧道上的三个真实缺陷回归（FakeTunnel → RelayClient → TunnelHttp → DshApiV2）：
 *
 * 1. 流式请求没带 `Accept: text/event-stream`，中继把它当非流式请求装上 60s 空闲超时；
 * 2. 逐 chunk `String(bytes, UTF_8)` 在切片边界劈开多字节字符，产生静默乱码；
 * 3. 非 2xx 的错误体没有上限，一直累积到单流 32 MiB 上限。
 *
 * 这些都是"不报错的错"，只能靠把 chunk 切在字节中间来钉住。
 */
class SseStreamFramingTest {

    private class Stack(val api: DshApiV2)

    private fun stack(onRequest: (FakeTunnel, ReqFrame) -> Unit): Stack {
        val token = "dshr_api_token_123456789"
        val tunnel = FakeTunnel()
        val client = RelayClient(tunnel, CoroutineScope(Dispatchers.Unconfined))
        tunnel.onClientFrame = { frame ->
            when (frame) {
                is HelloFrame -> tunnel.serverSend(
                    ReadyFrame(homeId = "home_test", homeName = "DESKTOP", homeOnline = true),
                )

                is ReqFrame -> onRequest(tunnel, frame)
                else -> Unit
            }
        }
        client.setEndpoint("ws://10.0.2.2:9443", token, "Pixel 8")
        client.connect()
        return Stack(DshApiV2(TunnelHttp(client, tokenProvider = { token })))
    }

    private fun b64b(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    private val deltaPrefix = """event: message.delta
data: {"sessionId":"s-1","seq":7,"role":"assistant","text":""""

    @Test
    fun `事件流请求自带 Accept text-event-stream 且不影响续传头`() = runBlocking {
        val requests = CopyOnWriteArrayList<ReqFrame>()
        val stack = stack { tunnel, req ->
            requests += req
            tunnel.serverSend(ResFrame(req.id, 200, mapOf("Content-Type" to "text/event-stream")))
            tunnel.serverSend(EndFrame(req.id))
        }

        stack.api.sessionEvents(fromSeq = 100L, lastEventId = "100").toList()

        val req = requests.first()
        // 中继用正则 /text\/event-stream/i 判定 isStream，判错就装上 60s 空闲超时
        assertEquals("text/event-stream", req.headers["Accept"])
        assertEquals("100", req.headers["Last-Event-ID"])
        assertTrue(req.path, req.path.contains("fromSeq=100"))
    }

    @Test
    fun `没有续传游标时 Accept 仍然要带`() = runBlocking {
        val requests = CopyOnWriteArrayList<ReqFrame>()
        val stack = stack { tunnel, req ->
            requests += req
            tunnel.serverSend(ResFrame(req.id, 200, mapOf("Content-Type" to "text/event-stream")))
            tunnel.serverSend(EndFrame(req.id))
        }

        stack.api.sessionEvents(fromSeq = null, lastEventId = null).toList()

        // ConsoleStreams.headers() 在 lastEventId 为空时返回 emptyMap()，
        // 所以 Accept 必须由调用方补上，否则这个分支一定漏
        assertEquals("text/event-stream", requests.first().headers["Accept"])
    }

    @Test
    fun `中文字符被 chunk 边界劈开时事件文本仍然完整`() = runBlocking {
        val payload = (deltaPrefix + "中文✅\"}\n\n").toByteArray(Charsets.UTF_8)
        // 切在"中"的第三个字节之前：修复前两个 chunk 各解出一个 U+FFFD，JSON 照样能解析
        val cut = deltaPrefix.toByteArray(Charsets.UTF_8).size + 2
        val stack = stack { tunnel, req ->
            tunnel.serverSend(ResFrame(req.id, 200, mapOf("Content-Type" to "text/event-stream")))
            tunnel.serverSend(ChunkFrame(req.id, b64b(payload.copyOfRange(0, cut))))
            tunnel.serverSend(ChunkFrame(req.id, b64b(payload.copyOfRange(cut, payload.size))))
            tunnel.serverSend(EndFrame(req.id))
        }

        val events = stack.api.sessionEvents(fromSeq = null, lastEventId = null).toList()

        assertEquals(1, events.size)
        assertTrue("应解析出 message.delta：$events", events[0] is ConsoleEvent.MessageDelta)
        val text = (events[0] as ConsoleEvent.MessageDelta).text
        assertEquals("中文✅", text)
        assertTrue("不允许出现替换字符：$text", !text.contains('\uFFFD'))
    }

    @Test
    fun `逐字节下发的多字节字符也能拼回`() = runBlocking {
        val payload = (deltaPrefix + "好\"}\n\n").toByteArray(Charsets.UTF_8)
        val stack = stack { tunnel, req ->
            tunnel.serverSend(ResFrame(req.id, 200, mapOf("Content-Type" to "text/event-stream")))
            payload.forEach { tunnel.serverSend(ChunkFrame(req.id, b64b(byteArrayOf(it)))) }
            tunnel.serverSend(EndFrame(req.id))
        }

        val events = stack.api.sessionEvents(fromSeq = null, lastEventId = null).toList()
        assertEquals("好", (events[0] as ConsoleEvent.MessageDelta).text)
    }

    @Test
    fun `非 2xx 的超大流式错误体不会改变错误语义`() = runBlocking {
        val stack = stack { tunnel, req ->
            tunnel.serverSend(ResFrame(req.id, 500, mapOf("Content-Type" to "text/plain")))
            // 40 × 8 KiB = 320 KiB 垃圾 body：修复前会一路 append 到 32 MiB 的单流上限
            repeat(40) {
                tunnel.serverSend(ChunkFrame(req.id, b64b(ByteArray(8 * 1024) { 'x'.code.toByte() })))
            }
            tunnel.serverSend(EndFrame(req.id))
        }

        try {
            stack.api.sessionEvents(fromSeq = null, lastEventId = null).toList()
            fail("非 2xx 必须抛出 ApiException")
        } catch (e: ApiException) {
            assertEquals("internal", e.code)
            assertEquals(500, e.httpStatus)
            assertEquals("会话事件流失败 HTTP 500", e.message)
        }
    }

    @Test
    fun `非 2xx 的 JSON 错误体仍然按网关给的 code 解析`() = runBlocking {
        val stack = stack { tunnel, req ->
            tunnel.serverSend(ResFrame(req.id, 503, mapOf("Content-Type" to "application/json")))
            tunnel.serverSend(
                ChunkFrame(req.id, b64b("""{"error":{"code":"home_offline","message":"PC 不在线"}}""".toByteArray())),
            )
            tunnel.serverSend(EndFrame(req.id))
        }

        try {
            stack.api.sessionEvents(fromSeq = null, lastEventId = null).toList()
            fail("非 2xx 必须抛出 ApiException")
        } catch (e: ApiException) {
            // 截断逻辑只在超过 64 KiB 时生效，正常大小的错误体必须原样解析
            assertEquals("home_offline", e.code)
            assertEquals("PC 不在线", e.message)
        }
    }
}
