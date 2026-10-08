package com.deepseek.dshremote.data

import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * ApiClient 的真实 HTTP 行为测试（MockWebServer）。
 *
 * 覆盖：契约端点路径与请求头、错误体到 [ApiException] 的映射、URL 规范化。
 */
class ApiClientTest {

    private lateinit var server: MockWebServer
    private lateinit var api: ApiClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = ApiClient()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun baseUrl() = server.url("/").toString().trimEnd('/')

    @Test
    fun `health 解析且不带认证头`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody(
                    """{"ok":true,"apiVersion":1,"serverName":"PC","gatewayVersion":"1.0.0",
                       "dshVersion":"0.1.0-rc.7","uptimeMs":1,"activeTasks":0,"queuedTasks":0,
                       "pairingOpen":false,"authRequired":true,"capabilities":["events"]}""",
                ),
        )
        val health = api.health(baseUrl())
        assertTrue(health.ok)
        val recorded = server.takeRequest()
        assertEquals("/api/v1/health", recorded.path)
        assertEquals("1", recorded.getHeader("X-Api-Version"))
        assertNull(recorded.getHeader("Authorization"))
    }

    @Test
    fun `pair claim 提交设备信息并解析令牌`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("""{"token":"dshr_abc","tokenId":"tok_1","serverName":"PC","expiresAt":null}"""),
        )
        val claim = api.pairClaim(baseUrl(), "482913", "Xiaomi 14", "device-uuid")
        assertEquals("dshr_abc", claim.token)

        val recorded = server.takeRequest()
        assertEquals("/api/v1/pair/claim", recorded.path)
        val body = recorded.body.readUtf8()
        assertTrue(body.contains("\"code\":\"482913\""))
        assertTrue(body.contains("Xiaomi 14"))
        assertTrue(body.contains("device-uuid"))
    }

    @Test
    fun `createTask 携带 Bearer 令牌与契约字段`() {
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """{"id":"task_1","title":"跑单测","prompt":"p","workspace":"D:\\proj","status":"queued",
                   "createdAt":1730000000000,"output":"","truncated":false}""",
            ),
        )
        val task = api.createTask(
            baseUrl = baseUrl(),
            token = "dshr_token",
            prompt = "跑单测，注意中文与换行\n第二行",
            workspace = "D:\\proj",
            title = null,
        )
        assertEquals("task_1", task.id)
        assertEquals(TaskStatus.QUEUED, task.status)

        val recorded = server.takeRequest()
        assertEquals("/api/v1/tasks", recorded.method)
        assertEquals("Bearer dshr_token", recorded.getHeader("Authorization"))
        val body = recorded.body.readUtf8()
        assertTrue("prompt 必须原样传递中文与换行", body.contains("第二行"))
        // 可选字段缺省时不发送，交给网关默认值
        assertTrue(!body.contains("\"title\""))
        assertTrue(!body.contains("\"timeoutSec\""))
    }

    @Test
    fun `401 映射为 unauthorized 异常`() {
        server.enqueue(
            MockResponse().setResponseCode(401)
                .setBody("""{"error":{"code":"unauthorized","message":"设备令牌无效或已吊销"}}"""),
        )
        val error = runCatching { api.listTasks(baseUrl(), "bad") }.exceptionOrNull()
        assertTrue(error is ApiException)
        error as ApiException
        assertTrue(error.isUnauthorized)
        assertEquals("设备令牌无效或已吊销", error.message)
    }

    @Test
    fun `429 busy 映射为 rate_limited`() {
        server.enqueue(
            MockResponse().setResponseCode(429)
                .setBody("""{"error":{"code":"rate_limited","message":"请求过于频繁"}}"""),
        )
        val error = runCatching {
            api.createTask(baseUrl(), "t", "p", "D:\\proj")
        }.exceptionOrNull() as ApiException
        assertTrue(error.isRateLimited)
    }

    @Test
    fun `cancel 与 list 使用契约路径`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"tasks":[],"nextCursor":null}"""))
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody("""{"id":"task_1","status":"canceled","createdAt":1,"output":""}"""),
        )
        api.listTasks(baseUrl(), "t", status = "active", limit = 50)
        api.cancelTask(baseUrl(), "t", "task_1")

        assertEquals("/api/v1/tasks?status=active&limit=50", server.takeRequest().path)
        val cancel = server.takeRequest(2, TimeUnit.SECONDS)
        assertEquals("/api/v1/tasks/task_1/cancel", cancel?.path)
        assertEquals("POST", cancel?.method)
    }

    @Test
    fun `deleteTask 只对终态任务发 DELETE`() {
        server.enqueue(MockResponse().setResponseCode(204))
        api.deleteTask(baseUrl(), "t", "task_9")
        val recorded = server.takeRequest()
        assertEquals("DELETE", recorded.method)
        assertEquals("/api/v1/tasks/task_9", recorded.path)
    }

    @Test
    fun `baseUrl 规范化`() {
        assertEquals("http://192.168.1.8:8787", ApiClient.normalizeBaseUrl("192.168.1.8:8787"))
        assertEquals("http://192.168.1.8:8787", ApiClient.normalizeBaseUrl(" http://192.168.1.8:8787/ "))
        assertEquals("https://pc.example.com", ApiClient.normalizeBaseUrl("https://pc.example.com/"))
        assertEquals("", ApiClient.normalizeBaseUrl("   "))
    }

    @Test
    fun `eventsUrl 组装 fromSeq 与 taskId`() {
        assertEquals(
            "http://pc:8787/api/v1/events",
            api.eventsUrl("http://pc:8787"),
        )
        assertEquals(
            "http://pc:8787/api/v1/events?fromSeq=42",
            api.eventsUrl("http://pc:8787", fromSeq = 42),
        )
        assertEquals(
            "http://pc:8787/api/v1/events?taskId=task_1&fromSeq=7",
            api.eventsUrl("http://pc:8787", taskId = "task_1", fromSeq = 7),
        )
    }
}
