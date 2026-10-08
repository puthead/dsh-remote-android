package com.deepseek.dshremote.data

import java.io.IOException
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import okhttp3.Call
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * SSE 长连接客户端。
 *
 * 关键点：
 * - **读超时必须为 0**（无限等待）。契约里网关 15s 才发一次心跳，任何有限的读超时都会在
 *   任务安静期（模型思考时可能几十秒没有输出）把连接判死，反复重连反而更丢事件。
 * - 用 [SseFrameParser] 消费**原始字符流**而不是 `readLine()`，这样才能覆盖"一条事件被拆包"
 *   与 `\r` 结尾的包，并且每次读取都真实地处于 TCP 包边界上。
 * - [open] 只建立一次连接，重连由 [EventStream] 统一调度（带 fromSeq 与退避）。
 */
class SseClient(
    connectTimeoutSec: Long = 15,
    client: OkHttpClient? = null,
    private val parserFactory: () -> SseFrameParser = { SseFrameParser() },
) {
    /** 专用 OkHttpClient：不打乱普通 API 请求的超时配置。 */
    val httpClient: OkHttpClient = client ?: OkHttpClient.Builder()
        .connectTimeout(connectTimeoutSec, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(connectTimeoutSec, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /**
     * 发起一次 SSE 连接并返回可取消句柄；[SseConnection.readLoop] 才是阻塞读取。
     *
     * @param url 完整事件流地址（`fromSeq` 由调用方拼好）
     * @param token 设备令牌；`null`/空串表示不带认证头
     * @param onFrame 每解析出一帧回调一次；做成挂起函数，让上层可以安全地做落库等 IO
     */
    fun open(
        url: String,
        token: String?,
        onOpen: () -> Unit,
        onFrame: suspend (SseFrame) -> Unit,
    ): SseConnection {
        val request = Request.Builder()
            .url(url)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .header("X-Api-Version", API_VERSION.toString())
            .apply { if (!token.isNullOrEmpty()) header("Authorization", "Bearer $token") }
            .get()
            .build()
        return SseConnection(httpClient.newCall(request), parserFactory, onOpen, onFrame)
    }

    /** 一次 SSE 连接的可取消句柄。 */
    inner class SseConnection internal constructor(
        private val call: Call,
        private val newParser: () -> SseFrameParser,
        private val onOpen: () -> Unit,
        private val onFrame: suspend (SseFrame) -> Unit,
    ) {
        private val canceled = AtomicBoolean(false)

        val isCanceled: Boolean get() = canceled.get()

        /**
         * 阻塞读取，直到流自然结束、被 [cancel] 或抛 IO 异常。
         *
         * 声明成挂起函数只是为了能在帧回调里做 IO；实现本身是**同步阻塞**的，
         * 因此调用方必须放在 [Dispatchers.IO] 上。
         *
         * @return 本次连接收到的帧数；为 0 且没有异常说明连接立刻被对端关闭（需要重连）
         */
        @Throws(IOException::class)
        suspend fun readLoop(): Int {
            var count = 0
            val parser = newParser()
            call.execute().use { response: Response ->
                if (!response.isSuccessful) {
                    throw SseHttpException(response.code, response.safeBodyText())
                }
                val body = response.body ?: throw IOException("事件流响应没有 body")
                val contentType = body.contentType()
                if (contentType != null && contentType.isJsonLike()) {
                    // 反向代理/网关版本不匹配时可能返回 JSON 错误体，明确报出来比"空流"好排查
                    throw IOException("事件流返回了 JSON（$contentType），疑似被反代或网关拦截")
                }
                onOpen()
                InputStreamReader(body.byteStream(), Charsets.UTF_8).use { stream ->
                    val buffer = CharArray(READ_BUFFER_CHARS)
                    while (!canceled.get()) {
                        val len = stream.read(buffer)
                        if (len < 0) break
                        if (len == 0) continue
                        for (frame in parser.feed(String(buffer, 0, len))) {
                            count++
                            onFrame(frame)
                        }
                    }
                }
                // 半条事件（连接在帧中间断掉）必须丢弃：补齐后由 fromSeq 重放整条
                parser.reset()
            }
            return count
        }

        /** 幂等取消；阻塞中的读会因 socket 关闭而立刻抛错退出。 */
        fun cancel() {
            if (canceled.compareAndSet(false, true)) {
                runCatching { call.cancel() }
            }
        }
    }

    /** 非 2xx 握手响应；401 需要上层提示"重新配对"而不是无脑重连。 */
    class SseHttpException(val httpStatus: Int, val body: String) :
        IOException("SSE 握手失败 HTTP $httpStatus")

    companion object {
        const val API_VERSION = 1
        private const val READ_BUFFER_CHARS = 2048

        private fun Response.safeBodyText(): String =
            runCatching { body?.string().orEmpty() }.getOrDefault("")

        private fun MediaType.isJsonLike(): Boolean = subtype.contains("json")
    }
}
