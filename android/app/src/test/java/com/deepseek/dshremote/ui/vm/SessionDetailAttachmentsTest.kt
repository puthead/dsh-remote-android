package com.deepseek.dshremote.ui.vm

import com.deepseek.dshremote.data.ConsoleRepository
import com.deepseek.dshremote.data.api.PendingImage
import com.deepseek.dshremote.data.api.SessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 待发送图片在 UI state 上的判据：发送键的闸、附件条摘要、发送失败文案。
 *
 * 全部是纯函数/data class，不起 ViewModel、不碰仓库——`ConsoleRepository` 需要 Android
 * Context，真起一个等于把 JVM 单测拖进 Android 环境（与 [SessionDetailUiStateTest] 同一策略）。
 */
class SessionDetailAttachmentsTest {

    private fun image(sizeBytes: Int, name: String = "img.jpg") = PendingImage(
        bytes = ByteArray(sizeBytes),
        mediaType = "image/jpeg",
        name = name,
        width = 800,
        height = 600,
    )

    /**
     * 只能靠 [SessionSummary] 构造：`UiState.writable` 是从 `session.writable` 派生的，
     * 没有可覆写的开关（这是有意的——界面不该绕过服务端下发的可写性）。
     */
    private fun session(writable: Boolean = true) = SessionSummary(
        id = "session-1",
        title = "看图",
        workspace = "D:\\Workspace\\dsh_android",
        cwd = "D:\\Workspace\\dsh_android",
        createdAt = 1791463029427L,
        updatedAt = 1791468699595L,
        turns = 2,
        steps = 249,
        live = true,
        origin = "user",
        agentPreset = "standard",
        bytes = 1598845L,
        eventCount = 1779,
        hasChanges = false,
        changeCount = 0,
        lastTurnState = "ended",
        lastTurnReason = "completed",
        source = SessionSummary.SOURCE_COMPUTER,
        writableFlag = writable,
        writableReasonFlag = if (writable) null else "runtime_gone",
        driverFlag = null,
    )

    private fun state(
        input: String = "",
        images: List<PendingImage> = emptyList(),
        sending: Boolean = false,
        writable: Boolean = true,
        resumable: Boolean = true,
    ) = SessionDetailViewModel.UiState(
        session = session(writable),
        input = input,
        sending = sending,
        resumable = resumable,
        pendingImages = images,
    )

    // ---- 发送键的闸 --------------------------------------------------------

    /**
     * 只选了图、一个字没打：**必须能发**。
     *
     * 这是整个图片功能里最容易回归的一条：把 `canSend` 写成 `input.isNotBlank() && ...`
     * 之后，界面看起来完全正常，只是"发张图问问这是什么"永远点不动。
     */
    @Test
    fun `image_without_text_can_be_sent`() {
        assertTrue(state(images = listOf(image(1024))).canSend)
    }

    @Test
    fun `text_without_image_can_still_be_sent`() {
        assertTrue(state(input = "继续").canSend)
    }

    @Test
    fun `empty_input_and_no_images_cannot_be_sent`() {
        assertFalse(state(input = "   ").canSend)
    }

    @Test
    fun `sending_blocks_even_with_images`() {
        assertFalse(state(images = listOf(image(1024)), sending = true).canSend)
    }

    /** 只读会话（别人的/不可续聊的）即使有图也不能发。 */
    @Test
    fun `read_only_session_cannot_send_images`() {
        assertFalse(state(images = listOf(image(1024)), writable = false).canSend)
    }

    @Test
    fun `non_resumable_session_cannot_send_images`() {
        assertFalse(state(images = listOf(image(1024)), resumable = false).canSend)
    }

    // ---- 附件条摘要 --------------------------------------------------------

    /** 没有图片时摘要必须是空串："没有附件"不该占版面。 */
    @Test
    fun `note_is_empty_without_images`() {
        assertEquals("", state().imageSendNote)
    }

    @Test
    fun `note_counts_images_and_total_size`() {
        val note = state(images = listOf(image(512 * 1024), image(512 * 1024, "b.jpg"))).imageSendNote

        assertTrue("应报张数: $note", note.contains("2 张图片"))
        assertTrue("应报合计体积且带单位: $note", note.contains("MB") || note.contains("KB"))
    }

    /** 单图也要报"1 张"（不是"1 张图片"被静默吞掉或显示成空）。 */
    @Test
    fun `single_image_note_uses_singular_count`() {
        assertTrue(state(images = listOf(image(64 * 1024))).imageSendNote.startsWith("1 张图片"))
    }

    // ---- 待发队列：追加与移除 ----------------------------------------------

    /**
     * 第 5 张必须被**原样挡回**（返回同一个实例）。
     *
     * 调用方靠 `!==` 判定"没加上"，从而给出「一次最多发 4 张图片」；
     * 若这里偷偷 `copy` 出一个新实例，界面会以为加成功了——用户看到 4 张、不知道第 5 张去哪了。
     */
    @Test
    fun `append_at_limit_returns_the_same_instance_untouched`() {
        val full = state(images = listOf(image(1), image(1), image(1), image(1)))
        assertSame(full, SessionDetailViewModel.appendImage(full, image(1, "5.jpg")))
    }

    @Test
    fun `append_adds_one_image_and_updates_the_running_total`() {
        val one = SessionDetailViewModel.appendImage(state(), image(16, "a.jpg"))
        assertEquals(1, one.pendingImages.size)
        assertTrue("应给出已添加提示: ${one.message}", one.message!!.contains("已添加 1 张图片"))
        assertTrue("提示里应带总数: ${one.message}", one.message!!.contains("共 1 张"))
        assertFalse("成功提示不该是错误态", one.isError)

        val two = SessionDetailViewModel.appendImage(one, image(16, "b.jpg"))
        assertTrue("总数应更新: ${two.message}", two.message!!.contains("共 2 张"))
    }

    @Test
    fun `append_reaches_the_limit_but_not_past_it`() {
        assertEquals(4, SessionDetailViewModel.MAX_IMAGES)

        var current = state()
        repeat(SessionDetailViewModel.MAX_IMAGES) { i ->
            current = SessionDetailViewModel.appendImage(current, image(8, "$i.jpg"))
        }
        assertEquals(4, current.pendingImages.size)
        assertSame(current, SessionDetailViewModel.appendImage(current, image(8, "extra.jpg")))
    }

    /** 提示文案要与上限一致，不能出现「最多 4 张」配「共 5 张」这种自相矛盾。 */
    @Test
    fun `limit_message_matches_the_limit_number`() {
        assertTrue(
            "上限提示应含数字 4: ${SessionDetailViewModel.MAX_IMAGES_MESSAGE}",
            SessionDetailViewModel.MAX_IMAGES_MESSAGE.contains("4"),
        )
    }

    @Test
    fun `remove_drops_exactly_the_given_index_and_keeps_order`() {
        val next = SessionDetailViewModel.removeImageAt(
            state(images = listOf(image(1, "a.jpg"), image(1, "b.jpg"), image(1, "c.jpg"))),
            1,
        )
        assertEquals(listOf("a.jpg", "c.jpg"), next.pendingImages.map { it.name })
    }

    /**
     * 越界必须静默忽略：界面可能比状态晚一帧（刚删掉的那张又被点了一次），
     * 这里抛异常就是一次崩溃。
     */
    @Test
    fun `out_of_range_remove_is_ignored_verbatim`() {
        val original = state(images = listOf(image(1), image(1)))
        assertSame(original, SessionDetailViewModel.removeImageAt(original, -1))
        assertSame(original, SessionDetailViewModel.removeImageAt(original, 2))

        // 空队列上点「删除」同样不能炸，也必须原实例返回。
        val empty = state()
        assertSame(empty, SessionDetailViewModel.removeImageAt(empty, 0))

        // 反向哨兵：合法下标必须真的产出新实例，否则上面三条 assertSame 会「空过」。
        assertNotSame(original, SessionDetailViewModel.removeImageAt(original, 0))
    }

    /** 移除只动队列，不顺手清掉别的状态（提示文案还得留着）。 */
    @Test
    fun `remove_does_not_touch_other_state_fields`() {
        val before = state(images = listOf(image(1), image(1)))
            .copy(message = "已添加 1 张图片（共 2 张）", isError = true)
        val after = SessionDetailViewModel.removeImageAt(before, 0)

        assertNotSame(before, after)
        assertEquals(1, after.pendingImages.size)
        assertEquals("已添加 1 张图片（共 2 张）", after.message)
        assertEquals(true, after.isError)
    }

    // ---- 发送失败文案 ------------------------------------------------------

    /**
     * 「离线时不能发送图片」是**完整指引**，不能再套"发送失败："前缀。
     *
     * 套上之后用户会以为是网络抖动，于是反复按发送——而真实原因是「离线状态下根本没带图」，
     * 重试一万次都一样。
     */
    @Test
    fun `offline_image_failure_keeps_its_own_message_without_prefix`() {
        val text = SessionDetailViewModel.sendFailureMessage(
            IllegalArgumentException(ConsoleRepository.IMAGE_OFFLINE_MESSAGE),
        )
        assertEquals(ConsoleRepository.IMAGE_OFFLINE_MESSAGE, text)
        assertFalse("不该带发送失败前缀: $text", text.startsWith("发送失败"))
    }

    /** 其它错误仍然要有前缀，否则用户不知道这是"发送"这一步失败的。 */
    @Test
    fun `other_failures_get_the_send_prefix`() {
        val text = SessionDetailViewModel.sendFailureMessage(IllegalStateException("隧道断了"))
        assertTrue("缺前缀: $text", text.startsWith("发送失败"))
        assertTrue("缺原因: $text", text.contains("隧道断了"))
    }

    /** 同样的文案但类型不是 IllegalArgumentException：不该被误判成那条特例。 */
    @Test
    fun `same_text_with_other_exception_type_still_gets_prefix`() {
        val text = SessionDetailViewModel.sendFailureMessage(
            IllegalStateException(ConsoleRepository.IMAGE_OFFLINE_MESSAGE),
        )
        assertTrue("缺前缀: $text", text.startsWith("发送失败"))
    }
}
