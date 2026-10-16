package com.deepseek.dshremote.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 轮次导航行预览的清洗（[turnPreviewText]）。
 *
 * 这些用例全部来自真机取证时看到的"难看的预览"：面板里显示过 `- **头部**：…`、
 * `|---|---|` 这类原始 Markdown 标记。测试钉住的是"人读起来像一句话"这条体感标准，
 * 所以断言里刻意包含"不含 ** 与 |"这类形态检查，而不只是逐字快照。
 */
class TurnPreviewTextTest {

    @Test
    fun `粗体与斜体标记被去掉`() {
        val out = turnPreviewText("这是 **重点** 与 *斜体* 混排")
        assertEquals("这是 重点 与 斜体 混排", out)
        assertFalse(out.contains("*"))
    }

    @Test
    fun `表格被摊平成句子且不留分隔行`() {
        val raw = """
            | 文件 | 尺寸 | 字节数 |
            |---|---|---|
            | e2e-64.png | 64 × 64 px | 6,443 bytes |
        """.trimIndent()
        val out = turnPreviewText(raw)
        assertFalse("分隔行不该出现在预览里：$out", out.contains("---"))
        assertTrue("表头仍在：$out", out.contains("文件"))
        assertTrue("单元格内容仍在：$out", out.contains("6,443 bytes"))
        assertFalse("竖线也不该留在预览里：$out", out.contains("|"))
    }

    @Test
    fun `被截断在半截的表格不再吐出一串竖线`() {
        // 真机第 1 轮的预览就是这个形状：服务端 200 字符截断切在表格中间，
        // 解析器认不出表格，`| 文件 | 尺寸 | 字节数 | |---|---|---|` 全成了正文。
        val raw = "两张图已用 read_image 读取，结果（均为归一化副本，image/png）：\n\n" +
            "| 文件 | 尺寸 | 字节数 |\n|---|---|---|\n| e2e-64.png | 64 × 64 px | 6,443 bytes"
        val out = turnPreviewText(raw)
        assertFalse("竖线残留：$out", out.contains("|"))
        assertFalse("分隔行残留：$out", out.contains("---"))
        assertTrue("表头可读：$out", out.contains("文件"))
        assertTrue("单元格可读：$out", out.contains("6,443 bytes"))
    }

    @Test
    fun `单根管道是内容本身要留下`() {
        // `ps aux | grep node` 里的竖线是命令的一部分，只有一根，不按表格处理。
        assertEquals("ps aux | grep node", turnPreviewText("ps aux | grep node"))
    }

    @Test
    fun `列表项摊成一行且换行被折叠`() {        val out = turnPreviewText("- 头部：执行轨迹\n- 中部：用时\n- 底部：toast")
        assertEquals("头部：执行轨迹 中部：用时 底部：toast", out)
    }

    @Test
    fun `标题井号与引用尖括号被去掉`() {
        assertEquals("小结", turnPreviewText("# 小结"))
        assertEquals("注意事项", turnPreviewText("> 注意事项"))
    }

    @Test
    fun `代码围栏语言标记不残留`() {
        val out = turnPreviewText("```kotlin\nval a = 1\n```")
        assertFalse(out.contains("```"))
        assertFalse(out.contains("kotlin"))
        assertTrue(out.contains("val a = 1"))
    }

    @Test
    fun `行内代码的反引号被去掉`() {
        assertEquals("看 read_image 的结果", turnPreviewText("看 `read_image` 的结果"))
    }

    @Test
    fun `空白折叠成单空格并去掉首尾空白`() {
        assertEquals("a b c", turnPreviewText("  a \n\n  b\tc  "))
    }

    @Test
    fun `空输入不会变成一串空白`() {
        assertEquals("", turnPreviewText(""))
        assertEquals("", turnPreviewText("   \n  "))
    }

    @Test
    fun `链接只留文字`() {
        val out = turnPreviewText("见 [协议契约](docs/protocol.md) 第 4 节")
        assertFalse(out.contains("docs/protocol.md"))
        assertTrue(out.contains("协议契约"))
        assertTrue(out.contains("第 4 节"))
    }

    @Test
    fun `纯图片轮次的占位文案原样保留`() {
        assertEquals("（查看这张图片）", turnPreviewText("（查看这张图片）"))
    }

    @Test
    fun `半截 Markdown 不会抛异常`() {
        // 服务端按 200 字符硬截断，预览拿到的经常是"半句话 + 半个标记"
        val out = turnPreviewText("两张图已用 read_image 读取，结果（均为归一化副本，\n| 文件 | 尺寸")
        assertTrue(out.isNotEmpty())
        assertFalse(out.contains("\n"))
    }
}
