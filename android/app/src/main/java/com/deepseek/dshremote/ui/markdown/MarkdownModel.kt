package com.deepseek.dshremote.ui.markdown

/**
 * Markdown 渲染的中间模型。
 *
 * 设计约束：本文件（以及 [MarkdownParser]、[MarkdownInline]）不依赖任何 Android / Compose 类型，
 * 因此可以用普通 JVM 单元测试覆盖全部解析逻辑（本项目无 Robolectric，Compose 层难以测试）。
 */
sealed interface MdInline {
    /** 普通文本，渲染时逐字符保留。 */
    data class Text(val text: String) : MdInline

    /** 行内代码 `code`，渲染为等宽样式。 */
    data class Code(val text: String) : MdInline

    /** 斜体。 */
    data class Emph(val children: List<MdInline>) : MdInline

    /** 粗体。 */
    data class Strong(val children: List<MdInline>) : MdInline

    /** 删除线。 */
    data class Strike(val children: List<MdInline>) : MdInline

    /** 链接，[children] 为可见文字，[url] 为跳转目标。 */
    data class Link(val children: List<MdInline>, val url: String) : MdInline

    /** 图片。本地路径由 MarkdownImages 经网关加载，其他地址保留链接。 */
    data class Image(val alt: String, val url: String) : MdInline

    /** 段落内的单个换行（Markdown 里的 soft line break）。 */
    data object SoftBreak : MdInline
}

/** 表格列对齐方向。 */
enum class MdAlign { NONE, LEFT, CENTER, RIGHT }

/** Markdown 列表项；[blocks] 承载内容，从而支持项内的嵌套列表与代码块。 */
data class MdListItem(
    val blocks: List<MdBlock>,
    /** 任务列表的勾选状态；普通列表项为 null。 */
    val checked: Boolean? = null,
) {
    /** 该项的纯文本投影，便于测试与复制。 */
    fun plainText(): String = blocks.joinToString("\n") { it.plainText() }
}

sealed interface MdBlock {
    /** 标题，[level] 为 1..6。 */
    data class Heading(val level: Int, val inlines: List<MdInline>) : MdBlock

    /** 段落，[inlines] 里可能含 [MdInline.SoftBreak]。 */
    data class Paragraph(val inlines: List<MdInline>) : MdBlock

    /** 围栏代码块；[language] 为 info string（可能为空）。 */
    data class CodeBlock(val language: String, val code: String) : MdBlock

    /** 列表；[start] 为有序列表起始序号（无序列表固定 1）。 */
    data class MdList(val ordered: Boolean, val start: Int, val items: List<MdListItem>) : MdBlock

    /** 引用块，内部可嵌套任意块。 */
    data class Quote(val blocks: List<MdBlock>) : MdBlock

    /** 分隔线。 */
    data object Rule : MdBlock

    /** 表格；每行单元格数与 [header] 对齐（不足补空串）。 */
    data class Table(
        val header: List<List<MdInline>>,
        val aligns: List<MdAlign>,
        val rows: List<List<List<MdInline>>>,
    ) : MdBlock
}

/**
 * 把块序列投影为纯文本，用于测试断言与「无语法文本必须逐字符不变」的回归校验。
 *
 * 命名不叫 plainText 是因为 Kotlin 扩展在 JVM 上会类型擦除，`List<MdBlock>` 与 `List<MdInline>`
 * 的同名扩展会撞签名。
 */
fun List<MdBlock>.blocksPlainText(): String = joinToString("\n") { it.plainText() }

/** 单个块的纯文本投影。 */
fun MdBlock.plainText(): String = when (this) {
    is MdBlock.Heading -> inlines.plainText()
    is MdBlock.Paragraph -> inlines.plainText()
    is MdBlock.CodeBlock -> code
    is MdBlock.MdList -> items.joinToString("\n") { it.plainText() }
    is MdBlock.Quote -> blocks.blocksPlainText()
    MdBlock.Rule -> ""
    is MdBlock.Table -> (listOf(header) + rows).joinToString("\n") { row ->
        row.joinToString(" | ") { it.plainText() }
    }
}

/** 行内序列的纯文本投影（[MdInline.SoftBreak] 还原为换行）。 */
fun List<MdInline>.plainText(): String = buildString {
    this@plainText.forEach { node ->
        when (node) {
            is MdInline.Text -> append(node.text)
            is MdInline.Code -> append(node.text)
            is MdInline.Emph -> append(node.children.plainText())
            is MdInline.Strong -> append(node.children.plainText())
            is MdInline.Strike -> append(node.children.plainText())
            is MdInline.Link -> append(node.children.plainText())
            is MdInline.Image -> append(node.alt)
            MdInline.SoftBreak -> append('\n')
        }
    }
}
