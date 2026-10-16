package com.deepseek.dshremote.ui.markdown

/**
 * 行内语法解析：代码 span、强调、删除线、链接、图片、自动链接、软换行。
 *
 * 支持的语法被刻意收敛到 DSH 会话里高频出现的写法；无法识别的字符（含 HTML 标签）一律按普通文本
 * 输出，保证「不含 Markdown 语法的文本渲染后逐字符不变」这条回归红线。
 *
 * 解析规则要点：
 * - 代码 span 先于强调处理，反引号内部不再解析任何语法；
 * - `_` 不出现在词中间才算强调定界符（`snake_case` 保持原样）；
 * - 定界符必须「左不后空白、右不前空白」，避免把 `2 * 3 * 4` 之类当成强调；
 * - 强调/删除线/链接标签递归解析，深度上限 [MAX_DEPTH] 防御病态输入。
 */
object MarkdownInline {
    private const val MAX_DEPTH = 8

    /** 这些标点在任意位置都按转义处理（它们本身就是行内/块级语法的触发字符）。 */
    private const val ESCAPE_ALWAYS = "*_`~[]()|<>#+!\\{}"

    /** 这些标点只在词首（前一个字符不是字母/数字/下划线）才按转义处理。 */
    private const val ESCAPE_AT_BOUNDARY = ".,-=\"'/:;?@^$%&"
    private val EMAIL = Regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")
    private val URL_TAIL_TRIM = ".,;:!?、。；：！？\"'*_"

    /**
     * 解析一段可能含换行的行内文本。
     *
     * @return 行内节点序列；换行变成 [MdInline.SoftBreak]，相邻纯文本会合并。
     */
    fun parse(text: String): List<MdInline> = parseDepth(text, 0)

    private fun parseDepth(text: String, depth: Int): List<MdInline> {
        if (text.isEmpty()) return emptyList()
        val out = ArrayList<MdInline>()
        var start = 0
        while (true) {
            val nl = text.indexOf('\n', start)
            if (nl < 0) {
                out += parseLine(text.substring(start), depth)
                break
            }
            out += parseLine(text.substring(start, nl), depth)
            out += MdInline.SoftBreak
            start = nl + 1
        }
        while (out.isNotEmpty() && out.last() === MdInline.SoftBreak) out.removeAt(out.size - 1)
        return merge(out)
    }

    private fun parseLine(line: String, depth: Int): List<MdInline> {
        val out = ArrayList<MdInline>()
        val buf = StringBuilder()
        var i = 0
        fun flush() {
            if (buf.isNotEmpty()) {
                out += MdInline.Text(buf.toString())
                buf.setLength(0)
            }
        }
        while (i < line.length) {
            val c = line[i]
            when {
                c == '\\' && i + 1 < line.length && isEscapableAt(line, i) -> {
                    buf.append(line[i + 1])
                    i += 2
                }

                c == '`' -> {
                    val run = runLength(line, i, '`')
                    val close = findRun(line, i + run, '`', run)
                    if (close < 0) {
                        buf.append(line, i, i + run)
                        i += run
                    } else {
                        flush()
                        out += MdInline.Code(normalizeCode(line.substring(i + run, close)))
                        i = close + run
                    }
                }

                c == '!' && i + 1 < line.length && line[i + 1] == '[' -> {
                    val link = readLink(line, i + 1)
                    if (link == null) {
                        buf.append(c)
                        i++
                    } else {
                        flush()
                        out += MdInline.Image(link.label, link.url)
                        i = link.end
                    }
                }

                c == '[' -> {
                    val link = readLink(line, i)
                    if (link == null) {
                        buf.append(c)
                        i++
                    } else {
                        flush()
                        out += MdInline.Link(parseDepth(link.label, depth + 1), link.url)
                        i = link.end
                    }
                }

                (c == '*' || c == '_') && depth < MAX_DEPTH -> {
                    val parsed = readEmphasis(line, i, depth)
                    if (parsed == null) {
                        buf.append(c)
                        i++
                    } else {
                        flush()
                        out += parsed.nodes
                        i = parsed.end
                    }
                }

                c == '~' && i + 1 < line.length && line[i + 1] == '~' && depth < MAX_DEPTH -> {
                    val parsed = readDelimited(line, i, "~~", depth)
                    if (parsed == null) {
                        buf.append(c)
                        i++
                    } else {
                        flush()
                        out += parsed.nodes
                        i = parsed.end
                    }
                }

                c == '<' -> {
                    val parsed = readAngleAutolink(line, i)
                    if (parsed == null) {
                        buf.append(c)
                        i++
                    } else {
                        flush()
                        out += parsed.nodes
                        i = parsed.end
                    }
                }

                c == 'h' -> {
                    val parsed = readBareUrl(line, i)
                    if (parsed == null) {
                        buf.append(c)
                        i++
                    } else {
                        flush()
                        out += parsed.nodes
                        i = parsed.end
                    }
                }

                else -> {
                    buf.append(c)
                    i++
                }
            }
        }
        flush()
        return merge(out)
    }

    private data class Parsed(val nodes: List<MdInline>, val end: Int)

    private data class RawLink(val label: String, val url: String, val end: Int)

    /** 解析 `*x*` / `**x**` / `***x***`；返回 null 表示按普通字符处理。 */
    private fun readEmphasis(line: String, start: Int, depth: Int): Parsed? {
        val ch = line[start]
        val run = runLength(line, start, ch)
        val after = start + run
        if (after >= line.length || line[after].isWhitespace()) return null
        val before = if (start == 0) ' ' else line[start - 1]
        if (ch == '_' && isWordChar(before)) return null

        if (run >= 3) {
            val close = findClosing(line, after, ch, 3, exact = false)
            if (close > after) {
                val inner = parseDepth(line.substring(after, close), depth + 1)
                return Parsed(listOf(MdInline.Strong(listOf(MdInline.Emph(inner)))), close + 3)
            }
        }
        val size = if (run >= 2) 2 else 1
        var close = findClosing(line, after, ch, size, exact = true)
        if (close <= after && size == 2) {
            // `**粗体中的*斜***` 这类写法：收尾定界符比需要的长，取前两个字符收尾
            close = findClosing(line, after, ch, size, exact = false)
        }
        if (close > after) {
            val inner = parseDepth(line.substring(after, close), depth + 1)
            val node = if (size == 2) MdInline.Strong(inner) else MdInline.Emph(inner)
            return Parsed(listOf(node), close + size)
        }
        // 定界符没有成对闭合时整体按普通文本输出（CommonMark 同样如此），避免吞掉字符
        return null
    }

    /** 解析 `~~x~~` 这类成对定界符。 */
    private fun readDelimited(line: String, start: Int, delim: String, depth: Int): Parsed? {
        val after = start + delim.length
        if (after >= line.length || line[after].isWhitespace()) return null
        var i = after
        while (i < line.length) {
            val c = line[i]
            if (c == '\\') {
                i += 2
                continue
            }
            if (line.startsWith(delim, i)) {
                if (i > after && !line[i - 1].isWhitespace()) {
                    val inner = parseDepth(line.substring(after, i), depth + 1)
                    return Parsed(listOf(MdInline.Strike(inner)), i + delim.length)
                }
                i += delim.length
                continue
            }
            i++
        }
        return null
    }

    private fun findClosing(line: String, from: Int, ch: Char, size: Int, exact: Boolean): Int {
        var i = from
        while (i < line.length) {
            val c = line[i]
            if (c == '\\' && i + 1 < line.length) {
                i += 2
                continue
            }
            if (c == '`') {
                val run = runLength(line, i, '`')
                val close = findRun(line, i + run, '`', run)
                i = if (close < 0) i + run else close + run
                continue
            }
            if (c == ch) {
                val run = runLength(line, i, ch)
                val sizeOk = if (exact) run == size else run >= size
                if (sizeOk && i > from && !line[i - 1].isWhitespace()) {
                    val afterRun = i + size
                    val next = if (afterRun >= line.length) ' ' else line[afterRun]
                    if (ch != '_' || !isWordChar(next)) return i
                }
                i += run
                continue
            }
            i++
        }
        return -1
    }

    /** [open] 必须指向 `[`；返回 null 表示不是合法链接（调用方按普通字符处理）。 */
    private fun readLink(line: String, open: Int): RawLink? {
        var i = open + 1
        var depth = 1
        val label = StringBuilder()
        while (i < line.length) {
            val c = line[i]
            if (c == '\\' && i + 1 < line.length) {
                label.append(line[i + 1])
                i += 2
                continue
            }
            if (c == '[') {
                depth++
            } else if (c == ']') {
                depth--
                if (depth == 0) break
            }
            label.append(c)
            i++
        }
        if (depth != 0 || i + 1 >= line.length || line[i + 1] != '(') return null
        var j = i + 2
        val url = StringBuilder()
        var parens = 0
        var closed = false
        while (j < line.length) {
            val c = line[j]
            if (c == '\\' && j + 1 < line.length) {
                url.append(line[j + 1])
                j += 2
                continue
            }
            if (c.isWhitespace()) {
                // `[文字](地址 "标题")`：跳过标题部分，定位到右括号
                val close = line.indexOf(')', j + 1)
                if (close < 0) return null
                j = close
                closed = true
                break
            }
            if (c == '(') {
                parens++
            } else if (c == ')') {
                if (parens == 0) {
                    closed = true
                    break
                }
                parens--
            }
            url.append(c)
            j++
        }
        if (!closed) return null
        val href = url.toString().trim()
        if (href.isEmpty()) return null
        return RawLink(label.toString(), href, j + 1)
    }

    /** `<https://x>` / `<mailto:a@b>` 形式的自动链接；其他尖括号内容原样输出。 */
    private fun readAngleAutolink(line: String, start: Int): Parsed? {
        val end = line.indexOf('>', start + 1)
        if (end < 0) return null
        val body = line.substring(start + 1, end)
        if (body.isEmpty() || body.any { it.isWhitespace() }) return null
        return when {
            body.contains("://") -> Parsed(
                listOf(MdInline.Link(listOf(MdInline.Text(body)), body)),
                end + 1,
            )

            EMAIL.matches(body) -> Parsed(
                listOf(MdInline.Link(listOf(MdInline.Text(body)), "mailto:$body")),
                end + 1,
            )

            else -> null
        }
    }

    /** 裸地址（http/https）自动变成链接；末尾标点不计入地址。 */
    private fun readBareUrl(line: String, start: Int): Parsed? {
        if (!line.startsWith("https://", start) && !line.startsWith("http://", start)) return null
        if (start > 0 && isWordChar(line[start - 1])) return null
        var end = start
        while (end < line.length) {
            val c = line[end]
            if (c.isWhitespace() || c == '<' || c == '>' || c == '"' || c == '`') break
            end++
        }
        val url = trimUrlTail(line.substring(start, end))
        if (url.length <= "https://".length) return null
        return Parsed(listOf(MdInline.Link(listOf(MdInline.Text(url)), url)), start + url.length)
    }

    private fun trimUrlTail(raw: String): String {
        var end = raw.length
        while (end > 0) {
            val c = raw[end - 1]
            val drop = when {
                c in URL_TAIL_TRIM -> true
                c == ')' -> raw.take(end).count { it == ')' } > raw.take(end).count { it == '(' }
                c == ']' -> raw.take(end).count { it == ']' } > raw.take(end).count { it == '[' }
                else -> false
            }
            if (!drop) break
            end--
        }
        return raw.substring(0, end)
    }

    /**
     * 反斜杠转义判定。
     *
     * 特殊处理：DSH 输出里大量出现 Windows 绝对路径（`D:\Workspace\dsh_android\.toolchain\jdk17`），
     * 若把 `\.` 一律当转义，路径会掉字符显示错。因此 `.,-` 这类标点只在「词首」才按转义处理，
     * 语法字符（`\*`、`` \` ``、`\[` 等）仍然到处都能转义。
     */
    private fun isEscapableAt(text: String, i: Int): Boolean {
        val next = text[i + 1]
        if (ESCAPE_ALWAYS.indexOf(next) >= 0) return true
        if (ESCAPE_AT_BOUNDARY.indexOf(next) < 0) return false
        val prev = if (i == 0) ' ' else text[i - 1]
        return !isWordChar(prev)
    }

    private fun isWordChar(c: Char): Boolean = c.isLetterOrDigit() || c == '_'

    private fun runLength(s: String, from: Int, ch: Char): Int {
        var i = from
        while (i < s.length && s[i] == ch) i++
        return i - from
    }

    /** 查找长度恰好为 [size] 的定界符串；长度不符的连续串整体跳过（避免匹配 ` `` ` 的子串）。 */
    private fun findRun(s: String, from: Int, ch: Char, size: Int): Int {
        var i = from
        while (i < s.length) {
            if (s[i] == ch) {
                val run = runLength(s, i, ch)
                if (run == size) return i
                i += run
            } else {
                i++
            }
        }
        return -1
    }

    /** 行内代码的公共空白处理：单行化，并去掉首尾成对的一个空格。 */
    private fun normalizeCode(text: String): String {
        val flat = text.replace('\n', ' ')
        val paired = flat.length >= 3 && flat.first() == ' ' && flat.last() == ' '
        return if (paired && flat.any { it != ' ' }) flat.substring(1, flat.length - 1) else flat
    }

    private fun merge(nodes: List<MdInline>): List<MdInline> {
        if (nodes.size < 2) return nodes
        val out = ArrayList<MdInline>(nodes.size)
        for (node in nodes) {
            val last = out.lastOrNull()
            if (node is MdInline.Text && last is MdInline.Text) {
                out[out.size - 1] = MdInline.Text(last.text + node.text)
            } else if (node !is MdInline.Text || node.text.isNotEmpty()) {
                out += node
            }
        }
        return out
    }
}
