package com.deepseek.dshremote.data.api

import com.deepseek.dshremote.data.ApiException
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * 中继 HTTP 端点（契约 §2.1 / §2.3）：配对前没有 deviceToken，走不了隧道，
 * 因此 health 与 pair/claim 必须是普通 HTTP —— 这也是"手机只连中继"的另一半。
 *
 * 用真实 TCP（MockWebServer）而不是 mock 掉传输层，确保请求路径/头部真的按契约发出。
 */
class RelayHttpClientTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun base(): String = server.url("/").toString().trimEnd('/')

    @Test
    fun `health 请求打到中继 health 且带上 api 版本头`() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"ok":true,"relayVersion":"2.0.0","apiVersion":2,"uptimeMs":1,"homes":1,"devices":2,"relayName":"relay.example.com"}""",
            ),
        )
        val client = RelayHttpClient()
        val health = client.health(base())
        assertTrue(health.ok)
        assertEquals("relay.example.com", health.relayName)

        val recorded = server.takeRequest()
        assertEquals("/health", recorded.path)
        assertEquals("2", recorded.getHeader("X-Api-Version"))
    }

    @Test
    fun `pair claim 发送 code deviceName deviceId 并解析 relay 块`() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"token":"dshr_9f2cAbCdEfGh1234","tokenId":"tok_7a1b","serverName":"DESKTOP-XXX","expiresAt":null,
                    "relay":{"homeId":"home_9f2c","deviceToken":"dshr_relay_abcdef","tunnelUrl":"wss://relay.example.com/api/v2/tunnel/device"}}""",
            ),
        )
        val client = RelayHttpClient()
        val claim = client.pairClaim(
            relayUrl = base(),
            code = "482913",
            deviceName = "Xiaomi 14",
            deviceId = "8f3c1e5a-1111-4222-8333-444455556666",
        )
        assertEquals("home_9f2c", claim.homeId)
        assertEquals("dshr_relay_abcdef", claim.effectiveDeviceToken)
        assertEquals("wss://relay.example.com/api/v2/tunnel/device", claim.tunnelUrl)

        val recorded = server.takeRequest()
        assertEquals("/api/v2/pair/claim", recorded.path)
        assertEquals("POST", recorded.method)
        val body = recorded.body.readUtf8()
        assertTrue(body, body.contains("\"code\":\"482913\""))
        assertTrue(body, body.contains("Xiaomi 14"))
        assertTrue(body, body.contains("8f3c1e5a-1111-4222-8333-444455556666"))
    }

    @Test
    fun `配对失败按契约错误码抛出`() {
        server.enqueue(
            MockResponse().setResponseCode(401).setBody(
                """{"error":{"code":"pairing_bad_code","message":"配对码错误或已过期"}}""",
            ),
        )
        try {
            RelayHttpClient().pairClaim(base(), "000000", "Pixel", "8f3c1e5a-1111-4222-8333-444455556666")
            fail("应抛 ApiException")
        } catch (e: ApiException) {
            assertEquals("pairing_bad_code", e.code)
            assertEquals(401, e.httpStatus)
        }
    }

    @Test
    fun `PC 离线时返回 503 home_offline`() {
        server.enqueue(
            MockResponse().setResponseCode(503).setBody("""{"error":{"code":"home_offline","message":"电脑隧道不在线"}}"""),
        )
        try {
            RelayHttpClient().pairClaim(base(), "482913", "Pixel", "8f3c1e5a-1111-4222-8333-444455556666")
            fail("应抛 ApiException")
        } catch (e: ApiException) {
            assertEquals("home_offline", e.code)
            assertEquals(503, e.httpStatus)
        }
    }

    @Test
    fun `非 JSON 错误体也能给出可读错误`() {
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>bad gateway</html>"))
        try {
            RelayHttpClient().health(base())
            fail("应抛 ApiException")
        } catch (e: ApiException) {
            assertEquals("internal", e.code)
            assertEquals(502, e.httpStatus)
        }
    }

    @Test
    fun `空地址直接报错而不是发出非法请求`() {
        try {
            RelayHttpClient().health("   ")
            fail("空地址应报错")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message.orEmpty().contains("中继地址"))
        }
    }
}
