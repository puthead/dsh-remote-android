package com.deepseek.dshremote.data

/**
 * 任务状态机（契约 §0）。
 *
 * `queued` / `running` 为活动态，其余为终态；状态只可单向流转，因此合并事件时不允许把
 * 终态回退成活动态（网关重启或重放旧事件时可能出现乱序的 status）。
 */
enum class TaskStatus(val wire: String) {
    QUEUED("queued"),
    RUNNING("running"),
    SUCCEEDED("succeeded"),
    FAILED("failed"),
    CANCELED("canceled"),
    ;

    val isTerminal: Boolean
        get() = this == SUCCEEDED || this == FAILED || this == CANCELED

    val isActive: Boolean
        get() = !isTerminal

    companion object {
        /** 未知状态按 `queued` 处理：宁可显示成"进行中"也不要让整条事件被丢弃。 */
        fun fromWire(value: String?): TaskStatus =
            entries.firstOrNull { it.wire == value } ?: QUEUED

        /** 终态优先级，用于合并两个状态时取"更靠后"的那个（防止状态回退）。 */
        private fun rank(status: TaskStatus): Int = when (status) {
            QUEUED -> 0
            RUNNING -> 1
            SUCCEEDED, FAILED, CANCELED -> 2
        }

        fun later(a: TaskStatus, b: TaskStatus): TaskStatus = if (rank(b) >= rank(a)) b else a
    }
}

/** 契约 §3 的 Task 对象。`output` 是客户端累计拼接后的完整输出。 */
data class RemoteTask(
    val id: String,
    val title: String = "",
    val prompt: String = "",
    val workspace: String = "",
    val status: TaskStatus = TaskStatus.QUEUED,
    val createdAt: Long = 0L,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val exitCode: Int? = null,
    val output: String = "",
    val error: String? = null,
    val truncated: Boolean = false,
    val sessionId: String? = null,
) {
    /** 耗时：终态用 finishedAt，活动态用"现在"，便于 UI 实时跳动。 */
    fun durationMs(now: Long = System.currentTimeMillis()): Long {
        val start = startedAt ?: createdAt
        val end = finishedAt ?: now
        return (end - start).coerceAtLeast(0L)
    }
}

/** 契约 §1 `GET /api/v1/health`。 */
data class HealthInfo(
    val ok: Boolean,
    val apiVersion: Int,
    val serverName: String,
    val gatewayVersion: String,
    val dshVersion: String,
    val uptimeMs: Long,
    val activeTasks: Int,
    val queuedTasks: Int,
    val pairingOpen: Boolean,
    val authRequired: Boolean,
    val capabilities: List<String>,
)

/** 契约 §5 工作区白名单中的一项。 */
data class WorkspaceInfo(
    val path: String,
    val label: String,
    val exists: Boolean,
)

data class WorkspaceList(
    val workspaces: List<WorkspaceInfo>,
    val default: String?,
)

/** 契约 §2.2 配对成功的响应；`token` 只在这一次响应里出现，必须立刻落到 DataStore。 */
data class PairClaim(
    val token: String,
    val tokenId: String,
    val serverName: String,
    val expiresAt: Long?,
)

/** 契约 §4 的事件类型。未知类型保留为 [UNKNOWN]，仅用于日志，不影响流消费。 */
enum class TaskEventType(val wire: String) {
    TASK_CREATED("task.created"),
    TASK_STARTED("task.started"),
    TASK_OUTPUT("task.output"),
    TASK_FINISHED("task.finished"),
    TASK_PROGRESS("task.progress"),
    UNKNOWN(""),
    ;

    companion object {
        fun fromWire(value: String?): TaskEventType =
            entries.firstOrNull { it.wire == value && it != UNKNOWN } ?: UNKNOWN
    }
}

/** 契约 §4 的 SSE data 载荷（字段名与契约一致）。 */
data class TaskEvent(
    val seq: Long,
    val taskId: String,
    val at: Long,
    val type: TaskEventType,
    val delta: String = "",
    val task: RemoteTask? = null,
    val phase: String? = null,
    val note: String? = null,
)

/** 一条已解析的 SSE 帧：只保留契约用到的 id/event/data 三个字段。 */
data class SseFrame(
    val id: String?,
    val event: String?,
    val data: String,
)

/** 契约 §0 的统一错误体；[httpStatus] 为 0 表示网络层失败（未拿到响应）。 */
class ApiException(
    val code: String,
    override val message: String,
    val httpStatus: Int = 0,
) : Exception(message) {
    /** 令牌失效：必须清空本地令牌并回到配置页，而不是无脑重试（契约 §0 + 裁定 A4）。 */
    val isUnauthorized: Boolean get() = code == "unauthorized" || httpStatus == 401

    /** 403：配对关闭/网络异常导致的越权，与 401 区别处理（不清令牌，提示重新生成配对码）。 */
    val isForbidden: Boolean get() = code == "forbidden" || httpStatus == 403

    /** 429：可能是 `busy`（队列满，裁定 A2）或 `rate_limited`（失败限速，契约 §6.4）。 */
    val isRateLimited: Boolean get() = code == "rate_limited" || httpStatus == 429

    /** 队列满（裁定 A2）：UI 必须显示"服务器繁忙，请稍后重试"，不能与"排队中"混为一谈。 */
    val isBusy: Boolean get() = code == "busy"

    /** 409：对活动态任务执行 DELETE（裁定 A7）。 */
    val isConflict: Boolean get() = code == "conflict" || httpStatus == 409

    /** 413：请求体过大。 */
    val isPayloadTooLarge: Boolean get() = code == "payload_too_large" || httpStatus == 413
}

/** 本地保存的连接配置（DataStore Preferences 的领域模型）。 */
data class AppSettings(
    val baseUrl: String,
    val token: String,
    val deviceId: String,
    val deviceName: String,
    val serverName: String?,
)

/** SSE 连接状态，用于 UI 顶部指示条。 */
sealed interface ConnectionState {
    data object Idle : ConnectionState

    data class Connecting(val attempt: Int) : ConnectionState

    data class Connected(val since: Long) : ConnectionState

    /** 断开后等待退避重连；[retryInMs] 让 UI 能显示倒计时。 */
    data class Retrying(val attempt: Int, val retryInMs: Long, val reason: String) : ConnectionState

    /**
     * 令牌失效（HTTP 401）。
     *
     * 单独一种状态而不是复用 [Failed]：401 需要"清空本地令牌 + 跳回配置页 + 提示重新配对"，
     * 而 [Failed] 只是展示性错误（例如尚未配置），处理动作完全不同。
     */
    data class Unauthorized(val reason: String) : ConnectionState

    data class Failed(val reason: String) : ConnectionState
}
