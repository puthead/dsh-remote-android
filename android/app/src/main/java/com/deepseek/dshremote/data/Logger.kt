package com.deepseek.dshremote.data

import android.util.Log
import com.deepseek.dshremote.BuildConfig

/**
 * 极简日志门面。
 *
 * 存在的理由：安全红线要求"令牌不落日志"，所以集中在这里做**脱敏**，
 * 而不是在每个调用点靠自觉。v2 起额外维护一个内存环形缓冲，
 * 供设置页"日志导出"使用（导出内容同样已经脱敏）。
 */
object Logger {

    private const val MAX_TAG = 23
    private const val MAX_BUFFER_LINES = 500

    private val buffer = ArrayDeque<String>()
    private val bufferLock = Any()

    fun d(tag: String, message: String) {
        if (BuildConfig.DEBUG) Log.d(tag.take(MAX_TAG), redact(message))
        record("D", tag, message)
    }

    fun i(tag: String, message: String) {
        Log.i(tag.take(MAX_TAG), redact(message))
        record("I", tag, message)
    }

    fun w(tag: String, message: String, throwable: Throwable? = null) {
        Log.w(tag.take(MAX_TAG), redact(message), throwable)
        record("W", tag, message + (throwable?.let { " · ${it::class.java.simpleName}: ${it.message}" } ?: ""))
    }

    fun e(tag: String, message: String, throwable: Throwable? = null) {
        Log.e(tag.take(MAX_TAG), redact(message), throwable)
        record("E", tag, message + (throwable?.let { " · ${it::class.java.simpleName}: ${it.message}" } ?: ""))
    }

    /** 导出用快照（已脱敏）。 */
    fun snapshot(): List<String> = synchronized(bufferLock) { buffer.toList() }

    fun clearBuffer() = synchronized(bufferLock) { buffer.clear() }

    /**
     * 把 `dshr_...` 形态的令牌、`Bearer xxx`、`home_`/`dev_` id 与 6 位配对码替换掉，
     * 避免日志泄露凭据（契约 §5.5：前 4 位 + `****`）。
     */
    fun redact(message: String): String {
        var result = message
        TOKEN_PATTERN.findAll(result).forEach { match ->
            result = result.replace(match.value, match.value.take(4) + "****")
        }
        result = BEARER_PATTERN.replace(result) { match -> "Bearer ${match.groupValues[1].take(4)}****" }
        result = PAIR_CODE_PATTERN.replace(result) { match -> match.groupValues[1] + "******" }
        return result
    }

    private fun record(level: String, tag: String, message: String) {
        val line = "${System.currentTimeMillis()} $level/${tag.take(MAX_TAG)} ${redact(message)}"
        synchronized(bufferLock) {
            buffer.addLast(line)
            while (buffer.size > MAX_BUFFER_LINES) buffer.removeFirst()
        }
    }

    /**
     * 令牌与配对码的形态：
     * - `dshr_`/`tok_` 前缀的凭据；
     * - `home_` 后至少 16 位（真实 homeId 是 22 位 Base64Url），
     *   这样 `home_offline`/`home_not_found` 这类**枚举值不会被误伤**。
     */
    private val TOKEN_PATTERN = Regex("(dshr_[A-Za-z0-9_\\-]{8,})|(tok_[A-Za-z0-9]{6,})|(home_[A-Za-z0-9]{16,})")

    private val BEARER_PATTERN = Regex("Bearer\\s+([A-Za-z0-9_\\-]{8,})")

    /** `code=123456` / `"code":"123456"` 形态的配对码。 */
    private val PAIR_CODE_PATTERN = Regex("(code[\"=:]{1,3}\\s*\"?)(\\d{6})")
}
