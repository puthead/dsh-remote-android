package com.deepseek.dshremote.ui.vm

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.deepseek.dshremote.DebugSeeds
import com.deepseek.dshremote.data.ConsoleRepository
import com.deepseek.dshremote.data.FeedItem
import com.deepseek.dshremote.data.api.ModelCatalog
import com.deepseek.dshremote.data.api.ModelSelection
import com.deepseek.dshremote.data.api.SessionSummary
import com.deepseek.dshremote.data.api.TaskAccess
import com.deepseek.dshremote.data.api.TaskHost
import com.deepseek.dshremote.data.api.WorkspaceSummary
import com.deepseek.dshremote.data.api.placementNote
import com.deepseek.dshremote.data.store.PendingTurn
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 手机任务页状态（契约 §7.3 + v2.1.0 的 `createdBy` / `host`）。
 *
 * 这里的会话都**由手机发起**（`createdBy:"phone"`），但执行地有两种：
 * - 缺省落**电脑端 DSH**（`source:"computer"`）：电脑上能看到、能接管，权限跟随电脑端设置；
 * - 打开「仅在手机上执行」才落**网关自己的 DSH_HOME + SDK profile**（`source:"phone"`），
 *   这时才轮到权限档说话，手机可以一直续聊。
 */
class PhoneTasksViewModel(private val repository: ConsoleRepository) : ViewModel() {

    data class UiState(
        val tasks: List<SessionSummary> = emptyList(),
        val workspaces: List<WorkspaceSummary> = emptyList(),
        val pending: List<PendingTurn> = emptyList(),
        val feed: List<FeedItem> = emptyList(),
        val online: Boolean = false,
        val refreshing: Boolean = false,
        val creating: Boolean = false,
        val newTaskWorkspace: String = "",
        val newTaskPrompt: String = "",
        /**
         * 「仅在手机上执行」（请求字段 `host`）。**缺省 false = 落在电脑端 DSH**（v2.1.0 的默认）。
         *
         * 打开时才在网关自己的 DSH_HOME 里用 SDK profile 起一轮，这时 [newTaskAccess] 才有意义。
         */
        val newTaskOnPhoneOnly: Boolean = false,
        /** 权限档（契约 §4.2 的 `access`）：**只在 [newTaskOnPhoneOnly] 为真时**发给网关。 */
        val newTaskAccess: TaskAccess = TaskAccess.DEFAULT,
        /**
         * 选定的模型；`null` = **不指定**，按执行端当前模型跑（请求体里连 `model` 都不带）。
         *
         * 为什么不默认填上目录里的默认模型：不选就是不选，请求里少一个字段就少一处撒谎的机会；
         * 界面上那句「默认（<名字>）」是**展示**目录里的默认值，不是替用户做选择。
         */
        val newTaskModel: ModelSelection? = null,
        /** 可选模型目录（`GET /api/v2/models`）。旧网关 → [ModelCatalog.UNKNOWN]，界面整块不画选择器。 */
        val models: ModelCatalog = ModelCatalog.UNKNOWN,
        val loadingModels: Boolean = false,
        /** 模型目录拉取失败的原因；**内联**展示（不弹窗、不进 [message]），不挡住新建任务主流程。 */
        val modelsError: String? = null,
        val createdSessionId: String? = null,
        /**
         * 任务已创建、但**用户选的模型没生效**（网关回执 `modelApplied:false`）。
         *
         * 为真时 [takeReadySessionId] 故意**不给** id：得先让用户看见 [message] 里的原因，
         * 否则界面写着 A 模型、实际跑的是 B，而这条信息一被导航丢掉就再也补不回来。
         */
        val createdNeedsAck: Boolean = false,
        val message: String? = null,
        val isError: Boolean = false,
    ) {
        val canCreate: Boolean
            get() = !creating && newTaskWorkspace.isNotBlank() && newTaskPrompt.isNotBlank()

        /** 请求体里的 `model`：空白视为没选（不许把空串发出去让网关去猜）。 */
        val newTaskModelId: String? get() = newTaskModel?.model?.takeIf { it.isNotBlank() }

        /**
         * 请求体里的 `provider` / `reasoningEffort`：**只跟着 [newTaskModelId] 走**。
         *
         * 单独一个 provider 没有意义（网关据此选不出模型），所以没选模型时一律不带。
         */
        val newTaskProvider: String?
            get() = if (newTaskModelId == null) null else newTaskModel?.provider?.takeIf { it.isNotBlank() }

        val newTaskReasoningEffort: String?
            get() = if (newTaskModelId == null) null else newTaskModel?.reasoningEffort?.takeIf { it.isNotBlank() }

        val liveCount: Int get() = tasks.count { it.live }

        /**
         * 现在就能导航过去的新会话 id。
         *
         * 为 null 只有两种含义：还没建好，或者建好了但[模型没生效][createdNeedsAck]——后者必须先让
         * 用户读到 [message] 里的原因再决定进不进，否则界面写着 A 模型、实际跑的是 B，
         * 而这条信息一被导航丢掉就再也补不回来。
         *
         * 抽成纯属性是为了能被单测钉住（[takeReadySessionId] 用的就是它）。
         */
        val readySessionId: String? get() = createdSessionId?.takeIf { !createdNeedsAck }

        /**
         * 这次新建会落在哪（供对话框文案用）。
         *
         * **缺省是"显式发 `host:"desktop"`"，而不是"省略 host 让网关自己兜底"** —— 这一点是有意为之，
         * 别当成缺陷改回去（Lead 已裁定，记在这里免得后人重犯）：
         * 1. 需求就是「新建任务默认落电脑端」。省略 host 时网关会在桌面端不可用时**静默**改走
         *    网关自己的 DSH_HOME（SDK profile），那段会话在电脑端列表里根本看不见，与需求相反；
         * 2. 显式发 desktop 后，桌面端不可达时用户拿到 `desktop_unavailable` +「打开『仅在手机上执行』」
         *    的可解释失败，而不是"以为跑在电脑上、其实跑在网关里"；
         * 3. 网关侧"未接入则自动改走 gateway"的兜底继续作为**协议层缺省**存在（服务其它客户端/老版本），
         *    与本客户端无关。
         */
        val newTaskHost: String
            get() = if (newTaskOnPhoneOnly) TaskHost.GATEWAY else TaskHost.DESKTOP
    }

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    val relayState: StateFlow<com.deepseek.dshremote.data.relay.RelayState> = repository.relayState

    init {
        viewModelScope.launch {
            combine(
                repository.sessions,
                repository.pending,
                repository.feed,
                repository.online,
            ) { sessions, pending, feed, online ->
                Quad(
                    tasks = sessions.filter { it.isPhoneTask }.sortedByDescending { it.updatedAt },
                    pending = pending,
                    feed = feed,
                    online = online,
                )
            }.collect { quad ->
                _ui.update {
                    it.copy(
                        tasks = quad.tasks,
                        pending = quad.pending,
                        feed = quad.feed,
                        online = quad.online,
                        // 首次拿到列表时默认选中第一个工作区，省掉一次点击
                        newTaskWorkspace = it.newTaskWorkspace.ifBlank {
                            quad.tasks.firstOrNull()?.workspace
                                ?: it.workspaces.firstOrNull { w -> w.exists }?.path.orEmpty()
                        },
                    )
                }
            }
        }
        // 恢复在线后必须把"电脑离线"那条错误收掉：它描述的是**当时**的隧道状态，
        // 隧道已经回来还挂着旧报错，用户会以为必须重启 App（实测反馈）。
        // 只清错误、不动其它提示（"已请求补发待发送队列"这类仍然有效）。
        viewModelScope.launch {
            repository.online.collect { online ->
                if (online) _ui.update { if (it.isError) it.copy(message = null, isError = false) else it }
            }
        }
        refresh()
        loadWorkspaces()
    }

    private data class Quad(
        val tasks: List<SessionSummary>,
        val pending: List<PendingTurn>,
        val feed: List<FeedItem>,
        val online: Boolean,
    )

    fun refresh() {
        if (_ui.value.refreshing) return
        _ui.update { it.copy(refreshing = true) }
        viewModelScope.launch {
            repository.refreshSessions()
                .onFailure { error ->
                    _ui.update { it.copy(message = "刷新失败：${error.friendlyMessage()}", isError = true) }
                }
            _ui.update { it.copy(refreshing = false) }
        }
    }

    private fun loadWorkspaces() {
        viewModelScope.launch {
            repository.loadWorkspaces().onSuccess { list ->
                _ui.update { current ->
                    current.copy(
                        workspaces = list,
                        newTaskWorkspace = current.newTaskWorkspace.ifBlank {
                            list.firstOrNull { it.exists }?.path ?: list.firstOrNull()?.path.orEmpty()
                        },
                    )
                }
            }
        }
    }

    /**
     * 进入「新建任务」对话页时调一次：清掉上一次留下的提示。
     *
     * 成功/失败的横幅不该跨屏重复出现（用户返回再进来还看着三分钟前那条"创建失败"）。
     */
    fun beginDraft() = _ui.update { it.copy(message = null, isError = false) }

    /**
     * 拉一次可选模型目录。
     *
     * 失败只写 [UiState.modelsError] 内联显示，**不**写 [UiState.message]：模型是新建任务里的
     * 附加项，网关旧版本上这个端点根本不存在，不能因此把"新建任务"这一屏变成错误页。
     * 失败时**保留上一次的目录**（老目录比空目录有用：至少还能选）。
     */
    fun loadModels() {
        if (_ui.value.loadingModels) return
        _ui.update { it.copy(loadingModels = true) }
        viewModelScope.launch {
            repository.loadModels()
                .onSuccess { catalog -> _ui.update { it.copy(models = catalog, modelsError = null) } }
                .onFailure { error -> _ui.update { it.copy(modelsError = error.friendlyMessage()) } }
            _ui.update { it.copy(loadingModels = false) }
        }
    }

    /** 选择模型；`null` = 恢复「不指定，按执行端当前模型跑」。 */
    fun onModelChange(selection: ModelSelection?) = _ui.update { it.copy(newTaskModel = selection) }

    fun onWorkspaceChange(path: String) = _ui.update { it.copy(newTaskWorkspace = path) }

    fun onPromptChange(value: String) = _ui.update { it.copy(newTaskPrompt = value) }

    /** 切换权限档（「仅当前工作区」/「全部权限」）；只在「仅在手机上执行」打开时有意义。 */
    fun onAccessChange(access: TaskAccess) = _ui.update { it.copy(newTaskAccess = access) }

    /**
     * 切换「仅在手机上执行」（请求字段 `host`）。
     *
     * 关掉（缺省）时权限档选择器会从界面上消失，但**不清空已选档位**：
     * 用户来回切时不该丢设置；发请求时按 [UiState.newTaskOnPhoneOnly] 决定要不要带上 `access`。
     */
    fun onPhoneOnlyChange(onPhoneOnly: Boolean) = _ui.update { it.copy(newTaskOnPhoneOnly = onPhoneOnly) }

    /** 调试/自动化：示例任务内容（模拟器没有中文输入法，BUILD.md §7.3）。 */
    fun fillDemoTask() = _ui.update {
        it.copy(
            // 真机联调会通过 --es dsh_task_prompt 注入一个便宜的 ASCII prompt，
            // 避免默认示例真的去跑一整套测试（既慢又贵）
            newTaskPrompt = DebugSeeds.taskPrompt
                ?: "在本工作区里跑一遍 android 模块的单元测试，把失败的用例和原因用中文列出来",
        )
    }

    /** 新建手机任务；成功后把新会话 id 交给 UI 导航过去（见 [takeReadySessionId]）。 */
    fun create() {
        val state = _ui.value
        if (!state.canCreate) {
            _ui.update { it.copy(message = "请选择工作区并填写任务内容", isError = true) }
            return
        }
        _ui.update { it.copy(creating = true, message = null) }
        viewModelScope.launch {
            try {
                repository.createPhoneTask(
                    workspace = state.newTaskWorkspace,
                    prompt = state.newTaskPrompt,
                    model = state.newTaskModelId,
                    provider = state.newTaskProvider,
                    reasoningEffort = state.newTaskReasoningEffort,
                    access = state.newTaskAccess,
                    host = state.newTaskHost,
                )
                    .onSuccess { outcome ->
                        if (outcome.sessionId.isEmpty()) {
                            _ui.update { it.copy(message = "任务已提交，但没有拿到会话 id，请下拉刷新列表", isError = true) }
                        } else {
                            // 网关回执说"模型没生效"时必须把它摆在导航之前：任务照跑（这是
                            // 软失败，不是创建失败），但界面不能继续显示用户选的那个模型。
                            val notApplied = outcome.modelWarning?.takeIf { it.isNotBlank() }
                            _ui.update {
                                it.copy(
                                    newTaskPrompt = "",
                                    createdSessionId = outcome.sessionId,
                                    createdNeedsAck = notApplied != null,
                                    message = notApplied?.let { reason ->
                                        "任务已创建，但你选的模型没有生效：$reason（仍按执行端当前模型跑）"
                                    } ?: "任务已创建：${outcome.sessionId.take(24)}${outcome.placementNote()}",
                                    isError = notApplied != null,
                                )
                            }
                        }
                    }
                    .onFailure { error ->
                        // 失败时**保留**用户输入的 prompt 与已选项：重试不该让内容重打一遍
                        _ui.update { it.copy(message = "创建失败：${error.friendlyMessage()}", isError = true) }
                    }
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                _ui.update { it.copy(message = "内部错误：${t.message}", isError = true) }
            } finally {
                _ui.update { it.copy(creating = false) }
            }
        }
    }

    /**
     * 取"可以进对话"的新会话 id（导航用），取到即消费掉。
     *
     * 返回 null 的两种情况：还没创建成功；或者创建成功但**模型没生效**——那时要求用户先看到
     * [UiState.message] 里的原因，再由他点「仍然进入」调 [consumeCreated] 放行。
     */
    fun takeReadySessionId(): String? {
        val id = _ui.value.readySessionId ?: return null
        consumeCreated()
        return id
    }

    /**
     * 用户在「模型没生效」那条提示上点了「仍然进入」：返回新会话 id 并消费掉。
     *
     * 与 [takeReadySessionId] 的区别只有一个：这里**不看** [UiState.createdNeedsAck]——
     * 用户已经读过原因了，这正是他那一下点击的含义。
     */
    fun acknowledgeCreated(): String? {
        val id = _ui.value.createdSessionId ?: return null
        consumeCreated()
        return id
    }

    fun consumeCreated() = _ui.update { it.copy(createdSessionId = null, createdNeedsAck = false) }

    fun flushOutbox() {
        repository.flushOutbox()
        _ui.update { it.copy(message = "已请求补发待发送队列", isError = false) }
    }

    fun clearOutbox() {
        viewModelScope.launch {
            repository.clearOutbox()
            _ui.update { it.copy(message = "已清空待发送队列", isError = false) }
        }
    }

    fun dismissPending(clientTurnId: String) {
        repository.dismissPending(clientTurnId)
        _ui.update { it.copy(message = "已删除该条待发送请求", isError = false) }
    }

    fun consumeMessage() = _ui.update { it.copy(message = null) }
}
