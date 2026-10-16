package com.deepseek.dshremote.data.relay

import kotlinx.coroutines.flow.Flow

/**
 * HTTP-over-隧道（契约 §3.2 的 req/res/chunk/end 多路复用）。
 *
 * 存在的意义：让"手机所有 API 调用"从一个口子出去，**手机不直连 PC** 这条硬约束
 * 因此可以被代码结构保证——上层的 [com.deepseek.dshremote.data.api.DshApiV2] 拿不到
 * 任何指向 PC 的地址，只有隧道。
 *
 * 与 [RelayClient] 的分工：本类只管"业务 HTTP 长什么样"（Api 版本头、Bearer 令牌、超时），
 * 帧与 id 的一切细节都在 [RelayClient]/[PendingStreams] 里。
 */
class TunnelHttp(
    private val relay: RelayClient,
    private val tokenProvider: () -> String? = { null },
    private val apiVersion: Int = RelayClient.API_VERSION,
    private val timeoutMs: Long = 60_000L,
) {

    /** 构造请求头；令牌只在这里注入，调用方拿不到明文（也打不了日志）。 */
    fun headers(extra: Map<String, String> = emptyMap()): Map<String, String> {
        val result = LinkedHashMap<String, String>()
        result["X-Api-Version"] = apiVersion.toString()
        result["Accept"] = "application/json"
        val token = tokenProvider()
        if (!token.isNullOrEmpty()) result["Authorization"] = "Bearer $token"
        result.putAll(extra)
        return result
    }

    /** 一次普通请求：等 `end` 后返回整包响应。 */
    suspend fun execute(
        method: String,
        path: String,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        timeoutMs: Long = this.timeoutMs,
    ): TunnelResponse = relay.request(method, path, headers(extra = headers), body, timeoutMs)

    /** 便捷方法：GET 并返回 UTF-8 文本。 */
    suspend fun getText(path: String, timeoutMs: Long = this.timeoutMs): String =
        execute("GET", path, timeoutMs = timeoutMs).bodyText()

    /** POST + JSON 请求体（`null` 表示无体，例如 abort 这类动作端点）。 */
    suspend fun postJson(
        path: String,
        json: String?,
        timeoutMs: Long = this.timeoutMs,
    ): TunnelResponse = execute(
        method = "POST",
        path = path,
        headers = if (json == null) emptyMap() else mapOf("Content-Type" to "application/json; charset=utf-8"),
        body = json?.toByteArray(Charsets.UTF_8),
        timeoutMs = timeoutMs,
    )

    /** 流式请求（SSE）：chunk 逐段吐出，`end` 只在流真正结束时到来。 */
    fun stream(
        method: String,
        path: String,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
    ): Flow<TunnelEvent> = relay.openStream(method, path, this.headers(extra = headers), body)

    val pendingStreams: Int get() = relay.pendingStreams
}
