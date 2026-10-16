package com.deepseek.dshremote.data.api

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2.9.0 的两块新投影：**图片引用**（`images[]`）与**轮次索引**（`turn-index`）。
 *
 * 这两块的共同点是"老网关根本没有这些字段"，所以每个用例都要问一遍"缺字段会怎样"：
 * 缺字段必须退化成 emptyList/空索引（界面照旧显示占位、面板显示"取不到轮次列表"），
 * **绝不能**抛异常或把"没有"误读成"没有内容"。
 */
class JsonV2AttachmentsTest {

    private val hex = "3d0e4bafd3ab66872856c9bf7c3c74029660b027eba6c25e0dbf93048dbe9fb9"
    private val otherHex = "aa0e4bafd3ab66872856c9bf7c3c74029660b027eba6c25e0dbf93048dbe9fb9"

    @Test
    fun `消息里的图片引用与轮次号被解析出来`() {
        val json = """
        {
          "seq": 41, "role": "user", "at": 1791463030000, "text": "",
          "turn": 3,
          "images": [
            { "id": "sha256:$hex", "mediaType": "image/png", "width": 1290, "height": 2796,
              "bytes": 538426, "name": "screenshot.png" },
            { "attachmentId": "sha256:$otherHex", "mediaType": "image/jpeg" }
          ],
          "toolCalls": [], "deliverables": []
        }
        """.trimIndent()

        val message = JsonV2.parseMessage(JSONObject(json))
        assertEquals(2, message.images.size)

        val first = message.images[0]
        assertEquals("sha256:$hex", first.id)
        assertEquals("image/png", first.mediaType)
        assertEquals(1290, first.width)
        assertEquals(2796, first.height)
        assertEquals(538426, first.bytes)
        assertEquals("screenshot.png", first.name)
        assertTrue(first.isFetchable)
        assertEquals("screenshot.png", first.label)

        // 网关投影用 `id`，原始事件里嵌套的 `attachmentId` 也认
        assertEquals("sha256:$otherHex", message.images[1].id)
        assertNull(message.images[1].width)
        assertEquals("图片", message.images[1].label)

        assertEquals(3, message.turn)
        // 纯图片轮次的 text 是空串：图片必须算内容，否则整条消息会被界面丢掉
        assertFalse("只有图片的消息不是空消息", message.isEmpty)
    }

    @Test
    fun `缺 images 字段的老网关退化成空列表`() {
        val message = JsonV2.parseMessage(
            JSONObject("""{ "seq": 1, "role": "user", "text": "你好" }"""),
        )
        assertTrue(message.images.isEmpty())
        assertNull(message.turn)
        assertFalse(message.isEmpty)
    }

    @Test
    fun `没有 id 的图片引用被丢掉落而不是留个空壳`() {
        val message = JsonV2.parseMessage(
            JSONObject(
                """
                { "seq": 2, "role": "assistant", "text": "看图",
                  "images": [ { "width": 10, "height": 10 }, { "id": "", "bytes": 1 },
                              { "id": "sha256:$hex" } ] }
                """.trimIndent(),
            ),
        )
        assertEquals(1, message.images.size)
        assertEquals("sha256:$hex", message.images[0].id)
    }

    @Test
    fun `工具结果里的图片进入工具调用`() {
        val call = JsonV2.parseToolCall(
            JSONObject(
                """
                { "id": "call_7", "name": "read_image", "args": {}, "result": "已读取图片",
                  "isError": false, "truncated": false, "durationMs": 12,
                  "images": [ { "id": "sha256:$hex", "mediaType": "image/png", "bytes": 538426 } ] }
                """.trimIndent(),
            ),
        )
        assertEquals(1, call.images.size)
        assertEquals("sha256:$hex", call.images[0].id)
        assertEquals(538426, call.images[0].bytes)
    }

    @Test
    fun `转写页里每条消息各自带自己的图片与轮次号`() {
        val page = JsonV2.parseTranscriptPage(
            """
            {
              "sessionId": "session-1", "total": 2, "nextCursor": null,
              "messages": [
                { "seq": 10, "role": "user", "at": 1, "text": "", "turn": 1,
                  "images": [ { "id": "sha256:$hex", "width": 4, "height": 4 } ] },
                { "seq": 20, "role": "assistant", "at": 2, "text": "收到", "turn": 1 }
              ]
            }
            """.trimIndent(),
        )
        assertEquals(2, page.messages.size)
        assertEquals(1, page.messages[0].images.size)
        assertEquals(1, page.messages[0].turn)
        assertEquals(1, page.messages[1].turn)
        assertTrue(page.messages[1].images.isEmpty())
    }

    @Test
    fun `轮次索引解析条目 按轮号排序 并给出排他游标`() {
        val index = JsonV2.parseTurnIndex(
            """
            {
              "sessionId": "session-1", "total": 2, "totalMessages": 57,
              "turns": [
                { "turn": 9, "fromIndex": 55, "toIndex": 57, "at": 1791468699595,
                  "userText": "帮我把版本号提到 2.9.0", "assistantText": "已改完", "steps": 14, "toolCalls": 6 },
                { "turn": 8, "fromIndex": 0, "toIndex": 54, "at": 1791463029427,
                  "userText": "看看构建為什麼失敗", "assistantText": "", "steps": 3, "toolCalls": 0 }
              ]
            }
            """.trimIndent(),
        )

        assertEquals("session-1", index.sessionId)
        assertEquals(2, index.total)
        assertEquals(57, index.totalMessages)
        assertFalse(index.isEmpty)

        // 服务端顺序不保证：客户端必须自己按轮号排好，否则"最新在最上"会错乱
        assertEquals(listOf(8, 9), index.turns.map { it.turn })

        val last = index.entry(9)!!
        assertEquals(55, last.fromIndex)
        assertEquals(57, last.toIndex)
        assertEquals(2, last.messageCount)
        // 游标 = toIndex（排他上界）：GET /transcript?cursor=57 正好取到"以第 9 轮结尾"的一页
        assertEquals("57", last.cursor)
        assertTrue(index.contains(9))
        assertFalse(index.contains(10))
        assertNull(index.entry(7))
    }

    @Test
    fun `轮次索引的坏输入一律退化成空索引`() {
        assertTrue(JsonV2.parseTurnIndex("不是 JSON").isEmpty)
        assertTrue(JsonV2.parseTurnIndex("""{ "sessionId": "s" }""").isEmpty)
        assertTrue(JsonV2.parseTurnIndex("""{ "turns": [] }""").isEmpty)

        // 轮号 <= 0 的条目直接跳过：0 轮会把"最新在最上"排到最前面，是个坏锚点
        val partial = JsonV2.parseTurnIndex(
            """{ "total": 2, "turns": [ { "turn": 0, "toIndex": 5 }, { "turn": 2, "fromIndex": 6, "toIndex": 9 } ] }""",
        )
        assertEquals(1, partial.turns.size)
        // total 用服务端给的 2，不因为跳过条目而改写服务端的口径
        assertEquals(2, partial.total)
    }

    @Test
    fun `写回缓存再读回来 图片引用与轮次号都不丢`() {
        val original = listOf(
            ChatMessage(
                seq = 41,
                role = "user",
                at = 1791463030000,
                text = "",
                turn = 3,
                images = listOf(
                    ImageRef(
                        id = "sha256:$hex",
                        mediaType = "image/png",
                        width = 1290,
                        height = 2796,
                        bytes = 538426,
                        name = "screenshot.png",
                    ),
                    // 只有 id 的引用：可空字段一个都不该被"补"成默认值
                    ImageRef(id = "sha256:$otherHex"),
                ),
            ),
        )

        val restored = JsonV2.messagesFromJson(JsonV2.messagesToJson(original))

        assertEquals(1, restored.size)
        val message = restored.single()
        assertEquals(3, message.turn)
        assertEquals(listOf(41L), restored.map { it.seq })
        assertEquals(2, message.images.size)
        assertEquals("sha256:$hex", message.images[0].id)
        assertEquals("image/png", message.images[0].mediaType)
        assertEquals(1290, message.images[0].width)
        assertEquals(2796, message.images[0].height)
        assertEquals(538426, message.images[0].bytes)
        assertEquals("screenshot.png", message.images[0].name)
        assertEquals("sha256:$otherHex", message.images[1].id)
        assertNull(message.images[1].width)
        assertNull(message.images[1].name)
        // 离线打开时这条消息必须还在（只有图片的消息不能因为丢字段变成"空消息"）
        assertFalse(message.isEmpty)
    }

    @Test
    fun `写回缓存再读回来 工具调用里的图片也不丢`() {
        val original = listOf(
            ChatMessage(
                seq = 7,
                role = "assistant",
                at = 1791463031000,
                text = "已读取图片",
                turn = 5,
                toolCalls = listOf(
                    ToolCall(
                        id = "call_7",
                        name = "read_image",
                        argsJson = """{"path":"a.png"}""",
                        result = "1080 × 2340 px, 312,799 bytes",
                        isError = false,
                        truncated = false,
                        durationMs = 12,
                        images = listOf(ImageRef(id = "sha256:$hex", mediaType = "image/png", bytes = 312799)),
                    ),
                ),
            ),
        )

        val call = JsonV2.messagesFromJson(JsonV2.messagesToJson(original)).single().toolCalls.single()
        assertEquals("read_image", call.name)
        assertEquals("""{"path":"a.png"}""", call.argsJson)
        assertEquals(1, call.images.size)
        assertEquals("sha256:$hex", call.images[0].id)
        assertEquals(312799, call.images[0].bytes)
    }

    @Test
    fun `没有图片没有轮次号的消息写回缓存后仍是空引用`() {
        val original = listOf(
            ChatMessage(seq = 1, role = "user", at = 0, text = "你好", turn = null),
        )
        val message = JsonV2.messagesFromJson(JsonV2.messagesToJson(original)).single()
        assertTrue(message.images.isEmpty())
        assertTrue(message.toolCalls.isEmpty())
        // 老网关不给 turn ⇒ 往返之后依然是"不知道"，而不是被写成 0
        assertNull(message.turn)
    }
}
