package com.deepseek.dshremote.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.deepseek.dshremote.data.api.ChangeEntry
import com.deepseek.dshremote.data.api.DiffClassifier
import com.deepseek.dshremote.data.api.DiffLineKind
import com.deepseek.dshremote.data.api.SearchHit
import com.deepseek.dshremote.data.api.VcsBadge
import com.deepseek.dshremote.data.api.WorkspaceEntry
import com.deepseek.dshremote.ui.theme.DshBackground
import com.deepseek.dshremote.ui.theme.DshBadgeAdded
import com.deepseek.dshremote.ui.theme.DshBadgeDeleted
import com.deepseek.dshremote.ui.theme.DshBadgeModified
import com.deepseek.dshremote.ui.theme.DshBadgeRenamed
import com.deepseek.dshremote.ui.theme.DshBadgeUntracked
import com.deepseek.dshremote.ui.theme.DshCodeText
import com.deepseek.dshremote.ui.theme.DshDiffAddedBg
import com.deepseek.dshremote.ui.theme.DshDiffAddedText
import com.deepseek.dshremote.ui.theme.DshDiffHunkText
import com.deepseek.dshremote.ui.theme.DshDiffMetaText
import com.deepseek.dshremote.ui.theme.DshDiffRemovedBg
import com.deepseek.dshremote.ui.theme.DshDiffRemovedText
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSecondary
import com.deepseek.dshremote.ui.theme.DshSurface
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType

/**
 * 工作区相关的列表 / 代码 / 输入组件（方向 A：纯黑底、46dp 行、等宽路径、16dp 圆角卡）。
 *
 * 全部几何值来自画稿生成脚本而不是目测：`docs/01-设计/原型/gen_05_workspace.py`
 * （文件列表卡 46dp 行、40×22dp 徽标、diff 行高 int(11×1.6)=17.6dp、增删底色左右内缩 6dp）
 * 与 `gen_02_detail.py`（自绘详情顶栏：返回圆心 x=32dp、标题 x=52dp、46dp 高）。
 *
 * 另外三个原语 —— [DshDetailTopBar] / [DshInputField] / [DshButton] —— 语义上不属于"工作区"，
 * 但它们都是文件查看、diff、配对、设置四页共用的东西，而本轮可写文件只有六个、`ShellBits.kt`
 * 属于别的 owner：与其在四个页面里各抄一份必然跑偏的实现，不如集中在这里并写清签名。
 */

/** diff 行样式：11sp / 17.6sp 行高（= 11 × 1.6，画稿 `gen_05_workspace.py:89` 的 `int(11*S*1.6)`）。 */
private val DiffLineStyle = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontSize = 11.sp,
    lineHeight = 17.6.sp,
)

/** 12sp 等宽正文（画稿里路径、文件名、设置行数值统一等宽）。 */
@Composable
private fun monoLabel(): TextStyle =
    LocalDshType.current.label.copy(fontFamily = LocalDshType.current.monoBody.fontFamily)

/**
 * 自绘详情页顶栏（46dp 高）。
 *
 * 为什么不用 M3 `TopAppBar`：它是 64dp 高 + 4dp 状态栏内边距，画稿 `gen_02_detail.py:12-27`
 * 的顶栏是 46dp 且返回箭头圆心在 x=32dp、标题从 x=52dp 起 —— 用 `TopAppBar` 只能靠一堆
 * 负 padding 去凑，不如按画稿直接摆位。
 */
@Composable
fun DshDetailTopBar(
    title: String,
    subtitle: String?,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val type = LocalDshType.current
    Row(
        modifier = modifier.fillMaxWidth().height(46.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // offset(x=10dp)：把 44dp 触摸盒里的 36dp 圆形按钮圆心顶到画稿的 x=32dp，
        // 同时让触摸盒仍占 44dp（触摸目标不缩水）
        DshIconButton(
            icon = Icons.AutoMirrored.Filled.ArrowBack,
            contentDescription = "返回",
            onClick = onBack,
            modifier = Modifier.offset(x = 10.dp),
        )
        Column(Modifier.weight(1f).padding(start = 8.dp)) {
            Text(
                text = title,
                style = type.detailTitle,
                color = DshOnBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                Text(
                    text = subtitle,
                    style = type.tiny,
                    color = DshOnSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // end=16dp：动作按钮的 44dp 盒自带 4dp 视觉留白，补到画稿的 20dp 页边距
        Row(
            modifier = Modifier.padding(end = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            content = actions,
        )
    }
}

/**
 * 可切换的圆形图标按钮（文件查看页的"预览/行号"开关）。
 *
 * 为什么不用 [DshIconButton] 的 `solid`：实心橙在画稿里只表示"主操作"，
 * 拿它表示"开关处于打开"会让用户以为点了会发送什么。选中态改用底栏选中的同一套做法
 * （`DshPrimary` 18% 底 + 主色图标），一眼能看出"这个开关是开着的"。
 */
@Composable
fun DshToggleIconButton(
    icon: ImageVector,
    contentDescription: String?,
    active: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dimens = LocalDshDimens.current
    Box(
        modifier = modifier
            .size(dimens.iconButton + 8.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(dimens.iconButton)
                .clip(CircleShape)
                .background(if (active) DshPrimary.copy(alpha = 0.18f) else DshSurface)
                .border(
                    dimens.border,
                    if (active) DshPrimary.copy(alpha = 0.45f) else DshOutline,
                    CircleShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = contentDescription,
                tint = if (active) DshPrimary else DshOnSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

/**
 * 单行输入框（40dp 高、12dp 圆角、`DshSurfaceVariant` 底 + 1dp 描边）。
 *
 * 用 `BasicTextField` 而不是 M3 `OutlinedTextField`：后者最小高度 56dp、自带 16dp 浮动标签，
 * 在 320dp 宽、45dp 行距的设置/配对页里会把页面顶长一截。
 */
@Composable
fun DshInputField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    height: Dp = 40.dp,
    mono: Boolean = false,
    enabled: Boolean = true,
    style: TextStyle? = null,
    textAlign: TextAlign = TextAlign.Start,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: androidx.compose.ui.text.input.ImeAction = androidx.compose.ui.text.input.ImeAction.Done,
    onImeAction: () -> Unit = {},
) {
    val type = LocalDshType.current
    val resolved = style ?: if (mono) {
        type.body.copy(fontFamily = type.monoBody.fontFamily)
    } else {
        type.body
    }
    DshCard(
        modifier = modifier.fillMaxWidth().height(height),
        containerColor = DshSurfaceVariant,
        radius = DshRadius.Sub,
    ) {
        Box(
            modifier = Modifier.fillMaxWidth().height(height).padding(horizontal = 12.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (value.isEmpty()) {
                Text(
                    text = placeholder,
                    style = resolved,
                    color = DshNeutral,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                enabled = enabled,
                singleLine = true,
                textStyle = resolved.copy(
                    color = if (enabled) DshOnBackground else DshNeutral,
                    textAlign = textAlign,
                ),
                cursorBrush = SolidColor(DshPrimary),
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
                keyboardActions = KeyboardActions(onDone = { onImeAction() }, onSearch = { onImeAction() }),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * 胶囊按钮（34dp 高、17dp 圆角）。
 *
 * 形状与画稿的 `chip_solid` 同源，只是高度按主按钮的 34dp —— 页里的"配对并连接"、
 * 编辑器里的"保存并重连"都用它，避免每页各写一套按钮尺寸。
 */
@Composable
fun DshButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    solid: Boolean = false,
    height: Dp = 34.dp,
) {
    val type = LocalDshType.current
    val shape = RoundedCornerShape(height / 2)
    val fill = when {
        solid && enabled -> DshPrimary
        solid -> DshPrimary.copy(alpha = 0.35f)
        else -> DshSurface
    }
    Row(
        modifier = modifier
            .height(height)
            .clip(shape)
            .background(fill)
            .border(
                LocalDshDimens.current.border,
                if (solid) Color.Transparent else DshOutline,
                shape,
            )
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(
            text = text,
            style = type.bodyLoose.copy(fontWeight = FontWeight.SemiBold),
            color = when {
                solid && enabled -> Color.White
                enabled -> DshOnBackground
                else -> DshNeutral
            },
            maxLines = 1,
        )
    }
}

/** git 类型徽标（40×22dp、6dp 圆角、12sp 加粗字母）—— 画稿 `gen_05_workspace.py:59-61`。 */
@Composable
fun VcsBadgeBox(badge: VcsBadge, modifier: Modifier = Modifier) {
    val color = when (badge) {
        VcsBadge.MODIFIED, VcsBadge.TYPE_CHANGED -> DshBadgeModified
        VcsBadge.ADDED, VcsBadge.COPIED -> DshBadgeAdded
        VcsBadge.DELETED, VcsBadge.CONFLICT -> DshBadgeDeleted
        VcsBadge.RENAMED -> DshBadgeRenamed
        VcsBadge.UNTRACKED, VcsBadge.IGNORED, VcsBadge.OTHER -> DshBadgeUntracked
    }
    val shape = RoundedCornerShape(DshRadius.Badge)
    Box(
        modifier = modifier
            .size(width = 40.dp, height = 22.dp)
            .clip(shape)
            // 画稿用的是 _shade(color, .18, SURFACE)：即"色 @18% 压在卡面 #141414 上"，
            // Compose 里同一件事就是半透明色画在 DshSurface 卡上
            .background(color.copy(alpha = 0.18f))
            .border(LocalDshDimens.current.border, color.copy(alpha = 0.50f), shape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = badge.letter,
            style = LocalDshType.current.label.copy(fontWeight = FontWeight.Bold),
            color = color,
            maxLines = 1,
        )
    }
}

/**
 * 列表卡的一段。
 *
 * 画稿里"一张卡包住 N 行 + 行间缩进细线"是个整体，但工作区列表可能有上千行（目录条目上限 2000），
 * 必须走 `LazyColumn`。于是把卡拆成段：首段画上边 + 上圆角，末段画下边 + 下圆角，
 * 每段都画左右竖边，拼起来就是一张连续的卡，同时列表仍然是惰性的。
 *
 * 为什么不用 `Modifier.border`：它画的是**闭合**轮廓，中间段会在每行上下各留一条全宽描边，
 * 与画稿"行间是缩进 16dp 的 `#222222` 细线"冲突。
 */
@Composable
fun ListCardSegment(
    isFirst: Boolean,
    isLast: Boolean,
    modifier: Modifier = Modifier,
    hairlineInset: Dp = 16.dp,
    content: @Composable () -> Unit,
) {
    val radius = DshRadius.Card
    val shape = RoundedCornerShape(
        topStart = if (isFirst) radius else 0.dp,
        topEnd = if (isFirst) radius else 0.dp,
        bottomStart = if (isLast) radius else 0.dp,
        bottomEnd = if (isLast) radius else 0.dp,
    )
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(DshSurface)
            .drawBehind {
                // 画稿的卡是 1dp 实描边；描边中心内缩半线宽，否则外半边会被 clip 吃掉、看起来比别处的卡细一半
                val stroke = 1.dp.toPx()
                val r = radius.toPx()
                val o = stroke / 2f
                val top = if (isFirst) r else 0f
                val bottom = if (isLast) r else 0f
                drawLine(DshOutline, Offset(o, top), Offset(o, size.height - bottom), stroke)
                drawLine(DshOutline, Offset(size.width - o, top), Offset(size.width - o, size.height - bottom), stroke)
                if (isFirst) {
                    drawLine(DshOutline, Offset(r, o), Offset(size.width - r, o), stroke)
                    drawArc(
                        DshOutline, 180f, 90f, false,
                        topLeft = Offset(o, o), size = Size(2 * r - 2 * o, 2 * r - 2 * o), style = Stroke(stroke),
                    )
                    drawArc(
                        DshOutline, 270f, 90f, false,
                        topLeft = Offset(size.width - 2 * r + o, o),
                        size = Size(2 * r - 2 * o, 2 * r - 2 * o), style = Stroke(stroke),
                    )
                }
                if (isLast) {
                    drawLine(DshOutline, Offset(r, size.height - o), Offset(size.width - r, size.height - o), stroke)
                    drawArc(
                        DshOutline, 90f, 90f, false,
                        topLeft = Offset(o, size.height - 2 * r + o),
                        size = Size(2 * r - 2 * o, 2 * r - 2 * o), style = Stroke(stroke),
                    )
                    drawArc(
                        DshOutline, 0f, 90f, false,
                        topLeft = Offset(size.width - 2 * r + o, size.height - 2 * r + o),
                        size = Size(2 * r - 2 * o, 2 * r - 2 * o), style = Stroke(stroke),
                    )
                }
            },
    ) {
        if (!isFirst) Hairline(inset = hairlineInset)
        content()
    }
}

/** 目录面包屑：38dp 高、`DshSurfaceVariant` 底、12sp；点任意一级回跳。 */
@Composable
fun BreadcrumbBar(
    workspaceLabel: String,
    crumbs: List<Pair<String, String>>,
    onNavigate: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val type = LocalDshType.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(38.dp)
            .background(DshSurfaceVariant)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Crumb(text = workspaceLabel, color = DshOnSurfaceVariant, onClick = { onNavigate("") })
        crumbs.forEach { (name, path) ->
            Text(
                text = "/",
                style = type.label,
                color = DshNeutral,
                maxLines = 1,
            )
            Crumb(text = name, color = DshOnBackground, onClick = { onNavigate(path) })
        }
    }
}

@Composable
private fun Crumb(text: String, color: Color, onClick: () -> Unit) {
    val type = LocalDshType.current
    Text(
        text = text,
        style = type.label,
        color = color,
        maxLines = 1,
        // 8dp 横向内边距 + 2dp 间距：点击目标够大，又不会把一整行面包屑撑到换行
        modifier = Modifier
            .clip(RoundedCornerShape(DshRadius.Badge))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp),
    )
}

/** 目录树的一行：46dp、名称 12sp 等宽、元信息 11sp。 */
@Composable
fun EntryRow(
    entry: WorkspaceEntry,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val type = LocalDshType.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(LocalDshDimens.current.rowFile)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = 16.dp, end = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = when {
                entry.isDir -> Icons.Default.Folder
                entry.isSymlink -> Icons.Default.Link
                else -> Icons.AutoMirrored.Filled.InsertDriveFile
            },
            contentDescription = null,
            // 目录可进入 = 可操作 → 用第二强调色；普通文件保持中性灰（强调色保持稀缺）
            tint = if (entry.isDir) DshSecondary else DshNeutral,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = entry.name,
                style = monoLabel(),
                color = DshOnBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = buildString {
                    append(if (entry.isDir) "目录" else Fmt.size(entry.size ?: 0L))
                    entry.modifiedAt?.let { append(" · ${Fmt.relative(it)}") }
                },
                style = type.meta,
                color = DshOnSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(8.dp))
        Icon(
            imageVector = Icons.Default.ChevronRight,
            contentDescription = null,
            tint = DshOnSurfaceVariant,
            modifier = Modifier.size(12.dp),
        )
    }
}

/**
 * 改动列表的一行：类型徽标 + 路径 + 说明行 + chevron。
 *
 * 说明行放的是**真实有的信息**（增删行数、暂存态、二进制），画稿上的"buildscript 依赖升级"
 * 那类人工描述服务端并不提供 —— 缺字段就不硬造（同一行的布局与画稿一致）。
 */
@Composable
fun ChangeRow(
    change: ChangeEntry,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val type = LocalDshType.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(LocalDshDimens.current.rowFile)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = 16.dp, end = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        VcsBadgeBox(change.badge)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = change.path,
                style = monoLabel(),
                color = DshOnBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = buildString {
                    append(if (change.isBinary) "二进制文件" else "+${change.insertions} −${change.deletions}")
                    if (change.staged) append(" · 已暂存")
                },
                style = type.meta,
                color = DshOnSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(8.dp))
        Icon(
            imageVector = Icons.Default.ChevronRight,
            contentDescription = null,
            tint = DshOnSurfaceVariant,
            modifier = Modifier.size(12.dp),
        )
    }
}

/** 未跟踪文件行（徽标固定 `?`）。 */
@Composable
fun UntrackedRow(path: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(LocalDshDimens.current.rowFile)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = 16.dp, end = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        VcsBadgeBox(VcsBadge.UNTRACKED)
        Spacer(Modifier.width(12.dp))
        Text(
            text = path,
            style = monoLabel(),
            color = DshOnBackground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(8.dp))
        Icon(
            imageVector = Icons.Default.ChevronRight,
            contentDescription = null,
            tint = DshOnSurfaceVariant,
            modifier = Modifier.size(12.dp),
        )
    }
}

/** 搜索命中行：路径（12sp 等宽）+ 命中文本片段（11sp 等宽）。行高下限 46dp，片段长就多占一行。 */
@Composable
fun SearchHitRow(hit: SearchHit, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val type = LocalDshType.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = LocalDshDimens.current.rowFile)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = 16.dp, end = 14.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Default.Search,
            contentDescription = null,
            tint = DshNeutral,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = hit.path + (hit.line?.let { ":$it" } ?: ""),
                style = monoLabel(),
                color = DshOnBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (hit.text.isNotEmpty()) {
                Text(
                    text = hit.text.trim().take(160),
                    style = type.monoMeta,
                    color = DshOnSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/**
 * diff 的一行（预览卡与整页 diff 共用同一套底/字色）。
 *
 * 三条画稿规则（`gen_05_workspace.py:87-98`）：
 * 增量行整行底 `DshDiffAddedBg`、删除行 `DshDiffRemovedBg`，底色左右各内缩 6dp；
 * hunk 头（`@@ … @@`）**没有底色**、字色是橙族第二色；行内文字距卡左缘 14dp。
 * 行高 17.6dp 由 [DiffLineStyle] 决定；长行会折行、行号仍停在该行第一段。
 */
@Composable
fun DiffLineText(line: String, lineNumber: Int? = null, modifier: Modifier = Modifier) {
    val kind = DiffClassifier.classify(line)
    val background = when (kind) {
        DiffLineKind.ADDED -> DshDiffAddedBg
        DiffLineKind.REMOVED -> DshDiffRemovedBg
        else -> Color.Transparent
    }
    val color = when (kind) {
        DiffLineKind.ADDED -> DshDiffAddedText
        DiffLineKind.REMOVED -> DshDiffRemovedText
        DiffLineKind.HUNK -> DshDiffHunkText
        DiffLineKind.META -> DshDiffMetaText
        DiffLineKind.CONTEXT -> DshCodeText
    }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 6.dp)
            .background(background),
    ) {
        if (lineNumber != null) {
            Text(
                text = "$lineNumber",
                style = DiffLineStyle,
                color = DshNeutral,
                textAlign = TextAlign.End,
                maxLines = 1,
                modifier = Modifier.width(36.dp).padding(end = 8.dp),
            )
        }
        Text(
            text = line.ifEmpty { " " },
            style = DiffLineStyle,
            color = color,
            modifier = Modifier.padding(start = 8.dp, end = 6.dp),
        )
    }
}

/**
 * unified diff 视图。
 *
 * 用 `LazyColumn` 逐行渲染：diff 动辄几千行，塞进一个巨型 `Text` 会让滚动卡死（v1 的教训）。
 */
@Composable
fun DiffView(
    lines: List<String>,
    modifier: Modifier = Modifier,
    showLineNumbers: Boolean = true,
) {
    LazyColumn(
        modifier = modifier.fillMaxWidth().background(DshBackground),
        contentPadding = PaddingValues(vertical = 6.dp),
    ) {
        items(lines.size) { index ->
            DiffLineText(line = lines[index], lineNumber = if (showLineNumbers) index + 1 else null)
        }
    }
}

/** 文件内容视图（等宽 + 可选行号）。 */
@Composable
fun CodeView(
    text: String,
    modifier: Modifier = Modifier,
    showLineNumbers: Boolean = true,
) {
    val lines = remember(text) { if (text.isEmpty()) listOf("") else text.split('\n') }
    LazyColumn(
        modifier = modifier.fillMaxWidth().background(DshBackground),
        contentPadding = PaddingValues(vertical = 6.dp),
    ) {
        items(lines.size) { index ->
            Row(Modifier.fillMaxWidth()) {
                if (showLineNumbers) {
                    Text(
                        text = "${index + 1}",
                        style = DiffLineStyle,
                        color = DshNeutral,
                        textAlign = TextAlign.End,
                        maxLines = 1,
                        modifier = Modifier.width(36.dp).padding(end = 8.dp),
                    )
                }
                Text(
                    text = lines[index].ifEmpty { " " },
                    style = DiffLineStyle,
                    color = DshCodeText,
                    modifier = Modifier.padding(start = 8.dp, end = 6.dp),
                )
            }
        }
    }
}

/** 返回上级按钮（工作区文件页顶部）：直接复用 36dp 圆形图标按钮。 */
@Composable
fun UpButton(enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    DshIconButton(
        icon = Icons.Default.ArrowUpward,
        contentDescription = "返回上级",
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
    )
}
