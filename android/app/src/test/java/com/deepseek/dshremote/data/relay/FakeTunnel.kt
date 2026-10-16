package com.deepseek.dshremote.data.relay

import java.util.concurrent.CopyOnWriteArrayList

/**
 * 内存版隧道：一端是 [RelayClient]（客户端），另一端由测试直接驱动（扮演中继）。
 *
 * 为什么不用 mockk/MockWebServer：隧道协议的价值全在"帧序列 + id 多路复用"上，
 * 真实 WS 会引入握手/线程等无关变量；这里让测试**同步**决定每一帧何时到达，
 * 于是乱序、迟到、大帧、掉线都能被精确构造，而且跑在纯 JVM 上（无模拟器）。
 */
class FakeTunnel : WsTransport {

    /** 客户端发出的原始帧文本（顺序即发送顺序）。 */
    val clientFrames = CopyOnWriteArrayList<String>()

    /** 每收到一帧就回调一次（测试在这里扮演中继/PC 回应）。 */
    var onClientFrame: ((RelayFrame) -> Unit)? = null

    var connections: Int = 0
        private set

    var lastUrl: String = ""
        private set

    var lastHeaders: Map<String, String> = emptyMap()
        private set

    /** 非 null 时：每次 connect 都在 onOpen 之后立刻失败（用于测重连退避）。 */
    var failOnConnect: Throwable? = null

    private var clientListener: WsListener? = null
    private var clientHandle: Handle? = null
    private var closedNotified = false

    override fun connect(url: String, headers: Map<String, String>, listener: WsListener): WsHandle {
        connections++
        lastUrl = url
        lastHeaders = headers
        closedNotified = false
        val handle = Handle(
            onSend = { text ->
                clientFrames += text
                // 解析失败也要抛给测试，而不是静默
                onClientFrame?.invoke(FrameCodec.decode(text))
            },
            // 客户端主动 close（例如心跳判死）也要像真 WS 一样回调 onClosed，
            // 否则 RelayClient 会一直等在 closed 上、永远不重连
            onClosed = { code, reason -> notifyClosed(code, reason) },
        )
        clientHandle = handle
        clientListener = listener
        // 同步完成"握手"：连接立刻可用，省掉真实网络的不确定性
        listener.onOpen(handle)
        failOnConnect?.let { cause ->
            handle.markClosed()
            listener.onFailure(cause)
        }
        return handle
    }

    private fun notifyClosed(code: Int, reason: String) {
        if (closedNotified) return
        closedNotified = true
        clientListener?.onClosed(code, reason)
    }

    /** 客户端发来的帧（已解析）。 */
    fun frames(): List<RelayFrame> = clientFrames.map { FrameCodec.decode(it) }

    /** 客户端最近一次发出的 req 帧。 */
    fun lastRequest(): ReqFrame? = frames().filterIsInstance<ReqFrame>().lastOrNull()

    fun serverSend(frame: RelayFrame) {
        clientListener?.onMessage(FrameCodec.encode(frame))
    }

    fun serverSendRaw(text: String) {
        clientListener?.onMessage(text)
    }

    /** 模拟对端主动断开（会触发 RelayClient 的重连循环）。 */
    fun serverClose(code: Int = 1000, reason: String = "bye") {
        clientHandle?.markClosed()
        notifyClosed(code, reason)
    }

    /** 模拟网络故障（连不上/读失败）。 */
    fun serverFail(cause: Throwable) {
        clientHandle?.markClosed()
        clientListener?.onFailure(cause)
    }

    /** 模拟中继在连上之前就返回致命错误（例如 401）。 */
    fun rejectWith(code: String, message: String) {
        clientListener?.onMessage(FrameCodec.encode(ErrorFrame(code, message, fatal = true)))
        clientHandle?.markClosed()
        notifyClosed(1008, code)
    }

    private class Handle(
        private val onSend: (String) -> Unit,
        private val onClosed: (Int, String) -> Unit,
    ) : WsHandle {
        @Volatile
        private var open = true

        override val isOpen: Boolean get() = open

        override fun send(text: String): Boolean {
            if (!open) return false
            onSend(text)
            return true
        }

        override fun close(code: Int, reason: String) {
            if (!open) return
            open = false
            onClosed(code, reason)
        }

        fun markClosed() {
            open = false
        }
    }
}
