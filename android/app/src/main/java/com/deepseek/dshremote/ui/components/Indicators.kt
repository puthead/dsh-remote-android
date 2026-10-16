package com.deepseek.dshremote.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.deepseek.dshremote.data.api.VcsBadge
import com.deepseek.dshremote.data.relay.RelayState
import com.deepseek.dshremote.data.relay.describe
import com.deepseek.dshremote.ui.theme.DshBadgeAdded
import com.deepseek.dshremote.ui.theme.DshBadgeDeleted
import com.deepseek.dshremote.ui.theme.DshBadgeModified
import com.deepseek.dshremote.ui.theme.DshBadgeRenamed
import com.deepseek.dshremote.ui.theme.DshBadgeUntracked
import com.deepseek.dshremote.ui.theme.DshError
import com.deepseek.dshremote.ui.theme.DshLive
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSuccess
import com.deepseek.dshremote.ui.theme.DshWarning
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType

/**
 * 运行中呼吸点。
 *
 * 为什么要有动画：会话列表里"正在跑"和"跑完了"只差一个静态圆点的话，
 * 用户扫一眼分不出来；呼吸效果让它在余光里就能被注意到（对标 DeepSeek 客户端的思考态）。
 */
@Composable
fun LiveDot(
    active: Boolean,
    modifier: Modifier = Modifier,
    size: Dp = 8.dp,
) {
    if (!active) {
        Box(modifier.size(size).background(DshOutline, CircleShape))
        return
    }
    val transition = rememberInfiniteTransition(label = "live-dot")
    val alpha by transition.animateFloat(
        initialValue = 0.3f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(durationMillis = 900, easing = LinearEasing), RepeatMode.Reverse),
        label = "live-alpha",
    )
    Box(modifier.size(size).alpha(alpha).background(DshLive, CircleShape))
}

/**
 * 顶部中继连接状态条。
 *
 * 改成 [DshStatusBanner] 的薄封装：连接状态与页面里的其它横幅（等待审批、运行中等）
 * 本来就是同一个视觉原语（42dp 高 / 12dp 圆角 / 10dp 状态点），
 * 旧实现自己画一条 6dp 内边距的裸色条，会和横幅在同一个屏幕里对不上高、对不上圆角。
 *
 * 映射（画稿 §02 顶部那条「正在执行第 N 轮」用的是同一套 tone）：
 * 隧道 + PC 都在 → Ok；隧道在而 PC 离线 → Warn（契约 §0.5 的"电脑离线"）；
 * 握手/重连中 → Info；凭据失效/彻底失败 → Err；未连接 → Warn。
 */
@Composable
fun RelayStatusBar(
    state: RelayState,
    modifier: Modifier = Modifier,
) {
    // 未连接是"需要你处理"而不是"中性"：用琥珀而不是灰色，否则在纯黑底上几乎看不见
    val tone = when (state) {
        is RelayState.Connected -> if (state.homeOnline) DshTone.Ok else DshTone.Warn
        is RelayState.Connecting, is RelayState.Retrying -> DshTone.Info
        is RelayState.Unauthorized, is RelayState.Failed -> DshTone.Err
        RelayState.Idle -> DshTone.Warn
    }
    // 延迟没有独立的字段来源（RelayState 只有状态，没有 RTT），所以右侧留空而不是编一个数字出来
    DshStatusBanner(label = state.describe(), modifier = modifier, tone = tone)
}

/**
 * git 状态徽标（M/A/D/?…）。
 *
 * 用 [DshChip] 而不是自己画方块：画稿里这枚徽标与「轮数」「工作区名」等元信息芯片同高同圆角，
 * 单独实现迟早会跑偏成另一种尺寸。20dp 高 → `DshChip` 自动取 badge 档（10sp）。
 */
@Composable
fun GitBadgeChip(badge: VcsBadge, modifier: Modifier = Modifier) {
    val color = when (badge) {
        VcsBadge.MODIFIED, VcsBadge.TYPE_CHANGED -> DshBadgeModified
        VcsBadge.ADDED, VcsBadge.COPIED -> DshBadgeAdded
        VcsBadge.DELETED, VcsBadge.CONFLICT -> DshBadgeDeleted
        VcsBadge.RENAMED -> DshBadgeRenamed
        VcsBadge.UNTRACKED, VcsBadge.IGNORED, VcsBadge.OTHER -> DshBadgeUntracked
    }
    DshChip(
        text = badge.letter,
        modifier = modifier,
        containerColor = color.copy(alpha = 0.16f),
        contentColor = color,
        borderColor = color.copy(alpha = 0.30f),
        height = LocalDshDimens.current.chipHeightSmall,
        bold = true,
        mono = true,
    )
}

/** 增删行数角标：`+42 −7`（等宽 → 多行并排时 `+`/`−` 能对齐成一列）。 */
@Composable
fun CountsText(insertions: Int, deletions: Int, modifier: Modifier = Modifier) {
    val monoTiny = LocalDshType.current.monoMeta
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(LocalDshDimens.current.gapNode)) {
        if (insertions > 0) {
            Text("+$insertions", style = monoTiny, color = DshSuccess)
        }
        if (deletions > 0) {
            Text("−$deletions", style = monoTiny, color = DshError)
        }
    }
}

/**
 * 明文传输风险提示（契约 §5.6：`ws://` 必须提示）。
 *
 * 旧实现是一张红色大卡：明文联调是"需要注意"而不是"出错了"，用错误红会把整页染成故障态。
 * 改成画稿的警告条（琥珀 10% 底 + 30% 描边 + 左侧 1dp 竖条），与详情页的等待审批同色系。
 * 高度用 `heightIn(min = 36.dp)`）：文案有 3 行，固定 36dp 会直接截断。
 */
@Composable
fun CleartextWarningCard(modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 36.dp)
            .clip(RoundedCornerShape(DshRadius.Sub))
            .background(DshWarning.copy(alpha = 0.10f))
            .border(LocalDshDimens.current.border, DshWarning.copy(alpha = 0.30f), RoundedCornerShape(DshRadius.Sub)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 左侧竖条：警告条的身份标记（画稿里所有"需要你响应"的条都带这条）
        Box(
            Modifier
                .padding(start = 1.dp)
                .width(1.dp)
                .height(20.dp)
                .background(DshWarning),
        )
        Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            tint = DshWarning,
            modifier = Modifier.padding(start = 8.dp).size(16.dp),
        )
        Text(
            text = "当前中继地址是明文 ws://（或 http://）：\n" +
                "· 设备令牌与对话正文在链路上未加密，可被同网络设备嗅探；\n" +
                "· 仅建议在本机回环/可信内网做联调；\n" +
                "· 生产环境请在中继上启用 TLS，并把地址改成 wss://。",
            style = LocalDshType.current.label,
            color = DshOnBackground,
            modifier = Modifier.padding(start = 9.dp, end = 12.dp, top = 9.dp, bottom = 9.dp),
        )
    }
}

/**
 * 空状态占位：避免"白屏 + 不知道发生了什么"。
 *
 * 为什么不再画一整张 Card：空状态出现的地方（列表为空、加载中、无改动）本身就是"没有内容"，
 * 再给一张深灰卡等于用一块有分量的色块宣告"这里什么都没有"，反而更抢眼。
 * 改成一行居中的灰字（上下各 28dp 留白），保持节奏但不抢戏。
 */
@Composable
fun EmptyHint(
    text: String,
    modifier: Modifier = Modifier,
) {
    Text(
        text = text,
        style = LocalDshType.current.label,
        color = DshNeutral,
        textAlign = TextAlign.Center,
        modifier = modifier
            .fillMaxWidth()
            .padding(PaddingValues(horizontal = LocalDshDimens.current.pageMargin, vertical = 28.dp)),
    )
}

/** 小节标题（11sp 加粗次要色，与页头的 22sp 拉开三档，不靠字号靠颜色分层）。 */
@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = LocalDshType.current.meta.copy(fontWeight = FontWeight.Bold),
        color = DshOnSurfaceVariant,
        modifier = modifier.padding(start = LocalDshDimens.current.pageMargin),
        maxLines = 1,
    )
}

/**
 * 设置页的"键 : 值"行。
 *
 * 删掉旧的 96dp 固定标签列：`10.0.2.2:9443` 这类长键会被压成两行，
 * 而 `PC 名称` 后面又永远空着 60dp。改成两端对齐 + 44dp 最小行高（触摸/视觉节奏一致）。
 */
@Composable
fun KeyValueRow(
    key: String,
    value: String,
    modifier: Modifier = Modifier,
    valueColor: Color = DshOnSurfaceVariant,
) {
    val type = LocalDshType.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 44.dp)
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = key,
            style = type.label,
            color = DshOnSurfaceVariant,
        )
        Text(
            text = value,
            style = type.bodyLoose,
            color = valueColor,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1f),
        )
    }
}
