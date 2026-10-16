package com.deepseek.dshremote.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.deepseek.dshremote.ui.theme.DshError
import com.deepseek.dshremote.ui.theme.DshHairline
import com.deepseek.dshremote.ui.theme.DshLive
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSecondary
import com.deepseek.dshremote.ui.theme.DshSurface
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshWarning
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType

/**
 * 方向 A 的"外壳原语"：底栏、页头、圆形图标按钮、状态横幅、卡片、芯片、分隔线。
 *
 * 这一层的唯一职责是把 `proto_kit.py` 里的绘制原语一对一搬成 Compose：
 * `navbar` / `appbar` / `iconbtn` / `banner` / `card` / `chip` / `hline`。
 * **页面只允许用这里的原语 + `DshDimens` / `DshType` / 语义色**，不再各处写死 12.dp / 16.sp，
 * 否则"一半画稿、一半 M3 默认"的割裂会重新长回来。
 *
 * 三条不能违反的规则（原型 README）：
 * 1. 强调色（陶土橙）只出现在**可操作**与**正在运行**的元素上；
 * 2. 状态色是语义色，不做装饰；
 * 3. 琥珀色（warning）= 等待你响应，优先级高于"运行中"。
 */

/** 底部导航的一个 Tab。 */
data class DshNavItem(
    val label: String,
    val icon: ImageVector,
)

/**
 * 底部导航（对应 `proto_kit.py:289` `navbar`）。
 *
 * 与 M3 `NavigationBar` 的差别是"密度"而不是"结构"：M3 默认 80dp 高 + 32dp 选中胶囊 +
 * 12sp 标签，画稿是 62dp 高 + 34dp 选中方块 + 11sp 标签。四列等宽。
 */
@Composable
fun DshNavBar(
    items: List<DshNavItem>,
    selectedIndex: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val dimens = LocalDshDimens.current
    Surface(color = DshSurface, modifier = modifier.fillMaxWidth()) {
        Column {
            Hairline()
            Row(
                modifier = Modifier.fillMaxWidth().height(dimens.navBarHeight),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                items.forEachIndexed { index, item ->
                    NavItem(
                        item = item,
                        selected = index == selectedIndex,
                        onClick = { onSelect(index) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun NavItem(
    item: DshNavItem,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val tint = if (selected) DshPrimary else MaterialTheme.colorScheme.onSurfaceVariant

    Column(
        modifier = modifier
            .clip(RoundedCornerShape(DshRadius.Small))
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            modifier = Modifier
                .size(dimens.navActiveBox)
                .clip(RoundedCornerShape(DshRadius.Small))
                .background(if (selected) DshPrimary.copy(alpha = 0.18f) else Color.Transparent),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = item.icon,
                contentDescription = item.label,
                tint = tint,
                modifier = Modifier.size(dimens.navIcon),
            )
        }
        Text(
            text = item.label,
            style = type.meta,
            color = tint,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            maxLines = 1,
        )
    }
}

/**
 * 页头（对应 `proto_kit.py:306` `appbar`）。
 *
 * 大标题 22sp + 一行副标题 12sp + 右侧 36dp 圆形图标按钮。**没有 M3 TopAppBar 的 64dp 高度**——
 * 画稿里页头是"贴在内容上的两行字"，不是一条带阴影的栏。
 */
@Composable
fun DshPageHeader(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    subtitleWarning: Boolean = false,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(
                start = dimens.pageMargin,
                end = dimens.pageMargin,
                top = 18.dp,
                bottom = 14.dp,
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = type.pageTitle,
                color = MaterialTheme.colorScheme.onBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                Spacer(Modifier.height(3.dp))
                Text(
                    text = subtitle,
                    style = type.label,
                    color = if (subtitleWarning) DshWarning else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
            content = actions,
        )
    }
}

/**
 * 圆形图标按钮（对应 `proto_kit.py:280` `iconbtn`）。
 *
 * 视觉 36dp，触摸目标补到 44dp——**触摸目标与视觉尺寸分离**，不为了凑 48dp 把按钮画大。
 */
@Composable
fun DshIconButton(
    icon: ImageVector,
    contentDescription: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    solid: Boolean = false,
    danger: Boolean = false,
) {
    val dimens = LocalDshDimens.current
    val tint = when {
        !enabled -> DshNeutral
        danger -> DshError
        solid -> Color.White
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val fill = if (solid) DshPrimary else DshSurface
    val stroke = when {
        solid -> Color.Transparent
        danger -> DshError
        else -> DshOutline
    }
    Box(
        modifier = modifier
            .size(dimens.iconButton + 8.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(dimens.iconButton)
                .clip(CircleShape)
                .background(fill)
                .border(dimens.border, stroke, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = contentDescription,
                tint = tint,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

/** 状态横幅的语义色调（对应 `proto_kit.py:324` `banner` 的 tone）。 */
enum class DshTone(val color: Color) {
    Ok(DshLive),
    Warn(DshWarning),
    Err(DshError),
    Info(DshSecondary),
}

/**
 * 状态横幅（对应 `proto_kit.py:324` `banner`）。
 *
 * 42dp 高、12dp 圆角、左状态点 + 12sp 文案 + 右侧数值芯片。
 * 只表达"当前连接/运行状态"；操作结果走 snackbar，不做成第二类横幅。
 */
@Composable
fun DshStatusBanner(
    label: String,
    modifier: Modifier = Modifier,
    tone: DshTone = DshTone.Ok,
    right: String? = null,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(42.dp)
            .clip(RoundedCornerShape(DshRadius.Sub))
            .background(tone.color.copy(alpha = 0.09f))
            .border(dimens.border, tone.color.copy(alpha = 0.28f), RoundedCornerShape(DshRadius.Sub))
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(tone.color),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = label,
            style = type.label,
            color = MaterialTheme.colorScheme.onBackground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (right != null) {
            Spacer(Modifier.width(8.dp))
            DshChip(
                text = right,
                height = dimens.chipHeight,
                borderColor = tone.color.copy(alpha = 0.30f),
                containerColor = tone.color.copy(alpha = 0.10f),
                contentColor = tone.color,
                bold = true,
            )
        }
    }
}

/**
 * 主卡片（对应 `proto_kit.py:198` `card`）。
 *
 * `#141414` 底 + `#2A2A2A` 1dp 描边 + 16dp 圆角。**不用 M3 `Card` 的 elevation / tonalElevation**——
 * 那会在真黑底上叠出一层脏灰（旧详情页正是这么把 `#141414` 叠成灰的）。
 */
@Composable
fun DshCard(
    modifier: Modifier = Modifier,
    containerColor: Color = DshSurface,
    borderColor: Color = DshOutline,
    radius: Dp = DshRadius.Card,
    content: @Composable () -> Unit,
) {
    val dimens = LocalDshDimens.current
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(radius))
            .background(containerColor)
            .border(dimens.border, borderColor, RoundedCornerShape(radius)),
    ) {
        content()
    }
}

/**
 * 芯片（对应 `proto_kit.py:207` `chip`）。
 *
 * 默认 24dp 高、全圆、11sp；传 `height = 20.dp` 得到画稿里的元信息芯片（10sp）。
 * 筛选、状态、工作区名、轮数等一切短标签都用它——不再用 M3 `FilterChip` / `AssistChip`
 * （默认 32dp 高、8dp 圆角，与画稿不符）。
 */
@Composable
fun DshChip(
    text: String,
    modifier: Modifier = Modifier,
    containerColor: Color = DshSurfaceVariant,
    contentColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    borderColor: Color? = DshOutline,
    height: Dp = LocalDshDimens.current.chipHeight,
    bold: Boolean = false,
    mono: Boolean = false,
    leadingDotColor: Color? = null,
    onClick: (() -> Unit)? = null,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val shape = RoundedCornerShape(height / 2)
    // 24dp 芯片用 11sp，20dp 元信息芯片用 10sp —— 与画稿的两档一致
    val style: TextStyle = if (height <= 20.dp) type.badge else type.meta
    val resolved = if (mono) style.copy(fontFamily = type.monoMeta.fontFamily) else style

    Row(
        modifier = modifier
            .height(height)
            .clip(shape)
            .background(containerColor)
            .then(if (borderColor != null) Modifier.border(dimens.border, borderColor, shape) else Modifier)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = dimens.chipPadX),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leadingDotColor != null) {
            Box(
                Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(leadingDotColor),
            )
            Spacer(Modifier.width(6.dp))
        }
        Text(
            text = text,
            style = resolved,
            color = contentColor,
            fontWeight = if (bold) FontWeight.Bold else resolved.fontWeight,
            maxLines = 1,
        )
    }
}

/**
 * 筛选芯片（对应 `proto_kit.py:228` `chip_solid` 与 `:207` `chip` 的选中/未选两态）。
 *
 * 选中态是**陶土橙实底白字**——唯一允许实心橙的小控件；未选是近黑底灰字。
 */
@Composable
fun DshFilterChip(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    DshChip(
        text = text,
        modifier = modifier,
        containerColor = if (selected) DshPrimary else DshSurfaceVariant,
        contentColor = if (selected) Color.White else MaterialTheme.colorScheme.onSurfaceVariant,
        borderColor = if (selected) null else DshOutline,
        bold = selected,
        onClick = onClick,
    )
}

/** 分组小标题（设置页 `gen_06_settings.py:14` 的 `section` 抬头）。 */
@Composable
fun DshSectionLabel(text: String, modifier: Modifier = Modifier) {
    val dimens = LocalDshDimens.current
    Text(
        text = text,
        style = LocalDshType.current.meta.copy(fontWeight = FontWeight.Bold),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(start = dimens.pageMargin + 4.dp, bottom = 7.dp),
        maxLines = 1,
    )
}

/** 1dp 分隔线（对应 `proto_kit.py:239` `hline`）。 */
@Composable
fun Hairline(
    modifier: Modifier = Modifier,
    color: Color = DshHairline,
    inset: Dp = 0.dp,
) {
    Box(
        modifier
            .fillMaxWidth()
            .padding(horizontal = inset)
            .height(LocalDshDimens.current.hairline)
            .background(color),
    )
}

/** 圆点状态指示（画稿里 chip / 列表行前的 4dp 状态点）。 */
@Composable
fun DshStatusDot(color: Color, modifier: Modifier = Modifier, size: Dp = 8.dp) {
    Box(
        modifier
            .size(size)
            .clip(CircleShape)
            .background(color),
    )
}

/** 让内容块落在页面边距内：左右各 20dp。 */
@Composable
fun DshPageContainer(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(modifier.padding(horizontal = LocalDshDimens.current.pageMargin)) { content() }
}

/** 保证可点区域 ≥44dp，同时不改变卡片内的视觉密度。 */
@Composable
fun DshClickableRow(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    minHeight: Dp = 44.dp,
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = minHeight)
            .clickable(role = Role.Button, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}
