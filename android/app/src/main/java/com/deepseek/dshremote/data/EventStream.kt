package com.deepseek.dshremote.data

import java.util.TreeMap
import kotlin.math.min
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 指数退避：1s → 2s → 4s → … → 上限 30s（契约 §7）。
 *
 * 做成不依赖协程的纯函数，方便单测；抖动（jitter）默认关闭，因为家里只有一台网关，
 * 不需要避免惊群，而确定性延迟更利于排障。
 */
class ReconnectBackoff(
    private val baseMs: Long = 1_000L,
    private val maxMs: Long = 30_000L,
    private val multiplier: Double = 2.0,
) {
    init {
        require(baseMs > 0) { "baseMs 必须为正数" }
        require(maxMs >= baseMs) { "maxMs 不得小于 baseMs" }
    }

    /** @param attempt 从 1 开始的失败次数（第 1 次失败返回 baseMs）。 */
    fun delayFor(attempt: Int): Long {
        if (attempt <= 1) return baseMs
        var value = baseMs.toDouble()
        repeat(attempt - 1) {
            value *= multiplier
            if (value >= maxMs) return maxMs
        }
        return min(value.toLong(), maxMs)
    }
}

/**
 * 事件排序/去重器。
 *
 * 契约要求客户端"按 seq 严格排序、去重"。这里的做法是：
 * - 去重：只接受 `seq > lastApplied` 的事件（重连补发必然带来重复）；
 * - 排序：用 [TreeMap] 暂存，只在**连续**（`lastApplied + 1`）时依次放行，于是输出拼接顺序
 *   与 seq 顺序严格一致；
 * - 空洞兜底：网关只保留最近 2000 条事件，若断线太久，`fromSeq` 会落在窗口之外，流里会出现
 *   永远补不齐的空洞。此时靠 [flushPending]（连接空闲时由上层定期调用）按升序强制放行，
 *   宁可少几行日志也不要卡死整个事件流。
 */
class EventReducer {
    /**
     * 事件在 IO 读取线程写入，空洞兜底任务在另一个协程里读取/放行，因此必须显式同步；
     * [TreeMap] 不是线程安全容器，裸用会在并发下损坏结构。
     */
    private val lock = Any()
    private var lastApplied: Long = -1L
    private val pending = TreeMap<Long, TaskEvent>()

    /** 已应用的最后一个 seq；重连时的 `fromSeq` 就是它。 */
    val lastAppliedSeq: Long get() = synchronized(lock) { lastApplied }

    /**
     * 接收一个事件。
     *
     * @return 本次可以按序应用的事件（可能为空：重复事件 = 空，乱序事件 = 先暂存）
     */
    fun accept(event: TaskEvent): List<TaskEvent> = synchronized(lock) { acceptLocked(event) }

    /** 批量版本；同一批内先按 seq 排序再逐个处理。 */
    fun acceptAll(events: List<TaskEvent>): List<TaskEvent> = synchronized(lock) {
        events.sortedBy { it.seq }.flatMap { acceptLocked(it) }
    }

    /**
     * 强制放行暂存事件（升序）。用于检测到空洞后继续消费，避免整条流停摆。
     *
     * @return 实际放行的事件
     */
    fun flushPending(): List<TaskEvent> = synchronized(lock) { drain(onlyContiguous = false) }

    /** 是否仍有事件在等前面的空洞。 */
    val hasPendingGap: Boolean get() = synchronized(lock) { pending.isNotEmpty() }

    /** 重置到某个已知游标（切换服务器/令牌时调用，避免串台）。 */
    fun reset(fromSeq: Long = -1L) = synchronized(lock) {
        pending.clear()
        lastApplied = fromSeq
    }

    private fun acceptLocked(event: TaskEvent): List<TaskEvent> {
        if (event.seq <= lastApplied) return emptyList()
        pending[event.seq] = event
        return drain(onlyContiguous = true)
    }

    private fun drain(onlyContiguous: Boolean): List<TaskEvent> {
        if (pending.isEmpty()) return emptyList()
        val out = mutableListOf<TaskEvent>()
        while (pending.isNotEmpty()) {
            val first = pending.firstKey()
            if (onlyContiguous && first != lastApplied + 1) break
            val next = pending.remove(first) ?: break
            lastApplied = next.seq
            out += next
        }
        return out
    }
}

/**
 * 一次 SSE 订阅的参数快照。
 *
 * 之所以把 URL 组装做成可替换的 lambda：重连时必须重新读取"当前"的 settings 与 fromSeq，
 * 否则换服务器或换令牌后仍在重连旧地址。
 */
data class StreamRequest(
    val url: String,
    val token: String,
)

/**
 * SSE 事件流循环：连接 → 消费 → 断线 → 退避 → 带 fromSeq 重连。
 *
 * 单独成类（而不是塞进 Repository）是为了能用 MockWebServer 做端到端单测：
 * 断言"服务端关闭连接后客户端自动重连并带上了 fromSeq=已收到的最新 seq"。
 */
class EventStream(
    private val sseClient: SseClient,
    private val backoff: ReconnectBackoff = ReconnectBackoff(),
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
    @Volatile
    private var connection: SseClient.SseConnection? = null

    @Volatile
    private var stopped = false

    /**
     * 启动事件流循环（在调用方 scope 内运行，建议 Dispatchers.IO）。
     *
     * @param requestProvider 每次（重）连前调用，返回 null 表示"无可用配置"，直接结束
     * @param reducer 排序/去重器；其 [EventReducer.lastAppliedSeq] 会自动作为 `fromSeq`
     * @param onEvents 按序放行的事件；允许挂起（落库等 IO 不影响读取线程的时序保证）
     * @param onState 连接状态变化（UI 顶部指示条）
     */
    fun start(
        scope: CoroutineScope,
        requestProvider: () -> StreamRequest?,
        reducer: EventReducer,
        onEvents: suspend (List<TaskEvent>) -> Unit,
        onState: (ConnectionState) -> Unit,
    ): Job = scope.launch {
        var attempt = 0
        stopped = false
        while (isActive && !stopped) {
            val base = requestProvider()
            if (base == null) {
                onState(ConnectionState.Failed("尚未配置服务器地址或令牌"))
                return@launch
            }
            attempt += 1
            onState(ConnectionState.Connecting(attempt))
            var received = 0
            var failure: Throwable? = null
            try {
                withContext(Dispatchers.IO) {
                    val conn = sseClient.open(
                        url = withFromSeq(base.url, reducer.lastAppliedSeq),
                        token = base.token,
                        onOpen = { onState(ConnectionState.Connected(nowMs())) },
                        onFrame = { frame ->
                            received++
                            parseFrame(frame)?.let { events -> onEvents(reducer.accept(events)) }
                        },
                    )
                    connection = conn
                    val count = conn.readLoop()
                    if (count == 0 && !conn.isCanceled) {
                        failure = java.io.IOException("连接被对端立即关闭")
                    }
                }
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                failure = t
            } finally {
                connection = null
            }

            if (stopped || !isActive) break

            if (failure == null) {
                // 正常结束（服务端主动关闭）：短暂停顿后用 fromSeq 续传，避免网关立刻关流时打成热循环
                attempt = 0
                onState(ConnectionState.Retrying(0, RESUME_DELAY_MS, "连接已结束，正在续传"))
                delay(RESUME_DELAY_MS)
                continue
            }

            val fatal = failure as? SseClient.SseHttpException
            if (fatal != null && fatal.httpStatus == 401) {
                // 令牌失效属于配置问题，重试只会刷爆限速；交给 UI 引导重新配对
                onState(ConnectionState.Failed("设备令牌无效，请重新配对（HTTP 401）"))
                return@launch
            }
            val wait = backoff.delayFor(attempt)
            onState(ConnectionState.Retrying(attempt, wait, failure?.message ?: "网络异常"))
            delay(wait)
        }
        onState(ConnectionState.Idle)
    }

    /** 停止并取消当前连接；[start] 返回的 Job 也会被取消。 */
    fun stop() {
        stopped = true
        connection?.cancel()
        connection = null
    }

    /**
     * 把原始帧转成事件。
     *
     * data 非法（网关升级、代理截断、未知事件类型）时返回 null 并跳过：一条坏帧不应该让整条流
     * 停摆；真正的缺口由 `fromSeq` 重连补发。
     */
    private fun parseFrame(frame: SseFrame): TaskEvent? = JsonCodec.parseEvent(frame.data)

    private fun withFromSeq(url: String, fromSeq: Long): String {
        if (fromSeq < 0) return url
        val separator = if (url.contains('?')) '&' else '?'
        return "$url${separator}fromSeq=$fromSeq"
    }

    companion object {
        /** 服务端主动关流后的续传间隔：既不打成热循环，也不让用户等到退避上限。 */
        private const val RESUME_DELAY_MS = 300L
    }
}
