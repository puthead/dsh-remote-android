package com.deepseek.dshremote.ui.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 块级 Markdown 解析：标题、段落、围栏代码、列表（嵌套/任务项）、引用、分隔线、表格。
 */
class MarkdownParserTest {

    private fun parse(text: String): List<MdBlock> = MarkdownParser.parse(text)

    private fun text(value: String): MdInline = MdInline.Text(value)

    @Test
    fun `ATX 与 Setext 标题`() {
        val blocks = parse("# 一级标题\n\n## 二级 ##\n\nSetext 一级\n===\n\nSetext 二级\n---")
        assertEquals(4, blocks.size)
        assertEquals(MdBlock.Heading(1, listOf(text("一级标题"))), blocks[0])
        assertEquals(MdBlock.Heading(2, listOf(text("二级"))), blocks[1])
        assertEquals(MdBlock.Heading(1, listOf(text("Setext 一级"))), blocks[2])
        assertEquals(MdBlock.Heading(2, listOf(text("Setext 二级"))), blocks[3])
    }

    @Test
    fun `七个井号不是标题，井号后有空格的要求`() {
        assertEquals(1, parse("####### 不是标题").size)
        assertTrue(parse("####### 不是标题")[0] is MdBlock.Paragraph)
        assertTrue(parse("#没有空格")[0] is MdBlock.Paragraph)
    }

    @Test
    fun `围栏代码块内容原样保留，未闭合时解析到文末`() {
        val blocks = parse("```kotlin\nval a = 1\n# 不是标题\n- 不是列表\n```\n\n```\n未闭合")
        assertEquals(2, blocks.size)
        assertEquals(MdBlock.CodeBlock("kotlin", "val a = 1\n# 不是标题\n- 不是列表"), blocks[0])
        assertEquals(MdBlock.CodeBlock("", "未闭合"), blocks[1])
        assertEquals(MdBlock.CodeBlock("", "a\nb"), parse("~~~\na\nb\n~~~")[0])
    }

    @Test
    fun `代码块保留缩进而非去掉全部前导空白`() {
        val block = parse("```\nif (a) {\n    b()\n}\n```")[0] as MdBlock.CodeBlock
        assertEquals("if (a) {\n    b()\n}", block.code)
    }

    @Test
    fun `无序列表与嵌套列表`() {
        val blocks = parse("- 一\n- 二\n  - 二点一\n  - 二点二\n- 三")
        assertEquals(1, blocks.size)
        val list = blocks[0] as MdBlock.MdList
        assertFalse(list.ordered)
        assertEquals(1, list.start)
        assertEquals(3, list.items.size)
        assertEquals(listOf("一", "二\n二点一\n二点二", "三"), list.items.map { it.plainText() })
        val nested = list.items[1].blocks[1] as MdBlock.MdList
        assertEquals(2, nested.items.size)
        assertEquals("二点二", nested.items[1].plainText())
    }

    @Test
    fun `有序列表保留起始序号，括号与点号都算标记`() {
        val list = parse("3. 三\n4. 四")[0] as MdBlock.MdList
        assertTrue(list.ordered)
        assertEquals(3, list.start)
        assertEquals(listOf("三", "四"), list.items.map { it.plainText() })
        assertEquals(1, (parse("1) 一\n2) 二")[0] as MdBlock.MdList).start)
    }

    @Test
    fun `任务列表识别勾选状态`() {
        val list = parse("- [x] 已完成\n- [X] 也完成\n- [ ] 未完成\n- 普通项")[0] as MdBlock.MdList
        assertEquals(4, list.items.size)
        assertEquals(true, list.items[0].checked)
        assertEquals(true, list.items[1].checked)
        assertEquals(false, list.items[2].checked)
        assertNull(list.items[3].checked)
        assertEquals("已完成", list.items[0].plainText())
    }

    @Test
    fun `列表项内的围栏代码块`() {
        val list = parse("- 步骤：\n  ```kotlin\n  val x = 1\n  ```\n- 结束")[0] as MdBlock.MdList
        assertEquals(2, list.items.size)
        assertEquals(
            listOf(MdBlock.Paragraph(listOf(text("步骤："))), MdBlock.CodeBlock("kotlin", "val x = 1")),
            list.items[0].blocks,
        )
        assertEquals("结束", list.items[1].plainText())
    }

    @Test
    fun `星号加空格才算列表标记，斜体行不被当成列表`() {
        assertEquals(1, parse("*斜体开头* 的段落").size)
        assertTrue(parse("*斜体开头* 的段落")[0] is MdBlock.Paragraph)
        assertTrue(parse("* 列表项")[0] is MdBlock.MdList)
    }

    @Test
    fun `引用块支持内部块与嵌套引用`() {
        val blocks = parse("> 引用第一行\n> 引用第二行\n>\n> - 引用里的列表\n\n> > 嵌套引用")
        assertEquals(2, blocks.size)
        val quote = blocks[0] as MdBlock.Quote
        assertEquals(2, quote.blocks.size)
        assertEquals(
            MdBlock.Paragraph(
                listOf(text("引用第一行"), MdInline.SoftBreak, text("引用第二行")),
            ),
            quote.blocks[0],
        )
        assertEquals("引用里的列表", (quote.blocks[1] as MdBlock.MdList).items[0].plainText())
        val nested = (blocks[1] as MdBlock.Quote).blocks[0] as MdBlock.Quote
        assertEquals("嵌套引用", (nested.blocks[0] as MdBlock.Paragraph).inlines.plainText())
    }

    @Test
    fun `分隔线独立成块，紧贴段落时算 Setext 下划线`() {
        val blocks = parse("段落\n\n---\n\n***\n\n___")
        assertEquals(4, blocks.size)
        assertTrue(blocks[0] is MdBlock.Paragraph)
        assertEquals(MdBlock.Rule, blocks[1])
        assertEquals(MdBlock.Rule, blocks[2])
        assertEquals(MdBlock.Rule, blocks[3])
    }

    @Test
    fun `表格解析列对齐与单元格行内语法`() {
        val blocks = parse("| 名称 | 值 | 备注 |\n|:---|:---:|---:|\n| **粗** | 1 | `c` |\n| b | 2 | d |")
        assertEquals(1, blocks.size)
        val table = blocks[0] as MdBlock.Table
        assertEquals(3, table.header.size)
        assertEquals(listOf(MdAlign.LEFT, MdAlign.CENTER, MdAlign.RIGHT), table.aligns)
        assertEquals(2, table.rows.size)
        assertEquals("粗 | 1 | c", table.rows[0].joinToString(" | ") { it.plainText() })
        assertEquals(listOf<MdInline>(MdInline.Strong(listOf(text("粗")))), table.rows[0][0])
        assertEquals("b | 2 | d", table.rows[1].joinToString(" | ") { it.plainText() })
    }

    @Test
    fun `表格缺列时补空，转义竖线不算分隔符`() {
        val table = parse("| a | b |\n|---|---|\n| 1 |")[0] as MdBlock.Table
        assertEquals(2, table.rows[0].size)
        assertEquals("1", table.rows[0][0].plainText())
        assertEquals("", table.rows[0][1].plainText())
        val escaped = parse("| a | b |\n|---|---|\n| x\\|y | z |")[0] as MdBlock.Table
        assertEquals("x|y", escaped.rows[0][0].plainText())
        assertEquals("z", escaped.rows[0][1].plainText())
    }

    @Test
    fun `不是表格的竖线文本保持为段落`() {
        val blocks = parse("a | b\n不是分隔行")
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is MdBlock.Paragraph)
    }

    @Test
    fun `CRLF 与空输入`() {
        val blocks = parse("# 标题\r\n\r\n- a\r\n- b")
        assertEquals(2, blocks.size)
        assertTrue(blocks[0] is MdBlock.Heading)
        assertTrue(blocks[1] is MdBlock.MdList)
        assertEquals(emptyList<MdBlock>(), MarkdownParser.parse(""))
        assertEquals(emptyList<MdBlock>(), MarkdownParser.parse("\n\n   \n"))
    }

    @Test
    fun `段落内单换行不丢字符`() {
        val blocks = parse("第一行\n第二行\n\n第二段")
        assertEquals(2, blocks.size)
        assertEquals("第一行\n第二行", (blocks[0] as MdBlock.Paragraph).inlines.plainText())
        assertEquals("第二段", (blocks[1] as MdBlock.Paragraph).inlines.plainText())
    }

    @Test
    fun `无语法文本逐字符不变`() {
        val samples = listOf(
            "把 android 模块的单元测试跑一遍，失败的话帮我定位原因",
            "（示例文本，可直接改成别的）",
            "路径 android\\app\\src\\main\\java\\com\\deepseek\\dshremote 已就绪",
            "耗时 12.3s，共 214 个用例 / 24 个测试类",
            "D:\\Workspace\\dsh_android\\.toolchain\\android-dev\\jdk17",
        )
        for (sample in samples) {
            assertEquals(sample, MarkdownParser.toPlainText(sample))
        }
    }

    @Test
    fun `大文本与病态嵌套不会抛异常`() {
        val big = buildString {
            repeat(500) { index ->
                append("# 标题 ").append(index).append('\n')
                append("- 列表项 **粗** `code`\n")
                append("| a | b |\n|---|---|\n")
                append("> 引用\n\n")
            }
        }
        val blocks = MarkdownParser.parse(big)
        assertTrue("块数量应随内容增长", blocks.size >= 1000)
        assertTrue(MarkdownParser.toPlainText(big).isNotEmpty())

        assertTrue(MarkdownParser.parse("> ".repeat(40) + "深").isNotEmpty())
        val deepList = buildString {
            repeat(30) { index ->
                append("  ".repeat(index)).append("- 层").append(index).append('\n')
            }
        }
        assertTrue(MarkdownParser.parse(deepList).isNotEmpty())
        assertTrue(MarkdownParser.parse("#".repeat(100) + " 井号").isNotEmpty())
        assertTrue(MarkdownParser.parse("|".repeat(200)).isNotEmpty())
    }
}
