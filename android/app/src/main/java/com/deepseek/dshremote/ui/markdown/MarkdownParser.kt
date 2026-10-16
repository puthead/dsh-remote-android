package com.deepseek.dshremote.ui.markdown

/**
 * 块级 Markdown 解析器（纯 Kotlin，无 Android 依赖，可被 JVM 单测完整覆盖）。
 *
 * 支持：ATX/Setext 标题、段落、围栏代码块（``` 与 ~~~）、无序/有序列表（含嵌套与任务项）、
 * 引用块、分隔线、GFM 表格（含列对齐）。刻意不支持：HTML 块、缩进代码块、脚注、定义列表、
 * 数学公式——DSH 会话里几乎不出现，而实现它们会显著放大解析器的复杂度与回归面。
 *
 * 未闭合的围栏代码块会一直解析到文末：流式输出过程中模型先发 ``` 再发内容是常态，
 * 这样能在半截文本下也保持稳定（见 [MarkdownView] 的流式光标）。
 */
object MarkdownParser {
    /** 引用/列表的递归嵌套上限，防御病态输入导致的深递归。 */
    private const val MAX_NESTING = 6
    private val TASK_ITEM = Regex("""^\s*\[([ xX])]\s+(.*)$""")
    private val CLOSING_HASHES = Regex("\\s+#+$")
    private val DELIM_CELL = Regex("^:?-+:?$")

    /**
     * 解析整段 Markdown。
     *
     * @param markdown 原始文本，允许 CRLF。
     * @return 块序列；空输入返回空列表。
     */
    fun parse(markdown: String): List<MdBlock> {
        if (markdown.isBlank()) return emptyList()
        return parseBlocks(splitLines(markdown), 0)
    }

    /** 把 Markdown 投影为纯文本（去掉语法标记），用于测试与「复制全文」。 */
    fun toPlainText(markdown: String): String = parse(markdown).blocksPlainText()

    private fun splitLines(markdown: String): List<String> =
        markdown.replace("\r\n", "\n").replace('\r', '\n').split('\n')

    private fun parseBlocks(lines: List<String>, depth: Int): List<MdBlock> {
        val out = ArrayList<MdBlock>()
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            if (line.isBlank()) {
                i++
                continue
            }
            val fence = matchFenceOpen(line)
            if (fence != null) {
                i = readFence(lines, i, fence, out)
                continue
            }
            val heading = matchAtxHeading(line)
            if (heading != null) {
                out += heading
                i++
                continue
            }
            if (isThematicBreak(line)) {
                out += MdBlock.Rule
                i++
                continue
            }
            if (depth < MAX_NESTING && stripQuoteMarker(line) != null) {
                val (blocks, next) = readQuote(lines, i, depth)
                out += MdBlock.Quote(blocks)
                i = next
                continue
            }
            val marker = matchListItem(line)
            if (marker != null && depth < MAX_NESTING) {
                val (items, next) = readList(lines, i, marker, depth)
                out += MdBlock.MdList(ordered = marker.ordered, start = marker.number, items = items)
                i = next
                continue
            }
            if (isTableStart(lines, i)) {
                i = readTable(lines, i, out)
                continue
            }
            i = readParagraph(lines, i, out)
        }
        return out
    }

    private fun readParagraph(lines: List<String>, start: Int, out: MutableList<MdBlock>): Int {
        val buf = ArrayList<String>()
        var i = start
        while (i < lines.size) {
            val line = lines[i]
            if (line.isBlank()) break
            if (buf.isNotEmpty()) {
                val setext = matchSetext(line)
                if (setext > 0) {
                    out += MdBlock.Heading(setext, MarkdownInline.parse(buf.joinToString("\n")))
                    return i + 1
                }
                if (startsNewBlock(lines, i)) break
            }
            buf += line.trim()
            i++
        }
        if (buf.isNotEmpty()) out += MdBlock.Paragraph(MarkdownInline.parse(buf.joinToString("\n")))
        return if (i == start) start + 1 else i
    }

    private data class Fence(val marker: Char, val length: Int, val indent: Int, val info: String)

    private fun matchFenceOpen(line: String): Fence? {
        val indent = indentOf(line)
        if (indent > 3) return null
        val rest = line.substring(indent)
        val ch = rest.firstOrNull() ?: return null
        if (ch != '`' && ch != '~') return null
        val run = runLength(rest, 0, ch)
        if (run < 3) return null
        val info = rest.substring(run).trim()
        if (ch == '`' && info.contains('`')) return null
        return Fence(ch, run, indent, info)
    }

    private fun readFence(lines: List<String>, start: Int, fence: Fence, out: MutableList<MdBlock>): Int {
        val body = ArrayList<String>()
        var i = start + 1
        while (i < lines.size) {
            val line = lines[i]
            val indent = indentOf(line)
            val rest = line.substring(indent)
            if (indent <= 3 && rest.firstOrNull() == fence.marker) {
                val run = runLength(rest, 0, fence.marker)
                if (run >= fence.length && rest.substring(run).isBlank()) {
                    out += MdBlock.CodeBlock(languageOf(fence.info), body.joinToString("\n"))
                    return i + 1
                }
            }
            // 代码内容按起始围栏的缩进整体去掉前缀，保持相对缩进
            body += if (indent >= fence.indent) line.substring(fence.indent) else rest
            i++
        }
        out += MdBlock.CodeBlock(languageOf(fence.info), body.joinToString("\n"))
        return i
    }

    /** 读取引用块，返回（内部块序列, 下一行下标）。 */
    private fun readQuote(lines: List<String>, start: Int, depth: Int): Pair<List<MdBlock>, Int> {
        val inner = ArrayList<String>()
        var i = start
        while (i < lines.size) {
            val line = lines[i]
            val stripped = stripQuoteMarker(line)
            if (stripped != null) {
                inner += stripped
                i++
                continue
            }
            if (line.isBlank()) break
            if (startsNewBlock(lines, i)) break
            inner += line.trim() // 惰性续行：`> 第一行` 后的裸文本仍属于引用
            i++
        }
        return parseBlocks(inner, depth + 1) to i
    }

    private data class ListMarker(
        val ordered: Boolean,
        val number: Int,
        val indent: Int,
        val contentIndent: Int,
        val content: String,
    )

    private fun matchListItem(line: String): ListMarker? {
        val indent = indentOf(line)
        if (indent > 3) return null
        val rest = line.substring(indent)
        if (rest.isEmpty()) return null
        val ordered: Boolean
        val number: Int
        var idx: Int
        if (rest[0].isDigit()) {
            var d = 0
            while (d < rest.length && rest[d].isDigit()) d++
            val delim = rest.getOrNull(d)
            if (d > 9 || (delim != '.' && delim != ')')) return null
            number = rest.substring(0, d).toIntOrNull() ?: return null
            ordered = true
            idx = d + 1
        } else if (rest[0] == '-' || rest[0] == '*' || rest[0] == '+') {
            ordered = false
            number = 1
            idx = 1
        } else {
            return null
        }
        var spaces = 0
        while (idx + spaces < rest.length && (rest[idx + spaces] == ' ' || rest[idx + spaces] == '\t')) {
            spaces++
        }
        if (spaces == 0 && idx < rest.length) return null // 标记后必须跟空白，避免把 *斜体* 当列表
        val effective = spaces.coerceAtMost(4)
        return ListMarker(
            ordered = ordered,
            number = number,
            indent = indent,
            contentIndent = indent + idx + effective,
            content = rest.substring(minOf(idx + effective, rest.length)),
        )
    }

    /** 读取整个列表（同级项），返回（列表项, 下一行下标）。 */
    private fun readList(
        lines: List<String>,
        start: Int,
        first: ListMarker,
        depth: Int,
    ): Pair<List<MdListItem>, Int> {
        val items = ArrayList<MdListItem>()
        var i = start
        while (i < lines.size) {
            val marker = matchListItem(lines[i]) ?: break
            if (marker.ordered != first.ordered || marker.indent != first.indent) break
            val content = arrayListOf(marker.content)
            i++
            while (i < lines.size) {
                val line = lines[i]
                if (line.isBlank()) {
                    val next = lines.getOrNull(i + 1)
                    if (next != null && next.isNotBlank() && indentOf(next) >= marker.contentIndent) {
                        content += ""
                        i++
                        continue
                    }
                    break
                }
                val indent = indentOf(line)
                if (indent >= marker.contentIndent) {
                    content += line.substring(marker.contentIndent)
                    i++
                    continue
                }
                val nested = matchListItem(line)
                if (nested != null) {
                    if (nested.indent <= first.indent) break
                    content += line.trim() // 缩进不足的嵌套项：折进内容后靠递归解析
                    i++
                    continue
                }
                if (startsNewBlock(lines, i)) break
                content += line.trim() // 惰性续行
                i++
            }
            items += buildItem(content, depth)
        }
        return items to i
    }

    private fun buildItem(content: MutableList<String>, depth: Int): MdListItem {
        var checked: Boolean? = null
        val task = content.firstOrNull()?.let { TASK_ITEM.find(it) }
        if (task != null) {
            checked = task.groupValues[1] != " "
            content[0] = task.groupValues[2]
        }
        val blocks = if (content.all { it.isBlank() }) emptyList() else parseBlocks(content, depth + 1)
        return MdListItem(blocks, checked)
    }

    private fun isTableStart(lines: List<String>, i: Int): Boolean =
        lines[i].contains('|') && i + 1 < lines.size && lines[i + 1].contains('|') &&
            isTableDelimiter(lines[i + 1])

    private fun isTableDelimiter(line: String): Boolean {
        if (indentOf(line) > 3 || !line.contains('-')) return false
        val cells = splitRow(line)
        return cells.isNotEmpty() && cells.all { DELIM_CELL.matches(it.trim()) }
    }

    private fun readTable(lines: List<String>, start: Int, out: MutableList<MdBlock>): Int {
        val header = splitRow(lines[start])
        val columns = header.size
        val aligns = normalizeRow(splitRow(lines[start + 1]), columns).map { alignmentOf(it) }
        val rows = ArrayList<List<List<MdInline>>>()
        var i = start + 2
        while (i < lines.size) {
            val line = lines[i]
            if (line.isBlank() || !line.contains('|') || startsNewBlock(lines, i)) break
            rows += normalizeRow(splitRow(line), columns).map { MarkdownInline.parse(it) }
            i++
        }
        out += MdBlock.Table(header.map { MarkdownInline.parse(it) }, aligns, rows)
        return i
    }

    private fun alignmentOf(cell: String): MdAlign {
        val t = cell.trim()
        val left = t.startsWith(":")
        val right = t.endsWith(":")
        return when {
            left && right -> MdAlign.CENTER
            left -> MdAlign.LEFT
            right -> MdAlign.RIGHT
            else -> MdAlign.NONE
        }
    }

    /** 拆分表格行；`\|` 视为普通竖线。 */
    private fun splitRow(line: String): List<String> {
        var s = line.trim()
        if (s.startsWith("|")) s = s.substring(1)
        if (s.endsWith("|") && !s.endsWith("\\|")) s = s.substring(0, s.length - 1)
        val cells = ArrayList<String>()
        val cur = StringBuilder()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length && s[i + 1] == '|') {
                cur.append('|')
                i += 2
                continue
            }
            if (c == '|') {
                cells += cur.toString().trim()
                cur.setLength(0)
                i++
                continue
            }
            cur.append(c)
            i++
        }
        cells += cur.toString().trim()
        return cells
    }

    private fun normalizeRow(cells: List<String>, columns: Int): List<String> {
        if (cells.size == columns) return cells
        val out = ArrayList<String>(columns)
        for (i in 0 until columns) out += cells.getOrElse(i) { "" }
        return out
    }

    private fun matchAtxHeading(line: String): MdBlock.Heading? {
        val indent = indentOf(line)
        if (indent > 3) return null
        var i = indent
        while (i < line.length && line[i] == '#') i++
        val level = i - indent
        if (level == 0 || level > 6) return null
        if (i < line.length && !line[i].isWhitespace()) return null
        var content = line.substring(minOf(i, line.length)).trim()
        val closing = CLOSING_HASHES.find(content)
        if (closing != null) content = content.substring(0, closing.range.first).trim()
        return MdBlock.Heading(level, MarkdownInline.parse(content))
    }

    /** 返回 1/2 表示 Setext 标题级别，0 表示不是下划线行。 */
    private fun matchSetext(line: String): Int {
        val indent = indentOf(line)
        if (indent > 3) return 0
        val rest = line.substring(indent).trim()
        if (rest.isEmpty()) return 0
        if (rest.all { it == '=' }) return 1
        if (rest.all { it == '-' }) return 2
        return 0
    }

    private fun isThematicBreak(line: String): Boolean {
        val indent = indentOf(line)
        if (indent > 3) return false
        val rest = line.substring(indent).trim()
        val ch = rest.firstOrNull() ?: return false
        if (ch != '*' && ch != '-' && ch != '_') return false
        var count = 0
        for (c in rest) {
            if (c == ch) count++ else if (!c.isWhitespace()) return false
        }
        return count >= 3
    }

    /** 去掉引用标记，返回引用行内容；不是引用行返回 null。 */
    private fun stripQuoteMarker(line: String): String? {
        val indent = indentOf(line)
        if (indent > 3) return null
        if (line.getOrNull(indent) != '>') return null
        val rest = line.substring(indent + 1)
        return if (rest.startsWith(" ")) rest.substring(1) else rest
    }

    private fun startsNewBlock(lines: List<String>, i: Int): Boolean {
        val line = lines[i]
        if (line.isBlank()) return true
        if (matchFenceOpen(line) != null) return true
        if (matchAtxHeading(line) != null) return true
        if (isThematicBreak(line)) return true
        if (stripQuoteMarker(line) != null) return true
        if (matchListItem(line) != null) return true
        return isTableStart(lines, i)
    }

    private fun languageOf(info: String): String {
        val token = info.trim().substringBefore(' ').trim()
        return if (token.isEmpty() || token.length > 24) "" else token
    }

    private fun indentOf(line: String): Int {
        var i = 0
        while (i < line.length && (line[i] == ' ' || line[i] == '\t')) i++
        return i
    }

    private fun runLength(s: String, from: Int, ch: Char): Int {
        var i = from
        while (i < s.length && s[i] == ch) i++
        return i - from
    }
}
