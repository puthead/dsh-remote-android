package com.deepseek.dshremote.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 契约 §4.2 / §4.3 的 JSON 反序列化。
 *
 * 重点：中文与 emoji **原样保留**（网关是 UTF-8，不经任何转义），
 * 以及两类会话（电脑镜像 / 手机任务）的来源判定。
 */
class JsonV2Test {

    private val sessionsJson = """
    {
      "sessions": [
        {
          "id": "session-88e9459c-1111", "title": "远程控制台开发 🚀",
          "workspace": "D:\\Workspace\\dsh_android", "cwd": "D:\\Workspace\\dsh_android",
          "createdAt": 1791463029427, "updatedAt": 1791468699595,
          "turns": 2, "steps": 249, "lastTurn": { "state": "ended", "reason": "completed" },
          "live": true, "origin": "user", "agentPreset": "standard", "source": "computer",
          "bytes": 1598845, "eventCount": 1779, "hasChanges": true, "changeCount": 7
        },
        {
          "id": "sdk-0001", "title": "手机派活", "workspace": "D:\\Workspace\\dsh_android",
          "createdAt": 1791463029427, "updatedAt": 1791468699595, "turns": 1,
          "live": false, "origin": "user", "source": "phone", "steps": 3
        },
        {
          "id": "sdk-0002", "title": "老网关没给 source",
          "workspace": "D:\\Workspace\\other", "updatedAt": 1791468000000, "origin": "user"
        }
      ],
      "nextCursor": null
    }
    """.trimIndent()

    @Test
    fun `会话列表解析保留中文与 emoji 并区分来源`() {
        val sessions = JsonV2.parseSessions(sessionsJson)
        assertEquals(3, sessions.size)

        val computer = sessions[0]
        assertEquals("远程控制台开发 🚀", computer.title)
        assertEquals("D:\\Workspace\\dsh_android", computer.workspace)
        assertEquals("dsh_android", computer.workspaceLabel)
        assertTrue(computer.live)
        assertEquals("completed", computer.lastTurnReason)
        assertTrue(computer.hasChanges)
        assertEquals(7, computer.changeCount)
        assertTrue(computer.isComputerSession)
        assertFalse("电脑镜像会话手机不可写", computer.writable)
        assertEquals("电脑", computer.sourceLabel)

        val phone = sessions[1]
        assertTrue(phone.isPhoneTask)
        assertTrue("手机任务必须可写", phone.writable)
        assertEquals("手机", phone.sourceLabel)

        // 老网关漏字段时默认按电脑镜像处理（镜像接口的语义），不会误判成可写
        assertTrue(sessions[2].isComputerSession)
    }

    @Test
    fun `来源字段的兼容探测`() {
        assertEquals(SessionSummary.SOURCE_PHONE, JsonV2.parseSource(org.json.JSONObject("""{"source":"phone"}""")))
        assertEquals(SessionSummary.SOURCE_PHONE, JsonV2.parseSource(org.json.JSONObject("""{"driver":"gateway"}""")))
        assertEquals(SessionSummary.SOURCE_PHONE, JsonV2.parseSource(org.json.JSONObject("""{"phoneTask":true}""")))
        assertEquals(SessionSummary.SOURCE_COMPUTER, JsonV2.parseSource(org.json.JSONObject("""{"source":"computer"}""")))
        assertEquals(SessionSummary.SOURCE_COMPUTER, JsonV2.parseSource(org.json.JSONObject("""{"source":"mirror"}""")))
        assertEquals(SessionSummary.SOURCE_COMPUTER, JsonV2.parseSource(org.json.JSONObject("""{}""")))
    }

    @Test
    fun `transcript 解析出工具调用 交付物 与错误标记`() {
        val json = """
        {
          "sessionId": "session-1",
          "messages": [
            { "seq": 12, "role": "user", "at": 1791463030000, "text": "帮我看看构建失败的原因 😅",
              "toolCalls": [], "deliverables": [] },
            { "seq": 40, "role": "assistant", "at": 1791463040000, "text": "定位到 AGP 版本不匹配…",
              "toolCalls": [
                { "id": "call_1", "name": "pwsh", "args": { "command": "gradlew :app:assembleDebug" },
                  "result": "BUILD SUCCESSFUL", "isError": false, "truncated": false, "durationMs": 8420 },
                { "id": "call_2", "name": "read", "args": { "path": "app/build.gradle.kts" },
                  "result": "ENOENT: no such file", "isError": true, "truncated": true, "durationMs": 12 }
              ],
              "deliverables": [ { "path": "android/app/build/outputs/apk/release/app-release.apk", "description": "release 包" } ] }
          ],
          "nextCursor": "c1"
        }
        """.trimIndent()

        val messages = JsonV2.parseMessages(json)
        assertEquals(2, messages.size)
        assertEquals("帮我看看构建失败的原因 😅", messages[0].text)
        assertTrue(messages[0].isUser)

        val assistant = messages[1]
        assertTrue(assistant.isAssistant)
        assertEquals("定位到 AGP 版本不匹配…", assistant.text)
        assertEquals(2, assistant.toolCalls.size)

        val first = assistant.toolCalls[0]
        assertEquals("pwsh", first.name)
        assertEquals("gradlew :app:assembleDebug", first.args?.optString("command"))
        assertFalse(first.isError)
        assertEquals(8420L, first.durationMs)
        assertEquals("gradlew :app:assembleDebug", first.argsSummary)

        val second = assistant.toolCalls[1]
        assertTrue("isError 必须被解析出来（UI 要画红边）", second.isError)
        assertTrue(second.truncated)

        assertEquals(1, assistant.deliverables.size)
        assertEquals("release 包", assistant.deliverables[0].description)
    }

    /**
     * 分页字段的**原始形态**必须被保住：`JsonV2` 是唯一能看到"字段缺失"这回事的地方。
     *
     * `"nextCursor": null`（服务端说已到最早）与整个字段不在（老网关不表态）经 `optString`
     * 读出来都是空串，只有 `has("nextCursor")` 能分开；混淆这两者会让向上翻页要么永久失效、
     * 要么在同一页上空转（真机实测重复请求 8 次）。
     */
    @Test
    fun `transcript 分页页区分字段缺失与显式 null`() {
        val withCursor = JsonV2.parseTranscriptPage(
            """{ "sessionId": "s", "messages": [], "nextCursor": "160", "total": 220, "from": 160, "to": 220 }""",
        )
        assertEquals("160", withCursor.nextCursor)
        assertTrue("字段在 ⇒ 服务端表过态", withCursor.cursorProvided)
        assertEquals(220, withCursor.total)
        assertEquals(160, withCursor.from)
        assertEquals(220, withCursor.to)

        val explicitNull = JsonV2.parseTranscriptPage(
            """{ "sessionId": "s", "messages": [], "nextCursor": null, "total": 220, "from": 0, "to": 40 }""",
        )
        assertNull(explicitNull.nextCursor)
        assertTrue("显式 null 也是表态：已到最早", explicitNull.cursorProvided)
        assertFalse("已到最早 ⇒ 没有更早的页", explicitNull.hasMoreOlder)

        val oldGateway = JsonV2.parseTranscriptPage("""{ "sessionId": "s", "messages": [] }""")
        assertNull(oldGateway.nextCursor)
        assertFalse("字段压根不在 ⇒ 老网关没表态，不能当成已到最早", oldGateway.cursorProvided)

        // 坏 JSON / 缺 messages：退化成"没表态"的空页，不抛异常打断界面
        assertFalse(JsonV2.parseTranscriptPage("not json").cursorProvided)
        assertFalse(JsonV2.parseTranscriptPage("""{ "sessionId": "s" }""").cursorProvided)
    }

    @Test
    fun `消息按 seq 排序且非法条目不会让整页失败`() {
        val json = """
        { "messages": [
            { "seq": 30, "role": "assistant", "text": "b" },
            { "seq": 10, "role": "user", "text": "a" }
        ] }
        """.trimIndent()
        val messages = JsonV2.parseMessages(json)
        assertEquals(listOf(10L, 30L), messages.map { it.seq })

        assertEquals("非法 JSON 返回空列表而不是抛异常", emptyList<ChatMessage>(), JsonV2.parseMessages("<html>502</html>"))
    }

    @Test
    fun `工作区目录树 entries 排序为目录优先`() {
        val json = """
        { "workspace": "D:\\W", "path": "D:\\W",
          "entries": [
            { "name": "b.txt", "path": "D:\\W\\b.txt", "type": "file", "size": 12, "modifiedAt": 1 },
            { "name": "android", "path": "D:\\W\\android", "type": "dir", "size": null, "modifiedAt": 2 },
            { "name": "a.txt", "path": "D:\\W\\a.txt", "type": "file", "size": 3, "modifiedAt": 3 }
          ],
          "truncated": true }
        """.trimIndent()
        val listing = JsonV2.parseEntries(json)
        assertTrue(listing.truncated)
        assertEquals(listOf("android", "a.txt", "b.txt"), listing.entries.map { it.name })
        assertTrue(listing.entries[0].isDir)
        assertEquals(12L, listing.entries[2].size)
    }

    @Test
    fun `改动列表带 git 徽标与增删行数，非 git 目录降级不报错`() {
        val json = """
        { "workspace": "D:\\W", "vcs": "git", "branch": "main",
          "changed": [ { "path": "tools/dsh-remote/lib/http.mjs", "status": "M", "staged": false,
                         "insertions": 42, "deletions": 7, "isBinary": false } ],
          "untracked": [ "android/app/build/tmp.txt" ], "clean": false }
        """.trimIndent()
        val changes = JsonV2.parseChanges(json)
        assertTrue(changes.isGit)
        assertEquals("main", changes.branch)
        assertEquals(VcsBadge.MODIFIED, changes.changed[0].badge)
        assertEquals("http.mjs", changes.changed[0].fileName)
        assertEquals(42, changes.totalInsertions)
        assertEquals(1, changes.untracked.size)
        assertFalse(changes.clean)

        val none = JsonV2.parseChanges("""{ "workspace": "D:\\W", "vcs": "none", "branch": null, "changed": [], "clean": true }""")
        assertFalse(none.isGit)
        assertTrue(none.clean)
        assertEquals(0, none.totalInsertions)
        assertNotNull(none.untracked)
    }

    @Test
    fun `diff 与搜索命中解析`() {
        val diff = JsonV2.parseDiff(
            """{ "workspace": "D:\\W", "path": "D:\\W", "file": "a.kt", "vcs": "git",
                 "unified": "@@ -1,2 +1,3 @@\n-old\n+new\n+extra", "truncated": false }""",
        )
        assertEquals(4, diff.lines.size)
        assertEquals("a.kt", diff.file)

        val hits = JsonV2.parseSearch(
            """{ "hits": [
                 { "path": "android/BUILD.md", "name": "BUILD.md", "line": 12, "text": "工具链", "kind": "content" },
                 "README.md" ] }""",
        )
        assertEquals(2, hits.size)
        assertEquals(12, hits[0].line)
        assertEquals("README.md", hits[1].path)
    }

    @Test
    fun `错误体解析带 code 与 HTTP 状态`() {
        val error = JsonV2.parseError(
            """{ "error": { "code": "session_busy", "message": "该会话正由电脑端驱动" } }""",
            httpStatus = 409,
            fallbackMessage = "conflict",
        )
        assertEquals("session_busy", error.code)
        assertEquals(409, error.httpStatus)
        assertEquals("该会话正由电脑端驱动", error.message)

        val degraded = JsonV2.parseError("<html>502</html>", 502, "网关错误")
        assertEquals("internal", degraded.code)
        assertEquals("网关错误", degraded.message)
    }

    @Test
    fun `离线缓存序列化往返保留中文且 live 置 false`() {
        val sessions = JsonV2.parseSessions(sessionsJson)
        val text = JsonV2.sessionsToJson(sessions)
        val restored = JsonV2.sessionsFromJson(text)

        assertEquals(sessions.size, restored.size)
        assertEquals("远程控制台开发 🚀", restored[0].title)
        assertFalse("缓存里的 live 无意义，必须落盘为 false，避免离线看到假的呼吸点", restored[0].live)
        assertTrue(restored[0].hasChanges)
        assertEquals(SessionSummary.SOURCE_PHONE, restored[1].source)

        val messages = JsonV2.parseMessages(
            """{ "messages": [ { "seq": 1, "role": "assistant", "text": "中文 ✅ emoji 🚀",
                 "toolCalls": [ { "id": "c", "name": "pwsh", "args": { "command": "ls" }, "result": "ok",
                                  "isError": false, "truncated": false, "durationMs": 5 } ],
                 "deliverables": [ { "path": "a/b.apk", "description": "包" } ] } ] }""",
        )
        val restoredMessages = JsonV2.messagesFromJson(JsonV2.messagesToJson(messages))
        assertEquals("中文 ✅ emoji 🚀", restoredMessages[0].text)
        assertEquals("ls", restoredMessages[0].toolCalls[0].args?.optString("command"))
        assertEquals("a/b.apk", restoredMessages[0].deliverables[0].path)
    }

    @Test
    fun `损坏的缓存文本返回空列表`() {
        assertEquals(emptyList<SessionSummary>(), JsonV2.sessionsFromJson("not json"))
        assertEquals(emptyList<ChatMessage>(), JsonV2.messagesFromJson("{\"messages\": ")) 
        assertEquals(emptyList<com.deepseek.dshremote.data.api.SessionSummary>(), JsonV2.parseSessions(""))
    }

    @Test
    fun `新建任务响应兼容三种形状`() {
        assertEquals("session-x", JsonV2.parseCreateTask("""{"accepted":true,"sessionId":"session-x","turnId":"t1"}""").sessionId)
        assertEquals("session-y", JsonV2.parseCreateTask("""{"id":"session-y"}""").sessionId)
        assertEquals("session-z", JsonV2.parseCreateTask("""{"task":{"sessionId":"session-z"}}""").sessionId)
        val empty = JsonV2.parseCreateTask("{}")
        assertEquals("", empty.sessionId)
        assertFalse(empty.accepted)
    }

    @Test
    fun `新建任务响应解析权限档回执，旧网关缺字段不冒充全部权限`() {
        val full = JsonV2.parseCreateTask("""{"accepted":true,"sessionId":"session-a","access":"full"}""")
        assertEquals("full", full.access)
        assertEquals(TaskAccess.FULL, full.taskAccess)
        assertTrue(full.taskAccess.isDangerous)

        val workspace = JsonV2.parseCreateTask("""{"sessionId":"session-b","access":"workspace"}""")
        assertEquals(TaskAccess.WORKSPACE, workspace.taskAccess)

        // 包裹形状
        assertEquals("full", JsonV2.parseCreateTask("""{"task":{"sessionId":"session-c","access":"full"}}""").access)
        // 旧网关：没有该字段 → null（UI 会说明按默认档执行），且默认档必须是 workspace
        val legacy = JsonV2.parseCreateTask("""{"sessionId":"session-d"}""")
        assertEquals(null, legacy.access)
        assertEquals(TaskAccess.WORKSPACE, legacy.taskAccess)
        assertFalse(legacy.taskAccess.isDangerous)
        // 网关回了没见过的取值 → 收紧为 workspace，绝不能当成 full
        val unknown = JsonV2.parseCreateTask("""{"sessionId":"session-e","access":"yolo"}""")
        assertEquals("yolo", unknown.access)
        assertEquals(TaskAccess.WORKSPACE, unknown.taskAccess)
        assertFalse(unknown.taskAccess.isDangerous)
        // 空串等同没回执
        assertEquals(null, JsonV2.parseCreateTask("""{"sessionId":"session-f","access":""}""").access)
    }

    @Test
    fun `建任务请求体一定带上权限档且默认不是全部权限`() {
        val dflt = org.json.JSONObject(
            buildCreateTaskPayload(workspace = "D:\\Workspace\\dsh_android", prompt = "跑测试", clientTurnId = "ct-1"),
        )
        assertEquals("workspace", dflt.getString("access"))
        assertEquals("D:\\Workspace\\dsh_android", dflt.getString("workspace"))
        assertEquals("跑测试", dflt.getString("prompt"))
        assertEquals("ct-1", dflt.getString("clientTurnId"))
        assertFalse("没有 title/model 时不应写空字段", dflt.has("title"))
        assertFalse(dflt.has("model"))

        val full = org.json.JSONObject(
            buildCreateTaskPayload(
                workspace = "D:\\Workspace\\dsh_android",
                prompt = "把 D 盘那份报告改一下",
                clientTurnId = "ct-2",
                title = "跨盘任务",
                model = "deepseek-chat",
                access = TaskAccess.FULL,
            ),
        )
        assertEquals("full", full.getString("access"))
        assertEquals("跨盘任务", full.getString("title"))
        assertEquals("deepseek-chat", full.getString("model"))

        // 未知 wire 值在 enum 里收敛为默认档（防止手写字符串提权）
        assertEquals(TaskAccess.WORKSPACE, TaskAccess.fromWire("danger-full-access"))
        assertEquals(TaskAccess.WORKSPACE, TaskAccess.fromWire(null))
    }

    @Test
    fun `配对响应解析 relay 块并回退令牌字段`() {
        val claim = JsonV2.parsePairClaim(
            """{ "token": "dshr_v1_token_1234", "tokenId": "tok_7a1b", "serverName": "DESKTOP-XXX", "expiresAt": null,
                 "relay": { "homeId": "home_9f2c", "deviceToken": "dshr_relay_token_9876",
                            "tunnelUrl": "wss://relay.example.com/api/v2/tunnel/device" } }""",
        )
        assertEquals("home_9f2c", claim.homeId)
        assertEquals("dshr_relay_token_9876", claim.effectiveDeviceToken)
        assertEquals("dshr_v1_token_1234", claim.apiToken)
        assertEquals("wss://relay.example.com/api/v2/tunnel/device", claim.tunnelUrl)

        val legacy = JsonV2.parsePairClaim("""{ "token": "dshr_only_v1", "tokenId": "tok_1" }""")
        assertEquals("dshr_only_v1", legacy.effectiveDeviceToken)
        assertEquals("dshr_only_v1", legacy.apiToken)
        assertEquals("", legacy.homeId)
    }

    @Test
    fun `中继 health 与设备列表解析`() {
        val health = JsonV2.parseRelayHealth(
            """{ "ok": true, "relayVersion": "2.0.0", "apiVersion": 2, "uptimeMs": 12345,
                 "homes": 1, "devices": 2, "relayName": "relay.example.com" }""",
        )
        assertTrue(health.ok)
        assertEquals(1, health.homes)
        assertEquals("relay.example.com", health.relayName)

        val devices = JsonV2.parseDevices(
            """{ "devices": [ { "tokenId": "tok_1", "deviceName": "Pixel 8", "pairedAt": 1, "lastSeenAt": 2, "revoked": false } ] }""",
        )
        assertEquals(1, devices.size)
        assertEquals("Pixel 8", devices[0].deviceName)
    }

    // ---------- 模型目录与「模型到底生效没有」 ----------

    @Test
    fun `模型目录解析出分组 缺省选择与失败项`() {
        val catalog = JsonV2.parseModelCatalog(
            """{ "source": "desktop",
                 "default": { "provider": "deepseek-official", "model": "deepseek-v4-flash", "reasoningEffort": "medium" },
                 "groups": [ { "id": "deepseek-official", "name": "DeepSeek 官方", "models": [
                       { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "description": "快" },
                       { "id": "deepseek-v4-pro" } ] },
                   { "id": "openai", "models": [] } ],
                 "failures": [ { "id": "openai", "name": "OpenAI", "message": "缺 API key" } ] }""",
        )
        assertTrue(catalog.isKnown)
        assertTrue(catalog.hasChoices)
        assertEquals("desktop", catalog.source)
        assertEquals(2, catalog.groups.size)
        assertEquals("DeepSeek 官方", catalog.groups[0].name)
        assertEquals(2, catalog.groups[0].models.size)
        assertEquals("快", catalog.groups[0].models[0].description)
        assertEquals("名字缺失时回落到 id，选择器上不能出现空行", "deepseek-v4-pro", catalog.groups[0].models[1].name)
        assertEquals("组名缺失时同样回落成 id", "openai", catalog.groups[1].name)
        assertEquals("deepseek-v4-flash", catalog.defaultSelection?.model)
        assertEquals("medium", catalog.defaultSelection?.reasoningEffort)
        assertEquals(1, catalog.failures.size)
        assertEquals("缺 API key", catalog.failures[0].message)
        assertEquals("DeepSeek V4 Flash", catalog.labelFor(ModelSelection("deepseek-official", "deepseek-v4-flash")))
        assertEquals("目录外的 id 也要显示出来", "ghost", catalog.labelFor(ModelSelection("x", "ghost")))
        assertTrue(catalog.contains(ModelSelection("deepseek-official", "deepseek-v4-flash")))
        assertFalse(catalog.contains(ModelSelection("x", "ghost")))
    }

    @Test
    fun `模型目录坏掉时整块收敛为未知而不是抛出`() {
        assertEquals(ModelCatalog.UNKNOWN, JsonV2.parseModelCatalog("不是 JSON"))
        val empty = JsonV2.parseModelCatalog("""{"source":"config"}""")
        assertTrue(empty.isKnown)
        assertFalse("没有分组就没有可选项，界面不画选择器", empty.hasChoices)
        // 单个坏项只跳过它自己
        val partial = JsonV2.parseModelCatalog(
            """{"source":"desktop","groups":[{"id":"","models":[{"id":"a"}]},{"id":"ok","models":[{"id":""},{"id":"m1"}]}]}""",
        )
        assertEquals(1, partial.groups.size)
        assertEquals("ok", partial.groups[0].id)
        assertEquals(1, partial.groups[0].models.size)
        assertEquals("m1", partial.groups[0].models[0].id)
        // 只有一半的 default（缺 provider）等于没有缺省
        assertNull(JsonV2.parseModelCatalog("""{"source":"desktop","default":{"model":"m"}}""").defaultSelection)
    }

    @Test
    fun `回执里的模型字段：没生效要带原因，旧网关不许当成成功`() {
        val applied = JsonV2.parseCreateTask("""{"sessionId":"s1","modelApplied":true}""")
        assertEquals(true, applied.modelApplied)
        assertNull(applied.modelWarning)

        val failed = JsonV2.parseCreateTask(
            """{"sessionId":"s2","modelApplied":false,"modelWarning":"模型 deepseek-v4-pro 不在可用目录里"}""",
        )
        assertEquals(false, failed.modelApplied)
        assertEquals("模型 deepseek-v4-pro 不在可用目录里", failed.modelWarning)

        val warnedOnly = JsonV2.parseCreateTask("""{"sessionId":"s3","modelWarning":"没换成"}""")
        assertEquals("带着原因却说自己生效了，只能当成没生效", false, warnedOnly.modelApplied)

        val legacy = JsonV2.parseCreateTask("""{"sessionId":"s4"}""")
        assertNull("旧网关不回执 → 生效与否不可知，不许当成成功", legacy.modelApplied)
        assertNull(legacy.modelWarning)

        val wrapped = JsonV2.parseCreateTask("""{"task":{"sessionId":"s5","modelApplied":true}}""")
        assertEquals(true, wrapped.modelApplied)
    }
}
