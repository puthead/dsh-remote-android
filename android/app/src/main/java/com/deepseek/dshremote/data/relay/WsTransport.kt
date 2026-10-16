package com.deepseek.dshremote.data.relay

import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import com.deepseek.dshremote.data.Logger

/** WebSocket 可发送句柄。 */
interface WsHandle {
    val isOpen: Boolean

    /** @return false 表示底层已经不可写（连接正在关闭）。 */
    fun send(text: String): Boolean

    fun close(code: Int = 1000, reason: String = "client_close")
}

/** WS 事件回调；全部在 OkHttp 的读线程上触发，实现方必须自己保证线程安全。 */
interface WsListener {
    fun onOpen(handle: WsHandle)

    fun onMessage(text: String)

    fun onClosed(code: Int, reason: String)

    fun onFailure(cause: Throwable)
}

/**
 * 把 WS 传输抽成接口。
 *
 * 动机只有一个：**让隧道协议本身可以被单测**。真实实现是 OkHttp（[OkHttpWsTransport]），
 * 单测用内存里的双向管道（`FakeWsTransport`）驱动同一份 [RelayClient] 代码，
 * 于是多路复用、chunk 重组、心跳、重连退避都能在 JVM 上跑，不需要模拟器。
 */
interface WsTransport {
    fun connect(url: String, headers: Map<String, String>, listener: WsListener): WsHandle
}

/** OkHttp 实现：只在 `onOpen` 之后才算可用，其余回调原样透传。 */
class OkHttpWsTransport(
    private val client: OkHttpClient = defaultClient(),
) : WsTransport {

    override fun connect(url: String, headers: Map<String, String>, listener: WsListener): WsHandle {
        val builder = Request.Builder().url(url)
        headers.forEach { (key, value) -> builder.header(key, value) }
        val handle = OkHttpHandle()
        val socket = client.newWebSocket(
            builder.build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    handle.markOpen()
                    listener.onOpen(handle)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    listener.onMessage(text)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    // 对端先关：回一个 close 完成握手，真正的收尾在 onClosed
                    runCatching { webSocket.close(code, reason) }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    handle.markClosed()
                    listener.onClosed(code, reason)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    handle.markClosed()
                    // 失败原因要带上 HTTP 状态（握手 401 与网络不可达的处置完全不同）
                    val detail = response?.let { " (HTTP ${it.code})" }.orEmpty()
                    Logger.w(TAG, "WS 失败：${t.message}$detail")
                    listener.onFailure(t)
                }
            },
        )
        handle.attach(socket)
        return handle
    }

    private class OkHttpHandle : WsHandle {
        @Volatile
        private var socket: WebSocket? = null

        @Volatile
        private var open = false

        @Volatile
        private var closed = false

        fun attach(webSocket: WebSocket) {
            socket = webSocket
        }

        fun markOpen() {
            open = true
        }

        fun markClosed() {
            open = false
            closed = true
        }

        override val isOpen: Boolean get() = open && !closed

        override fun send(text: String): Boolean {
            if (closed) return false
            return runCatching { socket?.send(text) == true }.getOrDefault(false)
        }

        override fun close(code: Int, reason: String) {
            closed = true
            open = false
            runCatching { socket?.close(code, reason) }
        }
    }

    companion object {
        private const val TAG = "OkHttpWs"

        /**
         * 隧道专用客户端：读超时为 0（SSE 长流可能几十秒没有字节），
         * 心跳由 [RelayClient] 用应用层 ping/pong 负责，不用 OkHttp 的 pingInterval。
         */
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }
}
