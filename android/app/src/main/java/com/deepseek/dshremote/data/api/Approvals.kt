package com.deepseek.dshremote.data.api

import com.deepseek.dshremote.data.ApiException
import org.json.JSONArray
import org.json.JSONObject

/**
 * 契约 §7.7「审批与提问（可应答 waterfall）」的手机端模型与序列化。
 *
 * 为什么单独成一个文件、且全是纯函数：这条通道的**形状**是实测出来的、有一堆反直觉的坑
 * （`custom` 不是 `text`、`selected` 必须是数组、`multiSelect` 为假时整个键都不出现），
 * 而 [ConsoleRepository] 需要 Android Context / DataStore，没法在 JVM 单测里实例化。
 * 把"认帧"和"拼答案"全部收进这个纯对象，才能在单测里逐条钉住。
 *
 * 手机端读到的**唯一**关联键是 `eventId`：线上转发帧里的 `request` 已被剥掉 `agent`/`signal`，
 * 审批没有 approvalId，所以路径参数、去重、SSE 关联一律用 `eventId`。
 */
object WireApprovals {

    // ---------------------------------------------------------------- 枚举

    /** 未决请求的两类（对应网关两条 `mode:'waterfall'` 事件）。 */
    enum class Kind(val wire: String) {
        /** `approval/request`：请求使用某个工具。 */
        APPROVAL("approval"),

        /** `user-questions/request`：模型反问用户（`ask_user_question`）。 */
        QUESTION("question");

        companion object {
            fun fromWire(value: String?): Kind? = entries.firstOrNull { it.wire == value }
        }
    }

    /**
     * 审批结论（`dsh-user-approval` 的 `OUTCOMES`）。
     *
     * 四个取值都来自桌面端协议，**不要只暴露前两个**：`cancelled` / `unavailable` 是
     * 用户明确表达"这件事别做了 / 我这儿没这个能力"，映射成 `rejected` 会让模型拿到错误的语义
     * （它会把"无法执行"重试成"用户拒绝"）。
     */
    enum class Outcome(val wire: String, val label: String) {
        /** 允许这一次（不写任何持久授权）。 */
        ALLOWED_ONCE("allowed-once", "允许一次"),
        REJECTED("rejected", "拒绝"),
        CANCELLED("cancelled", "取消本轮"),
        UNAVAILABLE("unavailable", "无法处理");

        companion object {
            fun fromWire(value: String?): Outcome? = entries.firstOrNull { it.wire == value }
        }
    }

    /** 审批条的按钮文案常量——与 [encodeApproval] 用的取值同名，界面和测试都引用它，避免两处漂移。 */
    const val ACTION_ALLOW_ONCE = "allowed-once"
    const val ACTION_REJECT = "rejected"
    const val ACTION_CANCEL = "cancelled"
    const val ACTION_UNAVAILABLE = "unavailable"

    /** 未决请求的存活时间：15 分钟（网关侧 `DEFAULT_APPROVAL_TTL_MS`；它只影响网关自己的记账，见 [ApprovalEntry.remainingMillis]）。 */
    const val APPROVAL_TTL_MS: Long = 15 * 60_000L

    // ---------------------------------------------------------------- 模型

    /** 提问的一个选项。 */
    data class ApprovalOption(val label: String, val description: String? = null)

    /**
     * 提问里的一问。
     *
     * [options] 为空 ⇒ 自由文本问题（没有可点的选项，只能填 [ApprovalDraft.custom]）。
     * [multiSelect] 由网关补齐成布尔（线上为假时**整个键都不出现**），所以这里永远不问 null。
     */
    data class ApprovalQuestion(
        val id: String,
        val header: String? = null,
        val question: String = "",
        val detail: String? = null,
        val options: List<ApprovalOption> = emptyList(),
        val multiSelect: Boolean = false,
    ) {
        /** 没有选项 ⇒ 只能自由文本作答。 */
        val isFreeText: Boolean get() = options.isEmpty()
    }

    /** 一条未决请求（`GET /api/v2/approvals` 的 `approvals[]` = 网关的 `publicEntry`）。 */
    data class ApprovalEntry(
        val eventId: String,
        val sessionId: String? = null,
        val kind: Kind,
        val toolName: String? = null,
        val callId: String? = null,
        val reason: String? = null,
        /** 只有 [Kind.QUESTION] 有；审批恒为 null。 */
        val questions: List<ApprovalQuestion>? = null,
        val at: Long = 0L,
        val expiresAt: Long = 0L,
    ) {
        /** 一行摘要（画稿护栏条里那行等宽文字）。 */
        val headline: String
            get() = if (kind == Kind.APPROVAL) {
                toolName?.takeIf { it.isNotEmpty() }?.let { "请求使用工具 $it" } ?: "请求使用工具"
            } else {
                questions?.firstOrNull()?.question?.takeIf { it.isNotEmpty() } ?: "电脑端有提问等你回答"
            }

        /** 琥珀色警示语（画稿 02：等待你响应 = 最高优先级）。 */
        val warning: String
            get() = if (kind == Kind.APPROVAL) {
                "电脑端在等你的审批：这一轮已经挂住，直到有人回答"
            } else {
                "电脑端在等你回答：这一轮已经挂住，直到有人回答"
            }

        /** 还有多久过期（毫秒，已过期或 [now] 为 0 ⇒ 0）。 */
        fun remainingMillis(now: Long): Long =
            if (now <= 0L || expiresAt <= 0L) 0L else (expiresAt - now).coerceAtLeast(0L)
    }

    /** 一张卡里用户正在填的答案（界面状态，与协议解耦）。 */
    data class ApprovalDraft(
        val selected: Set<String> = emptySet(),
        val custom: String = "",
    ) {
        /** 这一问是否已经可以提交：选了选项，或者写了自由文本。 */
        val answered: Boolean get() = selected.isNotEmpty() || custom.isNotBlank()
    }

    /**
     * 提交前的本地校验（界面据此把「提交」置灰）。
     *
     * 为什么不让界面自己判：`selected: []` 在协议里合法（语义是"已回答"），但**只有当用户
     * 真的划过选项或写过文本时**才代表"回答过了"；把空选当成可提交，用户会误触发出一个
     * 什么都没答的请求，而桌面端会把它当成"跳过这一问"。
     */
    data class ApprovalPlan(
        val canSubmit: Boolean,
        val unanswered: List<String>,
        val total: Int,
    ) {
        val allAnswered: Boolean get() = unanswered.isEmpty()
    }

    /**
     * 网关报的"为什么收不到审批"的原因码（`state.reason`）。
     *
     * 为什么需要它：只凭 [BridgeState.available] / [BridgeState.connected] 两个布尔量，
     * 界面能把话说对的只有三句（"没启用 / 没连上 / 暂无"），而"没连上"至少有四种
     * 完全不同的处置方式（网关不是新版、电脑端没启动、凭据不可用、连接断了）。
     * 原因码由网关侧判定（见 `tools/dsh-remote/lib/approvals.mjs` 的 `APPROVAL_REASONS`），
     * 手机端只负责把它翻成中文，**不**自己猜。
     *
     * 未知取值一律归入 [UNKNOWN]：新版网关加了新原因码时，老 App 仍然能显示原来的三态文案。
     */
    enum class Reason(val wire: String) {
        /** 电脑端凭据不可用（`~/.dsh/.credentials.yaml` 里没有 browser-session）。 */
        NO_CREDENTIALS("desktop_no_credentials"),

        /** 电脑端拒绝了网关的凭据（browser-session 轮换过）。 */
        UNAUTHORIZED("desktop_unauthorized"),

        /** 连不上电脑端（没启动 / 端口不对 / 被防火墙拦下）。 */
        UNREACHABLE("desktop_unreachable"),

        /** 网关配置里关掉了桌面端通道（`desktop.enabled=false`）。 */
        DISABLED("desktop_disabled"),

        /** 连上过又断了，网关正在自动重连。 */
        DISCONNECTED("desktop_disconnected"),

        /** 还在初次连接中。 */
        NOT_CONNECTED("not_connected"),

        /** 网关内部错误。 */
        BRIDGE_CRASHED("bridge_crashed"),

        /** 没听说过的原因码（老 App 遇到新网关）。 */
        UNKNOWN("");

        companion object {
            fun fromWire(value: String?): Reason =
                entries.firstOrNull { it != UNKNOWN && it.wire == value } ?: UNKNOWN
        }
    }

    /** 网关审批桥的诊断快照（`state`）：用来解释"为什么列表是空的"。 */
    data class BridgeState(
        val available: Boolean = false,
        val connected: Boolean = false,
        val pending: Int = 0,
        val reconnects: Int = 0,
        val lastErrorCode: String? = null,
        /** 网关报的原因码（老网关没有这个字段 ⇒ [Reason.UNKNOWN]）。 */
        val reasonCode: Reason = Reason.UNKNOWN,
        /** 网关给的**下一步动作**（"请先启动电脑端 DSH"之类），没有时为 null。 */
        val serverHint: String? = null,
    ) {
        /**
         * 拿不到列表的原因（空列表时界面要能说清是"没有"还是"没连上"）。
         *
         * 三态文案与网关的 `reason` **必须一致**，否则会出现"网关说凭据不可用、
         * 手机说旧版本网关"这种自相矛盾的提示。所以原因码优先，两个布尔量兜底
         * （老网关没有 `reason` 字段，只能靠布尔量）。
         */
        val note: String
            get() = when (reasonCode) {
                Reason.NO_CREDENTIALS -> "网关找不到电脑端凭据，收不到审批"
                Reason.UNAUTHORIZED -> "电脑端拒绝了网关的凭据，收不到审批"
                Reason.UNREACHABLE -> "网关连不上电脑端，收不到审批"
                Reason.DISABLED -> "电脑端网关关掉了审批通道（desktop.enabled=false）"
                Reason.DISCONNECTED -> "网关与电脑端的连接断了，正在自动重连"
                Reason.BRIDGE_CRASHED -> "网关的审批通道出错了，收不到审批"
                Reason.NOT_CONNECTED, Reason.UNKNOWN -> when {
                    !available -> "网关未启用审批通道（旧版本网关）"
                    !connected -> "网关还没连上电脑端事件流，暂时收不到审批"
                    else -> "电脑端暂无待应答的审批或提问"
                }
            }

        /**
         * 界面用的第二行：**下一步该做什么**。
         *
         * 复用网关的 `hint`（它对具体原因最清楚），只有在网关没给（老网关）时才自己补一句。
         * 空串表示"没什么要做的"（正常情况下就不该多占一行）。
         */
        val hint: String
            get() = serverHint?.takeIf { it.isNotBlank() } ?: when (reasonCode) {
                Reason.NO_CREDENTIALS, Reason.UNAUTHORIZED -> "请先在电脑上启动 DSH 桌面端，再重启网关"
                Reason.UNREACHABLE -> "确认电脑端 DSH 正在运行，然后重启网关"
                Reason.DISABLED -> "打开配置里的 desktop.enabled 后重启网关"
                Reason.DISCONNECTED -> "网关会自动重连，稍后下拉刷新"
                Reason.BRIDGE_CRASHED -> "请查看电脑端网关日志"
                Reason.NOT_CONNECTED, Reason.UNKNOWN -> ""
            }

        /**
         * 是否需要把 [note] / [hint] 显示给用户。
         *
         * 正常且没有待答时**不显示**：那会在每次进会话时都多一行"暂无待应答"的噪声。
         * 只有"本该能收到却收不到"才值得占用输入区上方的位置。
         */
        val needsAttention: Boolean
            get() = reasonCode != Reason.UNKNOWN || !available || !connected
    }

    // ---------------------------------------------------------------- 解析

    /** `GET /api/v2/approvals` 的响应（未决列表 + 诊断快照）。 */
    data class ApprovalsResponse(
        val approvals: List<ApprovalEntry>,
        val state: BridgeState,
    )

    /**
     * 解析未决列表。
     *
     * 宽容策略与 [JsonV2] 一致：单个条目畸形就跳过、缺可选字段按默认，**绝不抛异常打断界面**；
     * 整份响应不是 JSON 时才返回 null（调用方当作一次失败的拉取处理）。
     */
    fun parseApprovals(json: String?): ApprovalsResponse? {
        val root = runCatching { JSONObject(json.orEmpty()) }.getOrNull() ?: return null
        val array = root.optJSONArray("approvals")
        val list = ArrayList<ApprovalEntry>(array?.length() ?: 0)
        for (i in 0 until (array?.length() ?: 0)) {
            val item = array?.optJSONObject(i) ?: continue
            parseEntry(item)?.let { list.add(it) }
        }
        return ApprovalsResponse(approvals = list, state = parseState(root.optJSONObject("state")))
    }

    /** 单条未决请求；缺 `eventId` 或缺/不认识的 `kind` 时返回 null（无法渲染也无法回答）。 */
    fun parseEntry(obj: JSONObject): ApprovalEntry? {
        val eventId = obj.optStringOrNull("eventId") ?: return null
        val kind = Kind.fromWire(obj.optStringOrNull("kind")) ?: return null
        return ApprovalEntry(
            eventId = eventId,
            sessionId = obj.optStringOrNull("sessionId"),
            kind = kind,
            toolName = obj.optStringOrNull("toolName"),
            callId = obj.optStringOrNull("callId"),
            reason = obj.optStringOrNull("reason"),
            // 审批恒为 null；提问即使一条都没有也保留空列表（界面据此显示"这次提问是空的"）
            questions = if (kind == Kind.QUESTION) parseQuestions(obj.optJSONArray("questions")) else null,
            at = obj.optLongOrNull("at") ?: 0L,
            expiresAt = obj.optLongOrNull("expiresAt") ?: 0L,
        )
    }

    /** 提问正文；非数组 ⇒ 空列表（不抛）。 */
    fun parseQuestions(array: JSONArray?): List<ApprovalQuestion> {
        if (array == null) return emptyList()
        val out = ArrayList<ApprovalQuestion>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val id = item.optStringOrNull("id") ?: continue
            val options = ArrayList<ApprovalOption>()
            val rawOptions = item.optJSONArray("options")
            for (j in 0 until (rawOptions?.length() ?: 0)) {
                val option = rawOptions?.optJSONObject(j) ?: continue
                options.add(
                    ApprovalOption(
                        label = option.optStringOrEmpty("label"),
                        description = option.optStringOrNull("description"),
                    ),
                )
            }
            out.add(
                ApprovalQuestion(
                    id = id,
                    header = item.optStringOrNull("header"),
                    question = item.optStringOrEmpty("question"),
                    detail = item.optStringOrNull("detail"),
                    options = options,
                    // multiSelect 为假时线上整个键都不出现，缺键即 false
                    multiSelect = item.optBoolean("multiSelect", false),
                ),
            )
        }
        return out
    }

    /** 诊断快照；缺字段按默认（老网关可能没有这个块，也可能没有 `reason`/`hint`）。 */
    fun parseState(obj: JSONObject?): BridgeState {
        if (obj == null) return BridgeState()
        return BridgeState(
            available = obj.optBoolean("available", false),
            connected = obj.optBoolean("connected", false),
            // pending 优先取列表长度之外的服务端计数：它是"全部会话"的未决数，
            // 而列表可能带了 sessionId 过滤（两者不等不是 bug）
            pending = obj.optIntOrNull("pending") ?: 0,
            reconnects = obj.optIntOrNull("reconnects") ?: 0,
            lastErrorCode = obj.optJSONObject("lastError")?.optStringOrNull("code"),
            // 老网关没有 reason/hint：走 UNKNOWN + null，文案退回三态兜底
            reasonCode = Reason.fromWire(obj.optStringOrNull("reason")),
            serverHint = obj.optStringOrNull("hint"),
        )
    }

    // ---------------------------------------------------------------- 编码

    /**
     * 手机端要提交的答案（封闭类型：界面不可能拼出协议之外的形状）。
     *
     * 为什么不用裸 JSON 字符串在层间传递：提交成功后要按"我到底提交了什么"生成提示语，
     * 而从 JSON 反解枚举名等于把已经知道的信息丢掉再猜回来。
     */
    sealed interface Answer {
        /** 线协议的请求体。 */
        val body: String

        /** 提交成功后的提示语（见 [resultMessageFor]）。 */
        val resultMessage: String

        /** 审批结论。 */
        data class Decision(val outcome: Outcome) : Answer {
            override val body: String = encodeApproval(outcome)
            override val resultMessage: String = resultMessageFor(outcome)
        }

        /** 提问的回答（[bodyJson] 由 [encodeAnswers] 生成，null 表示一条都没答）。 */
        data class Responses(val bodyJson: String?) : Answer {
            override val body: String get() = bodyJson.orEmpty()
            override val resultMessage: String = resultMessageFor(null)
        }

        /** 弃权：交给 waterfall 的下一个应答者。 */
        data class Abstain(val placeholder: Unit = Unit) : Answer {
            override val body: String = encodeAbstain()
            override val resultMessage: String = resultMessageFor(null, abstained = true)
        }
    }

    /** 审批应答体：`{outcome:'allowed-once'|'rejected'|'cancelled'|'unavailable'}`。 */
    fun encodeApproval(outcome: Outcome): String = JSONObject().put("outcome", outcome.wire).toString()

    /**
     * 提问应答体：`{answers:[{id, selected:[…], custom?}]}`。
     *
     * 两个必须在这里挡住的坑（见网关 `buildOutcome` 的注释，都是实测踩出来的）：
     * 1. 自由文本字段叫 **`custom`**，不是 `text`——多写一个 `text` 会被桌面端 strict schema 拒掉；
     * 2. `selected` **必须是数组**：传裸字符串会被工具内部 `[...selected]` 静默展开成单字符数组。
     *
     * 空问答（既没选项也没文本）会被**跳过**，不塞进 `answers`；一条都不剩时返回 null，
     * 交给调用方提示"还没回答任何问题"，而不是让桌面端把空串当成有效答案。
     */
    fun encodeAnswers(questions: List<ApprovalQuestion>, drafts: Map<String, ApprovalDraft>): String? {
        val answers = JSONArray()
        questions.forEach { question ->
            val draft = drafts[question.id] ?: return@forEach
            val selected = draft.selected.filter { it.isNotBlank() }
            val custom = draft.custom.trim()
            if (selected.isEmpty() && custom.isEmpty()) return@forEach
            answers.put(
                JSONObject().apply {
                    put("id", question.id)
                    put("selected", JSONArray(selected))
                    // custom 只在真有文本时才出现：桌面端 schema 的 additionalProperties=false，
                    // 空串也算"给了这个键"，语义上是"用户填了空"。
                    if (custom.isNotEmpty()) put("custom", custom)
                },
            )
        }
        if (answers.length() == 0) return null
        return JSONObject().put("answers", answers).toString()
    }

    /** 弃权：`{abstain:true}` → 网关翻译成 `{kind:'next'}`，waterfall 继续找下一个应答者。 */
    fun encodeAbstain(): String = JSONObject().put("abstain", true).toString()

    // ---------------------------------------------------------------- 界面派生

    /**
     * 本地校验：所有提问都答过才允许提交。
     *
     * 单问单选的常见情形也走同一条路径——少一个分支就少一处"单选忘了判"的漏洞。
     */
    fun plan(entry: ApprovalEntry, drafts: Map<String, ApprovalDraft>): ApprovalPlan {
        val questions = entry.questions.orEmpty()
        val unanswered = questions.filter { !(drafts[it.id]?.answered ?: false) }.map { it.id }
        return ApprovalPlan(
            canSubmit = questions.isNotEmpty() && unanswered.isEmpty(),
            unanswered = unanswered,
            total = questions.size,
        )
    }

    /**
     * 点一个选项后的新草稿。
     *
     * 单选：再点一次同一项**取消选择**（用户点错了要能改，而不是被迫换一个选项）；
     * 多选：切换该标签的选中态。
     */
    fun toggleOption(question: ApprovalQuestion, draft: ApprovalDraft, label: String): ApprovalDraft =
        if (question.multiSelect) {
            draft.copy(
                selected = if (draft.selected.contains(label)) draft.selected - label else draft.selected + label,
            )
        } else {
            draft.copy(selected = if (draft.selected == setOf(label)) emptySet() else setOf(label))
        }

    /**
     * 「谁先答谁赢」的判定。
     *
     * 网关对同一 `eventId` 只保留一条未决记录，电脑端自己答掉之后手机再提交会拿到
     * `not_found`。**提交成功不等于决定由手机做出**，所以界面文案必须是
     * "已提交（若电脑端先答过，则以先答的为准）"，而不是"已允许"。
     */
    fun alreadyDecided(error: Throwable): Boolean {
        val code = (error as? ApiException)?.code ?: return false
        return code == "not_found" || code == "approval_expired"
    }

    /**
     * 剩余时间的界面文案（`≤0` ⇒ 空串，界面据此不显示倒计时）。
     *
     * 刻意只给"还剩几分钟"这一档精度：网关的 TTL 是**它自己的记账**，到点并不会让电脑端
     * 那一轮结束，所以给用户一个精确到秒的倒计时是在暗示一个并不存在的能力。
     */
    fun formatRemaining(remainingMillis: Long): String = when {
        remainingMillis <= 0L -> ""
        remainingMillis < 60_000L -> "即将过期"
        else -> "还剩约 ${remainingMillis / 60_000L} 分钟"
    }

    /**
     * 提交（成功）后的提示语。
     *
     * 为什么成功文案要带那半句括号：这条通道**没有 allow-always**，且电脑端随时可能先答；
     * 只说"已允许"会让用户以为决定是自己做出的，而实际上可能只是"电脑端已经答过了"。
     */
    fun resultMessageFor(outcome: Outcome?, abstained: Boolean = false): String = when {
        abstained -> "已弃权：交给下一个应答者（无人应答时电脑端那一轮会拿到 unavailable）"
        outcome == null -> "已提交回答（若电脑端先答过，以先答的为准）"
        else -> "已提交「${outcome.label}」（若电脑端先答过，以先答的为准）"
    }

    /** 审批/提问错误码 → 中文提示（错误码本身保留在括号里，便于对照网关日志）。 */
    fun friendlyApprovalMessage(error: Throwable): String {
        val raw = error.message.orEmpty().ifEmpty { "未知错误" }
        val code = (error as? ApiException)?.code
        return when (code) {
            "not_found" -> "$raw（这条请求已经不在了：可能已被电脑端先答，或已过期）"
            "approval_expired" -> "$raw（超过 15 分钟未应答，网关已标记过期；电脑端那一轮仍在等待）"
            "bad_request" -> "$raw（提交的答案形状不被接受，请刷新后重试）"
            "desktop_unavailable" -> "$raw（网关未启用桌面端通道，无法把答案送到电脑上）"
            "desktop_unreachable" -> "$raw（连不上电脑端 runtime，请确认电脑上的 DSH 在运行）"
            "desktop_unauthorized" -> "$raw（网关与电脑端的凭据对不上，请在电脑上重新配对）"
            "desktop_error" -> "$raw（电脑端返回了协议级错误，详见网关日志）"
            else -> raw
        }
    }
}

/**
 * 这里刻意**不**复用 [JsonV2] 的私有小工具：它们是 `private`，跨文件不可见；
 * 为了三个字段把 [JsonV2] 的可见性放宽，会让整个解析层的封装漏出去。
 * 三个扩展都按"缺键/`null` ⇒ 缺省"处理，与 [JsonV2] 的宽容策略保持一致。
 */
private fun JSONObject.optStringOrNull(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key, "").takeIf { it.isNotEmpty() }

private fun JSONObject.optStringOrEmpty(key: String): String =
    if (!has(key) || isNull(key)) "" else optString(key, "")

private fun JSONObject.optLongOrNull(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key, 0L)

private fun JSONObject.optIntOrNull(key: String): Int? =
    if (!has(key) || isNull(key)) null else optInt(key, 0)
