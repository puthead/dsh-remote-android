package com.deepseek.dshremote.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** 配对成功后的结果，供配置页展示服务器信息。 */
data class PairOutcome(
    val health: HealthInfo,
    val tokenId: String,
)

/**
 * 应用唯一的任务仓库：把 HTTP、SSE、本地存储粘在一起，向 UI 暴露只读状态流。
 *
 * 线程模型：
 * - 所有对 [tasks] 的写入都经过一把 [writeLock]，SSE 读取协程与 UI 提交动作不会互相覆盖；
 * - UI 只读 StateFlow，因此事件流消费永远不会被 Compose 重组阻塞（契约 §7 最后一条）。
 */
class TaskRepository(
    private val api: ApiClient,
    private val prefs: PrefsStore,
    /** 构造参数刻意不叫 history：与下面公开的 `history` 状态流同名会触发声明冲突。 */
    private val historyStore: HistoryStore,
    private val eventStream: EventStream,
    private val scope: CoroutineScope,
) {
    private val reducer = EventReducer()
    private val writeLock = Mutex()

    private val _settings = MutableStateFlow<AppSettings?>(null)
    val settings: StateFlow<AppSettings?> = _settings.asStateFlow()

    /**
     * 首次配置读取完成标记。
     *
     * UI 用它区分"还没读到配置"与"确实没配置"：否则冷启动会先闪一下配置页再跳首页。
     */
    private val _ready = MutableStateFlow(false)
    val ready: StateFlow<Boolean> = _ready.asStateFlow()

    private val _tasks = MutableStateFlow<Map<String, RemoteTask>>(emptyMap())

    /** 任务表；UI 侧再按 createdAt 倒序排列。 */
    val tasks: StateFlow<Map<String, RemoteTask>> = _tasks.asStateFlow()

    private val _history = MutableStateFlow<List<RemoteTask>>(emptyList())

    /** 本地历史（终态任务）；离线也能查看完整输出。 */
    val history: StateFlow<List<RemoteTask>> = _history.asStateFlow()

    private val _connection = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
    val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

    /**
     * 一次性全局提示（例如"设备令牌已失效，请重新配对"）。
     *
     * 与各页面自己的 message 分开：令牌失效会把用户强制送回配置页，
     * 提示必须跨越这次导航仍然可见（401 要清空令牌 + 回配置页 + 明确提示）。
     */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private var streamJob: Job? = null
    private var gapJob: Job? = null

    init {
        scope.launch {
            _history.value = historyStore.load()
        }
        scope.launch {
            prefs.settings.collect { latest ->
                val previous = _settings.value
                _settings.value = latest
                val switched = latest?.baseUrl != previous?.baseUrl || latest?.token != previous?.token
                if (switched) {
                    // 换了网关/令牌，或已登出：旧游标在新服务器上没有意义，实时表也必须清空
                    reducer.reset(LAST_SEQ_UNKNOWN)
                    _tasks.value = emptyMap()
                }
                if (switched || (latest != null && streamJob?.isActive != true)) {
                    if (latest != null) startStream() else stopStream()
                }
                _ready.value = true
            }
        }
    }

    // ---------- 连接与事件流 ----------

    /**
     * 启动（或复用）事件流。
     *
     * 刻意**不重置** [reducer] 的游标：前台服务被系统重启时会再调一次 [startStream]，
     * 重置游标会让网关把最近 2000 条事件全量重放，输出被重复拼接。游标只在换服务器时清空。
     */
    fun startStream() {
        if (streamJob?.isActive == true) return
        val current = _settings.value ?: return
        gapJob?.cancel()
        streamJob = eventStream.start(
            scope = scope,
            requestProvider = { currentStreamRequest() },
            reducer = reducer,
            onEvents = { events -> if (events.isNotEmpty()) applyEvents(events) },
            onState = { state ->
                _connection.value = state
                // 握手 401 说明令牌已失效：清令牌 + 回配置页（放独立协程，避免打断读取循环）
                if (state is ConnectionState.Unauthorized) scope.launch { handleUnauthorized() }
            },
        )
        // 事件空洞兜底：网关只保留 2000 条，断太久必然有洞，定期强制放行避免流停摆
        gapJob = scope.launch {
            while (isActive) {
                delay(GAP_FLUSH_INTERVAL_MS)
                if (reducer.hasPendingGap) {
                    Logger.w(TAG, "事件流出现空洞，强制放行暂存事件")
                    applyEvents(reducer.flushPending())
                }
            }
        }
        Logger.i(TAG, "事件流已启动 server=${current.serverName.orEmpty()}")
    }

    /** 停止事件流（前台服务销毁、用户断开、清除配置时调用）。 */
    fun stopStream() {
        eventStream.stop()
        streamJob?.cancel()
        streamJob = null
        gapJob?.cancel()
        gapJob = null
        _connection.value = ConnectionState.Idle
    }

    private fun currentStreamRequest(): StreamRequest? {
        val current = _settings.value ?: return null
        return StreamRequest(
            url = api.eventsUrl(current.baseUrl, taskId = null, fromSeq = reducer.lastAppliedSeq),
            token = current.token,
        )
    }

    // ---------- 配置 / 配对 ----------

    /**
     * 所有网络调用都必须离开主线程。
     *
     * 这是踩过的坑：ViewModel 用 `viewModelScope`（Dispatchers.Main.immediate）驱动，而
     * [ApiClient] 是 OkHttp **同步**调用；不切线程会直接抛 `NetworkOnMainThreadException`，
     * 外部表现就是"点了按钮毫无反应、网关侧也收不到任何请求"。
     * 把兜底放在仓库层，任何调用方（含未来新增的页面）都不会再踩。
     */
    private suspend fun <T> onIo(block: suspend () -> T): T = withContext(Dispatchers.IO) { block() }

    /** 探测服务器连通性（无需令牌）。 */
    suspend fun probeHealth(baseUrl: String): Result<HealthInfo> =
        runCatching { onIo { api.health(baseUrl) } }

    /**
     * 401 的统一处理：**清空本地令牌**并留下明确提示。
     *
     * 清空后 `settings` 变为 null，导航根节点会立刻把用户送回配置页，
     * 这正是"设备令牌已失效，请重新配对"应有的行为（而不是反复重连刷限速）。
     */
    suspend fun handleUnauthorized() {
        Logger.w(TAG, "设备令牌已失效：清空本地令牌并回到配置页")
        stopStream()
        prefs.clearConnection()
        _notice.value = NOTICE_TOKEN_EXPIRED
    }

    /**
     * 包一层 401 检测：只有"已配对令牌失效"才清配置。
     *
     * 刻意不用在 [pairAndSave] / [saveManualToken] 上——那两处的 401 表示"配对码错误"或
     * "粘贴的令牌无效"，语义完全不同，清配置只会让用户困惑。
     */
    private suspend fun <T> withAuthGuard(block: suspend () -> T): Result<T> = onIo {
        val result = runCatching { block() }
        result.exceptionOrNull()?.let { error ->
            if ((error as? ApiException)?.isUnauthorized == true) handleUnauthorized()
        }
        result
    }

    /** 提示已经被用户看到（或已被新的成功配对覆盖）。 */
    fun consumeNotice() {
        _notice.value = null
    }

    /**
     * 用配对码换取令牌并保存配置。
     *
     * 顺序很关键：先 claim（拿令牌）→ 再用令牌调 workspaces 验证权限 → 才落库，
     * 这样"配对成功但令牌其实无效"的情况会当场暴露，而不是等到首页一脸空白。
     */
    suspend fun pairAndSave(baseUrl: String, code: String, deviceName: String): Result<PairOutcome> =
        runCatching {
            onIo {
                val normalized = ApiClient.normalizeBaseUrl(baseUrl)
                require(normalized.isNotEmpty()) { "请先填写服务器地址" }
                require(code.length == 6 && code.all { it.isDigit() }) { "配对码必须是 6 位数字" }
                val deviceId = prefs.deviceId()
                val claim = api.pairClaim(normalized, code, deviceName, deviceId)
                check(claim.token.isNotEmpty()) { "网关没有返回设备令牌" }
                api.workspaces(normalized, claim.token) // 令牌自检
                val health = api.health(normalized)
                prefs.saveConnection(
                    baseUrl = normalized,
                    token = claim.token,
                    deviceName = deviceName,
                    serverName = claim.serverName.ifEmpty { health.serverName },
                )
                PairOutcome(health = health, tokenId = claim.tokenId)
            }
        }

    /** 手动粘贴令牌（配对码失效时的兜底通道）。 */
    suspend fun saveManualToken(baseUrl: String, token: String, deviceName: String): Result<HealthInfo> =
        runCatching {
            onIo {
                val normalized = ApiClient.normalizeBaseUrl(baseUrl)
                require(normalized.isNotEmpty()) { "请先填写服务器地址" }
                require(token.isNotBlank()) { "令牌不能为空" }
                val health = api.health(normalized)
                api.workspaces(normalized, token.trim()) // 令牌自检：错了立刻报 401
                prefs.saveConnection(normalized, token.trim(), deviceName, health.serverName)
                health
            }
        }

    suspend fun loadWorkspaces(): Result<WorkspaceList> = withAuthGuard {
        val current = _settings.value ?: throw ApiException("bad_request", "尚未配置服务器")
        api.workspaces(current.baseUrl, current.token)
    }

    suspend fun disconnect() {
        stopStream()
        onIo { prefs.clearConnection() }
    }

    // ---------- 任务 ----------

    /**
     * 提交任务。
     *
     * @return 成功时返回网关创建的 Task（状态 `queued`，即"已入队"）；`busy`/`bad_request`
     * 以异常形式返回，由 UI 直接展示 message。
     */
    suspend fun submit(
        prompt: String,
        workspace: String,
        title: String? = null,
        model: String? = null,
        reasoningEffort: String? = null,
        timeoutSec: Int? = null,
    ): Result<RemoteTask> = withAuthGuard {
        val current = _settings.value ?: throw ApiException("bad_request", "尚未配置服务器，请先完成配对")
        val trimmed = prompt.trim()
        require(trimmed.isNotEmpty()) { "任务内容不能为空" }
        require(workspace.isNotBlank()) { "请选择工作区" }
        val task = api.createTask(
            baseUrl = current.baseUrl,
            token = current.token,
            prompt = trimmed,
            workspace = workspace,
            title = title,
            model = model,
            reasoningEffort = reasoningEffort,
            timeoutSec = timeoutSec,
        )
        upsertTask(task)
        task
    }

    suspend fun cancel(taskId: String): Result<RemoteTask> = withAuthGuard {
        val current = _settings.value ?: throw ApiException("bad_request", "尚未配置服务器")
        val task = api.cancelTask(current.baseUrl, current.token, taskId)
        upsertTask(task)
        if (task.status.isTerminal) persistHistory(task)
        task
    }

    /** 用服务端对象对账（进详情页 / 重连后调用），修正本地可能缺失的输出。 */
    suspend fun refresh(taskId: String): Result<RemoteTask> = withAuthGuard {
        val current = _settings.value ?: throw ApiException("bad_request", "尚未配置服务器")
        val task = api.getTask(current.baseUrl, current.token, taskId)
        upsertTask(task)
        if (task.status.isTerminal) persistHistory(task)
        task
    }

    /** 拉取活动任务列表，用于冷启动补齐（App 重启期间产生的任务）。 */
    suspend fun refreshActive(): Result<List<RemoteTask>> = withAuthGuard {
        val current = _settings.value ?: throw ApiException("bad_request", "尚未配置服务器")
        val list = api.listTasks(current.baseUrl, current.token, status = "active", limit = 50)
        list.forEach { upsertTask(it) }
        list
    }

    /**
     * 删除服务端任务记录。
     *
     * 契约 A7：仅终态可删，活动态返回 `409 conflict`；UI 侧也必须只在终态任务上给出入口，
     * 否则用户点一下只会换回一个必然的错误。
     */
    suspend fun deleteRemote(taskId: String): Result<Unit> = withAuthGuard {
        val current = _settings.value ?: throw ApiException("bad_request", "尚未配置服务器")
        api.deleteTask(current.baseUrl, current.token, taskId)
        writeLock.withLock {
            _tasks.value = _tasks.value - taskId
        }
        _history.value = historyStore.delete(taskId)
    }

    /** 只删本地历史（不影响服务端记录）。 */
    suspend fun deleteHistory(taskId: String) {
        _history.value = historyStore.delete(taskId)
    }

    suspend fun clearHistory() {
        _history.value = historyStore.clear()
    }

    // ---------- 事件合并 ----------

    /** 事件已经在 [EventReducer] 里排好序，这里只做状态归并与落库。 */
    private suspend fun applyEvents(events: List<TaskEvent>) {
        for (event in events) {
            when (event.type) {
                TaskEventType.TASK_CREATED,
                TaskEventType.TASK_STARTED,
                TaskEventType.TASK_FINISHED,
                -> {
                    val incoming = event.task ?: continue
                    val merged = merge(_tasks.value[incoming.id], incoming)
                    upsertTask(merged)
                    if (merged.status.isTerminal) persistHistory(merged)
                }

                TaskEventType.TASK_OUTPUT -> {
                    writeLock.withLock {
                        val existing = _tasks.value[event.taskId] ?: RemoteTask(id = event.taskId)
                        _tasks.value = _tasks.value +
                            (event.taskId to existing.copy(output = existing.output + event.delta))
                    }
                }

                // progress 只是"阶段提示"，UI 的进度由 status 驱动；这里刻意不做额外状态
                TaskEventType.TASK_PROGRESS, TaskEventType.UNKNOWN -> Unit
            }
        }
    }

    /** 归并服务端 Task 对象与本地已有状态；规则见 [TaskMerger]（纯函数，可单测）。 */
    private fun merge(local: RemoteTask?, incoming: RemoteTask): RemoteTask =
        TaskMerger.merge(local, incoming)

    private suspend fun upsertTask(task: RemoteTask) {
        writeLock.withLock {
            _tasks.value = _tasks.value + (task.id to task)
        }
    }

    private suspend fun persistHistory(task: RemoteTask) {
        _history.value = historyStore.upsert(task)
        Logger.i(TAG, "任务进入终态 id=${task.id} status=${task.status.wire} exit=${task.exitCode}")
    }

    companion object {
        private const val TAG = "TaskRepository"
        private const val GAP_FLUSH_INTERVAL_MS = 3_000L

        /** 令牌失效提示文案（验收按这句话核对）。 */
        const val NOTICE_TOKEN_EXPIRED = "设备令牌已失效，请重新配对"

        /** `reset(fromSeq)` 用它表示"服务端有历史，按现有游标续传"。 */
        const val LAST_SEQ_UNKNOWN = -1L
    }
}
