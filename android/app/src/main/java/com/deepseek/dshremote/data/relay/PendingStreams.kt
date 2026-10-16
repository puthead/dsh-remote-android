package com.deepseek.dshremote.data.relay

import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicLong

/**
 * `req` 帧 id 分配器（契约 §3.2：由发起方分配，连接内唯一且**单调递增**）。
 *
 * 用 [AtomicLong] 而不是 Int：契约里 id 是 1..2^53 的 JSON number，
 * 且中继侧 device→home 会重映射，客户端只要保证自己这一侧单调即可。
 */
class RelayIdAllocator(start: Long = 1L) {
    private val next = AtomicLong(start)

    fun next(): Long = next.getAndIncrement()

    /** 重连后重新开始编号：旧连接上的 id 已经作废，新连接从中继视角是全新的。 */
    fun reset() {
        next.set(1L)
    }
}

/**
 * 多路复用流表 + chunk 重组器。
 *
 * 为什么单独抽出来：这是整个隧道最容易出错的一段（id 串线、漏 chunk、乱序、超大体），
 * 抽成纯 Kotlin 类后单测可以逐条构造帧序列，不需要真实 WS。
 *
 * 语义：
 * - 一个 `id` 的生命周期严格为 `res?` → `chunk*` → `end|abort`；
 * - **容忍 `res` 之前就到来的 `chunk`**（重组器不依赖头的先后），
 *   以及同一时刻多个 id 交错到达（多路复用的本质）；
 * - `end`/`abort` 之后再来的 `chunk` 计为 late 并丢弃（中继重发/竞态）；
 * - 单流累计体超过 [maxBodyBytes] → 立刻 `abort:overflow`，防 OOM；
 * - 回调一律在锁外执行，避免上层在回调里 cancel 造成死锁。
 */
class PendingStreams(private val maxBodyBytes: Long = MAX_BODY_BYTES) {

    private class Stream(val onEvent: (TunnelEvent) -> Unit) {
        var status: Int = 0
        var hasHead = false
        var headers: Map<String, String> = emptyMap()
        var ended = false
        var aborted = false
        var lateChunks = 0
        var bufferedBytes = 0L
        val body = ByteArrayOutputStream(INITIAL_BODY_BYTES)

        fun response(): TunnelResponse = TunnelResponse(status, headers, body.toByteArray())
    }

    private val lock = Any()
    private val streams = LinkedHashMap<Long, Stream>()

    /** 当前未结束的流数（UI/测试可见）。 */
    val size: Int get() = synchronized(lock) { streams.size }

    fun contains(id: Long): Boolean = synchronized(lock) { streams.containsKey(id) }

    /** 注册一条流；id 重复返回 false（调用方必须换 id）。 */
    fun open(id: Long, onEvent: (TunnelEvent) -> Unit): Boolean = synchronized(lock) {
        if (streams.containsKey(id)) return false
        streams[id] = Stream(onEvent)
        true
    }

    /** 主动撤销一条流（用户取消 / 超时）；返回是否命中。 */
    fun cancel(id: Long): Boolean = synchronized(lock) { streams.remove(id) != null }

    /**
     * 处理一帧。
     *
     * @return true 表示该帧属于一条已知的流（已消费）；false 表示与本表无关
     *   （未知 id 的 chunk/end 属于竞态残留，调用方可以忽略；ping/pong/notice 也走这里）
     */
    fun onFrame(frame: RelayFrame): Boolean {
        val dispatches = ArrayList<Pair<(TunnelEvent) -> Unit, TunnelEvent>>(2)
        var handled = false
        synchronized(lock) {
            when (frame) {
                is ResFrame -> {
                    val stream = streams[frame.id] ?: return@synchronized
                    stream.status = frame.status
                    stream.headers = frame.headers
                    stream.hasHead = true
                    handled = true
                    dispatches += stream.onEvent to TunnelEvent.Head(frame.status, frame.headers)
                }

                is ChunkFrame -> {
                    val stream = streams[frame.id] ?: return@synchronized
                    handled = true
                    if (stream.ended || stream.aborted) {
                        stream.lateChunks++
                        return@synchronized
                    }
                    val bytes = FrameCodec.decodeBody(frame.dataB64)
                    if (bytes == null) {
                        streams.remove(frame.id)
                        stream.aborted = true
                        dispatches += stream.onEvent to TunnelEvent.Aborted(REASON_BAD_CHUNK)
                        return@synchronized
                    }
                    stream.bufferedBytes += bytes.size
                    if (stream.bufferedBytes > maxBodyBytes) {
                        streams.remove(frame.id)
                        stream.aborted = true
                        dispatches += stream.onEvent to TunnelEvent.Aborted(REASON_OVERFLOW)
                        return@synchronized
                    }
                    stream.body.write(bytes)
                    dispatches += stream.onEvent to TunnelEvent.Body(bytes)
                }

                is EndFrame -> {
                    val stream = streams.remove(frame.id) ?: return@synchronized
                    stream.ended = true
                    handled = true
                    dispatches += stream.onEvent to TunnelEvent.End
                }

                is AbortFrame -> {
                    val stream = streams.remove(frame.id) ?: return@synchronized
                    stream.aborted = true
                    handled = true
                    dispatches += stream.onEvent to TunnelEvent.Aborted(frame.reason)
                }

                else -> Unit
            }
        }
        for ((callback, event) in dispatches) {
            runCatching { callback(event) }
        }
        return handled
    }

    /** 取走整包响应（仅 [End] 之后调用有意义）。 */
    fun responseOf(id: Long): TunnelResponse? = synchronized(lock) { streams[id]?.response() }

    /** 隧道断开 / 主动登出：把所有在飞的流一次性失败掉，避免调用方永久挂起。 */
    fun abortAll(reason: String) {
        val pending: List<(TunnelEvent) -> Unit>
        synchronized(lock) {
            pending = streams.values.map { it.onEvent }
            streams.clear()
        }
        pending.forEach { callback -> runCatching { callback(TunnelEvent.Aborted(reason)) } }
    }

    companion object {
        /** 客户端侧兜底上限：契约里中继对单流缓冲限制 1 MiB，客户端给足余量防 OOM。 */
        const val MAX_BODY_BYTES = 32L * 1024 * 1024
        private const val INITIAL_BODY_BYTES = 8 * 1024

        const val REASON_BAD_CHUNK = "bad_chunk"
        const val REASON_OVERFLOW = "overflow"
    }
}
