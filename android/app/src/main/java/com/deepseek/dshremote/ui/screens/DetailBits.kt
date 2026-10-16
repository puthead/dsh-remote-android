package com.deepseek.dshremote.ui.screens

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.deepseek.dshremote.data.api.TrajectoryKind
import com.deepseek.dshremote.data.api.TrajectoryRow
import com.deepseek.dshremote.data.api.TurnIndexEntry
import com.deepseek.dshremote.data.api.WireApprovals
import com.deepseek.dshremote.ui.components.DshChip
import com.deepseek.dshremote.ui.components.DshIconButton
import com.deepseek.dshremote.ui.components.EmptyHint
import com.deepseek.dshremote.ui.components.Fmt
import com.deepseek.dshremote.ui.markdown.MarkdownParser
import com.deepseek.dshremote.ui.theme.DshBackground
import com.deepseek.dshremote.ui.theme.DshError
import com.deepseek.dshremote.ui.theme.DshLive
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSurface
import com.deepseek.dshremote.ui.theme.DshSurfaceHigh
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshWarning
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType
import java.util.Locale

/**
 * 会话详情（画稿 02）与执行轨迹（画稿 03）的几何件。
 *
 * 为什么单独成文件、而不是塞进 `SessionDetailScreen.kt`：详情页那边已经背着
 * 分页窗口、贴底判定、视图切换三套状态机；画稿几何（顶栏、页签、轮次进度、
 * 汇总条、审批条、输入胶囊）是**只吃画稿数值的哑组件**。混在一个文件里，
 * 下次改判定时很容易顺手改坏像素，反之亦然。
 *
 * 所有数值来自 `.proto-out/02-会话详情.png` / `.proto-out/03-执行轨迹.png`
 * （1080×2340 @3x，÷3 = dp/sp），密度令牌一律取 [LocalDshDimens] / [LocalDshType]。
 */

/**
 * 审批待应答的**极简**口子：一行命令摘要 + 两个回调。
 *
 * 数据层接通之后，详情页真正的来源是 `SessionDetailViewModel.ui.pendingApproval`
 * （见 [ApprovalCard]）；这个类保留下来作为**外部覆盖**：`SessionDetailScreen(..., pendingApproval = …)`
 * 仍能把输入区换成一条 36dp 的 [ApprovalStrip]（截图夹具、临时演示用）。
 * 公开签名不动，是因为它已经被 DshRemoteRoot 之外的调用点当成稳定接口用。
 *
 * 三个字段刻意做成"渲染它需要的全部"：UI 不认识审批协议。
 */
data class PendingApprovalPrompt(
    /** 一行命令摘要（超长由界面省略号截断）。 */
    val command: String,
    val onAllow: () -> Unit,
    val onDeny: () -> Unit,
)

/**
 * 详情页顶栏（画稿 02 / 03 共用）。
 *
 * 不用 M3 `TopAppBar`：它固定 64dp 高、带 M3 的 16dp 起始内边距，
 * 与画稿的"箭头圆心 x=32、标题从 x=52/54 起、30dp 高的停止按钮"三处都对不上。
 * 触摸目标补到 44dp，视觉仍是画稿的 22dp 箭头——视觉与触摸分离是本仓库的既有约定。
 */
@Composable
fun DetailTopBar(
    title: String,
    subtitle: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    titleStyle: TextStyle? = null,
    subtitleStyle: TextStyle? = null,
    subtitleColor: Color = DshOnSurfaceVariant,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            // 起点 10dp：44dp 的返回触摸框中心正好落在画稿的 x=32dp 上，标题因此从 x=54 起
            .padding(start = dimens.pageMargin - 10.dp, end = 16.dp, top = 14.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .clickable(role = Role.Button, onClick = onBack),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "返回",
                tint = DshOnBackground,
                modifier = Modifier.size(22.dp),
            )
        }
        Column(Modifier.weight(1f)) {
            Text(
                text = title,
                style = titleStyle ?: type.detailTitle,
                color = DshOnBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                text = subtitle,
                style = subtitleStyle ?: type.tiny,
                color = subtitleColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(10.dp))
        actions()
    }
}

/**
 * 「对话 / 轨迹」页签（画稿 03）。
 *
 * 换掉了原来的 M3 `SingleChoiceSegmentedButtonRow`：那是 40dp 高 + 8dp 圆角 + 一堆
 * 分割线，画稿是 168×34dp 全圆胶囊里滑一个 30dp 的实心橙块。
 */
@Composable
fun DetailTabRow(
    conversationSelected: Boolean,
    onSelectConversation: () -> Unit,
    onSelectTrajectory: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dimens = LocalDshDimens.current
    val shape = RoundedCornerShape(17.dp)
    Row(
        modifier = modifier
            .width(168.dp)
            .height(34.dp)
            .clip(shape)
            .background(DshSurfaceVariant)
            .border(dimens.border, DshOutline, shape)
            .padding(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TabSegment("对话", conversationSelected, onSelectConversation, Modifier.weight(1f))
        TabSegment("轨迹", !conversationSelected, onSelectTrajectory, Modifier.weight(1f))
    }
}

@Composable
private fun TabSegment(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val type = LocalDshType.current
    val shape = RoundedCornerShape(15.dp)
    Box(
        modifier = modifier
            .fillMaxHeight()
            .clip(shape)
            .then(if (selected) Modifier.background(DshPrimary) else Modifier)
            .clickable(role = Role.Tab, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = type.body,
            color = if (selected) Color.White else DshOnSurfaceVariant,
            fontWeight = if (selected) FontWeight.Bold else null,
            maxLines = 1,
        )
    }
}

/**
 * 顶栏「停止」按钮（画稿 02）：30dp 高、15dp 全圆、错误色 12% 底 + 1dp 描边。
 *
 * 外面套 44dp 高、22dp 圆的点击区：按钮视觉只有 30dp，直接点容易点空。
 */
@Composable
fun DetailStopButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(dimens.buttonHeight / 2)
    Box(
        modifier = modifier
            .height(44.dp)
            .clip(RoundedCornerShape(22.dp))
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier
                .height(dimens.buttonHeight)
                .clip(shape)
                .background(DshError.copy(alpha = 0.12f))
                .border(dimens.border, DshError, shape)
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Default.Stop,
                contentDescription = null,
                tint = DshError,
                modifier = Modifier.size(10.dp),
            )
            Spacer(Modifier.width(5.dp))
            Text(
                text = "停止",
                style = type.labelTight,
                color = DshError,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
        }
    }
}

/**
 * 实时状态条（画稿 02）：320×34dp、圆角 10dp、实时绿 9% 底 + 28% 描边。
 *
 * 只在真的在跑时出现（调用方判定），不做成"常驻但变灰"——常驻会让"在跑"
 * 这件事失去信号价值。
 */
@Composable
fun LiveRunBar(
    label: String,
    modifier: Modifier = Modifier,
    chip: String? = null,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(34.dp)
            .clip(shape)
            .background(DshLive.copy(alpha = 0.09f))
            .border(dimens.border, DshLive.copy(alpha = 0.28f), shape)
            // 右侧只留 4dp：芯片右缘要对齐到内容右界 −4dp（画稿）
            .padding(start = 10.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(DshLive),
        )
        Spacer(Modifier.width(7.dp))
        Text(
            text = label,
            style = type.label,
            color = DshOnBackground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (chip != null) {
            Spacer(Modifier.width(6.dp))
            DshChip(
                text = chip,
                height = dimens.chipHeightSmall,
                containerColor = DshSurfaceVariant,
                contentColor = DshOnSurfaceVariant,
                borderColor = null,
            )
        }
    }
}

/** 对话流末端「● 第 N 轮进行中」芯片（画稿 02）：96×24dp、圆角 12dp。 */
@Composable
fun RunningRoundChip(round: Int, modifier: Modifier = Modifier) {
    val type = LocalDshType.current
    val shape = RoundedCornerShape(DshRadius.Sub)
    Row(
        modifier = modifier
            .width(96.dp)
            .height(24.dp)
            .clip(shape)
            .background(DshSurfaceVariant)
            .border(LocalDshDimens.current.border, DshOutline, shape),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(DshPrimary),
        )
        Spacer(Modifier.width(5.dp))
        Text(
            text = "第 $round 轮进行中",
            style = type.meta,
            color = DshOnSurfaceVariant,
            maxLines = 1,
        )
    }
}

/** 轨迹页最多画几个轮次节点：再多就挤成一团，可读性比"全画出来"重要。 */
private const val MAX_ROUND_NODES = 14

/**
 * 轮次进度条（画稿 03）：轨道 1dp、已走过的那段是中性灰，
 * 已过节点 10dp 灰、当前节点 16dp 橙 + 外圈 26dp 空心橙、未到节点 8dp 深灰。
 *
 * 用 [Canvas] 而不是 Row + Box：节点间距要求等分且当前节点带外圈，
 * 用布局拼会引入一堆"半像素对齐"的麻烦。
 */
@Composable
fun RoundProgressBar(total: Int, current: Int, modifier: Modifier = Modifier) {
    if (total <= 0) return
    val nodes = total.coerceAtMost(MAX_ROUND_NODES)
    // 节点等分在 1..total 上：轮次多于节点数时按比例抽样，当前轮落在它最接近的节点
    val roundAt = { index: Int ->
        if (nodes <= 1) total else 1 + (index * (total - 1)) / (nodes - 1)
    }
    val currentIndex = (0 until nodes).lastOrNull { roundAt(it) <= current } ?: 0

    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(26.dp),
    ) {
        // 轨道左右各留 10dp：画稿里轨道从 x=30 到 330，页面边距 20dp
        val startX = 10.dp.toPx()
        val endX = size.width - 10.dp.toPx()
        val centerY = size.height / 2f
        val track = 1.dp.toPx()
        drawLine(DshOutline, Offset(startX, centerY), Offset(endX, centerY), track)

        val step = if (nodes > 1) (endX - startX) / (nodes - 1) else 0f
        val currentNodeX = startX + step * currentIndex
        // 已走完的那一段换成中性灰，给"进度"一个第二信号（不只靠节点大小）
        drawLine(DshNeutral, Offset(startX, centerY), Offset(currentNodeX, centerY), track)

        for (index in 0 until nodes) {
            val x = startX + step * index
            val center = Offset(x, centerY)
            when {
                index < currentIndex -> drawCircle(DshNeutral, 5.dp.toPx(), center)
                index == currentIndex -> {
                    drawCircle(DshPrimary, 8.dp.toPx(), center)
                    drawCircle(DshPrimary, 13.dp.toPx(), center, style = Stroke(1.dp.toPx()))
                }
                else -> drawCircle(DshSurfaceHigh, 4.dp.toPx(), center)
            }
        }
    }
}

/** 轮次芯片「第 N 轮」（画稿 03）：24dp 高、实心橙、白字、无描边。 */
@Composable
fun RoundChip(round: Int, modifier: Modifier = Modifier) {
    DshChip(
        text = "第 $round 轮",
        modifier = modifier,
        containerColor = DshPrimary,
        contentColor = Color.White,
        borderColor = null,
        bold = true,
    )
}

/**
 * 底部三格汇总条（画稿 03）：320×58dp、圆角 18dp、三等分 + 1dp 竖线。
 *
 * 三格的数值都必须由调用方算好（步数/工具调用/用时），组件不认识会话模型。
 */
@Composable
fun TrajectorySummaryBar(
    steps: String,
    toolCalls: String,
    elapsed: String,
    modifier: Modifier = Modifier,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(DshRadius.Summary)
    val valueStyle = type.body.copy(fontSize = 16.sp, lineHeight = 20.sp, fontWeight = FontWeight.Bold)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(58.dp)
            .clip(shape)
            .background(DshSurfaceVariant)
            .border(dimens.border, DshOutline, shape),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SummaryCell(value = steps, label = "步数", valueStyle = valueStyle, modifier = Modifier.weight(1f))
        Box(
            Modifier
                .width(1.dp)
                .height(34.dp)
                .background(DshOutline),
        )
        SummaryCell(value = toolCalls, label = "工具调用", valueStyle = valueStyle, modifier = Modifier.weight(1f))
        Box(
            Modifier
                .width(1.dp)
                .height(34.dp)
                .background(DshOutline),
        )
        SummaryCell(value = elapsed, label = "用时", valueStyle = valueStyle, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun SummaryCell(
    value: String,
    label: String,
    valueStyle: TextStyle,
    modifier: Modifier = Modifier,
) {
    val type = LocalDshType.current
    Column(
        modifier = modifier.padding(top = 9.dp, bottom = 9.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text(text = value, style = valueStyle, color = DshOnBackground, maxLines = 1)
        Text(text = label, style = type.meta, color = DshOnSurfaceVariant, maxLines = 1)
    }
}

/**
 * 审批条（画稿 02 的输入区接管态）：36dp 高警告条 + 命令摘要 + 两个 30dp 按钮。
 *
 * 为什么不是"一条普通消息"：审批是在等**人**做决定，它必须出现在用户视线
 * 和手指都会落到的位置（输入区），否则用户会以为 App 卡住了。
 */
@Composable
fun ApprovalStrip(prompt: PendingApprovalPrompt, modifier: Modifier = Modifier) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(36.dp)
            .clip(shape)
            .background(DshWarning.copy(alpha = 0.10f))
            .border(dimens.border, DshWarning.copy(alpha = 0.30f), shape)
            .padding(start = 10.dp, end = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            tint = DshWarning,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = prompt.command,
            style = type.monoMeta,
            color = DshOnBackground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(6.dp))
        StripButton(text = "允许一次", solid = true, onClick = prompt.onAllow)
        Spacer(Modifier.width(4.dp))
        StripButton(text = "拒绝", solid = false, onClick = prompt.onDeny)
    }
}

/**
 * 审批通道的诊断条（输入区上方）。
 *
 * 为什么必须有这一条：用户反馈「手机上看不到 ask 和回复的选项」，而真机上最常见的成因
 * **不是**界面缺控件，是网关压根收不到审批事件 —— 电脑端没启动 / 凭据不可用 / 连不上。
 * 这种情况下待答列表永远是空的，界面若什么都不说，用户只会以为 App 坏了。
 * 网关在 `state.reason` 里已经判定了原因（见 `lib/approvals.mjs` 的 `APPROVAL_REASONS`），
 * 这里只负责把「原因 + 下一步做什么」显示出来，**不**自己猜。
 *
 * 几何刻意与 [ApprovalStrip] 同族（同圆角、同底色、同图标），但高度不定：
 * 有的原因需要两行才说得清（"找不到凭据" + "请先启动电脑端"）。
 */
@Composable
fun BridgeNotice(note: String, hint: String, modifier: Modifier = Modifier) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(DshWarning.copy(alpha = 0.10f))
            .border(dimens.border, DshWarning.copy(alpha = 0.30f), shape)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            tint = DshWarning,
            modifier = Modifier
                .padding(top = 2.dp)
                .size(14.dp),
        )
        Spacer(Modifier.width(6.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = note,
                style = type.labelTight,
                color = DshOnBackground,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            // 空提示不占行：正常情况下这一条根本不会出现，出现时"做什么"才是重点
            if (hint.isNotBlank()) {
                Text(
                    text = hint,
                    style = type.tiny,
                    color = DshOnSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun StripButton(text: String, solid: Boolean, onClick: () -> Unit) {
    val dimens = LocalDshDimens.current
    val shape = RoundedCornerShape(dimens.buttonHeight / 2)
    Box(
        modifier = Modifier
            .height(dimens.buttonHeight)
            .clip(shape)
            .background(if (solid) DshPrimary else DshSurfaceVariant)
            .border(dimens.border, if (solid) Color.Transparent else DshOutline, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = LocalDshType.current.labelTight,
            color = if (solid) Color.White else DshOnSurfaceVariant,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

/**
 * 审批 / 提问的输入区接管卡（画稿 02 接管态的**完整协议形态**）。
 *
 * 为什么不是 [ApprovalStrip] 那种 36dp 一行条：审批只有"允许/拒绝"两个动作，
 * 而提问（`ask_user_question`）可能是 1~N 问、每问若干选项、还能自由文本作答。
 * 挤进一行的话，用户会在**看不到题目**的情况下点选项——那比不接管更糟。
 *
 * 唯一不妥协的是**位置**：它仍然接管输入区（输入框和发送键消失），因为"等我响应"
 * 必须落在视线和手指都会到的地方，而不是变成对话流里一条会被划过去的普通消息。
 *
 * 直接吃 [WireApprovals.ApprovalEntry] 而不是再做一层 UI 模型：字段一一对应，
 * 中间层只会多出一处会与协议漂移的映射（而这条协议的坑已经够多了）。
 */
@Composable
fun ApprovalCard(
    entry: WireApprovals.ApprovalEntry,
    drafts: Map<String, WireApprovals.ApprovalDraft>,
    plan: WireApprovals.ApprovalPlan,
    remaining: String,
    submitting: Boolean,
    onPick: (questionId: String, label: String) -> Unit,
    onCustom: (questionId: String, text: String) -> Unit,
    onClear: (questionId: String) -> Unit,
    onSubmit: () -> Unit,
    onDecide: (WireApprovals.Outcome) -> Unit,
    onAbstain: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(14.dp)
    // 琥珀图标的呼吸：表达的是"轮到你"，而不是"正在输出"。
    // 为什么不用打字光标那种闪烁：闪烁是输出中的语义，这里用更弱的脉动，不跟对话流抢注意力。
    val transition = rememberInfiniteTransition(label = "approval-wait")
    val pulse by transition.animateFloat(
        initialValue = 1f,
        targetValue = 0.4f,
        animationSpec = infiniteRepeatable(tween(durationMillis = 900), RepeatMode.Reverse),
        label = "approval-pulse",
    )
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(DshWarning.copy(alpha = 0.10f))
            .border(dimens.border, DshWarning.copy(alpha = 0.30f), shape)
            // 高到会把整个对话流推走：题目多时卡内滚动，接管的是输入区那一格而不是整页
            .heightIn(max = 320.dp)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ApprovalCardHeader(entry = entry, remaining = remaining, submitting = submitting, pulse = pulse)
        Text(
            text = entry.headline,
            style = type.monoMeta,
            color = DshOnBackground,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        entry.reason?.takeIf { it.isNotBlank() }?.let { reason ->
            Text(
                text = reason,
                style = type.tiny,
                color = DshOnSurfaceVariant,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
        entry.questions.orEmpty().forEachIndexed { index, question ->
            if (index > 0) HairlineRow()
            ApprovalQuestionBlock(
                question = question,
                draft = drafts[question.id] ?: WireApprovals.ApprovalDraft(),
                enabled = !submitting,
                onPick = { label -> onPick(question.id, label) },
                onCustom = { text -> onCustom(question.id, text) },
                onClear = { onClear(question.id) },
            )
        }
        // 题目为空是真实会发生的形态（computer 工具用提问通道问一句纯文本时没有 questions）。
        // 不说清楚的话，用户看到的是一张"等待你响应"却没有选项、也不知道往哪打字的卡。
        if (entry.kind == WireApprovals.Kind.QUESTION && entry.questions.orEmpty().isEmpty()) {
            Text(
                text = "这条提问没有可选项，也没有自由文本题；请在电脑端回答（手机点「不在手机上答」可跳过）",
                style = type.tiny,
                color = DshOnSurfaceVariant,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (entry.kind == WireApprovals.Kind.APPROVAL) {
            ApprovalDecisionActions(submitting = submitting, onDecide = onDecide, onAbstain = onAbstain)
        } else {
            QuestionActions(
                plan = plan,
                submitting = submitting,
                onSubmit = onSubmit,
                onAbstain = onAbstain,
            )
        }
    }
}

/** 卡片头：琥珀标题 + 类型芯片 + 剩余时间。 */
@Composable
private fun ApprovalCardHeader(
    entry: WireApprovals.ApprovalEntry,
    remaining: String,
    submitting: Boolean,
    pulse: Float,
) {
    val type = LocalDshType.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            tint = DshWarning.copy(alpha = pulse),
            modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = "等待你响应",
            style = type.labelTight,
            color = DshWarning,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
        Spacer(Modifier.width(6.dp))
        DshChip(
            text = if (entry.kind == WireApprovals.Kind.APPROVAL) "工具审批" else "模型提问",
            containerColor = DshWarning.copy(alpha = 0.14f),
            contentColor = DshWarning,
            borderColor = DshWarning.copy(alpha = 0.30f),
            height = LocalDshDimens.current.chipHeightSmall,
            bold = true,
        )
        Spacer(Modifier.weight(1f))
        if (submitting) {
            Text(text = "提交中…", style = type.meta, color = DshOnSurfaceVariant, maxLines = 1)
        } else if (remaining.isNotEmpty()) {
            Text(text = remaining, style = type.meta, color = DshOnSurfaceVariant, maxLines = 1)
        }
    }
}

/** 提问的一问：题面 + 选项列表 + 自由文本框。 */
@Composable
private fun ApprovalQuestionBlock(
    question: WireApprovals.ApprovalQuestion,
    draft: WireApprovals.ApprovalDraft,
    enabled: Boolean,
    onPick: (String) -> Unit,
    onCustom: (String) -> Unit,
    onClear: () -> Unit,
) {
    val type = LocalDshType.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        question.header?.takeIf { it.isNotBlank() }?.let { header ->
            Text(text = header, style = type.meta, color = DshOnSurfaceVariant, maxLines = 1)
        }
        Text(text = question.question, style = type.body, color = DshOnBackground)
        question.detail?.takeIf { it.isNotBlank() }?.let { detail ->
            Text(text = detail, style = type.tiny, color = DshOnSurfaceVariant, maxLines = 4)
        }
        if (!question.isFreeText) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                question.options.forEach { option ->
                    ApprovalOptionRow(
                        label = option.label,
                        description = option.description,
                        // 单选的选中态用等值判断；多选是集合成员关系——两者都落在 draft.selected 上，
                        // 所以这里只问"这个标签在不在里面"，不关心单选还是多选
                        selected = draft.selected.contains(option.label),
                        multiSelect = question.multiSelect,
                        enabled = enabled,
                        onClick = { onPick(option.label) },
                    )
                }
            }
        }
        ApprovalCustomField(
            value = draft.custom,
            freeText = question.isFreeText,
            enabled = enabled,
            onValueChange = onCustom,
            onClear = onClear,
            showClear = draft.answered,
        )
        if (!question.multiSelect && !question.isFreeText && draft.selected.isNotEmpty()) {
            // 单选：再点一次同一项即取消（[WireApprovals.toggleOption] 的语义），这里只做说明
            Text(text = "再点一次可取消选择", style = type.tiny, color = DshOnSurfaceVariant, maxLines = 1)
        }
    }
}

/** 一个选项：选中 = 琥珀 12% 底 + 30% 描边（与"等待你响应"同一套色语）。 */
@Composable
private fun ApprovalOptionRow(
    label: String,
    description: String?,
    selected: Boolean,
    multiSelect: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (selected) DshWarning.copy(alpha = 0.12f) else DshSurfaceVariant)
            .border(
                dimens.border,
                if (selected) DshWarning.copy(alpha = 0.30f) else DshOutline,
                shape,
            )
            .clickable(enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 多选用方框、单选用圆点：形状本身就说明"能不能多选"，不必额外写一行说明
        SelectionMark(selected = selected, multiSelect = multiSelect)
        Spacer(Modifier.width(8.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = label,
                style = type.label,
                color = DshOnBackground,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            )
            description?.takeIf { it.isNotBlank() }?.let {
                Text(text = it, style = type.tiny, color = DshOnSurfaceVariant, maxLines = 2)
            }
        }
    }
}

/** 选中标记：多选方形、单选圆形；未选中只是描边。 */
@Composable
private fun SelectionMark(selected: Boolean, multiSelect: Boolean) {
    val shape = if (multiSelect) RoundedCornerShape(4.dp) else CircleShape
    Box(
        modifier = Modifier
            .size(16.dp)
            .clip(shape)
            .background(if (selected) DshWarning else Color.Transparent)
            .border(
                LocalDshDimens.current.border,
                if (selected) DshWarning else DshOutline,
                shape,
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) {
            Icon(
                imageVector = Icons.Default.Check,
                contentDescription = null,
                tint = Color.White,
                modifier = Modifier.size(11.dp),
            )
        }
    }
}

/**
 * 自由文本答案。
 *
 * 用 `BasicTextField` 而不是 M3 `OutlinedTextField`：后者固定 56dp 高、带浮动标签，
 * 与这张卡的密度对不上（同样的理由见 `ComposerCapsule`）。
 */
@Composable
private fun ApprovalCustomField(
    value: String,
    freeText: Boolean,
    enabled: Boolean,
    onValueChange: (String) -> Unit,
    onClear: () -> Unit,
    showClear: Boolean,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 34.dp)
            .clip(shape)
            .background(DshBackground)
            .border(dimens.border, DshOutline, shape)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.weight(1f)) {
            if (value.isEmpty()) {
                Text(
                    text = if (freeText) "在这里输入你的回答" else "也可以补充自由文本",
                    style = type.body,
                    color = DshOnSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                enabled = enabled,
                textStyle = type.body.copy(color = DshOnBackground),
                cursorBrush = SolidColor(DshWarning),
                maxLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (showClear) {
            Spacer(Modifier.width(6.dp))
            Text(
                text = "清空",
                style = type.meta,
                color = DshOnSurfaceVariant,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable(enabled = enabled, role = Role.Button, onClick = onClear)
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
    }
}

/** 审批的三个动作。 */
@Composable
private fun ApprovalDecisionActions(
    submitting: Boolean,
    onDecide: (WireApprovals.Outcome) -> Unit,
    onAbstain: () -> Unit,
) {
    val type = LocalDshType.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ActionButton(
                text = WireApprovals.Outcome.ALLOWED_ONCE.label,
                solid = true,
                enabled = !submitting,
                onClick = { onDecide(WireApprovals.Outcome.ALLOWED_ONCE) },
            )
            Spacer(Modifier.width(6.dp))
            ActionButton(
                text = WireApprovals.Outcome.REJECTED.label,
                solid = false,
                enabled = !submitting,
                onClick = { onDecide(WireApprovals.Outcome.REJECTED) },
            )
        }
        // 后两个结论不给主按钮位：它们表达的是"这件事别做了 / 我这儿没这个能力"，
        // 而把四个结论并排会让"允许一次"变得不那么像默认动作。
        Row(verticalAlignment = Alignment.CenterVertically) {
            GhostAction("取消本轮", enabled = !submitting) { onDecide(WireApprovals.Outcome.CANCELLED) }
            Text(text = "·", style = type.meta, color = DshOnSurfaceVariant)
            GhostAction("无法处理", enabled = !submitting) { onDecide(WireApprovals.Outcome.UNAVAILABLE) }
            Text(text = "·", style = type.meta, color = DshOnSurfaceVariant)
            GhostAction("不在手机上答", enabled = !submitting, onClick = onAbstain)
        }
    }
}

/** 提问的动作：提交 + 弃权。 */
@Composable
private fun QuestionActions(
    plan: WireApprovals.ApprovalPlan,
    submitting: Boolean,
    onSubmit: () -> Unit,
    onAbstain: () -> Unit,
) {
    val type = LocalDshType.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ActionButton(
                // 没答完时按钮本身承担进度提示：置灰的"提交回答"不会告诉用户还差几问
                text = if (plan.allAnswered) "提交回答" else "还有 ${plan.unanswered.size} 问没答",
                solid = true,
                enabled = plan.canSubmit && !submitting,
                onClick = onSubmit,
            )
            Spacer(Modifier.width(6.dp))
            Text(
                text = "电脑端先答过的话，这里会自动消失",
                style = type.tiny,
                color = DshOnSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            GhostAction("不在手机上答", enabled = !submitting, onClick = onAbstain)
            Spacer(Modifier.width(6.dp))
            Text(
                text = "弃权会交给下一个应答者；无人应答时电脑端拿到 unable（等于拒绝）",
                style = type.tiny,
                color = DshOnSurfaceVariant,
                maxLines = 2,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/** 30dp 的条内按钮，几何与 [StripButton] 一致，额外支持禁用态。 */
@Composable
private fun ActionButton(text: String, solid: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val dimens = LocalDshDimens.current
    val shape = RoundedCornerShape(dimens.buttonHeight / 2)
    val background = when {
        !enabled -> DshSurfaceVariant.copy(alpha = 0.5f)
        solid -> DshPrimary
        else -> DshSurfaceVariant
    }
    Box(
        modifier = Modifier
            .height(dimens.buttonHeight)
            .clip(shape)
            .background(background)
            .border(dimens.border, if (solid && enabled) Color.Transparent else DshOutline, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = LocalDshType.current.labelTight,
            color = when {
                !enabled -> DshOnSurfaceVariant.copy(alpha = 0.5f)
                solid -> Color.White
                else -> DshOnSurfaceVariant
            },
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

/** 低强调的文字动作（`取消本轮` / `无法处理` / `不在手机上答`）。 */
@Composable
private fun GhostAction(text: String, enabled: Boolean, onClick: () -> Unit) {
    Text(
        text = text,
        style = LocalDshType.current.meta,
        color = if (enabled) DshOnSurfaceVariant else DshOnSurfaceVariant.copy(alpha = 0.5f),
        maxLines = 1,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 4.dp),
    )
}

/** 卡内分隔线（比卡片之间那条更短，缩进对齐文字）。 */
@Composable
private fun HairlineRow() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(LocalDshDimens.current.hairline)
            .background(DshOutline.copy(alpha = 0.6f)),
    )
}

/**
 * 详情页的轻量提示条（离线 / 只读 / 不可继续 / 电脑端说明）。
 *
 * 与 [com.deepseek.dshremote.ui.components.DshStatusBanner] 的区别：那个是 42dp 的
 * 页面级横幅（带数值芯片），这里是贴着内容的一条 12% 底色说明，用来放旧实现里
 * 那几条必须保留的文案（离线会进待发队列、只读原因、停止后不可继续）。
 */
@Composable
fun DetailNoteRow(
    text: String,
    tone: Color,
    icon: ImageVector,
    modifier: Modifier = Modifier,
    action: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 30.dp)
            .clip(shape)
            .background(tone.copy(alpha = 0.12f))
            .border(dimens.border, tone.copy(alpha = 0.30f), shape)
            .padding(start = 10.dp, end = 6.dp, top = 7.dp, bottom = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = tone,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(7.dp))
        Text(
            text = text,
            style = type.labelTight,
            color = tone,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (action != null && onAction != null) {
            Spacer(Modifier.width(6.dp))
            Box(
                modifier = Modifier
                    .height(30.dp)
                    .clip(RoundedCornerShape(15.dp))
                    .clickable(role = Role.Button, onClick = onAction)
                    .padding(horizontal = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = action,
                    style = type.labelTight,
                    color = tone,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                )
            }
        }
    }
}

/**
 * 输入胶囊（画稿 02）：34dp 高、17dp 全圆 —— 高度用 `heightIn(min)` 而不是固定 34dp，
 * 因为多行输入（本仓库一直支持）必须能把胶囊撑高，撑高后仍是圆角矩形。
 */
@Composable
fun ComposerCapsule(
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit,
) {
    val dimens = LocalDshDimens.current
    val shape = RoundedCornerShape(17.dp)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 34.dp)
            .clip(shape)
            .background(DshSurfaceVariant)
            .border(dimens.border, DshOutline, shape)
            .padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/** 输入胶囊里的图标（回形针 / 相机）：16dp、次要前景色，触摸目标补到 30dp。 */
@Composable
fun ComposerIcon(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .size(30.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = DshOnSurfaceVariant,
            modifier = Modifier.size(16.dp),
        )
    }
}

/** 发送键（画稿 02）：28dp 实心橙圆 + 16dp 白色上箭头；不可发送时压成深灰。 */
@Composable
fun CircleSendButton(
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .size(28.dp)
            .clip(CircleShape)
            .background(if (enabled) DshPrimary else DshSurfaceHigh)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Icons.Default.ArrowUpward,
            contentDescription = "发送",
            tint = if (enabled) Color.White else DshNeutral,
            modifier = Modifier.size(16.dp),
        )
    }
}

/**
 * 轨迹页的客户端筛选档（画稿 03 顶栏「筛选」）。
 *
 * 只是把已经摊平好的行按类型过滤给 [com.deepseek.dshremote.ui.components.TrajectoryList]，
 * **不动数据层**：轨迹行本来就是对话窗口的投影，筛掉几类不会让分页窗口变化。
 */
enum class TrajectoryFilter(val label: String) {
    All("全部"),
    Tool("工具调用"),
    Thought("思考"),
    Result("结果"),
    Todo("待办"),
    Deliverable("交付物"),
    Note("系统"),
    ;

    fun matches(row: TrajectoryRow): Boolean = when (this) {
        All -> true
        Tool -> row.kind == TrajectoryKind.TOOL
        Thought -> row.kind == TrajectoryKind.THOUGHT
        Result -> row.kind == TrajectoryKind.RESULT
        Todo -> row.kind == TrajectoryKind.TODO
        Deliverable -> row.kind == TrajectoryKind.DELIVERABLE
        Note -> row.kind == TrajectoryKind.NOTE
    }
}

/**
 * 耗时显示成 `mm:ss`（画稿里的「已用 02:14」「用时 02:14」）。
 *
 * 为什么不复用 [com.deepseek.dshremote.ui.components.Fmt.duration]：那个是给
 * 单个工具卡用的 `28.4s / 3m12s`，而汇总条要的是等宽的时间码。
 */
fun formatElapsed(millis: Long): String {
    if (millis <= 0L) return "—"
    val totalSeconds = millis / 1000
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60
    return if (hours > 0) {
        String.format(Locale.US, "%d:%02d:%02d", hours, minutes, seconds)
    } else {
        String.format(Locale.US, "%02d:%02d", minutes, seconds)
    }
}

/** 输入区上方的分隔线颜色（画稿 02 是纯 DshOutline，不是更暗的 hairline）。 */
val ComposerDivider: Color = DshOutline

/** 详情页底色：画稿是纯黑，不是 M3 的 surface。 */
val DetailBackground: Color = DshBackground

/**
 * 轮次导航面板（桌面端对话区那条"轮次导航"浮层的手机版）。
 *
 * 为什么是底部抽屉而不是桌面端那样的贴边浮卡：桌面端能 hover，手机不能——
 * 一个"要点开、要滑动、还要能看见当前在第几轮"的面板，在手机上只有底部抽屉
 * 能同时满足（拇指可达、不遮住正在读的那条消息、可以列很多轮）。
 *
 * 列表**从最新往回排**：用户打开它 90% 是为了回到刚过去的那几轮，
 * 倒序让"最近"落在拇指最先够到的位置。
 *
 * 面板自己不做任何数据判断：`turns/loading/error` 全部由 ViewModel 给，
 * 这样"加载失败"与"这段会话没有轮次"是两件事，不会互相伪装。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TurnNavSheet(
    total: Int,
    turns: List<TurnIndexEntry>,
    loading: Boolean,
    error: String?,
    currentTurn: Int,
    onSelect: (TurnIndexEntry) -> Unit,
    onRefresh: () -> Unit,
    onDismiss: () -> Unit,
) {
    val type = LocalDshType.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = DshSurface,
        // 默认的 4dp 拖拽条在纯黑底上几乎看不见，加宽到 36dp 让"这里能拖"看得出来
        dragHandle = {
            Box(
                Modifier
                    .padding(top = 10.dp, bottom = 6.dp)
                    .size(width = 36.dp, height = 4.dp)
                    .clip(CircleShape)
                    .background(DshOutline),
            )
        },
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 20.dp, end = 12.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "轮次导航",
                    style = type.detailTitle,
                    color = DshOnBackground,
                    modifier = Modifier.weight(1f),
                )
                // 轮次数是这一页的"读数"，与右上角的刷新并排
                if (total > 0) {
                    Text(
                        text = "共 $total 轮",
                        style = type.meta,
                        color = DshOnSurfaceVariant,
                        modifier = Modifier.padding(end = 4.dp),
                    )
                }
                DshIconButton(
                    icon = Icons.Default.Refresh,
                    contentDescription = "刷新轮次",
                    onClick = onRefresh,
                    enabled = !loading,
                )
            }
            when {
                turns.isEmpty() && loading -> Box(
                    Modifier.fillMaxWidth().heightIn(min = 120.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(22.dp),
                        strokeWidth = 2.dp,
                        color = DshPrimary,
                    )
                }

                turns.isEmpty() && error != null -> Column(Modifier.fillMaxWidth()) {
                    EmptyHint(text = error)
                    TextButton(
                        onClick = onRefresh,
                        modifier = Modifier.align(Alignment.CenterHorizontally),
                    ) {
                        Text(text = "重试", style = type.meta, color = DshPrimary)
                    }
                }

                turns.isEmpty() -> EmptyHint(
                    text = "这段会话还没有可跳转的轮次。\n轮次是每一问一答，出现后就能在这里跳回去。",
                )

                else -> LazyColumn(
                    modifier = Modifier.fillMaxWidth().heightIn(max = 460.dp),
                    contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    // 最新的排在最上面：打开面板多半是为了回到刚过去的那几轮
                    items(turns.asReversed(), key = { it.turn }) { entry ->
                        TurnNavRow(
                            entry = entry,
                            current = entry.turn == currentTurn,
                            onClick = { onSelect(entry) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * 轮次导航里的一行：轮号 + 用户那句话 + 助手那句回复 + 规模读数。
 *
 * 预览文案由服务端各截 200 字符（`turn-index`），这里再按行数夹一次：
 * 服务端的截断是为了不把带图片/长代码的轮次整包塞进导航接口，
 * 这里的夹断是为了让每行等高——不等高的列表滚起来会"一跳一跳"。
 */
@Composable
private fun TurnNavRow(
    entry: TurnIndexEntry,
    current: Boolean,
    onClick: () -> Unit,
) {
    val type = LocalDshType.current
    val dimens = LocalDshDimens.current
    val shape = RoundedCornerShape(DshRadius.Sub)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (current) DshPrimary.copy(alpha = 0.10f) else DshSurfaceVariant)
            .border(
                dimens.border,
                if (current) DshPrimary.copy(alpha = 0.55f) else DshOutline,
                shape,
            )
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        // 轮号方块：等宽数字保证 9→10 轮不会让预览文字左右抖动
        Box(
            modifier = Modifier
                .padding(top = 1.dp)
                .size(26.dp)
                .clip(RoundedCornerShape(DshRadius.Small))
                .background(if (current) DshPrimary else DshSurfaceHigh),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = entry.turn.toString(),
                style = type.monoMeta.copy(fontWeight = FontWeight.Bold),
                color = if (current) Color.White else DshOnSurfaceVariant,
                maxLines = 1,
            )
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(start = 10.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                // 纯图片轮次没有文字：不给一个空的灰行，直接说清楚这一轮是什么
                text = turnPreviewText(entry.userText).ifBlank { "（图片或附件轮次）" },
                style = type.body,
                color = DshOnBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (entry.assistantText.isNotBlank()) {
                Text(
                    text = turnPreviewText(entry.assistantText),
                    style = type.meta,
                    color = DshOnSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                text = turnNavStats(entry),
                style = type.tiny,
                color = DshNeutral,
                maxLines = 1,
            )
        }
        if (current) {
            Text(
                text = "当前",
                style = type.tiny,
                color = DshPrimary,
                modifier = Modifier.padding(start = 8.dp, top = 2.dp),
            )
        }
    }
}

/**
 * 轮次预览的清洗：把消息原文投影成一行可读的摘要。
 *
 * 服务端给的是**原始消息文本**（`turn-index` 只做长度截断，不改内容），直接摊在面板里会把
 * Markdown 语法标记一起显示出来——真机取证时第 4 轮的预览就是「- **头部**：执行轨迹…
 * |---|---|---|」，读起来像乱码。这里复用会话页同一套 Markdown 解析器做纯文本投影
 * （顺带把表格、列表、引用、代码块都摊平成句子），再把空白折叠成单空格：
 * 预览最多两行，保留换行只会让夹断点落在词中间。
 *
 * 纯函数、无 Compose 依赖，所以能被 JVM 单测直接覆盖（见 `TurnPreviewTextTest`）。
 *
 * 还额外吃掉表格竖线：服务端把预览截断到 200 字符，表格常被切在中间（只剩表头加半行
 * `|---|`），这时解析器认不出表格、竖线会当正文留下来——真机上第 1 轮的预览就是这样一串
 * `| 文件 | 尺寸 | 字节数 | |---|---|---|`。预览只有一行，竖线保留没有信息量。
 * 判定用「竖线至少两个」而不是「有一个就吃」：`ps aux | grep node` 这种单管道是内容本身，
 * 一根竖线留着比丢掉更诚实；表格残留必然成串。只在预览里做这件事，会话正文不受影响。
 */
internal fun turnPreviewText(raw: String): String {
    if (raw.isBlank()) return ""
    val plain = MarkdownParser.toPlainText(raw)
    val cleaned = if (plain.count { it == '|' } >= 2) {
        // 表格残留：先吃竖线（`| 文件 | 尺寸 |` → ` 文件 尺寸 `），再吃只剩破折号的单元格
        // （`|---|---|` → ` --- --- --- `，这一串连字符没有任何信息量）。
        plain.replace(TABLE_PIPES, " ").replace(TABLE_DASH_CELLS, " ")
    } else {
        plain
    }
    return cleaned.replace(WHITESPACE_RUN, " ").trim()
}

private val WHITESPACE_RUN = Regex("\\s+")

/** 表格竖线（含 `|---|` 分隔行）：`\s*\|+\s*`，替换成单个空格。 */
private val TABLE_PIPES = Regex("\\s*\\|+\\s*")

/** 表格分隔单元格残留的破折号串（`--- --- ---` / `:---:`），仅在有竖线时启用。 */
private val TABLE_DASH_CELLS = Regex("(:?-{2,}:?\\s*)+")

/** 一行的读数：`14:06 · 3 步 · 2 次工具`（没有的段直接不出现）。 */
private fun turnNavStats(entry: TurnIndexEntry): String {
    val parts = mutableListOf<String>()
    if (entry.at > 0L) parts += Fmt.clock(entry.at)
    if (entry.steps > 0) parts += "${entry.steps} 步"
    if (entry.toolCalls > 0) parts += "${entry.toolCalls} 次工具"
    if (entry.messageCount > 0) parts += "${entry.messageCount} 条"
    return parts.joinToString(" · ")
}
