package com.deepseek.dshremote.data.api

import com.deepseek.dshremote.ui.components.buildTrajectory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Ignore
import org.junit.Test

/**
 * 「手机端对话分页」数据核心 [TranscriptPager] 的窗口语义单测（m00002），
 * 外加轨迹投影 `buildTrajectory` 的行序/行数（第 9 条）。
 *
 * 这一层是纯计算（无 Android/协程依赖），所以能把真实翻页路径整条跑穿：
 * 首屏 merge → 上拉「加载更早」→ 重叠页去重 → 有界裁剪 → 本地乐观消息。
 *
 * 锁死的不变量（顺序即用户可见行为）：
 * 1. `messages` **严格按 seq 升序**且互不重复（去重按 seq，后到者胜）；本地乐观消息对外 seq 恒为 `0`
 *    （不占服务端序号空间），但在窗口里**排在最末** —— 它内部用大于任何真实 seq 的合成 key，时间线上就是最后一句；
 * 2. 窗口**有界**（capacity），且裁剪按 **seq 方向**：追新丢最旧、上拉更早丢最新 —— 刚载入的那一页一定留得下来；
 * 3. 游标只由服务端页推进，且分两种策略：`ADVANCE`（加载更早，下标必须严格变小，否则关掉入口不再空转）、
 *    `PRESERVE`（追最新，不许把游标往更新方向推）；
 * 4. 页里没带 nextCursor（老网关）时**保留**旧游标，绝不能误判成「已到最早」；
 * 5. 解析失败/退化响应不许抛异常，只能退化成"没有更多更早"。
 *
 * fixture 按服务端真实契约造：`tools/dsh-remote/lib/session-reader.mjs:745-751`（`paginate`）里
 * `from`/`to` 是**半开偏移区间** `[from, to)`，`messages.size == to - from`，
 * `nextCursor = String(from)` 是"更早一页"要传的排他上界（`from == 0` 时为 null = 已到最早）。
 * 真实 `seq` 是会话日志的稀疏水位，这里为便于断言取 `seq = 下标 + 1`（连续）。
 */
class TranscriptPagerTest {

    // ---------- 造数据小工具 ----------

    /**
     * 一页 transcript（半开偏移 [from, to)）。
     *
     * `nextCursor` 默认按契约取 `from`（`from == 0` 时取 null = 已到最早），
     * `cursorProvided` 默认 true = 响应里**有**这个字段。
     *
     * 要模拟"老网关连字段都没有"（服务端不表态）时，请显式构造 `TranscriptPage(..., cursorProvided = false)`，
     * 光把 `nextCursor` 传 null 表达的是**另一种**语义：服务端明确说"已到最早"。
     * 这两件事在协议里读出来都是 null，但客户端的行为相反，所以 fixture 必须能分别表达。
     */
    private fun page(
        from: Int,
        to: Int,
        nextCursor: String? = if (from > 0) from.toString() else null,
        total: Int = 250,
        cursorProvided: Boolean = true,
    ): TranscriptPage = TranscriptPage(
        messages = (from until to).map { message(it.toLong() + 1) },
        nextCursor = nextCursor,
        total = total,
        from = from,
        to = to,
        cursorProvided = cursorProvided,
    )

    private fun message(seq: Long, text: String = "msg-$seq"): ChatMessage =
        ChatMessage(seq = seq, role = "assistant", at = BASE_AT + seq, text = text)

    /**
     * 一页 transcript，且**序号与 seq 对齐**（第 n 条消息的 seq 就是 n）。
     *
     * `page()` 用的是"seq = offset + 1"，只适合单页断言；一旦要模拟"服务端按 offset 切真实会话"，
     * 就必须让第 n 条消息的 seq == n，否则第二页造出来的 seq 与 offset 对不上，翻页断言会假失败。
     */
    private fun offsetPage(from: Int, to: Int, total: Int): TranscriptPage = TranscriptPage(
        messages = ((from + 1)..to).map { message(it.toLong()) },
        nextCursor = if (from > 0) from.toString() else null,
        total = total,
        from = from,
        to = to,
    )

    private fun toolCall(
        name: String,
        result: String = "",
        isError: Boolean = false,
        argsJson: String = "{}",
    ): ToolCall = ToolCall(
        id = "call-$name",
        name = name,
        argsJson = argsJson,
        result = result,
        isError = isError,
        truncated = false,
        durationMs = 12L,
    )

    /**
     * 断言窗口按 seq 严格升序且互不重复（共用）。
     * 只适用于**不含本地乐观消息**的窗口：本地消息对外 seq 恒为 0 且排在末尾（见 `本地乐观消息…` 那条用例）。
     */
    private fun assertAscendingAndUnique(pager: TranscriptPager) {
        val seqs = pager.messages.map { it.seq }
        assertEquals("窗口必须按 seq 升序", seqs.sorted(), seqs)
        assertEquals("窗口内 seq 不得重复", seqs.distinct(), seqs)
        assertEquals("窗口内 seq 必须严格递增（不留空洞也允许，但不能重复）", seqs.size, seqs.toSet().size)
    }

    // ---------- 1. 首屏 ----------

    @Test
    fun `首屏 merge 建立一页升序窗口并打开加载更早入口`() {
        val pager = TranscriptPager()
        val window = pager.merge(page(from = 200, to = 250))

        assertEquals("首屏窗口恰好一页 50 条", 50, window.size)
        assertEquals(50, pager.messages.size)
        assertEquals("窗口最旧的是本页首条", 201L, pager.messages.first().seq)
        assertEquals("窗口最新的是本页末条", 250L, pager.messages.last().seq)
        assertAscendingAndUnique(pager)

        assertEquals("还有更早 → 上拉入口必须可见", "200", pager.state.nextCursor)
        assertTrue(pager.state.hasMoreOlder)
        assertTrue("首屏完成后界面才能从骨架切到列表", pager.state.initialized)
        assertEquals("总条数用服务端上报的 250", 250, pager.state.total)
        assertEquals("整页时缓存下界正好等于服务端 from", 200, pager.state.loadedFrom)
        assertEquals("缓存上界 = 服务端排他上界 to", 250, pager.state.loadedTo)
        assertEquals("已加载条数 = 50", 50, pager.state.loadedCount)
        assertFalse(pager.state.trimmedOlder)
        assertFalse(pager.state.trimmedNewer)
    }

    // ---------- 2. 上拉加载更早 ----------

    @Test
    fun `上拉加载更早把更早一页头插进窗口且整体仍然升序`() {
        val pager = TranscriptPager()
        pager.merge(page(from = 200, to = 250))
        pager.merge(page(from = 150, to = 200), trimOldest = false)

        assertEquals("两页合并后窗口 100 条", 100, pager.messages.size)
        assertEquals("更早的一页是头插：最旧的变成 151", 151L, pager.messages.first().seq)
        assertEquals("窗口最新仍是首屏末条 250", 250L, pager.messages.last().seq)
        assertAscendingAndUnique(pager)
        assertEquals("seq 一条不少、一条不多", (151L..250L).toSet(), pager.messages.map { it.seq }.toSet())

        assertEquals("游标被推进到更早一页", "150", pager.state.nextCursor)
        assertTrue(pager.state.hasMoreOlder)
        assertEquals("100 条已缓存，未触发裁剪", 100, pager.state.loadedCount)
        assertEquals("已加载区间下界跟着前进", 150, pager.state.loadedFrom)
        assertFalse("窗口没超容量，不该标裁剪", pager.state.trimmedNewer)
    }

    // ---------- 3. 重叠页去重（后到者胜） ----------

    @Test
    fun `重叠页同 seq 只保留一条且后到者胜`() {
        val pager = TranscriptPager()
        pager.merge(page(from = 100, to = 102))

        // 服务端重发窗口边界（同一 seq 再次出现）：内容被权威投影覆盖。
        // 用 PRESERVE：重发的是"同一位置"，不该把游标往更新方向推。
        pager.merge(
            TranscriptPage(
                messages = listOf(message(102, "服务端第二版"), message(103)),
                nextCursor = "101",
                total = 250,
                from = 101,
                to = 103,
            ),
            TranscriptPager.CursorPolicy.PRESERVE,
        )

        assertEquals("重叠的 seq=102 不得变成两条", 3, pager.messages.size)
        assertEquals(listOf(101L, 102L, 103L), pager.messages.map { it.seq })
        assertAscendingAndUnique(pager)

        val overlapped = pager.messages.single { it.seq == 102L }
        assertEquals("同一 seq 后到者胜（服务端权威投影覆盖旧内容）", "服务端第二版", overlapped.text)
        assertEquals("窗口里不该还有第一版", 0, pager.messages.count { it.text == "服务端第一版" })
        assertEquals("PRESERVE：重发同一位置不许把游标推新", "100", pager.state.nextCursor)
    }

    @Test
    fun `同一页内重复 seq 也按后到者胜`() {
        val pager = TranscriptPager()
        val window = pager.merge(
            TranscriptPage(
                messages = listOf(message(7, "页内旧"), message(7, "页内新")),
                nextCursor = "6",
                total = 250,
                from = 6,
                to = 7,
            ),
        )

        assertEquals("页内重复 seq 只留一条", 1, window.size)
        assertEquals("页内后到者胜", "页内新", window.single().text)
    }

    // ---------- 4. 有界窗口 ----------

    @Test
    fun `容量 10 时窗口恒为 10 条且追新裁最旧`() {
        assertEquals("默认窗口上限是 600 条", 600, TranscriptPager.DEFAULT_CAPACITY)

        val pager = TranscriptPager(capacity = 10)
        pager.merge(page(from = 0, to = 10))
        assertEquals("满容量恰好 10 条，不裁", 10, pager.messages.size)
        assertEquals(listOf(1L, 10L), listOf(pager.messages.first().seq, pager.messages.last().seq))

        pager.merge(page(from = 10, to = 20))
        assertEquals("追新后窗口仍恒为 10 条", 10, pager.messages.size)
        assertEquals(
            "追新（trimOldest=true）丢最旧：窗口 == 11..20",
            listOf(11L, 20L),
            listOf(pager.messages.first().seq, pager.messages.last().seq),
        )
        assertAscendingAndUnique(pager)
        assertTrue("裁掉了更早的 10 条，界面要提示", pager.state.trimmedOlder)
        assertFalse("追新不该裁最新", pager.state.trimmedNewer)
        assertEquals("窗口滚动后已缓存下界跟着走", 10, pager.state.loadedFrom)
        assertEquals(20, pager.state.loadedTo)

        // 连续 merge 多页：窗口大小恒等于容量，且始终落在最新 10 条
        for (start in 20..60 step 10) {
            pager.merge(page(from = start, to = start + 10))
            assertEquals("连续 merge 后窗口大小恒等于容量", 10, pager.messages.size)
            assertEquals("窗口末端跟随最新页", (start + 10).toLong(), pager.messages.last().seq)
        }
        assertEquals("多页之后最新仍是 70", 70L, pager.messages.last().seq)
        assertEquals("多页之后最旧是 61", 61L, pager.messages.first().seq)
    }

    @Test
    fun `容量 10 上拉加载更早时留住刚载入的那一页并丢掉最新`() {
        // lead 裁定的方向：trimOldest=false 丢**最大** seq（丢最新）。
        // 若按插入顺序裁，会恰好把刚载入的更早页丢掉，"上拉加载更早"在满容量时静默失效。
        val pager = TranscriptPager(capacity = 10)
        pager.merge(page(from = 20, to = 30))
        assertEquals(listOf(21L, 30L), listOf(pager.messages.first().seq, pager.messages.last().seq))

        pager.merge(page(from = 10, to = 20), trimOldest = false)

        assertEquals("窗口仍恒为 10 条", 10, pager.messages.size)
        assertEquals(
            "刚载入的更早那页必须留得下来",
            listOf(11L, 20L),
            listOf(pager.messages.first().seq, pager.messages.last().seq),
        )
        assertAscendingAndUnique(pager)
        assertTrue("裁掉的是更新的那一头", pager.state.trimmedNewer)
        assertFalse(pager.state.trimmedOlder)
    }

    // ---------- 5. 上拉不得丢最新 ----------

    @Test
    fun `上拉加载更早不会丢掉窗口里已有的消息`() {
        // 默认容量（600）：一路往更早翻，已加载的每一条都必须还在窗口里
        val pager = TranscriptPager()
        pager.merge(page(from = 200, to = 250))
        assertEquals("首屏最新一条在窗口里", 250L, pager.messages.last().seq)

        pager.merge(page(from = 150, to = 200), trimOldest = false)
        pager.merge(page(from = 100, to = 150), trimOldest = false)

        assertEquals("三页合并后窗口 150 条", 150, pager.messages.size)
        assertEquals("seq 一条不少、一条不多", (101L..250L).toSet(), pager.messages.map { it.seq }.toSet())
        assertEquals("最新一条仍在窗口里", 250L, pager.messages.map { it.seq }.max())
        assertTrue("最新一条的正文也还在", pager.messages.any { it.seq == 250L && it.text == "msg-250" })
        assertAscendingAndUnique(pager)
        assertEquals("游标一路退到 100", "100", pager.state.nextCursor)
        assertEquals("已加载条数与窗口一致", 150, pager.state.loadedCount)
        assertFalse(pager.state.trimmedOlder)
        assertFalse(pager.state.trimmedNewer)
    }

    @Test
    fun `上拉过程中窗口仍然有界且永远是一整段升序消息`() {
        val pager = TranscriptPager(capacity = 10)
        pager.merge(page(from = 20, to = 30))

        for (start in 10 downTo 0 step 10) {
            pager.merge(page(from = start, to = start + 10), trimOldest = false)

            assertEquals("上拉过程中窗口恒为容量大小", 10, pager.messages.size)
            assertAscendingAndUnique(pager)
            val seqs = pager.messages.map { it.seq }
            assertEquals("窗口永远是一整段", 9L, seqs.max() - seqs.min())
        }
        assertEquals("最后一次上拉后窗口就是最前面那 10 条", 1L, pager.messages.first().seq)
        assertEquals(10L, pager.messages.last().seq)
    }

    // ---------- 6. nextCursor 语义 ----------

    @Test
    fun `服务端未带 nextCursor 时保留上一页游标而不是变成已到最早`() {
        val pager = TranscriptPager()
        pager.merge(page(from = 200, to = 250))
        assertEquals("200", pager.state.nextCursor)

        // 老网关**根本不带这个字段**（不是"带了但是 null"）：服务端没表态 ⇒ 不得当成"已到最早"。
        // `cursorProvided = false` 正是 JSON 里 `has("nextCursor") == false` 的等价物。
        pager.merge(
            TranscriptPage(
                messages = (151L..200L).map { message(it) },
                nextCursor = null,
                total = 250,
                from = 150,
                to = 200,
                cursorProvided = false,
            ),
            trimOldest = false,
        )

        assertEquals("字段缺失不得覆盖已有游标", "200", pager.state.nextCursor)
        assertTrue("还有更早，上拉入口必须仍在", pager.state.hasMoreOlder)
        assertEquals("上界只许前进：漏字段的一页不能把已加载区间算小", 250, pager.state.loadedTo)
        assertEquals("已加载条数按窗口实有条数算", 100, pager.state.loadedCount)
        assertAscendingAndUnique(pager)
    }

    @Test
    fun `最早页服务端明确回 nextCursor null 时必须关掉上拉入口`() {
        // from == 0 那一页就是最早一页，服务端明确回 `"nextCursor": null`（字段在、值为 null）。
        // 曾经把它和"字段缺失"混成一个信号 ⇒ 游标被保留成 "40" ⇒ 最早页被反复请求、
        // 「已到最早」永不出现（真机实测重复请求 8 次）。
        val pager = TranscriptPager()
        pager.merge(page(from = 40, to = 100, nextCursor = "40"))
        assertEquals("40", pager.state.nextCursor)

        pager.merge(page(from = 0, to = 40, nextCursor = null), trimOldest = false)

        assertNull("服务端明确说没有更早的了 ⇒ 游标必须关掉", pager.state.nextCursor)
        assertFalse("上拉入口必须变成「已到最早」", pager.state.hasMoreOlder)
        assertEquals("三页都要在窗口里", 100, pager.messages.size)
        assertEquals("已加载条数 = 窗口实有条数", 100, pager.state.loadedCount)
        assertAscendingAndUnique(pager)
    }

    @Test
    fun `已加载条数不虚高：拉回一页更早的只能加一页`() {
        // 真机实测：220 条的会话，首屏 60 条显示「已加载 60/220」，
        // 取回一页更早的之后计数直接跳到 220/220，而窗口里只有 120 条。
        // 根因是 loadedCount 用 loadedTo - loadedFrom 推算（= 服务端上界减窗口条数），
        // 这里把"计数必须来自窗口"钉死。
        //
        // 注意 offset 与 seq 的换算：这条会话共 220 条，seq 就等于"序号"（1..220）⇒
        // offset 160..220 那页的 seq 是 161..220（不是 161..220 之外自造的区间）。
        val pager = TranscriptPager()
        pager.merge(offsetPage(from = 160, to = 220, total = 220))
        // nextCursor 是"更早那一页"的排他上界 = 本页的 from（不是本页的 to）
        assertEquals("160", pager.state.nextCursor)
        assertEquals("首屏 = 一页 60 条", 60, pager.state.loadedCount)
        assertEquals(220, pager.state.total)

        pager.merge(offsetPage(from = 100, to = 160, total = 220), trimOldest = false)

        assertEquals("游标继续往更早走", "100", pager.state.nextCursor)
        assertEquals("只多取了一页 ⇒ 120 条", 120, pager.state.loadedCount)
        assertEquals("窗口里也确实是 120 条", 120, pager.messages.size)
        assertEquals("最旧的那条是 seq 101", 101L, pager.messages.first().seq)
        assertTrue("还没到最早，上拉入口继续在", pager.state.hasMoreOlder)
        assertAscendingAndUnique(pager)
    }

    @Test
    fun `reset 之后已加载条数不残留旧窗口`() {
        // 重开会话（下拉刷新 / 切会话）是整个换窗口：计数必须跟着换成新窗口的条数，
        // 不能因为"上一轮加载过 150 条"就虚高。
        val pager = TranscriptPager()
        pager.merge(page(from = 100, to = 250))
        assertEquals("旧窗口 150 条", 150, pager.state.loadedCount)
        assertEquals(100, pager.state.loadedFrom)
        assertEquals(250, pager.state.loadedTo)

        pager.reset(page(from = 0, to = 50, nextCursor = null))

        assertEquals("窗口换成 50 条", 50, pager.messages.size)
        assertEquals("计数必须跟着换小", 50, pager.state.loadedCount)
        assertEquals("区间也跟着重置", 0, pager.state.loadedFrom)
        assertEquals(50, pager.state.loadedTo)
        assertEquals("总条数仍用服务端上报的", 250, pager.state.total)
    }

    @Test
    fun `本地乐观消息不虚高已加载条数且被裁掉后不再算进服务端条数`() {
        val pager = TranscriptPager(capacity = 3)
        pager.merge(page(from = 100, to = 103))
        assertEquals("窗口 3 条服务端消息", 3, pager.state.loadedCount)

        pager.upsert(ChatMessage(seq = 0L, role = "user", at = 1_791_463_100_000L, text = "本地乐观"))

        assertEquals("本地乐观消息也在窗口里", 4, pager.messages.size)
        assertEquals("但它不算「已加载的服务端条数」", 3, pager.state.loadedCount)

        // 再上拉一页更早的：超出容量按 seq 方向裁"最新" ⇒ 先裁掉排在最末的本地消息，再裁 103
        pager.merge(page(from = 99, to = 100), trimOldest = false)

        assertEquals("窗口被裁回容量 3 条", 3, pager.messages.size)
        assertEquals(listOf(100L, 101L, 102L), pager.messages.map { it.seq })
        assertTrue("本地乐观消息被裁掉", pager.messages.none { it.text == "本地乐观" })
        assertEquals("被裁掉的本地消息不能再被算进服务端条数", 3, pager.state.loadedCount)
        assertAscendingAndUnique(pager)
    }

    @Test
    fun `加载更早时游标必须严格变小否则关掉入口不再空转`() {
        val pager = TranscriptPager()
        pager.merge(page(from = 200, to = 250))
        pager.merge(page(from = 150, to = 200), trimOldest = false)
        assertEquals("游标一路往更早走", "150", pager.state.nextCursor)

        // 服务端把同一页又给了一次（游标没有变小）：再取还是同一页，宁可关掉入口也不空转
        val again = pager.merge(page(from = 150, to = 200), trimOldest = false)
        assertNull("游标没有更早就关掉上拉入口", pager.state.nextCursor)
        assertFalse(pager.state.hasMoreOlder)
        assertEquals("重复页不会把消息复制一份", 100, again.size)
        assertAscendingAndUnique(pager)
    }

    @Test
    fun `服务端给了解析不出来的游标时也不许放行`() {
        // parseCursor 解析不出来的游标一旦原样收下，下一轮的守卫也解析失败并继续放行，
        // 就会退回"永远请求同一页、永远到不了最早"（真机 D2 的复发形态）。
        val garbage = TranscriptPager()
        garbage.merge(page(from = 200, to = 250))
        assertEquals("200", garbage.state.nextCursor)

        garbage.merge(page(from = 150, to = 200, nextCursor = "abc"), trimOldest = false)

        assertNull("解析不出来的游标不许原样收下", garbage.state.nextCursor)
        assertFalse("宁可显示「已到最早」也不能空转", garbage.state.hasMoreOlder)

        // 负数 offset 同样不可能存在
        val negative = TranscriptPager()
        negative.merge(page(from = 200, to = 250))
        negative.merge(page(from = 150, to = 200, nextCursor = "-5"), trimOldest = false)

        assertNull("负数游标不许放行", negative.state.nextCursor)
        assertFalse(negative.state.hasMoreOlder)
    }

    @Test
    fun `首屏收到不可解析的游标时不得收下`() {
        // 首屏这一页就把游标钉死成 "abc"：下一轮 parseCursor(current) 又是 null、守卫再次放行，
        // 同一个游标被反复用来请求同一页。宁可这一轮就没有「加载更早」，也不留一个会空转的入口。
        val page = TranscriptPage(
            messages = (1L..3L).map { message(it) },
            nextCursor = "abc",
            total = 250,
            from = 0,
            to = 3,
            cursorProvided = true,
        )

        val pager = TranscriptPager()
        pager.merge(page)

        assertEquals("消息照常收下", 3, pager.messages.size)
        assertNull("不可解析的游标一个都不许收", pager.state.nextCursor)
        assertFalse("上拉入口保持关闭", pager.state.hasMoreOlder)
        assertTrue(pager.state.initialized)
    }

    @Test
    fun `首屏收到可解析的游标时照常收下`() {
        // 反向守卫：别把"首次只收可解析的"实现成"首次一律拒收"。
        val pager = TranscriptPager()
        pager.merge(
            TranscriptPage(
                messages = (201L..250L).map { message(it) },
                nextCursor = "200",
                total = 250,
                from = 200,
                to = 250,
                cursorProvided = true,
            ),
        )

        assertEquals("合法游标照常收下", "200", pager.state.nextCursor)
        assertTrue("上拉入口必须打开", pager.state.hasMoreOlder)
        assertEquals(50, pager.messages.size)
    }

    @Test
    fun `追最新页用 PRESERVE 不许把游标往更新方向推`() {
        val pager = TranscriptPager()
        pager.merge(page(from = 200, to = 250))
        assertEquals("200", pager.state.nextCursor)

        // 尾部刷新拿到的是"另一头"的一页：它的游标比当前窗口还新，采纳就会留下取不回的断档
        pager.merge(page(from = 250, to = 300), TranscriptPager.CursorPolicy.PRESERVE)

        assertEquals("PRESERVE：有游标就留着", "200", pager.state.nextCursor)
        assertTrue(pager.state.hasMoreOlder)
        assertEquals("追新页照常并入窗口", 100, pager.messages.size)
        assertAscendingAndUnique(pager)

        // 没有旧游标时 PRESERVE 才采纳服务端给的
        val fresh = TranscriptPager()
        fresh.merge(page(from = 200, to = 250), TranscriptPager.CursorPolicy.PRESERVE)
        assertEquals("没有旧游标就用服务端的", "200", fresh.state.nextCursor)
    }

    @Test
    fun `PRESERVE 分支也不许存下不可解析的游标`() {
        // "有一处收垃圾，就有一处要替它兜底"：PRESERVE 下 current 为 null 只说明"首屏还没拿到游标"，
        // 不能把追新页带回来的垃圾游标存进窗口。
        val fresh = TranscriptPager()
        fresh.merge(
            TranscriptPage(
                messages = (1L..3L).map { message(it) },
                nextCursor = "abc",
                total = 250,
                from = 0,
                to = 3,
                cursorProvided = true,
            ),
            TranscriptPager.CursorPolicy.PRESERVE,
        )

        assertNull("PRESERVE 也不许存下不可解析的游标", fresh.state.nextCursor)
        assertFalse("入口保持关闭", fresh.state.hasMoreOlder)
        assertEquals("消息照常收下", 3, fresh.messages.size)

        // 反向守卫：别把 PRESERVE 写成"一律不收"
        val adoptable = TranscriptPager()
        adoptable.merge(page(from = 200, to = 250), TranscriptPager.CursorPolicy.PRESERVE)

        assertEquals("没有旧游标时合法游标照常收下", "200", adoptable.state.nextCursor)
        assertTrue(adoptable.state.hasMoreOlder)

        // 已有游标时 PRESERVE 永远优先：垃圾 offered 连看都不看
        val established = TranscriptPager()
        established.merge(page(from = 200, to = 250))
        assertEquals("200", established.state.nextCursor)

        established.merge(
            TranscriptPage(
                messages = (251L..252L).map { message(it) },
                nextCursor = "abc",
                total = 250,
                from = 250,
                to = 252,
                cursorProvided = true,
            ),
            TranscriptPager.CursorPolicy.PRESERVE,
        )

        assertEquals("current 非空就永远优先", "200", established.state.nextCursor)
        assertTrue("上拉入口不受影响", established.state.hasMoreOlder)
        assertEquals("追新那页照常并入窗口", 52, established.messages.size)
        assertAscendingAndUnique(established)
    }

    @Test
    fun `reset 是唯一允许把游标清成已到最早的路径`() {
        val pager = TranscriptPager()
        pager.merge(page(from = 200, to = 250))
        pager.upsert(message(0, "本地乐观"))
        assertEquals(51, pager.messages.size)

        // 重新打开会话：窗口整个替换成服务端这一页，游标清空表示"还没有更早的已知页"
        pager.reset(page(from = 0, to = 50, nextCursor = null))

        assertEquals("reset 清掉旧窗口（含本地乐观消息）", 50, pager.messages.size)
        assertNull("reset 后没有服务端游标", pager.state.nextCursor)
        assertFalse(pager.state.hasMoreOlder)
        assertTrue(pager.state.initialized)
        assertEquals(250, pager.state.total)
        assertEquals(50, pager.state.loadedCount)
        assertEquals(
            "reset 不得残留上一会话的裁剪标记",
            listOf(false, false),
            listOf(pager.state.trimmedOlder, pager.state.trimmedNewer),
        )
        assertAscendingAndUnique(pager)
    }

    // ---------- 7. 本地乐观消息 ----------

    @Test
    fun `本地乐观消息排在窗口最末且对外 seq 恒为 0`() {
        val pager = TranscriptPager()
        pager.merge(page(from = 100, to = 103))

        val localText = "本地乐观：帮我跑一下构建"
        val afterUpsert = pager.upsert(ChatMessage(seq = 0L, role = "user", at = 1_791_463_100_000L, text = localText))

        assertEquals("乐观消息落在窗口内", 4, afterUpsert.size)
        assertEquals("刚发出去的那句话必须在最末：用户正停在底部等回复", localText, afterUpsert.last().text)
        assertEquals("对外 seq 恒为 0，不凭空发明一个服务端坐标", 0L, afterUpsert.last().seq)
        assertEquals(
            "服务端三条仍是窗口前三条且升序",
            listOf(101L, 102L, 103L),
            afterUpsert.dropLast(1).map { it.seq },
        )
        assertEquals("乐观消息只有一条", 1, afterUpsert.count { it.text == localText })
        assertEquals("服务端上报的总数不被本地乐观消息污染", 250, pager.state.total)
        assertTrue("乐观消息不改变游标", pager.state.hasMoreOlder)

        // 第二条乐观消息接在第一条后面，两条占住窗口最末两位，谁也不覆盖谁
        pager.upsert(ChatMessage(seq = 0L, role = "user", at = 1_791_463_101_000L, text = "本地乐观 2"))
        assertEquals("两条乐观消息互不覆盖", 5, pager.messages.size)
        assertEquals(
            "两条乐观消息按发送顺序占住最末两位",
            listOf(localText, "本地乐观 2"),
            pager.messages.takeLast(2).map { it.text },
        )
        assertEquals("两条对外 seq 都是 0，内部合成 key 不可见", listOf(0L, 0L), pager.messages.takeLast(2).map { it.seq })
        assertEquals("服务端三条一条没少", listOf(101L, 102L, 103L), pager.messages.filter { it.seq > 0L }.map { it.seq })

        // 权威投影接管后本地副本从窗口里消失。**清理的单一事实源在仓库层**：
        // ConsoleRepository.restoreLocalMessages 会把"已被服务端投影接管"的条目从它自己的
        // localMessages 里摘掉、并且不再 upsert 回来；pager 因此不需要 removeLocal() 之类的入口。
        // 这里能断言的 pager 侧行为只有一条：reset(全新一页) 会整个替换窗口，本地副本不留残影。
        pager.reset(page(from = 0, to = 3, nextCursor = null))
        assertEquals("reset 后只剩服务端那一页", 3, pager.messages.size)
        assertEquals(listOf(1L, 2L, 3L), pager.messages.map { it.seq })
        assertEquals("服务端正文原样保留", "msg-1", pager.messages.first().text)
        assertTrue("窗口里不该再有本地乐观消息", pager.messages.none { it.text.startsWith("本地乐观") })
    }

    @Test
    fun `窗口内 seq 不得重复否则轨迹列表的 rowKey 会撞车`() {
        // TrajectoryList 拿 "seq:index:kind" 当 LazyColumn 的 key，窗口里出现两条同 seq 的消息会让
        // 列表抛 "Key was already used" 把整屏打崩；数据层靠 TreeMap 按 seq 去重兜住这条不变量。
        val pager = TranscriptPager(capacity = 10)
        pager.merge(page(from = 0, to = 6))
        pager.merge(page(from = 2, to = 8), trimOldest = false)
        pager.merge(page(from = 4, to = 10), trimOldest = false)

        val seqs = pager.messages.map { it.seq }
        assertEquals("重叠三页合并后仍是连续的 1..10", (1L..10L).toList(), seqs)
        assertEquals("窗口内 seq 必须唯一", seqs.size, seqs.toSet().size)
        assertAscendingAndUnique(pager)

        // 同一 seq 的权威投影再 upsert 一次：只替换，不新增
        val afterUpsert = pager.upsert(message(4, "服务端又投影了一次同一 seq"))
        assertEquals("upsert 已有 seq 只替换不新增", 10, afterUpsert.size)
        assertEquals("该 seq 仍然只有一条", 1, afterUpsert.count { it.seq == 4L })
        assertEquals("内容被权威投影覆盖", "服务端又投影了一次同一 seq", afterUpsert.single { it.seq == 4L }.text)

        // 轨迹行 key 也必须全局唯一（LazyColumn 的真实约束）
        val rows = buildTrajectory(pager.messages)
        assertEquals("轨迹 rowKey 不得重复", rows.size, rows.map { it.rowKey }.distinct().size)
    }

    // ---------- 8. 老网关退化路径 ----------

    @Test
    fun `老网关只回 messages 时不分页也不抛异常`() {
        val raw = """
        {
          "sessionId": "session-legacy-1",
          "messages": [
            { "seq": 1, "role": "user", "at": 1791463030000, "text": "老网关：一次给全量 😅" },
            { "seq": 2, "role": "assistant", "at": 1791463040000, "text": "收到，退化成单页" }
          ]
        }
        """.trimIndent()

        val parsed = JsonV2.parseTranscriptPage(raw)

        assertEquals("老网关的 messages 仍要完整解析", 2, parsed.messages.size)
        assertEquals(1L, parsed.messages.first().seq)
        assertNull("没有 nextCursor", parsed.nextCursor)
        assertFalse("不得把「没有游标」误判成「还有更早」", parsed.hasMoreOlder)
        assertFalse(
            "老网关连字段都没有 ⇒ 必须能与「显式 null」分开（后者才是「已到最早」）",
            parsed.cursorProvided,
        )
        assertEquals("缺 total 时退回本页条数", 2, parsed.total)
        assertEquals(0, parsed.from)
        assertEquals("缺 to 时退回 from + 本页条数", 2, parsed.to)

        // 首屏：这页喂进空 pager 只能退化成"没有更多更早"，界面照常可用
        val fresh = TranscriptPager()
        fresh.merge(parsed)
        assertFalse(fresh.state.hasMoreOlder)
        assertNull(fresh.state.nextCursor)
        assertEquals(2, fresh.messages.size)
        assertTrue(fresh.state.initialized)
        assertAscendingAndUnique(fresh)

        // 真机退化路径：已经翻过页（游标 "200"）之后某一页由老网关回包 ⇒ 不许把上翻入口废掉
        val pager = TranscriptPager()
        pager.merge(page(from = 200, to = 250))
        assertEquals("200", pager.state.nextCursor)

        pager.merge(parsed, trimOldest = false)

        assertEquals("一次老网关回包不得覆盖已有游标", "200", pager.state.nextCursor)
        assertTrue("上翻入口必须还在", pager.state.hasMoreOlder)
        assertEquals("老网关那页的消息照常并入窗口", 52, pager.messages.size)
        assertAscendingAndUnique(pager)
    }

    @Test
    fun `transcript 页 JSON 无法解析时返回空页且不抛异常`() {
        val parsed = JsonV2.parseTranscriptPage("not-json-at-all")

        assertEquals("解析失败必须是空页而不是异常", 0, parsed.messages.size)
        assertNull(parsed.nextCursor)
        assertFalse(parsed.hasMoreOlder)

        val pager = TranscriptPager()
        pager.merge(parsed)
        assertEquals(0, pager.messages.size)
        assertNotNull("merge 空页后状态对象仍然可用（界面显示空列表）", pager.state)
    }

    // ---------- 9. 轨迹投影：行序与行数 ----------

    @Test
    fun `轨迹把 user 消息投影成一行 TURN 且标题为你`() {
        val rows = buildTrajectory(
            listOf(ChatMessage(seq = 7L, role = "user", at = BASE_AT, text = "帮我看下构建")),
        )

        assertEquals("user 消息恰好 1 行", 1, rows.size)
        assertEquals(TrajectoryKind.TURN, rows[0].kind)
        assertEquals("你", rows[0].title)
        assertEquals("帮我看下构建", rows[0].detail)
        assertEquals(0, rows[0].index)
        assertEquals(7L, rows[0].seq)
        assertEquals("7:0:TURN", rows[0].rowKey)
    }

    @Test
    fun `轨迹把 assistant 的工具调用摊成 工具 结果 工具 模型输出 四行`() {
        val withResult = toolCall("pwsh", result = "BUILD SUCCESSFUL\n(2 行输出)")
        val withoutResult = toolCall("read")
        val rows = buildTrajectory(
            listOf(
                ChatMessage(
                    seq = 11L,
                    role = "assistant",
                    at = BASE_AT,
                    text = "先跑构建，再读文件",
                    toolCalls = listOf(withResult, withoutResult),
                ),
            ),
        )

        // 每个 toolCall 都出一行 TOOL，只有拿到结果的才紧随其后追加一行 RESULT，文本最后出一行 THOUGHT
        assertEquals("2 个工具调用 + 1 个结果 + 1 段输出 = 4 行", 4, rows.size)
        assertEquals(
            listOf(
                TrajectoryKind.TOOL,
                TrajectoryKind.RESULT,
                TrajectoryKind.TOOL,
                TrajectoryKind.THOUGHT,
            ),
            rows.map { it.kind },
        )
        assertEquals("同一条消息内 index 从 0 连续递增", listOf(0, 1, 2, 3), rows.map { it.index })
        assertEquals(
            listOf("11:0:TOOL", "11:1:RESULT", "11:2:TOOL", "11:3:THOUGHT"),
            rows.map { it.rowKey },
        )
        assertEquals("pwsh", rows[0].title)
        assertEquals(withResult.argsSummary, rows[0].detail)
        assertEquals("执行结果", rows[1].title)
        assertEquals("换行被压成空格", "BUILD SUCCESSFUL (2 行输出)", rows[1].detail)
        assertFalse(rows[1].isError)
        assertEquals("read", rows[2].title)
        assertEquals("模型输出", rows[3].title)
        assertEquals("先跑构建，再读文件", rows[3].detail)
        assertTrue("每一行都归属同一条消息的 seq", rows.all { it.seq == 11L })
    }

    @Test
    fun `轨迹把待办排在工具之前把交付物排在最后`() {
        val rows = buildTrajectory(
            listOf(
                ChatMessage(
                    seq = 20L,
                    role = "system",
                    at = BASE_AT,
                    text = "",
                    toolCalls = listOf(toolCall("pwsh", result = "ok")),
                    deliverables = listOf(
                        Deliverable("D:\\out\\shot.png", "截图"),
                        Deliverable("D:\\out\\report.md", "报告"),
                    ),
                    todos = listOf(TodoItem("跑构建", "completed"), TodoItem("写测试", "pending")),
                ),
            ),
        )

        assertEquals(
            listOf(
                TrajectoryKind.TODO,
                TrajectoryKind.TODO,
                TrajectoryKind.TOOL,
                TrajectoryKind.RESULT,
                TrajectoryKind.DELIVERABLE,
                TrajectoryKind.DELIVERABLE,
            ),
            rows.map { it.kind },
        )
        assertEquals(listOf(0, 1, 2, 3, 4, 5), rows.map { it.index })
        assertEquals("待办：一步一行", listOf("跑构建", "写测试"), rows.take(2).map { it.title })
        assertEquals("待办带状态", listOf("completed", "pending"), rows.take(2).map { it.detail })
        assertEquals("pwsh", rows[2].title)
        assertEquals("执行结果", rows[3].title)
        assertEquals(
            "交付物排在最后",
            listOf("D:\\out\\shot.png", "D:\\out\\report.md"),
            rows.takeLast(2).map { it.title },
        )
        assertEquals(listOf("截图", "报告"), rows.takeLast(2).map { it.detail })
    }

    /**
     * **空槽（`@Ignore`）：等分页协调器抽出来之后要补的竞态回归。**
     *
     * 这里故意不写实现 —— 一旦有人摘掉 `@Ignore`，必须立刻红，而不是悄悄绿。
     *
     * 要覆盖的两条竞态都发生在 `ConsoleRepository`（"抓游标"与"落页"是两条独立路径），而这一层在
     * JVM 单测里**构造不出来**：`PrefsStore` 需要 Android `Context`（`data/PrefsStore.kt:62-64`），
     * 其余依赖也全是具体类（`data/api/DshApiV2.kt:20-23`、`SessionCache(dir: File)`），
     * 仓库里也没有 mockk / robolectric（可用测试依赖只有 junit、kotlinx-coroutines-test、
     * okhttp-mockwebserver、json-refimpl）。根因是同一条：**落页前没有任何地方校验
     * "要并进来的这一页与当前窗口在 offset 空间连续"**。
     *
     * **A. 换窗口后落进在途的陈旧更早页**（已修：窗口世代号 `windowEpochs` —— `resetWindow` 自增
     * `ConsoleRepository.kt:533`，`mergeOlderPage` 落页前校验 `:569`）
     * 时序（`PAGE_SIZE = 60`、220 条会话）：窗口 offsets 100..160（游标 `"100"`）→ 上拉到顶触发
     * `loadOlder`（在途，取 40..100）→ 用户点刷新 ⇒ `resetWindow` 把窗口换成 161..220（游标 `"160"`）
     * → 在途回包到达（ADVANCE 40 < 160 收下、`trimOldest = false`）⇒ 窗口 = seq 41..100 ∪ 161..220，
     * **101..160 永久丢失**，标题栏还谎报"已加载 120/220"。
     * 期望断言：这一页必须被**整页丢弃**（epoch 变了）；窗口 `map { it.seq }` 连续无洞；
     * `state.loadedCount` 与实际条数一致。
     *
     * **B. 抓游标之后窗口被裁过，再落进在途的更早页 ⇒ 窗口中间留洞**
     * （已修：D7 —— `mergeNewestPage` 真的裁掉最旧一段时也自增 epoch，`ConsoleRepository.kt:601-603`）
     * 时序：窗口**已超过 capacity**（默认 600，真机上要翻过 10 页才会发生）→ `loadOlder` 抓到游标在途
     * → `ConsoleEvent.TurnEnded` 走 `mergeNewestPage`（PRESERVE + `trimOldest = true`）把最旧的若干条
     * 裁掉。**修复前**这里既不换窗口也不自增 `windowEpochs` ⇒ 在途页落地时与窗口底部之间正好缺一段
     * ⇒ 永久空洞（探针：capacity 10 时窗口 11..20 + 在途 page(0,5) ⇒ 窗口变成 1..5 ∪ 11..15，
     * 中间的 6..10 没了，而 `loadedFrom` 还声称 10，游标也被这一页的 null 关掉）。**修复后**该页与 A
     * 一样被整页丢弃，所以这条用例的期望与 A 完全一致。
     * 期望断言：与 A 相同（连续、无洞）。代价（有意接受）：那次上拉白做一次，游标还在，再拉即回来。
     */
    @Ignore(
        "分页协调器尚未抽出：ConsoleRepository 需要 Android Context（PrefsStore.kt:62-64），" +
            "JVM 单测里构造不出来。待抽出后（变更记录 §11.1 待验证项）用 StandardTestDispatcher + " +
            "受控延迟的 fake fetchPage 补 A/B 两条确定性复现。",
    )
    @Test
    fun `窗口世代号：换窗口或裁剪后在途的陈旧更早页不许留下空洞`() {
        fail("空槽：见上方 KDoc 的 A/B 时序与期望断言（A/B 均已修，但都还没有测试覆盖）")
    }

    /**
     * m00011：**同一条本地乐观消息被补回来多少次，都只能占一行。**
     *
     * 时序（`ConsoleRepository.sendTurn` 发一张图，服务端随后投影同一轮）：
     * 1. `appendLocalUserMessage(seq = 0, text = "[1 张图片] …")` ⇒ 窗口里 1 行；
     * 2. 那一轮的 `user/message` 成为权威投影，`mergeNewestPage` 之后 `restoreLocalMessages`
     *    会把"尚未被接管"的本地消息**再补一次**。
     *
     * 修复前合成 key 每调用一次就自增 ⇒ 第 2 步不是覆盖自己而是**多出一行**，
     * 屏幕上就是并排两条一模一样的用户气泡（用户只发了一次）。
     */
    @Test
    fun `本地乐观消息重复补回只占一行（m00011 的合成 key 幂等）`() {
        val pager = TranscriptPager()
        val local = ChatMessage(seq = 0L, role = "user", at = BASE_AT, text = "[1 张图片] 看看这张")

        pager.upsert(local)
        assertEquals("先发一条：窗口 1 行", 1, pager.messages.size)

        pager.upsert(local)
        pager.upsert(local)
        assertEquals("补回来两次还是 1 行", 1, pager.messages.size)
        assertEquals(listOf(local), pager.messages)
        assertEquals("本地消息对外 seq 恒为 0", listOf(0L), pager.messages.map { it.seq })

        // 值相等的新对象不是"同一条"：它按内容相等也拿到同一个 key（`ChatMessage` 是 data class），
        // 这正是 `restoreLocalMessages` 每次补回来时发生的事 —— 不是新造了一条消息。
        pager.upsert(local.copy())
        assertEquals("等价副本仍只占一行", 1, pager.messages.size)

        // 反过来：文案不同的本地消息必须各自一行（并发两条待发不能互相覆盖）
        val second = ChatMessage(seq = 0L, role = "user", at = BASE_AT + 1, text = "第二条")
        pager.upsert(second)
        assertEquals("内容不同就是两条", 2, pager.messages.size)
        assertEquals(listOf(local, second), pager.messages)
    }

    /** 合成 key 的幂等性跨 `reset` 也成立：换窗口后本地消息被补回来仍只占一行。 */
    @Test
    fun `换窗口后补回本地消息仍然只有一行`() {
        val pager = TranscriptPager()
        val local = ChatMessage(seq = 0L, role = "user", at = BASE_AT, text = "[2 张图片] 两张都看看")

        pager.merge(page(0, 3))
        pager.upsert(local)
        assertEquals(listOf(1L, 2L, 3L, 0L), pager.messages.map { it.seq })

        pager.reset(page(0, 3))
        pager.upsert(local)
        assertEquals("reset 后再补一次：服务端 3 条 + 本地 1 条", 4, pager.messages.size)
        assertEquals("本地消息仍排在最后", 0L, pager.messages.last().seq)
        assertEquals(local, pager.messages.last())
    }

    @Test
    fun `轨迹跳过空消息并让 index 跨消息重置为 0`() {
        val empty = ChatMessage(seq = 1L, role = "assistant", at = BASE_AT, text = "   ")
        val user = ChatMessage(seq = 2L, role = "user", at = BASE_AT, text = "继续")
        val assistant = ChatMessage(
            seq = 3L,
            role = "assistant",
            at = BASE_AT,
            text = "好的",
            toolCalls = listOf(toolCall("pwsh")),
        )

        assertTrue("这条消息确实被判为空", empty.isEmpty)

        val rows = buildTrajectory(listOf(empty, user, assistant))

        assertEquals("空消息不产出任何行", 3, rows.size)
        assertEquals(listOf(2L, 3L, 3L), rows.map { it.seq })
        assertEquals("index 在第二条消息处重置为 0", listOf(0, 0, 1), rows.map { it.index })
        assertEquals(
            listOf(TrajectoryKind.TURN, TrajectoryKind.TOOL, TrajectoryKind.THOUGHT),
            rows.map { it.kind },
        )
    }

    private companion object {
        /** 固定基准时间，避免断言里出现魔法时间戳。 */
        const val BASE_AT = 1_791_463_000_000L
    }
}
