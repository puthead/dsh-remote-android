package com.deepseek.dshremote.ui.vm

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.deepseek.dshremote.data.ConsoleRepository
import com.deepseek.dshremote.data.api.ChangeSet
import com.deepseek.dshremote.data.api.SearchHit
import com.deepseek.dshremote.data.api.WorkspaceEntry
import com.deepseek.dshremote.data.api.WorkspaceLabels
import com.deepseek.dshremote.data.api.WorkspacePaths
import com.deepseek.dshremote.data.api.WorkspaceSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 工作区页状态：目录树 / 改动列表 / 搜索。
 *
 * 所有路径在发请求前都过一遍 [WorkspacePaths.normalize]（客户端侧第二道闸），
 * 越界直接拒绝，不会打到网关。
 */
class WorkspaceViewModel(private val repository: ConsoleRepository) : ViewModel() {

    enum class Tab { FILES, CHANGES, SEARCH }

    data class UiState(
        val workspaces: List<WorkspaceSummary> = emptyList(),
        val currentWorkspace: String = "",
        val relativePath: String = "",
        val entries: List<WorkspaceEntry> = emptyList(),
        val truncated: Boolean = false,
        val changes: ChangeSet? = null,
        val searchQuery: String = "",
        val hits: List<SearchHit> = emptyList(),
        val tab: Tab = Tab.FILES,
        val loading: Boolean = false,
        val showHidden: Boolean = false,
        val message: String? = null,
        val isError: Boolean = false,
        /**
         * 当前目录**自己**的加载失败原因（成功/空闲为 null）。
         *
         * 为什么必须和 [message] 分开：`entries` 为空有两种完全不同的原因 ——
         * 「目录真的是空的」和「这次列目录失败了」。改动前的文件页只按 `entries.isEmpty()`
         * 画一句「这个目录是空的（或未加载）。」，失败时用户看到的是"空目录"这种假象
         * （现场证据：03-workspace.png 里底部弹的是越界错误，内容区却写着"目录是空的"），
         * 于是"工作区里的文件夹进不去"看起来像"文件夹没了"。这里把失败单独记一份，
         * 文件页据此画错误卡 + 重试，而不是空状态。
         *
         * 只由目录加载路径设置/清空：改动、搜索的失败不该影响文件页。
         */
        val dirError: String? = null,
    ) {
        val crumbs: List<Pair<String, String>> get() = WorkspacePaths.breadcrumbs(relativePath)
        val workspaceLabel: String get() = WorkspaceLabels.label(currentWorkspace).ifEmpty { "工作区" }
        val canGoUp: Boolean get() = relativePath.isNotEmpty()
        val absolutePath: String
            get() = if (currentWorkspace.isEmpty()) "" else WorkspacePaths.absolute(currentWorkspace, relativePath)
    }

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private var bootstrapped = false

    /** 首次进入工作区页；[hint] 是会话详情带过来的工作区路径（优先选中它）。 */
    fun bootstrap(hint: String? = null) {
        if (bootstrapped && hint.isNullOrEmpty()) return
        bootstrapped = true
        viewModelScope.launch {
            _ui.update { it.copy(loading = true) }
            repository.loadWorkspaces()
                .onSuccess { list ->
                    val selected = when {
                        hint != null && list.any { it.path.equals(hint, ignoreCase = true) } -> hint
                        _ui.value.currentWorkspace.isNotEmpty() -> _ui.value.currentWorkspace
                        else -> list.firstOrNull { it.exists }?.path ?: list.firstOrNull()?.path.orEmpty()
                    }
                    _ui.update { it.copy(workspaces = list, currentWorkspace = selected) }
                    if (selected.isNotEmpty()) {
                        loadDir("")
                        loadChanges()
                    } else {
                        _ui.update { it.copy(message = "没有可用的工作区（请检查 PC 网关的白名单配置）", isError = true) }
                    }
                }
                .onFailure { error ->
                    _ui.update { it.copy(message = "加载工作区失败：${error.friendlyMessage()}", isError = true) }
                }
            _ui.update { it.copy(loading = false) }
        }
    }

    fun selectWorkspace(path: String) {
        if (path == _ui.value.currentWorkspace) return
        _ui.update { it.copy(currentWorkspace = path, relativePath = "", entries = emptyList(), changes = null, hits = emptyList(), dirError = null) }
        bootstrapped = true
        loadDir("")
        loadChanges()
    }

    /** 进入子目录（相对路径，或目录树条目给的绝对路径）。 */
    fun openDir(relative: String) {
        val state = _ui.value
        // 面包屑的「工作区根」传进来的是空串：它代表根目录本身，**不是**越界。
        // [WorkspacePaths.normalize] 按契约把空串判成非法（那是给"请求路径必须非空"用的），
        // 所以这里必须先放行根，否则点根面包屑会弹出「路径在工作区之外，已拒绝：」这条
        // 假错误，让人以为工作区根也进不去（2026-10-15 真机链路实测到）。
        if (relative.isBlank()) {
            loadDir("")
            return
        }
        val normalized = WorkspacePaths.normalize(state.currentWorkspace, relative)
        if (normalized == null) {
            // 客户端侧第二道闸拦下的，与网关的 403 必须能区分（文案各自可辨识）
            _ui.update { it.copy(message = "路径在工作区之外，已拒绝：$relative（客户端本地拦截，未发请求）", isError = true, dirError = null) }
            return
        }
        // 目录树的条目路径是绝对路径，[WorkspacePaths.normalize] 先归一成相对路径再发请求：
        // 这样请求里的 path 一定在工作区内，也让面包屑显示的是相对位置。
        loadDir(normalized)
    }

    fun up() {
        val parent = WorkspacePaths.parent(_ui.value.relativePath) ?: return
        loadDir(parent)
    }

    fun refresh() {
        loadDir(_ui.value.relativePath)
        loadChanges()
    }

    private fun loadDir(relative: String) {
        val state = _ui.value
        if (state.currentWorkspace.isEmpty()) return
        viewModelScope.launch {
            _ui.update { it.copy(loading = true) }
            val absolute = WorkspacePaths.absolute(state.currentWorkspace, relative)
            try {
                repository.loadEntries(absolute, depth = 1, showHidden = state.showHidden)
                    .onSuccess { listing ->
                        _ui.update {
                            it.copy(
                                relativePath = relative,
                                entries = listing.entries,
                                truncated = listing.truncated,
                                message = null,
                                dirError = null,
                            )
                        }
                    }
                    .onFailure { error ->
                        // 失败时清空 entries：留着上一次的内容会让人以为"就是这个目录的内容"
                        _ui.update {
                            it.copy(
                                entries = emptyList(),
                                truncated = false,
                                message = "打开目录失败：${error.friendlyMessage()}",
                                isError = true,
                                dirError = error.friendlyMessage(),
                            )
                        }
                    }
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                _ui.update {
                    it.copy(
                        entries = emptyList(),
                        truncated = false,
                        message = "内部错误：${t.message}",
                        isError = true,
                        dirError = t.message ?: "内部错误",
                    )
                }
            } finally {
                _ui.update { it.copy(loading = false) }
            }
        }
    }

    fun loadChanges() {
        val state = _ui.value
        if (state.currentWorkspace.isEmpty()) return
        viewModelScope.launch {
            repository.loadChanges(state.currentWorkspace)
                .onSuccess { changes -> _ui.update { it.copy(changes = changes) } }
                .onFailure { error ->
                    _ui.update { it.copy(message = "加载改动失败：${error.friendlyMessage()}", isError = true) }
                }
        }
    }

    fun onSearchChange(value: String) = _ui.update { it.copy(searchQuery = value, tab = Tab.SEARCH) }

    fun runSearch() {
        val state = _ui.value
        val query = state.searchQuery.trim()
        if (query.isEmpty()) {
            _ui.update { it.copy(hits = emptyList(), message = "请输入搜索关键词", isError = true) }
            return
        }
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, tab = Tab.SEARCH) }
            repository.search(query, state.currentWorkspace.ifEmpty { null })
                .onSuccess { hits ->
                    _ui.update {
                        it.copy(
                            hits = hits,
                            message = if (hits.isEmpty()) "没有匹配结果" else "命中 ${hits.size} 条",
                            isError = false,
                        )
                    }
                }
                .onFailure { error ->
                    _ui.update { it.copy(message = "搜索失败：${error.friendlyMessage()}", isError = true) }
                }
            _ui.update { it.copy(loading = false) }
        }
    }

    fun setTab(tab: Tab) {
        _ui.update { it.copy(tab = tab) }
        if (tab == Tab.CHANGES && _ui.value.changes == null) loadChanges()
    }

    fun toggleHidden() {
        val next = !_ui.value.showHidden
        _ui.update { it.copy(showHidden = next) }
        loadDir(_ui.value.relativePath)
    }

    fun consumeMessage() = _ui.update { it.copy(message = null) }
}
