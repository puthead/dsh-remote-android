package com.deepseek.dshremote.data.api

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 续聊带图：**上行请求体的字节形状**（冻结协议 §4.2 的 `content` 数组）。
 *
 * 为什么必须有这份测试：字段名与编码方式是网关侧定死的，写错一个字
 * ——`images` 而不是 `content`、`base64` 而不是 `data`、URL-safe 或换行版 base64——
 * 客户端自己一路全绿：压缩成功、缩略图在、发送键亮着，直到服务端回 400 才知道。
 * 所以这里不看行为，直接钉死 JSON 形状。
 *
 * 走 [DshApiV2.turnBodyJson] 这个真实的组装函数，而不是在测试里手拼一份 JSON
 * ——手拼只能证明测试作者会拼 JSON。
 */
class PostTurnImagesTest {

    /** 1x1 PNG 的头 8 字节：网关不解码像素，字节内容只要能无损往返就够。 */
    private val pngMagic = byteArrayOf(
        0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    )

    private fun image(
        bytes: ByteArray,
        mediaType: String = "image/png",
        name: String = "img.png",
    ) = PendingImage(
        bytes = bytes,
        mediaType = mediaType,
        name = name,
        width = 1,
        height = 1,
    )

    /**
     * 默认 **prompt 为空**，让 `content[0]` 就是 image 块（[DshApiV2.turnContent] 只在
     * prompt 非空时才写 text 块）。需要"文字 + 图片"的用例显式传 prompt，
     * 并且**必须**用 [imageBlock] 取块 —— 这条踩过一次：
     * 早期这组用例一律读 `getJSONObject(0)`，而默认 prompt 非空时 `content[0]` 是
     * **text** 块，于是 `data`/`mediaType` "凭空消失"，看着像生产代码把字段丢了，
     * 实际是断言读错了块（`type`/`mediaType` 只在空 prompt 的用例里侥幸对上）。
     */
    private fun body(
        images: List<PendingImage> = emptyList(),
        prompt: String = "",
    ) = JSONObject(DshApiV2.turnBodyJson(prompt, "turn-1", images))

    private fun contentOf(images: List<PendingImage>, prompt: String = ""): JSONArray =
        body(images, prompt).getJSONArray("content")

    /** 按 `type` 取块，不靠下标：块顺序本身另有专门用例钉着。 */
    private fun JSONArray.imageBlock(): JSONObject = firstBlock("image")

    private fun JSONArray.textBlock(): JSONObject = firstBlock("text")

    private fun JSONArray.firstBlock(type: String): JSONObject {
        for (i in 0 until length()) {
            val block = getJSONObject(i)
            if (block.getString("type") == type) return block
        }
        throw AssertionError("content 里没有 type=$type 的块：$this")
    }

    // ---- 只发图片 ----------------------------------------------------------

    /**
     * 一句话都不打、只发图：`content` 里**只有** image 块，不写空的 text 块。
     *
     * 空 text 块会让上游多出一条空消息；占位文本按冻结协议由网关侧补。
     */
    @Test
    fun `image_only_body_has_no_text_block`() {
        val content = contentOf(listOf(image(pngMagic)), prompt = "")

        assertEquals("只发图片时 content 应只有一个 image 块", 1, content.length())
        assertEquals("image", content.getJSONObject(0).getString("type"))
        assertEquals("image/png", content.getJSONObject(0).getString("mediaType"))
    }

    /** 只发图片时 `prompt` 仍必须是空串（不是 null、不是缺字段）。 */
    @Test
    fun `image_only_body_keeps_empty_prompt_string`() {
        val json = body(listOf(image(pngMagic)), prompt = "")
        assertTrue("prompt 应存在且为空串", json.has("prompt"))
        assertEquals("", json.getString("prompt"))
    }

    // ---- 文字 + 图片 ------------------------------------------------------

    /** 顺序固定：**先 text 再 image**（网关按同一份实现透传，顺序错上游语义就变了）。 */
    @Test
    fun `text_block_comes_first_then_images_in_order`() {
        val content = contentOf(
            listOf(
                image(byteArrayOf(1, 2, 3), name = "a.png"),
                image(byteArrayOf(4, 5, 6, 7), mediaType = "image/jpeg", name = "b.jpg"),
            ),
            prompt = "看看这张图",
        )

        assertEquals(3, content.length())
        assertEquals("text", content.getJSONObject(0).getString("type"))
        assertEquals("看看这张图", content.getJSONObject(0).getString("text"))
        assertEquals("image", content.getJSONObject(1).getString("type"))
        assertEquals("a.png", content.getJSONObject(1).getString("name"))
        assertEquals("image", content.getJSONObject(2).getString("type"))
        assertEquals("image/jpeg", content.getJSONObject(2).getString("mediaType"))
        assertEquals("b.jpg", content.getJSONObject(2).getString("name"))
    }

    /**
     * 有文字时，image 块仍在 `content` 里且字段齐全（顺序由上面那条钉着）。
     *
     * 这条是"读错块"事故的回归哨兵：它用 [imageBlock] 按 `type` 找块，
     * 无论 text 在前还是在后都成立。
     */
    @Test
    fun `image_block_is_present_even_when_a_text_block_comes_first`() {
        val block = contentOf(listOf(image(byteArrayOf(1, 2, 3))), prompt = "带一句话的图").imageBlock()

        assertEquals("image", block.getString("type"))
        assertEquals("image/png", block.getString("mediaType"))
        assertEquals("img.png", block.getString("name"))
        assertEquals("data 必须在这里", "AQID", block.getString("data"))
    }

    /**
     * base64 的编码器锁：必须是**标准字母表、无换行、无 `data:` 前缀**。
     *
     * `android.util.Base64` 默认带换行、URL_SAFE 用 `-` `_`，网关用标准 base64 解，
     * 两者都是 400。这条测试直接解回来对字节。
     */
    @Test
    fun `data_is_bare_standard_base64_without_wrap_or_prefix`() {
        val raw = ByteArray(200) { (it * 7 % 256).toByte() }
        val encoded = contentOf(listOf(image(raw)), prompt = "看看这张图").imageBlock().getString("data")

        assertFalse("不该有换行", encoded.contains("\n"))
        assertFalse("不该有回车", encoded.contains("\r"))
        assertFalse("不该带 data: 前缀", encoded.startsWith("data:"))
        assertFalse("不该是 URL-safe 变体", encoded.contains('-') || encoded.contains('_'))
        assertTrue("字节应当无损往返", raw.contentEquals(java.util.Base64.getDecoder().decode(encoded)))
    }

    // ---- 向后兼容：无图路径不能漂移 -----------------------------------------

    /**
     * 无图时**逐字节等于加图片功能之前的请求体**：没有 `content` 字段。
     *
     * 旧网关不认识 `content`，凭空多一个字段就是行为漂移。
     */
    @Test
    fun `no_images_keeps_legacy_body_shape_exactly`() {
        val json = DshApiV2.turnBodyJson("看看这张图", "turn-1")
        assertEquals("""{"prompt":"看看这张图","clientTurnId":"turn-1"}""", json)
    }

    /** 空 prompt 且无图：仍然是老形状（是否允许发由客户端 UI 那道闸决定，不在这里兜底）。 */
    @Test
    fun `empty_prompt_without_images_also_has_no_content`() {
        val json = DshApiV2.turnBodyJson("", "turn-1")
        assertEquals("""{"prompt":"","clientTurnId":"turn-1"}""", json)
    }

    // ---- 可选字段 ---------------------------------------------------------

    /** `name` 为空时不写这个键——老安卓取 MEDIA_DISPLAY_NAME 可能拿到空串。 */
    @Test
    fun `blank_name_is_omitted`() {
        val block = contentOf(listOf(image(pngMagic, name = "")), prompt = "看看这张图").imageBlock()

        assertFalse("空 name 不该出现在请求体里", block.has("name"))
        assertTrue("data / mediaType 必须还在", block.has("data") && block.has("mediaType"))
    }

    /** prompt 里的引号/换行/中文都必须被 JSON 转义成合法字符串。 */
    @Test
    fun `prompt_escaping_survives_json_round_trip`() {
        val tricky = "第一行\n第二行 \"引号\" \\反斜杠"
        val content = contentOf(listOf(image(pngMagic)), prompt = tricky)

        assertEquals("转义后应当还原出原文", tricky, body(listOf(image(pngMagic)), tricky).getString("prompt"))
        assertEquals(tricky, content.textBlock().getString("text"))
    }

    // ---- 整包预算：1 MiB 是**整个请求体**，不是单图 ---------------------------

    /**
     * 4 张 700 KiB 的图（每张 `ImagePayloads.MAX_COMPRESSED_BYTES`）必须被判超预算。
     *
     * 这是任务描述里"最多 4 张图"最容易骗人的地方：4 × 700 KiB 原始 → base64 后
     * ≈ 2.86 MiB，远超 1 MiB 的整个请求体上限。单图校验全绿、张数校验也全绿，
     * 只有把**整包**量出来才发现根本发不出去（实测 1_048_640 B 时连接被直接关闭）。
     */
    @Test
    fun `four_max_images_blow_the_request_body_budget`() {
        val max = ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES)
        val json = DshApiV2.turnBodyJson("看看这四张", "turn-1", List(4) { image(max, name = "m$it.jpg") })
        val bytes = DshApiV2.utf8Length(json)

        assertFalse(
            "4 张满预算的图不该被判在预算内（实际 $bytes 字节）",
            DshApiV2.bodyWithinBudget(bytes, imageCount = 4),
        )
        // 连 1 MiB 的硬边界也过不去——两层判据都该拦
        assertFalse(DshApiV2.bodyWithinLimit(bytes))
    }

    /**
     * **一张**满预算的图必须能发。
     *
     * 这条是防"预算写得太死"的哨兵：700 KiB 的图 base64 后是 955_736 字节，
     * **本身就超过 900 KiB 的整包预算**。若把单图也按 900 KiB 卡，
     * `ImagePayloads` 那套"压到 700 KiB 就能发"的降档阶梯会在发送这一步被自己拦下
     * ——压缩器额定的输出发不出去。所以单图走的是实测硬边界减余量那条线。
     *
     * 这条**真的红过**：余量最初按"700 KiB 原始"估成 96 KiB / 94 KiB，都低估了
     * base64 的 4/3 膨胀，实测 body 是 955_885 B，两条线（950_272 / 952_320）都拦下了它。
     * 断言里带上实测字节数，就是为了下次再有人调这个数时能一眼看出差多少。
     */
    @Test
    fun `one_max_image_still_fits`() {
        val max = ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES)
        val json = DshApiV2.turnBodyJson("看看这张", "turn-1", listOf(image(max, name = "m.jpg")))
        val bytes = DshApiV2.utf8Length(json)

        assertTrue(
            "单张满预算的图必须能发，实际 $bytes 字节（单图线 ${DshApiV2.SINGLE_IMAGE_BUDGET_BYTES}）",
            DshApiV2.bodyWithinBudget(bytes, imageCount = 1),
        )
        assertTrue(
            "而且真实字节数还要小于实测硬边界 1 MiB",
            DshApiV2.bodyWithinLimit(bytes),
        )
    }

    /** 两张满预算的图必须出局（1.9 MiB）：单图那条线不能顺手把两张也放过去。 */
    @Test
    fun `two_max_images_are_rejected`() {
        val max = ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES)
        val json = DshApiV2.turnBodyJson("看看这两张", "turn-1", List(2) { image(max, name = "m$it.jpg") })
        val bytes = DshApiV2.utf8Length(json)

        assertFalse(
            "两张满预算的图不该在预算内（实际 $bytes 字节）",
            DshApiV2.bodyWithinBudget(bytes, imageCount = 2),
        )
    }

    /**
     * 边界两侧各钉一次：`<=` 而不是 `<`。
     *
     * 差一个字节就决定用户能不能发出这张图，所以两条线都验；一旦有人把判定改成估算
     * （`approxBase64Chars` 求和）或把 `<=` 写成 `<`，这条会立刻红。
     */
    @Test
    fun `budget_boundaries_are_inclusive`() {
        assertTrue(DshApiV2.bodyWithinLimit(DshApiV2.MAX_BODY_CHARS))
        assertFalse(DshApiV2.bodyWithinLimit(DshApiV2.MAX_BODY_CHARS + 1))

        assertTrue(DshApiV2.singleImageWithinLimit(DshApiV2.SINGLE_IMAGE_BUDGET_BYTES))
        assertFalse(DshApiV2.singleImageWithinLimit(DshApiV2.SINGLE_IMAGE_BUDGET_BYTES + 1))

        assertTrue(DshApiV2.bodyWithinBudget(DshApiV2.IMAGE_BUDGET_CHARS, imageCount = 2))
        assertFalse(DshApiV2.bodyWithinBudget(DshApiV2.IMAGE_BUDGET_CHARS + 1, imageCount = 2))

        // 无图时只看 1 MiB 硬边界：此时 body 就是 {"prompt":…,"clientTurnId":…}
        assertTrue(DshApiV2.bodyWithinBudget(DshApiV2.MAX_BODY_CHARS, imageCount = 0))
        assertFalse(DshApiV2.bodyWithinBudget(DshApiV2.MAX_BODY_CHARS + 1, imageCount = 0))
    }

    /**
     * 量的是 **UTF-8 字节**，不是 `String.length`。
     *
     * 网关卡在网络层收到的字节上，中文一个字 3 字节。若按字符数量，一段中文长文会被
     * 低估到 1/3，正好落进实测窗口（1_048_500 通过 / 1_048_640 关闭）——"本地判过、
     * 网关断连"是最难查的一类失败。
     */
    @Test
    fun `budget_measures_utf8_bytes_not_utf16_length`() {
        val chinese = "图".repeat(1000)
        val json = DshApiV2.turnBodyJson(chinese, "turn-1")

        assertEquals("按字符数是 1000+壳，按字节数是 3 倍", 3000 + (json.length - 1000), DshApiV2.utf8Length(json))
        assertTrue("UTF-8 字节数必须大于 String.length", DshApiV2.utf8Length(json) > json.length)
    }

    /** 超预算的文案要能指导用户：得报出**本次合计**、**上限**，并说清该做什么。 */
    @Test
    fun `budget_message_states_actual_total_limit_and_fix`() {
        val text = DshApiV2.imagesBudgetMessage(bodyBytes = 2_936 * 1024, count = 4)

        assertTrue("应报出本次合计: $text", text.contains("2936 KB"))
        assertTrue("应报出上限: $text", text.contains("900 KB"))
        assertTrue("应报出张数: $text", text.contains("4 张"))
        assertTrue("应给出改法: $text", text.contains("减少张数") && text.contains("压缩"))
    }

    /** 多图文案里的上限必须与常量同源，不能手写一个会漂移的数字。 */
    @Test
    fun `budget_message_limit_matches_the_constant`() {
        assertTrue(DshApiV2.imagesBudgetMessage(1, 2).contains("${DshApiV2.IMAGE_BUDGET_CHARS / 1024} KB"))
    }

    /** 单图文案报的是单图那条线（不是 900 KB），否则用户会以为压缩到 900 KB 就该能发。 */
    @Test
    fun `single_image_message_reports_the_single_image_line`() {
        val text = DshApiV2.imagesBudgetMessage(1_000_000, 1)
        val expected = DshApiV2.SINGLE_IMAGE_BUDGET_BYTES / 1024
        assertTrue("单图文案应报 $expected KB: $text", text.contains("$expected KB"))
    }

    // ---- 发送前的预算判据（幽灵消息闸门）------------------------------------

    /** 没有图：一律放行（判据根本不该参与纯文本发送）。 */
    @Test
    fun `precheck_passes_no_images`() {
        assertNull(DshApiV2.imagesBudgetPrecheck("随便说点什么", emptyList()))
    }

    /**
     * 一张满预算（700 KiB 压缩上限）的合法单图：**必须放行**。
     *
     * 单图走 [DshApiV2.SINGLE_IMAGE_BUDGET_BYTES] 那条线，而它的 base64 后就有 955_736 B、
     * 比多图线（900 KiB）还高。若前置判据错用多图线，`ImagePayloads` 那套"压到 700 KiB 就能发"
     * 的降档阶梯会在发送时被自己拦死——压缩器额定的输出发不出去，是自相矛盾的。
     */
    @Test
    fun `precheck_passes_one_max_sized_image`() {
        val one = image(ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES))
        assertNull("合法的满预算单图不得被前置判据误杀", DshApiV2.imagesBudgetPrecheck("", listOf(one)))
    }

    /**
     * 两张**各自都远没到 700 KiB** 的图，合起来越过整包预算 → 提前拦下，并给出可读文案。
     *
     * 这是真实最容易撞的一条路：用户连选 2–4 张相册图，每张都合法；不拦的话先落一条
     * `[2 张图片] …` 幽灵气泡、紧接着才报失败。
     */
    @Test
    fun `precheck_blocks_two_images_over_the_whole_request_budget`() {
        // 每张 base64 后 ≈ 4/3 × (700 KiB/2 + 4 KiB) ≈ 478 KiB，两张 ≈ 956 KiB > 900 KiB
        val half = ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES / 2 + 4096)
        val reason = DshApiV2.imagesBudgetPrecheck("看这两张", listOf(image(half), image(half, name = "b.png")))

        assertNotNull("两张合计超预算必须被拦下", reason)
        assertTrue("文案应给上限: $reason", reason!!.contains("${DshApiV2.IMAGE_BUDGET_CHARS / 1024} KB"))
        assertTrue("文案应报张数: $reason", reason.contains("2 张"))
    }

    /**
     * 前置判据与真判据**逐字节同源**：`precheck == null` ⟺ `bodyWithinBudget(bodyBytes)`。
     *
     * 这条是本组存在的理由。第一版前置判据拿 `Σ approxBase64Chars` 跟预算比（不含 JSON 壳与文本），
     * 于是出现"估算过线、真实 body 没超"的放行 —— 放行了真判据不接受的东西，
     * 也就是把幽灵消息从"响两次"变成"必失败"，比原缺陷更糟。
     */
    @Test
    fun `precheck_agrees_with_the_real_gate_byte_for_byte`() {
        val cases = listOf(
            emptyList(),
            listOf(image(ByteArray(8 * 1024))),
            listOf(image(ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES))),
            listOf(image(ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES / 2)), image(ByteArray(8 * 1024), name = "b.png")),
            listOf(image(ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES / 2 + 4096)), image(ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES / 2 + 4096), name = "b.png")),
            listOf(image(ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES)), image(ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES), name = "b.png")),
        )
        for (images in cases) {
            val bodyBytes = DshApiV2.utf8Length(DshApiV2.turnBodyJson("看看这些图", "turn-1", images))
            val realGate = DshApiV2.bodyWithinBudget(bodyBytes, images.size)
            val precheck = DshApiV2.imagesBudgetPrecheck("看看这些图", images)
            assertEquals(
                "前置判据与真判据不一致（${images.size} 张，body $bodyBytes B）",
                realGate,
                precheck == null,
            )
        }
    }

    /**
     * 前置判据的边界严格沿用真判据：`body == 上限` 放行，多 1 字节就拒。
     *
     * 直接从常量反推一张图的字节数，而不是写会漂移的魔数：多图线判的是
     * `bodyBytes ≤ IMAGE_BUDGET_CHARS`，而 body ≈ Σ ceil(n/3)×4 + 壳，壳只有几十字节，
     * 所以"sum 略低于预算"与"sum 略高于预算"两张图就能把边界两侧都钉住。
     */
    @Test
    fun `precheck_boundary_follows_the_real_gate`() {
        val justUnder = (DshApiV2.IMAGE_BUDGET_CHARS / 4) * 3 / 2 - 2048
        val pass = listOf(image(ByteArray(justUnder)), image(ByteArray(justUnder), name = "b.png"))
        assertNull("明显在预算内必须放行", DshApiV2.imagesBudgetPrecheck("边界", pass))

        val justOver = (DshApiV2.IMAGE_BUDGET_CHARS / 4) * 3 / 2 + 2048
        val reject = listOf(image(ByteArray(justOver)), image(ByteArray(justOver), name = "b.png"))
        assertNotNull("明显超预算必须拒绝", DshApiV2.imagesBudgetPrecheck("边界", reject))
    }
}
