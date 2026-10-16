package com.deepseek.dshremote.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 轨迹视图里的纯逻辑单测（m00002，task-3）。
 *
 * 为什么只测这一个函数：
 * - [trajectoryDetailPreview] 是轨迹视图里**唯一**不需要 Compose 运行时的逻辑，也是
 *   "一行最多两行副标题"的直接决定者：算错了要么行高乱跳，要么把 160 字的工具输出
 *   塞进一屏，轨迹视图"一屏扫过很多步"这个存在理由就没了。
 * - `TrajectoryList` / `TrajectoryRowItem` / `LoadOlderEntry` 都是 @Composable（本仓库没有
 *   Compose UI 测试基建）；`trajectoryIcon` 是文件级 private，同包的测试文件也引用不到。
 *   kind→图标的映射本身是**不带 `else` 的穷尽 `when`**：新增一种 [com.deepseek.dshremote.data.api.TrajectoryKind]
 *   而忘了配图标会直接编译失败，这比一条断言更硬。
 * - [com.deepseek.dshremote.ui.screens.SessionDetailScreen] 只有私有扩展 `LazyListState.isNearBottom()`
 *   （依赖真实布局信息）与私有 @Composable `MessageItem`，同样不可在 JVM 上单测。
 * - `buildTrajectory` 的行序/行数归 task-2 的 TranscriptPagerTest，这里刻意不重复。
 *
 * 锁死的行为（顺序即用户可见结果）：
 * 1. 先折叠空白再截断，输出里永远不含换行；
 * 2. 截断长度为 `limit - 1` 个字符 + 一个 `…`，即结果长度恰好 `limit`；
 * 3. `limit <= 1` 时退化成纯 `take(limit)`（没有位置放省略号，也不能拿负数去 take）；
 * 4. 空串/纯空白 → 空串（调用方据此判断"这行没有副标题"）。
 */
class TrajectoryListTest {

    // ---------- 超长截断（默认 limit = 160） ----------

    @Test
    fun `超长文本按 limit 减一截断并以省略号结尾`() {
        val out = trajectoryDetailPreview("a".repeat(500))

        assertEquals("截断后长度必须恰好等于 limit", 160, out.length)
        assertEquals("a".repeat(159) + "…", out)
        assertTrue(out.endsWith("…"))
    }

    @Test
    fun `自定义 limit 生效且同样留出省略号的位置`() {
        val out = trajectoryDetailPreview("x".repeat(50), limit = 10)

        assertEquals(10, out.length)
        assertEquals("x".repeat(9) + "…", out)
    }

    @Test
    fun `长度恰好等于 limit 时不截断也不加省略号`() {
        val text = "a".repeat(160)
        val out = trajectoryDetailPreview(text)

        assertEquals(text, out)
        assertFalse("刚好放得下就不该出现省略号", out.endsWith("…"))
    }

    @Test
    fun `截断前先 trimEnd 省略号不跟空格`() {
        // 第 159 个字符正好是空格：不 trimEnd 的话会得到 "… a…"，视觉上是两个空格
        val out = trajectoryDetailPreview("a".repeat(158) + " " + "b".repeat(10))

        assertEquals("a".repeat(158) + "…", out)
        assertFalse(out.contains(" …"))
    }

    // ---------- 空白折叠 ----------

    @Test
    fun `换行与连续空白折叠成单空格并去掉首尾空白`() {
        assertEquals("第一行 第二行", trajectoryDetailPreview("  第一行\n\n\t第二行   "))
    }

    @Test
    fun `折叠发生在截断之前所以结果里不含换行`() {
        // 100 个 "abc\n" 折叠成 "abc abc …"：不先折叠的话截断出来的是 160 个字符里
        // 混着一堆换行，一行的高度就不固定了
        val out = trajectoryDetailPreview("abc\n".repeat(100))

        assertEquals(160, out.length)
        assertFalse(out.contains("\n"))
        assertTrue(out.startsWith("abc abc abc"))
    }

    @Test
    fun `短文本原样返回`() {
        assertEquals("你好，世界", trajectoryDetailPreview("你好，世界"))
    }

    // ---------- 退化输入 ----------

    @Test
    fun `空串返回空串`() {
        assertEquals("", trajectoryDetailPreview(""))
    }

    @Test
    fun `纯空白塌成空串`() {
        assertEquals("", trajectoryDetailPreview("  \n\t  "))
    }

    @Test
    fun `limit 为 1 时只留一个字符且不加省略号`() {
        assertEquals("a", trajectoryDetailPreview("abcdef", limit = 1))
    }

    @Test
    fun `limit 为 0 时返回空串而不是抛异常`() {
        // 负数是调用方 bug，但也必须退化成空串：`take(-1)` 会抛 IllegalArgumentException
        assertEquals("", trajectoryDetailPreview("abcdef", limit = 0))
        assertEquals("", trajectoryDetailPreview("abcdef", limit = -3))
    }

    // ---------- 边界：截断落在非 BMP 字符（emoji）中间 ----------

    @Test
    fun `代理对被劈开时只保证长度受限且不抛异常`() {
        // "🙂" 是 2 个 UTF-16 code unit，take(4) 会把第 3 个 emoji 劈成半个代理对。
        // 这里**刻意不锁死**具体字符串（修成按 code point 截断时这条不该失败），
        // 只锁住"不抛异常 + 不超长 + 仍有省略号"这三个界面真正依赖的性质。
        val out = trajectoryDetailPreview("🙂".repeat(100), limit = 5)

        assertTrue(out.endsWith("…"))
        assertTrue("结果不得超过 limit", out.length <= 5)
    }
}
