package com.deepseek.dshremote.data

import java.util.Collections
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * SSE 全链路测试：真实 HTTP（MockWebServer）+ 真实 OkHttp + 真实解析器 + 事件排序器。
 *
 * 覆盖需求 2/3：分包重组、转义换行、按 seq 拼接、断线自动重连并携带 `fromSeq`、
 * 401 不无脑重试、读超时为 0。
 */
class EventStreamTest {

    private lateinit var server: MockWebServer
    private lateinit var client: SseClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = SseClient()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    // ---------- 测试用的事件流构造 ----------

    private fun sseResponse(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "text/event-stream")
        .setBody(body)

    /** 按 JSON 规则转义，这样才能真实模拟"data 内部换行以 \n 转义"。 */
    private fun jsonEscape(text: String): String = text
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\n", "\\n")
        .replace("\r", "\\r")

    private fun outputEvent(seq: Long, delta: String): String =
        "id: $seq\nevent: task.output\n" +
            "data: {\"seq\":$seq,\"taskId\":\"task_1\",\"at\":${seq * 1000}," +
            "\"type\":\"task.output\",\"delta\":\"${jsonEscape(delta)}\"}\n\n"

    private fun finishedEvent(seq: Long, output: String): String =
        "id: $seq\nevent: task.finished\n" +
            "data: {\"seq\":$seq,\"taskId\":\"task_1\",\"at\":${seq * 1000},\"type\":\"task.finished\"," +
            "\"task\":{\"id\":\"task_1\",\"title\":\"跑单测\",\"prompt\":\"p\",\"workspace\":\"D:\\\\proj\"," +
            "\"status\":\"succeeded\",\"createdAt\":1,\"startedAt\":2,\"finishedAt\":3,\"exitCode\":0," +
            "\"output\":\"${jsonEscape(output)}\",\"error\":null,\"truncated\":false,\"sessionId\":\"s\"}}\n\n"

    private fun streamUrl() = server.url("/api/v1/events").toString()

    private class Recorder {
        val events = Collections.synchronizedList(mutableListOf<TaskEvent>())
        val states = Collections.synchronizedList(mutableListOf<ConnectionState>())

        fun output(): String =
            events.filter { it.type == TaskEventType.TASK_OUTPUT }.joinToString("") { it.delta }
    }

    // ---------- 用例 ----------

    @Test
    fun `读超时必须为 0 否则安静期会误判断线`() {
        assertEquals(0, client.httpClient.readTimeoutMillis)
        assertTrue(client.httpClient.connectTimeoutMillis > 0)
    }

    @Test
    fun `单次连接按 seq 拼接输出并识别终态`() = runBlocking {
        server.enqueue(
            sseResponse(
                ": ping\n\n" +
                    outputEvent(1, "第一行\n") +
                    outputEvent(2, "第二行\n") +
                    finishedEvent(3, "第一行\n第二行\n"),
            ),
        )
        val recorder = Recorder()
        val reducer = EventReducer()
        val scope = CoroutineScope(Dispatchers.IO)
        val stream = EventStream(client, ReconnectBackoff(baseMs = 10, maxMs = 20))
        stream.start(
            scope = scope,
            requestProvider = { StreamRequest(streamUrl(), "dshr_token") },
            reducer = reducer,
            onEvents = { recorder.events.addAll(it) },
            onState = { recorder.states.add(it) },
        )

        withTimeout(5_000) {
            while (recorder.events.none { it.type == TaskEventType.TASK_FINISHED }) delay(10)
        }

        assertEquals("第一行\n第二行\n", recorder.output())
        val finished = recorder.events.first { it.type == TaskEventType.TASK_FINISHED }
        assertEquals(TaskStatus.SUCCEEDED, finished.task?.status)
        assertEquals("第一行\n第二行\n", finished.task?.output)
        assertTrue(recorder.states.any { it is ConnectionState.Connected })
        assertEquals(3L, reducer.lastAppliedSeq)

        stream.stop()
        scope.cancel()
    }

    @Test
    fun `事件被切成多个网络包仍能还原`() = runBlocking {
        val body = ": ping\n\n" + outputEvent(1, "中文第一行\n") + outputEvent(2, "second")
        // 每 4 字节一个 chunk：中文（3 字节）必然被拆到两个 chunk，考验 UTF-8 解码
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setChunkedBody(body, 4),
        )
        val recorder = Recorder()
        val reducer = EventReducer()
        val scope = CoroutineScope(Dispatchers.IO)
        val stream = EventStream(client, ReconnectBackoff(baseMs = 10, maxMs = 20))
        stream.start(scope, { StreamRequest(streamUrl(), "t") }, reducer, { recorder.events.addAll(it) }, { recorder.states.add(it) })

        withTimeout(5_000) { while (recorder.events.size < 2) delay(10) }

        assertEquals("中文第一行\nsecond", recorder.output())
        stream.stop()
        scope.cancel()
    }

    @Test
    fun `断线后自动重连并携带 fromSeq`() = runBlocking {
        server.enqueue(sseResponse(outputEvent(1, "a") + outputEvent(2, "b")))
        server.enqueue(sseResponse(outputEvent(3, "c")))

        val recorder = Recorder()
        val reducer = EventReducer()
        val scope = CoroutineScope(Dispatchers.IO)
        val stream = EventStream(client, ReconnectBackoff(baseMs = 10, maxMs = 20))
        stream.start(scope, { StreamRequest(streamUrl(), "t") }, reducer, { recorder.events.addAll(it) }, { recorder.states.add(it) })

        withTimeout(5_000) { while (recorder.events.size < 3) delay(10) }

        val first = server.takeRequest(2, TimeUnit.SECONDS)
        val second = server.takeRequest(5, TimeUnit.SECONDS)
        assertEquals("/api/v1/events", first?.path)
        // 断线重连必须带上次已应用的 seq，网关据此补发；seq 从 1 开始因此首次不带 fromSeq
        assertTrue(second?.path.orEmpty().contains("fromSeq=2"))
        assertEquals("abc", recorder.output())
        assertEquals(3L, reducer.lastAppliedSeq)

        stream.stop()
        scope.cancel()
    }

    @Test
    fun `重连后重复补发的事件不会重复拼接`() = runBlocking {
        // 网关按 fromSeq 重发边界事件（含 seq=2）是契约允许的行为
        server.enqueue(sseResponse(outputEvent(1, "a") + outputEvent(2, "b")))
        server.enqueue(sseResponse(outputEvent(2, "b") + outputEvent(3, "c")))

        val recorder = Recorder()
        val scope = CoroutineScope(Dispatchers.IO)
        val stream = EventStream(client, ReconnectBackoff(baseMs = 10, maxMs = 20))
        stream.start(scope, { StreamRequest(streamUrl(), "t") }, EventReducer(), { recorder.events.addAll(it) }, {})

        withTimeout(5_000) { while (recorder.events.none { it.seq == 3L }) delay(10) }
        delay(100) // 给重复事件一点时间进来（它必须被丢弃）

        assertEquals("abc", recorder.output())
        stream.stop()
        scope.cancel()
    }

    @Test
    fun `令牌失效时停止重连并进入失败态`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(401)
                .setBody("""{"error":{"code":"unauthorized","message":"设备令牌无效或已吊销"}}"""),
        )
        val states = Collections.synchronizedList(mutableListOf<ConnectionState>())
        val scope = CoroutineScope(Dispatchers.IO)
        val stream = EventStream(client, ReconnectBackoff(baseMs = 10, maxMs = 20))
        stream.start(scope, { StreamRequest(streamUrl(), "bad") }, EventReducer(), {}, { states.add(it) })

        withTimeout(5_000) { while (states.none { it is ConnectionState.Failed }) delay(10) }
        delay(200)
        // 401 属于配置问题：重试只会刷爆限速，必须只请求一次
        assertEquals(1, server.requestCount)
        val failed = states.filterIsInstance<ConnectionState.Failed>().first()
        assertTrue(failed.reason.contains("重新配对"))

        stream.stop()
        scope.cancel()
    }

    @Test
    fun `连接被对端立即关闭时会退避重连`() = runBlocking {
        // 空响应体 = 网关立刻关连接（网关重启时的典型表现）
        server.enqueue(sseResponse(""))
        server.enqueue(sseResponse(outputEvent(1, "recovered")))

        val recorder = Recorder()
        val scope = CoroutineScope(Dispatchers.IO)
        val stream = EventStream(client, ReconnectBackoff(baseMs = 10, maxMs = 20))
        stream.start(scope, { StreamRequest(streamUrl(), "t") }, EventReducer(), { recorder.events.addAll(it) }, { recorder.states.add(it) })

        withTimeout(5_000) { while (recorder.events.isEmpty()) delay(10) }
        assertEquals("recovered", recorder.output())

        stream.stop()
        scope.cancel()
    }

    @Test
    fun `未配置服务器时不发起任何请求`() = runBlocking {
        val states = Collections.synchronizedList(mutableListOf<ConnectionState>())
        val scope = CoroutineScope(Dispatchers.IO)
        val stream = EventStream(client, ReconnectBackoff(baseMs = 10, maxMs = 20))
        stream.start(scope, { null }, EventReducer(), {}, { states.add(it) })

        withTimeout(2_000) { while (states.isEmpty()) delay(10) }
        delay(100)
        assertEquals(0, server.requestCount)
        assertTrue(states.last() is ConnectionState.Failed)
        assertNull(server.takeRequest(200, TimeUnit.MILLISECONDS))
        scope.cancel()
    }
}
