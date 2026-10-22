package com.deepseek.dshremote.ui.vm

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.data.ConsoleRepository
import com.deepseek.dshremote.data.Logger
import com.deepseek.dshremote.data.api.ChatMessage
import com.deepseek.dshremote.data.api.Deliverable
import com.deepseek.dshremote.data.api.DshApiV2
import com.deepseek.dshremote.data.api.ImageLoader
import com.deepseek.dshremote.data.api.ImagePayloads
import com.deepseek.dshremote.data.api.PendingImage
import com.deepseek.dshremote.data.api.SessionPermission
import com.deepseek.dshremote.data.api.SessionSummary
import com.deepseek.dshremote.data.api.SessionViewMode
import com.deepseek.dshremote.data.api.TodoExtractor
import com.deepseek.dshremote.data.api.TodoItem
import com.deepseek.dshremote.data.api.TrajectoryRow
import com.deepseek.dshremote.data.api.TranscriptSync
import com.deepseek.dshremote.data.api.TurnIndex
import com.deepseek.dshremote.data.api.TurnIndexEntry
import com.deepseek.dshremote.data.api.WireApprovals
import com.deepseek.dshremote.ui.components.buildTrajectory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
// 显式导入 combine：默认重载只到 5 个流，而分页后需要同时看 messages/drafts/sessions/
// busy/nonResumable/sync/loadingOlder/approvals，Kotlin 不会自动挑到 vararg 版本。
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 会话详情（对话流）状态。
 *
 * 数据合并规则：
 * - 已落地的消息来自仓库的 transcript（`turn.ended` 后由服务端权威数据覆盖）；
 * - 正在流式生成的助手消息来自仓库的 drafts（`message.delta` 累积）；
 * - 两者拼接后即为屏幕上看到的对话流。
 */
class SessionDetailViewModel(
    private val repository: ConsoleRepository,
    val sessionId: String,
) : ViewModel() {

    data class UiState(
        val session: SessionSummary? = null,
        val messages: List<ChatMessage> = emptyList(),
        /** 轨迹视图的行（由 [messages] 摊平而来，见 [buildTrajectory]）。 */
        val trajectory: List<TrajectoryRow> = emptyList(),
        /** 当前视图：对话流 / 轨迹。 */
        val viewMode: SessionViewMode = SessionViewMode.CONVERSATION,
        /** 分页元信息（是否还有更早、已加载区间、总数）。 */
        val sync: TranscriptSync = TranscriptSync(),
        /** 「加载更早」进行中（界面用它做三态入口与去重）。 */
        val loadingOlder: Boolean = false,
        /**
         * 「回到最新」的一次性信号：每次请求 +1。
         *
         * 为什么用计数器而不是 `Boolean`：用户可能连续点两次"回到最新"，也可能点了之后
         * 又被新消息推走再点一次——布尔量在"已经是 true"时无法表达"再滚一次"。
         */
        val scrollToNewestTick: Int = 0,
        val todos: List<TodoItem> = emptyList(),
        val input: String = "",
        val sending: Boolean = false,
        val loading: Boolean = false,
        val live: Boolean = false,
        val streaming: Boolean = false,
        val expandedTools: Set<String> = emptySet(),
        val message: String? = null,
        val isError: Boolean = false,
        val offline: Boolean = false,
        /** 该会话是否还能继续（`turn.ended.resumable` / abort 之后为 false）。 */
        val resumable: Boolean = true,
        val showStopConfirm: Boolean = false,
        // ---------- 审批 / 提问（契约 §7.7）----------
        /** 当前**等在电脑端**的未决请求（最新的一条；没有则 null）。 */
        val pendingApproval: WireApprovals.ApprovalEntry? = null,
        /** 提问里用户正在填的答案（按 questionId 索引）。 */
        val approvalDrafts: Map<String, WireApprovals.ApprovalDraft> = emptyMap(),
        /** 有一条答案正在提交（界面据此禁用按钮，避免重复点出两个请求）。 */
        val approvalSubmitting: Boolean = false,
        /** 审批桥诊断快照（解释"列表为什么是空的"）。 */
        val approvalBridge: WireApprovals.BridgeState = WireApprovals.BridgeState(),
        /**
         * 倒计时重算信号（每 15 秒 +1）。
         *
         * 为什么要有：TTL 只有 15 分钟，而"还剩 12 分钟"这种文案不重算就会一直停在旧值上；
         * 界面拿它当 key 触发重组，不需要真的读时间戳。
         */
        val countdownTick: Int = 0,
        // ---------- 待发送图片 ----------
        /**
         * 还没发出去的图片（输入区的附件条）。
         *
         * **只活在内存里**：图片字节不进 Outbox / 缓存（base64 太大，落盘也不该落），
         * 因此进程被杀就没了——这是刻意的，图片是可以重新选一次的。
         */
        val pendingImages: List<PendingImage> = emptyList(),
        // ---------- 会话图片（契约 §4.6，v2.9.0）----------
        /**
         * 图片取字节入口。
         *
         * 放在 UiState 里而不是让界面直接找 `Graph.repository`：会话详情页是唯一需要它的地方，
         * 而"界面拿得到仓库"这条口子一开，各处就会开始各自造缓存；
         * 同时也让 Compose 预览与单测能用 [ImageLoader.None] 构造一个不联网的状态。
         */
        val images: ImageLoader = ImageLoader.None,
        // ---------- 轮次导航（契约 §4.3，v2.9.0）----------
        /** 轮次导航面板是否展开。 */
        val turnNavOpen: Boolean = false,
        /** 服务端给的轮次目录（null = 还没拉过）。 */
        val turnIndex: TurnIndex? = null,
        /** 目录/跳转请求在途（面板据此显示进度并去重）。 */
        val turnIndexLoading: Boolean = false,
        /** 目录或跳转失败的一句话（面板内部显示，不弹全屏错误）。 */
        val turnIndexError: String? = null,
        /**
         * 要滚到的那条消息（一次性信号）。
         *
         * 与 [scrollToNewestTick] 同样的理由用"待消费的目标"而不是布尔量：
         * 连续跳两次到同一轮，布尔量表达不出第二次；而且滚动是界面的事，
         * ViewModel 拿不到 LazyListState，只能把"目标是谁"交出去。
         */
        val scrollToSeq: Long? = null,
        /** 跳转落点的高亮（界面画一条左侧强调线，几秒后自然消失）。 */
        val highlightSeq: Long? = null,
        /** 跳转完成后的轻提示（「已定位到第 3 轮」）。 */
        val jumpNote: String? = null,
        /** 用户最近跳过去的那一轮（null = 跟着最新走，见 [activeTurn]）。 */
        val focusedTurn: Int? = null,
        // ---------- 会话权限（契约 §7.9，v2.11.0）----------
        /** 权限选择面板是否展开。 */
        val permissionSheetOpen: Boolean = false,
        /** 有一条权限修改正在提交（界面禁用选项并显示进度）。 */
        val permissionSaving: Boolean = false,
        /** 权限修改失败的原因（显示在面板里，不关面板）。 */
        val permissionError: String? = null,
    ) {
        /** 服务端一共多少轮（目录没拉到时为 0）。 */
        val turnCount: Int get() = turnIndex?.total ?: 0

        /**
         * 轮次面板里标「当前」的那一轮。
         *
         * **不能用 [turnCount] 当轮号**：轮号是消息上的原始编号，中间可以有空洞（实测真会话
         * 里有 1/3/4/5 而没有 2 —— 第 2 轮那条用户消息被删了或从未落地），此时"共 4 轮"与
         * "最新是第 5 轮"不是一回事，把轮数当轮号会标错行（真机取证时就是这么发现的）。
         * 所以这里取目录里**最大的轮号**；用户跳转之后则以他刚去的那一轮为准，
         * 直到他再点「回到最新」。
         */
        val activeTurn: Int get() = focusedTurn ?: turnIndex?.turns?.maxOfOrNull { it.turn } ?: 0

        /**
         * 值不值得给用户一个"跳到某一轮"的入口。
         *
         * 只有一轮时这个入口是纯噪音（点开只有一个选项），所以门槛设在 >1。
         */
        val canJumpTurns: Boolean get() = turnCount > 1

        /**
         * 能不能发。
         *
         * 「只有图片、没有文字」也要能发：占位文本由网关侧补，
         * 手机端在这里拦住会让"发张图问问这是什么"变成不可能完成的操作。
         */
        val canSend: Boolean
            get() = canSendNow(input, pendingImages.size, sending, writable, resumable)

        val title: String get() = session?.title.orEmpty()

        /**
         * 待发图片的一句话摘要（如「2 张图片 · 约 0.4 MB」；没有图片时是空串）。
         *
         * 界面据此渲染附件条副标题；空串是有意的（"没有附件"不该占版面）。
         */
        val imageSendNote: String
            get() {
                if (pendingImages.isEmpty()) return ""
                val total = pendingImages.sumOf { it.bytes.size }
                return "${pendingImages.size} 张图片 · 约 ${ImagePayloads.formatBytes(total)}"
            }

        /** 是否还有更早的消息没加载（界面据此显示上拉入口）。 */
        val hasMoreOlder: Boolean get() = sync.hasMoreOlder

        /** 已加载条数（显示用近似值，翻页判定一律以 [hasMoreOlder] 为准）。 */
        val loadedCount: Int get() = sync.loadedCount

        /** 服务端报的总条数；老网关不给时为 0。 */
        val totalCount: Int get() = sync.total

        /**
         * 手机能否在此会话发消息。
         *
         * **以服务端 `writable` 为准**：
         * - `phone` 会话在网关重启或被 abort 后 `writable:false`（SDK 协议限制，新进程无法接管既有会话）；
         * - `computer` 会话由电脑端 runtime 常驻驱动，服务端现在下发 `writable:true`，
         *   手机发消息会写回电脑端同一段会话，电脑端的执行事件经 SSE 实时推回来。
         *
         * 缺字段（老网关）时按来源推导：只有手机任务可写。
         */
        val writable: Boolean get() = session?.writable == true

        /** 输入框整体是否可用：可写 **且** 会话仍可继续。 */
        val inputEnabled: Boolean get() = writable && resumable

        /** 当前权限视图（null = 旧网关/桌面端离线，界面显示"权限未知"）。 */
        val permission: SessionPermission? get() = session?.permission

        /** 能不能点开权限面板：必须是可写电脑端会话，且网关宣告 editable。 */
        val canEditPermission: Boolean get() = session?.canEditPermission == true

        /**
         * 输入区上方那句权限文案。
         *
         * 电脑端会话：`权限：仅工作区`（未知就说未知，绝不拿默认档假装知道）；
         * 网关会话：`权限：仅当前工作区（创建时固定）`，因为 SDK 没有运行中 setter。
         */
        val permissionNote: String
            get() {
                val current = session
                val known = permission
                if (known == null) return "权限未知（电脑端离线或旧网关）"
                return if (current?.isDesktopDriven == true) {
                    "权限：${known.currentLabel}"
                } else {
                    "权限：${known.currentLabel}（创建时固定）"
                }
            }

        /**
         * 电脑端会话可续聊时的一句说明。
         *
         * 为什么需要：用户以前看到"电脑"徽标就知道这里只能看；现在能发了，
         * 得让他知道消息落到**电脑上那段会话**里、输出来自电脑端 runtime 的实时事件。
         */
        val livePeerNote: String?
            get() = when {
                !writable -> null
                session?.isDesktopDriven != true -> null
                else -> "电脑端会话：消息交给电脑端 runtime 执行，电脑端的输出会实时同步到这里"
            }

        /**
         * 为什么发不了（只读横幅文案）。
         *
         * 原因分三级：服务端 `writableReason`（`desktop_disabled` / `subagent` / `runtime_gone`）优先，
         * 老网关缺字段时按来源兜底（见 [SessionSummary.readOnlyHeadline]）；
         * "接下来怎么办"那半句再按来源选——手机任务和电脑端会话的去处不一样。
         */
        val readOnlyReason: String
            get() {
                val current = session ?: return "正在加载会话信息…"
                if (current.writable) return ""
                // 去处按**数据在哪**判（source），不按谁发起：手机发起但落在电脑端的会话，
                // 该去电脑端接着聊，而不是回「手机任务」再新建一个。
                val advice = if (current.source == SessionSummary.SOURCE_PHONE) {
                    "请到「手机任务」新建任务"
                } else {
                    "请在电脑端继续，或在「手机任务」新建任务"
                }
                val head = current.readOnlyHeadline
                return if (head.isNullOrEmpty()) advice else "$head；$advice"
            }

        /**
         * 不可继续时的说明。
         *
         * 手机会话：停止只能杀进程（SDK 没有 cancel），会话随之作废。
         * 电脑端会话：中止**不会**作废会话，走到这里说明是网关重启/没接入该会话。
         */
        val nonResumableReason: String
            get() = if (session?.source == SessionSummary.SOURCE_PHONE) {
                "本会话已停止，无法继续（停止会终止该会话的 SDK 进程）；要接着干活请到「手机任务」新建任务"
            } else {
                "本会话已不可继续（电脑端网关重启或未接入该会话）；请在电脑端继续，或在「手机任务」新建任务"
            }

        // ---------- 审批 / 提问派生 ----------

        /** 一条审批都还没有时给界面的一句说明（区分"没有"和"没连上"）。 */
        val approvalNote: String get() = approvalBridge.note

        /** 提问的本地校验（界面据此把「提交」置灰）。 */
        val approvalPlan: WireApprovals.ApprovalPlan
            get() = pendingApproval?.let { WireApprovals.plan(it, approvalDrafts) }
                ?: WireApprovals.ApprovalPlan(canSubmit = false, unanswered = emptyList(), total = 0)
    }

    private val _ui = MutableStateFlow(UiState(images = repository.images))
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    val relayState: StateFlow<com.deepseek.dshremote.data.relay.RelayState> = repository.relayState

    init {
        viewModelScope.launch {
            // kotlinx.coroutines 只在 2~5 个流上提供带 lambda 的 combine 重载，
            // 6 个以上会落到 `combine(vararg Flow<T>)` —— 那要求**所有流同类型**，
            // 而这里是 Map / Map / List / Set / Set 混着的，编译器直接判为无解。
            // 所以先各自合并成三元组/四元组，再合并成一组（嵌套 combine 是官方推荐做法）。
            combine(
                combine(
                    repository.transcripts,
                    repository.drafts,
                    repository.loadingOlder,
                ) { transcripts, drafts, loadingOlder -> Triple(transcripts, drafts, loadingOlder) },
                combine(
                    repository.sessions,
                    repository.busySessions,
                    repository.nonResumable,
                    repository.transcriptSyncs,
                ) { sessions, busy, nonResumable, syncs -> Quad(sessions, busy, nonResumable, syncs) },
            ) { window, meta ->
                val (transcripts, drafts, loadingOlder) = window
                val committed = transcripts[sessionId].orEmpty()
                val draft = drafts[sessionId]
                val merged = if (draft == null || draft.isEmpty) {
                    committed
                } else {
                    committed + draft
                }
                Combined(
                    messages = merged,
                    session = meta.sessions.firstOrNull { it.id == sessionId },
                    sending = meta.busy.contains(sessionId),
                    online = repository.online.value,
                    streaming = draft != null && !draft.isEmpty,
                    resumable = !meta.nonResumable.contains(sessionId),
                    sync = meta.syncs[sessionId] ?: TranscriptSync(),
                    loadingOlder = loadingOlder.contains(sessionId),
                )
            }.collect { combined ->
                _ui.update {
                    it.copy(
                        messages = combined.messages,
                        // 轨迹与对话流**同源**：从同一份分页窗口摊平，长度随翻页一起增长。
                        // 只在 messages 变化时重算（combine 已经保证），不必再单独订阅窗口状态。
                        trajectory = buildTrajectory(combined.messages),
                        sync = combined.sync,
                        loadingOlder = combined.loadingOlder,
                        session = combined.session,
                        sending = combined.sending,
                        offline = !combined.online,
                        live = combined.session?.live == true || combined.sending,
                        streaming = combined.streaming,
                        resumable = combined.resumable,
                        todos = TodoExtractor.fromMessages(combined.messages),
                    )
                }
            }
        }
        // 审批状态单独订阅（并进上面那条 combine 就要再套一层四元组，收益不抵复杂度）。
        // 心跳：拿到新条目时顺手清掉上一次的错误提示——旧错误挂在新请求上会误导用户。
        viewModelScope.launch {
            combine(repository.approvals, repository.approvalState) { bySession, bridge ->
                bySession[sessionId].orEmpty().firstOrNull() to bridge
            }.collect { (entry, bridge) ->
                _ui.update { state ->
                    state.copy(
                        pendingApproval = entry,
                        approvalBridge = bridge,
                        // 换了另一条请求（或它没了）时把草稿清掉：上一题的选项不能留在这一题里
                        approvalDrafts = if (entry?.eventId == state.pendingApproval?.eventId) {
                            state.approvalDrafts
                        } else {
                            emptyMap()
                        },
                    )
                }
            }
        }
        // TTL 倒计时：15 分钟一档的文案不需要秒级刷新，15 秒一跳足够且几乎不耗电
        viewModelScope.launch {
            while (isActive) {
                delay(COUNTDOWN_TICK_MS)
                _ui.update { it.copy(countdownTick = it.countdownTick + 1) }
            }
        }
        // 隧道状态单独订阅：combine 里读 .value 拿不到后续变化
        viewModelScope.launch {
            repository.online.collect { online -> _ui.update { it.copy(offline = !online) } }
        }
        refresh(force = false)
        refreshApprovals()
    }

    /** 嵌套 combine 的中间载体：把 4 个不同类型的流装成一个值。 */
    private data class Quad(
        val sessions: List<SessionSummary>,
        val busy: Set<String>,
        val nonResumable: Set<String>,
        val syncs: Map<String, TranscriptSync>,
    )

    private data class Combined(
        val messages: List<ChatMessage>,
        val session: SessionSummary?,
        val sending: Boolean,
        val online: Boolean,
        val streaming: Boolean,
        val resumable: Boolean,
        val sync: TranscriptSync,
        val loadingOlder: Boolean,
    )

    fun refresh(force: Boolean = true) {
        if (_ui.value.loading) return
        _ui.update { it.copy(loading = true) }
        viewModelScope.launch {
            try {
                repository.loadTranscript(sessionId, force = force)
                    .onFailure { error ->
                        _ui.update { it.copy(message = "加载对话失败：${error.friendlyMessage()}", isError = true) }
                    }
                repository.refreshSession(sessionId)
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                _ui.update { it.copy(message = "内部错误：${t.message}", isError = true) }
            } finally {
                _ui.update { it.copy(loading = false) }
            }
        }
    }

    fun onInputChange(value: String) = _ui.update { it.copy(input = value, message = null) }

    /** 切换「对话 / 轨迹」。两者共用同一份分页窗口，所以切换**不重新加载**、不改变已加载区间。 */
    fun switchView(mode: SessionViewMode) {
        if (_ui.value.viewMode == mode) return
        _ui.update { it.copy(viewMode = mode) }
    }

    // ---------- 会话权限（v2.11.0）----------

    /** 打开权限面板。不可编辑时什么都不做（界面也不会给入口）。 */
    fun openPermissionSheet() {
        if (!_ui.value.canEditPermission) return
        _ui.update { it.copy(permissionSheetOpen = true, permissionError = null) }
    }

    /** 关闭权限面板；提交中不允许关（避免用户以为改了、其实请求被取消）。 */
    fun closePermissionSheet() {
        if (_ui.value.permissionSaving) return
        _ui.update { it.copy(permissionSheetOpen = false, permissionError = null) }
    }

    /**
     * 提交权限修改（预设名：`read-only` / `workspace-write` / `danger-full-access`）。
     *
     * 成功后面板自动关闭并提示一次；失败**不关面板**，把原因留在原地让用户重试
     * （与轮次导航同一个交互原则：用户还在面板上时，消失的提示等于没提示）。
     */
    fun changePermission(preset: String) {
        val state = _ui.value
        if (state.permissionSaving) return
        if (!state.canEditPermission) {
            _ui.update { it.copy(permissionError = "当前会话不支持在手机上修改权限") }
            return
        }
        if (state.permission?.currentValue == preset) {
            closePermissionSheet()
            return
        }
        _ui.update { it.copy(permissionSaving = true, permissionError = null) }
        viewModelScope.launch {
            repository.setSessionPermission(sessionId, preset)
                .onSuccess { permission ->
                    _ui.update {
                        it.copy(
                            permissionSaving = false,
                            permissionSheetOpen = false,
                            permissionError = null,
                            message = "权限已改为「${permission.currentLabel}」",
                            isError = false,
                        )
                    }
                }
                .onFailure { error ->
                    _ui.update {
                        it.copy(
                            permissionSaving = false,
                            permissionError = "修改权限失败：${error.friendlyMessage()}",
                        )
                    }
                }
        }
    }

    /**
     * 上拉加载更早的一页。
     *
     * 静默 return 的三种情况都是**故意**的：界面的滚动监听会高频触发，
     * 靠界面去重是治标（重组、旋转屏幕、快速滑动都会重复发），必须在状态里兜住：
     * 已到最早 / 正在加载 / 页面还没初始化完。
     */
    fun loadOlder() {
        val state = _ui.value
        if (state.loadingOlder || state.loading) return
        if (!state.hasMoreOlder) return
        viewModelScope.launch {
            repository.loadOlder(sessionId).onFailure { error ->
                _ui.update { it.copy(message = "加载更早的消息失败：${error.friendlyMessage()}", isError = true) }
            }
        }
    }

    /** 「回到最新」：只推进一次性信号，滚动本身由界面消费（ViewModel 拿不到 LazyListState）。 */
    fun scrollToNewest() = _ui.update {
        it.copy(
            scrollToNewestTick = it.scrollToNewestTick + 1,
            // 回到底部就不再是"停在某一轮"上了，落点高亮必须一起收掉：
            // 留着它会让用户以为底部这一轮才是他刚跳过去的那一轮。
            highlightSeq = null,
            // 「当前」也回到最新那一轮（见 [UiState.activeTurn]）。
            focusedTurn = null,
        )
    }

    // ---------- 轮次导航（契约 §4.3） ----------

    /**
     * 打开轮次导航面板。
     *
     * 目录只在**没拉过**时才去拉：面板是随时可开关的，每次都打一次网络请求没有必要；
     * 目录过期由仓库在"追新页/发消息"时作废缓存（见 `ConsoleRepository.loadTurnIndex`），
     * 所以这里拿到的旧目录最多比服务端少一轮，且下次打开会自动是新的。
     */
    fun openTurnNav() {
        _ui.update { it.copy(turnNavOpen = true, turnIndexError = null) }
        if (_ui.value.turnIndex == null) loadTurnIndex()
    }

    fun closeTurnNav() = _ui.update { it.copy(turnNavOpen = false) }

    /**
     * 拉目录。默认走仓库缓存（没拉过 / 已作废时才会真的发请求），
     * 面板里的「刷新」传 `force = true` 明确绕过缓存。
     */
    fun loadTurnIndex(force: Boolean = false) {
        if (_ui.value.turnIndexLoading) return
        viewModelScope.launch {
            _ui.update { it.copy(turnIndexLoading = true, turnIndexError = null) }
            repository.loadTurnIndex(sessionId, force = force).fold(
                onSuccess = { index ->
                    _ui.update { it.copy(turnIndexLoading = false, turnIndex = index, turnIndexError = null) }
                },
                onFailure = { error ->
                    // 失败**不关面板**：面板里要能显示原因并重试，关掉就成了"点了没反应"。
                    // 老网关（没有 turn-index 能力）走的也是这条路，文案要能读懂。
                    _ui.update {
                        it.copy(
                            turnIndexLoading = false,
                            turnIndexError = "轮次列表加载失败：${error.friendlyMessage()}",
                        )
                    }
                },
            )
        }
    }

    /**
     * 跳到第 [entry] 轮。
     *
     * 两条路径，差别很重要：
     * 1. **这一轮已经在窗口里**（消息上有同一个 [ChatMessage.turn]）⇒ 只滚动 + 高亮。
     *    这里绝不能走"重新取一页"：换窗口会把用户已经翻出来的历史整段丢掉，
     *    而他要的只是"回去看一眼第 3 轮"；
     * 2. **不在窗口里** ⇒ 请服务端以这一轮结尾取一页（`cursor = toIndex`），
     *    窗口整体换成那一页，再滚到该轮的第一条消息。
     *
     * 失败只写 [UiState.turnIndexError]（面板里显示）而不是弹 [UiState.message]：
     * 用户还在面板上，能在原地重试比看一条会消失的提示更有用。
     */
    fun jumpToTurn(entry: TurnIndexEntry) {
        if (_ui.value.turnIndexLoading) return
        val loaded = _ui.value.messages.firstOrNull { it.turn == entry.turn }
        if (loaded != null) {
            _ui.update {
                it.copy(
                    turnNavOpen = false,
                    scrollToSeq = loaded.seq,
                    highlightSeq = loaded.seq,
                    jumpNote = "已定位到第 ${entry.turn} 轮",
                    turnIndexError = null,
                    focusedTurn = entry.turn,
                )
            }
            return
        }
        viewModelScope.launch {
            _ui.update { it.copy(turnIndexLoading = true, turnIndexError = null) }
            repository.jumpToTranscript(sessionId, cursor = entry.cursor, turn = entry.turn).fold(
                onSuccess = { anchor ->
                    _ui.update {
                        it.copy(
                            turnIndexLoading = false,
                            turnNavOpen = false,
                            scrollToSeq = anchor?.seq,
                            highlightSeq = anchor?.seq,
                            jumpNote = if (anchor == null) {
                                "第 ${entry.turn} 轮没有可显示的内容"
                            } else {
                                "已定位到第 ${entry.turn} 轮"
                            },
                            focusedTurn = entry.turn,
                        )
                    }
                },
                onFailure = { error ->
                    _ui.update {
                        it.copy(
                            turnIndexLoading = false,
                            turnIndexError = "跳到第 ${entry.turn} 轮失败：${error.friendlyMessage()}",
                        )
                    }
                },
            )
        }
    }

    /** 界面滚完/滚不动之后调一次，把一次性信号收掉（否则重组会重复滚）。 */
    fun consumeScrollTarget() = _ui.update { if (it.scrollToSeq == null) it else it.copy(scrollToSeq = null) }

    /** 轻提示显示完由界面收掉。 */
    fun consumeJumpNote() = _ui.update { if (it.jumpNote == null) it else it.copy(jumpNote = null) }

    /**
     * 填入示例 prompt（中文多行）。
     *
     * 存在的理由不是"偷懒"：模拟器没有中文输入法，`adb shell input text '中文'` 会抛
     * `NullPointerException … InputShellCommand.sendText`（BUILD.md §7.3），
     * 自动化必须有一条不依赖输入法的中文写入通道。真机上系统输入法当然可用。
     */
    fun fillDemoPrompt() = _ui.update {
        it.copy(
            input = "把 android 模块的单元测试跑一遍，失败的话帮我定位原因\n（示例文本，可直接改成别的）",
            message = null,
        )
    }

    fun clearInput() = _ui.update { it.copy(input = "") }

    // ---------- 待发送图片 ----------

    /**
     * 选了一张图（相册/拍照/分享进来的 `content://`）。
     *
     * 解码与压缩必须离开主线程：一张 4000×3000 的 JPEG 解码 + 缩放要几百毫秒，
     * 在主线程做就是一次肉眼可见的卡顿（[Dispatchers.IO] 里做，回主线程只改状态）。
     *
     * 状态改动全部走 [appendImage] 这个纯函数：View 层点两下的竞态、
     * 以及"上限 4 张"的判定都在那里，不必依赖 Android Context 就能单测。
     */
    fun attachImage(uri: android.net.Uri, displayName: String? = null) {
        viewModelScope.launch {
            val loaded = withContext(Dispatchers.IO) {
                runCatching { ImagePayloads.fromUri(appContext(), uri, displayName) }
            }
            val image = loaded.getOrNull()?.getOrNull()
            if (image == null) {
                // 两种失败都要说人话：`fromUri` 自己回的失败原因优先（"超过 700 KiB"这类），
                // 连它都没跑起来（Graph 未初始化 / 线程被中断）时才用兜底异常。
                val error = loaded.getOrNull()?.exceptionOrNull()
                    ?: loaded.exceptionOrNull()
                    ?: IllegalStateException("图片读取失败")
                _ui.update { it.copy(message = ImagePayloads.describeFailure(error), isError = true) }
                return@launch
            }
            var added = false
            _ui.update { state ->
                val next = appendImage(state, image)
                added = next !== state
                next
            }
            if (!added) {
                // 上限拦下的：手机端先拦住，比让网关回 400 更早知道
                _ui.update { it.copy(message = MAX_IMAGES_MESSAGE, isError = true) }
            }
        }
    }

    /** 移除第 [index] 张待发图（越界静默忽略：界面可能比状态晚一帧）。 */
    fun removeImage(index: Int) = _ui.update { removeImageAt(it, index) }

    /** 清空待发图片（用户取消这次发送时用）。 */
    fun clearImages() = _ui.update { it.copy(pendingImages = emptyList()) }

    /**
     * 图片解码/压缩要用的 Context。
     *
     * [ViewModel] 拿不到 Activity Context（`AndroidViewModel` 能拿，但会把单测拖进 Robolectric）；
     * 这里复用 [Graph.appContext]——它是 Application Context，生命周期与进程一致，
     * **不会**泄漏 Activity。Graph 未初始化时抛错，由 [attachImage] 的 runCatching 转成提示。
     */
    private fun appContext(): android.content.Context = Graph.appContext

    fun send() {
        val state = _ui.value
        if (!state.canSend) return
        // 契约已更新：电脑端会话由电脑端 runtime 常驻驱动，服务端开始下发 `writable:true`，
        // 手机可以直接续聊（`canSend` 里的 writable 已经是唯一闸门）。
        // 老网关对电脑端会话仍给 `writable:false`/缺字段 —— 那种情况 `canSend` 已经挡住了，
        // 这里只留一句兜底，避免任何路径绕过可写性检查发请求。
        if (state.session?.writable != true) {
            _ui.update {
                it.copy(
                    message = "该会话当前不可写（电脑端未把该会话交给网关）；请在电脑端继续，或到「手机任务」新建任务",
                    isError = true,
                )
            }
            return
        }
        val prompt = state.input
        val images = state.pendingImages
        // 发送前的本地预算判据：拦在乐观回声**之前**。
        // 不做这一步的话，超预算的图会先在对话里落下一条 `[N 张图片] …` 气泡，紧接着才报
        // "图片总量超出…"失败——那条气泡在电脑端根本不存在（幽灵消息）。
        // 这里量的是**真实序列化后的 body 字节数**（见 imagesBudgetPrecheck 的注释：
        // 第一版用估算，结果放行了真判据不接受的组合，那本身就是幽灵消息）。
        // 它在 IO 线程上拼一次 JSON：图多时那是几 MB 的字符串，不该压在主线程。
        _ui.update { it.copy(sending = true, input = "", message = null) }
        viewModelScope.launch {
            val overBudget = withContext(Dispatchers.IO) {
                DshApiV2.imagesBudgetPrecheck(prompt, images)
            }
            if (overBudget != null) {
                // 图片留在 pendingImages 里：用户减一张就能重试，不必重新选图。
                // 输入框里的文字也还回去（上面那句 input = "" 是为"已发出"准备的清空）。
                _ui.update { it.copy(sending = false, input = prompt, message = overBudget, isError = true) }
                return@launch
            }
            try {
                repository.sendTurn(sessionId, prompt, images)
                    .onSuccess { outcome ->
                        val text = when {
                            outcome.queued -> "已离线排队：隧道恢复后会自动发送（对话内容不会丢）"
                            else -> "已发送，等待模型输出…"
                        }
                        Logger.i(
                            TAG,
                            "续聊已提交 queued=${outcome.queued} images=${images.size} session=${sessionId.take(20)}",
                        )
                        // 受理之后才清图片：失败时图片必须还在，用户能直接重试。
                        // 排队（queued）也要清——它是"已经收下了"，图片早已随客户端字节发进隧道；
                        // 带图请求根本不会走到排队分支（仓库侧离线直接失败）。
                        _ui.update { it.copy(message = text, isError = false, pendingImages = emptyList()) }
                    }
                    .onFailure { error ->
                        // 发送失败要把用户写的内容还回输入框，不能吞掉
                        _ui.update {
                            it.copy(
                                input = if (it.input.isBlank()) prompt else it.input,
                                message = sendFailureMessage(error),
                                isError = true,
                            )
                        }
                    }
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                _ui.update {
                    it.copy(
                        input = if (it.input.isBlank()) prompt else it.input,
                        message = "内部错误：${t.message}",
                        isError = true,
                    )
                }
            } finally {
                _ui.update { it.copy(sending = false) }
            }
        }
    }

    /** 点「停止」：先弹二次确认（停止 = 中止本轮；是否还能续聊由服务端说了算）。 */
    fun requestStop() = _ui.update { it.copy(showStopConfirm = true) }

    fun cancelStop() = _ui.update { it.copy(showStopConfirm = false) }

    /**
     * 用户确认停止（中止本轮）。
     *
     * **不要无条件把会话标成不可续**：中止是否作废会话取决于驱动方。
     * - 手机会话（网关 SDK）：`POST /abort` 返回 `resumable:false`，仓库把它记进 `nonResumable`，
     *   该会话再也接不回来（SDK 没有 cancel，只能杀进程）。
     * - 电脑端会话：返回 `resumable:true`，电脑端 runtime 还在，**中止后照样能继续聊**。
     *
     * 所以这里以仓库里 `nonResumable`（服务端权威结果）为准，而不是写死 `resumable = false`。
     */
    fun confirmStop() {
        _ui.update { it.copy(showStopConfirm = false, message = null) }
        viewModelScope.launch {
            repository.abortTurn(sessionId)
                .onSuccess {
                    val resumable = !repository.nonResumable.value.contains(sessionId)
                    _ui.update {
                        it.copy(
                            resumable = resumable,
                            message = if (resumable) {
                                "已停止本轮；该会话仍可继续"
                            } else {
                                "已停止本轮：该会话无法继续，需要新建任务"
                            },
                            isError = false,
                        )
                    }
                }
                .onFailure { error ->
                    _ui.update { it.copy(message = "停止失败：${error.friendlyMessage()}", isError = true) }
                }
        }
    }

    fun toggleTool(id: String) = _ui.update {
        it.copy(expandedTools = if (it.expandedTools.contains(id)) it.expandedTools - id else it.expandedTools + id)
    }

    /** 交付物能否在工作区里打开（路径必须能归一化到某个工作区）。 */
    fun deliverableWorkspace(deliverable: Deliverable): String? {
        val path = deliverable.path
        val session = _ui.value.session ?: return null
        return if (session.workspace.isNotEmpty() && path.startsWith(session.workspace, ignoreCase = true)) {
            session.workspace
        } else {
            null
        }
    }

    fun consumeMessage() = _ui.update { it.copy(message = null) }

    // ---------- 审批 / 提问（契约 §7.7）----------

    /** 重新拉一次本会话的未决列表（进入页面、提交后对账、用户下拉刷新都会走这里）。 */
    fun refreshApprovals() {
        viewModelScope.launch { repository.loadApprovals(sessionId) }
    }

    /** 点一个选项（单选可再点取消；多选切换）。 */
    fun selectOption(questionId: String, label: String) = _ui.update { state ->
        state.copy(
            approvalDrafts = applyOption(state.pendingApproval, state.approvalDrafts, questionId, label),
            message = null,
        )
    }

    /** 自由文本作答（无选项的问题，或想补充说明）。 */
    fun setCustomAnswer(questionId: String, text: String) = _ui.update { state ->
        val draft = state.approvalDrafts[questionId] ?: WireApprovals.ApprovalDraft()
        state.copy(approvalDrafts = state.approvalDrafts + (questionId to draft.copy(custom = text)), message = null)
    }

    /** 清空这一问的作答（选项与文本一起清，避免"看起来没答其实还选着"）。 */
    fun clearAnswer(questionId: String) = _ui.update { state ->
        state.copy(
            approvalDrafts = state.approvalDrafts + (questionId to WireApprovals.ApprovalDraft()),
            message = null,
        )
    }

    /**
     * 提交提问的答案。
     *
     * 提交前先做本地校验：网关对"一条都没答"的请求是 400，但让用户先看到一句
     * "还有 2 个问题没回答"比让服务器拒绝有用得多。
     */
    fun submitAnswers() {
        val state = _ui.value
        val entry = state.pendingApproval ?: return
        val plan = WireApprovals.plan(entry, state.approvalDrafts)
        if (!plan.canSubmit) {
            _ui.update {
                it.copy(
                    message = if (plan.total == 0) {
                        "这次提问没有可回答的内容"
                    } else {
                        "还有 ${plan.unanswered.size} 个问题没有回答"
                    },
                    isError = true,
                )
            }
            return
        }
        val body = WireApprovals.encodeAnswers(entry.questions.orEmpty(), state.approvalDrafts)
        if (body == null) {
            _ui.update { it.copy(message = "还没有填写任何答案", isError = true) }
            return
        }
        answerApproval(entry, WireApprovals.Answer.Responses(body))
    }

    /** 审批结论（允许一次 / 拒绝 / 取消本轮 / 无法处理）。 */
    fun decideApproval(outcome: WireApprovals.Outcome) {
        val entry = _ui.value.pendingApproval ?: return
        answerApproval(entry, WireApprovals.Answer.Decision(outcome))
    }

    /**
     * 弃权：让网关的 waterfall 继续找下一个应答者。
     *
     * 为什么值得一个按钮：手机端可能只知道"这不该由我决定"（比如审批的是电脑上的文件），
     * 弃权不会替用户做出错误决定；最终无人应答时协议归一成 `unavailable`（等于拒绝）。
     */
    fun abstainApproval() {
        val entry = _ui.value.pendingApproval ?: return
        answerApproval(entry, WireApprovals.Answer.Abstain())
    }

    private fun answerApproval(entry: WireApprovals.ApprovalEntry, answer: WireApprovals.Answer) {
        if (_ui.value.approvalSubmitting) return
        if (answer.body.isEmpty()) {
            _ui.update { it.copy(message = "还没有填写任何答案", isError = true) }
            return
        }
        _ui.update { it.copy(approvalSubmitting = true, message = null) }
        viewModelScope.launch {
            try {
                repository.submitApproval(entry.eventId, answer.body, sessionId)
                    .onSuccess {
                        _ui.update {
                            it.copy(
                                pendingApproval = null,
                                approvalDrafts = emptyMap(),
                                message = answer.resultMessage,
                                isError = false,
                            )
                        }
                    }
                    .onFailure { error ->
                        _ui.update {
                            it.copy(
                                message = WireApprovals.friendlyApprovalMessage(error),
                                isError = true,
                                // "已经不在了"（被别人先答 / 过期）：本地这张卡必须消失，
                                // 否则用户会一直点一个永远失败的按钮
                                pendingApproval = if (WireApprovals.alreadyDecided(error)) null else it.pendingApproval,
                            )
                        }
                    }
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                _ui.update { it.copy(message = "内部错误：${t.message}", isError = true) }
            } finally {
                _ui.update { it.copy(approvalSubmitting = false) }
            }
        }
    }

    /** 界面倒计时用的当前时间（抽成方法，单测里可以固定它）。 */
    fun now(): Long = System.currentTimeMillis()

    /**
     * 点选项后的新草稿表（纯函数，便于单测）。
     *
     * 找不到那一问时**原样返回**：界面可能比状态晚一帧（列表刚被 SSE 换掉），
     * 这时静默忽略比抛异常好——用户点到的是一张正在消失的卡片。
     */
    private fun applyOption(
        entry: WireApprovals.ApprovalEntry?,
        drafts: Map<String, WireApprovals.ApprovalDraft>,
        questionId: String,
        label: String,
    ): Map<String, WireApprovals.ApprovalDraft> {
        val question = entry?.questions.orEmpty().firstOrNull { it.id == questionId } ?: return drafts
        val draft = drafts[questionId] ?: WireApprovals.ApprovalDraft()
        return drafts + (questionId to WireApprovals.toggleOption(question, draft, label))
    }

    /**
     * 全部成员都是纯函数（只读入参）或常量，因此**不设 private**：
     * 单测在同一个模块里，能直接验这些真判据，而不必造一个需要 Android Context 的仓库。
     */
    internal companion object {
        const val TAG = "SessionDetailVM"

        /** TTL 文案的重算间隔：15 分钟一档的倒计时不需要秒级精度，15 秒一跳几乎不耗电。 */
        const val COUNTDOWN_TICK_MS = 15_000L

        /**
         * 一次最多几张图（冻结协议：网关侧同样卡 4 张）。
         *
         * 手机端先卡住的价值：用户在选第 5 张时立刻知道，而不是等网关回 400 才发现前面白选了。
         */
        const val MAX_IMAGES = 4

        /** 超过 [MAX_IMAGES] 的提示（与网关侧 400 的措辞同义）。 */
        const val MAX_IMAGES_MESSAGE = "一次最多发 4 张图片"

        /**
         * 追加一张待发图（**纯函数**，只读 `state`，见 `SessionDetailAttachmentsTest`）。
         *
         * 到上限（[MAX_IMAGES]）时**原样返回**（`===` 同一个实例），调用方据此判定"没加上"，
         * 从而给出「一次最多发 4 张图片」而不是默默只加了 3 张。
         */
        fun appendImage(state: UiState, image: PendingImage): UiState {
            if (state.pendingImages.size >= MAX_IMAGES) return state
            val next = state.pendingImages + image
            return state.copy(
                pendingImages = next,
                message = "已添加 1 张图片（共 ${next.size} 张）",
                isError = false,
            )
        }

        /**
         * 移除第 [index] 张。**越界原样返回**（界面可能比状态晚一帧：刚删掉的那张又被点了一次），
         * 这里抛异常就是一次崩溃。
         *
         * 判据必须落在**传入的索引**上，不能靠"过滤后少没少"：`filterIndexed`/`filter`
         * 无论删没删掉东西都会造一个新 List，于是 `state.copy(...)` 必然产出新实例，
         * `remaining === state.pendingImages` **永远为 false** —— 这条最初就是这么写错的
         * （`SessionDetailAttachmentsTest.「out_of_range_remove_is_ignored_verbatim」` 红的
         * 就是这个：越界删除返回的是新实例而不是原实例）。现在先判索引，
         * 再用 `map` 重建（`map` 同样总是新 List，所以越界那条必须在进 `map` 之前 return）。
         *
         * 为什么用 `===` 比 `equals` 对：调用方（[removeImage] → `_ui.update`）靠引用判断
         * "这次点击什么都没改"，`StateFlow` 也用的是引用相等。用 `equals` 会把"内容相同的
         * 新对象"当成一次真实变更推给界面，多一次无意义重组。
         */
        fun removeImageAt(state: UiState, index: Int): UiState {
            if (index !in state.pendingImages.indices) return state
            return state.copy(
                pendingImages = state.pendingImages.mapIndexedNotNull { i, it -> it.takeIf { i != index } },
            )
        }

        /**
         * 「只发图片」也要能发（占位文本由网关侧补）。
         */
        fun canSendNow(
            input: String,
            pendingImages: Int,
            sending: Boolean,
            writable: Boolean,
            resumable: Boolean,
        ): Boolean = (input.isNotBlank() || pendingImages > 0) && !sending && writable && resumable

        /**
         * 发送失败的一句话。
         *
         * 唯一的特例是「离线时不能发送图片」：那句文案本身已经是完整指引，
         * 再加"发送失败："前缀只会让用户以为是网络故障而反复重试。
         *
         * 放在伴生对象里不是为了复用它，而是因为它**不依赖任何实例状态**，
         * 这样单测能直接验这条特例而不必造一个需要 Context 的仓库。
         */
        fun sendFailureMessage(error: Throwable): String {
            val text = error.friendlyMessage()
            if (error is IllegalArgumentException && text == ConsoleRepository.IMAGE_OFFLINE_MESSAGE) return text
            return "发送失败：$text"
        }
    }
}
