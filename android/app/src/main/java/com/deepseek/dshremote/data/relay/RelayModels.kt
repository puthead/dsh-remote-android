package com.deepseek.dshremote.data.relay

/**
 * 契约 v2 §3 隧道帧模型。
 *
 * 设计取舍：帧不做成"每个字段一个 data class 继承体系 + 手写 when 解析"以外的抽象，
 * 因为手机端只需要 12 种帧、字段都是平铺的；用 [FrameCodec] 一处集中编解码，
 * 单测可以直接对着契约 §3.1 的表格逐行核对。
 */
object FrameType {
    const val HELLO = "hello"
    const val READY = "ready"
    const val ERROR = "error"
    const val REQ = "req"
    const val RES = "res"
    const val CHUNK = "chunk"
    const val END = "end"
    const val ABORT = "abort"
    const val PING = "ping"
    const val PONG = "pong"
    const val CANCEL = "cancel"
    const val NOTICE = "notice"
}

/** 隧道角色（契约 §3.1 `hello.role`）。手机永远是 `device`。 */
object RelayRole {
    const val HOME = "home"
    const val DEVICE = "device"
}

/** 契约 §3.1 的 `notice.kind`。 */
object NoticeKind {
    const val HOME_OFFLINE = "home_offline"
    const val HOME_ONLINE = "home_online"
    const val REVOKED = "revoked"
}

/** 隧道帧；[type] 与线上 `t` 字段一一对应。 */
sealed interface RelayFrame {
    val type: String
}

/** C→S 首帧。 */
data class HelloFrame(
    val proto: Int = 2,
    val role: String = RelayRole.DEVICE,
    val name: String? = null,
) : RelayFrame {
    override val type: String get() = FrameType.HELLO
}

/** S→C 准入成功；device 连接会带上 `homeName` / `homeOnline`（"电脑离线"的唯一事实源）。 */
data class ReadyFrame(
    val proto: Int = 2,
    val role: String = RelayRole.DEVICE,
    val homeId: String = "",
    val homeName: String? = null,
    val homeOnline: Boolean = true,
) : RelayFrame {
    override val type: String get() = FrameType.READY
}

/** S→C 拒绝；`fatal` 时中继随后关闭连接，客户端不要再重试同一份凭据。 */
data class ErrorFrame(
    val code: String,
    val message: String,
    val fatal: Boolean = true,
) : RelayFrame {
    override val type: String get() = FrameType.ERROR
}

/** C→S 请求（device→中继）。`bodyB64` 缺省表示无请求体。 */
data class ReqFrame(
    val id: Long,
    val method: String,
    val path: String,
    val headers: Map<String, String> = emptyMap(),
    val bodyB64: String? = null,
) : RelayFrame {
    override val type: String get() = FrameType.REQ
}

/** S→C 响应头。 */
data class ResFrame(
    val id: Long,
    val status: Int,
    val headers: Map<String, String> = emptyMap(),
) : RelayFrame {
    override val type: String get() = FrameType.RES
}

/** S→C 响应体分片（任意次，可 0 次）。 */
data class ChunkFrame(val id: Long, val dataB64: String) : RelayFrame {
    override val type: String get() = FrameType.CHUNK
}

/** S→C 本次响应正常结束。 */
data class EndFrame(val id: Long) : RelayFrame {
    override val type: String get() = FrameType.END
}

/** S→C 异常终止（对端断开、home 掉线、超时、overflow）。 */
data class AbortFrame(val id: Long, val reason: String = "") : RelayFrame {
    override val type: String get() = FrameType.ABORT
}

/** 双向心跳。 */
data class PingFrame(val id: Long? = null) : RelayFrame {
    override val type: String get() = FrameType.PING
}

data class PongFrame(val id: Long? = null) : RelayFrame {
    override val type: String get() = FrameType.PONG
}

/** C→S 取消请求（SSE 客户端离开时必须发，否则中继与网关会一直挂着这条流）。 */
data class CancelFrame(val id: Long) : RelayFrame {
    override val type: String get() = FrameType.CANCEL
}

/** S→C 状态通知（无需请求）。 */
data class NoticeFrame(val kind: String, val homeId: String? = null) : RelayFrame {
    override val type: String get() = FrameType.NOTICE
}

/** 未知帧类型：保留原始 JSON 文本，便于日志排查而不是直接崩。 */
data class UnknownFrame(val wireType: String, val raw: String) : RelayFrame {
    override val type: String get() = wireType
}

/**
 * 一次多路复用流的进展事件。
 *
 * [Head] 是响应头，[Body] 是增量字节，[End] 正常结束，[Aborted] 异常结束。
 */
sealed interface TunnelEvent {
    data class Head(val status: Int, val headers: Map<String, String>) : TunnelEvent

    data class Body(val bytes: ByteArray) : TunnelEvent

    data object End : TunnelEvent

    data class Aborted(val reason: String) : TunnelEvent
}

/** 组装完成的整包响应。 */
data class TunnelResponse(
    val status: Int,
    val headers: Map<String, String>,
    val body: ByteArray,
) {
    val isSuccessful: Boolean get() = status in 200..299

    fun bodyText(): String = String(body, Charsets.UTF_8)
}

/**
 * 中继连接状态（UI 顶部状态条 + 前台服务通知都用它）。
 *
 * [Connected.homeOnline] 为 false 就是契约 §0.5 说的"电脑离线"：隧道在、PC 不在，
 * UI 必须显示明确状态而不是转圈。
 */
sealed interface RelayState {
    data object Idle : RelayState

    data class Connecting(val attempt: Int) : RelayState

    data class Connected(
        val homeId: String,
        val homeName: String,
        val homeOnline: Boolean,
        val since: Long,
    ) : RelayState {
        val isComputerOffline: Boolean get() = !homeOnline
    }

    data class Retrying(val attempt: Int, val retryInMs: Long, val reason: String) : RelayState

    /** 隧道凭据被拒（`error.code=unauthorized` / `notice{revoked}`）：必须重新配对。 */
    data class Unauthorized(val reason: String) : RelayState

    data class Failed(val reason: String) : RelayState
}

/** 隧道层异常；[code] 用契约 §3.3 的错误码枚举（本地失败用 `internal`/`timeout`）。 */
class RelayException(
    val code: String,
    override val message: String,
    val httpStatus: Int = 0,
) : Exception(message)

/** 请求排队等待期间隧道断开（可用于 UI 的"电脑离线"提示）。 */
fun RelayState.describe(): String = when (this) {
    RelayState.Idle -> "未连接中继"
    is RelayState.Connecting -> "正在连接中继（第 $attempt 次）"
    is RelayState.Connected ->
        if (homeOnline) {
            "已连接 · $homeName"
        } else {
            "电脑离线（$homeName 的隧道已断开）"
        }
    is RelayState.Retrying -> "连接中断，${(retryInMs / 1000).coerceAtLeast(1)}s 后重连：$reason"
    is RelayState.Unauthorized -> "配对凭据已失效，请重新配对"
    is RelayState.Failed -> "中继连接失败：$reason"
}
