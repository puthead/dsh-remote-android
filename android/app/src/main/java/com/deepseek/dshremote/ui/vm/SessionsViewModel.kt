package com.deepseek.dshremote.ui.vm

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.deepseek.dshremote.data.ConsoleRepository
import com.deepseek.dshremote.data.Logger
import com.deepseek.dshremote.data.api.SessionSummary
import com.deepseek.dshremote.data.relay.RelayState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 电脑会话列表页状态。
 *
 * 这一页只列 `source=computer` 的会话。契约更新后它们**不再是只读镜像**：
 * 电脑端 runtime 常驻，服务端对这类会话下发 `writable:true`，手机可以续聊并实时收到
 * 电脑端的执行事件（见 [com.deepseek.dshremote.data.api.SessionSummary.writable]）。
 * 老网关不下发 `writable` 时仍是只读，列表用 [UiState.readOnlyCount] 如实标出来。
 *
 * **默认只列顶层会话**（用户诉求 m00121「子智能体的会话不要全都在手机上面显示」）：
 * 子智能体（subagent）会话是父会话的派生物，DSH 桌面端侧边栏也是直接把它们排除、
 * 只在父会话的目录/右侧栏里出现（见 `dsh-client-ui-workspace/lib/client.js` 的
 * `sessionVisible`：`if (session.origin === "subagent") return false;`）。
 * 想临时看它们时用 [toggleSubagent]，打开后每条都会带 [SessionSummary.derivedLabel]
 * 说明它属于哪个父会话。
 */
class SessionsViewModel(private val repository: ConsoleRepository) : ViewModel() {

    data class UiState(
        val sessions: List<SessionSummary> = emptyList(),
        val refreshing: Boolean = false,
        val includeSubagent: Boolean = false,
        val query: String = "",
        val fromCache: Boolean = false,
        val message: String? = null,
        val isError: Boolean = false,
        val lastLoadedAt: Long = 0L,
    ) {
        /**
         * 过滤后的可见列表（电脑端会话 + 子代理开关 + 关键词）。
         *
         * **两层都要挡**：服务端在 `includeSubagent=false` 时只回顶层会话，
         * 但仓库里那份快照可能来自 `refreshSession`（它按全量抓取，见 ConsoleRepository），
         * 所以这里再按同一条判据 [SessionSummary.isSubagent] 过滤一次。
         */
        val visible: List<SessionSummary>
            get() = sessions
                .filter { it.isComputerSession }
                .filter { includeSubagent || !it.isSubagent }
                .filter {
                    query.isBlank() ||
                        it.title.contains(query, ignoreCase = true) ||
                        it.workspace.contains(query, ignoreCase = true) ||
                        it.id.contains(query, ignoreCase = true)
                }

        /** 顶层会话数（**不受开关/搜索影响**）：用来在页头说明"这次少了多少条派生的"。 */
        val topLevelCount: Int
            get() = sessions.count { it.isComputerSession && !it.isSubagent }

        /** 被子代理开关挡掉的派生会话数（关着时 > 0，界面据此提示还有多少条没显示）。 */
        val hiddenDerivedCount: Int get() = if (includeSubagent) 0 else sessions.count { it.isComputerSession && it.isSubagent }

        val liveCount: Int get() = visible.count { it.live }

        /** 可以在手机上续聊的会话数（服务端给了 `writable:true`）。 */
        val resumableCount: Int get() = visible.count { it.writable }

        /** 仍是只读镜像的会话数（老网关不下发 `writable`，或电脑端没把会话交给网关）。 */
        val readOnlyCount: Int get() = visible.count { !it.writable }
    }

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    val relayState: StateFlow<RelayState> = repository.relayState
    val online: StateFlow<Boolean> = repository.online

    init {
        viewModelScope.launch {
            repository.sessions.collect { sessions ->
                _ui.update { it.copy(sessions = sessions) }
            }
        }
        viewModelScope.launch {
            repository.fromCache.collect { cached -> _ui.update { it.copy(fromCache = cached) } }
        }
        refresh()
    }

    fun refresh() {
        if (_ui.value.refreshing) return
        _ui.update { it.copy(refreshing = true, message = null) }
        viewModelScope.launch {
            try {
                repository.refreshSessions(includeSubagent = _ui.value.includeSubagent)
                    .onSuccess { list ->
                        _ui.update { it.copy(lastLoadedAt = System.currentTimeMillis(), message = null) }
                        Logger.i(TAG, "会话列表已刷新 count=${list.size}")
                    }
                    .onFailure { error ->
                        // 离线不算错误：缓存已经填上了列表，这里只给一句说明
                        _ui.update {
                            it.copy(
                                message = "刷新失败：${error.friendlyMessage()}",
                                isError = true,
                            )
                        }
                    }
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                _ui.update { it.copy(message = "内部错误：${t.message}", isError = true) }
            } finally {
                _ui.update { it.copy(refreshing = false) }
            }
        }
    }

    fun onQueryChange(value: String) = _ui.update { it.copy(query = value) }

    /**
     * 「含子代理」开关：打开后**重新向服务端要全量**（`?include=subagent`），
     * 不能只靠本地过滤——清单里没有的会话，本地怎么过滤都变不出来。
     */
    fun toggleSubagent() {
        val next = !_ui.value.includeSubagent
        _ui.update { it.copy(includeSubagent = next) }
        refresh()
    }

    fun consumeMessage() = _ui.update { it.copy(message = null) }

    private companion object {
        const val TAG = "SessionsViewModel"
    }
}
