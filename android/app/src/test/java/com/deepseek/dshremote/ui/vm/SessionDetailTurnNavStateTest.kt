package com.deepseek.dshremote.ui.vm

import com.deepseek.dshremote.data.api.ImageLoader
import com.deepseek.dshremote.data.api.TurnIndex
import com.deepseek.dshremote.data.api.TurnIndexEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 轮次导航的**状态层契约**（不起 ViewModel、不碰仓库，理由同 [SessionDetailUiStateTest]：
 * `ConsoleRepository` 需要 Android Context）。
 *
 * 这里钉的是三件在真机上都很难复现、但一错就全错的事：
 * 1. 老网关（没有 turn-index 能力）时不能在顶栏就露出"能跳轮次"的假象；
 * 2. 「跳到第 N 轮」是**一次性信号**，默认必须是 null —— 否则首屏组合时会自己滚到某个历史位置；
 * 3. 轮次总数以服务端口径（`TurnIndex.total`）为准，不是 `turns.size`（服务端可能只给一段窗口）。
 */
class SessionDetailTurnNavStateTest {

    private fun entry(turn: Int, from: Int = 0, to: Int = 1) = TurnIndexEntry(
        turn = turn,
        fromIndex = from,
        toIndex = to,
        at = 1791463029427L,
        userText = "第 $turn 轮的问题",
        assistantText = "第 $turn 轮的回答",
        steps = 3,
        toolCalls = 1,
    )

    private fun index(total: Int, vararg turns: TurnIndexEntry) = TurnIndex(
        sessionId = "session-1",
        total = total,
        totalMessages = 57,
        turns = turns.toList(),
    )

    @Test
    fun `没拉到目录时不给跳转入口也不假装知道轮数`() {
        val ui = SessionDetailViewModel.UiState()

        assertEquals(0, ui.turnCount)
        assertFalse(ui.canJumpTurns)
        assertFalse(ui.turnNavOpen)
        assertNull(ui.turnIndex)
        assertNull(ui.turnIndexError)
    }

    @Test
    fun `只有一轮的会话不值得给跳转`() {
        val ui = SessionDetailViewModel.UiState(turnIndex = index(1, entry(1)))

        assertEquals(1, ui.turnCount)
        assertFalse("一轮没有可跳的目标", ui.canJumpTurns)
    }

    @Test
    fun `两轮以上才出现轮次导航`() {
        val ui = SessionDetailViewModel.UiState(turnIndex = index(3, entry(1), entry(2), entry(3)))

        assertEquals(3, ui.turnCount)
        assertTrue(ui.canJumpTurns)
    }

    @Test
    fun `轮数用服务端口径而不是本地数组长度`() {
        // 服务端只回了一段窗口（turns 数组短），但 total 说这个会话有 42 轮：
        // 面板标题必须写"共 42 轮"，否则用户以为历史只有这么点
        val ui = SessionDetailViewModel.UiState(turnIndex = index(42, entry(40), entry(41), entry(42)))

        assertEquals(42, ui.turnCount)
        assertTrue(ui.canJumpTurns)
    }

    @Test
    fun `跳转信号默认是空的`() {
        val ui = SessionDetailViewModel.UiState()

        assertNull("滚动目标默认必须为空，否则首屏会自己滚走", ui.scrollToSeq)
        assertNull(ui.highlightSeq)
        assertNull(ui.jumpNote)
    }

    @Test
    fun `加载中与失败可以同时被面板读到`() {
        val ui = SessionDetailViewModel.UiState(
            turnNavOpen = true,
            turnIndexLoading = true,
            turnIndexError = "轮次列表加载失败：隧道未连接",
        )

        assertTrue(ui.turnNavOpen)
        assertTrue(ui.turnIndexLoading)
        assertEquals("轮次列表加载失败：隧道未连接", ui.turnIndexError)
        // 失败不关面板：用户要在原地重试
        assertTrue(ui.turnNavOpen)
    }

    @Test
    fun `图片加载器默认是不接网络的空实现`() {
        // 界面参数默认值用 ImageLoader.None：预览/单测里不会 NPE，失败也有可读文案
        assertSame(ImageLoader.None, SessionDetailViewModel.UiState().images)
    }
}
