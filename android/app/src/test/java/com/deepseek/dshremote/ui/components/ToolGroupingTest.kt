package com.deepseek.dshremote.ui.components

import com.deepseek.dshremote.data.api.ToolCall
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 工具调用分组 / 汇总文案 / 展开窗口的单测。
 *
 * 为什么只测这几个函数：它们是这次"工具卡不再淹没对话流"改造里**唯一**不需要 Compose 运行时的
 * 逻辑（本仓库没有 Compose UI 测试基建），也正好是三条产品约束的落点：
 *
 * 1. `groupToolCalls` —— 连续调用压成一行（一屏能装回好几轮对话）、**失败调用永不进组**
 *    （出错的提示一旦要展开才看得到就等于没提示）。这条"错了就拆开"的规则只有单测能钉住：
 *    界面上一个组被拆成三个组与两个组，肉眼几乎看不出差别，但它决定了错误是不是可见的。
 * 2. `toolRunSummary` —— 折叠行上那一句话（`6 次工具调用 · edit×4 · pwsh×2 · 全部成功 · 5.0s`）。
 *    它是用户在好几百 dp 的滚动里唯一能看到的工具信息，文案的每一个取舍（不写 `×1`、
 *    名字超过 [TOOL_RUN_SUMMARY_NAME_LIMIT] 个就收口、没有计时信息就不写 `—`）都在这层钉死。
 * 3. `toolRunWindow` —— 展开上限：一次铺几百张卡会让消息这个 LazyColumn item 里
 *    同时进几百个可组合节点（卡是 item 内的静态节点，不参与懒加载），是"展开就卡死"的根因。
 *
 * `ToolRunGroup` / `ToolCallCard` 都是 @Composable（不可在 JVM 上测），
 * `messageKeyOf` 是文件级 private（同包测试也引用不到）；它决定存档 key 是否正确，
 * 但没有 Compose 的 SaveableStateRegistry 也无法在纯 JVM 里观察，只能靠代码评审。
 *
 * 本文件用 `internal` 声明（与 CrashReporterTest 一致：AGP 的单元测试编译对 main 有 friend 权限）。
 */
class ToolGroupingTest {

    // ---------- 分组规则 ----------

    @Test
    fun `空列表不产生组`() {
        assertTrue(groupToolCalls(emptyList()).isEmpty())
    }

    @Test
    fun `单次成功调用是一组但不画汇总行`() {
        val runs = groupToolCalls(listOf(call("a", name = "read")))

        assertEquals(1, runs.size)
        // 单次调用直接复用单卡自己的头部：多一层"组"只会让用户点错一次
        assertFalse(runs.single().isGroup)
        assertEquals("a", runs.single().key)
    }

    @Test
    fun `两次调用才成组`() {
        val runs = groupToolCalls(listOf(call("a"), call("b")))

        assertEquals(1, runs.size)
        assertTrue(runs.single().isGroup)
    }

    @Test
    fun `连续成功调用合并成一组并保持原顺序`() {
        val runs = groupToolCalls(listOf(call("a", name = "edit"), call("b", name = "pwsh"), call("c", name = "read")))

        assertEquals(1, runs.size)
        assertEquals(listOf("a", "b", "c"), runs.single().calls.map { it.id })
    }

    @Test
    fun `失败调用被拆出来单独成组且不与相邻合并`() {
        val runs = groupToolCalls(
            listOf(call("ok1"), call("ok2"), call("bad", isError = true), call("ok3")),
        )

        assertEquals("ok ok err ok 要切成 3 组：错误的那个必须单独可见", 3, runs.size)
        assertEquals(listOf("ok1", "ok2"), runs[0].calls.map { it.id })
        assertEquals(listOf("bad"), runs[1].calls.map { it.id })
        assertFalse("失败调用不能进组，否则组头会把它藏起来", runs[1].isGroup)
        assertEquals(1, runs[1].failedCount)
        assertEquals(listOf("ok3"), runs[2].calls.map { it.id })
    }

    @Test
    fun `连续两个失败调用也各自成组`() {
        val runs = groupToolCalls(listOf(call("bad1", isError = true), call("bad2", isError = true)))

        assertEquals(2, runs.size)
        assertTrue(runs.all { it.calls.size == 1 && it.failedCount == 1 })
    }

    @Test
    fun `分组只是切分不改变总数与顺序`() {
        val calls = listOf(
            call("1"), call("2", isError = true), call("3"), call("4"),
            call("5", isError = true), call("6"),
        )
        val runs = groupToolCalls(calls)

        assertEquals(calls.map { it.id }, runs.flatMap { it.calls }.map { it.id })
        assertTrue("不允许出现空组（空组会在界面上留一行没有内容的卡）", runs.all { it.calls.isNotEmpty() })
    }

    // ---------- 组头图标 / 强调条用的工具名 ----------

    @Test
    fun `组头工具名取出现次数最多的并列取先出现的`() {
        val mixed = groupToolCalls(listOf(call("1", name = "read"), call("2", name = "read"), call("3", name = "edit")))
        assertEquals("read", mixed.single().dominantName)

        val tie = groupToolCalls(listOf(call("1", name = "read"), call("2", name = "edit")))
        assertEquals("并列时取先出现的那个，与 nameCounts 的顺序一致", "read", tie.single().dominantName)
    }

    // ---------- 汇总文案 ----------

    @Test
    fun `汇总文案与设计样张逐字一致`() {
        val calls = listOf(
            call("e1", name = "edit", durationMs = 1_000),
            call("e2", name = "edit", durationMs = 1_000),
            call("p1", name = "pwsh", durationMs = 500),
            call("e3", name = "edit", durationMs = 1_000),
            call("p2", name = "pwsh", durationMs = 500),
            call("e4", name = "edit", durationMs = 1_000),
        )
        val run = groupToolCalls(calls).single()

        assertEquals("6 次工具调用 · edit×4 · pwsh×2 · 全部成功 · 5.0s", toolRunSummary(run))
    }

    @Test
    fun `只出现一次的工具名不写乘一`() {
        val run = groupToolCalls(listOf(call("a", name = "read"), call("b", name = "grep"))).single()

        assertEquals("2 次工具调用 · read · grep · 全部成功", toolRunSummary(run))
        assertFalse("×1 不提供信息，只占掉本来就不够的一行宽度", toolRunSummary(run).contains("×1"))
    }

    @Test
    fun `工具名超过上限时收口且总数不变`() {
        val calls = listOf(
            call("1", name = "aa"), call("2", name = "bb"), call("3", name = "cc"),
            call("4", name = "dd"), call("5", name = "ee"),
        )
        val summary = toolRunSummary(groupToolCalls(calls).single())

        assertEquals("下面的期望字符串按「名字上限 3」这个前提写", 3, TOOL_RUN_SUMMARY_NAME_LIMIT)
        assertEquals("5 次工具调用 · aa · bb · cc … · 全部成功", summary)
        assertFalse("被收口的名字不该出现（它们展开后各自有卡）", summary.contains("dd"))
        assertFalse(summary.contains("ee"))
    }

    @Test
    fun `单次调用的汇总文案同样成立`() {
        val run = groupToolCalls(listOf(call("a", name = "read", durationMs = 300))).single()

        assertEquals("1 次工具调用 · read · 全部成功 · 0.3s", toolRunSummary(run))
    }

    @Test
    fun `组里出现失败时汇总行说实话`() {
        // 分组阶段失败调用会被拆出去，所以这个分支正常路径走不到；
        // 但手工构造的 ToolRun（或将来放宽分组规则）不能硬写"全部成功"
        val run = ToolRun(listOf(call("bad", isError = true)))

        assertEquals("1 次工具调用 · pwsh · 1 次失败", toolRunSummary(run))
    }

    @Test
    fun `结果还没回来的调用算进行中`() {
        val run = ToolRun(listOf(call("a", result = ""), call("b", result = "")))

        assertEquals(2, run.runningCount)
        assertEquals("2 次工具调用 · pwsh×2 · 2 次进行中", toolRunSummary(run))
    }

    @Test
    fun `失败与进行中同时出现时两段都写`() {
        val run = ToolRun(listOf(call("bad", isError = true), call("running", result = "")))

        assertEquals("2 次工具调用 · pwsh×2 · 1 次失败 · 1 次进行中", toolRunSummary(run))
    }

    @Test
    fun `没有计时信息时不显示耗时段`() {
        val run = groupToolCalls(listOf(call("a"), call("b"))).single()
        val summary = toolRunSummary(run)

        assertEquals("2 次工具调用 · pwsh×2 · 全部成功", summary)
        assertFalse("durationMs=0 是「还没有计时」而不是「跑了 0 秒」，写 — 会被误读", summary.contains("—"))
    }

    @Test
    fun `合计耗时是各次调用之和`() {
        val run = ToolRun(listOf(call("a", durationMs = 70_000), call("b", durationMs = 5_000)))

        assertEquals(75_000L, run.totalDurationMs)
        assertTrue(toolRunSummary(run).endsWith("1m15s"))
    }

    @Test
    fun `空工具名兜底成工具两个字`() {
        val run = ToolRun(listOf(call("a", name = ""), call("b", name = "")))

        assertEquals("2 次工具调用 · 工具×2 · 全部成功", toolRunSummary(run))
    }

    @Test
    fun `空调用列表的汇总文案是空串`() {
        assertEquals("", toolRunSummary(ToolRun(emptyList())))
    }

    // ---------- 展开窗口（性能上限） ----------

    @Test
    fun `不超过上限时全部铺开`() {
        val calls = (1..TOOL_RUN_EXPANDED_LIMIT).map { call("c$it") }
        val window = toolRunWindow(calls)

        assertEquals(TOOL_RUN_EXPANDED_LIMIT, window.visible.size)
        assertEquals(0, window.hidden)
    }

    @Test
    fun `超过上限时只铺前二十其余收口`() {
        val calls = (1..25).map { call("c$it") }
        val window = toolRunWindow(calls)

        assertEquals(TOOL_RUN_EXPANDED_LIMIT, window.visible.size)
        assertEquals("铺开的必须是最前面那些，否则用户看不到自己刚点开的那次", "c1", window.visible.first().id)
        assertEquals("c20", window.visible.last().id)
        assertEquals(5, window.hidden)
    }

    @Test
    fun `上限为零或负数时全部收口且不抛异常`() {
        val calls = (1..3).map { call("c$it") }

        assertTrue(toolRunWindow(calls, limit = 0).visible.isEmpty())
        assertEquals(3, toolRunWindow(calls, limit = 0).hidden)
        // 负数是调用方 bug，但也不能崩在 take(-1) 上
        assertTrue(toolRunWindow(calls, limit = -5).visible.isEmpty())
        assertEquals(3, toolRunWindow(calls, limit = -5).hidden)
    }

    // ---------- 耗时格式 ----------

    @Test
    fun `耗时为非正数时返回空串`() {
        assertEquals("", formatDuration(0L))
        assertEquals("", formatDuration(-1L))
    }

    @Test
    fun `耗时格式沿用 Fmt 的秒与分秒两种写法`() {
        assertEquals("5.0s", formatDuration(5_000L))
        assertEquals("3m12s", formatDuration(192_000L))
    }

    private fun call(
        id: String,
        name: String = "pwsh",
        result: String = "ok",
        isError: Boolean = false,
        durationMs: Long = 0L,
    ): ToolCall = ToolCall(
        id = id,
        name = name,
        argsJson = "{}",
        result = result,
        isError = isError,
        truncated = false,
        durationMs = durationMs,
    )
}
