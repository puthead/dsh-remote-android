package com.deepseek.dshremote.data.relay

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 隧道帧编解码（契约 §3.1 帧类型总表逐行核对）。
 *
 * 这些用例是三方对协议的"可执行契约"：字段名写错、漏字段、方向搞反都会在这里红。
 */
class FrameCodecTest {

    private fun roundTrip(frame: RelayFrame): RelayFrame = FrameCodec.decode(FrameCodec.encode(frame))

    @Test
    fun `hello 帧带 proto 与 role`() {
        val text = FrameCodec.encode(HelloFrame(role = RelayRole.DEVICE, name = "Xiaomi 14"))
        val obj = org.json.JSONObject(text)
        assertEquals("hello", obj.getString("t"))
        assertEquals(2, obj.getInt("proto"))
        assertEquals("device", obj.getString("role"))
        assertEquals("Xiaomi 14", obj.getString("name"))

        val decoded = roundTrip(HelloFrame(role = RelayRole.DEVICE, name = "Xiaomi 14")) as HelloFrame
        assertEquals(2, decoded.proto)
        assertEquals("device", decoded.role)
        assertEquals("Xiaomi 14", decoded.name)
    }

    @Test
    fun `ready 帧缺 homeOnline 时按在线处理`() {
        val decoded = FrameCodec.decode(
            """{"t":"ready","proto":2,"role":"device","homeId":"home_abcdefghijklmnopqrstuv","homeName":"DESKTOP-X"}""",
        ) as ReadyFrame
        assertEquals("home_abcdefghijklmnopqrstuv", decoded.homeId)
        assertTrue("缺字段不该判成电脑离线", decoded.homeOnline)

        val offline = FrameCodec.decode(
            """{"t":"ready","homeId":"home_x","homeOnline":false}""",
        ) as ReadyFrame
        assertFalse(offline.homeOnline)
    }

    @Test
    fun `req 帧的 headers 与 bodyB64 往返一致`() {
        val body = "帮我看看构建失败的原因".toByteArray(Charsets.UTF_8)
        val original = ReqFrame(
            id = 7,
            method = "POST",
            path = "/api/v2/sessions/abc/turns?x=1",
            headers = mapOf("Authorization" to "Bearer dshr_x", "X-Api-Version" to "2"),
            bodyB64 = FrameCodec.encodeBody(body),
        )
        val decoded = roundTrip(original) as ReqFrame
        assertEquals(7L, decoded.id)
        assertEquals("POST", decoded.method)
        assertEquals("/api/v2/sessions/abc/turns?x=1", decoded.path)
        assertEquals("Bearer dshr_x", decoded.headers["Authorization"])
        assertEquals("2", decoded.headers["X-Api-Version"])
        assertEquals(
            "中文请求体必须原样还原",
            "帮我看看构建失败的原因",
            String(FrameCodec.decodeBody(decoded.bodyB64!!)!!, Charsets.UTF_8),
        )
    }

    @Test
    fun `chunk 帧的大 payload 用 Base64 承载不破坏 JSON`() {
        val payload = ByteArray(300 * 1024) { (it % 251).toByte() }
        val frame = ChunkFrame(id = 3, dataB64 = FrameCodec.encodeBody(payload)!!)
        val decoded = roundTrip(frame) as ChunkFrame
        val restored = FrameCodec.decodeBody(decoded.dataB64)!!
        assertEquals(payload.size, restored.size)
        assertTrue(payload.contentEquals(restored))
    }

    @Test
    fun `非法 Base64 返回 null 而不是抛异常`() {
        assertNull(FrameCodec.decodeBody("!!!not-base64!!!"))
    }

    @Test
    fun `res chunk end abort ping pong cancel notice 逐个往返`() {
        val res = roundTrip(ResFrame(1, 200, mapOf("Content-Type" to "application/json"))) as ResFrame
        assertEquals(200, res.status)
        assertEquals("application/json", res.headers["Content-Type"])

        assertEquals(9L, (roundTrip(EndFrame(9)) as EndFrame).id)
        assertEquals("overflow", (roundTrip(AbortFrame(9, "overflow")) as AbortFrame).reason)
        assertEquals(11L, (roundTrip(PingFrame(11)) as PingFrame).id)
        assertNull((roundTrip(PongFrame(null)) as PongFrame).id)
        assertEquals(12L, (roundTrip(CancelFrame(12)) as CancelFrame).id)

        val notice = roundTrip(NoticeFrame(NoticeKind.HOME_OFFLINE, "home_1")) as NoticeFrame
        assertEquals("home_offline", notice.kind)
        assertEquals("home_1", notice.homeId)
    }

    @Test
    fun `error 帧带 fatal 标记`() {
        val decoded = roundTrip(ErrorFrame("unauthorized", "设备令牌无效或已吊销", fatal = true)) as ErrorFrame
        assertEquals("unauthorized", decoded.code)
        assertEquals("设备令牌无效或已吊销", decoded.message)
        assertTrue(decoded.fatal)
    }

    @Test
    fun `未知帧类型返回 UnknownFrame 而不是抛异常`() {
        val decoded = FrameCodec.decode("""{"t":"future_frame","x":1}""")
        assertTrue(decoded is UnknownFrame)
        assertEquals("future_frame", decoded.type)
    }

    @Test
    fun `非法 JSON 与缺 t 都抛协议错误`() {
        try {
            FrameCodec.decode("not-json")
            fail("应抛 RelayException")
        } catch (e: RelayException) {
            assertEquals("bad_request", e.code)
        }
        try {
            FrameCodec.decode("""{"id":1}""")
            fail("缺 t 应抛 RelayException")
        } catch (e: RelayException) {
            assertEquals("bad_request", e.code)
        }
    }

    @Test
    fun `一次文本帧里多行 NDJSON 会被逐行解析`() {
        val text = FrameCodec.encode(PingFrame(1)) + "\n" + FrameCodec.encode(EndFrame(2)) + "\n"
        val frames = FrameCodec.decodeLines(text)
        assertEquals(2, frames.size)
        assertTrue(frames[0] is PingFrame)
        assertTrue(frames[1] is EndFrame)
    }

    @Test
    fun `空帧返回空列表`() {
        assertTrue(FrameCodec.decodeLines("   ").isEmpty())
    }

    @Test
    fun `id 分配器单调递增且可重置`() {
        val allocator = RelayIdAllocator()
        assertEquals(1L, allocator.next())
        assertEquals(2L, allocator.next())
        assertEquals(3L, allocator.next())
        // 重连后新连接从 1 重新编号（中继视角旧 id 已作废）
        allocator.reset()
        assertEquals(1L, allocator.next())
    }

    @Test
    fun `Base64 编码用标准字符集且可解回原文`() {
        val bytes = "OK ✅ 中文".toByteArray(Charsets.UTF_8)
        val encoded = FrameCodec.encodeBody(bytes)!!
        // 标准 Base64（含 +/），不是 URL-safe：契约没有约定 URL-safe
        assertEquals(encoded, Base64.getEncoder().encodeToString(bytes))
        assertNotNull(FrameCodec.decodeBody(encoded))
    }
}
