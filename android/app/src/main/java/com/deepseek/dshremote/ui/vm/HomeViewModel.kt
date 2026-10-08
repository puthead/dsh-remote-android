package com.deepseek.dshremote.ui.vm

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.deepseek.dshremote.data.RemoteTask
import com.deepseek.dshremote.data.TaskRepository
import com.deepseek.dshremote.data.WorkspaceInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** 首页：提交任务 + 看活动任务。 */
class HomeViewModel(private val repository: TaskRepository) : ViewModel() {

    data class UiState(
        val prompt: String = "",
        val title: String = "",
        /** 工作区白名单拉取失败时的手动兜底输入（网关未就绪/白名单为空时仍可联调）。 */
        val manualWorkspace: String = "",
        val workspaces: List<WorkspaceInfo> = emptyList(),
        val selectedWorkspace: String? = null,
        val loadingWorkspaces: Boolean = false,
        val workspacesError: String? = null,
        val submitting: Boolean = false,
        val message: String? = null,
    ) {
        val effectiveWorkspace: String?
            get() = selectedWorkspace?.takeIf { it.isNotBlank() }
                ?: manualWorkspace.trim().takeIf { it.isNotBlank() }

        /** 提交按钮的可用性：这三个条件缺一不可（需求 6：防重复提交）。 */
        val canSubmit: Boolean
            get() = !submitting && prompt.isNotBlank() && effectiveWorkspace != null
    }

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    val tasks: StateFlow<Map<String, RemoteTask>> = repository.tasks
    val history: StateFlow<List<RemoteTask>> = repository.history
    val connection = repository.connection
    val settings = repository.settings

    /** 提交成功后的一次性事件，用于自动跳到详情页看流式输出。 */
    private val _submittedTaskId = MutableStateFlow<String?>(null)
    val submittedTaskId: StateFlow<String?> = _submittedTaskId.asStateFlow()

    init {
        loadWorkspaces()
        // 冷启动补齐：App 不在线时网关可能已经跑过任务，活动列表以服务端为准
        viewModelScope.launch { repository.refreshActive() }
    }

    fun onPromptChange(value: String) = _ui.update { it.copy(prompt = value) }

    fun onTitleChange(value: String) = _ui.update { it.copy(title = value) }

    fun onManualWorkspaceChange(value: String) = _ui.update { it.copy(manualWorkspace = value) }

    fun selectWorkspace(path: String) = _ui.update { it.copy(selectedWorkspace = path) }

    fun loadWorkspaces() {
        if (_ui.value.loadingWorkspaces) return
        _ui.update { it.copy(loadingWorkspaces = true, workspacesError = null) }
        viewModelScope.launch {
            repository.loadWorkspaces()
                .onSuccess { result ->
                    val preferred = result.default
                        ?: result.workspaces.firstOrNull { it.exists }?.path
                        ?: result.workspaces.firstOrNull()?.path
                    _ui.update { state ->
                        state.copy(
                            workspaces = result.workspaces,
                            selectedWorkspace = state.selectedWorkspace ?: preferred,
                            loadingWorkspaces = false,
                            workspacesError = null,
                        )
                    }
                }
                .onFailure { error ->
                    _ui.update {
                        it.copy(loadingWorkspaces = false, workspacesError = error.friendlyMessage())
                    }
                }
        }
    }

    fun submit() {
        val state = _ui.value
        if (state.submitting) return
        val workspace = state.effectiveWorkspace
        if (workspace == null) {
            _ui.update { it.copy(message = "请选择或填写工作区路径") }
            return
        }
        if (state.prompt.isBlank()) return
        _ui.update { it.copy(submitting = true) }
        viewModelScope.launch {
            val result = repository.submit(
                prompt = state.prompt,
                workspace = workspace,
                title = state.title.trim().ifBlank { null },
            )
            result
                .onSuccess { task ->
                    // 提交成功才清空输入框：失败时保留内容，用户可以直接重试
                    _ui.update {
                        it.copy(submitting = false, prompt = "", title = "", message = "已提交：${task.title.ifBlank { task.id }}")
                    }
                    _submittedTaskId.value = task.id
                }
                .onFailure { error ->
                    _ui.update { it.copy(submitting = false, message = "提交失败：${error.friendlyMessage()}") }
                }
        }
    }

    fun cancel(taskId: String) {
        viewModelScope.launch {
            repository.cancel(taskId)
                .onSuccess { _ui.update { state -> state.copy(message = "已请求取消 ${taskId.take(12)}…") } }
                .onFailure { error -> _ui.update { state -> state.copy(message = "取消失败：${error.friendlyMessage()}") } }
        }
    }

    fun consumeSubmitted() {
        _submittedTaskId.value = null
    }

    fun consumeMessage() = _ui.update { it.copy(message = null) }
}
