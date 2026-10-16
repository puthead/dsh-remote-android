package com.deepseek.dshremote.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.deepseek.dshremote.data.api.TrajectoryKind
import com.deepseek.dshremote.data.api.TrajectoryRow
import com.deepseek.dshremote.ui.theme.DshBackground
import com.deepseek.dshremote.ui.theme.DshError
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSuccess
import com.deepseek.dshremote.ui.theme.DshWarning
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType

/** 时间轴左侧槽宽（正好放一个 16dp 的节点圆）。 */
private val NodeGutterWidth = 16.dp

/** 节点圆直径（画稿 16dp）。 */
private val NodeSize = 16.dp

/** 节点圆里的小图标尺寸。 */
private val NodeIconSize = 10.dp

/**
 * 普通步骤卡固定高 44dp（画稿）。
 *
 * 为什么固定：连接线要在**卡片外面**按 y 坐标画（节点圆心 = 卡片中心），
 * 卡片高度一旦随内容浮动，时间轴就会歪。信息量本身也是固定的（标题一行 + 详情一行），
 * 详情在 [trajectoryDetailPreview] 里已经截断。
 */
private val StepCardHeight = 44.dp

/** 连接线不贴到节点圆上，上下各留 8dp（画稿）。 */
private val NodeClearance = 8.dp

/** 顶部区：第 0 项是「加载更早」入口，第 1 项是第一条内容，两者都算"已经到顶"。 */
private const val TopZoneLastIndex = 1

/**
 * 「上拉到顶就自动取更早一页」的共享触发器 —— 对话流与轨迹视图**必须**用同一份判定。
 *
 * 为什么不各写一份：这段逻辑在真机上出过两次同源的故障（一个列表加载不出来、另一个连续空转拉页），
 * 两次其实是同一个 bug 的两个面孔。把判定收在一处，行为就不可能再漂移。
 *
 * 判据是"第 0 项入口（或第一条内容）已经在视口里"（`firstVisibleItemIndex <= TopZoneLastIndex`），
 * 这是实测选出来的：真机到顶那一刻实测首可见下标 0、距末尾 60 项，判据本身没问题。
 * 出问题的一直是**开火时机**，所以这里只管时机，不动判据。
 *
 * 开火时机为什么要用 DragInteraction（用户是否亲手拖过）而不是 isScrollInProgress：
 * 1. effect 会在 hasMoreOlder / loadingOlder 翻转时重启，snapshotFlow 重启后会**立刻发一次初值**。
 *    首屏那一刻列表还是空的（firstVisibleItemIndex 默认 0），"已经到顶"会在没有用户手势的情况下
 *    被判成成立，这一次机会又被紧接着进行的 refresh 守卫静默吞掉
 *    （SessionDetailViewModel.loadOlder 的 state.loading 分支）⇒ 用户真上拉到顶时一页也取不回来。
 *    真机实测：入口可见、首可见下标 0、夹具新增 0 条请求。
 * 2. 换用 isScrollInProgress 之后，复跑实测（android/evidence/v4 报告 R6）发现它**连程序自己的
 *    滚动动画也算**：点一次「回到最新」（animateScrollToItem）时视口仍在顶部，于是又白拉走一页
 *    （夹具在 T+181.0s 多收到一条 cursor=100 的请求）；而用户停在顶部边界再拖时列表无内容可滚，
 *    这个信号反而可能不动。
 * DragInteraction.Start 只在手指真的拖动列表时发出，程序滚动不发 ⇒ 既不自燃，也不漏"再拉一次"。
 *
 * @param enabled 还有更早的页且当前没有加载中（调用方把"是不是对话视图"这类条件一并折进来）
 */
@Composable
fun LoadOlderOnReachTop(
    listState: LazyListState,
    enabled: Boolean,
    onLoadOlder: () -> Unit,
) {
    // "用户亲手拖过一次"的闩锁：开火即用掉，下一次还得用户再拖。
    var userDragged by remember(listState) { mutableStateOf(false) }
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            if (interaction is DragInteraction.Start) userDragged = true
        }
    }
    LaunchedEffect(listState, enabled) {
        if (!enabled) return@LaunchedEffect
        var requested = false
        snapshotFlow { listState.firstVisibleItemIndex to listState.isScrollInProgress }
            .collect { (index, scrolling) ->
                if (index > TopZoneLastIndex) {
                    // 离开顶部区：下一次再到顶可以再取一页
                    requested = false
                } else if (scrolling && !requested && userDragged) {
                    requested = true
                    // 同一次拖拽只换一页：不清零的话"取完一页后停在顶部"会被反复消费
                    userDragged = false
                    onLoadOlder()
                }
            }
    }
}

/**
 * 「轨迹」视图（画稿 03 的台账列）：把一段对话摊平成"一步一行"的时间轴。
 *
 * 为什么是时间轴而不是普通列表：轨迹视图存在的理由是"一屏扫过很多步"，
 * 步骤之间必须能看出先后与归属（哪几步属于同一轮），所以左侧画节点 + 连接线、
 * 每轮开头插一个轮次芯片。信息量仍旧固定：详情在 [trajectoryDetailPreview] 里已截断。
 *
 * 它不新增数据源：行是从已投影的对话里摊出来的，因此与对话流共用同一份分页窗口
 * （同一个 seq 空间），翻页语义完全一致（合同 §5）。
 */
@Composable
fun TrajectoryList(
    rows: List<TrajectoryRow>,
    modifier: Modifier = Modifier,
    listState: LazyListState = rememberLazyListState(),
    loadingOlder: Boolean = false,
    hasMoreOlder: Boolean = true,
    onLoadOlder: () -> Unit = {},
    autoFollow: Boolean = true,
) {
    val dimens = LocalDshDimens.current

    if (rows.isEmpty()) {
        Box(modifier = modifier.padding(dimens.gapCard)) {
            EmptyHint(text = "这段会话还没有可显示的轨迹步骤。")
        }
        return
    }

    // 「加载更早」的自动触发：与对话流共用同一份判定（见 LoadOlderOnReachTop 的注释）
    LoadOlderOnReachTop(
        listState = listState,
        enabled = hasMoreOlder && !loadingOlder,
        onLoadOlder = onLoadOlder,
    )

    // 自动跟随末尾：触发条件是"末尾那一行的 key 换了"，而不是 rows.size 变了 ——
    // 往前插历史（加载更早）时末尾不动，所以正在往回看的用户不会被一次贴底拽回底部。
    val tailKey = rows.last().rowKey
    LaunchedEffect(tailKey) {
        if (!autoFollow) return@LaunchedEffect
        // 首帧列表可能还没布局完：滚动失败不能崩（合同 §4.1）
        runCatching { listState.animateScrollToItem(rows.size) }
    }

    // 轮次芯片的文字只能在这里算：TrajectoryRow 里没有轮次字段（见 buildTurnLabels 的说明）
    val turnLabels = remember(rows) { buildTurnLabels(rows) }

    LazyColumn(
        state = listState,
        modifier = modifier,
        // 调用方（详情页）不给内容区加左右边距，所以左右 12dp 由本组件自带；上下 8dp 同理
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(dimens.gapNode),
    ) {
        // 第 0 项固定是「加载更早」入口：让它自己占一行而不是浮在列表上面，
        // 上拉到顶时它就是"还有更早"的唯一可见证据。
        item(key = "trajectory-load-older") {
            LoadOlderEntry(
                loadingOlder = loadingOlder,
                hasMoreOlder = hasMoreOlder,
                onLoadOlder = onLoadOlder,
                noun = "轨迹",
            )
        }
        // key 必须带 index：同一条消息（比如一轮里并行 5 个工具调用）会摊出多行，
        // 只用 seq 会撞 key，而重复 key 会让 LazyColumn 直接抛异常。
        itemsIndexed(rows, key = { _, row -> row.rowKey }) { index, row ->
            // 分页是"一整段一起插进来"的，没有增删动画时新行会硬跳出来，看着像闪屏
            Box(modifier = Modifier.animateItem()) {
                TrajectoryStepItem(
                    row = row,
                    turnLabel = turnLabels[index],
                    isFirst = index == 0,
                    isLast = index == rows.lastIndex,
                )
            }
        }
    }
}

/**
 * 「第 N 轮」标签。
 *
 * 近似说明：TrajectoryRow 没有轮次号，只能按**当前窗口**里 TURN 行出现的顺序编号；
 * 往前翻页后窗口变了，编号会跟着重排（已在回报里说明）。
 */
private fun buildTurnLabels(rows: List<TrajectoryRow>): List<String?> {
    var turn = 0
    return rows.map { row ->
        if (row.kind == TrajectoryKind.TURN) {
            turn += 1
            "第 $turn 轮"
        } else {
            null
        }
    }
}

/**
 * 轨迹一步：左侧节点 + 右侧步骤卡，节点之间用竖直连接线串起来。
 *
 * 为什么要自己算子层高度：LazyColumn 的 item 在滚动方向上高度无界，
 * `fillMaxHeight()` / `matchParentSize()` 在这里都拿不到"父项的真实高度"，
 * 所以时间轴槽用一个显式 `width × height` 的 Box 来画，高度 = 轮次头 + 44dp 卡片。
 */
@Composable
private fun TrajectoryStepItem(
    row: TrajectoryRow,
    turnLabel: String?,
    isFirst: Boolean,
    isLast: Boolean,
    modifier: Modifier = Modifier,
) {
    val dimens = LocalDshDimens.current
    val style = nodeStyle(row)
    val headerHeight: Dp = if (turnLabel != null) dimens.chipHeight + dimens.gapNode else 0.dp
    val itemHeight = headerHeight + StepCardHeight

    Box(modifier = modifier.fillMaxWidth()) {
        // 底层时间轴：画在轮次芯片与卡片**之前**，于是芯片/卡片自然压住连接线（画稿正是这样叠的）
        Box(
            modifier = Modifier
                .width(NodeGutterWidth)
                .height(itemHeight)
                .drawBehind {
                    val stroke = dimens.hairline.toPx()
                    val centerX = size.width / 2f
                    val nodeTop = headerHeight.toPx() + (StepCardHeight.toPx() - NodeSize.toPx()) / 2f
                    val nodeBottom = nodeTop + NodeSize.toPx()
                    val clearance = NodeClearance.toPx()
                    // 往上下各多画一个 gapNode，补齐 LazyColumn spacedBy 留下的间隙，
                    // 相邻两步的线段才会接成一条连续的线
                    val gap = dimens.gapNode.toPx()
                    if (!isFirst) {
                        drawLine(
                            color = DshOutline,
                            start = Offset(centerX, -gap),
                            end = Offset(centerX, nodeTop - clearance),
                            strokeWidth = stroke,
                        )
                    }
                    if (!isLast) {
                        drawLine(
                            color = DshOutline,
                            start = Offset(centerX, nodeBottom + clearance),
                            end = Offset(centerX, size.height + gap),
                            strokeWidth = stroke,
                        )
                    }
                    drawCircle(
                        color = style.color,
                        radius = NodeSize.toPx() / 2f,
                        center = Offset(centerX, (nodeTop + nodeBottom) / 2f),
                    )
                },
        )
        Icon(
            imageVector = style.icon,
            contentDescription = null,
            tint = DshBackground,
            modifier = Modifier
                .align(Alignment.TopStart)
                .offset(
                    x = (NodeSize - NodeIconSize) / 2,
                    y = headerHeight + (StepCardHeight - NodeIconSize) / 2,
                )
                .size(NodeIconSize),
        )
        Column(modifier = Modifier.fillMaxWidth()) {
            if (turnLabel != null) {
                DshChip(
                    text = turnLabel,
                    containerColor = DshPrimary,
                    contentColor = Color.White,
                    borderColor = null,
                    bold = true,
                )
                Spacer(Modifier.height(dimens.gapNode))
            }
            StepCard(
                row = row,
                modifier = Modifier
                    .fillMaxWidth()
                    // 左侧让出时间轴槽 + 10dp 间距
                    .padding(start = NodeGutterWidth + 10.dp)
                    .height(StepCardHeight),
            )
        }
    }
}

/** 一步的卡片：标题 + 详情（工具类等宽），右上时间、右下结果备注。 */
@Composable
private fun StepCard(row: TrajectoryRow, modifier: Modifier = Modifier) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    // 工具行的标题/详情用等宽：工具名与参数（路径、命令）里空格与符号很多，比例字体读起来对不齐
    val mono = row.kind == TrajectoryKind.TOOL
    val monoFamily = type.monoMeta.fontFamily
    val titleStyle = if (mono) {
        type.bodyLoose.copy(fontFamily = monoFamily, fontWeight = FontWeight.Bold)
    } else {
        type.bodyLoose.copy(fontWeight = FontWeight.Bold)
    }
    val detailStyle = if (mono) type.meta.copy(fontFamily = monoFamily) else type.meta
    val note = stepNote(row)

    DshCard(
        modifier = modifier,
        radius = DshRadius.Panel,
        borderColor = if (row.isError) DshError.copy(alpha = 0.6f) else DshOutline,
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = dimens.cardPad),
            verticalAlignment = Alignment.Top,
        ) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(top = 8.dp),
            ) {
                Text(
                    text = row.title,
                    style = titleStyle,
                    color = if (row.isError) DshError else DshOnBackground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (row.detail.isNotBlank()) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = row.detail,
                        style = detailStyle,
                        color = DshOnSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Spacer(Modifier.width(dimens.gapChip))
            Column(
                modifier = Modifier.padding(top = 8.dp),
                horizontalAlignment = Alignment.End,
            ) {
                // 画稿这里是"耗时"，但 TrajectoryRow 只有时间戳 at，没有任何耗时字段，
                // 所以放真实的时间戳（同一窗口内按时间排序，读起来仍然是"这一步什么时候发生的"）
                if (row.at > 0) {
                    Text(
                        text = Fmt.clock(row.at),
                        style = type.monoMeta,
                        color = DshOnSurfaceVariant,
                        maxLines = 1,
                    )
                }
                if (note != null) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = note.text,
                        style = type.monoMeta,
                        color = note.color,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

/** 右下角备注：只有能从现有字段推出来的两种（结果行是否成功、交付物行）。 */
private data class StepNote(val text: String, val color: Color)

private fun stepNote(row: TrajectoryRow): StepNote? = when {
    row.isError -> StepNote("失败", DshError)
    row.kind == TrajectoryKind.RESULT -> StepNote("已完成", DshSuccess)
    row.kind == TrajectoryKind.DELIVERABLE -> StepNote("交付物", DshSuccess)
    else -> null
}

/** 节点样式：颜色 + 圆内小图标。 */
private data class NodeStyle(val color: Color, val icon: ImageVector)

/**
 * 节点配色按"这一步干了什么"分档（画稿：思路=陶土橙、pwsh=琥珀、写文件=绿、读文件=灰、
 * 结束=绿）。工具行的档位只能从工具名推——TrajectoryRow 里没有工具类别字段。
 */
private fun nodeStyle(row: TrajectoryRow): NodeStyle = when (row.kind) {
    TrajectoryKind.THOUGHT -> NodeStyle(DshPrimary, Icons.Default.MoreHoriz)
    TrajectoryKind.TURN -> NodeStyle(DshSuccess, Icons.Default.Check)
    TrajectoryKind.TOOL -> toolNodeStyle(row.title)
    TrajectoryKind.RESULT ->
        if (row.isError) NodeStyle(DshError, Icons.Default.Close) else NodeStyle(DshSuccess, Icons.Default.Check)
    TrajectoryKind.DELIVERABLE -> NodeStyle(DshSuccess, Icons.Default.Inventory2)
    TrajectoryKind.TODO -> NodeStyle(DshNeutral, Icons.Default.Checklist)
    TrajectoryKind.NOTE -> NodeStyle(DshNeutral, Icons.Default.Description)
}

private fun toolNodeStyle(toolName: String): NodeStyle {
    val name = toolName.lowercase()
    return when {
        // 命令类：唯一会真的改动机器状态的工具，用琥珀色提醒
        listOf("pwsh", "shell", "bash", "exec", "terminal", "run").any { name.contains(it) } ->
            NodeStyle(DshWarning, Icons.Default.Terminal)

        listOf("edit", "write", "create", "patch", "apply", "append").any { name.contains(it) } ->
            NodeStyle(DshSuccess, Icons.Default.Edit)

        listOf("grep", "glob", "search", "find", "rg").any { name.contains(it) } ->
            NodeStyle(DshNeutral, Icons.Default.Search)

        listOf("read", "cat", "view", "ls", "list", "head", "tail").any { name.contains(it) } ->
            NodeStyle(DshNeutral, Icons.Default.Visibility)

        else -> NodeStyle(DshNeutral, Icons.Default.Build)
    }
}

/**
 * 轨迹一行：图标 + 标题 + 最多两行副标题。
 *
 * 刻意**不可展开**：detail 在 [trajectoryDetailPreview] 里已经截断，一行的信息量固定，
 * 才能保证"一屏扫过很多步"这个轨迹视图存在的理由。要看全文回对话流看。
 *
 * 单独使用时（不在 [TrajectoryList] 里）不画连接线：没有上下文时画出来的线会指向虚空。
 */
@Composable
fun TrajectoryRowItem(row: TrajectoryRow, modifier: Modifier = Modifier) {
    TrajectoryStepItem(
        row = row,
        turnLabel = null,
        isFirst = true,
        isLast = true,
        modifier = modifier,
    )
}

/**
 * 「加载更早」入口：对话流与轨迹**共用**这一个组件。
 *
 * 合同要求两种视图的入口行为完全一致；共用实现是"一致"最省事的保证方式 ——
 * 分成两份迟早会有一边忘了处理"已到最早"。三种形态分别对应：
 * 真的没有了 / 正在取 / 可以取。
 */
@Composable
fun LoadOlderEntry(
    loadingOlder: Boolean,
    hasMoreOlder: Boolean,
    onLoadOlder: () -> Unit,
    modifier: Modifier = Modifier,
    /** 文案里的名词（"轨迹" / "消息"）：两种视图只有这一个字不同。 */
    noun: String = "轨迹",
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        when {
            // 已到最早时给一行小字而不是直接隐藏入口：用户上拉到顶需要一个
            // "真的没有了"的答复，否则会一直上拉试图找出更多内容
            !hasMoreOlder -> Text(
                text = "已到最早，没有更早的${noun}了",
                style = type.meta,
                color = DshNeutral,
            )

            loadingOlder -> Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dimens.gapNode),
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(14.dp),
                    strokeWidth = 2.dp,
                    color = DshNeutral,
                )
                Text(
                    text = "正在加载更早的${noun}…",
                    style = type.meta,
                    color = DshNeutral,
                )
            }

            // 手动入口与自动触发并存：自动触发依赖滚动位置，网络抖动时用户仍需要能主动点
            else -> Text(
                text = "加载更早的${noun}（上拉或点这里）",
                style = type.meta,
                color = DshNeutral,
                modifier = Modifier
                    .clip(RoundedCornerShape(DshRadius.Badge))
                    .clickable(role = Role.Button, onClick = onLoadOlder)
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
    }
}
