package com.deepseek.dshremote.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.deepseek.dshremote.data.ConnectionState
import com.deepseek.dshremote.data.RemoteTask
import com.deepseek.dshremote.data.TaskStatus
import com.deepseek.dshremote.ui.theme.OutputTextStyle
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 时间/耗时格式化统一放这里：多处 UI 必须显示一致，否则用户会以为数据不同步。 */
object Fmt {

    private val dateTime = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())
    private val clock = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    fun time(millis: Long?): String =
        if (millis == null || millis <= 0L) "—" else dateTime.format(Date(millis))

    fun clock(millis: Long): String = clock.format(Date(millis))

    /** 耗时：<60s 显示 `12.3s`，否则 `3m12s`，超过 1 小时显示 `1h02m`。 */
    fun duration(millis: Long): String {
        val seconds = (millis / 1000.0).coerceAtLeast(0.0)
        return when {
            seconds < 60 -> String.format(Locale.US, "%.1fs", seconds)
            seconds < 3600 -> "${(seconds / 60).toInt()}m${(seconds % 60).toInt()}s"
            else -> "${(seconds / 3600).toInt()}h${((seconds % 3600) / 60).toInt()}m"
        }
    }

    fun size(chars: Int): String = when {
        chars < 1024 -> "${chars}B"
        chars < 1024 * 1024 -> String.format(Locale.US, "%.1fKB", chars / 1024.0)
        else -> String.format(Locale.US, "%.1fMB", chars / 1024.0 / 1024.0)
    }
}

/** 任务状态的中文名（网关返回的是英文枚举，UI 用中文）。 */
fun TaskStatus.label(): String = when (this) {
    TaskStatus.QUEUED -> "排队中"
    TaskStatus.RUNNING -> "执行中"
    TaskStatus.SUCCEEDED -> "已完成"
    TaskStatus.FAILED -> "失败"
    TaskStatus.CANCELED -> "已取消"
}

fun TaskStatus.chipColor(): Color = when (this) {
    TaskStatus.QUEUED -> Color(0xFF8A97A3)
    TaskStatus.RUNNING -> Color(0xFF4FA3E3)
    TaskStatus.SUCCEEDED -> Color(0xFF4CAF7D)
    TaskStatus.FAILED -> Color(0xFFE05B57)
    TaskStatus.CANCELED -> Color(0xFFB08442)
}

/** 小圆角状态标签。用 [Box] + 背景色而不是 Chip：卡片的横向空间要留给任务标题。 */
@Composable
fun StatusChip(status: TaskStatus, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .background(status.chipColor().copy(alpha = 0.18f), RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(
            text = status.label(),
            style = MaterialTheme.typography.labelMedium,
            color = status.chipColor(),
        )
    }
}

/** SSE 连接状态条：让"没有输出"这件事有明确原因（在重连 vs 真的在跑）。 */
@Composable
fun ConnectionBanner(state: ConnectionState, modifier: Modifier = Modifier) {
    val (text, color) = when (state) {
        is ConnectionState.Connected -> "已连接 · ${Fmt.clock(state.since)} 起接收事件" to Color(0xFF4CAF7D)
        is ConnectionState.Connecting -> "正在连接网关（第 ${state.attempt} 次）" to Color(0xFF4FA3E3)
        is ConnectionState.Retrying ->
            "连接中断，${(state.retryInMs / 1000).coerceAtLeast(0)}s 后重连：${state.reason}" to Color(0xFFE0A252)
        is ConnectionState.Unauthorized -> "设备令牌已失效，请重新配对" to Color(0xFFE05B57)
        is ConnectionState.Failed -> "连接失败：${state.reason}" to Color(0xFFE05B57)
        ConnectionState.Idle -> "未连接（保活已停止）" to Color(0xFF8A97A3)
    }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(color.copy(alpha = 0.12f))
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .background(color, RoundedCornerShape(4.dp)),
        )
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = color,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 输出尾部预览：卡片里只显示最后几行，完整输出在详情页。 */
@Composable
fun OutputPreview(
    output: String,
    maxLines: Int = 3,
    modifier: Modifier = Modifier,
) {
    val tail = remember(output, maxLines) {
        if (output.isEmpty()) {
            "（等待输出…）"
        } else {
            output.trimEnd('\n').lines().takeLast(maxLines).joinToString("\n")
        }
    }
    Text(
        text = tail,
        style = OutputTextStyle,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier.fillMaxWidth(),
    )
}

/**
 * 流式输出视图。
 *
 * 用 [LazyColumn] 逐行渲染而不是一个巨大的 Text：任务输出可能上万行，
 * 单节点文本会让 Compose 每帧重新布局整段，滚动直接卡死。
 *
 * @param autoScroll 为 true 时，输出增长会自动滚到底部（用户手动关掉后不再打扰他回看历史）
 */
@Composable
fun OutputView(
    output: String,
    autoScroll: Boolean,
    modifier: Modifier = Modifier,
) {
    // split 只在 output 变化时执行；LazyColumn 也只组合可见行
    val lines = remember(output) { if (output.isEmpty()) listOf("") else output.split('\n') }
    val listState = rememberLazyListState()

    LaunchedEffect(lines.size, autoScroll) {
        if (autoScroll && lines.isNotEmpty()) {
            listState.scrollToItem(lines.lastIndex)
        }
    }

    LazyColumn(
        state = listState,
        modifier = modifier,
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(1.dp),
    ) {
        itemsIndexed(lines) { _, line ->
            Text(
                text = line.ifEmpty { " " },
                style = OutputTextStyle,
                color = MaterialTheme.colorScheme.onBackground,
            )
        }
    }
}

/** 空状态占位：避免"白屏 + 不知道发生了什么"。 */
@Composable
fun EmptyHint(text: String, modifier: Modifier = Modifier) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = text,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** 任务卡片共用的头部信息行。 */
@Composable
fun TaskMeta(task: RemoteTask, now: Long, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "耗时 ${Fmt.duration(task.durationMs(now))}",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = Fmt.time(task.createdAt),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        task.exitCode?.let {
            Text(
                text = "exit=$it",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
