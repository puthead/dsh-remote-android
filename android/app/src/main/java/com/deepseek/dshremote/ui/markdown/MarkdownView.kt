package com.deepseek.dshremote.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.deepseek.dshremote.ui.components.Hairline
import com.deepseek.dshremote.ui.components.MessageImageStrip
import com.deepseek.dshremote.ui.theme.DshCodeText
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSurfaceHigh
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshSuccess
import com.deepseek.dshremote.ui.theme.LocalDshType

/**
 * 超过这个长度直接按纯文本渲染：几十万字的单条消息本来就该用等宽文本快速显示，
 * Markdown 解析与富文本排版的开销不值得压在主线程上（开发规范 K4）。
 */
private const val MAX_MARKDOWN_CHARS = 120_000

/**
 * 超长文本降级为纯文本时的单块字符数。
 *
 * 取值只影响排版粒度：8 000 字符在手机上大约 100 行，单块 measure 成本可控，
 * 又不至于把 LazyColumn 的 item 数撑到几万。
 */
private const val PLAIN_CHUNK_CHARS = 8_000

/** 流式输出时的光标（前置空格与接入前的纯文本渲染保持一致）。 */
private const val CARET = " ▍"

/** 代码块默认折叠的行数阈值（compact 用于用户气泡等窄容器）。 */
private const val COLLAPSE_LINES = 20
private const val COLLAPSE_LINES_COMPACT = 12

/**
 * 渲染一段 Markdown。
 *
 * 特性与取舍：
 * - 解析结果按 [text] 记忆化，流式追加时只重新解析当前文本；
 * - 单换行渲染为换行（与接入前的纯文本行为一致），不会被吞掉；
 * - 代码块支持折叠与复制（复制走系统剪贴板），长行横向滚动，不嵌套纵向滚动；
 * - 链接交给系统浏览器（[LinkAnnotation.Url]），App 自身不做内嵌浏览；
 * - 表格/列表只用 Row/Column 排版，不内嵌 LazyColumn，避免滚动冲突。
 *
 * 字号/行高/圆角全部来自 `LocalDshType` 与 `DshRadius`：
 * 旧实现用 `MaterialTheme.typography` + 一堆 `12.dp`/`10.dp`，
 * 结果同一屏里 Markdown 正文 14sp、对话正文 13sp、代码块 11.5sp 三套基线打架。
 *
 * @param text Markdown 源文本。
 * @param streaming 为 true 时在末尾显示流式光标 [CARET]。
 * @param compact 紧凑排版（用于用户气泡等窄容器）：段距与列表间距收一档。
 */
@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    textStyle: TextStyle = LocalDshType.current.bodyLoose,
    color: Color = DshOnBackground,
    streaming: Boolean = false,
    compact: Boolean = false,
) {
    if (text.isEmpty()) return
    if (text.length > MAX_MARKDOWN_CHARS) {
        // 超长文本降级：不解析，避免主线程卡顿
        Text(text = if (streaming) text + CARET else text, modifier = modifier, style = textStyle, color = color)
        return
    }
    val blocks = remember(text) { MarkdownParser.parse(text) }
    if (blocks.isEmpty()) {
        if (streaming) Text(text = CARET, modifier = modifier, style = textStyle, color = color)
        return
    }
    val styles = mdStyles(textStyle, color, compact)
    val gap = blockGap(compact)
    val last = blocks.lastIndex
    val caretInside = streaming && (blocks[last] is MdBlock.Paragraph || blocks[last] is MdBlock.Heading)
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(gap)) {
        blocks.forEachIndexed { index, block ->
            MarkdownBlockView(
                block = block,
                styles = styles,
                caret = if (caretInside && index == last) CARET else "",
            )
        }
        if (streaming && !caretInside) {
            Text(text = CARET, style = textStyle, color = color)
        }
    }
}

/**
 * 逐块懒加载渲染 Markdown（LazyColumn），供文件预览这类整篇文档场景使用。
 *
 * 与 [MarkdownText] 的区别：这里不把所有块塞进一个 Column，而是交给 LazyColumn 按需排版，
 * 避免大文件一次性排版（`CodeView` 逐行渲染是同样的理由）。
 */
@Composable
fun MarkdownBlockList(
    text: String,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    textStyle: TextStyle = LocalDshType.current.bodyLoose,
    color: Color = DshOnBackground,
    compact: Boolean = false,
) {
    if (text.length > MAX_MARKDOWN_CHARS) {
        // 超长文件不解析、不排版：直接给等宽纯文本，页面不会假死。
        // 但必须**切块**再交给 LazyColumn：整篇塞进一个 item 时，只要它滚进可视区，
        // 一次 measure 里就要把十万级字符全部 shaping 完（服务端单条消息上限就有 256 KiB），
        // 主线程会卡到 ANR。切成小块后 LazyColumn 只测量可视的那几块。
        val chunks = remember(text) { text.chunked(PLAIN_CHUNK_CHARS) }
        LazyColumn(modifier = modifier, contentPadding = contentPadding) {
            items(chunks) { chunk ->
                Text(text = chunk, style = LocalDshType.current.monoBody, color = DshCodeText)
            }
        }
        return
    }
    val blocks = remember(text) { MarkdownParser.parse(text) }
    val styles = mdStyles(textStyle, color, compact)
    LazyColumn(
        modifier = modifier,
        contentPadding = contentPadding,
        verticalArrangement = Arrangement.spacedBy(blockGap(compact)),
    ) {
        itemsIndexed(blocks, key = { index, _ -> index }) { _, block ->
            MarkdownBlockView(block = block, styles = styles, caret = "")
        }
    }
}

/** 块间距：画稿段落之间 8dp，用户气泡（compact）里收一档到 6dp。 */
private fun blockGap(compact: Boolean) = if (compact) 6.dp else 8.dp

/** 一整块渲染所需的样式，抽出来避免每个子组件都重复计算主题色。 */
private data class MdStyles(
    val text: TextStyle,
    val color: Color,
    val codeSpan: SpanStyle,
    val link: TextLinkStyles,
    val quoteBar: Color,
    val border: Color,
    val subtle: Color,
    val codeBackground: Color,
    val compact: Boolean,
)

@Composable
private fun mdStyles(textStyle: TextStyle, color: Color, compact: Boolean): MdStyles {
    val type = LocalDshType.current
    return MdStyles(
        text = textStyle,
        color = color,
        // 行内代码与围栏代码块同一套等宽字号：同一段文本里两者出现时要看起来是一回事
        codeSpan = SpanStyle(
            fontFamily = type.monoBody.fontFamily,
            fontSize = type.monoBody.fontSize,
            background = DshSurfaceVariant,
            color = DshCodeText,
        ),
        link = TextLinkStyles(
            style = SpanStyle(color = DshPrimary, textDecoration = TextDecoration.Underline),
        ),
        quoteBar = DshPrimary.copy(alpha = 0.45f),
        border = DshOutline,
        subtle = DshOnSurfaceVariant,
        codeBackground = DshSurfaceVariant,
        compact = compact,
    )
}

@Composable
private fun MarkdownBlockView(block: MdBlock, styles: MdStyles, caret: String) {
    when (block) {
        is MdBlock.Heading -> InlineContent(block.inlines, caret, styles, headingStyle(block.level))

        is MdBlock.Paragraph -> InlineContent(block.inlines, caret, styles)

        is MdBlock.CodeBlock -> CodeBlockView(block, styles)

        is MdBlock.MdList -> ListBlockView(block, styles)

        is MdBlock.Quote -> QuoteView(block, styles)

        // 分隔线用 1dp 实色 Hairline，而不是 M3 HorizontalDivider 的默认厚度/颜色
        MdBlock.Rule -> Hairline(modifier = Modifier.padding(vertical = 2.dp))

        is MdBlock.Table -> TableView(block, styles)
    }
}

@Composable
private fun InlineContent(
    nodes: List<MdInline>, caret: String, styles: MdStyles,
    textStyle: TextStyle = styles.text, modifier: Modifier = Modifier,
    textAlign: TextAlign = TextAlign.Start,
) {
    val context = LocalMarkdownImages.current
    val segments = remember(nodes) { imageSegments(nodes) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        segments.forEachIndexed { index, part ->
            val picture = part.singleOrNull() as? MdInline.Image
            val ref = picture?.let { context?.resolve(it) }
            if (ref != null && context != null) {
                MessageImageStrip(listOf(ref), context.loader, { context.onOpen(listOf(ref), 0) }, Modifier.fillMaxWidth())
            } else {
                Text(
                    text = inlineText(part, if (index == segments.lastIndex) caret else "", styles),
                    style = textStyle, color = styles.color, textAlign = textAlign,
                )
            }
        }
    }
}

/**
 * 标题档位：直接落到 [LocalDshType] 已有的四档，不再乘 1.5 / 1.3 / 1.15。
 *
 * 为什么删掉倍率：倍率会把 13sp 正文放大成 19.5sp，比页头的 22sp 只差一档半，
 * 于是文档里的 `##` 和整个页面的标题抢焦点。画稿的档位是 22 / 17 / 15 / 14 四档，
 * 与正文（12.5）之间留出明确落差 —— 认档位而不是算倍数。
 */
@Composable
private fun headingStyle(level: Int): TextStyle {
    val type = LocalDshType.current
    return when (level) {
        1 -> type.pageTitle
        2 -> type.screenTitle
        3 -> type.detailTitle
        else -> type.cardTitle
    }
}

@Composable
private fun CodeBlockView(block: MdBlock.CodeBlock, styles: MdStyles) {
    val clipboard = LocalClipboardManager.current
    val type = LocalDshType.current
    var expanded by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    val lines = remember(block.code) { block.code.split('\n') }
    val limit = if (styles.compact) COLLAPSE_LINES_COMPACT else COLLAPSE_LINES
    val scroll = rememberScrollState()
    val shape = RoundedCornerShape(DshRadius.Sub)
    val visible = if (expanded || lines.size <= limit) block.code else lines.take(limit).joinToString("\n")
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(styles.codeBackground)
            .border(1.dp, styles.border, shape)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                text = block.language.ifEmpty { "代码" },
                style = type.meta,
                color = styles.subtle,
                modifier = Modifier.weight(1f),
            )
            if (lines.size > limit) {
                Text(
                    text = if (expanded) "收起" else "展开 ${lines.size} 行",
                    style = type.meta,
                    color = styles.subtle,
                    modifier = Modifier.clickable { expanded = !expanded },
                )
            }
            Text(
                text = if (copied) "已复制" else "复制",
                style = type.meta,
                color = DshPrimary,
                modifier = Modifier.clickable {
                    clipboard.setText(AnnotatedString(block.code))
                    copied = true
                },
            )
        }
        Box(Modifier.fillMaxWidth().horizontalScroll(scroll)) {
            Text(text = visible, style = type.monoBody, color = DshCodeText)
        }
    }
}

@Composable
private fun ListBlockView(block: MdBlock.MdList, styles: MdStyles) {
    val type = LocalDshType.current
    val itemGap = if (styles.compact) 3.dp else 4.dp
    Column(verticalArrangement = Arrangement.spacedBy(itemGap)) {
        block.items.forEachIndexed { index, item ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Box(modifier = Modifier.widthIn(min = 20.dp)) {
                    when (item.checked) {
                        null -> Text(
                            text = if (block.ordered) "${block.start + index}." else "•",
                            style = styles.text,
                            color = styles.subtle,
                        )

                        // 任务项：与对话流的待办圈同构（勾=绿实心圆、未勾=灰描边圆），
                        // 12dp 而不是 M3 Icon 默认的 24dp —— 与 12.5sp 正文对齐才不显得笨重
                        else -> TaskMarker(checked = item.checked)
                    }
                }
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(itemGap),
                ) {
                    item.blocks.forEach { MarkdownBlockView(it, styles, "") }
                }
            }
        }
    }
}

/** Markdown 任务项的勾选圈（12dp，与 TodoListCard 的圈同一尺寸）。 */
@Composable
private fun TaskMarker(checked: Boolean) {
    Box(modifier = Modifier.size(12.dp).padding(top = 3.dp), contentAlignment = Alignment.Center) {
        if (checked) {
            Box(Modifier.size(12.dp).clip(CircleShape).background(DshSuccess), contentAlignment = Alignment.Center) {
                Icon(
                    imageVector = Icons.Default.Check,
                    contentDescription = "已完成",
                    tint = Color.White,
                    modifier = Modifier.size(9.dp),
                )
            }
        } else {
            Box(Modifier.size(12.dp).clip(CircleShape).border(1.dp, DshOutline, CircleShape))
        }
    }
}

@Composable
private fun QuoteView(block: MdBlock.Quote, styles: MdStyles) {
    Row(
        modifier = Modifier.height(IntrinsicSize.Min),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .width(3.dp)
                .fillMaxHeight()
                .clip(RoundedCornerShape(2.dp))
                .background(styles.quoteBar),
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(blockGap(styles.compact)),
        ) {
            block.blocks.forEach { MarkdownBlockView(it, styles, "") }
        }
    }
}

@Composable
private fun TableView(block: MdBlock.Table, styles: MdStyles) {
    // 表格单元格比正文收一档：表格要在一屏内放下更多列，字号跟着正文会挤成两行
    val cellStyle = LocalDshType.current.label
    Column(modifier = Modifier.fillMaxWidth()) {
        TableRowView(block.header, block.aligns, cellStyle, styles, headerBackground = true)
        block.rows.forEach { row ->
            Hairline()
            TableRowView(row, block.aligns, cellStyle, styles, headerBackground = false)
        }
    }
}

@Composable
private fun TableRowView(
    cells: List<List<MdInline>>,
    aligns: List<MdAlign>,
    cellStyle: TextStyle,
    styles: MdStyles,
    headerBackground: Boolean,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (headerBackground) DshSurfaceHigh else Color.Transparent),
    ) {
        cells.forEachIndexed { index, cell ->
            InlineContent(
                nodes = cell, caret = "", styles = styles,
                textStyle = if (headerBackground) cellStyle.copy(fontWeight = FontWeight.SemiBold) else cellStyle,
                textAlign = textAlignOf(aligns.getOrElse(index) { MdAlign.NONE }),
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            )
        }
    }
}

private fun textAlignOf(align: MdAlign): TextAlign = when (align) {
    MdAlign.LEFT -> TextAlign.Start
    MdAlign.CENTER -> TextAlign.Center
    MdAlign.RIGHT -> TextAlign.End
    MdAlign.NONE -> TextAlign.Start
}

private fun inlineText(inlines: List<MdInline>, caret: String, styles: MdStyles): AnnotatedString =
    buildAnnotatedString {
        appendInlines(inlines, styles)
        if (caret.isNotEmpty()) append(caret)
    }

private fun AnnotatedString.Builder.appendInlines(inlines: List<MdInline>, styles: MdStyles) {
    for (node in inlines) {
        when (node) {
            is MdInline.Text -> append(node.text)

            MdInline.SoftBreak -> append('\n')

            is MdInline.Code -> withStyle(styles.codeSpan) { append(node.text) }

            is MdInline.Emph -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
                appendInlines(node.children, styles)
            }

            is MdInline.Strong -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) {
                appendInlines(node.children, styles)
            }

            is MdInline.Strike -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) {
                appendInlines(node.children, styles)
            }

            is MdInline.Link -> withLink(LinkAnnotation.Url(node.url, styles.link)) {
                appendInlines(node.children, styles)
            }

            // 图片不做网络加载（App 只连中继/网关），以可点击的地址形式展示
            is MdInline.Image -> {
                append("[图片] ")
                if (node.alt.isNotEmpty()) {
                    append(node.alt)
                    append(" ")
                }
                withLink(LinkAnnotation.Url(node.url, styles.link)) { append(node.url) }
            }
        }
    }
}
