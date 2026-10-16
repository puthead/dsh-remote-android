package com.deepseek.dshremote.data.relay

/**
 * 重连指数退避（契约 §5.6 / 需求：1s → 30s）。
 *
 * 默认**不加抖动**：手机端只有一个客户端，退避序列必须可断言（[ReconnectBackoffTest]）；
 * 需要避让中继重启风暴时可以打开 [jitterRatio]。
 */
class ReconnectBackoff(
    private val initialMs: Long = 1_000L,
    private val maxMs: Long = 30_000L,
    private val factor: Double = 2.0,
    private val jitterRatio: Double = 0.0,
    private val random: () -> Double = { Math.random() },
) {

    var attempt: Int = 0
        private set

    /** 下一次重连前应等待的毫秒数；连续调用得到 1s,2s,4s,…,30s,30s…。 */
    fun nextDelayMs(): Long {
        attempt++
        var raw = initialMs.toDouble()
        repeat(attempt - 1) { raw *= factor }
        val capped = raw.coerceAtMost(maxMs.toDouble())
        if (jitterRatio <= 0.0) return capped.toLong().coerceIn(0L, maxMs)
        val delta = capped * jitterRatio * (random() * 2.0 - 1.0)
        return (capped + delta).toLong().coerceIn(0L, maxMs)
    }

    /** 连接成功后必须调用，否则下一次断线会从很长的等待开始。 */
    fun reset() {
        attempt = 0
    }

    /** 完整的退避序列（单测/文档用）。 */
    fun sequence(count: Int): List<Long> = buildList {
        for (i in 0 until count) add(nextDelayMs())
    }

    companion object {
        const val DEFAULT_INITIAL_MS = 1_000L
        const val DEFAULT_MAX_MS = 30_000L
    }
}

/**
 * 心跳判定（契约 §3.1：`ping` 30s 无 `pong` 视为死链）。
 *
 * 抽成纯函数是为了让"多久算死"这件事可以被单测钉住，而不是埋在 WS 回调里。
 */
object HeartbeatPolicy {

    const val INTERVAL_MS = 20_000L
    const val TIMEOUT_MS = 30_000L

    fun isExpired(lastPongAt: Long, now: Long, timeoutMs: Long = TIMEOUT_MS): Boolean =
        lastPongAt > 0L && now - lastPongAt > timeoutMs

    /** 是否到了发下一次 ping 的时间。 */
    fun shouldPing(lastPingAt: Long, now: Long, intervalMs: Long = INTERVAL_MS): Boolean =
        lastPingAt <= 0L || now - lastPingAt >= intervalMs
}
