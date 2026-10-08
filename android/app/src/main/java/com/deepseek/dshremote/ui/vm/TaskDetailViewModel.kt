package com.deepseek.dshremote.ui.vm

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.deepseek.dshremote.data.RemoteTask
import com.deepseek.dshremote.data.TaskRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** 任务详情：SSE 实时输出 + 取消 + 终态对账。 */
class TaskDetailViewModel(
    private val repository: TaskRepository,
    private val taskId: String,
) : ViewModel() {

    /**
     * 任务来自"内存实时表"或"本地历史"：刚提交的任务在内存里，重启 App 后从历史里读，
     * 因此离线也能看到上次的输出（需求 4）。
     */
    val task: StateFlow<RemoteTask?> = combine(repository.tasks, repository.history) { tasks, history ->
        tasks[taskId] ?: history.firstOrNull { it.id == taskId }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), repository.tasks.value[taskId])

    val connection = repository.connection

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    private val _canceling = MutableStateFlow(false)
    val canceling: StateFlow<Boolean> = _canceling.asStateFlow()

    private val _deleting = MutableStateFlow(false)
    val deleting: StateFlow<Boolean> = _deleting.asStateFlow()

    init {
        // 进页面时对账一次：断线期间丢的事件靠服务端的累计 output 补齐
        viewModelScope.launch { repository.refresh(taskId) }
    }

    fun cancel() {
        if (_canceling.value) return
        _canceling.value = true
        viewModelScope.launch {
            repository.cancel(taskId)
                .onSuccess { _message.value = "已取消" }
                .onFailure { _message.value = "取消失败：${it.friendlyMessage()}" }
            _canceling.value = false
        }
    }

    /**
     * 删除服务端任务记录（契约 §3.5 / 裁定 A7：仅终态可删）。
     *
     * UI 层只在终态任务上暴露入口，这里再兜一次底：活动态直接本地拒绝，
     * 避免用一次网络往返去换一个必然的 `409 conflict`。
     */
    fun deleteOnServer() {
        if (_deleting.value) return
        val current = task.value
        if (current?.status?.isTerminal != true) {
            _message.value = "该任务仍在执行中，无法删除（conflict）：请先取消或等它结束"
            return
        }
        _deleting.value = true
        viewModelScope.launch {
            repository.deleteRemote(taskId)
                .onSuccess { _message.value = "服务端记录已删除（本地历史保留）" }
                .onFailure { _message.value = "删除失败：${it.friendlyMessage()}" }
            _deleting.value = false
        }
    }

    fun deleteHistory() {
        viewModelScope.launch { repository.deleteHistory(taskId) }
    }
    fun consumeMessage() {
        _message.value = null
    }
}

/** 历史页：只看本地落库的终态任务，不发任何网络请求。 */
class HistoryViewModel(private val repository: TaskRepository) : ViewModel() {

    val history: StateFlow<List<RemoteTask>> = repository.history

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    fun clearAll() {
        viewModelScope.launch {
            repository.clearHistory()
            _message.value = "本地历史已清空"
        }
    }

    fun delete(taskId: String) {
        viewModelScope.launch {
            repository.deleteHistory(taskId)
            _message.value = "已删除该条历史"
        }
    }

    fun consumeMessage() {
        _message.value = null
    }
}
