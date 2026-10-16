package com.deepseek.dshremote.ui.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 行内语法解析：强调、代码 span、链接、转义与「无语法文本逐字符不变」的回归红线。
 */
class MarkdownInlineTest {

    private fun parse(text: String): List<MdInline> = MarkdownInline.parse(text)

    private fun text(value: String): MdInline = MdInline.Text(value)

    @Test
    fun `强调 删除线 行内代码`() {
        assertEquals(
            listOf<MdInline>(
                MdInline.Strong(listOf(text("粗"))),
                text(" "),
                MdInline.Emph(listOf(text("斜"))),
                text(" "),
                MdInline.Strike(listOf(text("删"))),
                text(" "),
                MdInline.Code("code"),
            ),
            parse("**粗** *斜* ~~删~~ `code`"),
        )
    }

    @Test
    fun `三星号是粗体加斜体，嵌套强调各自解析`() {
        assertEquals(
            listOf<MdInline>(
                MdInline.Strong(listOf(MdInline.Emph(listOf(text("又粗又斜"))))),
            ),
            parse("***又粗又斜***"),
        )
        assertEquals(
            listOf<MdInline>(
                MdInline.Strong(
                    listOf(text("粗体中的"), MdInline.Emph(listOf(text("斜"))), text("尾")),
                ),
            ),
            parse("**粗体中的*斜*尾**"),
        )
        // 内层强调紧贴外层收尾定界符（`*斜***`）：粗体范围仍应被识别
        assertTrue(parse("**粗体中的*斜***").first() is MdInline.Strong)
    }

    @Test
    fun `下划线在词中间不算强调`() {
        assertEquals(listOf<MdInline>(text("snake_case_name")), parse("snake_case_name"))
        assertEquals(listOf<MdInline>(text("DshPrimaryContainer 与 _私有")), parse("DshPrimaryContainer 与 _私有"))
    }

    @Test
    fun `星号被当成乘号时不算强调`() {
        assertEquals(listOf<MdInline>(text("2 * 3 * 4")), parse("2 * 3 * 4"))
        assertEquals(listOf<MdInline>(text("* 不是强调开头")), parse("* 不是强调开头"))
    }

    @Test
    fun `未闭合定界符整体按普通文本输出`() {
        assertEquals(listOf<MdInline>(text("**没有闭合")), parse("**没有闭合"))
        assertEquals(listOf<MdInline>(text("~~也没有闭合")), parse("~~也没有闭合"))
        assertEquals(listOf<MdInline>(text("`未闭合的代码")), parse("`未闭合的代码"))
    }

    @Test
    fun `行内代码内部不再解析语法`() {
        assertEquals(
            listOf<MdInline>(text("看 "), MdInline.Code("**不是粗体**"), text(" 结束")),
            parse("看 `**不是粗体**` 结束"),
        )
        assertEquals(listOf<MdInline>(MdInline.Code("a b c")), parse("``a b c``"))
        assertEquals(listOf<MdInline>(MdInline.Code("code")), parse("` code `"))
    }

    @Test
    fun `链接 图片 自动链接`() {
        assertEquals(
            listOf<MdInline>(MdInline.Link(listOf(text("文档")), "https://example.com/a.md")),
            parse("[文档](https://example.com/a.md)"),
        )
        assertEquals(
            listOf<MdInline>(
                MdInline.Link(
                    listOf(MdInline.Strong(listOf(text("粗"))), text("链接")),
                    "https://example.com/?a=1",
                ),
            ),
            parse("[**粗**链接](https://example.com/?a=1)"),
        )
        assertEquals(
            listOf<MdInline>(MdInline.Link(listOf(text("带标题")), "https://example.com/")),
            parse("[带标题](https://example.com/ \"可选的标题\")"),
        )
        assertEquals(
            listOf<MdInline>(MdInline.Image("截图", "shot.png")),
            parse("![截图](shot.png)"),
        )
        assertEquals(
            listOf<MdInline>(MdInline.Link(listOf(text("https://example.com")), "https://example.com")),
            parse("<https://example.com>"),
        )
        assertEquals(
            listOf<MdInline>(MdInline.Link(listOf(text("me@example.com")), "mailto:me@example.com")),
            parse("<me@example.com>"),
        )
    }

    @Test
    fun `裸地址自动变成链接且末尾标点不计入`() {
        assertEquals(
            listOf<MdInline>(
                text("见 "),
                MdInline.Link(listOf(text("https://example.com/x?a=1")), "https://example.com/x?a=1"),
                text("。"),
            ),
            parse("见 https://example.com/x?a=1。"),
        )
        assertEquals(
            listOf<MdInline>(
                text("("),
                MdInline.Link(listOf(text("https://example.com/a")), "https://example.com/a"),
                text(")"),
            ),
            parse("(https://example.com/a)"),
        )
        // 链接语法内部的地址不重复处理
        assertEquals(
            listOf<MdInline>(MdInline.Link(listOf(text("看这里")), "https://example.com/a")),
            parse("[看这里](https://example.com/a)"),
        )
    }

    @Test
    fun `非链接的尖括号原样保留`() {
        assertEquals(listOf<MdInline>(text("List<T> 泛型")), parse("List<T> 泛型"))
    }

    @Test
    fun `转义字符还原为普通字符`() {
        assertEquals(listOf<MdInline>(text("*不是斜体*")), parse("\\*不是斜体\\*"))
        assertEquals(listOf<MdInline>(text("[不是链接](x)")), parse("\\[不是链接\\](x)"))
    }

    @Test
    fun `Windows 路径里的反斜杠不被吃掉`() {
        val path = """D:\Workspace\dsh_android\.toolchain\android-dev\jdk17"""
        assertEquals(listOf<MdInline>(text(path)), parse(path))
        assertEquals(
            listOf<MdInline>(text("""C:\Users\me\.config\app.json""")),
            parse("""C:\Users\me\.config\app.json"""),
        )
    }

    @Test
    fun `换行变成软换行且不成对出现`() {
        assertEquals(
            listOf<MdInline>(text("第一行"), MdInline.SoftBreak, text("第二行")),
            parse("第一行\n第二行"),
        )
        // 结尾多余的换行不会渲染成空行
        assertEquals(listOf<MdInline>(text("只有一行")), parse("只有一行\n"))
    }

    @Test
    fun `无语法文本逐字符不变`() {
        val samples = listOf(
            "这是一段普通说明，包含中英文 mixed content 与数字 123。",
            "路径 D:\\Workspace\\dsh_android 与文件名 build.gradle.kts 保持原样",
            "命令：.\\gradlew.bat :app:testDebugUnitTest --no-daemon",
            "214 个用例全部通过（24 个测试类）",
            "a/b_c-d.e + f*g?h!i",
            "em dash — 与中文标点：、「」（）",
            "JSON: {\"key\":\"value\",\"n\":1}",
        )
        for (sample in samples) {
            assertEquals(sample, parse(sample).plainText())
        }
    }

    @Test
    fun `病态输入不会抛异常`() {
        val pathological = listOf(
            "*".repeat(500),
            "`".repeat(300),
            "[".repeat(200) + "]".repeat(200),
            "![".repeat(100),
            "~~".repeat(150),
            "\\".repeat(200),
            "***".repeat(100),
        )
        for (input in pathological) {
            val out = parse(input)
            assertTrue("解析结果不应为空", out.isNotEmpty())
        }
    }
}
