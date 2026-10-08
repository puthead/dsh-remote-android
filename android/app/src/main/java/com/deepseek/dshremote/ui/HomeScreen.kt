package com.deepseek.dshremote.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.data.RemoteTask
import com.deepseek.dshremote.ui.components.ConnectionBanner
import com.deepseek.dshremote.ui.components.EmptyHint
import com.deepseek.dshremote.ui.components.OutputPreview
import com.deepseek.dshremote.ui.components.StatusChip
import com.deepseek.dshremote.ui.components.TaskMeta
import com.deepseek.dshremote.ui.vm.HomeViewModel
import com.deepseek.dshremote.ui.vm.appViewModel
import kotlinx.coroutines.delay

/**
 * 首页（需求 2）：提交任务 + 观察活动任务。
 *
 * 布局刻意把输入区固定在顶部、只让任务列表滚动：键盘弹出时输入框不会被滚出屏幕，
 * 中文输入法的候选栏也不会与列表抢空间。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    onOpenDetail: (String) -> Unit,
    onOpenHistory: () -> Unit,
    onOpenSetup: () -> Unit,
) {
    val viewModel = appViewModel { HomeViewModel(Graph.repository) }
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val tasks by viewModel.tasks.collectAsStateWithLifecycle()
    val history by viewModel.history.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val submittedId by viewModel.submittedTaskId.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(ui.message) {
        ui.message?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.consumeMessage()
        }
    }
    LaunchedEffect(submittedId) {
        submittedId?.let {
            viewModel.consumeSubmitted()
            onOpenDetail(it)
        }
    }

    val activeTasks = remember(tasks) {
        tasks.values.filter { it.status.isActive }.sortedByDescending { it.createdAt }
    }
    val recentDone = remember(history) { history.take(5) }

    // 耗时每秒刷新；集中一个 ticker 而不是每张卡片各起一个协程
    val now by produceState(initialValue = System.currentTimeMillis()) {
        while (true) {
            delay(1_000)
            value = System.currentTimeMillis()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("DSH 远程")
                        Text(
                            text = settings?.serverName?.takeIf { it.isNotBlank() } ?: settings?.baseUrl.orEmpty(),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.loadWorkspaces() }) {
                        Icon(Icons.Default.Refresh, contentDescription = "刷新工作区")
                    }
                    IconButton(onClick = onOpenHistory) {
                        Icon(Icons.Default.History, contentDescription = "历史")
                    }
                    IconButton(onClick = onOpenSetup) {
                        Icon(Icons.Default.Settings, contentDescription = "设置")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            ConnectionBanner(connection)

            SubmitCard(
                ui = ui,
                onPromptChange = viewModel::onPromptChange,
                onTitleChange = viewModel::onTitleChange,
                onManualWorkspaceChange = viewModel::onManualWorkspaceChange,
                onSelectWorkspace = viewModel::selectWorkspace,
                onSubmit = viewModel::submit,
            )

            Text(
                text = "活动任务（${activeTasks.size}）",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(start = 16.dp, top = 8.dp, bottom = 4.dp),
            )

            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = 16.dp,
                    end = 16.dp,
                    bottom = 24.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (activeTasks.isEmpty()) {
                    item {
                        EmptyHint("当前没有活动任务。提交后这里会显示状态、耗时与实时输出尾部。")
                    }
                }
                items(activeTasks, key = { it.id }) { task ->
                    TaskCard(
                        task = task,
                        now = now,
                        onClick = { onOpenDetail(task.id) },
                        onCancel = { viewModel.cancel(task.id) },
                    )
                }

                if (recentDone.isNotEmpty()) {
                    item {
                        Text(
                            text = "最近完成（本地历史）",
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                    items(recentDone, key = { "history-${it.id}" }) { task ->
                        TaskCard(task = task, now = now, onClick = { onOpenDetail(task.id) }, onCancel = null)
                    }
                    item {
                        TextButton(onClick = onOpenHistory) { Text("查看全部历史") }
                    }
                }
            }
        }
    }
}

@Composable
private fun SubmitCard(
    ui: HomeViewModel.UiState,
    onPromptChange: (String) -> Unit,
    onTitleChange: (String) -> Unit,
    onManualWorkspaceChange: (String) -> Unit,
    onSelectWorkspace: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            OutlinedTextField(
                value = ui.prompt,
                onValueChange = onPromptChange,
                label = { Text("任务内容") },
                placeholder = { Text("例如：把 D:\\proj 的单测跑一遍，失败就修到通过") },
                minLines = 3,
                maxLines = 8,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = ui.title,
                onValueChange = onTitleChange,
                label = { Text("标题（可选，留空由网关取前 40 字）") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            WorkspacePicker(ui = ui, onSelect = onSelectWorkspace, onManual = onManualWorkspaceChange)

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (ui.submitting) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    Text(
                        text = "提交中…",
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(start = 8.dp, end = 12.dp),
                    )
                }
                Button(onClick = onSubmit, enabled = ui.canSubmit) {
                    Icon(Icons.Default.Send, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("提交任务", modifier = Modifier.padding(start = 6.dp))
                }
            }

            ui.workspacesError?.let {
                Text(
                    text = "工作区列表获取失败：$it\n可直接在下面手动填写绝对路径。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun WorkspacePicker(
    ui: HomeViewModel.UiState,
    onSelect: (String) -> Unit,
    onManual: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box {
                OutlinedButton(onClick = { expanded = true }, enabled = ui.workspaces.isNotEmpty()) {
                    Text(
                        text = ui.selectedWorkspace ?: "选择工作区",
                        maxLines = 1,
                    )
                    Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                }
                DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    ui.workspaces.forEach { workspace ->
                        DropdownMenuItem(
                            text = {
                                Column {
                                    Text(workspace.label.ifBlank { workspace.path })
                                    Text(
                                        text = workspace.path + if (workspace.exists) "" else "（不存在）",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            },
                            enabled = workspace.exists,
                            onClick = {
                                onSelect(workspace.path)
                                expanded = false
                            },
                        )
                    }
                }
            }
            if (ui.loadingWorkspaces) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            }
        }

        if (ui.workspaces.isEmpty()) {
            OutlinedTextField(
                value = ui.manualWorkspace,
                onValueChange = onManual,
                label = { Text("工作区绝对路径") },
                placeholder = { Text("D:\\proj") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun TaskCard(
    task: RemoteTask,
    now: Long,
    onClick: () -> Unit,
    onCancel: (() -> Unit)?,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = task.title.ifBlank { task.prompt.take(40).ifBlank { task.id } },
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                    maxLines = 2,
                )
                StatusChip(task.status)
            }
            TaskMeta(task = task, now = now)
            OutputPreview(output = task.output)
            if (onCancel != null && task.status.isActive) {
                Text(
                    text = "取消任务",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .clickable(onClick = onCancel)
                        .padding(vertical = 4.dp),
                )
            }
        }
    }
}
