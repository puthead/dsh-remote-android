package com.deepseek.dshremote.data.relay

import com.deepseek.dshremote.data.Logger
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 中继隧道客户端（契约 §3）。
 *
 * 手机端**所有**业务流量都从这里出去：HTTP 变成 `req` 帧，响应由 `res`/`chunk`/`end` 组装；
 * SSE 就是永远不发 `end` 的长流。手机不直接连 PC，因此这个类是"能不能用"的单点。
 *
 * 线程模型：
 * - [transport] 的回调在 OkHttp 读线程上，[PendingStreams] 自己加锁，事件在锁外回调；
 * - 连接/重连循环跑在注入的 [scope] 上，退避等待通过 [sleeper] 注入（单测可断言序列）；
 * - 心跳发送间隔通过 [timer] 注入（单测无需真实等待）。
 *
 * 安全：令牌只进 Authorization 头，日志一律只打印脱敏后的形态。
 */
class RelayClient(
    private val transport: WsTransport,
    private val scope: CoroutineScope,
    private val backoff: ReconnectBackoff = ReconnectBackoff(),
    private val heartbeatIntervalMs: Long = HeartbeatPolicy.INTERVAL_MS,
    private val heartbeatTimeoutMs: Long = HeartbeatPolicy.TIMEOUT_MS,
    private val handshakeTimeoutMs: Long = 15_000L,
    private val requestTimeoutMs: Long = 60_000L,
    private val maxBodyBytes: Long = PendingStreams.MAX_BODY_BYTES,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val sleeper: suspend (Long) -> Unit = { delay(it) },
    private val timer: suspend (Long) -> Unit = { delay(it) },
) {

    /** 中继隧道端点：地址 + 设备令牌（令牌不落日志）。 */
    data class Endpoint(val url: String, val token: String, val deviceName: String)

    private val endpoint = AtomicReference<Endpoint?>(null)
    private val lock = Any()
    private val ids = RelayIdAllocator()
    private val streams = PendingStreams(maxBodyBytes)

    private val _state = MutableStateFlow<RelayState>(RelayState.Idle)
    val state: StateFlow<RelayState> = _state.asStateFlow()

    @Volatile
    private var currentHandle: WsHandle? = null

    @Volatile
    private var lastPongAt: Long = 0L

    @Volatile
    private var desired: Boolean = false

    private var loopJob: Job? = null
    private var lastError: String = ""

    /** 未结束的流数（诊断用：正常应该回到 0，否则说明有流泄漏）。 */
    val pendingStreams: Int get() = streams.size

    val isConnected: Boolean get() = currentHandle?.isOpen == true && _state.value is RelayState.Connected

    /** 配置端点（幂等；地址/令牌变化时由上层先 [disconnect] 再 [connect]）。 */
    fun setEndpoint(url: String, token: String, deviceName: String = "Android") {
        val normalized = RelayUrls.tunnelUrl(url)
        endpoint.set(Endpoint(normalized, token, deviceName))
        Logger.i(TAG, "中继端点已配置 url=$normalized token=${mask(token)}")
    }

    fun clearEndpoint() {
        endpoint.set(null)
    }

    fun endpointUrl(): String? = endpoint.get()?.url

    /** 启动连接循环（幂等；已连接时什么都不做）。 */
    fun connect() {
        desired = true
        synchronized(lock) {
            if (loopJob?.isActive == true) return
            if (endpoint.get() == null) {
                _state.value = RelayState.Idle
                return
            }
            loopJob = scope.launch { runLoop() }
        }
    }

    /** 主动断开（用户登出/换地址）。会失败掉所有在飞的流，避免调用方永久挂起。 */
    fun disconnect() {
        desired = false
        val job: Job?
        synchronized(lock) {
            job = loopJob
            loopJob = null
        }
        job?.cancel()
        closeCurrent("client_disconnect")
        streams.abortAll("client_disconnect")
        _state.value = RelayState.Idle
    }

    /** 等待隧道进入 `Connected`（配对成功后 UI 用来决定是否显示"已连接"）。 */
    suspend fun awaitConnected(timeoutMs: Long = 15_000L): Boolean = withTimeoutOrNull(timeoutMs) {
        state.first { it is RelayState.Connected || it is RelayState.Unauthorized }
    } is RelayState.Connected

    /**
     * 等待"隧道可用**且** PC 在线"（`Connected && homeOnline`，即 [RelayState.Connected.isComputerOffline] 为假）。
     *
     * 为什么需要它：用户的**主动刷新**不能因为撞上重连窗口就报错。手机在蜂窝网下隧道会被运营商
     * NAT 掐断（中继日志关闭原因 `code=1006 reason=socket`，实测每 20s~4min 一次）；
     * 但断的那一刻 `writableHandle()` 会抛 `home_offline`，界面就弹"电脑离线"——把一次抖动
     * 说成了"电脑不在"。先等一小会儿再发请求，抖动就自己过去了。
     *
     * 重连耗时**不是**"几百毫秒"：2026-10-15 复核中继日志，`device 隧道 socket 关闭` →
     * `隧道上线 homeOnline=true` 的可配对间隔实测 **8.9s / 13.4s / 13.9s / 17.6s**
     * （退避 1s、2s、4s…），所以默认预算给到 20s（见 [ConsoleRepository.TUNNEL_WAIT_MS]）。
     *
     * 返回 false 的三种情况：没有配置端点、超时、或收到致命错误（[RelayState.Unauthorized]）。
     * 调用方拿到 false 后应当**如实报错**（例如"电脑离线"），不要假装成功。
     *
     * 为什么按 [PROBE_TICK_MS] 轮询而不是只 `first { … }`：状态流在句柄断开后**不会立刻**
     * 离开 `Connected`（见 [nudgeIfHandleDead]），只按状态值判断会瞬间返回 true，
     * 让调用方拿着刚死掉的句柄再吃一次 `home_offline`。每次 tick 都重新判定
     * "状态是 Connected **且** 句柄现在真的开着"，顺带把死句柄踢掉让 runLoop 立刻重连。
     * 代价是恢复后最多晚 [PROBE_TICK_MS] 才放行，换来的是"等到了就一定能用"。
     */
    suspend fun waitOnline(timeoutMs: Long = 20_000L): Boolean {
        if (endpoint.get() == null) return false
        // 超时 → withTimeoutOrNull 给 null → 视作"等不到"，调用方照实报错
        return withTimeoutOrNull(timeoutMs) { pollUntilUsable() } ?: false
    }

    /** [waitOnline] 的轮询体：返回 true 表示"此刻真的有一条可用隧道"。 */
    private suspend fun pollUntilUsable(): Boolean {
        while (true) {
            when (val current = state.value) {
                // 没端点/刚起步/重连中：隧道根本没建起来，等一下重连
                RelayState.Idle, is RelayState.Connecting, is RelayState.Retrying -> Unit
                is RelayState.Connected -> {
                    if (isConnected && !current.isComputerOffline) return true
                    // 状态说 Connected、句柄却是死的/刚被换掉：踢掉它，runLoop 会立刻重连
                    nudgeIfHandleDead()
                }
                // 凭据失效 / 连接彻底失败：再等也不会好，让调用方立刻如实报错
                is RelayState.Unauthorized, is RelayState.Failed -> return false
            }
            delay(PROBE_TICK_MS)
        }
    }

    /**
     * 状态还停在 `Connected`、但底层 socket 其实已经死了时，主动把它关掉以**立刻**触发重连。
     *
     * 为什么不能只等状态流：写失败/读到 EOF 时 [WsHandle] 只会被标记 `closed`，
     * `runLoop` 还挂在 `closed.await()` 上——它要等到下一次心跳丢 pong（最多 30s）才会
     * 察觉并重连。中间这段时间状态流一直说"已连接且电脑在线"，等它的人会白等到超时，
     * 然后照样弹"电脑离线"。关掉这个句柄就等于告诉循环"这条连接没了"，重连立刻开始。
     */
    private fun nudgeIfHandleDead() {
        val handle = synchronized(lock) { currentHandle } ?: return
        if (handle.isOpen) return
        Logger.w(TAG, "隧道句柄已失效但状态仍是 Connected，主动关闭以触发重连")
        runCatching { handle.close(1000, "stale_handle") }
    }

    /**
     * 发起一次请求/响应（非流式）：等 `end` 后返回完整响应体。
     *
     * @throws RelayException 未连接（`home_offline`）、超时（`timeout`）、被 abort（reason 原样）
     */
    suspend fun request(
        method: String,
        path: String,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        timeoutMs: Long = requestTimeoutMs,
    ): TunnelResponse {
        val handle = writableHandle()
        val id = ids.next()
        val done = CompletableDeferred<TunnelResponse>()
        val accumulator = Accumulator()
        if (!streams.open(id) { event ->
                when (event) {
                    is TunnelEvent.Head -> accumulator.head(event.status, event.headers)
                    is TunnelEvent.Body -> accumulator.append(event.bytes)
                    TunnelEvent.End -> done.complete(accumulator.snapshot())
                    is TunnelEvent.Aborted -> done.completeExceptionally(
                        RelayException(event.reason.ifEmpty { "aborted" }, "中继终止了本次请求：${event.reason}"),
                    )
                }
            }
        ) {
            throw RelayException("internal", "隧道流 id 冲突：$id")
        }
        if (!send(handle, ReqFrame(id, method, path, headers, FrameCodec.encodeBody(body)))) {
            streams.cancel(id)
            throw RelayException("home_offline", "隧道写入失败（连接正在关闭）")
        }
        return try {
            withTimeoutOrNull(timeoutMs) { done.await() }
                ?: throw RelayException("timeout", "请求超时（${timeoutMs}ms）：$method $path")
        } catch (t: Throwable) {
            // 超时/取消时必须显式 cancel，否则网关侧的 SSE 会一直挂着
            streams.cancel(id)
            send(handle, CancelFrame(id))
            throw t
        }
    }

    /**
     * 打开一条流式请求（SSE 用）。
     *
     * 返回的 Flow 会在 `End`/`Aborted` 后自动关闭；**collect 被取消时发送 `cancel` 帧**
     * （契约 §3.1 硬性要求，否则中继与网关会保留这条流直到超时）。
     *
     * 缓冲策略：显式 `.buffer(Channel.UNLIMITED)`，避免默认 64 容量下 `trySend` 静默丢帧
     * （帧可能在 `send(ReqFrame)` 内同步回灌，订阅方还没开始排空；丢一个 SSE chunk 就毁一条事件）。
     */
    fun openStream(
        method: String,
        path: String,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
    ): Flow<TunnelEvent> = callbackFlow {
        val handle = synchronized(lock) { currentHandle }?.takeIf { it.isOpen }
        if (handle == null) {
            close(RelayException("home_offline", "中继隧道未连接"))
            return@callbackFlow
        }
        val id = ids.next()
        val registered = streams.open(id) { event ->
            trySend(event)
            if (event is TunnelEvent.End || event is TunnelEvent.Aborted) close()
        }
        if (!registered) {
            close(RelayException("internal", "隧道流 id 冲突：$id"))
            return@callbackFlow
        }
        if (!send(handle, ReqFrame(id, method, path, headers, FrameCodec.encodeBody(body)))) {
            streams.cancel(id)
            close(RelayException("home_offline", "隧道写入失败（连接正在关闭）"))
            return@callbackFlow
        }
        awaitClose {
            streams.cancel(id)
            send(handle, CancelFrame(id))
        }
        // 默认缓冲只有 64（Channel.BUFFERED），而 `trySend` 在缓冲满时**静默丢帧**：
        // 响应帧可能在 `send(ReqFrame)` 内部就同步回灌（中继与真机都可能这样重入），
        // 此时订阅方还没开始排空缓冲，长流会被悄悄截断成"少了几段"的坏流。
        // SSE 丢 chunk 会直接毁掉解析（实测：逐字节下发 88 个 chunk 时最后一个事件永远拼不出来），
        // 因此这里改成无界缓冲；单流体积另有 PendingStreams.MAX_BODY_BYTES = 32 MiB 兜底。
    }.buffer(Channel.UNLIMITED)

    // ---------- 内部：连接循环 ----------

    private suspend fun runLoop() {
        var attempt = 0
        while (coroutineContext.isActive && desired) {
            val current = endpoint.get()
            if (current == null) {
                _state.value = RelayState.Idle
                return
            }
            attempt++
            if (attempt > 1) ids.reset()
            _state.value = RelayState.Connecting(attempt)

            val ready = CompletableDeferred<ReadyFrame>()
            val closed = CompletableDeferred<String>()
            lastError = ""
            val listener = object : WsListener {
                override fun onOpen(handle: WsHandle) {
                    handle.send(FrameCodec.encode(HelloFrame(role = RelayRole.DEVICE, name = current.deviceName)))
                }

                override fun onMessage(text: String) {
                    val frames = runCatching { FrameCodec.decodeLines(text) }.getOrElse { error ->
                        lastError = error.message ?: "帧解析失败"
                        Logger.w(TAG, "隧道帧解析失败：${error.message}")
                        emptyList()
                    }
                    for (frame in frames) handleFrame(frame, handle = { currentHandle }, ready = ready)
                }

                override fun onClosed(code: Int, reason: String) {
                    if (!ready.isCompleted) {
                        ready.completeExceptionally(IOException("连接被关闭（$code $reason）"))
                    }
                    closed.complete("连接关闭 code=$code ${reason.take(80)}")
                }

                override fun onFailure(cause: Throwable) {
                    lastError = cause.message ?: cause::class.java.simpleName
                    if (!ready.isCompleted) ready.completeExceptionally(cause)
                    closed.complete(lastError)
                }
            }

            val handle = try {
                transport.connect(
                    current.url,
                    mapOf(
                        "Authorization" to "Bearer ${current.token}",
                        "X-Api-Version" to API_VERSION.toString(),
                    ),
                    listener,
                )
            } catch (t: Throwable) {
                // 中继地址畸形（例如端口写成 70000）时 OkHttp 在建 Request 阶段就抛
                // IllegalArgumentException，异常点在此之前完全在 try 之外：会顺着 appScope
                // 直达线程默认 handler → 进程崩溃，且重连循环一并死掉再也起不来。
                lastError = t.message ?: t::class.java.simpleName
                null
            }

            if (handle == null) {
                val reason = lastError.ifEmpty { "建立隧道失败" }
                closeCurrent("connect_failed")
                streams.abortAll("connect_failed")
                if (!desired) break
                val delayMs = backoff.nextDelayMs()
                Logger.w(TAG, "隧道连接失败（$reason），${delayMs}ms 后重连")
                _state.value = RelayState.Retrying(attempt, delayMs, reason)
                sleeper(delayMs)
                continue
            }

            synchronized(lock) { currentHandle = handle }
            lastPongAt = clock()

            val readyFrame = try {
                withTimeoutOrNull(handshakeTimeoutMs) { ready.await() }
            } catch (t: Throwable) {
                if (lastError.isEmpty()) lastError = t.message ?: "握手失败"
                null
            }

            if (readyFrame == null) {
                val reason = lastError.ifEmpty { "握手超时（${handshakeTimeoutMs}ms）" }
                closeCurrent("handshake_failed")
                streams.abortAll("handshake_failed")
                if (!desired) break
                if (_state.value is RelayState.Unauthorized) break
                val delayMs = backoff.nextDelayMs()
                Logger.w(TAG, "隧道未就绪（$reason），${delayMs}ms 后重连")
                _state.value = RelayState.Retrying(attempt, delayMs, reason)
                sleeper(delayMs)
                continue
            }

            backoff.reset()
            attempt = 0
            _state.value = RelayState.Connected(
                homeId = readyFrame.homeId,
                homeName = readyFrame.homeName ?: "PC",
                homeOnline = readyFrame.homeOnline,
                since = clock(),
            )
            Logger.i(
                TAG,
                "隧道已就绪 homeId=${mask(readyFrame.homeId)} home=${readyFrame.homeName} online=${readyFrame.homeOnline}",
            )

            val heartbeat = scope.launch { heartbeatLoop(handle) }
            val reason = closed.await()
            heartbeat.cancel()
            closeCurrent("connection_lost")
            streams.abortAll(reason)
            if (!desired) break
            if (_state.value is RelayState.Unauthorized) break
            val delayMs = backoff.nextDelayMs()
            Logger.w(TAG, "隧道断开（$reason），${delayMs}ms 后重连")
            _state.value = RelayState.Retrying(1, delayMs, reason)
            sleeper(delayMs)
        }
        if (!desired) {
            // 凭据失效（Unauthorized）是可行动的终态，不能被"循环退出"覆盖成 Idle
            if (_state.value !is RelayState.Unauthorized) _state.value = RelayState.Idle
        }
    }

    /** 处理一条 S→C 帧；数据面帧交给 [PendingStreams]。 */
    private fun handleFrame(
        frame: RelayFrame,
        handle: () -> WsHandle?,
        ready: CompletableDeferred<ReadyFrame>,
    ) {
        when (frame) {
            is ReadyFrame -> if (!ready.isCompleted) ready.complete(frame)

            is ErrorFrame -> {
                if (frame.fatal) {
                    when (frame.code) {
                        "unauthorized", "forbidden" -> {
                            desired = false
                            _state.value = RelayState.Unauthorized(frame.message.ifEmpty { frame.code })
                        }

                        else -> {
                            lastError = "${frame.code}：${frame.message}"
                            if (!ready.isCompleted) {
                                ready.completeExceptionally(IOException(lastError))
                            }
                        }
                    }
                } else {
                    Logger.w(TAG, "隧道非致命错误 ${frame.code}：${frame.message}")
                }
            }

            is PongFrame -> lastPongAt = clock()

            is PingFrame -> handle()?.let { send(it, PongFrame(frame.id)) }

            is NoticeFrame -> applyNotice(frame)

            is ChunkFrame, is ResFrame, is EndFrame, is AbortFrame -> {
                if (!streams.onFrame(frame)) {
                    Logger.d(TAG, "忽略未知 id 的 ${frame.type} 帧")
                }
            }

            else -> Logger.d(TAG, "忽略帧类型 ${frame.type}")
        }
    }

    private fun applyNotice(frame: NoticeFrame) {
        when (frame.kind) {
            NoticeKind.HOME_OFFLINE, NoticeKind.HOME_ONLINE -> {
                val online = frame.kind == NoticeKind.HOME_ONLINE
                val current = _state.value
                if (current is RelayState.Connected) {
                    _state.value = current.copy(homeOnline = online)
                }
                Logger.i(TAG, "中继通知：home ${if (online) "上线" else "离线"}")
            }

            NoticeKind.REVOKED -> {
                desired = false
                _state.value = RelayState.Unauthorized("设备令牌已被吊销，请重新配对")
            }

            else -> Logger.d(TAG, "未知通知 ${frame.kind}")
        }
    }

    /** 应用层心跳：发 ping，超时未收到 pong 就判死链并关连接（触发重连）。 */
    private suspend fun heartbeatLoop(handle: WsHandle) {
        while (coroutineContext.isActive && handle.isOpen) {
            timer(heartbeatIntervalMs)
            if (!handle.isOpen) return
            val sentAt = clock()
            val id = ids.next()
            if (!send(handle, PingFrame(id))) return
            timer(heartbeatTimeoutMs)
            if (lastPongAt < sentAt) {
                Logger.w(TAG, "心跳超时（${heartbeatTimeoutMs}ms 无 pong），重建隧道")
                handle.close(4000, "heartbeat_timeout")
                return
            }
        }
    }

    private fun writableHandle(): WsHandle =
        synchronized(lock) { currentHandle }?.takeIf { it.isOpen }
            ?: throw RelayException("home_offline", "中继隧道未连接，请检查中继地址或等待重连")

    private fun closeCurrent(reason: String) {
        val handle = synchronized(lock) {
            val current = currentHandle
            currentHandle = null
            current
        }
        runCatching { handle?.close(1000, reason.take(60)) }
    }

    private fun send(handle: WsHandle, frame: RelayFrame): Boolean {
        val ok = handle.send(FrameCodec.encode(frame))
        if (!ok) Logger.w(TAG, "隧道写入失败：${frame.type}")
        return ok
    }

    private class Accumulator {
        private val lock = Any()
        private var status = 0
        private var headers: Map<String, String> = emptyMap()
        private val body = ByteArrayOutputStream(8 * 1024)

        fun head(status: Int, headers: Map<String, String>) = synchronized(lock) {
            this.status = status
            this.headers = headers
        }

        fun append(bytes: ByteArray) = synchronized(lock) { body.write(bytes) }

        fun snapshot(): TunnelResponse = synchronized(lock) {
            TunnelResponse(status, headers, body.toByteArray())
        }
    }

    companion object {
        private const val TAG = "RelayClient"
        const val API_VERSION = 2

        /**
         * [waitOnline] 的轮询周期：既要很快发现重连成功，也不能把唤醒次数堆起来。
         *
         * 1s 的依据：中继日志实测的"隧道下线 → 重新上线"间隔是 8.9s~17.6s 量级，
         * 1s 的粒度最多让调用方多等 1s，仍落在 [ConsoleRepository] 的等待预算里。
         */
        private const val PROBE_TICK_MS = 1_000L

        /** 日志脱敏：只留前 4 位（契约 §5.5）。 */
        fun mask(value: String?): String =
            if (value.isNullOrEmpty()) "" else value.take(4) + "****"
    }
}
