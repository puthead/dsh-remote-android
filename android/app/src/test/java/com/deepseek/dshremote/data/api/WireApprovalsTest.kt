package com.deepseek.dshremote.data.api

import com.deepseek.dshremote.data.ApiException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 审批/提问通道的契约钉子（契约 §7.7）。
 *
 * 为什么值得这么多断言：这条协议的形状是**实测**出来的，反直觉之处密集
 * （`custom` 不是 `text`、`selected` 必须是数组、`multiSelect` 为假时整个键都不出现、
 * `questions` 只在提问时有）。这些坑每一个都会在真机上表现成"点了没反应"或
 * "模型拿到了错的答案"，而看日志是看不出来的——只能在纯 JVM 里逐条钉住。
 */
class WireApprovalsTest {

    // ------------------------------------------------------------ 夹具

    private fun approvalJson(
        eventId: String = "evt-1",
        questions: String? = null,
        extra: String = "",
    ): String {
        val q = questions ?: "null"
        return """
            {"eventId":"$eventId","sessionId":"session-1","kind":"approval",
             "toolName":"Bash","callId":"call-9","reason":"需要在工作区里跑构建",
             "questions":$q,"at":1791463000000,"expiresAt":1791463900000$extra}
        """.trimIndent()
    }

    private fun questionJson(
        eventId: String = "evt-q1",
        questions: String = """[{"id":"q1","header":"部署目标","question":"发到哪个环境？",
            "detail":"生产环境会立刻对外可见","options":[{"label":"staging","description":"预发"},
            {"label":"prod","description":null}],"multiSelect":false}]""",
    ): String = """
        {"eventId":"$eventId","sessionId":"session-1","kind":"question",
         "toolName":"ask_user_question","callId":"call-1","reason":null,
         "questions":$questions,"at":1791463000000,"expiresAt":1791463900000}
    """.trimIndent()

    // ------------------------------------------------------------ 列表解析

    @Test
    fun `解析完整响应_列表与诊断快照都在`() {
        val body = """
            {"ok":true,
             "approvals":[${approvalJson()},${questionJson()}],
             "state":{"available":true,"connected":true,"pending":2,"startedAt":1791460000000,
                      "reconnects":1,"lastError":null,"counters":{"asked":5,"approved":1}}}
        """.trimIndent()

        val parsed = WireApprovals.parseApprovals(body)
        assertNotNull(parsed)
        assertEquals(2, parsed!!.approvals.size)
        assertEquals("evt-1", parsed.approvals[0].eventId)
        assertEquals(WireApprovals.Kind.APPROVAL, parsed.approvals[0].kind)
        assertEquals(WireApprovals.Kind.QUESTION, parsed.approvals[1].kind)

        val state = parsed.state
        assertTrue(state.available)
        assertTrue(state.connected)
        assertEquals(2, state.pending)
        assertEquals(1, state.reconnects)
        assertNull(state.lastErrorCode)
    }

    @Test
    fun `解析响应_审批的questions是null而不是空列表`() {
        val parsed = WireApprovals.parseApprovals("""{"ok":true,"approvals":[${approvalJson()}]}""")
        val entry = parsed!!.approvals.single()
        // 约定：审批恒为 null（不是 emptyList）——界面据此区分"没有题目"和"题目没解析出来"
        assertNull(entry.questions)
        assertEquals("Bash", entry.toolName)
        assertEquals("call-9", entry.callId)
        assertEquals("需要在工作区里跑构建", entry.reason)
    }

    @Test
    fun `解析响应_提问的questions解析出选项与说明`() {
        val entry = WireApprovals.parseApprovals("""{"approvals":[${questionJson()}]}""")!!.approvals.single()
        val questions = entry.questions!!
        assertEquals(1, questions.size)
        val q = questions.single()
        assertEquals("q1", q.id)
        assertEquals("部署目标", q.header)
        assertEquals("发到哪个环境？", q.question)
        assertEquals("生产环境会立刻对外可见", q.detail)
        assertEquals(2, q.options.size)
        assertEquals("staging", q.options[0].label)
        assertEquals("预发", q.options[0].description)
        // description 为 null 的选项要保留（它是"没有说明"，不是"选项无效"）
        assertEquals("prod", q.options[1].label)
        assertNull(q.options[1].description)
        assertFalse(q.multiSelect)
        assertFalse(q.isFreeText)
    }

    @Test
    fun `解析响应_选项为空数组即自由文本问题`() {
        val body = """{"approvals":[${questionJson(questions = """[{"id":"q1","question":"你希望用什么名字？","options":[]}]""")}]}"""
        val q = WireApprovals.parseApprovals(body)!!.approvals.single().questions!!.single()
        assertEquals(0, q.options.size)
        assertTrue(q.isFreeText)
    }

    @Test
    fun `解析响应_完全没有options键也当自由文本`() {
        val body = """{"approvals":[${questionJson(questions = """[{"id":"q1","question":"叫什么？"}]""")}]}"""
        val q = WireApprovals.parseApprovals(body)!!.approvals.single().questions!!.single()
        assertTrue(q.isFreeText)
    }

    @Test
    fun `解析响应_multiSelect缺键即false_为true时读出true`() {
        // 线上 multiSelect 为假时整个键都不出现（网关 normalizeQuestions 的行为），
        // 所以"缺键 ⇒ false"不是宽容，而是唯一正确的读法
        val body = """{"approvals":[${questionJson(questions = """[
            {"id":"q1","question":"单选","options":[{"label":"a"}],"multiSelect":false},
            {"id":"q2","question":"缺键","options":[{"label":"b"}]},
            {"id":"q3","question":"多选","options":[{"label":"c"}],"multiSelect":true}
        ]""")}]}"""
        val questions = WireApprovals.parseApprovals(body)!!.approvals.single().questions!!
        assertEquals(3, questions.size)
        assertFalse(questions[0].multiSelect)
        assertFalse(questions[1].multiSelect)
        assertTrue(questions[2].multiSelect)
    }

    @Test
    fun `解析响应_单条畸形只跳过它自己`() {
        val body = """
            {"approvals":[
              {"eventId":"evt-ok","kind":"approval","toolName":"Read"},
              {"eventId":"evt-bad-kind","kind":"something-else"},
              {"kind":"approval"},
              "not-an-object",
              {"eventId":"evt-ok2","kind":"question","questions":[{"question":"没有id"}]}
            ]}
        """.trimIndent()
        val entry = WireApprovals.parseApprovals(body)!!.approvals
        // 只留下第一条：kind 不认识、缺 eventId、非对象都被跳过；缺 id 的**问题**被跳过但条目还在
        assertEquals(2, entry.size)
        assertEquals("evt-ok", entry[0].eventId)
        assertEquals("evt-ok2", entry[1].eventId)
        assertEquals(0, entry[1].questions!!.size)
    }

    @Test
    fun `解析响应_整体不是JSON时返回null`() {
        assertNull(WireApprovals.parseApprovals("<html>502 Bad Gateway</html>"))
        assertNull(WireApprovals.parseApprovals(""))
    }

    @Test
    fun `解析响应_没有approvals键即空列表而不是null`() {
        val parsed = WireApprovals.parseApprovals("""{"ok":true,"state":{"connected":true}}""")
        assertNotNull(parsed)
        assertEquals(0, parsed!!.approvals.size)
        assertTrue(parsed.state.connected)
    }

    // ------------------------------------------------------------ 文案

    @Test
    fun `摘要与警示语按类型分岔`() {
        val approval = WireApprovals.parseApprovals("""{"approvals":[${approvalJson()}]}""")!!.approvals.single()
        assertEquals("请求使用工具 Bash", approval.headline)
        assertTrue(approval.warning.contains("审批"))

        // 提问的 headline 取第一问的题面：用户在这一眼里就该看到"要回答什么"
        val question = WireApprovals.parseApprovals("""{"approvals":[${questionJson()}]}""")!!.approvals.single()
        assertEquals("发到哪个环境？", question.headline)
        assertTrue(question.warning.contains("回答"))
    }

    @Test
    fun `没有toolName时摘要不出现空的工具名`() {
        val body = """{"approvals":[{"eventId":"e","kind":"approval"}]}"""
        assertEquals("请求使用工具", WireApprovals.parseApprovals(body)!!.approvals.single().headline)
    }

    @Test
    fun `剩余时间按分钟档取整_过期给空串`() {
        assertEquals("", WireApprovals.formatRemaining(0L))
        assertEquals("", WireApprovals.formatRemaining(-1L))
        assertEquals("即将过期", WireApprovals.formatRemaining(59_000L))
        assertEquals("还剩约 1 分钟", WireApprovals.formatRemaining(60_000L))
        assertEquals("还剩约 14 分钟", WireApprovals.formatRemaining(14 * 60_000L + 59_000L))
    }

    @Test
    fun `remainingMillis按now算_无有效期给0`() {
        val entry = WireApprovals.parseApprovals("""{"approvals":[${approvalJson()}]}""")!!.approvals.single()
        assertEquals(900_000L, entry.remainingMillis(entry.expiresAt - 900_000L))
        assertEquals(0L, entry.remainingMillis(entry.expiresAt + 1L))
        // now 拿不到（0）时不给倒计时：宁可不显示，也不要显示一个负数或"已过期"
        assertEquals(0L, entry.remainingMillis(0L))
        val noTtl = WireApprovals.parseApprovals("""{"approvals":[{"eventId":"e","kind":"approval"}]}""")!!
            .approvals.single()
        assertEquals(0L, noTtl.remainingMillis(1791463000000L))
    }

    @Test
    fun `拿不到列表的原因分三种`() {
        assertTrue(WireApprovals.BridgeState(available = false).note.contains("未启用"))
        assertTrue(WireApprovals.BridgeState(available = true, connected = false).note.contains("没连上"))
        assertTrue(WireApprovals.BridgeState(available = true, connected = true).note.contains("暂无"))
    }

    // ------------------------------------------------------------ 审批结论编码

    @Test
    fun `四个结论都按线上的字面量编码`() {
        assertEquals("""{"outcome":"allowed-once"}""", WireApprovals.encodeApproval(WireApprovals.Outcome.ALLOWED_ONCE))
        assertEquals("""{"outcome":"rejected"}""", WireApprovals.encodeApproval(WireApprovals.Outcome.REJECTED))
        assertEquals("""{"outcome":"cancelled"}""", WireApprovals.encodeApproval(WireApprovals.Outcome.CANCELLED))
        assertEquals("""{"outcome":"unavailable"}""", WireApprovals.encodeApproval(WireApprovals.Outcome.UNAVAILABLE))
    }

    @Test
    fun `结论枚举与线协议字面量、按钮文案常量三处对得上`() {
        // 按钮文案常量与编码取值同名：界面与测试都引用同一套常量，避免两处漂移
        WireApprovals.Outcome.entries.forEach { outcome ->
            assertTrue("按钮文案不能为空", outcome.label.isNotEmpty())
        }
        assertEquals(WireApprovals.ACTION_ALLOW_ONCE, WireApprovals.Outcome.ALLOWED_ONCE.wire)
        assertEquals(WireApprovals.ACTION_REJECT, WireApprovals.Outcome.REJECTED.wire)
        assertEquals(WireApprovals.ACTION_CANCEL, WireApprovals.Outcome.CANCELLED.wire)
        assertEquals(WireApprovals.ACTION_UNAVAILABLE, WireApprovals.Outcome.UNAVAILABLE.wire)
        // 界面显示中文、线上走英文，两者不是同一个字符串——混用会把中文送上线路
        assertEquals("允许一次", WireApprovals.Outcome.ALLOWED_ONCE.label)
        assertEquals(
            WireApprovals.Outcome.CANCELLED,
            WireApprovals.Outcome.fromWire(WireApprovals.ACTION_CANCEL),
        )
        assertNull(WireApprovals.Outcome.fromWire("allow-always"))
    }

    @Test
    fun `弃权体是abstain_true`() {
        assertEquals("""{"abstain":true}""", WireApprovals.encodeAbstain())
        assertEquals("""{"abstain":true}""", WireApprovals.Answer.Abstain().body)
    }

    @Test
    fun `Decision答案自带结论与提示语`() {
        val answer = WireApprovals.Answer.Decision(WireApprovals.Outcome.REJECTED)
        assertEquals("""{"outcome":"rejected"}""", answer.body)
        // 提示语必须点明"谁先答谁赢"：否则用户会以为决定是自己做的
        assertTrue(answer.resultMessage.contains("以先答的为准"))
    }

    // ------------------------------------------------------------ 提问答案编码

    private fun question(
        id: String = "q1",
        multiSelect: Boolean = false,
        options: List<WireApprovals.ApprovalOption> = listOf(WireApprovals.ApprovalOption("blue")),
    ) = WireApprovals.ApprovalQuestion(
        id = id,
        question = "选一个",
        options = options,
        multiSelect = multiSelect,
    )

    @Test
    fun `selected必须是JSON数组而不是裸字符串`() {
        val body = WireApprovals.encodeAnswers(
            listOf(question()),
            mapOf("q1" to WireApprovals.ApprovalDraft(selected = setOf("blue"))),
        )!!
        val answers = JSONObject(body).getJSONArray("answers")
        val first = answers.getJSONObject(0)
        assertEquals("q1", first.getString("id"))
        // 这条断言是整份测试里最重要的一条：传裸字符串会被工具内部
        // `[...answer.selected]` 静默展开成 ['b','l','u','e']，模型拿到四个单字母选项
        assertTrue(first.get("selected") is JSONArray)
        assertEquals(listOf("blue"), first.getJSONArray("selected").let { array ->
            (0 until array.length()).map { array.getString(it) }
        })
    }

    @Test
    fun `自由文本写在custom键_且没有text键`() {
        val body = WireApprovals.encodeAnswers(
            listOf(question(options = emptyList())),
            mapOf("q1" to WireApprovals.ApprovalDraft(custom = "  叫 dsh-remote  ")),
        )!!
        val first = JSONObject(body).getJSONArray("answers").getJSONObject(0)
        assertEquals("叫 dsh-remote", first.getString("custom"))
        assertEquals(0, first.getJSONArray("selected").length())
        // 桌面端 schema 是 additionalProperties=false：多一个 text 键会被整条拒掉
        assertFalse(first.has("text"))
    }

    @Test
    fun `没答的问题被跳过_一条都没有时返回null`() {
        val body = WireApprovals.encodeAnswers(
            listOf(question("q1"), question("q2")),
            mapOf(
                "q1" to WireApprovals.ApprovalDraft(selected = setOf("blue")),
                "q2" to WireApprovals.ApprovalDraft(custom = "   "),
            ),
        )!!
        val answers = JSONObject(body).getJSONArray("answers")
        assertEquals(1, answers.length())
        assertEquals("q1", answers.getJSONObject(0).getString("id"))

        assertNull(WireApprovals.encodeAnswers(listOf(question("q1")), emptyMap()))
        assertNull(
            WireApprovals.encodeAnswers(
                listOf(question("q1")),
                mapOf("q1" to WireApprovals.ApprovalDraft(custom = "  ")),
            ),
        )
    }

    @Test
    fun `纯空白的选项卡不写进selected`() {
        val body = WireApprovals.encodeAnswers(
            listOf(question()),
            mapOf("q1" to WireApprovals.ApprovalDraft(selected = setOf("blue", "  "))),
        )!!
        val selected = JSONObject(body).getJSONArray("answers").getJSONObject(0).getJSONArray("selected")
        assertEquals(1, selected.length())
    }

    @Test
    fun `多选答案带多个标签`() {
        val body = WireApprovals.encodeAnswers(
            listOf(question(multiSelect = true, options = listOf(
                WireApprovals.ApprovalOption("a"),
                WireApprovals.ApprovalOption("b"),
            ))),
            mapOf("q1" to WireApprovals.ApprovalDraft(selected = setOf("a", "b"))),
        )!!
        val selected = JSONObject(body).getJSONArray("answers").getJSONObject(0).getJSONArray("selected")
        assertEquals(listOf("a", "b"), (0 until selected.length()).map { selected.getString(it) }.sorted())
    }

    @Test
    fun `Responses答案的body就是编好的JSON_提示语用回答口径`() {
        val body = WireApprovals.encodeAnswers(
            listOf(question()),
            mapOf("q1" to WireApprovals.ApprovalDraft(selected = setOf("blue"))),
        )!!
        val answer = WireApprovals.Answer.Responses(body)
        assertEquals(body, answer.body)
        assertTrue(answer.resultMessage.contains("已提交回答"))
    }

    @Test
    fun `Responses为null时body是空串_交给VM提示还没填`() {
        // 空 body 是 VM 判断"还没回答任何问题"的哨兵值：不能让桌面端把空串当成有效答案
        assertEquals("", WireApprovals.Answer.Responses(null).body)
    }

    // ------------------------------------------------------------ 单选/多选切换

    @Test
    fun `单选再点同一项即取消`() {
        val q = question(multiSelect = false)
        val once = WireApprovals.toggleOption(q, WireApprovals.ApprovalDraft(), "blue")
        assertEquals(setOf("blue"), once.selected)
        val twice = WireApprovals.toggleOption(q, once, "blue")
        assertTrue(twice.selected.isEmpty())
    }

    @Test
    fun `单选点另一项会换掉原来那项`() {
        val q = question(options = listOf(WireApprovals.ApprovalOption("blue"), WireApprovals.ApprovalOption("green")))
        val picked = WireApprovals.toggleOption(q, WireApprovals.ApprovalDraft(selected = setOf("blue")), "green")
        assertEquals(setOf("green"), picked.selected)
    }

    @Test
    fun `多选是累加与取消`() {
        val q = question(multiSelect = true, options = listOf(
            WireApprovals.ApprovalOption("a"),
            WireApprovals.ApprovalOption("b"),
        ))
        val both = WireApprovals.toggleOption(
            q,
            WireApprovals.toggleOption(q, WireApprovals.ApprovalDraft(), "a"),
            "b",
        )
        assertEquals(setOf("a", "b"), both.selected)
        assertEquals(setOf("b"), WireApprovals.toggleOption(q, both, "a").selected)
        // 多选切选项不会动自由文本
        assertEquals(
            "补充",
            WireApprovals.toggleOption(q, both.copy(custom = "补充"), "a").custom,
        )
    }

    @Test
    fun `草稿answered的判据是选过或写过`() {
        assertFalse(WireApprovals.ApprovalDraft().answered)
        assertFalse(WireApprovals.ApprovalDraft(custom = "   ").answered)
        assertTrue(WireApprovals.ApprovalDraft(selected = setOf("a")).answered)
        assertTrue(WireApprovals.ApprovalDraft(custom = "文本").answered)
    }

    // ------------------------------------------------------------ 提交前校验

    @Test
    fun `两问只答一问时不允许提交`() {
        val entry = WireApprovals.parseApprovals(
            """{"approvals":[${questionJson(questions = """[
                {"id":"q1","question":"一","options":[{"label":"a"}]},
                {"id":"q2","question":"二","options":[{"label":"b"}]}
            ]""")}]}""",
        )!!.approvals.single()

        val partial = WireApprovals.plan(entry, mapOf("q1" to WireApprovals.ApprovalDraft(selected = setOf("a"))))
        assertFalse(partial.canSubmit)
        assertEquals(listOf("q2"), partial.unanswered)
        assertEquals(2, partial.total)
        assertFalse(partial.allAnswered)

        val full = WireApprovals.plan(
            entry,
            mapOf(
                "q1" to WireApprovals.ApprovalDraft(selected = setOf("a")),
                "q2" to WireApprovals.ApprovalDraft(custom = "随便"),
            ),
        )
        assertTrue(full.canSubmit)
        assertTrue(full.allAnswered)
    }

    @Test
    fun `审批条目没有题目时永远不可提交`() {
        // 审批走的是四个结论按钮，不是"提交回答"；把空问题判成可提交会露出一个假按钮
        val entry = WireApprovals.parseApprovals("""{"approvals":[${approvalJson()}]}""")!!.approvals.single()
        val plan = WireApprovals.plan(entry, emptyMap())
        assertFalse(plan.canSubmit)
        assertEquals(0, plan.total)
        assertTrue(plan.allAnswered)
    }

    // ------------------------------------------------------------ 错误码映射

    @Test
    fun `已经不在的两种错误码判定为已决`() {
        assertTrue(WireApprovals.alreadyDecided(ApiException("not_found", "no such approval", 404)))
        assertTrue(WireApprovals.alreadyDecided(ApiException("approval_expired", "expired", 409)))
        assertFalse(WireApprovals.alreadyDecided(ApiException("bad_request", "bad", 400)))
        assertFalse(WireApprovals.alreadyDecided(ApiException("desktop_unavailable", "off", 503)))
        // 网络层失败（不是 ApiException）不能把本地卡片撤掉：那只是"这次没送出去"
        assertFalse(WireApprovals.alreadyDecided(IllegalStateException("socket closed")))
    }

    @Test
    fun `错误提示保留错误码原文并给出处置建议`() {
        val notFound = WireApprovals.friendlyApprovalMessage(ApiException("not_found", "no such approval", 404))
        assertTrue(notFound.contains("no such approval"))
        assertTrue(notFound.contains("已被电脑端先答"))

        val expired = WireApprovals.friendlyApprovalMessage(ApiException("approval_expired", "expired", 409))
        assertTrue(expired.contains("15 分钟"))

        val offline = WireApprovals.friendlyApprovalMessage(ApiException("desktop_unavailable", "bridge off", 503))
        assertTrue(offline.contains("未启用桌面端通道"))

        val unreachable = WireApprovals.friendlyApprovalMessage(
            ApiException("desktop_unreachable", "connect ECONNREFUSED", 502),
        )
        assertTrue(unreachable.contains("确认电脑上的 DSH 在运行"))

        val unauthorized = WireApprovals.friendlyApprovalMessage(
            ApiException("desktop_unauthorized", "401 from desktop", 502),
        )
        assertTrue(unauthorized.contains("重新配对"))

        // 网关会把剩下的错误（含 gateway/*）统一折成 desktop_error
        val desktopError = WireApprovals.friendlyApprovalMessage(ApiException("desktop_error", "boom", 502))
        assertTrue(desktopError.contains("协议级错误"))

        // 不认识的码原样透出：编一句中文会把网关日志里的原始信息盖掉
        assertEquals("weird", WireApprovals.friendlyApprovalMessage(ApiException("weird", "weird", 500)))
        assertEquals("未知错误", WireApprovals.friendlyApprovalMessage(IllegalStateException()))
    }
}
