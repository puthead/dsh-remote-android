package com.deepseek.dshremote.ui.vm

import com.deepseek.dshremote.data.ApiException
import com.deepseek.dshremote.data.api.DshApiV2
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 带图片续聊会遇到的两类错误，翻译成人话之后**必须可行动**。
 *
 * 背景：一条 700 KiB 的图 base64 之后 ≈ 933 KB，而中继与网关的单请求体上限都是 1 MiB
 * （`tools/dsh-relay/lib/config.mjs:69`、`tools/dsh-remote/lib/config.mjs:216`）。
 * 一旦超限，服务端只会回一句 HTTP 413 —— 用户看到"413"没有任何办法自己解决；
 * 而"精简任务描述"这种通用建议在图片场景下是**错误指引**：用户此刻手里有的是图片，
 * 让他去改文字等于没给出路，只会让他反复重试同一条必然失败的消息。
 */
class ErrorMessagesImageTest {

    /** 网关带 code 回 413：文案必须点明"图太大"并给出两条出路。 */
    @Test
    fun `payload_too_large_code_explains_images_and_next_step`() {
        val text = ApiException(
            code = "payload_too_large",
            message = "request entity too large",
            httpStatus = 413,
        ).friendlyMessage()

        assertTrue("应说清是图片问题: $text", text.contains("图片太大"))
        assertTrue("应给出体积上限: $text", text.contains("1 MB"))
        assertTrue("应给出换小图/减张数的出路: $text", text.contains("更小的图") || text.contains("减少图片数量"))
        assertFalse("不该给'精简任务描述'这种错误指引: $text", text.contains("精简"))
    }

    /** 网关只回状态码 413、没给 code：走 HTTP 状态兜底，文案同样可行动。 */
    @Test
    fun `http_413_without_code_falls_back_to_the_same_guidance`() {
        val text = ApiException(
            code = "unknown",
            message = "Payload Too Large",
            httpStatus = 413,
        ).friendlyMessage()

        assertTrue("应说清是图片问题: $text", text.contains("图片太大"))
        assertTrue("应给出上限: $text", text.contains("1 MB"))
        assertTrue("应带可搜索的状态标记: $text", text.contains("413"))
    }

    /** 客户端侧常量与错误映射必须说同一句话（两处各写一份必然会漂移）。 */
    @Test
    fun `client_constant_and_error_mapping_agree_on_the_limit`() {
        assertTrue(
            "DshApiV2.IMAGE_TOO_LARGE_MESSAGE 也必须点明 1 MB 上限",
            DshApiV2.IMAGE_TOO_LARGE_MESSAGE.contains("1 MB"),
        )
        assertTrue(DshApiV2.IMAGE_TOO_LARGE_MESSAGE.contains("图片太大"))
    }

    // ---- 400：图片校验失败不能套用"检查工作区白名单" ------------------------

    /**
     * 网关对图片的 400 校验（mediaType 不在白名单 / base64 解不开 / 张数超 4）
     * 只有网关知道是哪一个，客户端任何通用建议都是瞎猜 —— 原样透出。
     */
    @Test
    fun `image_bad_request_is_passed_through_without_workspace_advice`() {
        val text = ApiException(
            code = "bad_request",
            message = "第 2 张图片的 mediaType 必须是 image/png|jpeg|webp|gif",
            httpStatus = 400,
        ).friendlyMessage()

        assertEquals("第 2 张图片的 mediaType 必须是 image/png|jpeg|webp|gif", text)
    }

    /** 英文措辞的图片 400（网关有中英两套文案）同样不该被套上"检查白名单"。 */
    @Test
    fun `english_image_bad_request_is_passed_through_too`() {
        val text = ApiException(
            code = "bad_request",
            message = "image data is not valid base64 (image/jpeg, 933 KB)",
            httpStatus = 400,
        ).friendlyMessage()

        assertFalse("不该套工作区建议: $text", text.contains("白名单"))
    }

    /** 回归保护：非图片的 bad_request 仍然要给出「检查白名单/配对」的指引。 */
    @Test
    fun `non_image_bad_request_keeps_the_workspace_hint`() {
        val text = ApiException(
            code = "bad_request",
            message = "缺少 workspace",
            httpStatus = 400,
        ).friendlyMessage()

        assertTrue("缺通用指引: $text", text.contains("白名单") || text.contains("配对"))
    }

    /** v2.1.0 的 host 校验：网关的 message 本身就是可执行的，不要再补。 */
    @Test
    fun `host_bad_request_is_passed_through`() {
        val raw = "非法 host：只允许 phone 或 computer"
        assertEquals(
            raw,
            ApiException(code = "bad_request", message = raw, httpStatus = 400).friendlyMessage(),
        )
    }
}
