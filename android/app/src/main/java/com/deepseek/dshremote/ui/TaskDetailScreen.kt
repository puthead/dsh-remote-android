package com.deepseek.dshremote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.VerticalAlignBottom
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.data.RemoteTask
import com.deepseek.dshremote.ui.components.ConnectionBanner
import com.deepseek.dshremote.ui.components.Fmt
import com.deepseek.dshremote.ui.components.OutputView
import com.deepseek.dshremote.ui.components.StatusChip
import com.deepseek.dshremote.ui.vm.TaskDetailViewModel
import com.deepseek.dshremote.ui.vm.appViewModel

/**
 * 任务详情（需求 3）：SSE 实时输出、自动滚动、取消、终态信息、复制全文。
 *
 * 输出区占满剩余高度并独立滚动；头部信息固定，便于一边看输出一边看到状态变化。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailScreen(taskId: String, onBack: () -> Unit) {
    // key = taskId：不同任务必须是不同 ViewModel，否则 second 任务会显示 first 的状态
    val viewModel = appViewModel(key = "detail-$taskId") { TaskDetailViewModel(Graph.repository, taskId) }
    val task by viewModel.task.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val canceling by viewModel.canceling.collectAsStateWithLifecycle()
    val deleting by viewModel.deleting.collectAsStateWithLifecycle()
    val message by viewModel.message.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val clipboard = LocalClipboardManager.current
    var autoScroll by remember { mutableStateOf(true) }

    LaunchedEffect(message) {
        message?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.consumeMessage()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = task?.title?.ifBlank { "任务详情" } ?: "任务详情",
                        maxLines = 1,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    IconButton(onClick = { autoScroll = !autoScroll }) {
                        Icon(
                            imageVector = Icons.Default.VerticalAlignBottom,
                            contentDescription = if (autoScroll) "关闭自动滚动" else "开启自动滚动",
                            tint = if (autoScroll) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                    IconButton(
                        onClick = { clipboard.setText(AnnotatedString(task?.output.orEmpty())) },
                        enabled = !task?.output.isNullOrEmpty(),
                    ) {
                        Icon(Icons.Default.ContentCopy, contentDescription = "复制全文")
                    }
                    if (task?.status?.isActive == true) {
                        IconButton(onClick = viewModel::cancel, enabled = !canceling) {
                            if (canceling) {
                                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                            } else {
                                Icon(
                                    imageVector = Icons.Default.Stop,
                                    contentDescription = "取消任务",
                                    tint = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
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
            task?.let {
                TaskHeader(
                    task = it,
                    deleting = deleting,
                    onDeleteOnServer = viewModel::deleteOnServer,
                )
            }
            OutputView(
                output = task?.output.orEmpty(),
                autoScroll = autoScroll,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            )
        }
    }
}

@Composable
private fun TaskHeader(task: RemoteTask, deleting: Boolean, onDeleteOnServer: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StatusChip(task.status)
                Text("耗时 ${Fmt.duration(task.durationMs())}", style = MaterialTheme.typography.labelMedium)
                task.exitCode?.let {
                    Text("退出码 $it", style = MaterialTheme.typography.labelMedium)
                }
                Text("输出 ${Fmt.size(task.output.length)}", style = MaterialTheme.typography.labelMedium)
            }
            Text(
                text = "工作区 ${task.workspace.ifBlank { "—" }}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = "创建 ${Fmt.time(task.createdAt)} · 开始 ${Fmt.time(task.startedAt)} · 结束 ${Fmt.time(task.finishedAt)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            task.sessionId?.let {
                Text(
                    text = "session $it",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (task.truncated) {
                // 裁定 A5：网关只保留尾部 1 MiB，必须显式告知，不能静默截断
                Text(
                    text = "输出过长，仅显示最近 1 MiB",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }
            task.error?.takeIf { it.isNotBlank() }?.let { error ->
                Text(
                    text = "错误：$error",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            // 契约 §3.5：仅终态可删；活动态不显示入口，避免必然的 409 conflict
            if (task.status.isTerminal) {
                TextButton(onClick = onDeleteOnServer, enabled = !deleting) {
                    Icon(
                        imageVector = Icons.Default.Delete,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                    )
                    Text(
                        text = if (deleting) "删除中…" else "删除服务端记录",
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
            }
        }
    }
}
