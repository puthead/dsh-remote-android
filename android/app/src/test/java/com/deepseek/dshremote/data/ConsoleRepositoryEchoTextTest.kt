package com.deepseek.dshremote.data

import com.deepseek.dshremote.data.api.ChatMessage
import com.deepseek.dshremote.data.api.ImageRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 本地乐观消息的文案（[ConsoleRepository.echoText]）**与回声去重判据**（[ConsoleRepository.isSameEcho]）。
 *
 * 为什么值得单测：图片本体**不上行到 transcript**（服务端只存文字），本地这条气泡是
 * 用户唯一能确认"图确实跟着发出去了"的东西。文案一旦不标张数，屏幕上就是一条空白气泡，
 * 用户会以为图丢了——而所有网络请求其实都是成功的，没有任何日志会提示这里出了问题。
 *
 * [ConsoleRepository.isSameEcho] 那一组锁的是 m00011（"只发一次却显示两条重复气泡"）：
 * 本地回声带 `[N 张图片]` 前缀、服务端投影只有正文 + 独立 `images` 数组，
 * 两边**字面永远不相等**。一旦这里退回严格相等比较，带图回合的本地气泡就再也摘不掉，
 * 每轮刷新都会在权威投影旁并排留下**第二条一模一样的用户气泡**（纯文本回合文字相等，所以不中招）。
 */
class ConsoleRepositoryEchoTextTest {

    @Test
    fun `text_only_is_unchanged`() {
        assertEquals("继续把测试补完", ConsoleRepository.echoText("继续把测试补完", 0))
    }

    @Test
    fun `image_only_shows_count_marker`() {
        assertEquals("[1 张图片]", ConsoleRepository.echoText("", 1))
    }

    @Test
    fun `text_and_images_marker_comes_first`() {
        assertEquals("[2 张图片] 看看这两张", ConsoleRepository.echoText("看看这两张", 2))
    }

    /** 负数/0 都按"没有附件"处理：不能出现 `[-1 张图片]` 这种脏文案。 */
    @Test
    fun `non_positive_count_never_renders_a_marker`() {
        assertEquals("", ConsoleRepository.echoText("", 0))
        assertEquals("", ConsoleRepository.echoText("", -3))
    }

    // ---------- 回声去重判据（m00011） ----------

    @Test
    fun `纯文本回合：本地回声与服务端投影判为同一条`() {
        val server = userMessage(seq = 26L, at = AT, text = "看看这张")
        val local = localEcho("看看这张")

        assertTrue(ConsoleRepository.isSameEcho(server, local, clientText = "看看这张"))
        // 文案全等时连原话都不用给（老调用方的兜底路径）
        assertTrue(ConsoleRepository.isSameEcho(server, local))
        assertFalse(ConsoleRepository.isSameEcho(server, localEcho("看看那张"), clientText = "看看那张"))
        // 前后空格属于"正文不同"：`sendTurn` 已经把 prompt.trim() 过，这里不该自作主张再归一化
        assertFalse(ConsoleRepository.isSameEcho(server, localEcho(" 看看这张"), clientText = " 看看这张"))
    }

    /**
     * m00011 的主症：**图文回合**。
     *
     * 手机端落的本地文案是 `[1 张图片] 测试手机端图片发送…`，服务端投影是
     * `测试手机端图片发送…` + 一张 image 块。修复前严格相等 ⇒ 永远判不出同一条 ⇒
     * 本地气泡每轮刷新都被补回窗口，屏幕上并排两条一模一样的用户气泡。
     */
    @Test
    fun `图文回合：用原话精确匹配判为同一条`() {
        val prompt = "测试手机端图片发送，图片解析功能，描述图中信息，图片尺寸以及图像大小"
        val server = userMessage(seq = 26L, at = AT + 1_301L, text = prompt, imageCount = 1)
        val local = localEcho(ConsoleRepository.echoText(prompt, 1))

        assertTrue(ConsoleRepository.isSameEcho(server, local, clientText = prompt))
        // 拿不到原话也能合上：第 3 级兜底按 `[N 张图片]` 前缀剥壳后精确相等
        assertTrue("没有原话时靠剥壳兜底", ConsoleRepository.isSameEcho(server, local))
        assertEquals(prompt, ConsoleRepository.echoBody(local.text, 1))
    }

    /**
     * 张数也要对得上：本地写的是 `[2 张图片]`，而服务端那条只带 1 张图 ⇒ 不是同一条
     * （否则会出现"两条待发消息互相顶掉"或者把另一条错摘）。
     */
    @Test
    fun `张数不同不判为同一条`() {
        val prompt = "看看这两张"
        val server = userMessage(seq = 30L, at = AT, text = prompt, imageCount = 1)

        assertFalse(ConsoleRepository.isSameEcho(server, localEcho(ConsoleRepository.echoText(prompt, 2))))
        assertTrue(ConsoleRepository.isSameEcho(server, localEcho(ConsoleRepository.echoText(prompt, 1))))
        assertNull(ConsoleRepository.echoBody("[2 张图片] $prompt", 1))
        assertEquals(prompt, ConsoleRepository.echoBody("[2 张图片] $prompt", 2))
    }

    /**
     * 用户正文**自己**以 `[1 张图片]` 开头时，只要服务端投影的正文与本地那一行**完全相同**，
     * 就还是同一条（两边字面一致，最可靠的判据）。
     *
     * 真正要防的是"文案只差一个前缀"的错认 —— 那必须靠原话或剥壳兜底，
     * 所以下面顺带锁住：文案不一致时不许合并。
     */
    @Test
    fun `正文自带张数前缀时按原话判定不误摘`() {
        val raw = "[1 张图片] 这是用户自己敲的正文"
        val server = userMessage(seq = 31L, at = AT, text = raw, imageCount = 1)
        val local = localEcho(raw)

        assertTrue("字面全等 ⇒ 同一条（原话给不给都一样）", ConsoleRepository.isSameEcho(server, local))
        assertTrue("原话等于服务端正文 ⇒ 同一条", ConsoleRepository.isSameEcho(server, local, clientText = raw))
        // 服务端正文与本地文案不同、原话也不是它 ⇒ 不许合并（宁可多留一条本地气泡）
        val other = userMessage(seq = 32L, at = AT, text = "这是另一句话", imageCount = 1)
        assertFalse(
            "文案与原话都对不上就不合并",
            ConsoleRepository.isSameEcho(other, local, clientText = "这是用户自己敲的正文"),
        )
        // 服务端没带图时原样比：本地那句的 `[N 张图片]` 只能是用户敲的正文
        assertFalse(
            "没带图就不许剥壳",
            ConsoleRepository.isSameEcho(userMessage(33L, AT, "这是用户自己敲的正文"), local, clientText = null),
        )
    }

    /**
     * 纯图片回合：本地是 `[1 张图片]`，服务端正文是网关补的占位文本
     * （`tools/dsh-remote/lib/http.mjs` 的 `TURN_IMAGE_ONLY_TEXT = '（查看这张图片）'`）。
     *
     * 两者文案不同、原话是空串 ⇒ **有意**不判为同一条：本地那条 "1 张图片" 对用户更清楚。
     * 屏幕上只会有一行 —— 那由 `TranscriptPager` 的合成 key 幂等保证（见 `TranscriptPagerTest`）。
     */
    @Test
    fun `纯图片回合：本地标记不与网关占位正文混为一条`() {
        val server = userMessage(seq = 27L, at = AT, text = "（查看这张图片）", imageCount = 1)
        val local = localEcho(ConsoleRepository.echoText("", 1))

        assertFalse(ConsoleRepository.isSameEcho(server, local, clientText = ""))
        assertFalse(ConsoleRepository.isSameEcho(server, local))
    }

    /** 角色不同永不判为同一条：本地回声只可能是 user，别把助手的回答摘掉。 */
    @Test
    fun `角色不同不判为同一条`() {
        val assistant = ChatMessage(seq = 3L, role = "assistant", at = AT, text = "看看这张")
        assertFalse(ConsoleRepository.isSameEcho(assistant, localEcho("看看这张"), clientText = "看看这张"))
    }

    /** 时间窗：服务端投影 `at` 与本机出口时间可能差几秒，但不能跨 10 秒。 */
    @Test
    fun `超过十秒不再判为同一条`() {
        val local = localEcho("看看这张")

        assertTrue(ConsoleRepository.isSameEcho(userMessage(9L, AT + 9_999L, "看看这张"), local, "看看这张"))
        assertFalse(ConsoleRepository.isSameEcho(userMessage(9L, AT + 10_000L, "看看这张"), local, "看看这张"))
        assertTrue(ConsoleRepository.isSameEcho(userMessage(9L, AT - 9_999L, "看看这张"), local, "看看这张"))
    }

    // ---------- 小工具 ----------

    /** 服务端投影出来的一条 user 消息（带图时 `images` 非空，正文不含张数前缀）。 */
    private fun userMessage(seq: Long, at: Long, text: String, imageCount: Int = 0): ChatMessage =
        ChatMessage(
            seq = seq,
            role = "user",
            at = at,
            text = text,
            images = List(imageCount) { ImageRef(id = "sha256:" + "0".repeat(64)) },
        )

    /** 本地乐观消息：`seq = 0`（约定），文案就是 [ConsoleRepository.echoText] 的产物。 */
    private fun localEcho(text: String): ChatMessage =
        ChatMessage(seq = 0L, role = "user", at = AT, text = text)

    private companion object {
        /** 固定基准时间，避免断言里出现魔法时间戳。 */
        const val AT = 1_792_112_081_000L
    }
}
