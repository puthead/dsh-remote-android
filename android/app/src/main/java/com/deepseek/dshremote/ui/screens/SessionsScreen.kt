package com.deepseek.dshremote.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import com.deepseek.dshremote.ui.components.DshSnackbarHost
import com.deepseek.dshremote.ui.components.DshSnackbarState
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.data.api.SessionSummary
import com.deepseek.dshremote.data.relay.RelayState
import com.deepseek.dshremote.ui.components.DshCard
import com.deepseek.dshremote.ui.components.DshChip
import com.deepseek.dshremote.ui.components.DshIconButton
import com.deepseek.dshremote.ui.components.DshPageContainer
import com.deepseek.dshremote.ui.components.DshPageHeader
import com.deepseek.dshremote.ui.components.DshStatusBanner
import com.deepseek.dshremote.ui.components.DshTone
import com.deepseek.dshremote.ui.components.Fmt
import com.deepseek.dshremote.ui.components.Hairline
import com.deepseek.dshremote.ui.theme.DshBackground
import com.deepseek.dshremote.ui.theme.DshError
import com.deepseek.dshremote.ui.theme.DshLive
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshSurfaceHigh
import com.deepseek.dshremote.ui.theme.DshWarning
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType
import com.deepseek.dshremote.ui.vm.SessionsViewModel
import com.deepseek.dshremote.ui.vm.appViewModel
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch

// region 电脑会话页（画稿 01）

/** 列表时间戳：今天只给 HH:mm、昨天给「昨天 HH:mm」、更早给 MM-dd HH:mm（画稿里就是这三种形态）。 */
private val sessionTimeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
private val sessionDayFormat = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())
private const val DayMillis = 24L * 60L * 60L * 1000L

internal fun sessionStamp(at: Long, now: Long = System.currentTimeMillis()): String {
    if (at <= 0L) return "—"
    val todayStart = Calendar.getInstance().apply {
        timeInMillis = now
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }.timeInMillis
    return when {
        at >= todayStart -> sessionTimeFormat.format(Date(at))
        at >= todayStart - DayMillis -> "昨天 ${sessionTimeFormat.format(Date(at))}"
        else -> sessionDayFormat.format(Date(at))
    }
}

/** 页脚「更新于 HH:mm」。 */
internal fun sessionClock(at: Long): String =
    if (at <= 0L) "尚未更新" else sessionTimeFormat.format(Date(at))

/** 会话筛选档：四个芯片，计数全部由数据算出来，不写死。 */
private enum class SessionFilter(val label: String) {
    All("全部"),
    Live("进行中"),
    Phone("手机发起"),
    ReadOnly("只读"),
    ;

    fun matches(session: SessionSummary): Boolean = when (this) {
        All -> true
        Live -> session.live
        Phone -> session.isPhoneTask
        ReadOnly -> !session.writable
    }
}

@Composable
fun ComputerSessionsScreen(onOpenSession: (String) -> Unit, onCreateTask: () -> Unit) {
    val viewModel = appViewModel { SessionsViewModel(Graph.repository) }
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val relayState by viewModel.relayState.collectAsStateWithLifecycle()
    val snackbarHostState = remember { DshSnackbarState() }
    val scope = rememberCoroutineScope()
    var filter by rememberSaveable { mutableStateOf(SessionFilter.All) }

    // 右下 FAB = 新建任务：本页没有「新建会话」能力，而新建任务默认就是「手机发起 · 电脑执行」，
    // 新会话正好落在本列表里。所以这里的 FAB 和手机任务页的「新建任务」卡片走**同一条**入口
    // （ROUTE_NEW_TASK → NewTaskScreen，那一屏创建成功后自己跳会话详情），
    // 不再各自持有一份创建弹窗和一个独立的 ViewModel——两个入口的默认行为不会慢慢漂开。
    //
    // 展示完就消费掉：message 不清空的话，每次回到本页都会用没变的 key 重跑一遍，同一条反复弹。
    // 只消费非错误提示，错误原因要留在屏幕上（判据与完整理由见 MessageConsumption.kt）。
    LaunchedEffect(ui.message) {
        val shown = ui.message ?: return@LaunchedEffect
        snackbarHostState.showMessage(shown)
        if (shouldConsumeSnackbarMessage(ui.message, ui.isError)) viewModel.consumeMessage()
    }

    val visible = ui.visible.filter { filter.matches(it) }
    // 脚注的分母要跟着"这次列了什么"走：关着子代理时若仍报"已加载 29 / 138 条"，
    // 用户会以为列表漏了一大半（其实是按设计藏起来的派生会话）。
    val computerTotal = if (ui.includeSubagent) ui.sessions.count { it.isComputerSession } else ui.topLevelCount
    // 首屏加载：一条都还没有、正在刷、且不是"刷新失败后的空缓存"——只有这时才用骨架，
    // 否则离线冷启动会先闪一屏骨架再跳空态提示，比直接给空态更晃眼。
    val firstLoad = ui.sessions.isEmpty() && ui.refreshing && !ui.isError

    SessionListScaffold(
        title = "DSH 远程",
        subtitle = hostSubtitle(relayState, ui.fromCache),
        subtitleWarning = ui.fromCache,
        snackbarHostState = snackbarHostState,
        refreshing = ui.refreshing,
        onRefresh = viewModel::refresh,
        query = ui.query,
        onQueryChange = viewModel::onQueryChange,
        errorMessage = ui.message?.takeIf { ui.isError },
        onRetry = viewModel::refresh,
        emptyTitle = if (isEmptyBecauseOfFilter(ui, filter)) "没有符合条件的会话" else "还没有电脑端会话",
        emptyHint = if (ui.query.isBlank()) {
            when {
                // 默认视图空了但子代理会话确实存在：必须给出"东西没丢，只是收起来了"的出口
                !ui.includeSubagent && ui.sessions.any { it.isComputerSession } ->
                    "这里只列顶层会话。当前这些会话都是子智能体的派生物，打开上方「含子代理」即可查看。"
                else -> "在电脑端开一个 DSH 会话，它会自动出现在这里；也可以点下面的按钮，用手机发一句话让电脑端跑。"
            }
        } else {
            "没有匹配「${ui.query}」的会话。"
        },
        isEmpty = visible.isEmpty(),
        loading = firstLoad,
        emptyAction = onCreateTask,
        banner = {
            ConnectionBanner(
                relayState = relayState,
                onClick = {
                    viewModel.refresh()
                    scope.launch { snackbarHostState.showMessage(bannerHint(relayState)) }
                },
            )
        },
        filterRow = {
            SessionFilter.entries.forEach { option ->
                // 计数按 `ui.sessions`（含被折叠的派生会话）算，再按开关过滤——
                // 这样打开「含子代理」时「全部」会从 29 涨到 138，前后差异一眼可见。
                val pool = ui.sessions.filter { ui.includeSubagent || !it.isSubagent }
                val count = when (option) {
                    SessionFilter.All -> pool.size
                    SessionFilter.Live -> pool.count { it.live }
                    SessionFilter.Phone -> pool.count { it.isPhoneTask }
                    SessionFilter.ReadOnly -> pool.count { !it.writable }
                }
                SessionFilterChip(
                    label = option.label,
                    count = count,
                    selected = filter == option,
                    onClick = { filter = option },
                )
            }
            // 「含子代理」是唯一会改变服务端查询的参数，画稿里没有这个控件，
            // 按 Lead 的指示并进筛选行右侧。它**不是筛选**（不筛掉当前列表，而是换一份数据），
            // 所以不套筛选芯片的实心橙选中态，改用"开关"的形态：开=橙描边 + 轻填充 + 前导点。
            SubagentToggle(
                enabled = ui.includeSubagent,
                hiddenCount = ui.hiddenDerivedCount,
                onClick = viewModel::toggleSubagent,
            )
        },
        rows = {
            val dimens = LocalDshDimens.current
            visible.forEachIndexed { index, session ->
                val status = SessionStatus.resolve(session, stale = ui.fromCache)
                SessionRowItem(
                    session = session,
                    status = status,
                    onClick = { onOpenSession(session.id) },
                    // 只读**不静默**：点行内胶囊给原因，不跳详情页（用户可能只是想知道为什么不能发）
                    onStatusClick = {
                        scope.launch { snackbarHostState.showMessage(status.hint) }
                    },
                )
                if (index != visible.lastIndex) Hairline(inset = dimens.hairlineInset)
            }
        },
        listTail = {
            SessionListFootnote(
                loaded = visible.size,
                total = computerTotal,
                filtered = filter != SessionFilter.All,
                hiddenDerived = ui.hiddenDerivedCount,
                updatedAt = ui.lastLoadedAt,
            )
        },
        fab = {
            SessionFab(
                onClick = onCreateTask,
                modifier = Modifier.align(Alignment.BottomEnd),
            )
        },
    )
}

/**
 * 筛选后为空 ≠ 真的没有会话。
 *
 * 这两件事必须给不同的话：前者要提醒"是筛选挡住的"（并让用户看到筛选芯片还在），
 * 后者才是引导新建。旧版只有一句空文案，用户筛到空列表时会以为会话全没了。
 */
private fun isEmptyBecauseOfFilter(ui: SessionsViewModel.UiState, filter: SessionFilter): Boolean {
    if (ui.sessions.isEmpty()) return false
    if (ui.query.isNotBlank()) return true
    return filter != SessionFilter.All
}

/** 页头副标题：画稿是「主机名 · 已连接」，中继异常时退化成同样长度的真实描述。 */
private fun hostSubtitle(relayState: RelayState, fromCache: Boolean): String {
    val base = when (relayState) {
        is RelayState.Connected -> "${relayState.homeName} · " + if (relayState.homeOnline) "已连接" else "电脑离线"
        RelayState.Idle -> "未连接中继"
        is RelayState.Connecting -> "正在连接中继（第 ${relayState.attempt} 次）"
        is RelayState.Retrying -> "中继重连中"
        is RelayState.Unauthorized -> "配对凭据已失效"
        is RelayState.Failed -> "中继连接失败"
    }
    return if (fromCache) "$base · 离线快照" else base
}

private fun bannerTone(relayState: RelayState): DshTone = when (relayState) {
    is RelayState.Connected -> if (relayState.homeOnline) DshTone.Ok else DshTone.Warn
    is RelayState.Connecting -> DshTone.Info
    is RelayState.Retrying -> DshTone.Warn
    is RelayState.Unauthorized -> DshTone.Err
    is RelayState.Failed -> DshTone.Err
    RelayState.Idle -> DshTone.Warn
}

private fun bannerLabel(relayState: RelayState): String = when (relayState) {
    is RelayState.Connected ->
        if (relayState.homeOnline) "桌面端 DSH 在线 · 隧道正常"
        else "电脑离线：${relayState.homeName} 的隧道已断开"
    RelayState.Idle -> "未连接中继"
    is RelayState.Connecting -> "正在连接中继（第 ${relayState.attempt} 次）"
    is RelayState.Retrying ->
        "中继中断，${(relayState.retryInMs / 1000).coerceAtLeast(1)}s 后重连"
    is RelayState.Unauthorized -> "配对凭据已失效，请重新配对"
    is RelayState.Failed -> "中继连接失败：${relayState.reason}"
}

/**
 * 画稿右侧是延迟胶囊「38 ms」，但协议、RelayState、仓库里都没有任何 rtt/latency 字段
 * （grep 确认），所以退化成真实可得的「已连 X」：连接已建立时才有值。
 */
private fun bannerRight(relayState: RelayState, now: Long = System.currentTimeMillis()): String? =
    when (relayState) {
        is RelayState.Connected ->
            if (relayState.since > 0L) "已连 ${Fmt.duration(now - relayState.since)}" else null
        else -> null
    }

/** 点横幅之后告诉用户"这一下干了什么"——横幅本身没有第二个动作可做，所以点=刷新。 */
private fun bannerHint(relayState: RelayState): String = when (relayState) {
    is RelayState.Connected -> if (relayState.homeOnline) "正在刷新会话列表…" else "正在重连电脑端…"
    is RelayState.Connecting, is RelayState.Retrying -> "正在重连中继…"
    is RelayState.Unauthorized -> "配对凭据已失效，请到设置页重新配对"
    is RelayState.Failed -> "中继连接失败，正在重试…"
    RelayState.Idle -> "未连接中继，请到设置页完成配对"
}

/**
 * 连接状态胶囊：顶部那条横幅现在**可点**（点=刷新；中继异常时同一动作会先等隧道回来）。
 *
 * 为什么不改成右上角一个 24dp 的小胶囊：那句「电脑离线：XXX 的隧道已断开」是需要用户
 * 真读一遍的信息（而不是一眼判色），塞进小胶囊必然被截断。保留 42dp 的横幅形态，
 * 只补上"它能点、点了会发生什么"——用底部 1dp 的按压高亮 + 点击后的 snackbar 反馈表达。
 */
@Composable
private fun ConnectionBanner(relayState: RelayState, onClick: () -> Unit) {
    DshStatusBanner(
        label = bannerLabel(relayState),
        tone = bannerTone(relayState),
        right = bannerRight(relayState),
        modifier = Modifier
            .clip(RoundedCornerShape(DshRadius.Sub))
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = "连接状态，点按刷新会话列表" },
    )
}

/**
 * 会话行 —— 新版信息层级（自上而下三行，**左对齐一条竖线**）：
 *
 * ```
 * ┌ 34dp ┬ 标题（14sp SemiBold，1 行）            [状态胶囊?]   ← 胶囊只在值得说时出现
 * │ 工作 │ 预览（12sp 次要色，1 行，"最后：…"）
 * │ 区图 │ 12 轮 · 3 个文件（等宽 11sp）            3 分钟前   ← 时间戳右对齐
 * └──────┴────────────────────────────────────────────────
 * ```
 *
 * 三处刻意改动（都是为了"看起来像成熟 IM/助手列表"）：
 * 1. **头像位**：以前没有，四行字全靠缩进对齐，眼睛没有落点。现在是 34dp 圆角方块 + 工作区图标，
 *    和标题左边缘拉开 12dp，形成一条稳定的竖直基线。图标而不是首字母：中文首字在 34dp 里
 *    经常被裁成半个字，图标不挑字符集。
 * 2. **状态收成一个胶囊位**（标题右侧）：以前标题行挂状态胶囊、预览行下面还有一排工作区/来源
 *    芯片，同一件事说两遍。现在工作区名进了头像（hover 语义由 contentDescription 给全），
 *    行右侧只剩「状态胶囊 + 时间戳」两个信息。
 * 3. **时间戳用相对时间**（`3 分钟前`）而不是 `HH:mm`：会话列表关心的是"多久没动它了"，
 *    绝对时刻要点进详情才有意义（`Fmt.relative` 与本仓其它页共用同一套口径）。
 */
@Composable
private fun SessionRowItem(
    session: SessionSummary,
    status: SessionStatus,
    onClick: () -> Unit,
    onStatusClick: () -> Unit,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(dimens.rowSessionQuiet)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = dimens.rowPadX, vertical = dimens.rowPadY),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SessionAvatar(session)
        Spacer(Modifier.width(dimens.gapCard))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = session.title.ifBlank { session.id },
                    style = type.cardTitle,
                    color = DshOnBackground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                // 状态胶囊紧贴标题：只有值得说的状态才有这一格，其余行这里直接是空白
                if (status.visible) {
                    Spacer(Modifier.width(dimens.gapChip))
                    SessionStatusChip(status = status, onClick = onStatusClick)
                }
            }
            Spacer(Modifier.height(dimens.gapNode))
            // 派生会话的父子关系标注**替换**预览行（不新增第四行）：父会话名比"最后：…"更能说明这条是什么
            Text(
                text = session.derivedLabel ?: sessionPreviewText(session),
                style = type.label,
                color = DshOnSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(dimens.gapNode))
            Row(verticalAlignment = Alignment.CenterVertically) {
                val meta = sessionMetaLine(session)
                if (meta.isNotEmpty()) {
                    Text(
                        text = meta,
                        style = type.monoMeta,
                        color = DshNeutral,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = Fmt.relative(session.updatedAt),
                    style = type.meta,
                    color = DshNeutral,
                    maxLines = 1,
                )
            }
        }
    }
}

/**
 * 行首工作区标识位。
 *
 * 图标固定用终端（工作区 = 一个 DSH 会话目录）；工作区**名字**放 contentDescription，
 * 而不是画进方块里——`dsh_android`、`dsh_docs` 这类名字截断成两个汉字后互相认不出来，
 * 信息反而丢了。搜索仍然按工作区名匹配（`SessionsViewModel.UiState.visible`）。
 */
@Composable
private fun SessionAvatar(session: SessionSummary) {
    val dimens = LocalDshDimens.current
    Box(
        modifier = Modifier
            .size(dimens.rowAvatar)
            .clip(RoundedCornerShape(DshRadius.Small))
            .background(DshSurfaceHigh)
            .semantics { contentDescription = "工作区 ${session.workspaceLabel}" },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Icons.Default.Terminal,
            contentDescription = null,
            tint = DshOnSurfaceVariant,
            modifier = Modifier.size(dimens.rowAvatarIcon),
        )
    }
}

/**
 * 状态胶囊：**唯一**的行内状态表达。
 *
 * 三档配色刻意不对称——只有「运行中」允许用语义色（它是"正在发生"，主题规则里的强调色白名单），
 * 「只读」用中性灰（它是"事实"，不是告警：绝大多数只读会话只是老网关没下发 writable），
 * 「手机」几乎不着色（它是出处，不是状态）。这样一眼扫过去，整列只有真正在跑的会话是绿的。
 *
 * 不可点时不加 clickable：「只读」需要点出原因（不静默），「运行中」「手机」点了没有更多内容。
 */
@Composable
private fun SessionStatusChip(status: SessionStatus, onClick: () -> Unit) {
    val dimens = LocalDshDimens.current
    val container: Color
    val content: Color
    val border: Color
    when (status.kind) {
        SessionStatus.SessionStatusKind.Live -> {
            container = DshLive.copy(alpha = 0.10f)
            content = DshLive
            border = DshLive.copy(alpha = 0.35f)
        }
        SessionStatus.SessionStatusKind.ReadOnly -> {
            container = DshSurfaceVariant
            content = DshOnSurfaceVariant
            border = DshOutline
        }
        SessionStatus.SessionStatusKind.Phone -> {
            container = Color.Transparent
            content = DshNeutral
            border = DshOutline
        }
        SessionStatus.SessionStatusKind.Idle -> return
    }
    DshChip(
        text = status.label,
        containerColor = container,
        contentColor = content,
        borderColor = border,
        height = dimens.chipHeightSmall,
        leadingDotColor = if (status.showsDot) DshLive else null,
        onClick = onClick.takeIf { status.kind == SessionStatus.SessionStatusKind.ReadOnly },
        modifier = Modifier.semantics { contentDescription = status.hint },
    )
}

/**
 * 筛选芯片（24dp 全圆）。
 *
 * 与公共 `DshFilterChip` 的差别只有一处，但很关键：**计数与标签分层**——
 * 选中态是实心橙上的一枚半透明白数字，未选中态是描边里的灰色小数字。
 * 旧版把 "全部 42" 当一个字符串塞进芯片，42 和「全部」同字重同颜色，
 * 于是计数抢走了标签的注意力（一列芯片全在比数字大）。
 */
@Composable
private fun SessionFilterChip(label: String, count: Int, selected: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(LocalDshDimens.current.chipHeight / 2)
    val container = if (selected) DshPrimary else DshSurfaceVariant
    val content = if (selected) Color.White else DshOnSurfaceVariant
    val border = if (selected) Color.Transparent else DshOutline
    Row(
        modifier = Modifier
            .height(LocalDshDimens.current.chipHeight)
            .clip(shape)
            .background(container)
            .border(LocalDshDimens.current.border, border, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = LocalDshDimens.current.chipPadX),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = LocalDshType.current.meta,
            color = content,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            maxLines = 1,
        )
        Spacer(Modifier.width(5.dp))
        Text(
            text = count.toString(),
            style = LocalDshType.current.badge,
            // 选中态用 80% 白而不是纯白：数字要比标签弱，否则满行都是 42 / 0 / 1
            color = if (selected) Color.White.copy(alpha = 0.80f) else DshNeutral,
            maxLines = 1,
        )
    }
}

/**
 * 「含子代理」开关形态的芯片。
 *
 * 它不是筛选器（不筛当前列表，而是重新向服务端要全量），所以不能长得和筛选芯片一样——
 * 旧版两者共用实心橙选中态，用户会以为它是第五个筛选档。开=橙描边 + 半透明橙填充 + 前导点；
 * 关=虚线感的描边（这里用更暗的描边 + 无填充表达"未启用"），并把被折叠的条数写在标签上：
 * 列表从 138 变 29 时，只有这个数字能解释"少掉的那些去哪了"。
 */
@Composable
private fun SubagentToggle(enabled: Boolean, hiddenCount: Int, onClick: () -> Unit) {
    val shape = RoundedCornerShape(LocalDshDimens.current.chipHeight / 2)
    val container = if (enabled) DshPrimary.copy(alpha = 0.14f) else Color.Transparent
    val content = if (enabled) DshPrimary else DshNeutral
    val border = if (enabled) DshPrimary.copy(alpha = 0.55f) else DshOutline
    val label = when {
        enabled -> "含子代理 开"
        hiddenCount > 0 -> "含子代理 关 · 折叠 $hiddenCount"
        else -> "含子代理 关"
    }
    Row(
        modifier = Modifier
            .height(LocalDshDimens.current.chipHeight)
            .clip(shape)
            .background(container)
            .border(LocalDshDimens.current.border, border, shape)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = LocalDshDimens.current.chipPadX),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(if (enabled) DshPrimary else DshOutline),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = label,
            style = LocalDshType.current.meta,
            color = content,
            maxLines = 1,
        )
    }
}

/**
 * 列表脚注卡：画稿写死「已加载 5 / 17 条」，这里给真实的已加载/筛选分母 + 更新时间。
 *
 * `hiddenDerived > 0` 时额外说明"还有多少条子智能体会话被收起来了"——
 * 这是用户诉求（不要刷屏）与用户预期（别丢会话）之间唯一需要解释的地方。
 */
@Composable
private fun SessionListFootnote(loaded: Int, total: Int, filtered: Boolean, hiddenDerived: Int, updatedAt: Long) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val note = when {
        hiddenDerived > 0 -> " · 已折叠 $hiddenDerived 条子智能体会话"
        filtered -> " · 当前有筛选"
        else -> " · 下拉刷新"
    }
    DshCard(
        modifier = Modifier.fillMaxWidth(),
        containerColor = DshSurfaceVariant,
        borderColor = Color.Transparent,
        radius = DshRadius.Sub,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(40.dp)
                .padding(horizontal = dimens.cardPad),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = if (loaded == total) "已加载 $total 条$note" else "已加载 $loaded / $total 条$note",
                style = type.label,
                color = DshOnSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(dimens.gapChip))
            Text(
                text = "更新于 ${sessionClock(updatedAt)}",
                style = type.label,
                color = DshOnSurfaceVariant,
                maxLines = 1,
            )
        }
    }
}

/** 悬浮新建按钮：不用 M3 FloatingActionButton（它有 16dp 默认内边距和 elevation，压不出画稿的位置）。 */
@Composable
private fun SessionFab(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val dimens = LocalDshDimens.current
    Box(
        modifier = modifier
            .padding(end = dimens.pageMargin, bottom = dimens.gapBlock)
            .size(dimens.fab)
            // 纯黑底上一个实心橙圆没有纵深，会和列表最后一行的橙色元素糊在一起。
            // 不用 elevation（M3 的 tonalElevation 会在真黑底上叠出一层脏灰，见 DshCard 的注释），
            // 改用一层 offset 的软阴影：既压出层次，又不改底色。
            .graphicsLayer {
                shadowElevation = 8.dp.toPx()
                shape = CircleShape
                clip = false
                this.ambientShadowColor = Color.Black
                this.spotShadowColor = Color.Black
            }
            .clip(CircleShape)
            .background(DshPrimary)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Icons.Default.Add,
            contentDescription = "新建会话",
            tint = Color.White,
            modifier = Modifier.size(24.dp),
        )
    }
}

/** 内联搜索行：34dp 全圆，替代原来常驻的 56dp OutlinedTextField。 */
@Composable
private fun InlineSearchRow(value: String, onValueChange: (String) -> Unit) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(dimens.buttonHeightLarge / 2)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(dimens.buttonHeightLarge)
            .clip(shape)
            .background(DshSurfaceVariant)
            .border(dimens.border, DshOutline, shape)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(dimens.gapChip),
    ) {
        Icon(
            imageVector = Icons.Default.Search,
            contentDescription = null,
            tint = DshNeutral,
            modifier = Modifier.size(16.dp),
        )
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            textStyle = type.body.copy(color = DshOnBackground),
            cursorBrush = SolidColor(DshPrimary),
            modifier = Modifier.weight(1f),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) {
                        Text(
                            text = "搜索标题 / 工作区",
                            style = type.body,
                            color = DshNeutral,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    inner()
                }
            },
        )
        if (value.isNotEmpty()) {
            Icon(
                imageVector = Icons.Default.Close,
                contentDescription = "清空搜索",
                tint = DshNeutral,
                modifier = Modifier
                    .size(16.dp)
                    .clickable(role = Role.Button) { onValueChange("") },
            )
        }
    }
}

// endregion

// region 会话/任务两页共用的列表骨架

/**
 * 两个列表页共用的骨架：页头（刷新 / 搜索两个圆钮）→ 可选内联搜索行 → 可选状态横幅 →
 * 可选前置块 → 筛选芯片行 → 列表（整张卡只画一次，行间走 hairline）→ 尾部脚注 → 固定底栏，右侧悬浮 FAB。
 *
 * 行内容用 `rows` 槽传入而不是 `LazyColumn.items`：画稿要求「整张卡只画一次」，
 * 所以所有行共享同一个 DshCard；本地列表（手机发起的会话）数量可控，可以直接铺。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionListScaffold(
    title: String,
    subtitle: String,
    subtitleWarning: Boolean,
    snackbarHostState: DshSnackbarState,
    refreshing: Boolean,
    onRefresh: () -> Unit,
    query: String,
    onQueryChange: (String) -> Unit,
    emptyHint: String,
    isEmpty: Boolean,
    rows: @Composable ColumnScope.() -> Unit,
    emptyTitle: String? = null,
    /** 空态里的主操作；null 时只给引导文案（手机任务页的空态有"新建任务"卡，不需要再来一个按钮）。 */
    emptyAction: (() -> Unit)? = null,
    loading: Boolean = false,
    errorMessage: String? = null,
    onRetry: (() -> Unit)? = null,
    banner: (@Composable () -> Unit)? = null,
    aboveFilters: (@Composable () -> Unit)? = null,
    filterRow: @Composable () -> Unit = {},
    listTail: @Composable ColumnScope.() -> Unit = {},
    footer: @Composable ColumnScope.() -> Unit = {},
    fab: @Composable BoxScope.() -> Unit = {},
) {
    val dimens = LocalDshDimens.current
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    val searchVisible = searchOpen || query.isNotBlank()

    Scaffold(snackbarHost = { DshSnackbarHost(snackbarHostState) }) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                DshPageHeader(
                    title = title,
                    subtitle = subtitle,
                    subtitleWarning = subtitleWarning,
                    actions = {
                        DshIconButton(
                            icon = Icons.Default.Refresh,
                            contentDescription = "刷新",
                            onClick = onRefresh,
                            enabled = !refreshing,
                        )
                        DshIconButton(
                            icon = Icons.Default.Search,
                            contentDescription = if (searchVisible) "收起搜索" else "搜索",
                            onClick = { searchOpen = !searchOpen },
                            solid = searchVisible,
                        )
                    },
                )
                if (searchVisible) {
                    DshPageContainer {
                        InlineSearchRow(value = query, onValueChange = onQueryChange)
                    }
                    Spacer(Modifier.height(dimens.gapChip))
                }
                if (banner != null) {
                    DshPageContainer { banner() }
                    Spacer(Modifier.height(dimens.gapBlock))
                }
                if (aboveFilters != null) {
                    DshPageContainer { aboveFilters() }
                    Spacer(Modifier.height(dimens.gapBlock))
                }
                DshPageContainer {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(dimens.gapChip),
                    ) {
                        filterRow()
                    }
                }
                Spacer(Modifier.height(dimens.gapCard))
                Box(modifier = Modifier.weight(1f)) {
                    if (errorMessage != null) {
                        ListErrorCard(
                            message = errorMessage,
                            onRetry = onRetry,
                            modifier = Modifier
                                .align(Alignment.TopCenter)
                                .padding(horizontal = dimens.pageMargin),
                        )
                    }
                    PullToRefreshBox(
                        isRefreshing = refreshing,
                        onRefresh = onRefresh,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        when {
                            isEmpty && loading -> ListLoadingState()
                            isEmpty -> ListEmptyState(
                                title = emptyTitle ?: "这里还是空的",
                                hint = emptyHint,
                                onAction = emptyAction,
                            )
                            else -> LazyColumn(
                                modifier = Modifier.fillMaxSize(),
                                contentPadding = PaddingValues(
                                    start = dimens.pageMargin,
                                    end = dimens.pageMargin,
                                    // 底部留白 = FAB 直径 + 间距 + 脚注呼吸位：
                                    // 滚到底时脚注卡和最后一行都不会被悬浮 FAB 压住。
                                    bottom = dimens.fabClearance,
                                ),
                            ) {
                                item(key = "list-card") {
                                    DshCard(
                                        modifier = Modifier.fillMaxWidth(),
                                        containerColor = DshSurfaceVariant,
                                        // 列表卡去掉橙色系描边：一整屏行本来就靠 hairline 分隔，
                                        // 外面再套一圈边会让列表看起来"被框住"，且和内部 hairline 抢层级。
                                        borderColor = Color.Transparent,
                                    ) {
                                        Column(modifier = Modifier.fillMaxWidth()) { rows() }
                                    }
                                }
                                item(key = "list-tail") {
                                    Column(modifier = Modifier.fillMaxWidth()) {
                                        Spacer(Modifier.height(dimens.gapCard))
                                        listTail()
                                    }
                                }
                            }
                        }
                    }
                }
                footer()
            }
            fab()
        }
    }
}

/**
 * 空态：图标 + 标题 + 引导文案（+ 可选动作）。
 *
 * 为什么不再是"一行居中的灰字"：列表空是**新用户看到的第一屏**，
 * 一行灰字既没说清"这里会有什么"，也没给下一步动作，用户只能退出去翻底栏。
 */
@Composable
private fun ListEmptyState(title: String, hint: String, onAction: (() -> Unit)?) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = dimens.pageMargin, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(dimens.emptyIconBox)
                .clip(RoundedCornerShape(DshRadius.Panel))
                .background(DshSurfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Default.FolderOpen,
                contentDescription = null,
                tint = DshNeutral,
                modifier = Modifier.size(22.dp),
            )
        }
        Spacer(Modifier.height(dimens.gapCard))
        Text(
            text = title,
            style = type.emphasis,
            color = DshOnBackground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(dimens.gapNode))
        Text(
            text = hint,
            style = type.label,
            color = DshNeutral,
        )
        if (onAction != null) {
            Spacer(Modifier.height(dimens.gapBlock))
            PrimaryActionButton(text = "新建任务", onClick = onAction)
        }
    }
}

/** 首次加载占位：一条细进度条 + 一行说明，比一整屏骨架屏更安静（本页数据量小、通常 <1s）。 */
@Composable
private fun ListLoadingState() {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = dimens.pageMargin, vertical = 28.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(dimens.gapChip),
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(14.dp),
            strokeWidth = 2.dp,
            color = DshPrimary,
        )
        Text(
            text = "正在读取会话…",
            style = type.label,
            color = DshNeutral,
        )
    }
}

/**
 * 错误态卡片：**不是**一句红字。
 *
 * 红字只能告诉用户"坏了"，不能告诉他"还能做什么"。这里给原因 + 一个「重试」按钮，
 * 并且保留列表内容可见（错误卡浮在列表上方而不是替换列表）：刷新失败时，
 * 屏幕上的旧列表仍然是有效信息，把它藏起来等于让用户倒退。
 */
@Composable
private fun ListErrorCard(message: String, onRetry: (() -> Unit)?, modifier: Modifier = Modifier) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    DshCard(
        modifier = modifier.fillMaxWidth(),
        containerColor = DshError.copy(alpha = 0.12f),
        borderColor = DshError.copy(alpha = 0.35f),
        radius = DshRadius.Sub,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 44.dp)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Default.Warning,
                contentDescription = null,
                tint = DshError,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(dimens.gapChip))
            Text(
                text = message,
                style = type.label,
                color = DshOnBackground,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (onRetry != null) {
                Spacer(Modifier.width(dimens.gapChip))
                DshChip(
                    text = "重试",
                    containerColor = DshError.copy(alpha = 0.18f),
                    contentColor = DshError,
                    borderColor = DshError.copy(alpha = 0.45f),
                    onClick = onRetry,
                    modifier = Modifier.semantics { contentDescription = "重试刷新会话列表" },
                )
            }
        }
    }
}

/** 空态里的主操作按钮（34dp 全圆实心橙）：用 `DshChip` 撑不出主按钮的分量，所以单独画。 */
@Composable
private fun PrimaryActionButton(text: String, onClick: () -> Unit) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(dimens.buttonHeightLarge / 2)
    Box(
        modifier = Modifier
            .height(dimens.buttonHeightLarge)
            .clip(shape)
            .background(DshPrimary)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 18.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = type.emphasis,
            color = Color.White,
            maxLines = 1,
        )
    }
}

// endregion
