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
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext
import com.deepseek.dshremote.data.api.DirListing
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
interface WorkspaceDataSource {
    suspend fun loadWorkspaces(): Result<List<WorkspaceSummary>>
    suspend fun loadEntries(path: String, showHidden: Boolean): Result<DirListing>
    suspend fun loadChanges(workspace: String): Result<ChangeSet>
    suspend fun search(query: String, workspace: String?): Result<List<SearchHit>>
}

class WorkspaceViewModel(private val repository: WorkspaceDataSource) : ViewModel() {
    constructor(repository: ConsoleRepository) : this(object : WorkspaceDataSource {
        override suspend fun loadWorkspaces() = repository.loadWorkspaces()
        override suspend fun loadEntries(path: String, showHidden: Boolean) =
            repository.loadEntries(path, depth = 1, showHidden = showHidden)
        override suspend fun loadChanges(workspace: String) = repository.loadChanges(workspace)
        override suspend fun search(query: String, workspace: String?) = repository.search(query, workspace)
    })

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
        val directoryLoading: Boolean = false,
        val workspacesLoading: Boolean = false,
        val changesLoading: Boolean = false,
        val searching: Boolean = false,
        val searchCompleted: Boolean = false,
        val searchError: String? = null,
        val changesError: String? = null,
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
        val loading: Boolean get() = directoryLoading || workspacesLoading || changesLoading || searching
        val crumbs: List<Pair<String, String>> get() = WorkspacePaths.breadcrumbs(relativePath)
        val workspaceLabel: String get() = WorkspaceLabels.label(currentWorkspace).ifEmpty { "工作区" }
        val canGoUp: Boolean get() = relativePath.isNotEmpty()
        val absolutePath: String
            get() = if (currentWorkspace.isEmpty()) "" else WorkspacePaths.absolute(currentWorkspace, relativePath)
    }

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private var bootstrapped = false
    private var workspaceJob: Job? = null
    private var directoryJob: Job? = null
    private var changesJob: Job? = null
    private var searchJob: Job? = null

    fun bootstrap(hint: String? = null) {
        if (bootstrapped && hint.isNullOrEmpty()) return
        reloadWorkspaces(hint)
    }

    private fun reloadWorkspaces(hint: String? = null) {
        workspaceJob?.cancel()
        _ui.update { it.copy(workspacesLoading = true) }
        workspaceJob = viewModelScope.launch {
            val result = repository.loadWorkspaces()
            coroutineContext.ensureActive()
            _ui.update { it.copy(workspacesLoading = false) }
            result.onSuccess { list ->
                bootstrapped = true
                val old = _ui.value.currentWorkspace
                val selected = list.firstOrNull { it.path.equals(hint ?: old, ignoreCase = true) }?.path
                    ?: list.firstOrNull { it.exists }?.path ?: list.firstOrNull()?.path.orEmpty()
                _ui.update { it.copy(workspaces = list, message = null, isError = false) }
                if (selected != old || selected.isEmpty()) resetWorkspace(selected)
                if (selected.isNotEmpty()) {
                    loadDir(_ui.value.relativePath)
                    loadChanges()
                    if (_ui.value.tab == Tab.SEARCH && _ui.value.searchQuery.isNotBlank()) runSearch()
                } else {
                    _ui.update { it.copy(message = "没有可用的工作区，请在电脑端添加工作区后刷新", isError = true) }
                }
            }.onFailure { error ->
                _ui.update { it.copy(message = "加载工作区失败：${error.friendlyMessage()}", isError = true) }
            }
        }
    }

    private fun resetWorkspace(path: String) {
        directoryJob?.cancel()
        changesJob?.cancel()
        searchJob?.cancel()
        _ui.update {
            it.copy(currentWorkspace = path, relativePath = "", entries = emptyList(), changes = null,
                hits = emptyList(), truncated = false, dirError = null, changesError = null,
                searchError = null, searchCompleted = false, directoryLoading = false,
                changesLoading = false, searching = false, message = null, isError = false)
        }
    }

    fun selectWorkspace(path: String) {
        if (path == _ui.value.currentWorkspace) return
        workspaceJob?.cancel()
        _ui.update { it.copy(workspacesLoading = false) }
        resetWorkspace(path)
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

    fun refresh() = reloadWorkspaces()

    fun retryDirectory() = loadDir(_ui.value.relativePath)

    private fun loadDir(relative: String) {
        val state = _ui.value
        if (state.currentWorkspace.isEmpty()) return
        directoryJob?.cancel()
        _ui.update { it.copy(directoryLoading = true, relativePath = relative, entries = emptyList(),
            truncated = false, dirError = null) }
        directoryJob = viewModelScope.launch {
            val absolute = WorkspacePaths.absolute(state.currentWorkspace, relative)
            try {
                repository.loadEntries(absolute, showHidden = state.showHidden)
                    .onSuccess { listing ->
                        coroutineContext.ensureActive()
                        _ui.update {
                            it.copy(
                                relativePath = relative,
                                entries = listing.entries,
                                truncated = listing.truncated,
                                message = null,
                                isError = false,
                                dirError = null,
                            )
                        }
                    }
                    .onFailure { error ->
                        coroutineContext.ensureActive()
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
                coroutineContext.ensureActive()
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
                if (coroutineContext[Job]?.isActive == true) {
                    _ui.update { it.copy(directoryLoading = false) }
                }
            }
        }
    }

    fun loadChanges() {
        val workspace = _ui.value.currentWorkspace
        if (workspace.isEmpty()) return
        changesJob?.cancel()
        _ui.update { it.copy(changesLoading = true, changesError = null) }
        changesJob = viewModelScope.launch {
            val result = repository.loadChanges(workspace)
            coroutineContext.ensureActive()
            _ui.update { it.copy(changesLoading = false) }
            result.onSuccess { changes -> _ui.update { it.copy(changes = changes) } }
                .onFailure { error ->
                    _ui.update { it.copy(changes = null, changesError = error.friendlyMessage()) }
                }
        }
    }

    fun onSearchChange(value: String) {
        searchJob?.cancel()
        _ui.update { it.copy(searchQuery = value, tab = Tab.SEARCH, hits = emptyList(),
            searching = false, searchCompleted = false, searchError = null) }
    }

    fun runSearch() {
        val state = _ui.value
        val query = state.searchQuery.trim()
        searchJob?.cancel()
        if (query.isEmpty() || state.currentWorkspace.isEmpty()) {
            _ui.update { it.copy(hits = emptyList(), searching = false, searchCompleted = false) }
            return
        }
        _ui.update { it.copy(searching = true, tab = Tab.SEARCH, hits = emptyList(), searchError = null) }
        searchJob = viewModelScope.launch {
            val result = repository.search(query, state.currentWorkspace)
            coroutineContext.ensureActive()
            _ui.update { it.copy(searching = false, searchCompleted = true) }
            result.onSuccess { hits -> _ui.update { it.copy(hits = hits) } }
                .onFailure { error ->
                    _ui.update { it.copy(searchError = error.friendlyMessage()) }
                }
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
