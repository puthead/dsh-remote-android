package com.deepseek.dshremote.data.api

import com.deepseek.dshremote.data.SseFrame
import com.deepseek.dshremote.data.SseFrameParser
import org.json.JSONObject

/**
 * 契约 §4.2 `GET /api/v2/sessions/stream` 的 SSE 事件。
 *
 * 与 v1 的 `TaskEvent` 分开建模：v2 的事件是**会话级增量**（message.delta / tool.call / …），
 * 字段与语义都不同，硬塞进 v1 模型只会让两边都难读。
 */
sealed interface ConsoleEvent {
    /** 事件所属会话；不针对具体会话的事件（心跳）为空串。 */
    val sessionId: String

    /** 事件游标；`null` 表示该事件类型不参与续传（heartbeat）。 */
    val seq: Long?

    data class SessionUpdated(
        override val sessionId: String,
        val updatedAt: Long,
        val live: Boolean,
        /** `source`（契约裁定：session.updated/turn.started/session.created 会带）；未知值为空串。 */
        val source: String = "",
    ) : ConsoleEvent {
        override val seq: Long? get() = null
    }

    data class SessionCreated(
        override val sessionId: String,
        val workspace: String,
        val source: String = "",
    ) : ConsoleEvent {
        override val seq: Long? get() = null
    }

    data class TurnStarted(
        override val sessionId: String,
        val turn: Int,
        val fromSeq: Long,
        val source: String = "",
    ) : ConsoleEvent {
        override val seq: Long? get() = fromSeq.takeIf { it >= 0 }
    }

    data class MessageDelta(
        override val sessionId: String,
        override val seq: Long?,
        val role: String,
        val text: String,
    ) : ConsoleEvent

    data class ToolCallStarted(
        override val sessionId: String,
        override val seq: Long?,
        val name: String,
        val argsJson: String,
    ) : ConsoleEvent

    data class ToolResultReady(
        override val sessionId: String,
        override val seq: Long?,
        val isError: Boolean,
        val result: String,
    ) : ConsoleEvent

    data class TurnEnded(
        override val sessionId: String,
        val turn: Int,
        val reason: String,
        /** 网关给的轮次 id（可选）。 */
        val turnId: String? = null,
        /**
         * 本轮结束后该会话**还能不能继续**（契约裁定）。
         *
         * `false` 只会在"被 abort 杀掉进程"后出现：SDK 协议没有 cancel，
         * 停止即破坏该会话，UI 必须据此灰化输入框。
         */
        val resumable: Boolean? = null,
    ) : ConsoleEvent {
        override val seq: Long? get() = null
    }

    /**
     * 电脑端在等一个决定（契约 §7.7）：审批（`approval/request`）或提问（`user-questions/request`）。
     *
     * 载荷与 `GET /api/v2/approvals` 的 `approvals[]` **同形**（网关的 `publicEntry`），
     * 所以这里直接复用 [WireApprovals.parseEntry]，不再写第二套解析。
     */
    data class ApprovalAsked(val entry: WireApprovals.ApprovalEntry) : ConsoleEvent {
        override val sessionId: String get() = entry.sessionId.orEmpty()

        /** 审批没有 `seq`：它是电脑端事件流上的瀑布帧，不是会话事件序号。 */
        override val seq: Long? get() = null
    }

    /**
     * 一个决定已经产生：可能是本网关提交的（`by:'phone'`），也可能是电脑端自己答的
     * （这种情况 [decision] 为 null —— 手机只是"发现它没了"）。
     */
    data class ApprovalDecided(
        override val sessionId: String,
        val eventId: String,
        val kind: String,
        val decision: String?,
        val by: String?,
        val at: Long,
    ) : ConsoleEvent {
        override val seq: Long? get() = null
    }

    /** 超过 TTL 仍未应答（`reason` 为 `expired` 或 `dropped`）；只是网关侧记账，电脑端那轮仍挂着。 */
    data class ApprovalExpired(
        override val sessionId: String,
        val eventId: String,
        val kind: String,
        val reason: String,
        val at: Long,
    ) : ConsoleEvent {
        override val seq: Long? get() = null
    }

    data class Heartbeat(val at: Long) : ConsoleEvent {
        override val sessionId: String get() = ""
        override val seq: Long? get() = null
    }

    /** 未知事件类型：保留原始 data，方便日志排查（不抛异常，避免新事件类型打断流）。 */
    data class Unknown(val name: String, val data: String) : ConsoleEvent {
        override val sessionId: String get() = ""
        override val seq: Long? get() = null
    }
}

/**
 * SSE 增量解析（契约：逐 chunk 解析、支持 `fromSeq` / `Last-Event-ID` 续传）。
 *
 * 复用 v1 已经过 75 个用例验证的 [SseFrameParser]（行切分、`\r\n`、注释心跳、多 `data:` 行），
 * 这里只做"帧 → 类型化事件"的映射，因此长流分包这一层不用重写一遍。
 */
class SseV2Parser(private val delegate: SseFrameParser = SseFrameParser()) {

    /**
     * 网关总线游标（来自 `id:` 行），**续传只用它**。
     *
     * gateway-dev 明确：`id:` 是网关总线的游标（`Last-Event-ID` 用它），
     * `data.seq` 是 DSH 的事件序号（用于和 `/transcript`、`/events` 对齐）。
     * 两者混用会把续传游标推到不存在的位置；心跳帧刻意不带 `id`。
     */
    var lastEventId: String? = null
        private set

    /** 最近一次事件里的 DSH 事件序号（`data.seq`），只用于会话内去重/对齐。 */
    var lastDataSeq: Long? = null
        private set

    /** 喂入一个网络 chunk（UTF-8 解码后的字符串），返回其中解析完成的事件。 */
    fun feed(chunk: String): List<ConsoleEvent> {
        if (chunk.isEmpty()) return emptyList()
        val frames = delegate.feed(chunk)
        if (frames.isEmpty()) return emptyList()
        val events = ArrayList<ConsoleEvent>(frames.size)
        for (frame in frames) {
            // `id:` = 网关总线游标；心跳不带 id，因此不会被推到不存在的位置
            frame.id?.takeIf { it.isNotEmpty() }?.let { id -> lastEventId = id }
            val event = mapFrame(frame)
            event.seq?.let { seq -> if (lastDataSeq == null || seq > lastDataSeq!!) lastDataSeq = seq }
            events += event
        }
        return events
    }

    /** 连接彻底结束时调用：丢弃半条事件。 */
    fun reset() {
        delegate.reset()
    }

    /**
     * 续传游标：**只用总线游标**（`id:` 行）。
     *
     * 没有 `id:` 时返回 null，让调用方改用 `Last-Event-ID` 或干脆从头订阅，
     * 而不是拿 DSH 事件序号当总线游标用（那会让服务端从错误位置回放）。
     */
    fun resumeFromSeq(): Long? = lastEventId?.toLongOrNull()

    private fun mapFrame(frame: SseFrame): ConsoleEvent {
        val name = frame.event.orEmpty()
        val data = frame.data
        val obj = runCatching { JSONObject(data) }.getOrNull()
            ?: return ConsoleEvent.Unknown(name, data)
        return when (name) {
            "session.updated" -> ConsoleEvent.SessionUpdated(
                sessionId = obj.optString("sessionId", ""),
                updatedAt = obj.optLong("updatedAt", 0L),
                live = obj.optBoolean("live", false),
                // 未知 source 原样带上：上层只做展示/分流，绝不因为取值陌生而报错
                source = obj.optString("source", ""),
            )

            "session.created" -> ConsoleEvent.SessionCreated(
                sessionId = obj.optString("sessionId", ""),
                workspace = obj.optString("workspace", ""),
                source = obj.optString("source", ""),
            )

            "turn.started" -> ConsoleEvent.TurnStarted(
                sessionId = obj.optString("sessionId", ""),
                turn = obj.optInt("turn", 0),
                fromSeq = obj.optLong("fromSeq", -1L),
                source = obj.optString("source", ""),
            )

            "message.delta" -> ConsoleEvent.MessageDelta(
                sessionId = obj.optString("sessionId", ""),
                seq = obj.seqOrNull(),
                role = obj.optString("role", "assistant"),
                text = obj.optString("text", ""),
            )

            "tool.call" -> ConsoleEvent.ToolCallStarted(
                sessionId = obj.optString("sessionId", ""),
                seq = obj.seqOrNull(),
                name = obj.optString("name", "tool"),
                argsJson = obj.opt("args")?.let { if (it is JSONObject) it.toString() else it.toString() } ?: "{}",
            )

            "tool.result" -> ConsoleEvent.ToolResultReady(
                sessionId = obj.optString("sessionId", ""),
                seq = obj.seqOrNull(),
                isError = obj.optBoolean("isError", false),
                result = obj.optString("result", ""),
            )

            "turn.ended" -> ConsoleEvent.TurnEnded(
                sessionId = obj.optString("sessionId", ""),
                turn = obj.optInt("turn", 0),
                reason = obj.optString("reason", ""),
                turnId = obj.optStringOrNull("turnId"),
                // 缺省视为"可续聊"：老网关不发这个字段，不能因此把用户锁死
                resumable = if (obj.has("resumable")) obj.optBoolean("resumable", true) else null,
            )

            // 契约 §7.7：审批/提问的三条新事件。载荷与 REST 列表同形，直接复用那份解析。
            "approval.asked" -> WireApprovals.parseEntry(obj)?.let { ConsoleEvent.ApprovalAsked(it) }
                ?: ConsoleEvent.Unknown(name, data)

            "approval.decided" -> ConsoleEvent.ApprovalDecided(
                sessionId = obj.optString("sessionId", ""),
                eventId = obj.optString("eventId", ""),
                kind = obj.optString("kind", ""),
                decision = obj.optStringOrNull("decision"),
                by = obj.optStringOrNull("by"),
                at = obj.optLong("at", 0L),
            )

            "approval.expired" -> ConsoleEvent.ApprovalExpired(
                sessionId = obj.optString("sessionId", ""),
                eventId = obj.optString("eventId", ""),
                kind = obj.optString("kind", ""),
                reason = obj.optString("reason", ""),
                at = obj.optLong("at", 0L),
            )

            "heartbeat" -> ConsoleEvent.Heartbeat(at = obj.optLong("at", 0L))

            else -> ConsoleEvent.Unknown(name, data)
        }
    }

    private fun JSONObject.seqOrNull(): Long? =
        if (!has("seq") || isNull("seq")) null else optLong("seq", 0L)

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key, "").takeIf { it.isNotEmpty() }
}

/**
 * SSE 续传地址与头部（纯函数，可单测）。
 *
 * 契约同时允许 `?fromSeq=` 与 `Last-Event-ID`；客户端两个都给：
 * 网关用哪个都能回放，避免"服务端只认其一"的版本差异。
 */
object ConsoleStreams {

    const val PATH_SESSIONS_STREAM = "/api/v2/sessions/stream"

    fun path(fromSeq: Long?, tail: Int? = null): String {
        val params = mutableListOf<String>()
        if (fromSeq != null && fromSeq >= 0) params += "fromSeq=$fromSeq"
        if (tail != null && tail > 0) params += "tail=$tail"
        return if (params.isEmpty()) PATH_SESSIONS_STREAM else "$PATH_SESSIONS_STREAM?" + params.joinToString("&")
    }

    fun headers(lastEventId: String?): Map<String, String> =
        if (lastEventId.isNullOrEmpty()) emptyMap() else mapOf("Last-Event-ID" to lastEventId)
}
