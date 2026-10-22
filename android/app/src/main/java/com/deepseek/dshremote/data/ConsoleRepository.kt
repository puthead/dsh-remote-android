package com.deepseek.dshremote.data

import com.deepseek.dshremote.data.api.ChangeSet
import com.deepseek.dshremote.data.api.ChatMessage
import com.deepseek.dshremote.data.api.ConsoleEvent
import com.deepseek.dshremote.data.api.CreateTaskOutcome
import com.deepseek.dshremote.data.api.DirListing
import com.deepseek.dshremote.data.api.DshApiV2
import com.deepseek.dshremote.data.api.FileContent
import com.deepseek.dshremote.data.api.ImageLoader
import com.deepseek.dshremote.data.api.ImageRef
import com.deepseek.dshremote.data.api.LiveDraftMerge
import com.deepseek.dshremote.data.api.ModelCatalog
import com.deepseek.dshremote.data.api.PairClaimV2
import com.deepseek.dshremote.data.api.PendingImage
import com.deepseek.dshremote.data.api.RelayHealth
import com.deepseek.dshremote.data.api.RelayHttpClient
import com.deepseek.dshremote.data.api.SearchHit
import com.deepseek.dshremote.data.api.SessionPermission
import com.deepseek.dshremote.data.api.SessionSummary
import com.deepseek.dshremote.data.api.TaskAccess
import com.deepseek.dshremote.data.api.TaskHost
import com.deepseek.dshremote.data.api.ToolCall
import com.deepseek.dshremote.data.api.ToolCallSummary
import com.deepseek.dshremote.data.api.TranscriptPage
import com.deepseek.dshremote.data.api.TranscriptPager
import com.deepseek.dshremote.data.api.TranscriptSync
import com.deepseek.dshremote.data.api.TurnAccepted
import com.deepseek.dshremote.data.api.TurnIndex
import com.deepseek.dshremote.data.api.WireApprovals
import com.deepseek.dshremote.data.api.accessForHost
import com.deepseek.dshremote.data.api.WorkspacePaths
import com.deepseek.dshremote.data.api.WorkspaceSummary
import com.deepseek.dshremote.data.api.buildCreateTaskPayload
import com.deepseek.dshremote.data.api.withParentTitles
import com.deepseek.dshremote.data.relay.RelayClient
import com.deepseek.dshremote.data.relay.RelayException
import com.deepseek.dshremote.data.relay.RelayState
import com.deepseek.dshremote.data.relay.RelayUrls
import com.deepseek.dshremote.data.relay.ReconnectBackoff
import com.deepseek.dshremote.data.relay.TunnelHttp
import com.deepseek.dshremote.data.store.Outbox
import com.deepseek.dshremote.data.store.PendingTurn
import com.deepseek.dshremote.data.store.SessionCache
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** 任务/动态页用的一条实时事件（工具调用与轮次状态）。 */
data class FeedItem(
    val sessionId: String,
    val seq: Long,
    val at: Long,
    val kind: String,
    val text: String,
    val isError: Boolean = false,
)

/** 配对结果（供 UI 展示服务器名与隧道地址）。 */
data class PairOutcome(
    val settings: ConsoleSettings,
    val relayName: String,
    val health: RelayHealth?,
)

/** 续聊结果：在线已受理，或离线排队。 */
data class SendOutcome(val queued: Boolean, val accepted: TurnAccepted?)

/**
 * 远程控制台的唯一仓库：把中继隧道、v2 API、本地缓存与待发队列粘在一起。
 *
 * 线程模型（与 v1 的教训一致，见 BUILD.md §7.5）：
 * - **所有网络/磁盘调用都经过 [onIo]**；ViewModel 只读 StateFlow，永远在主线程；
 * - StateFlow 写入本身线程安全，因此 SSE 消费协程不会与 UI 动作互相覆盖。
 */
class ConsoleRepository(
    private val prefs: PrefsStore,
    val relay: RelayClient,
    private val tunnel: TunnelHttp,
    private val api: DshApiV2,
    private val relayHttp: RelayHttpClient,
    private val cache: SessionCache,
    private val outbox: Outbox,
    private val scope: CoroutineScope,
    /**
     * 会话图片的取字节入口（v2.9.0）。
     *
     * 默认值是"未接入"的空实现，为的是**不破坏既有单测的构造调用**：它们全用命名参数
     * 构造本类，多一个必填参数就等于把这些测试全部改一遍，而它们测的是完全无关的行为。
     * 生产路径由 [com.deepseek.dshremote.Graph] 注入
     * [com.deepseek.dshremote.data.api.AttachmentImageLoader]。
     */
    val images: ImageLoader = ImageLoader.None,
) {
    private val writeLock = Mutex()

    /**
     * 轮次索引的内存缓存（会话 id → 目录）。
     *
     * 用 `ConcurrentHashMap` 而不是 `writeLock`：读取发生在 UI 打开导航面板时，
     * 不该和"正在翻页的网络请求"抢同一把锁；写入只发生在 [loadTurnIndex] 回包之后。
     */
    private val turnIndexCache = java.util.concurrent.ConcurrentHashMap<String, TurnIndex>()

    private val _settings = MutableStateFlow<ConsoleSettings?>(null)
    val settings: StateFlow<ConsoleSettings?> = _settings.asStateFlow()

    private val _ready = MutableStateFlow(false)
    val ready: StateFlow<Boolean> = _ready.asStateFlow()

    val relayState: StateFlow<RelayState> = relay.state

    private val _online = MutableStateFlow(false)

    /** 隧道与 PC 都可用（PC 离线时为 false）。 */
    val online: StateFlow<Boolean> = _online.asStateFlow()

    private val _sessions = MutableStateFlow<List<SessionSummary>>(emptyList())
    val sessions: StateFlow<List<SessionSummary>> = _sessions.asStateFlow()

    private val _transcripts = MutableStateFlow<Map<String, List<ChatMessage>>>(emptyMap())
    val transcripts: StateFlow<Map<String, List<ChatMessage>>> = _transcripts.asStateFlow()

    /**
     * 分页窗口（m00002）。
     *
     * 不变量：**能往外暴露的对话记录只有窗口这一份**——[transcripts] 的每一条写入都必须
     * 走 [TranscriptPager]，否则就绕过了去重/裁剪/游标三条规则，窗口会重新长成"全量单页"。
     */
    private val pagers = HashMap<String, TranscriptPager>()

    /** 每会话一个锁：并发复用同一个 cursor 会取回重复页，用户看到"加载更早"点了没反应。 */
    private val pageLocks = HashMap<String, Mutex>()

    /**
     * 窗口世代号：**每次 [resetWindow] 自增**，用来作废在途的"更早页"请求。
     *
     * 为什么必须有：`cursor` 描述的是**服务端 offset**，而窗口一旦被 reset 换成"最新一页"，
     * 那个在途请求带回来的 offsets 与当前窗口之间很可能正好缺一段。并进来就是**永久空洞**
     * （游标还一路往更早走，SSE/turn.ended 只取最新页，空洞再也补不回来），
     * 而标题栏会谎报"已加载 X/Y 条"说窗口是连续的。
     *
     * 只在 [writeLock] 保护下读写。
     */
    private val windowEpochs = HashMap<String, Long>()

    /** [loadOlder] 抓到的"这次要给哪个窗口取页"的快照：游标 + 当时的 [windowEpochs]。 */
    private data class OlderRequest(val cursor: String, val epoch: Long)

    private val _transcriptSyncs = MutableStateFlow<Map<String, TranscriptSync>>(emptyMap())

    /** 每个会话的分页元信息（是否还有更早、已加载区间、总数），供 UI 显示"已加载 X/Y 条"。 */
    val transcriptSyncs: StateFlow<Map<String, TranscriptSync>> = _transcriptSyncs.asStateFlow()

    /**
     * 本地乐观消息（用户刚发出、服务端还没投影出来）。
     *
     * 必须单独留一份：`turn.ended`/强制刷新会 `reset` 窗口（因为 `hasMoreOlder` 只能以服务端
     * 那一页为准），而乐观消息**不在服务端投影里**，reset 会把用户刚打的字抹掉。
     * 等服务端投影里出现了同角色同内容的消息，就把它从这份名单里删掉（交给服务端权威数据）。
     */
    private val localMessages = HashMap<String, MutableList<ChatMessage>>()

    /**
     * 每条本地乐观消息**真正发出去的正文**（`sendTurn` 的 `prompt.trim()`）。
     *
     * 为什么需要单独记一份：气泡上显示的是 [echoText] 的产物（带图时是 `[N 张图片] 正文`），
     * 而服务端存下来的是**不带前缀的原始正文**。去重时拿"屏幕上那句"去比永远比不中（m00011），
     * 而反过来用前缀启发式从显示文案里反推正文又会误伤用户真手敲的 `[1 张图片] …`。
     * 记下原话就是**精确比较**：既不会漏合，也不可能把用户的话错认成回声而摘掉。
     *
     * 与 [localMessages] 同一把写锁下读写；`restoreLocalMessages` 采纳服务端投影时一起清理。
     */
    private val localClientTexts = HashMap<String, MutableMap<ChatMessage, String>>()

    private val _loadingOlder = MutableStateFlow<Set<String>>(emptySet())

    /** 正在加载更早消息的会话（UI 用它显示三态入口与去重）。 */
    val loadingOlder: StateFlow<Set<String>> = _loadingOlder.asStateFlow()

    /** 正在流式写入的助手消息（`turn.ended` 后由服务端权威数据替换）。 */
    private val _drafts = MutableStateFlow<Map<String, ChatMessage>>(emptyMap())
    val drafts: StateFlow<Map<String, ChatMessage>> = _drafts.asStateFlow()

    private val _feed = MutableStateFlow<List<FeedItem>>(emptyList())
    val feed: StateFlow<List<FeedItem>> = _feed.asStateFlow()

    private val _pending = MutableStateFlow<List<PendingTurn>>(emptyList())
    val pending: StateFlow<List<PendingTurn>> = _pending.asStateFlow()

    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private val _fromCache = MutableStateFlow(false)

    /** 当前展示的会话列表是否来自离线缓存（UI 要标注"离线快照"）。 */
    val fromCache: StateFlow<Boolean> = _fromCache.asStateFlow()

    private val _busySessions = MutableStateFlow<Set<String>>(emptySet())

    /** 本机刚发出、等待服务端确认的会话（输入框显示"发送中/停止"）。 */
    val busySessions: StateFlow<Set<String>> = _busySessions.asStateFlow()

    private val _nonResumable = MutableStateFlow<Set<String>>(emptySet())

    /**
     * 已**不可继续**的会话。
     *
     * 来源有两个（都是契约裁定）：
     * 1. `POST /abort` —— SDK 协议没有 cancel，停止等于杀掉进程，会话随之作废；
     * 2. `turn.ended` 事件里的 `resumable:false`。
     *
     * 命中后 UI 必须灰化输入框并提示"需要新建任务"，而不是让用户白打一段字再失败。
     */
    val nonResumable: StateFlow<Set<String>> = _nonResumable.asStateFlow()

    private val _workspaces = MutableStateFlow<List<WorkspaceSummary>>(emptyList())
    val workspaces: StateFlow<List<WorkspaceSummary>> = _workspaces.asStateFlow()

    private val _approvals = MutableStateFlow<Map<String, List<WireApprovals.ApprovalEntry>>>(emptyMap())

    /**
     * 每个会话当前**等在电脑端**的审批与提问（契约 §7.7）。
     *
     * 为什么按会话存 Map 而不是一个全局列表：详情页只关心"我这个会话有没有东西等我"，
     * 而 SSE 事件与 `?sessionId=` 过滤过的 REST 列表都是按会话来的 —— 两条来源在这里汇合，
     * 界面层不需要知道哪个条目是从哪条路进来的（[loadApprovals] 带 `sessionId` 时只覆盖该会话，不动别人的）。
     *
     * 注意语义：条目**不是**"已决定"，而是"还没人决定"。谁先答谁赢，所以它随时可能在
     * 下一次 SSE `approval.decided` 里消失 —— 界面必须能接受"我还没点它就不见了"。
     */
    val approvals: StateFlow<Map<String, List<WireApprovals.ApprovalEntry>>> = _approvals.asStateFlow()

    private val _approvalRevision = MutableStateFlow(0)

    /**
     * 审批状态**变化**信号的计数器（每次列表被 REST 或 SSE 改写就 +1）。
     *
     * 为什么不让界面直接 collect [approvals]：详情页要区分"收到了新条目"（可以提示）
     * 与"列表内容没变"（静默），Map 相等性判不出"同一条被重新下发"；
     * 计数器让"变过一次"这件事本身可观察，与 `scrollToNewestTick` 同一套理由。
     */
    val approvalRevision: StateFlow<Int> = _approvalRevision.asStateFlow()

    /** 审批桥诊断快照（解释"列表为什么是空的"）。 */
    private val _approvalState = MutableStateFlow(WireApprovals.BridgeState())
    val approvalState: StateFlow<WireApprovals.BridgeState> = _approvalState.asStateFlow()

    /** 网关**总线游标**（SSE `id:` 行）；续传与持久化都用它，不用事件的 DSH seq。 */
    @Volatile
    private var busCursor: Long = -1L

    @Volatile
    private var lastAutoRefreshAt: Long = 0L

    /** 每个会话已应用的事件 seq（防 SSE 重连后重复应用 delta 造成文字翻倍）。 */
    private val appliedSeq = HashMap<String, Long>()

    @Volatile
    private var streamJob: Job? = null

    /** 离线态自愈探测（见 [startRecoveryProbe]）。 */
    @Volatile
    private var recoveryJob: Job? = null

    init {
        scope.launch { _pending.value = onIo { outbox.load() } }
        scope.launch {
            prefs.settings.collect { latest ->
                val previous = _settings.value
                _settings.value = latest
                val switched = latest?.deviceToken != previous?.deviceToken ||
                    latest?.tunnelEndpoint != previous?.tunnelEndpoint
                if (latest == null) {
                    relay.disconnect()
                    relay.clearEndpoint()
                    _sessions.value = emptyList()
                    _feed.value = emptyList()
                    _drafts.value = emptyMap()
                    _nonResumable.value = emptySet()
                    appliedSeq.clear()
                    busCursor = -1L
                } else {
                    busCursor = latest.lastEventSeq
                    relay.setEndpoint(latest.tunnelEndpoint, latest.deviceToken, latest.deviceName)
                    if (switched || !relay.isConnected) relay.connect()
                }
                _ready.value = true
            }
        }
        scope.launch {
            relay.state.collect { state ->
                // 判定必须同时看"状态"和"真的有一条开着的隧道"：状态流在句柄断开后还会停在
                // `Connected` 一小会儿，只看状态值会把"隧道已经死了"当成在线（2026-10-15 模拟器
                // 实测：黑障后副标题一直挂着"电脑离线"清不掉，就是这个假在线在把 _online 顶回去）。
                _online.value = state is RelayState.Connected && state.homeOnline && relay.isConnected
                when (state) {
                    is RelayState.Connected -> {
                        startEventStream()
                        if (state.homeOnline) {
                            stopRecoveryProbe()
                            flushOutbox()
                        } else {
                            startRecoveryProbe()
                        }
                    }

                    is RelayState.Unauthorized -> {
                        stopEventStream()
                        stopRecoveryProbe()
                        _notice.value = "设备令牌已失效，请重新配对"
                    }

                    else -> {
                        stopEventStream()
                        // 只要拿不到可用隧道就挂上自愈探测，**不要求"之前在线过"**（2026-10-15 修）：
                        // 冷启动第一次连不上时（切网瞬间、弱网、代理未起）状态会一直停在 Connecting/
                        // Retrying，而 runLoop 的重连与 waitOnline 都是"请求驱动"的——用户不点就没人
                        // 再试，界面会一直挂着"电脑离线"直到下一次手动刷新。探测本身是幂等的轻量
                        // health 请求（1s→30s 退避），隧道一回来它就把在线态、事件流与待发队列一起拉起来。
                        startRecoveryProbe()
                    }
                }
            }
        }
        scope.launch {
            // 冷启动先用缓存把界面填上（离线也能看），再等网络结果覆盖
            val cached = onIo { cache.loadSessions() }
            if (cached.isNotEmpty() && _sessions.value.isEmpty()) {
                _sessions.value = cached
                _fromCache.value = true
            }
        }
    }

    // ---------- 线程约定 ----------

    /**
     * 所有网络/磁盘调用都必须离开主线程。
     *
     * 复刻 v1 的约定（BUILD.md §7.5）：ViewModel 用 `viewModelScope`（Main.immediate），
     * OkHttp 是同步阻塞调用，不切线程会抛 `NetworkOnMainThreadException`，
     * 外部表现就是"点了按钮毫无反应、网关上零请求"。
     */
    private suspend fun <T> onIo(block: suspend () -> T): T = withContext(Dispatchers.IO) { block() }

    private suspend fun <T> guarded(block: suspend () -> T): Result<T> = onIo { runCatching { block() } }

    /**
     * 用户主动触发的读操作：撞上**重连窗口**时先等一等，再原样重试一次。
     *
     * 判定与重试骨架在 [TunnelRetry]（纯逻辑，跑得了 JVM 单测）；这里只负责线程切换与日志。
     * 为什么必须有（2026-10-15 用户真机截图"刷新失败：电脑离线：中继隧道未连接…"）：
     * 手机走蜂窝网时隧道会被运营商 NAT 掐断（中继日志关闭原因 `code=1006 reason=socket`，
     * 真机一天 47 次），实测每 20s~4min 一次；重连耗时 8.9s~17.6s，**恰好落在重连窗口里的
     * 那次下拉刷新**会立刻拿到 `home_offline`，界面就把一次抖动报成了"电脑离线"。
     *
     * 等不到（[TUNNEL_WAIT_MS]）就把**原始错误**如实返回，界面照旧显示"电脑离线"，
     * 不会把"其实连不上"伪装成成功。
     */
    private suspend fun <T> tunnelTolerant(block: suspend () -> T): Result<T> = onIo {
        val result = TunnelRetry.withRetry(
            block = block,
            waitOnline = { relay.waitOnline(TUNNEL_WAIT_MS) },
            onWait = { Logger.i(TAG, "隧道暂不可用，等待重连（最多 ${TUNNEL_WAIT_MS}ms）后自动重试一次") },
            onResult = { retried ->
                if (retried.isSuccess) {
                    Logger.i(TAG, "隧道已恢复，重试成功")
                } else {
                    Logger.w(TAG, "重试仍失败：${retried.exceptionOrNull()?.message}")
                }
            },
        )
        // onResult 只在"真的等过又真的重试过"之后回调：走到这里说明这次请求刚经历了一次
        // 隧道抖动并成功了 → 立刻按在线处理，别等自愈探测的 1s→30s 退避
        if (result.isSuccess && !_online.value) recoverOnlineIfNeeded()
        result
    }

    /**
     * "这次请求真的打通了隧道" → 立刻当作在线，别等自愈探测慢慢退避。
     *
     * 触发场景（2026-10-15 模拟器实测）：黑障中下拉刷新 → 等待重连 → 重试成功，列表其实已经刷新，
     * 但副标题还挂着"· 电脑离线"，因为 `_online` 只由中继状态流与自愈探测改写，而探测当时可能正
     * 退避到 30s。用户看到的就是"列表回来了，但顶上还说电脑离线"。
     *
     * 只做幂等副作用，不改判定口径：`_online` 仍以"隧道可用且 PC 在线"为准。
     */
    private suspend fun recoverOnlineIfNeeded() {
        if (_online.value) return
        Logger.i(TAG, "隧道请求已成功 → 清除离线态，恢复事件流并补发待发队列")
        _online.value = true
        stopRecoveryProbe()
        startEventStream()
        flushOutbox()
    }

    fun consumeNotice() {
        _notice.value = null
    }

    // ---------- 配对 ----------

    /**
     * 配对：`POST /api/v2/pair/claim`（中继 HTTP；配对前没有令牌，走不了隧道）。
     *
     * 顺序：校验 → 换令牌 → 落库 → 连隧道 → 探测中继健康，任何一步失败都给出可见错误。
     */
    suspend fun pair(relayUrl: String, code: String, deviceName: String): Result<PairOutcome> = guarded {
        require(relayUrl.isNotBlank()) { "请先填写中继地址" }
        require(code.length == 6 && code.all { it.isDigit() }) { "配对码必须是 6 位数字" }
        val deviceId = prefs.deviceId()
        val claim: PairClaimV2 = relayHttp.pairClaim(relayUrl, code, deviceName, deviceId)
        // 契约裁定：`relay` 块存在与否 = 这台 PC 是否支持中继。缺了它就拿不到隧道凭据，
        // v2 传输根本无法建立，必须给出**指向 PC 配置**的明确提示，而不是笼统的"配对失败"。
        if (!claim.hasRelayBlock) {
            throw ApiException(
                code = "relay_disabled",
                message = "该电脑未启用中继（网关响应里没有 relay 块）：请在 PC 的 config.json 里打开 relay.enabled 并重连中继",
                httpStatus = 0,
            )
        }
        check(claim.effectiveDeviceToken.isNotEmpty()) { "中继没有返回设备令牌（relay.deviceToken 为空）" }
        // 中继宣告的隧道地址优先，但必须在手机侧可解析（见 RelayUrls.pickTunnelEndpoint）
        val endpoint = RelayUrls.pickTunnelEndpoint(
            advertised = claim.tunnelUrl,
            fallback = relayUrl,
            canResolve = { host -> canResolveHost(host) },
        )
        if (claim.tunnelUrl.isNotEmpty() && endpoint != claim.tunnelUrl) {
            Logger.w(TAG, "中继宣告的隧道地址不可用，回退到用户填写的中继地址（主机名不可解析）")
        }
        val saved = prefs.savePairing(claim, relayUrl, deviceName, tunnelEndpoint = endpoint)
        relay.disconnect()
        relay.setEndpoint(saved.tunnelEndpoint, saved.deviceToken, saved.deviceName)
        relay.connect()
        relay.awaitConnected(CONNECT_TIMEOUT_MS)
        val health = runCatching { relayHttp.health(relayUrl) }.getOrNull()
        PairOutcome(settings = saved, relayName = health?.relayName.orEmpty(), health = health)
    }

    /** 凭据失效后的重新配对：先清旧令牌，再走 [pair]。 */
    suspend fun repair(relayUrl: String, code: String, deviceName: String): Result<PairOutcome> {
        onIo { prefs.clear() }
        return pair(relayUrl, code, deviceName)
    }

    /** 解除本机配对（令牌与地址一起清掉）。 */
    suspend fun unpair() {
        stopRecoveryProbe()
        onIo { prefs.clear() }
        relay.disconnect()
        relay.clearEndpoint()
        _notice.value = "已解除本机配对"
    }

    /**
     * 吊销本机令牌：先调 `DELETE /api/v1/devices/{tokenId}`（让 PC 侧也失效），
     * 再清本地令牌——用户点"吊销"的意图是本机立刻不能再用。
     */
    suspend fun revokeSelf(): Result<String> = guarded {
        val current = _settings.value ?: throw ApiException("bad_request", "尚未配对")
        val tokenId = current.tokenId
        if (tokenId.isNotEmpty()) api.revokeDevice(tokenId)
        prefs.clear()
        relay.disconnect()
        relay.clearEndpoint()
        if (tokenId.isEmpty()) "已清除本机令牌（PC 侧无 tokenId，未执行远端吊销）" else "已吊销令牌 $tokenId 并断开连接"
    }

    /** 换中继地址（迁移/测试）：保留令牌，只改地址并重连。 */
    suspend fun setRelayUrl(url: String): Result<Unit> = guarded {
        require(url.isNotBlank()) { "中继地址不能为空" }
        prefs.updateRelayUrl(url)
        val current = prefs.current() ?: throw ApiException("bad_request", "尚未配对")
        relay.disconnect()
        relay.setEndpoint(url, current.deviceToken, current.deviceName)
        relay.connect()
    }

    /** 探测中继 `GET /health`（无需令牌，配对前也能用）。 */
    suspend fun probeRelay(relayUrl: String): RelayHealth = onIo { relayHttp.health(relayUrl) }

    /** 主机名能否在本机解析（配对时决定用中继宣告地址还是用户填写地址）。 */
    private fun canResolveHost(host: String): Boolean = runCatching {
        java.net.InetAddress.getByName(host)
        true
    }.getOrDefault(false)

    /** 网关健康 + 版本能力（经隧道；看 `supportedApiVersions` 而不是 `apiVersion`）。 */
    suspend fun probeGateway(): Result<com.deepseek.dshremote.data.api.GatewayHealth> =
        guarded { api.gatewayHealth() }

    /** 令牌存储方式说明（设置页展示"是否加密"）。 */
    fun secretStorageNote(): String = prefs.tokenStorageNote()

    /** 浅色降级开关（默认关闭）。 */
    suspend fun setLightTheme(enabled: Boolean) {
        onIo { prefs.setLightTheme(enabled) }
    }

    // ---------- 会话 ----------

    /**
     * 会话列表。
     *
     * `includeSubagent=false` 时服务端只回**顶层会话**（判据在网关 `lib/dsh-home.mjs` 的
     * `isDerivedSession`：origin=subagent / delegationDepth>0 / 有 parentSession 都算派生）；
     * `true` 时把派生的子智能体会话也取回来，并在本地回填父会话标题（[withParentTitles]），
     * 让「含子代理」打开后每个条目都能看出它属于哪个任务。
     *
     * 走 [tunnelTolerant]：下拉刷新正好落在隧道重连窗口里时会等一下再重试，不再直接报"电脑离线"。
     */
    suspend fun refreshSessions(includeSubagent: Boolean = false): Result<List<SessionSummary>> = tunnelTolerant {
        val list = api.sessions(includeSubagent = includeSubagent).withParentTitles().sortedByDescending { it.updatedAt }
        writeLock.withLock {
            _sessions.value = list
            _fromCache.value = false
        }
        cache.saveSessions(list)
        list
    }

    /**
     * 单会话元数据（会话详情页刷新标题/运行态用）。
     *
     * 这里**故意取全量**（含派生会话）：详情页可能是从「含子代理」列表点进来的，
     * 也可能是直接按 id 打开的（子代理会话本身仍可只读浏览），全量才不会让页面找不到自己。
     * 列表页显示的仍是顶层会话——`SessionsViewModel` 自己按 [SessionSummary.isSubagent] 过滤，
     * 所以这份含派生的快照不会让子智能体会话冒到列表里。
     */
    suspend fun refreshSession(sessionId: String): Result<SessionSummary?> = tunnelTolerant {
        val list = api.sessions(includeSubagent = true).withParentTitles().sortedByDescending { it.updatedAt }
        writeLock.withLock { _sessions.value = list }
        cache.saveSessions(list)
        list.firstOrNull { it.id == sessionId }
    }

    /**
     * 改电脑端会话权限（契约 §7.9，v2.11.0）。
     *
     * 成功时把网关回执的 `permission` **立刻**写回本地会话列表：详情页的权限那行与
     * 新建任务页都从同一份 `sessions` 读，等待下一次列表刷新会让用户看到"点完没反应"。
     * 失败原样返回（含旧网关 404 / 电脑端离线），由 ViewModel 翻译成可读文案。
     *
     * 走 [tunnelTolerant]：这是用户主动点的一下，撞上重连窗口时值得等一次重试。
     */
    suspend fun setSessionPermission(sessionId: String, preset: String): Result<SessionPermission> = tunnelTolerant {
        val permission = api.setSessionPermission(sessionId, preset)
        var updated: List<SessionSummary>? = null
        writeLock.withLock {
            val next = _sessions.value.map {
                if (it.id == sessionId) it.copy(permission = permission, updatedAt = now()) else it
            }
            _sessions.value = next
            updated = next
        }
        updated?.let { cache.saveSessions(it) }
        permission
    }

    /**
     * 新建手机任务（网关自有 DSH_HOME 的会话，契约 §7.2 的 SDK profile 驱动）。
     *
     * 端点：`POST /api/v2/tasks`（契约裁定：唯一新建入口），响应 202
     * `{sessionId, accepted, source, createdBy, driver, host, fromSeq, access}`。
     *
     * @param host 落在哪执行（契约 §4.2 的 `host`）：v2.1.0 起**缺省是电脑端**
     *   （[TaskHost.DESKTOP]），任务写进电脑端 DSH，电脑上也能看到并接管；
     *   [TaskHost.GATEWAY] 才在网关自己的 DSH_HOME 里用 SDK profile 起一轮。
     * @param access 权限档（契约 §4.2 的 `access`）：默认「仅当前工作区」。
     *   **只在 [TaskHost.GATEWAY] 下发给网关**——落在电脑端时权限跟随电脑端 DSH 自己的设置，
     *   手机端无法指定，带上反而是自欺欺人。
     * @param model 选定模型 id；null = 不指定，按执行端当前模型跑（回执里不会有 `modelApplied`）。
     * @param provider 模型的 provider；只有 [model] 非空才有意义（见 [buildCreateTaskPayload]）。
     */
    suspend fun createPhoneTask(
        workspace: String,
        prompt: String,
        title: String? = null,
        model: String? = null,
        access: TaskAccess = TaskAccess.DEFAULT,
        host: String = TaskHost.DESKTOP,
        provider: String? = null,
        reasoningEffort: String? = null,
    ): Result<CreateTaskOutcome> = guarded {
        require(workspace.isNotBlank()) { "请选择工作区" }
        val trimmed = prompt.trim()
        require(trimmed.isNotEmpty()) { "内容不能为空" }
        val payload = buildCreateTaskPayload(
            workspace = workspace,
            prompt = trimmed,
            title = title,
            model = model,
            access = accessForHost(access, host),
            host = TaskHost.fromWireOrNull(host) ?: TaskHost.DESKTOP,
            provider = provider,
            reasoningEffort = reasoningEffort,
        )
        val outcome = api.createPhoneTask(payload)
        refreshSessions()
        outcome
    }

    /**
     * 可选模型目录（`GET /api/v2/models`）。
     *
     * 失败**不弹窗、不报错**：模型选择是新建任务里的附加项，网关是旧版本时这个端点根本不存在
     * （客户端侧回 [ModelCatalog.UNKNOWN]，界面据此整块不画选择器）。隧道的瞬时抖动同理——
     * 不该因为它把「新建任务」主流程变成一个错误页。所以走 [tunnelTolerant]（用户正看着这一屏，
     * 撞上重连窗口时等一次重连），失败由调用方降级成一行内联说明。
     */
    suspend fun loadModels(): Result<ModelCatalog> = tunnelTolerant { api.modelCatalog() }

    /**
     * 加载对话记录（**首页 = 最新一页**，不再全量拉取）。
     *
     * @param force false 且本地已有 → 直接返回（省流量）；离线 → 给缓存（离线可看已读会话）。
     */
    suspend fun loadTranscript(sessionId: String, force: Boolean = false): Result<List<ChatMessage>> {
        if (!force && _transcripts.value[sessionId]?.isNotEmpty() == true) {
            return Result.success(_transcripts.value.getValue(sessionId))
        }
        val loaded = fetchPage(sessionId, limit = PAGE_SIZE, cursor = null)
        loaded.onSuccess { page -> resetWindow(sessionId, page) }
        return loaded.map { it.messages }
    }

    /**
     * 上拉加载**更早**的一页。
     *
     * 两处细节都是为了让"反复上拉"可靠：
     * 1. 同会话串行（[pageLocks]）——并发会用同一个 cursor 取回同一页；
     * 2. 已到最早 / 正在加载就直接返回——UI 的滚动监听会高频触发，不能靠界面去重兜底。
     */
    suspend fun loadOlder(sessionId: String): Result<List<ChatMessage>> {
        val lock = writeLock.withLock { pageLocks.getOrPut(sessionId) { Mutex() } }
        val request = lock.withLock {
            val pager = writeLock.withLock { pagers[sessionId] } ?: return Result.success(emptyList())
            if (_loadingOlder.value.contains(sessionId)) return Result.success(emptyList())
            val next = pager.state.nextCursor
            if (next.isNullOrEmpty()) return Result.success(emptyList())
            _loadingOlder.update { it + sessionId }
            // 记下"这一页是给哪个窗口取的"（见 [windowEpochs]）：请求在途期间窗口可能被
            // [resetWindow] 整个换掉（首屏加载 / 下拉刷新 / 强制刷新），或者被追新页
            // [mergeNewestPage] 裁掉最旧的一段，回来时必须认得出自己已经过期。
            OlderRequest(cursor = next, epoch = writeLock.withLock { windowEpochs[sessionId] ?: 0L })
        }
        val loaded = try {
            fetchPage(sessionId, limit = PAGE_SIZE, cursor = request.cursor)
        } finally {
            _loadingOlder.update { it - sessionId }
        }
        // 服务端回包的 `from`/`to` 必须自洽（`to - from == messages.length`）：`loadedFrom`/`loadedTo`
        // 是拿它推算的，一个不自洽的 `to` 会让"已加载 X/Y 条"和连续性判断一起失真。
        // 老网关/中间层可能整个不带这两个字段，这里补一个自洽的值再往下走。
        loaded.onSuccess { page -> normalizeOffsets(page)?.let { mergeOlderPage(sessionId, it, request.epoch) } }
        return loaded.map { it.messages }
    }

    // ---------- 轮次导航（v2.9.0 契约 §4.3） ----------

    /**
     * 跳到某一轮：把窗口换成"以这一轮回包结尾的一页"，并返回该页**最旧**的一条消息。
     *
     * 为什么是"换窗口"而不是"插一段历史进来"：这一轮可能离当前窗口很远（比如第 3 轮 vs
     * 当前第 40 轮），中间隔着上千条消息。把它们全拉进来既没必要（用户只是要看第 3 轮），
     * 又会撞上 600 条窗口上限，于是必然产生空洞。**换窗口**的语义是干净的：
     * 窗口 = 服务端那一页，往两头翻页的游标都由这一页给出，和首屏加载走完全同一条路径
     * （[resetWindow]，含 epoch 自增与本地乐观消息回填）。
     *
     * 返回**该轮的第一条消息**（找不到就用这一页最旧的一条）。界面要的是"滚到这一轮的顶部"：
     * `cursor = toIndex` 取回的是"结束于 toIndex 的 60 条"，而这一页的**最旧**一条通常比这一轮
     * 的开头更早（第 40 轮的第 60 条消息都在这一页里），所以锚点必须按 `turn` 号在页内找，
     * 不能直接拿 `messages.first()` —— 那会停在第 39 轮的尾巴上（差一轮，肉眼可见的错位）。
     *
     * @param turn 要定位的轮次号（页内按它找锚点）；null 时退化为"这一页最旧的一条"。
     * @return 成功时给出滚动锚点消息；失败原样上报（远端 400/404 会被界面翻成可读文案）。
     */
    suspend fun jumpToTranscript(
        sessionId: String,
        cursor: String,
        turn: Int? = null,
        limit: Int = PAGE_SIZE,
    ): Result<ChatMessage?> {
        val lock = writeLock.withLock { pageLocks.getOrPut(sessionId) { Mutex() } }
        // 全程持锁：与并发的 loadOlder 串行。两者都会改窗口，交错执行时
        // "取更早页"会照着旧边界取回一段 offsets（见 [windowEpochs] 的长期教训）。
        return lock.withLock {
            fetchPage(sessionId, limit = limit, cursor = cursor)
                .onSuccess { page -> resetWindow(sessionId, page) }
                .map { page ->
                    page.messages.firstOrNull { turn != null && it.turn == turn }
                        ?: page.messages.firstOrNull()
                }
        }
    }

    /**
     * 轮次索引：一跳转目录（每一轮的首尾消息下标 + 双方文字摘要）。
     *
     * 缓存策略是**手动作废**而不是 TTL：索引只在"新增一轮"时变化，而新增一轮必然会走到
     * [mergeNewestPage]（turn.ended 追新页）或 [sendTurn]；在这两处丢掉缓存即可，
     * 不需要定时器，也不会出现"刚刷新完还是旧目录"。
     */
    suspend fun loadTurnIndex(sessionId: String, force: Boolean = false): Result<TurnIndex> {
        if (!force) turnIndexCache[sessionId]?.let { return Result.success(it) }
        return onIo { runCatching { api.turnIndex(sessionId) } }.onSuccess { index ->
            turnIndexCache[sessionId] = index
        }
    }

    /** 让 `from`/`to` 与 `messages` 自洽：缺失（都为 0）或与条数对不上时按条数补齐，
     * 返回 null 表示这一页没有任何内容（没有内容就没有要并的东西，调用方直接跳过）。
     */
    private fun normalizeOffsets(page: TranscriptPage): TranscriptPage? {
        if (page.messages.isEmpty()) return null
        val count = page.messages.size
        if (page.to <= 0) return page.copy(from = 0, to = count)
        if (page.to - page.from != count) return page.copy(from = maxOf(0, page.to - count))
        return page
    }

    /** 离线时没有网络可翻页；在线时把一页读进来（失败原样上报，界面按错误提示处理）。 */
    private suspend fun fetchPage(sessionId: String, limit: Int, cursor: String?): Result<TranscriptPage> {
        if (!_online.value) {
            val cached = onIo { cache.loadTranscript(sessionId) }
            if (cached.isNotEmpty()) {
                // 离线回包是"整段缓存"而不是某一页，所以这里手工构造一个**没有更早页**的页：
                // `nextCursor = null` + 显式的 `cursorProvided = true` 合起来读作"服务端明确说已到最早"，
                // 于是上拉入口立刻变成「已到最早」。离线时这正是想要的 —— 网络不通，翻页只会白跑；
                // **不要**改成 `cursorProvided = false`：那会保留旧游标、入口常开，滚动监听每次都会
                // 白发一次 `loadOlder`（拿不到数据还一直转圈）。
                return Result.success(
                    TranscriptPage(
                        messages = cached,
                        nextCursor = null,
                        total = cached.size,
                        from = 0,
                        to = cached.size,
                        cursorProvided = true,
                    ),
                )
            }
        }
        return onIo { runCatching { api.transcriptPage(sessionId, limit = limit, cursor = cursor) } }
    }

    private suspend fun resetWindow(sessionId: String, page: TranscriptPage) {
        val snapshot = writeLock.withLock {
            val pager = pagers.getOrPut(sessionId) { TranscriptPager() }
            // 换窗口 = 作废所有在途的"更早页"请求。自增 epoch 之后，`loadOlder` 里已经发出去的
            // 请求回来时会发现 epoch 变了，于是整页丢弃（见 [mergeOlderPage]）。
            // 没有这一步的后果是实测出来的（页大小 60、会话 220 条）：
            // 窗口 offsets 100..160（游标 "100"）→ 上拉触发 loadOlder（在途，取 40..100）→
            // 用户点刷新 ⇒ 窗口只剩 161..220（游标 "160"）→ 在途回包落地（ADVANCE 40 < 160 收下）
            // ⇒ 窗口 = seq 41..100 ∪ 161..220，**中间的 101..160 永久丢失**（SSE 与 turn.ended
            // 只取最新一页，游标还一路往更早走），而标题栏谎报「已加载 120/220」。
            windowEpochs[sessionId] = (windowEpochs[sessionId] ?: 0L) + 1L
            // 强制刷新（turn.ended / 下拉刷新）改走 reset：`hasMoreOlder` 必须以服务端这一页为准，
            // 否则上一轮的游标会把"其实已经没有更早"判成还有，入口一直转圈。
            pager.reset(page)
            restoreLocalMessages(sessionId, pager, page)
            publish(sessionId, pager)
            pager.messages
        }
        if (snapshot.isNotEmpty()) cache.saveTranscript(sessionId, snapshot)
    }

    /**
     * reset 之后把本地乐观消息补回窗口，并顺手清理已经被服务端投影接管的那些。
     *
     * 服务端一投影出来就删本地副本，是**必需的**而不是洁癖：两者内容相同但 seq 不同，
     * 留着就是屏幕上并排两条一模一样的话。
     *
     * 判据是 [isSameEcho]（带图回合要按 `[N 张图片]` 归一化后比，m00011）；
     * 且"补回来"这个动作必须落在**同一个窗口 key** 上才安全 —— 见 [TranscriptPager.keyOf]
     * 关于合成 key 分配幂等的说明，否则每补一次就多一行。
     */
    private fun restoreLocalMessages(sessionId: String, pager: TranscriptPager, page: TranscriptPage) {
        val clientTexts = localClientTexts[sessionId]
        val stillLocal = localMessages.getOrPut(sessionId) { mutableListOf() }.filterNot { local ->
            page.messages.any { server -> isSameEcho(server, local, clientTexts?.get(local)) }
                .also { adopted -> if (adopted) pager.removeLocal(local) }
        }
        localMessages[sessionId] = stillLocal.toMutableList()
        // 被服务端权威投影接管的那几条，连同"原话"一起清掉，别让两份记账各自漂移
        if (clientTexts != null) {
            val adopted = localMessages.getValue(sessionId)
            clientTexts.keys.retainAll { candidate -> adopted.any { it === candidate } }
            if (clientTexts.isEmpty()) localClientTexts.remove(sessionId)
        }
        stillLocal.forEach { pager.upsert(it) }
    }

    private suspend fun mergeOlderPage(sessionId: String, page: TranscriptPage, epoch: Long) {
        writeLock.withLock {
            // 在途期间窗口被换过（resetWindow：首屏加载 / 下拉刷新 / 强制刷新），或者追新页把最旧的
            // 若干条裁掉了（mergeNewestPage 的 trimOldest）⇒ 这一页属于上一个窗口，直接丢弃：
            // 它的 offsets 与新窗口之间很可能正好缺一段，并进来就是**永久空洞**（见 §11.2 的 D6/D7）。
            // 丢弃是安全的：新窗口自己带着服务端给的游标，"加载更早"从头再来一遍即可。
            if ((windowEpochs[sessionId] ?: 0L) != epoch) return
            val pager = pagers.getOrPut(sessionId) { TranscriptPager() }
            // 用户正在往上看：超容量时裁**最新**，不能把眼前的裁掉。
            // ADVANCE：游标必须一路往更早走，否则「加载更早」会重复请求同一页（见 TranscriptPager.pickNextCursor）。
            pager.merge(page, TranscriptPager.CursorPolicy.ADVANCE, trimOldest = false)
            publish(sessionId, pager)
        }
    }

    private fun publish(sessionId: String, pager: TranscriptPager) {
        _transcripts.value = _transcripts.value + (sessionId to pager.messages)
        _transcriptSyncs.value = _transcriptSyncs.value + (sessionId to pager.state)
    }

    /**
     * 追新一页：把"最新一页"合并进窗口（`trimOldest = true`，超容量时丢最旧的）。
     *
     * 与 [loadTranscript] 的区别是**不清窗口**——用户可能正翻在中间，"有新消息"不应该
     * 把他弹回底部，也不应该把他已经翻出来的历史丢掉。
     *
     * PRESERVE 的理由：这一页在窗口的"另一头"，直接采纳它的 `nextCursor` 会把"更早"的起点
     * 推到窗口上界之外，窗口与自己下方那段历史之间就出现永远取不回来的断档。
     */
    private suspend fun mergeNewestPage(sessionId: String, page: TranscriptPage) {
        writeLock.withLock {
            val pager = pagers.getOrPut(sessionId) { TranscriptPager() }
            pager.merge(page, TranscriptPager.CursorPolicy.PRESERVE, trimOldest = true)
            // 只有**真的裁掉了最旧的一段**时才作废在途的"更早页"（见 §11.2 的 D7）：
            // 窗口满（默认 600 条，真机翻过 10 页以上）以后，这次追新会把最旧若干条挤出窗口，
            // 而在途的更早页是照着"挤出前"的边界取的 offsets，落进来正好缺一段 ⇒ 永久空洞。
            // 作废的代价只是用户那一次上拉白做（游标还在，再拉一次即回来），
            // 远轻于"中间永久少 60 条 + 标题栏谎报已加载条数"。
            if (pager.state.trimmedOlder) {
                windowEpochs[sessionId] = (windowEpochs[sessionId] ?: 0L) + 1L
            }
            restoreLocalMessages(sessionId, pager, page)
            publish(sessionId, pager)
        }
        // 追新页意味着"可能多了一轮"，轮次目录随之过期。放在锁外：缓存是 ConcurrentHashMap。
        turnIndexCache.remove(sessionId)
    }

    /**
     * 续聊：在线直接发；离线/隧道断则入队，隧道恢复后自动补发（幂等靠 clientTurnId）。
     *
     * [images] 非空的四条额外规则（图片不进 Outbox 是硬约束）：
     * 1. **离线直接失败**，并把"离线时不发图"说清楚 —— 静默丢图比报错糟得多；
     * 2. `trimmed` 为空但**有图**时放行（"只发图片"是合法用法，占位文本由网关补），
     *    这在历史上是 `内容不能为空` 的失败分支；
     * 3. 请求体只在**当次**构造，图片字节不进 [outbox]（900 KiB 的 base64 存不下也不该存）；
     * 4. 断线重试**不自动入队**：只发图片的请求没有可重放的文字，进队列等于发一条空请求。
     *
     * 整包预算（1 MiB 请求体）**不在这里判**，而是留在 [DshApiV2.postTurn] 里：
     * 只有那里能拿到最终序列化后的 body 长度，判定依据与实际发出的字符串是同一个；
     * 在这里另写一份估算会让"两处阈值各说各话"（而且这个类需要 Android Context，
     * 判据留在这里就没法单测）。超预算时 postTurn 抛 [DshApiV2.BudgetExceededException]，
     * 经 [guarded] 变成 [Result.failure]，用户看到的是"请减少张数或压缩后再发"。
     */
    suspend fun sendTurn(
        sessionId: String,
        prompt: String,
        images: List<PendingImage> = emptyList(),
    ): Result<SendOutcome> {
        val trimmed = prompt.trim()
        if (trimmed.isEmpty() && images.isEmpty()) return Result.failure(IllegalArgumentException("内容不能为空"))
        if (images.isNotEmpty() && !_online.value) {
            return Result.failure(IllegalArgumentException(IMAGE_OFFLINE_MESSAGE))
        }
        val clientTurnId = UUID.randomUUID().toString()
        if (!_online.value) {
            val queued = onIo {
                outbox.enqueue(PendingTurn(sessionId, trimmed, clientTurnId, System.currentTimeMillis()))
            }
            _pending.value = queued
            appendLocalUserMessage(sessionId, trimmed)
            return Result.success(SendOutcome(queued = true, accepted = null))
        }
        _busySessions.update { it + sessionId }
        appendLocalUserMessage(sessionId, localEchoText(trimmed, images), trimmed)
        val result = guarded { api.postTurn(sessionId, trimmed, clientTurnId, images) }
        _busySessions.update { it - sessionId }
        return result.fold(
            onSuccess = { accepted ->
                markLive(sessionId, true)
                // 刚发出去的一轮马上会多出来：现在就丢掉旧目录，导航面板下次打开必是新的
                turnIndexCache.remove(sessionId)
                Result.success(SendOutcome(queued = false, accepted = accepted))
            },
            onFailure = { error ->
                if (images.isEmpty() && isConnectivityError(error)) {
                    // 隧道正好断了：排队而不是把用户写的内容丢掉
                    val queued = onIo {
                        outbox.enqueue(PendingTurn(sessionId, trimmed, clientTurnId, System.currentTimeMillis()))
                    }
                    _pending.value = queued
                    Result.success(SendOutcome(queued = true, accepted = null))
                } else {
                    Result.failure(error)
                }
            },
        )
    }

    /**
     * 本地乐观消息的文案：有图时把"[N 张图片]"标出来。
     *
     * 为什么必须标：图片本体**不上行到 transcript**（服务端只存文字），
     * 不标的话用户看到的就是一条空白气泡，会以为图丢了。
     *
     * 放在伴生对象里是为了能纯 JVM 单测（不需要 Context）：它是"发出去之后用户看到什么"
     * 的唯一判据，靠起一个真仓库去测等于把单测拖进 Android 环境。
     */
    private fun localEchoText(prompt: String, images: List<PendingImage>): String =
        echoText(prompt, images.size)

    suspend fun abortTurn(sessionId: String): Result<Unit> = guarded {
        val accepted = api.abortTurn(sessionId)
        markLive(sessionId, false)
        _busySessions.update { it - sessionId }
        // 停止 = 杀进程：契约裁定响应会带 resumable:false；老网关不发该字段时按"不可继续"处理，
        // 因为误导用户继续输入、然后必然失败，比多一句提示更糟。
        if (accepted.resumable != true) {
            _nonResumable.update { it + sessionId }
        }
    }

    // ---------- 审批 / 提问（契约 §7.7）----------

    /**
     * 拉取未决的审批与提问（`GET /api/v2/approvals`，可选 `?sessionId=` 过滤）。
     *
     * [sessionId] 非空时**只覆盖该会话**在本地状态里的那一条：列表端点按会话过滤，
     * 用它去整体替换会顺手抹掉别的会话的条目（那些条目只能靠 SSE 再等回来）。
     *
     * 响应整份解析不出来（老网关没有这个路由 / 返回非 JSON）按失败处理，并把原因写进
     * [notice]，因为"列表是空的"和"这个网关根本没有这条通道"对用户是两件事。
     */
    suspend fun loadApprovals(sessionId: String? = null): Result<List<WireApprovals.ApprovalEntry>> = guarded {
        val response = api.approvals(sessionId)
            ?: throw ApiException(code = "bad_response", message = "审批列表响应无法解析（网关可能不支持该端点）")
        _approvalState.value = response.state
        if (sessionId.isNullOrEmpty()) {
            _approvals.value = response.approvals.groupBy { it.sessionId.orEmpty() }
        } else {
            _approvals.update { it + (sessionId to response.approvals) }
        }
        _approvalRevision.update { it + 1 }
        response.approvals
    }

    /**
     * 提交手机端的答案（审批结论 / 提问回答 / 弃权）。
     *
     * [bodyJson] 必须由 [WireApprovals] 的编码函数生成——形状的坑（`custom` 不是 `text`、
     * `selected` 必须是数组）在那边集中处理。
     *
     * 两个刻意的设计：
     * 1. 提交成功后**立刻**把条目从本地移除（不等 SSE）：用户点了按钮，界面必须马上有反应；
     *    随后再拉一次列表对账，因为同一条请求可能已经在电脑端被答过（谁先答谁赢）。
     * 2. 成败都不抛异常，返回 [Result]；`not_found` / `approval_expired` 由调用方用
     *    [WireApprovals.alreadyDecided] 翻译成"它已经不在了"，而不是一句红色报错 ——
     *    这不是用户操作失误，是这条请求本来就可能被电脑端先答掉。
     */
    suspend fun submitApproval(eventId: String, bodyJson: String, sessionId: String? = null): Result<Boolean> {
        val result = guarded { api.submitApproval(eventId, bodyJson) }
        result.onSuccess {
            removeApproval(eventId)
            Logger.i(TAG, "审批/提问已由手机提交 eventId=${eventId.take(24)}")
        }
        // 无论如何都对账一次：成功要对账（可能已被别人答过）、失败也要（条目可能已消失）
        val key = sessionId ?: _approvals.value.entries.firstOrNull { entry ->
            entry.value.any { it.eventId == eventId }
        }?.key
        loadApprovals(key)
        return result.map { true }
    }

    /** 主动把一条未决请求从本地列表移除（提交成功，或收到 `approval.decided`）。 */
    private suspend fun removeApproval(eventId: String) = onIo {
        _approvals.update { current ->
            if (current.values.none { list -> list.any { it.eventId == eventId } }) return@update current
            current.mapValues { (_, list) -> list.filterNot { it.eventId == eventId } }
        }
        _approvalRevision.update { it + 1 }
    }

    /** 把 SSE 上"有人问了"的条目并进本地列表（同一 `eventId` 覆盖，不做重复卡片）。 */
    private suspend fun upsertApproval(entry: WireApprovals.ApprovalEntry) = onIo {
        val key = entry.sessionId.orEmpty()
        _approvals.update { current ->
            val list = current[key].orEmpty().filterNot { it.eventId == entry.eventId }
            // 新的排前面：界面取第一条渲染，最新等在电脑上的那件事最该被看到
            current + (key to (listOf(entry) + list))
        }
        _approvalRevision.update { it + 1 }
    }

    /** 补发待发队列（隧道恢复时自动调用，也可由用户手动触发）。 */
    fun flushOutbox() {
        scope.launch {
            val queued = _pending.value
            if (queued.isEmpty() || !_online.value) return@launch
            for (turn in queued) {
                val result = runCatching { onIo { api.postTurn(turn.sessionId, turn.prompt, turn.clientTurnId) } }
                result.fold(
                    onSuccess = {
                        _pending.value = onIo { outbox.remove(turn.clientTurnId) }
                        markLive(turn.sessionId, true)
                        Logger.i(TAG, "待发请求已补发 session=${turn.sessionId.take(20)}")
                    },
                    onFailure = { error ->
                        if (isConnectivityError(error)) {
                            Logger.w(TAG, "待发请求补发失败（隧道不可用），保留在队列中")
                            return@launch
                        }
                        val left = onIo { outbox.markAttempt(turn.clientTurnId) }
                        _pending.value = left
                        val attempt = left.firstOrNull { it.clientTurnId == turn.clientTurnId }?.attempts ?: 1
                        if (attempt >= Outbox.MAX_ATTEMPTS) {
                            _pending.value = onIo { outbox.remove(turn.clientTurnId) }
                            _notice.value = "有一条待发送请求连续失败，已放弃：${error.message.orEmpty()}"
                        }
                    },
                )
            }
        }
    }

    suspend fun clearOutbox() {
        _pending.value = onIo { outbox.clear() }
    }

    fun dismissPending(clientTurnId: String) {
        scope.launch { _pending.value = onIo { outbox.remove(clientTurnId) } }
    }

    // ---------- 工作区 ----------

    /**
     * 工作区列表。
     *
     * 同样走 [tunnelTolerant]：手机任务页打开时会立刻拉一次工作区，若正好撞上重连窗口，
     * 列表空着会让「新建任务」没法选工作区——用户看到的是"点了没反应"。
     */
    suspend fun loadWorkspaces(): Result<List<WorkspaceSummary>> = tunnelTolerant {
        val list = api.workspaces()
        _workspaces.value = list
        list
    }

    /**
     * 从绝对路径反推它属于哪个白名单工作区（网关契约 §4.3 的 `?workspace=`）。
     *
     * 为什么必须有这道：网关在缺 `?workspace=` 时回落到 defaultWorkspace，随后拿
     * 「默认工作区的根」去装「另一个白名单工作区里的绝对路径」，词法包含必然失败，
     * 于是 403 workspace_outside（实测文案 `路径越界（不在工作区内）：D:\Workspace\插件`）。
     * 工作区列表是 [loadWorkspaces] 刚拉回来的（就是用户在界面上选的同一份），
     * 取**最长匹配**：白名单里可能同时有 `D:\ws` 与 `D:\ws\sub`。
     *
     * 返回 null 时不发该参数，保持改动前的行为（网关侧另有反推兜底）。
     */
    private fun workspaceFor(path: String?): String? {
        val target = path?.trim().orEmpty()
        if (target.isEmpty()) return null
        return _workspaces.value
            .map { it.path }
            .filter { it.isNotBlank() && WorkspacePaths.isInside(it, target) }
            .maxByOrNull { it.length }
    }

    suspend fun loadEntries(path: String?, depth: Int = 1, showHidden: Boolean = false): Result<DirListing> =
        guarded { api.entries(path, depth, showHidden, workspace = workspaceFor(path)) }

    suspend fun loadFile(path: String): Result<FileContent> =
        guarded { api.file(path, workspace = workspaceFor(path)) }

    suspend fun loadChanges(workspace: String): Result<ChangeSet> =
        guarded { api.changes(workspace, workspace = workspaceFor(workspace)) }

    suspend fun loadDiff(workspace: String, file: String): Result<com.deepseek.dshremote.data.api.DiffResult> =
        guarded { api.diff(workspace, file, workspace = workspaceFor(workspace)) }

    suspend fun search(query: String, workspace: String?): Result<List<SearchHit>> =
        guarded { api.search(query, workspace, workspace = workspaceFor(workspace)) }

    suspend fun clearCache() {
        onIo { cache.clear() }
        _notice.value = "已清除本地离线缓存"
    }

    // ---------- SSE 增量流 ----------

    /**
     * 启动会话事件流（SSE over 隧道）。
     *
     * 断线重连由本方法自己的退避循环负责：隧道恢复后自动重新订阅，并用
     * `fromSeq` 续传（契约 §4.2）。重复投递由 [appliedSeq] 去重，
     * 因此"网络抖一下"既不会丢消息，也不会让同一条 delta 应用两次。
     */
    private fun startEventStream() {
        if (streamJob?.isActive == true) return
        streamJob = scope.launch {
            val backoff = ReconnectBackoff()
            while (isActive) {
                if (!_online.value) {
                    delay(STREAM_IDLE_POLL_MS)
                    continue
                }
                try {
                    api.sessionEvents(
                        fromSeq = busCursor.takeIf { it >= 0 },
                        lastEventId = null,
                        onCursor = { cursor -> busCursor = maxOf(busCursor, cursor) },
                    )
                        .collect { event -> applyEvent(event) }
                    backoff.reset()
                    delay(STREAM_RETRY_DELAY_MS)
                } catch (t: Throwable) {
                    if (t is CancellationException) throw t
                    val delayMs = backoff.nextDelayMs()
                    Logger.w(TAG, "会话事件流中断（${t.message}），${delayMs}ms 后续传")
                    delay(delayMs)
                }
                onIo { runCatching { prefs.saveEventSeq(busCursor) } }
            }
        }
    }

    private fun stopEventStream() {
        streamJob?.cancel()
        streamJob = null
    }

    /**
     * 离线态**自愈探测**（Lead 裁定的恢复策略 A）。
     *
     * 背景：中继在 home 掉线时会推 `notice{home_offline}`，恢复时会推 `home_online`；
     * 但"通知"可能丢失、也可能在重连窗口里被错过。如果离线后 App 什么请求都不发，
     * 就**永远等不到恢复的证据**（实测表现为：PC 侧 6 秒就回来了，手机却一直显示离线）。
     *
     * 因此离线态下按 1s→30s 退避周期性地经隧道打一个轻量探针（`GET /api/v1/health`）：
     * 一旦成功就清除离线态、刷新列表、补发离线期间排队的续聊。通知只是"加速"，不是唯一路径。
     */
    private fun startRecoveryProbe() {
        if (recoveryJob?.isActive == true) return
        if (_settings.value == null) return
        recoveryJob = scope.launch {
            val backoff = ReconnectBackoff()
            Logger.i(TAG, "进入离线态：启动自愈探测（1s→30s 退避）")
            while (isActive && !_online.value) {
                delay(backoff.nextDelayMs())
                if (_online.value) break
                val healthy = runCatching { onIo { api.gatewayHealth() } }.isSuccess
                if (healthy) {
                    Logger.i(TAG, "自愈探测成功：网关已恢复，清除离线态")
                    _online.value = true
                    refreshSessions()
                    flushOutbox()
                    startEventStream()
                    break
                }
            }
        }
    }

    private fun stopRecoveryProbe() {
        recoveryJob?.cancel()
        recoveryJob = null
    }

    /** 把一条 SSE 事件合并进本地状态。 */
    private suspend fun applyEvent(event: ConsoleEvent) {
        val seq = event.seq
        val sessionId = event.sessionId
        if (seq != null && sessionId.isNotEmpty()) {
            val applied = appliedSeq[sessionId] ?: -1L
            if (seq <= applied) {
                Logger.d(TAG, "跳过重复事件 seq=$seq session=${sessionId.take(16)}")
                return
            }
            appliedSeq[sessionId] = seq
        }
        // 注意：**不**把 data.seq 当成总线游标（gateway-dev 裁定：id: 行才是总线游标，
        // data.seq 是 DSH 事件序号）；总线游标由 sessionEvents(onCursor=…) 推进。

        when (event) {
            is ConsoleEvent.SessionUpdated -> {
                // source 未知（未来新增取值）时也只当成"状态变了"，不做任何假设、不报错
                if (_sessions.value.none { it.id == event.sessionId }) {
                    scheduleAutoRefresh()
                } else {
                    _sessions.value = _sessions.value.map {
                        if (it.id == event.sessionId) {
                            it.copy(
                                // 权限广播只带 `permission`（没有 live/updatedAt）：不能因为缺字段
                                // 就把一个正在跑的会话在列表里"熄灭"（event.live 缺省 false）。
                                live = if (event.permission != null && event.updatedAt == 0L) it.live else event.live,
                                updatedAt = maxOf(it.updatedAt, event.updatedAt),
                                // 权限事件可能来自另一台手机/网页：直接覆盖，别等下一次列表刷新。
                                permission = event.permission ?: it.permission,
                            )
                        } else {
                            it
                        }
                    }.sortedByDescending { it.updatedAt }
                }
            }

            is ConsoleEvent.SessionCreated -> scheduleAutoRefresh()

            is ConsoleEvent.TurnStarted -> {
                // 电脑端一轮会来两条 turn.started（桌面端真实事件 + 网关 202 回执）：
                // 会话状态靠 markLive 覆盖，天然幂等；活动流按「本来就在跑」去重，避免两条「第 N 轮开始」。
                val wasLive = _sessions.value.any { it.id == event.sessionId && it.live }
                markLive(event.sessionId, true)
                if (!wasLive) {
                    pushFeed(FeedItem(event.sessionId, event.fromSeq, now(), "turn", "第 ${event.turn} 轮开始"))
                }
            }

            is ConsoleEvent.MessageDelta -> appendDelta(event)

            is ConsoleEvent.ToolCallStarted -> {
                appendToolCall(event)
                pushFeed(
                    FeedItem(
                        event.sessionId,
                        event.seq ?: 0L,
                        now(),
                        "tool",
                        "${event.name} ${ToolCallSummary.summarize(event.name, event.argsJson)}",
                    ),
                )
            }

            is ConsoleEvent.ToolResultReady -> {
                completeToolCall(event)
                pushFeed(
                    FeedItem(
                        sessionId = event.sessionId,
                        seq = event.seq ?: 0L,
                        at = now(),
                        kind = "result",
                        text = event.result.replace('\n', ' ').take(120),
                        isError = event.isError,
                    ),
                )
            }

            is ConsoleEvent.TurnEnded -> {
                markLive(event.sessionId, false)
                _busySessions.update { it - event.sessionId }
                // resumable=false ⇒ 该会话已不可继续（被 abort 杀掉进程）；true/缺省 ⇒ 可以继续
                when (event.resumable) {
                    false -> _nonResumable.update { it + event.sessionId }
                    true -> _nonResumable.update { it - event.sessionId }
                    null -> Unit
                }
                pushFeed(
                    FeedItem(
                        event.sessionId,
                        busCursor,
                        now(),
                        "turn_end",
                        "第 ${event.turn} 轮结束（${event.reason}）" +
                            if (event.resumable == false) " · 会话已不可继续" else "",
                    ),
                )
                // 轮次结束后用服务端权威数据覆盖草稿，保证屏幕与磁盘一致。
                // 注意这里只取**最新一页**（旧实现是全量拉取，长会话等于每轮把上千条重下一遍）；
                // 用户已经翻出来的更早历史保留在窗口里，不会被这次刷新清掉（见 mergeNewestPage）。
                scope.launch {
                    val latest = fetchPage(event.sessionId, limit = PAGE_SIZE, cursor = null)
                    latest.onSuccess { page -> mergeNewestPage(event.sessionId, page) }
                    _drafts.update { it - event.sessionId }
                    refreshSessions()
                }
            }

            // ---------- 审批 / 提问（契约 §7.7）----------

            is ConsoleEvent.ApprovalAsked -> {
                // 桌面端重连后会重播未决帧，网关按 eventId 去重；本地再 upsert 一次，
                // 保证"同一件事只有一张卡"（重复下发不该让用户看到两条一样的审批）。
                upsertApproval(event.entry)
            }

            is ConsoleEvent.ApprovalDecided -> {
                // `by:'phone'` 可能是本机（此时本地已移除，幂等）；`by` 不是 phone 或为 null
                // 表示**电脑端自己答掉了** —— 用户还没点按钮，卡片就该消失。
                removeApproval(event.eventId)
                pushFeed(
                    FeedItem(
                        sessionId = event.sessionId,
                        seq = busCursor,
                        at = now(),
                        kind = "approval",
                        text = if (event.by == "phone") "审批已由手机应答" else "审批已在电脑端决定",
                    ),
                )
            }

            is ConsoleEvent.ApprovalExpired -> {
                removeApproval(event.eventId)
                pushFeed(
                    FeedItem(
                        sessionId = event.sessionId,
                        seq = busCursor,
                        at = now(),
                        kind = "approval",
                        text = "审批已过期，电脑端那一轮仍在等待（网关只做记账）",
                        isError = true,
                    ),
                )
            }

            is ConsoleEvent.Heartbeat -> Unit

            is ConsoleEvent.Unknown -> Logger.d(TAG, "未知会话事件 ${event.name}")
        }
    }

    private fun appendDelta(event: ConsoleEvent.MessageDelta) {
        _drafts.update { drafts ->
            val merged = LiveDraftMerge.delta(
                existing = drafts[event.sessionId],
                seq = event.seq,
                role = event.role,
                text = event.text,
                channel = event.channel,
                reasoning = event.reasoning,
                messageBoundary = event.messageBoundary,
                at = now(),
            )
            drafts + (event.sessionId to merged)
        }
    }

    private fun appendToolCall(event: ConsoleEvent.ToolCallStarted) {
        _drafts.update { drafts ->
            val merged = LiveDraftMerge.toolStarted(
                existing = drafts[event.sessionId],
                seq = event.seq,
                name = event.name,
                argsJson = event.argsJson,
                at = now(),
            )
            drafts + (event.sessionId to merged)
        }
    }

    private fun completeToolCall(event: ConsoleEvent.ToolResultReady) {
        _drafts.update { drafts ->
            val merged = LiveDraftMerge.toolResult(
                existing = drafts[event.sessionId],
                result = event.result,
                isError = event.isError,
            ) ?: return@update drafts
            drafts + (event.sessionId to merged)
        }
    }

    /**
     * 本地乐观插入用户消息。
     *
     * `seq = 0` 是**约定**而不是偷懒：服务端 seq 恒为正，[TranscriptPager] 据此给本地消息在窗口
     * 内部另发合成 key（排在所有真实 seq 之后，对外仍报 0）。这里不再"拿末条 seq + 1"——
     * 那个假正数会和服务端真实 seq 撞上，
     * 一旦撞了（正是原来 LazyColumn 不设 key 的原因）分页的去重/裁剪就无从判断谁是谁。
     */
    private suspend fun appendLocalUserMessage(sessionId: String, prompt: String, clientText: String = prompt) {
        writeLock.withLock {
            val message = ChatMessage(seq = 0L, role = "user", at = now(), text = prompt)
            localMessages.getOrPut(sessionId) { mutableListOf() }.add(message)
            // 记住"用户真正发出去的原话"：带图时 [prompt] 是 `[N 张图片] …`，
            // 而服务端存的是这份不含前缀的正文（去重判据 [isSameEcho] 靠它做精确比较）。
            localClientTexts.getOrPut(sessionId) { mutableMapOf() }[message] = clientText
            val pager = pagers.getOrPut(sessionId) { TranscriptPager() }
            pager.upsert(message)
            publish(sessionId, pager)
        }
    }

    private fun pushFeed(item: FeedItem) {
        _feed.value = (listOf(item) + _feed.value).take(FEED_LIMIT)
    }

    /**
     * 由 SSE 触发的会话列表刷新。
     *
     * 必须去抖：中继重连后网关会为**每个**会话补发 `session.updated`，
     * 不去抖会瞬间打出 N 个 `GET /api/v2/sessions`（实测 6 个会话 7 次请求），
     * 弱网下等于自己 DDoS 自己。
     */
    private fun scheduleAutoRefresh() {
        val now = System.currentTimeMillis()
        if (now - lastAutoRefreshAt < AUTO_REFRESH_MIN_INTERVAL_MS) return
        lastAutoRefreshAt = now
        scope.launch { refreshSessions() }
    }

    private fun markLive(sessionId: String, live: Boolean) {
        _sessions.value = _sessions.value.map {
            if (it.id == sessionId) it.copy(live = live, updatedAt = now()) else it
        }
    }

    private fun isConnectivityError(error: Throwable): Boolean = when (error) {
        is RelayException -> error.code in setOf("home_offline", "timeout", "aborted", "internal", "bad_request")
        is ApiException -> error.httpStatus == 0 || error.code == "home_offline"
        is IOException -> true
        else -> false
    }

    /** UI 判断"这条会话是否还在跑"（服务端 live 或本机刚发出的轮次）。 */
    fun isLive(sessionId: String): Boolean =
        _busySessions.value.contains(sessionId) || _sessions.value.any { it.id == sessionId && it.live }

    private fun now(): Long = System.currentTimeMillis()

    companion object {
        private const val TAG = "ConsoleRepository"

        /**
         * 离线带图发送的失败文案（**公开**：ViewModel 需要按同一句话识别"是离线拦下的"，
         * 从而把待发图片保留在输入区让用户重试，而不是当成普通失败弹一句红字）。
         */
        const val IMAGE_OFFLINE_MESSAGE: String = "离线时不能发送图片，请在网络恢复后重试"

        /**
         * 本地乐观消息的文案（纯函数，可单测）。
         *
         * 有图时前缀 `[N 张图片]`：图片本体不进 transcript，不标就是一条空白气泡。
         * 空 prompt【且】无图时返回空串——那条路径在 [sendTurn] 里已经被 `内容不能为空` 挡掉了，
         * 这里返回空串只是不给调用方留一个"看起来成功"的假消息。
         */
        internal fun echoText(prompt: String, imageCount: Int): String {
            if (imageCount <= 0) return prompt
            val mark = "[$imageCount 张图片]"
            return if (prompt.isEmpty()) mark else "$mark $prompt"
        }

        /**
         * 判断"服务端投影出来的这一条"与"本地乐观回声"是不是**同一轮用户消息**（m00011 根因）。
         *
         * 带图回合里两边天然长得不一样，所以不能直接比屏幕文案：
         *
         * - 本地（手机自己造的乐观气泡）：`[N 张图片] 正文` —— 图片本体不上行到 transcript，
         *   只能用前缀把"这条带图"标出来（见 [echoText]）；
         * - 服务端（网关投影权威结果）：`正文` + 独立的 `images` 数组；纯图片回合正文是网关补的
         *   占位文本 `（查看这张图片）`（`tools/dsh-remote/lib/http.mjs` 的 `TURN_IMAGE_ONLY_TEXT`）。
         *
         * 修复前这里是严格相等 `left.text == right.text`，于是带图回合**永远匹配不上** ⇒
         * 本地回声永不被摘除，每轮刷新又被 [ConsoleRepository.restoreLocalMessages] upsert 回窗口，
         * 屏幕上就是并排两条一模一样的用户气泡（纯文本回合文案相等，所以不中招 —— 与实测吻合）。
         *
         * 纯图片回合按附件数与网关占位文本对齐，权威图片到达后删除本地占位气泡。
         *
         * 判据按"强度从高到低"三级，越靠前越不可能误判：
         *
         * 1. **文案全等**（纯文本回合走这条，与修复前一致）；
         * 2. **服务端正文 == 用户真正发出去的原话** [clientText]（带图回合走这条，精确、无歧义）；
         * 3. 兜底：把本地文案的 `[N 张图片]` 前缀剥掉再比（见 [echoBody]）。只有在拿不到原话的
         *    路径上才会走到，代价是"用户正文恰好以 `[N 张图片] ` 开头"时本地那条也被摘掉 ——
         *    服务端那条正文相同、图还在，最多差一个前缀，比"漏合 ⇒ 永久多一条气泡"轻。
         *
         * @param clientText 用户**真正发出去的正文**（`sendTurn` 的 `prompt.trim()`）。这正是服务端
         *   会存下来的那份文本，所以带图回合也只是一个**精确相等**比较。
         *
         *   `null` = 调用方拿不到原始正文（理论上不该发生：仓库在放进 `localMessages` 的同一把锁里
         *   记了 [ConsoleRepository.localClientTexts]）⇒ 直接走第 3 级兜底。
         */
        internal fun isSameEcho(server: ChatMessage, local: ChatMessage, clientText: String? = null): Boolean {
            if (server.role != local.role) return false
            if (kotlin.math.abs(server.at - local.at) >= LOCAL_ECHO_WINDOW_MS) return false
            if (server.text == local.text) return true
            if (clientText != null && clientText.isNotEmpty() && server.text == clientText) return true
            if (clientText.isNullOrEmpty() && server.images.isNotEmpty() &&
                local.text == echoText("", server.images.size) &&
                (server.text.isEmpty() || server.text == "（查看这张图片）")
            ) return true
            // 兜底：本地记账里没有这条的原话时（不该发生），仍然允许按 `[N 张图片]` 前缀剥壳比对。
            // 代价已明确：用户正文**恰好**以 `[N 张图片] ` 开头时，本地那条也会被摘掉，
            // 而服务端那条正文相同、图还在（信息不丢），最多差一个前缀。相比"漏合就永久多一条气泡"，
            // 这个方向的错更轻，所以宁可这样兜底，也不留"某条路径拿不到原话就永远去不掉"的坑。
            return echoBody(local.text, server.images.size) == server.text
        }

        /**
         * 剥掉本地回声的 `[N 张图片]` 前缀，返回用户真正写的正文。
         *
         * @param imageCount 服务端投影里这条消息实际带的图片数；`<= 0` 表示服务端**没带图**
         *   （那本地文本里的 `[N 张图片]` 就只能是用户自己敲的正文，原样返回，不做任何剥除）。
         * @return 剥掉前缀后的正文；`null` = 这条文本**不是回声形态**（不以标记开头，或者
         *   用户正文里本来就有个 `[N 张图片]` 开头）⇒ 调用方按"不相等"处理。
         */
        internal fun echoBody(local: String, imageCount: Int): String? {
            if (imageCount <= 0) return local
            val mark = echoText(prompt = "", imageCount = imageCount)
            if (local == mark) return ""
            val prefix = "$mark "
            return local.takeIf { it.startsWith(prefix) }?.removePrefix(prefix)
        }

        private const val CONNECT_TIMEOUT_MS = 15_000L
        /**
         * 主动刷新撞上重连窗口时，最多等多久再重试一次（见 [tunnelTolerant]）。
         *
         * 取 20s 的依据（2026-10-15 复核中继日志 `/opt/dsh-relay/logs/relay-20261015.log`，
         * 真机 PGT-AN00 + 模拟器）：用户切回 App 时隧道往往正好处在"刚断、还没重连上"的窗口里。
         * 该设备能配对的"`device 隧道 socket 关闭` → `隧道上线 homeOnline=true`"间隔实测为
         * **8.9s / 13.4s / 13.9s / 17.6s**（关闭原因 47 次是 `code=1006 reason=socket`）。
         * 抖动样本里只有约 39% 在 12s 内回来，20s 能覆盖到 17.6s 这一档。
         *
         * 上限为什么不再长：电脑真的关机/断网时，用户宁可较快看到"电脑离线"，也不要对着
         * 转圈等几十秒；且单次刷新最坏 ≈ 首发 60s 超时 + 等待 + 重试 60s（见 [RelayClient]）。
         */
        private const val TUNNEL_WAIT_MS = 20_000L
        private const val STREAM_IDLE_POLL_MS = 1_000L
        private const val STREAM_RETRY_DELAY_MS = 500L
        private const val FEED_LIMIT = 60
        /** SSE 触发的列表刷新最小间隔：中继重连时网关会为每个会话补发事件。 */
        private const val AUTO_REFRESH_MIN_INTERVAL_MS = 2_000L
        /**
         * 对话/轨迹分页的页大小（m00002）。
         *
         * 60 的理由：服务端 `limit` 默认 200、上限 1000，取 60 大约是 6~10 屏，够一次滑动翻完，
         * 首屏也不会因为一页太大而卡；同时远小于 [TranscriptPager.DEFAULT_CAPACITY]，
         * 用户在窗口里连续上拉十页都不会触发裁剪，不会出现"翻着翻着中间断了一段"。
         */
        private const val PAGE_SIZE = 60
        /**
         * "本地乐观消息"与"服务端投影"判为同一条的时间窗。
         *
         * 前提是**角色相同**、且时间戳落在这个窗口内（内容判据见 [isSameEcho]：带图回合要先把
         * 本地回声的 `[N 张图片]` 前缀归一化掉，否则两边文案永远不相等）：服务端投影是
         * 事后生成的，`at` 与本机出口时间会有偏差，但不会差到 10 秒以上。
         */
        private const val LOCAL_ECHO_WINDOW_MS = 10_000L
    }
}
