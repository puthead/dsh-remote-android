package com.deepseek.dshremote.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import com.deepseek.dshremote.ui.components.DshSnackbarState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.data.api.SessionSummary
import com.deepseek.dshremote.ui.components.DshCard
import com.deepseek.dshremote.ui.components.DshChip
import com.deepseek.dshremote.ui.components.DshFilterChip
import com.deepseek.dshremote.ui.components.EmptyHint
import com.deepseek.dshremote.ui.components.Fmt
import com.deepseek.dshremote.ui.components.Hairline
import com.deepseek.dshremote.ui.theme.DshError
import com.deepseek.dshremote.ui.theme.DshLive
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSuccess
import com.deepseek.dshremote.ui.theme.DshSurface
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshWarning
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType
import com.deepseek.dshremote.ui.vm.PhoneTasksViewModel
import com.deepseek.dshremote.ui.vm.appViewModel

/** 手机任务的状态档：线上 lastTurn.state 只有 ended / running / aborted，reason 是补充说明。 */
internal enum class TaskPhase(val label: String) {
    Running("运行中"),
    Queued("排队中"),
    Done("已完成"),
    Failed("失败"),
}

internal fun taskPhase(session: SessionSummary): TaskPhase {
    val state = session.lastTurnState?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
    val reason = session.lastTurnReason?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
    return when {
        session.live || state == "running" -> TaskPhase.Running
        // 一轮都没跑过 = 请求已入库但电脑端还没接手，正好对应画稿的「等待电脑端空闲…」
        state == null && session.turns == 0 -> TaskPhase.Queued
        state != null && state != "ended" -> TaskPhase.Failed
        reason != null && reason != "completed" -> TaskPhase.Failed
        else -> TaskPhase.Done
    }
}

/** 任务筛选档：画稿的四个芯片（「排队中」不在芯片里，只在行内显示）。 */
private enum class TaskFilter(val label: String) {
    All("全部"),
    Running("运行中"),
    Done("已完成"),
    Failed("失败"),
    ;

    fun matches(session: SessionSummary): Boolean = when (this) {
        All -> true
        Running -> taskPhase(session) == TaskPhase.Running
        Done -> taskPhase(session) == TaskPhase.Done
        Failed -> taskPhase(session) == TaskPhase.Failed
    }
}

@Composable
fun PhoneTasksScreen(onOpenSession: (String) -> Unit, onCreateTask: () -> Unit) {
    val viewModel = appViewModel { PhoneTasksViewModel(Graph.repository) }
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val snackbarHostState = remember { DshSnackbarState() }
    // 手机任务的条数是本地量级（几十条），搜索直接在本地过滤；VM 没有 query 支持，也不该为它加。
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(TaskFilter.All) }

    // 一个界面里 LaunchedEffect 收到 message 就弹 snackbar，收到 createdSessionId 就打开会话。
    // snackbar 展示完要把 message 消费掉，否则每次回到本页同一条会反复弹（判据见 MessageConsumption.kt）。
    LaunchedEffect(ui.message) {
        val shown = ui.message ?: return@LaunchedEffect
        snackbarHostState.showMessage(shown)
        if (shouldConsumeSnackbarMessage(ui.message, ui.isError)) viewModel.consumeMessage()
    }
    // 新建任务现在在那条独立路由（NewTaskScreen）里完成，创建成功后由它自己跳会话详情；
    // 这里保留同一条"就绪即跳"的通道，只是必须经过 takeReadySessionId()——模型没生效时它会
    // 故意不给 id（原因得先让用户看见），否则本页会在用户还没读到原因时就把人推进对话。
    LaunchedEffect(ui.createdSessionId, ui.createdNeedsAck) {
        viewModel.takeReadySessionId()?.let(onOpenSession)
    }

    val visible = ui.tasks
        .filter { filter.matches(it) }
        .filter { session ->
            query.isBlank() ||
                session.title.contains(query, ignoreCase = true) ||
                session.workspaceLabel.contains(query, ignoreCase = true)
        }
    // 画稿里排队行显示「队列第 2 位」，位次只能在已加载的任务里推——真实队列在电脑端。
    val queuePositions = remember(ui.tasks) {
        ui.tasks.asSequence()
            .filter { taskPhase(it) == TaskPhase.Queued }
            .mapIndexed { index, session -> session.id to index + 1 }
            .toMap()
    }

    SessionListScaffold(
        title = "手机任务",
        subtitle = taskSubtitle(ui),
        subtitleWarning = !ui.online,
        snackbarHostState = snackbarHostState,
        refreshing = ui.refreshing,
        onRefresh = viewModel::refresh,
        query = query,
        onQueryChange = { query = it },
        emptyHint = if (query.isBlank()) {
            "还没有手机发起的任务。点上面的「新建任务」写一句话交给电脑端。"
        } else {
            "没有匹配「$query」的任务。"
        },
        isEmpty = visible.isEmpty(),
        // 画稿 04 没有中继横幅：离线状态靠副标题（琥珀色）表达，省下 42dp 给列表
        aboveFilters = { CreateTaskCard(onClick = onCreateTask) },
        filterRow = {
            TaskFilter.entries.forEach { option ->
                val count = ui.tasks.count { option.matches(it) }
                DshFilterChip(
                    text = "${option.label} $count",
                    selected = filter == option,
                    onClick = { filter = option },
                )
            }
        },
        rows = {
            val dimens = LocalDshDimens.current
            visible.forEachIndexed { index, task ->
                TaskRowItem(
                    session = task,
                    phase = taskPhase(task),
                    queuePosition = queuePositions[task.id],
                    onClick = { onOpenSession(task.id) },
                )
                if (index != visible.lastIndex) Hairline(inset = dimens.hairlineInset)
            }
        },
        listTail = { TaskHintCard() },
        footer = {
            if (ui.pending.isNotEmpty() || ui.feed.isNotEmpty()) {
                TaskFooter(
                    ui = ui,
                    onFlush = viewModel::flushOutbox,
                    onClear = viewModel::clearOutbox,
                    onDismiss = viewModel::dismissPending,
                )
            }
        },
    )

    // 新建任务不再是本页的弹窗：创建入口统一走 ROUTE_NEW_TASK（NewTaskScreen），
    // 那一屏本身就是对话界面，工作区/权限/模型都在里面选。
}

/** 页头副标题：画稿是「已发起 12 · 默认电脑端执行」，告警性的信息排在最前面，免得被 maxLines=1 截掉。 */
private fun taskSubtitle(ui: PhoneTasksViewModel.UiState): String = buildString {
    append("已发起 ${ui.tasks.size} · 默认电脑端执行")
    if (!ui.online) append(" · 电脑离线")
    if (ui.liveCount > 0) append(" · ${ui.liveCount} 个运行中")
    if (ui.pending.isNotEmpty()) append(" · 待发 ${ui.pending.size}")
}

/** 任务行：行高固定 rowTask(88dp)，标题/预览/元信息三行对齐画稿的 +13/+40/+63。 */
@Composable
private fun TaskRowItem(
    session: SessionSummary,
    phase: TaskPhase,
    queuePosition: Int?,
    onClick: () -> Unit,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .height(dimens.rowTask)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = dimens.cardPad, end = dimens.cardPad, top = 13.dp, bottom = 5.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = session.title.ifBlank { session.id },
                style = type.cardTitle,
                color = DshOnBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(dimens.gapChip))
            TaskStatusPill(phase)
        }
        Spacer(Modifier.height(3.dp))
        Text(
            text = taskPreview(session, phase),
            style = type.label,
            color = if (phase == TaskPhase.Failed) DshError else DshOnSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(7.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            DshChip(
                text = session.workspaceLabel,
                containerColor = DshSurfaceVariant,
                contentColor = DshOnSurfaceVariant,
                borderColor = null,
                height = dimens.chipHeightSmall,
            )
            Spacer(Modifier.width(dimens.gapChip))
            Text(
                text = taskMeta(session, phase, queuePosition),
                style = type.tiny.copy(fontFamily = type.monoMeta.fontFamily),
                color = DshOnSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** 状态胶囊：底色/描边由状态色压到卡面上得到，运行中额外带一个亮绿点。 */
@Composable
private fun TaskStatusPill(phase: TaskPhase) {
    val color = when (phase) {
        TaskPhase.Running -> DshPrimary
        TaskPhase.Done -> DshSuccess
        TaskPhase.Queued -> DshOnSurfaceVariant
        TaskPhase.Failed -> DshError
    }
    DshChip(
        text = phase.label,
        containerColor = color.copy(alpha = 0.10f),
        contentColor = color,
        borderColor = color.copy(alpha = 0.32f),
        leadingDotColor = if (phase == TaskPhase.Running) DshLive else null,
    )
}

/** 预览行：没有消息正文可用，用运行阶段 + 真实计数拼一句；失败时用最后中断原因。 */
private fun taskPreview(session: SessionSummary, phase: TaskPhase): String = when (phase) {
    TaskPhase.Queued -> "等待电脑端空闲…"
    TaskPhase.Running -> "正在执行 · 已记录 ${session.turns} 轮 ${session.steps} 步"
    TaskPhase.Failed -> "上一轮中断：${session.lastTurnReason?.takeIf { it.isNotBlank() } ?: "原因未回传"}"
    TaskPhase.Done -> "执行完成 · ${session.turns} 轮 ${session.steps} 步"
}

/** 元信息：排队中给队列位次，其余给真实耗时（updatedAt − createdAt）。 */
private fun taskMeta(session: SessionSummary, phase: TaskPhase, queuePosition: Int?): String {
    val head = if (phase == TaskPhase.Queued && queuePosition != null) {
        "队列第 $queuePosition 位"
    } else {
        "耗时 ${Fmt.duration(session.updatedAt - session.createdAt)}"
    }
    return "$head   ·   ${sessionStamp(session.updatedAt)}"
}

/** 「新建任务」卡：画稿 320×62dp，圆角 16dp，左 32dp 陶土橙圆加号。 */
@Composable
private fun CreateTaskCard(onClick: () -> Unit) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    DshCard(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick),
        containerColor = DshSurfaceVariant,
        borderColor = DshOutline,
        radius = DshRadius.Card,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(62.dp)
                .padding(horizontal = dimens.cardPad),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(DshPrimary),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Default.Add,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(18.dp),
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "新建任务",
                    style = type.cardTitle,
                    color = DshOnBackground,
                    maxLines = 1,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = "写一句话，交给电脑端 DSH 执行",
                    style = type.labelTight,
                    color = DshOnSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = DshNeutral,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

/** 列表尾部提示卡：只写两件真实存在的事（追问续聊、离线队列补发），不编造「一键重跑」。 */
@Composable
private fun TaskHintCard() {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    DshCard(
        modifier = Modifier.fillMaxWidth(),
        containerColor = DshSurfaceVariant,
        borderColor = DshOutline,
        radius = DshRadius.Panel,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(dimens.cardPad),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                imageVector = Icons.Default.Warning,
                contentDescription = null,
                tint = DshWarning,
                modifier = Modifier.size(16.dp),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "失败或中断的任务可以点进会话继续追问，输出会实时同步回来",
                    style = type.label,
                    color = DshOnBackground,
                )
                Spacer(Modifier.height(3.dp))
                Text(
                    text = "电脑离线时写下的内容会进待发队列，隧道恢复后自动补发（每条最多重试 3 次）",
                    style = type.meta,
                    color = DshOnSurfaceVariant,
                )
            }
        }
    }
}

/**
 * 离线队列 + 最近动态：这两块是「手机任务」页原来就有的底部信息区，
 * 这里只改形态与密度（芯片式操作 + 更紧的行高），功能和真实字段完全保留。
 */
@Composable
private fun TaskFooter(
    ui: PhoneTasksViewModel.UiState,
    onFlush: () -> Unit,
    onClear: () -> Unit,
    onDismiss: (String) -> Unit,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    // 「最近动态」默认收起：首屏密度对齐画稿 04，展开态才是逐条 SSE 台账。
    var feedExpanded by rememberSaveable { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 260.dp)
            .padding(horizontal = dimens.pageMargin, vertical = dimens.gapChip),
        verticalArrangement = Arrangement.spacedBy(dimens.gapNode),
    ) {
        if (ui.pending.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "待发 ${ui.pending.size} 条（离线排队）",
                    style = type.meta.copy(fontWeight = FontWeight.Bold),
                    color = DshOnSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                DshChip(text = "立即补发", onClick = onFlush)
                Spacer(Modifier.width(dimens.gapNode))
                DshChip(text = "清空", onClick = onClear)
            }
            LazyColumn(modifier = Modifier.heightIn(max = 120.dp)) {
                // key 必须带上插入下标：OutboxCodec 允许 clientTurnId 为空串（只校验 sessionId/prompt），
                // 两条空 id 的待发项会撞成同一个 key → LazyColumn 直接抛
                // IllegalArgumentException("Key ... was already used") 把进程带崩。
                itemsIndexed(ui.pending, key = { index, turn -> "${turn.clientTurnId}:$index" }) { _, turn ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = turn.preview,
                            style = type.label,
                            color = DshOnBackground,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(dimens.gapChip))
                        Text(
                            text = "尝试 ${turn.attempts}/3",
                            style = type.monoMeta,
                            color = DshOnSurfaceVariant,
                            maxLines = 1,
                        )
                        Spacer(Modifier.width(dimens.gapChip))
                        DshChip(text = "删除", onClick = { onDismiss(turn.clientTurnId) })
                    }
                }
            }
        }
        if (ui.feed.isNotEmpty()) {
            // 画稿 04 的默认视图里没有这块增量台账（它是本页原有的真实功能，不能删字段）：
            // 改成默认收起的一行摘要，点一下才展开原来的逐条列表 —— 首屏密度与画稿一致，信息一条不少。
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(DshRadius.Sub))
                    .clickable(role = Role.Button) { feedExpanded = !feedExpanded }
                    .padding(horizontal = 10.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "最近动态 · ${ui.feed.size} 条",
                    style = type.meta.copy(fontWeight = FontWeight.Bold),
                    color = DshOnSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                if (!feedExpanded) {
                    Text(
                        text = Fmt.clock(ui.feed.first().at),
                        style = type.monoMeta,
                        color = DshOnSurfaceVariant,
                    )
                    Spacer(Modifier.width(dimens.gapNode))
                }
                Icon(
                    imageVector = Icons.Filled.KeyboardArrowDown,
                    contentDescription = if (feedExpanded) "收起最近动态" else "展开最近动态",
                    tint = DshOnSurfaceVariant,
                    modifier = Modifier
                        .size(16.dp)
                        .rotate(if (feedExpanded) 180f else 0f),
                )
            }
            if (feedExpanded) {
            LazyColumn(modifier = Modifier.heightIn(max = 110.dp)) {
                // 同理：turn.ended / approval.decided 这类项的 seq 取的是 busCursor，两条事件可能
                // 共用同一个游标；tool.call/tool.result 还会退化成 seq=0，key 里补下标才唯一。
                itemsIndexed(ui.feed, key = { index, item -> "${item.sessionId}:${item.seq}:$index" }) { _, item ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = item.kind,
                            style = type.meta,
                            color = if (item.isError) DshError else DshNeutral,
                            maxLines = 1,
                        )
                        Spacer(Modifier.width(dimens.gapChip))
                        Text(
                            text = item.text,
                            style = type.label,
                            color = DshOnBackground,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(dimens.gapChip))
                        Text(
                            text = Fmt.clock(item.at),
                            style = type.monoMeta,
                            color = DshOnSurfaceVariant,
                            maxLines = 1,
                        )
                    }
                }
            }
            }
        }
    }
}



