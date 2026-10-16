package com.deepseek.dshremote.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Adjust
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.deepseek.dshremote.data.api.ChatMessage
import com.deepseek.dshremote.data.api.Deliverable
import com.deepseek.dshremote.data.api.ImageLoader
import com.deepseek.dshremote.data.api.ImageRef
import com.deepseek.dshremote.data.api.TodoItem
import com.deepseek.dshremote.data.api.ToolCall
import com.deepseek.dshremote.data.api.ToolCallSummary
import com.deepseek.dshremote.ui.markdown.MarkdownText
import com.deepseek.dshremote.ui.theme.DshCodeText
import com.deepseek.dshremote.ui.theme.DshDiffAddedBg
import com.deepseek.dshremote.ui.theme.DshDiffAddedText
import com.deepseek.dshremote.ui.theme.DshDiffHunkText
import com.deepseek.dshremote.ui.theme.DshDiffRemovedBg
import com.deepseek.dshremote.ui.theme.DshDiffRemovedText
import com.deepseek.dshremote.ui.theme.DshError
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshPrimaryContainer
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSecondary
import com.deepseek.dshremote.ui.theme.DshSuccess
import com.deepseek.dshremote.ui.theme.DshSurface
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshWarning
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType

/**
 * 对话流原语：用户气泡、助手正文、思考折叠行、工具调用卡、交付物、任务清单、错误提示。
 *
 * 几何全部来自画稿 `gen_02_detail.py`（1080×2340 @3x → ÷3 = dp/sp），
 * 密度令牌取自 `ui/theme/Dimens.kt` + `ui/theme/Type.kt`，**本文件不再出现散落的 dp/sp 常量**：
 * 一处 `12.dp` 一处 `16.sp` 的写法正是旧版"一半画稿、一半 M3 默认"的来源。
 */

/**
 * 内容列宽上限：画稿里对话内容 320dp（360dp 屏 − 左右各 20dp 页边距）。
 *
 * 只作为**上限**使用（`widthIn`），不作为固定宽度：详情页的对话流本身已经带了页边距，
 * 写死 320dp 在 360dp 屏上刚好，但在更窄的机型（≤320dp 宽）上会横向裁掉正文。
 */
private val CONTENT_WIDTH_MAX = 320.dp

/** 用户气泡宽度上限（画稿 750px ÷ 3）。 */
private val BUBBLE_WIDTH = 250.dp

/** 思考折叠行高度（画稿 90px ÷ 3）。 */
private val THINKING_ROW_HEIGHT = 30.dp

/** 工具卡头部高度（画稿 102px ÷ 3）。 */
private val TOOL_HEADER_HEIGHT = 34.dp

/**
 * 用户气泡（靠右）。
 *
 * 右缘对齐内容列右界（320dp）、整块 250dp：给了固定宽度而不是 widthIn(max)，
 * 因为画稿里两条不同长短的用户消息右缘与左缘都在同一条线上，气泡是等宽的。
 *
 * 图片（手机拍/传的，以及桌面端会话里的用户图）放在气泡**上方**而不是塞进气泡里：
 * 气泡是 13dp 内边距的容器，图片进去就被裁掉一圈，而用户期望的是"我发的图"
 * 完整显示。图片带与气泡同宽（[BUBBLE_WIDTH]），右缘因此仍然对齐。
 */
@Composable
fun UserBubble(
    text: String,
    at: Long,
    modifier: Modifier = Modifier,
    images: List<ImageRef> = emptyList(),
    loader: ImageLoader = ImageLoader.None,
    onOpenImage: (List<ImageRef>, Int) -> Unit = { _, _ -> },
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
    ) {
        Column(
            horizontalAlignment = Alignment.End,
            modifier = Modifier.widthIn(max = CONTENT_WIDTH_MAX),
        ) {
            if (images.isNotEmpty()) {
                MessageImageStrip(
                    images = images,
                    loader = loader,
                    onOpen = { index -> onOpenImage(images, index) },
                    modifier = Modifier.widthIn(max = BUBBLE_WIDTH),
                )
                if (text.isNotEmpty()) Spacer(Modifier.height(6.dp))
            }
            // 纯图片轮次没有文字（服务端 contentText 只拼 text 块），
            // 这时不再画一个空气泡：一个 26dp 高的橙色空条比没有更让人困惑。
            if (text.isNotEmpty()) {
                Box(
                    modifier = Modifier
                        .widthIn(max = BUBBLE_WIDTH)
                        .clip(RoundedCornerShape(DshRadius.Card))
                        .background(DshPrimaryContainer)
                        // 描边用主色的 45% alpha：气泡与"可操作"同源，但比实心橙按钮弱一档
                        .border(dimens.border, DshPrimary.copy(alpha = 0.45f), RoundedCornerShape(DshRadius.Card))
                        .padding(horizontal = 13.dp, vertical = 10.dp),
                ) {
                    MarkdownText(
                        text = text,
                        textStyle = type.body,
                        color = DshOnBackground,
                        compact = true,
                    )
                }
            }
            Text(
                text = Fmt.clock(at),
                style = type.meta,
                color = DshNeutral,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

/**
 * 思考块折叠行（`思考 · 1.2s`）。
 *
 * 为什么做成公开组件而不是塞进 [AssistantMessage]：思考文本目前没有独立的数据字段
 * （`ChatMessage` 只有 text / toolCalls / deliverables / todos），
 * 由详情页决定何时展示这一行、展开后渲染什么；这里只负责画稿的那一条 30dp 行。
 */
@Composable
fun ThinkingRow(
    label: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val type = LocalDshType.current
    Row(
        modifier = modifier
            .widthIn(max = CONTENT_WIDTH_MAX)
            .height(THINKING_ROW_HEIGHT)
            .clip(RoundedCornerShape(DshRadius.Sub))
            .background(DshSurfaceVariant)
            .border(LocalDshDimens.current.border, DshOutline, RoundedCornerShape(DshRadius.Sub))
            // 整行可点：只让箭头可点的话，用户戳在文字上会"没反应"
            .clickable(onClick = onToggle)
            .padding(start = 14.dp, end = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (expanded) Icons.Default.ExpandMore else Icons.Default.ChevronRight,
            contentDescription = if (expanded) "收起思考" else "展开思考",
            tint = DshOnSurfaceVariant,
            modifier = Modifier.size(12.dp),
        )
        Text(
            text = label,
            style = type.label.copy(fontWeight = FontWeight.Bold),
            color = DshOnSurfaceVariant,
            modifier = Modifier.padding(start = 4.dp).weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = if (expanded) "点击收起" else "已折叠 · 点击展开",
            style = type.meta,
            color = DshOnSurfaceVariant,
            maxLines = 1,
        )
    }
}

// ---------------------------------------------------------------------------
// 工具调用分组（纯逻辑：没有 Compose 依赖，可在 JVM 单测里直接跑，见 ToolGroupingTest）
// ---------------------------------------------------------------------------

/** 组汇总行里最多列几个工具名；超出的用 `…` 收口。 */
internal const val TOOL_RUN_SUMMARY_NAME_LIMIT = 3

/** 展开一组时最多铺开多少张卡；其余收成一行「还有 N 次调用」。 */
internal const val TOOL_RUN_EXPANDED_LIMIT = 20

/**
 * 一条助手消息里工具的**一次成组**。
 *
 * 分组不是为了排版好看，而是"往回翻时还找不找得到上一次人机交互"的判据：
 * 一次调用给一行、连续多次给一行汇总，6 次调用就从 6 行（每行 48dp）压成 1 行。
 */
internal data class ToolRun(val calls: List<ToolCall>) {

    /** 各工具名的出现次数，**按首次出现顺序**（`edit×4 · pwsh×2` 的原始数据）。 */
    val nameCounts: List<Pair<String, Int>> = calls.groupingBy { it.name }.eachCount().toList()

    /**
     * 出现次数最多的工具名（并列取先出现的）：组头的图标与强调条颜色都按它定，
     * 于是"这一屏在写文件还是跑命令"仍然不用读文字就看得出（与单卡同一套判据）。
     */
    val dominantName: String = nameCounts.maxByOrNull { it.second }?.first.orEmpty()

    val size: Int get() = calls.size

    /**
     * 是否要画汇总行：**两次及以上才成组**。
     *
     * 单次调用直接用 [ToolCallCard] 自己的头部当那一行，不再套一层汇总 ——
     * 多一层只有"我到底点的是组还是卡"这一种信息，点错一次就是一次无效操作。
     */
    val isGroup: Boolean get() = calls.size > 1

    /** 组的稳定身份 = 首个调用 id（展开状态的存档 key 与列表回收都靠它）。 */
    val key: String get() = calls.firstOrNull()?.id.orEmpty()

    val failedCount: Int get() = calls.count { it.isError }

    /** 还没回结果的调用：实时草稿里正在跑的那几个（`result` 为空且不是错误）。 */
    val runningCount: Int get() = calls.count { !it.isError && !it.hasResult }

    /** 合计耗时。逐次相加：串行调用≈真实等待，并行调用会偏大，但不会像取最大值那样在串行时严重低估。 */
    val totalDurationMs: Long get() = calls.sumOf { it.durationMs }

    /**
     * 汇总行的状态文案，优先级：失败 > 进行中 > 全部成功。
     *
     * 失败分支是**防御性**的：失败调用在分组阶段就被拆出去了（见 [groupToolCalls]），
     * 正常路径上组里不该有失败；但手工构造的 [ToolRun] 也必须说实话，不能硬写"全部成功"。
     */
    val statusText: String get() = when {
        failedCount > 0 && runningCount > 0 -> "$failedCount 次失败 · $runningCount 次进行中"
        failedCount > 0 -> "$failedCount 次失败"
        runningCount > 0 -> "$runningCount 次进行中"
        else -> "全部成功"
    }
}

/**
 * 把一条消息里的工具调用切成若干组：**连续的非失败调用**成一组，失败调用各自单独一组。
 *
 * 两条规则都服务于同一件事——"翻回去找人机交互"：
 * 1. 连续调用合并 ⇒ 6 次调用从 6 行压成 1 行，一屏能重新装下好几轮对话；
 * 2. 失败调用既不进组也不和相邻调用合并 ⇒ "出错了"永远是可见的一行。
 *    出错的提示一旦需要点开才看得到，就等于没有提示。
 *    代价是 `[ok, ok, err, ok]` 会被切成三组而不是两组，这是**刻意**的。
 *
 * 组内顺序、组间顺序都与入参一致（单测里钉住：摊平回来必须等于原列表）。
 */
internal fun groupToolCalls(calls: List<ToolCall>): List<ToolRun> {
    val runs = ArrayList<ToolRun>()
    val pending = ArrayList<ToolCall>()
    fun flush() {
        if (pending.isNotEmpty()) {
            runs += ToolRun(pending.toList())
            pending.clear()
        }
    }
    for (call in calls) {
        if (call.isError) {
            flush()
            runs += ToolRun(listOf(call))
        } else {
            pending += call
        }
    }
    flush()
    return runs
}

/**
 * 折叠组的汇总文案：`6 次工具调用 · edit×4 · pwsh×2 · 全部成功 · 5.0s`。
 *
 * 三处取舍：
 * - **计数为 1 的工具不写 `×1`**：出现次数在开头的 `N 次工具调用` 里已经说清了，`×1` 只占宽度；
 * - **最多列 [TOOL_RUN_SUMMARY_NAME_LIMIT] 个工具名**，超出用 `…` 收口。行宽是定死的
 *   （360dp 屏 320dp 内容宽，见 [CONTENT_WIDTH_MAX]），列到第四五个名字时 Android 的尾部
 *   省略号会开始随机吃掉后半段；与其让它乱截，不如自己先收口；
 * - **耗时没有计时信息时整段不出现**（见 [formatDuration]），而不是写成 `—`。
 *
 * 尾部被省略号截掉一段**不致命**：失败调用根本不进组（见 [groupToolCalls]），
 * 所以代价最多是一句 `全部成功` 和一个时长，而"是什么工具、有几次"永远在最前面。
 */
internal fun toolRunSummary(run: ToolRun): String {
    if (run.calls.isEmpty()) return ""
    val parts = ArrayList<String>(4)
    parts += "${run.calls.size} 次工具调用"
    val names = run.nameCounts.take(TOOL_RUN_SUMMARY_NAME_LIMIT).joinToString(" · ") { (name, count) ->
        // 服务端偶尔给出空工具名：直接拼出来是 `×4`，看不出这是什么，兜一个词比留空好
        val label = name.ifBlank { "工具" }
        if (count > 1) "$label×$count" else label
    }
    if (names.isNotEmpty()) {
        parts += if (run.nameCounts.size > TOOL_RUN_SUMMARY_NAME_LIMIT) "$names …" else names
    }
    parts += run.statusText
    val duration = formatDuration(run.totalDurationMs)
    if (duration.isNotEmpty()) parts += duration
    return parts.joinToString(" · ")
}

/**
 * 汇总行里的耗时，沿用 [Fmt.duration] 的格式（`5.0s` / `3m12s`），**不另造一套**。
 *
 * 只加一条规则：`ms <= 0`（没有计时信息）返回空串。契约 v2 的 `ToolCall.durationMs`
 * 在实时草稿里恒为 0，写成 `—` 会让人读成"跑了 0 秒"，什么都不写才是"还不知道"；
 * 单卡头部仍然必须写出 `exit 0` 这类状态，所以这条规则只属于汇总行。
 */
internal fun formatDuration(ms: Long): String = if (ms <= 0L) "" else Fmt.duration(ms)

/** 展开一组时真正铺开的调用，以及被收成一行提示的数量。 */
internal data class ToolRunWindow(val visible: List<ToolCall>, val hidden: Int)

/**
 * 展开一组时要铺开的调用：只取前 [limit] 个，其余收成一行「还有 N 次调用」。
 *
 * 为什么要设上限：一条消息里的工具调用数量没有上界（长任务一次上百次不罕见），
 * 而展开出来的卡在 LazyColumn 里是**同一个 item**（消息是 item，卡是 item 内的静态节点），
 * 一次铺 100 张卡 = 100 个可组合节点同时进组合，滚动立刻掉帧。
 * [TOOL_RUN_EXPANDED_LIMIT] 张 ≈ 一屏半，足够看清"这批工具干了什么"；
 * 完整步骤在「轨迹」页（懒加载的列表）里一条不少。
 *
 * `limit <= 0` 退化成"全部收口"而不是抛异常（`take(负数)` 会抛 IllegalArgumentException）。
 */
internal fun toolRunWindow(calls: List<ToolCall>, limit: Int = TOOL_RUN_EXPANDED_LIMIT): ToolRunWindow {
    val take = limit.coerceAtLeast(0)
    return ToolRunWindow(
        visible = if (take >= calls.size) calls else calls.take(take),
        hidden = (calls.size - take).coerceAtLeast(0),
    )
}

/**
 * 消息级身份，用作工具组展开状态的存档 key。
 *
 * `ChatMessage` 没有 id 字段，能当身份用的只有 [ChatMessage.seq]——但本地乐观消息与实时草稿的
 * seq 恒为 0（见 [com.deepseek.dshremote.data.api.LiveDraftMerge]），拿 0 当身份会让所有草稿
 * 共用同一个存档槽，于是退回"首个 call.id"。
 */
private fun messageKeyOf(message: ChatMessage): String =
    if (message.seq > 0L) {
        "seq-${message.seq}"
    } else {
        "draft-${message.toolCalls.firstOrNull()?.id.orEmpty()}"
    }

/**
 * 助手消息（靠左、流式）。
 *
 * 刻意不做气泡：模型输出经常是多段中文长文，气泡会把可用宽度压窄；
 * DeepSeek/codex 手机端同样是"文字直接铺在页面上"，所以正文用 12.5sp/17sp 直接落在页面上。
 *
 * 头部不再画「助手 / #seq」标签行：画稿里助手这一侧只有正文与工具卡，
 * 身份信息由对话流的位置（左/右）与颜色（灰字/橙气泡）表达，再挂一行标签就是噪音。
 */
@Composable
fun AssistantMessage(
    message: ChatMessage,
    expandedTools: Set<String>,
    onToggleTool: (String) -> Unit,
    onOpenDeliverable: (Deliverable) -> Unit,
    modifier: Modifier = Modifier,
    streaming: Boolean = false,
    loader: ImageLoader = ImageLoader.None,
    onOpenImage: (List<ImageRef>, Int) -> Unit = { _, _ -> },
) {
    val type = LocalDshType.current
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (message.text.isNotEmpty()) {
            // 模型输出几乎总是 Markdown（标题/列表/代码块/表格），渲染成富文本比原样显示可读得多
            MarkdownText(
                text = message.text,
                textStyle = type.bodyLoose,
                color = DshOnBackground,
                streaming = streaming,
                modifier = Modifier.widthIn(max = CONTENT_WIDTH_MAX),
            )
        }
        // 助手侧带图（模型返回的图片块）与用户侧同款呈现，但左对齐
        if (message.images.isNotEmpty()) {
            MessageImageStrip(
                images = message.images,
                loader = loader,
                onOpen = { index -> onOpenImage(message.images, index) },
                modifier = Modifier.widthIn(max = CONTENT_WIDTH_MAX),
            )
        }
        if (message.truncated) {
            Text(
                text = "（服务端已截断：单条消息上限 256 KiB，只保留头部）",
                style = type.meta,
                color = DshOnSurfaceVariant,
            )
        }
        // 先分组再渲染：连续的工具调用压成一行汇总，失败调用永远单独成卡。
        // remember 的 key 用列表本身：实时草稿每追加一个调用就产生一份新列表，分组跟着重算。
        val runs = remember(message.toolCalls) { groupToolCalls(message.toolCalls) }
        val messageKey = messageKeyOf(message)
        runs.forEach { run ->
            if (run.isGroup) {
                ToolRunGroup(
                    run = run,
                    // 归档 key 带上消息身份 + 组内首个 call.id：同一条消息里的多个组在
                    // forEach 里共用同一个复合 key，只靠位置存状态会在列表回收后串台。
                    stateKey = "toolrun:$messageKey:${run.key}",
                    expandedTools = expandedTools,
                    onToggleTool = onToggleTool,
                    loader = loader,
                    onOpenImage = onOpenImage,
                )
            } else {
                run.calls.firstOrNull()?.let { call ->
                    ToolCallCard(
                        call = call,
                        expanded = expandedTools.contains(call.id),
                        onToggle = { onToggleTool(call.id) },
                        loader = loader,
                        onOpenImage = onOpenImage,
                    )
                }
            }
        }
        message.deliverables.forEach { deliverable ->
            DeliverableCard(deliverable = deliverable, onClick = { onOpenDeliverable(deliverable) })
        }
    }
}

/** 工具输出按行分类：决定每行的底色与字色，是"扫一眼就能区分读/写/跑"的关键。 */
private enum class OutLineKind { Meta, Hunk, Added, Removed, Normal }

private data class OutLine(val text: String, val kind: OutLineKind)

/**
 * 是否按 diff 渲染。
 *
 * 门槛故意抬高：只有出现 `@@` hunk 头（或 `diff --git`）才进 diff 模式。
 * 否则 `+1 项` 这类正文普通行会被误判成新增行并铺上绿底 —— 宁可少染一次色，也不要误染。
 */
private fun looksLikeDiff(text: String): Boolean =
    text.contains("@@") || text.lineSequence().any { it.startsWith("diff --git") }

private fun classifyDiffLines(text: String): List<OutLine> = text.lineSequence().map { line ->
    when {
        line.startsWith("@@") -> OutLine(line, OutLineKind.Hunk)
        line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") -> OutLine(line, OutLineKind.Meta)
        line.startsWith("+") -> OutLine(line, OutLineKind.Added)
        line.startsWith("-") -> OutLine(line, OutLineKind.Removed)
        else -> OutLine(line, OutLineKind.Normal)
    }
}.toList()

private fun outLineColor(kind: OutLineKind): Color = when (kind) {
    OutLineKind.Hunk -> DshDiffHunkText
    OutLineKind.Added -> DshDiffAddedText
    OutLineKind.Removed -> DshDiffRemovedText
    OutLineKind.Meta -> DshNeutral
    OutLineKind.Normal -> DshCodeText
}

private fun outLineBackground(kind: OutLineKind): Color = when (kind) {
    OutLineKind.Added -> DshDiffAddedBg
    OutLineKind.Removed -> DshDiffRemovedBg
    // hunk 头刻意无底色：它是分隔符不是内容行，铺底会让 diff 块看起来碎成三段
    else -> Color.Transparent
}

/** 普通输出行色：构建成功绿、以 `>` 开头的任务行次要色、其余用代码正文色。 */
private fun outputLineColor(line: String): Color = when {
    line.contains("BUILD SUCCESSFUL") -> DshSuccess
    line.startsWith(">") -> DshOnSurfaceVariant
    else -> DshCodeText
}

/**
 * 工具调用卡（`tool_frame`）。
 *
 * 画稿与旧实现的三处结构性差别，都是"能不能一眼扫过去"的问题：
 * 1. 左侧 4dp 彩色强调条按工具类型着色（跑命令=琥珀、写文件=绿、读文件=橙），
 *    滚动时不用读文字就知道这一屏在跑什么；
 * 2. 头部 34dp 固定高 + 名称等宽加粗：工具名（`pwsh` / `edit app/build.gradle.kts`）
 *    与右侧统计（`28.4s · exit 0`）在同一基线上，旧实现用 M3 labelLarge 会随行高漂移；
 * 3. 正文按行着色（diff 增删行整行铺底、hunk 头无底色），而不是整块单一灰字。
 * 4. **折叠态只有一行**：早期版本在头部下面还挂一行结果预览（`The file D:\…`），
 *    于是每张卡固定 2 行 65dp、一屏只装得下 6 张 —— 工具卡把对话流淹没，用户往回翻
 *    找不到上一次提问。现在折叠态就是头部那一行（含上下留白 48dp），结果要点开才渲染。
 *
 * 参数与结果不再分区加标题行：展开态里"参数 → 结果"本来就有固定的先后顺序，
 * 多两行「参数」「结果」小标题只会把卡片撑高二三十 dp。
 */
@Composable
fun ToolCallCard(
    call: ToolCall,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    loader: ImageLoader = ImageLoader.None,
    onOpenImage: (List<ImageRef>, Int) -> Unit = { _, _ -> },
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val accent = when {
        call.isError -> DshError
        else -> toolAccent(call.name)
    }
    val shape = RoundedCornerShape(DshRadius.Panel)
    val diffMode = call.hasResult && looksLikeDiff(call.result)

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(DshSurface)
            .border(dimens.border, if (call.isError) DshError.copy(alpha = 0.7f) else DshOutline, shape)
            // 整卡可点：折叠态只剩 34dp 高，只让 14dp 的 chevron 可点会远小于 48dp 的最小可点尺寸
            .clickable(onClick = onToggle),
    ) {
        // 强调条：左缘起 0.3dp（0.3 = 画稿 1px @3x），纵向缩进 14dp，不碰到卡片的 14dp 圆角
        Box(
            Modifier
                .align(Alignment.TopStart)
                .offset(x = 0.3.dp, y = 14.dp)
                .width(4.dp)
                .heightIn(min = 20.dp)
                .background(accent, RoundedCornerShape(2.dp)),
        )
        Column(modifier = Modifier.padding(bottom = 14.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(TOOL_HEADER_HEIGHT)
                    .padding(start = 14.dp, end = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = toolIcon(call.name),
                    contentDescription = null,
                    tint = accent,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    text = call.name,
                    style = type.monoBody.copy(fontWeight = FontWeight.Bold),
                    color = DshOnBackground,
                    maxLines = 1,
                    modifier = Modifier.padding(start = 6.dp).weight(1f, fill = false),
                )
                // 右侧统计：等宽保证同行不同卡的数字能对齐成一列
                Text(
                    text = toolStats(call),
                    style = type.monoMeta,
                    color = if (call.isError) DshError else DshSuccess,
                    maxLines = 1,
                    textAlign = TextAlign.End,
                    modifier = Modifier.padding(start = 8.dp),
                )
                Icon(
                    imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = if (expanded) "收起" else "展开",
                    tint = DshOnSurfaceVariant,
                    modifier = Modifier.padding(start = 6.dp).size(14.dp),
                )
            }
            if (expanded) {
                ExpandedToolBody(
                    call = call,
                    diffMode = diffMode,
                    loader = loader,
                    onOpenImage = onOpenImage,
                )
            }
        }
    }
}

@Composable
private fun ExpandedToolBody(
    call: ToolCall,
    diffMode: Boolean,
    loader: ImageLoader = ImageLoader.None,
    onOpenImage: (List<ImageRef>, Int) -> Unit = { _, _ -> },
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Column {
        if (call.argsJson.isNotBlank() && call.argsJson != "{}") {
            Text(
                text = ToolCallSummary.pretty(call.argsJson),
                style = type.monoMeta,
                color = DshOnSurfaceVariant,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 32.dp, end = 12.dp, top = 6.dp),
            )
        }
        // 工具产出/读入的图片（read_image、截图、presented 图片）：展开态直接给图，
        // 否则用户只能看到一行"（无输出）"——那正是纯图片类工具在手机上的现状。
        if (call.images.isNotEmpty()) {
            MessageImageStrip(
                images = call.images,
                loader = loader,
                onOpen = { index -> onOpenImage(call.images, index) },
                modifier = Modifier
                    .widthIn(max = CONTENT_WIDTH_MAX)
                    .padding(start = 32.dp, end = 12.dp, top = 6.dp),
            )
        }
        val result = call.result
        if (result.isBlank()) {
            // 只有图没有文字的工具（read_image 命中附件、截图工具）：图已经画在上面了，
            // 再补一行"（无输出）"是自相矛盾的读数
            if (call.images.isEmpty()) {
                Text(
                    text = "（无输出）",
                    style = type.monoBody,
                    color = DshNeutral,
                    modifier = Modifier.padding(start = 32.dp, end = 12.dp, top = 6.dp),
                )
            }
            return@Column
        }
        if (diffMode) {
            DiffLines(lines = classifyDiffLines(result), modifier = Modifier.padding(top = 6.dp))
        } else {
            Text(
                text = buildOutputText(result),
                style = type.monoBody,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 32.dp, end = 12.dp, top = 6.dp),
            )
        }
        if (call.truncated) {
            Text(
                text = "（服务端已截断：工具结果上限 32 KiB，只保留尾部）",
                style = type.meta,
                color = DshNeutral,
                modifier = Modifier.padding(start = 32.dp, end = 12.dp, top = 6.dp),
            )
        }
    }
}

/**
 * 一组工具调用的折叠行；点开之后才是各张 [ToolCallCard]。
 *
 * 三个决定：
 * 1. 组头**自己就是一张卡**（与单卡同一套 48dp 高度、4dp 强调条、1dp 描边），而不是"卡片外面再套容器"。
 *    卡本身带边框，嵌套边框会把"卡片"读成"分区"，于是每次滚动都要先分辨层级；
 * 2. 展开出来的各卡与组头**平级**，只是把行距收到 6dp（消息内默认 8dp）暗示归属；
 * 3. 默认折叠，并用 `rememberSaveable` 扛住 LazyColumn 回收 —— 滑出去再滑回来，
 *    刚展开的那一组不该自己合上（这正是"往回翻"的高频路径）。
 */
@Composable
private fun ToolRunGroup(
    run: ToolRun,
    stateKey: String,
    expandedTools: Set<String>,
    onToggleTool: (String) -> Unit,
    modifier: Modifier = Modifier,
    loader: ImageLoader = ImageLoader.None,
    onOpenImage: (List<ImageRef>, Int) -> Unit = { _, _ -> },
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val failed = run.failedCount > 0
    val accent = if (failed) DshError else toolAccent(run.dominantName)
    val shape = RoundedCornerShape(DshRadius.Panel)
    // 同一个值既当显式 key 又当 inputs，两者各管一件事：
    // - 显式 key：同一条消息里的多个组在 forEach 里共用同一个复合 key，只按位置存状态会串台
    //   （第一个组吃掉第二个组的存档值）；
    // - inputs：`SessionDetailScreen.kt` 的 itemsIndexed 没有稳定 key（用下标），
    //   槽位会被别的消息复用，此时状态必须归零，不能让新消息"继承"上一条的展开态。
    var expanded by rememberSaveable(stateKey, key = stateKey) { mutableStateOf(false) }

    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(DshSurface)
                .border(dimens.border, if (failed) DshError.copy(alpha = 0.7f) else DshOutline, shape)
                // 整行可点：34dp 的行高已经贴着最小可点尺寸的下限，再缩点击区就是在惩罚手指
                .clickable { expanded = !expanded },
        ) {
            // 强调条与单卡逐像素一致（同样 14dp 纵向缩进、20dp 高）：折叠的组与折叠的单卡
            // 应当像同一种东西，否则"这行点开会出什么"要靠试
            Box(
                Modifier
                    .align(Alignment.TopStart)
                    .offset(x = 0.3.dp, y = 14.dp)
                    .width(4.dp)
                    .heightIn(min = 20.dp)
                    .background(accent, RoundedCornerShape(2.dp)),
            )
            Column(modifier = Modifier.padding(bottom = 14.dp)) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(TOOL_HEADER_HEIGHT)
                        .padding(start = 14.dp, end = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = toolIcon(run.dominantName),
                        contentDescription = null,
                        tint = accent,
                        modifier = Modifier.size(16.dp),
                    )
                    // 汇总是一句话而不是标识符，所以用正文字体（label）而不是单卡的等宽加粗：
                    // 中文在等宽字体下要靠回退字体渲染，字距会明显松掉
                    Text(
                        text = toolRunSummary(run),
                        style = type.label,
                        color = if (failed) DshError else DshOnBackground,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 6.dp).weight(1f),
                    )
                    Icon(
                        imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                        contentDescription = if (expanded) "收起" else "展开",
                        tint = DshOnSurfaceVariant,
                        modifier = Modifier.padding(start = 6.dp).size(14.dp),
                    )
                }
            }
        }
        if (expanded) {
            val window = toolRunWindow(run.calls)
            window.visible.forEach { call ->
                ToolCallCard(
                    call = call,
                    expanded = expandedTools.contains(call.id),
                    onToggle = { onToggleTool(call.id) },
                    loader = loader,
                    onOpenImage = onOpenImage,
                )
            }
            if (window.hidden > 0) {
                Text(
                    text = "还有 ${window.hidden} 次调用（完整步骤见「轨迹」页）",
                    style = type.meta,
                    color = DshOnSurfaceVariant,
                    modifier = Modifier.padding(start = 32.dp, end = 12.dp),
                )
            }
        }
    }
}

/**
 * 普通输出：用带行内样式的单段富文本，保证"整块一个行高"。
 *
 * 逐行一个 `Text` 也能做，但每行会各自成段、基线不连续，几百行的构建日志会明显错位；
 * 这里只需要字色分行，`SpanStyle` 正好够用（不需要整行底色，diff 才需要）。
 */
private fun buildOutputText(result: String): AnnotatedString = buildAnnotatedString {
    result.lineSequence().forEachIndexed { index, line ->
        if (index > 0) append('\n')
        withStyle(SpanStyle(color = outputLineColor(line))) { append(line) }
    }
}

/**
 * diff 正文：逐行渲染。
 *
 * 为什么这里不用单段富文本：`SpanStyle` 的背景只覆盖字形边界，铺不满整行，
 * 而画稿要求增删行"整行铺底"。逐行 `Text` 才能让 `background` 修改器铺满行宽，
 * 并让每行按 11sp/17dp 单独排版 —— 代价是行与行各自成段，但 diff 的每行本来就是独立的。
 */
@Composable
private fun DiffLines(lines: List<OutLine>, modifier: Modifier = Modifier) {
    val lineStyle = LocalDshType.current.monoMeta.copy(fontSize = 11.sp)
    Column(modifier = modifier.fillMaxWidth()) {
        lines.forEach { line ->
            Text(
                text = line.text.ifEmpty { " " },
                style = lineStyle,
                color = outLineColor(line.kind),
                maxLines = 1,
                overflow = TextOverflow.Clip,
                modifier = Modifier
                    .fillMaxWidth()
                    // 左右各留 2dp：底色不贴屏幕边，也不贴卡片描边
                    .padding(horizontal = 2.dp)
                    .background(outLineBackground(line.kind))
                    .padding(start = 30.dp, end = 10.dp),
            )
        }
    }
}

/**
 * 头部右侧统计：`28.4s · exit 0`。
 *
 * 退出码由 `isError` 派生：契约里 `ToolCall` 只有 durationMs / isError / truncated，
 * 没有独立的 exitCode 字段，所以这里按"成功=0 / 失败≠0"表达，而不是凭空编一个码值；
 * 颜色同样按 `isError` 给（绿=成功、红=失败），调用处决定。
 */
private fun toolStats(call: ToolCall): String {
    val duration = if (call.durationMs > 0) Fmt.duration(call.durationMs) else null
    val status = if (call.isError) "exit ≠0" else "exit 0"
    return listOfNotNull(duration, status).joinToString(" · ")
}

/** 工具类型 → 强调条/图标颜色（画稿 §02：跑=琥珀、写=绿、读=橙）。 */
private fun toolAccent(name: String): Color = when (toolKind(name)) {
    ToolKind.Shell -> DshWarning
    ToolKind.Write -> DshSuccess
    ToolKind.Read -> DshSecondary
    ToolKind.Plan -> DshNeutral
    else -> DshNeutral
}

/** 交付物卡片：点击可在工作区里打开（由上层判断是否可点）。 */
@Composable
fun DeliverableCard(
    deliverable: Deliverable,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(DshRadius.Sub))
            .background(DshSurface)
            .border(
                dimens.border,
                if (deliverable.description.isNotEmpty()) DshPrimary.copy(alpha = 0.30f) else DshOutline,
                RoundedCornerShape(DshRadius.Sub),
            )
            .clickable(onClick = onClick)
            .padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Default.Description,
            contentDescription = null,
            tint = DshPrimary,
            modifier = Modifier.size(16.dp),
        )
        Column(Modifier.padding(start = 8.dp).weight(1f)) {
            Text(
                text = deliverable.path,
                style = type.monoBody,
                color = DshOnBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (deliverable.description.isNotEmpty()) {
                Text(
                    text = deliverable.description,
                    style = type.meta,
                    color = DshOnSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Text(
            text = "打开",
            style = type.label,
            color = DshPrimary,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

/**
 * 待办列表（从 todo/write 类工具调用的参数投影）。
 *
 * 高度 = 30dp 抬头的固定行 + 每项 20dp + 6dp 收尾，与画稿一致：
 * 任务清单是"一眼看进度"的组件，行距一旦变成 M3 默认的 8dp 间距就会松散成两倍高。
 */
@Composable
fun TodoListCard(
    todos: List<TodoItem>,
    modifier: Modifier = Modifier,
) {
    if (todos.isEmpty()) return
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(DshRadius.Panel))
            .background(DshSurface)
            .border(dimens.border, DshOutline, RoundedCornerShape(DshRadius.Panel))
            .padding(bottom = 6.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(30.dp)
                .padding(start = 14.dp, end = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "任务清单",
                style = type.label.copy(fontWeight = FontWeight.Bold),
                color = DshOnBackground,
                modifier = Modifier.weight(1f),
                maxLines = 1,
            )
            Text(
                text = "${todos.count { it.done }}/${todos.size}",
                style = type.monoMeta,
                color = DshOnSurfaceVariant,
                maxLines = 1,
            )
        }
        todos.forEach { todo ->
            val done = todo.done
            val active = !done && isActiveStatus(todo.status)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(20.dp)
                    .padding(start = 14.dp, end = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TodoMarker(done = done, active = active)
                Text(
                    text = todo.text,
                    style = type.label,
                    color = if (active) DshOnBackground else DshOnSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textDecoration = if (done) TextDecoration.LineThrough else TextDecoration.None,
                    modifier = Modifier.padding(start = 8.dp).weight(1f),
                )
            }
        }
    }
}

/**
 * 待办状态圈（12dp）：完成 = 绿实心 + 白勾、进行中 = 橙环、未开始 = 灰环。
 *
 * 进行中用 `Adjust`（实心圆里挖一个楔形）而不是画一段圆弧：12dp 下手绘弧线的
 * 起止角度在不同字号缩放里很难稳定，图标则跟着字号一起缩放。
 */
@Composable
private fun TodoMarker(done: Boolean, active: Boolean) {
    Box(modifier = Modifier.size(12.dp), contentAlignment = Alignment.Center) {
        when {
            done -> Box(
                Modifier
                    .size(12.dp)
                    .clip(CircleShape)
                    .background(DshSuccess),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Default.Check,
                    contentDescription = "已完成",
                    tint = Color.White,
                    modifier = Modifier.size(9.dp),
                )
            }

            active -> Icon(
                imageVector = Icons.Default.Adjust,
                contentDescription = "进行中",
                tint = DshPrimary,
                modifier = Modifier.size(12.dp),
            )

            else -> Box(
                Modifier
                    .size(12.dp)
                    .clip(CircleShape)
                    .border(1.dp, DshOutline, CircleShape),
            )
        }
    }
}

/** 进行中的 todo 状态：服务端用 `in_progress` / `active` 两种写法。 */
private fun isActiveStatus(status: String): Boolean =
    status == "in_progress" || status == "active" || status == "running"

/** 错误提示（工具结果失败、请求失败等）。 */
@Composable
fun ErrorText(text: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            imageVector = Icons.Default.ErrorOutline,
            contentDescription = null,
            tint = DshError,
            modifier = Modifier.size(16.dp),
        )
        Text(
            text = text,
            style = LocalDshType.current.label,
            color = DshError,
        )
    }
}

/** 工具大类：只用于挑颜色，不参与逻辑判断。 */
private enum class ToolKind { Shell, Write, Read, Plan, Other }

/**
 * 工具名 → 图标。
 *
 * 图标映射刻意**逐条保留旧实现**（`read/file/cat → Description`、`fetch/web/http → Language`）：
 * `ToolCallCard` 与执行轨迹（`TrajectoryList`）共用这个函数，两者改了图标会让同一次调用
 * 在对话流和轨迹页里长得不一样 —— 换视觉时不该顺手改语义。
 * 新增的只是 `toolAccent`：强调条颜色按"跑/写/读"三大类分，图标仍按具体工具分。
 */
fun toolIcon(name: String): ImageVector = when {
    name.contains("pwsh", true) || name.contains("bash", true) || name.contains("shell", true) ||
        name.contains("exec", true) || name.contains("terminal", true) -> Icons.Default.Terminal

    name.contains("write", true) || name.contains("edit", true) || name.contains("patch", true) ->
        Icons.Default.Edit

    name.contains("search", true) || name.contains("grep", true) || name.contains("glob", true) ->
        Icons.Default.Search

    name.contains("fetch", true) || name.contains("web", true) || name.contains("http", true) ->
        Icons.Default.Language

    name.contains("todo", true) || name.contains("plan", true) -> Icons.Default.Checklist

    name.contains("read", true) || name.contains("file", true) || name.contains("cat", true) ->
        Icons.Default.Description

    else -> Icons.Default.Build
}

private fun toolKind(name: String): ToolKind = when {
    name.contains("pwsh", true) || name.contains("bash", true) || name.contains("shell", true) ||
        name.contains("exec", true) || name.contains("terminal", true) -> ToolKind.Shell

    name.contains("write", true) || name.contains("edit", true) || name.contains("patch", true) ->
        ToolKind.Write

    name.contains("read", true) || name.contains("file", true) || name.contains("cat", true) ->
        ToolKind.Read

    name.contains("search", true) || name.contains("grep", true) || name.contains("glob", true) ->
        ToolKind.Read

    name.contains("fetch", true) || name.contains("web", true) || name.contains("http", true) ->
        ToolKind.Read

    name.contains("todo", true) || name.contains("plan", true) -> ToolKind.Plan

    else -> ToolKind.Other
}
